import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statfsSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";

import { protectPrivateFile } from "./file-security.mjs";
import {
  disableProvider,
  enableProvider,
  readProviderSelection,
} from "./provider-selection.mjs";
import { STATE_DIR } from "./paths.mjs";
import { readUserModels, userModelEntry, writeUserModels } from "./user-models.mjs";
import {
  canonicalLocalModelTag,
  localModelDisplayName,
  splitLocalModelTag,
} from "./local-model-ref.mjs";
import {
  localOllamaRuntimeSnapshot,
  ollamaCommand,
  ollamaModelsPath,
} from "./ollama-runtime.mjs";
import { readLocalDownload, writeLocalDownload } from "./local-download.mjs";
import {
  EXPLORE_LOCAL_MODELS,
  LOCAL_FAMILY_RESEARCH,
} from "./local-ollama-catalog.mjs";
// The vision catalog is measured against a known image, so image readers are
// taken from there rather than guessed at a second time here.
import { LOCAL_VISION_CATALOG as VISION_CATALOG } from "./vision-host.mjs";


// Local models are the operator's own software running on their own machine, so
// the router only ever reads and reports what Ollama already has. Installing and
// removing are explicit operator actions, never side effects of a refresh.

export const LOCAL_MODELS_STATE_PATH =
  process.env.MODEL_ROUTER_LOCAL_MODELS_STATE ||
  path.join(STATE_DIR, "local-models.json");

function defaultSelection() {
  return { version: 1, enabled: [] };
}

// The checked set: which installed models the operator wants the router to
// treat as usable. Kept separate from "installed" so unchecking a model never
// deletes gigabytes, and separate from the vision engine pin so a model can be
// available without being the image reader.
export function readLocalModelSelection() {
  if (!existsSync(LOCAL_MODELS_STATE_PATH)) return defaultSelection();
  try {
    const parsed = JSON.parse(readFileSync(LOCAL_MODELS_STATE_PATH, "utf8"));
    if (parsed?.version === 1 && Array.isArray(parsed.enabled)) {
      return { version: 1, enabled: parsed.enabled.filter((tag) => typeof tag === "string") };
    }
  } catch {
    // Corrupt selection falls back to "nothing checked", which is the state
    // every install starts in.
  }
  return defaultSelection();
}

function writeSelection(selection) {
  const dir = path.dirname(LOCAL_MODELS_STATE_PATH);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  const temporary = `${LOCAL_MODELS_STATE_PATH}.tmp.${process.pid}`;
  writeFileSync(temporary, `${JSON.stringify(selection, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  protectPrivateFile(temporary);
  renameSync(temporary, LOCAL_MODELS_STATE_PATH);
  protectPrivateFile(LOCAL_MODELS_STATE_PATH);
  return selection;
}

export const LOCAL_PROVIDER_ID = "local";

function localOllamaBinary(spawn) {
  // Tests inject a fake spawn and expect the stable CLI name. The real path can
  // be the app bundle or a package-manager install, so production calls use
  // the runtime manager's resolved executable.
  return spawn === spawnSync ? ollamaCommand() || "ollama" : "ollama";
}

// Local models sort after every cloud model in the picker: they are slower and
// smaller, so they should not displace a paid flagship at the top of the list.
const LOCAL_MODEL_PRIORITY = 900;

// The overlay's default is 128K, which is wrong for a model running on the
// operator's own laptop: the KV cache for that window costs ~15 GB on a 3B
// model, overflows a 16 GB machine, and pushes half the work onto the CPU --
// measured here as 17 GB and 43% CPU versus 3.1 GB and 100% GPU at 8K, a six
// fold difference in wall clock. Codex sizes its prompts to the number
// advertised here, so advertising 128K asks a small local model for exactly
// the context that makes it unusable.
//
// This caps what Codex sends. It does not change what Ollama reserves: the
// OpenAI-compatible endpoint ignores `num_ctx`, so the allocation is set by
// Ollama's own OLLAMA_CONTEXT_LENGTH.
const LOCAL_CONTEXT_WINDOW = 32768;
const LOCAL_AUTO_COMPACT = 28000;

// Checking a model publishes it: it joins the user-model overlay, which the
// registry, gateway config, and Codex catalog already consume, so a local
// model reaches the picker through exactly the same path as any curated cloud
// model. Unchecking withdraws it again without touching the download.
export function setLocalModelEnabled(tag, enabled, { capabilitiesFor } = {}) {
  const value = String(tag || "").trim();
  if (!value) throw new Error("A model tag is required.");
  // Store one spelling per model. The downloader normalizes to `gemma3:latest`
  // while the CLI used to store whatever was typed, so a set keyed on the raw
  // string could hold both and `set gemma3 off` would clear neither. Dropping
  // every spelling first also migrates those older entries on the next write.
  const canonical = canonicalLocalModelTag(value);
  const remaining = readLocalModelSelection().enabled.filter(
    (entry) => canonicalLocalModelTag(entry) !== canonical,
  );
  const current = new Set(enabled ? [...remaining, canonical] : remaining);
  const selection = writeSelection({ version: 1, enabled: [...current].sort() });
  syncLocalUserModels({ enabled: selection.enabled, ...(capabilitiesFor ? { capabilitiesFor } : {}) });
  // Checking a model is the operator saying they want it available, so the
  // provider follows the models rather than being a second switch to find:
  // it turns on with the first check and off when the last one clears.
  syncLocalProviderSelection(selection.enabled.length > 0);
  return selection;
}

// Deliberately failure-tolerant. The selection file is shared state that other
// commands also write; if it cannot be updated the models are still published
// and the operator can enable the provider by hand, which beats failing the
// checkbox.
export function syncLocalProviderSelection(shouldEnable) {
  try {
    const enabled = readProviderSelection().includes(LOCAL_PROVIDER_ID);
    if (shouldEnable && !enabled) enableProvider(LOCAL_PROVIDER_ID);
    if (!shouldEnable && enabled) disableProvider(LOCAL_PROVIDER_ID);
    return shouldEnable;
  } catch {
    return undefined;
  }
}

// Rebuilds the overlay's local entries from the checked set, leaving every
// other curated model untouched. Declarative on purpose: the checked list is
// the source of truth, so a half-applied toggle cannot leave a stale entry
// advertising a model that is no longer selected.
export function syncLocalUserModels({
  enabled = readLocalModelSelection().enabled,
  capabilitiesFor = (tag) => localModelCapabilities(tag),
} = {}) {
  const others = readUserModels().filter((model) => model.provider !== LOCAL_PROVIDER_ID);
  // Codex drives every turn through tool calls. A model without them is not a
  // weaker chat model, it is a broken one: the first request comes back "does
  // not support tools". Such a model stays installed and stays usable as a
  // vision reader, but it is never published into the picker.
  const publishable = enabled.filter((tag) => capabilitiesFor(tag).includes("tools"));
  const entries = publishable.map((tag, index) => {
    const capabilities = capabilitiesFor(tag);
    let displayName;
    try {
      displayName = localModelDisplayName(tag);
    } catch {
      displayName = String(tag);
    }
    return {
      ...userModelEntry({
        providerId: LOCAL_PROVIDER_ID,
        upstreamId: tag,
        priority: LOCAL_MODEL_PRIORITY + index,
        metadata: {
          // Reported by Ollama, so the entry claims image input only when the
          // model genuinely has it -- the same standard the checked-in
          // registry is held to.
          inputModalities: capabilities.includes("vision") ? ["text", "image"] : ["text"],
          contextWindow: LOCAL_CONTEXT_WINDOW,
          autoCompact: LOCAL_AUTO_COMPACT,
          description: `${displayName} running locally through Ollama on this machine.`,
        },
      }),
      // Marked experimental in the picker itself. Vision is proven -- a local
      // model transcribes an image accurately every time -- but driving a
      // Codex turn is not: a model can pass this check and fail the same one
      // minutes later, and the label has to say so where the choice is made,
      // not only in a doc nobody opens mid-task.
      displayName: `${displayName} (local, experimental)`,
      // Codex's apply_patch is a freeform custom tool, which has no
      // representation in Ollama's tool schema: it arrives mangled or not at
      // all, and the model is left guessing at a toolset it cannot see. Opting
      // out keeps every tool a plain function, which Ollama does support.
      // Observed without this: llama3.2:3b inventing a `create_goal` call and
      // emitting it as prose.
      supportsApplyPatchTool: false,
      // Driving subagents is a harder job than answering a turn, and no local
      // model has been shown to do it here. Claiming v2 would offer them as
      // spawn targets on that untested basis.
      multiAgentVersion: "v1",
    };
  });
  writeUserModels([...others, ...entries]);
  return entries;
}

const REGISTRY_BASE =
  process.env.MODEL_ROUTER_OLLAMA_REGISTRY || "https://registry.ollama.ai";

// Tool support before the download, so nobody spends gigabytes on a model
// Codex can never drive. Ollama bakes tool calling into the chat template, and
// the registry serves that template as its own layer -- so fetching a few
// kilobytes answers what would otherwise cost a multi-gigabyte pull.
//
// A template mentioning `.Tools` is necessary but not sufficient: qwen2.5-coder
// has it and still emits tool calls as plain text. So this reports "the model
// claims tools", and only a real request proves it.
export async function fetchRegistryCapabilities(tag, { fetchImpl = fetch, timeoutMs = 6000 } = {}) {
  let identity;
  try {
    identity = splitLocalModelTag(tag);
  } catch {
    return undefined;
  }
  const { name, variant: version } = identity;
  if (!name) return undefined;
  const base = `${REGISTRY_BASE}/v2/library/${encodeURIComponent(name)}`;
  try {
    const manifest = await fetchImpl(
      `${base}/manifests/${encodeURIComponent(version)}`,
      {
        headers: { Accept: "application/vnd.docker.distribution.manifest.v2+json" },
        signal: AbortSignal.timeout(timeoutMs),
      },
    );
    if (!manifest.ok) return undefined;
    const parsed = await manifest.json();
    const layers = Array.isArray(parsed?.layers) ? parsed.layers : [];
    const template = layers.find((layer) => layer?.mediaType?.endsWith(".template"));
    const bytes = layers.reduce((sum, layer) => sum + (layer?.size || 0), 0);
    // One tenth of a gigabyte on every path: the two early returns used to
    // hand back the raw quotient, so a model whose template could not be read
    // reported "18.556700222 GB" in the tray while its neighbours read "18.6".
    const sizeGb = Math.round((bytes / 1e9) * 10) / 10;
    const digest = manifest.headers?.get?.("docker-content-digest") || parsed?.config?.digest;
    if (!template?.digest) {
      return {
        tag,
        tools: false,
        sizeGb,
        digest: digest || null,
        family: identity.family,
        variant: identity.variant,
      };
    }
    // Blob URLs redirect to a CDN, so the fetch has to follow them.
    const blob = await fetchImpl(`${base}/blobs/${template.digest}`, {
      redirect: "follow",
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!blob.ok) {
      return {
        tag,
        tools: false,
        sizeGb,
        digest: digest || null,
        family: identity.family,
        variant: identity.variant,
      };
    }
    const text = await blob.text();
    return {
      tag,
      tools: /\{\{[^}]*\.Tools/i.test(text),
      sizeGb,
      digest: digest || null,
      family: identity.family,
      variant: identity.variant,
    };
  } catch {
    // Offline or an unknown tag: the install proceeds unannotated rather than
    // being blocked by a lookup that is only advisory.
    return undefined;
  }
}

export const AGENT_CHECK_PATH =
  process.env.MODEL_ROUTER_AGENT_CHECKS ||
  path.join(STATE_DIR, "local-agent-checks.json");

export function readAgentChecks() {
  try {
    const parsed = JSON.parse(readFileSync(AGENT_CHECK_PATH, "utf8"));
    return parsed?.version === 1 && parsed.results ? parsed.results : {};
  } catch {
    return {};
  }
}

export function saveAgentCheck(tag, result) {
  const results = { ...readAgentChecks(), [tag]: result };
  mkdirSync(path.dirname(AGENT_CHECK_PATH), { recursive: true, mode: 0o700 });
  const temporary = `${AGENT_CHECK_PATH}.tmp.${process.pid}`;
  writeFileSync(temporary, `${JSON.stringify({ version: 1, results })}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  renameSync(temporary, AGENT_CHECK_PATH);
  return results;
}

export const CAPABILITY_CACHE_PATH =
  process.env.MODEL_ROUTER_LOCAL_CAPABILITY_CACHE ||
  path.join(STATE_DIR, "local-model-capabilities.json");

// Ollama reports what a model can actually do, which beats inferring it from
// the name: most small vision models cannot call tools, and a name says
// nothing about it. Codex is an agent -- it needs tool calls to edit files and
// run commands -- so publishing a toolless model gives the operator a picker
// entry that 400s on the first turn.
export function parseOllamaCapabilities(stdout) {
  const text = String(stdout || "");
  const section = text.split(/Capabilities/i)[1];
  if (!section) return [];
  const capabilities = [];
  for (const raw of section.split("\n").slice(1)) {
    const line = raw.trim();
    if (!line) break; // the capability block ends at the first blank line
    if (/^[A-Z]/.test(line)) break; // ...or at the next section heading
    capabilities.push(line.split(/\s+/)[0].toLowerCase());
  }
  return capabilities;
}

function readCapabilityCache() {
  try {
    const parsed = JSON.parse(readFileSync(CAPABILITY_CACHE_PATH, "utf8"));
    return parsed?.version === 1 && parsed.models ? parsed.models : {};
  } catch {
    return {};
  }
}

function writeCapabilityCache(models) {
  mkdirSync(path.dirname(CAPABILITY_CACHE_PATH), { recursive: true, mode: 0o700 });
  const temporary = `${CAPABILITY_CACHE_PATH}.tmp.${process.pid}`;
  writeFileSync(temporary, `${JSON.stringify({ version: 1, models })}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  renameSync(temporary, CAPABILITY_CACHE_PATH);
}

// Keyed by the model's content id, so a retagged or rebuilt model is re-read
// while an unchanged one costs no subprocess at all -- the tray polls this.
export function localModelCapabilities(tag, id, { spawn = spawnSync, cache } = {}) {
  const store = cache || readCapabilityCache();
  const key = id || tag;
  if (store[key]) return store[key];
  try {
    const result = spawn(localOllamaBinary(spawn), ["show", tag], { encoding: "utf8" });
    if (result.status !== 0 || typeof result.stdout !== "string") return [];
    const capabilities = parseOllamaCapabilities(result.stdout);
    store[key] = capabilities;
    if (!cache) writeCapabilityCache(store);
    return capabilities;
  } catch {
    return [];
  }
}

// `ollama list` is a fixed-width table; the columns are name, id, size, and a
// human "modified" phrase that runs to the end of the line.
export function parseOllamaList(stdout) {
  return String(stdout || "")
    .split("\n")
    .slice(1)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const parts = line.split(/\s{2,}/).filter(Boolean);
      const [tag, id, size, modified] = parts;
      if (!tag || !tag.includes(":")) return undefined;
      const gb = Number.parseFloat(String(size || "").replace(/[^\d.]/g, ""));
      return {
        tag,
        id: id || "",
        sizeGb: Number.isFinite(gb) ? gb : 0,
        modified: modified || "",
      };
    })
    .filter(Boolean);
}

export function localModelInventory({ spawn = spawnSync } = {}) {
  try {
    const result = spawn(localOllamaBinary(spawn), ["list"], { encoding: "utf8" });
    if (result.status !== 0 || typeof result.stdout !== "string") return [];
    return parseOllamaList(result.stdout);
  } catch {
    return [];
  }
}

// Which models Ollama currently holds in memory. Purely informational, but it
// is the difference between "installed" and "warm", and a cold model's first
// request pays a load penalty the operator should be able to see coming.
export function runningLocalModels({ spawn = spawnSync } = {}) {
  try {
    const result = spawn(localOllamaBinary(spawn), ["ps"], { encoding: "utf8" });
    if (result.status !== 0 || typeof result.stdout !== "string") return [];
    return parseOllamaList(result.stdout).map((entry) => entry.tag);
  } catch {
    return [];
  }
}

// Answers "is this model checked?" across spellings, so a caller holding
// `gemma3` and a state file holding `gemma3:latest` agree.
export function isLocalModelEnabled(tag, selection = readLocalModelSelection()) {
  const canonical = canonicalLocalModelTag(tag);
  return selection.enabled.some((entry) => canonicalLocalModelTag(entry) === canonical);
}

// Deleting reclaims gigabytes and cannot be undone without downloading again,
// so the caller must pass explicit consent rather than this inferring it.
export function removeLocalModel(tag, { spawn = spawnSync, confirmed = false, capabilitiesFor } = {}) {
  const value = String(tag || "").trim();
  if (!value) throw new Error("A model tag is required.");
  if (!confirmed) {
    throw new Error(`Removing ${value} deletes it from disk. Pass --yes to confirm.`);
  }
  const result = spawn(localOllamaBinary(spawn), ["rm", value], { encoding: "utf8" });
  if (result.status !== 0) {
    const detail = String(result.stderr || "").trim();
    throw new Error(`\`ollama rm ${value}\` failed${detail ? `: ${detail}` : "."}`);
  }
  // A deleted model cannot stay checked, or the picker would offer something
  // that is no longer on disk.
  setLocalModelEnabled(value, false, capabilitiesFor ? { capabilitiesFor } : undefined);
  return value;
}

// One view the tray can render directly: what is installed, what is checked,
// what is loaded, and which ones can read images.
export function localModelsSnapshot({
  inventory = localModelInventory(),
  running = runningLocalModels(),
  selection = readLocalModelSelection(),
  benchmarks = {},
  capabilities,
  agentChecks = readAgentChecks(),
  runtime = localOllamaRuntimeSnapshot(),
} = {}) {
  // Compared canonically: `ollama list` always prints `gemma3:latest`, while an
  // older state file may hold the bare `gemma3` the CLI once stored. Matching
  // on the raw string showed such a model as unchecked even though it routed.
  const enabled = new Set(selection.enabled.map((tag) => canonicalLocalModelTag(tag)));
  const runningSet = new Set(running);
  const cache = capabilities;
  const models = inventory.map((entry) => {
    const caps = cache
      ? cache[entry.tag] || []
      : localModelCapabilities(entry.tag, entry.id);
    let identity;
    try {
      identity = splitLocalModelTag(entry.tag);
    } catch {
      identity = { family: entry.tag, variant: "latest" };
    }
    const measured = benchmarks[entry.tag];
    return {
      ...entry,
      family: identity.family,
      variant: identity.variant,
      capabilities: caps,
      enabled: enabled.has(canonicalLocalModelTag(entry.tag)),
      running: runningSet.has(entry.tag),
      // Reported by Ollama, not guessed from the name.
      vision: caps.includes("vision"),
      // Codex drives models through tool calls, so a model without them can
      // never be a chat model here -- only a vision reader for the bridge.
      tools: caps.includes("tools"),
      accuracy: measured?.tier,
      measured,
      tokensPerSecond: Number.isFinite(measured?.tokensPerSecond)
        ? measured.tokensPerSecond
        : Number.isFinite(measured?.evalTokensPerSecond)
          ? measured.evalTokensPerSecond
          : null,
      speedStatus: Number.isFinite(measured?.tokensPerSecond) || Number.isFinite(measured?.evalTokensPerSecond)
        ? "measured"
        : "unmeasured",
      // Whether the real Codex client could actually drive it. Unmeasured
      // stays unmeasured: a guess here is what sends someone into a task with
      // a model that invents tools.
      agent: agentChecks[entry.tag]?.verdict,
      agentCapable: agentChecks[entry.tag]?.agentCapable,
    };
  });
  // Without this the only way to install a model was to already know its tag,
  // which is no help to anyone who has never installed one. Rated for this
  // machine so the list cannot suggest something that will not run here.
  const capacity = detectMachine();
  const available = suggestedLocalModels({ capacity, installed: models });
  const availableVision = suggestedVisionModels({ capacity, installed: models });
  const availableExplore = suggestedExploreModels({ capacity, installed: models });
  const familyEntries = [...models, ...available, ...availableVision, ...availableExplore];
  const families = new Map();
  for (const entry of familyEntries) {
    const tag = String(entry.tag || "");
    let identity;
    try {
      identity = splitLocalModelTag(tag);
    } catch {
      identity = { family: tag, variant: "latest" };
    }
    const current = families.get(identity.family) || {
      family: identity.family,
      displayName: localModelDisplayName(tag),
      variants: [],
    };
    if (!current.variants.includes(identity.variant)) current.variants.push(identity.variant);
    families.set(identity.family, current);
  }
  for (const family of families.values()) family.variants.sort();
  let download = readLocalDownload();
  // Older uninstall workers recorded an error when Ollama had already
  // removed the weights but the optional Codex catalog refresh failed.  The
  // inventory is authoritative here: do not keep showing a red "removal
  // failed" card for a model that is no longer on disk.  Preserve the warning
  // so the operator still knows the picker may need a Codex restart.
  const removedButUnpublished = download?.kind === "uninstall"
    && download.status === "error"
    && /^The model was removed,/i.test(String(download.error || ""));
  if (removedButUnpublished && !models.some((model) => canonicalLocalModelTag(model.tag) === canonicalLocalModelTag(download.tag))) {
    const catalogError = download.catalogError || download.error;
    const repaired = {
      ...download,
      status: "done",
      detail: "Model removed · catalog refresh needed",
      percent: 100,
      updatedAt: Date.now(),
      catalogError,
      error: undefined,
    };
    try {
      download = writeLocalDownload(repaired);
    } catch {
      // Rendering the truthful inventory still matters if the protected state
      // file cannot be rewritten; the next refresh can try the repair again.
      download = repaired;
    }
  }
  return {
    path: LOCAL_MODELS_STATE_PATH,
    installed: models.length,
    enabled: models.filter((model) => model.enabled).length,
    usableAsChat: models.filter((model) => model.tools).length,
    totalGb: Math.round(models.reduce((sum, model) => sum + model.sizeGb, 0) * 10) / 10,
    models,
    available,
    availableVision,
    availableExplore,
    families: [...families.values()].sort((left, right) => left.family.localeCompare(right.family)),
    catalog: {
      mode: "ollama-tags",
      note: "Any valid Ollama tag is supported. Paste an ollama.com model URL or enter a tag to inspect and install it.",
    },
    runtime,
    download,
    machine: describeMachine(capacity),
  };
}

// --- machine fit -----------------------------------------------------------

// Weights are not the whole cost: the KV cache, context, and runtime overhead
// need room beside them. A fifth on top is the common working estimate and is
// deliberately conservative, so a model reported as fitting actually runs.
const OVERHEAD_FACTOR = 1.2;

// Leave the operating system its own working set rather than pretending every
// byte of RAM is available to one process.
const SYSTEM_HEADROOM = 0.8;

// macOS lets the GPU wire roughly three quarters of unified memory.
const UNIFIED_GPU_SHARE = 0.75;

// Without a GPU the whole model sits in system memory beside everything else
// the machine is doing, so only the smaller part of the budget is comfortable.
const COMFORTABLE_CPU_SHARE = 0.6;

function nvidiaMemoryBytes() {
  try {
    const output = spawnSync(
      "nvidia-smi",
      ["--query-gpu=memory.total", "--format=csv,noheader,nounits"],
      { encoding: "utf8", timeout: 3_000 },
    );
    if (output.status !== 0 || !output.stdout) return undefined;
    // Multi-GPU hosts report one line each; a model runs on one card.
    const largest = output.stdout
      .split(/\r?\n/)
      .map((line) => Number.parseInt(line.trim(), 10))
      .filter((value) => Number.isFinite(value) && value > 0)
      .sort((left, right) => right - left)[0];
    return largest ? largest * 1_048_576 : undefined;
  } catch {
    return undefined;
  }
}

// Pure, so ratings can be tested against machines this one is not.
export function machineCapacity({
  totalMemoryBytes,
  gpuMemoryBytes,
  unifiedMemory = false,
  freeDiskBytes,
  platform = process.platform,
} = {}) {
  const total = Number(totalMemoryBytes) || 0;
  const systemBudget = Math.floor(total * SYSTEM_HEADROOM);
  const gpuBudget = unifiedMemory
    ? Math.floor(total * UNIFIED_GPU_SHARE)
    : Number(gpuMemoryBytes) || undefined;
  return {
    platform,
    totalMemoryBytes: total,
    unifiedMemory,
    gpuBudgetBytes: gpuBudget,
    // What runs at full speed, and what runs at all. With no GPU to fall back
    // from, "comfortable" is a fraction of RAM rather than all of it, or every
    // model reads as either fine or impossible and a 7B that will swap the
    // machine to a crawl is reported as a clean fit.
    fastBudgetBytes: gpuBudget || Math.floor(systemBudget * COMFORTABLE_CPU_SHARE),
    ceilingBytes: Math.max(gpuBudget || 0, systemBudget),
    freeDiskBytes: Number.isFinite(freeDiskBytes) ? freeDiskBytes : undefined,
  };
}

export function availableDiskBytes(directory = STATE_DIR, statfs = statfsSync) {
  let candidate = directory;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    try {
      const stats = statfs(candidate);
      const available = Number(stats?.bavail) * Number(stats?.bsize);
      return Number.isFinite(available) && available >= 0 ? available : undefined;
    } catch {
      // A fresh install has no model directory yet. Walk upward until an
      // existing parent gives a useful same-volume estimate.
      const parent = path.dirname(candidate);
      if (parent === candidate) break;
      candidate = parent;
    }
  }
  return undefined;
}

export function detectMachine() {
  const unifiedMemory = process.platform === "darwin" && process.arch === "arm64";
  return machineCapacity({
    totalMemoryBytes: os.totalmem(),
    gpuMemoryBytes: unifiedMemory ? undefined : nvidiaMemoryBytes(),
    unifiedMemory,
    freeDiskBytes: availableDiskBytes(ollamaModelsPath()),
  });
}

export function describeMachine(capacity) {
  const memory = capacity.unifiedMemory
    ? `${(capacity.totalMemoryBytes / 1e9).toFixed(1)} GB unified memory`
    : `${(capacity.totalMemoryBytes / 1e9).toFixed(1)} GB RAM`;
  const gpu = capacity.unifiedMemory
    ? `GPU budget ~${(capacity.gpuBudgetBytes / 1e9).toFixed(1)} GB`
    : capacity.gpuBudgetBytes
      ? `${(capacity.gpuBudgetBytes / 1e9).toFixed(1)} GB GPU memory`
      : "no GPU memory detected; models run on the CPU";
  const disk = Number.isFinite(capacity.freeDiskBytes)
    ? ` · ${(capacity.freeDiskBytes / 1e9).toFixed(1)} GB free disk`
    : "";
  return `${memory} · ${gpu}${disk}`;
}

// Disk is separate from memory fit: a model can fit the GPU and still leave
// the machine unable to finish its pull. Keep this advisory conservative and
// do not refuse an unknown filesystem (network mounts and test doubles often
// do not expose statfs data).
export function rateDiskFit(sizeGb, capacity = detectMachine()) {
  const bytes = Number(sizeGb) * 1e9;
  if (!Number.isFinite(bytes) || bytes <= 0 || !Number.isFinite(capacity.freeDiskBytes)) return undefined;
  const required = bytes * 1.1;
  if (capacity.freeDiskBytes < required) return "too-large";
  if (capacity.freeDiskBytes < required * 2) return "tight";
  return "fits";
}

// "fits" runs at full speed, "tight" runs but spills to the CPU, "too-large"
// cannot run here at all. Sizes come from the registry manifest, so this works
// for any tag rather than a list someone has to keep current.
export function rateModelFit(sizeGb, capacity = detectMachine()) {
  const bytes = Number(sizeGb) * 1e9;
  if (!Number.isFinite(bytes) || bytes <= 0) return undefined;
  const needed = bytes * OVERHEAD_FACTOR;
  if (needed <= capacity.fastBudgetBytes) return "fits";
  if (needed <= capacity.ceilingBytes) return "tight";
  return "too-large";
}

export function fitAdvisory(tag, sizeGb, capacity = detectMachine()) {
  const fit = rateModelFit(sizeGb, capacity);
  if (fit === "tight") {
    return `${tag} (${sizeGb} GB) is close to this machine's limit (${describeMachine(capacity)}); expect it to spill onto the CPU and run slowly.`;
  }
  if (fit === "too-large") {
    return `${tag} needs about ${Math.ceil(sizeGb * OVERHEAD_FACTOR)} GB to run and this machine has ${describeMachine(capacity)}.`;
  }
  return undefined;
}

// --- what is worth downloading ---------------------------------------------

// Nothing answered "which model should I get?", so the only way in was to
// already know a tag. Two questions decide it, and they have different
// answers: can this model do coding work, or can it only read images?
//
// Every value here was read from the model's own files on 2026-08-09, not
// from documentation: `tools` and `sizeGb` from the registry manifest via
// fetchRegistryCapabilities, `context` from the GGUF header via
// fetchRegistryContext. Both lookups run again live -- inspect reads them per
// tag, and install re-checks -- so a republished tag corrects itself there
// rather than silently disagreeing with this list.
//
// A tool template is a floor, not a prediction. Upstream measured it failing
// in both directions: a 3B model that emits perfect tool calls against a short
// prompt answers about its own instructions once Codex's real ~24K-token
// prompt is in front of it, and a 7B model that returns tool calls as plain
// text on Ollama's OpenAI surface dispatches them correctly through the
// router's native route. Only `local-models agent-check` settles it, by
// running the real client twice and requiring both runs to pass.
//
// So `codex` below records what was actually observed, and "untested" is left
// as untested rather than dressed up as a recommendation.
//
// Context is a floor check too. Every local model is advertised to Codex at
// LOCAL_CONTEXT_WINDOW regardless of what it natively holds, so native context
// above that buys nothing today -- but a model below it is worse than
// advertised, which is what this threshold catches.
const MIN_CODING_CONTEXT = LOCAL_CONTEXT_WINDOW;

// Codex's own instructions and tool definitions occupy most of that window
// before the operator's code is added. Measured from 40 real session rollouts
// under ~/.codex/sessions: tool definitions run 28.5K chars at the median and
// 34.1K at p90, base instructions 17.9K, and the first turn's context another
// 22.3K -- roughly 17K to 21K tokens on turn one, depending on how densely the
// JSON tokenizes. This uses the middle of that range.
export const CODEX_PROMPT_TOKENS = 20_000;

export const SUGGESTED_LOCAL_MODELS = Object.freeze(
  [
    {
      tag: "llama3.2:3b",
      sizeGb: 2,
      tools: true,
      context: 131_072,
      codex: "verified",
      note: "ran a real tool call through Codex",
    },
    {
      tag: "qwen2.5-coder:1.5b",
      sizeGb: 1,
      tools: true,
      context: 32_768,
      codex: "untested",
      note: "smallest coder",
    },
    {
      tag: "qwen2.5-coder:3b",
      sizeGb: 1.9,
      tools: true,
      context: 32_768,
      codex: "untested",
      note: "small coder",
    },
    {
      tag: "mistral:7b",
      sizeGb: 4.4,
      tools: true,
      context: 32_768,
      codex: "untested",
      note: "general purpose",
    },
    {
      tag: "qwen2.5-coder:7b",
      sizeGb: 4.7,
      tools: true,
      context: 32_768,
      codex: "untested",
      note: "has returned tool calls as plain text",
    },
    {
      tag: "llama3.1:8b",
      sizeGb: 4.9,
      tools: true,
      context: 131_072,
      codex: "untested",
      note: "general purpose",
    },
    {
      tag: "qwen2.5-coder:14b",
      sizeGb: 9,
      tools: true,
      context: 32_768,
      codex: "untested",
      note: "stronger coder",
    },
    {
      tag: "gpt-oss:20b",
      sizeGb: 13.8,
      tools: true,
      context: 131_072,
      codex: "untested",
      note: "thinking model",
    },
    {
      tag: "devstral",
      sizeGb: 14.3,
      tools: true,
      context: 131_072,
      codex: "untested",
      note: "built for agents",
    },
  ].map((entry) => Object.freeze(entry)),
);

// A discoverable family/tag list captured from the official Ollama tag pages.
// It is intentionally separate from the coding shortlist: the registry
// template is the authority for tool calling, and these tags should not be
// offered as Codex agents until `ollama show` proves that capability on the
// installed tag. Any other tag remains installable through the URL/tag field.
export { EXPLORE_LOCAL_MODELS };

function notInstalled(installed) {
  const have = new Set(installed.map((entry) => String(entry?.tag ?? entry)));
  return (tag) => !have.has(tag) && !have.has(`${tag}:latest`);
}

// Models that can actually do coding work here: they call tools, they hold
// enough context to be worth pointing at a codebase, and they fit in memory.
export function suggestedLocalModels({
  capacity = detectMachine(),
  installed = [],
  includeUnusable = false,
} = {}) {
  const fresh = notInstalled(installed);
  return SUGGESTED_LOCAL_MODELS
    .filter((entry) => entry.tools && entry.context >= MIN_CODING_CONTEXT)
    .map((entry) => ({
      ...entry,
      family: splitLocalModelTag(entry.tag).family,
      variant: splitLocalModelTag(entry.tag).variant,
      displayName: localModelDisplayName(entry.tag),
      fit: rateModelFit(entry.sizeGb, capacity),
      diskFit: rateDiskFit(entry.sizeGb, capacity),
      speedStatus: "unmeasured",
    }))
    .filter((entry) => fresh(entry.tag))
    .filter((entry) => includeUnusable || entry.fit !== "too-large")
    // Proven first: an untested model is a thing to try, not a recommendation.
    .sort(
      (left, right) =>
        (left.codex === "verified" ? 0 : 1) - (right.codex === "verified" ? 0 : 1) ||
        left.sizeGb - right.sizeGb,
    );
}

// Models that can only read images. Kept separate because the choice is a
// different one -- accuracy at transcription, not coding ability -- and the
// vision catalog already records what each one actually scored.
export function suggestedVisionModels({
  capacity = detectMachine(),
  installed = [],
  catalog,
} = {}) {
  const fresh = notInstalled(installed);
  const entries = catalog || VISION_CATALOG;
  return entries
    .map((entry) => ({
      tag: entry.tag,
      sizeGb: entry.sizeGb,
      accuracy: entry.accuracy,
      note: entry.note,
      fit: rateModelFit(entry.sizeGb, capacity),
      diskFit: rateDiskFit(entry.sizeGb, capacity),
    }))
    .filter((entry) => fresh(entry.tag))
    .filter((entry) => entry.fit !== "too-large")
    // Proven readers first. Sorting by size alone would top the list with
    // moondream, which is the smallest and transcribed none of the test text —
    // a confident-wrong reader is worse than a slower right one.
    .sort(
      (left, right) =>
        VISION_ACCURACY_RANK[left.accuracy] - VISION_ACCURACY_RANK[right.accuracy] ||
        left.sizeGb - right.sizeGb,
    );
}

// Every model the router knows about, in one browsable list.
//
// The two shortlists above are recommendations, and they deliberately drop
// anything this machine cannot run. That also made those entries unreachable:
// on an 8 GB laptop `qwen2.5-coder:14b`, `gpt-oss:20b` and `devstral` appeared
// in no list at all, so there was no way to install one even deliberately.
// This list hides nothing. It carries the fit rating instead, so the caller can
// warn about a model that will not fit rather than pretend it does not exist.
export function suggestedExploreModels({
  capacity = detectMachine(),
  installed = [],
} = {}) {
  const fresh = notInstalled(installed);
  const seen = new Set();
  const entries = [];
  for (const entry of [...EXPLORE_LOCAL_MODELS, ...SUGGESTED_LOCAL_MODELS, ...VISION_CATALOG]) {
    // `devstral` and `devstral:latest` are one model; the shortlists spell the
    // bare form and the explore catalog spells the tagged one.
    const canonical = canonicalLocalModelTag(entry.tag);
    if (seen.has(canonical) || !fresh(entry.tag)) continue;
    seen.add(canonical);
    let identity;
    try {
      identity = splitLocalModelTag(entry.tag);
    } catch {
      identity = { family: entry.tag, variant: "latest" };
    }
    const research = LOCAL_FAMILY_RESEARCH[identity.family];
    const cloudOnly = entry.downloadable === false;
    entries.push({
      // Defaults first so a catalog that states either one still wins.
      tools: false,
      downloadable: true,
      ...entry,
      family: identity.family,
      variant: identity.variant,
      displayName: entry.displayName || localModelDisplayName(entry.tag),
      fit: cloudOnly ? "cloud-only" : rateModelFit(entry.sizeGb, capacity),
      diskFit: cloudOnly ? "cloud-only" : rateDiskFit(entry.sizeGb, capacity),
      researchStatus: research?.status || "Cataloged · compatibility unverified",
      researchCapabilities: research?.capabilities || [],
      researchNote: research?.note || "Verify capabilities after pull.",
    });
  }
  return entries;
}

// Mirrors the vision catalog's own ranking: measured-accurate, then partial,
// then unmeasured, then the ones that only caption.
const VISION_ACCURACY_RANK = {
  accurate: 0,
  partial: 1,
  untested: 2,
  "captions-only": 3,
};

// A snapshot is the tray's data contract, not something a person can read at a
// terminal. This renders the same object for the operator, in the two groups
// the choice actually splits into.
function contextLabel(tokens) {
  return tokens >= 1000 ? `${Math.round(tokens / 1024)}K` : String(tokens);
}

export function renderLocalModels(snapshot) {
  const lines = [`Local models · ${snapshot.machine || "this machine"}`, ""];
  if (snapshot.models.length === 0) {
    lines.push("Installed: none yet");
  } else {
    lines.push(`Installed: ${snapshot.installed} · ${snapshot.totalGb} GB`);
    const width = Math.max(...snapshot.models.map((model) => model.tag.length));
    for (const model of snapshot.models) {
      const role = model.tools ? (model.vision ? "code + images" : "code") : "images only";
      lines.push(
        `  ${model.enabled ? "[x]" : "[ ]"} ${model.tag.padEnd(width)} ` +
          `${`${model.sizeGb.toFixed(1)} GB`.padStart(8)}  ${role}` +
          `${model.tokensPerSecond ? ` · ${model.tokensPerSecond.toFixed(1)} tok/s` : ""}` +
          `${model.running ? "  · loaded" : ""}`,
      );
    }
  }
  const coding = snapshot.available || [];
  const vision = snapshot.availableVision || [];
  const explore = snapshot.availableExplore || [];
  if (coding.length) {
    // The honest framing: Codex's own prompt takes most of the window before
    // any code is added, and only a verified model is known to drive a turn.
    const room = Math.max(0, LOCAL_CONTEXT_WINDOW - CODEX_PROMPT_TOKENS);
    lines.push(
      "",
      "For coding — experimental. Codex's prompt uses about " +
        `${Math.round(CODEX_PROMPT_TOKENS / 1000)}K of the ${contextLabel(LOCAL_CONTEXT_WINDOW)} ` +
        `window, leaving roughly ${Math.round(room / 1000)}K to work in.`,
      "",
    );
    const width = Math.max(...coding.map((entry) => entry.tag.length));
    for (const entry of coding) {
      lines.push(
        `  ${entry.tag.padEnd(width)} ${`${entry.sizeGb.toFixed(1)} GB`.padStart(8)} ` +
          `${entry.codex.padEnd(9)} ${entry.note}${entry.fit === "tight" ? " (memory tight)" : ""}` +
          `${entry.diskFit === "tight" ? " (disk tight)" : ""}`,
      );
    }
    lines.push("", "  Test one yourself:  ./bin/control local-models agent-check <tag>");
  }
  if (vision.length) {
    lines.push("", "For reading images only — cannot code:", "");
    const width = Math.max(...vision.map((entry) => entry.tag.length));
    for (const entry of vision) {
      lines.push(
        `  ${entry.tag.padEnd(width)} ${`${entry.sizeGb.toFixed(1)} GB`.padStart(8)}  ${entry.accuracy}`,
      );
    }
  }
  if (explore.length) {
    lines.push(
      "",
      "Explore Ollama tags (fit is shown; capabilities are checked after pull):",
    );
    for (const entry of explore) {
      if (entry.downloadable === false) {
        lines.push(`  ${entry.tag.padEnd(42)} cloud only · not downloadable`);
      } else {
        const fit = entry.fit === "too-large" ? "won't fit" : entry.fit || "fit unknown";
        lines.push(`  ${entry.tag.padEnd(42)} ${`${entry.sizeGb.toFixed(1)} GB`.padStart(8)} · ${fit}`);
      }
    }
  }
  if (coding.length || vision.length) {
    lines.push(
      "",
      `  ./bin/control local-models install ${(coding[0] || vision[0]).tag} --yes`,
      "  Any valid Ollama tag or ollama.com model URL also works.",
    );
  }
  return lines.join("\n");
}

// --- measured context length ------------------------------------------------

// How much of a codebase a model can hold decides whether it is worth pointing
// at one, and neither the registry manifest nor Ollama publishes it before the
// model is on disk. It is in the model file itself: GGUF stores its metadata
// as a key-value block at the very start, so a ranged request for the first
// megabyte reads the real number without pulling the weights.
const GGUF_MAGIC = 0x46554747;
const GGUF_HEAD_BYTES = 1_000_000;

// GGUF value type tags, in the order the format defines them.
const GGUF_UINT8 = 0;
const GGUF_INT8 = 1;
const GGUF_UINT16 = 2;
const GGUF_INT16 = 3;
const GGUF_UINT32 = 4;
const GGUF_INT32 = 5;
const GGUF_FLOAT32 = 6;
const GGUF_BOOL = 7;
const GGUF_STRING = 8;
const GGUF_ARRAY = 9;
const GGUF_UINT64 = 10;
const GGUF_INT64 = 11;
const GGUF_FLOAT64 = 12;

class ShortRead extends Error {}

function ggufReader(buffer) {
  let offset = 0;
  const need = (count) => {
    if (offset + count > buffer.length) throw new ShortRead();
  };
  return {
    u8() { need(1); return buffer[offset++]; },
    u32() { need(4); const value = buffer.readUInt32LE(offset); offset += 4; return value; },
    i32() { need(4); const value = buffer.readInt32LE(offset); offset += 4; return value; },
    u64() { need(8); const value = Number(buffer.readBigUInt64LE(offset)); offset += 8; return value; },
    i64() { need(8); const value = Number(buffer.readBigInt64LE(offset)); offset += 8; return value; },
    f32() { need(4); const value = buffer.readFloatLE(offset); offset += 4; return value; },
    f64() { need(8); const value = buffer.readDoubleLE(offset); offset += 8; return value; },
    str() {
      const length = this.u64();
      need(length);
      const value = buffer.toString("utf8", offset, offset + length);
      offset += length;
      return value;
    },
  };
}

// Values are read rather than skipped because an array's byte length is only
// knowable by walking it -- tokenizer vocabularies are arrays of strings.
function readGgufValue(reader, type) {
  if (type === GGUF_UINT8 || type === GGUF_INT8 || type === GGUF_BOOL) return reader.u8();
  if (type === GGUF_UINT16 || type === GGUF_INT16) return reader.u32() & 0xffff;
  if (type === GGUF_UINT32) return reader.u32();
  if (type === GGUF_INT32) return reader.i32();
  if (type === GGUF_FLOAT32) return reader.f32();
  if (type === GGUF_STRING) return reader.str();
  if (type === GGUF_UINT64) return reader.u64();
  if (type === GGUF_INT64) return reader.i64();
  if (type === GGUF_FLOAT64) return reader.f64();
  if (type === GGUF_ARRAY) {
    const elementType = reader.u32();
    const count = reader.u64();
    for (let index = 0; index < count; index += 1) readGgufValue(reader, elementType);
    return undefined;
  }
  throw new Error(`unsupported GGUF value type ${type}`);
}

export function parseGgufContextLength(buffer) {
  const reader = ggufReader(buffer);
  if (reader.u32() !== GGUF_MAGIC) return undefined;
  reader.u32();
  reader.u64();
  const pairs = reader.u64();
  for (let index = 0; index < pairs; index += 1) {
    let key;
    let value;
    try {
      key = reader.str();
      value = readGgufValue(reader, reader.u32());
    } catch (error) {
      // The head of the file ran out before the key appeared. Unknown is the
      // honest answer; it never blocks an install.
      if (error instanceof ShortRead) return undefined;
      throw error;
    }
    // Namespaced by architecture: llama.context_length, qwen2.context_length.
    if (key.endsWith(".context_length") && Number.isFinite(value)) return value;
  }
  return undefined;
}

export async function fetchRegistryContext(tag, { fetchImpl = fetch, timeoutMs = 8_000 } = {}) {
  let identity;
  try {
    identity = splitLocalModelTag(tag);
  } catch {
    return undefined;
  }
  const { name, variant: version } = identity;
  if (!name) return undefined;
  const base = `${REGISTRY_BASE}/v2/library/${encodeURIComponent(name)}`;
  try {
    const manifest = await fetchImpl(`${base}/manifests/${encodeURIComponent(version)}`, {
      headers: { Accept: "application/vnd.docker.distribution.manifest.v2+json" },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!manifest.ok) return undefined;
    const parsed = await manifest.json();
    const weights = (parsed?.layers || []).find((layer) =>
      layer?.mediaType?.endsWith(".model"),
    );
    if (!weights?.digest) return undefined;
    const head = await fetchImpl(`${base}/blobs/${weights.digest}`, {
      redirect: "follow",
      headers: { Range: `bytes=0-${GGUF_HEAD_BYTES - 1}` },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!head.ok) return undefined;
    return parseGgufContextLength(Buffer.from(await head.arrayBuffer()));
  } catch {
    // Offline, a non-GGUF model, or a CDN that refuses ranges: unknown, never
    // an error the operator has to deal with.
    return undefined;
  }
}
