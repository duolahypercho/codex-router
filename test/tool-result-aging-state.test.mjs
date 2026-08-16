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
  retentionTtlMs,
  setNativeToolResultAgingEnabled,
  setRetentionTtlDays,
  setToolResultAgingEnabled,
  toolResultAgingEnabled,
  toolResultAgingSnapshot,
} = await import("../src/tool-result-aging-state.mjs");

const { RETENTION_DEFAULT_TTL_DAYS } = await import("../src/tool-result-retention.mjs");
const DAY_MS = 24 * 60 * 60 * 1000;

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
    retentionTtlDays: RETENTION_DEFAULT_TTL_DAYS,
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
    retentionTtlDays: RETENTION_DEFAULT_TTL_DAYS,
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
    // A file written before the TTL existed never answered the question, so it
    // reads as the default rather than as "keep them forever".
    retentionTtlDays: RETENTION_DEFAULT_TTL_DAYS,
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
    evaluatedRequests: 0,
    largestResultBytes: 0,
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
    retentionTtlDays: RETENTION_DEFAULT_TTL_DAYS,
  });
  assert.equal(toolResultAgingEnabled(), false);
  assert.equal(nativeToolResultAgingEnabled(), false);
});

// The TTL deletes bytes the model already saw, so an operator's answer is kept
// verbatim in both directions: a shorter lifetime and "keep them" alike.
test("the retention TTL defaults to a week and round-trips through protected state", () => {
  forgetState();
  assert.equal(readToolResultAgingSettings().retentionTtlDays, RETENTION_DEFAULT_TTL_DAYS);
  assert.equal(retentionTtlMs(), RETENTION_DEFAULT_TTL_DAYS * DAY_MS);

  setRetentionTtlDays(2);
  assert.equal(readToolResultAgingSettings().retentionTtlDays, 2);
  assert.equal(retentionTtlMs(), 2 * DAY_MS);
  assert.equal(toolResultAgingSnapshot().retentionTtlDays, 2);

  // Zero is an answer, not an absence: it means keep them until an explicit
  // purge, and no default may overwrite it.
  setRetentionTtlDays(0);
  assert.equal(readToolResultAgingSettings().retentionTtlDays, 0);
  assert.equal(retentionTtlMs(), 0);

  setRetentionTtlDays(undefined);
  assert.equal(readToolResultAgingSettings().retentionTtlDays, RETENTION_DEFAULT_TTL_DAYS);
});

test("the TTL survives the aging toggles, and they survive it", () => {
  forgetState();
  setRetentionTtlDays(3);
  setToolResultAgingEnabled(true);
  setNativeToolResultAgingEnabled(true);
  assert.equal(readToolResultAgingSettings().retentionTtlDays, 3);

  setRetentionTtlDays(0);
  assert.equal(toolResultAgingEnabled(), true);
  assert.equal(nativeToolResultAgingEnabled(), true);
  forgetState();
});

test("a TTL that is not a number of days is refused rather than stored", () => {
  forgetState();
  assert.throws(() => setRetentionTtlDays("soon"), /number of days/u);
  assert.throws(() => setRetentionTtlDays(-1), /number of days/u);
  assert.throws(() => setRetentionTtlDays(0.5), /between 1 and 3650 days/u);
  assert.throws(() => setRetentionTtlDays(4_000), /between 1 and 3650 days/u);
  assert.equal(readToolResultAgingSettings().retentionTtlDays, RETENTION_DEFAULT_TTL_DAYS);
});

// The kill switch stops the router rewriting request context. Expiry is disk
// hygiene for bytes already written, so silencing compaction must not strand an
// aging archive on disk forever.
test("the environment kill switch does not disable the retention TTL", () => {
  forgetState();
  setRetentionTtlDays(2);
  process.env.CODEX_ROUTER_TOOL_RESULT_AGING = "0";
  assert.equal(toolResultAgingEnabled(), false);
  assert.equal(retentionTtlMs(), 2 * DAY_MS);
  delete process.env.CODEX_ROUTER_TOOL_RESULT_AGING;
  forgetState();
});
