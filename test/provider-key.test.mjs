import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

// provider-key.mjs is a CLI entry that validates process.argv at module
// evaluation time (and exits when the arguments are missing), so give it a
// valid invocation before importing it.
const savedArgv = [...process.argv];
process.argv = [process.argv[0], "provider-key.mjs", "opencode-go", "status"];
const { WINDOWS_HIDDEN_PROMPT_SCRIPT } = await import("../src/provider-key.mjs");
process.argv = savedArgv;

test("the Windows hidden-prompt script is structurally valid PowerShell", () => {
  // Joining the script pieces with "; " must not split `try { }` from
  // `finally { }`: PowerShell rejects "}; finally" with
  // MissingCatchOrFinally, which made every hidden key prompt fail on
  // Windows before the prompt was even shown.
  assert.doesNotMatch(WINDOWS_HIDDEN_PROMPT_SCRIPT, /}\s*;\s*finally/i);
  assert.match(WINDOWS_HIDDEN_PROMPT_SCRIPT, /}\s*finally\s*{/i);
  assert.match(WINDOWS_HIDDEN_PROMPT_SCRIPT, /-AsSecureString/);

  const opens = (WINDOWS_HIDDEN_PROMPT_SCRIPT.match(/\{/g) || []).length;
  const closes = (WINDOWS_HIDDEN_PROMPT_SCRIPT.match(/\}/g) || []).length;
  assert.equal(opens, closes);
});

test(
  "the Windows hidden-prompt script parses under powershell.exe",
  { skip: process.platform !== "win32" },
  () => {
    const testRoot = mkdtempSync(path.join(os.tmpdir(), "codex-router-prompt-"));
    const scriptPath = path.join(testRoot, "hidden-prompt.ps1");
    try {
      writeFileSync(scriptPath, WINDOWS_HIDDEN_PROMPT_SCRIPT, "utf8");
      const escaped = scriptPath.replaceAll("'", "''");
      const check = [
        "$tokens = $null; $errors = $null",
        `[System.Management.Automation.Language.Parser]::ParseFile('${escaped}', [ref]$tokens, [ref]$errors) | Out-Null`,
        "if ($errors.Count) { $errors | ForEach-Object { $_.Message }; exit 1 }",
      ].join("; ");
      execFileSync("powershell.exe", ["-NoLogo", "-NoProfile", "-Command", check], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "inherit"],
      });
    } finally {
      rmSync(testRoot, { recursive: true, force: true });
    }
  },
);
