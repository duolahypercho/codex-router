// Provider-scoped model metadata.  This module deliberately does not import
// the registry or publish a Codex catalog: live provider data is untrusted
// input, and native GPT metadata remains owned by Codex itself.

const MODALITIES = new Set(["text", "image", "audio", "video", "file"]);
const MAX_CONTEXT_WINDOW = 16_777_216;
const MAX_MODEL_ID_LENGTH = 512;
const MAX_DISPLAY_NAME_LENGTH = 240;
const PROFILE_PATTERN = /^[a-z0-9][a-z0-9._-]{0,79}$/;
const COST_FIELDS = [
  "input",
  "output",
  "prompt",
  "completion",
  "inputCacheRead",
  "inputCacheWrite",
  "cacheRead",
  "cacheWrite",
];

export const MODEL_METADATA_FIELDS = Object.freeze([
  "upstreamId",
  "displayName",
  "contextWindow",
  "inputModalities",
  "outputModalities",
  "supportsTools",
  "supportsReasoning",
  "supportsVision",
  "supportsSearch",
  "cost",
  "requestProfile",
]);

export const CONSERVATIVE_MODEL_DEFAULTS = Object.freeze({
  contextWindow: 131_072,
  inputModalities: Object.freeze(["text"]),
  outputModalities: Object.freeze(["text"]),
  supportsTools: false,
  supportsReasoning: false,
  supportsVision: false,
  supportsSearch: false,
});

function has(source, key) {
  return source !== null && typeof source === "object" &&
    Object.prototype.hasOwnProperty.call(source, key);
}

function own(source, key) {
  return has(source, key) ? source[key] : undefined;
}

function finitePositiveInteger(value, field, { max = MAX_CONTEXT_WINDOW } = {}) {
  if (!Number.isInteger(value) || value < 1 || value > max) {
    throw new Error(`${field} must be a positive integer no greater than ${max}.`);
  }
  return value;
}

function normalizeModalities(value, field) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`${field} must be a non-empty array.`);
  }
  const result = [...new Set(value.map((item) => {
    if (typeof item !== "string" || !MODALITIES.has(item.trim().toLowerCase())) {
      throw new Error(`${field} contains an unsupported modality.`);
    }
    return item.trim().toLowerCase();
  }))];
  if (!result.length) throw new Error(`${field} must contain a supported modality.`);
  return result;
}

function normalizeBoolean(value, field) {
  if (typeof value !== "boolean") throw new Error(`${field} must be a boolean.`);
  return value;
}

function normalizeCost(value) {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("cost must be an object.");
  }
  const result = {};
  for (const [key, raw] of Object.entries(value)) {
    if (!COST_FIELDS.includes(key)) throw new Error(`cost has an unsupported field ${key}.`);
    const numeric = typeof raw === "string" && raw.trim() !== "" ? Number(raw) : raw;
    if (typeof numeric !== "number" || !Number.isFinite(numeric) || numeric < 0) {
      throw new Error(`cost.${key} must be a non-negative number.`);
    }
    result[key] = numeric;
  }
  return result;
}

function normalizeRequestProfile(value) {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !PROFILE_PATTERN.test(value.trim())) {
    throw new Error("requestProfile must be a short lower-case profile id.");
  }
  return value.trim();
}

/**
 * Validate a canonical metadata object.  Missing fields are intentional and
 * mean "the source did not make a claim"; mergeModelMetadata supplies the
 * conservative fallback only after higher-priority sources are considered.
 */
export function normalizeModelMetadata(value, { upstreamId } = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Model metadata must be an object.");
  }
  const id = upstreamId ?? value.upstreamId;
  if (typeof id !== "string" || !id.trim() || id.length > MAX_MODEL_ID_LENGTH) {
    throw new Error("upstreamId must be a non-empty model id.");
  }
  const result = { upstreamId: id.trim() };
  if (has(value, "displayName")) {
    if (typeof value.displayName !== "string" || !value.displayName.trim() || value.displayName.length > MAX_DISPLAY_NAME_LENGTH) {
      throw new Error("displayName must be a non-empty string of at most 240 characters.");
    }
    result.displayName = value.displayName.trim();
  }
  if (has(value, "contextWindow")) result.contextWindow = finitePositiveInteger(value.contextWindow, "contextWindow");
  if (has(value, "inputModalities")) result.inputModalities = normalizeModalities(value.inputModalities, "inputModalities");
  if (has(value, "outputModalities")) result.outputModalities = normalizeModalities(value.outputModalities, "outputModalities");
  for (const field of ["supportsTools", "supportsReasoning", "supportsVision", "supportsSearch"]) {
    if (has(value, field)) result[field] = normalizeBoolean(value[field], field);
  }
  if (has(value, "cost")) result.cost = normalizeCost(value.cost);
  if (has(value, "requestProfile")) result.requestProfile = normalizeRequestProfile(value.requestProfile);
  return result;
}

function first(source, keys) {
  for (const key of keys) if (has(source, key) && source[key] !== undefined && source[key] !== null) return source[key];
  return undefined;
}

function boolFrom(source, keys) {
  const value = first(source, keys);
  return typeof value === "boolean" ? value : undefined;
}

function modalitiesFrom(source, keys) {
  const value = first(source, keys);
  if (value === undefined) return undefined;
  return normalizeModalities(value, keys[0]);
}

/** Convert a provider's OpenAI-compatible `/models` record into canonical metadata. */
export function modelMetadataFromProviderRecord(record) {
  if (!record || typeof record !== "object" || Array.isArray(record)) {
    throw new Error("Provider model metadata must be an object.");
  }
  const upstreamId = first(record, ["id", "model", "upstreamId"]);
  if (typeof upstreamId !== "string" || !upstreamId.trim()) {
    throw new Error("Provider model metadata is missing id.");
  }
  const architecture = record.architecture && typeof record.architecture === "object" ? record.architecture : {};
  const capabilities = record.capabilities && typeof record.capabilities === "object" ? record.capabilities : {};
  const supports = capabilities.supports && typeof capabilities.supports === "object" ? capabilities.supports : {};
  const metadata = { upstreamId: upstreamId.trim() };
  const displayName = first(record, ["display_name", "displayName", "name"]);
  if (displayName !== undefined) metadata.displayName = displayName;

  const context = first(record, ["context_length", "contextWindow", "context_window", "max_context_window_tokens"])
    ?? first(capabilities, ["context_length", "context_window"])
    ?? first(capabilities.limits || {}, ["max_context_window_tokens"])
    ?? first(record.top_provider || {}, ["context_length"]);
  if (context !== undefined) metadata.contextWindow = typeof context === "string" && /^\d+$/.test(context.trim()) ? Number(context) : context;

  const input = modalitiesFrom(record, ["input_modalities", "inputModalities"])
    ?? modalitiesFrom(architecture, ["input_modalities", "inputModalities"]);
  if (input) metadata.inputModalities = input;
  const output = modalitiesFrom(record, ["output_modalities", "outputModalities"])
    ?? modalitiesFrom(architecture, ["output_modalities", "outputModalities"]);
  if (output) metadata.outputModalities = output;

  const tools = boolFrom(record, ["supports_tools", "supportsTools", "tool_calls"])
    ?? boolFrom(capabilities, ["supports_tools", "supportsTools"])
    ?? boolFrom(supports, ["tool_calls", "tools"]);
  if (tools !== undefined) metadata.supportsTools = tools;
  const reasoning = boolFrom(record, ["supports_reasoning", "supportsReasoning"])
    ?? boolFrom(capabilities, ["supports_reasoning", "supportsReasoning"])
    ?? (typeof capabilities.reasoning === "boolean" ? capabilities.reasoning : undefined);
  if (reasoning !== undefined) metadata.supportsReasoning = reasoning;
  const vision = boolFrom(record, ["supports_vision", "supportsVision"])
    ?? boolFrom(capabilities, ["supports_vision", "supportsVision"]);
  if (vision !== undefined) metadata.supportsVision = vision;
  else if (input?.includes("image")) metadata.supportsVision = true;
  const search = boolFrom(record, ["supports_search", "supportsSearch", "web_search"])
    ?? boolFrom(capabilities, ["supports_search", "supportsSearch", "web_search"]);
  if (search !== undefined) metadata.supportsSearch = search;

  const pricing = record.pricing ?? record.cost;
  if (pricing && typeof pricing === "object" && !Array.isArray(pricing)) {
    const cost = {
      ...(pricing.input !== undefined ? { input: pricing.input } : {}),
      ...(pricing.output !== undefined ? { output: pricing.output } : {}),
      ...(pricing.prompt !== undefined ? { prompt: pricing.prompt } : {}),
      ...(pricing.completion !== undefined ? { completion: pricing.completion } : {}),
      ...(pricing.input_cache_read !== undefined ? { inputCacheRead: pricing.input_cache_read } : {}),
      ...(pricing.input_cache_write !== undefined ? { inputCacheWrite: pricing.input_cache_write } : {}),
      ...(pricing.cache_read !== undefined ? { cacheRead: pricing.cache_read } : {}),
      ...(pricing.cache_write !== undefined ? { cacheWrite: pricing.cache_write } : {}),
    };
    if (Object.keys(cost).length) metadata.cost = cost;
  }
  if (record.requestProfile !== undefined) metadata.requestProfile = record.requestProfile;
  return normalizeModelMetadata(metadata);
}

/** Convert an existing registry/user model into the same metadata shape. */
export function modelMetadataFromPreset(model) {
  if (!model || typeof model !== "object") throw new Error("Model preset must be an object.");
  const metadata = {
    upstreamId: model.upstreamId ?? model.upstreamModel,
    ...(model.displayName ? { displayName: model.displayName } : {}),
    ...(model.contextWindow !== undefined ? { contextWindow: model.contextWindow } : {}),
    ...(model.inputModalities ? { inputModalities: model.inputModalities } : {}),
    ...(model.outputModalities ? { outputModalities: model.outputModalities } : {}),
    ...(model.supportsTools !== undefined ? { supportsTools: model.supportsTools } : {}),
    ...(model.supportsReasoning !== undefined ? { supportsReasoning: model.supportsReasoning } : {}),
    ...(model.supportsVision !== undefined ? { supportsVision: model.supportsVision } : {}),
    ...(model.supportsSearch !== undefined ? { supportsSearch: model.supportsSearch } : {}),
    ...(model.searchTool !== undefined ? { supportsSearch: true } : {}),
    ...(model.cost !== undefined ? { cost: model.cost } : {}),
    ...(model.requestProfile !== undefined ? { requestProfile: model.requestProfile } : {}),
  };
  if (metadata.supportsReasoning === undefined && Array.isArray(model.reasoningLevels)) {
    metadata.supportsReasoning = model.reasoningLevels.length > 0;
  }
  if (metadata.supportsVision === undefined && Array.isArray(model.inputModalities)) {
    metadata.supportsVision = model.inputModalities.includes("image");
  }
  return normalizeModelMetadata(metadata);
}

/**
 * Merge one provider's user overrides, verified presets and live metadata.
 * Fields are merged independently, so an explicit `false` remains false and
 * a user display label does not discard live context or pricing metadata.
 */
export function mergeModelMetadata({ providerId, upstreamId, user, userOverride, verifiedPreset, live, defaults = {} } = {}) {
  const id = upstreamId ?? userOverride?.upstreamId ?? user?.upstreamId ?? verifiedPreset?.upstreamId ?? live?.upstreamId;
  if (typeof id !== "string" || !id.trim()) throw new Error("mergeModelMetadata requires upstreamId.");
  const sources = [
    CONSERVATIVE_MODEL_DEFAULTS,
    defaults,
    live,
    verifiedPreset,
    userOverride ?? user,
  ].filter(Boolean);
  const result = { upstreamId: id.trim() };
  for (const field of MODEL_METADATA_FIELDS) {
    if (field === "upstreamId") continue;
    for (let index = sources.length - 1; index >= 0; index -= 1) {
      if (has(sources[index], field)) {
        result[field] = sources[index][field];
        break;
      }
    }
  }
  // A model's clean label is always available, but the fallback is applied
  // after source precedence so a preset name is never replaced by its id.
  if (!has(result, "displayName")) result.displayName = id.trim();
  return normalizeModelMetadata(result, { upstreamId: id.trim() });
}

/**
 * Build the provider-local catalog without touching native GPT models. User
 * entries are kept even when a provider stopped returning them from `/models`.
 */
export function mergeDiscoveredModels({ providerId, live = [], verifiedPresets = [], userOverrides = [], defaults } = {}) {
  if (!Array.isArray(live) || !Array.isArray(verifiedPresets) || !Array.isArray(userOverrides)) {
    throw new Error("Model discovery inputs must be arrays.");
  }
  const sourceById = new Map();
  const add = (entry, source) => {
    const metadata = source === "live" ? modelMetadataFromProviderRecord(entry) : normalizeModelMetadata(entry);
    const id = metadata.upstreamId;
    const current = sourceById.get(id) || { upstreamId: id };
    current[source] = metadata;
    sourceById.set(id, current);
  };
  for (const entry of verifiedPresets) add(entry, "verifiedPreset");
  for (const entry of live) add(entry, "live");
  for (const entry of userOverrides) add(entry, "userOverride");
  return [...sourceById.values()].map((sources) => ({
    ...mergeModelMetadata({ providerId, ...sources, defaults }),
    userDefined: Boolean(sources.userOverride),
  }));
}

export function modelMetadataMap(models) {
  if (!models || typeof models !== "object" || Array.isArray(models)) throw new Error("models must be an object.");
  const result = {};
  for (const [id, value] of Object.entries(models)) {
    const metadata = normalizeModelMetadata(value, { upstreamId: id });
    result[id] = metadata;
  }
  return result;
}
