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

async function run(input, { chunkSize = 0, ...options } = {}) {
  const t = new ReasoningTagStripper(options);
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

function events(body) {
  return body.split(/\r?\n\r?\n/).flatMap((frame) => {
    const data = frame.split(/\r?\n/).find((line) => line.startsWith("data:"));
    if (!data) return [];
    try {
      return [JSON.parse(data.slice(5).trim())];
    } catch {
      return [];
    }
  });
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

test("a trailing incomplete tag is emitted before the text snapshot and stored item", async () => {
  for (const tail of ["<", "</", "<th", "</reasonin", "<thinking", "<think:", "</think:6124"]) {
    const text = `Keep this literal tail: ${tail}`;
    for (const options of [{}, { nonceDelimiters: true }]) {
      for (const chunkSize of [0, 1, 13]) {
        const output = await run(streamCase(["Keep this literal tail: ", tail]), { chunkSize, ...options });
        const { deltas, done, messages } = collect(output);
        assert.equal(deltas, text, `${JSON.stringify({ tail, options, chunkSize })}`);
        assert.deepEqual(done, [text]);
        assert.deepEqual(messages, [text]);
        const emitted = events(output);
        const tailAt = emitted.findIndex((event) => event.delta === tail);
        const doneAt = emitted.findIndex((event) => event.type === "response.output_text.done");
        assert.ok(tailAt >= 0 && tailAt < doneAt, "held text must precede its text completion");
      }
    }
  }
});

test("a partial tag is preserved when the stream ends without a text snapshot", async () => {
  for (const text of ["An inequality: x <", "<th", "\n\t<", " \n\t"]) {
    const input = block({ type: "response.output_text.delta", output_index: 0, delta: text });
    assert.equal(collect(await run(input)).deltas, text);
    assert.equal(collect(await run(input, { chunkSize: 1 })).deltas, text);
  }
});

test("held tails precede every item or response completion and are emitted once", async () => {
  const delta = { type: "response.output_text.delta", output_index: 2, content_index: 1, item_id: "m2", delta: "x <th" };
  for (const terminal of [
    { type: "response.content_part.done", output_index: 2, content_index: 1, part: { type: "output_text", text: "x <th" } },
    { type: "response.output_item.done", output_index: 2, item: { id: "m2", type: "message", content: [{ type: "output_text", text: "x <th" }] } },
    { type: "response.completed", response: { status: "completed", output: [] } },
    { type: "response.failed", response: { status: "failed", output: [] } },
    { type: "response.incomplete", response: { status: "incomplete", output: [] } },
    { type: "error", error: { code: "upstream_error" } },
  ]) {
    const output = await run(block(delta) + block(terminal));
    const emitted = events(output);
    assert.equal(collect(output).deltas, delta.delta, terminal.type);
    assert.equal(emitted.at(-1).type, terminal.type);
    assert.deepEqual(emitted.at(-2), { ...delta, delta: "<th" });
    assert.equal(emitted.filter((event) => event.delta === "<th").length, 1);
  }
  const done = await run(block(delta) + "data: [DONE]\n\n");
  assert.equal(collect(done).deltas, delta.delta);
  assert.ok(done.indexOf('"delta":"<th"') < done.indexOf("data: [DONE]"));
});

test("content parts never join their partial tags, and finishing one leaves the others pending", async () => {
  const input =
    block({ type: "response.output_text.delta", output_index: 0, content_index: 0, item_id: "m0", delta: "First <th" }) +
    block({ type: "response.output_text.delta", output_index: 0, content_index: 1, item_id: "m0", delta: "ink>Second <" }) +
    block({ type: "response.output_text.delta", output_index: 3, content_index: 0, item_id: "m3", delta: "Third </re" }) +
    block({ type: "response.output_text.done", output_index: 0, content_index: 0, text: "First <th" }) +
    block({ type: "response.output_text.delta", output_index: 0, content_index: 1, item_id: "m0", delta: "reason" }) +
    block({ type: "response.output_item.done", output_index: 0, item: { type: "message", content: [] } }) +
    block({ type: "response.output_text.done", output_index: 3, content_index: 0, text: "Third </re" });
  const output = events(await run(input));
  const textByPart = new Map();
  for (const event of output) {
    if (event.type !== "response.output_text.delta") continue;
    const key = `${event.output_index}:${event.content_index}`;
    textByPart.set(key, (textByPart.get(key) || "") + event.delta);
  }
  assert.deepEqual([...textByPart], [["0:0", "First <th"], ["0:1", "ink>Second <reason"], ["3:0", "Third </re"]]);
  const firstDone = output.findIndex((event) => event.type === "response.output_text.done" && event.output_index === 0);
  assert.equal(output[firstDone - 1].delta, "<th");
  assert.ok(output.findIndex((event) => event.delta === "<reason") > firstDone);
});

test("inserted tails retain content identity without duplicate sequence ids or logprobs", async () => {
  const input =
    block({ type: "response.output_text.delta", output_index: 0, content_index: 1, item_id: "m0", sequence_number: 8, logprobs: [{ token: "x" }], delta: "x <" }) +
    block({ type: "response.output_text.done", output_index: 0, content_index: 1, item_id: "m0", sequence_number: 9, text: "x <" }) +
    block({ type: "response.output_item.done", output_index: 0, sequence_number: 10, item: { type: "message", content: [] } }) +
    block({ type: "response.completed", sequence_number: 11, response: { status: "completed" } });
  const output = events(await run(input));
  assert.deepEqual(output.map((event) => event.sequence_number), [8, 9, 10, 11, 12]);
  assert.deepEqual(output[1], { type: "response.output_text.delta", output_index: 0, content_index: 1, item_id: "m0", sequence_number: 9, delta: "<" });
  assert.deepEqual(output[0].logprobs, [{ token: "x" }], "real delta metadata survives");
});

test("an unterminated final SSE frame still separates its flushed tail", async () => {
  const input = block({ type: "response.output_text.delta", output_index: 0, delta: "x <" }, "");
  assert.equal(collect(await run(input)).deltas, "x <");
});

test("held tails adopt CRLF framing and do not repeat the prior SSE id", async () => {
  const delta = { type: "response.output_text.delta", output_index: 0, delta: "x <" };
  const done = { type: "response.output_text.done", output_index: 0, text: "x <" };
  const input = `id: source-delta\r\nevent: ${delta.type}\r\ndata: ${JSON.stringify(delta)}\r\n\r\n` +
    `event: ${done.type}\r\ndata: ${JSON.stringify(done)}\r\n\r\n`;
  const output = await run(input, { chunkSize: 1 });
  assert.equal(collect(output).deltas, "x <");
  assert.ok(!/(?<!\r)\n/.test(output), "synthetic frame must retain CRLF");
  assert.equal(output.match(/id: source-delta/g).length, 1);
});

test("invalid UTF-8 releases preceding valid text and then relays the malformed bytes", async () => {
  const prefix = Buffer.from(block({ type: "response.output_text.delta", output_index: 0, delta: "x <" }));
  const invalid = Buffer.from([0xff, 0x0a, 0x0a]);
  const remainder = Buffer.from(block({ type: "response.output_text.delta", output_index: 0, delta: "raw <think>" }));
  const transform = new ReasoningTagStripper();
  const chunks = [];
  await pipeline(Readable.from([prefix, invalid, remainder]), transform, new Writable({
    write(chunk, _encoding, done) { chunks.push(chunk); done(); },
  }));
  const output = Buffer.concat(chunks);
  const invalidAt = output.indexOf(invalid);
  assert.notEqual(invalidAt, -1);
  assert.equal(collect(output.subarray(0, invalidAt).toString("utf8")).deltas, "x <");
  assert.deepEqual(output.subarray(invalidAt), Buffer.concat([invalid, remainder]));
});

test("an unfinished legacy reasoning span does not leak its held suffix on completion", async () => {
  const input = block({ type: "response.output_text.delta", output_index: 0, delta: "<think>hidden <th" }) +
    block({ type: "response.failed", response: { status: "failed" } });
  assert.equal(collect(await run(input)).deltas, "");
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

test("streamed deltas keep every reasoning-free message, including partial tags and whitespace", () => {
  // Property: with no complete tag anywhere, the
  // delta stream is the identity, exactly as `stripThinkTags` is. Checked over
  // several splits of a deliberately tag-adjacent alphabet, so a partial tag
  // held across deltas is covered too.
  const pieces = ["", " ", "\n", "\t", "<", ">", "/", "think", "reason", "x", "B"];
  const TAG = /<\/?(?:thinking|reasoning|think|reason)>/;
  for (const a of pieces) {
    for (const b of pieces) {
      for (const c of pieces) {
        const text = a + b + c;
        // Complete tags have their own opt-in legacy behavior. A possible tag
        // that never completes is ordinary text, including when it is the tail.
        if (TAG.test(text)) continue;
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

test("held whitespace is released when a message finishes without a tag", () => {
  const stripper = new ReasoningTagStripper();
  stripper.write(
    Buffer.from(block({ type: "response.output_text.delta", output_index: 0, delta: " " })),
  );
  stripper.end();
  let streamed = "";
  let chunk;
  while ((chunk = stripper.read()) !== null) streamed += chunk.toString("utf8");
  assert.equal(collect(streamed).deltas, " ");
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

// --- Hy4's nonce-suffixed delimiters (#654) -------------------------------
//
// `commandcode/hy4-preview` writes `</think:6124c78e>`, and a serving stack
// that swallows the opening tag leaves the model's planning prose in the
// visible answer behind nothing but that orphan close. The grammar is gated to
// the Hy4 family, so every case below is asserted both ways: untouched without
// `nonceDelimiters`, stripped with it.
const NONCE = { nonceDelimiters: true };
// The nonce and delimiters reported on the leaking turns; the prose is not.
const HEX = "6124c78e";

test("an orphan nonce close ends the leaked reasoning and takes its prose with it", () => {
  const leak = `Let me keep reading the behavior code.</think:${HEX}>The answer is 4.`;
  assert.equal(stripThinkTags(leak), leak, "ungated routes must not reinterpret the text");
  assert.equal(stripThinkTags(leak, NONCE), "The answer is 4.");
  // The same shape on the tool-call markup's own names (one reported turn ended
  // on `</arg_value:NONCE>`).
  const args = `tail -5 .qa/eo-up.log</arg_value:${HEX}>Done.`;
  assert.equal(stripThinkTags(args), args);
  assert.equal(stripThinkTags(args, NONCE), "Done.");
  // Whitespace that framed the removed block goes with it.
  assert.equal(stripThinkTags(`hidden\n</think:${HEX}>\n\nAnswer.`, NONCE), "Answer.");
});

test("a matched nonce span is stripped like a bare <think> span", () => {
  const span = `<think:${HEX}>hidden</think:${HEX}>Answer.`;
  assert.equal(stripThinkTags(span), span);
  assert.equal(stripThinkTags(span, NONCE), "Answer.");
  // A close that repeats an opening tag already seen is that span's end, not a
  // terminator: the text between the two spans survives.
  assert.equal(stripThinkTags(`A<think:${HEX}>r</think:${HEX}>B</think:${HEX}>C`, NONCE), "ABC");
});

test("the nonce grammar leaves the tool-call markup's own spans verbatim", () => {
  // `src/leaked-tool-call-recovery.mjs` runs first and relays a span it cannot
  // parse verbatim on purpose. Deleting it here would undo that.
  const markup = `<tool_calls:${HEX}><tool_call:${HEX}>exec_command</tool_call:${HEX}></tool_calls:${HEX}>`;
  assert.equal(stripThinkTags(markup, NONCE), markup);
  assert.equal(stripThinkTags(`x<arg_value:${HEX}>v</arg_value:${HEX}>y`, NONCE), `x<arg_value:${HEX}>v</arg_value:${HEX}>y`);
});

test("a bare </think> keeps its prefix on every route", () => {
  // The suffix is what makes "everything before this was reasoning" safe to
  // act on; `</think>` is ordinary enough to appear in an answer about tags.
  assert.equal(stripThinkTags("Close it with </think> at the end.", NONCE), "Close it with  at the end.");
  assert.equal(stripThinkTags("PRIVATE</think>FINAL", NONCE), "PRIVATEFINAL");
});

test("a nonce delimiter split across deltas is still recognised", async () => {
  const deltas = ["Let me check the ", "log first.</thi", `nk:${HEX.slice(0, 4)}`, `${HEX.slice(4)}>`, "The answer is 4."];
  const text = deltas.join("");
  assert.equal(stripThinkTags(text, NONCE), "The answer is 4.");
  for (const chunkSize of [0, 1, 3, 17]) {
    const { deltas: d, done, messages } = collect(await run(streamCase(deltas), { chunkSize, ...NONCE }));
    // The close is spread over three deltas and two of its pieces are not tags
    // on their own; none of them may reach the answer as literal text.
    assert.ok(!/<\/?thi/.test(d), `delimiter fragment survived at chunkSize=${chunkSize}: ${d}`);
    assert.ok(!d.includes(HEX), `nonce survived at chunkSize=${chunkSize}: ${d}`);
    assert.deepEqual(done, ["The answer is 4."], `chunkSize=${chunkSize}`);
    assert.deepEqual(messages, ["The answer is 4."], `chunkSize=${chunkSize}`);
  }
  // Ungated, the same stream keeps every byte of text it carried (the deltas
  // are re-split around the partial tag the plain grammar holds, but nothing
  // is added or removed).
  const ungated = collect(await run(streamCase(deltas)));
  assert.equal(ungated.deltas, text);
  assert.deepEqual(ungated.done, [text]);
  assert.deepEqual(ungated.messages, [text]);
});

test("prose already streamed before the orphan close is still cleaned from what is stored", async () => {
  // The delta channel cannot retract bytes it has emitted, so the reasoning
  // does reach the screen when it arrives in an earlier delta than its close.
  // The `.done` snapshot and the stored message item -- what Codex replays into
  // the next turn -- are cleaned regardless. That is what stops the leak from
  // accumulating in context.
  const deltas = ["I should read the file first.", `</think:${HEX}>`, "The answer is 4."];
  const { deltas: d, done, messages } = collect(await run(streamCase(deltas), NONCE));
  assert.deepEqual(done, ["The answer is 4."]);
  assert.deepEqual(messages, ["The answer is 4."]);
  assert.ok(!d.includes(`</think:${HEX}>`), "the delimiter itself must never be rendered");
  // Reasoning the stripper still holds when the close arrives is dropped.
  const held = collect(await run(streamCase([`I should read the file first.</think:${HEX}>The answer is 4.`]), NONCE));
  assert.equal(held.deltas, "The answer is 4.");
});

test("nonce state is per output index", async () => {
  const input =
    block({ type: "response.output_text.delta", output_index: 0, delta: `r0</think:${HEX}>Zero` }) +
    block({ type: "response.output_text.delta", output_index: 2, delta: `r2</think:${HEX}>Two` });
  const { deltas } = collect(await run(input, NONCE));
  assert.equal(deltas, "ZeroTwo");
});

test("the factory forwards the gate", () => {
  const gated = reasoningTagStripperTransform("text/event-stream", { nonceDelimiters: true });
  assert.ok(gated instanceof ReasoningTagStripper);
  assert.equal(reasoningTagStripperTransform("text/event-stream", { nonceDelimiters: true }) === gated, false);
  assert.ok(reasoningTagStripperTransform("text/event-stream") instanceof ReasoningTagStripper);
});
