import test from "node:test";
import assert from "node:assert/strict";
import {
  COMPACTION_SKIP_HEADROOM,
  isRemoteCompactV2Trigger,
  skippableCompactionTokens,
} from "../src/compaction-limit.mjs";
import { estimateInputTokens } from "../src/response-usage.mjs";

const ROUTE = { contextWindow: 1_048_576, autoCompact: 900_000 };

function textItem(text) {
  return { type: "message", role: "user", content: [{ type: "input_text", text }] };
}

test("a terminal compaction_trigger is the V2 protocol shape", () => {
  assert.equal(isRemoteCompactV2Trigger({ input: [textItem("hi"), { type: "compaction_trigger" }] }), true);
  assert.equal(isRemoteCompactV2Trigger({ input: [{ type: "compaction_trigger" }, textItem("hi")] }), false);
  assert.equal(isRemoteCompactV2Trigger({ input: [textItem("hi")] }), false);
  assert.equal(isRemoteCompactV2Trigger({}), false);
  assert.equal(isRemoteCompactV2Trigger(undefined), false);
});

test("a conversation well under the budget is skippable and reports its estimate", () => {
  const estimate = skippableCompactionTokens([textItem("x".repeat(40_000))], ROUTE);
  assert.equal(typeof estimate, "number");
  assert.ok(estimate <= ROUTE.autoCompact * COMPACTION_SKIP_HEADROOM);
});

test("a conversation over the budget is not skippable", () => {
  // Comfortably past the budget once counted at the estimator's own ratio.
  assert.equal(skippableCompactionTokens([textItem("x".repeat(4_000_000))], ROUTE), undefined);
});

// The asymmetry this whole guard exists for: erring high costs a summary,
// erring low costs the turn. A conversation sitting just under the budget --
// inside the estimator's error band -- keeps its summary rather than betting
// the next turn on a bytes-over-a-ratio estimate agreeing with what Codex
// counted.
test("a conversation just under the budget still compacts", () => {
  const justUnder = Math.round(ROUTE.autoCompact * 0.95 * 3.3);
  assert.equal(skippableCompactionTokens([textItem("x".repeat(justUnder))], ROUTE), undefined);
});

test("the headroom is what decides a value between the two thresholds", () => {
  const betweenHeadroomAndBudget = Math.round(ROUTE.autoCompact * 0.9 * 3.3);
  const input = [textItem("x".repeat(betweenHeadroomAndBudget))];
  // Under `autoCompact`, so a bare comparison would have skipped it.
  const bare = skippableCompactionTokens(input, { ...ROUTE, autoCompact: ROUTE.autoCompact * 2 });
  assert.equal(typeof bare, "number");
  assert.equal(skippableCompactionTokens(input, ROUTE), undefined);
});

// The regression this guard was rebuilt around. A routed session's history is
// mostly the router's own prior checkpoints, which arrive as `compaction`
// items whose payload sits in `encrypted_content` -- the one field
// `estimateInputTokens` discounts entirely. Estimating the inbound body read a
// genuinely full context as nearly empty (1,028,910 real tokens seen as
// 6,235), so the estimate is taken on the normalized input instead.
test("expanded checkpoint history is counted, not discounted as ciphertext", () => {
  const checkpointText = "function doThing(){ return compute(a,b,c); } ".repeat(75_000);
  // What normalizeRoutedInput produces: the checkpoint rendered as visible text.
  const normalized = [textItem(checkpointText), textItem("please carry on")];
  assert.equal(skippableCompactionTokens(normalized, ROUTE), undefined);

  // The same conversation still sealed in `encrypted_content` is what used to
  // be measured. Every one of those bytes is discounted, so what is left of a
  // 3.4 MB history does not even clear the estimator's own floor: the context
  // that was genuinely full measured as nothing at all.
  const sealed = [
    { type: "compaction", id: "cmp_1", encrypted_content: Buffer.from(checkpointText).toString("base64") },
    textItem("please carry on"),
  ];
  const visibleTokens = estimateInputTokens(Buffer.from(JSON.stringify(normalized), "utf8"), {
    contextWindow: ROUTE.contextWindow,
  });
  const sealedTokens = estimateInputTokens(Buffer.from(JSON.stringify(sealed), "utf8"), {
    contextWindow: ROUTE.contextWindow,
  });
  assert.ok(visibleTokens > ROUTE.autoCompact, "the normalized history is over budget");
  assert.equal(sealedTokens, undefined, "the sealed history reads as too small to measure");
});

test("the estimator's too-small-to-matter floor is never read as an empty context", () => {
  assert.equal(skippableCompactionTokens([textItem("small")], ROUTE), undefined);
});

test("a route without a usable autoCompact budget is never skippable", () => {
  const input = [textItem("x".repeat(40_000))];
  assert.equal(skippableCompactionTokens(input, { contextWindow: 1_048_576 }), undefined);
  assert.equal(skippableCompactionTokens(input, { ...ROUTE, autoCompact: 0 }), undefined);
  assert.equal(skippableCompactionTokens(input, { ...ROUTE, autoCompact: Number.NaN }), undefined);
  assert.equal(skippableCompactionTokens(input, undefined), undefined);
});

test("a non-array input is never skippable", () => {
  assert.equal(skippableCompactionTokens(undefined, ROUTE), undefined);
  assert.equal(skippableCompactionTokens("history", ROUTE), undefined);
});
