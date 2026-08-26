import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

import { withAtomicStateLock } from "./atomic-state-lock.mjs";
import { credentialPaths } from "./provider-credentials.mjs";
import { protectPrivateFile } from "./file-security.mjs";
import { normalizeGenericProviderId } from "./generic-provider-identity.mjs";
import { PROVIDERS } from "./model-registry.mjs";
import {
  CODEX_HOME,
  PROVIDER_CREDENTIAL_MIGRATIONS_DIR,
  PROVIDER_CREDENTIAL_STORE_PATH,
  ROUTER_PLANE_TARGET,
  STATE_DIR,
} from "./paths.mjs";

/**
 * Metadata for a credential is deliberately separate from the credential
 * itself. This module never accepts or writes a token, API key, cookie, or
 * OAuth secret. `secretRef` names an existing protected provider store and is
 * resolved by the provider-specific credential code when a request is made.
 */
export const PROVIDER_CREDENTIAL_SCHEMA_VERSION = 2;
export const PROVIDER_CREDENTIAL_KINDS = Object.freeze(["account", "api_key"]);
export const SECRET_REFERENCE_TYPES = Object.freeze([
  "provider-file",
  "keychain",
  "environment",
]);

const SENSITIVE_KEY = /(?:authorization|api[-_]?key|access[-_]?token|refresh[-_]?token|token|secret|password|cookie|credential|private[-_]?key|signed[-_]?url)/i;
const CREDENTIAL_ID = /^cred_[A-Za-z0-9_-]{16,64}$/;
const LABEL_LIMIT = 160;
const STORE_KEYS = new Set(["schemaVersion", "credentials"]);
const LEGACY_STORE_KEYS = new Set(["version", "credentials"]);
const CREDENTIAL_KEYS = new Set([
  "id",
  "providerId",
  "providerType",
  "kind",
  "secretRef",
  "state",
  "createdAt",
  "updatedAt",
  "label",
  "account",
]);
const ACCOUNT_KEYS = new Set(["alias", "plan"]);
const SECRET_REF_KEYS = new Set(["type", "providerId", "target", "service", "name"]);
const CREDENTIAL_INPUT_KEYS = new Set([
  "providerId", "kind", "secretRef", "label", "account", "id", "state", "createdAt", "updatedAt",
]);

function sensitiveKey(key) {
  // `secretRef` is a safe descriptor, not a secret-bearing field.
  return !["secretRef", "credentials"].includes(key) && SENSITIVE_KEY.test(key);
}

function plainObject(value, field) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${field} must be an object.`);
  }
  return value;
}

function assertAllowedKeys(value, allowed, field) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new Error(`${field} contains unsupported field ${key}.`);
  }
}

function isWithin(base, target) {
  const relative = path.relative(base, target);
  return relative === "" || (
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

function assertNoSymlinkComponents(target, field, boundary) {
  const absolute = path.resolve(target);
  const base = boundary ? path.resolve(boundary) : undefined;
  const root = path.parse(absolute).root;
  const components = absolute.slice(root.length).split(path.sep).filter(Boolean);
  let current = root;
  for (const component of components) {
    current = path.join(current, component);
    try {
      const atOrBelowBoundary = !base || isWithin(base, current);
      if (atOrBelowBoundary && lstatSync(current).isSymbolicLink()) {
        throw new Error(`${field} cannot contain a symbolic link.`);
      }
    } catch (error) {
      if (error?.code === "ENOENT") break;
      throw error;
    }
  }
}

function managedStatePath(value, field, { allowDirectory = false } = {}) {
  if (typeof value !== "string" || !path.isAbsolute(value)) {
    throw new Error(`${field} must be an absolute path.`);
  }
  const target = path.resolve(value);
  const base = path.resolve(STATE_DIR);
  if (!isWithin(base, target) || (!allowDirectory && target === base)) {
    throw new Error(`${field} must stay inside the router state directory.`);
  }
  assertNoSymlinkComponents(target, field, base);
  return target;
}

function managedSourcePath(value, field) {
  if (typeof value !== "string" || !path.isAbsolute(value)) {
    throw new Error(`${field} must be an absolute path.`);
  }
  const target = path.resolve(value);
  const bases = [path.resolve(CODEX_HOME), path.resolve(STATE_DIR)];
  const base = bases.find((candidate) => isWithin(candidate, target));
  if (!base || target === base) {
    throw new Error(`${field} must stay inside a managed credential directory.`);
  }
  assertNoSymlinkComponents(target, field, base);
  return target;
}

function readRegularBytes(filePath, field) {
  const target = path.resolve(filePath);
  let stat;
  try {
    stat = lstatSync(target);
  } catch (error) {
    if (error?.code === "ENOENT") return undefined;
    throw error;
  }
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error(`${field} must be a regular file.`);
  }
  return readFileSync(target);
}

function atomicPrivateBytes(filePath, bytes, { directoryMode = 0o700 } = {}) {
  const target = managedStatePath(filePath, "target path");
  const directory = path.dirname(target);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(directory, directoryMode);
  const temporary = path.join(
    directory,
    `.${path.basename(target)}.tmp-${process.pid}-${randomBytes(8).toString("hex")}`,
  );
  try {
    writeFileSync(temporary, bytes, { mode: 0o600 });
    protectPrivateFile(temporary);
    renameSync(temporary, target);
    protectPrivateFile(target);
  } catch (error) {
    try { unlinkSync(temporary); } catch (cleanupError) {
      if (cleanupError?.code !== "ENOENT") error.cleanupError = cleanupError;
    }
    throw error;
  }
  return target;
}

function restoreMigrationTarget(target, before, after) {
  const current = readRegularBytes(target, "credential store");
  const afterDigest = sha256(after);
  if (current === undefined || sha256(current) !== afterDigest) return;
  if (before === undefined) {
    unlinkSync(target);
  } else {
    atomicPrivateBytes(target, before);
  }
}

function serializedStore(store) {
  return Buffer.from(`${JSON.stringify(store, null, 2)}\n`, "utf8");
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
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
  const provider = PROVIDERS.get(providerId);
  if (!provider || provider.kind !== "openai-compatible" || !provider.credential) {
    throw new Error(`Invalid providerId: ${providerId}`);
  }
  return provider.variantOf || provider.id;
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

function normalizeSecretRef(value, providerId, { legacy = false, providerType } = {}) {
  plainObject(value, "secretRef");
  assertNoSecretFields(value, "secretRef");
  assertAllowedKeys(value, SECRET_REF_KEYS, "secretRef");
  const type = normalizeText(value.type, "secretRef.type", { max: 40, required: true });
  if (!SECRET_REFERENCE_TYPES.includes(type)) {
    throw new Error(`Unsupported secretRef type: ${type}`);
  }
  const referenceProviderId = value.providerId === undefined
    ? providerId
    : providerType === "generic"
      ? normalizeGenericProviderId(value.providerId)
      : validateProviderId(value.providerId);
  if (referenceProviderId !== providerId) {
    throw new Error("secretRef.providerId must match providerId.");
  }
  const target = value.target === undefined && legacy ? ROUTER_PLANE_TARGET : normalizeText(
    value.target,
    "secretRef.target",
    { max: 20, required: true },
  );
  if (target !== ROUTER_PLANE_TARGET) throw new Error("secretRef.target does not match this router plane.");
  const normalized = { type, providerId: referenceProviderId, target };
  if (providerType === "generic") {
    if (type !== "provider-file") {
      throw new Error("Generic providers support only protected provider-file credential references.");
    }
    if (value.service !== undefined || value.name !== undefined) {
      throw new Error("Generic provider-file secretRef cannot include service or name.");
    }
    return normalized;
  }
  const provider = PROVIDERS.get(referenceProviderId);
  if (!provider?.credential) throw new Error(`Provider ${referenceProviderId} has no credential policy.`);
  if (type === "keychain") {
    const service = normalizeText(value.service, "secretRef.service", { max: 200, required: true });
    if (!provider.credential.keychainServices?.includes(service)) {
      throw new Error("secretRef.service is not configured for this provider.");
    }
    normalized.service = service;
  } else if (type === "environment") {
    const name = normalizeText(value.name, "secretRef.name", { max: 100, required: true });
    if (!provider.credential.environment?.includes(name)) {
      throw new Error("secretRef.name is not configured for this provider.");
    }
    normalized.name = name;
  }
  if (type === "provider-file" && (value.service !== undefined || value.name !== undefined)) {
    throw new Error("provider-file secretRef cannot include service or name.");
  }
  if (type === "keychain" && value.name !== undefined) {
    throw new Error("keychain secretRef cannot include name.");
  }
  if (type === "environment" && value.service !== undefined) {
    throw new Error("environment secretRef cannot include service.");
  }
  return normalized;
}

function normalizeCredential(raw, { legacy = false } = {}) {
  plainObject(raw, "credential");
  assertNoSecretFields(raw, "credential metadata");
  assertAllowedKeys(raw, CREDENTIAL_KEYS, "credential");
  const providerType = raw.providerType === undefined
    ? undefined
    : normalizeText(raw.providerType, "providerType", { max: 20, required: true });
  if (providerType !== undefined && providerType !== "generic") {
    throw new Error(`Unsupported providerType: ${providerType}`);
  }
  if (legacy && providerType !== undefined) {
    throw new Error("Legacy credentials cannot declare providerType.");
  }
  const providerId = providerType === "generic"
    ? normalizeGenericProviderId(raw.providerId)
    : validateProviderId(raw.providerId);
  const kind = normalizeText(raw.kind || (legacy ? "api_key" : undefined), "credential kind", {
    max: 20,
    required: true,
  });
  if (!PROVIDER_CREDENTIAL_KINDS.includes(kind)) {
    throw new Error(`Unsupported credential kind: ${kind}`);
  }
  if (providerType === "generic" && kind !== "api_key") {
    throw new Error("Generic providers support only api_key credentials.");
  }
  const id = validateCredentialId(raw.id);
  const secretRef = normalizeSecretRef(raw.secretRef, providerId, { legacy, providerType });
  const state = normalizeText(raw.state || "active", "credential state", { max: 20, required: true });
  if (!["active", "paused", "revoked"].includes(state)) {
    throw new Error(`Unsupported credential state: ${state}`);
  }
  const createdAt = normalizeText(raw.createdAt || now(), "createdAt", { max: 80, required: true });
  const updatedAt = normalizeText(raw.updatedAt || createdAt, "updatedAt", { max: 80, required: true });
  const result = {
    id,
    providerId,
    ...(providerType ? { providerType } : {}),
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
  if (raw.account !== undefined) {
    plainObject(raw.account, "account");
    assertAllowedKeys(raw.account, ACCOUNT_KEYS, "account");
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
  plainObject(raw, "Credential store");
  assertNoSecretFields(raw, "Credential store");
  assertAllowedKeys(raw, legacy ? LEGACY_STORE_KEYS : STORE_KEYS, "Credential store");
  if (!Array.isArray(raw.credentials)) throw new Error("Credential store credentials must be an array.");
  if (!legacy && raw.schemaVersion !== PROVIDER_CREDENTIAL_SCHEMA_VERSION) {
    throw new Error("Unsupported provider credential store schema.");
  }
  const entries = raw.credentials;
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
  if (typeof contents !== "string" && !Buffer.isBuffer(contents)) {
    throw new Error("Credential store contents must be bytes.");
  }
  let parsed;
  try {
    parsed = JSON.parse(Buffer.from(contents).toString("utf8"));
  } catch {
    throw new Error("Credential store is not valid JSON.");
  }
  if (parsed?.schemaVersion === PROVIDER_CREDENTIAL_SCHEMA_VERSION) {
    return normalizeStore(parsed);
  }
  if (
    allowLegacy &&
    ((parsed?.version === 1) || (parsed?.schemaVersion === 1)) &&
    Array.isArray(parsed.credentials)
  ) {
    assertAllowedKeys(
      parsed,
      parsed.version === 1 ? LEGACY_STORE_KEYS : new Set(["schemaVersion", "credentials"]),
      "Credential store",
    );
    return normalizeStore({ version: 1, credentials: parsed.credentials }, { legacy: true });
  }
  throw new Error("Unsupported provider credential store schema.");
}

export function readProviderCredentialStore(filePath = PROVIDER_CREDENTIAL_STORE_PATH) {
  const target = managedStatePath(filePath, "credential store path");
  if (!existsSync(target)) return emptyStore();
  try {
    return parseStore(readRegularBytes(target, "credential store"));
  } catch {
    // A malformed store must not become a source of credentials. Returning an
    // empty, safe state lets health/catalog paths continue while migration and
    // explicit writes remain strict and report the repair needed.
    return emptyStore();
  }
}

export function writeProviderCredentialStore(store, filePath = PROVIDER_CREDENTIAL_STORE_PATH) {
  const target = managedStatePath(filePath, "credential store path");
  plainObject(store, "Credential store");
  assertNoSecretFields(store, "Credential store");
  assertAllowedKeys(store, STORE_KEYS, "Credential store");
  if (store.schemaVersion !== undefined && store.schemaVersion !== PROVIDER_CREDENTIAL_SCHEMA_VERSION) {
    throw new Error("Unsupported provider credential store schema.");
  }
  const normalized = normalizeStore({
    schemaVersion: PROVIDER_CREDENTIAL_SCHEMA_VERSION,
    credentials: store?.credentials,
  });
  atomicPrivateBytes(target, serializedStore(normalized));
  return normalized;
}

function createCredentialReferenceForType(input = {}, providerType) {
  assertNoSecretFields(input, "credential metadata");
  plainObject(input, "credential metadata");
  assertAllowedKeys(input, CREDENTIAL_INPUT_KEYS, "credential metadata");
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
  const normalizedProviderId = providerType === "generic"
    ? normalizeGenericProviderId(providerId)
    : validateProviderId(providerId);
  const credential = normalizeCredential({
    id: id || generatedCredentialId(normalizedProviderId, kind),
    providerId: normalizedProviderId,
    ...(providerType ? { providerType } : {}),
    kind: providerType === "generic" ? (kind || "api_key") : kind,
    secretRef: secretRef && typeof secretRef === "object"
      ? { ...secretRef, target: secretRef.target ?? ROUTER_PLANE_TARGET }
      : providerType === "generic"
        ? { type: "provider-file", providerId: normalizedProviderId, target: ROUTER_PLANE_TARGET }
        : secretRef,
    label,
    account,
    state,
    createdAt,
    updatedAt,
  });
  return credential;
}

export function createCredentialReference(input = {}) {
  return createCredentialReferenceForType(input);
}

export function createGenericProviderCredentialReference(input = {}) {
  return createCredentialReferenceForType(input, "generic");
}

function addCredentialReferenceWith(input, filePath, create) {
  const target = managedStatePath(filePath, "credential store path");
  return withAtomicStateLock(target, () => {
    const store = readProviderCredentialStoreStrict(target);
    const credential = create(input);
    if (store.credentials.some((entry) => entry.id === credential.id)) {
      throw new Error(`Credential id already exists: ${credential.id}`);
    }
    store.credentials.push(credential);
    return writeProviderCredentialStore(store, target).credentials.at(-1);
  });
}

export function addCredentialReference(input, filePath = PROVIDER_CREDENTIAL_STORE_PATH) {
  return addCredentialReferenceWith(input, filePath, createCredentialReference);
}

export function addGenericProviderCredentialReference(input, filePath = PROVIDER_CREDENTIAL_STORE_PATH) {
  return addCredentialReferenceWith(input, filePath, createGenericProviderCredentialReference);
}

export function removeCredentialReference(id, filePath = PROVIDER_CREDENTIAL_STORE_PATH) {
  const credentialId = validateCredentialId(id);
  const target = managedStatePath(filePath, "credential store path");
  return withAtomicStateLock(target, () => {
    const store = readProviderCredentialStoreStrict(target);
    const next = store.credentials.filter((entry) => entry.id !== credentialId);
    if (next.length === store.credentials.length) return false;
    writeProviderCredentialStore({ credentials: next }, target);
    return true;
  });
}

function readProviderCredentialStoreStrict(filePath) {
  const target = managedStatePath(filePath, "credential store path");
  if (!existsSync(target)) return emptyStore();
  return parseStore(readRegularBytes(target, "credential store"));
}

export function sanitizeCredentialStatus(entry) {
  const credential = normalizeCredential(entry);
  return {
    id: credential.id,
    providerId: credential.providerId,
    ...(credential.providerType ? { providerType: credential.providerType } : {}),
    kind: credential.kind,
    state: credential.state,
    label: credential.label || null,
    account: credential.account ? { ...credential.account } : null,
    secretRef: {
      type: credential.secretRef.type,
      providerId: credential.secretRef.providerId,
      target: credential.secretRef.target,
    },
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
    .replace(/((?:x[-_]?api[-_]?key|api[_-]?key|access[-_]?token|refresh[-_]?token|token|key)\s*[:=]\s*(?:bearer\s+)?)[^\s"'&,}]+/gi, "$1[REDACTED]")
    .replace(/([?&](?:x[-_]?api[-_]?key|api[_-]?key|access[-_]?token|refresh[-_]?token|token|key)=)[^&#\s]+/gi, "$1[REDACTED]")
    .replace(/((?:["']?(?:x[-_]?api[-_]?key|api[_-]?key|access[-_]?token|refresh[-_]?token|token|secret)["']?)\s*[:=]\s*["']?)([^\s"',}]+)/gi, "$1[REDACTED]")
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
  return `${new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-")}-${process.pid}-${randomBytes(6).toString("hex")}`;
}

function migrationManifestPath(directory) {
  return path.join(directory, "migration.json");
}

function readMigrationManifest(manifestPath, migrationDirectory, expectedTarget) {
  const selected = managedStatePath(manifestPath, "migration manifest path");
  const directory = managedStatePath(migrationDirectory, "migration directory", { allowDirectory: true });
  if (!isWithin(directory, selected) || path.basename(selected) !== "migration.json") {
    throw new Error("Migration manifest must stay inside the migration directory.");
  }
  const parsed = JSON.parse(readRegularBytes(selected, "migration manifest").toString("utf8"));
  plainObject(parsed, "migration manifest");
  assertAllowedKeys(parsed, new Set([
    "schemaVersion", "createdAt", "targetPath", "previousExists", "previousPath", "previousSha256", "afterSha256",
  ]), "migration manifest");
  if (parsed.schemaVersion !== PROVIDER_CREDENTIAL_SCHEMA_VERSION || typeof parsed.targetPath !== "string") {
    throw new Error("Unsupported provider credential migration snapshot.");
  }
  const target = managedStatePath(parsed.targetPath, "migration target path");
  if (target !== expectedTarget) throw new Error("Migration target does not match the requested store.");
  if (typeof parsed.afterSha256 !== "string" || !/^[a-f0-9]{64}$/.test(parsed.afterSha256)) {
    throw new Error("Migration snapshot has no valid post-migration digest.");
  }
  if (typeof parsed.previousExists !== "boolean") throw new Error("Migration snapshot has invalid previous state.");
  if (parsed.previousExists) {
    const previous = managedStatePath(parsed.previousPath, "migration rollback path");
    if (path.dirname(previous) !== path.dirname(selected) || path.basename(previous) !== "provider-credentials.before-migration.json") {
      throw new Error("Migration rollback path is outside its snapshot directory.");
    }
    if (typeof parsed.previousSha256 !== "string" || !/^[a-f0-9]{64}$/.test(parsed.previousSha256)) {
      throw new Error("Migration snapshot has no valid previous digest.");
    }
    parsed.previousPath = previous;
  } else if (parsed.previousPath !== null || parsed.previousSha256 !== null) {
    throw new Error("Migration snapshot has an unexpected previous path.");
  }
  parsed.targetPath = target;
  return parsed;
}

function existingProviderFileReferences() {
  const entries = [];
  const seen = new Set();
  for (const provider of PROVIDERS.values()) {
    if (provider.kind !== "openai-compatible" || !provider.credential) continue;
    const providerId = provider.variantOf || provider.id;
    const referenceKey = `${providerId}:api_key`;
    if (seen.has(referenceKey)) continue;
    const file = credentialPaths(provider).map((candidate) => {
      try {
        const managed = managedSourcePath(candidate, "provider credential path");
        return readRegularBytes(managed, "provider credential") === undefined ? undefined : managed;
      } catch {
        return undefined;
      }
    }).find(Boolean);
    if (!file) continue;
    seen.add(referenceKey);
    entries.push({
      id: migratedCredentialId(providerId, "api_key"),
      providerId,
      kind: "api_key",
      label: provider.credential.label,
      secretRef: { type: "provider-file", providerId, target: ROUTER_PLANE_TARGET },
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
  const target = managedStatePath(filePath, "credential store path");
  const migrations = managedStatePath(migrationDirectory, "migration directory", { allowDirectory: true });
  const existing = readRegularBytes(target, "credential store");
  if (existing !== undefined) {
    try {
      const current = parseStore(existing);
      return { migrated: false, store: current };
    } catch {
      const legacy = parseStore(existing, { allowLegacy: true });
      const directory = path.join(migrations, migrationTimestamp());
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      const previousPath = path.join(directory, "provider-credentials.before-migration.json");
      const store = {
        schemaVersion: PROVIDER_CREDENTIAL_SCHEMA_VERSION,
        credentials: legacy.credentials,
      };
      const after = serializedStore(store);
      const manifestPath = migrationManifestPath(directory);
      try {
        atomicPrivateBytes(previousPath, existing);
        atomicPrivateBytes(manifestPath, Buffer.from(JSON.stringify({
          schemaVersion: PROVIDER_CREDENTIAL_SCHEMA_VERSION,
          createdAt: now(),
          targetPath: target,
          previousExists: true,
          previousPath,
          previousSha256: sha256(existing),
          afterSha256: sha256(after),
        }, null, 2) + "\n"));
        atomicPrivateBytes(target, after);
        atomicPrivateBytes(path.join(migrations, "latest.json"), Buffer.from(JSON.stringify({
          schemaVersion: PROVIDER_CREDENTIAL_SCHEMA_VERSION,
          manifestPath,
        }, null, 2) + "\n"));
      } catch (error) {
        try {
          restoreMigrationTarget(target, existing, after);
        } catch (rollbackError) {
          error.rollbackError = rollbackError;
        }
        throw error;
      }
      return { migrated: true, store, legacy: true, manifestPath };
    }
  }

  const entries = existingProviderFileReferences();
  const store = { schemaVersion: PROVIDER_CREDENTIAL_SCHEMA_VERSION, credentials: entries };
  const after = serializedStore(store);
  mkdirSync(migrations, { recursive: true, mode: 0o700 });
  const directory = path.join(migrations, migrationTimestamp());
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const snapshot = {
    schemaVersion: PROVIDER_CREDENTIAL_SCHEMA_VERSION,
    createdAt: now(),
    targetPath: target,
    previousExists: false,
    previousPath: null,
    previousSha256: null,
    afterSha256: sha256(after),
  };
  const manifestPath = migrationManifestPath(directory);
  try {
    atomicPrivateBytes(manifestPath, Buffer.from(`${JSON.stringify(snapshot, null, 2)}\n`));
    atomicPrivateBytes(target, after);
    atomicPrivateBytes(path.join(migrations, "latest.json"), Buffer.from(`${JSON.stringify({
      schemaVersion: PROVIDER_CREDENTIAL_SCHEMA_VERSION,
      manifestPath,
    }, null, 2)}\n`));
  } catch (error) {
    try {
      restoreMigrationTarget(target, undefined, after);
    } catch (rollbackError) {
      error.rollbackError = rollbackError;
    }
    throw error;
  }
  return { migrated: true, store, manifestPath };
}

export function rollbackProviderCredentialStore(
  manifestPath,
  {
    migrationDirectory = PROVIDER_CREDENTIAL_MIGRATIONS_DIR,
    targetPath = PROVIDER_CREDENTIAL_STORE_PATH,
  } = {},
) {
  const migrations = managedStatePath(migrationDirectory, "migration directory", { allowDirectory: true });
  const target = managedStatePath(targetPath, "credential store path");
  let selected = manifestPath ? managedStatePath(manifestPath, "migration manifest path") : undefined;
  if (!selected) {
    const latestPath = path.join(migrations, "latest.json");
    const latest = readRegularBytes(latestPath, "latest migration pointer");
    if (!latest) throw new Error("No provider credential migration snapshot is available.");
    const parsed = JSON.parse(latest.toString("utf8"));
    plainObject(parsed, "latest migration pointer");
    assertAllowedKeys(parsed, new Set(["schemaVersion", "manifestPath"]), "latest migration pointer");
    if (parsed.schemaVersion !== PROVIDER_CREDENTIAL_SCHEMA_VERSION || typeof parsed.manifestPath !== "string") {
      throw new Error("Unsupported latest migration pointer.");
    }
    selected = managedStatePath(parsed.manifestPath, "migration manifest path");
  }
  if (!selected || !existsSync(selected)) throw new Error("Provider credential migration snapshot is missing.");
  const manifest = readMigrationManifest(selected, migrations, target);
  const current = readRegularBytes(target, "credential store");
  if (current !== undefined && sha256(current) !== manifest.afterSha256) {
    throw new Error("Refusing rollback because the credential store changed after migration.");
  }
  if (manifest.previousExists) {
    const previous = readRegularBytes(manifest.previousPath, "migration rollback snapshot");
    if (!previous || sha256(previous) !== manifest.previousSha256) {
      throw new Error("Provider credential rollback snapshot is missing.");
    }
    atomicPrivateBytes(target, previous);
  } else if (current !== undefined) {
    const stat = lstatSync(target);
    if (stat.isSymbolicLink() || !stat.isFile()) throw new Error("Credential store is not a regular file.");
    unlinkSync(target);
  }
  return { rolledBack: true, targetPath: target };
}
