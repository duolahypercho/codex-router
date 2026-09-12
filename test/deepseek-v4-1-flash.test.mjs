import assert from "node:assert/strict";
import test from "node:test";
import { MODEL_BY_SLUG } from "../src/model-registry.mjs";
import { routedModel } from "../src/catalog.mjs";
import { curatedModelBlockReason, curatedModelProviderId } from "../src/opencode-curation.mjs";

// DeepSeek documents a 64K default completion in thinking mode and 128K at
// `max` effort, so compaction must leave at least that much of the window.
const MAX_EFFORT_DEFAULT_OUTPUT = 128_000;

test("DeepSeek V4.1 Flash on the direct API publishes its documented capabilities", () => {
  const model = MODEL_BY_SLUG.get("deepseek/deepseek-v4.1-flash");
  assert.ok(model);
  assert.equal(model.provider, "deepseek");
  assert.equal(model.upstreamModel, "deepseek-flash");
  assert.equal(model.listed, true);
  assert.equal(model.requestProfile, "deepseek-thinking");
  assert.equal(model.defaultEffort, "high");
  assert.deepEqual(model.reasoningLevels.map(({ effort }) => effort), ["low", "high", "max"]);
  assert.equal(model.contextWindow, 1_048_576);
  assert.ok(model.contextWindow - model.autoCompact >= MAX_EFFORT_DEFAULT_OUTPUT);
  assert.deepEqual(model.inputModalities, ["text", "image"]);
  assert.notEqual(model.multiAgentVersion, "v2");
  const published = routedModel({ slug: "gpt-5.5" }, model);
  assert.equal(published.display_name, "DeepSeek V4.1 Flash (API)");
  assert.deepEqual(published.input_modalities, ["text", "image"]);
});

test("DeepSeek V4.1 Flash on opencode Go uses the renamed Chat Completions id", () => {
  const model = MODEL_BY_SLUG.get("opencode-go/deepseek-v4.1-flash");
  assert.ok(model);
  assert.equal(model.provider, "opencode-go");
  assert.equal(model.upstreamModel, "deepseek-v4.1-flash");
  assert.equal(model.listed, true);
  assert.equal(model.requestProfile, "auto-tool-choice");
  assert.deepEqual(model.reasoningLevels.map(({ effort }) => effort), ["low", "high", "max"]);
  assert.equal(model.contextWindow, 1_000_000);
  assert.ok(model.contextWindow - model.autoCompact >= MAX_EFFORT_DEFAULT_OUTPUT);
  assert.deepEqual(model.inputModalities, ["text", "image"]);
  assert.notEqual(model.multiAgentVersion, "v2");
  assert.equal(curatedModelProviderId("opencode-go", "deepseek-v4.1-flash"), "opencode-go");
  assert.equal(curatedModelBlockReason("opencode-go", "deepseek-v4.1-flash"), undefined);
  // OpenCode deprecated the launch-day id within hours; it is not a route.
  assert.equal(MODEL_BY_SLUG.get("opencode-go/deepseek-flash"), undefined);
});

test("DeepSeek V4.1 Flash on the Nous Portal sizes to the served 262K window", () => {
  const model = MODEL_BY_SLUG.get("nousresearch/deepseek-v4.1-flash");
  assert.ok(model);
  assert.equal(model.provider, "nousresearch");
  assert.equal(model.upstreamModel, "deepseek/deepseek-v4.1-flash");
  assert.equal(model.listed, true);
  assert.deepEqual(model.reasoningLevels.map(({ effort }) => effort), ["low", "high", "max"]);
  // /v1/models advertises 1,048,576 but the serving provider caps at 262,144.
  assert.equal(model.contextWindow, 262_144);
  assert.ok(model.contextWindow - model.autoCompact >= MAX_EFFORT_DEFAULT_OUTPUT);
  assert.deepEqual(model.inputModalities, ["text", "image"]);
  assert.notEqual(model.multiAgentVersion, "v2");
});

test("DeepSeek V4.1 Flash on Command Code uses the Provider API chat route", () => {
  const model = MODEL_BY_SLUG.get("commandcode/deepseek-v4.1-flash");
  assert.ok(model);
  assert.equal(model.provider, "commandcode");
  assert.equal(model.upstreamModel, "deepseek/deepseek-v4.1-flash");
  assert.equal(model.listed, true);
  assert.deepEqual(model.reasoningLevels.map(({ effort }) => effort), ["low", "high", "max"]);
  assert.equal(model.contextWindow, 1_000_000);
  assert.ok(model.contextWindow - model.autoCompact >= MAX_EFFORT_DEFAULT_OUTPUT);
  // Image input is claimed only in marketing copy, not at the API.
  assert.deepEqual(model.inputModalities, ["text"]);
  assert.notEqual(model.multiAgentVersion, "v2");
  assert.equal(curatedModelProviderId("commandcode", "deepseek/deepseek-v4.1-flash"), "commandcode");
  assert.equal(curatedModelBlockReason("commandcode", "deepseek/deepseek-v4.1-flash"), undefined);
});

test("DeepSeek V4.1 Flash on OpenRouter takes the catalog window and DeepSeek's tool-choice limit", () => {
  const model = MODEL_BY_SLUG.get("openrouter/deepseek-v4.1-flash");
  assert.ok(model);
  assert.equal(model.provider, "openrouter");
  assert.equal(model.upstreamModel, "deepseek/deepseek-v4.1-flash");
  assert.equal(model.listed, true);
  // DeepSeek answers 400 to a forced tool choice in thinking mode, and its
  // endpoint is one of the hosts OpenRouter may pick for any request.
  assert.equal(model.requestProfile, "auto-tool-choice");
  assert.deepEqual(model.reasoningLevels.map(({ effort }) => effort), ["low", "high", "max"]);
  assert.equal(model.contextWindow, 1_048_576);
  assert.equal(model.autoCompact, 900_000);
  assert.ok(model.contextWindow - model.autoCompact >= MAX_EFFORT_DEFAULT_OUTPUT);
  assert.deepEqual(model.inputModalities, ["text", "image"]);
  assert.notEqual(model.multiAgentVersion, "v2");
  // A reseller route sits in its provider's band, not beside the direct API.
  assert.ok(model.priority > MODEL_BY_SLUG.get("deepseek/deepseek-v4.1-flash").priority);
});

test("DeepSeek V4.1 Flash on Ollama Cloud uses the cloud tag and the shared serving profile", () => {
  const model = MODEL_BY_SLUG.get("ollama-cloud/deepseek-v4.1-flash");
  assert.ok(model);
  assert.equal(model.provider, "ollama-cloud");
  // The library page publishes this as a cloud-only tag, the same shape every
  // other cloud-only route on this provider already carries.
  assert.equal(model.upstreamModel, "deepseek-v4.1-flash:cloud");
  assert.equal(model.listed, true);
  // Ollama serves the weights itself, so the DeepSeek API's thinking-mode
  // tool_choice rejection is not known to apply here. The V4 Flash sibling on
  // this provider carries the same plain profile; if a live request shows a
  // forced tool choice failing, both move to ollama-cloud-auto-tool-choice.
  assert.equal(model.requestProfile, "ollama-cloud");
  assert.equal(
    MODEL_BY_SLUG.get("ollama-cloud/deepseek-v4-flash").requestProfile,
    "ollama-cloud",
  );
  assert.equal(model.defaultEffort, "high");
  assert.deepEqual(model.reasoningLevels.map(({ effort }) => effort), ["low", "high", "max"]);
  assert.equal(model.contextWindow, 1_048_576);
  assert.equal(model.autoCompact, 900_000);
  assert.ok(model.contextWindow - model.autoCompact >= MAX_EFFORT_DEFAULT_OUTPUT);
  assert.deepEqual(model.inputModalities, ["text", "image"]);
  assert.notEqual(model.multiAgentVersion, "v2");
  // Appended after the V4 routes rather than displacing them in the picker.
  assert.ok(model.priority > MODEL_BY_SLUG.get("ollama-cloud/deepseek-v4-flash").priority);
});

test("V4.1 Flash is added alongside the V4 routes rather than replacing them", () => {
  for (const [slug, upstreamModel] of [
    ["deepseek/deepseek-v4-flash", "deepseek-v4-flash"],
    ["deepseek/deepseek-v4-flash-vision-exp", "deepseek-v4-flash-vision-exp"],
    ["deepseek/deepseek-v4-pro", "deepseek-v4-pro"],
    ["opencode-go/deepseek-v4-flash", "deepseek-v4-flash"],
    ["opencode-go/deepseek-v4-pro", "deepseek-v4-pro"],
    ["ollama-cloud/deepseek-v4-flash", "deepseek-v4-flash:cloud"],
    ["ollama-cloud/deepseek-v4-pro", "deepseek-v4-pro"],
  ]) {
    const model = MODEL_BY_SLUG.get(slug);
    assert.ok(model, slug);
    assert.equal(model.upstreamModel, upstreamModel);
    assert.equal(model.listed, true);
  }
});
