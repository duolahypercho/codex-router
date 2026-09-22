import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const testRoot = mkdtempSync(path.join(os.tmpdir(), "grok-4-7-test-"));
process.env.MODEL_ROUTER_USER_MODELS = path.join(testRoot, "user-models.json");
process.env.MODEL_ROUTER_STATE_DIR = path.join(testRoot, "state");

const { MODEL_BY_SLUG } = await import("../src/model-registry.mjs");

test("Grok 4.7 OAuth records the upstream id, window, and reasoning ladder", () => {
  const model = MODEL_BY_SLUG.get("grok-oauth/grok-4.7");
  assert.ok(model, "grok-oauth/grok-4.7 is missing from the registry");
  assert.equal(model.upstreamModel, "grok-4.7");
  assert.equal(model.gatewayModel, "grok-oauth-grok-4-7");
  assert.equal(model.listed, true);
  assert.equal(model.contextWindow, 500_000);
  assert.equal(model.autoCompact, 440_000);
  assert.equal(model.defaultEffort, "high");
  assert.deepEqual(
    model.reasoningLevels.map((level) => level.effort),
    ["low", "medium", "high", "xhigh"],
  );
  assert.deepEqual(model.inputModalities, ["text", "image"]);
  assert.equal(model.supportsReasoningSummaries, true);
  assert.deepEqual(model.searchTool, { mode: "hosted" });
  assert.equal(model.supportsImageDetailOriginal, true);
  assert.equal(model.multiAgentVersion, undefined);
  assert.equal(model.serviceTiers, undefined);
});
