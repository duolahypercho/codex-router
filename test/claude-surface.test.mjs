import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";

import {
  claudeMessagesToResponses,
  handleClaudeRequest,
} from "../src/claude-surface.mjs";

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(server.address().port));
  });
}

function close(server) { return new Promise((resolve) => server.close(resolve)); }

function sse(response, events, { end = true } = {}) {
  response.writeHead(200, { "content-type": "text/event-stream" });
  for (const event of events) response.write(`data: ${JSON.stringify(event)}\n\n`);
  if (end) response.end();
}

function routedModels() {
  return {
    engine: "test",
    models: [
      { slug: "openai/gpt-test", displayName: "GPT Test", priority: 10 },
      { slug: "deepseek/test", displayName: "DeepSeek Test", priority: 5 },
    ],
  };
}

async function fixture(handler) {
  const upstream = http.createServer(handler);
  const upstreamPort = await listen(upstream);
  const surface = http.createServer((request, response) => {
    const route = new URL(request.url, `http://${request.headers.host}`).pathname;
    handleClaudeRequest(request, response, route, {
      responsesUrl: `http://127.0.0.1:${upstreamPort}/v1/responses`,
      routedModels,
    });
  });
  const surfacePort = await listen(surface);
  return {
    baseUrl: `http://127.0.0.1:${surfacePort}/anthropic`,
    close: () => Promise.all([close(surface), close(upstream)]),
  };
}

test("Claude Code discovers the complete routed catalog under Anthropic-shaped ids", async () => {
  const app = await fixture((_request, response) => {
    response.writeHead(500);
    response.end();
  });
  try {
    const hello = await fetch(`${app.baseUrl}/api/hello`, { method: "HEAD" });
    assert.equal(hello.status, 200);
    const catalog = await fetch(`${app.baseUrl}/v1/models?limit=1000`).then((response) => response.json());
    assert.deepEqual(catalog.data.map((model) => model.id), [
      "codex_router/anthropic/openai/gpt-test",
      "codex_router/anthropic/deepseek/test",
    ]);
    assert.equal(catalog.has_more, false);
  } finally {
    await app.close();
  }
});

test("Anthropic Messages requests re-enter the canonical Responses path with tools intact", async () => {
  let received;
  const app = await fixture(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    received = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    sse(response, [{ type: "response.completed", response: {
      id: "resp_test",
      status: "completed",
      output: [{ type: "function_call", call_id: "call_2", name: "write_file", arguments: '{"path":"b"}' }],
      usage: { input_tokens: 9, output_tokens: 3, total_tokens: 12 },
    } }]);
  });
  try {
    const response = await fetch(`${app.baseUrl}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "codex_router/anthropic/openai/gpt-test",
        max_tokens: 512,
        system: [{ type: "text", text: "Be precise." }],
        messages: [
          { role: "assistant", content: [{ type: "tool_use", id: "call_1", name: "read_file", input: { path: "a" } }] },
          { role: "user", content: [{ type: "tool_result", tool_use_id: "call_1", content: "ok" }] },
        ],
        tools: [{ name: "write_file", input_schema: { type: "object", properties: { path: { type: "string" } } } }],
      }),
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(received.model, "openai/gpt-test");
    assert.equal(received.instructions, "Be precise.");
    assert.deepEqual(received.input.slice(0, 2), [
      { type: "function_call", call_id: "call_1", name: "read_file", arguments: '{"path":"a"}' },
      { type: "function_call_output", call_id: "call_1", output: "ok" },
    ]);
    assert.equal(received.tools[0].name, "write_file");
    assert.equal(body.type, "message");
    assert.equal(body.stop_reason, "tool_use");
    assert.equal(body.content[0].name, "write_file");
  } finally {
    await app.close();
  }
});

test("Claude Code cannot request an unselected model", async () => {
  let calls = 0;
  const app = await fixture((_request, response) => {
    calls += 1;
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ output: [] }));
  });
  try {
    const response = await fetch(`${app.baseUrl}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "codex_router/anthropic/not/selected", max_tokens: 1, messages: [] }),
    });
    assert.equal(response.status, 404);
    assert.equal(calls, 0);
  } finally {
    await app.close();
  }
});

test("streaming emits Anthropic message events and terminates cleanly", async () => {
  const app = await fixture((_request, response) => {
    response.writeHead(200, { "content-type": "text/event-stream" });
    for (const event of [
      { type: "response.created", response: { id: "resp_stream" } },
      { type: "response.output_text.delta", item_id: "msg", delta: "hello" },
      { type: "response.output_text.done", item_id: "msg", text: "hello" },
      { type: "response.completed", response: { output: [], usage: { input_tokens: 3, output_tokens: 1, total_tokens: 4 } } },
    ]) response.write(`data: ${JSON.stringify(event)}\n\n`);
    response.end("data: [DONE]\n\n");
  });
  try {
    const response = await fetch(`${app.baseUrl}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "codex_router/anthropic/openai/gpt-test",
        max_tokens: 16,
        stream: true,
        messages: [{ role: "user", content: "hi" }],
      }),
    });
    const stream = await response.text();
    assert.match(stream, /event: message_start/);
    assert.match(stream, /event: content_block_delta/);
    assert.match(stream, /"text":"hello"/);
    assert.match(stream, /event: message_delta/);
    assert.match(stream, /event: message_stop/);
    assert.equal((stream.match(/event: message_stop/g) || []).length, 1);
  } finally {
    await app.close();
  }
});

test("tool and image blocks map to the canonical request shape", () => {
  const converted = claudeMessagesToResponses({
    model: "codex_router/anthropic/deepseek/test",
    max_tokens: 10,
    messages: [{
      role: "user",
      content: [
        { type: "text", text: "inspect" },
        { type: "image", source: { type: "base64", media_type: "image/png", data: "AA==" } },
      ],
    }],
  });
  assert.equal(converted.model, "deepseek/test");
  assert.equal(converted.input[0].content[1].image_url, "data:image/png;base64,AA==");
});
// The ChatGPT backend refuses stream:false, so a non-stream caller
// (Claude Code's /model validation) is served from an upstream stream.
async function nonStream(events) {
  let received;
  const app = await fixture(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    received = { body: JSON.parse(Buffer.concat(chunks).toString("utf8")), accept: request.headers.accept };
    sse(response, events);
  });
  try {
    const response = await fetch(`${app.baseUrl}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "codex_router/anthropic/openai/gpt-test", max_tokens: 1, messages: [{ role: "user", content: "hi" }] }),
    });
    return { status: response.status, body: await response.json(), received };
  } finally {
    await app.close();
  }
}

test("a non-stream request streams upstream and returns one message after completion", async () => {
  const item = { type: "message", role: "assistant", content: [{ type: "output_text", text: "hi" }] };
  const { status, body, received } = await nonStream([
    { type: "response.created", response: { id: "resp_ns" } },
    { type: "response.output_item.done", item },
    // The ChatGPT backend can complete with an empty output list.
    { type: "response.completed", response: { id: "resp_ns", status: "completed", output: [], usage: { input_tokens: 10, output_tokens: 1, input_tokens_details: { cached_tokens: 8 } } } },
  ]);
  assert.equal(received.body.stream, true);
  assert.equal(received.accept, "text/event-stream");
  assert.equal(status, 200);
  assert.equal(body.type, "message");
  assert.deepEqual(body.content, [{ type: "text", text: "hi" }]);
  assert.equal(body.stop_reason, "end_turn");
  assert.deepEqual(body.usage, { input_tokens: 2, output_tokens: 1, cache_read_input_tokens: 8 });
});

test("a non-stream request returns an error, never a message, on upstream failure or early EOF", async () => {
  const failed = await nonStream([{ type: "response.failed", response: { error: { message: "backend said no" } } }]);
  assert.equal(failed.status, 502);
  assert.equal(failed.body.type, "error");
  assert.match(failed.body.error.message, /backend said no/);
  const truncated = await nonStream([
    { type: "response.output_item.done", item: { type: "message", role: "assistant", content: [{ type: "output_text", text: "partial" }] } },
  ]);
  assert.equal(truncated.status, 502);
  assert.equal(truncated.body.type, "error");
  assert.match(truncated.body.error.message, /ended before the response completed/);
});
