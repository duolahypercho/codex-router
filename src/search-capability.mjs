import { genericProviderConfigured } from "./generic-provider-readiness.mjs";
import { RUNTIME_PROVIDERS } from "./model-registry.mjs";
import { trustedSearchProviderDescriptor } from "./search-sidecar-policy.mjs";
import { searchSidecarBindingForModel } from "./search-sidecar-state.mjs";

export function sidecarSearchAvailable(model, {
  bindingForModel = searchSidecarBindingForModel,
  providers = RUNTIME_PROVIDERS,
  providerReady = genericProviderConfigured,
} = {}) {
  let binding;
  try {
    binding = bindingForModel(model?.slug);
  } catch {
    return false;
  }
  if (!binding || model?.searchTool !== undefined) return false;
  const provider = providers.get(binding.providerId);
  return trustedSearchProviderDescriptor(provider, { requireGeneric: true }) && providerReady(provider.id);
}

// The catalog and the last provider-facing hop must answer this question from
// the same evidence. A checked-in/user model can own search directly, while a
// separately credentialed sidecar can add it to one exact routed slug. An
// OpenAI-compatible endpoint alone proves neither capability.
export function routedModelSearchAvailable(model, options) {
  return routedModelSearchMode(model, options) !== undefined;
}

export function routedModelSearchMode(model, options) {
  if (["hosted", "standalone"].includes(model?.searchTool?.mode)) {
    return model.searchTool.mode;
  }
  return sidecarSearchAvailable(model, options) ? "standalone" : undefined;
}

export function routedModelPreservesSearchContract(
  model,
  { requiredMode, hasSearchHistory = false } = {},
  options,
) {
  // Replaying a completed search call is a provider-input compatibility
  // question, not proof that the destination can execute a new search. Keep
  // that narrower capability separate so a model can accept prior
  // `web_search_call` items without advertising a search tool to Codex.
  if (hasSearchHistory && !requiredMode) {
    return model?.supportsSearchHistory === true;
  }
  return searchModePreservesSearchContract(
    routedModelSearchMode(model, options),
    { requiredMode },
  );
}

export function searchModePreservesSearchContract(
  searchMode,
  { requiredMode } = {},
) {
  return !requiredMode || searchMode === requiredMode;
}

const HOSTED_SEARCH_TOOL_TYPES = new Set(["web_search", "web_search_preview"]);

function hostedSearchTool(tool) {
  return HOSTED_SEARCH_TOOL_TYPES.has(tool?.type);
}

function unsupportedSearchError(message) {
  const error = new Error(message);
  error.status = 400;
  error.code = "model_search_not_supported";
  return error;
}

export function unsupportedSearchContractError(model) {
  const label = model ? `Model ${model}` : "The selected model";
  return unsupportedSearchError(
    `${label} can no longer preserve this turn's web-search execution contract.`,
  );
}

// Codex can attach provider-hosted search fields to a routed turn even when
// the selected catalog entry advertises supports_search_tool=false. Remove
// only those ambient hosted-search extensions. Function tools -- including a
// function literally named web_search -- are ordinary caller-owned tools and
// remain byte-for-byte intact.
export function stripUnsupportedHostedSearch(payload, { model } = {}) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return payload;
  const tools = Array.isArray(payload.tools) ? payload.tools : undefined;
  const strippedTools = tools?.filter((tool) => !hostedSearchTool(tool));
  const removedTools = Boolean(tools && strippedTools.length !== tools.length);
  const include = Array.isArray(payload.include) ? payload.include : undefined;
  const strippedInclude = include?.filter(
    (entry) => typeof entry !== "string" || !entry.startsWith("web_search_call."),
  );
  const removedInclude = Boolean(include && strippedInclude.length !== include.length);
  const removedOptions = payload.web_search_options !== undefined;
  const explicitHostedChoice = hostedSearchTool(payload.tool_choice);
  if (!removedTools && !removedInclude && !removedOptions && !explicitHostedChoice) return payload;

  const label = model ? `Model ${model}` : "The selected model";
  if (explicitHostedChoice) {
    throw unsupportedSearchError(
      `${label} does not advertise web search, but tool_choice explicitly selects it.`,
    );
  }
  if (removedTools && payload.tool_choice === "required" && strippedTools.length === 0) {
    throw unsupportedSearchError(
      `${label} does not advertise web search, and no supported tool remains for tool_choice required.`,
    );
  }

  const next = { ...payload };
  delete next.web_search_options;
  if (removedTools) {
    if (strippedTools.length) next.tools = strippedTools;
    else delete next.tools;
  }
  if (removedInclude) {
    if (strippedInclude.length) next.include = strippedInclude;
    else delete next.include;
  }
  if (
    removedTools &&
    strippedTools.length === 0 &&
    ["auto", "none"].includes(next.tool_choice)
  ) {
    delete next.tool_choice;
  }
  return next;
}
