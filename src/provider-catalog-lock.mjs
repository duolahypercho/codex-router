import { mkdirSync } from "node:fs";
import path from "node:path";

import { acquireFileLock } from "./file-lock.mjs";
import { STATE_DIR } from "./paths.mjs";

const DEFAULT_WAIT_MS = 120_000;
const DEFAULT_RETRY_MS = 100;
const DEFAULT_STALE_MS = 2 * 60_000;
const DEFAULT_HEARTBEAT_MS = 5_000;

function positiveInteger(value, fallback, minimum = 1) {
  return Number.isFinite(value)
    ? Math.max(minimum, Math.floor(value))
    : fallback;
}

export function providerCatalogLockTarget(stateDir = STATE_DIR) {
  return path.join(stateDir, "provider-catalog-transaction");
}

function lockWaitError(waitMs, cause) {
  const seconds = Math.max(1, Math.ceil(waitMs / 1_000));
  const error = new Error(
    `Another provider-catalog transaction is still running after ${seconds} second${seconds === 1 ? "" : "s"}. `
      + "Wait for that model discovery or credential change to finish, then retry; abandoned locks are recovered automatically.",
    { cause },
  );
  error.code = "provider_catalog_locked";
  return error;
}

// Network discovery runs outside this lock. A discovery takes one short
// snapshot transaction before fetching and one short compare-and-commit
// transaction afterward, so independent providers can still fetch in
// parallel. Credential writers use this same boundary for write+invalidation;
// the final comparison then refuses an answer fetched for an older account.
export async function withProviderCatalogLock(
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
  const target = providerCatalogLockTarget(stateDir);
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
        operationError.providerCatalogLockReleaseError = releaseError;
      } catch {
        // Preserve a frozen operation error rather than replacing its cause.
      }
    }
    throw operationError;
  }
  if (releaseError) {
    throw new Error(
      `The provider-catalog transaction completed, but its lock could not be released (${releaseError.message}).`,
      { cause: releaseError },
    );
  }
  return result;
}
