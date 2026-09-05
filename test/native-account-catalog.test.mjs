import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  refreshNativeAccountCatalog,
} from "../src/native-account-catalog.mjs";

const ACCESS = "test-native-account-access-token";
const ACCOUNT = "test-native-account-id";
const headersProvider = async () => ({
  authorization: `Bearer ${ACCESS}`,
  "chatgpt-account-id": ACCOUNT,
});
const noLock = (operation) => operation();

function fixtureCache(models, overrides = {}) {
  return {
    fetched_at: "2026-08-01T00:00:00.000Z",
    etag: 'W/"old-account-catalog"',
    client_version: "0.153.2",
    models,
    ...overrides,
  };
}

function withCache(run) {
  const directory = mkdtempSync(path.join(os.tmpdir(), "native-account-catalog-"));
  const cachePath = path.join(directory, "models_cache.json");
  return Promise.resolve(run(cachePath)).finally(() => {
    rmSync(directory, { recursive: true, force: true });
  });
}

test("a changed live account catalog atomically replaces the frozen Codex cache", () =>
  withCache(async (cachePath) => {
    const oldModels = [{ slug: "gpt-old", visibility: "list" }];
    const newModels = [
      { slug: "gpt-old", visibility: "list" },
      { slug: "gpt-new-account-model", visibility: "list" },
    ];
    writeFileSync(cachePath, JSON.stringify(fixtureCache(oldModels)));
    let request;
    const result = await refreshNativeAccountCatalog({
      cachePath,
      force: true,
      now: Date.parse("2026-09-06T00:00:00.000Z"),
      version: "0.153.2",
      headersProvider,
      discoveryOff: () => false,
      lock: noLock,
      fetchImpl: async (url, init) => {
        request = { url, init };
        return new Response(JSON.stringify({ models: newModels }), {
          status: 200,
          headers: { etag: 'W/"new-account-catalog"' },
        });
      },
    });

    assert.equal(result.status, "updated");
    assert.match(request.url, /client_version=0\.153\.2/);
    assert.equal(request.init.headers.authorization, `Bearer ${ACCESS}`);
    assert.equal(request.init.headers["chatgpt-account-id"], ACCOUNT);
    assert.equal(request.init.headers["if-none-match"], 'W/"old-account-catalog"');
    const written = JSON.parse(readFileSync(cachePath, "utf8"));
    assert.deepEqual(written.models, newModels);
    assert.equal(written.etag, 'W/"new-account-catalog"');
    assert.equal(written.client_version, "0.153.2");
    assert.equal(written.fetched_at, "2026-09-06T00:00:00.000Z");
    assert.doesNotMatch(JSON.stringify(result), new RegExp(ACCESS));
    assert.doesNotMatch(readFileSync(cachePath, "utf8"), new RegExp(ACCESS));
    assert.doesNotMatch(readFileSync(cachePath, "utf8"), new RegExp(ACCOUNT));
  }));

test("a matching ETag leaves the account cache byte-identical", () =>
  withCache(async (cachePath) => {
    const contents = `${JSON.stringify(fixtureCache([{ slug: "gpt-stable" }]), null, 2)}\n`;
    writeFileSync(cachePath, contents);
    const result = await refreshNativeAccountCatalog({
      cachePath,
      force: true,
      version: "0.153.2",
      headersProvider,
      discoveryOff: () => false,
      lock: noLock,
      fetchImpl: async () => new Response(null, { status: 304 }),
    });
    assert.equal(result.status, "not-modified");
    assert.equal(readFileSync(cachePath, "utf8"), contents);
  }));

test("a changed ETag with identical models is persisted once without reporting model drift", () =>
  withCache(async (cachePath) => {
    const models = [{ slug: "gpt-stable" }];
    writeFileSync(cachePath, JSON.stringify(fixtureCache(models)));
    const result = await refreshNativeAccountCatalog({
      cachePath,
      force: true,
      now: Date.parse("2026-09-06T00:00:00.000Z"),
      version: "0.153.2",
      headersProvider,
      discoveryOff: () => false,
      lock: noLock,
      fetchImpl: async () => new Response(JSON.stringify({ models }), {
        status: 200,
        headers: { etag: 'W/"revalidated-account-catalog"' },
      }),
    });
    assert.equal(result.status, "revalidated");
    const written = JSON.parse(readFileSync(cachePath, "utf8"));
    assert.deepEqual(written.models, models);
    assert.equal(written.etag, 'W/"revalidated-account-catalog"');
  }));

test("network and schema failures preserve the last usable account cache", () =>
  withCache(async (cachePath) => {
    const contents = JSON.stringify(fixtureCache([{ slug: "gpt-stable" }]));
    writeFileSync(cachePath, contents);
    for (const fetchImpl of [
      async () => { throw new Error(`request failed with ${ACCESS}`); },
      async () => new Response('{"models":[]}', { status: 200 }),
      async () => new Response("denied", { status: 401 }),
    ]) {
      const result = await refreshNativeAccountCatalog({
        cachePath,
        force: true,
        version: "0.153.2",
        headersProvider,
        discoveryOff: () => false,
        lock: noLock,
        fetchImpl,
      });
      assert.equal(result.status, "failed");
      assert.equal(readFileSync(cachePath, "utf8"), contents);
      assert.doesNotMatch(JSON.stringify(result), new RegExp(ACCESS));
    }
  }));

test("proxy dispatcher setup failure falls back without exposing credentials", () =>
  withCache(async (cachePath) => {
    const contents = JSON.stringify(fixtureCache([{ slug: "gpt-stable" }]));
    writeFileSync(cachePath, contents);
    const result = await refreshNativeAccountCatalog({
      cachePath,
      force: true,
      version: "0.153.2",
      headersProvider,
      discoveryOff: () => false,
      lock: noLock,
      dispatcherFactory: () => {
        throw new Error(`invalid proxy carrying ${ACCESS}`);
      },
    });
    assert.equal(result.status, "failed");
    assert.equal(readFileSync(cachePath, "utf8"), contents);
    assert.doesNotMatch(JSON.stringify(result), new RegExp(ACCESS));
  }));

test("discovery-disabled refresh reads no cache, credential, version, or network", async () => {
  const forbidden = () => { throw new Error("account-derived operation ran"); };
  const result = await refreshNativeAccountCatalog({
    cachePath: new Proxy({}, { get: forbidden }),
    discoveryOff: () => true,
    lock: forbidden,
    versionProvider: forbidden,
    headersProvider: forbidden,
    fetchImpl: forbidden,
  });
  assert.deepEqual(result, { status: "disabled" });
});

test("a fresh current-version cache avoids account auth and network reads", () =>
  withCache(async (cachePath) => {
    writeFileSync(cachePath, JSON.stringify(fixtureCache(
      [{ slug: "gpt-current" }],
      { fetched_at: "2026-09-06T00:00:00.000Z" },
    )));
    const forbidden = () => { throw new Error("unexpected live refresh"); };
    const result = await refreshNativeAccountCatalog({
      cachePath,
      now: Date.parse("2026-09-06T00:04:59.999Z"),
      version: "0.153.2",
      discoveryOff: () => false,
      lock: noLock,
      headersProvider: forbidden,
      fetchImpl: forbidden,
    });
    assert.equal(result.status, "fresh");
  }));

test("a future-dated cache is revalidated instead of remaining fresh indefinitely", () =>
  withCache(async (cachePath) => {
    const models = [{ slug: "gpt-current" }];
    writeFileSync(cachePath, JSON.stringify(fixtureCache(
      models,
      { fetched_at: "2026-09-07T00:00:00.000Z" },
    )));
    let requested = false;
    const result = await refreshNativeAccountCatalog({
      cachePath,
      now: Date.parse("2026-09-06T00:00:00.000Z"),
      version: "0.153.2",
      discoveryOff: () => false,
      lock: noLock,
      headersProvider,
      fetchImpl: async () => {
        requested = true;
        return new Response(JSON.stringify({ models }), { status: 200 });
      },
    });
    assert.equal(requested, true);
    assert.equal(result.status, "unchanged");
  }));

test("an account switch during the request cannot overwrite the new account cache", () =>
  withCache(async (cachePath) => {
    const contents = JSON.stringify(fixtureCache([{ slug: "gpt-before-switch" }]));
    writeFileSync(cachePath, contents);
    let reads = 0;
    const result = await refreshNativeAccountCatalog({
      cachePath,
      force: true,
      version: "0.153.2",
      discoveryOff: () => false,
      lock: noLock,
      headersProvider: async () => ({
        authorization: `Bearer ${ACCESS}`,
        "chatgpt-account-id": reads++ === 0 ? ACCOUNT : "different-account",
      }),
      fetchImpl: async () => new Response(JSON.stringify({
        models: [{ slug: "gpt-from-old-account" }],
      }), { status: 200 }),
    });
    assert.equal(result.status, "failed");
    assert.equal(readFileSync(cachePath, "utf8"), contents);
  }));

test("an account switch during a version revalidation cannot restamp the cache", () =>
  withCache(async (cachePath) => {
    const contents = JSON.stringify(fixtureCache(
      [{ slug: "gpt-before-switch" }],
      { client_version: "0.152.0" },
    ));
    writeFileSync(cachePath, contents);
    let reads = 0;
    const result = await refreshNativeAccountCatalog({
      cachePath,
      force: true,
      version: "0.153.2",
      discoveryOff: () => false,
      lock: noLock,
      headersProvider: async () => ({
        authorization: `Bearer ${ACCESS}`,
        "chatgpt-account-id": reads++ === 0 ? ACCOUNT : "different-account",
      }),
      fetchImpl: async () => new Response(null, { status: 304 }),
    });
    assert.equal(result.status, "failed");
    assert.equal(readFileSync(cachePath, "utf8"), contents);
  }));
