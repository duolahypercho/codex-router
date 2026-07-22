import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { withServiceOperationLock } from "../src/service-operation-lock.mjs";

test("service operation lock rejects overlap and releases afterward", { timeout: 5_000 }, async () => {
  const stateDir = mkdtempSync(path.join(os.tmpdir(), "codex-router-service-lock-"));
  let allowFirstToFinish;
  const firstCanFinish = new Promise((resolve) => {
    allowFirstToFinish = resolve;
  });
  let markFirstEntered;
  const firstEntered = new Promise((resolve) => {
    markFirstEntered = resolve;
  });

  const first = withServiceOperationLock(async () => {
    markFirstEntered();
    await firstCanFinish;
    return "first";
  }, { stateDir, waitMs: 100, retryMs: 10, staleMs: 5_000 });

  try {
    await firstEntered;
    await assert.rejects(
      withServiceOperationLock(
        async () => "overlap",
        { stateDir, waitMs: 50, retryMs: 10, staleMs: 5_000 },
      ),
      /Another background-service operation is still running/,
    );

    allowFirstToFinish();
    assert.equal(await first, "first");
    assert.equal(
      await withServiceOperationLock(
        async () => "second",
        { stateDir, waitMs: 100, retryMs: 10, staleMs: 5_000 },
      ),
      "second",
    );
    await assert.rejects(
      withServiceOperationLock(
        async () => {
          throw new Error("operation failed");
        },
        { stateDir, waitMs: 100, retryMs: 10, staleMs: 5_000 },
      ),
      /operation failed/,
    );
    assert.equal(
      await withServiceOperationLock(
        async () => "after failure",
        { stateDir, waitMs: 100, retryMs: 10, staleMs: 5_000 },
      ),
      "after failure",
    );
  } finally {
    allowFirstToFinish();
    await first.catch(() => {});
    rmSync(stateDir, { recursive: true, force: true });
  }
});
