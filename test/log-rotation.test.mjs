import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { DEFAULT_MAX_LOG_BYTES, logRotationPlan, rotateLog } from "../src/log-rotation.mjs";

function scratch() {
  return mkdtempSync(path.join(os.tmpdir(), "log-rotation-"));
}

test("a log under the cap is left alone", () => {
  assert.equal(DEFAULT_MAX_LOG_BYTES, 32 * 1024 * 1024);
  assert.equal(logRotationPlan(0), "keep");
  assert.equal(logRotationPlan(DEFAULT_MAX_LOG_BYTES), "keep");
  assert.equal(logRotationPlan(DEFAULT_MAX_LOG_BYTES + 1), "rotate");
});

test("an unreadable size never triggers rotation", () => {
  // Housekeeping must not act on a number it does not trust; the service has
  // to start either way.
  assert.equal(logRotationPlan(Number.NaN), "keep");
  assert.equal(logRotationPlan(-1), "keep");
});

test("an oversized log is moved aside and the content is preserved", () => {
  const dir = scratch();
  const log = path.join(dir, "router.log");
  try {
    writeFileSync(log, "x".repeat(42), "utf8");
    const result = rotateLog(log, { maxBytes: 32 });
    assert.equal(result.rotated, true);
    // Rotated, not deleted: the tail before a restart is often the only
    // record of why the service died.
    assert.equal(existsSync(log), false);
    assert.equal(existsSync(`${log}.1`), true);
    assert.equal(readFileSync(`${log}.1`, "utf8"), "x".repeat(42));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("only one previous generation is kept", () => {
  const dir = scratch();
  const log = path.join(dir, "router.log");
  try {
    writeFileSync(`${log}.1`, "oldest", "utf8");
    writeFileSync(log, "y".repeat(42), "utf8");
    assert.equal(rotateLog(log, { maxBytes: 32 }).rotated, true);
    // Two files bound the worst case at 2x the cap; without replacing the
    // previous generation the directory would grow without limit instead.
    assert.equal(existsSync(`${log}.2`), false);
    assert.equal(readFileSync(`${log}.1`, "utf8"), "y".repeat(42));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a small log and a missing log both leave the service startable", () => {
  const dir = scratch();
  const log = path.join(dir, "router.log");
  try {
    assert.deepEqual(rotateLog(log), { rotated: false, reason: "absent" });
    writeFileSync(log, "small", "utf8");
    const result = rotateLog(log);
    assert.equal(result.rotated, false);
    assert.equal(result.reason, "under-cap");
    assert.equal(readFileSync(log, "utf8"), "small");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("rotation runs while the service is stopped, never from inside it", () => {
  // The first attempt rotated from start.mjs. launchd and systemd both open
  // the log before the service execs, so the started process renamed a file it
  // already held a descriptor on and kept appending to the renamed inode: the
  // log grew exactly as before under a `.1` name. Verified on a live service,
  // whose fds 1 and 2 both pointed at router.log.1 after the rename.
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const start = readFileSync(path.join(root, "src", "start.mjs"), "utf8");
  assert.doesNotMatch(start, /log-rotation/);

  const macos = readFileSync(path.join(root, "src", "service-macos.mjs"), "utf8");
  assert.match(macos, /rotateLog\(LOG_PATH\)/);
  // Ordering is the whole fix: rotating before the old process is gone
  // reintroduces the open-descriptor bug.
  assert.ok(
    macos.indexOf("bootout();") < macos.indexOf("rotateLog(LOG_PATH)"),
    "macOS must stop the service before rotating",
  );
  assert.ok(
    macos.indexOf("rotateLog(LOG_PATH)") < macos.indexOf("bootstrap();"),
    "macOS must rotate before starting the service again",
  );

  const linux = readFileSync(path.join(root, "src", "service-linux.mjs"), "utf8");
  assert.match(linux, /rotateLog\(LOG_PATH\)/);
  assert.ok(
    linux.indexOf('systemctl(["stop", unitName]') < linux.indexOf("rotateLog(LOG_PATH)"),
    "Linux must stop the unit before rotating",
  );
});

test("rotating twice does not lose the log to a failed replace", () => {
  // rename replaces the destination atomically. Unlinking the previous
  // generation first left a window where a failure between the two calls
  // would have destroyed both, so the module must not do that.
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const source = readFileSync(path.join(root, "src", "log-rotation.mjs"), "utf8");
  assert.doesNotMatch(source, /unlinkSync/);

  const dir = mkdtempSync(path.join(os.tmpdir(), "log-rotation-twice-"));
  const log = path.join(dir, "router.log");
  try {
    for (const marker of ["first", "second"]) {
      writeFileSync(log, marker + "z".repeat(32), "utf8");
      assert.equal(rotateLog(log, { maxBytes: 32 }).rotated, true);
    }
    assert.equal(readFileSync(`${log}.1`, "utf8"), "second" + "z".repeat(32));
    assert.equal(existsSync(log), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a failed rotation preserves the current log and previous destination", () => {
  const dir = scratch();
  const log = path.join(dir, "router.log");
  try {
    const content = "current log content";
    writeFileSync(log, content, "utf8");
    // A nonempty directory cannot be replaced by a file on supported platforms.
    mkdirSync(`${log}.1`);
    writeFileSync(path.join(`${log}.1`, "keep"), "previous destination", "utf8");
    const result = rotateLog(log, { maxBytes: 16 });
    assert.equal(result.rotated, false);
    assert.equal(result.reason, "failed");
    assert.equal(readFileSync(log, "utf8"), content);
    assert.equal(readFileSync(path.join(`${log}.1`, "keep"), "utf8"), "previous destination");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
