import { mkdirSync } from "node:fs";
import path from "node:path";

import lockfile from "proper-lockfile";

import { STATE_DIR } from "./paths.mjs";

export async function withServiceOperationLock(
  operation,
  {
    stateDir = STATE_DIR,
    waitMs = 15_000,
    retryMs = 100,
    staleMs = 90_000,
  } = {},
) {
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const target = path.join(stateDir, "service-operation");
  const retries = Math.max(0, Math.ceil(waitMs / retryMs) - 1);
  let release;
  try {
    release = await lockfile.lock(target, {
      realpath: false,
      lockfilePath: `${target}.lock`,
      stale: staleMs,
      update: Math.min(10_000, staleMs / 2),
      retries: {
        retries,
        factor: 1,
        minTimeout: retryMs,
        maxTimeout: retryMs,
        randomize: false,
      },
    });
  } catch (error) {
    if (error?.code === "ELOCKED") {
      throw new Error("Another background-service operation is still running; retry shortly.", {
        cause: error,
      });
    }
    throw error;
  }

  try {
    return await operation();
  } finally {
    await release();
  }
}
