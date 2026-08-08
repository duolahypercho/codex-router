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

import { isVisionModelId } from "./vision-host.mjs";

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

// Checking a model publishes it: it joins the user-model overlay, which the
// registry, gateway config, and Codex catalog already consume, so a local
// model reaches the picker through exactly the same path as any curated cloud
// model. Unchecking withdraws it again without touching the download.
export function setLocalModelEnabled(tag, enabled, { vision } = {}) {
  const value = String(tag || "").trim();
  if (!value) throw new Error("A model tag is required.");
  const current = new Set(readLocalModelSelection().enabled);
  if (enabled) current.add(value);
  else current.delete(value);
  const selection = writeSelection({ version: 1, enabled: [...current].sort() });
  syncLocalUserModels({ enabled: selection.enabled, vision });
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
export function syncLocalUserModels({ enabled = readLocalModelSelection().enabled, vision } = {}) {
  const others = readUserModels().filter((model) => model.provider !== LOCAL_PROVIDER_ID);
  const visionTag = (tag) => (typeof vision === "function" ? vision(tag) : isVisionModelId(tag));
  const entries = enabled.map((tag, index) =>
    userModelEntry({
      providerId: LOCAL_PROVIDER_ID,
      upstreamId: tag,
      priority: LOCAL_MODEL_PRIORITY + index,
      metadata: {
        // Only a model that can actually read images may advertise it, exactly
        // as the checked-in registry is held to.
        inputModalities: visionTag(tag) ? ["text", "image"] : ["text"],
        description: `${tag} running locally through Ollama on this machine.`,
      },
    }),
  ).map((entry) => ({ ...entry, displayName: `${entry.upstreamModel} (local)` }));
  writeUserModels([...others, ...entries]);
  return entries;
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
export function removeLocalModel(tag, { spawn = spawnSync, confirmed = false } = {}) {
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
  setLocalModelEnabled(value, false);
  return value;
}

// One view the tray can render directly: what is installed, what is checked,
// what is loaded, and which ones can read images.
export function localModelsSnapshot({
  inventory = localModelInventory(),
  running = runningLocalModels(),
  selection = readLocalModelSelection(),
  benchmarks = {},
} = {}) {
  const enabled = new Set(selection.enabled);
  const runningSet = new Set(running);
  const models = inventory.map((entry) => ({
    ...entry,
    enabled: enabled.has(entry.tag),
    running: runningSet.has(entry.tag),
    vision: isVisionModelId(entry.tag),
    accuracy: benchmarks[entry.tag]?.tier,
    measured: benchmarks[entry.tag],
  }));
  return {
    path: LOCAL_MODELS_STATE_PATH,
    installed: models.length,
    enabled: models.filter((model) => model.enabled).length,
    totalGb: Math.round(models.reduce((sum, model) => sum + model.sizeGb, 0) * 10) / 10,
    models,
  };
}
