import assert from "node:assert/strict";
import test from "node:test";

import {
  deepSeekBalanceMetrics,
  kimiApiBalanceMetrics,
  kimiQuotaMetrics,
  providerAccountUsageSnapshot,
} from "../src/provider-account-usage.mjs";

test("normalizes Kimi weekly and five-hour quota windows", () => {
  assert.deepEqual(kimiQuotaMetrics({
    usage: { limit: "2048", used: "214", remaining: "1834", resetTime: "2026-07-25T00:00:00Z" },
    limits: [{ detail: { limit: 200, used: 139, remaining: 61 } }],
  }), [
    {
      kind: "quota",
      label: "Weekly quota",
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
