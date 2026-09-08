import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  readProviderCatalogCache,
  providerCatalogIdentityFingerprint,
  withProviderCatalogCacheTransaction,
  writeProviderCatalogCache,
} from "./model-catalog-cache.mjs";
import { modelCatalogMetadata } from "./model-catalog-metadata.mjs";
import {
  mergeDiscoveredModels,
  modelMetadataFromPreset,
  modelMetadataFromProviderRecord,
} from "./model-capabilities.mjs";
import { genericProviderDiscoverySnapshot } from "./generic-providers.mjs";
import {
  anonymousModelAllowed,
  CHECKED_IN_MODELS,
  MODELS,
  RUNTIME_PROVIDERS,
  resolveProviderBaseUrl,
} from "./model-registry.mjs";
import { curatedModelBlockReason } from "./opencode-curation.mjs";
import {
  OPENCODE_SESSION_FALLBACKS,
  applyOpenCodeSessionHeaders,
  isOpenCodeProvider,
} from "./opencode-session.mjs";
import { providerCatalogRouteIds } from "./provider-catalogs.mjs";
import { readUserModels } from "./user-models.mjs";
import { credentialStatus, resolveProviderCredential } from "./provider-credentials.mjs";
import { VERSION } from "./version.mjs";
import {
  fetchUntrustedModelCatalog,
  validateModelCatalogPayload,
} from "./untrusted-model-discovery.mjs";
import {
  ensureFreshGitHubCopilotSession,
  githubCopilotCatalogHeaders,
} from "./github-copilot-session.mjs";

function option(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

export function modelIds(payload, provider) {
  const data = Array.isArray(payload) ? payload : payload?.data ?? payload?.models;
  if (!Array.isArray(data)) throw new Error("The provider returned an invalid model list.");
  const candidates = provider?.id === "chatgpt-web"
    ? data.filter((item) => modelRecordId(item).startsWith("chatgpt-web/"))
    : provider?.authMode === "anonymous"
    ? data.filter((item) => anonymousModelAllowed(provider, item?.id))
    : provider?.id === "orca"
    ? data.filter((item) => {
        // OrcaRouter's catalog also contains image, video, audio, and
        // provider-native-only entries. This provider reaches its upstream
        // through the OpenAI chat-completions surface, so offering anything
        // that does not advertise that surface creates a picker entry the
        // forwarder cannot call. The documented `-free` deployments are chat
        // replicas, but some currently omit endpoint metadata, so their
        // provider-owned naming contract is the narrow exception.
        const id = String(item?.id || "").trim();
        const endpointTypes = item?.supported_endpoint_types;
        // `orcarouter/free` is a moving meta-router, not a model identity. Keep
        // it out of local curation so the picker names the concrete free model
        // that will actually serve the turn.
        if (id === "orcarouter/free") return false;
        if (Array.isArray(endpointTypes)) return endpointTypes.includes("openai");
        return id.endsWith("-free");
      })
    : provider?.authProfile === "github-copilot"
    ? data.filter((item) =>
        typeof item?.id === "string" &&
        !item.id.startsWith("accounts/") &&
        (item.object === undefined || item.object === "model") &&
        (item.capabilities?.type === undefined || item.capabilities.type === "chat") &&
        item?.policy?.state === "enabled" &&
        item?.capabilities?.supports?.tool_calls === true &&
        item?.capabilities?.supports?.streaming !== false &&
        Array.isArray(item?.supported_endpoints) &&
        item.supported_endpoints.includes("/responses")
      )
    : data;
  return [...new Set(candidates.map(modelRecordId).filter(Boolean))].sort();
}

// OpenAI's documented `/models` response uses `id`, but compatible local
// servers commonly return `model` (and a few return the canonical name as
// `upstreamId`). Keep discovery provider-agnostic without changing the
// filtering policy for built-in providers.
function modelRecordId(item) {
  return String(item?.id ?? item?.model ?? item?.upstreamId ?? item?.slug ?? "").trim();
}

function modelRecords(payload, provider) {
  const data = Array.isArray(payload) ? payload : payload?.data ?? payload?.models;
  if (!Array.isArray(data)) throw new Error("The provider returned an invalid model list.");
  const ids = new Set(modelIds(payload, provider));
  return data.filter((item) => ids.has(modelRecordId(item)));
}

function metadataFromRecords(payload, provider) {
  const metadata = {};
  for (const record of modelRecords(payload, provider)) {
    try {
      const entry = modelMetadataFromProviderRecord(record);
      metadata[entry.upstreamId] = entry;
    } catch {
      // Model ids remain useful even when an optional provider capability
      // record is malformed. Discovery must not discard the whole catalog.
    }
  }
  return metadata;
}

function providerPresetMetadata(providerId) {
  return CHECKED_IN_MODELS
    .filter((model) => model.provider === providerId)
    .flatMap((model) => {
      try {
        return [modelMetadataFromPreset(model)];
      } catch {
        return [];
      }
    });
}

function providerUserMetadata(providerId) {
  return readUserModels()
    .filter((model) => model.provider === providerId)
    .flatMap((model) => {
      try {
        return [modelMetadataFromPreset(model)];
      } catch {
        // A malformed user-owned override must not block discovery for the
        // provider or affect native GPT entries in the merged catalog.
        return [];
      }
    });
}

function mergedProviderModels(providerId, liveMetadata, defaults) {
  return mergeDiscoveredModels({
    providerId,
    live: Object.values(liveMetadata || {}),
    verifiedPresets: providerPresetMetadata(providerId),
    userOverrides: providerUserMetadata(providerId),
    defaults,
  });
}

function zeroPrice(value) {
  if (value === undefined || value === null || value === "") return false;
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric === 0;
}

// Free catalog entries are useful only when they are also callable through
// this provider's supported OpenAI surface. Only concrete model identities are
// returned; the moving `orcarouter/free` meta-router is deliberately excluded.
// Concrete free deployments advertise either a `-free` suffix, a zero request
// price, or zero input and output token prices.
export function freeModelIds(payload, provider) {
  if (provider?.id !== "orca") return [];
  const data = Array.isArray(payload) ? payload : payload?.data ?? payload?.models;
  if (!Array.isArray(data)) throw new Error("The provider returned an invalid model list.");
  const callable = new Set(modelIds(payload, provider));
  return data
    .filter((item) => {
      const id = String(item?.id || "").trim();
      if (!callable.has(id)) return false;
      if (id.endsWith("-free")) return true;
      if (zeroPrice(item?.pricing?.request)) return true;
      return zeroPrice(item?.pricing?.prompt) && zeroPrice(item?.pricing?.completion);
    })
    .map((item) => String(item.id).trim())
    .filter((id, index, ids) => ids.indexOf(id) === index)
    .sort();
}

// What a provider says one model's context window is, or undefined when it says
// nothing usable. OpenAI-compatible catalogs disagree about the key: OpenRouter
// and most resellers publish `context_length` and repeat the figure the chosen
// endpoint actually serves under `top_provider`, Copilot puts it in
// `capabilities.limits`, and a few spell it `context_window`.
//
// When more than one is present they are not alternatives, they are limits at
// different scopes, and the smallest one is the only one the request path can
// rely on: a model that can do 200K reached through an endpoint that serves
// 131K is a 131K model here. Anything that is not a positive integer is treated
// as silence -- a string, a float, or a zero is a catalog quirk, not a size.
function advertisedContextLength(item) {
  let smallest;
  for (const value of [
    item?.context_length,
    item?.top_provider?.context_length,
    item?.context_window,
    item?.capabilities?.limits?.max_context_window_tokens,
  ]) {
    if (!Number.isInteger(value) || value < 1) continue;
    if (smallest === undefined || value < smallest) smallest = value;
  }
  return smallest;
}

// Model id -> advertised context window, for the models `modelIds` kept. A
// model the provider filtered out has no answer worth carrying, and a model
// the provider sized in silence is absent rather than guessed: curation falls
// back to its conservative default only when nothing was advertised.
export function modelContextLengths(payload, provider) {
  const data = Array.isArray(payload) ? payload : payload?.data ?? payload?.models;
  if (!Array.isArray(data)) return {};
  const kept = new Set(modelIds(payload, provider));
  const lengths = {};
  for (const item of data) {
    const id = modelRecordId(item);
    if (!id || !kept.has(id) || id in lengths) continue;
    const length = advertisedContextLength(item);
    if (length !== undefined) lengths[id] = length;
  }
  return lengths;
}

async function providerDiscoveryIdentity(provider) {
  if (provider.id === "devin-cli") {
    const { readDevinSession } = await import("./devin-cli-session.mjs");
    return { kind: "devin", session: readDevinSession() };
  }
  const credential = resolveProviderCredential(provider);
  if (!credential) throw new Error(credentialStatus(provider).setup);
  return {
    kind: "api",
    credential,
    baseUrl: resolveProviderBaseUrl(provider).baseUrl,
  };
}

function sameProviderDiscoveryIdentity(left, right) {
  return providerDiscoveryIdentityFingerprint(left)
    === providerDiscoveryIdentityFingerprint(right);
}

function discoveryEndpoint(identity) {
  const baseUrl = identity?.baseUrl || identity?.session?.apiServerUrl;
  return typeof baseUrl === "string" && baseUrl.trim() ? `${baseUrl.replace(/\/+$/, "")}/models` : undefined;
}

export function providerDiscoveryIdentityFingerprint(identity) {
  if (!identity || typeof identity !== "object") {
    return providerCatalogIdentityFingerprint(["missing"]);
  }
  if (identity.kind === "devin") {
    return providerCatalogIdentityFingerprint([
      "devin",
      identity.session?.apiKey,
      identity.session?.apiServerUrl,
      identity.session?.devinApiUrl,
    ]);
  }
  return providerCatalogIdentityFingerprint([
    "api",
    identity.baseUrl,
    identity.credential?.value,
  ]);
}

function credentialChangedError(provider) {
  const error = new Error(
    `${provider.displayName} credentials changed while its model catalog was loading. Reload the catalog for the current account.`,
  );
  error.code = "provider_catalog_credential_changed";
  return error;
}

async function providerPayload(provider, identity) {
  const fixture = option("--fixture");
  if (fixture) {
    const payload = JSON.parse(readFileSync(path.resolve(fixture), "utf8"));
    validateModelCatalogPayload(payload);
    return payload;
  }
  if (provider.id === "devin-cli") {
    const { listCascadeModels } = await import("./devin-cli-forwarder.mjs");
    const models = await listCascadeModels({
      session: identity?.session,
      signal: AbortSignal.timeout(30_000),
    });
    return {
      object: "list",
      data: models.map((model) => ({
        id: model.id,
        object: "model",
        owned_by: "devin",
      })),
    };
  }
  const credential = identity?.credential || resolveProviderCredential(provider);
  if (!credential) throw new Error(credentialStatus(provider).setup);
  // The same loopback guard the api-forwarder applies: a keyless provider's
  // placeholder credential passes the check above, so an unguarded override
  // would send `Bearer local` to whatever host the environment names.
  let baseUrl = identity?.baseUrl || resolveProviderBaseUrl(provider).baseUrl;
  let headers = provider.authMode === "anonymous"
    ? {}
    : provider.protocol === "anthropic"
    ? { "x-api-key": credential.value, "anthropic-version": "2023-06-01" }
    : { Authorization: `Bearer ${credential.value}` };
  if (provider.authProfile === "github-copilot") {
    const session = await ensureFreshGitHubCopilotSession(credential.value);
    if (!process.env[provider.baseUrlEnv]) baseUrl = session.baseUrl;
    headers = {
      ...githubCopilotCatalogHeaders(session.token),
    };
  }
  if (isOpenCodeProvider(provider)) {
    headers["User-Agent"] = `codex-router/${VERSION}`;
    applyOpenCodeSessionHeaders(headers, {
      provider,
      fallback: OPENCODE_SESSION_FALLBACKS.discovery,
    });
  }
  return fetchUntrustedModelCatalog(`${baseUrl}/models`, {
    headers,
    allowPrivate: Boolean(provider.keyless),
  });
}

/**
 * List what a provider serves and compare it with the local registry.
 *
 * The provider's own list is cached, so opening a provider does not require a
 * live round trip (or even a reachable network) once it has been seen. Passing
 * `refresh` re-asks the provider; `cache: false` keeps a run out of the cache
 * entirely, which is what fixture-driven runs and tests want.
 */
export async function discoverProviderModels(
  providerId,
  { refresh = false, cache = true, fixture = false, scope, loadPayload = providerPayload } = {},
) {
  const provider = RUNTIME_PROVIDERS.get(providerId);
  if (!provider) throw new Error(`Unknown provider: ${providerId}`);
  if (provider.generic === true) {
    const fixturePath = option("--fixture");
    const genericFixture = fixturePath
      ? JSON.parse(readFileSync(path.resolve(fixturePath), "utf8"))
      : fixture && fixture !== true
        ? fixture
        : undefined;
    return discoverGenericProviderModels(providerId, {
      refresh,
      cache,
      scope,
      ...(genericFixture !== undefined ? { fixture: genericFixture } : {}),
    });
  }
  // Discovery asks one endpoint what it serves. A per-model-endpoint provider
  // is not an endpoint, so there is no single host to ask and no answer that
  // would mean anything for the models under it. Refusing beats picking one of
  // its models' addresses and reporting that as the provider's catalog.
  if (provider.perModelEndpoint) {
    throw new Error(
      `${provider.displayName} has no endpoint of its own; each of its models names one. ` +
        "Discovery runs against a single endpoint, so there is nothing to list here.",
    );
  }
  if (provider.kind !== "openai-compatible" && provider.id !== "devin-cli") {
    throw new Error(`${provider.displayName} does not expose a supported model-list endpoint.`);
  }
  // A fixture is a file the caller handed in, not what the provider serves.
  // It must never be answered from the stored list and must never become it,
  // whichever entrypoint asked -- discovery's own CLI or curation's.
  const usingFixture = fixture || option("--fixture") !== undefined;
  const storeAnswer = cache && !usingFixture;
  let cached;
  let identity;
  if (storeAnswer) {
    // The initial read and credential snapshot linearize against credential
    // write+family invalidation. Network IO happens after this short critical
    // section, so other providers can still load in parallel.
    ({ cached, identity } = await withProviderCatalogCacheTransaction(async (catalog) => {
      const currentIdentity = await providerDiscoveryIdentity(provider);
      const currentFingerprint = providerDiscoveryIdentityFingerprint(currentIdentity);
      const held = refresh ? undefined : catalog.read(providerId, { scope });
      if (held?.identityFingerprint === currentFingerprint) {
        return { cached: held, identity: currentIdentity };
      }
      if (held) catalog.forget([providerId], { scope });
      return { cached: undefined, identity: currentIdentity };
    }));
  }
  let discovered;
  let free;
  let contextLengths;
  let metadata;
  let modelMetadata;
  let fetchedAt;
  if (cached) {
    discovered = cached.discovered;
    free = cached.free || [];
    contextLengths = cached.contextLengths || {};
    metadata = cached.metadata || {};
    modelMetadata = cached.modelMetadata || {};
    fetchedAt = cached.fetchedAt;
  } else {
    identity ||= usingFixture ? undefined : await providerDiscoveryIdentity(provider);
    const payload = await loadPayload(provider, identity);
    validateModelCatalogPayload(payload);
    discovered = modelIds(payload, provider);
    free = freeModelIds(payload, provider);
    contextLengths = modelContextLengths(payload, provider);
    const discoveredIds = new Set(discovered);
    metadata = Object.fromEntries(
      Object.entries(modelCatalogMetadata(payload, provider))
        .filter(([id]) => discoveredIds.has(id)),
    );
    modelMetadata = metadataFromRecords(payload, provider);
    fetchedAt = new Date().toISOString();
    if (storeAnswer) {
      await withProviderCatalogCacheTransaction(async (catalog) => {
        const currentIdentity = await providerDiscoveryIdentity(provider);
        if (!sameProviderDiscoveryIdentity(identity, currentIdentity)) {
          throw credentialChangedError(provider);
        }
        catalog.write(providerId, {
          discovered,
          free,
          contextLengths,
          metadata,
          modelMetadata,
          fetchedAt,
          scope,
          identityFingerprint: providerDiscoveryIdentityFingerprint(identity),
          provenance: {
            schema: "codex-router/provider-catalog/v1",
            providerId,
            endpoint: discoveryEndpoint(identity),
            identityFingerprint: providerDiscoveryIdentityFingerprint(identity),
            ...(scope ? { scope } : {}),
          },
        });
      });
    }
  }
  // A catalog endpoint can back several protocol routes. Compare against all
  // routes on that exact endpoint so Command Code Messages and OpenCode Go
  // Messages/Responses models do not reappear as unregistered duplicates.
  // Zen shares the Go credential but has a different endpoint and therefore
  // remains a separate empty catalog until the operator curates it.
  const curationProviders = new Set(providerCatalogRouteIds(providerId));
  const registered = MODELS
    .filter((model) => curationProviders.has(model.provider))
    .map((model) => model.upstreamModel)
    .sort();
  const discoveredSet = new Set(discovered);
  const registeredSet = new Set(registered);
  const unregistered = discovered.filter((id) => !registeredSet.has(id));
  const blocked = Object.fromEntries(unregistered.flatMap((id) => {
    const reason = curatedModelBlockReason(providerId, id);
    return reason ? [[id, reason]] : [];
  }));
  const addable = unregistered.filter((id) => !Object.hasOwn(blocked, id));
  return {
    provider: providerId,
    discovered,
    registered,
    // `unregistered` describes the provider-vs-registry comparison. `addable`
    // is the narrower set a control surface may actually submit; `blocked`
    // carries a stable, user-facing reason for every withheld candidate.
    unregistered,
    addable,
    blocked,
    unavailable: registered.filter((id) => !discoveredSet.has(id)),
    // Sizing the provider published for itself. Curation stores it rather than
    // guessing a window for a model whose catalog entry already names one.
    contextLengths,
    // Normalized provider-declared capabilities and documented supplements.
    // Missing fields stay missing: discovery is an evidence record, not a
    // reason to invent curation defaults or enable a route automatically.
    ...(Object.keys(metadata || {}).length ? { metadata } : {}),
    modelMetadata: mergedProviderModels(providerId, modelMetadata),
    // Whether this list came from the provider just now or from the last time
    // it was asked. The surfaces that show it say which, so a stale list is
    // never mistaken for a live one.
    cached: Boolean(cached),
    // A stored list past its trust window is still the only answer available
    // offline, so it is served rather than withheld -- but it is labelled so
    // the caller can re-read it in the background instead of showing a list
    // that silently predates the provider's newer models.
    stale: Boolean(cached?.stale),
    fetchedAt,
    ...(provider.id === "orca" ? { free } : {}),
    note: "Discovery never edits the registry. New models must pass the live compatibility test before they are listed in Codex.",
  };
}

export async function discoverGenericProviderModels(
  providerId,
  {
    fetchImpl = globalThis.fetch,
    timeoutMs = 30_000,
    resolveHost,
    proxyResolvesDestination,
    fixture,
    refresh = false,
    cache = true,
    scope,
  } = {},
) {
  const snapshot = genericProviderDiscoverySnapshot(providerId);
  const { descriptor, identityFingerprint } = snapshot;
  // Fixtures are test/operator input and must never become a persistent
  // catalog answer. Live generic catalogs use the same bounded, provider- and
  // account-scoped cache as built-in discovery, so opening a dashboard does
  // not repeatedly hit a local or remote endpoint.
  const usingFixture = fixture !== undefined;
  const storeAnswer = cache && !usingFixture;
  const held = refresh || !storeAnswer ? undefined : readProviderCatalogCache(providerId, { scope });
  const cached = held?.identityFingerprint === identityFingerprint ? held : undefined;
  let discovered;
  let modelMetadata;
  let fetchedAt;
  if (cached) {
    discovered = cached.discovered;
    modelMetadata = cached.modelMetadata || {};
    fetchedAt = cached.fetchedAt;
  } else {
    const payload = usingFixture
      ? (typeof fixture === "string" ? JSON.parse(fixture) : fixture)
      : await snapshot.fetchCatalog({
          fetchImpl,
          timeoutMs,
          resolveHost,
          proxyResolvesDestination,
        });
    validateModelCatalogPayload(payload);
    discovered = modelIds(payload, descriptor);
    modelMetadata = metadataFromRecords(payload, descriptor);
    fetchedAt = new Date().toISOString();
    if (storeAnswer) {
      if (genericProviderDiscoverySnapshot(providerId).identityFingerprint !== identityFingerprint) {
        throw new Error(`Generic provider ${providerId} credentials changed while its model catalog was loading.`);
      }
      await writeProviderCatalogCache(providerId, {
        discovered,
        modelMetadata,
        fetchedAt,
        scope,
        identityFingerprint,
        provenance: {
          schema: "codex-router/provider-catalog/v1",
          providerId,
          endpoint: `${descriptor.baseUrl}/models`,
          identityFingerprint,
          ...(scope ? { scope } : {}),
        },
      });
    }
  }
  const merged = mergeDiscoveredModels({
    providerId,
    live: Object.values(modelMetadata),
    userOverrides: providerUserMetadata(providerId),
    defaults: {},
  });
  const registered = MODELS
    .filter((model) => model.provider === providerId)
    .map((model) => model.upstreamModel)
    .sort();
  const registeredSet = new Set(registered);
  const discoveredSet = new Set(discovered);
  const unregistered = discovered.filter((id) => !registeredSet.has(id));
  const publicationBlocked = descriptor.adapter === "openai-completions"
    ? "This endpoint exposes legacy OpenAI Completions. Codex Router can inspect its catalog, but has no completions caller surface and will not publish an unusable route."
    : undefined;
  const blocked = publicationBlocked
    ? Object.fromEntries(unregistered.map((id) => [id, publicationBlocked]))
    : {};
  const contextLengths = Object.fromEntries(
    Object.entries(modelMetadata)
      .filter(([, metadata]) => Number.isInteger(metadata?.contextWindow))
      .map(([id, metadata]) => [id, metadata.contextWindow]),
  );
  return {
    provider: providerId,
    descriptor: { ...descriptor, headers: undefined },
    discovered,
    registered,
    unregistered,
    addable: unregistered.filter((id) => !Object.hasOwn(blocked, id)),
    blocked,
    unavailable: registered.filter((id) => !discoveredSet.has(id)),
    contextLengths,
    modelMetadata: merged,
    cached: Boolean(cached),
    stale: Boolean(cached?.stale),
    fetchedAt,
    note: publicationBlocked ||
      "Discovery never grants request behavior or edits the registry; curation must explicitly select every published model and any request profile.",
  };
}

async function main() {
  if (process.argv.includes("--help")) {
    process.stdout.write(`Usage: discover-models PROVIDER [--fixture FILE] [--refresh] [--json]

Queries a provider's official /models endpoint and compares it with
the checked-in config/ registry tree. Credential values are never printed or written.
`);
    return;
  }
  const providerId = process.argv.slice(2).find((value) => !value.startsWith("--") && value !== option("--fixture"));
  if (!providerId) throw new Error("Pass a provider id, such as anthropic-api, deepseek, grok-api, or kimi-api.");
  const result = await discoverProviderModels(providerId, {
    refresh: process.argv.includes("--refresh"),
  });
  if (process.argv.includes("--json")) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    process.stdout.write(
      `${result.provider}: ${result.discovered.length} models ${
        result.cached ? `from the list cached at ${result.fetchedAt} (--refresh re-asks the provider)` : "discovered"
      }\n`,
    );
    process.stdout.write(`Registered: ${result.registered.join(", ") || "none"}\n`);
    process.stdout.write(`New addable candidates: ${result.addable.join(", ") || "none"}\n`);
    for (const [id, reason] of Object.entries(result.blocked)) {
      process.stdout.write(`Blocked candidate ${id}: ${reason}\n`);
    }
    process.stdout.write(`Unavailable registered ids: ${result.unavailable.join(", ") || "none"}\n`);
    process.stdout.write(`${result.note}\n`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
