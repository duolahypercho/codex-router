import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function fixture(t) {
  const directory = mkdtempSync(path.join(os.tmpdir(), "copilot-control-"));
  const stateDir = path.join(directory, "state");
  const codexHome = path.join(directory, "codex");
  mkdirSync(stateDir, { mode: 0o700 });
  mkdirSync(codexHome, { mode: 0o700 });
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const env = {
    ...process.env,
    MODEL_ROUTER_TARGET: "codex",
    MODEL_ROUTER_STATE_DIR: stateDir,
    CODEX_HOME: codexHome,
  };
  const run = (...args) => spawnSync(process.execPath,
    [path.join(root, "src/control.mjs"), "github-copilot", "host", ...args],
    { cwd: root, env, encoding: "utf8", timeout: 30_000 });
  const success = (...args) => {
    const result = run(...args);
    assert.equal(result.status, 0, result.stderr || result.error?.message);
    assert.ok(!result.stdout.includes("private-test-token"));
    const status = JSON.parse(result.stdout);
    assert.deepEqual(Object.keys(status).sort(), ["host", "source"]);
    return status;
  };
  return { stateDir, codexHome, run, success };
}

function catalogEntry(providerId) {
  const identityFingerprint = "a".repeat(64);
  return {
    identityFingerprint,
    fetchedAt: "2026-01-01T00:00:00.000Z",
    discovered: ["synthetic-model"],
    provenance: {
      schema: "codex-router/provider-catalog/v1",
      providerId,
      endpoint: "https://api.example.com/v1/models",
      identityFingerprint,
    },
  };
}

test("Copilot host CLI persists across processes and clears to public GitHub", (t) => {
  const { stateDir, codexHome, success } = fixture(t);
  const preserved = [
    [stateDir, "provider-credentials.json", '{"synthetic-token":"private-test-token"}\n'],
    [stateDir, "provider-api-key-pools.json", '{"synthetic-pool":true}\n'],
    [stateDir, "enabled-providers.json", '{"version":1,"providers":["github-copilot"]}\n'],
    [stateDir, "user-models.json", '{"curated-model":"synthetic-model"}\n'],
    [stateDir, "merged-models.json", '{"installed-picker":true}\n'],
    [codexHome, "config.toml", 'model = "synthetic-model"\n'],
  ];
  for (const [directory, name, content] of preserved) {
    writeFileSync(path.join(directory, name), content, { mode: 0o600 });
  }
  const cachePath = path.join(stateDir, "provider-catalog-cache.json");
  const unrelated = catalogEntry("deepseek");
  const seedCache = () => writeFileSync(cachePath, JSON.stringify({
    version: 2,
    providers: { "github-copilot": catalogEntry("github-copilot"), deepseek: unrelated },
  }), { mode: 0o600 });
  const assertScopedInvalidation = () => {
    const cache = JSON.parse(readFileSync(cachePath, "utf8"));
    assert.deepEqual(cache.providers, { deepseek: unrelated });
    for (const [directory, name, content] of preserved) {
      assert.equal(readFileSync(path.join(directory, name), "utf8"), content, name);
    }
  };
  assert.equal(success("status").host, "github.com");
  seedCache();
  assert.equal(success("set", "octocorp.ghe.com").host, "octocorp.ghe.com");
  assert.equal(success("status").host, "octocorp.ghe.com");
  assertScopedInvalidation();
  seedCache();
  assert.equal(success("clear").host, "github.com");
  assert.equal(success("status").host, "github.com");
  assertScopedInvalidation();
});

test("invalid Copilot host input and corrupt-state status preserve files", (t) => {
  const { stateDir, run, success } = fixture(t);
  success("set", "octocorp.ghe.com");
  const settingsPath = path.join(stateDir, "github-copilot-settings.json");
  const cachePath = path.join(stateDir, "provider-catalog-cache.json");
  writeFileSync(cachePath, JSON.stringify({ version: 2, providers: {
    "github-copilot": catalogEntry("github-copilot"),
    deepseek: catalogEntry("deepseek"),
  } }), { mode: 0o600 });
  const settings = readFileSync(settingsPath, "utf8");
  const cache = readFileSync(cachePath, "utf8");
  for (const args of [
    ["set", "self-hosted.example.com"],
    ["set", "https://octocorp.ghe.com"],
    ["set", "nested.octocorp.ghe.com"],
    ["set"], ["clear", "extra"], ["status", "extra"],
  ]) {
    const result = run(...args);
    assert.notEqual(result.status, 0, JSON.stringify(args));
    assert.equal(readFileSync(settingsPath, "utf8"), settings);
    assert.equal(readFileSync(cachePath, "utf8"), cache);
  }
  writeFileSync(settingsPath, "{invalid-json", { mode: 0o600 });
  const result = run("status");
  assert.notEqual(result.status, 0);
  assert.equal(readFileSync(settingsPath, "utf8"), "{invalid-json");
  assert.equal(readFileSync(cachePath, "utf8"), cache);
  assert.ok(!result.stdout.includes("private-test-token"));
});


test("Copilot host change preserves settings when catalog invalidation fails", (t) => {
  const { stateDir, run, success } = fixture(t);
  success("set", "octocorp.ghe.com");
  const settingsPath = path.join(stateDir, "github-copilot-settings.json");
  const settings = readFileSync(settingsPath, "utf8");
  mkdirSync(path.join(stateDir, "provider-catalog-cache.json"));
  for (const args of [["set", "othercorp.ghe.com"], ["clear"]]) {
    const result = run(...args);
    assert.notEqual(result.status, 0, JSON.stringify(args));
    assert.equal(readFileSync(settingsPath, "utf8"), settings);
    assert.equal(success("status").host, "octocorp.ghe.com");
  }
});
