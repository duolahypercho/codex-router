import assert from "node:assert/strict";
import test from "node:test";

import { PROVIDERS } from "../src/model-registry.mjs";
import {
  providerCatalogKind,
  providerCatalogFamilyCacheIds,
  providerCatalogRouteIds,
  providerCatalogSources,
} from "../src/provider-catalogs.mjs";

test("every selectable provider remains a canonical UI family", () => {
  const canonical = [...PROVIDERS.values()].filter((provider) => !provider.variantOf);
  assert.equal(canonical.length, 42);
  assert.equal(PROVIDERS.size, 47);
});

test("catalog capability comes from backend provider definitions", () => {
  assert.equal(providerCatalogKind(PROVIDERS.get("anthropic-api")), "models-endpoint");
  assert.equal(providerCatalogKind(PROVIDERS.get("devin-cli")), "devin");
  assert.equal(providerCatalogKind(PROVIDERS.get("kimi-oauth")), undefined);
  assert.equal(providerCatalogKind(PROVIDERS.get("grok-oauth")), undefined);
  assert.equal(providerCatalogKind(PROVIDERS.get("local")), undefined);
  assert.equal(providerCatalogKind(PROVIDERS.get("lmstudio")), undefined);
  assert.equal(providerCatalogKind(PROVIDERS.get("chatgpt-web")), "models-endpoint");
  assert.equal(providerCatalogKind(PROVIDERS.get("custom")), undefined);
});

test("shared credentials expose distinct catalogs without duplicate protocol rows", () => {
  assert.deepEqual(providerCatalogSources("opencode-go").map(({ id }) => id), [
    "opencode-go",
    "opencode-zen",
  ]);
  assert.deepEqual(providerCatalogSources("opencode-free").map(({ id }) => id), [
    "opencode-free",
  ]);
  assert.deepEqual(providerCatalogSources("commandcode").map(({ id }) => id), [
    "commandcode",
  ]);
  assert.deepEqual(providerCatalogSources("devin-cli").map(({ id }) => id), [
    "devin-cli",
  ]);
  assert.deepEqual(providerCatalogRouteIds("opencode-go"), [
    "opencode-go",
    "opencode-go-messages",
    "opencode-go-responses",
  ]);
  assert.deepEqual(providerCatalogRouteIds("opencode-zen"), ["opencode-zen"]);
  assert.deepEqual(providerCatalogRouteIds("commandcode"), [
    "commandcode",
    "commandcode-messages",
  ]);
  assert.deepEqual(new Set(providerCatalogFamilyCacheIds("opencode-go")), new Set([
    "opencode-go",
    "opencode-go-messages",
    "opencode-go-responses",
    "opencode-zen",
  ]));
});
