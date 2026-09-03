import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { diagnoseWindowsLaunchFailure, readLogTail } from "../src/windows-launch-diagnosis.mjs";

const CHECKOUT = "C:\\Users\\operator\\AppData\\Local\\codex-router";
const START = `${CHECKOUT}\\src\\start.mjs`;

function moduleError(modulePath) {
  return [
    "Error: Cannot find module '" + modulePath + "'",
    "    at Function._resolveFilename (node:internal/modules/cjs/loader)",
    "  code: 'MODULE_NOT_FOUND'",
  ].join("\n");
}

test("a module the loader named but that exists is reported as a permission failure", () => {
  // Issue #548: the installer creates the checkout, the task exits 1, and the
  // log names a file the operator can open. Node reports an unreadable module
  // exactly as it reports an absent one, so the existence check is the only
  // thing that separates them.
  const message = diagnoseWindowsLaunchFailure({
    logText: moduleError(START),
    exists: (candidate) => candidate === START,
  });
  assert.match(message, /but that file exists/);
  assert.match(message, /token could not read it/);
  assert.match(message, /Limited level/);
  assert.match(message, /icacls/);
  assert.ok(message.includes(START), "the operator needs the exact path named");
});

test("a module that really is absent is reported as an incomplete checkout", () => {
  const message = diagnoseWindowsLaunchFailure({
    logText: moduleError(START),
    exists: () => false,
  });
  assert.match(message, /it is in fact absent/);
  assert.match(message, /re-run the installer/);
  assert.doesNotMatch(message, /token could not read it/);
});

test("the most recent launch decides the verdict", () => {
  // A long-lived log holds older failures; only the newest launch is being
  // diagnosed, so an earlier absent module must not outvote a present one.
  const older = `${CHECKOUT}\\src\\gone.mjs`;
  const message = diagnoseWindowsLaunchFailure({
    logText: `${moduleError(older)}\n${moduleError(START)}`,
    exists: (candidate) => candidate === START,
  });
  assert.match(message, /but that file exists/);
  assert.ok(message.includes(START));
  assert.ok(!message.includes(older));
});

test("a log with no module error adds nothing, so the caller keeps its own wording", () => {
  for (const logText of [
    "",
    "[codex-router] listening on 127.0.0.1:4202\n",
    "Error: listen EADDRINUSE: address already in use 127.0.0.1:4202\n",
  ]) {
    assert.equal(diagnoseWindowsLaunchFailure({ logText }), undefined, JSON.stringify(logText));
  }
  assert.equal(diagnoseWindowsLaunchFailure({ logText: undefined }), undefined);
  assert.equal(diagnoseWindowsLaunchFailure({}), undefined);
});

test("the log tail is read from the end and a missing or empty log is silent", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "launch-diagnosis-"));
  try {
    const absent = path.join(root, "nothing.log");
    assert.equal(readLogTail(absent), "");

    const empty = path.join(root, "empty.log");
    writeFileSync(empty, "");
    assert.equal(readLogTail(empty), "");

    // Only the window at the end is read, and the newest line survives it.
    const large = path.join(root, "router.log");
    writeFileSync(large, `${"filler line\n".repeat(20_000)}${moduleError(START)}\n`);
    const tail = readLogTail(large, { maxBytes: 4096 });
    assert.ok(tail.length <= 4096);
    assert.match(tail, /Cannot find module/);
    assert.equal(
      diagnoseWindowsLaunchFailure({ logText: tail, exists: () => true }).includes(START),
      true,
    );

    // A file smaller than the window is returned whole.
    const small = path.join(root, "small.log");
    writeFileSync(small, moduleError(START));
    assert.match(readLogTail(small, { maxBytes: 4096 }), /MODULE_NOT_FOUND/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
