import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

// These assertions describe the checked-in registry, so the machine's own
// curated models must not leak in.
const testRoot = mkdtempSync(path.join(os.tmpdir(), "grok-4-7-test-"));
process.env.MODEL_ROUTER_USER_MODELS = path.join(testRoot, "user-models.json");
process.env.MODEL_ROUTER_STATE_DIR = path.join(testRoot, "state");

const { MODEL_BY_SLUG } = await import("../src/model-registry.mjs");
const {
  isGrokOauthAgenticRoute,
  isGrokOauthAgenticModel,
} = await import("../src/grok-oauth-routes.mjs");
const { shouldAliasViewImageForGrok } = await import("../src/grok-oauth-tool-alias.mjs");
const { shouldGuideGrokApplyPatch } = await import("../src/grok-apply-patch-guidance.mjs");
const { grokOauthIngressContextBytes } = await import("../src/request-diagnostics.mjs");

// Grok 4.7 is shipped through six providers. Each names the model differently
// and their catalogs vary, so these assertions keep the checked-in pins from
// drifting away from what each provider actually publishes.
const ROUTES = [
  ["commandcode/grok-4.7", "xai/grok-4.7"],
  ["grok-api/grok-4.7", "grok-4.7"],
  ["grok-oauth/grok-4.7", "grok-4.7"],
  ["nousresearch/grok-4.7", "x-ai/grok-4.7"],
  ["opencode-go-responses/grok-4.7", "grok-4.7"],
  ["openrouter/grok-4.7", "x-ai/grok-4.7"],
];

test("every Grok 4.7 route records the upstream id and window", () => {
  for (const [slug, upstreamModel] of ROUTES) {
    const model = MODEL_BY_SLUG.get(slug);
    assert.ok(model, `${slug} is missing from the registry`);
    assert.equal(model.upstreamModel, upstreamModel);
    assert.equal(model.listed, true);
    // xAI documents a 500,000-token window for grok-4.7.
    assert.equal(model.contextWindow, 500_000, slug);
    // autoCompact sits below the hard limit.
    assert.ok(model.autoCompact >= 440_000 && model.autoCompact <= 450_000, slug);
    assert.equal(model.defaultEffort, "high", slug);
  }
});

test("Grok 4.7 reasoning ladders match each catalog, not the family name", () => {
  // xAI documents low/medium/high/xhigh, and every route whose own catalog or
  // documentation says it forwards an effort carries the same four rungs.
  // OpenRouter is in this group on its own evidence: its reasoning docs list
  // xhigh in the accepted vocabulary and map an unsupported rung down rather
  // than rejecting it, and its /models record for x-ai/grok-4.7 advertises
  // `reasoning_effort` in supported_parameters.
  for (const slug of [
    "grok-api/grok-4.7",
    "grok-oauth/grok-4.7",
    "nousresearch/grok-4.7",
    "opencode-go-responses/grok-4.7",
    "openrouter/grok-4.7",
  ]) {
    assert.deepEqual(
      MODEL_BY_SLUG.get(slug).reasoningLevels.map((level) => level.effort),
      ["low", "medium", "high", "xhigh"],
      slug,
    );
  }

  // Command Code publishes no parameter metadata for its Grok route, so it
  // keeps the conservative ladder rather than inheriting xAI's through a
  // reseller that has not said it forwards the field. A rung is per route.
  for (const slug of ["commandcode/grok-4.7"]) {
    assert.deepEqual(
      MODEL_BY_SLUG.get(slug).reasoningLevels.map((level) => level.effort),
      ["low", "medium", "high"],
      slug,
    );
  }
});

test("Grok 4.7 carries no subagent or upgrade claim it has not earned", () => {
  for (const [slug] of ROUTES) {
    const model = MODEL_BY_SLUG.get(slug);
    // v2 needs an accepted v2_agent/ artifact in the same pull request, and
    // the certified grok-4.5 routes do not lend their proof to a new model.
    assert.equal(model.multiAgentVersion, undefined, slug);
    assert.equal(model.upgradeTo, undefined, slug);
  }
  // The Fast tier is a grok-oauth/grok-4.6 capability that has not been shown
  // on 4.7, so the newer route must not inherit it by being in the family.
  assert.equal(MODEL_BY_SLUG.get("grok-oauth/grok-4.7").serviceTiers, undefined);
});

test("the agentic grok-oauth workarounds cover 4.7 and stop at the provider edge", () => {
  for (const slug of ["grok-oauth/grok-4.6", "grok-oauth/grok-4.7"]) {
    assert.equal(isGrokOauthAgenticRoute({ slug }), true, slug);
    assert.equal(shouldGuideGrokApplyPatch({ slug }), true, slug);
    assert.ok(grokOauthIngressContextBytes({ input: [] }, { slug }), slug);
  }

  // grok-4.5 predates these adaptations, and a reseller's Grok is a different
  // upstream path: neither may pick them up from the shared list.
  for (const slug of ["grok-oauth/grok-4.5", "openrouter/grok-4.7", "commandcode/grok-4.7"]) {
    assert.equal(isGrokOauthAgenticRoute({ slug }), false, slug);
    assert.equal(shouldGuideGrokApplyPatch({ slug }), false, slug);
    assert.equal(grokOauthIngressContextBytes({ input: [] }, { slug }), undefined, slug);
  }
});

test("the view_image alias follows the upstream model id the forwarder receives", () => {
  const tools = [{ type: "function", function: { name: "view_image" } }];
  assert.equal(isGrokOauthAgenticModel("grok-4.7"), true);
  assert.equal(shouldAliasViewImageForGrok({ model: "grok-4.7", tools }), true);
  assert.equal(shouldAliasViewImageForGrok({ model: "grok-4.6", tools }), true);
  assert.equal(shouldAliasViewImageForGrok({ model: "grok-4.5", tools }), false);
});
