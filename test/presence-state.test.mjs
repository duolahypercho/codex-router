import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { privateFileIsProtected } from "../src/file-security.mjs";

const stateDir = mkdtempSync(path.join(os.tmpdir(), "presence-state-test-"));
process.env.CODEX_ROUTER_STATE_DIR = stateDir;

// A PATH with no `codex` on it, so the terminal-client probe answers no unless
// a test puts one there. Set before the module loads: the probe memoizes.
// Not an empty directory -- the probe runs `which`, which has to stay findable
// -- but the two system directories that never hold a Codex install.
//
// Keep the probe deterministic on every host. Windows needs its system tools
// (`where.exe`, PowerShell, and icacls) for command detection and protected
// state, but the user's full PATH may also contain the real Codex executable.
// Restricting it to those system directories exercises the no-terminal-client
// case without changing the production detection rule.
const emptyPathDir = process.platform === "win32"
  ? [
      path.join(process.env.SystemRoot || process.env.windir || "C:\\Windows", "System32"),
      path.join(process.env.SystemRoot || process.env.windir || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0"),
    ].join(path.delimiter)
  : "/usr/bin:/bin";
process.env.PATH = emptyPathDir;

const {
  PRESENCE_ALWAYS,
  PRESENCE_FOLLOW_CODEX,
  PRESENCE_STATE_PATH,
  effectivePresenceMode,
  harnessPublished,
  presenceSnapshot,
  readPresenceMode,
  serviceFollowsHostApps,
  setPresenceMode,
  terminalCodexInstalled,
} = await import("../src/presence-state.mjs");

const { DSH_CATALOG_PATH } = await import("../src/paths.mjs");

function publishHarness() {
  writeFileSync(DSH_CATALOG_PATH, JSON.stringify({ models: [] }), "utf8");
}

function unpublishHarness() {
  rmSync(DSH_CATALOG_PATH, { force: true });
}

// A directory holding an executable `codex`, added to PATH to stand in for a
// terminal install. `which` only reports it when it is executable.
function installTerminalCodex() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "presence-codex-path-"));
  const binary = path.join(dir, "codex");
  writeFileSync(binary, "#!/bin/sh\nexit 0\n", { encoding: "utf8", mode: 0o755 });
  chmodSync(binary, 0o755);
  process.env.PATH = `${dir}${path.delimiter}${emptyPathDir}`;
  return dir;
}

function uninstallTerminalCodex(dir) {
  process.env.PATH = emptyPathDir;
  rmSync(dir, { recursive: true, force: true });
}

test("presence defaults to always when no state has been written", () => {
  assert.equal(readPresenceMode(), PRESENCE_ALWAYS);
  assert.equal(serviceFollowsHostApps(), false);
  assert.ok(PRESENCE_STATE_PATH.startsWith(stateDir));
});

test("presence round-trips through protected state", () => {
  assert.deepEqual(setPresenceMode(PRESENCE_FOLLOW_CODEX), {
    mode: PRESENCE_FOLLOW_CODEX,
    effectiveMode: PRESENCE_FOLLOW_CODEX,
    harnessPublished: false,
    terminalCodex: false,
    path: PRESENCE_STATE_PATH,
  });
  assert.equal(readPresenceMode(), PRESENCE_FOLLOW_CODEX);
  assert.equal(serviceFollowsHostApps(), true);
  assert.equal(privateFileIsProtected(PRESENCE_STATE_PATH), true);
  // Windows protects private files with ACLs, not POSIX modes.
  if (process.platform !== "win32") {
    assert.equal(statSync(PRESENCE_STATE_PATH).mode & 0o777, 0o600);
  }

  setPresenceMode(PRESENCE_ALWAYS);
  assert.equal(serviceFollowsHostApps(), false);
  assert.equal(presenceSnapshot().mode, PRESENCE_ALWAYS);
});

test("a published harness pins the router on without discarding the choice", () => {
  setPresenceMode(PRESENCE_FOLLOW_CODEX);
  assert.equal(serviceFollowsHostApps(), true);
  assert.equal(harnessPublished(), false);

  // The harness is a CLI with no bundle to watch and no lazy start, so
  // following the desktop apps would stop the router under a harness-only user.
  publishHarness();
  assert.equal(harnessPublished(), true);
  assert.equal(effectivePresenceMode(), PRESENCE_ALWAYS);
  assert.equal(serviceFollowsHostApps(), false);
  // The toggle the user set is overridden, never rewritten.
  assert.equal(readPresenceMode(), PRESENCE_FOLLOW_CODEX);
  assert.deepEqual(presenceSnapshot(), {
    mode: PRESENCE_FOLLOW_CODEX,
    effectiveMode: PRESENCE_ALWAYS,
    harnessPublished: true,
    terminalCodex: false,
    path: PRESENCE_STATE_PATH,
  });

  // Removing the route hands the user's own choice back.
  unpublishHarness();
  assert.equal(effectivePresenceMode(), PRESENCE_FOLLOW_CODEX);
  assert.equal(serviceFollowsHostApps(), true);
  setPresenceMode(PRESENCE_ALWAYS);
});

// Windows resolves through where.exe and would need an executable of its own;
// the rule under test is platform-independent, the fixture is not.
test("a terminal codex pins the router on the same way the harness does",
  { skip: process.platform === "win32" }, () => {
  setPresenceMode(PRESENCE_FOLLOW_CODEX);
  assert.equal(terminalCodexInstalled(), false);
  assert.equal(serviceFollowsHostApps(), true);

  // NSRunningApplication enumerates app bundles, so a `codex` run from a shell
  // is as invisible to follow mode as the harness is -- and just as unable to
  // be started on demand once its first request has already been refused.
  const dir = installTerminalCodex();
  assert.equal(terminalCodexInstalled(), true);
  assert.equal(effectivePresenceMode(), PRESENCE_ALWAYS);
  assert.equal(serviceFollowsHostApps(), false);
  assert.equal(presenceSnapshot().terminalCodex, true);
  assert.equal(readPresenceMode(), PRESENCE_FOLLOW_CODEX);

  uninstallTerminalCodex(dir);
  assert.equal(terminalCodexInstalled(), false);
  assert.equal(serviceFollowsHostApps(), true);
  setPresenceMode(PRESENCE_ALWAYS);
});

test("a published harness leaves always-on alone", () => {
  setPresenceMode(PRESENCE_ALWAYS);
  publishHarness();
  assert.equal(effectivePresenceMode(), PRESENCE_ALWAYS);
  assert.equal(serviceFollowsHostApps(), false);
  unpublishHarness();
});

test("presence rejects modes the tray does not offer", () => {
  assert.throws(() => setPresenceMode("sometimes"), /Presence mode must be one of/);
  assert.throws(() => setPresenceMode(""), /Presence mode must be one of/);
});

test("presence falls back to always when the state file is unusable", () => {
  writeFileSync(PRESENCE_STATE_PATH, "{ not json", "utf8");
  assert.equal(readPresenceMode(), PRESENCE_ALWAYS);

  writeFileSync(PRESENCE_STATE_PATH, JSON.stringify({ version: 2, mode: "follow-codex" }), "utf8");
  assert.equal(readPresenceMode(), PRESENCE_ALWAYS);

  writeFileSync(PRESENCE_STATE_PATH, JSON.stringify({ version: 1, mode: "nonsense" }), "utf8");
  assert.equal(readPresenceMode(), PRESENCE_ALWAYS);
});
