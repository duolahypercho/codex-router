import assert from "node:assert/strict";
import test from "node:test";

import { aggregateProviderUsage } from "../src/provider-usage.mjs";

test("protocol variants never appear as separate usage providers", () => {
  const snapshot = aggregateProviderUsage([], { now: Date.parse("2026-07-21T18:00:00Z") });
  const ids = snapshot.providers.map((provider) => provider.id);
  assert.ok(ids.includes("opencode-go"));
  assert.ok(!ids.includes("opencode-go-messages"));
  assert.ok(!ids.includes("opencode-go-responses"));
  assert.ok(ids.includes("commandcode"));
  assert.ok(!ids.includes("commandcode-messages"));
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
  assert.equal(byId["opencode-free"].credentialType, "anonymous");
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
        durationMs: 2_000,
        firstTokenMs: 500,
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
        durationMs: 4_000,
        firstTokenMs: 1_500,
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
        durationMs: 100,
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
  assert.equal(flash.observedTokensPerSecond, 26.7);
  assert.equal(flash.speedSampleCount, 1);
  assert.equal(flash.lastUsedAt, "2026-07-21T12:00:00.000Z");

  // Per-model totals must reconcile with the provider rollup they came from.
  const summed = deepseek.models.reduce((total, model) => total + model.totalTokens, 0);
  assert.equal(summed, deepseek.totalTokens);
});

test("reports no observed speed when successful requests have no metered output", () => {
  const now = Date.parse("2026-07-21T18:00:00Z");
  const snapshot = aggregateProviderUsage(
    [
      {
        meteringVersion: 1,
        at: "2026-07-21T12:00:00Z",
        provider: "deepseek",
        model: "deepseek/deepseek-v4-flash",
        status: 200,
        durationMs: 1_000,
        inputTokens: 100,
        totalTokens: 100,
      },
    ],
    { days: 7, now },
  );
  const model = snapshot.providers
    .find((provider) => provider.id === "deepseek")
    .models[0];

  assert.equal(model.observedTokensPerSecond, null);
  assert.equal(model.speedSampleCount, 0);
});

test("uses only the latest 20 clean generation timings for observed speed", () => {
  const now = Date.parse("2026-07-21T18:00:00Z");
  const events = Array.from({ length: 22 }, (_, index) => ({
    meteringVersion: 1,
    at: new Date(now - (21 - index) * 60_000).toISOString(),
    provider: "deepseek",
    model: "deepseek/deepseek-v4-flash",
    status: 200,
    durationMs: index < 2 ? 11_000 : 3_000,
    firstTokenMs: 1_000,
    outputTokens: 100,
    totalTokens: 100,
  }));
  // These rows must not become speed samples: historical rows have no
  // response-start timing, and retries do not describe one clean stream.
  events.push({
    ...events.at(-1),
    at: new Date(now - 500).toISOString(),
    firstTokenMs: undefined,
  });
  events.push({
    ...events.at(-1),
    at: new Date(now).toISOString(),
    firstTokenMs: 1_000,
    retries: 1,
  });

  const model = aggregateProviderUsage(events, { days: 7, now }).providers
    .find((provider) => provider.id === "deepseek")
    .models[0];

  assert.equal(model.speedSampleCount, 20);
  assert.equal(model.observedTokensPerSecond, 50);
});

test("accepts a response that starts within the first measured millisecond", () => {
  const now = Date.parse("2026-07-21T18:00:00Z");
  const model = aggregateProviderUsage(
    [
      {
        meteringVersion: 1,
        at: new Date(now).toISOString(),
        provider: "deepseek",
        model: "deepseek/deepseek-v4-flash",
        status: 200,
        durationMs: 2_000,
        firstTokenMs: 0,
        outputTokens: 100,
      },
    ],
    { days: 7, now },
  ).providers
    .find((provider) => provider.id === "deepseek")
    .models[0];

  assert.equal(model.speedSampleCount, 1);
  assert.equal(model.observedTokensPerSecond, 50);
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

// Output tokens per second is the rate after the first token, with the wait
// before it reported separately -- the definition every published benchmark
// uses. Dividing by time-since-headers instead put a reasoning model's silent
// thinking in the denominator, so the same model read at 12 tok/s on a short
// reply and 69 on a long one.
test("the observed rate does not move with reply length", () => {
  const at = new Date().toISOString();
  const reply = (outputTokens) => ({
    meteringVersion: 1,
    at,
    model: "gpt-x",
    provider: "openai",
    status: 200,
    inputTokens: 10,
    outputTokens,
    totalTokens: 10 + outputTokens,
    responseStartMs: 700,
    firstTokenMs: 2900,
    // 2.9s of thinking, then a steady 80 tokens/second.
    durationMs: 2900 + Math.round(outputTokens * 12.5),
  });

  const short = aggregateProviderUsage([reply(31)]).providers[0].models[0];
  const long = aggregateProviderUsage([reply(426)]).providers[0].models[0];
  assert.equal(Math.round(short.observedTokensPerSecond), 80);
  assert.equal(Math.round(long.observedTokensPerSecond), 80);
});

test("time to first token is reported on its own", () => {
  const at = new Date().toISOString();
  const events = [1200, 2900, 5000].map((firstTokenMs) => ({
    meteringVersion: 1,
    at,
    model: "gpt-x",
    provider: "openai",
    status: 200,
    inputTokens: 10,
    outputTokens: 100,
    totalTokens: 110,
    firstTokenMs,
    durationMs: firstTokenMs + 1000,
  }));
  const model = aggregateProviderUsage(events).providers[0].models[0];
  // Median, so one cold start cannot drag it.
  assert.equal(model.observedFirstTokenMs, 2900);
});

test("a first token that outlives its own request is not sampled", () => {
  const model = aggregateProviderUsage([{
    meteringVersion: 1,
    at: new Date().toISOString(),
    model: "gpt-x",
    provider: "openai",
    status: 200,
    inputTokens: 10,
    outputTokens: 100,
    totalTokens: 110,
    firstTokenMs: 5000,
    durationMs: 1000,
  }]).providers[0].models[0];
  assert.equal(model.observedTokensPerSecond, null);
  assert.equal(model.observedFirstTokenMs, null);
});

test("rows recorded before first-token timing are unmeasured, not wrong", () => {
  const model = aggregateProviderUsage([{
    meteringVersion: 1,
    at: new Date().toISOString(),
    model: "gpt-x",
    provider: "openai",
    status: 200,
    inputTokens: 10,
    outputTokens: 100,
    totalTokens: 110,
    responseStartMs: 200,
    durationMs: 1000,
  }]).providers[0].models[0];
  assert.equal(model.observedTokensPerSecond, null);
  assert.equal(model.observedFirstTokenMs, null);
});
