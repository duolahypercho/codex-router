import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  AUTO_ANNOUNCE_WINDOW_MS,
  annotateNewModelAnnouncements,
  buildMergedCatalog,
  buildLoginFreeCatalog,
  clampModelEfforts,
  codexEffortVocabulary,
  effectivePickerHiddenModels,
  liveAccountCatalogProbeAllowed,
  nativeCacheCanRefreshInPlace,
  nativeCatalogIsReusable,
  deriveBaseInstructions,
  mergeNativeCatalogs,
  mergeNativeModel,
  nativeSubagentCertification,
  promoteNativeMultiAgent,
  routedCatalogConfigured,
  routedModel,
} from "../src/catalog.mjs";
import { sidecarSearchAvailable } from "../src/search-capability.mjs";

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
  default_service_tier: "priority",
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

test("live account catalog probes stay off while the router owns the catalog", () => {
  assert.equal(
    liveAccountCatalogProbeAllowed({ discoveryDisabled: false, routedCatalogActive: false }),
    true,
  );
  assert.equal(
    liveAccountCatalogProbeAllowed({ discoveryDisabled: true, routedCatalogActive: false }),
    false,
  );
  assert.equal(
    liveAccountCatalogProbeAllowed({ discoveryDisabled: false, routedCatalogActive: true }),
    false,
  );
  // ChatGPT account switching refreshes native while openai_base_url still
  // points at this router. A live `debug models` probe would echo the merged
  // catalog and abort the switch with "already-merged catalog".
  assert.equal(
    liveAccountCatalogProbeAllowed({ discoveryDisabled: false, routedCatalogActive: true }),
    false,
  );
});

test("native capture refuses to probe a live account catalog under a routed config", () => {
  const source = readFileSync(new URL("../src/catalog.mjs", import.meta.url), "utf8");
  assert.match(
    source,
    /liveAccountCatalogProbeAllowed\(\{\s*discoveryDisabled: idle,\s*routedCatalogActive: routedActive,\s*\}\)/,
  );
  assert.match(source, /catalogContainsRoutedSlugs\(account\)/);
  assert.match(
    source,
    /Could not refresh the native model catalog \(\$\{error\.message\}\); reusing the cached capture\./,
  );
});

test("signed-in picker overlay cannot hide Codex native base entries", () => {
  const hidden = new Set(["gpt-5.6-luna", "gpt-5.6-sol-1m", "grok-oauth/grok-4.5"]);
  const native = new Set(["gpt-5.6-luna", "gpt-5.6-sol"]);
  assert.deepEqual(
    [...effectivePickerHiddenModels(hidden, native)].sort(),
    ["gpt-5.6-sol-1m", "grok-oauth/grok-4.5"],
  );
  // Login-free aliases deliberately reuse native slugs, so the router policy
  // applies to every entry in that mode.
  assert.deepEqual(
    [...effectivePickerHiddenModels(hidden, native, { loginFree: true })].sort(),
    [...hidden].sort(),
  );
});

test("routed catalog is exposed only when the active provider reaches the router", () => {
  // An absent base URL is the first-install case: setup has not written the
  // caller capability yet, but the catalog still needs to be buildable.
  assert.equal(routedCatalogConfigured(""), true);
  assert.equal(routedCatalogConfigured('model_provider = "openai"\n'), true);
  assert.equal(
    routedCatalogConfigured('openai_base_url = "https://foreign.invalid/v1"\n'),
    false,
  );
  assert.equal(
    routedCatalogConfigured(`model_provider = "openai"
openai_base_url = "https://foreign.invalid/v1"
`),
    false,
  );
  assert.equal(
    routedCatalogConfigured(`model_provider = "openai"
openai_base_url = "http://127.0.0.1:4102/_codex-router/test-caller-secret-with-sufficient-length/v1"
`),
    true,
  );
  assert.equal(
    routedCatalogConfigured(`model_provider = "openai"
openai_base_url = "http://127.0.0.1:4202/v1"
`),
    true,
  );
  assert.equal(
    routedCatalogConfigured(`model_provider = "openai"
note = """
[fake.table]
"""
openai_base_url = "https://foreign.invalid/v1"
`),
    false,
  );
  assert.equal(
    routedCatalogConfigured(`model_provider = "openai"
note = '''
[fake.table]
'''
openai_base_url = "https://foreign.invalid/v1"
`),
    false,
  );
  assert.equal(routedCatalogConfigured('model_provider = "custom"\n'), false);
  assert.equal(
    routedCatalogConfigured(`model_provider = "custom"

[model_providers.custom]
base_url = "http://127.0.0.1:4102/_codex-router/test-caller-secret-with-sufficient-length/v1"
wire_api = "responses"
`),
    true,
  );
  assert.equal(
    routedCatalogConfigured(`model_provider = "custom"

[model_providers.custom]
base_url = "http://127.0.0.1:4202/v1"
wire_api = "responses"
`),
    true,
  );
  assert.equal(
    routedCatalogConfigured(`model_provider = "custom"
note = """
[model_providers.custom]
base_url = "http://127.0.0.1:4102/_codex-router/test-caller-secret-with-sufficient-length/v1"
"""

[model_providers.custom]
base_url = "https://foreign.invalid/v1"
wire_api = "responses"
`),
    false,
  );
  assert.equal(
    routedCatalogConfigured(`model_provider = "custom]id"

[model_providers."custom]id"]
base_url = "http://127.0.0.1:4102/_codex-router/test-caller-secret-with-sufficient-length/v1"
wire_api = "responses"
`),
    true,
  );
  assert.equal(
    routedCatalogConfigured(`model_provider = "openai"
note = """
[fake.table]
`),
    false,
  );
  assert.equal(routedCatalogConfigured('model_provider = "custom"\n', "1"), true);
  assert.equal(routedCatalogConfigured('model_provider = "custom"\n', "0"), false);
});

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

test("routed models can borrow native behavior instructions without inheriting capabilities", () => {
  const behaviorTemplate = {
    ...template,
    slug: "gpt-5.6-sol",
    base_instructions: "You are Codex, an agent based on GPT-5. SOL_BEHAVIOR",
    model_messages: {
      instructions_template: "You are Codex, an agent based on GPT-5. SOL_TEMPLATE {{ personality }}",
      instructions_variables: { personality_default: "" },
    },
    tool_mode: "code_mode_only",
    use_responses_lite: true,
  };
  const model = routedModel(template, { ...grok, behaviorTemplate: "gpt-5.6-sol" }, behaviorTemplate);

  assert.match(model.base_instructions, /based on Grok 4\.5/);
  assert.match(model.base_instructions, /SOL_BEHAVIOR/);
  assert.match(model.model_messages.instructions_template, /SOL_TEMPLATE/);
  assert.equal(model.tool_mode, undefined);
  assert.equal(model.use_responses_lite, false);
});

test("routed behavior identity rewriting consumes versioned native GPT names", () => {
  const behaviorTemplate = {
    ...template,
    base_instructions: "You are Codex, an agent based on GPT-5.6-Sol.",
    model_messages: {
      instructions_template: "You are Codex, an agent based on GPT-5.6-Sol.",
    },
  };
  const model = routedModel(template, grok, behaviorTemplate);

  assert.match(model.base_instructions, /based on Grok 4\.5\./);
  assert.doesNotMatch(model.base_instructions, /GPT-5/);
  assert.doesNotMatch(model.base_instructions, /Grok 4\.5\.6-Sol/);
  assert.match(model.model_messages.instructions_template, /based on Grok 4\.5\./);
  assert.doesNotMatch(model.model_messages.instructions_template, /GPT-5/);
});

test("routed models can opt into a concise execution overlay", () => {
  const model = routedModel(template, {
    ...grok,
    instructionOverlay: "efficient-agentic",
  });
  const plain = routedModel(template, grok);

  assert.match(model.base_instructions, /Routed execution discipline/);
  assert.match(model.base_instructions, /without narrating each routine tool step/);
  assert.match(model.model_messages.instructions_template, /Routed execution discipline/);
  assert.doesNotMatch(plain.base_instructions, /Routed execution discipline/);
});

test("efficient routed execution keeps persistent tool output bounded", () => {
  const model = routedModel(template, { ...grok, instructionOverlay: "efficient-agentic" });
  assert.match(model.base_instructions, /minimum sufficient tool output/i);
  assert.match(model.base_instructions, /large file/i);
  assert.match(model.base_instructions, /bounded sections/i);
});

test("efficient routed execution keeps secret-bearing CLI output out of history", () => {
  const model = routedModel(template, { ...grok, instructionOverlay: "efficient-agentic" });
  assert.match(model.base_instructions, /credentials/i);
  assert.match(model.base_instructions, /capture.*output/i);
  assert.match(model.base_instructions, /safe fields/i);
});

test("efficient routed execution preflights unfamiliar command and test APIs", () => {
  const model = routedModel(template, { ...grok, instructionOverlay: "efficient-agentic" });
  assert.match(model.base_instructions, /unfamiliar.*CLI.*test API/i);
  assert.match(model.base_instructions, /help.*signatures.*documentation/i);
});

test("efficient routed execution avoids fragile Windows nested quoting", () => {
  const model = routedModel(template, { ...grok, instructionOverlay: "efficient-agentic" });
  assert.match(model.base_instructions, /Windows/i);
  assert.match(model.base_instructions, /PowerShell.*SQL.*JSON/i);
  assert.match(model.base_instructions, /here-string.*temporary script/i);
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

test("ClinePass routed models omit the unsupported reasoning-effort selector", () => {
  const clinepass = routedModel(template, { ...grok, requestProfile: "clinepass" });
  assert.equal("default_reasoning_level" in clinepass, false);
  assert.equal("supported_reasoning_levels" in clinepass, false);

  const normal = routedModel(template, grok);
  assert.equal(normal.default_reasoning_level, "high");
  assert.deepEqual(normal.supported_reasoning_levels, grok.reasoningLevels);
});

test("current Codex search contract distinguishes supported and unsupported routed models", () => {
  // The managed provider opts in globally, while this catalog field is the
  // second, per-model gate Codex requires before it exposes standalone search.
  const plain = routedModel(template, grok);
  assert.equal(plain.supports_search_tool, false);
  const hosted = routedModel(template, {
    ...grok,
    searchTool: { mode: "hosted" },
  });
  assert.equal(hosted.supports_search_tool, true);
  const standalone = routedModel(template, {
    ...grok,
    searchTool: { mode: "standalone" },
  });
  assert.equal(standalone.supports_search_tool, true);
});

test("search sidecars advertise only an exact ready model and trusted generic provider", () => {
  const sidecarProvider = {
    id: "perplexity-sidecar",
    generic: true,
    enabled: true,
    adapter: "openai-chat",
    allowPrivate: false,
    credentialRef: "cred_perplexity_sidecar_01",
    baseUrl: "https://api.perplexity.ai",
  };
  const options = {
    bindingForModel: (slug) => slug === grok.slug
      ? { model: slug, providerId: sidecarProvider.id, enabled: true }
      : undefined,
    providers: new Map([[sidecarProvider.id, sidecarProvider]]),
    providerReady: () => true,
  };
  assert.equal(sidecarSearchAvailable(grok, options), true);
  assert.equal(sidecarSearchAvailable({ ...grok, slug: "grok-oauth/other" }, options), false);
  assert.equal(sidecarSearchAvailable({ ...grok, searchTool: { mode: "hosted" } }, options), false);
  assert.equal(sidecarSearchAvailable(grok, { ...options, providerReady: () => false }), false);
  assert.equal(sidecarSearchAvailable(grok, {
    ...options,
    providers: new Map([[sidecarProvider.id, { ...sidecarProvider, allowPrivate: true }]]),
  }), false);
  assert.equal(sidecarSearchAvailable(grok, {
    ...options,
    providers: new Map([[sidecarProvider.id, {
      ...sidecarProvider,
      baseUrl: "https://api.perplexity.ai.attacker.example",
    }]]),
  }), false);
});

test("routed models advertise original image detail only when the registry opts in", () => {
  const plain = routedModel(template, grok);
  assert.equal(plain.supports_image_detail_original, false);
  const capable = routedModel(template, {
    ...grok,
    supportsImageDetailOriginal: true,
  });
  assert.equal(capable.supports_image_detail_original, true);
});

test("routed models can explicitly narrow inherited tool capabilities", () => {
  const plain = routedModel(template, grok);
  assert.equal(plain.supports_parallel_tool_calls, false);
  assert.equal("experimental_supported_tools" in plain, false);

  const narrowed = routedModel(template, {
    ...grok,
    supportsParallelToolCalls: false,
    experimentalSupportedTools: [],
  });
  assert.equal(narrowed.supports_parallel_tool_calls, false);
  assert.deepEqual(narrowed.experimental_supported_tools, []);
});

test("routed service tiers are explicit and never inherit a paid default", () => {
  const plain = routedModel(template, grok);
  assert.deepEqual(plain.service_tiers, []);
  assert.equal(plain.default_service_tier, null);

  const tiered = routedModel(template, {
    ...grok,
    serviceTiers: [
      { id: " priority ", name: " Fast ", description: " Guaranteed throughput. " },
    ],
  });
  assert.deepEqual(tiered.service_tiers, [
    { id: "priority", name: "Fast", description: "Guaranteed throughput." },
  ]);
  assert.equal(tiered.default_service_tier, null);
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

test("merged catalog preserves native GPT identity while rewriting routed models", () => {
  const merged = buildMergedCatalog({ models: [template] }, [grok]);
  const bySlug = new Map(merged.map((model) => [model.slug, model]));
  assert.match(bySlug.get("gpt-5.5").base_instructions, /based on GPT-5/);
  assert.equal(bySlug.get("gpt-5.5").supports_reasoning_summaries, false);
  assert.match(bySlug.get("grok-oauth/grok-4.5").base_instructions, /based on Grok 4\.5/);
  assert.doesNotMatch(bySlug.get("grok-oauth/grok-4.5").base_instructions, /GPT-5/);
});

test("merged catalog gives native models first and keeps routed providers contiguous", () => {
  const nativeOlder = {
    ...template,
    slug: "gpt-5.4",
    display_name: "GPT-5.4",
    priority: 29,
  };
  const routed = [
    { ...grok, slug: "opencode-go/glm-5.3", provider: "opencode-go", priority: 7 },
    { ...grok, slug: "deepseek/deepseek-v4-pro", provider: "deepseek", priority: 1 },
    { ...grok, slug: "antigravity-oauth/gemini-3.7-flash", provider: "antigravity-oauth", priority: 9 },
    { ...grok, slug: "opencode-zen/zen-r1", provider: "opencode-zen", priority: 4 },
    { ...grok, slug: "opencode-go-responses/gpt-5.6-luna", provider: "opencode-go-responses", priority: 2 },
    { ...grok, slug: "grok-oauth/grok-4.5", provider: "grok-oauth", priority: 0 },
    { ...grok, slug: "antigravity-oauth/gemini-3.1-pro", provider: "antigravity-oauth", priority: 3 },
  ];
  const merged = buildMergedCatalog({ models: [nativeOlder, template] }, routed);

  // Routed models stay grouped by the named vendor policy. Every routed entry
  // in this fixture inherits `multiAgentVersion: "v2"` from `grok`, and a
  // certified v2 spawn route keeps the `priority` the operator chose: those
  // low values are what keep it inside Codex's spawn_agent override window,
  // so publication must never renumber them. The band that v1 routed models
  // do move into is covered by the next test.
  assert.deepEqual(merged.map((model) => model.slug), [
    "gpt-5.5",
    "gpt-5.4",
    "antigravity-oauth/gemini-3.1-pro",
    "antigravity-oauth/gemini-3.7-flash",
    "deepseek/deepseek-v4-pro",
    "opencode-go-responses/gpt-5.6-luna",
    "opencode-zen/zen-r1",
    "opencode-go/glm-5.3",
    "grok-oauth/grok-4.5",
  ]);
  assert.deepEqual(
    merged.map((model) => model.priority),
    [10, 29, 3, 9, 1, 2, 4, 7, 0],
  );
});

test("v1 routed models publish in a band above the visible native maximum while v2 routes keep their authored priority", () => {
  // Issue #544: Codex sorts its picker by `priority`, so routed models that
  // reuse the native GPT integers interleave with them and vendor grouping
  // never appears. Renumbering everything would crowd certified v2 spawn
  // routes out of Codex's override window, so only v1 routes move.
  const nativeOlder = { ...template, slug: "gpt-5.4", display_name: "GPT-5.4", priority: 29 };
  // A hidden native entry may carry any number; it must not set the band.
  const hiddenNative = {
    ...template,
    slug: "gpt-5.3-internal",
    display_name: "GPT-5.3",
    priority: 500,
    visibility: "hide",
  };
  const v1 = { ...grok, multiAgentVersion: "v1" };
  const routed = [
    { ...v1, slug: "opencode-go/glm-5.3", provider: "opencode-go", priority: 7 },
    { ...v1, slug: "deepseek/deepseek-v4-pro", provider: "deepseek", priority: 1 },
    { ...v1, slug: "deepseek/deepseek-v4-flash", provider: "deepseek", priority: 6 },
    { ...grok, slug: "grok-oauth/grok-4.5", provider: "grok-oauth", priority: 2 },
    { ...v1, slug: "grok-oauth/grok-4.6", provider: "grok-oauth", priority: 1 },
  ];
  const merged = buildMergedCatalog(
    { models: [nativeOlder, template, hiddenNative] },
    routed,
  );
  const bySlug = new Map(merged.map((model) => [model.slug, model]));

  // Natives are never renumbered.
  assert.equal(bySlug.get("gpt-5.5").priority, 10);
  assert.equal(bySlug.get("gpt-5.4").priority, 29);
  assert.equal(bySlug.get("gpt-5.3-internal").priority, 500);

  // The certified v2 route keeps its authored priority and its certificate,
  // and does not consume a slot in the band.
  assert.equal(bySlug.get("grok-oauth/grok-4.5").priority, 2);
  assert.equal(bySlug.get("grok-oauth/grok-4.5").multi_agent_version, "v2");

  // v1 routes land directly above the highest *visible* native (29, not the
  // hidden 500), in vendor-group order and then authored order within a
  // vendor: DeepSeek (pro 1, flash 6), then opencode, then the catch-all.
  assert.deepEqual(
    [
      "deepseek/deepseek-v4-pro",
      "deepseek/deepseek-v4-flash",
      "opencode-go/glm-5.3",
      "grok-oauth/grok-4.6",
    ].map((slug) => bySlug.get(slug).priority),
    [30, 31, 32, 33],
  );

  // The published picker has no colliding integers left to interleave on.
  assert.equal(new Set(merged.map((model) => model.priority)).size, merged.length);
});

test("native gpt-5.2 stays parseable by older Codex catalog readers", () => {
  const native52 = { ...template, slug: "gpt-5.2" };
  delete native52.supports_parallel_tool_calls;
  const merged = buildMergedCatalog({ models: [native52] }, []);
  assert.equal(merged[0].supports_parallel_tool_calls, true);
});

test("merged catalog resolves a routed behavior template without inheriting its capabilities", () => {
  const sol = {
    ...template,
    slug: "gpt-5.6-sol",
    base_instructions: "You are Codex, an agent based on GPT-5. SOL_BEHAVIOR",
    model_messages: {
      instructions_template: "You are Codex, an agent based on GPT-5. SOL_TEMPLATE {{ personality }}",
      instructions_variables: { personality_default: "" },
    },
    tool_mode: "code_mode_only",
    use_responses_lite: true,
  };
  const merged = buildMergedCatalog(
    { models: [template, sol] },
    [{ ...grok, behaviorTemplate: "gpt-5.6-sol" }],
  );
  const routed = merged.find((model) => model.slug === grok.slug);

  assert.match(routed.base_instructions, /SOL_BEHAVIOR/);
  assert.match(routed.model_messages.instructions_template, /SOL_TEMPLATE/);
  assert.equal(routed.tool_mode, undefined);
  assert.equal(routed.use_responses_lite, false);
});

test("merged catalog derives a missing behavior base instruction from its template", () => {
  const sol = {
    slug: "gpt-5.6-sol",
    model_messages: {
      instructions_template: "You are Codex, an agent based on GPT-5.6-Sol.",
    },
  };
  const merged = buildMergedCatalog(
    { models: [template, sol] },
    [{ ...grok, behaviorTemplate: "gpt-5.6-sol" }],
  );
  const routed = merged.find((model) => model.slug === grok.slug);

  assert.match(routed.base_instructions, /based on Grok 4\.5\./);
  assert.doesNotMatch(routed.base_instructions, /GPT-5/);
});

test("merged catalog does not inherit native tool mode from a fallback template", () => {
  const sol = {
    ...template,
    slug: "gpt-5.6-sol",
    tool_mode: "code_mode_only",
    use_responses_lite: true,
  };
  const merged = buildMergedCatalog(
    { models: [sol] },
    [{ ...grok, behaviorTemplate: "gpt-5.6-sol" }],
  );
  const routed = merged.find((model) => model.slug === grok.slug);

  assert.equal(routed.tool_mode, undefined);
  assert.equal(routed.use_responses_lite, false);
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

function withCredentialEnvironment(kimiHome, run) {
  const previousKimi = process.env.KIMI_CODE_HOME;
  const previousGrok = process.env.GROK_AUTH_PATH;
  const dir = mkdtempSync(path.join(os.tmpdir(), "catalog-login-free-"));
  if (kimiHome === "unconfigured") {
    process.env.KIMI_CODE_HOME = path.join(dir, "kimi-home");
  } else {
    const credentialsDir = path.join(dir, "kimi-home", "credentials");
    mkdirSync(credentialsDir, { recursive: true });
    writeFileSync(
      path.join(credentialsDir, "kimi-code.json"),
      JSON.stringify({
        access_token: "access-value",
        refresh_token: "refresh-value",
        expires_at: Math.floor(Date.now() / 1000) + 3600,
        scope: "kimi-code",
      }),
      { mode: 0o600 },
    );
    process.env.KIMI_CODE_HOME = path.join(dir, "kimi-home");
  }
  process.env.GROK_AUTH_PATH = path.join(dir, "grok", "auth.json");
  try {
    return run();
  } finally {
    if (previousKimi === undefined) delete process.env.KIMI_CODE_HOME;
    else process.env.KIMI_CODE_HOME = previousKimi;
    if (previousGrok === undefined) delete process.env.GROK_AUTH_PATH;
    else process.env.GROK_AUTH_PATH = previousGrok;
    rmSync(dir, { recursive: true, force: true });
  }
}

test("login-free catalog does not assign slots to unauthenticated providers", () => {
  const kimi = {
    ...grok,
    slug: "kimi-oauth/k3",
    provider: "kimi-oauth",
    displayName: "Kimi K3 (OAuth)",
    priority: 2,
    compHash: "kimi-oauth-k3-v1",
  };
  withCredentialEnvironment("unconfigured", () => {
    // The credential file does not exist under this KIMI_CODE_HOME, so
    // kimi-oauth is not configured; its model must not take a slot.
    const { models, aliases } = buildLoginFreeCatalog(
      { models: [template] },
      [kimi],
    );
    assert.deepEqual(aliases, {});
    assert.deepEqual(models, []);
  });
});

test("login-free catalog assigns slots to models of credentialed providers", () => {
  const kimi = {
    ...grok,
    slug: "kimi-oauth/k3",
    provider: "kimi-oauth",
    displayName: "Kimi K3 (OAuth)",
    priority: 2,
    compHash: "kimi-oauth-k3-v1",
  };
  const unauthenticatedGrok = {
    ...grok,
    provider: "grok-oauth",
  };
  withCredentialEnvironment("configured", () => {
    // kimi-oauth has a live credential, grok-oauth does not: only the kimi
    // model may take the whitelist slot.
    const { models, aliases } = buildLoginFreeCatalog(
      { models: [template] },
      [kimi, unauthenticatedGrok],
    );
    assert.deepEqual(aliases, { "gpt-5.5": "kimi-oauth/k3" });
    const bySlug = new Map(models.map((model) => [model.slug, model]));
    assert.equal(bySlug.get("gpt-5.5").display_name, "Kimi K3 (OAuth)");
    assert.equal(bySlug.get("gpt-5.5").visibility, "list");
    assert.equal(bySlug.get("kimi-oauth/k3").visibility, "hide");
  });
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

test("native cache permits in-place refresh only when it contains native models", () => {
  assert.equal(
    nativeCacheCanRefreshInPlace({ catalog: { models: [template] } }),
    true,
  );
  assert.equal(
    nativeCacheCanRefreshInPlace({
      catalog: { models: [template, { ...template, slug: grok.slug }] },
    }),
    false,
  );
  assert.equal(nativeCacheCanRefreshInPlace({}), false);
});

test("native catalog cache is reusable only for the codex build that captured it", () => {
  const captured = {
    captured_with: "codex-cli 0.142.5",
    native_source_fingerprint: "account-a",
    models: [template],
  };

  assert.equal(nativeCatalogIsReusable(captured, "codex-cli 0.142.5"), true);
  assert.equal(nativeCatalogIsReusable(captured, "codex-cli 0.146.1"), false);
  // Account catalogs change independently of the binary version.
  assert.equal(
    nativeCatalogIsReusable(captured, "codex-cli 0.142.5", "account-b"),
    false,
  );
  assert.equal(
    nativeCatalogIsReusable(captured, "codex-cli 0.142.5", "account-a"),
    true,
  );
  // Unknown current version: no binary to re-ask, so keep what we have.
  assert.equal(nativeCatalogIsReusable(captured, undefined), true);
  // Un-stamped caches predate version tracking; re-capture when we can ask.
  assert.equal(nativeCatalogIsReusable({ models: [template] }, "codex-cli 0.146.1"), false);
  assert.equal(nativeCatalogIsReusable({ models: [template] }, undefined), true);
  // Invalid or empty caches are never reusable.
  assert.equal(nativeCatalogIsReusable(undefined, undefined), false);
  assert.equal(nativeCatalogIsReusable({ models: [] }, "codex-cli 0.146.1"), false);
});

test("native catalog merge preserves account visibility and bundled-only models", () => {
  const accountMini = {
    slug: "gpt-mini",
    visibility: "list",
    source: "account",
    model_messages: { instructions_template: "account instructions" },
  };
  const merged = mergeNativeCatalogs(
    {
      models: [
        accountMini,
        {
          slug: "gpt-spark",
          visibility: "list",
          model_messages: { instructions_template: "spark instructions" },
        },
      ],
    },
    {
      models: [
        {
          slug: "gpt-mini",
          visibility: "hide",
          source: "bundled",
          base_instructions: "bundled instructions",
        },
        { slug: "gpt-bundled-only", visibility: "list" },
      ],
    },
  );
  assert.deepEqual(merged.models, [
    {
      ...accountMini,
      base_instructions: "bundled instructions",
    },
    {
      slug: "gpt-spark",
      visibility: "list",
      model_messages: { instructions_template: "spark instructions" },
      base_instructions: "spark instructions",
    },
    { slug: "gpt-bundled-only", visibility: "list" },
  ]);
});

test("an account catalog can be authoritative about model availability", () => {
  const merged = mergeNativeCatalogs(
    { models: [{ slug: "gpt-free", visibility: "list" }] },
    {
      models: [
        { slug: "gpt-free", visibility: "list" },
        { slug: "gpt-plus-only", visibility: "list" },
      ],
    },
    { includeBundledOnly: false },
  );
  assert.deepEqual(merged.models, [{ slug: "gpt-free", visibility: "list" }]);
});

test("native catalog merge never loses non-empty bundled metadata", () => {
  const merged = mergeNativeModel(
    {
      slug: "gpt-5.6-luna",
      additional_speed_tiers: [],
      service_tiers: [],
      input_modalities: [],
      experimental_supported_tools: [],
      include_apps_usage_instructions: undefined,
      model_messages: {},
    },
    {
      slug: "gpt-5.6-luna",
      additional_speed_tiers: ["fast"],
      service_tiers: [
        { id: "priority", name: "Fast", description: "1.5x speed" },
      ],
      input_modalities: ["text", "image"],
      experimental_supported_tools: ["web_search"],
      include_apps_usage_instructions: true,
      model_messages: { instructions_template: "bundled instructions" },
    },
  );
  assert.deepEqual(merged.additional_speed_tiers, ["fast"]);
  assert.deepEqual(merged.service_tiers, [
    { id: "priority", name: "Fast", description: "1.5x speed" },
  ]);
  assert.deepEqual(merged.input_modalities, ["text", "image"]);
  assert.deepEqual(merged.experimental_supported_tools, ["web_search"]);
  assert.equal(merged.include_apps_usage_instructions, true);
  assert.deepEqual(merged.model_messages, {
    instructions_template: "bundled instructions",
  });
  assert.equal(
    mergeNativeModel(
      { slug: "gpt-5.6-luna", visibility: "list" },
      { slug: "gpt-5.6-luna", visibility: "hide" },
    ).visibility,
    "list",
  );
});

test("bundled backfill is an allowlist, not every empty account field", () => {
  const merged = mergeNativeModel(
    {
      slug: "gpt-5.6-luna",
      // An account that lost its effort ladder is expressing exactly that;
      // resurrecting bundled's ladder would offer efforts it cannot spend.
      supported_reasoning_levels: [],
      // Unknown fields never backfill: the allowlist is the whole contract,
      // so a future schema field starts account-authoritative by default.
      some_future_field: "",
      // Empty on both sides stays empty rather than inventing a value.
      additional_speed_tiers: [],
    },
    {
      slug: "gpt-5.6-luna",
      supported_reasoning_levels: ["low", "high"],
      some_future_field: "bundled-value",
      additional_speed_tiers: [],
    },
  );
  assert.deepEqual(merged.supported_reasoning_levels, []);
  assert.equal(merged.some_future_field, "");
  assert.deepEqual(merged.additional_speed_tiers, []);
});

test("account-only models satisfy the strict custom-catalog instruction schema", () => {
  const [spark] = mergeNativeCatalogs(
    {
      models: [
        {
          slug: "gpt-spark",
          visibility: "list",
          model_messages: { instructions_template: "spark instructions" },
        },
      ],
    },
    { models: [{ slug: "other", base_instructions: "other instructions" }] },
  ).models;
  assert.equal(spark.base_instructions, "spark instructions");
});

// The bundled catalog's base_instructions equals the account template with
// `{{ personality }}` replaced by `instructions_variables.personality_default`
// (verified against codex-cli for gpt-5.4, gpt-5.4-mini, and gpt-5.5).
// Account-only models must get the same treatment: the literal placeholder
// must never reach a system prompt.
test("derived base_instructions substitutes template variable defaults", () => {
  assert.equal(
    deriveBaseInstructions({
      instructions_template: "You are Codex.\n{{ personality }}\nBe fast.",
      instructions_variables: {
        personality_default: "# Personality\nStay neutral.",
        personality_friendly: "# Personality\nBe warm.",
      },
    }),
    "You are Codex.\n# Personality\nStay neutral.\nBe fast.",
  );
  // No default for the placeholder: strip it rather than leaking the token.
  assert.equal(
    deriveBaseInstructions({
      instructions_template: "Intro {{ tone }} outro.",
      instructions_variables: {},
    }),
    "Intro  outro.",
  );
  assert.equal(
    deriveBaseInstructions({ instructions_template: "plain" }),
    "plain",
  );
  assert.equal(deriveBaseInstructions(undefined), undefined);
});

test("no template placeholder survives into any merged base_instructions", () => {
  const merged = mergeNativeCatalogs(
    {
      models: [
        {
          slug: "gpt-spark",
          model_messages: {
            instructions_template: "Spark. {{ personality }} End.",
            instructions_variables: { personality_default: "Calm." },
          },
        },
        {
          slug: "gpt-undefaulted",
          model_messages: {
            instructions_template: "Head {{ mystery }} tail.",
            instructions_variables: {
              // A default may itself carry a placeholder; it must be stripped,
              // not substituted recursively.
              mystery_default: "nested {{ personality }} token",
            },
          },
        },
      ],
    },
    undefined,
  );
  for (const model of merged.models) {
    assert.equal(typeof model.base_instructions, "string");
    assert.doesNotMatch(model.base_instructions, /\{\{[\s\S]*?\}\}/);
  }
  assert.equal(merged.models[0].base_instructions, "Spark. Calm. End.");
});

test("duplicate account slugs collapse to the first occurrence", () => {
  const merged = mergeNativeCatalogs(
    {
      models: [
        { slug: "gpt-dupe", visibility: "list", base_instructions: "first" },
        { slug: "gpt-dupe", visibility: "hide", base_instructions: "second" },
      ],
    },
    { models: [{ slug: "gpt-dupe", base_instructions: "bundled" }] },
  );
  assert.equal(merged.models.length, 1);
  assert.equal(merged.models[0].base_instructions, "first");
  assert.equal(merged.models[0].visibility, "list");
});

test("native listed models retain only repository-certified v2 capability", () => {
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

test("native context variants are never advertised as subagent models", () => {
  const native = [
    { slug: "gpt-5.6-sol", visibility: "list", multi_agent_version: "v2" },
    { slug: "gpt-5.6-sol-1m", visibility: "list", multi_agent_version: "v2" },
  ];
  const promoted = promoteNativeMultiAgent(native, {
    mode: "all",
    enabled: ["gpt-5.6-sol-1m"],
    disabled: [],
  });
  assert.equal(promoted[0].multi_agent_version, "v2");
  assert.equal(promoted[1].multi_agent_version, "v1");
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

test("selected subagent mode does not promote unreviewed native models", () => {
  const native = [
    { slug: "gpt-5.4", visibility: "list", multi_agent_version: "v1" },
    { slug: "gpt-5.3", visibility: "list", multi_agent_version: "v1" },
  ];
  const promoted = promoteNativeMultiAgent(native, {
    mode: "selected",
    enabled: ["gpt-5.4"],
    disabled: [],
  });
  assert.equal(promoted[0].multi_agent_version, "v1");
  assert.equal(promoted[1].multi_agent_version, "v1");
});

test("proven subagent mode still promotes upstream-verified v2-backend slugs", () => {
  // gpt-5.6-luna is shipped as v1 by upstream but runs on the v2 backend, so
  // it must be promoted even in the conservative proven mode; an unverified
  // native slug keeps its upstream value.
  const native = [
    { slug: "gpt-5.6-luna", visibility: "list", multi_agent_version: "v1" },
    { slug: "gpt-5.4", visibility: "list", multi_agent_version: "v1" },
  ];
  const promoted = promoteNativeMultiAgent(native, {
    mode: "proven",
    enabled: [],
    disabled: [],
  });
  assert.equal(promoted[0].multi_agent_version, "v2");
  assert.equal(promoted[1].multi_agent_version, "v1");
});

test("an upstream-verified slug still honours disabled and picker-hidden", () => {
  const native = [{ slug: "gpt-5.6-luna", visibility: "list", multi_agent_version: "v1" }];
  assert.equal(nativeSubagentCertification(native[0]), "v2");
  const promoted = promoteNativeMultiAgent(
    native,
    { mode: "proven", enabled: [], disabled: ["gpt-5.6-luna"] },
  );
  assert.equal(promoted[0].multi_agent_version, "v1");
  const hidden = promoteNativeMultiAgent(
    native,
    { mode: "proven", enabled: [], disabled: [] },
    new Set(["gpt-5.6-luna"]),
  );
  assert.equal(hidden[0].multi_agent_version, "v1");
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


test("efficient routed execution closes a RED behavior area before switching", () => {
  const model = routedModel(template, { ...grok, instructionOverlay: "efficient-agentic" });
  assert.match(model.base_instructions, /RED.*suite.*green.*blocker/i);
});

test("efficient routed execution invalidates contradicted debugging hypotheses", () => {
  const model = routedModel(template, { ...grok, instructionOverlay: "efficient-agentic" });
  assert.match(model.base_instructions, /runtime evidence.*contradict.*hypothesis/i);
  assert.match(model.base_instructions, /re-?trace.*production.*call path/i);
});

test("efficient routed execution stops patching after two failed hypotheses", () => {
  const model = routedModel(template, { ...grok, instructionOverlay: "efficient-agentic" });
  assert.match(model.base_instructions, /two.*failed hypotheses.*production call path/i);
});

test("efficient routed execution bounds large reads and defers future-stage research", () => {
  const model = routedModel(template, { ...grok, instructionOverlay: "efficient-agentic" });
  assert.match(model.base_instructions, /32 KiB|400 lines/i);
  assert.match(model.base_instructions, /defer.*research.*stage.*consume/i);
});
test("efficient routed execution grounds unfamiliar fixtures in canonical contracts", () => {
  const model = routedModel(template, { ...grok, instructionOverlay: "efficient-agentic" });
  assert.match(model.base_instructions, /fixture.*canonical.*schema.*type.*known-good/i);
});


test("efficient routed execution silently substitutes routine missing tools", () => {
  const model = routedModel(template, { ...grok, instructionOverlay: "efficient-agentic" });
  assert.match(model.base_instructions, /optional helper.*unavailable.*switch silently/i);
  assert.match(model.base_instructions, /do not send.*progress message.*fallback/i);
});

// One whole catalog publication, from a `model-picker.json` in the shape a
// build older than the allowlist left behind, to the file Codex reads at
// startup. The unit tests above cover the state transition; this covers the
// only thing the operator sees, which is whether the models are still in the
// picker after an update (issue #338).
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function writeCatalogCodexStub(directory) {
  const windows = process.platform === "win32";
  const target = path.join(directory, windows ? "codex-picker.cmd" : "codex-picker");
  const models = JSON.stringify({
    models: [
      { slug: "gpt-5.6-sol", display_name: "GPT-5.6 Sol", visibility: "list", priority: 10 },
    ],
  });
  writeFileSync(
    target,
    windows
      ? `@echo off\r\nif "%1"=="--version" (echo codex-cli 99.0.0& exit /b 0)\r\nif "%1"=="login" exit /b 0\r\nif "%1"=="debug" (echo ${models}& exit /b 0)\r\nexit /b 1\r\n`
      : `#!/bin/sh
case "$1" in
  --version) echo 'codex-cli 99.0.0' ;;
  login) exit 0 ;;
  debug) printf '%s\\n' '${models}' ;;
  *) exit 1 ;;
esac
`,
    { mode: 0o755 },
  );
  return target;
}

test(
  "an update publishes the models a pre-allowlist picker was already showing",
  { timeout: 30_000 },
  () => {
    const codexHome = mkdtempSync(path.join(os.tmpdir(), "codex-router-picker-migration-"));
    const stateDir = path.join(codexHome, "router-state");
    mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    writeFileSync(path.join(codexHome, "config.toml"), 'model = "gpt-5.6-sol"\n', {
      mode: 0o600,
    });
    writeFileSync(
      path.join(stateDir, "enabled-providers.json"),
      `${JSON.stringify({ version: 1, providers: ["deepseek"] })}\n`,
      { mode: 0o600 },
    );
    writeFileSync(path.join(stateDir, "deepseek-api-key.secret"), "test-key\n", {
      mode: 0o600,
    });
    // What the previous build wrote: the extended-window variant it seeded
    // hidden, one model this operator switched off, and no `visible` key --
    // so the two DeepSeek models absent from the file were the ones showing.
    writeFileSync(
      path.join(stateDir, "model-picker.json"),
      `${JSON.stringify({
        version: 1,
        hidden: ["gpt-5.6-sol-1m", "deepseek/deepseek-v4-pro"],
        seeded: ["gpt-5.6-sol-1m", "deepseek/deepseek-v4-pro"],
      })}\n`,
      { mode: 0o600 },
    );

    try {
      const catalog = spawnSync(
        process.execPath,
        [path.join(repoRoot, "src", "catalog.mjs"), "--refresh-native"],
        {
          cwd: repoRoot,
          encoding: "utf8",
          env: {
            ...process.env,
            CODEX_BIN: writeCatalogCodexStub(codexHome),
            CODEX_HOME: codexHome,
            CODEX_ROUTER_STATE_DIR: stateDir,
            MODEL_ROUTER_STATE_DIR: stateDir,
            MODEL_ROUTER_TARGET: "codex",
          },
        },
      );
      assert.equal(catalog.status, 0, catalog.stderr);

      const merged = JSON.parse(
        readFileSync(path.join(stateDir, "merged-models.json"), "utf8"),
      );
      const visibility = new Map(
        merged.models.map((model) => [String(model.slug), model.visibility]),
      );
      assert.equal(visibility.get("deepseek/deepseek-v4-flash"), "list");
      assert.equal(visibility.get("deepseek/deepseek-v4-flash-vision-exp"), "list");
      assert.equal(visibility.get("deepseek/deepseek-v4-pro"), "hide");
      assert.equal(visibility.get("gpt-5.6-sol-1m"), "hide");

      const picker = JSON.parse(
        readFileSync(path.join(stateDir, "model-picker.json"), "utf8"),
      );
      assert.deepEqual(picker.visible, [
        "deepseek/deepseek-v4-flash",
        "deepseek/deepseek-v4-flash-vision-exp",
      ]);
    } finally {
      rmSync(codexHome, { recursive: true, force: true });
    }
  },
);
