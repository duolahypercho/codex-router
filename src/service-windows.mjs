import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

import {
  CODEX_HOME,
  LOG_PATH,
  PORTS,
  SOURCE_ROOT,
  STATE_DIR,
  TARGET,
} from "./paths.mjs";

const effectivePlatform = process.env.CODEX_ROUTER_SERVICE_PLATFORM || process.platform;
const command = process.argv[2] || "status";
const renderCommands = new Set(["render", "render-launcher", "render-task"]);
const taskName = "Codex Router";
const wrapperPath = path.join(STATE_DIR, "start-codex-router.cmd");
const launcherPath = path.join(STATE_DIR, "start-codex-router-hidden.vbs");

if (effectivePlatform !== "win32" && !renderCommands.has(command)) {
  throw new Error("The Task Scheduler service manager runs on Windows only.");
}

function cmdEscape(value) {
  return String(value).replaceAll("%", "%%").replaceAll('"', '""');
}

function vbsEscape(value) {
  return String(value).replaceAll('"', '""');
}

function wrapper() {
  const start = path.join(SOURCE_ROOT, "src", "start.mjs");
  const variables = {
    MODEL_ROUTER_TARGET: TARGET,
    MODEL_ROUTER_STATE_DIR: STATE_DIR,
    MODEL_ROUTER_QUIET: "1",
    MODEL_ROUTER_GATEWAY_PORT: String(PORTS.gateway),
    MODEL_ROUTER_OAUTH_PORT: String(PORTS.oauth),
    MODEL_ROUTER_PORT: String(PORTS.router),
    MODEL_ROUTER_API_PORT: String(PORTS.api),
    CODEX_HOME,
    CODEX_ROUTER_STATE_DIR: STATE_DIR,
    CODEX_ROUTER_QUIET: "1",
    CODEX_ROUTER_GATEWAY_PORT: String(PORTS.gateway),
    CODEX_ROUTER_OAUTH_PORT: String(PORTS.oauth),
    CODEX_ROUTER_PORT: String(PORTS.router),
    CODEX_ROUTER_API_PORT: String(PORTS.api),
    // The LiteLLM gateway is a Python process. Force UTF-8 output so its
    // startup banner and logs do not crash on Windows systems whose default
    // ANSI/OEM code page is not UTF-8 (e.g. Russian cp1251), where Python
    // would otherwise encode stdout as the legacy code page.
    PYTHONIOENCODING: "utf-8",
    PYTHONUTF8: "1",
    ...(process.env.KIMI_CODE_HOME ? { KIMI_CODE_HOME: process.env.KIMI_CODE_HOME } : {}),
  };
  return `@echo off\r\n${Object.entries(variables)
    .map(([key, value]) => `set "${key}=${cmdEscape(value)}"`)
    .join("\r\n")}\r\n"${cmdEscape(process.execPath)}" "${cmdEscape(start)}" >> "${cmdEscape(LOG_PATH)}" 2>&1\r\n`;
}

// The scheduled task launches this script through `wscript.exe //B //NoLogo`,
// which is a windowless host, and the script starts the CMD wrapper with a
// window style of 0. Without it the wrapper owned a console window that stayed
// on screen for the router's lifetime and reappeared on every watchdog restart.
//
// The `True` wait flag is what keeps Task Scheduler's restart settings alive:
// Run then blocks until the wrapper exits and returns its exit code, which the
// script re-raises through WScript.Quit. Quitting with a fixed 0 (or letting the
// script fall off the end) would report every crash as a clean exit and silently
// disable RestartCount/RestartInterval.
function launcher() {
  // A Windows path cannot contain a double quote, but escape it anyway so a
  // hand-edited state directory can never break out of the string literal.
  // Chr(34) supplies the quotes cmd.exe needs around the wrapper path, which
  // keeps this generated source free of stacked quote-doubling.
  return [
    "Option Explicit",
    "",
    "Dim quote, shell, status",
    "quote = Chr(34)",
    'Set shell = CreateObject("WScript.Shell")',
    "On Error Resume Next",
    `status = shell.Run("cmd.exe /D /C " & quote & quote & "${vbsEscape(wrapperPath)}" & quote & quote, 0, True)`,
    "If Err.Number <> 0 Then",
    "  WScript.Quit 1",
    "End If",
    "On Error Goto 0",
    "WScript.Quit status",
    "",
  ].join("\r\n");
}

function schtasks(args, options = {}) {
  return execFileSync("schtasks.exe", args, {
    encoding: "utf8",
    stdio: options.quiet ? ["ignore", "ignore", "ignore"] : ["ignore", "pipe", "pipe"],
  });
}

function writeAtomic(target, contents) {
  const temporary = `${target}.tmp.${process.pid}`;
  writeFileSync(temporary, contents);
  // renameSync replaces an existing destination on Windows, so reinstalling
  // over an older launcher pair is a plain overwrite rather than a conflict.
  renameSync(temporary, target);
}

function writeLaunchers() {
  mkdirSync(STATE_DIR, { recursive: true });
  writeAtomic(wrapperPath, Buffer.from(wrapper(), "utf8"));
  // wscript.exe parses a script file with the system ANSI code page unless the
  // file carries a UTF-16 byte order mark, so a state directory holding
  // non-ASCII characters only round-trips when the launcher is UTF-16LE.
  writeAtomic(
    launcherPath,
    Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(launcher(), "utf16le")]),
  );
}

// `//B` suppresses script errors and prompts, `//NoLogo` suppresses the banner;
// neither host allocates a console, so nothing is drawn at logon.
function taskAction() {
  return {
    execute: "wscript.exe",
    // Unlike cmd.exe, wscript.exe follows the standard command-line parser, so
    // the launcher path takes a single quote pair. cmd.exe's doubled-quote form
    // would parse as an empty argument followed by a split path.
    argument: `//B //NoLogo "${launcherPath}"`,
  };
}

function installTask() {
  const { execute, argument } = taskAction();
  const script = [
    // The action strings travel through the environment so that the quotes
    // around the launcher path never pass through powershell.exe's -Command
    // reparse or the schtasks argument escaper.
    "$action = New-ScheduledTaskAction -Execute $env:CODEX_ROUTER_TASK_EXECUTE -Argument $env:CODEX_ROUTER_TASK_ARGUMENT",
    "$trigger = New-ScheduledTaskTrigger -AtLogOn -User ([Security.Principal.WindowsIdentity]::GetCurrent().Name)",
    "$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew",
    "$principal = New-ScheduledTaskPrincipal -UserId ([Security.Principal.WindowsIdentity]::GetCurrent().Name) -LogonType Interactive -RunLevel Limited",
    "Register-ScheduledTask -TaskName $env:CODEX_ROUTER_TASK -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Force | Out-Null",
  ].join("; ");
  try {
    execFileSync(
      "powershell.exe",
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
      {
        env: {
          ...process.env,
          CODEX_ROUTER_TASK: taskName,
          CODEX_ROUTER_TASK_EXECUTE: execute,
          CODEX_ROUTER_TASK_ARGUMENT: argument,
        },
        stdio: ["ignore", "ignore", "ignore"],
      },
    );
  } catch {
    schtasks(
      [
        "/Create",
        "/TN",
        taskName,
        "/SC",
        "ONLOGON",
        "/TR",
        `${execute} ${argument}`,
        "/RL",
        "LIMITED",
        "/F",
      ],
      { quiet: true },
    );
  }
}

// `schtasks /End` returns once Task Scheduler has accepted the request, not
// once the instance is gone, and `MultipleInstances IgnoreNew` silently drops a
// `/Run` issued while the old one is still winding down -- which leaves the
// router stopped until the next logon, and turns the installer's readiness wait
// into a five-minute stall followed by a rollback. Polling the real state beats
// retrying `/Run`: it continues as soon as the instance has actually gone
// instead of guessing how long that takes, and it gives up on a fixed deadline
// instead of hoping one extra attempt is enough.
const TASK_STOP_TIMEOUT_MS = 10_000;
const TASK_STOP_POLL_MS = 250;
// Every state query has to return for the deadline above to mean anything, so a
// wedged PowerShell is capped rather than allowed to hang the install outright.
const TASK_STATE_TIMEOUT_MS = 15_000;

function sleep(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function waitForTaskToStop() {
  const deadline = Date.now() + TASK_STOP_TIMEOUT_MS;
  // An undefined state means no PowerShell could answer -- the same restricted
  // shell that blocks registration -- so there is nothing to poll and waiting
  // would only spend the deadline on a question that cannot be answered.
  while (taskState() === "running") {
    if (Date.now() >= deadline) return;
    sleep(TASK_STOP_POLL_MS);
  }
}

function endTask() {
  try {
    schtasks(["/End", "/TN", taskName], { quiet: true });
  } catch {
    // The task may not exist, or may not be running; either way there is no
    // instance left to wait for.
    return;
  }
  waitForTaskToStop();
}

// Only a task that still exists can be started. `Register-ScheduledTask -Force`
// unregisters before it registers, so a failed registration leaves either the
// previous definition or nothing at all, and `/Run` against a name that is gone
// recovers nothing while reporting an error of its own.
function taskExists() {
  try {
    schtasks(["/Query", "/TN", taskName], { quiet: true });
    return true;
  } catch {
    return false;
  }
}

function taskState() {
  const script =
    "try { [Console]::Out.Write((Get-ScheduledTask -TaskName $env:CODEX_ROUTER_TASK).State.ToString()) } catch { exit 1 }";
  for (const executable of ["powershell.exe", "pwsh.exe"]) {
    try {
      return execFileSync(
        executable,
        ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
        {
          encoding: "utf8",
          env: { ...process.env, CODEX_ROUTER_TASK: taskName },
          stdio: ["ignore", "pipe", "ignore"],
          timeout: TASK_STATE_TIMEOUT_MS,
        },
      ).trim().toLowerCase();
    } catch {
      // Try Windows PowerShell after PowerShell Core, or fall back to schtasks.
    }
  }
  return undefined;
}

if (
  !new Set([
    "install",
    "uninstall",
    "start",
    "stop",
    "restart",
    "status",
    "render",
    "render-launcher",
    "render-task",
  ]).has(command)
) {
  console.error(
    "Usage: service-windows.mjs install|uninstall|start|stop|restart|status|render|render-launcher|render-task",
  );
  process.exit(2);
}

if (command === "render") {
  process.stdout.write(wrapper());
} else if (command === "render-launcher") {
  process.stdout.write(launcher());
} else if (command === "render-task") {
  process.stdout.write(`${JSON.stringify(taskAction())}\n`);
} else if (command === "install") {
  try {
    // Writing the launchers belongs inside the try: renameSync over the .vbs
    // raises a sharing violation while a running wscript.exe still holds it
    // open, and that used to throw out of install with nothing to catch it.
    writeLaunchers();
    // An upgrade from the console-visible task may still have that instance
    // running. Register-ScheduledTask -Force replaces the definition under the
    // same task name, so no duplicate is left behind, but it does not stop the
    // running instance, and MultipleInstances IgnoreNew would then drop the new
    // hidden run — the console window would survive until the next logon.
    endTask();
    installTask();
    schtasks(["/Run", "/TN", taskName], { quiet: true });
  } catch {
    // Scheduled-task creation can be restricted in a non-elevated terminal. The
    // launchers are still written, so the install is reported as success and
    // the caller can retry -- but endTask() has already stopped whatever was
    // running by this point, so simply returning would take a working router
    // down in exchange for nothing. Start whichever definition survived the
    // failed registration. When none did there is nothing to restore: no
    // snapshot was taken, and re-creating the old console-visible action would
    // reintroduce the very defect this launcher exists to fix.
    try {
      if (taskExists()) schtasks(["/Run", "/TN", taskName], { quiet: true });
    } catch {
      // Nothing left to start; the caller's readiness check reports the failure.
    }
  }
  process.stdout.write(`${JSON.stringify({ installed: true, path: wrapperPath })}\n`);
} else if (command === "uninstall") {
  endTask();
  try {
    schtasks(["/Delete", "/TN", taskName, "/F"], { quiet: true });
  } catch {
    // The task may not exist.
  }
  for (const target of [launcherPath, wrapperPath]) {
    try {
      if (existsSync(target)) unlinkSync(target);
    } catch {
      // The launcher may already be gone, or a concurrent uninstall removed it.
    }
  }
  process.stdout.write(`${JSON.stringify({ installed: false })}\n`);
} else if (command === "status") {
  let installed = false;
  let state = "stopped";
  try {
    schtasks(["/Query", "/TN", taskName, "/FO", "LIST", "/V"]);
    installed = true;
    state = taskState() || "ready";
  } catch {
    // Missing task.
  }
  process.stdout.write(
    `${JSON.stringify({ installed, loaded: state === "running", state })}\n`,
  );
} else if (command === "stop") {
  // Stopping is idempotent, like uninstall and restart: a task that is missing
  // or already idle is the state the caller asked for, not an error to raise.
  endTask();
  process.stdout.write(`${JSON.stringify({ state: "stopped" })}\n`);
} else {
  if (command === "restart") endTask();
  schtasks(["/Run", "/TN", taskName], { quiet: true });
  process.stdout.write(`${JSON.stringify({ state: "running" })}\n`);
}
