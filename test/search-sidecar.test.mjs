import assert from "node:assert/strict";
import test from "node:test";

import {
  createSearchCache,
  normalizeSearchResponse,
  normalizeSearchSidecarConfig,
  resolveSearchTransport,
  searchWithSidecar,
  SearchSidecarError,
} from "../src/search-sidecar.mjs";

const config = { enabled: true, providerId: "search-provider", credentialRef: "cred_search" };

test("native search wins in auto mode and sidecar is explicit", () => {
  assert.equal(resolveSearchTransport({ modelCapabilities: { supportsSearch: true }, sidecar: config }), "native");
  assert.equal(resolveSearchTransport({ modelCapabilities: { supportsSearch: true }, sidecar: config, mode: "sidecar" }), "sidecar");
  assert.equal(resolveSearchTransport({ modelCapabilities: { supportsSearch: false }, sidecar: config }), "sidecar");
  assert.equal(resolveSearchTransport({ modelCapabilities: { supportsSearch: false }, sidecar: {} }), "disabled");
});

test("enabled config contains only opaque credential metadata", () => {
  assert.throws(() => normalizeSearchSidecarConfig({ ...config, apiKey: "secret" }), /cannot contain apiKey/);
  assert.throws(() => normalizeSearchSidecarConfig({ enabled: true, providerId: "search-provider" }), /credentialRef/);
  assert.equal(normalizeSearchSidecarConfig(config).enabled, true);
});

test("success returns bounded results, citations and telemetry", async () => {
  const calls = [];
  const result = await searchWithSidecar({
    config: { ...config, maxResults: 1 },
    request: { query: "  latest news  " },
    searchImpl: async (input) => {
      calls.push(input);
      return { results: [
        { title: "One", url: "https://example.com/1", snippet: "summary" },
        { title: "Two", url: "https://example.com/2" },
      ] };
    },
    cache: createSearchCache(),
  });
  assert.equal(calls[0].credentialRef, "cred_search");
  assert.equal(result.results.length, 1);
  assert.deepEqual(result.citations, [{ index: 1, title: "One", url: "https://example.com/1" }]);
  assert.equal(result.telemetry.cacheHit, false);
});

test("cache hit avoids a duplicate provider call and stays bounded", async () => {
  let calls = 0;
  const cache = createSearchCache({ maxEntries: 1, ttlMs: 100 });
  const searchImpl = async () => { calls += 1; return [{ title: "One", url: "https://example.com" }]; };
  const first = await searchWithSidecar({ config, request: "same", searchImpl, cache });
  const second = await searchWithSidecar({ config, request: "same", searchImpl, cache });
  assert.equal(calls, 1);
  assert.equal(first.telemetry.cacheHit, false);
  assert.equal(second.telemetry.cacheHit, true);
  assert.equal(cache.size, 1);
});

test("transient errors retry, but deterministic errors do not", async () => {
  let calls = 0;
  const sleeps = [];
  const result = await searchWithSidecar({
    config: { ...config, maxAttempts: 2, retryDelayMs: 7 },
    request: "retry",
    searchImpl: async () => {
      calls += 1;
      if (calls === 1) throw Object.assign(new Error("busy"), { status: 503 });
      return [{ title: "One", url: "https://example.com" }];
    },
    sleep: async (ms) => sleeps.push(ms),
  });
  assert.equal(calls, 2);
  assert.deepEqual(sleeps, [7]);
  await assert.rejects(
    () => searchWithSidecar({ config, request: "bad", searchImpl: async () => { throw Object.assign(new Error("bad request"), { status: 400 }); } }),
    (error) => error instanceof SearchSidecarError && error.status === 400 && error.telemetry.attempts === 1,
  );
});

test("explicit non-retryable errors do not retry even for a transient status", async () => {
  let calls = 0;
  await assert.rejects(
    () => searchWithSidecar({
      config: { ...config, maxAttempts: 2 },
      request: "no-retry",
      searchImpl: async () => {
        calls += 1;
        throw Object.assign(new Error("provider stopped"), { status: 503, retryable: false });
      },
    }),
    (error) => error instanceof SearchSidecarError && error.status === 503 && error.telemetry.attempts === 1,
  );
  assert.equal(calls, 1);
});

test("timeout and caller cancellation are observable", async () => {
  await assert.rejects(
    () => searchWithSidecar({
      config: { ...config, timeoutMs: 5 },
      request: "slow",
      searchImpl: ({ signal }) => new Promise((resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      }),
    }),
    (error) => error.code === "search_sidecar_timeout" && error.telemetry.attempts === 1,
  );
  const controller = new AbortController();
  controller.abort(new Error("user cancelled"));
  await assert.rejects(
    () => searchWithSidecar({ config, request: "cancel", signal: controller.signal, searchImpl: async ({ signal }) => { signal.throwIfAborted(); } }),
    (error) => error.code === "search_sidecar_cancelled",
  );
});

test("late adapter responses cannot bypass the timeout", async () => {
  await assert.rejects(
    () => searchWithSidecar({
      config: { ...config, timeoutMs: 5, maxAttempts: 1 },
      request: "late",
      searchImpl: async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
        return [{ title: "Late", url: "https://example.com/late" }];
      },
    }),
    (error) => error.code === "search_sidecar_timeout" && error.telemetry.attempts === 1,
  );
});

test("malformed results never enter the model-visible schema", () => {
  assert.throws(() => normalizeSearchResponse({ results: [{ title: "bad", url: "file:///tmp/a" }] }, { query: "x", maxResults: 1 }), /http or https/);
  assert.throws(() => normalizeSearchResponse({ results: [null] }, { query: "x", maxResults: 1 }), /Search result/);
});
