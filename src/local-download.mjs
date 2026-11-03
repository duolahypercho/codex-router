import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { ownerLeaseEndpoint, startOwnerServer, closeOwnerServer } from "./kernel-owner-lease.mjs";
import { writePrivateJson } from "./file-security.mjs";
import {
  applyModelOverlayPublication,
  transactModelOverlayMutation,
} from "./model-overlay-publication.mjs";
import { PROVIDER_SELECTION_PATH, STATE_DIR } from "./paths.mjs";
import { ensureOllamaHeadless } from "./ollama-runtime.mjs";
import { canonicalLocalModelTag, normalizeLocalModelTag } from "./local-model-ref.mjs";
import { streamOllamaPull } from "./vision-download.mjs";
import { DEFAULT_LOCAL_VISION_BASE_URL } from "./vision-bridge.mjs";
import { USER_MODELS_PATH } from "./user-models.mjs";

export const LOCAL_DOWNLOAD_STATE_PATH =
  process.env.MODEL_ROUTER_LOCAL_DOWNLOAD_STATE ||
  path.join(STATE_DIR, "local-model-download.json");

export const LOCAL_DOWNLOAD_CLAIM_PATH =
  process.env.MODEL_ROUTER_LOCAL_DOWNLOAD_CLAIM || `${LOCAL_DOWNLOAD_STATE_PATH}.claim`;

export const LOCAL_DOWNLOAD_HEARTBEAT_TIMEOUT_MS = 5 * 60 * 1_000;

export const LOCAL_DOWNLOAD_ACTIVE_STATUSES = Object.freeze(["downloading", "uninstalling"]);

export function isLocalOperationActive(state) {
  return LOCAL_DOWNLOAD_ACTIVE_STATUSES.includes(state?.status);
}

// The OS owns this short controller gate until release or process death.
// A busy/colliding endpoint grants no permission to seed another operation.
export async function claimLocalOperation(tag, kind, { claimPath = LOCAL_DOWNLOAD_CLAIM_PATH } = {}) {
  normalizeLocalModelTag(tag);
  mkdirSync(path.dirname(claimPath), { recursive: true, mode: 0o700 });
  let identity = path.join(realpathSync.native(path.dirname(claimPath)), path.basename(claimPath));
  if (process.platform === "win32") identity = identity.toLowerCase();
  const endpoint = ownerLeaseEndpoint("controller", identity, 30_000, { family: "local-operation" });
  try {
    const server = await startOwnerServer(endpoint);
    return { acquired: true, release: () => closeOwnerServer({ server }) };
  } catch (error) {
    if (["EADDRINUSE", "EACCES"].includes(error?.code)) return { acquired: false };
    throw error;
  }
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
    finalizePublication = applyModelOverlayPublication,
    restartService = async (operation) => {
      const { restartRouterServiceIfInstalled } = await import("./router-restart.mjs");
      return restartRouterServiceIfInstalled(operation);
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
    const { LOCAL_MODELS_STATE_PATH, isLocalModelEnabled } = await import(
      "./local-models.mjs"
    );
    const visionState = await import("./vision-bridge-state.mjs");
    let shouldAdoptVision = false;
    const overlayFiles = [
      LOCAL_MODELS_STATE_PATH,
      USER_MODELS_PATH,
      PROVIDER_SELECTION_PATH,
      visionState.VISION_BRIDGE_STATE_PATH,
    ];
    const activate = async () => {
      if (!canChat && capabilities.includes("vision")) {
        // A vision-only tag is still useful in the same Local LLM surface. It
        // becomes the first local reader only when no reader is already pinned;
        // downloading never silently replaces a measured engine. Read this
        // decision after the transaction lock is held, beside the snapshot.
        const settings = visionState.readVisionBridgeSettings();
        // A missing state file is the default-on case. Once an operator has
        // explicitly turned the bridge off, a model download must never turn it
        // back on behind their back. An explicitly enabled bridge with no
        // engine is still safe to adopt for the first local reader.
        shouldAdoptVision = !visionState.visionBridgeConfigured() ||
          (settings.enabled === true && !settings.engine);
      }
      if (canChat) await enable(tag);
      if (shouldAdoptVision) {
        visionState.setVisionBridgeLocal({ model: tag });
        visionState.setVisionBridgeEnabled(true);
      }
    };
    let catalogError;
    let restartError;
    let activationRolledBack = false;
    let adoptedVision = false;
    // The restart decision is evaluated under the same lock as the snapshot,
    // so a concurrent local-model toggle cannot make this worker skip the
    // reload that publishes its newly enabled route.
    const restart = () => canChat && !isLocalModelEnabled(tag);
    if (refreshCatalog) {
      try {
        const publication = await transactModelOverlayMutation({
          files: overlayFiles,
          mutate: activate,
          restart,
          warningOnly: true,
          applyPublication: finalizePublication,
          restartService,
        });
        adoptedVision = shouldAdoptVision;
        catalogError = publication?.catalogError;
        restartError = publication?.restartError;
      } catch (error) {
        catalogError = error instanceof Error ? error.message : String(error);
        activationRolledBack = true;
      }
    } else {
      // Kept for focused callers that deliberately suppress publication while
      // exercising the worker. Production completion always takes the branch
      // above, where publication precedes this same restart.
      await transactModelOverlayMutation({
        files: overlayFiles,
        mutate: activate,
        restart,
        warningOnly: true,
        applyPublication: async ({ restart: shouldRestart, signal, deadline }) => {
          if (!shouldRestart) return {};
          try {
            await restartService({ signal, deadline });
            return {};
          } catch (error) {
            return { restartError: error instanceof Error ? error.message : String(error) };
          }
        },
      });
      adoptedVision = shouldAdoptVision;
    }
    if (cancelled()) return { tag, status: "cancelled", cancelled: true };
    writeLocalDownload({
      version: 1,
      kind: "download",
      tag,
      status: "done",
      detail: activationRolledBack
        ? "downloaded · activation rolled back"
        : catalogError
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
      ...(activationRolledBack ? { activationRolledBack: true } : {}),
      capabilities,
      canChat,
      adoptedVision,
    });
    return {
      tag,
      status: "done",
      catalogError,
      restartError,
      activationRolledBack,
      capabilities,
      canChat,
      adoptedVision,
    };
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
