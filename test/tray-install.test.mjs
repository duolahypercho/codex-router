import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";

import { desktopTrayBinary, trayBundleDir, trayDecision } from "../src/tray-install.mjs";

test("trayDecision skips when --no-tray is passed", () => {
  assert.equal(
    trayDecision({ platform: "darwin", withTray: true, noTray: true, guided: true }),
    "skip",
  );
});

// Windows used to be excluded here because it had no launcher. It has one
// now, and the exclusion was the reason the installer silently skipped the one
// platform whose tray never got built by anything else.
test("trayDecision offers the tray on Windows", () => {
  assert.equal(
    trayDecision({ platform: "win32", withTray: true, noTray: false, guided: true }),
    "install",
  );
  assert.equal(
    trayDecision({ platform: "win32", withTray: false, noTray: false, guided: true }),
    "ask",
  );
  assert.equal(
    trayDecision({ platform: "win32", withTray: false, noTray: true, guided: true }),
    "skip",
  );
});

test("trayDecision still skips a platform with no companion at all", () => {
  assert.equal(
    trayDecision({ platform: "aix", withTray: true, noTray: false, guided: true }),
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

test("trayBundleDir uses forward slashes regardless of the host OS", () => {
  // A macOS bundle path must never contain backslashes even when the tooling
  // runs on Windows (CI); guards the path.posix join.
  const result = trayBundleDir("darwin", "/Users/example");
  assert.ok(!result.includes("\\"), `expected no backslashes in ${result}`);
});

test("trayBundleDir is undefined on other platforms", () => {
  assert.equal(trayBundleDir("linux", "/home/example"), undefined);
});

test("desktopTrayBinary names the Tauri release binary per platform", () => {
  assert.equal(
    desktopTrayBinary("win32", "C:\\repo"),
    ["C:\\repo", "apps", "desktop", "src-tauri", "target", "release", "codex-router-desktop.exe"].join(
      path.sep,
    ),
  );
  assert.ok(desktopTrayBinary("linux", "/repo").endsWith("codex-router-desktop"));
  // macOS builds a Swift app bundle instead, served by TRAY_APP_BINARY.
  assert.equal(desktopTrayBinary("darwin", "/repo"), undefined);
});
