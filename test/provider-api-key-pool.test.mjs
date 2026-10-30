import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const root = mkdtempSync(path.join(os.tmpdir(), "codex-router-api-key-pool-"));
const statePath = path.join(root, "provider-api-key-pools.json");
const NOW = Date.parse("2026-08-24T00:00:00.000Z");

const {
  getProviderApiKeyPool,
  deleteProviderApiKeyPool,
  isRetryableProviderApiKeyFailure,
  providerApiKeyPoolsSnapshot,
  providerApiKeyPoolStatus,
  readProviderApiKeyPoolState,
  recordProviderApiKeyOutcome,
  removeProviderApiKey,
  runProviderApiKeyAttempts,
  selectProviderApiKey,
  selectProviderApiKeyLocked,
  setProviderApiKeyPaused,
  setProviderApiKeyPoolPolicy,
  upsertProviderApiKey,
} = await import("../src/provider-api-key-pool.mjs");

const credential = (id, secret, patch = {}) => ({
  id: `cred_${id}_12345678`,
  ...patch,
  _secret: secret,
});

function metadata(value) {
  const { _secret, ...safe } = value;
  return safe;
}

test.after(() => rmSync(root, { recursive: true, force: true }));

test("an absent pool explicitly permits the legacy single-key path", async () => {
  const result = await selectProviderApiKey("openrouter", {
    filePath: path.join(root, "absent.json"),
    resolveCredential: () => "unused",
  });
  assert.equal(result.configured, false);
  assert.equal(result.fallbackAllowed, true);
});

test("a configured pool is authoritative and never falls back when empty or invalid", async () => {
  const emptyPath = path.join(root, "empty.json");
  await upsertProviderApiKey("openrouter", metadata(credential("one", "ONE")), { filePath: emptyPath });
  await setProviderApiKeyPaused("openrouter", "cred_one_12345678", true, { filePath: emptyPath });
  const empty = await selectProviderApiKey("openrouter", {
    filePath: emptyPath,
    resolveCredential: () => undefined,
  });
  assert.equal(empty.configured, true);
  assert.equal(empty.credentialId, null);
  assert.equal(empty.fallbackAllowed, undefined);

  const invalidPath = path.join(root, "invalid.json");
  writeFileSync(invalidPath, '{"version":1,"providers":{"openrouter":{"credentials":{"bad": {}}}}}');
  const invalid = providerApiKeyPoolStatus("openrouter", { filePath: invalidPath });
  assert.equal(invalid.configured, true);
  assert.equal(invalid.valid, false);
  const selected = await selectProviderApiKey("openrouter", { filePath: invalidPath, resolveCredential: () => "LEGACY" });
  assert.equal(selected.reason, "invalid_pool_state");
  assert.equal(selected.fallbackAllowed, false);
});

test("resolution refuses duplicate secret values even when references differ", async () => {
  const filePath = path.join(root, "duplicate-values.json");
  await upsertProviderApiKey("openrouter", metadata(credential("first", "SAME")), { filePath });
  await upsertProviderApiKey("openrouter", metadata(credential("second", "SAME")), { filePath });
  const result = await selectProviderApiKey("openrouter", {
    filePath,
    resolveCredential: () => "SAME",
  });
  assert.equal(result.credentialId, null);
  assert.equal(result.reason, "duplicate_secret_reference");
});

test("quota and round-robin selection never returns the secret value in metadata", async () => {
  const filePath = path.join(root, "selection.json");
  await upsertProviderApiKey("openrouter", metadata(credential("low", "LOW", { priority: 1, quota: { limit: 100, remaining: 10 } })), { filePath });
  await upsertProviderApiKey("openrouter", metadata(credential("high", "HIGH", { priority: 2, quota: { limit: 100, remaining: 90 } })), { filePath });
  const result = await selectProviderApiKey("openrouter", {
    filePath,
    resolveCredential: (id) => id.includes("high") ? "HIGH" : "LOW",
    now: NOW,
  });
  assert.equal(result.credentialId, "cred_high_12345678");
  assert.equal(result.credentialValue, "HIGH");
  const snapshot = getProviderApiKeyPool("openrouter", { filePath, now: NOW });
  assert.equal(snapshot.credentials[0].id.startsWith("cred_"), true);
  assert.doesNotMatch(readFileSync(filePath, "utf8"), /HIGH|LOW/);
});

test("an expired request window becomes unknown instead of pinning a key at zero", async () => {
  const filePath = path.join(root, "expired-quota.json");
  const expired = metadata(credential("expired", "EXPIRED", {
    priority: 100,
    quota: {
      unit: "requests",
      limit: 100,
      remaining: 0,
      resetAt: new Date(NOW - 1).toISOString(),
    },
  }));
  const unknown = metadata(credential("unknown", "UNKNOWN", { priority: 1 }));
  await upsertProviderApiKey("openrouter", expired, { filePath });
  await upsertProviderApiKey("openrouter", unknown, { filePath });
  const selected = await selectProviderApiKey("openrouter", {
    filePath,
    resolveCredential: (id) => id === expired.id ? "EXPIRED" : "UNKNOWN",
    now: NOW,
  });
  assert.equal(selected.credentialId, expired.id);
});

test("an attempt records only its exact credential's complete request window", async () => {
  const filePath = path.join(root, "observed-quota.json");
  const first = metadata(credential("quota_first", "FIRST", { priority: 2 }));
  const second = metadata(credential("quota_second", "SECOND", { priority: 1 }));
  await upsertProviderApiKey("openrouter", first, { filePath });
  await upsertProviderApiKey("openrouter", second, { filePath });
  const resetAt = new Date(NOW + 60_000).toISOString();
  await runProviderApiKeyAttempts("openrouter", {
    filePath,
    resolveCredential: (id) => id === first.id ? "FIRST" : "SECOND",
    send: async () => ({
      status: 200,
      ok: true,
      committed: false,
      quota: { unit: "requests", limit: 100, remaining: 42, resetAt },
    }),
    now: () => NOW,
  });
  let state = readProviderApiKeyPoolState(filePath, { now: NOW });
  assert.deepEqual(state.providers.openrouter.credentials[first.id].quota, {
    unit: "requests",
    limit: 100,
    remaining: 42,
    resetAt,
    observedAt: new Date(NOW).toISOString(),
  });
  assert.equal(state.providers.openrouter.credentials[second.id].quota, undefined);

  await recordProviderApiKeyOutcome("openrouter", first.id, {
    status: 200,
    ok: true,
    quota: { unit: "requests", limit: 100 },
    now: NOW + 1_000,
  }, { filePath });
  state = readProviderApiKeyPoolState(filePath, { now: NOW + 1_000 });
  assert.equal(
    state.providers.openrouter.credentials[first.id].quota.remaining,
    42,
    "a later partial header set must preserve the complete observation",
  );
});

test("an older outcome cannot replace a newer credential failure or quota observation", async () => {
  const filePath = path.join(root, "out-of-order-outcomes.json");
  const entry = metadata(credential("ordered", "ORDERED"));
  await upsertProviderApiKey("openrouter", entry, { filePath });
  const baseAt = Date.now();
  const olderAt = baseAt + 1_000;
  const newerAt = baseAt + 2_000;
  const resetAt = new Date(baseAt + 300_000).toISOString();

  // Two concurrent upstream requests can finish in one order and acquire the
  // pool lock in the other. Persist the later observation first, then replay
  // the delayed older success deterministically.
  await recordProviderApiKeyOutcome("openrouter", entry.id, {
    status: 429,
    ok: false,
    committed: false,
    retryAfterSeconds: 300,
    quota: {
      unit: "requests",
      limit: 100,
      remaining: 0,
      resetAt,
      observedAt: new Date(newerAt).toISOString(),
    },
    now: newerAt,
  }, { filePath });
  const delayed = await recordProviderApiKeyOutcome("openrouter", entry.id, {
    status: 200,
    ok: true,
    committed: false,
    quota: {
      unit: "requests",
      limit: 100,
      remaining: 90,
      resetAt,
      observedAt: new Date(olderAt).toISOString(),
    },
    now: olderAt,
  }, { filePath });

  const state = readProviderApiKeyPoolState(filePath, { now: newerAt });
  const stored = state.providers.openrouter.credentials[entry.id];
  assert.equal(stored.requestCount, 2, "both completed attempts remain accounted for");
  assert.equal(stored.quota.remaining, 0);
  assert.equal(stored.quota.observedAt, new Date(newerAt).toISOString());
  assert.equal(stored.health.state, "cooldown");
  assert.equal(stored.health.lastStatus, 429);
  assert.equal(stored.health.lastOutcomeAt, new Date(newerAt).toISOString());
  assert.equal(stored.health.lastSuccessAt, undefined);
  assert.equal(delayed.credential.health.state, "cooldown");
  const selected = await selectProviderApiKey("openrouter", {
    filePath,
    resolveCredential: () => "ORDERED",
    now: newerAt,
  });
  assert.equal(selected.credentialId, null, "the delayed success must not resurrect the exhausted key");
});

test("non-sticky round-robin advances across every credential for a bound session", async () => {
  const filePath = path.join(root, "round-robin-session.json");
  const entries = ["a", "b", "c"].map((id) => metadata(credential(`round_${id}`, id.toUpperCase())));
  for (const entry of entries) await upsertProviderApiKey("openrouter", entry, { filePath });
  await setProviderApiKeyPoolPolicy("openrouter", {
    strategy: "round-robin",
    sticky: false,
  }, { filePath });
  const values = new Map(entries.map((entry, index) => [entry.id, String.fromCharCode(65 + index)]));
  const selected = [];
  for (let index = 0; index < 5; index += 1) {
    const result = await selectProviderApiKeyLocked("openrouter", {
      filePath,
      sessionId: "same-thread",
      resolveCredential: (id) => values.get(id),
      now: NOW + index,
    });
    selected.push(result.credentialId);
  }
  assert.deepEqual(selected, [entries[0].id, entries[1].id, entries[2].id, entries[0].id, entries[1].id]);
});

test("diagnostic snapshots fail closed for every unusable authoritative pool without exposing secrets", async () => {
  const emptyPath = path.join(root, "diagnostic-empty.json");
  const emptyEntry = metadata(credential("diagnostic_empty", "EMPTY"));
  await upsertProviderApiKey("openrouter", emptyEntry, { filePath: emptyPath });
  await removeProviderApiKey("openrouter", emptyEntry.id, { filePath: emptyPath });
  const empty = providerApiKeyPoolsSnapshot({
    filePath: emptyPath,
    resolveCredential: () => "MUST_NOT_APPEAR_EMPTY",
  });
  assert.equal(empty.usable, false);
  assert.equal(empty.providers.openrouter.readiness.reason, "empty_pool");

  const pausedPath = path.join(root, "diagnostic-paused.json");
  const pausedEntry = metadata(credential("diagnostic_paused", "PAUSED"));
  await upsertProviderApiKey("openrouter", pausedEntry, { filePath: pausedPath });
  await setProviderApiKeyPaused("openrouter", pausedEntry.id, true, { filePath: pausedPath });
  const paused = providerApiKeyPoolsSnapshot({
    filePath: pausedPath,
    resolveCredential: () => "MUST_NOT_APPEAR_PAUSED",
  });
  assert.equal(paused.usable, false);
  assert.equal(paused.providers.openrouter.readiness.reason, "no_eligible_credentials");

  const unresolvedPath = path.join(root, "diagnostic-unresolved.json");
  const unresolvedEntry = metadata(credential("diagnostic_unresolved", "UNRESOLVED"));
  await upsertProviderApiKey("openrouter", unresolvedEntry, { filePath: unresolvedPath });
  const unresolved = providerApiKeyPoolsSnapshot({
    filePath: unresolvedPath,
    resolveCredential: () => undefined,
  });
  assert.equal(unresolved.usable, false);
  assert.equal(unresolved.providers.openrouter.readiness.reason, "unresolvable_credentials");

  const readySecret = "DIAGNOSTIC_READY_SECRET_MUST_NOT_APPEAR";
  const ready = providerApiKeyPoolsSnapshot({
    filePath: unresolvedPath,
    resolveCredential: () => readySecret,
  });
  assert.equal(ready.usable, true);
  assert.equal(ready.providers.openrouter.readiness.reason, "ready");
  assert.doesNotMatch(JSON.stringify(ready), new RegExp(readySecret));
});

test("ordinary 400 and 404 responses do not disable a key", async () => {
  const filePath = path.join(root, "ordinary-errors.json");
  const entry = metadata(credential("ordinary", "ORDINARY"));
  await upsertProviderApiKey("openrouter", entry, { filePath });
  for (const status of [400, 404]) {
    const outcome = await recordProviderApiKeyOutcome("openrouter", entry.id, {
      status,
      ok: false,
      committed: false,
      now: NOW,
    }, { filePath });
    assert.equal(outcome.rebindRecommended, false);
    assert.equal(outcome.credential.health.state, "healthy");
  }
  const selected = await selectProviderApiKey("openrouter", {
    filePath,
    resolveCredential: () => "ORDINARY",
    now: NOW,
  });
  assert.equal(selected.credentialId, entry.id);
});

test("only pre-commit transient failures recommend a rebind", async () => {
  const filePath = path.join(root, "commit-boundary.json");
  const first = metadata(credential("first", "FIRST"));
  const second = metadata(credential("second", "SECOND"));
  await upsertProviderApiKey("openrouter", first, { filePath });
  await upsertProviderApiKey("openrouter", second, { filePath });

  const committed = await recordProviderApiKeyOutcome("openrouter", first.id, {
    status: 401,
    ok: false,
    committed: true,
    now: NOW,
  }, { filePath });
  assert.equal(committed.rebindRecommended, false);
  assert.notEqual(committed.credential.health.state, "cooldown");

  const precommit = await recordProviderApiKeyOutcome("openrouter", second.id, {
    status: 401,
    ok: false,
    committed: false,
    now: NOW,
  }, { filePath });
  assert.equal(precommit.rebindRecommended, true);
  assert.equal(precommit.credential.health.state, "cooldown");
  assert.equal(isRetryableProviderApiKeyFailure({ status: 400 }), false);
  assert.equal(isRetryableProviderApiKeyFailure({ status: 404 }), false);
  assert.equal(isRetryableProviderApiKeyFailure({ status: 401, committed: true }), false);
  assert.equal(isRetryableProviderApiKeyFailure({ status: 401, committed: false }), true);
  assert.equal(isRetryableProviderApiKeyFailure({ status: 500, committed: false }), false);
  assert.equal(isRetryableProviderApiKeyFailure({
    error: new TypeError("fetch failed", { cause: Object.assign(new Error("reset"), { code: "ECONNRESET" }) }),
  }), true);
});

test("runProviderApiKeyAttempts retries before relay and stops after relay begins", async () => {
  const filePath = path.join(root, "attempts.json");
  const first = metadata(credential("first", "FIRST", { priority: 2 }));
  const second = metadata(credential("second", "SECOND", { priority: 1 }));
  await upsertProviderApiKey("openrouter", first, { filePath });
  await upsertProviderApiKey("openrouter", second, { filePath });
  const secrets = new Map([[first.id, "FIRST"], [second.id, "SECOND"]]);
  let calls = 0;
  const recovered = await runProviderApiKeyAttempts("openrouter", {
    filePath,
    resolveCredential: (id) => secrets.get(id),
    send: async ({ apiKey }) => {
      calls += 1;
      return apiKey === "FIRST"
        ? { status: 401, ok: false, committed: false }
        : { status: 200, ok: true, committed: false };
    },
    now: () => NOW,
  });
  assert.equal(calls, 2);
  assert.equal(recovered.result.status, 200);
  assert.deepEqual(recovered.attempts.map((attempt) => attempt.credentialId), [first.id, second.id]);

  const latePath = path.join(root, "late.json");
  await upsertProviderApiKey("openrouter", metadata(credential("late", "LATE")), { filePath: latePath });
  let lateCalls = 0;
  const late = await runProviderApiKeyAttempts("openrouter", {
    filePath: latePath,
    resolveCredential: () => "LATE",
    send: async () => {
      lateCalls += 1;
      return { status: 401, ok: false, committed: true };
    },
    now: () => NOW,
  });
  assert.equal(lateCalls, 1);
  assert.equal(late.attempts[0].committed, true);
  assert.equal(late.reason, "failed");
});

test("outcome persistence failure preserves success and prevents an unrecorded failover", async () => {
  const successPath = path.join(root, "outcome-write-success.json");
  const first = metadata(credential("write_success", "FIRST", { priority: 2 }));
  const second = metadata(credential("write_second", "SECOND", { priority: 1 }));
  await upsertProviderApiKey("openrouter", first, { filePath: successPath });
  await upsertProviderApiKey("openrouter", second, { filePath: successPath });
  const writeFailure = new Error("simulated state disk failure");
  let sends = 0;
  const success = await runProviderApiKeyAttempts("openrouter", {
    filePath: successPath,
    resolveCredential: (id) => id === first.id ? "FIRST" : "SECOND",
    send: async () => {
      sends += 1;
      return { status: 200, ok: true, committed: false, bodyText: "success" };
    },
    recordOutcome: async () => { throw writeFailure; },
    now: () => NOW,
  });
  assert.equal(sends, 1);
  assert.equal(success.reason, "success");
  assert.equal(success.result.status, 200);
  assert.equal(success.persistenceError, writeFailure);
  assert.equal(success.attempts[0].statePersisted, false);

  sends = 0;
  const failed = await runProviderApiKeyAttempts("openrouter", {
    filePath: successPath,
    resolveCredential: (id) => id === first.id ? "FIRST" : "SECOND",
    send: async () => {
      sends += 1;
      return { status: 401, ok: false, committed: false, bodyText: "unauthorized" };
    },
    recordOutcome: async () => { throw writeFailure; },
    now: () => NOW,
  });
  assert.equal(sends, 1);
  assert.equal(failed.reason, "state_persistence_failed");
  assert.equal(failed.result.status, 401);
  assert.equal(failed.persistenceError, writeFailure);
  assert.equal(failed.attempts[0].statePersisted, false);
});

test("a credential-specific preflight rejection rotates even when its public error is 503", async () => {
  const filePath = path.join(root, "preflight-rejection.json");
  const at = Date.now();
  const first = metadata(credential("preflight_a", "FIRST", { priority: 2 }));
  const second = metadata(credential("preflight_b", "SECOND", { priority: 1 }));
  await upsertProviderApiKey("github-copilot", first, { filePath });
  await upsertProviderApiKey("github-copilot", second, { filePath });
  const secrets = new Map([[first.id, "FIRST"], [second.id, "SECOND"]]);
  const sent = [];
  const result = await runProviderApiKeyAttempts("github-copilot", {
    filePath,
    resolveCredential: (id) => secrets.get(id),
    isResponseCommitted: () => false,
    send: async ({ apiKey }) => {
      sent.push(apiKey);
      if (apiKey === "FIRST") {
        const error = new Error("Copilot setup unavailable");
        error.status = 503;
        error.providerStatus = 401;
        throw error;
      }
      return { status: 200, ok: true, committed: false };
    },
    now: () => at,
    sleepImpl: async () => {},
  });
  assert.deepEqual(sent, ["FIRST", "SECOND"]);
  assert.equal(result.reason, "success");
  assert.deepEqual(result.attempts.map((attempt) => attempt.status), [401, 200]);
  const state = readProviderApiKeyPoolState(filePath, { now: at });
  assert.equal(state.providers["github-copilot"].credentials[first.id].health.state, "cooldown");
});

test("a send error after response commit propagates the commit boundary", async () => {
  const filePath = path.join(root, "committed-send-error.json");
  const entry = metadata(credential("committed_throw", "COMMITTED"));
  await upsertProviderApiKey("openrouter", entry, { filePath });
  let committed = false;
  let sends = 0;
  const failure = new Error("stream failed after headers");
  const result = await runProviderApiKeyAttempts("openrouter", {
    filePath,
    resolveCredential: () => "COMMITTED",
    isResponseCommitted: () => committed,
    send: async () => {
      sends += 1;
      committed = true;
      throw failure;
    },
    now: () => NOW,
  });
  assert.equal(sends, 1);
  assert.equal(result.error, failure);
  assert.equal(result.committed, true);
  assert.equal(result.attempts[0].committed, true);
});

test("duplicate resolved secrets remain blocked after a failed candidate is excluded", async () => {
  const filePath = path.join(root, "duplicate-failover.json");
  const first = metadata(credential("first", "SAME", { priority: 2 }));
  const second = metadata(credential("second", "SAME", { priority: 1 }));
  await upsertProviderApiKey("openrouter", first, { filePath });
  await upsertProviderApiKey("openrouter", second, { filePath });
  const result = await runProviderApiKeyAttempts("openrouter", {
    filePath,
    resolveCredential: () => "SAME",
    send: async () => ({ status: 401, ok: false, committed: false }),
    now: () => NOW,
  });
  assert.equal(result.attempts.length, 0);
  assert.equal(result.reason, "duplicate_secret_reference");
});

test("attempts re-read a paused initial candidate before sending", async () => {
  const filePath = path.join(root, "stale-selection.json");
  const first = metadata(credential("stale", "STALE", { priority: 2 }));
  const second = metadata(credential("fresh", "FRESH", { priority: 1 }));
  await upsertProviderApiKey("openrouter", first, { filePath });
  await upsertProviderApiKey("openrouter", second, { filePath });
  const initialSelection = await selectProviderApiKeyLocked("openrouter", {
    filePath,
    resolveCredential: (id) => id === first.id ? "STALE" : "FRESH",
    now: NOW,
  });
  await setProviderApiKeyPaused("openrouter", first.id, true, { filePath });
  const sent = [];
  const result = await runProviderApiKeyAttempts("openrouter", {
    filePath,
    initialSelection,
    resolveCredential: (id) => id === first.id ? "STALE" : "FRESH",
    send: async ({ apiKey }) => {
      sent.push(apiKey);
      return { status: 200, ok: true, committed: false };
    },
    now: () => NOW,
  });
  assert.deepEqual(sent, ["FRESH"]);
  assert.equal(result.credentialId, second.id);
});

test("attempts never retry origin 500 and cap an explicit large attempt request", async () => {
  // This case measures status and attempt-count policy, not ACL wall time.
  // Budget expiry during selection/backoff has its own regression below.
  const noRetryPath = path.join(root, "no-retry-500.json");
  for (const id of ["one", "two"]) {
    await upsertProviderApiKey("openrouter", metadata(credential(`five_${id}`, id)), { filePath: noRetryPath });
  }
  let calls = 0;
  const originFailure = await runProviderApiKeyAttempts("openrouter", {
    filePath: noRetryPath,
    resolveCredential: (id) => id,
    send: async () => {
      calls += 1;
      return { status: 500, ok: false, committed: false };
    },
    sleepImpl: async () => {},
    now: () => NOW,
  });
  assert.equal(calls, 1);
  assert.equal(originFailure.reason, "failed");

  const cappedPath = path.join(root, "attempt-cap.json");
  for (const id of ["a", "b", "c", "d"]) {
    await upsertProviderApiKey("openrouter", metadata(credential(`cap_${id}`, id)), { filePath: cappedPath });
  }
  calls = 0;
  await runProviderApiKeyAttempts("openrouter", {
    filePath: cappedPath,
    maxAttempts: 256,
    resolveCredential: (id) => id,
    send: async () => {
      calls += 1;
      return { status: 429, ok: false, committed: false };
    },
    sleepImpl: async () => {},
    now: () => NOW,
  });
  assert.equal(calls, 3);
});

test("oversized maps and symlink state fail closed without truncation", async () => {
  const oversizedPath = path.join(root, "oversized.json");
  const credentials = Object.fromEntries(Array.from({ length: 257 }, (_, index) => {
    const id = `cred_over_${String(index).padStart(8, "0")}`;
    return [id, { id, providerId: "openrouter", health: { state: "healthy" } }];
  }));
  writeFileSync(oversizedPath, JSON.stringify({
    version: 1,
    providers: { openrouter: { providerId: "openrouter", credentials } },
  }));
  assert.equal(readProviderApiKeyPoolState(oversizedPath).valid, false);
  await assert.rejects(
    upsertProviderApiKey("openrouter", metadata(credential("extra", "EXTRA")), { filePath: oversizedPath }),
    /invalid; refusing to overwrite/i,
  );

  const linkedPath = path.join(root, "linked.json");
  symlinkSync(oversizedPath, linkedPath);
  assert.equal(readProviderApiKeyPoolState(linkedPath).valid, false);
});

test("credential and pool removal clean bindings but preserve external credential references", async () => {
  const filePath = path.join(root, "remove.json");
  const first = metadata(credential("remove", "REMOVE"));
  await upsertProviderApiKey("openrouter", first, { filePath });
  await selectProviderApiKeyLocked("openrouter", {
    filePath,
    sessionId: "bound-session",
    resolveCredential: () => "REMOVE",
    now: NOW,
  });
  await removeProviderApiKey("openrouter", first.id, { filePath });
  const afterRemoval = getProviderApiKeyPool("openrouter", { filePath, now: NOW });
  assert.equal(afterRemoval.credentials.length, 0);
  assert.equal(afterRemoval.sessions["bound-session"], undefined);
  await deleteProviderApiKeyPool("openrouter", { filePath });
  assert.equal(providerApiKeyPoolStatus("openrouter", { filePath }).configured, false);
});

test("a new thread evicts the least-recently-used binding at the session cap", async () => {
  const filePath = path.join(root, "session-cap.json");
  const entry = metadata(credential("session_cap", "SESSION_CAP"));
  await upsertProviderApiKey("openrouter", entry, { filePath });
  const document = JSON.parse(readFileSync(filePath, "utf8"));
  document.providers.openrouter.sessions = Object.fromEntries(
    Array.from({ length: 2_048 }, (_, index) => {
      const timestamp = new Date(NOW - (2_048 - index) * 1_000).toISOString();
      return [`old-session-${String(index).padStart(4, "0")}`, {
        credentialId: entry.id,
        turns: 1,
        requests: 1,
        boundAt: timestamp,
        updatedAt: timestamp,
      }];
    }),
  );
  writeFileSync(filePath, `${JSON.stringify(document)}\n`, { mode: 0o600 });

  const selected = await selectProviderApiKeyLocked("openrouter", {
    filePath,
    sessionId: "new-session",
    resolveCredential: () => "SESSION_CAP",
    now: NOW,
  });
  assert.equal(selected.credentialId, entry.id);
  const state = readProviderApiKeyPoolState(filePath, { now: NOW });
  const sessions = state.providers.openrouter.sessions;
  assert.equal(Object.keys(sessions).length, 2_048);
  assert.equal(sessions["old-session-0000"], undefined);
  assert.ok(sessions["old-session-2047"]);
  assert.equal(sessions["new-session"].credentialId, entry.id);
});

test("pool writes globally evict old sessions before the state can outgrow its read bound", async () => {
  const filePath = path.join(root, "global-session-cap.json");
  const providers = [
    "openrouter",
    "deepseek",
    "grok-api",
    "kimi-api",
    "kimi-api-cn",
    "anthropic-api",
    "commandcode",
    "github-copilot",
    "venice",
  ];
  const entries = new Map();
  for (const provider of providers) {
    const entry = metadata(credential(`global_${provider.replaceAll("-", "_")}`, provider));
    entries.set(provider, entry);
    await upsertProviderApiKey(provider, entry, { filePath });
  }
  const document = JSON.parse(readFileSync(filePath, "utf8"));
  for (const [providerIndex, provider] of providers.entries()) {
    document.providers[provider].sessions = Object.fromEntries(
      Array.from({ length: 2_048 }, (_, index) => {
        const timestamp = new Date(NOW + providerIndex * 10_000_000 + index).toISOString();
        return [`${provider}-session-${String(index).padStart(4, "0")}`, {
          credentialId: entries.get(provider).id,
          turns: 1,
          requests: 1,
          boundAt: timestamp,
          updatedAt: timestamp,
        }];
      }),
    );
  }
  writeFileSync(filePath, `${JSON.stringify(document)}\n`, { mode: 0o600 });
  assert.ok(Buffer.byteLength(readFileSync(filePath)) <= 4 * 1024 * 1024);

  await setProviderApiKeyPoolPolicy("venice", { stickyLimit: 25 }, { filePath });

  const state = readProviderApiKeyPoolState(filePath, { now: NOW });
  assert.equal(state.valid, true);
  const sessionCount = providers.reduce(
    (count, provider) => count + Object.keys(state.providers[provider].sessions).length,
    0,
  );
  assert.equal(sessionCount, 4_096);
  assert.equal(Object.keys(state.providers.openrouter.sessions).length, 0);
  assert.equal(Object.keys(state.providers["github-copilot"].sessions).length, 2_048);
  assert.equal(Object.keys(state.providers.venice.sessions).length, 2_048);
  assert.ok(Buffer.byteLength(readFileSync(filePath)) <= 4 * 1024 * 1024);
});

test("lock serializes concurrent state updates and preserves every session turn", async () => {
  const filePath = path.join(root, "concurrency.json");
  const entry = metadata(credential("concurrent", "CONCURRENT"));
  await upsertProviderApiKey("openrouter", entry, { filePath });
  const results = await Promise.all(Array.from({ length: 12 }, () => selectProviderApiKeyLocked("openrouter", {
    filePath,
    sessionId: "session-1",
    resolveCredential: () => "CONCURRENT",
    now: NOW,
  })));
  assert.equal(new Set(results.map((result) => result.credentialId)).size, 1);
  const state = readProviderApiKeyPoolState(filePath, { now: NOW });
  assert.equal(state.providers.openrouter.sessions["session-1"].turns, 12);
  assert.equal(existsSync(`${filePath}.pool-lock`), false);
});

test("pool attempts do not send after backoff or credential selection exhausts the budget", async () => {
  for (const phase of ["backoff", "selection", "within-budget"]) {
    const filePath = path.join(root, `budget-${phase}.json`);
    const first = metadata(credential("budget_first", "FIRST", { priority: 2 }));
    const second = metadata(credential("budget_second", "SECOND", { priority: 1 }));
    await upsertProviderApiKey("openrouter", first, { filePath });
    await upsertProviderApiKey("openrouter", second, { filePath });
    let elapsed = 0;
    const sends = [];
    const result = await runProviderApiKeyAttempts("openrouter", {
      filePath,
      now: () => NOW + elapsed,
      resolveCredential: (id) => {
        if (phase === "selection") elapsed = 5001;
        return id === first.id ? "FIRST" : "SECOND";
      },
      sleepImpl: async (ms) => { elapsed += ms; },
      send: async ({ apiKey }) => {
        sends.push(elapsed);
        if (apiKey === "FIRST") {
          elapsed = phase === "within-budget" ? 100 : 4900;
          return { status: 429, ok: false, committed: false };
        }
        return { status: 200, ok: true, committed: false };
      },
    });
    assert.equal(sends.length, phase === "within-budget" ? 2 : phase === "selection" ? 0 : 1);
    assert.equal(result.reason, phase === "within-budget" ? "success" : "no_retry_candidate");
    assert.ok(sends.every((at) => at < 5000));
  }
});
