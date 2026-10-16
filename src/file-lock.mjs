import fs from "node:fs";
import { setTimeout as delay } from "node:timers/promises";

/**
 * proper-lockfile 4.1.2 does not check whether a lease was released before
 * handling a pending heartbeat stat. That callback can throw ECOMPROMISED
 * after unlock, or start a new utimes against a reacquired directory. Stop
 * delivering this lease's stat callbacks after release begins, using the
 * public fs option. Active callbacks and onCompromised remain unchanged.
 * Load the dependency lazily so setup can still reach dependency repair.
 * This does not fence an already-dispatched utimes or an unreleased stale
 * lease; those remain proper-lockfile's existing filesystem limitations.
 */
export async function acquireFileLock(file, options = {}) {
  const { default: lockfile } = await import("proper-lockfile");
  const sourceFs = options.fs || fs;
  let releaseStarted = false;

  const release = await lockfile.lock(file, {
    ...options,
    fs: {
      ...sourceFs,
      stat(...args) {
        const callback = args.pop();
        return sourceFs.stat(...args, (...result) => {
          if (!releaseStarted) return callback(...result);
        });
      },
    },
  });

  return () => {
    // The official 4.1.2 release adapter marks the captured lease inactive and
    // cancels its heartbeat synchronously before rmdir. Set our guard first:
    // a custom fs.rmdir can reentrantly deliver a pending stat during that call.
    releaseStarted = true;
    return release();
  };
}

// Retry only a held lease, with the caller's execution deadline as the bound.
// Never abandon a pending acquisition: it could acquire a lease after abort.
export async function acquireFileLockWithSignal(file, options = {}, { signal, retryMs = 25 } = {}) {
  while (true) {
    signal?.throwIfAborted();
    let release;
    try {
      release = await acquireFileLock(file, { ...options, retries: 0 });
    } catch (error) {
      signal?.throwIfAborted();
      if (error?.code !== "ELOCKED") throw error;
      try { await delay(retryMs, undefined, { signal }); } catch (error) {
        signal?.throwIfAborted();
        throw error;
      }
      continue;
    }
    if (signal?.aborted) {
      await runWithLockRelease(() => signal.throwIfAborted(), release);
    }
    return release;
  }
}

// An unlock error must be visible without replacing the failure that caused
// cleanup. Keep the operation error's identity, including rollback markers.
export async function runWithLockRelease(operation, release) {
  let result;
  let operationError;
  let operationFailed = false;
  try {
    result = await operation();
  } catch (error) {
    operationFailed = true;
    operationError = error;
  }
  try {
    await release();
  } catch (error) {
    if (!operationFailed) throw error;
    if (operationError && typeof operationError === "object") {
      try { operationError.lockReleaseError = error; } catch {}
    }
  }
  if (operationFailed) throw operationError;
  return result;
}
