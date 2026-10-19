import assert from "node:assert/strict";
import http from "node:http";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { callerBaseUrl } from "../src/caller-auth.mjs";
import {
  measureIngressContextBytes,
  utf8JsonBytes,
} from "../src/request-diagnostics.mjs";
import { openPort } from "./port-pool.mjs";
import { spawnNodeFixture, waitForNodeFixture } from "./node-fixture.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const INTERNAL_KEY = "test-internal-service-key-with-sufficient-length";
const CALLER_KEY = "test-router-caller-capability-with-sufficient-length";

function routerBase(port) {
  return callerBaseUrl(port, CALLER_KEY);
}

function json(response, status, payload) {
  const body = Buffer.from(JSON.stringify(payload), "utf8");
  response.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": String(body.length),
  });
  response.end(body);
}

async function bodyJson(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

async function mockServer(handler) {
  const server = http.createServer(handler);
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return { server, port: server.address().port };
}

function run(env) {
  const stateDir =
    env?.MODEL_ROUTER_STATE_DIR ||
    mkdtempSync(path.join(os.tmpdir(), "request-diagnostics-state-"));
  const child = spawnNodeFixture(path.join(root, "src", "router.mjs"), {
    cwd: root,
    env: {
      ...process.env,
      CODEX_HOME: path.join(stateDir, "codex-home"),
      MODEL_ROUTER_STATE_DIR: stateDir,
      CODEX_ROUTER_CALLER_KEY: CALLER_KEY,
      CODEX_ROUTER_INTERNAL_KEY: INTERNAL_KEY,
      KIMI_INTERNAL_KEY: INTERNAL_KEY,
      CODEX_ROUTER_SHOW_ALL_MODELS: "1",
      CODEX_ROUTER_QUIET: "1",
      ...env,
    },
  });
  child.stateDir = stateDir;
  return child;
}

async function waitFor(url, child) {
  await waitForNodeFixture(url, child);
}

async function stopChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  await new Promise((resolve) => child.once("exit", resolve));
}

async function closeServer(server) {
  await new Promise((resolve) => server.close(resolve));
}

function websocketHandshake(url, authenticated) {
  return new Promise((resolve, reject) => {
    const request = http.request(url, { headers: {
      Connection: "Upgrade", Upgrade: "websocket", "Sec-WebSocket-Version": "13",
      "OpenAI-Beta": "responses_websockets=2026-02-06",
      "Sec-WebSocket-Key": Buffer.from("0123456789abcdef").toString("base64"),
      ...(authenticated ? { Authorization: `Bearer ${CALLER_KEY}` } : {}),
    } });
    request.once("error", reject);
    request.once("upgrade", (response, socket) => { socket.destroy(); resolve(response.statusCode); });
    request.once("response", response => { response.resume(); resolve(response.statusCode); });
    request.setTimeout(5000, () => request.destroy(new Error("handshake deadline")));
    request.end();
  });
}

function usageEvents(stateDir) {
  const file = path.join(stateDir, "usage-events.jsonl");
  if (!existsSync(file)) return [];
  const lines = readFileSync(file, "utf8").split("\n");
  if (lines.at(-1) !== "") lines.pop();
  return lines.filter(Boolean).map((line) => JSON.parse(line));
}

async function waitForUsageEvents(stateDir, count, child) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const events = usageEvents(stateDir);
    if (events.length >= count) return events;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for ${count} usage events: ${child.testErrors()}`);
}

const GROK_PAYLOAD = {
  model: "grok-oauth/grok-4.6",
  instructions: "Stay concise.",
  tools: [{ type: "function", name: "read_file" }],
  input: [{ type: "message", role: "user", content: "hello" }],
};

const EXPECTED_CONTEXT = measureIngressContextBytes(GROK_PAYLOAD);

test("Grok 4.6 usage rows correlate with activity id across success, failure, and cancel", async () => {
  let hang;
  let turns = 0;
  const gateway = await mockServer(async (request, response) => {
    if (request.method === "GET" && request.url === "/health") {
      json(response, 200, { ok: true, credential_present: true });
      return;
    }
    await bodyJson(request);
    turns += 1;
    if (turns === 3) {
      hang = new Promise((resolve) => {
        request.once("close", resolve);
        response.once("close", resolve);
      });
      return;
    }
    if (turns === 2) {
      json(response, 502, { error: { message: "upstream refused" } });
      return;
    }
    json(response, 200, {
      id: "resp_grok",
      output: [{ type: "message", content: [{ type: "output_text", text: "ok" }] }],
      usage: {
        input_tokens: 11,
        output_tokens: 4,
        output_tokens_details: { reasoning_tokens: 3 },
      },
    });
  });
  const stateDir = mkdtempSync(path.join(os.tmpdir(), "request-diagnostics-router-"));
  const routerPort = await openPort();
  const router = run({
    CODEX_ROUTER_PORT: String(routerPort),
    CODEX_ROUTER_GATEWAY_BASE_URL: `http://127.0.0.1:${gateway.port}/v1`,
    CODEX_ROUTER_OAUTH_HEALTH_URL: `http://127.0.0.1:${gateway.port}/health`,
    CODEX_ROUTER_API_HEALTH_URL: `http://127.0.0.1:${gateway.port}/health`,
    CODEX_ROUTER_GROK_OAUTH_HEALTH_URL: `http://127.0.0.1:${gateway.port}/health`,
    CODEX_ROUTER_GATEWAY_HEALTH_URL: `http://127.0.0.1:${gateway.port}/health`,
    MODEL_ROUTER_STATE_DIR: stateDir,
  });
  const headers = { "Content-Type": "application/json" };

  try {
    await waitFor(`${routerBase(routerPort)}/models`, router);

    const ok = await fetch(`${routerBase(routerPort)}/responses`, {
      method: "POST",
      headers,
      body: JSON.stringify(GROK_PAYLOAD),
    });
    assert.equal(ok.status, 200, await ok.text());
    const [success] = await waitForUsageEvents(stateDir, 1, router);
    assert.equal(success.model, "grok-oauth/grok-4.6");
    assert.equal(success.provider, "grok-oauth");
    assert.equal(success.status, 200);
    assert.equal(success.reasoningTokens, 3);
    assert.equal(success.inputTokens, 11);
    assert.equal(success.outputTokens, 4);
    assert.match(success.requestId, /^[a-f0-9-]+:[0-9]+$/);
    const completedActivity = await (await fetch(`${routerBase(routerPort)}/activity`)).json();
    assert.ok(completedActivity.recent.some((entry) => entry.requestId === success.requestId && entry.status === 200));
    assert.deepEqual(success.contextBytes, EXPECTED_CONTEXT);
    assert.equal(success.contextBytes.instructionsBytes, utf8JsonBytes("Stay concise."));
    assert.equal("reasoningOutputTokens" in success, false);

    const failed = await fetch(`${routerBase(routerPort)}/responses`, {
      method: "POST",
      headers,
      body: JSON.stringify(GROK_PAYLOAD),
    });
    assert.equal(failed.status, 502);
    const events = await waitForUsageEvents(stateDir, 2, router);
    const failure = events.at(-1);
    assert.equal(failure.status, 502);
    assert.notEqual(failure.requestId, success.requestId);
    const failedActivity = await (await fetch(`${routerBase(routerPort)}/activity`)).json();
    assert.ok(failedActivity.recent.some((entry) => entry.requestId === failure.requestId && entry.status === 502));
    assert.deepEqual(failure.contextBytes, EXPECTED_CONTEXT);
    assert.equal("reasoningTokens" in failure, false);

    const canceler = new AbortController();
    const held = fetch(`${routerBase(routerPort)}/responses`, {
      method: "POST",
      headers,
      body: JSON.stringify(GROK_PAYLOAD),
      signal: canceler.signal,
    }).catch(() => undefined);
    const deadline = Date.now() + 3_000;
    let activityId;
    while (!activityId && Date.now() < deadline) {
      const activity = await fetch(`${routerBase(routerPort)}/activity`);
      const payload = await activity.json();
      const active = payload.active?.find(
        (entry) => entry.model === "grok-oauth/grok-4.6",
      );
      activityId = active?.requestId || active?.id;
      if (!activityId) await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.ok(activityId, "in-flight activity did not publish a request id");
    canceler.abort();
    await held;
    if (hang) await hang;
    const afterCancel = await waitForUsageEvents(stateDir, 3, router);
    const canceled = afterCancel.at(-1);
    assert.equal(canceled.status, 0);
    assert.equal(canceled.requestId, activityId);
    assert.deepEqual(canceled.contextBytes, EXPECTED_CONTEXT);

    const raw = readFileSync(path.join(stateDir, "usage-events.jsonl"), "utf8");
    assert.equal(raw.includes("Stay concise."), false);
    assert.equal(raw.includes("read_file"), false);
    assert.equal(raw.includes("hello"), false);
  } finally {
    await stopChild(router);
    await closeServer(gateway.server);
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("a canceled native stream settles as canceled, not as the upstream's 200", async () => {
  let upstreamClosed;
  const upstreamGone = new Promise((resolve) => {
    upstreamClosed = resolve;
  });
  const native = await mockServer(async (request, response) => {
    await bodyJson(request);
    response.once("close", upstreamClosed);
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    // One event, then the upstream keeps streaming until the client leaves.
    response.write('data: {"type":"response.image_generation_call.partial_image"}\n\n');
  });
  const gateway = await mockServer((_request, response) => {
    json(response, 200, { ok: true, credential_present: true });
  });
  const stateDir = mkdtempSync(path.join(os.tmpdir(), "request-diagnostics-native-"));
  const routerPort = await openPort();
  const router = run({
    CODEX_ROUTER_PORT: String(routerPort),
    CODEX_NATIVE_BASE_URL: `http://127.0.0.1:${native.port}/backend-api/codex`,
    CODEX_ROUTER_GATEWAY_BASE_URL: `http://127.0.0.1:${gateway.port}/v1`,
    CODEX_ROUTER_OAUTH_HEALTH_URL: `http://127.0.0.1:${gateway.port}/health`,
    CODEX_ROUTER_API_HEALTH_URL: `http://127.0.0.1:${gateway.port}/health`,
    CODEX_ROUTER_GROK_OAUTH_HEALTH_URL: `http://127.0.0.1:${gateway.port}/health`,
    CODEX_ROUTER_GATEWAY_HEALTH_URL: `http://127.0.0.1:${gateway.port}/health`,
    MODEL_ROUTER_STATE_DIR: stateDir,
  });
  try {
    await waitFor(`${routerBase(routerPort)}/models`, router);
    const canceler = new AbortController();
    await fetch(`${routerBase(routerPort)}/images/generations`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer native-session-token" },
      body: JSON.stringify({ model: "gpt-image-2", prompt: "a lighthouse", stream: true }),
      signal: canceler.signal,
    })
      .then(async (response) => {
        assert.equal(response.status, 200);
        await response.body.getReader().read();
        canceler.abort();
      })
      .catch((error) => {
        if (error?.name !== "AbortError") throw error;
      });
    await upstreamGone;
    const [event] = await waitForUsageEvents(stateDir, 1, router);
    assert.equal(event.status, 0);
    assert.equal(event.provider, "openai");
    const activity = await (await fetch(`${routerBase(routerPort)}/activity`)).json();
    const settled = activity.recent.find((entry) => entry.requestId === event.requestId);
    assert.ok(settled, JSON.stringify(activity));
    assert.equal(settled.state, "canceled");
    assert.equal(settled.cancelReason, "client_disconnected");
    assert.equal(settled.status, 0);
  } finally {
    await stopChild(router);
    await closeServer(native.server);
    await closeServer(gateway.server);
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("a non-Grok-4.6 turn still records requestId and omits contextBytes", async () => {
  const gateway = await mockServer(async (request, response) => {
    if (request.method === "GET" && request.url === "/health") {
      json(response, 200, { ok: true, credential_present: true });
      return;
    }
    await bodyJson(request);
    json(response, 200, {
      id: "resp_ds",
      usage: { input_tokens: 2, output_tokens: 1 },
    });
  });
  const stateDir = mkdtempSync(path.join(os.tmpdir(), "request-diagnostics-other-"));
  const routerPort = await openPort();
  const router = run({
    CODEX_ROUTER_PORT: String(routerPort),
    CODEX_ROUTER_GATEWAY_BASE_URL: `http://127.0.0.1:${gateway.port}/v1`,
    CODEX_ROUTER_OAUTH_HEALTH_URL: `http://127.0.0.1:${gateway.port}/health`,
    CODEX_ROUTER_API_HEALTH_URL: `http://127.0.0.1:${gateway.port}/health`,
    CODEX_ROUTER_GROK_OAUTH_HEALTH_URL: `http://127.0.0.1:${gateway.port}/health`,
    CODEX_ROUTER_GATEWAY_HEALTH_URL: `http://127.0.0.1:${gateway.port}/health`,
    MODEL_ROUTER_STATE_DIR: stateDir,
  });

  try {
    await waitFor(`${routerBase(routerPort)}/models`, router);
    const response = await fetch(`${routerBase(routerPort)}/responses`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "deepseek/deepseek-v4-pro",
        instructions: "should not be measured",
        input: "go",
      }),
    });
    assert.equal(response.status, 200, await response.text());
    const [event] = await waitForUsageEvents(stateDir, 1, router);
    assert.match(event.requestId, /^[a-f0-9-]+:[0-9]+$/);
    assert.equal("contextBytes" in event, false);
    const raw = readFileSync(path.join(stateDir, "usage-events.jsonl"), "utf8");
    assert.equal(raw.includes("should not be measured"), false);
  } finally {
    await stopChild(router);
    await closeServer(gateway.server);
    rmSync(stateDir, { recursive: true, force: true });
  }
});

for (const mode of ["structured", "header", "endpoint"]) test(`actual routed usage records ${mode} version and application without payload content`, async () => {
  const hookMode = mode !== "structured";
  const gateway = await mockServer(async (request, response) => {
    if (request.method === "GET") return json(response, 200, { ok: true, credential_present: true });
    const payload = await bodyJson(request);
    assert.equal(request.headers["x-codex-router-patch-hook"], undefined);
    assert.equal(request.url.includes("structured-patch-v1"), false);
    const patch = payload.tools?.find(tool => tool.parameters?.properties?.operations);
    json(response, 200, { id: "resp_diagnostic", output: hookMode && patch
      ? [{ type: "function_call", id: "fc_hook", call_id: "call_hook", name: patch.name, arguments: "{" }]
      : [{ type: "message", content: [{ type: "output_text", text: "ok" }] }] });
  });
  const routerPort = await openPort();
  const router = run({
    CODEX_ROUTER_PORT: String(routerPort),
    CODEX_ROUTER_GATEWAY_BASE_URL: `http://127.0.0.1:${gateway.port}/v1`,
    CODEX_ROUTER_GROK_OAUTH_HEALTH_URL: `http://127.0.0.1:${gateway.port}/health`,
    CODEX_ROUTER_GROK_STRUCTURED_PATCH: hookMode ? "0" : "1",
    CODEX_ROUTER_GROK_PATCH_HOOK: hookMode ? "1" : "0",
  });
  try {
    await waitFor(`${routerBase(routerPort)}/models`, router);
    if (mode === "endpoint") {
      const unauthenticated = await fetch(`http://127.0.0.1:${routerPort}/v1/_codex-router/structured-patch-v1/models`);
      assert.equal(unauthenticated.status, 401);
      await unauthenticated.text();
      const authenticated = await fetch(`http://127.0.0.1:${routerPort}/v1/_codex-router/structured-patch-v1/models`, { headers: { Authorization: `Bearer ${CALLER_KEY}` } });
      assert.equal(authenticated.status, 200);
      await authenticated.text();
      const wsUrl = `http://127.0.0.1:${routerPort}/v1/_codex-router/structured-patch-v1/responses`;
      assert.equal(await websocketHandshake(wsUrl, false), 401);
      assert.equal(await websocketHandshake(wsUrl, true), 101);
    }
    for (const applied of [true, false]) {
      const response = await fetch(`${routerBase(routerPort)}${mode === "endpoint" ? "/_codex-router/structured-patch-v1" : ""}/responses`, {
        method: "POST", headers: { "Content-Type": "application/json", ...(mode === "header" ? { "x-codex-router-patch-hook": "structured-patch-v1" } : {}) },
        body: JSON.stringify({ ...GROK_PAYLOAD, tools: applied ? [{ type: "custom", name: "apply_patch", description: "private tool description" }] : GROK_PAYLOAD.tools }),
      });
      const body = await response.text();
      assert.equal(response.status, 200, body);
      if (hookMode && applied) {
        const item = JSON.parse(body).output[0];
        assert.equal(item.type, "custom_tool_call");
        assert.equal(item.call_id, "call_hook");
        assert.equal(item.input, "CODEX_ROUTER_STRUCTURED_PATCH_V1\n{");
      }
      const events = await waitForUsageEvents(router.stateDir, applied ? 1 : 2, router);
      assert.deepEqual(events.at(-1).grokStructuredPatch, { enabled: true, applied, schemaVersion: 1, ...(hookMode ? { mode: "client_hook" } : {}) });
    }
    const raw = readFileSync(path.join(router.stateDir, "usage-events.jsonl"), "utf8");
    assert.equal(raw.includes("private tool description"), false);
    assert.equal(raw.includes("Stay concise."), false);
  } finally {
    await stopChild(router);
    await closeServer(gateway.server);
    rmSync(router.stateDir, { recursive: true, force: true });
  }
});
