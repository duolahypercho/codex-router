import { readFileSync } from "node:fs";
import path from "node:path";

import { SOURCE_ROOT } from "./paths.mjs";

export const REGISTRY_PATH =
  process.env.CODEX_ROUTER_REGISTRY || path.join(SOURCE_ROOT, "config", "providers.json");

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
