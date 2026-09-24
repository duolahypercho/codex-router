import assert from "node:assert/strict";
import test from "node:test";

import { declaredEffort } from "../src/effort-ladder.mjs";

// The property this file exists for: a user who picks the deepest rung Codex
// offers must reach the deepest rung the model actually has.
//
// Codex 0.141 cannot parse `max`, so the catalog clamps the advertised ladder to
// `xhigh` (catalog.mjs, pinned by catalog.test.mjs). What arrives at the
// forwarder is therefore `xhigh`, and the forwarder has to turn it back into the
// upstream's top rung. On 2026-09-22 the opencode deepseek entries declared a
// single rung, so that turn-back landed on `high` and every "max" silently ran
// shallower. These tests fail on that shape and pass on the corrected one.

test("Codex's clamped top rung reaches the model's declared top rung", () => {
  assert.equal(declaredEffort("xhigh", ["low", "high", "max"]), "max");
  assert.equal(declaredEffort("max", ["low", "high", "max"]), "max");
  assert.equal(declaredEffort("ultra", ["low", "high", "max"]), "max");
});

test("a single-rung declaration collapses every request onto that rung", () => {
  // The shape that caused the defect. Kept as a test so the failure mode is
  // visible rather than rediscovered: nothing errors, the depth just drops.
  assert.equal(declaredEffort("xhigh", ["high"]), "high");
  assert.equal(declaredEffort("max", ["high"]), "high");
  assert.equal(declaredEffort("low", ["high"]), "high");
});

test("lower rungs land on the nearest declared rung at or below them", () => {
  assert.equal(declaredEffort("low", ["low", "high", "max"]), "low");
  assert.equal(declaredEffort("minimal", ["low", "high", "max"]), "low");
  // The clamp takes the nearest declared rung at or below the request, so a rung the
  // model does not have lands on the one beneath it rather than above it.
  assert.equal(declaredEffort("medium", ["low", "high", "max"]), "low");
  assert.equal(declaredEffort("high", ["low", "high", "max"]), "high");
});

test("an undeclared or unparseable request falls back to the declared floor", () => {
  assert.equal(declaredEffort("gigantic", ["low", "high", "max"]), "high");
  assert.equal(declaredEffort(undefined, ["low", "high", "max"]), "high");
  assert.equal(declaredEffort("xhigh", []), undefined);
});
