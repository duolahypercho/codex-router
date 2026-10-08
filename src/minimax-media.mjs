// MiniMax media generation CLI: video, music, speech, and image through the
// operator's stored MiniMax Token Plan credential. This is the executable
// behind the codex-router-media skill, so a routed model can generate media
// with a shell call instead of the router growing an inner tool loop.
//
// The credential is resolved through the router's own resolver and is never
// printed; results are reported as file paths and URLs only.
//
// CLI: node src/minimax-media.mjs ACTION [options]
import { createWriteStream } from "node:fs";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";

import { resolveProviderCredential } from "./provider-credentials.mjs";
import { PROVIDERS } from "./model-registry.mjs";

const PROVIDER_ID = "minimax-token-plan";

// Poll cadence for the async video task, matching MiniMax's documented
// recommendation. A 6s clip has been observed to take ~100s end to end.
const VIDEO_POLL_INTERVAL_MS = 10_000;
const VIDEO_POLL_LIMIT = 90; // 15 minutes

const DEFAULTS = {
  videoModel: "MiniMax-Hailuo-02",
  musicModel: "music-3.0",
  speechModel: "speech-02-turbo",
  imageModel: "image-01",
  voice: "male-qn-qingse",
};

const USAGE = `Usage: media ACTION [options]

Actions:
  video   --prompt TEXT [--model ${DEFAULTS.videoModel}] [--duration 6]
          [--resolution 768P|1080P] [--image PATH_OR_URL] [--out FILE]
  music   --prompt TEXT [--lyrics TEXT | --instrumental] [--out FILE]
  speech  --text TEXT [--voice ${DEFAULTS.voice}] [--speed 1.0] [--out FILE]
  image   --prompt TEXT [--ratio 1:1] [--count 1] [--out FILE]
  status  --task-id ID   (check a pending video task)

Every action spends MiniMax Token Plan quota. Results download next to the
current directory unless --out names a destination. Add --json for a
machine-readable result on stdout. Multiple images get numbered suffixes
before the output extension, or at the end of an extensionless filename.`;

export function parseArgs(argv) {
  const [action, ...rest] = argv;
  const options = {};
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    if (!arg.startsWith("--")) throw new Error(`Unexpected argument: ${arg}`);
    const name = arg.slice(2);
    if (name === "instrumental" || name === "json" || name === "no-download") {
      options[name] = true;
      continue;
    }
    const value = rest[i + 1];
    if (value === undefined) throw new Error(`Missing value for --${name}`);
    options[name] = value;
    i += 1;
  }
  return { action, options };
}

function mediaOrigin(provider) {
  const base = process.env.MINIMAX_BASE_URL?.trim() || provider.baseUrl;
  return new URL(base).origin;
}

function requireOption(options, name, flag = name) {
  const value = options[name];
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`--${flag} is required. ${USAGE}`);
  }
  return value.trim();
}

// MiniMax reports most failures inside a 200 body: base_resp.status_code is
// non-zero and status_msg carries the reason. Both layers are checked so an
// HTTP error and an in-band error read the same to the caller.
function assertMiniMaxOk(body, label) {
  const statusCode = body?.base_resp?.status_code;
  if (statusCode !== undefined && statusCode !== 0) {
    throw new Error(`${label} failed: ${body.base_resp.status_msg || `code ${statusCode}`}`);
  }
  const apiError = body?.error?.message;
  if (apiError) throw new Error(`${label} failed: ${apiError}`);
}

async function callMiniMax(context, label, pathname, init = {}) {
  const url = `${context.origin}${pathname}`;
  let response;
  try {
    response = await context.fetchImpl(url, {
      ...init,
      headers: {
        Authorization: `Bearer ${context.apiKey}`,
        "Content-Type": "application/json",
        ...(init.headers || {}),
      },
    });
  } catch (error) {
    throw new Error(`${label} failed: ${error?.message || "network error"}`);
  }
  const text = await response.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error(`${label} failed: HTTP ${response.status} with a non-JSON body`);
  }
  assertMiniMaxOk(body, label);
  if (!response.ok) {
    throw new Error(`${label} failed: HTTP ${response.status}`);
  }
  return body;
}

function timestampSlug(now) {
  return new Date(now).toISOString().replace(/[:.]/g, "-").slice(0, 19);
}

async function download(context, url, destination) {
  if (context.options["no-download"]) return null;
  const response = await context.fetchImpl(url);
  if (!response.ok || !response.body) {
    throw new Error(`Download failed: HTTP ${response.status}`);
  }
  const target = path.resolve(destination);
  const directory = path.dirname(target);
  mkdirSync(directory, { recursive: true });
  // Stage beside the destination so the final rename stays on one filesystem.
  // A failed transfer must neither truncate an existing result nor leave a
  // partial file looking like a complete one. Each download owns its staging
  // directory, including when two commands target the same output path.
  const staging = mkdtempSync(path.join(directory, ".minimax-download-"));
  try {
    let mode;
    try {
      const existing = statSync(target);
      if (existing.isFile()) mode = existing.mode & 0o777;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    const temporary = path.join(staging, "download");
    await pipeline(Readable.fromWeb(response.body), createWriteStream(temporary, { flags: "wx", mode }));
    // An existing destination kept its permissions under the old in-place
    // write. Restore them after the creation umask before replacing it.
    if (mode !== undefined) chmodSync(temporary, mode);
    renameSync(temporary, target);
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
  return destination;
}

function outputPath(context, extension) {
  const named = context.options.out;
  if (named) return named;
  return `minimax-${context.action}-${timestampSlug(context.now())}.${extension}`;
}

// A local image becomes a data URL; anything already URL-shaped passes
// through for MiniMax to fetch itself.
export function firstFrameImage(value) {
  if (/^(https?:|data:)/i.test(value)) return value;
  const bytes = readFileSync(value);
  const extension = path.extname(value).toLowerCase().replace(".", "") || "png";
  const mime = extension === "jpg" ? "jpeg" : extension;
  return `data:image/${mime};base64,${bytes.toString("base64")}`;
}

async function videoTaskResult(context, taskId) {
  const poll = await callMiniMax(
    context,
    "Video status",
    `/v1/query/video_generation?task_id=${encodeURIComponent(taskId)}`,
  );
  if (poll.status === "Fail") {
    throw new Error(`Video generation failed: ${poll.base_resp?.status_msg || "provider reported Fail"}`);
  }
  if (poll.status !== "Success") return { pending: true, status: poll.status };
  const file = await callMiniMax(
    context,
    "Video file lookup",
    `/v1/files/retrieve?file_id=${encodeURIComponent(poll.file_id)}`,
  );
  const url = file.file?.download_url;
  if (!url) throw new Error("Video file lookup returned no download URL.");
  return { pending: false, url };
}

async function generateVideo(context) {
  const model = context.options.model || DEFAULTS.videoModel;
  // Observed live: the Token Plan subscription is refused for the H3 series
  // with error 2013. Say so up front instead of relaying the raw code.
  if (/^minimax-h3/i.test(model)) {
    throw new Error(
      "MiniMax-H3 video is not available on the Token Plan subscription. " +
        `Use the default ${DEFAULTS.videoModel} instead.`,
    );
  }
  const payload = {
    model,
    prompt: requireOption(context.options, "prompt"),
    duration: Number(context.options.duration || 6),
    resolution: context.options.resolution || "768P",
  };
  if (context.options.image) payload.first_frame_image = firstFrameImage(context.options.image);
  const submit = await callMiniMax(context, "Video generation", "/v1/video_generation", {
    method: "POST",
    body: JSON.stringify(payload),
  });
  const taskId = submit.task_id;
  if (!taskId) throw new Error("Video generation returned no task_id.");
  context.log(`Video task ${taskId} submitted; rendering usually takes 1-3 minutes.`);
  for (let attempt = 0; attempt < VIDEO_POLL_LIMIT; attempt += 1) {
    await context.sleep(VIDEO_POLL_INTERVAL_MS);
    const result = await videoTaskResult(context, taskId);
    if (result.pending) {
      context.log(`  …${result.status}`);
      continue;
    }
    const saved = await download(context, result.url, outputPath(context, "mp4"));
    return { action: "video", taskId, url: result.url, file: saved };
  }
  throw new Error(
    `Video task ${taskId} is still rendering. Check later with: media status --task-id ${taskId}`,
  );
}

async function videoStatus(context) {
  const taskId = requireOption(context.options, "task-id");
  const result = await videoTaskResult(context, taskId);
  if (result.pending) return { action: "status", taskId, status: result.status };
  const saved = await download(context, result.url, outputPath(context, "mp4"));
  return { action: "status", taskId, status: "Success", url: result.url, file: saved };
}

async function generateMusic(context) {
  const body = await callMiniMax(context, "Music generation", "/v1/music_generation", {
    method: "POST",
    body: JSON.stringify({
      model: context.options.model || DEFAULTS.musicModel,
      prompt: requireOption(context.options, "prompt"),
      // "[inst]" is MiniMax's marker for an instrumental-only track.
      lyrics: context.options.instrumental ? "[inst]" : requireOption(context.options, "lyrics"),
      audio_setting: { sample_rate: 44100, bitrate: 256000, format: "mp3" },
      output_format: "url",
    }),
  });
  const url = body.data?.audio;
  if (!url) throw new Error("Music generation returned no audio URL.");
  const saved = await download(context, url, outputPath(context, "mp3"));
  return { action: "music", url, file: saved, durationMs: body.extra_info?.music_duration };
}

async function generateSpeech(context) {
  const body = await callMiniMax(context, "Speech generation", "/v1/t2a_v2", {
    method: "POST",
    body: JSON.stringify({
      model: context.options.model || DEFAULTS.speechModel,
      text: requireOption(context.options, "text"),
      stream: false,
      voice_setting: {
        voice_id: context.options.voice || DEFAULTS.voice,
        speed: Number(context.options.speed || 1),
      },
      audio_setting: { sample_rate: 32000, bitrate: 128000, format: "mp3" },
      output_format: "url",
    }),
  });
  const url = body.data?.audio;
  if (!url) throw new Error("Speech generation returned no audio URL.");
  const saved = await download(context, url, outputPath(context, "mp3"));
  return { action: "speech", url, file: saved };
}

async function generateImage(context) {
  const body = await callMiniMax(context, "Image generation", "/v1/image_generation", {
    method: "POST",
    body: JSON.stringify({
      model: context.options.model || DEFAULTS.imageModel,
      prompt: requireOption(context.options, "prompt"),
      aspect_ratio: context.options.ratio || "1:1",
      n: Number(context.options.count || 1),
      response_format: "url",
    }),
  });
  const urls = body.data?.image_urls || [];
  if (!urls.length) throw new Error("Image generation returned no images.");
  const files = [];
  const base = outputPath(context, "jpeg");
  const extension = path.extname(base);
  const stem = base.slice(0, base.length - extension.length);
  for (const [index, url] of urls.entries()) {
    const destination =
      urls.length === 1 ? base : `${stem}-${index + 1}${extension}`;
    files.push(await download(context, url, destination));
  }
  return { action: "image", urls, files: files.filter(Boolean) };
}

const ACTIONS = {
  video: generateVideo,
  music: generateMusic,
  speech: generateSpeech,
  image: generateImage,
  status: videoStatus,
};

export async function runMedia(argv, hooks = {}) {
  const { action, options } = parseArgs(argv);
  const emit = hooks.emit || ((line) => console.log(line));
  if (!action || action === "--help" || action === "help") {
    emit(USAGE);
    return null;
  }
  const handler = ACTIONS[action];
  if (!handler) throw new Error(`Unknown action: ${action}. ${USAGE}`);
  const provider = hooks.provider || PROVIDERS.get(PROVIDER_ID);
  if (!provider) throw new Error(`Provider ${PROVIDER_ID} is not in the registry.`);
  const credential = (hooks.resolveCredential || resolveProviderCredential)(provider);
  if (!credential) {
    throw new Error(
      "No MiniMax Token Plan credential. Store one with: " +
        "model-router codex provider-key minimax-token-plan set",
    );
  }
  const quiet = Boolean(options.json);
  const context = {
    action,
    options,
    origin: mediaOrigin(provider),
    apiKey: credential.value,
    fetchImpl: hooks.fetchImpl || fetch,
    sleep: hooks.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
    now: hooks.now || Date.now,
    log: quiet ? () => {} : hooks.log || ((line) => console.error(line)),
  };
  const result = await handler(context);
  if (options.json) {
    emit(JSON.stringify(result));
  } else if (result.file) {
    emit(`Saved: ${result.file}`);
  } else if (result.files) {
    for (const file of result.files) emit(`Saved: ${file}`);
  } else if (result.status) {
    emit(`Task ${result.taskId}: ${result.status}`);
  }
  return result;
}

const isMain =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  runMedia(process.argv.slice(2)).catch((error) => {
    console.error(error.message || String(error));
    process.exit(1);
  });
}
