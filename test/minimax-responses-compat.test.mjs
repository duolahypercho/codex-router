import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { once } from "node:events";
import test from "node:test";

import { MiniMaxResponsesCompatTransform, minimaxResponsesCompatTransform } from "../src/minimax-responses-compat.mjs";

async function transform(chunks) {
  const stream = Readable.from(chunks).pipe(new MiniMaxResponsesCompatTransform());
  const output = [];
  stream.on("data", (chunk) => output.push(chunk));
  await once(stream, "end");
  return Buffer.concat(output).toString("utf8");
}

test("MiniMax Responses compatibility removes leaked think markup from deltas", async () => {
  const result = await transform([
    'data: {"type":"response.output_text.delta","delta":"<think>internal"}\n\n',
    'data: {"type":"response.output_text.delta","delta":" reasoning</think>answer"}\n\n',
  ]);
  assert.match(result, /"delta":"answer"/);
  assert.doesNotMatch(result, /internal|reasoning|<think>/);
});

test("MiniMax compatibility is scoped to MiniMax models", () => {
  assert.ok(minimaxResponsesCompatTransform({ slug: "opencode-go-messages/minimax-m3" }, "text/event-stream"));
  assert.equal(minimaxResponsesCompatTransform({ slug: "opencode-go/glm-5.2" }, "text/event-stream"), undefined);
});
