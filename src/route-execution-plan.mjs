import { createHash } from "node:crypto";

// This module consumes an already loaded registry and an explicit selection.
// It must not import registry, credential, discovery, or process-lifecycle
// modules: native requests have no dependency on any external provider.
const OAUTH_SERVICES = new Map([
  ["kimi-oauth", "kimi"],
  ["grok-oauth", "grok"],
  ["antigravity-oauth", "antigravity"],
  ["devin-cli", "devin"],
]);

// Include routing, canonical preparation, and client capability metadata.
// Explicit fields prevent arbitrary descriptor additions from hashing secrets.
const MODEL_FIELDS = [
  "slug", "gatewayModel", "upstreamModel", "provider", "adapter", "vertexPublisher",
  "listed", "displayName", "description", "priority", "compHash", "contextWindow",
  "autoCompact", "inputModalities", "defaultEffort", "supportedEndpoints",
  "requestProfile", "behaviorTemplate", "instructionOverlay", "reasoningTagPolicy",
  "requiresTrailingUserTurn", "goalContinuationGuard", "repetitionGuard",
  "toolSchemaRecursion", "multiAgentVersion", "supportsReasoningSummaries",
  "defaultReasoningSummary", "supportsApplyPatchTool", "supportsParallelToolCalls",
  "supportsSearchHistory", "supportsImageDetailOriginal", "experimentalSupportedTools",
  "visionBridge", "failoverCandidate", "isFree", "availabilityNux",
];
const PROVIDER_FIELDS = [
  "id", "kind", "ownedBy", "protocol", "transport", "adapter", "generic", "enabled",
  "perModelEndpoint", "variantOf", "authMode", "authProfile", "keyless", "allowPrivate",
  "baseUrlEnv", "proxyBaseEnv", "apiVersion", "anonymousModelPolicy", "anonymousModels",
  "credentialRef",
];
const ENDPOINT_FIELDS = ["protocol", "authMode", "keyless", "baseUrlEnv"];
const CREDENTIAL_REFERENCE_FIELDS = [
  "resolver", "file", "environment", "legacyFiles", "keychainServices",
];

function fields(value, names) {
  const result = {};
  for (const name of names) {
    if (value?.[name] !== undefined) result[name] = value[name];
  }
  return result;
}

function effectiveProvider(model, providerForModel) {
  if (typeof providerForModel !== "function") {
    throw new TypeError("Routed execution requires an effective providerForModel resolver.");
  }
  const provider = providerForModel(model);
  if (!provider || typeof provider !== "object") {
    throw new TypeError("Cannot plan a routed model without its registered provider.");
  }
  return provider;
}

function executionForProvider(provider) {
  if (provider.kind === "oauth") {
    const service = OAUTH_SERVICES.get(provider.id);
    if (!service) throw new TypeError("Cannot plan an OAuth provider without a known listener.");
    return { transport: "litellm", services: [service, "gateway"].sort() };
  }
  if (provider.kind !== "openai-compatible") {
    throw new TypeError("Cannot plan an unsupported provider kind.");
  }
  // Ollama uses the gateway's ollama_chat adapter to enforce num_ctx. An
  // ordinary keyless local endpoint (such as LM Studio) still uses api.
  if (provider.keyless && provider.transport === "ollama") {
    return { transport: "litellm", services: ["gateway", "ollama"] };
  }
  // The injected registry helper owns per-model endpoint precedence and the
  // verified DeepSeek Flash override. Generic Responses WebSocket providers
  // use this same forwarder boundary, including its connection affinity.
  if (provider.protocol === "openai-responses") {
    return { transport: "direct-responses", services: ["api"] };
  }
  return { transport: "litellm", services: ["api", "gateway"] };
}

/** Undefined/null is an unregistered native GPT route, as in Router lookup. */
export function routeExecution(model, { providerForModel } = {}) {
  if (model == null) return { transport: "native", services: [] };
  return executionForProvider(effectiveProvider(model, providerForModel));
}

function publicBaseUrl(value) {
  if (value === undefined) return undefined;
  let url;
  try { url = new URL(value); } catch {
    throw new TypeError("Cannot fingerprint an invalid provider endpoint.");
  }
  // Managed bases must be credential-free. Even an unvalidated descriptor
  // must not place URL credentials, query secrets, or fragments in the hash.
  url.username = "";
  url.password = "";
  url.search = "";
  url.hash = "";
  return url.href.replace(/\/+$/, "");
}

function endpointSemantic(endpoint) {
  return {
    ...fields(endpoint, ENDPOINT_FIELDS),
    baseUrl: publicBaseUrl(endpoint?.baseUrl),
    // These are public references to a credential boundary, never its value.
    credentialReference: fields(endpoint?.credential, CREDENTIAL_REFERENCE_FIELDS),
  };
}

function routeSemantic(model, provider, execution) {
  if (model == null) return { transport: "native" };
  return {
    model: {
      ...fields(model, MODEL_FIELDS),
      reasoningLevels: model.reasoningLevels?.map((level) => fields(level, ["effort", "description"])),
      serviceTiers: model.serviceTiers?.map((tier) => fields(tier, ["id", "name", "description"])),
      searchTool: fields(model.searchTool, ["mode"]),
      upgradeTo: fields(model.upgradeTo, ["model", "markdown"]),
    },
    provider: {
      ...fields(provider, PROVIDER_FIELDS),
      // Generic runtime descriptors redact values, but callers need not be
      // redacted for this API to remain safe. Hash header names only.
      headerNames: Object.keys(provider.headers || {}).sort(),
    },
    endpoint: endpointSemantic(provider.perModelEndpoint ? model.endpoint : provider),
    transport: execution.transport,
  };
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).filter((name) => value[name] !== undefined).sort()
      .map((name) => `${JSON.stringify(name)}:${canonicalJson(value[name])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/**
 * routeEnabled must represent selection, including variants and generic
 * descriptor enablement; it must not gate on listing or credential readiness.
 * Construct this once from the adopted registry, before publishing its routes.
 * The fingerprint describes these inputs, not live environment/secret bytes or
 * independently stored state such as Vertex project/location or overlay files.
 * A proof-only listener participates in readiness, but does not change routes
 * and therefore does not change their adoption identity after proof promotion.
 */
export function createExecutionPlan({
  models = [],
  providerForModel,
  routeEnabled = () => true,
  pendingAntigravity = false,
} = {}) {
  if (!Array.isArray(models)) throw new TypeError("Execution plan models must be an array.");
  if (typeof routeEnabled !== "function") throw new TypeError("Execution plan routeEnabled must be a function.");
  if (typeof pendingAntigravity !== "boolean") throw new TypeError("pendingAntigravity must be a boolean.");
  const services = new Set();
  const routes = [];
  const slugs = new Set();
  for (const model of models) {
    if (!routeEnabled(model)) continue;
    if (model != null) {
      if (typeof model.slug !== "string" || !model.slug) {
        throw new TypeError("Execution plan requires a registered model slug.");
      }
      if (slugs.has(model.slug)) throw new TypeError("Execution plan contains duplicate model slugs.");
      slugs.add(model.slug);
    }
    const provider = model == null ? undefined : effectiveProvider(model, providerForModel);
    const execution = model == null
      ? { transport: "native", services: [] }
      : executionForProvider(provider);
    for (const service of execution.services) services.add(service);
    routes.push(canonicalJson(routeSemantic(model, provider, execution)));
  }
  const routeServices = [...services].sort();
  // A pending proof needs its listener to become provable; it does not yet
  // publish a model or create a gateway request dependency. Its promotion must
  // not invalidate the unchanged requestable route generation.
  if (pendingAntigravity) services.add("antigravity");
  const orderedServices = [...services].sort();
  const fingerprint = createHash("sha256").update(canonicalJson({
    version: 1, services: routeServices, routes: routes.sort(),
  })).digest("hex");
  return Object.freeze({
    needsGateway: services.has("gateway"),
    services: Object.freeze(orderedServices),
    fingerprint,
  });
}
