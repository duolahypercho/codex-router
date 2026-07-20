import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { zstdCompressSync } from "node:zlib";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const INTERNAL_KEY = "test-internal-service-key-with-sufficient-length";

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

function run(script, env) {
  const child = spawn(process.execPath, [path.join(root, "src", script)], {
    cwd: root,
    env: {
      ...process.env,
      CODEX_ROUTER_INTERNAL_KEY: INTERNAL_KEY,
      KIMI_INTERNAL_KEY: INTERNAL_KEY,
      ...env,
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
      if (response.ok) return;
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

test("router preserves native auth and isolates every external route", async () => {
  const nativeRequests = [];
  const routedRequests = [];
  const native = await mockServer(async (request, response) => {
    nativeRequests.push({ url: request.url, headers: request.headers, body: await bodyJson(request) });
    json(response, 200, { route: "native" });
  });
  const gateway = await mockServer(async (request, response) => {
    const body = await bodyJson(request);
    routedRequests.push({ url: request.url, headers: request.headers, body });
    if (body.stream === false && Array.isArray(body.input)) {
      json(response, 200, {
        id: "resp-summary",
        object: "response",
        output: [
          {
            type: "message",
            content: [{ type: "output_text", text: "compact summary" }],
          },
        ],
      });
    } else {
      json(response, 200, { route: "external" });
    }
  });
  const routerPort = await openPort();
  const router = run("router.mjs", {
    CODEX_ROUTER_PORT: String(routerPort),
    CODEX_NATIVE_BASE_URL: `http://127.0.0.1:${native.port}/backend-api/codex`,
    CODEX_ROUTER_GATEWAY_BASE_URL: `http://127.0.0.1:${gateway.port}/v1`,
    CODEX_ROUTER_QUIET: "1",
  });

  try {
    await waitFor(`http://127.0.0.1:${routerPort}/v1/models`, router);
    const callerHeaders = {
      Authorization: "Bearer CODEX_CALLER_SECRET",
      "ChatGPT-Account-Id": "account-secret",
      "X-Codex-Installation-Id": "installation-secret",
      "X-Private-Header": "must-not-forward",
      "Content-Type": "application/json",
    };
    const nativePayload = zstdCompressSync(
      Buffer.from(
        JSON.stringify({
          model: "gpt-5.6-sol",
          input: "native test",
          previous_response_id: "remove-me",
        }),
      ),
    );
    const nativeResponse = await fetch(`http://127.0.0.1:${routerPort}/v1/responses`, {
      method: "POST",
      headers: { ...callerHeaders, "Content-Encoding": "zstd" },
      body: nativePayload,
    });
    assert.equal(nativeResponse.status, 200);

    for (const [model, gatewayModel] of [
      ["kimi-oauth/k3", "kimi-oauth-k3"],
      ["kimi-api/kimi-k3", "kimi-api-k3"],
      ["deepseek/deepseek-v4-flash", "deepseek-v4-flash"],
      ["deepseek/deepseek-v4-pro", "deepseek-v4-pro"],
    ]) {
      const response = await fetch(`http://127.0.0.1:${routerPort}/v1/responses`, {
        method: "POST",
        headers: callerHeaders,
        body: JSON.stringify({ model, input: "external test" }),
      });
      assert.equal(response.status, 200);
      assert.equal(routedRequests.at(-1).body.model, gatewayModel);
    }

    assert.equal(nativeRequests[0].headers.authorization, "Bearer CODEX_CALLER_SECRET");
    assert.equal(nativeRequests[0].headers["chatgpt-account-id"], "account-secret");
    assert.equal(nativeRequests[0].headers["x-private-header"], undefined);
    assert.equal(nativeRequests[0].body.previous_response_id, undefined);
    for (const request of routedRequests) {
      assert.equal(request.headers.authorization, `Bearer ${INTERNAL_KEY}`);
      assert.equal(request.headers["chatgpt-account-id"], undefined);
      assert.equal(request.headers["x-codex-installation-id"], undefined);
      assert.equal(request.headers["x-private-header"], undefined);
    }
  } finally {
    await stopChild(router);
    await Promise.all([closeServer(native.server), closeServer(gateway.server)]);
  }
});

test("router synthesizes v1 and v2 compaction for registry models", async () => {
  const gatewayRequests = [];
  const gateway = await mockServer(async (request, response) => {
    gatewayRequests.push({ headers: request.headers, body: await bodyJson(request) });
    json(response, 200, {
      id: "resp-summary",
      object: "response",
      output: [
        {
          type: "message",
          content: [{ type: "output_text", text: "compact summary" }],
        },
      ],
    });
  });
  const routerPort = await openPort();
  const router = run("router.mjs", {
    CODEX_ROUTER_PORT: String(routerPort),
    CODEX_ROUTER_GATEWAY_BASE_URL: `http://127.0.0.1:${gateway.port}/v1`,
    CODEX_ROUTER_QUIET: "1",
  });
  const headers = {
    Authorization: "Bearer CODEX_CALLER_SECRET",
    "Content-Type": "application/json",
  };

  try {
    await waitFor(`http://127.0.0.1:${routerPort}/v1/models`, router);
    const input = [
      { type: "message", role: "user", content: [{ type: "input_text", text: "keep me" }] },
    ];
    const v1 = await fetch(`http://127.0.0.1:${routerPort}/v1/responses/compact`, {
      method: "POST",
      headers,
      body: JSON.stringify({ model: "deepseek/deepseek-v4-pro", input }),
    });
    assert.equal(v1.status, 200);
    const v1Body = await v1.json();
    assert.equal(v1Body.output.at(-1).role, "user");
    assert.match(v1Body.output.at(-1).content[0].text, /compact summary/);

    const v2 = await fetch(`http://127.0.0.1:${routerPort}/v1/responses`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: "deepseek/deepseek-v4-pro",
        stream: false,
        input: [...input, { type: "compaction_trigger" }],
      }),
    });
    assert.equal(v2.status, 200);
    const v2Body = await v2.json();
    assert.equal(v2Body.output[0].type, "compaction");
    assert.match(v2Body.output[0].encrypted_content, /^kcr1:/);

    const replay = await fetch(`http://127.0.0.1:${routerPort}/v1/responses`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: "deepseek/deepseek-v4-pro",
        input: [v2Body.output[0], ...input],
      }),
    });
    assert.equal(replay.status, 200);
    assert.equal(gatewayRequests.at(-1).body.input[0].type, "message");
    assert.match(gatewayRequests.at(-1).body.input[0].content[0].text, /compact summary/);
  } finally {
    await stopChild(router);
    await closeServer(gateway.server);
  }
});

test("API forwarder replaces caller auth and enforces Kimi K3 API parameters", async () => {
  const upstreamRequests = [];
  const upstream = await mockServer(async (request, response) => {
    upstreamRequests.push({ headers: request.headers, body: await bodyJson(request) });
    json(response, 200, { choices: [] });
  });
  const forwarderPort = await openPort();
  const forwarder = run("api-forwarder.mjs", {
    KIMI_API_FORWARD_PORT: String(forwarderPort),
    KIMI_API_BASE_URL: `http://127.0.0.1:${upstream.port}/v1`,
    KIMI_API_KEY: "TEST_KIMI_API_KEY",
    KIMI_PROXY_QUIET: "1",
  });

  try {
    await waitFor(`http://127.0.0.1:${forwarderPort}/health`, forwarder);
    const unauthorized = await fetch(
      `http://127.0.0.1:${forwarderPort}/v1/chat/completions`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      },
    );
    assert.equal(unauthorized.status, 401);

    const response = await fetch(
      `http://127.0.0.1:${forwarderPort}/v1/chat/completions`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${INTERNAL_KEY}`,
          "ChatGPT-Account-Id": "must-not-forward",
          "X-Codex-Installation-Id": "must-not-forward",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "kimi-api-k3",
          reasoning_effort: "low",
          messages: [{ role: "user", content: "test" }],
        }),
      },
    );
    assert.equal(response.status, 200);
    const request = upstreamRequests[0];
    assert.equal(request.headers.authorization, "Bearer TEST_KIMI_API_KEY");
    assert.equal(request.headers["chatgpt-account-id"], undefined);
    assert.equal(request.headers["x-codex-installation-id"], undefined);
    assert.equal(request.body.model, "kimi-k3");
    assert.equal(request.body.reasoning_effort, "max");
  } finally {
    await stopChild(forwarder);
    await closeServer(upstream.server);
  }
});

test("API forwarder supports all DeepSeek V4 models and normalizes thinking", async () => {
  const upstreamRequests = [];
  const upstream = await mockServer(async (request, response) => {
    upstreamRequests.push({ headers: request.headers, body: await bodyJson(request) });
    json(response, 200, { choices: [] });
  });
  const forwarderPort = await openPort();
  const forwarder = run("api-forwarder.mjs", {
    CODEX_ROUTER_API_PORT: String(forwarderPort),
    DEEPSEEK_API_BASE_URL: `http://127.0.0.1:${upstream.port}`,
    DEEPSEEK_API_KEY: "TEST_DEEPSEEK_API_KEY",
    CODEX_ROUTER_QUIET: "1",
  });

  try {
    await waitFor(`http://127.0.0.1:${forwarderPort}/health`, forwarder);
    for (const [gatewayModel, upstreamModel, effort] of [
      ["deepseek-v4-flash", "deepseek-v4-flash", "high"],
      ["deepseek-v4-pro", "deepseek-v4-pro", "max"],
    ]) {
      const response = await fetch(
        `http://127.0.0.1:${forwarderPort}/v1/chat/completions`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${INTERNAL_KEY}`,
            "ChatGPT-Account-Id": "must-not-forward",
            "X-Codex-Installation-Id": "must-not-forward",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model: gatewayModel,
            reasoning_effort: effort === "max" ? "xhigh" : "low",
            temperature: 0.7,
            messages: [{ role: "user", content: "test" }],
          }),
        },
      );
      assert.equal(response.status, 200);
      const request = upstreamRequests.at(-1);
      assert.equal(request.headers.authorization, "Bearer TEST_DEEPSEEK_API_KEY");
      assert.equal(request.headers["chatgpt-account-id"], undefined);
      assert.equal(request.headers["x-codex-installation-id"], undefined);
      assert.equal(request.body.model, upstreamModel);
      assert.deepEqual(request.body.thinking, { type: "enabled" });
      assert.equal(request.body.reasoning_effort, effort);
      assert.equal(request.body.temperature, undefined);
    }
  } finally {
    await stopChild(forwarder);
    await closeServer(upstream.server);
  }
});
