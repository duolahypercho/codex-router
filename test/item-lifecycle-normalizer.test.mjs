import assert from "node:assert/strict";
import { Readable, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import test from "node:test";

import { ItemLifecycleNormalizer } from "../src/item-lifecycle-normalizer.mjs";

// Build an SSE block for a Responses event. `sep` lets a test exercise both LF
// and CRLF framing without changing the events.
function block(event, sep = "\n\n") {
  return `event: ${event.type}\ndata: ${JSON.stringify(event)}${sep}`;
}

async function normalize(input, { chunkSize = 0 } = {}) {
  const norm = new ItemLifecycleNormalizer();
  const chunks = [];
  const collector = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(Buffer.from(chunk));
      callback();
    },
  });
  const source = [];
  if (chunkSize > 0) {
    const buf = Buffer.from(input);
    for (let at = 0; at < buf.length; at += chunkSize) {
      source.push(buf.subarray(at, at + chunkSize));
    }
  } else {
    source.push(Buffer.from(input));
  }
  await pipeline(Readable.from(source), norm, collector);
  return Buffer.concat(chunks).toString("utf8");
}

// The ordered list of item lifecycle boundaries, for asserting sequence.
function itemBoundaries(body) {
  const out = [];
  for (const chunk of body.split(/\r?\n\r?\n/)) {
    const dataLines = chunk
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trim());
    if (!dataLines.length) continue;
    const dataText = dataLines.join("\n");
    if (dataText === "[DONE]") continue;
    let event;
    try {
      event = JSON.parse(dataText);
    } catch {
      continue;
    }
    if (
      event.type === "response.output_item.added" ||
      event.type === "response.output_item.done"
    ) {
      out.push(`${event.output_index}:${event.type.split(".").pop()}`);
    }
  }
  return out;
}

// The sorted multiset of data payloads, to prove events are only reordered --
// never added, dropped, or mutated.
function payloadMultiset(body) {
  return body
    .split(/\r?\n\r?\n/)
    .map((chunk) =>
      chunk
        .split(/\r?\n/)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5))
        .join("\n"),
    )
    .filter(Boolean)
    .sort();
}

// The failure JD reported: a `message` item stays open while a `function_call`
// item opens and closes, then the message closes late. This is the exact shape
// captured live from the router's Qwen path via LiteLLM.
const INTERLEAVED = [
  block({ type: "response.created", response: { id: "r1" } }),
  block({ type: "response.in_progress", response: { id: "r1" } }),
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
  block({ type: "response.output_text.delta", output_index: 0, item_id: "m1", delta: "I'll check." }),
  block({
    type: "response.output_item.added",
    output_index: 1,
    item: { id: "f1", type: "function_call", name: "get_weather", arguments: "" },
  }),
  block({ type: "response.function_call_arguments.delta", output_index: 1, item_id: "f1", delta: "{\"city\"" }),
  block({ type: "response.function_call_arguments.done", output_index: 1, item_id: "f1", arguments: "{\"city\":\"Tokyo\"}" }),
  block({
    type: "response.output_item.done",
    output_index: 1,
    item: { id: "f1", type: "function_call", name: "get_weather", arguments: "{\"city\":\"Tokyo\"}" },
  }),
  block({ type: "response.output_text.done", output_index: 0, item_id: "m1", text: "I'll check." }),
  block({ type: "response.content_part.done", output_index: 0, item_id: "m1", part: { type: "output_text", text: "I'll check." } }),
  block({
    type: "response.output_item.done",
    output_index: 0,
    item: {
      id: "m1",
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text: "I'll check." }],
    },
  }),
  block({ type: "response.completed", response: { id: "r1", output: [] } }),
  "data: [DONE]\n\n",
].join("");

test("reorders an interleaved message/function_call turn into sequential items", async () => {
  const before = itemBoundaries(INTERLEAVED);
  assert.deepEqual(before, ["0:added", "1:added", "1:done", "0:done"]);

  const out = await normalize(INTERLEAVED);
  assert.deepEqual(itemBoundaries(out), ["0:added", "0:done", "1:added", "1:done"]);
});

test("reorders identically regardless of upstream chunk boundaries", async () => {
  for (const chunkSize of [1, 7, 40, 200]) {
    const out = await normalize(INTERLEAVED, { chunkSize });
    assert.deepEqual(
      itemBoundaries(out),
      ["0:added", "0:done", "1:added", "1:done"],
      `chunkSize=${chunkSize}`,
    );
  }
});

test("only reorders -- never adds, drops, or mutates an event", async () => {
  const out = await normalize(INTERLEAVED);
  assert.deepEqual(payloadMultiset(out), payloadMultiset(INTERLEAVED));
});

test("the function_call is fully emitted before response.completed", async () => {
  const out = await normalize(INTERLEAVED);
  const idxFn = out.indexOf('"id":"f1","type":"function_call"');
  const idxDone = out.indexOf('"type":"response.completed"');
  assert.ok(idxFn !== -1 && idxDone !== -1);
  assert.ok(idxFn < idxDone, "function_call item must precede response.completed");
});

test("a clean sequential stream passes through byte-for-byte", async () => {
  const clean = [
    block({ type: "response.created", response: { id: "r1" } }),
    block({
      type: "response.output_item.added",
      output_index: 0,
      item: { id: "m1", type: "message", role: "assistant", content: [] },
    }),
    block({ type: "response.output_text.delta", output_index: 0, item_id: "m1", delta: "hi" }),
    block({
      type: "response.output_item.done",
      output_index: 0,
      item: { id: "m1", type: "message", role: "assistant", content: [{ type: "output_text", text: "hi" }] },
    }),
    block({
      type: "response.output_item.added",
      output_index: 1,
      item: { id: "f1", type: "function_call", name: "t", arguments: "{}" },
    }),
    block({
      type: "response.output_item.done",
      output_index: 1,
      item: { id: "f1", type: "function_call", name: "t", arguments: "{}" },
    }),
    block({ type: "response.completed", response: { id: "r1", output: [] } }),
    "data: [DONE]\n\n",
  ].join("");
  assert.equal(await normalize(clean), clean);
  assert.equal(await normalize(clean, { chunkSize: 13 }), clean);
});

test("a tool-only turn (single item) passes through unchanged", async () => {
  const toolOnly = [
    block({ type: "response.created", response: { id: "r1" } }),
    block({
      type: "response.output_item.added",
      output_index: 0,
      item: { id: "f1", type: "function_call", name: "t", arguments: "" },
    }),
    block({ type: "response.function_call_arguments.done", output_index: 0, item_id: "f1", arguments: "{}" }),
    block({
      type: "response.output_item.done",
      output_index: 0,
      item: { id: "f1", type: "function_call", name: "t", arguments: "{}" },
    }),
    block({ type: "response.completed", response: { id: "r1", output: [] } }),
    "data: [DONE]\n\n",
  ].join("");
  assert.equal(await normalize(toolOnly), toolOnly);
});

test("preserves CRLF framing while reordering", async () => {
  const crlf = [
    block(
      {
        type: "response.output_item.added",
        output_index: 0,
        item: { id: "m1", type: "message", role: "assistant", content: [] },
      },
      "\r\n\r\n",
    ),
    block({ type: "response.output_text.delta", output_index: 0, item_id: "m1", delta: "x" }, "\r\n\r\n"),
    block(
      {
        type: "response.output_item.added",
        output_index: 1,
        item: { id: "f1", type: "function_call", name: "t", arguments: "{}" },
      },
      "\r\n\r\n",
    ),
    block(
      {
        type: "response.output_item.done",
        output_index: 1,
        item: { id: "f1", type: "function_call", name: "t", arguments: "{}" },
      },
      "\r\n\r\n",
    ),
    block(
      {
        type: "response.output_item.done",
        output_index: 0,
        item: { id: "m1", type: "message", role: "assistant", content: [{ type: "output_text", text: "x" }] },
      },
      "\r\n\r\n",
    ),
  ].join("");
  const out = await normalize(crlf);
  assert.deepEqual(itemBoundaries(out), ["0:added", "0:done", "1:added", "1:done"]);
  assert.ok(out.includes("\r\n\r\n"), "CRLF separators must be preserved");
  assert.ok(!out.includes("\n\n\n"), "must not corrupt separators");
});
