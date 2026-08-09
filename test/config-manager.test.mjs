import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { privateFileIsProtected } from "../src/file-security.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const manager = path.join(root, "src", "config-manager.mjs");
const CALLER_KEY = "test-config-caller-capability-with-sufficient-length";

// The config manager probes the installed Codex binary to learn whether its
// schema accepts the managed root-level concurrency scalar. Point it at stubs
// so the tests do not depend on whichever Codex build this machine has.
// Windows cannot execute shebang scripts, so the stubs are batch files there —
// the same .cmd shape codexSpawnTarget already handles for npm-installed Codex.
const codexStubDir = mkdtempSync(path.join(os.tmpdir(), "codex-router-codex-stub-"));
function writeCodexStub(name, message) {
  const isWindows = process.platform === "win32";
  const file = path.join(codexStubDir, isWindows ? `${name}.cmd` : name);
  const contents = isWindows
    ? `@echo ${message} 1>&2\r\n@exit /b 1\r\n`
    : `#!/bin/sh\necho '${message}' >&2\nexit 1\n`;
  writeFileSync(file, contents, { mode: 0o755 });
  return file;
}
const scalarAcceptingCodex = writeCodexStub("codex-accepts-scalar", "Not logged in");
const scalarRejectingCodex = writeCodexStub(
  "codex-rejects-scalar",
  "Error loading configuration: invalid type: integer, expected struct AgentRoleToml",
);
// Accepts the legacy concurrency scalar but rejects the modern v2 feature,
// which is how older builds that still support the scalar behave.
const scalarOnlyCodex = (() => {
  const isWindows = process.platform === "win32";
  const file = path.join(
    codexStubDir,
    isWindows ? "codex-scalar-only.cmd" : "codex-scalar-only",
  );
  const contents = isWindows
    ? `@echo off\r\nfindstr /c:"multi_agent_v2" "%CODEX_HOME%\\config.toml" >nul 2>&1\r\nif %errorlevel% equ 0 (\r\n  echo Error loading configuration: unknown feature multi_agent_v2 1>&2\r\n  exit /b 1\r\n)\r\necho Not logged in 1>&2\r\nexit /b 1\r\n`
    : `#!/bin/sh
if grep -q multi_agent_v2 "$CODEX_HOME/config.toml" 2>/dev/null; then
  echo 'Error loading configuration: unknown feature multi_agent_v2' >&2
  exit 1
fi
echo 'Not logged in' >&2
exit 1
`;
  writeFileSync(file, contents, { mode: 0o755 });
  return file;
})();

function run(
  command,
  codexHome,
  stateDir = path.join(codexHome, "router-state"),
  commandArgs = [],
  env = {},
) {
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const callerSecretPath = path.join(stateDir, "caller-secret");
  if (!existsSync(callerSecretPath)) {
    writeFileSync(callerSecretPath, `${CALLER_KEY}\n`, { mode: 0o600 });
  }
  return JSON.parse(
    execFileSync(process.execPath, [manager, command, ...commandArgs], {
      cwd: root,
      encoding: "utf8",
      env: {
        ...process.env,
        CODEX_BIN: scalarAcceptingCodex,
        CODEX_HOME: codexHome,
        CODEX_ROUTER_STATE_DIR: stateDir,
        CODEX_ROUTER_PORT: "46192",
        ...env,
      },
    }),
  );
}

test("config manager preserves Codex defaults and profiles", () => {
  const codexHome = mkdtempSync(path.join(os.tmpdir(), "codex-router-config-"));
  const configPath = path.join(codexHome, "config.toml");
  const original = `model = "gpt-5.6-sol"
model_provider = "openai"
model_reasoning_effort = "xhigh"

[profiles.work]
model = "gpt-5.6-terra"
approval_policy = "never"
`;
  writeFileSync(configPath, original, { mode: 0o644 });

  try {
    const enabled = run("enable", codexHome);
    assert.equal(enabled.mode, "router");
    assert.equal(enabled.model, "gpt-5.6-sol");
    assert.equal(enabled.model_provider, "openai");
    assert.equal(enabled.config_protected, true);
    assert.equal(
      enabled.openai_base_url,
      "http://127.0.0.1:46192/_codex-router/[REDACTED]/v1",
    );
    assert.doesNotMatch(JSON.stringify(enabled), new RegExp(CALLER_KEY));

    const configured = readFileSync(configPath, "utf8");
    assert.match(configured, /# BEGIN codex-router-managed/);
    assert.match(configured, /# BEGIN codex-router-provider-managed/);
    assert.match(configured, /# BEGIN codex-router-multi-agent-v2-managed/);
    assert.match(
      configured,
      /multi_agent_v2 = \{ enabled = true, max_concurrent_threads_per_session = 6, expose_spawn_agent_model_overrides = true \}/,
    );
    assert.doesNotMatch(configured, /codex-router-agent-concurrency-managed/);
    assert.doesNotMatch(configured, /^max_concurrent_threads_per_session\s*=/m);
    assert.doesNotMatch(configured, /\[agents\]/);
    assert.match(configured, /\[model_providers\.codex-router\]/);
    assert.match(configured, /wire_api = "responses"/);
    assert.ok(
      configured.includes(
        `openai_base_url = "http://127.0.0.1:46192/_codex-router/${CALLER_KEY}/v1"`,
      ),
    );
    assert.match(
      configured,
      /^experimental_realtime_webrtc_call_base_url = "https:\/\/chatgpt\.com\/backend-api\/codex"$/m,
    );
    assert.match(
      configured,
      /^experimental_realtime_ws_base_url = "https:\/\/api\.openai\.com\/v1"$/m,
    );
    assert.match(configured, /model_reasoning_effort = "xhigh"/);
    assert.match(configured, /\[profiles\.work\]/);
    assert.match(configured, /approval_policy = "never"/);
    assert.equal(
      readFileSync(path.join(codexHome, "config.toml.pre-codex-router"), "utf8"),
      original,
    );
    assert.equal(privateFileIsProtected(configPath), true);
    assert.equal(
      privateFileIsProtected(path.join(codexHome, "config.toml.pre-codex-router")),
      true,
    );

    const reenabled = run("enable", codexHome);
    assert.equal(reenabled.mode, "router");
    assert.equal(
      (readFileSync(configPath, "utf8").match(/# BEGIN codex-router-managed/g) || [])
        .length,
      1,
    );

    const disabled = run("disable", codexHome);
    assert.equal(disabled.mode, "native");
    assert.equal(disabled.config_protected, true);
    const restored = readFileSync(configPath, "utf8");
    assert.doesNotMatch(
      restored,
      /codex-router-(?:(?:provider|agent-concurrency|multi-agent-v2)-)?managed|codex-router-created-agents-table|openai_base_url|model_catalog_json|experimental_realtime_(?:webrtc_call|ws)_base_url/,
    );
    assert.doesNotMatch(restored, /\[agents\]|max_concurrent_threads_per_session/);
    assert.match(restored, /model = "gpt-5\.6-sol"/);
    assert.match(restored, /model_provider = "openai"/);
    assert.match(restored, /model_reasoning_effort = "xhigh"/);
    assert.match(restored, /\[profiles\.work\]/);
  } finally {
    rmSync(codexHome, { recursive: true, force: true });
  }
});

test("config manager preserves a user-owned agent concurrency limit", () => {
  const codexHome = mkdtempSync(path.join(os.tmpdir(), "codex-router-agent-limit-"));
  const configPath = path.join(codexHome, "config.toml");
  const original = `max_concurrent_threads_per_session = 3

[agents]
default_subagent_model = "gpt-5.6-terra"
`;
  writeFileSync(configPath, original, { mode: 0o600 });

  try {
    run("enable", codexHome);
    const enabled = readFileSync(configPath, "utf8");
    assert.equal(
      (enabled.match(/^max_concurrent_threads_per_session\s*=/gm) || []).length,
      1,
    );
    assert.match(enabled, /^max_concurrent_threads_per_session = 3$/m);
    assert.match(enabled, /^default_subagent_model = "gpt-5\.6-terra"$/m);
    assert.doesNotMatch(enabled, /codex-router-agent-concurrency-managed/);

    run("disable", codexHome);
    const restored = readFileSync(configPath, "utf8");
    assert.match(restored, /^max_concurrent_threads_per_session = 3$/m);
    assert.match(restored, /^default_subagent_model = "gpt-5\.6-terra"$/m);
  } finally {
    rmSync(codexHome, { recursive: true, force: true });
  }
});

test("config manager adds concurrency at root before an existing agents table", () => {
  const codexHome = mkdtempSync(path.join(os.tmpdir(), "codex-router-agent-default-"));
  const configPath = path.join(codexHome, "config.toml");
  writeFileSync(
    configPath,
    `[agents]
default_subagent_model = "gpt-5.6-terra"

[profiles.work]
model_reasoning_effort = "high"
`,
    { mode: 0o600 },
  );

  try {
    run("enable", codexHome, undefined, [], { CODEX_BIN: scalarOnlyCodex });
    const enabled = readFileSync(configPath, "utf8");
    assert.equal((enabled.match(/^\[agents\]$/gm) || []).length, 1);
    assert.match(enabled, /^max_concurrent_threads_per_session = 6$/m);
    assert.match(enabled, /^default_subagent_model = "gpt-5\.6-terra"$/m);
    assert.doesNotMatch(enabled, /codex-router-multi-agent-v2-managed/);
    assert.ok(
      enabled.indexOf("max_concurrent_threads_per_session = 6") <
        enabled.indexOf("[agents]"),
    );

    run("disable", codexHome, undefined, [], { CODEX_BIN: scalarOnlyCodex });
    const restored = readFileSync(configPath, "utf8");
    assert.match(restored, /^\[agents\]$/m);
    assert.match(restored, /^default_subagent_model = "gpt-5\.6-terra"$/m);
    assert.doesNotMatch(restored, /max_concurrent_threads_per_session/);
    assert.doesNotMatch(restored, /codex-router-agent-concurrency-managed/);
  } finally {
    rmSync(codexHome, { recursive: true, force: true });
  }
});

test("config manager does not add the legacy agents scalar to modern agent configs", () => {
  const codexHome = mkdtempSync(path.join(os.tmpdir(), "codex-router-modern-agents-"));
  const configPath = path.join(codexHome, "config.toml");
  const original = `[agents.gsd-example]
description = "Example agent"
config_file = "/tmp/example-agent.toml"
`;
  writeFileSync(configPath, original, { mode: 0o600 });

  try {
    run("enable", codexHome);
    const enabled = readFileSync(configPath, "utf8");
    assert.doesNotMatch(enabled, /codex-router-agent-concurrency-managed/);
    assert.doesNotMatch(enabled, /^\[agents\]$/m);
    assert.match(enabled, /^\[agents\.gsd-example\]$/m);

    run("disable", codexHome);
    assert.equal(readFileSync(configPath, "utf8").trimStart(), original);
  } finally {
    rmSync(codexHome, { recursive: true, force: true });
  }
});

test("config manager skips the agents scalar when the codex binary rejects it", () => {
  const codexHome = mkdtempSync(path.join(os.tmpdir(), "codex-router-strict-schema-"));
  const configPath = path.join(codexHome, "config.toml");
  const original = `model = "gpt-5.5"
`;
  writeFileSync(configPath, original, { mode: 0o600 });

  try {
    run("enable", codexHome, undefined, [], { CODEX_BIN: scalarRejectingCodex });
    const enabled = readFileSync(configPath, "utf8");
    assert.doesNotMatch(enabled, /codex-router-agent-concurrency-managed/);
    assert.doesNotMatch(enabled, /codex-router-multi-agent-v2-managed/);
    assert.doesNotMatch(enabled, /^\[agents\]$/m);
    assert.match(enabled, /# BEGIN codex-router-managed/);

    run("disable", codexHome, undefined, [], { CODEX_BIN: scalarRejectingCodex });
    assert.equal(readFileSync(configPath, "utf8").trimStart(), original);
  } finally {
    rmSync(codexHome, { recursive: true, force: true });
  }
});

test("config manager keeps writing the agents scalar when the codex binary lacks v2 support", () => {
  const codexHome = mkdtempSync(path.join(os.tmpdir(), "codex-router-lenient-schema-"));
  const configPath = path.join(codexHome, "config.toml");
  writeFileSync(configPath, `model = "gpt-5.5"\n`, { mode: 0o600 });

  try {
    run("enable", codexHome, undefined, [], { CODEX_BIN: scalarOnlyCodex });
    const enabled = readFileSync(configPath, "utf8");
    assert.match(enabled, /codex-router-agent-concurrency-managed/);
    assert.match(enabled, /^max_concurrent_threads_per_session = 6$/m);
    assert.doesNotMatch(enabled, /codex-router-multi-agent-v2-managed/);
  } finally {
    rmSync(codexHome, { recursive: true, force: true });
  }
});

test("config manager enables multi_agent_v2 and skips the legacy agents scalar when supported", () => {
  const codexHome = mkdtempSync(path.join(os.tmpdir(), "codex-router-v2-feature-"));
  const configPath = path.join(codexHome, "config.toml");
  writeFileSync(configPath, `model = "gpt-5.5"\n`, { mode: 0o600 });

  try {
    run("enable", codexHome);
    const enabled = readFileSync(configPath, "utf8");
    assert.match(enabled, /# BEGIN codex-router-multi-agent-v2-managed/);
    assert.match(
      enabled,
      /multi_agent_v2 = \{ enabled = true, max_concurrent_threads_per_session = 6, expose_spawn_agent_model_overrides = true \}/,
    );
    assert.doesNotMatch(enabled, /codex-router-agent-concurrency-managed/);
    assert.doesNotMatch(enabled, /^max_concurrent_threads_per_session\s*=/m);

    run("enable", codexHome);
    const reenabled = readFileSync(configPath, "utf8");
    assert.equal(
      (reenabled.match(/# BEGIN codex-router-multi-agent-v2-managed/g) || []).length,
      1,
    );

    run("disable", codexHome);
    const restored = readFileSync(configPath, "utf8");
    assert.doesNotMatch(restored, /codex-router-multi-agent-v2-managed|multi_agent_v2/);
    assert.equal(restored.trimStart(), `model = "gpt-5.5"\n`);
  } finally {
    rmSync(codexHome, { recursive: true, force: true });
  }
});

test("config manager preserves user-owned realtime endpoints", () => {
  const codexHome = mkdtempSync(path.join(os.tmpdir(), "codex-router-realtime-"));
  const configPath = path.join(codexHome, "config.toml");
  const original = `experimental_realtime_webrtc_call_base_url = "https://voice.example/calls"
experimental_realtime_ws_base_url = "wss://voice.example/live"
chatgpt_base_url = "https://chat.example/backend-api/"
`;
  writeFileSync(configPath, original, { mode: 0o600 });

  try {
    run("enable", codexHome);
    const enabled = readFileSync(configPath, "utf8");
    assert.equal(
      (enabled.match(/^experimental_realtime_webrtc_call_base_url\s*=/gm) || []).length,
      1,
    );
    assert.equal(
      (enabled.match(/^experimental_realtime_ws_base_url\s*=/gm) || []).length,
      1,
    );
    assert.match(enabled, /experimental_realtime_webrtc_call_base_url = "https:\/\/voice\.example\/calls"/);
    assert.match(enabled, /experimental_realtime_ws_base_url = "wss:\/\/voice\.example\/live"/);

    run("disable", codexHome);
    assert.equal(readFileSync(configPath, "utf8"), original);
  } finally {
    rmSync(codexHome, { recursive: true, force: true });
  }
});

test("config manager derives native Voice calls from a custom ChatGPT base URL", () => {
  const codexHome = mkdtempSync(path.join(os.tmpdir(), "codex-router-voice-base-"));
  const configPath = path.join(codexHome, "config.toml");
  writeFileSync(
    configPath,
    `chatgpt_base_url = "https://chat.example/backend-api/"
`,
    { mode: 0o600 },
  );

  try {
    run("enable", codexHome);
    const enabled = readFileSync(configPath, "utf8");
    assert.match(
      enabled,
      /^experimental_realtime_webrtc_call_base_url = "https:\/\/chat\.example\/backend-api\/codex"$/m,
    );

    run("disable", codexHome);
    assert.equal(
      readFileSync(configPath, "utf8"),
      `chatgpt_base_url = "https://chat.example/backend-api/"
`,
    );
  } finally {
    rmSync(codexHome, { recursive: true, force: true });
  }
});

test("login-free mode selects the managed provider and restores the previous provider", () => {
  const codexHome = mkdtempSync(path.join(os.tmpdir(), "codex-router-login-free-"));
  const stateDir = path.join(codexHome, "router-state");
  const configPath = path.join(codexHome, "config.toml");
  const providerModePath = path.join(stateDir, "codex-provider-mode.json");
  writeFileSync(
    configPath,
    `model = "gpt-5.6-sol"
model_provider = "openai"
model_reasoning_effort = "high"

[profiles.work]
approval_policy = "never"
`,
    { mode: 0o600 },
  );

  try {
    run("enable", codexHome, stateDir);
    const enabled = run("login-free-enable", codexHome, stateDir, ["deepseek/deepseek-v4-pro"]);
    assert.equal(enabled.mode, "router");
    assert.equal(enabled.model_provider, "codex-router");
    assert.equal(enabled.login_free, true);
    assert.equal(enabled.login_free_managed, true);
    assert.equal(enabled.model, "deepseek/deepseek-v4-pro");
    assert.equal(privateFileIsProtected(providerModePath), true);

    const loginFreeConfig = readFileSync(configPath, "utf8");
    assert.match(loginFreeConfig, /^model_provider = "codex-router"$/m);
    assert.match(loginFreeConfig, /\[model_providers\.codex-router\]/);
    assert.match(loginFreeConfig, /model = "deepseek\/deepseek-v4-pro"/);
    assert.match(loginFreeConfig, /model_reasoning_effort = "high"/);
    assert.match(loginFreeConfig, /\[profiles\.work\]/);

    const reenabled = run("enable", codexHome, stateDir);
    assert.equal(reenabled.login_free, true);
    assert.equal(reenabled.login_free_managed, true);

    const restored = run("login-free-disable", codexHome, stateDir);
    assert.equal(restored.mode, "router");
    assert.equal(restored.model_provider, "openai");
    assert.equal(restored.login_free, false);
    assert.equal(restored.model, "gpt-5.6-sol");
    assert.equal(existsSync(providerModePath), false);
    assert.match(readFileSync(configPath, "utf8"), /^model_provider = "openai"$/m);
    assert.match(readFileSync(configPath, "utf8"), /^model = "gpt-5.6-sol"$/m);
  } finally {
    rmSync(codexHome, { recursive: true, force: true });
  }
});

test("signed-in enable clears stale login-free restore state after an external provider change", () => {
  const codexHome = mkdtempSync(path.join(os.tmpdir(), "codex-router-config-stale-mode-"));
  const stateDir = path.join(codexHome, "codex-router");
  const configPath = path.join(codexHome, "config.toml");
  const providerModePath = path.join(stateDir, "codex-provider-mode.json");
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(configPath, 'model_provider = "openai"\n', { mode: 0o600 });
  try {
    run("login-free-enable", codexHome, stateDir, ["deepseek/deepseek-v4-pro"]);
    assert.equal(existsSync(providerModePath), true);
    const externallyRestored = readFileSync(configPath, "utf8").replace(
      /^model_provider = "codex-router"$/m,
      'model_provider = "custom"',
    );
    writeFileSync(configPath, externallyRestored, { mode: 0o600 });

    const enabled = run("enable", codexHome, stateDir);
    assert.equal(enabled.mode, "router");
    assert.equal(enabled.model_provider, "custom");
    assert.equal(enabled.provider_mode_state_present, false);
    assert.equal(existsSync(providerModePath), false);
  } finally {
    rmSync(codexHome, { recursive: true, force: true });
  }
});

test("disabling the router from login-free mode restores an originally unset provider", () => {
  const codexHome = mkdtempSync(path.join(os.tmpdir(), "codex-router-login-free-unset-"));
  const stateDir = path.join(codexHome, "router-state");
  const configPath = path.join(codexHome, "config.toml");
  writeFileSync(configPath, `model = "kimi-api/kimi-k3"\n`, { mode: 0o600 });

  try {
    run("login-free-enable", codexHome, stateDir, ["kimi-api/kimi-k3"]);
    assert.match(readFileSync(configPath, "utf8"), /^model_provider = "codex-router"$/m);

    const disabled = run("disable", codexHome, stateDir);
    assert.equal(disabled.mode, "native");
    assert.equal(disabled.model_provider, "openai");
    const restored = readFileSync(configPath, "utf8");
    assert.doesNotMatch(restored, /^model_provider\s*=/m);
    assert.doesNotMatch(restored, /model_providers\.codex-router|codex-router-managed/);
    assert.match(restored, /model = "kimi-api\/kimi-k3"/);
  } finally {
    rmSync(codexHome, { recursive: true, force: true });
  }
});

test("config manager refuses an unowned codex-router provider table", () => {
  const codexHome = mkdtempSync(path.join(os.tmpdir(), "codex-router-provider-conflict-"));
  const configPath = path.join(codexHome, "config.toml");
  writeFileSync(
    configPath,
    `[model_providers.codex-router]
name = "User router"
base_url = "http://127.0.0.1:9999/v1"
wire_api = "responses"
`,
    { mode: 0o600 },
  );

  try {
    assert.throws(
      () => run("enable", codexHome),
      /Refusing to replace user-owned model provider codex-router/,
    );
  } finally {
    rmSync(codexHome, { recursive: true, force: true });
  }
});

test("config manager adopts the exact legacy router-owned provider table", () => {
  const codexHome = mkdtempSync(path.join(os.tmpdir(), "codex-router-provider-legacy-"));
  const stateDir = path.join(codexHome, "router-state");
  const configPath = path.join(codexHome, "config.toml");

  try {
    run("enable", codexHome, stateDir);
    const current = readFileSync(configPath, "utf8");
    const legacy = current
      .replace("# BEGIN codex-router-provider-managed\n", "")
      .replace("\n# END codex-router-provider-managed", "")
      .replace(
        'name = "Codex Router (external models)"',
        'name = "Codex Router (extra providers)"',
      )
      .replace('wire_api = "responses"', 'wire_api = "responses"\nrequires_openai_auth = true');
    writeFileSync(configPath, legacy, { mode: 0o600 });

    const enabled = run("login-free-enable", codexHome, stateDir, ["kimi-oauth/kimi-k2.5"]);
    assert.equal(enabled.login_free, true);
    assert.equal(enabled.login_free_managed, true);
    assert.equal(enabled.model, "kimi-oauth/kimi-k2.5");
    const migrated = readFileSync(configPath, "utf8");
    assert.equal((migrated.match(/\[model_providers\.codex-router\]/g) || []).length, 1);
    assert.match(migrated, /# BEGIN codex-router-provider-managed/);
    assert.match(migrated, /name = "Codex Router \(external models\)"/);
    assert.doesNotMatch(migrated, /extra providers|requires_openai_auth/);
  } finally {
    rmSync(codexHome, { recursive: true, force: true });
  }
});

test("config manager refuses a modified legacy router provider table", () => {
  const codexHome = mkdtempSync(path.join(os.tmpdir(), "codex-router-provider-modified-"));
  const stateDir = path.join(codexHome, "router-state");
  const configPath = path.join(codexHome, "config.toml");

  try {
    run("enable", codexHome, stateDir);
    const modified = readFileSync(configPath, "utf8")
      .replace("# BEGIN codex-router-provider-managed\n", "")
      .replace("\n# END codex-router-provider-managed", "")
      .replace('wire_api = "responses"', 'wire_api = "responses"\ncustom_setting = true');
    writeFileSync(configPath, modified, { mode: 0o600 });

    assert.throws(
      () => run("enable", codexHome, stateDir),
      /Refusing to replace user-owned model provider codex-router/,
    );
  } finally {
    rmSync(codexHome, { recursive: true, force: true });
  }
});

test("config manager decodes escaped catalog paths", () => {
  const codexHome = mkdtempSync(path.join(os.tmpdir(), "codex-router-escaped-path-"));
  const stateDir = path.join(codexHome, "router\\state");

  try {
    const enabled = run("enable", codexHome, stateDir);
    assert.equal(enabled.mode, "router");
    assert.equal(enabled.model_catalog_json, path.join(stateDir, "merged-models.json"));
    assert.equal(run("status", codexHome, stateDir).mode, "router");
  } finally {
    rmSync(codexHome, { recursive: true, force: true });
  }
});

test("config manager upgrades the earlier Kimi-only managed block", () => {
  const codexHome = mkdtempSync(path.join(os.tmpdir(), "codex-router-legacy-"));
  const configPath = path.join(codexHome, "config.toml");
  writeFileSync(
    configPath,
    `model = "gpt-5.6-sol"

# BEGIN kimi-codex-router-managed
openai_base_url = "http://127.0.0.1:46192/v1"
model_catalog_json = "${path.join(codexHome, "kimi-router", "merged-models.json")}"
# END kimi-codex-router-managed

[profiles.personal]
model_reasoning_effort = "high"
`,
    { mode: 0o600 },
  );

  try {
    run("enable", codexHome);
    const configured = readFileSync(configPath, "utf8");
    assert.doesNotMatch(configured, /kimi-codex-router-managed|kimi-router/);
    assert.match(configured, /# BEGIN codex-router-managed/);
    assert.ok(
      configured.includes(
        JSON.stringify(path.join(codexHome, "router-state", "merged-models.json")),
      ),
    );
    assert.match(configured, /\[profiles\.personal\]/);
  } finally {
    rmSync(codexHome, { recursive: true, force: true });
  }
});

test("config manager repairs a malformed prototype block without touching tables", () => {
  const codexHome = mkdtempSync(path.join(os.tmpdir(), "codex-router-prototype-"));
  const configPath = path.join(codexHome, "config.toml");
  const prototypeCatalog = path.join(codexHome, "kimi-proxy", "merged-models.json");
  writeFileSync(
    configPath,
    `model = "kimi-oauth/k3"
model_reasoning_effort = "high"

# BEGIN kimi-codex-router-managed
openai_base_url = "http://127.0.0.1:46192/v1"
model_catalog_json = "${prototypeCatalog}"

[projects."/important/project"]
trust_level = "trusted"
`,
    { mode: 0o600 },
  );

  try {
    run("enable", codexHome);
    const configured = readFileSync(configPath, "utf8");
    assert.doesNotMatch(configured, /kimi-proxy|BEGIN kimi-codex-router/);
    assert.match(configured, /# BEGIN codex-router-managed/);
    assert.match(configured, /model = "kimi-oauth\/k3"/);
    assert.match(configured, /model_reasoning_effort = "high"/);
    assert.match(configured, /\[projects\."\/important\/project"\]/);
    assert.match(configured, /trust_level = "trusted"/);
  } finally {
    rmSync(codexHome, { recursive: true, force: true });
  }
});

test("config manager fails closed when the caller capability is missing", () => {
  const codexHome = mkdtempSync(path.join(os.tmpdir(), "codex-router-no-caller-"));
  const stateDir = path.join(codexHome, "router-state");
  const configPath = path.join(codexHome, "config.toml");
  const original = `model = "gpt-5.6-sol"\n`;
  writeFileSync(configPath, original, { mode: 0o600 });

  try {
    assert.throws(
      () =>
        execFileSync(process.execPath, [manager, "enable"], {
          cwd: root,
          encoding: "utf8",
          env: {
            ...process.env,
            CODEX_HOME: codexHome,
            CODEX_ROUTER_STATE_DIR: stateDir,
            CODEX_ROUTER_PORT: "46192",
          },
          stdio: ["ignore", "pipe", "pipe"],
        }),
      (error) =>
        error?.status === 1 &&
        String(error.stderr).includes("router caller key is missing"),
    );
    assert.equal(readFileSync(configPath, "utf8"), original);
    assert.equal(
      existsSync(path.join(codexHome, "config.toml.pre-codex-router")),
      false,
    );
  } finally {
    rmSync(codexHome, { recursive: true, force: true });
  }
});

test("config manager migrates a managed capability when the router port changes", () => {
  const codexHome = mkdtempSync(path.join(os.tmpdir(), "codex-router-port-change-"));
  const stateDir = path.join(codexHome, "router-state");
  const configPath = path.join(codexHome, "config.toml");
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  writeFileSync(path.join(stateDir, "caller-secret"), `${CALLER_KEY}\n`, {
    mode: 0o600,
  });
  writeFileSync(
    configPath,
    `# BEGIN codex-router-managed
openai_base_url = "http://127.0.0.1:4102/_codex-router/${CALLER_KEY}/v1"
model_catalog_json = ${JSON.stringify(path.join(stateDir, "merged-models.json"))}

[profiles.work]
model = "gpt-5.6-terra"
`,
    { mode: 0o600 },
  );

  try {
    assert.equal(run("enable", codexHome, stateDir).mode, "router");
    const configured = readFileSync(configPath, "utf8");
    assert.ok(configured.includes("http://127.0.0.1:46192/_codex-router/"));
    assert.doesNotMatch(configured, /127\.0\.0\.1:4102/);
    assert.match(configured, /\[profiles\.work\]/);
  } finally {
    rmSync(codexHome, { recursive: true, force: true });
  }
});

test("model_catalog_json round-trips through TOML escaping", () => {
  const codexHome = mkdtempSync(path.join(os.tmpdir(), "codex-router-config-catalog-"));
  const configPath = path.join(codexHome, "config.toml");
  writeFileSync(configPath, 'model = "gpt-5.6-sol"\n', { mode: 0o644 });
  try {
    run("enable", codexHome);
    const configured = readFileSync(configPath, "utf8");
    const line = configured.split("\n").find((l) => l.startsWith("model_catalog_json"));
    assert.ok(line, "model_catalog_json is emitted");
    const raw = line.slice(line.indexOf("=") + 1).trim();
    // Basic strings are emitted with JSON escaping so any Windows path,
    // including one containing apostrophes, stays valid TOML.
    assert.equal(raw.startsWith('"'), true, "catalog path must be a basic string");
    const value = JSON.parse(raw);
    assert.equal(value, path.join(codexHome, "router-state", "merged-models.json"));
  } finally {
    rmSync(codexHome, { recursive: true, force: true });
  }
});

test("model_catalog_json accepts apostrophes and backslashes in the path", () => {
  const codexHome = mkdtempSync(path.join(os.tmpdir(), "codex-router-config-catalog-"));
  const configPath = path.join(codexHome, "config.toml");
  const stateDir = path.join(codexHome, "O'Brien router-state\\win");
  writeFileSync(configPath, 'model = "gpt-5.6-sol"\n', { mode: 0o644 });
  try {
    run("enable", codexHome, stateDir);
    const configured = readFileSync(configPath, "utf8");
    const line = configured.split("\n").find((l) => l.startsWith("model_catalog_json"));
    assert.ok(line, "model_catalog_json is emitted");
    const raw = line.slice(line.indexOf("=") + 1).trim();
    assert.equal(JSON.parse(raw), path.join(stateDir, "merged-models.json"));
  } finally {
    rmSync(codexHome, { recursive: true, force: true });
  }
});
