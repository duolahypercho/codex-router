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
  return {
    captured,
    writeHead(status, headers) {
      captured.status = status;
      captured.headers = headers;
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
  assert.equal(response.captured.headers["Content-Type"], "text/event-stream");
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
  assert.ok(response.captured.body.endsWith("data: [DONE]\n\n"));
});
