import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";

const root = mkdtempSync(path.join(os.tmpdir(), "cursor-router-config-"));
const stateDir = path.join(root, "router-state");
const dbPath = path.join(root, "Cursor", "User", "globalStorage", "state.vscdb");
const launcherPath = path.join(root, "bin", "cursor-router-agent");
mkdirSync(path.dirname(dbPath), { recursive: true });
process.env.MODEL_ROUTER_TARGET = "cursor";
process.env.MODEL_ROUTER_STATE_DIR = stateDir;
process.env.MODEL_ROUTER_CURSOR_STATE_DB = dbPath;
process.env.MODEL_ROUTER_CURSOR_LAUNCHER = launcherPath;

const { installCursorAgentIntegration, nodeRuntimePath, publishCursorIntegration, removeCursorIntegration } =
  await import("../src/cursor-config-manager.mjs");
const { cursorModelId } = await import("../src/cursor-model-id.mjs");

const APPLICATION_STATE_KEY =
  "src.vs.platform.reactivestorage.browser.reactiveStorageServiceImpl.persistentStorage.applicationUser";
const CALLER = "cursor-config-caller-secret-with-sufficient-length";
const PUBLIC = "cursor-config-public-secret-with-sufficient-length";

function readApplicationState() {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return JSON.parse(db.prepare("SELECT value FROM ItemTable WHERE key = ?").get(APPLICATION_STATE_KEY).value);
  } finally { db.close(); }
}

function hasRouterPlaceholder() {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return Boolean(db.prepare("SELECT 1 AS present FROM ItemTable WHERE key IN (?, ?) AND value = ? LIMIT 1")
      .get("cursorAuth/openAIKey", "secret://cursorAuth/openAIKey", "codex-router")?.present);
  } finally { db.close(); }
}

test("Cursor Agent setup is local, one-step, and does not require Cursor App state", () => {
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(path.join(stateDir, "caller-secret"), `${CALLER}\n`, { mode: 0o600 });
  const result = installCursorAgentIntegration({
    probe: () => ({ available: true, command: "cursor-agent", version: "test-version" }),
  });
  assert.equal(result.launcher, launcherPath);
  assert.match(result.cliBaseUrl, /\[REDACTED\]/);
  const launcher = readFileSync(launcherPath, "utf8");
  assert.equal(launcher.includes("cursor-agent-launcher.mjs"), true);
  assert.equal(launcher.includes(CALLER), false);
  assert.equal(readFileSync(path.join(stateDir, "caller-secret"), "utf8").trim(), CALLER);
  rmSync(launcherPath, { force: true });
});

test("packaged setup writes a real Node runtime instead of the Electron host", () => {
  const nodeName = process.platform === "win32" ? "node.exe" : "node";
  const runtime = "/test/runtime/bin";
  const node = nodeRuntimePath({
    execPath: "/Applications/Codex Router.app/Contents/MacOS/Codex Router",
    electron: true,
    environment: { PATH: runtime },
    exists: (candidate) => candidate === path.join(runtime, nodeName),
  });
  assert.equal(node, path.join(runtime, nodeName));
});

test("Cursor doctor recognizes the launcher as a complete agent-only integration", () => {
  const doctor = readFileSync(new URL("../src/doctor.mjs", import.meta.url), "utf8");
  assert.match(doctor, /const cursorAgentOnly = TARGET === "cursor"/);
  assert.match(doctor, /existsSync\(CURSOR_CATALOG_PATH\) \|\| existsSync\(CURSOR_LAUNCHER_PATH\)/);
});

test("Cursor publication is additive, private, reversible, and records every routed alias", () => {
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(path.join(stateDir, "caller-secret"), `${CALLER}\n`, { mode: 0o600 });
  writeFileSync(path.join(stateDir, "cursor-public-secret"), `${PUBLIC}\n`, { mode: 0o600 });
  const original = {
    useOpenAIKey: false,
    openAIBaseUrl: "https://user.example/v1",
    aiSettings: {
      userAddedModels: ["user/model"],
      modelOverrideEnabled: ["user/model"],
      modelOverrideDisabled: [cursorModelId("provider/one", "low")],
      modelConfig: {
        composer: {
          modelName: "user/model",
          selectedModels: [{ modelId: "user/model", parameters: [] }],
        },
      },
    },
    unrelated: { keep: true },
  };
  const db = new DatabaseSync(dbPath);
  db.exec("CREATE TABLE ItemTable (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB)");
  db.prepare("INSERT INTO ItemTable(key, value) VALUES(?, ?)").run(APPLICATION_STATE_KEY, JSON.stringify(original));
  db.close();

  try {
    assert.throws(
      () => publishCursorIntegration({
        origin: "https://127.0.0.1",
        assertStopped: () => {},
        routedModels: () => ({
          engine: "test",
          models: [{ slug: "provider/one", reasoningLevels: [{ effort: "low" }] }],
        }),
      }),
      /must not use a loopback/,
    );
    const result = publishCursorIntegration({
      origin: "https://cursor.example",
      assertStopped: () => {},
      routedModels: () => ({
        engine: "test",
        models: [
          { slug: "provider/one", reasoningLevels: [{ effort: "low" }, { effort: "high" }] },
          { slug: "provider/two", reasoningLevels: [{ effort: "medium" }] },
        ],
      }),
    });
    assert.deepEqual(result.aliases, [
      cursorModelId("provider/one", "low"),
      cursorModelId("provider/one", "high"),
      cursorModelId("provider/two", "medium"),
    ]);
    assert.equal(result.aliases.every((alias) => !alias.includes("provider/one")), true);
    const published = readApplicationState();
    assert.equal(published.useOpenAIKey, true);
    assert.match(published.openAIBaseUrl, /^https:\/\/cursor\.example\/_codex-router-cursor\//);
    assert.deepEqual(published.aiSettings.userAddedModels, [
      "user/model",
      cursorModelId("provider/one", "low"),
      cursorModelId("provider/one", "high"),
      cursorModelId("provider/two", "medium"),
    ]);
    assert.deepEqual(published.aiSettings.modelOverrideDisabled, []);
    assert.equal(published.aiSettings.modelConfig.composer.modelName, "user/model");
    assert.deepEqual(published.unrelated, { keep: true });
    assert.equal(hasRouterPlaceholder(), true);
    const launcher = readFileSync(launcherPath, "utf8");
    assert.equal(launcher.includes("cursor-agent-launcher.mjs"), true);
    assert.equal(launcher.includes(process.execPath), true);

    // Unrelated live edits remain the user's. The router restores only the
    // aliases it owns, including an alias that was disabled before install.
    const edited = new DatabaseSync(dbPath);
    const live = readApplicationState();
    live.aiSettings.userAddedModels = live.aiSettings.userAddedModels
      .filter((model) => model !== "user/model")
      .concat("user/new-model");
    live.aiSettings.modelConfig.composer = {
      modelName: result.aliases[1],
      selectedModels: [{ modelId: result.aliases[1], parameters: [] }],
    };
    edited.prepare("UPDATE ItemTable SET value = ? WHERE key = ?")
      .run(JSON.stringify(live), APPLICATION_STATE_KEY);
    edited.close();

    removeCursorIntegration({ assertStopped: () => {} });
    const restored = readApplicationState();
    assert.equal(restored.useOpenAIKey, false);
    assert.equal(restored.openAIBaseUrl, "https://user.example/v1");
    assert.deepEqual(restored.aiSettings.userAddedModels, ["user/new-model"]);
    assert.deepEqual(restored.aiSettings.modelOverrideEnabled, ["user/model"]);
    assert.deepEqual(restored.aiSettings.modelOverrideDisabled, [cursorModelId("provider/one", "low")]);
    assert.equal(restored.aiSettings.modelConfig.composer.modelName, "user/model");
    assert.deepEqual(restored.unrelated, { keep: true });
    assert.equal(hasRouterPlaceholder(), false);

    assert.deepEqual(removeCursorIntegration({ assertStopped: () => {} }), { removed: false });
    assert.deepEqual(readApplicationState(), restored);

    publishCursorIntegration({
      origin: "https://cursor.example",
      assertStopped: () => {},
      routedModels: () => ({
        engine: "test",
        models: [{ slug: "provider/one", reasoningLevels: [{ effort: "low" }] }],
      }),
    });
    const changedEndpoint = new DatabaseSync(dbPath);
    const changed = readApplicationState();
    changed.openAIBaseUrl = "https://user-new.example/v1";
    changed.useOpenAIKey = true;
    changedEndpoint.prepare("UPDATE ItemTable SET value = ? WHERE key = ?")
      .run(JSON.stringify(changed), APPLICATION_STATE_KEY);
    changedEndpoint.close();
    removeCursorIntegration({ assertStopped: () => {} });
    const endpointPreserved = readApplicationState();
    assert.equal(endpointPreserved.openAIBaseUrl, "https://user-new.example/v1");
    assert.equal(endpointPreserved.useOpenAIKey, true);

    writeFileSync(launcherPath, "#!/bin/sh\necho user-owned\n", { mode: 0o700 });
    assert.throws(
      () => publishCursorIntegration({
        origin: "https://cursor.example",
        assertStopped: () => {},
        routedModels: () => ({
          engine: "test",
          models: [{ slug: "provider/one", reasoningLevels: [{ effort: "low" }] }],
        }),
      }),
      /not owned by codex-router/,
    );
    assert.equal(readFileSync(launcherPath, "utf8"), "#!/bin/sh\necho user-owned\n");
    assert.deepEqual(readApplicationState(), endpointPreserved);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
