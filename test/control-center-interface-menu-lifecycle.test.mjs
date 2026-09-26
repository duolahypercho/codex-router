import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import vm from "node:vm";
import * as menus from "../apps/control-center/electron/interface-menu.mjs";

const mainURL = new URL("../apps/control-center/electron/main.mjs", import.meta.url);
const mainSource = readFileSync(mainURL, "utf8");

// Execute the actual entry-point body with in-memory OS/Electron boundaries.
// This is not a packaged Electron smoke test: native windows, disk writes,
// external commands and network traffic are never started by this harness.
async function boot({ locale = "en-US", platform = "linux", embedded = false } = {}) {
  const listeners = new Map();
  const windows = [];
  const trays = [];
  const applicationMenus = [];
  const lifecycleWrites = [];
  let quitCount = 0;
  let readyCallback;
  const handlers = () => ({
    on() { return this; },
    once() { return this; },
  });
  const app = {
    isPackaged: false,
    getLocale: () => locale,
    requestSingleInstanceLock: () => true,
    whenReady: () => ({ then(callback) { readyCallback = callback; } }),
    on() {},
    dock: { setIcon() {}, show() {}, hide() {} },
    quit() { quitCount++; },
    exit(code) { assert.fail(`Unexpected app.exit(${code})`); },
  };
  class BrowserWindow {
    constructor(options) {
      this.options = options;
      Object.assign(this, handlers());
      this.webContents = {
        ...handlers(),
        mainFrame: { url: "" },
        setWindowOpenHandler() {},
        send() {},
      };
      windows.push(this);
    }
    loadFile(file) {
      this.webContents.mainFrame.url = pathToFileURL(file).href;
      return Promise.resolve();
    }
    loadURL(url) {
      this.webContents.mainFrame.url = url;
      return Promise.resolve();
    }
    isDestroyed() { return false; }
    isMinimized() { return false; }
    restore() {}
    show() {}
    hide() {}
    focus() {}
  }
  class Tray {
    constructor() {
      this.destroyed = false;
      this.menus = [];
      trays.push(this);
    }
    setToolTip() {}
    setContextMenu(menu) { this.menus.push(menu); }
    on() {}
    isDestroyed() { return this.destroyed; }
    destroy() { this.destroyed = true; }
  }
  const bindings = {
    ...menus,
    app, BrowserWindow, Tray, path, fileURLToPath, pathToFileURL, URL,
    ipcMain: { on(name, callback) { listeners.set(name, callback); } },
    Menu: {
      buildFromTemplate: (template) => template,
      setApplicationMenu(menu) { applicationMenus.push(menu); },
    },
    nativeImage: { createFromPath: () => ({ isEmpty: () => false, setTemplateImage() {} }) },
    shell: {},
    session: { defaultSession: {
      setPermissionCheckHandler() {},
      setPermissionRequestHandler() {},
      webRequest: { onHeadersReceived() {} },
    } },
    process: {
      platform,
      argv: ["node", "main.mjs", "--tray-only"],
      env: embedded ? { CODEX_ROUTER_EMBEDDED_CONTROL_CENTER: "1" } : {},
      exit(code) { assert.fail(`Unexpected process.exit(${code})`); },
    },
    console: { error(...values) { assert.fail(values.join(" ")); } },
    writeFileSync() { assert.fail("Unexpected writeFileSync during menu startup"); },
    registerIpcHandlers: () => ({ hasActiveMutations: () => false, whenMutationsIdle: () => Promise.resolve() }),
    createOpenRequestGate: () => ({ requestOpen() {}, markReady() {} }),
    createRendererReadyGate: () => ({ didFinishLoad() {}, didBecomeReadyToShow() {}, didFailLoad() {} }),
    lifecycleStatePath: () => "/not-written/menu-harness.json",
    linuxStatusNotifierHostAvailable: () => true,
    LIFECYCLE_QUERY_ARGUMENT: "--query-lifecycle",
    queryLifecycleState: () => ({}),
    shouldQuitOnLastWindowClosed: () => false,
    writeLifecycleState(file, state) { lifecycleWrites.push({ file, state }); },
    controlCenterDestination: () => undefined,
    controlCenterNavigationURL: () => undefined,
  };
  const expectedImports = new Set([
    "electron", "node:path", "node:fs", "node:url", "./ipc.mjs",
    "./lifecycle-state.mjs", "./navigation.mjs", "./interface-menu.mjs",
  ]);
  const seenImports = [];
  const body = mainSource.replace(/^import\s+[\s\S]*?\sfrom\s+"([^"]+)";\s*/gm, (_statement, specifier) => {
    assert.ok(expectedImports.has(specifier), `Update the harness for import ${specifier}`);
    seenImports.push(specifier);
    return "";
  }).replaceAll("import.meta.url", JSON.stringify(mainURL.href));
  assert.deepEqual(new Set(seenImports), expectedImports);
  vm.runInNewContext(body, bindings, { filename: fileURLToPath(mainURL), timeout: 1_000 });
  assert.equal(typeof readyCallback, "function");
  await readyCallback();
  await Promise.resolve();
  assert.equal(windows.length, 1, "tray-only startup must still create its hidden renderer");
  const renderer = windows[0].webContents;
  const trusted = () => ({ sender: renderer, senderFrame: renderer.mainFrame });
  const send = (value, event = trusted()) => listeners.get("router-control:interface-language")(event, value);
  return { windows, trays, applicationMenus, lifecycleWrites, renderer, trusted, send, quits: () => quitCount };
}

for (const platform of ["linux", "win32", "darwin"]) {
  for (const [locale, label] of [
    ["en-US", "Open Control Center"],
    ["zh-CN", "打开控制中心"],
    ["zh-TW", "開啟控制中心"],
    ["zh-Hant-HK", "開啟控制中心"],
    ["zh-Hans-TW", "打开控制中心"],
  ]) {
    test(`entry-point startup uses ${locale} for the ${platform} tray`, async () => {
      const harness = await boot({ locale, platform });
      assert.equal(harness.trays.length, 1);
      assert.equal(harness.trays[0].menus.at(-1)[0].label, label);
      if (platform === "darwin") {
        assert.equal(harness.applicationMenus.at(-1)[4].submenu.find((item) => item.click)?.label, label);
      } else {
        assert.deepEqual(harness.applicationMenus, [null]);
      }
    });
  }
  test(`trusted renderer switches en -> zh-TW -> zh-CN -> en on ${platform}`, async () => {
    const harness = await boot({ platform });
    const writesBefore = harness.lifecycleWrites.length;
    for (const [language, label] of [
      ["zh-TW", "開啟控制中心"],
      ["zh-CN", "打开控制中心"],
      ["en", "Open Control Center"],
    ]) {
      harness.send(language);
      assert.equal(harness.trays[0].menus.at(-1)[0].label, label);
      if (platform === "darwin") {
        assert.equal(harness.applicationMenus.at(-1)[4].submenu.find((item) => item.click)?.label, label);
      }
    }
    assert.equal(harness.lifecycleWrites.length, writesBefore, "language updates do not write lifecycle/router state");
    assert.equal(harness.quits(), 0, "language changes never execute menu actions");
    harness.trays[0].menus.at(-1)[2].click();
    assert.equal(harness.quits(), 1, "the Quit action keeps its original callback");
  });
}

test("the real entry-point listener ignores invalid IDs, alien windows and subframes", async () => {
  const harness = await boot();
  const tray = harness.trays[0];
  const before = tray.menus.length;
  for (const value of [undefined, null, {}, [], "zh-Hant", "zh-tw", "../../zh-TW", "constructor", "__proto__"]) {
    harness.send(value);
  }
  harness.send("zh-TW", { sender: {}, senderFrame: harness.renderer.mainFrame });
  harness.send("zh-TW", { sender: harness.renderer, senderFrame: { url: harness.renderer.mainFrame.url } });
  const originalURL = harness.renderer.mainFrame.url;
  harness.renderer.mainFrame.url = "https://example.invalid/";
  harness.send("zh-TW");
  harness.renderer.mainFrame.url = originalURL;
  assert.equal(tray.menus.length, before);
  assert.equal(tray.menus.at(-1)[0].label, "Open Control Center");
  harness.send("zh-TW");
  assert.equal(tray.menus.length, before + 1);
});

test("embedded macOS updates its application menu without creating a second native tray", async () => {
  const harness = await boot({ locale: "zh-Hant", platform: "darwin", embedded: true });
  assert.equal(harness.trays.length, 0);
  assert.equal(harness.applicationMenus.at(-1)[1].label, "檔案");
  harness.send("zh-CN");
  assert.equal(harness.applicationMenus.at(-1)[1].label, "文件");
  harness.send("en");
  assert.equal(harness.applicationMenus.at(-1)[1].label, "File");
});

test("an already-destroyed tray is not recreated by a language notification", async () => {
  const harness = await boot();
  const tray = harness.trays[0];
  const updates = tray.menus.length;
  tray.destroy();
  harness.send("zh-TW");
  assert.equal(harness.trays.length, 1);
  assert.equal(tray.menus.length, updates);
});
