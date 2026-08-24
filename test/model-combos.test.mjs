import assert from "node:assert/strict";
import test from "node:test";

import {
  beginComboAttempt,
  comboModelIdentity,
  comboTargetKey,
  completeComboAttempt,
  createComboState,
  normalizeComboDefinition,
  normalizeComboState,
  resolveComboTarget,
  validateComboDefinition,
} from "../src/model-combos.mjs";

const models = [
  { provider: "openrouter", slug: "openrouter/qwen-max", capabilities: ["tools", "vision"], contextWindow: 100_000 },
  { provider: "local", slug: "local/qwen", supportsTools: true, supportsSearch: true, contextWindow: 50_000 },
  { provider: "backup", slug: "backup/text", supportsTools: false, contextWindow: 10_000 },
];

function health(overrides = {}) {
  return {
    "openrouter/qwen-max": { status: "healthy" },
    "local/qwen": { healthy: true },
    "backup/text": { healthy: true },
    ...overrides,
  };
}

function failoverCombo(overrides = {}) {
  return {
    id: "fast-coding",
    displayName: "Fast Coding",
    strategy: "failover",
    sticky: true,
    stickyLimit: 2,
    targets: [
      { provider: "openrouter", slug: "openrouter/qwen-max" },
      { provider: "local", slug: "local/qwen" },
    ],
    ...overrides,
  };
}

test("definitions use canonical slugs and reject ambiguous identities", () => {
  const normalized = normalizeComboDefinition(failoverCombo());
  assert.equal(normalized.targets[0].slug, "openrouter/qwen-max");
  assert.equal(comboTargetKey(normalized.targets[0]), "openrouter/qwen-max");
  assert.equal(comboModelIdentity(models[0]), "openrouter/qwen-max");
  assert.equal(resolveComboTarget(failoverCombo({ sticky: false, targets: [{ provider: "openrouter", slug: "openrouter/qwen-max" }] }), {
    models: [{ provider: "openrouter", slug: "openrouter/qwen-max", model: "wrong-upstream-id", capabilities: ["tools"] }],
    health: { "openrouter/qwen-max": true },
    requiredCapabilities: ["tools"],
  }).targetKey, "openrouter/qwen-max");
  assert.equal(validateComboDefinition({ ...failoverCombo(), targets: [{ provider: "openrouter", model: "old", slug: "new" }] }).ok, false);
  assert.equal(validateComboDefinition({ ...failoverCombo(), id: "Bad Name" }).ok, false);
});

test("health is explicit and unknown health fails closed", () => {
  const missing = resolveComboTarget(failoverCombo(), { models, requiredCapabilities: ["tools"] });
  assert.equal(missing.ok, false);
  assert.equal(missing.reason, "no-healthy-target");
  assert.ok(missing.diagnostics.skipped.every((item) => item.reason === "health-unknown"));
  const selected = resolveComboTarget(failoverCombo(), { models, health: health(), requiredCapabilities: ["tools"] });
  assert.equal(selected.targetKey, "openrouter/qwen-max");
});

test("a successful attempt commits stickiness, while failure clears it for recovery", () => {
  const combo = failoverCombo();
  let state = createComboState();
  const first = beginComboAttempt(combo, { models, health: health(), requiredCapabilities: ["tools"], sessionKey: "session-1", state });
  assert.equal(first.targetKey, "openrouter/qwen-max");
  assert.deepEqual(state, createComboState());
  state = completeComboAttempt(combo, state, first.attempt, { outcome: "success" });
  const sticky = beginComboAttempt(combo, { models, health: health(), requiredCapabilities: ["tools"], sessionKey: "session-1", state });
  assert.equal(sticky.targetKey, first.targetKey);
  assert.equal(sticky.diagnostics.stickyHit, true);
  state = completeComboAttempt(combo, state, sticky.attempt, { outcome: "retryable_failure" });
  const recovered = beginComboAttempt(combo, {
    models,
    health: health({ "openrouter/qwen-max": { healthy: false, reason: "cooldown" } }),
    requiredCapabilities: ["tools"],
    sessionKey: "session-1",
    state,
  });
  assert.equal(recovered.targetKey, "local/qwen");
  assert.equal(recovered.diagnostics.stickyHit, false);
});

test("sticky affinity expires only after its committed success limit", () => {
  const combo = failoverCombo();
  let state = createComboState();
  for (let i = 0; i < 2; i += 1) {
    const attempt = beginComboAttempt(combo, { models, health: health(), requiredCapabilities: ["tools"], sessionKey: "session-1", state });
    assert.equal(attempt.targetKey, "openrouter/qwen-max");
    state = completeComboAttempt(combo, state, attempt.attempt, { outcome: "success" });
  }
  const expired = beginComboAttempt(combo, { models, health: health(), requiredCapabilities: ["tools"], sessionKey: "session-1", state });
  assert.equal(expired.targetKey, "local/qwen");
  assert.equal(expired.diagnostics.stickyHit, false);
});

test("round-robin persists weighted cursor and skips a failed target's remaining weight", () => {
  const combo = failoverCombo({
    strategy: "round-robin",
    sticky: false,
    targets: [
      { provider: "openrouter", slug: "openrouter/qwen-max", weight: 2 },
      { provider: "local", slug: "local/qwen", weight: 1 },
    ],
  });
  let state = createComboState();
  const selected = [];
  for (let i = 0; i < 3; i += 1) {
    const attempt = beginComboAttempt(combo, { models, health: health(), requiredCapabilities: ["tools"], state });
    selected.push(attempt.targetKey);
    state = completeComboAttempt(combo, state, attempt.attempt, { outcome: "success" });
  }
  assert.deepEqual(selected, ["openrouter/qwen-max", "openrouter/qwen-max", "local/qwen"]);
  state = createComboState();
  const failed = beginComboAttempt(combo, { models, health: health(), requiredCapabilities: ["tools"], state });
  state = completeComboAttempt(combo, state, failed.attempt, { outcome: "retryable_failure" });
  const recovery = beginComboAttempt(combo, { models, health: health(), requiredCapabilities: ["tools"], state });
  assert.equal(recovery.targetKey, "local/qwen");
});

test("stale concurrent attempts cannot overwrite the persisted cursor", () => {
  const combo = failoverCombo({ strategy: "round-robin", sticky: false });
  const state = createComboState();
  const first = beginComboAttempt(combo, { models, health: health(), state });
  const second = beginComboAttempt(combo, { models, health: health(), state });
  const committed = completeComboAttempt(combo, state, first.attempt, { outcome: "success" });
  assert.throws(() => completeComboAttempt(combo, committed, second.attempt, { outcome: "success" }), /stale/);
});

test("tool capability accepts declared capability metadata and rejects unknown declarations", () => {
  const compatible = resolveComboTarget(failoverCombo({ sticky: false }), { models, health: health(), requiredCapabilities: ["tools"] });
  assert.equal(compatible.targetKey, "openrouter/qwen-max");
  const unknown = resolveComboTarget(failoverCombo({ targets: [{ provider: "backup", slug: "backup/text" }] }), { models, health: health(), requiredCapabilities: ["tools"] });
  assert.equal(unknown.reason, "no-eligible-target");
  assert.equal(unknown.diagnostics.skipped[0].reason, "missing-capability:tools");
  const undeclared = resolveComboTarget(failoverCombo({ targets: [{ provider: "local", slug: "local/qwen" }] }), { models: [{ provider: "local", slug: "local/qwen", contextWindow: 50_000 }], health: health(), requiredCapabilities: ["tools"] });
  assert.equal(undeclared.diagnostics.skipped[0].reason, "capability-unknown:tools");
});

test("state normalization drops malformed and oversized session records", () => {
  const sessions = Object.fromEntries(Array.from({ length: 1_005 }, (_, index) => [`s-${index}`, { target: "local/qwen", count: 1 }]));
  const state = normalizeComboState({ version: 99, cursors: { "fast-coding": 3, bad: -1 }, affinity: { "fast-coding": sessions } });
  assert.equal(state.version, 1);
  assert.equal(state.cursors["fast-coding"], 3);
  assert.equal(Object.keys(state.affinity["fast-coding"]).length, 1_000);
});
