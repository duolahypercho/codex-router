import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const directory = mkdtempSync(path.join(os.tmpdir(), "agent-bridge-state-"));
process.env.MODEL_ROUTER_AGENT_BRIDGE_STATE = path.join(directory, "sessions.json");

const { agentBridgeSessions, recordAgentBridgeSession } = await import("../src/agent-bridge-state.mjs");
const { agentBridgeDefinitions, agentBridgeStatus, probeAgentBridge, promptAgentBridge } = await import("../src/agent-bridges.mjs");

test("bridge detection is optional and does not manufacture authentication", () => {
  const resolver = () => undefined;
  const definitions = agentBridgeDefinitions({
    PATH: "",
    MODEL_ROUTER_CLAUDE_BIN: "/tools/claude",
    MODEL_ROUTER_CURSOR_AGENT_BIN: "/tools/agent",
  }, { commandResolver: resolver });
  assert.deepEqual(definitions.map(({ id, installed }) => [id, installed]), [
    ["anthropic", true],
    ["cursor", true],
    ["gemini", false],
  ]);
  const status = agentBridgeStatus({ PATH: "" }, { commandResolver: resolver });
  assert.equal(status.bridges.every((bridge) => bridge.authentication === "unavailable"), true);
});

test("the router-owned session index stores metadata only and is private", () => {
  recordAgentBridgeSession({
    id: "session-1",
    bridge: "cursor",
    cwd: "/workspace",
    prompt: "must never be written",
  });
  assert.equal(agentBridgeSessions("cursor").length, 1);
  const text = readFileSync(process.env.MODEL_ROUTER_AGENT_BRIDGE_STATE, "utf8");
  assert.equal(text.includes("must never be written"), false);
  if (process.platform !== "win32") {
    assert.equal(statSync(process.env.MODEL_ROUTER_AGENT_BRIDGE_STATE).mode & 0o777, 0o600);
  }
});

test("Claude probe redacts account identity fields", async () => {
  const result = await probeAgentBridge("anthropic", {
    env: {
      PATH: "",
      MODEL_ROUTER_CLAUDE_BIN: "/tools/claude",
    },
    spawnSyncImpl: () => ({
      status: 0,
      stdout: JSON.stringify({
        loggedIn: true,
        authMethod: "claude.ai",
        subscriptionType: "max",
        email: "private@example.com",
        orgId: "private-org",
        orgName: "Private Org",
      }),
      stderr: "",
    }),
  });
  assert.equal(result.authentication, "claude.ai");
  assert.equal(result.subscription, "max");
  assert.equal(result.login, "ok");
  assert.equal(result.capability, "unverified");
  assert.equal(Object.hasOwn(result, "handshake"), false);
  assert.equal(Object.hasOwn(result, "email"), false);
  assert.equal(Object.hasOwn(result, "orgId"), false);
  assert.equal(Object.hasOwn(result, "orgName"), false);
});

test("Cursor probe refuses a signed-out CLI before starting ACP", async () => {
  await assert.rejects(
    probeAgentBridge("cursor", {
      env: { PATH: "", MODEL_ROUTER_CURSOR_AGENT_BIN: "/tools/agent" },
      spawnSyncImpl: () => ({
        status: 0,
        stdout: JSON.stringify({ status: "unauthenticated", isAuthenticated: false }),
        stderr: "",
      }),
      spawnImpl: () => { throw new Error("ACP must not start"); },
    }),
    /signed out/,
  );
});

test("public prompt bridge forwards Claude controls on new and resumed sessions", async () => {
  const calls = [];
  const bridgeFactory = () => ({
    newSession: async () => ({ sessionId: "fresh", cwd: "/workspace" }),
    loadSession: async (sessionId) => ({ sessionId, cwd: "/workspace" }),
    prompt: async (...args) => {
      calls.push(args);
      return { sessionId: args[0], text: "ok" };
    },
    close: async () => {},
  });
  await promptAgentBridge("anthropic", {
    prompt: "first", cwd: "/workspace", model: "claude-sonnet-4-5", effort: "medium", bridgeFactory,
  });
  await promptAgentBridge("anthropic", {
    prompt: "next", cwd: "/workspace", sessionId: "fresh", model: "claude-sonnet-4-5", effort: "xhigh", bridgeFactory,
  });
  assert.deepEqual(calls, [
    ["fresh", "first", { cwd: "/workspace", resume: false, model: "claude-sonnet-4-5", effort: "medium" }],
    ["fresh", "next", { cwd: "/workspace", resume: true, model: "claude-sonnet-4-5", effort: "xhigh" }],
  ]);
});

test("non-Claude bridges reject model and effort before constructing a bridge", async () => {
  let constructed = false;
  const bridgeFactory = () => { constructed = true; throw new Error("unexpected bridge construction"); };
  for (const id of ["cursor", "gemini"]) {
    await assert.rejects(promptAgentBridge(id, { prompt: "hello", model: "model", bridgeFactory }), /Claude/i);
    await assert.rejects(promptAgentBridge(id, { prompt: "hello", effort: "low", bridgeFactory }), /Claude/i);
  }
  assert.equal(constructed, false);
});

test("prompt CLI rejects missing values, unknown options and non-Claude controls before reading stdin", () => {
  const script = path.resolve("src/agent-bridges.mjs");
  for (const [args, expected] of [
    [["prompt", "anthropic", "--session"], /Missing value for --session/],
    [["prompt", "anthropic", "--cwd"], /Missing value for --cwd/],
    [["prompt", "anthropic", "--model"], /Missing value for --model/],
    [["prompt", "anthropic", "--effort"], /Missing value for --effort/],
    [["prompt", "anthropic", "--model", "--effort", "low"], /Missing value for --model/],
    [["prompt", "anthropic", "--unknown", "value"], /Unknown prompt option/],
    [["prompt", "anthropic", "--model", "--help"], /Missing value for --model/],
    [["prompt", "anthropic", "--effort", "ultracode"], /Claude effort/],
    [["prompt", "cursor", "--model", "model"], /Claude bridge/],
    [["prompt", "gemini", "--effort", "low"], /Claude bridge/],
  ]) {
    const result = spawnSync(process.execPath, [script, ...args], { cwd: path.dirname(script), encoding: "utf8", input: "", timeout: 5000 });
    assert.notEqual(result.status, 0, args.join(" "));
    assert.match(result.stderr, expected, args.join(" "));
  }
});
