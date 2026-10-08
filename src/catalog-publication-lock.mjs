import { mkdirSync } from "node:fs";
import path from "node:path";

import { acquireFileLock } from "./file-lock.mjs";

import { STATE_DIR } from "./paths.mjs";

const DEFAULT_WAIT_MS = 120_000;
const DEFAULT_RETRY_MS = 250;
// Catalog publication can synchronously probe Codex for up to a minute before
// the event loop gets another turn. Keep the stale horizon comfortably beyond
// that blocking interval; proper-lockfile's updater then heartbeats every ten
// seconds whenever the process can run timers.
const DEFAULT_STALE_MS = 10 * 60_000;
const DEFAULT_HEARTBEAT_MS = 10_000;

function positiveInteger(value, fallback, minimum = 1) {
  return Number.isFinite(value)
    ? Math.max(minimum, Math.floor(value))
    : fallback;
}

export function catalogPublicationLockTarget(stateDir = STATE_DIR) {
  return path.join(stateDir, "catalog-publication");
}

function lockWaitError(waitMs, cause) {
  const seconds = Math.max(1, Math.ceil(waitMs / 1_000));
  const error = new Error(
    `Another Codex model catalog publication is still running after ${seconds} second${seconds === 1 ? "" : "s"}. ` +
      "Wait for that router command to finish, then retry; abandoned locks are recovered automatically.",
    { cause },
  );
  error.code = "catalog_publication_locked";
  return error;
}

// Every catalog producer (CLI commands, the control center, and autonomous
// refreshes) executes catalog.mjs in a separate process. The directory lock is
// an atomic, cross-platform rendezvous for those processes. It spans the whole
// caller operation so mutable inputs, native probes, and the coupled catalog /
// alias / announcement / agent publication observe one serialized snapshot.
export async function withCatalogPublicationLock(
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
  // proper-lockfile itself enforces this floor. Normalize it here as well so
  // retry and stale-recovery behavior match the values this helper reasons
  // about and exposes to focused tests.
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
  const target = catalogPublicationLockTarget(stateDir);
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
    if (error?.code === "ELOCKED") {
      throw lockWaitError(normalizedWaitMs, error);
    }
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

  // A release failure must not replace an operation error: catalog.mjs marks
  // safely rolled-back publication errors with catalogRollbackSafe, and the
  // original object has to reach its CLI boundary for exit 75 to survive.
  if (operationError) {
    if (releaseError && typeof operationError === "object") {
      try {
        operationError.catalogLockReleaseError = releaseError;
      } catch {
        // A frozen error still keeps its identity and rollback-safety marker.
      }
    }
    throw operationError;
  }
  if (releaseError) {
    throw new Error(
      `The Codex model catalog was published, but its publication lock could not be released (${releaseError.message}).`,
      { cause: releaseError },
    );
  }
  return result;
}
