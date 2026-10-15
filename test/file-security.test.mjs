import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  ensureCheckoutReadable,
  privateFileIsProtected,
  privateFilesAreProtectedAsync,
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
    /protectPrivateFilesWin32Async\(paths, /,
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

// The record that lets the Windows service manager stop the tree it owns is
// written before anything else starts, so a PowerShell that cannot start used
// to take the whole router down: measured 2026-09-23, every start attempt for
// forty minutes after a boot died on "Failed to protect private file ACL:
// spawnSync powershell.exe ETIMEDOUT". A warn-only write must survive that; the
// default must still fail closed, because a credential file cannot silently
// lose its hardening.
test(
  "a warn-only private write survives a PowerShell that cannot run the hardening script",
  { skip: process.platform !== "win32" },
  () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "codex-router-harden-warn-"));
    const shadow = path.join(directory, "shadow");
    const target = path.join(directory, "state.json");
    const originalPath = process.env.PATH;
    try {
      mkdirSync(shadow);
      // A PowerShell that cannot start at all: an executable-named file that
      // CreateProcess rejects, which is the shape protectPrivateFilesWin32
      // turns into "Failed to protect private file ACL". PATH is searched
      // before the Windows directory for a bare image name, so this shadow wins
      // over the real interpreter.
      writeFileSync(path.join(shadow, "powershell.exe"), "not an executable\n");
      process.env.PATH = `${shadow};${originalPath}`;

      const value = { version: 1, pid: 4242 };
      assert.deepEqual(writePrivateJson(target, value, { hardenFailure: "warn" }), value);
      assert.deepEqual(JSON.parse(readFileSync(target, "utf8")), value);

      const strict = path.join(directory, "strict.json");
      assert.throws(
        () => writePrivateJson(strict, value),
        /Failed to protect private file ACL/,
      );
      assert.equal(existsSync(strict), false);
    } finally {
      process.env.PATH = originalPath;
      rmSync(directory, { recursive: true, force: true });
    }
  },
);

function verifierChild() {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.exitCode = null; child.signalCode = null;
  child.kills = 0;
  child.kill = () => { child.kills++; child.signalCode = "SIGTERM"; return true; };
  child.complete = (output, code = 0) => { child.stdout.end(output); child.exitCode = code; child.emit("close", code); };
  return child;
}

test("Windows verification batches paths asynchronously with the owner-only ACL predicate and no secrets", async () => {
  const child = verifierChild(); let calls = 0; let captured;
  const previous = process.env.CODEX_ROUTER_TEST_SECRET; process.env.CODEX_ROUTER_TEST_SECRET = "synthetic-never-forwarded";
  try {
    const pending = privateFilesAreProtectedAsync(["C:\\private\\one.json", "C:\\private\\two.json"], {
      platform: "win32", spawnImpl: (command, args, options) => { calls++; captured = { command, args, options }; return child; },
    });
    let timerRan = false;
    await new Promise((resolve) => setTimeout(() => { timerRan = true; resolve(); }, 10));
    assert.equal(timerRan, true); assert.equal(calls, 1);
    assert.equal(captured.command, "powershell.exe"); assert.equal(captured.options.windowsHide, true);
    assert.equal(captured.options.env.CODEX_ROUTER_TEST_SECRET, undefined);
    assert.deepEqual(JSON.parse(captured.options.env.CODEX_ROUTER_PRIVATE_FILES), ["C:\\private\\one.json", "C:\\private\\two.json"]);
    const script = Buffer.from(captured.args.at(-1), "base64").toString("utf16le");
    for (const predicate of ["AreAccessRulesProtected", "IsInherited", "hasFullControl", "hasForeignAllow", "GetCurrent"]) assert.ok(script.includes(predicate));
    assert.doesNotMatch(script, /synthetic-never-forwarded|Get-Content/);
    child.complete("[true,false]"); assert.deepEqual(await pending, [true, false]);
  } finally {
    if (previous === undefined) delete process.env.CODEX_ROUTER_TEST_SECRET; else process.env.CODEX_ROUTER_TEST_SECRET = previous;
  }
});

for (const [output, code] of [["true", 0], ["[true,true]", 0], ['["true"]', 0], ["[true]", 1], ["malformed", 0]]) {
  test(`Windows verification rejects malformed or failed helper output ${JSON.stringify(output)}/${code}`, async () => {
    const child = verifierChild();
    const pending = privateFilesAreProtectedAsync(["synthetic.json"], { platform: "win32", spawnImpl: () => child });
    child.complete(output, code); await assert.rejects(pending, /verification failed/);
  });
}

test("Windows verification bounds output, timeout and cancellation and kills its helper", async () => {
  for (const failure of ["output", "timeout", "abort"]) {
    const child = verifierChild(); const controller = new AbortController(); const reason = new Error("synthetic cancel");
    const pending = privateFilesAreProtectedAsync(["synthetic.json"], { platform: "win32", spawnImpl: () => child, signal: controller.signal, timeoutMs: failure === "timeout" ? 10 : 15000 });
    const rejected = assert.rejects(pending, (error) => failure === "abort" ? error === reason : /exceeded|timed out/.test(error.message));
    if (failure === "output") child.stdout.write("x".repeat(65537));
    if (failure === "abort") controller.abort(reason);
    await rejected; assert.equal(child.kills, 1);
    child.emit("close", 0);
  }
  const child = verifierChild();
  const failed = privateFilesAreProtectedAsync(["synthetic.json"], { platform: "win32", spawnImpl: () => child });
  child.emit("error", new Error("synthetic helper cannot start"));
  await assert.rejects(failed, /could not start/);
  await assert.rejects(privateFilesAreProtectedAsync(["synthetic.json"], { platform: "win32", spawnImpl: () => { throw new Error("synthetic spawn failure"); } }), /spawn failure/);
});

test("Windows batch ACL verification accepts private files and refuses a public one", { skip: process.platform !== "win32" }, async (t) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "codex-router-batch-acl-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const first = path.join(directory, "first.json"); const second = path.join(directory, "second.json");
  writePrivateJson(first, { synthetic: true }); writePrivateJson(second, { synthetic: true });
  assert.deepEqual(await privateFilesAreProtectedAsync([first, second]), [true, true]);
  execFileSync("icacls.exe", [second, "/grant", "*S-1-1-0:(R)"], { stdio: "ignore", windowsHide: true });
  assert.deepEqual(await privateFilesAreProtectedAsync([first, second]), [true, false]);
});

test("canceled private writes preserve the target and remove temporary files", async (t) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "private-write-cancel-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const target = path.join(directory, "state.json");
  writeFileSync(target, '{"original":true}');
  const controller = new AbortController(); const reason = new Error("synthetic request deadline");
  controller.abort(reason);
  await assert.rejects(writePrivateJsonAsync(target, { changed: true }, { signal: controller.signal }), (error) => error === reason);
  assert.equal(readFileSync(target, "utf8"), '{"original":true}');
});

test("Windows private writes cancel the ACL helper without publishing or retaining a temporary", async (t) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "private-win-write-cancel-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const target = path.join(directory, "state.json");
  writeFileSync(target, '{"original":true}');
  const child = verifierChild(); child.stderr = new PassThrough();
  const controller = new AbortController(); const reason = new Error("synthetic disconnected request");
  let temporary;
  const pending = writePrivateJsonAsync(target, { changed: true }, {
    platform: "win32", signal: controller.signal,
    spawnImpl: (_command, _args, options) => { [temporary] = JSON.parse(options.env.CODEX_ROUTER_PRIVATE_FILES); return child; },
  });
  const rejected = assert.rejects(pending, (error) => error === reason);
  controller.abort(reason); await rejected;
  assert.equal(child.kills, 1); assert.equal(existsSync(temporary), false);
  assert.equal(readFileSync(target, "utf8"), '{"original":true}');
  child.emit("close", 0);
});

for (const failure of ["timeout", "output", "start", "exit", "late-abort"]) {
  test(`Windows private write ${failure} preserves the atomic target and removes the temporary`, async (t) => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "private-win-write-failure-"));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const target = path.join(directory, "state.json"); writeFileSync(target, "original");
    const child = verifierChild(); child.stderr = new PassThrough();
    const controller = new AbortController(); const reason = new Error("synthetic late abort"); let temporary;
    const pending = writePrivateJsonAsync(target, { changed: true }, {
      platform: "win32", signal: controller.signal, timeoutMs: failure === "timeout" ? 10 : 30000,
      spawnImpl: (_command, _args, options) => { [temporary] = JSON.parse(options.env.CODEX_ROUTER_PRIVATE_FILES); return child; },
    });
    const rejected = assert.rejects(pending, (error) => failure === "late-abort" ? error === reason : /Timed out|exceeded|could not start|Failed to protect/.test(error.message));
    if (failure === "output") child.stderr.write("x".repeat(65536));
    if (failure === "start") child.emit("error", new Error("synthetic start failure"));
    if (failure === "exit") { child.exitCode = 1; child.emit("close", 1); }
    if (failure === "late-abort") { child.exitCode = 0; child.emit("close", 0); controller.abort(reason); }
    await rejected;
    assert.equal(readFileSync(target, "utf8"), "original"); assert.equal(existsSync(temporary), false);
    assert.equal(controller.signal.onabort, null);
    child.emit("close", 0);
  });
}

test("Windows private write publishes only after ACL success and ignores later cancellation", async (t) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "private-win-write-success-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const target = path.join(directory, "state.json"); writeFileSync(target, "original");
  const child = verifierChild(); child.stderr = new PassThrough(); const controller = new AbortController();
  const pending = writePrivateJsonAsync(target, { changed: true }, { platform: "win32", signal: controller.signal, spawnImpl: () => child });
  assert.equal(readFileSync(target, "utf8"), "original");
  child.exitCode = 0; child.emit("close", 0); await pending;
  controller.abort(new Error("synthetic later disconnect")); assert.equal(child.kills, 0);
  assert.deepEqual(JSON.parse(readFileSync(target, "utf8")), { changed: true });
});
