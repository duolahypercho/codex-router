import assert from "node:assert/strict";
import { Readable } from "node:stream";
import test from "node:test";

const { generateEndpoint, relayCommandCodeGenerate } = await import(
  "../src/commandcode-relay.mjs"
);

const AT = Date.parse("2026-08-16T09:00:00.000Z");
const MODEL = { gatewayModel: "commandcode-deepseek-v4-flash", upstreamModel: "deepseek/deepseek-v4-flash" };
const OPENAI_PROVIDER = { id: "commandcode", ownedBy: "commandcode" };
const ANTHROPIC_PROVIDER = { id: "commandcode-messages", ownedBy: "commandcode", protocol: "anthropic" };

function fakeResponse() {
  const captured = { status: undefined, headers: undefined, body: "", ended: false };
  // `setHeader`/`getHeader` are part of the surface the relay uses: the SSE
  // head seats its content type through them so a terminal error frame can
  // later tell this is an event stream (see writeEventStreamHead).
  const seated = new Map();
  return {
    captured,
    setHeader(name, value) {
      seated.set(name, value);
    },
    getHeader(name) {
      const wanted = String(name).toLowerCase();
      for (const [key, value] of seated) {
        if (key.toLowerCase() === wanted) return value;
      }
      return undefined;
    },
    writeHead(status, headers) {
      captured.status = status;
      captured.headers = { ...Object.fromEntries(seated), ...headers };
    },
    write(chunk) {
      captured.body += chunk;
    },
    end(chunk) {
      if (chunk) captured.body += chunk;
      captured.ended = true;
    },
  };
}

function ndjson(events) {
  return Readable.from(
    events.map((event) => Buffer.from(`${JSON.stringify(event)}\n`, "utf8")),
  );
}

function upstreamOk(events) {
  return {
    ok: true,
    status: 200,
    headers: new Headers({ "x-ratelimit-remaining-requests": "41" }),
    body: ndjson(events),
  };
}

const TURN = [
  { type: "start" },
  { type: "text-start", id: "t" },
  { type: "text-delta", id: "t", text: "OK" },
  { type: "text-end", id: "t" },
  { type: "finish-step", finishReason: "stop", usage: { inputTokens: 5, outputTokens: 1, totalTokens: 6 } },
];

// The registry points the provider at /provider/v1 because that is where the
// documented API lives; the CLI route hangs off the origin instead.
test("the route is derived from whatever base url is in force", () => {
  assert.equal(
    generateEndpoint("https://api.commandcode.ai/provider/v1"),
    "https://api.commandcode.ai/alpha/generate",
  );
  assert.equal(
    generateEndpoint("http://127.0.0.1:9090/provider/v1/"),
    "http://127.0.0.1:9090/alpha/generate",
  );
});

test("a streaming turn is translated to openai chunks", async () => {
  const response = fakeResponse();
  let seen;
  const outcome = await relayCommandCodeGenerate({
    payload: { model: "x", stream: true, messages: [{ role: "user", content: "hi" }] },
    model: MODEL,
    provider: OPENAI_PROVIDER,
    apiKey: "user_key",
    baseUrl: "https://api.commandcode.ai/provider/v1",
    response,
    at: AT,
    fetchImpl: async (url, init) => {
      seen = { url, init };
      return upstreamOk(TURN);
    },
  });
  assert.equal(outcome.status, 200);
  // The upstream's own headers travel back so this route reports quota and
  // cooldowns exactly as a provider forwarded intact does.
  assert.equal(outcome.headers.get("x-ratelimit-remaining-requests"), "41");
  assert.equal(seen.url, "https://api.commandcode.ai/alpha/generate");
  assert.equal(seen.init.headers.Authorization, "Bearer user_key");
  // The upstream model id travels, not the gateway id the caller used.
  assert.equal(JSON.parse(seen.init.body).params.model, "deepseek/deepseek-v4-flash");
  assert.match(response.captured.headers["Content-Type"], /^text\/event-stream\b/);
  assert.match(response.captured.body, /"content":"OK"/);
  assert.ok(response.captured.body.endsWith("data: [DONE]\n\n"));
  assert.equal(response.captured.ended, true);
});

test("a non-streaming caller gets one assembled json body", async () => {
  const response = fakeResponse();
  const status = await relayCommandCodeGenerate({
    payload: { model: "x", messages: [{ role: "user", content: "hi" }] },
    model: MODEL,
    provider: OPENAI_PROVIDER,
    apiKey: "user_key",
    baseUrl: "https://api.commandcode.ai/provider/v1",
    response,
    at: AT,
    fetchImpl: async () => upstreamOk(TURN),
  });
  assert.equal(status.status, 200);
  assert.equal(response.captured.headers["Content-Type"], "application/json");
  const body = JSON.parse(response.captured.body);
  assert.equal(body.object, "chat.completion");
  assert.equal(body.choices[0].message.content, "OK");
  assert.equal(body.model, MODEL.gatewayModel);
});

test("an anthropic caller gets anthropic events", async () => {
  const response = fakeResponse();
  await relayCommandCodeGenerate({
    payload: { model: "x", stream: true, max_tokens: 128, messages: [{ role: "user", content: "hi" }] },
    model: MODEL,
    provider: ANTHROPIC_PROVIDER,
    apiKey: "user_key",
    baseUrl: "https://api.commandcode.ai/provider/v1",
    response,
    at: AT,
    fetchImpl: async () => upstreamOk(TURN),
  });
  assert.match(response.captured.body, /^event: message_start\n/);
  assert.match(response.captured.body, /event: message_stop/);
  assert.doesNotMatch(response.captured.body, /\[DONE\]/);
});

// The gateway's own message is what tells the operator to top up or upgrade;
// a generic proxy error would send them looking at the router instead.
test("an upstream refusal is relayed with its own status and message", async () => {
  const response = fakeResponse();
  const status = await relayCommandCodeGenerate({
    payload: { model: "x", stream: true, messages: [] },
    model: MODEL,
    provider: OPENAI_PROVIDER,
    apiKey: "user_key",
    baseUrl: "https://api.commandcode.ai/provider/v1",
    response,
    at: AT,
    fetchImpl: async () => ({
      ok: false,
      status: 402,
      headers: new Headers({ "retry-after": "60" }),
      text: async () => JSON.stringify({ success: false, message: "insufficient credits" }),
    }),
  });
  assert.equal(status.status, 402);
  assert.equal(status.ok, false);
  assert.equal(status.headers.get("retry-after"), "60");
  assert.equal(response.captured.status, 402);
  assert.equal(JSON.parse(response.captured.body).error.message, "insufficient credits");
});

test("a pooled refusal can be returned without committing the caller response", async () => {
  const response = fakeResponse();
  const outcome = await relayCommandCodeGenerate({
    payload: { model: "x", stream: true, messages: [] },
    model: MODEL,
    provider: OPENAI_PROVIDER,
    apiKey: "revoked_key",
    baseUrl: "https://api.commandcode.ai/provider/v1",
    response,
    deferErrors: true,
    at: AT,
    fetchImpl: async () => ({
      ok: false,
      status: 401,
      headers: new Headers({ "retry-after": "90" }),
      text: async () => JSON.stringify({ success: false, message: "credential revoked" }),
    }),
  });
  assert.equal(outcome.status, 401);
  assert.equal(outcome.ok, false);
  assert.equal(outcome.committed, false);
  assert.equal(outcome.headers.get("retry-after"), "90");
  assert.equal(JSON.parse(outcome.bodyText).error.message, "credential revoked");
  assert.equal(outcome.responseHeaders["Content-Type"], "application/json");
  assert.equal(response.captured.status, undefined);
  assert.equal(response.captured.body, "");
  assert.equal(response.captured.ended, false);
});

test("a mid-stream failure is reported inside the stream and still terminates", async () => {
  const response = fakeResponse();
  const status = await relayCommandCodeGenerate({
    payload: { model: "x", stream: true, messages: [] },
    model: MODEL,
    provider: OPENAI_PROVIDER,
    apiKey: "user_key",
    baseUrl: "https://api.commandcode.ai/provider/v1",
    response,
    at: AT,
    fetchImpl: async () =>
      upstreamOk([
        { type: "start" },
        { type: "text-start", id: "t" },
        { type: "text-delta", id: "t", text: "par" },
        { type: "error", error: { message: "premium_credits_exhausted" } },
      ]),
  });
  assert.equal(status.status, 200);
  assert.match(response.captured.body, /premium_credits_exhausted/);
  assert.doesNotMatch(response.captured.body, /\[DONE\]|"finish_reason":"stop"/);
});

test("incomplete Command Code generations cannot become successful answers or deferred retries", async () => {
  const prefix = TURN.slice(0, -1).map((event) => `${JSON.stringify(event)}\n`).join("");
  const cases = [
    Buffer.from(prefix),
    Buffer.from(`${prefix}${JSON.stringify({ type: "finish-step", finishReason: "error" })}\n`),
    Buffer.from(`${prefix}${JSON.stringify({ type: "finish-step", finishReason: "error" })}\n${JSON.stringify(TURN.at(-1))}\n`),
    Buffer.from(`${prefix}${JSON.stringify({ type: "finish", finishReason: "unsupported-reason" })}\n`),
    Buffer.from(`${prefix}${JSON.stringify({ type: "finish", finishReason: "unknown" })}\n`),
    Buffer.from(`${prefix}${JSON.stringify({ type: "finish", finishReason: "other" })}\n`),
    Buffer.from(`${prefix}{"type":"text-delta","text":"PRIVATE_BAD_EVENT"\n${JSON.stringify(TURN.at(-1))}\n`),
    Buffer.concat([Buffer.from(prefix), Buffer.from([0xe4, 0xb8])]),
  ];
  for (const provider of [OPENAI_PROVIDER, ANTHROPIC_PROVIDER]) {
    for (const stream of [false, true]) {
      for (const bytes of cases) {
        const response = fakeResponse();
        let submissions = 0;
        const outcome = await relayCommandCodeGenerate({
          payload: { model: "x", stream, messages: [] },
          model: MODEL, provider, apiKey: "synthetic_key",
          baseUrl: "https://fixture.invalid/provider/v1", response, deferErrors: true, at: AT,
          fetchImpl: async () => {
            submissions += 1;
            return { ok: true, status: 200, headers: new Headers(), body: Readable.from([bytes]) };
          },
        });
        assert.equal(outcome.committed, true);
        assert.equal(response.captured.ended, true);
        assert.equal(submissions, 1);
        if (stream) {
          assert.equal(response.captured.status, 200);
          assert.match(response.captured.body, /error/);
          assert.doesNotMatch(response.captured.body, /\[DONE\]|"finish_reason":"stop"|"stop_reason":"end_turn"/);
        } else {
          assert.equal(response.captured.status, 502);
          assert.equal(JSON.parse(response.captured.body).error.type, "commandcode_generate_error");
        }
        assert.doesNotMatch(response.captured.body, /PRIVATE_BAD_EVENT/);
      }
    }
  }
});

test("SSE comments preserve relay replies with known terminal reasons", async () => {
  for (const provider of [OPENAI_PROVIDER, ANTHROPIC_PROVIDER]) {
    for (const stream of [false, true]) {
      for (const finishReason of ["stop", "length"]) {
        const response = fakeResponse();
        const events = [...TURN.slice(0, -1), { ...TURN.at(-1), finishReason }];
        const bytes = Buffer.from(": keepalive\r\n" + events.map((event) => `data: ${JSON.stringify(event)}\r\n\r\n`).join(""));
        let submissions = 0;
        const outcome = await relayCommandCodeGenerate({
          payload: { model: "x", stream, messages: [] }, model: MODEL, provider,
          apiKey: "synthetic_key", baseUrl: "https://fixture.invalid/provider/v1", response, at: AT,
          fetchImpl: async () => { submissions += 1; return { ...upstreamOk([]), body: Readable.from([bytes]) }; },
        });
        assert.equal(outcome.status, 200);
        assert.equal(response.captured.status, 200);
        assert.equal(response.captured.ended, true);
        assert.equal(submissions, 1);
        assert.match(response.captured.body, /OK/);
        assert.doesNotMatch(response.captured.body, /commandcode_generate_error/);
        if (stream) assert.match(response.captured.body, provider.protocol === "anthropic" ? /message_stop/ : /\[DONE\]/);
      }
    }
  }
});

test("malformed tool arguments fail both streamed and buffered relay protocols without replay", async () => {
  for (const provider of [OPENAI_PROVIDER, ANTHROPIC_PROVIDER]) {
    for (const stream of [false, true]) {
      const response = fakeResponse();
      let submissions = 0;
      const outcome = await relayCommandCodeGenerate({
        payload: { model: "x", stream, messages: [] }, model: MODEL, provider,
        apiKey: "synthetic_key", baseUrl: "https://fixture.invalid/provider/v1", response, deferErrors: true, at: AT,
        fetchImpl: async () => { submissions += 1; return upstreamOk([
          { type: "tool-input-start", id: "call", toolName: "read_file" },
          { type: "tool-input-delta", id: "call", delta: "{bad" },
          { type: "tool-input-end", id: "call" },
          { type: "finish", finishReason: "tool-calls" },
        ]); },
      });
      assert.equal(outcome.committed, true);
      assert.equal(response.captured.ended, true);
      assert.equal(submissions, 1);
      assert.match(response.captured.body, /unreadable tool arguments/);
      assert.doesNotMatch(response.captured.body, /\[DONE\]|message_stop/);
      assert.equal(response.captured.status, stream ? 200 : 502);
    }
  }
});

test("a truncated generation commits its failure before a second pooled key can run", async () => {
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { upsertProviderApiKey, runProviderApiKeyAttempts } = await import("../src/provider-api-key-pool.mjs");
  const directory = mkdtempSync(join(tmpdir(), "commandcode-truncated-pool-"));
  const filePath = join(directory, "pools.json");
  try {
    for (const id of ["cred_first_12345678", "cred_second_12345678"]) {
      await upsertProviderApiKey("commandcode", { id }, { filePath });
    }
    for (const stream of [false, true]) {
      let submissions = 0;
      const response = fakeResponse();
      const result = await runProviderApiKeyAttempts("commandcode", {
        filePath, resolveCredential: (id) => id, backoffMs: 0,
        isResponseCommitted: () => response.captured.ended,
        send: ({ apiKey }) => relayCommandCodeGenerate({
          payload: { model: "x", stream, messages: [] }, model: MODEL, provider: OPENAI_PROVIDER,
          apiKey, baseUrl: "https://fixture.invalid/provider/v1", response, deferErrors: true, at: AT,
          fetchImpl: async () => { submissions += 1; return upstreamOk(TURN.slice(0, -1)); },
        }),
      });
      assert.equal(submissions, 1);
      assert.equal(response.captured.status, stream ? 200 : 502);
      assert.equal(result.committed, true);
      assert.equal(result.attempts.length, 1);
      // The pool records HTTP/credential health, not the generation outcome.
      // An already-committed 200 stream carries the latter in its error frame.
      assert.equal(result.attempts[0].ok, stream);
      assert.match(response.captured.body, /error/);
      assert.doesNotMatch(response.captured.body, /\[DONE\]|"finish_reason":"stop"/);
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});


test("unreadable buffered Anthropic tool input fails once instead of becoming an empty tool call", async () => {
  const response = fakeResponse();
  const outcome = await relayCommandCodeGenerate({
    payload: { stream: false, messages: [] }, model: MODEL, provider: ANTHROPIC_PROVIDER,
    apiKey: "synthetic_key", baseUrl: "https://fixture.invalid/provider/v1",
    response, deferErrors: true, at: AT,
    fetchImpl: async () => upstreamOk([
      { type: "tool-input-start", id: "t", toolName: "read_file" },
      { type: "tool-input-delta", id: "t", delta: '{"path":' },
      { type: "tool-input-end", id: "t" },
      { type: "finish-step", finishReason: "tool-calls" },
    ]),
  });
  assert.equal(response.captured.status, 502);
  assert.equal(outcome.committed, true);
  assert.match(response.captured.body, /unreadable tool arguments/);
  assert.doesNotMatch(response.captured.body, /"input":\{\}/);
});


function resetAfterPartial({ controller, name = "Error" } = {}) {
  const error = Object.assign(new Error("PRIVATE_RESET_DETAIL"), { code: "ECONNRESET", name });
  return {
    ...upstreamOk([]),
    body: Readable.from((async function* () {
      yield Buffer.from(TURN.slice(0, -1).map((event) => `${JSON.stringify(event)}\n`).join(""));
      await new Promise(setImmediate);
      controller?.abort();
      throw error;
    })()),
  };
}

test("a reset after partial Command Code output commits an error without a success terminal", async () => {
  for (const provider of [OPENAI_PROVIDER, ANTHROPIC_PROVIDER]) {
    for (const stream of [false, true]) {
      for (const name of ["Error", "AbortError"]) {
        const response = fakeResponse();
        const outcome = await relayCommandCodeGenerate({
          payload: { stream, messages: [] }, model: MODEL, provider,
          apiKey: "synthetic_key", baseUrl: "https://fixture.invalid/provider/v1",
          response, deferErrors: true, at: AT,
          fetchImpl: async () => resetAfterPartial({ name }),
        });
        assert.equal(outcome.committed, true);
        assert.equal(response.captured.ended, true);
        assert.equal(response.captured.status, stream ? 200 : 502);
        assert.match(response.captured.body, /error/);
        assert.doesNotMatch(response.captured.body, /PRIVATE_RESET_DETAIL|\[DONE\]|"finish_reason":"stop"|"stop_reason":"end_turn"/);
      }
    }
  }
});

test("partial resets and actual caller cancellation cannot advance a Command Code key pool", async () => {
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { upsertProviderApiKey, runProviderApiKeyAttempts } = await import("../src/provider-api-key-pool.mjs");
  const directory = mkdtempSync(join(tmpdir(), "commandcode-reset-pool-"));
  const filePath = join(directory, "pools.json");
  try {
    for (const id of ["cred_first_12345678", "cred_second_12345678"]) {
      await upsertProviderApiKey("commandcode", { id }, { filePath });
    }
    for (const cancel of [false, true]) {
      for (const stream of [false, true]) {
        let submissions = 0;
        const controller = cancel ? new AbortController() : undefined;
        const response = fakeResponse();
        const result = await runProviderApiKeyAttempts("commandcode", {
          filePath, resolveCredential: (id) => id, backoffMs: 0,
          isResponseCommitted: () => response.captured.status !== undefined,
          send: ({ apiKey }) => relayCommandCodeGenerate({
            payload: { stream, messages: [] }, model: MODEL, provider: OPENAI_PROVIDER,
            apiKey, baseUrl: "https://fixture.invalid/provider/v1", response,
            signal: controller?.signal, deferErrors: true, at: AT,
            fetchImpl: async () => { submissions += 1; return resetAfterPartial({ controller }); },
          }),
        });
        assert.equal(submissions, 1);
        assert.equal(result.attempts.length, 1);
        if (cancel) {
          assert.equal(result.error, controller.signal.reason);
          assert.equal(response.captured.ended, false, "the caller owns cancellation");
          assert.doesNotMatch(response.captured.body, /PRIVATE_RESET_DETAIL|\[DONE\]|"type":"commandcode_generate_error"/);
        } else {
          assert.equal(result.committed, true);
          assert.equal(response.captured.status, stream ? 200 : 502);
          assert.match(response.captured.body, /error/);
        }
      }
    }
    // Unlike a generation-body reset, an explicit HTTP refusal can still
    // select the second credential before anything is committed to the caller.
    let submissions = 0;
    const response = fakeResponse();
    // This control tests refusal policy, not host filesystem latency.
    const refusalAt = Date.now();
    const result = await runProviderApiKeyAttempts("commandcode", {
      filePath, resolveCredential: (id) => id, backoffMs: 0, now: () => refusalAt,
      isResponseCommitted: () => response.captured.status !== undefined,
      send: ({ apiKey }) => relayCommandCodeGenerate({
        payload: { messages: [] }, model: MODEL, provider: OPENAI_PROVIDER,
        apiKey, baseUrl: "https://fixture.invalid/provider/v1", response, deferErrors: true, at: AT,
        fetchImpl: async () => ++submissions === 1
          ? { ok: false, status: 401, headers: new Headers(), text: async () => "credential refused" }
          : upstreamOk(TURN),
      }),
    });
    assert.equal(submissions, 2);
    assert.equal(result.attempts.length, 2);
    assert.equal(response.captured.status, 200);
    assert.equal(JSON.parse(response.captured.body).choices[0].message.content, "OK");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
