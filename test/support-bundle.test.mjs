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
delete process.env.CHUTES_API_KEY;
delete process.env.KIMI_API_KEY;
delete process.env.MOONSHOT_API_KEY;

const { createSupportBundle } = await import("../src/support-bundle.mjs");
const { LOG_PATH } = await import("../src/paths.mjs");

test("support bundle reports credential presence without including values", () => {
  const stateDir = process.env.CODEX_ROUTER_STATE_DIR;
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const sentinel = "TEST_SUPPORT_BUNDLE_SECRET_MUST_NOT_APPEAR";
  const chutesSentinel = "TEST_SUPPORT_CHUTES_SECRET_MUST_NOT_APPEAR";
  const copilotSentinel = "github_pat_TEST_SUPPORT_COPILOT_SECRET_MUST_NOT_APPEAR";
  const callerSentinel =
    "TEST_SUPPORT_CALLER_CAPABILITY_MUST_NOT_APPEAR_ANYWHERE";
  const oauthAccessSentinel = "TEST_SUPPORT_ANTIGRAVITY_ACCESS_MUST_NOT_APPEAR";
  const oauthRefreshSentinel = "TEST_SUPPORT_ANTIGRAVITY_REFRESH_MUST_NOT_APPEAR";
  writeFileSync(path.join(stateDir, "deepseek-api-key.secret"), `${sentinel}\n`, {
    mode: 0o600,
  });
  writeFileSync(path.join(stateDir, "chutes-api-key.secret"), `${chutesSentinel}\n`, {
    mode: 0o600,
  });
  writeFileSync(path.join(stateDir, "github-copilot-token.secret"), `${copilotSentinel}\n`, {
    mode: 0o600,
  });
  writeFileSync(path.join(stateDir, "caller-secret"), `${callerSentinel}\n`, {
    mode: 0o600,
  });
  writeFileSync(
    path.join(stateDir, "antigravity-oauth.json"),
    `${JSON.stringify({
      version: 1,
      access_token: oauthAccessSentinel,
      refresh_token: oauthRefreshSentinel,
      expires_at: 2_000_000_000,
      expires_in: 3600,
    })}\n`,
    { mode: 0o600 },
  );
  writeFileSync(LOG_PATH, `oauth ${oauthAccessSentinel} refresh ${oauthRefreshSentinel}\n`, {
    mode: 0o600,
  });
  writeFileSync(
    path.join(stateDir, "enabled-providers.json"),
    `${JSON.stringify({ version: 1, providers: ["chutes", "deepseek"] })}\n`,
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
    const result = createSupportBundle({ includeLogs: true });
    const contents = readFileSync(result.path, "utf8");
    const bundle = JSON.parse(contents);
    assert.equal(bundle.credentialSources.deepseek.configured, true);
    assert.equal(bundle.credentialSources.chutes.configured, true);
    assert.equal(bundle.credentialSources["github-copilot"].configured, true);
    assert.doesNotMatch(contents, new RegExp(sentinel));
    assert.doesNotMatch(contents, new RegExp(chutesSentinel));
    assert.doesNotMatch(contents, new RegExp(copilotSentinel));
    assert.doesNotMatch(contents, new RegExp(callerSentinel));
    assert.doesNotMatch(contents, new RegExp(oauthAccessSentinel));
    assert.doesNotMatch(contents, new RegExp(oauthRefreshSentinel));
    assert.match(bundle.config.openai_base_url, /\[REDACTED\]/);
    assert.match(bundle.redactedLogTail, /\[REDACTED\]/);
  } finally {
    rmSync(testRoot, { recursive: true, force: true });
  }
});
