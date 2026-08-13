import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function run(relative, args = []) {
  return spawnSync(process.execPath, [path.join(root, relative), ...args], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, CODEX_HOME: path.join(root, ".missing-test-codex-home") },
  });
}

test("live smoke tests refuse to spend quota without explicit --yes consent", () => {
  const result = run("src/smoke-test.mjs");
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /quota.*--yes/i);
});

test("the signed provider precedence probe requires both live intent and consent", () => {
  const refused = run("scripts/provider-precedence-probe.mjs");
  assert.equal(refused.status, 2);
  assert.match(refused.stderr, /quota.*--live --yes/i);

  const help = run("scripts/provider-precedence-probe.mjs", ["--help"]);
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /--live --yes/);
});

test("the precedence probe uses shared cross-platform Codex and venv paths", () => {
  const source = readFileSync(
    path.join(root, "scripts", "provider-precedence-probe.mjs"),
    "utf8",
  );
  assert.match(source, /findCodexBinary\(\)/);
  assert.match(source, /spawnableCommand\(CODEX_BIN, args\)/);
  assert.match(source, /process\.platform === "win32" \? "Scripts" : "bin"/);
  assert.match(source, /process\.platform === "win32" \? "litellm\.exe" : "litellm"/);
});

test("setup forwards its already-confirmed smoke choice as --yes", () => {
  const source = readFileSync(path.join(root, "src", "setup.mjs"), "utf8");
  assert.match(source, /"smoke-test\.mjs"\), "--yes"/);
});

test("installation documentation includes consent in its direct smoke command", () => {
  const source = readFileSync(path.join(root, "docs", "INSTALL.md"), "utf8");
  assert.match(source, /\.\/bin\/smoke-test --yes/);
});
