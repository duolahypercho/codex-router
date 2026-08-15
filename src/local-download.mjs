import {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { protectPrivateFile, writePrivateJson } from "./file-security.mjs";
import { STATE_DIR } from "./paths.mjs";
import { ensureOllamaHeadless } from "./ollama-runtime.mjs";
import { canonicalLocalModelTag, normalizeLocalModelTag } from "./local-model-ref.mjs";
import { streamOllamaPull } from "./vision-download.mjs";
import { DEFAULT_LOCAL_VISION_BASE_URL } from "./vision-bridge.mjs";

export const LOCAL_DOWNLOAD_STATE_PATH =
  process.env.MODEL_ROUTER_LOCAL_DOWNLOAD_STATE ||
  path.join(STATE_DIR, "local-model-download.json");

export const LOCAL_DOWNLOAD_CLAIM_PATH =
  process.env.MODEL_ROUTER_LOCAL_DOWNLOAD_CLAIM || `${LOCAL_DOWNLOAD_STATE_PATH}.claim`;

export const LOCAL_DOWNLOAD_CLAIM_STALE_MS = 30 * 1_000;

export const LOCAL_DOWNLOAD_HEARTBEAT_TIMEOUT_MS = 5 * 60 * 1_000;

export const LOCAL_DOWNLOAD_ACTIVE_STATUSES = Object.freeze(["downloading", "uninstalling"]);

export function isLocalOperationActive(state) {
  return LOCAL_DOWNLOAD_ACTIVE_STATUSES.includes(state?.status);
}

/**
 * Claim the short controller section that checks the state and seeds a new
 * operation. The state file itself is atomically replaced, so two controllers
 * could otherwise both read "idle" before either one writes "downloading".
 * This tiny exclusive claim closes that window without holding a lock for the
 * multi-minute Ollama worker. A dead controller's claim is recoverable.
 */
export function claimLocalOperation(
  tag,
  kind,
  {
    now = Date.now,
    kill = process.kill,
    claimPath = LOCAL_DOWNLOAD_CLAIM_PATH,
  } = {},
) {
  const currentNow = typeof now === "function" ? now() : now;
  const normalizedTag = normalizeLocalModelTag(tag);
  const directory = path.dirname(claimPath);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);

  for (let attempt = 0; attempt < 2; attempt += 1) {
    let descriptor;
    const token = `${process.pid}:${currentNow}:${Math.random().toString(36).slice(2)}`;
    try {
      descriptor = openSync(claimPath, "wx", 0o600);
      writeFileSync(
        descriptor,
        `${JSON.stringify({ version: 1, pid: process.pid, kind, tag: normalizedTag, createdAt: currentNow, token })}\n`,
        "utf8",
      );
      closeSync(descriptor);
      descriptor = undefined;
      protectPrivateFile(claimPath);
      let released = false;
      return {
        acquired: true,
        release() {
          if (released) return;
          released = true;
          try {
            const owner = JSON.parse(readFileSync(claimPath, "utf8"));
            if (owner?.token === token) unlinkSync(claimPath);
          } catch {
            // A concurrent controller either owns a replacement claim or the
            // file has already gone away. Never remove that controller's lock.
          }
        },
      };
    } catch (error) {
      if (descriptor !== undefined) {
        try { closeSync(descriptor); } catch {}
      }
      if (error?.code !== "EEXIST") throw error;

      let owner;
      try {
        owner = JSON.parse(readFileSync(claimPath, "utf8"));
      } catch {
        owner = null;
      }
      const ownerAlive = processIsAlive(Number(owner?.pid), kill);
      const createdAt = Number(owner?.createdAt);
      let mtimeFresh = false;
      try {
        const modifiedAt = statSync(claimPath).mtimeMs;
        mtimeFresh = Number.isFinite(modifiedAt) && currentNow - modifiedAt <= LOCAL_DOWNLOAD_CLAIM_STALE_MS;
      } catch {}
      const claimFresh = Number.isFinite(createdAt) && currentNow - createdAt <= LOCAL_DOWNLOAD_CLAIM_STALE_MS;
      // An empty/partially written claim is still a live claim. Do not unlink
      // it while its owner is between open() and write(); only a sufficiently
      // old unreadable file is recoverable.
      if (ownerAlive || claimFresh || (!owner && mtimeFresh)) return { acquired: false, owner };
      try {
        unlinkSync(claimPath);
      } catch (unlinkError) {
        if (unlinkError?.code !== "ENOENT") return { acquired: false, owner };
      }
    }
  }
  return { acquired: false };
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

export function reconcileLocalDownload(
  state,
  {
    now = Date.now(),
    kill = process.kill,
    timeoutMs = LOCAL_DOWNLOAD_HEARTBEAT_TIMEOUT_MS,
    persist = true,
  } = {},
) {
  if (!state || !isLocalOperationActive(state)) return state;
  const updatedAt = Number(state.updatedAt || state.startedAt || 0);
  const heartbeatFresh = Number.isFinite(updatedAt) && now - updatedAt <= timeoutMs;
  const workerAlive = processIsAlive(Number(state.workerPid), kill);
  // Older state files have no workerPid. Give a just-started preflight one
  // heartbeat window, but never let an abandoned record block installs forever.
  if ((state.workerPid && workerAlive && heartbeatFresh) || (!state.workerPid && heartbeatFresh)) {
    return state;
  }
  const recovered = {
    ...state,
    kind: state.kind || (state.status === "uninstalling" ? "uninstall" : "download"),
    status: "error",
    detail: "interrupted",
    error: state.status === "uninstalling"
      ? "The local model removal stopped before completion. Retry the removal."
      : "The local model download stopped before completion. Retry the install.",
    updatedAt: now,
  };
  if (persist) writeLocalDownload(recovered);
  return recovered;
}

export function cancelLocalDownload(
  requestedTag,
  {
    now = Date.now,
    kill = process.kill,
    spawn = spawnSync,
    platform = process.platform,
  } = {},
) {
  // Use one timestamp for reconciliation and the cancellation record. Tests
  // and callers that provide a clock should not accidentally have the active
  // operation marked stale by a second, real-time clock read.
  const currentNow = typeof now === "function" ? now() : now;
  const state = readLocalDownload({ kill, persist: true, now: currentNow });
  if (!isLocalOperationActive(state)) return { cancelled: false, state };
  const actualTag = canonicalLocalModelTag(state.tag);
  if (requestedTag !== undefined && requestedTag !== null && String(requestedTag).trim()) {
    const expectedTag = normalizeLocalModelTag(requestedTag);
    if (expectedTag !== actualTag) {
      throw new Error(`${state.tag} is the active local model operation.`);
    }
  }

  // During registry/runtime preflight there is no detached worker yet; the
  // controller PID is the cancellable process. Once the worker is handed off,
  // workerPid takes precedence and the controller has already returned.
  const pid = Number(state.workerPid || state.controllerPid);
  // Reconciliation already checked the recorded worker once. Stop it now
  // without probing a second time (the extra probe can itself race with the
  // worker exiting and, on Unix, sends an unnecessary second signal check).
  if (Number.isInteger(pid) && pid > 0 && pid !== process.pid) {
    if (platform === "win32") {
      const result = spawn("taskkill", ["/PID", String(pid), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true,
      });
      if (result?.status !== 0) {
        throw new Error("The local model operation could not be cancelled.");
      }
    } else {
      try {
        kill(pid, "SIGTERM");
      } catch (error) {
        if (error?.code !== "ESRCH") throw error;
      }
    }
  }

  const kind = state.kind || (state.status === "uninstalling" ? "uninstall" : "download");
  const cancelled = {
    ...state,
    kind,
    status: "cancelled",
    detail: kind === "uninstall" ? "Removal cancelled" : "Download cancelled",
    error: "Cancelled by user.",
    workerPid: null,
    controllerPid: null,
    updatedAt: currentNow,
  };
  writeLocalDownload(cancelled);
  return { cancelled: true, state: cancelled };
}

export function readLocalDownload(options) {
  if (!existsSync(LOCAL_DOWNLOAD_STATE_PATH)) return null;
  try {
    const parsed = JSON.parse(readFileSync(LOCAL_DOWNLOAD_STATE_PATH, "utf8"));
    return parsed?.version === 1 ? reconcileLocalDownload(parsed, options) : null;
  } catch {
    return null;
  }
}

export function writeLocalDownload(state) {
  writePrivateJson(LOCAL_DOWNLOAD_STATE_PATH, state, { space: 0, directoryMode: 0o700 });
  return state;
}

export async function downloadLocalModel(
  input,
  {
    ensureRuntime = ensureOllamaHeadless,
    pull = streamOllamaPull,
    enable = async (tag) => {
      const { setLocalModelEnabled } = await import("./local-models.mjs");
      return setLocalModelEnabled(tag, true);
    },
    capabilitiesFor,
    refreshCatalog = true,
    restartService = async () => {
      const { restartRouterServiceIfInstalled } = await import("./router-restart.mjs");
      return restartRouterServiceIfInstalled();
    },
    baseUrl = process.env.MODEL_ROUTER_LOCAL_BASE_URL || DEFAULT_LOCAL_VISION_BASE_URL,
    onProgress,
  } = {},
) {
  const tag = normalizeLocalModelTag(input);
  const existing = readLocalDownload();
  const existingTag = canonicalLocalModelTag(existing?.tag);
  if (existing?.status === "cancelled" && existingTag === tag) {
    return { tag, status: "cancelled", cancelled: true };
  }
  if (isLocalOperationActive(existing)) {
    const sameTag = existingTag === tag;
    const isThisWorker = Number(existing.workerPid) === process.pid;
    if (!sameTag) {
      throw new Error(`${existing.tag} is already ${existing.status === "uninstalling" ? "being removed" : "downloading"}.`);
    }
    if (!isThisWorker) {
      return { tag, status: existing.status, existing: true };
    }
  }
  const startedAt = Date.now();
  const cancelled = () => readLocalDownload()?.status === "cancelled";
  writeLocalDownload({
    version: 1,
    kind: "download",
    tag,
    status: "downloading",
    detail: "starting Ollama",
    percent: 0,
    startedAt,
    updatedAt: startedAt,
    workerPid: process.pid,
  });
  let lastPercent = -1;
  let lastDetail = "";
  try {
    await ensureRuntime({ install: false, baseUrl });
    if (cancelled()) return { tag, status: "cancelled", cancelled: true };
    await pull(tag, {
      baseUrl,
      onProgress: ({ detail, percent }) => {
        if (cancelled()) return;
        const shown = percent ?? lastPercent;
        if (shown === lastPercent && detail === lastDetail) return;
        lastPercent = shown;
        lastDetail = detail;
        writeLocalDownload({
          version: 1,
          kind: "download",
          tag,
          status: "downloading",
          detail,
          percent: shown < 0 ? 0 : shown,
          startedAt,
          updatedAt: Date.now(),
          workerPid: process.pid,
        });
        onProgress?.({ detail, percent: shown < 0 ? 0 : shown });
      },
    });
    if (cancelled()) return { tag, status: "cancelled", cancelled: true };
    const capabilities = capabilitiesFor
      ? capabilitiesFor(tag)
      : (await import("./local-models.mjs")).localModelCapabilities(tag);
    const canChat = capabilities.includes("tools");
    const { readLocalModelSelection } = await import("./local-models.mjs");
    const wasEnabled = readLocalModelSelection().enabled.includes(tag);
    let adoptedVision = false;
    if (canChat) await enable(tag);
    if (!canChat && capabilities.includes("vision")) {
      // A vision-only tag is still useful in the same Local LLM surface. It
      // becomes the first local reader only when no reader is already pinned;
      // downloading never silently replaces a measured engine.
      const {
        readVisionBridgeSettings,
        setVisionBridgeEnabled,
        setVisionBridgeLocal,
        visionBridgeConfigured,
      } = await import("./vision-bridge-state.mjs");
      const settings = readVisionBridgeSettings();
      // A missing state file is the default-on case. Once an operator has
      // explicitly turned the bridge off, a model download must never turn it
      // back on behind their back. An explicitly enabled bridge with no
      // engine is still safe to adopt for the first local reader.
      adoptedVision = !visionBridgeConfigured() || (settings.enabled === true && !settings.engine);
      if (adoptedVision) {
        setVisionBridgeLocal({ model: tag });
        setVisionBridgeEnabled(true);
      }
    }
    let catalogError;
    if (refreshCatalog) {
      try {
        const { spawnSync } = await import("node:child_process");
        const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
        const result = spawnSync(process.execPath, [path.join(repoRoot, "src", "catalog.mjs")], {
          cwd: repoRoot,
          env: { ...process.env, MODEL_ROUTER_TARGET: "codex" },
          stdio: "ignore",
          windowsHide: true,
        });
        if (result.status !== 0) catalogError = "The model was downloaded, but the Codex catalog needs a refresh.";
      } catch {
        catalogError = "The model was downloaded, but the Codex catalog needs a refresh.";
      }
    }
    let restartError;
    if (canChat && !wasEnabled) {
      try {
        await restartService();
      } catch (error) {
        restartError = error instanceof Error ? error.message : String(error);
      }
    }
    if (cancelled()) return { tag, status: "cancelled", cancelled: true };
    writeLocalDownload({
      version: 1,
      kind: "download",
      tag,
      status: "done",
      detail: catalogError
        ? "ready · catalog refresh needed"
        : restartError
          ? "ready · router restart needed"
          : canChat
          ? "ready"
          : adoptedVision
            ? "ready for images"
            : "downloaded · no tool calling",
      percent: 100,
      startedAt,
      updatedAt: Date.now(),
      workerPid: process.pid,
      ...(catalogError ? { catalogError } : {}),
      ...(restartError ? { restartError } : {}),
      capabilities,
      canChat,
      adoptedVision,
    });
    return { tag, status: "done", catalogError, restartError, capabilities, canChat, adoptedVision };
  } catch (error) {
    if (cancelled()) return { tag, status: "cancelled", cancelled: true };
    const message = error instanceof Error ? error.message : String(error);
    writeLocalDownload({
      version: 1,
      kind: "download",
      tag,
      status: "error",
      detail: "failed",
      percent: lastPercent < 0 ? 0 : lastPercent,
      error: message,
      startedAt,
      updatedAt: Date.now(),
      workerPid: process.pid,
    });
    throw error;
  }
}

async function main() {
  const input = process.argv[2];
  if (!input) throw new Error("A model tag or Ollama model URL is required.");
  await downloadLocalModel(input);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
