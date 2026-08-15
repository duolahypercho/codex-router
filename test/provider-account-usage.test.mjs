import assert from "node:assert/strict";
import test from "node:test";

import {
  chutesBalanceMetrics,
  chutesSubscriptionMetrics,
  commandCodeCreditsMetrics,
  deepSeekBalanceMetrics,
  githubCopilotQuotaMetrics,
  grokCreditsMetrics,
  kimiApiBalanceMetrics,
  kimiQuotaMetrics,
  minimaxQuotaMetrics,
  opencodeGoUsageMetrics,
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

test("normalizes the Chutes API balance", () => {
  assert.deepEqual(chutesBalanceMetrics({ balance: "42.75" }), [{
    kind: "balance",
    label: "API balance",
    value: 42.75,
    currency: "USD",
    detail: "Chutes credits remaining",
    available: true,
  }]);
});

test("keeps finite zero and negative Chutes balances", () => {
  assert.equal(chutesBalanceMetrics({ balance: 0 })[0].value, 0);
  assert.equal(chutesBalanceMetrics({ balance: "-2.75" })[0].value, -2.75);
  assert.deepEqual(chutesBalanceMetrics({ balance: "not-a-number" }), []);
});

test("normalizes Chutes subscription windows", () => {
  assert.deepEqual(chutesSubscriptionMetrics({
    subscription: true,
    four_hour: {
      usage: 2,
      cap: 8,
      remaining: 6,
      reset_at: "2026-08-09T16:00:00Z",
    },
    monthly: {
      usage: 25,
      cap: 100,
      remaining: 75,
      reset_at: "2026-09-09T00:00:00Z",
    },
  }), [
    {
      kind: "quota",
      label: "4-hour subscription",
      usedPercent: 25,
      remainingPercent: 75,
      used: 2,
      limit: 8,
      remaining: 6,
      unit: "USD",
      resetAt: 1786291200,
    },
    {
      kind: "quota",
      label: "Monthly subscription",
      usedPercent: 25,
      remainingPercent: 75,
      used: 25,
      limit: 100,
      remaining: 75,
      unit: "USD",
      resetAt: 1788912000,
    },
  ]);
});

test("normalizes a custom Chutes subscription without inventing a monthly cap", () => {
  const metrics = chutesSubscriptionMetrics({
    subscription: true,
    custom: true,
    four_hour: { usage: 3, cap: 12, remaining: 9 },
    monthly: { uncapped: true },
  });
  assert.equal(metrics.length, 1);
  assert.equal(metrics[0].label, "4-hour subscription");
  assert.equal(metrics[0].remainingPercent, 75);
});

test("does not invent Chutes subscription quotas for an unsubscribed account", () => {
  assert.deepEqual(chutesSubscriptionMetrics({ subscription: false }), []);
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

test("anonymous free providers degrade to traffic-only usage without a balance API", async () => {
  const snapshot = await providerAccountUsageSnapshot({
    providerIds: ["opencode-free", "kilo-free"],
    fetchImpl: async () => {
      throw new Error("anonymous providers must not poll a private account endpoint");
    },
  });
  assert.equal(snapshot["opencode-free"].status, "local-only");
  assert.equal(snapshot["kilo-free"].status, "local-only");
  assert.match(snapshot["opencode-free"].message, /quota is not exposed/);
  assert.match(snapshot["kilo-free"].message, /quota is not exposed/);
});

test("Command Code usage reads plan windows from the billing credits API", async () => {
  delete process.env.COMMAND_CODE_API_KEY;
  delete process.env.COMMANDCODE_API_KEY;
  process.env.COMMAND_CODE_API_KEY = "TEST_COMMANDCODE_USAGE_KEY";
  try {
    const snapshot = await providerAccountUsageSnapshot({
      providerIds: ["commandcode"],
      fetchImpl: async (url, options) => {
        assert.equal(url, "https://api.commandcode.ai/alpha/billing/credits");
        assert.equal(options.headers.Authorization, "Bearer TEST_COMMANDCODE_USAGE_KEY");
        return new Response(JSON.stringify({
          credits: { monthlyCredits: 10, purchasedCredits: 0, freeCredits: 0 },
          windowLimits: {
            limited: true,
            fiveHour: { used: 1, cap: 3, exceeded: false, resetAt: 1_786_579_200 },
            weekly: { used: 2, cap: 6, exceeded: false, resetAt: 0 },
          },
        }));
      },
    });
    assert.equal(snapshot.commandcode.status, "available");
    assert.equal(snapshot.commandcode.dashboardUrl, "https://commandcode.ai/studio");
    assert.deepEqual(snapshot.commandcode.metrics, [
      {
        kind: "quota",
        label: "5-hour limit",
        usedPercent: (1 / 3) * 100,
        remainingPercent: 100 - (1 / 3) * 100,
        used: 1,
        limit: 3,
        remaining: 2,
        unit: "credits",
        resetAt: 1_786_579_200,
      },
      {
        kind: "quota",
        label: "Weekly limit",
        usedPercent: (2 / 6) * 100,
        remainingPercent: 100 - (2 / 6) * 100,
        used: 2,
        limit: 6,
        remaining: 4,
        unit: "credits",
      },
    ]);
    assert.doesNotMatch(JSON.stringify(snapshot), /TEST_COMMANDCODE_USAGE_KEY/);
  } finally {
    delete process.env.COMMAND_CODE_API_KEY;
  }
});

test("Command Code usage degrades to the Studio link when the credits API fails", async () => {
  delete process.env.COMMAND_CODE_API_KEY;
  delete process.env.COMMANDCODE_API_KEY;
  process.env.COMMAND_CODE_API_KEY = "TEST_COMMANDCODE_USAGE_KEY";
  try {
    const snapshot = await providerAccountUsageSnapshot({
      providerIds: ["commandcode"],
      fetchImpl: async () => new Response("nope", { status: 503 }),
    });
    assert.equal(snapshot.commandcode.status, "local-only");
    assert.equal(snapshot.commandcode.dashboardUrl, "https://commandcode.ai/studio");
  } finally {
    delete process.env.COMMAND_CODE_API_KEY;
  }
});

test("Command Code usage avoids the billing API for a custom endpoint", async () => {
  delete process.env.COMMAND_CODE_API_KEY;
  delete process.env.COMMANDCODE_API_KEY;
  process.env.COMMAND_CODE_API_KEY = "TEST_COMMANDCODE_CUSTOM_KEY";
  process.env.COMMANDCODE_BASE_URL = "https://example.test/provider/v1";
  try {
    const snapshot = await providerAccountUsageSnapshot({
      providerIds: ["commandcode"],
      fetchImpl: async () => {
        throw new Error("custom Command Code endpoints must not trigger billing API calls");
      },
    });
    assert.equal(snapshot.commandcode.status, "local-only");
    assert.match(snapshot.commandcode.message, /custom Command Code endpoint/);
  } finally {
    delete process.env.COMMAND_CODE_API_KEY;
    delete process.env.COMMANDCODE_BASE_URL;
  }
});

test("normalizes opencode Go rolling, weekly, and monthly windows", () => {
  assert.deepEqual(opencodeGoUsageMetrics({
    usage: {
      rolling: { status: "ok", percent: 1, resetsAt: "2026-08-13T01:32:51.675Z" },
      weekly: { status: "ok", percent: 67, resetsAt: "2026-08-17T00:00:00.675Z" },
      monthly: { status: "ok", percent: 52, resetsAt: "2026-09-04T23:37:45.675Z" },
    },
  }), [
    {
      kind: "quota",
      label: "Rolling limit",
      usedPercent: 1,
      remainingPercent: 99,
      used: 1,
      limit: 100,
      remaining: 99,
      unit: "percent",
      resetAt: 1786584771.675,
    },
    {
      kind: "quota",
      label: "Weekly limit",
      usedPercent: 67,
      remainingPercent: 33,
      used: 67,
      limit: 100,
      remaining: 33,
      unit: "percent",
      resetAt: 1786924800.675,
    },
    {
      kind: "quota",
      label: "Monthly limit",
      usedPercent: 52,
      remainingPercent: 48,
      used: 52,
      limit: 100,
      remaining: 48,
      unit: "percent",
      resetAt: 1788565065.675,
    },
  ]);
});

test("opencode Go usage reads the Zen usage API", async () => {
  const saved = process.env.OPENCODE_API_KEY;
  process.env.OPENCODE_API_KEY = "TEST_OPENCODE_USAGE_KEY";
  try {
    const snapshot = await providerAccountUsageSnapshot({
      providerIds: ["opencode-go"],
      fetchImpl: async (url, options) => {
        assert.equal(url, "https://opencode.ai/zen/go/v1/usage");
        assert.equal(options.headers.Authorization, "Bearer TEST_OPENCODE_USAGE_KEY");
        return new Response(JSON.stringify({
          usage: {
            rolling: { status: "ok", percent: 5, resetsAt: "2026-08-13T01:00:00Z" },
            weekly: { status: "ok", percent: 60, resetsAt: "2026-08-17T00:00:00Z" },
          },
        }));
      },
    });
    assert.equal(snapshot["opencode-go"].status, "available");
    assert.equal(snapshot["opencode-go"].metrics.length, 2);
    assert.equal(snapshot["opencode-go"].metrics[1].remainingPercent, 40);
    assert.doesNotMatch(JSON.stringify(snapshot), /TEST_OPENCODE_USAGE_KEY/);
  } finally {
    if (saved === undefined) delete process.env.OPENCODE_API_KEY;
    else process.env.OPENCODE_API_KEY = saved;
  }
});

test("opencode Go usage avoids the Zen API for a custom endpoint", async () => {
  const savedKey = process.env.OPENCODE_API_KEY;
  const savedBase = process.env.OPENCODE_GO_BASE_URL;
  process.env.OPENCODE_API_KEY = "TEST_OPENCODE_CUSTOM_KEY";
  process.env.OPENCODE_GO_BASE_URL = "https://example.test/zen/go/v1";
  try {
    const snapshot = await providerAccountUsageSnapshot({
      providerIds: ["opencode-go"],
      fetchImpl: async () => {
        throw new Error("custom opencode endpoints must not trigger usage API calls");
      },
    });
    assert.equal(snapshot["opencode-go"].status, "local-only");
    assert.match(snapshot["opencode-go"].message, /custom opencode endpoint/);
  } finally {
    if (savedKey === undefined) delete process.env.OPENCODE_API_KEY;
    else process.env.OPENCODE_API_KEY = savedKey;
    if (savedBase === undefined) delete process.env.OPENCODE_GO_BASE_URL;
    else process.env.OPENCODE_GO_BASE_URL = savedBase;
  }
});

test("normalizes MiniMax coding plan windows from the general entry only", () => {
  assert.deepEqual(minimaxQuotaMetrics({
    model_remains: [
      {
        model_name: "general",
        start_time: 1_786_564_800_000,
        end_time: 1_786_579_200_000,
        current_interval_remaining_percent: 98,
        current_weekly_remaining_percent: 82,
        weekly_end_time: 1_786_924_800_000,
      },
      {
        model_name: "video",
        current_interval_remaining_percent: 10,
        current_weekly_remaining_percent: 10,
      },
    ],
    base_resp: { status_code: 0, status_msg: "success" },
  }), [
    {
      kind: "quota",
      label: "4-hour limit",
      usedPercent: 2,
      remainingPercent: 98,
      used: 2,
      limit: 100,
      remaining: 98,
      unit: "percent",
      resetAt: 1_786_579_200,
    },
    {
      kind: "quota",
      label: "Weekly limit",
      usedPercent: 18,
      remainingPercent: 82,
      used: 18,
      limit: 100,
      remaining: 82,
      unit: "percent",
      resetAt: 1_786_924_800,
    },
  ]);
});

test("MiniMax token plan usage reads the coding plan remains API", async () => {
  const saved = process.env.MINIMAX_API_KEY;
  process.env.MINIMAX_API_KEY = "TEST_MINIMAX_USAGE_KEY";
  try {
    const snapshot = await providerAccountUsageSnapshot({
      providerIds: ["minimax-token-plan"],
      fetchImpl: async (url, options) => {
        assert.equal(url, "https://api.minimax.io/v1/coding_plan/remains");
        assert.equal(options.headers.Authorization, "Bearer TEST_MINIMAX_USAGE_KEY");
        return new Response(JSON.stringify({
          model_remains: [{
            model_name: "general",
            start_time: 1_786_564_800_000,
            end_time: 1_786_579_200_000,
            current_interval_remaining_percent: 55,
            current_weekly_remaining_percent: 40,
            weekly_end_time: 1_786_924_800_000,
          }],
          base_resp: { status_code: 0, status_msg: "success" },
        }));
      },
    });
    assert.equal(snapshot["minimax-token-plan"].status, "available");
    assert.equal(snapshot["minimax-token-plan"].metrics[0].remainingPercent, 55);
    assert.equal(snapshot["minimax-token-plan"].metrics[1].label, "Weekly limit");
    assert.doesNotMatch(JSON.stringify(snapshot), /TEST_MINIMAX_USAGE_KEY/);
  } finally {
    if (saved === undefined) delete process.env.MINIMAX_API_KEY;
    else process.env.MINIMAX_API_KEY = saved;
  }
});

test("MiniMax token plan usage surfaces an API error status", async () => {
  const saved = process.env.MINIMAX_API_KEY;
  process.env.MINIMAX_API_KEY = "TEST_MINIMAX_ERROR_KEY";
  try {
    const snapshot = await providerAccountUsageSnapshot({
      providerIds: ["minimax-token-plan"],
      fetchImpl: async () => new Response(JSON.stringify({
        base_resp: { status_code: 1004, status_msg: "invalid api key" },
      })),
    });
    assert.equal(snapshot["minimax-token-plan"].status, "unavailable");
    assert.match(snapshot["minimax-token-plan"].message, /invalid api key/);
  } finally {
    if (saved === undefined) delete process.env.MINIMAX_API_KEY;
    else process.env.MINIMAX_API_KEY = saved;
  }
});

test("MiniMax token plan usage avoids the plan API for a custom endpoint", async () => {
  const savedKey = process.env.MINIMAX_API_KEY;
  const savedBase = process.env.MINIMAX_BASE_URL;
  process.env.MINIMAX_API_KEY = "TEST_MINIMAX_CUSTOM_KEY";
  process.env.MINIMAX_BASE_URL = "https://example.test/v1";
  try {
    const snapshot = await providerAccountUsageSnapshot({
      providerIds: ["minimax-token-plan"],
      fetchImpl: async () => {
        throw new Error("custom MiniMax endpoints must not trigger plan API calls");
      },
    });
    assert.equal(snapshot["minimax-token-plan"].status, "local-only");
    assert.match(snapshot["minimax-token-plan"].message, /custom MiniMax endpoint/);
  } finally {
    if (savedKey === undefined) delete process.env.MINIMAX_API_KEY;
    else process.env.MINIMAX_API_KEY = savedKey;
    if (savedBase === undefined) delete process.env.MINIMAX_BASE_URL;
    else process.env.MINIMAX_BASE_URL = savedBase;
  }
});

test("Chutes usage reads the official account balance with Bearer auth", async () => {
  const saved = process.env.CHUTES_API_KEY;
  process.env.CHUTES_API_KEY = "TEST_CHUTES_USAGE_KEY";
  try {
    const requests = [];
    const snapshot = await providerAccountUsageSnapshot({
      providerIds: ["chutes"],
      fetchImpl: async (url, options) => {
        requests.push({ url: String(url), auth: options?.headers?.Authorization });
        return {
          ok: true,
          status: 200,
          json: async () => String(url).endsWith("/subscription_usage")
            ? {
                subscription: true,
                four_hour: { usage: 1, cap: 10, remaining: 9 },
                monthly: { usage: 20, cap: 100, remaining: 80 },
              }
            : { balance: 18.5 },
        };
      },
    });
    assert.deepEqual(requests, [
      {
        url: "https://api.chutes.ai/users/me",
        auth: "Bearer TEST_CHUTES_USAGE_KEY",
      },
      {
        url: "https://api.chutes.ai/users/me/subscription_usage",
        auth: "Bearer TEST_CHUTES_USAGE_KEY",
      },
    ]);
    assert.equal(snapshot.chutes.status, "available");
    assert.equal(snapshot.chutes.metrics[0].label, "4-hour subscription");
    assert.equal(snapshot.chutes.metrics[0].remainingPercent, 90);
    assert.equal(snapshot.chutes.metrics[2].value, 18.5);
    assert.equal(snapshot.chutes.dashboardUrl, "https://chutes.ai/app");
  } finally {
    if (saved === undefined) delete process.env.CHUTES_API_KEY;
    else process.env.CHUTES_API_KEY = saved;
  }
});

test("Chutes usage retains zero and negative balances beside subscription quotas", async () => {
  const saved = process.env.CHUTES_API_KEY;
  process.env.CHUTES_API_KEY = "TEST_CHUTES_BALANCE_KEY";
  try {
    for (const balance of [0, -4.25]) {
      const snapshot = await providerAccountUsageSnapshot({
        providerIds: ["chutes"],
        fetchImpl: async (url) => new Response(JSON.stringify(
          String(url).endsWith("/subscription_usage")
            ? {
                subscription: true,
                four_hour: { usage: 1, cap: 10, remaining: 9 },
                monthly: { usage: 2, cap: 100, remaining: 98 },
              }
            : { balance },
        )),
      });
      assert.equal(snapshot.chutes.status, "available");
      assert.equal(snapshot.chutes.metrics.at(-1).kind, "balance");
      assert.equal(snapshot.chutes.metrics.at(-1).value, balance);
    }
  } finally {
    if (saved === undefined) delete process.env.CHUTES_API_KEY;
    else process.env.CHUTES_API_KEY = saved;
  }
});

test("Chutes usage keeps whichever official account surface succeeds", async () => {
  const saved = process.env.CHUTES_API_KEY;
  process.env.CHUTES_API_KEY = "TEST_CHUTES_PARTIAL_KEY";
  try {
    const subscriptionOnly = await providerAccountUsageSnapshot({
      providerIds: ["chutes"],
      fetchImpl: async (url) => {
        if (!String(url).endsWith("/subscription_usage")) {
          return new Response("account failed", { status: 503 });
        }
        return new Response(JSON.stringify({
          subscription: true,
          four_hour: { usage: 1, cap: 5, remaining: 4 },
          monthly: { uncapped: true },
        }));
      },
    });
    assert.equal(subscriptionOnly.chutes.status, "available");
    assert.deepEqual(subscriptionOnly.chutes.metrics.map((metric) => metric.kind), ["quota"]);

    const balanceOnly = await providerAccountUsageSnapshot({
      providerIds: ["chutes"],
      fetchImpl: async (url) => {
        if (String(url).endsWith("/subscription_usage")) {
          return new Response("subscription failed", { status: 503 });
        }
        return new Response(JSON.stringify({ balance: 7.5 }));
      },
    });
    assert.equal(balanceOnly.chutes.status, "available");
    assert.deepEqual(balanceOnly.chutes.metrics.map((metric) => metric.kind), ["balance"]);
  } finally {
    if (saved === undefined) delete process.env.CHUTES_API_KEY;
    else process.env.CHUTES_API_KEY = saved;
  }
});

test("Chutes usage reports an unsubscribed account balance", async () => {
  const saved = process.env.CHUTES_API_KEY;
  process.env.CHUTES_API_KEY = "TEST_CHUTES_UNSUBSCRIBED_KEY";
  try {
    const snapshot = await providerAccountUsageSnapshot({
      providerIds: ["chutes"],
      fetchImpl: async (url) => new Response(JSON.stringify(
        String(url).endsWith("/subscription_usage")
          ? { subscription: false }
          : { balance: 0 },
      )),
    });
    assert.equal(snapshot.chutes.status, "available");
    assert.deepEqual(snapshot.chutes.metrics.map((metric) => metric.kind), ["balance"]);
    assert.equal(snapshot.chutes.metrics[0].value, 0);
  } finally {
    if (saved === undefined) delete process.env.CHUTES_API_KEY;
    else process.env.CHUTES_API_KEY = saved;
  }
});

test("Chutes usage degrades when both official account surfaces fail", async () => {
  const saved = process.env.CHUTES_API_KEY;
  process.env.CHUTES_API_KEY = "TEST_CHUTES_FAILURE_KEY";
  try {
    const snapshot = await providerAccountUsageSnapshot({
      providerIds: ["chutes"],
      fetchImpl: async () => new Response("unavailable", { status: 503 }),
    });
    assert.equal(snapshot.chutes.status, "unavailable");
    assert.deepEqual(snapshot.chutes.metrics, []);
    assert.match(snapshot.chutes.message, /usable usage or balance data/);
  } finally {
    if (saved === undefined) delete process.env.CHUTES_API_KEY;
    else process.env.CHUTES_API_KEY = saved;
  }
});

test("Chutes usage avoids official account APIs for a custom endpoint", async () => {
  const savedKey = process.env.CHUTES_API_KEY;
  const savedBase = process.env.CHUTES_API_BASE_URL;
  process.env.CHUTES_API_KEY = "TEST_CHUTES_CUSTOM_KEY";
  process.env.CHUTES_API_BASE_URL = "https://example.test/v1";
  try {
    const snapshot = await providerAccountUsageSnapshot({
      providerIds: ["chutes"],
      fetchImpl: async () => {
        throw new Error("custom Chutes endpoints must not trigger account API calls");
      },
    });
    assert.equal(snapshot.chutes.status, "local-only");
    assert.match(snapshot.chutes.message, /custom endpoint/);
  } finally {
    if (savedKey === undefined) delete process.env.CHUTES_API_KEY;
    else process.env.CHUTES_API_KEY = savedKey;
    if (savedBase === undefined) delete process.env.CHUTES_API_BASE_URL;
    else process.env.CHUTES_API_BASE_URL = savedBase;
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

test("treats a Grok period without creditUsagePercent as 0% used", () => {
  // proto3 JSON omits zero-valued fields, so a fresh weekly window arrives
  // with a currentPeriod but no creditUsagePercent at all.
  assert.deepEqual(grokCreditsMetrics({
    config: {
      currentPeriod: {
        type: "USAGE_PERIOD_TYPE_WEEKLY",
        start: "2026-08-12T04:11:10.883403+00:00",
        end: "2026-08-19T04:11:10.883403+00:00",
      },
      onDemandCap: { val: 0 },
      onDemandUsed: { val: 0 },
      prepaidBalance: { val: 0 },
      isUnifiedBillingUser: true,
    },
  }), [{
    kind: "quota",
    label: "Weekly limit",
    usedPercent: 0,
    remainingPercent: 100,
    used: 0,
    limit: 100,
    remaining: 100,
    unit: "percent",
    resetAt: 1787112670.883,
  }]);
});

test("returns no Grok metrics for a config without any billing period", () => {
  assert.deepEqual(grokCreditsMetrics({ config: { isUnifiedBillingUser: true } }), []);
});

test("normalizes Command Code plan windows and skips a zero resetAt", () => {
  assert.deepEqual(commandCodeCreditsMetrics({
    credits: { monthlyCredits: 10, purchasedCredits: 0, freeCredits: 0 },
    windowLimits: {
      limited: true,
      fiveHour: { used: 0, cap: 3, exceeded: false, resetAt: 0 },
      weekly: { used: 0, cap: 6, exceeded: false, resetAt: 1_786_579_200_000 },
    },
  }), [
    {
      kind: "quota",
      label: "5-hour limit",
      usedPercent: 0,
      remainingPercent: 100,
      used: 0,
      limit: 3,
      remaining: 3,
      unit: "credits",
    },
    {
      kind: "quota",
      label: "Weekly limit",
      usedPercent: 0,
      remainingPercent: 100,
      used: 0,
      limit: 6,
      remaining: 6,
      unit: "credits",
      resetAt: 1_786_579_200,
    },
  ]);
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

// The balance probe used to be pinned to the global provider id. Both Moonshot
// platforms answer /users/me/balance, in their own currency, from their own
// account -- so it is parameterized and each provider must reach its own host.
test("the China Kimi platform is probed on its own host and currency", async () => {
  const requested = [];
  process.env.KIMI_API_CN_KEY = "TEST_KIMI_CN_KEY";
  delete process.env.KIMI_API_CN_BASE_URL;
  try {
    const snapshot = await providerAccountUsageSnapshot({
      providerIds: ["kimi-api-cn"],
      fetchImpl: async (url) => {
        requested.push(String(url));
        return {
          ok: true,
          status: 200,
          json: async () => ({
            code: 0,
            status: true,
            data: { available_balance: 3.5, cash_balance: 3.5, voucher_balance: 0 },
          }),
        };
      },
    });
    assert.deepEqual(requested, ["https://api.moonshot.cn/v1/users/me/balance"]);
    assert.equal(snapshot["kimi-api-cn"].status, "available");
    assert.equal(snapshot["kimi-api-cn"].metrics[0].currency, "CNY");
  } finally {
    delete process.env.KIMI_API_CN_KEY;
  }
});
