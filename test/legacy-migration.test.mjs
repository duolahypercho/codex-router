import assert from "node:assert/strict";
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

const testRoot = mkdtempSync(path.join(os.tmpdir(), "codex-router-migration-"));
const codexHome = path.join(testRoot, "codex");
const launchAgents = path.join(testRoot, "LaunchAgents");
const stateDir = path.join(codexHome, "codex-router");
process.env.CODEX_HOME = codexHome;
process.env.CODEX_ROUTER_STATE_DIR = stateDir;
process.env.CODEX_ROUTER_PORT = "46192";
process.env.CODEX_ROUTER_LAUNCH_AGENTS_DIR = launchAgents;
process.env.CODEX_ROUTER_SKIP_LAUNCHCTL = "1";

const {
  applyKnownMigrations,
  detectLegacyInstallations,
  rollbackLatestMigration,
} = await import("../src/legacy-migration.mjs");
const { privateFileIsProtected } = await import("../src/file-security.mjs");

test("known prototype migration snapshots, cleans, and restores exact state", () => {
  mkdirSync(codexHome, { recursive: true });
  mkdirSync(launchAgents, { recursive: true });
  const configPath = path.join(codexHome, "config.toml");
  const plistPath = path.join(launchAgents, "com.ziwenxu.kimi-codex-proxy.plist");
  const prototypeCatalog = path.join(codexHome, "kimi-proxy", "merged-models.json");
  const original = `model = "kimi-oauth/k3"

# BEGIN kimi-codex-router-managed
openai_base_url = "http://127.0.0.1:46192/v1"
model_catalog_json = "${prototypeCatalog}"

[profiles.work]
model_reasoning_effort = "xhigh"
`;
  writeFileSync(configPath, original, { mode: 0o600 });
  writeFileSync(plistPath, "prototype plist\n", { mode: 0o644 });

  try {
    const detected = detectLegacyInstallations();
    assert.deepEqual(detected.installations.map((item) => item.id), ["kimi-proxy-prototype"]);
    assert.equal(detected.unknownConflict, false);

    const migration = applyKnownMigrations();
    assert.equal(migration.migrated, true);
    assert.equal(existsSync(plistPath), false);
    assert.equal(privateFileIsProtected(migration.manifestPath), true);
    const cleaned = readFileSync(configPath, "utf8");
    assert.doesNotMatch(cleaned, /openai_base_url|model_catalog_json|kimi-codex-router-managed/);
    assert.match(cleaned, /model = "kimi-oauth\/k3"/);
    assert.match(cleaned, /\[profiles\.work\]/);

    rollbackLatestMigration();
    assert.equal(readFileSync(configPath, "utf8"), original);
    assert.equal(readFileSync(plistPath, "utf8"), "prototype plist\n");
  } finally {
    rmSync(testRoot, { recursive: true, force: true });
  }
});
