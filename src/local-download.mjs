import {
  existsSync,
  readFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { writePrivateJson } from "./file-security.mjs";
import { STATE_DIR } from "./paths.mjs";
import { ensureOllamaHeadless } from "./ollama-runtime.mjs";
import { normalizeLocalModelTag } from "./local-model-ref.mjs";
import { streamOllamaPull } from "./vision-download.mjs";
import { DEFAULT_LOCAL_VISION_BASE_URL } from "./vision-bridge.mjs";

export const LOCAL_DOWNLOAD_STATE_PATH =
  process.env.MODEL_ROUTER_LOCAL_DOWNLOAD_STATE ||
  path.join(STATE_DIR, "local-model-download.json");

export const LOCAL_DOWNLOAD_HEARTBEAT_TIMEOUT_MS = 5 * 60 * 1_000;

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
  if (!state || state.status !== "downloading") return state;
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
    status: "error",
    detail: "interrupted",
    error: "The local model download stopped before completion. Retry the install.",
    updatedAt: now,
  };
  if (persist) writeLocalDownload(recovered);
  return recovered;
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
  const startedAt = Date.now();
  writeLocalDownload({
    version: 1,
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
    await pull(tag, {
      baseUrl,
      onProgress: ({ detail, percent }) => {
        const shown = percent ?? lastPercent;
        if (shown === lastPercent && detail === lastDetail) return;
        lastPercent = shown;
        lastDetail = detail;
        writeLocalDownload({
          version: 1,
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
    writeLocalDownload({
      version: 1,
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
    const message = error instanceof Error ? error.message : String(error);
    writeLocalDownload({
      version: 1,
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
