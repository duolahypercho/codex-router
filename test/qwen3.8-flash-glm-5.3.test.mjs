import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "path";
import test from "node:test";

// These assertions describe the checked-in registry, so the machine's own
// curated models must not leak in.
const testRoot = mkdtempSync(path.join(os.tmpdir(), "qwen-glm-test-"));
process.env.MODEL_ROUTER_USER_MODELS = path.join(testRoot, "user-models.json");
process.env.MODEL_ROUTER_STATE_DIR = path.join(testRoot, "state");

const { MODEL_BY_SLUG } = await import("../src/model-registry.mjs");

// Qwen3.8 Flash routes confirmed 2026-08-27.
const QWEN_FLASH_ROUTES = [
  ["openrouter/qwen3.8-flash", "qwen/qwen3.8-flash", 1_000_000, 900_000],
  ["commandcode/qwen3.8-flash", "Qwen/Qwen3.8-Flash", 1_000_000, 900_000],
  ["qwen-plan/qwen3.8-flash", "qwen3.8-flash", 983_616, 900_000],
  ["nousresearch/qwen3.8-flash", "qwen/qwen3.8-flash", 1_000_000, 900_000],
];

// The first three GLM-5.3 full routes were confirmed 2026-08-27. The Ollama
// Cloud entry is checked-in candidate metadata added later; these assertions
// do not replace its required current-head router-level live certificate.
const GLM_FULL_ROUTES = [
  ["openrouter/glm-5.3", "z-ai/glm-5.3", 1_048_576, 943_000],
  ["commandcode/glm-5.3", "zai-org/GLM-5.3", 1_000_000, 900_000],
  ["venice/glm-5.3", "z-ai-glm-5-3", 1_000_000, 900_000],
  ["ollama-cloud/glm-5.3", "glm-5.3:cloud", 1_000_000, 880_000],
];

// GLM-5.3-Flash zai-api route confirmed 2026-08-27.
const GLM_FLASH_ZAI_API = [
  ["zai-api/glm-5.3-flash", "glm-5.3-flash", 1_000_000, 400_000],
];

test("every Qwen3.8 Flash route records the upstream id and window", () => {
  for (const [slug, upstreamModel, contextWindow, autoCompact] of QWEN_FLASH_ROUTES) {
    const model = MODEL_BY_SLUG.get(slug);
    assert.ok(model, `${slug} is missing from the registry`);
    assert.equal(model.upstreamModel, upstreamModel);
    assert.equal(model.listed, true);
    assert.equal(model.contextWindow, contextWindow);
    assert.equal(model.autoCompact, autoCompact);
  }
});

test("confirmed and candidate GLM-5.3 full routes record their static metadata", () => {
  for (const [slug, upstreamModel, contextWindow, autoCompact] of GLM_FULL_ROUTES) {
    const model = MODEL_BY_SLUG.get(slug);
    assert.ok(model, `${slug} is missing from the registry`);
    assert.equal(model.upstreamModel, upstreamModel);
    assert.equal(model.listed, true);
    assert.equal(model.contextWindow, contextWindow);
    assert.equal(model.autoCompact, autoCompact);
  }
});

test("zai-api/glm-5.3-flash records the upstream id and window", () => {
  for (const [slug, upstreamModel, contextWindow, autoCompact] of GLM_FLASH_ZAI_API) {
    const model = MODEL_BY_SLUG.get(slug);
    assert.ok(model, `${slug} is missing from the registry`);
    assert.equal(model.upstreamModel, upstreamModel);
    assert.equal(model.listed, true);
    assert.equal(model.contextWindow, contextWindow);
    assert.equal(model.autoCompact, autoCompact);
    assert.equal(model.requestProfile, "glm-thinking");
  }
});

test("Qwen3.8 Flash input modalities match catalog documentation", () => {
  // All Qwen3.8 Flash routes document text+image.
  for (const slug of ["openrouter/qwen3.8-flash", "commandcode/qwen3.8-flash", "qwen-plan/qwen3.8-flash", "nousresearch/qwen3.8-flash"]) {
    const model = MODEL_BY_SLUG.get(slug);
    assert.deepEqual(model.inputModalities, ["text", "image"]);
  }
});

test("GLM-5.3 full input modalities are text-only", () => {
  // All GLM-5.3 full routes are text-only (no vision).
  for (const [slug] of GLM_FULL_ROUTES) {
    const model = MODEL_BY_SLUG.get(slug);
    assert.deepEqual(model.inputModalities, ["text"]);
  }
});

test("GLM-5.3 full reasoning ladders use low/high/max", () => {
  // All GLM-5.3 full routes use the model's low/high/max ladder.
  for (const [slug] of GLM_FULL_ROUTES) {
    const model = MODEL_BY_SLUG.get(slug);
    assert.deepEqual(
      model.reasoningLevels.map((level) => level.effort),
      ["low", "high", "max"],
    );
    assert.equal(model.defaultEffort, "max");
  }
});

test("Qwen3.8 Flash reasoning uses single high level", () => {
  // All Qwen3.8 Flash routes use a single high reasoning level.
  for (const slug of ["openrouter/qwen3.8-flash", "commandcode/qwen3.8-flash", "qwen-plan/qwen3.8-flash", "nousresearch/qwen3.8-flash"]) {
    const model = MODEL_BY_SLUG.get(slug);
    assert.deepEqual(
      model.reasoningLevels.map((level) => level.effort),
      ["high"],
    );
    assert.equal(model.defaultEffort, "high");
  }
});

test("qwen-plan routes have the qwen-plan request profile", () => {
  const model = MODEL_BY_SLUG.get("qwen-plan/qwen3.8-flash");
  assert.equal(model.requestProfile, "qwen-plan");
  assert.equal(model.supportsImageDetailOriginal, true);
});

test("no route sets multiAgentVersion v2 without v2_agent/ artifact", () => {
  const allNewSlugs = [
    ...QWEN_FLASH_ROUTES.map(([slug]) => slug),
    ...GLM_FULL_ROUTES.map(([slug]) => slug),
    ...GLM_FLASH_ZAI_API.map(([slug]) => slug),
  ];
  for (const slug of allNewSlugs) {
    const model = MODEL_BY_SLUG.get(slug);
    assert.notEqual(model.multiAgentVersion, "v2", `${slug} must not set v2 without artifact`);
  }
});

test("OpenRouter, Command Code, Nous, and Venice routes have no requestProfile", () => {
  const noProfileSlugs = [
    "openrouter/qwen3.8-flash",
    "openrouter/glm-5.3",
    "commandcode/qwen3.8-flash",
    "commandcode/glm-5.3",
    "nousresearch/qwen3.8-flash",
    "venice/glm-5.3",
  ];
  for (const slug of noProfileSlugs) {
    const model = MODEL_BY_SLUG.get(slug);
    assert.equal(model.requestProfile, undefined, `${slug} must not have requestProfile`);
  }
});
