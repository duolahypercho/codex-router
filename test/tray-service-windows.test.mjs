import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
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

test("tray restarts wait for Task Scheduler to stop before starting again", () => {
  const source = readFileSync(path.join(root, "src", "tray-service-windows.mjs"), "utf8");
  assert.match(source, /function waitForTaskState\(/);
  assert.match(source, /timeout: options\.timeoutMs \|\| TASK_COMMAND_TIMEOUT_MS/);
  assert.match(source, /const probeTimeout = Math\.min\(TASK_COMMAND_TIMEOUT_MS, remaining\)/);
  assert.match(source, /Register-ScheduledTask[\s\S]*?timeout: TASK_COMMAND_TIMEOUT_MS/);
  assert.match(source, /endTask\(\)[\s\S]*?waitForTaskState\([^\n]+TASK_STOP_TIMEOUT_MS/);
  assert.match(source, /function startTask\(\)[\s\S]*?waitForTaskState\([^\n]+TASK_START_TIMEOUT_MS/);
  assert.doesNotMatch(source, /if \(command === "restart"\) endTask\(\);\s*\n\s*schtasks\(\["\/Run"/);
});

test("tray uninstall verifies that Task Scheduler removed the task", () => {
  const source = readFileSync(path.join(root, "src", "tray-service-windows.mjs"), "utf8");
  const uninstall = source.slice(
    source.indexOf('command === "uninstall"'),
    source.indexOf('command === "stop"'),
  );
  assert.match(uninstall, /schtasks\(\["\/Delete"/);
  assert.match(uninstall, /if \(taskExists\(\)\)[\s\S]*?throw/);
  assert.doesNotMatch(uninstall, /catch \{\s*\/\/ The task may not exist/);
});

test("tray status reports the registered action and reads task state once", () => {
  const source = readFileSync(path.join(root, "src", "tray-service-windows.mjs"), "utf8");
  assert.match(source, /function registeredTaskAction\(/);
  assert.match(source, /const action = installed \? registeredTaskAction\(\) : undefined/);
  assert.match(source, /const companionPath = action\?\.execute/);
  assert.match(source, /const taskStatus = installed \? taskState\(\) : undefined/);
  assert.doesNotMatch(source, /loaded: installed && taskRunning\(\)/);
});

test("tray registration leaves its interactive principal able to update the task", () => {
  const source = readFileSync(path.join(root, "src", "tray-service-windows.mjs"), "utf8");
  assert.match(source, /WindowsIdentity\]\:\:GetCurrent\(\)\.User\.Value/);
  assert.match(source, /GetSecurityDescriptor\(7\)/);
  assert.match(source, /RawSecurityDescriptor/);
  assert.match(source, /TASK_FULL_CONTROL_MASK\s*=\s*0x1f01ff/);
  assert.match(source, /DiscretionaryAcl\.InsertAce/);
  assert.match(source, /SetSecurityDescriptor\([^\n]+0x10\)/);
  assert.match(source, /earlier elevated install owns it[\s\S]*?tray repair/);
  assert.doesNotMatch(source, /icacls|takeown/i);
});

test("a platform with no supervisor says so instead of reporting success", () => {
  const result = trayDispatch("install", "linux");
  assert.equal(result.status, 0, "an install must not fail over an unsupervised companion");
  assert.match(result.stdout, /"supported":false/);
  assert.match(result.stderr, /not supervised on linux/);
  // `status` is machine-readable and stays quiet.
  assert.equal(trayDispatch("status", "linux").stderr, "");
});

// macOS and Linux each have one command that builds the companion and hands it
// to a supervisor. Windows had none: bin/model-router-tray told you to go read
// a build script, and codex-router.ps1 had no tray verb at all, so the only
// route was knowing two separate incantations.
test("the Windows CLI exposes tray as a first-class command", () => {
  const script = readFileSync(path.join(root, "codex-router.ps1"), "utf8");
  assert.match(script, /"refresh-catalog", "media", "tray"/);
  assert.match(script, /"tray" \{/);
  // Build only when the sources moved, then stamp it, then register.
  assert.match(script, /install-plan\.mjs"\) tray-plan/);
  assert.match(script, /build-desktop-tray\.ps1"\) -BinaryOnly/);
  assert.match(script, /install-plan\.mjs"\) record-tray/);
  assert.match(script, /tray-service\.mjs" @\(\$Action\)/);
  // Every action the supervisor accepts is reachable.
  for (const action of ["install", "status", "start", "stop", "restart", "uninstall"]) {
    assert.ok(script.includes(`"${action}"`), `tray action ${action} is unreachable`);
  }
});

test("tray rebuild registers the artifact it just built", () => {
  const script = readFileSync(path.join(root, "codex-router.ps1"), "utf8");
  const rebuild = script.slice(
    script.indexOf('if ($Action -eq "rebuild")'),
    script.indexOf('if ($Action -eq "install" -and'),
  );
  assert.match(rebuild, /tray-service\.mjs" @\("install"\)/);
  assert.match(rebuild, /tray-service\.mjs" @\("install-electron"\)/);
  assert.doesNotMatch(rebuild, /tray-service\.mjs" @\("restart"\)/);
});

test("tray repair validates the task and grants only its current principal control", () => {
  const script = readFileSync(path.join(root, "codex-router.ps1"), "utf8");
  assert.match(script, /"repair"/);
  assert.match(script, /function Get-ValidatedTrayTask/);
  assert.match(script, /principal is not the current user/);
  assert.match(script, /action is not this checkout's tray companion/);
  assert.match(script, /CODEX_ROUTER_TRAY_REPAIR_SID/);
  assert.match(script, /RawSecurityDescriptor/);
  assert.match(script, /SetSecurityDescriptor\([^\n]+0x10\)/);
  assert.match(script, /Start-Process[^\n]+-Verb RunAs[^\n]+-Wait[^\n]+-WindowStyle Hidden/);
  assert.match(script, /if \(-not \(Test-TrayTaskFullControl/);
  assert.doesNotMatch(script, /icacls|takeown/i);
});

test("the POSIX tray launcher points Windows at that command", () => {
  const launcher = readFileSync(path.join(root, "bin", "model-router-tray"), "utf8");
  assert.match(launcher, /codex-router\.ps1 tray/);
  assert.doesNotMatch(launcher, /use scripts\/build-desktop-tray\.ps1 on Windows/);
});

test("setup reuses the tray command instead of repeating its steps", () => {
  const source = readFileSync(path.join(root, "src", "setup.mjs"), "utf8");
  assert.match(source, /"codex-router\.ps1"\),\s*\n\s*"tray",\s*\n\s*"install",/);
  // The build/stamp/register sequence must live in one place.
  assert.doesNotMatch(source, /build-desktop-tray\.ps1/);
});

test("Windows gets the same rebuild gating as the other tray platforms", async () => {
  // recordTrayBuild() threw on win32, so the one platform whose tray has to be
  // built deliberately was also the one that never recorded having been built
  // -- every update would have rebuilt it from scratch.
  const { trayRebuildPlan, traySourceFingerprint } = await import("../src/install-plan.mjs");
  assert.notEqual(trayRebuildPlan({ platform: "win32" }), "unsupported");
  // Same Tauri sources as Linux, so the fingerprints must agree.
  assert.equal(traySourceFingerprint(root, "win32"), traySourceFingerprint(root, "linux"));
  assert.notEqual(traySourceFingerprint(root, "win32"), "");
});
