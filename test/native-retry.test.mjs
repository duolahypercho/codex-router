import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { zstdDecompressSync } from "node:zlib";

import { callerBaseUrl } from "../src/caller-auth.mjs";
import { fetchWithRetry } from "../src/upstream-retry.mjs";
import { openPort } from "./port-pool.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const INTERNAL_KEY = "test-internal-service-key-with-sufficient-length";
const CALLER_KEY = "test-router-caller-capability-with-sufficient-length";

// The body ChatGPT's edge actually returns. "before headers" is the property
// that makes the request replayable: no response bytes ever existed.
const EDGE_503_BODY =
  "upstream connect error or disconnect/reset before headers. " +
  "reset reason: remote connection failure";

function routerBase(port) {
  return callerBaseUrl(port, CALLER_KEY);
}

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
  return {
    encoding: request.headers["content-encoding"],
    raw,
    // A retried turn must arrive as a valid body, not a half-consumed stream
    // or a zstd frame whose header says one thing and whose bytes say another.
    text: (request.headers["content-encoding"] === "zstd"
      ? zstdDecompressSync(raw)
      : raw
    ).toString("utf8"),
  };
}

function run(env) {
  const child = spawn(process.execPath, [path.join(root, "src", "router.mjs")], {
    cwd: root,
    env: {
      ...process.env,
      CODEX_ROUTER_CALLER_KEY: CALLER_KEY,
      CODEX_ROUTER_INTERNAL_KEY: INTERNAL_KEY,
      KIMI_INTERNAL_KEY: INTERNAL_KEY,
      CODEX_ROUTER_SHOW_ALL_MODELS: "1",
      CODEX_ROUTER_QUIET: "1",
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

async function closeServer(server) {
  await new Promise((resolve) => server.close(resolve));
}

function usageEvents(stateDir) {
  const file = path.join(stateDir, "usage-events.jsonl");
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

async function waitUntil(predicate, message, timeoutMs = 3_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(message);
}

// A turn large enough that the router compresses it, so a retry has to replay
// a zstd frame rather than plain JSON.
function largeNativeTurn() {
  const text = Array.from(
    { length: 4_000 },
    (_, index) => `line ${index}: the quick brown fox jumps over the lazy dog`,
  ).join("\n");
  return {
    model: "gpt-5.6-sol",
    input: [{ type: "message", role: "user", content: [{ type: "input_text", text }] }],
  };
}

function startRouter({ nativePort, routerPort, stateDir, backoffMs = 20, retries }) {
  return run({
    CODEX_ROUTER_PORT: String(routerPort),
    CODEX_NATIVE_BASE_URL: `http://127.0.0.1:${nativePort}/backend-api/codex`,
    CODEX_ROUTER_GATEWAY_BASE_URL: `http://127.0.0.1:${nativePort}/v1`,
    MODEL_ROUTER_STATE_DIR: stateDir,
    CODEX_ROUTER_NATIVE_RETRY_BACKOFF_MS: String(backoffMs),
    ...(retries === undefined ? {} : { CODEX_ROUTER_NATIVE_RETRIES: String(retries) }),
  });
}

function stateDirectory() {
  return mkdtempSync(path.join(os.tmpdir(), "native-retry-state-"));
}

// The reported failure: ChatGPT's edge answers a native turn with a 503 whose
// body says the connection reset *before headers*. Nothing was relayed, so the
// router can send it again and the caller never learns it happened.
test("a native 503 before headers is retried and the caller sees only the success", async () => {
  const attempts = [];
  const native = await mockServer(async (request, response) => {
    attempts.push(await readBody(request));
    if (attempts.length === 1) {
      response.writeHead(503, { "Content-Type": "text/plain" });
      response.end(EDGE_503_BODY);
      return;
    }
    const payload = Buffer.from(JSON.stringify({ id: "resp-retried", output: [] }), "utf8");
    response.writeHead(200, {
      "Content-Type": "application/json",
      "Content-Length": String(payload.length),
    });
    response.end(payload);
  });
  const stateDir = stateDirectory();
  const routerPort = await openPort();
  const router = startRouter({ nativePort: native.port, routerPort, stateDir });

  try {
    await waitFor(`${routerBase(routerPort)}/models`, router);
    const turn = largeNativeTurn();
    const result = await fetch(`${routerBase(routerPort)}/responses`, {
      method: "POST",
      headers: { Authorization: "Bearer caller", "Content-Type": "application/json" },
      body: JSON.stringify(turn),
    });

    const relayed = await result.text();
    assert.equal(result.status, 200, relayed);
    assert.equal(JSON.parse(relayed).id, "resp-retried");
    assert.equal(attempts.length, 2, "the 503 was relayed instead of retried");

    // Idempotency: the replayed request is the same bytes under the same
    // encoding, and it still decodes.
    assert.equal(attempts[0].encoding, "zstd");
    assert.equal(attempts[1].encoding, "zstd");
    assert.deepEqual(
      JSON.parse(attempts[1].text).input[0].content[0].text,
      turn.input[0].content[0].text,
    );
    assert.ok(
      attempts[0].raw.equals(attempts[1].raw),
      "the retry did not replay the first attempt's bytes",
    );

    // A silent retry would let a flaky upstream read as a healthy one.
    await waitUntil(
      () => /native upstream retry /.test(router.testErrors()),
      `no retry was logged: ${router.testErrors()}`,
    );
    assert.match(
      router.testErrors(),
      /\[codex-router\] native upstream retry 1\/2 status=503 model=gpt-5\.6-sol path=\/v1\/responses delayMs=\d+/,
    );
    // The logged path is the authenticated route the router already resolved,
    // never the caller capability in the URL it was dialed with.
    assert.equal(router.testErrors().includes(CALLER_KEY), false);

    await waitUntil(
      () => usageEvents(stateDir).length > 0,
      "no usage event was recorded",
    );
    const event = usageEvents(stateDir).at(-1);
    assert.equal(event.status, 200);
    assert.equal(event.provider, "openai");
    // Distinguishable from a first-attempt success, which records no field.
    assert.equal(event.retries, 1);
  } finally {
    await stopChild(router);
    await closeServer(native.server);
    rmSync(stateDir, { recursive: true, force: true });
  }
});

// The bound has to be a bound. Once it is spent the upstream's own answer
// reaches the caller untouched, exactly as it does today.
test("a native 503 that outlives the retry bound is relayed unchanged", async () => {
  const attempts = [];
  const native = await mockServer(async (request, response) => {
    attempts.push(await readBody(request));
    response.writeHead(503, { "Content-Type": "text/plain", "X-Edge": "envoy" });
    response.end(EDGE_503_BODY);
  });
  const stateDir = stateDirectory();
  const routerPort = await openPort();
  const router = startRouter({ nativePort: native.port, routerPort, stateDir });

  try {
    await waitFor(`${routerBase(routerPort)}/models`, router);
    const result = await fetch(`${routerBase(routerPort)}/responses`, {
      method: "POST",
      headers: { Authorization: "Bearer caller", "Content-Type": "application/json" },
      body: JSON.stringify({ model: "gpt-5.6-sol", input: "native turn" }),
    });

    assert.equal(result.status, 503);
    assert.equal(await result.text(), EDGE_503_BODY);
    assert.equal(result.headers.get("x-edge"), "envoy");
    // One first attempt plus the two the bound allows, and no more.
    assert.equal(attempts.length, 3);

    await waitUntil(
      () => usageEvents(stateDir).length > 0,
      "no usage event was recorded",
    );
    const event = usageEvents(stateDir).at(-1);
    assert.equal(event.status, 503);
    assert.equal(event.retries, 2);
  } finally {
    await stopChild(router);
    await closeServer(native.server);
    rmSync(stateDir, { recursive: true, force: true });
  }
});

// The constraint that must never break. Once any byte is on the wire the
// request is no longer replayable: a retry would append a second response to a
// stream the client is already reading.
test("an upstream failure after headers is never retried", async () => {
  const attempts = [];
  const native = await mockServer(async (request, response) => {
    attempts.push(await readBody(request));
    response.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache",
    });
    response.write('event: response.created\ndata: {"type":"response.created"}\n\n');
    // The edge drops a live stream: headers and one event already relayed.
    setTimeout(() => response.destroy(), 60);
  });
  const stateDir = stateDirectory();
  const routerPort = await openPort();
  const router = startRouter({ nativePort: native.port, routerPort, stateDir });

  try {
    await waitFor(`${routerBase(routerPort)}/models`, router);
    const result = await fetch(`${routerBase(routerPort)}/responses`, {
      method: "POST",
      headers: { Authorization: "Bearer caller", "Content-Type": "application/json" },
      body: JSON.stringify({ model: "gpt-5.6-sol", input: "native turn", stream: true }),
    });
    assert.equal(result.status, 200);
    const body = await result.text();

    // Give a would-be retry every chance to arrive before counting.
    await new Promise((resolve) => setTimeout(resolve, 500));
    assert.equal(attempts.length, 1, "a request that had already streamed was retried");

    // The decisive assertion: the caller received the partial stream exactly
    // once. A retry here would have duplicated it.
    assert.equal(body.match(/event: response\.created/g)?.length, 1, body);
    assert.match(body, /event: error/);
  } finally {
    await stopChild(router);
    await closeServer(native.server);
    rmSync(stateDir, { recursive: true, force: true });
  }
});

// 4xx is deterministic, and 429 is the one 5xx-adjacent status a retry makes
// actively worse: it is rate limiting, and the caller has to see it.
test("native 4xx and 429 responses are relayed without a retry", async () => {
  const attempts = [];
  const native = await mockServer(async (request, response) => {
    await readBody(request);
    attempts.push(request.url);
    const status = attempts.length === 1 ? 400 : 429;
    const payload = Buffer.from(JSON.stringify({ error: { code: status } }), "utf8");
    response.writeHead(status, {
      "Content-Type": "application/json",
      "Content-Length": String(payload.length),
      ...(status === 429 ? { "Retry-After": "30" } : {}),
    });
    response.end(payload);
  });
  const stateDir = stateDirectory();
  const routerPort = await openPort();
  const router = startRouter({ nativePort: native.port, routerPort, stateDir });

  try {
    await waitFor(`${routerBase(routerPort)}/models`, router);
    const headers = {
      Authorization: "Bearer caller",
      "Content-Type": "application/json",
    };
    const body = JSON.stringify({ model: "gpt-5.6-sol", input: "native turn" });

    const badRequest = await fetch(`${routerBase(routerPort)}/responses`, {
      method: "POST",
      headers,
      body,
    });
    assert.equal(badRequest.status, 400);
    assert.equal((await badRequest.json()).error.code, 400);

    const rateLimited = await fetch(`${routerBase(routerPort)}/responses`, {
      method: "POST",
      headers,
      body,
    });
    assert.equal(rateLimited.status, 429);
    // The upstream's own pacing instruction survives, which a retry loop that
    // swallowed 429 would have replaced with a burst of extra requests.
    assert.equal(rateLimited.headers.get("retry-after"), "30");

    assert.equal(attempts.length, 2, "a 4xx or 429 was retried");
    assert.equal(/native upstream retry /.test(router.testErrors()), false);
  } finally {
    await stopChild(router);
    await closeServer(native.server);
    rmSync(stateDir, { recursive: true, force: true });
  }
});

// A caller that walked away must not keep the router working on its behalf,
// least of all sleeping through a backoff for it.
test("a caller that disconnects mid-backoff stops the retries", async () => {
  let attempts = 0;
  let sawFirst;
  const firstAttempt = new Promise((resolve) => {
    sawFirst = resolve;
  });
  const native = await mockServer(async (request, response) => {
    attempts += 1;
    for await (const _chunk of request) {
      // Drain.
    }
    response.writeHead(503, { "Content-Type": "text/plain" });
    response.end(EDGE_503_BODY);
    sawFirst();
  });
  const stateDir = stateDirectory();
  const routerPort = await openPort();
  // A backoff long enough that the abort lands squarely inside it.
  const router = startRouter({
    nativePort: native.port,
    routerPort,
    stateDir,
    backoffMs: 1_500,
  });

  try {
    await waitFor(`${routerBase(routerPort)}/models`, router);
    const controller = new AbortController();
    const pending = fetch(`${routerBase(routerPort)}/responses`, {
      method: "POST",
      headers: { Authorization: "Bearer caller", "Content-Type": "application/json" },
      body: JSON.stringify({ model: "gpt-5.6-sol", input: "native turn" }),
      signal: controller.signal,
    }).catch((error) => error);

    await firstAttempt;
    controller.abort();
    const settled = await pending;
    assert.equal(settled?.name, "AbortError");

    // Well past the backoff the second attempt would have fired at.
    await new Promise((resolve) => setTimeout(resolve, 2_500));
    assert.equal(attempts, 1, "the router kept retrying for a caller that was gone");
  } finally {
    await stopChild(router);
    await closeServer(native.server);
    rmSync(stateDir, { recursive: true, force: true });
  }
});

// The reported reset reason is "remote connection failure": the edge could not
// reach the origin. Some of those arrive as a socket error rather than a 503,
// and they are the same class of failure -- nothing was served.
test("a connect failure is retried and an abort never is", async () => {
  const connectFailure = () => {
    const error = new TypeError("fetch failed");
    error.cause = Object.assign(new Error("connect ECONNREFUSED"), {
      code: "ECONNREFUSED",
    });
    return error;
  };
  let calls = 0;
  const retried = await fetchWithRetry(
    "http://upstream.invalid/responses",
    {},
    {
      retries: 2,
      backoffMs: 0,
      fetchImpl: async () => {
        calls += 1;
        if (calls < 3) throw connectFailure();
        return new Response("ok", { status: 200 });
      },
    },
  );
  assert.equal(calls, 3);
  assert.equal(retried.retries, 2);
  assert.equal(retried.response.status, 200);

  // An abort is the caller leaving, not an upstream failure.
  let abortCalls = 0;
  await assert.rejects(
    fetchWithRetry(
      "http://upstream.invalid/responses",
      {},
      {
        retries: 2,
        backoffMs: 0,
        fetchImpl: async () => {
          abortCalls += 1;
          const error = new Error("aborted");
          error.name = "AbortError";
          throw error;
        },
      },
    ),
    /aborted/,
  );
  assert.equal(abortCalls, 1);
});

// A 504 the edge spent half a minute producing is still a 504, but retrying it
// twice would turn a slow failure into a hang.
test("a retryable failure that was slow to arrive is not retried", async () => {
  let calls = 0;
  let clock = 0;
  const result = await fetchWithRetry(
    "http://upstream.invalid/responses",
    {},
    {
      retries: 2,
      backoffMs: 0,
      budgetMs: 5_000,
      now: () => clock,
      fetchImpl: async () => {
        calls += 1;
        clock += 30_000;
        return new Response("gateway timeout", { status: 504 });
      },
    },
  );
  assert.equal(calls, 1);
  assert.equal(result.retries, 0);
  assert.equal(result.response.status, 504);
});

// The predicate the router binds to `response.headersSent`. Even a retryable
// status must not be retried once the caller has been sent anything.
test("a retryable status is not retried once something has been relayed", async () => {
  let calls = 0;
  let relayed = false;
  const result = await fetchWithRetry(
    "http://upstream.invalid/responses",
    {},
    {
      retries: 3,
      backoffMs: 0,
      canRetry: () => !relayed,
      fetchImpl: async () => {
        calls += 1;
        relayed = true;
        return new Response("upstream connect error", { status: 503 });
      },
    },
  );
  assert.equal(calls, 1);
  assert.equal(result.retries, 0);
  assert.equal(result.response.status, 503);
});

// A retried turn costs a duplicated request; a retried image generation costs
// the operator a second billed image. The retryable statuses were chosen to
// mean "no response was obtained", but that is reasoning rather than anything
// observable from here, and Cloudflare can emit 520 after reaching the origin.
// So the billed path keeps the pre-retry behaviour, and this test is what stops
// it being switched on again by someone generalizing the turn path.
test("an image generation is never retried, however retryable the failure looks", async () => {
  const attempts = [];
  const native = await mockServer(async (request, response) => {
    attempts.push(await readBody(request));
    response.writeHead(503, { "Content-Type": "text/plain" });
    response.end(EDGE_503_BODY);
  });
  const stateDir = stateDirectory();
  const routerPort = await openPort();
  const router = startRouter({ nativePort: native.port, routerPort, stateDir });

  try {
    await waitFor(`${routerBase(routerPort)}/models`, router);
    const result = await fetch(`${routerBase(routerPort)}/images/generations`, {
      method: "POST",
      headers: { Authorization: "Bearer caller", "Content-Type": "application/json" },
      body: JSON.stringify({ model: "gpt-image-1", prompt: "a billed image" }),
    });

    assert.equal(result.status, 503, "the upstream failure must reach the caller");
    assert.equal(
      attempts.length,
      1,
      `a billed image generation was sent ${attempts.length} times`,
    );
  } finally {
    await stopChild(router);
    await closeServer(native.server);
    rmSync(stateDir, { recursive: true, force: true });
  }
});
