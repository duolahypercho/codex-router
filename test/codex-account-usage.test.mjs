import assert from "node:assert/strict";
import test from "node:test";

import {
  normalizeCodexAccountUsage,
  readCodexAccountUsage,
} from "../src/codex-account-usage.mjs";

test("normalizes Codex limits and daily usage without account credentials", () => {
  const value = normalizeCodexAccountUsage(
    {
      rateLimits: {
        limitId: "codex",
        planType: "pro",
        primary: { usedPercent: 54, windowDurationMins: 10_080, resetsAt: 1_800_000_000 },
        secondary: { usedPercent: 12, windowDurationMins: 300, resetsAt: 1_700_000_000 },
        credits: { balance: "secret-adjacent-data-is-not-needed" },
      },
    },
    {
      summary: { lifetimeTokens: 12_345, peakDailyTokens: 3_210, currentStreakDays: 4 },
      dailyUsageBuckets: [
        { startDate: "2026-07-20", tokens: 200 },
        { startDate: "invalid", tokens: 999 },
        { startDate: "2026-07-19", tokens: 100 },
      ],
    },
    new Date("2026-07-21T12:00:00.000Z"),
  );

  assert.deepEqual(value, {
    fetchedAt: "2026-07-21T12:00:00.000Z",
    planType: "pro",
    limitId: "codex",
    primary: {
      usedPercent: 54,
      remainingPercent: 46,
      windowDurationMins: 10_080,
      resetsAt: 1_800_000_000,
    },
    secondary: {
      usedPercent: 12,
      remainingPercent: 88,
      windowDurationMins: 300,
      resetsAt: 1_700_000_000,
    },
    dailyUsageBuckets: [
      { startDate: "2026-07-19", tokens: 100 },
      { startDate: "2026-07-20", tokens: 200 },
    ],
    summary: { lifetimeTokens: 12_345, peakDailyTokens: 3_210, currentStreakDays: 4 },
  });
  assert.equal(JSON.stringify(value).includes("secret-adjacent"), false);
});

test("clamps malformed percentages and tolerates missing usage", () => {
  const value = normalizeCodexAccountUsage(
    { rateLimits: { primary: { usedPercent: 140 } } },
    undefined,
    new Date("2026-07-21T12:00:00.000Z"),
  );
  assert.equal(value.primary.usedPercent, 100);
  assert.equal(value.primary.remainingPercent, 0);
  assert.deepEqual(value.dailyUsageBuckets, []);
});

test("preserves optional daily account token breakdowns for the usage graph", () => {
  const value = normalizeCodexAccountUsage(
    {},
    {
      dailyUsageBuckets: [
        {
          startDate: "2026-07-20",
          tokens: 500,
          inputTokens: 420.9,
          cachedInputTokens: 120.8,
          outputTokens: 79.7,
        },
      ],
    },
    new Date("2026-07-21T12:00:00.000Z"),
  );

  assert.deepEqual(value.dailyUsageBuckets, [{
    startDate: "2026-07-20",
    tokens: 500,
    inputTokens: 420,
    cachedInputTokens: 120,
    outputTokens: 79,
  }]);
});

// The panel used to run its own two-line search for Codex -- an undocumented
// CODEX_BINARY, a macOS app path, then the bare name "codex". On Windows all
// three miss, and the bare name resolves to the npm shim Node refuses to
// spawn, so the usage panel reported "the Codex app-server could not be
// started" on every Windows machine.
test("the usage panel reaches an npm-installed Codex through cmd.exe", () => {
  let invocation;
  readCodexAccountUsage({
    binary: "C:\\Users\\ann\\AppData\\Roaming\\npm\\codex.cmd",
    codexHome: "C:\\Users\\ann\\.codex-secondary",
    platform: "win32",
    spawnImpl: (command, args, options) => {
      invocation = { command, args, options };
      return {
        stdout: { on() {}, once() {}, removeListener() {}, setEncoding() {} },
        stdin: { write() {} },
        once() {},
        kill() {},
      };
    },
  }).catch(() => {});

  assert.match(invocation.command, /cmd\.exe$/i);
  assert.deepEqual(invocation.args.slice(0, 3), ["/d", "/s", "/c"]);
  assert.ok(invocation.args[3].includes("codex.cmd"), invocation.args[3]);
  assert.equal(invocation.options.windowsVerbatimArguments, true);
  assert.equal(invocation.options.windowsHide, true);
  assert.equal(invocation.options.env.CODEX_HOME, "C:\\Users\\ann\\.codex-secondary");
});

test("the usage panel names a missing Codex instead of blaming the app-server", async () => {
  // `null`, not `undefined`: a default parameter fires for `undefined`, so
  // passing that resolved a real binary and the rejection never happened on any
  // machine with Codex installed. It only looked green because CI runners have
  // none -- which is the one environment where this assertion cannot fail.
  await assert.rejects(readCodexAccountUsage({ binary: null }), /no Codex binary was found/);
});
