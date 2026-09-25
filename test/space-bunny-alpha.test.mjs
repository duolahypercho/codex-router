import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

// These assertions describe the checked-in registry, so the machine's own
// curated models must not leak in.
const testRoot = mkdtempSync(path.join(os.tmpdir(), "space-bunny-alpha-test-"));
process.env.MODEL_ROUTER_USER_MODELS = path.join(testRoot, "user-models.json");
process.env.MODEL_ROUTER_STATE_DIR = path.join(testRoot, "state");

const { MODEL_BY_SLUG } = await import("../src/model-registry.mjs");
const { selectedListedModels } = await import("../src/provider-selection.mjs");

const SLUG = "openrouter/stealth/space-bunny-alpha";
const COMMAND_CODE_SLUG = "commandcode/stealth/space-bunny-alpha";

test("Space Bunny Alpha keeps the slug an operator's local curation already used", () => {
  // OpenRouter lists the stealth id only on its own endpoint, not in the
  // public catalog, so operators reached it through curate-models first. The
  // checked-in slug matches that curated one, which makes the registry merge
  // skip the local copy instead of publishing the model twice.
  const model = MODEL_BY_SLUG.get(SLUG);
  assert.ok(model, `${SLUG} is missing from the registry`);
  assert.equal(model.provider, "openrouter");
  assert.equal(model.upstreamModel, "stealth/space-bunny-alpha");
  assert.equal(model.gatewayModel, "openrouter-stealth-space-bunny-alpha");
  assert.equal(model.listed, true);
});

test("Space Bunny Alpha compacts early enough for its input cap and full output", () => {
  // OpenRouter publishes a 1,000,000-token window and a 524,288-token output
  // limit, and models.dev records a 524,288-token input cap for the same
  // model on OpenCode. Compacting below both leaves room for a full-length
  // completion and never sends a prompt the upstream could refuse on size.
  const model = MODEL_BY_SLUG.get(SLUG);
  assert.equal(model.contextWindow, 1_000_000);
  assert.ok(model.contextWindow - model.autoCompact >= 524_288);
  assert.ok(model.autoCompact < 524_288);
});

test("Space Bunny Alpha offers the effort ladder the endpoint accepted", () => {
  // Reasoning cannot be turned off (the endpoint answers HTTP 400 to
  // reasoning.enabled=false), so there is no `minimal` rung. Each of the five
  // rungs below was accepted by the live endpoint on 2026-09-24.
  const model = MODEL_BY_SLUG.get(SLUG);
  assert.deepEqual(
    model.reasoningLevels.map(({ effort }) => effort),
    ["low", "medium", "high", "xhigh", "max"],
  );
  assert.equal(model.defaultEffort, "high");
  assert.deepEqual(model.inputModalities, ["text", "image"]);
  // Tool calls worked under required, auto, and a named function, so no
  // tool-choice repair is attached, and nothing here claims the v2 child role.
  assert.equal(model.requestProfile, undefined);
  assert.equal(model.multiAgentVersion, undefined);
});

test("Command Code publishes Space Bunny Alpha under its advertised model ID", () => {
  const model = MODEL_BY_SLUG.get(COMMAND_CODE_SLUG);
  assert.ok(model, `${COMMAND_CODE_SLUG} is missing from the registry`);
  assert.equal(model.provider, "commandcode");
  assert.equal(model.upstreamModel, "stealth/space-bunny-alpha");
  assert.equal(model.gatewayModel, "commandcode-stealth-space-bunny-alpha");
  assert.equal(model.listed, true);
  assert.equal(model.contextWindow, 1_000_000);
  assert.equal(model.autoCompact, 700_000);
  assert.deepEqual(model.inputModalities, ["text"]);
  assert.deepEqual(
    model.reasoningLevels.map(({ effort }) => effort),
    ["medium"],
  );
  assert.equal(model.defaultEffort, "medium");
  assert.equal(model.requestProfile, undefined);
  assert.equal(model.multiAgentVersion, undefined);
});

test("Command Code Space Bunny Alpha is included in the selectable model set", () => {
  assert.ok(selectedListedModels().some(({ slug }) => slug === COMMAND_CODE_SLUG));
});
