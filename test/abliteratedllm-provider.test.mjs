import assert from "node:assert/strict";
import test from "node:test";

import { LISTED_MODELS, PROVIDERS } from "../src/model-registry.mjs";

test("AbliteratedLLM is a credentialed catalog-only OpenAI-compatible provider", () => {
  const provider = PROVIDERS.get("abliteratedllm");
  assert.equal(provider.displayName, "AbliteratedLLM");
  assert.equal(provider.baseUrl, "https://api.abliteratedllm.dev/v1");
  assert.equal(provider.baseUrlEnv, "ABLITERATEDLLM_API_BASE_URL");
  assert.deepEqual(provider.credential.environment, ["ABLITERATEDLLM_API_KEY"]);
  assert.equal(provider.credential.file, "abliteratedllm-api-key.secret");
  assert.deepEqual(provider.credential.keychainServices, ["codex-router-abliteratedllm"]);
  assert.equal(LISTED_MODELS.some(({ provider: id }) => id === "abliteratedllm"), false);
});
