import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const testRoot = mkdtempSync(path.join(os.tmpdir(), "codex-router-support-"));
process.env.CODEX_HOME = path.join(testRoot, "codex");
process.env.CODEX_ROUTER_STATE_DIR = path.join(testRoot, "state");
process.env.KIMI_CODE_HOME = path.join(testRoot, "kimi-code");
process.env.CODEX_ROUTER_SERVICE_PLATFORM = "linux";
process.env.CODEX_ROUTER_LAUNCH_AGENTS_DIR = path.join(testRoot, "LaunchAgents");
process.env.CODEX_ROUTER_SKIP_LAUNCHCTL = "1";
process.env.XDG_CONFIG_HOME = path.join(testRoot, "xdg");
delete process.env.DEEPSEEK_API_KEY;
delete process.env.KIMI_API_KEY;
delete process.env.MOONSHOT_API_KEY;

const { createSupportBundle } = await import("../src/support-bundle.mjs");

test("support bundle reports credential presence without including values", () => {
  const stateDir = process.env.CODEX_ROUTER_STATE_DIR;
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const sentinel = "TEST_SUPPORT_BUNDLE_SECRET_MUST_NOT_APPEAR";
  const callerSentinel =
    "TEST_SUPPORT_CALLER_CAPABILITY_MUST_NOT_APPEAR_ANYWHERE";
  writeFileSync(path.join(stateDir, "deepseek-api-key.secret"), `${sentinel}\n`, {
    mode: 0o600,
  });
  writeFileSync(path.join(stateDir, "caller-secret"), `${callerSentinel}\n`, {
    mode: 0o600,
  });
  writeFileSync(
    path.join(stateDir, "enabled-providers.json"),
    `${JSON.stringify({ version: 1, providers: ["deepseek"] })}\n`,
    { mode: 0o600 },
  );
  const codexHome = process.env.CODEX_HOME;
  mkdirSync(codexHome, { recursive: true, mode: 0o700 });
  writeFileSync(
    path.join(codexHome, "config.toml"),
    `# BEGIN codex-router-managed
openai_base_url = "http://127.0.0.1:4102/_codex-router/${callerSentinel}/v1"
model_catalog_json = ${JSON.stringify(path.join(stateDir, "merged-models.json"))}
# END codex-router-managed
`,
    { mode: 0o600 },
  );

  try {
    const result = createSupportBundle();
    const contents = readFileSync(result.path, "utf8");
    const bundle = JSON.parse(contents);
    assert.equal(bundle.credentialSources.deepseek.configured, true);
    assert.doesNotMatch(contents, new RegExp(sentinel));
    assert.doesNotMatch(contents, new RegExp(callerSentinel));
    assert.match(bundle.config.openai_base_url, /\[REDACTED\]/);
    assert.equal("redactedLogTail" in bundle, false);
  } finally {
    rmSync(testRoot, { recursive: true, force: true });
  }
});
