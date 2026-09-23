import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

process.env.MODEL_ROUTER_USER_MODELS = path.join(
  mkdtempSync(path.join(os.tmpdir(), "openrouter-decisions-test-")),
  "user-models.json",
);

const { LISTED_MODELS, MODEL_BY_SLUG, PROVIDERS } = await import("../src/model-registry.mjs");
const { providerModelEndpoint } = await import("../src/openai-endpoint-policy.mjs");

test("OpenRouter Decisions shares the chat key but uses its own route", () => {
  const provider = PROVIDERS.get("openrouter-decisions");
  const parent = PROVIDERS.get("openrouter");
  const model = MODEL_BY_SLUG.get("openrouter-decisions/jev-latest");

  assert.equal(provider?.variantOf, "openrouter");
  assert.equal(provider?.protocol, "openai-decisions");
  assert.equal(provider?.baseUrl, "https://openrouter.ai/api/alpha");
  assert.equal(provider?.baseUrlEnv, "OPENROUTER_DECISIONS_API_BASE_URL");
  assert.deepEqual(provider?.credential, parent?.credential);
  assert.equal(model?.listed, false, "Decisions judges are not conversational chat models");
  assert.equal(
    LISTED_MODELS.some((entry) => entry.slug === model?.slug),
    false,
    "Decisions judges are not published to conversational model pickers",
  );
  assert.equal(model?.provider, "openrouter-decisions");
  assert.equal(model?.upstreamModel, "~typesafe/jev-latest");
  assert.equal(providerModelEndpoint(PROVIDERS.get(model?.provider)), "/decisions");
});
