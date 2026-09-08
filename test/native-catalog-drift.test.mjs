import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("drift detection triggers republish with new arbitrary native in merged output", async () => {
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
    const { nativeCatalogDriftDetected, republishOnNativeDrift } = await import("../src/native-catalog-drift.mjs");
    const { codexBinaryFingerprint, codexVersion } = await import("../src/codex-binary.mjs");
    const { NATIVE_CATALOG_PATH, MERGED_CATALOG_PATH, CONFIG_PATH } = await import("../src/paths.mjs");

    // Create minimal managed config so codexIntegrationInstalled returns true
    writeFileSync(CONFIG_PATH, "# BEGIN codex-router-managed\nopenai_base_url = \"http://test\"\n# END codex-router-managed\n");

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

    // Simulate stored native-models.json with old fingerprint. Match a real
    // installed Codex when the test host has one; CI hosts without Codex keep
    // the historical fallback fixture.
    const currentVersion = codexVersion();
    const currentBinaryFingerprint = codexBinaryFingerprint();
    const storedCatalog = {
      captured_with: currentVersion || "codex-cli 0.146.1",
      native_source_fingerprint: oldFingerprint,
      ...(currentBinaryFingerprint
        ? { native_binary_fingerprint: currentBinaryFingerprint }
        : {}),
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

    // NOW drift should be detected
    assert.equal(nativeCatalogDriftDetected(), true, "drift detected when new native appears");

    // Verify NEW fingerprint differs from stored
    const newFingerprint = createHash("sha256")
      .update(JSON.stringify([oldNative, newNative]))
      .digest("hex");
    assert.notEqual(newFingerprint, oldFingerprint, "fingerprint changed");

    // Put the frozen input back. The automatic path must refresh it before it
    // checks drift; comparing first would reproduce issue #628 forever.
    writeFileSync(
      path.join(codexHome, "models_cache.json"),
      JSON.stringify(modelsCache),
    );
    assert.equal(nativeCatalogDriftDetected(), false, "frozen cache alone has no drift");

    process.env.CODEX_ROUTER_NO_DISCOVERY = "1";
    try {
      writeFileSync(
        path.join(codexHome, "models_cache.json"),
        JSON.stringify(updatedCache),
      );
      assert.equal(
        nativeCatalogDriftDetected(),
        false,
        "discovery-disabled drift checks do not read account-cache changes",
      );
    } finally {
      delete process.env.CODEX_ROUTER_NO_DISCOVERY;
      writeFileSync(
        path.join(codexHome, "models_cache.json"),
        JSON.stringify(modelsCache),
      );
    }

    // NOW TEST ACTUAL REPUBLISH: Call republishOnNativeDrift()
    // This should refresh the account cache, detect drift, and run the full
    // publish path in that order.
    const republished = await republishOnNativeDrift({
      refreshAccountCatalog: async () => {
        writeFileSync(
          path.join(codexHome, "models_cache.json"),
          JSON.stringify(updatedCache),
        );
        return { status: "updated" };
      },
    });
    
    // Republish should have succeeded
    assert.equal(republished, true, "republish succeeded");

    // VERIFY: merged-models.json or native-models.json should now contain NEW arbitrary native
    const updated = JSON.parse(readFileSync(NATIVE_CATALOG_PATH, "utf8"));
    const updatedSlugs = updated.models.map(m => m.slug);
    
    assert.ok(
      updatedSlugs.includes("gpt-7-prime"),
      "NEW arbitrary native (gpt-7-prime) appears in native-models.json after republish"
    );
    assert.ok(
      updatedSlugs.includes("gpt-5.6-sol"),
      "existing native (gpt-5.6-sol) preserved after republish"
    );
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

test("managed Codex marker detection matches config-manager blocks", async () => {
  const { managedCodexConfigDetected } = await import("../src/native-catalog-drift.mjs");

  assert.equal(managedCodexConfigDetected("# BEGIN codex-router-managed\n"), true);
  assert.equal(managedCodexConfigDetected("# BEGIN codex-router-provider-managed\n"), true);
  assert.equal(managedCodexConfigDetected("# BEGIN kimi-codex-proxy-managed\n"), true);
  assert.equal(managedCodexConfigDetected("# BEGIN something-else\n"), false);
});

test("startup drift detection repairs missing routed agents without native model drift", async () => {
  const {
    republishOnNativeDrift,
    routedAgentCatalogDriftDetected,
  } = await import("../src/native-catalog-drift.mjs");

  const settings = { version: 2, mode: "proven", enabled: [], disabled: [] };
  const model = {
    slug: "zai-coding/glm-5.3",
    displayName: "GLM 5.3",
    multiAgentVersion: "v2",
  };
  let statusModels;
  assert.equal(
    routedAgentCatalogDriftDetected({
      integrationInstalled: () => true,
      readConfig: () => 'openai_base_url = "http://127.0.0.1:4202/v1"\n',
      selectedModels: () => [model],
      readSettings: () => settings,
      readHidden: () => new Set(),
      agentStatus: (models) => {
        statusModels = models;
        return { ok: false };
      },
    }),
    true,
    "a missing managed definition is startup drift",
  );
  assert.deepEqual(statusModels.map((entry) => entry.slug), [model.slug]);

  let refreshes = 0;
  const repaired = await republishOnNativeDrift({
    refreshAccountCatalog: async () => ({ status: "not-modified" }),
    nativeDriftDetected: () => false,
    routedAgentDriftDetected: () => true,
    refreshTargetPicker: async () => { refreshes += 1; },
  });
  assert.equal(repaired, true);
  assert.equal(refreshes, 1, "agent drift alone republishes the installed picker");

  refreshes = 0;
  const unchanged = await republishOnNativeDrift({
    refreshAccountCatalog: async () => ({ status: "not-modified" }),
    nativeDriftDetected: () => false,
    routedAgentDriftDetected: () => false,
    refreshTargetPicker: async () => { refreshes += 1; },
  });
  assert.equal(unchanged, false);
  assert.equal(refreshes, 0, "current native and agent state stays write-free");
});

test("routed agent startup drift detection fails closed on inactive or uncertain config", async () => {
  const { routedAgentCatalogDriftDetected } = await import("../src/native-catalog-drift.mjs");
  const common = {
    integrationInstalled: () => true,
    selectedModels: () => [{ slug: "zai-coding/glm-5.3", multiAgentVersion: "v2" }],
    readSettings: () => ({ version: 2, mode: "proven", enabled: [], disabled: [] }),
    readHidden: () => new Set(),
    agentStatus: () => ({ ok: false }),
  };
  assert.equal(
    routedAgentCatalogDriftDetected({
      ...common,
      readConfig: () => 'model_provider = "other"\n[model_providers.other]\nbase_url = "https://example.com/v1"\n',
    }),
    false,
    "a transport not owned by the router must not trigger repair",
  );
  assert.equal(
    routedAgentCatalogDriftDetected({
      ...common,
      readConfig: () => { throw new Error("config busy"); },
    }),
    false,
    "an uncertain config read must not trigger repair",
  );
});
