import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
  STARTUP_BACKOFF_STEPS_MS,
  clearStartupAttempts,
  readStartupAttempts,
  recordStartupFailure,
  startupBackoffDisabled,
  startupBackoffRemainingMs,
  resetStartupAttempts,
  serviceStartupBackoffEnvironment,
} from "../src/startup-attempts.mjs";

const NOW = 1_790_000_000_000;

function withTempState(run) {
  const directory = mkdtempSync(path.join(os.tmpdir(), "codex-router-startup-attempts-"));
  try {
    return run(path.join(directory, "startup-attempts.json"), directory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function seed(statePath, record) {
  // Plain write: readStartupAttempts only parses, and seeding through the
  // hardened writer would spawn PowerShell for every case.
  writeFileSync(statePath, `${JSON.stringify(record)}\n`);
}

test("the back-off schedule grows and then holds", () => {
  assert.deepEqual([...STARTUP_BACKOFF_STEPS_MS], [60_000, 120_000, 240_000, 480_000, 900_000]);
  // Strictly non-decreasing, so a persistent failure can never be retried
  // faster than a transient one.
  for (let index = 1; index < STARTUP_BACKOFF_STEPS_MS.length; index += 1) {
    assert.ok(STARTUP_BACKOFF_STEPS_MS[index] >= STARTUP_BACKOFF_STEPS_MS[index - 1]);
  }
});

test("an absent, malformed, or elapsed record reports no wait", () => {
  withTempState((statePath) => {
    assert.equal(startupBackoffRemainingMs(readStartupAttempts(statePath), () => NOW), 0);

    seed(statePath, { version: 99, consecutiveFailures: 3, nextAttemptNotBefore: NOW + 60_000 });
    assert.equal(startupBackoffRemainingMs(readStartupAttempts(statePath), () => NOW), 0);

    seed(statePath, { version: 1, consecutiveFailures: 0, lastFailureAt: NOW, nextAttemptNotBefore: NOW + 60_000 });
    assert.equal(startupBackoffRemainingMs(readStartupAttempts(statePath), () => NOW), 0);

    seed(statePath, { version: 1, consecutiveFailures: 2, lastFailureAt: NOW, nextAttemptNotBefore: NOW });
    assert.equal(startupBackoffRemainingMs(readStartupAttempts(statePath), () => NOW), 0);

    // Otherwise valid, but with no failure age: the age is what bounds the
    // back-off, so a record without it cannot be honoured.
    seed(statePath, { version: 1, consecutiveFailures: 2, nextAttemptNotBefore: NOW + 600_000 });
    assert.equal(readStartupAttempts(statePath), undefined);
    assert.equal(startupBackoffRemainingMs(readStartupAttempts(statePath), () => NOW), 0);
  });
});

// The whole point: a record written by a failed attempt must actually hold the
// next automatic attempt back, and must stop holding it once the window passes.
test("a record inside its window reports the remaining wait", () => {
  withTempState((statePath) => {
    seed(statePath, { version: 1, consecutiveFailures: 2, lastFailureAt: NOW, nextAttemptNotBefore: NOW + 240_000 });
    assert.equal(startupBackoffRemainingMs(readStartupAttempts(statePath), () => NOW), 240_000);
    assert.equal(startupBackoffRemainingMs(readStartupAttempts(statePath), () => NOW + 239_999), 1);
    assert.equal(startupBackoffRemainingMs(readStartupAttempts(statePath), () => NOW + 240_000), 0);
  });
});

// The record is written from the system clock, so a skewed or hand-edited record
// must not be able to refuse automatic starts indefinitely. Two rules bound it:
// a record whose own age exceeds the largest step is expired (which releases in
// both skew directions), and the remaining wait is clamped to that step.
test("a skewed or corrupt record is bounded to one step past its failure", () => {
  withTempState((statePath) => {
    const ceiling = STARTUP_BACKOFF_STEPS_MS[STARTUP_BACKOFF_STEPS_MS.length - 1];

    // Far-future instant, recent failure: the wait is clamped, not honoured.
    seed(statePath, {
      version: 1,
      consecutiveFailures: 2,
      lastFailureAt: NOW,
      nextAttemptNotBefore: NOW + 30 * 24 * 60 * 60 * 1000,
    });
    assert.equal(startupBackoffRemainingMs(readStartupAttempts(statePath), () => NOW), ceiling);
    assert.equal(
      startupBackoffRemainingMs(readStartupAttempts(statePath), () => NOW + ceiling),
      ceiling,
    );
    // One step past the failure, the record is expired whatever it claims.
    assert.equal(
      startupBackoffRemainingMs(readStartupAttempts(statePath), () => NOW + ceiling + 1),
      0,
    );

    // A clock that jumped backwards makes the age negative, which also expires.
    seed(statePath, {
      version: 1,
      consecutiveFailures: 2,
      lastFailureAt: NOW + 60_000,
      nextAttemptNotBefore: NOW + 300_000,
    });
    assert.equal(startupBackoffRemainingMs(readStartupAttempts(statePath), () => NOW), 0);
  });
});

test("consecutive failures escalate to the cap and are readable", () => {
  withTempState((statePath) => {
    const first = recordStartupFailure({ statePath, now: () => NOW, reason: "venv-timeout" });
    assert.equal(first.consecutiveFailures, 1);
    assert.equal(first.nextAttemptNotBefore, NOW + 60_000);
    assert.equal(first.lastReason, "venv-timeout");

    let last = first;
    for (let index = 0; index < 10; index += 1) {
      last = recordStartupFailure({ statePath, now: () => NOW });
    }
    assert.equal(last.consecutiveFailures, 11);
    assert.equal(
      last.nextAttemptNotBefore - NOW,
      STARTUP_BACKOFF_STEPS_MS[STARTUP_BACKOFF_STEPS_MS.length - 1],
    );
    assert.equal(readStartupAttempts(statePath).consecutiveFailures, 11);
  });
});

test("the failure counter remains readable at the safe integer ceiling", () => {
  withTempState((statePath) => {
    seed(statePath, {
      version: 1,
      consecutiveFailures: Number.MAX_SAFE_INTEGER,
      lastFailureAt: NOW,
      nextAttemptNotBefore: NOW + 900_000,
    });
    for (let index = 0; index < 2; index += 1) {
      const record = recordStartupFailure({ statePath, now: () => NOW });
      assert.equal(record.consecutiveFailures, Number.MAX_SAFE_INTEGER);
      assert.equal(record.nextAttemptNotBefore, NOW + 900_000);
      assert.deepEqual(readStartupAttempts(statePath), record);
    }
  });
});

test("one clock sample determines both failure age and remaining cooldown", () => {
  let samples = 0;
  const remaining = startupBackoffRemainingMs({
    lastFailureAt: NOW,
    nextAttemptNotBefore: NOW + 60_000,
  }, () => NOW + samples++ * 120_000);
  assert.equal(remaining, 60_000);
  assert.equal(samples, 1);
});

test("clearing removes the record", () => {
  withTempState((statePath) => {
    recordStartupFailure({ statePath, now: () => NOW });
    assert.ok(readStartupAttempts(statePath));
    clearStartupAttempts(statePath);
    assert.equal(readStartupAttempts(statePath), undefined);
    // Clearing an absent record is not an error: an explicit start clears
    // unconditionally, and most starts have nothing to clear.
    clearStartupAttempts(statePath);
  });
});

test("the kill switch bypasses the gate", () => {
  assert.equal(startupBackoffDisabled({ CODEX_ROUTER_DISABLE_STARTUP_BACKOFF: "1" }), true);
  assert.equal(startupBackoffDisabled({}), false);
  assert.equal(startupBackoffDisabled({ CODEX_ROUTER_DISABLE_STARTUP_BACKOFF: "0" }), false);
});

// It runs inside a startup failure handler, so a write that cannot happen must
// not turn the failure into a crash.
test("recording a failure never throws when the state cannot be written", () => {
  withTempState((_statePath, directory) => {
    // A directory where the file should be: the write cannot succeed.
    const record = recordStartupFailure({ statePath: directory, now: () => NOW });
    assert.equal(record.consecutiveFailures, 1);
  });
});

test("only fixed classifications are persisted, and optional resets never throw", () => {
  withTempState((statePath, directory) => {
    recordStartupFailure({ statePath, reason: "secret arbitrary error material" });
    assert.doesNotMatch(readFileSync(statePath, "utf8"), /secret arbitrary/);
    assert.throws(() => resetStartupAttempts({ statePath: directory }), /Could not reset automatic startup cooldown.*The service was not launched/);
    assert.equal(resetStartupAttempts({ statePath: directory, required: false }), false);
  });
});

test("service environments carry only explicitly supplied boolean settings", () => {
  for (const value of ["0", "1"]) assert.deepEqual(serviceStartupBackoffEnvironment({ CODEX_ROUTER_DISABLE_STARTUP_BACKOFF: value }), { CODEX_ROUTER_DISABLE_STARTUP_BACKOFF: value });
  for (const value of [undefined, "true", " 1", "1\nINJECT=value"]) assert.deepEqual(serviceStartupBackoffEnvironment({ CODEX_ROUTER_DISABLE_STARTUP_BACKOFF: value }), {});
});

test("an unredirected test cannot clear installed cooldown state", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "startup-cache-guard-"));
  const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const env = { ...process.env, HOME: directory, USERPROFILE: directory, CODEX_HOME: path.join(directory, "codex"), MODEL_ROUTER_STATE_DIR: "", CODEX_ROUTER_STATE_DIR: "", NODE_TEST_CONTEXT: "child-v8" };
  try {
    const probe = spawnSync(process.execPath, ["--input-type=module", "-e", 'import {STARTUP_ATTEMPTS_PATH} from "./src/startup-attempts.mjs"; console.log(STARTUP_ATTEMPTS_PATH);'], { cwd: sourceRoot, env, encoding: "utf8" });
    assert.equal(probe.status, 0, probe.stderr);
    const statePath = probe.stdout.trim();
    assert.ok(statePath.startsWith(directory));
    mkdirSync(path.dirname(statePath), { recursive: true });
    writeFileSync(statePath, "sentinel");
    const clear = spawnSync(process.execPath, ["--input-type=module", "-e", 'import {clearStartupAttempts} from "./src/startup-attempts.mjs"; clearStartupAttempts();'], { cwd: sourceRoot, env, encoding: "utf8" });
    assert.notEqual(clear.status, 0);
    assert.match(clear.stderr, /Refusing to write the automatic startup cooldown state/);
    assert.equal(readFileSync(statePath, "utf8"), "sentinel");
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
