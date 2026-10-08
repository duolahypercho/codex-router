import { mkdirSync } from "node:fs";
import path from "node:path";
import { acquireFileLock } from "./file-lock.mjs";
import { STATE_DIR } from "./paths.mjs";

const DEFAULT_WAIT_MS = 15_000;
const DEFAULT_RETRY_MS = 100;
const DEFAULT_STALE_MS = 10 * 60_000;
const DEFAULT_HEARTBEAT_MS = 10_000;

function positiveInteger(value, fallback, minimum = 1) {
  return Number.isFinite(value) ? Math.max(minimum, Math.floor(value)) : fallback;
}

export function callerKeyRotationLockTarget(stateDir = STATE_DIR) {
  return path.join(stateDir, "caller-key-rotation");
}

export async function withCallerKeyRotationLock(operation, {
  stateDir = STATE_DIR, waitMs = DEFAULT_WAIT_MS, retryMs = DEFAULT_RETRY_MS,
  staleMs = DEFAULT_STALE_MS, heartbeatMs = DEFAULT_HEARTBEAT_MS,
} = {}) {
  const normalizedWaitMs = positiveInteger(waitMs, DEFAULT_WAIT_MS, 0);
  const normalizedRetryMs = positiveInteger(retryMs, DEFAULT_RETRY_MS);
  const normalizedStaleMs = positiveInteger(staleMs, DEFAULT_STALE_MS, 2_000);
  const normalizedHeartbeatMs = Math.min(
    positiveInteger(heartbeatMs, DEFAULT_HEARTBEAT_MS, 1_000), normalizedStaleMs / 2,
  );
  const retries = Math.max(0, Math.ceil(normalizedWaitMs / normalizedRetryMs) - 1);
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const target = callerKeyRotationLockTarget(stateDir);
  let release;
  try {
    release = await acquireFileLock(target, {
      realpath: false, lockfilePath: `${target}.lock`, stale: normalizedStaleMs,
      update: normalizedHeartbeatMs,
      retries: { retries, factor: 1, minTimeout: normalizedRetryMs, maxTimeout: normalizedRetryMs, randomize: false },
    });
  } catch (error) {
    if (error?.code === "ELOCKED") {
      const locked = new Error("Another caller capability rotation is still running; retry shortly.", { cause: error });
      locked.code = "caller_key_rotation_locked";
      throw locked;
    }
    throw error;
  }
  let result;
  let operationError;
  try { result = await operation(); } catch (error) { operationError = error; }
  let releaseError;
  try { await release(); } catch (error) { releaseError = error; }
  if (operationError) {
    if (releaseError && typeof operationError === "object") {
      try { operationError.callerKeyRotationLockReleaseError = releaseError; } catch {}
    }
    throw operationError;
  }
  if (releaseError) {
    throw new Error(`Caller capability rotation completed, but its lock could not be released (${releaseError.message}).`, { cause: releaseError });
  }
  return result;
}
