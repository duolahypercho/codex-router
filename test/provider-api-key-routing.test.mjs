import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const root = mkdtempSync(path.join(os.tmpdir(), "codex-router-api-key-routing-"));
process.env.CODEX_HOME = path.join(root, "codex");
process.env.CODEX_ROUTER_STATE_DIR = path.join(root, "state");
process.env.MODEL_ROUTER_STATE_DIR = process.env.CODEX_ROUTER_STATE_DIR;
process.env.MODEL_ROUTER_PROVIDER_CREDENTIAL_STORE = path.join(root, "state", "provider-credentials.json");
delete process.env.OPENROUTER_API_KEY;

const { MODEL_BY_SLUG, PROVIDERS, endpointForModel } = await import("../src/model-registry.mjs");
const { writeProviderCredential } = await import("../src/provider-credentials.mjs");
const { addCredentialReference } = await import("../src/provider-credential-store.mjs");
const { resolveProviderApiKeyForRequest } = await import("../src/provider-api-key-routing.mjs");
const { setProviderApiKeyPaused, upsertProviderApiKey } = await import("../src/provider-api-key-pool.mjs");

const provider = PROVIDERS.get("openrouter");
const opencodeMessages = PROVIDERS.get("opencode-go-messages");
const statePath = path.join(root, "state", "pool.json");
const credentialStorePath = process.env.MODEL_ROUTER_PROVIDER_CREDENTIAL_STORE;
let credentialId;

test.after(() => rmSync(root, { recursive: true, force: true }));

test.before(async () => {
  writeProviderCredential(provider, "POOL_PRIMARY_SECRET");
  credentialId = addCredentialReference({
    providerId: provider.id,
    kind: "api_key",
    secretRef: { type: "provider-file" },
  }, credentialStorePath).id;
  await upsertProviderApiKey(provider.id, { id: credentialId }, { filePath: statePath });
});

test("per-model endpoint identities bypass provider-level API-key pools", async () => {
  const endpoint = endpointForModel(MODEL_BY_SLUG.get("custom/qwen3.8-27b"));
  assert.equal(endpoint.id, "custom/qwen3.8-27b");

  const routing = await resolveProviderApiKeyForRequest(endpoint, {
    poolStatePath: statePath,
    credentialStorePath,
  });

  assert.equal(routing.pooled, false);
  assert.equal(routing.configured, false);
  assert.equal(routing.fallbackAllowed, true);
  assert.equal(routing.credential?.source, "official anonymous endpoint");
});

test("credential-store ids resolve through registry-bound references", async () => {
  const routing = await resolveProviderApiKeyForRequest(provider, { poolStatePath: statePath, credentialStorePath });
  assert.equal(routing.pooled, true);
  assert.equal(routing.fallbackAllowed, false);
  assert.equal(routing.credential.value, "POOL_PRIMARY_SECRET");
});

test("an empty configured pool refuses the legacy key instead of silently using it", async () => {
  await setProviderApiKeyPaused(provider.id, credentialId, true, { filePath: statePath });
  const routing = await resolveProviderApiKeyForRequest(provider, { poolStatePath: statePath, credentialStorePath });
  assert.equal(routing.pooled, true);
  assert.equal(routing.credential, undefined);
  assert.equal(routing.fallbackAllowed, false);
});

test("protocol variants use the canonical provider pool", async () => {
  const opencodeStatePath = path.join(root, "state", "opencode-pool.json");
  writeProviderCredential(PROVIDERS.get("opencode-go"), "OPENCODE_POOL_SECRET");
  const opencodeId = addCredentialReference({
    providerId: "opencode-go",
    kind: "api_key",
    secretRef: { type: "provider-file" },
  }, credentialStorePath).id;
  await upsertProviderApiKey("opencode-go", { id: opencodeId }, { filePath: opencodeStatePath });
  const routing = await resolveProviderApiKeyForRequest(opencodeMessages, {
    poolStatePath: opencodeStatePath,
    credentialStorePath,
  });
  assert.equal(routing.pooled, true);
  assert.equal(routing.credential?.value, "OPENCODE_POOL_SECRET");
  assert.equal(routing.selection?.providerId, "opencode-go");
});
