import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  estimateInputTokens,
  mergeTokenUsage,
  normalizeTokenUsage,
  ResponseUsageTransform,
  substituteZeroInputUsage,
  tokenUsageFromPayload,
} from "../src/response-usage.mjs";

async function passThrough(transform, chunks) {
  const output = [];
  transform.on("data", (chunk) => output.push(chunk));
  for (const chunk of chunks) transform.write(chunk);
  transform.end();
  await new Promise((resolve, reject) => {
    transform.once("finish", resolve);
    transform.once("error", reject);
  });
  return Buffer.concat(output).toString("utf8");
}

test("normalizes Responses and Chat Completions token usage", () => {
  assert.deepEqual(normalizeTokenUsage({ input_tokens: 12, output_tokens: 5 }), {
    inputTokens: 12,
    outputTokens: 5,
    totalTokens: 17,
  });
  assert.deepEqual(
    tokenUsageFromPayload({ usage: { prompt_tokens: 9, completion_tokens: 4, total_tokens: 13 } }),
    { inputTokens: 9, outputTokens: 4, totalTokens: 13 },
  );
  assert.deepEqual(
    normalizeTokenUsage({
      prompt_tokens: 10,
      completion_tokens: 4,
      total_tokens: 14,
      retries: 1,
      progress_only_retried: true,
      billed_prompt_tokens: 21,
      billed_completion_tokens: 9,
    }),
    {
      inputTokens: 10,
      outputTokens: 4,
      totalTokens: 14,
      retries: 1,
      progressOnlyRetried: true,
      billedInputTokens: 21,
      billedOutputTokens: 9,
    },
  );
});

test("captures provider-reported prefix-cache hits when they exist", () => {
  // OpenAI-compatible shape: cached prefix inside input_tokens_details.
  assert.deepEqual(
    normalizeTokenUsage({
      input_tokens: 100,
      output_tokens: 5,
      input_tokens_details: { cached_tokens: 90 },
    }),
    { inputTokens: 100, outputTokens: 5, totalTokens: 105, cachedInputTokens: 90 },
  );
  // Chat-completions shape used by DeepSeek-style APIs.
  assert.deepEqual(
    tokenUsageFromPayload({
      usage: { prompt_tokens: 100, completion_tokens: 5, prompt_cache_hit_tokens: 80 },
    }),
    { inputTokens: 100, outputTokens: 5, totalTokens: 105, cachedInputTokens: 80 },
  );
  // A provider that reports no cache fields stays unchanged: the key is
  // absent, not zero, so old rows keep their exact shape.
  assert.deepEqual(
    normalizeTokenUsage({ input_tokens: 3, output_tokens: 1 }),
    { inputTokens: 3, outputTokens: 1, totalTokens: 4 },
  );
});

test("extracts reasoning tokens from output_tokens_details when present", () => {
  // OpenAI-compatible shape: reasoning tokens in output_tokens_details.
  assert.deepEqual(
    normalizeTokenUsage({
      input_tokens: 100,
      output_tokens: 502,
      output_tokens_details: { reasoning_tokens: 98 },
    }),
    { inputTokens: 100, outputTokens: 502, totalTokens: 602, reasoningTokens: 98 },
  );
  // Chat-completions shape: completion_tokens_details.
  assert.deepEqual(
    tokenUsageFromPayload({
      usage: {
        prompt_tokens: 50,
        completion_tokens: 200,
        completion_tokens_details: { reasoning_tokens: 30 },
      },
    }),
    { inputTokens: 50, outputTokens: 200, totalTokens: 250, reasoningTokens: 30 },
  );
  // Direct reasoning_tokens field.
  assert.deepEqual(
    normalizeTokenUsage({
      input_tokens: 10,
      output_tokens: 15,
      reasoning_tokens: 5,
    }),
    { inputTokens: 10, outputTokens: 15, totalTokens: 25, reasoningTokens: 5 },
  );
  // No reasoning tokens: key absent, not zero.
  assert.deepEqual(
    normalizeTokenUsage({ input_tokens: 10, output_tokens: 5 }),
    { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
  );
});

test("adds up the usage of two attempts at one turn", () => {
  assert.deepEqual(
    mergeTokenUsage(
      { inputTokens: 100, outputTokens: 0, totalTokens: 100 },
      { inputTokens: 100, outputTokens: 5, totalTokens: 105 },
    ),
    { inputTokens: 200, outputTokens: 5, totalTokens: 205 },
  );
  // A cache count reported by either attempt survives the merge; reported by
  // neither, the key stays absent rather than becoming a zero.
  assert.deepEqual(
    mergeTokenUsage(
      { inputTokens: 10, outputTokens: 1, totalTokens: 11 },
      { inputTokens: 10, outputTokens: 1, totalTokens: 11, cachedInputTokens: 8 },
    ),
    { inputTokens: 20, outputTokens: 2, totalTokens: 22, cachedInputTokens: 8 },
  );
  // Reasoning tokens merge the same way as cache tokens.
  assert.deepEqual(
    mergeTokenUsage(
      { inputTokens: 50, outputTokens: 100, totalTokens: 150, reasoningTokens: 20 },
      { inputTokens: 50, outputTokens: 100, totalTokens: 150, reasoningTokens: 30 },
    ),
    { inputTokens: 100, outputTokens: 200, totalTokens: 300, reasoningTokens: 50 },
  );
  // One-sided merges are the ordinary case: an attempt whose provider reported
  // nothing must not erase the one that did.
  const only = { inputTokens: 3, outputTokens: 1, totalTokens: 4 };
  assert.deepEqual(mergeTokenUsage(undefined, only), only);
  assert.deepEqual(mergeTokenUsage(only, undefined), only);
  assert.equal(mergeTokenUsage(undefined, undefined), undefined);
});

test("captures final SSE usage without changing streamed bytes", async () => {
  const body = [
    "event: response.output_text.delta\ndata: {\"type\":\"response.output_text.delta\",\"delta\":\"hi\"}\n\n",
    "event: response.completed\ndata: {\"type\":\"response.completed\",\"response\":{\"usage\":{\"input_tokens\":21,\"output_tokens\":8}}}\n\n",
    "data: [DONE]\n\n",
  ];
  const transform = new ResponseUsageTransform("text/event-stream; charset=utf-8");
  assert.equal(await passThrough(transform, body), body.join(""));
  assert.deepEqual(transform.tokenUsage(), {
    inputTokens: 21,
    outputTokens: 8,
    totalTokens: 29,
  });
  assert.equal(transform.completedResponseObserved(), true);
  assert.equal(typeof transform.firstTokenAt(), "number");
});

test("detects first token from chat.completion.chunk without type field", async () => {
  // Real chat.completion.chunk objects often have no `type` field, so checking
  // type before delta meant chat first-token never fired and tray speed stayed null.
  const body = [
    'data: {"choices":[{"delta":{"content":"Hello"}}]}\n\n',
    'data: {"choices":[{"delta":{"content":" world"}}]}\n\n',
    "data: [DONE]\n\n",
  ];
  const transform = new ResponseUsageTransform("text/event-stream");
  await passThrough(transform, body);
  // First token should be detected from the first delta with content.
  assert.equal(typeof transform.firstTokenAt(), "number");
});

test("captures JSON usage without changing the response", async () => {
  const body = JSON.stringify({
    id: "response-test",
    usage: { input_tokens: 31, output_tokens: 11, total_tokens: 42 },
  });
  const transform = new ResponseUsageTransform("application/json");
  assert.equal(await passThrough(transform, [body]), body);
  assert.deepEqual(transform.tokenUsage(), {
    inputTokens: 31,
    outputTokens: 11,
    totalTokens: 42,
  });
});

test("parses usage when UTF-8 text is split across response chunks", async () => {
  const body = Buffer.from(JSON.stringify({
    output: "月",
    usage: { input_tokens: 7, output_tokens: 3, total_tokens: 10 },
  }));
  const characterStart = body.indexOf(Buffer.from("月"));
  const chunks = [body.subarray(0, characterStart + 1), body.subarray(characterStart + 1)];
  const transform = new ResponseUsageTransform("application/json");
  assert.equal(await passThrough(transform, chunks), body.toString("utf8"));
  assert.deepEqual(transform.tokenUsage(), {
    inputTokens: 7,
    outputTokens: 3,
    totalTokens: 10,
  });
});

// Issue #95: opencode's Go endpoint stopped reporting prompt tokens for its
// DeepSeek V4 models, so Codex's context counter never climbed, auto-compaction
// never fired, and the turn died at the provider's real 1,048,576-token limit.
// The router substitutes an estimate only where the upstream is plainly wrong.
const DEEPSEEK_CONTEXT_WINDOW = 1_048_576;
const DEEPSEEK_AUTO_COMPACT = 900_000;

function completedEvent(usage) {
  return `event: response.completed\ndata: ${JSON.stringify({
    type: "response.completed",
    response: { id: "resp_test", usage },
  })}\n\n`;
}

test("the prompt-token estimate errs high rather than low", () => {
  // The two errors are not symmetric. Compaction fires at 900,000 of a
  // 1,048,576-token window, so an estimate more than ~14% low still lets the
  // provider reject the turn -- the exact failure this exists to prevent --
  // while a high estimate only compacts sooner. Four bytes per token is the
  // most generous density real conversation text reaches, so an estimate at
  // least that large never lands under the true count.
  const body = Buffer.alloc(64_000, "a");
  assert.ok(estimateInputTokens(body) >= Math.ceil(body.byteLength / 4));

  // A conversation sitting at the hard limit serializes to at least four bytes
  // per token; the estimate has to cross the compaction threshold there.
  const atTheLimit = Buffer.alloc(DEEPSEEK_CONTEXT_WINDOW * 4, "a");
  const estimate = estimateInputTokens(atTheLimit, {
    contextWindow: DEEPSEEK_CONTEXT_WINDOW,
  });
  assert.ok(estimate > DEEPSEEK_AUTO_COMPACT);
  // A request the provider accepted cannot have exceeded the window, so the
  // estimate is never allowed to claim it did.
  assert.equal(estimate, DEEPSEEK_CONTEXT_WINDOW);
});

test("a request too small to matter produces no estimate at all", () => {
  assert.equal(estimateInputTokens(Buffer.alloc(200, "a")), undefined);
  assert.equal(estimateInputTokens(Buffer.alloc(3_000, "a")), undefined);
  assert.ok(estimateInputTokens(Buffer.alloc(40_000, "a")) > 0);
});

test("the estimate is capped at the provider's context window", () => {
  // A request the provider answered cannot have exceeded the window, so the
  // estimate must never claim it did. The cap is the context window itself.
  const contextWindow = 1_048_576;
  const oversized = Buffer.alloc(contextWindow * 10, "a");
  assert.equal(estimateInputTokens(oversized, { contextWindow }), contextWindow);
  assert.ok(
    estimateInputTokens(Buffer.alloc(contextWindow * 3, "a"), { contextWindow }) <=
      contextWindow,
  );
  // Without a window the estimate is returned as measured.
  assert.equal(estimateInputTokens(oversized), Math.ceil(oversized.byteLength / 3.3));
});

test("a positive or missing prompt count is never rewritten with an estimate", async () => {
  const estimate = 512_000;
  for (const usage of [
    { input_tokens: 1, output_tokens: 8, total_tokens: 9 },
    { input_tokens: 4_321, output_tokens: 8, total_tokens: 4_329 },
    { output_tokens: 8, total_tokens: 8 },
  ]) {
    assert.equal(substituteZeroInputUsage({ response: { usage } }, estimate), undefined);
  }

  // End to end through the transform: a reported positive count arrives at
  // Codex byte for byte and never marks a substitution.
  const body = [
    completedEvent({ input_tokens: 4_321, output_tokens: 8, total_tokens: 4_329 }),
    "data: [DONE]\n\n",
  ];
  const transform = new ResponseUsageTransform("text/event-stream", {
    estimatedInputTokens: estimate,
  });
  assert.equal(await passThrough(transform, body), body.join(""));
  assert.equal(transform.substitutedInputTokens(), undefined);
  assert.deepEqual(transform.tokenUsage(), {
    inputTokens: 4_321,
    outputTokens: 8,
    totalTokens: 4_329,
  });
});

test("only an explicit zero prompt count is substituted", () => {
  const estimate = 4_242;
  const zero = substituteZeroInputUsage(
    { response: { usage: { input_tokens: 0, output_tokens: 8, total_tokens: 8 } } },
    estimate,
  );
  assert.deepEqual(zero.response.usage, {
    input_tokens: estimate,
    output_tokens: 8,
    total_tokens: estimate + 8,
  });
  assert.deepEqual(
    substituteZeroInputUsage({ usage: { prompt_tokens: 0, completion_tokens: 3 } }, estimate)
      .usage,
    { prompt_tokens: estimate, completion_tokens: 3, total_tokens: estimate + 3 },
  );

  // A correctly reported count, a response carrying no usage at all, and a
  // usage block that never mentions the prompt are all left alone: the router
  // replaces a value it knows to be false, never one it merely dislikes.
  assert.equal(
    substituteZeroInputUsage(
      { response: { usage: { input_tokens: 17, output_tokens: 8 } } },
      estimate,
    ),
    undefined,
  );
  assert.equal(substituteZeroInputUsage({ response: { id: "resp" } }, estimate), undefined);
  assert.equal(substituteZeroInputUsage({ usage: { output_tokens: 8 } }, estimate), undefined);
  // `null` means "no count yet", not "no tokens" -- and `Number(null)` is 0, so
  // a coercing predicate would have fabricated a number here.
  assert.equal(
    substituteZeroInputUsage({ usage: { input_tokens: null, output_tokens: 8 } }, estimate),
    undefined,
  );
  assert.equal(
    substituteZeroInputUsage({ usage: { input_tokens: 0, output_tokens: 8 } }, undefined),
    undefined,
  );
});

// Synthetic Lane L4 regression fixture reconstructed from the recorded
// telemetry and the response.completed shape used by the #95 reproducer. The
// router did not retain the upstream payload, so the fixture is deliberately
// labelled as a reconstruction rather than captured provider evidence.
const LANE_L4_FIXTURE_PATH = new URL("./fixtures/upstream-zero-usage.json", import.meta.url);

function laneL4Fixture() {
  const fixture = JSON.parse(readFileSync(LANE_L4_FIXTURE_PATH, "utf8"));
  assert.equal(fixture.provenance, "synthetic-reconstruction");
  assert.equal(fixture.upstreamSse?.event, "response.completed");
  assert.equal(fixture.upstreamSse?.data?.type, "response.completed");
  assert.equal(typeof fixture.recorded?.estimatedInputTokens, "number");
  assert.equal(typeof fixture.upstreamSse?.data?.response?.usage?.output_tokens, "number");
  return {
    upstream: fixture.upstreamSse.data,
    estimate: fixture.recorded.estimatedInputTokens,
    outputTokens: fixture.upstreamSse.data.response.usage.output_tokens,
  };
}

test("the fixture upstream zero is substituted and only the estimate is added", async () => {
  const { upstream, estimate, outputTokens } = laneL4Fixture();
  assert.equal(upstream.response.usage.input_tokens, 0);

  const substituted = substituteZeroInputUsage(upstream, estimate);
  assert.notEqual(substituted, undefined);
  assert.equal(substituted.response.usage.input_tokens, estimate);
  assert.equal(substituted.response.usage.total_tokens, estimate + outputTokens);

  // The transform keeps the provider's own numbers in telemetry and names the
  // estimate separately, so an estimated turn is never mistaken for recovery.
  const transform = new ResponseUsageTransform("text/event-stream", {
    estimatedInputTokens: estimate,
  });
  const body = [
    `event: response.completed\ndata: ${JSON.stringify(upstream)}\n\n`,
    "data: [DONE]\n\n",
  ];
  transform.on("data", () => {});
  for (const chunk of body) transform.write(chunk);
  transform.end();
  await new Promise((resolve, reject) => {
    transform.once("finish", resolve);
    transform.once("error", reject);
  });
  assert.equal(transform.substitutedInputTokens(), estimate);
  assert.deepEqual(transform.tokenUsage(), {
    inputTokens: 0,
    outputTokens,
    totalTokens: outputTokens,
  });
});

test("a zero-prompt SSE response is rewritten with the estimate", async () => {
  const estimate = 512_000;
  const body = [
    "event: response.output_text.delta\ndata: {\"type\":\"response.output_text.delta\",\"delta\":\"hi\"}\n\n",
    completedEvent({ input_tokens: 0, output_tokens: 12, total_tokens: 12 }),
    "data: [DONE]\n\n",
  ];
  const transform = new ResponseUsageTransform("text/event-stream; charset=utf-8", {
    estimatedInputTokens: estimate,
  });
  const streamed = await passThrough(transform, body);
  const completed = JSON.parse(
    streamed
      .split("\n")
      .find((line) => line.includes("response.completed") && line.startsWith("data:"))
      .slice(5),
  );
  assert.equal(completed.response.usage.input_tokens, estimate);
  assert.equal(completed.response.usage.total_tokens, estimate + 12);
  // Every byte outside the rewritten event -- the delta, the framing, the
  // terminator -- is forwarded exactly as the provider wrote it.
  assert.ok(streamed.startsWith(body[0]));
  assert.ok(streamed.endsWith(`\n\n${body[2]}`));
  assert.equal(transform.substitutedInputTokens(), estimate);
  // Telemetry keeps what the provider actually said, so a substitution can
  // never be mistaken for the provider having recovered.
  assert.deepEqual(transform.tokenUsage(), {
    inputTokens: 0,
    outputTokens: 12,
    totalTokens: 12,
  });
});

test("a correctly reported response is never rewritten", async () => {
  const body = [
    completedEvent({ input_tokens: 21, output_tokens: 8, total_tokens: 29 }),
    "data: [DONE]\n\n",
  ];
  const transform = new ResponseUsageTransform("text/event-stream", {
    estimatedInputTokens: 512_000,
  });
  assert.equal(await passThrough(transform, body), body.join(""));
  assert.equal(transform.substitutedInputTokens(), undefined);
  assert.deepEqual(transform.tokenUsage(), {
    inputTokens: 21,
    outputTokens: 8,
    totalTokens: 29,
  });
});

test("a response with no estimate behind it is forwarded untouched", async () => {
  const body = [
    completedEvent({ input_tokens: 0, output_tokens: 12, total_tokens: 12 }),
    "data: [DONE]\n\n",
  ];
  const transform = new ResponseUsageTransform("text/event-stream");
  assert.equal(await passThrough(transform, body), body.join(""));
  assert.equal(transform.substitutedInputTokens(), undefined);
});

test("observes a terminal SSE error without rewriting the stream", async () => {
  const body = [
    'event: error\n',
    'data: {"type":"error","code":"local_router_stream_failed","message":"repair failed"}\n\n',
  ];
  const transform = new ResponseUsageTransform("text/event-stream");
  assert.equal(await passThrough(transform, body), body.join(""));
  assert.equal(transform.terminalErrorObserved(), true);
  assert.equal(transform.completedResponseObserved(), false);
});

test("bytes the router is not rewriting survive rewrite mode exactly", async () => {
  // Only the one substituted line is re-encoded. Everything else -- including a
  // byte sequence that is not valid UTF-8 at all -- has to leave as it arrived,
  // or a decoder would quietly replace it with U+FFFD.
  const malformed = Buffer.from([0x64, 0x61, 0x74, 0x61, 0x3a, 0x20, 0xff, 0xfe, 0x0a, 0x0a]);
  const chunks = [
    malformed,
    Buffer.from(completedEvent({ input_tokens: 0, output_tokens: 4, total_tokens: 4 }), "utf8"),
    Buffer.from("data: [DONE]\n\n", "utf8"),
  ];
  const transform = new ResponseUsageTransform("text/event-stream", {
    estimatedInputTokens: 7_000,
  });
  const output = [];
  transform.on("data", (chunk) => output.push(chunk));
  for (const chunk of chunks) transform.write(chunk);
  transform.end();
  await new Promise((resolve, reject) => {
    transform.once("finish", resolve);
    transform.once("error", reject);
  });
  const streamed = Buffer.concat(output);
  assert.deepEqual(streamed.subarray(0, malformed.length), malformed);
  assert.deepEqual(streamed.subarray(streamed.length - 14), chunks[2]);
  assert.equal(transform.substitutedInputTokens(), 7_000);
});

test("a later reported count supersedes an earlier substituted one", async () => {
  // Codex reads the last usage it is given, so telemetry must not keep claiming
  // a substitution the client never ended up using.
  const body = [
    completedEvent({ input_tokens: 0, output_tokens: 4, total_tokens: 4 }),
    completedEvent({ input_tokens: 5_000, output_tokens: 9, total_tokens: 5_009 }),
    "data: [DONE]\n\n",
  ];
  const transform = new ResponseUsageTransform("text/event-stream", {
    estimatedInputTokens: 7_000,
  });
  await passThrough(transform, body);
  assert.equal(transform.substitutedInputTokens(), undefined);
  assert.deepEqual(transform.tokenUsage(), {
    inputTokens: 5_000,
    outputTokens: 9,
    totalTokens: 5_009,
  });
});

test("a zero-prompt JSON response is rewritten with the estimate", async () => {
  const body = JSON.stringify({
    id: "response-test",
    usage: { input_tokens: 0, output_tokens: 11, total_tokens: 11 },
  });
  const transform = new ResponseUsageTransform("application/json", {
    estimatedInputTokens: 99_000,
  });
  const rewritten = JSON.parse(await passThrough(transform, [body]));
  assert.deepEqual(rewritten.usage, {
    input_tokens: 99_000,
    output_tokens: 11,
    total_tokens: 99_011,
  });
  assert.equal(rewritten.id, "response-test");
  assert.equal(transform.substitutedInputTokens(), 99_000);
});

test("meters a stream the backend sent without a content-type header", async () => {
  // The ChatGPT backend answers /responses this way: an SSE body, every
  // x-codex-* header present, and no content-type at all.
  const body = [
    'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"hi"}\n\n',
    'event: response.completed\ndata: {"type":"response.completed","response":{"usage":{"input_tokens":153642,"output_tokens":661,"total_tokens":154303}}}\n\n',
    "data: [DONE]\n\n",
  ];
  const transform = new ResponseUsageTransform("");
  const output = await passThrough(transform, body.map((part) => Buffer.from(part, "utf8")));
  assert.equal(output, body.join(""));
  assert.deepEqual(transform.tokenUsage(), {
    inputTokens: 153642,
    outputTokens: 661,
    totalTokens: 154303,
  });
});

test("meters a headerless stream whose first event spans two chunks", async () => {
  const terminal =
    'event: response.completed\ndata: {"type":"response.completed","response":{"usage":{"input_tokens":4,"output_tokens":2}}}\n\n';
  const transform = new ResponseUsageTransform("");
  const output = await passThrough(transform, [
    Buffer.from(terminal.slice(0, 40), "utf8"),
    Buffer.from(terminal.slice(40), "utf8"),
  ]);
  assert.equal(output, terminal);
  assert.deepEqual(transform.tokenUsage(), {
    inputTokens: 4,
    outputTokens: 2,
    totalTokens: 6,
  });
});

test("meters headerless SSE after a split BOM, comments, and blank lines", async () => {
  const body = Buffer.from(
    `\uFEFF: keepalive\r\n\r\n\n${completedEvent({
      input_tokens: 17,
      output_tokens: 4,
      total_tokens: 21,
    })}data: [DONE]\n\n`,
    "utf8",
  );
  const transform = new ResponseUsageTransform("");
  const output = await passThrough(
    transform,
    [...body].map((byte) => Buffer.from([byte])),
  );
  assert.equal(output, body.toString("utf8"));
  assert.deepEqual(transform.tokenUsage(), {
    inputTokens: 17,
    outputTokens: 4,
    totalTokens: 21,
  });
});

test("still reads a headerless body as JSON when it is not an event stream", async () => {
  const body = JSON.stringify({ usage: { input_tokens: 7, output_tokens: 3 } });
  const transform = new ResponseUsageTransform("");
  const output = await passThrough(transform, [Buffer.from(body, "utf8")]);
  assert.equal(output, body);
  assert.deepEqual(transform.tokenUsage(), {
    inputTokens: 7,
    outputTokens: 3,
    totalTokens: 10,
  });
});

test("a declared JSON content-type is never re-read as an event stream", async () => {
  // A JSON body that happens to open with the word data must not be sniffed
  // into the streaming branch when the header already settled the question.
  const body = '{"data": "one", "usage": {"input_tokens": 5, "output_tokens": 1}}';
  const transform = new ResponseUsageTransform("application/json");
  const output = await passThrough(transform, [Buffer.from(body, "utf8")]);
  assert.equal(output, body);
  assert.deepEqual(transform.tokenUsage(), {
    inputTokens: 5,
    outputTokens: 1,
    totalTokens: 6,
  });
});

test("substitutes an estimated prompt count on a headerless stream", async () => {
  const body =
    'event: response.completed\ndata: {"type":"response.completed","response":{"usage":{"input_tokens":0,"output_tokens":9,"total_tokens":9}}}\n\n';
  const transform = new ResponseUsageTransform("", { estimatedInputTokens: 1200 });
  const output = await passThrough(transform, [Buffer.from(body, "utf8")]);
  assert.match(output, /"input_tokens":1200/);
  assert.equal(transform.substitutedInputTokens(), 1200);
});

// Issue #266: on a curated OpenRouter model the substituted estimate came in
// 3.9x-4.7x above the true prompt count, which pushed every zero-report turn
// past the compaction threshold and compacted the session on every turn.
// `estimateInputTokens` was measuring the whole serialized body, and the body a
// Codex session sends is mostly `encrypted_content` -- reasoning ciphertext no
// routed provider reads. The reporter's figures: ~382 KB of body over ~29,551
// real prompt tokens, about 12.9 real bytes per token against a divisor of 3.3.

// A reasoning item as Codex replays one: a short visible summary and a large
// opaque ciphertext blob.
function reasoningItem(summary, ciphertextBytes) {
  return {
    type: "reasoning",
    id: "rs_1",
    summary: [{ type: "summary_text", text: summary }],
    encrypted_content: `gAAAAAB${"x".repeat(ciphertextBytes)}`,
  };
}

test("reasoning ciphertext is not counted as prompt tokens", () => {
  // Same conversation twice: once as the provider stores it, once with the
  // ciphertext stripped. The model reads the same words either way, so the two
  // must estimate the same.
  const visible = { type: "message", role: "user", content: [{ type: "input_text", text: "x".repeat(40_000) }] };
  const withCiphertext = Buffer.from(
    JSON.stringify({ model: "m", input: [visible, reasoningItem("Thinking about it.", 300_000)] }),
    "utf8",
  );
  const withoutCiphertext = Buffer.from(
    JSON.stringify({
      model: "m",
      input: [visible, { type: "reasoning", id: "rs_1", summary: [{ type: "summary_text", text: "Thinking about it." }] }],
    }),
    "utf8",
  );
  // The ciphertext is nearly 90% of the stored body.
  assert.ok(withCiphertext.byteLength > withoutCiphertext.byteLength * 8);
  const stored = estimateInputTokens(withCiphertext);
  const stripped = estimateInputTokens(withoutCiphertext);
  // Before the fix `stored` was over 90,000 against `stripped` of about 12,000.
  assert.ok(
    Math.abs(stored - stripped) <= 40,
    `ciphertext changed the estimate: ${stored} vs ${stripped}`,
  );
});

test("a body that is mostly reasoning ciphertext does not force a compaction", () => {
  // The reporter's shape: a conversation Codex is nowhere near needing to
  // compact, inside a body three quarters ciphertext. autoCompact is 85% of the
  // window, so the estimate has to stay under that or the session compacts on
  // every turn that the provider reports as zero.
  const contextWindow = 131_072;
  const autoCompact = Math.floor(contextWindow * 0.85);
  const input = [];
  for (let turn = 0; turn < 24; turn += 1) {
    input.push({
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: `turn ${turn}: ${"word ".repeat(800)}` }],
    });
    input.push(reasoningItem(`Turn ${turn} reasoning summary.`, 12_000));
  }
  const body = Buffer.from(JSON.stringify({ model: "m", input }), "utf8");
  // Roughly the reporter's proportions: a body whose real prompt content is a
  // small fraction of its bytes.
  assert.ok(body.byteLength > 380_000, `body was ${body.byteLength} bytes`);
  const wholeBody = Math.ceil(body.byteLength / 3.3);
  assert.ok(wholeBody > autoCompact, "the pre-fix estimate must clear the threshold");
  const estimate = estimateInputTokens(body, { contextWindow });
  assert.ok(
    estimate < autoCompact,
    `estimate ${estimate} still forces compaction at ${autoCompact}`,
  );
  // And it is not merely small: the visible half of the conversation is still
  // counted in full.
  assert.ok(estimate > 25_000, `estimate ${estimate} lost the visible text too`);
});

test("only the ciphertext is discounted, never the text beside it", () => {
  // `encrypted_content` is also the name of a content-part type, and it appears
  // as a value right next to the key. Discounting the value would silently drop
  // real text; the scan keys on the colon that only follows the key.
  const body = JSON.stringify({
    input: [
      {
        type: "agent_message",
        content: [
          { type: "encrypted_content", encrypted_content: "gAAAA" + "z".repeat(50_000) },
          { type: "input_text", text: "y".repeat(20_000) },
        ],
      },
    ],
  });
  const estimate = estimateInputTokens(body);
  const visibleOnly = estimateInputTokens(
    JSON.stringify({
      input: [
        {
          type: "agent_message",
          content: [
            { type: "encrypted_content", encrypted_content: "" },
            { type: "input_text", text: "y".repeat(20_000) },
          ],
        },
      ],
    }),
  );
  assert.ok(Math.abs(estimate - visibleOnly) <= 4, `${estimate} vs ${visibleOnly}`);
  // A tool result that quotes this very JSON is text, not a key, and every
  // quote inside it is escaped -- so it must not be discounted.
  const quoted = JSON.stringify({
    input: [
      {
        type: "message",
        role: "user",
        content: [
          { type: "input_text", text: `here is the payload: {"encrypted_content":"${"q".repeat(40_000)}"}` },
        ],
      },
    ],
  });
  assert.ok(
    estimateInputTokens(quoted) > 12_000,
    "escaped text was mistaken for a key and discounted",
  );
});

test("a non-JSON body is still counted whole", () => {
  // A compressed frame or any other opaque payload finds no key to discount and
  // is measured exactly as it always was. Erring high is the safe direction, so
  // an unparseable body must never estimate low.
  const opaque = Buffer.alloc(64_000, 0x9c);
  assert.equal(estimateInputTokens(opaque), Math.ceil(64_000 / 3.3));
});

test("a ciphertext value carrying escapes ends where JSON says it ends", () => {
  // Base64 has no quotes in it, but nothing stops a provider putting something
  // else under the key. Stopping at an escaped quote would end the value early
  // and discount the rest of the body as if it were ciphertext; running past
  // the real closing quote would discount the visible text after it. Neither
  // shows up as a wrong-looking number on its own, so the assertion is
  // invariance: what the model reads is the same either way, so the estimate
  // has to be too.
  const visible = (awkward) =>
    JSON.stringify({
      input: [
        { type: "reasoning", encrypted_content: awkward + "q".repeat(20_000) },
        {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "z".repeat(30_000) }],
        },
      ],
    });
  const baseline = estimateInputTokens(visible(""));
  // The trailing text dominates, so the estimate has to be near it rather than
  // near the 15,000 tokens the ciphertext would have added.
  assert.ok(baseline > 9_000 && baseline < 9_300, `baseline was ${baseline}`);
  for (const awkward of ['a"b', "a\\", 'a\\"b', '\\\\"', "line\nbreak", '"']) {
    assert.equal(
      estimateInputTokens(visible(awkward)),
      baseline,
      `escape ${JSON.stringify(awkward)} moved the estimate`,
    );
  }
});
