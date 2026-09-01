import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const directory = mkdtempSync(path.join(os.tmpdir(), "agent-bridge-state-"));
process.env.MODEL_ROUTER_AGENT_BRIDGE_STATE = path.join(directory, "sessions.json");

const { agentBridgeSessions, recordAgentBridgeSession } = await import("../src/agent-bridge-state.mjs");
const { agentBridgeDefinitions, agentBridgeStatus, probeAgentBridge } = await import("../src/agent-bridges.mjs");

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
