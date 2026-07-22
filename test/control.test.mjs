import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

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
      },
    });
    return JSON.parse(output);
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
}

test("cursor probe reports enabled models", () => {
  const slice = probe("cursor", ["deepseek"]);
  assert.equal(slice.target, "cursor");
  const deepseek = slice.models.filter((m) => m.provider === "deepseek");
  assert.ok(deepseek.length > 0 && deepseek.every((m) => m.enabled));
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
    },
  );
  assert.equal(slice.models.some((model) => model.slug === "codex-auto-review"), false);
  assert.equal(slice.loginFree, false);
  assert.equal(slice.loginFreeManaged, false);
});

test("codex probe exposes managed login-free mode without credential details", () => {
  const slice = probe("codex", ["deepseek"], [], { loginFree: true });
  assert.equal(slice.loginFree, true);
  assert.equal(slice.loginFreeManaged, true);
  assert.equal(JSON.stringify(slice).includes("previousModelProvider"), false);
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
  const added = probeSet("cursor", ["deepseek"], "grok-oauth", "on");
  assert.deepEqual(added.enabledProviders, ["deepseek", "grok-oauth"]);

  const removed = probeSet("cursor", ["grok-oauth", "deepseek"], "deepseek", "off");
  assert.deepEqual(removed.enabledProviders, ["grok-oauth"]);
});

test("toggle rejects an unknown provider", () => {
  assert.throws(() => probeSet("cursor", ["deepseek"], "not-a-provider", "on"));
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
            MODEL_ROUTER_TARGET: "codex",
            MODEL_ROUTER_STATE_DIR: stateDir,
          },
        },
      ),
    );

  try {
    const enabled = runMode("on");
    assert.equal(enabled.login_free, true);
    assert.match(enabled.model, /^deepseek\//);
    assert.equal(enabled.model_provider, "codex-router");
    const catalog = JSON.parse(readFileSync(path.join(stateDir, "merged-models.json"), "utf8"));
    assert.deepEqual(
      catalog.models.filter((model) => model.slug.startsWith("deepseek/")).map((model) => model.slug),
      ["deepseek/deepseek-v4-flash", "deepseek/deepseek-v4-pro"],
    );

    const disabled = runMode("off");
    assert.equal(disabled.login_free, false);
    assert.equal(disabled.model, "gpt-5.6-sol");
    assert.equal(disabled.model_provider, "openai");
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("aggregate overview covers every target", () => {
  const output = execFileSync(process.execPath, [path.join(root, "src", "control.mjs"), "--json"], {
    cwd: root,
    encoding: "utf8",
  });
  const overview = JSON.parse(output);
  assert.deepEqual(Object.keys(overview.targets).sort(), ["codex", "cursor"]);
});
