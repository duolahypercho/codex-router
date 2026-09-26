import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { privateFileIsProtected } from "../src/file-security.mjs";
import { classifyRoutedFailure } from "../src/model-failover.mjs";

const stateDir = mkdtempSync(path.join(os.tmpdir(), "auto-review-fallback-test-"));
process.env.CODEX_ROUTER_STATE_DIR = stateDir;

const {
  AUTO_REVIEW_FALLBACK_PATH,
  AUTO_REVIEW_MODEL,
  autoReviewFallbackEngaged,
  autoReviewFallbackSnapshot,
  clearAutoReviewExhaustion,
  clearAutoReviewFallback,
  isAutoReviewModel,
  readAutoReviewFallback,
  recordAutoReviewExhaustion,
  setAutoReviewFallback,
} = await import("../src/auto-review-fallback.mjs");

test("the reviewer is recognized by its own slug and nothing else", () => {
  assert.equal(AUTO_REVIEW_MODEL, "codex-auto-review");
  assert.equal(isAutoReviewModel("codex-auto-review"), true);
  assert.equal(isAutoReviewModel(" codex-auto-review "), true);
  // Acceptance criterion 3: the reviewer is chosen independently of the model
  // running the session, so an ordinary GPT turn must never enter this path.
  for (const other of ["gpt-6-astra", "gpt-5.6-luna", "kimi-oauth/k3", "", undefined, null]) {
    assert.equal(isAutoReviewModel(other), false, `${other} must not be the reviewer`);
  }
});

test("nothing is configured until the operator names a reviewer", () => {
  assert.deepEqual(readAutoReviewFallback(), {
    model: undefined,
    exhaustedUntil: undefined,
    reason: undefined,
    observedAt: undefined,
  });
  assert.equal(autoReviewFallbackEngaged(), false);
  assert.deepEqual(autoReviewFallbackSnapshot(), {
    model: null,
    nativeExhaustedUntil: null,
    reason: null,
    observedAt: null,
    reviewer: AUTO_REVIEW_MODEL,
    path: AUTO_REVIEW_FALLBACK_PATH,
  });
});

test("an exhaustion with no configured reviewer is not recorded", () => {
  // Otherwise `status` would claim a fallback the router cannot perform.
  assert.equal(recordAutoReviewExhaustion({ until: new Date(Date.now() + 60_000).toISOString() }), undefined);
  assert.equal(autoReviewFallbackEngaged(), false);
});

test("a reviewer must be a routed slug, never a native one", () => {
  assert.throws(() => setAutoReviewFallback("gpt-6-astra"), /not a routed model slug/);
  assert.throws(() => setAutoReviewFallback(""), /routed model slug is required/);
  assert.equal(readAutoReviewFallback().model, undefined);
});

test("the configured reviewer round-trips through protected state", () => {
  const snapshot = setAutoReviewFallback("kimi-oauth/k3");
  assert.equal(snapshot.model, "kimi-oauth/k3");
  // Configured is not engaged: the native reviewer still has quota as far as
  // anyone knows, so criterion 1 keeps approvals on it.
  assert.equal(snapshot.reviewer, AUTO_REVIEW_MODEL);
  assert.equal(autoReviewFallbackEngaged(), false);
  assert.equal(privateFileIsProtected(AUTO_REVIEW_FALLBACK_PATH), true);
});

test("a quota refusal engages the fallback for the window the upstream named", () => {
  const now = Date.UTC(2026, 8, 17, 12, 0, 0);
  const verdict = classifyRoutedFailure({
    status: 429,
    bodyText: JSON.stringify({ error: { message: "You have hit your usage limit." } }),
    retryAfterSeconds: 1_800,
    now,
  });
  assert.equal(verdict.swap, true);

  const snapshot = recordAutoReviewExhaustion({ ...verdict, now });
  assert.equal(snapshot.nativeExhaustedUntil, new Date(now + 1_800_000).toISOString());
  assert.equal(snapshot.reviewer, "kimi-oauth/k3");
  assert.equal(autoReviewFallbackEngaged({ now: now + 60_000 }), true);
  // Criterion 5: the window ends by itself, with nobody doing anything.
  assert.equal(autoReviewFallbackEngaged({ now: now + 1_800_001 }), false);
  assert.equal(readAutoReviewFallback({ now: now + 1_800_001 }).exhaustedUntil, undefined);
  // ...and the configured reviewer survives the window expiring.
  assert.equal(readAutoReviewFallback({ now: now + 1_800_001 }).model, "kimi-oauth/k3");
});

test("a window is capped at six hours however long the upstream claims", () => {
  const now = Date.UTC(2026, 8, 17, 12, 0, 0);
  const snapshot = recordAutoReviewExhaustion({
    until: new Date(now + 72 * 60 * 60 * 1_000).toISOString(),
    reason: "out_of_usage",
    now,
  });
  assert.equal(snapshot.nativeExhaustedUntil, new Date(now + 6 * 60 * 60 * 1_000).toISOString());
});

test("a refusal that named no window still stops a burst re-asking every approval", () => {
  const now = Date.UTC(2026, 8, 17, 12, 0, 0);
  const snapshot = recordAutoReviewExhaustion({ reason: "out_of_usage", now });
  // Short on purpose. Nothing was stated, so nothing is invented beyond enough
  // to stop each command in the same minute paying for the same rejection.
  assert.equal(snapshot.nativeExhaustedUntil, new Date(now + 60_000).toISOString());
  assert.equal(autoReviewFallbackEngaged({ now: now + 59_000 }), true);
  assert.equal(autoReviewFallbackEngaged({ now: now + 61_000 }), false);
});

test("any native reviewer answer clears the window", () => {
  recordAutoReviewExhaustion({ until: new Date(Date.now() + 3_600_000).toISOString() });
  assert.equal(autoReviewFallbackEngaged(), true);
  assert.equal(clearAutoReviewExhaustion(), true);
  assert.equal(autoReviewFallbackEngaged(), false);
  // Still configured; only the window went.
  assert.equal(readAutoReviewFallback().model, "kimi-oauth/k3");
  assert.equal(clearAutoReviewExhaustion(), false, "clearing twice is a no-op");
});

// Acceptance criterion 4, and the safety paragraph of #787: the classifier is
// the routed path's, so these are the answers it already gives. Asserting them
// here is what keeps the reviewer bound to that one definition of "out of
// quota" rather than growing a looser one of its own.
test("only a quota refusal engages the fallback", () => {
  const cases = [
    { label: "a deny decision", status: 200, bodyText: JSON.stringify({ decision: "deny" }) },
    { label: "a policy rejection", status: 403, bodyText: JSON.stringify({ error: { message: "Request blocked by policy." } }) },
    { label: "a missing entitlement", status: 403, bodyText: JSON.stringify({ error: { message: "Your plan does not include API access. Please upgrade your plan." } }) },
    { label: "a bad request", status: 400, bodyText: JSON.stringify({ error: { message: "Invalid input." } }) },
    { label: "an unauthorized session", status: 401, bodyText: JSON.stringify({ error: { message: "Unauthorized" } }) },
    { label: "a server error", status: 500, bodyText: "upstream exploded" },
    { label: "a gateway timeout", status: 504, bodyText: "" },
    { label: "a malformed body", status: 429, bodyText: "<html>nope</html>" },
    { label: "a short rate limit", status: 429, bodyText: "", retryAfterSeconds: 5 },
  ];
  for (const { label, ...failure } of cases) {
    assert.equal(
      classifyRoutedFailure(failure).swap,
      false,
      `${label} must never be read as the reviewer's quota running out`,
    );
  }
});

test("a damaged document reads as no fallback rather than as consent", () => {
  clearAutoReviewFallback();
  writeFileSync(AUTO_REVIEW_FALLBACK_PATH, "{ not json");
  assert.equal(readAutoReviewFallback().model, undefined);
  assert.equal(autoReviewFallbackEngaged(), false);

  writeFileSync(AUTO_REVIEW_FALLBACK_PATH, JSON.stringify({ version: 99, model: "kimi-oauth/k3" }));
  assert.equal(readAutoReviewFallback().model, undefined, "an unknown version is not consent");
  assert.equal(autoReviewFallbackEngaged(), false);
});

test("clearing removes the whole document", () => {
  setAutoReviewFallback("kimi-oauth/k3");
  assert.deepEqual(clearAutoReviewFallback(), {
    model: null,
    nativeExhaustedUntil: null,
    reason: null,
    observedAt: null,
    reviewer: AUTO_REVIEW_MODEL,
    path: AUTO_REVIEW_FALLBACK_PATH,
  });
});
