import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";

import {
  GrokReasoningSummaryCompatTransform,
  grokReasoningSummaryCompatTransform,
} from "../src/grok-reasoning-summary-compat.mjs";

function block(event, newline = "\n") {
  return `data: ${JSON.stringify(event)}${newline}${newline}`;
}

function events(text) {
  return text
    .split(/\r?\n\r?\n/u)
    .filter(Boolean)
    .map((frame) => frame.split(/\r?\n/u).find((line) => line.startsWith("data:")))
    .filter((line) => line && line !== "data: [DONE]")
    .map((line) => JSON.parse(line.slice(5).trimStart()));
}

async function transformed(input, chunkSize = 0) {
  const stream = new GrokReasoningSummaryCompatTransform();
  let output = "";
  stream.setEncoding("utf8");
  stream.on("data", (chunk) => { output += chunk; });
  const bytes = Buffer.from(input);
  if (chunkSize > 0) {
    for (let at = 0; at < bytes.length; at += chunkSize) {
      stream.write(bytes.subarray(at, at + chunkSize));
    }
  } else {
    stream.write(bytes);
  }
  stream.end();
  await once(stream, "end");
  return output;
}

function malformedReasoningStream(newline = "\n") {
  const reasoning = {
    id: "rs_open",
    type: "reasoning",
    status: "in_progress",
    summary: null,
  };
  const completedReasoning = {
    ...reasoning,
    status: "completed",
    summary: [{ type: "summary_text", text: "Проверяю контекст." }],
  };
  const message = {
    id: "msg_answer",
    type: "message",
    status: "completed",
    role: "assistant",
    content: [{ type: "output_text", text: "Готово.", annotations: [] }],
  };
  return [
    block({ type: "response.output_item.added", output_index: 0, item: reasoning }, newline),
    block({ type: "response.reasoning_summary_text.delta", item_id: "rs_hash_1", output_index: 0, delta: "Проверяю " }, newline),
    block({ type: "response.reasoning_summary_text.delta", item_id: "rs_hash_2", output_index: 0, delta: "контекст." }, newline),
    block({ type: "response.reasoning_summary_text.done", item_id: "rs_open", output_index: 0, summary_index: 0, text: "Проверяю контекст." }, newline),
    block({ type: "response.reasoning_summary_part.done", item_id: "rs_open", output_index: 0, summary_index: 0, part: { type: "summary_text", text: "Проверяю контекст." } }, newline),
    block({ type: "response.output_item.done", output_index: 0, item: completedReasoning }, newline),
    block({ type: "response.output_text.delta", item_id: "msg_answer", output_index: 1, content_index: 0, delta: "Готово." }, newline),
    block({ type: "response.completed", response: { id: "resp_1", status: "completed", output: [completedReasoning, message] } }, newline),
  ].join("");
}

test("repairs LiteLLM's mismatched Grok reasoning ids into one Codex lifecycle", async () => {
  const output = events(await transformed(malformedReasoningStream()));
  const reasoningEvents = output.filter(
    (event) => event.item?.type === "reasoning" || event.type.startsWith("response.reasoning_"),
  );
  assert.deepEqual(reasoningEvents.map((event) => event.type), [
    "response.output_item.added",
    "response.reasoning_summary_part.added",
    "response.reasoning_summary_text.delta",
    "response.reasoning_summary_text.delta",
    "response.reasoning_summary_text.done",
    "response.reasoning_summary_part.done",
    "response.output_item.done",
  ]);
  assert.ok(reasoningEvents.every(
    (event) => (event.item_id ?? event.item?.id) === "rs_open",
  ));
  assert.deepEqual(reasoningEvents[0].item.summary, []);
  assert.deepEqual(reasoningEvents.at(-1).item.summary, [
    { type: "summary_text", text: "Проверяю контекст." },
  ]);
  assert.equal(
    output.find((event) => event.type === "response.output_text.delta").delta,
    "Готово.",
  );
  assert.deepEqual(
    output.find((event) => event.type === "response.completed").response.output[0],
    reasoningEvents.at(-1).item,
  );
});

test("repairs the live LiteLLM message-first Grok stream", async () => {
  const message = {
    id: "msg_live",
    type: "message",
    role: "assistant",
    status: "completed",
    content: [{ type: "output_text", text: "Готово.", annotations: [] }],
  };
  const input = [
    block({ type: "response.output_item.added", output_index: 0, item: { ...message, status: "in_progress", content: [] } }),
    block({ type: "response.content_part.added", item_id: message.id, output_index: 0, content_index: 0, part: { type: "output_text", text: "", annotations: [] } }),
    block({ type: "response.reasoning_summary_text.delta", item_id: "rs_hash_1", output_index: 0, delta: "Проверяю " }),
    block({ type: "response.reasoning_summary_text.delta", item_id: "rs_hash_2", output_index: 0, delta: "контекст." }),
    block({ type: "response.output_text.delta", item_id: message.id, output_index: 0, content_index: 0, delta: "Готово." }),
    block({ type: "response.output_text.done", item_id: message.id, output_index: 0, content_index: 0, text: "Готово." }),
    block({ type: "response.content_part.done", item_id: message.id, output_index: 0, content_index: 0, part: { type: "reasoning_text", reasoning: "Проверяю контекст." } }),
    block({ type: "response.output_item.done", output_index: 0, item: message }),
    block({
      type: "response.completed",
      response: {
        id: "resp_live",
        status: "completed",
        output: [
          { type: "reasoning", id: "rs_final_hash", status: "completed", role: "assistant", content: [{ type: "output_text", text: "Проверяю контекст.", annotations: [] }] },
          { ...message, id: "chatcmpl_final" },
        ],
      },
    }),
  ].join("");
  const output = events(await transformed(input));
  const reasoningEvents = output.filter(
    (event) => event.item?.type === "reasoning" || event.type.startsWith("response.reasoning_"),
  );
  assert.deepEqual(reasoningEvents.map((event) => event.type), [
    "response.output_item.added",
    "response.reasoning_summary_part.added",
    "response.reasoning_summary_text.delta",
    "response.reasoning_summary_text.delta",
    "response.reasoning_summary_text.done",
    "response.reasoning_summary_part.done",
    "response.output_item.done",
  ]);
  assert.ok(reasoningEvents.every(
    (event) => (event.item_id ?? event.item?.id) === "rs_hash_1",
  ));
  const messageEvents = output.filter(
    (event) => event.item_id === message.id || event.item?.id === message.id,
  );
  assert.ok(messageEvents.every((event) => event.output_index === 1));
  assert.deepEqual(
    output.find((event) => event.type === "response.content_part.done").part,
    { type: "output_text", text: "Готово.", annotations: [] },
  );
  assert.deepEqual(
    output.find((event) => event.type === "response.completed").response.output,
    [
      {
        id: "rs_hash_1",
        type: "reasoning",
        status: "completed",
        summary: [{ type: "summary_text", text: "Проверяю контекст." }],
      },
      message,
    ],
  );
});

test("repairs one-byte CRLF chunks without changing their framing", async () => {
  const output = await transformed(malformedReasoningStream("\r\n"), 1);
  assert.ok(output.includes("\r\n\r\n"));
  assert.equal(output.replace(/\r\n\r\n/gu, "").includes("\n\n"), false);
  assert.ok(events(output).every((event) => !String(event.item_id || "").startsWith("rs_hash_")));
});

test("adds missing reasoning terminal events before closing the item", async () => {
  const input = [
    block({ type: "response.output_item.added", output_index: 0, item: { id: "rs_1", type: "reasoning", status: "in_progress", summary: [] } }),
    block({ type: "response.reasoning_summary_text.delta", item_id: "wrong", output_index: 0, delta: "Жду ответ." }),
    block({ type: "response.output_item.done", output_index: 0, item: { id: "rs_1", type: "reasoning", status: "completed", summary: [] } }),
  ].join("");
  const output = events(await transformed(input));
  assert.deepEqual(output.map((event) => event.type), [
    "response.output_item.added",
    "response.reasoning_summary_part.added",
    "response.reasoning_summary_text.delta",
    "response.reasoning_summary_text.done",
    "response.reasoning_summary_part.done",
    "response.output_item.done",
  ]);
  assert.deepEqual(output.at(-1).item.summary, [
    { type: "summary_text", text: "Жду ответ." },
  ]);
});

test("closes reasoning before a terminal-only assistant answer", async () => {
  const input = [
    block({ type: "response.output_item.added", output_index: 0, item: { id: "msg_terminal", type: "message", role: "assistant", status: "in_progress", content: [] } }),
    block({ type: "response.content_part.added", item_id: "msg_terminal", output_index: 0, content_index: 0, part: { type: "output_text", text: "", annotations: [] } }),
    block({ type: "response.reasoning_summary_text.delta", item_id: "rs_terminal", output_index: 0, delta: "Готовлю ответ." }),
    block({ type: "response.output_text.done", item_id: "msg_terminal", output_index: 0, content_index: 0, text: "" }),
  ].join("");
  const output = events(await transformed(input));
  assert.deepEqual(output.map((event) => event.type), [
    "response.output_item.added",
    "response.reasoning_summary_part.added",
    "response.reasoning_summary_text.delta",
    "response.reasoning_summary_text.done",
    "response.reasoning_summary_part.done",
    "response.output_item.done",
    "response.output_item.added",
    "response.content_part.added",
    "response.output_text.done",
  ]);
  assert.equal(output[5].item.type, "reasoning");
  assert.equal(output[6].output_index, 1);
  assert.equal(output.at(-1).output_index, 1);
});

test("leaves an already canonical Grok reasoning stream byte-identical", async () => {
  const input = [
    block({ type: "response.output_item.added", output_index: 0, item: { id: "rs_ok", type: "reasoning", status: "in_progress", summary: [] } }),
    block({ type: "response.reasoning_summary_part.added", item_id: "rs_ok", output_index: 0, summary_index: 0, part: { type: "summary_text", text: "" } }),
    block({ type: "response.reasoning_summary_text.delta", item_id: "rs_ok", output_index: 0, summary_index: 0, delta: "Готовлю ответ." }),
    block({ type: "response.reasoning_summary_text.done", item_id: "rs_ok", output_index: 0, summary_index: 0, text: "Готовлю ответ." }),
    block({ type: "response.reasoning_summary_part.done", item_id: "rs_ok", output_index: 0, summary_index: 0, part: { type: "summary_text", text: "Готовлю ответ." } }),
    block({ type: "response.output_item.done", output_index: 0, item: { id: "rs_ok", type: "reasoning", status: "completed", summary: [{ type: "summary_text", text: "Готовлю ответ." }] } }),
  ].join("");
  assert.equal(await transformed(input), input);
});

test("leaves malformed and non-reasoning SSE frames unchanged", async () => {
  const input = [
    "data: {not-json}\n\n",
    block({ type: "response.output_text.delta", item_id: "msg_1", delta: "ok" }),
    "data: [DONE]\n\n",
  ].join("");
  assert.equal(await transformed(input), input);
});

test("flushes a pending message-only envelope byte-identically at EOF", async () => {
  const input = [
    block({ type: "response.output_item.added", output_index: 0, item: { id: "msg_eof", type: "message", role: "assistant", status: "in_progress", content: [] } }, "\r\n"),
    block({ type: "response.content_part.added", item_id: "msg_eof", output_index: 0, content_index: 0, part: { type: "output_text", text: "", annotations: [] } }, "\r\n"),
  ].join("");
  assert.equal(await transformed(input), input);
});

test("compatibility factory is scoped to Grok OAuth event streams", () => {
  assert.ok(grokReasoningSummaryCompatTransform({ id: "grok-oauth" }, "text/event-stream"));
  assert.ok(grokReasoningSummaryCompatTransform("grok-oauth", "text/event-stream; charset=utf-8"));
  assert.equal(grokReasoningSummaryCompatTransform("grok-api", "text/event-stream"), undefined);
  assert.equal(grokReasoningSummaryCompatTransform("grok-oauth", "application/json"), undefined);
});
