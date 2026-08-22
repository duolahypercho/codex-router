import test from "node:test";
import assert from "node:assert/strict";
import { realpathSync, symlinkSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import {
  assertMutationCompatibility,
  discoverSourceRoot,
  runControl,
  runControlJson,
  runtimeEnvironment,
  standardSourceRoots,
} from "../apps/control-center/electron/command-runner.mjs";

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
  assert.match(main, /setWindowOpenHandler\(\(\) => \(\{ action: "deny" \}\)\)/);
  assert.match(main, /if \(app\.isPackaged \|\| !requested\)/);
  assert.match(main, /\["127\.0\.0\.1", "localhost", "\[::1\]"\]\.includes\(parsed\.hostname\)/);
  assert.match(main, /event\.senderFrame !== event\.sender\.mainFrame/);
  assert.match(main, /setPermissionCheckHandler\(\(\) => false\)/);
  assert.match(main, /setPermissionRequestHandler\([\s\S]*callback\(false\)/);
  assert.match(main, /requestSingleInstanceLock\(\)/);
  assert.match(main, /app\.on\("second-instance"/);
  assert.match(main, /mainWindow\.isDestroyed\(\)\) && app\.isReady\(\)\) createWindow\(\)/);
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
});

test("the model directory combines provider setup and models in accessible single-open accordions", async () => {
  const models = await readFile(new URL("../apps/control-center/src/pages/ModelsPage.tsx", import.meta.url), "utf8");
  const providerModelsCss = await readFile(new URL("../apps/control-center/src/pages/providers-models.css", import.meta.url), "utf8");
  assert.match(models, /aria-expanded=\{expanded\}/);
  assert.match(models, /aria-controls=\{panelId\}/);
  assert.match(models, /hidden=\{!expanded\}/);
  assert.match(models, /setExpandedProviderId\(expanded \? null : entry\.id\)/);
  assert.match(models, /className="pm-provider-detail"[\s\S]*className="pm-provider-connection"[\s\S]*className="pm-model-list"/);
  assert.match(models, /saveProviderCredential/);
  assert.match(models, /setProviderEnabled/);
  assert.match(models, /setPickerModel/);
  // A router-managed OAuth file can be rejected while it still needs a
  // disconnect action. Removal must not be gated on configured status.
  assert.match(
    models,
    /\(entry\.setup\.kind === "api" && entry\.setup\.configured\) \|\| entry\.setup\.disconnectable/,
  );
  assert.doesNotMatch(models, /entry\.setup\.configured && \([^\n]*entry\.setup\.disconnectable/);

  // Adding republishes the whole catalog to every installed client and is the
  // slowest thing this page starts. Placeholder rows carrying the chosen slugs
  // stand in meanwhile, or the click reads as having done nothing at all.
  assert.match(models, /setPendingModels\(\(current\) => \(\{ \.\.\.current, \[entry\.id\]: selected \}\)\)/);
  assert.match(models, /<PendingModelRows slugs=\{pending\} \/>/);
  assert.match(models, /Adding to the picker/);
  // Cleared in a finally: a placeholder surviving a failed add would claim the
  // model arrived.
  assert.match(models, /\} finally \{[\s\S]{0,400}setPendingModels\(/);
  // A slug already in the picker gets no ghost row beside its real one.
  assert.match(models, /pendingModels\[entry\.id\] \?\? \[\][\s\S]{0,160}!entry\.models\.some/);
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
  assert.match(models, /<strong>\{model\.displayName\}<\/strong>/);
  assert.match(models, /discoverProviderModels/);
  assert.match(models, /addProviderModels/);
  assert.match(models, /<Badge tone="accent">\{entry\.models\.length\} selected<\/Badge>/);
  assert.doesNotMatch(models, /providerUsage\?\.requests \|\| 0/);
  assert.match(models, /\{providerUsage\?\.requests \? <small className="pm-provider-requests">/);
  assert.match(models, /providerUsage\.requests === 1 \? "request" : "requests"/);
  assert.match(providerModelsCss, /\.pm-provider-tags\s*\{[^}]*flex-wrap:\s*nowrap;/s);
  assert.match(models, /\{ label: "Selected", value: models\.length, detail: `\$\{enabledCount\} enabled` \}/);
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
  assert.match(models, />Picker models<\/strong>/);
  assert.match(models, /catalogEligible\(entry\) && catalog \?/);
  assert.match(models, /catalog\?\.data \? "Reload from provider" : "Load all models"/);
  assert.match(models, /Use Load all models to choose/);
  // Opening a provider shows its stored list; only an explicit reload re-asks.
  assert.match(models, /const openProvider = \(entry: ProviderDirectoryEntry, expanded: boolean\)/);
  assert.match(models, /discoverProviderModels\(entry\.id, \{ refresh \}\)/);
  assert.match(models, /onReload=\{\(\) => void discoverCatalog\(entry, \{ refresh: true \}\)\}/);
  assert.match(models, /state\.data\.cached \? "saved list from" : "read"/);
  assert.match(models, /<strong>Available models<\/strong>/);
  assert.doesNotMatch(models, /Use Add models|<strong>Add models<\/strong>/);
  assert.doesNotMatch(models, />Provider catalog<\/strong>/);
  assert.match(providerModelsCss, /\.pm-filter-menu-wrap\s*\{/);
  assert.match(providerModelsCss, /\.pm-filter-menu\s*\{/);
  assert.doesNotMatch(providerModelsCss, /\.pm-model-layout\s*\{/);
  assert.match(models, /const effortOptions = model\.reasoningLevels \?\? \[\]/);
  assert.doesNotMatch(models, /reasoningLevels\?\.map\(\(level\) => level\.effort\)/);
  assert.doesNotMatch(models, /<dt>Available<\/dt>/);
  assert.match(models, /This list is saved locally/);
  assert.match(models, /x-preview-f-free[^\n]+Ox Alpha Free/);

  const components = await readFile(new URL("../apps/control-center/src/components.tsx", import.meta.url), "utf8");
  assert.match(components, /export function SkeletonBlock/);
  assert.match(components, /export function CatalogSkeleton/);
  assert.match(components, /export function PanelSkeleton/);
  assert.match(components, /app-loading-skeleton/);
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
  const connect = source.match(/handleAction\("connectProvider"[\s\S]*?\n  \}\);/)?.[0];
  assert.ok(connect, "provider-connect handler should be readable");
  assert.match(connect, /id === "antigravity-oauth"[\s\S]*?\["login", id\]/);
  const removal = source.match(/handleAction\("removeProviderCredential"[\s\S]*?\n  \}\);/)?.[0];
  assert.ok(removal, "credential-removal handler should be readable");
  assert.match(removal, /validateProvider\(providerId, "disconnect"\)/);
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
    assert.match(body, /forgetProviderCatalogCache\(providerId\)/);
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
