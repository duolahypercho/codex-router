import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const script = path.join(root, "codex-router.ps1");

// The Windows entry point can only be run on Windows. Skipping is deliberate
// and states its reason: the bug below shipped precisely because every
// assertion about this script read its text instead of running it.
const skip =
  process.platform === "win32" ? false : "the PowerShell entry point runs on Windows only";

function runCli(...cliArgs) {
  return spawnSync(
    "powershell.exe",
    ["-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script, ...cliArgs],
    { encoding: "utf8", cwd: root },
  );
}

// PowerShell enumerates a statement's output into an assignment, so
// `$Arguments = if (...) { @(...) }` collapsed a one-element array to the
// element itself. $Arguments[0] then indexed a String and returned its first
// character, so every single-argument subcommand died on a one-letter action:
// tray status/start/stop/restart/uninstall were all unreachable.
test("a lone subcommand argument survives as a whole word", { skip }, () => {
  const result = runCli("tray", "frobnicate");
  const output = `${result.stdout}${result.stderr}`;
  assert.match(output, /frobnicate/, "the action was truncated before it was validated");
  assert.doesNotMatch(
    output,
    /action 'f'/,
    "a one-element argument array was unrolled into a string",
  );
});

// Deliberately invalid actions: the validator echoes what it received, which
// is the whole assertion, and nothing runs. Testing the real verbs here would
// mean stopping and unregistering the companion of whoever ran the suite.
test("an action is never truncated, whatever its length", { skip }, () => {
  for (const action of ["st", "status-typo", "uninstall-typo"]) {
    const result = runCli("companion", action);
    const output = `${result.stdout}${result.stderr}`;
    assert.ok(
      output.includes(`action '${action}'`),
      `companion ${action} reached the validator as something else`,
    );
  }
});

test("multi-argument subcommands are still passed through whole", { skip }, () => {
  const result = runCli("panel", "--help");
  assert.match(result.stdout, /--print/, "the flag did not reach panel.mjs");
});
