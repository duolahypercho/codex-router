import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  antigravityUpstreamError,
  consumeAntigravitySseStream,
  parseAntigravitySseEvent,
  requestAntigravityUpstream,
} from "../src/antigravity-oauth-forwarder.mjs";
import { writePrivateJson } from "../src/file-security.mjs";
import { openPort } from "./port-pool.mjs";

const encoder = new TextEncoder();
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const internalKey = "test-antigravity-internal-key-with-sufficient-length";

async function stopChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  await new Promise((resolve) => child.once("exit", resolve));
}

async function closeServer(server) {
  if (!server.listening) return;
  server.closeAllConnections?.();
  await new Promise((resolve) => server.close(resolve));
}

async function startMockUpstream(handler, t) {
  const port = await openPort();
  const server = http.createServer(handler);
  // Setup may throw before its explicit try/finally (for example an ACL write).
  // Register ownership immediately, so a failed test cannot retain this socket.
  t.after(() => closeServer(server));
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  return { server, url: `http://127.0.0.1:${port}` };
}

test("upstream fixture releases its listener when setup throws before finally", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "antigravity-setup-failure-"));
  try {
    const probe = path.join(directory, "setup-failure.test.mjs");
    writeFileSync(probe, [
      'import test from "node:test";',
      'import http from "node:http";',
      'const openPort = async () => 0;',
      closeServer.toString(),
      startMockUpstream.toString(),
      'test("synthetic setup failure", async (t) => { await startMockUpstream((_request, response) => response.end(), t); throw new Error("synthetic setup rejection"); });',
    ].join("\n"));
    // Direct execution runs node:test in this process. A timeout can therefore
    // retire the entire probe without leaving a separate test worker behind.
    const result = spawnSync(process.execPath, [probe], {
      encoding: "utf8", timeout: 10_000, windowsHide: true,
    });
    assert.equal(result.error, undefined, "failed setup must not leave an open server until the child timeout");
    assert.equal(result.status, 1, "the original setup failure must still fail the test");
    assert.match(result.stdout + result.stderr, /synthetic setup rejection/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

function writeTestToken(directory, { verified = true, overrides = {} } = {}) {
  const tokenPath = path.join(directory, "antigravity-oauth.json");
  writePrivateJson(tokenPath, {
    version: 3,
    managed_by: "codex-router",
    session_generation: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    client_id: "operator-owned.apps.googleusercontent.com",
    client_secret: "test-client-secret",
    access_token: "test-access-token",
    refresh_token: "test-refresh-token",
    expires_at: Math.floor(Date.now() / 1_000) + 3_600,
    expires_in: 3_600,
    project_id: "test-managed-project",
    project_source: "managed",
    project_checked_at: Date.now(),
    token_type: "Bearer",
    ...(verified
      ? {
        probe_version: 1,
        probe_verified_at: Date.now(),
        probe_model: "gemini-3.1-pro",
        probe_activation: {
          version: 1,
          state: "active",
          generation: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        },
      }
      : {}),
    ...overrides,
  });
  return tokenPath;
}

function startForwarder(port, upstreamUrl, tokenPath, extraEnv = {}) {
  const child = spawn(
    process.execPath,
    [path.join(root, "src", "antigravity-oauth-forwarder.mjs")],
    {
      cwd: root,
      env: {
        ...process.env,
        MODEL_ROUTER_TARGET: "codex",
        MODEL_ROUTER_INTERNAL_KEY: internalKey,
        MODEL_ROUTER_ANTIGRAVITY_OAUTH_PORT: String(port),
        MODEL_ROUTER_STATE_DIR: path.dirname(tokenPath),
        ANTIGRAVITY_ENDPOINT: upstreamUrl,
        ANTIGRAVITY_PROD_ENDPOINT: upstreamUrl,
        MODEL_ROUTER_QUIET: "1",
        ...extraEnv,
      },
      stdio: ["ignore", "ignore", "pipe"],
    },
  );
  child.stderr.setEncoding("utf8");
  let errors = "";
  child.stderr.on("data", (chunk) => {
    errors += chunk;
  });
  child.testErrors = () => errors;
  return child;
}

async function waitForForwarder(base, child) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`forwarder exited: ${child.testErrors()}`);
    try {
      const response = await fetch(`${base}/health`, {
        headers: { Authorization: `Bearer ${internalKey}` },
      });
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  throw new Error(`forwarder did not become healthy: ${child.testErrors()}`);
}

function sse(payload) {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

function errorFrame(body) {
  for (const block of body.split(/\r?\n\r?\n/)) {
    const line = block.split(/\r?\n/).find((entry) => entry.startsWith("data: "));
    if (!line) continue;
    try {
      const payload = JSON.parse(line.slice(6));
      if (payload.error) return payload.error;
    } catch {}
  }
  return undefined;
}

async function exerciseStreamFailure(t, upstreamHandler, expected, extraEnv = {}) {
  const directory = mkdtempSync(path.join(os.tmpdir(), "antigravity-stream-error-"));
  const upstream = await startMockUpstream(upstreamHandler, t);
  const port = await openPort();
  const child = startForwarder(port, upstream.url, writeTestToken(directory), extraEnv);
  const base = `http://127.0.0.1:${port}`;
  try {
    await waitForForwarder(base, child);
    const response = await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${internalKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "gemini-3.7-flash",
        stream: true,
        messages: [{ role: "user", content: "hello" }],
      }),
    });
    assert.equal(response.status, 200);
    const body = await response.text();
    assert.match(body, /"content":"partial"/);
    assert.deepEqual(errorFrame(body), {
      message: expected.message,
      type: expected.status >= 500 ? "api_error" : "invalid_request_error",
      code: expected.status,
      provider_code: expected.providerCode,
    });
    assert.doesNotMatch(body, /data: \[DONE\]/);
  } finally {
    await stopChild(child);
    await closeServer(upstream.server);
    rmSync(directory, { recursive: true, force: true });
  }
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function beginSlowChatRequest(base) {
  let responseResolve;
  let responseReject;
  const responsePromise = new Promise((resolve, reject) => {
    responseResolve = resolve;
    responseReject = reject;
  });
  const target = new URL(`${base}/v1/chat/completions`);
  const request = http.request({
    hostname: target.hostname,
    port: target.port,
    path: target.pathname,
    method: "POST",
    headers: {
      Authorization: `Bearer ${internalKey}`,
      "Content-Type": "application/json",
      "Transfer-Encoding": "chunked",
    },
  }, (response) => {
    response.setEncoding("utf8");
    let body = "";
    response.on("data", (chunk) => { body += chunk; });
    response.on("end", () => responseResolve({ status: response.statusCode, body }));
  });
  request.once("error", responseReject);
  request.write('{"model":"gemini-3.1-pro","messages":[');
  return { request, responsePromise };
}

test("rejects an omitted forced Claude tool locally before OAuth or upstream work", async (t) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "antigravity-local-shape-"));
  let upstreamCalls = 0;
  const upstream = await startMockUpstream((_request, response) => {
    upstreamCalls += 1;
    response.writeHead(500);
    response.end();
  }, t);
  const port = await openPort();
  const tokenPath = writeTestToken(directory);
  const child = startForwarder(port, upstream.url, tokenPath);
  const base = `http://127.0.0.1:${port}`;
  try {
    await waitForForwarder(base, child);
    const response = await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${internalKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "claude-opus-4-6-thinking",
        messages: [{ role: "user", content: "use impossible" }],
        tool_choice: { type: "function", function: { name: "impossible" } },
        tools: [{
          type: "function",
          function: {
            name: "impossible",
            parameters: { type: "object", properties: { value: false } },
          },
        }],
      }),
    });
    assert.equal(response.status, 400);
    const payload = await response.json();
    assert.equal(payload.error.type, "invalid_request_error");
    assert.equal(payload.error.code, "unsupported_forced_tool_schema");
    assert.match(payload.error.message, /impossible/);
    assert.equal(upstreamCalls, 0);
  } finally {
    await stopChild(child);
    await closeServer(upstream.server);
    rmSync(directory, { recursive: true, force: true });
  }
});

test("delivers an upstream SSE chunk before the delayed stream completes", async () => {
  let streamController;
  const body = new ReadableStream({
    start(controller) {
      streamController = controller;
    },
  });
  const firstHandled = deferred();
  const payloads = [];
  let settled = false;
  const consuming = consumeAntigravitySseStream(body, async (payload) => {
    payloads.push(payload);
    firstHandled.resolve();
  }).finally(() => {
    settled = true;
  });

  streamController.enqueue(
    encoder.encode('data: {"response":{"candidates":[{"content":{"parts":[{"text":"first"}]}}]}}\n\n'),
  );
  await firstHandled.promise;
  assert.equal(settled, false, "the first event is delivered while the body remains open");

  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(settled, false, "a delayed second chunk does not hold back the first");
  streamController.enqueue(
    encoder.encode('data: {"response":{"candidates":[{"content":{"parts":[{"text":" second"}]},"finishReason":"STOP"}]}}\n\n'),
  );
  streamController.enqueue(encoder.encode("data: [DONE]\n\n"));
  streamController.close();
  await consuming;
  assert.equal(payloads.length, 2);
});

test("awaits an async event handler to preserve output backpressure ordering", async () => {
  let active = 0;
  let maximumActive = 0;
  const seen = [];
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(
        encoder.encode('data: {"sequence":1}\n\ndata: {"sequence":2}\n\ndata: [DONE]\n\n'),
      );
      controller.close();
    },
  });
  await consumeAntigravitySseStream(body, async (payload) => {
    active += 1;
    maximumActive = Math.max(maximumActive, active);
    await new Promise((resolve) => setTimeout(resolve, 10));
    seen.push(payload.sequence);
    active -= 1;
  });
  assert.deepEqual(seen, [1, 2]);
  assert.equal(maximumActive, 1);
});

test("rejects malformed SSE data instead of silently returning an empty 200", () => {
  assert.throws(
    () => parseAntigravitySseEvent("data: {not-json}\n\n"),
    (error) => error.status === 502 && error.code === "malformed_sse",
  );
});

test("bounds an upstream body that stops producing data", async () => {
  const body = new ReadableStream({ start() {} });
  await assert.rejects(
    consumeAntigravitySseStream(body, async () => {}, { idleTimeoutMs: 15 }),
    (error) => error.status === 504 && error.code === "upstream_idle_timeout",
  );
});

test("terminal grace is one absolute window even while later SSE members trickle", async () => {
  let interval;
  let cancelled = false;
  let sawTerminal = false;
  let handled = 0;
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode('data: {"terminal":true}\n\n'));
      controller.enqueue(encoder.encode('data: {"trailer":true}\n\n'));
      interval = setInterval(() => {
        controller.enqueue(encoder.encode('data: {"trailer":true}\n\n'));
      }, 5);
    },
    cancel() {
      cancelled = true;
      clearInterval(interval);
    },
  });
  const controller = new AbortController();
  const safetyTimer = setTimeout(() => {
    controller.abort(new Error("terminal grace was reset by trailer traffic"));
  }, 250);
  try {
    await consumeAntigravitySseStream(body, async (payload) => {
      handled += 1;
      if (payload.terminal) sawTerminal = true;
    }, {
      idleTimeoutMs: 100,
      terminalGraceMs: 30,
      isTerminal: () => sawTerminal,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(safetyTimer);
  }
  assert.equal(cancelled, true);
  assert.ok(handled > 1, "the grace window should inspect trailers that have already arrived");
});

test("the local boundary refuses unverified sessions without upstream traffic", async (t) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "antigravity-unverified-"));
  let upstreamCalls = 0;
  const upstream = await startMockUpstream((_request, response) => {
    upstreamCalls += 1;
    response.writeHead(500).end();
  }, t);
  const port = await openPort();
  const child = startForwarder(
    port,
    upstream.url,
    writeTestToken(directory, { verified: false }),
  );
  const base = `http://127.0.0.1:${port}`;
  try {
    await waitForForwarder(base, child);
    const response = await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${internalKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "gemini-3.1-pro",
        messages: [{ role: "user", content: "must remain local" }],
      }),
    });
    assert.equal(response.status, 403);
    assert.equal((await response.json()).error.code, "antigravity_probe_required");
    assert.equal(upstreamCalls, 0);
  } finally {
    await stopChild(child);
    await closeServer(upstream.server);
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a slow request body cannot cross a session replacement", async (t) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "antigravity-slow-session-"));
  let upstreamCalls = 0;
  const upstream = await startMockUpstream((_request, response) => {
    upstreamCalls += 1;
    response.writeHead(500).end();
  }, t);
  const port = await openPort();
  const tokenPath = writeTestToken(directory);
  const child = startForwarder(port, upstream.url, tokenPath);
  const base = `http://127.0.0.1:${port}`;
  try {
    await waitForForwarder(base, child);
    const slow = beginSlowChatRequest(base);
    await new Promise((resolve) => setTimeout(resolve, 30));
    writeTestToken(directory, {
      overrides: {
        session_generation: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
        access_token: "replacement-access",
        refresh_token: "replacement-refresh",
      },
    });
    slow.request.end('{"role":"user","content":"must stay local"}]}');
    const result = await slow.responsePromise;
    assert.equal(result.status, 409);
    assert.equal(JSON.parse(result.body).error.code, "oauth_session_changed");
    assert.equal(upstreamCalls, 0);
  } finally {
    await stopChild(child);
    await closeServer(upstream.server);
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a slow request body cannot outlive proof invalidation", async (t) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "antigravity-slow-proof-"));
  let upstreamCalls = 0;
  const upstream = await startMockUpstream((_request, response) => {
    upstreamCalls += 1;
    response.writeHead(500).end();
  }, t);
  const port = await openPort();
  const tokenPath = writeTestToken(directory);
  const child = startForwarder(port, upstream.url, tokenPath);
  const base = `http://127.0.0.1:${port}`;
  try {
    await waitForForwarder(base, child);
    const slow = beginSlowChatRequest(base);
    await new Promise((resolve) => setTimeout(resolve, 30));
    writeTestToken(directory, { verified: false });
    slow.request.end('{"role":"user","content":"must stay local"}]}');
    const result = await slow.responsePromise;
    assert.equal(result.status, 403);
    assert.equal(JSON.parse(result.body).error.code, "antigravity_probe_required");
    assert.equal(upstreamCalls, 0);
  } finally {
    await stopChild(child);
    await closeServer(upstream.server);
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a 401 retry cannot cross a disconnect-reconnect session generation", async (t) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "antigravity-401-generation-"));
  let upstreamCalls = 0;
  const tokenPath = writeTestToken(directory);
  const upstream = await startMockUpstream((_request, response) => {
    upstreamCalls += 1;
    writeTestToken(directory, {
      overrides: {
        session_generation: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
        access_token: "replacement-access",
        refresh_token: "replacement-refresh",
      },
    });
    response.writeHead(401, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ error: { message: "expired" } }));
  }, t);
  const port = await openPort();
  const child = startForwarder(port, upstream.url, tokenPath);
  const base = `http://127.0.0.1:${port}`;
  try {
    await waitForForwarder(base, child);
    const response = await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${internalKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "gemini-3.1-pro",
        messages: [{ role: "user", content: "do not cross accounts" }],
      }),
    });
    assert.equal(response.status, 409);
    assert.equal((await response.json()).error.code, "oauth_session_changed");
    assert.equal(upstreamCalls, 1);
  } finally {
    await stopChild(child);
    await closeServer(upstream.server);
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a 401 retry cannot outlive proof invalidation in the same session", async (t) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "antigravity-401-proof-"));
  let upstreamCalls = 0;
  const tokenPath = writeTestToken(directory);
  const upstream = await startMockUpstream((_request, response) => {
    upstreamCalls += 1;
    writeTestToken(directory, { verified: false });
    response.writeHead(401, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ error: { message: "expired" } }));
  }, t);
  const port = await openPort();
  const child = startForwarder(port, upstream.url, tokenPath);
  const base = `http://127.0.0.1:${port}`;
  try {
    await waitForForwarder(base, child);
    const response = await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${internalKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "gemini-3.1-pro",
        messages: [{ role: "user", content: "do not retry stale proof" }],
      }),
    });
    assert.equal(response.status, 403);
    assert.equal((await response.json()).error.code, "antigravity_probe_required");
    assert.equal(upstreamCalls, 1);
  } finally {
    await stopChild(child);
    await closeServer(upstream.server);
    rmSync(directory, { recursive: true, force: true });
  }
});

test("endpoint fallback reasserts the exact active proof before another attempt", async (t) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "antigravity-fallback-proof-"));
  let dailyCalls = 0;
  let productionCalls = 0;
  const tokenPath = writeTestToken(directory);
  const daily = await startMockUpstream((_request, response) => {
    dailyCalls += 1;
    writeTestToken(directory, { verified: false });
    response.writeHead(503, { "Content-Type": "application/json" });
    response.end("{}");
  }, t);
  const production = await startMockUpstream((_request, response) => {
    productionCalls += 1;
    response.writeHead(500).end();
  }, t);
  const port = await openPort();
  const child = startForwarder(port, daily.url, tokenPath, {
    ANTIGRAVITY_PROD_ENDPOINT: production.url,
  });
  const base = `http://127.0.0.1:${port}`;
  try {
    await waitForForwarder(base, child);
    const response = await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${internalKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "gemini-3.1-pro",
        messages: [{ role: "user", content: "do not fall back after revocation" }],
      }),
    });
    assert.equal(response.status, 403);
    assert.equal((await response.json()).error.code, "antigravity_probe_required");
    assert.equal(dailyCalls, 1);
    assert.equal(productionCalls, 0);
  } finally {
    await stopChild(child);
    await closeServer(daily.server);
    await closeServer(production.server);
    rmSync(directory, { recursive: true, force: true });
  }
});

test("falls back only after an explicit retryable response and reuses the body", async () => {
  const calls = [];
  const serializedBody = JSON.stringify({ requestId: "agent-stable" });
  const upstream = await requestAntigravityUpstream({
    accessToken: "secret",
    serializedBody,
    endpoints: ["https://daily.example", "https://prod.example"],
    fetchImpl: async (url, options) => {
      calls.push({ url, body: options.body, authorization: options.headers.Authorization });
      if (calls.length === 1) return new Response("busy", { status: 503 });
      return new Response("data: [DONE]\n\n", { status: 200 });
    },
  });
  assert.equal(upstream.status, 200);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].body, serializedBody);
  assert.equal(calls[1].body, serializedBody);
  assert.equal(calls[0].authorization, "Bearer secret");
  assert.match(calls[0].url, /^https:\/\/daily\.example\//);
  assert.match(calls[1].url, /^https:\/\/prod\.example\//);
});

test("does not fall back after a non-retryable provider response", async () => {
  let calls = 0;
  const upstream = await requestAntigravityUpstream({
    accessToken: "secret",
    serializedBody: "{}",
    endpoints: ["https://daily.example", "https://prod.example"],
    fetchImpl: async () => {
      calls += 1;
      return new Response("bad request", { status: 400 });
    },
  });
  assert.equal(upstream.status, 400);
  assert.equal(calls, 1);
});

test("classifies network failures as transport errors without endpoint replay", async () => {
  let calls = 0;
  await assert.rejects(
    requestAntigravityUpstream({
      accessToken: "secret",
      serializedBody: "{}",
      endpoints: ["https://daily.example", "https://prod.example"],
      fetchImpl: async () => {
        calls += 1;
        throw new TypeError("socket closed");
      },
    }),
    (error) => error.status === 502 && error.code === "upstream_transport_error",
  );
  assert.equal(calls, 1);
});

test("preserves provider statuses and safe retry headers", () => {
  const headers = new Headers({
    "Retry-After": "30",
    "X-RateLimit-Remaining-Requests": "0",
    "Set-Cookie": "private=value",
  });
  for (const status of [400, 403, 404, 429, 500, 503, 504]) {
    const translated = antigravityUpstreamError(status, headers, '{"error":{"message":"busy"}}');
    assert.equal(translated.status, status);
    assert.equal(translated.headers["retry-after"], "30");
    assert.equal(translated.headers["x-ratelimit-remaining-requests"], "0");
    assert.equal("set-cookie" in translated.headers, false);
  }
});

test("ends a started stream with an OpenAI error frame for an embedded 429", async (t) => {
  await exerciseStreamFailure(t, (_request, response) => {
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    response.write(sse({
      response: { candidates: [{ content: { parts: [{ text: "partial" }] } }] },
    }));
    response.end(sse({
      error: { code: 429, status: "RESOURCE_EXHAUSTED", message: "quota exhausted" },
    }));
  }, {
    status: 429,
    providerCode: "RESOURCE_EXHAUSTED",
    message: "Google Antigravity returned an embedded error: quota exhausted",
  });
});

test("ends a started stream with an OpenAI error frame after an idle timeout", async (t) => {
  await exerciseStreamFailure(t, (_request, response) => {
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    response.write(sse({
      response: { candidates: [{ content: { parts: [{ text: "partial" }] } }] },
    }));
  }, {
    status: 504,
    providerCode: "upstream_idle_timeout",
    message: "Google Antigravity sent no stream data for 30ms.",
  }, {
    ANTIGRAVITY_IDLE_TIMEOUT_MS: "30",
  });
});

test("ends a started stream with an OpenAI error frame after a clean incomplete EOF", async (t) => {
  await exerciseStreamFailure(t, (_request, response) => {
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    response.end(sse({
      response: { candidates: [{ content: { parts: [{ text: "partial" }] } }] },
    }));
  }, {
    status: 502,
    providerCode: "incomplete_stream",
    message: "Google Antigravity ended its stream before the candidate completed.",
  });
});
