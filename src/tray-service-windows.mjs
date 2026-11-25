// Windows autostart for the unified Control Center. Without it the tray is a
// bare executable somebody has to remember to launch, so it disappears at
// every reboot -- and `control tray enable` answered {"supported":false} and
// exited 0, which reads as success while doing nothing at all.
//
// This is the router's own Task Scheduler pattern from service-windows.mjs,
// with one deliberate difference: no windowless wrapper. That wrapper exists
// to keep a console off the screen for a background Node process; the tray is
// a GUI binary that owns no console, and routing it through wscript would only
// put a script host between Task Scheduler and the window it has to show.
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

import { SOURCE_ROOT, TRAY_TASK_NAME } from "./paths.mjs";
import { skipServiceManagerCall } from "./service-write-guard.mjs";
import {
  controlCenterBinary,
  controlCenterLaunch,
  isRecognizedControlCenterAction,
  legacyCompanionActions,
  preferredCompanionBinary,
  recognizedLegacyCompanionAction,
} from "./tray-install.mjs";

const effectivePlatform = process.env.CODEX_ROUTER_SERVICE_PLATFORM || process.platform;
const command = process.argv[2] || "status";
const renderCommands = new Set(["render", "render-task", "render-electron"]);
// Resolved from the effective platform, not process.platform, so a render on
// a POSIX machine shows the Windows path it would actually register.
const TRAY_BINARY = controlCenterBinary(effectivePlatform, SOURCE_ROOT);
const TASK_STOP_TIMEOUT_MS = 10_000;
const TASK_START_TIMEOUT_MS = 10_000;
const TASK_STATE_POLL_MS = 250;
// Matches service-windows.mjs's TASK_STATE_TIMEOUT_MS (15s) for the identical
// call. A cold powershell.exe running the ScheduledTasks CDXML cmdlets is
// routinely 1.5-3s and slower under install load or on a domain; a stricter
// budget made a single slow Get-ScheduledTask abort install/start/restart.
// The per-host split below keeps either PowerShell host's share of the budget.
const TASK_COMMAND_TIMEOUT_MS = 15_000;
const MUTATION_DRAIN_TIMEOUT_MS = 12 * 60 * 1000;
const APP_READY_TIMEOUT_MS = 30_000;
const TASK_FULL_CONTROL_MASK = 0x1f01ff;
const LIFECYCLE_VERIFIED = Symbol("lifecycleVerified");

// Task Scheduler mutations must never run from a test run on a Windows dev
// box (a stray `npm test` would otherwise register/start a real tray task and
// rewrite its DACL). Reads stay live, so status still answers truthfully.
const HOST_MANAGED = process.platform === "win32";

if (effectivePlatform !== "win32" && !renderCommands.has(command)) {
  throw new Error("The Task Scheduler tray manager runs on Windows only.");
}

function schtasks(args, options = {}) {
  // Only mutable calls consult the guard; queries stay live so status can
  // still report whether the named task exists.
  if (options.mutating && skipServiceManagerCall({ hostManaged: HOST_MANAGED })) {
    return "";
  }
  return execFileSync("schtasks.exe", args, {
    encoding: "utf8",
    windowsHide: true,
    stdio: options.quiet ? ["ignore", "ignore", "ignore"] : ["ignore", "pipe", "pipe"],
    timeout: options.timeoutMs || TASK_COMMAND_TIMEOUT_MS,
  });
}

export function trayTaskAction(binary = TRAY_BINARY) {
  return { execute: binary, argument: "--tray-only" };
}

// Starting a task is different from recognizing one for migration. A
// recognized action may point at a stable install while this command is being
// run from a developer checkout; start/restart/open must never claim that
// other binary as the app they just launched. Require this checkout's exact
// packaged executable and its one supervised argument.
export function isCanonicalTrayTaskAction(action, binary = TRAY_BINARY) {
  if (typeof action?.execute !== "string" || typeof binary !== "string") return false;
  if (String(action.argument || "").trim() !== "--tray-only") return false;
  const actual = path.win32.normalize(action.execute.trim()).toLowerCase();
  const expected = path.win32.normalize(binary.trim()).toLowerCase();
  return actual === expected;
}

// Compatibility command name for older installers. It now returns the same
// packaged Control Center action as every canonical install path.
export function electronTaskAction() {
  return controlCenterLaunch(effectivePlatform, SOURCE_ROOT);
}

// RestartCount covers a crash, not a clean exit. That distinction is the whole
// reason the tray's Quit menu item still works: Task Scheduler treats a zero
// exit as the task finishing, so quitting stays quit until the next logon --
// the same conditional-KeepAlive intent the macOS agent spells out.
function installTask(action = trayTaskAction()) {
  // Register-ScheduledTask is a second Task Scheduler path, independent of
  // schtasks(). Keep it behind the same mutation guard so a test run cannot
  // register or replace the developer's real task.
  if (skipServiceManagerCall({ hostManaged: HOST_MANAGED })) return;
  const script = [
    "$principalSid = ([Security.Principal.WindowsIdentity]::GetCurrent().User.Value)",
    // Only passed when there is one: `-Argument ""` registers an empty
    // argument rather than none.
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

// Tri-state: "exists" | "missing" | "error". The boolean answer cannot
// distinguish "not installed" from "Task Scheduler itself would not say".
// `schtasks` names a missing task with a *localized* line ("ERROR: The system
// cannot find the file specified."), so its text cannot be classified the way
// callers need -- but Get-ScheduledTask reports the miss with a
// culture-invariant FullyQualifiedErrorId. A timeout, access-denied, or
// scheduler-down outcome raises that ID to a different value and is reported
// as "error", never as a missing task.
function taskExists(timeoutMs = TASK_COMMAND_TIMEOUT_MS) {
  const script = [
    "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8",
    'try { Get-ScheduledTask -TaskName $env:CODEX_ROUTER_TRAY_TASK -ErrorAction Stop | Out-Null; "[exists]" } catch { if ($_.FullyQualifiedErrorId -like "CmdletizationQuery_NotFound_TaskName,*") { "[missing]" } else { "[error]" } }',
  ].join("; ");
  const perHostTimeout = Math.max(50, Math.floor(timeoutMs / 2));
  // 5.1 and 7 can disagree about the current user's task reads, so both hosts
  // are consulted before a host-level failure is reported as indeterminate.
  let sawError = false;
  for (const executable of ["powershell.exe", "pwsh.exe"]) {
    try {
      const value = execFileSync(
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
      if (value === "[exists]") return "exists";
      if (value === "[missing]") return "missing";
      sawError = true;
    } catch {
      // A non-answering host is indeterminate, not evidence of an absent task.
      sawError = true;
    }
  }
  return sawError ? "error" : "missing";
}

function sleep(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function taskState(timeoutMs = TASK_COMMAND_TIMEOUT_MS) {
  // `schtasks` output is localized ("En ejecución" on Spanish Windows), so a
  // regex on its text reads a running task as stopped. Task Scheduler's own
  // State property is an enum that renders the same in every locale.
  // PowerShell 5.1 writes `[Console]::Out` in the OEM console encoding, so a
  // Task Name that contains non-ASCII bytes would corrupt stdout before Node
  // decodes it as UTF-8. Pin the child's output encoding so the JSON/text we
  // parse actually round-trips.
  const script =
    "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; try { [Console]::Out.Write((Get-ScheduledTask -TaskName $env:CODEX_ROUTER_TRAY_TASK).State.ToString()) } catch { exit 1 }";
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
    "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8",
    "$task = Get-ScheduledTask -TaskName $env:CODEX_ROUTER_TRAY_TASK -ErrorAction Stop",
    "$actions = @($task.Actions)",
    "if ($actions.Count -ne 1) { exit 1 }",
    "$action = $actions[0]",
    "if ($null -eq $action) { exit 1 }",
    "$principalId = [string]$task.Principal.UserId",
    "try { $principalSid = ([Security.Principal.SecurityIdentifier]::new($principalId)).Value } catch { $principalSid = ([Security.Principal.NTAccount]::new($principalId)).Translate([Security.Principal.SecurityIdentifier]).Value }",
    "$currentSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value",
    "$logonType = $task.Principal.LogonType.ToString()",
    "[Console]::Out.Write((@{ execute = [string]$action.Execute; argument = [string]$action.Arguments; principalSid = $principalSid; currentSid = $currentSid; logonType = $logonType } | ConvertTo-Json -Compress))",
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
      if (
        typeof value?.execute === "string"
        && value.execute
        && typeof value.principalSid === "string"
        && value.principalSid
        && typeof value.currentSid === "string"
        && value.currentSid
        && typeof value.logonType === "string"
        && value.logonType
      ) return value;
    } catch {
      // Try the other PowerShell host before reporting an unreadable action.
    }
  }
  return undefined;
}

function isCurrentUserInteractiveTask(registered) {
  return typeof registered?.principalSid === "string"
    && typeof registered?.currentSid === "string"
    && registered.principalSid.toLowerCase() === registered.currentSid.toLowerCase()
    && String(registered.logonType || "").toLowerCase() === "interactive";
}

function requireRecognizedCurrentUserTask(registered, operation) {
  if (!isCurrentUserInteractiveTask(registered)) {
    throw new Error(
      `The named ${TRAY_TASK_NAME} task is not an interactive task owned by the current user; it was not ${operation}.`,
    );
  }
  if (!isRecognizedControlCenterAction(registered) && !recognizedLegacyCompanionAction(registered)) {
    throw new Error(
      `The named ${TRAY_TASK_NAME} task has an unrecognized action; it was not ${operation}.`,
    );
  }
  return registered;
}

function sameRegisteredTaskIdentity(left, right) {
  if (!isCurrentUserInteractiveTask(left) || !isCurrentUserInteractiveTask(right)) return false;
  try {
    return path.win32.normalize(left.execute).toLowerCase()
        === path.win32.normalize(right.execute).toLowerCase()
      && String(left.argument || "") === String(right.argument || "")
      && left.principalSid.toLowerCase() === right.principalSid.toLowerCase()
      && String(left.logonType).toLowerCase() === String(right.logonType).toLowerCase();
  } catch {
    return false;
  }
}

function requireCanonicalRegisteredAction() {
  const registered = registeredTaskAction();
  if (!registered) {
    throw new Error("Task Scheduler did not return one registered tray action.");
  }
  requireRecognizedCurrentUserTask(registered, "used");
  if (!isCanonicalTrayTaskAction(registered)) {
    throw new Error(
      `The registered tray action is not the canonical Control Center at ${TRAY_BINARY}. ` +
        "Run: control tray install",
    );
  }
  if (!existsSync(registered.execute)) {
    throw new Error(`The registered Control Center is missing at ${registered.execute}.`);
  }
  return registered;
}

function unavailableLifecycle() {
  const state = {
    version: 1,
    running: false,
    pid: null,
    ready: false,
    visible: false,
    updatedAt: null,
  };
  Object.defineProperty(state, LIFECYCLE_VERIFIED, { value: false });
  return state;
}

function verifiedLifecycle(state) {
  Object.defineProperty(state, LIFECYCLE_VERIFIED, { value: true });
  return state;
}

function lifecycleWasVerified(state) {
  return state?.[LIFECYCLE_VERIFIED] === true;
}

function packagedGuiEnvironment() {
  const environment = { ...process.env };
  // Settings and repair commands run through packaged Electron's Node mode.
  // A direct launch of that same executable must explicitly drop the switch or
  // Electron will interpret `--query-lifecycle` / `--quit-for-update` as Node
  // argv and never enter the GUI lifecycle handler.
  delete environment.ELECTRON_RUN_AS_NODE;
  return environment;
}

function queryControlCenterLifecycle(executable) {
  if (!executable || !existsSync(executable)) return unavailableLifecycle();
  const result = spawnSync(executable, ["--query-lifecycle"], {
    encoding: "utf8",
    env: packagedGuiEnvironment(),
    stdio: ["ignore", "pipe", "ignore"],
    timeout: TASK_COMMAND_TIMEOUT_MS,
    windowsHide: true,
  });
  if (result.error || result.status !== 0) return unavailableLifecycle();
  try {
    const state = JSON.parse(String(result.stdout || "").trim());
    if (
      state?.version !== 1
      || typeof state.running !== "boolean"
      || !(state.pid === null || (Number.isSafeInteger(state.pid) && state.pid > 0))
      || typeof state.ready !== "boolean"
      || typeof state.visible !== "boolean"
      || !(state.updatedAt === null || typeof state.updatedAt === "string")
      || state.running !== (state.pid !== null)
      || (state.ready && !state.running)
      || (state.visible && !state.running)
    ) return unavailableLifecycle();
    return verifiedLifecycle(state);
  } catch {
    return unavailableLifecycle();
  }
}

function exactUserExecutableOwnsPid(executable, pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) return false;
  const script = [
    "$ErrorActionPreference = 'Stop'",
    "try {",
    "$target = [IO.Path]::GetFullPath($env:CODEX_ROUTER_TRAY_EXECUTE)",
    "$targetPid = [int]$env:CODEX_ROUTER_TRAY_PID",
    "$currentSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value",
    "$candidate = Get-CimInstance Win32_Process -Filter \"ProcessId = $targetPid\" -ErrorAction Stop",
    "if ($null -eq $candidate -or [string]::IsNullOrWhiteSpace([string]$candidate.ExecutablePath)) { exit 1 }",
    "$candidatePath = [IO.Path]::GetFullPath([string]$candidate.ExecutablePath)",
    "if (-not [string]::Equals($candidatePath, $target, [StringComparison]::OrdinalIgnoreCase)) { exit 1 }",
    "$owner = Invoke-CimMethod -InputObject $candidate -MethodName GetOwnerSid -ErrorAction Stop",
    "if ($owner.ReturnValue -ne 0 -or $owner.Sid -ne $currentSid) { exit 1 }",
    "$process = Get-Process -Id $targetPid -ErrorAction SilentlyContinue",
    "if ($null -eq $process) { exit 1 }",
    "$cimTicks = ([datetime]$candidate.CreationDate).ToUniversalTime().Ticks",
    "$startTimeDifference = [Math]::Abs($process.StartTime.ToUniversalTime().Ticks - $cimTicks)",
    "if ($startTimeDifference -gt [TimeSpan]::TicksPerMillisecond) { exit 1 }",
    "exit 0",
    "} catch { [Console]::Error.Write($_.Exception.Message); exit 3 }",
  ].join("\n");
  let lastFailure;
  for (const host of ["powershell.exe", "pwsh.exe"]) {
    const result = spawnSync(
      host,
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          CODEX_ROUTER_TRAY_EXECUTE: executable,
          CODEX_ROUTER_TRAY_PID: String(pid),
        },
        stdio: ["ignore", "ignore", "pipe"],
        timeout: TASK_COMMAND_TIMEOUT_MS,
        windowsHide: true,
      },
    );
    if (result.error?.code === "ENOENT") {
      lastFailure = result.error;
      continue;
    }
    if (result.error) {
      throw new Error(`Could not verify the Control Center process identity: ${result.error.message}`);
    }
    if (result.status === 0) return true;
    if (result.status === 1) return false;
    lastFailure = new Error(String(result.stderr || "").trim() || `${host} exited ${result.status}`);
  }
  throw new Error(
    `Could not verify the Control Center process identity${lastFailure ? `: ${lastFailure.message}` : "."}`,
  );
}

// Stop only a current-user process whose executable and complete launch argv
// match one repository-known companion action. CommandLineToArgvW is used
// instead of substring matching so a similarly named checkout, renderer child,
// or path embedded inside another argument cannot be terminated accidentally.
function stopExactUserAction(action, { stop = true } = {}) {
  if (!action?.execute || !existsSync(action.execute)) return 0;
  const script = [
    "$ErrorActionPreference = 'Stop'",
    "Add-Type -TypeDefinition @'",
    "using System;",
    "using System.Runtime.InteropServices;",
    "public static class RouterCommandLine {",
    "  [DllImport(\"shell32.dll\", SetLastError=true)] public static extern IntPtr CommandLineToArgvW([MarshalAs(UnmanagedType.LPWStr)] string commandLine, out int argc);",
    "  [DllImport(\"kernel32.dll\")] public static extern IntPtr LocalFree(IntPtr value);",
    "}",
    "'@",
    "function Get-RouterArgv([string]$Line) {",
    "  $count = 0",
    "  $pointer = [RouterCommandLine]::CommandLineToArgvW($Line, [ref]$count)",
    "  if ($pointer -eq [IntPtr]::Zero) { throw 'CommandLineToArgvW failed.' }",
    "  try {",
    "    $values = @()",
    "    for ($index = 0; $index -lt $count; $index += 1) {",
    "      $item = [Runtime.InteropServices.Marshal]::ReadIntPtr($pointer, $index * [IntPtr]::Size)",
    "      $values += [Runtime.InteropServices.Marshal]::PtrToStringUni($item)",
    "    }",
    "    return $values",
    "  } finally { [void][RouterCommandLine]::LocalFree($pointer) }",
    "}",
    "$target = [IO.Path]::GetFullPath($env:CODEX_ROUTER_TRAY_EXECUTE)",
    "$expectedArgument = [string]$env:CODEX_ROUTER_TRAY_ARGUMENT",
    "$stopMatches = $env:CODEX_ROUTER_TRAY_STOP_MATCHES -eq '1'",
    "$currentSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value",
    "function Test-RouterCandidate($Candidate) {",
    "  if ($null -eq $Candidate -or [string]::IsNullOrWhiteSpace([string]$Candidate.ExecutablePath) -or [string]::IsNullOrWhiteSpace([string]$Candidate.CommandLine)) { return $false }",
    "  $candidatePath = [IO.Path]::GetFullPath([string]$Candidate.ExecutablePath)",
    "  if (-not [string]::Equals($candidatePath, $target, [StringComparison]::OrdinalIgnoreCase)) { return $false }",
    "  $owner = Invoke-CimMethod -InputObject $Candidate -MethodName GetOwnerSid -ErrorAction Stop",
    "  if ($owner.ReturnValue -ne 0 -or $owner.Sid -ne $currentSid) { return $false }",
    "  $argv = @(Get-RouterArgv ([string]$Candidate.CommandLine))",
    "  if ([string]::IsNullOrEmpty($expectedArgument)) { return $argv.Count -eq 1 }",
    "  return $argv.Count -eq 2 -and [string]::Equals([string]$argv[1], $expectedArgument, [StringComparison]::OrdinalIgnoreCase)",
    "}",
    "function Get-RouterCandidates {",
    "  return @(Get-CimInstance Win32_Process -ErrorAction Stop | Where-Object { Test-RouterCandidate $_ })",
    "}",
    "function Get-SameRouterProcessHandle($Candidate) {",
    "  $pidValue = [int]$Candidate.ProcessId",
    "  $fresh = Get-CimInstance Win32_Process -Filter \"ProcessId = $pidValue\" -ErrorAction SilentlyContinue",
    "  if ($null -eq $fresh -or [string]$fresh.CreationDate -ne [string]$Candidate.CreationDate -or -not (Test-RouterCandidate $fresh)) { return $null }",
    "  $process = Get-Process -Id $pidValue -ErrorAction SilentlyContinue",
    "  if ($null -eq $process) { return $null }",
    "  $cimTicks = ([datetime]$fresh.CreationDate).ToUniversalTime().Ticks",
    "  $startTimeDifference = [Math]::Abs($process.StartTime.ToUniversalTime().Ticks - $cimTicks)",
    "  if ($startTimeDifference -gt [TimeSpan]::TicksPerMillisecond) { return $null }",
    "  return $process",
    "}",
    "$matches = @(Get-RouterCandidates)",
    "if (-not $stopMatches) { [Console]::Out.Write([string]$matches.Count); exit 0 }",
    "foreach ($candidate in $matches) {",
    "  $process = Get-SameRouterProcessHandle $candidate",
    "  if ($null -ne $process) { [void]$process.CloseMainWindow() }",
    "}",
    "$deadline = [DateTime]::UtcNow.AddSeconds(5)",
    "do {",
    "  $remaining = @(Get-RouterCandidates)",
    "  if ($remaining.Count -eq 0) { break }",
    "  Start-Sleep -Milliseconds 250",
    "} while ([DateTime]::UtcNow -lt $deadline)",
    "foreach ($candidate in @(Get-RouterCandidates)) {",
    "  $process = Get-SameRouterProcessHandle $candidate",
    "  if ($null -ne $process) { $process.Kill(); [void]$process.WaitForExit(5000) }",
    "}",
    "if (@(Get-RouterCandidates).Count -ne 0) { throw 'An exact companion process survived termination.' }",
    "[Console]::Out.Write([string]$matches.Count)",
  ].join("\n");
  let lastFailure;
  for (const host of ["powershell.exe", "pwsh.exe"]) {
    const result = spawnSync(
      host,
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          CODEX_ROUTER_TRAY_EXECUTE: action.execute,
          CODEX_ROUTER_TRAY_ARGUMENT: action.argument || "",
          CODEX_ROUTER_TRAY_STOP_MATCHES: stop ? "1" : "0",
        },
        stdio: ["ignore", "pipe", "pipe"],
        timeout: TASK_COMMAND_TIMEOUT_MS + 6_000,
        windowsHide: true,
      },
    );
    if (result.error?.code === "ENOENT") {
      lastFailure = result.error;
      continue;
    }
    if (!result.error && result.status === 0) {
      const count = Number.parseInt(String(result.stdout || "0"), 10);
      if (Number.isSafeInteger(count) && count >= 0 && String(count) === String(result.stdout || "").trim()) {
        return count;
      }
      throw new Error("The exact companion process query returned an invalid count.");
    }
    lastFailure = result.error || new Error(
      String(result.stderr || "").trim() || `${host} exited ${result.status}`,
    );
  }
  throw new Error(
    `Could not drain the exact current-user companion action: ${lastFailure?.message || "PowerShell did not answer."}`,
  );
}

function exactUserActionProcessCount(action) {
  return stopExactUserAction(action, { stop: false });
}

function exactCanonicalProcessCount(executable) {
  return exactUserActionProcessCount({ execute: executable, argument: "--tray-only" })
    + exactUserActionProcessCount({ execute: executable, argument: "" });
}

function stopKnownLegacyProcesses(registeredAction) {
  let stopped = 0;
  const actions = legacyCompanionActions("win32", SOURCE_ROOT);
  const registeredLegacy = recognizedLegacyCompanionAction(registeredAction);
  if (registeredLegacy) actions.push(registeredLegacy);
  const seen = new Set();
  for (const action of actions) {
    const identity = `${path.win32.normalize(action.execute).toLowerCase()}\0${action.argument.toLowerCase()}`;
    if (seen.has(identity)) continue;
    seen.add(identity);
    stopped += stopExactUserAction(action);
  }
  return stopped;
}

function waitForControlCenterReady(executable, timeoutMs = APP_READY_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const lifecycle = queryControlCenterLifecycle(executable);
    if (
      lifecycle.running
      && lifecycle.ready
      && exactUserExecutableOwnsPid(executable, lifecycle.pid)
    ) return lifecycle;
    if (Date.now() >= deadline) {
      throw new Error(`The Control Center did not report ready within ${timeoutMs}ms.`);
    }
    sleep(TASK_STATE_POLL_MS);
  }
}

// Task Scheduler's state only describes the instance it launched. The primary
// Electron process can instead have been opened by hand, leaving the task in
// Ready while that process drains an active provider mutation. Wait on the
// exact registered executable owned by this user before replacing its files.
function waitForExactUserExecutableExit(executable, timeoutMs, pid) {
  const script = [
    "$ErrorActionPreference = 'Stop'",
    "$target = [IO.Path]::GetFullPath($env:CODEX_ROUTER_TRAY_EXECUTE)",
    "$targetPid = 0",
    "[void][int]::TryParse($env:CODEX_ROUTER_TRAY_PID, [ref]$targetPid)",
    "$currentSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value",
    `$deadline = [DateTime]::UtcNow.AddMilliseconds(${timeoutMs})`,
    "do {",
    "  $running = $false",
    "  $filter = if ($targetPid -gt 0) { \"ProcessId = $targetPid\" } else { \"Name = 'Codex Router.exe'\" }",
    "  $candidates = @(Get-CimInstance Win32_Process -Filter $filter -ErrorAction Stop)",
    "  foreach ($candidate in $candidates) {",
    "    if ([string]::IsNullOrWhiteSpace([string]$candidate.ExecutablePath)) { continue }",
    "    $candidatePath = [IO.Path]::GetFullPath([string]$candidate.ExecutablePath)",
    "    if (-not [string]::Equals($candidatePath, $target, [StringComparison]::OrdinalIgnoreCase)) { continue }",
    "    $owner = Invoke-CimMethod -InputObject $candidate -MethodName GetOwnerSid -ErrorAction Stop",
    "    if ($owner.ReturnValue -eq 0 -and $owner.Sid -eq $currentSid) { $running = $true; break }",
    "  }",
    "  if (-not $running) { exit 0 }",
    `  Start-Sleep -Milliseconds ${TASK_STATE_POLL_MS}`,
    "} while ([DateTime]::UtcNow -lt $deadline)",
    "exit 2",
  ].join("\n");
  let lastFailure;
  for (const host of ["powershell.exe", "pwsh.exe"]) {
    const result = spawnSync(
      host,
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          CODEX_ROUTER_TRAY_EXECUTE: executable,
          CODEX_ROUTER_TRAY_PID: Number.isSafeInteger(pid) && pid > 0 ? String(pid) : "0",
        },
        stdio: ["ignore", "ignore", "pipe"],
        timeout: timeoutMs + TASK_COMMAND_TIMEOUT_MS,
        windowsHide: true,
      },
    );
    if (result.error?.code === "ENOENT") {
      lastFailure = result.error;
      continue;
    }
    if (result.error) {
      throw new Error(`Could not verify that the Control Center exited: ${result.error.message}`);
    }
    if (result.status === 0) return;
    if (result.status === 2) {
      throw new Error(`The Control Center did not finish its active operation within ${timeoutMs}ms.`);
    }
    lastFailure = new Error(String(result.stderr || "").trim() || `${host} exited ${result.status}`);
  }
  throw new Error(
    `Could not verify that the Control Center exited${lastFailure ? `: ${lastFailure.message}` : "."}`,
  );
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
    if (state === undefined) {
      const existence = taskExists(Math.min(TASK_COMMAND_TIMEOUT_MS, Math.max(50, deadline - Date.now())));
      if (existence === "missing") {
        if (action === "stop") return "missing";
        throw new Error(`The tray task disappeared while waiting for it to ${action}.`);
      }
      if (existence === "error") {
        // An unreadable scheduler is not a missing task: a stop would return
        // early on a task that is still there, and an uninstall would report
        // success it did not earn.
        throw new Error(`Task Scheduler did not answer while waiting for the tray to ${action}.`);
      }
    }
    if (Date.now() >= deadline) {
      throw new Error(`The tray task did not ${action} within ${timeoutMs}ms.`);
    }
    sleep(TASK_STATE_POLL_MS);
  }
}

function sameWindowsExecutable(left, right) {
  if (typeof left !== "string" || typeof right !== "string") return false;
  return path.win32.normalize(left).toLowerCase() === path.win32.normalize(right).toLowerCase();
}

function drainCanonicalExecutable(executable, { schedulerOwned = false } = {}) {
  const lifecycle = queryControlCenterLifecycle(executable);

  if (!lifecycleWasVerified(lifecycle)) {
    const schedulerState = schedulerOwned ? taskState() : undefined;
    if (schedulerOwned && schedulerState === undefined) {
      throw new Error(
        "Task Scheduler did not answer while verifying whether the Control Center can drain safely; it was not force-stopped.",
      );
    }
    const exactProcesses = exactCanonicalProcessCount(executable);
    if (exactProcesses > 0 || schedulerState === "running") {
      throw new Error(
        "The Control Center lifecycle could not be verified while an exact current-user instance may be running. Close it normally and retry; it was not force-stopped.",
      );
    }
    return;
  }

  if (!lifecycle.running) {
    const schedulerState = schedulerOwned ? taskState() : undefined;
    if (schedulerOwned && schedulerState === undefined) {
      throw new Error(
        "Task Scheduler did not answer while verifying whether the Control Center can drain safely; it was not force-stopped.",
      );
    }
    const exactProcesses = exactCanonicalProcessCount(executable);
    if (exactProcesses > 0 || schedulerState === "running") {
      throw new Error(
        "The Control Center lifecycle reported no owner while an exact current-user instance may still be running. Close it normally and retry; it was not force-stopped.",
      );
    }
    return;
  }

  if (!exactUserExecutableOwnsPid(executable, lifecycle.pid)) {
    throw new Error("The Control Center lifecycle PID does not belong to the registered current-user executable.");
  }
  const request = spawnSync(executable, ["--quit-for-update"], {
    encoding: "utf8",
    env: packagedGuiEnvironment(),
    stdio: "ignore",
    timeout: TASK_COMMAND_TIMEOUT_MS,
    windowsHide: true,
  });
  if (request.error) {
    throw new Error(`The Control Center did not accept a graceful stop: ${request.error.message}`);
  }
  if (request.status !== 0) {
    throw new Error(
      `The Control Center did not accept a graceful stop (exit ${request.status ?? "unknown"}).`,
    );
  }
  waitForExactUserExecutableExit(executable, MUTATION_DRAIN_TIMEOUT_MS, lifecycle.pid);
  if (schedulerOwned) {
    waitForTaskState((state) => state !== "running", TASK_STOP_TIMEOUT_MS, "stop");
  }
  if (exactCanonicalProcessCount(executable) > 0) {
    throw new Error(
      "Another exact current-user Control Center has no verified lifecycle owner. Close it normally and retry; it was not force-stopped.",
    );
  }
}

function endTask() {
  // A skipped `/End` (test run) means no mutation happened, so there is
  // nothing to wait for -- polling an absent host would spend the full
  // deadline on a question that cannot be answered.
  if (skipServiceManagerCall({ hostManaged: HOST_MANAGED })) return;
  const registered = registeredTaskAction();
  if (registered) requireRecognizedCurrentUserTask(registered, "stopped or replaced");
  const registeredLegacy = recognizedLegacyCompanionAction(registered);
  const registeredCanonical = isRecognizedControlCenterAction(registered) && !registeredLegacy;
  if (registeredCanonical) {
    if (!existsSync(registered.execute)) {
      throw new Error(`The registered Control Center is missing at ${registered.execute}; the task was not stopped.`);
    }
    // Current unified packages are mutation-aware. If their lifecycle cannot be
    // proved, refuse instead of treating the query failure as permission to
    // terminate an exact-looking GUI that may be in the middle of a mutation.
    drainCanonicalExecutable(registered.execute, { schedulerOwned: true });
  } else if (registeredLegacy) {
    try {
      schtasks(["/End", "/TN", TRAY_TASK_NAME], { quiet: true, mutating: true });
    } catch {
      // Missing or already idle: the state the caller asked for either way.
    }
    waitForTaskState((state) => state !== "running", TASK_STOP_TIMEOUT_MS, "stop");
  } else {
    const existence = taskExists();
    // Treat both "missing" and "error" as "nothing to uninstall". When both
    // PowerShell hosts fail to query the task (e.g., due to a timeout or locale
    // issue), taskExists() returns "error", but if schtasks also reports the
    // task doesn't exist, the error is just a probe failure, not evidence the
    // task exists. Refusing to uninstall in this case leaves the user stuck.
    // See #1175.
    if (existence === "exists") {
      throw new Error(
        `The named ${TRAY_TASK_NAME} task exists but its action could not be verified; it was not stopped.`,
      );
    }
  }

  // A task describes only one process. Drain manually launched copies of both
  // recognized legacy shells as exact current-user executable+argv pairs so
  // the unified tray cannot coexist with a Tauri or legacy Electron primary.
  stopKnownLegacyProcesses(registered);

  // A manually opened canonical package may belong to the current checkout
  // while Task Scheduler names a stable install. It gets the same verified
  // graceful drain contract; exact argv alone never authorizes a force-stop.
  if (
    TRAY_BINARY
    && existsSync(TRAY_BINARY)
    && !(registeredCanonical && sameWindowsExecutable(TRAY_BINARY, registered.execute))
  ) {
    drainCanonicalExecutable(TRAY_BINARY);
  }
}

function startTask() {
  if (skipServiceManagerCall({ hostManaged: HOST_MANAGED })) return;
  const registered = requireCanonicalRegisteredAction();
  schtasks(["/Run", "/TN", TRAY_TASK_NAME], { quiet: true, mutating: true });
  waitForTaskState((state) => state === "running", TASK_START_TIMEOUT_MS, "start");
  waitForControlCenterReady(registered.execute);
  if (taskState() !== "running") {
    throw new Error("The Control Center became ready outside the supervised Task Scheduler instance.");
  }
}

function requireBuiltTray() {
  if (!TRAY_BINARY || !existsSync(TRAY_BINARY)) {
    throw new Error(
      `The tray app is not built at ${TRAY_BINARY}. ` +
        "Run scripts\\build-electron-companion.ps1 first.",
    );
  }
}

// Start and restart always resolve the canonical packaged Control Center.
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
        "first.",
    );
  }
}

// A registered task pointing at a missing packaged app silently never appears,
// so fail before mutating Task Scheduler.
function requireBuiltElectron() {
  const binary = controlCenterBinary(effectivePlatform, SOURCE_ROOT);
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
    "validate",
    "lifecycle",
    "status",
    "render",
    "render-task",
    "render-electron",
  ]).has(command)
) {
  console.error(
    "Usage: tray-service-windows.mjs install|install-electron|uninstall|start|stop|restart|validate|lifecycle|status|render|render-task|render-electron",
  );
  process.exit(2);
}

if (command === "render" || command === "render-task") {
  process.stdout.write(`${JSON.stringify(trayTaskAction())}\n`);
} else if (command === "render-electron") {
  process.stdout.write(`${JSON.stringify(electronTaskAction())}\n`);
} else if (command === "install-electron") {
  // Compatibility alias retained for callers from the previous release.
  requireBuiltElectron();
  endTask();
  installTask(electronTaskAction());
  startTask();
  process.stdout.write(
    `${JSON.stringify({ installed: true, ...electronTaskAction() })}\n`,
  );
} else if (command === "status") {
  const existence = taskExists();
  if (existence === "error") {
    // An indeterminate scheduler answer must not read as either success or a
    // missing task. `status` cannot refuse here: a non-zero exit broke callers
    // that parse its JSON (and made the Windows-dispatch test pass vacuously on
    // empty stdout). Emit a tri-state document instead: installed is not
    // asserted, and the distinct "unknown" state plus `why` surface the
    // unreadable scheduler honestly.
    const companionPath = builtCompanionPath();
    process.stdout.write(
      `${JSON.stringify({
        installed: false,
        supported: true,
        loaded: false,
        appPresent: Boolean(companionPath && existsSync(companionPath)),
        state: "unknown",
        path: companionPath,
        argument: undefined,
        canonical: false,
        why: "Task Scheduler did not answer whether the tray task is registered.",
      })}\n`,
    );
  } else {
    const installed = existence === "exists";
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
        argument: action?.argument || "",
        canonical: installed && isCurrentUserInteractiveTask(action) && isCanonicalTrayTaskAction(action),
      })}\n`,
    );
  }
} else if (command === "validate") {
  requireBuiltTray();
  const action = requireCanonicalRegisteredAction();
  const lifecycle = queryControlCenterLifecycle(action.execute);
  if (
    !lifecycle.running
    || !lifecycle.ready
    || !exactUserExecutableOwnsPid(action.execute, lifecycle.pid)
  ) {
    throw new Error("The canonical Control Center is not ready.");
  }
  process.stdout.write(`${JSON.stringify({ valid: true, ...action, lifecycle })}\n`);
} else if (command === "lifecycle") {
  const registered = registeredTaskAction();
  const executable = isCurrentUserInteractiveTask(registered) && isRecognizedControlCenterAction(registered)
    ? registered.execute
    : builtCompanionPath();
  process.stdout.write(`${JSON.stringify(queryControlCenterLifecycle(executable))}\n`);
} else if (command === "install") {
  requireBuiltTray();
  endTask();
  installTask();
  startTask();
  process.stdout.write(`${JSON.stringify({ installed: true, path: TRAY_BINARY })}\n`);
} else if (command === "uninstall") {
  const initial = registeredTaskAction();
  if (!initial) {
    const existence = taskExists();
    if (existence !== "missing") {
      throw new Error(
        `The named ${TRAY_TASK_NAME} task exists or is unreadable, but its identity could not be verified; it was not deleted.`,
      );
    }
  } else {
    requireRecognizedCurrentUserTask(initial, "deleted");
    endTask();
  }
  const beforeDelete = registeredTaskAction();
  if (beforeDelete) {
    requireRecognizedCurrentUserTask(beforeDelete, "deleted");
    if (!sameRegisteredTaskIdentity(initial, beforeDelete)) {
      throw new Error(
        `The named ${TRAY_TASK_NAME} task changed while uninstall was draining it; it was not deleted.`,
      );
    }
  } else if (taskExists() !== "missing") {
    throw new Error(
      `The named ${TRAY_TASK_NAME} task became unreadable during uninstall; it was not deleted.`,
    );
  }
  try {
    if (beforeDelete) {
      schtasks(["/Delete", "/TN", TRAY_TASK_NAME, "/F"], { quiet: true, mutating: true });
    }
  } catch (error) {
    // Missing is already the requested state. A task that still exists means
    // Task Scheduler rejected the deletion, which must not be reported as a
    // successful uninstall.
    if (taskExists() === "exists") {
      const failure = new Error("Task Scheduler did not remove the tray task.");
      failure.cause = error;
      throw failure;
    }
  }
  const existence = taskExists();
  if (existence === "exists") {
    throw new Error("Task Scheduler still reports the tray task after deletion.");
  }
  if (existence === "error") {
    throw new Error("Task Scheduler did not answer whether the tray task was removed.");
  }
  process.stdout.write(`${JSON.stringify({ installed: false })}\n`);
} else if (command === "stop") {
  endTask();
  process.stdout.write(`${JSON.stringify({ state: "stopped" })}\n`);
} else {
  // start and restart. A tray that was quit by hand is not running, so both
  // reduce to asking Task Scheduler for a fresh instance.
  requireBuiltCompanion();
  const existence = taskExists();
  if (existence === "missing") {
    throw new Error(`The tray task is not installed. Run: control tray enable`);
  }
  if (existence === "error") {
    throw new Error("Task Scheduler did not answer whether the tray task is registered.");
  }
  // Validate before restart stops anything: a wrapper run from another
  // checkout must not terminate that checkout's registered Control Center and
  // only then discover that it is not allowed to start it again.
  requireCanonicalRegisteredAction();
  if (command === "restart") endTask();
  startTask();
  process.stdout.write(`${JSON.stringify({ state: "running" })}\n`);
}
