import assert from "node:assert/strict";
import test from "node:test";
import { MODEL_BY_SLUG, PROVIDERS } from "../src/model-registry.mjs";
import { routedModel } from "../src/catalog.mjs";
import { curatedModelBlockReason, curatedModelProviderId } from "../src/opencode-curation.mjs";

test("DeepSeek V4.1 Flash publishes the documented Go route and capabilities", () => {
  const model = MODEL_BY_SLUG.get("opencode-go/deepseek-flash");
  assert.ok(model);
  assert.equal(model.upstreamModel, "deepseek-flash");
  assert.equal(model.gatewayModel, "opencode-go-deepseek-flash");
  assert.equal(model.provider, "opencode-go");
  assert.equal(PROVIDERS.get(model.provider).protocol, undefined);
  assert.equal(model.listed, true);
  assert.equal(model.contextWindow, 1_000_000);
  assert.ok(model.contextWindow - model.autoCompact >= 384_000);
  assert.deepEqual(model.inputModalities, ["text", "image"]);
  assert.deepEqual(model.reasoningLevels.map(({ effort }) => effort), ["low", "high", "max"]);
  assert.equal(model.requestProfile, "auto-tool-choice");
  assert.notEqual(model.multiAgentVersion, "v2");
  assert.equal(curatedModelProviderId("opencode-go", "deepseek-flash"), "opencode-go");
  assert.equal(curatedModelBlockReason("opencode-go", "deepseek-flash"), undefined);
  assert.ok(curatedModelBlockReason("opencode-go", "unverified-future-deepseek"));
  const published = routedModel({ slug: "gpt-5.5" }, model);
  assert.equal(published.display_name, "DeepSeek V4.1 Flash (opencode Go)");
  assert.equal(published.context_window, 1_000_000);
  assert.deepEqual(published.input_modalities, ["text", "image"]);
  assert.equal(MODEL_BY_SLUG.get("opencode-go/deepseek-v4-flash").upstreamModel, "deepseek-v4-flash");
});
