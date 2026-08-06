import assert from "node:assert/strict";
import test from "node:test";

import { renderLiteLlmConfig } from "../src/litellm-config.mjs";
import {
  API_MODELS,
  LISTED_MODELS,
  MODEL_BY_SLUG,
  MODELS,
  PROVIDERS,
} from "../src/model-registry.mjs";

test("provider registry exposes configured API and OAuth model families", () => {
  assert.deepEqual(
    LISTED_MODELS.map((model) => model.slug),
    [
      "kimi-oauth/kimi-for-coding",
      "kimi-oauth/kimi-for-coding-highspeed",
      "kimi-oauth/k3",
      "kimi-api/kimi-k3",
      "deepseek/deepseek-v4-flash",
      "deepseek/deepseek-v4-pro",
      "grok-oauth/grok-4.5",
      "grok-api/grok-4.5",
      "anthropic-api/claude-opus-4.8",
      "zai-coding/glm-5.2",
      "zai-coding/glm-5-turbo",
      "qwen-plan/qwen3.7-max",
      "qwen-plan/qwen3.7-plus",
      "qwen-plan/qwen3.8-max",
      "qwen-plan/qwen3.8-max-preview",
      "qwen-plan/qwen3.6-flash",
      "qwen-plan/deepseek-v4-pro",
      "qwen-plan/deepseek-v4-flash-0731",
      "qwen-plan/glm-5.2",
      "ollama-cloud/glm-5.2",
      "ollama-cloud/kimi-k2.7-code",
      "ollama-cloud/minimax-m3",
      "ollama-cloud/deepseek-v4-pro",
      "minimax-token-plan/minimax-m3",
      "opencode-go/grok-4.5",
      "opencode-go/glm-5.2",
      "opencode-go/glm-5.1",
      "opencode-go/kimi-k3",
      "opencode-go/kimi-k2.7-code",
      "opencode-go/kimi-k2.6",
      "opencode-go/deepseek-v4-pro",
      "opencode-go/deepseek-v4-flash",
      "opencode-go/mimo-v2.5",
      "opencode-go/mimo-v2.5-pro",
      "opencode-go-messages/minimax-m3",
      "opencode-go-messages/minimax-m2.7",
      "opencode-go-messages/qwen3.8-max",
      "opencode-go-messages/qwen3.7-max",
      "opencode-go-messages/qwen3.7-plus",
      "opencode-go-messages/qwen3.6-plus",
      "opencode-go/hy3",
      "opencode-go-responses/gpt-5.6-luna",
      "meta/muse-spark-1.2",
      "meta/muse-spark-1.2-contributor",
      "meta/muse-spark-1.1",
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
  assert.equal(PROVIDERS.get("ollama-cloud").baseUrl, "https://ollama.com/v1");
  assert.equal(PROVIDERS.get("minimax-token-plan").baseUrl, "https://api.minimax.io/v1");
  // Go is its own endpoint, not the pay-per-use Zen one.
  assert.equal(PROVIDERS.get("opencode-go").baseUrl, "https://opencode.ai/zen/go/v1");
  assert.equal(PROVIDERS.get("opencode-go-messages").baseUrl, "https://opencode.ai/zen/go/v1");
  assert.equal(PROVIDERS.get("opencode-go-responses").baseUrl, "https://opencode.ai/zen/go/v1");
  assert.equal(PROVIDERS.get("opencode-go-messages").protocol, "anthropic");
  assert.equal(PROVIDERS.get("opencode-go-responses").protocol, "openai-responses");
  // The protocol variants are one selectable family: they declare the parent
  // whose credential and picker selection they follow.
  assert.equal(PROVIDERS.get("opencode-go").variantOf, undefined);
  assert.equal(PROVIDERS.get("opencode-go-messages").variantOf, "opencode-go");
  assert.equal(PROVIDERS.get("opencode-go-responses").variantOf, "opencode-go");
  assert.equal(
    PROVIDERS.get("opencode-go-messages").credential.file,
    PROVIDERS.get("opencode-go").credential.file,
  );
  assert.equal(PROVIDERS.get("grok-api").baseUrl, "https://api.x.ai/v1");
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
  for (const model of LISTED_MODELS.filter(({ provider }) =>
    /^(?:kimi|grok)-/.test(provider),
  )) {
    assert.equal(model.multiAgentVersion, "v2", model.slug);
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
  const minimax = MODEL_BY_SLUG.get("minimax-token-plan/minimax-m3");
  assert.equal(minimax.contextWindow, 1_000_000);
  assert.equal(minimax.autoCompact, 900_000);
  assert.deepEqual(minimax.inputModalities, ["text", "image"]);
  assert.equal(
    MODEL_BY_SLUG.get("opencode-go-responses/gpt-5.6-luna").contextWindow,
    272_000,
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
  assert.match(rendered, /model: "anthropic\/opencode-go-messages-minimax-m3"/);
  const lunaBlock = rendered.slice(
    rendered.indexOf('model_name: "opencode-go-responses-gpt-5-6-luna"'),
    rendered.indexOf('model_name:', rendered.indexOf('model_name: "opencode-go-responses-gpt-5-6-luna"') + 1),
  );
  assert.doesNotMatch(lunaBlock, /use_chat_completions_api/);
  assert.doesNotMatch(rendered, /ANTHROPIC_API_KEY|DEEPSEEK_API_KEY|KIMI_API_KEY/);
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

test("a checked-in upgrade prompt with an unresolvable target fails the registry load", async () => {
  const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const path = (await import("node:path")).default;
  const { spawnSync } = await import("node:child_process");
  const dir = mkdtempSync(path.join(tmpdir(), "registry-upgrade-test-"));
  try {
    const registry = JSON.parse(
      (await import("node:fs")).readFileSync("config/providers.json", "utf8"),
    );
    registry.models[0] = {
      ...registry.models[0],
      upgradeTo: { model: "no-such/model", markdown: "Upgrade now" },
    };
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
