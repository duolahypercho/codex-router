import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";

const root = mkdtempSync(path.join(os.tmpdir(), "chatgpt-web-provider-"));
const userModelsPath = path.join(root, "user-models.json");
process.env.MODEL_ROUTER_STATE_DIR = path.join(root, "state");
process.env.MODEL_ROUTER_USER_MODELS = userModelsPath;
delete process.env.MODEL_ROUTER_CHATGPT_WEB_BASE_URL;
writeFileSync(userModelsPath, JSON.stringify({
  version: 1,
  models: [{
    slug: "chatgpt-web/light",
    gatewayModel: "chatgpt-web-light",
    upstreamModel: "chatgpt-web/light",
    provider: "chatgpt-web",
    listed: true,
    displayName: "ChatGPT Web — Instant",
    description: "Test ChatGPT Web route.",
    priority: 100,
    reasoningLevels: [{ effort: "low", description: "Quick reasoning" }],
    defaultEffort: "low",
    contextWindow: 41_000,
    autoCompact: 32_000,
    inputModalities: ["text", "image"],
    compHash: "chatgpt-web-light-test-v1"
  }],
}));

after(() => rmSync(root, { recursive: true, force: true }));

const {
  directResponsesBody,
  directResponsesHeaders,
  directResponsesTarget,
} = await import("../src/direct-responses-provider.mjs");
const { modelIds } = await import("../src/model-discovery.mjs");
const { MODEL_BY_SLUG, PROVIDERS } = await import("../src/model-registry.mjs");
const { routedClientModels } = await import("../src/routed-client-models.mjs");
const { userModelIdentity } = await import("../src/user-models.mjs");

test("ChatGPT Web is an explicit Codex-only direct Responses provider", () => {
  const provider = PROVIDERS.get("chatgpt-web");
  assert.equal(provider.protocol, "openai-responses");
  assert.equal(provider.keyless, true);
  assert.equal(provider.directResponses, true);
  assert.equal(provider.codexOnly, true);
  assert.equal(provider.explicitSelection, true);
  assert.equal(MODEL_BY_SLUG.get("chatgpt-web/light").upstreamModel, "chatgpt-web/light");
  assert.equal(
    userModelIdentity({ providerId: "chatgpt-web", upstreamId: "chatgpt-web/pro" }).slug,
    "chatgpt-web/pro",
  );
});

test("ChatGPT Web discovery accepts a Codex catalog and withholds native rows", () => {
  const payload = {
    models: [
      { slug: "gpt-5.6-sol", display_name: "GPT-5.6 Sol" },
      { slug: "chatgpt-web/light", display_name: "ChatGPT Web — Instant" },
      { slug: "chatgpt-web/high", display_name: "ChatGPT Web — High" },
    ],
  };
  assert.deepEqual(modelIds(payload, PROVIDERS.get("chatgpt-web")), [
    "chatgpt-web/high",
    "chatgpt-web/light",
  ]);
});

test("direct Responses requests retain Codex authority but strip account credentials", () => {
  const provider = PROVIDERS.get("chatgpt-web");
  const headers = directResponsesHeaders({
    authorization: "Bearer CHATGPT_ACCOUNT_TOKEN",
    "chatgpt-account-id": "acct-secret",
    cookie: "session=secret",
    "content-encoding": "zstd",
    "content-length": "999",
    "openai-project": "project-secret",
    "x-oai-attestation": "attestation-secret",
    "x-codex-turn-metadata": "turn-authority",
    "x-openai-subagent": "review",
  });
  assert.equal(headers.Authorization, "Bearer local");
  assert.equal(headers["x-codex-turn-metadata"], "turn-authority");
  assert.equal(headers["x-openai-subagent"], "review");
  assert.equal(headers["chatgpt-account-id"], undefined);
  assert.equal(headers.cookie, undefined);
  assert.equal(headers["openai-project"], undefined);
  assert.equal(headers["x-oai-attestation"], undefined);
  assert.equal(headers["content-encoding"], undefined);
  assert.equal(
    directResponsesTarget(provider, "/v1/responses/compact", "?mode=test"),
    "http://127.0.0.1:17841/v1/responses/compact?mode=test",
  );
  assert.deepEqual(
    JSON.parse(directResponsesBody(
      { model: "chatgpt-web/light", client_metadata: { authority: "kept" } },
      MODEL_BY_SLUG.get("chatgpt-web/light"),
    )),
    { model: "chatgpt-web/light", client_metadata: { authority: "kept" } },
  );
});

test("non-Codex client publication omits ChatGPT Web routes", () => {
  assert.ok(!routedClientModels().models.some((model) => model.slug.startsWith("chatgpt-web/")));
});
