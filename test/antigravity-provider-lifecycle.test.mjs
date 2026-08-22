import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const root = mkdtempSync(path.join(os.tmpdir(), "antigravity-provider-lifecycle-"));
process.env.CODEX_HOME = path.join(root, "codex");
process.env.CODEX_ROUTER_STATE_DIR = path.join(root, "state");
process.env.MODEL_ROUTER_USER_MODELS = path.join(root, "state", "user-models.json");

const {
  antigravityTokenPath,
  saveAntigravityToken,
} = await import("../src/antigravity-oauth-session.mjs");
const {
  providerOnboardingSnapshot,
  removeApiCredential,
} = await import("../src/provider-onboarding.mjs");
const { antigravityOAuthHealth } = await import("../src/antigravity-oauth-status.mjs");
const {
  enableProvider,
  readProviderSelection,
} = await import("../src/provider-selection.mjs");

test("router-managed Antigravity disconnect removes its token and selection", async () => {
  try {
    await saveAntigravityToken({
      access_token: "access-token",
      refresh_token: "refresh-token",
      expires_at: 2_000_000_000,
      expires_in: 3600,
      project_id: "managed-project",
      project_source: "managed",
    });
    enableProvider("antigravity-oauth");
    assert.ok(readProviderSelection().includes("antigravity-oauth"));
    assert.equal(antigravityOAuthHealth().status, "ok");

    const removal = await removeApiCredential("antigravity-oauth");

    assert.equal(removal.removedFiles, 1);
    assert.equal(removal.stillConfigured, false);
    assert.equal(existsSync(antigravityTokenPath()), false);
    assert.equal(readProviderSelection().includes("antigravity-oauth"), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a rejected Antigravity session remains disconnectable and is withdrawn", async () => {
  try {
    const tokenPath = antigravityTokenPath();
    mkdirSync(path.dirname(tokenPath), { recursive: true });
    writeFileSync(tokenPath, `${JSON.stringify({
      access_token: "",
      refresh_token: "",
      expires_at: 0,
      expires_in: 0,
      revoked_at: 2_000_000_000,
    })}\n`, { mode: 0o600 });
    enableProvider("antigravity-oauth");

    const provider = providerOnboardingSnapshot().providers.find(
      (entry) => entry.id === "antigravity-oauth",
    );
    assert.equal(provider?.configured, false);
    assert.equal(provider?.disconnectable, true);
    assert.equal(provider?.credentialLabel, "OAuth session");
    assert.ok(readProviderSelection().includes("antigravity-oauth"));
    assert.equal(antigravityOAuthHealth().status, "revoked");

    const removal = await removeApiCredential("antigravity-oauth");

    assert.equal(removal.removedFiles, 1);
    assert.equal(removal.stillConfigured, false);
    assert.equal(existsSync(tokenPath), false);
    assert.equal(readProviderSelection().includes("antigravity-oauth"), false);
    const disconnected = providerOnboardingSnapshot().providers.find(
      (entry) => entry.id === "antigravity-oauth",
    );
    assert.equal(disconnected?.disconnectable, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
