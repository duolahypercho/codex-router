import {
  curatedModelContextLength,
  curatedModelOutputLimit,
  curatedModelReasoningLevels,
} from "./opencode-curation.mjs";

// A catalog record is evidence, not a routing declaration. Keep only fields
// the provider publishes (plus the two documented supplements below), and
// omit every unknown rather than filling it with the curation defaults.
// That distinction matters for catalog-only providers: their changing list is
// useful for review, but it does not prove a model's wire protocol or tool
// behavior well enough to publish the model into Codex.

const EFFORT_ORDER = Object.freeze([
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra",
]);
const EFFORT_RANK = new Map(EFFORT_ORDER.map((effort, index) => [effort, index]));

// MiniMax's /models response currently contains ids only. These windows come
// from the provider's model-selection table, not from an inferred family
// default: https://platform.minimax.io/docs/guides/text-generation
const MINIMAX_CONTEXT_WINDOWS = Object.freeze({
  "MiniMax-M2": 204_800,
  "MiniMax-M2.1": 204_800,
  "MiniMax-M2.1-highspeed": 204_800,
  "MiniMax-M2.5": 204_800,
  "MiniMax-M2.5-highspeed": 204_800,
  "MiniMax-M2.7": 204_800,
  "MiniMax-M2.7-highspeed": 204_800,
  "MiniMax-M3": 1_000_000,
});

function positiveInteger(...values) {
  let smallest;
  for (const value of values) {
    if (!Number.isInteger(value) || value < 1) continue;
    if (smallest === undefined || value < smallest) smallest = value;
  }
  return smallest;
}

function boolean(value) {
  return typeof value === "boolean" ? value : undefined;
}

function strings(value) {
  if (!Array.isArray(value)) return undefined;
  const kept = [...new Set(value
    .filter((entry) => typeof entry === "string" && entry.trim())
    .map((entry) => entry.trim().toLowerCase()))]
    .sort();
  return kept.length ? kept : undefined;
}

function efforts(value) {
  const kept = strings(value);
  return kept?.sort((left, right) => {
    const leftRank = EFFORT_RANK.get(left) ?? Number.MAX_SAFE_INTEGER;
    const rightRank = EFFORT_RANK.get(right) ?? Number.MAX_SAFE_INTEGER;
    return leftRank - rightRank || left.localeCompare(right);
  });
}

function compact(value) {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined));
}

function nonempty(value) {
  return Object.keys(value).length ? value : undefined;
}

function openRouterMetadata(item) {
  const supportedParameters = new Set(strings(item?.supported_parameters) || []);
  const advertisedEfforts = efforts(item?.reasoning?.supported_efforts);
  const reasoning = item?.reasoning && typeof item.reasoning === "object"
    ? nonempty(compact({
        supported: true,
        configurable: advertisedEfforts ? true : false,
        supportedEfforts: advertisedEfforts,
        defaultEffort: typeof item.reasoning.default_effort === "string"
          ? item.reasoning.default_effort.trim().toLowerCase()
          : undefined,
        mandatory: boolean(item.reasoning.mandatory),
        defaultEnabled: boolean(item.reasoning.default_enabled),
      }))
    : undefined;
  return nonempty(compact({
    contextWindow: positiveInteger(item?.context_length, item?.top_provider?.context_length),
    maxOutputTokens: positiveInteger(item?.top_provider?.max_completion_tokens),
    inputModalities: strings(item?.architecture?.input_modalities),
    outputModalities: strings(item?.architecture?.output_modalities),
    supportsTools: supportedParameters.size ? supportedParameters.has("tools") : undefined,
    supportsToolChoice: supportedParameters.size ? supportedParameters.has("tool_choice") : undefined,
    reasoning,
    metadataSource: "provider-catalog",
  }));
}

function veniceMetadata(item) {
  const capabilities = item?.model_spec?.capabilities;
  const advertisedEfforts = efforts(capabilities?.reasoningEffortOptions);
  const inputModalities = capabilities && typeof capabilities === "object"
    ? [
        "text",
        capabilities.supportsVision ? "image" : undefined,
        capabilities.supportsAudioInput ? "audio" : undefined,
        capabilities.supportsVideoInput ? "video" : undefined,
      ].filter(Boolean)
    : undefined;
  const reasoningSupported = boolean(capabilities?.supportsReasoning);
  const configurable = boolean(capabilities?.supportsReasoningEffort);
  const reasoning = reasoningSupported !== undefined || configurable !== undefined || advertisedEfforts
    ? nonempty(compact({
        supported: reasoningSupported,
        configurable,
        // Discovery is evidence about the provider catalog, not a wire
        // compatibility certificate. Preserve Venice's advertised ladder for
        // operator curation unless this exact route earns checked-in proof.
        supportedEfforts: advertisedEfforts,
        defaultEffort: typeof capabilities?.defaultReasoningEffort === "string"
          ? capabilities.defaultReasoningEffort.trim().toLowerCase()
          : undefined,
      }))
    : undefined;
  return nonempty(compact({
    contextWindow: positiveInteger(item?.context_length, item?.model_spec?.availableContextTokens),
    maxOutputTokens: positiveInteger(item?.model_spec?.maxCompletionTokens),
    inputModalities,
    outputModalities: item?.type === "text" ? ["text"] : undefined,
    supportsTools: boolean(capabilities?.supportsFunctionCalling),
    reasoning,
    metadataSource: "provider-catalog",
  }));
}

function minimaxMetadata(item) {
  const id = String(item?.id || "").trim();
  const contextWindow = MINIMAX_CONTEXT_WINDOWS[id];
  if (!contextWindow) return undefined;
  return {
    contextWindow,
    ...(id === "MiniMax-M3" ? { inputModalities: ["text", "image", "video"] } : {}),
    outputModalities: ["text"],
    // MiniMax documents reasoning output, but its API reference does not
    // publish a reasoning-effort selector. No synthetic effort ladder belongs
    // in a record whose purpose is exact capability evidence.
    reasoning: { supported: true, configurable: false },
    metadataSource: "official-documentation",
  };
}

function openCodeFreeMetadata(item) {
  const id = String(item?.id || "").trim();
  const contextWindow = curatedModelContextLength("opencode-free", id);
  const maxOutputTokens = curatedModelOutputLimit("opencode-free", id);
  const supportedEfforts = efforts(curatedModelReasoningLevels("opencode-free", id));
  if (!contextWindow && !maxOutputTokens && !supportedEfforts) return undefined;
  return compact({
    contextWindow,
    maxOutputTokens,
    reasoning: supportedEfforts
      ? { supported: true, configurable: true, supportedEfforts }
      : undefined,
    metadataSource: "opencode-published-metadata",
  });
}

export function modelCatalogMetadata(payload, provider) {
  const data = Array.isArray(payload) ? payload : payload?.data ?? payload?.models;
  if (!Array.isArray(data)) return {};
  const metadata = Object.create(null);
  for (const item of data) {
    const id = String(item?.id ?? item?.slug ?? "").trim();
    if (!id || Object.hasOwn(metadata, id)) continue;
    const value = provider?.id === "venice"
      ? veniceMetadata(item)
      : provider?.id === "minimax-token-plan"
        ? minimaxMetadata(item)
        : provider?.id === "opencode-free"
          ? openCodeFreeMetadata(item)
          : provider?.id === "openrouter" || provider?.id === "nousresearch"
            ? openRouterMetadata(item)
            : undefined;
    if (value) metadata[id] = value;
  }
  return Object.fromEntries(Object.entries(metadata).sort(([left], [right]) => left.localeCompare(right)));
}

export const MODEL_CATALOG_METADATA_SOURCES = Object.freeze({
  "minimax-token-plan": Object.freeze([
    "https://api.minimax.io/v1/models",
    "https://platform.minimax.io/docs/guides/text-generation",
    "https://platform.minimax.io/docs/api-reference/text-post",
  ]),
  nousresearch: Object.freeze([
    "https://inference-api.nousresearch.com/v1/models",
    "https://hermes-agent.nousresearch.com/docs/user-guide/configuration",
  ]),
  "opencode-free": Object.freeze([
    "https://opencode.ai/zen/v1/models",
    "https://models.dev/api.json",
  ]),
  openrouter: Object.freeze([
    "https://openrouter.ai/api/v1/models",
    "https://openrouter.ai/docs/guides/best-practices/reasoning-tokens",
  ]),
  venice: Object.freeze([
    "https://api.venice.ai/api/v1/models",
    "https://docs.venice.ai/guides/features/reasoning-models",
  ]),
});
