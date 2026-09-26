import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";

import {
  ZaiResponsesCompatTransform,
  messageEnvelopeCompatTransform,
} from "../src/zai-responses-compat.mjs";

async function transformed(chunks) {
  const stream = new ZaiResponsesCompatTransform();
  let output = "";
  stream.setEncoding("utf8");
  stream.on("data", (chunk) => { output += chunk; });
  for (const chunk of chunks) stream.write(chunk);
  stream.end();
  await once(stream, "end");
  return output;
}

function block(event) {
  return `data: ${JSON.stringify(event)}\n\n`;
}

function dataEvents(text) {
  return text.split(/\r?\n\r?\n/).filter(Boolean).map((part) => {
    const line = part.split(/\r?\n/).find((value) => value.startsWith("data:"));
    return line ? JSON.parse(line.slice(5).trim()) : undefined;
  }).filter(Boolean);
}

test("repairs the live LiteLLM reasoning-to-message Responses envelope", async () => {
  const input = [
    block({ type: "response.output_item.added", output_index: 0, model: "zai-coding-glm-5-3", item: { id: "rs_1", type: "reasoning", status: "in_progress", summary: [] } }),
    block({ type: "response.output_item.done", output_index: 0, sequence_number: 6, model: "zai-coding-glm-5-3", item: { id: "rs_1", type: "reasoning", summary: [] } }),
    block({ type: "response.output_text.delta", output_index: 0, content_index: 0, item_id: "msg_1", model: "zai-coding-glm-5-3", delta: "HELLO" }),
    block({ type: "response.output_text.done", output_index: 0, content_index: 0, item_id: "msg_1", model: "zai-coding-glm-5-3", text: "HELLO" }),
    block({ type: "response.content_part.done", output_index: 0, content_index: 0, item_id: "msg_1", model: "zai-coding-glm-5-3", part: { type: "reasoning_text", reasoning: "private reasoning" } }),
    block({ type: "response.output_item.done", output_index: 0, sequence_number: 1, model: "zai-coding-glm-5-3", item: { id: "msg_1", type: "message", status: "completed", role: "assistant", content: [{ type: "output_text", text: "HELLO", annotations: [] }] } }),
    block({ type: "response.completed", response: { id: "resp_1", status: "completed", output: [] } }),
  ].join("");

  const output = await transformed([input.slice(0, 157), input.slice(157)]);
  const events = dataEvents(output);
  const deltaIndex = events.findIndex((event) => event.type === "response.output_text.delta");
  assert.ok(deltaIndex >= 2);
  assert.equal(events[deltaIndex - 2].type, "response.output_item.added");
  assert.equal(events[deltaIndex - 2].item.type, "message");
  assert.equal(events[deltaIndex - 2].item.id, "msg_1");
  assert.equal(events[deltaIndex - 2].output_index, 1);
  assert.equal(events[deltaIndex - 1].type, "response.content_part.added");
  assert.equal(events[deltaIndex - 1].part.type, "output_text");
  assert.equal(events[deltaIndex].output_index, 1);

  const textDone = events.find((event) => event.type === "response.output_text.done");
  const partDone = events.find((event) => event.type === "response.content_part.done");
  const messageDone = events.find((event) => event.type === "response.output_item.done" && event.item?.type === "message");
  assert.equal(textDone.output_index, 1);
  assert.equal(partDone.output_index, 1);
  assert.deepEqual(partDone.part, { type: "output_text", text: "HELLO", annotations: [] });
  assert.equal(messageDone.output_index, 1);
  assert.ok(!output.includes("private reasoning"));
});

test("leaves an already valid message stream byte-identical", async () => {
  const input = [
    block({ type: "response.output_item.added", output_index: 0, item: { id: "msg_ok", type: "message", status: "in_progress", role: "assistant", content: [] } }),
    block({ type: "response.content_part.added", output_index: 0, content_index: 0, item_id: "msg_ok", part: { type: "output_text", text: "", annotations: [] } }),
    block({ type: "response.output_text.delta", output_index: 0, content_index: 0, item_id: "msg_ok", delta: "OK" }),
  ].join("");
  assert.equal(await transformed([input]), input);
});

test("compatibility factory covers every LiteLLM Chat Completions route and nothing else", () => {
  const sse = "text/event-stream";
  // Z.ai and OpenRouter both reproduced the missing envelope live; neither
  // declares a protocol, so both are the default Chat Completions bridge.
  assert.ok(messageEnvelopeCompatTransform({ id: "zai-coding" }, sse));
  assert.ok(messageEnvelopeCompatTransform({ id: "zai-api" }, "text/event-stream; charset=utf-8"));
  assert.ok(messageEnvelopeCompatTransform({ id: "openrouter" }, sse));
  assert.ok(messageEnvelopeCompatTransform({ id: "opencode-go", protocol: "openai" }, sse));
  // Native traffic has no provider; Responses providers skip the bridge;
  // direct DeepSeek has its own repair; other protocols have no capture.
  assert.equal(messageEnvelopeCompatTransform(undefined, sse), undefined);
  assert.equal(messageEnvelopeCompatTransform("openrouter", sse), undefined);
  assert.equal(messageEnvelopeCompatTransform({ id: "meta", protocol: "openai-responses" }, sse), undefined);
  assert.equal(messageEnvelopeCompatTransform({ id: "deepseek" }, sse), undefined);
  assert.equal(messageEnvelopeCompatTransform({ id: "opencode-go-messages", protocol: "anthropic" }, sse), undefined);
  assert.equal(messageEnvelopeCompatTransform({ id: "openrouter" }, "application/json"), undefined);
});

test("repairs the live OpenRouter reasoning-then-text stream on the reasoning's index", async () => {
  // Relayed live on openrouter/mimo-v2.6-flash (codex-cli 0.156.1) after the
  // reasoning-summary repair: Codex logged `OutputTextDelta without active
  // item` once per delta.
  const input = [
    block({ type: "response.output_item.added", output_index: 0, item: { id: "rs_or", type: "reasoning", status: "in_progress", summary: [] } }),
    block({ type: "response.reasoning_summary_part.added", item_id: "rs_or", output_index: 0, summary_index: 0, part: { type: "summary_text", text: "" } }),
    block({ type: "response.reasoning_summary_text.delta", item_id: "rs_or", output_index: 0, summary_index: 0, delta: "Need exact requested." }),
    block({ type: "response.reasoning_summary_part.done", item_id: "rs_or", output_index: 0, summary_index: 0, part: { type: "summary_text", text: "Need exact requested." } }),
    block({ type: "response.output_item.done", output_index: 0, item: { id: "rs_or", type: "reasoning", status: "completed", summary: [{ type: "summary_text", text: "Need exact requested." }] } }),
    block({ type: "response.output_text.delta", item_id: "gen-or", output_index: 0, content_index: 0, delta: "M" }),
    block({ type: "response.output_text.delta", item_id: "gen-or", output_index: 0, content_index: 0, delta: "IMO-OK PAPAYA" }),
    block({ type: "response.output_text.done", item_id: "gen-or", output_index: 0, content_index: 0, text: "MIMO-OK PAPAYA" }),
    block({ type: "response.content_part.done", item_id: "gen-or", output_index: 0, content_index: 0, part: { type: "reasoning_text", reasoning: "Need exact requested." } }),
    block({ type: "response.output_item.done", output_index: 0, item: { id: "gen-or", type: "message", status: "completed", role: "assistant", content: [{ type: "output_text", text: "MIMO-OK PAPAYA", annotations: [] }] } }),
    block({ type: "response.completed", response: { id: "resp_or", status: "completed", output: [] } }),
  ].join("");
  const events = dataEvents(await transformed([input]));
  const messageEvents = events.filter((event) => event.item_id === "gen-or" || event.item?.id === "gen-or");
  assert.deepEqual(messageEvents.map((event) => event.type), [
    "response.output_item.added",
    "response.content_part.added",
    "response.output_text.delta",
    "response.output_text.delta",
    "response.output_text.done",
    "response.content_part.done",
    "response.output_item.done",
  ]);
  assert.ok(messageEvents.every((event) => event.output_index === 1));
  assert.deepEqual(messageEvents[5].part, { type: "output_text", text: "MIMO-OK PAPAYA", annotations: [] });
  assert.ok(events.filter((event) => event.item_id === "rs_or" || event.item?.id === "rs_or").every((event) => event.output_index === 0));
});

test("relays invalid UTF-8 byte-exact and stops rewriting the rest of the stream", async () => {
  const input = Buffer.concat([
    Buffer.from("data: "),
    Buffer.from([0xff, 0xfe]),
    Buffer.from("\n\n"),
    // Would be repaired if rewriting were still on.
    Buffer.from(block({ type: "response.output_text.delta", output_index: 0, item_id: "msg_after", delta: "x" })),
  ]);
  const stream = new ZaiResponsesCompatTransform();
  const chunks = [];
  stream.on("data", (chunk) => chunks.push(chunk));
  stream.write(input.subarray(0, 7));
  stream.end(input.subarray(7));
  await once(stream, "end");
  assert.deepEqual(Buffer.concat(chunks), input);
});

test("never adopts another item's content parts as a message envelope", async () => {
  const input = [
    block({ type: "response.output_item.added", output_index: 0, item: { id: "rs_parts", type: "reasoning", status: "in_progress", summary: [] } }),
    block({ type: "response.content_part.added", output_index: 0, content_index: 0, item_id: "rs_parts", part: { type: "reasoning_text", text: "" } }),
    block({ type: "response.content_part.done", output_index: 0, content_index: 0, item_id: "rs_parts", part: { type: "reasoning_text", text: "thinking" } }),
    block({ type: "response.output_item.done", output_index: 0, item: { id: "rs_parts", type: "reasoning", status: "completed", summary: [] } }),
  ].join("");
  assert.equal(await transformed([input]), input);
});

test("repairs a message-only LiteLLM stream without shifting its zero output index", async () => {
  const input = [
    block({ type: "response.output_text.delta", output_index: 0, content_index: 0, item_id: "msg_only", delta: "OK" }),
    block({ type: "response.output_text.done", output_index: 0, content_index: 0, item_id: "msg_only", text: "OK" }),
    block({ type: "response.output_item.done", output_index: 0, item: { id: "msg_only", type: "message", status: "completed", role: "assistant", content: [{ type: "output_text", text: "OK", annotations: [] }] } }),
  ].join("");
  const events = dataEvents(await transformed([input]));
  assert.deepEqual(events.slice(0, 3).map((event) => event.type), [
    "response.output_item.added",
    "response.content_part.added",
    "response.output_text.delta",
  ]);
  assert.ok(events.every((event) => !Number.isInteger(event.output_index) || event.output_index === 0));
});

test("repairs a message-only close and never relays reasoning content", async () => {
  const input = block({
    type: "response.output_item.done",
    output_index: 0,
    item: {
      id: "msg_done",
      type: "message",
      status: "completed",
      role: "assistant",
      content: [{ type: "reasoning_text", reasoning: "private reasoning" }],
    },
  });
  const output = dataEvents(await transformed([input]));
  assert.deepEqual(output.slice(0, 2).map((event) => event.type), [
    "response.output_item.added",
    "response.content_part.added",
  ]);
  const done = output.at(-1);
  assert.equal(done.type, "response.output_item.done");
  assert.equal(done.output_index, 0);
  assert.deepEqual(done.item.content, [{ type: "output_text", text: "", annotations: [] }]);
  assert.ok(!JSON.stringify(output).includes("private reasoning"));
});

test("starts a new repaired message when a later delta changes item id", async () => {
  const input = [
    block({ type: "response.output_item.added", output_index: 0, item: { id: "msg_1", type: "message", role: "assistant", content: [] } }),
    block({ type: "response.output_text.delta", output_index: 0, item_id: "msg_2", delta: "second" }),
  ].join("");
  const events = dataEvents(await transformed([input]));
  const delta = events.find((event) => event.type === "response.output_text.delta");
  assert.equal(delta.output_index, 1);
  assert.equal(events.filter((event) => event.type === "response.output_item.added").at(-1).item.id, "msg_2");
});

test("repairs a content-part close when LiteLLM omitted the whole message envelope", async () => {
  const input = block({
    type: "response.content_part.done",
    output_index: 0,
    item_id: "msg_part",
    content_index: 0,
    part: { type: "reasoning_text", reasoning: "private reasoning" },
  });
  const events = dataEvents(await transformed([input]));
  assert.deepEqual(events.slice(0, 2).map((event) => event.type), [
    "response.output_item.added",
    "response.content_part.added",
  ]);
  assert.deepEqual(events.at(-1).part, { type: "output_text", text: "", annotations: [] });
  assert.ok(!JSON.stringify(events).includes("private reasoning"));
});

test("injects only the missing item for a partial message envelope", async () => {
  const input = [
    block({
      type: "response.content_part.added",
      output_index: 0,
      item_id: "msg_part",
      content_index: 0,
      part: { type: "output_text", text: "" },
    }),
    block({ type: "response.output_text.delta", output_index: 0, item_id: "msg_part", delta: "ok" }),
  ].join("");
  const events = dataEvents(await transformed([input]));
  assert.deepEqual(events.map((event) => event.type), [
    "response.output_item.added",
    "response.content_part.added",
    "response.output_text.delta",
  ]);
});

test("preserves CRLF framing while repairing the malformed message envelope", async () => {
  const input = [
    `data: ${JSON.stringify({ type: "response.output_item.done", output_index: 0, item: { id: "rs", type: "reasoning" } })}\r\n\r\n`,
    `data: ${JSON.stringify({ type: "response.output_text.delta", output_index: 0, content_index: 0, item_id: "msg", delta: "X" })}\r\n\r\n`,
  ].join("");
  const output = await transformed([input]);
  assert.ok(output.includes("\r\n\r\n"));
  assert.equal(output.replace(/\r\n\r\n/g, "").includes("\n\n"), false);
});
