import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  ollamaCommand,
  ollamaAvailable as runtimeOllamaAvailable,
  ollamaInstallHint,
} from "./ollama-runtime.mjs";
import { STATE_DIR } from "./paths.mjs";
import {
  DEFAULT_LOCAL_VISION_BASE_URL,
  DEFAULT_LOCAL_VISION_MODEL,
} from "./vision-bridge.mjs";

// Deliberately a function, not a top-level constant. Building the hint asks
// `ollamaInstallPlan` which package manager is present, and that is a
// synchronous `brew --version` (~200 ms here). As a constant it ran on every
// import of this module -- including the static start.mjs -> local-models.mjs
// chain -- so every router start paid for a string almost nobody reads.
let cachedInstallHint;
export function ollamaInstallMessage() {
  cachedInstallHint ??= `Install Ollama (${ollamaInstallHint()}), then retry.`;
  return cachedInstallHint;
}

// A runtime is the operator's own software. This helper only reports whether
// the CLI is present; the local-model install flow may install it after the
// operator explicitly clicks/approves a model download.
export function ollamaAvailable({ spawn = spawnSync } = {}) {
  return runtimeOllamaAvailable({ spawn });
}

// A model download is gigabytes, so it is never silent: the caller passes an
// explicit consent flag (a --yes on the CLI, or a confirmed installer prompt).
//
// The runtime resolver, not the bare name: `ollamaAvailable()` above finds
// Ollama through its known install locations, which on Windows is a
// %LOCALAPPDATA% path the router's own PATH may never have seen. Probing with
// one resolver and running with another reported an installed Ollama and then
// failed to spawn it.
export function pullOllamaModel(model, { spawn = spawnSync } = {}) {
  const command = ollamaCommand({ spawn });
  if (!command) throw new Error(`\`ollama pull ${model}\` failed: ${ollamaInstallMessage()}`);
  const result = spawn(command, ["pull", model], { stdio: "inherit" });
  if (result.status !== 0) {
    throw new Error(`\`ollama pull ${model}\` failed (exit ${result.status ?? "unknown"}).`);
  }
  return model;
}

// Reads the local Ollama store directly (not the serving endpoint) so a model
// pulled but not currently loaded still counts as installed. Returns the tags
// as Ollama reports them (e.g. "qwen2.5vl:3b", "moondream:latest").
export function ollamaInstalledModels({ spawn = spawnSync } = {}) {
  try {
    const command = ollamaCommand({ spawn });
    if (!command) return [];
    const result = spawn(command, ["list"], { encoding: "utf8", windowsHide: true });
    if (result.status !== 0 || typeof result.stdout !== "string") return [];
    return result.stdout
      .split("\n")
      .slice(1) // drop the NAME/ID/SIZE header
      .map((line) => line.trim().split(/\s+/)[0])
      .filter((name) => name && name.includes(":"));
  } catch {
    return [];
  }
}

// A curated shortlist of small vision models the bridge can drive. Sizes are
// the Ollama download sizes (approximate); minRamGib is the comfortable floor
// for the q4 build.
//
// `accuracy` is measured, never assumed: `src/vision-benchmark.mjs` reads one
// checked-in image with known contents and scores how much comes back
// verbatim. This matters more than any other field here — a model that invents
// an invoice number is worse than no model, because the text-only model
// downstream repeats the invention as fact. Two well-known models score zero
// on text, so the picker has to say which ones actually read.
//
//   accurate      >=80% of codes, numbers, and dates transcribed exactly
//   partial       40-79%
//   captions-only <40% — describes the scene, fabricates the details
//   untested      not measured on this machine's benchmark yet
export const LOCAL_VISION_CATALOG = Object.freeze([
  {
    tag: "qwen2.5vl:3b",
    label: "Qwen2.5-VL 3B",
    sizeGb: 3.2,
    minRamGib: 8,
    recommended: true,
    accuracy: "accurate",
    measured: { percent: 75, textPercent: 100, seconds: 23 },
    note: "Reads codes, numbers, and dates exactly. The default choice.",
  },
  {
    tag: "qwen2.5vl:7b",
    label: "Qwen2.5-VL 7B",
    sizeGb: 6.0,
    minRamGib: 16,
    accuracy: "untested",
    note: "Larger sibling of the 3B. Not benchmarked here yet.",
  },
  {
    tag: "llama3.2-vision:11b",
    label: "Llama 3.2 Vision 11B",
    sizeGb: 7.9,
    minRamGib: 16,
    accuracy: "untested",
    note: "Strongest reasoning of the set. Not benchmarked here yet.",
  },
  {
    tag: "moondream",
    label: "Moondream",
    sizeGb: 1.7,
    minRamGib: 4,
    accuracy: "captions-only",
    measured: { percent: 19, textPercent: 0, seconds: 4 },
    note: "Tiny and quick, but transcribed none of the test text.",
  },
  {
    tag: "llava",
    label: "LLaVA 7B",
    sizeGb: 4.7,
    minRamGib: 8,
    accuracy: "captions-only",
    measured: { percent: 0, textPercent: 0, seconds: 37 },
    note: "Scored zero on the benchmark and is the slowest. Avoid for text.",
  },
]);

// Ranked so the picker never puts a confident-wrong reader at the top: proven
// readers first, unmeasured models next, caption-only models last. Size breaks
// ties, keeping the cheapest download first within a tier.
const ACCURACY_RANK = { accurate: 0, partial: 1, untested: 2, "captions-only": 3 };

export const MODEL_SIZE_CACHE_PATH =
  process.env.MODEL_ROUTER_VISION_SIZE_CACHE ||
  path.join(STATE_DIR, "vision-model-sizes.json");
const SIZE_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const REGISTRY_BASE = process.env.MODEL_ROUTER_OLLAMA_REGISTRY || "https://registry.ollama.ai";

// The catalog's sizes are hand-written approximations that drift whenever a
// model is requantized. Ollama's registry publishes the real layer sizes per
// tag, so the picker can show the download the user will actually pay for.
// There is no list-all endpoint -- only this per-tag manifest -- which is the
// other half of why the catalog stays curated rather than generated.
export async function fetchRegistrySize(tag, { fetchImpl = fetch, timeoutMs = 4000 } = {}) {
  const [name, version = "latest"] = String(tag).split(":");
  if (!name) return undefined;
  try {
    const response = await fetchImpl(
      `${REGISTRY_BASE}/v2/library/${encodeURIComponent(name)}/manifests/${encodeURIComponent(version)}`,
      {
        headers: { Accept: "application/vnd.docker.distribution.manifest.v2+json" },
        signal: AbortSignal.timeout(timeoutMs),
      },
    );
    if (!response.ok) return undefined;
    const manifest = await response.json();
    const layers = Array.isArray(manifest?.layers) ? manifest.layers : [];
    const bytes = layers.reduce(
      (total, layer) => total + (Number.isFinite(layer?.size) ? layer.size : 0),
      0,
    );
    return bytes > 0 ? bytes : undefined;
  } catch {
    // Offline, rate-limited, or a renamed tag: the hand-written size stands in.
    return undefined;
  }
}

export function readSizeCache() {
  try {
    const parsed = JSON.parse(readFileSync(MODEL_SIZE_CACHE_PATH, "utf8"));
    return parsed?.version === 1 && parsed.sizes ? parsed : null;
  } catch {
    return null;
  }
}

export function sizeCacheIsStale(cache = readSizeCache(), now = Date.now()) {
  return !cache || !(now - (cache.updatedAt || 0) < SIZE_CACHE_TTL_MS);
}

function writeSizeCache(sizes) {
  const dir = path.dirname(MODEL_SIZE_CACHE_PATH);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const value = { version: 1, updatedAt: Date.now(), sizes };
  const temporary = `${MODEL_SIZE_CACHE_PATH}.tmp.${process.pid}`;
  writeFileSync(temporary, `${JSON.stringify(value)}\n`, { encoding: "utf8", mode: 0o600 });
  renameSync(temporary, MODEL_SIZE_CACHE_PATH);
  return value;
}

// Refreshes every curated size in one pass. Bounded and failure-tolerant: a
// tag that cannot be reached keeps whatever the cache or the catalog already
// says, so a flaky network never blanks the picker.
export async function refreshModelSizes({ fetchImpl = fetch, timeoutMs = 4000 } = {}) {
  const previous = readSizeCache()?.sizes || {};
  const entries = await Promise.all(
    LOCAL_VISION_CATALOG.map(async (model) => [
      model.tag,
      (await fetchRegistrySize(model.tag, { fetchImpl, timeoutMs })) ?? previous[model.tag],
    ]),
  );
  const sizes = Object.fromEntries(entries.filter(([, bytes]) => Number.isFinite(bytes)));
  return writeSizeCache(sizes);
}

// Sizes change only when a model is republished, so a weekly refresh is plenty
// and the network cost stays off the common path: a fresh cache returns without
// touching the network at all.
export async function refreshVisionModelSizesIfStale(options = {}) {
  if (!sizeCacheIsStale()) return false;
  try {
    await refreshModelSizes(options);
    return true;
  } catch {
    // A refresh failure is never worth failing the caller: the picker falls
    // back to the checked-in sizes.
    return false;
  }
}

// Two tags name the same model when they differ only by an implicit `:latest`,
// so a curated `moondream` matches an installed `moondream:latest`.
function tagsMatch(catalogTag, installedTag) {
  const normalize = (value) => (value.includes(":") ? value : `${value}:latest`);
  return normalize(catalogTag) === normalize(installedTag);
}

// Joins the catalog to this machine: does it fit in RAM, and is it already
// pulled. `fits` uses the unified-memory-aware profile, so a discrete-GPU host
// is flagged honestly (it may still run via CPU offload, just slower).
export function annotateLocalModels(
  {
    profile = hostVisionProfile(),
    installed = ollamaInstalledModels(),
    sizes = readSizeCache()?.sizes,
    benchmarks = {},
  } = {},
) {
  const installedTags = Array.isArray(installed) ? installed : [];
  // A model the operator downloaded and tested themselves is listed alongside
  // the curated ones: the picker is a shortlist, not a whitelist, so anything
  // installed and measured deserves the same label treatment.
  const extras = Object.entries(benchmarks)
    .filter(
      ([tag]) =>
        !LOCAL_VISION_CATALOG.some((model) => tagsMatch(model.tag, tag)) &&
        installedTags.some((name) => tagsMatch(tag, name)),
    )
    .map(([tag, result]) => ({
      tag,
      label: tag,
      sizeGb: 0,
      minRamGib: 0,
      note: "Added by you.",
      custom: true,
      accuracy: result?.tier || "untested",
      measured: result,
    }));
  return [...LOCAL_VISION_CATALOG, ...extras].map((model) => {
    // A locally measured result always wins over the shipped one: it was run on
    // this machine, against this build of the model.
    const measured = benchmarks[model.tag] || model.measured;
    const accuracy = benchmarks[model.tag]?.tier || model.accuracy || "untested";
    // A published size is the truth; the checked-in number is the fallback for
    // an offline machine or a tag the registry no longer serves.
    // Decimal GB, matching what `ollama list` and ollama.com display, so the
    // picker never contradicts the tool doing the download. (RAM stays GiB,
    // which is how memory is actually sold and reported.)
    const bytes = sizes?.[model.tag];
    const sizeGb = Number.isFinite(bytes)
      ? Math.round((bytes / 1e9) * 10) / 10
      : model.sizeGb;
    return {
      ...model,
      sizeGb,
      sizeSource: Number.isFinite(bytes) ? "registry" : "catalog",
      accuracy,
      measured,
      // Only a locally measured score can be shown as this machine's own
      // result; a shipped figure was measured somewhere else.
      measuredLocally: Boolean(benchmarks[model.tag]),
      fits: profile.memGib >= model.minRamGib,
      installed: installedTags.some((tag) => tagsMatch(model.tag, tag)),
    };
  }).sort((left, right) => {
    const tier =
      (ACCURACY_RANK[left.accuracy] ?? 2) - (ACCURACY_RANK[right.accuracy] ?? 2);
    return tier || left.sizeGb - right.sizeGb;
  });
}

// A local vision model's real limit is memory. On Apple Silicon the GPU shares
// system RAM, so total memory is an honest proxy; on a discrete-GPU box it
// overestimates VRAM, but the local runtime (Ollama, llama.cpp) degrades to
// CPU/partial offload rather than failing, so the recommendation still runs --
// just slower. The thresholds pick the largest model that comfortably fits.
const GIB = 1024 ** 3;
const RECOMMENDATIONS = [
  {
    minGib: 15,
    model: "qwen2.5vl:7b",
    reason: "16 GB or more: the sharper 7B model fits and reads cluttered UI best.",
  },
  {
    minGib: 7,
    model: "qwen2.5vl:3b",
    reason: "8 GB class: the 3B model is the reliable default for text, tables, and charts.",
  },
  {
    minGib: 0,
    model: "moondream",
    reason:
      "Under 8 GB: moondream (~1.8B) is the only model that runs comfortably; expect rougher reads of dense text.",
  },
];

// Name-based, because a model list carries no capability flags. These are the
// well-known local vision families; an unrecognized multimodal model simply
// will not be flagged as a vision model, which is the safe direction to miss.
const VISION_FAMILY_PATTERNS = [
  /qwen.*vl/i,
  /moondream/i,
  /llava/i,
  /bakllava/i,
  /llama.*vision/i,
  /minicpm-?v/i,
  /internvl/i,
  /pixtral/i,
  /cogvlm/i,
  /granite.*vision/i,
];

export function isVisionModelId(id) {
  return typeof id === "string" && VISION_FAMILY_PATTERNS.some((re) => re.test(id));
}

export function hostVisionProfile({
  totalMemBytes = os.totalmem(),
  arch = process.arch,
  platform = os.platform(),
} = {}) {
  const memGib = totalMemBytes / GIB;
  const appleSilicon = platform === "darwin" && arch === "arm64";
  const pick = RECOMMENDATIONS.find((entry) => memGib >= entry.minGib) || RECOMMENDATIONS.at(-1);
  const alternatives = RECOMMENDATIONS.filter((entry) => entry.model !== pick.model).map(
    (entry) => entry.model,
  );
  return {
    memGib: Math.round(memGib * 10) / 10,
    arch,
    platform,
    appleSilicon,
    // On a discrete-GPU host the RAM proxy is optimistic, so the note is honest
    // about the softer guarantee there.
    memoryProxy: appleSilicon ? "unified" : "system-ram",
    recommended: pick.model,
    reason: pick.reason,
    alternatives,
  };
}

// The bridge is runtime-agnostic: it needs an OpenAI-compatible
// /v1/chat/completions, nothing more. These are the common local servers that
// expose one, with the port each listens on by default. Probing a port that
// runs something else is harmless -- a non-LLM service answers /v1/models with
// a 404 or non-JSON, which reads as "not a vision runtime".
export const KNOWN_LOCAL_RUNTIMES = Object.freeze([
  { name: "ollama", baseUrl: "http://127.0.0.1:11434/v1" },
  { name: "llama.cpp", baseUrl: "http://127.0.0.1:8080/v1" },
  { name: "lm-studio", baseUrl: "http://127.0.0.1:1234/v1" },
]);

// Best-effort, read-only, and fast: a machine without a local server should get
// a clear "not reachable" in a second, not a hung probe. The OpenAI-compatible
// /models list is enough to see what is pulled; families are matched by name.
export async function probeLocalServer(
  baseUrl = DEFAULT_LOCAL_VISION_BASE_URL,
  { fetchImpl = fetch, timeoutMs = 2000 } = {},
) {
  const base = String(baseUrl).replace(/\/+$/, "");
  try {
    const res = await fetchImpl(`${base}/models`, {
      method: "GET",
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) {
      return { reachable: false, baseUrl: base, error: `HTTP ${res.status}`, models: [], visionModels: [] };
    }
    const parsed = await res.json();
    const models = (Array.isArray(parsed?.data) ? parsed.data : [])
      .map((entry) => (typeof entry?.id === "string" ? entry.id : null))
      .filter(Boolean);
    return {
      reachable: true,
      baseUrl: base,
      models,
      visionModels: models.filter(isVisionModelId),
    };
  } catch (error) {
    return {
      reachable: false,
      baseUrl: base,
      error: error?.name === "TimeoutError" ? "no response" : "not reachable",
      models: [],
      visionModels: [],
    };
  }
}

// Probes every known runtime in parallel (plus a configured base URL that is
// not among them). Closed ports refuse instantly, so this stays fast; only an
// open-but-slow service can reach the timeout.
export async function detectLocalRuntimes({
  runtimes = KNOWN_LOCAL_RUNTIMES,
  fetchImpl = fetch,
  timeoutMs = 1500,
} = {}) {
  const seen = new Set();
  const targets = [];
  for (const runtime of runtimes) {
    const baseUrl = String(runtime.baseUrl).replace(/\/+$/, "");
    if (seen.has(baseUrl)) continue;
    seen.add(baseUrl);
    targets.push({ name: runtime.name, baseUrl });
  }
  return Promise.all(
    targets.map(async (target) => ({
      name: target.name,
      ...(await probeLocalServer(target.baseUrl, { fetchImpl, timeoutMs })),
    })),
  );
}

// Ties it all together into one actionable answer: what the hardware suggests,
// which runtime is up and what it already has, and the exact model + base URL
// to pin. An already-pulled vision model wins over the hardware pick, because
// it needs no download and the operator clearly installed it.
export async function suggestLocalVisionSetup(settings = {}, deps = {}) {
  const profile = hostVisionProfile(deps.host);
  const configuredBase = (
    settings.local?.baseUrl ||
    process.env.MODEL_ROUTER_VISION_LOCAL_BASE_URL ||
    DEFAULT_LOCAL_VISION_BASE_URL
  ).replace(/\/+$/, "");
  const runtimeList = KNOWN_LOCAL_RUNTIMES.some((r) => r.baseUrl.replace(/\/+$/, "") === configuredBase)
    ? KNOWN_LOCAL_RUNTIMES
    : [{ name: "configured", baseUrl: configuredBase }, ...KNOWN_LOCAL_RUNTIMES];
  const runtimes = await detectLocalRuntimes({ runtimes: runtimeList, ...(deps.probe || {}) });

  const running = runtimes.filter((runtime) => runtime.reachable);
  // Prefer the configured runtime, then the first that has any vision model.
  const withVision =
    running.find(
      (runtime) => runtime.baseUrl === configuredBase && runtime.visionModels.length,
    ) || running.find((runtime) => runtime.visionModels.length);

  let chosen;
  let baseUrl;
  let needsPull;
  if (withVision) {
    baseUrl = withVision.baseUrl;
    chosen = withVision.visionModels.includes(profile.recommended)
      ? profile.recommended
      : withVision.visionModels[0];
    needsPull = false;
  } else {
    baseUrl = configuredBase;
    chosen = settings.local?.model || profile.recommended;
    needsPull = true;
  }
  const nonDefaultBase = baseUrl !== DEFAULT_LOCAL_VISION_BASE_URL ? ` ${baseUrl}` : "";
  return {
    profile,
    runtimes,
    runningRuntimes: running.map((runtime) => runtime.name),
    chosen,
    baseUrl,
    needsPull,
    // llama.cpp and LM Studio load their model from disk, so the pull command
    // only makes sense for Ollama; elsewhere it is guidance, not a literal step.
    pullCommand: needsPull ? `ollama pull ${chosen}` : null,
    pinCommand: `./bin/control vision-bridge local ${chosen}${nonDefaultBase}`,
  };
}

export { DEFAULT_LOCAL_VISION_MODEL };
