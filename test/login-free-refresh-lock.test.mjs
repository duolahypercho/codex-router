import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import {
  existsSync,
  mkdtempSync,
  rmSync,
  utimesSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

import {
  loginFreeRefreshLockTarget,
  withLoginFreeRefreshLock,
} from "../src/login-free-refresh-lock.mjs";

const helperUrl = pathToFileURL(
  path.resolve("src", "login-free-refresh-lock.mjs"),
).href;

async function waitForLocked(child, stderr) {
  child.stdout.setEncoding("utf8");
  let output = "";
  while (!output.includes("locked\n")) {
    const winner = await Promise.race([
      once(child.stdout, "data").then(([chunk]) => ({ chunk })),
      once(child, "exit").then(([code, signal]) => ({ code, signal })),
    ]);
    if ("code" in winner) {
      assert.fail(
        `lock holder exited before acquiring the lock (${winner.code ?? winner.signal}): ${stderr()}`,
      );
    }
    output += winner.chunk;
  }
}

function spawnHolder(stateDir) {
  const script = `
    import { withLoginFreeRefreshLock } from ${JSON.stringify(helperUrl)};
    await withLoginFreeRefreshLock(async () => {
      process.stdout.write("locked\\n");
      await new Promise((resolve) => setTimeout(resolve, 6000));
    }, {
      stateDir: ${JSON.stringify(stateDir)},
      waitMs: 100,
      retryMs: 25,
      staleMs: 2000,
      heartbeatMs: 1000,
    });
  `;
  return spawn(process.execPath, ["--input-type=module", "--eval", script], {
    stdio: ["ignore", "pipe", "pipe"],
  });
}

test(
  "login-free refresh lock serializes processes and recovers an abandoned operation",
  { timeout: 10_000 },
  async () => {
    const stateDir = mkdtempSync(path.join(os.tmpdir(), "codex-router-login-free-lock-"));
    const child = spawnHolder(stateDir);
    let childStderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      childStderr += chunk;
    });

    try {
      await waitForLocked(child, () => childStderr);
      await assert.rejects(
        withLoginFreeRefreshLock(
          async () => assert.fail("overlapping refresh entered its transaction"),
          {
            stateDir,
            waitMs: 100,
            retryMs: 25,
            staleMs: 2_000,
            heartbeatMs: 1_000,
          },
        ),
        (error) => {
          assert.equal(error.code, "login_free_refresh_locked");
          assert.match(error.message, /rerun bin\/refresh-catalog/);
          return true;
        },
      );

      child.kill("SIGKILL");
      await once(child, "exit");
      const lockDirectory = `${loginFreeRefreshLockTarget(stateDir)}.lock`;
      assert.equal(existsSync(lockDirectory), true);
      const stale = new Date(Date.now() - 5_000);
      utimesSync(lockDirectory, stale, stale);
      assert.equal(
        await withLoginFreeRefreshLock(async () => "resumed", {
          stateDir,
          waitMs: 200,
          retryMs: 25,
          staleMs: 2_000,
          heartbeatMs: 1_000,
        }),
        "resumed",
      );
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      rmSync(stateDir, { recursive: true, force: true });
    }
  },
);
