import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync as rawWriteFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

import {
  chatGPTSubscriptionAccountAuthPath,
  chatGPTSubscriptionAccountCatalogDir,
  createChatGPTSubscriptionAccount,
  readChatGPTAccountPoolState,
  withChatGPTAccountPoolLock,
  writeChatGPTAccountPoolState,
} from "../src/chatgpt-account-pool.mjs";
import {
  atomicPrivateCopy,
  codexDesktopRunning,
  chatGPTProfileSwitchSnapshot,
  ensureChatGPTProfileAccounts,
  finalizeChatGPTProfileLogin,
  readChatGPTProfileSwitchState,
  reconcileChatGPTProfileSwitch,
  reconcileChatGPTProfileSwitchIfReady,
  recoverCompletedChatGPTProfileLogins,
  discardCompletedChatGPTProfileLogin,
  removeChatGPTProfileAccount,
  requestChatGPTProfileSwitch,
  selectChatGPTProfileAccount,
} from "../src/chatgpt-profile-switch.mjs";
import { withCatalogPublicationLock } from "../src/catalog-publication-lock.mjs";
import { privateFileIsProtected, protectPrivateFile } from "../src/file-security.mjs";
import {
  CHATGPT_LOGIN_LEASE_MAX_AGE_MS,
  clearChatGPTLoginLease,
  createChatGPTLoginLease,
} from "../src/chatgpt-login-lease.mjs";

function writeFileSync(target, contents, options) {
  rawWriteFileSync(target, contents, options);
  if (options && typeof options === "object" && options.mode === 0o600) {
    protectPrivateFile(target);
  }
}

function runModuleChild(source) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", source], {
      cwd: path.resolve("."),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`child exited ${code ?? signal}: ${stderr.trim()}`));
    });
  });
}

test("settled account discovery leaves state bytes, mtimes, and absent files unchanged", async () => {
  const emptyRoot = mkdtempSync(path.join(os.tmpdir(), "codex-profile-empty-read-"));
  const emptyPoolPath = path.join(emptyRoot, "pool.json");
  const emptySwitchPath = path.join(emptyRoot, "switch.json");
  await ensureChatGPTProfileAccounts({
    filePath: emptyPoolPath,
    homesDir: path.join(emptyRoot, "accounts"),
    primaryHome: path.join(emptyRoot, "primary"),
    switchPath: emptySwitchPath,
  });
  assert.equal(existsSync(emptyPoolPath), false);
  assert.equal(existsSync(emptySwitchPath), false);

  const root = mkdtempSync(path.join(os.tmpdir(), "codex-profile-settled-read-state-"));
  const primaryHome = path.join(root, "primary");
  const homesDir = path.join(root, "accounts");
  const filePath = path.join(root, "pool.json");
  const switchPath = path.join(root, "switch.json");
  mkdirSync(primaryHome, { recursive: true });
  const account = createChatGPTSubscriptionAccount({ filePath, homesDir });
  const auth = JSON.stringify({ tokens: { access_token: "settled-token", account_id: "settled" } });
  writeFileSync(path.join(primaryHome, "auth.json"), auth, { mode: 0o600 });
  writeFileSync(chatGPTSubscriptionAccountAuthPath(account.id, { homesDir }), auth, { mode: 0o600 });
  const pool = readChatGPTAccountPoolState(filePath);
  pool.accounts[account.id].identity = { accountId: "settled" };
  writeChatGPTAccountPoolState(pool, filePath);
  writeFileSync(switchPath, JSON.stringify({
    version: 1,
    desired: account.id,
    active: account.id,
    pending: false,
    phase: "idle",
  }), { mode: 0o600 });
  const settledTime = new Date("2000-01-01T00:00:00.000Z");
  utimesSync(filePath, settledTime, settledTime);
  utimesSync(switchPath, settledTime, settledTime);
  const before = {
    poolBytes: readFileSync(filePath, "utf8"),
    poolMtime: statSync(filePath).mtimeMs,
    switchBytes: readFileSync(switchPath, "utf8"),
    switchMtime: statSync(switchPath).mtimeMs,
  };

  for (let read = 0; read < 2; read += 1) {
    const ensured = await ensureChatGPTProfileAccounts({ filePath, homesDir, primaryHome, switchPath });
    assert.equal(ensured.currentAccountId, account.id);
  }
  assert.equal(readFileSync(filePath, "utf8"), before.poolBytes);
  assert.equal(statSync(filePath).mtimeMs, before.poolMtime);
  assert.equal(readFileSync(switchPath, "utf8"), before.switchBytes);
  assert.equal(statSync(switchPath).mtimeMs, before.switchMtime);
});

test("a selected profile waits for Codex to close and preserves both account profiles", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "codex-profile-switch-"));
  const primaryHome = path.join(root, "primary");
  const homesDir = path.join(root, "accounts");
  const filePath = path.join(root, "pool.json");
  const switchPath = path.join(root, "switch.json");
  mkdirSync(primaryHome, { recursive: true });
  const first = createChatGPTSubscriptionAccount({ filePath, homesDir });
  const second = createChatGPTSubscriptionAccount({ filePath, homesDir });
  const firstAuth = JSON.stringify({ tokens: { access_token: "first-token", account_id: "first" } });
  const secondAuth = JSON.stringify({ tokens: { access_token: "second-token", account_id: "second" } });
  writeFileSync(path.join(primaryHome, "auth.json"), firstAuth, { mode: 0o600 });
  writeFileSync(chatGPTSubscriptionAccountAuthPath(first.id, { homesDir }), firstAuth, { mode: 0o600 });
  writeFileSync(chatGPTSubscriptionAccountAuthPath(second.id, { homesDir }), secondAuth, { mode: 0o600 });

  const pending = await requestChatGPTProfileSwitch(second.id, {
    filePath,
    homesDir,
    primaryHome,
    switchPath,
    platform: "darwin",
    processList: "/Applications/ChatGPT.app/Contents/MacOS/ChatGPT",
    refreshCatalog: false,
  });
  assert.equal(pending.pending, true);
  assert.equal(readFileSync(path.join(primaryHome, "auth.json"), "utf8"), firstAuth);

  const stillPending = await reconcileChatGPTProfileSwitchIfReady({
    filePath,
    homesDir,
    primaryHome,
    switchPath,
    platform: "darwin",
    processList: "/Applications/ChatGPT.app/Contents/MacOS/ChatGPT",
    refreshCatalog: false,
  });
  assert.equal(stillPending.pending, true);
  assert.equal(readFileSync(path.join(primaryHome, "auth.json"), "utf8"), firstAuth);

  const applied = await reconcileChatGPTProfileSwitchIfReady({
    filePath,
    homesDir,
    primaryHome,
    switchPath,
    platform: "darwin",
    processList: "",
    refreshCatalog: false,
  });
  assert.equal(applied.active, second.id);
  assert.equal(readFileSync(path.join(primaryHome, "auth.json"), "utf8"), secondAuth);
  assert.equal(readFileSync(chatGPTSubscriptionAccountAuthPath(first.id, { homesDir }), "utf8"), firstAuth);

  const restore = await requestChatGPTProfileSwitch(first.id, {
    filePath,
    homesDir,
    primaryHome,
    switchPath,
    platform: "darwin",
    processList: "",
    refreshCatalog: false,
  });
  assert.equal(restore.active, first.id);
  assert.equal(readFileSync(path.join(primaryHome, "auth.json"), "utf8"), firstAuth);
  assert.equal(readChatGPTProfileSwitchState(switchPath).pending, false);
  assert.equal(chatGPTProfileSwitchSnapshot({ switchPath, platform: "darwin", processList: "" }).running, false);

  await requestChatGPTProfileSwitch(second.id, {
    filePath,
    homesDir,
    primaryHome,
    switchPath,
    platform: "darwin",
    processList: "",
    refreshCatalog: false,
  });
  const autoPending = await requestChatGPTProfileSwitch("auto", {
    filePath,
    homesDir,
    primaryHome,
    switchPath,
    platform: "darwin",
    processList: "/Applications/ChatGPT.app/Contents/MacOS/ChatGPT",
    refreshCatalog: false,
  });
  assert.equal(autoPending.pending, false);
  assert.equal(autoPending.active, second.id);
  const autoApplied = await reconcileChatGPTProfileSwitch({
    filePath,
    homesDir,
    primaryHome,
    switchPath,
    platform: "darwin",
    processList: "",
    refreshCatalog: false,
  });
  assert.equal(autoApplied.desired, second.id);
  assert.equal(autoApplied.active, second.id);
});

test("a target auth rewrite during switching rolls back instead of installing another identity", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "codex-profile-target-drift-"));
  const primaryHome = path.join(root, "primary");
  const homesDir = path.join(root, "accounts");
  const filePath = path.join(root, "pool.json");
  const switchPath = path.join(root, "switch.json");
  mkdirSync(primaryHome, { recursive: true });
  const first = createChatGPTSubscriptionAccount({ filePath, homesDir });
  const second = createChatGPTSubscriptionAccount({ filePath, homesDir });
  const firstAuth = JSON.stringify({ tokens: { access_token: "first-token", account_id: "first" } });
  const secondAuth = JSON.stringify({ tokens: { access_token: "second-token", account_id: "second" } });
  const replacementAuth = JSON.stringify({ tokens: { access_token: "replacement-token", account_id: "replacement" } });
  const targetPath = chatGPTSubscriptionAccountAuthPath(second.id, { homesDir });
  writeFileSync(path.join(primaryHome, "auth.json"), firstAuth, { mode: 0o600 });
  writeFileSync(chatGPTSubscriptionAccountAuthPath(first.id, { homesDir }), firstAuth, { mode: 0o600 });
  writeFileSync(targetPath, secondAuth, { mode: 0o600 });

  await assert.rejects(
    requestChatGPTProfileSwitch(second.id, {
      filePath,
      homesDir,
      primaryHome,
      switchPath,
      platform: "darwin",
      processList: "",
      refreshCatalog: false,
      afterSwitchBackup: () => writeFileSync(targetPath, replacementAuth, { mode: 0o600 }),
    }),
    /selected ChatGPT login profile changed during the native switch/,
  );
  assert.equal(readFileSync(path.join(primaryHome, "auth.json"), "utf8"), firstAuth);
  assert.equal(readFileSync(targetPath, "utf8"), replacementAuth);
  assert.deepEqual(readChatGPTProfileSwitchState(switchPath), {
    version: 1,
    desired: second.id,
    active: first.id,
    pending: true,
    phase: "idle",
  });
});

test("a target auth rewrite during awaited catalog refresh rolls back before commit", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "codex-profile-target-refresh-drift-"));
  const primaryHome = path.join(root, "primary");
  const homesDir = path.join(root, "accounts");
  const filePath = path.join(root, "pool.json");
  const switchPath = path.join(root, "switch.json");
  mkdirSync(primaryHome, { recursive: true });
  const first = createChatGPTSubscriptionAccount({ filePath, homesDir });
  const second = createChatGPTSubscriptionAccount({ filePath, homesDir });
  const firstAuth = JSON.stringify({ tokens: { access_token: "first-token", account_id: "first" } });
  const secondAuth = JSON.stringify({ tokens: { access_token: "second-token", account_id: "second" } });
  const replacementAuth = JSON.stringify({ tokens: { access_token: "replacement-token", account_id: "replacement" } });
  const targetPath = chatGPTSubscriptionAccountAuthPath(second.id, { homesDir });
  writeFileSync(path.join(primaryHome, "auth.json"), firstAuth, { mode: 0o600 });
  writeFileSync(chatGPTSubscriptionAccountAuthPath(first.id, { homesDir }), firstAuth, { mode: 0o600 });
  writeFileSync(targetPath, secondAuth, { mode: 0o600 });

  await assert.rejects(
    requestChatGPTProfileSwitch(second.id, {
      filePath,
      homesDir,
      primaryHome,
      switchPath,
      platform: "darwin",
      processList: "",
      modelsCachePath: path.join(root, "models-cache.json"),
      nativeCatalogPath: path.join(root, "native-catalog.json"),
      mergedCatalogPath: path.join(root, "merged-catalog.json"),
      nativeAliasPath: path.join(root, "native-alias.json"),
      announcedModelsPath: path.join(root, "announced-models.json"),
      refreshCatalog: async () => {
        await Promise.resolve();
        writeFileSync(targetPath, replacementAuth, { mode: 0o600 });
      },
    }),
    /selected ChatGPT login profile changed during the native switch/,
  );
  assert.equal(readFileSync(path.join(primaryHome, "auth.json"), "utf8"), firstAuth);
  assert.equal(readFileSync(targetPath, "utf8"), replacementAuth);
  assert.deepEqual(readChatGPTProfileSwitchState(switchPath), {
    version: 1,
    desired: second.id,
    active: first.id,
    pending: true,
    phase: "idle",
  });
});

test("private OAuth profile copies protect the temporary and final replacement", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "codex-profile-private-copy-"));
  const source = path.join(root, "source-auth.json");
  const destination = path.join(root, "nested", "auth.json");
  const protectedPaths = [];
  writeFileSync(source, JSON.stringify({ tokens: { account_id: "private" } }), { mode: 0o600 });
  atomicPrivateCopy(source, destination, {
    protect(target) {
      protectedPaths.push(target);
      chmodSync(target, 0o600);
    },
  });
  assert.equal(protectedPaths.length, 2);
  assert.match(protectedPaths[0], /auth\.json\.tmp-/);
  assert.equal(protectedPaths[1], destination);
  assert.equal(readFileSync(destination, "utf8"), readFileSync(source, "utf8"));
});

test("reconcile revalidates the desired account after waiting for the account lock", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "codex-profile-reconcile-race-"));
  const primaryHome = path.join(root, "primary");
  const homesDir = path.join(root, "accounts");
  const filePath = path.join(root, "pool.json");
  const switchPath = path.join(root, "switch.json");
  mkdirSync(primaryHome, { recursive: true });
  const first = createChatGPTSubscriptionAccount({ filePath, homesDir });
  const second = createChatGPTSubscriptionAccount({ filePath, homesDir });
  const firstAuth = JSON.stringify({ tokens: { access_token: "first-token", account_id: "first" } });
  const secondAuth = JSON.stringify({ tokens: { access_token: "second-token", account_id: "second" } });
  writeFileSync(path.join(primaryHome, "auth.json"), firstAuth, { mode: 0o600 });
  writeFileSync(chatGPTSubscriptionAccountAuthPath(first.id, { homesDir }), firstAuth, { mode: 0o600 });
  writeFileSync(chatGPTSubscriptionAccountAuthPath(second.id, { homesDir }), secondAuth, { mode: 0o600 });
  await requestChatGPTProfileSwitch(second.id, {
    filePath, homesDir, primaryHome, switchPath,
    platform: "darwin",
    processList: "/Applications/ChatGPT.app/Contents/MacOS/ChatGPT",
    refreshCatalog: false,
  });

  let releaseHolder;
  let markHeld;
  const held = new Promise((resolve) => { markHeld = resolve; });
  const release = new Promise((resolve) => { releaseHolder = resolve; });
  const holder = withChatGPTAccountPoolLock(async () => {
    markHeld();
    await release;
  }, { filePath, waitMs: 5_000, retryMs: 20 });
  await held;
  const reconciling = reconcileChatGPTProfileSwitch({
    filePath, homesDir, primaryHome, switchPath,
    platform: "darwin",
    processList: "",
    refreshCatalog: false,
    waitMs: 5_000,
    retryMs: 20,
  });
  await new Promise((resolve) => setTimeout(resolve, 60));

  const pool = readChatGPTAccountPoolState(filePath);
  writeChatGPTAccountPoolState({
    ...pool,
    policy: { ...pool.policy, selectedAccountId: first.id },
  }, filePath);
  writeFileSync(
    switchPath,
    JSON.stringify({ version: 1, desired: first.id, active: first.id, pending: false, phase: "idle" }),
    { mode: 0o600 },
  );
  releaseHolder();
  await holder;
  const reconciled = await reconciling;
  assert.equal(reconciled.desired, first.id);
  assert.equal(reconciled.active, first.id);
  assert.equal(readFileSync(path.join(primaryHome, "auth.json"), "utf8"), firstAuth);
});

test("a saved account identity is bound before a later switch", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "codex-profile-identity-"));
  const primaryHome = path.join(root, "primary");
  const homesDir = path.join(root, "accounts");
  const filePath = path.join(root, "pool.json");
  const switchPath = path.join(root, "switch.json");
  mkdirSync(primaryHome, { recursive: true });
  const first = createChatGPTSubscriptionAccount({ filePath, homesDir });
  const second = createChatGPTSubscriptionAccount({ filePath, homesDir });
  const firstAuth = JSON.stringify({ tokens: { access_token: "first-token", account_id: "first" } });
  const secondAuth = JSON.stringify({ tokens: { access_token: "second-token", account_id: "second" } });
  writeFileSync(path.join(primaryHome, "auth.json"), firstAuth, { mode: 0o600 });
  writeFileSync(chatGPTSubscriptionAccountAuthPath(first.id, { homesDir }), firstAuth, { mode: 0o600 });
  writeFileSync(chatGPTSubscriptionAccountAuthPath(second.id, { homesDir }), secondAuth, { mode: 0o600 });
  const options = { filePath, homesDir, primaryHome, switchPath, platform: "darwin", processList: "/Applications/Codex.app/Contents/MacOS/Codex", refreshCatalog: false };
  await requestChatGPTProfileSwitch(second.id, options);
  writeFileSync(
    chatGPTSubscriptionAccountAuthPath(second.id, { homesDir }),
    JSON.stringify({ tokens: { access_token: "replacement-token", account_id: "replacement" } }),
    { mode: 0o600 },
  );
  await assert.rejects(
    requestChatGPTProfileSwitch(second.id, { ...options, processList: "" }),
    /does not match its login profile/i,
  );
  assert.equal(readFileSync(path.join(primaryHome, "auth.json"), "utf8"), firstAuth);
});

test("background discovery does not bind auth while its login owner is active", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "codex-profile-leased-discovery-"));
  const homesDir = path.join(root, "accounts");
  const filePath = path.join(root, "pool.json");
  const account = createChatGPTSubscriptionAccount({ filePath, homesDir });
  writeFileSync(chatGPTSubscriptionAccountAuthPath(account.id, { homesDir }), JSON.stringify({
    tokens: { access_token: "new-login", account_id: "leased-identity" },
  }), { mode: 0o600 });
  const identity = () => "test-process";
  const lease = createChatGPTLoginLease(account.id, process.pid, { homesDir, identity });
  try {
    await ensureChatGPTProfileAccounts({
      filePath,
      homesDir,
      primaryHome: path.join(root, "primary"),
      switchPath: path.join(root, "switch.json"),
      loginLeaseIdentity: identity,
    });
    assert.equal(readChatGPTAccountPoolState(filePath).accounts[account.id].identity, undefined);
  } finally {
    assert.equal(clearChatGPTLoginLease(account.id, lease, { homesDir }), true);
  }
});

test("restart recovery finalizes changed active auth from its durable lease exactly once", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "codex-profile-login-restart-"));
  const primaryHome = path.join(root, "primary");
  const homesDir = path.join(root, "accounts");
  const filePath = path.join(root, "pool.json");
  const switchPath = path.join(root, "switch.json");
  mkdirSync(primaryHome, { recursive: true });
  const account = createChatGPTSubscriptionAccount({ filePath, homesDir });
  const oldAuth = JSON.stringify({ tokens: { access_token: "old-token", account_id: "same-account" } });
  const freshAuth = JSON.stringify({ tokens: { access_token: "fresh-token", account_id: "same-account" } });
  writeFileSync(path.join(primaryHome, "auth.json"), oldAuth, { mode: 0o600 });
  writeFileSync(chatGPTSubscriptionAccountAuthPath(account.id, { homesDir }), oldAuth, { mode: 0o600 });
  const pool = readChatGPTAccountPoolState(filePath);
  pool.accounts[account.id].identity = { accountId: "same-account" };
  writeChatGPTAccountPoolState(pool, filePath);
  writeFileSync(switchPath, JSON.stringify({
    version: 1,
    desired: account.id,
    active: account.id,
    pending: false,
    phase: "idle",
  }), { mode: 0o600 });
  createChatGPTLoginLease(account.id, 4242, {
    homesDir,
    identity: () => "departed-owner",
    now: 1_000,
    phase: "running",
  });
  writeFileSync(chatGPTSubscriptionAccountAuthPath(account.id, { homesDir }), freshAuth, { mode: 0o600 });

  const options = {
    filePath,
    homesDir,
    primaryHome,
    switchPath,
    platform: "darwin",
    processList: "",
    refreshCatalog: false,
    loginLeaseIdentity: () => "replacement-owner",
    now: 1_000 + CHATGPT_LOGIN_LEASE_MAX_AGE_MS + 1,
  };
  assert.deepEqual(await recoverCompletedChatGPTProfileLogins(options), {
    recovered: [account.id],
    failures: [],
  });
  assert.equal(readFileSync(path.join(primaryHome, "auth.json"), "utf8"), freshAuth);
  assert.equal(existsSync(path.join(homesDir, account.id, "router-login-lease.json")), false);
  assert.equal(readChatGPTProfileSwitchState(switchPath).pending, false);
  assert.deepEqual(await recoverCompletedChatGPTProfileLogins(options), { recovered: [], failures: [] });
});

test("restart recovery is idempotent after profile commit but before exact lease clear", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "codex-profile-login-post-commit-"));
  const primaryHome = path.join(root, "primary");
  const homesDir = path.join(root, "accounts");
  const filePath = path.join(root, "pool.json");
  const switchPath = path.join(root, "switch.json");
  mkdirSync(primaryHome, { recursive: true });
  const account = createChatGPTSubscriptionAccount({ filePath, homesDir });
  const oldAuth = JSON.stringify({ tokens: { access_token: "old", account_id: "same" } });
  const freshAuth = JSON.stringify({ tokens: { access_token: "fresh", account_id: "same" } });
  writeFileSync(path.join(primaryHome, "auth.json"), oldAuth, { mode: 0o600 });
  writeFileSync(chatGPTSubscriptionAccountAuthPath(account.id, { homesDir }), oldAuth, { mode: 0o600 });
  const pool = readChatGPTAccountPoolState(filePath);
  pool.accounts[account.id].identity = { accountId: "same" };
  writeChatGPTAccountPoolState(pool, filePath);
  writeFileSync(switchPath, JSON.stringify({ version: 1, desired: account.id, active: account.id, pending: false, phase: "idle" }), { mode: 0o600 });
  const lease = createChatGPTLoginLease(account.id, 4242, {
    homesDir,
    identity: () => "departed-owner",
    now: 1_000,
    phase: "running",
  });
  writeFileSync(chatGPTSubscriptionAccountAuthPath(account.id, { homesDir }), freshAuth, { mode: 0o600 });
  await assert.rejects(
    finalizeChatGPTProfileLogin(account.id, {
      filePath,
      homesDir,
      primaryHome,
      switchPath,
      platform: "darwin",
      processList: "",
      refreshCatalog: false,
      expectedLoginLease: lease,
      clearLoginLease: () => false,
    }),
    /lease changed after finalization/,
  );
  assert.equal(readFileSync(path.join(primaryHome, "auth.json"), "utf8"), freshAuth);
  assert.equal(existsSync(path.join(homesDir, account.id, "router-login-lease.json")), true);

  assert.deepEqual(await recoverCompletedChatGPTProfileLogins({
    filePath,
    homesDir,
    primaryHome,
    switchPath,
    platform: "darwin",
    processList: "",
    refreshCatalog: false,
    loginLeaseIdentity: () => "replacement-owner",
    now: 2_000,
  }), { recovered: [account.id], failures: [] });
  assert.equal(readFileSync(path.join(primaryHome, "auth.json"), "utf8"), freshAuth);
  assert.equal(existsSync(path.join(homesDir, account.id, "router-login-lease.json")), false);
});

test("restart recovery reports one invalid login while finalizing another", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "codex-profile-login-partial-recovery-"));
  const homesDir = path.join(root, "accounts");
  const filePath = path.join(root, "pool.json");
  const invalid = createChatGPTSubscriptionAccount({ filePath, homesDir });
  const valid = createChatGPTSubscriptionAccount({ filePath, homesDir });
  for (const account of [invalid, valid]) {
    createChatGPTLoginLease(account.id, 4242, {
      homesDir,
      identity: () => "departed-owner",
      now: 1_000,
      phase: "running",
    });
  }
  writeFileSync(
    chatGPTSubscriptionAccountAuthPath(invalid.id, { homesDir }),
    JSON.stringify({ tokens: { access_token: "invalid", account_id: "x".repeat(257) } }),
    { mode: 0o600 },
  );
  writeFileSync(
    chatGPTSubscriptionAccountAuthPath(valid.id, { homesDir }),
    JSON.stringify({ tokens: { access_token: "valid", account_id: "valid-account" } }),
    { mode: 0o600 },
  );

  const options = {
    filePath,
    homesDir,
    refreshCatalog: false,
    loginLeaseIdentity: () => "replacement-owner",
    now: 2_000,
  };
  assert.deepEqual(await recoverCompletedChatGPTProfileLogins(options), {
    recovered: [valid.id],
    failures: [{ accountId: invalid.id, code: "invalid-auth" }],
  });
  assert.equal(existsSync(path.join(homesDir, invalid.id, "router-login-lease.json")), true);
  assert.equal(existsSync(path.join(homesDir, valid.id, "router-login-lease.json")), false);
  assert.equal(readChatGPTAccountPoolState(filePath).accounts[valid.id].identity.accountId, "valid-account");
  assert.equal(await discardCompletedChatGPTProfileLogin(invalid.id, options), true);
  assert.equal(await discardCompletedChatGPTProfileLogin(invalid.id, options), false);
});

test("restart recovery makes a deleted completed auth profile explicitly retryable", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "codex-profile-login-deleted-auth-"));
  const homesDir = path.join(root, "accounts");
  const filePath = path.join(root, "pool.json");
  const account = createChatGPTSubscriptionAccount({ filePath, homesDir });
  const authPath = chatGPTSubscriptionAccountAuthPath(account.id, { homesDir });
  writeFileSync(authPath, JSON.stringify({ tokens: { access_token: "old", account_id: "old" } }), { mode: 0o600 });
  createChatGPTLoginLease(account.id, 4242, {
    homesDir,
    identity: () => "departed-owner",
    now: 1_000,
    phase: "running",
  });
  rmSync(authPath);
  const options = {
    filePath,
    homesDir,
    refreshCatalog: false,
    loginLeaseIdentity: () => "replacement-owner",
    now: 2_000,
  };
  assert.deepEqual(await recoverCompletedChatGPTProfileLogins(options), {
    recovered: [],
    failures: [{ accountId: account.id, code: "invalid-auth" }],
  });
  assert.equal(await discardCompletedChatGPTProfileLogin(account.id, options), true);
});

test("explicit retry resets only an exactly ended changed login", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "codex-profile-login-reset-"));
  const homesDir = path.join(root, "accounts");
  const filePath = path.join(root, "pool.json");
  const account = createChatGPTSubscriptionAccount({ filePath, homesDir });
  const ended = createChatGPTLoginLease(account.id, 4242, {
    homesDir,
    identity: () => "departed-owner",
    now: 1_000,
    phase: "running",
  });
  writeFileSync(
    chatGPTSubscriptionAccountAuthPath(account.id, { homesDir }),
    JSON.stringify({ tokens: { access_token: "changed", account_id: "x".repeat(257) } }),
    { mode: 0o600 },
  );
  const endedOptions = {
    filePath,
    homesDir,
    loginLeaseIdentity: () => "replacement-owner",
    now: 2_000,
  };
  assert.equal(await discardCompletedChatGPTProfileLogin(account.id, endedOptions), true);
  const retry = createChatGPTLoginLease(account.id, 5252, {
    homesDir,
    identity: () => "live-retry",
    now: 3_000,
    phase: "running",
  });
  writeFileSync(
    chatGPTSubscriptionAccountAuthPath(account.id, { homesDir }),
    JSON.stringify({ tokens: { access_token: "changed-again", account_id: "y".repeat(257) } }),
    { mode: 0o600 },
  );
  assert.notEqual(retry.leaseId, ended.leaseId);
  assert.equal(await discardCompletedChatGPTProfileLogin(account.id, {
    ...endedOptions,
    loginLeaseIdentity: () => "live-retry",
  }), false, "a live matching owner must not be reset");
  assert.equal(await discardCompletedChatGPTProfileLogin(account.id, {
    ...endedOptions,
    loginLeaseIdentity: () => undefined,
  }), false, "an unprobeable owner must not be reset");
  assert.equal(clearChatGPTLoginLease(account.id, retry, { homesDir }), true);

  const valid = createChatGPTLoginLease(account.id, 6262, {
    homesDir,
    identity: () => "departed-valid-owner",
    now: 4_000,
    phase: "running",
  });
  writeFileSync(
    chatGPTSubscriptionAccountAuthPath(account.id, { homesDir }),
    JSON.stringify({ tokens: { access_token: "valid", account_id: "valid-recovery" } }),
    { mode: 0o600 },
  );
  assert.equal(await discardCompletedChatGPTProfileLogin(account.id, {
    ...endedOptions,
    loginLeaseIdentity: () => "replacement-owner",
    now: 5_000,
  }), false, "valid recovery evidence must not be reset");
  assert.equal(clearChatGPTLoginLease(account.id, valid, { homesDir }), true);
});

test("login finalization binds inactive identities and synchronizes an active refresh only when Codex closes", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "codex-profile-login-finalize-"));
  const primaryHome = path.join(root, "primary");
  const homesDir = path.join(root, "accounts");
  const filePath = path.join(root, "pool.json");
  const switchPath = path.join(root, "switch.json");
  mkdirSync(primaryHome, { recursive: true });
  const first = createChatGPTSubscriptionAccount({ filePath, homesDir });
  const second = createChatGPTSubscriptionAccount({ filePath, homesDir });
  const firstAuth = JSON.stringify({ tokens: { access_token: "first-token", account_id: "first" } });
  const secondAuth = JSON.stringify({ tokens: { access_token: "second-old", account_id: "second" } });
  writeFileSync(path.join(primaryHome, "auth.json"), firstAuth, { mode: 0o600 });
  writeFileSync(chatGPTSubscriptionAccountAuthPath(first.id, { homesDir }), firstAuth, { mode: 0o600 });
  writeFileSync(chatGPTSubscriptionAccountAuthPath(second.id, { homesDir }), secondAuth, { mode: 0o600 });
  const pool = readChatGPTAccountPoolState(filePath);
  pool.accounts[first.id].identity = { accountId: "first" };
  writeChatGPTAccountPoolState(pool, filePath);
  writeFileSync(switchPath, JSON.stringify({
    version: 1,
    desired: first.id,
    active: first.id,
    pending: false,
    phase: "idle",
  }), { mode: 0o600 });
  const base = {
    filePath,
    homesDir,
    primaryHome,
    switchPath,
    refreshCatalog: false,
    expectedLoginLease: { leaseId: "fixture" },
    loginLeaseMatches: () => true,
    loginAuthChanged: () => true,
    hardenAuth: () => {},
    clearLoginLease: () => true,
  };

  const inactive = await finalizeChatGPTProfileLogin(second.id, {
    ...base,
    platform: "darwin",
    processList: "",
  });
  assert.equal(inactive.active, first.id);
  assert.equal(readFileSync(path.join(primaryHome, "auth.json"), "utf8"), firstAuth);
  assert.equal(readChatGPTAccountPoolState(filePath).accounts[second.id].identity.accountId, "second");

  await requestChatGPTProfileSwitch(second.id, {
    ...base,
    platform: "darwin",
    processList: "",
  });
  assert.equal(readFileSync(path.join(primaryHome, "auth.json"), "utf8"), secondAuth);
  const refreshedAuth = JSON.stringify({ tokens: { access_token: "second-fresh", account_id: "second" } });
  writeFileSync(chatGPTSubscriptionAccountAuthPath(second.id, { homesDir }), refreshedAuth, { mode: 0o600 });
  const calls = [];
  const pending = await finalizeChatGPTProfileLogin(second.id, {
    ...base,
    platform: "darwin",
    processList: "/Applications/Codex.app/Contents/MacOS/Codex",
    hardenAuth: () => calls.push("harden"),
    clearLoginLease: () => {
      calls.push("clear");
      return true;
    },
  });
  assert.deepEqual(calls, ["harden"]);
  assert.equal(pending.pending, false);
  assert.equal(pending.loginFinalizationPending, true);
  assert.equal(pending.active, second.id);
  assert.equal(readFileSync(path.join(primaryHome, "auth.json"), "utf8"), secondAuth);

  const reconciled = await finalizeChatGPTProfileLogin(second.id, {
    ...base,
    platform: "darwin",
    processList: "",
    hardenAuth: () => calls.push("harden"),
    clearLoginLease: () => {
      calls.push("clear");
      return true;
    },
  });
  assert.deepEqual(calls, ["harden", "harden", "clear"]);
  assert.equal(reconciled.pending, false);
  assert.equal(reconciled.active, second.id);
  assert.equal(readFileSync(path.join(primaryHome, "auth.json"), "utf8"), refreshedAuth);
});

test("login finalization leaves its durable lease when credential hardening fails", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "codex-profile-login-hardening-"));
  const primaryHome = path.join(root, "primary");
  const homesDir = path.join(root, "accounts");
  const filePath = path.join(root, "pool.json");
  const switchPath = path.join(root, "switch.json");
  mkdirSync(primaryHome, { recursive: true });
  const account = createChatGPTSubscriptionAccount({ filePath, homesDir });
  const auth = JSON.stringify({ tokens: { access_token: "token", account_id: "account" } });
  writeFileSync(path.join(primaryHome, "auth.json"), auth, { mode: 0o600 });
  writeFileSync(chatGPTSubscriptionAccountAuthPath(account.id, { homesDir }), auth, { mode: 0o600 });
  writeFileSync(switchPath, JSON.stringify({
    version: 1,
    desired: account.id,
    active: account.id,
    pending: false,
    phase: "idle",
  }), { mode: 0o600 });
  let cleared = false;
  await assert.rejects(
    finalizeChatGPTProfileLogin(account.id, {
      filePath,
      homesDir,
      primaryHome,
      switchPath,
      refreshCatalog: false,
      expectedLoginLease: { leaseId: "fixture" },
      loginLeaseMatches: () => true,
      loginAuthChanged: () => true,
      hardenAuth: () => { throw new Error("ACL hardening refused"); },
      clearLoginLease: () => { cleared = true; return true; },
    }),
    /ACL hardening refused/,
  );
  assert.equal(cleared, false);
  assert.equal(readFileSync(path.join(primaryHome, "auth.json"), "utf8"), auth);

  let matchChecks = 0;
  await assert.rejects(
    finalizeChatGPTProfileLogin(account.id, {
      filePath,
      homesDir,
      primaryHome,
      switchPath,
      refreshCatalog: false,
      expectedLoginLease: { leaseId: "wrong-generation" },
      loginLeaseMatches: () => ++matchChecks === 1,
      loginAuthChanged: () => true,
      hardenAuth: () => {},
      clearLoginLease: () => false,
    }),
    /lease changed before finalization/,
  );
  assert.equal(readChatGPTAccountPoolState(filePath).accounts[account.id].identity, undefined);
  assert.equal(readFileSync(path.join(primaryHome, "auth.json"), "utf8"), auth);
});

test("login finalization rejects unbindable account identities without clearing ownership", async () => {
  for (const accountId of ["x".repeat(257), "valid-prefix\u0007suffix"]) {
    const root = mkdtempSync(path.join(os.tmpdir(), "codex-profile-login-invalid-identity-"));
    const homesDir = path.join(root, "accounts");
    const filePath = path.join(root, "pool.json");
    const account = createChatGPTSubscriptionAccount({ filePath, homesDir });
    writeFileSync(
      chatGPTSubscriptionAccountAuthPath(account.id, { homesDir }),
      JSON.stringify({ tokens: { access_token: "fresh", account_id: accountId } }),
      { mode: 0o600 },
    );
    let cleared = false;
    await assert.rejects(
      finalizeChatGPTProfileLogin(account.id, {
        filePath,
        homesDir,
        refreshCatalog: false,
        expectedLoginLease: { leaseId: "fixture" },
        loginLeaseMatches: () => true,
        loginAuthChanged: () => true,
        hardenAuth: () => {},
        clearLoginLease: () => { cleared = true; return true; },
      }),
      /login profile is invalid after hardening/,
    );
    assert.equal(cleared, false);
    assert.equal(readChatGPTAccountPoolState(filePath).accounts[account.id].identity, undefined);
  }
});

test("login finalization rejects duplicate unbound credentials without clearing ownership", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "codex-profile-login-duplicate-"));
  const primaryHome = path.join(root, "primary");
  const homesDir = path.join(root, "accounts");
  const filePath = path.join(root, "pool.json");
  const switchPath = path.join(root, "switch.json");
  mkdirSync(primaryHome, { recursive: true });
  const first = createChatGPTSubscriptionAccount({ filePath, homesDir });
  const second = createChatGPTSubscriptionAccount({ filePath, homesDir });
  const auth = JSON.stringify({ tokens: { access_token: "token", account_id: "duplicate" } });
  writeFileSync(path.join(primaryHome, "auth.json"), auth, { mode: 0o600 });
  writeFileSync(chatGPTSubscriptionAccountAuthPath(first.id, { homesDir }), auth, { mode: 0o600 });
  writeFileSync(chatGPTSubscriptionAccountAuthPath(second.id, { homesDir }), auth, { mode: 0o600 });
  writeFileSync(switchPath, JSON.stringify({
    version: 1,
    desired: first.id,
    active: first.id,
    pending: false,
    phase: "idle",
  }), { mode: 0o600 });
  let cleared = false;
  await assert.rejects(
    finalizeChatGPTProfileLogin(second.id, {
      filePath,
      homesDir,
      primaryHome,
      switchPath,
      refreshCatalog: false,
      expectedLoginLease: { leaseId: "fixture" },
      loginLeaseMatches: () => true,
      loginAuthChanged: () => true,
      hardenAuth: () => {},
      clearLoginLease: () => { cleared = true; return true; },
    }),
    /registered more than once/,
  );
  assert.equal(cleared, false);
  assert.equal(readChatGPTAccountPoolState(filePath).accounts[second.id].identity, undefined);
});

test("an inactive identity-conflict account remains removable after explicit failed-login reset", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "codex-profile-login-conflict-remove-"));
  const homesDir = path.join(root, "accounts");
  const filePath = path.join(root, "pool.json");
  const switchPath = path.join(root, "switch.json");
  const first = createChatGPTSubscriptionAccount({ filePath, homesDir });
  const duplicate = createChatGPTSubscriptionAccount({ filePath, homesDir });
  const auth = JSON.stringify({ tokens: { access_token: "duplicate", account_id: "same-account" } });
  writeFileSync(chatGPTSubscriptionAccountAuthPath(first.id, { homesDir }), auth, { mode: 0o600 });
  const pool = readChatGPTAccountPoolState(filePath);
  pool.accounts[first.id].identity = { accountId: "same-account" };
  writeChatGPTAccountPoolState(pool, filePath);
  writeFileSync(switchPath, JSON.stringify({
    version: 1,
    desired: first.id,
    active: first.id,
    pending: false,
    phase: "idle",
  }), { mode: 0o600 });
  createChatGPTLoginLease(duplicate.id, 4242, {
    homesDir,
    identity: () => "departed-owner",
    now: 1_000,
    phase: "running",
  });
  writeFileSync(chatGPTSubscriptionAccountAuthPath(duplicate.id, { homesDir }), auth, { mode: 0o600 });
  const options = {
    filePath,
    homesDir,
    switchPath,
    refreshCatalog: false,
    loginLeaseIdentity: () => "replacement-owner",
    now: 2_000,
  };
  assert.deepEqual(await recoverCompletedChatGPTProfileLogins(options), {
    recovered: [],
    failures: [{ accountId: duplicate.id, code: "identity-conflict" }],
  });
  assert.equal(await discardCompletedChatGPTProfileLogin(duplicate.id, options), true);
  const removed = await removeChatGPTProfileAccount(duplicate.id, options);
  assert.equal(removed.removed.id, duplicate.id);
  assert.equal(removed.removed.state, "revoked");
  const persisted = readChatGPTAccountPoolState(filePath).accounts[duplicate.id];
  assert.ok(!persisted || persisted.state === "revoked");
  assert.equal(removed.profile.active, first.id);
});

test("an active bound-identity mismatch remains retryable without bypassing removal discovery", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "codex-profile-login-mismatch-remove-"));
  const homesDir = path.join(root, "accounts");
  const filePath = path.join(root, "pool.json");
  const switchPath = path.join(root, "switch.json");
  const primaryHome = path.join(root, "primary");
  mkdirSync(primaryHome, { recursive: true });
  const replacement = createChatGPTSubscriptionAccount({ filePath, homesDir });
  const mismatch = createChatGPTSubscriptionAccount({ filePath, homesDir });
  const replacementAuth = JSON.stringify({ tokens: { access_token: "replacement", account_id: "replacement-account" } });
  const priorAuth = JSON.stringify({ tokens: { access_token: "prior", account_id: "prior-account" } });
  writeFileSync(path.join(primaryHome, "auth.json"), priorAuth, { mode: 0o600 });
  writeFileSync(chatGPTSubscriptionAccountAuthPath(replacement.id, { homesDir }), replacementAuth, { mode: 0o600 });
  writeFileSync(chatGPTSubscriptionAccountAuthPath(mismatch.id, { homesDir }), priorAuth, { mode: 0o600 });
  const pool = readChatGPTAccountPoolState(filePath);
  pool.accounts[replacement.id].identity = { accountId: "replacement-account" };
  pool.accounts[mismatch.id].identity = { accountId: "prior-account" };
  pool.policy.selectedAccountId = mismatch.id;
  writeChatGPTAccountPoolState(pool, filePath);
  writeFileSync(switchPath, JSON.stringify({
    version: 1,
    desired: mismatch.id,
    active: mismatch.id,
    pending: false,
    phase: "idle",
  }), { mode: 0o600 });
  createChatGPTLoginLease(mismatch.id, 4242, {
    homesDir,
    identity: () => "departed-owner",
    now: 1_000,
    phase: "running",
  });
  writeFileSync(
    chatGPTSubscriptionAccountAuthPath(mismatch.id, { homesDir }),
    JSON.stringify({ tokens: { access_token: "new", account_id: "new-unique-account" } }),
    { mode: 0o600 },
  );
  const options = {
    filePath,
    homesDir,
    primaryHome,
    switchPath,
    refreshCatalog: false,
    platform: "darwin",
    processList: "",
    loginLeaseIdentity: () => "replacement-owner",
    now: 2_000,
  };
  assert.deepEqual(await recoverCompletedChatGPTProfileLogins(options), {
    recovered: [],
    failures: [{ accountId: mismatch.id, code: "identity-conflict" }],
  });
  assert.equal(await discardCompletedChatGPTProfileLogin(mismatch.id, options), true);
  await assert.rejects(
    removeChatGPTProfileAccount(mismatch.id, options),
    /identity does not match/i,
  );
  const retry = createChatGPTLoginLease(mismatch.id, 5252, {
    homesDir,
    identity: () => "retry-owner",
    now: 3_000,
    phase: "reserved",
  });
  assert.equal(clearChatGPTLoginLease(mismatch.id, retry, { homesDir }), true);
  assert.equal(readFileSync(path.join(primaryHome, "auth.json"), "utf8"), priorAuth);
});

test("Windows login finalization replaces a foreign inherited OAuth ACL", { skip: process.platform !== "win32" }, async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "codex-profile-login-windows-acl-"));
  const homesDir = path.join(root, "accounts");
  const filePath = path.join(root, "pool.json");
  const account = createChatGPTSubscriptionAccount({ filePath, homesDir });
  const authPath = chatGPTSubscriptionAccountAuthPath(account.id, { homesDir });
  const oldAuth = JSON.stringify({ tokens: { access_token: "old", account_id: "windows-account" } });
  const freshAuth = JSON.stringify({ tokens: { access_token: "fresh", account_id: "windows-account" } });
  writeFileSync(authPath, oldAuth, { mode: 0o600 });
  const lease = createChatGPTLoginLease(account.id, process.pid, { homesDir, identity: () => "owner" });
  writeFileSync(authPath, freshAuth, { mode: 0o600 });
  const dirtyAcl = [
    "$acl = [System.IO.File]::GetAccessControl($env:CODEX_ROUTER_PRIVATE_FILE)",
    "[void]$acl.SetAccessRuleProtection($false, $true)",
    "$everyone = [Security.Principal.SecurityIdentifier]::new('S-1-1-0')",
    "$rule = [System.Security.AccessControl.FileSystemAccessRule]::new($everyone, [System.Security.AccessControl.FileSystemRights]::Read, [System.Security.AccessControl.InheritanceFlags]::None, [System.Security.AccessControl.PropagationFlags]::None, [System.Security.AccessControl.AccessControlType]::Allow)",
    "[void]$acl.AddAccessRule($rule)",
    "[System.IO.File]::SetAccessControl($env:CODEX_ROUTER_PRIVATE_FILE, $acl)",
  ].join("; ");
  execFileSync("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", dirtyAcl], {
    env: { ...process.env, CODEX_ROUTER_PRIVATE_FILE: authPath },
    stdio: "ignore",
  });
  assert.equal(privateFileIsProtected(authPath), false);

  await finalizeChatGPTProfileLogin(account.id, {
    filePath,
    homesDir,
    primaryHome: path.join(root, "primary"),
    switchPath: path.join(root, "switch.json"),
    refreshCatalog: false,
    expectedLoginLease: lease,
  });
  assert.equal(privateFileIsProtected(authPath), true);
  assert.equal(readChatGPTAccountPoolState(filePath).accounts[account.id].identity.accountId, "windows-account");
});

test("a same-account refresh does not mutate primary auth when journal staging fails", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "codex-profile-refresh-staging-"));
  const primaryHome = path.join(root, "primary");
  const homesDir = path.join(root, "accounts");
  const filePath = path.join(root, "pool.json");
  const switchPath = path.join(root, "switch.json");
  mkdirSync(primaryHome, { recursive: true });
  const account = createChatGPTSubscriptionAccount({ filePath, homesDir });
  const oldAuth = JSON.stringify({ tokens: { access_token: "old", account_id: "same" } });
  const freshAuth = JSON.stringify({ tokens: { access_token: "fresh", account_id: "same" } });
  writeFileSync(path.join(primaryHome, "auth.json"), oldAuth, { mode: 0o600 });
  writeFileSync(chatGPTSubscriptionAccountAuthPath(account.id, { homesDir }), freshAuth, { mode: 0o600 });
  const pool = readChatGPTAccountPoolState(filePath);
  pool.accounts[account.id].identity = { accountId: "same" };
  writeChatGPTAccountPoolState(pool, filePath);
  const before = {
    version: 1,
    desired: account.id,
    active: account.id,
    pending: true,
    phase: "idle",
  };
  writeFileSync(switchPath, JSON.stringify(before), { mode: 0o600 });

  await assert.rejects(
    requestChatGPTProfileSwitch(account.id, {
      filePath,
      homesDir,
      primaryHome,
      switchPath,
      platform: "darwin",
      processList: "",
      refreshCatalog: false,
      afterSwitchTransactionEvidenceStaged: () => { throw new Error("staging interrupted"); },
    }),
    /staging interrupted/,
  );
  assert.equal(readFileSync(path.join(primaryHome, "auth.json"), "utf8"), oldAuth);
  assert.deepEqual(readChatGPTProfileSwitchState(switchPath), before);
  assert.equal(existsSync(path.join(root, "chatgpt-profile", "switch-transaction")), false);
  assert.equal(existsSync(path.join(root, "chatgpt-profile", "switch-transaction.staging")), false);
});

test("a published pre-phase journal is abandoned without restoring stale catalog state", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "codex-profile-pre-phase-crash-"));
  const primaryHome = path.join(root, "primary");
  const homesDir = path.join(root, "accounts");
  const filePath = path.join(root, "pool.json");
  const switchPath = path.join(root, "switch.json");
  const transactionDir = path.join(root, "chatgpt-profile", "switch-transaction");
  const catalog = {
    modelsCachePath: path.join(root, "models_cache.json"),
    nativeCatalogPath: path.join(root, "native-models.json"),
    mergedCatalogPath: path.join(root, "merged-models.json"),
    nativeAliasPath: path.join(root, "native-aliases.json"),
    announcedModelsPath: path.join(root, "announced-models.json"),
  };
  mkdirSync(primaryHome, { recursive: true });
  const first = createChatGPTSubscriptionAccount({ filePath, homesDir });
  const second = createChatGPTSubscriptionAccount({ filePath, homesDir });
  const firstAuth = JSON.stringify({ tokens: { access_token: "first", account_id: "first" } });
  const secondAuth = JSON.stringify({ tokens: { access_token: "second", account_id: "second" } });
  writeFileSync(path.join(primaryHome, "auth.json"), firstAuth, { mode: 0o600 });
  writeFileSync(chatGPTSubscriptionAccountAuthPath(first.id, { homesDir }), firstAuth, { mode: 0o600 });
  writeFileSync(chatGPTSubscriptionAccountAuthPath(second.id, { homesDir }), secondAuth, { mode: 0o600 });
  const pool = readChatGPTAccountPoolState(filePath);
  pool.accounts[first.id].identity = { accountId: "first" };
  pool.accounts[second.id].identity = { accountId: "second" };
  writeChatGPTAccountPoolState(pool, filePath);
  const priorState = {
    version: 1,
    desired: first.id,
    active: first.id,
    pending: false,
    phase: "idle",
  };
  writeFileSync(switchPath, JSON.stringify(priorState), { mode: 0o600 });
  const originalCatalog = Object.fromEntries(Object.entries(catalog).map(([key, target]) => {
    const contents = JSON.stringify({ key, owner: "first", exact: true });
    writeFileSync(target, contents, { mode: 0o600 });
    return [key, contents];
  }));
  const targetCatalogDir = chatGPTSubscriptionAccountCatalogDir(second.id, { homesDir });
  mkdirSync(targetCatalogDir, { recursive: true, mode: 0o700 });
  const targetCatalog = Object.fromEntries([
    ["models_cache.json", "modelsCachePath"],
    ["native-models.json", "nativeCatalogPath"],
    ["merged-models.json", "mergedCatalogPath"],
    ["native-aliases.json", "nativeAliasPath"],
    ["announced-models.json", "announcedModelsPath"],
  ].map(([name, key]) => {
    const contents = JSON.stringify({ key, owner: "second", exact: true });
    writeFileSync(path.join(targetCatalogDir, name), contents, { mode: 0o600 });
    return [key, contents];
  }));

  const moduleUrl = pathToFileURL(path.resolve("src/chatgpt-profile-switch.mjs")).href;
  const childSource = `
    import { requestChatGPTProfileSwitch } from ${JSON.stringify(moduleUrl)};
    await requestChatGPTProfileSwitch(${JSON.stringify(second.id)}, {
      filePath: ${JSON.stringify(filePath)}, homesDir: ${JSON.stringify(homesDir)},
      primaryHome: ${JSON.stringify(primaryHome)}, switchPath: ${JSON.stringify(switchPath)},
      platform: "darwin", processList: "", refreshCatalog: false,
      ${Object.entries(catalog).map(([key, value]) => `${key}: ${JSON.stringify(value)}`).join(",\n      ")},
      afterSwitchTransactionPublished: () => process.exit(86),
    });
  `;
  const crashed = spawnSync(process.execPath, ["--input-type=module", "-e", childSource], {
    cwd: path.resolve("."),
    encoding: "utf8",
  });
  assert.equal(crashed.status, 86, crashed.stderr);
  assert.equal(existsSync(transactionDir), true);
  assert.deepEqual(readChatGPTProfileSwitchState(switchPath), priorState);
  assert.equal(readFileSync(path.join(primaryHome, "auth.json"), "utf8"), firstAuth);
  for (const [key, contents] of Object.entries(originalCatalog)) {
    assert.equal(readFileSync(catalog[key], "utf8"), contents, `${key} changed before recovery`);
  }

  const options = {
    filePath,
    homesDir,
    primaryHome,
    switchPath,
    platform: "darwin",
    processList: "",
    refreshCatalog: false,
    ...catalog,
  };
  const recovered = await reconcileChatGPTProfileSwitchIfReady(options);
  assert.deepEqual({ ...recovered, running: undefined }, { ...priorState, running: undefined });
  assert.equal(existsSync(transactionDir), false);
  const idempotent = await reconcileChatGPTProfileSwitchIfReady(options);
  assert.deepEqual({ ...idempotent, running: undefined }, { ...priorState, running: undefined });
  for (const [key, contents] of Object.entries(originalCatalog)) {
    assert.equal(readFileSync(catalog[key], "utf8"), contents, `${key} changed during recovery`);
  }

  const switched = await requestChatGPTProfileSwitch(second.id, options);
  assert.equal(switched.active, second.id);
  assert.equal(switched.pending, false);
  assert.equal(readFileSync(path.join(primaryHome, "auth.json"), "utf8"), secondAuth);
  for (const [key, contents] of Object.entries(targetCatalog)) {
    assert.equal(readFileSync(catalog[key], "utf8"), contents, `${key} did not follow the later switch`);
  }
});

test("every durable switch crash boundary reconciles idempotently and permits a later switch", async () => {
  const cases = [
    ["evidence-staged", "afterSwitchTransactionEvidenceStaged", false],
    ["manifest-staged", "afterSwitchTransactionManifestStaged", false],
    ["preparing", "afterSwitchPreparing", true],
    ["backed-up", "afterSwitchBackup", true],
    ["primary-installed", "afterSwitchInstall", true],
    ["installed", "afterSwitchInstalled", true],
    ["idle-before-removal", "afterSwitchIdleBeforeTransactionRemoval", true],
  ];
  const moduleUrl = pathToFileURL(path.resolve("src/chatgpt-profile-switch.mjs")).href;
  for (const [label, hook, targetCommitted] of cases) {
    const root = mkdtempSync(path.join(os.tmpdir(), `codex-profile-crash-${label}-`));
    const primaryHome = path.join(root, "primary");
    const homesDir = path.join(root, "accounts");
    const filePath = path.join(root, "pool.json");
    const switchPath = path.join(root, "switch.json");
    const transactionDir = path.join(root, "chatgpt-profile", "switch-transaction");
    const stagingDir = `${transactionDir}.staging`;
    const catalog = {
      modelsCachePath: path.join(root, "models_cache.json"),
      nativeCatalogPath: path.join(root, "native-models.json"),
      mergedCatalogPath: path.join(root, "merged-models.json"),
      nativeAliasPath: path.join(root, "native-aliases.json"),
      announcedModelsPath: path.join(root, "announced-models.json"),
    };
    mkdirSync(primaryHome, { recursive: true });
    const first = createChatGPTSubscriptionAccount({ filePath, homesDir });
    const second = createChatGPTSubscriptionAccount({ filePath, homesDir });
    const firstAuth = JSON.stringify({ tokens: { access_token: `${label}-first`, account_id: "first" } });
    const secondAuth = JSON.stringify({ tokens: { access_token: `${label}-second`, account_id: "second" } });
    writeFileSync(path.join(primaryHome, "auth.json"), firstAuth, { mode: 0o600 });
    writeFileSync(chatGPTSubscriptionAccountAuthPath(first.id, { homesDir }), firstAuth, { mode: 0o600 });
    writeFileSync(chatGPTSubscriptionAccountAuthPath(second.id, { homesDir }), secondAuth, { mode: 0o600 });
    const pool = readChatGPTAccountPoolState(filePath);
    pool.accounts[first.id].identity = { accountId: "first" };
    pool.accounts[second.id].identity = { accountId: "second" };
    writeChatGPTAccountPoolState(pool, filePath);
    const priorState = { version: 1, desired: first.id, active: first.id, pending: false, phase: "idle" };
    writeFileSync(switchPath, JSON.stringify(priorState), { mode: 0o600 });
    const firstCatalog = {};
    for (const [key, target] of Object.entries(catalog)) {
      firstCatalog[key] = JSON.stringify({ key, owner: "first", label });
      writeFileSync(target, firstCatalog[key], { mode: 0o600 });
    }
    const targetCatalogDir = chatGPTSubscriptionAccountCatalogDir(second.id, { homesDir });
    mkdirSync(targetCatalogDir, { recursive: true, mode: 0o700 });
    const targetNames = {
      modelsCachePath: "models_cache.json",
      nativeCatalogPath: "native-models.json",
      mergedCatalogPath: "merged-models.json",
      nativeAliasPath: "native-aliases.json",
      announcedModelsPath: "announced-models.json",
    };
    const secondCatalog = {};
    for (const [key, name] of Object.entries(targetNames)) {
      secondCatalog[key] = JSON.stringify({ key, owner: "second", label });
      writeFileSync(path.join(targetCatalogDir, name), secondCatalog[key], { mode: 0o600 });
    }
    const childSource = `
      import { requestChatGPTProfileSwitch } from ${JSON.stringify(moduleUrl)};
      await requestChatGPTProfileSwitch(${JSON.stringify(second.id)}, {
        filePath: ${JSON.stringify(filePath)}, homesDir: ${JSON.stringify(homesDir)},
        primaryHome: ${JSON.stringify(primaryHome)}, switchPath: ${JSON.stringify(switchPath)},
        platform: "darwin", processList: "", refreshCatalog: false,
        ${Object.entries(catalog).map(([key, value]) => `${key}: ${JSON.stringify(value)}`).join(",\n        ")},
        ${hook}: () => process.exit(87),
      });
    `;
    const crashed = spawnSync(process.execPath, ["--input-type=module", "-e", childSource], {
      cwd: path.resolve("."),
      encoding: "utf8",
    });
    assert.equal(crashed.status, 87, `${label}: ${crashed.stderr}`);
    assert.equal(existsSync(targetCommitted ? transactionDir : stagingDir), true, `${label}: missing crash evidence`);

    const options = {
      filePath,
      homesDir,
      primaryHome,
      switchPath,
      platform: "darwin",
      processList: "",
      refreshCatalog: false,
      ...catalog,
    };
    const recovered = await reconcileChatGPTProfileSwitchIfReady(options);
    const repeated = await reconcileChatGPTProfileSwitchIfReady(options);
    assert.equal(recovered.active, targetCommitted ? second.id : first.id, `${label}: wrong recovered account`);
    assert.equal(recovered.pending, false, `${label}: recovery remained pending`);
    assert.equal(repeated.active, recovered.active, `${label}: second recovery changed account`);
    assert.equal(repeated.pending, false, `${label}: second recovery became pending`);
    assert.equal(existsSync(transactionDir), false, `${label}: journal survived recovery`);
    assert.equal(existsSync(stagingDir), false, `${label}: staging survived recovery`);
    const expectedAuth = targetCommitted ? secondAuth : firstAuth;
    const expectedCatalog = targetCommitted ? secondCatalog : firstCatalog;
    assert.equal(readFileSync(path.join(primaryHome, "auth.json"), "utf8"), expectedAuth, `${label}: wrong auth after recovery`);
    for (const [key, contents] of Object.entries(expectedCatalog)) {
      assert.equal(readFileSync(catalog[key], "utf8"), contents, `${label}: wrong ${key} after recovery`);
    }

    const laterTarget = targetCommitted ? first.id : second.id;
    const later = await requestChatGPTProfileSwitch(laterTarget, options);
    assert.equal(later.active, laterTarget, `${label}: later switch failed`);
    assert.equal(later.pending, false, `${label}: later switch remained pending`);
    const laterAuth = targetCommitted ? firstAuth : secondAuth;
    const laterCatalog = targetCommitted ? firstCatalog : secondCatalog;
    assert.equal(readFileSync(path.join(primaryHome, "auth.json"), "utf8"), laterAuth, `${label}: later auth mismatch`);
    for (const [key, contents] of Object.entries(laterCatalog)) {
      assert.equal(readFileSync(catalog[key], "utf8"), contents, `${label}: later ${key} mismatch`);
    }
  }
});

test("malformed switch state retains durable rollback evidence and fails closed", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "codex-profile-corrupt-state-"));
  const switchPath = path.join(root, "switch.json");
  const transactionDirectory = path.join(root, "chatgpt-profile", "switch-transaction");
  const evidencePath = path.join(transactionDirectory, "primary-auth.json");
  mkdirSync(transactionDirectory, { recursive: true });
  writeFileSync(evidencePath, '{"tokens":{"account_id":"rollback-account"}}', { mode: 0o600 });
  writeFileSync(switchPath, '{"version":1,"phase":', { mode: 0o600 });

  await assert.rejects(
    requestChatGPTProfileSwitch("auto", { switchPath }),
    /could not be read as JSON/i,
  );
  assert.equal(existsSync(evidencePath), true);
  assert.equal(readFileSync(evidencePath, "utf8"), '{"tokens":{"account_id":"rollback-account"}}');

  writeFileSync(switchPath, JSON.stringify({
    version: 1,
    pending: true,
    phase: "future-phase",
  }), { mode: 0o600 });
  await assert.rejects(
    requestChatGPTProfileSwitch("auto", { switchPath }),
    /phase is invalid/i,
  );
  assert.equal(existsSync(evidencePath), true);
});

test("transaction cleanup preserves unexpected and non-private recovery evidence", async () => {
  for (const kind of ["unexpected", ...(process.platform === "win32" ? [] : ["non-private"])]) {
    const root = mkdtempSync(path.join(os.tmpdir(), `codex-profile-transaction-${kind}-`));
    const primaryHome = path.join(root, "primary");
    const switchPath = path.join(root, "switch.json");
    const transactionDir = path.join(root, "chatgpt-profile", "switch-transaction");
    mkdirSync(primaryHome, { recursive: true });
    mkdirSync(transactionDir, { recursive: true, mode: 0o700 });
    const auth = JSON.stringify({ tokens: { access_token: "active", account_id: "active" } });
    writeFileSync(path.join(primaryHome, "auth.json"), auth, { mode: 0o600 });
    writeFileSync(path.join(transactionDir, "primary-auth.json"), auth, { mode: 0o600 });
    const manifestPath = path.join(transactionDir, "manifest.json");
    writeFileSync(manifestPath, JSON.stringify({
      version: 2,
      active: "acct_active_12345678",
      target: "acct_target_12345678",
      activeAccountId: "active",
      targetAccountId: "target",
      catalogsEnabled: false,
    }), { mode: 0o600 });
    if (kind === "unexpected") {
      writeFileSync(path.join(transactionDir, "foreign.txt"), "retain", { mode: 0o600 });
    } else {
      chmodSync(manifestPath, 0o644);
    }
    writeFileSync(switchPath, JSON.stringify({
      version: 1,
      desired: "acct_target_12345678",
      active: "acct_active_12345678",
      pending: true,
      phase: "preparing",
    }), { mode: 0o600 });

    await assert.rejects(
      reconcileChatGPTProfileSwitch({
        filePath: path.join(root, "pool.json"),
        homesDir: path.join(root, "accounts"),
        primaryHome,
        switchPath,
        platform: "darwin",
        processList: "",
        refreshCatalog: false,
      }),
      /unexpected artifact|not private/,
    );
    assert.equal(existsSync(path.join(transactionDir, "primary-auth.json")), true);
    assert.equal(existsSync(manifestPath), true);
    if (kind === "unexpected") {
      assert.equal(readFileSync(path.join(transactionDir, "foreign.txt"), "utf8"), "retain");
    }
    assert.equal(readChatGPTProfileSwitchState(switchPath).phase, "preparing");
  }
});

test("profile detection fails closed across desktop process names", () => {
  assert.equal(codexDesktopRunning({ platform: "darwin", processList: "/Applications/ChatGPT.app/Contents/MacOS/ChatGPT" }), true);
  assert.equal(codexDesktopRunning({ platform: "darwin", processList: "/usr/bin/codex app-server" }), false);
  assert.equal(codexDesktopRunning({ platform: "win32", processList: '"Codex.exe","123","Console","1","42 K"' }), true);
  assert.equal(codexDesktopRunning({ platform: "win32", processList: '"codex-cli.exe","123","Console","1","42 K"' }), false);
  assert.equal(codexDesktopRunning({ platform: "linux", processList: "/opt/Codex-desktop --profile default" }), true);
  assert.equal(codexDesktopRunning({ platform: "linux", processList: "/usr/local/bin/codex app-server" }), true);
  assert.equal(codexDesktopRunning({ platform: "linux", processList: "/usr/local/bin/codex-router" }), false);
  assert.equal(codexDesktopRunning({ platform: "plan9", processList: "" }), true);
  assert.equal(codexDesktopRunning({ platform: "linux", processListReader: () => { throw new Error("ps unavailable"); } }), true);
});

test("profile switching rejects symlinked login files before mutating the active profile", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "codex-profile-symlink-"));
  const primaryHome = path.join(root, "primary");
  const homesDir = path.join(root, "accounts");
  const filePath = path.join(root, "pool.json");
  const switchPath = path.join(root, "switch.json");
  mkdirSync(primaryHome, { recursive: true });
  const first = createChatGPTSubscriptionAccount({ filePath, homesDir });
  const second = createChatGPTSubscriptionAccount({ filePath, homesDir });
  const firstAuth = JSON.stringify({ tokens: { access_token: "first-token", account_id: "first" } });
  const secondAuth = path.join(root, "second-auth.json");
  writeFileSync(path.join(primaryHome, "auth.json"), firstAuth, { mode: 0o600 });
  writeFileSync(chatGPTSubscriptionAccountAuthPath(first.id, { homesDir }), firstAuth, { mode: 0o600 });
  writeFileSync(secondAuth, JSON.stringify({ tokens: { access_token: "second-token", account_id: "second" } }), { mode: 0o600 });
  symlinkSync(secondAuth, chatGPTSubscriptionAccountAuthPath(second.id, { homesDir }));
  await assert.rejects(
    requestChatGPTProfileSwitch(second.id, { filePath, homesDir, primaryHome, switchPath, platform: "darwin", processList: "", refreshCatalog: false }),
    /unavailable|symbolic-link/i,
  );
  assert.equal(readFileSync(path.join(primaryHome, "auth.json"), "utf8"), firstAuth);
  assert.equal(readChatGPTProfileSwitchState(switchPath).active, first.id);
});

test("a catalog refresh failure restores the previous auth and catalog atomically", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "codex-profile-rollback-"));
  const primaryHome = path.join(root, "primary");
  const homesDir = path.join(root, "accounts");
  const filePath = path.join(root, "pool.json");
  const switchPath = path.join(root, "switch.json");
  const modelsCachePath = path.join(root, "models_cache.json");
  mkdirSync(primaryHome, { recursive: true });
  const first = createChatGPTSubscriptionAccount({ filePath, homesDir });
  const second = createChatGPTSubscriptionAccount({ filePath, homesDir });
  const firstAuth = JSON.stringify({ tokens: { access_token: "first-token", account_id: "first" } });
  const secondAuth = JSON.stringify({ tokens: { access_token: "second-token", account_id: "second" } });
  writeFileSync(path.join(primaryHome, "auth.json"), firstAuth, { mode: 0o600 });
  writeFileSync(chatGPTSubscriptionAccountAuthPath(first.id, { homesDir }), firstAuth, { mode: 0o600 });
  writeFileSync(chatGPTSubscriptionAccountAuthPath(second.id, { homesDir }), secondAuth, { mode: 0o600 });
  writeFileSync(modelsCachePath, '{"account":"first"}', { mode: 0o600 });
  const firstCatalog = path.join(chatGPTSubscriptionAccountCatalogDir(first.id, { homesDir }), "models_cache.json");
  mkdirSync(path.dirname(firstCatalog), { recursive: true });
  writeFileSync(firstCatalog, '{"account":"first"}', { mode: 0o600 });
  const secondCatalog = path.join(chatGPTSubscriptionAccountCatalogDir(second.id, { homesDir }), "models_cache.json");
  mkdirSync(path.dirname(secondCatalog), { recursive: true });
  writeFileSync(secondCatalog, '{"account":"second"}', { mode: 0o600 });
  await assert.rejects(
    requestChatGPTProfileSwitch(second.id, {
      filePath, homesDir, primaryHome, switchPath, platform: "darwin", processList: "", modelsCachePath,
      refreshCatalog: () => { throw new Error("simulated catalog crash"); },
    }),
    /simulated catalog crash/,
  );
  assert.equal(readFileSync(path.join(primaryHome, "auth.json"), "utf8"), firstAuth);
  assert.equal(readFileSync(modelsCachePath, "utf8"), '{"account":"first"}');
  assert.equal(readChatGPTProfileSwitchState(switchPath).active, first.id);
  assert.equal(readChatGPTProfileSwitchState(switchPath).pending, true);
});

test("a failed profile rollback cannot overwrite a queued catalog publication", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "codex-profile-publication-lock-"));
  const primaryHome = path.join(root, "primary");
  const homesDir = path.join(root, "accounts");
  const filePath = path.join(root, "pool.json");
  const switchPath = path.join(root, "switch.json");
  const catalog = Object.fromEntries([
    ["modelsCachePath", path.join(root, "models_cache.json")],
    ["nativeCatalogPath", path.join(root, "native-models.json")],
    ["mergedCatalogPath", path.join(root, "merged-models.json")],
    ["nativeAliasPath", path.join(root, "native-aliases.json")],
    ["announcedModelsPath", path.join(root, "announced-models.json")],
  ]);
  mkdirSync(primaryHome, { recursive: true });
  const first = createChatGPTSubscriptionAccount({ filePath, homesDir });
  const second = createChatGPTSubscriptionAccount({ filePath, homesDir });
  const firstAuth = JSON.stringify({ tokens: { access_token: "first-token", account_id: "first" } });
  const secondAuth = JSON.stringify({ tokens: { access_token: "second-token", account_id: "second" } });
  writeFileSync(path.join(primaryHome, "auth.json"), firstAuth, { mode: 0o600 });
  writeFileSync(chatGPTSubscriptionAccountAuthPath(first.id, { homesDir }), firstAuth, { mode: 0o600 });
  writeFileSync(chatGPTSubscriptionAccountAuthPath(second.id, { homesDir }), secondAuth, { mode: 0o600 });
  for (const target of Object.values(catalog)) {
    writeFileSync(target, JSON.stringify({ publisher: "before-switch" }), { mode: 0o600 });
  }

  let markRefreshStarted;
  let releaseRefresh;
  const refreshStarted = new Promise((resolve) => { markRefreshStarted = resolve; });
  const refreshRelease = new Promise((resolve) => { releaseRefresh = resolve; });
  const switching = requestChatGPTProfileSwitch(second.id, {
    filePath,
    homesDir,
    primaryHome,
    switchPath,
    catalogLockStateDir: root,
    platform: "darwin",
    processList: "",
    ...catalog,
    refreshCatalog: async () => {
      writeFileSync(catalog.mergedCatalogPath, JSON.stringify({ publisher: "switch" }), { mode: 0o600 });
      markRefreshStarted();
      await refreshRelease;
      throw new Error("forced profile publication failure");
    },
  });
  await refreshStarted;

  await assert.rejects(
    withCatalogPublicationLock(
      async () => assert.fail("the profile switch must still own catalog publication"),
      { stateDir: root, waitMs: 0, retryMs: 20 },
    ),
    (error) => error?.code === "catalog_publication_locked",
  );

  let markQueuedPublisherStarted;
  const queuedPublisherStartedLatch = new Promise((resolve) => {
    markQueuedPublisherStarted = resolve;
  });
  const queuedPublication = withCatalogPublicationLock(async () => {
    markQueuedPublisherStarted();
    writeFileSync(catalog.mergedCatalogPath, JSON.stringify({ publisher: "provider" }), { mode: 0o600 });
  }, { stateDir: root, waitMs: 60_000, retryMs: 20 });

  releaseRefresh();
  await assert.rejects(switching, /forced profile publication failure/);
  await queuedPublisherStartedLatch;
  await queuedPublication;
  assert.deepEqual(JSON.parse(readFileSync(catalog.mergedCatalogPath, "utf8")), { publisher: "provider" });
  assert.equal(readFileSync(path.join(primaryHome, "auth.json"), "utf8"), firstAuth);
});

test("concurrent account switches serialize without producing a torn auth file", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "codex-profile-concurrent-"));
  const primaryHome = path.join(root, "primary");
  const homesDir = path.join(root, "accounts");
  const filePath = path.join(root, "pool.json");
  const switchPath = path.join(root, "switch.json");
  mkdirSync(primaryHome, { recursive: true });
  const first = createChatGPTSubscriptionAccount({ filePath, homesDir });
  const second = createChatGPTSubscriptionAccount({ filePath, homesDir });
  const firstAuth = JSON.stringify({ tokens: { access_token: "first-token", account_id: "first" } });
  const secondAuth = JSON.stringify({ tokens: { access_token: "second-token", account_id: "second" } });
  writeFileSync(path.join(primaryHome, "auth.json"), firstAuth, { mode: 0o600 });
  writeFileSync(chatGPTSubscriptionAccountAuthPath(first.id, { homesDir }), firstAuth, { mode: 0o600 });
  writeFileSync(chatGPTSubscriptionAccountAuthPath(second.id, { homesDir }), secondAuth, { mode: 0o600 });
  const options = { filePath, homesDir, primaryHome, switchPath, platform: "darwin", processList: "", refreshCatalog: false };
  await Promise.all([requestChatGPTProfileSwitch(second.id, options), requestChatGPTProfileSwitch(first.id, options)]);
  const active = readFileSync(path.join(primaryHome, "auth.json"), "utf8");
  assert.ok(active === firstAuth || active === secondAuth);
  assert.equal(readChatGPTProfileSwitchState(switchPath).pending, false);
});

test("switching accounts restores each native catalog without losing routed models", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "codex-profile-catalog-"));
  const primaryHome = path.join(root, "primary");
  const homesDir = path.join(root, "accounts");
  const filePath = path.join(root, "pool.json");
  const switchPath = path.join(root, "switch.json");
  const catalog = Object.fromEntries([
    ["modelsCachePath", path.join(root, "models_cache.json")],
    ["nativeCatalogPath", path.join(root, "native-models.json")],
    ["mergedCatalogPath", path.join(root, "merged-models.json")],
    ["nativeAliasPath", path.join(root, "native-aliases.json")],
    ["announcedModelsPath", path.join(root, "announced-models.json")],
  ]);
  mkdirSync(primaryHome, { recursive: true });
  const first = createChatGPTSubscriptionAccount({ filePath, homesDir });
  const second = createChatGPTSubscriptionAccount({ filePath, homesDir });
  const firstAuth = JSON.stringify({ tokens: { access_token: "first-token", account_id: "first" } });
  const secondAuth = JSON.stringify({ tokens: { access_token: "second-token", account_id: "second" } });
  writeFileSync(path.join(primaryHome, "auth.json"), firstAuth, { mode: 0o600 });
  writeFileSync(chatGPTSubscriptionAccountAuthPath(first.id, { homesDir }), firstAuth, { mode: 0o600 });
  writeFileSync(chatGPTSubscriptionAccountAuthPath(second.id, { homesDir }), secondAuth, { mode: 0o600 });

  const firstFiles = {
    modelsCachePath: JSON.stringify({ account: "first", models: ["gpt-free"] }),
    nativeCatalogPath: JSON.stringify({ account: "first", models: [{ slug: "gpt-free", visibility: "list" }] }),
    mergedCatalogPath: JSON.stringify({ account: "first", models: ["gpt-free", "opencode-go/deepseek-v4-flash"] }),
  };
  for (const [key, contents] of Object.entries(firstFiles)) writeFileSync(catalog[key], contents, { mode: 0o600 });
  const secondDir = chatGPTSubscriptionAccountCatalogDir(second.id, { homesDir });
  mkdirSync(secondDir, { recursive: true, mode: 0o700 });
  const secondFiles = {
    "models_cache.json": JSON.stringify({ account: "second", models: ["gpt-plus"] }),
    "native-models.json": JSON.stringify({ account: "second", models: [{ slug: "gpt-plus", visibility: "list" }] }),
    "merged-models.json": JSON.stringify({ account: "second", models: ["gpt-plus", "opencode-go/deepseek-v4-flash"] }),
  };
  for (const [name, contents] of Object.entries(secondFiles)) writeFileSync(path.join(secondDir, name), contents, { mode: 0o600 });

  const options = {
    filePath,
    homesDir,
    primaryHome,
    switchPath,
    platform: "darwin",
    processList: "",
    refreshCatalog: false,
    ...catalog,
  };
  const applied = await requestChatGPTProfileSwitch(second.id, options);
  assert.equal(applied.active, second.id);
  assert.equal(readFileSync(path.join(primaryHome, "auth.json"), "utf8"), secondAuth);
  assert.equal(readFileSync(catalog.modelsCachePath, "utf8"), secondFiles["models_cache.json"]);
  assert.equal(readFileSync(catalog.nativeCatalogPath, "utf8"), secondFiles["native-models.json"]);
  assert.equal(readFileSync(catalog.mergedCatalogPath, "utf8"), secondFiles["merged-models.json"]);

  await requestChatGPTProfileSwitch(first.id, options);
  assert.equal(readFileSync(path.join(primaryHome, "auth.json"), "utf8"), firstAuth);
  assert.equal(readFileSync(catalog.modelsCachePath, "utf8"), firstFiles.modelsCachePath);
  assert.equal(readFileSync(catalog.nativeCatalogPath, "utf8"), firstFiles.nativeCatalogPath);
  assert.equal(readFileSync(catalog.mergedCatalogPath, "utf8"), firstFiles.mergedCatalogPath);
  assert.equal(readFileSync(path.join(secondDir, "native-models.json"), "utf8"), secondFiles["native-models.json"]);
});

test("an interrupted switch rolls back durable auth and catalog before retrying", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "codex-profile-crash-"));
  const primaryHome = path.join(root, "primary");
  const homesDir = path.join(root, "accounts");
  const filePath = path.join(root, "pool.json");
  const switchPath = path.join(root, "switch.json");
  const modelsCachePath = path.join(root, "models_cache.json");
  mkdirSync(primaryHome, { recursive: true });
  const first = createChatGPTSubscriptionAccount({ filePath, homesDir });
  const second = createChatGPTSubscriptionAccount({ filePath, homesDir });
  const firstAuth = JSON.stringify({ tokens: { access_token: "first-token", account_id: "first" } });
  const secondAuth = JSON.stringify({ tokens: { access_token: "second-token", account_id: "second" } });
  writeFileSync(path.join(primaryHome, "auth.json"), firstAuth, { mode: 0o600 });
  writeFileSync(chatGPTSubscriptionAccountAuthPath(first.id, { homesDir }), firstAuth, { mode: 0o600 });
  writeFileSync(chatGPTSubscriptionAccountAuthPath(second.id, { homesDir }), secondAuth, { mode: 0o600 });
  writeFileSync(modelsCachePath, JSON.stringify({ account: "first" }), { mode: 0o600 });
  const firstCatalog = chatGPTSubscriptionAccountCatalogDir(first.id, { homesDir });
  const secondCatalog = chatGPTSubscriptionAccountCatalogDir(second.id, { homesDir });
  mkdirSync(firstCatalog, { recursive: true, mode: 0o700 });
  mkdirSync(secondCatalog, { recursive: true, mode: 0o700 });
  writeFileSync(path.join(firstCatalog, "models_cache.json"), JSON.stringify({ account: "first" }), { mode: 0o600 });
  writeFileSync(path.join(secondCatalog, "models_cache.json"), JSON.stringify({ account: "second" }), { mode: 0o600 });

  const modulePath = path.resolve("src/chatgpt-profile-switch.mjs");
  const childSource = `
    import { requestChatGPTProfileSwitch } from ${JSON.stringify(pathToFileURL(modulePath).href)};
    await requestChatGPTProfileSwitch(${JSON.stringify(second.id)}, {
      filePath: ${JSON.stringify(filePath)}, homesDir: ${JSON.stringify(homesDir)},
      primaryHome: ${JSON.stringify(primaryHome)}, switchPath: ${JSON.stringify(switchPath)},
      platform: "darwin", processList: "", modelsCachePath: ${JSON.stringify(modelsCachePath)},
      staleMs: 2000, waitMs: 5000,
      refreshCatalog: () => process.kill(process.pid, "SIGKILL"),
    });
  `;
 const crashed = spawnSync(process.execPath, ["--input-type=module", "-e", childSource], {
   cwd: path.resolve("."),
   encoding: "utf8",
 });
  if (process.platform === "win32") {
    assert.ok(crashed.status !== 0 || crashed.signal !== null);
  } else {
    assert.equal(crashed.signal, "SIGKILL");
  }
 const interrupted = readChatGPTProfileSwitchState(switchPath);
  assert.equal(interrupted.phase, "backed-up");
  assert.equal(interrupted.pending, true);
  assert.equal(readFileSync(path.join(primaryHome, "auth.json"), "utf8"), secondAuth);
  assert.equal(JSON.parse(readFileSync(modelsCachePath, "utf8")).account, "second");

  const applied = await reconcileChatGPTProfileSwitch({
    filePath,
    homesDir,
    primaryHome,
    switchPath,
    platform: "darwin",
    processList: "",
    modelsCachePath,
    staleMs: 2000,
    waitMs: 5000,
    refreshCatalog: () => {},
  });
  assert.equal(applied.active, second.id);
  assert.equal(applied.pending, false);
  assert.equal(readFileSync(path.join(primaryHome, "auth.json"), "utf8"), secondAuth);
  assert.equal(JSON.parse(readFileSync(modelsCachePath, "utf8")).account, "second");
});

test("production reconcile hook completes an installed transaction after restart", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "codex-profile-installed-recovery-"));
  const primaryHome = path.join(root, "primary");
  const homesDir = path.join(root, "accounts");
  const filePath = path.join(root, "pool.json");
  const switchPath = path.join(root, "switch.json");
  const transactionDir = path.join(root, "chatgpt-profile", "switch-transaction");
  mkdirSync(primaryHome, { recursive: true });
  const first = createChatGPTSubscriptionAccount({ filePath, homesDir });
  const second = createChatGPTSubscriptionAccount({ filePath, homesDir });
  const firstAuth = JSON.stringify({ tokens: { access_token: "first-token", account_id: "first" } });
  const secondAuth = JSON.stringify({ tokens: { access_token: "second-token", account_id: "second" } });
  writeFileSync(path.join(primaryHome, "auth.json"), secondAuth, { mode: 0o600 });
  writeFileSync(chatGPTSubscriptionAccountAuthPath(first.id, { homesDir }), firstAuth, { mode: 0o600 });
  writeFileSync(chatGPTSubscriptionAccountAuthPath(second.id, { homesDir }), secondAuth, { mode: 0o600 });
  mkdirSync(transactionDir, { recursive: true, mode: 0o700 });
  writeFileSync(path.join(transactionDir, "primary-auth.json"), firstAuth, { mode: 0o600 });
  writeFileSync(path.join(transactionDir, "manifest.json"), JSON.stringify({
    version: 2,
    active: first.id,
    target: second.id,
    activeAccountId: "first",
    targetAccountId: "second",
    catalogsEnabled: false,
  }), { mode: 0o600 });
  writeFileSync(switchPath, JSON.stringify({
    version: 1,
    desired: second.id,
    active: second.id,
    pending: false,
    phase: "installed",
  }), { mode: 0o600 });

  const stillInstalled = await reconcileChatGPTProfileSwitchIfReady({
    filePath,
    homesDir,
    primaryHome,
    switchPath,
    platform: "darwin",
    processList: "/Applications/ChatGPT.app/Contents/MacOS/ChatGPT",
    refreshCatalog: false,
  });
  assert.equal(stillInstalled.phase, "installed");
  assert.equal(existsSync(transactionDir), true);

  const recovered = await reconcileChatGPTProfileSwitchIfReady({
    filePath,
    homesDir,
    primaryHome,
    switchPath,
    platform: "darwin",
    processList: "",
    refreshCatalog: false,
  });
  assert.equal(recovered.active, second.id);
  assert.equal(recovered.pending, false);
  assert.equal(recovered.phase, "idle");
  assert.equal(readFileSync(path.join(primaryHome, "auth.json"), "utf8"), secondAuth);
  assert.equal(existsSync(transactionDir), false);
});

test("malformed durable catalog snapshots fail closed without deleting global artifacts", async () => {
  for (const [label, manifestVersion, manifestSnapshot] of [
    ["legacy-partial-v1", 1, { modelsCachePath: "legacy" }],
    ["missing", 2, undefined],
    ["partial", 2, { modelsCachePath: "only-one-artifact" }],
    ["malformed", 2, {
      modelsCachePath: { account: "not-serialized" },
      nativeCatalogPath: null,
      mergedCatalogPath: null,
      nativeAliasPath: null,
      announcedModelsPath: null,
    }],
  ]) {
    const root = mkdtempSync(path.join(os.tmpdir(), `codex-profile-${label}-snapshot-`));
    const primaryHome = path.join(root, "primary");
    const switchPath = path.join(root, "switch.json");
    const transactionDir = path.join(root, "chatgpt-profile", "switch-transaction");
    const catalog = {
      modelsCachePath: path.join(root, "models_cache.json"),
      nativeCatalogPath: path.join(root, "native-models.json"),
      mergedCatalogPath: path.join(root, "merged-models.json"),
      nativeAliasPath: path.join(root, "native-aliases.json"),
      announcedModelsPath: path.join(root, "announced-models.json"),
    };
    mkdirSync(primaryHome, { recursive: true });
    mkdirSync(transactionDir, { recursive: true, mode: 0o700 });
    const activeAuth = JSON.stringify({ tokens: { access_token: "active-token", account_id: "active" } });
    writeFileSync(path.join(primaryHome, "auth.json"), activeAuth, { mode: 0o600 });
    writeFileSync(path.join(transactionDir, "primary-auth.json"), activeAuth, { mode: 0o600 });
    const manifest = {
      version: manifestVersion,
      active: "acct_active_12345678",
      target: "acct_target_12345678",
      activeAccountId: "active",
      targetAccountId: "target",
      catalogsEnabled: true,
      ...(manifestSnapshot === undefined ? {} : { globalCatalogSnapshot: manifestSnapshot }),
    };
    writeFileSync(path.join(transactionDir, "manifest.json"), JSON.stringify(manifest), { mode: 0o600 });
    writeFileSync(switchPath, JSON.stringify({
      version: 1,
      desired: manifest.target,
      active: manifest.active,
      pending: true,
      phase: "backed-up",
    }), { mode: 0o600 });
    const catalogContents = Object.fromEntries(Object.entries(catalog).map(([key, filePath]) => {
      const contents = JSON.stringify({ key, label, retained: true });
      writeFileSync(filePath, contents, { mode: 0o600 });
      return [filePath, contents];
    }));

    await assert.rejects(
      reconcileChatGPTProfileSwitch({
        switchPath,
        primaryHome,
        filePath: path.join(root, "pool.json"),
        homesDir: path.join(root, "accounts"),
        platform: "darwin",
        processList: "",
        ...catalog,
      }),
      /transaction manifest is invalid|catalog snapshot is invalid/i,
    );
    for (const [filePath, contents] of Object.entries(catalogContents)) {
      assert.equal(readFileSync(filePath, "utf8"), contents, `${label} snapshot changed ${path.basename(filePath)}`);
    }
    assert.equal(existsSync(path.join(transactionDir, "manifest.json")), true);
    assert.equal(existsSync(path.join(transactionDir, "primary-auth.json")), true);
    assert.equal(readChatGPTProfileSwitchState(switchPath).phase, "backed-up");
  }
});

test("a complete v2 durable snapshot restores every encoded catalog artifact", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "codex-profile-complete-snapshot-"));
  const primaryHome = path.join(root, "primary");
  const homesDir = path.join(root, "accounts");
  const filePath = path.join(root, "pool.json");
  const switchPath = path.join(root, "switch.json");
  const transactionDir = path.join(root, "chatgpt-profile", "switch-transaction");
  const catalog = {
    modelsCachePath: path.join(root, "models_cache.json"),
    nativeCatalogPath: path.join(root, "native-models.json"),
    mergedCatalogPath: path.join(root, "merged-models.json"),
    nativeAliasPath: path.join(root, "native-aliases.json"),
    announcedModelsPath: path.join(root, "announced-models.json"),
  };
  mkdirSync(primaryHome, { recursive: true });
  const active = createChatGPTSubscriptionAccount({ filePath, homesDir });
  const target = createChatGPTSubscriptionAccount({ filePath, homesDir });
  const activeAuth = JSON.stringify({ tokens: { access_token: "active-token", account_id: "active" } });
  const targetAuth = JSON.stringify({ tokens: { access_token: "target-token", account_id: "target" } });
  writeFileSync(path.join(primaryHome, "auth.json"), targetAuth, { mode: 0o600 });
  writeFileSync(chatGPTSubscriptionAccountAuthPath(active.id, { homesDir }), activeAuth, { mode: 0o600 });
  writeFileSync(chatGPTSubscriptionAccountAuthPath(target.id, { homesDir }), targetAuth, { mode: 0o600 });
  mkdirSync(transactionDir, { recursive: true, mode: 0o700 });
  writeFileSync(path.join(transactionDir, "primary-auth.json"), activeAuth, { mode: 0o600 });
  const snapshot = {
    modelsCachePath: JSON.stringify({ restored: "models" }),
    nativeCatalogPath: JSON.stringify({ restored: "native" }),
    mergedCatalogPath: JSON.stringify({ restored: "merged" }),
    nativeAliasPath: JSON.stringify({ restored: "aliases" }),
    announcedModelsPath: null,
  };
  writeFileSync(path.join(transactionDir, "manifest.json"), JSON.stringify({
    version: 2,
    active: active.id,
    target: target.id,
    activeAccountId: "active",
    targetAccountId: "target",
    catalogsEnabled: true,
    globalCatalogSnapshot: snapshot,
  }), { mode: 0o600 });
  writeFileSync(switchPath, JSON.stringify({
    version: 1,
    desired: target.id,
    active: active.id,
    pending: true,
    phase: "backed-up",
  }), { mode: 0o600 });
  for (const filePathValue of Object.values(catalog)) {
    writeFileSync(filePathValue, JSON.stringify({ crash: true }), { mode: 0o600 });
  }

  const recovered = await reconcileChatGPTProfileSwitch({
    filePath,
    homesDir,
    primaryHome,
    switchPath,
    platform: "darwin",
    processList: "/Applications/Codex.app/Contents/MacOS/Codex",
    ...catalog,
  });
  assert.equal(recovered.active, active.id);
  assert.equal(recovered.pending, true);
  assert.equal(readFileSync(path.join(primaryHome, "auth.json"), "utf8"), activeAuth);
  for (const [key, contents] of Object.entries(snapshot)) {
    if (contents === null) assert.equal(existsSync(catalog[key]), false);
    else assert.equal(readFileSync(catalog[key], "utf8"), contents);
  }
  assert.equal(existsSync(transactionDir), false);
});

test("settled production reconcile reads do not wait on account or catalog locks", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "codex-profile-settled-read-"));
  const filePath = path.join(root, "pool.json");
  const switchPath = path.join(root, "switch.json");
  let releaseHolder;
  let markHeld;
  const held = new Promise((resolve) => { markHeld = resolve; });
  const release = new Promise((resolve) => { releaseHolder = resolve; });
  const holder = withChatGPTAccountPoolLock(async () => {
    markHeld();
    await release;
  }, { filePath, waitMs: 5_000, retryMs: 20 });
  await held;
  try {
    const state = await Promise.race([
      reconcileChatGPTProfileSwitchIfReady({
        filePath,
        switchPath,
        platform: "darwin",
        processList: "",
        catalogLockStateDir: root,
        refreshCatalog: false,
      }),
      new Promise((_, reject) => setTimeout(
        () => reject(new Error("settled reconcile attempted to acquire a mutation lock")),
        250,
      )),
    ]);
    assert.equal(state.pending, false);
    assert.equal(state.phase, "idle");
  } finally {
    releaseHolder();
    await holder;
  }
});

test("cross-process account selections commit one matching policy and profile", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "codex-profile-policy-concurrent-"));
  const primaryHome = path.join(root, "primary");
  const homesDir = path.join(root, "accounts");
  const filePath = path.join(root, "pool.json");
  const switchPath = path.join(root, "switch.json");
  mkdirSync(primaryHome, { recursive: true });
  const first = createChatGPTSubscriptionAccount({ filePath, homesDir });
  const second = createChatGPTSubscriptionAccount({ filePath, homesDir });
  const firstAuth = JSON.stringify({ tokens: { access_token: "first-token", account_id: "first" } });
  const secondAuth = JSON.stringify({ tokens: { access_token: "second-token", account_id: "second" } });
  writeFileSync(path.join(primaryHome, "auth.json"), firstAuth, { mode: 0o600 });
  writeFileSync(chatGPTSubscriptionAccountAuthPath(first.id, { homesDir }), firstAuth, { mode: 0o600 });
  writeFileSync(chatGPTSubscriptionAccountAuthPath(second.id, { homesDir }), secondAuth, { mode: 0o600 });
  const modulePath = pathToFileURL(path.resolve("src/chatgpt-profile-switch.mjs")).href;
  const options = { filePath, homesDir, primaryHome, switchPath, platform: "darwin", processList: "", refreshCatalog: false };
  const childSource = (selection) => `
    import { selectChatGPTProfileAccount } from ${JSON.stringify(modulePath)};
    await selectChatGPTProfileAccount(${JSON.stringify(selection)}, ${JSON.stringify(options)});
  `;
  await Promise.all([
    runModuleChild(childSource(second.id)),
    runModuleChild(childSource(first.id)),
  ]);
  const pool = readChatGPTAccountPoolState(filePath);
  const profile = readChatGPTProfileSwitchState(switchPath);
  assert.equal(profile.pending, false);
  assert.equal(pool.policy.selectedAccountId, profile.active);
  assert.equal(profile.desired, profile.active);
  const activeIdentity = JSON.parse(readFileSync(path.join(primaryHome, "auth.json"), "utf8")).tokens.account_id;
  assert.equal(activeIdentity, profile.active === first.id ? "first" : "second");
});

test("a policy commit failure rolls the native profile back to its prior account", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "codex-profile-policy-rollback-"));
  const primaryHome = path.join(root, "primary");
  const homesDir = path.join(root, "accounts");
  const filePath = path.join(root, "pool.json");
  const switchPath = path.join(root, "switch.json");
  mkdirSync(primaryHome, { recursive: true });
  const first = createChatGPTSubscriptionAccount({ filePath, homesDir });
  const second = createChatGPTSubscriptionAccount({ filePath, homesDir });
  const firstAuth = JSON.stringify({ tokens: { access_token: "first-token", account_id: "first" } });
  const secondAuth = JSON.stringify({ tokens: { access_token: "second-token", account_id: "second" } });
  writeFileSync(path.join(primaryHome, "auth.json"), firstAuth, { mode: 0o600 });
  writeFileSync(chatGPTSubscriptionAccountAuthPath(first.id, { homesDir }), firstAuth, { mode: 0o600 });
  writeFileSync(chatGPTSubscriptionAccountAuthPath(second.id, { homesDir }), secondAuth, { mode: 0o600 });
  const options = { filePath, homesDir, primaryHome, switchPath, platform: "darwin", processList: "", refreshCatalog: false };
  await requestChatGPTProfileSwitch(first.id, options);
  const initialPool = readChatGPTAccountPoolState(filePath);
  initialPool.policy.selectedAccountId = first.id;
  writeChatGPTAccountPoolState(initialPool, filePath);
  await assert.rejects(
    selectChatGPTProfileAccount(second.id, {
      ...options,
      writeAccountPoolState: () => { throw new Error("simulated policy write failure"); },
    }),
    /simulated policy write failure/,
  );
  assert.equal(readChatGPTAccountPoolState(filePath).policy.selectedAccountId, first.id);
  assert.equal(readChatGPTProfileSwitchState(switchPath).active, first.id);
  assert.equal(readChatGPTProfileSwitchState(switchPath).desired, first.id);
  assert.equal(readFileSync(path.join(primaryHome, "auth.json"), "utf8"), firstAuth);
});

test("a removal failure rolls back the required active-profile handoff", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "codex-profile-remove-rollback-"));
  const primaryHome = path.join(root, "primary");
  const homesDir = path.join(root, "accounts");
  const filePath = path.join(root, "pool.json");
  const switchPath = path.join(root, "switch.json");
  mkdirSync(primaryHome, { recursive: true });
  const first = createChatGPTSubscriptionAccount({ filePath, homesDir });
  const second = createChatGPTSubscriptionAccount({ filePath, homesDir });
  const firstAuth = JSON.stringify({ tokens: { access_token: "first-token", account_id: "first" } });
  const secondAuth = JSON.stringify({ tokens: { access_token: "second-token", account_id: "second" } });
  writeFileSync(path.join(primaryHome, "auth.json"), firstAuth, { mode: 0o600 });
  writeFileSync(chatGPTSubscriptionAccountAuthPath(first.id, { homesDir }), firstAuth, { mode: 0o600 });
  writeFileSync(chatGPTSubscriptionAccountAuthPath(second.id, { homesDir }), secondAuth, { mode: 0o600 });
  const options = { filePath, homesDir, primaryHome, switchPath, platform: "darwin", processList: "", refreshCatalog: false };
  await requestChatGPTProfileSwitch(first.id, options);
  const initialPool = readChatGPTAccountPoolState(filePath);
  initialPool.policy.selectedAccountId = first.id;
  writeChatGPTAccountPoolState(initialPool, filePath);
  await assert.rejects(
    removeChatGPTProfileAccount(first.id, {
      ...options,
      removeAccount: () => { throw new Error("simulated account removal failure"); },
    }),
    /simulated account removal failure/,
  );
  assert.ok(readChatGPTAccountPoolState(filePath).accounts[first.id]);
  assert.equal(readChatGPTAccountPoolState(filePath).policy.selectedAccountId, first.id);
  assert.equal(readChatGPTProfileSwitchState(switchPath).active, first.id);
  assert.equal(readFileSync(path.join(primaryHome, "auth.json"), "utf8"), firstAuth);
});
