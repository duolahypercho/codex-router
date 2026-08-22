import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  privateFileIsProtected,
  protectPrivateFile,
  writePrivateJson,
} from "../src/file-security.mjs";

test("private JSON state uses one owner-only atomic writer", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "codex-router-private-json-"));
  const target = path.join(directory, "state.json");
  const value = { version: 1, enabled: true };
  try {
    assert.deepEqual(writePrivateJson(target, value, { directoryMode: 0o700 }), value);
    assert.deepEqual(JSON.parse(readFileSync(target, "utf8")), value);
    if (process.platform !== "win32") assert.equal(statSync(target).mode & 0o777, 0o600);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test(
  "Windows private-file ACL removes foreign grants and gives only the current identity full control",
  { skip: process.platform !== "win32" },
  () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "codex-router-acl-"));
    const target = path.join(directory, "private.secret");
    writeFileSync(target, "TEST_ONLY\n");
    try {
      protectPrivateFile(target);
      assert.equal(privateFileIsProtected(target), true);

      const grantEveryoneRead = [
        "$target = $env:CODEX_ROUTER_PRIVATE_FILE",
        "$acl = [System.IO.File]::GetAccessControl($target)",
        "$everyone = [System.Security.Principal.SecurityIdentifier]::new('S-1-1-0')",
        "$read = [System.Security.AccessControl.FileSystemRights]::Read",
        "$none = [System.Security.AccessControl.InheritanceFlags]::None",
        "$propagationNone = [System.Security.AccessControl.PropagationFlags]::None",
        "$allow = [System.Security.AccessControl.AccessControlType]::Allow",
        "$rule = [System.Security.AccessControl.FileSystemAccessRule]::new($everyone, $read, $none, $propagationNone, $allow)",
        "[void]$acl.AddAccessRule($rule)",
        "[System.IO.File]::SetAccessControl($target, $acl)",
      ].join("; ");
      execFileSync(
        "powershell.exe",
        ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", grantEveryoneRead],
        {
          env: { ...process.env, CODEX_ROUTER_PRIVATE_FILE: target },
          stdio: "ignore",
        },
      );
      assert.equal(privateFileIsProtected(target), false);

      protectPrivateFile(target);
      const script = [
        "$acl = [System.IO.File]::GetAccessControl($env:CODEX_ROUTER_PRIVATE_FILE)",
        "$identity = [Security.Principal.WindowsIdentity]::GetCurrent()",
        "$rawRules = @($acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]))",
        "$rules = @($rawRules | ForEach-Object { [pscustomobject]@{ identity = $_.IdentityReference.Value; type = $_.AccessControlType.ToString(); rights = $_.FileSystemRights.ToString(); inherited = $_.IsInherited } })",
        "[pscustomobject]@{ protected = $acl.AreAccessRulesProtected; currentSid = $identity.User.Value; currentName = $identity.Name; rules = $rules } | ConvertTo-Json -Compress -Depth 4",
      ].join("; ");
      const acl = execFileSync(
        "powershell.exe",
        ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
        {
          encoding: "utf8",
          env: { ...process.env, CODEX_ROUTER_PRIVATE_FILE: target },
        },
      ).trim();
      assert.equal(privateFileIsProtected(target), true, acl);
      const snapshot = JSON.parse(acl);
      assert.equal(snapshot.protected, true);
      assert.deepEqual(snapshot.rules, [
        {
          identity: snapshot.currentSid,
          type: "Allow",
          rights: "FullControl",
          inherited: false,
        },
      ]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  },
);
