import assert from "node:assert/strict";
import { spawn } from "node:child_process";
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
import { openPort } from "./port-pool.mjs";

const encoder = new TextEncoder();
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const internalKey = "test-antigravity-internal-key-with-sufficient-length";

async function stopChild(child) {
  if (child.exitCode !== null) return;
  child.kill("SIGTERM");
  await new Promise((resolve) => child.once("exit", resolve));
}

async function closeServer(server) {
  server.closeAllConnections?.();
  await new Promise((resolve) => server.close(resolve));
}

async function startMockUpstream(handler) {
  const port = await openPort();
  const server = http.createServer(handler);
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  return { server, url: `http://127.0.0.1:${port}` };
}

function writeTestToken(directory) {
  const tokenPath = path.join(directory, "antigravity-oauth.json");
  writeFileSync(tokenPath, JSON.stringify({
    version: 1,
    access_token: "test-access-token",
    refresh_token: "test-refresh-token",
    expires_at: Math.floor(Date.now() / 1_000) + 3_600,
    expires_in: 3_600,
    project_id: "test-managed-project",
    project_source: "managed",
    project_checked_at: Date.now(),
    token_type: "Bearer",
  }), { mode: 0o600 });
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
        ANTIGRAVITY_TOKEN_PATH: tokenPath,
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

async function exerciseStreamFailure(upstreamHandler, expected, extraEnv = {}) {
  const directory = mkdtempSync(path.join(os.tmpdir(), "antigravity-stream-error-"));
  const upstream = await startMockUpstream(upstreamHandler);
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

test("ends a started stream with an OpenAI error frame for an embedded 429", async () => {
  await exerciseStreamFailure((_request, response) => {
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

test("ends a started stream with an OpenAI error frame after an idle timeout", async () => {
  await exerciseStreamFailure((_request, response) => {
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

test("ends a started stream with an OpenAI error frame after a clean incomplete EOF", async () => {
  await exerciseStreamFailure((_request, response) => {
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
