import assert from "node:assert/strict";
import { mkdtempSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

const stateDir = mkdtempSync(path.join(os.tmpdir(), "presence-state-test-"));
process.env.CODEX_ROUTER_STATE_DIR = stateDir;

const {
  PRESENCE_ALWAYS,
  PRESENCE_FOLLOW_CODEX,
  PRESENCE_STATE_PATH,
  presenceSnapshot,
  readPresenceMode,
  serviceFollowsHostApps,
  setPresenceMode,
} = await import("../src/presence-state.mjs");

test("presence defaults to always when no state has been written", () => {
  assert.equal(readPresenceMode(), PRESENCE_ALWAYS);
  assert.equal(serviceFollowsHostApps(), false);
  assert.ok(PRESENCE_STATE_PATH.startsWith(stateDir));
});

test("presence round-trips through protected state", () => {
  assert.deepEqual(setPresenceMode(PRESENCE_FOLLOW_CODEX), {
    mode: PRESENCE_FOLLOW_CODEX,
    path: PRESENCE_STATE_PATH,
  });
  assert.equal(readPresenceMode(), PRESENCE_FOLLOW_CODEX);
  assert.equal(serviceFollowsHostApps(), true);
  if (process.platform !== "win32") {
    assert.equal(statSync(PRESENCE_STATE_PATH).mode & 0o777, 0o600);
  }

  setPresenceMode(PRESENCE_ALWAYS);
  assert.equal(serviceFollowsHostApps(), false);
  assert.equal(presenceSnapshot().mode, PRESENCE_ALWAYS);
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
