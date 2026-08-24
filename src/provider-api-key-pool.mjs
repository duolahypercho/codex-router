import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
} from "node:fs";
import path from "node:path";

import lockfile from "proper-lockfile";

import { writePrivateJson } from "./file-security.mjs";
import { PROVIDER_API_KEY_POOL_PATH, STATE_DIR } from "./paths.mjs";

export const PROVIDER_API_KEY_POOL_SCHEMA_VERSION = 1;
export const PROVIDER_API_KEY_POOL_STRATEGIES = Object.freeze([
  "quota",
  "round-robin",
  "fill-first",
]);
export const PROVIDER_API_KEY_POOL_PATH_DEFAULT = PROVIDER_API_KEY_POOL_PATH;

const PROVIDER_ID = /^[a-z0-9][a-z0-9-]{0,99}$/;
const CREDENTIAL_ID = /^cred_[A-Za-z0-9_-]{8,96}$/;
const REFERENCE_ID = /^ref_[A-Za-z0-9_-]{8,128}$/;
const SESSION_ID_LIMIT = 256;
const MAX_PROVIDERS = 128;
const MAX_CREDENTIALS = 256;
const MAX_SESSIONS = 2_048;
const MAX_ERROR_LENGTH = 512;
const MAX_COOLDOWN_SECONDS = 24 * 60 * 60;
const DEFAULT_LOCK_WAIT_MS = 120_000;
const DEFAULT_LOCK_RETRY_MS = 25;
const DEFAULT_LOCK_STALE_MS = 10 * 60_000;

const TRANSIENT_STATUS = new Set([
  401,
  403,
  408,
  429,
  500,
  501,
  502,
  503,
  504,
  505,
  506,
  507,
  508,
  509,
  510,
  511,
]);
const TRANSIENT_ERROR_CODES = new Set([
  "ECONNABORTED",
  "ECONNRESET",
  "ECONNREFUSED",
  "EHOSTUNREACH",
  "ENETDOWN",
  "ENETUNREACH",
  "ENOTFOUND",
  "ETIMEDOUT",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_SOCKET",
]);

function record(value) {
  return value && typeof value === "object" && !Array.isArray(value);
}

function text(value, field, { max = 256, required = false } = {}) {
  if (typeof value !== "string") {
    if (required) throw new Error(`${field} must be a string.`);
    return undefined;
  }
  const normalized = value.trim();
  if (!normalized && required) throw new Error(`${field} must not be empty.`);
  if (normalized.length > max || /[\u0000-\u001f\u007f]/.test(normalized)) {
    throw new Error(`${field} is invalid.`);
  }
  return normalized || undefined;
}

function providerId(value) {
  const normalized = text(value, "provider id", { max: 100, required: true }).toLowerCase();
  if (!PROVIDER_ID.test(normalized)) throw new Error(`Invalid provider id: ${normalized}`);
  return normalized;
}

function credentialId(value) {
  const normalized = text(value, "credential id", { max: 100, required: true });
  if (!CREDENTIAL_ID.test(normalized)) throw new Error("Credential id is invalid.");
  return normalized;
}

function sessionId(value) {
  if (value === undefined || value === null || value === "") return undefined;
  const normalized = text(value, "session id", { max: SESSION_ID_LIMIT, required: true });
  return normalized;
}

function finiteNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function integer(value, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const parsed = finiteNumber(value);
  return parsed === undefined ? fallback : Math.min(max, Math.max(min, Math.floor(parsed)));
}

function isoTimestamp(value) {
  const parsed = Date.parse(String(value || ""));
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : undefined;
}

function nowMs(value) {
  return Number.isFinite(value) ? value : Date.now();
}

function isoNow(value) {
  return new Date(nowMs(value)).toISOString();
}

function assertAllowedKeys(value, allowed, context) {
  for (const key of Object.keys(value || {})) {
    if (!allowed.has(key)) throw new Error(`${context} contains unsupported field ${key}.`);
  }
}

export function normalizeProviderApiKeySecretRef(value) {
  if (!record(value)) {
    throw new Error("secretRef must be a reference object.");
  }
  assertAllowedKeys(value, new Set(["type", "id", "name", "service", "providerId"]), "secretRef");
  const type = text(value.type, "secretRef.type", { max: 32, required: true });
  if (!["opaque", "provider-file", "keychain", "environment"].includes(type)) {
    throw new Error("secretRef.type is unsupported.");
  }
  if (type === "opaque") {
    if (value.name !== undefined || value.service !== undefined || value.providerId !== undefined) {
      throw new Error("Opaque secret references may only contain type and id.");
    }
    const id = text(value.id, "secretRef.id", { max: 140, required: true });
    if (!REFERENCE_ID.test(id)) throw new Error("secretRef.id is invalid.");
    return { type, id };
  }
  if (value.id !== undefined) throw new Error(`${type} secret references do not accept id.`);
  const providerIdValue = value.providerId === undefined
    ? undefined
    : text(value.providerId, "secretRef.providerId", { max: 100, required: true });
  if (type === "keychain") {
    if (value.name !== undefined) throw new Error("Keychain references use service.");
    const service = text(value.service, "secretRef.service", { max: 200, required: true });
    return { type, service, ...(providerIdValue ? { providerId: providerIdValue } : {}) };
  }
  if (value.service !== undefined) throw new Error(`${type} references use name.`);
  const name = text(value.name, "secretRef.name", { max: 200, required: true });
  return { type, name, ...(providerIdValue ? { providerId: providerIdValue } : {}) };
}

export function providerApiKeySecretRefIdentity(value) {
  const ref = normalizeProviderApiKeySecretRef(value);
  const source = ref.id || ref.name || ref.service;
  return `${ref.providerId || ""}:${ref.type}:${source}`;
}

function normalizeQuota(value) {
  if (!record(value)) return undefined;
  assertAllowedKeys(value, new Set(["limit", "remaining", "used", "resetAt", "observedAt"]), "quota");
  const limit = finiteNumber(value.limit);
  const remaining = finiteNumber(value.remaining);
  if (limit === undefined || limit <= 0 || remaining === undefined) return undefined;
  const result = {
    limit,
    remaining: Math.max(0, Math.min(limit, remaining)),
  };
  const used = finiteNumber(value.used);
  const resetAt = isoTimestamp(value.resetAt);
  const observedAt = isoTimestamp(value.observedAt);
  if (used !== undefined && used >= 0) result.used = used;
  if (resetAt) result.resetAt = resetAt;
  if (observedAt) result.observedAt = observedAt;
  return result;
}

function normalizeHealth(value, now = Date.now()) {
  const source = record(value) ? value : {};
  assertAllowedKeys(
    source,
    new Set(["state", "cooldownUntil", "lastSuccessAt", "lastErrorAt", "lastUsedAt", "lastStatus", "lastError", "failureCount"]),
    "health",
  );
  const state = ["healthy", "cooldown", "failed"].includes(source.state)
    ? source.state
    : "healthy";
  const result = { state };
  for (const field of ["cooldownUntil", "lastSuccessAt", "lastErrorAt", "lastUsedAt"]) {
    const timestamp = isoTimestamp(source[field]);
    if (timestamp) result[field] = timestamp;
  }
  const status = integer(source.lastStatus, undefined, { min: 100, max: 999 });
  if (status !== undefined) result.lastStatus = status;
  const error = text(source.lastError, "health.lastError", { max: MAX_ERROR_LENGTH });
  if (error) result.lastError = error;
  const failures = integer(source.failureCount, 0, { max: 100_000 });
  if (failures) result.failureCount = failures;
  if (result.cooldownUntil && Date.parse(result.cooldownUntil) <= nowMs(now)) {
    delete result.cooldownUntil;
    if (result.state === "cooldown") result.state = "healthy";
  }
  return result;
}

function normalizeCredential(value, provider, now = Date.now()) {
  if (!record(value)) throw new Error("Each pool credential must be an object.");
  assertAllowedKeys(
    value,
    new Set(["id", "providerId", "secretRef", "state", "paused", "priority", "quota", "health", "requestCount", "tokenCount"]),
    "pool credential",
  );
  const id = credentialId(value.id);
  if (value.providerId !== undefined && providerId(value.providerId) !== provider) {
    throw new Error(`Credential ${id} belongs to a different provider.`);
  }
  const secretRef = normalizeProviderApiKeySecretRef(value.secretRef);
  const state = ["active", "paused", "revoked"].includes(value.state)
    ? value.state
    : "active";
  const priority = integer(value.priority, 50, { max: 100_000 });
  const requestCount = integer(value.requestCount, 0);
  const tokenCount = integer(value.tokenCount, 0);
  const result = {
    id,
    providerId: provider,
    secretRef,
    state,
    paused: value.paused === true,
    priority,
    health: normalizeHealth(value.health, now),
    requestCount,
    tokenCount,
  };
  const quota = normalizeQuota(value.quota);
  if (quota) result.quota = quota;
  return result;
}

function normalizePolicy(value) {
  const source = record(value) ? value : {};
  assertAllowedKeys(
    source,
    new Set(["strategy", "autoSwitchThreshold", "sticky", "stickyLimit", "maxCooldownSeconds", "priorityOrder", "pausedCredentialIds"]),
    "pool policy",
  );
  const strategy = PROVIDER_API_KEY_POOL_STRATEGIES.includes(source.strategy)
    ? source.strategy
    : "quota";
  const threshold = finiteNumber(source.autoSwitchThreshold);
  const priorityOrder = Array.isArray(source.priorityOrder)
    ? [...new Set(source.priorityOrder.map((id) => text(id, "priority credential id", { max: 100 })).filter((id) => id && CREDENTIAL_ID.test(id)))].slice(0, MAX_CREDENTIALS)
    : [];
  const pausedCredentialIds = Array.isArray(source.pausedCredentialIds)
    ? [...new Set(source.pausedCredentialIds.map((id) => text(id, "paused credential id", { max: 100 })).filter((id) => id && CREDENTIAL_ID.test(id)))].slice(0, MAX_CREDENTIALS)
    : [];
  return {
    strategy,
    autoSwitchThreshold: threshold === undefined ? 0.1 : Math.min(1, Math.max(0, threshold)),
    sticky: source.sticky !== false,
    stickyLimit: integer(source.stickyLimit, 50, { min: 1, max: MAX_SESSIONS }),
    maxCooldownSeconds: integer(source.maxCooldownSeconds, 300, { max: MAX_COOLDOWN_SECONDS }),
    priorityOrder,
    pausedCredentialIds,
  };
}

function normalizeSession(value, now = Date.now()) {
  if (!record(value)) throw new Error("Each pool session must be an object.");
  assertAllowedKeys(value, new Set(["credentialId", "turns", "requests", "boundAt", "updatedAt", "reboundAt", "lastReason"]), "pool session");
  const credential = credentialId(value.credentialId);
  const result = {
    credentialId: credential,
    turns: integer(value.turns, 0),
    requests: integer(value.requests, 0),
    boundAt: isoTimestamp(value.boundAt) || isoNow(now),
    updatedAt: isoTimestamp(value.updatedAt) || isoNow(now),
  };
  const reboundAt = isoTimestamp(value.reboundAt);
  const reason = text(value.lastReason, "session.lastReason", { max: 120 });
  if (reboundAt) result.reboundAt = reboundAt;
  if (reason) result.lastReason = reason;
  return result;
}

function normalizePool(value, provider, now = Date.now()) {
  if (value !== undefined && !record(value)) throw new Error(`Provider ${provider} pool must be an object.`);
  const source = value || {};
  assertAllowedKeys(source, new Set(["providerId", "policy", "roundRobinCursor", "credentials", "sessions"]), `${provider} pool`);
  if (source.providerId !== undefined && providerId(source.providerId) !== provider) {
    throw new Error(`Provider pool identity does not match ${provider}.`);
  }
  const result = {
    providerId: provider,
    policy: normalizePolicy(source.policy),
    roundRobinCursor: integer(source.roundRobinCursor, 0),
    credentials: {},
    sessions: {},
  };
  const credentials = source.credentials === undefined
    ? []
    : record(source.credentials)
      ? Object.entries(source.credentials)
      : (() => { throw new Error(`${provider} credentials must be an object.`); })();
  const refs = new Set();
  for (const [id, raw] of credentials.slice(0, MAX_CREDENTIALS)) {
    const normalized = normalizeCredential({ ...(record(raw) ? raw : {}), id }, provider, now);
    const refIdentity = providerApiKeySecretRefIdentity(normalized.secretRef);
    if (refs.has(refIdentity)) throw new Error(`Provider ${provider} contains duplicate secret references.`);
    refs.add(refIdentity);
    result.credentials[normalized.id] = normalized;
  }
  const sessions = source.sessions === undefined
    ? []
    : record(source.sessions)
      ? Object.entries(source.sessions)
      : (() => { throw new Error(`${provider} sessions must be an object.`); })();
  for (const [id, raw] of sessions.slice(0, MAX_SESSIONS)) {
    const normalizedId = sessionId(id);
    if (!normalizedId) continue;
    const normalized = normalizeSession(raw, now);
    if (!result.credentials[normalized.credentialId]) continue;
    result.sessions[normalizedId] = normalized;
  }
  return result;
}

function normalizeState(value, now = Date.now()) {
  if (!record(value) || value.version !== PROVIDER_API_KEY_POOL_SCHEMA_VERSION) {
    throw new Error("Unsupported provider API-key pool state.");
  }
  assertAllowedKeys(value, new Set(["version", "providers"]), "provider API-key pool state");
  if (!record(value.providers)) throw new Error("Provider API-key pool providers must be an object.");
  const result = { version: PROVIDER_API_KEY_POOL_SCHEMA_VERSION, providers: {} };
  for (const [rawProvider, rawPool] of Object.entries(value.providers).slice(0, MAX_PROVIDERS)) {
    const provider = providerId(rawProvider);
    if (result.providers[provider]) throw new Error(`Duplicate provider pool: ${provider}`);
    result.providers[provider] = normalizePool(rawPool, provider, now);
  }
  return result;
}

function emptyState() {
  return { version: PROVIDER_API_KEY_POOL_SCHEMA_VERSION, providers: {} };
}

export function readProviderApiKeyPoolState(filePath = PROVIDER_API_KEY_POOL_PATH_DEFAULT, { now = Date.now() } = {}) {
  if (!existsSync(filePath)) return { ...emptyState(), valid: true };
  try {
    return { ...normalizeState(JSON.parse(readFileSync(filePath, "utf8")), now), valid: true };
  } catch {
    return { ...emptyState(), valid: false };
  }
}

function stateForWrite(state, now = Date.now()) {
  return normalizeState({ version: PROVIDER_API_KEY_POOL_SCHEMA_VERSION, providers: state?.providers || {} }, now);
}

function poolStatus(providerOrId, filePath, now = Date.now()) {
  const provider = providerId(providerOrId);
  const state = readProviderApiKeyPoolState(filePath, { now });
  const configured = !state.valid || Object.prototype.hasOwnProperty.call(state.providers, provider);
  return {
    providerId: provider,
    configured,
    valid: state.valid,
    pool: state.providers[provider],
  };
}

export function providerApiKeyPoolStatus(providerOrId, { filePath = PROVIDER_API_KEY_POOL_PATH_DEFAULT, now = Date.now() } = {}) {
  return poolStatus(providerOrId, filePath, now);
}

export function sanitizeProviderApiKeyPoolCredential(value) {
  if (!value) return null;
  return {
    id: value.id,
    providerId: value.providerId,
    secretRef: { ...value.secretRef },
    state: value.state,
    paused: value.paused === true,
    priority: value.priority,
    ...(value.quota ? { quota: { ...value.quota } } : {}),
    health: { ...value.health },
    requestCount: value.requestCount,
    tokenCount: value.tokenCount,
  };
}

export function sanitizeProviderApiKeyPool(providerOrId, value) {
  const provider = providerId(providerOrId);
  const pool = normalizePool(value, provider);
  return {
    providerId: provider,
    policy: { ...pool.policy },
    roundRobinCursor: pool.roundRobinCursor,
    credentials: Object.values(pool.credentials).map(sanitizeProviderApiKeyPoolCredential),
    sessions: Object.fromEntries(Object.entries(pool.sessions).map(([id, session]) => [id, { ...session }])),
  };
}

export function getProviderApiKeyPool(providerOrId, { filePath = PROVIDER_API_KEY_POOL_PATH_DEFAULT, now = Date.now() } = {}) {
  const status = poolStatus(providerOrId, filePath, now);
  if (!status.valid) return { providerId: status.providerId, valid: false, configured: true, credentials: [], sessions: {} };
  return {
    ...sanitizeProviderApiKeyPool(status.providerId, status.pool || { }),
    configured: status.configured,
    valid: true,
  };
}

function quotaRatio(meta) {
  if (!meta?.quota || !(meta.quota.limit > 0) || !Number.isFinite(meta.quota.remaining)) return undefined;
  return Math.max(0, Math.min(1, meta.quota.remaining / meta.quota.limit));
}

function cooldownActive(meta, at) {
  const until = Date.parse(meta?.health?.cooldownUntil || "");
  return Number.isFinite(until) && until > at;
}

function eligibleMeta(pool, at, exclude = new Set()) {
  return Object.values(pool.credentials).filter((meta) => {
    if (exclude.has(meta.id) || meta.state !== "active" || meta.paused) return false;
    if (pool.policy.pausedCredentialIds.includes(meta.id)) return false;
    if (cooldownActive(meta, at) || meta.health.state === "failed") return false;
    const ratio = quotaRatio(meta);
    const reset = Date.parse(meta.quota?.resetAt || "");
    return !(ratio !== undefined && ratio <= 0 && (!Number.isFinite(reset) || reset > at));
  });
}

function orderMeta(pool, candidates) {
  const rank = (id) => {
    const index = pool.policy.priorityOrder.indexOf(id);
    return index === -1 ? Number.MAX_SAFE_INTEGER : index;
  };
  return [...candidates].sort((left, right) => {
    const rankDiff = rank(left.id) - rank(right.id);
    if (rankDiff) return rankDiff;
    const priorityDiff = right.priority - left.priority;
    return priorityDiff || left.id.localeCompare(right.id);
  });
}

function chooseMeta(pool, candidates) {
  const ordered = orderMeta(pool, candidates);
  if (!ordered.length) return undefined;
  if (pool.policy.strategy === "round-robin") {
    return ordered[pool.roundRobinCursor % ordered.length];
  }
  const aboveThreshold = ordered.filter((candidate) => {
    const ratio = quotaRatio(candidate);
    return ratio === undefined || ratio > pool.policy.autoSwitchThreshold;
  });
  const eligible = aboveThreshold.length ? aboveThreshold : ordered;
  if (pool.policy.strategy === "fill-first") return eligible[0];
  return [...eligible].sort((left, right) => {
    const leftRatio = quotaRatio(left);
    const rightRatio = quotaRatio(right);
    if (leftRatio !== undefined && rightRatio === undefined) return -1;
    if (leftRatio === undefined && rightRatio !== undefined) return 1;
    if (leftRatio !== undefined && rightRatio !== undefined && leftRatio !== rightRatio) {
      return rightRatio - leftRatio;
    }
    return orderMeta(pool, [left, right]).indexOf(left) - orderMeta(pool, [left, right]).indexOf(right);
  })[0];
}

function resolveValue(result) {
  if (typeof result === "string") return result.trim() || undefined;
  if (record(result) && typeof result.value === "string") return result.value.trim() || undefined;
  return undefined;
}

function duplicateResolvedSecrets(entries) {
  const seen = new Map();
  for (const entry of entries) {
    const digest = createHash("sha256").update(entry.value).digest("hex");
    const previous = seen.get(digest);
    if (previous && previous !== entry.meta.id) return true;
    seen.set(digest, entry.meta.id);
  }
  return false;
}

async function resolvedCandidates(pool, { resolveSecret, now, exclude }) {
  if (typeof resolveSecret !== "function") return { entries: [], reason: "secret_resolver_required" };
  const entries = [];
  for (const meta of eligibleMeta(pool, now, exclude)) {
    let resolved;
    try {
      resolved = await resolveSecret({ ...meta.secretRef });
    } catch {
      resolved = undefined;
    }
    const value = resolveValue(resolved);
    if (value) entries.push({ meta, value });
  }
  if (duplicateResolvedSecrets(entries)) return { entries: [], reason: "duplicate_secret_reference" };
  return { entries };
}

function sessionCanStay(pool, session, meta, at) {
  if (!pool.policy.sticky || !session || !meta) return false;
  if (session.turns >= pool.policy.stickyLimit) return false;
  return !cooldownActive(meta, at) && meta.state === "active" && !meta.paused;
}

function selectedResult(provider, pool, selected, value, session, rebound = false) {
  return {
    configured: true,
    valid: true,
    providerId: provider,
    credentialId: selected?.id || null,
    credentialRef: selected ? { ...selected.secretRef } : undefined,
    credentialValue: value,
    reason: selected ? (rebound ? "rebound" : session ? "sticky" : "selected") : "no_eligible_credentials",
    strategy: pool.policy.strategy,
    ...(session ? { session: { ...session } } : {}),
  };
}

async function selectFromState(providerOrId, options = {}) {
  const provider = providerId(providerOrId);
  const filePath = options.filePath || PROVIDER_API_KEY_POOL_PATH_DEFAULT;
  const at = nowMs(options.now);
  const state = options.state || readProviderApiKeyPoolState(filePath, { now: at });
  if (!state.valid) {
    return { configured: true, valid: false, providerId: provider, credentialId: null, reason: "invalid_pool_state", fallbackAllowed: false };
  }
  const pool = state.providers[provider];
  if (!pool) {
    return { configured: false, valid: true, providerId: provider, credentialId: null, reason: "pool_not_configured", fallbackAllowed: true };
  }
  const excluded = new Set((options.excludeCredentialIds || []).map((id) => credentialId(id)));
  const resolved = await resolvedCandidates(pool, {
    resolveSecret: options.resolveSecret,
    now: at,
    exclude: excluded,
  });
  if (!resolved.entries.length) {
    return selectedResult(provider, pool, undefined, undefined, undefined);
  }
  const session = sessionId(options.sessionId);
  const bound = session ? pool.sessions[session] : undefined;
  const boundEntry = bound
    ? resolved.entries.find((entry) => entry.meta.id === bound.credentialId)
    : undefined;
  let selectedEntry = boundEntry && sessionCanStay(pool, bound, boundEntry.meta, at)
    ? boundEntry
    : undefined;
  let rebound = false;
  if (!selectedEntry) {
    selectedEntry = { meta: chooseMeta(pool, resolved.entries.map((entry) => entry.meta)) };
    selectedEntry.value = resolved.entries.find((entry) => entry.meta.id === selectedEntry.meta.id)?.value;
    rebound = Boolean(bound && selectedEntry.meta && selectedEntry.meta.id !== bound.credentialId);
  }
  if (!selectedEntry?.meta || !selectedEntry.value) return selectedResult(provider, pool, undefined, undefined, undefined);
  if (options.commit !== false) {
    selectedEntry.meta.health.lastUsedAt = isoNow(at);
    if (pool.policy.strategy === "round-robin" && !boundEntry) {
      pool.roundRobinCursor = (pool.roundRobinCursor + 1) % Math.max(1, resolved.entries.length);
    }
    if (session) {
      const previous = pool.sessions[session];
      pool.sessions[session] = {
        credentialId: selectedEntry.meta.id,
        turns: rebound ? 1 : (previous?.turns || 0) + 1,
        requests: rebound ? 1 : (previous?.requests || 0) + 1,
        boundAt: rebound && previous ? previous.boundAt : previous?.boundAt || isoNow(at),
        updatedAt: isoNow(at),
        ...(rebound && previous ? { reboundAt: isoNow(at) } : {}),
        ...(rebound ? { lastReason: options.rebindReason || "credential_unavailable" } : {}),
      };
    }
  }
  return selectedResult(provider, pool, selectedEntry.meta, selectedEntry.value, session ? pool.sessions[session] : undefined, rebound);
}

function lockTarget(filePath) {
  return `${filePath}.pool-lock-target`;
}

function lockError(waitMs, cause) {
  const error = new Error(`Provider API-key pool is locked; retry after ${Math.max(1, Math.ceil(waitMs / 1_000))}s.`, { cause });
  error.code = "provider_api_key_pool_locked";
  return error;
}

export async function withProviderApiKeyPoolLock(operation, {
  filePath = PROVIDER_API_KEY_POOL_PATH_DEFAULT,
  waitMs = DEFAULT_LOCK_WAIT_MS,
  retryMs = DEFAULT_LOCK_RETRY_MS,
  staleMs = DEFAULT_LOCK_STALE_MS,
} = {}) {
  const directory = path.dirname(filePath);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const normalizedWait = Math.max(0, Math.floor(Number(waitMs) || 0));
  const normalizedRetry = Math.max(1, Math.floor(Number(retryMs) || DEFAULT_LOCK_RETRY_MS));
  const retries = Math.max(0, Math.ceil(normalizedWait / normalizedRetry) - 1);
  let release;
  try {
    release = await lockfile.lock(lockTarget(filePath), {
      realpath: false,
      lockfilePath: `${filePath}.pool-lock`,
      stale: Math.max(2_000, Math.floor(Number(staleMs) || DEFAULT_LOCK_STALE_MS)),
      retries: {
        retries,
        factor: 1,
        minTimeout: normalizedRetry,
        maxTimeout: normalizedRetry,
        randomize: false,
      },
    });
  } catch (error) {
    if (error?.code === "ELOCKED") throw lockError(normalizedWait, error);
    throw error;
  }
  try {
    return await operation();
  } finally {
    await release();
  }
}

async function mutatePool(filePath, operation) {
  return withProviderApiKeyPoolLock(async () => {
    const state = readProviderApiKeyPoolState(filePath);
    if (!state.valid) throw new Error("Provider API-key pool state is invalid; refusing to overwrite it.");
    const next = { version: PROVIDER_API_KEY_POOL_SCHEMA_VERSION, providers: state.providers };
    const result = await operation(next);
    writePrivateJson(filePath, stateForWrite(next), { directoryMode: 0o700 });
    return result;
  }, { filePath });
}

export function selectProviderApiKey(providerOrId, options = {}) {
  return selectFromState(providerOrId, { ...options, commit: false });
}

export async function selectProviderApiKeyLocked(providerOrId, options = {}) {
  const filePath = options.filePath || PROVIDER_API_KEY_POOL_PATH_DEFAULT;
  return withProviderApiKeyPoolLock(
    () => mutateSelect(providerOrId, { ...options, filePath }),
    { filePath, waitMs: options.waitMs, retryMs: options.retryMs, staleMs: options.staleMs },
  );
}

async function mutateSelect(providerOrId, options) {
  const filePath = options.filePath || PROVIDER_API_KEY_POOL_PATH_DEFAULT;
  const state = readProviderApiKeyPoolState(filePath, { now: nowMs(options.now) });
  if (!state.valid) return { configured: true, valid: false, providerId: providerId(providerOrId), credentialId: null, reason: "invalid_pool_state", fallbackAllowed: false };
  const result = await selectFromState(providerOrId, { ...options, state, filePath, commit: true });
  if (state.providers[result.providerId]) {
    writePrivateJson(filePath, stateForWrite(state, nowMs(options.now)), { directoryMode: 0o700 });
  }
  return result;
}

export async function upsertProviderApiKey(providerOrId, credential, {
  filePath = PROVIDER_API_KEY_POOL_PATH_DEFAULT,
} = {}) {
  const provider = providerId(providerOrId);
  const normalized = normalizeCredential({ ...credential, providerId: provider }, provider);
  return mutatePool(filePath, async (state) => {
    const pool = state.providers[provider] || {
      providerId: provider,
      policy: normalizePolicy(),
      roundRobinCursor: 0,
      credentials: {},
      sessions: {},
    };
    for (const current of Object.values(pool.credentials)) {
      if (current.id !== normalized.id && providerApiKeySecretRefIdentity(current.secretRef) === providerApiKeySecretRefIdentity(normalized.secretRef)) {
        throw new Error(`Provider ${provider} already contains this secret reference.`);
      }
    }
    pool.credentials[normalized.id] = normalized;
    state.providers[provider] = pool;
    return sanitizeProviderApiKeyPoolCredential(normalized);
  });
}

export async function setProviderApiKeyPoolPolicy(providerOrId, patch, {
  filePath = PROVIDER_API_KEY_POOL_PATH_DEFAULT,
} = {}) {
  const provider = providerId(providerOrId);
  return mutatePool(filePath, async (state) => {
    const pool = state.providers[provider];
    if (!pool) throw new Error(`Provider ${provider} API-key pool is not configured.`);
    pool.policy = normalizePolicy({ ...pool.policy, ...(patch || {}) });
    return { ...pool.policy };
  });
}

export async function setProviderApiKeyPaused(providerOrId, credentialOrId, paused, {
  filePath = PROVIDER_API_KEY_POOL_PATH_DEFAULT,
} = {}) {
  const provider = providerId(providerOrId);
  const id = credentialId(credentialOrId);
  if (typeof paused !== "boolean") throw new Error("paused must be a boolean.");
  return mutatePool(filePath, async (state) => {
    const pool = state.providers[provider];
    if (!pool?.credentials[id]) throw new Error(`Credential ${id} is not configured for ${provider}.`);
    pool.credentials[id].paused = paused;
    pool.credentials[id].state = paused ? "paused" : "active";
    pool.policy.pausedCredentialIds = paused
      ? [...new Set([...pool.policy.pausedCredentialIds, id])]
      : pool.policy.pausedCredentialIds.filter((entry) => entry !== id);
    return sanitizeProviderApiKeyPoolCredential(pool.credentials[id]);
  });
}

export function isRetryableProviderApiKeyFailure({ status, errorCode, committed = false } = {}) {
  if (committed) return false;
  const normalizedStatus = Number(status);
  if (Number.isInteger(normalizedStatus)) return TRANSIENT_STATUS.has(normalizedStatus);
  return TRANSIENT_ERROR_CODES.has(String(errorCode || ""));
}

function cooldownSeconds(pool, { status, retryAfterSeconds } = {}) {
  const max = pool.policy.maxCooldownSeconds;
  const retryAfter = finiteNumber(retryAfterSeconds);
  if (retryAfter !== undefined && retryAfter > 0) return Math.min(max, retryAfter);
  if (status === 429) return Math.min(max, 60);
  if (status >= 500) return Math.min(max, 30);
  if (status === 401 || status === 403) return max;
  return 0;
}

export async function recordProviderApiKeyOutcome(providerOrId, credentialOrId, outcome = {}, {
  filePath = PROVIDER_API_KEY_POOL_PATH_DEFAULT,
} = {}) {
  const provider = providerId(providerOrId);
  const id = credentialId(credentialOrId);
  const at = nowMs(outcome.now);
  return mutatePool(filePath, async (state) => {
    const pool = state.providers[provider];
    const meta = pool?.credentials[id];
    if (!meta) return { recorded: false, rebindRecommended: false };
    const status = Number.isInteger(Number(outcome.status)) ? Number(outcome.status) : undefined;
    const committed = outcome.committed === true;
    const ok = outcome.ok === true || (status !== undefined && status >= 200 && status < 400);
    meta.health.lastStatus = status;
    meta.health.lastUsedAt = isoNow(at);
    meta.requestCount += 1;
    if (Number.isFinite(outcome.tokens) && outcome.tokens >= 0) meta.tokenCount += Math.floor(outcome.tokens);
    if (ok) {
      meta.health.state = "healthy";
      meta.health.lastSuccessAt = isoNow(at);
      delete meta.health.cooldownUntil;
      delete meta.health.lastError;
      meta.health.failureCount = 0;
    } else {
      const retryable = isRetryableProviderApiKeyFailure({
        status,
        errorCode: outcome.errorCode,
        committed,
      });
      const seconds = retryable ? cooldownSeconds(pool, { status, retryAfterSeconds: outcome.retryAfterSeconds }) : 0;
      meta.health.lastErrorAt = isoNow(at);
      const error = text(outcome.error || outcome.message, "outcome error", { max: MAX_ERROR_LENGTH });
      if (error) meta.health.lastError = error;
      meta.health.failureCount = integer(meta.health.failureCount, 0) + 1;
      if (retryable && seconds > 0) {
        meta.health.state = "cooldown";
        meta.health.cooldownUntil = new Date(at + seconds * 1_000).toISOString();
      }
      return {
        recorded: true,
        rebindRecommended: retryable && !committed,
        committed,
        credential: sanitizeProviderApiKeyPoolCredential(meta),
      };
    }
    return {
      recorded: true,
      rebindRecommended: false,
      committed,
      credential: sanitizeProviderApiKeyPoolCredential(meta),
    };
  });
}

export async function runProviderApiKeyAttempts(providerOrId, {
  resolveSecret,
  send,
  sessionId: sessionValue,
  initialSelection,
  filePath = PROVIDER_API_KEY_POOL_PATH_DEFAULT,
  maxAttempts = MAX_CREDENTIALS,
  isResponseCommitted,
  now = Date.now,
} = {}) {
  const provider = providerId(providerOrId);
  if (typeof send !== "function") throw new Error("send must be a function.");
  const status = poolStatus(provider, filePath, now());
  if (!status.configured) return { configured: false, fallbackAllowed: true, providerId: provider };
  if (!status.valid) return { configured: true, valid: false, fallbackAllowed: false, providerId: provider, reason: "invalid_pool_state" };
  const attempted = new Set();
  const attempts = [];
  for (let index = 0; index < Math.min(MAX_CREDENTIALS, Math.max(1, Math.floor(maxAttempts))); index += 1) {
    if (typeof isResponseCommitted === "function" && isResponseCommitted()) {
      return { configured: true, valid: true, providerId: provider, attempts, committed: true, reason: "response_committed" };
    }
    const selection = initialSelection && index === 0
      ? initialSelection
      : await selectProviderApiKeyLocked(provider, {
          filePath,
          resolveSecret,
          sessionId: sessionValue,
          excludeCredentialIds: [...attempted],
          now: now(),
          rebindReason: "previous_credential_failed_before_response",
        });
    if (!selection.credentialId || !selection.credentialValue) {
      return { configured: true, valid: true, providerId: provider, attempts, reason: selection.reason };
    }
    attempted.add(selection.credentialId);
    let result;
    let error;
    try {
      result = await send({
        apiKey: selection.credentialValue,
        credentialId: selection.credentialId,
        secretRef: { ...selection.credentialRef },
        attempt: index,
      });
    } catch (caught) {
      error = caught;
    }
    const responseCommitted = typeof isResponseCommitted === "function"
      ? isResponseCommitted()
      : typeof result?.committed === "boolean"
        ? result.committed
        : true;
    const statusCode = Number.isInteger(Number(result?.status)) ? Number(result.status) : undefined;
    const ok = !error && (result?.ok === true || (statusCode !== undefined && statusCode >= 200 && statusCode < 400));
    const errorCode = error?.code || result?.errorCode;
    const outcome = await recordProviderApiKeyOutcome(provider, selection.credentialId, {
      status: statusCode,
      ok,
      committed: responseCommitted,
      errorCode,
      error: error?.message || result?.error,
      retryAfterSeconds: Number(result?.retryAfterSeconds),
      now: now(),
    }, { filePath });
    const attempt = {
      credentialId: selection.credentialId,
      status: statusCode,
      ok,
      committed: responseCommitted,
      ...(outcome?.rebindRecommended ? { rebound: true } : {}),
    };
    attempts.push(attempt);
    if (error) {
      if (!isRetryableProviderApiKeyFailure({ errorCode, committed: responseCommitted })) {
        return { configured: true, valid: true, providerId: provider, result, error, attempts, reason: "failed" };
      }
    } else if (ok || responseCommitted || !isRetryableProviderApiKeyFailure({ status: statusCode, committed: responseCommitted })) {
      return { configured: true, valid: true, providerId: provider, result, attempts, reason: ok ? "success" : "failed" };
    }
  }
  return { configured: true, valid: true, providerId: provider, attempts, reason: "no_retry_candidate" };
}
