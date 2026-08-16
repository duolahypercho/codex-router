import assert from "node:assert/strict";
import { Readable } from "node:stream";
import test from "node:test";

const { GenerateTranslator, readGenerateEvents } = await import("../src/commandcode-stream.mjs");

const CREATED = 1_786_000_000;

// Captured from a live Go-plan turn against api.commandcode.ai. The ordering is
// the real one, including `text-start` arriving before the reasoning block it
// follows has ended.
const REASONING_TURN = [
  { type: "start" },
  { type: "start-step", request: { body: {} }, warnings: [] },
  { type: "reasoning-start", id: "reasoning-0" },
  { type: "reasoning-delta", id: "reasoning-0", text: "think" },
  { type: "text-start", id: "txt-0" },
  { type: "reasoning-end", id: "reasoning-0" },
  { type: "text-delta", id: "txt-0", text: "OK" },
  { type: "text-end", id: "txt-0" },
  {
    type: "finish-step",
    finishReason: "stop",
    usage: {
      inputTokens: 94,
      outputTokens: 18,
      totalTokens: 112,
      cachedInputTokens: 16,
      reasoningTokens: 16,
    },
  },
];

const TOOL_TURN = [
  { type: "start" },
  { type: "tool-input-start", id: "call_1", toolName: "get_weather", dynamic: false },
  { type: "tool-input-delta", id: "call_1", delta: '{"location"' },
  { type: "tool-input-delta", id: "call_1", delta: ':"Paris"}' },
  { type: "tool-input-end", id: "call_1" },
  // The redundant trailing event, which keys on toolCallId rather than id.
  { type: "tool-call", toolCallId: "call_1", toolName: "get_weather", input: { location: "Paris" } },
  { type: "finish-step", finishReason: "tool-calls", usage: { inputTokens: 367, outputTokens: 64 } },
];

function run(events, options) {
  const translator = new GenerateTranslator({ created: CREATED, model: "cc-model", ...options });
  let out = "";
  for (const event of events) out += translator.push(event);
  out += translator.finish();
  return { translator, sse: out };
}

function openAiChunks(sse) {
  return sse
    .split("\n\n")
    .map((block) => block.replace(/^data: /, "").trim())
    .filter((line) => line && line !== "[DONE]")
    .map((line) => JSON.parse(line));
}

function anthropicEvents(sse) {
  return sse
    .split("\n\n")
    .filter(Boolean)
    .map((block) => {
      const [eventLine, dataLine] = block.split("\n");
      return { event: eventLine.replace(/^event: /, ""), data: JSON.parse(dataLine.replace(/^data: /, "")) };
    });
}

test("openai chunks carry text, reasoning, finish reason, and usage", () => {
  const { sse } = run(REASONING_TURN);
  const chunks = openAiChunks(sse);
  assert.deepEqual(chunks[0].choices[0].delta, { role: "assistant" });
  assert.equal(chunks[0].object, "chat.completion.chunk");
  assert.equal(chunks[0].created, CREATED);
  assert.deepEqual(
    chunks.map((chunk) => chunk.choices[0].delta).filter((delta) => delta.reasoning_content),
    [{ reasoning_content: "think" }],
  );
  assert.deepEqual(
    chunks.map((chunk) => chunk.choices[0].delta).filter((delta) => delta.content),
    [{ content: "OK" }],
  );
  const final = chunks.at(-1);
  assert.equal(final.choices[0].finish_reason, "stop");
  // inputTokens already includes the cached reads, which is what OpenAI's
  // shape reports too -- so it maps across rather than being adjusted.
  assert.deepEqual(final.usage, {
    prompt_tokens: 94,
    completion_tokens: 18,
    total_tokens: 112,
    prompt_tokens_details: { cached_tokens: 16 },
    completion_tokens_details: { reasoning_tokens: 16 },
  });
  assert.ok(sse.endsWith("data: [DONE]\n\n"));
});

test("anthropic blocks stay serialized even when the source interleaves them", () => {
  const { sse } = run(REASONING_TURN, { protocol: "anthropic" });
  const events = anthropicEvents(sse);
  assert.deepEqual(
    events.map((entry) => entry.event),
    [
      "message_start",
      "content_block_start",
      "content_block_delta",
      "content_block_stop",
      "content_block_start",
      "content_block_delta",
      "content_block_stop",
      "message_delta",
      "message_stop",
    ],
  );
  assert.equal(events[1].data.content_block.type, "thinking");
  assert.deepEqual(events[2].data.delta, { type: "thinking_delta", thinking: "think" });
  assert.equal(events[4].data.index, 1);
  assert.deepEqual(events[5].data.delta, { type: "text_delta", text: "OK" });
  assert.equal(events[7].data.delta.stop_reason, "end_turn");
  // Anthropic's input_tokens excludes cache reads, so the cached count is
  // subtracted here rather than double-counted into the caller's cost math.
  assert.deepEqual(events[7].data.usage, {
    input_tokens: 78,
    output_tokens: 18,
    cache_read_input_tokens: 16,
  });
});

test("a tool call fires once even though the route reports it twice", () => {
  const { sse } = run(TOOL_TURN);
  const chunks = openAiChunks(sse);
  const toolDeltas = chunks
    .map((chunk) => chunk.choices[0].delta.tool_calls)
    .filter(Boolean)
    .flat();
  assert.deepEqual(toolDeltas[0], {
    index: 0,
    id: "call_1",
    type: "function",
    function: { name: "get_weather", arguments: "" },
  });
  assert.equal(
    toolDeltas
      .map((call) => call.function?.arguments || "")
      .join(""),
    '{"location":"Paris"}',
  );
  assert.equal(toolDeltas.filter((call) => call.id).length, 1);
  assert.equal(chunks.at(-1).choices[0].finish_reason, "tool_calls");
});

test("a model that only sends the trailing tool-call still produces one", () => {
  const { sse, translator } = run([
    { type: "start" },
    { type: "tool-call", toolCallId: "c9", toolName: "run", input: { cmd: "ls" } },
    { type: "finish-step", finishReason: "tool-calls" },
  ]);
  const calls = openAiChunks(sse)
    .map((chunk) => chunk.choices[0].delta.tool_calls)
    .filter(Boolean)
    .flat();
  assert.equal(calls[0].id, "c9");
  assert.equal(calls[0].function.name, "run");
  assert.equal(calls.map((call) => call.function?.arguments || "").join(""), '{"cmd":"ls"}');
  assert.deepEqual(translator.body().choices[0].message.tool_calls, [
    { id: "c9", type: "function", function: { name: "run", arguments: '{"cmd":"ls"}' } },
  ]);
});

test("anthropic tool calls become a tool_use block with json deltas", () => {
  const { sse } = run(TOOL_TURN, { protocol: "anthropic" });
  const events = anthropicEvents(sse);
  const start = events.find((entry) => entry.event === "content_block_start");
  assert.deepEqual(start.data.content_block, {
    type: "tool_use",
    id: "call_1",
    name: "get_weather",
    input: {},
  });
  assert.deepEqual(
    events
      .filter((entry) => entry.event === "content_block_delta")
      .map((entry) => entry.data.delta.partial_json)
      .join(""),
    '{"location":"Paris"}',
  );
  assert.equal(events.find((entry) => entry.event === "message_delta").data.delta.stop_reason, "tool_use");
});

test("a stream that stops without a terminal event still terminates cleanly", () => {
  const { sse } = run([
    { type: "start" },
    { type: "text-start", id: "t" },
    { type: "text-delta", id: "t", text: "half" },
  ]);
  const chunks = openAiChunks(sse);
  assert.equal(chunks.at(-1).choices[0].finish_reason, "stop");
  assert.ok(sse.endsWith("data: [DONE]\n\n"));
});

test("the whole answer is assembled for a caller that did not ask to stream", () => {
  const { translator } = run(REASONING_TURN);
  const body = translator.body();
  assert.equal(body.object, "chat.completion");
  assert.equal(body.choices[0].message.content, "OK");
  assert.equal(body.choices[0].message.reasoning_content, "think");
  assert.equal(body.choices[0].finish_reason, "stop");
  assert.equal(body.usage.prompt_tokens, 94);
});

test("the anthropic body assembles thinking, text, and tool blocks", () => {
  const translator = new GenerateTranslator({ protocol: "anthropic", model: "m", created: CREATED });
  for (const event of [...REASONING_TURN, ...TOOL_TURN.slice(1)]) translator.push(event);
  const body = translator.body();
  assert.deepEqual(
    body.content.map((block) => block.type),
    ["thinking", "text", "tool_use"],
  );
  assert.deepEqual(body.content[2].input, { location: "Paris" });
  assert.equal(body.stop_reason, "tool_use");
});

test("a mid-stream error event is captured rather than swallowed", () => {
  const { translator } = run([
    { type: "start" },
    { type: "error", error: { message: "insufficient credits" } },
  ]);
  assert.equal(translator.error, "insufficient credits");
});

test("events survive being split across read boundaries", async () => {
  const wire = REASONING_TURN.map((event) => `${JSON.stringify(event)}\n`).join("");
  // Deliberately ugly slicing: the route splits JSON objects across TCP reads,
  // and a parser that assumed whole lines would drop content under load.
  const pieces = [];
  for (let index = 0; index < wire.length; index += 7) {
    pieces.push(Buffer.from(wire.slice(index, index + 7), "utf8"));
  }
  const events = [];
  for await (const event of readGenerateEvents(Readable.from(pieces))) events.push(event);
  assert.deepEqual(events, REASONING_TURN);
});

test("a data-prefixed line and a [DONE] sentinel are tolerated", async () => {
  const events = [];
  const body = Readable.from([
    Buffer.from('data: {"type":"start"}\n', "utf8"),
    Buffer.from("not json\n", "utf8"),
    Buffer.from("[DONE]\n", "utf8"),
  ]);
  for await (const event of readGenerateEvents(body)) events.push(event);
  assert.deepEqual(events, [{ type: "start" }]);
});
