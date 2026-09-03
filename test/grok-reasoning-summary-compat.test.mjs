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

async function transformed(input, chunkSize = 0, options) {
  const stream = new GrokReasoningSummaryCompatTransform(options);
  let output = "";
  stream.setEncoding("utf8");
  stream.on("data", (chunk) => { output += chunk; });
  const ended = once(stream, "end");
  const bytes = Buffer.from(input);
  if (chunkSize > 0) {
    for (let at = 0; at < bytes.length; at += chunkSize) {
      stream.write(bytes.subarray(at, at + chunkSize));
    }
  } else {
    stream.write(bytes);
  }
  stream.end();
  await ended;
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
    block({ type: "response.output_item.added", output_index: 0, item: { id: "rs_1", type: "reasoning", status: "in_progress", summary: null } }),
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

test("leaves canonical multi-part reasoning byte-identical", async () => {
  const input = [
    block({ type: "response.output_item.added", output_index: 0, item: { id: "rs_parts", type: "reasoning", status: "in_progress", summary: [] } }),
    block({ type: "response.reasoning_summary_part.added", item_id: "rs_parts", output_index: 0, summary_index: 0, part: { type: "summary_text", text: "" } }),
    block({ type: "response.reasoning_summary_text.delta", item_id: "rs_parts", output_index: 0, summary_index: 0, delta: "Первый." }),
    block({ type: "response.reasoning_summary_text.done", item_id: "rs_parts", output_index: 0, summary_index: 0, text: "Первый." }),
    block({ type: "response.reasoning_summary_part.done", item_id: "rs_parts", output_index: 0, summary_index: 0, part: { type: "summary_text", text: "Первый." } }),
    block({ type: "response.reasoning_summary_part.added", item_id: "rs_parts", output_index: 0, summary_index: 1, part: { type: "summary_text", text: "" } }),
    block({ type: "response.reasoning_summary_text.delta", item_id: "rs_parts", output_index: 0, summary_index: 1, delta: "Второй." }),
    block({ type: "response.reasoning_summary_text.done", item_id: "rs_parts", output_index: 0, summary_index: 1, text: "Второй." }),
    block({ type: "response.reasoning_summary_part.done", item_id: "rs_parts", output_index: 0, summary_index: 1, part: { type: "summary_text", text: "Второй." } }),
    block({ type: "response.output_item.done", output_index: 0, item: { id: "rs_parts", type: "reasoning", status: "completed", summary: [{ type: "summary_text", text: "Первый." }, { type: "summary_text", text: "Второй." }] } }),
  ].join("");
  assert.equal(await transformed(input, 1), input);
});

test("drops a late upstream reasoning close after a synthetic close", async () => {
  const message = { id: "msg_late", type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: "Готово.", annotations: [] }] };
  const input = [
    block({ type: "response.output_item.added", output_index: 0, item: { ...message, status: "in_progress", content: [] } }),
    block({ type: "response.content_part.added", item_id: message.id, output_index: 0, content_index: 0, part: { type: "output_text", text: "", annotations: [] } }),
    block({ type: "response.reasoning_summary_text.delta", item_id: "rs_late", output_index: 0, delta: "Проверяю." }),
    block({ type: "response.output_text.delta", item_id: message.id, output_index: 0, content_index: 0, delta: "Готово." }),
    block({ type: "response.output_item.done", output_index: 0, item: { id: "rs_late_final", type: "reasoning", status: "completed", summary: [{ type: "summary_text", text: "Проверяю." }] } }),
    block({ type: "response.output_text.done", item_id: message.id, output_index: 0, content_index: 0, text: "Готово." }),
  ].join("");
  const output = events(await transformed(input));
  assert.equal(
    output.filter((event) => event.type === "response.output_item.done" && event.item?.type === "reasoning").length,
    1,
  );
  assert.equal(output.at(-1).type, "response.output_text.done");
});

test("flushes the held message after a real reasoning close", async () => {
  const message = {
    id: "msg_after_close",
    type: "message",
    role: "assistant",
    status: "in_progress",
    content: [],
  };
  const input = [
    block({ type: "response.output_item.added", output_index: 0, item: message }),
    block({ type: "response.content_part.added", item_id: message.id, output_index: 0, content_index: 0, part: { type: "output_text", text: "", annotations: [] } }),
    block({ type: "response.reasoning_summary_text.delta", item_id: "rs_after_close", output_index: 0, delta: "Проверил." }),
    block({ type: "response.output_item.done", output_index: 0, item: { id: "rs_final", type: "reasoning", status: "completed", summary: [{ type: "summary_text", text: "Проверил." }] } }),
    block({ type: "response.output_text.delta", item_id: message.id, output_index: 0, content_index: 0, delta: "Готово." }),
  ].join("");
  const output = events(await transformed(input));
  const messageAdded = output.findIndex(
    (event) => event.type === "response.output_item.added" && event.item?.type === "message",
  );
  const textDelta = output.findIndex((event) => event.type === "response.output_text.delta");
  assert.ok(messageAdded >= 0 && messageAdded < textDelta);
  assert.equal(output[messageAdded].output_index, 1);
  assert.equal(output[textDelta].output_index, 1);
});

test("normalizes a completed frame larger than the pre-commit limit", async () => {
  const longText = "x".repeat(600);
  const message = {
    id: "msg_large",
    type: "message",
    role: "assistant",
    status: "completed",
    content: [{ type: "output_text", text: longText, annotations: [] }],
  };
  const terminal = {
    type: "response.completed",
    response: {
      id: "resp_large",
      status: "completed",
      output: [
        { id: "rs_large_final", type: "reasoning", status: "completed", content: [] },
        { ...message, id: "chatcmpl_large" },
      ],
    },
  };
  assert.ok(Buffer.byteLength(block(terminal)) > 256);
  const input = [
    block({ type: "response.output_item.added", output_index: 0, item: { ...message, status: "in_progress", content: [] } }),
    block({ type: "response.reasoning_summary_text.delta", item_id: "rs_large", output_index: 0, delta: "Проверяю." }),
    block({ type: "response.output_text.delta", item_id: message.id, output_index: 0, content_index: 0, delta: longText }),
    block(terminal),
  ].join("");
  const output = events(await transformed(input, 1, {
    maxFrameBytes: 256,
    maxCommittedFrameBytes: 4_096,
  }));
  const completed = output.find((event) => event.type === "response.completed");
  assert.deepEqual(completed.response.output.map((item) => item.id), [
    "rs_large",
    message.id,
  ]);
  assert.deepEqual(completed.response.output[0].summary, [
    { type: "summary_text", text: "Проверяю." },
  ]);
});

test("fails closed when a post-mutation frame exceeds the committed limit", async () => {
  const input = [
    block({ type: "response.output_item.added", output_index: 0, item: { id: "msg_hard_limit", type: "message", role: "assistant", status: "in_progress", content: [] } }),
    block({ type: "response.reasoning_summary_text.delta", item_id: "rs_hard_limit", output_index: 0, delta: "Начал." }),
    `data: ${"x".repeat(512)}\n\n`,
  ].join("");
  await assert.rejects(
    transformed(input, 1, { maxFrameBytes: 256, maxCommittedFrameBytes: 320 }),
    /failed after stream mutation: SSE frame byte limit/u,
  );
});

test("normalizes incomplete response output while preserving truncation details", async () => {
  const message = {
    id: "msg_incomplete",
    type: "message",
    role: "assistant",
    status: "incomplete",
    content: [{ type: "output_text", text: "Частичный ответ", annotations: [] }],
  };
  const input = [
    block({ type: "response.output_item.added", output_index: 0, item: { ...message, status: "in_progress", content: [] } }),
    block({ type: "response.reasoning_summary_text.delta", item_id: "rs_incomplete", output_index: 0, delta: "Не успел." }),
    block({ type: "response.output_text.delta", item_id: message.id, output_index: 0, content_index: 0, delta: "Частичный ответ" }),
    block({
      type: "response.incomplete",
      response: {
        id: "resp_incomplete",
        status: "incomplete",
        incomplete_details: { reason: "max_output_tokens" },
        output: [
          { id: "rs_incomplete_final", type: "reasoning", status: "completed", content: [] },
          { ...message, id: "chatcmpl_incomplete" },
        ],
      },
    }),
  ].join("");
  const output = events(await transformed(input));
  const incomplete = output.find((event) => event.type === "response.incomplete");
  assert.equal(incomplete.response.status, "incomplete");
  assert.deepEqual(incomplete.response.incomplete_details, { reason: "max_output_tokens" });
  assert.deepEqual(incomplete.response.output.map((item) => item.id), [
    "rs_incomplete",
    message.id,
  ]);
});

test("renumbers a moved message and synthetic reasoning monotonically", async () => {
  const message = {
    id: "msg_sequence",
    type: "message",
    role: "assistant",
    status: "completed",
    content: [{ type: "output_text", text: "Да.", annotations: [] }],
  };
  const input = [
    block({ type: "response.created", sequence_number: 0, response: { id: "resp_sequence", status: "in_progress", output: [] } }),
    block({ type: "response.output_item.added", sequence_number: 1, output_index: 0, item: { ...message, status: "in_progress", content: [] } }),
    block({ type: "response.content_part.added", sequence_number: 2, item_id: message.id, output_index: 0, content_index: 0, part: { type: "output_text", text: "", annotations: [] } }),
    block({ type: "response.reasoning_summary_text.delta", sequence_number: 3, item_id: "rs_sequence", output_index: 0, delta: "Думаю." }),
    block({ type: "response.output_text.delta", sequence_number: 4, item_id: message.id, output_index: 0, content_index: 0, delta: "Да." }),
    block({ type: "response.completed", sequence_number: 5, response: { id: "resp_sequence", status: "completed", output: [{ id: "rs_final", type: "reasoning", status: "completed", content: [] }, message] } }),
  ].join("");
  const output = events(await transformed(input));
  assert.deepEqual(
    output.map((event) => event.sequence_number),
    output.map((_event, index) => index),
  );
});

test("recovers a reasoning summary supplied only by the terminal item", async () => {
  const input = [
    block({ type: "response.output_item.added", output_index: 0, item: { id: "rs_terminal_only", type: "reasoning", status: "in_progress", summary: null } }),
    block({ type: "response.output_item.done", output_index: 0, item: { id: "rs_terminal_only", type: "reasoning", status: "completed", summary: [{ type: "summary_text", text: "Только в конце." }] } }),
  ].join("");
  const output = events(await transformed(input));
  assert.deepEqual(output.map((event) => event.type), [
    "response.output_item.added",
    "response.reasoning_summary_part.added",
    "response.reasoning_summary_text.done",
    "response.reasoning_summary_part.done",
    "response.output_item.done",
  ]);
  assert.deepEqual(output.at(-1).item.summary, [
    { type: "summary_text", text: "Только в конце." },
  ]);
});

test("separates synthesized lifecycle frames at an unterminated EOF", async () => {
  const terminal = {
    type: "response.output_item.done",
    output_index: 0,
    item: {
      id: "rs_unterminated",
      type: "reasoning",
      status: "completed",
      summary: [{ type: "summary_text", text: "Готово." }],
    },
  };
  const input = [
    block({ type: "response.output_item.added", output_index: 0, item: { ...terminal.item, status: "in_progress", summary: null } }),
    block({ type: "response.reasoning_summary_text.delta", item_id: "rs_unterminated", output_index: 0, delta: "Готово." }),
    `data: ${JSON.stringify(terminal)}`,
  ].join("");
  const raw = await transformed(input);
  const output = events(raw);
  assert.equal(raw.endsWith("\n\n"), false);
  assert.deepEqual(output.map((event) => event.type), [
    "response.output_item.added",
    "response.reasoning_summary_part.added",
    "response.reasoning_summary_text.delta",
    "response.reasoning_summary_text.done",
    "response.reasoning_summary_part.done",
    "response.output_item.done",
  ]);
});

test("preserves an incomplete reasoning status in stream and terminal output", async () => {
  const repaired = {
    id: "rs_incomplete_item",
    type: "reasoning",
    status: "incomplete",
    summary: [{ type: "summary_text", text: "Оборвалось." }],
  };
  const input = [
    block({ type: "response.output_item.added", output_index: 0, item: { ...repaired, status: "in_progress", summary: null } }),
    block({ type: "response.reasoning_summary_text.delta", item_id: "wrong", output_index: 0, delta: "Оборвалось." }),
    block({ type: "response.output_item.done", output_index: 0, item: repaired }),
    block({
      type: "response.incomplete",
      response: {
        id: "resp_incomplete_item",
        status: "incomplete",
        output: [{ ...repaired, id: "rs_incomplete_final" }],
      },
    }),
  ].join("");
  const output = events(await transformed(input));
  const itemDone = output.find((event) => event.type === "response.output_item.done");
  const incomplete = output.find((event) => event.type === "response.incomplete");
  assert.equal(itemDone.item.status, "incomplete");
  assert.equal(incomplete.response.output[0].status, "incomplete");
  assert.equal(incomplete.response.output[0].id, repaired.id);
});

test("uses the terminal summary when streamed close events are missing", async () => {
  const fullText = "Проверяю контекст полностью.";
  const input = [
    block({ type: "response.output_item.added", output_index: 0, item: { id: "rs_partial", type: "reasoning", status: "in_progress", summary: null } }),
    block({ type: "response.reasoning_summary_text.delta", item_id: "rs_partial_hash", output_index: 0, delta: "Проверяю " }),
    block({
      type: "response.output_item.done",
      output_index: 0,
      item: {
        id: "rs_partial_final",
        type: "reasoning",
        status: "completed",
        summary: [{ type: "summary_text", text: fullText }],
      },
    }),
  ].join("");
  const output = events(await transformed(input));
  assert.equal(
    output.find((event) => event.type === "response.reasoning_summary_text.done").text,
    fullText,
  );
  assert.equal(
    output.find((event) => event.type === "response.reasoning_summary_part.done").part.text,
    fullText,
  );
  assert.deepEqual(output.at(-1).item.summary, [{ type: "summary_text", text: fullText }]);
});

test("flushes the held message before a terminal-only message close", async () => {
  const message = {
    id: "msg_terminal_close",
    type: "message",
    role: "assistant",
    status: "completed",
    content: [{ type: "output_text", text: "Ответ.", annotations: [] }],
  };
  const input = [
    block({ type: "response.output_item.added", output_index: 0, item: { ...message, status: "in_progress", content: [] } }),
    block({ type: "response.content_part.added", item_id: message.id, output_index: 0, content_index: 0, part: { type: "output_text", text: "", annotations: [] } }),
    block({ type: "response.reasoning_summary_text.delta", item_id: "rs_before_message_close", output_index: 0, delta: "Решил." }),
    block({ type: "response.output_item.done", output_index: 0, item: message }),
  ].join("");
  const output = events(await transformed(input));
  const reasoningDone = output.findIndex(
    (event) => event.type === "response.output_item.done" && event.item?.type === "reasoning",
  );
  const messageAdded = output.findIndex(
    (event) => event.type === "response.output_item.added" && event.item?.type === "message",
  );
  const messageDone = output.findIndex(
    (event) => event.type === "response.output_item.done" && event.item?.type === "message",
  );
  assert.ok(reasoningDone < messageAdded && messageAdded < messageDone);
  assert.equal(output[messageAdded].output_index, 1);
  assert.equal(output[messageDone].output_index, 1);
});

test("retains every repaired reasoning item in terminal output order", async () => {
  const reasoning = [
    { id: "rs_first", text: "Первый итог." },
    { id: "rs_second", text: "Второй итог." },
  ];
  const input = [
    ...reasoning.flatMap(({ id, text }, index) => {
      const outputIndex = index + 1;
      return [
        block({ type: "response.output_item.added", output_index: outputIndex, item: { id, type: "reasoning", status: "in_progress", summary: null } }),
        block({ type: "response.reasoning_summary_text.delta", item_id: `${id}_hash`, output_index: outputIndex, delta: text }),
        block({ type: "response.output_item.done", output_index: outputIndex, item: { id: `${id}_final`, type: "reasoning", status: "completed", summary: [{ type: "summary_text", text }] } }),
      ];
    }),
    block({
      type: "response.completed",
      response: {
        id: "resp_multiple_reasoning",
        status: "completed",
        output: [
          { id: "rs_unstreamed", type: "reasoning", status: "completed", summary: [] },
          { id: "raw_first", type: "reasoning", status: "completed", summary: [] },
          { id: "raw_second", type: "reasoning", status: "completed", summary: [] },
          { id: "msg_multiple", type: "message", role: "assistant", status: "completed", content: [] },
        ],
      },
    }),
  ].join("");
  const output = events(await transformed(input));
  const completed = output.find((event) => event.type === "response.completed");
  assert.deepEqual(completed.response.output.map((item) => item.id), [
    "rs_unstreamed",
    "rs_first",
    "rs_second",
    "msg_multiple",
  ]);
  assert.deepEqual(
    completed.response.output.slice(1, 3).map((item) => item.summary[0].text),
    reasoning.map(({ text }) => text),
  );
});

test("resolves held lifecycles before failure terminals", async () => {
  for (const terminal of [
    { type: "response.failed", response: { id: "resp_failed", status: "failed" } },
    { type: "response.error", error: { code: "upstream_error", message: "failed" } },
    { type: "error", code: "upstream_error", message: "failed", param: null },
  ]) {
    const messageId = `msg_${terminal.type}`;
    const input = [
      block({ type: "response.output_item.added", output_index: 0, item: { id: messageId, type: "message", role: "assistant", status: "in_progress", content: [] } }),
      block({ type: "response.content_part.added", item_id: messageId, output_index: 0, content_index: 0, part: { type: "output_text", text: "", annotations: [] } }),
      block({ type: "response.reasoning_summary_text.delta", item_id: `rs_${terminal.type}`, output_index: 0, delta: "Не завершено." }),
      block(terminal),
    ].join("");
    const output = events(await transformed(input));
    assert.equal(output.at(-1).type, terminal.type);
    assert.equal(output.some((event) => event.item?.type === "message"), false);
    assert.equal(output.some((event) => event.item_id === messageId), false);
    const reasoningDone = output.find(
      (event) => event.type === "response.output_item.done" && event.item?.type === "reasoning",
    );
    assert.equal(reasoningDone.item.status, "incomplete");
  }

  const message = {
    id: "msg_failed_output",
    type: "message",
    role: "assistant",
    status: "incomplete",
    content: [],
  };
  const input = [
    block({ type: "response.output_item.added", output_index: 0, item: { ...message, status: "in_progress" } }),
    block({ type: "response.content_part.added", item_id: message.id, output_index: 0, content_index: 0, part: { type: "output_text", text: "", annotations: [] } }),
    block({ type: "response.reasoning_summary_text.delta", item_id: "rs_failed_output", output_index: 0, delta: "Не завершено." }),
    block({
      type: "response.failed",
      response: {
        id: "resp_failed_output",
        status: "failed",
        output: [
          { id: "rs_failed_final", type: "reasoning", status: "incomplete", summary: [] },
          { ...message, id: "msg_failed_final" },
        ],
      },
    }),
  ].join("");
  const output = events(await transformed(input));
  const failedIndex = output.findIndex((event) => event.type === "response.failed");
  const messageAddedIndex = output.findIndex(
    (event) => event.type === "response.output_item.added" && event.item?.type === "message",
  );
  assert.ok(messageAddedIndex >= 0 && messageAddedIndex < failedIndex);
  assert.deepEqual(output[failedIndex].response.output.map((item) => item.id), [
    "rs_failed_output",
    message.id,
  ]);
});

test("an oversized unterminated frame fails open without unbounded buffering", async () => {
  const input = `${block({ type: "response.output_item.added", output_index: 0, item: { id: "msg_limit", type: "message", role: "assistant", status: "in_progress", content: [] } })}data: ${"x".repeat(512)}`;
  assert.equal(await transformed(input, 1, { maxFrameBytes: 256 }), input);
});

test("an oversized delimited frame and its tail pass through byte-identically", async () => {
  const input = `data: ${"x".repeat(512)}\r\n\r\n${block({ type: "response.output_text.delta", item_id: "msg_tail", output_index: 0, delta: "ok" }, "\r\n")}`;
  assert.equal(await transformed(input, 1, { maxFrameBytes: 256 }), input);
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
