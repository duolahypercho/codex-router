import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { execFile } from "node:child_process";
import path from "node:path";
import { randomBytes } from "node:crypto";

import lockfile from "proper-lockfile";

import { writePrivateJson } from "./file-security.mjs";
import { CHATGPT_ACCOUNT_HOMES_DIR, CHATGPT_ACCOUNT_POOL_PATH } from "./paths.mjs";
import { findCodexBinary } from "./codex-binary.mjs";
import { spawnableCommand } from "./spawnable-command.mjs";

// Subscription-account routing for the first-party Codex/ChatGPT surface.
// OAuth files remain owned by isolated Codex homes created for each account;
// this module reads a usable access token only in memory for the single native
// request that selected that profile and never copies it into pool metadata.
export const CHATGPT_ACCOUNT_POOL_SCHEMA_VERSION = 1;
export const CHATGPT_ACCOUNT_POOL_STRATEGIES = Object.freeze([
  "quota",
  "round-robin",
  "fill-first",
]);
export const CHATGPT_ACCOUNT_POOL_MODES = Object.freeze(["switch", "pool"]);
export const CHATGPT_ACCOUNT_POOL_HEALTH_STATES = Object.freeze([
  "healthy",
  "cooldown",
  "reauth-required",
  "failed",
]);

const ACCOUNT_ID = /^acct_[A-Za-z0-9_-]{8,80}$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const SESSION_ID_LIMIT = 256;
const MAX_ACCOUNTS = 64;
const MAX_SESSIONS = 2_048;
const MAX_WINDOWS = 16;
const MAX_ERROR_LENGTH = 512;
const MAX_COOLDOWN_SECONDS = 24 * 60 * 60;
const runtimeStates = new Map();
const refreshAttempts = new Map();

const DEFAULT_POLICY = Object.freeze({
  // Pooling is opt-in. A missing/disabled policy is an explicit signal to
  // leave the native single-account path alone.
  enabled: false,
  mode: "switch",
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

export function isChatGPTAccountId(value) {
  return typeof value === "string" && ACCOUNT_ID.test(value.trim());
}

function newAccountId(state) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const id = `acct_${randomBytes(12).toString("base64url")}`;
    if (!state.accounts[id]) return id;
  }
  throw new Error("Could not allocate a unique ChatGPT account id.");
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
    mode: source.mode === "pool" ? "pool" : DEFAULT_POLICY.mode,
    strategy,
    autoSwitchThreshold: Number.isFinite(threshold) ? Math.min(1, Math.max(0, threshold)) : DEFAULT_POLICY.autoSwitchThreshold,
    sticky: source.sticky !== false,
    stickyLimit: integer(source.stickyLimit, DEFAULT_POLICY.stickyLimit, { min: 1, max: MAX_SESSIONS }),
    maxCooldownSeconds: integer(source.maxCooldownSeconds, DEFAULT_POLICY.maxCooldownSeconds, { min: 0, max: MAX_COOLDOWN_SECONDS }),
    priorityOrder,
    pausedAccountIds,
    ...(ACCOUNT_ID.test(text(source.selectedAccountId)) ? { selectedAccountId: text(source.selectedAccountId) } : {}),
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
    ...(text(raw.label) ? { label: text(raw.label).slice(0, 120) } : {}),
    ...(iso(raw.createdAt) ? { createdAt: iso(raw.createdAt) } : {}),
    ...(raw.subscription && typeof raw.subscription === "object" && !Array.isArray(raw.subscription)
      ? {
          subscription: {
            status: ["pending", "usable", "expired", "invalid"].includes(raw.subscription.status)
              ? raw.subscription.status
              : "pending",
            ...(iso(raw.subscription.lastCheckedAt)
              ? { lastCheckedAt: iso(raw.subscription.lastCheckedAt) }
              : {}),
          },
        }
      : {}),
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

function pruneRevokedAccounts(state) {
  const revokedIds = new Set(
    Object.entries(state.accounts)
      .filter(([, account]) => account?.state === "revoked")
      .map(([id]) => id),
  );
  if (!revokedIds.size) return state;
  for (const id of revokedIds) delete state.accounts[id];
  state.policy.pausedAccountIds = state.policy.pausedAccountIds.filter((id) => !revokedIds.has(id));
  state.policy.priorityOrder = state.policy.priorityOrder.filter((id) => !revokedIds.has(id));
  if (revokedIds.has(state.policy.selectedAccountId)) delete state.policy.selectedAccountId;
  for (const [sessionIdValue, session] of Object.entries(state.sessions)) {
    if (revokedIds.has(session?.accountId)) delete state.sessions[sessionIdValue];
  }
  return state;
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
  runtimeStates.delete(filePath);
  return normalized;
}

/**
 * Create the metadata for a subscription account and its private Codex home.
 * The home is deliberately empty until the user runs the official
 * `codex login` command with that CODEX_HOME.  No token is accepted by this
 * function and no credential is written to the pool JSON.
 */
export function createChatGPTSubscriptionAccount(
  { label = "", filePath = CHATGPT_ACCOUNT_POOL_PATH, homesDir = CHATGPT_ACCOUNT_HOMES_DIR, now = Date.now() } = {},
) {
  const state = readChatGPTAccountPoolState(filePath, { now });
  // Older router versions kept removed accounts as revoked tombstones. Clean
  // those explicit removals before allocating a new automatic label so an
  // account removed twice cannot make the next account become "Account 3".
  pruneRevokedAccounts(state);
  if (Object.keys(state.accounts).length >= MAX_ACCOUNTS) {
    throw new Error(`The ChatGPT subscription pool supports at most ${MAX_ACCOUNTS} accounts.`);
  }
  const cleanLabel = text(label).slice(0, 120);
  const id = newAccountId(state);
  const home = path.join(homesDir, id);
  const accountNumber = Object.values(state.accounts).filter((account) => account?.state !== "revoked").length + 1;
  mkdirSync(home, { recursive: true, mode: 0o700 });
  chmodSync(home, 0o700);
  const account = normalizeAccount({
    id,
    state: "active",
    label: cleanLabel || `ChatGPT account ${accountNumber}`,
    createdAt: isoNow(now),
    subscription: { status: "pending" },
    health: { state: "healthy" },
  }, id, now);
  state.accounts[id] = account;
  try {
    writeChatGPTAccountPoolState(state, filePath);
  } catch (error) {
    rmSync(home, { recursive: true, force: true });
    throw error;
  }
  return sanitizeChatGPTAccount(account);
}

export function chatGPTSubscriptionAccountHome(
  accountValue,
  { homesDir = CHATGPT_ACCOUNT_HOMES_DIR } = {},
) {
  const id = accountId(accountValue);
  return path.join(homesDir, id);
}

export function chatGPTSubscriptionAccountAuthPath(accountValue, options = {}) {
  return path.join(chatGPTSubscriptionAccountHome(accountValue, options), "auth.json");
}

export function removeChatGPTSubscriptionAccount(
  accountValue,
  { filePath = CHATGPT_ACCOUNT_POOL_PATH, homesDir = CHATGPT_ACCOUNT_HOMES_DIR } = {},
) {
  const id = accountId(accountValue);
  const state = readChatGPTAccountPoolState(filePath);
  const removed = state.accounts[id];
  if (!removed) throw new Error("Account id is not registered.");
  // Remove means remove the pool entry, not leave a visible revoked account.
  // Older versions kept tombstones here, which made deleted rows come back in
  // Control Center and consumed the next automatic account label.
  delete state.accounts[id];
  state.policy.pausedAccountIds = state.policy.pausedAccountIds.filter((value) => value !== id);
  state.policy.priorityOrder = state.policy.priorityOrder.filter((value) => value !== id);
  if (state.policy.selectedAccountId === id) delete state.policy.selectedAccountId;
  for (const [sessionIdValue, session] of Object.entries(state.sessions)) {
    if (session?.accountId === id) delete state.sessions[sessionIdValue];
  }
  writeChatGPTAccountPoolState(state, filePath);
  // The profile is router-created and deterministic (`homesDir/<acct_id>`),
  // so removing an account can safely remove the whole isolated Codex home.
  // This is the only destructive path and is exposed only by the explicit
  // Remove action; it prevents a revoked subscription token lingering on disk.
  rmSync(chatGPTSubscriptionAccountHome(id, { homesDir }), { recursive: true, force: true });
  return sanitizeChatGPTAccount({ ...removed, state: "revoked", paused: true });
}

const EXPIRY_SKEW_MS = 120_000;

function tokenExpiryMs(accessToken) {
  try {
    const payload = String(accessToken).split(".")[1];
    if (!payload) return undefined;
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    return Number.isFinite(claims?.exp) ? claims.exp * 1000 : undefined;
  } catch {
    return undefined;
  }
}

function tokenEmail(idToken) {
  try {
    const payload = String(idToken || "").split(".")[1];
    if (!payload) return undefined;
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    const email = typeof claims?.email === "string" ? claims.email.trim() : "";
    return email.length <= 320 && EMAIL.test(email) ? email : undefined;
  } catch {
    return undefined;
  }
}

function readSubscriptionSession(accountValue, { homesDir = CHATGPT_ACCOUNT_HOMES_DIR, now = Date.now() } = {}) {
  const authPath = chatGPTSubscriptionAccountAuthPath(accountValue, { homesDir });
  if (!existsSync(authPath)) return undefined;
  try {
    const file = lstatSync(authPath);
    if (!file.isFile() || file.isSymbolicLink()) return undefined;
    if (process.platform !== "win32" && (file.mode & 0o077) !== 0) return undefined;
    const parsed = JSON.parse(readFileSync(authPath, "utf8"));
    const tokens = parsed?.tokens;
    const accessToken = typeof tokens?.access_token === "string" ? tokens.access_token : "";
    if (!accessToken || accessToken.length > 64 * 1024 || /[\u0000-\u001f\u007f]/.test(accessToken)) return undefined;
    const accountIdValue = typeof tokens?.account_id === "string" ? tokens.account_id : "";
    if (accountIdValue.length > 256 || /[\u0000-\u001f\u007f]/.test(accountIdValue)) return undefined;
    const expiresAtMs = tokenExpiryMs(accessToken);
    const expired = expiresAtMs !== undefined && expiresAtMs - EXPIRY_SKEW_MS <= now;
    const email = tokenEmail(tokens?.id_token);
    return { accessToken, accountId: accountIdValue, expiresAtMs, expired, ...(email ? { email } : {}) };
  } catch {
    return undefined;
  }
}

export function chatGPTSubscriptionAccountStatus(
  accountValue,
  { homesDir = CHATGPT_ACCOUNT_HOMES_DIR, now = Date.now() } = {},
) {
  const session = readSubscriptionSession(accountValue, { homesDir, now });
  return {
    authenticated: Boolean(session),
    usable: Boolean(session) && !session.expired,
    expired: Boolean(session?.expired),
    hasAccountId: Boolean(session?.accountId),
    ...(session?.email ? { email: session.email } : {}),
    expiresInHours: session?.expiresAtMs === undefined
      ? undefined
      : Math.round(((session.expiresAtMs - now) / 36e5) * 10) / 10,
  };
}

const ACCOUNT_REFRESH_MARGIN_MS = 24 * 60 * 60 * 1000;
const ACCOUNT_REFRESH_RETRY_MS = 5 * 60 * 1000;

export function refreshChatGPTSubscriptionAccount(
  accountValue,
  { homesDir = CHATGPT_ACCOUNT_HOMES_DIR, force = false, now = Date.now(), binary, execFileImpl = execFile } = {},
) {
  const id = accountId(accountValue);
  const status = chatGPTSubscriptionAccountStatus(id, { homesDir, now });
  const expiresSoon = status.expiresInHours !== undefined
    && status.expiresInHours * 36e5 <= ACCOUNT_REFRESH_MARGIN_MS;
  if (!force && !status.expired && !expiresSoon) return Promise.resolve(false);
  const attemptedAt = refreshAttempts.get(id) || 0;
  if (!force && now - attemptedAt < ACCOUNT_REFRESH_RETRY_MS) return Promise.resolve(false);
  const resolvedBinary = binary || findCodexBinary();
  if (!resolvedBinary) return Promise.resolve(false);
  const target = spawnableCommand(resolvedBinary, ["login", "status"]);
  const home = chatGPTSubscriptionAccountHome(id, { homesDir });
  refreshAttempts.set(id, now);
  return new Promise((resolve) => {
    execFileImpl(target.command, target.args, {
      ...target.options,
      env: { ...process.env, CODEX_HOME: home },
      encoding: "utf8",
      timeout: 30_000,
      maxBuffer: 256 * 1024,
      windowsHide: true,
    }, (error) => resolve(!error));
  });
}

function refreshAccountsInBackground(state, { homesDir = CHATGPT_ACCOUNT_HOMES_DIR, now = Date.now() } = {}) {
  for (const id of Object.keys(state.accounts || {})) {
    void refreshChatGPTSubscriptionAccount(id, { homesDir, now }).catch(() => false);
  }
}

export function chatGPTSubscriptionAccountPoolSnapshot(
  { filePath = CHATGPT_ACCOUNT_POOL_PATH, homesDir = CHATGPT_ACCOUNT_HOMES_DIR, now = Date.now() } = {},
) {
  const state = readChatGPTAccountPoolState(filePath, { now });
  const sanitized = sanitizeChatGPTAccountPool(state);
  for (const [id, account] of Object.entries(sanitized.accounts)) {
    const status = chatGPTSubscriptionAccountStatus(id, { homesDir, now });
    account.subscription = {
      ...(account.subscription || {}),
      status: status.usable ? "usable" : status.expired ? "expired" : status.authenticated ? "invalid" : "pending",
      ...status,
    };
  }
  return sanitized;
}

/**
 * Select a logged-in subscription account for a native Codex request. The
 * returned headers contain the token only in memory and are never persisted
 * or included in a dashboard snapshot.
 */
export function chatGPTSubscriptionPoolHeaders(
  { sessionId: sessionValue, filePath = CHATGPT_ACCOUNT_POOL_PATH, homesDir = CHATGPT_ACCOUNT_HOMES_DIR, now = Date.now() } = {},
) {
  // Selection is synchronous because it runs on the hot native request path.
  // Keep the affinity/cursor in this process rather than writing the pool JSON
  // for every turn; CLI/UI mutations replace the file and invalidate this
  // small cache through its mtime.
  let mtimeMs;
  try { mtimeMs = statSync(filePath).mtimeMs; } catch { mtimeMs = undefined; }
  const cached = runtimeStates.get(filePath);
  const state = cached && cached.mtimeMs === mtimeMs
    ? cached.state
    : readChatGPTAccountPoolState(filePath, { now });
  if (!cached || cached.mtimeMs !== mtimeMs) runtimeStates.set(filePath, { mtimeMs, state });
  if (!state.policy.enabled) return undefined;
  refreshAccountsInBackground(state, { homesDir, now });
  const references = Object.values(state.accounts)
    .map((account) => {
      const session = readSubscriptionSession(account.id, { homesDir, now });
      if (!session || session.expired) return undefined;
      return {
        ...account,
        subscription: { ...(account.subscription || {}), status: "usable" },
      };
    })
    .filter(Boolean);
  if (!references.length) return undefined;
  const selected = selectChatGPTAccount(references, {
    state,
    sessionId: sessionValue,
    now,
    commit: false,
  });
  if (!selected.accountId) return undefined;
  const session = readSubscriptionSession(selected.accountId, { homesDir, now });
  if (!session || session.expired) return undefined;
  return {
    authorization: `Bearer ${session.accessToken}`,
    ...(session.accountId ? { "chatgpt-account-id": session.accountId } : {}),
    accountId: selected.accountId,
  };
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
  let candidates = eligibleAccounts(working, references, at);
  if (!candidates.length) return { enabled: true, accountId: null, reason: "no_eligible_accounts", candidates: [] };
  if (working.policy.selectedAccountId && working.policy.mode !== "pool") {
    candidates = candidates.filter((candidate) => candidate.id === working.policy.selectedAccountId);
    if (!candidates.length) {
      return { enabled: true, accountId: null, reason: "selected_account_unavailable", candidates: [] };
    }
  }
  if (working.policy.mode === "pool" && working.policy.selectedAccountId && candidates.length > 1) {
    const alternates = candidates.filter((candidate) => candidate.id !== working.policy.selectedAccountId);
    if (alternates.length) candidates = alternates;
  }

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
    ...(account.label ? { label: account.label } : {}),
    ...(account.createdAt ? { createdAt: account.createdAt } : {}),
    ...(account.subscription ? { subscription: { ...account.subscription } } : {}),
    ...(account.quota ? { quota: { windows: account.quota.windows.map((window) => ({ ...window })) } } : {}),
    health: {
      ...account.health,
      ...(account.health?.lastError ? { lastError: "[redacted]" } : {}),
    },
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
