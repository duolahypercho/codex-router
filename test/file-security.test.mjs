import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  privateFileIsProtected,
  protectPrivateFile,
  windowsFullControlGrant,
} from "../src/file-security.mjs";

test("Windows numeric SID grants use the icacls SID prefix", () => {
  assert.equal(
    windowsFullControlGrant("S-1-5-21-1742564184-1656218818-310408600-500"),
    "*S-1-5-21-1742564184-1656218818-310408600-500:(F)",
  );
  assert.throws(() => windowsFullControlGrant("runner@example.com"), /invalid Windows user SID/);
});

test(
  "Windows private-file ACL is protected for the current identity",
  { skip: process.platform !== "win32" },
  () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "codex-router-acl-"));
    const target = path.join(directory, "private.secret");
    writeFileSync(target, "TEST_ONLY\n");
    try {
      protectPrivateFile(target);
      const script = [
        "$acl = [System.IO.File]::GetAccessControl($env:CODEX_ROUTER_PRIVATE_FILE)",
        "$identity = [Security.Principal.WindowsIdentity]::GetCurrent()",
        "$rules = @($acl.Access | ForEach-Object { [pscustomobject]@{ identity = $_.IdentityReference.Value; type = $_.AccessControlType.ToString(); inherited = $_.IsInherited } })",
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
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  },
);
