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

test("an answer with no reasoning tags streams through byte-for-byte", async () => {
  // The stripper trimmed the message's leading whitespace unconditionally, but
  // `stripThinkTags` only trims when it removed a tag -- so an ordinary answer
  // that opens with a newline (a fenced code block, a leading blank line) lost
  // it from the streamed deltas while the `output_text.done` snapshot beside it
  // kept it, and an all-whitespace first delta was dropped from the stream
  // entirely.
  const text = "\n```py\nprint(1)\n```";
  const body =
    block({ type: "response.output_text.delta", output_index: 0, delta: "\n" }) +
    block({ type: "response.output_text.delta", output_index: 0, delta: "```py\nprint(1)\n```" }) +
    block({ type: "response.output_text.done", output_index: 0, text });

  for (const chunkSize of [0, 1, 7]) {
    const { deltas, done } = collect(await run(body, { chunkSize }));
    assert.equal(deltas, text, `deltas lost the leading newline at chunkSize=${chunkSize}`);
    assert.equal(done[0], text);
    // The two channels must agree, or the rendered answer and the stored one differ.
    assert.equal(deltas, done[0]);
  }
});

test("streamed deltas keep every reasoning-free message that has visible text", () => {
  // Property: with no tag anywhere and at least one visible character, the
  // delta stream is the identity, exactly as `stripThinkTags` is. Checked over
  // several splits of a deliberately tag-adjacent alphabet, so a partial tag
  // held across deltas is covered too.
  const pieces = ["", " ", "\n", "\t", "<", ">", "/", "think", "reason", "x", "B"];
  const TAG = /<\/?(?:thinking|reasoning|think|reason)>/;
  // A trailing prefix of a tag ("a <", "x<th") is held back as a possible split
  // tag and released only by `flush`, whose return value the transform does not
  // emit. Pre-existing and unchanged here.
  const PARTIAL = /<\/?(?:t(?:h(?:i(?:n(?:k)?)?)?)?|r(?:e(?:a(?:s(?:o(?:n)?)?)?)?)?)?$/;
  for (const a of pieces) {
    for (const b of pieces) {
      for (const c of pieces) {
        const text = a + b + c;
        // A real tag has its own documented behavior; an all-whitespace message
        // is covered by the case below; and a message ending mid-tag is held by
        // `#partialHold`, which this change does not touch (see PARTIAL below).
        if (TAG.test(text) || !/\S/.test(text) || PARTIAL.test(text)) continue;
        assert.equal(
          stripThinkTags(text),
          text,
          `stripThinkTags is not the identity for ${JSON.stringify(text)}`,
        );
        for (const split of [[text], [a, b, c], [a + b, c], [a, b + c]]) {
          const events = split
            .filter((part) => part.length > 0)
            .map((part) =>
              block({ type: "response.output_text.delta", output_index: 0, delta: part }),
            )
            .join("");
          if (!events) continue;
          const stripper = new ReasoningTagStripper();
          stripper.write(Buffer.from(events));
          stripper.end();
          let streamed = "";
          let chunk;
          while ((chunk = stripper.read()) !== null) streamed += chunk.toString("utf8");
          assert.equal(
            collect(streamed).deltas,
            text,
            `stream changed untagged ${JSON.stringify(text)} split as ${JSON.stringify(split)}`,
          );
        }
      }
    }
  }
});

test("a delta that is only whitespace is still held back", () => {
  // Unchanged from before: the lead is released by the first visible character,
  // so a message that never produces one contributes no delta. The terminal
  // `output_text.done` snapshot carries the text either way, and a model answer
  // made only of whitespace is not one.
  const stripper = new ReasoningTagStripper();
  stripper.write(
    Buffer.from(block({ type: "response.output_text.delta", output_index: 0, delta: " " })),
  );
  stripper.end();
  let streamed = "";
  let chunk;
  while ((chunk = stripper.read()) !== null) streamed += chunk.toString("utf8");
  assert.equal(collect(streamed).deltas, "");
});

test("held leading whitespace is dropped by a tag that only arrives in a later delta", () => {
  // The hold and the split-tag carry are separate mechanisms, and this is where
  // they meet: the leading "\n" is still pending when a `<think>` starts to
  // arrive one character at a time. The removal has to reach the held
  // whitespace, or the answer renders behind a blank line again. Passes before
  // this change too -- it pins the new `#pendingLead` path, it does not prove it.
  const deltas = ["\n", "<th", "ink>hidden</think>", "\nAnswer"];
  const stripper = new ReasoningTagStripper();
  for (const delta of deltas) {
    stripper.write(
      Buffer.from(block({ type: "response.output_text.delta", output_index: 0, delta })),
    );
  }
  stripper.end();
  let streamed = "";
  let chunk;
  while ((chunk = stripper.read()) !== null) streamed += chunk.toString("utf8");
  assert.equal(collect(streamed).deltas, "Answer");
  assert.equal(collect(streamed).deltas, stripThinkTags(deltas.join("")));
});

test("a long whitespace-only run is held in bounded time and loses nothing", () => {
  // The hold must not become an unbounded buffer re-scanned on every delta:
  // that is O(n) per delta and O(n^2) over a run of whitespace-only ones. The
  // run here is far past MAX_PENDING_LEAD, and carries no tag, so the stripper
  // owes the answer every byte of its own leading whitespace back.
  // Sized from measurement, not taste: at this many deltas the pre-fix
  // implementation took ~14s through this same transform and the bounded one
  // takes ~115ms. Both margins against the guard below are then wide, so it
  // neither flakes on a loaded runner nor lets the quadratic version pass on a
  // fast one.
  const lead = "\n".repeat(64 * 16_000);
  const text = `${lead}Answer`;
  const stripper = new ReasoningTagStripper();
  const started = process.hrtime.bigint();
  let streamed = "";
  for (let at = 0; at < text.length; at += 64) {
    stripper.write(
      Buffer.from(
        block({
          type: "response.output_text.delta",
          output_index: 0,
          delta: text.slice(at, at + 64),
        }),
      ),
    );
    let chunk;
    while ((chunk = stripper.read()) !== null) streamed += chunk.toString("utf8");
  }
  stripper.end();
  let chunk;
  while ((chunk = stripper.read()) !== null) streamed += chunk.toString("utf8");
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;

  assert.equal(collect(streamed).deltas, text);
  assert.equal(collect(streamed).deltas, stripThinkTags(text));
  // A complexity guard, not a benchmark: ~26x headroom over the bounded
  // implementation, and the quadratic one overshoots it ~5x.
  assert.ok(elapsedMs < 3_000, `whitespace-only run took ${elapsedMs.toFixed(0)}ms`);
});

test("whitespace held past the cap is still dropped by a tag that follows it", () => {
  // Settling at the cap gives up the *retraction*, not the stripping: the tag
  // itself is still removed, and only the leading whitespace stays behind.
  const text = `${" ".repeat(20_000)}<think>hidden</think>Answer`;
  const stripper = new ReasoningTagStripper();
  stripper.write(
    Buffer.from(block({ type: "response.output_text.delta", output_index: 0, delta: text })),
  );
  stripper.end();
  let streamed = "";
  let chunk;
  while ((chunk = stripper.read()) !== null) streamed += chunk.toString("utf8");
  const { deltas } = collect(streamed);
  assert.ok(!deltas.includes("hidden"), "reasoning survived the cap path");
  assert.ok(!deltas.includes("<think>"), "tag survived the cap path");
  assert.equal(deltas.trimStart(), "Answer");
});
