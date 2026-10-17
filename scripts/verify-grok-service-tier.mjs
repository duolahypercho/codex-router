import { writeGrokVersionCli } from "../test/grok-version-fixture.mjs";
// Synthetic loopback-only proof using the repository's locked LiteLLM runtime.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
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
import { PYTHON_REQUIREMENTS, requirementParts } from "../src/install-plan.mjs";
import { tokenUsageFromPayload } from "../src/response-usage.mjs";
import { openPort } from "../test/port-pool.mjs";
import { CODEX_APP_TOOLS } from "../src/codex-app-tools.mjs";
import { grokToolSchema } from "../src/grok-tool-schema.mjs";
import { MODELS } from "../src/model-registry.mjs";

assert.ok(process.argv[2], "pass the locked venv Python executable");
const python = path.resolve(process.argv[2]);
const litellmVersion = PYTHON_REQUIREMENTS.map(requirementParts)
  .find(({ name }) => name === "litellm")?.version;
assert.ok(litellmVersion, "the installer must pin LiteLLM");
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const temp = mkdtempSync(path.join(os.tmpdir(), "grok-tier-proof-"));
const key = "sk-synthetic-grok-tier-internal-key-long-enough";
const pieces = Array.from({ length: 1000 }, (_, i) => `piece-${i}-Привет\n`);
const expected = pieces.join("");
let requested;
let actual = "priority";
let postTool = false;
let aggregateUsage = false;
let repair = false;
let terminalDelayMs = 0;
let emptyReplies = 0;
let provider = "grok-oauth";
let upstreamRequests = 0;
let compaction = false;
const automationSchema = CODEX_APP_TOOLS.find(tool => tool.name === "codex_app")
  .tools.find(tool => tool.name === "automation_update").inputSchema;
const upstream = http.createServer(async (req, res) => {
  upstreamRequests += 1;
  const body = [];
  for await (const chunk of req) body.push(chunk);
  requested = JSON.parse(Buffer.concat(body));
  if (req.url === "/v1/chat/completions") {
    const usage = { prompt_tokens: 10, completion_tokens: 1000, total_tokens: 1010, prompt_tokens_details: { cached_tokens: 0 } };
    const common = { id: "chatcmpl-api-fixture", model: requested.model, created: 1,
      ...(actual !== undefined ? { service_tier: actual } : {}) };
    if (!requested.stream) {
      const data = JSON.stringify({ ...common, object: "chat.completion",
        choices: [{ index: 0, message: { role: "assistant", content: expected }, finish_reason: "stop" }], usage });
      res.writeHead(200, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) });
      res.end(data);
    } else {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      for (const delta of pieces) res.write(`data: ${JSON.stringify({ ...common, object: "chat.completion.chunk", choices: [{ index: 0, delta: { content: delta }, finish_reason: null }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ ...common, object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ ...common, object: "chat.completion.chunk", choices: [], usage })}\n\n`);
      res.end("data: [DONE]\n\n");
    }
    return;
  }
  res.writeHead(200, { "Content-Type": "text/event-stream" });
  const event = value => res.write(`event: ${value.type}\ndata: ${JSON.stringify(value)}\n\n`);
  if (emptyReplies > 0) {
    emptyReplies -= 1;
    event({ type: "response.completed", response: { usage: { input_tokens: 572089, output_tokens: 0 } } });
    res.end();
    return;
  }
  let output;
  if (postTool) {
    assert.equal(requested.max_output_tokens, 4096, "caller budget survives Router and locked LiteLLM");
    const final = requested.tools.find(tool => tool.name?.startsWith("__codex_router_submit_final"));
    assert.ok(final, "first post-tool generation must offer the private final");
    assert.equal(requested.tool_choice, "auto");
    assert.equal(requested.temperature, 0.7);
    assert.equal(requested.top_p, 0.95);
    const operations = requested.tools.filter(tool => tool.name?.startsWith("fixture_operation__"));
    const adapted = grokToolSchema(automationSchema);
    assert.equal(operations.length, adapted.oneOf.length);
    for (const [index, operation] of operations.entries()) {
      assert.equal(operation.strict, true);
      assert.deepEqual(operation.parameters, { ...adapted.oneOf[index], $defs: automationSchema.$defs, $schema: automationSchema.$schema }, "each operation survives Router and locked LiteLLM as a complete function");
    }
    const item = { type: "function_call", id: "fc_final", call_id: "call_final", name: final.name, arguments: JSON.stringify({ answer: expected.trimEnd() }) };
    event({ type: "response.output_item.added", output_index: 0, item: { ...item, arguments: "" } });
    event({ type: "response.function_call_arguments.delta", output_index: 0, item_id: item.id, delta: item.arguments });
    event({ type: "response.output_item.done", output_index: 0, item });
    output = [item];
  } else if (compaction) {
    event({ type: "response.output_text.delta", delta: "Synthetic compaction summary." });
  } else {
    for (const delta of pieces) event({ type: "response.output_text.delta", delta });
  }
  if (terminalDelayMs) await new Promise(resolve => setTimeout(resolve, terminalDelayMs));
  event({ type: "response.completed", response: {
    ...(output ? { output } : {}),
    ...(actual !== undefined ? { service_tier: actual } : {}),
    usage: { input_tokens: aggregateUsage ? 572089 : 10, output_tokens: 1000,
      input_tokens_details: { cached_tokens: aggregateUsage ? 500000 : 0 } },
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
    GROK_AUTH_PATH: authPath, GROK_CLI: writeGrokVersionCli(temp), CODEX_ROUTER_GROK_REASONING_CARRY: "1", MODEL_ROUTER_QUIET: "1" },
  stdio: ["ignore", "ignore", "pipe"],
});
const maxLogBytes = 64 * 1024;
let errors = "";
forwarder.stderr.on("data", chunk => { errors = (errors + chunk).slice(-maxLogBytes); });

const gatewayPort = await openPort();
const apiPort = await openPort();
const routerPort = await openPort();
const configPath = path.join(temp, "litellm.yaml");
const callbacks = ["grok_service_tier_callback.grok_service_tier_callback", "litellm_stream_cleanup_callback.stream_cleanup_callback"];
assert.ok(renderLiteLlmConfig().includes(`callbacks: [${callbacks.join(", ")}]`));
for (const name of ["grok_service_tier_callback.py", "litellm_stream_cleanup_callback.py"]) {
  writeFileSync(path.join(temp, name), readFileSync(path.join(root, "src", name)), { mode: 0o600 });
}
// Parse the actual publisher output with the locked gateway's YAML reader.
// Only endpoint substitution and catalog selection isolate this proof; provider
// parameter policy, callbacks, timeouts and router settings are production's.
const gatewayConfig = JSON.parse(execFileSync(python, ["-c",
  "import json,sys,yaml; print(json.dumps(yaml.safe_load(sys.stdin.read())))"], {
  input: renderLiteLlmConfig(), encoding: "utf8",
}));
gatewayConfig.model_list = gatewayConfig.model_list.filter(route =>
  /^grok-(oauth|api)-grok-4-[567]$/.test(route.model_name));
assert.equal(gatewayConfig.model_list.length, 5, "all published Grok presets are covered");
for (const route of gatewayConfig.model_list) {
  route.litellm_params.api_base = `http://127.0.0.1:${route.model_name.startsWith("grok-oauth-") ? port : apiPort}/v1`;
  route.litellm_params.api_key = key;
}
gatewayConfig.general_settings.master_key = key;
writeFileSync(configPath, JSON.stringify(gatewayConfig), { mode: 0o600 });
const processErrors = new Map();
function start(executable, args, env) {
  const child = spawn(executable, args, { cwd: temp, env: { ...process.env, ...env }, stdio: ["ignore", "ignore", "pipe"] });
  processErrors.set(child, "");
  child.stderr.on("data", c => processErrors.set(child, (processErrors.get(child) + c).slice(-maxLogBytes)));
  return child;
}
let gateway, router, apiForwarder;
function timingRecords(child) {
  const output = child === forwarder ? errors : processErrors.get(child) || "";
  return output.split("\n").filter(line => line.startsWith("[grok-timing] "))
    .map(line => JSON.parse(line.slice("[grok-timing] ".length)));
}
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
async function run(model, tier, streaming, reasoning, reasoningForm = "responses") {
  emptyReplies = repair ? 1 : 0;
  const requestsBefore = upstreamRequests;
  const usageBefore = usageRecords().length;
  const requestBody = { model: `${provider}/${model}`, input: [{ type: "message", role: "user", content: "synthetic fixture" }], stream: streaming !== false,
    ...(tier === "omit" ? {} : { service_tier: tier }),
    ...(reasoning ? reasoningForm === "effort" ? { reasoning_effort: reasoning.effort } : { reasoning } : {}) };
  if (postTool) {
    requestBody.max_output_tokens = 4096;
    requestBody.tools = [{ type: "function", name: "fixture_read", parameters: { type: "object", properties: {} } }];
    requestBody.tools.push({ type: "function", name: "fixture_operation", parameters: automationSchema });
    for (let index = 0; index < 3; index++) {
      requestBody.input.push({ type: "function_call", name: "fixture_read", call_id: `seed_read_${index}`, arguments: "{}" },
        { type: "function_call_output", call_id: `seed_read_${index}`, output: "fixture complete" });
    }
  }
  const expectedText = postTool ? expected.trimEnd() : expected;
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
    assert.equal(delivered.filter(e => e.type === "response.output_text.delta").map(e => e.delta).join(""), expectedText);
    terminal = delivered.find(e => e.type === "response.completed")?.response;
  } else terminal = JSON.parse(body);
  assert.ok(terminal, "terminal response required");
  const contextEstimate = terminal.provider_specific_fields?.grok_context_input_tokens;
  if (provider === "grok-oauth") {
    assert.ok(Number.isSafeInteger(contextEstimate) && contextEstimate > 0, "provider request estimate survives locked LiteLLM");
    assert.equal(terminal.usage.input_tokens, contextEstimate, "client sees current context, not cumulative billing");
    assert.equal(terminal.usage.total_tokens, contextEstimate + 1000);
    assert.equal(terminal.usage.input_tokens_details, undefined, "unknown current-context cache omits the entire optional breakdown");
  } else {
    assert.equal(contextEstimate, undefined);
    assert.equal(terminal.usage.input_tokens, 10, "API prompt usage remains provider-measured");
  }
  if (aggregateUsage) assert.ok(contextEstimate < 100000, "572k billed tokens must not force compaction of a small request");
  assert.equal(terminal.output.filter(x => x.type === "message").flatMap(x => x.content).map(x => x.text || "").join(""), expectedText);
  assert.equal(upstreamRequests - requestsBefore, repair ? 2 : 1, "no generation beyond the bounded repair");
  assert.equal(terminal.output.some(item => item.type === "function_call"), false, "private final never reaches client dispatch");
  const known = actual === "default" || actual === "priority";
  const want = !repair ? (known ? actual : actual === undefined ? undefined : "unknown") : undefined;
  assert.equal(terminal.provider_specific_fields?.grok_service_tier, want);
  assert.equal(tokenUsageFromPayload(terminal, { grokServiceTier: true })?.serviceTier, known && !repair ? actual : undefined);
  assert.equal(requested.service_tier, tier !== "omit" ? tier : undefined);
  if (provider === "grok-oauth") {
    assert.deepEqual(requested.reasoning, reasoning ? { effort: reasoning.effort } : undefined,
      "selected effort survives Router, locked LiteLLM and the OAuth forwarder");
    assert.deepEqual(requested.include, reasoning ? ["reasoning.encrypted_content"] : undefined,
      "explicit effort requests the encrypted reasoning needed for the tool loop");
  }
  const deadline = Date.now() + 2000;
  while (usageRecords().length === usageBefore && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
  const row = usageRecords().at(-1);
  assert.ok(usageRecords().length > usageBefore, "new usage row required");
  assert.equal(row.requestedServiceTier, tier !== "omit" ? tier : undefined);
  assert.equal(row.serviceTier, known && !repair ? actual : undefined);
  assert.equal(row.serviceTierUnknown, want === "unknown" ? true : undefined);
  assert.equal(row.inputTokens, aggregateUsage ? 572089 : 10);
  assert.equal(row.cachedInputTokens, aggregateUsage ? 500000 : 0);
  assert.equal(row.estimatedInputTokens, contextEstimate);
  assert.equal(row.billedInputTokens, repair ? 1144178 : undefined);
  assert.equal(row.billedOutputTokens, repair ? 1000 : undefined);
  assert.equal(row.outputTokens, 1000);
  assert.equal(JSON.stringify(row).includes("synthetic fixture"), false);
  if (provider === "grok-oauth") {
    let forwardTiming, routerTiming;
    const timingDeadline = Date.now() + 2000;
    do {
      forwardTiming = timingRecords(forwarder).find(timing => timing.requestId === row.requestId);
      routerTiming = timingRecords(router).find(timing => timing.requestId === row.requestId);
      if (forwardTiming && routerTiming) break;
      await new Promise(resolve => setTimeout(resolve, 20));
    } while (Date.now() < timingDeadline);
    assert.ok(forwardTiming, "owned request ID survives the locked gateway into forwarder timing");
    assert.ok(routerTiming, "the same ID joins Router egress timing and usage");
    assert.equal(forwardTiming.forwardedReasoningEffort, reasoning?.effort ?? null);
    assert.equal(forwardTiming.requestedReasoningEffort, reasoning?.effort ?? null);
    assert.equal(routerTiming.requestedReasoningEffort, reasoning?.effort ?? null);
    assert.equal(forwardTiming.attempts.length, repair ? 2 : 1);
    for (const attempt of forwardTiming.attempts) {
      assert.ok(Number.isInteger(attempt.dispatchMs));
      assert.ok(attempt.headersMs >= attempt.dispatchMs);
      assert.ok(attempt.firstEventMs >= attempt.headersMs);
      assert.ok(attempt.terminalMs >= attempt.firstEventMs);
      assert.ok(attempt.endMs >= attempt.terminalMs);
      assert.equal(attempt.terminal, "completed");
    }
    if (terminalDelayMs && postTool && !repair) {
      const attempt = forwardTiming.attempts[0];
      assert.ok(attempt.firstToolMs < attempt.terminalMs, "upstream tool arrives before the delayed terminal");
      assert.ok(forwardTiming.firstActionMs >= attempt.terminalMs, "post-tool action is held until certified completion");
    }
    for (const value of [forwardTiming, routerTiming]) {
      assert.ok(value.totalMs >= 0);
      const serialized = JSON.stringify(value);
      for (const secret of [key, "fake-access", "synthetic fixture", "piece-0-"]) {
        assert.equal(serialized.includes(secret), false, "timing contains no content or credentials");
      }
    }
  }
  console.log(JSON.stringify({ provider, model, requested: tier, actual: want ?? "missing", streaming, reasoning: reasoning ?? "omitted", reasoningForm, terminalDelayMs, postTool, aggregateUsage, repair, contextEstimate, upstreamRequests: repair ? 2 : 1, textPieces: 1000, textPreserved: true }));
}

async function runCompaction(v2, stream, effortFields) {
  const requestsBefore = upstreamRequests;
  const usageBefore = usageRecords().length;
  const requestBody = { model: "grok-oauth/grok-4.7", stream, service_tier: "priority", ...effortFields,
    tools: [{ type: "function", name: "write_stdin", parameters: { type: "object", properties: { session_id: { type: "integer" } } } }],
    input: [{ type: "message", role: "user", content: "synthetic compact fixture" },
      ...(v2 ? [{ type: "compaction_trigger" }] : [])],
  };
  const reply = await fetch(`${callerBaseUrl(routerPort, key)}/responses${v2 ? "" : "/compact"}`, {
    method: "POST", headers: { "Content-Type": "application/json" }, signal: AbortSignal.timeout(60000),
    body: JSON.stringify(requestBody),
  });
  const body = await reply.text();
  assert.equal(reply.status, 200, body);
  if (stream) {
    const events = body.split("\n").filter(s => s.startsWith("data: {")).map(s => JSON.parse(s.slice(6)));
    const terminal = events.find(event => event.type === "response.completed")?.response;
    assert.equal(terminal?.output[0]?.type, "compaction", body);
  } else assert.ok(JSON.parse(body).output.length > 0, "client receives a usable checkpoint");
  assert.equal(upstreamRequests - requestsBefore, 1, "compaction uses one summary generation");
  const effort = effortFields.reasoning?.effort ?? effortFields.reasoning_effort;
  assert.deepEqual(requested.reasoning, effort ? { effort } : undefined, "compaction effort crosses the locked bridge");
  assert.deepEqual(requested.include, effort ? ["reasoning.encrypted_content"] : undefined);
  assert.equal(requested.tools, undefined, "compaction cannot execute client or hosted tools");
  assert.equal(requested.tool_choice, undefined, "xAI does not accept none with an empty tool list");
  const deadline = Date.now() + 2000;
  let row, routerTiming, forwardTiming;
  do {
    if (usageRecords().length > usageBefore) row = usageRecords().at(-1);
    routerTiming = row && timingRecords(router).find(timing => timing.requestId === row.requestId);
    forwardTiming = row && timingRecords(forwarder).find(timing => timing.requestId === row.requestId);
    if (routerTiming && forwardTiming) break;
    await new Promise(resolve => setTimeout(resolve, 20));
  } while (Date.now() < deadline);
  assert.ok(routerTiming && forwardTiming, "compaction has one correlation ID across all three processes");
  assert.equal(row.requestKind, "compaction");
  assert.equal(row.generationOutcome, "completed");
  assert.equal(row.httpStatus, 200);
  assert.equal(row.providerToolCount, 0);
  assert.equal(routerTiming.requestKind, "compaction");
  assert.equal(routerTiming.requestedReasoningEffort, effort ?? null);
  assert.equal(forwardTiming.forwardedReasoningEffort, effort ?? null);
  assert.ok(routerTiming.preparedMs >= routerTiming.parsedMs);
  assert.ok(routerTiming.firstGatewayDispatchMs >= routerTiming.preparedMs);
  assert.ok(routerTiming.firstGatewayHeadersMs >= routerTiming.firstGatewayDispatchMs);
  assert.ok(routerTiming.terminalMs >= routerTiming.firstGatewayHeadersMs);
  assert.equal(routerTiming.terminal, "completed");
  assert.equal(routerTiming.toolSurfaces.client.known.write_stdin.count, 1);
  assert.equal(routerTiming.toolSurfaces.gateway.count, 0);
  assert.equal(forwardTiming.toolSurfaces.gateway.count, 0);
  assert.equal(forwardTiming.toolSurfaces.upstream.count, 0);
  assert.equal(forwardTiming.attempts.length, 1);
  assert.equal(forwardTiming.attempts[0].terminal, "completed");
  assert.doesNotMatch(JSON.stringify({ row, routerTiming, forwardTiming }), /synthetic compact fixture|Synthetic compaction summary/);
  console.log(JSON.stringify({ compaction: v2 ? "v2" : "v1", stream, effort: effort ?? "omitted",
    correlated: true, measuredStages: true, upstreamRequests: 1 }));
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
  apiForwarder = start(process.execPath, [path.join(root, "src/api-forwarder.mjs")], {
    MODEL_ROUTER_INTERNAL_KEY: key, MODEL_ROUTER_API_PORT: String(apiPort),
    MODEL_ROUTER_STATE_DIR: temp, CODEX_ROUTER_STATE_DIR: temp,
    MODEL_ROUTER_PROVIDER_CREDENTIAL_STORE: path.join(temp, "api-credentials.json"),
    MODEL_ROUTER_API_KEY_POOL_PATH: path.join(temp, "api-pool.json"),
    XAI_API_KEY: "synthetic-api-key", XAI_API_BASE_URL: `http://127.0.0.1:${upstream.address().port}/v1`,
    MODEL_ROUTER_QUIET: "1",
  });
  await ready(`http://127.0.0.1:${apiPort}/health`, apiForwarder, { Authorization: `Bearer ${key}` });
  const deadline = Date.now() + 10000;
  while (true) {
    assert.equal(forwarder.exitCode, null, errors);
    try { if ((await fetch(`http://127.0.0.1:${port}/health`, { headers: { Authorization: `Bearer ${key}` } })).ok) break; } catch {}
    assert.ok(Date.now() < deadline, errors);
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  gateway = start(python, ["-c", `import importlib.metadata; assert importlib.metadata.version('litellm') == ${JSON.stringify(litellmVersion)}; from litellm import run_server; run_server()`, "--config", configPath, "--host", "127.0.0.1", "--port", String(gatewayPort)], {
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
  postTool = true;
  aggregateUsage = true;
  for (const streaming of [true, false, "ws"]) {
    actual = "default"; await run("grok-4.6", "default", streaming);
  }
  repair = true;
  for (const streaming of [true, false, "ws"]) {
    actual = "default"; await run("grok-4.6", "default", streaming);
  }
  repair = false;
  for (const streaming of [true, false, "ws"]) {
    actual = "default"; await run("grok-4.7", "priority", streaming);
    actual = "priority"; await run("grok-4.7", "priority", streaming);
  }
  // Each advertised effort, with and without summary, crosses the real locked
  // gateway in all client transports. A missing effort is checked above too.
  postTool = false;
  aggregateUsage = false;
  for (const route of MODELS.filter(model => model.provider === "grok-oauth")) {
    for (const { effort } of route.reasoningLevels) {
      for (const summary of [undefined, "detailed"]) {
        for (const streaming of [true, false, "ws"]) {
          actual = "priority";
          await run(route.upstreamModel, "priority", streaming, { effort, ...(summary ? { summary } : {}) });
        }
      }
    }
  }
  // Clients using the Chat-shaped effort extension send a scalar rather than
  // a Responses object. Exercise its actual wire form through the same stack.
  for (const streaming of [true, false, "ws"]) {
    await run("grok-4.7", "priority", streaming, { effort: "high" }, "effort");
  }
  // The same object must survive both the initial post-tool decision and its
  // bounded recovery request, where the bridge rebuilds the provider payload.
  postTool = true;
  aggregateUsage = true;
  for (const recover of [false, true]) {
    repair = recover;
    terminalDelayMs = recover ? 0 : 80;
    for (const streaming of [true, false, "ws"]) {
      actual = "priority";
      await run("grok-4.7", "priority", streaming, { effort: "high", summary: "detailed" });
    }
  }
  repair = false;
  terminalDelayMs = 0;
  postTool = false;
  aggregateUsage = false;
  compaction = true;
  for (const effortFields of [{ reasoning: { effort: "medium", summary: "detailed" } }, { reasoning_effort: "high" }, {}]) {
    await runCompaction(false, false, effortFields);
    await runCompaction(true, false, effortFields);
    await runCompaction(true, true, effortFields);
  }
  compaction = false;
  provider = "grok-api";
  postTool = false;
  aggregateUsage = false;
  for (const model of ["grok-4.5", "grok-4.7"]) {
    for (const streaming of [true, false, "ws"]) {
      for (const value of ["priority", "default", undefined]) {
        actual = value; await run(model, "priority", streaming);
      }
    }
  }
} finally {
  for (const child of [router, gateway, apiForwarder]) {
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
