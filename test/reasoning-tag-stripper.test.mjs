import assert from "node:assert/strict";
import { Readable, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import test from "node:test";

import {
  ReasoningTagStripper,
  reasoningTagStripperTransform,
  stripThinkTags,
} from "../src/reasoning-tag-stripper.mjs";

function block(event, sep = "\n\n") {
  return `event: ${event.type}\ndata: ${JSON.stringify(event)}${sep}`;
}

async function run(input, { chunkSize = 0 } = {}) {
  const t = new ReasoningTagStripper();
  const chunks = [];
  const sink = new Writable({
    write(chunk, _e, cb) {
      chunks.push(Buffer.from(chunk));
      cb();
    },
  });
  const source = [];
  if (chunkSize > 0) {
    const buf = Buffer.from(input);
    for (let at = 0; at < buf.length; at += chunkSize) source.push(buf.subarray(at, at + chunkSize));
  } else {
    source.push(Buffer.from(input));
  }
  await pipeline(Readable.from(source), t, sink);
  return Buffer.concat(chunks).toString("utf8");
}

function collect(body) {
  let deltas = "";
  const done = [];
  const messages = [];
  for (const chunk of body.split(/\r?\n\r?\n/)) {
    const dl = chunk.split(/\r?\n/).find((l) => l.startsWith("data:"));
    if (!dl) continue;
    let e;
    try {
      e = JSON.parse(dl.slice(5).trim());
    } catch {
      continue;
    }
    if (e.type === "response.output_text.delta") deltas += e.delta;
    if (e.type === "response.output_text.done") done.push(e.text);
    if (e.type === "response.output_item.done" && e.item?.type === "message") {
      messages.push((e.item.content || []).map((c) => c.text || "").join(""));
    }
  }
  return { deltas, done, messages };
}

test("stripThinkTags handles the real leak shapes", () => {
  assert.equal(stripThinkTags("<think>The capital of France is Paris.</think>\nParis"), "Paris");
  assert.equal(stripThinkTags("\n</think>\n\nThe real answer."), "The real answer.");
  assert.equal(stripThinkTags("\n</think>\n\n"), "");
  assert.equal(stripThinkTags("A<think>hidden</think>B"), "AB");
  assert.equal(stripThinkTags("Paris"), "Paris"); // no tags -> unchanged (identity)
  assert.equal(stripThinkTags("less < than, not a tag"), "less < than, not a tag");
});

test("stripThinkTags covers the reasoning-delimiter family the model varies to", () => {
  // Captured live from qwen3.8-flash when nudged: it varies the tag name.
  assert.equal(stripThinkTags("<thinking>The capital of France is Paris.</thinking>\nParis"), "Paris");
  assert.equal(stripThinkTags("<reason>The capital of France is Paris.</reason>\nParis"), "Paris");
  assert.equal(stripThinkTags("<reasoning>x</reasoning>\nAnswer"), "Answer");
  assert.equal(stripThinkTags("\n</thinking>\n\nOrphan close variant."), "Orphan close variant.");
  // `<think>` must not be mis-detected inside `<thinking>`.
  assert.equal(stripThinkTags("<thinking>a</thinking>B"), "B");
});

// The tag opening is split across deltas exactly as captured from the router
// ("<th" then "ink>..."), which a naive per-delta replace would miss.
const SPLIT_DELTAS = ["<th", "ink>The capital of", " France is", " Paris.</think>", "\nParis"];
const FULL = SPLIT_DELTAS.join("");

function streamCase(deltas) {
  return (
    deltas.map((d) => block({ type: "response.output_text.delta", output_index: 0, delta: d })).join("") +
    block({ type: "response.output_text.done", output_index: 0, text: deltas.join("") }) +
    block({
      type: "response.output_item.done",
      output_index: 0,
      item: { id: "m1", type: "message", role: "assistant", content: [{ type: "output_text", text: deltas.join("") }] },
    })
  );
}

test("strips a think span split across deltas; delta concat == done == message == full strip", async () => {
  const out = await run(streamCase(SPLIT_DELTAS));
  const { deltas, done, messages } = collect(out);
  const expected = stripThinkTags(FULL);
  assert.equal(expected, "Paris");
  assert.equal(deltas, expected);
  assert.deepEqual(done, [expected]);
  assert.deepEqual(messages, [expected]);
});

test("convergence holds across every chunk boundary", async () => {
  for (const chunkSize of [1, 2, 3, 5, 11, 50]) {
    const out = await run(streamCase(SPLIT_DELTAS), { chunkSize });
    const { deltas } = collect(out);
    assert.equal(deltas, "Paris", `chunkSize=${chunkSize}`);
  }
});

test("streams a split <thinking> variant identically to a full strip", async () => {
  const deltas = ["<thi", "nking>The capital", " is Paris.</thin", "king>", "\nParis"];
  const expected = stripThinkTags(deltas.join(""));
  assert.equal(expected, "Paris");
  for (const chunkSize of [0, 1, 4, 13]) {
    const { deltas: d } = collect(await run(streamCase(deltas), { chunkSize }));
    assert.equal(d, expected, `chunkSize=${chunkSize}`);
  }
});

test("strips an orphan leading </think> from the streamed answer", async () => {
  const deltas = ["\n</think>\n\n", "The real ", "answer."];
  const out = await run(streamCase(deltas));
  const { deltas: d, done, messages } = collect(out);
  assert.equal(d, "The real answer.");
  assert.deepEqual(done, ["The real answer."]);
  assert.deepEqual(messages, ["The real answer."]);
});

test("a clean answer with no tags passes through byte-for-byte", async () => {
  const clean = streamCase(["Paris", " is the ", "capital."]);
  assert.equal(await run(clean), clean);
  assert.equal(await run(clean, { chunkSize: 9 }), clean);
});

test("does not touch reasoning_summary or function_call items", async () => {
  const input =
    block({ type: "response.reasoning_summary_text.delta", output_index: 0, delta: "<think>internal</think>" }) +
    block({ type: "response.output_item.done", output_index: 1, item: { id: "f1", type: "function_call", name: "t", arguments: "{}" } });
  assert.equal(await run(input), input);
});

test("keeps per-index state so two message items strip independently", async () => {
  const input =
    block({ type: "response.output_text.delta", output_index: 0, delta: "<think>a</think>Zero" }) +
    block({ type: "response.output_text.delta", output_index: 2, delta: "<think>b</think>Two" }) +
    block({ type: "response.output_text.done", output_index: 0, text: "<think>a</think>Zero" }) +
    block({ type: "response.output_text.done", output_index: 2, text: "<think>b</think>Two" });
  const out = await run(input);
  const { deltas } = collect(out);
  assert.equal(deltas, "ZeroTwo");
});

test("factory gates on event-stream content type", () => {
  assert.ok(reasoningTagStripperTransform("text/event-stream") instanceof ReasoningTagStripper);
  assert.equal(reasoningTagStripperTransform("application/json"), undefined);
});
