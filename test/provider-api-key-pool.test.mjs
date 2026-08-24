import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
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
  isRetryableProviderApiKeyFailure,
  providerApiKeyPoolStatus,
  providerApiKeySecretRefIdentity,
  readProviderApiKeyPoolState,
  recordProviderApiKeyOutcome,
  runProviderApiKeyAttempts,
  selectProviderApiKey,
  selectProviderApiKeyLocked,
  setProviderApiKeyPaused,
  setProviderApiKeyPoolPolicy,
  upsertProviderApiKey,
} = await import("../src/provider-api-key-pool.mjs");

const ref = (id) => ({ type: "opaque", id: `ref_${id}_12345678` });
const credential = (id, secret, patch = {}) => ({
  id: `cred_${id}_12345678`,
  secretRef: ref(id),
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
    resolveSecret: () => "unused",
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
    resolveSecret: () => undefined,
  });
  assert.equal(empty.configured, true);
  assert.equal(empty.credentialId, null);
  assert.equal(empty.fallbackAllowed, undefined);

  const invalidPath = path.join(root, "invalid.json");
  writeFileSync(invalidPath, '{"version":1,"providers":{"openrouter":{"credentials":{"bad": {}}}}}');
  const invalid = providerApiKeyPoolStatus("openrouter", { filePath: invalidPath });
  assert.equal(invalid.configured, true);
  assert.equal(invalid.valid, false);
  const selected = await selectProviderApiKey("openrouter", { filePath: invalidPath, resolveSecret: () => "LEGACY" });
  assert.equal(selected.reason, "invalid_pool_state");
  assert.equal(selected.fallbackAllowed, false);
});

test("duplicate secret references are rejected rather than selecting one arbitrarily", async () => {
  const filePath = path.join(root, "duplicates.json");
  const first = metadata({
    ...credential("first", "A"),
    secretRef: { type: "provider-file", name: "openrouter-api-key.secret" },
  });
  const second = metadata({
    ...credential("second", "B"),
    secretRef: { ...first.secretRef, providerId: "openrouter" },
  });
  await upsertProviderApiKey("openrouter", first, { filePath });
  await assert.rejects(
    upsertProviderApiKey("openrouter", second, { filePath }),
    /already contains this secret reference/,
  );
  assert.equal(
    providerApiKeySecretRefIdentity(first.secretRef, "openrouter"),
    providerApiKeySecretRefIdentity(second.secretRef, "openrouter"),
  );
});

test("resolution refuses duplicate secret values even when references differ", async () => {
  const filePath = path.join(root, "duplicate-values.json");
  await upsertProviderApiKey("openrouter", metadata(credential("first", "SAME")), { filePath });
  await upsertProviderApiKey("openrouter", metadata(credential("second", "SAME")), { filePath });
  const result = await selectProviderApiKey("openrouter", {
    filePath,
    resolveSecret: () => "SAME",
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
    resolveSecret: ({ id }) => id.includes("high") ? "HIGH" : "LOW",
    now: NOW,
  });
  assert.equal(result.credentialId, "cred_high_12345678");
  assert.equal(result.credentialValue, "HIGH");
  const snapshot = getProviderApiKeyPool("openrouter", { filePath, now: NOW });
  assert.equal(snapshot.credentials[0].secretRef.type, "opaque");
  assert.doesNotMatch(readFileSync(filePath, "utf8"), /HIGH|LOW/);
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
    resolveSecret: () => "ORDINARY",
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
});

test("runProviderApiKeyAttempts retries before relay and stops after relay begins", async () => {
  const filePath = path.join(root, "attempts.json");
  const first = metadata(credential("first", "FIRST", { priority: 2 }));
  const second = metadata(credential("second", "SECOND", { priority: 1 }));
  await upsertProviderApiKey("openrouter", first, { filePath });
  await upsertProviderApiKey("openrouter", second, { filePath });
  const secrets = new Map([[first.secretRef.id, "FIRST"], [second.secretRef.id, "SECOND"]]);
  let calls = 0;
  const recovered = await runProviderApiKeyAttempts("openrouter", {
    filePath,
    resolveSecret: ({ id }) => secrets.get(id),
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
    resolveSecret: () => "LATE",
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

test("duplicate resolved secrets remain blocked after a failed candidate is excluded", async () => {
  const filePath = path.join(root, "duplicate-failover.json");
  const first = metadata(credential("first", "SAME", { priority: 2 }));
  const second = metadata(credential("second", "SAME", { priority: 1 }));
  await upsertProviderApiKey("openrouter", first, { filePath });
  await upsertProviderApiKey("openrouter", second, { filePath });
  const result = await runProviderApiKeyAttempts("openrouter", {
    filePath,
    resolveSecret: () => "SAME",
    send: async () => ({ status: 401, ok: false, committed: false }),
    now: () => NOW,
  });
  assert.equal(result.attempts.length, 0);
  assert.equal(result.reason, "duplicate_secret_reference");
});

test("lock serializes concurrent state updates and preserves every session turn", async () => {
  const filePath = path.join(root, "concurrency.json");
  const entry = metadata(credential("concurrent", "CONCURRENT"));
  await upsertProviderApiKey("openrouter", entry, { filePath });
  const results = await Promise.all(Array.from({ length: 12 }, () => selectProviderApiKeyLocked("openrouter", {
    filePath,
    sessionId: "session-1",
    resolveSecret: () => "CONCURRENT",
    now: NOW,
  })));
  assert.equal(new Set(results.map((result) => result.credentialId)).size, 1);
  const state = readProviderApiKeyPoolState(filePath, { now: NOW });
  assert.equal(state.providers.openrouter.sessions["session-1"].turns, 12);
  assert.equal(existsSync(`${filePath}.pool-lock`), false);
});
