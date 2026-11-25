import assert from "node:assert/strict";
import test from "node:test";

import { LISTED_MODELS, PROVIDERS } from "../src/model-registry.mjs";

test("Standard Compute is a credentialed catalog-only OpenAI-compatible provider", () => {
  const provider = PROVIDERS.get("standardcompute");
  assert.equal(provider.displayName, "Standard Compute");
  assert.equal(provider.baseUrl, "https://api.stdcmpt.com/v1");
  assert.equal(provider.baseUrlEnv, "STANDARDCOMPUTE_API_BASE_URL");
  assert.deepEqual(provider.credential.environment, ["STANDARDCOMPUTE_API_KEY"]);
  assert.equal(provider.credential.file, "standardcompute-api-key.secret");
  assert.deepEqual(provider.credential.keychainServices, ["codex-router-standardcompute"]);
  assert.equal(LISTED_MODELS.some(({ provider: id }) => id === "standardcompute"), false);
});
