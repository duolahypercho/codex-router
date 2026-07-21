import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import http from "node:http";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const INTERNAL_KEY = "test-cursor-internal-service-key-with-sufficient-length";
const CALLER_KEY = "test-cursor-caller-capability-with-sufficient-length";

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

async function openPort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function mockServer(handler) {
  const server = http.createServer(handler);
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return { server, port: server.address().port };
}

function runRouter(port, gatewayPort, stateDir) {
  const child = spawn(process.execPath, [path.join(root, "src", "cursor-router.mjs")], {
    cwd: root,
    env: {
      ...process.env,
      MODEL_ROUTER_TARGET: "cursor",
      MODEL_ROUTER_STATE_DIR: stateDir,
      MODEL_ROUTER_PORT: String(port),
      MODEL_ROUTER_GATEWAY_BASE_URL: `http://127.0.0.1:${gatewayPort}/v1`,
      MODEL_ROUTER_OAUTH_HEALTH_URL: `http://127.0.0.1:${gatewayPort}/health`,
      MODEL_ROUTER_API_HEALTH_URL: `http://127.0.0.1:${gatewayPort}/health`,
      MODEL_ROUTER_GATEWAY_HEALTH_URL: `http://127.0.0.1:${gatewayPort}/health`,
      MODEL_ROUTER_INTERNAL_KEY: INTERNAL_KEY,
      MODEL_ROUTER_CALLER_KEY: CALLER_KEY,
      MODEL_ROUTER_QUIET: "1",
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  child.stderr.setEncoding("utf8");
  let errors = "";
  child.stderr.on("data", (chunk) => {
    errors += chunk;
  });
  child.testErrors = () => errors;
  return child;
}

async function waitFor(url, child) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`Child exited early (${child.exitCode}): ${child.testErrors()}`);
    }
    try {
      const response = await fetch(url);
      if (response.status < 500) return;
    } catch {
      // The child has not bound its port yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for ${url}: ${child.testErrors()}`);
}

async function stopChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  await new Promise((resolve) => child.once("exit", resolve));
}

async function closeServer(server) {
  await new Promise((resolve) => server.close(resolve));
}

function writeSelection(stateDir, providers) {
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  writeFileSync(
    path.join(stateDir, "enabled-providers.json"),
    `${JSON.stringify({ version: 1, providers })}\n`,
    { mode: 0o600 },
  );
}

test("Cursor router authenticates, lists OpenAI models, and proxies chat completions without leaking caller auth", async () => {
  const requests = [];
  const gateway = await mockServer(async (request, response) => {
    if (request.method === "GET" && request.url === "/health") {
      json(response, 200, { ok: true });
      return;
    }
    const body = await bodyJson(request);
    requests.push({ url: request.url, headers: request.headers, body });
    if (body.stream) {
      response.writeHead(200, { "Content-Type": "text/event-stream" });
      response.end(
        [
          'data: {"id":"chatcmpl-1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"ok"}}]}',
          "data: [DONE]",
          "",
        ].join("\n\n"),
      );
      return;
    }
    json(response, 200, {
      id: "chatcmpl-1",
      object: "chat.completion",
      model: body.model,
      choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    });
  });
  const routerPort = await openPort();
  const testRoot = mkdtempSync(path.join(os.tmpdir(), "cursor-router-routing-"));
  const stateDir = path.join(testRoot, "state");
  writeSelection(stateDir, ["kimi-oauth", "kimi-api", "deepseek"]);
  const router = runRouter(routerPort, gateway.port, stateDir);

  try {
    await waitFor(`http://127.0.0.1:${routerPort}/health`, router);

    const publicHealth = await fetch(`http://127.0.0.1:${routerPort}/health`);
    assert.equal(publicHealth.status, 200);
    const publicBody = await publicHealth.json();
    assert.deepEqual(Object.keys(publicBody).sort(), ["ok", "service", "version"]);
    assert.equal(publicBody.service, "cursor-router");

    // Auth is required for the model catalog.
    assert.equal((await fetch(`http://127.0.0.1:${routerPort}/v1/models`)).status, 401);
    const wrongKey = await fetch(`http://127.0.0.1:${routerPort}/v1/models`, {
      headers: { Authorization: "Bearer wrong-caller-key-with-sufficient-length" },
    });
    assert.equal(wrongKey.status, 401);

    const modelsResponse = await fetch(`http://127.0.0.1:${routerPort}/v1/models`, {
      headers: { Authorization: `Bearer ${CALLER_KEY}` },
    });
    assert.equal(modelsResponse.status, 200);
    const models = await modelsResponse.json();
    assert.equal(models.object, "list");
    assert.deepEqual(
      models.data.map((model) => model.id),
      ["kimi-oauth-k3", "kimi-api-k3", "deepseek-v4-flash", "deepseek-v4-pro"],
    );
    assert.equal(models.data[0].object, "model");

    // Gateway model id passes through untouched; caller auth never leaks.
    const direct = await fetch(`http://127.0.0.1:${routerPort}/v1/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${CALLER_KEY}`,
        "Content-Type": "application/json",
        "X-Private-Header": "must-not-forward",
      },
      body: JSON.stringify({
        model: "kimi-api-k3",
        messages: [{ role: "user", content: "hi" }],
        stream: false,
      }),
    });
    assert.equal(direct.status, 200);
    assert.equal((await direct.json()).object, "chat.completion");
    assert.equal(requests.length, 1);
    assert.equal(requests[0].url, "/v1/chat/completions");
    assert.equal(requests[0].body.model, "kimi-api-k3");
    assert.equal(requests[0].headers.authorization, `Bearer ${INTERNAL_KEY}`);
    assert.equal(requests[0].headers["x-private-header"], undefined);

    // A registry slug is accepted and rewritten to the gateway model id.
    const aliased = await fetch(`http://127.0.0.1:${routerPort}/v1/chat/completions`, {
      method: "POST",
      headers: { "X-Api-Key": CALLER_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "kimi-oauth/k3",
        messages: [{ role: "user", content: "hi" }],
      }),
    });
    assert.equal(aliased.status, 200);
    assert.equal(requests.at(-1).body.model, "kimi-oauth-k3");

    // Streaming responses pass through unchanged.
    const streamed = await fetch(`http://127.0.0.1:${routerPort}/v1/chat/completions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${CALLER_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "deepseek-v4-pro",
        messages: [{ role: "user", content: "hi" }],
        stream: true,
      }),
    });
    assert.equal(streamed.status, 200);
    const streamedBody = await streamed.text();
    assert.match(streamedBody, /chat\.completion\.chunk/);
    assert.match(streamedBody, /\[DONE\]/);

    // Browser-originated requests are rejected before reaching the gateway.
    const beforeBrowser = requests.length;
    const browser = await fetch(`http://127.0.0.1:${routerPort}/v1/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${CALLER_KEY}`,
        Origin: "https://attacker.invalid",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ model: "kimi-api-k3", messages: [{ role: "user", content: "hi" }] }),
    });
    assert.equal(browser.status, 403);
    assert.equal(requests.length, beforeBrowser);
  } finally {
    await stopChild(router);
    await closeServer(gateway.server);
    rmSync(testRoot, { recursive: true, force: true });
  }
});

test("Cursor router rejects disabled and unknown models before reaching the gateway", async () => {
  let gatewayRequests = 0;
  const gateway = await mockServer(async (request, response) => {
    if (request.method === "GET" && request.url === "/health") {
      json(response, 200, { ok: true });
      return;
    }
    gatewayRequests += 1;
    json(response, 200, {});
  });
  const routerPort = await openPort();
  const testRoot = mkdtempSync(path.join(os.tmpdir(), "cursor-router-hidden-"));
  const stateDir = path.join(testRoot, "state");
  writeSelection(stateDir, ["kimi-oauth"]);
  const router = runRouter(routerPort, gateway.port, stateDir);
  const headers = {
    Authorization: `Bearer ${CALLER_KEY}`,
    "Content-Type": "application/json",
  };

  try {
    await waitFor(`http://127.0.0.1:${routerPort}/health`, router);
    for (const [model, status, type] of [
      ["deepseek-v4-pro", 409, "provider_not_enabled"],
      ["unknown-model", 400, "model_not_found"],
    ]) {
      const response = await fetch(`http://127.0.0.1:${routerPort}/v1/chat/completions`, {
        method: "POST",
        headers,
        body: JSON.stringify({ model, messages: [{ role: "user", content: "hi" }] }),
      });
      assert.equal(response.status, status);
      assert.equal((await response.json()).error.type, type);
    }
    assert.equal(gatewayRequests, 0);
  } finally {
    await stopChild(router);
    await closeServer(gateway.server);
    rmSync(testRoot, { recursive: true, force: true });
  }
});
