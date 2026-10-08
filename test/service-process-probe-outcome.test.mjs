import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { SOURCE_ROOT } from "../src/paths.mjs";
import { isForegroundSupervisor, markForegroundSupervisor, shouldRecordServiceProcess, writeServiceProcessState } from "../src/service-process.mjs";

test("startup refusals carry the original typed probe failure", () => {
  for (const [failure, options] of [
    ["pid-invalid", { pid: 0 }],
    ["identity-unavailable", { identity: () => undefined }],
    ["command-line-unavailable", { commandLine: () => undefined }],
    ["command-line-mismatch", { commandLine: () => "/other/start.mjs" }],
  ]) {
    assert.throws(() => writeServiceProcessState({
      pid: process.pid, platform: "linux", identity: () => "verified-identity",
      commandLine: () => path.join(SOURCE_ROOT, "src/start.mjs"), ...options,
    }), error => {
      assert.equal(error.serviceProcessFailure, failure);
      assert.ok(error.message.includes(`(${failure})`));
      return true;
    });
  }
});

test("state write failures do not become unavailable identity probes", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "service-state-denied-"));
  const statePath = path.join(directory, "record-is-a-directory");
  mkdirSync(statePath);
  try {
    assert.throws(() => writeServiceProcessState({
      statePath, pid: process.pid, platform: "linux", identity: () => "verified-identity",
      commandLine: () => path.join(SOURCE_ROOT, "src/start.mjs"),
    }), error => { assert.equal(error.serviceProcessFailure, undefined); return true; });
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("foreground status uses the existing explicit marker on every platform", () => {
  assert.equal(isForegroundSupervisor(), false);
  assert.equal(shouldRecordServiceProcess({ platform: "win32" }), true);
  markForegroundSupervisor();
  assert.equal(isForegroundSupervisor(), true);
  assert.equal(shouldRecordServiceProcess({ platform: "win32" }), false);
});
