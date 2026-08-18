import {
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
  chmodSync,
  renameSync,
} from "node:fs";
import path from "node:path";
import { randomUUID, createHash } from "node:crypto";

import { protectPrivateFile, writePrivateJson } from "./file-security.mjs";
import { STATE_DIR } from "./paths.mjs";
import { PROVIDERS } from "./model-registry.mjs";
import {
  apiProvider,
  primaryCredentialPath,
  credentialPaths,
  resolveProviderCredential,
} from "./provider-credentials.mjs";
import { upstreamFailureKind, extractUpstreamDetail } from "./error-translation.mjs";

// ─── Credential pools: same-provider rotation ─────────────────────────────────
//
// Hermes Agent's Credential Pools let one provider hold many API keys and rotate
// among them when one is rate-limited or quota-exhausted. This module brings
// that spirit to Codex Router for external API-key providers.
//
// A pool is per *canonical* provider id (variantOf collapses to its parent), so
// `opencode-go` and its protocol variants share one pool. Keyless, anonymous,
// and per-model-endpoint providers cannot have pools — they carry no credential
// or their credential lives per model.
//
// Storage
// ───────
// Pool metadata lives in STATE_DIR/credential-pools.json (protected 0600). No
// secret is stored there — each pool member's secret lives in its own
// protected file under STATE_DIR. The pool file only records the file path
// plus bookkeeping (request counts, cooldowns, labels).
//
// Backward compatibility
// ──────────────────────
// An install with no pool file behaves exactly as before: resolveProvider-
// Credential is the sole credential source. The first `credential-pool add`
// seeds the pool from the existing primary credential file if one exists, so
// enabling pools never discards a working key.

export const POOL_PATH =
  process.env.MODEL_ROUTER_CREDENTIAL_POOLS ||
  path.join(STATE_DIR, "credential-pools.json");

export const VALID_STRATEGIES = Object.freeze([
  "fill_first",
  "round_robin",
  "least_used",
  "random",
]);
export const DEFAULT_STRATEGY = "fill_first";

// Cooldowns: match Hermes's defaults (1h for billing/quota/rate-limit, 5m for
// auth) but honour provider-supplied Retry-After when present.
export const DEFAULT_COOLDOWN_MS = 60 * 60 * 1_000;
export const AUTH_COOLDOWN_MS = 5 * 60 * 1_000;
export const MAX_COOLDOWN_MS = 6 * 60 * 60 * 1_000;

function nowMs(now) {
  return Number.isFinite(now) ? now : Date.now();
}

function cappedUntil(at, durationMs) {
  return new Date(at + Math.min(durationMs, MAX_COOLDOWN_MS)).toISOString();
}

function isoOrUndefined(value) {
  const ms = typeof value === "string" ? Date.parse(value) : Number(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : undefined;
}

function canonicalId(providerId) {
  const id = String(providerId || "").trim();
  if (!id) return "";
  // Collapse protocol variants (registry `variantOf`) to their canonical parent,
  // matching provider-selection's canonicalProviderId without creating a cycle.
  const provider = PROVIDERS.get(id);
  if (provider?.variantOf) return provider.variantOf;
  return id;
}

function providerForPool(providerId) {
  const id = canonicalId(providerId);
  const provider = PROVIDERS.get(id);
  if (!provider) throw new Error(`Unknown provider: ${providerId}`);
  if (provider.kind !== "openai-compatible") {
    throw new Error(`Provider ${id} does not use API-key credentials and cannot have a pool.`);
  }
  if (provider.keyless || ["anonymous", "per-model"].includes(provider.authMode)) {
    throw new Error(`Provider ${id} carries no credential and cannot have a pool.`);
  }
  if (!provider.credential?.file) {
    throw new Error(`Provider ${id} is missing credential metadata and cannot have a pool.`);
  }
  return provider;
}

function providerIsPoolable(providerId) {
  try {
    providerForPool(providerId);
    return true;
  } catch {
    return false;
  }
}

function readPoolDocument() {
  if (!existsSync(POOL_PATH)) return { version: 1, pools: {} };
  try {
    const parsed = JSON.parse(readFileSync(POOL_PATH, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { version: 1, pools: {} };
    if (parsed.version !== 1) return { version: 1, pools: {} };
    if (!parsed.pools || typeof parsed.pools !== "object") return { version: 1, pools: {} };
    return { version: 1, pools: parsed.pools };
  } catch {
    return { version: 1, pools: {} };
  }
}

function writePoolDocument(document) {
  const toWrite = { version: 1, pools: document.pools || {} };
  try {
    writePrivateJson(POOL_PATH, toWrite, { directoryMode: 0o700 });
  } catch (error) {
    // Pool bookkeeping must never take routing down, but writes here are CLI-
    // initiated and should surface.
    throw error;
  }
  return toWrite;
}

function poolMemberFile(provider, id) {
  const primary = primaryCredentialPath(provider);
  const dir = path.dirname(primary);
  const base = path.basename(primary, path.extname(primary));
  const ext = path.extname(primary) || ".secret";
  // e.g. deepseek-api-key.pool.a1b2c3d4.secret
  return path.join(dir, `${base}.pool.${id}${ext}`);
}

function generateId() {
  return randomUUID().replaceAll("-", "").slice(0, 8);
}

function fingerprint(value) {
  return `sha256:${createHash("sha256").update(String(value)).digest("hex").slice(0, 16)}`;
}

function ensurePoolEntry(providerId) {
  const id = canonicalId(providerId);
  const doc = readPoolDocument();
  if (!doc.pools[id]) {
    doc.pools[id] = {
      strategy: DEFAULT_STRATEGY,
      credentials: [],
      state: { roundRobinIndex: 0 },
    };
  } else {
    if (!VALID_STRATEGIES.includes(doc.pools[id].strategy)) {
      doc.pools[id].strategy = DEFAULT_STRATEGY;
    }
    if (!Array.isArray(doc.pools[id].credentials)) doc.pools[id].credentials = [];
    if (!doc.pools[id].state || typeof doc.pools[id].state !== "object") {
      doc.pools[id].state = { roundRobinIndex: 0 };
    }
    if (!Number.isFinite(doc.pools[id].state.roundRobinIndex)) {
      doc.pools[id].state.roundRobinIndex = 0;
    }
  }
  return { doc, pool: doc.pools[id], id };
}

function isHealthy(credential, now) {
  const at = nowMs(now);
  const until = isoOrUndefined(credential.cooldownUntil);
  if (!until) return true;
  return Date.parse(until) <= at;
}

function healthyCredentials(pool, now) {
  const at = nowMs(now);
  return pool.credentials.filter((cred) => isHealthy(cred, at));
}

function readSecretFile(filePath) {
  try {
    const value = readFileSync(filePath, "utf8").trim();
    return value || undefined;
  } catch {
    return undefined;
  }
}

function writeSecretFile(filePath, value) {
  const key = String(value || "").trim();
  if (!key) throw new Error("No credential value was provided; nothing changed.");
  mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  chmodSync(path.dirname(filePath), 0o700);
  const temporary = `${filePath}.tmp.${process.pid}`;
  writeFileSync(temporary, `${key}\n`, { encoding: "utf8", mode: 0o600 });
  try {
    protectPrivateFile(temporary);
    renameSync(temporary, filePath);
    protectPrivateFile(filePath);
  } catch (error) {
    if (existsSync(temporary)) unlinkSync(temporary);
    throw error;
  }
  return filePath;
}

// ── Public: pool metadata ───────────────────────────────────────────────────

export function getPool(providerId) {
  const id = canonicalId(providerId);
  const doc = readPoolDocument();
  return doc.pools[id] ? { ...doc.pools[id], id } : undefined;
}

export function listPools() {
  const doc = readPoolDocument();
  return Object.entries(doc.pools).map(([id, pool]) => ({ id, ...pool }));
}

export function getStrategy(providerId) {
  const id = canonicalId(providerId);
  const doc = readPoolDocument();
  const pool = doc.pools[id];
  if (!pool) return DEFAULT_STRATEGY;
  return VALID_STRATEGIES.includes(pool.strategy) ? pool.strategy : DEFAULT_STRATEGY;
}

export function setStrategy(providerId, strategy) {
  const provider = providerForPool(providerId);
  const normalized = String(strategy || "").trim().toLowerCase();
  if (!VALID_STRATEGIES.includes(normalized)) {
    throw new Error(`Unknown rotation strategy "${strategy}". Valid: ${VALID_STRATEGIES.join(", ")}`);
  }
  const { doc, pool, id } = ensurePoolEntry(provider.id);
  pool.strategy = normalized;
  writePoolDocument(doc);
  return { provider: id, strategy: normalized };
}

export function strategyLabel(strategy) {
  const labels = {
    fill_first: "fill_first — use the first healthy credential until exhausted, then move to the next (default)",
    round_robin: "round_robin — cycle evenly through healthy credentials",
    least_used: "least_used — always pick the credential with the lowest request count",
    random: "random — randomly select among healthy credentials",
  };
  return labels[strategy] || strategy;
}

// ── Public: credential CRUD ─────────────────────────────────────────────────

export function addCredential(providerId, value, options = {}) {
  const provider = providerForPool(providerId);
  const key = String(value || "").trim();
  if (!key) throw new Error("No credential value was provided; nothing changed.");
  const label = typeof options.label === "string" ? options.label.trim() : "";
  const { doc, pool, id } = ensurePoolEntry(provider.id);

  // Seed from primary file on first pool use. The primary file is the operator's
  // existing single credential; promoting it into the pool keeps it live and
  // makes the pool's first entry the one the install already authenticates with.
  if (pool.credentials.length === 0) {
    const primaryPath = primaryCredentialPath(provider);
    const primaryValue = readSecretFile(primaryPath);
    if (primaryValue) {
      const primaryFingerprint = fingerprint(primaryValue);
      const alreadySeeded = pool.credentials.some((cred) => cred.file === primaryPath);
      if (!alreadySeeded) {
        // If the new key is identical to the primary, don't create a duplicate.
        if (fingerprint(key) !== primaryFingerprint) {
          pool.credentials.push({
            id: generateId(),
            label: "primary",
            file: primaryPath,
            source: "file",
            fingerprint: primaryFingerprint,
            createdAt: new Date().toISOString(),
            requestCount: 0,
            cooldownUntil: null,
            lastStatus: "ok",
            hasRetried429: false,
          });
        }
      }
    }
  }

  // Reject exact duplicates (same fingerprint) across the pool.
  const newFingerprint = fingerprint(key);
  const duplicate = pool.credentials.find((cred) => cred.fingerprint === newFingerprint);
  if (duplicate) {
    throw new Error(
      `This credential is already in the ${id} pool as "${duplicate.label || duplicate.id}" (#${pool.credentials.indexOf(duplicate) + 1}).`,
    );
  }

  const credId = generateId();
  const filePath = poolMemberFile(provider, credId);
  writeSecretFile(filePath, key);

  const entry = {
    id: credId,
    label: label || `key-${pool.credentials.length + 1}`,
    file: filePath,
    source: "pool",
    fingerprint: newFingerprint,
    createdAt: new Date().toISOString(),
    requestCount: 0,
    cooldownUntil: null,
    lastStatus: "ok",
    hasRetried429: false,
  };
  pool.credentials.push(entry);
  writePoolDocument(doc);
  return { provider: id, credential: entry, index: pool.credentials.length };
}

export function removeCredential(providerId, identifier) {
  const provider = providerForPool(providerId);
  const id = canonicalId(provider.id);
  const doc = readPoolDocument();
  const pool = doc.pools[id];
  if (!pool || !Array.isArray(pool.credentials) || pool.credentials.length === 0) {
    throw new Error(`Provider ${id} has no credential pool.`);
  }
  const raw = String(identifier || "").trim();
  if (!raw) throw new Error("No credential identifier was provided.");
  let index = -1;
  // 1-based index takes precedence when the input is a positive integer within range.
  const asNumber = Number(raw);
  if (Number.isInteger(asNumber) && asNumber >= 1 && asNumber <= pool.credentials.length) {
    index = asNumber - 1;
  } else {
    index = pool.credentials.findIndex((cred) => cred.id === raw || cred.label === raw);
  }
  if (index === -1) {
    throw new Error(`No credential "${identifier}" found in ${id} pool. Use "credential-pool list ${id}" to see available entries.`);
  }
  const [removed] = pool.credentials.splice(index, 1);
  // Only delete pool-managed files. The primary credential file (the original
  // single-key location) is deleted too when it is the removed entry — that is
  // the operator's explicit intent via `remove`.
  if (removed.file && existsSync(removed.file)) {
    const primary = primaryCredentialPath(provider);
    // Allow deletion of both primary and pool-member files; they are all
    // protected files under STATE_DIR. Never delete a file outside STATE_DIR.
    const stateDir = path.resolve(STATE_DIR);
    const fileDir = path.resolve(path.dirname(removed.file));
    if (fileDir === stateDir || fileDir.startsWith(stateDir + path.sep)) {
      try {
        unlinkSync(removed.file);
      } catch {
        // File may have been removed externally; pool entry removal is what matters.
      }
    }
  }
  // Clean up empty pool: remove the provider entry entirely rather than leaving
  // an empty strategy shell. The pool is recreated on next add.
  if (pool.credentials.length === 0) {
    delete doc.pools[id];
  }
  writePoolDocument(doc);
  return { provider: id, removed, remaining: pool.credentials.length };
}

// ── Public: cooldown management ─────────────────────────────────────────────

export function resetCooldowns(providerId, options = {}) {
  const now = nowMs(options.now);
  if (providerId) {
    const id = canonicalId(providerId);
    const doc = readPoolDocument();
    const pool = doc.pools[id];
    if (!pool) return { provider: id, reset: 0 };
    let reset = 0;
    for (const cred of pool.credentials) {
      if (cred.cooldownUntil || cred.hasRetried429 || cred.lastStatus !== "ok") {
        cred.cooldownUntil = null;
        cred.hasRetried429 = false;
        cred.lastStatus = "ok";
        reset += 1;
      }
    }
    writePoolDocument(doc);
    return { provider: id, reset };
  }
  const doc = readPoolDocument();
  let total = 0;
  for (const pool of Object.values(doc.pools)) {
    for (const cred of pool.credentials) {
      if (cred.cooldownUntil || cred.hasRetried429 || cred.lastStatus !== "ok") {
        cred.cooldownUntil = null;
        cred.hasRetried429 = false;
        cred.lastStatus = "ok";
        total += 1;
      }
    }
  }
  writePoolDocument(doc);
  return { provider: "all", reset: total };
}

// ── Public: selection & rotation ────────────────────────────────────────────

export function credentialPoolStatus(providerId) {
  const id = canonicalId(providerId);
  const doc = readPoolDocument();
  const pool = doc.pools[id];
  if (!pool) return { provider: id, exists: false, strategy: DEFAULT_STRATEGY, credentials: [] };
  const at = Date.now();
  const credentials = pool.credentials.map((cred, idx) => ({
    index: idx + 1,
    id: cred.id,
    label: cred.label,
    file: cred.file,
    source: cred.source,
    fingerprint: cred.fingerprint,
    requestCount: cred.requestCount || 0,
    lastStatus: cred.lastStatus || "ok",
    cooldownUntil: cred.cooldownUntil || null,
    healthy: isHealthy(cred, at),
    hasRetried429: Boolean(cred.hasRetried429),
    createdAt: cred.createdAt,
  }));
  return {
    provider: id,
    exists: true,
    strategy: pool.strategy || DEFAULT_STRATEGY,
    credentials,
    total: credentials.length,
    healthy: credentials.filter((c) => c.healthy).length,
    state: pool.state || { roundRobinIndex: 0 },
  };
}

function pickCredential(pool, now) {
  const at = nowMs(now);
  const healthy = healthyCredentials(pool, at);
  if (!healthy.length) return undefined;
  const strategy = VALID_STRATEGIES.includes(pool.strategy) ? pool.strategy : DEFAULT_STRATEGY;
  if (strategy === "fill_first") {
    // First healthy in insertion order.
    return pool.credentials.find((cred) => isHealthy(cred, at));
  }
  if (strategy === "round_robin") {
    const index = Number.isFinite(pool.state?.roundRobinIndex) ? pool.state.roundRobinIndex : 0;
    const healthySet = new Set(healthy.map((c) => c.id));
    // Walk the pool in order starting at roundRobinIndex, wrapping around.
    for (let offset = 0; offset < pool.credentials.length; offset += 1) {
      const candidate = pool.credentials[(index + offset) % pool.credentials.length];
      if (healthySet.has(candidate.id)) {
        pool.state.roundRobinIndex = (pool.credentials.indexOf(candidate) + 1) % pool.credentials.length;
        return candidate;
      }
    }
    return healthy[0];
  }
  if (strategy === "least_used") {
    let best = healthy[0];
    for (const cred of healthy) {
      if ((cred.requestCount || 0) < (best.requestCount || 0)) best = cred;
    }
    return best;
  }
  if (strategy === "random") {
    return healthy[Math.floor(Math.random() * healthy.length)];
  }
  return healthy[0];
}

export function selectCredential(providerId, options = {}) {
  const id = canonicalId(providerId);
  // Non-poolable providers (native, anonymous, per-model) have no pool.
  if (!providerIsPoolable(id)) return undefined;
  const doc = readPoolDocument();
  const pool = doc.pools[id];
  if (!pool || !Array.isArray(pool.credentials) || pool.credentials.length === 0) return undefined;
  const at = nowMs(options.now);
  const picked = pickCredential(pool, at);
  if (!picked) return undefined;
  // Bookkeeping: count the selection and remember last use. Persist immediately
  // so least_used and round_robin see the update on the next request.
  picked.requestCount = (picked.requestCount || 0) + 1;
  picked.lastUsedAt = new Date(at).toISOString();
  // A success will clear hasRetried429; a transient 429 keeps it set until the
  // second consecutive 429 promotes to a cooldown. Don't reset here — only on
  // success.
  writePoolDocument(doc);
  const value = readSecretFile(picked.file);
  if (!value) {
    // File missing or empty — skip this credential and try the next healthy one.
    // Mark it as unhealthy briefly so the same missing file isn't picked again
    // in a tight loop.
    picked.cooldownUntil = cappedUntil(at, 60_000);
    picked.lastStatus = "missing";
    writePoolDocument(doc);
    return selectCredential(providerId, options);
  }
  return {
    provider: id,
    id: picked.id,
    label: picked.label,
    file: picked.file,
    source: `pool:${picked.label || picked.id} (${picked.file})`,
    value,
    requestCount: picked.requestCount,
    strategy: pool.strategy,
  };
}

export function resolvePoolCredential(providerOrId, options = {}) {
  const provider =
    typeof providerOrId === "string" ? PROVIDERS.get(canonicalId(providerOrId)) : providerOrId;
  if (!provider) return undefined;
  const id = canonicalId(provider.id || providerOrId);
  return selectCredential(id, options);
}

// Called on successful upstream response for a pooled credential. Mirrors
// Hermes's `has_retried_429` reset on success.
export function markCredentialSuccess(providerId, credentialId, options = {}) {
  const id = canonicalId(providerId);
  const doc = readPoolDocument();
  const pool = doc.pools[id];
  if (!pool) return undefined;
  const cred = pool.credentials.find((c) => c.id === credentialId);
  if (!cred) return undefined;
  cred.cooldownUntil = null;
  cred.lastStatus = "ok";
  cred.hasRetried429 = false;
  writePoolDocument(doc);
  return cred;
}

// Classify a failure for pool rotation. Returns what to do:
//
//  { action: "none" }                          → not a pool-rotatable failure
//  { action: "retry_same", credential }        → transient 429, retry same key once
//  { action: "rotate", credential, next }      → mark exhausted, move to next
//  { action: "exhausted", credential }         → all pool keys are down
//
// The caller decides whether to actually retry the HTTP request; this function
// only mutates pool state.
export function markCredentialFailure(providerId, credentialId, { status, bodyText, retryAfterSeconds, now } = {}) {
  const id = canonicalId(providerId);
  const at = nowMs(now);
  const doc = readPoolDocument();
  const pool = doc.pools[id];
  if (!pool) return { action: "none" };
  const cred = pool.credentials.find((c) => c.id === credentialId);
  if (!cred) return { action: "none" };

  const code = Number(status);
  const kind = upstreamFailureKind({ status: code, bodyText });
  const retryAfter = Number(retryAfterSeconds);
  const hasRetryAfter = Number.isFinite(retryAfter) && retryAfter > 0;
  const cooldownMs = hasRetryAfter ? Math.min(retryAfter * 1000, MAX_COOLDOWN_MS) : DEFAULT_COOLDOWN_MS;

  // Hard limits: quota / billing / plan usage — never retry the same key.
  const isHardLimit =
    kind === "out_of_usage" || code === 402 || (code === 429 && kind === "out_of_usage");

  // Entitlement (plan doesn't include this API) is not rotatable — no other
  // key on the same provider makes it true either. Same as router's failover.
  if (kind === "entitlement") {
    return { action: "none", reason: "entitlement", credential: cred };
  }

  if (isHardLimit) {
    cred.cooldownUntil = hasRetryAfter ? cappedUntil(at, retryAfter * 1000) : new Date(at + cooldownMs).toISOString();
    cred.lastStatus = "out_of_usage";
    cred.hasRetried429 = false;
    writePoolDocument(doc);
    const next = pickCredential(pool, at);
    if (!next) return { action: "exhausted", credential: cred, reason: "out_of_usage", cooldownUntil: cred.cooldownUntil };
    // Don't select via selectCredential (which would bump its count); just name it.
    const nextValue = readSecretFile(next.file);
    return {
      action: "rotate",
      credential: cred,
      next: nextValue ? { id: next.id, label: next.label, file: next.file, value: nextValue } : undefined,
      reason: "out_of_usage",
      cooldownUntil: cred.cooldownUntil,
    };
  }

  if (code === 429) {
    // Generic / burst 429 — Hermes retries same key once, second 429 rotates.
    if (!cred.hasRetried429) {
      cred.hasRetried429 = true;
      cred.lastStatus = "rate_limited_retry";
      writePoolDocument(doc);
      return { action: "retry_same", credential: cred, reason: "rate_limited" };
    }
    cred.cooldownUntil = hasRetryAfter ? cappedUntil(at, retryAfter * 1000) : new Date(at + cooldownMs).toISOString();
    cred.lastStatus = "rate_limited";
    cred.hasRetried429 = false;
    writePoolDocument(doc);
    const next = pickCredential(pool, at);
    if (!next) return { action: "exhausted", credential: cred, reason: "rate_limited", cooldownUntil: cred.cooldownUntil };
    const nextValue = readSecretFile(next.file);
    return {
      action: "rotate",
      credential: cred,
      next: nextValue ? { id: next.id, label: next.label, file: next.file, value: nextValue } : undefined,
      reason: "rate_limited",
      cooldownUntil: cred.cooldownUntil,
    };
  }

  if (code === 401 || code === 403) {
    // Auth failure — brief cooldown then rotate. A 401 on a pooled key is not
    // retried; the key is assumed rejected.
    cred.cooldownUntil = new Date(at + AUTH_COOLDOWN_MS).toISOString();
    cred.lastStatus = code === 401 ? "auth_error" : "forbidden";
    cred.hasRetried429 = false;
    writePoolDocument(doc);
    const next = pickCredential(pool, at);
    if (!next) return { action: "exhausted", credential: cred, reason: cred.lastStatus, cooldownUntil: cred.cooldownUntil };
    const nextValue = readSecretFile(next.file);
    return {
      action: "rotate",
      credential: cred,
      next: nextValue ? { id: next.id, label: next.label, file: next.file, value: nextValue } : undefined,
      reason: cred.lastStatus,
      cooldownUntil: cred.cooldownUntil,
    };
  }

  return { action: "none", credential: cred };
}

// Convenience: record a failure and log rotation in one call for forwarders.
export function recordPoolFailureAndRotate(providerId, credentialId, details = {}) {
  const result = markCredentialFailure(providerId, credentialId, details);
  if (result.action === "rotate") {
    console.error(
      `[credential-pool] provider=${canonicalId(providerId)} credential=${result.credential.label || result.credential.id} reason=${result.reason} cooldown_until=${result.cooldownUntil} -> ${result.next ? result.next.label || result.next.id : "exhausted"}`,
    );
  } else if (result.action === "exhausted") {
    console.error(
      `[credential-pool] provider=${canonicalId(providerId)} credential=${result.credential.label || result.credential.id} reason=${result.reason} — all pool credentials exhausted`,
    );
  } else if (result.action === "retry_same") {
    console.error(
      `[credential-pool] provider=${canonicalId(providerId)} credential=${result.credential.label || result.credential.id} 429 transient — retrying same credential once`,
    );
  }
  return result;
}

// ── Convenience: does this provider have a pool with >1 credential? ───────────
export function hasCredentialPool(providerId) {
  const id = canonicalId(providerId);
  const doc = readPoolDocument();
  const pool = doc.pools[id];
  return Boolean(pool && Array.isArray(pool.credentials) && pool.credentials.length > 0);
}

export function credentialPoolSize(providerId) {
  const id = canonicalId(providerId);
  const doc = readPoolDocument();
  const pool = doc.pools[id];
  return pool?.credentials?.length || 0;
}

// For tests: reset whole pool file.
export function clearAllPools() {
  writePrivateJson(POOL_PATH, { version: 1, pools: {} }, { directoryMode: 0o700 });
}

// Legacy helper: does a provider's credential resolve via pool or single file?
// Used to make configuredProviderIds pool-aware without importing the whole
// selection loop into this module.
export function poolAwareCredentialStatus(providerId) {
  const id = canonicalId(providerId);
  const pool = getPool(id);
  if (pool && pool.credentials.length > 0) {
    const healthy = pool.credentials.filter((cred) => {
      const until = isoOrUndefined(cred.cooldownUntil);
      if (!until) return true;
      return Date.parse(until) <= Date.now();
    });
    if (healthy.length > 0) {
      return { configured: true, source: `credential pool (${healthy.length}/${pool.credentials.length} healthy)`, persistent: true };
    }
    // All pooled credentials are in cooldown — still considered configured, just temporarily exhausted.
    return { configured: true, source: `credential pool (all ${pool.credentials.length} in cooldown)`, persistent: true };
  }
  return undefined;
}
