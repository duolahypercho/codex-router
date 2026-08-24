import { createHash, randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
} from "node:fs";
import path from "node:path";

import { credentialPaths } from "./provider-credentials.mjs";
import { writePrivateFile, writePrivateJson } from "./file-security.mjs";
import { PROVIDERS } from "./model-registry.mjs";
import {
  PROVIDER_CREDENTIAL_MIGRATIONS_DIR,
  PROVIDER_CREDENTIAL_STORE_PATH,
} from "./paths.mjs";

/**
 * Metadata for a credential is deliberately separate from the credential
 * itself. This module never accepts or writes a token, API key, cookie, or
 * OAuth secret. `secretRef` names an existing protected provider store and is
 * resolved by the provider-specific credential code when a request is made.
 */
export const PROVIDER_CREDENTIAL_SCHEMA_VERSION = 1;
export const PROVIDER_CREDENTIAL_KINDS = Object.freeze(["account", "api_key"]);
export const SECRET_REFERENCE_TYPES = Object.freeze([
  "provider-file",
  "keychain",
  "oauth-session",
  "environment",
]);

const SENSITIVE_KEY = /(?:authorization|api[-_]?key|access[-_]?token|refresh[-_]?token|secret|password|cookie|credential|private[-_]?key|signed[-_]?url)/i;
const PROVIDER_ID = /^[a-z0-9][a-z0-9-]*$/i;
const CREDENTIAL_ID = /^cred_[A-Za-z0-9_-]{16,64}$/;
const LABEL_LIMIT = 160;

function sensitiveKey(key) {
  // `secretRef` is a safe descriptor, not a secret-bearing field. Every
  // other key matching the broad pattern is rejected/redacted.
  return key !== "secretRef" && SENSITIVE_KEY.test(key);
}

function now() {
  return new Date().toISOString();
}

function emptyStore() {
  return { schemaVersion: PROVIDER_CREDENTIAL_SCHEMA_VERSION, credentials: [] };
}

function normalizeText(value, field, { max = LABEL_LIMIT, required = false } = {}) {
  if (typeof value !== "string") {
    if (required) throw new Error(`${field} must be a string.`);
    return undefined;
  }
  const normalized = value.trim();
  if (required && !normalized) throw new Error(`${field} must not be empty.`);
  if (normalized.length > max) throw new Error(`${field} is too long.`);
  return normalized || undefined;
}

function validateProviderId(value) {
  const providerId = normalizeText(value, "providerId", { max: 100, required: true });
  if (!PROVIDER_ID.test(providerId)) throw new Error(`Invalid providerId: ${providerId}`);
  return providerId;
}

function validateCredentialId(value) {
  const id = normalizeText(value, "credential id", { max: 80, required: true });
  if (!CREDENTIAL_ID.test(id)) throw new Error("Credential id must be an opaque cred_ identifier.");
  return id;
}

function generatedCredentialId(providerId, kind) {
  // Random IDs are used for new entries. Migration uses this deterministic
  // form so running the migration twice never creates duplicate references.
  const random = randomBytes(18).toString("base64url");
  return `cred_${random}`;
}

function migratedCredentialId(providerId, kind) {
  const digest = createHash("sha256")
    .update(`codex-router-provider-credential:${providerId}:${kind}`)
    .digest("base64url")
    .slice(0, 24);
  return `cred_${digest}`;
}

function assertNoSecretFields(value, context = "credential metadata") {
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    if (sensitiveKey(key)) {
      throw new Error(`${context} cannot contain secret field ${key}.`);
    }
    if (child && typeof child === "object") assertNoSecretFields(child, `${context}.${key}`);
  }
}

function normalizeSecretRef(value, providerId) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("secretRef must be an object reference; raw secrets are not accepted.");
  }
  assertNoSecretFields(value, "secretRef");
  const type = normalizeText(value.type, "secretRef.type", { max: 40, required: true });
  if (!SECRET_REFERENCE_TYPES.includes(type)) {
    throw new Error(`Unsupported secretRef type: ${type}`);
  }
  const referenceProviderId = value.providerId === undefined
    ? providerId
    : validateProviderId(value.providerId);
  const normalized = { type, providerId: referenceProviderId };
  if (type === "keychain") {
    const service = normalizeText(value.service, "secretRef.service", { max: 200, required: true });
    normalized.service = service;
  } else if (type === "environment") {
    const name = normalizeText(value.name, "secretRef.name", { max: 100, required: true });
    if (!/^[A-Z][A-Z0-9_]*$/.test(name)) throw new Error("secretRef.name must be an environment variable name.");
    normalized.name = name;
  }
  return normalized;
}

function normalizeCredential(raw, { legacy = false } = {}) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("Each credential must be an object.");
  }
  assertNoSecretFields(raw, "credential metadata");
  const providerId = validateProviderId(raw.providerId);
  const kind = normalizeText(raw.kind || (legacy ? "api_key" : undefined), "credential kind", {
    max: 20,
    required: true,
  });
  if (!PROVIDER_CREDENTIAL_KINDS.includes(kind)) {
    throw new Error(`Unsupported credential kind: ${kind}`);
  }
  const id = validateCredentialId(raw.id);
  const secretRef = normalizeSecretRef(raw.secretRef, providerId);
  const state = normalizeText(raw.state || "active", "credential state", { max: 20, required: true });
  if (!["active", "paused", "revoked"].includes(state)) {
    throw new Error(`Unsupported credential state: ${state}`);
  }
  const createdAt = normalizeText(raw.createdAt || now(), "createdAt", { max: 80, required: true });
  const updatedAt = normalizeText(raw.updatedAt || createdAt, "updatedAt", { max: 80, required: true });
  const result = {
    id,
    providerId,
    kind,
    secretRef,
    state,
    createdAt,
    updatedAt,
  };
  const label = normalizeText(raw.label, "label");
  if (label) result.label = label;
  // Account metadata is intentionally narrow. Do not persist arbitrary
  // provider responses or email/token-shaped fields in this store.
  if (raw.account && typeof raw.account === "object" && !Array.isArray(raw.account)) {
    const account = {};
    const alias = normalizeText(raw.account.alias, "account.alias");
    const plan = normalizeText(raw.account.plan, "account.plan", { max: 80 });
    if (alias) account.alias = alias;
    if (plan) account.plan = plan;
    if (Object.keys(account).length) result.account = account;
  }
  return result;
}

function normalizeStore(raw, { legacy = false } = {}) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("Credential store must be an object.");
  }
  const entries = Array.isArray(raw.credentials) ? raw.credentials : [];
  const seen = new Set();
  const credentials = entries.map((entry) => {
    const normalized = normalizeCredential(entry, { legacy });
    if (seen.has(normalized.id)) throw new Error(`Duplicate credential id: ${normalized.id}`);
    seen.add(normalized.id);
    return normalized;
  });
  return { schemaVersion: PROVIDER_CREDENTIAL_SCHEMA_VERSION, credentials };
}

function parseStore(contents, { allowLegacy = false } = {}) {
  const parsed = JSON.parse(contents);
  if (parsed?.schemaVersion === PROVIDER_CREDENTIAL_SCHEMA_VERSION) {
    return normalizeStore(parsed);
  }
  // The migration accepts the older `{ version: 1, credentials: [...] }`
  // shape used by early local experiments, but the normal reader never writes
  // it back unless an explicit migration is requested.
  if (allowLegacy && parsed?.version === 1 && Array.isArray(parsed.credentials)) {
    return normalizeStore(parsed, { legacy: true });
  }
  throw new Error("Unsupported provider credential store schema.");
}

export function readProviderCredentialStore(filePath = PROVIDER_CREDENTIAL_STORE_PATH) {
  if (!existsSync(filePath)) return emptyStore();
  try {
    return parseStore(readFileSync(filePath, "utf8"));
  } catch {
    // A malformed store must not become a source of credentials. Returning an
    // empty, safe state lets health/catalog paths continue while migration and
    // explicit writes remain strict and report the repair needed.
    return emptyStore();
  }
}

export function writeProviderCredentialStore(store, filePath = PROVIDER_CREDENTIAL_STORE_PATH) {
  const normalized = normalizeStore({
    schemaVersion: PROVIDER_CREDENTIAL_SCHEMA_VERSION,
    credentials: store?.credentials,
  });
  writePrivateJson(filePath, normalized, { directoryMode: 0o700 });
  return normalized;
}

export function createCredentialReference(input = {}) {
  assertNoSecretFields(input, "credential metadata");
  const {
    providerId,
    kind,
    secretRef,
    label,
    account,
    id,
    state,
    createdAt,
    updatedAt,
  } = input;
  const normalizedProviderId = validateProviderId(providerId);
  const credential = normalizeCredential({
    id: id || generatedCredentialId(normalizedProviderId, kind),
    providerId: normalizedProviderId,
    kind,
    secretRef,
    label,
    account,
    state,
    createdAt,
    updatedAt,
  });
  return credential;
}

export function addCredentialReference(input, filePath = PROVIDER_CREDENTIAL_STORE_PATH) {
  const store = readProviderCredentialStoreStrict(filePath);
  const credential = createCredentialReference(input);
  if (store.credentials.some((entry) => entry.id === credential.id)) {
    throw new Error(`Credential id already exists: ${credential.id}`);
  }
  store.credentials.push(credential);
  return writeProviderCredentialStore(store, filePath).credentials.at(-1);
}

export function removeCredentialReference(id, filePath = PROVIDER_CREDENTIAL_STORE_PATH) {
  const credentialId = validateCredentialId(id);
  const store = readProviderCredentialStoreStrict(filePath);
  const next = store.credentials.filter((entry) => entry.id !== credentialId);
  if (next.length === store.credentials.length) return false;
  writeProviderCredentialStore({ credentials: next }, filePath);
  return true;
}

function readProviderCredentialStoreStrict(filePath) {
  if (!existsSync(filePath)) return emptyStore();
  return parseStore(readFileSync(filePath, "utf8"));
}

export function sanitizeCredentialStatus(entry) {
  const credential = normalizeCredential(entry);
  return {
    id: credential.id,
    providerId: credential.providerId,
    kind: credential.kind,
    state: credential.state,
    label: credential.label || null,
    account: credential.account ? { ...credential.account } : null,
    secretRef: { type: credential.secretRef.type, providerId: credential.secretRef.providerId },
    createdAt: credential.createdAt,
    updatedAt: credential.updatedAt,
  };
}

export function sanitizedCredentialStore(filePath = PROVIDER_CREDENTIAL_STORE_PATH) {
  const store = readProviderCredentialStore(filePath);
  return {
    schemaVersion: store.schemaVersion,
    credentials: store.credentials.map(sanitizeCredentialStatus),
  };
}

function redactString(value) {
  let result = String(value ?? "");
  result = result
    .replace(/(authorization\s*[:=]\s*bearer\s+)[^\s"'&,}]+/gi, "$1[REDACTED]")
    .replace(/([?&](?:api[_-]?key|access[_-]?token|refresh[_-]?token|token|key)=)[^&#\s]+/gi, "$1[REDACTED]")
    .replace(/((?:["']?(?:api[_-]?key|access[_-]?token|refresh[_-]?token)["']?)\s*[:=]\s*["']?)[^\s"',}]+/gi, "$1[REDACTED]")
    .replace(/(https?:\/\/)[^\s/@:]+:[^\s/@]+@/gi, "$1[REDACTED]@[REDACTED]")
    .replace(/\b(?:sk|ghp|gho|github_pat)-[A-Za-z0-9_-]{8,}\b/g, "[REDACTED_KEY]");
  return result;
}

export function redactCredentialText(value, knownSecrets = []) {
  let result = redactString(value);
  for (const secret of knownSecrets) {
    const normalized = String(secret || "");
    if (normalized.length >= 4) result = result.replaceAll(normalized, "[REDACTED]");
  }
  return result;
}

export function redactCredentialObject(value, knownSecrets = []) {
  if (typeof value === "string") return redactCredentialText(value, knownSecrets);
  if (Array.isArray(value)) return value.map((item) => redactCredentialObject(item, knownSecrets));
  if (!value || typeof value !== "object") return value;
  const result = {};
  for (const [key, child] of Object.entries(value)) {
    result[key] = sensitiveKey(key)
      ? "[REDACTED]"
      : redactCredentialObject(child, knownSecrets);
  }
  return result;
}

function migrationTimestamp() {
  return `${new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-")}-${process.pid}`;
}

function migrationManifestPath(directory) {
  return path.join(directory, "migration.json");
}

function readMigrationManifest(manifestPath) {
  return JSON.parse(readFileSync(manifestPath, "utf8"));
}

function existingProviderFileReferences() {
  const entries = [];
  const seen = new Set();
  for (const provider of PROVIDERS.values()) {
    if (provider.kind !== "openai-compatible" || !provider.credential) continue;
    const providerId = provider.variantOf || provider.id;
    const referenceKey = `${providerId}:api_key`;
    if (seen.has(referenceKey)) continue;
    const file = credentialPaths(provider).find((candidate) => existsSync(candidate));
    if (!file) continue;
    seen.add(referenceKey);
    entries.push({
      id: migratedCredentialId(providerId, "api_key"),
      providerId,
      kind: "api_key",
      label: provider.credential.label,
      secretRef: { type: "provider-file", providerId },
      state: "active",
      createdAt: now(),
      updatedAt: now(),
    });
  }
  return entries;
}

export function migrateProviderCredentialStore(
  filePath = PROVIDER_CREDENTIAL_STORE_PATH,
  { migrationDirectory = PROVIDER_CREDENTIAL_MIGRATIONS_DIR } = {},
) {
  if (existsSync(filePath)) {
    const contents = readFileSync(filePath, "utf8");
    try {
      const current = parseStore(contents);
      return { migrated: false, store: current };
    } catch {
      // Continue only when this is the explicitly supported legacy shape. A
      // foreign or malformed file is never silently overwritten.
      const legacy = parseStore(contents, { allowLegacy: true });
      const directory = path.join(migrationDirectory, migrationTimestamp());
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      const previousPath = path.join(directory, "provider-credentials.before-migration.json");
      // Keep rollback useful without copying unknown fields from the legacy
      // document. `parseStore` already reduced it to the supported metadata
      // shape; snapshot that normalized shape instead of preserving arbitrary
      // values that may contain a secret under an unrecognised key.
      writePrivateJson(previousPath, { version: 1, credentials: legacy.credentials });
      const manifestPath = migrationManifestPath(directory);
      writePrivateJson(
        manifestPath,
        {
          schemaVersion: PROVIDER_CREDENTIAL_SCHEMA_VERSION,
          createdAt: now(),
          targetPath: filePath,
          previousExists: true,
          previousPath,
        },
        { directoryMode: 0o700 },
      );
      const store = writeProviderCredentialStore(legacy, filePath);
      writePrivateJson(
        path.join(migrationDirectory, "latest.json"),
        { schemaVersion: 1, manifestPath },
        { directoryMode: 0o700 },
      );
      return { migrated: true, store, legacy: true, manifestPath };
    }
  }

  const entries = existingProviderFileReferences();
  const store = { schemaVersion: PROVIDER_CREDENTIAL_SCHEMA_VERSION, credentials: entries };
  mkdirSync(migrationDirectory, { recursive: true, mode: 0o700 });
  const directory = path.join(migrationDirectory, migrationTimestamp());
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const snapshot = {
    schemaVersion: PROVIDER_CREDENTIAL_SCHEMA_VERSION,
    createdAt: now(),
    targetPath: filePath,
    previousExists: false,
    previousPath: null,
  };
  const manifestPath = migrationManifestPath(directory);
  writePrivateJson(manifestPath, snapshot, { directoryMode: 0o700 });
  writeProviderCredentialStore(store, filePath);
  writePrivateJson(path.join(migrationDirectory, "latest.json"), { schemaVersion: 1, manifestPath }, { directoryMode: 0o700 });
  return { migrated: true, store, manifestPath };
}

export function rollbackProviderCredentialStore(
  manifestPath,
  { migrationDirectory = PROVIDER_CREDENTIAL_MIGRATIONS_DIR } = {},
) {
  let selected = manifestPath;
  if (!selected) {
    const latestPath = path.join(migrationDirectory, "latest.json");
    if (!existsSync(latestPath)) throw new Error("No provider credential migration snapshot is available.");
    selected = JSON.parse(readFileSync(latestPath, "utf8")).manifestPath;
  }
  if (!selected || !existsSync(selected)) throw new Error("Provider credential migration snapshot is missing.");
  const manifest = readMigrationManifest(selected);
  if (manifest.schemaVersion !== PROVIDER_CREDENTIAL_SCHEMA_VERSION || typeof manifest.targetPath !== "string") {
    throw new Error("Unsupported provider credential migration snapshot.");
  }
  if (manifest.previousExists) {
    if (!manifest.previousPath || !existsSync(manifest.previousPath)) {
      throw new Error("Provider credential rollback snapshot is missing.");
    }
    writePrivateFile(manifest.targetPath, readFileSync(manifest.previousPath, "utf8"));
  } else if (existsSync(manifest.targetPath)) {
    unlinkSync(manifest.targetPath);
  }
  return { rolledBack: true, targetPath: manifest.targetPath };
}
