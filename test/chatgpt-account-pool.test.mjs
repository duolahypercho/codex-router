import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const root = mkdtempSync(path.join(os.tmpdir(), "codex-router-chatgpt-account-pool-"));
const statePath = path.join(root, "chatgpt-account-pool.json");
const NOW = Date.parse("2026-08-24T00:00:00.000Z");

const {
  readChatGPTAccountPoolState,
  chatGPTSubscriptionAccountAuthPath,
  chatGPTSubscriptionAccountPoolSnapshot,
  chatGPTSubscriptionPoolHeaders,
  createChatGPTSubscriptionAccount,
  removeChatGPTSubscriptionAccount,
  recordChatGPTAccountOutcome,
  refreshChatGPTSubscriptionAccount,
  releaseChatGPTAccountSession,
  sanitizeChatGPTAccountPool,
  selectChatGPTAccount,
  withChatGPTAccountPoolLock,
  writeChatGPTAccountPoolState,
} = await import("../src/chatgpt-account-pool.mjs");

const account = (id, patch = {}) => ({
  id,
  state: "active",
  ...patch,
});

const ACCOUNTS = [
  account("acct_primary_123456", { priority: 100 }),
  account("acct_backup_123456", { priority: 50 }),
];

test.after(() => rmSync(root, { recursive: true, force: true }));

test("pool is disabled by default and leaves the native account path untouched", () => {
  const result = selectChatGPTAccount(ACCOUNTS, { filePath: statePath, now: NOW });
  assert.equal(result.enabled, false);
  assert.equal(result.accountId, null);
});

test("quota strategy prefers the account with the most remaining quota", () => {
  const result = selectChatGPTAccount([
    account("acct_lowquota_123456", { quota: { windows: [{ limit: 100, remaining: 20 }] } }),
    account("acct_highquota_123456", { quota: { windows: [{ limit: 100, remaining: 80 }] } }),
  ], {
    filePath: path.join(root, "quota.json"),
    policy: { enabled: true },
    now: NOW,
  });
  assert.equal(result.accountId, "acct_highquota_123456");
});

test("manual selection pins the requested active account", () => {
  const result = selectChatGPTAccount(ACCOUNTS, {
    filePath: path.join(root, "manual-selection.json"),
    policy: { enabled: true, selectedAccountId: "acct_backup_123456" },
    now: NOW,
  });
  assert.equal(result.accountId, "acct_backup_123456");
});

test("pool mode keeps the selected login as the runtime account and routes an alternate", () => {
  const filePath = path.join(root, "pool-mode.json");
  const homesDir = path.join(root, "pool-mode-homes");
  const first = createChatGPTSubscriptionAccount({ filePath, homesDir, now: NOW });
  const second = createChatGPTSubscriptionAccount({ filePath, homesDir, now: NOW });
  const payload = Buffer.from(JSON.stringify({ exp: Math.floor((NOW + 3_600_000) / 1000) })).toString("base64url");
  for (const [accountId, token, externalId] of [[first.id, "first", "first-account"], [second.id, "second", "second-account"]]) {
    const authPath = chatGPTSubscriptionAccountAuthPath(accountId, { homesDir });
    writeFileSync(authPath, JSON.stringify({ tokens: { access_token: `${token}.${payload}.sig`, account_id: externalId } }), { mode: 0o600 });
  }
  const state = readChatGPTAccountPoolState(filePath);
  state.policy.enabled = true;
  state.policy.mode = "pool";
  state.policy.selectedAccountId = first.id;
  writeChatGPTAccountPoolState(state, filePath);
  const headers = chatGPTSubscriptionPoolHeaders({ filePath, homesDir, now: NOW, sessionId: "pool-mode-thread" });
  assert.equal(headers.accountId, second.id);
  assert.match(headers.authorization, /^Bearer second\./);
});

test("expired quota windows do not permanently strand an account", () => {
  const result = selectChatGPTAccount([
    account("acct_expired_123456", { quota: { windows: [{ limit: 100, remaining: 0, resetAt: "2026-08-23T23:00:00Z" }] } }),
  ], {
    filePath: path.join(root, "expiry.json"),
    policy: { enabled: true },
    now: NOW,
  });
  assert.equal(result.accountId, "acct_expired_123456");
});

test("near-expiry account refresh runs in its isolated CODEX_HOME", async () => {
  const filePath = path.join(root, "refresh.json");
  const homesDir = path.join(root, "refresh-homes");
  const created = createChatGPTSubscriptionAccount({ filePath, homesDir, now: NOW });
  const authPath = chatGPTSubscriptionAccountAuthPath(created.id, { homesDir });
  const payload = Buffer.from(JSON.stringify({ exp: Math.floor((NOW + 3_600_000) / 1000) })).toString("base64url");
  writeFileSync(authPath, JSON.stringify({ tokens: { access_token: `soon.${payload}.sig`, account_id: "refresh-account" } }), { mode: 0o600 });
  let invocation;
  const refreshed = await refreshChatGPTSubscriptionAccount(created.id, {
    filePath,
    homesDir,
    now: NOW,
    binary: "/usr/local/bin/codex",
    execFileImpl: (command, args, options, callback) => {
      invocation = { command, args, options };
      callback(null, "", "");
    },
  });
  assert.equal(refreshed, true);
  assert.equal(invocation.options.env.CODEX_HOME, path.join(homesDir, created.id));
});

test("round-robin and sticky affinity respect the turn limit", () => {
  const filePath = path.join(root, "sticky.json");
  const options = {
    filePath,
    policy: { enabled: true, strategy: "round-robin", sticky: true, stickyLimit: 2 },
    sessionId: "thread-1",
    now: NOW,
  };
  const first = selectChatGPTAccount(ACCOUNTS, options);
  const second = selectChatGPTAccount(ACCOUNTS, options);
  const third = selectChatGPTAccount(ACCOUNTS, options);
  assert.equal(first.accountId, "acct_primary_123456");
  assert.equal(second.accountId, first.accountId);
  assert.equal(second.reason, "sticky");
  assert.equal(third.accountId, "acct_backup_123456");
  assert.equal(third.reason, "rebound");
});

test("paused, revoked, reauth-required and cooled-down accounts are not selected", () => {
  const result = selectChatGPTAccount([
    account("acct_paused_123456", { state: "paused" }),
    account("acct_revoked_123456", { state: "revoked" }),
    account("acct_reauth_123456", { health: { state: "reauth-required" } }),
    account("acct_cooldown_123456", { health: { state: "cooldown", cooldownUntil: "2026-08-24T00:05:00Z" } }),
    account("acct_usable_123456"),
  ], {
    filePath: path.join(root, "eligibility.json"),
    policy: { enabled: true },
    now: NOW,
  });
  assert.equal(result.accountId, "acct_usable_123456");
});

test("401/403 require re-authentication and 429 recommends a safe pre-commit rebind", () => {
  const filePath = path.join(root, "health.json");
  const authFailure = recordChatGPTAccountOutcome("acct_primary_123456", {
    status: 401,
    error: "expired session",
    now: NOW,
  }, filePath);
  assert.equal(authFailure.reauthRequired, true);
  assert.equal(authFailure.rebindRecommended, true);

  const rateFailure = recordChatGPTAccountOutcome("acct_backup_123456", {
    status: 429,
    retryAfterSeconds: 42,
    now: NOW,
  }, filePath);
  assert.equal(rateFailure.rebindRecommended, true);
  assert.equal(Date.parse(rateFailure.account.health.cooldownUntil), NOW + 42_000);

  const committed = recordChatGPTAccountOutcome("acct_primary_123456", {
    status: 403,
    committed: true,
    now: NOW,
  }, filePath);
  assert.equal(committed.rebindRecommended, false);
});

test("explicit failed outcomes quarantine an account and preserve the last-used timestamp", () => {
  const filePath = path.join(root, "failed.json");
  const failed = recordChatGPTAccountOutcome("acct_primary_123456", {
    ok: false,
    error: "upstream failed",
    now: NOW,
  }, filePath);
  assert.equal(failed.account.health.state, "failed");
  assert.equal(failed.rebindRecommended, false);
  assert.equal(failed.account.health.lastUsedAt, new Date(NOW).toISOString());
  assert.equal(readChatGPTAccountPoolState(filePath, { now: NOW }).accounts.acct_primary_123456.health.lastUsedAt, new Date(NOW).toISOString());
});

test("upstream 5xx errors use a bounded cooldown before another account is tried", () => {
  const filePath = path.join(root, "server-error.json");
  const result = recordChatGPTAccountOutcome("acct_primary_123456", {
    status: 503,
    now: NOW,
  }, filePath);
  assert.equal(result.account.health.state, "cooldown");
  assert.equal(result.rebindRecommended, true);
  assert.equal(Date.parse(result.account.health.cooldownUntil), NOW + 30_000);
});

test("session affinity can be released without changing account metadata", () => {
  const filePath = path.join(root, "release.json");
  selectChatGPTAccount(ACCOUNTS, {
    filePath,
    policy: { enabled: true },
    sessionId: "thread-release",
    now: NOW,
  });
  assert.equal(releaseChatGPTAccountSession("thread-release", filePath), true);
  assert.equal(releaseChatGPTAccountSession("thread-release", filePath), false);
  assert.equal(Object.keys(readChatGPTAccountPoolState(filePath).sessions).length, 0);
});

test("pool lock serializes state operations and leaves lock files without credentials", async () => {
  const filePath = path.join(root, "locked.json");
  const order = [];
  await Promise.all([
    withChatGPTAccountPoolLock(async () => {
      order.push("first-start");
      await new Promise((resolve) => setTimeout(resolve, 10));
      order.push("first-end");
    }, { filePath }),
    withChatGPTAccountPoolLock(async () => {
      order.push("second-start");
      order.push("second-end");
    }, { filePath }),
  ]);
  assert.deepEqual(order, ["first-start", "first-end", "second-start", "second-end"]);
});

test("persisted pool contains account metadata only and sanitization is stable", () => {
  const filePath = path.join(root, "persist.json");
  const state = readChatGPTAccountPoolState(filePath, { now: NOW });
  state.policy.enabled = true;
  state.accounts[ACCOUNTS[0].id] = {
    ...ACCOUNTS[0],
    access_token: "must-not-persist",
    health: { state: "healthy", lastUsedAt: "2026-08-24T00:00:00Z" },
  };
  writeChatGPTAccountPoolState(state, filePath);
  assert.doesNotMatch(readFileSync(filePath, "utf8"), /token|secret|access_token|refresh_token|value/i);
  assert.equal(readChatGPTAccountPoolState(filePath).accounts[ACCOUNTS[0].id].health.lastUsedAt, "2026-08-24T00:00:00.000Z");
  assert.deepEqual(sanitizeChatGPTAccountPool(readChatGPTAccountPoolState(filePath, { now: NOW })).policy, {
    enabled: true,
    mode: "switch",
    strategy: "quota",
    autoSwitchThreshold: 0.1,
    sticky: true,
    stickyLimit: 50,
    maxCooldownSeconds: 300,
    priorityOrder: [],
    pausedAccountIds: [],
  });
});

test("subscription accounts use isolated Codex homes and route only after login", () => {
  const filePath = path.join(root, "subscription.json");
  const homesDir = path.join(root, "subscription-homes");
  const created = createChatGPTSubscriptionAccount({
    label: "Work ChatGPT",
    filePath,
    homesDir,
    now: NOW,
  });
  assert.match(created.id, /^acct_[A-Za-z0-9_-]{8,80}$/);
  assert.equal(created.label, "Work ChatGPT");
  assert.equal(created.subscription.status, "pending");
  const pending = chatGPTSubscriptionAccountPoolSnapshot({ filePath, homesDir, now: NOW });
  assert.equal(pending.accounts[created.id].subscription.usable, false);

  const state = readChatGPTAccountPoolState(filePath, { now: NOW });
  state.policy.enabled = true;
  writeChatGPTAccountPoolState(state, filePath);
  const authPath = chatGPTSubscriptionAccountAuthPath(created.id, { homesDir });
  mkdirSync(path.dirname(authPath), { recursive: true, mode: 0o700 });
  const payload = Buffer.from(JSON.stringify({ exp: Math.floor((NOW + 3_600_000) / 1000) })).toString("base64url");
  const accessToken = `header.${payload}.signature`;
  const idPayload = Buffer.from(JSON.stringify({ email: "secondary@example.com" })).toString("base64url");
  const idToken = `header.${idPayload}.signature`;
  writeFileSync(authPath, JSON.stringify({ auth_mode: "chatgpt", tokens: { access_token: accessToken, id_token: idToken, account_id: "subscription-account" } }), { mode: 0o600 });

  const ready = chatGPTSubscriptionAccountPoolSnapshot({ filePath, homesDir, now: NOW });
  assert.equal(ready.accounts[created.id].subscription.usable, true);
  assert.equal(ready.accounts[created.id].subscription.email, "secondary@example.com");
  const headers = chatGPTSubscriptionPoolHeaders({ filePath, homesDir, now: NOW, sessionId: "thread-subscription" });
  assert.deepEqual(headers, {
    authorization: `Bearer ${accessToken}`,
    "chatgpt-account-id": "subscription-account",
    accountId: created.id,
  });
  assert.doesNotMatch(readFileSync(filePath, "utf8"), /access_token|signature|subscription-account/);
});

test("removing a subscription account deletes its row metadata, affinity, and isolated home", () => {
  const filePath = path.join(root, "remove.json");
  const homesDir = path.join(root, "remove-homes");
  const created = createChatGPTSubscriptionAccount({ filePath, homesDir, now: NOW });
  const state = readChatGPTAccountPoolState(filePath, { now: NOW });
  state.policy.priorityOrder = [created.id];
  state.policy.pausedAccountIds = [created.id];
  state.policy.selectedAccountId = created.id;
  state.sessions.thread = {
    accountId: created.id,
    turns: 1,
    requests: 1,
    boundAt: new Date(NOW).toISOString(),
    updatedAt: new Date(NOW).toISOString(),
  };
  writeChatGPTAccountPoolState(state, filePath);

  const removed = removeChatGPTSubscriptionAccount(created.id, { filePath, homesDir });
  assert.equal(removed.id, created.id);
  assert.equal(removed.state, "revoked");
  assert.equal(readChatGPTAccountPoolState(filePath).accounts[created.id], undefined);
  const after = chatGPTSubscriptionAccountPoolSnapshot({ filePath, homesDir, now: NOW });
  assert.equal(after.accounts[created.id], undefined);
  assert.deepEqual(after.policy.priorityOrder, []);
  assert.deepEqual(after.policy.pausedAccountIds, []);
  assert.equal(after.policy.selectedAccountId, undefined);
  assert.equal(after.sessions.thread, undefined);
  assert.equal(existsSync(path.join(homesDir, created.id)), false);
});

test("new automatic labels ignore revoked records from older router versions", () => {
  const filePath = path.join(root, "label-migration.json");
  const homesDir = path.join(root, "label-migration-homes");
  const stale = createChatGPTSubscriptionAccount({ filePath, homesDir, now: NOW });
  const state = readChatGPTAccountPoolState(filePath, { now: NOW });
  state.accounts[stale.id].state = "revoked";
  state.accounts[stale.id].paused = true;
  state.policy.pausedAccountIds = [stale.id];
  writeChatGPTAccountPoolState(state, filePath);

  const next = createChatGPTSubscriptionAccount({ filePath, homesDir, now: NOW });
  assert.equal(next.label, "ChatGPT account 1");
  const after = readChatGPTAccountPoolState(filePath, { now: NOW });
  assert.equal(after.accounts[stale.id], undefined);
  assert.deepEqual(after.policy.pausedAccountIds, []);
});
