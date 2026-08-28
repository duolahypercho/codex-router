import { execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

const WINDOWS_PRIVATE_WORKER_TIMEOUT_MS = 30_000;
// The Node test runner executes files in parallel child processes. Keeping one
// PowerShell helper alive for a minute in every child exhausts the small
// Windows CI runner and leaves newly spawned helpers unscheduled until their
// request timeout. Retire test helpers as soon as the immediate write burst is
// over; production keeps the full interval so selection and outcome writes on
// either side of an upstream request still reuse one process.
const WINDOWS_PRIVATE_WORKER_IDLE_MS = process.env.NODE_TEST_CONTEXT ? 250 : 60_000;
const WINDOWS_PRIVATE_WORKER_OUTPUT_LIMIT = 64 * 1024;

let windowsPrivateWorker;
let windowsPrivateWorkerSequence = 0;
let windowsPrivateWorkerSpawns = 0;

// Synchronous Windows private-file hardening is one PowerShell spawn per call.
// The request-path async writer below reuses a single narrow ACL worker so pool
// bookkeeping does not cold-start PowerShell twice per routed request.
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

// Request/response lines are base64-encoded JSON. File names may contain
// newlines and PowerShell metacharacters, so neither belongs in command text
// or in a line-delimited protocol without an encoding boundary.
function powershellPrivateWorkerScript() {
  return [
    "$ErrorActionPreference = 'Stop'",
    "$sid = [Security.Principal.WindowsIdentity]::GetCurrent().User",
    "$fullControl = [System.Security.AccessControl.FileSystemRights]::FullControl",
    "$none = [System.Security.AccessControl.InheritanceFlags]::None",
    "$propagationNone = [System.Security.AccessControl.PropagationFlags]::None",
    "$allow = [System.Security.AccessControl.AccessControlType]::Allow",
    "while (($line = [Console]::In.ReadLine()) -ne $null) {",
    "  $id = $null",
    "  try {",
    "    $json = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($line))",
    "    $request = ConvertFrom-Json -InputObject $json",
    "    $id = [string]$request.id",
    "    foreach ($p in @($request.paths)) {",
    "      $acl = [System.Security.AccessControl.FileSecurity]::new()",
    "      [void]$acl.SetAccessRuleProtection($true, $false)",
    "      $rule = [System.Security.AccessControl.FileSystemAccessRule]::new($sid, $fullControl, $none, $propagationNone, $allow)",
    "      [void]$acl.AddAccessRule($rule)",
    "      [System.IO.File]::SetAccessControl([string]$p, $acl)",
    "    }",
    "    $response = @{ id = $id; ok = $true } | ConvertTo-Json -Compress",
    "  } catch {",
    "    $response = @{ id = $id; ok = $false; error = $_.Exception.Message } | ConvertTo-Json -Compress",
    "  }",
    "  $encoded = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($response))",
    "  [Console]::Out.WriteLine($encoded)",
    "  [Console]::Out.Flush()",
    "}",
  ].join("\n");
}

export function windowsPrivateWorkerInvocation() {
  // Windows PowerShell's `-Command` mode owns stdin while parsing the command,
  // so it cannot also provide a reliable persistent line protocol. Encoding
  // the bounded script as an argument leaves stdin exclusively to requests.
  const encoded = Buffer.from(powershellPrivateWorkerScript(), "utf16le").toString("base64");
  return {
    executable: "powershell.exe",
    args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", encoded],
  };
}

function windowsWorkerEnvironment() {
  // Do not copy provider API keys into a helper that only needs Windows and a
  // temporary directory. PowerShell itself may need any of these canonical
  // names depending on the host configuration; everything else is omitted.
  const allowed = new Set(
    ["SystemRoot", "WINDIR", "ComSpec", "PATH", "PATHEXT", "TEMP", "TMP"]
      .map((name) => name.toLowerCase()),
  );
  return Object.fromEntries(
    Object.entries(process.env).filter(
      ([name, value]) => allowed.has(name.toLowerCase()) && typeof value === "string",
    ),
  );
}

function setWindowsWorkerReferenced(worker, referenced) {
  const method = referenced ? "ref" : "unref";
  worker.child[method]?.();
  worker.child.stdin?.[method]?.();
  worker.child.stdout?.[method]?.();
  worker.child.stderr?.[method]?.();
}

function retireWindowsPrivateWorker(worker, error) {
  if (!worker || worker.retired) return;
  worker.retired = true;
  if (windowsPrivateWorker === worker) windowsPrivateWorker = undefined;
  if (worker.idleTimer) clearTimeout(worker.idleTimer);
  for (const pending of worker.pending.values()) {
    clearTimeout(pending.timer);
    pending.reject(error);
  }
  worker.pending.clear();
  worker.child.kill();
}

function idleWindowsPrivateWorker(worker) {
  if (worker.retired || worker.pending.size) return;
  setWindowsWorkerReferenced(worker, false);
  if (worker.idleTimer) clearTimeout(worker.idleTimer);
  worker.idleTimer = setTimeout(() => {
    if (worker.pending.size || worker.retired) return;
    worker.child.stdin.end();
    retireWindowsPrivateWorker(worker, new Error("Windows private-file worker retired."));
  }, WINDOWS_PRIVATE_WORKER_IDLE_MS);
  worker.idleTimer.unref?.();
}

function completeWindowsPrivateWorkerLine(worker, line) {
  let response;
  try {
    response = JSON.parse(Buffer.from(line, "base64").toString("utf8"));
  } catch (cause) {
    retireWindowsPrivateWorker(worker, new Error("Windows private-file worker returned invalid output.", { cause }));
    return;
  }
  const id = String(response?.id || "");
  const pending = worker.pending.get(id);
  if (!pending) {
    retireWindowsPrivateWorker(worker, new Error("Windows private-file worker returned an unknown response."));
    return;
  }
  worker.pending.delete(id);
  clearTimeout(pending.timer);
  if (response.ok === true) pending.resolve();
  else {
    const detail = String(response.error || "").trim();
    pending.reject(new Error(detail ? `Failed to protect private file ACL: ${detail}` : "Failed to protect private file ACL."));
  }
  idleWindowsPrivateWorker(worker);
}

function startWindowsPrivateWorker() {
  const invocation = windowsPrivateWorkerInvocation();
  const child = spawn(
    invocation.executable,
    invocation.args,
    {
      env: windowsWorkerEnvironment(),
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    },
  );
  windowsPrivateWorkerSpawns += 1;
  const worker = {
    child,
    pending: new Map(),
    stdout: "",
    stderr: "",
    idleTimer: undefined,
    retired: false,
  };
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    worker.stdout += chunk;
    if (worker.stdout.length > WINDOWS_PRIVATE_WORKER_OUTPUT_LIMIT) {
      retireWindowsPrivateWorker(worker, new Error("Windows private-file worker output exceeded its bound."));
      return;
    }
    while (worker.stdout.includes("\n")) {
      const boundary = worker.stdout.indexOf("\n");
      const line = worker.stdout.slice(0, boundary).trim();
      worker.stdout = worker.stdout.slice(boundary + 1);
      if (line) completeWindowsPrivateWorkerLine(worker, line);
    }
  });
  child.stderr.on("data", (chunk) => {
    worker.stderr = `${worker.stderr}${chunk}`.slice(-WINDOWS_PRIVATE_WORKER_OUTPUT_LIMIT);
  });
  child.on("error", (cause) => {
    retireWindowsPrivateWorker(worker, new Error("Windows private-file worker could not start.", { cause }));
  });
  child.on("exit", (code, signal) => {
    if (worker.retired) return;
    const detail = worker.stderr.trim();
    retireWindowsPrivateWorker(
      worker,
      new Error(
        detail
          ? `Windows private-file worker exited: ${detail}`
          : `Windows private-file worker exited (${signal || code || "unknown"}).`,
      ),
    );
  });
  return worker;
}

function protectPrivateFilesWin32Async(paths) {
  const list = [...paths];
  const worker = windowsPrivateWorker && !windowsPrivateWorker.retired
    ? windowsPrivateWorker
    : (windowsPrivateWorker = startWindowsPrivateWorker());
  if (worker.idleTimer) {
    clearTimeout(worker.idleTimer);
    worker.idleTimer = undefined;
  }
  setWindowsWorkerReferenced(worker, true);
  const id = String(++windowsPrivateWorkerSequence);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      retireWindowsPrivateWorker(worker, new Error("Timed out protecting a private file ACL."));
    }, WINDOWS_PRIVATE_WORKER_TIMEOUT_MS);
    timer.unref?.();
    worker.pending.set(id, { resolve, reject, timer });
    const line = Buffer.from(JSON.stringify({ id, paths: list }), "utf8").toString("base64");
    worker.child.stdin.write(`${line}\n`, (error) => {
      if (error) retireWindowsPrivateWorker(worker, new Error("Windows private-file worker input failed.", { cause: error }));
    });
  });
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
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", powershellPrivateScript()],
      {
        env: { ...process.env, CODEX_ROUTER_PRIVATE_FILES: JSON.stringify(list) },
        stdio: ["ignore", "ignore", "pipe"],
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

export function protectPrivateFile(target) {
  chmodSync(target, 0o600);
  if (process.platform === "win32") protectPrivateFilesWin32([target]);
  return target;
}

// All private JSON state uses the same temp-file, owner-only, atomic replace.
// Keeping it here prevents one state writer from drifting away from the rest.
export function writePrivateFile(target, contents, { directoryMode } = {}) {
  const directory = path.dirname(target);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (directoryMode !== undefined) chmodSync(directory, directoryMode);
  const temporary = `${target}.tmp.${process.pid}.${randomBytes(8).toString("hex")}`;
  try {
    writeFileSync(temporary, contents, { encoding: "utf8", mode: 0o600 });
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
    if (existsSync(temporary)) unlinkSync(temporary);
    throw error;
  }
  return target;
}

// The API-key router updates bounded health/session metadata on every attempt.
// On Windows, starting PowerShell once per atomic write would put a cold process
// launch under the pool lock twice per request. This async form retains the
// exact same temporary-file/DACL/rename boundary while reusing one narrowly
// scoped ACL worker for the lifetime of the forwarder. Other state writers keep
// the synchronous API because they are setup/control paths, not request paths.
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

export function windowsPrivateFileWorkerSpawnCount() {
  return windowsPrivateWorkerSpawns;
}

export function closeWindowsPrivateFileWorker() {
  const worker = windowsPrivateWorker;
  if (!worker) return;
  worker.child.stdin.end();
  retireWindowsPrivateWorker(worker, new Error("Windows private-file worker closed."));
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
      },
    ).trim().toLowerCase() === "true";
  } catch {
    return false;
  }
}
