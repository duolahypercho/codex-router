import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { zstdDecompressSync } from "node:zlib";

import { callerBaseUrl } from "../src/caller-auth.mjs";
import { foldResponsesSse, nativeInputAsList } from "../src/native-buffered-response.mjs";
import { openPort } from "./port-pool.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const INTERNAL_KEY = "test-internal-service-key-with-sufficient-length";
const CALLER_KEY = "test-router-caller-capability-with-sufficient-length";

const MESSAGE = {
  id: "msg_1",
  type: "message",
  role: "assistant",
  status: "completed",
  content: [{ type: "output_text", text: "OK", annotations: [] }],
};

// The native backend's shape: items arrive on output_item.done, and the
// terminal snapshot may carry an empty `output`.
function nativeSse({ completedOutput = [] } = {}) {
  const events = [
    { type: "response.created", response: { id: "resp_1", status: "in_progress", output: [] } },
    { type: "response.output_item.added", output_index: 0, item: { ...MESSAGE, status: "in_progress", content: [] } },
    { type: "response.output_text.delta", output_index: 0, delta: "OK" },
    { type: "response.output_item.done", output_index: 0, item: MESSAGE },
    {
      type: "response.completed",
      response: {
        id: "resp_1",
        object: "response",
        status: "completed",
        output: completedOutput,
        usage: { input_tokens: 5, output_tokens: 1, total_tokens: 6 },
      },
    },
  ];
  return events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("");
}

test("a string input becomes the one user message it stands for", () => {
  assert.deepEqual(nativeInputAsList("Reply with exactly OK"), [
    {
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: "Reply with exactly OK" }],
    },
  ]);
  const list = [{ role: "user", content: "hi" }];
  assert.equal(nativeInputAsList(list), list, "a list is never rewritten");
  assert.equal(nativeInputAsList(undefined), undefined);
});

test("a native stream folds into the response object, items included", () => {
  const folded = foldResponsesSse(nativeSse());
  assert.equal(folded.status, 200);
  assert.equal(folded.body.id, "resp_1");
  assert.equal(folded.body.status, "completed");
  assert.deepEqual(folded.body.output, [MESSAGE]);
  assert.deepEqual(folded.body.usage, { input_tokens: 5, output_tokens: 1, total_tokens: 6 });

  // A snapshot that already carries its items is believed as sent.
  const own = [{ ...MESSAGE, id: "msg_snapshot" }];
  assert.deepEqual(foldResponsesSse(nativeSse({ completedOutput: own })).body.output, own);
});

test("a stream that failed or never completed is an error, not an empty success", () => {
  const failed = foldResponsesSse(
    `data: ${JSON.stringify({
      type: "response.failed",
      response: { error: { code: "server_error", message: "boom" } },
    })}\n\n`,
  );
  assert.equal(failed.status, 502);
  assert.equal(failed.body.error.code, "server_error");
  assert.equal(failed.body.error.message, "boom");

  const cut = foldResponsesSse(
    `data: ${JSON.stringify({ type: "response.created", response: { id: "r" } })}\n\n`,
  );
  assert.equal(cut.status, 502);
  assert.equal(cut.body.error.code, "native_stream_incomplete");
});

async function mockServer(handler) {
  const server = http.createServer(handler);
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return { server, port: server.address().port };
}

async function readBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const raw = Buffer.concat(chunks);
  const decoded =
    request.headers["content-encoding"] === "zstd" ? zstdDecompressSync(raw) : raw;
  return JSON.parse(decoded.toString("utf8"));
}

function runRouter(env) {
  const child = spawn(process.execPath, [path.join(root, "src", "router.mjs")], {
    cwd: root,
    env: {
      ...process.env,
      CODEX_ROUTER_CALLER_KEY: CALLER_KEY,
      CODEX_ROUTER_INTERNAL_KEY: INTERNAL_KEY,
      KIMI_INTERNAL_KEY: INTERNAL_KEY,
      CODEX_ROUTER_QUIET: "1",
      // No session to substitute: the header is deleted rather than the
      // router key forwarded, which is all this test needs.
      CODEX_ROUTER_NATIVE_SESSION_FALLBACK: "0",
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
      // Not bound yet.
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

async function withRouter(run) {
  const seen = [];
  const native = await mockServer(async (request, response) => {
    const body = await readBody(request);
    seen.push({ body, headers: request.headers });
    // The real backend's two refusals, so a regression reproduces the issue.
    if (!Array.isArray(body.input)) {
      response.writeHead(400, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ detail: "Input must be a list" }));
      return;
    }
    if (body.stream !== true) {
      response.writeHead(400, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ detail: "Stream must be set to true" }));
      return;
    }
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    response.end(nativeSse());
  });
  const stateDir = mkdtempSync(path.join(os.tmpdir(), "native-generic-client-"));
  const routerPort = await openPort();
  const router = runRouter({
    CODEX_ROUTER_PORT: String(routerPort),
    CODEX_NATIVE_BASE_URL: `http://127.0.0.1:${native.port}/backend-api/codex`,
    CODEX_ROUTER_GATEWAY_BASE_URL: `http://127.0.0.1:${native.port}/v1`,
    MODEL_ROUTER_STATE_DIR: stateDir,
  });
  try {
    const base = callerBaseUrl(routerPort, CALLER_KEY);
    await waitFor(`${base}/models`, router);
    await run({ base, seen });
  } finally {
    await stopChild(router);
    await new Promise((resolve) => native.server.close(resolve));
    rmSync(stateDir, { recursive: true, force: true });
  }
}

test("a generic client's string, non-streaming request gets one JSON response (#862)", async () => {
  await withRouter(async ({ base, seen }) => {
    const result = await fetch(`${base}/responses`, {
      method: "POST",
      headers: { Authorization: `Bearer ${CALLER_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "gpt-5.6-sol",
        input: "Reply with exactly OK",
        max_output_tokens: 400,
      }),
    });
    const text = await result.text();
    assert.equal(result.status, 200, text);
    assert.match(result.headers.get("content-type") || "", /application\/json/);
    const body = JSON.parse(text);
    assert.equal(body.status, "completed");
    assert.deepEqual(body.output, [MESSAGE]);

    assert.equal(seen.length, 1);
    assert.equal(seen[0].body.stream, true);
    assert.deepEqual(seen[0].body.input, nativeInputAsList("Reply with exactly OK"));
    assert.equal(seen[0].headers.authorization, undefined, "the router key never leaves");
  });
});

test("a streaming caller that brought its own credential is relayed as a stream", async () => {
  await withRouter(async ({ base, seen }) => {
    const input = [{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }];
    const result = await fetch(`${base}/responses`, {
      method: "POST",
      headers: { Authorization: "Bearer upstream-token", "Content-Type": "application/json" },
      body: JSON.stringify({ model: "gpt-5.6-sol", stream: true, input }),
    });
    const text = await result.text();
    assert.equal(result.status, 200, text);
    assert.match(result.headers.get("content-type") || "", /text\/event-stream/);
    assert.match(text, /response\.completed/);
    assert.deepEqual(seen[0].body.input, input);
    assert.equal(seen[0].headers.authorization, "Bearer upstream-token");
  });
});
