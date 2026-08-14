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
import { desktopTrayBinary } from "./tray-install.mjs";

const effectivePlatform = process.env.CODEX_ROUTER_SERVICE_PLATFORM || process.platform;
const command = process.argv[2] || "status";
const renderCommands = new Set(["render", "render-task"]);
// Resolved from the effective platform, not process.platform, so a render on
// a POSIX machine shows the Windows path it would actually register.
const TRAY_BINARY = desktopTrayBinary(effectivePlatform, SOURCE_ROOT);

if (effectivePlatform !== "win32" && !renderCommands.has(command)) {
  throw new Error("The Task Scheduler tray manager runs on Windows only.");
}

function schtasks(args, options = {}) {
  return execFileSync("schtasks.exe", args, {
    encoding: "utf8",
    windowsHide: true,
    stdio: options.quiet ? ["ignore", "ignore", "ignore"] : ["ignore", "pipe", "pipe"],
  });
}

export function trayTaskAction(binary = TRAY_BINARY) {
  return { execute: binary, argument: "" };
}

// RestartCount covers a crash, not a clean exit. That distinction is the whole
// reason the tray's Quit menu item still works: Task Scheduler treats a zero
// exit as the task finishing, so quitting stays quit until the next logon --
// the same conditional-KeepAlive intent the macOS agent spells out.
function installTask() {
  const script = [
    "$action = New-ScheduledTaskAction -Execute $env:CODEX_ROUTER_TRAY_EXECUTE",
    "$trigger = New-ScheduledTaskTrigger -AtLogOn -User ([Security.Principal.WindowsIdentity]::GetCurrent().Name)",
    "$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew",
    "$principal = New-ScheduledTaskPrincipal -UserId ([Security.Principal.WindowsIdentity]::GetCurrent().Name) -LogonType Interactive -RunLevel Limited",
    "Register-ScheduledTask -TaskName $env:CODEX_ROUTER_TRAY_TASK -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Force | Out-Null",
  ].join("; ");
  execFileSync(
    "powershell.exe",
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
    {
      env: {
        ...process.env,
        CODEX_ROUTER_TRAY_TASK: TRAY_TASK_NAME,
        CODEX_ROUTER_TRAY_EXECUTE: trayTaskAction().execute,
      },
      stdio: ["ignore", "ignore", "ignore"],
      windowsHide: true,
    },
  );
}

function taskExists() {
  try {
    schtasks(["/Query", "/TN", TRAY_TASK_NAME], { quiet: true });
    return true;
  } catch {
    return false;
  }
}

function taskRunning() {
  try {
    return /\bRunning\b/i.test(schtasks(["/Query", "/TN", TRAY_TASK_NAME, "/FO", "LIST", "/V"]));
  } catch {
    return false;
  }
}

function endTask() {
  try {
    schtasks(["/End", "/TN", TRAY_TASK_NAME], { quiet: true });
  } catch {
    // Missing or already idle: the state the caller asked for either way.
  }
}

function requireBuiltTray() {
  if (!TRAY_BINARY || !existsSync(TRAY_BINARY)) {
    throw new Error(
      `The tray app is not built at ${TRAY_BINARY}. ` +
        "Run scripts\\build-desktop-tray.ps1 -BinaryOnly first.",
    );
  }
}

if (
  !new Set(["install", "uninstall", "start", "stop", "restart", "status", "render", "render-task"]).has(
    command,
  )
) {
  console.error(
    "Usage: tray-service-windows.mjs install|uninstall|start|stop|restart|status|render|render-task",
  );
  process.exit(2);
}

if (command === "render" || command === "render-task") {
  process.stdout.write(`${JSON.stringify(trayTaskAction())}\n`);
} else if (command === "status") {
  const installed = taskExists();
  process.stdout.write(
    `${JSON.stringify({
      installed,
      supported: true,
      loaded: installed && taskRunning(),
      appPresent: Boolean(TRAY_BINARY) && existsSync(TRAY_BINARY),
      state: installed && taskRunning() ? "running" : "stopped",
      path: TRAY_BINARY,
    })}\n`,
  );
} else if (command === "install") {
  requireBuiltTray();
  endTask();
  installTask();
  schtasks(["/Run", "/TN", TRAY_TASK_NAME], { quiet: true });
  process.stdout.write(`${JSON.stringify({ installed: true, path: TRAY_BINARY })}\n`);
} else if (command === "uninstall") {
  endTask();
  try {
    schtasks(["/Delete", "/TN", TRAY_TASK_NAME, "/F"], { quiet: true });
  } catch {
    // The task may not exist.
  }
  process.stdout.write(`${JSON.stringify({ installed: false })}\n`);
} else if (command === "stop") {
  endTask();
  process.stdout.write(`${JSON.stringify({ state: "stopped" })}\n`);
} else {
  // start and restart. A tray that was quit by hand is not running, so both
  // reduce to asking Task Scheduler for a fresh instance.
  requireBuiltTray();
  if (!taskExists()) {
    throw new Error(`The tray task is not installed. Run: control tray enable`);
  }
  if (command === "restart") endTask();
  schtasks(["/Run", "/TN", TRAY_TASK_NAME], { quiet: true });
  process.stdout.write(`${JSON.stringify({ state: "running" })}\n`);
}
