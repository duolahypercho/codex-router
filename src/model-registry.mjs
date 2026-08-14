import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

import { SOURCE_ROOT } from "./paths.mjs";
import { readUserModels } from "./user-models.mjs";

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
  "kilo-free": "https://api.kilo.ai/api/gateway",
});

export function anonymousModelAllowed(provider, modelId) {
  const id = typeof modelId === "string" ? modelId.trim() : "";
  if (provider?.authMode !== "anonymous" || !id) return false;
  if (provider.anonymousModelPolicy === "opencode-console") {
    return id === "big-pickle" || id.endsWith("-free");
  }
  if (provider.anonymousModelPolicy === "suffix-free") return id.endsWith(":free");
  return false;
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
    else if (entry.isFile() && entry.name.endsWith(".json")) files.push(full);
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

// An optional `credential.cliSession` lets a provider reuse the API key its
// own CLI stores after a browser sign-in. The descriptor names one file inside
// one directory of the user's home, so a stray separator or `..` would let the
// registry point the reader at an arbitrary path; reject those at load time.
function cliSessionProblem(provider) {
  // A keyless provider has no credential block at all, so there is no CLI
  // session descriptor to validate.
  const session = provider.credential?.cliSession;
  if (session === undefined) return undefined;
  if (!session || typeof session !== "object" || Array.isArray(session)) {
    return `provider ${provider.id} has an invalid credential.cliSession`;
  }
  for (const field of ["directory", "file", "field", "label", "loginCommand"]) {
    if (typeof session[field] !== "string" || !session[field].trim()) {
      return `provider ${provider.id} cliSession requires ${field}`;
    }
  }
  for (const field of ["directory", "file"]) {
    if (session[field].includes("/") || session[field].includes("\\") || session[field] === "..") {
      return `provider ${provider.id} cliSession ${field} must be a single path segment`;
    }
  }
  if (session.homeEnv !== undefined && (typeof session.homeEnv !== "string" || !session.homeEnv)) {
    return `provider ${provider.id} cliSession has an invalid homeEnv`;
  }
  return undefined;
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
      if (!/^https?:\/\//.test(provider.baseUrl || "")) {
        fail(`provider ${provider.id} requires an HTTP(S) baseUrl`);
      }
      // A keyless provider serves from this machine (a local Ollama or
      // llama.cpp), so there is no secret to store and nothing to protect.
      // Everything else must declare where its credential lives, or the
      // resolver has no way to authenticate it.
      if (provider.keyless !== undefined && typeof provider.keyless !== "boolean") {
        fail(`provider ${provider.id} has an invalid keyless flag`);
      }
      if (provider.keyless && provider.credential !== undefined) {
        fail(`keyless provider ${provider.id} must not declare a credential`);
      }
      // Only a loopback endpoint may skip authentication: a keyless provider
      // pointed at the internet would send unauthenticated traffic off-box.
      if (provider.keyless && !loopbackBaseUrl(provider.baseUrl)) {
        fail(`keyless provider ${provider.id} must use a loopback baseUrl`);
      }
      if (
        provider.authMode !== undefined &&
        !["anonymous"].includes(provider.authMode)
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
        if (!["opencode-console", "suffix-free"].includes(provider.anonymousModelPolicy)) {
          fail(`anonymous provider ${provider.id} requires a supported anonymousModelPolicy`);
        }
        if (typeof provider.anonymousNote !== "string" || !provider.anonymousNote.trim()) {
          fail(`anonymous provider ${provider.id} requires an anonymousNote`);
        }
      } else if (provider.anonymousModelPolicy !== undefined || provider.anonymousNote !== undefined) {
        fail(`provider ${provider.id} has anonymous metadata without authMode anonymous`);
      }
      if (
        !provider.keyless &&
        provider.authMode !== "anonymous" &&
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
      const sessionProblem = cliSessionProblem(provider);
      if (sessionProblem) fail(sessionProblem);
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
        !["openai", "anthropic", "openai-responses"].includes(provider.protocol)
      ) {
        fail(`provider ${provider.id} has an unsupported API protocol`);
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
    // A variant that resolved a different CLI sign-in than its parent would
    // authenticate one protocol surface and not the other from the same
    // "connected" state, so the descriptors must match exactly.
    if (
      JSON.stringify(provider.credential?.cliSession ?? null) !==
      JSON.stringify(parent.credential?.cliSession ?? null)
    ) {
      fail(`variant provider ${provider.id} must share ${parent.id}'s credential CLI session`);
    }
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
  if (provider.authMode === "anonymous" && !anonymousModelAllowed(provider, model.upstreamModel)) {
    return `anonymous provider ${provider.id} only accepts its documented free-model ids`;
  }
  if (model.requestProfile !== undefined && typeof model.requestProfile !== "string") {
    return `model ${model.slug} has an invalid requestProfile`;
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

// User-curated models extend the checked-in registry. A broken entry (or a
// collision after an upstream update ships the same model) must never take
// the whole router down, so problems skip the entry and surface as warnings.
function mergeUserModels(base) {
  const warnings = [];
  const models = [...base.models];
  const slugs = new Set(models.map((model) => model.slug));
  const gatewayModels = new Set(models.map((model) => model.gatewayModel));
  const userModels = new Set();
  for (const model of readUserModels()) {
    const problem = modelProblem(model, base.providers, slugs, gatewayModels);
    if (problem) {
      warnings.push(`Skipped user model: ${problem}`);
      continue;
    }
    slugs.add(model.slug);
    gatewayModels.add(model.gatewayModel);
    const frozen = Object.freeze(model);
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
  return { models: Object.freeze(kept), warnings: Object.freeze(warnings) };
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
