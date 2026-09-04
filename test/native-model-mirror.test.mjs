import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

process.env.MODEL_ROUTER_USER_MODELS = path.join(
  mkdtempSync(path.join(os.tmpdir(), "native-model-mirror-test-")),
  "user-models.json",
);

const {
  NATIVE_MODEL_MIRROR_MARKER,
  planNativeModelMirror,
  syncNativeModelMirrors,
} = await import("../src/native-model-mirror.mjs");

const provider = {
  id: "private",
  displayName: "Private",
  kind: "openai-compatible",
  protocol: "openai-responses",
  mirrorNativeModels: true,
};

const astra = {
  slug: "gpt-6-astra",
  display_name: "GPT-6-Astra",
  visibility: "list",
  supported_in_api: true,
  context_window: 272_000,
  input_modalities: ["text", "image"],
  default_reasoning_level: "medium",
  supported_reasoning_levels: [
    { effort: "low", description: "Fast" },
    { effort: "medium", description: "Balanced" },
    { effort: "high", description: "Deep" },
    { effort: "xhigh", description: "Deeper" },
    { effort: "max", description: "Maximum" },
    { effort: "ultra", description: "Delegated" },
  ],
  service_tiers: [{ id: "priority", name: "Fast", description: "Higher speed" }],
};

test("native mirroring adds only account-visible models advertised by the provider", () => {
  const manual = {
    slug: "private/gpt-5.6-sol",
    upstreamModel: "gpt-5.6-sol",
    provider: "private",
    priority: 100,
  };
  const result = planNativeModelMirror({
    provider,
    nativeModels: [
      astra,
      { ...astra, slug: "gpt-hidden", visibility: "hide" },
      { ...astra, slug: "gpt-not-served" },
    ],
    discovered: ["gpt-6-astra", "gpt-hidden", "upstream-only"],
    existing: [manual],
  });

  assert.deepEqual(result.added, ["private/gpt-6-astra"]);
  assert.deepEqual(result.updated, []);
  assert.equal(result.models[0], manual);
  const mirrored = result.models[1];
  assert.equal(mirrored.managedBy, NATIVE_MODEL_MIRROR_MARKER);
  assert.equal(mirrored.contextWindow, 272_000);
  assert.equal(mirrored.autoCompact, 231_200);
  assert.deepEqual(mirrored.inputModalities, ["text", "image"]);
  assert.equal(mirrored.defaultEffort, "medium");
  assert.deepEqual(
    mirrored.reasoningLevels.map((level) => level.effort),
    ["low", "medium", "high", "xhigh", "max"],
  );
  assert.deepEqual(mirrored.serviceTiers, astra.service_tiers);
});

test("native mirroring updates its own entries and preserves manual curation", () => {
  const first = planNativeModelMirror({
    provider,
    nativeModels: [astra],
    discovered: [astra.slug],
    existing: [],
  });
  const managed = first.models[0];
  const updated = planNativeModelMirror({
    provider,
    nativeModels: [{ ...astra, context_window: 300_000 }],
    discovered: [astra.slug],
    existing: [managed],
  });
  assert.deepEqual(updated.added, []);
  assert.deepEqual(updated.updated, ["private/gpt-6-astra"]);
  assert.equal(updated.models[0].contextWindow, 300_000);

  const manual = { ...managed, managedBy: undefined, contextWindow: 123_456 };
  const preserved = planNativeModelMirror({
    provider,
    nativeModels: [astra],
    discovered: [astra.slug],
    existing: [manual],
  });
  assert.deepEqual(preserved.preserved, ["private/gpt-6-astra"]);
  assert.equal(preserved.models[0].contextWindow, 123_456);
});

test("sync discovers opted-in providers, persists additions, and selects them", async () => {
  let written;
  let shown;
  let transaction;
  const result = await syncNativeModelMirrors({
    providers: new Map([[provider.id, provider]]),
    discover: async (providerId, options) => {
      assert.equal(providerId, "private");
      assert.deepEqual(options, { refresh: true });
      return { discovered: [astra.slug] };
    },
    readNative: () => ({ models: [astra] }),
    readModels: () => [],
    writeModels: (models) => { written = models; },
    showModels: (slugs) => { shown = slugs; },
    transact: async (options) => {
      transaction = options;
      return options.mutate();
    },
  });
  assert.equal(result.changed, true);
  assert.deepEqual(result.added, ["private/gpt-6-astra"]);
  assert.equal(written[0].slug, "private/gpt-6-astra");
  assert.deepEqual(shown, ["private/gpt-6-astra"]);
  assert.equal(transaction.restart, true);
  assert.equal(typeof transaction.applyPublication, "function");
});

test("sync does not publish or restart when managed metadata is current", async () => {
  const current = planNativeModelMirror({
    provider,
    nativeModels: [astra],
    discovered: [astra.slug],
    existing: [],
  }).models;
  let transacted = false;
  const result = await syncNativeModelMirrors({
    providers: new Map([[provider.id, provider]]),
    discover: async () => ({ discovered: [astra.slug] }),
    readNative: () => ({ models: [astra] }),
    readModels: () => current,
    transact: async () => { transacted = true; },
  });
  assert.equal(result.changed, false);
  assert.equal(transacted, false);
});

test("sync is a no-network no-op without an opted-in provider", async () => {
  let discovered = false;
  const result = await syncNativeModelMirrors({
    providers: new Map([[provider.id, { ...provider, mirrorNativeModels: false }]]),
    discover: async () => { discovered = true; },
  });
  assert.equal(discovered, false);
  assert.equal(result.changed, false);
});
