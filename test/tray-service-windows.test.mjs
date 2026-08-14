import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// The Windows tray manager can only be exercised off-Windows through its
// render commands, the same contract service-windows.mjs uses: everything that
// touches Task Scheduler refuses to run on the wrong platform, and everything
// that only renders a definition works anywhere so CI can check it.
function trayService(command, { platform = "win32", env = {} } = {}) {
  return spawnSync(
    process.execPath,
    [path.join(root, "src", "tray-service-windows.mjs"), command],
    {
      encoding: "utf8",
      env: { ...process.env, CODEX_ROUTER_SERVICE_PLATFORM: platform, ...env },
    },
  );
}

function trayDispatch(command, platform) {
  return spawnSync(
    process.execPath,
    [path.join(root, "src", "tray-service.mjs"), command],
    {
      encoding: "utf8",
      env: { ...process.env, CODEX_ROUTER_SERVICE_PLATFORM: platform },
    },
  );
}

test("the registered action points at the Tauri release binary", () => {
  const result = trayService("render-task");
  assert.equal(result.status, 0, result.stderr);
  const action = JSON.parse(result.stdout);
  assert.ok(action.execute.endsWith("codex-router-desktop.exe"), action.execute);
  assert.ok(action.execute.includes(path.join("src-tauri", "target", "release")), action.execute);
  // A GUI binary takes no arguments; the router's task needs them, this one
  // must not inherit that shape.
  assert.equal(action.argument, "");
});

test("a render resolves the path for the platform it is rendering for", () => {
  // Not process.platform: a render on Linux still has to show the .exe that
  // would actually be registered on Windows.
  assert.match(JSON.parse(trayService("render-task").stdout).execute, /\.exe$/);
});

test("Task Scheduler commands refuse to run off Windows", () => {
  for (const command of ["install", "uninstall", "start", "stop", "restart", "status"]) {
    const result = trayService(command, { platform: "linux" });
    assert.notEqual(result.status, 0, `${command} should have refused`);
    assert.match(result.stderr, /runs on Windows only/);
  }
});

test("an unknown subcommand exits 2 with usage", () => {
  const result = trayService("frobnicate");
  assert.equal(result.status, 2);
  assert.match(result.stderr, /Usage: tray-service-windows\.mjs/);
});

test("install refuses before the tray has been built", () => {
  // The checkout under test has no compiled Tauri binary, so this exercises
  // the real guard rather than a stub. A missing binary must name the build
  // command instead of registering a task that points at nothing.
  const result = trayService("install");
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /not built at/);
  assert.match(result.stderr, /build-desktop-tray\.ps1/);
});

test("the dispatcher routes Windows to the Task Scheduler manager", () => {
  // Windows reached the no-op branch before this existed, so `control tray
  // enable` printed {"supported":false} and exited 0 -- success, with no tray.
  const result = trayDispatch("status", "win32");
  assert.doesNotMatch(result.stdout, /"supported":false/);
});

test("a platform with no supervisor says so instead of reporting success", () => {
  const result = trayDispatch("install", "linux");
  assert.equal(result.status, 0, "an install must not fail over an unsupervised companion");
  assert.match(result.stdout, /"supported":false/);
  assert.match(result.stderr, /not supervised on linux/);
  // `status` is machine-readable and stays quiet.
  assert.equal(trayDispatch("status", "linux").stderr, "");
});
