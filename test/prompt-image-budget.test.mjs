import assert from "node:assert/strict";
import test from "node:test";

import {
  boundImagePayload,
  IMAGE_PAYLOAD_BUDGET_BYTES,
  IMAGE_PAYLOAD_BUDGET_TOKENS,
  IMAGE_PAYLOAD_KEEP_NEWEST,
} from "../src/prompt-image-budget.mjs";

// One decoded megabyte of image, as a data URL: the base64 is 4/3 of the decoded
// length, which is what the budget measures.
function imageOf(megabytes) {
  return {
    type: "input_image",
    image_url: `data:image/png;base64,${"A".repeat(Math.round((megabytes * 1024 * 1024 * 4) / 3))}`,
  };
}

function messageWith(parts) {
  return [{ type: "message", role: "user", content: [{ type: "input_text", text: "look" }, ...parts] }];
}

// A data URL whose decoded size is trivial, so a fixture can cross the token
// budget while staying far under the byte budget - the case the byte cap alone
// cannot see.
function tinyImage() {
  return { type: "input_image", image_url: `data:image/png;base64,${"A".repeat(64)}` };
}

function decodedBytes(input) {
  let total = 0;
  for (const item of input) {
    for (const parts of [item.content, item.output]) {
      for (const part of Array.isArray(parts) ? parts : []) {
        if (part?.type !== "input_image") continue;
        const url = part.image_url;
        total += Math.floor(((url.length - url.indexOf(",") - 1) * 3) / 4);
      }
    }
  }
  return total;
}

test("a payload inside the budget is returned untouched", () => {
  const input = messageWith([imageOf(4), imageOf(4)]);
  const { input: next, stats } = boundImagePayload(input);
  assert.equal(next, input, "an ordinary turn must not be copied or rewritten");
  assert.equal(stats.imageReferencesDropped, 0);
  assert.equal(stats.imageBytesSaved, 0);
});

test("an oversized payload is trimmed to the budget", () => {
  const input = messageWith(Array.from({ length: 30 }, () => imageOf(1)));
  const before = decodedBytes(input);
  assert.ok(before > IMAGE_PAYLOAD_BUDGET_BYTES, "fixture must exceed the budget");
  const { input: next, stats } = boundImagePayload(input);
  assert.ok(decodedBytes(next) <= IMAGE_PAYLOAD_BUDGET_BYTES, "trimmed payload must fit");
  assert.ok(stats.imageReferencesDropped > 0);
  assert.equal(stats.imageBytesBefore, before);
  assert.equal(stats.imageBytesAfter, decodedBytes(next));
  assert.equal(stats.imageBytesSaved, stats.imageBytesBefore - stats.imageBytesAfter);
});

test("the newest images survive and older ones become receipts", () => {
  const input = messageWith(Array.from({ length: 30 }, () => imageOf(1)));
  const { input: next } = boundImagePayload(input);
  const parts = next[0].content;
  const tail = parts.slice(parts.length - IMAGE_PAYLOAD_KEEP_NEWEST);
  assert.ok(
    tail.every((part) => part.type === "input_image"),
    "the images the model is looking at must not be dropped",
  );
  assert.ok(parts[1].type === "input_text", "the oldest image must become a text receipt");
  assert.match(parts[1].text, /image omitted by Codex Router/);
});

test("images inside a tool result are bounded too", () => {
  // 3 x 9MB: one image is droppable under the 20MB budget once the newest two
  // are protected, and dropping it brings the payload inside.
  const input = [
    { type: "function_call_output", call_id: "c1", output: [imageOf(9)] },
    { type: "function_call_output", call_id: "c2", output: [imageOf(9)] },
    { type: "function_call_output", call_id: "c3", output: [imageOf(9)] },
  ];
  const { input: next } = boundImagePayload(input);
  assert.ok(decodedBytes(next) <= IMAGE_PAYLOAD_BUDGET_BYTES);
  assert.equal(next[0].output[0].type, "input_text");
  assert.equal(next[2].output[0].type, "input_image");
});

test("a non-data image reference is left alone", () => {
  const input = messageWith([{ type: "input_image", image_url: "https://example.test/a.png" }]);
  const { input: next, stats } = boundImagePayload(input);
  assert.equal(next, input);
  assert.equal(stats.imageReferencesSeen, 0);
});

test("a single image larger than the budget is still kept", () => {
  const input = messageWith([imageOf(IMAGE_PAYLOAD_BUDGET_BYTES / 1024 / 1024 + 5)]);
  const { input: next, stats } = boundImagePayload(input);
  assert.equal(next, input, "nothing droppable is worse than a turn that cannot be served");
  assert.equal(stats.imageReferencesDropped, 0);
});

test("a payload under the byte budget but over the token budget is trimmed", () => {
  const input = messageWith(Array.from({ length: 60 }, tinyImage));
  assert.ok(
    decodedBytes(input) < IMAGE_PAYLOAD_BUDGET_BYTES,
    "fixture must fit inside the byte budget, or it proves nothing about tokens",
  );
  const { input: next, stats } = boundImagePayload(input);
  assert.ok(stats.imageReferencesSeen * 4096 > IMAGE_PAYLOAD_BUDGET_TOKENS);
  assert.ok(stats.imageReferencesDropped > 0, "the token budget must drop something");
  assert.ok(stats.imageTokensAfter <= IMAGE_PAYLOAD_BUDGET_TOKENS, "tokens must fit the budget");
  assert.ok(decodedBytes(next) < IMAGE_PAYLOAD_BUDGET_BYTES, "and bytes must still fit");
  const parts = next[0].content;
  assert.ok(
    parts.slice(parts.length - IMAGE_PAYLOAD_KEEP_NEWEST).every((part) => part.type === "input_image"),
    "the newest images survive the token budget too",
  );
  assert.equal(parts[1].type, "input_text", "the oldest image becomes a receipt");
});

test("the route's per-image bound decides how many images fit", () => {
  const input = messageWith(Array.from({ length: 60 }, tinyImage));
  const resold = boundImagePayload(input, { tokensPerImage: 4096 });
  const native = boundImagePayload(input, { tokensPerImage: 1024 });
  assert.ok(resold.stats.imageReferencesDropped > 0);
  assert.equal(native.stats.imageReferencesDropped, 0, "1024-token images fit 60 under the budget");
  assert.ok(
    native.stats.imageReferencesDropped < resold.stats.imageReferencesDropped,
    "a cheaper per-image bound must trim less",
  );
});

test("token stats report the cost that was saved", () => {
  const input = messageWith(Array.from({ length: 60 }, tinyImage));
  const { stats } = boundImagePayload(input);
  assert.equal(stats.imageTokensBefore, 60 * 4096);
  assert.equal(stats.imageTokensSaved, stats.imageReferencesDropped * 4096);
  assert.equal(stats.imageTokensAfter, stats.imageTokensBefore - stats.imageTokensSaved);
});

test("a payload inside both budgets is returned untouched with zero token savings", () => {
  const input = messageWith(Array.from({ length: 4 }, tinyImage));
  const { input: next, stats } = boundImagePayload(input);
  assert.equal(next, input);
  assert.equal(stats.imageTokensBefore, 4 * 4096);
  assert.equal(stats.imageTokensSaved, 0);
});

test("an explicit maxTokens override is honoured", () => {
  const input = messageWith(Array.from({ length: 10 }, tinyImage));
  const { stats } = boundImagePayload(input, { maxTokens: 5 * 4096 });
  assert.equal(stats.imageTokensAfter, 5 * 4096);
  assert.equal(stats.imageReferencesDropped, 5);
});
