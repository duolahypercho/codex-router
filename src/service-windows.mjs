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
const TASK_NAMES = {
  codex: "Codex Router",
  claude: "Codex Router - Claude",
  cursor: "Codex Router - Cursor",
};
const WRAPPER_NAMES = {
  codex: "start-codex-router.cmd",
  claude: "start-claude-router.cmd",
  cursor: "start-cursor-router.cmd",
};
const taskName = TASK_NAMES[TARGET];
const wrapperPath = path.join(STATE_DIR, WRAPPER_NAMES[TARGET]);

if (effectivePlatform !== "win32" && command !== "render") {
  throw new Error("The Task Scheduler service manager runs on Windows only.");
}

function cmdEscape(value) {
  return String(value).replaceAll("%", "%%").replaceAll('"', '""');
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
    ...(process.env.KIMI_CODE_HOME ? { KIMI_CODE_HOME: process.env.KIMI_CODE_HOME } : {}),
  };
  return `@echo off\r\n${Object.entries(variables)
    .map(([key, value]) => `set "${key}=${cmdEscape(value)}"`)
    .join("\r\n")}\r\n"${cmdEscape(process.execPath)}" "${cmdEscape(start)}" >> "${cmdEscape(LOG_PATH)}" 2>&1\r\n`;
}

function schtasks(args, options = {}) {
  return execFileSync("schtasks.exe", args, {
    encoding: "utf8",
    stdio: options.quiet ? ["ignore", "ignore", "ignore"] : ["ignore", "pipe", "pipe"],
  });
}

function writeWrapper() {
  mkdirSync(STATE_DIR, { recursive: true });
  const temporary = `${wrapperPath}.tmp.${process.pid}`;
  writeFileSync(temporary, wrapper(), "utf8");
  renameSync(temporary, wrapperPath);
}

function installTask() {
  const script = [
    "$action = New-ScheduledTaskAction -Execute 'cmd.exe' -Argument ('/D /C \"\"' + $env:CODEX_ROUTER_WRAPPER + '\"\"')",
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
          CODEX_ROUTER_WRAPPER: wrapperPath,
        },
        stdio: ["ignore", "ignore", "ignore"],
      },
    );
  } catch {
    const action = `cmd.exe /D /C ""${wrapperPath}""`;
    schtasks(
      ["/Create", "/TN", taskName, "/SC", "ONLOGON", "/TR", action, "/RL", "LIMITED", "/F"],
      { quiet: true },
    );
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
        },
      ).trim().toLowerCase();
    } catch {
      // Try Windows PowerShell after PowerShell Core, or fall back to schtasks.
    }
  }
  return undefined;
}

if (!new Set(["install", "uninstall", "start", "stop", "restart", "status", "render"]).has(command)) {
  console.error("Usage: service-windows.mjs install|uninstall|start|stop|restart|status|render");
  process.exit(2);
}

if (command === "render") {
  process.stdout.write(wrapper());
} else if (command === "install") {
  writeWrapper();
  installTask();
  schtasks(["/Run", "/TN", taskName], { quiet: true });
  process.stdout.write(`${JSON.stringify({ installed: true, path: wrapperPath })}\n`);
} else if (command === "uninstall") {
  try {
    schtasks(["/End", "/TN", taskName], { quiet: true });
  } catch {
    // The task may not be running.
  }
  try {
    schtasks(["/Delete", "/TN", taskName, "/F"], { quiet: true });
  } catch {
    // The task may not exist.
  }
  if (existsSync(wrapperPath)) unlinkSync(wrapperPath);
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
  schtasks(["/End", "/TN", taskName], { quiet: true });
  process.stdout.write(`${JSON.stringify({ state: "stopped" })}\n`);
} else {
  if (command === "restart") {
    try {
      schtasks(["/End", "/TN", taskName], { quiet: true });
    } catch {
      // The task may not be running.
    }
  }
  schtasks(["/Run", "/TN", taskName], { quiet: true });
  process.stdout.write(`${JSON.stringify({ state: "running" })}\n`);
}
