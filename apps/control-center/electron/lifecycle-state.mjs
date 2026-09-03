import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";

export const LIFECYCLE_QUERY_ARGUMENT = "--query-lifecycle";
export const LIFECYCLE_STATE_VERSION = 1;
const MAX_STATE_BYTES = 4_096;
const STATUS_NOTIFIER_QUERY = Object.freeze([
  "call",
  "--session",
  "--dest", "org.kde.StatusNotifierWatcher",
  "--object-path", "/StatusNotifierWatcher",
  "--method", "org.freedesktop.DBus.Properties.Get",
  "org.kde.StatusNotifierWatcher",
  "IsStatusNotifierHostRegistered",
]);

// A constructed Electron Tray does not prove that a Linux desktop rendered it.
// StatusNotifierWatcher exposes the one positive signal the app can verify: a
// registered panel host. Missing gdbus, a missing watcher, a false property, a
// timeout, or an unfamiliar reply all fail open to the visible window.
export function linuxStatusNotifierHostAvailable({
  platform = process.platform,
  executable = "/usr/bin/gdbus",
  executableExists = existsSync,
  spawn = spawnSync,
  environment = process.env,
} = {}) {
  if (platform !== "linux" || !executableExists(executable)) return false;
  try {
    const result = spawn(executable, STATUS_NOTIFIER_QUERY, {
      encoding: "utf8",
      env: environment,
      maxBuffer: 4_096,
      shell: false,
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 1_000,
      windowsHide: true,
    });
    return result.status === 0 && /^\(\s*<true>\s*,?\s*\)\s*$/.test(result.stdout || "");
  } catch {
    return false;
  }
}

export function lifecycleStatePath(environment = process.env, home = os.homedir()) {
  if (environment.MODEL_ROUTER_CONTROL_CENTER_STATE) {
    return path.resolve(environment.MODEL_ROUTER_CONTROL_CENTER_STATE);
  }
  const codexHome = environment.CODEX_HOME || path.join(home, ".codex");
  const stateDirectory = environment.MODEL_ROUTER_STATE_DIR
    || environment.CODEX_ROUTER_STATE_DIR
    || environment.KIMI_CODEX_STATE_DIR
    || path.join(codexHome, "codex-router");
  return path.join(stateDirectory, "control-center-lifecycle.json");
}

export function writeLifecycleState(file, {
  pid = process.pid,
  ready = false,
  visible = false,
  now = new Date(),
} = {}) {
  const state = {
    version: LIFECYCLE_STATE_VERSION,
    pid,
    ready: ready === true,
    visible: visible === true,
    updatedAt: now.toISOString(),
  };
  const directory = path.dirname(file);
  const temporary = path.join(directory, `.${path.basename(file)}.${pid}.${Date.now()}.tmp`);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  try {
    writeFileSync(temporary, `${JSON.stringify(state)}\n`, { encoding: "utf8", mode: 0o600 });
    renameSync(temporary, file);
  } finally {
    rmSync(temporary, { force: true });
  }
  return state;
}

function processIsRunning(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // Windows and hardened POSIX hosts can deny signal access to an otherwise
    // live process. The state file is per-user and the writer records its PID,
    // so permission denial is still evidence that the owner exists.
    return error?.code === "EPERM";
  }
}

function unavailableState() {
  return {
    version: LIFECYCLE_STATE_VERSION,
    running: false,
    pid: null,
    ready: false,
    visible: false,
    updatedAt: null,
  };
}

export function queryLifecycleState(file, { isRunning = processIsRunning } = {}) {
  try {
    const stat = statSync(file);
    if (!stat.isFile() || stat.size < 2 || stat.size > MAX_STATE_BYTES) return unavailableState();
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    if (
      parsed?.version !== LIFECYCLE_STATE_VERSION
      || !Number.isSafeInteger(parsed.pid)
      || parsed.pid < 1
      || typeof parsed.ready !== "boolean"
      || typeof parsed.visible !== "boolean"
      || typeof parsed.updatedAt !== "string"
    ) return unavailableState();
    const running = isRunning(parsed.pid) === true;
    return {
      version: LIFECYCLE_STATE_VERSION,
      running,
      pid: running ? parsed.pid : null,
      ready: running && parsed.ready,
      visible: running && parsed.visible,
      updatedAt: parsed.updatedAt,
    };
  } catch {
    return unavailableState();
  }
}

// A second Electron instance can reach the primary before app.whenReady(). The
// gate coalesces any number of those normal open requests and drains one after
// the primary has installed its IPC/session/window lifecycle.
export function createOpenRequestGate(openWindow) {
  let ready = false;
  let pending = false;
  return Object.freeze({
    requestOpen() {
      if (ready) openWindow();
      else pending = true;
    },
    markReady() {
      ready = true;
      if (!pending) return;
      pending = false;
      openWindow();
    },
    pending() {
      return pending;
    },
  });
}

// Electron's app-ready event proves Chromium started, not that the privileged
// local renderer loaded. Package validation must not accept a missing/broken
// dist directory as a healthy Control Center, and showing before first paint
// produces the same blank-window symptom for users. Both signals are required;
// a main-frame load failure permanently closes this one-shot gate.
export function createRendererReadyGate({ onReady, onFailure }) {
  let loaded = false;
  let readyToShow = false;
  let failed = false;
  let completed = false;
  const finish = () => {
    if (failed || completed || !loaded || !readyToShow) return;
    completed = true;
    onReady();
  };
  return Object.freeze({
    didFinishLoad() {
      loaded = true;
      finish();
    },
    didBecomeReadyToShow() {
      readyToShow = true;
      finish();
    },
    didFailLoad(error) {
      if (failed || completed) return;
      failed = true;
      onFailure(error);
    },
    ready() {
      return completed;
    },
    failed() {
      return failed;
    },
  });
}

export function shouldQuitOnLastWindowClosed({
  platform,
  nativeTrayOwnedByHost,
  trayAvailable = true,
}) {
  // The embedded macOS child stays alive after the window hides so Dock and
  // Command-Tab can return to it. The outer Swift host owns process exit.
  if (platform === "darwin" && nativeTrayOwnedByHost === true) return false;
  // On Windows/Linux a usable Electron tray is what makes a windowless
  // lifetime recoverable. If construction failed (or it was later destroyed),
  // closing the fallback window must not strand an invisible process.
  return (platform === "win32" || platform === "linux") && trayAvailable === false;
}
