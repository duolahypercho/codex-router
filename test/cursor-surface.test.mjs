import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import http from "node:http";
import test from "node:test";
import { gzipSync } from "node:zlib";

import { handleCursorRequest } from "../src/cursor-surface.mjs";
import {
  bytesField,
  connectEnvelope,
  decodeConnectEnvelope,
  encodeMessageField,
  encodeStringField,
  encodeVarintField,
  stringField,
  varintField,
} from "../src/protobuf-lite.mjs";

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(server.address().port));
  });
}

function close(server) {
  return new Promise((resolve) => server.close(resolve));
}

function routedModels() {
  return [
    { slug: "anthropic-api/claude-test", displayName: "Claude Test", priority: 10 },
    { slug: "deepseek/test", displayName: "DeepSeek Test", priority: 5 },
  ];
}

test("the router gives Cursor the shared publishable client catalog", async () => {
  const source = await readFile(new URL("../src/router.mjs", import.meta.url), "utf8");
  assert.match(
    source,
    /if \(isCursorRoute\(route\)\)[\s\S]{0,400}routedModels: routedClientModels/,
  );
});

function splitEnvelopes(buffer) {
  const envelopes = [];
  let offset = 0;
  while (offset < buffer.length) {
    const envelope = decodeConnectEnvelope(buffer.subarray(offset));
    envelopes.push(envelope);
    offset += 5 + envelope.payload.length;
  }
  return envelopes;
}

async function nextStreamEnvelope(reader, state) {
  for (;;) {
    if (state.buffer.length >= 5) {
      const length = state.buffer.readUInt32BE(1);
      if (state.buffer.length >= 5 + length) {
        const envelope = decodeConnectEnvelope(state.buffer);
        state.buffer = state.buffer.subarray(5 + length);
        return envelope;
      }
    }
    const next = await reader.read();
    if (next.done) return undefined;
    state.buffer = Buffer.concat([state.buffer, Buffer.from(next.value)]);
  }
}

async function fixture(responsesHandler) {
  const upstream = http.createServer(responsesHandler);
  const upstreamPort = await listen(upstream);
  const surface = http.createServer((request, response) => {
    const route = new URL(request.url, `http://${request.headers.host}`).pathname;
    handleCursorRequest(request, response, route, {
      responsesUrl: `http://127.0.0.1:${upstreamPort}/v1/responses`,
      routedModels,
    }).catch((error) => {
      response.writeHead(error.status || 500, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: error.message }));
    });
  });
  const surfacePort = await listen(surface);
  return {
    baseUrl: `http://127.0.0.1:${surfacePort}`,
    close: () => Promise.all([close(surface), close(upstream)]),
  };
}

test("Cursor app catalog uses neutral aliases and normalizes Responses-shaped chat requests", async () => {
  let received;
  const app = await fixture(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    received = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      id: "resp_test",
      output: [{ type: "message", content: [{ type: "output_text", text: "done" }] }],
      usage: { input_tokens: 4, output_tokens: 1, total_tokens: 5 },
    }));
  });
  try {
    const catalog = await fetch(`${app.baseUrl}/cursor/v1/models`).then((response) => response.json());
    assert.deepEqual(catalog.data.map((model) => model.id), [
      "codex_router/anthropic-api/claude-test",
      "codex_router/deepseek/test",
    ]);

    const response = await fetch(`${app.baseUrl}/cursor/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "codex_router/anthropic-api/claude-test",
        input: "hello",
        instructions: "Be concise.",
        stream: true,
        tools: [{
          type: "function",
          function: { name: "read_file", description: "Read", parameters: { type: "object" } },
        }],
      }),
    });
    const stream = await response.text();
    assert.equal(received.model, "anthropic-api/claude-test");
    assert.equal(received.stream, false);
    assert.equal(received.tools[0].name, "read_file");
    assert.match(stream, /"content":"done"/);
    assert.match(stream, /data: \[DONE\]/);
  } finally {
    await app.close();
  }
});

test("Cursor app converts Anthropic tool blocks without dropping tool identities", () => {
  // Import lazily here so the assertion documents this translator independently
  // from the HTTP fixture above.
  return import("../src/cursor-surface.mjs").then(({ cursorChatToResponses }) => {
    const converted = cursorChatToResponses({
      model: "router/deepseek/test",
      messages: [
        { role: "assistant", content: [{ type: "tool_use", id: "call_1", name: "read", input: { path: "a" } }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "call_1", content: "ok" }] },
      ],
    });
    assert.deepEqual(converted.input, [
      { type: "function_call", call_id: "call_1", name: "read", arguments: '{"path":"a"}' },
      { type: "function_call_output", call_id: "call_1", output: "ok" },
    ]);
    assert.equal(converted.model, "deepseek/test");
  });
});

test("Cursor app preserves chat-completions image parts for the router vision path", async () => {
  const { cursorChatToResponses } = await import("../src/cursor-surface.mjs");
  const converted = cursorChatToResponses({
    model: "codex_router/deepseek/test",
    messages: [{
      role: "user",
      content: [
        { type: "text", text: "What is this?" },
        { type: "image_url", image_url: { url: "data:image/png;base64,AA==", detail: "low" } },
      ],
    }],
  });
  assert.deepEqual(converted.input, [{
    role: "user",
    content: [
      { type: "input_text", text: "What is this?" },
      { type: "input_image", image_url: "data:image/png;base64,AA==", detail: "low" },
    ],
  }]);
});

test("Cursor rejects models outside the published routed catalog", async () => {
  let upstreamCalls = 0;
  const app = await fixture((_request, response) => {
    upstreamCalls += 1;
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ output: [] }));
  });
  try {
    const response = await fetch(`${app.baseUrl}/cursor/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "gpt-5.6-sol",
        messages: [{ role: "user", content: "hello" }],
      }),
    });
    assert.equal(response.status, 404);
    assert.equal(upstreamCalls, 0);
  } finally {
    await app.close();
  }
});

test("Cursor Agent catalog and a RunSSE/BidiAppend turn use the current Connect wire shape", async () => {
  let received;
  const app = await fixture(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    received = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      output: [{ type: "message", content: [{ type: "output_text", text: "OK" }] }],
      usage: { input_tokens: 7, output_tokens: 2 },
    }));
  });
  try {
    const catalogResponse = await fetch(`${app.baseUrl}/aiserver.v1.AiService/GetUsableModels`, {
      method: "POST",
      headers: { "content-type": "application/proto" },
      body: Buffer.alloc(0),
    });
    const catalog = Buffer.from(await catalogResponse.arrayBuffer());
    const firstModel = bytesField(catalog, 1);
    assert.equal(stringField(firstModel, 1), "codex_router/anthropic-api/claude-test");

    const requestId = "request-test";
    const userMessage = encodeStringField(1, "Reply with exactly OK.");
    const userAction = encodeMessageField(1, userMessage);
    const action = encodeMessageField(1, userAction);
    const requestedModel = encodeStringField(1, "codex_router/deepseek/test");
    const runRequest = Buffer.concat([
      encodeMessageField(2, action),
      encodeMessageField(9, requestedModel),
    ]);
    const clientMessage = encodeMessageField(1, runRequest);
    const bidiAppend = Buffer.concat([
      encodeStringField(1, clientMessage.toString("hex")),
      encodeMessageField(2, encodeStringField(1, requestId)),
      encodeVarintField(3, 0),
    ]);

    const runPromise = fetch(`${app.baseUrl}/agent.v1.AgentService/RunSSE`, {
      method: "POST",
      headers: { "content-type": "application/connect+proto" },
      body: connectEnvelope(encodeStringField(1, requestId)),
    });
    const appendResponse = await fetch(`${app.baseUrl}/aiserver.v1.BidiService/BidiAppend`, {
      method: "POST",
      headers: { "content-type": "application/proto", "content-encoding": "gzip" },
      body: gzipSync(bidiAppend),
    });
    assert.equal(appendResponse.status, 200);

    const runResponse = await runPromise;
    const envelopes = splitEnvelopes(Buffer.from(await runResponse.arrayBuffer()));
    assert.equal(envelopes.length, 3);
    const interaction = bytesField(envelopes[0].payload, 1);
    const delta = bytesField(interaction, 1);
    assert.equal(stringField(delta, 1), "OK");
    assert.ok(bytesField(bytesField(envelopes[1].payload, 1), 14));
    assert.equal(envelopes[2].flags, 2);
    assert.equal(received.model, "deepseek/test");
    assert.deepEqual(received.input, [{ role: "user", content: "Reply with exactly OK." }]);
  } finally {
    await app.close();
  }
});

test("Cursor Agent executes routed read tools through its local controlled-exec channel", async () => {
  const received = [];
  const app = await fixture(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    received.push(payload);
    response.writeHead(200, { "content-type": "application/json" });
    if (received.length === 1) {
      response.end(JSON.stringify({
        output: [{
          type: "function_call",
          call_id: "call_read",
          name: "read_file",
          arguments: '{"path":"README.md","limit":5}',
        }],
        usage: { input_tokens: 3, output_tokens: 1 },
      }));
      return;
    }
    response.end(JSON.stringify({
      output: [{ type: "message", content: [{ type: "output_text", text: "READ_OK" }] }],
      usage: { input_tokens: 5, output_tokens: 2 },
    }));
  });
  try {
    const requestId = "request-tool-test";
    const userMessage = encodeStringField(1, "Read README.md, then reply READ_OK.");
    const userAction = encodeMessageField(1, userMessage);
    const action = encodeMessageField(1, userAction);
    const requestedModel = encodeStringField(1, "deepseek/test");
    const runRequest = Buffer.concat([
      encodeMessageField(2, action),
      encodeMessageField(9, requestedModel),
    ]);
    const clientMessage = encodeMessageField(1, runRequest);
    const initialAppend = Buffer.concat([
      encodeMessageField(2, encodeStringField(1, requestId)),
      encodeVarintField(3, 0),
      encodeMessageField(4, clientMessage),
    ]);

    const runPromise = fetch(`${app.baseUrl}/agent.v1.AgentService/RunSSE`, {
      method: "POST",
      headers: { "content-type": "application/connect+proto" },
      body: connectEnvelope(encodeStringField(1, requestId)),
    });
    await fetch(`${app.baseUrl}/aiserver.v1.BidiService/BidiAppend`, {
      method: "POST",
      headers: { "content-type": "application/proto" },
      body: initialAppend,
    });

    const runResponse = await runPromise;
    const reader = runResponse.body.getReader();
    const state = { buffer: Buffer.alloc(0) };
    const startedEnvelope = await nextStreamEnvelope(reader, state);
    assert.ok(bytesField(bytesField(startedEnvelope.payload, 1), 2));
    const execEnvelope = await nextStreamEnvelope(reader, state);
    const exec = bytesField(execEnvelope.payload, 2);
    const execId = varintField(exec, 1);
    assert.equal(execId, 1n);
    const readArgs = bytesField(exec, 45);
    assert.equal(stringField(readArgs, 1), "README.md");
    assert.equal(varintField(readArgs, 3), 5n);

    const readSuccess = encodeStringField(1, "README CONTENT");
    const readResult = encodeMessageField(1, readSuccess);
    const execClient = Buffer.concat([
      encodeVarintField(1, execId),
      encodeMessageField(46, readResult),
    ]);
    const resultMessage = encodeMessageField(2, execClient);
    const resultAppend = Buffer.concat([
      encodeMessageField(2, encodeStringField(1, requestId)),
      encodeVarintField(3, 1),
      encodeMessageField(4, resultMessage),
    ]);
    await fetch(`${app.baseUrl}/aiserver.v1.BidiService/BidiAppend`, {
      method: "POST",
      headers: { "content-type": "application/proto" },
      body: resultAppend,
    });

    const remaining = [];
    for (;;) {
      const envelope = await nextStreamEnvelope(reader, state);
      if (!envelope) break;
      remaining.push(envelope);
    }
    assert.ok(bytesField(bytesField(remaining[0].payload, 1), 3));
    const text = bytesField(bytesField(remaining[1].payload, 1), 1);
    assert.equal(stringField(text, 1), "READ_OK");
    assert.ok(bytesField(bytesField(remaining[2].payload, 1), 14));
    assert.equal(remaining[3].flags, 2);
    assert.equal(received.length, 2);
    assert.deepEqual(received[0].tools.map((tool) => tool.name), [
      "read_file",
      "run_terminal_command",
      "edit_file",
      "write_file",
    ]);
    assert.deepEqual(received[1].input.slice(-2), [
      {
        type: "function_call",
        call_id: "call_read",
        name: "read_file",
        arguments: '{"path":"README.md","limit":5}',
      },
      { type: "function_call_output", call_id: "call_read", output: "README CONTENT" },
    ]);
  } finally {
    await app.close();
  }
});

test("Cursor Agent keeps write, edit, and shell execution in the official client", async () => {
  const received = [];
  const calls = [
    { id: "call_write", name: "write_file", arguments: '{"path":"proof.txt","content":"ALPHA\\n"}' },
    { id: "call_edit", name: "edit_file", arguments: '{"path":"proof.txt","edits":[{"old_text":"ALPHA","new_text":"BETA"}]}' },
    { id: "call_bash", name: "run_terminal_command", arguments: '{"command":"grep -qx BETA proof.txt"}' },
  ];
  const app = await fixture(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    received.push(payload);
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(received.length === 1
      ? {
          output: calls.map((call) => ({ type: "function_call", call_id: call.id, ...call })),
          usage: { input_tokens: 4, output_tokens: 3 },
        }
      : {
          output: [{ type: "message", content: [{ type: "output_text", text: "TOOLS_OK" }] }],
          usage: { input_tokens: 8, output_tokens: 1 },
        }));
  });
  try {
    const requestId = "request-mutation-tools";
    const action = encodeMessageField(1, encodeMessageField(1, encodeStringField(1, "Use all tools.")));
    const runRequest = Buffer.concat([
      encodeMessageField(2, action),
      encodeMessageField(9, encodeStringField(1, "deepseek/test")),
    ]);
    const firstAppend = Buffer.concat([
      encodeMessageField(2, encodeStringField(1, requestId)),
      encodeVarintField(3, 0),
      encodeMessageField(4, encodeMessageField(1, runRequest)),
    ]);
    const runPromise = fetch(`${app.baseUrl}/agent.v1.AgentService/RunSSE`, {
      method: "POST",
      headers: { "content-type": "application/connect+proto" },
      body: connectEnvelope(encodeStringField(1, requestId)),
    });
    await fetch(`${app.baseUrl}/aiserver.v1.BidiService/BidiAppend`, {
      method: "POST",
      headers: { "content-type": "application/proto" },
      body: firstAppend,
    });
    const runResponse = await runPromise;
    const reader = runResponse.body.getReader();
    const state = { buffer: Buffer.alloc(0) };
    const specs = [
      { argsField: 48, resultField: 49, path: "proof.txt", content: "ALPHA\n", output: "write ok" },
      { argsField: 47, resultField: 48, path: "proof.txt", edit: ["ALPHA", "BETA"], output: "edit ok" },
      { argsField: 46, resultField: 47, command: "grep -qx BETA proof.txt", output: "shell ok" },
    ];
    let sequence = 1;
    for (const spec of specs) {
      const started = await nextStreamEnvelope(reader, state);
      assert.ok(bytesField(bytesField(started.payload, 1), 2));
      const execEnvelope = await nextStreamEnvelope(reader, state);
      const exec = bytesField(execEnvelope.payload, 2);
      const execId = varintField(exec, 1);
      const args = bytesField(exec, spec.argsField);
      if (spec.path) assert.equal(stringField(args, 1), spec.path);
      if (spec.content) assert.equal(stringField(args, 2), spec.content);
      if (spec.edit) {
        const edit = bytesField(args, 2);
        assert.deepEqual([stringField(edit, 1), stringField(edit, 2)], spec.edit);
      }
      if (spec.command) assert.equal(stringField(args, 1), spec.command);
      const success = encodeStringField(1, spec.output);
      const result = encodeMessageField(1, success);
      const execClient = Buffer.concat([
        encodeVarintField(1, execId),
        encodeMessageField(spec.resultField, result),
      ]);
      const append = Buffer.concat([
        encodeMessageField(2, encodeStringField(1, requestId)),
        encodeVarintField(3, sequence),
        encodeMessageField(4, encodeMessageField(2, execClient)),
      ]);
      sequence += 1;
      await fetch(`${app.baseUrl}/aiserver.v1.BidiService/BidiAppend`, {
        method: "POST",
        headers: { "content-type": "application/proto" },
        body: append,
      });
      const completed = await nextStreamEnvelope(reader, state);
      assert.ok(bytesField(bytesField(completed.payload, 1), 3));
    }
    const textEnvelope = await nextStreamEnvelope(reader, state);
    assert.equal(stringField(bytesField(bytesField(textEnvelope.payload, 1), 1), 1), "TOOLS_OK");
    assert.ok(bytesField(bytesField((await nextStreamEnvelope(reader, state)).payload, 1), 14));
    assert.equal((await nextStreamEnvelope(reader, state)).flags, 2);
    assert.equal(received.length, 2);
    assert.deepEqual(received[1].input.slice(-3).map((item) => item.output), [
      "write ok",
      "edit ok",
      "shell ok",
    ]);
  } finally {
    await app.close();
  }
});
