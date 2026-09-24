import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
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

test("the registered action points at the packaged Control Center", () => {
  const result = trayService("render-task");
  assert.equal(result.status, 0, result.stderr);
  const action = JSON.parse(result.stdout);
  assert.ok(action.execute.endsWith("Codex Router.exe"), action.execute);
  assert.ok(action.execute.includes(path.join("control-center", "release", "win-unpacked")), action.execute);
  assert.equal(action.argument, "--tray-only");
});

test("a render resolves the path for the platform it is rendering for", () => {
  // Not process.platform: a render on Linux still has to show the .exe that
  // would actually be registered on Windows.
  assert.match(JSON.parse(trayService("render-task").stdout).execute, /\.exe$/);
});

test("Task Scheduler commands refuse to run off Windows", () => {
  for (const command of ["install", "uninstall", "start", "stop", "restart", "validate", "lifecycle", "status"]) {
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

// The guard below only exists while the companion is missing, so a checkout
// that has already built one cannot exercise it.
const companionBuilt = existsSync(
  path.join(root, "apps", "control-center", "release", "win-unpacked", "Codex Router.exe"),
);

test("install refuses before the tray has been built", { skip: companionBuilt ? "the packaged companion is already built in this checkout" : false }, () => {
  // The checkout under test has no compiled Tauri binary, so this exercises
  // the real guard rather than a stub. A missing binary must name the build
  // command instead of registering a task that points at nothing.
  const result = trayService("install");
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /not built at/);
  assert.match(result.stderr, /build-electron-companion\.ps1/);
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

test("tray uninstall deletes only one unchanged recognized current-user task", () => {
  const source = readFileSync(path.join(root, "src", "tray-service-windows.mjs"), "utf8");
  const uninstall = source.slice(
    source.indexOf('command === "uninstall"'),
    source.indexOf('command === "stop"'),
  );
  assert.match(uninstall, /schtasks\(\["\/Delete"/);
  // A task the scheduler still cannot enumerate must fail the uninstall, never
  // report success as "missing".
  assert.match(uninstall, /if \(taskExists\(\) === "exists"\)[\s\S]*?throw/);
  assert.match(uninstall, /if \(existence === "error"\)[\s\S]*?did not answer whether the tray task was removed/);
  assert.match(uninstall, /requireRecognizedCurrentUserTask\(initial, "deleted"\)/);
  assert.match(uninstall, /requireRecognizedCurrentUserTask\(beforeDelete, "deleted"\)/);
  assert.match(uninstall, /sameRegisteredTaskIdentity\(initial, beforeDelete\)/);
  assert.match(uninstall, /if \(beforeDelete\) \{\s+schtasks\(\["\/Delete"/);
  assert.doesNotMatch(uninstall, /Best effort stop|continue to the \/Delete attempt/);
  const endTaskCall = uninstall.indexOf("endTask()");
  const deleteCall = uninstall.indexOf('schtasks(["/Delete"');
  assert.ok(
    endTaskCall >= 0 && deleteCall > endTaskCall,
    "the verified task must drain before its guarded deletion",
  );
});

test("every Windows task mutation verifies the interactive current-user principal", () => {
  const source = readFileSync(path.join(root, "src", "tray-service-windows.mjs"), "utf8");
  const query = source.slice(
    source.indexOf("function registeredTaskAction("),
    source.indexOf("function requireCanonicalRegisteredAction("),
  );
  assert.match(query, /WindowsIdentity\]::GetCurrent\(\)\.User\.Value/);
  assert.match(query, /principalSid/);
  assert.match(query, /LogonType\.ToString\(\)/);
  assert.match(query, /isCurrentUserInteractiveTask/);
  assert.match(query, /logonType \|\| ""\)\.toLowerCase\(\) === "interactive"/);
  assert.match(query, /isRecognizedControlCenterAction\(registered\)[\s\S]*recognizedLegacyCompanionAction\(registered\)/);
  const endTask = source.slice(source.indexOf("function endTask("), source.indexOf("function startTask("));
  assert.match(endTask, /requireRecognizedCurrentUserTask\(registered, "stopped or replaced"\)/);
  assert.ok(
    endTask.indexOf("requireRecognizedCurrentUserTask") < endTask.indexOf('schtasks(["/End"'),
    "principal and action identity must be proven before /End",
  );
});

test("task query returns a tri-state answer, not a silent false", () => {
  const source = readFileSync(path.join(root, "src", "tray-service-windows.mjs"), "utf8");
  const task = source.slice(
    source.indexOf("function taskExists("),
    source.indexOf("function sleep("),
  );
  // The positive, negative, and indeterminate outcomes are returned as distinct
  // literals rather than collapsed to a boolean false.
  assert.match(task, /return sawError \? "error" : "missing"/);
  assert.match(task, /"exists"/);
  assert.match(task, /"missing"/);
  // Only the culture-invariant "task not found" FullyQualifiedErrorId may count
  // as missing; a timeout/denial/scheduler outage must become "error".
  assert.match(task, /CmdletizationQuery_NotFound_TaskName/);
  // Both PowerShell hosts are consulted before a host failure is treated as
  // indeterminate rather than as an absent task.
  assert.match(task, /for \(const executable of \["powershell\.exe", "pwsh\.exe"\]\)/);
});

test("a scheduler failure is never treated as a missing task while stopping", () => {
  const source = readFileSync(path.join(root, "src", "tray-service-windows.mjs"), "utf8");
  const wait = source.slice(
    source.indexOf("function waitForTaskState("),
    source.indexOf("function endTask("),
  );
  assert.match(wait, /existence === "missing"/);
  assert.match(wait, /if \(action === "stop"\) return "missing"/);
  // An indeterminate query is reported, not swallowed into a "missing" answer.
  assert.match(wait, /existence === "error"[\s\S]*?did not answer/);
  assert.match(wait, /uninstall would report[\s\S]*?success it did not earn/);
});

test("tray status reports the registered action and reads task state once", () => {
  const source = readFileSync(path.join(root, "src", "tray-service-windows.mjs"), "utf8");
  assert.match(source, /function registeredTaskAction\(/);
  assert.match(source, /const action = installed \? registeredTaskAction\(\) : undefined/);
  assert.match(source, /const companionPath = action\?\.execute/);
  assert.match(source, /const taskStatus = installed \? taskState\(\) : undefined/);
  assert.doesNotMatch(source, /loaded: installed && taskRunning\(\)/);
});

test("graceful update drain is verified and lifecycle failure never authorizes a force-stop", () => {
  const source = readFileSync(path.join(root, "src", "tray-service-windows.mjs"), "utf8");
  const endTask = source.slice(source.indexOf("function endTask("), source.indexOf("function startTask("));
  const drain = source.slice(
    source.indexOf("function drainCanonicalExecutable("),
    source.indexOf("function endTask("),
  );
  assert.match(endTask, /isRecognizedControlCenterAction\(registered\)/);
  assert.match(endTask, /drainCanonicalExecutable\(registered\.execute, \{ schedulerOwned: true \}\)/);
  assert.match(drain, /spawnSync\(executable, \["--quit-for-update"\]/);
  assert.match(drain, /exactUserExecutableOwnsPid\(executable, lifecycle\.pid\)/);
  const processIdentity = source.slice(
    source.indexOf("function exactUserExecutableOwnsPid("),
    source.indexOf("function stopExactUserAction("),
  );
  assert.match(processIdentity, /candidate\.CreationDate/);
  assert.match(processIdentity, /process\.StartTime\.ToUniversalTime\(\)\.Ticks/);
  assert.match(processIdentity, /\[Math\]::Abs\(\$process\.StartTime\.ToUniversalTime\(\)\.Ticks - \$cimTicks\)/);
  assert.match(processIdentity, /\[TimeSpan\]::TicksPerMillisecond/);
  assert.ok(
    drain.indexOf("exactUserExecutableOwnsPid(executable, lifecycle.pid)")
      < drain.indexOf('spawnSync(executable, ["--quit-for-update"]'),
    "the lifecycle PID must be verified before it scopes the drain",
  );
  assert.match(drain, /request\.status !== 0/);
  assert.match(drain, /MUTATION_DRAIN_TIMEOUT_MS/);
  assert.match(drain, /waitForExactUserExecutableExit\(executable/);
  assert.match(drain, /!lifecycleWasVerified\(lifecycle\)[\s\S]*exactCanonicalProcessCount/);
  assert.match(drain, /Close it normally and retry; it was not force-stopped/);
  assert.doesNotMatch(endTask, /stopExactUserAction\(\{ execute: (?:registered\.execute|TRAY_BINARY)/);
  assert.match(endTask, /if \(registered\) requireRecognizedCurrentUserTask\(registered, "stopped or replaced"\)/);
  assert.match(endTask, /const existence = taskExists\(\)[\s\S]*existence !== "missing"[\s\S]*action could not be verified/);
  assert.match(endTask, /stopKnownLegacyProcesses\(registered\)/);
  assert.doesNotMatch(endTask, /path\.resolve|===\s*path\.resolve/);
});

test("Windows legacy drain binds exact argv and process creation identity", () => {
  const source = readFileSync(path.join(root, "src", "tray-service-windows.mjs"), "utf8");
  const exact = source.slice(
    source.indexOf("function stopExactUserAction("),
    source.indexOf("function stopKnownLegacyProcesses("),
  );
  assert.match(exact, /CommandLineToArgvW/);
  assert.match(exact, /argv\.Count -eq 1/);
  assert.match(exact, /argv\.Count -eq 2/);
  assert.match(exact, /GetOwnerSid/);
  assert.match(exact, /Get-SameRouterProcessHandle/);
  assert.match(exact, /ProcessId = \$pidValue/);
  assert.match(exact, /fresh\.CreationDate[^\n]+Candidate\.CreationDate/);
  assert.match(exact, /process\.StartTime\.ToUniversalTime\(\)\.Ticks/);
  assert.match(exact, /\[TimeSpan\]::TicksPerMillisecond/);
  assert.match(exact, /\$process\.Kill\(\)/);
  assert.match(exact, /if \(-not \$stopMatches\)[^\n]+exit 0/);
  assert.match(exact, /exact companion process query returned an invalid count/);
  assert.doesNotMatch(exact, /Stop-Process -Id \$candidate\.ProcessId/);
  assert.match(source, /legacyCompanionActions\("win32", SOURCE_ROOT\)/);
  assert.match(source, /recognizedLegacyCompanionAction\(registeredAction\)/);
});

test("graceful update drain waits for the exact current-user executable", () => {
  const source = readFileSync(path.join(root, "src", "tray-service-windows.mjs"), "utf8");
  const wait = source.slice(
    source.indexOf("function waitForExactUserExecutableExit("),
    source.indexOf("function waitForTaskState("),
  );
  assert.match(wait, /CODEX_ROUTER_TRAY_EXECUTE/);
  assert.match(wait, /ExecutablePath/);
  assert.match(wait, /OrdinalIgnoreCase/);
  assert.match(wait, /WindowsIdentity\]\:\:GetCurrent\(\)\.User\.Value/);
  assert.match(wait, /GetOwnerSid/);
  assert.match(wait, /owner\.Sid -eq \$currentSid/);
  assert.match(wait, /did not finish its active operation/);
});

test("start restart and open require the exact canonical registered action", () => {
  const source = readFileSync(path.join(root, "src", "tray-service-windows.mjs"), "utf8");
  const wrapper = readFileSync(path.join(root, "codex-router.ps1"), "utf8");
  assert.match(source, /function isCanonicalTrayTaskAction\(/);
  assert.match(source, /path\.win32\.normalize\(action\.execute\.trim\(\)\)/);
  assert.match(source, /actual === expected/);
  assert.match(source, /\$actions\.Count -ne 1/);
  assert.match(source, /function startTask\(\)[\s\S]*?requireCanonicalRegisteredAction\(\)[\s\S]*?schtasks\(\["\/Run"/);
  const restart = source.slice(source.indexOf("// start and restart"));
  assert.ok(
    restart.indexOf("requireCanonicalRegisteredAction()") < restart.indexOf('if (command === "restart") endTask()'),
    "restart must validate before stopping anything",
  );
  const open = wrapper.slice(wrapper.indexOf("function Open-ControlCenterWindow"), wrapper.indexOf("function New-ControlCenterUpdateTransaction"));
  assert.match(open, /tray-service\.mjs" @\("validate"\)/);
  assert.ok(open.indexOf('tray-service.mjs" @("validate")') < open.indexOf("Start-Process"));
});

test("Task Scheduler start waits for the packaged lifecycle-ready contract", () => {
  const source = readFileSync(path.join(root, "src", "tray-service-windows.mjs"), "utf8");
  assert.match(source, /spawnSync\(executable, \["--query-lifecycle"\]/);
  assert.match(source, /state\.running !== \(state\.pid !== null\)/);
  assert.match(source, /lifecycle\.running[\s\S]{0,120}lifecycle\.ready[\s\S]{0,120}exactUserExecutableOwnsPid/);
  const start = source.slice(source.indexOf("function startTask("), source.indexOf("function requireBuiltTray("));
  assert.match(start, /waitForTaskState[^\n]+"running"/);
  assert.match(start, /waitForControlCenterReady\(registered\.execute\)/);
  assert.match(start, /taskState\(\) !== "running"/);
  const validate = source.slice(source.indexOf('command === "validate"'), source.indexOf('command === "lifecycle"'));
  assert.match(validate, /exactUserExecutableOwnsPid\(action\.execute, lifecycle\.pid\)/);
  assert.match(validate, /canonical Control Center is not ready/);
});

test("direct packaged GUI launches clear inherited Electron Node mode", () => {
  const source = readFileSync(path.join(root, "src", "tray-service-windows.mjs"), "utf8");
  const wrapper = readFileSync(path.join(root, "codex-router.ps1"), "utf8");
  const guiEnvironment = source.slice(
    source.indexOf("function packagedGuiEnvironment("),
    source.indexOf("function queryControlCenterLifecycle("),
  );
  assert.match(guiEnvironment, /delete environment\.ELECTRON_RUN_AS_NODE/);
  const query = source.slice(
    source.indexOf("function queryControlCenterLifecycle("),
    source.indexOf("function exactUserExecutableOwnsPid("),
  );
  assert.match(query, /--query-lifecycle[\s\S]*env: packagedGuiEnvironment\(\)/);
  const drain = source.slice(
    source.indexOf("function drainCanonicalExecutable("),
    source.indexOf("function endTask("),
  );
  assert.match(drain, /--quit-for-update[\s\S]*env: packagedGuiEnvironment\(\)/);
  const open = wrapper.slice(
    wrapper.indexOf("function Open-ControlCenterWindow"),
    wrapper.indexOf("function New-ControlCenterUpdateTransaction"),
  );
  assert.match(open, /Remove-Item Env:ELECTRON_RUN_AS_NODE/);
  assert.ok(open.indexOf("Remove-Item Env:ELECTRON_RUN_AS_NODE") < open.indexOf("Start-Process"));
  assert.match(open, /Set-Item Env:ELECTRON_RUN_AS_NODE \$PreviousElectronRunAsNode/);
});

test("status stays a JSON exit-0 document when Task Scheduler is unreadable", () => {
  // With no scheduler hosts reachable (empty PATH forces both PowerShell
  // hosts to fail), taskExists() returns "error" and status must print
  // parseable JSON and exit 0. It used to throw, which emptied stdout and
  // broke every caller that parses status JSON.
  const result = trayService("status", { env: { PATH: "" } });
  assert.equal(result.status, 0, result.stderr);
  const doc = JSON.parse(result.stdout);
  assert.equal(doc.supported, true);
  assert.equal(doc.state, "unknown");
  assert.equal(doc.loaded, false);
  assert.match(result.stdout, /"why":/);
});

test("tray mutations are guarded so a test run never touches the scheduler", () => {
  const source = readFileSync(path.join(root, "src", "tray-service-windows.mjs"), "utf8");
  assert.match(source, /skipServiceManagerCall/);
  assert.match(source, /const HOST_MANAGED = process\.platform === "win32"/);
  // Queries stay live while every scheduler mutation consults the guard.
  assert.match(source, /if \(options\.mutating && skipServiceManagerCall/);
  assert.match(source, /function installTask\([\s\S]*?skipServiceManagerCall/);
  assert.match(source, /function endTask\(\)[\s\S]*?skipServiceManagerCall/);
  assert.match(source, /function startTask\(\)[\s\S]*?skipServiceManagerCall/);
  // /End, /Run and /Delete are the three direct writes through schtasks; all
  // three must be marked mutating so the guard can skip them under test.
  assert.match(source, /\/End"[\s\S]*?mutating: true/);
  assert.match(source, /\/Run"[\s\S]*?mutating: true/);
  assert.match(source, /\/Delete"[\s\S]*?mutating: true/);
});

test("tray Task Scheduler timeouts match service-windows.mjs's single larger value", () => {
  const source = readFileSync(path.join(root, "src", "tray-service-windows.mjs"), "utf8");
  assert.match(source, /const TASK_COMMAND_TIMEOUT_MS = 15_000;/);
  // The windows service manager uses 15_000 for the identical Get-ScheduledTask
  // read, so the tray must not abort install/start/restart/uninstall on a slow
  // cold-start powershell the way a 4 s budget did. The per-host split still
  // keeps each PowerShell host within its share.
  assert.match(source, /const perHostTimeout = Math\.max\(50, Math\.floor\(timeoutMs \/ 2\)\)/);
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
  assert.notEqual(result.status, 0, "an unsupported mutation must not report success");
  assert.match(result.stdout, /"supported":false/);
  assert.match(result.stdout, /"state":"unsupported"/);
  assert.match(result.stderr, /supervision is unavailable on linux/);
  // `status` is machine-readable and stays quiet.
  const status = trayDispatch("status", "linux");
  assert.equal(status.status, 0);
  assert.equal(status.stderr, "");
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
  assert.match(script, /build-electron-companion\.ps1/);
  assert.match(script, /install-plan\.mjs"\) record-tray/);
  assert.match(script, /tray-service\.mjs" @\(\$Action\)/);
  // Every action the supervisor accepts is reachable.
  for (const action of ["install", "status", "start", "stop", "restart", "uninstall"]) {
    assert.ok(script.includes(`"${action}"`), `tray action ${action} is unreachable`);
  }
});

// `control tray` prints enable|disable|status|restart|refresh|rebuild in its
// own usage line, and the Windows wrapper accepted install|uninstall for the
// first two, so following that usage line on Windows died on "Unknown tray
// action 'disable'" (issue #751). Both surfaces are parsed here rather than
// asserting one spelling, so a later rename of either one is caught.
test("the Windows tray verbs accept every control tray command", () => {
  const script = readFileSync(path.join(root, "codex-router.ps1"), "utf8");
  const control = readFileSync(path.join(root, "src", "control.mjs"), "utf8");
  const pairs = (source, pattern, entry) => {
    const body = source.match(pattern)?.[1];
    assert.ok(body, `could not read ${pattern}`);
    return new Map([...body.matchAll(entry)].map((match) => [match[1], match[2]]));
  };
  const commands = pairs(control, /const TRAY_COMMANDS = \{([^}]*)\}/, /(\w+):\s*"([^"]+)"/g);
  const aliases = pairs(script, /\$TrayActionAliases = @\{([^}]*)\}/, /"(\w+)"\s*=\s*"([^"]+)"/g);
  const accepted = script.match(/\$Action -notin @\(([^)]*)\)/)?.[1];
  assert.ok(accepted, "the tray action validator should remain readable");
  const actions = new Set([...accepted.matchAll(/"([^"]+)"/g)].map((match) => match[1]));
  assert.ok(commands.size >= 4, "control tray should still name its commands");
  for (const [command, subcommand] of commands) {
    const resolved = aliases.get(command) ?? command;
    assert.ok(actions.has(resolved), `codex-router.ps1 tray ${command} is unreachable`);
    // An alias must reach the same supervisor transaction control reaches, not
    // merely some accepted verb.
    assert.equal(resolved, subcommand, `tray ${command} must map to ${subcommand}`);
  }
  // The aliases are folded in before validation, so an aliased action reaches
  // the same transaction the canonical spelling does.
  assert.ok(
    script.indexOf("$TrayActionAliases.ContainsKey($Action)") < script.indexOf("$Action -notin @("),
    "the control aliases must be resolved before the action is validated",
  );
});

test("tray rebuild registers the artifact it just built", () => {
  const script = readFileSync(path.join(root, "codex-router.ps1"), "utf8");
  const rebuild = script.slice(
    script.indexOf('if ($Action -eq "rebuild")'),
    script.indexOf('$RefreshOnly = $Action -eq "refresh"'),
  );
  assert.match(rebuild, /tray-service\.mjs" @\("install"\)/);
  assert.doesNotMatch(rebuild, /tray-service\.mjs" @\("install-electron"\)/);
  assert.doesNotMatch(rebuild, /tray-service\.mjs" @\("restart"\)/);
  // Windows locks running tray binaries, so the supervised task is stopped
  // BEFORE the in-place build, and a failed rebuild restores the old instance.
  const stopBeforeBuild = rebuild.indexOf('tray-service.mjs" @("stop")');
  const build = rebuild.indexOf("Build-ControlCenterReplacement");
  assert.ok(stopBeforeBuild >= 0 && stopBeforeBuild < build,
    "the running tray must be stopped before the in-place build");
  assert.match(rebuild, /\$TrayWasRunning\s*=\s*\$/);
  assert.match(rebuild, /New-ControlCenterUpdateTransaction/);
  assert.match(rebuild, /Undo-ControlCenterReplacement/);
  assert.match(rebuild, /Companion rebuild failed/);
  const statusCatch = rebuild.match(/try \{[\s\S]*?tray-service\.mjs"\) status[\s\S]*?\} catch \{([\s\S]*?)\n\s*\}/)?.[1] || "";
  assert.ok(statusCatch, "the rebuild status fallback should remain readable");
  assert.doesNotMatch(statusCatch, /\$TrayWasRunning\s*=\s*\$false/);
});

test("normal Windows tray install restarts the previous app when a rebuild fails", () => {
  const script = readFileSync(path.join(root, "codex-router.ps1"), "utf8");
  const install = script.slice(
    script.indexOf('$RefreshOnly = $Action -eq "refresh"'),
    script.indexOf('if (-not $ActionHandled)'),
  );
  assert.match(install, /\$TrayWasRunning/);
  assert.match(install, /New-ControlCenterUpdateTransaction/);
  assert.match(install, /try \{[\s\S]*?Build-ControlCenterReplacement[\s\S]*?\} catch \{/);
  assert.match(install, /Undo-ControlCenterReplacement \$Transaction \$TrayWasRunning/);
  assert.match(script, /exact previous companion package and Scheduled Task were restored and restarted/);
});

test("Windows replacement commits only after lifecycle-ready start and stamps after commit", () => {
  const script = readFileSync(path.join(root, "codex-router.ps1"), "utf8");
  const rebuild = script.slice(
    script.indexOf('if ($Action -eq "rebuild")'),
    script.indexOf('$RefreshOnly = $Action -eq "refresh"'),
  );
  const build = rebuild.indexOf("Build-ControlCenterReplacement");
  const start = rebuild.indexOf('tray-service.mjs" @("install")', build);
  const ready = rebuild.indexOf('Write-ControlCenterTransactionJournal $Transaction "replacement-ready"', start);
  const commit = rebuild.indexOf("Complete-ControlCenterReplacement", ready);
  const stamp = rebuild.indexOf("Record-ControlCenterBuild", commit);
  assert.ok(build >= 0 && start > build && ready > start && commit > ready && stamp > commit,
    "build -> ready supervisor start -> durable commit -> stamp must stay ordered");

  const helpers = script.slice(
    script.indexOf("function Get-ControlCenterUpdateLayout"),
    script.indexOf("function Resolve-AccountSid"),
  );
  assert.match(helpers, /-BackupDirectory \$Transaction\.BackupDirectory -KeepPrevious/);
  assert.match(helpers, /Restore-ControlCenterReplacement/);
  assert.match(helpers, /Remove-Item -LiteralPath \$Transaction\.TargetDirectory -Recurse -Force/);
  assert.match(helpers, /Move-Item -LiteralPath \$Transaction\.BackupDirectory -Destination \$Transaction\.TargetDirectory/);
  assert.ok(
    helpers.indexOf("Invoke-RouterNode \"src\\tray-service.mjs\" @(\"stop\")")
      < helpers.indexOf("Restore-ControlCenterReplacement $Transaction"),
    "rollback must stop the replacement before restoring files",
  );
  const record = helpers.slice(helpers.indexOf("function Record-ControlCenterBuild"));
  assert.match(record, /Record only after Task Scheduler and the app-ready handshake/);
});

test("Windows replacement recovery journals the package and exact prior Scheduled Task", () => {
  const script = readFileSync(path.join(root, "codex-router.ps1"), "utf8");
  const transaction = script.slice(
    script.indexOf("function Get-ControlCenterUpdateLayout"),
    script.indexOf("function Record-ControlCenterBuild"),
  );
  assert.match(transaction, /\.win-control-center-transaction\.json/);
  assert.match(transaction, /\.win-unpacked\.previous-transaction/);
  assert.match(transaction, /Export-ScheduledTask/);
  assert.match(transaction, /GetSecurityDescriptor\(7\)/);
  assert.match(transaction, /Register-ScheduledTask -TaskName \$TaskName -Xml/);
  assert.match(transaction, /SetSecurityDescriptor\(\[string\]\$TaskSnapshot\.Sddl, 0x10\)/);
  assert.match(transaction, /TaskSnapshot\.WasRunning[\s\S]*Start-ScheduledTask/);
  assert.match(transaction, /Write-ControlCenterTransactionJournal \$Transaction "recovering"/);
  assert.match(transaction, /Write-ControlCenterTransactionJournal \$Transaction "committed"/);
  assert.match(
    transaction,
    /Assert-ControlCenterRecoveryState \$Transaction\s+Assert-ControlCenterPackageComplete \$Transaction\s+Write-ControlCenterTransactionJournal \$Transaction "committed"/,
  );
  assert.match(transaction, /Length -le 0/);
  assert.match(transaction, /Assert-ControlCenterTransactionPath \$Resources "packaged resources directory" "Directory"/);
  assert.match(
    transaction,
    /MatchesRecoveringPrior = \$Transaction\.Phase -eq "recovering" -and \$MatchesPriorDocument/,
  );
  assert.match(
    transaction,
    /-not \$MatchesReplacement -and -not \$MatchesPrior -and -not \$MatchesRecoveringPrior/,
  );
  assert.match(
    transaction,
    /Write-ControlCenterTransactionJournal \$Transaction "committed"[\s\S]*Assert-ControlCenterRecoveryState \$Transaction[\s\S]*Remove-Item -LiteralPath \$Transaction\.BackupDirectory/,
  );
  assert.match(transaction, /FileOptions\]::WriteThrough/);
  assert.match(transaction, /Stream\.Flush\(\$true\)/);
  assert.match(transaction, /function Replace-ControlCenterTransactionJournal/);
  assert.match(transaction, /\[IO\.File\]::Replace\(\$Temporary, \$JournalPath, \$null\)/);
  assert.match(transaction, /catch \[ArgumentException\]/);
  assert.match(transaction, /\.replace-backup-/);
  assert.match(
    transaction,
    /Move-Item -LiteralPath \$FallbackBackup -Destination \$JournalPath -ErrorAction Stop/,
  );
  assert.match(transaction, /Replace-ControlCenterTransactionJournal \$Temporary \$Transaction\.JournalPath/);
  assert.match(
    transaction,
    /if \(\[IO\.File\]::Exists\(\$Temporary\)\) \{\s+Assert-ControlCenterTransactionPath \$Temporary "temporary transaction journal" "File"\s+\[IO\.File\]::Delete\(\$Temporary\)/,
  );
  assert.match(transaction, /unexpected rollback packages coexist with the journal/);
  assert.match(transaction, /rollback package exists without its transaction journal/);
  assert.match(transaction, /reparse point/);
  const recoveryBody = transaction.slice(
    transaction.indexOf("function Recover-ControlCenterUpdateTransaction"),
    transaction.indexOf("function New-ControlCenterUpdateTransaction"),
  );
  assert.ok(
    recoveryBody.indexOf('Assert-ControlCenterTransactionPath $Layout.ReleaseDirectory')
      < recoveryBody.indexOf("Remove-ControlCenterJournalTemps $Layout"),
    "recovery must reject a linked release tree before deleting journal temporaries",
  );
  assert.ok(
    transaction.indexOf("Get-ControlCenterTaskSnapshot")
      < transaction.indexOf('Invoke-RouterNode "src\\tray-service.mjs" @("stop")'),
    "recovery must reject an unknown named task before stopping anything",
  );
  assert.ok(
    transaction.indexOf("Restore-ControlCenterReplacement $Transaction")
      < transaction.indexOf("Restore-ControlCenterTaskSnapshot $Transaction.TaskSnapshot"),
    "the prior package must be restored before its exact task is restarted",
  );
  const tray = script.slice(script.indexOf('"tray" {'), script.indexOf('"companion" {'));
  const recovery = tray.indexOf("Recover-ControlCenterUpdateTransaction");
  const repair = tray.indexOf("Repair-TrayTaskPermissions");
  const dispatch = tray.indexOf('Invoke-RouterNode "src\\tray-service.mjs" @($Action)');
  assert.ok(recovery >= 0 && repair > recovery && dispatch > recovery,
    "every mutating tray action must reconcile an interrupted transaction first");
  assert.match(tray, /if \(\$Action -ne "status"\)[\s\S]*Recover-ControlCenterUpdateTransaction/);
});

test("refresh is plan-gated and preserves the prior window lifecycle", () => {
  const script = readFileSync(path.join(root, "codex-router.ps1"), "utf8");
  assert.match(script, /"install", "refresh", "status"/);
  assert.match(script, /Get-ControlCenterLifecycle/);
  assert.match(script, /PreviousLifecycle\.running[\s\S]*PreviousLifecycle\.visible/);
  assert.match(script, /if \(\$RefreshOnly\) \{ exit 0 \}/);
  assert.match(script, /Invoke-RouterNode "src\\tray-service\.mjs" @\("install"\)[\s\S]*Record-ControlCenterBuild/);
  assert.match(script, /if \(\$OpenAfterAction\)[\s\S]*Open-ControlCenterWindow/);
  const skip = script.slice(
    script.indexOf('if ($Plan.Trim() -eq "skip")'),
    script.indexOf("} else {", script.indexOf('if ($Plan.Trim() -eq "skip")')),
  );
  assert.match(skip, /New-ControlCenterUpdateTransaction[\s\S]*tray-service\.mjs" @\("install"\)[\s\S]*Complete-ControlCenterReplacement/);
  assert.match(skip, /Undo-ControlCenterReplacement[\s\S]*Companion registration failed/);
});

test("successful Windows install removes only the standalone legacy executable", () => {
  const script = readFileSync(path.join(root, "codex-router.ps1"), "utf8");
  const cleanup = script.slice(
    script.indexOf("function Get-ObsoleteTauriExecutableForRemoval"),
    script.indexOf("function Get-ControlCenterLifecycle"),
  );
  assert.match(cleanup, /"apps", "desktop", "src-tauri", "target", "release"/);
  assert.match(cleanup, /Assert-ControlCenterTransactionPath \$Cursor "obsolete Tauri path component" "Directory"/);
  assert.match(cleanup, /Assert-ControlCenterTransactionPath \$LegacyBinary "obsolete Tauri executable" "File"/);
  assert.doesNotMatch(cleanup, /apps\\electron\\node_modules\\electron\\dist\\electron\.exe/);
  const installResult = script.slice(script.indexOf('Invoke-RouterNode "src\\tray-service.mjs" @($Action)'));
  assert.match(installResult, /Get-ObsoleteTauriExecutableForRemoval/);
  assert.match(installResult, /Remove-Item -LiteralPath \$LegacyBinary -Force/);
  assert.doesNotMatch(installResult, /Remove-Item[^\n]+-Recurse/);
});

test("PowerShell children that emit parsed text pin their output encoding to UTF-8", () => {
  const source = readFileSync(path.join(root, "src", "tray-service-windows.mjs"), "utf8");
  // OEM-encoded Console.Out corrupts a localized profile path before Node's
  // `encoding: "utf8"` sees it, which made status report appPresent:false on a
  // healthy tray and reject a valid deploy.
  const pin = "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8";
  const pinWithin = (functionName) => {
    const start = source.indexOf(`function ${functionName}(`);
    assert.ok(start >= 0, `${functionName} must still exist`);
    // Every PowerShell child that writes text for Node to parse pins UTF-8
    // near the top of its script body, before emitting the parsed output.
    return source.slice(start, start + 900).includes(pin);
  };
  assert.ok(pinWithin("taskState"), "taskState must pin UTF-8 before its output");
  assert.ok(pinWithin("registeredTaskAction"), "registeredTaskAction must pin UTF-8");
  assert.ok(pinWithin("taskExists"), "taskExists must pin UTF-8");
});

test("tray repair validates the task and grants only its current principal control", () => {
  const script = readFileSync(path.join(root, "codex-router.ps1"), "utf8");
  assert.match(script, /"repair"/);
  assert.match(script, /function Get-ValidatedTrayTask/);
  assert.match(script, /principal is not the current user/);
  // A task registered from another checkout must still be recognized by shape,
  // so a dev user whose task points at %LOCALAPPDATA% is not rejected.
  assert.doesNotMatch(script, /this checkout's tray companion/);
  assert.match(script, /apps\\control-center\\release\\win-unpacked\\Codex Router\.exe/);
  assert.match(script, /--tray-only/);
  assert.match(script, /not a recognized Codex Router Control Center/);
  assert.match(script, /RawSecurityDescriptor/);
  assert.match(script, /SetSecurityDescriptor\([^\n]+0x10\)/);
  // The elevated PowerShell host must be named absolutely so ShellExecuteEx
  // cannot resolve a CWD/PATH shadow, and the working directory pinned to
  // SystemRoot so the elevated child runs from an unwritable directory.
  assert.match(script, /System32\\WindowsPowerShell\\v1\.0\\powershell\.exe/);
  assert.match(script, /Start-Process[^\n]+-FilePath \$ElevatedPowerShell/);
  assert.match(script, /Start-Process[^\n]+-Verb RunAs[^\n]+-Wait[^\n]+-WindowStyle Hidden/);
  assert.match(script, /-WorkingDirectory \$env:SystemRoot/);
  assert.doesNotMatch(script, /Start-Process[^\n]+\-FilePath "powershell\.exe"/);
  // The validated values travel inside the -EncodedCommand payload, not the
  // process environment: env vars do not survive ShellExecuteEx ->
  // CreateProcessAsUser, so the elevated side must not read them.
  assert.doesNotMatch(script, /CODEX_ROUTER_TRAY_REPAIR_TASK/);
  assert.match(script, /ConvertTo-RepairLiteral/);
  assert.match(script, /__TRAY_EXECUTE__/);
  assert.match(script, /-EncodedCommand/);
  assert.match(script, /if \(-not \(Test-TrayTaskFullControl/);
  assert.doesNotMatch(script, /icacls|takeown/i);
  const repair = script.slice(
    script.indexOf("function Repair-TrayTaskPermissions"),
    script.indexOf("switch ($Command)"),
  );
  assert.match(script, /legacy Tauri action deliberately has no argv/);
  assert.match(repair, /foreach \(\$Field in "Name", "Sid", "Execute"\)/);
  assert.doesNotMatch(repair, /foreach \(\$Field in [^\n]*"Argument"/);
  assert.match(repair, /__TRAY_ARGUMENT__/);
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

// Task Scheduler rewrites a task's stored DACL when it registers one, so an
// exact SDDL comparison cannot survive a replacement. The recovery path has to
// compare the security identity instead, without accepting any change to who
// may reach the task.
test("Windows recovery compares task security rather than the raw SDDL string", () => {
  const script = readFileSync(path.join(root, "codex-router.ps1"), "utf8");
  assert.match(script, /function Test-SameControlCenterTaskSecurity\(\[string\]\$Left, \[string\]\$Right\)/);
  // The auto-inherited marker is the only thing the comparison drops, and it
  // has to be dropped from the DACL flags the stored descriptor carries.
  assert.match(script, /function Get-ControlCenterDaclFlags/);
  assert.match(script, /\.Replace\("AI", ""\)/);
  assert.match(script, /Test-SameControlCenterTaskSecurity \(Get-ControlCenterTaskSddl \$TaskName\)/);
  // The strictly textual comparison is what made recovery impossible; it must
  // not come back in the restore path or in the prior-task guard.
  assert.doesNotMatch(script, /GetSddlForm\(\$Sections\) -ne/);
  assert.doesNotMatch(script, /Test-SameControlCenterTaskSddl/);
});

const schedulerDescriptorSkip = process.platform === "win32"
  ? false
  : "Task Scheduler security descriptors are Windows-only";

test("the recovery comparison accepts a canonicalised DACL and refuses a changed one", { skip: schedulerDescriptorSkip }, () => {
  const script = readFileSync(path.join(root, "codex-router.ps1"), "utf8");
  const helpers = script.slice(
    script.indexOf("function Get-ControlCenterDaclAceIdentities"),
    script.indexOf("function Read-ControlCenterTaskIdentityFromXml"),
  );
  assert.ok(helpers.includes("Test-SameControlCenterTaskSecurity"), "the comparison helpers should be extractable");
  // Every case is built from the same ACEs the installer records, so only the
  // property under test differs between them.
  const probe = [
    helpers,
    "$user = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value",
    "$group = 'S-1-5-32-545'",
    "$expected = 'O:' + $user + 'G:' + $group + 'D:(A;ID;0x1f019f;;;BA)(A;ID;0x1f019f;;;SY)(A;ID;FA;;;' + $user + ')(A;;FR;;;' + $user + ')'",
    // What Task Scheduler stores back: same ACEs, auto-inherited flag, canonical order.
    "$canonical = 'O:' + $user + 'G:' + $group + 'D:AI(A;;FR;;;' + $user + ')(A;ID;0x1f019f;;;BA)(A;ID;0x1f019f;;;SY)(A;ID;FA;;;' + $user + ')'",
    // A descriptor with no D: section parses to a null DACL (everyone), while
    // 'D:' parses to an empty one (nobody); the two must not be interchangeable.
    "$noDacl = 'O:' + $user + 'G:' + $group",
    "$cases = @(",
    "  @{ Name = 'canonicalised'; Left = $canonical; Right = $expected; Want = $true },",
    "  @{ Name = 'identical'; Left = $expected; Right = $expected; Want = $true },",
    "  @{ Name = 'added ace'; Left = 'O:' + $user + 'G:' + $group + 'D:AI(A;;FR;;;WD)(A;;FR;;;' + $user + ')(A;ID;0x1f019f;;;BA)(A;ID;0x1f019f;;;SY)(A;ID;FA;;;' + $user + ')'; Right = $expected; Want = $false },",
    "  @{ Name = 'removed ace'; Left = 'O:' + $user + 'G:' + $group + 'D:AI(A;ID;0x1f019f;;;BA)(A;ID;0x1f019f;;;SY)(A;ID;FA;;;' + $user + ')'; Right = $expected; Want = $false },",
    "  @{ Name = 'weakened ace'; Left = 'O:' + $user + 'G:' + $group + 'D:AI(A;;FR;;;' + $user + ')(A;ID;0x1f019f;;;BA)(A;ID;0x1f019f;;;SY)(A;;FR;;;' + $user + ')'; Right = $expected; Want = $false },",
    "  @{ Name = 'protected dacl'; Left = 'O:' + $user + 'G:' + $group + 'D:P(A;ID;0x1f019f;;;BA)(A;ID;0x1f019f;;;SY)(A;ID;FA;;;' + $user + ')(A;;FR;;;' + $user + ')'; Right = $expected; Want = $false },",
    "  @{ Name = 'other owner'; Left = 'O:S-1-5-18' + 'G:' + $group + 'D:(A;ID;0x1f019f;;;BA)(A;ID;0x1f019f;;;SY)(A;ID;FA;;;' + $user + ')(A;;FR;;;' + $user + ')'; Right = $expected; Want = $false },",
    "  @{ Name = 'missing dacl'; Left = $noDacl; Right = $expected; Want = $false },",
    "  @{ Name = 'both missing dacl'; Left = $noDacl; Right = $noDacl; Want = $true },",
    "  @{ Name = 'unreadable descriptor'; Left = 'not-a-descriptor'; Right = $expected; Want = $false }",
    ")",
    "$failed = @()",
    "foreach ($case in $cases) {",
    "  $actual = Test-SameControlCenterTaskSecurity $case.Left $case.Right",
    "  if ($actual -ne $case.Want) { $failed += $case.Name }",
    "}",
    "if ($failed.Count) { Write-Output ('FAILED: ' + ($failed -join ', ')); exit 1 }",
    "Write-Output ('CASES ' + $cases.Count + ' FAILED ' + $failed.Count)",
  ].join("\n");
  const result = spawnSync("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", probe], {
    encoding: "utf8",
    windowsHide: true,
  });
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
  assert.match(result.stdout, /CASES 10 FAILED 0/);
});
