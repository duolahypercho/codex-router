import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import http from "node:http";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { zstdCompressSync, zstdDecompressSync } from "node:zlib";

import { callerBaseUrl } from "../src/caller-auth.mjs";
import { openPort } from "./port-pool.mjs";

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
  const raw = Buffer.concat(chunks);
  // The router compresses large bodies on the way to the native backend, the
  // way Codex itself does on the way in, so a mock backend has to decode one.
  const body = request.headers["content-encoding"] === "zstd" ? zstdDecompressSync(raw) : raw;
  return JSON.parse(body.toString("utf8"));
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
  // Isolate from the user's real router state (e.g. native-aliases.json)
  // unless the test provides its own state directory.
  const stateIsolation =
    env?.MODEL_ROUTER_STATE_DIR || env?.CODEX_ROUTER_STATE_DIR
      ? {}
      : { MODEL_ROUTER_STATE_DIR: mkdtempSync(path.join(os.tmpdir(), "routing-state-")) };
  const child = spawn(process.execPath, [path.join(root, "src", script)], {
    cwd: root,
    env: {
      ...process.env,
      ...stateIsolation,
      CODEX_ROUTER_CALLER_KEY: CALLER_KEY,
      CODEX_ROUTER_INTERNAL_KEY: INTERNAL_KEY,
      KIMI_INTERNAL_KEY: INTERNAL_KEY,
      CODEX_ROUTER_SHOW_ALL_MODELS: "1",
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

async function waitFor(url, child, headers = {}) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`Child exited early (${child.exitCode}): ${child.testErrors()}`);
    }
    try {
      const response = await fetch(url, { headers });
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

test("router health waits for enabled dependencies and ignores disabled forwarders", async () => {
  const testRoot = mkdtempSync(path.join(os.tmpdir(), "router-health-selection-"));
  writeFileSync(
    path.join(testRoot, "enabled-providers.json"),
    `${JSON.stringify({ version: 1, providers: ["kimi-oauth"] })}\n`,
    { mode: 0o600 },
  );
  const healthy = await mockServer(async (request, response) => {
    if (request.url === "/oauth-health") {
      await new Promise((resolve) => setTimeout(resolve, 1_200));
    }
    json(response, 200, { ok: true });
  });
  const unavailableApiPort = await openPort();
  const routerPort = await openPort();
  const router = run("router.mjs", {
    CODEX_ROUTER_PORT: String(routerPort),
    CODEX_ROUTER_STATE_DIR: testRoot,
    CODEX_ROUTER_SHOW_ALL_MODELS: "0",
    CODEX_ROUTER_OAUTH_HEALTH_URL: `http://127.0.0.1:${healthy.port}/oauth-health`,
    CODEX_ROUTER_API_HEALTH_URL: `http://127.0.0.1:${unavailableApiPort}/health`,
    CODEX_ROUTER_GATEWAY_HEALTH_URL: `http://127.0.0.1:${healthy.port}/gateway-health`,
    CODEX_ROUTER_QUIET: "1",
  });

  try {
    await waitFor(`http://127.0.0.1:${routerPort}/health`, router);
    const response = await fetch(`http://127.0.0.1:${routerPort}/health`);
    assert.equal(response.status, 200);
  } finally {
    await stopChild(router);
    await closeServer(healthy.server);
    rmSync(testRoot, { recursive: true, force: true });
  }
});

test("router requires the configured path capability before any model route", async () => {
  const sessionDirectory = mkdtempSync(path.join(os.tmpdir(), "model-router-session-"));
  const sessionIndex = path.join(sessionDirectory, "session_index.jsonl");
  const firstThread = "019f8821-881a-7582-9e60-633bff68789f";
  const secondThread = "019f8832-71e2-7670-87d9-9ff140e78585";
  writeFileSync(sessionIndex, [
    JSON.stringify({ id: firstThread, thread_name: "Checkout release" }),
    JSON.stringify({ id: secondThread, thread_name: "Audit telemetry" }),
  ].join("\n"));
  const gatewayRequests = [];
  const healthAuth = [];
  const gateway = await mockServer(async (request, response) => {
    if (request.method === "GET" && request.url === "/health") {
      healthAuth.push(request.headers.authorization);
      json(response, 200, {
        ok: true,
        credential_present: true,
        credential_source: "protected-test-state",
      });
      return;
    }
    const body = await bodyJson(request);
    gatewayRequests.push({ headers: request.headers, body });
    if (body.input === "hold") {
      await new Promise((resolve) => setTimeout(resolve, 120));
    }
    json(response, 200, { route: "external" });
  });
  const routerPort = await openPort();
  const router = run("router.mjs", {
    CODEX_ROUTER_PORT: String(routerPort),
    CODEX_ROUTER_GATEWAY_BASE_URL: `http://127.0.0.1:${gateway.port}/v1`,
    CODEX_ROUTER_OAUTH_HEALTH_URL: `http://127.0.0.1:${gateway.port}/health`,
    CODEX_ROUTER_API_HEALTH_URL: `http://127.0.0.1:${gateway.port}/health`,
    CODEX_ROUTER_GATEWAY_HEALTH_URL: `http://127.0.0.1:${gateway.port}/health`,
    CODEX_ROUTER_SESSION_INDEX: sessionIndex,
    CODEX_ROUTER_QUIET: "1",
  });

  try {
    await waitFor(`${routerBase(routerPort)}/models`, router);

    const oldRoute = await fetch(`http://127.0.0.1:${routerPort}/v1/responses`, {
      method: "POST",
      headers: {
        Authorization: "Bearer any-local-value",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ model: "deepseek/deepseek-v4-pro", input: "blocked" }),
    });
    assert.equal(oldRoute.status, 401);

    const wrongCapability = await fetch(
      `http://127.0.0.1:${routerPort}/_codex-router/wrong-caller-capability-with-sufficient-length/v1/models`,
    );
    assert.equal(wrongCapability.status, 401);

    const unauthenticatedPreflight = await fetch(
      `http://127.0.0.1:${routerPort}/v1/responses`,
      { method: "OPTIONS" },
    );
    assert.equal(unauthenticatedPreflight.status, 401);
    assert.equal(gatewayRequests.length, 0);

    const simpleBrowserTransport = await fetch(`${routerBase(routerPort)}/responses`, {
      method: "POST",
      headers: {
        Authorization: "Bearer codex-caller-auth",
        "Content-Type": "text/plain",
      },
      body: JSON.stringify({ model: "deepseek/deepseek-v4-pro", input: "blocked" }),
    });
    assert.equal(simpleBrowserTransport.status, 415);

    const browserOrigin = await fetch(`${routerBase(routerPort)}/responses`, {
      method: "POST",
      headers: {
        Authorization: "Bearer codex-caller-auth",
        "Content-Type": "application/json",
        Origin: "https://attacker.invalid",
      },
      body: JSON.stringify({ model: "deepseek/deepseek-v4-pro", input: "blocked" }),
    });
    assert.equal(browserOrigin.status, 403);
    assert.equal(gatewayRequests.length, 0);

    const authorized = await fetch(`${routerBase(routerPort)}/responses`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Thread-Id": firstThread },
      body: JSON.stringify({ model: "deepseek/deepseek-v4-pro", input: "allowed" }),
    });
    assert.equal(authorized.status, 200);
    assert.equal(gatewayRequests.length, 1);
    assert.equal(gatewayRequests[0].headers.authorization, `Bearer ${INTERNAL_KEY}`);

    const heldRequest = fetch(`${routerBase(routerPort)}/responses`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Thread-Id": firstThread },
      body: JSON.stringify({ model: "deepseek/deepseek-v4-pro", input: "hold" }),
    });
    const secondHeldRequest = fetch(`${routerBase(routerPort)}/responses`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Thread-Id": secondThread },
      body: JSON.stringify({ model: "deepseek/deepseek-v4-flash", input: "hold" }),
    });
    let generatingActivity;
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const generatingHealth = await fetch(`http://127.0.0.1:${routerPort}/health`);
      generatingActivity = (await generatingHealth.json()).activity;
      if (
        generatingActivity.state === "generating" &&
        generatingActivity.activeCount === 2 &&
        generatingActivity.active?.length === 2
      ) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.equal(generatingActivity.state, "generating");
    assert.equal(generatingActivity.provider, "deepseek");
    assert.equal(generatingActivity.activeCount, 2);
    assert.equal(generatingActivity.active.length, 2);
    assert.deepEqual(
      new Set(generatingActivity.active.map((entry) => entry.model)),
      new Set(["deepseek/deepseek-v4-pro", "deepseek/deepseek-v4-flash"]),
    );
    assert.deepEqual(
      new Set(generatingActivity.active.map((entry) => entry.sessionName)),
      new Set(["Checkout release", "Audit telemetry"]),
    );
    assert.ok(
      ["deepseek/deepseek-v4-pro", "deepseek/deepseek-v4-flash"].includes(
        generatingActivity.model,
      ),
    );
    for (const entry of generatingActivity.active) {
      assert.equal(entry.provider, "deepseek");
      assert.equal(typeof entry.id, "string");
      assert.equal(typeof entry.startedAt, "number");
    }
    assert.equal((await heldRequest).status, 200);
    assert.equal((await secondHeldRequest).status, 200);

    const errorSentinel = "SENSITIVE_ERROR_DETAIL_MUST_NOT_ESCAPE";
    const invalidEncoding = await fetch(`${routerBase(routerPort)}/responses`, {
      method: "POST",
      headers: {
        "Content-Encoding": errorSentinel,
        "Content-Type": "application/json",
      },
      body: "{}",
    });
    assert.equal(invalidEncoding.status, 415);
    assert.doesNotMatch(await invalidEncoding.text(), new RegExp(errorSentinel));
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.doesNotMatch(router.testErrors(), new RegExp(errorSentinel));

    const publicHealth = await fetch(`http://127.0.0.1:${routerPort}/health`);
    assert.equal(publicHealth.status, 200);
    const publicPayload = await publicHealth.json();
    assert.deepEqual(Object.keys(publicPayload).sort(), ["activity", "ok", "service", "version"]);
    assert.equal(publicPayload.activity.state, "error");

    const protectedHealth = await fetch(`${routerBase(routerPort)}/health`);
    assert.equal(protectedHealth.status, 200);
    const protectedPayload = await protectedHealth.json();
    assert.equal(protectedPayload.oauth.credential_present, true);
    assert.ok(healthAuth.every((value) => value === `Bearer ${INTERNAL_KEY}`));
  } finally {
    await stopChild(router);
    await closeServer(gateway.server);
  }
});

test("a canceled request does not flip activity into the error state", async () => {
  const gateway = await mockServer(async (request, response) => {
    if (request.method === "GET" && request.url === "/health") {
      json(response, 200, { ok: true, credential_present: true });
      return;
    }
    const body = await bodyJson(request);
    if (body.input === "hang") {
      // Hold the request open until the router aborts it, then finish so the
      // mock server can close cleanly.
      await new Promise((resolve) => {
        request.once("close", resolve);
        response.once("close", resolve);
      });
      return;
    }
    json(response, 200, { route: "external" });
  });
  const routerPort = await openPort();
  const router = run("router.mjs", {
    CODEX_ROUTER_PORT: String(routerPort),
    CODEX_ROUTER_GATEWAY_BASE_URL: `http://127.0.0.1:${gateway.port}/v1`,
    CODEX_ROUTER_OAUTH_HEALTH_URL: `http://127.0.0.1:${gateway.port}/health`,
    CODEX_ROUTER_API_HEALTH_URL: `http://127.0.0.1:${gateway.port}/health`,
    CODEX_ROUTER_GATEWAY_HEALTH_URL: `http://127.0.0.1:${gateway.port}/health`,
    CODEX_ROUTER_QUIET: "1",
  });

  try {
    await waitFor(`${routerBase(routerPort)}/models`, router);
    const canceler = new AbortController();
    const held = fetch(`${routerBase(routerPort)}/responses`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "deepseek/deepseek-v4-pro", input: "hang" }),
      signal: canceler.signal,
    }).catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 150));
    canceler.abort();
    await held;
    await new Promise((resolve) => setTimeout(resolve, 150));

    const health = await fetch(`http://127.0.0.1:${routerPort}/health`);
    const payload = await health.json();
    assert.equal(payload.activity.state, "idle");
    assert.equal(payload.activity.activeCount, 0);
  } finally {
    await stopChild(router);
    await closeServer(gateway.server);
  }
});

test("router refuses a known model whose provider is hidden", async () => {
  const gatewayRequests = [];
  const gateway = await mockServer(async (request, response) => {
    gatewayRequests.push(await bodyJson(request));
    json(response, 200, { route: "external" });
  });
  const routerPort = await openPort();
  const testRoot = mkdtempSync(path.join(os.tmpdir(), "codex-router-hidden-provider-"));
  const stateDir = path.join(testRoot, "state");
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(
    path.join(stateDir, "enabled-providers.json"),
    `${JSON.stringify({ version: 1, providers: ["kimi-oauth"] })}\n`,
  );
  const router = run("router.mjs", {
    CODEX_ROUTER_PORT: String(routerPort),
    CODEX_ROUTER_GATEWAY_BASE_URL: `http://127.0.0.1:${gateway.port}/v1`,
    CODEX_ROUTER_STATE_DIR: stateDir,
    CODEX_ROUTER_SHOW_ALL_MODELS: "0",
    CODEX_ROUTER_QUIET: "1",
  });

  try {
    await waitFor(`${routerBase(routerPort)}/models`, router);
    const response = await fetch(`${routerBase(routerPort)}/responses`, {
      method: "POST",
      headers: {
        Authorization: "Bearer CODEX_CALLER_SECRET",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ model: "deepseek/deepseek-v4-pro", input: "test" }),
    });
    assert.equal(response.status, 409);
    assert.equal((await response.json()).error.type, "provider_not_enabled");
    assert.equal(gatewayRequests.length, 0);
  } finally {
    await stopChild(router);
    await closeServer(gateway.server);
    rmSync(testRoot, { recursive: true, force: true });
  }
});

test("router rewrites gateway errors to name the failing provider", async () => {
  const gateway = await mockServer(async (request, response) => {
    await bodyJson(request);
    json(response, 503, {
      error: {
        message:
          "litellm.ServiceUnavailableError: ServiceUnavailableError: OpenAIException - Upstream request failed: Endpoint is unavailable.. Received Model Group=opencode-go-grok-4-5\nAvailable Model Group Fallbacks=None",
        type: null,
        param: null,
        code: "503",
      },
    });
  });
  const routerPort = await openPort();
  const router = run("router.mjs", {
    CODEX_ROUTER_PORT: String(routerPort),
    CODEX_ROUTER_GATEWAY_BASE_URL: `http://127.0.0.1:${gateway.port}/v1`,
    CODEX_ROUTER_QUIET: "1",
  });

  try {
    await waitFor(`${routerBase(routerPort)}/models`, router);
    const response = await fetch(`${routerBase(routerPort)}/responses`, {
      method: "POST",
      headers: {
        Authorization: "Bearer CODEX_CALLER_SECRET",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ model: "opencode-go/grok-4.5", input: "test" }),
    });
    assert.equal(response.status, 503);
    const payload = await response.json();
    assert.equal(
      payload.error.message,
      "Something is wrong at opencode: Grok 4.5 (opencode Go) is unavailable right now. Retry in a few minutes or switch models. (HTTP 503: Upstream request failed: Endpoint is unavailable.)",
    );
    assert.equal(payload.error.type, "server_error");
    assert.ok(!payload.error.message.includes("litellm"));
  } finally {
    await stopChild(router);
    await closeServer(gateway.server);
  }
});

test("router dispatches aliased native slugs to the mapped external model", async () => {
  const gatewayRequests = [];
  const gateway = await mockServer(async (request, response) => {
    gatewayRequests.push(await bodyJson(request));
    json(response, 200, { route: "external" });
  });
  const routerPort = await openPort();
  const testRoot = mkdtempSync(path.join(os.tmpdir(), "codex-router-alias-route-"));
  const stateDir = path.join(testRoot, "state");
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(
    path.join(stateDir, "native-aliases.json"),
    `${JSON.stringify({ version: 1, aliases: { "gpt-5.5": "kimi-oauth/k3" } })}\n`,
  );
  const router = run("router.mjs", {
    CODEX_ROUTER_PORT: String(routerPort),
    CODEX_ROUTER_GATEWAY_BASE_URL: `http://127.0.0.1:${gateway.port}/v1`,
    CODEX_ROUTER_STATE_DIR: stateDir,
    CODEX_ROUTER_QUIET: "1",
  });

  try {
    await waitFor(`${routerBase(routerPort)}/models`, router);
    const response = await fetch(`${routerBase(routerPort)}/responses`, {
      method: "POST",
      headers: {
        Authorization: "Bearer CODEX_CALLER_SECRET",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ model: "gpt-5.5", input: "alias test" }),
    });
    assert.equal(response.status, 200);
    assert.equal(gatewayRequests.at(-1).model, "kimi-oauth-k3");
  } finally {
    await stopChild(router);
    await closeServer(gateway.server);
    rmSync(testRoot, { recursive: true, force: true });
  }
});

test("native tool-result aging is opt-in and rewrites only consumed old results", async () => {
  const nativeRequests = [];
  const native = await mockServer(async (request, response) => {
    nativeRequests.push({ url: request.url, body: await bodyJson(request) });
    json(response, 200, { route: "native" });
  });

  // A conversation whose first tool result is large, already acted on, and
  // outside the four-newest frontier — exactly the shape aging compacts.
  const bigOutput = "x".repeat(40_000);
  const agableInput = [
    { type: "function_call", call_id: "call-old", name: "shell", arguments: "{}" },
    { type: "function_call_output", call_id: "call-old", output: bigOutput },
    {
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text: "acted on it" }],
    },
    ...[1, 2, 3, 4].map((n) => ({
      type: "function_call_output",
      call_id: `call-${n}`,
      output: `small result ${n}`,
    })),
  ];
  const send = async (routerPort) =>
    fetch(`${routerBase(routerPort)}/responses`, {
      method: "POST",
      headers: {
        Authorization: "Bearer CODEX_CALLER_SECRET",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ model: "gpt-5.6-sol", input: agableInput }),
    });

  // Default state: the native path forwards the blob untouched.
  const defaultPort = await openPort();
  const defaultRouter = run("router.mjs", {
    CODEX_ROUTER_PORT: String(defaultPort),
    CODEX_NATIVE_BASE_URL: `http://127.0.0.1:${native.port}/backend-api/codex`,
    CODEX_ROUTER_QUIET: "1",
  });
  try {
    await waitFor(`${routerBase(defaultPort)}/models`, defaultRouter);
    assert.equal((await send(defaultPort)).status, 200);
    assert.equal(nativeRequests.at(-1).body.input[1].output, bigOutput);
  } finally {
    await stopChild(defaultRouter);
  }

  // Opted in: the blob becomes a receipt, the newest results stay intact,
  // and the usage event records the savings.
  const stateDir = mkdtempSync(path.join(os.tmpdir(), "native-aging-state-"));
  writeFileSync(
    path.join(stateDir, "tool-result-aging.json"),
    `${JSON.stringify({ version: 1, enabled: true, nativeEnabled: true })}\n`,
    "utf8",
  );
  const agingPort = await openPort();
  const agingRouter = run("router.mjs", {
    CODEX_ROUTER_PORT: String(agingPort),
    CODEX_NATIVE_BASE_URL: `http://127.0.0.1:${native.port}/backend-api/codex`,
    CODEX_ROUTER_QUIET: "1",
    MODEL_ROUTER_STATE_DIR: stateDir,
  });
  try {
    await waitFor(`${routerBase(agingPort)}/models`, agingRouter);
    assert.equal((await send(agingPort)).status, 200);
    const forwarded = nativeRequests.at(-1).body.input;
    assert.match(forwarded[1].output, /^\[Older tool result compacted by Codex Router/);
    assert.match(forwarded[1].output, /sha256:[0-9a-f]{64}/);
    assert.equal(forwarded.at(-1).output, "small result 4");
    // The usage event is appended after the response is relayed; give the
    // router a moment to flush it rather than racing the write.
    const eventsPath = path.join(stateDir, "usage-events.jsonl");
    let aged;
    const deadline = Date.now() + 3_000;
    while (!aged && Date.now() < deadline) {
      if (existsSync(eventsPath)) {
        aged = readFileSync(eventsPath, "utf8")
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line))
          .find((event) => event.toolResultsAged);
      }
      if (!aged) await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.equal(aged?.toolResultsAged, 1);
    assert.ok(aged.toolResultBytesSaved > 30_000);
  } finally {
    await stopChild(agingRouter);
    rmSync(stateDir, { recursive: true, force: true });
    native.server.close();
  }
});

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
    await waitFor(`${routerBase(routerPort)}/models`, router);
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
          client_metadata: { workspace: "caller-owned" },
        }),
      ),
    );
    const nativeResponse = await fetch(
      `${routerBase(routerPort)}/responses?api_key=PROVIDER_QUERY_SECRET&source=provider`,
      {
      method: "POST",
      headers: { ...callerHeaders, "Content-Encoding": "zstd" },
      body: nativePayload,
      },
    );
    assert.equal(nativeResponse.status, 200);

    for (const [model, gatewayModel] of [
      ["kimi-oauth/k3", "kimi-oauth-k3"],
      ["kimi-api/kimi-k3", "kimi-api-k3"],
      ["deepseek/deepseek-v4-flash", "deepseek-v4-flash"],
      ["deepseek/deepseek-v4-pro", "deepseek-v4-pro"],
      ["grok-api/grok-4.5", "grok-api-grok-4-5"],
      ["anthropic-api/claude-opus-4.8", "anthropic-api-claude-opus-4-8"],
    ]) {
      const response = await fetch(`${routerBase(routerPort)}/responses`, {
        method: "POST",
        headers: callerHeaders,
        body: JSON.stringify({
          model,
          input: "external test",
          client_metadata: { workspace: "caller-owned" },
        }),
      });
      assert.equal(response.status, 200);
      assert.equal(routedRequests.at(-1).body.model, gatewayModel);
    }

    assert.equal(nativeRequests[0].headers.authorization, "Bearer CODEX_CALLER_SECRET");
    assert.equal(nativeRequests[0].headers["chatgpt-account-id"], "account-secret");
    assert.equal(nativeRequests[0].headers["x-private-header"], undefined);
    assert.equal(nativeRequests[0].url, "/backend-api/codex/responses");
    assert.doesNotMatch(nativeRequests[0].url, /PROVIDER_QUERY_SECRET/);
    assert.equal(nativeRequests[0].body.previous_response_id, undefined);
    // Native OpenAI traffic owns client_metadata; only routed traffic drops it.
    assert.deepEqual(nativeRequests[0].body.client_metadata, { workspace: "caller-owned" });
    for (const request of routedRequests) {
      assert.equal(request.headers.authorization, `Bearer ${INTERNAL_KEY}`);
      assert.equal(request.headers["chatgpt-account-id"], undefined);
      assert.equal(request.headers["x-codex-installation-id"], undefined);
      assert.equal(request.headers["x-private-header"], undefined);
      assert.equal(request.body.client_metadata, undefined);
    }
  } finally {
    await stopChild(router);
    await Promise.all([closeServer(native.server), closeServer(gateway.server)]);
  }
});

test("router permits a compressed context larger than the encoded request limit", async () => {
  let receivedInputLength = 0;
  const native = await mockServer(async (request, response) => {
    const payload = await bodyJson(request);
    receivedInputLength = payload.input.length;
    json(response, 200, { id: "large-context-ok", output: [] });
  });
  const routerPort = await openPort();
  const router = run("router.mjs", {
    CODEX_ROUTER_PORT: String(routerPort),
    CODEX_NATIVE_BASE_URL: `http://127.0.0.1:${native.port}`,
    CODEX_ROUTER_GATEWAY_BASE_URL: `http://127.0.0.1:${native.port}`,
    CODEX_ROUTER_QUIET: "1",
    MODEL_ROUTER_MAX_BODY_BYTES: String(64 * 1024),
    MODEL_ROUTER_MAX_DECODED_BODY_BYTES: String(4 * 1024 * 1024),
  });

  try {
    await waitFor(`${routerBase(routerPort)}/models`, router);
    const input = "x".repeat(1_500_000);
    const compressed = zstdCompressSync(
      Buffer.from(JSON.stringify({ model: "gpt-5.6-sol", input })),
    );
    assert.ok(compressed.length < 64 * 1024);

    const response = await fetch(`${routerBase(routerPort)}/responses`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${CALLER_KEY}`,
        "Content-Type": "application/json",
        "Content-Encoding": "zstd",
      },
      body: compressed,
    });

    assert.equal(response.status, 200, await response.text());
    assert.equal(receivedInputLength, input.length);
  } finally {
    await stopChild(router);
    await closeServer(native.server);
  }
});

test("router hands the native backend a compressed body instead of inflated JSON", async () => {
  const seen = [];
  const native = await mockServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const raw = Buffer.concat(chunks);
    const encoding = request.headers["content-encoding"];
    const decoded = encoding === "zstd" ? zstdDecompressSync(raw) : raw;
    seen.push({ encoding, wireBytes: raw.length, payload: JSON.parse(decoded.toString("utf8")) });
    json(response, 200, { id: "ok", output: [] });
  });
  const routerPort = await openPort();
  const router = run("router.mjs", {
    CODEX_ROUTER_PORT: String(routerPort),
    CODEX_NATIVE_BASE_URL: `http://127.0.0.1:${native.port}`,
    CODEX_ROUTER_GATEWAY_BASE_URL: `http://127.0.0.1:${native.port}`,
    CODEX_ROUTER_QUIET: "1",
  });

  try {
    await waitFor(`${routerBase(routerPort)}/models`, router);
    // A real turn: far past the threshold, and compressible the way a
    // conversation is rather than the way a run of one character is.
    const text = Array.from(
      { length: 4_000 },
      (_, index) => `line ${index}: the quick brown fox jumps over the lazy dog`,
    ).join("\n");
    const big = JSON.stringify({
      model: "gpt-5.6-sol",
      input: [{ type: "message", role: "user", content: [{ type: "input_text", text }] }],
    });

    const response = await fetch(`${routerBase(routerPort)}/responses`, {
      method: "POST",
      headers: { Authorization: `Bearer ${CALLER_KEY}`, "Content-Type": "application/json" },
      body: big,
    });
    assert.equal(response.status, 200, await response.text());

    const [call] = seen;
    assert.equal(call.encoding, "zstd");
    // The point of the exercise: fewer bytes on the wire than the router holds
    // in memory, and the backend still receives the exact turn.
    assert.ok(call.wireBytes < big.length / 2, `${call.wireBytes} vs ${big.length}`);
    assert.equal(call.payload.input[0].content[0].text, text);
  } finally {
    await stopChild(router);
    await closeServer(native.server);
  }
});

test("a small native turn is sent unencoded, exactly as it always was", async () => {
  const seen = [];
  const native = await mockServer(async (request, response) => {
    seen.push({ encoding: request.headers["content-encoding"], body: await bodyJson(request) });
    json(response, 200, { id: "ok", output: [] });
  });
  const routerPort = await openPort();
  const router = run("router.mjs", {
    CODEX_ROUTER_PORT: String(routerPort),
    CODEX_NATIVE_BASE_URL: `http://127.0.0.1:${native.port}`,
    CODEX_ROUTER_GATEWAY_BASE_URL: `http://127.0.0.1:${native.port}`,
    CODEX_ROUTER_QUIET: "1",
  });

  try {
    await waitFor(`${routerBase(routerPort)}/models`, router);
    const response = await fetch(`${routerBase(routerPort)}/responses`, {
      method: "POST",
      headers: { Authorization: `Bearer ${CALLER_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: "gpt-5.6-sol", input: "hello" }),
    });
    assert.equal(response.status, 200, await response.text());
    assert.equal(seen[0].encoding, undefined);
    assert.equal(seen[0].body.input, "hello");
  } finally {
    await stopChild(router);
    await closeServer(native.server);
  }
});

test("router relays encrypted Codex subagent payloads before external routing", async () => {
  const nativeRequests = [];
  const native = await mockServer(async (request, response) => {
    nativeRequests.push({ headers: request.headers, body: await bodyJson(request) });
    const relayArguments = JSON.stringify({ payload: "Inspect /tmp/capture.png harshly." });
    const relayEvents = [
      {
        type: "response.output_item.added",
        item: {
          type: "function_call",
          id: "fc_relay",
          name: "relay_external_agent_payload",
          arguments: "",
        },
      },
      {
        type: "response.function_call_arguments.delta",
        item_id: "fc_relay",
        delta: relayArguments.slice(0, 17),
      },
      {
        type: "response.function_call_arguments.delta",
        item_id: "fc_relay",
        delta: relayArguments.slice(17),
      },
      {
        type: "response.function_call_arguments.done",
        item_id: "fc_relay",
        arguments: relayArguments,
      },
    ];
    const event = `${relayEvents
      .map((entry) => `event: ${entry.type}\ndata: ${JSON.stringify(entry)}\n\n`)
      .join("")}data: [DONE]\n\n`;
    response.writeHead(200, { "Content-Type": "application/octet-stream" });
    response.write(event.slice(0, 37));
    response.write(event.slice(37, 103));
    response.end(event.slice(103));
  });
  const gatewayRequests = [];
  const gateway = await mockServer(async (request, response) => {
    gatewayRequests.push({ headers: request.headers, body: await bodyJson(request) });
    json(response, 200, { route: "external" });
  });
  const routerPort = await openPort();
  const router = run("router.mjs", {
    CODEX_ROUTER_PORT: String(routerPort),
    CODEX_NATIVE_BASE_URL: `http://127.0.0.1:${native.port}/backend-api/codex`,
    CODEX_ROUTER_GATEWAY_BASE_URL: `http://127.0.0.1:${gateway.port}/v1`,
    CODEX_ROUTER_QUIET: "1",
  });

  try {
    await waitFor(`${routerBase(routerPort)}/models`, router);
    const response = await fetch(`${routerBase(routerPort)}/responses`, {
      method: "POST",
      headers: {
        Authorization: "Bearer CHATGPT_SESSION_TOKEN",
        "ChatGPT-Account-Id": "account-id",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "kimi-oauth/k3",
        stream: false,
        input: [
          {
            type: "agent_message",
            author: "/root",
            recipient: "/root/critic",
            content: [
              {
                type: "input_text",
                text: "Message Type: NEW_TASK\nTask name: /root/critic\nSender: /root\nPayload:\n",
              },
              { type: "encrypted_content", encrypted_content: "gAAAAA-test-payload=" },
            ],
          },
        ],
      }),
    });

    assert.equal(response.status, 200, await response.text());
    assert.equal(nativeRequests.length, 1);
    assert.equal(nativeRequests[0].headers.authorization, "Bearer CHATGPT_SESSION_TOKEN");
    assert.equal(nativeRequests[0].headers["chatgpt-account-id"], "account-id");
    assert.equal(nativeRequests[0].body.model, "gpt-5.6-sol");
    assert.equal(nativeRequests[0].body.stream, true);
    assert.equal(nativeRequests[0].body.tool_choice.name, "relay_external_agent_payload");
    assert.equal(gatewayRequests.length, 1);
    const content = gatewayRequests[0].body.input[0].content;
    assert.equal(content.some((part) => part.type === "encrypted_content"), false);
    assert.equal(content.at(-1).text, "Inspect /tmp/capture.png harshly.");

    const cachedResponse = await fetch(`${routerBase(routerPort)}/responses`, {
      method: "POST",
      headers: {
        Authorization: "Bearer CHATGPT_SESSION_TOKEN",
        "ChatGPT-Account-Id": "account-id",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "kimi-oauth/k3",
        stream: false,
        input: [
          {
            type: "agent_message",
            content: [
              {
                type: "input_text",
                text: "Message Type: NEW_TASK\nTask name: /root/critic\nSender: /root\nPayload:\n",
              },
              { type: "encrypted_content", encrypted_content: "gAAAAA-test-payload=" },
            ],
          },
        ],
      }),
    });
    assert.equal(cachedResponse.status, 200, await cachedResponse.text());
    assert.equal(nativeRequests.length, 1);

    const plaintextResponse = await fetch(`${routerBase(routerPort)}/responses`, {
      method: "POST",
      headers: {
        Authorization: "Bearer CHATGPT_SESSION_TOKEN",
        "ChatGPT-Account-Id": "account-id",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "kimi-oauth/k3",
        stream: false,
        input: [
          {
            type: "agent_message",
            content: [
              {
                type: "input_text",
                text: "Message Type: NEW_TASK\nTask name: /root/critic\nSender: /root\nPayload:\n",
              },
              {
                type: "encrypted_content",
                encrypted_content: "External parent returned plaintext directly.",
              },
            ],
          },
        ],
      }),
    });
    assert.equal(plaintextResponse.status, 200, await plaintextResponse.text());
    assert.equal(nativeRequests.length, 1);
    const plaintextContent = gatewayRequests[2].body.input[0].content;
    assert.equal(plaintextContent.some((part) => part.type === "encrypted_content"), false);
    assert.equal(
      plaintextContent.at(-1).text,
      "External parent returned plaintext directly.",
    );
  } finally {
    await stopChild(router);
    await Promise.all([closeServer(native.server), closeServer(gateway.server)]);
  }
});

test("router fails closed when an encrypted subagent payload cannot be relayed", async () => {
  const native = await mockServer(async (_request, response) => {
    json(response, 401, { error: { message: "native sign-in required" } });
  });
  let gatewayRequests = 0;
  const gateway = await mockServer(async (_request, response) => {
    gatewayRequests += 1;
    json(response, 200, { route: "external" });
  });
  const routerPort = await openPort();
  const router = run("router.mjs", {
    CODEX_ROUTER_PORT: String(routerPort),
    CODEX_NATIVE_BASE_URL: `http://127.0.0.1:${native.port}/backend-api/codex`,
    CODEX_ROUTER_GATEWAY_BASE_URL: `http://127.0.0.1:${gateway.port}/v1`,
    CODEX_ROUTER_QUIET: "1",
  });

  try {
    await waitFor(`${routerBase(routerPort)}/models`, router);
    const response = await fetch(`${routerBase(routerPort)}/responses`, {
      method: "POST",
      headers: {
        Authorization: "Bearer expired-session",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "grok-oauth/grok-4.5",
        input: [
          {
            type: "agent_message",
            content: [
              { type: "input_text", text: "Message Type: MESSAGE\nPayload:\n" },
              { type: "encrypted_content", encrypted_content: "gAAAAA-unreadable=" },
            ],
          },
        ],
      }),
    });
    assert.equal(response.status, 502);
    assert.equal(gatewayRequests, 0);
  } finally {
    await stopChild(router);
    await Promise.all([closeServer(native.server), closeServer(gateway.server)]);
  }
});

test("router sends standalone image requests only to the native OpenAI backend", async () => {
  const nativeRequests = [];
  const native = await mockServer(async (request, response) => {
    nativeRequests.push({
      url: request.url,
      headers: request.headers,
      body: await bodyJson(request),
    });
    json(response, 200, { data: [{ b64_json: "test-image" }] });
  });
  const routerPort = await openPort();
  const router = run("router.mjs", {
    CODEX_ROUTER_PORT: String(routerPort),
    CODEX_NATIVE_BASE_URL: `http://127.0.0.1:${native.port}/backend-api/codex`,
    CODEX_ROUTER_QUIET: "1",
  });
  const headers = {
    Authorization: "Bearer CODEX_CALLER_SECRET",
    "ChatGPT-Account-Id": "account-secret",
    "X-Codex-Installation-Id": "installation-secret",
    "X-Private-Header": "must-not-forward",
    "Content-Type": "application/json",
  };

  try {
    await waitFor(`${routerBase(routerPort)}/models`, router);
    const generationBody = zstdCompressSync(
      Buffer.from(
        JSON.stringify({
          model: "gpt-image-2",
          prompt: "generate a game world",
          size: "auto",
        }),
      ),
    );
    const generation = await fetch(`${routerBase(routerPort)}/images/generations`, {
      method: "POST",
      headers: { ...headers, "Content-Encoding": "zstd" },
      body: generationBody,
    });
    assert.equal(generation.status, 200);

    const edit = await fetch(`${routerBase(routerPort)}/images/edits`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: "gpt-image-2",
        prompt: "add a game controller",
        images: [{ image_url: "data:image/png;base64,dGVzdA==" }],
      }),
    });
    assert.equal(edit.status, 200);

    assert.deepEqual(
      nativeRequests.map((request) => request.url),
      [
        "/backend-api/codex/images/generations",
        "/backend-api/codex/images/edits",
      ],
    );
    assert.equal(nativeRequests[0].headers.authorization, "Bearer CODEX_CALLER_SECRET");
    assert.equal(nativeRequests[0].headers["chatgpt-account-id"], "account-secret");
    assert.equal(nativeRequests[0].headers["x-codex-installation-id"], "installation-secret");
    assert.equal(nativeRequests[0].headers["x-private-header"], undefined);
    assert.equal(nativeRequests[0].headers["content-encoding"], undefined);
    assert.equal(nativeRequests[0].body.model, "gpt-image-2");
    assert.equal(nativeRequests[1].body.images[0].image_url, "data:image/png;base64,dGVzdA==");

    const unsupported = await fetch(`${routerBase(routerPort)}/audio/speech`, {
      method: "POST",
      headers,
      body: "{}",
    });
    assert.equal(unsupported.status, 404);
    assert.equal(nativeRequests.length, 2);
  } finally {
    await stopChild(router);
    await closeServer(native.server);
  }
});

test("router sends standalone web search only to the native OpenAI backend", async () => {
  const nativeRequests = [];
  const native = await mockServer(async (request, response) => {
    nativeRequests.push({
      url: request.url,
      headers: request.headers,
      body: await bodyJson(request),
    });
    json(response, 200, {
      output: "search result",
      results: [{ type: "text_result", ref_id: "turn0search0" }],
    });
  });
  const routerPort = await openPort();
  const router = run("router.mjs", {
    CODEX_ROUTER_PORT: String(routerPort),
    CODEX_NATIVE_BASE_URL: `http://127.0.0.1:${native.port}/backend-api/codex`,
    CODEX_ROUTER_QUIET: "1",
  });
  const headers = {
    Authorization: "Bearer CODEX_CALLER_SECRET",
    "ChatGPT-Account-Id": "account-secret",
    "X-Codex-Installation-Id": "installation-secret",
    "X-Codex-Turn-Metadata": "turn-metadata",
    "X-Private-Header": "must-not-forward",
    "Content-Type": "application/json",
  };

  try {
    await waitFor(`${routerBase(routerPort)}/models`, router);
    const searchBody = zstdCompressSync(
      Buffer.from(
        JSON.stringify({
          id: "search-session",
          model: "gpt-5.6-sol",
          commands: { search_query: [{ q: "OpenAI news" }] },
          settings: { external_web_access: true },
        }),
      ),
    );
    const search = await fetch(`${routerBase(routerPort)}/alpha/search?source=codex&api_key=PROVIDER_QUERY_SECRET`, {
      method: "POST",
      headers: { ...headers, "Content-Encoding": "zstd" },
      body: searchBody,
    });
    const searchPayload = await search.json();
    assert.equal(search.status, 200, JSON.stringify(searchPayload));
    assert.deepEqual(searchPayload, {
      output: "search result",
      results: [{ type: "text_result", ref_id: "turn0search0" }],
    });

    assert.equal(nativeRequests.length, 1);
    assert.equal(nativeRequests[0].url, "/backend-api/codex/alpha/search?source=codex");
    assert.doesNotMatch(nativeRequests[0].url, /PROVIDER_QUERY_SECRET/);
    assert.equal(nativeRequests[0].headers.authorization, "Bearer CODEX_CALLER_SECRET");
    assert.equal(nativeRequests[0].headers["chatgpt-account-id"], "account-secret");
    assert.equal(nativeRequests[0].headers["x-codex-installation-id"], "installation-secret");
    assert.equal(nativeRequests[0].headers["x-codex-turn-metadata"], "turn-metadata");
    assert.equal(nativeRequests[0].headers["x-private-header"], undefined);
    assert.equal(nativeRequests[0].headers["content-encoding"], undefined);
    assert.equal(nativeRequests[0].body.model, "gpt-5.6-sol");
    assert.deepEqual(nativeRequests[0].body.commands.search_query, [{ q: "OpenAI news" }]);

    const unsupported = await fetch(`${routerBase(routerPort)}/alpha/embeddings`, {
      method: "POST",
      headers,
      body: "{}",
    });
    assert.equal(unsupported.status, 404);
    assert.equal(nativeRequests.length, 1);
  } finally {
    await stopChild(router);
    await closeServer(native.server);
  }
});

test("router synthesizes routed compaction and safely replays it to native models", async () => {
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
  const nativeRequests = [];
  const native = await mockServer(async (request, response) => {
    nativeRequests.push({ headers: request.headers, body: await bodyJson(request) });
    json(response, 200, { route: "native" });
  });
  const routerPort = await openPort();
  const router = run("router.mjs", {
    CODEX_ROUTER_PORT: String(routerPort),
    CODEX_ROUTER_GATEWAY_BASE_URL: `http://127.0.0.1:${gateway.port}/v1`,
    CODEX_NATIVE_BASE_URL: `http://127.0.0.1:${native.port}/backend-api/codex`,
    CODEX_ROUTER_QUIET: "1",
  });
  const headers = {
    Authorization: "Bearer CODEX_CALLER_SECRET",
    "Content-Type": "application/json",
  };

  try {
    await waitFor(`${routerBase(routerPort)}/models`, router);
    const input = [
      { type: "message", role: "user", content: [{ type: "input_text", text: "keep me" }] },
    ];
    const v1 = await fetch(`${routerBase(routerPort)}/responses/compact`, {
      method: "POST",
      headers,
      body: JSON.stringify({ model: "deepseek/deepseek-v4-pro", input }),
    });
    assert.equal(v1.status, 200);
    const v1Body = await v1.json();
    assert.equal(v1Body.output.at(-1).role, "user");
    assert.match(v1Body.output.at(-1).content[0].text, /compact summary/);

    const v2 = await fetch(`${routerBase(routerPort)}/responses`, {
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

    const replay = await fetch(`${routerBase(routerPort)}/responses`, {
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

    const nativeCompaction = {
      type: "compaction",
      id: "cmp_native",
      encrypted_content: "genuine-openai-encrypted-content",
    };
    const nativeReplay = await fetch(`${routerBase(routerPort)}/responses`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: "gpt-5.6-sol",
        input: [v2Body.output[0], nativeCompaction, ...input],
      }),
    });
    assert.equal(nativeReplay.status, 200);
    assert.equal(nativeRequests[0].body.input[0].type, "message");
    assert.match(nativeRequests[0].body.input[0].content[0].text, /compact summary/);
    assert.deepEqual(nativeRequests[0].body.input[1], nativeCompaction);
  } finally {
    await stopChild(router);
    await Promise.all([closeServer(native.server), closeServer(gateway.server)]);
  }
});

test("router strips non-OpenAI reasoning encrypted_content before replaying to native", async () => {
  const nativeRequests = [];
  const native = await mockServer(async (request, response) => {
    nativeRequests.push({ headers: request.headers, body: await bodyJson(request) });
    json(response, 200, { route: "native" });
  });
  const routerPort = await openPort();
  const router = run("router.mjs", {
    CODEX_ROUTER_PORT: String(routerPort),
    CODEX_NATIVE_BASE_URL: `http://127.0.0.1:${native.port}/backend-api/codex`,
    CODEX_ROUTER_QUIET: "1",
  });
  const headers = {
    Authorization: "Bearer CODEX_CALLER_SECRET",
    "Content-Type": "application/json",
  };

  try {
    await waitFor(`${routerBase(routerPort)}/models`, router);
    // Mimics an Ollama local-responses reasoning item: encrypted_content holds
    // the plain-text reasoning instead of an OpenAI-issued opaque blob.
    const bogusReasoning = {
      type: "reasoning",
      id: "rs_518653",
      summary: [{ type: "summary_text", text: "The user is frustrated." }],
      content: null,
      encrypted_content: "The user is frustrated.",
    };
    const genuineReasoning = {
      type: "reasoning",
      id: "rs_real",
      summary: [],
      content: null,
      encrypted_content: "gAAAAABkZmtM7cT9w_XY_zThisIsAnOpaqueBlobWithNoWhitespace",
    };
    const userMessage = {
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: "continue" }],
    };
    const replay = await fetch(`${routerBase(routerPort)}/responses`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: "gpt-5.6-sol",
        input: [bogusReasoning, genuineReasoning, userMessage],
      }),
    });
    assert.equal(replay.status, 200);
    const sent = nativeRequests[0].body.input;
    const sentBogus = sent.find((item) => item?.id === "rs_518653");
    const sentGenuine = sent.find((item) => item?.id === "rs_real");
    assert.equal(sentBogus.type, "reasoning");
    assert.equal(sentBogus.encrypted_content, undefined);
    assert.deepEqual(sentBogus.summary, bogusReasoning.summary);
    assert.equal(sentGenuine.encrypted_content, genuineReasoning.encrypted_content);
  } finally {
    await stopChild(router);
    await closeServer(native.server);
  }
});

test("router inlines an external parent's plaintext task before replaying to native", async () => {
  const nativeRequests = [];
  const native = await mockServer(async (request, response) => {
    nativeRequests.push({ headers: request.headers, body: await bodyJson(request) });
    json(response, 200, { route: "native" });
  });
  const routerPort = await openPort();
  const router = run("router.mjs", {
    CODEX_ROUTER_PORT: String(routerPort),
    CODEX_NATIVE_BASE_URL: `http://127.0.0.1:${native.port}/backend-api/codex`,
    CODEX_ROUTER_QUIET: "1",
  });
  const headers = {
    Authorization: "Bearer CODEX_CALLER_SECRET",
    "Content-Type": "application/json",
  };

  try {
    await waitFor(`${routerBase(routerPort)}/models`, router);
    // A routed parent never reaches the native backend, so Codex stores the
    // delegated task as plain text under encrypted_content. Replaying that to
    // OpenAI fails the whole request with "Encrypted function output content
    // could not be decrypted or decoded", killing the native subagent.
    const externalParentTask = {
      type: "agent_message",
      id: "amsg_external",
      author: "/root",
      recipient: "/root/reviewer",
      content: [
        {
          type: "input_text",
          text: "Message Type: NEW_TASK\nTask name: /root/reviewer\nSender: /root\nPayload:\n",
        },
        { type: "encrypted_content", encrypted_content: "Inspect /tmp/capture.png harshly." },
      ],
    };
    const nativeParentTask = {
      type: "agent_message",
      id: "amsg_native",
      author: "/root",
      recipient: "/root/other",
      content: [
        {
          type: "input_text",
          text: "Message Type: NEW_TASK\nTask name: /root/other\nSender: /root\nPayload:\n",
        },
        {
          type: "encrypted_content",
          encrypted_content: "gAAAAABkZmtM7cT9w_XY_zThisIsAnOpaqueBlobWithNoWhitespace==",
        },
      ],
    };
    const replay = await fetch(`${routerBase(routerPort)}/responses`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: "gpt-5.6-sol",
        input: [externalParentTask, nativeParentTask],
      }),
    });
    assert.equal(replay.status, 200);
    const sent = nativeRequests[0].body.input;
    const sentExternal = sent.find((item) => item?.id === "amsg_external");
    const sentNative = sent.find((item) => item?.id === "amsg_native");
    // The unreadable field is gone and the task survives as ordinary text.
    assert.equal(
      sentExternal.content.some((part) => part?.type === "encrypted_content"),
      false,
    );
    assert.deepEqual(sentExternal.content.at(-1), {
      type: "input_text",
      text: "Inspect /tmp/capture.png harshly.",
    });
    assert.equal(sentExternal.recipient, "/root/reviewer");
    // Genuine OpenAI ciphertext must reach the backend untouched.
    assert.deepEqual(sentNative, nativeParentTask);
  } finally {
    await stopChild(router);
    await closeServer(native.server);
  }
});

// A routed subagent cannot mint an OpenAI Fernet token, so Codex stores its
// readable handoff under `agent_message.content[].encrypted_content` regardless
// of how the surrounding envelope is rendered. The envelope-matching path only
// covers the four `Message Type:` headers that end at `Payload:`; everything
// else reached OpenAI unchanged and failed the whole request with "Encrypted
// function output content could not be decrypted or decoded", so the
// conversation could neither continue nor compact.
const readableHandoffCases = [
  {
    label: "no envelope at all",
    id: "amsg_bare",
    content: [{ type: "encrypted_content", encrypted_content: "Summarize the diff." }],
    expected: [{ type: "input_text", text: "Summarize the diff." }],
  },
  {
    label: "text after the payload",
    id: "amsg_trailing",
    content: [
      {
        type: "input_text",
        text: "Message Type: FINAL_ANSWER\nSender: /root/reviewer\nPayload:\n",
      },
      { type: "encrypted_content", encrypted_content: "The review is done." },
      { type: "input_text", text: "\n(truncated)" },
    ],
    expected: [
      {
        type: "input_text",
        text: "Message Type: FINAL_ANSWER\nSender: /root/reviewer\nPayload:\n",
      },
      { type: "input_text", text: "The review is done." },
      { type: "input_text", text: "\n(truncated)" },
    ],
  },
  {
    label: "unrecognized message type",
    id: "amsg_unknown_type",
    content: [
      { type: "input_text", text: "Message Type: TASK_ABORTED\nSender: /root\nPayload:\n" },
      { type: "encrypted_content", encrypted_content: "The user interrupted the task." },
    ],
    expected: [
      { type: "input_text", text: "Message Type: TASK_ABORTED\nSender: /root\nPayload:\n" },
      { type: "input_text", text: "The user interrupted the task." },
    ],
  },
  {
    label: "readable and opaque parts in one message",
    id: "amsg_mixed",
    content: [
      { type: "input_text", text: "Message Type: MESSAGE\nSender: /root\nPayload:\n" },
      { type: "encrypted_content", encrypted_content: "Readable routed handoff." },
      {
        type: "encrypted_content",
        encrypted_content: "gAAAAABkZmtM7cT9w_XY_zThisIsAnOpaqueBlobWithNoWhitespace==",
      },
    ],
    expected: [
      { type: "input_text", text: "Message Type: MESSAGE\nSender: /root\nPayload:\n" },
      { type: "input_text", text: "Readable routed handoff." },
      {
        type: "encrypted_content",
        encrypted_content: "gAAAAABkZmtM7cT9w_XY_zThisIsAnOpaqueBlobWithNoWhitespace==",
      },
    ],
  },
];

// Nothing here may be rewritten: an opaque OpenAI blob has to arrive
// byte-identical, and `input_text` / `input_image` are already legal.
const untouchedHandoffItems = [
  {
    type: "agent_message",
    id: "amsg_opaque",
    author: "/root",
    recipient: "/root/other",
    content: [
      { type: "input_text", text: "Message Type: NEW_TASK\nSender: /root\nPayload:\n" },
      {
        type: "encrypted_content",
        encrypted_content: "gAAAAABmXk9wQ1J2c3RfT3BhcXVlQmxvYl9Ob1doaXRlc3BhY2U=",
      },
    ],
  },
  {
    type: "agent_message",
    id: "amsg_plain_parts",
    author: "/root/reviewer",
    recipient: "/root",
    content: [
      { type: "input_text", text: "Already ordinary text." },
      { type: "input_image", image_url: "https://example.invalid/shot.png" },
    ],
  },
];

for (const endpoint of ["/responses", "/responses/compact"]) {
  test(`router converts readable routed-agent handoffs to input_text on ${endpoint}`, async () => {
    const nativeRequests = [];
    const native = await mockServer(async (request, response) => {
      nativeRequests.push({ url: request.url, body: await bodyJson(request) });
      json(response, 200, { route: "native" });
    });
    const routerPort = await openPort();
    const router = run("router.mjs", {
      CODEX_ROUTER_PORT: String(routerPort),
      CODEX_NATIVE_BASE_URL: `http://127.0.0.1:${native.port}/backend-api/codex`,
      CODEX_ROUTER_QUIET: "1",
    });
    const headers = {
      Authorization: "Bearer CODEX_CALLER_SECRET",
      "Content-Type": "application/json",
    };

    try {
      await waitFor(`${routerBase(routerPort)}/models`, router);
      const input = [
        ...readableHandoffCases.map((entry) => ({
          type: "agent_message",
          id: entry.id,
          author: "/root",
          recipient: "/root/reviewer",
          content: entry.content,
        })),
        ...untouchedHandoffItems,
      ];
      const replay = await fetch(`${routerBase(routerPort)}${endpoint}`, {
        method: "POST",
        headers,
        body: JSON.stringify({ model: "gpt-5.6-sol", input }),
      });
      assert.equal(replay.status, 200);
      assert.match(nativeRequests[0].url, new RegExp(`${endpoint}$`));
      const sent = nativeRequests[0].body.input;
      for (const entry of readableHandoffCases) {
        const item = sent.find((candidate) => candidate?.id === entry.id);
        assert.deepEqual(item.content, entry.expected, entry.label);
        assert.equal(item.type, "agent_message", entry.label);
        assert.equal(item.recipient, "/root/reviewer", entry.label);
      }
      for (const untouched of untouchedHandoffItems) {
        assert.deepEqual(
          sent.find((candidate) => candidate?.id === untouched.id),
          untouched,
        );
      }
    } finally {
      await stopChild(router);
      await closeServer(native.server);
    }
  });
}

// Gemini models reach the registry only through `bin/curate-models gemini-api`,
// so the fixture registers one the same way curation does.
function curatedGeminiModel() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "routing-user-models-"));
  const file = path.join(dir, "user-models.json");
  writeFileSync(
    file,
    JSON.stringify({
      version: 1,
      models: [
        {
          slug: "gemini-api/gemini-3.5-flash",
          gatewayModel: "gemini-api-gemini-3-5-flash",
          upstreamModel: "gemini-3.5-flash",
          provider: "gemini-api",
          listed: true,
          displayName: "Gemini 3.5 Flash (curated)",
          description: "Test fixture.",
          priority: 500,
          defaultEffort: "high",
          reasoningLevels: [{ effort: "high", description: "Adaptive reasoning" }],
          contextWindow: 131072,
          autoCompact: 110000,
          // Honest for this model, and load-bearing for the signature test
          // below: a model declared text-only has its image parts replaced
          // before any Gemini-specific handling is reached.
          inputModalities: ["text", "image"],
          compHash: "gemini-api-gemini-3-5-flash-user-v1",
        },
      ],
    }),
    "utf8",
  );
  return { dir, file, gatewayModel: "gemini-api-gemini-3-5-flash" };
}

function curatedCopilotModel() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "routing-copilot-models-"));
  const file = path.join(dir, "user-models.json");
  writeFileSync(
    file,
    JSON.stringify({
      version: 1,
      models: [
        {
          slug: "github-copilot/gpt-test",
          gatewayModel: "github-copilot-gpt-test",
          upstreamModel: "gpt-test",
          provider: "github-copilot",
          listed: true,
          displayName: "GPT Test (Copilot)",
          description: "Test fixture.",
          priority: 500,
          defaultEffort: "high",
          reasoningLevels: [{ effort: "high", description: "Adaptive reasoning" }],
          contextWindow: 131072,
          autoCompact: 110000,
          inputModalities: ["text", "image"],
          compHash: "github-copilot-gpt-test-user-v1",
        },
      ],
    }),
    "utf8",
  );
  return { dir, file, gatewayModel: "github-copilot-gpt-test" };
}

test("API forwarder validates Copilot auth, sets identity headers, and retries routing once", async () => {
  const userRequests = [];
  const upstreamRequests = [];
  const upstream = await mockServer(async (request, response) => {
    if (request.url === "/user") {
      userRequests.push(request.headers);
      json(response, 200, {
        endpoints: {},
      });
      return;
    }
    upstreamRequests.push({
      headers: request.headers,
      body: await bodyJson(request),
    });
    if (upstreamRequests.length === 1) {
      json(response, 401, { error: { message: "expired" } });
      return;
    }
    json(response, 200, {
      id: "resp_copilot",
      object: "response",
      status: "completed",
      model: "gpt-test",
      output: [],
    });
  });
  const curated = curatedCopilotModel();
  const forwarderPort = await openPort();
  const forwarder = run("api-forwarder.mjs", {
    CODEX_ROUTER_API_PORT: String(forwarderPort),
    MODEL_ROUTER_USER_MODELS: curated.file,
    GITHUB_COPILOT_BASE_URL: `http://127.0.0.1:${upstream.port}`,
    GITHUB_COPILOT_USER_URL: `http://127.0.0.1:${upstream.port}/user`,
    COPILOT_GITHUB_TOKEN: "github_pat_TEST_GITHUB_SOURCE_TOKEN",
    CODEX_ROUTER_QUIET: "1",
  });

  try {
    await waitFor(`http://127.0.0.1:${forwarderPort}/health`, forwarder, {
      Authorization: `Bearer ${INTERNAL_KEY}`,
    });
    const response = await fetch(`http://127.0.0.1:${forwarderPort}/v1/responses`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${INTERNAL_KEY}`,
        "ChatGPT-Account-Id": "must-not-forward",
        "Copilot-Integration-Id": "must-not-forward",
        "X-Initiator": "user",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: `responses/${curated.gatewayModel}`,
        service_tier: "priority",
        input: [
          {
            type: "message",
            role: "user",
            content: [{ type: "input_image", image_url: "data:image/png;base64,AAA" }],
          },
          { type: "function_call_output", call_id: "call-1", output: "ok" },
        ],
      }),
    });
    assert.equal(response.status, 200, forwarder.testErrors());
    assert.equal(userRequests.length, 2);
    assert.equal(userRequests[0].authorization, "Bearer github_pat_TEST_GITHUB_SOURCE_TOKEN");
    assert.equal(upstreamRequests.length, 2);
    assert.equal(upstreamRequests[0].headers.authorization, "Bearer github_pat_TEST_GITHUB_SOURCE_TOKEN");
    assert.equal(upstreamRequests[1].headers.authorization, "Bearer github_pat_TEST_GITHUB_SOURCE_TOKEN");
    assert.equal(upstreamRequests[1].headers["copilot-integration-id"], "copilot-developer-cli");
    assert.equal(upstreamRequests[1].headers["openai-intent"], "conversation-edits");
    assert.equal(upstreamRequests[1].headers["x-initiator"], "agent");
    assert.equal(upstreamRequests[1].headers["copilot-vision-request"], "true");
    assert.equal(upstreamRequests[1].headers["chatgpt-account-id"], undefined);
    assert.equal(upstreamRequests[1].body.model, "gpt-test");
    assert.equal(upstreamRequests[1].body.service_tier, undefined);
  } finally {
    await stopChild(forwarder);
    await closeServer(upstream.server);
    rmSync(curated.dir, { recursive: true, force: true });
  }
});

// The forwarder sits downstream of the gateway, so Codex's own traffic reaches
// it already bridged. What this covers is the other way in: a client talking to
// the gateway directly, whose image would otherwise reach the provider intact
// and come back as a 400 naming a JSON variant rather than an image.
test("API forwarder replaces an image a text-only model cannot read", async () => {
  const upstreamRequests = [];
  const upstream = await mockServer(async (request, response) => {
    upstreamRequests.push(await bodyJson(request));
    json(response, 200, { choices: [] });
  });
  const forwarderPort = await openPort();
  const forwarder = run("api-forwarder.mjs", {
    CODEX_ROUTER_API_PORT: String(forwarderPort),
    DEEPSEEK_API_BASE_URL: `http://127.0.0.1:${upstream.port}/v1`,
    DEEPSEEK_API_KEY: "TEST_DEEPSEEK_API_KEY",
    KIMI_PROXY_QUIET: "1",
  });

  try {
    await waitFor(`http://127.0.0.1:${forwarderPort}/health`, forwarder, {
      Authorization: `Bearer ${INTERNAL_KEY}`,
    });
    const response = await fetch(`http://127.0.0.1:${forwarderPort}/v1/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${INTERNAL_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "deepseek-v4-flash",
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "what does this say?" },
              { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
            ],
          },
        ],
      }),
    });
    assert.equal(response.status, 200);
    const body = upstreamRequests[0];
    assert.doesNotMatch(JSON.stringify(body), /image_url|base64/);
    // A chat-completions part is `text`; substituting a Responses `input_text`
    // would trade an image the provider rejects for a text part it rejects.
    assert.deepEqual(
      body.messages[0].content.map((part) => part.type),
      ["text", "text"],
    );
    assert.match(body.messages[0].content[1].text, /could not be read/);
    assert.match(body.messages[0].content[1].text, /skips the router's vision bridge/);
  } finally {
    await stopChild(forwarder);
    await closeServer(upstream.server);
  }
});

test("API forwarder fills only missing Gemini thought signatures", async () => {
  const upstreamRequests = [];
  const upstream = await mockServer(async (request, response) => {
    upstreamRequests.push(await bodyJson(request));
    json(response, 200, { choices: [] });
  });
  const curated = curatedGeminiModel();
  const forwarderPort = await openPort();
  const forwarder = run("api-forwarder.mjs", {
    CODEX_ROUTER_API_PORT: String(forwarderPort),
    MODEL_ROUTER_USER_MODELS: curated.file,
    GEMINI_API_BASE_URL: `http://127.0.0.1:${upstream.port}/v1`,
    GEMINI_API_KEY: "TEST_GEMINI_API_KEY",
    KIMI_PROXY_QUIET: "1",
  });

  try {
    await waitFor(`http://127.0.0.1:${forwarderPort}/health`, forwarder, {
      Authorization: `Bearer ${INTERNAL_KEY}`,
    });
    const response = await fetch(`http://127.0.0.1:${forwarderPort}/v1/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${INTERNAL_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: curated.gatewayModel,
        web_search_options: { search_context_size: "medium" },
        thinking: { type: "enabled" },
        think: true,
        store: true,
        logit_bias: { 123: -100 },
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "look" },
              { type: "image_url", image_url: { url: "data:image/png;base64,AAA" } },
            ],
          },
          {
            role: "assistant",
            tool_calls: [
              {
                id: "call-signed",
                type: "function",
                thought_signature: "real-upstream-signature",
                function: { name: "a", arguments: "{}" },
              },
              { id: "call-bare", type: "function", function: { name: "b", arguments: "{}" } },
            ],
          },
          {
            role: "tool",
            tool_call_id: "call-signed",
            content: [
              { type: "text", text: "screenshot:" },
              { type: "image_url", image_url: { url: "data:image/png;base64,BBB" } },
            ],
          },
          { role: "tool", tool_call_id: "call-bare", content: "ok" },
        ],
      }),
    });
    assert.equal(response.status, 200);
    const body = upstreamRequests[0];
    assert.equal(body.model, "gemini-3.5-flash");
    // Google's OpenAI-compatible endpoint 400s on any non-OpenAI field, so the
    // web search, thinking/think reasoning controls, and the OpenAI-only
    // store/logit_bias fields are stripped outright.
    assert.equal(body.web_search_options, undefined);
    assert.equal(body.thinking, undefined);
    assert.equal(body.think, undefined);
    assert.equal(body.store, undefined);
    assert.equal(body.logit_bias, undefined);
    // Google accepts images only on user turns: the user image survives, the
    // tool-turn image is downgraded to a text placeholder.
    const userMsg = body.messages.find((message) => message.role === "user");
    assert.deepEqual(userMsg.content, [
      { type: "text", text: "look" },
      { type: "image_url", image_url: { url: "data:image/png;base64,AAA" } },
    ]);
    const toolMsg = body.messages.find(
      (message) => message.role === "tool" && Array.isArray(message.content),
    );
    assert.deepEqual(toolMsg.content, [
      { type: "text", text: "screenshot:" },
      { type: "text", text: "[Image]" },
    ]);
    const [signed, bare] = body.messages.find((message) => message.role === "assistant").tool_calls;
    // A signature Gemini already returned must survive untouched.
    assert.equal(signed.thought_signature, "real-upstream-signature");
    assert.equal(signed.extra_content, undefined);
    // A call with no signature gets the documented validation bypass.
    assert.equal(bare.thought_signature, "skip_thought_signature_validator");
    assert.equal(
      bare.extra_content.google.thought_signature,
      "skip_thought_signature_validator",
    );
  } finally {
    await stopChild(forwarder);
    await closeServer(upstream.server);
    rmSync(curated.dir, { recursive: true, force: true });
  }
});

test("API forwarder leaves non-Gemini tool calls unsigned", async () => {
  const upstreamRequests = [];
  const upstream = await mockServer(async (request, response) => {
    upstreamRequests.push(await bodyJson(request));
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
    await waitFor(`http://127.0.0.1:${forwarderPort}/health`, forwarder, {
      Authorization: `Bearer ${INTERNAL_KEY}`,
    });
    const response = await fetch(`http://127.0.0.1:${forwarderPort}/v1/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${INTERNAL_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "kimi-api-k3",
        messages: [
          { role: "user", content: "test" },
          {
            role: "assistant",
            tool_calls: [
              { id: "call-1", type: "function", function: { name: "a", arguments: "{}" } },
            ],
          },
          { role: "tool", tool_call_id: "call-1", content: "ok" },
        ],
      }),
    });
    assert.equal(response.status, 200);
    const [call] = upstreamRequests[0].messages.find(
      (message) => message.role === "assistant",
    ).tool_calls;
    assert.equal(call.thought_signature, undefined);
    assert.equal(call.extra_content, undefined);
  } finally {
    await stopChild(forwarder);
    await closeServer(upstream.server);
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
    await waitFor(`http://127.0.0.1:${forwarderPort}/health`, forwarder, {
      Authorization: `Bearer ${INTERNAL_KEY}`,
    });
    const unauthorizedHealth = await fetch(
      `http://127.0.0.1:${forwarderPort}/health`,
    );
    assert.equal(unauthorizedHealth.status, 401);
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
          client_metadata: { workspace: "caller-owned" },
        }),
      },
    );
    assert.equal(response.status, 200);
    const request = upstreamRequests[0];
    assert.equal(request.headers.authorization, "Bearer TEST_KIMI_API_KEY");
    assert.equal(request.headers["chatgpt-account-id"], undefined);
    assert.equal(request.headers["x-codex-installation-id"], undefined);
    assert.equal(request.body.model, "kimi-k3");
    // K3 documents low/high/max; the requested low passes through unchanged.
    assert.equal(request.body.reasoning_effort, "low");
    assert.equal(request.body.client_metadata, undefined);
  } finally {
    await stopChild(forwarder);
    await closeServer(upstream.server);
  }
});

test("API forwarder routes ClinePass with isolated auth and unchanged stream tools", async () => {
  const upstreamRequests = [];
  const upstream = await mockServer(async (request, response) => {
    upstreamRequests.push({
      url: request.url,
      headers: request.headers,
      body: await bodyJson(request),
    });
    json(response, 200, { choices: [] });
  });
  const forwarderPort = await openPort();
  const forwarder = run("api-forwarder.mjs", {
    CODEX_ROUTER_API_PORT: String(forwarderPort),
    CLINE_API_BASE_URL: `http://127.0.0.1:${upstream.port}/api/v1`,
    CLINE_API_KEY: "TEST_CLINEPASS_KEY",
    CODEX_ROUTER_QUIET: "1",
  });

  try {
    await waitFor(`http://127.0.0.1:${forwarderPort}/health`, forwarder, {
      Authorization: `Bearer ${INTERNAL_KEY}`,
    });
    const tools = [{
      type: "function",
      function: {
        name: "read_file",
        parameters: { type: "object", properties: { path: { type: "string" } } },
      },
    }];
    const response = await fetch(
      `http://127.0.0.1:${forwarderPort}/v1/chat/completions`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${INTERNAL_KEY}`,
          "X-Api-Key": "must-not-forward",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "clinepass-qwen3-8-max",
          reasoning_effort: "high",
          thinking: { type: "enabled" },
          top_p: 0.9,
          temperature: 0.7,
          stream: true,
          tools,
          tool_choice: "auto",
          messages: [{ role: "user", content: "test" }],
        }),
      },
    );
    assert.equal(response.status, 200);
    const request = upstreamRequests[0];
    assert.equal(request.url, "/api/v1/chat/completions");
    assert.equal(request.headers.authorization, "Bearer TEST_CLINEPASS_KEY");
    assert.equal(request.headers["x-api-key"], undefined);
    assert.equal(request.body.model, "cline-pass/qwen3.8-max");
    assert.equal(request.body.reasoning_effort, undefined);
    assert.equal(request.body.thinking, undefined);
    assert.equal(request.body.top_p, undefined);
    assert.equal(request.body.temperature, 0.7);
    assert.equal(request.body.stream, true);
    assert.deepEqual(request.body.tools, tools);
    assert.equal(request.body.tool_choice, "auto");
  } finally {
    await stopChild(forwarder);
    await closeServer(upstream.server);
  }
});

test("API forwarder health omits disabled API providers", async () => {
  const testRoot = mkdtempSync(path.join(os.tmpdir(), "api-forwarder-health-"));
  writeFileSync(
    path.join(testRoot, "enabled-providers.json"),
    `${JSON.stringify({ version: 1, providers: ["kimi-oauth"] })}\n`,
    { mode: 0o600 },
  );
  const forwarderPort = await openPort();
  const forwarder = run("api-forwarder.mjs", {
    CODEX_ROUTER_API_PORT: String(forwarderPort),
    CODEX_ROUTER_STATE_DIR: testRoot,
    CODEX_ROUTER_SHOW_ALL_MODELS: "0",
    CODEX_ROUTER_QUIET: "1",
  });

  try {
    await waitFor(`http://127.0.0.1:${forwarderPort}/health`, forwarder, {
      Authorization: `Bearer ${INTERNAL_KEY}`,
    });
    const response = await fetch(`http://127.0.0.1:${forwarderPort}/health`, {
      headers: { Authorization: `Bearer ${INTERNAL_KEY}` },
    });
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.deepEqual(payload.providers, {});
  } finally {
    await stopChild(forwarder);
    rmSync(testRoot, { recursive: true, force: true });
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
    await waitFor(`http://127.0.0.1:${forwarderPort}/health`, forwarder, {
      Authorization: `Bearer ${INTERNAL_KEY}`,
    });
    // DeepSeek documents low/high/max; low passes through (a real tier on
    // V4 Flash) and the xhigh compat alias maps to max.
    for (const [gatewayModel, upstreamModel, sentEffort, effort] of [
      ["deepseek-v4-flash", "deepseek-v4-flash", "low", "low"],
      ["deepseek-v4-flash", "deepseek-v4-flash", "medium", "high"],
      ["deepseek-v4-pro", "deepseek-v4-pro", "xhigh", "max"],
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
            reasoning_effort: sentEffort,
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

test("API forwarder downgrades forced tool choices for DeepSeek thinking models", async () => {
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

  async function forward(gatewayModel, body) {
    const response = await fetch(
      `http://127.0.0.1:${forwarderPort}/v1/chat/completions`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${INTERNAL_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: gatewayModel,
          messages: [{ role: "user", content: "test" }],
          ...body,
        }),
      },
    );
    assert.equal(response.status, 200);
    return upstreamRequests.at(-1);
  }

  try {
    await waitFor(`http://127.0.0.1:${forwarderPort}/health`, forwarder, {
      Authorization: `Bearer ${INTERNAL_KEY}`,
    });
    // DeepSeek answers a forced tool choice under thinking with HTTP 400
    // ("Thinking mode does not support this tool_choice"). The compatibility
    // probe sends the string form and the subagent payload relay sends the
    // object form, so both must arrive as auto rather than failing the turn.
    for (const gatewayModel of [
      "deepseek-v4-flash",
      "deepseek-v4-pro",
      "deepseek-legacy-reasoner",
    ]) {
      for (const toolChoice of [
        "required",
        { type: "function", function: { name: "relay_external_agent_payload" } },
      ]) {
        const request = await forward(gatewayModel, { tool_choice: toolChoice });
        assert.deepEqual(request.body.thinking, { type: "enabled" });
        assert.equal(request.body.tool_choice, "auto");
      }

      // "none" is not a forced choice: it suppresses tool calls, which the
      // compaction turn relies on, so it must survive untouched.
      const suppressed = await forward(gatewayModel, { tool_choice: "none" });
      assert.equal(suppressed.body.tool_choice, "none");

      // An absent choice stays absent so DeepSeek applies its own default.
      const absent = await forward(gatewayModel, {});
      assert.equal(absent.body.tool_choice, undefined);
      assert.equal("tool_choice" in absent.body, false);
    }

    // Thinking is disabled on the non-thinking profile, so the restriction does
    // not apply and a forced choice must pass through unchanged.
    const nonThinking = await forward("deepseek-legacy-chat", {
      tool_choice: "required",
    });
    assert.deepEqual(nonThinking.body.thinking, { type: "disabled" });
    assert.equal(nonThinking.body.tool_choice, "required");
  } finally {
    await stopChild(forwarder);
    await closeServer(upstream.server);
  }
});

test("API forwarder coalesces consecutive assistant messages so tool results follow tool calls", async () => {
  const upstreamRequests = [];
  const upstream = await mockServer(async (request, response) => {
    upstreamRequests.push({ headers: request.headers, body: await bodyJson(request) });
    json(response, 200, { choices: [] });
  });
  const forwarderPort = await openPort();
  const forwarder = run("api-forwarder.mjs", {
    CODEX_ROUTER_API_PORT: String(forwarderPort),
    DEEPSEEK_API_BASE_URL: `http://127.0.0.1:${upstream.port}/v1`,
    DEEPSEEK_API_KEY: "TEST_DEEPSEEK_KEY",
    CODEX_ROUTER_QUIET: "1",
  });

  try {
    await waitFor(`http://127.0.0.1:${forwarderPort}/health`, forwarder, {
      Authorization: `Bearer ${INTERNAL_KEY}`,
    });
    // Mimics a Responses->chat-completions translation that split one assistant
    // turn into a tool-call message and a separate text message, followed by the
    // tool results. Strict providers (e.g. MiniMax) reject this with
    // "tool call result does not follow tool call" because the tool results no
    // longer follow the tool-call-bearing assistant message.
    const toolCall = {
      id: "call_A",
      type: "function",
      function: { name: "exec_command", arguments: "{}" },
    };
    const response = await fetch(
      `http://127.0.0.1:${forwarderPort}/v1/chat/completions`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${INTERNAL_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "deepseek-v4-pro",
          messages: [
            { role: "user", content: "run it" },
            { role: "assistant", tool_calls: [toolCall] },
            { role: "assistant", content: "Running the command now." },
            { role: "tool", tool_call_id: "call_A", content: "done" },
          ],
        }),
      },
    );
    assert.equal(response.status, 200);
    const messages = upstreamRequests[0].body.messages;
    assert.equal(messages.length, 3);
    assert.equal(messages[1].role, "assistant");
    assert.equal(messages[1].content, "Running the command now.");
    assert.deepEqual(messages[1].tool_calls, [toolCall]);
    assert.equal(messages[2].role, "tool");
    assert.equal(messages[2].tool_call_id, "call_A");
  } finally {
    await stopChild(forwarder);
    await closeServer(upstream.server);
  }
});

test("API forwarder synthesizes missing tool results for incomplete tool_calls history", async () => {
  const upstreamRequests = [];
  const upstream = await mockServer(async (request, response) => {
    upstreamRequests.push({ headers: request.headers, body: await bodyJson(request) });
    json(response, 200, { choices: [] });
  });
  const forwarderPort = await openPort();
  const forwarder = run("api-forwarder.mjs", {
    CODEX_ROUTER_API_PORT: String(forwarderPort),
    DEEPSEEK_API_BASE_URL: `http://127.0.0.1:${upstream.port}/v1`,
    DEEPSEEK_API_KEY: "TEST_DEEPSEEK_KEY",
    CODEX_ROUTER_QUIET: "1",
  });

  try {
    await waitFor(`http://127.0.0.1:${forwarderPort}/health`, forwarder, {
      Authorization: `Bearer ${INTERNAL_KEY}`,
    });
    // Compact / Responses->chat translation can leave assistant tool_calls without
    // matching tool rows. Console Go rejects that with "insufficient tool
    // messages following tool_calls message".
    const toolCalls = [
      {
        id: "call_A",
        type: "function",
        function: { name: "exec_command", arguments: '{"cmd":"ls"}' },
      },
      {
        id: "call_B",
        type: "function",
        function: { name: "view_image", arguments: '{"path":"x.png"}' },
      },
    ];
    const response = await fetch(
      `http://127.0.0.1:${forwarderPort}/v1/chat/completions`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${INTERNAL_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "deepseek-v4-flash",
          messages: [
            { role: "user", content: "continue after compact" },
            { role: "assistant", tool_calls: toolCalls },
            // Only one of the two call ids has a real tool result.
            { role: "tool", tool_call_id: "call_A", content: "done" },
            { role: "user", content: "what next?" },
            // Orphan tool row after a user turn should not break the contract.
            { role: "tool", tool_call_id: "call_orphan", content: "stale" },
          ],
        }),
      },
    );
    assert.equal(response.status, 200);
    const messages = upstreamRequests[0].body.messages;
    assert.equal(messages[0].role, "user");
    assert.equal(messages[1].role, "assistant");
    assert.deepEqual(messages[1].tool_calls, toolCalls);
    assert.equal(messages[2].role, "tool");
    assert.equal(messages[2].tool_call_id, "call_A");
    assert.equal(messages[2].content, "done");
    assert.equal(messages[3].role, "tool");
    assert.equal(messages[3].tool_call_id, "call_B");
    assert.match(messages[3].content, /tool result unavailable/);
    assert.equal(messages[4].role, "user");
    assert.equal(messages[4].content, "what next?");
    assert.equal(messages.length, 5);
  } finally {
    await stopChild(forwarder);
    await closeServer(upstream.server);
  }
});

test("API forwarder coalesces split assistant tool turns before synthesizing missing results", async () => {
  const upstreamRequests = [];
  const upstream = await mockServer(async (request, response) => {
    upstreamRequests.push({ headers: request.headers, body: await bodyJson(request) });
    json(response, 200, { choices: [] });
  });
  const forwarderPort = await openPort();
  const forwarder = run("api-forwarder.mjs", {
    CODEX_ROUTER_API_PORT: String(forwarderPort),
    DEEPSEEK_API_BASE_URL: `http://127.0.0.1:${upstream.port}/v1`,
    DEEPSEEK_API_KEY: "TEST_DEEPSEEK_KEY",
    CODEX_ROUTER_QUIET: "1",
  });

  try {
    await waitFor(`http://127.0.0.1:${forwarderPort}/health`, forwarder, {
      Authorization: `Bearer ${INTERNAL_KEY}`,
    });
    const toolCall = {
      id: "call_A",
      type: "function",
      function: { name: "exec_command", arguments: "{}" },
    };
    const response = await fetch(
      `http://127.0.0.1:${forwarderPort}/v1/chat/completions`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${INTERNAL_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "deepseek-v4-pro",
          messages: [
            { role: "user", content: "run it" },
            { role: "assistant", tool_calls: [toolCall] },
            { role: "assistant", content: "Running the command now." },
            // Missing tool result after the split assistant turn.
          ],
        }),
      },
    );
    assert.equal(response.status, 200);
    const messages = upstreamRequests[0].body.messages;
    assert.equal(messages.length, 3);
    assert.equal(messages[1].role, "assistant");
    assert.equal(messages[1].content, "Running the command now.");
    assert.deepEqual(messages[1].tool_calls, [toolCall]);
    assert.equal(messages[2].role, "tool");
    assert.equal(messages[2].tool_call_id, "call_A");
    assert.match(messages[2].content, /tool result unavailable/);
  } finally {
    await stopChild(forwarder);
    await closeServer(upstream.server);
  }
});

test("API forwarder routes Ollama Cloud models without unsupported parameters", async () => {
  const upstreamRequests = [];
  const upstream = await mockServer(async (request, response) => {
    upstreamRequests.push({ headers: request.headers, body: await bodyJson(request) });
    json(response, 200, { choices: [] });
  });
  const forwarderPort = await openPort();
  const forwarder = run("api-forwarder.mjs", {
    CODEX_ROUTER_API_PORT: String(forwarderPort),
    OLLAMA_CLOUD_BASE_URL: `http://127.0.0.1:${upstream.port}`,
    OLLAMA_API_KEY: "TEST_OLLAMA_CLOUD_KEY",
    CODEX_ROUTER_QUIET: "1",
  });

  try {
    await waitFor(`http://127.0.0.1:${forwarderPort}/health`, forwarder, {
      Authorization: `Bearer ${INTERNAL_KEY}`,
    });
    // Ollama accepts high/medium/low/max/none and errors on anything else, so
    // Codex-only rungs must be mapped rather than forwarded verbatim.
    for (const [gatewayModel, upstreamModel, sentEffort, expectedEffort] of [
      ["ollama-cloud-glm-5-2", "glm-5.2", "high", "high"],
      ["ollama-cloud-glm-5-2", "glm-5.2", "max", "max"],
      ["ollama-cloud-glm-5-2", "glm-5.2", "xhigh", "max"],
      ["ollama-cloud-glm-5-2", "glm-5.2", "minimal", "none"],
      ["ollama-cloud-glm-5-2", "glm-5.2", "bogus", "high"],
      ["ollama-cloud-kimi-k2-7-code", "kimi-k2.7-code", "high", "high"],
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
            reasoning_effort: sentEffort,
            messages: [{ role: "user", content: "test" }],
          }),
        },
      );
      assert.equal(response.status, 200);
      const request = upstreamRequests.at(-1);
      assert.equal(request.headers.authorization, "Bearer TEST_OLLAMA_CLOUD_KEY");
      assert.equal(request.headers["chatgpt-account-id"], undefined);
      assert.equal(request.headers["x-codex-installation-id"], undefined);
      assert.equal(request.body.model, upstreamModel);
      assert.equal(request.body.reasoning_effort, expectedEffort);
      assert.equal(request.body.think, undefined);
    }

    // An absent effort stays absent so Ollama applies the model's own default.
    await fetch(`http://127.0.0.1:${forwarderPort}/v1/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${INTERNAL_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "ollama-cloud-glm-5-2",
        messages: [{ role: "user", content: "test" }],
      }),
    });
    assert.equal(upstreamRequests.at(-1).body.reasoning_effort, undefined);

    async function forwardMiniMax(toolChoice) {
      const response = await fetch(
        `http://127.0.0.1:${forwarderPort}/v1/chat/completions`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${INTERNAL_KEY}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model: "ollama-cloud-minimax-m3",
            reasoning_effort: "high",
            messages: [{ role: "user", content: "test" }],
            ...(toolChoice === undefined ? {} : { tool_choice: toolChoice }),
          }),
        },
      );
      assert.equal(response.status, 200);
      return upstreamRequests.at(-1).body;
    }

    // The combined profile keeps Ollama's effort normalization while applying
    // the MiniMax-specific compatibility exception on direct traffic.
    const required = await forwardMiniMax("required");
    assert.equal(required.model, "minimax-m3");
    assert.equal(required.reasoning_effort, "high");
    assert.equal(required.tool_choice, "auto");

    const forcedFunction = await forwardMiniMax({
      type: "function",
      function: { name: "relay_external_agent_payload" },
    });
    assert.equal(forcedFunction.tool_choice, "auto");

    const suppressed = await forwardMiniMax("none");
    assert.equal(suppressed.tool_choice, "none");

    const absentToolChoice = await forwardMiniMax();
    assert.equal("tool_choice" in absentToolChoice, false);
  } finally {
    await stopChild(forwarder);
    await closeServer(upstream.server);
  }
});


test("API forwarder routes Qwen plan models without unsupported parameters", async () => {
  const upstreamRequests = [];
  const upstream = await mockServer(async (request, response) => {
    upstreamRequests.push({ headers: request.headers, body: await bodyJson(request) });
    json(response, 200, { choices: [] });
  });
  const forwarderPort = await openPort();
  const forwarder = run("api-forwarder.mjs", {
    CODEX_ROUTER_API_PORT: String(forwarderPort),
    QWEN_PLAN_BASE_URL: `http://127.0.0.1:${upstream.port}`,
    QWEN_PLAN_API_KEY: "TEST_QWEN_PLAN_KEY",
    CODEX_ROUTER_QUIET: "1",
  });

  try {
    await waitFor(`http://127.0.0.1:${forwarderPort}/health`, forwarder, {
      Authorization: `Bearer ${INTERNAL_KEY}`,
    });
    // Qwen models have no documented effort control on DashScope, so the
    // parameter is dropped; the cross-vendor DeepSeek/GLM models DO document
    // reasoning_effort there (high/max), so the picked tier passes through.
    for (const [gatewayModel, upstreamModel, expectedEffort] of [
      ["qwen-plan-qwen3-7-max", "qwen3.7-max", undefined],
      ["qwen-plan-qwen3-7-plus", "qwen3.7-plus", undefined],
      ["qwen-plan-qwen3-8-max", "qwen3.8-max", undefined],
      ["qwen-plan-qwen3-8-max-preview", "qwen3.8-max-preview", undefined],
      ["qwen-plan-qwen3-6-flash", "qwen3.6-flash", undefined],
      ["qwen-plan-deepseek-v4-pro", "deepseek-v4-pro", "high"],
      ["qwen-plan-deepseek-v4-flash-0731", "deepseek-v4-flash-0731", "high"],
      ["qwen-plan-glm-5-2", "glm-5.2", "high"],
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
            reasoning_effort: "high",
            tool_choice: "required",
            messages: [{ role: "user", content: "test" }],
          }),
        },
      );
      assert.equal(response.status, 200);
      const request = upstreamRequests.at(-1);
      assert.equal(request.headers.authorization, "Bearer TEST_QWEN_PLAN_KEY");
      assert.equal(request.headers["chatgpt-account-id"], undefined);
      assert.equal(request.headers["x-codex-installation-id"], undefined);
      assert.equal(request.body.model, upstreamModel);
      assert.equal(request.body.reasoning_effort, expectedEffort);
      assert.equal(request.body.tool_choice, "auto");
    }
  } finally {
    await stopChild(forwarder);
    await closeServer(upstream.server);
  }
});

// The catalog-only resellers ship no models, so their entries reach the
// registry only through `bin/curate-models`. The fixture registers two
// OpenRouter models the same way curation does: one whose upstream refuses a
// forced tool choice and therefore carries the opt-in profile, and one that
// does not, because OpenRouter itself imposes no such restriction.
function curatedOpenRouterModels() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "routing-openrouter-models-"));
  const file = path.join(dir, "user-models.json");
  const entry = (provider, upstreamModel, gatewayModel, requestProfile) => ({
    slug: `${provider}/${upstreamModel}`,
    gatewayModel,
    upstreamModel,
    provider,
    listed: true,
    displayName: `${upstreamModel} (curated)`,
    description: "Test fixture.",
    priority: 500,
    defaultEffort: "high",
    reasoningLevels: [{ effort: "high", description: "Adaptive reasoning" }],
    contextWindow: 131072,
    autoCompact: 110000,
    inputModalities: ["text"],
    compHash: `${gatewayModel}-user-v1`,
    ...(requestProfile ? { requestProfile } : {}),
  });
  writeFileSync(
    file,
    JSON.stringify({
      version: 1,
      models: [
        entry("openrouter", "qwen/qwen3.8-max", "openrouter-qwen-qwen3-8-max", "auto-tool-choice"),
        entry("openrouter", "openai/gpt-5.3", "openrouter-openai-gpt-5-3"),
        entry("chutes", "moonshotai/Kimi-K3-TEE", "chutes-moonshotai-kimi-k3-tee"),
      ],
    }),
    "utf8",
  );
  return {
    dir,
    file,
    restricted: "openrouter-qwen-qwen3-8-max",
    unrestricted: "openrouter-openai-gpt-5-3",
    chutes: "chutes-moonshotai-kimi-k3-tee",
  };
}

test("API forwarder downgrades forced tool choices only for models that declare the restriction", async () => {
  const upstreamRequests = [];
  const upstream = await mockServer(async (request, response) => {
    upstreamRequests.push({ headers: request.headers, body: await bodyJson(request) });
    json(response, 200, { choices: [] });
  });
  const curated = curatedOpenRouterModels();
  const forwarderPort = await openPort();
  const forwarder = run("api-forwarder.mjs", {
    CODEX_ROUTER_API_PORT: String(forwarderPort),
    MODEL_ROUTER_USER_MODELS: curated.file,
    OPENROUTER_API_BASE_URL: `http://127.0.0.1:${upstream.port}`,
    OPENROUTER_API_KEY: "TEST_OPENROUTER_API_KEY",
    CHUTES_API_BASE_URL: `http://127.0.0.1:${upstream.port}`,
    CHUTES_API_KEY: "TEST_CHUTES_API_KEY",
    CODEX_ROUTER_QUIET: "1",
  });

  async function forward(gatewayModel, body) {
    const response = await fetch(`http://127.0.0.1:${forwarderPort}/v1/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${INTERNAL_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: gatewayModel,
        messages: [{ role: "user", content: "test" }],
        ...body,
      }),
    });
    assert.equal(response.status, 200);
    return upstreamRequests.at(-1);
  }

  try {
    await waitFor(`http://127.0.0.1:${forwarderPort}/health`, forwarder, {
      Authorization: `Bearer ${INTERNAL_KEY}`,
    });
    // Some upstreams answer a forced tool choice with a hard 400 while still
    // calling tools under "auto". The compatibility probe sends the string
    // form and the subagent payload relay sends the object form, so both must
    // arrive as auto rather than failing the turn.
    for (const toolChoice of [
      "required",
      { type: "function", function: { name: "relay_external_agent_payload" } },
    ]) {
      const request = await forward(curated.restricted, { tool_choice: toolChoice });
      assert.equal(request.headers.authorization, "Bearer TEST_OPENROUTER_API_KEY");
      assert.equal(request.body.model, "qwen/qwen3.8-max");
      assert.equal(request.body.tool_choice, "auto");
    }

    // "none" is not a forced choice: it suppresses tool calls, which the
    // compaction turn relies on, so it must survive untouched.
    const suppressed = await forward(curated.restricted, { tool_choice: "none" });
    assert.equal(suppressed.body.tool_choice, "none");

    // An absent choice stays absent so the upstream applies its own default.
    const absent = await forward(curated.restricted, {});
    assert.equal(absent.body.tool_choice, undefined);
    assert.equal("tool_choice" in absent.body, false);

    // The profile normalizes the tool choice and nothing else. Reusing
    // qwen-plan here would have collapsed the picked effort to DashScope's
    // two-tier ladder, which is not OpenRouter's parameter surface.
    const untouched = await forward(curated.restricted, {
      reasoning_effort: "medium",
      temperature: 0.4,
      tool_choice: "required",
    });
    assert.equal(untouched.body.reasoning_effort, "medium");
    assert.equal(untouched.body.temperature, 0.4);

    // The restriction belongs to the upstream model, not to the reseller: a
    // sibling curated on the same provider keeps its forced choice, so tool
    // calling is not weakened for every OpenRouter model to serve two.
    const sibling = await forward(curated.unrestricted, { tool_choice: "required" });
    assert.equal(sibling.body.model, "openai/gpt-5.3");
    assert.equal(sibling.body.tool_choice, "required");

    const siblingObject = await forward(curated.unrestricted, {
      tool_choice: { type: "function", function: { name: "relay_external_agent_payload" } },
    });
    assert.deepEqual(siblingObject.body.tool_choice, {
      type: "function",
      function: { name: "relay_external_agent_payload" },
    });

    // Chutes K3 accepts forced tool choice, so its locally curated model must
    // preserve "required" through the real credential/base-URL route. This
    // local mock proves translation without spending Chutes quota.
    const chutes = await forward(curated.chutes, {
      reasoning_effort: "high",
      tool_choice: "required",
    });
    assert.equal(chutes.headers.authorization, "Bearer TEST_CHUTES_API_KEY");
    assert.equal(chutes.body.model, "moonshotai/Kimi-K3-TEE");
    assert.equal(chutes.body.tool_choice, "required");
    assert.equal(chutes.body.reasoning_effort, "high");
  } finally {
    await stopChild(forwarder);
    await closeServer(upstream.server);
    rmSync(curated.dir, { recursive: true, force: true });
  }
});


test("API forwarder routes MiniMax M3 streaming tool calls with adaptive thinking", async () => {
  const upstreamRequests = [];
  const upstream = await mockServer(async (request, response) => {
    upstreamRequests.push({
      url: request.url,
      headers: request.headers,
      body: await bodyJson(request),
    });
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    response.end(
      'data: {"choices":[{"delta":{"tool_calls":[{"function":{"arguments":"{\\"city\\":\\"Berlin\\"}"}}]}}]}\n\ndata: [DONE]\n\n',
    );
  });
  const forwarderPort = await openPort();
  const forwarder = run("api-forwarder.mjs", {
    CODEX_ROUTER_API_PORT: String(forwarderPort),
    MINIMAX_BASE_URL: `http://127.0.0.1:${upstream.port}/v1`,
    MINIMAX_API_KEY: "TEST_MINIMAX_API_KEY",
    CODEX_ROUTER_QUIET: "1",
  });

  try {
    await waitFor(`http://127.0.0.1:${forwarderPort}/health`, forwarder, {
      Authorization: `Bearer ${INTERNAL_KEY}`,
    });
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
          model: "minimax-token-plan-minimax-m3",
          reasoning_effort: "high",
          stream: true,
          messages: [{ role: "user", content: "What is the weather?" }],
          tools: [
            {
              type: "function",
              function: {
                name: "get_weather",
                parameters: {
                  type: "object",
                  properties: { city: { type: "string" } },
                  required: ["city"],
                },
              },
            },
          ],
        }),
      },
    );

    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type"), /text\/event-stream/);
    assert.match(await response.text(), /\\"city\\":\\"Berlin\\"/);
    const request = upstreamRequests[0];
    assert.equal(request.url, "/v1/chat/completions");
    assert.equal(request.headers.authorization, "Bearer TEST_MINIMAX_API_KEY");
    assert.equal(request.headers["chatgpt-account-id"], undefined);
    assert.equal(request.headers["x-codex-installation-id"], undefined);
    assert.equal(request.body.model, "MiniMax-M3");
    assert.equal(request.body.stream, true);
    assert.equal(request.body.reasoning_effort, undefined);
    assert.deepEqual(request.body.thinking, { type: "adaptive" });
    assert.equal(request.body.tools[0].function.name, "get_weather");
    assert.deepEqual(request.body.tools[0].function.parameters.required, ["city"]);
  } finally {
    await stopChild(forwarder);
    await closeServer(upstream.server);
  }
});


test("API forwarder routes GLM coding-plan models with thinking enabled", async () => {
  const upstreamRequests = [];
  const upstream = await mockServer(async (request, response) => {
    upstreamRequests.push({ headers: request.headers, body: await bodyJson(request) });
    json(response, 200, { choices: [] });
  });
  const forwarderPort = await openPort();
  const forwarder = run("api-forwarder.mjs", {
    CODEX_ROUTER_API_PORT: String(forwarderPort),
    ZAI_CODING_BASE_URL: `http://127.0.0.1:${upstream.port}`,
    ZAI_API_KEY: "TEST_ZAI_API_KEY",
    CODEX_ROUTER_QUIET: "1",
  });

  try {
    await waitFor(`http://127.0.0.1:${forwarderPort}/health`, forwarder, {
      Authorization: `Bearer ${INTERNAL_KEY}`,
    });
    // GLM-5.2 has two documented tiers (high/max, upstream default max), so
    // high must be sent explicitly; GLM-5-Turbo does not support the
    // parameter and never receives it.
    for (const [gatewayModel, upstreamModel, sentEffort, expectedEffort] of [
      ["zai-coding-glm-5-2", "glm-5.2", "xhigh", "max"],
      ["zai-coding-glm-5-2", "glm-5.2", "high", "high"],
      ["zai-coding-glm-5-turbo", "glm-5-turbo", "low", undefined],
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
            reasoning_effort: sentEffort,
            temperature: 0.7,
            top_p: 0.9,
            messages: [{ role: "user", content: "test" }],
          }),
        },
      );
      assert.equal(response.status, 200);
      const request = upstreamRequests.at(-1);
      assert.equal(request.headers.authorization, "Bearer TEST_ZAI_API_KEY");
      assert.equal(request.headers["chatgpt-account-id"], undefined);
      assert.equal(request.headers["x-codex-installation-id"], undefined);
      assert.equal(request.body.model, upstreamModel);
      assert.deepEqual(request.body.thinking, { type: "enabled" });
      assert.equal(request.body.reasoning_effort, expectedEffort);
      assert.equal(request.body.temperature, undefined);
      assert.equal(request.body.top_p, undefined);
    }
  } finally {
    await stopChild(forwarder);
    await closeServer(upstream.server);
  }
});

test("API forwarder routes Grok 4.5 with supported xAI reasoning effort", async () => {
  const upstreamRequests = [];
  const upstream = await mockServer(async (request, response) => {
    upstreamRequests.push({ headers: request.headers, body: await bodyJson(request) });
    json(response, 200, { choices: [] });
  });
  const forwarderPort = await openPort();
  const forwarder = run("api-forwarder.mjs", {
    CODEX_ROUTER_API_PORT: String(forwarderPort),
    XAI_API_BASE_URL: `http://127.0.0.1:${upstream.port}/v1`,
    XAI_API_KEY: "TEST_XAI_API_KEY",
    CODEX_ROUTER_QUIET: "1",
  });

  try {
    await waitFor(`http://127.0.0.1:${forwarderPort}/health`, forwarder, {
      Authorization: `Bearer ${INTERNAL_KEY}`,
    });
    const response = await fetch(
      `http://127.0.0.1:${forwarderPort}/v1/chat/completions`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${INTERNAL_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "grok-api-grok-4-5",
          reasoning_effort: "ultra",
          presence_penalty: 0.2,
          frequency_penalty: 0.1,
          stop: ["done"],
          messages: [{ role: "user", content: "test" }],
        }),
      },
    );
    assert.equal(response.status, 200);
    const request = upstreamRequests[0];
    assert.equal(request.headers.authorization, "Bearer TEST_XAI_API_KEY");
    assert.equal(request.body.model, "grok-4.5");
    assert.equal(request.body.reasoning_effort, "high");
    assert.equal(request.body.presence_penalty, undefined);
    assert.equal(request.body.frequency_penalty, undefined);
    assert.equal(request.body.stop, undefined);
  } finally {
    await stopChild(forwarder);
    await closeServer(upstream.server);
  }
});

test("API forwarder isolates Anthropic credentials on the native Messages route", async () => {
  const upstreamRequests = [];
  const upstream = await mockServer(async (request, response) => {
    upstreamRequests.push({
      url: request.url,
      headers: request.headers,
      body: await bodyJson(request),
    });
    json(response, 200, {
      id: "msg_test",
      type: "message",
      role: "assistant",
      model: "claude-opus-4-8",
      content: [{ type: "text", text: "ANTHROPIC_ROUTE_OK" }],
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: { input_tokens: 4, output_tokens: 3 },
    });
  });
  const forwarderPort = await openPort();
  const forwarder = run("api-forwarder.mjs", {
    CODEX_ROUTER_API_PORT: String(forwarderPort),
    ANTHROPIC_API_BASE_URL: `http://127.0.0.1:${upstream.port}/v1`,
    ANTHROPIC_API_KEY: "TEST_ANTHROPIC_API_KEY",
    CODEX_ROUTER_QUIET: "1",
  });

  try {
    await waitFor(`http://127.0.0.1:${forwarderPort}/health`, forwarder, {
      Authorization: `Bearer ${INTERNAL_KEY}`,
    });
    const response = await fetch(
      `http://127.0.0.1:${forwarderPort}/v1/messages`,
      {
        method: "POST",
        headers: {
          "x-api-key": INTERNAL_KEY,
          "anthropic-version": "2023-06-01",
          "ChatGPT-Account-Id": "must-not-forward",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "anthropic-api-claude-opus-4-8",
          max_tokens: 64,
          reasoning_effort: "xhigh",
          messages: [{ role: "user", content: "test" }],
        }),
      },
    );
    assert.equal(response.status, 200);
    const request = upstreamRequests[0];
    assert.equal(request.url, "/v1/messages");
    assert.equal(request.headers.authorization, undefined);
    assert.equal(request.headers["x-api-key"], "TEST_ANTHROPIC_API_KEY");
    assert.equal(request.headers["anthropic-version"], "2023-06-01");
    assert.equal(request.headers["chatgpt-account-id"], undefined);
    assert.equal(request.body.model, "claude-opus-4-8");
    assert.equal(request.body.reasoning_effort, undefined);
    assert.deepEqual(request.body.thinking, { type: "adaptive" });
    // The picker's effort passes through to output_config (documented ladder
    // low/medium/high/xhigh/max); the integration test covers the high
    // fallback for unrecognized values.
    assert.deepEqual(request.body.output_config, { effort: "xhigh" });
  } finally {
    await stopChild(forwarder);
    await closeServer(upstream.server);
  }
});

test("API forwarder routes opencode Go chat, Messages, and Responses surfaces", async () => {
  const upstreamRequests = [];
  const upstream = await mockServer(async (request, response) => {
    upstreamRequests.push({
      url: request.url,
      headers: request.headers,
      body: await bodyJson(request),
    });
    if (request.url.endsWith("/messages")) {
      json(response, 200, {
        id: "msg_opencode_go",
        type: "message",
        role: "assistant",
        model: "minimax-m3",
        content: [{ type: "text", text: "MESSAGES_OK" }],
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: { input_tokens: 2, output_tokens: 2 },
      });
      return;
    }
    if (request.url.endsWith("/responses")) {
      json(response, 200, {
        id: "resp_opencode_go",
        object: "response",
        created_at: 1,
        status: "completed",
        model: "gpt-5.6-luna",
        output: [],
        usage: { input_tokens: 2, output_tokens: 2, total_tokens: 4 },
      });
      return;
    }
    json(response, 200, {
      id: "chatcmpl_opencode_go",
      object: "chat.completion",
      model: "mimo-v2.5",
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: "CHAT_OK" },
          finish_reason: "stop",
        },
      ],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    });
  });
  const forwarderPort = await openPort();
  const forwarder = run("api-forwarder.mjs", {
    CODEX_ROUTER_API_PORT: String(forwarderPort),
    OPENCODE_GO_BASE_URL: `http://127.0.0.1:${upstream.port}/v1`,
    // The forwarder resolves OPENCODE_API_KEY before OPENCODE_GO_API_KEY, and
    // run() inherits the developer's real key from process.env. Pin both to
    // the sentinel so the test never asserts against (or prints) a real key.
    OPENCODE_API_KEY: "TEST_OPENCODE_GO_API_KEY",
    OPENCODE_GO_API_KEY: "TEST_OPENCODE_GO_API_KEY",
    CODEX_ROUTER_QUIET: "1",
  });

  try {
    await waitFor(`http://127.0.0.1:${forwarderPort}/health`, forwarder, {
      Authorization: `Bearer ${INTERNAL_KEY}`,
    });

    const chat = await fetch(
      `http://127.0.0.1:${forwarderPort}/v1/chat/completions`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${INTERNAL_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "opencode-go-mimo-v2-5",
          messages: [{ role: "user", content: "test" }],
        }),
      },
    );
    assert.equal(chat.status, 200);
    assert.equal(upstreamRequests[0].url, "/v1/chat/completions");
    assert.equal(upstreamRequests[0].body.model, "mimo-v2.5");
    assert.equal(
      upstreamRequests[0].headers.authorization,
      "Bearer TEST_OPENCODE_GO_API_KEY",
    );

    const messages = await fetch(
      `http://127.0.0.1:${forwarderPort}/v1/messages`,
      {
        method: "POST",
        headers: {
          "x-api-key": INTERNAL_KEY,
          "anthropic-version": "2023-06-01",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "opencode-go-messages-minimax-m3",
          max_tokens: 64,
          messages: [{ role: "user", content: "test" }],
        }),
      },
    );
    assert.equal(messages.status, 200);
    assert.equal(upstreamRequests[1].url, "/v1/messages");
    assert.equal(upstreamRequests[1].body.model, "minimax-m3");
    assert.equal(
      upstreamRequests[1].headers["x-api-key"],
      "TEST_OPENCODE_GO_API_KEY",
    );
    assert.equal(upstreamRequests[1].headers.authorization, undefined);

    const responses = await fetch(
      `http://127.0.0.1:${forwarderPort}/v1/responses`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${INTERNAL_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "responses/opencode-go-responses-gpt-5-6-luna",
          input: "test",
          stream: false,
        }),
      },
    );
    assert.equal(responses.status, 200);
    assert.equal(upstreamRequests[2].url, "/v1/responses");
    assert.equal(upstreamRequests[2].body.model, "gpt-5.6-luna");
    assert.equal(
      upstreamRequests[2].headers.authorization,
      "Bearer TEST_OPENCODE_GO_API_KEY",
    );
  } finally {
    await stopChild(forwarder);
    await closeServer(upstream.server);
  }
});

test("API forwarder routes Command Code chat and Messages surfaces", async () => {
  const upstreamRequests = [];
  const upstream = await mockServer(async (request, response) => {
    upstreamRequests.push({
      url: request.url,
      headers: request.headers,
      body: await bodyJson(request),
    });
    if (request.url.endsWith("/messages")) {
      json(response, 200, {
        id: "msg_commandcode",
        type: "message",
        role: "assistant",
        model: "claude-opus-4-8",
        content: [{ type: "text", text: "MESSAGES_OK" }],
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: { input_tokens: 2, output_tokens: 2 },
      });
      return;
    }
    json(response, 200, {
      id: "chatcmpl_commandcode",
      object: "chat.completion",
      model: "deepseek/deepseek-v4-flash",
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: "CHAT_OK" },
          finish_reason: "stop",
        },
      ],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    });
  });
  const forwarderPort = await openPort();
  const forwarder = run("api-forwarder.mjs", {
    CODEX_ROUTER_API_PORT: String(forwarderPort),
    COMMANDCODE_BASE_URL: `http://127.0.0.1:${upstream.port}/v1`,
    COMMAND_CODE_API_KEY: "TEST_COMMANDCODE_API_KEY",
    CODEX_ROUTER_QUIET: "1",
  });

  try {
    await waitFor(`http://127.0.0.1:${forwarderPort}/health`, forwarder, {
      Authorization: `Bearer ${INTERNAL_KEY}`,
    });

    const chat = await fetch(
      `http://127.0.0.1:${forwarderPort}/v1/chat/completions`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${INTERNAL_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "commandcode-deepseek-v4-flash",
          messages: [{ role: "user", content: "test" }],
        }),
      },
    );
    assert.equal(chat.status, 200);
    assert.equal(upstreamRequests[0].url, "/v1/chat/completions");
    assert.equal(upstreamRequests[0].body.model, "deepseek/deepseek-v4-flash");
    assert.equal(
      upstreamRequests[0].headers.authorization,
      "Bearer TEST_COMMANDCODE_API_KEY",
    );

    const messages = await fetch(
      `http://127.0.0.1:${forwarderPort}/v1/messages`,
      {
        method: "POST",
        headers: {
          "x-api-key": INTERNAL_KEY,
          "anthropic-version": "2023-06-01",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "commandcode-messages-claude-opus-4-8",
          max_tokens: 64,
          messages: [{ role: "user", content: "test" }],
        }),
      },
    );
    assert.equal(messages.status, 200);
    assert.equal(upstreamRequests[1].url, "/v1/messages");
    assert.equal(upstreamRequests[1].body.model, "claude-opus-4-8");
    assert.equal(
      upstreamRequests[1].headers["x-api-key"],
      "TEST_COMMANDCODE_API_KEY",
    );
    assert.equal(upstreamRequests[1].headers.authorization, undefined);
  } finally {
    await stopChild(forwarder);
    await closeServer(upstream.server);
  }
});

test("router strips empty text parts and drops the messages left with nothing", async () => {
  const gatewayRequests = [];
  const gateway = await mockServer(async (request, response) => {
    gatewayRequests.push(await bodyJson(request));
    json(response, 200, { route: "external" });
  });
  const native = await mockServer(async (_request, response) => {
    json(response, 200, { id: "unused", output: [] });
  });
  const routerPort = await openPort();
  const router = run("router.mjs", {
    CODEX_ROUTER_PORT: String(routerPort),
    CODEX_NATIVE_BASE_URL: `http://127.0.0.1:${native.port}/backend-api/codex`,
    CODEX_ROUTER_GATEWAY_BASE_URL: `http://127.0.0.1:${gateway.port}/v1`,
    CODEX_ROUTER_QUIET: "1",
  });

  try {
    await waitFor(`${routerBase(routerPort)}/models`, router);
    const response = await fetch(`${routerBase(routerPort)}/responses`, {
      method: "POST",
      headers: {
        Authorization: "Bearer CHATGPT_SESSION_TOKEN",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "kimi-oauth/k3",
        stream: false,
        input: [
          // Codex emits these filler assistant turns around tool calls.
          { type: "message", role: "assistant", content: [{ type: "output_text", text: "   " }] },
          {
            type: "message",
            role: "user",
            content: [
              { type: "input_text", text: "" },
              { type: "input_text", text: "real question" },
            ],
          },
          { type: "function_call", name: "shell", arguments: "{}" },
        ],
      }),
    });

    assert.equal(response.status, 200, await response.text());
    assert.equal(gatewayRequests.length, 1);
    const forwarded = gatewayRequests[0].input;

    // The whitespace-only assistant message carries nothing once stripped.
    assert.equal(forwarded.length, 2);
    assert.ok(!forwarded.some((item) => item.role === "assistant"));

    // A message keeps its real text and loses only the empty part.
    const user = forwarded.find((item) => item.role === "user");
    assert.deepEqual(user.content, [{ type: "input_text", text: "real question" }]);

    // Non-message items are never touched.
    assert.equal(forwarded.at(-1).type, "function_call");

    // Nothing empty survives anywhere.
    for (const item of forwarded) {
      if (!Array.isArray(item.content)) continue;
      for (const part of item.content) {
        if (typeof part?.text === "string") assert.notEqual(part.text.trim(), "");
      }
    }
  } finally {
    await stopChild(router);
    await closeServer(gateway.server);
    await closeServer(native.server);
  }
});

function curatedFireworksModel() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "routing-fireworks-model-"));
  const file = path.join(dir, "user-models.json");
  writeFileSync(
    file,
    JSON.stringify({
      version: 1,
      models: [
        {
          slug: "fireworks/test-model",
          gatewayModel: "fireworks-test-model",
          upstreamModel: "accounts/fireworks/models/test-model",
          provider: "fireworks",
          listed: true,
          displayName: "Fireworks Test Model",
          description: "Test fixture.",
          priority: 500,
          defaultEffort: "high",
          reasoningLevels: [{ effort: "high", description: "Adaptive reasoning" }],
          contextWindow: 131072,
          autoCompact: 110000,
          inputModalities: ["text"],
          compHash: "fireworks-test-model-user-v1",
        },
      ],
    }),
    "utf8",
  );
  return { dir, file, gatewayModel: "fireworks-test-model" };
}

test("API forwarder strips web_search_options for Fireworks", async () => {
  const upstreamRequests = [];
  const upstream = await mockServer(async (request, response) => {
    upstreamRequests.push(await bodyJson(request));
    json(response, 200, { choices: [] });
  });
  const curated = curatedFireworksModel();
  const forwarderPort = await openPort();
  const forwarder = run("api-forwarder.mjs", {
    CODEX_ROUTER_API_PORT: String(forwarderPort),
    MODEL_ROUTER_USER_MODELS: curated.file,
    FIREWORKS_API_BASE_URL: `http://127.0.0.1:${upstream.port}/v1`,
    FIREWORKS_API_KEY: "TEST_FIREWORKS_API_KEY",
    CODEX_ROUTER_QUIET: "1",
  });

  try {
    await waitFor(`http://127.0.0.1:${forwarderPort}/health`, forwarder, {
      Authorization: `Bearer ${INTERNAL_KEY}`,
    });
    const response = await fetch(
      `http://127.0.0.1:${forwarderPort}/v1/chat/completions`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${INTERNAL_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: curated.gatewayModel,
          web_search_options: { search_context_size: "medium" },
          client_metadata: { workspace: "caller-owned" },
          messages: [{ role: "user", content: "test" }],
        }),
      },
    );
    assert.equal(response.status, 200, forwarder.testErrors());
    assert.equal(upstreamRequests[0].model, "accounts/fireworks/models/test-model");
    assert.equal(upstreamRequests[0].web_search_options, undefined);
    assert.equal(upstreamRequests[0].client_metadata, undefined);
  } finally {
    await stopChild(forwarder);
    await closeServer(upstream.server);
    rmSync(curated.dir, { recursive: true, force: true });
  }
});

test("router strips Fireworks web_search_options on routed and compaction requests", async () => {
  const gatewayRequests = [];
  const gateway = await mockServer(async (request, response) => {
    gatewayRequests.push(await bodyJson(request));
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
  const curated = curatedFireworksModel();
  const routerPort = await openPort();
  const router = run("router.mjs", {
    CODEX_ROUTER_PORT: String(routerPort),
    MODEL_ROUTER_USER_MODELS: curated.file,
    CODEX_ROUTER_GATEWAY_BASE_URL: `http://127.0.0.1:${gateway.port}/v1`,
    CODEX_ROUTER_QUIET: "1",
  });
  const headers = {
    Authorization: `Bearer ${CALLER_KEY}`,
    "Content-Type": "application/json",
  };

  try {
    await waitFor(`${routerBase(routerPort)}/models`, router);
    const routed = await fetch(`${routerBase(routerPort)}/responses`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: "fireworks/test-model",
        input: "routed test",
        web_search_options: { search_context_size: "medium" },
        client_metadata: { workspace: "caller-owned" },
      }),
    });
    assert.equal(routed.status, 200, router.testErrors());
    assert.equal(gatewayRequests[0].model, curated.gatewayModel);
    assert.equal(gatewayRequests[0].web_search_options, undefined);
    assert.equal(gatewayRequests[0].client_metadata, undefined);

    const compact = await fetch(`${routerBase(routerPort)}/responses/compact`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: "fireworks/test-model",
        input: [
          {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "keep me" }],
          },
        ],
        web_search_options: { search_context_size: "medium" },
        client_metadata: { workspace: "caller-owned" },
      }),
    });
    assert.equal(compact.status, 200, router.testErrors());
    assert.equal(gatewayRequests[1].model, curated.gatewayModel);
    assert.equal(gatewayRequests[1].web_search_options, undefined);
    assert.equal(gatewayRequests[1].client_metadata, undefined);
  } finally {
    await stopChild(router);
    await closeServer(gateway.server);
    rmSync(curated.dir, { recursive: true, force: true });
  }
});

test("router normalizes forced tool choices before LiteLLM for auto-tool-choice models", async () => {
  const gatewayRequests = [];
  const gateway = await mockServer(async (request, response) => {
    gatewayRequests.push(await bodyJson(request));
    json(response, 200, { id: "resp_test", object: "response", output: [] });
  });
  const routerPort = await openPort();
  const router = run("router.mjs", {
    CODEX_ROUTER_PORT: String(routerPort),
    CODEX_ROUTER_GATEWAY_BASE_URL: `http://127.0.0.1:${gateway.port}/v1`,
    CODEX_ROUTER_QUIET: "1",
  });
  const headers = {
    Authorization: `Bearer ${CALLER_KEY}`,
    "Content-Type": "application/json",
  };

  async function route(model, toolChoice) {
    const response = await fetch(`${routerBase(routerPort)}/responses`, {
      method: "POST",
      headers,
      body: JSON.stringify({ model, input: "test", tool_choice: toolChoice }),
    });
    assert.equal(response.status, 200, router.testErrors());
    return gatewayRequests.at(-1);
  }

  try {
    await waitFor(`${routerBase(routerPort)}/models`, router);

    // LiteLLM does its Responses -> Chat Completions translation after the
    // router, so this must already be auto when it reaches the gateway.
    const required = await route("ollama-cloud/minimax-m3", "required");
    assert.equal(required.model, "ollama-cloud-minimax-m3");
    assert.equal(required.tool_choice, "auto");

    // The collaboration relay uses an object form; it has the same upstream
    // restriction and therefore must not survive the Responses hop either.
    const forcedFunction = await route("ollama-cloud/minimax-m3", {
      type: "function",
      name: "relay_external_agent_payload",
    });
    assert.equal(forcedFunction.tool_choice, "auto");

    // Suppressing tools is not forcing one, and remains necessary for turns
    // such as compaction that deliberately disable tools.
    const suppressed = await route("ollama-cloud/minimax-m3", "none");
    assert.equal(suppressed.tool_choice, "none");

    const absent = await route("ollama-cloud/minimax-m3");
    assert.equal("tool_choice" in absent, false);

    // The profile remains model-scoped: other Ollama Cloud models preserve a
    // forced choice so their capability probe and collaboration relay work.
    const sibling = await route("ollama-cloud/glm-5.2", "required");
    assert.equal(sibling.tool_choice, "required");
  } finally {
    await stopChild(router);
    await closeServer(gateway.server);
  }
});

test("router redirects native background turns to the configured routed model", async () => {
  const gatewayRequests = [];
  const gateway = await mockServer(async (request, response) => {
    gatewayRequests.push(await bodyJson(request));
    json(response, 200, { route: "external" });
  });
  const routerPort = await openPort();
  const testRoot = mkdtempSync(path.join(os.tmpdir(), "codex-router-native-redirect-"));
  const stateDir = path.join(testRoot, "state");
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(
    path.join(stateDir, "native-redirect.json"),
    `${JSON.stringify({ version: 1, model: "kimi-oauth/k3" })}\n`,
  );
  const router = run("router.mjs", {
    CODEX_ROUTER_PORT: String(routerPort),
    CODEX_ROUTER_GATEWAY_BASE_URL: `http://127.0.0.1:${gateway.port}/v1`,
    CODEX_ROUTER_STATE_DIR: stateDir,
    CODEX_ROUTER_QUIET: "1",
  });

  try {
    await waitFor(`${routerBase(routerPort)}/models`, router);
    const response = await fetch(`${routerBase(routerPort)}/responses`, {
      method: "POST",
      headers: {
        Authorization: "Bearer CODEX_CALLER_SECRET",
        "Content-Type": "application/json",
      },
      // The shape Codex Desktop uses for background agent sessions: a native
      // GPT slug the picker never chose.
      body: JSON.stringify({ model: "gpt-5.6-luna", input: "background turn" }),
    });
    assert.equal(response.status, 200);
    assert.equal(gatewayRequests.at(-1).model, "kimi-oauth-k3");
  } finally {
    await stopChild(router);
    await closeServer(gateway.server);
    rmSync(testRoot, { recursive: true, force: true });
  }
});

test("native redirect falls back to native when the target cannot route", async () => {
  const nativeRequests = [];
  const native = await mockServer(async (request, response) => {
    nativeRequests.push(await bodyJson(request));
    json(response, 200, { route: "native" });
  });
  const routerPort = await openPort();
  const testRoot = mkdtempSync(path.join(os.tmpdir(), "codex-router-native-redirect-off-"));
  const stateDir = path.join(testRoot, "state");
  mkdirSync(stateDir, { recursive: true });
  // A redirect target that is not in the registry must leave native traffic
  // untouched instead of failing the request.
  writeFileSync(
    path.join(stateDir, "native-redirect.json"),
    `${JSON.stringify({ version: 1, model: "not-a-registered/model" })}\n`,
  );
  const router = run("router.mjs", {
    CODEX_ROUTER_PORT: String(routerPort),
    CODEX_NATIVE_BASE_URL: `http://127.0.0.1:${native.port}/backend-api/codex`,
    CODEX_ROUTER_GATEWAY_BASE_URL: "http://127.0.0.1:9/v1",
    CODEX_ROUTER_STATE_DIR: stateDir,
    CODEX_ROUTER_QUIET: "1",
  });

  try {
    await waitFor(`${routerBase(routerPort)}/models`, router);
    const response = await fetch(`${routerBase(routerPort)}/responses`, {
      method: "POST",
      headers: {
        Authorization: "Bearer CODEX_CALLER_SECRET",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ model: "gpt-5.6-luna", input: "background turn" }),
    });
    assert.equal(response.status, 200);
    assert.equal(nativeRequests.at(-1).model, "gpt-5.6-luna");
  } finally {
    await stopChild(router);
    await closeServer(native.server);
    rmSync(testRoot, { recursive: true, force: true });
  }
});

function usageEvents(stateDir) {
  const file = path.join(stateDir, "usage-events.jsonl");
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

// The router meters after it has already answered the client, so the fetch can
// resolve before the event reaches disk. Poll rather than sleep.
async function waitForUsageEvents(stateDir, count, child) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const events = usageEvents(stateDir);
    if (events.length >= count) return events;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for ${count} usage events: ${child.testErrors()}`);
}

async function waitForStderr(child, pattern) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (pattern.test(child.testErrors())) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for ${pattern}: ${child.testErrors()}`);
}

// A routed compaction that leaves no usage event and no log line is invisible:
// nothing in the router's own telemetry can answer "was compaction even
// attempted?", which is what made issue #95 slow to diagnose.
test("routed compaction records usage and logs on success and on failure", async () => {
  let failing = false;
  const gateway = await mockServer(async (request, response) => {
    await bodyJson(request);
    if (failing) {
      json(response, 502, { error: { message: "provider refused the compaction" } });
      return;
    }
    json(response, 200, {
      id: "resp-summary",
      object: "response",
      output: [
        { type: "message", content: [{ type: "output_text", text: "compact summary" }] },
      ],
      usage: { input_tokens: 1234, output_tokens: 56, total_tokens: 1290 },
    });
  });
  const stateDir = mkdtempSync(path.join(os.tmpdir(), "routing-compaction-usage-"));
  const routerPort = await openPort();
  // QUIET stays off here: the log line is half of what this test asserts.
  const router = run("router.mjs", {
    CODEX_ROUTER_PORT: String(routerPort),
    CODEX_ROUTER_GATEWAY_BASE_URL: `http://127.0.0.1:${gateway.port}/v1`,
    MODEL_ROUTER_STATE_DIR: stateDir,
  });
  const headers = {
    Authorization: "Bearer CODEX_CALLER_SECRET",
    "Content-Type": "application/json",
  };
  const body = JSON.stringify({
    model: "deepseek/deepseek-v4-pro",
    input: [
      { type: "message", role: "user", content: [{ type: "input_text", text: "keep me" }] },
    ],
  });

  try {
    await waitFor(`${routerBase(routerPort)}/models`, router);

    const ok = await fetch(`${routerBase(routerPort)}/responses/compact`, {
      method: "POST",
      headers,
      body,
    });
    assert.equal(ok.status, 200, await ok.text());
    const [success] = await waitForUsageEvents(stateDir, 1, router);
    assert.equal(success.model, "deepseek/deepseek-v4-pro");
    assert.equal(success.provider, "deepseek");
    assert.equal(success.status, 200);
    assert.equal(success.inputTokens, 1234);
    assert.equal(success.outputTokens, 56);
    assert.equal(success.totalTokens, 1290);
    await waitForStderr(
      router,
      /\[codex-router\] model=deepseek\/deepseek-v4-pro provider=deepseek status=200/,
    );

    failing = true;
    const failed = await fetch(`${routerBase(routerPort)}/responses/compact`, {
      method: "POST",
      headers,
      body,
    });
    assert.equal(failed.status, 502);
    const events = await waitForUsageEvents(stateDir, 2, router);
    const failure = events.at(-1);
    assert.equal(failure.model, "deepseek/deepseek-v4-pro");
    assert.equal(failure.provider, "deepseek");
    assert.equal(failure.status, 502);
    // A failed compaction reports no tokens at all rather than zeros, which
    // would be indistinguishable from the zero-token accounting behind #95.
    assert.equal("inputTokens" in failure, false);
    assert.equal("outputTokens" in failure, false);
    assert.equal("totalTokens" in failure, false);
    await waitForStderr(
      router,
      /\[codex-router\] model=deepseek\/deepseek-v4-pro provider=deepseek status=502/,
    );
  } finally {
    await stopChild(router);
    await closeServer(gateway.server);
    rmSync(stateDir, { recursive: true, force: true });
  }
});

// AGENTS.md requires the same collaboration handling on `/responses` and
// `/responses/compact` alike. Compaction replays the whole conversation, so a
// `/goal` or subagent session compacting through a routed model would otherwise
// summarize opaque payloads.
test("routed compaction resolves subagent handoffs before summarizing", async () => {
  const nativeRequests = [];
  const native = await mockServer(async (request, response) => {
    nativeRequests.push({ headers: request.headers, body: await bodyJson(request) });
    const relayArguments = JSON.stringify({ payload: "Review the routed diff." });
    const events = [
      {
        type: "response.output_item.added",
        item: {
          type: "function_call",
          id: "fc_relay",
          name: "relay_external_agent_payload",
          arguments: "",
        },
      },
      {
        type: "response.function_call_arguments.done",
        item_id: "fc_relay",
        arguments: relayArguments,
      },
    ];
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    response.end(
      `${events
        .map((entry) => `event: ${entry.type}\ndata: ${JSON.stringify(entry)}\n\n`)
        .join("")}data: [DONE]\n\n`,
    );
  });
  const gatewayRequests = [];
  const gateway = await mockServer(async (request, response) => {
    gatewayRequests.push(await bodyJson(request));
    json(response, 200, {
      id: "resp-summary",
      object: "response",
      output: [
        { type: "message", content: [{ type: "output_text", text: "compact summary" }] },
      ],
    });
  });
  const routerPort = await openPort();
  const router = run("router.mjs", {
    CODEX_ROUTER_PORT: String(routerPort),
    CODEX_NATIVE_BASE_URL: `http://127.0.0.1:${native.port}/backend-api/codex`,
    CODEX_ROUTER_GATEWAY_BASE_URL: `http://127.0.0.1:${gateway.port}/v1`,
    CODEX_ROUTER_QUIET: "1",
  });

  try {
    await waitFor(`${routerBase(routerPort)}/models`, router);
    const response = await fetch(`${routerBase(routerPort)}/responses/compact`, {
      method: "POST",
      headers: {
        Authorization: "Bearer CHATGPT_SESSION_TOKEN",
        "ChatGPT-Account-Id": "account-id",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "kimi-oauth/k3",
        input: [
          {
            type: "agent_message",
            id: "amsg_routed",
            author: "/root",
            recipient: "/root/critic",
            content: [
              {
                type: "input_text",
                text: "Message Type: NEW_TASK\nTask name: /root/critic\nSender: /root\nPayload:\n",
              },
              {
                type: "encrypted_content",
                encrypted_content: "Summarize the routed subagent handoff.",
              },
            ],
          },
          {
            type: "agent_message",
            id: "amsg_native",
            author: "/root",
            recipient: "/root/critic",
            content: [
              { type: "input_text", text: "Message Type: MESSAGE\nSender: /root\nPayload:\n" },
              { type: "encrypted_content", encrypted_content: "gAAAAA-test-payload=" },
            ],
          },
        ],
      }),
    });
    assert.equal(response.status, 200, await response.text());
    assert.equal(gatewayRequests.length, 1);
    const sent = gatewayRequests[0].input;

    const routed = sent.find((item) => item?.id === "amsg_routed");
    assert.equal(routed.content.some((part) => part.type === "encrypted_content"), false);
    assert.equal(routed.content.at(-1).type, "input_text");
    assert.equal(routed.content.at(-1).text, "Summarize the routed subagent handoff.");

    // The Fernet-shaped payload proves the request itself is threaded through:
    // resolving it needs the caller's native session for the relay.
    const relayed = sent.find((item) => item?.id === "amsg_native");
    assert.equal(relayed.content.some((part) => part.type === "encrypted_content"), false);
    assert.equal(relayed.content.at(-1).text, "Review the routed diff.");
    assert.equal(nativeRequests.length, 1);
    assert.equal(nativeRequests[0].headers.authorization, "Bearer CHATGPT_SESSION_TOKEN");
  } finally {
    await stopChild(router);
    await Promise.all([closeServer(native.server), closeServer(gateway.server)]);
  }
});

// Issue #95: opencode's Go endpoint reports `input_tokens: 0` for its DeepSeek
// V4 models, so Codex's context counter never climbs, auto-compaction never
// fires, and the provider eventually rejects the turn at its real limit. Codex
// reads that number out of `response.completed`, so a router that only logged
// the problem would not fix it -- the substituted count has to reach the client.
test("router substitutes a prompt-token estimate a provider reported as zero", async () => {
  let reportedInputTokens = 0;
  const gatewayBodies = [];
  const gateway = await mockServer(async (request, response) => {
    gatewayBodies.push(await bodyJson(request));
    const completed = {
      type: "response.completed",
      response: {
        id: "resp_routed",
        usage: {
          input_tokens: reportedInputTokens,
          output_tokens: 12,
          total_tokens: reportedInputTokens + 12,
        },
      },
    };
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    response.end(
      `event: response.output_text.delta\ndata: ${JSON.stringify({ type: "response.output_text.delta", delta: "ok" })}\n\n` +
        `event: response.completed\ndata: ${JSON.stringify(completed)}\n\ndata: [DONE]\n\n`,
    );
  });
  const stateDir = mkdtempSync(path.join(os.tmpdir(), "routing-zero-input-"));
  const routerPort = await openPort();
  // QUIET stays off: the log line is part of what makes a substitution visible.
  const router = run("router.mjs", {
    CODEX_ROUTER_PORT: String(routerPort),
    CODEX_ROUTER_GATEWAY_BASE_URL: `http://127.0.0.1:${gateway.port}/v1`,
    MODEL_ROUTER_STATE_DIR: stateDir,
  });
  const headers = {
    Authorization: "Bearer CODEX_CALLER_SECRET",
    "Content-Type": "application/json",
  };
  const conversation = "the quick brown fox jumps over the lazy dog. ".repeat(1_000);
  const body = JSON.stringify({
    model: "opencode-go/deepseek-v4-flash",
    input: [
      { type: "message", role: "user", content: [{ type: "input_text", text: conversation }] },
    ],
  });

  try {
    await waitFor(`${routerBase(routerPort)}/models`, router);

    const zero = await fetch(`${routerBase(routerPort)}/responses`, {
      method: "POST",
      headers,
      body,
    });
    assert.equal(zero.status, 200);
    const streamed = await zero.text();
    const completed = JSON.parse(
      streamed
        .split("\n")
        .find((line) => line.startsWith("data:") && line.includes("response.completed"))
        .slice(5),
    );
    // What Codex now reads is an estimate of the prompt it actually sent,
    // erring high: never below the familiar four-bytes-per-token figure, and
    // never above the densest plausible three.
    const estimate = completed.response.usage.input_tokens;
    assert.ok(estimate >= Math.ceil(conversation.length / 4), `estimate ${estimate} too low`);
    assert.ok(estimate <= Math.ceil((conversation.length + 2_000) / 3), `estimate ${estimate} too high`);
    assert.equal(completed.response.usage.total_tokens, estimate + 12);

    const [substituted] = await waitForUsageEvents(stateDir, 1, router);
    assert.equal(substituted.model, "opencode-go/deepseek-v4-flash");
    // The telemetry keeps the provider's own zero and records the estimate
    // beside it, so nothing here can be mistaken for the provider recovering.
    assert.equal(substituted.inputTokens, 0);
    assert.equal(substituted.outputTokens, 12);
    assert.equal(substituted.estimatedInputTokens, estimate);
    await waitForStderr(router, new RegExp(`estimated-input-tokens=${estimate}\\b`));

    // Exercise the router's real route metadata, not just the estimator in
    // isolation: an accepted request can never be reported above the model's
    // declared context window.
    const contextWindow = 1_048_576;
    const oversizedBody = JSON.stringify({
      model: "opencode-go/deepseek-v4-flash",
      input: [
        {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "x".repeat(contextWindow * 4) }],
        },
      ],
    });
    const capped = await fetch(`${routerBase(routerPort)}/responses`, {
      method: "POST",
      headers,
      body: oversizedBody,
    });
    assert.equal(capped.status, 200);
    const cappedCompleted = JSON.parse(
      (await capped.text())
        .split("\n")
        .find((line) => line.startsWith("data:") && line.includes("response.completed"))
        .slice(5),
    );
    assert.equal(cappedCompleted.response.usage.input_tokens, contextWindow);
    const cappedEvents = await waitForUsageEvents(stateDir, 2, router);
    assert.equal(cappedEvents.at(-1).estimatedInputTokens, contextWindow);

    // A provider that reports correctly is left alone on the very same route.
    reportedInputTokens = 4_321;
    const reported = await fetch(`${routerBase(routerPort)}/responses`, {
      method: "POST",
      headers,
      body,
    });
    assert.equal(reported.status, 200);
    assert.match(await reported.text(), /"input_tokens":4321/);
    const events = await waitForUsageEvents(stateDir, 3, router);
    const honest = events.at(-1);
    assert.equal(honest.inputTokens, 4_321);
    assert.equal("estimatedInputTokens" in honest, false);
    assert.equal(router.testErrors().match(/estimated-input-tokens=/g).length, 2);
    assert.equal(gatewayBodies.length, 3);
  } finally {
    await stopChild(router);
    await closeServer(gateway.server);
    rmSync(stateDir, { recursive: true, force: true });
  }
});

// Inventing token counts is a heuristic, however tightly gated, so an operator
// has to be able to see the provider's own numbers again without downgrading.
test("the prompt-token estimate can be switched off", async () => {
  const gateway = await mockServer(async (request, response) => {
    await bodyJson(request);
    const completed = {
      type: "response.completed",
      response: {
        id: "resp_routed",
        usage: { input_tokens: 0, output_tokens: 12, total_tokens: 12 },
      },
    };
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    response.end(
      `event: response.output_text.delta\ndata: ${JSON.stringify({ type: "response.output_text.delta", delta: "ok" })}\n\n` +
        `event: response.completed\ndata: ${JSON.stringify(completed)}\n\ndata: [DONE]\n\n`,
    );
  });
  const stateDir = mkdtempSync(path.join(os.tmpdir(), "routing-zero-input-off-"));
  const routerPort = await openPort();
  const router = run("router.mjs", {
    CODEX_ROUTER_PORT: String(routerPort),
    CODEX_ROUTER_GATEWAY_BASE_URL: `http://127.0.0.1:${gateway.port}/v1`,
    CODEX_ROUTER_ZERO_INPUT_ESTIMATE: "0",
    CODEX_ROUTER_QUIET: "1",
    MODEL_ROUTER_STATE_DIR: stateDir,
  });

  try {
    await waitFor(`${routerBase(routerPort)}/models`, router);
    const response = await fetch(`${routerBase(routerPort)}/responses`, {
      method: "POST",
      headers: {
        Authorization: "Bearer CODEX_CALLER_SECRET",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "opencode-go/deepseek-v4-flash",
        input: [
          {
            type: "message",
            role: "user",
            content: [
              { type: "input_text", text: "the quick brown fox. ".repeat(2_000) },
            ],
          },
        ],
      }),
    });
    assert.equal(response.status, 200);
    assert.match(await response.text(), /"input_tokens":0/);
    const [event] = await waitForUsageEvents(stateDir, 1, router);
    assert.equal(event.inputTokens, 0);
    assert.equal("estimatedInputTokens" in event, false);
  } finally {
    await stopChild(router);
    await closeServer(gateway.server);
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("router ages consumed large tool results but preserves the newest result frontier", async () => {
  const gatewayBodies = [];
  const gateway = await mockServer(async (request, response) => {
    gatewayBodies.push(await bodyJson(request));
    json(response, 200, { output: [{ type: "message", role: "assistant", content: "ok" }] });
  });
  const stateDir = mkdtempSync(path.join(os.tmpdir(), "routing-tool-result-aging-"));
  // Aging is opt-in, so this test states the setting it is exercising rather
  // than relying on a default.
  writeFileSync(
    path.join(stateDir, "tool-result-aging.json"),
    JSON.stringify({ version: 1, enabled: true, nativeEnabled: false }),
  );
  const routerPort = await openPort();
  const router = run("router.mjs", {
    CODEX_ROUTER_PORT: String(routerPort),
    CODEX_ROUTER_GATEWAY_BASE_URL: `http://127.0.0.1:${gateway.port}/v1`,
    CODEX_ROUTER_QUIET: "1",
    MODEL_ROUTER_STATE_DIR: stateDir,
  });
  const large = `old-head\n${"old-middle\n".repeat(4_000)}old-tail`;
  const input = [
    { type: "function_call", call_id: "old", name: "exec_command", arguments: "{}" },
    { type: "function_call_output", call_id: "old", output: large },
    { type: "message", role: "assistant", content: "I acted on the old result." },
    ...Array.from({ length: 4 }, (_, index) => [
      { type: "function_call", call_id: `new-${index}`, name: "exec_command", arguments: "{}" },
      {
        type: "function_call_output",
        call_id: `new-${index}`,
        output: `${index}:${"n".repeat(34_000)}`,
      },
      { type: "message", role: "assistant", content: `used ${index}` },
    ]).flat(),
  ];

  try {
    await waitFor(`${routerBase(routerPort)}/models`, router);
    const response = await fetch(`${routerBase(routerPort)}/responses`, {
      method: "POST",
      headers: {
        Authorization: "Bearer CODEX_CALLER_SECRET",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ model: "deepseek/deepseek-v4-pro", stream: false, input }),
    });
    assert.equal(response.status, 200, await response.text());
    const forwarded = gatewayBodies[0].input;
    assert.match(forwarded[1].output, /Older tool result compacted by Codex Router/);
    assert.match(forwarded[1].output, /old-head/);
    assert.match(forwarded[1].output, /old-tail/);
    for (let index = 0; index < 4; index += 1) {
      const result = forwarded.find((item) => item.call_id === `new-${index}` && item.type === "function_call_output");
      assert.equal(result.output, `${index}:${"n".repeat(34_000)}`);
    }
    const [event] = await waitForUsageEvents(stateDir, 1, router);
    assert.equal(event.toolResultsAged, 1);
    assert.ok(event.toolResultBytesSaved > 30_000);

    // Settings are read for each routed request, so a UI toggle takes effect
    // without restarting the router or interrupting a running Codex task.
    writeFileSync(
      path.join(stateDir, "tool-result-aging.json"),
      `${JSON.stringify({ version: 1, enabled: false })}\n`,
      { mode: 0o600 },
    );
    const exactResponse = await fetch(`${routerBase(routerPort)}/responses`, {
      method: "POST",
      headers: {
        Authorization: "Bearer CODEX_CALLER_SECRET",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ model: "deepseek/deepseek-v4-pro", stream: false, input }),
    });
    assert.equal(exactResponse.status, 200, await exactResponse.text());
    assert.equal(gatewayBodies[1].input[1].output, large);
  } finally {
    await stopChild(router);
    await closeServer(gateway.server);
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("tool-result aging kill switch forwards the same large output", async () => {
  const gatewayBodies = [];
  const gateway = await mockServer(async (request, response) => {
    gatewayBodies.push(await bodyJson(request));
    json(response, 200, { output: [{ type: "message", role: "assistant", content: "ok" }] });
  });
  const routerPort = await openPort();
  const router = run("router.mjs", {
    CODEX_ROUTER_PORT: String(routerPort),
    CODEX_ROUTER_GATEWAY_BASE_URL: `http://127.0.0.1:${gateway.port}/v1`,
    CODEX_ROUTER_TOOL_RESULT_AGING: "0",
    CODEX_ROUTER_QUIET: "1",
  });
  const large = "x".repeat(40_000);
  const input = [
    { type: "function_call", call_id: "old", name: "exec_command", arguments: "{}" },
    { type: "function_call_output", call_id: "old", output: large },
    { type: "message", role: "assistant", content: "acted" },
  ];

  try {
    await waitFor(`${routerBase(routerPort)}/models`, router);
    const response = await fetch(`${routerBase(routerPort)}/responses`, {
      method: "POST",
      headers: {
        Authorization: "Bearer CODEX_CALLER_SECRET",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ model: "deepseek/deepseek-v4-pro", stream: false, input }),
    });
    assert.equal(response.status, 200, await response.text());
    assert.equal(gatewayBodies[0].input[1].output, large);
  } finally {
    await stopChild(router);
    await closeServer(gateway.server);
  }
});

test("an image a text-only model fetched with view_image never reaches the provider", async () => {
  // The shape that broke: a paste carries the image *and* its path as text, so
  // a text-only model calls Codex's `view_image` on the path and the tool
  // result comes back holding the same bytes again. The bridge read the
  // message and left the tool result alone, so the provider was handed a raw
  // data URL and rejected the entire conversation with a message that never
  // mentions an image ("unknown variant `image_url`, expected `text`").
  const dataUrl = "data:image/png;base64,AAAA";
  const gatewayRequests = [];
  const gateway = await mockServer(async (request, response) => {
    gatewayRequests.push(await bodyJson(request));
    json(response, 200, { route: "external" });
  });
  const native = await mockServer(async (_request, response) => {
    json(response, 200, { id: "unused", output: [] });
  });
  const visionCalls = [];
  const engine = await mockServer(async (request, response) => {
    visionCalls.push(await bodyJson(request));
    json(response, 200, {
      choices: [{ message: { content: "## Summary\nA login screen." } }],
    });
  });
  const stateDirectory = mkdtempSync(path.join(os.tmpdir(), "router-view-image-"));
  const bridgeState = path.join(stateDirectory, "vision-bridge.json");
  writeFileSync(
    bridgeState,
    `${JSON.stringify({
      version: 1,
      enabled: true,
      engine: "local",
      effort: null,
      local: { baseUrl: `http://127.0.0.1:${engine.port}/v1`, model: "moondream" },
    })}\n`,
    { mode: 0o600 },
  );
  const routerPort = await openPort();
  const router = run("router.mjs", {
    CODEX_ROUTER_PORT: String(routerPort),
    CODEX_NATIVE_BASE_URL: `http://127.0.0.1:${native.port}/backend-api/codex`,
    CODEX_ROUTER_GATEWAY_BASE_URL: `http://127.0.0.1:${gateway.port}/v1`,
    MODEL_ROUTER_VISION_BRIDGE_STATE: bridgeState,
    CODEX_ROUTER_QUIET: "1",
  });

  const input = [
    {
      type: "message",
      role: "user",
      content: [
        { type: "input_text", text: "what does this say?" },
        { type: "input_image", image_url: dataUrl, detail: "high" },
      ],
    },
    {
      type: "function_call",
      call_id: "call_1",
      name: "view_image",
      arguments: '{"path":"/tmp/codex-clipboard.png"}',
    },
    {
      type: "function_call_output",
      call_id: "call_1",
      output: [{ type: "input_image", image_url: dataUrl, detail: "high" }],
    },
  ];

  try {
    await waitFor(`${routerBase(routerPort)}/models`, router);
    const response = await fetch(`${routerBase(routerPort)}/responses`, {
      method: "POST",
      headers: {
        Authorization: "Bearer CHATGPT_SESSION_TOKEN",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ model: "deepseek/deepseek-v4-pro", stream: false, input }),
    });

    assert.equal(response.status, 200, await response.text());
    assert.equal(gatewayRequests.length, 1);
    const forwarded = gatewayRequests[0];
    // The only thing the provider must never see, in either place.
    assert.doesNotMatch(JSON.stringify(forwarded), /input_image|image_url|base64/);
    assert.match(forwarded.input[0].content[1].text, /IMAGE EVIDENCE/);
    assert.match(forwarded.input[0].content[1].text, /A login screen\./);
    // A tool result that is now pure text goes back as ordinary text. It is the
    // same image one item above, so it points at that reading instead of
    // paying for every word of it a second time.
    assert.equal(typeof forwarded.input[2].output, "string");
    assert.match(forwarded.input[2].output, /is the same image as Image 1/);
    assert.doesNotMatch(forwarded.input[2].output, /A login screen\./);
    assert.equal(forwarded.input[2].call_id, "call_1");
    // Two images, one purchase: the tool result is read for the question that
    // led to it, so it lands on the transcript the paste already paid for.
    assert.equal(visionCalls.length, 1);
    assert.match(JSON.stringify(visionCalls[0]), /what does this say\?/);
  } finally {
    await stopChild(router);
    await closeServer(gateway.server);
    await closeServer(native.server);
    await closeServer(engine.server);
    rmSync(stateDirectory, { recursive: true, force: true });
  }
});

test("two concurrent turns carrying one image buy one read, not two", async () => {
  // Observed in production: Codex had two requests in flight carrying the same
  // pasted screenshot, both missed the cache because neither read had returned
  // yet, and the engine was charged twice for one transcript.
  const dataUrl = "data:image/png;base64,AAAA";
  const gateway = await mockServer(async (_request, response) => {
    json(response, 200, { route: "external" });
  });
  const native = await mockServer(async (_request, response) => {
    json(response, 200, { id: "unused", output: [] });
  });
  let reads = 0;
  const engine = await mockServer(async (_request, response) => {
    reads += 1;
    // Slow enough that the second request is certain to arrive mid-read.
    await new Promise((resolve) => setTimeout(resolve, 250));
    json(response, 200, {
      choices: [{ message: { content: "## Summary\nA login screen." } }],
    });
  });
  const stateDirectory = mkdtempSync(path.join(os.tmpdir(), "router-single-flight-"));
  const bridgeState = path.join(stateDirectory, "vision-bridge.json");
  writeFileSync(
    bridgeState,
    `${JSON.stringify({
      version: 1,
      enabled: true,
      engine: "local",
      effort: null,
      local: { baseUrl: `http://127.0.0.1:${engine.port}/v1`, model: "moondream" },
    })}\n`,
    { mode: 0o600 },
  );
  const routerPort = await openPort();
  const router = run("router.mjs", {
    CODEX_ROUTER_PORT: String(routerPort),
    CODEX_NATIVE_BASE_URL: `http://127.0.0.1:${native.port}/backend-api/codex`,
    CODEX_ROUTER_GATEWAY_BASE_URL: `http://127.0.0.1:${gateway.port}/v1`,
    MODEL_ROUTER_VISION_BRIDGE_STATE: bridgeState,
    CODEX_ROUTER_QUIET: "1",
  });

  const turn = JSON.stringify({
    model: "deepseek/deepseek-v4-pro",
    stream: false,
    input: [
      {
        type: "message",
        role: "user",
        content: [
          { type: "input_text", text: "what does this say?" },
          { type: "input_image", image_url: dataUrl },
        ],
      },
    ],
  });

  try {
    await waitFor(`${routerBase(routerPort)}/models`, router);
    const send = () =>
      fetch(`${routerBase(routerPort)}/responses`, {
        method: "POST",
        headers: {
          Authorization: "Bearer CHATGPT_SESSION_TOKEN",
          "Content-Type": "application/json",
        },
        body: turn,
      });
    const [first, second] = await Promise.all([send(), send()]);
    assert.equal(first.status, 200, await first.text());
    assert.equal(second.status, 200, await second.text());
    assert.equal(reads, 1, "the second request must wait on the first read, not buy its own");
  } finally {
    await stopChild(router);
    await closeServer(gateway.server);
    await closeServer(native.server);
    await closeServer(engine.server);
    rmSync(stateDirectory, { recursive: true, force: true });
  }
});

test("a turn with no image reaches a text-only model untouched", async () => {
  // The vision bridge rewrites turns that carry images. A turn that carries
  // none must reach the model exactly as Codex sent it: no injected evidence
  // block, no engine lookup, and above all no failure when the operator has
  // no vision engine at all.
  const gatewayRequests = [];
  const gateway = await mockServer(async (request, response) => {
    gatewayRequests.push(await bodyJson(request));
    json(response, 200, { route: "external" });
  });
  const native = await mockServer(async (_request, response) => {
    json(response, 200, { id: "unused", output: [] });
  });
  const routerPort = await openPort();
  const router = run("router.mjs", {
    CODEX_ROUTER_PORT: String(routerPort),
    CODEX_NATIVE_BASE_URL: `http://127.0.0.1:${native.port}/backend-api/codex`,
    CODEX_ROUTER_GATEWAY_BASE_URL: `http://127.0.0.1:${gateway.port}/v1`,
    // No vision engine is reachable here, which is the state that would break
    // an unconditional bridge.
    CODEX_ROUTER_QUIET: "1",
  });

  const input = [
    {
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: "explain this function" }],
    },
  ];

  try {
    await waitFor(`${routerBase(routerPort)}/models`, router);
    const response = await fetch(`${routerBase(routerPort)}/responses`, {
      method: "POST",
      headers: {
        Authorization: "Bearer CHATGPT_SESSION_TOKEN",
        "Content-Type": "application/json",
      },
      // deepseek reads no images, so it is exactly the model the bridge exists
      // for — and exactly the one that must not be touched without an image.
      body: JSON.stringify({ model: "deepseek/deepseek-v4-pro", stream: false, input }),
    });

    assert.equal(response.status, 200, await response.text());
    assert.equal(gatewayRequests.length, 1);
    // Byte-for-byte the same turn: no evidence block, no substitution notice,
    // no extra part of any kind.
    assert.deepEqual(gatewayRequests[0].input, input);
    // And nothing anywhere in the forwarded body mentions the bridge.
    assert.doesNotMatch(JSON.stringify(gatewayRequests[0]), /vision|image|could not read/i);
  } finally {
    await stopChild(router);
    await closeServer(gateway.server);
    await closeServer(native.server);
  }
});
