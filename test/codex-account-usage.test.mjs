import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import path from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";

import {
  ACCOUNT_POOL_USAGE_PROBE_LIMIT,
  attachBoundedChatGPTAccountUsage,
  normalizeCodexAccountUsage,
  readCodexAccountUsage,
} from "../src/codex-account-usage.mjs";

function fakeAppServer(replies) {
  const stdout = new PassThrough();
  const stdin = new PassThrough();
  const child = new EventEmitter();
  child.stdout = stdout;
  child.stdin = stdin;
  child.kill = () => {
    stdout.end();
    child.emit("exit", 0);
  };
  stdin.on("data", (chunk) => {
    for (const line of String(chunk).split("\n").filter(Boolean)) {
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        continue;
      }
      const reply = replies(message);
      if (reply) stdout.write(`${JSON.stringify(reply)}\n`);
    }
  });
  return child;
}

test("64 slow account probes stay within one capped concurrent usage budget", async () => {
  const accounts = Object.fromEntries(Array.from({ length: 64 }, (_, index) => [
    `acct_${String(index).padStart(8, "0")}`,
    {
      id: `acct_${String(index).padStart(8, "0")}`,
      subscription: { usable: true },
    },
  ]));
  const pool = { accounts };
  let active = 0;
  let maximumActive = 0;
  let calls = 0;
  const startedAt = Date.now();
  await attachBoundedChatGPTAccountUsage(pool, {
    accountHome: (id) => `/isolated/${id}`,
    timeoutMs: 25,
    readUsage: async ({ timeoutMs }) => {
      calls += 1;
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await new Promise((resolve) => setTimeout(resolve, timeoutMs));
      active -= 1;
      throw new Error("slow optional probe");
    },
  });
  assert.equal(calls, ACCOUNT_POOL_USAGE_PROBE_LIMIT);
  assert.equal(maximumActive, ACCOUNT_POOL_USAGE_PROBE_LIMIT);
  assert.ok(Date.now() - startedAt < 500, "optional usage probes exceeded their single bounded batch");
  assert.equal(Object.values(accounts).some((account) => account.subscription.usage), false);
});

test("the selected account is included before the optional usage probe cap", async () => {
  const selectedId = "acct_00000063";
  const accounts = Object.fromEntries(Array.from({ length: 64 }, (_, index) => {
    const id = `acct_${String(index).padStart(8, "0")}`;
    return [id, { id, subscription: { usable: true } }];
  }));
  const calls = [];
  await attachBoundedChatGPTAccountUsage({
    policy: { selectedAccountId: selectedId },
    accounts,
  }, {
    accountHome: (id) => `/isolated/${id}`,
    readUsage: async ({ codexHome }) => {
      calls.push(path.basename(codexHome));
      return {};
    },
  });
  assert.equal(calls.length, ACCOUNT_POOL_USAGE_PROBE_LIMIT);
  assert.equal(calls[0], selectedId);
});

test("weekly and monthly account usage windows are classified disjointly", async () => {
  const accounts = {
    acct_weekly_0001: { id: "acct_weekly_0001", subscription: { usable: true } },
    acct_monthly_001: { id: "acct_monthly_001", subscription: { usable: true } },
  };
  await attachBoundedChatGPTAccountUsage({ accounts }, {
    accountHome: (id) => `/isolated/${id}`,
    readUsage: async ({ codexHome }) => path.basename(codexHome) === "acct_weekly_0001"
      ? { primary: { windowDurationMins: 7 * 24 * 60, remainingPercent: 70 } }
      : { primary: { windowDurationMins: 30 * 24 * 60, remainingPercent: 30 } },
  });
  assert.equal(accounts.acct_weekly_0001.subscription.usage.period, "weekly");
  assert.equal(accounts.acct_monthly_001.subscription.usage.period, "monthly");
});

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

test("a refused rateLimits read still returns usage instead of failing the panel", async () => {
  const value = await readCodexAccountUsage({
    binary: "/fake/codex",
    platform: "darwin",
    timeoutMs: 2_000,
    spawnImpl: () => fakeAppServer((message) => {
      if (message.id === 1) return { id: 1, result: {} };
      if (message.id === 2) {
        return { id: 2, error: { code: -32000, message: "limits unavailable" } };
      }
      if (message.id === 3) {
        return {
          id: 3,
          result: {
            summary: { lifetimeTokens: 42, peakDailyTokens: 7, currentStreakDays: 1 },
            dailyUsageBuckets: [{ startDate: "2026-09-01", tokens: 9 }],
          },
        };
      }
      return undefined;
    }),
  });

  assert.equal(value.planType, null);
  assert.equal(value.primary, null);
  assert.equal(value.secondary, null);
  assert.equal(value.summary.lifetimeTokens, 42);
  assert.deepEqual(value.dailyUsageBuckets, [{ startDate: "2026-09-01", tokens: 9 }]);
});

test("a refused usage read still returns rate limits instead of failing the panel", async () => {
  const value = await readCodexAccountUsage({
    binary: "/fake/codex",
    platform: "darwin",
    timeoutMs: 2_000,
    spawnImpl: () => fakeAppServer((message) => {
      if (message.id === 1) return { id: 1, result: {} };
      if (message.id === 2) {
        return {
          id: 2,
          result: {
            rateLimits: {
              planType: "pro",
              limitId: "codex",
              primary: { usedPercent: 10, windowDurationMins: 300, resetsAt: 1_800_000_000 },
            },
          },
        };
      }
      if (message.id === 3) {
        return { id: 3, error: { code: -32000, message: "usage unavailable" } };
      }
      return undefined;
    }),
  });

  assert.equal(value.planType, "pro");
  assert.equal(value.primary.usedPercent, 10);
  assert.deepEqual(value.dailyUsageBuckets, []);
  assert.equal(value.summary.lifetimeTokens, null);
});
