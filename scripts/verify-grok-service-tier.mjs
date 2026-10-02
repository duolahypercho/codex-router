import { writeGrokVersionCli } from "../test/grok-version-fixture.mjs";
// Synthetic loopback-only proof using the repository's locked LiteLLM runtime.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket } from "undici";
import { RESPONSES_WEBSOCKET_BETA } from "../src/responses-websocket.mjs";
import { callerBaseUrl } from "../src/caller-auth.mjs";
import { renderLiteLlmConfig } from "../src/litellm-config.mjs";
import { tokenUsageFromPayload } from "../src/response-usage.mjs";
import { openPort } from "../test/port-pool.mjs";

assert.ok(process.argv[2], "pass the locked venv Python executable");
const python = path.resolve(process.argv[2]);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const temp = mkdtempSync(path.join(os.tmpdir(), "grok-tier-proof-"));
const key = "sk-synthetic-grok-tier-internal-key-long-enough";
const pieces = Array.from({ length: 1000 }, (_, i) => `piece-${i}-Привет\n`);
const expected = pieces.join("");
let requested;
let actual = "priority";
const upstream = http.createServer(async (req, res) => {
  const body = [];
  for await (const chunk of req) body.push(chunk);
  requested = JSON.parse(Buffer.concat(body));
  res.writeHead(200, { "Content-Type": "text/event-stream" });
  const event = value => res.write(`event: ${value.type}\ndata: ${JSON.stringify(value)}\n\n`);
  for (const delta of pieces) event({ type: "response.output_text.delta", delta });
  event({ type: "response.completed", response: {
    ...(actual !== undefined ? { service_tier: actual } : {}),
    usage: { input_tokens: 10, output_tokens: 1000 },
  } });
  res.end();
});
await new Promise(resolve => upstream.listen(0, "127.0.0.1", resolve));
const port = await openPort();
const authPath = path.join(temp, "auth.json");
writeFileSync(authPath, JSON.stringify({ "https://auth.x.ai::synthetic": { key: "fake-access" } }), { mode: 0o600 });
const forwarder = spawn(process.execPath, [path.join(root, "src/grok-oauth-forwarder.mjs")], {
  cwd: root,
  env: { ...process.env, MODEL_ROUTER_INTERNAL_KEY: key, MODEL_ROUTER_GROK_OAUTH_PORT: String(port),
    GROK_CLI_CHAT_PROXY_BASE_URL: `http://127.0.0.1:${upstream.address().port}`,
    GROK_AUTH_PATH: authPath, GROK_CLI: writeGrokVersionCli(temp), MODEL_ROUTER_QUIET: "1" },
  stdio: ["ignore", "ignore", "pipe"],
});
let errors = "";
forwarder.stderr.on("data", chunk => { errors = (errors + chunk).slice(-8000); });

const gatewayPort = await openPort();
const routerPort = await openPort();
const configPath = path.join(temp, "litellm.yaml");
assert.match(renderLiteLlmConfig(), /callbacks: \[grok_service_tier_callback.grok_service_tier_callback\]/);
writeFileSync(path.join(temp, "grok_service_tier_callback.py"), readFileSync(path.join(root, "src/grok_service_tier_callback.py")));
writeFileSync(configPath, JSON.stringify({
  model_list: ["grok-4.6", "grok-4.5"].map(model => ({
    model_name: `grok-oauth-${model.replaceAll(".", "-")}`,
    litellm_params: { model: `openai/${model}`, api_base: `http://127.0.0.1:${port}/v1`, api_key: key, use_chat_completions_api: true },
  })),
  litellm_settings: { drop_params: true, callbacks: ["grok_service_tier_callback.grok_service_tier_callback"] },
  general_settings: { master_key: key, disable_spend_logs: true },
}));
const processErrors = new Map();
function start(executable, args, env) {
  const child = spawn(executable, args, { cwd: temp, env: { ...process.env, ...env }, stdio: ["ignore", "ignore", "pipe"] });
  processErrors.set(child, "");
  child.stderr.on("data", c => processErrors.set(child, (processErrors.get(child) + c).slice(-8000)));
  return child;
}
let gateway, router;
function usageRecords() {
  const file = path.join(temp, "usage-events.jsonl");
  if (!existsSync(file)) return [];
  const text = readFileSync(file, "utf8");
  // Another process may still be appending the final JSONL record. Only a
  // newline commits a row; malformed completed rows must still fail.
  const end = text.lastIndexOf("\n");
  return end < 0 ? [] : text.slice(0, end).split("\n").filter(Boolean).map(JSON.parse);
}
async function ready(url, child, headers = {}) {
  const deadline = Date.now() + 45000;
  while (true) {
    assert.equal(child.exitCode, null, processErrors.get(child));
    try { if ((await fetch(url, { headers })).ok) return; } catch {}
    assert.ok(Date.now() < deadline, processErrors.get(child));
    await new Promise(resolve => setTimeout(resolve, 100));
  }
}
async function run(model, tier, streaming) {
  const usageBefore = usageRecords().length;
  const requestBody = { model: `grok-oauth/${model}`, input: [{ type: "message", role: "user", content: "synthetic fixture" }], stream: streaming !== false,
    ...(tier === "omit" ? {} : { service_tier: tier }) };
  let body;
  if (streaming === "ws") {
    const url = `${callerBaseUrl(routerPort, key)}/responses`.replace("http:", "ws:");
    body = await new Promise((resolve, reject) => {
      const socket = new WebSocket(url, { headers: { "OpenAI-Beta": RESPONSES_WEBSOCKET_BETA } });
      const events = [];
      const timer = setTimeout(() => { socket.close(); reject(new Error("WS terminal deadline")); }, 60000);
      socket.addEventListener("open", () => socket.send(JSON.stringify({ ...requestBody, type: "response.create" })));
      socket.addEventListener("error", () => { clearTimeout(timer); reject(new Error("WS failed")); });
      socket.addEventListener("message", event => {
        const payload = JSON.parse(event.data);
        events.push(payload);
        if (payload.type === "response.completed" || payload.type === "error") {
          clearTimeout(timer); socket.close();
          resolve(events.map(e => `data: ${JSON.stringify(e)}\n\n`).join(""));
        }
      });
    });
  } else {
  const reply = await fetch(`${callerBaseUrl(routerPort, key)}/responses`, {
    method: "POST", headers: { "Content-Type": "application/json" }, signal: AbortSignal.timeout(60000),
    body: JSON.stringify(requestBody),
  });
  body = await reply.text();
  assert.equal(reply.status, 200, body);
  }
  let terminal;
  if (streaming) {
    const delivered = body.split("\n").filter(s => s.startsWith("data: {")).map(s => JSON.parse(s.slice(6)));
    assert.equal(delivered.find(e => e.type === "error"), undefined, body);
    assert.equal(delivered.filter(e => e.type === "response.output_text.delta").map(e => e.delta).join(""), expected);
    terminal = delivered.find(e => e.type === "response.completed")?.response;
  } else terminal = JSON.parse(body);
  assert.ok(terminal, "terminal response required");
  assert.equal(terminal.output.filter(x => x.type === "message").flatMap(x => x.content).map(x => x.text || "").join(""), expected);
  const known = actual === "default" || actual === "priority";
  const want = model === "grok-4.6" ? (known ? actual : actual === undefined ? undefined : "unknown") : undefined;
  assert.equal(terminal.provider_specific_fields?.grok_service_tier, want);
  assert.equal(tokenUsageFromPayload(terminal, { grokServiceTier: model === "grok-4.6" })?.serviceTier, known && model === "grok-4.6" ? actual : undefined);
  assert.equal(requested.service_tier, model === "grok-4.6" && tier !== "omit" ? tier : undefined);
  const deadline = Date.now() + 2000;
  while (usageRecords().length === usageBefore && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
  const row = usageRecords().at(-1);
  assert.ok(usageRecords().length > usageBefore, "new usage row required");
  assert.equal(row.requestedServiceTier, model === "grok-4.6" && tier !== "omit" ? tier : undefined);
  assert.equal(row.serviceTier, known && model === "grok-4.6" ? actual : undefined);
  assert.equal(row.serviceTierUnknown, want === "unknown" ? true : undefined);
  assert.equal(row.inputTokens, 10);
  assert.equal(row.outputTokens, 1000);
  assert.equal(JSON.stringify(row).includes("synthetic fixture"), false);
  console.log(JSON.stringify({ model, requested: tier, actual: want ?? "missing", streaming, textPieces: 1000, textPreserved: true }));
}
try {
  // Exercise the cross-process read boundary before the Router starts.
  const ledgerFixture = path.join(temp, "usage-events.jsonl");
  writeFileSync(ledgerFixture, '{"inputTokens":');
  assert.deepEqual(usageRecords(), []);
  writeFileSync(ledgerFixture, '{"inputTokens":10}\n{"outputTokens":');
  assert.deepEqual(usageRecords(), [{ inputTokens: 10 }]);
  writeFileSync(ledgerFixture, '{"broken":}\n');
  assert.throws(usageRecords, SyntaxError);
  rmSync(ledgerFixture);
  const deadline = Date.now() + 10000;
  while (true) {
    assert.equal(forwarder.exitCode, null, errors);
    try { if ((await fetch(`http://127.0.0.1:${port}/health`, { headers: { Authorization: `Bearer ${key}` } })).ok) break; } catch {}
    assert.ok(Date.now() < deadline, errors);
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  gateway = start(python, ["-c", "import importlib.metadata; assert importlib.metadata.version('litellm') == '1.96.0'; from litellm import run_server; run_server()", "--config", configPath, "--host", "127.0.0.1", "--port", String(gatewayPort)], {
    LITELLM_LOCAL_MODEL_COST_MAP: "True", DATABASE_URL: undefined, LITELLM_MASTER_KEY: key,
    // Match production startup: LiteLLM prints Unicode on Windows too.
    PYTHONIOENCODING: "utf-8", PYTHONUTF8: "1",
  });
  await ready(`http://127.0.0.1:${gatewayPort}/health/liveliness`, gateway);
  router = start(process.execPath, [path.join(root, "src/router.mjs")], {
    MODEL_ROUTER_STATE_DIR: temp, CODEX_ROUTER_STATE_DIR: temp,
    CODEX_ROUTER_PORT: String(routerPort), CODEX_ROUTER_GATEWAY_BASE_URL: `http://127.0.0.1:${gatewayPort}/v1`,
    CODEX_ROUTER_CALLER_KEY: key, CODEX_ROUTER_INTERNAL_KEY: key, MODEL_ROUTER_INTERNAL_KEY: key,
    CODEX_ROUTER_SHOW_ALL_MODELS: "1", CODEX_ROUTER_QUIET: "1",
  });
  await ready(`${callerBaseUrl(routerPort, key)}/models`, router);
  for (const streaming of [true, false, "ws"]) {
    actual = "priority"; await run("grok-4.6", "priority", streaming);
    actual = "default"; await run("grok-4.6", "priority", streaming);
    await run("grok-4.6", "default", streaming);
    await run("grok-4.6", "omit", streaming);
    actual = undefined; await run("grok-4.6", "priority", streaming);
    actual = "future-tier"; await run("grok-4.6", "priority", streaming);
    actual = "priority"; await run("grok-4.5", "priority", streaming);
  }
} finally {
  for (const child of [router, gateway]) {
    if (child?.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
      const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
      await once(child, "exit"); clearTimeout(timer);
    }
  }
  if (forwarder.exitCode === null) { forwarder.kill("SIGTERM"); await once(forwarder, "exit"); }
  upstream.closeAllConnections();
  await new Promise(resolve => upstream.close(resolve));
  rmSync(temp, { recursive: true, force: true });
}
