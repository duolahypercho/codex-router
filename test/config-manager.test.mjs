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

function run(
  command,
  codexHome,
  stateDir = path.join(codexHome, "router-state"),
  commandArgs = [],
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
        CODEX_HOME: codexHome,
        CODEX_ROUTER_STATE_DIR: stateDir,
        CODEX_ROUTER_PORT: "46192",
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
    assert.match(configured, /\[model_providers\.codex-router\]/);
    assert.match(configured, /wire_api = "responses"/);
    assert.ok(
      configured.includes(
        `openai_base_url = "http://127.0.0.1:46192/_codex-router/${CALLER_KEY}/v1"`,
      ),
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
      /codex-router-(?:provider-)?managed|openai_base_url|model_catalog_json/,
    );
    assert.match(restored, /model = "gpt-5\.6-sol"/);
    assert.match(restored, /model_provider = "openai"/);
    assert.match(restored, /model_reasoning_effort = "xhigh"/);
    assert.match(restored, /\[profiles\.work\]/);
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
