import { randomBytes, scryptSync } from "node:crypto";
import { existsSync, lstatSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

import { writePrivateJson } from "./file-security.mjs";
import { INTERNAL_SECRET_PATH, PROVIDER_CATALOG_CACHE_PATH } from "./paths.mjs";
import { withProviderCatalogLock } from "./provider-catalog-lock.mjs";
import { normalizeModelMetadata } from "./model-capabilities.mjs";

// Asking a provider what it serves is a network round trip against a live
// credential, and the answer barely moves between releases. Re-asking it every
// time somebody opens a provider row is what made the Control Center feel like
// it reloads the world before it can add a single model. The answer is cached
// here so the list is present the moment a provider is opened, and a refresh
// stays an explicit choice rather than the price of looking.
//
// Only the provider's own published list is stored. Which of those models are
// registered locally is always recomputed from the live registry, so a cached
// list can never claim a model is curated when it is not.

export const PROVIDER_CATALOG_CACHE_SCHEMA_VERSION = 2;
const CACHE_VERSION = PROVIDER_CATALOG_CACHE_SCHEMA_VERSION;
// How long a stored list is trusted without question. Past it the list is
// still served -- it is the only answer available offline, and it is almost
// always still right -- but it is marked stale so the surfaces that show it can
// re-ask in the background. Without this a provider that shipped a new model
// would never surface it until somebody thought to press Reload.
export const CATALOG_STALE_AFTER_MS = 24 * 60 * 60 * 1000;
export const PROVIDER_CATALOG_CACHE_MAX_BYTES = 8 * 1024 * 1024;
const MAX_PROVIDERS = 80;
// A provider can have several API keys/accounts. Keep those snapshots
// isolated, but bound the number retained per provider so rotating keys cannot
// grow the cache forever. The scope is an opaque caller-owned id, never a key.
export const MAX_SCOPES_PER_PROVIDER = 16;
const MAX_MODELS = 4000;
const PROVIDER_ID = /^[a-z0-9][a-z0-9._-]{0,80}$/i;
const IDENTITY_FINGERPRINT = /^[a-f0-9]{64}$/;
const PROVENANCE_SCHEMA = "codex-router/provider-catalog/v1";
const MAX_MODEL_ID_LENGTH = 512;
const PROCESS_IDENTITY_KEY = randomBytes(32);
const IDENTITY_SCRYPT_OPTIONS = Object.freeze({ N: 16_384, r: 8, p: 1, maxmem: 32 * 1024 * 1024 });

function providerCatalogIdentityKey() {
  try {
    const key = readFileSync(INTERNAL_SECRET_PATH, "utf8").trim();
    if (key.length >= 32) return key;
  } catch {
    // Discovery can be exercised before installation has created the router's
    // internal secret. A process-local key keeps that cache account-bound for
    // this process without persisting a verifier that supports offline guesses.
  }
  return PROCESS_IDENTITY_KEY;
}

// The cache must answer only for the effective account that produced it. This
// memory-hard digest is a private verifier, never a credential. The
// installation's independent internal secret is its salt, so somebody who
// obtains only the private cache cannot test credential guesses, and scrypt
// keeps verification expensive even if both private files are compromised.
export function providerCatalogIdentityFingerprint(parts) {
  const values = Array.isArray(parts) ? parts : [parts];
  return scryptSync(
    JSON.stringify(values.map((value) => value ?? null)),
    providerCatalogIdentityKey(),
    32,
    IDENTITY_SCRYPT_OPTIONS,
  ).toString("hex");
}

const SCOPE_ID = /^[a-z0-9][a-z0-9._:-]{0,127}$/i;

function normalizedScope(value) {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string") return undefined;
  const scope = value.trim();
  return SCOPE_ID.test(scope) ? scope : undefined;
}

function readCacheDocument() {
  if (!existsSync(PROVIDER_CATALOG_CACHE_PATH)) return { version: CACHE_VERSION, providers: {}, invalid: false };
  try {
    if (lstatSync(PROVIDER_CATALOG_CACHE_PATH).isSymbolicLink() || statSync(PROVIDER_CATALOG_CACHE_PATH).size > PROVIDER_CATALOG_CACHE_MAX_BYTES) {
      return { version: CACHE_VERSION, providers: {}, invalid: true };
    }
    const parsed = JSON.parse(readFileSync(PROVIDER_CATALOG_CACHE_PATH, "utf8"));
    if (
      !parsed ||
      typeof parsed !== "object" ||
      Array.isArray(parsed) ||
      parsed.version !== CACHE_VERSION ||
      !parsed.providers ||
      typeof parsed.providers !== "object" ||
      Array.isArray(parsed.providers) ||
      Object.keys(parsed.providers).length > MAX_PROVIDERS ||
      Object.keys(parsed.providers).some((providerId) => !PROVIDER_ID.test(providerId)) ||
      Object.values(parsed.providers).some((provider) => (
        provider && typeof provider === "object" && provider.scopes !== undefined &&
        (Array.isArray(provider.scopes) || typeof provider.scopes !== "object" || Object.keys(provider.scopes).length > MAX_SCOPES_PER_PROVIDER)
      )) ||
      Object.keys(parsed).some((key) => !["version", "providers"].includes(key))
    ) {
      return { version: CACHE_VERSION, providers: {}, invalid: true };
    }
    return { version: CACHE_VERSION, providers: { ...parsed.providers }, invalid: false };
  } catch {
    // A cache is never the authority on anything. An unreadable or foreign
    // document is treated as a miss so the next read goes to the provider.
    return { version: CACHE_VERSION, providers: {}, invalid: true };
  }
}

function stringList(value, limit = MAX_MODELS) {
  if (!Array.isArray(value)) return undefined;
  if (value.length === 0 || value.length > limit) return undefined;
  const kept = value.map((item) => {
    if (typeof item !== "string" || !item.trim() || item.length > MAX_MODEL_ID_LENGTH || /[\u0000-\u001f\u007f]/.test(item)) return undefined;
    return item.trim();
  });
  if (kept.some((item) => !item) || new Set(kept).size !== kept.length) return undefined;
  return kept;
}

function contextMap(value, allowed) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const lengths = {};
  for (const [id, length] of Object.entries(value)) {
    if (!allowed.has(id)) return undefined;
    if (!Number.isInteger(length) || length < 1 || length > 16_777_216) return undefined;
    lengths[id] = length;
  }
  return lengths;
}

function boundedStringList(value, limit = 16) {
  if (!Array.isArray(value)) return undefined;
  const kept = [...new Set(value
    .filter((item) => typeof item === "string" && item.trim())
    .map((item) => item.trim().slice(0, 80)))]
    .slice(0, limit);
  return kept.length ? kept : undefined;
}

function optionalBoolean(value) {
  return typeof value === "boolean" ? value : undefined;
}

function positiveInteger(value) {
  return Number.isInteger(value) && value > 0 ? value : undefined;
}

function normalizedReasoning(value) {
  if (!value || typeof value !== "object") return undefined;
  const normalized = Object.fromEntries(Object.entries({
    supported: optionalBoolean(value.supported),
    configurable: optionalBoolean(value.configurable),
    supportedEfforts: boundedStringList(value.supportedEfforts),
    defaultEffort: typeof value.defaultEffort === "string" && value.defaultEffort.trim()
      ? value.defaultEffort.trim().slice(0, 80)
      : undefined,
    mandatory: optionalBoolean(value.mandatory),
    defaultEnabled: optionalBoolean(value.defaultEnabled),
    advertisedSupportedEfforts: boundedStringList(value.advertisedSupportedEfforts),
    advertisedDefaultEffort:
      typeof value.advertisedDefaultEffort === "string" && value.advertisedDefaultEffort.trim()
        ? value.advertisedDefaultEffort.trim().slice(0, 80)
        : undefined,
    effectiveMetadataSource:
      typeof value.effectiveMetadataSource === "string" && value.effectiveMetadataSource.trim()
        ? value.effectiveMetadataSource.trim().slice(0, 120)
        : undefined,
  }).filter(([, item]) => item !== undefined));
  return Object.keys(normalized).length ? normalized : undefined;
}

function metadataMap(value, allowed) {
  if (!value || typeof value !== "object") return undefined;
  const entries = [];
  for (const [id, item] of Object.entries(value)) {
    if (!allowed.has(id) || !item || typeof item !== "object") continue;
    const normalized = Object.fromEntries(Object.entries({
      contextWindow: positiveInteger(item.contextWindow),
      maxOutputTokens: positiveInteger(item.maxOutputTokens),
      inputModalities: boundedStringList(item.inputModalities),
      outputModalities: boundedStringList(item.outputModalities),
      supportsTools: optionalBoolean(item.supportsTools),
      supportsToolChoice: optionalBoolean(item.supportsToolChoice),
      reasoning: normalizedReasoning(item.reasoning),
      metadataSource: typeof item.metadataSource === "string" && item.metadataSource.trim()
        ? item.metadataSource.trim().slice(0, 120)
        : undefined,
    }).filter(([, entry]) => entry !== undefined));
    if (Object.keys(normalized).length) entries.push([id, normalized]);
  }
  return entries.length ? Object.fromEntries(entries) : undefined;
}

function normalizedProvenance(value, providerId, scope) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const allowed = ["schema", "providerId", "endpoint", "identityFingerprint", "scope"];
  if (Object.keys(value).some((key) => !allowed.includes(key))) return undefined;
  let endpoint;
  try {
    endpoint = new URL(value.endpoint);
  } catch {
    return undefined;
  }
  if (
    value.schema !== PROVENANCE_SCHEMA ||
    value.providerId !== providerId ||
    !["http:", "https:"].includes(endpoint.protocol) ||
    endpoint.username ||
    endpoint.password ||
    endpoint.search ||
    endpoint.hash ||
    typeof value.identityFingerprint !== "string" ||
    !IDENTITY_FINGERPRINT.test(value.identityFingerprint)
  ) return undefined;
  const normalizedScopeValue = normalizedScope(scope);
  if (scope !== undefined && scope !== null && scope !== "" && !normalizedScopeValue) return undefined;
  if (value.scope !== undefined && value.scope !== normalizedScopeValue) return undefined;
  return {
    schema: PROVENANCE_SCHEMA,
    providerId,
    endpoint: endpoint.toString().replace(/\/$/, ""),
    identityFingerprint: value.identityFingerprint,
    ...(normalizedScopeValue ? { scope: normalizedScopeValue } : {}),
  };
}

function normalizedEntry(entry, providerId, scope) {
  if (!entry || typeof entry !== "object") return undefined;
  if (Array.isArray(entry)) return undefined;
  const allowed = ["identityFingerprint", "fetchedAt", "discovered", "free", "contextLengths", "metadata", "modelMetadata", "provenance"];
  if (Object.keys(entry).some((key) => !allowed.includes(key))) return undefined;
  const identityFingerprint = typeof entry.identityFingerprint === "string"
    && IDENTITY_FINGERPRINT.test(entry.identityFingerprint)
    ? entry.identityFingerprint
    : undefined;
  // Pre-account-bound entries deliberately become misses. Serving one would
  // expose the previous account's private model entitlements after an
  // environment, Keychain, or official-CLI login changed outside the router.
  if (!identityFingerprint) return undefined;
  const discovered = stringList(entry.discovered);
  if (!discovered?.length) return undefined;
  const fetchedAt = typeof entry.fetchedAt === "string" && entry.fetchedAt.trim()
    ? entry.fetchedAt
    : undefined;
  if (!fetchedAt || !Number.isFinite(Date.parse(fetchedAt))) return undefined;
  const provenance = normalizedProvenance(entry.provenance, providerId, scope);
  if (!provenance || provenance.identityFingerprint !== identityFingerprint) return undefined;
  const known = new Set(discovered);
  const free = entry.free === undefined || (Array.isArray(entry.free) && entry.free.length === 0)
    ? undefined
    : stringList(entry.free);
  if (
    entry.free !== undefined &&
    (!Array.isArray(entry.free) || (entry.free.length > 0 && (!free || free.some((id) => !known.has(id)))))
  ) return undefined;
  const contextLengths = entry.contextLengths === undefined ? undefined : contextMap(entry.contextLengths, known);
  if (entry.contextLengths !== undefined && !contextLengths) return undefined;
  const metadata = entry.metadata === undefined ? undefined : metadataMap(entry.metadata, known);
  if (
    entry.metadata !== undefined &&
    (
      !entry.metadata ||
      typeof entry.metadata !== "object" ||
      Array.isArray(entry.metadata) ||
      (Object.keys(entry.metadata).length > 0 && !metadata)
    )
  ) return undefined;
  let modelMetadata;
  if (entry.modelMetadata !== undefined) {
    if (entry.modelMetadata && typeof entry.modelMetadata === "object" && !Array.isArray(entry.modelMetadata)) {
      const valid = {};
      for (const [id, value] of Object.entries(entry.modelMetadata)) {
        if (!known.has(id) || typeof id !== "string" || id.length > MAX_MODEL_ID_LENGTH) return undefined;
        // Live provider metadata is intentionally capability-only. A cached
        // request profile would select router wire behavior on the next run;
        // reject it even when the rest of the record is account-bound, rather
        // than allowing a hand-edited or legacy cache to grant that authority.
        if (value?.requestProfile !== undefined) return undefined;
        try {
          valid[id] = normalizeModelMetadata(value, { upstreamId: id });
        } catch {
          return undefined;
        }
      }
      if (Object.keys(valid).length) modelMetadata = valid;
    }
    else return undefined;
  }
  return {
    identityFingerprint,
    fetchedAt,
    discovered,
    provenance,
    ...(free?.length ? { free } : {}),
    ...(contextLengths ? { contextLengths } : {}),
    ...(metadata ? { metadata } : {}),
    ...(modelMetadata ? { modelMetadata } : {}),
  };
}

function normalizedScopedEntries(value, providerId) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const entries = {};
  for (const [scope, entry] of Object.entries(value)) {
    const normalized = normalizedScope(scope);
    const parsed = normalizedEntry(entry, providerId, normalized);
    if (!normalized || !parsed) continue;
    entries[normalized] = parsed;
  }
  return entries;
}

function providerRecordEntry(providerRecord, providerId, scope) {
  const normalized = normalizedScope(scope);
  if (normalized) return normalizedEntry(providerRecord?.scopes?.[normalized], providerId, normalized);
  const root = providerRecord && typeof providerRecord === "object" ? { ...providerRecord } : providerRecord;
  if (root && typeof root === "object") delete root.scopes;
  return normalizedEntry(root, providerId);
}

function latestProviderTimestamp(providerRecord) {
  const timestamps = [
    providerRecord?.fetchedAt,
    ...Object.values(providerRecord?.scopes || {}).map((entry) => entry?.fetchedAt),
  ].filter(Boolean);
  return timestamps.sort().at(-1) || "";
}

function serializedProviderDocument(providers) {
  return JSON.stringify({ version: CACHE_VERSION, providers }, null, 2);
}

/**
 * Keep the cache file below its read-side safety limit. Provider catalogs are
 * untrusted input: a large model list or verbose capability metadata must not
 * make the next process discard the entire cache. Entries are already ordered
 * newest-first, so the newest complete provider snapshots win and older ones
 * are evicted first. If one provider alone is too large, it is skipped rather
 * than writing a document that cannot be read back.
 */
function boundedProviderDocument(ordered) {
  const kept = {};
  for (const [providerId, entry] of ordered) {
    const candidate = { ...kept, [providerId]: entry };
    // writePrivateJson appends one trailing newline, so include it in the
    // safety check rather than letting an exact-boundary document become a
    // read-side miss on the next process.
    if (Buffer.byteLength(serializedProviderDocument(candidate), "utf8") + 1 > PROVIDER_CATALOG_CACHE_MAX_BYTES) {
      continue;
    }
    kept[providerId] = entry;
  }
  return { version: CACHE_VERSION, providers: kept };
}

/**
 * Whether a stored list is old enough that it should be re-read in the
 * background. An unparseable timestamp counts as stale: a list whose age
 * cannot be established is not one to keep trusting indefinitely.
 */
export function catalogEntryIsStale(fetchedAt, now = Date.now()) {
  const stamped = Date.parse(String(fetchedAt || ""));
  if (!Number.isFinite(stamped)) return true;
  return now - stamped >= CATALOG_STALE_AFTER_MS;
}

/** The provider's last known published model list, or undefined on a miss. */
export function readProviderCatalogCache(providerId, { scope } = {}) {
  if (!PROVIDER_ID.test(String(providerId || ""))) return undefined;
  const normalized = normalizedScope(scope);
  // A malformed non-empty scope must never silently fall back to another
  // account's catalog. Undefined is the only unscoped request.
  if (scope !== undefined && scope !== null && scope !== "" && !normalized) return undefined;
  const entry = providerRecordEntry(readCacheDocument().providers[providerId], providerId, normalized);
  // Age is derived from the timestamp on every read, never stored: a document
  // that carried its own staleness would be answering a question about a
  // moment that has already passed.
  return entry ? { ...entry, stale: catalogEntryIsStale(entry.fetchedAt) } : undefined;
}

/**
 * Record what a provider just published. `fetchedAt` is supplied by the caller
 * so a discovery run and its cache entry cannot disagree about when the list
 * was seen.
 */
function writeProviderCatalogCacheInTransaction(
  providerId,
  { discovered, free, contextLengths, metadata, modelMetadata, fetchedAt, scope, identityFingerprint, provenance } = {},
) {
  if (!PROVIDER_ID.test(String(providerId || ""))) return undefined;
  const normalized = normalizedScope(scope);
  if (scope !== undefined && scope !== null && scope !== "" && !normalized) return undefined;
  const entry = normalizedEntry({
    discovered,
    free,
    contextLengths,
    metadata,
    modelMetadata,
    fetchedAt: fetchedAt || new Date().toISOString(),
    identityFingerprint,
    provenance,
  }, providerId, normalized);
  if (!entry) return undefined;
  const document = readCacheDocument();
  const previous = document.providers[providerId];
  const previousScopes = normalizedScopedEntries(previous?.scopes, providerId);
  const previousRoot = previous && typeof previous === "object" ? { ...previous } : undefined;
  if (previousRoot) delete previousRoot.scopes;
  const providerRecord = normalized
    ? {
        ...(normalizedEntry(previousRoot, providerId) || {}),
        scopes: { ...previousScopes, [normalized]: entry },
      }
    : {
        ...entry,
        ...(Object.keys(previousScopes).length ? { scopes: previousScopes } : {}),
      };
  const scopes = providerRecord.scopes;
  if (scopes) {
    providerRecord.scopes = Object.fromEntries(
      Object.entries(scopes)
        .sort(([, left], [, right]) => String(right.fetchedAt).localeCompare(String(left.fetchedAt)))
        .slice(0, MAX_SCOPES_PER_PROVIDER),
    );
  }
  const providers = { ...document.providers, [providerId]: providerRecord };
  // Bound the document so a long-lived installation that has touched many
  // providers cannot grow it without limit. The oldest entries are the ones
  // whose provider has not been opened in the longest time.
  const ordered = Object.entries(providers)
    .sort(([, left], [, right]) => latestProviderTimestamp(right).localeCompare(latestProviderTimestamp(left)))
    .slice(0, MAX_PROVIDERS);
  writePrivateJson(PROVIDER_CATALOG_CACHE_PATH, boundedProviderDocument(ordered), { directoryMode: 0o700 });
  return entry;
}

/** Drop several providers' cached lists with one protected document rewrite. */
function forgetProviderCatalogCachesInTransaction(providerIds, { scope } = {}) {
  const ids = [...new Set(
    (Array.isArray(providerIds) ? providerIds : [])
      .map((providerId) => String(providerId || ""))
      .filter((providerId) => PROVIDER_ID.test(providerId)),
  )];
  if (ids.length === 0) return 0;
  const document = readCacheDocument();
  if (document.invalid) {
    // A legacy, future, corrupt, or symlinked document is not a source of
    // readable catalog data. Replace it with an empty current-generation
    // document during an explicit invalidation instead of leaving an ignored
    // credential-bound artifact on disk indefinitely.
    writePrivateJson(PROVIDER_CATALOG_CACHE_PATH, boundedProviderDocument([]), { directoryMode: 0o700 });
    return 0;
  }
  let removed = 0;
  for (const providerId of ids) {
    const existing = document.providers[providerId];
    if (!existing) continue;
    const normalized = normalizedScope(scope);
    if (scope !== undefined && scope !== null && scope !== "" && !normalized) continue;
    if (!normalized) {
      delete document.providers[providerId];
      removed += 1;
      continue;
    }
    const scopes = normalizedScopedEntries(existing.scopes, providerId);
    if (!(normalized in scopes)) continue;
    delete scopes[normalized];
    const existingRoot = existing && typeof existing === "object" ? { ...existing } : undefined;
    if (existingRoot) delete existingRoot.scopes;
    const root = normalizedEntry(existingRoot, providerId);
    if (!root && !Object.keys(scopes).length) delete document.providers[providerId];
    else document.providers[providerId] = {
      ...(root || {}),
      ...(Object.keys(scopes).length ? { scopes } : {}),
    };
    removed += 1;
  }
  if (removed === 0) return 0;
  const ordered = Object.entries(document.providers)
    .sort(([, left], [, right]) => latestProviderTimestamp(right).localeCompare(latestProviderTimestamp(left)))
    .slice(0, MAX_PROVIDERS);
  writePrivateJson(PROVIDER_CATALOG_CACHE_PATH, boundedProviderDocument(ordered), { directoryMode: 0o700 });
  return removed;
}

// All cache writers share one short cross-process transaction. Discovery does
// its network round trip outside this boundary, then uses this API to compare
// the credential snapshot and commit against the latest cache document. The
// transaction object deliberately exposes no path and no arbitrary file IO.
export function withProviderCatalogCacheTransaction(operation, options = {}) {
  return withProviderCatalogLock(() => operation(Object.freeze({
    read: readProviderCatalogCache,
    write: writeProviderCatalogCacheInTransaction,
    forget: forgetProviderCatalogCachesInTransaction,
  })), options);
}

/** Record one answer without losing a concurrent provider's cache entry. */
export function writeProviderCatalogCache(providerId, entry) {
  return withProviderCatalogCacheTransaction((cache) => cache.write(providerId, entry));
}

/** Drop several providers atomically with respect to discovery commits. */
export function forgetProviderCatalogCaches(providerIds) {
  return withProviderCatalogCacheTransaction((cache) => cache.forget(providerIds));
}

/** Drop one provider's cached list, for example after its credential changes. */
export async function forgetProviderCatalogCache(providerId, options = {}) {
  return await withProviderCatalogCacheTransaction((cache) => cache.forget([providerId], options)) > 0;
}

export const PROVIDER_CATALOG_CACHE_FILE = path.basename(PROVIDER_CATALOG_CACHE_PATH);
