import assert from "node:assert/strict";
import test from "node:test";

import { LISTED_MODELS, PROVIDERS } from "../src/model-registry.mjs";

test("Runcrate is a credentialed catalog-only OpenAI-compatible provider", () => {
  const provider = PROVIDERS.get("runcrate");
  assert.equal(provider.displayName, "Runcrate");
  assert.equal(provider.baseUrl, "https://api.runcrate.ai/v1");
  assert.equal(provider.baseUrlEnv, "RUNCRATE_API_BASE_URL");
  assert.deepEqual(provider.credential.environment, ["RUNCRATE_API_KEY"]);
  assert.equal(provider.credential.file, "runcrate-api-key.secret");
  assert.deepEqual(provider.credential.keychainServices, ["codex-router-runcrate"]);
  assert.equal(LISTED_MODELS.some(({ provider: id }) => id === "runcrate"), false);
});
