import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { freeModelIds, modelIds } from "../src/model-discovery.mjs";
import { LISTED_MODELS, PROVIDERS } from "../src/model-registry.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function isolatedEnvironment(testRoot) {
  return {
    ...process.env,
    HOME: testRoot,
    CODEX_HOME: path.join(testRoot, "codex"),
    CODEX_ROUTER_STATE_DIR: path.join(testRoot, "state"),
    MODEL_ROUTER_USER_MODELS: path.join(testRoot, "state", "user-models.json"),
    CODEX_ROUTER_SERVICE_PLATFORM: "linux",
    CODEX_ROUTER_LAUNCH_AGENTS_DIR: path.join(testRoot, "LaunchAgents"),
    CODEX_ROUTER_SKIP_LAUNCHCTL: "1",
    KIMI_CODE_HOME: path.join(testRoot, "kimi-code"),
    GROK_AUTH_PATH: path.join(testRoot, "grok", "auth.json"),
    ORCAROUTER_API_KEY: "",
    ORCAROUTER_BASE_URL: "",
  };
}

function runNode(args, env) {
  return spawnSync(process.execPath, args, { cwd: root, env, encoding: "utf8" });
}

function writeCredential(testRoot) {
  const stateDir = path.join(testRoot, "state");
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  writeFileSync(path.join(stateDir, "orcarouter-api-key.secret"), "TEST_ORCAROUTER_KEY\n", {
    mode: 0o600,
  });
}

function catalogFixture() {
  return {
    data: [
      {
        id: "orcarouter/free",
        supported_endpoint_types: ["openai", "openai-response", "anthropic"],
      },
      {
        id: "deepseek/deepseek-v4-flash-free",
        supported_endpoint_types: ["openai", "openai-response"],
        context_length: 65_536,
        pricing: { request: "0.000000" },
      },
      {
        id: "vendor/zero-token-price",
        supported_endpoint_types: ["openai"],
        context_length: 200_000,
        pricing: { prompt: "0", completion: 0 },
      },
      {
        id: "vendor/paid",
        supported_endpoint_types: ["openai"],
        pricing: { prompt: "0.000001", completion: "0.000002" },
      },
      {
        id: "vendor/image-only-free",
        supported_endpoint_types: ["image"],
        pricing: { request: "0" },
      },
      {
        id: "vendor/unspecified-surface-free",
        supported_endpoint_types: null,
        pricing: { request: "0" },
      },
      {
        id: "vendor/unspecified-paid",
        supported_endpoint_types: null,
        pricing: { prompt: "0.000001", completion: "0.000002" },
      },
    ],
  };
}

test("OrcaRouter is a credentialed catalog-only OpenAI provider", () => {
  const provider = PROVIDERS.get("orca");
  assert.equal(provider.displayName, "OrcaRouter");
  assert.equal(provider.baseUrl, "https://api.orcarouter.ai/v1");
  assert.equal(provider.baseUrlEnv, "ORCAROUTER_BASE_URL");
  assert.deepEqual(provider.credential.environment, ["ORCAROUTER_API_KEY"]);
  assert.equal(provider.credential.file, "orcarouter-api-key.secret");
  assert.deepEqual(provider.credential.keychainServices, ["codex-router-orcarouter"]);
  assert.equal(LISTED_MODELS.some(({ provider: id }) => id === "orca"), false);

  const overlay = readFileSync(
    path.join(root, "apps", "macos", "ModelRouterTray", "Sources", "IslandOverlay.swift"),
    "utf8",
  );
  assert.match(
    overlay,
    /\["deepseek", "chutes", "orca"\]\.contains\(provider\)[\s\S]*return routerMessage\(\.meteredApi\)/,
  );
});

test("OrcaRouter discovery keeps callable chat models and identifies the free subset", () => {
  const provider = PROVIDERS.get("orca");
  const payload = catalogFixture();
  assert.deepEqual(modelIds(payload, provider), [
    "deepseek/deepseek-v4-flash-free",
    "vendor/paid",
    "vendor/unspecified-surface-free",
    "vendor/zero-token-price",
  ]);
  assert.deepEqual(freeModelIds(payload, provider), [
    "deepseek/deepseek-v4-flash-free",
    "vendor/unspecified-surface-free",
    "vendor/zero-token-price",
  ]);
});

test("a configured OrcaRouter provider enables cleanly and doctor requests curation", () => {
  const testRoot = mkdtempSync(path.join(os.tmpdir(), "orcarouter-enable-test-"));
  try {
    writeCredential(testRoot);
    const stateDir = path.join(testRoot, "state");
    writeFileSync(
      path.join(stateDir, "enabled-providers.json"),
      `${JSON.stringify({ version: 1, providers: [] })}\n`,
      { mode: 0o600 },
    );
    const env = isolatedEnvironment(testRoot);
    const enabled = runNode(["src/providers.mjs", "enable", "orca"], env);
    assert.equal(enabled.status, 0, enabled.stderr);
    assert.match(enabled.stdout, /OrcaRouter is enabled, but ships no preselected models/);
    assert.match(enabled.stdout, /curate-models orca/);

    const doctor = runNode(["src/doctor.mjs", "--json"], env);
    assert.equal(doctor.status, 1, doctor.stderr);
    const report = JSON.parse(doctor.stdout);
    const byName = Object.fromEntries(report.checks.map((check) => [check.name, check]));
    assert.equal(byName["OrcaRouter key"].status, "ok");
    assert.equal(byName["OrcaRouter models"].status, "warn");
    assert.match(byName["OrcaRouter models"].fix, /curate-models orca/);
  } finally {
    rmSync(testRoot, { recursive: true, force: true });
  }
});

test("--free-only additively curates the live free OrcaRouter catalog", () => {
  const testRoot = mkdtempSync(path.join(os.tmpdir(), "orcarouter-curation-test-"));
  try {
    const fixture = path.join(testRoot, "models.json");
    const userModels = path.join(testRoot, "user-models.json");
    writeFileSync(fixture, JSON.stringify(catalogFixture()));
    writeFileSync(userModels, JSON.stringify({
      version: 1,
      models: [
        {
          provider: "orca",
          upstreamModel: "orcarouter/free",
          slug: "orca/orcarouter-free",
          gatewayModel: "orca-orcarouter-free",
          displayName: "orcarouter/free (curated)",
          description: "Legacy moving free meta-router",
          contextWindow: 131072,
          autoCompact: 111411,
          inputModalities: ["text"],
          priority: 98,
          compHash: "orca-orcarouter-free-user-v1"
        },
        {
          provider: "orca",
          upstreamModel: "vendor/existing-paid",
          slug: "orca/vendor-existing-paid",
          gatewayModel: "orca-vendor-existing-paid",
          displayName: "vendor/existing-paid (OrcaRouter)",
          description: "Locally curated OrcaRouter model",
          contextWindow: 131072,
          autoCompact: 111411,
          inputModalities: ["text"],
          priority: 99,
          compHash: "orca-vendor-existing-paid-user-v1"
        },
      ],
    }));
    const result = spawnSync(process.execPath, [
      path.join(root, "src", "curate-models.mjs"),
      "orca",
      "--fixture",
      fixture,
      "--free-only",
      "--no-apply",
    ], {
      cwd: root,
      encoding: "utf8",
      env: {
        ...process.env,
        MODEL_ROUTER_USER_MODELS: userModels,
        MODEL_ROUTER_STATE_DIR: testRoot,
        ORCAROUTER_API_KEY: "",
      },
    });
    assert.equal(result.status, 0, result.stderr);
    const stored = JSON.parse(readFileSync(userModels, "utf8"));
    assert.deepEqual(
      stored.models.map((model) => model.upstreamModel),
      [
        "vendor/existing-paid",
        "deepseek/deepseek-v4-flash-free",
        "vendor/unspecified-surface-free",
        "vendor/zero-token-price",
      ],
    );
    const flash = stored.models.find((model) => model.upstreamModel === "deepseek/deepseek-v4-flash-free");
    assert.equal(flash.contextWindow, 65_536);
    assert.equal(flash.autoCompact, 55_705);
    assert.equal(flash.isFree, true);
    assert.equal(flash.slug, "orca/deepseek-v4-flash");
    assert.equal(stored.models.find((model) => model.upstreamModel === "vendor/existing-paid").isFree, undefined);
    assert.equal(stored.models.some((model) => model.upstreamModel === "orcarouter/free"), false);

    const route = runNode([
      "-e",
      "const { MODELS } = await import('./src/model-registry.mjs');" +
        "const { renderLiteLlmConfig } = await import('./src/litellm-config.mjs');" +
        "const model = MODELS.find((entry) => entry.provider === 'orca' && entry.upstreamModel === 'deepseek/deepseek-v4-flash-free');" +
        "process.stdout.write(JSON.stringify({ model, config: renderLiteLlmConfig() }));",
    ], {
      ...isolatedEnvironment(testRoot),
      MODEL_ROUTER_USER_MODELS: userModels,
    });
    assert.equal(route.status, 0, route.stderr);
    const rendered = JSON.parse(route.stdout);
    assert.equal(rendered.model.slug, "orca/deepseek-v4-flash");
    assert.equal(rendered.model.gatewayModel, "orca-deepseek-v4-flash");
    assert.equal(rendered.model.upstreamModel, "deepseek/deepseek-v4-flash-free");
    assert.equal(rendered.model.isFree, true);
    const blockStart = rendered.config.indexOf(
      'model_name: "orca-deepseek-v4-flash"',
    );
    assert.ok(blockStart >= 0);
    const nextBlock = rendered.config.indexOf("model_name:", blockStart + 1);
    const block = rendered.config.slice(blockStart, nextBlock === -1 ? undefined : nextBlock);
    assert.match(block, /model: "openai\/orca-deepseek-v4-flash"/);
    assert.match(block, /api_base: "os\.environ\/CODEX_ROUTER_API_FORWARD_BASE_URL"/);
    assert.doesNotMatch(block, /ORCAROUTER_API_KEY/);

    const modelsPage = readFileSync(
      path.join(root, "apps", "control-center", "src", "pages", "ModelsPage.tsx"),
      "utf8",
    );
    assert.match(modelsPage, /model\.isFree \? <Badge tone="success">\{t\("models\.add\.free"\)\}<\/Badge>/);
    const branding = readFileSync(
      path.join(root, "apps", "control-center", "src", "provider-branding.tsx"),
      "utf8",
    );
    assert.match(branding, /\\bdeepseek\\b[\s\S]*return BRANDS\.deepseek/);
  } finally {
    rmSync(testRoot, { recursive: true, force: true });
  }
});
