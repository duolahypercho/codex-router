import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, scryptSync } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// paths.mjs resolves the state directory once at load, so the environment has
// to be in place before the cache module is imported at all.
const stateRoot = mkdtempSync(path.join(os.tmpdir(), "codex-router-catalog-cache-"));
process.env.MODEL_ROUTER_STATE_DIR = stateRoot;
process.env.CODEX_ROUTER_STATE_DIR = stateRoot;
const cachePath = path.join(stateRoot, "provider-catalog-cache.json");
const internalSecret = "provider-catalog-test-internal-secret-0000000000000000";
writeFileSync(path.join(stateRoot, "internal-secret"), `${internalSecret}\n`, { mode: 0o600 });
const {
  catalogEntryIsStale,
  forgetProviderCatalogCache,
  forgetProviderCatalogCaches,
  providerCatalogIdentityFingerprint,
  MAX_SCOPES_PER_PROVIDER,
  PROVIDER_CATALOG_CACHE_MAX_BYTES,
  readProviderCatalogCache,
  withProviderCatalogCacheTransaction,
  writeProviderCatalogCache: rawWriteProviderCatalogCache,
} = await import("../src/model-catalog-cache.mjs");
const TEST_IDENTITY = providerCatalogIdentityFingerprint(["test-account"]);

function writeProviderCatalogCache(providerId, entry = {}) {
  const identityFingerprint = entry.identityFingerprint || TEST_IDENTITY;
  const endpoint = entry.provenance?.endpoint || `https://${providerId}.example.test/v1/models`;
  return rawWriteProviderCatalogCache(providerId, {
    identityFingerprint,
    provenance: {
      schema: "codex-router/provider-catalog/v1",
      providerId,
      endpoint,
      identityFingerprint,
      ...(entry.scope ? { scope: entry.scope } : {}),
      ...entry.provenance,
    },
    ...entry,
  });
}

test.after(() => rmSync(stateRoot, { recursive: true, force: true }));

test("catalog identity fingerprints require the installation's independent secret", () => {
  const payload = JSON.stringify(["test-account"]);
  const unkeyed = createHash("sha256").update(payload).digest("hex");
  const keyed = scryptSync(payload, internalSecret, 32, {
    N: 16_384,
    r: 8,
    p: 1,
    maxmem: 32 * 1024 * 1024,
  }).toString("hex");
  assert.equal(TEST_IDENTITY, keyed);
  assert.notEqual(TEST_IDENTITY, unkeyed);
  try {
    writeFileSync(
      path.join(stateRoot, "internal-secret"),
      "rotated-provider-catalog-test-secret-1111111111111111\n",
      { mode: 0o600 },
    );
    assert.notEqual(providerCatalogIdentityFingerprint(["test-account"]), TEST_IDENTITY);
  } finally {
    writeFileSync(path.join(stateRoot, "internal-secret"), `${internalSecret}\n`, { mode: 0o600 });
  }
  assert.equal(providerCatalogIdentityFingerprint(["test-account"]), TEST_IDENTITY);
});

test("a provider's published list survives for the next visit", async () => {
  assert.equal(readProviderCatalogCache("deepseek"), undefined);
  await writeProviderCatalogCache("deepseek", {
    discovered: ["deepseek-v5", "deepseek-v4-flash"],
    free: ["deepseek-v5"],
    contextLengths: { "deepseek-v5": 262_144 },
    metadata: {
      "deepseek-v5": {
        contextWindow: 262_144,
        maxOutputTokens: 32_000,
        inputModalities: ["text", "image"],
        supportsTools: true,
        reasoning: { supported: true, configurable: true, supportedEfforts: ["low", "high"] },
        metadataSource: "provider-catalog",
      },
      unlisted: { contextWindow: 4096 },
    },
    fetchedAt: "2020-01-01T00:00:00.000Z",
    identityFingerprint: TEST_IDENTITY,
  });
  const entry = readProviderCatalogCache("deepseek");
  // Age is derived on every read and never persisted, so a stored document can
  // never assert its own freshness.
  assert.equal(entry.stale, true);
  assert.equal(JSON.parse(readFileSync(cachePath, "utf8")).providers.deepseek.stale, undefined);
  assert.equal(catalogEntryIsStale(new Date().toISOString()), false);
  assert.equal(catalogEntryIsStale("not a timestamp"), true);
  // A list written now is trusted; the boundary is exercised from both sides
  // against a fixed clock so neither case can drift with the calendar.
  const fixedNow = Date.parse("2026-08-21T00:00:00.000Z");
  assert.equal(catalogEntryIsStale("2026-08-20T23:00:00.000Z", fixedNow), false);
  assert.equal(catalogEntryIsStale("2026-08-19T23:00:00.000Z", fixedNow), true);
  await writeProviderCatalogCache("fresh-provider", {
    discovered: ["only"],
    identityFingerprint: TEST_IDENTITY,
  });
  assert.equal(readProviderCatalogCache("fresh-provider").stale, false);
  assert.deepEqual(entry.discovered, ["deepseek-v5", "deepseek-v4-flash"]);
  assert.deepEqual(entry.free, ["deepseek-v5"]);
  assert.deepEqual(entry.contextLengths, { "deepseek-v5": 262_144 });
  assert.deepEqual(entry.metadata, {
    "deepseek-v5": {
      contextWindow: 262_144,
      maxOutputTokens: 32_000,
      inputModalities: ["text", "image"],
      supportsTools: true,
      reasoning: { supported: true, configurable: true, supportedEfforts: ["low", "high"] },
      metadataSource: "provider-catalog",
    },
  });
  assert.equal(entry.fetchedAt, "2020-01-01T00:00:00.000Z");

  if (process.platform !== "win32") {
    assert.equal(statSync(cachePath).mode & 0o777, 0o600);
  }
  assert.doesNotMatch(readFileSync(cachePath, "utf8"), /Bearer|api[_-]?key/i);

  assert.equal(await forgetProviderCatalogCache("deepseek"), true);
  assert.equal(readProviderCatalogCache("deepseek"), undefined);
  assert.equal(await forgetProviderCatalogCache("deepseek"), false);
});

test("several catalog sources are forgotten with one family invalidation", async () => {
  await writeProviderCatalogCache("opencode-go", {
    discovered: ["go-model"],
    identityFingerprint: TEST_IDENTITY,
  });
  await writeProviderCatalogCache("opencode-zen", {
    discovered: ["zen-model"],
    identityFingerprint: TEST_IDENTITY,
  });
  await writeProviderCatalogCache("deepseek", {
    discovered: ["deepseek-model"],
    identityFingerprint: TEST_IDENTITY,
  });

  assert.equal(
    await forgetProviderCatalogCaches(["opencode-go", "opencode-zen", "opencode-go"]),
    2,
  );
  assert.equal(readProviderCatalogCache("opencode-go"), undefined);
  assert.equal(readProviderCatalogCache("opencode-zen"), undefined);
  assert.deepEqual(readProviderCatalogCache("deepseek").discovered, ["deepseek-model"]);
  assert.equal(await forgetProviderCatalogCaches(["../escape", "opencode-go"]), 0);
});

test("parallel catalog transactions preserve every provider entry", async () => {
  let active = 0;
  let overlap = 0;
  const firstEntered = Promise.withResolvers();
  const releaseFirst = Promise.withResolvers();
  const first = withProviderCatalogCacheTransaction(async (catalog) => {
    active += 1;
    overlap = Math.max(overlap, active);
    firstEntered.resolve();
    await releaseFirst.promise;
    catalog.write("parallel-one", {
      discovered: ["one"],
      identityFingerprint: TEST_IDENTITY,
      provenance: { schema: "codex-router/provider-catalog/v1", providerId: "parallel-one", endpoint: "https://parallel-one.example.test/v1/models", identityFingerprint: TEST_IDENTITY },
    });
    active -= 1;
  });
  await firstEntered.promise;
  const second = withProviderCatalogCacheTransaction(async (catalog) => {
    active += 1;
    overlap = Math.max(overlap, active);
    catalog.write("parallel-two", {
      discovered: ["two"],
      identityFingerprint: TEST_IDENTITY,
      provenance: { schema: "codex-router/provider-catalog/v1", providerId: "parallel-two", endpoint: "https://parallel-two.example.test/v1/models", identityFingerprint: TEST_IDENTITY },
    });
    active -= 1;
  });
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(active, 1, "the second cache writer entered before the first committed");
  releaseFirst.resolve();
  await Promise.all([first, second]);
  assert.equal(overlap, 1);
  assert.deepEqual(readProviderCatalogCache("parallel-one").discovered, ["one"]);
  assert.deepEqual(readProviderCatalogCache("parallel-two").discovered, ["two"]);
});

test("an old-account discovery cannot commit after credential replacement", async () => {
  process.env.DEEPSEEK_API_KEY = "";
  const { discoverProviderModels } = await import("../src/model-discovery.mjs");
  const { writeProviderCredential } = await import("../src/provider-credentials.mjs");
  const { providerCatalogFamilyCacheIds } = await import("../src/provider-catalogs.mjs");
  const fetchedWithOldAccount = Promise.withResolvers();
  const finishOldFetch = Promise.withResolvers();

  await withProviderCatalogCacheTransaction((catalog) => {
    writeProviderCredential("deepseek", "old-account-key");
    catalog.forget(providerCatalogFamilyCacheIds("deepseek"));
  });
  const discovery = discoverProviderModels("deepseek", {
    refresh: true,
    loadPayload: async (_provider, identity) => {
      assert.equal(identity.credential.value, "old-account-key");
      fetchedWithOldAccount.resolve();
      await finishOldFetch.promise;
      return { data: [{ id: "old-account-only-model" }] };
    },
  });
  await fetchedWithOldAccount.promise;
  await withProviderCatalogCacheTransaction((catalog) => {
    writeProviderCredential("deepseek", "new-account-key");
    catalog.forget(providerCatalogFamilyCacheIds("deepseek"));
  });
  finishOldFetch.resolve();

  await assert.rejects(discovery, (error) => {
    assert.equal(error.code, "provider_catalog_credential_changed");
    assert.doesNotMatch(error.message, /old-account-key|new-account-key/);
    return true;
  });
  assert.equal(readProviderCatalogCache("deepseek"), undefined);
});

test("a cache hit is rejected after an external account replacement", async () => {
  process.env.DEEPSEEK_API_KEY = "";
  const {
    discoverProviderModels,
    providerDiscoveryIdentityFingerprint,
  } = await import("../src/model-discovery.mjs");
  const { writeProviderCredential } = await import("../src/provider-credentials.mjs");
  const baseUrl = "https://api.deepseek.com";
  writeProviderCredential("deepseek", "old-external-account-key");
  await writeProviderCatalogCache("deepseek", {
    discovered: ["old-account-only-model"],
    identityFingerprint: providerDiscoveryIdentityFingerprint({
      kind: "api",
      baseUrl,
      credential: { value: "old-external-account-key" },
    }),
  });

  // This intentionally bypasses the router's normal write+invalidation
  // transaction, just like an environment, Keychain, or official CLI account
  // change can. The identity verifier must still turn the old hit into a miss.
  writeProviderCredential("deepseek", "new-external-account-key");
  let fetches = 0;
  const result = await discoverProviderModels("deepseek", {
    loadPayload: async (_provider, identity) => {
      fetches += 1;
      assert.equal(identity.credential.value, "new-external-account-key");
      return { data: [{ id: "new-account-only-model" }] };
    },
  });
  assert.equal(fetches, 1);
  assert.equal(result.cached, false);
  assert.deepEqual(result.discovered, ["new-account-only-model"]);
  assert.deepEqual(readProviderCatalogCache("deepseek").discovered, ["new-account-only-model"]);
});

test("a damaged or foreign cache document reads as a miss", () => {
  for (const contents of [
    "{",
    JSON.stringify({ version: 99, providers: { deepseek: { discovered: ["x"], fetchedAt: "now" } } }),
    JSON.stringify({ version: 1, providers: { deepseek: { discovered: [] } } }),
    JSON.stringify({ version: 1, providers: { deepseek: { discovered: ["x"] } } }),
    JSON.stringify({ version: 2, providers: { deepseek: { discovered: ["x"], identityFingerprint: TEST_IDENTITY } } }),
    JSON.stringify({ version: 2, providers: { deepseek: { discovered: ["x"], identityFingerprint: TEST_IDENTITY, fetchedAt: new Date().toISOString(), provenance: { schema: "codex-router/provider-catalog/v1", providerId: "other", endpoint: "https://other.example.test/models", identityFingerprint: TEST_IDENTITY } } } }),
  ]) {
    writeFileSync(cachePath, contents, "utf8");
    assert.equal(readProviderCatalogCache("deepseek"), undefined);
  }
  rmSync(cachePath, { force: true });
});

test("a cache symlink is never followed", () => {
  if (process.platform === "win32") return;
  const foreign = path.join(stateRoot, "foreign-cache.json");
  writeFileSync(foreign, JSON.stringify({ version: 2, providers: {} }));
  symlinkSync(foreign, cachePath);
  assert.equal(readProviderCatalogCache("deepseek"), undefined);
  rmSync(cachePath, { force: true });
  rmSync(foreign, { force: true });
});

test("a provider id that is not one is never a cache key", async () => {
  assert.equal(readProviderCatalogCache("../escape"), undefined);
  assert.equal(await writeProviderCatalogCache("../escape", {
    discovered: ["x"],
    identityFingerprint: TEST_IDENTITY,
  }), undefined);
  assert.equal(existsSync(cachePath), false);
});

test("account scopes never reuse another account's catalog and stay bounded", async () => {
  await forgetProviderCatalogCache("scoped-provider");
  await writeProviderCatalogCache("scoped-provider", {
    discovered: ["shared-default"],
    fetchedAt: "2026-08-20T00:00:00.000Z",
  });
  await writeProviderCatalogCache("scoped-provider", {
    scope: "cred_alpha",
    discovered: ["alpha-only"],
    fetchedAt: "2026-08-21T00:00:00.000Z",
  });
  await writeProviderCatalogCache("scoped-provider", {
    scope: "cred_beta",
    discovered: ["beta-only"],
    fetchedAt: "2026-08-22T00:00:00.000Z",
  });

  assert.deepEqual(readProviderCatalogCache("scoped-provider").discovered, ["shared-default"]);
  assert.deepEqual(readProviderCatalogCache("scoped-provider", { scope: "cred_alpha" }).discovered, ["alpha-only"]);
  assert.deepEqual(readProviderCatalogCache("scoped-provider", { scope: "cred_beta" }).discovered, ["beta-only"]);
  assert.equal(readProviderCatalogCache("scoped-provider", { scope: "cred_missing" }), undefined);
  // An invalid scope must not fall back to the unscoped entry either.
  assert.equal(readProviderCatalogCache("scoped-provider", { scope: "../escape" }), undefined);

  for (let index = 0; index < MAX_SCOPES_PER_PROVIDER + 4; index += 1) {
    await writeProviderCatalogCache("scoped-provider", {
      scope: `cred_${String(index).padStart(2, "0")}`,
      discovered: [`model-${index}`],
      fetchedAt: new Date(Date.parse("2026-08-23T00:00:00.000Z") + index * 1_000).toISOString(),
    });
  }
  const stored = JSON.parse(readFileSync(cachePath, "utf8"));
  assert.equal(Object.keys(stored.providers["scoped-provider"].scopes).length, MAX_SCOPES_PER_PROVIDER);
  assert.equal(readProviderCatalogCache("scoped-provider", { scope: "cred_00" }), undefined);
  assert.deepEqual(
    readProviderCatalogCache("scoped-provider", { scope: "cred_19" }).discovered,
    ["model-19"],
  );
  assert.equal(await forgetProviderCatalogCache("scoped-provider", { scope: "cred_19" }), true);
  assert.equal(readProviderCatalogCache("scoped-provider", { scope: "cred_19" }), undefined);
  await forgetProviderCatalogCache("scoped-provider");
});

test("malformed scope types never fall back to the unscoped catalog", async () => {
  await forgetProviderCatalogCache("scope-type-provider");
  await writeProviderCatalogCache("scope-type-provider", {
    discovered: ["default-model"],
    fetchedAt: "2026-08-20T00:00:00.000Z",
  });
  for (const scope of [123, [], {}, "../escape"]) {
    assert.equal(readProviderCatalogCache("scope-type-provider", { scope }), undefined);
    assert.equal(
      await rawWriteProviderCatalogCache("scope-type-provider", { scope, discovered: ["should-not-write"], identityFingerprint: TEST_IDENTITY }),
      undefined,
    );
  }
  assert.deepEqual(readProviderCatalogCache("scope-type-provider").discovered, ["default-model"]);
  await forgetProviderCatalogCache("scope-type-provider");
});

test("one malformed metadata record invalidates the whole untrusted snapshot", async () => {
  await forgetProviderCatalogCache("metadata-provider");
  await writeProviderCatalogCache("metadata-provider", {
    discovered: ["valid", "invalid"],
    modelMetadata: {
      valid: { upstreamId: "valid", supportsTools: true },
      invalid: { upstreamId: "invalid", contextWindow: -1 },
      unknown: { upstreamId: "unknown", supportsTools: true },
    },
  });
  assert.equal(readProviderCatalogCache("metadata-provider"), undefined);
  await forgetProviderCatalogCache("metadata-provider");
});

test("a cached provider request profile is rejected as untrusted wire authority", async () => {
  await forgetProviderCatalogCache("profile-provider");
  writeFileSync(cachePath, `${JSON.stringify({
    version: 2,
    providers: {
      "profile-provider": {
        discovered: ["model"],
        fetchedAt: new Date().toISOString(),
        identityFingerprint: TEST_IDENTITY,
        modelMetadata: {
          model: { upstreamId: "model", requestProfile: "auto-tool-choice" },
        },
        provenance: {
          schema: "codex-router/provider-catalog/v1",
          providerId: "profile-provider",
          endpoint: "https://profile-provider.example.test/models",
          identityFingerprint: TEST_IDENTITY,
        },
      },
    },
  })}\n`, { mode: 0o600 });
  assert.equal(readProviderCatalogCache("profile-provider"), undefined);
  await forgetProviderCatalogCache("profile-provider");
});

test("oversized provider snapshots are evicted before the cache crosses its read limit", async () => {
  await forgetProviderCatalogCache("oversized-provider");
  const modelCount = 4_000;
  await writeProviderCatalogCache("oversized-provider", {
    discovered: Array.from({ length: modelCount }, (_, index) => `model-${index}-${"x".repeat(3_000)}`),
  });
  assert.ok(statSync(cachePath).size <= PROVIDER_CATALOG_CACHE_MAX_BYTES);
  // A snapshot too large to fit is deliberately not reported as a cache hit;
  // the next discovery can ask the provider again instead of trusting a
  // silently truncated list.
  assert.equal(readProviderCatalogCache("oversized-provider"), undefined);
});

test("a fixture comparison never becomes the stored answer", () => {
  const fixtureRoot = mkdtempSync(path.join(os.tmpdir(), "codex-router-catalog-fixture-"));
  try {
    const fixture = path.join(fixtureRoot, "models.json");
    writeFileSync(fixture, JSON.stringify({ data: [{ id: "deepseek-v9-preview" }] }));
    const result = JSON.parse(execFileSync(
      process.execPath,
      ["src/model-discovery.mjs", "deepseek", "--fixture", fixture, "--json"],
      {
        cwd: root,
        encoding: "utf8",
        env: {
          ...process.env,
          MODEL_ROUTER_STATE_DIR: fixtureRoot,
          CODEX_ROUTER_STATE_DIR: fixtureRoot,
          DEEPSEEK_API_KEY: "",
        },
      },
    ));
    assert.equal(result.cached, false);
    assert.ok(result.fetchedAt);
    assert.equal(
      existsSync(path.join(fixtureRoot, "provider-catalog-cache.json")),
      false,
      "a fixture run compares against a supplied file, not against what the provider serves",
    );
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

test("curation with a fixture never becomes the stored answer either", () => {
  const fixtureRoot = mkdtempSync(path.join(os.tmpdir(), "codex-router-curation-fixture-"));
  try {
    const fixture = path.join(fixtureRoot, "models.json");
    writeFileSync(fixture, JSON.stringify({ data: [{ id: "deepseek-v9-preview" }] }));
    execFileSync(
      process.execPath,
      [
        "src/curate-models.mjs",
        "deepseek",
        "--fixture",
        fixture,
        "--models",
        "deepseek-v9-preview",
        "--no-apply",
      ],
      {
        cwd: root,
        encoding: "utf8",
        env: {
          ...process.env,
          MODEL_ROUTER_STATE_DIR: fixtureRoot,
          CODEX_ROUTER_STATE_DIR: fixtureRoot,
          MODEL_ROUTER_USER_MODELS: path.join(fixtureRoot, "user-models.json"),
          DEEPSEEK_API_KEY: "",
        },
      },
    );
    assert.equal(existsSync(path.join(fixtureRoot, "provider-catalog-cache.json")), false);
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

test("a same-account stored list answers discovery without a network", async () => {
  const offlineRoot = mkdtempSync(path.join(os.tmpdir(), "codex-router-catalog-offline-"));
  try {
    const credential = "offline-same-account-key";
    const baseUrl = "http://127.0.0.1:9";
    const { providerDiscoveryIdentityFingerprint } = await import("../src/model-discovery.mjs");
    writeFileSync(path.join(offlineRoot, "internal-secret"), `${internalSecret}\n`, { mode: 0o600 });
    writeFileSync(path.join(offlineRoot, "deepseek-api-key.secret"), `${credential}\n`, { mode: 0o600 });
    writeFileSync(
      path.join(offlineRoot, "provider-catalog-cache.json"),
      `${JSON.stringify({
        version: 2,
        providers: {
          deepseek: {
            fetchedAt: "2020-01-01T00:00:00.000Z",
            discovered: ["deepseek-v4-flash", "deepseek-v9-preview"],
            contextLengths: { "deepseek-v9-preview": 262_144 },
            identityFingerprint: providerDiscoveryIdentityFingerprint({
              kind: "api",
              baseUrl,
              credential: { value: credential },
            }),
            provenance: {
              schema: "codex-router/provider-catalog/v1",
              providerId: "deepseek",
              endpoint: `${baseUrl}/models`,
              identityFingerprint: providerDiscoveryIdentityFingerprint({
                kind: "api",
                baseUrl,
                credential: { value: credential },
              }),
            },
          },
        },
      })}\n`,
      { mode: 0o600 },
    );
    const environment = {
      ...process.env,
      MODEL_ROUTER_STATE_DIR: offlineRoot,
      CODEX_ROUTER_STATE_DIR: offlineRoot,
      DEEPSEEK_API_KEY: "",
      // Pinning the endpoint at a port nothing listens on proves the matching
      // account can read its bound cache without a network, while an explicit
      // refresh still fails rather than silently substituting that cache.
      DEEPSEEK_API_BASE_URL: baseUrl,
    };
    const cached = JSON.parse(execFileSync(
      process.execPath,
      ["src/model-discovery.mjs", "deepseek", "--json"],
      { cwd: root, encoding: "utf8", env: environment },
    ));
    assert.equal(cached.cached, true);
    assert.equal(cached.fetchedAt, "2020-01-01T00:00:00.000Z");
    // Old enough to want re-reading, and still served rather than withheld.
    assert.equal(cached.stale, true);
    assert.deepEqual(cached.unregistered, ["deepseek-v9-preview"]);
    // What is registered locally is always recomputed, never cached, so a
    // stored list can never claim a model is curated when it is not.
    assert.ok(cached.registered.includes("deepseek-v4-flash"));

    // Refreshing is the only path that reaches the provider, and when it
    // cannot be reached it must fail rather than quietly serve the stored list.
    assert.throws(() => execFileSync(
      process.execPath,
      ["src/model-discovery.mjs", "deepseek", "--json", "--refresh"],
      { cwd: root, encoding: "utf8", env: environment, stdio: ["ignore", "pipe", "pipe"] },
    ));
  } finally {
    rmSync(offlineRoot, { recursive: true, force: true });
  }
});
