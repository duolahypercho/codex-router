import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const testRoot = mkdtempSync(path.join(os.tmpdir(), "codex-router-discovery-"));
process.env.CODEX_HOME = path.join(testRoot, "codex");
process.env.CODEX_ROUTER_STATE_DIR = path.join(testRoot, "state");
process.env.KIMI_CODE_HOME = path.join(testRoot, "kimi-code");
process.env.GROK_AUTH_PATH = path.join(testRoot, "grok", "auth.json");
delete process.env.CODEX_ROUTER_NO_DISCOVERY;

const { discoveryDisabled, writeDiscoveryMode } = await import("../src/discovery-mode.mjs");
const { DISCOVERY_MODE_PATH } = await import("../src/paths.mjs");

test("discovery is enabled by default and the marker survives a process's choice", () => {
  // No marker file is the state every install before the flag existed had.
  assert.equal(discoveryDisabled(), false);

  writeDiscoveryMode(true);
  assert.equal(discoveryDisabled(), true);
  if (process.platform !== "win32") {
    assert.equal(statSync(DISCOVERY_MODE_PATH).mode & 0o777, 0o600);
  }

  writeDiscoveryMode(false);
  assert.equal(discoveryDisabled(), false);
});

test("the environment override wins over the marker in both directions", () => {
  try {
    writeDiscoveryMode(false);
    process.env.CODEX_ROUTER_NO_DISCOVERY = "1";
    assert.equal(discoveryDisabled(), true);

    writeDiscoveryMode(true);
    process.env.CODEX_ROUTER_NO_DISCOVERY = "0";
    assert.equal(discoveryDisabled(), false);
  } finally {
    delete process.env.CODEX_ROUTER_NO_DISCOVERY;
    writeDiscoveryMode(false);
  }
});

test("an unrecognized marker file keeps discovery on", () => {
  try {
    // "Cannot prove --no-discovery" must read as the state every install
    // without the flag has always had, not as a surprise lockout.
    mkdirSync(path.dirname(DISCOVERY_MODE_PATH), { recursive: true });
    writeDiscoveryMode(false); // drop the module's cached reading via the API
    writeFileSync(DISCOVERY_MODE_PATH, "not json", "utf8");
    assert.equal(discoveryDisabled(), false);

    writeDiscoveryMode(false);
    writeFileSync(DISCOVERY_MODE_PATH, '{"version":99,"discovery":"disabled"}\n', "utf8");
    assert.equal(discoveryDisabled(), false);
  } finally {
    delete process.env.CODEX_ROUTER_NO_DISCOVERY;
    writeDiscoveryMode(false);
  }
});

test("disabling discovery empties the configured set and blinds every reader", async () => {
  const { configuredProviderIds } = await import("../src/provider-selection.mjs");
  const { kimiOAuthStatus } = await import("../src/oauth-status.mjs");
  const { grokOAuthStatus } = await import("../src/grok-oauth-status.mjs");
  const { codexAuthStatus } = await import("../src/codex-binary.mjs");
  const { nativeSessionFallbackEnabled, nativeSessionStatus } = await import(
    "../src/codex-native-session.mjs"
  );
  const { readCodexAccountUsage } = await import("../src/codex-account-usage.mjs");
  try {
    process.env.CODEX_ROUTER_NO_DISCOVERY = "1";
    // Even keyless local backends drop out: "configured" feeds the default
    // selection and the enable gate, and an idle install keeps both empty.
    assert.deepEqual(configuredProviderIds(), []);
    assert.equal(kimiOAuthStatus().configured, false);
    assert.match(kimiOAuthStatus().setup, /discovery is disabled/i);
    assert.equal(grokOAuthStatus().configured, false);
    assert.deepEqual(codexAuthStatus(), {
      authenticated: false,
      reason: "discovery-disabled",
    });
    assert.equal(nativeSessionFallbackEnabled(), false);

    // Even the metadata is withheld: whether auth.json exists, and how old it
    // is, is knowledge about a credential this process promised not to read.
    const session = nativeSessionStatus();
    assert.equal(session.present, false);
    assert.equal(session.usable, false);
    assert.equal(session.ageHours, undefined);
    assert.equal(session.fallbackEnabled, false);

    // The account-usage probe spawns `codex app-server` and reads the
    // signed-in ChatGPT account; it must refuse before any spawn.
    let spawned = false;
    await assert.rejects(
      readCodexAccountUsage({
        binary: "codex",
        spawnImpl: () => {
          spawned = true;
          throw new Error("must not spawn");
        },
      }),
      /discovery is disabled/i,
    );
    assert.equal(spawned, false, "the account probe spawned despite the kill-switch");
  } finally {
    delete process.env.CODEX_ROUTER_NO_DISCOVERY;
  }
});

test.after(() => {
  rmSync(testRoot, { recursive: true, force: true });
});
