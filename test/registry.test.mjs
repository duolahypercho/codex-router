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

test("provider registry exposes Kimi and every current DeepSeek API model", () => {
  assert.deepEqual(
    LISTED_MODELS.map((model) => model.slug),
    [
      "kimi-oauth/k3",
      "kimi-api/kimi-k3",
      "deepseek/deepseek-v4-flash",
      "deepseek/deepseek-v4-pro",
      "chatgpt-oauth/gpt-5.6-sol",
      "chatgpt-oauth/gpt-5.6-terra",
      "chatgpt-oauth/gpt-5.6-luna",
    ],
  );
  assert.equal(PROVIDERS.get("deepseek").baseUrl, "https://api.deepseek.com");
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
  assert.match(rendered, /os\.environ\/CODEX_ROUTER_INTERNAL_KEY/);
  assert.doesNotMatch(rendered, /DEEPSEEK_API_KEY|KIMI_API_KEY/);
});
