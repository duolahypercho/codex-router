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
      /multi_agent_v2 = \{ enabled = true, max_concurrent_threads_per_session = 6, expose_spawn_agent_model_overrides = true, usage_hint_enabled = true, root_agent_usage_hint_text = "When a child agent finishes \(FINAL_ANSWER, task_complete, or an idle\/errored wait snapshot\), call interrupt_agent on that child so Codex can mark it done\. Do not leave finished children in the working state\." \}/,
    );
    assert.doesNotMatch(configured, /codex-router-agent-concurrency-managed/);
    assert.doesNotMatch(configured, /^max_concurrent_threads_per_session\s*=/m);
    assert.doesNotMatch(configured, /\[agents\]/);
    assert.match(configured, /\[model_providers\.codex-router\]/);
    assert.match(configured, /wire_api = "responses"/);
    assert.match(configured, /supports_standalone_web_search = true/);
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
      /multi_agent_v2 = \{ enabled = true, max_concurrent_threads_per_session = 6, expose_spawn_agent_model_overrides = true, usage_hint_enabled = true, root_agent_usage_hint_text = "When a child agent finishes \(FINAL_ANSWER, task_complete, or an idle\/errored wait snapshot\), call interrupt_agent on that child so Codex can mark it done\. Do not leave finished children in the working state\." \}/,
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

test("the managed multi_agent_v2 line tells the parent to interrupt finished children", () => {
  const codexHome = mkdtempSync(path.join(os.tmpdir(), "codex-router-v2-hint-"));
  const configPath = path.join(codexHome, "config.toml");
  writeFileSync(configPath, `model = "gpt-5.5"\n`, { mode: 0o600 });

  try {
    run("enable", codexHome);
    const enabled = readFileSync(configPath, "utf8");
    assert.match(enabled, /usage_hint_enabled = true/);
    assert.match(enabled, /root_agent_usage_hint_text = "When a child agent finishes/);
    assert.match(enabled, /call interrupt_agent on that child/);
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
    assert.doesNotMatch(migrated, /extra providers/);
    const loginFreeProvider = migrated.match(
      /\[model_providers\.codex-router\][\s\S]*?# END codex-router-provider-managed/,
    )?.[0];
    assert.ok(loginFreeProvider);
    assert.doesNotMatch(loginFreeProvider, /requires_openai_auth/);
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
model_catalog_json = ${JSON.stringify(path.join(codexHome, "kimi-router", "merged-models.json"))}
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
model_catalog_json = ${JSON.stringify(prototypeCatalog)}

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

test("config manager recognizes the pre-BrlAPI-safe default and rewrites it", () => {
  const codexHome = mkdtempSync(path.join(os.tmpdir(), "codex-router-legacy-port-"));
  const stateDir = path.join(codexHome, "router-state");
  const configPath = path.join(codexHome, "config.toml");
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  writeFileSync(path.join(stateDir, "caller-secret"), `${CALLER_KEY}\n`, { mode: 0o600 });
  writeFileSync(
    configPath,
    `# BEGIN codex-router-managed\nopenai_base_url = "http://127.0.0.1:4102/_codex-router/${CALLER_KEY}/v1"\nmodel_catalog_json = ${JSON.stringify(path.join(stateDir, "merged-models.json"))}\n`,
    { mode: 0o600 },
  );
  try {
    assert.equal(run("enable", codexHome, stateDir).mode, "router");
    assert.match(readFileSync(configPath, "utf8"), /127\.0\.0\.1:46192/);
    assert.doesNotMatch(readFileSync(configPath, "utf8"), /127\.0\.0\.1:4102/);
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

test("config manager adopts and restores a prepared user-owned native catalog", () => {
  const codexHome = mkdtempSync(path.join(os.tmpdir(), "codex-router-adopt-catalog-"));
  const stateDir = path.join(codexHome, "router-state");
  const configPath = path.join(codexHome, "config.toml");
  const foreignCatalog = path.join(codexHome, "user catalog's", "native-models.json");
  mkdirSync(path.dirname(foreignCatalog), { recursive: true });
  writeFileSync(
    foreignCatalog,
    JSON.stringify({ models: [{ slug: "gpt-user-native" }] }),
    { mode: 0o600 },
  );
  writeFileSync(
    configPath,
    `model = "gpt-user-native"\nmodel_catalog_json = ${JSON.stringify(foreignCatalog)}\n`,
    { mode: 0o600 },
  );

  try {
    execFileSync(
      process.execPath,
      [path.join(root, "src", "native-catalog-source.mjs"), "prepare-from-config"],
      {
        cwd: root,
        env: {
          ...process.env,
          CODEX_HOME: codexHome,
          CODEX_ROUTER_STATE_DIR: stateDir,
        },
      },
    );
    const enabled = run("enable", codexHome, stateDir, ["--adopt-native-catalog"]);
    assert.equal(enabled.mode, "router");
    assert.equal(
      JSON.parse(
        readFileSync(path.join(stateDir, "native-catalog-source.json"), "utf8"),
      ).status,
      "active",
    );

    const disabled = run("disable", codexHome, stateDir);
    assert.equal(disabled.mode, "native");
    assert.equal(
      readFileSync(configPath, "utf8").includes(
        `model_catalog_json = ${JSON.stringify(foreignCatalog)}`,
      ),
      true,
    );
    assert.equal(
      existsSync(path.join(stateDir, "native-catalog-source.json")),
      false,
    );
  } finally {
    rmSync(codexHome, { recursive: true, force: true });
  }
});

test("signed routing preserves the active provider identity and exactly restores its table", () => {
  const codexHome = mkdtempSync(path.join(os.tmpdir(), "codex-router-signed-provider-"));
  const stateDir = path.join(codexHome, "router-state");
  const configPath = path.join(codexHome, "config.toml");
  const original = `model = "gpt-5.6-sol"
model_provider = "custom"

[model_providers.custom]
name = "CC Switch"
base_url = "https://example.invalid/v1"
wire_api = "responses"

[model_providers.custom.query_params]
api_key = "PROVIDER_QUERY_SECRET"

[profiles.work]
model = "gpt-5.6-terra"

[model_providers.custom.auth]
token = "PROVIDER_AUTH_SECRET"

[model_providers.other]
base_url = "https://other.invalid/v1"

[model_providers.custom.http_headers]
Authorization = "Bearer PROVIDER_HEADER_SECRET"
`;
  writeFileSync(configPath, original, { mode: 0o600 });

  try {
    const enabled = run("signed-enable", codexHome, stateDir);
    assert.equal(enabled.signed_routing, true);
    assert.equal(enabled.signed_routing_managed, true);
    const configured = readFileSync(configPath, "utf8");
    assert.match(configured, /^model_provider = "custom"$/m);
    assert.match(configured, /# BEGIN codex-router-signed-provider-managed/);
    assert.match(configured, /\[model_providers\.custom\]/);
    assert.doesNotMatch(configured, /\[model_providers\.codex-router-signed\]/);
    assert.match(configured, new RegExp(`base_url = "http://127\\.0\\.0\\.1:46192/_codex-router/${CALLER_KEY}/v1"`));
    assert.match(configured, /requires_openai_auth = true/);
    assert.match(configured, /supports_websockets = false/);
    assert.match(configured, /supports_standalone_web_search = true/);
    assert.doesNotMatch(configured, /PROVIDER_(?:QUERY|AUTH|HEADER)_SECRET/);
    assert.doesNotMatch(
      configured,
      /\[model_providers\.custom\.(?:query_params|auth|http_headers)\]/,
    );
    assert.match(configured, /\[model_providers\.other\]/);
    assert.match(configured, /\[profiles\.work\]/);
    assert.equal(
      privateFileIsProtected(path.join(stateDir, "signed-provider-mode.json")),
      true,
    );

    const disabled = run("signed-disable", codexHome, stateDir);
    assert.equal(disabled.model_provider, "custom");
    assert.equal(disabled.signed_provider_state_present, false);
    const restored = readFileSync(configPath, "utf8");
    assert.match(restored, /\[model_providers\.custom\]/);
    assert.match(restored, /name = "CC Switch"/);
    assert.match(restored, /base_url = "https:\/\/example\.invalid\/v1"/);
    assert.match(restored, /api_key = "PROVIDER_QUERY_SECRET"/);
    assert.match(restored, /token = "PROVIDER_AUTH_SECRET"/);
    assert.match(restored, /Authorization = "Bearer PROVIDER_HEADER_SECRET"/);
    assert.ok(
      restored.indexOf("[model_providers.custom.query_params]") <
        restored.indexOf("[profiles.work]"),
    );
    assert.ok(
      restored.indexOf("[model_providers.other]") <
        restored.indexOf("[model_providers.custom.http_headers]"),
    );
    assert.doesNotMatch(restored, /codex-router-signed-provider-managed/);
  } finally {
    rmSync(codexHome, { recursive: true, force: true });
  }
});

test("signed routing snapshots a quoted provider id containing a closing bracket", () => {
  const codexHome = mkdtempSync(path.join(os.tmpdir(), "codex-router-signed-quoted-id-"));
  const stateDir = path.join(codexHome, "router-state");
  const configPath = path.join(codexHome, "config.toml");
  writeFileSync(
    configPath,
    `model_provider = "custom]id"

[model_providers."custom]id"]
name = "Foreign provider"
base_url = "https://foreign.invalid/v1"

[model_providers."custom]id".query_params]
api_key = "QUOTED_QUERY_SECRET"

[model_providers."custom]id".auth]
token = "QUOTED_AUTH_SECRET"

[model_providers."custom]id".http_headers]
Authorization = "Bearer QUOTED_HEADER_SECRET"
`,
    { mode: 0o600 },
  );

  try {
    const enabled = run("signed-enable", codexHome, stateDir);
    assert.equal(enabled.signed_routing, true);
    const active = readFileSync(configPath, "utf8");
    assert.equal((active.match(/\[model_providers\."custom\]id"\]/g) || []).length, 1);
    assert.doesNotMatch(active, /https:\/\/foreign\.invalid/);
    assert.doesNotMatch(active, /QUOTED_(?:QUERY|AUTH|HEADER)_SECRET/);
    assert.doesNotMatch(
      active,
      /\[model_providers\."custom\]id"\.(?:query_params|auth|http_headers)\]/,
    );

    run("signed-disable", codexHome, stateDir);
    const restored = readFileSync(configPath, "utf8");
    assert.match(restored, /base_url = "https:\/\/foreign\.invalid\/v1"/);
    assert.match(restored, /api_key = "QUOTED_QUERY_SECRET"/);
    assert.match(restored, /token = "QUOTED_AUTH_SECRET"/);
    assert.match(restored, /Authorization = "Bearer QUOTED_HEADER_SECRET"/);
    assert.doesNotMatch(restored, /codex-router-signed-provider-managed/);
  } finally {
    rmSync(codexHome, { recursive: true, force: true });
  }
});

test("signed routing ignores table-looking lines inside multiline TOML strings", () => {
  const codexHome = mkdtempSync(path.join(os.tmpdir(), "codex-router-signed-multiline-"));
  const stateDir = path.join(codexHome, "router-state");
  const configPath = path.join(codexHome, "config.toml");
  writeFileSync(
    configPath,
    `model_provider = "custom"

[model_providers.custom]
description = """
[looks.like.a.table]
This is provider documentation, not a TOML table.
"""
base_url = "https://foreign.invalid/v1"

[model_providers.custom.query_params]
api_key = "MULTILINE_QUERY_SECRET"
`,
    { mode: 0o600 },
  );

  try {
    run("signed-enable", codexHome, stateDir);
    const active = readFileSync(configPath, "utf8");
    assert.doesNotMatch(active, /\[looks\.like\.a\.table\]/);
    assert.doesNotMatch(active, /https:\/\/foreign\.invalid/);
    assert.doesNotMatch(active, /MULTILINE_QUERY_SECRET/);

    run("signed-disable", codexHome, stateDir);
    const restored = readFileSync(configPath, "utf8");
    assert.match(restored, /description = """\n\[looks\.like\.a\.table\]/);
    assert.match(restored, /api_key = "MULTILINE_QUERY_SECRET"/);
    assert.doesNotMatch(restored, /codex-router-signed-provider-managed/);
  } finally {
    rmSync(codexHome, { recursive: true, force: true });
  }
});

test("signed routing fails closed before writing ambiguous TOML boundaries", () => {
  const codexHome = mkdtempSync(path.join(os.tmpdir(), "codex-router-signed-ambiguous-"));
  const stateDir = path.join(codexHome, "router-state");
  const configPath = path.join(codexHome, "config.toml");
  const original = `model_provider = "custom"

[model_providers.custom]
description = """
[looks.like.a.table]
`;
  writeFileSync(configPath, original, { mode: 0o600 });

  try {
    assert.throws(
      () => run("signed-enable", codexHome, stateDir),
      /ambiguous TOML|unterminated multiline/i,
    );
    assert.equal(readFileSync(configPath, "utf8"), original);
    assert.equal(existsSync(path.join(stateDir, "signed-provider-mode.json")), false);
  } finally {
    rmSync(codexHome, { recursive: true, force: true });
  }
});

test("ordinary enable keeps signed routing active without reviving nested provider secrets", () => {
  const codexHome = mkdtempSync(path.join(os.tmpdir(), "codex-router-signed-update-"));
  const stateDir = path.join(codexHome, "router-state");
  const configPath = path.join(codexHome, "config.toml");
  writeFileSync(
    configPath,
    `model_provider = "custom"

[model_providers.custom]
name = "CC Switch"
base_url = "https://example.invalid/v1"

[model_providers.custom.query_params]
api_key = "UPDATE_QUERY_SECRET"

[model_providers.custom.http_headers]
Authorization = "Bearer UPDATE_HEADER_SECRET"
`,
    { mode: 0o600 },
  );
  try {
    run("signed-enable", codexHome, stateDir);
    const updated = run("enable", codexHome, stateDir);
    assert.equal(updated.signed_routing, true);
    assert.equal(updated.signed_routing_managed, true);
    const active = readFileSync(configPath, "utf8");
    assert.doesNotMatch(active, /UPDATE_(?:QUERY|HEADER)_SECRET/);
    assert.equal(
      (active.match(/# BEGIN codex-router-signed-provider-managed/g) || []).length,
      1,
    );
    assert.equal(
      JSON.parse(readFileSync(path.join(stateDir, "signed-provider-mode.json"), "utf8"))
        .version,
      3,
    );

    run("signed-disable", codexHome, stateDir);
    const restored = readFileSync(configPath, "utf8");
    assert.match(restored, /api_key = "UPDATE_QUERY_SECRET"/);
    assert.match(restored, /Authorization = "Bearer UPDATE_HEADER_SECRET"/);
  } finally {
    rmSync(codexHome, { recursive: true, force: true });
  }
});

test("ordinary update upgrades v2 signed state and captures subtables it previously left active", () => {
  const codexHome = mkdtempSync(path.join(os.tmpdir(), "codex-router-signed-v2-update-"));
  const stateDir = path.join(codexHome, "router-state");
  const configPath = path.join(codexHome, "config.toml");
  const statePath = path.join(stateDir, "signed-provider-mode.json");
  writeFileSync(
    configPath,
    `model_provider = "custom"

[model_providers.custom]
name = "CC Switch"
base_url = "https://example.invalid/v1"

[model_providers.custom.query_params]
api_key = "LEGACY_V2_QUERY_SECRET"
`,
    { mode: 0o600 },
  );
  try {
    run("signed-enable", codexHome, stateDir);
    const v3 = JSON.parse(readFileSync(statePath, "utf8"));
    const legacyActive = `${readFileSync(configPath, "utf8")
      .replace(/^# codex-router-signed-provider-tree-slot.*(?:\n|$)/gm, "")
      .trimEnd()}\n\n${v3.previousProviderSections[1]}\n`;
    writeFileSync(configPath, legacyActive, { mode: 0o600 });
    writeFileSync(
      statePath,
      `${JSON.stringify({
        version: 2,
        mode: "provider-table",
        managedProvider: "custom",
        managedBaseUrl: v3.managedBaseUrl,
        previousProviderTablePresent: true,
        previousProviderTable: v3.previousProviderSections[0],
      }, null, 2)}\n`,
      { mode: 0o600 },
    );

    const updated = run("enable", codexHome, stateDir);
    assert.equal(updated.signed_routing, true);
    assert.doesNotMatch(readFileSync(configPath, "utf8"), /LEGACY_V2_QUERY_SECRET/);
    const upgraded = JSON.parse(readFileSync(statePath, "utf8"));
    assert.equal(upgraded.version, 3);
    assert.ok(
      upgraded.previousProviderSections.some((section) =>
        section.includes("LEGACY_V2_QUERY_SECRET")),
    );
  } finally {
    rmSync(codexHome, { recursive: true, force: true });
  }
});

test(
  "refresh-catalog restores signed routing instead of leaving the selected provider direct",
  { skip: process.platform === "win32" },
  () => {
    const codexHome = mkdtempSync(path.join(os.tmpdir(), "codex-router-signed-refresh-"));
    const stateDir = path.join(codexHome, "router-state");
    const configPath = path.join(codexHome, "config.toml");
    const codexStub = path.join(codexHome, "codex-stub");
    writeFileSync(
      configPath,
      `model_provider = "custom"

[model_providers.custom]
name = "CC Switch"
base_url = "https://example.invalid/v1"

[model_providers.custom.query_params]
api_key = "REFRESH_QUERY_SECRET"
`,
      { mode: 0o600 },
    );
    writeFileSync(
      codexStub,
      `#!/bin/sh
case "$1" in
  --version) echo 'codex-cli 99.0.0' ;;
  login) exit 0 ;;
  debug) echo '{"models":[{"slug":"gpt-5.6-sol","display_name":"GPT-5.6-Sol","visibility":"list","priority":10}]}' ;;
  *) exit 1 ;;
esac
`,
      { mode: 0o755 },
    );
    try {
      run("signed-enable", codexHome, stateDir);
      writeFileSync(
        path.join(stateDir, "enabled-providers.json"),
        `${JSON.stringify({ version: 1, providers: ["deepseek"] })}\n`,
        { mode: 0o600 },
      );
      writeFileSync(path.join(stateDir, "deepseek-api-key.secret"), "test-key\n", {
        mode: 0o600,
      });
      execFileSync(path.join(root, "bin", "refresh-catalog"), [], {
        cwd: root,
        encoding: "utf8",
        env: {
          ...process.env,
          CODEX_BIN: codexStub,
          CODEX_HOME: codexHome,
          CODEX_ROUTER_PORT: "46192",
          CODEX_ROUTER_STATE_DIR: stateDir,
          MODEL_ROUTER_STATE_DIR: stateDir,
          MODEL_ROUTER_TARGET: "codex",
        },
      });
      const status = run("status", codexHome, stateDir);
      assert.equal(status.signed_routing, true);
      assert.equal(status.model_provider, "custom");
      const active = readFileSync(configPath, "utf8");
      assert.doesNotMatch(active, /REFRESH_QUERY_SECRET/);
      assert.match(active, /codex-router-signed-provider-managed/);
      const catalog = JSON.parse(
        readFileSync(path.join(stateDir, "merged-models.json"), "utf8"),
      );
      assert.ok(catalog.models.some((model) => model.slug === "gpt-5.6-sol"));
      assert.ok(
        catalog.models.some((model) => model.slug === "deepseek/deepseek-v4-flash"),
      );
    } finally {
      rmSync(codexHome, { recursive: true, force: true });
    }
  },
);

test("signed routing restores an originally unset provider", () => {
  const codexHome = mkdtempSync(path.join(os.tmpdir(), "codex-router-signed-unset-"));
  const stateDir = path.join(codexHome, "router-state");
  const configPath = path.join(codexHome, "config.toml");
  writeFileSync(configPath, 'model = "gpt-5.6-sol"\n', { mode: 0o600 });
  try {
    run("signed-enable", codexHome, stateDir);
    assert.doesNotMatch(readFileSync(configPath, "utf8"), /^model_provider\s*=/m);
    run("signed-disable", codexHome, stateDir);
    assert.doesNotMatch(readFileSync(configPath, "utf8"), /^model_provider\s*=/m);
  } finally {
    rmSync(codexHome, { recursive: true, force: true });
  }
});

test("signed routing refuses to overwrite provider-table ownership drift", () => {
  const codexHome = mkdtempSync(path.join(os.tmpdir(), "codex-router-signed-drift-"));
  const stateDir = path.join(codexHome, "router-state");
  const configPath = path.join(codexHome, "config.toml");
  writeFileSync(
    configPath,
    `model_provider = "custom"

[model_providers.custom]
name = "CC Switch"
wire_api = "responses"
`,
    { mode: 0o600 },
  );
  try {
    run("signed-enable", codexHome, stateDir);
    const drifted = readFileSync(configPath, "utf8").replace(
      /^base_url = ".*"$/m,
      'base_url = "https://changed.invalid/v1"',
    );
    writeFileSync(configPath, drifted, { mode: 0o600 });
    assert.throws(
      () => run("signed-disable", codexHome, stateDir),
      /lost ownership|Refusing to replace/i,
    );
    assert.match(readFileSync(configPath, "utf8"), /changed\.invalid/);
  } finally {
    rmSync(codexHome, { recursive: true, force: true });
  }
});

test("config manager keeps user tables parked inside the managed provider block", () => {
  const codexHome = mkdtempSync(path.join(os.tmpdir(), "codex-router-config-"));
  const configPath = path.join(codexHome, "config.toml");
  writeFileSync(configPath, 'model = "gpt-5.6-sol"\nmodel_provider = "openai"\n', {
    mode: 0o644,
  });

  try {
    run("enable", codexHome);

    // The desktop app rewrites config.toml wholesale and can park user tables
    // between the managed provider table and the end marker.
    const parked = readFileSync(configPath, "utf8").replace(
      "# END codex-router-provider-managed",
      `[desktop]
localeOverride = "zh-CN"
followUpQueueMode = "queue"

[desktop.appearanceLightChromeTheme]
accent = "#4e96d1"

# END codex-router-provider-managed`,
    );
    assert.notEqual(parked, readFileSync(configPath, "utf8"));
    writeFileSync(configPath, parked, { mode: 0o600 });

    const reenabled = run("enable", codexHome);
    assert.equal(reenabled.mode, "router");
    const refreshed = readFileSync(configPath, "utf8");
    assert.match(refreshed, /\[desktop\]/);
    assert.match(refreshed, /localeOverride = "zh-CN"/);
    assert.match(refreshed, /\[desktop\.appearanceLightChromeTheme\]/);
    assert.match(refreshed, /accent = "#4e96d1"/);
    // The hoisted table must sit outside the managed block.
    const providerBlock = refreshed.match(
      /# BEGIN codex-router-provider-managed\n[\s\S]*?\n# END codex-router-provider-managed/,
    );
    assert.ok(providerBlock);
    assert.doesNotMatch(providerBlock[0], /\[desktop\]/);

    const disabled = run("disable", codexHome);
    assert.equal(disabled.mode, "native");
    const restored = readFileSync(configPath, "utf8");
    assert.doesNotMatch(restored, /codex-router-provider-managed/);
    assert.match(restored, /\[desktop\]/);
    assert.match(restored, /localeOverride = "zh-CN"/);
    assert.match(restored, /accent = "#4e96d1"/);
  } finally {
    rmSync(codexHome, { recursive: true, force: true });
  }
});

test("a header-looking line inside a parked multiline string does not split the hoist", () => {
  const codexHome = mkdtempSync(path.join(os.tmpdir(), "codex-router-config-"));
  const configPath = path.join(codexHome, "config.toml");
  writeFileSync(configPath, 'model = "gpt-5.6-sol"\nmodel_provider = "openai"\n', {
    mode: 0o644,
  });

  try {
    run("enable", codexHome);

    // A parked table can hold a multiline string whose content looks like a
    // TOML header. A `[`-prefix line scan would split the string there and
    // corrupt the hoisted table; the real scanner must carry it out whole.
    const parked = readFileSync(configPath, "utf8").replace(
      "# END codex-router-provider-managed",
      `[desktop]
notes = """
[not_a_table]
still the same string
"""
accent = "#4e96d1"

# END codex-router-provider-managed`,
    );
    writeFileSync(configPath, parked, { mode: 0o600 });

    const reenabled = run("enable", codexHome);
    assert.equal(reenabled.mode, "router");
    const refreshed = readFileSync(configPath, "utf8");
    // The whole table survived as one piece: header, multiline string with its
    // header-looking content, and the key that followed the string.
    assert.match(
      refreshed,
      /\[desktop\]\nnotes = """\n\[not_a_table\]\nstill the same string\n"""\naccent = "#4e96d1"/,
    );
    // The string content was not promoted to a real table anywhere.
    assert.equal(
      refreshed.indexOf("[not_a_table]"),
      refreshed.lastIndexOf("[not_a_table]"),
      "the header-looking line appears once, inside the string",
    );
  } finally {
    rmSync(codexHome, { recursive: true, force: true });
  }
});
