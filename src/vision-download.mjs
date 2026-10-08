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
import path from "node:path";
import { fileURLToPath } from "node:url";

import { protectPrivateFile, writePrivateJson } from "./file-security.mjs";
import {
  applyModelOverlayPublication,
  transactModelOverlayMutation,
} from "./model-overlay-publication.mjs";
import { STATE_DIR } from "./paths.mjs";
import { DEFAULT_LOCAL_VISION_BASE_URL } from "./vision-bridge.mjs";

// A vision model is gigabytes, so the download cannot block whoever asked for
// it: the tray would sit frozen for minutes and read as crashed. The request
// starts a detached worker that streams Ollama's pull API and records progress
// here; the caller returns immediately and polls this file.
export const VISION_DOWNLOAD_STATE_PATH =
  process.env.MODEL_ROUTER_VISION_DOWNLOAD_STATE ||
  path.join(STATE_DIR, "vision-download.json");

export const VISION_DOWNLOAD_CLAIM_PATH =
  process.env.MODEL_ROUTER_VISION_DOWNLOAD_CLAIM || `${VISION_DOWNLOAD_STATE_PATH}.claim`;

const VISION_DOWNLOAD_CLAIM_STALE_MS = 30 * 1_000;
export const VISION_DOWNLOAD_HEARTBEAT_TIMEOUT_MS = 5 * 60 * 1_000;

export function readVisionDownload(options) {
  if (!existsSync(VISION_DOWNLOAD_STATE_PATH)) return null;
  try {
    const parsed = JSON.parse(readFileSync(VISION_DOWNLOAD_STATE_PATH, "utf8"));
    return parsed?.version === 1 ? reconcileVisionDownload(parsed, options) : null;
  } catch {
    // A half-written progress file is not worth an error: the next update
    // rewrites it, and a missing one just means "no download in flight".
    return null;
  }
}

export function writeVisionDownload(state) {
  writePrivateJson(VISION_DOWNLOAD_STATE_PATH, state, { space: 0, directoryMode: 0o700 });
  return state;
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

export function reconcileVisionDownload(
  state,
  {
    now = Date.now(),
    kill = process.kill,
    timeoutMs = VISION_DOWNLOAD_HEARTBEAT_TIMEOUT_MS,
    persist = true,
  } = {},
) {
  if (!state || state.status !== "downloading") return state;
  const updatedAt = Number(state.updatedAt || state.startedAt || 0);
  const heartbeatFresh = Number.isFinite(updatedAt) && now - updatedAt <= timeoutMs;
  const ownerPid = Number(state.workerPid || state.controllerPid);
  const ownerAlive = processIsAlive(ownerPid, kill);
  // Legacy records have no PID. Give a fresh one a single heartbeat window,
  // but a record whose named controller/worker is dead is retryable at once.
  if ((ownerPid && ownerAlive && heartbeatFresh) || (!ownerPid && heartbeatFresh)) return state;
  const interrupted = {
    ...state,
    status: "error",
    detail: "interrupted",
    error: "The vision model download stopped before completion. Retry the download.",
    controllerPid: null,
    workerPid: null,
    updatedAt: now,
  };
  if (persist) writeVisionDownload(interrupted);
  return interrupted;
}

// The state write is atomic, but read-then-write is not. Keep the controller's
// tiny seed-and-spawn section exclusive so two UI clicks cannot start two
// multi-gigabyte pulls before either one has made its state visible.
export function claimVisionDownloadStart({
  claimPath = VISION_DOWNLOAD_CLAIM_PATH,
  now = Date.now,
} = {}) {
  const currentNow = typeof now === "function" ? now() : now;
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
        `${JSON.stringify({ version: 1, pid: process.pid, createdAt: currentNow, token })}\n`,
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
            // A replacement claim belongs to another controller.
          }
        },
      };
    } catch (error) {
      if (descriptor !== undefined) {
        try { closeSync(descriptor); } catch {}
      }
      if (error?.code !== "EEXIST") throw error;
      let fresh = true;
      try {
        fresh = currentNow - statSync(claimPath).mtimeMs <= VISION_DOWNLOAD_CLAIM_STALE_MS;
      } catch {
        fresh = false;
      }
      if (fresh) return { acquired: false };
      try {
        unlinkSync(claimPath);
      } catch (unlinkError) {
        if (unlinkError?.code !== "ENOENT") return { acquired: false };
      }
    }
  }
  return { acquired: false };
}

export function activeVisionDownloadResult(state, tag) {
  if (state?.status !== "downloading") return null;
  if (state.tag !== tag) {
    throw new Error(`${state.tag} is already downloading (${state.percent || 0}%).`);
  }
  return {
    started: false,
    existing: true,
    tag,
    percent: state.percent || 0,
  };
}

// Ollama reports progress per layer, so a single layer's completed/total jumps
// back to zero when the next one starts. Summing every layer seen so far gives
// one number that only moves forward, which is what a progress bar needs.
export function createProgressTracker() {
  const layers = new Map();
  return {
    update(event) {
      const key = event?.digest || event?.status;
      if (!key || !Number.isFinite(event?.total) || event.total <= 0) return undefined;
      layers.set(key, {
        completed: Number.isFinite(event.completed) ? event.completed : 0,
        total: event.total,
      });
      let completed = 0;
      let total = 0;
      for (const layer of layers.values()) {
        completed += layer.completed;
        total += layer.total;
      }
      if (total <= 0) return undefined;
      return Math.max(0, Math.min(100, Math.round((completed / total) * 100)));
    },
  };
}

export function parseNdjsonLines(buffer) {
  const lines = buffer.split("\n");
  const remainder = lines.pop() ?? "";
  const events = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      events.push(JSON.parse(trimmed));
    } catch {
      // Ollama only emits JSON objects here; anything else is noise.
    }
  }
  return { events, remainder };
}

// Streams `POST /api/pull` and reports progress through `onProgress`. Resolves
// when the model is on disk, rejects with a plain message otherwise.
export async function streamOllamaPull(
  tag,
  { baseUrl = DEFAULT_LOCAL_VISION_BASE_URL, fetchImpl = fetch, onProgress } = {},
) {
  // The pull endpoint sits on the daemon root, not under the OpenAI-compatible
  // /v1 prefix the bridge uses for inference.
  const root = String(baseUrl).replace(/\/+$/, "").replace(/\/v1$/, "");
  let response;
  try {
    response = await fetchImpl(`${root}/api/pull`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: tag, stream: true }),
    });
  } catch {
    throw new Error("Could not reach Ollama. Is it installed and running?");
  }
  if (!response.ok) {
    throw new Error(`Ollama refused the download (HTTP ${response.status}).`);
  }
  const tracker = createProgressTracker();
  const decoder = new TextDecoder();
  let buffer = "";
  let sawSuccess = false;
  const reportEvents = (events) => {
    for (const event of events) {
      if (event.error) throw new Error(String(event.error));
      if (event.status === "success") sawSuccess = true;
      const percent = tracker.update(event);
      onProgress?.({ detail: String(event.status || "downloading"), percent });
    }
  };
  for await (const chunk of response.body) {
    buffer += decoder.decode(chunk, { stream: true });
    const { events, remainder } = parseNdjsonLines(buffer);
    buffer = remainder;
    reportEvents(events);
  }
  // EOF also closes the last record. The daemon (or a proxy) need not send a
  // final line feed, and leaving the carry unread loses both success and error
  // records. Flush the decoder before parsing, preserving split UTF-8 text.
  reportEvents(parseNdjsonLines(`${buffer}${decoder.decode()}\n`).events);
  if (!sawSuccess) throw new Error("The download ended before Ollama confirmed success.");
}

export function shouldAdoptDownloadedVisionModel(settings, configured) {
  return !configured || (settings?.enabled === true && !settings?.engine);
}

// Pulling has already completed by the time this runs. Publication failures
// therefore become progress-state warnings; they must never rewrite a model
// that is physically on disk as a failed download.
export async function finalizeVisionDownload(
  tag,
  {
    readSettings,
    configured,
    setLocal,
    setEnabled,
    finalizePublication = applyModelOverlayPublication,
  } = {},
) {
  if (!readSettings || !configured || !setLocal || !setEnabled) {
    const state = await import("./vision-bridge-state.mjs");
    readSettings ||= state.readVisionBridgeSettings;
    configured ||= state.visionBridgeConfigured;
    setLocal ||= state.setVisionBridgeLocal;
    setEnabled ||= state.setVisionBridgeEnabled;
  }

  const state = await import("./vision-bridge-state.mjs");
  let adopt = false;
  try {
    const publication = await transactModelOverlayMutation({
      files: [state.VISION_BRIDGE_STATE_PATH],
      mutate: () => {
        // The adoption decision belongs inside the same lock as the snapshot:
        // another bridge choice must not be observed before capture and then
        // silently overwritten by a stale first-reader decision.
        adopt = shouldAdoptDownloadedVisionModel(readSettings(), configured());
        if (adopt) {
          setLocal({ model: tag });
          setEnabled(true);
        }
      },
      warningOnly: true,
      applyPublication: finalizePublication,
    });
    return {
      adopt,
      ...(publication?.catalogError ? { catalogError: publication.catalogError } : {}),
    };
  } catch (error) {
    return {
      adopt: false,
      activationRolledBack: adopt,
      catalogError: error instanceof Error ? error.message : String(error),
    };
  }
}

async function main() {
  const tag = process.argv[2];
  if (!tag) throw new Error("A model tag is required.");
  const startedAt = Date.now();
  const base = { version: 1, tag, startedAt };
  writeVisionDownload({
    ...base,
    status: "downloading",
    detail: "starting",
    percent: 0,
    updatedAt: startedAt,
    controllerPid: null,
    workerPid: process.pid,
  });
  // Rewriting on every event would rename the file hundreds of times a second
  // for no visible gain; a change of one percent is the smallest a progress
  // bar can show.
  let lastPercent = -1;
  let lastDetail = "";
  try {
    await streamOllamaPull(tag, {
      onProgress: ({ detail, percent }) => {
        const shown = percent ?? lastPercent;
        if (shown === lastPercent && detail === lastDetail) return;
        lastPercent = shown;
        lastDetail = detail;
        writeVisionDownload({
          ...base,
          status: "downloading",
          detail,
          percent: shown < 0 ? 0 : shown,
          updatedAt: Date.now(),
          controllerPid: null,
          workerPid: process.pid,
        });
      },
    });
    // The model only becomes the reader once it is actually on disk, so a
    // failed or cancelled download never repoints the bridge at a missing one.
    // Downloading is not choosing. A freshly pulled model is unmeasured, and
    // silently promoting it over a reader that is known to work would swap an
    // accurate transcript for a possibly fabricated one without the operator
    // ever asking. So it becomes the engine only when there is nothing else --
    // the first-run case, where any reader beats none. Otherwise the picker's
    // Use button (and its measured label) makes the call.
    const publication = await finalizeVisionDownload(tag);
    const { adopt, activationRolledBack, catalogError } = publication;
    writeVisionDownload({
      ...base,
      status: "done",
      detail: activationRolledBack
        ? "downloaded · activation rolled back"
        : catalogError
        ? `${adopt ? "ready" : "downloaded"} · catalog refresh needed`
        : adopt
          ? "ready"
          : "downloaded",
      adopted: adopt,
      percent: 100,
      updatedAt: Date.now(),
      controllerPid: null,
      workerPid: null,
      ...(catalogError ? { catalogError } : {}),
      ...(activationRolledBack ? { activationRolledBack: true } : {}),
    });
  } catch (error) {
    writeVisionDownload({
      ...base,
      status: "error",
      detail: "failed",
      percent: lastPercent < 0 ? 0 : lastPercent,
      error: error instanceof Error ? error.message : String(error),
      updatedAt: Date.now(),
      controllerPid: null,
      workerPid: null,
    });
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
