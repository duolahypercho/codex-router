import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { pickerCommandArgs } from "../src/control-args.mjs";
import { writePrivateJson } from "../src/file-security.mjs";
import { userModelEntry } from "../src/user-models.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function writeSignedOutCodexStub(directory) {
  const windows = process.platform === "win32";
  const target = path.join(directory, windows ? "codex-signed-out.cmd" : "codex-signed-out");
  const catalog = JSON.stringify({
    models: [{
      slug: "gpt-5.6-sol",
      display_name: "GPT-5.6-Sol",
      visibility: "list",
      priority: 10,
    }],
  });
  writeFileSync(
    target,
    windows
      ? `@echo off\r\n@if "%~1"=="debug" (\r\n  @echo ${catalog}\r\n  @exit /b 0\r\n)\r\n@echo Not logged in 1>&2\r\n@exit /b 1\r\n`
      : `#!/bin/sh\nif [ "$1" = "debug" ]; then\n  printf '%s\\n' '${catalog}'\n  exit 0\nfi\necho 'Not logged in' >&2\nexit 1\n`,
    { mode: 0o755 },
  );
  if (!windows) chmodSync(target, 0o755);
  return target;
}

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
  if (options.subagentSettings) {
    writeFileSync(
      path.join(stateDir, "multi-agent-settings.json"),
      `${JSON.stringify({ version: 2, ...options.subagentSettings })}\n`,
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
  if (options.hiddenModels) {
    writeFileSync(
      path.join(stateDir, "model-picker.json"),
      `${JSON.stringify({
        version: 1,
        hidden: options.hiddenModels,
        seeded: options.hiddenModels,
      })}\n`,
      { mode: 0o600 },
    );
  }
  if (options.userModels) {
    writeFileSync(
      path.join(stateDir, "user-models.json"),
      `${JSON.stringify({ version: 1, models: options.userModels })}\n`,
      { mode: 0o600 },
    );
  }
  if (options.loginFree) {
    const loginFreeProvider = options.loginFreeProvider || "custom";
    const ownershipId = "00000000000000000000000000000000";
    writeFileSync(
      path.join(stateDir, "config.toml"),
      `model = ${JSON.stringify(options.selectedModel || "deepseek/deepseek-v4-pro")}\nmodel_provider = ${JSON.stringify(loginFreeProvider)}\n\n# codex-router-signed-provider-tree-slot ${ownershipId} 0\n# BEGIN codex-router-signed-provider-managed\n[model_providers.${loginFreeProvider}]\nname = "Codex Router (external models)"\nbase_url = "http://127.0.0.1:4202/v1"\nwire_api = "responses"\nrequires_openai_auth = false\nsupports_standalone_web_search = true\nsupports_websockets = false\n# END codex-router-signed-provider-managed\n`,
      { mode: 0o600 },
    );
    writePrivateJson(
      path.join(stateDir, "codex-provider-mode.json"),
      {
        version: 3,
        mode: "provider-table",
        managedProvider: loginFreeProvider,
        managedBaseUrl: "http://127.0.0.1:4202/v1",
        ownershipId,
        previousProviderSections: [],
        previousModelPresent: false,
        loginFree: true,
      },
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

test("desktop snapshots expose the canonical Ox Alpha route instead of its opaque OpenCode id", () => {
  const stored = {
    ...userModelEntry({
      providerId: "opencode-free",
      upstreamId: "x-preview-f-free",
      priority: 100,
      metadata: { isFree: true },
    }),
    // Simulate curation written by an older router. Registry normalization
    // updates presentation without changing the routing identity.
    displayName: "x-preview-f-free (curated)",
  };
  const slice = probe("codex", ["opencode-free"], [], { userModels: [stored] });
  const model = slice.models.find((entry) => entry.slug === "opencode-free/ox-alpha");
  assert.equal(model.displayName, "Ox Alpha (OpenCode Free)");
  assert.equal(model.slug, "opencode-free/ox-alpha");
  assert.equal(model.provider, "opencode-free");
  assert.equal(model.enabled, true);
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
      subagentCertification: "unknown",
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
  // The panel's periodic refresh reads this snapshot, not `local-models
  // list`, so the LM Studio section has to ride here or it paints once and
  // vanishes on the next poll.
  assert.equal(slice.modelSettings.localModels.lmstudio.provider, "lmstudio");
  assert.equal(typeof slice.modelSettings.localModels.lmstudio.reachable, "boolean");
  assert.ok(Array.isArray(slice.modelSettings.localModels.lmstudio.models));
});

test("codex probe preserves an explicit repository v1 verdict", () => {
  const slice = probe("codex", [], [], {
    nativeModels: [
      {
        slug: "gpt-reviewed-v1",
        display_name: "GPT Reviewed V1",
        visibility: "list",
        multi_agent_version: "v1",
      },
    ],
  });
  const model = slice.models.find((entry) => entry.slug === "gpt-reviewed-v1");
  assert.equal(model.multiAgentVersion, "v1");
  assert.equal(model.subagentCertification, "v1");
});

// The row is the whole feature: an entry the operator cannot find is an entry
// that ships off forever. It belongs in the OpenAI group, drawn unchecked.
test("codex probe draws the extended-context variant under OpenAI, switched off", () => {
  const slice = probe("codex", [], [], {
    hiddenModels: ["gpt-5.6-sol-1m"],
    nativeModels: [
      { slug: "gpt-5.6-sol", display_name: "GPT-5.6-Sol", visibility: "list" },
    ],
  });

  const variant = slice.models.find((model) => model.slug === "gpt-5.6-sol-1m");
  assert.equal(variant.provider, "openai");
  assert.equal(variant.native, true);
  assert.equal(variant.visible, false);
  assert.equal(variant.displayName, "GPT-5.6-Sol (1M context)");
  // And it has not displaced the model it was derived from.
  assert.equal(slice.models.find((model) => model.slug === "gpt-5.6-sol").visible, true);
});

test("a login-free probe draws no extended-context variant", () => {
  const slice = probe("codex", ["deepseek"], [], {
    loginFree: true,
    nativeModels: [
      { slug: "gpt-5.6-sol", display_name: "GPT-5.6-Sol", visibility: "list" },
    ],
  });

  assert.equal(slice.loginFree, true);
  // Signed-out Codex only displays allowlisted native slugs, so the row would
  // offer a model the picker can never show.
  assert.equal(slice.models.some((model) => model.slug === "gpt-5.6-sol-1m"), false);
  assert.ok(slice.models.some((model) => model.slug === "gpt-5.6-sol"));
});

test("codex probe does not turn a selected native v1 model into v2", () => {
  const slice = probe("codex", [], [], {
    nativeModels: [
      {
        slug: "gpt-5.6-terra",
        display_name: "GPT-5.6-Terra",
        visibility: "list",
        multi_agent_version: "v1",
      },
      {
        slug: "gpt-5.6-luna",
        display_name: "GPT-5.6-Luna",
        visibility: "list",
        multi_agent_version: "v1",
      },
    ],
    subagentSettings: {
      mode: "selected",
      enabled: ["gpt-5.6-terra"],
      disabled: [],
    },
  });

  assert.equal(
    slice.models.find((model) => model.slug === "gpt-5.6-terra")?.multiAgentVersion,
    "v1",
  );
  assert.equal(
    slice.models.find((model) => model.slug === "gpt-5.6-luna")?.multiAgentVersion,
    "v2",
  );
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
      // Without this the command republishes into the operator's real
      // ~/.codex/agents and clears every routed subagent definition there.
      CODEX_HOME: stateDir,
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

test("control refuses to enable a repository-certified v1 model as a v2 subagent", () => {
  const stateDir = mkdtempSync(path.join(os.tmpdir(), "control-subagent-v1-"));
  const env = {
    ...process.env,
    // Without this the command republishes into the operator's real
    // ~/.codex/agents and clears every routed subagent definition there.
    CODEX_HOME: stateDir,
    MODEL_ROUTER_TARGET: "codex",
    MODEL_ROUTER_STATE_DIR: stateDir,
  };
  writeFileSync(
    path.join(stateDir, "merged-models.json"),
    `${JSON.stringify({ models: [{ slug: "gpt-reviewed-v1", multi_agent_version: "v1" }] })}\n`,
    { mode: 0o600 },
  );
  try {
    assert.throws(
      () => execFileSync(
        process.execPath,
        [path.join(root, "src", "control.mjs"), "subagents", "set", "gpt-reviewed-v1", "on"],
        { cwd: root, encoding: "utf8", env, stdio: "pipe" },
      ),
      /repository-certified v1/,
    );
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("a disabled repository-certified native v2 model can be turned back on", () => {
  const stateDir = mkdtempSync(path.join(os.tmpdir(), "control-subagent-native-v2-"));
  const slug = "gpt-5.6-luna";
  const env = {
    ...process.env,
    CODEX_HOME: stateDir,
    MODEL_ROUTER_TARGET: "codex",
    MODEL_ROUTER_STATE_DIR: stateDir,
  };
  writeFileSync(
    path.join(stateDir, "native-models.json"),
    `${JSON.stringify({ models: [{
      slug,
      display_name: "GPT-5.6-Luna",
      visibility: "list",
      multi_agent_version: "v1",
    }] })}\n`,
    { mode: 0o600 },
  );
  writeFileSync(
    path.join(stateDir, "merged-models.json"),
    `${JSON.stringify({ models: [{ slug, multi_agent_version: "v1" }] })}\n`,
    { mode: 0o600 },
  );
  writeFileSync(
    path.join(stateDir, "multi-agent-settings.json"),
    `${JSON.stringify({ version: 2, mode: "selected", enabled: [], disabled: [slug] })}\n`,
    { mode: 0o600 },
  );
  try {
    const snapshot = probe("codex", [], [], {
      nativeModels: [{
        slug,
        display_name: "GPT-5.6-Luna",
        visibility: "list",
        multi_agent_version: "v1",
      }],
      subagentSettings: { mode: "selected", enabled: [], disabled: [slug] },
    });
    const row = snapshot.models.find((model) => model.slug === slug);
    assert.equal(row.multiAgentVersion, "v1");
    assert.equal(row.subagentCertification, "v2");

    const state = JSON.parse(execFileSync(
      process.execPath,
      [path.join(root, "src", "control.mjs"), "subagents", "set", slug, "on"],
      { cwd: root, encoding: "utf8", env, stdio: "pipe" },
    ));
    assert.deepEqual(state.disabled, []);
    assert.deepEqual(state.enabled, [slug]);
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("an unknown native route is not mistaken for the merged catalog's conservative v1", () => {
  const stateDir = mkdtempSync(path.join(os.tmpdir(), "control-subagent-native-unknown-"));
  const slug = "gpt-native-candidate";
  const env = {
    ...process.env,
    CODEX_HOME: stateDir,
    MODEL_ROUTER_TARGET: "codex",
    MODEL_ROUTER_STATE_DIR: stateDir,
  };
  writeFileSync(
    path.join(stateDir, "native-models.json"),
    `${JSON.stringify({ models: [{ slug, visibility: "list" }] })}\n`,
    { mode: 0o600 },
  );
  writeFileSync(
    path.join(stateDir, "merged-models.json"),
    `${JSON.stringify({ models: [{ slug, multi_agent_version: "v1" }] })}\n`,
    { mode: 0o600 },
  );
  try {
    const state = JSON.parse(execFileSync(
      process.execPath,
      [path.join(root, "src", "control.mjs"), "subagents", "set", slug, "on"],
      { cwd: root, encoding: "utf8", env, stdio: "pipe" },
    ));
    assert.deepEqual(state.enabled, [slug]);
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("control can test an uncertified route despite its conservative merged-catalog v1", () => {
  const stateDir = mkdtempSync(path.join(os.tmpdir(), "control-subagent-unknown-"));
  const slug = "deepseek/deepseek-v4-flash";
  const env = {
    ...process.env,
    // Without this the command republishes into the operator's real
    // ~/.codex/agents and clears every routed subagent definition there.
    CODEX_HOME: stateDir,
    MODEL_ROUTER_TARGET: "codex",
    MODEL_ROUTER_STATE_DIR: stateDir,
  };
  writeFileSync(
    path.join(stateDir, "merged-models.json"),
    `${JSON.stringify({ models: [{ slug, multi_agent_version: "v1" }] })}\n`,
    { mode: 0o600 },
  );
  // A settled candidate prevents this command-level regression test from
  // launching the detached, quota-spending probe worker.
  writeFileSync(
    path.join(stateDir, "multi-agent-proofs.json"),
    `${JSON.stringify({ version: 1, proofs: { [slug]: { status: "candidate" } } })}\n`,
    { mode: 0o600 },
  );
  try {
    const state = JSON.parse(execFileSync(
      process.execPath,
      [path.join(root, "src", "control.mjs"), "subagents", "set", slug, "on"],
      { cwd: root, encoding: "utf8", env, stdio: "pipe" },
    ));
    assert.equal(state.mode, "selected");
    assert.deepEqual(state.enabled, [slug]);
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("control toggles tool-result aging without a router restart", () => {
  const stateDir = mkdtempSync(path.join(os.tmpdir(), "control-tool-result-aging-"));
  const env = {
    ...process.env,
    // Without this the command republishes into the operator's real
    // ~/.codex/agents and clears every routed subagent definition there.
    CODEX_HOME: stateDir,
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

test("set-apply keeps provider mutation, publication, and rollback in one transaction", () => {
  const source = readFileSync(path.join(root, "src", "control.mjs"), "utf8");
  const atomic = source.match(
    /async function runSetApply[\s\S]*?\r?\n}\r?\n\r?\nasync function printAccountUsage/,
  )?.[0];
  assert.ok(atomic, "atomic set/apply helper should be readable");
  assert.match(atomic, /transactModelOverlayMutation\(\{/);
  assert.match(atomic, /files: \[PROVIDER_SELECTION_PATH\]/);
  assert.match(atomic, /mutate: \(\) => setProviderSelectionForTargets/);
  assert.match(atomic, /applyProviderSelectionForTargets\(TARGETS, \{ activate \}\)/);
  assert.match(atomic, /const activate = args\.includes\("--activate"\)/);
  assert.match(source, /args\[0\] === "set-apply"[\s\S]{0,260}runSetApply\(args\[1\], args\[2\]\)/);
});

test("login-free control selects a ready external model and restores Codex defaults", () => {
  const stateDir = mkdtempSync(path.join(os.tmpdir(), "control-login-free-"));
  const signedOutCodex = writeSignedOutCodexStub(stateDir);
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
            CODEX_BIN: signedOutCodex,
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
    const providerModePath = path.join(stateDir, "codex-provider-mode.json");
    const providerMode = JSON.parse(readFileSync(providerModePath, "utf8"));
    assert.equal(providerMode.version, 1);
    assert.equal(providerMode.previousPresent, false);
    assert.equal(providerMode.previousModelPresent, true);
    assert.equal(providerMode.previousModel, "gpt-5.6-sol");
    const loginFreeConfig = readFileSync(path.join(stateDir, "config.toml"), "utf8");
    assert.match(loginFreeConfig, /^model_provider = "codex-router"$/m);
    assert.match(loginFreeConfig, /\[model_providers\.codex-router\]/);
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
        ["deepseek/deepseek-v4-flash-vision-exp", "list"],
        ["deepseek/deepseek-v4-pro", "list"],
      ],
    );
    const aliases = JSON.parse(readFileSync(path.join(stateDir, "native-aliases.json"), "utf8"));
    assert.deepEqual(aliases, {
      version: 1,
      aliases: { "gpt-5.6-sol": "deepseek/deepseek-v4-flash" },
    });

    // A later catalog rebuild has no mode-toggle override. It must recover
    // login-free mode remains discoverable from the ownership-validated
    // fallback state even though the Codex stub reports no ChatGPT session.
    execFileSync(process.execPath, [path.join(root, "src", "catalog.mjs")], {
      cwd: root,
      encoding: "utf8",
      env: {
        ...process.env,
        CODEX_HOME: stateDir,
        CODEX_BIN: signedOutCodex,
        MODEL_ROUTER_TARGET: "codex",
        MODEL_ROUTER_STATE_DIR: stateDir,
      },
    });
    assert.deepEqual(
      JSON.parse(readFileSync(path.join(stateDir, "native-aliases.json"), "utf8")),
      aliases,
    );

    execFileSync(process.execPath, [path.join(root, "src", "refresh-catalog.mjs")], {
      cwd: root,
      encoding: "utf8",
      env: {
        ...process.env,
        CODEX_HOME: stateDir,
        CODEX_BIN: signedOutCodex,
        MODEL_ROUTER_TARGET: "codex",
        MODEL_ROUTER_STATE_DIR: stateDir,
      },
    });
    const afterRefresh = JSON.parse(
      execFileSync(process.execPath, [path.join(root, "src", "config-manager.mjs"), "status"], {
        cwd: root,
        encoding: "utf8",
        env: {
          ...process.env,
          CODEX_HOME: stateDir,
          CODEX_BIN: signedOutCodex,
          MODEL_ROUTER_TARGET: "codex",
          MODEL_ROUTER_STATE_DIR: stateDir,
        },
      }),
    );
    assert.equal(afterRefresh.login_free, true);
    assert.equal(afterRefresh.model_provider, "codex-router");
    assert.equal(afterRefresh.model, "gpt-5.6-sol");

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
    // The built-in OpenAI identity takes the cross-version-safe provider switch.
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

test("aggregate overview exposes the router-owned catalog separately from client probes", () => {
  const stateDir = mkdtempSync(path.join(os.tmpdir(), "control-catalog-"));
  try {
    const userModel = userModelEntry({
      providerId: "deepseek",
      upstreamId: "operator-curated-preview",
      priority: 1,
    });
    writeFileSync(
      path.join(stateDir, "user-models.json"),
      `${JSON.stringify({ version: 1, models: [userModel] })}\n`,
      { mode: 0o600 },
    );
    const output = execFileSync(process.execPath, [path.join(root, "src", "control.mjs"), "--json"], {
      cwd: root,
      encoding: "utf8",
      env: {
        ...process.env,
        CODEX_HOME: stateDir,
        MODEL_ROUTER_STATE_DIR: stateDir,
      },
    });
    const parsed = JSON.parse(output);
    assert.equal(parsed.catalog.source, "codex-router");
    assert.ok(Array.isArray(parsed.catalog.models));
    assert.ok(Array.isArray(parsed.catalog.knownModels));
    assert.ok(Array.isArray(parsed.catalog.enabledProviders));
    assert.ok(Array.isArray(parsed.catalog.picker.hidden));
    assert.ok(Array.isArray(parsed.catalog.picker.visible));
    assert.equal(
      parsed.catalog.knownModels.some((model) => model.slug === userModel.slug),
      false,
      "operator-curated models must not be described as checked-in research routes",
    );
    const oxAlphaRoutes = parsed.catalog.knownModels
      .filter((model) => model.displayName.startsWith("Ox Alpha"))
      .map((model) => [model.slug, model.available])
      .sort(([left], [right]) => left.localeCompare(right));
    assert.deepEqual(oxAlphaRoutes, [
      ["commandcode/ox-alpha", false],
      ["nousresearch/ox-alpha", false],
      ["opencode-free/ox-alpha", true],
      ["openrouter/ox-alpha", false],
      ["venice/ox-alpha", false],
    ]);
    assert.deepEqual(
      parsed.catalog.models
        .filter((model) => model.slug.endsWith("/ox-alpha"))
        .map((model) => model.slug),
      ["opencode-free/ox-alpha"],
      "unavailable research routes must not enter the routable catalog",
    );
    const activeOxAlpha = parsed.catalog.models.find(
      (model) => model.slug === "opencode-free/ox-alpha",
    );
    assert.equal(activeOxAlpha.contextWindow, 1_048_576);
    assert.deepEqual(activeOxAlpha.inputModalities, ["text", "image"]);
    const flash = parsed.catalog.knownModels.find(
      (model) => model.slug === "opencode-go/glm-5.3-flash",
    );
    assert.equal(flash.available, false);
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

test("the tray usage advertises rebuild alongside the supervised actions", () => {
  const stateDir = mkdtempSync(path.join(os.tmpdir(), "control-tray-usage-"));
  try {
    assert.throws(
      () =>
        execFileSync(
          process.execPath,
          [path.join(root, "src", "control.mjs"), "tray", "bogus"],
          {
            cwd: root,
            encoding: "utf8",
            stdio: ["ignore", "pipe", "pipe"],
            env: { ...process.env, MODEL_ROUTER_STATE_DIR: stateDir },
          },
        ),
      (error) => {
        assert.match(String(error.stderr), /Usage: control tray enable\|disable\|status\|restart\|refresh\|rebuild/);
        return true;
      },
    );
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("Windows tray enable uses the durable package and task transaction", () => {
  const source = readFileSync(path.join(root, "src", "control.mjs"), "utf8");
  const tray = source.slice(source.indexOf("function handleTray("), source.indexOf("async function handleNativeRedirect("));
  assert.match(tray, /value === "enable" && process\.platform === "win32"/);
  assert.match(
    tray,
    /powershell\.exe[\s\S]*codex-router\.ps1[\s\S]*"tray"[\s\S]*"install"[\s\S]*"--preserve-window"/,
  );
  assert.ok(
    tray.indexOf('path.join(REPO_ROOT, "codex-router.ps1")')
      < tray.indexOf('path.join(REPO_ROOT, "src", "tray-service.mjs"), subcommand'),
    "Windows enable must choose the transaction before the raw supervisor fallback",
  );
});
