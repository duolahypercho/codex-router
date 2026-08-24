import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { realpathSync, symlinkSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import {
  assertMutationCompatibility,
  detachedControlRuntime,
  discoverSourceRoot,
  runControlDetached,
  runControl,
  runControlJson,
  runtimeEnvironment,
  standardSourceRoots,
} from "../apps/control-center/electron/command-runner.mjs";
import {
  groupModelFamilies,
  modelFamilyKey,
} from "../apps/control-center/src/model-families.mjs";
import {
  addPendingCatalogModels,
  beginCatalogRequest,
  catalogRequestIsCurrent,
  clearProviderCatalogStates,
  invalidateProviderCatalogRequests,
  modelRouteKind,
  modelRouteProtocol,
  pendingCatalogModelIds,
  removePendingCatalogModels,
  searchLoadedCatalogModels,
} from "../apps/control-center/src/model-catalog-search.mjs";
import {
  createOpenRequestGate,
  createRendererReadyGate,
  lifecycleStatePath,
  linuxStatusNotifierHostAvailable,
  queryLifecycleState,
  shouldQuitOnLastWindowClosed,
  writeLifecycleState,
} from "../apps/control-center/electron/lifecycle-state.mjs";
import { openBrowserCommand } from "../apps/control-center/electron/ipc.mjs";

test("ChatGPT browser login waits for the OAuth URL after child close", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "router-browser-login-"));
  const executable = path.join(directory, "codex-test");
  const openedUrls = [];
  let exited = false;
  try {
    await writeFile(
      executable,
      "#!/usr/bin/env node\nprocess.stdout.write('https://auth.openai.com/oauth/authorize?state=test')\n",
    );
    await chmod(executable, 0o755);
    const result = await openBrowserCommand(executable, [], process.cwd(), {
      environment: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin" },
      openExternal: async (url) => { openedUrls.push(url); },
      onExit: () => { exited = true; },
    });
    assert.deepEqual(result, { opened: true, surface: "browser" });
    assert.deepEqual(openedUrls, ["https://auth.openai.com/oauth/authorize?state=test"]);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(exited, true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Control Center groups provider routes under one model family", () => {
  const families = groupModelFamilies([
    { slug: "opencode-free/ox-alpha", displayName: "Ox Alpha (OpenCode Free)", provider: "opencode-free", visible: false, enabled: true },
    { slug: "opencode-go/ox-alpha", displayName: "Ox Alpha (opencode Go)", provider: "opencode-go", visible: true, enabled: true },
    { slug: "opencode-free/x-preview-f-free", displayName: "Ox Alpha Free", provider: "opencode-free", visible: true, enabled: true },
    { slug: "deepseek/deepseek-v4-pro", displayName: "DeepSeek V4 Pro (API)", provider: "deepseek", visible: true, enabled: true },
  ]);
  assert.equal(families.length, 2);
  const ox = families.find((family) => family.id === "ox-alpha");
  assert.equal(ox.displayName, "Ox Alpha");
  assert.deepEqual(ox.routes.map((route) => route.slug), [
    "opencode-free/ox-alpha",
    "opencode-free/x-preview-f-free",
    "opencode-go/ox-alpha",
  ]);
  assert.equal(modelFamilyKey({ displayName: "Kimi K3 (OAuth)" }), "kimi-k3");
  assert.equal(modelFamilyKey({ displayName: "Kimi K3 (opencode Go)" }), "kimi-k3");
});

test("global model search includes candidates that exist only in loaded discovery state", () => {
  const directory = [{
    id: "opencode-go",
    displayName: "opencode Go/Zen",
    setup: {
      configured: true,
      catalogSources: [
        { id: "opencode-go", displayName: "opencode Go" },
        { id: "opencode-zen", displayName: "opencode Zen" },
      ],
    },
  }];
  const states = {
    "opencode-zen": {
      data: {
        discovered: ["discovery-only-model"],
        registered: [],
        unregistered: ["discovery-only-model"],
        addable: ["discovery-only-model"],
        blocked: {},
        contextLengths: { "discovery-only-model": 131_072 },
      },
    },
  };

  const [match] = searchLoadedCatalogModels(directory, states, "discovery only");
  assert.equal(match.modelId, "discovery-only-model");
  assert.equal(match.providerName, "opencode Go/Zen");
  assert.equal(match.sourceName, "opencode Zen");
  assert.equal(match.sourceId, "opencode-zen");
  assert.equal(match.addable, true);
  assert.equal(match.registered, false);
  assert.equal(match.contextWindow, 131_072);
  assert.equal(searchLoadedCatalogModels(directory, states, "opencode zen").length, 1);
});

test("global model search exposes blocked reasons and hides disconnected catalog state", () => {
  const connected = [{
    id: "opencode-go",
    displayName: "opencode Go/Zen",
    setup: {
      configured: true,
      catalogSources: [{ id: "opencode-go", displayName: "opencode Go" }],
    },
  }];
  const states = {
    "opencode-go": {
      data: {
        discovered: ["future-protocol-model"],
        registered: [],
        unregistered: ["future-protocol-model"],
        addable: [],
        blocked: {
          "future-protocol-model": "No certified Chat, Messages, or Responses route yet.",
        },
      },
    },
  };

  const [match] = searchLoadedCatalogModels(connected, states, "future protocol");
  assert.equal(match.addable, false);
  assert.equal(match.blockedReason, "No certified Chat, Messages, or Responses route yet.");

  const disconnected = [{
    ...connected[0],
    setup: { ...connected[0].setup, configured: false },
  }];
  assert.deepEqual(searchLoadedCatalogModels(disconnected, states, "future protocol"), []);
});

test("credential changes clear every loaded catalog source in only that provider family", () => {
  const current = {
    "opencode-go": { status: "ready" },
    "opencode-zen": { status: "ready" },
    deepseek: { status: "ready" },
  };
  const cleared = clearProviderCatalogStates(current, [
    { id: "opencode-go" },
    { id: "opencode-zen" },
  ]);
  assert.deepEqual(cleared, { deepseek: { status: "ready" } });
  assert.deepEqual(current, {
    "opencode-go": { status: "ready" },
    "opencode-zen": { status: "ready" },
    deepseek: { status: "ready" },
  });
  assert.strictEqual(clearProviderCatalogStates(current, []), current);
});

test("credential changes invalidate every pre-existing catalog completion", () => {
  const generations = {};
  const oldGo = beginCatalogRequest(generations, "opencode-go");
  const oldZen = beginCatalogRequest(generations, "opencode-zen");
  const unrelated = beginCatalogRequest(generations, "deepseek");

  invalidateProviderCatalogRequests(generations, [
    { id: "opencode-go" },
    { id: "opencode-zen" },
  ]);
  assert.equal(catalogRequestIsCurrent(generations, "opencode-go", oldGo), false);
  assert.equal(catalogRequestIsCurrent(generations, "opencode-zen", oldZen), false);
  assert.equal(catalogRequestIsCurrent(generations, "deepseek", unrelated), true);

  const newGo = beginCatalogRequest(generations, "opencode-go");
  assert.equal(catalogRequestIsCurrent(generations, "opencode-go", newGo), true);
  assert.equal(catalogRequestIsCurrent(generations, "opencode-go", oldGo), false);
});

test("route protocol labels use the provider-qualified snapshot slug", () => {
  const base = { provider: "opencode-go", enabled: true, visible: true };
  const messages = { ...base, slug: "opencode-go-messages/minimax-m3" };
  const responses = { ...base, slug: "opencode-go-responses/grok-4.5", isFree: true };

  assert.equal(modelRouteProtocol(messages), "messages");
  assert.equal(modelRouteKind(messages), "Messages API route");
  assert.equal(modelRouteProtocol(responses), "responses");
  assert.equal(modelRouteKind(responses), "Responses API route");
});

test("overlapping catalog adds retain each operation's pending models", () => {
  let pending = {};
  pending = addPendingCatalogModels(pending, "deepseek", ["deepseek-v4", "shared-model"]);
  pending = addPendingCatalogModels(pending, "deepseek", ["deepseek-v5", "shared-model"]);
  assert.deepEqual(
    new Set(pendingCatalogModelIds(pending, "deepseek")),
    new Set(["deepseek-v4", "deepseek-v5", "shared-model"]),
  );

  pending = removePendingCatalogModels(pending, "deepseek", ["deepseek-v4", "shared-model"]);
  assert.deepEqual(
    new Set(pendingCatalogModelIds(pending, "deepseek")),
    new Set(["deepseek-v5", "shared-model"]),
  );

  pending = removePendingCatalogModels(pending, "deepseek", ["deepseek-v5", "shared-model"]);
  assert.deepEqual(pendingCatalogModelIds(pending, "deepseek"), []);
  assert.deepEqual(pending, {});
});

test("Electron queues pre-ready open requests and drains them once", () => {
  let opens = 0;
  const gate = createOpenRequestGate(() => { opens += 1; });
  gate.requestOpen();
  gate.requestOpen();
  assert.equal(gate.pending(), true);
  assert.equal(opens, 0);
  gate.markReady();
  assert.equal(gate.pending(), false);
  assert.equal(opens, 1);
  gate.requestOpen();
  assert.equal(opens, 2);
});

test("Electron renderer readiness requires load and first-paint signals", () => {
  let ready = 0;
  let failures = 0;
  const gate = createRendererReadyGate({
    onReady: () => { ready += 1; },
    onFailure: () => { failures += 1; },
  });
  gate.didFinishLoad();
  assert.equal(gate.ready(), false);
  assert.equal(ready, 0);
  gate.didBecomeReadyToShow();
  assert.equal(gate.ready(), true);
  assert.equal(ready, 1);
  gate.didBecomeReadyToShow();
  gate.didFinishLoad();
  gate.didFailLoad(new Error("late failure"));
  assert.equal(ready, 1);
  assert.equal(failures, 0);
});

test("Electron renderer readiness fails closed before first paint", () => {
  let ready = 0;
  let failure;
  const gate = createRendererReadyGate({
    onReady: () => { ready += 1; },
    onFailure: (error) => { failure = error; },
  });
  gate.didFinishLoad();
  gate.didFailLoad(new Error("missing renderer"));
  gate.didBecomeReadyToShow();
  assert.equal(gate.ready(), false);
  assert.equal(gate.failed(), true);
  assert.equal(ready, 0);
  assert.match(failure.message, /missing renderer/);
});

test("Electron lifecycle state is durable, queryable, and fail-closed", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "router-control-lifecycle-"));
  const file = path.join(directory, "control-center-lifecycle.json");
  try {
    assert.equal(
      lifecycleStatePath({ MODEL_ROUTER_STATE_DIR: directory }, "/unused"),
      file,
    );
    const written = writeLifecycleState(file, {
      pid: 4321,
      ready: true,
      visible: true,
      now: new Date("2026-08-24T00:00:00.000Z"),
    });
    assert.equal(written.visible, true);
    if (process.platform !== "win32") assert.equal((await stat(file)).mode & 0o077, 0);
    assert.deepEqual(queryLifecycleState(file, { isRunning: (pid) => pid === 4321 }), {
      version: 1,
      running: true,
      pid: 4321,
      ready: true,
      visible: true,
      updatedAt: "2026-08-24T00:00:00.000Z",
    });
    assert.deepEqual(queryLifecycleState(file, { isRunning: () => false }), {
      version: 1,
      running: false,
      pid: null,
      ready: false,
      visible: false,
      updatedAt: "2026-08-24T00:00:00.000Z",
    });
    writeLifecycleState(file, { pid: 4321, ready: false, visible: false });
    const stopped = queryLifecycleState(file, { isRunning: () => true });
    assert.equal(stopped.ready, false);
    assert.equal(stopped.visible, false);
    await writeFile(file, "not json\n", { mode: 0o600 });
    assert.equal(queryLifecycleState(file).visible, false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a windowless desktop process survives only while a real tray owner exists", () => {
  assert.equal(shouldQuitOnLastWindowClosed({ platform: "darwin", nativeTrayOwnedByHost: true }), true);
  assert.equal(shouldQuitOnLastWindowClosed({ platform: "darwin", nativeTrayOwnedByHost: false, trayAvailable: false }), false);
  assert.equal(shouldQuitOnLastWindowClosed({ platform: "win32", nativeTrayOwnedByHost: false, trayAvailable: true }), false);
  assert.equal(shouldQuitOnLastWindowClosed({ platform: "win32", nativeTrayOwnedByHost: false, trayAvailable: false }), true);
  assert.equal(shouldQuitOnLastWindowClosed({ platform: "linux", nativeTrayOwnedByHost: false, trayAvailable: true }), false);
  assert.equal(shouldQuitOnLastWindowClosed({ platform: "linux", nativeTrayOwnedByHost: false, trayAvailable: false }), true);
});

test("Linux tray-only mode trusts only a positively registered StatusNotifier host", () => {
  const calls = [];
  const available = linuxStatusNotifierHostAvailable({
    platform: "linux",
    executableExists: () => true,
    environment: { DBUS_SESSION_BUS_ADDRESS: "unix:path=/test/session-bus" },
    spawn(executable, args, options) {
      calls.push({ executable, args, options });
      return { status: 0, stdout: "(<true>,)\n" };
    },
  });
  assert.equal(available, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].executable, "/usr/bin/gdbus");
  assert.deepEqual(calls[0].args, [
    "call",
    "--session",
    "--dest", "org.kde.StatusNotifierWatcher",
    "--object-path", "/StatusNotifierWatcher",
    "--method", "org.freedesktop.DBus.Properties.Get",
    "org.kde.StatusNotifierWatcher",
    "IsStatusNotifierHostRegistered",
  ]);
  assert.equal(calls[0].options.shell, false);

  for (const result of [
    { status: 0, stdout: "(<false>,)\n" },
    { status: 0, stdout: "unexpected\n" },
    { status: 1, stdout: "(<true>,)\n" },
  ]) {
    assert.equal(linuxStatusNotifierHostAvailable({
      platform: "linux",
      executableExists: () => true,
      spawn: () => result,
    }), false);
  }
  assert.equal(linuxStatusNotifierHostAvailable({
    platform: "linux",
    executableExists: () => false,
    spawn: () => assert.fail("a missing probe must fail open without spawning"),
  }), false);
  assert.equal(linuxStatusNotifierHostAvailable({
    platform: "linux",
    executableExists: () => true,
    spawn: () => { throw new Error("session bus unavailable"); },
  }), false);
  assert.equal(linuxStatusNotifierHostAvailable({
    platform: "win32",
    executableExists: () => true,
    spawn: () => assert.fail("non-Linux platforms must not query D-Bus"),
  }), false);
});

async function waitForProcessExit(pid, timeoutMs = 4_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { process.kill(pid, 0); }
    catch (error) {
      if (error?.code === "ESRCH") return;
      throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail(`descendant process ${pid} survived command termination`);
}

async function makeProcessTreeControlRoot() {
  const root = await mkdtemp(path.join(os.tmpdir(), "router-control-tree-"));
  await mkdir(path.join(root, "src"), { recursive: true });
  await mkdir(path.join(root, "bin"), { recursive: true });
  await writeFile(
    path.join(root, "src", "control.mjs"),
    [
      'import { spawn } from "node:child_process";',
      'import { writeFileSync } from "node:fs";',
      'const [pidFile, mode] = process.argv.slice(2);',
      'const descendant = spawn(process.execPath, ["-e", "process.on(\\"SIGTERM\\", () => {}); setInterval(() => {}, 1000)"], { stdio: "ignore" });',
      'writeFileSync(pidFile, String(descendant.pid));',
      'if (mode === "overflow") process.stdout.write("x".repeat(4096));',
      'process.on("SIGTERM", () => {});',
      'setInterval(() => {}, 1000);',
      '',
    ].join("\n"),
    { mode: 0o700 },
  );
  await writeFile(path.join(root, "bin", "control"), "#!/bin/sh\n", { mode: 0o700 });
  if (process.platform !== "win32") await chmod(path.join(root, "bin", "control"), 0o700);
  return root;
}

test("control center knows each installer's stable checkout location", () => {
  assert.deepEqual(
    standardSourceRoots({ platform: "win32", environment: { LOCALAPPDATA: "/local/appdata" }, home: "/home/test" }),
    [path.join("/local/appdata", "codex-router")],
  );
  assert.deepEqual(
    standardSourceRoots({ platform: "linux", environment: { XDG_DATA_HOME: "/xdg/data" }, home: "/home/test" }),
    [path.join("/xdg/data", "codex-router"), path.join("/home/test", ".local", "share", "codex-router")],
  );
});

test("control center repairs the runtime PATH for desktop-launched commands", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "router-control-node-"));
  const nodeName = process.platform === "win32" ? "node.exe" : "node";
  const node = path.join(directory, nodeName);
  try {
    await writeFile(node, "", { mode: 0o700 });
    const environment = runtimeEnvironment({ PATH: directory, KEEP_ME: "yes" });
    assert.equal(environment.KEEP_ME, "yes");
    assert.equal(environment.PATH.split(path.delimiter)[0], directory);
    assert.equal(environment.CODEX_ROUTER_NODE_BIN, node);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("the recorded runtime keeps the name a version-manager shim dispatches on", { skip: process.platform === "win32" }, async () => {
  // volta ships one dispatcher binary and symlinks `node` at it; it decides
  // what to run from the name it was invoked under. Recording the link target
  // hands `bin/install` a launcher that refuses to start, and that value is
  // written straight into the background service definition.
  const directory = await mkdtemp(path.join(os.tmpdir(), "router-control-shim-"));
  try {
    const dispatcher = path.join(directory, "volta-shim");
    const node = path.join(directory, "node");
    await writeFile(dispatcher, "", { mode: 0o700 });
    symlinkSync(dispatcher, node);
    const environment = runtimeEnvironment({ PATH: directory });
    assert.equal(environment.CODEX_ROUTER_NODE_BIN, node);
    assert.equal(path.basename(environment.CODEX_ROUTER_NODE_BIN), "node");
    assert.equal(environment.PATH.split(path.delimiter)[0], directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("an operator's own runtime choice is honored exactly as written", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "router-control-chosen-"));
  const nodeName = process.platform === "win32" ? "node.exe" : "node";
  try {
    const chosen = path.join(directory, nodeName);
    await writeFile(chosen, "", { mode: 0o700 });
    assert.equal(
      runtimeEnvironment({ PATH: "", CODEX_ROUTER_NODE_BIN: chosen }).CODEX_ROUTER_NODE_BIN,
      chosen,
    );
    // A named runtime that cannot be executed must not be recorded; discovery
    // takes over, and an undiscoverable runtime leaves the refusal to the
    // installer rather than naming something that does not run.
    const broken = runtimeEnvironment(
      { PATH: "", CODEX_ROUTER_NODE_BIN: path.join(directory, "missing") },
      { platform: "sunos" },
    );
    assert.notEqual(broken.CODEX_ROUTER_NODE_BIN, path.join(directory, "missing"));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Windows detached tray refresh runs outside the package on external node.exe", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "router-control-detached-"));
  const packageDirectory = path.join(directory, "win-unpacked");
  const runtimeDirectory = path.join(directory, "node-runtime");
  const packagedExecutable = path.join(packageDirectory, "Codex Router.exe");
  const externalNode = path.join(runtimeDirectory, "node.exe");
  try {
    await mkdir(packageDirectory, { recursive: true });
    await mkdir(runtimeDirectory, { recursive: true });
    await writeFile(packagedExecutable, "");
    await writeFile(externalNode, "");
    const launch = detachedControlRuntime(
      {
        PATH: "",
        CODEX_ROUTER_NODE_BIN: externalNode,
        ELECTRON_RUN_AS_NODE: "1",
      },
      { platform: "win32", execPath: packagedExecutable, electron: true },
    );
    assert.equal(launch.executable, externalNode);
    assert.equal(launch.environment.CODEX_ROUTER_NODE_BIN, externalNode);
    assert.equal(launch.environment.ELECTRON_RUN_AS_NODE, undefined);

    const source = await readFile(new URL("../apps/control-center/electron/command-runner.mjs", import.meta.url), "utf8");
    const detached = source.slice(source.indexOf("export function runControlDetached("));
    assert.match(detached, /spawnImpl\([\s\S]*runtime\.executable,[\s\S]*path\.join\(sourceRoot, "src", "control\.mjs"\), \.\.\.args/);
    assert.doesNotMatch(detached, /spawn\(process\.execPath/);

    const inPackageNode = path.join(packageDirectory, "node.exe");
    await writeFile(inPackageNode, "");
    assert.throws(
      () => detachedControlRuntime(
        { PATH: "", CODEX_ROUTER_NODE_BIN: inPackageNode },
        { platform: "win32", execPath: packagedExecutable, electron: true },
      ),
      /trusted external node\.exe is required/,
    );
    await rm(inPackageNode);
    assert.throws(
      () => detachedControlRuntime(
        { PATH: "" },
        { platform: "win32", execPath: packagedExecutable, electron: true },
      ),
      /trusted external node\.exe is required/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("non-Windows detached refresh keeps the packaged Node-mode launch", { skip: process.platform === "win32" }, () => {
  const launch = detachedControlRuntime(
    { PATH: path.dirname(process.execPath) },
    { platform: process.platform, execPath: process.execPath, electron: true },
  );
  assert.equal(launch.executable, process.execPath);
  assert.equal(launch.environment.ELECTRON_RUN_AS_NODE, "1");
});

test("detached control resolves only after spawn and rejects a pre-spawn error", async () => {
  const runtime = { executable: "/test/node", environment: {} };
  const sourceRoot = path.dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
  const failedChild = new EventEmitter();
  failedChild.unref = () => assert.fail("a failed child must not be unreferenced as launched");
  const failed = runControlDetached(["tray", "restart"], {
    sourceRoot,
    runtime,
    spawnImpl: () => {
      queueMicrotask(() => failedChild.emit("error", new Error("spawn ENOENT")));
      return failedChild;
    },
  });
  await assert.rejects(failed, /spawn ENOENT/);

  const launchedChild = new EventEmitter();
  launchedChild.pid = 4242;
  let unreferenced = false;
  launchedChild.unref = () => { unreferenced = true; };
  const launched = runControlDetached(["tray", "restart"], {
    sourceRoot,
    runtime,
    spawnImpl: () => {
      queueMicrotask(() => launchedChild.emit("spawn"));
      return launchedChild;
    },
  });
  assert.equal(await launched, 4242);
  assert.equal(unreferenced, true);
});

test("control center resolves a trusted router source root", async () => {
  const priorRoot = process.env.CODEX_ROUTER_SOURCE_ROOT;
  const priorModelState = process.env.MODEL_ROUTER_STATE_DIR;
  const priorState = process.env.CODEX_ROUTER_STATE_DIR;
  const priorKimiState = process.env.KIMI_CODEX_STATE_DIR;
  const state = await mkdtemp(path.join(os.tmpdir(), "router-control-state-"));
  delete process.env.CODEX_ROUTER_SOURCE_ROOT;
  delete process.env.MODEL_ROUTER_STATE_DIR;
  process.env.CODEX_ROUTER_STATE_DIR = state;
  delete process.env.KIMI_CODEX_STATE_DIR;
  const repositoryRoot = path.dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
  try {
    assert.equal(discoverSourceRoot(), repositoryRoot);
  } finally {
    if (priorRoot === undefined) delete process.env.CODEX_ROUTER_SOURCE_ROOT;
    else process.env.CODEX_ROUTER_SOURCE_ROOT = priorRoot;
    if (priorModelState === undefined) delete process.env.MODEL_ROUTER_STATE_DIR;
    else process.env.MODEL_ROUTER_STATE_DIR = priorModelState;
    if (priorState === undefined) delete process.env.CODEX_ROUTER_STATE_DIR;
    else process.env.CODEX_ROUTER_STATE_DIR = priorState;
    if (priorKimiState === undefined) delete process.env.KIMI_CODEX_STATE_DIR;
    else process.env.KIMI_CODEX_STATE_DIR = priorKimiState;
    await rm(state, { recursive: true, force: true });
  }
});

test("control center follows the recorded router owner", async () => {
  const owner = await mkdtemp(path.join(os.tmpdir(), "router-control-owner-"));
  const state = await mkdtemp(path.join(os.tmpdir(), "router-control-state-"));
  const priorRoot = process.env.CODEX_ROUTER_SOURCE_ROOT;
  const priorModelState = process.env.MODEL_ROUTER_STATE_DIR;
  const priorState = process.env.CODEX_ROUTER_STATE_DIR;
  const priorKimiState = process.env.KIMI_CODEX_STATE_DIR;
  try {
    await mkdir(path.join(owner, "src"), { recursive: true });
    await mkdir(path.join(owner, "bin"), { recursive: true });
    await writeFile(path.join(owner, "src", "control.mjs"), "", { mode: 0o700 });
    await writeFile(path.join(owner, "bin", "control"), "#!/bin/sh\n", { mode: 0o700 });
    await writeFile(
      path.join(state, "install-manifest.json"),
      JSON.stringify({ version: 1, current: { sourceRoot: owner } }),
      { mode: 0o600 },
    );
    delete process.env.CODEX_ROUTER_SOURCE_ROOT;
    delete process.env.MODEL_ROUTER_STATE_DIR;
    process.env.CODEX_ROUTER_STATE_DIR = state;
    delete process.env.KIMI_CODEX_STATE_DIR;
    assert.equal(discoverSourceRoot(), realpathSync(owner));
  } finally {
    if (priorRoot === undefined) delete process.env.CODEX_ROUTER_SOURCE_ROOT;
    else process.env.CODEX_ROUTER_SOURCE_ROOT = priorRoot;
    if (priorModelState === undefined) delete process.env.MODEL_ROUTER_STATE_DIR;
    else process.env.MODEL_ROUTER_STATE_DIR = priorModelState;
    if (priorState === undefined) delete process.env.CODEX_ROUTER_STATE_DIR;
    else process.env.CODEX_ROUTER_STATE_DIR = priorState;
    if (priorKimiState === undefined) delete process.env.KIMI_CODEX_STATE_DIR;
    else process.env.KIMI_CODEX_STATE_DIR = priorKimiState;
    await rm(owner, { recursive: true, force: true });
    await rm(state, { recursive: true, force: true });
  }
});

test("control center refuses mutations across app/control protocol skew", async () => {
  const owner = await mkdtemp(path.join(os.tmpdir(), "router-control-contract-"));
  try {
    await mkdir(path.join(owner, "src"), { recursive: true });
    await mkdir(path.join(owner, "bin"), { recursive: true });
    await writeFile(path.join(owner, "src", "control.mjs"), "", { mode: 0o700 });
    await writeFile(path.join(owner, "bin", "control"), "#!/bin/sh\n", { mode: 0o700 });
    assert.throws(() => assertMutationCompatibility(owner), /same build/);

    const bundled = JSON.parse(await readFile(new URL("../apps/control-center/package.json", import.meta.url), "utf8"));
    await mkdir(path.join(owner, "apps", "control-center"), { recursive: true });
    await writeFile(
      path.join(owner, "apps", "control-center", "package.json"),
      JSON.stringify({ version: bundled.version, controlProtocol: bundled.controlProtocol }),
      { mode: 0o600 },
    );
    assert.doesNotThrow(() => assertMutationCompatibility(owner));

    await writeFile(
      path.join(owner, "apps", "control-center", "package.json"),
      JSON.stringify({ version: "0.0.0", controlProtocol: bundled.controlProtocol }),
      { mode: 0o600 },
    );
    assert.throws(() => assertMutationCompatibility(owner), /same build/);
  } finally {
    await rm(owner, { recursive: true, force: true });
  }
});

test("trusted install provenance overrides contradictory package-manager environment", async () => {
  const owner = await mkdtemp(path.join(os.tmpdir(), "router-control-owner-"));
  const state = await mkdtemp(path.join(os.tmpdir(), "router-control-state-"));
  const environmentKeys = [
    "CODEX_ROUTER_SOURCE_ROOT",
    "MODEL_ROUTER_SOURCE_ROOT",
    "MODEL_ROUTER_STATE_DIR",
    "CODEX_ROUTER_STATE_DIR",
    "KIMI_CODEX_STATE_DIR",
    "CODEX_ROUTER_PACKAGE_MANAGER",
  ];
  const prior = new Map(environmentKeys.map((key) => [key, process.env[key]]));
  const writeManifest = (packageManager) => writeFile(
    path.join(state, "install-manifest.json"),
    JSON.stringify({ version: 1, current: { sourceRoot: owner, packageManager } }),
    { mode: 0o600 },
  );
  try {
    await mkdir(path.join(owner, "src"), { recursive: true });
    await mkdir(path.join(owner, "bin"), { recursive: true });
    await writeFile(
      path.join(owner, "src", "control.mjs"),
      "process.stdout.write(JSON.stringify({ packageManager: process.env.CODEX_ROUTER_PACKAGE_MANAGER ?? null }));\n",
      { mode: 0o700 },
    );
    await writeFile(path.join(owner, "bin", "control"), "#!/bin/sh\n", { mode: 0o700 });
    process.env.CODEX_ROUTER_SOURCE_ROOT = owner;
    delete process.env.MODEL_ROUTER_SOURCE_ROOT;
    process.env.MODEL_ROUTER_STATE_DIR = state;
    delete process.env.CODEX_ROUTER_STATE_DIR;
    delete process.env.KIMI_CODEX_STATE_DIR;
    process.env.CODEX_ROUTER_PACKAGE_MANAGER = "contradictory";

    await writeManifest("homebrew");
    assert.equal((await runControlJson()).packageManager, "homebrew");
    await writeManifest(null);
    assert.equal((await runControlJson()).packageManager, null);
  } finally {
    for (const [key, value] of prior) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(owner, { recursive: true, force: true });
    await rm(state, { recursive: true, force: true });
  }
});

test("electron boundary does not enable node integration or shell argv", async () => {
  const preload = await readFile(new URL("../apps/control-center/electron/preload.cjs", import.meta.url), "utf8");
  assert.match(preload, /contextBridge\.exposeInMainWorld\("routerControl"/);
  assert.match(preload, /require\("electron"\)/);
  assert.doesNotMatch(preload, /executeJavaScript|node:child_process|node:fs|node:path/);
  const main = await readFile(new URL("../apps/control-center/electron/main.mjs", import.meta.url), "utf8");
  assert.match(main, /contextIsolation:\s*true/);
  assert.match(main, /nodeIntegration:\s*false/);
  assert.match(main, /sandbox:\s*true/);
  assert.match(main, /frame:\s*process\.platform\s*!==\s*"darwin"/);
  assert.match(main, /titleBarStyle:\s*"hiddenInset"/);
  assert.match(main, /trafficLightPosition:\s*\{\s*x:\s*16,\s*y:\s*16\s*\}/);
  assert.match(main, /icon:\s*appIconPath\(\)/);
  assert.match(main, /app\.dock\?\.setIcon\(appIconPath\(\)\)/);
  assert.match(main, /CODEX_ROUTER_USER_VISIBLE_CONTROL_CENTER/);
  assert.match(main, /app\.dock\?\.show\(\)/);
  assert.match(main, /setWindowOpenHandler\(\(\) => \(\{ action: "deny" \}\)\)/);
  assert.match(main, /if \(app\.isPackaged \|\| !requested\)/);
  assert.match(main, /\["127\.0\.0\.1", "localhost", "\[::1\]"\]\.includes\(parsed\.hostname\)/);
  assert.match(main, /event\.senderFrame !== event\.sender\.mainFrame/);
  assert.match(main, /setPermissionCheckHandler\(\(\) => false\)/);
  assert.match(main, /setPermissionRequestHandler\([\s\S]*callback\(false\)/);
  assert.match(main, /requestSingleInstanceLock\(\)/);
  assert.match(main, /app\.on\("second-instance"/);
  assert.match(main, /else openRequests\.requestOpen\(\)/);
  assert.match(main, /new Tray\(/);
  assert.match(main, /createdTray\.on\("click", showWindow\)/);
  assert.match(main, /Open Control Center/);
  assert.match(main, /CODEX_ROUTER_EMBEDDED_CONTROL_CENTER/);
  assert.match(main, /image\.isEmpty\(\)[\s\S]*tray icon could not be loaded/);
  assert.match(main, /const trayAvailable = trayIsAvailable\(\)/);
  assert.match(main, /process\.platform === "linux"[\s\S]{0,100}linuxStatusNotifierHostAvailable\(\)/);
  assert.doesNotMatch(main, /nativeImage\.createEmpty\(\)/);
  assert.match(
    main,
    /if \(!trayOnlyInvocation \|\| !trayAvailable\) openRequests\.requestOpen\(\);\s*createWindow\(\);/,
  );
  assert.doesNotMatch(main, /if \(trayAvailable\)[\s\S]{0,100}completeApplicationReadiness\(\)/);
  assert.match(main, /webContents\.once\("did-finish-load"/);
  assert.match(main, /createdWindow\.once\("ready-to-show"/);
  assert.match(main, /webContents\.once\([\s\S]{0,80}"did-fail-load"/);
  assert.match(main, /rendererReady\.didFailLoad/);
  assert.match(main, /app\.exit\(1\)/);
  assert.match(main, /commandLine\.includes\("--quit-for-update"\)/);
  assert.match(main, /shouldQuitOnLastWindowClosed\([\s\S]{0,120}app\.quit\(\)/);
  assert.match(main, /LIFECYCLE_QUERY_ARGUMENT/);
  assert.match(main, /queryLifecycleState\(lifecycleFile\)/);
  assert.match(main, /createdWindow\.on\("hide"[\s\S]{0,140}windowVisible = false/);
  assert.match(main, /app\.on\("will-quit"[\s\S]{0,160}applicationReady = false/);
  assert.match(main, /app\.on\("before-quit"/);
  assert.match(main, /mutationLifecycle\.hasActiveMutations\(\)/);
  assert.match(main, /mutationLifecycle\.whenMutationsIdle\(\)/);
  assert.match(main, /script-src 'self' 'sha256-Z2\/iFzh9VMlVkEOar1f\/oSHWwQk3ve1qk\/C2WdsC4Xk='/);
  assert.doesNotMatch(main, /script-src[^;]*'unsafe-inline'/);
  const builder = await readFile(new URL("../apps/control-center/electron-builder.yml", import.meta.url), "utf8");
  assert.match(builder, /extraResources:[\s\S]*icon\.png/);
  assert.match(builder, /runAsNode:\s*true/);
  assert.match(builder, /enableEmbeddedAsarIntegrityValidation:\s*true/);
  assert.match(builder, /onlyLoadAppFromAsar:\s*true/);
  assert.match(builder, /mac:[\s\S]*target:\s*\[dmg, zip\]/);
  assert.match(builder, /linux:[\s\S]*executableName:\s*codex-router-control-center[\s\S]*target:\s*\[AppImage\]/);
  assert.match(builder, /win:[\s\S]*target:\s*\[nsis\]/);
  const compatibilityMain = await readFile(new URL("../apps/control-center/main.mjs", import.meta.url), "utf8");
  assert.match(compatibilityMain, /import "\.\/electron\/main\.mjs"/);
  assert.doesNotMatch(compatibilityMain, /BrowserWindow|ipcMain|registerIpcHandlers/);
  const renderer = await readFile(new URL("../apps/control-center/src/App.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(renderer, /WindowControls|traffic-lights|window-control/);
  assert.match(renderer, /native-titlebar/);
  const styles = await readFile(new URL("../apps/control-center/src/styles.css", import.meta.url), "utf8");
  assert.doesNotMatch(styles, /traffic-lights|window-control|window-close|window-minimize|window-maximize/);
  assert.match(styles, /native-titlebar/);
  assert.match(styles, /native-titlebar\.sidebar-collapsed \.titlebar[\s\S]*padding-left:\s*88px/);
  assert.doesNotMatch(renderer, /drag-region|no-drag/);
  assert.match(styles, /-webkit-app-region:\s*drag/);
  assert.match(styles, /-webkit-app-region:\s*no-drag/);
  for (const label of ["Close window", "Minimize window", "Maximize or restore window"]) {
    assert.doesNotMatch(renderer, new RegExp(`aria-label=\\"${label}\\"`));
  }
  const runner = await readFile(new URL("../apps/control-center/electron/command-runner.mjs", import.meta.url), "utf8");
  assert.match(runner, /shell:\s*false/);
  assert.doesNotMatch(runner, /shell:\s*true/);
  assert.match(runner, /detached:\s*process\.platform !== "win32"/);
  assert.match(runner, /process\.kill\(-child\.pid, "SIGKILL"\)/);
  assert.match(runner, /\["\/PID", String\(child\.pid\), "\/T", "\/F"\]/);
});

test("control center package version follows the router beta", async () => {
  const routerPackage = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  const appPackage = JSON.parse(await readFile(new URL("../apps/control-center/package.json", import.meta.url), "utf8"));
  const appLock = JSON.parse(await readFile(new URL("../apps/control-center/package-lock.json", import.meta.url), "utf8"));
  assert.equal(appPackage.version, routerPackage.version);
  assert.equal(appPackage.controlProtocol, 1);
  assert.equal(appLock.version, routerPackage.version);
  assert.equal(appLock.packages[""].version, routerPackage.version);
});

test("background usage polling is conservative while manual refresh stays immediate", async () => {
  const source = await readFile(new URL("../apps/control-center/src/App.tsx", import.meta.url), "utf8");
  assert.match(source, /usageTimer = window\.setInterval\(\(\) => void refreshUsage\(\), 5 \* 60_000\)/);
  assert.doesNotMatch(source, /usageTimer = window\.setInterval\(\(\) => void refreshUsage\(\), 30_000\)/);
  assert.match(source, /Promise\.allSettled\(\[refreshCore\(\), refreshUsage\(\)\]\)/);
  assert.match(source, /Promise\.allSettled\(\[[\s\S]*api\.getSnapshot\(\)[\s\S]*api\.getHealth\(\)/);
  assert.match(source, /downloadPollInFlight\.current/);
  assert.match(source, /localDownloadActive(?: \|\| mlxOperationActive)? \? api\.getLocalModels\(\)/);
  assert.match(source, /visionDownloadActive \? api\.getVisionBridge\(\)/);
  assert.match(source, /downloadTimer = window\.setInterval\(\(\) => void refreshDownloadProgress\(\), 4_000\)/);
  assert.doesNotMatch(source, /downloadTimer = window\.setInterval\([\s\S]{0,160}refreshCore/);
});

test("preload exposes only the named control operations", async () => {
  const source = await readFile(new URL("../apps/control-center/electron/preload.cjs", import.meta.url), "utf8");
  for (const method of [
    "getSnapshot",
    "getChatGptAccountPool",
    "getHarnesses",
    "getContextSessions",
    "minimizeWindow",
    "toggleMaximizeWindow",
    "closeWindow",
    "setProviderEnabled",
    "discoverProviderModels",
    "addProviderModels",
    "connectProvider",
    "saveProviderCredential",
    "setSubagentEffort",
    "controlLocalRuntime",
    "installLocalMlx",
    "cancelLocalMlx",
    "setVisionBridgeEngine",
    "downloadVisionModel",
    "useLocalVisionModel",
    "benchmarkVisionModel",
    "setDefaultModel",
    "repairInstall",
    "launchHarness",
    "installHarness",
    "openHarnessSession",
    "openExternal",
  ]) {
    assert.match(source, new RegExp(`${method}\\s*:`));
  }
  assert.doesNotMatch(source, /runCommand|exec|spawn|argv/);
  assert.doesNotMatch(source, /runMaintenance/);
  assert.doesNotMatch(source, /setLoginFree/);
  assert.doesNotMatch(source, /typeof\s+\w+\s*===\s*"object"/);
});

test("preload constructs exact positional IPC payloads", async () => {
  const source = await readFile(new URL("../apps/control-center/electron/preload.cjs", import.meta.url), "utf8");
  const calls = [];
  let api;
  vm.runInNewContext(source, {
    process: { platform: "linux" },
    require(specifier) {
      assert.equal(specifier, "electron");
      return {
        contextBridge: {
          exposeInMainWorld(name, value) {
            assert.equal(name, "routerControl");
            api = value;
          },
        },
        ipcRenderer: {
          invoke: async (channel, input) => { calls.push([channel, input]); },
          on() {},
          removeListener() {},
        },
      };
    },
  });
  const cases = [
    ["getChatGptAccountPool", [], null],
    ["discoverProviderModels", ["provider"], { providerId: "provider", refresh: false }],
    ["discoverProviderModels", ["provider", { refresh: true }], { providerId: "provider", refresh: true }],
    ["setProviderEnabled", ["provider", false], { providerId: "provider", enabled: false }],
    ["addProviderModels", ["provider", ["model-a", "model-b"]], { providerId: "provider", modelIds: ["model-a", "model-b"] }],
    ["connectProvider", ["provider"], { providerId: "provider" }],
    ["saveProviderCredential", ["provider", "credential"], { providerId: "provider", credential: "credential" }],
    ["removeProviderCredential", ["provider"], { providerId: "provider" }],
    ["setSubagentMode", ["proven"], { mode: "proven" }],
    ["setSubagentModel", ["model", true], { slug: "model", enabled: true }],
    ["setSubagentEffort", ["model", "xhigh"], { slug: "model", effort: "xhigh" }],
    ["setSubagentSelection", [false], { selectAll: false }],
    ["setPickerModel", ["model", false], { slug: "model", visible: false }],
    ["setPickerModels", [true], { showAll: true }],
    ["installLocalModel", ["model:latest", true], { tag: "model:latest", force: true, yes: true }],
    ["uninstallLocalModel", ["model:latest"], { tag: "model:latest" }],
    ["setLocalModelEnabled", ["model:latest", false], { tag: "model:latest", enabled: false }],
    ["benchmarkLocalModel", ["model:latest"], { tag: "model:latest" }],
    ["controlLocalRuntime", ["start"], { action: "start" }],
    ["installLocalMlx", [], { yes: true }],
    ["cancelLocalMlx", [], null],
    ["setVisionBridgeEnabled", [true], { enabled: true }],
    ["setVisionBridgeEngine", ["auto", "high"], { engine: "auto", effort: "high" }],
    ["setVisionBridgeEffort", ["high"], { effort: "high" }],
    ["downloadVisionModel", ["vision:latest"], { tag: "vision:latest" }],
    ["useLocalVisionModel", ["vision:latest"], { tag: "vision:latest" }],
    ["benchmarkVisionModel", ["vision:latest"], { tag: "vision:latest" }],
    ["setToolResultAging", [true], { enabled: true }],
    ["setNativeToolResultAging", [false], { enabled: false }],
    ["setToolResultRetentionTtl", [7], { days: 7 }],
    ["setDefaultModel", ["model"], { slug: "model" }],
    ["setSignedRouting", [false], { enabled: false }],
    ["addChatGptSubscriptionAccount", ["Work"], { label: "Work" }],
    ["loginChatGptSubscriptionAccount", ["acct_example_123456"], { accountId: "acct_example_123456" }],
    ["removeChatGptSubscriptionAccount", ["acct_example_123456"], { accountId: "acct_example_123456" }],
    ["setChatGptAccountPoolEnabled", [true], { enabled: true }],
    ["setChatGptAccountPoolMode", ["pool"], { mode: "pool" }],
    ["setChatGptAccountPoolStrategy", ["round-robin"], { strategy: "round-robin" }],
    ["setChatGptAccountSelection", ["acct_example_123456"], { selection: "acct_example_123456" }],
    ["setPresence", ["always"], { mode: "always" }],
    ["controlService", ["start"], { action: "start" }],
    ["controlTray", ["status"], { action: "status" }],
    ["launchHarness", ["codex", "app"], { harnessId: "codex", surface: "app" }],
    ["installHarness", ["deepcode"], { harnessId: "deepcode" }],
    ["openHarnessSession", ["codex", "session", "terminal", "model"], { harnessId: "codex", sessionId: "session", surface: "terminal", model: "model" }],
    ["openExternal", ["https://example.com"], { url: "https://example.com" }],
  ];
  for (const [method, args, expected] of cases) {
    await api[method](...args);
    const actual = calls.shift();
    assert.deepEqual(
      JSON.parse(JSON.stringify(actual)),
      [`router-control:${method}`, expected],
      method,
    );
  }
  assert.equal(calls.length, 0);
});

// The Control Center and the tray render the same health report through two
// separate implementations, so the pair has to be checked, not just one half
// (#366). apps/panel/model.mjs is exercised directly in
// test/panel-ui.test.mjs; this is the TypeScript twin.
test("the control center health rows match the tray's on absent and Grok dependencies", async () => {
  const source = await readFile(new URL("../apps/control-center/src/service-health.ts", import.meta.url), "utf8");

  // A router that answered `ok` has already probed every dependency it knows
  // about, so an id missing from `degraded` is Ready rather than Unknown.
  assert.match(source, /routerOk\?: boolean/);
  assert.match(source, /if \(!offline && routerOk === true\) \{[\s\S]*?state: "ready"/);
  assert.match(source, /dependencyRow\("gateway", "Gateway", health\?\.gateway, degraded, routerOk\)/);

  // The Grok OAuth forwarder is a fifth local port with its own probe, and
  // both surfaces enumerate forwarders explicitly, so it has to be listed.
  assert.match(source, /\["grokOauth", "Grok OAuth forwarder"\]/);
  const types = await readFile(new URL("../apps/control-center/src/types.ts", import.meta.url), "utf8");
  assert.match(types, /grokOauth\?: RouterServiceHealth;/);
});

test("control center sidebar keeps the requested product order", async () => {
  const source = await readFile(new URL("../apps/control-center/src/App.tsx", import.meta.url), "utf8");
  const navBlock = source.match(/const NAV_ITEMS:[\s\S]*?= \[([\s\S]*?)\n\];/)?.[1];
  assert.ok(navBlock, "NAV_ITEMS block should be readable");
  const ids = [...navBlock.matchAll(/id: "([^"]+)"/g)].map((match) => match[1]);
  assert.deepEqual(ids, ["dashboard", "usage", "status", "models", "local", "harness", "context", "settings"]);
  assert.doesNotMatch(navBlock, /deferred|Soon/);
  assert.match(navBlock, /label: "Models"/);

  const status = await readFile(new URL("../apps/control-center/src/pages/StatusPage.tsx", import.meta.url), "utf8");
  // Settings remains the only page that renders the diagnostic report; Status
  // may start a repair but must not grow a doctor surface of its own.
  assert.doesNotMatch(status, /doctor/i);
  assert.match(status, /api\.repairInstall\(\)/);
  assert.match(status, /<ServiceHealthPanel[^>]*onRepair=/);

  // Repair is offered on this panel only while a service actually needs it, so
  // a healthy router never shows a maintenance button beside its green badge.
  const serviceHealth = await readFile(new URL("../apps/control-center/src/ServiceHealth.tsx", import.meta.url), "utf8");
  assert.match(serviceHealth, /\{onRepair && attention \?/);

  const usage = await readFile(new URL("../apps/control-center/src/pages/UsagePage.tsx", import.meta.url), "utf8");
  assert.match(usage, /ChatGPT · measured by this router/);
  assert.match(usage, /ChatGPT account · reported by OpenAI/);
  assert.match(usage, /excludes account usage/);
  assert.match(usage, /This router total is the sum of every measured provider row/);
  assert.match(usage, /Account-reported · excluded from router total/);
  assert.match(usage, /regularInputTokens/);
  assert.match(usage, /cachedInputTokens/);
  assert.match(usage, /outputTokens/);
  assert.match(usage, /All retained/);
  assert.match(usage, /scopeLabel/);
  assert.match(usage, /is-regular/);
  assert.match(usage, /is-cached/);
  assert.match(usage, /is-output/);
  assert.match(usage, /ChartTooltip/);
  assert.match(usage, /aria-label=\{label\}/);
  assert.match(usage, /Regular input|regular input/);
  const usageStyles = await readFile(new URL("../apps/control-center/src/pages/usage-status.css", import.meta.url), "utf8");
  assert.match(usageStyles, /--token-regular/);
  assert.match(usageStyles, /--token-cached/);
  assert.match(usageStyles, /--token-output/);
  assert.match(usageStyles, /\.us-token-mix > div \{[\s\S]*border-right/);
  assert.doesNotMatch(usageStyles, /\.us-token-mix > div \{[^}]*border-radius/);
  assert.match(usageStyles, /\.us-chart-tooltip/);
  assert.match(usageStyles, /white-space: normal|text-transform: capitalize/);
  assert.match(usageStyles, /data-edge="start"|data-edge/);
  const dashboard = await readFile(new URL("../apps/control-center/src/pages/DashboardPage.tsx", import.meta.url), "utf8");
  assert.match(dashboard, /db-trend-stack/);
  assert.match(dashboard, /TrafficTooltip/);
  assert.match(dashboard, /tabIndex=\{0\}/);
  assert.match(dashboard, /Token activity/);
  assert.match(dashboard, /TOKEN_ACTIVITY_WEEKS = 53/);
  assert.match(dashboard, /providerUsage\?\.retained\?\.providers/);
  assert.match(dashboard, /\["daily", "weekly", "cumulative"\]/);
  assert.match(dashboard, /role="gridcell"/);
  assert.match(dashboard, /db-token-tooltip/);
  assert.doesNotMatch(dashboard, /title="Routing mode"/);
  assert.doesNotMatch(dashboard, /Credentials on file and routes in use/);
  assert.doesNotMatch(dashboard, /title="Catalog readiness"/);
  assert.doesNotMatch(dashboard, /title="Context reused, 24h"/);
  const dashboardStyles = await readFile(new URL("../apps/control-center/src/pages/dashboard.css", import.meta.url), "utf8");
  assert.match(dashboardStyles, /--token-regular/);
  assert.match(dashboardStyles, /--token-cached/);
  assert.match(dashboardStyles, /--token-output/);
  assert.match(dashboardStyles, /\.db-trend-tooltip/);
  assert.match(dashboardStyles, /\.db-token-cells/);
  assert.match(dashboardStyles, /grid-template-columns: repeat\(53, minmax\(var\(--db-token-min-cell\), 1fr\)\)/);
  assert.match(dashboardStyles, /\.db-token-day\.level-4/);
  assert.match(dashboardStyles, /\.db-token-tooltip/);
  assert.match(dashboardStyles, /border-radius: 0/);
});

test("settings keeps model choice out and exposes durable app preferences", async () => {
  const settings = await readFile(new URL("../apps/control-center/src/pages/SettingsPage.tsx", import.meta.url), "utf8");
  // Default model selection belongs to the catalog page. Settings owns the
  // router switches and renderer-local preferences, so it must not grow a
  // second model-choice control as the catalog evolves.
  assert.doesNotMatch(settings, /setDefaultModel|default model/i);
  assert.match(settings, /settings\.language\.title/);
  assert.match(settings, /settings\.context\.enable\.title/);
  assert.match(settings, /settings\.vision\.title/);
  assert.match(settings, /setToolResultAging\(/);
  assert.match(settings, /setNativeToolResultAging\(/);
  assert.match(settings, /setToolResultRetentionTtl\(/);
  assert.match(settings, /setVisionBridgeEnabled\(/);
  assert.match(settings, /setVisionBridgeEngine\(/);
  assert.match(settings, /setVisionBridgeEffort\(/);
  assert.match(settings, /ChatGPT subscription pool/);
  assert.match(settings, /subscription-account-row/);
  assert.match(settings, /No saved ChatGPT accounts/);
  assert.match(settings, /addChatGptSubscriptionAccount\(/);
  assert.match(settings, /loginChatGptSubscriptionAccount\(/);
  assert.match(settings, /removeChatGptSubscriptionAccount\(/);
  assert.doesNotMatch(settings, /access_token|refresh_token/);
  assert.doesNotMatch(settings, /runMaintenance/);
  assert.doesNotMatch(settings, /setLoginFree/);
  // Repair used to be terminal-only. It is an in-app button now, but it still
  // reinstalls and restarts the service, so it stays behind a confirmation and
  // it must not become a one-click control that fires on the first press.
  assert.match(settings, /api\.repairInstall\(\)/);
  assert.match(settings, /setConfirmRepair\(true\)/);
  assert.match(settings, /settings\.maintenance\.confirm\.body/);
  assert.doesNotMatch(settings, /controlService\("(?:stop|restart)"\)/);

  const i18n = await readFile(new URL("../apps/control-center/src/i18n.ts", import.meta.url), "utf8");
  assert.match(i18n, /settings\.language\.title/);
  assert.match(i18n, /settings\.context\.enable\.title/);
  assert.match(i18n, /settings\.vision\.title/);
  assert.doesNotMatch(i18n, /settings\.routing\.modelNote/);
  // Every locale is an overlay over EN, so a repair string that only exists in
  // English silently renders English inside an otherwise translated dialog.
  for (const key of [
    "settings.maintenance.fixRunning",
    "settings.maintenance.fixDone",
    "settings.maintenance.fixIncomplete",
    "settings.maintenance.confirm.title",
    "settings.maintenance.confirm.body",
  ]) {
    const occurrences = i18n.split(`"${key}"`).length - 1;
    assert.equal(occurrences, 6, `${key} must be translated in all six locales`);
  }
  // Sharing is an authorization to spend the user's subscription, so its
  // confirmation and live state cannot silently fall back to English.
  for (const key of [
    "settings.chatgptSession.title",
    "settings.chatgptSession.detail",
    "settings.chatgptSession.confirm.title",
    "settings.chatgptSession.confirm.description",
    "settings.chatgptSession.confirm.body",
    "settings.chatgptSession.confirm.enable",
    "settings.chatgptSession.status.sharingEnabled",
    "settings.chatgptSession.status.sharingDisabled",
    "settings.chatgptSession.status.unavailable",
    "settings.chatgptSession.status.loginUsable",
    "settings.chatgptSession.status.loginUsableHours",
    "settings.chatgptSession.status.loginExpired",
    "settings.chatgptSession.status.loginUnavailableDetected",
    "settings.chatgptSession.status.loginUnavailableLogin",
    "settings.chatgptSession.action.enable",
    "settings.chatgptSession.action.disable",
  ]) {
    const occurrences = i18n.split(`"${key}"`).length - 1;
    assert.equal(occurrences, 6, `${key} must be translated in all six locales`);
  }
  for (const key of [
    "settings.desktop.unavailable.title",
    "settings.desktop.unavailable.body",
  ]) {
    const occurrences = i18n.split(`"${key}"`).length - 1;
    assert.equal(occurrences, 6, `${key} must be translated in all six locales`);
    assert.ok(settings.includes(`t("${key}")`), `${key} must be rendered through the translator`);
  }
  assert.doesNotMatch(settings, /["`]Sharing (?:enabled|disabled|status unavailable)/);
  assert.doesNotMatch(settings, /["`]Login (?:usable|expired|unavailable)/);
  assert.doesNotMatch(settings, /Tray supervision controls unavailable|no supported OS supervision contract/);
});

test("the model directory combines provider setup with de-duplicated model-family routes", async () => {
  const models = await readFile(new URL("../apps/control-center/src/pages/ModelsPage.tsx", import.meta.url), "utf8");
  const catalogSearch = await readFile(new URL("../apps/control-center/src/model-catalog-search.mjs", import.meta.url), "utf8");
  const providerModelsCss = await readFile(new URL("../apps/control-center/src/pages/providers-models.css", import.meta.url), "utf8");
  assert.match(models, /aria-expanded=\{expanded\}/);
  assert.match(models, /aria-controls=\{panelId\}/);
  assert.match(models, /hidden=\{!expanded\}/);
  assert.match(models, /setExpandedProviderId\(expanded \? null : entry\.id\)/);
  assert.match(models, /className="pm-provider-detail"[\s\S]*className="pm-provider-connection"[\s\S]*className="pm-model-list"/);
  assert.match(models, /saveProviderCredential/);
  assert.match(models, /setProviderEnabled/);
  assert.match(models, /setPickerModel/);
  assert.match(models, /"Show all router models", \(\) => api\.setPickerModels\(true\)/);
  assert.match(models, />Show all<\/Button>/);
  assert.match(models, />Hide all<\/Button>/);
  assert.match(models, /invalidateCatalogs\(\);[\s\S]{0,180}try \{[\s\S]*finally \{\s*invalidateCatalogs\(\)/);
  assert.match(models, /const generation = beginCatalogRequest/);
  assert.match(models, /catalogRequestIsCurrent\(catalogRequestGenerations\.current, sourceId, generation\)/);

  // Adding republishes the whole catalog to every installed client and is the
  // slowest thing this page starts. Placeholder rows carrying the chosen slugs
  // stand in meanwhile, or the click reads as having done nothing at all.
  assert.match(models, /setPendingModels\(\(current\) => addPendingCatalogModels\(current, entry\.id, selected\)\)/);
  assert.match(models, /<PendingModelRows slugs=\{pending\} \/>/);
  assert.match(models, /Adding to the picker/);
  // Cleared in a finally: a placeholder surviving a failed add would claim the
  // model arrived.
  assert.match(models, /\} finally \{[\s\S]{0,400}setPendingModels\(/);
  // A slug already in the picker gets no ghost row beside its real one.
  assert.match(models, /pendingCatalogModelIds\(pendingModels, entry\.id\)[\s\S]{0,160}!entry\.models\.some/);
  assert.match(models, /removePendingCatalogModels\(current, entry\.id, selected\)/);
  // The placeholder must hold the real row's geometry so the list does not jump
  // when the add lands.
  assert.match(providerModelsCss, /\.pm-model-row-pending/);
  assert.match(providerModelsCss, /\.pm-pending-control/);
  assert.match(models, /setSubagentModel/);
  assert.match(models, /setSubagentEffort/);
  assert.match(models, /<Badge tone="accent">Subagent<\/Badge>/);
  assert.match(models, /subagent thinking effort/);
  assert.match(models, /<option value="default">Model default<\/option>/);
  assert.match(providerModelsCss, /\.pm-model-row\[data-subagent="enabled"\]/);
  assert.match(models, /<strong>\{family\.displayName\}<\/strong>/);
  assert.match(models, /<strong>\{providerName\}<\/strong>/);
  assert.match(models, /groupModelFamilies\(models\)/);
  assert.match(models, /One model row\. Expand it only when you need to choose a provider route\./);
  assert.match(models, /These routes use different credentials, quotas, and provider policies\./);
  assert.match(models, /setExpandedFamilyId\(expanded \? null : family\.id\)/);
  assert.match(models, /discoverProviderModels/);
  assert.match(models, /addProviderModels/);
  assert.match(models, /<Badge tone="accent">\{entry\.models\.length\} active/);
  assert.doesNotMatch(models, /providerUsage\?\.requests \|\| 0/);
  assert.match(models, /\{providerUsage\?\.requests \? <small className="pm-provider-requests">/);
  assert.match(models, /providerUsage\.requests === 1 \? "request" : "requests"/);
  assert.match(providerModelsCss, /\.pm-provider-tags\s*\{[^}]*flex-wrap:\s*nowrap;/s);
  assert.match(models, /\{ label: "Models", value: modelFamilies\.length, detail: `\$\{enabledCount\} provider routes` \}/);
  assert.match(models, /className="pm-provider-toolbar-primary"/);
  assert.match(models, /className="pm-provider-toolbar-actions"/);
  assert.match(models, /className="pm-filter-trigger"/);
  assert.match(models, /aria-haspopup="menu"/);
  assert.match(models, /role="menuitemradio"/);
  assert.doesNotMatch(models, /className="segmented-control compact"/);
  assert.doesNotMatch(models, /Default routed model/);
  assert.doesNotMatch(models, /Subagent catalog/);
  assert.doesNotMatch(models, /Enabled models only/);
  assert.doesNotMatch(models, /if \(enabledModelsOnly/);
  assert.match(models, /className="pm-selected-models-heading"/);
  assert.match(models, />Provider catalog<\/strong>/);
  assert.match(models, />Model families<\/strong>/);
  assert.match(models, /catalogEligible\(entry\) && catalog \?/);
  assert.match(models, /catalog\?\.data \? "Reload catalog" : "Browse model catalog"/);
  assert.match(models, /Load connected catalogs/);
  assert.match(models, /Available from loaded catalogs/);
  assert.match(models, /publishCatalogModels\(entry, result\.sourceId, \[result\.modelId\]\)/);
  assert.match(models, /modelRouteKind\(model\)/);
  assert.match(models, /Search providers or known models/);
  assert.match(models, /Every supported provider stays visible/);
  assert.match(models, /catalogSources\.length > 1/);
  assert.match(models, /Select up to 200/);
  assert.match(models, /state\.data\.addable \?\? state\.data\.unregistered/);
  assert.match(models, /addable\.has\(id\)/);
  assert.match(models, /Protocol pending/);
  assert.match(models, /pm-catalog-block-reason/);
  assert.match(models, /Show 120 more/);
  // Opening a provider shows its stored list; only an explicit reload re-asks.
  assert.match(models, /const openProvider = \(entry: ProviderDirectoryEntry, expanded: boolean\)/);
  assert.match(models, /discoverProviderModels\(sourceId, \{ refresh \}\)/);
  assert.match(models, /onReload=\{\(\) => catalogSource && void discoverCatalog/);
  assert.match(models, /state\.data\.cached \? "saved list from" : "read"/);
  assert.match(models, /<strong>Available models<\/strong>/);
  assert.doesNotMatch(models, /Use Add models|<strong>Add models<\/strong>/);
  assert.match(providerModelsCss, /\.pm-filter-menu-wrap\s*\{/);
  assert.match(providerModelsCss, /\.pm-filter-menu\s*\{/);
  assert.doesNotMatch(providerModelsCss, /\.pm-model-layout\s*\{/);
  assert.match(models, /const effortOptions = model\.reasoningLevels \?\? \[\]/);
  assert.doesNotMatch(models, /reasoningLevels\?\.map\(\(level\) => level\.effort\)/);
  assert.doesNotMatch(models, /<dt>Available<\/dt>/);
  assert.match(models, /This list is saved locally/);
  assert.match(catalogSearch, /x-preview-f-free[^\n]+Ox Alpha Free/);

  const components = await readFile(new URL("../apps/control-center/src/components.tsx", import.meta.url), "utf8");
  assert.match(components, /export function SkeletonBlock/);
  assert.match(components, /export function CatalogSkeleton/);
  assert.match(components, /export function PanelSkeleton/);
  assert.match(components, /app-loading-skeleton/);
  assert.match(components, /createPortal\([\s\S]*document\.body\)/);
  assert.match(components, /element\.inert = true/);
  assert.match(components, /panel\.focus\(\{ preventScroll: true \}\)/);
  assert.match(components, /event\.key === "Escape"/);
  assert.match(components, /event\.key !== "Tab"/);
  assert.match(components, /previouslyFocused\?\.isConnected/);
  const appStyles = await readFile(new URL("../apps/control-center/src/styles.css", import.meta.url), "utf8");
  assert.match(appStyles, /\.skeleton-block::after/);
  assert.match(appStyles, /@keyframes skeleton-sweep/);
  assert.match(appStyles, /prefers-reduced-motion:[\s\S]*\.skeleton-block::after/);

  const branding = await readFile(new URL("../apps/control-center/src/provider-branding.tsx", import.meta.url), "utf8");
  assert.match(branding, /assets\/providers\/commandcode\.svg/);
  assert.match(branding, /commandcode:[^\n]+logoMode: "artwork"/);
  for (const asset of ["cognition", "deepreinforce", "kilo", "lmstudio", "poolside", "tencent"]) {
    assert.match(branding, new RegExp(`assets/providers/${asset}\\.svg`), `${asset} logo is not bundled`);
  }
  for (const providerId of [
    "devin-cli", "kilo-free", "kimi-api-cn", "opencode-free",
    "xiaomi-mimo", "zai-api",
  ]) {
    assert.match(branding, new RegExp(`"${providerId}":`), `${providerId} falls back to a monogram`);
  }
  assert.match(branding, /"lmstudio": "lmstudio"/);
  assert.match(branding, /ornith[^\n]+BRANDS\.deepreinforce/);
  assert.match(branding, /hy3[^\n]+BRANDS\.tencent/);
  assert.match(branding, /laguna[^\n]+BRANDS\.poolside/);
  assert.match(branding, /export function brandForLocalModel/);
  const sources = await readFile(new URL("../apps/control-center/src/assets/providers/SOURCES.md", import.meta.url), "utf8");
  assert.match(sources, /commandcode\.ai\/brand/);
  assert.match(sources, /CommandCodeAI\/command-code[^\s|]+\/symbol\.svg/);
  assert.match(sources, /lmstudio\.ai\/brand/);
  assert.match(sources, /CognitionAI\/devin-extension[^|]+devin-full-color\.png/);
  assert.match(sources, /ornith-ai\/Ornith-1[^|]+ornith_logo\.png/);
  assert.doesNotMatch(sources, /avatars\.githubusercontent\.com/);
  assert.match(branding, /cognition:[^\n]+name: "Devin"/);
  assert.match(branding, /deepreinforce:[^\n]+name: "Ornith"/);
  const local = await readFile(new URL("../apps/control-center/src/pages/LocalPage.tsx", import.meta.url), "utf8");
  assert.match(local, /brandForLocalModel/);
  assert.match(local, /<BrandLogo brand=\{brandForLocalModel\(model\)\}/);
  assert.match(local, /<BrandLogo brand=\{maker\} size="medium" \/>/);
  assert.match(local, /<span>\{maker\.name\}<\/span>/);
  assert.match(local, /<small>\{`local\/\$\{model\.tag\}`\}<\/small>/);
});

test("persisted Electron toggles render optimistic intent and reconcile failures", async () => {
  const helper = await readFile(new URL("../apps/control-center/src/useOptimisticValues.ts", import.meta.url), "utf8");
  const models = await readFile(new URL("../apps/control-center/src/pages/ModelsPage.tsx", import.meta.url), "utf8");
  const local = await readFile(new URL("../apps/control-center/src/pages/LocalPage.tsx", import.meta.url), "utf8");
  const settings = await readFile(new URL("../apps/control-center/src/pages/SettingsPage.tsx", import.meta.url), "utf8");

  // Paint intent before entering the serialized durable-write queue. The
  // wrapped action distinguishes a rejected save even though App.runAction
  // converts failures into a toast instead of rethrowing them.
  assert.ok(helper.indexOf("setOverrides((current) => new Map([...current, ...desired]))") < helper.indexOf("queue.current.catch"));
  assert.match(helper, /let saved = false;[\s\S]*await action\(\);[\s\S]*saved = true;/);
  assert.match(helper, /revisions\.current\.get\(key\) !== revision/);
  assert.match(helper, /Object\.is\(authoritative\.get\(key\), optimistic\)/);

  assert.match(models, /optimisticProviders\.mutate\(/);
  assert.match(models, /optimisticPicker\.mutateMany\(/);
  assert.match(models, /optimisticSubagents\.mutate\(/);
  assert.match(local, /optimisticLocalModels\.mutate\(/);
  assert.match(local, /optimisticVision\.mutate\(/);
  for (const key of ["signed-routing", "tool-result-aging", "native-tool-result-aging", "vision-bridge"]) {
    assert.match(settings, new RegExp(`optimisticToggles\\.mutate\\(\\"${key}\\"`));
  }
});

test("providers and models share one provider-first Models destination without tabs", async () => {
  const app = await readFile(new URL("../apps/control-center/src/App.tsx", import.meta.url), "utf8");
  const models = await readFile(new URL("../apps/control-center/src/pages/ModelsPage.tsx", import.meta.url), "utf8");
  const types = await readFile(new URL("../apps/control-center/src/types.ts", import.meta.url), "utf8");
  const viewType = types.match(/export type ViewId =[\s\S]*?;/)?.[0] || "";

  assert.match(app, /case "models": return <ModelsPage/);
  assert.doesNotMatch(app, /case "providers"|ProvidersModelsPage|ProvidersPage/);
  assert.match(viewType, /\| "models"/);
  assert.doesNotMatch(viewType, /\| "providers"/);
  assert.doesNotMatch(models, /role="tablist"|role="tabpanel"|pm-section-switcher/);
  assert.match(app, /stored === "models" \|\| stored === "providers"/);
  assert.match(app, /focusRequest=\{modelFocusRequest\}/);
  assert.match(models, /model-provider-directory/);
  assert.match(models, /model-catalog-controls/);
  const dashboard = await readFile(new URL("../apps/control-center/src/pages/DashboardPage.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(dashboard, /onNavigate\("models", "providers"\)/);
  assert.doesNotMatch(dashboard, /onNavigate\("models", "models"\)/);
});

test("control center focus feedback uses state changes without focus rings", async () => {
  const styleUrls = [
    "../apps/control-center/src/styles.css",
    "../apps/control-center/src/pages/dashboard.css",
    "../apps/control-center/src/pages/providers-models.css",
    "../apps/control-center/src/pages/usage-status.css",
    "../apps/control-center/src/search-dialog.css",
  ];
  const styles = (await Promise.all(styleUrls.map((url) => readFile(new URL(url, import.meta.url), "utf8")))).join("\n");

  assert.doesNotMatch(styles, /outline:\s*2px/);
  assert.doesNotMatch(styles, /box-shadow:\s*0 0 0/);
  assert.match(styles, /:where\(button, \[tabindex\]\):focus-visible[\s\S]*?background-color/);
  assert.match(styles, /:where\(input, select, textarea\):focus-visible[\s\S]*?border-color/);
  assert.match(styles, /\.toggle input:focus-visible \+ span[\s\S]*?border-color/);
  assert.match(styles, /\.db-trend-slot:focus-visible[\s\S]*?background/);
});

test("harness and context IPC remain fixed and session-scoped", async () => {
  const source = await readFile(new URL("../apps/control-center/electron/ipc.mjs", import.meta.url), "utf8");
  assert.match(source, /const HARNESS_IDS = \["codex", "deepcode"\]/);
  assert.match(source, /const HARNESS_SURFACES = \["app", "terminal"\]/);
  assert.match(source, /const SESSION_UUID = \/\^\[0-9a-f\]/);
  assert.match(source, /const DEEPCODE_PACKAGE = "@vegamo\/deepcode-cli"/);
  assert.match(source, /oneOf\(harnessId, HARNESS_IDS, "Harness"\)/);
  assert.match(source, /stringValue\(sessionId, "Session", SESSION_UUID\)/);
  assert.match(source, /codex:\/\/threads\/\$\{id\}/);
  assert.doesNotMatch(source, /readFileSync\(deepcodeSettings/);
  const chatgptLogin = source.match(/handleAction\("loginChatGptSubscriptionAccount"[\s\S]*?\n  \}\);/)?.[0];
  assert.ok(chatgptLogin, "ChatGPT subscription login handler should be readable");
  assert.match(chatgptLogin, /openBrowserCommand\(codex, \["login"\]/);
  assert.match(chatgptLogin, /\["chatgpt-account-pool", "status"\]/);
  assert.match(chatgptLogin, /account\.subscription\?\.usable === true/);
  assert.match(chatgptLogin, /profileHome === primaryHome/);
  assert.match(chatgptLogin, /subscriptionLoginInFlight/);
  assert.doesNotMatch(chatgptLogin, /openTerminalCommand/);
  assert.match(source, /const CHATGPT_LOGIN_URL/);
  assert.match(source, /stdio: \["ignore", "pipe", "pipe"\]/);
  assert.match(source, /openExternal\(match\[0\]\)/);
  assert.match(source, /openExternal: shell\?\.openExternal\?\.bind\(shell\)/);
  assert.match(source, /await openBrowserCommand\(codex, \["login"\]/);
  assert.match(source, /did not provide an OAuth browser URL/);
  assert.match(source, /surface: "browser"/);

  const app = await readFile(new URL("../apps/control-center/src/App.tsx", import.meta.url), "utf8");
  assert.match(app, /api\.getChatGptSession\(\)/);
  assert.match(app, /alreadyAuthenticated/);
  const settings = await readFile(new URL("../apps/control-center/src/pages/SettingsPage.tsx", import.meta.url), "utf8");
  assert.match(settings, /filter\(\(account\) => account\.state !== "revoked"\)/);
  assert.match(settings, /account\.subscription\?\.usable === true/);
});

test("credential input stays off argv and is delivered over stdin", async () => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "router-control-center-"));
  const priorRoot = process.env.CODEX_ROUTER_SOURCE_ROOT;
  const secret = "test-only-secret-value";
  try {
    await mkdir(path.join(temporaryRoot, "src"), { recursive: true });
    await mkdir(path.join(temporaryRoot, "bin"), { recursive: true });
    await writeFile(
      path.join(temporaryRoot, "src", "control.mjs"),
      "let input = ''; for await (const chunk of process.stdin) input += chunk; process.stdout.write(JSON.stringify({ argv: process.argv.slice(2), input }));\n",
      { mode: 0o700 },
    );
    await writeFile(path.join(temporaryRoot, "bin", "control"), "#!/bin/sh\nexit 0\n", { mode: 0o700 });
    if (process.platform !== "win32") await chmod(path.join(temporaryRoot, "bin", "control"), 0o700);
    process.env.CODEX_ROUTER_SOURCE_ROOT = temporaryRoot;
    const result = await runControlJson(["credential", "demo"], { stdin: secret });
    assert.deepEqual(result.argv, ["credential", "demo"]);
    assert.equal(result.input, secret);
    assert.equal(result.argv.includes(secret), false);
  } finally {
    if (priorRoot === undefined) delete process.env.CODEX_ROUTER_SOURCE_ROOT;
    else process.env.CODEX_ROUTER_SOURCE_ROOT = priorRoot;
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("provider writes republish all installed targets and roll selection back on apply failure", async () => {
  const source = await readFile(new URL("../apps/control-center/electron/ipc.mjs", import.meta.url), "utf8");
  assert.match(source, /updateProviderSelection\(id, enabled/);
  const toggle = source.match(/async function updateProviderSelection[\s\S]*?\n}/)?.[0];
  assert.ok(toggle, "provider toggle helper should be readable");
  assert.match(toggle, /\["set-apply", id, enabled \? "on" : "off"\]/);
  assert.match(toggle, /shared by every installed[\s\S]*client/);
  assert.match(toggle, /CATALOG_MUTATION_TIMEOUT_MS/);
  assert.doesNotMatch(toggle, /\["set"|\["apply"|before\.has/);
  assert.match(source, /runJson\(\["credential", id\], \{[\s\S]{0,80}stdin: credential/);
  const save = source.match(/handleAction\("saveProviderCredential"[\s\S]*?\n  \}\);/)?.[0];
  assert.ok(save, "credential-save handler should be readable");
  assert.doesNotMatch(save, /updateProviderSelection/);
  assert.match(save, /CATALOG_MUTATION_TIMEOUT_MS/);
  const removal = source.match(/handleAction\("removeProviderCredential"[\s\S]*?\n  \}\);/)?.[0];
  assert.ok(removal, "credential-removal handler should be readable");
  assert.doesNotMatch(removal, /updateProviderSelection/);
  assert.match(removal, /\["credential", id, "--remove"\]/);
  assert.match(removal, /CATALOG_MUTATION_TIMEOUT_MS/);
  assert.match(source, /if \(requiresCompatibleRouter\) assertMutationCompatibility\(\)/);

  // Repair runs the CLI's own `doctor --fix` and takes no renderer arguments,
  // so the installer decides what is rewritten. It must stay exempt from the
  // compatibility gate: a protocol mismatch is the damage repair undoes, and
  // gating it there would withhold the fix exactly when it is needed. It also
  // must tolerate a non-zero exit, which means "repaired, checks still fail"
  // and carries the report the page needs to name them.
  const repair = source.match(/handleAction\("repairInstall"[\s\S]*?\n  \}, \{[^}]*\}\);/)?.[0];
  assert.ok(repair, "repair handler should be readable");
  assert.match(repair, /runRouterScript\("doctor\.mjs", \["--fix", "--json"\]/);
  assert.match(repair, /allowNonZero: true/);
  assert.match(repair, /REPAIR_TIMEOUT_MS/);
  assert.match(repair, /CODEX_ROUTER_DEFER_TRAY_REBUILD: "1"/);
  assert.match(repair, /\} finally \{[\s\S]*await runControlDetached/);
  assert.match(repair, /runControlDetached\(\["tray", "refresh"\]\)/);
  assert.doesNotMatch(repair, /setTimeout/);
  assert.ok(
    repair.indexOf('await runControlDetached(["tray", "refresh"])') < repair.indexOf("return response"),
    "the detached refresh must start before repair releases its mutation drain",
  );
  assert.match(repair, /requiresCompatibleRouter: false/);

  assert.doesNotMatch(source, /apply\s*=/);
  assert.doesNotMatch(source, /handleAction\("setLoginFree"/);

  // Browsing a provider is answered from its stored list, but committing a
  // model to the picker is checked against what the provider serves now: a
  // stored list old enough to name a withdrawn model would otherwise curate a
  // route that fails on its first real request.
  const add = source.match(/handleAction\("addProviderModels"[\s\S]*?\n  \}\);/)?.[0];
  assert.ok(add, "model-add handler should be readable");
  assert.match(add, /\[id, "--models", unique\.join\(","\), "--refresh", "--apply"\]/);
  assert.match(add, /CATALOG_MUTATION_TIMEOUT_MS/);

  // Replacing a credential can mean a different account with a different
  // entitlement, so neither save nor removal may leave the old list behind.
  const control = await readFile(new URL("../src/control.mjs", import.meta.url), "utf8");
  for (const handler of ["saveProviderCredential", "deleteProviderCredential"]) {
    const body = control.match(new RegExp(`async function ${handler}[\\s\\S]*?\\n}`))?.[0];
    assert.ok(body, `${handler} should be readable`);
    assert.match(body, /withProviderCatalogCacheTransaction/);
    assert.match(body, /catalog\.forget\(providerCatalogFamilyCacheIds\(providerId\)\)/);
  }
});

test("catalog-backed mutations outlive the publication-lock wait", async () => {
  const source = await readFile(new URL("../apps/control-center/electron/ipc.mjs", import.meta.url), "utf8");
  assert.match(source, /const CATALOG_MUTATION_TIMEOUT_MS = 330_000/);
  assert.match(source, /\["set-apply"[\s\S]{0,180}timeoutMs: CATALOG_MUTATION_TIMEOUT_MS/);
  assert.match(source, /handleAction\("setSubagentMode"[\s\S]{0,280}CATALOG_MUTATION_TIMEOUT_MS/);
  assert.match(source, /handleAction\("setSubagentEffort"[\s\S]{0,320}\["subagents", "effort", model, effort\][\s\S]{0,120}CATALOG_MUTATION_TIMEOUT_MS/);
  assert.match(source, /handleAction\("setPickerModel"[\s\S]{0,320}CATALOG_MUTATION_TIMEOUT_MS/);
  assert.match(source, /handleAction\("setVisionBridgeEnabled"[\s\S]{0,280}CATALOG_MUTATION_TIMEOUT_MS/);
  assert.match(source, /handleAction\("setSignedRouting"[\s\S]{0,280}CATALOG_MUTATION_TIMEOUT_MS/);
});

test("service IPC exposes only safe beta actions and start covers readiness", async () => {
  const source = await readFile(new URL("../apps/control-center/electron/ipc.mjs", import.meta.url), "utf8");
  assert.match(source, /const SERVICE_COMMANDS = \["status", "start"\]/);
  assert.match(source, /value === "start" \? 330_000 : 120_000/);
  assert.match(source, /runControl\(\["service", value\], \{ timeoutMs \}\)/);
  const api = await readFile(new URL("../apps/control-center/electron/api.d.ts", import.meta.url), "utf8");
  assert.match(api, /type ServiceAction = "status" \| "start"/);
  assert.doesNotMatch(api, /type ServiceAction =[^;]*(?:stop|restart)/);
});

test("tray mutations detach before the GUI releases its mutation drain", async () => {
  const source = await readFile(new URL("../apps/control-center/electron/ipc.mjs", import.meta.url), "utf8");
  const handler = source.match(/handleAction\("controlTray"[\s\S]*?\n  \}\);/)?.[0];
  assert.ok(handler, "controlTray handler should be readable");
  assert.match(handler, /runControlJson\(\["tray", "status"\]/);
  assert.match(handler, /status\?\.supported === false[\s\S]*throw new Error/);
  assert.match(handler, /await runControlDetached\(\["tray", value\]\)/);
  assert.match(handler, /accepted: true/);
  assert.ok(
    handler.indexOf('value === "status"') < handler.indexOf('runControlDetached(["tray", value])'),
    "only status may use the awaited tray path",
  );
});

test("detached tray acceptance is labeled started, never completed", async () => {
  const source = await readFile(new URL("../apps/control-center/src/App.tsx", import.meta.url), "utf8");
  const action = source.slice(source.indexOf("const runAction"), source.indexOf("const t = useCallback"));
  assert.match(action, /accepted[^\n]+=== true/);
  assert.match(action, /`\$\{label\} started\.`/);
  const acceptedStart = action.indexOf("if (\n        actionResult?.accepted === true");
  assert.notEqual(acceptedStart, -1, "runAction should keep a dedicated detached-acceptance branch");
  const accepted = action.slice(acceptedStart, action.indexOf("return;", acceptedStart));
  assert.doesNotMatch(accepted, /status: "completed"/);
  assert.match(source, /<Badge tone="neutral">Started<\/Badge>/);
});

test("local model mutations cover service readiness and validate consent flags", async () => {
  const source = await readFile(new URL("../apps/control-center/electron/ipc.mjs", import.meta.url), "utf8");
  assert.match(source, /typeof yes !== "boolean"/);
  assert.match(source, /typeof force !== "boolean"/);
  assert.match(source, /local-models", "install"[\s\S]{0,260}timeoutMs: 330_000/);
  assert.match(source, /local-models", "uninstall"[\s\S]{0,180}timeoutMs: 330_000/);
  assert.match(source, /local-models", "set"[\s\S]{0,240}timeoutMs: 330_000/);
});

test("one-click MLX setup stays on fixed IPC commands and polls background stages", async () => {
  const ipc = await readFile(new URL("../apps/control-center/electron/ipc.mjs", import.meta.url), "utf8");
  assert.match(ipc, /handleAction\("installLocalMlx"[\s\S]{0,300}yes !== true[\s\S]{0,220}\["local-models", "mlx-install", "--yes"\]/);
  assert.match(ipc, /handleAction\("cancelLocalMlx"[\s\S]{0,180}\["local-models", "mlx-cancel"\]/);

  const app = await readFile(new URL("../apps/control-center/src/App.tsx", import.meta.url), "utf8");
  assert.match(app, /ACTIVE_MLX_STATES = new Set\(\["preparing", "downloading", "loading", "starting-server", "verifying", "publishing"\]\)/);
  assert.match(app, /localDownloadActive \|\| mlxOperationActive \? api\.getLocalModels\(\)/);

  const page = await readFile(new URL("../apps/control-center/src/pages/LocalPage.tsx", import.meta.url), "utf8");
  assert.match(page, /title="Qwen 3\.8 27B · MLX"/);
  assert.match(page, /api\.installLocalMlx\(\)/);
  assert.match(page, /api\.cancelLocalMlx\(\)/);
  assert.match(page, /about 15 GB/);
  assert.match(page, /runtime installation, model download, and local proxy publication/);
  assert.match(page, /mlxPublished && mlx\?\.runtime\?\.served === true/);
  assert.match(page, /mlx\?\.host\?\.supported !== false/);
  assert.match(page, /Reduced guardrails; local access only/);
  assert.match(page, /progressMode === "indeterminate"/);
  assert.match(page, /ollamaMutationActive/);
  assert.doesNotMatch(page, /token.*(?:input|textarea)|(?:input|textarea).*token/i);
});

for (const mode of ["timeout", "overflow"]) {
  test(`command ${mode} terminates its full descendant process tree`, async () => {
    const root = await makeProcessTreeControlRoot();
    const pidFile = path.join(root, `${mode}.pid`);
    const priorRoot = process.env.CODEX_ROUTER_SOURCE_ROOT;
    let descendantPid;
    try {
      process.env.CODEX_ROUTER_SOURCE_ROOT = root;
      const command = runControl(
        [pidFile, mode],
        mode === "timeout" ? { timeoutMs: 250 } : { timeoutMs: 5_000, maxOutputBytes: 32 },
      );
      await assert.rejects(command, mode === "timeout" ? /timed out/ : /output exceeded/);
      descendantPid = Number.parseInt(await readFile(pidFile, "utf8"), 10);
      assert.ok(Number.isInteger(descendantPid) && descendantPid > 0);
      await waitForProcessExit(descendantPid);
    } finally {
      if (descendantPid) {
        try { process.kill(descendantPid, "SIGKILL"); } catch { /* already gone */ }
      }
      if (priorRoot === undefined) delete process.env.CODEX_ROUTER_SOURCE_ROOT;
      else process.env.CODEX_ROUTER_SOURCE_ROOT = priorRoot;
      await rm(root, { recursive: true, force: true });
    }
  });
}
