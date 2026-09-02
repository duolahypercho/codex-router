import { execFileSync, spawn } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync } from "node:fs";
import { randomBytes } from "node:crypto";
import path from "node:path";

import lockfile from "proper-lockfile";

import { privateFileIsProtected, protectPrivateFile, writePrivateJson } from "./file-security.mjs";
import { discoveryDisabled } from "./discovery-mode.mjs";
import { CHATGPT_ACCOUNT_HOMES_DIR, CHATGPT_ACCOUNT_POOL_PATH } from "./paths.mjs";
import { findCodexBinary } from "./codex-binary.mjs";
import { spawnableCommand } from "./spawnable-command.mjs";
import {
  attachChatGPTLoginLease,
  assertChatGPTLoginLeaseInactive,
  chatGPTLoginAuthChanged,
  chatGPTLoginLeaseStatus,
  clearChatGPTLoginLease,
  createChatGPTLoginLease,
} from "./chatgpt-login-lease.mjs";
import { ensureNoSymlinkParents } from "./path-security.mjs";

export const CHATGPT_ACCOUNT_POOL_SCHEMA_VERSION = 1;

const ACCOUNT_ID = /^acct_[A-Za-z0-9_-]{8,80}$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_ACCOUNTS = 64;
const MAX_ERROR_LENGTH = 512;
const EXPIRY_SKEW_MS = 120_000;
const ACCOUNT_REFRESH_MARGIN_MS = 24 * 60 * 60 * 1000;
export const ACCOUNT_REFRESH_RETRY_MS = 5 * 60 * 1000;
export const ACCOUNT_REFRESH_POLL_LIMIT = 8;
export const ACCOUNT_REFRESH_POLL_CONCURRENCY = 2;
const ACCOUNT_REFRESH_TIMEOUT_MS = 30_000;

function terminateRefreshProcessTree(child, {
  viaShell,
  platform,
  execFileSyncImpl,
} = {}) {
  if (viaShell && platform === "win32") {
    if (!Number.isInteger(child?.pid) || child.pid < 1) return false;
    try {
      const systemRoot = process.env.SystemRoot;
      const systemTaskkill = systemRoot ? path.join(systemRoot, "System32", "taskkill.exe") : undefined;
      const command = systemTaskkill && existsSync(systemTaskkill) ? systemTaskkill : "taskkill.exe";
      execFileSyncImpl(command, ["/PID", String(child.pid), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true,
        timeout: 5_000,
      });
      return true;
    } catch {
      // Killing only cmd.exe would orphan the Codex descendant whose auth
      // write the lease protects. Keep the wrapper and lease live instead.
      return false;
    }
  }
  try {
    return child?.kill?.() !== false;
  } catch {
    return false;
  }
}

function assertAccountDiscoveryEnabled() {
  if (discoveryDisabled()) {
    throw new Error(
      "ChatGPT account profiles are unavailable while credential discovery is disabled.",
    );
  }
}

function text(value) { return typeof value === "string" ? value.trim() : ""; }
function number(value) { const parsed = Number(value); return Number.isFinite(parsed) ? parsed : undefined; }
function integer(value, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const parsed = number(value);
  return Number.isFinite(parsed) ? Math.min(max, Math.max(min, Math.floor(parsed))) : fallback;
}
function iso(value) {
  const parsed = Date.parse(String(value || ""));
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : undefined;
}
function isoNow(now = Date.now()) { return new Date(Number.isFinite(now) ? now : Date.now()).toISOString(); }
function accountId(value) {
  const id = text(value);
  if (!ACCOUNT_ID.test(id)) throw new Error("accountId must be an opaque acct_ identifier.");
  return id;
}
export function isChatGPTAccountId(value) { return typeof value === "string" && ACCOUNT_ID.test(value.trim()); }

function normalizePolicy(raw = {}) {
  const source = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const selected = text(source.selectedAccountId);
  return { enabled: source.enabled !== false, mode: "switch", ...(ACCOUNT_ID.test(selected) ? { selectedAccountId: selected } : {}) };
}
function normalizeIdentity(raw) {
  const value = text(raw?.accountId);
  if (!value || value.length > 256 || /[\u0000-\u001f\u007f]/.test(value)) return undefined;
  return { accountId: value, ...(text(raw.email) ? { email: text(raw.email).slice(0, 320) } : {}) };
}
function normalizeHealth(raw) {
  const source = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const state = ["healthy", "cooldown", "reauth-required", "failed"].includes(source.state) ? source.state : "healthy";
  return {
    state,
    ...(iso(source.cooldownUntil) ? { cooldownUntil: iso(source.cooldownUntil) } : {}),
    ...(iso(source.lastSuccessAt) ? { lastSuccessAt: iso(source.lastSuccessAt) } : {}),
    ...(iso(source.lastErrorAt) ? { lastErrorAt: iso(source.lastErrorAt) } : {}),
    ...(iso(source.lastUsedAt) ? { lastUsedAt: iso(source.lastUsedAt) } : {}),
    ...(iso(source.lastRefreshAttemptAt) ? { lastRefreshAttemptAt: iso(source.lastRefreshAttemptAt) } : {}),
    ...(number(source.lastStatus) !== undefined ? { lastStatus: integer(source.lastStatus, 500, { min: 100, max: 999 }) } : {}),
    ...(text(source.lastError) ? { lastError: text(source.lastError).slice(0, MAX_ERROR_LENGTH) } : {}),
  };
}
function normalizeSubscription(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const status = ["pending", "usable", "expired", "invalid"].includes(raw.status) ? raw.status : "pending";
  return {
    status,
    ...(typeof raw.authenticated === "boolean" ? { authenticated: raw.authenticated } : {}),
    ...(typeof raw.usable === "boolean" ? { usable: raw.usable } : {}),
    ...(typeof raw.expired === "boolean" ? { expired: raw.expired } : {}),
    ...(typeof raw.hasAccountId === "boolean" ? { hasAccountId: raw.hasAccountId } : {}),
    ...(number(raw.expiresInHours) !== undefined ? { expiresInHours: number(raw.expiresInHours) } : {}),
    ...(text(raw.email) ? { email: text(raw.email).slice(0, 320) } : {}),
    ...(raw.usage && typeof raw.usage === "object" ? { usage: { ...raw.usage } } : {}),
  };
}
function normalizeAccount(raw, id) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const state = ["active", "paused", "revoked"].includes(raw.state) ? raw.state : "active";
  const identity = normalizeIdentity(raw.identity);
  const subscription = normalizeSubscription(raw.subscription);
  return {
    id,
    state,
    paused: raw.paused === true,
    priority: integer(raw.priority, 50, { min: 0, max: 100_000 }),
    ...(text(raw.label) ? { label: text(raw.label).slice(0, 120) } : {}),
    ...(iso(raw.createdAt) ? { createdAt: iso(raw.createdAt) } : {}),
    ...(identity ? { identity } : {}),
    ...(subscription ? { subscription } : {}),
    health: normalizeHealth(raw.health),
    turns: integer(raw.turns, 0),
    requests: integer(raw.requests, 0),
  };
}
function emptyState() { return { version: CHATGPT_ACCOUNT_POOL_SCHEMA_VERSION, policy: normalizePolicy(), accounts: {}, sessions: {} }; }
function plainObject(value) { return Boolean(value) && typeof value === "object" && !Array.isArray(value); }

function invalidPoolState(reason) {
  throw new Error(`The saved ChatGPT account list is invalid: ${reason}.`);
}

function validatePersistedState(raw) {
  if (!plainObject(raw)) invalidPoolState("the document root must be an object");
  if (raw.version !== CHATGPT_ACCOUNT_POOL_SCHEMA_VERSION) {
    invalidPoolState(`unsupported schema version ${String(raw.version)}`);
  }
  if (!plainObject(raw.policy)) invalidPoolState("policy must be an object");
  if (typeof raw.policy.enabled !== "boolean" || raw.policy.mode !== "switch") {
    invalidPoolState("policy is malformed");
  }
  if (
    raw.policy.selectedAccountId !== undefined
    && !isChatGPTAccountId(raw.policy.selectedAccountId)
  ) invalidPoolState("the selected account id is malformed");
  if (!plainObject(raw.accounts)) invalidPoolState("accounts must be an object");
  if (!plainObject(raw.sessions)) invalidPoolState("sessions must be an object");
  const entries = Object.entries(raw.accounts);
  if (entries.length > MAX_ACCOUNTS) invalidPoolState(`more than ${MAX_ACCOUNTS} accounts are present`);
  for (const [id, account] of entries) {
    if (!isChatGPTAccountId(id) || !plainObject(account) || account.id !== id) {
      invalidPoolState("an account record is malformed");
    }
    if (!["active", "paused", "revoked"].includes(account.state)) {
      invalidPoolState(`account ${id} has an invalid state`);
    }
    if (typeof account.paused !== "boolean" || !Number.isFinite(account.priority)) {
      invalidPoolState(`account ${id} has invalid routing metadata`);
    }
    if (!plainObject(account.health) || !["healthy", "cooldown", "reauth-required", "failed"].includes(account.health.state)) {
      invalidPoolState(`account ${id} has invalid health metadata`);
    }
    if (!Number.isFinite(account.turns) || !Number.isFinite(account.requests)) {
      invalidPoolState(`account ${id} has invalid counters`);
    }
    if (account.identity !== undefined && !normalizeIdentity(account.identity)) {
      invalidPoolState(`account ${id} has an invalid identity`);
    }
    if (account.subscription !== undefined && !plainObject(account.subscription)) {
      invalidPoolState(`account ${id} has invalid subscription metadata`);
    }
  }
  if (
    raw.policy.selectedAccountId !== undefined
    && !Object.hasOwn(raw.accounts, raw.policy.selectedAccountId)
  ) invalidPoolState("the selected account is not registered");
  return raw;
}

function normalizeState(raw) {
  const result = emptyState();
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return result;
  result.policy = normalizePolicy(raw.policy);
  for (const [id, value] of Object.entries(raw.accounts || {}).slice(0, MAX_ACCOUNTS)) {
    if (!ACCOUNT_ID.test(id)) continue;
    const account = normalizeAccount(value, id);
    if (account) result.accounts[id] = account;
  }
  return result;
}
export function readChatGPTAccountPoolState(filePath = CHATGPT_ACCOUNT_POOL_PATH) {
  assertAccountDiscoveryEnabled();
  let file;
  try {
    file = lstatSync(filePath);
  } catch (error) {
    if (error?.code === "ENOENT") return emptyState();
    throw new Error("The saved ChatGPT account list could not be inspected.", { cause: error });
  }
  if (file.isSymbolicLink() || !file.isFile()) {
    invalidPoolState("the state path is not a regular file");
  }
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(filePath, "utf8"));
  } catch (error) {
    throw new Error("The saved ChatGPT account list could not be read as JSON.", { cause: error });
  }
  return normalizeState(validatePersistedState(parsed));
}
export function writeChatGPTAccountPoolState(state, filePath = CHATGPT_ACCOUNT_POOL_PATH) {
  assertAccountDiscoveryEnabled();
  const normalized = normalizeState({ ...state, version: CHATGPT_ACCOUNT_POOL_SCHEMA_VERSION });
  writePrivateJson(filePath, normalized, { directoryMode: 0o700 });
  return normalized;
}

function newAccountId(state) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const id = `acct_${randomBytes(12).toString("base64url")}`;
    if (!state.accounts[id]) return id;
  }
  throw new Error("Could not allocate a unique ChatGPT account id.");
}

function ensurePrivateAccountDirectory(target, homesDir) {
  const root = path.resolve(homesDir);
  const absolute = path.resolve(target);
  const relative = path.relative(root, absolute);
  if (relative.startsWith(`..${path.sep}`) || relative === ".." || path.isAbsolute(relative)) {
    throw new Error("ChatGPT account profile escaped its private home directory.");
  }
  ensureNoSymlinkParents(path.dirname(root), { label: "ChatGPT account home parent" });
  if (existsSync(root)) {
    const rootStat = lstatSync(root);
    if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
      throw new Error("ChatGPT account home directory is not a private directory.");
    }
  } else {
    mkdirSync(root, { recursive: true, mode: 0o700 });
  }
  ensureNoSymlinkParents(root, { label: "ChatGPT account home" });
  mkdirSync(absolute, { recursive: true, mode: 0o700 });
  ensureNoSymlinkParents(absolute, { label: "ChatGPT account profile" });
  const accountStat = lstatSync(absolute);
  if (accountStat.isSymbolicLink() || !accountStat.isDirectory()) {
    throw new Error("ChatGPT account profile directory is not a private directory.");
  }
  chmodSync(root, 0o700);
  chmodSync(absolute, 0o700);
}

function nextAccountLabel(state) {
  const used = new Set(Object.values(state.accounts).filter((account) => account?.state !== "revoked").map((account) => {
    const match = /^ChatGPT account (\d+)$/.exec(account?.label || "");
    return match ? Number(match[1]) : undefined;
  }).filter(Number.isInteger));
  let numberValue = 1;
  while (used.has(numberValue)) numberValue += 1;
  return `ChatGPT account ${numberValue}`;
}
export function createChatGPTSubscriptionAccount({ label = "", filePath = CHATGPT_ACCOUNT_POOL_PATH, homesDir = CHATGPT_ACCOUNT_HOMES_DIR, now = Date.now() } = {}) {
  const state = readChatGPTAccountPoolState(filePath);
  if (Object.values(state.accounts).filter((account) => account?.state !== "revoked").length >= MAX_ACCOUNTS) throw new Error(`The ChatGPT account list supports at most ${MAX_ACCOUNTS} accounts.`);
  const id = newAccountId(state);
  const home = chatGPTSubscriptionAccountHome(id, { homesDir });
  ensurePrivateAccountDirectory(home, homesDir);
  const account = normalizeAccount({ id, state: "active", label: text(label).slice(0, 120) || nextAccountLabel(state), createdAt: isoNow(now), subscription: { status: "pending" }, health: { state: "healthy" } }, id);
  state.accounts[id] = account;
  try { writeChatGPTAccountPoolState(state, filePath); } catch (error) { rmSync(home, { recursive: true, force: true }); throw error; }
  return sanitizeChatGPTAccount(account);
}
export function chatGPTSubscriptionAccountHome(accountValue, { homesDir = CHATGPT_ACCOUNT_HOMES_DIR } = {}) { return path.join(homesDir, accountId(accountValue)); }
export function chatGPTSubscriptionAccountAuthPath(accountValue, options = {}) { return path.join(chatGPTSubscriptionAccountHome(accountValue, options), "auth.json"); }
export function chatGPTSubscriptionAccountCatalogDir(accountValue, options = {}) { return path.join(chatGPTSubscriptionAccountHome(accountValue, options), "router-catalog"); }
export function removeChatGPTSubscriptionAccount(accountValue, {
  filePath = CHATGPT_ACCOUNT_POOL_PATH,
  homesDir = CHATGPT_ACCOUNT_HOMES_DIR,
  selectedAccountId,
  loginLeaseIdentity,
  now = Date.now(),
  loginLeaseMaxAgeMs,
} = {}) {
  const id = accountId(accountValue);
  const state = readChatGPTAccountPoolState(filePath);
  const removed = state.accounts[id];
  if (!removed) throw new Error("Account id is not registered.");
  assertChatGPTLoginLeaseInactive(id, {
    homesDir,
    ...(loginLeaseIdentity ? { identity: loginLeaseIdentity } : {}),
    now,
    ...(loginLeaseMaxAgeMs === undefined ? {} : { maxAgeMs: loginLeaseMaxAgeMs }),
  });
  delete state.accounts[id];
  if (selectedAccountId !== undefined) {
    const selected = accountId(selectedAccountId);
    const account = state.accounts[selected];
    if (!account || account.state !== "active" || account.paused) {
      throw new Error("The replacement ChatGPT account is not active.");
    }
    state.policy.selectedAccountId = selected;
  } else if (state.policy.selectedAccountId === id) {
    delete state.policy.selectedAccountId;
  }
  const root = path.resolve(homesDir);
  const home = path.resolve(chatGPTSubscriptionAccountHome(id, { homesDir }));
  ensureNoSymlinkParents(root, { label: "ChatGPT account removal root" });
  ensureNoSymlinkParents(home, { label: "ChatGPT account removal target" });
  const rootStat = lstatSync(root);
  const homeStat = lstatSync(home);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw new Error("ChatGPT account removal root is not a private directory.");
  }
  if (homeStat.isSymbolicLink() || !homeStat.isDirectory()) {
    throw new Error("ChatGPT account removal target is not an owned directory.");
  }
  const realRoot = realpathSync(root);
  if (path.dirname(realpathSync(home)) !== realRoot) {
    throw new Error("ChatGPT account removal target escaped its private root.");
  }
  const tombstone = path.join(root, `.removed-${id}-${randomBytes(8).toString("hex")}`);
  // The account/publisher locks serialize router mutations, but an external
  // filesystem actor can still replace an ancestor. Revalidate the full chain
  // and realpath ownership at the destructive boundary immediately before the
  // atomic rename.
  ensureNoSymlinkParents(root, { label: "ChatGPT account removal root" });
  ensureNoSymlinkParents(home, { label: "ChatGPT account removal target" });
  if (realpathSync(root) !== realRoot || path.dirname(realpathSync(home)) !== realRoot) {
    throw new Error("ChatGPT account removal target changed during validation.");
  }
  renameSync(home, tombstone);
  let committed = false;
  try {
    const staged = lstatSync(tombstone);
    if (staged.isSymbolicLink() || !staged.isDirectory() || path.dirname(realpathSync(tombstone)) !== realRoot) {
      throw new Error("ChatGPT account removal staging target is not an owned directory.");
    }
    try {
      writeChatGPTAccountPoolState(state, filePath);
    } catch (error) {
      renameSync(tombstone, home);
      throw error;
    }
    committed = true;
  } catch (error) {
    if (existsSync(tombstone) && !existsSync(home)) {
      try { renameSync(tombstone, home); } catch (rollbackError) {
        throw new AggregateError([error, rollbackError], "ChatGPT account removal staging rollback failed.");
      }
    }
    throw error;
  }
  // Pool state is committed before deletion, but only the directory we just
  // atomically staged is eligible. If its identity changes, leave a private
  // tombstone for manual cleanup rather than following an attacker path.
  if (committed) {
    try {
      const cleanup = lstatSync(tombstone);
      if (!cleanup.isSymbolicLink() && cleanup.isDirectory() && path.dirname(realpathSync(tombstone)) === realRoot) {
        rmSync(tombstone, { recursive: true, force: true });
      }
    } catch {}
  }
  return sanitizeChatGPTAccount({ ...removed, state: "revoked", paused: true });
}

function tokenExpiryMs(accessToken) {
  try {
    const payload = String(accessToken).split(".")[1];
    if (!payload) return undefined;
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    return Number.isFinite(claims?.exp) ? claims.exp * 1000 : undefined;
  } catch { return undefined; }
}
function tokenEmail(idToken) {
  try {
    const payload = String(idToken || "").split(".")[1];
    if (!payload) return undefined;
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    const email = typeof claims?.email === "string" ? claims.email.trim() : "";
    return email.length <= 320 && EMAIL.test(email) ? email : undefined;
  } catch { return undefined; }
}
function readSubscriptionSession(accountValue, { homesDir = CHATGPT_ACCOUNT_HOMES_DIR, now = Date.now() } = {}) {
  const authPath = chatGPTSubscriptionAccountAuthPath(accountValue, { homesDir });
  if (!existsSync(authPath)) return undefined;
  try {
    const file = lstatSync(authPath);
    if (file.isSymbolicLink() || !file.isFile()) return undefined;
    if (!privateFileIsProtected(authPath)) return undefined;
    const parsed = JSON.parse(readFileSync(authPath, "utf8"));
    const tokens = parsed?.tokens;
    const accessToken = typeof tokens?.access_token === "string" ? tokens.access_token : "";
    if (!accessToken || accessToken.length > 64 * 1024 || /[\u0000-\u001f\u007f]/.test(accessToken)) return undefined;
    const accountIdValue = typeof tokens?.account_id === "string" ? tokens.account_id : "";
    const expiresAtMs = tokenExpiryMs(accessToken);
    const expired = expiresAtMs !== undefined && expiresAtMs - EXPIRY_SKEW_MS <= now;
    const email = tokenEmail(tokens?.id_token);
    return { accessToken, accountId: accountIdValue, expiresAtMs, expired, ...(email ? { email } : {}) };
  } catch { return undefined; }
}

export function hardenChatGPTSubscriptionAccountAuth(accountValue, {
  homesDir = CHATGPT_ACCOUNT_HOMES_DIR,
  protect = protectPrivateFile,
  isProtected = privateFileIsProtected,
} = {}) {
  const id = accountId(accountValue);
  const home = chatGPTSubscriptionAccountHome(id, { homesDir });
  const authPath = chatGPTSubscriptionAccountAuthPath(id, { homesDir });
  ensurePrivateAccountDirectory(home, homesDir);
  ensureNoSymlinkParents(home, { label: "ChatGPT account profile" });
  const before = lstatSync(authPath);
  if (before.isSymbolicLink() || !before.isFile()) {
    throw new Error("The ChatGPT account login profile is not a regular file.");
  }
  if (!isProtected(authPath)) protect(authPath);
  ensureNoSymlinkParents(home, { label: "ChatGPT account profile" });
  const after = lstatSync(authPath);
  if (after.isSymbolicLink() || !after.isFile() || !isProtected(authPath)) {
    throw new Error("The ChatGPT account login profile is not owner-only.");
  }
  if (!readSubscriptionSession(id, { homesDir })) {
    throw new Error("The ChatGPT account login profile is invalid after hardening.");
  }
  return authPath;
}
export function chatGPTSubscriptionAccountStatus(accountValue, { homesDir = CHATGPT_ACCOUNT_HOMES_DIR, now = Date.now() } = {}) {
  assertAccountDiscoveryEnabled();
  const session = readSubscriptionSession(accountValue, { homesDir, now });
  return {
    authenticated: Boolean(session), usable: Boolean(session) && !session.expired, expired: Boolean(session?.expired), hasAccountId: Boolean(session?.accountId),
    ...(session?.email ? { email: session.email } : {}),
    expiresInHours: session?.expiresAtMs === undefined ? undefined : Math.round(((session.expiresAtMs - now) / 36e5) * 10) / 10,
  };
}
export async function claimChatGPTSubscriptionRefresh(accountValue, {
  filePath = CHATGPT_ACCOUNT_POOL_PATH,
  force = false,
  now = Date.now(),
} = {}) {
  const id = accountId(accountValue);
  return withChatGPTAccountPoolLock(() => {
    const state = readChatGPTAccountPoolState(filePath);
    const account = state.accounts[id];
    if (!account || account.state !== "active" || account.paused) return false;
    const attemptedAt = Date.parse(account.health?.lastRefreshAttemptAt || "");
    if (!force && Number.isFinite(attemptedAt) && now - attemptedAt < ACCOUNT_REFRESH_RETRY_MS) return false;
    account.health = { ...account.health, lastRefreshAttemptAt: isoNow(now) };
    writeChatGPTAccountPoolState(state, filePath);
    return true;
  }, { filePath });
}

export async function refreshChatGPTSubscriptionAccount(accountValue, {
  filePath = CHATGPT_ACCOUNT_POOL_PATH,
  homesDir = CHATGPT_ACCOUNT_HOMES_DIR,
  force = false,
  now = Date.now(),
  binary,
  platform = process.platform,
  spawnImpl = spawn,
  execFileSyncImpl = execFileSync,
  refreshTimeoutMs = ACCOUNT_REFRESH_TIMEOUT_MS,
  terminationGraceMs = 2_000,
  createLoginLease = createChatGPTLoginLease,
  attachLoginLease = attachChatGPTLoginLease,
  clearLoginLease = clearChatGPTLoginLease,
  finalizeLogin,
} = {}) {
  assertAccountDiscoveryEnabled();
  const id = accountId(accountValue);
  const status = chatGPTSubscriptionAccountStatus(id, { homesDir, now });
  const expiresSoon = status.expiresInHours !== undefined && status.expiresInHours * 36e5 <= ACCOUNT_REFRESH_MARGIN_MS;
  if (!force && !status.expired && !expiresSoon) return false;
  const resolvedBinary = binary || findCodexBinary();
  if (!resolvedBinary) return false;
  if (!await claimChatGPTSubscriptionRefresh(id, { filePath, force, now })) return false;
  const target = spawnableCommand(resolvedBinary, ["login", "status"], platform);
  return new Promise((resolve) => {
    let lease;
    let child;
    let childFinished = false;
    let leaseReady = false;
    let attachmentFailed = false;
    let finalizationStarted = false;
    let settled = false;
    let timeout;
    let terminationDeadline;
    const settle = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const finish = async () => {
      if (!leaseReady || !childFinished || finalizationStarted) return;
      finalizationStarted = true;
      clearTimeout(timeout);
      clearTimeout(terminationDeadline);
      try {
        if (attachmentFailed && !chatGPTLoginAuthChanged(id, lease, { homesDir })) {
          clearLoginLease(id, lease, { homesDir });
          settle(false);
          return;
        }
        const finalize = finalizeLogin
          || (await import("./chatgpt-profile-switch.mjs")).finalizeChatGPTProfileLogin;
        await finalize(id, {
          filePath,
          homesDir,
          expectedLoginLease: lease,
          clearLoginLease,
        });
        settle(true);
      } catch {
        settle(false);
      }
    };
    try {
      lease = createLoginLease(id, process.pid, { homesDir, phase: "reserved" });
      child = spawnImpl(
        target.command,
        target.args,
        {
          ...target.options,
          env: { ...process.env, CODEX_HOME: chatGPTSubscriptionAccountHome(id, { homesDir }) },
          stdio: "ignore",
          windowsHide: true,
        },
      );
      const childDone = () => {
        if (childFinished) return;
        childFinished = true;
        void finish();
      };
      // Spawn errors are delivered on a later tick. Own that event before any
      // synchronous process-identity attachment can throw, or ENOENT becomes
      // an unhandled EventEmitter error after the reservation catch returns.
      child.once("error", childDone);
      child.once("close", childDone);
      lease = attachLoginLease(id, lease, child?.pid, { homesDir });
      leaseReady = true;
      void finish();
      timeout = setTimeout(() => {
        const terminated = terminateRefreshProcessTree(child, {
          viaShell: Boolean(target.options.windowsVerbatimArguments),
          platform,
          execFileSyncImpl,
        });
        if (!terminated) {
          child.unref?.();
          settle(false);
          return;
        }
        terminationDeadline = setTimeout(() => {
          if (childFinished) return;
          if (!(target.options.windowsVerbatimArguments && platform === "win32")) {
            try { child.kill?.("SIGKILL"); } catch {}
          }
          // Keep the exact lease. A late close will still finalize it, while
          // the caller is released from a child that ignored termination.
          child.unref?.();
          settle(false);
        }, terminationGraceMs);
      }, refreshTimeoutMs);
    } catch {
      if (child) {
        attachmentFailed = true;
        leaseReady = true;
        const terminated = terminateRefreshProcessTree(child, {
          viaShell: Boolean(target.options.windowsVerbatimArguments),
          platform,
          execFileSyncImpl,
        });
        if (terminated) {
          terminationDeadline = setTimeout(() => {
            if (childFinished) return;
            if (!(target.options.windowsVerbatimArguments && platform === "win32")) {
              try { child.kill?.("SIGKILL"); } catch {}
            }
            child.unref?.();
            settle(false);
          }, terminationGraceMs);
          void finish();
          return;
        }
        child.unref?.();
      }
      if (lease && !child) {
        try {
          if (!chatGPTLoginAuthChanged(id, lease, { homesDir })) {
            clearLoginLease(id, lease, { homesDir });
          }
        } catch {}
      }
      clearTimeout(timeout);
      clearTimeout(terminationDeadline);
      settle(false);
    }
  });
}
export async function refreshBoundedChatGPTSubscriptionAccounts(pool, {
  refresh = refreshChatGPTSubscriptionAccount,
  probeLimit = ACCOUNT_REFRESH_POLL_LIMIT,
  concurrency = ACCOUNT_REFRESH_POLL_CONCURRENCY,
} = {}) {
  if (!pool?.accounts || typeof refresh !== "function") return pool;
  const selectedId = pool.policy?.selectedAccountId;
  const candidates = Object.values(pool.accounts)
    .filter((account) => account?.subscription?.usable === true)
    .sort((left, right) => Number(right.id === selectedId) - Number(left.id === selectedId))
    .slice(0, Math.max(0, Math.floor(probeLimit)));
  let cursor = 0;
  const workerCount = Math.min(candidates.length, Math.max(1, Math.floor(concurrency)));
  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (cursor < candidates.length) {
      const account = candidates[cursor++];
      await refresh(account.id);
    }
  }));
  return pool;
}
export function chatGPTSubscriptionAccountPoolSnapshot({
  filePath = CHATGPT_ACCOUNT_POOL_PATH,
  homesDir = CHATGPT_ACCOUNT_HOMES_DIR,
  now = Date.now(),
  loginLeaseIdentity,
  loginLeaseMaxAgeMs,
} = {}) {
  assertAccountDiscoveryEnabled();
  const state = readChatGPTAccountPoolState(filePath);
  const sanitized = sanitizeChatGPTAccountPool(state);
  for (const [id, account] of Object.entries(sanitized.accounts)) {
    const loginLease = chatGPTLoginLeaseStatus(id, {
      homesDir,
      ...(loginLeaseIdentity ? { identity: loginLeaseIdentity } : {}),
      ...(loginLeaseMaxAgeMs === undefined ? {} : { maxAgeMs: loginLeaseMaxAgeMs }),
      now,
    });
    if (loginLease.active) {
      account.subscription = {
        ...(account.subscription || {}),
        status: "pending",
        authenticated: false,
        usable: false,
        expired: false,
        hasAccountId: false,
        loginInProgress: true,
        ...(loginLease.attentionRequired === true ? { attentionRequired: true } : {}),
      };
      continue;
    }
    const status = chatGPTSubscriptionAccountStatus(id, { homesDir, now });
    account.subscription = { ...(account.subscription || {}), status: status.usable ? "usable" : status.expired ? "expired" : status.authenticated ? "invalid" : "pending", ...status };
  }
  return sanitized;
}
export function sanitizeChatGPTAccount(account) {
  if (!account) return null;
  return {
    id: account.id, state: account.state, paused: account.paused === true, priority: account.priority,
    ...(account.label ? { label: account.label } : {}), ...(account.createdAt ? { createdAt: account.createdAt } : {}),
    ...(account.subscription ? { subscription: { ...account.subscription } } : {}),
    health: { ...account.health, ...(account.health?.lastError ? { lastError: "[redacted]" } : {}) }, turns: account.turns, requests: account.requests,
  };
}
export function sanitizeChatGPTAccountPool(state) {
  const normalized = normalizeState(state);
  return {
    version: CHATGPT_ACCOUNT_POOL_SCHEMA_VERSION, policy: { ...normalized.policy },
    accounts: Object.fromEntries(Object.entries(normalized.accounts).map(([id, account]) => [id, sanitizeChatGPTAccount(account)])), sessions: {},
  };
}
export async function withChatGPTAccountPoolLock(operation, { filePath = CHATGPT_ACCOUNT_POOL_PATH, waitMs = 120_000, retryMs = 25, staleMs = 10 * 60_000 } = {}) {
  assertAccountDiscoveryEnabled();
  const lockTarget = `${filePath}.pool-lock`;
  const lockPath = `${lockTarget}.lock`;
  const retries = Math.max(0, Math.ceil(waitMs / retryMs) - 1);
  mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  let release;
  try {
    release = await lockfile.lock(lockTarget, { realpath: false, lockfilePath: lockPath, stale: Math.max(2_000, staleMs), retries: { retries, factor: 1, minTimeout: retryMs, maxTimeout: retryMs, randomize: false } });
    return await operation();
  } finally { if (release) await release().catch(() => {}); }
}
