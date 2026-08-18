import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const testRoot = mkdtempSync(path.join(os.tmpdir(), "codex-router-pool-"));
process.env.CODEX_HOME = path.join(testRoot, "codex");
process.env.CODEX_ROUTER_STATE_DIR = path.join(testRoot, "state");

const {
  addCredential,
  removeCredential,
  getPool,
  setStrategy,
  getStrategy,
  selectCredential,
  markCredentialFailure,
  markCredentialSuccess,
  resetCooldowns,
  hasCredentialPool,
  credentialPoolStatus,
  clearAllPools,
  DEFAULT_STRATEGY,
  VALID_STRATEGIES,
} = await import("../src/credential-pool.mjs");

test("credential pool stratégies et rotation basique", () => {
  try {
    clearAllPools();
    // deepseek is a poolable provider in the default registry
    const provider = "deepseek";
    assert.equal(hasCredentialPool(provider), false);
    assert.equal(getStrategy(provider), DEFAULT_STRATEGY);
    assert.deepEqual(VALID_STRATEGIES, ["fill_first", "round_robin", "least_used", "random"]);

    // first add seeds pool + creates primary if existing single file absent — new pool has 1 entry
    const first = addCredential(provider, "sk-test-pool-1", { label: "primary" });
    assert.equal(first.provider, provider);
    assert.equal(credentialPoolStatus(provider).total, 1);
    assert.equal(hasCredentialPool(provider), true);
    const pool = getPool(provider);
    assert.ok(pool.credentials.length === 1);
    assert.equal(pool.credentials[0].label, "primary");

    // second add
    const second = addCredential(provider, "sk-test-pool-2", { label: "backup" });
    assert.equal(credentialPoolStatus(provider).total, 2);
    // duplicate fingerprint rejected
    assert.throws(() => addCredential(provider, "sk-test-pool-1"), /already in the deepseek pool/);

    // strategies
    setStrategy(provider, "round_robin");
    assert.equal(getStrategy(provider), "round_robin");
    setStrategy(provider, "least_used");
    assert.equal(getStrategy(provider), "least_used");
    assert.throws(() => setStrategy(provider, "bogus"), /Unknown rotation strategy/);
    setStrategy(provider, "fill_first");

    // fill_first picks first healthy (requestCount increments)
    const picked = selectCredential(provider);
    assert.ok(picked);
    assert.equal(picked.label, "primary");
    assert.equal(credentialPoolStatus(provider).credentials[0].requestCount, 1);

    // least_used picks backup (0 vs 1)
    setStrategy(provider, "least_used");
    const least = selectCredential(provider);
    assert.equal(least.label, "backup");

    // round_robin cycles
    setStrategy(provider, "round_robin");
    clearAllPools();
    addCredential(provider, "sk-a-1", { label: "a" });
    addCredential(provider, "sk-a-2", { label: "b" });
    setStrategy(provider, "round_robin");
    const r1 = selectCredential(provider);
    const r2 = selectCredential(provider);
    const r3 = selectCredential(provider);
    assert.notEqual(r1.id, r2.id);
    assert.equal(r3.id, r1.id); // wrap

    // mark failure: 429 transient → retry_same, second 429 → rotate + cooldown
    clearAllPools();
    addCredential(provider, "sk-429-1", { label: "k1" });
    addCredential(provider, "sk-429-2", { label: "k2" });
    setStrategy(provider, "fill_first");
    const c1 = selectCredential(provider);
    assert.equal(c1.label, "k1");
    // need the id of k1 — list via status
    const k1Id = credentialPoolStatus(provider).credentials.find((c) => c.label === "k1").id;
    const k2Id = credentialPoolStatus(provider).credentials.find((c) => c.label === "k2").id;
    let res = markCredentialFailure(provider, k1Id, { status: 429, bodyText: "rate limit exceeded" });
    assert.equal(res.action, "retry_same");
    res = markCredentialFailure(provider, k1Id, { status: 429, bodyText: "rate limit exceeded" });
    assert.equal(res.action, "rotate");
    assert.ok(res.next);
    // k1 now in cooldown, so next select should give k2
    const after = selectCredential(provider);
    assert.equal(after.label, "k2");
    // reset clears cooldown
    resetCooldowns(provider);
    const afterReset = credentialPoolStatus(provider);
    assert.ok(afterReset.credentials.every((c) => c.cooldownUntil === null));

    // 402 / quota → immediate rotate
    // k1 is healthy again after reset, but select will pick fill_first k1
    const pk = selectCredential(provider);
    const pkId = pk.id;
    res = markCredentialFailure(provider, pkId, { status: 402, bodyText: "insufficient_quota" });
    assert.ok(["rotate","exhausted"].includes(res.action), `402 should rotate or exhausted, got ${res.action}`);

    // 401 → rotate
    const pk2 = credentialPoolStatus(provider).credentials.find((c) => c.healthy);
    if (pk2) {
      res = markCredentialFailure(provider, pk2.id, { status: 401, bodyText: "unauthorized" });
      assert.ok(["rotate","exhausted"].includes(res.action), `401 should rotate or exhausted, got ${res.action}`);
    }

    // success clears
    markCredentialSuccess(provider, k1Id);
    assert.equal(credentialPoolStatus(provider).credentials.find((c) => c.id === k1Id).lastStatus, "ok");

    // remove by index and id
    const before = credentialPoolStatus(provider).total;
    removeCredential(provider, 1);
    assert.equal(credentialPoolStatus(provider).total, before - 1);
    const remainingId = credentialPoolStatus(provider).credentials[0].id;
    removeCredential(provider, remainingId);
    assert.equal(hasCredentialPool(provider), false);

    clearAllPools();
  } finally {
    rmSync(testRoot, { recursive: true, force: true });
    clearAllPools();
  }
});

test("non-poolable providers rejected", async () => {
  clearAllPools();
  // anonymous / keyless / per-model / unknown cannot have pools
  assert.throws(() => addCredential("opencode-free", "sk-x"), /cannot have a pool/);
  // deepseek is poolable, so use known non-poolable ids; ollama may or may not exist per registry, so test generically
  assert.throws(() => addCredential("opencode-free", "sk-x2"), /cannot have a pool/);
  assert.throws(() => addCredential("custom", "sk-x"), /cannot have a pool|Unknown provider|per-model/);
  clearAllPools();
});
