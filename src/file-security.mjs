import { execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

const WINDOWS_PRIVATE_ASYNC_TIMEOUT_MS = 30_000;
const WINDOWS_PRIVATE_ASYNC_OUTPUT_LIMIT = 64 * 1024;

// Windows private-file hardening is one bounded PowerShell operation per
// atomic write. Keeping the async path one-shot is deliberate: Windows
// PowerShell does not provide a stable line-oriented stdin protocol when it is
// launched from a redirected Node child, and a hung helper otherwise strands
// every request behind a thirty-second ACL timeout. The synchronous path below
// already uses this exact script; the async wrapper only changes how we wait.
//
// Keeping it a single process is the point: `main` memoized the current SID
// and then ran `icacls` per file, and icacls is what this module exists to
// replace. `icacls /inheritance:r` left every explicit foreign ACE in place,
// `/grant:r:` could throw "system error 1332" over a non-canonical DACL, and
// its NTAccount translation throws IdentityNotMappedException for an orphaned
// SID or an unreachable DC. So the per-write cost is one cold-start of
// powershell.exe where main paid one icacls.exe — noticeably slower per write,
// but it is the price of a hardening path that cannot silently skip repairing
// the exact drift it is meant to repair.
//
// Internal callers that harden several paths at once go through
// protectPrivateFilesWin32 so that cost is paid once for the batch.
function powershellPrivateScript() {
  return [
    // A hardening failure must surface as a non-zero exit that Node can turn
    // into a thrown error. Without this PowerShell only rolls an unhandled
    // method-invocation exception into a statement that its caller may exit 0
    // on, which would let a credential write report success while the DACL
    // was never applied.
    "$ErrorActionPreference = 'Stop'",
    "try {",
    "  $paths = @(ConvertFrom-Json -InputObject $env:CODEX_ROUTER_PRIVATE_FILES)",
    // Build each ACL from a fresh, empty FileSecurity rather than asking
    // GetAccessControl about the file's existing (possibly non-canonical)
    // DACL. SetAccessRuleProtection on a bare object never canonicalizes a
    // broken inherited/permission mix, so a file whose DACL is already
    // corrupt — the exact drift an install or doctor --fix must be able to
    // repair — cannot make this throw. The pre-existing DACL is replaced
    // outright instead of being edited toward compliance.
    // Only the DACL is persisted, not owner or group: persisting those
    // sections demands WRITE_OWNER, which Windows grants to nobody but the
    // owner raised it to even for the current identity. `icacls /inheritance:r`
    // needed only WRITE_DAC, so in exactly the non-canonical-DACL scenario
    // this repair exists for, a SetOwner/SetGroup would throw
    // UnauthorizedAccessException where the DACL fix would have succeeded.
    "  $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User",
    "  $fullControl = [System.Security.AccessControl.FileSystemRights]::FullControl",
    "  $none = [System.Security.AccessControl.InheritanceFlags]::None",
    "  $propagationNone = [System.Security.AccessControl.PropagationFlags]::None",
    "  $allow = [System.Security.AccessControl.AccessControlType]::Allow",
    "  foreach ($p in $paths) {",
    "    $acl = [System.Security.AccessControl.FileSecurity]::new()",
    "    [void]$acl.SetAccessRuleProtection($true, $false)",
    "    $rule = [System.Security.AccessControl.FileSystemAccessRule]::new($sid, $fullControl, $none, $propagationNone, $allow)",
    "    [void]$acl.AddAccessRule($rule)",
    "    [System.IO.File]::SetAccessControl($p, $acl)",
    "  }",
    "} catch {",
    "  [Console]::Error.WriteLine($_.Exception.Message)",
    "  exit 1",
    "}",
  ].join("\n");
}

function windowsPowerShellEnvironment(paths) {
  // The helper only needs the Windows runtime and the private-file list. Do
  // not copy provider API keys or other caller secrets into PowerShell's
  // environment while applying an ACL.
  const allowed = new Set(
    [
      "SystemRoot",
      "WINDIR",
      "ComSpec",
      "PATH",
      "PATHEXT",
      "TEMP",
      "TMP",
      "PSModulePath",
      "SystemDrive",
      "ProgramData",
      "ProgramFiles",
      "ProgramFiles(x86)",
      "ProgramW6432",
      "USERPROFILE",
    ]
      .map((name) => name.toLowerCase()),
  );
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([name, value]) => allowed.has(name.toLowerCase()) && typeof value === "string",
    ),
  );
  env.CODEX_ROUTER_PRIVATE_FILES = JSON.stringify(paths);
  return env;
}

function powershellPrivateArgs() {
  // PowerShell's `-Command` argument is parsed again by the Windows process
  // launcher.  That is observable with a spawned child (and especially when
  // the command contains a block and newlines), so send the UTF-16LE script
  // through the encoding PowerShell documents for application callers.
  const encoded = Buffer.from(powershellPrivateScript(), "utf16le").toString("base64");
  return ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", encoded];
}

function powershellPrivateCommandArgs() {
  // `execFileSync` already hands Node's argument vector directly to
  // CreateProcess.  Keep the synchronous setup/control path on the proven
  // `-Command` form; PowerShell's encoded-command decoder is much slower on
  // the hosted Windows image and turns every private write into a timeout-
  // shaped delay.  The async request path still uses powershellPrivateArgs()
  // because its one-shot child is launched through spawn and must not depend
  // on nested command-line quoting.
  return ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", powershellPrivateScript()];
}

function terminateWindowsChild(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  // `ChildProcess.kill()` is not consistently tree-aware on Windows.  A
  // PowerShell process can leave a native child behind while it is inside an
  // ACL call, keeping the router process alive after our bounded operation has
  // already failed.  Kill the process tree as a fallback; the PID is supplied
  // by Node rather than user input and taskkill's output is discarded.
  child.kill();
  if (Number.isInteger(child.pid) && child.pid > 0) {
    // Do not wait synchronously for taskkill: Windows can hold it while a
    // descendant is inside the same ACL call, which would turn our bounded
    // timeout into an unbounded event-loop stall.  The original child has
    // already received kill(); taskkill is only best-effort tree cleanup.
    let treeKiller;
    try {
      treeKiller = spawn(
        "taskkill.exe",
        ["/PID", String(child.pid), "/T", "/F"],
        { stdio: "ignore", windowsHide: true },
      );
    } catch {
      return;
    }
    treeKiller.on("error", () => {});
    treeKiller.unref?.();
    const timer = setTimeout(() => treeKiller.kill(), 5_000);
    timer.unref?.();
    treeKiller.on("close", () => clearTimeout(timer));
  }
}

// Protect one or more paths in a single PowerShell process. Each file ends up
// with exactly one current-identity FullControl Allow rule and no inheritance —
// the same strictness privateFileIsProtected verifies. Owner/group are left
// untouched: persisting them costs WRITE_OWNER, which can fail where the DACL
// fix would succeed, so they are not part of the hardening assertion.
function protectPrivateFilesWin32(paths) {
  const list = [...paths];
  try {
    execFileSync(
      "powershell.exe",
      powershellPrivateCommandArgs(),
      {
        env: windowsPowerShellEnvironment(list),
        stdio: ["ignore", "ignore", "pipe"],
        timeout: 15_000,
        // Every private write reaches this helper, including the ones a
        // Control Center status refresh performs. A console child of a GUI
        // parent gets its own window unless this is set, which is how a
        // routine refresh produced a burst of visible PowerShell windows
        // (issue #565). The script is non-interactive and its stdio is
        // already redirected, so nothing is hidden from the operator.
        windowsHide: true,
      },
    );
  } catch (error) {
    // The hardening script writes its diagnosis to stderr before exiting 1. A
    // non-zero exit is swallowed by execFileSync's throw, so fold the message
    // in here instead of discarding it: a `doctor` report needs it.
    const detail = String(error?.stderr?.trim?.() || error?.message || "").trim();
    throw new Error(detail ? `Failed to protect private file ACL: ${detail}` : `Failed to protect private file ACL.`);
  }
  return list;
}

// The request-path writer is asynchronous, but it must use the same bounded
// one-shot operation as setup/control writes. A persistent PowerShell child
// cannot reliably consume redirected stdin on Windows; it can stay alive
// without applying an ACL and strand every caller until the timeout. Keep the
// credentials out of the helper environment and cap diagnostic output.
function protectPrivateFilesWin32Async(paths) {
  const list = [...paths];
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer;
    let stderr = "";
    const child = spawn(
      "powershell.exe",
      powershellPrivateArgs(),
      {
        env: windowsPowerShellEnvironment(list),
        stdio: ["ignore", "ignore", "pipe"],
        windowsHide: true,
      },
    );
    const settle = (error) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (error) reject(error);
      else resolve(list);
    };
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      stderr = `${stderr}${chunk}`.slice(-WINDOWS_PRIVATE_ASYNC_OUTPUT_LIMIT);
      if (stderr.length >= WINDOWS_PRIVATE_ASYNC_OUTPUT_LIMIT) {
        terminateWindowsChild(child);
        settle(new Error("Windows private-file protection output exceeded its bound."));
      }
    });
    child.on("error", (cause) => {
      settle(new Error("Windows private-file protection could not start.", { cause }));
    });
    child.on("close", (code, signal) => {
      if (code === 0) {
        settle();
        return;
      }
      const detail = stderr.trim();
      settle(new Error(
        detail
          ? `Failed to protect private file ACL: ${detail}`
          : `Failed to protect private file ACL (${signal || code || "unknown"}).`,
      ));
    });
    timer = setTimeout(() => {
      terminateWindowsChild(child);
      settle(new Error("Timed out protecting a private file ACL."));
    }, WINDOWS_PRIVATE_ASYNC_TIMEOUT_MS);
  });
}

export function protectPrivateFile(target) {
  chmodSync(target, 0o600);
  if (process.platform === "win32") protectPrivateFilesWin32([target]);
  return target;
}

// All private JSON state uses the same temp-file, owner-only, atomic replace.
// Keeping it here prevents one state writer from drifting away from the rest.
export function writePrivateFile(target, contents, { directoryMode } = {}) {
  const directory = path.dirname(target);
  const createdDirectory = mkdirSync(directory, { recursive: true, mode: 0o700 });
  // A caller may inject a credential path for an isolated test, but it never
  // owns an already-existing parent such as /tmp or a project checkout. Only
  // apply the requested directory mode to a directory this write created.
  if (createdDirectory !== undefined && directoryMode !== undefined) {
    chmodSync(directory, directoryMode);
  }
  const temporary = `${target}.tmp.${process.pid}.${randomBytes(8).toString("hex")}`;
  try {
    writeFileSync(temporary, contents, { encoding: "utf8", mode: 0o600, flag: "wx" });
    if (process.platform === "win32") {
      // One spawn hardens the temporary; the renameSync below then moves this
      // exact file over the target, and MoveFile carries the source's DACL
      // with it, so the destination inherits the same owner-only ACL without a
      // second PowerShell cold start. A pre-existing target that is being
      // replaced is discarded with the move, so it cannot leak permissions.
      protectPrivateFilesWin32([temporary]);
      renameSync(temporary, target);
    } else {
      protectPrivateFile(temporary);
      renameSync(temporary, target);
      protectPrivateFile(target);
    }
  } catch (error) {
    try {
      const metadata = lstatSync(temporary);
      if (metadata.isFile() && !metadata.isSymbolicLink()) unlinkSync(temporary);
    } catch {
      // The exclusive temporary was never created or was already moved.
    }
    throw error;
  }
  return target;
}

// The API-key router updates bounded health/session metadata on every attempt.
// This async form retains the exact same temporary-file/DACL/rename boundary
// without blocking the event loop; each operation is independently bounded and
// cannot strand later requests behind a persistent helper.
export async function writePrivateFileAsync(target, contents, { directoryMode } = {}) {
  if (process.platform !== "win32") return writePrivateFile(target, contents, { directoryMode });
  const directory = path.dirname(target);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (directoryMode !== undefined) chmodSync(directory, directoryMode);
  const temporary = `${target}.tmp.${process.pid}.${randomBytes(8).toString("hex")}`;
  try {
    writeFileSync(temporary, contents, { encoding: "utf8", mode: 0o600 });
    await protectPrivateFilesWin32Async([temporary]);
    renameSync(temporary, target);
  } catch (error) {
    if (existsSync(temporary)) unlinkSync(temporary);
    throw error;
  }
  return target;
}

export function writePrivateJson(target, value, { space = 2, directoryMode } = {}) {
  writePrivateFile(target, `${JSON.stringify(value, null, space)}\n`, { directoryMode });
  return value;
}

export async function writePrivateJsonAsync(target, value, { space = 2, directoryMode } = {}) {
  await writePrivateFileAsync(target, `${JSON.stringify(value, null, space)}\n`, { directoryMode });
  return value;
}

export function privateFileIsProtected(target) {
  if (!existsSync(target)) return false;
  if (process.platform !== "win32") return (statSync(target).mode & 0o777) === 0o600;
  const script = [
    // Get-Acl lazy-loads Microsoft.PowerShell.Security, which can fail under
    // concurrent Windows processes. The .NET API returns the same FileSecurity
    // object without importing a PowerShell module.
    "$acl = [System.IO.File]::GetAccessControl($env:CODEX_ROUTER_PRIVATE_FILE)",
    "$sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value",
    "$rules = @($acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]))",
    "$fullControl = [System.Security.AccessControl.FileSystemRights]::FullControl",
    "$hasFullControl = $false",
    "$hasForeignAllow = $false",
    "$hasInheritedRule = $false",
    "foreach ($rule in $rules) { if ($rule.IsInherited) { $hasInheritedRule = $true }; if ($rule.AccessControlType -eq [System.Security.AccessControl.AccessControlType]::Allow) { if ($rule.IdentityReference.Value -eq $sid) { if (($rule.FileSystemRights -band $fullControl) -eq $fullControl) { $hasFullControl = $true } } else { $hasForeignAllow = $true } } }",
    "[Console]::Out.Write(($acl.AreAccessRulesProtected -and -not $hasInheritedRule -and $hasFullControl -and -not $hasForeignAllow).ToString())",
  ].join("; ");
  try {
    return execFileSync(
      "powershell.exe",
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
      {
        encoding: "utf8",
        env: { ...process.env, CODEX_ROUTER_PRIVATE_FILE: target },
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 15_000,
        // Verification runs from the same GUI-parented paths as the write
        // above; see issue #565.
        windowsHide: true,
      },
    ).trim().toLowerCase() === "true";
  } catch {
    return false;
  }
}
