import { execFileSync } from "node:child_process";
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

export function protectPrivateFile(target) {
  chmodSync(target, 0o600);
  if (process.platform !== "win32") return target;
  const script = [
    "$target = $env:CODEX_ROUTER_PRIVATE_FILE",
    "$sid = [Security.Principal.WindowsIdentity]::GetCurrent().User",
    "$acl = [System.IO.File]::GetAccessControl($target)",
    "$acl.SetAccessRuleProtection($true, $false)",
    "$rules = @($acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]))",
    "foreach ($rule in $rules) { [void]$acl.RemoveAccessRuleSpecific($rule) }",
    "$fullControl = [System.Security.AccessControl.FileSystemRights]::FullControl",
    "$none = [System.Security.AccessControl.InheritanceFlags]::None",
    "$propagationNone = [System.Security.AccessControl.PropagationFlags]::None",
    "$allow = [System.Security.AccessControl.AccessControlType]::Allow",
    "$rule = [System.Security.AccessControl.FileSystemAccessRule]::new($sid, $fullControl, $none, $propagationNone, $allow)",
    "[void]$acl.AddAccessRule($rule)",
    "[System.IO.File]::SetAccessControl($target, $acl)",
  ].join("; ");
  execFileSync(
    "powershell.exe",
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
    {
      env: { ...process.env, CODEX_ROUTER_PRIVATE_FILE: target },
      stdio: "ignore",
    },
  );
  return target;
}

// All private JSON state uses the same temp-file, owner-only, atomic replace.
// Keeping it here prevents one state writer from drifting away from the rest.
export function writePrivateFile(target, contents, { directoryMode } = {}) {
  const directory = path.dirname(target);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (directoryMode !== undefined) chmodSync(directory, directoryMode);
  const temporary = `${target}.tmp.${process.pid}`;
  try {
    writeFileSync(temporary, contents, { encoding: "utf8", mode: 0o600 });
    protectPrivateFile(temporary);
    renameSync(temporary, target);
    protectPrivateFile(target);
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
