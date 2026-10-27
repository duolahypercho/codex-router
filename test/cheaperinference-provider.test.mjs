import assert from "node:assert/strict";
import test from "node:test";

import { LISTED_MODELS, PROVIDERS } from "../src/model-registry.mjs";

test("Cheaper Inference is a credentialed catalog-only OpenAI-compatible provider", () => {
  const provider = PROVIDERS.get("cheaperinference");
  assert.equal(provider.displayName, "Cheaper Inference");
  assert.equal(provider.baseUrl, "https://api.cheaperinference.com/v1");
  assert.equal(provider.baseUrlEnv, "CHEAPERINFERENCE_API_BASE_URL");
  assert.deepEqual(provider.credential.environment, ["CHEAPERINFERENCE_API_KEY"]);
  assert.equal(provider.credential.file, "cheaperinference-api-key.secret");
  assert.deepEqual(provider.credential.keychainServices, ["codex-router-cheaperinference"]);
  assert.equal(LISTED_MODELS.some(({ provider: id }) => id === "cheaperinference"), false);
});
