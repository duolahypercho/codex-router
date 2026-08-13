import assert from "node:assert/strict";
import test from "node:test";

import {
  buildQuotaCards,
  chartGeometry,
  compactTokens,
  dailySeries,
  observedModelSpeed,
  quotaWindow,
  visibleLocalDownload,
} from "../apps/desktop/ui/model.mjs";
import { availableLanguages, getLanguage, setLanguage, t, translationKeys } from "../apps/desktop/ui/i18n.mjs";

test("desktop usage series fills missing local calendar days", () => {
  const series = dailySeries(
    [
      { startDate: "2026-07-19", tokens: 2_400 },
      { startDate: "2026-07-21", tokens: 8_100 },
    ],
    3,
    new Date(2026, 6, 21, 18),
  );

  assert.deepEqual(
    series.map(({ key, tokens }) => ({ key, tokens })),
    [
      { key: "2026-07-19", tokens: 2_400 },
      { key: "2026-07-20", tokens: 0 },
      { key: "2026-07-21", tokens: 8_100 },
    ],
  );
});

test("quota windows use one weekly label and a distinct five-hour label", () => {
  assert.deepEqual(quotaWindow({ label: "Weekly requests" }), {
    key: "weekly",
    label: "Weekly limit",
  });
  assert.deepEqual(quotaWindow({ windowDurationMins: 300 }), {
    key: "five-hour",
    label: "5-hour limit",
  });
});

test("quota cards omit unconfigured providers and de-duplicate synonymous windows", () => {
  const cards = buildQuotaCards({
    providerSetup: {
      providers: [
        { id: "kimi-oauth", configured: true },
        { id: "grok-api", configured: false },
      ],
    },
    providerUsage: {
      providers: [
        {
          id: "kimi-oauth",
          displayName: "Kimi OAuth",
          account: {
            metrics: [
              { kind: "quota", label: "Weekly requests", usedPercent: 48 },
              { kind: "quota", label: "Week", usedPercent: 48 },
              { kind: "quota", label: "5 hour", usedPercent: 3 },
            ],
          },
        },
        {
          id: "grok-api",
          displayName: "Grok API",
          account: { metrics: [{ kind: "quota", label: "Weekly", usedPercent: 20 }] },
        },
      ],
    },
  });

  assert.deepEqual(
    cards.map(({ providerId, label }) => ({ providerId, label })),
    [
      { providerId: "kimi-oauth", label: "Weekly limit" },
      { providerId: "kimi-oauth", label: "5-hour limit" },
    ],
  );
});

test("chart geometry stays finite for an empty week", () => {
  const geometry = chartGeometry(Array.from({ length: 7 }, () => ({ tokens: 0 })));
  assert.match(geometry.line, /^M /);
  assert.equal(geometry.points.length, 7);
  assert.ok(geometry.points.every(({ x, y }) => Number.isFinite(x) && Number.isFinite(y)));
});

test("token counts remain compact without hiding small values", () => {
  assert.equal(compactTokens(983), "983");
  assert.equal(compactTokens(1_250), "1.3k");
  assert.equal(compactTokens(28_800), "29k");
  assert.equal(compactTokens(2_500_000), "2.5m");
});

test("completed local downloads disappear when the model is no longer installed", () => {
  const done = { tag: "gemma4:12b", status: "done", percent: 100 };
  assert.equal(visibleLocalDownload({ models: [], download: done }), null);
  assert.deepEqual(
    visibleLocalDownload({ models: [{ tag: "gemma4:12b" }], download: done }),
    done,
  );
  const active = { tag: "gemma4:12b", status: "downloading", percent: 42 };
  assert.deepEqual(visibleLocalDownload({ models: [], download: active }), active);
});

test("active model speed prefers its provider and matches qualified slugs", () => {
  const usage = {
    providers: [
      {
        id: "deepseek",
        models: [
          {
            slug: "deepseek/deepseek-v4-flash",
            displayName: "deepseek-v4-flash",
            observedTokensPerSecond: 18.7,
            speedSampleCount: 4,
          },
        ],
      },
    ],
  };
  assert.deepEqual(observedModelSpeed(usage, "deepseek", "deepseek/deepseek-v4-flash"), {
    speed: 18.7,
    samples: 4,
  });
  usage.providers[0].models[0].observedTokensPerSecond = null;
  assert.equal(observedModelSpeed(usage, "deepseek", "deepseek/deepseek-v4-flash"), null);
  assert.equal(observedModelSpeed(usage, "deepseek", "missing/model"), null);
});

test("desktop UI exposes English and Simplified Chinese translations", () => {
  assert.deepEqual(availableLanguages().map(({ id }) => id), ["en", "zh-CN"]);
  const keys = translationKeys();
  assert.deepEqual([...keys.en].sort(), [...keys["zh-CN"]].sort());
  try {
    setLanguage("zh-CN");
    assert.equal(getLanguage(), "zh-CN");
    assert.equal(t("nav.usage"), "用量");
    assert.equal(t("usage.resetsToday", { time: "10:30" }), "今天 10:30 重置");
  } finally {
    setLanguage("en");
  }
  assert.equal(t("nav.usage"), "Usage");
});
