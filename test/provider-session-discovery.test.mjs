import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const root = mkdtempSync(path.join(os.tmpdir(), "provider-session-discovery-"));
process.env.MODEL_ROUTER_STATE_DIR = path.join(root, "state");
process.env.CODEX_ROUTER_STATE_DIR = process.env.MODEL_ROUTER_STATE_DIR;
process.env.KIMI_CODE_HOME = path.join(root, "kimi");
process.env.GROK_AUTH_PATH = path.join(root, "grok.json");
process.env.CODEX_ROUTER_NO_DISCOVERY = "0";
mkdirSync(path.join(process.env.KIMI_CODE_HOME, "credentials"), { recursive: true });
writeFileSync(path.join(process.env.KIMI_CODE_HOME, "credentials", "kimi-code.json"), JSON.stringify({
  access_token: "FAKE_KIMI_ACCESS", refresh_token: "FAKE_KIMI_REFRESH", expires_in: 3600,
  expires_at: Math.floor(Date.now() / 1000) + 3600,
}));
writeFileSync(path.join(process.env.KIMI_CODE_HOME, "device_id"), "FAKE_DEVICE");
writeFileSync(process.env.GROK_AUTH_PATH, JSON.stringify({ "https://auth.x.ai::fixture": { key: "FAKE_GROK_ACCESS" } }));
const { readKimiOAuthToken, kimiIdentityHeaders, ensureFreshKimiOAuthToken } = await import("../src/kimi-oauth-session.mjs");
const { ensureFreshGrokOAuthToken, refreshWithOfficialCli } = await import("../src/grok-oauth-session.mjs");
const { readDevinSession } = await import("../src/devin-cli-session.mjs");
test.after(() => rmSync(root, { recursive: true, force: true }));

test("direct session readers stop before returning a credential or launching a refresh", async () => {
  assert.equal(readKimiOAuthToken().access_token, "FAKE_KIMI_ACCESS");
  assert.equal(await ensureFreshGrokOAuthToken(), "FAKE_GROK_ACCESS");
  process.env.CODEX_ROUTER_NO_DISCOVERY = "1";
  try {
    assert.throws(readKimiOAuthToken, /discovery is disabled/);
    assert.throws(kimiIdentityHeaders, /discovery is disabled/);
    assert.throws(() => readDevinSession({ credentialsPath: path.join(root, "never-open") }), /discovery is disabled/);
    await assert.rejects(ensureFreshKimiOAuthToken(), /discovery is disabled/);
    await assert.rejects(ensureFreshGrokOAuthToken(), /discovery is disabled/);
    await assert.rejects(refreshWithOfficialCli({ spawnImpl() { assert.fail("must not spawn"); } }), /discovery is disabled/);
  } finally {
    process.env.CODEX_ROUTER_NO_DISCOVERY = "0";
  }
});
