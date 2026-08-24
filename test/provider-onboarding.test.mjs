import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { oauthLoginArgs } from "../src/provider-onboarding.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("Grok tray sign-in explicitly starts the OAuth flow", () => {
  assert.deepEqual(oauthLoginArgs("grok-oauth"), ["login", "--oauth"]);
  assert.deepEqual(oauthLoginArgs("kimi-oauth"), ["login"]);
});

function isolatedPath() {
  if (process.platform !== "win32") return "/usr/bin:/bin";
  const windowsRoot = process.env.SystemRoot ?? process.env.WINDIR;
  assert.ok(windowsRoot, "Windows system root is required for isolated provider tests");
  return [
    path.join(windowsRoot, "System32"),
    path.join(windowsRoot, "System32", "WindowsPowerShell", "v1.0"),
  ].join(path.delimiter);
}

function isolatedEnvironment(testRoot) {
  return {
    ...process.env,
    HOME: testRoot,
    PATH: isolatedPath(),
    // Onboarding falls back to npm's own global bin directory when PATH and
    // the guessed locations come up empty, so an isolated home is not enough
    // on a machine that really does have these CLIs installed.
    npm_config_prefix: path.join(testRoot, "npm-global"),
    MODEL_ROUTER_TARGET: "codex",
    MODEL_ROUTER_STATE_DIR: path.join(testRoot, "state"),
    KIMI_CODE_HOME: path.join(testRoot, "kimi"),
    GROK_HOME: path.join(testRoot, "grok-home"),
    GROK_AUTH_PATH: path.join(testRoot, "grok", "auth.json"),
    KIMI_API_KEY: "",
    MOONSHOT_API_KEY: "",
    DEEPSEEK_API_KEY: "",
    MINIMAX_API_KEY: "",
    MINIMAX_TOKEN_PLAN_API_KEY: "",
    XAI_API_KEY: "",
    GROK_API_KEY: "",
    ANTHROPIC_API_KEY: "",
    COPILOT_GITHUB_TOKEN: "",
    GH_TOKEN: "",
    GITHUB_TOKEN: "",
    CLINE_API_KEY: "",
    CHUTES_API_KEY: "",
    OPENCODE_API_KEY: "",
    OPENCODE_GO_API_KEY: "",
  };
}

function seedCatalogCache(stateDir) {
  mkdirSync(stateDir, { recursive: true });
  const identityFingerprint = "a".repeat(64);
  const catalogEntry = (providerId, discovered) => ({
    discovered,
    fetchedAt: new Date().toISOString(),
    identityFingerprint,
    provenance: {
      schema: "codex-router/provider-catalog/v1",
      providerId,
      endpoint: `https://${providerId}.example.test/models`,
      identityFingerprint,
    },
  });
  writeFileSync(path.join(stateDir, "provider-catalog-cache.json"), JSON.stringify({
    version: 2,
    providers: {
      "opencode-go": catalogEntry("opencode-go", ["go-old-account"]),
      "opencode-zen": catalogEntry("opencode-zen", ["zen-old-account"]),
      deepseek: catalogEntry("deepseek", ["keep-me"]),
    },
  }));
}

function cachedProviders(stateDir) {
  return JSON.parse(
    readFileSync(path.join(stateDir, "provider-catalog-cache.json"), "utf8"),
  ).providers;
}

test("provider onboarding reports install, login, and API key actions without secrets", () => {
  const testRoot = mkdtempSync(path.join(os.tmpdir(), "provider-onboarding-"));
  try {
    const output = execFileSync(
      process.execPath,
      [path.join(root, "src", "control.mjs"), "providers", "--json"],
      { cwd: root, encoding: "utf8", env: isolatedEnvironment(testRoot) },
    );
    const snapshot = JSON.parse(output);
    const byId = Object.fromEntries(snapshot.providers.map((provider) => [provider.id, provider]));

    assert.equal(byId["kimi-oauth"].action, "install");
    assert.equal(byId["grok-oauth"].action, "install");
    assert.equal(byId["kimi-api"].action, "add-key");
    assert.equal(byId["grok-api"].action, "add-key");
    assert.equal(byId["anthropic-api"].action, "add-key");
    assert.equal(byId["minimax-token-plan"].action, "add-key");
    assert.equal(byId.commandcode.action, "add-key");
    assert.equal("signIn" in byId.commandcode, false);
    assert.equal(byId["github-copilot"].action, "add-key");
    assert.equal(byId["github-copilot"].credentialLabel, "GitHub token");
    assert.equal("credentialLabel" in byId["deepseek"], false);
    assert.equal(byId.clinepass.action, "add-key");
    assert.equal(byId.chutes.action, "add-key");
    for (const id of ["opencode-free", "kilo-free"]) {
      assert.equal(byId[id].kind, "anonymous");
      assert.equal(byId[id].configured, true);
      assert.equal(byId[id].action, "anonymous");
      assert.equal(byId[id].credentialLabel, "No API key");
      assert.match(byId[id].anonymousNote, /No API key/);
    }
    // A per-model-endpoint container must never offer a key field: a secret
    // stored against it would be read by nothing.
    assert.equal(byId.custom.kind, "per-model");
    assert.equal(byId.custom.configured, true);
    assert.equal(byId.custom.action, "per-model");
    assert.equal(byId.custom.credentialLabel, "Per-model endpoints");
    assert.match(byId.custom.perModelNote, /own endpoint/);
    assert.equal("source" in byId["kimi-api"], false);
  } finally {
    rmSync(testRoot, { recursive: true, force: true });
  }
});

test("control accepts an API key only through stdin and stores it privately", () => {
  const testRoot = mkdtempSync(path.join(os.tmpdir(), "provider-key-control-"));
  const testKey = "TEST_TRAY_XAI_KEY";
  try {
    const result = spawnSync(
      process.execPath,
      [path.join(root, "src", "control.mjs"), "credential", "grok-api"],
      {
        cwd: root,
        encoding: "utf8",
        env: isolatedEnvironment(testRoot),
        input: `${testKey}\n`,
      },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.doesNotMatch(result.stdout, new RegExp(testKey));
    assert.equal(
      readFileSync(path.join(testRoot, "state", "xai-api-key.secret"), "utf8").trim(),
      testKey,
    );
  } finally {
    rmSync(testRoot, { recursive: true, force: true });
  }
});

test("control clears every catalog source when a shared credential changes", () => {
  const testRoot = mkdtempSync(path.join(os.tmpdir(), "provider-family-cache-control-"));
  const environment = isolatedEnvironment(testRoot);
  const stateDir = environment.MODEL_ROUTER_STATE_DIR;
  try {
    seedCatalogCache(stateDir);
    const saved = spawnSync(
      process.execPath,
      [path.join(root, "src", "control.mjs"), "credential", "opencode-go"],
      { cwd: root, encoding: "utf8", env: environment, input: "TEST_OPENCODE_KEY\n" },
    );
    assert.equal(saved.status, 0, saved.stderr);
    assert.equal(cachedProviders(stateDir)["opencode-go"], undefined);
    assert.equal(cachedProviders(stateDir)["opencode-zen"], undefined);
    assert.deepEqual(cachedProviders(stateDir).deepseek.discovered, ["keep-me"]);

    seedCatalogCache(stateDir);
    const removed = spawnSync(
      process.execPath,
      [path.join(root, "src", "control.mjs"), "credential", "opencode-go", "--remove"],
      { cwd: root, encoding: "utf8", env: environment },
    );
    assert.equal(removed.status, 0, removed.stderr);
    assert.equal(cachedProviders(stateDir)["opencode-go"], undefined);
    assert.equal(cachedProviders(stateDir)["opencode-zen"], undefined);
    assert.deepEqual(cachedProviders(stateDir).deepseek.discovered, ["keep-me"]);
  } finally {
    rmSync(testRoot, { recursive: true, force: true });
  }
});

test("control removes a stored API key and disables the provider", () => {
  const testRoot = mkdtempSync(path.join(os.tmpdir(), "provider-key-remove-"));
  const environment = isolatedEnvironment(testRoot);
  const keyPath = path.join(testRoot, "state", "xai-api-key.secret");
  try {
    execFileSync(
      process.execPath,
      [path.join(root, "src", "control.mjs"), "credential", "grok-api"],
      { cwd: root, encoding: "utf8", env: environment, input: "TEST_TRAY_XAI_KEY\n" },
    );
    assert.equal(existsSync(keyPath), true);

    const result = spawnSync(
      process.execPath,
      [path.join(root, "src", "control.mjs"), "credential", "grok-api", "--remove"],
      { cwd: root, encoding: "utf8", env: environment },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.equal(existsSync(keyPath), false);

    const snapshot = JSON.parse(result.stdout);
    assert.equal(snapshot.removal.removedFiles, 1);
    assert.equal(snapshot.removal.stillConfigured, false);
    const byId = Object.fromEntries(snapshot.providers.map((provider) => [provider.id, provider]));
    assert.equal(byId["grok-api"].configured, false);
    assert.equal(byId["grok-api"].action, "add-key");

    const selection = JSON.parse(
      readFileSync(path.join(testRoot, "state", "enabled-providers.json"), "utf8"),
    );
    assert.equal(selection.providers.includes("grok-api"), false);
  } finally {
    rmSync(testRoot, { recursive: true, force: true });
  }
});

test("removing an absent API key reports no change instead of failing", () => {
  const testRoot = mkdtempSync(path.join(os.tmpdir(), "provider-key-remove-absent-"));
  try {
    const result = spawnSync(
      process.execPath,
      [path.join(root, "src", "control.mjs"), "credential", "deepseek", "--remove"],
      { cwd: root, encoding: "utf8", env: isolatedEnvironment(testRoot) },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).removal.removedFiles, 0);
  } finally {
    rmSync(testRoot, { recursive: true, force: true });
  }
});

test("provider-key remove awaits removal and reports the deleted credential", () => {
  const testRoot = mkdtempSync(path.join(os.tmpdir(), "provider-key-await-remove-"));
  const stateDir = path.join(testRoot, "state");
  const keyPath = path.join(stateDir, "deepseek-api-key.secret");
  try {
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(keyPath, "test-provider-key\n", { mode: 0o600 });
    const result = spawnSync(
      process.execPath,
      [path.join(root, "src", "provider-key.mjs"), "deepseek", "remove"],
      { cwd: root, encoding: "utf8", env: isolatedEnvironment(testRoot) },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.equal(existsSync(keyPath), false);
    assert.match(result.stdout, /Removed 1 managed DeepSeek API key file/);
    assert.doesNotMatch(result.stdout, /No managed DeepSeek API key file exists/);
  } finally {
    rmSync(testRoot, { recursive: true, force: true });
  }
});

test("provider-key remove clears every catalog source sharing the credential", () => {
  const testRoot = mkdtempSync(path.join(os.tmpdir(), "provider-family-cache-cli-"));
  const environment = isolatedEnvironment(testRoot);
  const stateDir = environment.MODEL_ROUTER_STATE_DIR;
  const keyPath = path.join(stateDir, "opencode-go-api-key.secret");
  try {
    seedCatalogCache(stateDir);
    writeFileSync(keyPath, "test-provider-key\n", { mode: 0o600 });
    const result = spawnSync(
      process.execPath,
      [path.join(root, "src", "provider-key.mjs"), "opencode-go", "remove"],
      { cwd: root, encoding: "utf8", env: environment },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.equal(existsSync(keyPath), false);
    assert.equal(cachedProviders(stateDir)["opencode-go"], undefined);
    assert.equal(cachedProviders(stateDir)["opencode-zen"], undefined);
    assert.deepEqual(cachedProviders(stateDir).deepseek.discovered, ["keep-me"]);
  } finally {
    rmSync(testRoot, { recursive: true, force: true });
  }
});
