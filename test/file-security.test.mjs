import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  closeWindowsPrivateFileWorker,
  privateFileIsProtected,
  protectPrivateFile,
  writePrivateJson,
  writePrivateJsonAsync,
  writePrivateFile,
  windowsPrivateWorkerInvocation,
  windowsPrivateFileWorkerSpawnCount,
} from "../src/file-security.mjs";

test("Windows ACL worker reserves stdin for its bounded request protocol", () => {
  const invocation = windowsPrivateWorkerInvocation();
  assert.equal(invocation.executable, "powershell.exe");
  assert.ok(invocation.args.includes("-EncodedCommand"));
  assert.equal(invocation.args.includes("-Command"), false);
});

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
        "$everyone = [Security.Principal.SecurityIdentifier]::new('S-1-1-0')",
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

test(
  "Windows protectPrivateFile rebuilds a canonical owner-only ACL over a broad foreign+inherited DACL",
  { skip: process.platform !== "win32" },
  () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "codex-router-acl-dirty-"));
    const target = path.join(directory, "private.secret");
    writeFileSync(target, "TEST_ONLY\n");
    // Make the file a genuinely messy DACL before hardening: keep its inherited
    // ACEs (don't clear them), re-enable inheritance (unprotect), and add an
    // explicit Everyone Read Allow. That leaves an "unprotected, foreign +
    // inherited, mixed" DACL, the exact drift the canonical builder exists to
    // repair and the shape the old GetAccessControl + SetAccessRuleProtection
    // + RemoveAccessRuleSpecific path could not safely recanonicalize.
    const setDirtyAcl = [
      "$acl = [System.IO.File]::GetAccessControl($env:CODEX_ROUTER_PRIVATE_FILE)",
      "[void]$acl.SetAccessRuleProtection($false, $true)",
      "$everyone = [Security.Principal.SecurityIdentifier]::new('S-1-1-0')",
      "$read = [System.Security.AccessControl.FileSystemRights]::Read",
      "$none = [System.Security.AccessControl.InheritanceFlags]::None",
      "$propagationNone = [System.Security.AccessControl.PropagationFlags]::None",
      "$allow = [System.Security.AccessControl.AccessControlType]::Allow",
      "$rule = [System.Security.AccessControl.FileSystemAccessRule]::new($everyone, $read, $none, $propagationNone, $allow)",
      "[void]$acl.AddAccessRule($rule)",
      "[System.IO.File]::SetAccessControl($env:CODEX_ROUTER_PRIVATE_FILE, $acl)",
    ].join("; ");
    execFileSync(
      "powershell.exe",
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", setDirtyAcl],
      { env: { ...process.env, CODEX_ROUTER_PRIVATE_FILE: target }, stdio: "ignore" },
    );
    try {
      // Confirm the file started in the messy shape, so the repro is real.
      const before = execFileSync(
        "powershell.exe",
        [
          "-NoLogo",
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          [
            "$acl = [System.IO.File]::GetAccessControl($env:CODEX_ROUTER_PRIVATE_FILE)",
            "$rawRules = @($acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]))",
            "$hasForeignAllow = $false",
            "$everyone = [Security.Principal.SecurityIdentifier]::new('S-1-1-0')",
            "foreach ($rule in $rawRules) { if ($rule.AccessControlType -eq [System.Security.AccessControl.AccessControlType]::Allow) { if ($rule.IdentityReference.Value -ne $acl.GetOwner([System.Security.Principal.SecurityIdentifier])) { $hasForeignAllow = $true } } }",
            "[Console]::Out.Write((($acl.AreAccessRulesProtected -eq $false) -and $hasForeignAllow).ToString())",
          ].join("; "),
        ],
        {
          encoding: "utf8",
          env: { ...process.env, CODEX_ROUTER_PRIVATE_FILE: target },
        },
      ).trim().toLowerCase();
      assert.equal(before, "true");

      // The repair must not depend on the pre-existing (unprotected,
      // foreign, non-canonical) DACL: it substitutes a fresh canonical one.
      protectPrivateFile(target);
      const snapshotScript = [
        "$acl = [System.IO.File]::GetAccessControl($env:CODEX_ROUTER_PRIVATE_FILE)",
        "$identity = [Security.Principal.WindowsIdentity]::GetCurrent()",
        "$rawRules = @($acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]))",
        "$rules = @($rawRules | ForEach-Object { [pscustomobject]@{ identity = $_.IdentityReference.Value; type = $_.AccessControlType.ToString(); rights = $_.FileSystemRights.ToString(); inherited = $_.IsInherited } })",
        "[pscustomobject]@{ protected = $acl.AreAccessRulesProtected; currentSid = $identity.User.Value; rules = $rules } | ConvertTo-Json -Compress -Depth 4",
      ].join("; ");
      const snapshot = JSON.parse(
        execFileSync(
          "powershell.exe",
          ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", snapshotScript],
          { encoding: "utf8", env: { ...process.env, CODEX_ROUTER_PRIVATE_FILE: target } },
        ).trim(),
      );
      assert.equal(privateFileIsProtected(target), true, JSON.stringify(snapshot));
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

// writePrivateFile's whole Windows path rests on the rename carrying the
// temporary file's ACL onto the target. If a future move ever crosses a volume
// (or the temp stops being a same-directory sibling), the destination would
// inherit the destination folder's DACL and hardening would silently vanish.
// This guards that the production writer leaves exactly one hardened file at
// the destination, not just that protectPrivateFile works standalone.
test(
  "Windows writePrivateFile leaves the atomic-rename target protected",
  { skip: process.platform !== "win32" },
  () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "codex-router-write-protected-"));
    const target = path.join(directory, "state.json");
    try {
      writePrivateFile(target, "secret\n");
      assert.equal(privateFileIsProtected(target), true);

      const snapshot = JSON.parse(
        execFileSync(
          "powershell.exe",
          [
            "-NoLogo",
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            [
              "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8",
              "$acl = [System.IO.File]::GetAccessControl($env:CODEX_ROUTER_PRIVATE_FILE)",
              "$identity = [Security.Principal.WindowsIdentity]::GetCurrent()",
              "$rawRules = @($acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]))",
              "$rules = @($rawRules | ForEach-Object { [pscustomobject]@{ identity = $_.IdentityReference.Value; type = $_.AccessControlType.ToString(); rights = $_.FileSystemRights.ToString(); inherited = $_.IsInherited } })",
              "[pscustomobject]@{ protected = $acl.AreAccessRulesProtected; currentSid = $identity.User.Value; rules = $rules } | ConvertTo-Json -Compress -Depth 4",
            ].join("; "),
          ],
          { encoding: "utf8", env: { ...process.env, CODEX_ROUTER_PRIVATE_FILE: target } },
        ).trim(),
      );
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

test(
  "Windows request-path private writes reuse one ACL worker and preserve the atomic target ACL",
  { skip: process.platform !== "win32" },
  async () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "codex-router-write-worker-"));
    const target = path.join(directory, "pool.json");
    const before = windowsPrivateFileWorkerSpawnCount();
    try {
      await writePrivateJsonAsync(target, { version: 1, value: "first" });
      await writePrivateJsonAsync(target, { version: 1, value: "second" });
      assert.equal(windowsPrivateFileWorkerSpawnCount() - before, 1);
      assert.deepEqual(JSON.parse(readFileSync(target, "utf8")), { version: 1, value: "second" });
      assert.equal(privateFileIsProtected(target), true);
    } finally {
      closeWindowsPrivateFileWorker();
      rmSync(directory, { recursive: true, force: true });
    }
  },
);
