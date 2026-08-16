import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function isolatedEnvironment(testRoot, extra = {}) {
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
    COMMANDCODE_CLI_HOME: path.join(testRoot, "commandcode"),
    CHUTES_API_KEY: "",
    CHUTES_API_BASE_URL: "",
    ...extra,
  };
}

function runNode(args, env) {
  return spawnSync(process.execPath, args, {
    cwd: root,
    env,
    encoding: "utf8",
  });
}

function writeChutesCredential(testRoot, value = "TEST_CHUTES_PERSISTENT_KEY") {
  const stateDir = path.join(testRoot, "state");
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  writeFileSync(path.join(stateDir, "chutes-api-key.secret"), `${value}\n`, { mode: 0o600 });
}

test("the macOS tray labels Chutes as a metered API route", () => {
  const overlay = readFileSync(
    path.join(root, "apps", "macos", "ModelRouterTray", "Sources", "IslandOverlay.swift"),
    "utf8",
  );
  const sourceLabel = overlay.slice(
    overlay.indexOf("private var sourceLabel: String"),
    overlay.indexOf("private var compactUsageSummary: String"),
  );
  assert.match(
    sourceLabel,
    /\["deepseek", "chutes"\]\.contains\(provider\)[\s\S]*return "METERED API"/,
  );
});

test("both installer frontends pass provider selection to setup, which accepts Chutes", () => {
  const testRoot = mkdtempSync(path.join(os.tmpdir(), "chutes-installer-test-"));
  try {
    const posix = readFileSync(path.join(root, "install.sh"), "utf8");
    const windows = readFileSync(path.join(root, "install.ps1"), "utf8");
    assert.match(posix, /--providers "\$providers"/);
    assert.match(windows, /\$SetupArguments \+= @\("--providers", \$Providers\)/);

    writeChutesCredential(testRoot, "TEST_CHUTES_INSTALL_KEY");
    const env = isolatedEnvironment(testRoot);
    const result = runNode(
      ["src/setup.mjs", "--providers", "chutes", "--selection-only"],
      env,
    );
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout).providers, ["chutes"]);
    const selection = JSON.parse(
      readFileSync(path.join(testRoot, "state", "enabled-providers.json"), "utf8"),
    );
    assert.deepEqual(selection.providers, ["chutes"]);
  } finally {
    rmSync(testRoot, { recursive: true, force: true });
  }
});

test("providers enable accepts a configured Chutes key and points catalog-only users at curation", () => {
  const testRoot = mkdtempSync(path.join(os.tmpdir(), "chutes-enable-test-"));
  try {
    writeChutesCredential(testRoot);
    writeFileSync(
      path.join(testRoot, "state", "enabled-providers.json"),
      `${JSON.stringify({ version: 1, providers: [] })}\n`,
      { mode: 0o600 },
    );
    const result = runNode(
      ["src/providers.mjs", "enable", "chutes"],
      isolatedEnvironment(testRoot),
    );
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Chutes is enabled, but ships no preselected models/);
    assert.match(result.stdout, /curate-models chutes/);
    const selection = JSON.parse(
      readFileSync(path.join(testRoot, "state", "enabled-providers.json"), "utf8"),
    );
    assert.deepEqual(selection.providers, ["chutes"]);
  } finally {
    rmSync(testRoot, { recursive: true, force: true });
  }
});

test("doctor recognizes a persistent Chutes key and warns when no models are curated", () => {
  const testRoot = mkdtempSync(path.join(os.tmpdir(), "chutes-doctor-test-"));
  try {
    writeChutesCredential(testRoot);
    writeFileSync(
      path.join(testRoot, "state", "enabled-providers.json"),
      `${JSON.stringify({ version: 1, providers: ["chutes"] })}\n`,
      { mode: 0o600 },
    );
    const result = runNode(["src/doctor.mjs", "--json"], isolatedEnvironment(testRoot));
    const report = JSON.parse(result.stdout);
    const byName = Object.fromEntries(report.checks.map((check) => [check.name, check]));
    assert.equal(byName["Chutes key"].status, "ok");
    assert.match(byName["Chutes key"].detail, /protected file/);
    assert.equal(byName["Chutes models"].status, "warn");
    assert.match(byName["Chutes models"].fix, /curate-models chutes/);
  } finally {
    rmSync(testRoot, { recursive: true, force: true });
  }
});

test("Chutes public-catalog fixtures drive discovery, deterministic curation, and a LiteLLM route", () => {
  const testRoot = mkdtempSync(path.join(os.tmpdir(), "chutes-curation-test-"));
  try {
    const fixture = path.join(testRoot, "models.json");
    writeFileSync(fixture, JSON.stringify({
      data: [
        { id: "moonshotai/Kimi-K3-TEE", object: "model", context_length: 262144 },
        // A record the catalog sizes in silence: curation falls back rather
        // than inventing a window for it.
        { id: "zai-org/GLM-5.2-TEE", object: "model" },
      ],
    }));
    const env = isolatedEnvironment(testRoot);
    const discovery = runNode(
      ["src/model-discovery.mjs", "chutes", "--fixture", fixture, "--json"],
      env,
    );
    assert.equal(discovery.status, 0, discovery.stderr);
    assert.deepEqual(JSON.parse(discovery.stdout), {
      provider: "chutes",
      discovered: ["moonshotai/Kimi-K3-TEE", "zai-org/GLM-5.2-TEE"],
      registered: [],
      unregistered: ["moonshotai/Kimi-K3-TEE", "zai-org/GLM-5.2-TEE"],
      unavailable: [],
      contextLengths: { "moonshotai/Kimi-K3-TEE": 262144 },
      note: "Discovery never edits the registry. New models must pass the live compatibility test before they are listed in Codex.",
    });

    const curation = runNode([
      "src/curate-models.mjs",
      "chutes",
      "--fixture",
      fixture,
      "--models",
      "moonshotai/Kimi-K3-TEE",
      "--efforts",
      "high",
      "--no-apply",
    ], env);
    assert.equal(curation.status, 0, curation.stderr);
    const stored = JSON.parse(readFileSync(env.MODEL_ROUTER_USER_MODELS, "utf8"));
    assert.equal(stored.models.length, 1);
    assert.equal(stored.models[0].provider, "chutes");
    assert.equal(stored.models[0].upstreamModel, "moonshotai/Kimi-K3-TEE");
    assert.equal(stored.models[0].requestProfile, undefined);
    // The catalog said how big this model is, so curation stores that rather
    // than the conservative 131072 guess -- and the compaction threshold
    // Codex reads follows from it (#266).
    assert.equal(stored.models[0].contextWindow, 262144);
    assert.equal(stored.models[0].autoCompact, 222822);
    assert.deepEqual(
      stored.models[0].reasoningLevels.map((level) => level.effort),
      ["high"],
    );

    const route = runNode([
      "-e",
      "const { MODELS } = await import('./src/model-registry.mjs');" +
        "const { renderLiteLlmConfig } = await import('./src/litellm-config.mjs');" +
        "const model = MODELS.find((entry) => entry.provider === 'chutes');" +
        "process.stdout.write(JSON.stringify({ model, config: renderLiteLlmConfig() }));",
    ], env);
    assert.equal(route.status, 0, route.stderr);
    const rendered = JSON.parse(route.stdout);
    assert.equal(rendered.model.gatewayModel, "chutes-moonshotai-kimi-k3-tee");
    assert.equal(rendered.model.requestProfile, undefined);
    const blockStart = rendered.config.indexOf(
      'model_name: "chutes-moonshotai-kimi-k3-tee"',
    );
    assert.ok(blockStart >= 0);
    const nextBlock = rendered.config.indexOf("model_name:", blockStart + 1);
    const block = rendered.config.slice(blockStart, nextBlock === -1 ? undefined : nextBlock);
    assert.match(block, /model: "openai\/chutes-moonshotai-kimi-k3-tee"/);
    assert.match(block, /api_base: "os\.environ\/CODEX_ROUTER_API_FORWARD_BASE_URL"/);
    assert.match(block, /use_chat_completions_api: true/);
    assert.doesNotMatch(block, /CHUTES_API_KEY/);
  } finally {
    rmSync(testRoot, { recursive: true, force: true });
  }
});
