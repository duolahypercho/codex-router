import assert from "node:assert/strict";
import test from "node:test";

import {
  estimateInputTokens,
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
