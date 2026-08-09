import assert from "node:assert/strict";
import test from "node:test";

import {
  AUTO_ANNOUNCE_WINDOW_MS,
  annotateNewModelAnnouncements,
  applyAllMultiAgent,
  buildMergedCatalog,
  buildLoginFreeCatalog,
  clampModelEfforts,
  codexEffortVocabulary,
  nativeCatalogIsReusable,
  promoteNativeMultiAgent,
  routedModel,
} from "../src/catalog.mjs";

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
  apply_patch_tool_type: "freeform",
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
  multiAgentVersion: "v2",
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
  assert.equal(model.multi_agent_version, "v2");
});

test("routed models are native v2 spawn-agent model overrides", () => {
  const model = routedModel(template, grok);
  assert.equal(model.visibility, "list");
  assert.equal(model.supported_in_api, true);
  assert.equal(model.multi_agent_version, "v2");
});

test("routed models advertise reasoning summaries only when the registry opts in", () => {
  // Default stays off: external models must not claim summary support untested.
  const plain = routedModel(template, grok);
  assert.equal(plain.supports_reasoning_summaries, false);
  assert.equal(plain.default_reasoning_summary, "none");
  const summarized = routedModel(template, {
    ...grok,
    supportsReasoningSummaries: true,
    defaultReasoningSummary: "auto",
  });
  assert.equal(summarized.supports_reasoning_summaries, true);
  assert.equal(summarized.default_reasoning_summary, "auto");
});

test("routed models advertise search and image detail only when the registry opts in", () => {
  // Defaults stay off: external models must not claim capabilities untested.
  const plain = routedModel(template, grok);
  assert.equal(plain.supports_search_tool, false);
  assert.equal(plain.supports_image_detail_original, false);
  const capable = routedModel(template, {
    ...grok,
    searchTool: { mode: "hosted" },
    supportsImageDetailOriginal: true,
  });
  assert.equal(capable.supports_search_tool, true);
  assert.equal(capable.supports_image_detail_original, true);
});

test("routed models inherit apply_patch unless the registry opts out", () => {
  const plain = routedModel(template, grok);
  assert.equal(plain.apply_patch_tool_type, "freeform");
  const noPatch = routedModel(template, {
    ...grok,
    supportsApplyPatchTool: false,
  });
  assert.equal(noPatch.apply_patch_tool_type, null);
});

test("routed models announce availability only when curated with NUX copy", () => {
  // Default stays null: an empty announcement card must never render.
  const plain = routedModel(template, grok);
  assert.equal(plain.availability_nux, null);
  const announced = routedModel(template, {
    ...grok,
    availabilityNux: "  Grok 4.5 now routes through your own X subscription.  ",
  });
  assert.deepEqual(announced.availability_nux, {
    message: "Grok 4.5 now routes through your own X subscription.",
  });
});

test("first capture seeds announcement state without announcing anything", () => {
  const { models, announcedAt } = annotateNewModelAnnouncements([grok], null, new Set(), 1000);
  assert.equal(models[0].availabilityNux, undefined);
  assert.equal(announcedAt.get(grok.slug), 0);
});

test("models new since the last capture announce for a window, then go quiet", () => {
  const seeded = new Map([["kimi-oauth/k3", 0]]);
  const now = 5000;
  const { models, announcedAt } = annotateNewModelAnnouncements([grok], seeded, new Set(), now);
  assert.equal(
    models[0].availabilityNux,
    "Grok 4.5 (OAuth) just landed in your model picker. It comes with a 500K-token context window and image input.",
  );
  assert.equal(announcedAt.get(grok.slug), now);
  // Within the window the copy persists across rebuilds; after it, silence.
  const later = annotateNewModelAnnouncements([grok], announcedAt, new Set(), now + 1);
  assert.ok(later.models[0].availabilityNux);
  const expired = annotateNewModelAnnouncements(
    [grok],
    announcedAt,
    new Set(),
    now + AUTO_ANNOUNCE_WINDOW_MS,
  );
  assert.equal(expired.models[0].availabilityNux, undefined);
  assert.equal(expired.announcedAt.get(grok.slug), now);
});

test("curated copy and locally curated models are left alone by auto-announce", () => {
  const seeded = new Map();
  const curated = { ...grok, availabilityNux: "Hand-written copy." };
  const { models } = annotateNewModelAnnouncements([curated], seeded, new Set(), 1000);
  assert.equal(models[0].availabilityNux, "Hand-written copy.");
  const userModel = { ...grok, slug: "deepseek/user-added" };
  const skipped = annotateNewModelAnnouncements(
    [userModel],
    seeded,
    new Set(["deepseek/user-added"]),
    1000,
  );
  assert.equal(skipped.models[0].availabilityNux, undefined);
});

test("routed models carry a migration prompt only when curated with upgradeTo", () => {
  const plain = routedModel(template, grok);
  assert.equal(plain.upgrade, null);
  const upgraded = routedModel(template, {
    ...grok,
    upgradeTo: {
      model: "kimi-oauth/k3",
      markdown: "# Introducing Kimi K3\n\nSwitch from {model_from} to {model_to}.\n",
    },
  });
  assert.deepEqual(upgraded.upgrade, {
    model: "kimi-oauth/k3",
    migration_markdown: "# Introducing Kimi K3\n\nSwitch from {model_from} to {model_to}.",
  });
});

test("unverified routed models retain conservative v1 collaboration", () => {
  const model = routedModel(template, {
    ...grok,
    slug: "example/model",
    multiAgentVersion: undefined,
  });
  assert.equal(model.multi_agent_version, "v1");
});

test("all-models multi-agent mode promotes every selected model to v2", () => {
  const models = [
    { slug: "opencode-go/deepseek-v4-flash" },
    { slug: "qwen-plan/qwen3.8-max", multiAgentVersion: "v1" },
  ];
  const promoted = applyAllMultiAgent(models, true);
  assert.deepEqual(
    promoted.map((model) => model.multiAgentVersion),
    ["v2", "v2"],
  );
  assert.equal(applyAllMultiAgent(models, false), models);
});

test("merged catalog preserves native GPT identity while rewriting routed models", () => {
  const merged = buildMergedCatalog({ models: [template] }, [grok]);
  const bySlug = new Map(merged.map((model) => [model.slug, model]));
  assert.match(bySlug.get("gpt-5.5").base_instructions, /based on GPT-5/);
  assert.equal(bySlug.get("gpt-5.5").supports_reasoning_summaries, false);
  assert.match(bySlug.get("grok-oauth/grok-4.5").base_instructions, /based on Grok 4\.5/);
  assert.doesNotMatch(bySlug.get("grok-oauth/grok-4.5").base_instructions, /GPT-5/);
});

test("merged catalog preserves an explicit native reasoning summary capability", () => {
  const native = {
    ...template,
    supports_reasoning_summaries: true,
  };
  const merged = buildMergedCatalog({ models: [native] }, []);
  assert.equal(merged[0].supports_reasoning_summaries, true);
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

test("effort vocabulary follows the installed codex build's enum history", () => {
  // max and ultra joined the enum in 0.143.0.
  const legacy = codexEffortVocabulary("codex-cli 0.142.5");
  assert.deepEqual(
    [...legacy].sort(),
    ["high", "low", "medium", "minimal", "xhigh"],
  );
  assert.ok(codexEffortVocabulary("codex-cli 0.143.0").has("max"));
  assert.ok(codexEffortVocabulary("codex-cli 0.147.0-alpha.1.2").has("ultra"));
  // A prerelease of the boundary build may predate the variants, and an
  // unknown version must clamp rather than risk an unparseable picker level.
  assert.ok(!codexEffortVocabulary("codex-cli 0.143.0-alpha.3").has("max"));
  assert.ok(!codexEffortVocabulary(undefined).has("max"));
});

test("efforts the installed codex build cannot parse clamp to the nearest supported tier", () => {
  const vocabulary = codexEffortVocabulary("codex-cli 0.141.0");
  const [deepseek] = clampModelEfforts(
    [
      {
        ...grok,
        defaultEffort: "max",
        reasoningLevels: [
          { effort: "low", description: "Faster reasoning" },
          { effort: "high", description: "Deep reasoning" },
          { effort: "max", description: "Maximum reasoning" },
        ],
      },
    ],
    vocabulary,
  );
  // Codex 0.141 drops unknown enum variants, so "max" must reach it as xhigh
  // (issue #57); the forwarder already folds xhigh back to the upstream max.
  assert.deepEqual(deepseek.reasoningLevels, [
    { effort: "low", description: "Faster reasoning" },
    { effort: "high", description: "Deep reasoning" },
    { effort: "xhigh", description: "Maximum reasoning" },
  ]);
  assert.equal(deepseek.defaultEffort, "xhigh");
});

test("clamped duplicates collapse onto the model's genuine entry for that tier", () => {
  const vocabulary = codexEffortVocabulary("codex-cli 0.141.0");
  const [opus] = clampModelEfforts(
    [
      {
        ...grok,
        defaultEffort: "max",
        reasoningLevels: [
          { effort: "xhigh", description: "Extended reasoning" },
          { effort: "max", description: "Maximum reasoning" },
        ],
      },
    ],
    vocabulary,
  );
  assert.deepEqual(opus.reasoningLevels, [
    { effort: "xhigh", description: "Extended reasoning" },
  ]);
  assert.equal(opus.defaultEffort, "xhigh");
});

test("models stay untouched when the installed build understands their efforts", () => {
  const vocabulary = codexEffortVocabulary("codex-cli 0.146.1");
  const original = {
    ...grok,
    defaultEffort: "max",
    reasoningLevels: [
      { effort: "high", description: "Deep reasoning" },
      { effort: "max", description: "Maximum reasoning" },
    ],
  };
  const [unchanged] = clampModelEfforts([original], vocabulary);
  assert.equal(unchanged, original);
});

test("native catalog cache is reusable only for the codex build that captured it", () => {
  const captured = { captured_with: "codex-cli 0.142.5", models: [template] };

  assert.equal(nativeCatalogIsReusable(captured, "codex-cli 0.142.5"), true);
  assert.equal(nativeCatalogIsReusable(captured, "codex-cli 0.146.1"), false);
  // Unknown current version: no binary to re-ask, so keep what we have.
  assert.equal(nativeCatalogIsReusable(captured, undefined), true);
  // Un-stamped caches predate version tracking; re-capture when we can ask.
  assert.equal(nativeCatalogIsReusable({ models: [template] }, "codex-cli 0.146.1"), false);
  assert.equal(nativeCatalogIsReusable({ models: [template] }, undefined), true);
  // Invalid or empty caches are never reusable.
  assert.equal(nativeCatalogIsReusable(undefined, undefined), false);
  assert.equal(nativeCatalogIsReusable({ models: [] }, "codex-cli 0.146.1"), false);
});

test("native listed models follow the local subagent opt-in", () => {
  // Upstream still ships gpt-5.6-luna as v1 while it runs fine on the v2
  // backend, and spawn_agent filters child models on that static value.
  const native = [
    { slug: "gpt-5.6-terra", visibility: "list", multi_agent_version: "v2" },
    { slug: "gpt-5.6-luna", visibility: "list", multi_agent_version: "v1" },
    { slug: "codex-auto-review", visibility: "hide", multi_agent_version: "v1" },
  ];
  const promoted = promoteNativeMultiAgent(native, {
    mode: "all",
    enabled: [],
    disabled: [],
  });
  assert.equal(promoted[1].multi_agent_version, "v2");
  // Hidden native entries are never advertised as spawn targets.
  assert.equal(promoted[2].multi_agent_version, "v1");
});

test("native promotion honours disabled models and picker-hidden slugs", () => {
  const native = [
    { slug: "gpt-5.6-luna", visibility: "list", multi_agent_version: "v1" },
    { slug: "gpt-5.5", visibility: "list", multi_agent_version: "v1" },
  ];
  const promoted = promoteNativeMultiAgent(
    native,
    { mode: "all", enabled: [], disabled: ["gpt-5.6-luna"] },
    new Set(["gpt-5.5"]),
  );
  assert.equal(promoted[0].multi_agent_version, "v1");
  assert.equal(promoted[1].multi_agent_version, "v1");
});

test("selected subagent mode only promotes the chosen native models", () => {
  const native = [
    { slug: "gpt-5.6-luna", visibility: "list", multi_agent_version: "v1" },
    { slug: "gpt-5.4", visibility: "list", multi_agent_version: "v1" },
  ];
  const promoted = promoteNativeMultiAgent(native, {
    mode: "selected",
    enabled: ["gpt-5.6-luna"],
    disabled: [],
  });
  assert.equal(promoted[0].multi_agent_version, "v2");
  assert.equal(promoted[1].multi_agent_version, "v1");
});

test("proven subagent mode leaves the native catalog untouched", () => {
  const native = [{ slug: "gpt-5.6-luna", visibility: "list", multi_agent_version: "v1" }];
  const promoted = promoteNativeMultiAgent(native, {
    mode: "proven",
    enabled: [],
    disabled: [],
  });
  assert.deepEqual(promoted, native);
});

test("a ChatGPT-plan model drives the same advertisement as a routed engine", async () => {
  const { applyVisionBridge, nativeVisionCandidates, resolveVisionEngine } = await import(
    "../src/vision-bridge.mjs"
  );
  const deepseek = {
    ...grok,
    slug: "deepseek/deepseek-v4-flash",
    displayName: "DeepSeek V4 Flash",
    gatewayModel: "deepseek-v4-flash",
    inputModalities: ["text"],
    compHash: "deepseek-v4-flash-native-bridge-v1",
  };
  // The native capture is snake_case, the registry is camelCase, and both have
  // to reach the same advertisement rule.
  const capture = [
    {
      slug: "gpt-5.6-luna",
      display_name: "GPT-5.6-Luna",
      visibility: "list",
      priority: 3,
      input_modalities: ["text", "image"],
    },
  ];

  const engine = resolveVisionEngine(() => nativeVisionCandidates(capture), {
    enabled: true,
    engine: "gpt-5.6-luna",
  });
  const [bridged] = applyVisionBridge([deepseek], engine);
  assert.deepEqual(routedModel(template, bridged).input_modalities, ["text", "image"]);

  // A model the operator took out of the picker is not theirs to spend, so it
  // cannot resolve, and the advertisement goes with it.
  const hidden = resolveVisionEngine(
    () => nativeVisionCandidates(capture, new Set(["gpt-5.6-luna"])),
    { enabled: true, engine: "gpt-5.6-luna" },
  );
  assert.equal(hidden, undefined);
  assert.deepEqual(
    routedModel(template, applyVisionBridge([deepseek], hidden)[0]).input_modalities,
    ["text"],
  );
});

test("a bridged text-only model advertises image input, and only through the bridge", async () => {
  const { applyVisionBridge } = await import("../src/vision-bridge.mjs");
  const deepseek = {
    ...grok,
    slug: "deepseek/deepseek-v4-pro",
    displayName: "DeepSeek V4 Pro",
    gatewayModel: "deepseek-v4-pro",
    inputModalities: ["text"],
    compHash: "deepseek-v4-pro-v1",
  };

  // Off, or with no engine to read images with, the catalog repeats the
  // registry's honest declaration and Codex refuses the paste.
  assert.deepEqual(routedModel(template, deepseek).input_modalities, ["text"]);

  const [bridged] = applyVisionBridge([deepseek], grok);
  const entry = routedModel(template, bridged);
  assert.deepEqual(entry.input_modalities, ["text", "image"]);
  // The bridge is router state, not a picker field: nothing about the engine
  // leaks into what Codex reads.
  assert.equal(entry.visionBridgeEngine, undefined);
  // Advertising image input is not a claim about detail handling.
  assert.equal(entry.supports_image_detail_original, false);
});
