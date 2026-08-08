import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

import { protectPrivateFile } from "./file-security.mjs";
import {
  disableProvider,
  enableProvider,
  readProviderSelection,
} from "./provider-selection.mjs";
import { STATE_DIR } from "./paths.mjs";
import { readUserModels, userModelEntry, writeUserModels } from "./user-models.mjs";


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
  const current = new Set(readLocalModelSelection().enabled);
  if (enabled) current.add(value);
  else current.delete(value);
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
          description: `${tag} running locally through Ollama on this machine.`,
        },
      }),
      displayName: `${tag} (local)`,
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
  const [name, version = "latest"] = String(tag).split(":");
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
    if (!template?.digest) return { tag, tools: false, sizeGb: bytes / 1e9 };
    // Blob URLs redirect to a CDN, so the fetch has to follow them.
    const blob = await fetchImpl(`${base}/blobs/${template.digest}`, {
      redirect: "follow",
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!blob.ok) return { tag, tools: false, sizeGb: bytes / 1e9 };
    const text = await blob.text();
    return {
      tag,
      tools: /\{\{[^}]*\.Tools/i.test(text),
      sizeGb: Math.round((bytes / 1e9) * 10) / 10,
    };
  } catch {
    // Offline or an unknown tag: the install proceeds unannotated rather than
    // being blocked by a lookup that is only advisory.
    return undefined;
  }
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
    const result = spawn("ollama", ["show", tag], { encoding: "utf8" });
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
    const result = spawn("ollama", ["list"], { encoding: "utf8" });
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
    const result = spawn("ollama", ["ps"], { encoding: "utf8" });
    if (result.status !== 0 || typeof result.stdout !== "string") return [];
    return parseOllamaList(result.stdout).map((entry) => entry.tag);
  } catch {
    return [];
  }
}

// Deleting reclaims gigabytes and cannot be undone without downloading again,
// so the caller must pass explicit consent rather than this inferring it.
export function removeLocalModel(tag, { spawn = spawnSync, confirmed = false, capabilitiesFor } = {}) {
  const value = String(tag || "").trim();
  if (!value) throw new Error("A model tag is required.");
  if (!confirmed) {
    throw new Error(`Removing ${value} deletes it from disk. Pass --yes to confirm.`);
  }
  const result = spawn("ollama", ["rm", value], { encoding: "utf8" });
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
} = {}) {
  const enabled = new Set(selection.enabled);
  const runningSet = new Set(running);
  const cache = capabilities;
  const models = inventory.map((entry) => {
    const caps = cache
      ? cache[entry.tag] || []
      : localModelCapabilities(entry.tag, entry.id);
    return {
      ...entry,
      capabilities: caps,
      enabled: enabled.has(entry.tag),
      running: runningSet.has(entry.tag),
      // Reported by Ollama, not guessed from the name.
      vision: caps.includes("vision"),
      // Codex drives models through tool calls, so a model without them can
      // never be a chat model here -- only a vision reader for the bridge.
      tools: caps.includes("tools"),
      accuracy: benchmarks[entry.tag]?.tier,
      measured: benchmarks[entry.tag],
    };
  });
  return {
    path: LOCAL_MODELS_STATE_PATH,
    installed: models.length,
    enabled: models.filter((model) => model.enabled).length,
    usableAsChat: models.filter((model) => model.tools).length,
    totalGb: Math.round(models.reduce((sum, model) => sum + model.sizeGb, 0) * 10) / 10,
    models,
  };
}
