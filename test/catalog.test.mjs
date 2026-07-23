import assert from "node:assert/strict";
import test from "node:test";

import { buildMergedCatalog, buildLoginFreeCatalog, routedModel } from "../src/catalog.mjs";

const template = {
  slug: "gpt-5.5",
  display_name: "GPT-5.5",
  description: "Native template",
  priority: 10,
  visibility: "list",
  base_instructions:
    "You are Codex, a coding agent based on GPT-5. You and the user share one workspace.",
  model_messages: {
    instructions_template:
      "You are Codex, a coding agent based on GPT-5. {{ personality }}",
    instructions_variables: {
      personality_default: "",
    },
  },
};

const grok = {
  slug: "grok-oauth/grok-4.5",
  displayName: "Grok 4.5 (OAuth)",
  description: "Grok through OAuth",
  priority: 1,
  defaultEffort: "high",
  reasoningLevels: [{ effort: "high", description: "Deep reasoning" }],
  contextWindow: 500000,
  autoCompact: 440000,
  inputModalities: ["text", "image"],
  compHash: "grok-oauth-grok-4-5-v1",
};

test("routed models rewrite GPT identity text to the external model name", () => {
  const model = routedModel(template, grok);
  assert.equal(model.slug, "grok-oauth/grok-4.5");
  assert.equal(model.display_name, "Grok 4.5 (OAuth)");
  assert.match(model.base_instructions, /based on Grok 4\.5/);
  assert.doesNotMatch(model.base_instructions, /GPT-5/);
  assert.match(model.model_messages.instructions_template, /based on Grok 4\.5/);
  assert.doesNotMatch(model.model_messages.instructions_template, /GPT-5/);
  assert.equal(model.model_messages.instructions_variables.personality_default, "");
});

test("merged catalog preserves native GPT identity while rewriting routed models", () => {
  const merged = buildMergedCatalog({ models: [template] }, [grok]);
  const bySlug = new Map(merged.map((model) => [model.slug, model]));
  assert.match(bySlug.get("gpt-5.5").base_instructions, /based on GPT-5/);
  assert.match(bySlug.get("grok-oauth/grok-4.5").base_instructions, /based on Grok 4\.5/);
  assert.doesNotMatch(bySlug.get("grok-oauth/grok-4.5").base_instructions, /GPT-5/);
});

test("login-free catalogs contain only authenticated external models", () => {
  const merged = buildMergedCatalog({ models: [template] }, [grok], {
    includeNative: false,
  });
  assert.deepEqual(merged.map((model) => model.slug), ["grok-oauth/grok-4.5"]);
});

test("login-free catalog republishes external models under native slugs", () => {
  const kimi = {
    ...grok,
    slug: "kimi-oauth/k3",
    displayName: "Kimi K3 (OAuth)",
    priority: 2,
    compHash: "kimi-oauth-k3-v1",
  };
  const secondNative = {
    ...template,
    slug: "gpt-5.4",
    display_name: "GPT-5.4",
    priority: 20,
  };
  const { models, aliases } = buildLoginFreeCatalog(
    { models: [secondNative, template] },
    [grok, kimi],
  );

  assert.deepEqual(aliases, {
    "gpt-5.5": "grok-oauth/grok-4.5",
    "gpt-5.4": "kimi-oauth/k3",
  });

  const bySlug = new Map(models.map((model) => [model.slug, model]));
  assert.equal(bySlug.get("gpt-5.5").display_name, "Grok 4.5 (OAuth)");
  assert.equal(bySlug.get("gpt-5.5").visibility, "list");
  assert.equal(bySlug.get("gpt-5.5").priority, 10);
  assert.match(bySlug.get("gpt-5.5").base_instructions, /based on Grok 4\.5/);
  assert.equal(bySlug.get("gpt-5.4").display_name, "Kimi K3 (OAuth)");
  assert.equal(bySlug.get("grok-oauth/grok-4.5").visibility, "hide");
  assert.equal(bySlug.get("kimi-oauth/k3").visibility, "hide");
});

test("login-free catalog keeps overflow models visible under their own slugs", () => {
  const overflow = {
    ...grok,
    slug: "kimi-oauth/kimi-for-coding",
    displayName: "K2.7 Coding (OAuth)",
    priority: 3,
    compHash: "kimi-oauth-kimi-for-coding-v1",
  };
  const { models, aliases } = buildLoginFreeCatalog(
    { models: [template] },
    [grok, overflow],
  );

  assert.deepEqual(aliases, { "gpt-5.5": "grok-oauth/grok-4.5" });
  const bySlug = new Map(models.map((model) => [model.slug, model]));
  assert.equal(bySlug.get("kimi-oauth/kimi-for-coding").visibility, "list");
  assert.equal(bySlug.get("grok-oauth/grok-4.5").visibility, "hide");
});
