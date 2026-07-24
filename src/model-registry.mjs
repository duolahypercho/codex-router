import { readFileSync } from "node:fs";
import path from "node:path";

import { SOURCE_ROOT } from "./paths.mjs";
import { readUserModels } from "./user-models.mjs";

export const REGISTRY_PATH =
  process.env.MODEL_ROUTER_REGISTRY ||
  process.env.CODEX_ROUTER_REGISTRY ||
  path.join(SOURCE_ROOT, "config", "providers.json");

function fail(message) {
  throw new Error(`Invalid provider registry ${REGISTRY_PATH}: ${message}`);
}

function loadRegistry() {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(REGISTRY_PATH, "utf8"));
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
  if (parsed?.version !== 1) fail("version must be 1");
  if (!Array.isArray(parsed.providers) || !Array.isArray(parsed.models)) {
    fail("providers and models must be arrays");
  }

  const providers = new Map();
  for (const provider of parsed.providers) {
    if (!provider || typeof provider !== "object" || Array.isArray(provider)) {
      fail("every provider must be an object");
    }
    if (!/^[a-z0-9][a-z0-9-]*$/.test(provider.id || "")) {
      fail(`invalid provider id ${JSON.stringify(provider.id)}`);
    }
    if (providers.has(provider.id)) fail(`duplicate provider id ${provider.id}`);
    if (!["oauth", "openai-compatible"].includes(provider.kind)) {
      fail(`unsupported provider kind ${provider.kind} for ${provider.id}`);
    }
    for (const field of ["displayName", "ownedBy"]) {
      if (typeof provider[field] !== "string" || !provider[field]) {
        fail(`provider ${provider.id} requires ${field}`);
      }
    }
    if (provider.kind === "oauth" && !provider.proxyBaseEnv) {
      fail(`OAuth provider ${provider.id} requires proxyBaseEnv`);
    }
    if (provider.kind === "openai-compatible") {
      if (!/^https?:\/\//.test(provider.baseUrl || "")) {
        fail(`provider ${provider.id} requires an HTTP(S) baseUrl`);
      }
      if (!provider.credential?.file || !Array.isArray(provider.credential.environment)) {
        fail(`provider ${provider.id} requires credential metadata`);
      }
      if (provider.protocol !== undefined && !["openai", "anthropic"].includes(provider.protocol)) {
        fail(`provider ${provider.id} has an unsupported API protocol`);
      }
    }
    providers.set(provider.id, Object.freeze(provider));
  }

  const slugs = new Set();
  const gatewayModels = new Set();
  const models = parsed.models.map((model) => {
    const problem = modelProblem(model, providers, slugs, gatewayModels);
    if (problem) fail(problem);
    slugs.add(model.slug);
    gatewayModels.add(model.gatewayModel);
    return Object.freeze(model);
  });

  return {
    providers,
    models: Object.freeze(models),
  };
}

// Returns a problem description instead of throwing so the strict registry
// loader can fail hard while the user-model overlay skips with a warning.
function modelProblem(model, providers, slugs, gatewayModels) {
  if (!model || typeof model !== "object" || Array.isArray(model)) {
    return "every model must be an object";
  }
  for (const field of ["slug", "gatewayModel", "upstreamModel", "provider"]) {
    if (typeof model[field] !== "string" || !model[field]) {
      return `model is missing ${field}`;
    }
  }
  if (!providers.has(model.provider)) {
    return `model ${model.slug} references unknown provider ${model.provider}`;
  }
  if (!model.slug.startsWith(`${model.provider}/`)) {
    return `model ${model.slug} must be namespaced under ${model.provider}/`;
  }
  if (model.requestProfile !== undefined && typeof model.requestProfile !== "string") {
    return `model ${model.slug} has an invalid requestProfile`;
  }
  if (slugs.has(model.slug)) return `duplicate model slug ${model.slug}`;
  if (gatewayModels.has(model.gatewayModel)) {
    return `duplicate gateway model ${model.gatewayModel}`;
  }
  if (model.listed) {
    for (const field of ["displayName", "description", "defaultEffort", "compHash"]) {
      if (typeof model[field] !== "string" || !model[field]) {
        return `listed model ${model.slug} is missing ${field}`;
      }
    }
    if (!Array.isArray(model.reasoningLevels) || model.reasoningLevels.length === 0) {
      return `listed model ${model.slug} requires reasoningLevels`;
    }
    if (!Number.isInteger(model.contextWindow) || model.contextWindow < 1) {
      return `listed model ${model.slug} requires contextWindow`;
    }
    if (!Number.isInteger(model.priority)) {
      return `listed model ${model.slug} requires an integer priority`;
    }
    if (
      !Number.isInteger(model.autoCompact) ||
      model.autoCompact < 1 ||
      model.autoCompact > model.contextWindow
    ) {
      return `listed model ${model.slug} requires a valid autoCompact limit`;
    }
    if (
      !Array.isArray(model.inputModalities) ||
      model.inputModalities.length === 0 ||
      model.inputModalities.some((value) => !["text", "image"].includes(value))
    ) {
      return `listed model ${model.slug} requires supported inputModalities`;
    }
    if (
      model.reasoningLevels.some(
        (level) =>
          !level ||
          typeof level.effort !== "string" ||
          !level.effort ||
          typeof level.description !== "string" ||
          !level.description,
      ) ||
      !model.reasoningLevels.some((level) => level.effort === model.defaultEffort)
    ) {
      return `listed model ${model.slug} has invalid reasoningLevels`;
    }
  }
  return undefined;
}

// User-curated models extend the checked-in registry. A broken entry (or a
// collision after an upstream update ships the same model) must never take
// the whole router down, so problems skip the entry and surface as warnings.
function mergeUserModels(base) {
  const warnings = [];
  const models = [...base.models];
  const slugs = new Set(models.map((model) => model.slug));
  const gatewayModels = new Set(models.map((model) => model.gatewayModel));
  for (const model of readUserModels()) {
    const problem = modelProblem(model, base.providers, slugs, gatewayModels);
    if (problem) {
      warnings.push(`Skipped user model: ${problem}`);
      continue;
    }
    slugs.add(model.slug);
    gatewayModels.add(model.gatewayModel);
    models.push(Object.freeze(model));
  }
  return { models: Object.freeze(models), warnings: Object.freeze(warnings) };
}

const registry = loadRegistry();
const merged = mergeUserModels(registry);

export const PROVIDERS = registry.providers;
export const MODELS = merged.models;
export const USER_MODEL_WARNINGS = merged.warnings;
export const LISTED_MODELS = Object.freeze(MODELS.filter((model) => model.listed));
export const API_MODELS = Object.freeze(
  MODELS.filter((model) => PROVIDERS.get(model.provider)?.kind === "openai-compatible"),
);
export const MODEL_BY_SLUG = new Map(MODELS.map((model) => [model.slug, model]));
export const MODEL_BY_GATEWAY_ID = new Map(
  MODELS.map((model) => [model.gatewayModel, model]),
);

export function providerForModel(model) {
  return PROVIDERS.get(model.provider);
}
