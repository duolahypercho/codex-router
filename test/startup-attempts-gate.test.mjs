import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const START = path.join(root, "src", "start.mjs");
const BACKOFF_EXIT_CODE = 69;
// The startup path probes the bundled virtualenv before it reaches the secret
// check, and that probe is allowed 45s on a starved host. The test only needs
// the process to get as far as the gate or the check, so this is a ceiling on
// the probe rather than an expectation.
const TIMEOUT_MS = 120_000;

// The gate is exercised against the real entrypoint rather than a unit seam,
// because the thing being verified is that the process a scheduled task
// launches actually stops early. CODEX_ROUTER_STATE_DIR points the whole run at
// a throwaway state directory, so nothing here can touch the live service.
function runStartWith(record) {
  const directory = mkdtempSync(path.join(os.tmpdir(), "codex-router-backoff-gate-"));
  try {
    if (record) {
      writeFileSync(
        path.join(directory, "startup-attempts.json"),
        `${JSON.stringify(record)}\n`,
      );
    }
    const result = spawnSync(process.execPath, [START], {
      cwd: root,
      encoding: "utf8",
      timeout: TIMEOUT_MS,
      env: {
        ...process.env,
        CODEX_ROUTER_STATE_DIR: directory,
        MODEL_ROUTER_STATE_DIR: directory,
        MODEL_ROUTER_QUIET: "1",
      },
    });
    return { status: result.status, output: `${result.stdout || ""}${result.stderr || ""}` };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test("a back-off record stops the automatic start before any work", () => {
  const { status, output } = runStartWith({
    version: 1,
    consecutiveFailures: 4,
    lastFailureAt: Date.now() - 1000,
    nextAttemptNotBefore: Date.now() + 600_000,
    lastReason: "test fixture",
  });
  assert.equal(status, BACKOFF_EXIT_CODE, output.slice(-2000));
  assert.match(output, /backing off for another \d+s/);
  assert.match(output, /consecutive failed start/);
  // It says how to get out, because the reader is an operator whose service is
  // down and who must not have to read the source to learn the escape hatch.
  assert.match(output, /service restart` clears this/);
  assert.match(output, /CODEX_ROUTER_DISABLE_STARTUP_BACKOFF=1/);
  // And it did not run the startup pipeline: no service key complaint, which is
  // what the same run reports when the gate lets it through.
  assert.doesNotMatch(output, /Internal service key is missing/);
});

test("an elapsed back-off record does not hold the start back", () => {
  const { status, output } = runStartWith({
    version: 1,
    consecutiveFailures: 4,
    lastFailureAt: Date.now() - 600_000,
    nextAttemptNotBefore: Date.now() - 1000,
  });
  assert.notEqual(status, BACKOFF_EXIT_CODE, output.slice(-2000));
  assert.doesNotMatch(output, /backing off/);
  // It reached the startup pipeline, which is the proof the gate opened. Which
  // check it then fails depends on the checkout -- a full install has a gateway
  // and no service key here, a bare clone has no virtualenv -- so the assertion
  // is that it got past the gate into one of them, not which one.
  assert.match(output, /(LiteLLM is not installed|Internal service key is missing)/);
});

test("the kill switch bypasses a live back-off record", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "codex-router-backoff-switch-"));
  try {
    writeFileSync(
      path.join(directory, "startup-attempts.json"),
      `${JSON.stringify({
        version: 1,
        consecutiveFailures: 4,
        lastFailureAt: Date.now(),
        nextAttemptNotBefore: Date.now() + 600_000,
      })}\n`,
    );
    const result = spawnSync(process.execPath, [START], {
      cwd: root,
      encoding: "utf8",
      timeout: TIMEOUT_MS,
      env: {
        ...process.env,
        CODEX_ROUTER_STATE_DIR: directory,
        MODEL_ROUTER_STATE_DIR: directory,
        MODEL_ROUTER_QUIET: "1",
        CODEX_ROUTER_DISABLE_STARTUP_BACKOFF: "1",
      },
    });
    const output = `${result.stdout || ""}${result.stderr || ""}`;
    assert.notEqual(result.status, BACKOFF_EXIT_CODE, output.slice(-2000));
    assert.doesNotMatch(output, /backing off/);
    assert.match(output, /(LiteLLM is not installed|Internal service key is missing)/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
