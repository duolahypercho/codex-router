import assert from "node:assert/strict";
import test from "node:test";

import { normalizeCodexAccountUsage } from "../src/codex-account-usage.mjs";

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
