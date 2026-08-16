import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";

import { writeJson } from "../src/http-utils.mjs";
import { GEMINI_ROUTE_PREFIX, handleGeminiRequest, isGeminiRoute } from "../src/gemini-surface.mjs";

const MODELS = [
  { slug: "vendor/model", displayName: "Vendor Model", contextWindow: 262144 },
  { slug: "other/model", displayName: "Other Model", contextWindow: 128000 },
];

// A stand-in for the router's own /v1/responses endpoint. The surface reaches
// it over the loopback exactly as it would in the service, so these exercise
// the real request the CLI's turn becomes.
function upstream(handler) {
  const seen = [];
  const server = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = Buffer.concat(chunks).toString("utf8");
    seen.push({ headers: request.headers, body: body ? JSON.parse(body) : undefined });
    handler(request, response, seen[seen.length - 1]);
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve({
        seen,
        url: `http://127.0.0.1:${server.address().port}/v1/responses`,
        close: () => new Promise((done) => server.close(done)),
      });
    });
  });
}

function surface(responsesUrl, { abortRequestSignal = false } = {}) {
  const server = http.createServer(async (request, response) => {
    const route = new URL(request.url, "http://127.0.0.1").pathname;
    if (isGeminiRoute(route)) {
      if (abortRequestSignal) {
        // What Node 24 does on its own: `IncomingMessage.signal` aborts once the
        // request body has been read, which is before the loopback call is made.
        Object.defineProperty(request, "signal", { value: AbortSignal.abort() });
      }
      await handleGeminiRequest(request, response, route, {
        responsesUrl,
        routedModels: () => MODELS,
      });
      return;
    }
    writeJson(response, 404, { error: { type: "not_found" } });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve({
        url: (path) => `http://127.0.0.1:${server.address().port}${GEMINI_ROUTE_PREFIX}${path}`,
        close: () => new Promise((done) => server.close(done)),
      });
    });
  });
}

function sse(response, events) {
  response.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache",
  });
  for (const [type, data] of events) {
    response.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
  }
  response.end("data: [DONE]\n\n");
}

function frames(text) {
  return text
    .split("\n\n")
    .map((block) => block.split("\n").find((line) => line.startsWith("data: ")))
    .filter(Boolean)
    .map((line) => line.slice("data: ".length))
    .filter((payload) => payload !== "[DONE]")
    .map((payload) => JSON.parse(payload));
}

test("only the gemini leaf is claimed", () => {
  assert.equal(isGeminiRoute("/gemini/v1beta/models"), true);
  assert.equal(isGeminiRoute("/gemini"), true);
  assert.equal(isGeminiRoute("/v1/responses"), false);
  assert.equal(isGeminiRoute("/gemini-other/v1beta/models"), false);
});

test("the model list serves the routed set", async () => {
  const app = await surface("http://127.0.0.1:1/v1/responses");
  try {
    const response = await fetch(app.url("/v1beta/models"));
    const payload = await response.json();
    assert.equal(response.status, 200);
    assert.deepEqual(
      payload.models.map((model) => model.name),
      ["models/vendor/model", "models/other/model"],
    );
  } finally {
    await app.close();
  }
});

test("a turn reaches the router's own Responses endpoint", async () => {
  const back = await upstream((request, response) => {
    writeJson(response, 200, {
      id: "resp_1",
      status: "completed",
      output: [
        { type: "message", role: "assistant", content: [{ type: "output_text", text: "hi" }] },
      ],
      usage: { input_tokens: 3, output_tokens: 1, total_tokens: 4 },
    });
  });
  const app = await surface(back.url);
  try {
    const response = await fetch(app.url("/v1beta/models/vendor/model:generateContent"), {
      method: "POST",
      headers: { "content-type": "application/json", "x-goog-api-key": "caller-secret" },
      body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: "hello" }] }] }),
    });
    const payload = await response.json();
    assert.equal(response.status, 200);
    assert.deepEqual(payload.candidates[0].content.parts, [{ text: "hi" }]);
    assert.equal(payload.candidates[0].finishReason, "STOP");
    assert.equal(payload.usageMetadata.promptTokenCount, 3);
    assert.equal(back.seen[0].body.model, "vendor/model");
    assert.equal(back.seen[0].body.stream, false);
  } finally {
    await app.close();
    await back.close();
  }
});

test("the caller's own key is never relayed upstream", async () => {
  // The key the CLI sends is this router's caller capability. Forwarding it on
  // the loopback would put a router secret into a request that can be
  // substituted onto a real provider hop -- and `callerBroughtNoUpstreamCredential`
  // is what lets a client with no ChatGPT session of its own reach native models.
  const back = await upstream((request, response) => {
    writeJson(response, 200, { status: "completed", output: [] });
  });
  const app = await surface(back.url);
  try {
    await fetch(app.url("/v1beta/models/vendor/model:generateContent"), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-goog-api-key": "caller-secret",
        authorization: "Bearer caller-secret",
      },
      body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: "hi" }] }] }),
    });
    assert.equal(back.seen[0].headers.authorization, undefined);
    assert.equal(back.seen[0].headers["x-goog-api-key"], undefined);
  } finally {
    await app.close();
    await back.close();
  }
});

test("an already-aborted request signal does not cancel the turn", async () => {
  // `IncomingMessage.signal` does not exist before Node 22, and on Node 24 it
  // aborts as soon as the request body has been read -- which is *before* the
  // loopback call is made, so passing it through failed every routed turn with
  // an instant 502 on CI while passing locally on a Node that has no `signal`
  // at all. The turn's lifetime is tied to the response closing instead.
  const back = await upstream((request, response) => {
    writeJson(response, 200, {
      status: "completed",
      output: [
        { type: "message", role: "assistant", content: [{ type: "output_text", text: "alive" }] },
      ],
    });
  });
  const app = await surface(back.url, { abortRequestSignal: true });
  try {
    const response = await fetch(app.url("/v1beta/models/vendor/model:generateContent"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: "hi" }] }] }),
    });
    assert.equal(response.status, 200);
    assert.deepEqual((await response.json()).candidates[0].content.parts, [{ text: "alive" }]);
    assert.equal(back.seen.length, 1);
  } finally {
    await app.close();
    await back.close();
  }
});

test("a loopback failure names its cause instead of swallowing it", async () => {
  // The first cut answered a failed loopback with a bare "could not be reached",
  // so a CI run that failed on every turn had nothing in it to say why.
  const app = await surface("http://127.0.0.1:1/v1/responses");
  try {
    const response = await fetch(app.url("/v1beta/models/vendor/model:generateContent"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: "hi" }] }] }),
    });
    assert.equal(response.status, 502);
    const { error } = await response.json();
    assert.match(error.message, /could not be reached/);
    // The cause chain, not just the summary: a bare TypeError names nothing.
    assert.match(error.message, /ECONNREFUSED|TypeError/);
  } finally {
    await app.close();
  }
});

test("a streamed turn arrives as whole Gemini responses in SSE frames", async () => {
  const back = await upstream((request, response) => {
    sse(response, [
      ["response.output_text.delta", { delta: "he" }],
      ["response.output_text.delta", { delta: "llo" }],
      [
        "response.completed",
        {
          response: {
            id: "resp_2",
            status: "completed",
            usage: { input_tokens: 5, output_tokens: 2, total_tokens: 7 },
          },
        },
      ],
    ]);
  });
  const app = await surface(back.url);
  try {
    const response = await fetch(
      app.url("/v1beta/models/vendor/model:streamGenerateContent?alt=sse"),
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: "hi" }] }] }),
      },
    );
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type"), /text\/event-stream/);
    const parsed = frames(await response.text());
    assert.deepEqual(
      parsed.slice(0, 2).map((chunk) => chunk.candidates[0].content.parts[0].text),
      ["he", "llo"],
    );
    const last = parsed[parsed.length - 1];
    assert.equal(last.candidates[0].finishReason, "STOP");
    assert.equal(last.usageMetadata.totalTokenCount, 7);
    assert.equal(back.seen[0].body.stream, true);
  } finally {
    await app.close();
    await back.close();
  }
});

test("a stream the upstream drops still ends with a finish reason", async () => {
  const back = await upstream((request, response) => {
    response.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8" });
    response.write(
      `event: response.output_text.delta\ndata: ${JSON.stringify({
        type: "response.output_text.delta",
        delta: "partial",
      })}\n\n`,
    );
    response.end();
  });
  const app = await surface(back.url);
  try {
    const response = await fetch(app.url("/v1beta/models/vendor/model:streamGenerateContent?alt=sse"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: "hi" }] }] }),
    });
    const parsed = frames(await response.text());
    assert.equal(parsed[parsed.length - 1].candidates[0].finishReason, "STOP");
  } finally {
    await app.close();
    await back.close();
  }
});

test("an upstream refusal is reported in the Gemini error shape", async () => {
  const back = await upstream((request, response) => {
    writeJson(response, 429, {
      error: { type: "rate_limit_error", message: "provider is out of quota" },
    });
  });
  const app = await surface(back.url);
  try {
    const response = await fetch(app.url("/v1beta/models/vendor/model:generateContent"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: "hi" }] }] }),
    });
    const payload = await response.json();
    assert.equal(response.status, 429);
    assert.equal(payload.error.code, 429);
    assert.equal(payload.error.status, "RESOURCE_EXHAUSTED");
    assert.match(payload.error.message, /out of quota/);
  } finally {
    await app.close();
    await back.close();
  }
});

test("a model that is not routed is refused by name", async () => {
  // Falling through would send the slug to /v1/responses, where an unregistered
  // model is treated as native GPT traffic -- so a typo would silently become a
  // ChatGPT-session request rather than an error the user can read.
  const app = await surface("http://127.0.0.1:1/v1/responses");
  try {
    const response = await fetch(app.url("/v1beta/models/vendor/missing:generateContent"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ contents: [] }),
    });
    const payload = await response.json();
    assert.equal(response.status, 404);
    assert.equal(payload.error.status, "NOT_FOUND");
    assert.match(payload.error.message, /vendor\/missing/);
  } finally {
    await app.close();
  }
});

test("countTokens answers without spending a turn", async () => {
  const back = await upstream(() => {
    throw new Error("countTokens must not reach the provider");
  });
  const app = await surface(back.url);
  try {
    const response = await fetch(app.url("/v1beta/models/vendor/model:countTokens"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: "x".repeat(400) }] }] }),
    });
    const payload = await response.json();
    assert.equal(response.status, 200);
    assert.ok(payload.totalTokens > 0);
    assert.equal(back.seen.length, 0);
  } finally {
    await app.close();
    await back.close();
  }
});

test("embeddings are refused in a way that names the limit", async () => {
  const app = await surface("http://127.0.0.1:1/v1/responses");
  try {
    const response = await fetch(app.url("/v1beta/models/vendor/model:embedContent"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: { parts: [{ text: "hi" }] } }),
    });
    const payload = await response.json();
    assert.equal(response.status, 501);
    assert.equal(payload.error.status, "UNIMPLEMENTED");
    assert.match(payload.error.message, /embedding/i);
  } finally {
    await app.close();
  }
});

test("a streaming request without alt=sse is refused rather than answered wrongly", async () => {
  // Without `alt=sse` the real API answers with a JSON array, not an event
  // stream. Serving SSE anyway would hand a client a body it cannot parse.
  const app = await surface("http://127.0.0.1:1/v1/responses");
  try {
    const response = await fetch(app.url("/v1beta/models/vendor/model:streamGenerateContent"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ contents: [] }),
    });
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error.status, "INVALID_ARGUMENT");
  } finally {
    await app.close();
  }
});

test("an unknown gemini path is a 404, not a crash", async () => {
  const app = await surface("http://127.0.0.1:1/v1/responses");
  try {
    const response = await fetch(app.url("/v1beta/tunedModels/x:generateContent"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    assert.equal(response.status, 404);
  } finally {
    await app.close();
  }
});

test("a browser-originated request is rejected the way the routed path rejects one", async () => {
  const app = await surface("http://127.0.0.1:1/v1/responses");
  try {
    const response = await fetch(app.url("/v1beta/models/vendor/model:generateContent"), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "https://example.com",
      },
      body: JSON.stringify({ contents: [] }),
    });
    assert.equal(response.status, 403);
  } finally {
    await app.close();
  }
});
