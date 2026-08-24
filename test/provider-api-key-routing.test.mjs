import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const root = mkdtempSync(path.join(os.tmpdir(), "codex-router-api-key-routing-"));
process.env.CODEX_HOME = path.join(root, "codex");
process.env.CODEX_ROUTER_STATE_DIR = path.join(root, "state");
delete process.env.OPENROUTER_API_KEY;

const { PROVIDERS } = await import("../src/model-registry.mjs");
const { writeProviderCredential, resolveProviderCredentialReference } = await import("../src/provider-credentials.mjs");
const { resolveProviderApiKeyForRequest } = await import("../src/provider-api-key-routing.mjs");
const { setProviderApiKeyPaused, upsertProviderApiKey } = await import("../src/provider-api-key-pool.mjs");

const provider = PROVIDERS.get("openrouter");
const opencodeMessages = PROVIDERS.get("opencode-go-messages");
const statePath = path.join(root, "pool.json");
const credentialId = "cred_primary_12345678";

test.after(() => rmSync(root, { recursive: true, force: true }));

test("registry-bound provider-file references resolve without accepting arbitrary paths", async () => {
  writeProviderCredential(provider, "POOL_PRIMARY_SECRET");
  const reference = {
    type: "provider-file",
    name: provider.credential.file,
  };
  assert.equal(resolveProviderCredentialReference(provider, reference)?.value, "POOL_PRIMARY_SECRET");
  assert.throws(
    () => resolveProviderCredentialReference(provider, { type: "provider-file", name: "../outside.secret" }),
    /not declared/,
  );
  await upsertProviderApiKey(provider.id, {
    id: credentialId,
    secretRef: reference,
  }, { filePath: statePath });
  const routing = await resolveProviderApiKeyForRequest(provider, { poolStatePath: statePath });
  assert.equal(routing.pooled, true);
  assert.equal(routing.fallbackAllowed, false);
  assert.equal(routing.credential.value, "POOL_PRIMARY_SECRET");
});

test("an empty configured pool refuses the legacy key instead of silently using it", async () => {
  await setProviderApiKeyPaused(provider.id, credentialId, true, { filePath: statePath });
  const routing = await resolveProviderApiKeyForRequest(provider, { poolStatePath: statePath });
  assert.equal(routing.pooled, true);
  assert.equal(routing.credential, undefined);
  assert.equal(routing.fallbackAllowed, false);
});

test("protocol variants use the canonical provider pool", async () => {
  const opencodeStatePath = path.join(root, "opencode-pool.json");
  writeProviderCredential(PROVIDERS.get("opencode-go"), "OPENCODE_POOL_SECRET");
  await upsertProviderApiKey("opencode-go", {
    id: "cred_opencode_12345678",
    secretRef: {
      type: "provider-file",
      name: opencodeMessages.credential.file,
    },
  }, { filePath: opencodeStatePath });
  const routing = await resolveProviderApiKeyForRequest(opencodeMessages, {
    poolStatePath: opencodeStatePath,
  });
  assert.equal(routing.pooled, true);
  assert.equal(routing.credential?.value, "OPENCODE_POOL_SECRET");
  assert.equal(routing.selection?.providerId, "opencode-go");
});
