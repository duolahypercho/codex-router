import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const root = mkdtempSync(path.join(os.tmpdir(), "codex-router-credential-store-"));
process.env.CODEX_HOME = path.join(root, "codex");
process.env.CODEX_ROUTER_STATE_DIR = path.join(root, "state");
process.env.MODEL_ROUTER_PROVIDER_CREDENTIAL_STORE = path.join(root, "state", "provider-credentials.json");
process.env.MODEL_ROUTER_PROVIDER_CREDENTIAL_MIGRATIONS = path.join(root, "state", "migrations", "provider-credentials");
for (const name of ["DEEPSEEK_API_KEY", "OPENROUTER_API_KEY", "ANTHROPIC_API_KEY"]) delete process.env[name];

const {
  addCredentialReference,
  migrateProviderCredentialStore,
  PROVIDER_CREDENTIAL_SCHEMA_VERSION,
  readProviderCredentialStore,
  redactCredentialObject,
  redactCredentialText,
  removeCredentialReference,
  rollbackProviderCredentialStore,
  sanitizeCredentialStatus,
  sanitizedCredentialStore,
  writeProviderCredentialStore,
} = await import("../src/provider-credential-store.mjs");
const { writeProviderCredential } = await import("../src/provider-credentials.mjs");
const { privateFileIsProtected } = await import("../src/file-security.mjs");

test.after(() => rmSync(root, { recursive: true, force: true }));

test("credential references contain no secret and use protected metadata storage", () => {
  const filePath = path.join(root, "state", "references.json");
  const entry = addCredentialReference(
    {
      providerId: "deepseek",
      kind: "api_key",
      secretRef: { type: "provider-file" },
      label: "Primary DeepSeek",
      account: { alias: "main", plan: "api" },
    },
    filePath,
  );
  assert.match(entry.id, /^cred_[A-Za-z0-9_-]{16,64}$/);
  assert.equal(entry.secretRef.providerId, "deepseek");
  assert.equal("value" in entry, false);
  assert.equal(privateFileIsProtected(filePath), true);
  if (process.platform !== "win32") assert.equal(statSync(filePath).mode & 0o777, 0o600);
  const raw = readFileSync(filePath, "utf8");
  assert.doesNotMatch(raw, /api[_-]?key\s*[:=]/i);
  assert.deepEqual(sanitizedCredentialStore(filePath).credentials[0], sanitizeCredentialStatus(entry));
  assert.equal(removeCredentialReference(entry.id, filePath), true);
  assert.deepEqual(readProviderCredentialStore(filePath).credentials, []);
});

test("raw secret fields are rejected instead of being copied into the store", () => {
  const filePath = path.join(root, "state", "reject.json");
  assert.throws(
    () => addCredentialReference({
      providerId: "deepseek",
      kind: "api_key",
      secretRef: { type: "provider-file" },
      apiKey: "TEST_DO_NOT_STORE",
    }, filePath),
    /secret field apiKey/,
  );
  assert.equal(existsSync(filePath), false);
});

test("redaction covers headers, URLs, errors, nested objects, and known secrets", () => {
  const text = [
    "Authorization: Bearer TEST_BEARER_TOKEN",
    "https://user:password@example.test/v1?api_key=QUERY_SECRET",
    "{\"access_token\":\"JSON_SECRET\",\"message\":\"TEST_KNOWN_SECRET\"}",
    "sk-test_secret_value",
  ].join(" ");
  const redacted = redactCredentialText(text, ["TEST_KNOWN_SECRET"]);
  assert.doesNotMatch(redacted, /TEST_BEARER_TOKEN|password|QUERY_SECRET|JSON_SECRET|TEST_KNOWN_SECRET|sk-test_secret_value/);
  const object = redactCredentialObject({
    headers: { Authorization: "Bearer TEST_HEADER_SECRET" },
    nested: { refreshToken: "TEST_REFRESH_SECRET", message: "TEST_KNOWN_SECRET" },
  }, ["TEST_KNOWN_SECRET"]);
  assert.equal(object.headers.Authorization, "[REDACTED]");
  assert.equal(object.nested.refreshToken, "[REDACTED]");
  assert.equal(object.nested.message, "[REDACTED]");
});

test("migration discovers existing protected provider files without copying secrets", () => {
  const filePath = path.join(root, "state", "migrated.json");
  const migrationDirectory = path.join(root, "state", "migration-test");
  const providerPath = writeProviderCredential("deepseek", "TEST_MIGRATION_SECRET");
  const first = migrateProviderCredentialStore(filePath, { migrationDirectory });
  assert.equal(first.migrated, true);
  assert.equal(first.store.schemaVersion, PROVIDER_CREDENTIAL_SCHEMA_VERSION);
  assert.equal(first.store.credentials.some((entry) => entry.providerId === "deepseek"), true);
  assert.doesNotMatch(readFileSync(filePath, "utf8"), /TEST_MIGRATION_SECRET/);
  assert.equal(privateFileIsProtected(first.manifestPath), true);
  const second = migrateProviderCredentialStore(filePath, { migrationDirectory });
  assert.equal(second.migrated, false, "the second run must be idempotent");

  rollbackProviderCredentialStore(first.manifestPath, { migrationDirectory });
  assert.equal(existsSync(filePath), false);
  assert.equal(readFileSync(providerPath, "utf8"), "TEST_MIGRATION_SECRET\n");
});

test("legacy metadata migration creates a protected rollback snapshot", () => {
  const filePath = path.join(root, "state", "legacy.json");
  const migrationDirectory = path.join(root, "state", "legacy-migration-test");
  const legacy = {
    version: 1,
    credentials: [{
      id: "cred_legacy_reference_123456",
      providerId: "openrouter",
      kind: "api_key",
      secretRef: { type: "provider-file" },
      state: "active",
    }],
    // Unknown legacy fields are deliberately discarded from the rollback
    // snapshot; they are not part of the supported metadata contract.
    opaque: "TEST_LEGACY_SECRET",
  };
  writeFileSync(filePath, `${JSON.stringify(legacy)}\n`, { mode: 0o600 });
  const migration = migrateProviderCredentialStore(filePath, { migrationDirectory });
  assert.equal(migration.legacy, true);
  assert.equal(JSON.parse(readFileSync(filePath, "utf8")).schemaVersion, 1);
  assert.equal(privateFileIsProtected(path.join(migrationDirectory, "latest.json")), true);
  const snapshot = readFileSync(path.join(path.dirname(migration.manifestPath), "provider-credentials.before-migration.json"), "utf8");
  assert.doesNotMatch(snapshot, /TEST_LEGACY_SECRET/);
  rollbackProviderCredentialStore(undefined, { migrationDirectory });
  const rolledBack = JSON.parse(readFileSync(filePath, "utf8"));
  assert.equal(rolledBack.version, 1);
  assert.equal(rolledBack.credentials.length, 1);
  assert.equal(rolledBack.credentials[0].id, legacy.credentials[0].id);
  assert.equal(rolledBack.credentials[0].secretRef.providerId, "openrouter");
  assert.equal("opaque" in rolledBack, false);
});
