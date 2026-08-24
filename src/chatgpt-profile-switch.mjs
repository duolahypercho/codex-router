import { execFileSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

import { writePrivateJson } from "./file-security.mjs";
import {
  CHATGPT_ACCOUNT_HOMES_DIR,
  CHATGPT_ACCOUNT_POOL_PATH,
  CHATGPT_PROFILE_SWITCH_PATH,
  CODEX_HOME,
} from "./paths.mjs";
import {
  createChatGPTSubscriptionAccount,
  chatGPTSubscriptionAccountHome,
  chatGPTSubscriptionAccountAuthPath,
  chatGPTSubscriptionAccountStatus,
  isChatGPTAccountId,
  readChatGPTAccountPoolState,
  withChatGPTAccountPoolLock,
} from "./chatgpt-account-pool.mjs";

const VERSION = 1;
const LEGACY_PRIMARY = "primary";
const AUTO = "auto";

function normalizeSelection(value) {
  const selection = String(value || "").trim();
  if (selection === LEGACY_PRIMARY || selection === AUTO || isChatGPTAccountId(selection)) return selection;
  throw new Error("Account selection must be automatic or a registered account id.");
}

function defaultState() {
  return { version: VERSION, desired: undefined, active: undefined, pending: false, phase: "idle" };
}

export function readChatGPTProfileSwitchState(filePath = CHATGPT_PROFILE_SWITCH_PATH) {
  if (!existsSync(filePath)) return defaultState();
  try {
    const parsed = JSON.parse(readFileSync(filePath, "utf8"));
    const desired = parsed?.desired === AUTO || parsed?.desired === LEGACY_PRIMARY || isChatGPTAccountId(parsed?.desired)
      ? parsed.desired
      : undefined;
    const active = isChatGPTAccountId(parsed?.active) || parsed?.active === LEGACY_PRIMARY
      ? parsed.active
      : undefined;
    return {
      version: VERSION,
      desired,
      active,
      pending: parsed?.pending === true,
      phase: parsed?.phase === "backed-up" || parsed?.phase === "installed" ? parsed.phase : "idle",
    };
  } catch {
    return defaultState();
  }
}

function writeState(state, filePath) {
  const value = {
    version: VERSION,
    ...(state.desired ? { desired: state.desired } : {}),
    ...(state.active ? { active: state.active } : {}),
    pending: state.pending === true,
    phase: state.phase || "idle",
  };
  writePrivateJson(filePath, value, { directoryMode: 0o700 });
  return value;
}

function primaryAuthPath(primaryHome = CODEX_HOME) {
  return path.join(primaryHome, "auth.json");
}

function backupAuthPath(filePath = CHATGPT_PROFILE_SWITCH_PATH) {
  return path.join(path.dirname(filePath), "chatgpt-profile", "primary-auth.json");
}

function profileAuthPath(selection, { homesDir = CHATGPT_ACCOUNT_HOMES_DIR } = {}) {
  return chatGPTSubscriptionAccountAuthPath(selection, { homesDir });
}

function ensureAuthFile(filePath, label) {
  try {
    if (!statSync(filePath).isFile()) throw new Error();
    return filePath;
  } catch {
    throw new Error(`${label} login profile is unavailable.`);
  }
}

function atomicPrivateCopy(source, destination) {
  ensureAuthFile(source, "The selected");
  mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
  const temporary = `${destination}.tmp-${process.pid}-${Date.now()}`;
  try {
    copyFileSync(source, temporary);
    chmodSync(temporary, 0o600);
    renameSync(temporary, destination);
    chmodSync(destination, 0o600);
  } finally {
    rmSync(temporary, { force: true });
  }
}

function syncAuthProfile(source, destination) {
  ensureAuthFile(source, "The active");
  ensureAuthFile(destination, "The saved");
  const sourceMtime = statSync(source).mtimeMs;
  const destinationMtime = statSync(destination).mtimeMs;
  if (sourceMtime >= destinationMtime) atomicPrivateCopy(source, destination);
  else atomicPrivateCopy(destination, source);
}

function authIdentity(filePath) {
  if (!existsSync(filePath)) return undefined;
  try {
    const file = statSync(filePath);
    if (!file.isFile() || (process.platform !== "win32" && (file.mode & 0o077) !== 0)) return undefined;
    const parsed = JSON.parse(readFileSync(filePath, "utf8"));
    const tokens = parsed?.tokens;
    const accountId = typeof tokens?.account_id === "string" ? tokens.account_id.trim() : "";
    if (!accountId) return undefined;
    let email;
    try {
      const payload = JSON.parse(Buffer.from(String(tokens?.id_token || "").split(".")[1] || "", "base64url").toString("utf8"));
      email = typeof payload?.email === "string" ? payload.email.trim() : undefined;
    } catch {
      email = undefined;
    }
    return { accountId, ...(email ? { email } : {}) };
  } catch {
    return undefined;
  }
}

function accountForAuth(state, authPath, { homesDir = CHATGPT_ACCOUNT_HOMES_DIR } = {}) {
  const identity = authIdentity(authPath);
  if (!identity) return undefined;
  for (const id of Object.keys(state.accounts)) {
    const candidate = authIdentity(chatGPTSubscriptionAccountAuthPath(id, { homesDir }));
    if (candidate?.accountId === identity.accountId) return id;
  }
  return undefined;
}

function ensureProfileAccountLocked({
  filePath = CHATGPT_ACCOUNT_POOL_PATH,
  homesDir = CHATGPT_ACCOUNT_HOMES_DIR,
  primaryHome = CODEX_HOME,
  switchPath = CHATGPT_PROFILE_SWITCH_PATH,
} = {}) {
  let state = readChatGPTAccountPoolState(filePath);
  const sources = [
    primaryAuthPath(primaryHome),
    backupAuthPath(switchPath),
  ];
  let currentAccountId;
  for (const source of sources) {
    const identity = authIdentity(source);
    if (!identity) continue;
    let id = accountForAuth(state, source, { homesDir });
    if (!id) {
      const created = createChatGPTSubscriptionAccount({ filePath, homesDir, label: "" });
      id = created.id;
      atomicPrivateCopy(source, chatGPTSubscriptionAccountAuthPath(id, { homesDir }));
      state = readChatGPTAccountPoolState(filePath);
    }
    if (source === primaryAuthPath(primaryHome)) currentAccountId = id;
  }
  if (currentAccountId) {
    const profile = readChatGPTProfileSwitchState(switchPath);
    const desired = profile.desired === LEGACY_PRIMARY ? currentAccountId : profile.desired;
    const pending = Boolean(desired && desired !== currentAccountId && profile.pending);
    if (profile.active !== currentAccountId || profile.desired === LEGACY_PRIMARY) {
      writeState({ ...profile, active: currentAccountId, desired, pending }, switchPath);
    }
  }
  return {
    state: readChatGPTAccountPoolState(filePath),
    currentAccountId,
  };
}

export async function ensureChatGPTProfileAccounts(options = {}) {
  return withChatGPTAccountPoolLock(
    () => ensureProfileAccountLocked(options),
    { filePath: options.filePath || CHATGPT_ACCOUNT_POOL_PATH },
  );
}

export function codexDesktopRunning({ platform = process.platform, processList } = {}) {
  if (platform !== "darwin") return false;
  let listing = processList;
  if (listing === undefined) {
    try {
      listing = execFileSync("/bin/ps", ["-axo", "command="], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    } catch {
      return true;
    }
  }
  return String(listing).split(/\r?\n/).some((line) =>
    /\/((?:ChatGPT|Codex)\.app)\/Contents\/MacOS\/(?:ChatGPT|Codex)(?:\s|$)/.test(line),
  );
}

function validateSelection(selection, { filePath = CHATGPT_ACCOUNT_POOL_PATH, currentAccountId } = {}) {
  const normalized = normalizeSelection(selection);
  if (normalized === LEGACY_PRIMARY) return currentAccountId;
  if (normalized === AUTO) return normalized;
  const state = readChatGPTAccountPoolState(filePath);
  const account = state.accounts[normalized];
  if (!account || account.state !== "active" || account.paused) {
    throw new Error("The selected subscription account is not active.");
  }
  return normalized;
}

function restorePreviousProfile(active, { homesDir, primaryHome }) {
  const primary = primaryAuthPath(primaryHome);
  const current = profileAuthPath(active, { homesDir });
  if (existsSync(current)) atomicPrivateCopy(current, primary);
}

async function applyLocked(selection, options) {
  const {
    filePath = CHATGPT_ACCOUNT_POOL_PATH,
    homesDir = CHATGPT_ACCOUNT_HOMES_DIR,
    primaryHome = CODEX_HOME,
    switchPath = CHATGPT_PROFILE_SWITCH_PATH,
  } = options;
  const migration = ensureProfileAccountLocked({ filePath, homesDir, primaryHome, switchPath });
  const current = readChatGPTProfileSwitchState(switchPath);
  const active = current.active || migration.currentAccountId;
  const targetSelection = selection === LEGACY_PRIMARY ? migration.currentAccountId : selection;
  if (!active && targetSelection !== AUTO) throw new Error("No logged-in ChatGPT account is available.");
  if (codexDesktopRunning(options)) {
    const target = targetSelection === AUTO ? active : targetSelection;
    return writeState({ ...current, desired: target, active, pending: Boolean(target && target !== active), phase: "idle" }, switchPath);
  }
  const target = targetSelection === AUTO ? active : targetSelection;
  if (target === active) {
    return writeState({ ...current, desired: target, active, pending: false, phase: "idle" }, switchPath);
  }
  const primary = primaryAuthPath(primaryHome);
  const activeProfile = profileAuthPath(active, { homesDir });
  const targetProfile = profileAuthPath(target, { homesDir });
  ensureAuthFile(activeProfile, "The active");
  ensureAuthFile(targetProfile, "The selected");
  writeState({ ...current, desired: target, active, pending: true, phase: "preparing" }, switchPath);
  try {
    syncAuthProfile(primary, activeProfile);
    writeState({ ...current, desired: target, active, pending: true, phase: "backed-up" }, switchPath);
    atomicPrivateCopy(targetProfile, primary);
    writeState({ desired: target, active: target, pending: false, phase: "installed" }, switchPath);
    return writeState({ desired: target, active: target, pending: false, phase: "idle" }, switchPath);
  } catch (error) {
    try {
      restorePreviousProfile(active, { homesDir, primaryHome });
      writeState({ ...current, desired: target, active, pending: true, phase: "idle" }, switchPath);
    } catch {
      writeState({ ...current, desired: target, active, pending: true, phase: "backed-up" }, switchPath);
    }
    throw error;
  }
}

export async function requestChatGPTProfileSwitch(selection, options = {}) {
  return withChatGPTAccountPoolLock(
    () => {
      const migration = ensureProfileAccountLocked(options);
      const normalized = validateSelection(selection, { ...options, currentAccountId: migration.currentAccountId });
      return applyLocked(normalized, options);
    },
    { filePath: options.filePath || CHATGPT_ACCOUNT_POOL_PATH },
  );
}

export async function reconcileChatGPTProfileSwitch(options = {}) {
  const state = readChatGPTProfileSwitchState(options.switchPath || CHATGPT_PROFILE_SWITCH_PATH);
  if (!state.pending) return state;
  return requestChatGPTProfileSwitch(state.desired, options);
}

export function selectedChatGPTUsageProfile({
  filePath = CHATGPT_ACCOUNT_POOL_PATH,
  homesDir = CHATGPT_ACCOUNT_HOMES_DIR,
  primaryHome = CODEX_HOME,
  switchPath = CHATGPT_PROFILE_SWITCH_PATH,
} = {}) {
  const pool = readChatGPTAccountPoolState(filePath);
  const profile = readChatGPTProfileSwitchState(switchPath);
  const selection = pool.policy.selectedAccountId || profile.active;
  if (!selection || selection === AUTO || selection === LEGACY_PRIMARY) return { selection: selection || AUTO, home: undefined, pending: profile.pending };
  const account = pool.accounts[selection];
  if (!account || account.state !== "active") return { selection, home: undefined, pending: profile.pending };
  return {
    selection,
    home: path.dirname(chatGPTSubscriptionAccountAuthPath(selection, { homesDir })),
    email: chatGPTSubscriptionAccountStatus(selection, { homesDir }).email,
    pending: profile.pending && profile.desired === selection,
  };
}

export function chatGPTProfileSwitchSnapshot(options = {}) {
  const state = readChatGPTProfileSwitchState(options.switchPath || CHATGPT_PROFILE_SWITCH_PATH);
  return { ...state, running: codexDesktopRunning(options) };
}
