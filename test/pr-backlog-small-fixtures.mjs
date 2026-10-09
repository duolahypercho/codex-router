import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { callerBaseUrl } from "../src/caller-auth.mjs";
import { END_STREAM_FLAG, encodeEnvelope } from "../src/connect-stream-audit.mjs";
import * as proto from "../src/devin-proto.mjs";
import { readRegistryDocument } from "../src/model-registry.mjs";
import { decodeMessage, encodeMessage } from "../src/protobuf-wire.mjs";
import { openPort } from "./port-pool.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const internalKey = "small-e2e-internal-key-with-sufficient-length";
const callerKey = "small-e2e-caller-key-with-sufficient-length";
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const inheritedEnv = Object.fromEntries(Object.entries(process.env).filter(([name]) =>
  /^(PATH|SystemRoot|WINDIR|ComSpec|PATHEXT|TEMP|TMP|SystemDrive)$/i.test(name)));

function temporary(t) {
  const directory = mkdtempSync(path.join(os.tmpdir(), "router-small-e2e-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

async function listen(t, handler) {
  const server = http.createServer(handler);
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  return `http://127.0.0.1:${server.address().port}`;
}

function child(t, script, args, env) {
  const processChild = spawn(process.execPath, [path.join(root, script), ...args], {
    cwd: root, env: { ...inheritedEnv, MODEL_ROUTER_TARGET: "codex", ...env }, stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  processChild.stdout.on("data", (chunk) => { stdout += chunk; });
  processChild.stderr.on("data", (chunk) => { stderr += chunk; });
  const exited = once(processChild, "exit");
  t.after(async () => {
    if (processChild.exitCode !== null || processChild.signalCode !== null) return;
    processChild.kill("SIGTERM");
    const deadline = setTimeout(() => processChild.kill("SIGKILL"), 2_000);
    try { await exited; } finally { clearTimeout(deadline); }
  });
  return { process: processChild, exited, output: () => ({ stdout, stderr }) };
}

async function ready(url, running, headers = {}) {
  for (let attempt = 0; attempt < 150; attempt++) {
    assert.equal(running.process.exitCode, null, running.output().stderr);
    try {
      if ((await fetch(url, { headers, signal: AbortSignal.timeout(300) })).ok) return;
    } catch { /* The child has not bound yet. */ }
    await pause(20);
  }
  throw new Error(`Local process readiness failed: ${running.output().stderr}`);
}

async function cli(t, script, args, env, input, { leaveInputOpen = false } = {}) {
  const running = child(t, script, args, env);
  if (!leaveInputOpen) running.process.stdin.end(input);
  const timeout = setTimeout(() => running.process.kill("SIGKILL"), 5_000);
  const [code, signal] = await running.exited.finally(() => clearTimeout(timeout));
  assert.equal(signal, null, "CLI must terminate without waiting for stdin or a real provider");
  return { code, ...running.output() };
}

function sseEvents(text) {
  return text.split(/\r?\n\r?\n/).flatMap((frame) => {
    const data = frame.split(/\r?\n/).filter((line) => line.startsWith("data: ")).map((line) => line.slice(6)).join("\n");
    return data && data !== "[DONE]" ? [JSON.parse(data)] : [];
  });
}

async function devinScenario(t) {
  const directory = temporary(t);
  const seen = [];
  const calls = [
    { id: "call-one", name: "ping", argumentsJson: "" },
    { argumentsJson: "{" },
    { argumentsJson: '"value":' },
    { id: "call-one", name: "ping", argumentsJson: '{"value":1' },
    { argumentsJson: "}" },
    { id: "call-one", name: "ping", argumentsJson: '{"value":1}' },
    { id: "call-two", name: "pong", argumentsJson: '{"next":2}' },
    { id: "call-two", name: "pong", argumentsJson: '{"next":2}' },
  ];
  const backend = await listen(t, async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const bytes = Buffer.concat(chunks);
    if (request.url.endsWith("GetCliModelConfigs")) {
      seen.push(decodeMessage(proto.GET_CLI_MODEL_CONFIGS_REQUEST, bytes));
      response.writeHead(200, { "Content-Type": "application/proto" });
      response.end(encodeMessage(proto.GET_CLI_MODEL_CONFIGS_RESPONSE, {
        clientModelConfigs: [{ modelUid: "fixture-model", label: "Fixture" }],
      }));
      return;
    }
    seen.push(decodeMessage(proto.GET_CHAT_MESSAGE_REQUEST, bytes.subarray(5)));
    response.writeHead(200, { "Content-Type": "application/connect+proto" });
    for (const call of calls) response.write(encodeEnvelope(encodeMessage(proto.GET_CHAT_MESSAGE_RESPONSE, { deltaToolCalls: [call] })));
    response.write(encodeEnvelope(encodeMessage(proto.GET_CHAT_MESSAGE_RESPONSE, { stopReason: proto.STOP_REASON.FUNCTION_CALL })));
    response.end(encodeEnvelope(Buffer.from("{}"), { flags: END_STREAM_FLAG }));
  });
  const credentials = path.join(directory, "credentials.toml");
  writeFileSync(credentials, `windsurf_api_key = "fixture-key"\napi_server_url = "${backend}"\n`, { mode: 0o600 });
  const port = await openPort();
  const running = child(t, "src/devin-cli-forwarder.mjs", [], {
    CODEX_HOME: path.join(directory, "codex"), MODEL_ROUTER_STATE_DIR: directory,
    MODEL_ROUTER_INTERNAL_KEY: internalKey, MODEL_ROUTER_DEVIN_CLI_PORT: String(port),
    MODEL_ROUTER_DEVIN_CLI_HOST: "127.0.0.1", MODEL_ROUTER_QUIET: "1",
    DEVIN_CREDENTIALS_PATH: credentials, DEVIN_CASCADE_BASE_URL: backend,
  });
  const headers = { Authorization: `Bearer ${internalKey}`, "Content-Type": "application/json" };
  const base = `http://127.0.0.1:${port}`;
  await ready(`${base}/health`, running, headers);
  const models = await fetch(`${base}/v1/models`, { headers });
  assert.equal(models.status, 200);
  assert.equal((await models.json()).data[0].id, "fixture-model");
  let collected;
  for (const stream of [false, true]) {
    const response = await fetch(`${base}/v1/chat/completions`, {
      method: "POST", headers, signal: AbortSignal.timeout(5_000),
      body: JSON.stringify({ model: "fixture-model", messages: [{ role: "user", content: "invoke fixtures" }], stream }),
    });
    assert.equal(response.status, 200, running.output().stderr);
    if (!stream) {
      collected = (await response.json()).choices[0].message.tool_calls;
      assert.deepEqual(collected.map((call) => [call.id, call.function.name, JSON.parse(call.function.arguments)]), [
        ["call-one", "ping", { value: 1 }], ["call-two", "pong", { next: 2 }],
      ]);
    } else {
      const assembled = [];
      for (const event of sseEvents(await response.text())) {
        for (const call of event.choices?.[0]?.delta?.tool_calls || []) {
          const held = assembled[call.index] ||= { id: call.id, type: call.type, function: { name: call.function.name, arguments: "" } };
          held.function.arguments += call.function.arguments || "";
        }
      }
      assert.deepEqual(assembled, collected, "streamed deltas reconstruct exactly the collected calls without duplicate snapshots");
    }
  }
  assert.equal(seen.length, 3, "one discovery and two turns, with no replay");
  for (const request of seen) {
    assert.equal(request.metadata.ideName, "chisel");
    assert.equal(request.metadata.ideVersion, "0.0.0-dev");
    assert.equal(request.metadata.extensionVersion, "0.0.0-dev");
  }
  assert.equal(seen[1].metadata.os, process.platform === "darwin" ? "darwin" : process.platform === "win32" ? "win" : "linux");
}

async function claudeScenario(t) {
  const directory = temporary(t);
  const fake = path.join(directory, "claude.mjs");
  const log = path.join(directory, "invocations.jsonl");
  writeFileSync(fake, `#!${process.execPath}\nimport { appendFileSync } from "node:fs";\nlet prompt = "";\nfor await (const chunk of process.stdin) prompt += chunk;\nconst args = process.argv.slice(2);\nappendFileSync(${JSON.stringify(log)}, JSON.stringify({ args, prompt }) + "\\n");\nconst session = args[args.indexOf(args.includes("--resume") ? "--resume" : "--session-id") + 1];\nconsole.log(JSON.stringify({ type: "result", subtype: "success", session_id: session, result: "fixture answer" }));\n`, { mode: 0o700 });
  const env = { MODEL_ROUTER_CLAUDE_BIN: fake, MODEL_ROUTER_AGENT_BRIDGE_STATE: path.join(directory, "sessions.json"), CODEX_HOME: path.join(directory, "codex"), MODEL_ROUTER_STATE_DIR: directory };
  const fresh = await cli(t, "src/agent-bridges.mjs", ["prompt", "anthropic", "--model", "fixture-model", "--effort", "high", "--cwd", directory], env, "PRIVATE_PROMPT_MARKER");
  assert.equal(fresh.code, 0, fresh.stderr);
  const session = JSON.parse(fresh.stdout).sessionId;
  const resumed = await cli(t, "src/agent-bridges.mjs", ["prompt", "anthropic", "--session", session, "--model", "fixture-model", "--effort", "low"], env, "continue");
  assert.equal(resumed.code, 0, resumed.stderr);
  assert.equal(JSON.parse(resumed.stdout).sessionId, session);
  const invocations = readFileSync(log, "utf8").trim().split("\n").map(JSON.parse);
  assert.equal(invocations.length, 2);
  assert.equal(invocations[0].prompt, "PRIVATE_PROMPT_MARKER");
  assert.equal(invocations[0].args.includes("PRIVATE_PROMPT_MARKER"), false);
  for (const [index, invocation] of invocations.entries()) {
    assert.equal(invocation.args[invocation.args.indexOf("--model") + 1], "fixture-model");
    assert.equal(invocation.args[invocation.args.indexOf("--effort") + 1], index ? "low" : "high");
    assert.equal(invocation.args[invocation.args.indexOf("--permission-mode") + 1], "dontAsk");
    assert.equal(invocation.args[invocation.args.indexOf("--tools") + 1], "");
  }
  assert.equal(invocations[1].args[invocations[1].args.indexOf("--resume") + 1], session);
  for (const args of [["anthropic", "--effort", "ultracode"], ["anthropic", "--model"], ["cursor", "--model", "fixture-model"]]) {
    const result = await cli(t, "src/agent-bridges.mjs", ["prompt", ...args], env, undefined, { leaveInputOpen: true });
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /effort|Missing value|only available/);
  }
  assert.equal(readFileSync(log, "utf8").trim().split("\n").length, 2, "invalid controls fail before spawning the CLI");
  assert.doesNotMatch(readFileSync(env.MODEL_ROUTER_AGENT_BRIDGE_STATE, "utf8"), /PRIVATE_PROMPT_MARKER/);
}

async function replayScenario(t) {
  const directory = temporary(t);
  const env = { CODEX_HOME: path.join(directory, "codex"), MODEL_ROUTER_STATE_DIR: directory };
  const replay = await cli(t, "scripts/worker-routing-replay.mjs", ["test/fixtures/worker-routing.json"], env, "");
  assert.equal(replay.code, 0, replay.stderr);
  const report = JSON.parse(replay.stdout);
  assert.equal(report.liveRequests, 0);
  assert.deepEqual(report.outcomes, { accepted: 2, rejected: 1, failed: 0, cancelled: 0 });
  assert.deepEqual(report.rows.map(({ harness, effort }) => [harness, effort]), [["codex", "low"], ["codex", "high"], ["claude", "high"]]);
  assert.equal(report.rows[0].sessionId, report.rows[1].sessionId);
  assert.equal(report.measurements.subscriptionCostUsd, null);
}

async function repetitionScenario(t) {
  const directory = temporary(t);
  const model = "zai-coding/glm-5.3";
  const identity = { id: "guard-fixture", model: "glm-5.3", created_at: 1791388800 };
  const repeated = "The same sentence repeats forever. ".repeat(220);
  const frame = (event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
  let posts = 0;
  let structured = false;
  let cancelled = false;
  const backend = await listen(t, async (request, response) => {
    if (request.method === "GET") { response.end('{"ok":true}'); return; }
    for await (const _ of request) void _;
    posts++;
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    response.write(frame({ type: "response.created", sequence_number: 0, response: { ...identity, status: "in_progress", output: [] } }));
    response.write(frame({ type: "response.output_text.delta", sequence_number: 1, item_id: "message-fixture", delta: structured ? "[" : "Starting. " }));
    const timer = setTimeout(() => {
      const text = structured ? JSON.stringify(Array(220).fill("The same sentence repeats forever.")) : repeated;
      response.write(frame({ type: "response.output_text.delta", sequence_number: 2, item_id: "message-fixture", delta: structured ? text.slice(1) : text }));
      if (structured) response.end(frame({ type: "response.completed", sequence_number: 3, response: {
        ...identity, status: "completed", output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text }] }],
        usage: { input_tokens: 20, output_tokens: 5 },
      } }));
    }, 40);
    response.once("close", () => { clearTimeout(timer); if (!response.writableEnded) cancelled = true; });
  });
  const document = readRegistryDocument(path.join(root, "config"));
  const route = document.models.find((entry) => entry.slug === model);
  assert.ok(route);
  route.repetitionGuard = true;
  const registry = path.join(directory, "registry.json");
  writeFileSync(registry, JSON.stringify(document));
  const port = await openPort();
  const running = child(t, "src/router.mjs", [], {
    CODEX_HOME: path.join(directory, "codex"), MODEL_ROUTER_STATE_DIR: directory,
    MODEL_ROUTER_USER_MODELS: path.join(directory, "absent.json"), MODEL_ROUTER_REGISTRY: registry,
    CODEX_ROUTER_CALLER_KEY: callerKey, CODEX_ROUTER_INTERNAL_KEY: internalKey, KIMI_INTERNAL_KEY: internalKey,
    CODEX_ROUTER_SHOW_ALL_MODELS: "1", CODEX_ROUTER_QUIET: "1", CODEX_ROUTER_PORT: String(port),
    CODEX_ROUTER_GATEWAY_BASE_URL: `${backend}/v1`,
    ...Object.fromEntries(["OAUTH", "API", "GROK_OAUTH", "GATEWAY"].map((service) => [`CODEX_ROUTER_${service}_HEALTH_URL`, `${backend}/health`])),
  });
  const base = callerBaseUrl(port, callerKey);
  await ready(`${base}/models`, running);
  for (structured of [false, true]) {
    const response = await fetch(`${base}/responses`, {
      method: "POST", signal: AbortSignal.timeout(8_000),
      headers: { "Content-Type": "application/json", Authorization: "Bearer fixture-caller" },
      body: JSON.stringify({ model, input: "produce the fixture", stream: true }),
    });
    const text = await response.text();
    assert.equal(response.status, 200, text);
    const events = sseEvents(text);
    if (structured) {
      assert.ok(events.some((event) => event.type === "response.completed"));
      assert.doesNotMatch(text, /router_repetitive_generation/);
    } else {
      const failures = events.filter((event) => event.type === "response.failed");
      assert.equal(failures.length, 1, text);
      assert.equal(failures[0].code, "router_repetitive_generation");
      assert.equal(failures[0].response.error.code, "invalid_prompt");
      assert.doesNotMatch(text, /response.completed|\[DONE\]/);
      for (let attempt = 0; !cancelled && attempt < 100; attempt++) await pause(10);
      assert.equal(cancelled, true, "guard cancels upstream generation");
    }
    assert.equal(posts, structured ? 2 : 1, "no repetition retry or failover");
  }
  const usageFile = path.join(directory, "usage-events.jsonl");
  for (let attempt = 0; attempt < 100; attempt++) {
    if (existsSync(usageFile) && readFileSync(usageFile, "utf8").trim().split("\n").length === 2) break;
    await pause(10);
  }
  const usage = readFileSync(usageFile, "utf8").trim().split("\n").map(JSON.parse);
  assert.equal(usage.length, 2, "each request meters once");
  assert.equal(usage[0].status, 502);
  assert.equal(usage[0].streamAborted, true);
  assert.equal(usage[1].status, 200);
}

export async function runSmallScenarios(t) {
  await t.test("Devin process preserves fragmented calls, snapshots and discovery metadata", devinScenario);
  await t.test("Claude subprocess controls reject before spawn and preserve resumed sessions", {
    skip: process.platform === "win32" ? "The fake Claude executable uses a POSIX shebang." : false,
  }, claudeScenario);
  await t.test("Offline replay reports supplied outcomes and preserves task sessions", replayScenario);
  await t.test("Router repetition stop is terminal without replay; structured text remains valid", repetitionScenario);
  await t.test("OpenCode Go Flash changes stay route-local and retain the conservative threshold", () => {
    const { models } = readRegistryDocument(path.join(root, "config"));
    const route = models.find((entry) => entry.slug === "opencode-go/glm-5.3-flash");
    assert.equal(route.autoCompact, 400000);
    assert.equal(route.compHash, "opencode-go-glm-5-3-flash-v2");
    assert.equal(route.searchTool.mode, "standalone");
    assert.equal(route.behaviorTemplate, "gpt-5.6-sol");
    assert.equal(route.instructionOverlay, "efficient-agentic-v2");
    assert.equal(models.some((entry) => entry.repetitionGuard === true), false);
  });
}
