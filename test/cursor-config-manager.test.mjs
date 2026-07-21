import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function run(command, stateDir) {
  const output = execFileSync(
    process.execPath,
    [path.join(root, "src", "cursor-config-manager.mjs"), command],
    {
      cwd: root,
      encoding: "utf8",
      env: {
        ...process.env,
        MODEL_ROUTER_TARGET: "cursor",
        MODEL_ROUTER_STATE_DIR: stateDir,
      },
    },
  );
  return JSON.parse(output);
}

test("cursor config manager tracks enable/disable state without touching any app config", () => {
  const stateDir = mkdtempSync(path.join(os.tmpdir(), "cursor-config-manager-"));
  try {
    // Defaults to disabled before any enable.
    const initial = run("status", stateDir);
    assert.equal(initial.target, "cursor");
    assert.equal(initial.enabled, false);
    assert.match(initial.baseUrl, /^http:\/\/127\.0\.0\.1:\d+\/v1$/);
    assert.ok(Array.isArray(initial.models) && initial.models.length > 0);

    const enabled = run("enable", stateDir);
    assert.equal(enabled.enabled, true);

    // The only artifact written is our own state file, inside the state dir.
    assert.deepEqual(readdirSync(stateDir), ["cursor-config-state.json"]);

    // Status is stable across a fresh process.
    assert.equal(run("status", stateDir).enabled, true);

    const disabled = run("disable", stateDir);
    assert.equal(disabled.enabled, false);
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("cursor config manager refuses malformed state", () => {
  const stateDir = mkdtempSync(path.join(os.tmpdir(), "cursor-config-manager-bad-"));
  try {
    writeFileSync(path.join(stateDir, "cursor-config-state.json"), "{ not json", {
      mode: 0o600,
    });
    assert.throws(() => run("status", stateDir));
    // The malformed file is left in place, never silently replaced.
    assert.ok(existsSync(path.join(stateDir, "cursor-config-state.json")));
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});
