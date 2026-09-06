import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

import {
  genericProviderRuntimeDescriptor,
  readGenericProviders,
} from "./generic-provider-state.mjs";
import {
  normalizeSupportedEndpoints,
  providerModelEndpoint,
} from "./openai-endpoint-policy.mjs";
import {
  curatedModelInputModalities,
  curatedModelIsFree,
  curatedModelToolSchemaRecursion,
} from "./opencode-curation.mjs";
import { instructionOverlayExists } from "./instruction-overlays.mjs";
import { SOURCE_ROOT } from "./paths.mjs";
import { officialModelDisplayName, readUserModels } from "./user-models.mjs";
import { curatableRequestProfile, requestProfileKnown } from "./request-profiles.mjs";
import { VERTEX_ADAPTERS } from "./vertex-adapters.mjs";

export const REGISTRY_PATH =
  process.env.MODEL_ROUTER_REGISTRY ||
  process.env.CODEX_ROUTER_REGISTRY ||
  path.join(SOURCE_ROOT, "config");

function fail(message) {
  throw new Error(`Invalid provider registry ${REGISTRY_PATH}: ${message}`);
}

// Remote providers that intentionally accept anonymous traffic are a much
// narrower class than local `keyless` providers. Keep the allowlist here so a
// future registry entry cannot turn an arbitrary HTTPS endpoint into a
// credential-free exfiltration path.
const ANONYMOUS_ENDPOINTS = Object.freeze({
  "opencode-free": "https://opencode.ai/zen/v1",
  "opencode-free-responses": "https://opencode.ai/zen/v1",
  "kilo-free": "https://api.kilo.ai/api/gateway",
});

// The same guarantee, one level down. A per-model endpoint moves the address
// out of the provider and into the model, so the allowlist has to follow it or
// it stops being an allowlist at all: without this, adding a JSON fragment
// under `config/custom/` would be enough to make the router send an operator's
// prompts to any HTTPS host on earth with no credential and no review. Keyed
// on the slug, which is what a fragment cannot forge without colliding.
const ANONYMOUS_MODEL_ENDPOINTS = Object.freeze({
  "custom/qwen3.8-27b":
    "https://g9hnto0u7lvbu837.us-east-2.aws.endpoints.huggingface.cloud/v1",
});

export function anonymousModelAllowed(provider, modelId) {
  const id = typeof modelId === "string" ? modelId.trim() : "";
  if (provider?.authMode !== "anonymous" || !id) return false;
  if (provider.anonymousModelPolicy === "opencode-console") {
    return id === "big-pickle" || id.endsWith("-free");
  }
  if (provider.anonymousModelPolicy === "suffix-free") return id.endsWith(":free");
  if (provider.anonymousModelPolicy === "explicit-models") {
    return Array.isArray(provider.anonymousModels) && provider.anonymousModels.includes(id);
  }
  return false;
}

// A provider that defers its address to its models has no endpoint of its own,
// so every consumer that used to read `provider.baseUrl` has to ask this
// instead. The descriptor is deliberately provider-shaped: `baseUrl`,
// `authMode`, `keyless`, and `credential` mean exactly what they mean on a
// provider, so `resolveProviderBaseUrl` and the whole credential resolution
// chain accept one unchanged rather than growing a parallel implementation.
// Its `id` is the model slug, which is what makes a per-model credential file
// and Keychain entry distinct from every other endpoint's.
export function endpointForModel(model, providers = RUNTIME_PROVIDERS) {
  const provider = providers.get(model?.provider);
  return provider?.perModelEndpoint ? model.endpoint : provider;
}

// "Nothing for the operator to supply to *this provider*" — three different
// reasons, one consequence, and every surface that offers to take a key has to
// agree on it. Named once because the list grew a third member and the four
// call sites that spelled it inline would each have had to be found.
export function providerNeedsNoKey(provider) {
  return Boolean(provider?.keyless) || ["anonymous", "per-model"].includes(provider?.authMode);
}

function normalizedBaseUrl(value) {
  return String(value || "").replace(/\/+$/, "");
}

function loopbackBaseUrl(value) {
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) &&
      ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
  } catch {
    return false;
  }
}

// The loader proves a keyless provider's checked-in baseUrl is loopback, but
// an environment override arrives at request time and skips that proof. A
// keyless request carries no credential, so a non-loopback override would send
// unauthenticated traffic off-box. Resolve overrides through this guard: the
// override is refused — not the request — because the registry URL is always
// safe to fall back to. Anonymous providers never allow an override at all
// (the loader rejects baseUrlEnv on them), so they resolve to their fixed
// endpoint here by construction.
export function resolveProviderBaseUrl(provider, env = process.env) {
  const override = provider.baseUrlEnv ? env[provider.baseUrlEnv] : undefined;
  const raw = normalizedBaseUrl(override || provider.baseUrl);
  if (provider.keyless && !loopbackBaseUrl(raw)) {
    return { baseUrl: normalizedBaseUrl(provider.baseUrl), refusedOverride: raw };
  }
  return { baseUrl: raw };
}

// Byte-order comparison keeps the walk identical on every machine; a
// locale-aware sort could reorder fragments (and therefore the merged model
// list) between hosts.
function byName(a, b) {
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}

function registryFragmentFiles(root) {
  const files = [];
  for (const entry of readdirSync(root, { withFileTypes: true }).sort(byName)) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) files.push(...registryFragmentFiles(full));
    else if (
      entry.isFile() &&
      entry.name.endsWith(".json") &&
      entry.name !== "support-catalog.json"
    ) files.push(full);
  }
  return files;
}

function parseFragment(file) {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    fail(`${file}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (parsed?.version !== 1) fail(`${file}: version must be 1`);
  for (const field of ["providers", "models"]) {
    if (parsed[field] !== undefined && !Array.isArray(parsed[field])) {
      fail(`${file}: ${field} must be an array`);
    }
  }
  return parsed;
}

// The checked-in registry is a directory tree — one vendor directory holding
// a `<vendor>.json` provider file plus per-access-method `models.json`
// fragments (config/kimi/kimi.json, config/kimi/oauth/models.json, ...).
// Fragments merge in sorted-path order so the result is deterministic; a
// model still names its provider explicitly, so the directory layout is
// purely organizational. A single-file registry (the pre-split format, still
// used by MODEL_ROUTER_REGISTRY overrides in tests and tooling) keeps
// working unchanged.
export function readRegistryDocument(root = REGISTRY_PATH) {
  let isFile;
  try {
    isFile = statSync(root).isFile();
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
  if (isFile) {
    const parsed = parseFragment(root);
    return {
      version: 1,
      providers: parsed.providers || [],
      models: parsed.models || [],
    };
  }
  const providers = [];
  const models = [];
  const files = registryFragmentFiles(root);
  if (files.length === 0) fail("no registry fragments found");
  for (const file of files) {
    const parsed = parseFragment(file);
    providers.push(...(parsed.providers || []));
    models.push(...(parsed.models || []));
  }
  return { version: 1, providers, models };
}

function loadRegistry() {
  const parsed = readRegistryDocument();
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
    if (
      provider.authProfile !== undefined &&
      !["github-copilot"].includes(provider.authProfile)
    ) {
      fail(`provider ${provider.id} has an unsupported auth profile`);
    }
    if (
      provider.authProfile === "github-copilot" &&
      (
        provider.id !== "github-copilot" ||
        provider.kind !== "openai-compatible" ||
        provider.protocol !== "openai-responses"
      )
    ) {
      fail("the github-copilot auth profile requires the github-copilot Responses provider");
    }
    if (provider.kind === "oauth" && !provider.proxyBaseEnv) {
      fail(`OAuth provider ${provider.id} requires proxyBaseEnv`);
    }
    if (provider.kind === "openai-compatible") {
      // A per-model-endpoint provider is a container, not a destination: it
      // has no address, no credential, and nothing to authenticate, because
      // each of its models carries all three. Letting it also declare them
      // would create two answers to "where does this go" and a silent winner.
      if (provider.perModelEndpoint !== undefined) {
        if (provider.perModelEndpoint !== true) {
          fail(`provider ${provider.id} has an invalid perModelEndpoint flag`);
        }
        if (provider.authMode !== "per-model") {
          fail(`provider ${provider.id} must declare authMode per-model`);
        }
        for (const field of ["baseUrl", "baseUrlEnv", "credential", "keyless", "protocol"]) {
          if (provider[field] !== undefined) {
            fail(`per-model-endpoint provider ${provider.id} must not declare ${field}`);
          }
        }
      } else if (provider.authMode === "per-model") {
        fail(`provider ${provider.id} declares authMode per-model without perModelEndpoint`);
      } else if (!/^https?:\/\//.test(provider.baseUrl || "")) {
        fail(`provider ${provider.id} requires an HTTP(S) baseUrl`);
      }
      // A keyless provider serves from this machine (a local Ollama or
      // llama.cpp), so there is no secret to store and nothing to protect.
      // Everything else must declare where its credential lives, or the
      // resolver has no way to authenticate it.
      if (provider.keyless !== undefined && typeof provider.keyless !== "boolean") {
        fail(`provider ${provider.id} has an invalid keyless flag`);
      }
      for (const field of ["directResponses", "codexOnly", "explicitSelection"]) {
        if (provider[field] !== undefined && typeof provider[field] !== "boolean") {
          fail(`provider ${provider.id} has an invalid ${field} flag`);
        }
      }
      if (provider.keyless && provider.credential !== undefined) {
        fail(`keyless provider ${provider.id} must not declare a credential`);
      }
      // Only a loopback endpoint may skip authentication: a keyless provider
      // pointed at the internet would send unauthenticated traffic off-box.
      if (provider.keyless && !loopbackBaseUrl(provider.baseUrl)) {
        fail(`keyless provider ${provider.id} must use a loopback baseUrl`);
      }
      const credentialResolver = provider.credential?.resolver;
      if (
        provider.authMode !== undefined &&
        !["anonymous", "per-model"].includes(provider.authMode)
      ) {
        fail(`provider ${provider.id} has an unsupported authMode`);
      }
      if (provider.authMode === "anonymous") {
        const expected = ANONYMOUS_ENDPOINTS[provider.id];
        if (!expected || normalizedBaseUrl(provider.baseUrl) !== expected) {
          fail(`anonymous provider ${provider.id} must use its fixed official endpoint`);
        }
        if (provider.baseUrlEnv !== undefined) {
          fail(`anonymous provider ${provider.id} must not allow a baseUrl override`);
        }
        if (provider.keyless || provider.credential !== undefined) {
          fail(`anonymous provider ${provider.id} must not declare keyless or credential metadata`);
        }
        if (![
          "explicit-models",
          "opencode-console",
          "suffix-free",
        ].includes(provider.anonymousModelPolicy)) {
          fail(`anonymous provider ${provider.id} requires a supported anonymousModelPolicy`);
        }
        if (provider.anonymousModelPolicy === "explicit-models") {
          const models = provider.anonymousModels;
          if (
            !Array.isArray(models) ||
            models.length === 0 ||
            models.some((model) =>
              typeof model !== "string" || !model.trim() || model !== model.trim()
            ) ||
            new Set(models).size !== models.length
          ) {
            fail(`anonymous provider ${provider.id} requires a valid anonymousModels allowlist`);
          }
        } else if (provider.anonymousModels !== undefined) {
          fail(`anonymous provider ${provider.id} may declare anonymousModels only with explicit-models policy`);
        }
        if (typeof provider.anonymousNote !== "string" || !provider.anonymousNote.trim()) {
          fail(`anonymous provider ${provider.id} requires an anonymousNote`);
        }
      } else if (
        provider.anonymousModelPolicy !== undefined ||
        provider.anonymousModels !== undefined ||
        provider.anonymousNote !== undefined
      ) {
        fail(`provider ${provider.id} has anonymous metadata without authMode anonymous`);
      }
      if (
        credentialResolver !== undefined &&
        credentialResolver !== "google-application-default"
      ) {
        fail(`provider ${provider.id} has an unsupported credential resolver`);
      }
      if (credentialResolver === "google-application-default") {
        if (provider.protocol !== "vertex") {
          fail(`provider ${provider.id} may only use Google Application Default Credentials with the vertex protocol`);
        }
        if (
          Object.keys(provider.credential || {}).some((field) => field !== "resolver")
        ) {
          fail(`provider ${provider.id} Google credential metadata must only declare resolver`);
        }
      } else if (
        !provider.keyless &&
        !["anonymous", "per-model"].includes(provider.authMode) &&
        (!provider.credential?.file || !Array.isArray(provider.credential.environment))
      ) {
        fail(`provider ${provider.id} requires credential metadata`);
      }
      if (
        provider.credential?.label !== undefined &&
        (typeof provider.credential.label !== "string" || !provider.credential.label.trim())
      ) {
        fail(`provider ${provider.id} has an invalid credential label`);
      }
      if (provider.credential?.cliSession !== undefined) {
        fail(`provider ${provider.id} does not support CLI sessions; use an API key`);
      }
      // Some providers authenticate a credential their plan may still not
      // entitle to the API. The note says so everywhere a user connects, so
      // the first sign of it is not a 403 inside Codex.
      if (
        provider.planNote !== undefined &&
        (typeof provider.planNote !== "string" || !provider.planNote.trim())
      ) {
        fail(`provider ${provider.id} has an invalid planNote`);
      }
      if (
        provider.protocol !== undefined &&
        !["openai", "anthropic", "openai-responses", "vertex"].includes(provider.protocol)
      ) {
        fail(`provider ${provider.id} has an unsupported API protocol`);
      }
      if (provider.transport !== undefined && provider.transport !== "ollama") {
        fail(`provider ${provider.id} has an unsupported transport`);
      }
      if (provider.transport === "ollama" && !provider.keyless) {
        fail(`provider ${provider.id} Ollama transport must be keyless`);
      }
      // A direct Responses provider bypasses LiteLLM so a Codex-native request
      // envelope reaches a reviewed local bridge intact. Keep that exception
      // narrower than the ordinary keyless-provider contract: no remote host,
      // no protocol translation, and no publication to non-Codex clients.
      if (
        provider.directResponses &&
        (!provider.keyless || provider.protocol !== "openai-responses" || !provider.codexOnly)
      ) {
        fail(
          `direct Responses provider ${provider.id} must be keyless, openai-responses, and Codex-only`,
        );
      }
      if (provider.codexOnly && !provider.directResponses) {
        fail(`Codex-only provider ${provider.id} must use the direct Responses contract`);
      }
    }
    providers.set(provider.id, Object.freeze(provider));
  }

  // Protocol variants (e.g. opencode-go-messages) ride on another provider's
  // credential and selection state, so the link must point at a real canonical
  // provider whose stored key is actually the one the variant will send.
  for (const provider of providers.values()) {
    if (provider.variantOf === undefined) continue;
    const parent = providers.get(provider.variantOf);
    if (!parent) {
      fail(`provider ${provider.id} is a variant of unknown provider ${provider.variantOf}`);
    }
    if (parent.variantOf !== undefined) {
      fail(`provider ${provider.id} may not be a variant of variant ${parent.id}`);
    }
    if (provider.kind !== "openai-compatible" || parent.kind !== "openai-compatible") {
      fail(`variant provider ${provider.id} and its parent must be openai-compatible`);
    }
    if (provider.credential?.file !== parent.credential?.file) {
      fail(`variant provider ${provider.id} must share ${parent.id}'s credential file`);
    }
    if (provider.authProfile !== parent.authProfile) {
      fail(`variant provider ${provider.id} must share ${parent.id}'s auth profile`);
    }
  }

  const slugs = new Set();
  const gatewayModels = new Set();
  const models = parsed.models.map((model) => {
    const problem = modelProblem(model, providers, slugs, gatewayModels);
    if (problem) fail(problem);
    slugs.add(model.slug);
    gatewayModels.add(model.gatewayModel);
    return normalizedModel(model, providers.get(model.provider));
  });

  const modelBySlug = new Map(models.map((model) => [model.slug, model]));
  for (const model of models) {
    const problem = upgradeTargetProblem(model, modelBySlug);
    if (problem) fail(problem);
  }

  return {
    providers,
    models: Object.freeze(models),
  };
}

// Operator-defined providers extend only the runtime view. The checked-in
// registry stays immutable and authoritative for built-in provider identity,
// native capabilities, and repository-certified model behavior. A malformed
// generic document is one failed optional layer: keep every built-in route and
// expose a diagnostic instead of taking down the router at module import.
function loadRuntimeProviders(checkedInProviders) {
  const providers = new Map(checkedInProviders);
  const warnings = [];
  try {
    const genericProviders = readGenericProviders({
      reservedProviderIds: checkedInProviders,
    });
    for (const provider of genericProviders) {
      if (!provider.enabled) continue;
      const descriptor = genericProviderRuntimeDescriptor(provider);
      if (providers.has(descriptor.id)) {
        throw new Error(`generic provider ${descriptor.id} collides with the checked-in registry`);
      }
      providers.set(descriptor.id, descriptor);
    }
  } catch (error) {
    warnings.push(
      `Ignored generic provider state: ${error instanceof Error ? error.message : String(error)}`,
    );
    return {
      providers: new Map(checkedInProviders),
      warnings: Object.freeze(warnings),
    };
  }
  return { providers, warnings: Object.freeze(warnings) };
}

// Codex only renders the upgrade modal when the target slug is in the picker,
// so a prompt pointing at a missing or unlisted model can never fire. Catch
// that at load time instead of shipping a silent no-op. Targets may be
// declared later in the file, so this runs after the whole set is known.
function upgradeTargetProblem(model, modelBySlug) {
  if (model.upgradeTo === undefined) return undefined;
  const target = modelBySlug.get(model.upgradeTo.model);
  if (!target) {
    return `model ${model.slug} upgrades to unknown model ${model.upgradeTo.model}`;
  }
  if (!target.listed) {
    return `model ${model.slug} upgrades to unlisted model ${model.upgradeTo.model}`;
  }
  return undefined;
}

// A model's own endpoint answers the three questions a provider normally
// answers -- where the request goes, whether it carries a credential, and
// which one -- so it is validated to the same standard, in the same order, and
// with the same refusals. Everything an operator can add to `config/custom/`
// or to their user-model overlay lands here.
function endpointProblem(model, provider) {
  if (!provider.perModelEndpoint) {
    return model.endpoint === undefined
      ? undefined
      : `model ${model.slug} declares an endpoint but ${provider.id} is not a per-model-endpoint provider`;
  }
  const endpoint = model.endpoint;
  if (!endpoint || typeof endpoint !== "object" || Array.isArray(endpoint)) {
    return `model ${model.slug} requires an endpoint under per-model-endpoint provider ${provider.id}`;
  }
  if (endpoint.id !== undefined || endpoint.kind !== undefined) {
    // Both are derived from the model, and a fragment that set them could
    // point one model's credential file at another model's secret.
    return `model ${model.slug} endpoint must not declare id or kind`;
  }
  if (!/^https?:\/\//.test(endpoint.baseUrl || "")) {
    return `model ${model.slug} endpoint requires an HTTP(S) baseUrl`;
  }
  if (endpoint.authMode !== undefined && endpoint.authMode !== "anonymous") {
    return `model ${model.slug} endpoint has an unsupported authMode`;
  }
  if (endpoint.keyless !== undefined && typeof endpoint.keyless !== "boolean") {
    return `model ${model.slug} endpoint has an invalid keyless flag`;
  }
  // Exactly one auth story per endpoint. Two would leave a silent winner, and
  // none would send an unauthenticated request to an address nobody vetted.
  const declared = [
    endpoint.authMode === "anonymous",
    Boolean(endpoint.keyless),
    endpoint.credential !== undefined,
  ].filter(Boolean).length;
  if (declared !== 1) {
    return `model ${model.slug} endpoint must declare exactly one of anonymous, keyless, or credential`;
  }
  // The keyless rule is about the address, not the flag: an endpoint that
  // sends no credential may only talk to this machine.
  if (endpoint.keyless && !loopbackBaseUrl(endpoint.baseUrl)) {
    return `model ${model.slug} keyless endpoint must use a loopback baseUrl`;
  }
  // An anonymous endpoint reaches a third party with no credential at all, so
  // the address itself is the security boundary and it lives in code.
  if (endpoint.authMode === "anonymous") {
    const expected = ANONYMOUS_MODEL_ENDPOINTS[model.slug];
    if (!expected || normalizedBaseUrl(endpoint.baseUrl) !== expected) {
      return `model ${model.slug} anonymous endpoint must use its allowlisted address`;
    }
    if (typeof endpoint.note !== "string" || !endpoint.note.trim()) {
      return `model ${model.slug} anonymous endpoint requires a note`;
    }
  }
  if (
    endpoint.credential !== undefined &&
    (!endpoint.credential.file || !Array.isArray(endpoint.credential.environment))
  ) {
    return `model ${model.slug} endpoint requires credential metadata`;
  }
  if (endpoint.baseUrlEnv !== undefined && typeof endpoint.baseUrlEnv !== "string") {
    return `model ${model.slug} endpoint has an invalid baseUrlEnv`;
  }
  // An override on an endpoint that carries no key would walk straight around
  // the allowlist the anonymous case just enforced.
  if (endpoint.baseUrlEnv && (endpoint.authMode === "anonymous" || endpoint.keyless)) {
    return `model ${model.slug} endpoint must not allow a baseUrl override without a credential`;
  }
  return undefined;
}

// The endpoint the registry declares is data; the endpoint the router resolves
// has to be provider-shaped so the existing base-URL and credential chains
// accept it. Identity is derived here rather than read from the fragment.
//
// The official-name table fills in a name curation could not know -- it reads
// an opaque id off a provider's catalog and has nothing better to show. A
// checked-in fragment always knows, and more than one route can carry the same
// upstream id, so the table must not overwrite a name the repository chose:
// `openrouter/glm-5.3-flash` says which reseller route it is, and the
// table would flatten that back to the curated label.
function normalizedModel(model, provider, { curated = false } = {}) {
  const officialDisplayName = curated
    ? officialModelDisplayName(model.provider, model.upstreamModel)
    : undefined;
  // A documented free tier is applied for the same reason the name is: an entry
  // curated before the tag existed carries neither, and re-curating is not
  // something an installed machine should have to do to be told the price.
  const documentedFree = curated
    ? curatedModelIsFree(model.provider, model.upstreamModel)
    : undefined;
  const renamed = officialDisplayName && model.displayName !== officialDisplayName
    ? { ...model, displayName: officialDisplayName }
    : model;
  const priced = documentedFree === true && renamed.isFree !== true
    ? { ...renamed, isFree: true }
    : renamed;
  // Same rule again, and this one costs turns rather than clarity: without it
  // an entry curated before the upstream's limitation was documented keeps
  // sending cycles that come back as a 400 naming nothing.
  const documentedRecursion = curated
    ? curatedModelToolSchemaRecursion(model.provider, model.upstreamModel)
    : undefined;
  const withRecursion = documentedRecursion && !priced.toolSchemaRecursion
    ? { ...priced, toolSchemaRecursion: documentedRecursion }
    : priced;
  // Image input is another published free-id fact Zen's catalog omits. A
  // text-only stored default would keep Codex refusing paste forever; widen
  // only when the documented set includes image and the entry still lacks it,
  // so an already-correct text+image row stays byte-identical.
  const documentedModalities = curated
    ? curatedModelInputModalities(model.provider, model.upstreamModel)
    : undefined;
  const modalitiesMissingImage =
    Array.isArray(documentedModalities) &&
    documentedModalities.includes("image") &&
    !(
      Array.isArray(withRecursion.inputModalities) &&
      withRecursion.inputModalities.includes("image")
    );
  const presented = modalitiesMissingImage
    ? { ...withRecursion, inputModalities: [...documentedModalities] }
    : withRecursion;
  if (!provider?.perModelEndpoint) return Object.freeze(presented);
  return Object.freeze({
    ...presented,
    endpoint: Object.freeze({
      ...presented.endpoint,
      id: presented.slug,
      kind: "openai-compatible",
    }),
  });
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
  const provider = providers.get(model.provider);
  if (!provider) {
    return `model ${model.slug} references unknown provider ${model.provider}`;
  }
  if (!model.slug.startsWith(`${model.provider}/`)) {
    return `model ${model.slug} must be namespaced under ${model.provider}/`;
  }
  if (model.adapter !== undefined && typeof model.adapter !== "string") {
    return "model " + model.slug + " has an invalid adapter";
  }
  if (provider.protocol === "vertex") {
    if (!Object.hasOwn(VERTEX_ADAPTERS, model.adapter)) {
      return "model " + model.slug + " requires a supported Vertex adapter";
    }
    if (
      model.vertexPublisher !== undefined &&
      (
        typeof model.vertexPublisher !== "string" ||
        !/^[a-z][a-z0-9._-]{0,127}$/i.test(model.vertexPublisher)
      )
    ) {
      return "model " + model.slug + " has an invalid Vertex publisher";
    }
  } else if (model.adapter !== undefined) {
    return "model " + model.slug + " may only set an adapter for a Vertex provider";
  } else if (model.vertexPublisher !== undefined) {
    return "model " + model.slug + " may only set a Vertex publisher for a Vertex provider";
  }
  if (provider.authMode === "anonymous" && !anonymousModelAllowed(provider, model.upstreamModel)) {
    return `anonymous provider ${provider.id} only accepts its documented free-model ids`;
  }
  const endpoint = endpointProblem(model, provider);
  if (endpoint) return endpoint;
  if (
    model.behaviorTemplate !== undefined &&
    (typeof model.behaviorTemplate !== "string" || !model.behaviorTemplate.trim())
  ) {
    return `model ${model.slug} has an invalid behaviorTemplate`;
  }
  if (model.instructionOverlay !== undefined && !instructionOverlayExists(model.instructionOverlay)) {
    return `model ${model.slug} has an invalid instructionOverlay`;
  }
  if (model.requestProfile !== undefined && !requestProfileKnown(model.requestProfile)) {
    return `model ${model.slug} has an invalid requestProfile`;
  }
  if (model.supportedEndpoints !== undefined) {
    let supported;
    try {
      supported = normalizeSupportedEndpoints(model.supportedEndpoints, {
        field: `model ${model.slug}.supportedEndpoints`,
      });
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
    const conversational = providerModelEndpoint(provider);
    if (!conversational && supported.includes("/embeddings")) {
      return `model ${model.slug} cannot declare OpenAI endpoints for provider protocol ${provider.protocol}`;
    }
    if (model.listed && (!conversational || !supported.includes(conversational))) {
      return `listed model ${model.slug} must support its provider's conversational endpoint`;
    }
  }
  if (
    provider.generic === true &&
    model.requestProfile !== undefined &&
    !curatableRequestProfile(model.requestProfile)
  ) {
    return `generic model ${model.slug} may use only an explicitly curatable requestProfile`;
  }
  // The router exposes Chat Completions and Responses request surfaces. A
  // legacy text-completions catalog can still be inspected, but publishing a
  // model from it would create a route no caller endpoint can execute.
  if (provider.generic === true && provider.adapter === "openai-completions") {
    return `generic model ${model.slug} uses unsupported openai-completions publication`;
  }
  if (
    model.requiresTrailingUserTurn !== undefined &&
    typeof model.requiresTrailingUserTurn !== "boolean"
  ) {
    return `model ${model.slug} has an invalid requiresTrailingUserTurn flag`;
  }
  if (
    model.multiAgentVersion !== undefined &&
    !["v1", "v2"].includes(model.multiAgentVersion)
  ) {
    return `model ${model.slug} has an invalid multiAgentVersion`;
  }
  if (
    model.supportsReasoningSummaries !== undefined &&
    typeof model.supportsReasoningSummaries !== "boolean"
  ) {
    return `model ${model.slug} has an invalid supportsReasoningSummaries`;
  }
  if (
    model.supportsApplyPatchTool !== undefined &&
    typeof model.supportsApplyPatchTool !== "boolean"
  ) {
    return `model ${model.slug} has an invalid supportsApplyPatchTool`;
  }
  if (
    model.supportsParallelToolCalls !== undefined &&
    typeof model.supportsParallelToolCalls !== "boolean"
  ) {
    return `model ${model.slug} has an invalid supportsParallelToolCalls`;
  }
  if (
    model.supportsSearchHistory !== undefined &&
    typeof model.supportsSearchHistory !== "boolean"
  ) {
    return `model ${model.slug} has an invalid supportsSearchHistory`;
  }
  if (
    model.experimentalSupportedTools !== undefined &&
    (!Array.isArray(model.experimentalSupportedTools) ||
      model.experimentalSupportedTools.some(
        (tool) => typeof tool !== "string" || !tool.trim(),
      ))
  ) {
    return `model ${model.slug} has invalid experimentalSupportedTools`;
  }
  if (
    model.supportsImageDetailOriginal !== undefined &&
    typeof model.supportsImageDetailOriginal !== "boolean"
  ) {
    return `model ${model.slug} has an invalid supportsImageDetailOriginal`;
  }
  // The router's vision bridge covers every text-only model once the operator
  // enables it, so this field exists only to opt one out -- a model whose
  // upstream mangles long injected transcripts, for example. Setting it true
  // would read as a capability claim the model does not have, and the bridge
  // never needs it, so only false is accepted.
  if (model.visionBridge !== undefined && model.visionBridge !== false) {
    return `model ${model.slug} may only set visionBridge to false`;
  }
  // An upstream that refuses a tool schema whose `$ref`s cycle needs the cycle
  // broken before dispatch. This is a property of the upstream, not of the
  // model's abilities, and it is deliberately separate from `requestProfile`:
  // that field holds one value, and every route needing this so far also needs
  // a profile of its own. `flatten` is the only verb, because rejecting the
  // turn is what already happens without it.
  if (
    model.toolSchemaRecursion !== undefined &&
    model.toolSchemaRecursion !== "flatten"
  ) {
    return `model ${model.slug} may only set toolSchemaRecursion to "flatten"`;
  }
  if (model.isFree !== undefined && typeof model.isFree !== "boolean") {
    return `model ${model.slug} has an invalid isFree flag`;
  }
  // "hosted" means the provider's own backend executes web searches
  // server-side (xAI's Responses proxy today). "standalone" means Codex
  // executes the search client-side and returns the result in the routed
  // conversation; it is still opt-in per model because not every upstream
  // accepts the resulting web-search items. Keep the enum closed so an
  // unimplemented mode cannot make the catalog advertise an unsupported
  // search path.
  if (
    model.searchTool !== undefined &&
    (!model.searchTool ||
      typeof model.searchTool !== "object" ||
      Array.isArray(model.searchTool) ||
      !["hosted", "standalone"].includes(model.searchTool.mode))
  ) {
    return `model ${model.slug} has an invalid searchTool`;
  }
  if (model.serviceTiers !== undefined) {
    if (
      !Array.isArray(model.serviceTiers) ||
      model.serviceTiers.some(
        (tier) =>
          !tier ||
          typeof tier !== "object" ||
          Array.isArray(tier) ||
          typeof tier.id !== "string" ||
          !tier.id.trim() ||
          typeof tier.name !== "string" ||
          !tier.name.trim() ||
          (tier.description !== undefined && typeof tier.description !== "string"),
      )
    ) {
      return `model ${model.slug} has invalid serviceTiers`;
    }
    const ids = model.serviceTiers.map((tier) => tier.id.trim());
    if (new Set(ids).size !== ids.length) {
      return `model ${model.slug} has duplicate serviceTiers`;
    }
  }
  if (
    model.defaultReasoningSummary !== undefined &&
    !["auto", "concise", "detailed"].includes(model.defaultReasoningSummary)
  ) {
    return `model ${model.slug} has an invalid defaultReasoningSummary`;
  }
  // A default summary mode without summary support is a contradictory
  // capability claim. This matters especially for user-models.json, where
  // hand-edited metadata is skipped with a warning instead of trusted merely
  // because each field is valid in isolation.
  if (
    model.defaultReasoningSummary !== undefined &&
    model.supportsReasoningSummaries !== true
  ) {
    return `model ${model.slug} sets defaultReasoningSummary without reasoning-summary support`;
  }
  if (
    model.availabilityNux !== undefined &&
    (typeof model.availabilityNux !== "string" || !model.availabilityNux.trim())
  ) {
    return `model ${model.slug} has an invalid availabilityNux`;
  }
  // The markdown is the entire migration modal body, so an empty one would
  // render a blank prompt; a self-target would loop the prompt forever.
  if (model.upgradeTo !== undefined) {
    const upgrade = model.upgradeTo;
    if (
      !upgrade ||
      typeof upgrade !== "object" ||
      Array.isArray(upgrade) ||
      typeof upgrade.model !== "string" ||
      !upgrade.model ||
      upgrade.model === model.slug ||
      typeof upgrade.markdown !== "string" ||
      !upgrade.markdown.trim()
    ) {
      return `model ${model.slug} has an invalid upgradeTo`;
    }
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

const STATIC_MODEL_SLUG_ALIASES = new Map([
  // Z.ai revealed the OpenCode Go Ox Alpha preview as GLM-5.3-Flash. The
  // provider withdrew ox-alpha-free when it published the named model, so
  // preserve existing picker and caller state on the new live route.
  ["opencode-go/ox-alpha", "opencode-go/glm-5.3-flash"],
  ["opencode-go/ox-alpha-free", "opencode-go/glm-5.3-flash"],
  // OpenCode moved Grok 4.5 from Chat Completions to Responses. Keep the old
  // public slug routable while catalog publication carries picker state to
  // the protocol-namespaced replacement.
  ["opencode-go/grok-4.5", "opencode-go-responses/grok-4.5"],
]);

function validatedStaticModelSlugAliases({ models, providers }) {
  const modelBySlug = new Map(models.map((model) => [model.slug, model]));
  const aliases = new Map();
  for (const [from, to] of STATIC_MODEL_SLUG_ALIASES) {
    if (modelBySlug.has(from)) {
      fail(`static model slug alias ${from} collides with a checked-in model`);
    }
    const replacement = modelBySlug.get(to);
    if (!replacement) {
      // A registry override may intentionally omit this whole provider family;
      // in that case the repository-specific compatibility alias is irrelevant.
      // Once the target provider is present, though, a missing target is a typo
      // or incomplete protocol migration and must stop the load before picker
      // state or MODEL_BY_SLUG can be rewritten around it.
      const targetProvider = String(to).split("/", 1)[0];
      if (providers.has(targetProvider)) {
        fail(`static model slug alias ${from} points to unknown model ${to}`);
      }
      continue;
    }
    aliases.set(from, to);
  }
  return aliases;
}

// User-curated models extend the checked-in registry. A broken entry (or a
// collision after an upstream update ships the same model) must never take
// the whole router down, so problems skip the entry and surface as warnings.
function mergeUserModels(base, staticAliases) {
  const warnings = [];
  const models = [...base.models];
  const slugs = new Set(models.map((model) => model.slug));
  const gatewayModels = new Set(models.map((model) => model.gatewayModel));
  // Curation used to publish opaque provider ids before a checked-in entry
  // gave the same route a stable public slug. Treat provider + upstream id as
  // routing identity too, not only the public slug: otherwise both names reach
  // the exact same endpoint and the picker shows a duplicate model. Keep the
  // replacement so persisted visibility can follow the canonical slug.
  const checkedInRoutes = new Map(
    models.map((model) => [`${model.provider}\0${model.upstreamModel}`, model]),
  );
  const aliases = new Map();
  const userModels = new Set();
  for (const model of readUserModels()) {
    // A mutable local overlay may describe routing and presentation, but it
    // cannot grant itself the repository's native-collaboration certificate.
    // Local Ollama/LM Studio entries intentionally declare conservative v1 so
    // they are settled and never spend a cloud compatibility probe. Preserve
    // that denial, but refuse the positive certificate.
    if (model?.multiAgentVersion === "v2") {
      warnings.push(
        `Skipped user model: model ${model?.slug || "<unknown>"} may not declare multiAgentVersion v2`,
      );
      continue;
    }
    const checkedIn = checkedInRoutes.get(`${model?.provider}\0${model?.upstreamModel}`);
    if (checkedIn) {
      if (typeof model?.slug === "string" && model.slug && model.slug !== checkedIn.slug) {
        // An old curation slug is safe as an alias only while nothing else
        // owns that public name. Otherwise the alias loop below would replace
        // a real checked-in/user model (or a repository migration alias) in
        // MODEL_BY_SLUG, changing which upstream a trusted slug reaches.
        if (
          slugs.has(model.slug)
          || staticAliases.has(model.slug)
          || aliases.has(model.slug)
        ) {
          warnings.push(
            `Skipped user model: alias ${model.slug} for checked-in route ${checkedIn.slug} collides with an existing model or alias`,
          );
          continue;
        }
        aliases.set(model.slug, checkedIn.slug);
      }
      warnings.push(
        `Skipped user model: ${model?.slug || "<unknown>"} duplicates checked-in route ${checkedIn.slug}`,
      );
      continue;
    }
    if (
      typeof model?.slug === "string"
      && (staticAliases.has(model.slug) || aliases.has(model.slug))
    ) {
      warnings.push(`Skipped user model: model slug ${model.slug} collides with an existing model alias`);
      continue;
    }
    const problem = modelProblem(model, base.providers, slugs, gatewayModels);
    if (problem) {
      warnings.push(`Skipped user model: ${problem}`);
      continue;
    }
    slugs.add(model.slug);
    gatewayModels.add(model.gatewayModel);
    const frozen = normalizedModel(model, base.providers.get(model.provider), { curated: true });
    userModels.add(frozen);
    models.push(frozen);
  }
  // Upgrade targets may point at models merged later in the overlay, so they
  // resolve only after the whole set settles.
  const modelBySlug = new Map(models.map((model) => [model.slug, model]));
  const kept = models.filter((model) => {
    if (!userModels.has(model)) return true;
    const problem = upgradeTargetProblem(model, modelBySlug);
    if (problem) {
      warnings.push(`Skipped user model: ${problem}`);
      return false;
    }
    return true;
  });
  return {
    models: Object.freeze(kept),
    warnings: Object.freeze(warnings),
    aliases: new Map(aliases),
  };
}

const registry = loadRegistry();
const staticAliases = validatedStaticModelSlugAliases(registry);
const runtime = loadRuntimeProviders(registry.providers);
const merged = mergeUserModels(
  { ...registry, providers: runtime.providers },
  staticAliases,
);

export const PROVIDERS = registry.providers;
// Runtime routing and curation use this union. Keeping it separate from
// PROVIDERS prevents mutable local state from becoming checked-in authority in
// callers that intentionally audit or certify the repository registry.
export const RUNTIME_PROVIDERS = runtime.providers;
export const RUNTIME_PROVIDER_WARNINGS = runtime.warnings;
// The immutable registry shipped by this checkout, before the operator's
// mutable user-model overlay is merged. Repository certification gates must
// bind to this set: a local overlay is useful routing configuration, but it
// cannot certify itself for every installer.
export const CHECKED_IN_MODELS = registry.models;
export const MODELS = merged.models;
export const USER_MODEL_WARNINGS = merged.warnings;
// Old curated public slugs that now resolve to a checked-in route. Catalog
// publication migrates picker decisions through these aliases before applying
// defaults, so an update removes the duplicate without hiding the model.
export const MODEL_SLUG_ALIASES = new Map([
  ...staticAliases,
  ...merged.aliases,
]);
export const LISTED_MODELS = Object.freeze(MODELS.filter((model) => model.listed));
export const API_MODELS = Object.freeze(
  MODELS.filter((model) => RUNTIME_PROVIDERS.get(model.provider)?.kind === "openai-compatible"),
);
export const MODEL_BY_SLUG = new Map(MODELS.map((model) => [model.slug, model]));
for (const [from, to] of MODEL_SLUG_ALIASES) {
  const replacement = MODEL_BY_SLUG.get(to);
  if (replacement) MODEL_BY_SLUG.set(from, replacement);
}
export const MODEL_BY_GATEWAY_ID = new Map(
  MODELS.map((model) => [model.gatewayModel, model]),
);

export function providerForModel(model) {
  return RUNTIME_PROVIDERS.get(model.provider);
}
