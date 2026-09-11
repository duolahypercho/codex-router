import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { once } from "node:events";
import test from "node:test";

import {
  createResponsesJsonTransform,
  createResponsesStreamTransform,
  normalizeOpenAIRequest,
} from "../src/openai-adapters.mjs";

async function transformText(transform, chunks) {
  const output = [];
  transform.on("data", (chunk) => output.push(Buffer.from(chunk)));
  Readable.from(chunks).pipe(transform);
  await once(transform, "end");
  return Buffer.concat(output).toString("utf8");
}

function frames(text) {
  return text.trim().split(/\n\n+/).map((frame) => {
    const event = frame.match(/^event: (.*)$/m)?.[1];
    const dataLine = frame.split("\n").find((line) => line.startsWith("data: ")) || "data: ";
    const raw = dataLine.slice(6);
    return { event, data: raw === "[DONE]" ? raw : JSON.parse(raw) };
  });
}

test("Responses requests normalize legacy aliases without dropping fields", () => {
  const input = {
    model: "responses-model",
    messages: [
      { role: "system", content: "be concise" },
      {
        role: "assistant",
        reasoning_content: "private reasoning",
        content: "answer",
        tool_calls: [
          { id: "call-a", type: "function", function: { name: "lookup", arguments: '{"a":1}' } },
          { id: "call-b", type: "function", function: { name: "lookup", arguments: '{"b":2}' } },
        ],
      },
      { role: "tool", tool_call_id: "call-a", content: "one" },
      { role: "tool", tool_call_id: "call-b", content: "two" },
    ],
    tools: [{ type: "function", function: { name: "lookup", description: "look up", parameters: { type: "object" }, strict: true } }],
    tool_choice: { type: "function", function: { name: "lookup" } },
    reasoning_effort: "high",
    max_tokens: 64,
    response_format: { type: "json_object" },
    metadata: { request_tag: "kept" },
  };
  const output = normalizeOpenAIRequest(input);
  assert.equal(output.messages, undefined);
  assert.equal(output.max_tokens, undefined);
  assert.equal(output.max_output_tokens, 64);
  assert.deepEqual(output.reasoning, { effort: "high" });
  assert.deepEqual(output.text, { format: { type: "json_object" } });
  assert.deepEqual(output.metadata, { request_tag: "kept" });
  assert.deepEqual(output.tools, [{
    type: "function",
    name: "lookup",
    description: "look up",
    parameters: { type: "object" },
    strict: true,
  }]);
  assert.deepEqual(output.tool_choice, { type: "function", name: "lookup" });
  assert.deepEqual(output.input.slice(0, 2), [
    { type: "message", role: "system", content: [{ type: "input_text", text: "be concise" }] },
    { type: "reasoning", summary: [{ type: "summary_text", text: "private reasoning" }] },
  ]);
  assert.deepEqual(output.input.slice(-2), [
    { type: "function_call_output", call_id: "call-a", output: "one" },
    { type: "function_call_output", call_id: "call-b", output: "two" },
  ]);
  assert.deepEqual(input.messages[1].tool_calls[0].function, { name: "lookup", arguments: '{"a":1}' });
  assert.throws(
    () => normalizeOpenAIRequest({ model: "m", messages: [{ role: "assistant", tool_calls: {} }] }),
    /tool_calls must be an array/,
  );
  assert.throws(() => normalizeOpenAIRequest({ model: "m", tools: {} }), /tools must be an array/);
});

test("Responses input stays lossless and invalid tool lifecycle fails closed", () => {
  const input = {
    model: "responses-model",
    input: [
      { type: "message", role: "user", content: [{ type: "input_text", text: "hello" }], custom: { keep: true } },
      { type: "function_call", call_id: "call-1", name: "one", arguments: "{}" },
      { type: "function_call_output", call_id: "call-1", output: "done" },
    ],
    include: ["reasoning.encrypted_content"],
  };
  const output = normalizeOpenAIRequest(input);
  assert.deepEqual(output.input, input.input);
  assert.deepEqual(output.include, input.include);
  assert.throws(
    () => normalizeOpenAIRequest({ model: "m", input: [{ type: "function_call_output", output: "missing id" }] }),
    (error) => error.status === 400 && error.code === "invalid_responses_request",
  );
  assert.throws(
    () => normalizeOpenAIRequest({ model: "m", input: [], max_tokens: 1, max_output_tokens: 2 }),
    /must not disagree/,
  );
});

test("Responses schema aliases keep their descriptive metadata", () => {
  const output = normalizeOpenAIRequest({
    model: "responses-model",
    response_format: {
      type: "json_schema",
      json_schema: {
        name: "answer",
        description: "A short answer",
        schema: { type: "object" },
        strict: true,
      },
    },
  });
  assert.deepEqual(output.text, {
    format: {
      type: "json_schema",
      name: "answer",
      description: "A short answer",
      schema: { type: "object" },
      strict: true,
    },
  });
});

test("Responses stream keeps independent tool indices and usage across chunk boundaries", async () => {
  const source = [
    "event: response.created\r\ndata: {\"type\":\"response.created\",\"response\":{\"id\":\"resp-1\"}}\r\n\r\n",
    "event: response.output_item.added\ndata: {\"type\":\"response.output_item.added\",\"item\":{\"id\":\"item-a\",\"type\":\"function_call\",\"call_id\":\"call-a\"}}\n\n",
    "event: response.function_call_arguments.delta\ndata: {\"type\":\"response.function_call_arguments.delta\",\"call_id\":\"call-a\",\"delta\":\"{\\\"a\\\":1}\"}\n\n",
    "event: response.output_item.added\ndata: {\"type\":\"response.output_item.added\",\"item\":{\"id\":\"item-b\",\"type\":\"function_call\",\"call_id\":\"call-b\"}}\n\n",
    "event: response.function_call_arguments.delta\ndata: {\"type\":\"response.function_call_arguments.delta\",\"call_id\":\"call-b\",\"delta\":\"{\\\"b\\\":2}\"}\n\n",
    "event: response.completed\ndata: {\"type\":\"response.completed\",\"response\":{\"status\":\"completed\",\"usage\":{\"input_tokens\":4,\"output_tokens\":3}}}\n\n",
    "data: [DONE]\n\n",
  ];
  const output = frames(await transformText(createResponsesStreamTransform(), source));
  const added = output.filter((frame) => frame.data?.type === "response.output_item.added");
  const deltas = output.filter((frame) => frame.data?.type === "response.function_call_arguments.delta");
  assert.deepEqual(added.map((frame) => frame.data.output_index), [0, 1]);
  assert.deepEqual(deltas.map((frame) => frame.data.output_index), [0, 1]);
  assert.deepEqual(output.find((frame) => frame.data?.type === "response.completed").data.response.usage, {
    input_tokens: 4,
    output_tokens: 3,
  });
  assert.equal(output.at(-1).data, "[DONE]");
});

test("Responses stream emits a terminal error instead of silently ending", async () => {
  const output = frames(await transformText(createResponsesStreamTransform(), [
    "event: response.created\ndata: {\"type\":\"response.created\",\"response\":{\"id\":\"resp-2\"}}\n\n",
  ]));
  assert.equal(output.at(-1).event, "error");
  assert.deepEqual(output.at(-1).data, {
    type: "error",
    code: "upstream_stream_incomplete",
    message: "The upstream Responses stream ended before a terminal event.",
    param: null,
  });
});

test("Responses stream rejects unknown, conflicting, and post-terminal tool indices", async () => {
  const output = frames(await transformText(createResponsesStreamTransform(), [
    "event: response.created\ndata: {\"type\":\"response.created\",\"response\":{\"id\":\"resp-4\"}}\n\n",
    "event: response.output_item.added\ndata: {\"type\":\"response.output_item.added\",\"output_index\":0,\"item\":{\"id\":\"item-a\",\"type\":\"function_call\",\"call_id\":\"call-a\"}}\n\n",
    "event: response.function_call_arguments.delta\ndata: {\"type\":\"response.function_call_arguments.delta\",\"call_id\":\"unknown\",\"delta\":\"{}\"}\n\n",
    "event: response.completed\ndata: {\"type\":\"response.completed\",\"response\":{\"id\":\"resp-4\"}}\n\n",
  ]));
  assert.equal(output.at(-1).event, "error");
  assert.equal(output.at(-1).data.code, "invalid_responses_stream");
  assert.match(output.at(-1).data.message, /unknown item/);

  const mismatch = frames(await transformText(createResponsesStreamTransform(), [
    "event: response.output_item.added\ndata: {\"type\":\"response.output_item.added\",\"output_index\":0,\"item\":{\"id\":\"item-a\",\"type\":\"function_call\",\"call_id\":\"call-a\"}}\n\n",
    "event: response.function_call_arguments.delta\ndata: {\"type\":\"response.function_call_arguments.delta\",\"call_id\":\"call-a\",\"output_index\":1,\"delta\":\"{}\"}\n\n",
  ]));
  assert.equal(mismatch.at(-1).data.code, "invalid_responses_stream");

  const afterTerminal = frames(await transformText(createResponsesStreamTransform(), [
    "event: response.completed\ndata: {\"type\":\"response.completed\",\"response\":{\"id\":\"resp-5\"}}\n\n",
    "event: response.output_text.delta\ndata: {\"type\":\"response.output_text.delta\",\"delta\":\"late\"}\n\n",
  ]));
  assert.equal(afterTerminal.at(-1).data.code, "invalid_responses_stream");
  assert.match(afterTerminal.at(-1).data.message, /after its terminal/);
});

test("Responses stream drops a keep-alive after the terminal event instead of failing the turn", async () => {
  // OpenCode Go and Zen send exactly this `ping` after every response.completed.
  // Turning it into an error appended a gateway failure to completed turns,
  // which strict Responses clients (opencode's AI SDK, pi) reject.
  const output = frames(await transformText(createResponsesStreamTransform(), [
    "event: response.created\ndata: {\"type\":\"response.created\",\"response\":{\"id\":\"resp-6\"}}\n\n",
    ": keep-alive\n\n",
    "event: response.completed\ndata: {\"type\":\"response.completed\",\"response\":{\"id\":\"resp-6\",\"status\":\"completed\"}}\n\n",
    "event: ping\ndata: {\"type\":\"ping\",\"cost\":\"0\"}\n\n",
    ": trailing comment\n\n",
    "data: [DONE]\n\n",
  ]));
  assert.deepEqual(
    output.map((frame) => frame.data?.type ?? frame.data),
    ["response.created", "response.completed", "[DONE]"],
  );
  assert.equal(output.some((frame) => frame.event === "error"), false);
});

test("Responses provider errors stay structured and do not gain a second terminal frame", async () => {
  const output = frames(await transformText(createResponsesStreamTransform(), [
    "event: error\ndata: {\"type\":\"error\",\"code\":\"provider_failed\",\"message\":\"upstream rejected\"}\n\n",
  ]));
  assert.deepEqual(output, [{
    event: "error",
    data: { type: "error", code: "provider_failed", message: "upstream rejected" },
  }]);
});

test("Responses stream rejects malformed JSON event data without relaying it", async () => {
  await assert.rejects(
    transformText(createResponsesStreamTransform(), [
      "event: response.output_text.delta\ndata: {not-json}\n\n",
    ]),
    (error) =>
      error.status === 502 &&
      error.code === "invalid_responses_stream" &&
      /malformed JSON/.test(error.message),
  );
});

test("Responses JSON transform preserves usage and error-shaped payloads", async () => {
  const response = {
    id: "resp-3",
    object: "response",
    output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "ok" }] }],
    usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
  };
  assert.deepEqual(JSON.parse(await transformText(createResponsesJsonTransform(), [JSON.stringify(response)])), response);
  const errorPayload = { error: { type: "invalid_request_error", message: "bad" } };
  assert.deepEqual(JSON.parse(await transformText(createResponsesJsonTransform(), [JSON.stringify(errorPayload)])), errorPayload);
});

test("Responses JSON transform rejects malformed and invalid upstream bodies", async () => {
  await assert.rejects(
    transformText(createResponsesJsonTransform(), ["{not-json}"]),
    (error) =>
      error.status === 502 &&
      error.code === "invalid_responses_response" &&
      /not valid JSON/.test(error.message),
  );
  await assert.rejects(
    transformText(createResponsesJsonTransform(), [JSON.stringify({ output: {} })]),
    (error) =>
      error.status === 502 &&
      error.code === "invalid_responses_response" &&
      /invalid output array/.test(error.message),
  );
});
