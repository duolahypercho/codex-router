import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

const stateDir = mkdtempSync(path.join(os.tmpdir(), "tool-result-aging-state-test-"));
process.env.MODEL_ROUTER_STATE_DIR = stateDir;

const {
  TOOL_RESULT_AGING_STATE_PATH,
  nativeToolResultAgingEnabled,
  readToolResultAgingSettings,
  setNativeToolResultAgingEnabled,
  setToolResultAgingEnabled,
  toolResultAgingEnabled,
  toolResultAgingSnapshot,
} = await import("../src/tool-result-aging-state.mjs");

function forgetState() {
  rmSync(TOOL_RESULT_AGING_STATE_PATH, { force: true });
  delete process.env.CODEX_ROUTER_TOOL_RESULT_AGING;
}

// Compaction rewrites what the model sees mid-conversation, so it is opted
// into rather than discovered after the fact.
test("tool-result aging defaults off until it is configured", () => {
  forgetState();
  assert.deepEqual(readToolResultAgingSettings(), {
    version: 1,
    enabled: false,
    nativeEnabled: false,
    defaulted: true,
  });
  assert.equal(toolResultAgingSnapshot().configured, false);
  assert.equal(toolResultAgingEnabled(), false);
  assert.equal(nativeToolResultAgingEnabled(), false);
});

test("tool-result aging toggle round-trips through protected state", () => {
  setToolResultAgingEnabled(false);
  assert.deepEqual(readToolResultAgingSettings(), {
    version: 1,
    enabled: false,
    nativeEnabled: false,
  });
  assert.equal(toolResultAgingEnabled(), false);
  assert.equal(toolResultAgingSnapshot().configured, true);

  setToolResultAgingEnabled(true);
  assert.equal(toolResultAgingEnabled(), true);
  assert.ok(TOOL_RESULT_AGING_STATE_PATH.startsWith(stateDir));
});

test("native aging is a separate opt-in that survives the routed toggle", () => {
  forgetState();
  setNativeToolResultAgingEnabled(true);
  assert.equal(nativeToolResultAgingEnabled(), true);
  // The routed default must not be disturbed by opting the native path in --
  // it stays at whatever it was, which on a fresh state is off.
  assert.equal(toolResultAgingEnabled(), false);

  // Flipping the routed flag must not silently reset the native choice.
  setToolResultAgingEnabled(false);
  assert.equal(nativeToolResultAgingEnabled(), true);
  setToolResultAgingEnabled(true);

  setNativeToolResultAgingEnabled(false);
  assert.equal(nativeToolResultAgingEnabled(), false);
  assert.equal(toolResultAgingEnabled(), true);
});

test("a pre-native state file reads as native off, not as corrupt", () => {
  writeFileSync(
    TOOL_RESULT_AGING_STATE_PATH,
    `${JSON.stringify({ version: 1, enabled: true })}\n`,
    "utf8",
  );
  assert.deepEqual(readToolResultAgingSettings(), {
    version: 1,
    enabled: true,
    nativeEnabled: false,
  });
});

test("environment kill switch overrides the saved setting", () => {
  setToolResultAgingEnabled(true);
  setNativeToolResultAgingEnabled(true);
  process.env.CODEX_ROUTER_TOOL_RESULT_AGING = "0";
  assert.equal(toolResultAgingEnabled(), false);
  assert.equal(nativeToolResultAgingEnabled(), false);
  assert.equal(toolResultAgingSnapshot().environmentOverride, true);
  delete process.env.CODEX_ROUTER_TOOL_RESULT_AGING;
  setNativeToolResultAgingEnabled(false);
});

test("snapshot reports zeroed savings stats before any usage is recorded", () => {
  forgetState();
  const emptyCache = { agedRate: null, unagedRate: null, agedTurns: 0, unagedTurns: 0 };
  assert.deepEqual(toolResultAgingSnapshot().stats, {
    requests: 0,
    resultsAged: 0,
    bytesSaved: 0,
    estimatedTokensSaved: 0,
    firstAt: undefined,
    lastAt: undefined,
    ranges: {
      "24h": { savedTokens: 0, requests: 0, buckets: new Array(24).fill(0), cache: emptyCache },
      "7d": { savedTokens: 0, requests: 0, buckets: new Array(7).fill(0), cache: emptyCache },
      "30d": { savedTokens: 0, requests: 0, buckets: new Array(30).fill(0), cache: emptyCache },
    },
  });
});

test("corrupt explicit state fails closed", () => {
  writeFileSync(TOOL_RESULT_AGING_STATE_PATH, "{not json", "utf8");
  assert.deepEqual(readToolResultAgingSettings(), {
    version: 1,
    enabled: false,
    nativeEnabled: false,
  });
  assert.equal(toolResultAgingEnabled(), false);
  assert.equal(nativeToolResultAgingEnabled(), false);
});
