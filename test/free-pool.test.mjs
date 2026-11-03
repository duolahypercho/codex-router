import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

const stateDir = mkdtempSync(path.join(os.tmpdir(), "free-pool-test-"));
process.env.MODEL_ROUTER_STATE_DIR = stateDir;
process.env.CODEX_ROUTER_STATE_DIR = stateDir;

const catalogModule = await import("../src/free-pool-catalog.mjs");
const pool = await import("../src/free-pool.mjs");
const { MODELS, MODEL_BY_SLUG } = await import("../src/model-registry.mjs");
const { usageDiagnosticMetadata } = await import("../src/request-diagnostics.mjs");

const {
  STATIC_FREE_POOL_CATALOG,
  freePoolMemberModels,
  parseKiloFreeModels,
  parseOpenCodeFreeModels,
  readFreePoolCatalog,
} = catalogModule;

test("free/auto is the only listed free-pool model; its members stay out of the picker", () => {
  const entry = MODEL_BY_SLUG.get("free/auto");
  assert.equal(entry.listed, true);
  assert.equal(entry.freePool, true);
  assert.equal(entry.upstreamModel, "kilo-auto/free");
  const members = MODELS.filter((model) => model.freePoolMember === true);
  assert.ok(members.length >= 2);
  for (const member of members) {
    assert.equal(member.listed, false, member.slug);
    assert.equal(member.failoverCandidate, false, member.slug);
    assert.ok(["free", "free-opencode"].includes(member.provider), member.slug);
  }
  const listedFree = MODELS.filter((model) => model.listed && ["free", "free-opencode"].includes(model.provider));
  assert.deepEqual(listedFree.map((model) => model.slug), ["free/auto"]);
});

test("Kilo listing keeps only free, tool-capable text models and never re-adds the pool entry", () => {
  const members = parseKiloFreeModels({
    data: [
      { id: "kilo-auto/free", isFree: true, supported_parameters: ["tools"] },
      { id: "vendor/good:free", isFree: true, context_length: 131072, supported_parameters: ["tools"], preferredIndex: 2 },
      { id: "vendor/priced:free", isFree: false, pricing: { prompt: "0.000001", completion: "0" }, supported_parameters: ["tools"] },
      { id: "vendor/zero-free", pricing: { prompt: "0", completion: "0" }, supported_parameters: ["tools"] },
      { id: "vendor/notools:free", isFree: true, supported_parameters: ["temperature"] },
      { id: "vendor/image-only:free", isFree: true, supported_parameters: ["tools"], architecture: { output_modalities: ["image"] } },
      { id: "stealth/glyph-cluster", isFree: true, supported_parameters: ["tools"] },
      { id: "vendor/good:free", isFree: true, supported_parameters: ["tools"] },
    ],
  });
  assert.deepEqual(members.map((member) => member.id), ["vendor/good:free", "vendor/zero-free"]);
  assert.equal(members[0].contextLength, 131072);
  assert.equal(members[0].preferredIndex, 2);
});

test("OpenCode listing keeps free chat models and drops priced, tool-less, or withdrawn ones", () => {
  const members = parseOpenCodeFreeModels({
    data: [
      // big-pickle is free-lane reachable with the public CLI fingerprint;
      // hy3-free has been withdrawn and stays out.
      { id: "big-pickle", limit: { context: 200000 } },
      { id: "hy3-free" },
      { id: "some-model-free", cost: { input: 0, output: 0 } },
      { id: "paid-model-free", cost: { input: 1, output: 2 } },
      {
        id: "nested-free",
        cost: { text: { input: { price: 0 }, output: { price: 0 } } },
        limit: { context: 131072 },
      },
      {
        id: "nested-paid-free",
        cost: { text: { input: { price: 1 }, output: { price: 2 } } },
      },
      { id: "claude-sonnet" },
      { id: "notools-free", capabilities: { tools: { supported: false } } },
    ],
  });
  assert.deepEqual(members.map((member) => member.id), [
    "big-pickle",
    "some-model-free",
    "nested-free",
  ]);
  assert.equal(members[0].contextLength, 200000);
});

test("member order: Kilo preference, then window; the catch-all router and small windows go last", () => {
  const members = freePoolMemberModels({
    kilo: [
      { id: "openrouter/free", contextLength: 200000, preferredIndex: 0 },
      { id: "a/small:free", contextLength: 32000, preferredIndex: 1 },
      { id: "b/big:free", contextLength: 1000000 },
      { id: "c/pref:free", contextLength: 131072, preferredIndex: 3 },
    ],
    opencode: [{ id: "big-pickle", contextLength: 200000 }],
  });
  assert.deepEqual(members.map((member) => member.slug), [
    "free/c/pref:free",
    "free/b/big:free",
    "free/openrouter/free",
    "free/a/small:free",
    "free-opencode/big-pickle",
  ]);
  assert.equal(members[0].gatewayModel, "free-kilo-c-pref-free");
  assert.equal(members[4].gatewayModel, "free-opencode-big-pickle");
});

test("a damaged or empty catalog cache falls back to the static member list", () => {
  const file = path.join(stateDir, "catalog-damaged.json");
  writeFileSync(file, "{not json");
  assert.equal(readFreePoolCatalog({ file }), STATIC_FREE_POOL_CATALOG);
  writeFileSync(file, JSON.stringify({ version: 1, kilo: [{ id: "paid/model" }], opencode: [] }));
  assert.equal(readFreePoolCatalog({ file }), STATIC_FREE_POOL_CATALOG);
  writeFileSync(file, JSON.stringify({ version: 1, fetchedAt: "2026-10-30T00:00:00.000Z", kilo: [{ id: "x/y:free" }], opencode: [] }));
  const live = readFreePoolCatalog({ file });
  assert.equal(live.source, "live");
  assert.deepEqual(live.kilo.map((entry) => entry.id), ["x/y:free"]);
});

test("route order starts with the pool entry and honors the prefer override", () => {
  const order = pool.freePoolRouteOrder({ env: {} });
  assert.equal(order[0].slug, "free/auto");
  assert.ok(order.length >= 3);
  const last = order.at(-1);
  const preferred = pool.freePoolRouteOrder({ env: { MODEL_ROUTER_FREE_POOL_PREFER: `${last.upstreamModel}, missing/model` } });
  assert.equal(preferred[0].slug, last.slug);
  assert.equal(preferred[1].slug, "free/auto");
  assert.equal(preferred.length, order.length);
});

test("classification: rate limits, quota, outages and timeouts move; a plain bad request does not", () => {
  const cases = [
    [{ status: 429, bodyText: "FreeUsageLimitError: free usage exceeded" }, true, "free_quota", 3_600_000],
    [{ status: 429, headers: { "retry-after": "5" } }, true, "rate_limited", 30_000],
    [{ status: 429, headers: { "retry-after": "120" } }, true, "rate_limited", 120_000],
    [{ status: 429 }, true, "rate_limited", 600_000],
    [{ status: 402 }, true, "payment_required"],
    [{ status: 401 }, true, "refused_anonymous"],
    [{ status: 404 }, true, "model_unavailable"],
    [{ status: 0 }, true, "timeout_or_transport"],
    [{ status: 503, bodyText: "no upstreams available" }, true, "model_unavailable", 600_000],
    [{ status: 500 }, true, "upstream_error", 120_000],
    [{ status: 400, bodyText: "model is not available" }, true, "model_unavailable"],
    [{ status: 400, bodyText: "invalid tool schema" }, false, "request_rejected"],
  ];
  for (const [input, swap, reason, drainMs] of cases) {
    const verdict = pool.classifyFreePoolFailure(input);
    assert.equal(verdict.swap, swap, JSON.stringify(input));
    assert.equal(verdict.reason, reason, JSON.stringify(input));
    if (drainMs !== undefined) assert.equal(verdict.drainMs, drainMs, JSON.stringify(input));
  }
});

test("drains skip a member until they expire, and clearing restores it", () => {
  pool.clearAllFreePoolDrains();
  const order = pool.freePoolRouteOrder({ env: {} });
  const now = Date.parse("2026-10-30T00:00:00.000Z");
  pool.drainFreePoolMember(order[0].slug, { ms: 60_000, reason: "rate_limited", status: 429, now });
  const available = pool.availableFreePoolRoutes({ env: {}, now: now + 1000 });
  assert.equal(available[0].slug, order[1].slug);
  assert.equal(available.length, order.length - 1);
  assert.equal(pool.availableFreePoolRoutes({ env: {}, now: now + 61_000 }).length, order.length);
  assert.equal(pool.soonestFreePoolRetry({ now: now + 1000 }), "2026-10-30T00:01:00.000Z");
  assert.equal(pool.clearFreePoolDrain(order[0].slug), true);
  assert.equal(pool.availableFreePoolRoutes({ env: {}, now: now + 1000 }).length, order.length);
  // A drain is capped at twelve hours whatever the caller asks for.
  const capped = pool.drainFreePoolMember(order[1].slug, { ms: 99 * 3_600_000, now });
  assert.equal(capped.until, "2026-10-30T12:00:00.000Z");
  pool.clearAllFreePoolDrains();
});

test("a disabled lane drops out of the available routes", () => {
  pool.clearAllFreePoolDrains();
  const available = pool.availableFreePoolRoutes({ env: {}, providerEnabled: (id) => id === "free" });
  assert.ok(available.length > 0);
  assert.ok(available.every((model) => model.provider === "free"));
});

test("exhausted error names the pool and the first member's return", () => {
  pool.clearAllFreePoolDrains();
  const now = Date.now();
  for (const model of pool.freePoolRouteOrder({ env: {} })) {
    pool.drainFreePoolMember(model.slug, { ms: 300_000, reason: "free_quota", status: 429, now });
  }
  assert.equal(pool.availableFreePoolRoutes({ env: {} }).length, 0);
  const body = pool.freePoolExhaustedError({});
  assert.equal(body.error.code, "free_pool_exhausted");
  assert.match(body.error.message, /free\/auto/);
  assert.ok(body.error.retry_at);
  pool.clearAllFreePoolDrains();
});

test("catalog refresh reads both public listings, keeps a failed lane, and writes the cache", async () => {
  const file = path.join(stateDir, "catalog-refresh.json");
  rmSync(file, { force: true });
  const seen = [];
  const fetchImpl = async (url, init) => {
    seen.push([url, init.headers["User-Agent"]]);
    if (url.includes("kilo")) {
      return new Response(JSON.stringify({ data: [{ id: "new/model:free", isFree: true, supported_parameters: ["tools"] }] }), { status: 200 });
    }
    return new Response("down", { status: 503 });
  };
  const result = await pool.refreshFreePoolCatalog({ fetchImpl, file });
  assert.equal(result.written, true);
  assert.deepEqual(result.kilo.map((entry) => entry.id), ["new/model:free"]);
  assert.deepEqual(result.opencode.map((entry) => entry.id), STATIC_FREE_POOL_CATALOG.opencode.map((entry) => entry.id));
  assert.equal(result.errors.length, 1);
  assert.equal(readFreePoolCatalog({ file }).source, "live");
  assert.ok(seen.every(([, agent]) => agent === "codex-router-free-pool"));
  // Neither lane answering leaves the previous cache alone.
  const failed = await pool.refreshFreePoolCatalog({ fetchImpl: async () => new Response("", { status: 500 }), file });
  assert.equal(failed.written, false);
  assert.deepEqual(readFreePoolCatalog({ file }).kilo.map((entry) => entry.id), ["new/model:free"]);
});

test("startup refresh runs only when free is explicitly enabled and the cache is stale", () => {
  const selection = path.join(stateDir, "enabled-providers.json");
  const file = path.join(stateDir, "catalog-due.json");
  rmSync(selection, { force: true });
  rmSync(file, { force: true });
  assert.equal(pool.freePoolRefreshDue({ env: {}, file }), false);
  writeFileSync(selection, JSON.stringify({ version: 1, providers: ["kimi"] }));
  assert.equal(pool.freePoolRefreshDue({ env: {}, file }), false);
  writeFileSync(selection, JSON.stringify({ version: 1, providers: ["free"] }));
  assert.equal(pool.freePoolRefreshDue({ env: {}, file }), true);
  assert.equal(pool.freePoolRefreshDue({ env: { MODEL_ROUTER_FREE_POOL_REFRESH: "0" }, file }), false);
  const fetchedAt = "2026-10-30T00:00:00.000Z";
  writeFileSync(file, JSON.stringify({ version: 1, fetchedAt, kilo: [{ id: "x/y:free" }], opencode: [] }));
  assert.equal(pool.freePoolRefreshDue({ env: {}, file, now: Date.parse(fetchedAt) + 3_600_000 }), false);
  assert.equal(pool.freePoolRefreshDue({ env: {}, file, now: Date.parse(fetchedAt) + 25 * 3_600_000 }), true);
  rmSync(selection, { force: true });
});

test("usage diagnostics keep only the pool slug and known pool reasons", () => {
  assert.deepEqual(
    usageDiagnosticMetadata({ freePool: "free/auto", freePoolReason: "rate_limited" }),
    { freePool: "free/auto", freePoolReason: "rate_limited" },
  );
  assert.deepEqual(usageDiagnosticMetadata({ freePool: "other/model", freePoolReason: "made up" }), {});
});

test("status summarizes pool rows: served, fallbacks, failed hops, exhaustion and tokens", () => {
  pool.clearAllFreePoolDrains();
  const order = pool.freePoolRouteOrder({ env: {} });
  pool.drainFreePoolMember(order[0].slug, { ms: 600_000, reason: "rate_limited", status: 429 });
  const events = [
    { at: "2026-10-30T00:00:00.000Z", freePool: "free/auto", model: order[0].slug, status: 429, freePoolReason: "rate_limited", requestId: "r1" },
    { at: "2026-10-30T00:00:01.000Z", freePool: "free/auto", model: order[1].slug, status: 200, failoverFrom: order[0].slug, inputTokens: 100, outputTokens: 20, requestId: "r1" },
    { at: "2026-10-30T00:01:00.000Z", freePool: "free/auto", model: order[1].slug, status: 200, inputTokens: 50, outputTokens: 5, requestId: "r2" },
    { at: "2026-10-30T00:02:00.000Z", freePool: "free/auto", model: "free/auto", status: 429, freePoolReason: "exhausted", requestId: "r3" },
    { at: "2026-10-30T00:03:00.000Z", model: "kimi/k2", status: 200, inputTokens: 999 },
  ];
  const status = pool.freePoolStatus({ events, env: {}, providerEnabled: () => true });
  assert.equal(status.pool, "free/auto");
  assert.equal(status.usage.requests, 3);
  assert.equal(status.usage.attempts, 4);
  assert.equal(status.usage.served, 2);
  assert.equal(status.usage.fallbacks, 1);
  assert.equal(status.usage.errors, 2);
  assert.equal(status.usage.exhausted, 1);
  assert.equal(status.usage.inputTokens, 150);
  assert.equal(status.usage.outputTokens, 25);
  assert.equal(status.usage.recent[0].reason, "exhausted");
  assert.equal(status.usage.recent[2].failoverFrom, order[0].slug);
  const drained = status.members.find((member) => member.slug === order[0].slug);
  assert.equal(drained.drained, true);
  assert.equal(drained.drainReason, "rate_limited");
  assert.ok(drained.remainingMs > 0);
  assert.equal(status.members.filter((member) => member.drained).length, 1);
  pool.clearAllFreePoolDrains();
});
