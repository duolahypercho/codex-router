import assert from "node:assert/strict";
import { Readable, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import test from "node:test";

import {
  createReasoningReplayJsonTap,
  createReasoningReplayTap,
  reasoningForToolCalls,
  reasoningReplayCacheStats,
  rememberReasoningForToolCalls,
  resetReasoningReplayCache,
  toolCallIdsOf,
} from "../src/chat-reasoning-replay.mjs";

// The contract this exists for (measured live on opencode's Go plan,
// 2026-09-21): a thinking-mode assistant tool call whose `reasoning_content` is
// missing -- or empty -- is answered with HTTP 400, while the model's own
// reasoning replayed passes. The client cannot always supply it (compaction,
// stateless tool-result replay), so the router remembers what it streamed.

function assistant(id, reasoning) {
  return {
    role: "assistant",
    content: "",
    tool_calls: [{ id, type: "function", function: { name: "read_file", arguments: "{}" } }],
    ...(reasoning === undefined ? {} : { reasoning_content: reasoning }),
  };
}

test("reasoning is remembered per tool-call id and replayed by id", () => {
  resetReasoningReplayCache();
  assert.equal(rememberReasoningForToolCalls(["call_a", "call_b"], "I read the file."), 2);
  assert.equal(reasoningForToolCalls(["call_a"]), "I read the file.");
  assert.equal(reasoningForToolCalls(["call_b"]), "I read the file.");
  assert.equal(reasoningForToolCalls(["call_unknown"]), undefined);
  assert.deepEqual(toolCallIdsOf(assistant("call_a")), ["call_a"]);
});

test("nothing is remembered for an empty reasoning or a lone field", () => {
  resetReasoningReplayCache();
  assert.equal(rememberReasoningForToolCalls(["call_a"], ""), 0);
  assert.equal(rememberReasoningForToolCalls([], "text"), 0);
  assert.equal(rememberReasoningForToolCalls(["call_a"], undefined), 0);
  assert.equal(reasoningReplayCacheStats().entries, 0);
});

test("the cache evicts whole turns by entry count and by characters", () => {
  resetReasoningReplayCache();
  for (let index = 0; index < 600; index += 1) {
    rememberReasoningForToolCalls([`call_${index}`], `reasoning ${index}`);
  }
  const stats = reasoningReplayCacheStats();
  assert.ok(stats.entries <= 512, `entries stayed bounded (${stats.entries})`);
  assert.equal(reasoningForToolCalls(["call_0"]), undefined, "the oldest turn was evicted");
  assert.equal(reasoningForToolCalls(["call_599"]), "reasoning 599");

  resetReasoningReplayCache();
  const big = "x".repeat(200_000);
  rememberReasoningForToolCalls(["call_big_1"], big);
  rememberReasoningForToolCalls(["call_big_2"], big);
  assert.ok(reasoningReplayCacheStats().chars <= 400_000, "characters stayed bounded");
  assert.equal(reasoningForToolCalls(["call_big_2"]), big, "the newest big turn survives");
  rememberReasoningForToolCalls(["call_big_3"], big);
  assert.ok(reasoningReplayCacheStats().chars <= 400_000, "characters stayed bounded after growth");
  assert.equal(reasoningForToolCalls(["call_big_1"]), undefined, "the oldest big turn was evicted");
});

async function runTap(chunks) {
  const seen = [];
  const tap = createReasoningReplayTap({ onStore: (event) => seen.push(event) });
  const out = [];
  await pipeline(
    Readable.from(chunks),
    tap,
    new Writable({
      write(chunk, _encoding, callback) {
        out.push(chunk.toString("utf8"));
        callback();
      },
    }),
  );
  return { seen, out: out.join("") };
}

test("the tap remembers a streamed tool-call turn and forwards every byte", async () => {
  resetReasoningReplayCache();
  const sse = [
    'data: {"choices":[{"delta":{"reasoning_content":"The user wants the file. "}}]}\n\n',
    'data: {"choices":[{"delta":{"reasoning_content":"I should read it."}}]}\n\n',
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_tap_1","function":{"name":"read_file","arguments":"{}"}}]}}]}\n\n',
    'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\n',
    "data: [DONE]\n\n",
  ];
  const { seen, out } = await runTap(sse);
  assert.equal(out, sse.join(""), "the tap changed bytes on the wire");
  assert.equal(seen.length, 1);
  assert.equal(seen[0].toolCallIds[0], "call_tap_1");
  assert.equal(
    reasoningForToolCalls(["call_tap_1"]),
    "The user wants the file. I should read it.",
  );
});

test("the tap stays silent for a turn with no tool calls", async () => {
  resetReasoningReplayCache();
  const sse = [
    'data: {"choices":[{"delta":{"reasoning_content":"just thinking"}}]}\n\n',
    'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
    "data: [DONE]\n\n",
  ];
  const { seen } = await runTap(sse);
  assert.deepEqual(seen, []);
  assert.equal(reasoningReplayCacheStats().entries, 0);
});

async function runJsonTap(body) {
  const source = Buffer.from(body);
  const seen = [];
  const out = [];
  await pipeline(
    Readable.from([source.subarray(0, 13), source.subarray(13)]),
    createReasoningReplayJsonTap({ onStore: (event) => seen.push(event) }),
    new Writable({ write(chunk, _encoding, callback) { out.push(Buffer.from(chunk)); callback(); } }),
  );
  assert.deepEqual(Buffer.concat(out), source, "JSON tap changed response bytes");
  return seen;
}

test("complete JSON tool-call reasoning is available for the next turn", async () => {
  resetReasoningReplayCache();
  const seen = await runJsonTap(JSON.stringify({ choices: [{
    finish_reason: "tool_calls",
    message: { reasoning_content: "complete thought", tool_calls: [{ id: "call_json" }] },
  }] }));
  assert.equal(seen.length, 1);
  assert.equal(seen[0].stored, 1);
  assert.equal(reasoningForToolCalls(["call_json"]), "complete thought");
});

test("JSON tap skips incomplete, malformed, empty-reasoning, and oversized responses", async () => {
  resetReasoningReplayCache();
  for (const body of [
    '{"choices":',
    JSON.stringify({ choices: [{ finish_reason: "length", message: { reasoning_content: "partial", tool_calls: [{ id: "call_length" }] } }] }),
    JSON.stringify({ choices: [{ finish_reason: "tool_calls", message: { reasoning_content: "", tool_calls: [{ id: "call_empty" }] } }] }),
    JSON.stringify({ choices: [{ finish_reason: "tool_calls", message: { reasoning_content: "x".repeat(4 * 1024 * 1024), tool_calls: [{ id: "call_oversize" }] } }] }),
  ]) assert.deepEqual(await runJsonTap(body), []);
  for (const id of ["call_length", "call_empty", "call_oversize"]) {
    assert.equal(reasoningForToolCalls([id]), undefined);
  }
});

test("JSON tap rejects invalid UTF-8 rather than storing changed reasoning", async () => {
  resetReasoningReplayCache();
  const prefix = Buffer.from('{"choices":[{"finish_reason":"tool_calls","message":{"reasoning_content":"');
  const suffix = Buffer.from('","tool_calls":[{"id":"call_invalid_utf8"}]}}]}');
  assert.deepEqual(await runJsonTap(Buffer.concat([prefix, Buffer.from([0xff]), suffix])), []);
  assert.equal(reasoningForToolCalls(["call_invalid_utf8"]), undefined);
});

test("JSON tap captures successful later choices without storing incomplete choices", async () => {
  resetReasoningReplayCache();
  const seen = await runJsonTap(JSON.stringify({ choices: [
    { finish_reason: "length", message: { reasoning_content: "partial", tool_calls: [{ id: "call_partial" }] } },
    { finish_reason: "tool_calls", message: { reasoning_content: "second thought", tool_calls: [{ id: "call_second" }] } },
    { finish_reason: "tool_calls", message: { reasoning_content: "third thought", tool_calls: [{ id: "call_third" }] } },
  ] }));
  assert.equal(seen.length, 2);
  assert.equal(reasoningForToolCalls(["call_partial"]), undefined);
  assert.equal(reasoningForToolCalls(["call_second"]), "second thought");
  assert.equal(reasoningForToolCalls(["call_third"]), "third thought");
});

// The exact shape the forwarder produces: an assistant tool-call message whose
// reasoning was lost gets the remembered text back, and a turn that already
// carries reasoning is never rewritten.
test("a replayed turn carries the remembered reasoning and a complete turn is untouched", () => {
  resetReasoningReplayCache();
  rememberReasoningForToolCalls(["call_r1"], "remembered chain");

  const lost = assistant("call_r1");
  const replayed = { ...lost, reasoning_content: reasoningForToolCalls(toolCallIdsOf(lost)) };
  assert.equal(replayed.reasoning_content, "remembered chain");

  const intact = assistant("call_r2", "original chain");
  assert.equal(intact.reasoning_content, "original chain");
  assert.equal(toolCallIdsOf(intact)[0], "call_r2");
});
