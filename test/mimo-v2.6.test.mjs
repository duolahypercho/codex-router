import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

// These assertions describe the checked-in registry, so the machine's own
// curated models must not leak in.
const testRoot = mkdtempSync(path.join(os.tmpdir(), "mimo-v2-6-test-"));
process.env.MODEL_ROUTER_USER_MODELS = path.join(testRoot, "user-models.json");
process.env.MODEL_ROUTER_STATE_DIR = path.join(testRoot, "state");

const { MODEL_BY_SLUG, MODELS } = await import("../src/model-registry.mjs");

// Xiaomi's MiMo-V2.6 series ships Pro, Flash, and Pro-UltraSpeed. Each route
// below was taken from that provider's own live catalog rather than from the
// family name, which is why the windows and modalities are not uniform.
const ROUTES = [
  ["xiaomi-mimo/mimo-v2.6-pro", "mimo-v2.6-pro"],
  ["xiaomi-mimo/mimo-v2.6-flash", "mimo-v2.6-flash"],
  ["xiaomi-mimo/mimo-v2.6-pro-ultraspeed", "mimo-v2.6-pro-ultraspeed"],
  ["commandcode/mimo-v2.6-pro", "xiaomi/mimo-v2.6-pro"],
  ["commandcode/mimo-v2.6-flash", "xiaomi/mimo-v2.6-flash"],
  ["commandcode/mimo-v2.6-pro-ultraspeed", "xiaomi/mimo-v2.6-pro-ultraspeed"],
  ["nousresearch/mimo-v2.6-pro", "xiaomi/mimo-v2.6-pro"],
  ["nousresearch/mimo-v2.6-flash", "xiaomi/mimo-v2.6-flash"],
  ["nousresearch/mimo-v2.6-pro-ultraspeed", "xiaomi/mimo-v2.6-pro-ultraspeed"],
  ["openrouter/mimo-v2.6-pro", "xiaomi/mimo-v2.6-pro"],
  ["openrouter/mimo-v2.6-flash", "xiaomi/mimo-v2.6-flash"],
  ["openrouter/mimo-v2.6-pro-ultraspeed", "xiaomi/mimo-v2.6-pro-ultraspeed"],
  ["opencode-go/mimo-v2.6-pro", "mimo-v2.6-pro"],
  ["opencode-go/mimo-v2.6-flash", "mimo-v2.6-flash"],
];

test("every MiMo V2.6 route records its upstream id and a reserved window", () => {
  for (const [slug, upstreamModel] of ROUTES) {
    const model = MODEL_BY_SLUG.get(slug);
    assert.ok(model, `${slug} is missing from the registry`);
    assert.equal(model.upstreamModel, upstreamModel);
    assert.equal(model.listed, true);
    // Xiaomi publishes a 131,072-token output limit for the whole series, so
    // compaction has to fire while that much room is still left in the window
    // it just declared -- otherwise a full-length answer overruns it.
    assert.ok(
      model.contextWindow - model.autoCompact >= 131_072,
      `${slug} reserves ${model.contextWindow - model.autoCompact} for a 131,072-token completion`,
    );
  }
});

test("MiMo V2.6 windows follow each provider's own catalog figure", () => {
  // Xiaomi's API, OpenRouter, Nous Portal, and Command Code all publish
  // 1,048,576 for these ids.
  for (const slug of ROUTES.map(([slug]) => slug).filter((slug) => !slug.startsWith("opencode-go/"))) {
    assert.equal(MODEL_BY_SLUG.get(slug).contextWindow, 1_048_576, slug);
  }

  // OpenCode's catalog publishes no limit for a paid Go id, so these keep the
  // figure their checked-in V2.5 siblings on the same route already use.
  for (const slug of ["opencode-go/mimo-v2.6-pro", "opencode-go/mimo-v2.6-flash"]) {
    assert.equal(MODEL_BY_SLUG.get(slug).contextWindow, 1_000_000, slug);
    assert.equal(
      MODEL_BY_SLUG.get(slug).contextWindow,
      MODEL_BY_SLUG.get(slug.replace("v2.6-flash", "v2.5").replace("v2.6-pro", "v2.5-pro")).contextWindow,
      slug,
    );
  }
});

test("MiMo V2.6 image input is claimed only where the route publishes it", () => {
  // Xiaomi, Nous, and OpenRouter each advertise image input on these ids.
  for (const slug of [
    "xiaomi-mimo/mimo-v2.6-pro",
    "xiaomi-mimo/mimo-v2.6-flash",
    "xiaomi-mimo/mimo-v2.6-pro-ultraspeed",
    "nousresearch/mimo-v2.6-pro",
    "openrouter/mimo-v2.6-flash",
  ]) {
    assert.deepEqual(MODEL_BY_SLUG.get(slug).inputModalities, ["text", "image"], slug);
  }

  // Command Code and opencode Go publish no modalities for these ids, so they
  // stay on the conservative text-only default their V2.5 entries use.
  for (const slug of [
    "commandcode/mimo-v2.6-pro",
    "commandcode/mimo-v2.6-flash",
    "opencode-go/mimo-v2.6-pro",
    "opencode-go/mimo-v2.6-flash",
  ]) {
    assert.deepEqual(MODEL_BY_SLUG.get(slug).inputModalities, ["text"], slug);
  }
});

test("MiMo V2.6 exposes one rung because Xiaomi documents a thinking toggle", () => {
  // The series publishes reasoning as a toggle, not an effort ladder, so
  // inventing low/medium/high here would advertise a control that does not
  // exist. Every checked-in MiMo entry already reads this way.
  for (const [slug] of ROUTES) {
    const model = MODEL_BY_SLUG.get(slug);
    assert.deepEqual(model.reasoningLevels.map((level) => level.effort), ["high"], slug);
    assert.equal(model.defaultEffort, "high", slug);
    assert.equal(model.multiAgentVersion, undefined, slug);
  }
});

test("UltraSpeed says what it costs, because it shadows a cheaper twin", () => {
  // Xiaomi bills UltraSpeed at ten times the V2.6-Pro token price for the same
  // answers. It arrives in the picker next to Pro, so the price difference
  // belongs in the description the picker shows rather than in a release note.
  for (const model of MODELS.filter(({ slug }) => slug.endsWith("/mimo-v2.6-pro-ultraspeed"))) {
    assert.match(model.description, /ten times the V2\.6-Pro token price/, model.slug);
  }
});
