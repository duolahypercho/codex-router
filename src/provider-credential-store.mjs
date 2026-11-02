import { randomBytes } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
} from "node:fs";
import path from "node:path";

import { withAtomicStateLock } from "./atomic-state-lock.mjs";
import { writePrivateFile } from "./file-security.mjs";
import { normalizeGenericProviderId } from "./generic-provider-identity.mjs";
import { PROVIDERS } from "./model-registry.mjs";
import {
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

function managedStatePath(value, field) {
  if (typeof value !== "string" || !path.isAbsolute(value)) {
    throw new Error(`${field} must be an absolute path.`);
  }
  const target = path.resolve(value);
  const base = path.resolve(STATE_DIR);
  if (!isWithin(base, target) || target === base) {
    throw new Error(`${field} must stay inside the router state directory.`);
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

function atomicPrivateBytes(filePath, bytes) {
  const target = managedStatePath(filePath, "target path");
  const directory = path.dirname(target);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);
  return writePrivateFile(target, bytes);
}

function serializedStore(store) {
  return Buffer.from(`${JSON.stringify(store, null, 2)}\n`, "utf8");
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

export function generatedCredentialId(random = randomBytes) {
  // Random IDs are used for new entries.
  // Base64url may begin with `-` or `_`, while a generic provider's
  // credentialRef requires the first post-prefix character to be alphanumeric.
  // A fixed opaque marker makes every generated id valid without discarding
  // entropy or retrying on a random outcome.
  const opaque = random(18).toString("base64url");
  return `cred_r${opaque}`;
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

function normalizeSecretRef(value, providerId, { providerType } = {}) {
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
      ? normalizeGenericProviderId(value.providerId, { reservedProviderIds: PROVIDERS })
      : validateProviderId(value.providerId);
  if (referenceProviderId !== providerId) {
    throw new Error("secretRef.providerId must match providerId.");
  }
  const target = normalizeText(
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

function normalizeCredential(raw) {
  plainObject(raw, "credential");
  assertNoSecretFields(raw, "credential metadata");
  assertAllowedKeys(raw, CREDENTIAL_KEYS, "credential");
  const providerType = raw.providerType === undefined
    ? undefined
    : normalizeText(raw.providerType, "providerType", { max: 20, required: true });
  if (providerType !== undefined && providerType !== "generic") {
    throw new Error(`Unsupported providerType: ${providerType}`);
  }
  const providerId = providerType === "generic"
    ? normalizeGenericProviderId(raw.providerId, { reservedProviderIds: PROVIDERS })
    : validateProviderId(raw.providerId);
  const kind = normalizeText(raw.kind, "credential kind", {
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
  const secretRef = normalizeSecretRef(raw.secretRef, providerId, { providerType });
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

function normalizeStore(raw) {
  plainObject(raw, "Credential store");
  assertNoSecretFields(raw, "Credential store");
  assertAllowedKeys(raw, STORE_KEYS, "Credential store");
  if (!Array.isArray(raw.credentials)) throw new Error("Credential store credentials must be an array.");
  if (raw.schemaVersion !== PROVIDER_CREDENTIAL_SCHEMA_VERSION) {
    throw new Error("Unsupported provider credential store schema.");
  }
  const entries = raw.credentials;
  const seen = new Set();
  const credentials = entries.map((entry) => {
    const normalized = normalizeCredential(entry);
    if (seen.has(normalized.id)) throw new Error(`Duplicate credential id: ${normalized.id}`);
    seen.add(normalized.id);
    return normalized;
  });
  return { schemaVersion: PROVIDER_CREDENTIAL_SCHEMA_VERSION, credentials };
}

function parseStore(contents) {
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
  throw new Error("Unsupported provider credential store schema.");
}

export function readProviderCredentialStore(filePath = PROVIDER_CREDENTIAL_STORE_PATH) {
  const target = managedStatePath(filePath, "credential store path");
  if (!existsSync(target)) return emptyStore();
  try {
    return parseStore(readRegularBytes(target, "credential store"));
  } catch {
    // A malformed store must not become a source of credentials. Returning an
    // empty, safe state lets health/catalog paths continue while explicit
    // writes remain strict and report the repair needed.
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
    ? normalizeGenericProviderId(providerId, { reservedProviderIds: PROVIDERS })
    : validateProviderId(providerId);
  const credential = normalizeCredential({
    id: id || generatedCredentialId(),
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

function sameSecretReference(left, right) {
  return ["type", "providerId", "target", "service", "name"]
    .every((field) => left?.[field] === right?.[field]);
}

export function ensureCredentialReference(input, filePath = PROVIDER_CREDENTIAL_STORE_PATH) {
  const target = managedStatePath(filePath, "credential store path");
  return withAtomicStateLock(target, () => {
    const store = readProviderCredentialStoreStrict(target);
    const credential = createCredentialReference(input);
    const existing = store.credentials.find(
      (entry) =>
        entry.state === "active" &&
        entry.providerId === credential.providerId &&
        entry.kind === credential.kind &&
        sameSecretReference(entry.secretRef, credential.secretRef),
    );
    if (existing) return { credential: existing, created: false };
    if (store.credentials.some((entry) => entry.id === credential.id)) {
      throw new Error(`Credential id already exists: ${credential.id}`);
    }
    store.credentials.push(credential);
    return {
      credential: writeProviderCredentialStore(store, target).credentials.at(-1),
      created: true,
    };
  });
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
