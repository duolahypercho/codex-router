import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";

const root = mkdtempSync(path.join(os.tmpdir(), "meta-muse-catalog-"));
process.env.MODEL_ROUTER_STATE_DIR = root;
process.env.MODEL_ROUTER_USER_MODELS = path.join(root, "user-models.json");
after(() => rmSync(root, { recursive: true, force: true }));
const { MODEL_BY_SLUG } = await import("../src/model-registry.mjs");
const { routedModel } = await import("../src/catalog.mjs");

for (const id of ["muse-wonder-1.0", "muse-ember-1.0"]) {
  test(`${id} publishes the documented Meta Responses capabilities`, () => {
    const model = MODEL_BY_SLUG.get(`meta/${id}`);
    assert.ok(model);
    assert.equal(model.upstreamModel, id);
    assert.equal(model.provider, "meta");
    assert.equal(model.listed, true);
    assert.equal(model.contextWindow, 1_048_576);
    assert.ok(model.autoCompact < model.contextWindow);
    assert.equal(model.defaultEffort, "max");
    assert.deepEqual(model.reasoningLevels.map(({ effort }) => effort),
      ["minimal", "low", "medium", "high", "xhigh", "max"]);
    assert.deepEqual(model.inputModalities, ["text", "image"]);
    assert.equal(model.requestProfile, "auto-tool-choice");
    const published = routedModel({}, model);
    assert.equal(published.slug, model.slug);
    assert.equal(published.context_window, 1_048_576);
    assert.equal(published.default_reasoning_level, "max");
    assert.equal(published.supports_reasoning_summaries, true);
    assert.equal(published.default_reasoning_summary, "auto");
    assert.deepEqual(published.supported_reasoning_levels, model.reasoningLevels);
  });
}

test("Spark Standard supports max without extending Contributor's effort ladder", () => {
  assert.ok(MODEL_BY_SLUG.get("meta/muse-spark-1.3").reasoningLevels.some(x => x.effort === "max"));
  assert.ok(!MODEL_BY_SLUG.get("meta/muse-spark-1.3-contributor").reasoningLevels.some(x => x.effort === "max"));
  assert.equal(MODEL_BY_SLUG.get("meta/muse-ember-1.0").maxOutputTokens, 524_288);
});

test("all seven hosted chat models remain available without fictitious specialty routes", () => {
  const ids = [...MODEL_BY_SLUG.values()].filter(m => m.provider === "meta" && m.listed).map(m => m.upstreamModel).sort();
  assert.deepEqual(ids, ["muse-ember-1.0", "muse-spark-1.1", "muse-spark-1.2", "muse-spark-1.2-contributor", "muse-spark-1.3", "muse-spark-1.3-contributor", "muse-wonder-1.0"]);
});
