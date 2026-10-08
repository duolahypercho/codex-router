import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const directory = mkdtempSync(path.join(os.tmpdir(), "azure-retry-policy-"));
process.env.MODEL_ROUTER_STATE_DIR = directory;
process.env.CODEX_HOME = path.join(directory, "codex");
process.env.MODEL_ROUTER_GENERIC_PROVIDERS = path.join(directory, "generic-providers.json");
process.env.MODEL_ROUTER_USER_MODELS = path.join(directory, "user-models.json");
writeFileSync(process.env.MODEL_ROUTER_GENERIC_PROVIDERS, JSON.stringify({
  version: 1,
  providers: [{
    id: "azure-kmamc",
    displayName: "Azure test",
    baseUrl: "https://azure.example.test/v1",
    adapter: "openai-responses",
    headers: {},
    enabled: true,
  }],
}));
writeFileSync(process.env.MODEL_ROUTER_USER_MODELS, JSON.stringify({
  version: 1,
  models: [{
    slug: "azure-kmamc/retry-test",
    provider: "azure-kmamc",
    gatewayModel: "azure-retry-test",
    upstreamModel: "azure-test-model",
    compHash: "azure-retry-test-v1",
    displayName: "Azure retry test",
    description: "Isolated retry policy fixture.",
    priority: 100,
    listed: true,
    defaultEffort: "medium",
    reasoningLevels: [{ effort: "medium", description: "Medium" }],
    contextWindow: 131072,
    autoCompact: 110000,
    inputModalities: ["text"],
  }],
}));
test.after(() => rmSync(directory, { recursive: true, force: true }));
const { MODELS } = await import("../src/model-registry.mjs");
const { renderLiteLlmConfig } = await import("../src/litellm-config.mjs");

// Regression: Azure TPM 429s mid-stream close the SSE without
// response.completed (Codex: "stream closed before response.completed",
// 5x reconnect). LiteLLM must not retry the same exhausted deployment and
// amplify TPM pressure/cost; Codex owns retries. Mirrors the zai-coding
// precedent in the same file.
test("azure-kmamc model groups disable LiteLLM rate-limit retries", () => {
  assert.ok(MODELS.some((model) => model.slug === "azure-kmamc/retry-test"));
  const rendered = renderLiteLlmConfig();
  assert.ok(rendered.includes("    azure-retry-test:\n      RateLimitErrorRetries: 0"));
  const controls = MODELS.filter(({ provider }) => !["azure-kmamc", "zai-coding"].includes(provider));
  assert.ok(controls.length > 0);
  for (const model of controls) {
    assert.ok(!rendered.includes(`    ${model.gatewayModel}:\n      RateLimitErrorRetries: 0`), model.slug);
  }
});

test("zai-coding precedent still holds", () => {
  const rendered = renderLiteLlmConfig();
  for (const model of MODELS.filter(({ provider }) => provider === "zai-coding")) {
    assert.match(
      rendered,
      new RegExp(`${model.gatewayModel}:\\n\\s+RateLimitErrorRetries: 0`),
      model.slug,
    );
  }
});
