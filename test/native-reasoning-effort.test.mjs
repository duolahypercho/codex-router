import assert from "node:assert/strict";
import test from "node:test";

import {
  clampNativeReasoningEffort,
  nativeReasoningModels,
  normalizeNativeReasoningEffort,
} from "../src/native-reasoning-effort.mjs";

const astra = {
  slug: "gpt-6-astra",
  supported_reasoning_levels: ["low", "medium", "high", "xhigh", "max"].map(
    (effort) => ({ effort, description: effort }),
  ),
};

test("native effort clamps a stale picker rung onto the target model ladder", () => {
  assert.equal(clampNativeReasoningEffort("minimal", ["low", "medium", "high"]), "low");
  assert.equal(clampNativeReasoningEffort("ultra", ["low", "high", "max"]), "max");
  assert.equal(clampNativeReasoningEffort("medium", ["low", "high"]), "low");
  assert.equal(clampNativeReasoningEffort("none", ["low", "medium"]), "low");
});

test("native effort preserves supported and unknown values", () => {
  assert.equal(clampNativeReasoningEffort("high", ["low", "high"]), "high");
  assert.equal(clampNativeReasoningEffort("future", ["low", "high"]), "future");
  assert.equal(clampNativeReasoningEffort(undefined, ["low", "high"]), undefined);
});

test("native request normalization covers nested and flat effort spellings", () => {
  const payload = {
    model: "gpt-6-astra",
    reasoning: { effort: "minimal", summary: "auto" },
    reasoning_effort: "ultra",
  };
  const changes = normalizeNativeReasoningEffort(payload, { models: [astra] });
  assert.deepEqual(payload.reasoning, { effort: "low", summary: "auto" });
  assert.equal(payload.reasoning_effort, "max");
  assert.deepEqual(changes, [
    { field: "reasoning.effort", from: "minimal", to: "low" },
    { field: "reasoning_effort", from: "ultra", to: "max" },
  ]);
});

test("native request normalization is fail-open without authoritative metadata", () => {
  const payload = { model: "gpt-future", reasoning: { effort: "minimal" } };
  assert.deepEqual(normalizeNativeReasoningEffort(payload, { models: [astra] }), []);
  assert.equal(payload.reasoning.effort, "minimal");
});

test("fresh account reasoning metadata narrows the captured fallback", () => {
  const models = nativeReasoningModels({
    capturedCatalogModels: [{
      slug: "gpt-6-astra",
      supported_reasoning_levels: [{ effort: "minimal" }, { effort: "low" }],
    }],
    accountCatalog: {
      models: [{
        slug: "gpt-6-astra",
        supported_reasoning_levels: [{ effort: "low" }, { effort: "medium" }],
      }],
    },
  });
  const payload = { model: "gpt-6-astra", reasoning: { effort: "minimal" } };
  normalizeNativeReasoningEffort(payload, { models });
  assert.equal(payload.reasoning.effort, "low");
});
