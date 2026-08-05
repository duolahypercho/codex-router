import assert from "node:assert/strict";
import test from "node:test";

import { aggregateProviderUsage } from "../src/provider-usage.mjs";

test("protocol variants never appear as separate usage providers", () => {
  const snapshot = aggregateProviderUsage([], { now: Date.parse("2026-07-21T18:00:00Z") });
  const ids = snapshot.providers.map((provider) => provider.id);
  assert.ok(ids.includes("opencode-go"));
  assert.ok(!ids.includes("opencode-go-messages"));
  assert.ok(!ids.includes("opencode-go-responses"));
});

test("aggregates tokens and calls independently for each provider", () => {
  const now = Date.parse("2026-07-21T18:00:00Z");
  const snapshot = aggregateProviderUsage(
    [
      {
        meteringVersion: 1,
        at: "2026-07-20T12:00:00Z",
        provider: "grok-oauth",
        status: 200,
        inputTokens: 100,
        outputTokens: 40,
        totalTokens: 140,
      },
      {
        meteringVersion: 1,
        at: "2026-07-21T12:00:00Z",
        provider: "grok-oauth",
        status: 500,
      },
      {
        meteringVersion: 1,
        at: "2026-07-21T13:00:00Z",
        provider: "deepseek",
        status: 200,
        inputTokens: 80,
        outputTokens: 20,
        totalTokens: 100,
      },
      {
        at: "2026-07-21T14:00:00Z",
        provider: "kimi-api",
        status: 200,
      },
    ],
    { days: 7, now },
  );
  const byId = Object.fromEntries(snapshot.providers.map((provider) => [provider.id, provider]));

  assert.equal(byId["grok-oauth"].credentialType, "oauth");
  assert.equal(byId["grok-oauth"].requests, 2);
  assert.equal(byId["grok-oauth"].successfulRequests, 1);
  assert.equal(byId["grok-oauth"].meteredRequests, 1);
  assert.equal(byId["grok-oauth"].totalTokens, 140);
  assert.deepEqual(byId["grok-oauth"].dailyUsageBuckets, [
    { startDate: "2026-07-20", tokens: 140, requests: 1 },
    { startDate: "2026-07-21", tokens: 0, requests: 1 },
  ]);
  assert.equal(byId.deepseek.credentialType, "api");
  assert.equal(byId.deepseek.totalTokens, 100);
  assert.equal(byId["kimi-api"].requests, 0);
  assert.equal(snapshot.scope, "local-router");
});

test("breaks provider usage down by model, heaviest first", () => {
  const now = Date.parse("2026-07-21T18:00:00Z");
  const snapshot = aggregateProviderUsage(
    [
      {
        meteringVersion: 1,
        at: "2026-07-20T12:00:00Z",
        provider: "deepseek",
        model: "deepseek/deepseek-v4-flash",
        status: 200,
        inputTokens: 100,
        outputTokens: 40,
        totalTokens: 140,
      },
      {
        meteringVersion: 1,
        at: "2026-07-21T09:00:00Z",
        provider: "deepseek",
        model: "deepseek/deepseek-v4-pro",
        status: 200,
        inputTokens: 900,
        outputTokens: 100,
        totalTokens: 1_000,
      },
      {
        meteringVersion: 1,
        at: "2026-07-21T12:00:00Z",
        provider: "deepseek",
        model: "deepseek/deepseek-v4-flash",
        status: 500,
        inputTokens: 10,
        outputTokens: 0,
        totalTokens: 10,
      },
    ],
    { days: 7, now },
  );
  const deepseek = snapshot.providers.find((provider) => provider.id === "deepseek");

  assert.deepEqual(
    deepseek.models.map((model) => model.slug),
    ["deepseek/deepseek-v4-pro", "deepseek/deepseek-v4-flash"],
  );

  const flash = deepseek.models.find((model) => model.slug === "deepseek/deepseek-v4-flash");
  assert.equal(flash.displayName, "deepseek-v4-flash");
  assert.equal(flash.requests, 2);
  assert.equal(flash.successfulRequests, 1);
  assert.equal(flash.totalTokens, 150);
  assert.equal(flash.inputTokens, 110);
  assert.equal(flash.lastUsedAt, "2026-07-21T12:00:00.000Z");

  // Per-model totals must reconcile with the provider rollup they came from.
  const summed = deepseek.models.reduce((total, model) => total + model.totalTokens, 0);
  assert.equal(summed, deepseek.totalTokens);
});

test("keeps unlabeled model traffic visible instead of dropping it", () => {
  const now = Date.parse("2026-07-21T18:00:00Z");
  const snapshot = aggregateProviderUsage(
    [
      {
        meteringVersion: 1,
        at: "2026-07-21T12:00:00Z",
        provider: "grok-oauth",
        status: 200,
        totalTokens: 25,
      },
    ],
    { days: 7, now },
  );
  const grok = snapshot.providers.find((provider) => provider.id === "grok-oauth");

  assert.deepEqual(grok.models.map((model) => model.slug), ["unknown"]);
  assert.equal(grok.models[0].totalTokens, 25);
});
