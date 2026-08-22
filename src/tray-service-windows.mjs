// Windows autostart for the Tauri tray companion. Without it the tray is a
// bare executable somebody has to remember to launch, so it disappears at
// every reboot -- and `control tray enable` answered {"supported":false} and
// exited 0, which reads as success while doing nothing at all.
//
// This is the router's own Task Scheduler pattern from service-windows.mjs,
// with one deliberate difference: no windowless wrapper. That wrapper exists
// to keep a console off the screen for a background Node process; the tray is
// a GUI binary that owns no console, and routing it through wscript would only
// put a script host between Task Scheduler and the window it has to show.
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";

import { SOURCE_ROOT, TRAY_TASK_NAME } from "./paths.mjs";
import {
  desktopTrayBinary,
  electronBinary,
  electronLaunch,
  preferredCompanionBinary,
} from "./tray-install.mjs";

const effectivePlatform = process.env.CODEX_ROUTER_SERVICE_PLATFORM || process.platform;
const command = process.argv[2] || "status";
const renderCommands = new Set(["render", "render-task", "render-electron"]);
// Resolved from the effective platform, not process.platform, so a render on
// a POSIX machine shows the Windows path it would actually register.
const TRAY_BINARY = desktopTrayBinary(effectivePlatform, SOURCE_ROOT);
const TASK_STOP_TIMEOUT_MS = 10_000;
const TASK_START_TIMEOUT_MS = 10_000;
const TASK_STATE_POLL_MS = 250;
const TASK_COMMAND_TIMEOUT_MS = 4_000;
const TASK_FULL_CONTROL_MASK = 0x1f01ff;

if (effectivePlatform !== "win32" && !renderCommands.has(command)) {
  throw new Error("The Task Scheduler tray manager runs on Windows only.");
}

function schtasks(args, options = {}) {
  return execFileSync("schtasks.exe", args, {
    encoding: "utf8",
    windowsHide: true,
    stdio: options.quiet ? ["ignore", "ignore", "ignore"] : ["ignore", "pipe", "pipe"],
    timeout: options.timeoutMs || TASK_COMMAND_TIMEOUT_MS,
  });
}

export function trayTaskAction(binary = TRAY_BINARY) {
  return { execute: binary, argument: "" };
}

// The Electron companion is a runtime plus an app directory, so it is the one
// action here that carries an argument. Kept separate from trayTaskAction
// rather than folded into it: the Tauri binary must keep rendering with no
// argument, and one function returning different shapes by inference is how
// that guarantee would quietly lapse.
export function electronTaskAction() {
  return electronLaunch(effectivePlatform, SOURCE_ROOT);
}

// RestartCount covers a crash, not a clean exit. That distinction is the whole
// reason the tray's Quit menu item still works: Task Scheduler treats a zero
// exit as the task finishing, so quitting stays quit until the next logon --
// the same conditional-KeepAlive intent the macOS agent spells out.
function installTask(action = trayTaskAction()) {
  const script = [
    "$principalSid = ([Security.Principal.WindowsIdentity]::GetCurrent().User.Value)",
    // Only passed when there is one: `-Argument ""` registers an empty
    // argument rather than none, which the Tauri binary must never receive.
    action.argument
      ? "$action = New-ScheduledTaskAction -Execute $env:CODEX_ROUTER_TRAY_EXECUTE -Argument $env:CODEX_ROUTER_TRAY_ARGUMENT"
      : "$action = New-ScheduledTaskAction -Execute $env:CODEX_ROUTER_TRAY_EXECUTE",
    "$trigger = New-ScheduledTaskTrigger -AtLogOn -User ([Security.Principal.WindowsIdentity]::GetCurrent().Name)",
    "$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew",
    "$principal = New-ScheduledTaskPrincipal -UserId ([Security.Principal.WindowsIdentity]::GetCurrent().Name) -LogonType Interactive -RunLevel Limited",
    "Register-ScheduledTask -TaskName $env:CODEX_ROUTER_TRAY_TASK -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Force | Out-Null",
    // An elevated install otherwise leaves the unelevated account with only
    // read/run access to its own tray task. Preserve Task Scheduler's existing
    // descriptor and add one explicit full-control ACE for the task principal,
    // so later updates neither need elevation nor rewrite SYSTEM/Admin rights.
    "$service = New-Object -ComObject 'Schedule.Service'",
    "$service.Connect()",
    "$registered = $service.GetFolder('\\').GetTask($env:CODEX_ROUTER_TRAY_TASK)",
    "$descriptor = [Security.AccessControl.RawSecurityDescriptor]::new($registered.GetSecurityDescriptor(7))",
    "$sid = [Security.Principal.SecurityIdentifier]::new($principalSid)",
    `$fullControl = ${TASK_FULL_CONTROL_MASK}`,
    "$hasFullControl = $false",
    "foreach ($ace in $descriptor.DiscretionaryAcl) { if ($ace -is [Security.AccessControl.CommonAce] -and $ace.AceQualifier -eq [Security.AccessControl.AceQualifier]::AccessAllowed -and $ace.SecurityIdentifier.Value -eq $sid.Value -and ($ace.AccessMask -band $fullControl) -eq $fullControl) { $hasFullControl = $true; break } }",
    "if (-not $hasFullControl) { $newAce = [Security.AccessControl.CommonAce]::new([Security.AccessControl.AceFlags]::None, [Security.AccessControl.AceQualifier]::AccessAllowed, $fullControl, $sid, $false, $null); $descriptor.DiscretionaryAcl.InsertAce($descriptor.DiscretionaryAcl.Count, $newAce); $sections = [Security.AccessControl.AccessControlSections]::Owner -bor [Security.AccessControl.AccessControlSections]::Group -bor [Security.AccessControl.AccessControlSections]::Access; $registered.SetSecurityDescriptor($descriptor.GetSddlForm($sections), 0x10) }",
  ].join("; ");
  try {
    execFileSync(
      "powershell.exe",
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          CODEX_ROUTER_TRAY_TASK: TRAY_TASK_NAME,
          CODEX_ROUTER_TRAY_EXECUTE: action.execute,
          CODEX_ROUTER_TRAY_ARGUMENT: action.argument,
        },
        stdio: ["ignore", "ignore", "pipe"],
        windowsHide: true,
        timeout: TASK_COMMAND_TIMEOUT_MS,
      },
    );
  } catch (error) {
    const detail = String(error?.stderr || "").trim();
    throw new Error(
      "Task Scheduler could not replace the tray task. " +
        "If an earlier elevated install owns it, run `.\\codex-router.ps1 tray repair` once." +
        (detail ? ` ${detail}` : ""),
      { cause: error },
    );
  }
}

function taskExists(timeoutMs = TASK_COMMAND_TIMEOUT_MS) {
  try {
    schtasks(["/Query", "/TN", TRAY_TASK_NAME], { quiet: true, timeoutMs });
    return true;
  } catch {
    return false;
  }
}

function sleep(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function taskState(timeoutMs = TASK_COMMAND_TIMEOUT_MS) {
  // `schtasks` output is localized ("En ejecución" on Spanish Windows), so a
  // regex on its text reads a running task as stopped. Task Scheduler's own
  // State property is an enum that renders the same in every locale.
  const script =
    "try { [Console]::Out.Write((Get-ScheduledTask -TaskName $env:CODEX_ROUTER_TRAY_TASK).State.ToString()) } catch { exit 1 }";
  const perHostTimeout = Math.max(50, Math.floor(timeoutMs / 2));
  for (const executable of ["powershell.exe", "pwsh.exe"]) {
    try {
      return execFileSync(
        executable,
        ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
        {
          encoding: "utf8",
          env: { ...process.env, CODEX_ROUTER_TRAY_TASK: TRAY_TASK_NAME },
          stdio: ["ignore", "pipe", "ignore"],
          timeout: perHostTimeout,
          windowsHide: true,
        },
      ).trim().toLowerCase();
    } catch {
      // Try the other PowerShell host. A missing task is handled by taskExists.
    }
  }
  return undefined;
}

function registeredTaskAction() {
  const script = [
    "$task = Get-ScheduledTask -TaskName $env:CODEX_ROUTER_TRAY_TASK -ErrorAction Stop",
    "$action = @($task.Actions)[0]",
    "if ($null -eq $action) { exit 1 }",
    "[Console]::Out.Write((@{ execute = [string]$action.Execute; argument = [string]$action.Arguments } | ConvertTo-Json -Compress))",
  ].join("; ");
  const perHostTimeout = Math.floor(TASK_COMMAND_TIMEOUT_MS / 2);
  for (const executable of ["powershell.exe", "pwsh.exe"]) {
    try {
      const value = JSON.parse(execFileSync(
        executable,
        ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
        {
          encoding: "utf8",
          env: { ...process.env, CODEX_ROUTER_TRAY_TASK: TRAY_TASK_NAME },
          stdio: ["ignore", "pipe", "ignore"],
          timeout: perHostTimeout,
          windowsHide: true,
        },
      ));
      if (typeof value?.execute === "string" && value.execute) return value;
    } catch {
      // Try the other PowerShell host before reporting an unreadable action.
    }
  }
  return undefined;
}

function waitForTaskState(predicate, timeoutMs, action) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      throw new Error(`The tray task did not ${action} within ${timeoutMs}ms.`);
    }
    const probeTimeout = Math.min(TASK_COMMAND_TIMEOUT_MS, remaining);
    const state = taskState(probeTimeout);
    if (state !== undefined && predicate(state)) return state;
    if (state === undefined && !taskExists(Math.min(TASK_COMMAND_TIMEOUT_MS, Math.max(50, deadline - Date.now())))) {
      if (action === "stop") return "missing";
      throw new Error(`The tray task disappeared while waiting for it to ${action}.`);
    }
    if (Date.now() >= deadline) {
      throw new Error(`The tray task did not ${action} within ${timeoutMs}ms.`);
    }
    sleep(TASK_STATE_POLL_MS);
  }
}

function endTask() {
  try {
    schtasks(["/End", "/TN", TRAY_TASK_NAME], { quiet: true });
  } catch {
    // Missing or already idle: the state the caller asked for either way.
  }
  waitForTaskState((state) => state !== "running", TASK_STOP_TIMEOUT_MS, "stop");
}

function startTask() {
  schtasks(["/Run", "/TN", TRAY_TASK_NAME], { quiet: true });
  waitForTaskState((state) => state === "running", TASK_START_TIMEOUT_MS, "start");
}

function requireBuiltTray() {
  if (!TRAY_BINARY || !existsSync(TRAY_BINARY)) {
    throw new Error(
      `The tray app is not built at ${TRAY_BINARY}. ` +
        "Run scripts\\build-desktop-tray.ps1 -BinaryOnly first.",
    );
  }
}

// Either shell satisfies start/restart. Demanding the Tauri binary there would
// refuse to start a companion this same script had just registered.
function builtCompanionExists() {
  const binary = builtCompanionPath();
  return Boolean(binary && existsSync(binary));
}

function builtCompanionPath() {
  return preferredCompanionBinary(effectivePlatform, SOURCE_ROOT, existsSync);
}

function requireBuiltCompanion() {
  if (!builtCompanionExists()) {
    throw new Error(
      "No desktop companion is built. Run scripts\\build-electron-companion.ps1 " +
        "(Node only), or scripts\\build-desktop-tray.ps1 -BinaryOnly (needs Rust).",
    );
  }
}

// The Electron companion needs its runtime present for the same reason the
// Tauri one needs its binary: a registered task pointing at nothing is a
// companion that silently never appears.
function requireBuiltElectron() {
  const binary = electronBinary(effectivePlatform, SOURCE_ROOT);
  if (!binary || !existsSync(binary)) {
    throw new Error(
      `The Electron companion is not built at ${binary}. ` +
        "Run scripts\\build-electron-companion.ps1 first.",
    );
  }
}

if (
  !new Set([
    "install",
    "install-electron",
    "uninstall",
    "start",
    "stop",
    "restart",
    "status",
    "render",
    "render-task",
    "render-electron",
  ]).has(command)
) {
  console.error(
    "Usage: tray-service-windows.mjs install|install-electron|uninstall|start|stop|restart|status|render|render-task|render-electron",
  );
  process.exit(2);
}

if (command === "render" || command === "render-task") {
  process.stdout.write(`${JSON.stringify(trayTaskAction())}\n`);
} else if (command === "render-electron") {
  process.stdout.write(`${JSON.stringify(electronTaskAction())}\n`);
} else if (command === "install-electron") {
  // One companion, one logon task: the Electron and Tauri shells are two
  // builds of the same app, so registering one replaces the other rather than
  // leaving two icons fighting over the tray.
  requireBuiltElectron();
  endTask();
  installTask(electronTaskAction());
  startTask();
  process.stdout.write(
    `${JSON.stringify({ installed: true, ...electronTaskAction() })}\n`,
  );
} else if (command === "status") {
  const installed = taskExists();
  const taskStatus = installed ? taskState() : undefined;
  const action = installed ? registeredTaskAction() : undefined;
  const companionPath = action?.execute || (!installed ? builtCompanionPath() : undefined);
  const loaded = installed && taskStatus === "running";
  process.stdout.write(
    `${JSON.stringify({
      installed,
      supported: true,
      loaded,
      appPresent: Boolean(companionPath && existsSync(companionPath)),
      state: loaded ? "running" : "stopped",
      path: companionPath,
    })}\n`,
  );
} else if (command === "install") {
  requireBuiltTray();
  endTask();
  installTask();
  startTask();
  process.stdout.write(`${JSON.stringify({ installed: true, path: TRAY_BINARY })}\n`);
} else if (command === "uninstall") {
  endTask();
  try {
    schtasks(["/Delete", "/TN", TRAY_TASK_NAME, "/F"], { quiet: true });
  } catch (error) {
    // Missing is already the requested state. A task that still exists means
    // Task Scheduler rejected the deletion, which must not be reported as a
    // successful uninstall.
    if (taskExists()) {
      const failure = new Error("Task Scheduler did not remove the tray task.");
      failure.cause = error;
      throw failure;
    }
  }
  if (taskExists()) {
    throw new Error("Task Scheduler still reports the tray task after deletion.");
  }
  process.stdout.write(`${JSON.stringify({ installed: false })}\n`);
} else if (command === "stop") {
  endTask();
  process.stdout.write(`${JSON.stringify({ state: "stopped" })}\n`);
} else {
  // start and restart. A tray that was quit by hand is not running, so both
  // reduce to asking Task Scheduler for a fresh instance.
  requireBuiltCompanion();
  if (!taskExists()) {
    throw new Error(`The tray task is not installed. Run: control tray enable`);
  }
  if (command === "restart") endTask();
  startTask();
  process.stdout.write(`${JSON.stringify({ state: "running" })}\n`);
}
