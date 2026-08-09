import assert from "node:assert/strict";
import test from "node:test";

import {
  deepSeekBalanceMetrics,
  githubCopilotQuotaMetrics,
  grokCreditsMetrics,
  kimiApiBalanceMetrics,
  kimiQuotaMetrics,
  providerAccountUsageSnapshot,
} from "../src/provider-account-usage.mjs";

test("normalizes GitHub Copilot AI-credit quota", () => {
  assert.deepEqual(githubCopilotQuotaMetrics({
    quota_reset_date: "2026-09-01T00:00:00Z",
    quota_snapshots: {
      premium_interactions: {
        entitlement: 1_500,
        remaining: 1_125,
        percent_remaining: 75,
      },
      chat: { entitlement: -1, remaining: -1, unlimited: true },
    },
  }), [{
    kind: "quota",
    label: "AI credits",
    usedPercent: 25,
    remainingPercent: 75,
    used: 375,
    limit: 1_500,
    remaining: 1_125,
    unit: "credits",
    resetAt: 1_788_220_800,
  }]);
});

test("GitHub Copilot usage reads the account quota without exposing the token", async () => {
  process.env.COPILOT_GITHUB_TOKEN = "github_pat_TEST_COPILOT_USAGE_TOKEN";
  try {
    const snapshot = await providerAccountUsageSnapshot({
      providerIds: ["github-copilot"],
      fetchImpl: async (url, options) => {
        assert.equal(url, "https://api.github.com/copilot_internal/user");
        assert.equal(options.headers.Authorization, "Bearer github_pat_TEST_COPILOT_USAGE_TOKEN");
        return new Response(JSON.stringify({
          copilot_plan: "pro",
          quota_snapshots: {
            premium_interactions: { entitlement: 1_500, percent_remaining: 90 },
          },
        }));
      },
    });
    assert.equal(snapshot["github-copilot"].status, "available");
    assert.equal(snapshot["github-copilot"].plan, "pro");
    assert.equal(snapshot["github-copilot"].metrics[0].remainingPercent, 90);
    assert.doesNotMatch(JSON.stringify(snapshot), /TEST_COPILOT_USAGE_TOKEN/);
  } finally {
    delete process.env.COPILOT_GITHUB_TOKEN;
  }
});

test("GitHub Copilot ignores null and unlimited quota placeholders", () => {
  assert.deepEqual(githubCopilotQuotaMetrics({
    quota_snapshots: {
      premium_interactions: { entitlement: null, remaining: null, percent_remaining: null },
      chat: { entitlement: 100, remaining: -1, percent_remaining: 100 },
    },
  }), []);
});

test("normalizes Kimi weekly and five-hour quota windows", () => {
  assert.deepEqual(kimiQuotaMetrics({
    usage: { limit: "2048", used: "214", remaining: "1834", resetTime: "2026-07-25T00:00:00Z" },
    limits: [{ detail: { limit: 200, used: 139, remaining: 61 } }],
  }), [
    {
      kind: "quota",
      label: "Weekly limit",
      usedPercent: 10.44921875,
      remainingPercent: 89.55078125,
      used: 214,
      limit: 2048,
      remaining: 1834,
      unit: "requests",
      resetAt: 1784937600,
    },
    {
      kind: "quota",
      label: "5-hour limit",
      usedPercent: 69.5,
      remainingPercent: 30.5,
      used: 139,
      limit: 200,
      remaining: 61,
      unit: "requests",
    },
  ]);
});
test("normalizes DeepSeek paid and granted API balance", () => {
  assert.deepEqual(deepSeekBalanceMetrics({
    is_available: true,
    balance_infos: [{
      currency: "USD",
      total_balance: "50.25",
      granted_balance: "10.00",
      topped_up_balance: "40.25",
    }],
  }), [{
    kind: "balance",
    label: "API balance",
    value: 50.25,
    currency: "USD",
    detail: "Paid 40.25 · Granted 10.00",
    available: true,
  }]);
});

test("normalizes Moonshot Kimi API account balance", () => {
  assert.deepEqual(kimiApiBalanceMetrics({
    code: 0,
    status: true,
    data: { available_balance: 12.5, cash_balance: 10, voucher_balance: 2.5 },
  }, "CNY"), [{
    kind: "balance",
    label: "API balance",
    value: 12.5,
    currency: "CNY",
    detail: "Cash 10.00 · Voucher 2.50",
    available: true,
  }]);
});

test("does not poll account endpoints for disabled providers", async () => {
  const snapshot = await providerAccountUsageSnapshot({
    providerIds: [],
    fetchImpl: async () => {
      throw new Error("disabled provider should not reach the network");
    },
  });
  assert.ok(Object.values(snapshot).every((account) => account.status === "disabled"));
});

test("Command Code usage degrades to the Studio link without an account API", async () => {
  delete process.env.COMMAND_CODE_API_KEY;
  delete process.env.COMMANDCODE_API_KEY;
  process.env.COMMAND_CODE_API_KEY = "TEST_COMMANDCODE_USAGE_KEY";
  try {
    const snapshot = await providerAccountUsageSnapshot({
      providerIds: ["commandcode"],
      fetchImpl: async () => {
        throw new Error("Command Code usage should not reach an undocumented endpoint");
      },
    });
    assert.equal(snapshot.commandcode.status, "local-only");
    assert.equal(snapshot.commandcode.dashboardUrl, "https://commandcode.ai/studio");
  } finally {
    delete process.env.COMMAND_CODE_API_KEY;
  }
});

test("normalizes Grok weekly credits usage from billing proxy", () => {
  assert.deepEqual(grokCreditsMetrics({
    config: {
      creditUsagePercent: 6,
      currentPeriod: {
        type: "USAGE_PERIOD_TYPE_WEEKLY",
        start: "2026-07-15T04:11:10.883403+00:00",
        end: "2026-07-22T04:11:10.883403+00:00",
      },
      prepaidBalance: { val: 0 },
      onDemandCap: { val: 0 },
      onDemandUsed: { val: 0 },
      isUnifiedBillingUser: true,
    },
  }), [{
    kind: "quota",
    label: "Weekly limit",
    usedPercent: 6,
    remainingPercent: 94,
    used: 6,
    limit: 100,
    remaining: 94,
    unit: "percent",
    resetAt: 1784693470.883,
  }]);
});

test("normalizes Grok prepaid credits and pay-as-you-go balance", () => {
  assert.deepEqual(grokCreditsMetrics({
    config: {
      creditUsagePercent: 100,
      currentPeriod: {
        type: "USAGE_PERIOD_TYPE_MONTHLY",
        end: "2026-08-01T00:00:00Z",
      },
      prepaidBalance: { val: -1250 },
      onDemandCap: { val: 5000 },
      onDemandUsed: { val: 355 },
    },
  }), [
    {
      kind: "quota",
      label: "Monthly limit",
      usedPercent: 100,
      remainingPercent: 0,
      used: 100,
      limit: 100,
      remaining: 0,
      unit: "percent",
      resetAt: 1785542400,
    },
    {
      kind: "balance",
      label: "Prepaid credits",
      value: 12.5,
      currency: "USD",
      detail: "Purchased credits remaining",
      available: true,
    },
    {
      kind: "balance",
      label: "Pay-as-you-go",
      value: 46.45,
      currency: "USD",
      detail: "$3.55 used of $50.00 limit",
      available: true,
    },
  ]);
});
