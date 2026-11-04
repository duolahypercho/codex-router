import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const root = mkdtempSync(path.join(os.tmpdir(), "provider-read-authority-"));
process.env.MODEL_ROUTER_STATE_DIR = root;
process.env.CODEX_ROUTER_STATE_DIR = root;
process.env.CODEX_HOME = path.join(root, "codex");
process.env.HOME = path.join(root, "home");
process.env.USERPROFILE = process.env.HOME;
process.env.MODEL_ROUTER_PROVIDER_CREDENTIAL_STORE = path.join(root, "credentials.json");
process.env.MODEL_ROUTER_API_KEY_POOL_PATH = path.join(root, "pools.json");
process.env.CODEX_ROUTER_NO_DISCOVERY = "1";
const { ensureCredentialReference } = await import("../src/provider-credential-store.mjs");
const { writeProviderCredential } = await import("../src/provider-credentials.mjs");
const { addStoredCredentialToPool, setStoredCredentialPoolState, deleteStoredCredentialPool } = await import("../src/provider-api-key-control.mjs");
const { auditProviderModels } = await import("../src/model-discovery-audit.mjs");
const { discoverProviderModels } = await import("../src/model-discovery.mjs");
const { providerAccountUsageSnapshot } = await import("../src/provider-account-usage.mjs");
const store = process.env.MODEL_ROUTER_PROVIDER_CREDENTIAL_STORE;
const pool = process.env.MODEL_ROUTER_API_KEY_POOL_PATH;
test.after(() => rmSync(root, { recursive: true, force: true }));

test("catalog and quota use the pool account and never fall around paused or invalid authority", async () => {
  process.env.DEEPSEEK_API_KEY = "SYNTHETIC_LEGACY";
  process.env.CODEX_ROUTER_NO_DISCOVERY = "0";
  writeProviderCredential("deepseek", "SYNTHETIC_POOLED");
  const entry = ensureCredentialReference({ providerId: "deepseek", kind: "api_key",
    secretRef: { type: "provider-file" } }, store).credential;
  await addStoredCredentialToPool("deepseek", entry.id, { credentialStorePath: store, poolStatePath: pool });
  const seen = [];
  const discovery = () => discoverProviderModels("deepseek", { cache: false,
    loadPayload: async (_provider, identity) => {
      seen.push(identity.credential.value);
      return { data: [{ id: "synthetic-model" }] };
    },
  });
  const usage = () => providerAccountUsageSnapshot({ providerIds: ["deepseek"], fetchImpl: async (_url, options) => {
    seen.push(options.headers.Authorization.replace(/^Bearer /, ""));
    return new Response(JSON.stringify({ is_available: true, balance_infos: [{ currency: "USD", total_balance: "1", granted_balance: "0", topped_up_balance: "1" }] }));
  }});
  const poolBeforeReads = readFileSync(pool);
  const storeBeforeReads = readFileSync(store);
  await discovery(); await usage();
  assert.deepEqual(seen, ["SYNTHETIC_POOLED", "SYNTHETIC_POOLED"]);
  const audit = await auditProviderModels({ requested: "deepseek", discover: async () => {
    throw new Error("Account SYNTHETIC_POOLED rejected");
  }});
  assert.equal(audit.summary.failed, 1);
  assert.equal(audit.results[0].error, "Account [redacted] rejected");
  assert.deepEqual(readFileSync(pool), poolBeforeReads, "read-only consumers must not advance pool state");
  assert.deepEqual(readFileSync(store), storeBeforeReads, "read-only consumers must not rewrite credential references");
  seen.length = 0;
  await setStoredCredentialPoolState("deepseek", entry.id, true, { credentialStorePath: store, poolStatePath: pool });
  await assert.rejects(discovery(), /pool is unavailable/);
  assert.equal((await usage()).deepseek.status, "not-configured");
  assert.equal((await auditProviderModels({ requested: "deepseek", discover: discovery })).summary.skipped, 1);
  assert.deepEqual(seen, []);
  const saved = readFileSync(pool);
  writeFileSync(pool, '{"version":99}');
  await assert.rejects(discovery(), /pool is unavailable/);
  assert.equal((await usage()).deepseek.status, "not-configured");
  assert.equal((await auditProviderModels({ requested: "deepseek", discover: discovery })).summary.skipped, 1);
  assert.deepEqual(seen, []);
  writeFileSync(pool, saved);
  await deleteStoredCredentialPool("deepseek", { poolStatePath: pool });
  await discovery(); await usage();
  assert.deepEqual(seen, ["SYNTHETIC_LEGACY", "SYNTHETIC_LEGACY"]);
});


test("pooled catalog identity survives dispatch rotation but rejects real credential replacement", async () => {
  process.env.CODEX_ROUTER_NO_DISCOVERY = "0";
  process.env.DEEPSEEK_API_KEY = "SYNTHETIC_SECOND";
  writeProviderCredential("deepseek", "SYNTHETIC_FIRST");
  const first = ensureCredentialReference({ providerId: "deepseek", kind: "api_key",
    secretRef: { type: "provider-file" } }, store).credential;
  const second = ensureCredentialReference({ providerId: "deepseek", kind: "api_key",
    secretRef: { type: "environment", name: "DEEPSEEK_API_KEY" } }, store).credential;
  for (const entry of [first, second]) await addStoredCredentialToPool("deepseek", entry.id,
    { credentialStorePath: store, poolStatePath: pool });
  const { setProviderApiKeyPoolPolicy, selectProviderApiKeyLocked } = await import("../src/provider-api-key-pool.mjs");
  const { resolveStoredCredential } = await import("../src/provider-api-key-routing.mjs");
  const { PROVIDERS } = await import("../src/model-registry.mjs");
  const provider = PROVIDERS.get("deepseek");
  await setProviderApiKeyPoolPolicy("deepseek", { strategy: "round-robin", priorityOrder: [first.id, second.id] }, { filePath: pool });
  const dispatch = () => selectProviderApiKeyLocked("deepseek", { filePath: pool,
    resolveCredential: id => resolveStoredCredential(provider, id, store) });
  let fetched = 0;
  const loadPayload = async (_provider, identity) => {
    fetched++;
    assert.equal(identity.credential.value, "SYNTHETIC_FIRST");
    const before = readFileSync(pool);
    assert.equal((await dispatch()).credentialId, first.id);
    assert.notDeepEqual(readFileSync(pool), before, "real dispatch must advance the cursor");
    return { data: [{ id: "synthetic-stable" }] };
  };
  const fresh = await discoverProviderModels("deepseek", { refresh: true, loadPayload });
  assert.equal(fresh.cached, false);
  const afterDispatch = readFileSync(pool);
  assert.equal((await discoverProviderModels("deepseek", { loadPayload })).cached, true);
  assert.equal(fetched, 1, "cursor rotation alone must not invalidate the cached account");
  assert.deepEqual(readFileSync(pool), afterDispatch, "catalog reads must not commit selection");
  assert.equal((await dispatch()).credentialId, second.id, "dispatch retains round-robin");
  const { upsertProviderApiKey, selectProviderApiKey } = await import("../src/provider-api-key-pool.mjs");
  await setProviderApiKeyPoolPolicy("deepseek", { strategy: "quota" }, { filePath: pool });
  for (const [entry, remaining] of [[first, 10], [second, 90]]) {
    await upsertProviderApiKey("deepseek", { id: entry.id, quota: { limit: 100, remaining } }, { filePath: pool });
  }
  const preview = await selectProviderApiKey("deepseek", { filePath: pool,
    resolveCredential: id => resolveStoredCredential(provider, id, store) });
  assert.equal(preview.credentialId, second.id, "dispatch preview still follows quota ranking");
  assert.equal((await discoverProviderModels("deepseek", { loadPayload })).cached, true);
  assert.equal(fetched, 1, "quota ranking alone must not invalidate catalog provenance");
  const audit = await auditProviderModels({ requested: "deepseek", discover: async () => {
    throw new Error("Account SYNTHETIC_FIRST rejected");
  }});
  assert.equal(audit.results[0].error, "Account [redacted] rejected");

  await assert.rejects(discoverProviderModels("deepseek", { refresh: true, loadPayload: async () => {
    writeProviderCredential("deepseek", "SYNTHETIC_REPLACEMENT");
    return { data: [{ id: "must-not-publish" }] };
  }}), /credentials changed/);
  await setStoredCredentialPoolState("deepseek", first.id, true, { credentialStorePath: store, poolStatePath: pool });
  let replacementFetches = 0;
  assert.equal((await discoverProviderModels("deepseek", { loadPayload: async (_provider, identity) => {
    replacementFetches++;
    assert.equal(identity.credential.value, "SYNTHETIC_SECOND");
    return { data: [{ id: "second-account-only" }] };
  }})).cached, false, "paused catalog credential invalidates its stored list");
  assert.equal(replacementFetches, 1);
  await setStoredCredentialPoolState("deepseek", second.id, true, { credentialStorePath: store, poolStatePath: pool });
  await assert.rejects(discoverProviderModels("deepseek", { loadPayload: () => assert.fail("cached data cannot bypass paused authority") }), /pool is unavailable/);
});
