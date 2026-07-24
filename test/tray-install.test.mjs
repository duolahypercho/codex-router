import assert from "node:assert/strict";
import { test } from "node:test";

import { trayBundleDir, trayDecision } from "../src/tray-install.mjs";

test("trayDecision skips when --no-tray is passed", () => {
  assert.equal(
    trayDecision({ platform: "darwin", withTray: true, noTray: true, guided: true }),
    "skip",
  );
});

test("trayDecision skips on Windows where no launcher exists yet", () => {
  assert.equal(
    trayDecision({ platform: "win32", withTray: true, noTray: false, guided: true }),
    "skip",
  );
});

test("trayDecision installs without asking when --with-tray is passed", () => {
  assert.equal(
    trayDecision({ platform: "darwin", withTray: true, noTray: false, guided: false }),
    "install",
  );
  assert.equal(
    trayDecision({ platform: "linux", withTray: true, noTray: false, guided: true }),
    "install",
  );
});

test("trayDecision asks during guided setup", () => {
  assert.equal(
    trayDecision({ platform: "darwin", withTray: false, noTray: false, guided: true }),
    "ask",
  );
});

test("trayDecision skips silently in automatic mode", () => {
  assert.equal(
    trayDecision({ platform: "darwin", withTray: false, noTray: false, guided: false }),
    "skip",
  );
});

test("trayBundleDir places the macOS bundle in the user's Applications folder", () => {
  assert.equal(
    trayBundleDir("darwin", "/Users/example"),
    "/Users/example/Applications/Model Router.app",
  );
});

test("trayBundleDir is undefined on other platforms", () => {
  assert.equal(trayBundleDir("linux", "/home/example"), undefined);
});
