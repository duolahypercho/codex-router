import {
  app,
  BrowserWindow,
  ipcMain,
  Menu,
  nativeImage,
  shell,
  session,
  Tray,
} from "electron";
import path from "node:path";
import { writeFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { registerIpcHandlers } from "./ipc.mjs";
import {
  createOpenRequestGate,
  createRendererReadyGate,
  lifecycleStatePath,
  linuxStatusNotifierHostAvailable,
  LIFECYCLE_QUERY_ARGUMENT,
  queryLifecycleState,
  shouldQuitOnLastWindowClosed,
  writeLifecycleState,
} from "./lifecycle-state.mjs";
import { controlCenterDestination, controlCenterNavigationURL } from "./navigation.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEVELOPMENT_ICON = path.resolve(HERE, "..", "assets", "icon.png");
let mainWindow;
let tray;
let mutationLifecycle = {
  hasActiveMutations: () => false,
  whenMutationsIdle: () => Promise.resolve(),
};
let deferredQuit;
let isQuitting = false;
let applicationReady = false;
let windowVisible = false;
let windowContentReady = false;
let showWhenContentReady = false;
let pendingNavigationDestination = controlCenterDestination(process.argv);
const lifecycleFile = lifecycleStatePath();

// macOS keeps its existing Swift NSStatusItem. The Control Center is embedded
// in that app bundle and receives this marker from the native host, so it must
// not paint a second menu-bar icon. Windows, Linux, and standalone development
// builds own their native Electron Tray directly.
function embeddedInNativeHost() {
  if (process.platform !== "darwin" || !process.resourcesPath) return false;
  const resourcePath = path.resolve(process.resourcesPath);
  return ["Codex Router.app", "Model Router.app"].some((outerBundle) =>
    resourcePath.endsWith([
      outerBundle,
      "Contents",
      "Resources",
      "Control Center.app",
      "Contents",
      "Resources",
    ].join(path.sep)));
}

const nativeTrayOwnedByHost = process.platform === "darwin"
  && (process.env.CODEX_ROUTER_EMBEDDED_CONTROL_CENTER === "1" || embeddedInNativeHost());
const trayOnlyInvocation = process.argv.includes("--tray-only");
const quitForUpdateInvocation = process.argv.includes("--quit-for-update");
const lifecycleQueryInvocation = process.argv.includes(LIFECYCLE_QUERY_ARGUMENT);

function publishLifecycleState() {
  try {
    writeLifecycleState(lifecycleFile, { ready: applicationReady, visible: windowVisible });
  } catch (error) {
    console.error(`Could not publish Control Center lifecycle state: ${error?.message || error}`);
  }
}

function rendererLocation() {
  const productionFile = path.join(HERE, "..", "dist", "index.html");
  const requested = process.env.VITE_DEV_SERVER_URL;
  // An inherited environment variable must never replace packaged renderer
  // code with a page that receives the privileged preload bridge.
  if (app.isPackaged || !requested) {
    return { url: pathToFileURL(productionFile).href, file: productionFile, development: false };
  }
  let parsed;
  try { parsed = new URL(requested); } catch { throw new Error("VITE_DEV_SERVER_URL must be a loopback HTTP URL."); }
  if (
    parsed.protocol !== "http:"
    || !["127.0.0.1", "localhost", "[::1]"].includes(parsed.hostname)
    || parsed.username
    || parsed.password
  ) {
    throw new Error("VITE_DEV_SERVER_URL must be a loopback HTTP URL without credentials.");
  }
  return { url: parsed.href, development: true };
}

const RENDERER = rendererLocation();

function appIconPath() {
  return app.isPackaged ? path.join(process.resourcesPath, "icon.png") : DEVELOPMENT_ICON;
}

function showDockForVisibleWindow() {
  if (process.platform !== "darwin" || !nativeTrayOwnedByHost || !app.dock) return;
  app.dock.setIcon(appIconPath());
  void app.dock.show();
}

function hideDockForHiddenWindow() {
  if (process.platform !== "darwin" || !nativeTrayOwnedByHost || !app.dock) return;
  app.dock.hide();
}

function createWindow() {
  const createdWindow = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 960,
    minHeight: 640,
    show: false,
    title: "Codex Router",
    icon: appIconPath(),
    // macOS keeps native traffic lights. Windows/Linux are frameless with
    // no overlay so the renderer can place left-side lights like macOS.
    frame: false,
    ...(process.platform === "darwin"
      ? {
          titleBarStyle: "hiddenInset",
          trafficLightPosition: { x: 16, y: 16 },
        }
      : {
          titleBarStyle: "hidden",
          autoHideMenuBar: true,
        }),
    backgroundColor: "#ffffff",
    webPreferences: {
      preload: path.join(HERE, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      devTools: !app.isPackaged,
      navigateOnDragDrop: false,
      safeDialogs: true,
      spellcheck: false,
      webviewTag: false,
    },
  });
  mainWindow = createdWindow;
  windowContentReady = false;
  const rendererReady = createRendererReadyGate({
    onReady: () => {
      if (mainWindow !== createdWindow || createdWindow.isDestroyed()) return;
      windowContentReady = true;
      if (!applicationReady) completeApplicationReadiness();
      else if (showWhenContentReady) showWindow();
    },
    onFailure: (error) => {
      if (mainWindow !== createdWindow) return;
      applicationReady = false;
      windowContentReady = false;
      windowVisible = false;
      publishLifecycleState();
      const description = String(error?.message || error || "renderer load failed")
        .replace(/[\u0000-\u001f\u007f]+/g, " ")
        .slice(0, 200);
      console.error(`Control Center renderer failed to load: ${description}`);
      app.exit(1);
    },
  });
  createdWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  createdWindow.webContents.on("will-navigate", (event) => event.preventDefault());
  createdWindow.webContents.on("will-redirect", (event) => event.preventDefault());
  createdWindow.webContents.on("will-attach-webview", (event) => event.preventDefault());
  createdWindow.webContents.once("did-finish-load", () => rendererReady.didFinishLoad());
  createdWindow.webContents.once(
    "did-fail-load",
    (_event, errorCode, errorDescription, _validatedUrl, isMainFrame) => {
      if (isMainFrame === false) return;
      rendererReady.didFailLoad(new Error(`${errorDescription || "load failed"} (${errorCode})`));
    },
  );
  createdWindow.once("ready-to-show", () => rendererReady.didBecomeReadyToShow());
  createdWindow.on("show", () => {
    windowVisible = true;
    publishLifecycleState();
  });
  createdWindow.on("hide", () => {
    windowVisible = false;
    publishLifecycleState();
    // Keep the Dock / Command-Tab tile while Control Center is merely hidden.
    // Retiring it made Cmd+Tab and the Dock look like the app had quit.
  });
  createdWindow.on("close", (event) => {
    // Close means hide only while a recoverable owner can bring the window
    // back (embedded macOS host or a live tray). Without that owner, destroy
    // so window-all-closed can quit instead of stranding an invisible process.
    if (isQuitting || createdWindow.isDestroyed()) return;
    if (!(nativeTrayOwnedByHost || trayIsAvailable())) return;
    event.preventDefault();
    createdWindow.hide();
  });
  createdWindow.once("closed", () => {
    if (mainWindow !== createdWindow) return;
    mainWindow = undefined;
    windowContentReady = false;
    showWhenContentReady = false;
    windowVisible = false;
    publishLifecycleState();
    if (isQuitting) hideDockForHiddenWindow();
  });
  const loading = RENDERER.development
    ? createdWindow.loadURL(RENDERER.url)
    : createdWindow.loadFile(RENDERER.file);
  void loading.catch((error) => rendererReady.didFailLoad(error));
  return createdWindow;
}

function revealWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  // The native host is an LSUIElement and never owns a Dock tile. Let its
  // embedded Control Center represent the product in the Dock and Command-Tab
  // for as long as this process is alive, including while the window is hidden,
  // so switching away and back does not make the app look like it quit.
  showDockForVisibleWindow();
  mainWindow.show();
  mainWindow.focus();
  windowVisible = true;
  publishLifecycleState();
}

function flushNavigationDestination() {
  if (!pendingNavigationDestination || !mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send("router-control:navigate", pendingNavigationDestination);
  pendingNavigationDestination = undefined;
}

function requestNavigation(navigation) {
  if (!navigation) return false;
  pendingNavigationDestination = navigation;
  openRequests.requestOpen();
  if (windowContentReady) flushNavigationDestination();
  return true;
}

function showWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) createWindow();
  showWhenContentReady = true;
  if (!windowContentReady) return;
  showWhenContentReady = false;
  revealWindow();
}

const openRequests = createOpenRequestGate(showWindow);

function completeApplicationReadiness() {
  if (applicationReady) return;
  applicationReady = true;
  publishLifecycleState();
  openRequests.markReady();
}

function createTray() {
  if (tray && !tray.isDestroyed()) return tray;
  const image = nativeImage.createFromPath(appIconPath());
  if (image.isEmpty()) throw new Error(`The tray icon could not be loaded from ${appIconPath()}.`);
  const createdTray = new Tray(image);
  try {
    createdTray.setToolTip("Codex Router");
    createdTray.setContextMenu(Menu.buildFromTemplate([
      { label: "Open Control Center", click: showWindow },
      { type: "separator" },
      { label: "Quit Codex Router", click: () => app.quit() },
    ]));
    createdTray.on("click", showWindow);
  } catch (error) {
    createdTray.destroy();
    throw error;
  }
  tray = createdTray;
  return tray;
}

function trayIsAvailable() {
  if (nativeTrayOwnedByHost) return true;
  if (!tray || tray.isDestroyed()) return false;
  // Electron exposes construction, not Linux panel visibility. Keep tray-only
  // launches visible unless the desktop's StatusNotifierWatcher positively
  // reports a registered host; a missing probe is deliberately not success.
  if (process.platform === "linux") return linuxStatusNotifierHostAvailable();
  return true;
}

function trustedRendererSender(event) {
  if (event.sender !== mainWindow?.webContents || event.senderFrame !== event.sender.mainFrame) return false;
  try {
    const actual = new URL(event.senderFrame.url);
    const expected = new URL(RENDERER.url);
    return actual.protocol === expected.protocol
      && actual.hostname === expected.hostname
      && actual.port === expected.port
      && actual.pathname === expected.pathname;
  } catch {
    return false;
  }
}

if (lifecycleQueryInvocation) {
  // Query contract: one compact JSON object on stdout and status 0, including
  // for absent/stale state. This is directly consumable by jq or
  // ConvertFrom-Json without making "not running" a shell error.
  // A packaged GUI may have a pipe that never reports its write callback even
  // after the small lifecycle document is accepted. Exiting immediately after
  // the synchronous write handoff keeps rebuild verification from parking a
  // query helper forever.
  writeFileSync(1, `${JSON.stringify(queryLifecycleState(lifecycleFile))}\n`);
  process.exit(0);
}

const primaryInstance = !lifecycleQueryInvocation && app.requestSingleInstanceLock();
// These are helper invocations, not application sessions. app.quit() before
// ready can remain alive in packaged Electron when there is no primary GUI to
// receive the update request, which blocks the transactional bundle swap.
if (!lifecycleQueryInvocation && (!primaryInstance || quitForUpdateInvocation)) process.exit(0);

if (primaryInstance) app.on("open-url", (event, url) => {
  event.preventDefault();
  requestNavigation(controlCenterNavigationURL(url));
});

if (primaryInstance && !quitForUpdateInvocation) {
  // Replace a stale record as soon as this process owns the single-instance
  // lock. The ready bit is raised only after the full Electron boundary is set.
  publishLifecycleState();
  app.whenReady().then(() => {
    if (process.platform !== "darwin") {
      Menu.setApplicationMenu(null);
    }
    if (process.platform === "darwin") {
      if (nativeTrayOwnedByHost) hideDockForHiddenWindow();
      else app.dock?.setIcon(appIconPath());
    }
    session.defaultSession.setPermissionCheckHandler(() => false);
    session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
    // Keep the renderer's document policy narrow even when a future component
    // accidentally adds a remote resource.
    session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
      const scriptPolicy = RENDERER.development
        ? "script-src 'self' 'sha256-Z2/iFzh9VMlVkEOar1f/oSHWwQk3ve1qk/C2WdsC4Xk='"
        : "script-src 'self'";
      const connectPolicy = RENDERER.development
        ? "connect-src 'self' ws://127.0.0.1:* ws://localhost:* ws://[::1]:*"
        : "connect-src 'self'";
      const policy = `default-src 'self'; ${connectPolicy}; img-src 'self' data:; font-src 'self'; style-src 'self' 'unsafe-inline'; ${scriptPolicy}; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`;
      const responseHeaders = { ...details.responseHeaders };
      for (const name of Object.keys(responseHeaders)) {
        if (name.toLowerCase() === "content-security-policy") delete responseHeaders[name];
      }
      callback({ responseHeaders: { ...responseHeaders, "Content-Security-Policy": [policy] } });
    });
    if (!nativeTrayOwnedByHost) {
      try {
        createTray();
      } catch (error) {
        // Some Linux desktops expose no StatusNotifier/AppIndicator host. A
        // tray-only launch must never become an invisible live process there.
        console.error(`Could not create the native tray: ${error?.message || error}`);
      }
    }
    const trayAvailable = trayIsAvailable();
    mutationLifecycle = registerIpcHandlers({
      ipcMain,
      BrowserWindow,
      shell,
      senderGuard: trustedRendererSender,
    });
    ipcMain.on("router-control:navigation-ready", (event) => {
      if (!trustedRendererSender(event)) return;
      flushNavigationDestination();
    });
    // Even tray-only startup loads one hidden renderer before it publishes
    // ready. Otherwise a package with a missing/broken dist directory would
    // pass lifecycle validation merely because its tray icon was constructible.
    if (!trayOnlyInvocation || !trayAvailable) openRequests.requestOpen();
    createWindow();
    app.on("activate", () => openRequests.requestOpen());
  });
}

if (primaryInstance) app.on("second-instance", (_event, commandLine) => {
  if (commandLine.includes("--quit-for-update")) {
    app.quit();
  } else {
    const navigation = controlCenterDestination(commandLine);
    if (navigation) requestNavigation(navigation);
    else openRequests.requestOpen();
  }
});

if (primaryInstance) app.on("before-quit", (event) => {
  isQuitting = true;
  if (!mutationLifecycle.hasActiveMutations()) return;
  event.preventDefault();
  isQuitting = false;
  if (!deferredQuit) {
    deferredQuit = mutationLifecycle.whenMutationsIdle().then(() => {
      deferredQuit = undefined;
      isQuitting = true;
      app.quit();
    });
  }
});

if (primaryInstance) app.on("will-quit", () => {
  isQuitting = true;
  applicationReady = false;
  windowVisible = false;
  publishLifecycleState();
  hideDockForHiddenWindow();
});

if (primaryInstance) app.on("window-all-closed", () => {
  // Prefer close-to-hide above. If the window is destroyed anyway, keep the
  // embedded macOS process (and Windows/Linux tray builds) alive so Dock,
  // Command-Tab, or the tray can reopen it. Only quit when no recoverable
  // owner remains.
  if (shouldQuitOnLastWindowClosed({
    platform: process.platform,
    nativeTrayOwnedByHost,
    trayAvailable: trayIsAvailable(),
  })) app.quit();
});
