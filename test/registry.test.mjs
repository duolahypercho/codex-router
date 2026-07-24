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
  assert.equal(PROVIDERS.get("grok-api").baseUrl, "https://api.x.ai/v1");
  assert.equal(PROVIDERS.get("grok-oauth").proxyBaseEnv, "GROK_OAUTH_FORWARD_BASE_URL");
  assert.equal(PROVIDERS.get("anthropic-api").protocol, "anthropic");
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
  assert.deepEqual(
    MODEL_BY_SLUG.get("anthropic-api/claude-opus-4.8").reasoningLevels,
    [{ effort: "high", description: "Adaptive deep reasoning for agentic work" }],
  );
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
  assert.doesNotMatch(rendered, /ANTHROPIC_API_KEY|DEEPSEEK_API_KEY|KIMI_API_KEY/);
});
