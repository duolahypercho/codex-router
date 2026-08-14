// Electron shell for the Codex Model Router companion. It owns the window, the
// tray icon and the IPC bridge; every panel, chart and control it displays is
// the same apps/desktop/ui the Tauri shell renders, loaded verbatim. Only the
// host differs, so a UI fix lands in both shells at once.
const {
  app,
  BrowserWindow,
  Menu,
  Tray,
  ipcMain,
  nativeImage,
  screen,
  shell,
} = require("electron");
const { execFile } = require("node:child_process");
const http = require("node:http");
const path = require("node:path");
const { promisify } = require("node:util");
const { pathToFileURL } = require("node:url");

const execFileAsync = promisify(execFile);

// Taken from the Tauri shell's constants and tauri.conf.json rather than
// chosen again here. The two shells render the same stylesheet at the same
// sizes, so a window sized differently is a layout bug, not a preference.
const PANEL_WIDTH = 382;
const PANEL_HEIGHT = 610;
const PANEL_MIN_WIDTH = 360;
const PANEL_MIN_HEIGHT = 520;
const ISLAND_WIDTH = 326;
const ISLAND_HEIGHT = 44;
const ISLAND_EXPANDED_WIDTH = 410;
const ISLAND_EXPANDED_HEIGHT = 122;
const EDGE_MARGIN = 16;
const ISLAND_TOP_MARGIN = 8;

// Packaged, main.js runs from inside app.asar while the UI and src/ are
// unpacked beside it under resources/app -- so a path relative to __dirname
// points at nothing and the window loads a blank page while the process looks
// perfectly healthy. One root, resolved per mode, keeps dev and packaged from
// drifting: everything else is derived from it.
const APP_ROOT = app.isPackaged
  ? path.join(process.resourcesPath, "app")
  : path.resolve(__dirname, "..", "..");
const UI_DIR = path.join(APP_ROOT, "apps", "desktop", "ui");
const COMMANDS_MODULE = pathToFileURL(path.join(APP_ROOT, "src", "desktop-commands.mjs")).href;
const ROUTER_PORT = Number(process.env.MODEL_ROUTER_PORT || 4202);

let bridge;
let root;
let tray;
let panel;
let island;
let presenceTimer;
let presenceStopTimer;
let presenceMode = "always";
let hostAppRunning = true;
let serviceIntent = "unknown";
// islandEnabled starts true, as it does in the Tauri shell's Settings::default.
// Starting it false meant the switch read "off" on first launch and the pill
// never appeared until someone found and flipped it.
const settings = { islandEnabled: true, islandExpanded: false };
const HOST_PROCESS_NAMES = new Set(["chatgpt.exe", "codex.exe", "codex-desktop.exe"]);
const PRESENCE_POLL_MS = 5_000;
const PRESENCE_ABSENCE_GRACE_MS = 15_000;

async function loadBridge() {
  bridge ??= await import(COMMANDS_MODULE);
  root ??= process.env.MODEL_ROUTER_SOURCE_ROOT || APP_ROOT;
  return bridge;
}

// Mirrors the Rust reader: a short connect timeout so a stopped router reports
// offline promptly instead of stalling the panel behind a hanging socket.
function routerHealth() {
  return new Promise((resolve) => {
    const offline = (detail) => resolve({ ok: false, status: "offline", detail });
    const request = http.get(
      { host: "127.0.0.1", port: ROUTER_PORT, path: "/health", timeout: 2000 },
      (response) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () => {
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
          } catch {
            offline("Router health response was unreadable.");
          }
        });
      },
    );
    request.on("timeout", () => {
      request.destroy();
      offline("Router health check did not finish.");
    });
    request.on("error", () => offline("Router is offline."));
  });
}

async function handleInvoke(command, args) {
  const { runDesktopCommand } = await loadBridge();

  if (command === "router_health") return routerHealth();
  if (command === "platform_info") return platformInfo();
  if (command === "desktop_settings") return { ...settings };
  if (command === "set_island_enabled") {
    settings.islandEnabled = Boolean(args.enabled);
    applyIslandVisibility();
    return { ...settings };
  }
  if (command === "set_island_expanded") {
    // Hovering the pill expands it into the seven-day graph, so this both
    // resizes and re-centres: the wider window centred on the old width would
    // sit off-centre by half the difference.
    settings.islandExpanded = Boolean(args.expanded);
    if (settings.islandEnabled) showIsland(settings.islandExpanded);
    return { ...settings };
  }
  if (command === "show_panel") {
    showPanel();
    return null;
  }
  if (command === "hide_panel") {
    panel?.hide();
    return null;
  }
  if (command === "quit_app") {
    app.quit();
    return null;
  }

  // The shared runner, so the shell adds a window and an IPC hop and nothing
  // else. Behaviour lives in src/desktop-commands.mjs for every surface.
  return runDesktopCommand(command, args ?? {}, { root });
}

// The shape the shared UI actually reads -- the camelCase serialization of the
// Rust PlatformInfo. The previous reply used an `island` key the UI never looks
// at, so islandSupported was always undefined, the switch always rendered as
// supported, and the reason line was always empty.
function platformInfo() {
  const wayland = process.platform === "linux" && Boolean(process.env.WAYLAND_DISPLAY);
  return {
    os: process.platform,
    session: wayland ? "wayland" : process.platform === "linux" ? "x11" : "native",
    // Same rule the Tauri shell applies: compositors own absolute placement on
    // Wayland, so a fixed top-center pill cannot be honoured there.
    islandSupported: !wayland,
    islandReason: wayland
      ? "Wayland compositors control window placement, so the activity pill cannot hold a fixed position."
      : null,
    shell: "electron",
  };
}

// Windows has no NSWorkspace equivalent, so the Electron companion keeps the
// same follow-Codex contract as the native macOS tray with a small process-list
// poll. The names cover the installed ChatGPT/Codex package and the CLI host;
// a missing tasklist (for example in a headless test) is treated as present so
// an availability probe can never strand the router behind a false negative.
async function hostApplicationRunning() {
  if (process.platform !== "win32") return true;
  try {
    const { stdout } = await execFileAsync("tasklist.exe", ["/FO", "CSV", "/NH"], {
      windowsHide: true,
      timeout: 3_000,
      maxBuffer: 512 * 1024,
    });
    return String(stdout)
      .split(/\r?\n/)
      .some((line) => {
        const match = line.match(/^\"([^\"]+)\"/);
        return match && HOST_PROCESS_NAMES.has(match[1].toLowerCase());
      });
  } catch {
    return true;
  }
}

function applyPresenceVisibility(visible) {
  if (!visible) {
    panel?.hide();
    if (island && !island.isDestroyed()) island.hide();
    if (tray && !tray.isDestroyed()) {
      tray.destroy();
      tray = null;
    }
    return;
  }
  if (!tray) {
    try {
      buildTray();
    } catch {
      // A tray is optional in a headless session; the panel still responds to
      // the app bridge and the next poll retries once a desktop is available.
    }
  }
  applyIslandVisibility();
}

async function setPresenceService(action) {
  const desired = action === "stop" ? "stopped" : "running";
  if (serviceIntent === desired) return;
  serviceIntent = desired;
  try {
    await (await loadBridge()).runDesktopCommand(
      action === "stop" ? "service_stop" : "service_start",
      {},
      { root },
    );
  } catch {
    serviceIntent = "unknown";
  }
}

async function reconcilePresence() {
  if (process.platform !== "win32") return;
  let mode = presenceMode;
  try {
    const snapshot = await (await loadBridge()).runDesktopCommand("presence_status", {}, { root });
    mode = snapshot?.mode === "follow-codex" ? "follow-codex" : "always";
  } catch {
    mode = "always";
  }
  presenceMode = mode;
  if (mode !== "follow-codex") {
    if (presenceStopTimer) {
      clearTimeout(presenceStopTimer);
      presenceStopTimer = null;
    }
    hostAppRunning = true;
    applyPresenceVisibility(true);
    if (serviceIntent === "stopped") void setPresenceService("start");
    else serviceIntent = "unknown";
    return;
  }

  hostAppRunning = await hostApplicationRunning();
  applyPresenceVisibility(hostAppRunning);
  if (hostAppRunning) {
    if (presenceStopTimer) {
      clearTimeout(presenceStopTimer);
      presenceStopTimer = null;
    }
    void setPresenceService("start");
    return;
  }

  // Hide the surfaces immediately, but wait before stopping the endpoint so a
  // quick Codex restart and any final in-flight request are not interrupted.
  if (!presenceStopTimer) {
    presenceStopTimer = setTimeout(async () => {
      presenceStopTimer = null;
      const stillRunning = await hostApplicationRunning();
      if (stillRunning || presenceMode !== "follow-codex") return;
      const health = await routerHealth();
      const activity = health?.activity || {};
      if (Number(activity.activeCount || activity.active?.length || 0) > 0 || activity.state === "generating") {
        presenceStopTimer = setTimeout(() => reconcilePresence(), PRESENCE_ABSENCE_GRACE_MS);
        return;
      }
      await setPresenceService("stop");
    }, PRESENCE_ABSENCE_GRACE_MS);
  }
}

function startPresenceObservation() {
  if (process.platform !== "win32") return;
  clearInterval(presenceTimer);
  void reconcilePresence();
  presenceTimer = setInterval(() => void reconcilePresence(), PRESENCE_POLL_MS);
}

// Both windows are chromeless because the UI draws its own header, close
// button and rounded background -- the same reason tauri.conf.json sets
// decorations:false. A native frame put a second title bar and a second set of
// window controls above the ones already on screen.
function chromelessWindow(options) {
  return new BrowserWindow({
    show: false,
    frame: false,
    transparent: true,
    resizable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
    ...options,
  });
}

// The UI picks its view from the query string and renders the pill or the
// panel accordingly. Loading index.html without one left the island window
// showing a full panel, which is why this is never assembled by hand.
function loadView(window, view) {
  window.loadFile(path.join(UI_DIR, "index.html"), { query: { view } });
  // The panel is the whole app; external links belong in a browser, not in a
  // window with a privileged preload attached to it.
  window.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });
}

function displayForCursor() {
  return screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
}

function showPanel() {
  if (!panel || panel.isDestroyed()) {
    panel = chromelessWindow({
      width: PANEL_WIDTH,
      height: PANEL_HEIGHT,
      minWidth: PANEL_MIN_WIDTH,
      minHeight: PANEL_MIN_HEIGHT,
      title: "Codex Model Router",
    });
    loadView(panel, "panel");
  }
  // Anchored to the tray corner rather than wherever the window manager would
  // put it. workArea already excludes the taskbar, so the margin is the whole
  // adjustment -- the Tauri shell subtracts a taskbar allowance itself because
  // it measures the full monitor.
  const { workArea } = displayForCursor();
  panel.setBounds({
    width: PANEL_WIDTH,
    height: PANEL_HEIGHT,
    x: workArea.x + workArea.width - PANEL_WIDTH - EDGE_MARGIN,
    y: workArea.y + workArea.height - PANEL_HEIGHT - EDGE_MARGIN,
  });
  panel.show();
  panel.focus();
}

function showIsland(expanded) {
  if (!island || island.isDestroyed()) {
    island = chromelessWindow({
      width: ISLAND_WIDTH,
      height: ISLAND_HEIGHT,
      title: "Router activity",
      hasShadow: false,
      // The pill reports what the router is doing while someone works in
      // another application; taking focus would interrupt the very thing it
      // exists to report on.
      focusable: false,
    });
    loadView(island, "island");
  }
  const width = expanded ? ISLAND_EXPANDED_WIDTH : ISLAND_WIDTH;
  const height = expanded ? ISLAND_EXPANDED_HEIGHT : ISLAND_HEIGHT;
  // Top-center of the display the cursor is on, matching position_island.
  const { bounds } = displayForCursor();
  island.setBounds({
    width,
    height,
    x: Math.round(bounds.x + (bounds.width - width) / 2),
    y: bounds.y + ISLAND_TOP_MARGIN,
  });
  island.showInactive();
}

function applyIslandVisibility() {
  if (!platformInfo().islandSupported || !settings.islandEnabled) {
    if (island && !island.isDestroyed()) island.hide();
    return;
  }
  showIsland(settings.islandExpanded);
}

function buildTray() {
  // A one-pixel transparent image keeps the tray constructible on a machine
  // with no icon theme (and in CI); the real asset replaces it when present.
  const icon = nativeImage.createFromPath(path.join(UI_DIR, "..", "src-tauri", "icons", "32x32.png"));
  tray = new Tray(icon.isEmpty() ? nativeImage.createEmpty() : icon);
  tray.setToolTip("Codex Model Router");
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: "Open Model Router", click: showPanel },
      {
        label: "Activity pill",
        type: "checkbox",
        checked: settings.islandEnabled,
        enabled: platformInfo().islandSupported,
        click: (item) => {
          settings.islandEnabled = item.checked;
          applyIslandVisibility();
        },
      },
      { type: "separator" },
      { label: "Quit", click: () => app.quit() },
    ]),
  );
  tray.on("click", showPanel);
}

// Not `require.main === module`: Electron does not load the entry point as
// Node's main module, so that guard is always false here and the app would
// start without ever opening a window. Running under Electron is the real
// condition, and it leaves the module inert for a plain-Node import.
if (process.versions.electron) {
  app.whenReady().then(() => {
    ipcMain.handle("router:invoke", (_event, command, args) => handleInvoke(command, args));
    try {
      buildTray();
    } catch {
      // A headless session has no tray host. The panel still works, which is
      // what an automated pass drives.
    }
    // Panel first: it is the window an automated pass drives, and creating the
    // pill ahead of it would make the pill the application's first window.
    if (!process.env.CODEX_ROUTER_ELECTRON_TRAY_ONLY) showPanel();
    applyIslandVisibility();
    startPresenceObservation();
  });
  app.on("before-quit", () => {
    clearInterval(presenceTimer);
    if (presenceStopTimer) clearTimeout(presenceStopTimer);
    // If follow mode stopped the endpoint, hand it back to the background
    // service before the watcher exits; otherwise the next Codex launch would
    // have no resident process left to notice it.
    if (presenceMode === "follow-codex" && serviceIntent === "stopped") {
      void setPresenceService("start");
    }
  });
  // The companion lives in the tray, so closing the panel must not end it.
  app.on("window-all-closed", () => {});
}

module.exports = { handleInvoke, routerHealth, showPanel };
