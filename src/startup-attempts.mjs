import { readFileSync, unlinkSync } from "node:fs";
import path from "node:path";

import { writePrivateJson } from "./file-security.mjs";
import { STATE_DIR } from "./paths.mjs";

const STATE_VERSION = 1;
export const STARTUP_ATTEMPTS_PATH = path.join(STATE_DIR, "startup-attempts.json");

// The launcher task fires every minute so a healthy service is supervised
// closely, but a service that CANNOT start must not be retried at that rate
// forever. Measured 2026-09-23: a host whose powershell.exe was cold refused to
// start for forty minutes, and every one of those retries spent seconds to
// minutes spawning probes on the same saturated host -- a feedback loop where
// the retries helped keep the machine too busy to recover. The steps below give
// the host room to come back, and the cap keeps a recovered host from waiting
// long: 1, 2, 4, 8, then 15 minutes.
export const STARTUP_BACKOFF_STEPS_MS = Object.freeze([
  60_000,
  120_000,
  240_000,
  480_000,
  900_000,
]);

// The back-off exists to slow AUTOMATIC retries, never to refuse an operator.
// `service start`/`restart` clears the record before it issues its run, and this
// switch is the way out if the record itself ever misbehaves.
const DISABLE_ENV = "CODEX_ROUTER_DISABLE_STARTUP_BACKOFF";

// Distinct from 1 so the task's LastTaskResult says "deliberately skipped"
// rather than "failed", and distinct from the readiness timeout's 75 so the two
// temporary conditions stay tellable apart.
export const STARTUP_BACKOFF_EXIT_CODE = 69;

export function startupBackoffDisabled(environment = process.env) {
  return String(environment[DISABLE_ENV] || "") === "1";
}

export function readStartupAttempts(statePath = STARTUP_ATTEMPTS_PATH) {
  try {
    const record = JSON.parse(readFileSync(statePath, "utf8"));
    if (record?.version !== STATE_VERSION) return undefined;
    if (!Number.isSafeInteger(record.consecutiveFailures) || record.consecutiveFailures < 1) {
      return undefined;
    }
    if (!Number.isFinite(record.nextAttemptNotBefore)) return undefined;
    // Required, not optional: the age of the failure is what bounds the
    // back-off, so a record without it cannot be honoured.
    if (!Number.isFinite(record.lastFailureAt)) return undefined;
    return record;
  } catch {
    return undefined;
  }
}

export function clearStartupAttempts(statePath = STARTUP_ATTEMPTS_PATH) {
  try {
    unlinkSync(statePath);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

// How long the next attempt must wait. Zero means "start now", which is also
// the answer for a record that is absent, malformed, or already elapsed.
//
// Two guards, both there because the record is written from the system clock:
//
//   * a record whose own AGE exceeds the largest step is expired. That single
//     rule releases in both skew directions -- a clock that jumped backwards
//     makes the age negative, and a clock that jumped forwards makes it huge --
//     and it is consistent, because the largest step is the longest window any
//     legitimate record can carry;
//   * the remaining wait is clamped to that same step, so a structurally
//     corrupt instant cannot be reported as a longer wait than the schedule
//     allows.
//
// Together they bound the automatic refusal to one step past the last recorded
// failure. Without them, a skewed or hand-edited record refuses automatic starts
// for as long as the skew lasts, and the only escapes are an explicit command or
// the kill switch.
export function startupBackoffRemainingMs(record, now = Date.now) {
  if (!record) return 0;
  const ceiling = STARTUP_BACKOFF_STEPS_MS[STARTUP_BACKOFF_STEPS_MS.length - 1];
  const elapsed = now() - record.lastFailureAt;
  if (!Number.isFinite(elapsed) || elapsed < 0 || elapsed > ceiling) return 0;
  const remaining = record.nextAttemptNotBefore - now();
  if (!Number.isFinite(remaining) || remaining <= 0) return 0;
  return Math.min(remaining, ceiling);
}

// Record one failed start and return the updated record. Called from the
// startup failure path, so it must never throw: a failure that cannot be
// recorded is still a failure the caller has to report.
export function recordStartupFailure({ statePath = STARTUP_ATTEMPTS_PATH, now = Date.now, reason } = {}) {
  const previous = readStartupAttempts(statePath);
  const consecutiveFailures = (previous?.consecutiveFailures ?? 0) + 1;
  const step = STARTUP_BACKOFF_STEPS_MS[
    Math.min(consecutiveFailures, STARTUP_BACKOFF_STEPS_MS.length) - 1
  ];
  const at = now();
  const record = {
    version: STATE_VERSION,
    consecutiveFailures,
    lastFailureAt: at,
    nextAttemptNotBefore: at + step,
    ...(reason ? { lastReason: String(reason).slice(0, 400) } : {}),
  };
  try {
    writePrivateJson(statePath, record, {
      // Not a credential, and losing this record must not turn a startup
      // failure into a crash inside its own error handler.
      hardenFailure: "warn",
    });
  } catch {
    // The caller is already on a failure path; the record is an optimisation
    // for the next attempt, not a precondition for reporting this one.
  }
  return record;
}
