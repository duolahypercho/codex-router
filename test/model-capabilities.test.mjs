import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  CONSERVATIVE_MODEL_DEFAULTS,
  mergeModelMetadata,
  mergeDiscoveredModels,
  modelMetadataFromProviderRecord,
} from "../src/model-capabilities.mjs";
const { discoverProviderModels } = await import("../src/model-discovery.mjs");

test("model metadata accepts canonical records and ignores null pricing", () => {
  assert.deepEqual(
    modelMetadataFromProviderRecord({
      upstreamId: "local/qwen",
      displayName: "Local Qwen",
      pricing: null,
      supportsTools: true,
    }),
    {
      upstreamId: "local/qwen",
      displayName: "Local Qwen",
      supportsTools: true,
    },
  );
});

test("untrusted provider metadata cannot select a router request profile", () => {
  assert.equal(
    modelMetadataFromProviderRecord({ id: "provider/model", requestProfile: "glm-thinking" }).requestProfile,
    undefined,
  );
  assert.equal(
    modelMetadataFromProviderRecord({ id: "provider/model", requestProfile: "glm-thinking" }, { trusted: true }).requestProfile,
    "glm-thinking",
  );
});

test("metadata precedence is user, verified, live, then conservative defaults", () => {
  const merged = mergeModelMetadata({
    providerId: "example",
    upstreamId: "example/model",
    live: { upstreamId: "example/model", displayName: "Live", supportsVision: true },
    verifiedPreset: { upstreamId: "example/model", displayName: "Verified", contextWindow: 262_144 },
    userOverride: { upstreamId: "example/model", displayName: "Chosen", supportsVision: false },
  });
  assert.equal(merged.displayName, "Chosen");
  assert.equal(merged.contextWindow, 262_144);
  assert.equal(merged.supportsVision, false);
  assert.equal(merged.supportsTools, CONSERVATIVE_MODEL_DEFAULTS.supportsTools);
});

test("invalid live metadata is rejected without weakening valid records", () => {
  assert.throws(
    () => modelMetadataFromProviderRecord({ id: "example/invalid", input_modalities: [] }),
    /input_modalities must be a non-empty array/,
  );
  const models = mergeDiscoveredModels({
    providerId: "example",
    live: [{ id: "example/valid", supports_tools: true }],
  });
  assert.equal(models[0].upstreamId, "example/valid");
});

test("discovery keeps model ids when one live capability record is malformed", async () => {
  const fixtureRoot = mkdtempSync(path.join(os.tmpdir(), "codex-router-capability-discovery-"));
  const fixture = path.join(fixtureRoot, "models.json");
  const previousArgv = process.argv.slice();
  writeFileSync(fixture, JSON.stringify({
    data: [
      { id: "provider/valid", supports_tools: true, context_length: 65536 },
      { id: "provider/invalid", input_modalities: [] },
    ],
  }));
  process.argv.push("--fixture", fixture);
  try {
    const result = await discoverProviderModels("commandcode", { cache: false });
    assert.deepEqual(result.discovered, ["provider/invalid", "provider/valid"]);
    assert.deepEqual(
      result.modelMetadata.find((entry) => entry.upstreamId === "provider/valid"),
      {
        upstreamId: "provider/valid",
        displayName: "provider/valid",
        contextWindow: 65536,
        inputModalities: ["text"],
        outputModalities: ["text"],
        supportsTools: true,
        supportsReasoning: false,
        supportsVision: false,
        supportsSearch: false,
        userDefined: false,
      },
    );
    assert.equal(
      result.modelMetadata.some((entry) => entry.upstreamId === "provider/invalid"),
      false,
      "invalid optional metadata must not be promoted into the capability catalog",
    );
  } finally {
    process.argv.splice(0, process.argv.length, ...previousArgv);
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
});
