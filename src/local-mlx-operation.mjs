import { spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { writePrivateJson } from "./file-security.mjs";
import {
  claimLocalOperation,
  isLocalOperationActive,
  readLocalDownload,
} from "./local-download.mjs";
import {
  DEFAULT_MLX_URL,
  LOCAL_MLX_CONTEXT,
  LOCAL_MLX_ID,
  LOCAL_MLX_INSTALLERS,
  ensureLocalMlxPrerequisites,
  findLms,
  findUvx,
  installLocalMlx,
  localMlxStatus,
} from "./local-mlx.mjs";
import { STATE_DIR } from "./paths.mjs";
import { detachedOperationEnvironment } from "./process-tree.mjs";

export const LOCAL_MLX_OPERATION_PATH =
  process.env.MODEL_ROUTER_LOCAL_MLX_OPERATION_STATE ||
  path.join(STATE_DIR, "local-mlx", "operation.json");

const HEARTBEAT_MS = 5_000;
const HEARTBEAT_TIMEOUT_MS = 5 * 60_000;
export const LOCAL_MLX_ACTIVE_STATUSES = Object.freeze([
  "preparing",
  "downloading",
  "loading",
  "starting-server",
  "verifying",
  "publishing",
]);

export function isLocalMlxOperationActive(state) {
  return LOCAL_MLX_ACTIVE_STATUSES.includes(state?.status);
}

export function localMlxHostSupport({
  platform = process.platform,
  arch = process.arch,
} = {}) {
  const supported = platform === "darwin" && arch === "arm64";
  return {
    supported,
    platform,
    arch,
    ...(!supported
      ? { reason: "The curated MLX build requires macOS on Apple silicon (arm64)." }
      : {}),
  };
}

function processIsAlive(pid, kill = process.kill) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

export function writeLocalMlxOperation(state) {
  writePrivateJson(LOCAL_MLX_OPERATION_PATH, state, { space: 0, directoryMode: 0o700 });
  return state;
}

export function readLocalMlxOperation({
  now = Date.now(),
  kill = process.kill,
  persist = true,
} = {}) {
  if (!existsSync(LOCAL_MLX_OPERATION_PATH)) return null;
  let state;
  try {
    state = JSON.parse(readFileSync(LOCAL_MLX_OPERATION_PATH, "utf8"));
  } catch {
    return null;
  }
  if (state?.version !== 1 || !isLocalMlxOperationActive(state)) return state;
  const updatedAt = Number(state.updatedAt || state.startedAt || 0);
  const heartbeatFresh = Number.isFinite(updatedAt) && now - updatedAt <= HEARTBEAT_TIMEOUT_MS;
  if (processIsAlive(Number(state.workerPid), kill) && heartbeatFresh) return state;
  // A controller seeds the record immediately before spawning the worker.
  if (!state.workerPid && heartbeatFresh) return state;
  const interrupted = {
    ...state,
    status: "error",
    detail: "Installation interrupted",
    error: "The local MLX installation stopped before completion. Retry the install.",
    progressMode: "determinate",
    controllerPid: null,
    workerPid: null,
    updatedAt: now,
  };
  if (persist) writeLocalMlxOperation(interrupted);
  return interrupted;
}


function idleOperation() {
  return {
    status: "idle",
    detail: "Not installed",
    percent: 0,
    progressMode: "determinate",
    startedAt: null,
    updatedAt: null,
    controllerPid: null,
    workerPid: null,
  };
}

export async function localMlxUiSnapshot({
  platform = process.platform,
  arch = process.arch,
  lmsPath = findLms(),
  uvxPath = findUvx(),
  fetchImpl = fetch,
  published,
} = {}) {
  const runtime = await localMlxStatus({ lmsPath, uvxPath, fetchImpl, published });
  const suffix = platform === "win32" ? "win32" : "unix";
  const operation = readLocalMlxOperation() || idleOperation();
  return {
    host: localMlxHostSupport({ platform, arch }),
    model: {
      id: LOCAL_MLX_ID,
      slug: `lmstudio/${LOCAL_MLX_ID}`,
      source: DEFAULT_MLX_URL,
      precision: "4-bit",
      contextLength: LOCAL_MLX_CONTEXT,
    },
    prerequisites: {
      lms: {
        available: runtime.lmsAvailable,
        automaticWithYes: true,
        source: LOCAL_MLX_INSTALLERS.lms[suffix],
        installHint: "Installed automatically after consent, or install LM Studio from its official source.",
      },
      uvx: {
        available: runtime.uvxAvailable,
        automaticWithYes: true,
        source: LOCAL_MLX_INSTALLERS.uvx[suffix],
        installHint: "Installed automatically after consent, or install uv from its official source.",
      },
    },
    operation,
    runtime: {
      loopbackReachable: runtime.loopbackReachable,
      served: runtime.served,
      published: runtime.published,
    },
  };
}

export async function startLocalMlxOperation({
  yes = false,
  spawnImpl = spawn,
  now = Date.now,
  platform = process.platform,
  arch = process.arch,
  claimGlobalOperation = claimLocalOperation,
  readLocalOperation = readLocalDownload,
} = {}) {
  if (!yes) {
    throw new Error(
      "Installing the model and any missing official prerequisites changes user software. Pass --yes to confirm.",
    );
  }
  const host = localMlxHostSupport({ platform, arch });
  if (!host.supported) throw new Error(host.reason);
  // Shared with Ollama's controller. Both runtimes re-check the other's
  // durable state while holding this gate and seed their own state before
  // release, so two simultaneous clicks cannot both observe an idle peer.
  const globalClaim = await claimGlobalOperation(LOCAL_MLX_ID, "mlx-install", { now });
  if (!globalClaim.acquired) {
    const localOperation = readLocalOperation();
    if (isLocalOperationActive(localOperation)) {
      const verb = localOperation.status === "uninstalling" ? "being removed" : "downloading";
      throw new Error(`${localOperation.tag || "Another local model"} is already ${verb}.`);
    }
    const existing = readLocalMlxOperation();
    if (isLocalMlxOperationActive(existing)) {
      return { started: false, existing: true, operation: existing };
    }
    throw new Error("Another local model operation is starting. Try again shortly.");
  }
  try {
    const localOperation = readLocalOperation();
    if (isLocalOperationActive(localOperation)) {
      const verb = localOperation.status === "uninstalling" ? "being removed" : "downloading";
      throw new Error(`${localOperation.tag || "Another local model"} is already ${verb}.`);
    }
    const existing = readLocalMlxOperation();
    if (isLocalMlxOperationActive(existing)) {
      return { started: false, existing: true, operation: existing };
    }
    const startedAt = typeof now === "function" ? now() : now;
    const seeded = writeLocalMlxOperation({
      version: 1,
      status: "preparing",
      detail: "Starting one-click MLX installation",
      percent: 0,
      progressMode: "determinate",
      startedAt,
      updatedAt: startedAt,
      controllerPid: process.pid,
      workerPid: null,
    });
    let child;
    try {
      child = spawnImpl(process.execPath, [fileURLToPath(import.meta.url), "worker"], {
        detached: true,
        env: detachedOperationEnvironment(),
        stdio: "ignore",
        windowsHide: true,
      });
      child.unref?.();
    } catch (error) {
      const failed = writeLocalMlxOperation({
        ...seeded,
        status: "error",
        detail: "Installation failed to start",
        error: error instanceof Error ? error.message : String(error),
        controllerPid: null,
        workerPid: null,
        updatedAt: Date.now(),
      });
      throw new Error(failed.error);
    }
    const current = readLocalMlxOperation({ persist: false }) || seeded;
    const operation = isLocalMlxOperationActive(current)
      ? writeLocalMlxOperation({
          ...current,
          controllerPid: null,
          workerPid: child.pid,
          updatedAt: Date.now(),
        })
      : current;
    return { started: true, existing: false, operation };
  } finally {
    await globalClaim.release();
  }
}

export function cancelLocalMlxOperation({
  kill = process.kill,
  platform = process.platform,
  spawnSyncImpl = spawnSync,
  now = Date.now(),
} = {}) {
  const state = readLocalMlxOperation({ now, kill });
  if (!isLocalMlxOperationActive(state)) return { cancelled: false, state };
  const pid = Number(state.workerPid || state.controllerPid);
  if (Number.isInteger(pid) && pid > 0 && pid !== process.pid) {
    if (platform === "win32") {
      const result = spawnSyncImpl("taskkill", ["/PID", String(pid), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true,
      });
      if (result?.status !== 0) throw new Error("The local MLX installation could not be cancelled.");
    } else {
      // The worker is detached, so it owns a process group with uvx/lms
      // descendants. Signal the whole group to avoid leaving a large download
      // behind; fall back to the worker PID for injected/legacy launchers.
      try {
        kill(-pid, "SIGTERM");
      } catch (error) {
        if (error?.code !== "ESRCH") throw error;
        try { kill(pid, "SIGTERM"); } catch (fallbackError) {
          if (fallbackError?.code !== "ESRCH") throw fallbackError;
        }
      }
    }
  }
  // Persist cancellation only after the OS accepted the stop request. If it
  // refuses, leave the truthful active state for polling and retry.
  const cancelled = writeLocalMlxOperation({
    ...state,
    status: "cancelled",
    detail: "Installation cancelled",
    error: "Cancelled by user.",
    progressMode: "determinate",
    controllerPid: null,
    workerPid: null,
    updatedAt: now,
  });
  return { cancelled: true, state: cancelled };
}

async function runWorker() {
  const started = readLocalMlxOperation({ persist: false });
  if (!isLocalMlxOperationActive(started)) return;
  const abort = new AbortController();
  const abortWorker = () => abort.abort(new Error("Cancelled by user."));
  process.once("SIGTERM", abortWorker);
  process.once("SIGINT", abortWorker);
  const update = (status, detail, percent) => {
    if (readLocalMlxOperation({ persist: false })?.status === "cancelled") return;
    writeLocalMlxOperation({
      ...(readLocalMlxOperation({ persist: false }) || started),
      version: 1,
      status,
      detail,
      percent,
      progressMode: status === "downloading" ? "indeterminate" : "determinate",
      controllerPid: null,
      workerPid: process.pid,
      updatedAt: Date.now(),
      error: undefined,
    });
  };
  const heartbeat = setInterval(() => {
    const current = readLocalMlxOperation({ persist: false });
    if (!isLocalMlxOperationActive(current)) return;
    writeLocalMlxOperation({ ...current, workerPid: process.pid, updatedAt: Date.now() });
  }, HEARTBEAT_MS);
  heartbeat.unref();
  try {
    const prerequisites = await ensureLocalMlxPrerequisites({
      yes: true,
      signal: abort.signal,
      onPhase: update,
    });
    await installLocalMlx({
      yes: true,
      lmsPath: prerequisites.lmsPath,
      uvxPath: prerequisites.uvxPath,
      signal: abort.signal,
      onPhase: update,
    });
    if (readLocalMlxOperation({ persist: false })?.status === "cancelled") return;
    writeLocalMlxOperation({
      ...(readLocalMlxOperation({ persist: false }) || started),
      version: 1,
      status: "done",
      detail: "Installed and published to Codex",
      percent: 100,
      progressMode: "determinate",
      controllerPid: null,
      workerPid: null,
      updatedAt: Date.now(),
      error: undefined,
    });
  } catch (error) {
    if (readLocalMlxOperation({ persist: false })?.status === "cancelled") return;
    writeLocalMlxOperation({
      ...(readLocalMlxOperation({ persist: false }) || started),
      version: 1,
      status: "error",
      detail: "Installation failed",
      percent: readLocalMlxOperation({ persist: false })?.percent || 0,
      progressMode: "determinate",
      controllerPid: null,
      workerPid: null,
      updatedAt: Date.now(),
      error: error instanceof Error ? error.message : String(error),
    });
  } finally {
    clearInterval(heartbeat);
    process.removeListener("SIGTERM", abortWorker);
    process.removeListener("SIGINT", abortWorker);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url) && process.argv[2] === "worker") {
  runWorker().catch(() => { process.exitCode = 1; });
}
