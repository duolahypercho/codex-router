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
const INTERNAL_KEY = "test-claude-internal-service-key-with-sufficient-length";
const CALLER_KEY = "test-claude-caller-capability-with-sufficient-length";

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
  const address = server.address();
  assert.ok(typeof address === "object" && address);
  const port = address.port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function mockServer(handler) {
  const server = http.createServer(handler);
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(typeof address === "object" && address);
  return { server, port: address.port };
}

function runRouter(port, gatewayPort, stateDir) {
  const child = spawn(process.execPath, [path.join(root, "src", "claude-router.mjs")], {
    cwd: root,
    env: {
      ...process.env,
      MODEL_ROUTER_TARGET: "claude",
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

test("Claude router authenticates discovery and maps Messages requests without leaking caller auth", async () => {
  const requests = [];
  const healthAuth = [];
  const gateway = await mockServer(async (request, response) => {
    if (request.method === "GET" && request.url === "/health") {
      healthAuth.push(request.headers.authorization);
      json(response, 200, { ok: true });
      return;
    }
    requests.push({
      url: request.url,
      headers: request.headers,
      body: await bodyJson(request),
    });
    if (requests.at(-1).body.stream) {
      response.writeHead(200, { "Content-Type": "text/event-stream" });
      response.end(
        [
          'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_test","type":"message","role":"assistant","model":"gateway-model","content":[],"usage":{"input_tokens":1,"output_tokens":0}}}',
          'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
          'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"ok"}}',
          'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}',
          'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":1}}',
          'event: message_stop\ndata: {"type":"message_stop"}',
          "",
        ].join("\n\n"),
      );
      return;
    }
    json(response, 200, {
      id: "msg_test",
      type: "message",
      role: "assistant",
      content: [{ type: "text", text: "ok" }],
      model: requests.at(-1).body.model,
      stop_reason: "end_turn",
      usage: { input_tokens: 1, output_tokens: 1 },
    });
  });
  const routerPort = await openPort();
  const testRoot = mkdtempSync(path.join(os.tmpdir(), "claude-router-routing-"));
  const stateDir = path.join(testRoot, "state");
  writeSelection(stateDir, ["kimi-oauth", "kimi-api", "deepseek"]);
  const router = runRouter(routerPort, gateway.port, stateDir);

  try {
    await waitFor(`http://127.0.0.1:${routerPort}/health`, router);

    const publicHealth = await fetch(`http://127.0.0.1:${routerPort}/health`);
    assert.equal(publicHealth.status, 200);
    assert.deepEqual(Object.keys(await publicHealth.json()).sort(), ["ok", "service", "version"]);

    const unauthenticatedModels = await fetch(`http://127.0.0.1:${routerPort}/v1/models`);
    assert.equal(unauthenticatedModels.status, 401);
    const wrongKey = await fetch(`http://127.0.0.1:${routerPort}/v1/models`, {
      headers: { Authorization: "Bearer wrong-caller-key-with-sufficient-length" },
    });
    assert.equal(wrongKey.status, 401);

    const modelsResponse = await fetch(`http://127.0.0.1:${routerPort}/v1/models`, {
      headers: { Authorization: `Bearer ${CALLER_KEY}` },
    });
    assert.equal(modelsResponse.status, 200);
    const models = await modelsResponse.json();
    assert.deepEqual(
      models.data.map((model) => model.id),
      [
        "kimi-oauth/k3",
        "kimi-api/kimi-k3",
        "deepseek/deepseek-v4-flash",
        "deepseek/deepseek-v4-pro",
      ],
    );
    assert.equal(models.data[0].display_name, "Kimi K3 (OAuth)");

    const payload = {
      model: "kimi-api/kimi-k3",
      max_tokens: 64,
      stream: false,
      system: "Use tools when needed.",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "inspect" },
            {
              type: "image",
              source: { type: "base64", media_type: "image/png", data: "aGVsbG8=" },
            },
          ],
        },
      ],
      tools: [
        {
          name: "inspect_file",
          description: "Inspect a file",
          input_schema: { type: "object", properties: { path: { type: "string" } } },
        },
      ],
    };
    const response = await fetch(`http://127.0.0.1:${routerPort}/v1/messages`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${CALLER_KEY}`,
        "X-Api-Key": CALLER_KEY,
        "anthropic-version": "2023-06-01",
        "Content-Type": "application/json",
        "X-Private-Header": "must-not-forward",
      },
      body: JSON.stringify(payload),
    });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).type, "message");
    assert.equal(requests.length, 1);
    assert.equal(requests[0].url, "/v1/messages");
    assert.equal(requests[0].body.model, "kimi-api-k3");
    assert.equal(requests[0].body.stream, true);
    assert.deepEqual(requests[0].body.messages, payload.messages);
    assert.deepEqual(requests[0].body.tools, payload.tools);
    assert.equal(requests[0].headers.authorization, `Bearer ${INTERNAL_KEY}`);
    assert.equal(requests[0].headers["x-api-key"], undefined);
    assert.equal(requests[0].headers["x-private-header"], undefined);
    assert.equal(requests[0].headers["anthropic-version"], "2023-06-01");

    const streamed = await fetch(`http://127.0.0.1:${routerPort}/v1/messages`, {
      method: "POST",
      headers: {
        "X-Api-Key": CALLER_KEY,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "deepseek/deepseek-v4-pro",
        max_tokens: 8,
        stream: true,
        messages: [{ role: "user", content: "hi" }],
      }),
    });
    assert.equal(streamed.status, 200);
    const streamedBody = await streamed.text();
    assert.match(streamedBody, /event: message_start/);
    assert.match(streamedBody, /deepseek\/deepseek-v4-pro/);
    assert.doesNotMatch(streamedBody, /"model":"deepseek-v4-pro"/);

    const browser = await fetch(`http://127.0.0.1:${routerPort}/v1/messages`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${CALLER_KEY}`,
        Origin: "https://attacker.invalid",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });
    assert.equal(browser.status, 403);
    assert.equal(requests.length, 2);
    assert.ok(healthAuth.every((value) => value === `Bearer ${INTERNAL_KEY}`));
  } finally {
    await stopChild(router);
    await closeServer(gateway.server);
    rmSync(testRoot, { recursive: true, force: true });
  }
});

test("Claude router rejects hidden and unknown models before reaching the gateway", async () => {
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
  const testRoot = mkdtempSync(path.join(os.tmpdir(), "claude-router-hidden-"));
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
      ["deepseek/deepseek-v4-pro", 409, "provider_not_enabled"],
      ["unknown/model", 400, "invalid_request_error"],
    ]) {
      const response = await fetch(`http://127.0.0.1:${routerPort}/v1/messages`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          model,
          max_tokens: 8,
          messages: [{ role: "user", content: "hi" }],
        }),
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
