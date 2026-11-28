import assert from "node:assert/strict";
import test from "node:test";

import { LISTED_MODELS, PROVIDERS } from "../src/model-registry.mjs";

test("LLMTR is a credentialed catalog-only OpenAI-compatible provider", () => {
  const provider = PROVIDERS.get("llmtr");
  assert.equal(provider.displayName, "LLMTR");
  assert.equal(provider.baseUrl, "https://llmtr.com/v1");
  assert.equal(provider.baseUrlEnv, "LLMTR_API_BASE_URL");
  assert.deepEqual(provider.credential.environment, ["LLMTR_API_KEY"]);
  assert.equal(provider.credential.file, "llmtr-api-key.secret");
  assert.deepEqual(provider.credential.keychainServices, ["codex-router-llmtr"]);
  assert.equal(LISTED_MODELS.some(({ provider: id }) => id === "llmtr"), false);
});
