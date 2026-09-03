import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

// These assertions describe the checked-in registry and synthetic account
// fixtures, so the machine's own models, credentials, and quota history must
// not leak in; the imports are dynamic for that reason.
const testRoot = mkdtempSync(path.join(os.tmpdir(), "glm-5.3-flash-test-"));
process.env.MODEL_ROUTER_USER_MODELS = path.join(testRoot, "user-models.json");
process.env.MODEL_ROUTER_STATE_DIR = path.join(testRoot, "state");

const { MODEL_BY_SLUG } = await import("../src/model-registry.mjs");

// This inventory asserts checked-in metadata only. The Ollama Cloud entry is a
// candidate until its own current-head router-level exact-route certificate is
// recorded; presence in this array is not that proof.
const ROUTES = [
  ["opencode-go/glm-5.3-flash", "glm-5.3-flash", "ox-alpha"],
  ["ollama-cloud/glm-5.3-flash", "glm-5.3-flash:cloud", "ollama-cloud-glm-5-3-flash"],
  ["openrouter/glm-5.3-flash", "z-ai/glm-5.3-flash", "ox-alpha"],
  ["zai-api/glm-5.3-flash", "glm-5.3-flash", "glm-thinking"],
  ["zai-coding/glm-5.3-flash", "glm-5.3-flash", "glm-thinking"],
];

test("every checked-in GLM-5.3-Flash route records its static metadata", () => {
  for (const [slug, upstreamModel, requestProfile] of ROUTES) {
    const model = MODEL_BY_SLUG.get(slug);
    assert.ok(model, `${slug} is missing from the registry`);
    assert.equal(model.upstreamModel, upstreamModel);
    assert.equal(model.listed, true);
    assert.deepEqual(model.reasoningLevels.map((level) => level.effort), ["low", "high", "max"]);
    assert.equal(model.defaultEffort, "max");
    assert.equal(model.contextWindow, 1_000_000);
    assert.equal(model.autoCompact, 400_000);
    assert.deepEqual(
      model.inputModalities,
      ["opencode-go/glm-5.3-flash", "ollama-cloud/glm-5.3-flash"].includes(slug) ? ["text", "image"] : ["text"],
    );
    assert.equal(model.requestProfile, requestProfile);
  }
});

test("withdrawn or uncertified reseller routes stay absent while direct-proven routes remain", () => {
  for (const slug of [
    "commandcode/ox-alpha",
    "nousresearch/ox-alpha",
    "opencode-free/ox-alpha",
    "openrouter/ox-alpha",
    "venice/ox-alpha",
  ]) {
    assert.equal(MODEL_BY_SLUG.has(slug), false, `${slug} should not exist`);
  }
  for (const slug of [
    "nousresearch/glm-5.3-flash",
    "venice/glm-5.3-flash",
  ]) {
    assert.equal(MODEL_BY_SLUG.has(slug), false, `${slug} is not route-certified`);
  }
  assert.equal(MODEL_BY_SLUG.has("commandcode/glm-5.3-flash"), true);
  assert.equal(MODEL_BY_SLUG.has("openrouter/glm-5.3-flash"), true);
  assert.equal(MODEL_BY_SLUG.has("zai-api/glm-5.3-flash"), true);
  assert.equal(MODEL_BY_SLUG.has("zai-coding/glm-5.3-flash"), true);
  assert.equal(MODEL_BY_SLUG.has("opencode-go/glm-5.3-flash"), true);
  assert.equal(MODEL_BY_SLUG.has("ollama-cloud/glm-5.3-flash"), true);
});

test("Ollama Cloud Flash candidate records its upstream id and request profile", () => {
  assert.equal(MODEL_BY_SLUG.has("ollama-cloud/glm-5.3-flash"), true);
  const model = MODEL_BY_SLUG.get("ollama-cloud/glm-5.3-flash");
  assert.equal(model?.upstreamModel, "glm-5.3-flash:cloud");
  assert.equal(model?.requestProfile, "ollama-cloud-glm-5-3-flash");
});
