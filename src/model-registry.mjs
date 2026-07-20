import { readFileSync } from "node:fs";
import path from "node:path";

import { SOURCE_ROOT } from "./paths.mjs";

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
    }
    providers.set(provider.id, Object.freeze(provider));
  }

  const slugs = new Set();
  const gatewayModels = new Set();
  const models = parsed.models.map((model) => {
    if (!model || typeof model !== "object" || Array.isArray(model)) {
      fail("every model must be an object");
    }
    for (const field of ["slug", "gatewayModel", "upstreamModel", "provider"]) {
      if (typeof model[field] !== "string" || !model[field]) {
        fail(`model is missing ${field}`);
      }
    }
    if (!providers.has(model.provider)) {
      fail(`model ${model.slug} references unknown provider ${model.provider}`);
    }
    if (!model.slug.startsWith(`${model.provider}/`)) {
      fail(`model ${model.slug} must be namespaced under ${model.provider}/`);
    }
    if (model.requestProfile !== undefined && typeof model.requestProfile !== "string") {
      fail(`model ${model.slug} has an invalid requestProfile`);
    }
    if (slugs.has(model.slug)) fail(`duplicate model slug ${model.slug}`);
    if (gatewayModels.has(model.gatewayModel)) {
      fail(`duplicate gateway model ${model.gatewayModel}`);
    }
    if (model.listed) {
      for (const field of ["displayName", "description", "defaultEffort", "compHash"]) {
        if (typeof model[field] !== "string" || !model[field]) {
          fail(`listed model ${model.slug} is missing ${field}`);
        }
      }
      if (!Array.isArray(model.reasoningLevels) || model.reasoningLevels.length === 0) {
        fail(`listed model ${model.slug} requires reasoningLevels`);
      }
      if (!Number.isInteger(model.contextWindow) || model.contextWindow < 1) {
        fail(`listed model ${model.slug} requires contextWindow`);
      }
      if (!Number.isInteger(model.priority)) {
        fail(`listed model ${model.slug} requires an integer priority`);
      }
      if (
        !Number.isInteger(model.autoCompact) ||
        model.autoCompact < 1 ||
        model.autoCompact > model.contextWindow
      ) {
        fail(`listed model ${model.slug} requires a valid autoCompact limit`);
      }
      if (
        !Array.isArray(model.inputModalities) ||
        model.inputModalities.length === 0 ||
        model.inputModalities.some((value) => !["text", "image"].includes(value))
      ) {
        fail(`listed model ${model.slug} requires supported inputModalities`);
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
        fail(`listed model ${model.slug} has invalid reasoningLevels`);
      }
    }
    slugs.add(model.slug);
    gatewayModels.add(model.gatewayModel);
    return Object.freeze(model);
  });

  return {
    providers,
    models: Object.freeze(models),
  };
}

const registry = loadRegistry();

export const PROVIDERS = registry.providers;
export const MODELS = registry.models;
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
