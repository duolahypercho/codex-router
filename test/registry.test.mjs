import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

// These assertions describe the checked-in registry, so the machine's own
// curated models (including any local Ollama models the operator has checked)
// must not leak in. Point the overlay at an empty directory before the registry
// loads, which is why the imports below are dynamic.
process.env.MODEL_ROUTER_USER_MODELS = path.join(
  mkdtempSync(path.join(os.tmpdir(), "registry-test-")),
  "user-models.json",
);

const { renderLiteLlmConfig } = await import("../src/litellm-config.mjs");
const {
  API_MODELS,
  anonymousModelAllowed,
  LISTED_MODELS,
  MODEL_BY_SLUG,
  MODELS,
  PROVIDERS,
  readRegistryDocument,
} = await import("../src/model-registry.mjs");

test("provider registry exposes configured API and OAuth model families", () => {
  // Order follows the deterministic sorted walk of the config/ vendor tree;
  // picker placement comes from each model's priority field, not this list.
  assert.deepEqual(
    LISTED_MODELS.map((model) => model.slug),
    [
      "anthropic-api/claude-opus-4.8",
      "clinepass/deepseek-v4-flash",
      "clinepass/deepseek-v4-pro",
      "clinepass/glm-5.2",
      "clinepass/kimi-k2.6",
      "clinepass/kimi-k2.7-code",
      "clinepass/kimi-k3",
      "clinepass/mimo-v2.5-pro",
      "clinepass/mimo-v2.5",
      "clinepass/minimax-m3",
      "clinepass/qwen3.7-max",
      "clinepass/qwen3.7-plus",
      "clinepass/qwen3.8-max",
      "commandcode/deepseek-v4-flash",
      "commandcode/deepseek-v4-pro",
      "commandcode/fugu-ultra",
      "commandcode/gemini-3.5-flash",
      "commandcode/gemini-3.7-flash",
      "commandcode/glm-5.2-fast",
      "commandcode/glm-5.2",
      "commandcode/gpt-5.5",
      "commandcode/gpt-5.6-luna",
      "commandcode/gpt-5.6-sol",
      "commandcode/gpt-5.6-terra",
      "commandcode/grok-4.5",
      "commandcode/grok-4.6",
      "commandcode/hy3-paid",
      "commandcode/inkling-small",
      "commandcode/inkling",
      "commandcode/kimi-k2.7-code-highspeed",
      "commandcode/kimi-k2.7-code",
      "commandcode/kimi-k3",
      "commandcode/laguna-s-2.1",
      "commandcode-messages/claude-fable-5",
      "commandcode-messages/claude-haiku-4.5",
      "commandcode-messages/claude-opus-4.8",
      "commandcode-messages/claude-opus-5",
      "commandcode-messages/claude-sonnet-5",
      "commandcode/mimo-v2.5-pro",
      "commandcode/minimax-m2.7",
      "commandcode/minimax-m3",
      "commandcode/muse-spark-1.2",
      "commandcode/nemotron-3-ultra",
      "commandcode/qwen3.7-flash",
      "commandcode/qwen3.7-max",
      "commandcode/qwen3.7-plus",
      "commandcode/qwen3.8-max",
      "commandcode/step-3.7-flash",
      "deepseek/deepseek-v4-flash",
      "deepseek/deepseek-v4-pro",
      "grok-api/grok-4.5",
      "grok-oauth/grok-4.5",
      "grok-oauth/grok-4.6",
      "kimi-api/kimi-k3",
      "kimi-api-cn/kimi-k3",
      "kimi-oauth/k3",
      "kimi-oauth/kimi-for-coding-highspeed",
      "kimi-oauth/kimi-for-coding",
      "meta/muse-spark-1.1",
      "meta/muse-spark-1.2-contributor",
      "meta/muse-spark-1.2",
      "minimax-token-plan/minimax-m3",
      "ollama-cloud/deepseek-v4-flash",
      "ollama-cloud/deepseek-v4-pro",
      "ollama-cloud/glm-5.2",
      "ollama-cloud/kimi-k2.7-code",
      "ollama-cloud/minimax-m3",
      "opencode-go/deepseek-v4-flash",
      "opencode-go/deepseek-v4-pro",
      "opencode-go/glm-5.1",
      "opencode-go/glm-5.2",
      "opencode-go/glm-5.3",
      "opencode-go/grok-4.5",
      "opencode-go/hy3",
      "opencode-go/kimi-k2.6",
      "opencode-go/kimi-k2.7-code",
      "opencode-go/kimi-k3",
      "opencode-go/mimo-v2.5-pro",
      "opencode-go/mimo-v2.5",
      "opencode-go-messages/minimax-m2.7",
      "opencode-go-messages/minimax-m3",
      "opencode-go-messages/qwen3.6-plus",
      "opencode-go-messages/qwen3.7-max",
      "opencode-go-messages/qwen3.7-plus",
      "opencode-go-messages/qwen3.8-max",
      "opencode-go-responses/gpt-5.6-luna",
      "qwen-plan/deepseek-v4-flash-0731",
      "qwen-plan/deepseek-v4-pro",
      "qwen-plan/glm-5.2",
      "qwen-plan/qwen3.6-flash",
      "qwen-plan/qwen3.7-max",
      "qwen-plan/qwen3.7-plus",
      "qwen-plan/qwen3.8-max-preview",
      "qwen-plan/qwen3.8-max",
      "zai-api/glm-4.7",
      "zai-api/glm-5.2",
      "zai-api/glm-5.3",
      "zai-coding/glm-5-turbo",
      "zai-coding/glm-5.2",
      "zai-coding/glm-5.3-1m",
      "zai-coding/glm-5.3",
    ],
  );
  assert.equal(PROVIDERS.get("deepseek").baseUrl, "https://api.deepseek.com");
  assert.equal(
    PROVIDERS.get("qwen-plan").baseUrl,
    "https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1",
  );
  assert.equal(
    PROVIDERS.get("zai-coding").baseUrl,
    "https://api.z.ai/api/coding/paas/v4",
  );
  // The pay-per-token platform is its own endpoint, its own credential, and its
  // own key file: a Coding Plan key is not billable on it.
  assert.equal(PROVIDERS.get("zai-api").baseUrl, "https://api.z.ai/api/paas/v4");
  assert.equal(PROVIDERS.get("zai-api").variantOf, undefined);
  assert.equal(PROVIDERS.get("zai-api").credential.file, "zai-api-key.secret");
  assert.notEqual(
    PROVIDERS.get("zai-api").credential.file,
    PROVIDERS.get("zai-coding").credential.file,
  );
  // Every channel the credential can arrive through has to be distinct, not
  // just the file: the same check the China Kimi route gets below. A shared
  // keychain service or base-URL variable would let one product's key satisfy
  // the other's lookup, which is the whole failure this split exists to stop.
  for (const field of ["environment", "keychainServices"]) {
    const platform = PROVIDERS.get("zai-api").credential[field] || [];
    const plan = new Set(PROVIDERS.get("zai-coding").credential[field] || []);
    assert.ok(platform.length > 0, `zai-api declares no ${field}`);
    assert.ok(
      platform.every((entry) => !plan.has(entry)),
      `zai-api ${field} must not overlap the Coding Plan`,
    );
  }
  assert.notEqual(
    PROVIDERS.get("zai-api").baseUrlEnv,
    PROVIDERS.get("zai-coding").baseUrlEnv,
  );
  assert.ok(PROVIDERS.get("zai-api").planNote);
  assert.equal(PROVIDERS.get("ollama-cloud").baseUrl, "https://ollama.com/v1");
  assert.equal(PROVIDERS.get("minimax-token-plan").baseUrl, "https://api.minimax.io/v1");
  // Go is its own endpoint, not the pay-per-use Zen one.
  assert.equal(PROVIDERS.get("opencode-go").baseUrl, "https://opencode.ai/zen/go/v1");
  assert.equal(PROVIDERS.get("opencode-go-messages").baseUrl, "https://opencode.ai/zen/go/v1");
  assert.equal(PROVIDERS.get("opencode-go-responses").baseUrl, "https://opencode.ai/zen/go/v1");
  assert.equal(PROVIDERS.get("opencode-go-messages").protocol, "anthropic");
  assert.equal(PROVIDERS.get("opencode-go-responses").protocol, "openai-responses");
  assert.equal(PROVIDERS.get("commandcode").baseUrl, "https://api.commandcode.ai/provider/v1");
  assert.equal(PROVIDERS.get("commandcode-messages").baseUrl, "https://api.commandcode.ai/provider/v1");
  assert.equal(PROVIDERS.get("commandcode-messages").protocol, "anthropic");
  // The protocol variants are one selectable family: they declare the parent
  // whose credential and picker selection they follow.
  assert.equal(PROVIDERS.get("opencode-go").variantOf, undefined);
  assert.equal(PROVIDERS.get("opencode-go-messages").variantOf, "opencode-go");
  assert.equal(PROVIDERS.get("opencode-go-responses").variantOf, "opencode-go");
  assert.equal(PROVIDERS.get("commandcode").variantOf, undefined);
  assert.equal(PROVIDERS.get("commandcode-messages").variantOf, "commandcode");
  assert.equal(
    PROVIDERS.get("opencode-go-messages").credential.file,
    PROVIDERS.get("opencode-go").credential.file,
  );
  assert.equal(
    PROVIDERS.get("commandcode-messages").credential.file,
    PROVIDERS.get("commandcode").credential.file,
  );
  assert.deepEqual(PROVIDERS.get("commandcode").credential.environment, [
    "COMMAND_CODE_API_KEY",
    "COMMANDCODE_API_KEY",
  ]);
  assert.equal(PROVIDERS.get("grok-api").baseUrl, "https://api.x.ai/v1");
  // kimi-api is the global platform. The mainland one is its own provider
  // below, not a KIMI_API_BASE_URL override of this one -- the override still
  // works for a genuinely custom deployment, but pointing it at moonshot.cn
  // would authenticate the wrong account's key against the wrong host.
  assert.equal(PROVIDERS.get("kimi-api").baseUrl, "https://api.moonshot.ai/v1");
  // Moonshot runs two platforms with separate accounts, separate billing, and
  // keys each host rejects from the other. They must never collapse into one
  // provider, and must never share a credential.
  assert.equal(PROVIDERS.get("kimi-api-cn").baseUrl, "https://api.moonshot.cn/v1");
  assert.notEqual(
    PROVIDERS.get("kimi-api-cn").credential.file,
    PROVIDERS.get("kimi-api").credential.file,
  );
  assert.notEqual(
    PROVIDERS.get("kimi-api-cn").baseUrlEnv,
    PROVIDERS.get("kimi-api").baseUrlEnv,
  );
  for (const field of ["environment", "keychainServices"]) {
    const global = new Set(PROVIDERS.get("kimi-api").credential[field]);
    const china = PROVIDERS.get("kimi-api-cn").credential[field];
    assert.ok(
      china.every((entry) => !global.has(entry)),
      `kimi-api-cn ${field} must not overlap the global platform`,
    );
  }
  // The China route has never been through the native collaboration probe
  // AGENTS.md requires, so it stays conservative v1 while the global one is v2.
  assert.equal(MODEL_BY_SLUG.get("kimi-api-cn/kimi-k3").multiAgentVersion, undefined);
  assert.equal(MODEL_BY_SLUG.get("kimi-api/kimi-k3").multiAgentVersion, "v2");
  assert.equal(MODEL_BY_SLUG.get("kimi-api-cn/kimi-k3").upstreamModel, "kimi-k3");
  assert.equal(PROVIDERS.get("github-copilot").authProfile, "github-copilot");
  assert.equal(PROVIDERS.get("github-copilot").protocol, "openai-responses");
  assert.deepEqual(PROVIDERS.get("github-copilot").credential.environment, [
    "COPILOT_GITHUB_TOKEN",
    "GH_TOKEN",
    "GITHUB_TOKEN",
  ]);
  const chutes = PROVIDERS.get("chutes");
  assert.equal(chutes.baseUrl, "https://llm.chutes.ai/v1");
  assert.equal(chutes.baseUrlEnv, "CHUTES_API_BASE_URL");
  assert.deepEqual(chutes.credential.environment, ["CHUTES_API_KEY"]);
  assert.equal(chutes.credential.file, "chutes-api-key.secret");
  assert.deepEqual(chutes.credential.keychainServices, ["codex-router-chutes"]);
  assert.equal(LISTED_MODELS.some(({ provider }) => provider === "chutes"), false);
  const opencodeFree = PROVIDERS.get("opencode-free");
  assert.equal(opencodeFree.authMode, "anonymous");
  assert.equal(opencodeFree.baseUrl, "https://opencode.ai/zen/v1");
  assert.equal(opencodeFree.credential, undefined);
  assert.equal(anonymousModelAllowed(opencodeFree, "big-pickle"), true);
  assert.equal(anonymousModelAllowed(opencodeFree, "mimo-v2.5-free"), true);
  assert.equal(anonymousModelAllowed(opencodeFree, "glm-5.1"), false);
  const kiloFree = PROVIDERS.get("kilo-free");
  assert.equal(kiloFree.authMode, "anonymous");
  assert.equal(kiloFree.baseUrl, "https://api.kilo.ai/api/gateway");
  assert.equal(anonymousModelAllowed(kiloFree, "z-ai/glm-5:free"), true);
  assert.equal(anonymousModelAllowed(kiloFree, "z-ai/glm-5"), false);
  const clinepass = PROVIDERS.get("clinepass");
  assert.equal(clinepass.baseUrl, "https://api.cline.bot/api/v1");
  assert.equal(clinepass.baseUrlEnv, "CLINE_API_BASE_URL");
  assert.equal(clinepass.planNote, "Requires an active ClinePass subscription.");
  assert.deepEqual(clinepass.credential.environment, ["CLINE_API_KEY"]);
  assert.equal(clinepass.credential.file, "clinepass-api-key.secret");
  assert.deepEqual(clinepass.credential.keychainServices, ["codex-router-clinepass"]);
  const clinepassModels = LISTED_MODELS.filter(({ provider }) => provider === "clinepass");
  assert.deepEqual(
    clinepassModels.map(({ upstreamModel }) => upstreamModel),
    [
      "cline-pass/deepseek-v4-flash",
      "cline-pass/deepseek-v4-pro",
      "cline-pass/glm-5.2",
      "cline-pass/kimi-k2.6",
      "cline-pass/kimi-k2.7-code",
      "cline-pass/kimi-k3",
      "cline-pass/mimo-v2.5-pro",
      "cline-pass/mimo-v2.5",
      "cline-pass/minimax-m3",
      "cline-pass/qwen3.7-max",
      "cline-pass/qwen3.7-plus",
      "cline-pass/qwen3.8-max",
    ],
  );
  for (const model of clinepassModels) {
    assert.equal(model.requestProfile, "clinepass", model.slug);
    assert.equal(model.defaultEffort, "high", model.slug);
    assert.deepEqual(model.reasoningLevels, [
      { effort: "high", description: "Default model behavior" },
    ], model.slug);
    assert.equal(model.multiAgentVersion, undefined, model.slug);
    assert.deepEqual(model.inputModalities, ["text"], model.slug);
  }
  const clinepassContext = Object.fromEntries(
    clinepassModels.map(({ upstreamModel, contextWindow, autoCompact }) => [
      upstreamModel,
      [contextWindow, autoCompact],
    ]),
  );
  assert.deepEqual(clinepassContext, {
    "cline-pass/deepseek-v4-flash": [1_048_576, 900_000],
    "cline-pass/deepseek-v4-pro": [1_048_576, 900_000],
    "cline-pass/glm-5.2": [1_048_576, 900_000],
    "cline-pass/kimi-k2.6": [262_144, 235_000],
    "cline-pass/kimi-k2.7-code": [262_144, 235_000],
    "cline-pass/kimi-k3": [1_048_576, 900_000],
    "cline-pass/mimo-v2.5-pro": [1_050_000, 900_000],
    "cline-pass/mimo-v2.5": [1_050_000, 900_000],
    "cline-pass/minimax-m3": [1_048_576, 900_000],
    "cline-pass/qwen3.7-max": [1_000_000, 900_000],
    "cline-pass/qwen3.7-plus": [1_000_000, 900_000],
    "cline-pass/qwen3.8-max": [1_000_000, 900_000],
  });
  assert.equal(PROVIDERS.get("grok-oauth").proxyBaseEnv, "GROK_OAUTH_FORWARD_BASE_URL");
  // Qwen OAuth was discontinued upstream on 2026-04-15, so the plan key is the
  // only Qwen surface. A second key-based provider would differ only by base
  // URL, which QWEN_PLAN_BASE_URL already covers.
  assert.deepEqual(
    [...PROVIDERS.values()].filter((p) => p.ownedBy === "alibaba").map((p) => p.id),
    ["qwen-plan"],
  );
  assert.deepEqual(PROVIDERS.get("qwen-plan").credential.environment, [
    "QWEN_PLAN_API_KEY",
    "DASHSCOPE_API_KEY",
  ]);
  assert.equal(PROVIDERS.get("anthropic-api").protocol, "anthropic");
  // Deliberate v1 holdouts. Both are unproven through the native collaboration
  // probe AGENTS.md requires, and a v2 claim is not inherited from a sibling
  // route: kimi-api-cn is the same model on a different platform, which is
  // exactly the kind of "surely it also works" assumption the probe exists for.
  const unprovenForV2 = new Set(["grok-oauth/grok-4.6", "kimi-api-cn/kimi-k3"]);
  for (const model of LISTED_MODELS.filter(({ provider, slug }) =>
    /^(?:kimi|grok)-/.test(provider) && !unprovenForV2.has(slug),
  )) {
    assert.equal(model.multiAgentVersion, "v2", model.slug);
  }
  for (const slug of unprovenForV2) {
    assert.equal(MODEL_BY_SLUG.get(slug).multiAgentVersion, undefined, slug);
  }
  assert.equal(MODEL_BY_SLUG.get("deepseek/deepseek-v4-pro").multiAgentVersion, undefined);
  for (const slug of [
    "kimi-oauth/kimi-for-coding-highspeed",
    "kimi-oauth/kimi-for-coding",
  ]) {
    const model = MODEL_BY_SLUG.get(slug);
    assert.equal(model.contextWindow, 262_144);
    assert.deepEqual(model.reasoningLevels, [
      { effort: "high", description: "Always-on coding reasoning" },
    ]);
  }
  // K3 documents low/high/max regardless of gateway; the opencode Go relay
  // forwards reasoning_effort, so it carries the same ladder and profile as
  // the direct Moonshot entry.
  for (const slug of ["opencode-go/kimi-k3", "commandcode/kimi-k3"]) {
    const k3 = MODEL_BY_SLUG.get(slug);
    assert.deepEqual(
      k3.reasoningLevels.map((level) => level.effort),
      ["low", "high", "max"],
      slug,
    );
    assert.equal(k3.defaultEffort, "max", slug);
    assert.equal(k3.requestProfile, "kimi-k3", slug);
  }
  // Hosted search is an xAI-backend behavior. Standalone search is limited to
  // provider/model pairs verified against Codex's client-side replay path.
  for (const slug of ["grok-oauth/grok-4.5", "grok-oauth/grok-4.6"]) {
    assert.deepEqual(MODEL_BY_SLUG.get(slug).searchTool, { mode: "hosted" });
  }
  const standaloneSearchSlugs = new Set([
    "deepseek/deepseek-v4-flash",
    "opencode-go/deepseek-v4-flash",
  ]);
  for (const model of MODELS) {
    if (["grok-oauth/grok-4.5", "grok-oauth/grok-4.6"].includes(model.slug) || standaloneSearchSlugs.has(model.slug)) continue;
    assert.equal(model.searchTool, undefined, model.slug);
  }
  // Original-detail images are declared per slug on canonical vision
  // flagships only; gateway variants stay conservative until each relay is
  // probed live.
  const originalDetailSlugs = MODELS.filter(
    (model) => model.supportsImageDetailOriginal === true,
  ).map((model) => model.slug);
  assert.deepEqual(originalDetailSlugs.sort(), [
    "anthropic-api/claude-opus-4.8",
    "grok-api/grok-4.5",
    "grok-oauth/grok-4.5",
    "grok-oauth/grok-4.6",
    "kimi-api-cn/kimi-k3",
    "kimi-api/kimi-k3",
    "kimi-oauth/k3",
    "kimi-oauth/kimi-for-coding",
    "kimi-oauth/kimi-for-coding-highspeed",
    "minimax-token-plan/minimax-m3",
    "qwen-plan/qwen3.6-flash",
    "qwen-plan/qwen3.7-max",
    "qwen-plan/qwen3.8-max",
    "qwen-plan/qwen3.8-max-preview",
  ]);
  for (const slug of originalDetailSlugs) {
    assert.ok(
      MODEL_BY_SLUG.get(slug).inputModalities.includes("image"),
      `${slug} declares original image detail without image input`,
    );
  }
  const minimax = MODEL_BY_SLUG.get("minimax-token-plan/minimax-m3");
  assert.equal(minimax.contextWindow, 1_000_000);
  assert.equal(minimax.autoCompact, 900_000);
  assert.deepEqual(minimax.inputModalities, ["text", "image"]);
  assert.equal(
    MODEL_BY_SLUG.get("opencode-go-responses/gpt-5.6-luna").contextWindow,
    272_000,
  );
  assert.equal(
    MODEL_BY_SLUG.get("commandcode/deepseek-v4-flash").contextWindow,
    1_000_000,
  );
  assert.equal(
    MODEL_BY_SLUG.get("commandcode-messages/claude-opus-4.8").contextWindow,
    1_000_000,
  );
  // Command Code serves Haiku 4.5 only under its dated id. The undated alias
  // every other Anthropic surface accepts is absent from this catalog, so the
  // route 404s the moment the registry shortens it.
  assert.equal(
    MODEL_BY_SLUG.get("commandcode-messages/claude-haiku-4.5").upstreamModel,
    "claude-haiku-4-5-20251001",
  );
  // Documented output_config.effort ladder for Opus 4.8 (default high).
  assert.deepEqual(
    MODEL_BY_SLUG.get("anthropic-api/claude-opus-4.8").reasoningLevels.map((level) => level.effort),
    ["low", "medium", "high", "xhigh", "max"],
  );
  assert.equal(MODEL_BY_SLUG.get("anthropic-api/claude-opus-4.8").defaultEffort, "high");
  const grok = MODEL_BY_SLUG.get("grok-api/grok-4.5");
  assert.equal(grok.contextWindow, 500_000);
  assert.deepEqual(grok.reasoningLevels.map((level) => level.effort), ["low", "medium", "high"]);
  assert.deepEqual(grok.inputModalities, ["text", "image"]);
  const grok46 = MODEL_BY_SLUG.get("grok-oauth/grok-4.6");
  assert.equal(grok46.contextWindow, 500_000);
  assert.deepEqual(
    grok46.reasoningLevels.map((level) => level.effort),
    ["low", "medium", "high", "xhigh"],
  );
  assert.equal(grok46.defaultEffort, "high");
  assert.deepEqual(grok46.inputModalities, ["text", "image"]);
  for (const slug of [
    "deepseek/deepseek-v4-flash",
    "deepseek/deepseek-v4-pro",
  ]) {
    const model = MODEL_BY_SLUG.get(slug);
    assert.equal(model.contextWindow, 1_048_576);
    assert.match(model.description, /DeepSeek V4/);
    assert.deepEqual(model.inputModalities, ["text"]);
  }
});

test("DeepSeek V4 Flash routes opt in to Codex standalone web search", () => {
  for (const slug of [
    "deepseek/deepseek-v4-flash",
    "opencode-go/deepseek-v4-flash",
  ]) {
    assert.deepEqual(MODEL_BY_SLUG.get(slug)?.searchTool, { mode: "standalone" }, slug);
  }
});

test("Meta models opt out of the apply_patch custom tool", () => {
  for (const slug of [
    "meta/muse-spark-1.2",
    "meta/muse-spark-1.2-contributor",
    "meta/muse-spark-1.1",
  ]) {
    assert.equal(MODEL_BY_SLUG.get(slug).supportsApplyPatchTool, false);
  }
  assert.equal(MODEL_BY_SLUG.get("grok-oauth/grok-4.5").supportsApplyPatchTool, undefined);
});

test("deprecated DeepSeek aliases remain routable but stay out of the picker", () => {
  for (const slug of [
    "deepseek/deepseek-chat",
    "deepseek/deepseek-reasoner",
  ]) {
    const model = MODEL_BY_SLUG.get(slug);
    assert.ok(model);
    assert.equal(model.listed, false);
    assert.ok(API_MODELS.includes(model));
  }
});

// Providers that resell the same upstream model and expose the same effort
// ladder must agree on the default. Profiles like qwen-plan always send an
// explicit reasoning_effort, so a divergent default silently gives users a
// weaker tier on one provider than the same model offers on another.
test("resellers of one upstream model share a default effort when their ladders match", () => {
  const groups = new Map();
  for (const model of MODELS) {
    const ladder = (model.reasoningLevels || []).map((level) => level.effort).join(",");
    if (!ladder) continue;
    const key = `${model.upstreamModel || model.slug.split("/").at(-1)}|${ladder}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(model);
  }
  for (const [key, models] of groups) {
    if (models.length < 2) continue;
    const defaults = new Set(models.map((model) => model.defaultEffort));
    assert.equal(
      defaults.size,
      1,
      `${key} disagrees on defaultEffort: ${models
        .map((model) => `${model.slug}=${model.defaultEffort}`)
        .join(", ")}`,
    );
  }
});

// Ollama validates reasoning_effort against high/medium/low/max/none and
// rejects anything else outright, so a level the forwarder cannot map into that
// set would 400 the moment a user picked it. Codex does not expose none, so
// the no-thinking rung is advertised as minimal and mapped to none in
// src/api-forwarder.mjs.
test("Ollama Cloud models advertise only levels the forwarder maps to Ollama", () => {
  const accepted = new Set(["minimal", "low", "medium", "high", "max"]);
  for (const model of MODELS) {
    if (model.requestProfile !== "ollama-cloud") continue;
    for (const level of model.reasoningLevels || []) {
      assert.ok(
        accepted.has(level.effort),
        `${model.slug} advertises ${level.effort}, which Ollama would reject`,
      );
    }
  }
});

// Every model_name has exactly one deployment, so a cooldown can only hide a
// failure -- it turns a 401 into LiteLLM's own 429. See #179.
test("the gateway config disables deployment cooldowns", () => {
  const rendered = renderLiteLlmConfig();
  assert.match(rendered, /router_settings:\n\s+disable_cooldowns: true/);
  const names = [...rendered.matchAll(/^  - model_name: (.+)$/gm)].map((m) => m[1]);
  assert.equal(new Set(names).size, names.length, "one deployment per model_name");
});

test("LiteLLM configuration is generated from every registry route", () => {
  const rendered = renderLiteLlmConfig();
  for (const model of MODELS) {
    assert.match(rendered, new RegExp(`model_name: "${model.gatewayModel}"`));
  }
  assert.match(rendered, /os\.environ\/CODEX_ROUTER_API_FORWARD_BASE_URL/);
  assert.match(rendered, /os\.environ\/CODEX_ROUTER_ANTHROPIC_FORWARD_BASE_URL/);
  assert.match(rendered, /os\.environ\/GROK_OAUTH_FORWARD_BASE_URL/);
  assert.match(rendered, /os\.environ\/CODEX_ROUTER_INTERNAL_KEY/);
  assert.match(rendered, /model: "anthropic\/anthropic-api-claude-opus-4-8"/);
  assert.match(
    rendered,
    /model: "openai\/responses\/opencode-go-responses-gpt-5-6-luna"/,
  );
  assert.equal(
    MODELS.some((model) => model.provider === "github-copilot"),
    false,
    "Copilot stays catalog-only until account-visible models are curated",
  );
  assert.match(rendered, /model: "anthropic\/opencode-go-messages-minimax-m3"/);
  const lunaBlock = rendered.slice(
    rendered.indexOf('model_name: "opencode-go-responses-gpt-5-6-luna"'),
    rendered.indexOf('model_name:', rendered.indexOf('model_name: "opencode-go-responses-gpt-5-6-luna"') + 1),
  );
  assert.doesNotMatch(lunaBlock, /use_chat_completions_api/);
  assert.doesNotMatch(rendered, /ANTHROPIC_API_KEY|CLINE_API_KEY|DEEPSEEK_API_KEY|KIMI_API_KEY/);
});

test("curated upgrade prompts point at listed generational successors", () => {
  // The modal only renders when the target slug is in the picker, so every
  // upgradeTo must resolve to a listed model (also enforced at load time).
  for (const model of MODELS) {
    if (model.upgradeTo === undefined) continue;
    const target = MODEL_BY_SLUG.get(model.upgradeTo.model);
    assert.ok(target, `${model.slug} upgrade target exists`);
    assert.equal(target.listed, true, `${model.slug} upgrade target is listed`);
    // Accepting the modal switches the default model, so the target must ride
    // the same credential: same provider, or a variant of the same parent.
    const family = (id) => PROVIDERS.get(id).variantOf || id;
    assert.equal(
      family(target.provider),
      family(model.provider),
      `${model.slug} upgrade target stays on the same credential`,
    );
  }
  assert.equal(
    MODEL_BY_SLUG.get("opencode-go/glm-5.1").upgradeTo.model,
    "opencode-go/glm-5.2",
  );
  assert.equal(
    MODEL_BY_SLUG.get("opencode-go/kimi-k2.6").upgradeTo.model,
    "opencode-go/kimi-k3",
  );
  assert.equal(
    MODEL_BY_SLUG.get("opencode-go-messages/minimax-m2.7").upgradeTo.model,
    "opencode-go-messages/minimax-m3",
  );
});

// The router's vision bridge is what gives a text-only model images, so the
// registry may only record an opt-out. A `true` would read as a capability the
// model itself has, which is exactly the claim the bridge must never make.
test("visionBridge may only be set to false", async () => {
  const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const path = (await import("node:path")).default;
  const { spawnSync } = await import("node:child_process");
  const dir = mkdtempSync(path.join(tmpdir(), "registry-vision-test-"));
  try {
    const registry = readRegistryDocument("config");
    registry.models = [
      { ...registry.models[0], visionBridge: true },
      ...registry.models.slice(1),
    ];
    const registryPath = path.join(dir, "providers.json");
    writeFileSync(registryPath, JSON.stringify(registry));
    const result = spawnSync(
      process.execPath,
      ["-e", "import('./src/model-registry.mjs').catch((e)=>{console.error(e.message);process.exit(1);})"],
      { encoding: "utf8", env: { ...process.env, MODEL_ROUTER_REGISTRY: registryPath } },
    );
    assert.equal(result.status, 1);
    assert.match(result.stderr, /may only set visionBridge to false/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a checked-in upgrade prompt with an unresolvable target fails the registry load", async () => {
  const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const path = (await import("node:path")).default;
  const { spawnSync } = await import("node:child_process");
  const dir = mkdtempSync(path.join(tmpdir(), "registry-upgrade-test-"));
  try {
    // The merged document round-trips into the single-file registry format
    // that MODEL_ROUTER_REGISTRY overrides still accept.
    const registry = readRegistryDocument("config");
    registry.models = [
      { ...registry.models[0], upgradeTo: { model: "no-such/model", markdown: "Upgrade now" } },
      ...registry.models.slice(1),
    ];
    const registryPath = path.join(dir, "providers.json");
    writeFileSync(registryPath, JSON.stringify(registry));
    const result = spawnSync(
      process.execPath,
      ["-e", "import('./src/model-registry.mjs').catch((e)=>{console.error(e.message);process.exit(1);})"],
      { encoding: "utf8", env: { ...process.env, MODEL_ROUTER_REGISTRY: registryPath } },
    );
    assert.equal(result.status, 1);
    assert.match(result.stderr, /upgrades to unknown model no-such\/model/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("serviceTiers require unique non-empty ids and names", async () => {
  const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const nodePath = (await import("node:path")).default;
  const { spawnSync } = await import("node:child_process");
  const dir = mkdtempSync(nodePath.join(tmpdir(), "registry-service-tiers-test-"));
  const load = (serviceTiers) => {
    const registry = readRegistryDocument("config");
    registry.models = [
      { ...registry.models[0], serviceTiers },
      ...registry.models.slice(1),
    ];
    const registryPath = nodePath.join(dir, "providers.json");
    writeFileSync(registryPath, JSON.stringify(registry));
    return spawnSync(
      process.execPath,
      ["-e", "import('./src/model-registry.mjs').catch((e)=>{console.error(e.message);process.exit(1);})"],
      { encoding: "utf8", env: { ...process.env, MODEL_ROUTER_REGISTRY: registryPath } },
    );
  };
  try {
    assert.match(load([{ id: " ", name: "Priority" }]).stderr, /invalid serviceTiers/);
    assert.match(load([{ id: "priority" }]).stderr, /invalid serviceTiers/);
    assert.match(
      load([{ id: "priority", name: "Fast" }, { id: " priority ", name: "Again" }]).stderr,
      /duplicate serviceTiers/,
    );
    const valid = load([{ id: "priority", name: "Fast" }]);
    assert.equal(valid.status, 0, valid.stderr);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// A keyless provider skips the credential requirement, which is only safe
// because it cannot reach off-box. Both halves of that bargain are enforced.
test("a keyless provider must be loopback and must not carry a credential", async () => {
  const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const nodePath = (await import("node:path")).default;
  const { spawnSync } = await import("node:child_process");
  const dir = mkdtempSync(nodePath.join(tmpdir(), "registry-keyless-test-"));
  const load = (mutate) => {
    const registry = readRegistryDocument("config");
    mutate(registry);
    const registryPath = nodePath.join(dir, "providers.json");
    writeFileSync(registryPath, JSON.stringify(registry));
    return spawnSync(
      process.execPath,
      ["-e", "import('./src/model-registry.mjs').catch((e)=>{console.error(e.message);process.exit(1);})"],
      { encoding: "utf8", env: { ...process.env, MODEL_ROUTER_REGISTRY: registryPath } },
    );
  };
  try {
    // Off-box endpoint: unauthenticated traffic must never leave the machine.
    const remote = load((registry) => {
      registry.providers = registry.providers.map((provider) =>
        provider.id === "local" ? { ...provider, baseUrl: "https://example.com/v1" } : provider,
      );
    });
    assert.equal(remote.status, 1);
    assert.match(remote.stderr, /must use a loopback baseUrl/);

    // Declaring a credential while claiming to need none is contradictory.
    const keyed = load((registry) => {
      registry.providers = registry.providers.map((provider) =>
        provider.id === "local"
          ? { ...provider, credential: { file: "x.secret", environment: [] } }
          : provider,
      );
    });
    assert.equal(keyed.status, 1);
    assert.match(keyed.stderr, /must not declare a credential/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("anonymous providers are fixed official endpoints without credentials", async () => {
  const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const nodePath = (await import("node:path")).default;
  const { spawnSync } = await import("node:child_process");
  const dir = mkdtempSync(nodePath.join(tmpdir(), "registry-anonymous-test-"));
  const load = (mutate) => {
    const registry = readRegistryDocument("config");
    mutate(registry);
    const registryPath = nodePath.join(dir, "providers.json");
    writeFileSync(registryPath, JSON.stringify(registry));
    return spawnSync(
      process.execPath,
      ["-e", "import('./src/model-registry.mjs').catch((e)=>{console.error(e.message);process.exit(1);})"],
      { encoding: "utf8", env: { ...process.env, MODEL_ROUTER_REGISTRY: registryPath } },
    );
  };
  try {
    const redirected = load((registry) => {
      registry.providers = registry.providers.map((provider) =>
        provider.id === "opencode-free"
          ? { ...provider, baseUrl: "https://example.com/v1" }
          : provider,
      );
    });
    assert.equal(redirected.status, 1);
    assert.match(redirected.stderr, /anonymous provider opencode-free must use its fixed official endpoint/);

    const keyed = load((registry) => {
      registry.providers = registry.providers.map((provider) =>
        provider.id === "kilo-free"
          ? { ...provider, credential: { file: "unexpected.secret", environment: [] } }
          : provider,
      );
    });
    assert.equal(keyed.status, 1);
    assert.match(keyed.stderr, /anonymous provider kilo-free must not declare keyless or credential metadata/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the Copilot auth profile cannot be attached to another provider", async () => {
  const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const nodePath = (await import("node:path")).default;
  const { spawnSync } = await import("node:child_process");
  const dir = mkdtempSync(nodePath.join(tmpdir(), "registry-copilot-profile-test-"));
  try {
    const registry = readRegistryDocument("config");
    registry.providers = registry.providers.map((provider) =>
      provider.id === "deepseek" ? { ...provider, authProfile: "github-copilot" } : provider,
    );
    const registryPath = nodePath.join(dir, "providers.json");
    writeFileSync(registryPath, JSON.stringify(registry));
    const result = spawnSync(
      process.execPath,
      ["-e", "import('./src/model-registry.mjs').catch((e)=>{console.error(e.message);process.exit(1);})"],
      { encoding: "utf8", env: { ...process.env, MODEL_ROUTER_REGISTRY: registryPath } },
    );
    assert.equal(result.status, 1);
    assert.match(result.stderr, /requires the github-copilot Responses provider/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the Copilot auth profile cannot be attached to an OAuth provider", async () => {
  const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const nodePath = (await import("node:path")).default;
  const { spawnSync } = await import("node:child_process");
  const dir = mkdtempSync(nodePath.join(tmpdir(), "registry-copilot-oauth-test-"));
  try {
    const registry = readRegistryDocument("config");
    registry.providers = registry.providers.map((provider) =>
      provider.id === "kimi-oauth" ? { ...provider, authProfile: "github-copilot" } : provider,
    );
    const registryPath = nodePath.join(dir, "providers.json");
    writeFileSync(registryPath, JSON.stringify(registry));
    const result = spawnSync(
      process.execPath,
      ["-e", "import('./src/model-registry.mjs').catch((e)=>{console.error(e.message);process.exit(1);})"],
      { encoding: "utf8", env: { ...process.env, MODEL_ROUTER_REGISTRY: registryPath } },
    );
    assert.equal(result.status, 1);
    assert.match(result.stderr, /requires the github-copilot Responses provider/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// The OpenAI-compatible surface silently ignores num_ctx, so a local model
// routed through it gets Ollama's maximum context -- a ~15 GB KV cache for ~2 GB
// of weights, which overflows a 16 GB machine and drops inference onto the CPU.
// Local models therefore route with Ollama's own protocol, which honours it.
test("local models route with Ollama's native protocol and a bounded context", () => {
  const rendered = renderLiteLlmConfig();
  const openAiRoutes = rendered.match(/model: "openai\/local-[^"]+"/g);
  assert.equal(openAiRoutes, null, "a local model must not use the OpenAI-compatible surface");
  // Every non-local model keeps the forwarder path untouched.
  assert.match(rendered, /model: "openai\/deepseek-v4-pro"/);
});
