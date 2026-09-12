import assert from "node:assert/strict";
import { Readable } from "node:stream";
import test from "node:test";

import {
  collapseRepeatedBlocks,
  duplicateBlockCollapseTransform,
} from "../src/duplicate-block-collapse.mjs";

function block(event) {
  return `data: ${JSON.stringify(event)}\n\n`;
}

function eventsFrom(body) {
  const out = [];
  for (const chunk of body.split(/\n\n/)) {
    const data = chunk
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trim())
      .join("\n");
    if (!data || data === "[DONE]") continue;
    try {
      out.push(JSON.parse(data));
    } catch {
      /* ignore */
    }
  }
  return out;
}

async function normalize(body, { chunkSize } = {}) {
  const transform = duplicateBlockCollapseTransform("text/event-stream; charset=utf-8");
  const chunks = [];
  const source =
    chunkSize === undefined
      ? [Buffer.from(body)]
      : (() => {
          const raw = Buffer.from(body);
          const parts = [];
          for (let i = 0; i < raw.length; i += chunkSize) {
            parts.push(raw.subarray(i, i + chunkSize));
          }
          return parts;
        })();
  for await (const chunk of Readable.from(source).pipe(transform)) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

// The exact captured shape: a short line, then the same line again.
const DUPLICATED = [
  block({ type: "response.created", response: { id: "r1" } }),
  block({
    type: "response.output_item.added",
    output_index: 0,
    item: { id: "m1", type: "message", role: "assistant", content: [] },
  }),
  block({
    type: "response.content_part.added",
    output_index: 0,
    item_id: "m1",
    part: { type: "output_text", text: "" },
  }),
  block({ type: "response.output_text.delta", output_index: 0, item_id: "m1", delta: "checking the second one now." }),
  block({ type: "response.output_text.delta", output_index: 0, item_id: "m1", delta: "\n\n" }),
  block({ type: "response.output_text.delta", output_index: 0, item_id: "m1", delta: "checking the second one now." }),
  block({
    type: "response.output_text.done",
    output_index: 0,
    item_id: "m1",
    text: "checking the second one now.\n\nchecking the second one now.",
  }),
  block({ type: "response.content_part.done", output_index: 0, item_id: "m1" }),
  block({
    type: "response.output_item.done",
    output_index: 0,
    item: {
      id: "m1",
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text: "checking the second one now.\n\nchecking the second one now." }],
    },
  }),
  block({ type: "response.completed", response: { id: "r1", output: [] } }),
  "data: [DONE]\n\n",
].join("");

test("collapseRepeatedBlocks collapses only runs of identical adjacent blocks", () => {
  assert.equal(collapseRepeatedBlocks("A\n\nA"), "A");
  assert.equal(collapseRepeatedBlocks("A\n\nA\n\nB\n\nB"), "A\n\nB");
  assert.equal(collapseRepeatedBlocks("A\n\nB"), "A\n\nB");
  assert.equal(collapseRepeatedBlocks("A\n\nA\n\nB"), "A\n\nB");
  // Distinct blocks that merely resemble each other are untouched.
  assert.equal(collapseRepeatedBlocks("A\n\nA!"), "A\n\nA!");
  assert.equal(collapseRepeatedBlocks(""), "");
});

test("a duplicated message is collapsed in the streamed output", async () => {
  const out = await normalize(DUPLICATED);
  const events = eventsFrom(out);

  const deltas = events.filter((e) => e.type === "response.output_text.delta");
  const streamed = deltas.map((e) => e.delta).join("");
  assert.equal(streamed, "checking the second one now.");

  const done = events.find((e) => e.type === "response.output_text.done");
  assert.equal(done.text, "checking the second one now.");

  const itemDone = events.find(
    (e) => e.type === "response.output_item.done" && e.item?.type === "message",
  );
  assert.equal(itemDone.item.content[0].text, "checking the second one now.");

  // The duplicate must not survive anywhere in the emitted bytes.
  assert.equal(out.split("checking the second one now.").length - 1, 3, "one per carrier");
});

test("collapsing is independent of upstream chunk boundaries", async () => {
  for (const chunkSize of [1, 3, 17, 64, 4096]) {
    const out = await normalize(DUPLICATED, { chunkSize });
    const streamed = eventsFrom(out)
      .filter((e) => e.type === "response.output_text.delta")
      .map((e) => e.delta)
      .join("");
    assert.equal(streamed, "checking the second one now.", `chunkSize=${chunkSize}`);
  }
});

test("a normal message passes through byte-for-byte", async () => {
  const clean = [
    block({ type: "response.created", response: { id: "r1" } }),
    block({
      type: "response.output_item.added",
      output_index: 0,
      item: { id: "m1", type: "message", role: "assistant", content: [] },
    }),
    block({ type: "response.output_text.delta", output_index: 0, item_id: "m1", delta: "Hello " }),
    block({ type: "response.output_text.delta", output_index: 0, item_id: "m1", delta: "world." }),
    block({
      type: "response.output_text.done",
      output_index: 0,
      item_id: "m1",
      text: "Hello world.",
    }),
    block({
      type: "response.output_item.done",
      output_index: 0,
      item: {
        id: "m1",
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "Hello world." }],
      },
    }),
    block({ type: "response.completed", response: { id: "r1", output: [] } }),
    "data: [DONE]\n\n",
  ].join("");

  const out = await normalize(clean);
  assert.equal(out, clean);
});

test("a tool-only turn with no message text passes through unchanged", async () => {
  const toolOnly = [
    block({
      type: "response.output_item.added",
      output_index: 0,
      item: { id: "f1", type: "function_call", name: "probe", arguments: "" },
    }),
    block({ type: "response.function_call_arguments.delta", output_index: 0, item_id: "f1", delta: "{}" }),
    block({ type: "response.output_item.done", output_index: 0, item: { id: "f1", type: "function_call" } }),
    block({ type: "response.completed", response: { id: "r1", output: [] } }),
    "data: [DONE]\n\n",
  ].join("");

  const out = await normalize(toolOnly);
  assert.equal(out, toolOnly);
});

test("a non-streaming content type is not wrapped", () => {
  assert.equal(duplicateBlockCollapseTransform("application/json"), undefined);
});

// The shape that shipped broken. A thinking model emits a large reasoning pass
// into the same output item as the visible answer -- a captured turn held
// 138 KB for one message item, 113 KB of it reasoning. When the held-byte guard
// counted that reasoning against the same budget as the answer text, it tripped
// and the item was replayed verbatim, so the duplicate survived on thinking
// routes exactly where it mattered. The guard must weigh the answer text, not
// the reasoning, while still bounding total memory.
test("a large reasoning preamble does not defeat the collapse", async () => {
  const REASONING_CHUNKS = 1200;
  const chunk = "considering the next step carefully and weighing options ";
  const reasoning = [];
  for (let i = 0; i < REASONING_CHUNKS; i += 1) {
    reasoning.push(
      block({
        type: "response.reasoning_summary_text.delta",
        output_index: 0,
        item_id: "m1",
        delta: chunk,
      }),
    );
  }

  const body = [
    block({ type: "response.created", response: { id: "r1" } }),
    block({
      type: "response.output_item.added",
      output_index: 0,
      item: { id: "m1", type: "message", role: "assistant", content: [] },
    }),
    block({
      type: "response.content_part.added",
      output_index: 0,
      item_id: "m1",
      part: { type: "output_text", text: "" },
    }),
    ...reasoning,
    block({ type: "response.output_text.delta", output_index: 0, item_id: "m1", delta: "checking the second one now." }),
    block({ type: "response.output_text.delta", output_index: 0, item_id: "m1", delta: "\n\n" }),
    block({ type: "response.output_text.delta", output_index: 0, item_id: "m1", delta: "checking the second one now." }),
    block({
      type: "response.output_text.done",
      output_index: 0,
      item_id: "m1",
      text: "checking the second one now.\n\nchecking the second one now.",
    }),
    block({ type: "response.content_part.done", output_index: 0, item_id: "m1" }),
    block({
      type: "response.output_item.done",
      output_index: 0,
      item: {
        id: "m1",
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "checking the second one now.\n\nchecking the second one now." }],
      },
    }),
    block({ type: "response.completed", response: { id: "r1", output: [] } }),
    "data: [DONE]\n\n",
  ].join("");

  // Guard the premise: this fixture must actually exceed the old 64 KiB bound,
  // otherwise it would pass even with the defect present.
  const reasoningBytes = REASONING_CHUNKS * chunk.length;
  assert.ok(reasoningBytes > 64 * 1024, `fixture must exceed the old cap (${reasoningBytes})`);

  const out = await normalize(body);
  const streamed = eventsFrom(out)
    .filter((e) => e.type === "response.output_text.delta")
    .map((e) => e.delta)
    .join("");
  assert.equal(streamed, "checking the second one now.");

  // Reasoning must still reach the client untouched.
  const reasoningOut = eventsFrom(out).filter((e) =>
    String(e.type).includes("reasoning"),
  );
  assert.equal(reasoningOut.length, REASONING_CHUNKS);
});
