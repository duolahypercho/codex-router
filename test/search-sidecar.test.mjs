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

const config = {
  enabled: true,
  providerId: "search-provider",
  credentialRef: "cred_search",
  destination: "https://search.example.test/api/search",
};
const authorized = async () => true;

test("native search wins in auto mode and sidecar requires explicit authorization", () => {
  assert.equal(resolveSearchTransport({ modelCapabilities: { supportsSearch: true }, sidecar: config }), "native");
  assert.equal(resolveSearchTransport({ modelCapabilities: { supportsSearch: true }, sidecar: config, mode: "sidecar" }), "disabled");
  assert.equal(resolveSearchTransport({ modelCapabilities: { supportsSearch: true }, sidecar: config, mode: "sidecar", invocationAuthorized: true }), "sidecar");
  assert.equal(resolveSearchTransport({ modelCapabilities: { supportsSearch: false }, sidecar: config }), "disabled");
  assert.equal(resolveSearchTransport({ modelCapabilities: { supportsSearch: false }, sidecar: {} }), "disabled");
});

test("enabled config contains only opaque credential and destination metadata", () => {
  assert.throws(() => normalizeSearchSidecarConfig({ ...config, apiKey: "secret" }), /does not accept apiKey/);
  assert.throws(() => normalizeSearchSidecarConfig({ enabled: true, providerId: "search-provider" }), /credentialRef/);
  assert.throws(() => normalizeSearchSidecarConfig({ ...config, destination: "http://search.example.test" }), /HTTPS/);
  assert.throws(() => normalizeSearchSidecarConfig({ ...config, destination: "https://user:pass@search.example.test" }), /credentials/);
  assert.throws(() => normalizeSearchSidecarConfig({ ...config, destination: "https://127.0.0.1/search" }), /private address/);
  assert.throws(() => normalizeSearchSidecarConfig({ ...config, destination: "https://100.64.0.1/search" }), /private address/);
  assert.throws(() => normalizeSearchSidecarConfig({ ...config, credentialRef: "secret value" }), /opaque reference/);
  assert.throws(() => normalizeSearchSidecarConfig({ ...config, credentialRef: "secret\nvalue" }), /at most/);
  assert.throws(() => normalizeSearchSidecarConfig({ ...config, credentialRef: "sk-12345678901234567890" }), /stored credentials/);
  assert.equal(normalizeSearchSidecarConfig(config).enabled, true);
});

test("success returns bounded results, citations and telemetry", async () => {
  const calls = [];
  const result = await searchWithSidecar({
    config: { ...config, maxResults: 1 },
    request: { query: "  latest news  " },
    accountId: "account-a",
    model: "model-a",
    authorize: authorized,
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
  assert.equal(calls[0].destination, config.destination);
  assert.equal(calls[0].accountId, "account-a");
  assert.equal(result.results.length, 1);
  assert.deepEqual(result.citations, [{ index: 1, title: "One", url: "https://example.com/1" }]);
  assert.equal(result.telemetry.cacheHit, false);
});

test("configured maxResults is a hard cap for explicit request limits", async () => {
  let requested;
  const result = await searchWithSidecar({
    config: { ...config, maxResults: 1 },
    request: { query: "bounded", maxResults: 50 },
    accountId: "account-a",
    model: "model-a",
    authorize: authorized,
    searchImpl: async (input) => {
      requested = input.maxResults;
      return [
        { title: "One", url: "https://example.com/1" },
        { title: "Two", url: "https://example.com/2" },
      ];
    },
  });
  assert.equal(requested, 1);
  assert.equal(result.results.length, 1);
});

test("cache keys isolate account, provider and model", async () => {
  let calls = 0;
  const cache = createSearchCache({ maxEntries: 10, ttlMs: 100 });
  const searchImpl = async () => { calls += 1; return [{ title: "One", url: "https://example.com" }]; };
  const first = await searchWithSidecar({ config, request: "same", accountId: "account-a", model: "model-a", authorize: authorized, searchImpl, cache });
  const second = await searchWithSidecar({ config, request: "same", accountId: "account-a", model: "model-a", authorize: authorized, searchImpl, cache });
  await searchWithSidecar({ config, request: "same", accountId: "account-b", model: "model-a", authorize: authorized, searchImpl, cache });
  await searchWithSidecar({ config, request: "same", accountId: "account-a", model: "model-b", authorize: authorized, searchImpl, cache });
  await searchWithSidecar({ config: { ...config, providerId: "other-provider", credentialRef: "other_credential", destination: "https://other.example.test/search" }, request: "same", accountId: "account-a", model: "model-a", authorize: authorized, searchImpl, cache });
  assert.equal(calls, 4);
  assert.equal(first.telemetry.cacheHit, false);
  assert.equal(second.telemetry.cacheHit, true);
  assert.equal(cache.size, 4);
});

test("transient errors retry, but deterministic errors do not", async () => {
  let calls = 0;
  const sleeps = [];
  const result = await searchWithSidecar({
    config: { ...config, maxAttempts: 2, retryDelayMs: 7 },
    request: "retry",
    accountId: "account-a",
    model: "model-a",
    authorize: authorized,
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
    () => searchWithSidecar({ config, request: "bad", accountId: "account-a", model: "model-a", authorize: authorized, searchImpl: async () => { throw Object.assign(new Error("bad request"), { status: 400 }); } }),
    (error) => error instanceof SearchSidecarError && error.status === 400 && error.telemetry.attempts === 1,
  );
});

test("explicit non-retryable errors do not retry even for a transient status", async () => {
  let calls = 0;
  await assert.rejects(
    () => searchWithSidecar({
      config: { ...config, maxAttempts: 2 },
      request: "no-retry",
      accountId: "account-a",
      model: "model-a",
      authorize: authorized,
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
      accountId: "account-a",
      model: "model-a",
      authorize: authorized,
      searchImpl: ({ signal }) => new Promise((resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      }),
    }),
    (error) => error.code === "search_sidecar_timeout" && error.telemetry.attempts === 1,
  );
  const controller = new AbortController();
  controller.abort(new Error("user cancelled"));
  await assert.rejects(
    () => searchWithSidecar({ config, request: "cancel", accountId: "account-a", model: "model-a", authorize: authorized, signal: controller.signal, searchImpl: async ({ signal }) => { signal.throwIfAborted(); } }),
    (error) => error.code === "search_sidecar_cancelled",
  );
});

test("late adapter responses cannot bypass the timeout", async () => {
  await assert.rejects(
    () => searchWithSidecar({
      config: { ...config, timeoutMs: 5, maxAttempts: 1 },
      request: "late",
      accountId: "account-a",
      model: "model-a",
      authorize: authorized,
      searchImpl: async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
        return [{ title: "Late", url: "https://example.com/late" }];
      },
    }),
    (error) => error.code === "search_sidecar_timeout" && error.telemetry.attempts === 1,
  );
});

test("a hung retry backoff is bounded and cancellable", async () => {
  await assert.rejects(
    () => searchWithSidecar({
      config: { ...config, timeoutMs: 5, maxAttempts: 2 },
      request: "hung-backoff",
      accountId: "account-a",
      model: "model-a",
      authorize: authorized,
      searchImpl: async () => { throw Object.assign(new Error("busy"), { status: 503 }); },
      sleep: async () => new Promise(() => {}),
    }),
    (error) => error.code === "search_sidecar_timeout",
  );
});

test("the timeout is a total operation budget across retries", async () => {
  const started = Date.now();
  let calls = 0;
  await assert.rejects(
    () => searchWithSidecar({
      config: { ...config, timeoutMs: 15, maxAttempts: 2, retryDelayMs: 1 },
      request: "total-timeout",
      accountId: "account-a",
      model: "model-a",
      authorize: authorized,
      searchImpl: async ({ signal }) => new Promise((resolve, reject) => {
        calls += 1;
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      }),
    }),
    (error) => error.code === "search_sidecar_timeout" && error.telemetry.attempts === 1,
  );
  assert.equal(calls, 1);
  assert.ok(Date.now() - started < 100, "operation should not restart the full timeout for another attempt");
});

test("authorization is mandatory and runs before cache access", async () => {
  const cache = createSearchCache();
  let calls = 0;
  await assert.rejects(
    () => searchWithSidecar({ config, request: "blocked", accountId: "account-a", model: "model-a", searchImpl: async () => { calls += 1; return []; }, cache }),
    (error) => error.code === "search_sidecar_unauthorized",
  );
  await assert.rejects(
    () => searchWithSidecar({ config, request: "blocked", accountId: "account-a", model: "model-a", authorize: async () => false, searchImpl: async () => { calls += 1; return []; }, cache }),
    (error) => error.code === "search_sidecar_unauthorized",
  );
  assert.equal(calls, 0);
});

test("a hung authorization gate is bounded", async () => {
  await assert.rejects(
    () => searchWithSidecar({
      config: { ...config, timeoutMs: 5 },
      request: "hung-auth",
      accountId: "account-a",
      model: "model-a",
      authorize: async () => new Promise(() => {}),
      searchImpl: async () => [],
    }),
    (error) => error.code === "search_sidecar_timeout",
  );
});

test("malformed results never enter the model-visible schema", () => {
  assert.throws(() => normalizeSearchResponse({ results: [{ title: "bad", url: "file:///tmp/a" }] }, { query: "x", maxResults: 1 }), /HTTP\(S\)/);
  assert.throws(() => normalizeSearchResponse({ results: [{ title: "bad", url: "https://user:pass@example.com" }] }, { query: "x", maxResults: 1 }), /credentials/);
  assert.throws(() => normalizeSearchResponse({ results: [{ title: "bad", url: "http://127.0.0.1" }] }, { query: "x", maxResults: 1 }), /private address/);
  assert.throws(() => normalizeSearchResponse({ results: [null] }, { query: "x", maxResults: 1 }), /Search result/);
  const sanitized = normalizeSearchResponse({ results: [{ title: "<b>Title</b>", url: "https://example.com", snippet: "line\n<script>alert(1)</script> two" }] }, { query: "x", maxResults: 1 });
  assert.deepEqual(sanitized.results[0],
    { title: "Title", url: "https://example.com/", snippet: "line two" },
  );
  assert.deepEqual(sanitized.citations, [{ index: 1, title: "Title", url: "https://example.com/" }]);
});
