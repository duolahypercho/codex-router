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
  await discovery(); await usage();
  assert.deepEqual(seen, ["SYNTHETIC_POOLED", "SYNTHETIC_POOLED"]);
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
