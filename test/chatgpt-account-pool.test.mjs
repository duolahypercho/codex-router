import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const root = mkdtempSync(path.join(os.tmpdir(), "codex-router-chatgpt-account-pool-"));
const statePath = path.join(root, "chatgpt-account-pool.json");
const NOW = Date.parse("2026-08-24T00:00:00.000Z");

const {
  readChatGPTAccountPoolState,
  recordChatGPTAccountOutcome,
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
    strategy: "quota",
    autoSwitchThreshold: 0.1,
    sticky: true,
    stickyLimit: 50,
    maxCooldownSeconds: 300,
    priorityOrder: [],
    pausedAccountIds: [],
  });
});
