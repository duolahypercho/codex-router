import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("native catalog drift detection without mocking", async () => {
  // Create a temporary state directory
  const tempDir = mkdtempSync(path.join(os.tmpdir(), "native-drift-test-"));
  const stateDir = path.join(tempDir, "state");
  const codexHome = path.join(tempDir, "codex");
  mkdirSync(stateDir, { recursive: true });
  mkdirSync(codexHome, { recursive: true });

  // Save original env
  const originalStateDir = process.env.MODEL_ROUTER_STATE_DIR;
  const originalCodexHome = process.env.CODEX_HOME;
  const originalTarget = process.env.MODEL_ROUTER_TARGET;

  try {
    // Set up environment
    process.env.MODEL_ROUTER_STATE_DIR = stateDir;
    process.env.CODEX_HOME = codexHome;
    process.env.MODEL_ROUTER_TARGET = "codex";

    // Import after env is set
    const { nativeCatalogDriftDetected } = await import("../src/native-catalog-drift.mjs");
    const { NATIVE_CATALOG_PATH } = await import("../src/paths.mjs");

    // Simulate OLD native model in models_cache.json
    const oldNative = {
      slug: "gpt-5.6-sol",
      name: "GPT Sol",
      visibility: "list",
    };
    const oldFingerprint = createHash("sha256")
      .update(JSON.stringify([oldNative]))
      .digest("hex");

    const modelsCache = {
      models: [oldNative],
    };
    writeFileSync(
      path.join(codexHome, "models_cache.json"),
      JSON.stringify(modelsCache),
    );

    // Simulate stored native-models.json with old fingerprint
    const storedCatalog = {
      captured_with: "codex-cli 0.146.1",
      native_source_fingerprint: oldFingerprint,
      models: [oldNative],
    };
    writeFileSync(NATIVE_CATALOG_PATH, JSON.stringify(storedCatalog));

    // With matching fingerprints, no drift should be detected
    assert.equal(nativeCatalogDriftDetected(), false, "no drift when fingerprints match");

    // NOW simulate Codex updating models_cache.json with NEW arbitrary native
    const newNative = {
      slug: "gpt-7-prime", // Arbitrary future native
      name: "GPT Prime",
      visibility: "list",
    };
    const updatedCache = {
      models: [oldNative, newNative], // NEW model added
    };
    writeFileSync(
      path.join(codexHome, "models_cache.json"),
      JSON.stringify(updatedCache),
    );

    // NOW drift should be detected (fingerprint changed, stored catalog stale)
    assert.equal(nativeCatalogDriftDetected(), true, "drift detected when new native appears");

    // Verify NEW fingerprint differs from stored
    const newFingerprint = createHash("sha256")
      .update(JSON.stringify([oldNative, newNative]))
      .digest("hex");
    assert.notEqual(newFingerprint, oldFingerprint, "fingerprint changed");
  } finally {
    // Restore original env
    if (originalStateDir !== undefined) process.env.MODEL_ROUTER_STATE_DIR = originalStateDir;
    else delete process.env.MODEL_ROUTER_STATE_DIR;
    if (originalCodexHome !== undefined) process.env.CODEX_HOME = originalCodexHome;
    else delete process.env.CODEX_HOME;
    if (originalTarget !== undefined) process.env.MODEL_ROUTER_TARGET = originalTarget;
    else delete process.env.MODEL_ROUTER_TARGET;
    
    rmSync(tempDir, { recursive: true, force: true });
  }
});
