import { mkdirSync } from "node:fs";
import path from "node:path";

import lockfile from "proper-lockfile";

import { STATE_DIR } from "./paths.mjs";

const DEFAULT_WAIT_MS = 120_000;
const DEFAULT_RETRY_MS = 250;
// refresh-catalog synchronously runs Codex and catalog subprocesses. Those
// waits can keep Node's event loop from sending a heartbeat, so the stale
// horizon must comfortably exceed one complete healthy refresh.
const DEFAULT_STALE_MS = 10 * 60_000;
const DEFAULT_HEARTBEAT_MS = 10_000;

function positiveInteger(value, fallback, minimum = 1) {
  return Number.isFinite(value)
    ? Math.max(minimum, Math.floor(value))
    : fallback;
}

export function loginFreeRefreshLockTarget(stateDir = STATE_DIR) {
  return path.join(stateDir, "login-free-refresh-operation");
}

export async function withLoginFreeRefreshLock(
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
  const target = loginFreeRefreshLockTarget(stateDir);
  let release;
  try {
    release = await lockfile.lock(target, {
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
      const seconds = Math.max(1, Math.ceil(normalizedWaitMs / 1_000));
      const wrapped = new Error(
        `Another login-free catalog refresh is still running after ${seconds} second${seconds === 1 ? "" : "s"}. ` +
          "Wait for it to finish, then rerun bin/refresh-catalog; abandoned locks recover automatically.",
        { cause: error },
      );
      wrapped.code = "login_free_refresh_locked";
      throw wrapped;
    }
    throw error;
  }

  try {
    return await operation();
  } finally {
    await release();
  }
}
