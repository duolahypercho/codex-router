import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

process.env.CODEX_ROUTER_STATE_DIR = mkdtempSync(path.join(os.tmpdir(), "models-dev-test-"));

const {
  MODELS_DEV_PROVIDER_KEYS,
  fetchModelsDevCatalog,
  filterModelsDevCatalog,
  modelsDevMetadata,
  readModelsDevSnapshot,
} = await import("../src/models-dev.mjs");
const { PROVIDERS } = await import("../src/model-registry.mjs");
const { userModelEntry } = await import("../src/user-models.mjs");

const catalog = {
  groq: {
    id: "groq",
    models: {
      "llama-3.3-70b-versatile": {
        id: "llama-3.3-70b-versatile",
        name: "Llama 3.3 70B",
        reasoning: false,
        modalities: { input: ["text", "image", "audio"], output: ["text"] },
        limit: { context: 131072, output: 32768 },
        cost: { input: 0.59, output: 0.79 },
      },
      "broken-context": {
        id: "broken-context",
        name: "Broken",
        modalities: { input: ["video"] },
        limit: { context: 12 },
      },
    },
  },
};

test("every openai-compatible provider maps to a models.dev key", () => {
  for (const provider of PROVIDERS.values()) {
    if (provider.kind !== "openai-compatible") continue;
    assert.ok(
      MODELS_DEV_PROVIDER_KEYS[provider.id],
      `provider ${provider.id} is missing a models.dev mapping`,
    );
  }
});

test("modelsDevMetadata normalizes catalog values for the registry validator", () => {
  const metadata = modelsDevMetadata(catalog, "groq", "llama-3.3-70b-versatile");
  assert.equal(metadata.contextWindow, 131072);
  assert.ok(Number.isInteger(metadata.autoCompact));
  assert.ok(metadata.autoCompact >= 1 && metadata.autoCompact <= metadata.contextWindow);
  assert.ok(metadata.autoCompact % 1000 === 0);
  // audio is not a supported input modality; text/image survive.
  assert.deepEqual(metadata.inputModalities, ["text", "image"]);
  // Naming stays the router's own; models.dev must not rename curated models.
  assert.equal(metadata.displayName, undefined);
  assert.ok(metadata.description.includes("models.dev"));
  assert.ok(metadata.description.includes("$0.59/M input"));
  assert.equal(metadata.metadataSource, "models.dev");
});

test("modelsDevMetadata matches upstream ids case-insensitively", () => {
  const metadata = modelsDevMetadata(catalog, "groq", "LLAMA-3.3-70B-VERSATILE");
  assert.equal(metadata.contextWindow, 131072);
});

test("modelsDevMetadata rejects implausible sizing and unsupported modalities", () => {
  const metadata = modelsDevMetadata(catalog, "groq", "broken-context");
  // A 12-token context is below the sanity floor, so sizing stays default.
  assert.equal(metadata.contextWindow, undefined);
  assert.equal(metadata.autoCompact, undefined);
  // video filters out; text is always present so the validator accepts it.
  assert.deepEqual(metadata.inputModalities, ["text"]);
});

test("modelsDevMetadata returns undefined for unknown providers and models", () => {
  assert.equal(modelsDevMetadata(catalog, "no-such-provider", "x"), undefined);
  assert.equal(modelsDevMetadata(catalog, "groq", "no-such-model"), undefined);
  assert.equal(modelsDevMetadata({}, "groq", "llama-3.3-70b-versatile"), undefined);
});

test("enriched entries still satisfy the user-model shape", () => {
  const metadata = modelsDevMetadata(catalog, "groq", "llama-3.3-70b-versatile");
  const entry = userModelEntry({
    providerId: "groq",
    upstreamId: "llama-3.3-70b-versatile",
    priority: 100,
    metadata,
  });
  // Identity fields are never overridable by catalog data.
  assert.equal(entry.slug, "groq/llama-3.3-70b-versatile");
  assert.equal(entry.provider, "groq");
  assert.equal(entry.gatewayModel, "groq-llama-3-3-70b-versatile");
  assert.equal(entry.contextWindow, 131072);
  assert.deepEqual(entry.inputModalities, ["text", "image"]);
  assert.equal(entry.displayName, "llama-3.3-70b-versatile (curated)");
});

test("metadata overrides cannot replace identity or routing fields", () => {
  const entry = userModelEntry({
    providerId: "groq",
    upstreamId: "model-a",
    priority: 100,
    metadata: {
      slug: "evil/other",
      provider: "evil",
      gatewayModel: "evil",
      requestProfile: "evil",
      displayName: "Evil Name",
      contextWindow: 200000,
      autoCompact: 170000,
    },
  });
  assert.equal(entry.slug, "groq/model-a");
  assert.equal(entry.provider, "groq");
  assert.equal(entry.gatewayModel, "groq-model-a");
  assert.equal(entry.requestProfile, undefined);
  assert.equal(entry.displayName, "model-a (curated)");
  assert.equal(entry.contextWindow, 200000);
  assert.equal(entry.autoCompact, 170000);
});

test("the checked-in snapshot is valid and usable as a metadata source", () => {
  const snapshot = readModelsDevSnapshot();
  assert.ok(snapshot, "config/models-dev.json must exist and parse");
  assert.equal(snapshot.version, 1);
  assert.ok(snapshot.fetchedAt);
  for (const key of new Set(Object.values(MODELS_DEV_PROVIDER_KEYS))) {
    assert.ok(snapshot.providers[key], `snapshot is missing mapped provider ${key}`);
  }
  // The snapshot must satisfy the same normalization path as a live fetch.
  const [providerId, providerKey] = Object.entries(MODELS_DEV_PROVIDER_KEYS).find(
    ([, key]) => Object.keys(snapshot.providers[key].models).length > 0,
  );
  const upstreamId = Object.keys(snapshot.providers[providerKey].models)[0];
  const metadata = modelsDevMetadata(snapshot.providers, providerId, upstreamId);
  assert.ok(metadata === undefined || metadata.metadataSource === "models.dev");
});

test("filterModelsDevCatalog is deterministic and idempotent", () => {
  const snapshot = readModelsDevSnapshot();
  const once = filterModelsDevCatalog(snapshot.providers);
  const twice = filterModelsDevCatalog(once);
  assert.deepEqual(once, twice);
  assert.deepEqual(Object.keys(once), [...Object.keys(once)].sort());
  // Unmapped providers never enter the snapshot.
  const mapped = new Set(Object.values(MODELS_DEV_PROVIDER_KEYS));
  for (const key of Object.keys(once)) assert.ok(mapped.has(key));
});

test("fetchModelsDevCatalog rejects invalid documents", async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => new Response(JSON.stringify([1, 2, 3]), { status: 200 });
    await assert.rejects(() => fetchModelsDevCatalog(), /invalid catalog/);
    globalThis.fetch = async () => new Response("nope", { status: 503 });
    await assert.rejects(() => fetchModelsDevCatalog(), /HTTP 503/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
