import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "path";
import test from "node:test";

// These assertions describe the checked-in registry, so the machine's own
// curated models must not leak in.
const testRoot = mkdtempSync(path.join(os.tmpdir(), "gemini38-muse13-fable51-test-"));
process.env.MODEL_ROUTER_USER_MODELS = path.join(testRoot, "user-models.json");
process.env.MODEL_ROUTER_STATE_DIR = path.join(testRoot, "state");

const { MODEL_BY_SLUG } = await import("../src/model-registry.mjs");

// Gemini 3.8 Flash routes confirmed 2026-09-03.
const GEMINI_38_FLASH_ROUTES = [
  ["openrouter/gemini-3.8-flash", "google/gemini-3.8-flash", 1_048_576, 943_000],
  ["commandcode/gemini-3.8-flash", "google/gemini-3.8-flash", 1_000_000, 900_000],
  ["nousresearch/gemini-3.8-flash", "google/gemini-3.8-flash", 1_048_576, 943_000],
  ["venice/gemini-3.8-flash", "gemini-3-8-flash", 1_000_000, 900_000],
];

// Muse Spark 1.3 routes confirmed 2026-09-03.
const MUSE_12_ROUTES = [
  ["openrouter/muse-spark-1.2", "meta/muse-spark-1.2", 1_048_576, 943_000],
  ["openrouter/muse-spark-1.2-contributor", "meta/muse-spark-1.2-contributor", 1_048_576, 943_000],
];

const MUSE_13_ROUTES = [
  ["openrouter/muse-spark-1.3", "meta/muse-spark-1.3", 1_048_576, 943_000],
  ["openrouter/muse-spark-1.3-contributor", "meta/muse-spark-1.3-contributor", 1_048_576, 943_000],
  ["nousresearch/muse-spark-1.3", "meta/muse-spark-1.3", 1_048_576, 943_000],
  ["nousresearch/muse-spark-1.3-contributor", "meta/muse-spark-1.3-contributor", 1_048_576, 943_000],
  ["opencode-go-responses/muse-spark-1.3-contributor", "muse-spark-1.3-contributor", 1_048_576, 900_000],
];

// Claude Fable 5.1 routes confirmed 2026-09-03.
const FABLE_51_ROUTES = [
  ["openrouter/claude-fable-5.1", "anthropic/claude-fable-5.1", 1_000_000, 900_000],
  ["commandcode-messages/claude-fable-5.1", "claude-fable-5-1", 1_000_000, 900_000],
  ["nousresearch/claude-fable-5.1", "anthropic/claude-fable-5.1", 1_048_576, 943_000],
  ["venice/claude-fable-5.1", "claude-fable-5-1", 1_000_000, 900_000],
];

// Additional confirmed routes 2026-09-03.
const ADDITIONAL_ROUTES = [
  ["commandcode/qwen3.8-max-0902", "Qwen/Qwen3.8-Max-0902", 1_000_000, 900_000],
  ["commandcode/glm-5.3-flash", "z-ai/glm-5.3-flash", 1_000_000, 900_000],
  ["opencode-go-messages/qwen3.8-flash", "qwen3.8-flash", 262_144, 235_000],
];

test("every Gemini 3.8 Flash route records the upstream id and window", () => {
  for (const [slug, upstreamModel, contextWindow, autoCompact] of GEMINI_38_FLASH_ROUTES) {
    const model = MODEL_BY_SLUG.get(slug);
    assert.ok(model, `${slug} is missing from the registry`);
    assert.equal(model.upstreamModel, upstreamModel);
    assert.equal(model.listed, true);
    assert.equal(model.contextWindow, contextWindow);
    assert.equal(model.autoCompact, autoCompact);
  }
});

test("every Muse Spark 1.2 OpenRouter route records the upstream id and window", () => {
  for (const [slug, upstreamModel, contextWindow, autoCompact] of MUSE_12_ROUTES) {
    const model = MODEL_BY_SLUG.get(slug);
    assert.ok(model, `${slug} is missing from the registry`);
    assert.equal(model.upstreamModel, upstreamModel);
    assert.equal(model.listed, true);
    assert.equal(model.contextWindow, contextWindow);
    assert.equal(model.autoCompact, autoCompact);
  }
});

test("every Muse Spark 1.3 route records the upstream id and window", () => {
  for (const [slug, upstreamModel, contextWindow, autoCompact] of MUSE_13_ROUTES) {
    const model = MODEL_BY_SLUG.get(slug);
    assert.ok(model, `${slug} is missing from the registry`);
    assert.equal(model.upstreamModel, upstreamModel);
    assert.equal(model.listed, true);
    assert.equal(model.contextWindow, contextWindow);
    assert.equal(model.autoCompact, autoCompact);
  }
});

test("every Claude Fable 5.1 route records the upstream id and window", () => {
  for (const [slug, upstreamModel, contextWindow, autoCompact] of FABLE_51_ROUTES) {
    const model = MODEL_BY_SLUG.get(slug);
    assert.ok(model, `${slug} is missing from the registry`);
    assert.equal(model.upstreamModel, upstreamModel);
    assert.equal(model.listed, true);
    assert.equal(model.contextWindow, contextWindow);
    assert.equal(model.autoCompact, autoCompact);
  }
});

test("additional routes record their static metadata", () => {
  for (const [slug, upstreamModel, contextWindow, autoCompact] of ADDITIONAL_ROUTES) {
    const model = MODEL_BY_SLUG.get(slug);
    assert.ok(model, `${slug} is missing from the registry`);
    assert.equal(model.upstreamModel, upstreamModel);
    assert.equal(model.listed, true);
    assert.equal(model.contextWindow, contextWindow);
    assert.equal(model.autoCompact, autoCompact);
  }
});

test("Gemini 3.8 Flash input modalities match catalog documentation", () => {
  // OpenRouter and Nous are text-only; Command Code is text-only; Venice has vision.
  const textOnlySlugs = [
    "openrouter/gemini-3.8-flash",
    "commandcode/gemini-3.8-flash",
    "nousresearch/gemini-3.8-flash",
  ];
  for (const slug of textOnlySlugs) {
    const model = MODEL_BY_SLUG.get(slug);
    assert.deepEqual(model.inputModalities, ["text"]);
  }

  const veniceModel = MODEL_BY_SLUG.get("venice/gemini-3.8-flash");
  assert.deepEqual(veniceModel.inputModalities, ["text", "image"]);
});

test("Muse Spark 1.3 routes use auto-tool-choice request profile", () => {
  for (const [slug] of MUSE_13_ROUTES) {
    const model = MODEL_BY_SLUG.get(slug);
    assert.equal(model.requestProfile, "auto-tool-choice");
  }
});

test("Muse Spark reseller routes advertise text and image input", () => {
  const visionSlugs = [
    "meta/muse-spark-1.2",
    "meta/muse-spark-1.2-contributor",
    "commandcode/muse-spark-1.2",
    "openrouter/muse-spark-1.2",
    "openrouter/muse-spark-1.2-contributor",
    "openrouter/muse-spark-1.3",
    "openrouter/muse-spark-1.3-contributor",
    "nousresearch/muse-spark-1.3",
    "nousresearch/muse-spark-1.3-contributor",
    "nousresearch/muse-spark-1.2-contributor",
    "opencode-go-responses/muse-spark-1.2-contributor",
    "opencode-go-responses/muse-spark-1.3-contributor",
  ];
  for (const slug of visionSlugs) {
    const model = MODEL_BY_SLUG.get(slug);
    assert.deepEqual(model.inputModalities, ["text", "image"], slug);
  }
});

test("Muse Spark 1.3 reasoning ladders have minimal/low/medium/high/xhigh", () => {
  const expectedEfforts = ["minimal", "low", "medium", "high", "xhigh"];
  for (const [slug] of MUSE_13_ROUTES) {
    const model = MODEL_BY_SLUG.get(slug);
    assert.deepEqual(
      model.reasoningLevels.map((level) => level.effort),
      expectedEfforts,
    );
  }
});

test("Muse Spark xhigh is labeled as extra deep, not max, and defaults to high", () => {
  const museSlugs = [
    ...MUSE_13_ROUTES.map(([slug]) => slug),
    ...MUSE_12_ROUTES.map(([slug]) => slug),
    "meta/muse-spark-1.2",
    "meta/muse-spark-1.2-contributor",
    "meta/muse-spark-1.1",
  ];
  for (const slug of museSlugs) {
    const model = MODEL_BY_SLUG.get(slug);
    assert.ok(model, `${slug} is missing from the registry`);
    assert.equal(model.defaultEffort, "high", slug);
    const xhigh = model.reasoningLevels.find((level) => level.effort === "xhigh");
    assert.ok(xhigh, `${slug} is missing xhigh`);
    assert.equal(xhigh.description, "Extra deep reasoning", slug);
    assert.notEqual(xhigh.description, "Maximum reasoning");
    assert.ok(
      !model.reasoningLevels.some((level) => level.effort === "max"),
      `${slug} must not advertise Meta's unreleased max tier yet`,
    );
  }
});

test("Gemini 3.8 Flash reasoning matches provider patterns", () => {
  // Nous has low/medium/high
  const nousModel = MODEL_BY_SLUG.get("nousresearch/gemini-3.8-flash");
  assert.deepEqual(
    nousModel.reasoningLevels.map((level) => level.effort),
    ["low", "medium", "high"],
  );

  // Command Code has single high
  const ccModel = MODEL_BY_SLUG.get("commandcode/gemini-3.8-flash");
  assert.deepEqual(
    ccModel.reasoningLevels.map((level) => level.effort),
    ["high"],
  );

  // Venice has low/high/max
  const veniceModel = MODEL_BY_SLUG.get("venice/gemini-3.8-flash");
  assert.deepEqual(
    veniceModel.reasoningLevels.map((level) => level.effort),
    ["low", "high", "max"],
  );
});

test("Claude Fable 5.1 reasoning ladders match provider patterns", () => {
  // OpenRouter and Nous have full ladder
  const fullLadderSlugs = [
    "openrouter/claude-fable-5.1",
    "commandcode-messages/claude-fable-5.1",
    "nousresearch/claude-fable-5.1",
  ];
  const expectedEfforts = ["low", "medium", "high", "xhigh", "max"];
  for (const slug of fullLadderSlugs) {
    const model = MODEL_BY_SLUG.get(slug);
    assert.deepEqual(
      model.reasoningLevels.map((level) => level.effort),
      expectedEfforts,
    );
  }

  // Venice has low/high/max
  const veniceModel = MODEL_BY_SLUG.get("venice/claude-fable-5.1");
  assert.deepEqual(
    veniceModel.reasoningLevels.map((level) => level.effort),
    ["low", "high", "max"],
  );
});

test("GLM-5.3-Flash uses low/high/max reasoning ladder", () => {
  const model = MODEL_BY_SLUG.get("commandcode/glm-5.3-flash");
  assert.deepEqual(
    model.reasoningLevels.map((level) => level.effort),
    ["low", "high", "max"],
  );
});

test("Command Code gemini-3.8-flash has requiresTrailingUserTurn", () => {
  const model = MODEL_BY_SLUG.get("commandcode/gemini-3.8-flash");
  assert.equal(model.requiresTrailingUserTurn, true);
});

test("no new route sets multiAgentVersion v2 without v2_agent/ artifact", () => {
  const allNewSlugs = [
    ...GEMINI_38_FLASH_ROUTES.map(([slug]) => slug),
    ...MUSE_12_ROUTES.map(([slug]) => slug),
    ...MUSE_13_ROUTES.map(([slug]) => slug),
    ...FABLE_51_ROUTES.map(([slug]) => slug),
    ...ADDITIONAL_ROUTES.map(([slug]) => slug),
  ];
  for (const slug of allNewSlugs) {
    const model = MODEL_BY_SLUG.get(slug);
    assert.notEqual(model.multiAgentVersion, "v2", `${slug} must not set v2 without artifact`);
  }
});

test("OpenRouter routes have no requestProfile except Muse auto-tool-choice", () => {
  const openrouterSlugs = [
    "openrouter/gemini-3.8-flash",
    "openrouter/claude-fable-5.1",
  ];
  for (const slug of openrouterSlugs) {
    const model = MODEL_BY_SLUG.get(slug);
    assert.equal(model.requestProfile, undefined, `${slug} must not have requestProfile`);
  }
});

test("Nous routes have no requestProfile except Muse auto-tool-choice", () => {
  const nousNoProfileSlugs = [
    "nousresearch/gemini-3.8-flash",
    "nousresearch/claude-fable-5.1",
  ];
  for (const slug of nousNoProfileSlugs) {
    const model = MODEL_BY_SLUG.get(slug);
    assert.equal(model.requestProfile, undefined, `${slug} must not have requestProfile`);
  }
});

test("Venice routes have no requestProfile", () => {
  const veniceSlugs = [
    "venice/gemini-3.8-flash",
    "venice/claude-fable-5.1",
  ];
  for (const slug of veniceSlugs) {
    const model = MODEL_BY_SLUG.get(slug);
    assert.equal(model.requestProfile, undefined, `${slug} must not have requestProfile`);
  }
});

test("GLM-5.3-Flash input modalities include text and image", () => {
  const model = MODEL_BY_SLUG.get("commandcode/glm-5.3-flash");
  assert.deepEqual(model.inputModalities, ["text", "image"]);
});

test("Qwen3.8 Flash opencode-go-messages has auto-tool-choice profile", () => {
  const model = MODEL_BY_SLUG.get("opencode-go-messages/qwen3.8-flash");
  assert.equal(model.requestProfile, "auto-tool-choice");
});
