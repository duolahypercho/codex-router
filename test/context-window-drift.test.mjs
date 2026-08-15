import assert from "node:assert/strict";
import test from "node:test";

import {
  acceptedInputTokens,
  contextWindowDrift,
  describeContextWindowDrift,
  observedCeilings,
} from "../src/context-window-drift.mjs";

const MODELS = [
  { slug: "qwen-plan/qwen3.8-max", contextWindow: 262_144, autoCompact: 235_000 },
  { slug: "grok-oauth/grok-4.5", contextWindow: 500_000, autoCompact: 440_000 },
  { slug: "openai/gpt-5.6-sol", contextWindow: 1_000_000, autoCompact: 900_000 },
];

function event(model, inputTokens, extra = {}) {
  return { model, status: 200, inputTokens, ...extra };
}

test("a provider accepting more than the declared window is reported as drift", () => {
  const drift = contextWindowDrift(MODELS, [
    event("qwen-plan/qwen3.8-max", 277_174),
    event("openai/gpt-5.6-sol", 214_784),
  ]);
  assert.equal(drift.length, 1);
  assert.deepEqual(drift[0], {
    slug: "qwen-plan/qwen3.8-max",
    declared: 262_144,
    observed: 277_174,
    autoCompact: 235_000,
    ratio: 1.06,
  });
});

test("drift is ordered worst-first so the most understated entry leads", () => {
  const drift = contextWindowDrift(MODELS, [
    event("qwen-plan/qwen3.8-max", 277_174),
    event("grok-oauth/grok-4.5", 2_033_426),
  ]);
  assert.deepEqual(drift.map((entry) => entry.slug), [
    "grok-oauth/grok-4.5",
    "qwen-plan/qwen3.8-max",
  ]);
  assert.equal(drift[0].ratio, 4.07);
});

// A rejected turn may have been rejected for exceeding the very limit under
// test, so it is evidence of nothing.
test("only turns the provider accepted count as evidence", () => {
  assert.equal(acceptedInputTokens(event("m", 900_000, { status: 400 })), undefined);
  assert.equal(acceptedInputTokens(event("m", 900_000, { status: 0 })), undefined);
  assert.equal(acceptedInputTokens(event("m", 900_000)), 900_000);
  const drift = contextWindowDrift(MODELS, [
    event("qwen-plan/qwen3.8-max", 999_999, { status: 400 }),
  ]);
  assert.deepEqual(drift, []);
});

// An empty-completion retry bills both attempts, so the meter sums them and a
// perfectly ordinary turn lands as a 200 carrying twice the prompt it sent.
// Believing that would invent a ~2x window out of one retry -- and this check
// tells the operator to raise the window, so the bad sample argues for
// doubling a number that was right.
test("a retried turn's doubled prompt count is not evidence of capacity", () => {
  assert.equal(
    acceptedInputTokens(event("m", 900_000, { emptyCompletionRetried: true })),
    undefined,
  );
  assert.equal(acceptedInputTokens(event("m", 900_000)), 900_000);
  const drift = contextWindowDrift(MODELS, [
    event("qwen-plan/qwen3.8-max", 524_288, { emptyCompletionRetried: true }),
  ]);
  assert.deepEqual(drift, []);
  // A real accepted turn still counts on a slug that also has retried traffic.
  assert.deepEqual(
    contextWindowDrift(MODELS, [
      event("qwen-plan/qwen3.8-max", 524_288, { emptyCompletionRetried: true }),
      event("qwen-plan/qwen3.8-max", 277_174),
    ]).map((entry) => entry.observed),
    [277_174],
  );
});

// The router substitutes its own estimate when a provider reports zero input
// tokens. An estimate cannot disprove that provider's own limit.
test("estimated input counts never disprove a declared window", () => {
  const drift = contextWindowDrift(MODELS, [
    event("qwen-plan/qwen3.8-max", 400_000, { estimatedInputTokens: 400_000 }),
  ]);
  assert.deepEqual(drift, []);
});

test("a provider reporting an impossible count is treated as a metering bug", () => {
  const drift = contextWindowDrift(MODELS, [
    event("qwen-plan/qwen3.8-max", 262_144 * 100),
  ]);
  assert.deepEqual(drift, [], "a 100x overshoot is not a discovery");
});

// Same upstream model, two providers, two ceilings: a reseller or subscription
// endpoint enforces its own, so evidence must not cross between slugs.
test("evidence is keyed per routed slug, not per upstream model", () => {
  const ceilings = observedCeilings([
    event("qwen-plan/qwen3.8-max", 277_174),
    event("grok-oauth/grok-4.5", 120_000),
  ]);
  assert.equal(ceilings.get("qwen-plan/qwen3.8-max"), 277_174);
  assert.equal(ceilings.get("grok-oauth/grok-4.5"), 120_000);
  assert.equal(ceilings.size, 2);
});

test("a model whose traffic stays inside its window reports no drift", () => {
  assert.deepEqual(contextWindowDrift(MODELS, [event("openai/gpt-5.6-sol", 999_999)]), []);
  assert.equal(describeContextWindowDrift([]), undefined);
});

test("the summary names the worst offenders and counts the rest", () => {
  const many = Array.from({ length: 5 }, (_, index) => ({
    slug: `p/model-${index}`,
    contextWindow: 1_000,
    autoCompact: 900,
  }));
  const drift = contextWindowDrift(
    many,
    many.map((model, index) => event(model.slug, 1_100 + index * 100)),
  );
  const summary = describeContextWindowDrift(drift);
  assert.match(summary, /p\/model-4 declares 1000 but accepted 1500/);
  assert.match(summary, /and 2 more$/);
});
