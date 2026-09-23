import assert from "node:assert/strict";
import { test } from "node:test";

const { resolveAvailabilityCache, withdrawnListedRoutes } = await import("../src/model-catalog-cache.mjs");

const NOW = Date.parse("2026-09-18T12:00:00.000Z");
const FRESH = new Date(NOW - 60 * 60 * 1000).toISOString();
const STALE = new Date(NOW - 25 * 60 * 60 * 1000).toISOString();

function route(slug, provider, upstreamModel) {
  return { slug, provider, upstreamModel };
}

function cache(discovered, fetchedAt = FRESH) {
  return { discovered, fetchedAt };
}

test("flags a listed route its provider no longer advertises", () => {
  const withdrawn = withdrawnListedRoutes(
    [route("vendor/retired-preview", "vendor", "upstream/retired-preview")],
    { vendor: cache(["upstream/other-model"]) },
    NOW,
  );
  assert.deepEqual(withdrawn, [
    {
      slug: "vendor/retired-preview",
      provider: "vendor",
      upstreamModel: "upstream/retired-preview",
    },
  ]);
});

test("stays silent for advertised routes and other providers", () => {
  const withdrawn = withdrawnListedRoutes(
    [
      route("vendor/live-model", "vendor", "upstream/live-model"),
      route("other/live-model", "other", "upstream/live-model"),
    ],
    {
      vendor: cache(["upstream/live-model", "upstream/other-model"]),
    },
    NOW,
  );
  assert.deepEqual(withdrawn, []);
});

test("fails open on stale, empty, or missing catalog evidence", () => {
  const routes = [route("vendor/maybe-live", "vendor", "upstream/maybe-live")];
  assert.deepEqual(
    withdrawnListedRoutes(routes, { vendor: cache(["upstream/other"], STALE) }, NOW),
    [],
  );
  assert.deepEqual(
    withdrawnListedRoutes(routes, { vendor: cache([]) }, NOW),
    [],
  );
  assert.deepEqual(withdrawnListedRoutes(routes, {}, NOW), []);
  assert.deepEqual(
    withdrawnListedRoutes(routes, { vendor: cache(["upstream/other"], "not-a-date") }, NOW),
    [],
  );
});

test("ignores routes without an authoritative upstream identity", () => {
  const withdrawn = withdrawnListedRoutes(
    [
      { slug: "local/scratch", provider: "local", upstreamModel: "" },
      { slug: "custom/endpoint", provider: "custom" },
      { slug: "", provider: "vendor", upstreamModel: "upstream/gone" },
    ],
    { vendor: cache(["upstream/other-model"]), local: cache(["x"]), custom: cache(["y"]) },
    NOW,
  );
  assert.deepEqual(withdrawn, []);
});

test("a returning model clears the warning without any removal", () => {  const routes = [route("vendor/comeback", "vendor", "upstream/comeback")];
  assert.equal(
    withdrawnListedRoutes(routes, { vendor: cache(["upstream/other"]) }, NOW).length,
    1,
  );
  assert.deepEqual(
    withdrawnListedRoutes(
      routes,
      { vendor: cache(["upstream/other", "upstream/comeback"]) },
      NOW,
    ),
    [],
  );
});

function providersMap(entries) {
  return new Map(entries.map(([id, value]) => [id, value]));
}

test("resolveAvailabilityCache prefers the provider's own entry", () => {
  const own = { discovered: ["a"], fetchedAt: FRESH };
  const seen = [];
  const entry = resolveAvailabilityCache("vendor", {
    readCache: (id) => {
      seen.push(id);
      return id === "vendor" ? own : undefined;
    },
    providers: providersMap([["vendor", { baseUrl: "https://x.test" }]]),
  });
  assert.equal(entry, own);
  assert.deepEqual(seen, ["vendor"]);
});

test("resolveAvailabilityCache falls back only within the same endpoint", () => {
  const ownerEntry = { discovered: ["a"], fetchedAt: FRESH };
  const providers = providersMap([
    ["owner", { baseUrl: "https://same.test/v1" }],
    ["override", { baseUrl: "https://same.test/v1", variantOf: "owner" }],
    ["other-endpoint", { baseUrl: "https://other.test/v1", variantOf: "owner" }],
  ]);
  const readCache = (id) => (id === "owner" ? ownerEntry : undefined);
  assert.equal(
    resolveAvailabilityCache("override", { readCache, providers }),
    ownerEntry,
  );
  assert.equal(
    resolveAvailabilityCache("other-endpoint", { readCache, providers }),
    undefined,
  );
  assert.equal(
    resolveAvailabilityCache("unknown", { readCache, providers }),
    undefined,
  );
});
