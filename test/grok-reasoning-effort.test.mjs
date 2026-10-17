import assert from "node:assert/strict";
import test from "node:test";
import { grokReasoningBridgeBody, normalizeGrokReasoningEffort } from "../src/grok-reasoning-effort.mjs";

test("Grok effort preserves the caller choice in string and summary-object forms", () => {
  for (const xhigh of [false, true]) {
    for (const [effort, expected] of [["none", "low"], ["minimal", "low"], ["low", "low"],
      ["medium", "medium"], ["high", "high"], ["xhigh", xhigh ? "xhigh" : "high"], ["max", "high"]]) {
      assert.equal(normalizeGrokReasoningEffort(effort, { xhigh }), expected);
      assert.equal(normalizeGrokReasoningEffort({ effort, summary: "detailed" }, { xhigh }), expected);
    }
  }
});

test("Grok effort does not invent a setting for absent or malformed input", () => {
  for (const value of [undefined, null, false, 0, [], ["high"], "", "HIGH", "future", {},
    { summary: "detailed" }, { effort: null }, { effort: 1 }, { effort: ["high"] }, { effort: { effort: "high" } }]) {
    assert.equal(normalizeGrokReasoningEffort(value), undefined);
  }
});

test("owned Chat bridge preserves both reasoning forms and unrelated extra fields", () => {
  for (const reasoning of ["low", { effort: "medium" }, { effort: "xhigh", summary: "detailed" }]) {
    const payload = { reasoning, extra_body: { another: { retained: true }, reasoning_effort: "low" } };
    const before = structuredClone(payload);
    assert.deepEqual(grokReasoningBridgeBody(payload), { another: { retained: true }, reasoning_effort: reasoning });
    assert.deepEqual(payload, before, "caller payload is not mutated");
    assert.deepEqual(grokReasoningBridgeBody({ reasoning_effort: reasoning }), { reasoning_effort: reasoning });
  }
});

test("owned Chat bridge uses Responses reasoning precedence without fabricating a default", () => {
  assert.deepEqual(grokReasoningBridgeBody({ reasoning: { effort: "medium" }, reasoning_effort: "high" }),
    { reasoning_effort: { effort: "medium" } });
  assert.deepEqual(grokReasoningBridgeBody({ reasoning: null, reasoning_effort: "low", extra_body: [] }),
    { reasoning_effort: "low" });
  for (const payload of [undefined, {}, { reasoning: null }, { extra_body: { another: true } }]) {
    assert.equal(grokReasoningBridgeBody(payload), undefined);
  }
});
