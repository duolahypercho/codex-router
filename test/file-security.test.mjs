import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  ensureCheckoutReadable,
  privateFileIsProtected,
  protectPrivateFile,
  writePrivateJson,
  writePrivateJsonAsync,
  writePrivateFile,
} from "../src/file-security.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("the Windows async ACL path uses the bounded one-shot script", () => {
  const implementation = readFileSync(path.join(root, "src", "file-security.mjs"), "utf8");
  assert.match(
    implementation,
    /protectPrivateFilesWin32Async\(paths\)/,
  );
  assert.match(implementation, /powershellPrivateArgs\(\)/);
  assert.match(implementation, /"-EncodedCommand"/);
  assert.match(implementation, /taskkill\.exe/);
  assert.match(implementation, /treeKiller\.unref/);
  assert.doesNotMatch(implementation, /execFileSync\(\s*\n?\s*"taskkill\.exe"/);
  assert.match(implementation, /WINDOWS_PRIVATE_ASYNC_TIMEOUT_MS/);
  assert.doesNotMatch(implementation, /powershellPrivateWorkerScript/);
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

test("private writes never chmod an existing caller-owned parent directory", {
  skip: process.platform === "win32" ? "POSIX mode assertion" : false,
}, () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "codex-router-existing-parent-"));
  const target = path.join(directory, "state.json");
  try {
    chmodSync(directory, 0o755);
    writePrivateJson(target, { ok: true }, { directoryMode: 0o700 });
    assert.equal(statSync(directory).mode & 0o777, 0o755);
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
  "Windows request-path private writes use bounded ACL operations and preserve the atomic target ACL",
  { skip: process.platform !== "win32" },
  async () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "codex-router-write-async-"));
    const target = path.join(directory, "pool.json");
    try {
      await writePrivateJsonAsync(target, { version: 1, value: "first" });
      await writePrivateJsonAsync(target, { version: 1, value: "second" });
      assert.deepEqual(JSON.parse(readFileSync(target, "utf8")), { version: 1, value: "second" });
      assert.equal(privateFileIsProtected(target), true);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  },
);

test(
  "ensureCheckoutReadable grants Users read access to the checkout directory on Windows",
  { skip: process.platform !== "win32" },
  () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "codex-router-checkout-"));
    const file = path.join(directory, "src", "start.mjs");
    try {
      mkdirSync(path.join(directory, "src"), { recursive: true });
      writeFileSync(file, "// test file\n");
      // Call ensureCheckoutReadable to grant Users read access
      ensureCheckoutReadable(directory);
      // Verify that Users (S-1-5-32-545) has ReadAndExecute access
      const script = [
        "$acl = [System.IO.Directory]::GetAccessControl($env:CODEX_ROUTER_CHECKOUT)",
        "$usersId = [Security.Principal.SecurityIdentifier]::new('S-1-5-32-545')",
        "$rules = @($acl.GetAccessRules($true, $false, [Security.Principal.SecurityIdentifier]))",
        "$usersRule = $rules | Where-Object { $_.IdentityReference.Value -eq $usersId.Value -and $_.AccessControlType -eq 'Allow' } | Select-Object -First 1",
        "if ($null -ne $usersRule) {",
        "  $readExecute = [System.Security.AccessControl.FileSystemRights]::ReadAndExecute",
        "  $hasReadExecute = ($usersRule.FileSystemRights -band $readExecute) -eq $readExecute",
        "  [Console]::Out.Write($hasReadExecute.ToString())",
        "} else {",
        "  [Console]::Out.Write('False')",
        "}",
      ].join("\n");
      const result = execFileSync(
        "powershell.exe",
        ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
        {
          encoding: "utf8",
          env: { ...process.env, CODEX_ROUTER_CHECKOUT: directory },
          stdio: ["ignore", "pipe", "ignore"],
        },
      ).trim().toLowerCase();
      assert.equal(result, "true", "Users should have ReadAndExecute access to the checkout");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  },
);
