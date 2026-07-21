import assert from "node:assert/strict";
import test from "node:test";

import { aggregateProviderUsage } from "../src/provider-usage.mjs";

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
