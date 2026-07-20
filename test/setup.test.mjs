import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("automatic selection-only setup exposes only configured providers", () => {
  const testRoot = mkdtempSync(path.join(os.tmpdir(), "codex-router-setup-"));
  const codexHome = path.join(testRoot, "codex");
  const stateDir = path.join(testRoot, "state");
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  writeFileSync(path.join(stateDir, "deepseek-api-key.secret"), "TEST_SETUP_KEY\n", {
    mode: 0o600,
  });

  try {
    const output = execFileSync(
      process.execPath,
      ["src/setup.mjs", "--providers", "configured", "--selection-only"],
      {
        cwd: root,
        encoding: "utf8",
        env: {
          ...process.env,
          CODEX_HOME: codexHome,
          CODEX_ROUTER_STATE_DIR: stateDir,
          KIMI_CODE_HOME: path.join(testRoot, "kimi-code"),
          CODEX_ROUTER_LAUNCH_AGENTS_DIR: path.join(testRoot, "LaunchAgents"),
          CODEX_ROUTER_SKIP_LAUNCHCTL: "1",
          DEEPSEEK_API_KEY: "",
          KIMI_API_KEY: "",
          MOONSHOT_API_KEY: "",
        },
      },
    );
    assert.deepEqual(JSON.parse(output).providers, ["deepseek"]);
    const selection = JSON.parse(readFileSync(path.join(stateDir, "enabled-providers.json"), "utf8"));
    assert.deepEqual(selection.providers, ["deepseek"]);
  } finally {
    rmSync(testRoot, { recursive: true, force: true });
  }
});

test("Claude selection-only setup uses isolated state and does not touch Codex", () => {
  const testRoot = mkdtempSync(path.join(os.tmpdir(), "claude-router-setup-"));
  const codexHome = path.join(testRoot, "codex");
  const stateDir = path.join(testRoot, "claude-state");
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  mkdirSync(codexHome, { recursive: true, mode: 0o700 });
  const codexConfig = path.join(codexHome, "config.toml");
  writeFileSync(codexConfig, 'model = "gpt-native"\n', { mode: 0o600 });
  writeFileSync(path.join(stateDir, "deepseek-api-key.secret"), "TEST_SETUP_KEY\n", {
    mode: 0o600,
  });

  try {
    const output = execFileSync(
      process.execPath,
      ["src/claude-setup.mjs", "--providers", "configured", "--selection-only"],
      {
        cwd: root,
        encoding: "utf8",
        env: {
          ...process.env,
          MODEL_ROUTER_TARGET: "claude",
          MODEL_ROUTER_STATE_DIR: stateDir,
          CODEX_HOME: codexHome,
          KIMI_CODE_HOME: path.join(testRoot, "kimi-code"),
          DEEPSEEK_API_KEY: "",
          KIMI_API_KEY: "",
          MOONSHOT_API_KEY: "",
        },
      },
    );
    assert.equal(JSON.parse(output).target, "claude");
    assert.deepEqual(JSON.parse(output).providers, ["deepseek"]);
    assert.equal(readFileSync(codexConfig, "utf8"), 'model = "gpt-native"\n');
  } finally {
    rmSync(testRoot, { recursive: true, force: true });
  }
});
