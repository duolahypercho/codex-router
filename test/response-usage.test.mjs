import assert from "node:assert/strict";
import test from "node:test";

import {
  normalizeTokenUsage,
  ResponseUsageTransform,
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
