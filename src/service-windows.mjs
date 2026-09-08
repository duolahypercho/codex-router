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
import {
  clearServiceProcessState,
  readServiceProcessState,
  serviceProcessOwns,
} from "./service-process.mjs";
import { ensureCheckoutReadable, protectPrivateFile } from "./file-security.mjs";
import { providerApiKeyServiceEnvironment } from "./provider-api-key-service-environment.mjs";
import { serviceProxyEnvironment } from "./proxy-environment.mjs";
import {
  skipServiceManagerCall,
  assertServiceWriteIsolated,
} from "./service-write-guard.mjs";
import { windowsScheduledTaskState } from "./windows-task-state.mjs";

// Only this platform's own module can reach this machine's Task Scheduler.
// Cross-platform render tests execute this module on POSIX with executable
// stubs, so those calls must remain live; a real Windows test process must
// never mutate the developer's scheduler.
const HOST_MANAGED = process.platform === "win32";

const effectivePlatform = process.env.CODEX_ROUTER_SERVICE_PLATFORM || process.platform;
const command = process.argv[2] || "status";
const renderCommands = new Set(["render", "render-launcher", "render-task"]);
const taskName = "Codex Router";
const guardLauncherWrite = () => assertServiceWriteIsolated(STATE_DIR, {
  redirected: Boolean(
    process.env.MODEL_ROUTER_STATE_DIR || process.env.CODEX_ROUTER_STATE_DIR,
  ),
  label: "service launchers",
  override: "MODEL_ROUTER_STATE_DIR",
});

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
    MODEL_ROUTER_GROK_OAUTH_PORT: String(PORTS.grokOauth),
    MODEL_ROUTER_DEVIN_CLI_PORT: String(PORTS.devinCli),
    MODEL_ROUTER_ANTIGRAVITY_OAUTH_PORT: String(PORTS.antigravityOauth),
    CODEX_HOME,
    CODEX_ROUTER_STATE_DIR: STATE_DIR,
    CODEX_ROUTER_QUIET: "1",
    CODEX_ROUTER_GATEWAY_PORT: String(PORTS.gateway),
    CODEX_ROUTER_OAUTH_PORT: String(PORTS.oauth),
    CODEX_ROUTER_PORT: String(PORTS.router),
    CODEX_ROUTER_API_PORT: String(PORTS.api),
    ...serviceProxyEnvironment(),
    ...providerApiKeyServiceEnvironment(),
    // The LiteLLM gateway is a Python process. Force UTF-8 output so its
    // startup banner and logs do not crash on Windows systems whose default
    // ANSI/OEM code page is not UTF-8 (e.g. Russian cp1251), where Python
    // would otherwise encode stdout as the legacy code page.
    PYTHONIOENCODING: "utf-8",
    PYTHONUTF8: "1",
    ...(process.env.KIMI_CODE_HOME ? { KIMI_CODE_HOME: process.env.KIMI_CODE_HOME } : {}),
  };
  return `@echo off\r\nsetlocal DisableDelayedExpansion\r\n${Object.entries(variables)
    .map(([key, value]) => `set "${key}=${cmdEscape(value)}"`)
    .join("\r\n")}\r\n"${cmdEscape(process.execPath)}" "${cmdEscape(start)}" >> "${cmdEscape(LOG_PATH)}" 2>&1\r\n`;
}

// The scheduled task launches this script through `wscript.exe //B //NoLogo`,
// which is a windowless host, and the script starts the CMD wrapper with a
// window style of 0. Without it the wrapper owned a console window that stayed
// on screen for the router's lifetime and reappeared on every watchdog restart.
//
// The `True` wait flag keeps the task instance alive for the router's lifetime
// so Task Scheduler state and `schtasks /End` track the real process tree.
// Propagating the wrapper exit code still matters for diagnostics
// (`LastTaskResult`), but it does not drive relaunch: Task Scheduler's
// RestartOnFailure only covers actions that fail to start, not a non-zero
// exit after a successful start (issue #581). Relaunch after exit or a power
// event comes from the minute heartbeat trigger in installTask().
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
  // Queries are intentionally not skipped: status must report whether the
  // named task exists. Callers mark only service-manager mutations below.
  if (options.mutating && skipServiceManagerCall({ hostManaged: HOST_MANAGED })) {
    return "";
  }
  return execFileSync("schtasks.exe", args, {
    encoding: "utf8",
    stdio: options.quiet ? ["ignore", "ignore", "ignore"] : ["ignore", "pipe", "pipe"],
  });
}

function writeAtomic(target, contents) {
  guardLauncherWrite();
  const temporary = `${target}.tmp.${process.pid}`;
  try {
    writeFileSync(temporary, contents, { mode: 0o600 });
    // Proxy URLs may contain credentials. Protect both the temporary file and
    // the replaced launcher so Windows does not leave the secret readable via
    // inherited ACLs (POSIX mode bits are kept in step for deterministic tests).
    protectPrivateFile(temporary);
    // renameSync replaces an existing destination on Windows, so reinstalling
    // over an older launcher pair is a plain overwrite rather than a conflict.
    renameSync(temporary, target);
    protectPrivateFile(target);
  } catch (error) {
    try {
      unlinkSync(temporary);
    } catch {
      // Best effort cleanup; preserve the original write/ACL error.
    }
    throw error;
  }
}

function writeLaunchers() {
  // Refuse before creating the state directory. A test must never leave even
  // an empty directory behind in the user's real install location.
  guardLauncherWrite();
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
  // PowerShell is a second Task Scheduler path, independent of schtasks().
  // Keep it behind the same mutation guard so tests cannot register or replace
  // the user's real task.
  if (skipServiceManagerCall({ hostManaged: HOST_MANAGED })) return;
  const { execute, argument } = taskAction();
  const script = [
    // The action strings travel through the environment so that the quotes
    // around the launcher path never pass through powershell.exe's -Command
    // reparse or the schtasks argument escaper.
    "$action = New-ScheduledTaskAction -Execute $env:CODEX_ROUTER_TASK_EXECUTE -Argument $env:CODEX_ROUTER_TASK_ARGUMENT",
    // Logon alone never re-fires on wake/fast-startup, and RestartOnFailure
    // does not relaunch after a started action exits (issue #581). The minute
    // heartbeat is the supervisor: MultipleInstances IgnoreNew drops it while
    // the router is alive, and StartWhenAvailable catches ticks missed in sleep.
    "$logon = New-ScheduledTaskTrigger -AtLogOn -User ([Security.Principal.WindowsIdentity]::GetCurrent().Name)",
    "$heartbeat = New-ScheduledTaskTrigger -Once -At (Get-Date) -RepetitionInterval (New-TimeSpan -Minutes 1) -RepetitionDuration (New-TimeSpan -Days 9999)",
    "$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew -StartWhenAvailable",
    "$principal = New-ScheduledTaskPrincipal -UserId ([Security.Principal.WindowsIdentity]::GetCurrent().Name) -LogonType Interactive -RunLevel Limited",
    "Register-ScheduledTask -TaskName $env:CODEX_ROUTER_TASK -Action $action -Trigger @($logon, $heartbeat) -Settings $settings -Principal $principal -Force | Out-Null",
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
        // Registration also runs from the GUI installer and the Control
        // Center, where a console child gets its own window (issue #565).
        windowsHide: true,
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
      { quiet: true, mutating: true },
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
// Task Scheduler can report Ready before the detached cmd/node descendants
// have gone away. Give the verified tree and its ports their own bounded wait
// after task state changes, so restart never races the old listener.
const SERVICE_TREE_STOP_TIMEOUT_MS = 15_000;
const SERVICE_TREE_STOP_POLL_MS = 250;
const SERVICE_TREE_COMMAND_TIMEOUT_MS = 2_000;

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

function servicePorts(state) {
  const ports = state?.ports && typeof state.ports === "object" ? state.ports : PORTS;
  return [...new Set(Object.values(ports).filter((port) => Number.isSafeInteger(port) && port > 0))];
}

// `taskkill /T /F` is the ownership boundary. This netstat check is only a
// final readiness guard: if an unrelated process owns one of the configured
// ports it is never killed, and restart waits until the normal readiness check
// can report the conflict instead of claiming the old tree was stopped.
function managedPortStillListening(state) {
  // netstat is a machine-wide probe. It is not needed to exercise fixture
  // service lifecycle code and can observe unrelated listeners, so keep it
  // out of real Windows test runs.
  if (skipServiceManagerCall({ hostManaged: HOST_MANAGED })) return false;
  try {
    const output = execFileSync("netstat.exe", ["-ano", "-p", "tcp"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: SERVICE_TREE_COMMAND_TIMEOUT_MS,
      windowsHide: true,
    });
    const ports = new Set(servicePorts(state).map((port) => `:${port}`));
    return String(output)
      .split(/\r?\n/)
      .some((line) => {
        const fields = line.trim().split(/\s+/);
        const local = String(fields[1] || "");
        const colon = local.lastIndexOf(":");
        const suffix = colon >= 0 ? local.slice(colon) : local;
        return fields[0] === "TCP" && fields[3] === "LISTENING" && ports.has(suffix);
      });
  } catch {
    // A missing/blocked netstat cannot prove a listener is present. The
    // identity-checked process tree is still terminated below, and the normal
    // health probe remains the final readiness check.
    return false;
  }
}

function stopOwnedServiceTree() {
  // This path can issue taskkill and then poll process/port state for 15s.
  // Under test, the service-manager mutation was skipped, so there is no
  // owned tree to stop and no reason to touch the host or wait on it.
  if (skipServiceManagerCall({ hostManaged: HOST_MANAGED })) return;
  const state = readServiceProcessState();
  if (!state || state.pid === process.pid || !serviceProcessOwns(state, { platform: effectivePlatform })) {
    return;
  }
  try {
    execFileSync("taskkill.exe", ["/PID", String(state.pid), "/T", "/F"], {
      encoding: "utf8",
      stdio: ["ignore", "ignore", "ignore"],
      timeout: SERVICE_TREE_COMMAND_TIMEOUT_MS,
      windowsHide: true,
    });
  } catch {
    // A process that already exited is the desired state. If taskkill failed
    // for another reason, the bounded wait below leaves the record intact so a
    // later stop can try the same verified identity again.
  }
  const deadline = Date.now() + SERVICE_TREE_STOP_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const alive = serviceProcessOwns(state, { platform: effectivePlatform });
    const listening = managedPortStillListening(state);
    if (!alive && !listening) {
      clearServiceProcessState();
      return;
    }
    sleep(SERVICE_TREE_STOP_POLL_MS);
  }
  if (
    !serviceProcessOwns(state, { platform: effectivePlatform }) &&
    !managedPortStillListening(state)
  ) {
    clearServiceProcessState();
  }
}

function endTask() {
  // Do not poll after a skipped `/End`: taskState is a truthful read, but in a
  // test there was no mutation to wait for and a missing PowerShell can spend
  // the full timeout. This also keeps Kimi OAuth cleanup bounded.
  const managerSkipped = skipServiceManagerCall({ hostManaged: HOST_MANAGED });
  if (managerSkipped) return;
  try {
    schtasks(["/End", "/TN", taskName], { quiet: true, mutating: true });
  } catch {
    // The task may not exist, or may not be running. An orphaned router root
    // can still be recorded even in that case, so continue to the ownership
    // cleanup rather than returning early.
  }
  waitForTaskToStop();
  stopOwnedServiceTree();
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

function setTaskEnabled(enabled) {
  schtasks(
    ["/Change", "/TN", taskName, enabled ? "/ENABLE" : "/DISABLE"],
    { quiet: true, mutating: true },
  );
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
          // Status is polled from the tray on a timer, so an unhidden console
          // here is a window that reappears on its own (issue #565).
          windowsHide: true,
        },
      ).trim().toLowerCase();
    } catch {
      // Try Windows PowerShell after PowerShell Core, or fall back to schtasks.
    }
  }
  return undefined;
}

async function taskRunning(state) {
  if (state === "running") return true;
  // Task Scheduler can answer Ready while its detached launcher is still
  // serving. Reuse the process-level probe that guards startup readiness, but
  // keep an unavailable query inconclusive so a restricted shell cannot turn
  // an idle task into a false running service.
  const corroborated = await windowsScheduledTaskState({
    taskName,
    platform: effectivePlatform,
    timeoutMs: TASK_STATE_TIMEOUT_MS,
  });
  // Neither signal is sufficient alone: COM instances can outlive their
  // process, while the machine-wide launcher scan can also see a manually
  // started router. Only their conjunction corroborates this task.
  return corroborated?.instanceCount > 0 && corroborated?.launcherAlive === true;
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
  // Keep the guard outside the scheduler-recovery catch below. An unredirected
  // test install is a safety violation, not a restricted Task Scheduler
  // failure, and must exit non-zero without touching the host filesystem.
  guardLauncherWrite();
  try {
    // Ensure the checkout directory is readable by the Limited-level scheduled
    // task. An elevated installer creates files with ACLs that only allow the
    // elevated account to read them, while the task runs at Limited level
    // (issue #548). Grant Users read access so the task can load modules.
    ensureCheckoutReadable(SOURCE_ROOT);
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
    schtasks(["/Run", "/TN", taskName], { quiet: true, mutating: true });
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
      if (taskExists()) schtasks(["/Run", "/TN", taskName], { quiet: true, mutating: true });
    } catch {
      // Nothing left to start; the caller's readiness check reports the failure.
    }
  }
  // Launchers alone are not an installed service. A restricted scheduler (or
  // a test-mode mutation guard) must not claim success when the task is absent.
  process.stdout.write(`${JSON.stringify({ installed: taskExists(), path: wrapperPath })}\n`);
} else if (command === "uninstall") {
  // Refuse before `/End`, `/Delete`, or any filesystem removal when a test has
  // not redirected its service state directory.
  guardLauncherWrite();
  endTask();
  try {
    schtasks(["/Delete", "/TN", taskName, "/F"], { quiet: true, mutating: true });
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
  let loaded = false;
  try {
    schtasks(["/Query", "/TN", taskName, "/FO", "LIST", "/V"]);
    installed = true;
    state = taskState() || "ready";
    loaded = await taskRunning(state);
    if (loaded) state = "running";
  } catch {
    // Missing task.
  }
  process.stdout.write(
    `${JSON.stringify({ installed, loaded, state })}\n`,
  );
} else if (command === "stop") {
  // A heartbeat trigger must not undo an explicit stop. Disable the task before
  // ending the active instance so scheduled ticks stay inert until start/restart.
  // If the task is already missing, stopping remains idempotent.
  if (taskExists()) {
    setTaskEnabled(false);
    endTask();
  }
  process.stdout.write(`${JSON.stringify({ state: "stopped" })}\n`);
} else {
  if (command === "restart") endTask();
  setTaskEnabled(true);
  schtasks(["/Run", "/TN", taskName], { quiet: true, mutating: true });
  process.stdout.write(`${JSON.stringify({ state: "running" })}\n`);
}
