import assert from "node:assert/strict";
import { lstatSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";

const testRoot = mkdtempSync(path.join(os.tmpdir(), "codex-router-discovery-"));
process.env.CODEX_HOME = path.join(testRoot, "codex");
process.env.CODEX_ROUTER_STATE_DIR = path.join(testRoot, "state");
process.env.MODEL_ROUTER_STATE_DIR = process.env.CODEX_ROUTER_STATE_DIR;
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

test("an unrecognized marker keeps discovery disabled and reports repair once per read epoch", () => {
  const warnings = [];
  const warn = console.error;
  console.error = (message) => warnings.push(message);
  try {
    mkdirSync(path.dirname(DISCOVERY_MODE_PATH), { recursive: true });
    for (const contents of [
      "not json",
      '{"version":99,"discovery":"disabled"}\n',
      '{"version":1,"discovery":"unexpected"}\n',
    ]) {
      writeDiscoveryMode(false); // drop the module's cached reading via the API
      writeFileSync(DISCOVERY_MODE_PATH, contents, "utf8");
      assert.equal(discoveryDisabled(), true);
      assert.equal(discoveryDisabled(), true);
    }
    assert.equal(warnings.length, 3);
    assert.ok(warnings.every((message) => /discovery.*disabled.*setup/i.test(message)));
  } finally {
    console.error = warn;
    delete process.env.CODEX_ROUTER_NO_DISCOVERY;
    writeDiscoveryMode(false);
  }
});

test("an unreadable marker does not resume reads of a pre-existing CLI session", async () => {
  const { grokOAuthStatus } = await import("../src/grok-oauth-status.mjs");
  mkdirSync(path.dirname(process.env.GROK_AUTH_PATH), { recursive: true });
  writeFileSync(process.env.GROK_AUTH_PATH, JSON.stringify({
    "https://auth.x.ai::fixture": { key: "SYNTHETIC_PREEXISTING_SESSION" },
  }));
  try {
    writeDiscoveryMode(false);
    assert.equal(grokOAuthStatus().configured, true);

    for (const state of ["malformed", "unreadable"]) {
      writeDiscoveryMode(true);
      if (state === "malformed") writeFileSync(DISCOVERY_MODE_PATH, "not json", "utf8");
      else {
        rmSync(DISCOVERY_MODE_PATH);
        mkdirSync(DISCOVERY_MODE_PATH);
      }
      assert.equal(discoveryDisabled(), true);
      assert.equal(grokOAuthStatus().configured, false);
      rmSync(DISCOVERY_MODE_PATH, { recursive: true, force: true });
    }
    writeDiscoveryMode(false);
    assert.equal(grokOAuthStatus().configured, true);
  } finally {
    rmSync(DISCOVERY_MODE_PATH, { recursive: true, force: true });
    writeDiscoveryMode(false);
    rmSync(process.env.GROK_AUTH_PATH, { force: true });
  }
});

test("a dangling discovery marker stays disabled while a readable symlink keeps working", async (t) => {
  try {
    writeDiscoveryMode(false);
    rmSync(DISCOVERY_MODE_PATH);
    const target = path.join(testRoot, "missing-discovery-policy.json");
    try {
      symlinkSync(target, DISCOVERY_MODE_PATH, "file");
    } catch (error) {
      if (process.platform === "win32" && error?.code === "EPERM") {
        t.skip("Windows fixture cannot create file symlinks without the required privilege");
        return;
      }
      throw error;
    }
    assert.equal(lstatSync(DISCOVERY_MODE_PATH).isSymbolicLink(), true);
    assert.equal(discoveryDisabled(), true);
    writeFileSync(target, JSON.stringify({ version: 1, discovery: "enabled" }));
    const { discoveryDisabled: readFresh } = await import("../src/discovery-mode.mjs?readable-symlink");
    assert.equal(readFresh(), false);
  } finally {
    rmSync(DISCOVERY_MODE_PATH, { force: true });
    writeDiscoveryMode(false);
  }
});

test("discovery read ENOENT requires directory-entry absence before using the legacy default", () => {
  const source = readFileSync(new URL("../src/discovery-mode.mjs", import.meta.url), "utf8");
  const start = source.indexOf("function readDiscoveryModeFile()");
  const end = source.indexOf("\nexport function writeDiscoveryMode", start);
  assert.ok(start >= 0 && end > start);
  for (const state of ["present", "unreadable", "absent"]) {
    let inspections = 0;
    const warnings = [];
    const read = vm.runInNewContext(`(${source.slice(start, end)})`, {
      DISCOVERY_MODE_PATH: "synthetic-policy", console: { error: (message) => warnings.push(message) },
      readFileSync: () => { throw Object.assign(new Error("missing target"), { code: "ENOENT" }); },
      lstatSync: () => {
        inspections += 1;
        if (state !== "present") throw Object.assign(new Error("entry check"), {
          code: state === "absent" ? "ENOENT" : "EACCES",
        });
        return { isSymbolicLink: () => true };
      },
    });
    assert.equal(read(), state !== "absent", state);
    assert.equal(inspections, 1, state);
    assert.equal(warnings.length, state === "absent" ? 0 : 1);
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
