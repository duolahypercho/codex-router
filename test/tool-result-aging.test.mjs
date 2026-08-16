import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { ageToolResults } from "../src/tool-result-aging.mjs";

function call(id, name = "exec_command") {
  return { type: "function_call", call_id: id, name, arguments: "{}" };
}

function output(id, value) {
  return { type: "function_call_output", call_id: id, output: value };
}

test("ages a large consumed result while preserving its call pairing and recovery evidence", () => {
  const value = `HEAD\n${"middle\n".repeat(8_000)}TAIL`;
  const input = [
    call("old", "exec_command"),
    output("old", value),
    { type: "message", role: "assistant", content: "I used that result." },
    ...Array.from({ length: 4 }, (_, index) => [
      call(`new-${index}`),
      output(`new-${index}`, "small"),
    ]).flat(),
  ];

  const result = ageToolResults(input);
  assert.notEqual(result.input, input);
  assert.equal(result.stats.toolResultsAged, 1);
  assert.ok(result.stats.toolResultBytesSaved > 40_000);
  assert.equal(result.input[1].call_id, "old");
  assert.match(result.input[1].output, /Repeat the preceding exec_command call/);
  assert.match(result.input[1].output, /HEAD/);
  assert.match(result.input[1].output, /TAIL/);
  assert.match(
    result.input[1].output,
    new RegExp(createHash("sha256").update(value).digest("hex")),
  );
});

test("keeps the newest four result items byte-for-byte intact", () => {
  const value = "x".repeat(40_000);
  const input = Array.from({ length: 4 }, (_, index) => [
    call(`call-${index}`),
    output(`call-${index}`, value),
    { type: "message", role: "assistant", content: "acted" },
  ]).flat();

  const result = ageToolResults(input);
  assert.equal(result.input, input);
  assert.equal(result.stats.toolResultsAged, 0);
});

test("keeps an unconsumed result even when it is outside a zero-sized frontier", () => {
  const input = [call("pending"), output("pending", "x".repeat(40_000))];
  const result = ageToolResults(input, { frontier: 0 });
  assert.equal(result.input, input);
});

test("does not rewrite image-bearing or mixed output parts", () => {
  const input = [
    call("image", "view_image"),
    {
      type: "function_call_output",
      call_id: "image",
      output: [
        { type: "input_text", text: "x".repeat(40_000) },
        { type: "input_image", image_url: "data:image/png;base64,AAAA" },
      ],
    },
    { type: "message", role: "assistant", content: "acted" },
  ];
  const result = ageToolResults(input, { frontier: 0 });
  assert.equal(result.input, input);
});

test("can be disabled without copying or changing the input", () => {
  const input = [
    call("old"),
    output("old", "x".repeat(40_000)),
    { type: "message", role: "assistant", content: "acted" },
  ];
  const result = ageToolResults(input, { enabled: false, frontier: 0 });
  assert.equal(result.input, input);
  assert.deepEqual(result.stats, {
    toolResultsAged: 0,
    toolResultBytesBefore: 0,
    toolResultBytesAfter: 0,
    toolResultBytesSaved: 0,
  });
});

test("does not split surrogate pairs at either preview boundary", () => {
  const value = `${"a".repeat(1_023)}😀${"z".repeat(40_000)}😀${"b".repeat(1_023)}`;
  const input = [
    call("old"),
    output("old", value),
    { type: "message", role: "assistant", content: "acted" },
  ];
  const result = ageToolResults(input, { frontier: 0 });
  assert.doesNotMatch(result.input[1].output, /�/);
  assert.equal((result.input[1].output.match(/😀/gu) || []).length, 2);
});

// The failure this instrumentation exists for: a session that spends its whole
// context on results which each sit under the floor reported the same empty
// stats as a pass that never ran, so an operator could not tell an ineffective
// feature from an unloaded one.
test("a pass that ages nothing still reports what it evaluated and the largest result it saw", () => {
  const input = [
    ...Array.from({ length: 12 }, (_, index) => [
      call(`mid-${index}`),
      output(`mid-${index}`, "x".repeat(12_000)),
      { type: "message", role: "assistant", content: `read ${index}` },
    ]).flat(),
  ];
  const { stats, input: unchanged } = ageToolResults(input);
  assert.equal(stats.toolResultsAged, 0);
  assert.equal(stats.toolResultsEvaluated, 8, "the four newest results stay protected");
  assert.equal(stats.toolResultBytesLargest, 12_000);
  assert.equal(unchanged, input, "nothing qualified, so the input is passed through by reference");
});

test("a disabled pass stays distinguishable from one that ran and found nothing", () => {
  const input = [call("a"), output("a", "x".repeat(12_000))];
  const off = ageToolResults(input, { enabled: false });
  assert.equal(off.stats.toolResultsEvaluated, undefined);
  assert.equal(off.stats.toolResultBytesLargest, undefined);
  const on = ageToolResults(input);
  assert.equal(on.stats.toolResultsEvaluated, 0, "every result here sits inside the frontier");
});

// Reported alongside #256: the 400 was seen with "Compact old tool results"
// switched on, so the pass had to be cleared of rewriting the reasoning that
// a thinking provider demands back. It only ever replaces the `output` of a
// tool result; reasoning items and assistant messages come out by reference.
test("a pass that ages a result leaves the reasoning and assistant turns around it untouched", () => {
  const reasoning = {
    type: "reasoning",
    id: "rs_1",
    summary: [{ type: "summary_text", text: "The user wants the log tail." }],
    content: null,
  };
  const answer = {
    type: "message",
    role: "assistant",
    content: [{ type: "output_text", text: "Here is what the log says." }],
  };
  const input = [
    reasoning,
    call("old", "exec_command"),
    output("old", `HEAD\n${"middle\n".repeat(8_000)}TAIL`),
    answer,
    ...Array.from({ length: 4 }, (_, index) => [
      call(`new-${index}`),
      output(`new-${index}`, "small"),
    ]).flat(),
  ];

  const result = ageToolResults(input);
  assert.equal(result.stats.toolResultsAged, 1, "the old result did qualify");
  assert.equal(result.input[0], reasoning, "the reasoning item is passed through by reference");
  assert.equal(result.input[3], answer, "the assistant turn is passed through by reference");
  assert.deepEqual(
    result.input.filter((item) => item.type === "reasoning"),
    [reasoning],
  );
});
