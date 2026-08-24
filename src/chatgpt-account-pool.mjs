import { existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";

import lockfile from "proper-lockfile";

import { writePrivateJson } from "./file-security.mjs";
import { CHATGPT_ACCOUNT_POOL_PATH } from "./paths.mjs";

// Policy-only account routing for the first-party Codex/ChatGPT surface.  This
// module deliberately does not read, copy, refresh, or write OAuth tokens.  An
// integration can pass opaque account references at the request boundary; the
// native login implementation remains the only owner of those credentials.
export const CHATGPT_ACCOUNT_POOL_SCHEMA_VERSION = 1;
export const CHATGPT_ACCOUNT_POOL_STRATEGIES = Object.freeze([
  "quota",
  "round-robin",
  "fill-first",
]);
export const CHATGPT_ACCOUNT_POOL_HEALTH_STATES = Object.freeze([
  "healthy",
  "cooldown",
  "reauth-required",
  "failed",
]);

const ACCOUNT_ID = /^acct_[A-Za-z0-9_-]{8,80}$/;
const SESSION_ID_LIMIT = 256;
const MAX_ACCOUNTS = 64;
const MAX_SESSIONS = 2_048;
const MAX_WINDOWS = 16;
const MAX_ERROR_LENGTH = 512;
const MAX_COOLDOWN_SECONDS = 24 * 60 * 60;

const DEFAULT_POLICY = Object.freeze({
  // Pooling is opt-in. A missing/disabled policy is an explicit signal to
  // leave the native single-account path alone.
  enabled: false,
  strategy: "quota",
  autoSwitchThreshold: 0.1,
  sticky: true,
  stickyLimit: 50,
  maxCooldownSeconds: 300,
  priorityOrder: [],
  pausedAccountIds: [],
});

function text(value) {
  return typeof value === "string" ? value.trim() : "";
}

function number(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function integer(value, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const parsed = number(value);
  return Number.isFinite(parsed) ? Math.min(max, Math.max(min, Math.floor(parsed))) : fallback;
}

function iso(value) {
  const parsed = Date.parse(String(value || ""));
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : undefined;
}

function nowMs(value) {
  return Number.isFinite(value) ? value : Date.now();
}

function isoNow(value) {
  return new Date(nowMs(value)).toISOString();
}

function accountId(value) {
  const id = text(value);
  if (!ACCOUNT_ID.test(id)) throw new Error("accountId must be an opaque acct_ identifier.");
  return id;
}

function sessionId(value) {
  if (value === undefined || value === null || value === "") return undefined;
  const id = text(value);
  if (!id || id.length > SESSION_ID_LIMIT || /[\u0000-\u001f\u007f]/.test(id)) {
    throw new Error(`sessionId must be a non-empty string of at most ${SESSION_ID_LIMIT} characters.`);
  }
  return id;
}

function normalizePolicy(raw = {}) {
  const source = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const strategy = CHATGPT_ACCOUNT_POOL_STRATEGIES.includes(source.strategy)
    ? source.strategy
    : DEFAULT_POLICY.strategy;
  const threshold = number(source.autoSwitchThreshold);
  const priorityOrder = Array.isArray(source.priorityOrder)
    ? [...new Set(source.priorityOrder.map((value) => text(value)).filter((value) => ACCOUNT_ID.test(value)))].slice(0, MAX_ACCOUNTS)
    : [];
  const pausedAccountIds = Array.isArray(source.pausedAccountIds)
    ? [...new Set(source.pausedAccountIds.map((value) => text(value)).filter((value) => ACCOUNT_ID.test(value)))].slice(0, MAX_ACCOUNTS)
    : [];
  return {
    enabled: source.enabled === true,
    strategy,
    autoSwitchThreshold: Number.isFinite(threshold) ? Math.min(1, Math.max(0, threshold)) : DEFAULT_POLICY.autoSwitchThreshold,
    sticky: source.sticky !== false,
    stickyLimit: integer(source.stickyLimit, DEFAULT_POLICY.stickyLimit, { min: 1, max: MAX_SESSIONS }),
    maxCooldownSeconds: integer(source.maxCooldownSeconds, DEFAULT_POLICY.maxCooldownSeconds, { min: 0, max: MAX_COOLDOWN_SECONDS }),
    priorityOrder,
    pausedAccountIds,
  };
}

function normalizeQuotaWindow(raw, now) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const limit = number(raw.limit);
  const remaining = number(raw.remaining);
  if (!Number.isFinite(limit) || limit <= 0 || !Number.isFinite(remaining)) return undefined;
  const resetAt = iso(raw.resetAt);
  // Expired windows are ignored rather than treated as exhausted. The next
  // official quota snapshot can then repopulate the window after a reset.
  if (resetAt && Date.parse(resetAt) <= nowMs(now)) return undefined;
  return {
    ...(text(raw.name) ? { name: text(raw.name).slice(0, 80) } : {}),
    limit,
    remaining: Math.max(0, Math.min(limit, remaining)),
    ...(resetAt ? { resetAt } : {}),
    ...(iso(raw.observedAt) ? { observedAt: iso(raw.observedAt) } : {}),
  };
}

function normalizeHealth(raw, now) {
  const source = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const state = CHATGPT_ACCOUNT_POOL_HEALTH_STATES.includes(source.state)
    ? source.state
    : "healthy";
  const cooldownUntil = iso(source.cooldownUntil);
  const result = {
    state,
    ...(cooldownUntil && Date.parse(cooldownUntil) > nowMs(now) ? { cooldownUntil } : {}),
    ...(iso(source.lastSuccessAt) ? { lastSuccessAt: iso(source.lastSuccessAt) } : {}),
    ...(iso(source.lastErrorAt) ? { lastErrorAt: iso(source.lastErrorAt) } : {}),
    ...(iso(source.lastUsedAt) ? { lastUsedAt: iso(source.lastUsedAt) } : {}),
    ...(number(source.lastStatus) !== undefined ? { lastStatus: integer(source.lastStatus, 500, { min: 100, max: 999 }) } : {}),
    ...(text(source.lastError) ? { lastError: text(source.lastError).slice(0, MAX_ERROR_LENGTH) } : {}),
    ...(integer(source.failureCount, 0) ? { failureCount: integer(source.failureCount, 0) } : {}),
  };
  if (!result.cooldownUntil && result.state === "cooldown") result.state = "healthy";
  return result;
}

function normalizeAccount(raw, id, now) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const state = ["active", "paused", "revoked"].includes(raw.state) ? raw.state : "active";
  const windows = Array.isArray(raw.quota?.windows)
    ? raw.quota.windows.map((window) => normalizeQuotaWindow(window, now)).filter(Boolean).slice(0, MAX_WINDOWS)
    : [];
  return {
    id,
    state,
    paused: raw.paused === true,
    priority: integer(raw.priority, 50, { min: 0, max: 100_000 }),
    ...(windows.length ? { quota: { windows } } : {}),
    health: normalizeHealth(raw.health, now),
    turns: integer(raw.turns, 0),
    requests: integer(raw.requests, 0),
  };
}

function emptyState() {
  return {
    version: CHATGPT_ACCOUNT_POOL_SCHEMA_VERSION,
    policy: normalizePolicy(),
    roundRobinCursor: 0,
    accounts: {},
    sessions: {},
  };
}

function normalizeState(raw, now = Date.now()) {
  const result = emptyState();
  if (!raw || typeof raw !== "object" || Array.isArray(raw) || raw.version !== CHATGPT_ACCOUNT_POOL_SCHEMA_VERSION) return result;
  result.policy = normalizePolicy(raw.policy);
  result.roundRobinCursor = integer(raw.roundRobinCursor, 0);
  for (const [id, value] of Object.entries(raw.accounts || {}).slice(0, MAX_ACCOUNTS)) {
    if (!ACCOUNT_ID.test(id)) continue;
    const normalized = normalizeAccount(value, id, now);
    if (normalized) result.accounts[id] = normalized;
  }
  const sessionEntries = Object.entries(raw.sessions || {});
  for (const [id, value] of sessionEntries) {
    try {
      const normalizedSession = sessionId(id);
      const bound = accountId(value?.accountId);
      if (normalizedSession) {
        result.sessions[normalizedSession] = {
          accountId: bound,
          turns: integer(value?.turns, 0),
          requests: integer(value?.requests, 0),
          boundAt: iso(value?.boundAt) || isoNow(now),
          updatedAt: iso(value?.updatedAt) || isoNow(now),
          ...(iso(value?.reboundAt) ? { reboundAt: iso(value.reboundAt) } : {}),
          ...(text(value?.lastReason) ? { lastReason: text(value.lastReason).slice(0, 120) } : {}),
        };
      }
    } catch {
      // Invalid session state is discarded; it must never influence routing.
    }
  }
  // Keep the most recently updated bindings when a hand-edited file exceeds
  // the cap. This is advisory state; dropping an old affinity is safe.
  const sessions = Object.entries(result.sessions)
    .sort((left, right) => Date.parse(left[1].updatedAt) - Date.parse(right[1].updatedAt));
  for (const [id] of sessions.slice(0, Math.max(0, sessions.length - MAX_SESSIONS))) delete result.sessions[id];
  return result;
}

export function readChatGPTAccountPoolState(filePath = CHATGPT_ACCOUNT_POOL_PATH, { now = Date.now() } = {}) {
  if (!existsSync(filePath)) return emptyState();
  try {
    return normalizeState(JSON.parse(readFileSync(filePath, "utf8")), now);
  } catch {
    return emptyState();
  }
}

export function writeChatGPTAccountPoolState(state, filePath = CHATGPT_ACCOUNT_POOL_PATH) {
  const normalized = normalizeState({ ...state, version: CHATGPT_ACCOUNT_POOL_SCHEMA_VERSION });
  writePrivateJson(filePath, normalized, { directoryMode: 0o700 });
  return normalized;
}

function quotaRatio(account) {
  const windows = account?.quota?.windows || [];
  if (!windows.length) return undefined;
  const ratios = windows.map((window) => window.remaining / window.limit).filter(Number.isFinite);
  return ratios.length ? Math.min(...ratios) : undefined;
}

function cooldownActive(account, now) {
  const until = Date.parse(account?.health?.cooldownUntil || "");
  return Number.isFinite(until) && until > nowMs(now);
}

function eligibleAccounts(state, references, now) {
  const accounts = Array.isArray(references) ? references : [];
  const seen = new Set();
  const result = [];
  for (const reference of accounts) {
    const id = text(reference?.id);
    if (!ACCOUNT_ID.test(id) || seen.has(id)) continue;
    seen.add(id);
    const existing = state.accounts[id];
    const account = normalizeAccount({ ...(existing || {}), ...reference, id }, id, now);
    state.accounts[id] = account;
    if (account.state !== "active" || account.paused || state.policy.pausedAccountIds.includes(id)) continue;
    if (account.health.state === "reauth-required" || account.health.state === "failed" || cooldownActive(account, now)) continue;
    if ((quotaRatio(account) ?? 1) <= 0) continue;
    result.push(account);
  }
  return result;
}

function ordered(state, accounts) {
  return [...accounts].sort((left, right) => {
    const leftIndex = state.policy.priorityOrder.indexOf(left.id);
    const rightIndex = state.policy.priorityOrder.indexOf(right.id);
    const leftRank = leftIndex === -1 ? Number.MAX_SAFE_INTEGER : leftIndex;
    const rightRank = rightIndex === -1 ? Number.MAX_SAFE_INTEGER : rightIndex;
    if (leftRank !== rightRank) return leftRank - rightRank;
    if (left.priority !== right.priority) return right.priority - left.priority;
    return left.id.localeCompare(right.id);
  });
}

function passesThreshold(account, policy) {
  const ratio = quotaRatio(account);
  return ratio === undefined || ratio > policy.autoSwitchThreshold;
}

function choose(state, accounts) {
  const sorted = ordered(state, accounts);
  if (!sorted.length) return undefined;
  if (state.policy.strategy === "round-robin") {
    const selected = sorted[state.roundRobinCursor % sorted.length];
    state.roundRobinCursor = (state.roundRobinCursor + 1) % sorted.length;
    return selected;
  }
  if (state.policy.strategy === "fill-first") return sorted.find((account) => passesThreshold(account, state.policy)) || sorted[0];
  const above = sorted.filter((account) => passesThreshold(account, state.policy));
  const pool = above.length ? above : sorted;
  return [...pool].sort((left, right) => {
    const leftRatio = quotaRatio(left);
    const rightRatio = quotaRatio(right);
    if (leftRatio === undefined && rightRatio !== undefined) return 1;
    if (leftRatio !== undefined && rightRatio === undefined) return -1;
    if (leftRatio !== rightRatio) return (rightRatio ?? -1) - (leftRatio ?? -1);
    return ordered(state, [left, right]).indexOf(left) - ordered(state, [left, right]).indexOf(right);
  })[0];
}

function sessionCanStay(state, session, account, now) {
  return Boolean(
    state.policy.sticky &&
    session &&
    account &&
    session.turns < state.policy.stickyLimit &&
    account.state === "active" &&
    !account.paused &&
    !state.policy.pausedAccountIds.includes(account.id) &&
    account.health.state === "healthy" &&
    !cooldownActive(account, now),
  );
}

function sessionRecord(state, id, selected, now, { rebound = false, reason } = {}) {
  const previous = state.sessions[id];
  const record = {
    accountId: selected.id,
    turns: rebound ? 1 : (previous?.turns || 0) + 1,
    requests: rebound ? 1 : (previous?.requests || 0) + 1,
    boundAt: rebound && previous ? previous.boundAt : previous?.boundAt || isoNow(now),
    updatedAt: isoNow(now),
    ...(rebound && previous ? { reboundAt: isoNow(now) } : {}),
    ...(reason ? { lastReason: text(reason).slice(0, 120) } : {}),
  };
  state.sessions[id] = record;
  return record;
}

export function selectChatGPTAccount(
  references,
  {
    sessionId: sessionValue,
    filePath = CHATGPT_ACCOUNT_POOL_PATH,
    state,
    policy,
    now = Date.now(),
    commit = true,
    rebindReason,
  } = {},
) {
  const session = sessionId(sessionValue);
  const at = nowMs(now);
  const working = state || readChatGPTAccountPoolState(filePath, { now: at });
  if (policy) working.policy = normalizePolicy({ ...working.policy, ...policy });
  if (!working.policy.enabled) return { enabled: false, accountId: null, reason: "disabled" };
  const candidates = eligibleAccounts(working, references, at);
  if (!candidates.length) return { enabled: true, accountId: null, reason: "no_eligible_accounts", candidates: [] };

  let selected;
  let rebound = false;
  if (session) {
    const bound = working.sessions[session];
    const boundAccount = bound ? candidates.find((candidate) => candidate.id === bound.accountId) : undefined;
    if (sessionCanStay(working, bound, boundAccount, at)) selected = boundAccount;
    else {
      selected = choose(working, candidates);
      rebound = Boolean(bound && selected && selected.id !== bound.accountId);
    }
  } else selected = choose(working, candidates);
  if (!selected) return { enabled: true, accountId: null, reason: "no_eligible_accounts", candidates: candidates.map(sanitizeChatGPTAccount) };

  selected.health.lastUsedAt = isoNow(at);
  selected.turns += 1;
  selected.requests += 1;
  const binding = session ? sessionRecord(working, session, selected, at, { rebound, reason: rebound ? rebindReason || "account_unavailable" : undefined }) : undefined;
  if (commit && !state) writeChatGPTAccountPoolState(working, filePath);
  return {
    enabled: true,
    accountId: selected.id,
    reason: rebound ? "rebound" : binding ? "sticky" : "selected",
    ...(binding ? { session: { ...binding } } : {}),
    account: sanitizeChatGPTAccount(selected),
  };
}

function cooldownSeconds(state, status, retryAfterSeconds) {
  const retry = number(retryAfterSeconds);
  if (Number.isFinite(retry) && retry > 0) return Math.min(state.policy.maxCooldownSeconds, retry);
  if (status === 429) return Math.min(state.policy.maxCooldownSeconds, 60);
  if (status >= 500 && status <= 599) return Math.min(state.policy.maxCooldownSeconds, 30);
  return 0;
}

export function recordChatGPTAccountOutcome(
  accountValue,
  outcome = {},
  filePath = CHATGPT_ACCOUNT_POOL_PATH,
) {
  const id = accountId(accountValue);
  const at = nowMs(outcome.now);
  const state = readChatGPTAccountPoolState(filePath, { now: at });
  const account = state.accounts[id] || normalizeAccount({ id }, id, at);
  state.accounts[id] = account;
  const status = integer(outcome.status, undefined, { min: 100, max: 999 });
  const committed = outcome.committed === true;
  account.requests += 1;
  account.health.lastStatus = status;
  account.health.lastUsedAt = isoNow(at);
  if (status === 401 || status === 403) {
    if (!committed) account.health.state = "reauth-required";
  } else if (outcome.ok === false || (status !== undefined && status >= 400)) {
    const seconds = cooldownSeconds(state, status, outcome.retryAfterSeconds);
    if (!committed && seconds > 0) {
      account.health.state = "cooldown";
      account.health.cooldownUntil = new Date(at + seconds * 1_000).toISOString();
    } else if (!committed) {
      account.health.state = "failed";
    }
    account.health.lastErrorAt = isoNow(at);
    account.health.failureCount = (account.health.failureCount || 0) + 1;
  } else {
    account.health.state = "healthy";
    account.health.lastSuccessAt = isoNow(at);
    account.health.failureCount = 0;
    delete account.health.cooldownUntil;
  }
  if (text(outcome.error || outcome.message)) account.health.lastError = text(outcome.error || outcome.message).slice(0, MAX_ERROR_LENGTH);
  writeChatGPTAccountPoolState(state, filePath);
  return {
    account: sanitizeChatGPTAccount(account),
    reauthRequired: account.health.state === "reauth-required",
    rebindRecommended: !committed && ([401, 403, 429].includes(status) || account.health.state === "cooldown"),
  };
}

export function sanitizeChatGPTAccount(account) {
  if (!account) return null;
  return {
    id: account.id,
    state: account.state,
    paused: account.paused === true,
    priority: account.priority,
    ...(account.quota ? { quota: { windows: account.quota.windows.map((window) => ({ ...window })) } } : {}),
    health: { ...account.health },
    turns: account.turns,
    requests: account.requests,
  };
}

export function sanitizeChatGPTAccountPool(state) {
  const normalized = normalizeState(state);
  return {
    version: CHATGPT_ACCOUNT_POOL_SCHEMA_VERSION,
    policy: { ...normalized.policy },
    roundRobinCursor: normalized.roundRobinCursor,
    accounts: Object.fromEntries(Object.entries(normalized.accounts).map(([id, account]) => [id, sanitizeChatGPTAccount(account)])),
    sessions: Object.fromEntries(Object.entries(normalized.sessions).map(([id, session]) => [id, { ...session }])),
  };
}

/**
 * Remove one session affinity without touching the native ChatGPT login.
 * The binding is only a routing hint, so a missing session is not an error.
 */
export function releaseChatGPTAccountSession(sessionValue, filePath = CHATGPT_ACCOUNT_POOL_PATH) {
  const id = sessionId(sessionValue);
  if (!id) return false;
  const state = readChatGPTAccountPoolState(filePath);
  if (!(id in state.sessions)) return false;
  delete state.sessions[id];
  writeChatGPTAccountPoolState(state, filePath);
  return true;
}

/**
 * Serialize selection/outcome state changes across router processes. The lock
 * file contains no credentials; the native Codex login remains out of scope.
 */
export async function withChatGPTAccountPoolLock(
  operation,
  { filePath = CHATGPT_ACCOUNT_POOL_PATH, waitMs = 120_000, retryMs = 25, staleMs = 10 * 60_000 } = {},
) {
  const lockTarget = `${filePath}.pool-lock`;
  const lockPath = `${lockTarget}.lock`;
  const retries = Math.max(0, Math.ceil(waitMs / retryMs) - 1);
  mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  let release;
  try {
    release = await lockfile.lock(lockTarget, {
      realpath: false,
      lockfilePath: lockPath,
      stale: Math.max(2_000, staleMs),
      retries: {
        retries,
        factor: 1,
        minTimeout: retryMs,
        maxTimeout: retryMs,
        randomize: false,
      },
    });
    return await operation();
  } finally {
    if (release) await release().catch(() => {});
  }
}
