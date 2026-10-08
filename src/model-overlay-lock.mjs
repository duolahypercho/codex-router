import { mkdirSync } from "node:fs";
import path from "node:path";

import { acquireFileLock } from "./file-lock.mjs";

import { STATE_DIR } from "./paths.mjs";

const DEFAULT_WAIT_MS = 120_000;
const DEFAULT_RETRY_MS = 250;
// The lock covers only state mutation, publication, and rollback. Detached
// model downloads happen before it is acquired. Keep the stale horizon beyond
// the synchronous Codex probes a catalog publication can perform, while the
// heartbeat makes a live async transaction safe to wait on.
const DEFAULT_STALE_MS = 10 * 60_000;
const DEFAULT_HEARTBEAT_MS = 10_000;

function positiveInteger(value, fallback, minimum = 1) {
  return Number.isFinite(value)
    ? Math.max(minimum, Math.floor(value))
    : fallback;
}

export function modelOverlayLockTarget(stateDir = STATE_DIR) {
  return path.join(stateDir, "model-overlay-transaction");
}

function lockWaitError(waitMs, cause) {
  const seconds = Math.max(1, Math.ceil(waitMs / 1_000));
  const error = new Error(
    `Another model-overlay transaction is still running after ${seconds} second${seconds === 1 ? "" : "s"}. ` +
      "Wait for that router command to finish, then retry; abandoned locks are recovered automatically.",
    { cause },
  );
  error.code = "model_overlay_locked";
  return error;
}

/**
 * Serialize the complete model-overlay transaction across CLI, tray, desktop,
 * and detached worker processes. The catalog publisher has its own lock and
 * is entered by a fresh child while this lock is held; the two locks therefore
 * never nest in one process and read-only catalog/status calls remain unlocked.
 */
export async function withModelOverlayLock(
  operation,
  {
    stateDir = STATE_DIR,
    waitMs = DEFAULT_WAIT_MS,
    retryMs = DEFAULT_RETRY_MS,
    staleMs = DEFAULT_STALE_MS,
    heartbeatMs = DEFAULT_HEARTBEAT_MS,
  } = {},
) {
  const normalizedWaitMs = positiveInteger(waitMs, DEFAULT_WAIT_MS, 0);
  const normalizedRetryMs = positiveInteger(retryMs, DEFAULT_RETRY_MS);
  const normalizedStaleMs = positiveInteger(staleMs, DEFAULT_STALE_MS, 2_000);
  const normalizedHeartbeatMs = Math.min(
    positiveInteger(heartbeatMs, DEFAULT_HEARTBEAT_MS, 1_000),
    normalizedStaleMs / 2,
  );
  const retries = Math.max(
    0,
    Math.ceil(normalizedWaitMs / normalizedRetryMs) - 1,
  );

  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const target = modelOverlayLockTarget(stateDir);
  let release;
  try {
    release = await acquireFileLock(target, {
      realpath: false,
      lockfilePath: `${target}.lock`,
      stale: normalizedStaleMs,
      update: normalizedHeartbeatMs,
      retries: {
        retries,
        factor: 1,
        minTimeout: normalizedRetryMs,
        maxTimeout: normalizedRetryMs,
        randomize: false,
      },
    });
  } catch (error) {
    if (error?.code === "ELOCKED") throw lockWaitError(normalizedWaitMs, error);
    throw error;
  }

  let result;
  let operationError;
  try {
    result = await operation();
  } catch (error) {
    operationError = error;
  }

  let releaseError;
  try {
    await release();
  } catch (error) {
    releaseError = error;
  }

  if (operationError) {
    if (releaseError && typeof operationError === "object") {
      try {
        operationError.modelOverlayLockReleaseError = releaseError;
      } catch {
        // Preserve the original operation error even if it is frozen.
      }
    }
    throw operationError;
  }
  if (releaseError) {
    throw new Error(
      `The model-overlay transaction completed, but its lock could not be released (${releaseError.message}).`,
      { cause: releaseError },
    );
  }
  return result;
}
