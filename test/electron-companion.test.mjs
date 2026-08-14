import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  electronAppDir,
  electronBinary,
  electronInstallIsComplete,
  electronLaunch,
  preferredCompanionBinary,
} from "../src/tray-install.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("the companion runtime resolves per platform", () => {
  assert.equal(
    electronBinary("win32", "/checkout"),
    path.join("/checkout", "apps", "electron", "node_modules", "electron", "dist", "electron.exe"),
  );
  assert.equal(
    electronBinary("linux", "/checkout"),
    path.join("/checkout", "apps", "electron", "node_modules", "electron", "dist", "electron"),
  );
  // macOS keeps its Swift menu-bar app; this shell is the Windows/Linux answer
  // to the Rust prerequisite, not a third companion for every platform.
  assert.equal(electronBinary("darwin", "/checkout"), undefined);
});

// npm 11 blocks install scripts by default and electron downloads its runtime
// from one, so `npm ci` exits 0 with the package present and the binary
// missing. Anything that treats a clean exit as success ships that failure to
// the user as an app that never starts.
test("an install is judged complete by the binary, not by npm's exit code", () => {
  const present = () => true;
  const absent = () => false;
  assert.equal(electronInstallIsComplete("win32", "/checkout", present), true);
  assert.equal(electronInstallIsComplete("win32", "/checkout", absent), false);
  assert.equal(electronInstallIsComplete("darwin", "/checkout", present), false);

  // The path it checks is the runtime itself.
  let asked;
  electronInstallIsComplete("linux", "/checkout", (value) => {
    asked = value;
    return true;
  });
  assert.equal(asked, electronBinary("linux", "/checkout"));
});

// status reported the Tauri path on a machine running the Electron build --
// naming a binary that was neither installed nor what Task Scheduler started.
test("the reported companion is the one that would actually run", () => {
  const tauri = (value) => value.endsWith("codex-router-desktop.exe");
  const electron = (value) => value.endsWith("electron.exe");

  assert.ok(tauri(preferredCompanionBinary("win32", "/checkout", () => true)));
  assert.ok(
    electron(preferredCompanionBinary("win32", "/checkout", (value) => electron(value))),
    "the Electron build must be reported when it is the only one built",
  );
  // Nothing built: name the preferred one, so the guidance points at a build
  // rather than at whichever shell happens to be absent.
  assert.ok(tauri(preferredCompanionBinary("win32", "/checkout", () => false)));
});

test("the launch carries the app directory, quoted for Task Scheduler", () => {
  const launch = electronLaunch("win32", "C:\\Program Files\\codex-router");
  assert.equal(launch.execute, electronBinary("win32", "C:\\Program Files\\codex-router"));
  // A checkout path with a space is ordinary on Windows; an unquoted argument
  // would register as two arguments and the app would not load.
  assert.equal(launch.argument, `"${electronAppDir("C:\\Program Files\\codex-router")}"`);
  assert.equal(electronLaunch("darwin", "/checkout"), undefined);
});

test("the Windows supervisor renders the Electron action", () => {
  const result = spawnSync(
    process.execPath,
    [path.join(root, "src", "tray-service-windows.mjs"), "render-electron"],
    { encoding: "utf8", env: { ...process.env, CODEX_ROUTER_SERVICE_PLATFORM: "win32" } },
  );
  assert.equal(result.status, 0, result.stderr);
  const action = JSON.parse(result.stdout);
  assert.ok(action.execute.endsWith("electron.exe"), action.execute);
  assert.ok(action.argument.startsWith('"') && action.argument.endsWith('"'), action.argument);
});

// The Tauri action must keep rendering with no argument: it is a GUI binary
// that takes none, and -Argument "" registers an empty argument rather than
// none at all.
test("adding an argument to one action did not add one to the other", () => {
  const result = spawnSync(
    process.execPath,
    [path.join(root, "src", "tray-service-windows.mjs"), "render-task"],
    { encoding: "utf8", env: { ...process.env, CODEX_ROUTER_SERVICE_PLATFORM: "win32" } },
  );
  assert.equal(JSON.parse(result.stdout).argument, "");
});

test("the install path falls back instead of failing without Rust", () => {
  const script = readFileSync(path.join(root, "codex-router.ps1"), "utf8");
  // `tray install` is what setup runs, so the fallback has to live there and
  // not only behind a command a user would have to know to type.
  assert.match(script, /Get-Command cargo/);
  assert.match(script, /build-electron-companion\.ps1/);
  assert.match(script, /install-electron/);
  assert.match(script, /"companion"/);

  const launcher = readFileSync(path.join(root, "bin", "model-router-tray"), "utf8");
  assert.match(launcher, /command -v cargo/);
  assert.match(launcher, /build-electron-companion\.sh/);
});

test("the build script refuses to report success without the runtime", () => {
  for (const file of ["build-electron-companion.ps1", "build-electron-companion.sh"]) {
    const script = readFileSync(path.join(root, "scripts", file), "utf8");
    // Both halves matter: fetch the runtime npm skipped, then fail loudly if
    // it is still absent rather than printing a path to nothing.
    assert.match(script, /install\.js/, `${file} must recover the skipped download`);
    assert.match(script, /still missing/, `${file} must fail on a missing runtime`);
    // The point of this script: it must never gate itself on a Rust toolchain.
    // Matched on the presence check rather than the word, which also appears in
    // the comment explaining why the Tauri script needs one.
    assert.doesNotMatch(
      script,
      /Get-Command cargo|command -v cargo|"cargo"/,
      `${file} must not require Rust`,
    );
  }
});
