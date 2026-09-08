import assert from "node:assert/strict";
import test from "node:test";

import { accountBucketsWithRouterFallback } from "../apps/control-center/src/lib.ts";
import { LANGUAGE_OPTIONS, translate } from "../apps/control-center/src/i18n.ts";

test("account usage fills only absent OpenAI dates from the local router", () => {
  const buckets = accountBucketsWithRouterFallback(
    [
      { startDate: "2026-08-26", tokens: 260 },
      { startDate: "2026-08-28", tokens: 280 },
    ],
    [
      { startDate: "2026-08-27", tokens: 27_000, requests: 3, inputTokens: 25_000, outputTokens: 2_000 },
      { startDate: "2026-08-28", tokens: 99_999, requests: 9 },
    ],
  );

  assert.deepEqual(buckets, [
    { startDate: "2026-08-26", tokens: 260, displaySource: "account" },
    {
      startDate: "2026-08-27",
      tokens: 27_000,
      requests: 3,
      inputTokens: 25_000,
      outputTokens: 2_000,
      displaySource: "router-fallback",
    },
    { startDate: "2026-08-28", tokens: 280, displaySource: "account" },
  ]);
});

test("an OpenAI zero bucket remains authoritative over local traffic", () => {
  const buckets = accountBucketsWithRouterFallback(
    [{ startDate: "2026-08-27", tokens: 0 }],
    [{ startDate: "2026-08-27", tokens: 27_000 }],
  );

  assert.deepEqual(buckets, [
    { startDate: "2026-08-27", tokens: 0, displaySource: "account" },
  ]);
});

test("dates absent from both streams are not invented", () => {
  const buckets = accountBucketsWithRouterFallback(
    [{ startDate: "2026-08-26", tokens: 260 }],
    [],
  );

  assert.deepEqual(buckets.map((bucket) => bucket.startDate), ["2026-08-26"]);
});

test("fallback provenance is translated in every control-center language", () => {
  const keys = [
    "usage.fallback.source",
    "usage.fallback.chartDescription",
    "usage.fallback.chartDescriptionOne",
    "usage.fallback.detail",
    "usage.fallback.detailOne",
    "usage.fallback.summary",
    "usage.fallback.chartAria",
    "usage.fallback.chartAriaOne",
    "usage.fallback.legend",
    "usage.fallback.point",
    "usage.fallback.tooltip",
    "usage.fallback.lastSeven",
  ];
  for (const { id } of LANGUAGE_OPTIONS) {
    for (const key of keys) {
      const localized = translate(id, key, {
        name: "ChatGPT",
        count: 2,
        total: "300",
        account: "100",
        fallback: "200",
      });
      assert.doesNotMatch(localized, /\{(?:name|count|total|account|fallback)\}/, `${key} was not formatted in ${id}`);
      if (id !== "en") assert.notEqual(localized, translate("en", key), `${key} fell back to English in ${id}`);
    }
    for (const singularKey of [
      "usage.fallback.chartDescriptionOne",
      "usage.fallback.detailOne",
      "usage.fallback.chartAriaOne",
    ]) {
      const singular = translate(id, singularKey, { name: "ChatGPT", count: 1 });
      if (id === "en") assert.doesNotMatch(singular, /1 dates\b/);
    }
  }
});

test("the daily window is walked in UTC days, the day space every bucket key uses", async () => {
  const { bucketRange } = await import("../apps/control-center/src/lib.ts");
  const utcToday = new Date().toISOString().slice(0, 10);
  const range = bucketRange([{ startDate: utcToday, tokens: 4_242 }], 7);

  assert.equal(range.length, 7);
  // Keys must be plain UTC calendar days, ascending, ending on the current one.
  assert.ok(range.every((bucket) => /^\d{4}-\d{2}-\d{2}$/.test(bucket.startDate)));
  assert.deepEqual(range.map((bucket) => bucket.startDate).slice().sort(), range.map((bucket) => bucket.startDate));
  assert.equal(range.at(-1).startDate, utcToday);
  // The newest slot has to find today's account bucket. Walking local days
  // asked for a key the UTC-keyed stream has not written yet whenever the
  // machine is east of UTC, which read as a confident zero all morning.
  assert.equal(range.at(-1).tokens, 4_242);
});
