import assert from "node:assert/strict";
import test from "node:test";

import { LISTED_MODELS, PROVIDERS } from "../src/model-registry.mjs";

test("Obscurify.ai is a credentialed catalog-only OpenAI-compatible provider", () => {
  const provider = PROVIDERS.get("obscurify");
  assert.equal(provider.displayName, "Obscurify.ai");
  assert.equal(provider.baseUrl, "https://obscurify.ai/v1");
  assert.equal(provider.baseUrlEnv, "OBSCURIFY_API_BASE_URL");
  assert.deepEqual(provider.credential.environment, ["OBSCURIFY_API_KEY"]);
  assert.equal(provider.credential.file, "obscurify-api-key.secret");
  assert.deepEqual(provider.credential.keychainServices, ["codex-router-obscurify"]);
  assert.equal(LISTED_MODELS.some(({ provider: id }) => id === "obscurify"), false);
});
