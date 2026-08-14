import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { pickerCommandArgs } from "../src/control-args.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function probe(target, providers, usageEvents = [], options = {}) {
  const stateDir = mkdtempSync(path.join(os.tmpdir(), "control-probe-"));
  writeFileSync(
    path.join(stateDir, "enabled-providers.json"),
    `${JSON.stringify({ version: 1, providers })}\n`,
    { mode: 0o600 },
  );
  if (usageEvents.length) {
    writeFileSync(
      path.join(stateDir, "usage-events.jsonl"),
      `${usageEvents.map((event) => JSON.stringify(event)).join("\n")}\n`,
      { mode: 0o600 },
    );
  }
  if (options.nativeModels) {
    writeFileSync(
      path.join(stateDir, "native-models.json"),
      `${JSON.stringify({ models: options.nativeModels })}\n`,
      { mode: 0o600 },
    );
  }
  if (options.selectedModel) {
    writeFileSync(
      path.join(stateDir, "config.toml"),
      `model = ${JSON.stringify(options.selectedModel)}\n`,
      { mode: 0o600 },
    );
  }
  if (options.loginFree) {
    writeFileSync(
      path.join(stateDir, "config.toml"),
      `model = ${JSON.stringify(options.selectedModel || "deepseek/deepseek-v4-pro")}\nmodel_provider = "codex-router"\n`,
      { mode: 0o600 },
    );
    writeFileSync(
      path.join(stateDir, "codex-provider-mode.json"),
      `${JSON.stringify({
        version: 1,
        previousPresent: false,
        previousModelPresent: false,
      })}\n`,
      { mode: 0o600 },
    );
  }
  try {
    const output = execFileSync(process.execPath, [path.join(root, "src", "control.mjs"), "--probe"], {
      cwd: root,
      encoding: "utf8",
      env: {
        ...process.env,
        CODEX_HOME: stateDir,
        MODEL_ROUTER_TARGET: target,
        MODEL_ROUTER_STATE_DIR: stateDir,
        CODEX_ROUTER_TOOL_RESULT_AGING: "1",
      },
    });
    return JSON.parse(output);
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
}

test("codex probe reports enabled models", () => {
  const slice = probe("codex", ["deepseek"]);
  assert.equal(slice.target, "codex");
  const deepseek = slice.models.filter((m) => m.provider === "deepseek");
  assert.ok(deepseek.length > 0 && deepseek.every((m) => m.enabled));
});

test("codex probe folds protocol variants into one provider family", () => {
  const slice = probe("codex", ["opencode-go"]);
  // Models served by the messages/responses variants group under the family
  // id, so the tray renders a single opencode Go row.
  const family = slice.models.filter((m) => m.provider === "opencode-go");
  assert.ok(family.length > 0 && family.every((m) => m.enabled));
  assert.ok(!slice.models.some((m) => m.provider.startsWith("opencode-go-")));
  const providerIds = slice.providers.map((p) => p.id);
  assert.ok(providerIds.includes("opencode-go"));
  assert.ok(!providerIds.some((id) => id.startsWith("opencode-go-")));
});

test("codex probe folds Command Code protocol variants into one provider family", () => {
  const slice = probe("codex", ["commandcode"]);
  const family = slice.models.filter((m) => m.provider === "commandcode");
  assert.ok(family.length > 0 && family.every((m) => m.enabled));
  assert.ok(!slice.models.some((m) => m.provider.startsWith("commandcode-")));
  const providerIds = slice.providers.map((p) => p.id);
  assert.ok(providerIds.includes("commandcode"));
  assert.ok(!providerIds.some((id) => id.startsWith("commandcode-")));
});

test("codex probe exposes only privacy-safe recent usage events", () => {
  const event = {
    at: new Date().toISOString(),
    model: "grok-oauth/grok-4.5",
    provider: "grok-oauth",
    status: 200,
    durationMs: 1234,
    prompt: "must not escape the private event store",
  };
  const slice = probe("codex", ["grok-oauth"], [event]);
  assert.deepEqual(slice.usageEvents, [{
    at: event.at,
    model: event.model,
    provider: event.provider,
    status: event.status,
    durationMs: event.durationMs,
  }]);
  assert.equal("prompt" in slice.usageEvents[0], false);
  assert.equal("response" in slice.usageEvents[0], false);
});

test("codex probe includes native GPT models and the configured default", () => {
  const slice = probe("codex", ["grok-oauth"], [], {
    selectedModel: "gpt-5.6-terra",
    nativeModels: [
      {
        slug: "gpt-5.6-terra",
        display_name: "GPT-5.6-Terra",
        visibility: "list",
      },
      {
        slug: "codex-auto-review",
        display_name: "Codex Auto Review",
        visibility: "hide",
      },
    ],
  });

  assert.equal(slice.selectedModel, "gpt-5.6-terra");
  assert.deepEqual(
    slice.models.find((model) => model.slug === "gpt-5.6-terra"),
    {
      slug: "gpt-5.6-terra",
      displayName: "GPT-5.6-Terra",
      provider: "openai",
      gatewayModel: "gpt-5.6-terra",
      enabled: true,
      native: true,
      multiAgentVersion: "v1",
      visible: true,
    },
  );
  assert.equal(slice.models.some((model) => model.slug === "codex-auto-review"), false);
  assert.equal(slice.loginFree, false);
  assert.equal(slice.loginFreeManaged, false);
  assert.equal(slice.modelSettings.picker.hidden.length, 0);
  assert.ok(["all", "selected", "proven"].includes(slice.modelSettings.subagents.mode));
  // Compaction is opt-in, so an unconfigured probe reports it off.
  assert.equal(slice.modelSettings.toolResultAging.enabled, false);
});

test("codex probe exposes managed login-free mode without credential details", () => {
  const slice = probe("codex", ["deepseek"], [], { loginFree: true });
  assert.equal(slice.loginFree, true);
  assert.equal(slice.loginFreeManaged, true);
  assert.equal(JSON.stringify(slice).includes("previousModelProvider"), false);
});

test("control exposes subagent and picker settings without credentials", () => {
  const stateDir = mkdtempSync(path.join(os.tmpdir(), "control-settings-"));
  try {
    const env = {
      ...process.env,
      MODEL_ROUTER_TARGET: "codex",
      MODEL_ROUTER_STATE_DIR: stateDir,
    };
    const subagents = JSON.parse(
      execFileSync(
        process.execPath,
        [path.join(root, "src", "control.mjs"), "subagents", "status"],
        { cwd: root, encoding: "utf8", env },
      ),
    );
    assert.ok(["all", "selected", "proven"].includes(subagents.mode));
    assert.ok(Array.isArray(subagents.enabled));
    assert.ok(Array.isArray(subagents.disabled));

    const picker = JSON.parse(
      execFileSync(
        process.execPath,
        [path.join(root, "src", "control.mjs"), "picker", "status"],
        { cwd: root, encoding: "utf8", env },
      ),
    );
    assert.deepEqual(picker.hidden, []);
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("control toggles tool-result aging without a router restart", () => {
  const stateDir = mkdtempSync(path.join(os.tmpdir(), "control-tool-result-aging-"));
  const env = {
    ...process.env,
    MODEL_ROUTER_TARGET: "codex",
    MODEL_ROUTER_STATE_DIR: stateDir,
  };
  delete env.CODEX_ROUTER_TOOL_RESULT_AGING;
  const runControl = (action) =>
    JSON.parse(
      execFileSync(
        process.execPath,
        [path.join(root, "src", "control.mjs"), "tool-result-aging", action],
        { cwd: root, encoding: "utf8", env },
      ),
    );
  try {
    // Starts off, because compaction is opted into.
    assert.equal(runControl("status").enabled, false);
    assert.equal(runControl("on").enabled, true);
    assert.equal(runControl("status").enabled, true);
    assert.equal(runControl("off").enabled, false);
    assert.equal(runControl("status").enabled, false);
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("picker all accepts the documented show/hide flag position", () => {
  assert.deepEqual(pickerCommandArgs(["picker", "all", "show"]), [
    "all",
    undefined,
    "show",
  ]);
  assert.deepEqual(pickerCommandArgs(["picker", "all", "hide"]), [
    "all",
    undefined,
    "hide",
  ]);
  assert.deepEqual(
    pickerCommandArgs([
      "picker",
      "set",
      "deepseek/deepseek-v4-flash",
      "hide",
    ]),
    ["set", "deepseek/deepseek-v4-flash", "hide"],
  );
});

function probeSet(target, providers, provider, desired) {
  const stateDir = mkdtempSync(path.join(os.tmpdir(), "control-set-"));
  writeFileSync(
    path.join(stateDir, "enabled-providers.json"),
    `${JSON.stringify({ version: 1, providers })}\n`,
    { mode: 0o600 },
  );
  try {
    const output = execFileSync(
      process.execPath,
      [path.join(root, "src", "control.mjs"), "--probe-set", provider, desired],
      {
        cwd: root,
        encoding: "utf8",
        env: { ...process.env, MODEL_ROUTER_TARGET: target, MODEL_ROUTER_STATE_DIR: stateDir },
      },
    );
    return JSON.parse(output);
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
}

test("toggle on adds a provider; toggle off removes it", () => {
  const added = probeSet("codex", ["deepseek"], "grok-oauth", "on");
  assert.deepEqual(added.enabledProviders, ["deepseek", "grok-oauth"]);

  const removed = probeSet("codex", ["grok-oauth", "deepseek"], "deepseek", "off");
  assert.deepEqual(removed.enabledProviders, ["grok-oauth"]);
});

test("toggle rejects an unknown provider", () => {
  assert.throws(() => probeSet("codex", ["deepseek"], "not-a-provider", "on"));
});

test("login-free control selects a ready external model and restores Codex defaults", () => {
  const stateDir = mkdtempSync(path.join(os.tmpdir(), "control-login-free-"));
  writeFileSync(path.join(stateDir, "config.toml"), `model = "gpt-5.6-sol"\n`, {
    mode: 0o600,
  });
  writeFileSync(
    path.join(stateDir, "enabled-providers.json"),
    `${JSON.stringify({ version: 1, providers: ["deepseek"] })}\n`,
    { mode: 0o600 },
  );
  writeFileSync(path.join(stateDir, "deepseek-api-key.secret"), "test-provider-key\n", {
    mode: 0o600,
  });
  writeFileSync(
    path.join(stateDir, "caller-secret"),
    "test-control-caller-capability-with-sufficient-length\n",
    { mode: 0o600 },
  );
  writeFileSync(
    path.join(stateDir, "native-models.json"),
    `${JSON.stringify({
      models: [
        {
          slug: "gpt-5.6-sol",
          display_name: "GPT-5.6-Sol",
          visibility: "list",
          priority: 10,
        },
      ],
    })}\n`,
    { mode: 0o600 },
  );
  const runMode = (desired) =>
    JSON.parse(
      execFileSync(
        process.execPath,
        [path.join(root, "src", "control.mjs"), "auth-mode", desired],
        {
          cwd: root,
          encoding: "utf8",
          env: {
            ...process.env,
            CODEX_HOME: stateDir,
            CODEX_BIN: process.execPath,
            MODEL_ROUTER_TARGET: "codex",
            MODEL_ROUTER_STATE_DIR: stateDir,
          },
        },
      ),
    );

  try {
    const enabled = runMode("on");
    assert.equal(enabled.login_free, true);
    assert.equal(enabled.model, "gpt-5.6-sol");
    assert.equal(enabled.model_provider, "codex-router");
    const catalog = JSON.parse(readFileSync(path.join(stateDir, "merged-models.json"), "utf8"));
    const aliasEntry = catalog.models.find((model) => model.slug === "gpt-5.6-sol");
    assert.match(aliasEntry.display_name, /DeepSeek/);
    assert.equal(aliasEntry.visibility, "list");
    assert.deepEqual(
      catalog.models
        .filter((model) => model.slug.startsWith("deepseek/"))
        .map((model) => [model.slug, model.visibility]),
      [
        ["deepseek/deepseek-v4-flash", "hide"],
        ["deepseek/deepseek-v4-pro", "list"],
      ],
    );
    const aliases = JSON.parse(readFileSync(path.join(stateDir, "native-aliases.json"), "utf8"));
    assert.deepEqual(aliases, {
      version: 1,
      aliases: { "gpt-5.6-sol": "deepseek/deepseek-v4-flash" },
    });

    const disabled = runMode("off");
    assert.equal(disabled.login_free, false);
    assert.equal(disabled.model, "gpt-5.6-sol");
    assert.equal(disabled.model_provider, "openai");
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("login-free aliasing applies even when a ChatGPT credential is still stored", () => {
  const stateDir = mkdtempSync(path.join(os.tmpdir(), "control-login-free-auth-"));
  writeFileSync(path.join(stateDir, "config.toml"), `model = "gpt-5.6-sol"\n`, {
    mode: 0o600,
  });
  writeFileSync(
    path.join(stateDir, "enabled-providers.json"),
    `${JSON.stringify({ version: 1, providers: ["deepseek"] })}\n`,
    { mode: 0o600 },
  );
  writeFileSync(path.join(stateDir, "deepseek-api-key.secret"), "test-provider-key\n", {
    mode: 0o600,
  });
  writeFileSync(
    path.join(stateDir, "caller-secret"),
    "test-control-caller-capability-with-sufficient-length\n",
    { mode: 0o600 },
  );
  writeFileSync(
    path.join(stateDir, "native-models.json"),
    `${JSON.stringify({
      models: [
        { slug: "gpt-5.6-sol", display_name: "GPT-5.6-Sol", visibility: "list", priority: 10 },
      ],
    })}\n`,
    { mode: 0o600 },
  );
  try {
    const enabled = JSON.parse(
      execFileSync(
        process.execPath,
        [path.join(root, "src", "control.mjs"), "auth-mode", "on"],
        {
          cwd: root,
          encoding: "utf8",
          env: {
            ...process.env,
            CODEX_HOME: stateDir,
            // A real Codex install must not leak into this test on Windows,
            // where /usr/bin/true does not exist. Node is runnable everywhere
            // and produces no Codex catalog, so the seeded fixture is reused.
            CODEX_BIN: process.execPath,
            MODEL_ROUTER_TARGET: "codex",
            MODEL_ROUTER_STATE_DIR: stateDir,
          },
        },
      ),
    );
    assert.equal(enabled.login_free, true);
    assert.equal(enabled.model, "gpt-5.6-sol");
    const aliases = JSON.parse(readFileSync(path.join(stateDir, "native-aliases.json"), "utf8"));
    assert.deepEqual(aliases.aliases, { "gpt-5.6-sol": "deepseek/deepseek-v4-flash" });
    const catalog = JSON.parse(readFileSync(path.join(stateDir, "merged-models.json"), "utf8"));
    assert.match(
      catalog.models.find((model) => model.slug === "gpt-5.6-sol").display_name,
      /DeepSeek/,
    );
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("model-set switches the login-free model and rejects unavailable models", () => {
  const stateDir = mkdtempSync(path.join(os.tmpdir(), "control-model-set-"));
  writeFileSync(path.join(stateDir, "config.toml"), `model = "gpt-5.6-sol"\n`, {
    mode: 0o600,
  });
  writeFileSync(
    path.join(stateDir, "enabled-providers.json"),
    `${JSON.stringify({ version: 1, providers: ["deepseek", "kimi-api"] })}\n`,
    { mode: 0o600 },
  );
  writeFileSync(path.join(stateDir, "deepseek-api-key.secret"), "test-provider-key\n", {
    mode: 0o600,
  });
  writeFileSync(
    path.join(stateDir, "caller-secret"),
    "test-control-caller-capability-with-sufficient-length\n",
    { mode: 0o600 },
  );
  writeFileSync(
    path.join(stateDir, "native-models.json"),
    `${JSON.stringify({
      models: [
        {
          slug: "gpt-5.6-sol",
          display_name: "GPT-5.6-Sol",
          visibility: "list",
          priority: 10,
        },
      ],
    })}\n`,
    { mode: 0o600 },
  );
  const environment = {
    ...process.env,
    CODEX_HOME: stateDir,
    CODEX_BIN: process.execPath,
    KIMI_CODE_HOME: path.join(stateDir, "kimi-code"),
    MODEL_ROUTER_TARGET: "codex",
    MODEL_ROUTER_STATE_DIR: stateDir,
  };
  delete environment.KIMI_API_KEY;
  delete environment.MOONSHOT_API_KEY;
  const runControl = (...commandArgs) =>
    JSON.parse(
      execFileSync(
        process.execPath,
        [path.join(root, "src", "control.mjs"), ...commandArgs],
        { cwd: root, encoding: "utf8", env: environment },
      ),
    );

  try {
    assert.throws(
      () => runControl("model-set", "deepseek/deepseek-v4-flash"),
      /login-free/,
      "model-set must require login-free mode",
    );

    runControl("auth-mode", "on");
    const switched = runControl("model-set", "deepseek/deepseek-v4-flash");
    assert.equal(switched.model, "gpt-5.6-sol");
    assert.equal(switched.model_provider, "codex-router");
    assert.equal(switched.login_free, true);

    const overflow = runControl("model-set", "deepseek/deepseek-v4-pro");
    assert.equal(overflow.model, "deepseek/deepseek-v4-pro");

    assert.throws(
      () => runControl("model-set", "kimi-api/kimi-k3"),
      /enabled, authenticated/,
      "model-set must reject models from unauthenticated providers",
    );
    assert.throws(
      () => runControl("model-set", "gpt-5.6-sol"),
      /enabled, authenticated/,
      "model-set must reject native models",
    );
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("signed routing rolls back catalog and config after a forced post-publication failure", () => {
  const stateDir = mkdtempSync(path.join(os.tmpdir(), "control-signed-rollback-"));
  const configPath = path.join(stateDir, "config.toml");
  const originalCatalog = {
    models: [
      {
        slug: "gpt-5.6-sol",
        display_name: "GPT-5.6-Sol",
        visibility: "list",
        priority: 10,
      },
    ],
  };
  const staleMergedCatalog = {
    models: [
      ...originalCatalog.models,
      {
        slug: "deepseek/deepseek-v4-flash",
        display_name: "DeepSeek V4 Flash",
        visibility: "list",
        priority: 6,
      },
    ],
  };
  writeFileSync(
    configPath,
    `model_provider = "custom"

[model_providers.custom]
name = "CC Switch"
base_url = "https://direct.invalid/v1"

[model_providers.custom.query_params]
api_key = "ROLLBACK_QUERY_SECRET"
`,
    { mode: 0o600 },
  );
  writeFileSync(
    path.join(stateDir, "enabled-providers.json"),
    `${JSON.stringify({ version: 1, providers: ["deepseek"] })}\n`,
    { mode: 0o600 },
  );
  writeFileSync(path.join(stateDir, "deepseek-api-key.secret"), "test-provider-key\n", {
    mode: 0o600,
  });
  writeFileSync(
    path.join(stateDir, "caller-secret"),
    "test-control-caller-capability-with-sufficient-length\n",
    { mode: 0o600 },
  );
  writeFileSync(
    path.join(stateDir, "native-models.json"),
    `${JSON.stringify(originalCatalog)}\n`,
    { mode: 0o600 },
  );
  writeFileSync(
    path.join(stateDir, "merged-models.json"),
    `${JSON.stringify(staleMergedCatalog, null, 2)}\n`,
    { mode: 0o600 },
  );
  const environment = {
    ...process.env,
    CODEX_HOME: stateDir,
    CODEX_BIN: process.execPath,
    MODEL_ROUTER_TARGET: "codex",
    MODEL_ROUTER_STATE_DIR: stateDir,
    MODEL_ROUTER_TEST_FAIL_AFTER_CATALOG_WRITE: "1",
  };
  try {
    assert.throws(
      () =>
        execFileSync(
          process.execPath,
          [path.join(root, "src", "control.mjs"), "signed-routing", "on"],
          { cwd: root, encoding: "utf8", env: environment, stdio: "pipe" },
        ),
      /catalog|publication/i,
    );
    const restoredConfig = readFileSync(configPath, "utf8");
    assert.match(restoredConfig, /^model_provider = "custom"$/m);
    assert.match(restoredConfig, /base_url = "https:\/\/direct\.invalid\/v1"/);
    assert.match(restoredConfig, /api_key = "ROLLBACK_QUERY_SECRET"/);
    assert.doesNotMatch(restoredConfig, /codex-router-signed-provider-managed/);
    const safeCatalog = JSON.parse(
      readFileSync(path.join(stateDir, "merged-models.json"), "utf8"),
    );
    assert.equal(
      safeCatalog.models.some((model) => model.slug === "deepseek/deepseek-v4-flash"),
      false,
    );
    assert.equal(
      existsSync(path.join(stateDir, "signed-provider-mode.json")),
      false,
    );
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

// The state directory is pinned per case on purpose: this assertion used to
// read the developer's own installation, so publishing to DeepSeek Harness on
// the machine running the tests changed the expected target list.
function overviewTargets(stateDir) {
  const output = execFileSync(process.execPath, [path.join(root, "src", "control.mjs"), "--json"], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, MODEL_ROUTER_STATE_DIR: stateDir },
  });
  return Object.keys(JSON.parse(output).targets).sort();
}

test("aggregate overview covers every target", () => {
  const stateDir = mkdtempSync(path.join(os.tmpdir(), "control-targets-"));
  try {
    assert.deepEqual(overviewTargets(stateDir), ["codex"]);
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("the harness target appears only once its route has been published", () => {
  const stateDir = mkdtempSync(path.join(os.tmpdir(), "control-targets-dsh-"));
  try {
    writeFileSync(
      path.join(stateDir, "dsh-models.json"),
      `${JSON.stringify({ version: 1, route: "codex-router", models: [] })}\n`,
      { mode: 0o600 },
    );
    assert.deepEqual(overviewTargets(stateDir), ["codex", "dsh"]);
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});
