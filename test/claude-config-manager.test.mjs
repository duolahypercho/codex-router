import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CALLER_KEY = "test-claude-config-caller-capability-with-sufficient-length";
const existingId = "11111111-1111-4111-8111-111111111111";

function environment(testRoot) {
  return {
    ...process.env,
    MODEL_ROUTER_TARGET: "claude",
    MODEL_ROUTER_STATE_DIR: path.join(testRoot, "router-state"),
    CLAUDE_ROUTER_CONFIG_LIBRARY: path.join(testRoot, "Claude-3p", "configLibrary"),
    MODEL_ROUTER_PORT: "49110",
    XDG_CONFIG_HOME: path.join(testRoot, "xdg"),
    CODEX_HOME: path.join(testRoot, "codex-home"),
  };
}

function prepare(testRoot, env) {
  mkdirSync(env.MODEL_ROUTER_STATE_DIR, { recursive: true, mode: 0o700 });
  writeFileSync(
    path.join(env.MODEL_ROUTER_STATE_DIR, "caller-secret"),
    `${CALLER_KEY}\n`,
    { mode: 0o600 },
  );
  writeFileSync(
    path.join(env.MODEL_ROUTER_STATE_DIR, "enabled-providers.json"),
    `${JSON.stringify({ version: 1, providers: ["kimi-oauth", "deepseek"] })}\n`,
    { mode: 0o600 },
  );
  mkdirSync(env.CLAUDE_ROUTER_CONFIG_LIBRARY, { recursive: true, mode: 0o700 });
  writeFileSync(
    path.join(env.CLAUDE_ROUTER_CONFIG_LIBRARY, "_meta.json"),
    `${JSON.stringify({
      appliedId: existingId,
      entries: [{ id: existingId, name: "Existing configuration" }],
    })}\n`,
    { mode: 0o600 },
  );
  writeFileSync(
    path.join(env.CLAUDE_ROUTER_CONFIG_LIBRARY, `${existingId}.json`),
    `${JSON.stringify({ inferenceProvider: "anthropic", sentinel: "preserve-me" })}\n`,
    { mode: 0o600 },
  );
  mkdirSync(env.CODEX_HOME, { recursive: true });
  writeFileSync(path.join(env.CODEX_HOME, "config.toml"), 'model = "keep-codex"\n');
}

function run(command, env) {
  const output = execFileSync(
    process.execPath,
    ["src/claude-config-manager.mjs", command],
    { cwd: root, env, encoding: "utf8" },
  );
  return { output, parsed: JSON.parse(output) };
}

test("Claude config manager adds one owned entry and restores the previous selection", () => {
  const testRoot = mkdtempSync(path.join(os.tmpdir(), "claude-router-config-"));
  const env = environment(testRoot);
  prepare(testRoot, env);

  try {
    const enabled = run("enable", env);
    assert.equal(enabled.parsed.mode, "router");
    assert.equal(enabled.parsed.applied, true);
    assert.doesNotMatch(enabled.output, new RegExp(CALLER_KEY));

    const metaPath = path.join(env.CLAUDE_ROUTER_CONFIG_LIBRARY, "_meta.json");
    const meta = JSON.parse(readFileSync(metaPath, "utf8"));
    assert.equal(meta.entries.length, 2);
    assert.equal(meta.appliedId, enabled.parsed.entryId);
    assert.deepEqual(meta.entries[0], { id: existingId, name: "Existing configuration" });

    const configPath = path.join(
      env.CLAUDE_ROUTER_CONFIG_LIBRARY,
      `${enabled.parsed.entryId}.json`,
    );
    const config = JSON.parse(readFileSync(configPath, "utf8"));
    assert.equal(config.inferenceProvider, "gateway");
    assert.equal(config.inferenceCredentialKind, "static");
    assert.equal(config.inferenceGatewayBaseUrl, "http://127.0.0.1:49110");
    assert.equal(config.inferenceGatewayApiKey, CALLER_KEY);
    assert.equal(config.inferenceGatewayAuthScheme, "bearer");
    assert.equal(config.modelDiscoveryEnabled, false);
    assert.equal(config.toolSearchEnabled, false);
    // Models are presented under Claude role ids (so Claude Desktop accepts
    // them) with a labelOverride carrying the real name.
    assert.deepEqual(
      config.inferenceModels.map((model) => model.name),
      ["claude-sonnet-5", "claude-opus-4-8", "claude-haiku-4-5"],
    );
    assert.equal(config.inferenceModels[0].labelOverride, "Kimi K3 (OAuth)");
    assert.equal(config.inferenceModels[0].supports1m, undefined);
    assert.equal(config.inferenceModels[1].supports1m, true);
    assert.equal(config.inferenceModels[2].supports1m, true);
    if (process.platform !== "win32") {
      assert.equal(statSync(configPath).mode & 0o777, 0o600);
      assert.equal(statSync(metaPath).mode & 0o777, 0o600);
    }

    const enabledAgain = run("enable", env);
    assert.equal(enabledAgain.parsed.entryId, enabled.parsed.entryId);
    assert.equal(
      JSON.parse(readFileSync(metaPath, "utf8")).entries.filter(
        (entry) => entry.id === enabled.parsed.entryId,
      ).length,
      1,
    );

    const manuallySwitchedMeta = JSON.parse(readFileSync(metaPath, "utf8"));
    manuallySwitchedMeta.appliedId = existingId;
    writeFileSync(metaPath, `${JSON.stringify(manuallySwitchedMeta)}\n`, { mode: 0o600 });
    const providerOutput = execFileSync(
      process.execPath,
      ["src/providers.mjs", "disable", "kimi-oauth"],
      { cwd: root, env, encoding: "utf8" },
    );
    assert.match(providerOutput, /Claude Desktop model picker/);
    assert.equal(JSON.parse(readFileSync(metaPath, "utf8")).appliedId, existingId);
    const refreshedConfig = JSON.parse(readFileSync(configPath, "utf8"));
    assert.deepEqual(
      refreshedConfig.inferenceModels.map((model) => model.name),
      ["claude-sonnet-5", "claude-opus-4-8"],
    );

    const disabled = run("disable", env);
    assert.equal(disabled.parsed.mode, "native");
    assert.equal(disabled.parsed.applied, false);
    const restoredMeta = JSON.parse(readFileSync(metaPath, "utf8"));
    assert.equal(restoredMeta.appliedId, existingId);
    assert.deepEqual(restoredMeta.entries, [
      { id: existingId, name: "Existing configuration" },
    ]);
    assert.equal(existsSync(configPath), false);
    assert.equal(
      JSON.parse(
        readFileSync(path.join(env.CLAUDE_ROUTER_CONFIG_LIBRARY, `${existingId}.json`), "utf8"),
      ).sentinel,
      "preserve-me",
    );
    assert.equal(readFileSync(path.join(env.CODEX_HOME, "config.toml"), "utf8"), 'model = "keep-codex"\n');
    assert.equal(
      JSON.parse(
        readFileSync(path.join(env.MODEL_ROUTER_STATE_DIR, "claude-config-state.json"), "utf8"),
      ).enabled,
      false,
    );
  } finally {
    rmSync(testRoot, { recursive: true, force: true });
  }
});

test("Claude config manager refuses malformed user metadata without overwriting it", () => {
  const testRoot = mkdtempSync(path.join(os.tmpdir(), "claude-router-config-invalid-"));
  const env = environment(testRoot);
  prepare(testRoot, env);
  const metaPath = path.join(env.CLAUDE_ROUTER_CONFIG_LIBRARY, "_meta.json");
  const malformed = '{"appliedId":"broken","entries":"not-an-array"}\n';
  writeFileSync(metaPath, malformed, { mode: 0o600 });

  try {
    const result = spawnSync(
      process.execPath,
      ["src/claude-config-manager.mjs", "enable"],
      { cwd: root, env, encoding: "utf8" },
    );
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /unrecognized Claude configuration library/);
    assert.equal(readFileSync(metaPath, "utf8"), malformed);
  } finally {
    rmSync(testRoot, { recursive: true, force: true });
  }
});

test("Claude config manager removes a library index it created from scratch", () => {
  const testRoot = mkdtempSync(path.join(os.tmpdir(), "claude-router-config-empty-"));
  const env = environment(testRoot);
  mkdirSync(env.MODEL_ROUTER_STATE_DIR, { recursive: true, mode: 0o700 });
  writeFileSync(
    path.join(env.MODEL_ROUTER_STATE_DIR, "caller-secret"),
    `${CALLER_KEY}\n`,
    { mode: 0o600 },
  );
  writeFileSync(
    path.join(env.MODEL_ROUTER_STATE_DIR, "enabled-providers.json"),
    `${JSON.stringify({ version: 1, providers: ["deepseek"] })}\n`,
    { mode: 0o600 },
  );

  try {
    const enabled = run("enable", env);
    const metaPath = path.join(env.CLAUDE_ROUTER_CONFIG_LIBRARY, "_meta.json");
    const ownedPath = path.join(
      env.CLAUDE_ROUTER_CONFIG_LIBRARY,
      `${enabled.parsed.entryId}.json`,
    );
    assert.equal(existsSync(metaPath), true);
    assert.equal(existsSync(ownedPath), true);

    run("disable", env);
    assert.equal(existsSync(metaPath), false);
    assert.equal(existsSync(ownedPath), false);
  } finally {
    rmSync(testRoot, { recursive: true, force: true });
  }
});

test("Claude config cleanup preserves metadata fields added after installation", () => {
  const testRoot = mkdtempSync(path.join(os.tmpdir(), "claude-router-config-evolved-"));
  const env = environment(testRoot);
  mkdirSync(env.MODEL_ROUTER_STATE_DIR, { recursive: true, mode: 0o700 });
  writeFileSync(
    path.join(env.MODEL_ROUTER_STATE_DIR, "caller-secret"),
    `${CALLER_KEY}\n`,
    { mode: 0o600 },
  );
  writeFileSync(
    path.join(env.MODEL_ROUTER_STATE_DIR, "enabled-providers.json"),
    `${JSON.stringify({ version: 1, providers: ["deepseek"] })}\n`,
    { mode: 0o600 },
  );

  try {
    run("enable", env);
    const metaPath = path.join(env.CLAUDE_ROUTER_CONFIG_LIBRARY, "_meta.json");
    const meta = JSON.parse(readFileSync(metaPath, "utf8"));
    writeFileSync(
      metaPath,
      `${JSON.stringify({ ...meta, futureClaudeField: "preserve-me" })}\n`,
      { mode: 0o600 },
    );

    run("disable", env);
    const cleaned = JSON.parse(readFileSync(metaPath, "utf8"));
    assert.equal(cleaned.futureClaudeField, "preserve-me");
    assert.equal(cleaned.appliedId, "");
    assert.deepEqual(cleaned.entries, []);
  } finally {
    rmSync(testRoot, { recursive: true, force: true });
  }
});
