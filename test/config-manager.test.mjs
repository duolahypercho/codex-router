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

function run(command, codexHome, stateDir = path.join(codexHome, "router-state")) {
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const callerSecretPath = path.join(stateDir, "caller-secret");
  if (!existsSync(callerSecretPath)) {
    writeFileSync(callerSecretPath, `${CALLER_KEY}\n`, { mode: 0o600 });
  }
  return JSON.parse(
    execFileSync(process.execPath, [manager, command], {
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
    assert.doesNotMatch(restored, /codex-router-managed|openai_base_url|model_catalog_json/);
    assert.match(restored, /model = "gpt-5\.6-sol"/);
    assert.match(restored, /model_provider = "openai"/);
    assert.match(restored, /model_reasoning_effort = "xhigh"/);
    assert.match(restored, /\[profiles\.work\]/);
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
