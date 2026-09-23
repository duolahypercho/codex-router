import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

// These assertions describe the checked-in registry, so the machine's own
// curated models must not leak in.
const testRoot = mkdtempSync(path.join(os.tmpdir(), "grok-4-6-test-"));
process.env.MODEL_ROUTER_USER_MODELS = path.join(testRoot, "user-models.json");
process.env.MODEL_ROUTER_STATE_DIR = path.join(testRoot, "state");

const { MODEL_BY_SLUG } = await import("../src/model-registry.mjs");

// Grok 4.6 is shipped through four providers. Each provider names the model
// slightly differently, and their catalogs vary. These assertions keep the
// checked-in pins from drifting.
const ROUTES = [
  ["commandcode/grok-4.6", "xai/grok-4.6"],
  ["nousresearch/grok-4.6", "x-ai/grok-4.6"],
  ["grok-oauth/grok-4.6", "grok-4.6"],
  ["openrouter/grok-4.6", "x-ai/grok-4.6"],
];

test("every Grok 4.6 route records the upstream id and window", () => {
  for (const [slug, upstreamModel] of ROUTES) {
    const model = MODEL_BY_SLUG.get(slug);
    assert.ok(model, `${slug} is missing from the registry`);
    assert.equal(model.upstreamModel, upstreamModel);
    assert.equal(model.listed, true);
    // The official window is 500,000 tokens.
    assert.equal(model.contextWindow, 500_000);
    // autoCompact sits below the hard limit.
    assert.ok(model.autoCompact >= 440_000 && model.autoCompact <= 450_000);
  }
});

test("Grok 4.6 reasoning ladders match catalog documentation", () => {
  // Nous Portal, grok-oauth, and OpenRouter document low/medium/high/xhigh.
  // OpenRouter's entry carried low/medium/high until 2026-09-22 only because
  // it was copied from Command Code's; OpenRouter's own reasoning docs list
  // xhigh in the accepted vocabulary, its /models record for x-ai/grok-4.6
  // advertises `reasoning_effort` in supported_parameters, and xAI documents
  // xhigh as a native rung of this model, so the route really does carry it.
  for (const slug of ["nousresearch/grok-4.6", "grok-oauth/grok-4.6", "openrouter/grok-4.6"]) {
    const model = MODEL_BY_SLUG.get(slug);
    assert.deepEqual(
      model.reasoningLevels.map((level) => level.effort),
      ["low", "medium", "high", "xhigh"],
    );
  }

  // Command Code publishes no parameter metadata for its Grok route at all,
  // so it stays on the conservative low/medium/high rather than inheriting
  // xAI's ladder through a reseller that has not said it forwards the field.
  for (const slug of ["commandcode/grok-4.6"]) {
    const model = MODEL_BY_SLUG.get(slug);
    assert.deepEqual(
      model.reasoningLevels.map((level) => level.effort),
      ["low", "medium", "high"],
    );
  }
});

test("Grok 4.6 input modalities match catalog documentation", () => {
  // Command Code, grok-oauth, and OpenRouter document text+image support.
  for (const slug of ["commandcode/grok-4.6", "grok-oauth/grok-4.6", "openrouter/grok-4.6"]) {
    const model = MODEL_BY_SLUG.get(slug);
    assert.deepEqual(model.inputModalities, ["text", "image"]);
  }

  // Nous Research documents text-only.
  const nousModel = MODEL_BY_SLUG.get("nousresearch/grok-4.6");
  assert.deepEqual(nousModel.inputModalities, ["text"]);
});

test("Grok OAuth 4.6 advertises Fast as an opt-in priority tier without a paid default", () => {
  const model = MODEL_BY_SLUG.get("grok-oauth/grok-4.6");
  assert.deepEqual(model.serviceTiers, [{ id: "priority", name: "Fast", description: "Use priority processing when available." }]);
  for (const slug of ["grok-oauth/grok-4.5", "commandcode/grok-4.6", "openrouter/grok-4.6", "nousresearch/grok-4.6"]) {
    assert.equal(MODEL_BY_SLUG.get(slug).serviceTiers, undefined, `${slug} must not inherit Grok OAuth Fast`);
  }
});
