import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  OPENCLAW_PROVIDER_ID,
  createOpenClawCli,
  createOpenClawManager,
  openclawModelProfile,
} from "../src/openclaw-config-manager.mjs";

const SECRET = "openclaw-test-caller-secret-with-length-123";

function models(first = "fast-model") {
  return {
    engine: { slug: first },
    models: [
      {
        slug: first,
        displayName: "Fast Model",
        priority: 20,
        contextWindow: 131072,
        inputModalities: ["text", "image"],
        reasoningLevels: [{ effort: "low" }, { effort: "ultra" }],
      },
      { slug: "steady-model", displayName: "Steady Model", priority: 10, reasoningLevels: [] },
    ],
  };
}

function fakeClient({ provider, defaultModel, configPath = "/tmp/openclaw.json" } = {}) {
  const state = { provider, defaultModel, patches: [], unsets: [] };
  return {
    binary: "/tmp/openclaw",
    state,
    get(configPath) {
      if (configPath === `models.providers.${OPENCLAW_PROVIDER_ID}`) return state.provider;
      if (configPath === "agents.defaults.model.primary") return state.defaultModel;
      return undefined;
    },
    configFile() { return configPath; },
    patch(value, replacePaths) {
      state.patches.push({ value, replacePaths });
      state.provider = value.models.providers[OPENCLAW_PROVIDER_ID];
      if (value.agents) state.defaultModel = value.agents.defaults.model.primary;
    },
    unset(configPath) {
      state.unsets.push(configPath);
      if (configPath === `models.providers.${OPENCLAW_PROVIDER_ID}`) state.provider = undefined;
      if (configPath === "agents.defaults.model.primary") state.defaultModel = undefined;
    },
  };
}

function fixture(options = {}, managerOptions = {}) {
  const directory = mkdtempSync(path.join(os.tmpdir(), "openclaw-manager-"));
  const secretPath = path.join(directory, "caller-secret");
  const catalogPath = path.join(directory, "openclaw-models.json");
  const configPath = path.join(directory, "openclaw.json");
  writeFileSync(secretPath, `${SECRET}\n`, { mode: 0o600 });
  writeFileSync(configPath, "{}\n", { mode: 0o644 });
  const client = fakeClient({ ...options, configPath });
  const manager = createOpenClawManager({
    client,
    catalogPath,
    secretPath,
    port: 4299,
    legacyPort: 4199,
    modelSource: () => models(),
    assertOwnership() {},
    ...managerOptions,
  });
  return { directory, secretPath, catalogPath, configPath, client, manager };
}

test("OpenClaw profiles preserve router capabilities and exact reasoning efforts", () => {
  assert.deepEqual(openclawModelProfile(models().models[0]), {
    id: "fast-model",
    name: "Fast Model",
    reasoning: true,
    input: ["text", "image"],
    contextWindow: 131072,
    compat: { supportedReasoningEfforts: ["low", "ultra"] },
  });
  assert.deepEqual(openclawModelProfile(models().models[1]), {
    id: "steady-model",
    name: "Steady Model",
    reasoning: false,
    input: ["text"],
  });
});

test("OpenClaw config publication keeps the caller key off argv and redacts failures", () => {
  const calls = [];
  const cli = createOpenClawCli("/fixed/openclaw", {
    spawn: (command, args, options) => {
      calls.push({ command, args, input: options.input });
      return { status: 0, stdout: "", stderr: "" };
    },
  });
  cli.patch({ apiKey: SECRET }, ["models.providers.codex-router"], SECRET);
  assert.equal(calls[0].args.includes(SECRET), false);
  assert.equal(calls[0].input.includes(SECRET), true);

  const failing = createOpenClawCli("/fixed/openclaw", {
    spawn: () => ({ status: 1, stdout: "", stderr: `rejected ${SECRET}` }),
  });
  assert.throws(
    () => failing.patch({ apiKey: SECRET }, ["models.providers.codex-router"], SECRET),
    (error) => !error.message.includes(SECRET) && error.message.includes("[REDACTED]"),
  );
});

test("OpenClaw treats a schema-valid unset path as missing on first publish", () => {
  const cli = createOpenClawCli("/fixed/openclaw", {
    spawn: () => ({
      status: 1,
      stdout: "",
      stderr: "Config path is valid but unset: models.providers.codex-router\n",
    }),
  });
  assert.equal(cli.get("models.providers.codex-router"), undefined);
});

test("first publish owns an empty default and writes a private catalog marker", () => {
  const { manager, client, catalogPath } = fixture();
  const result = manager.install();
  assert.equal(result.models, 2);
  assert.equal(result.defaultModel, "codex-router/fast-model");
  assert.equal(client.state.defaultModel, "codex-router/fast-model");
  assert.equal(client.state.provider.api, "openai-responses");
  assert.equal(client.state.provider.apiKey, SECRET);
  assert.match(client.state.provider.baseUrl, /_codex-router\/openclaw-test-caller-secret-with-length-123\/v1$/);
  assert.deepEqual(client.state.provider.models.map((model) => model.id), ["fast-model", "steady-model"]);
  assert.deepEqual(client.state.patches[0].replacePaths, [
    "models.providers.codex-router",
    "agents.defaults.model.primary",
  ]);
  assert.equal(readFileSync(catalogPath, "utf8").includes(SECRET), true);
  if (process.platform !== "win32") {
    const mode = statSync(catalogPath).mode & 0o777;
    assert.equal(mode, 0o600);
  }
});

test("publish preserves an existing user default", () => {
  const { manager, client } = fixture({ defaultModel: "other/model" });
  const result = manager.install();
  assert.equal(result.defaultOwned, false);
  assert.equal(client.state.defaultModel, "other/model");
  assert.deepEqual(client.state.patches[0].replacePaths, ["models.providers.codex-router"]);
});

test("refresh follows a router-owned default but stops after a user override", () => {
  const { manager, client, catalogPath, secretPath } = fixture();
  manager.install();
  writeFileSync(secretPath, "rotated-openclaw-caller-secret-with-length-456\n", { mode: 0o600 });
  const refreshed = createOpenClawManager({
    client,
    catalogPath,
    secretPath,
    port: 4299,
    legacyPort: 4199,
    modelSource: () => models("new-fast-model"),
    assertOwnership() {},
  });
  refreshed.refreshCallerCapability();
  assert.equal(client.state.defaultModel, "codex-router/new-fast-model");
  assert.equal(client.state.provider.apiKey, "rotated-openclaw-caller-secret-with-length-456");

  client.state.defaultModel = "other/user-choice";
  const result = refreshed.install();
  assert.equal(result.defaultOwned, false);
  assert.equal(client.state.defaultModel, "other/user-choice");
});

test("publish refuses an unmanaged provider collision", () => {
  const { manager } = fixture({ provider: { baseUrl: "https://example.com/v1" } });
  assert.throws(() => manager.install(), /unmanaged codex-router provider/);
});

test("publish stops before mutation when the OpenClaw config cannot be protected", () => {
  const { manager, client, catalogPath } = fixture({}, {
    protectConfig() { throw new Error("planned privacy failure"); },
  });
  assert.throws(() => manager.install(), /planned privacy failure/);
  assert.equal(client.state.patches.length, 0);
  assert.equal(client.state.provider, undefined);
  assert.equal(client.state.defaultModel, undefined);
  assert.equal(existsSync(catalogPath), false);
});

test("publish rolls back provider and default when the marker write fails", () => {
  const { manager, client, catalogPath } = fixture({}, {
    writeCatalog() { throw new Error("planned marker failure"); },
  });
  assert.throws(() => manager.install(), /planned marker failure/);
  assert.equal(client.state.provider, undefined);
  assert.equal(client.state.defaultModel, undefined);
  assert.deepEqual(client.state.unsets, [
    "models.providers.codex-router",
    "agents.defaults.model.primary",
  ]);
  assert.equal(existsSync(catalogPath), false);
});

test("malformed publication markers fail closed before install or uninstall mutation", () => {
  const { manager, client, catalogPath } = fixture({
    provider: {
      baseUrl: `http://127.0.0.1:4299/_codex-router/${SECRET}/v1`,
      apiKey: SECRET,
      api: "openai-responses",
    },
    defaultModel: "other/user-choice",
  });
  writeFileSync(catalogPath, JSON.stringify({
    version: 999,
    provider: OPENCLAW_PROVIDER_ID,
    defaultOwned: "yes",
    defaultModel: "other/user-choice",
  }));

  assert.throws(() => manager.install(), /unsupported or malformed shape/);
  assert.throws(() => manager.uninstall(), /unsupported or malformed shape/);
  assert.equal(client.state.patches.length, 0);
  assert.equal(client.state.unsets.length, 0);
  const value = manager.status();
  assert.equal(value.stateValid, false);
  assert.equal(value.configValid, false);
  assert.match(value.configError, /unsupported or malformed shape/);

  writeFileSync(catalogPath, "null\n");
  assert.match(manager.status().configError, /unsupported or malformed shape/);
});

test("uninstall refuses a provider that has no router ownership marker", () => {
  const { manager, client } = fixture({
    provider: { baseUrl: `http://127.0.0.1:4299/_codex-router/${SECRET}/v1` },
  });
  assert.throws(() => manager.uninstall(), /unmanaged OpenClaw codex-router provider/);
  assert.notEqual(client.state.provider, undefined);
  assert.equal(client.state.unsets.length, 0);
});

test("publish and uninstall both enforce router state ownership", () => {
  const actions = [];
  const { manager } = fixture({}, { assertOwnership: (action) => actions.push(action) });
  manager.install();
  manager.uninstall();
  assert.deepEqual(actions, [
    "write the OpenClaw model catalog",
    "remove the OpenClaw integration",
  ]);
});

test("uninstall removes only a default the router still owns", () => {
  const owned = fixture();
  owned.manager.install();
  assert.equal(owned.manager.uninstall().defaultRemoved, true);
  assert.equal(owned.client.state.defaultModel, undefined);
  assert.equal(existsSync(owned.catalogPath), false);

  const overridden = fixture();
  overridden.manager.install();
  overridden.client.state.defaultModel = "other/user-choice";
  assert.equal(overridden.manager.uninstall().defaultRemoved, false);
  assert.equal(overridden.client.state.defaultModel, "other/user-choice");
});

test("status redacts the caller capability", () => {
  const { manager } = fixture();
  manager.install();
  const value = manager.status();
  assert.equal(value.baseUrl.includes(SECRET), false);
  assert.match(value.baseUrl, /\[REDACTED\]/);
  assert.equal(value.catalogFresh, true);
});

test("status detects live OpenClaw provider drift", () => {
  const { manager, client } = fixture();
  manager.install();
  client.state.provider.api = "openai-completions";
  const value = manager.status();
  assert.equal(value.configValid, false);
  assert.equal(value.catalogFresh, false);
  assert.match(value.configError, /differs from the router-owned protocol/);
});
