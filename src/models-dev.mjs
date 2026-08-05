// Optional metadata enrichment for user-curated models, sourced from the
// community-maintained models.dev catalog (https://models.dev/api.json).
//
// Trust model: the provider's own /v1/models endpoint remains the source of
// truth for which models exist (src/model-discovery.mjs). models.dev only
// supplies picker/routing metadata defaults — context window, auto-compact
// threshold, input modalities, and pricing shown in the description — for
// curated entries. Naming is deliberately untouched: curated models keep the
// router's own "<upstream-id> (curated)" display name. Every value is validated and clamped
// here, written into the local user-model file where the user can edit it,
// and any fetch or parse failure falls back to the conservative defaults in
// src/user-models.mjs. Nothing from models.dev ever touches credentials or
// edits config/providers.json.

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { SOURCE_ROOT } from "./paths.mjs";

export const MODELS_DEV_URL =
  process.env.MODEL_ROUTER_MODELS_DEV_URL || "https://models.dev/api.json";

// A filtered snapshot of the models.dev catalog (MIT-licensed data) is checked
// in so curation still gets metadata offline and every data refresh lands as
// a reviewable diff via bin/update-models-dev-snapshot. The live fetch is
// still tried first: the usual reason to curate is a model newer than any
// checkout. The snapshot file is the single hand-editable artifact — add or
// adjust models directly in it (keys sorted, same shape) and commit the diff.
export const MODELS_DEV_SNAPSHOT_PATH = path.join(SOURCE_ROOT, "config", "models-dev.json");

// Router provider id -> models.dev provider key. Keys were matched against
// each provider's base URL, not just its name (e.g. kimi-api talks to
// api.moonshot.cn, which models.dev files under moonshotai-cn).
export const MODELS_DEV_PROVIDER_KEYS = Object.freeze({
  "anthropic-api": "anthropic",
  cerebras: "cerebras",
  deepseek: "deepseek",
  fireworks: "fireworks-ai",
  "gemini-api": "google",
  "grok-api": "xai",
  groq: "groq",
  huggingface: "huggingface",
  "kimi-api": "moonshotai-cn",
  meta: "meta",
  "minimax-token-plan": "minimax",
  mistral: "mistral",
  "nvidia-nim": "nvidia",
  "ollama-cloud": "ollama-cloud",
  "opencode-go": "opencode-go",
  "opencode-go-messages": "opencode-go",
  "opencode-go-responses": "opencode-go",
  "opencode-zen": "opencode",
  openrouter: "openrouter",
  "qwen-plan": "alibaba-token-plan",
  siliconflow: "siliconflow-cn",
  together: "togetherai",
  "zai-coding": "zai-coding-plan",
});

// Reject rather than clamp implausible context sizes so a corrupted or
// malicious catalog value degrades to the conservative default instead of
// silently reshaping requests.
const MIN_CONTEXT = 4096;
const MAX_CONTEXT = 20_000_000;

export async function fetchModelsDevCatalog({ url = MODELS_DEV_URL, timeoutMs = 10_000 } = {}) {
  const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) {
    throw new Error(`models.dev returned HTTP ${response.status}.`);
  }
  const catalog = await response.json();
  if (!catalog || typeof catalog !== "object" || Array.isArray(catalog)) {
    throw new Error("models.dev returned an invalid catalog document.");
  }
  return catalog;
}

// Reduces a full models.dev catalog to the providers this router maps and the
// fields modelsDevMetadata reads, with deterministically sorted keys so the
// checked-in snapshot diffs cleanly. The result keeps api.json's shape and can
// be passed to modelsDevMetadata directly.
export function filterModelsDevCatalog(catalog) {
  const providers = {};
  for (const key of [...new Set(Object.values(MODELS_DEV_PROVIDER_KEYS))].sort()) {
    const models = catalog?.[key]?.models;
    if (!models || typeof models !== "object") continue;
    const filtered = {};
    for (const id of Object.keys(models).sort()) {
      const model = models[id];
      if (!model || typeof model !== "object") continue;
      const entry = {};
      if (typeof model.name === "string" && model.name.trim()) entry.name = model.name.trim();
      if (Number.isInteger(model.limit?.context)) entry.limit = { context: model.limit.context };
      if (Array.isArray(model.modalities?.input)) {
        entry.modalities = { input: model.modalities.input.filter((v) => typeof v === "string") };
      }
      const input = Number(model.cost?.input);
      const output = Number(model.cost?.output);
      if (Number.isFinite(input) && Number.isFinite(output)) {
        entry.cost = { input, output };
      }
      filtered[id] = entry;
    }
    providers[key] = { models: filtered };
  }
  return providers;
}

export function readModelsDevSnapshot() {
  if (!existsSync(MODELS_DEV_SNAPSHOT_PATH)) return undefined;
  try {
    const snapshot = JSON.parse(readFileSync(MODELS_DEV_SNAPSHOT_PATH, "utf8"));
    if (snapshot?.version !== 1 || typeof snapshot.providers !== "object") return undefined;
    return snapshot;
  } catch {
    return undefined;
  }
}

function autoCompactFor(contextWindow) {
  const raw = Math.floor(contextWindow * 0.85);
  const rounded = raw >= 2000 ? Math.floor(raw / 1000) * 1000 : raw;
  return Math.max(1, rounded);
}

function sanitizedModalities(input) {
  if (!Array.isArray(input)) return undefined;
  const allowed = input.filter((value) => ["text", "image"].includes(value));
  if (!allowed.includes("text")) allowed.unshift("text");
  return [...new Set(allowed)];
}

function priceLine(cost) {
  const input = Number(cost?.input);
  const output = Number(cost?.output);
  if (!Number.isFinite(input) || !Number.isFinite(output) || input < 0 || output < 0) {
    return undefined;
  }
  return `$${input}/M input, $${output}/M output`;
}

function findModel(catalog, providerKey, upstreamId) {
  const models = catalog?.[providerKey]?.models;
  if (!models || typeof models !== "object") return undefined;
  if (models[upstreamId]) return models[upstreamId];
  const wanted = upstreamId.toLowerCase();
  for (const [id, model] of Object.entries(models)) {
    if (id.toLowerCase() === wanted) return model;
  }
  return undefined;
}

// Returns validated metadata overrides for userModelEntry, or undefined when
// models.dev has nothing usable for this model. Only fields that pass
// validation are included, so callers can spread the result over defaults.
export function modelsDevMetadata(catalog, providerId, upstreamId) {
  const providerKey = MODELS_DEV_PROVIDER_KEYS[providerId];
  if (!providerKey) return undefined;
  const model = findModel(catalog, providerKey, upstreamId);
  if (!model || typeof model !== "object") return undefined;

  const metadata = {};
  const context = model.limit?.context;
  if (Number.isInteger(context) && context >= MIN_CONTEXT && context <= MAX_CONTEXT) {
    metadata.contextWindow = context;
    metadata.autoCompact = autoCompactFor(context);
  }
  const modalities = sanitizedModalities(model.modalities?.input);
  if (modalities) metadata.inputModalities = modalities;
  const price = priceLine(model.cost);
  const notes = [price, "metadata from models.dev; edit the user model file to override"]
    .filter(Boolean)
    .join("; ");
  metadata.description = `User-curated ${providerId} model (${notes}).`;
  metadata.metadataSource = "models.dev";
  return Object.keys(metadata).length > 2 ? metadata : undefined;
}
