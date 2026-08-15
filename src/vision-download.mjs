import {
  existsSync,
  readFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { writePrivateJson } from "./file-security.mjs";
import { STATE_DIR } from "./paths.mjs";
import { DEFAULT_LOCAL_VISION_BASE_URL } from "./vision-bridge.mjs";

// A vision model is gigabytes, so the download cannot block whoever asked for
// it: the tray would sit frozen for minutes and read as crashed. The request
// starts a detached worker that streams Ollama's pull API and records progress
// here; the caller returns immediately and polls this file.
export const VISION_DOWNLOAD_STATE_PATH =
  process.env.MODEL_ROUTER_VISION_DOWNLOAD_STATE ||
  path.join(STATE_DIR, "vision-download.json");

export function readVisionDownload() {
  if (!existsSync(VISION_DOWNLOAD_STATE_PATH)) return null;
  try {
    const parsed = JSON.parse(readFileSync(VISION_DOWNLOAD_STATE_PATH, "utf8"));
    return parsed?.version === 1 ? parsed : null;
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
  for await (const chunk of response.body) {
    buffer += decoder.decode(chunk, { stream: true });
    const { events, remainder } = parseNdjsonLines(buffer);
    buffer = remainder;
    for (const event of events) {
      if (event.error) throw new Error(String(event.error));
      if (event.status === "success") sawSuccess = true;
      const percent = tracker.update(event);
      onProgress?.({ detail: String(event.status || "downloading"), percent });
    }
  }
  if (!sawSuccess) throw new Error("The download ended before Ollama confirmed success.");
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
        });
      },
    });
    // The model only becomes the reader once it is actually on disk, so a
    // failed or cancelled download never repoints the bridge at a missing one.
    const { readVisionBridgeSettings, setVisionBridgeEnabled, setVisionBridgeLocal } = await import(
      "./vision-bridge-state.mjs"
    );
    // Downloading is not choosing. A freshly pulled model is unmeasured, and
    // silently promoting it over a reader that is known to work would swap an
    // accurate transcript for a possibly fabricated one without the operator
    // ever asking. So it becomes the engine only when there is nothing else --
    // the first-run case, where any reader beats none. Otherwise the picker's
    // Use button (and its measured label) makes the call.
    const settings = readVisionBridgeSettings();
    const adopt = !settings.enabled || !settings.engine;
    if (adopt) {
      setVisionBridgeLocal({ model: tag });
      setVisionBridgeEnabled(true);
    }
    writeVisionDownload({
      ...base,
      status: "done",
      detail: adopt ? "ready" : "downloaded",
      adopted: adopt,
      percent: 100,
      updatedAt: Date.now(),
    });
  } catch (error) {
    writeVisionDownload({
      ...base,
      status: "error",
      detail: "failed",
      percent: lastPercent < 0 ? 0 : lastPercent,
      error: error instanceof Error ? error.message : String(error),
      updatedAt: Date.now(),
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
