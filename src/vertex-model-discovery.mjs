import { readFileSync } from "node:fs";
import path from "node:path";

import {
  providerCatalogIdentityFingerprint,
  readProviderCatalogCache,
  withProviderCatalogCacheTransaction,
} from "./model-catalog-cache.mjs";
import { mergeDiscoveredModels, normalizeModelMetadata } from "./model-capabilities.mjs";
import { MODELS } from "./model-registry.mjs";
import { providerCatalogRouteIds } from "./provider-catalogs.mjs";
import { credentialStatus, resolveProviderCredential } from "./provider-credentials.mjs";
import { resolveVertexConfiguration } from "./vertex-state.mjs";
import {
  fetchUntrustedModelCatalog,
  validateModelCatalogPayload,
} from "./untrusted-model-discovery.mjs";
import {
  parseVertexSupportCatalog,
  readVertexSupportCatalog,
  vertexAdapterFor,
  vertexAdapterIsImplemented,
} from "./vertex-support-catalog.mjs";

const DISCOVERY_TIMEOUT_MS = 30_000;
const MAX_PAGES_PER_PUBLISHER = 100;
const MAX_DISCOVERED_MODELS = 4_000;

function trimSlashes(value) {
  return String(value || "").replace(/^\/+|\/+$/g, "");
}

function safePublisher(value) {
  const normalized = typeof value === "string" ? value.trim() : "";
  return /^[a-z][a-z0-9._-]{0,127}$/i.test(normalized) ? normalized : undefined;
}

function modelGardenSettings(provider, catalog) {
  const garden = provider?.modelGarden;
  if (!garden || typeof garden !== "object" || Array.isArray(garden)) {
    throw new Error((provider?.displayName || "Vertex") + " does not configure Model Garden discovery.");
  }
  const publishers = [];
  const add = (value) => {
    const publisher = safePublisher(value);
    if (publisher && !publishers.includes(publisher)) publishers.push(publisher);
  };
  const configured = garden.publishers || garden.parents;
  if (Array.isArray(configured)) {
    for (const value of configured) {
      const parent = trimSlashes(value);
      add(parent.startsWith("publishers/") ? parent.slice("publishers/".length) : parent);
    }
  } else if (typeof configured === "string") {
    const parent = trimSlashes(configured);
    add(parent.startsWith("publishers/") ? parent.slice("publishers/".length) : parent);
  }
  if (garden.publisherEnv) add(process.env[garden.publisherEnv]);
  if (garden.parentEnv) {
    const parent = trimSlashes(process.env[garden.parentEnv]);
    add(parent.startsWith("publishers/") ? parent.slice("publishers/".length) : parent);
  }
  if (garden.publisher) add(garden.publisher);
  if (garden.parent) {
    const parent = trimSlashes(garden.parent);
    if (parent !== "publishers") {
      add(parent.startsWith("publishers/") ? parent.slice("publishers/".length) : parent);
    }
  }
  // The first foundation used parent: publishers as a placeholder. Resolve
  // that old value from reviewed catalog metadata rather than requesting the
  // invalid /publishers/models endpoint.
  if (publishers.length === 0 && trimSlashes(garden.parent) === "publishers") {
    for (const model of catalog?.models || []) add(model.publisher);
  }
  if (publishers.length === 0) {
    throw new Error("Vertex Model Garden discovery requires at least one publisher.");
  }
  return { garden, publishers };
}

function gardenBaseUrl(provider, garden) {
  const configuredBase = garden.baseUrlEnv ? process.env[garden.baseUrlEnv] : undefined;
  const base = String(configuredBase || garden.baseUrl || provider.baseUrl || "").replace(/\/+$/, "");
  let parsed;
  try {
    parsed = new URL(base);
  } catch {
    throw new Error("Vertex Model Garden discovery requires an HTTP(S) base URL.");
  }
  if (
    !["http:", "https:"].includes(parsed.protocol) ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash
  ) {
    throw new Error("Vertex Model Garden discovery requires a credential-free HTTP(S) base URL.");
  }
  return parsed.toString().replace(/\/$/, "");
}

function fixtureValue(options) {
  if (options.fixturePayload !== undefined) return options.fixturePayload;
  if (options.fixture !== undefined) {
    if (typeof options.fixture !== "string") return options.fixture;
    return JSON.parse(readFileSync(path.resolve(options.fixture), "utf8"));
  }
  if (options.fixturePath) {
    return JSON.parse(readFileSync(path.resolve(options.fixturePath), "utf8"));
  }
  return undefined;
}

function fixturePages(payload) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.pages)) return payload.pages;
  if (payload?.pages && typeof payload.pages === "object" && !Array.isArray(payload.pages)) {
    return Object.values(payload.pages);
  }
  return [payload];
}

function fixturePublishers(payload) {
  const publishers = new Set();
  for (const page of fixturePages(payload)) {
    for (const resource of page?.publisherModels || []) {
      const name = typeof resource?.name === "string" ? resource.name.trim() : "";
      const match = /^publishers\/([^/]+)\/models\/[^/]+$/.exec(name);
      if (match?.[1] && safePublisher(match[1])) publishers.add(match[1]);
    }
  }
  return publishers;
}

function filterFixturePage(page, publisher) {
  if (!page || typeof page !== "object" || Array.isArray(page) || !Array.isArray(page.publisherModels)) {
    return page;
  }
  return {
    ...page,
    publisherModels: page.publisherModels.filter((resource) => vertexPublisherModelId(resource, publisher)),
  };
}

function filterPublisherFixture(payload, publisher) {
  if (Array.isArray(payload)) return payload.map((page) => filterFixturePage(page, publisher));
  if (Array.isArray(payload?.pages)) {
    return {
      ...payload,
      pages: payload.pages.map((page) => filterFixturePage(page, publisher)),
    };
  }
  if (payload?.pages && typeof payload.pages === "object" && !Array.isArray(payload.pages)) {
    return {
      ...payload,
      pages: Object.fromEntries(
        Object.entries(payload.pages).map(([token, page]) => [token, filterFixturePage(page, publisher)]),
      ),
    };
  }
  return filterFixturePage(payload, publisher);
}

function publisherFixture(payload, publisher, publisherCount, firstPublisher) {
  if (payload?.publishers && typeof payload.publishers === "object" && !Array.isArray(payload.publishers)) {
    return payload.publishers[publisher];
  }
  // A flat fixture remains useful for one-publisher tests and is compatible
  // with the original dynamic-Vertex fixture shape.
  if (publisherCount === 1) return payload;
  const availablePublishers = fixturePublishers(payload);
  if (availablePublishers.size === 0) {
    // Preserve malformed-resource fixtures for the first configured publisher
    // so validation still reports the bad record instead of silently turning
    // it into an empty catalog for every publisher.
    return publisher === firstPublisher ? payload : { publisherModels: [] };
  }
  return availablePublishers.has(publisher)
    ? filterPublisherFixture(payload, publisher)
    : { publisherModels: [] };
}

function fixtureReader(payload, publisher, publisherCount, firstPublisher) {
  const selected = publisherFixture(payload, publisher, publisherCount, firstPublisher);
  if (selected === undefined) return undefined;
  if (Array.isArray(selected)) {
    let index = 0;
    return () => selected[index++];
  }
  if (Array.isArray(selected?.pages)) {
    let index = 0;
    return () => selected.pages[index++];
  }
  if (selected?.pages && typeof selected.pages === "object" && !Array.isArray(selected.pages)) {
    let token = "";
    return () => {
      const page = selected.pages[token];
      token = page?.nextPageToken || "";
      return page;
    };
  }
  let consumed = false;
  return () => {
    if (consumed) return undefined;
    consumed = true;
    return selected;
  };
}

function pagePayload(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("Vertex Model Garden returned an invalid page.");
  }
  validateModelCatalogPayload(payload, {
    collectionFields: ["publisherModels"],
    recordIdFields: ["name"],
  });
  if (payload.nextPageToken !== undefined && typeof payload.nextPageToken !== "string") {
    throw new Error("Vertex Model Garden returned an invalid nextPageToken.");
  }
  return payload;
}

export function vertexPublisherModelId(resource, publisher) {
  const expectedPublisher = safePublisher(publisher);
  const name = typeof resource?.name === "string" ? resource.name.trim() : "";
  if (!expectedPublisher || !name) return undefined;
  const prefix = `publishers/${expectedPublisher}/models/`;
  if (!name.startsWith(prefix)) return undefined;
  const id = name.slice(prefix.length);
  return id && !/[\u0000-\u001f\u007f?#\\]/.test(id) ? id : undefined;
}

export function vertexModelGardenUrl(provider, publisherOrOptions, pageTokenArgument) {
  const legacyPlaceholder = trimSlashes(provider?.modelGarden?.parent) === "publishers";
  const catalog = legacyPlaceholder ? readVertexSupportCatalog() : { models: [] };
  const { garden, publishers } = modelGardenSettings(provider, catalog);
  let publisher = publishers[0];
  let pageToken = pageTokenArgument;
  if (typeof publisherOrOptions === "string") {
    if (publishers.includes(publisherOrOptions)) publisher = publisherOrOptions;
    else pageToken = publisherOrOptions;
  } else if (publisherOrOptions && typeof publisherOrOptions === "object") {
    publisher = publisherOrOptions.publisher || publisher;
    pageToken = publisherOrOptions.pageToken;
  }
  publisher = safePublisher(publisher);
  if (!publisher || !publishers.includes(publisher)) {
    throw new Error("Vertex Model Garden discovery requires a configured publisher.");
  }
  const base = gardenBaseUrl(provider, garden);
  const version = trimSlashes(garden.apiVersion || "v1beta1");
  if (!/^[a-z0-9][a-z0-9._-]*$/i.test(version)) {
    throw new Error("Vertex Model Garden discovery has an invalid API version.");
  }
  const versionedBase = base.endsWith("/" + version) ? base : base + "/" + version;
  const url = new URL(
    versionedBase + "/publishers/" + encodeURIComponent(publisher) + "/models",
  );
  if (garden.listAllVersions === true) url.searchParams.set("listAllVersions", "true");
  if (pageToken !== undefined && pageToken !== null && String(pageToken)) {
    url.searchParams.set("pageToken", String(pageToken));
  }
  return url.href;
}

function discoveryIdentity(provider, credential, settings) {
  const { garden, publishers } = settings;
  const configuration = {
    ...resolveVertexConfiguration({ persistent: false }),
    ...(credential?.projectId ? { projectId: credential.projectId } : {}),
    ...(credential?.location ? { location: credential.location } : {}),
  };
  return {
    kind: "vertex",
    baseUrl: gardenBaseUrl(provider, garden),
    credential,
    projectId: configuration.projectId,
    location: configuration.location,
    apiVersion: trimSlashes(garden.apiVersion || "v1beta1"),
    publishers: [...publishers].sort(byId),
    listAllVersions: garden.listAllVersions === true,
  };
}

function identityFingerprint(identity) {
  return providerCatalogIdentityFingerprint([
    identity.kind,
    identity.baseUrl,
    identity.projectId,
    identity.location,
    identity.apiVersion,
    identity.publishers,
    identity.listAllVersions,
    identity.credential?.value,
  ]);
}

function credentialChangedError(provider) {
  const error = new Error(
    provider.displayName +
      " credentials changed while its model catalog was loading. Reload the catalog for the current account.",
  );
  error.code = "provider_catalog_credential_changed";
  return error;
}

function resolvedCredential(provider, options, fixture) {
  if (fixture !== undefined) return undefined;
  const credential = options.credential || resolveProviderCredential(provider);
  if (!credential?.value) throw new Error(credentialStatus(provider).setup);
  return credential;
}

async function fetchPages(provider, settings, options, credential, fixture) {
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const resources = [];
  for (const publisher of settings.publishers) {
    const readFixturePage = fixture === undefined
      ? undefined
      : fixtureReader(fixture, publisher, settings.publishers.length, settings.publishers[0]);
    if (fixture !== undefined && !readFixturePage) {
      throw new Error("Vertex Model Garden fixture has no pages for publisher " + publisher + ".");
    }
    let pageToken;
    const seenTokens = new Set();
    for (let pageNumber = 0; ; pageNumber += 1) {
      if (pageNumber >= MAX_PAGES_PER_PUBLISHER) {
        throw new Error("Vertex Model Garden discovery exceeded the pagination limit.");
      }
      let page;
      if (readFixturePage) {
        page = readFixturePage();
        if (page === undefined) {
          throw new Error("Vertex Model Garden fixture ended before pagination completed.");
        }
      } else {
        const endpoint = vertexModelGardenUrl(provider, { publisher, pageToken });
        page = await fetchUntrustedModelCatalog(endpoint, {
          headers: { Authorization: "Bearer " + credential.value },
          fetchImpl,
          timeoutMs: options.timeoutMs || DISCOVERY_TIMEOUT_MS,
          allowPrivate: Boolean(options.allowPrivate),
          allowQuery: true,
          collectionFields: ["publisherModels"],
          recordIdFields: ["name"],
          ...(options.resolveHost ? { resolveHost: options.resolveHost } : {}),
          ...(options.proxyResolvesDestination !== undefined
            ? { proxyResolvesDestination: options.proxyResolvesDestination }
            : {}),
        });
      }
      const parsed = pagePayload(page);
      resources.push(...parsed.publisherModels.map((resource) => ({ resource, publisher })));
      if (resources.length > MAX_DISCOVERED_MODELS) {
        throw new Error("Vertex Model Garden returned too many models.");
      }
      const next = parsed.nextPageToken || "";
      if (!next) break;
      if (seenTokens.has(next)) {
        throw new Error("Vertex Model Garden returned a repeated page token.");
      }
      seenTokens.add(next);
      pageToken = next;
    }
  }
  return resources;
}

function byId(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function catalogMetadata(model) {
  return normalizeModelMetadata({
    upstreamId: model.id,
    displayName: model.displayName,
    contextWindow: model.capabilities.contextWindow,
    inputModalities: model.capabilities.inputModalities,
    supportsReasoning: true,
    supportsVision: model.capabilities.inputModalities.includes("image"),
  });
}

function classify(resources, catalog) {
  const ids = new Map();
  const malformed = [];
  for (const { resource, publisher } of resources) {
    const id = vertexPublisherModelId(resource, publisher);
    if (id) {
      if (!ids.has(id)) ids.set(id, publisher);
    } else {
      const name = typeof resource?.name === "string" ? resource.name.trim() : "";
      malformed.push({
        id: name || "<unnamed publisher model>",
        reason: "invalid publisher model resource name",
      });
    }
  }

  const byCatalogId = new Map(catalog.models.map((model) => [model.id, model]));
  const supportedModels = [];
  const unsupported = [...malformed];
  for (const [id, publisher] of [...ids.entries()].sort(([left], [right]) => byId(left, right))) {
    const model = byCatalogId.get(id);
    if (!model) {
      unsupported.push({ id, reason: "not in the Vertex support catalog" });
      continue;
    }
    if (model.publisher && model.publisher !== publisher) {
      unsupported.push({
        id,
        reason: "Vertex support catalog expects publisher " + model.publisher + ", not " + publisher,
      });
      continue;
    }
    if (!vertexAdapterIsImplemented(model.adapter)) {
      unsupported.push({
        id,
        adapter: model.adapter,
        reason: "Vertex adapter " + model.adapter + " is not implemented",
      });
      continue;
    }
    const adapter = vertexAdapterFor(model);
    supportedModels.push(Object.freeze({
      ...model,
      requestProfile: adapter.requestProfile,
    }));
  }
  unsupported.sort((left, right) => byId(left.id, right.id));
  return {
    discovered: [...ids.keys()].sort(byId),
    supported: supportedModels.map((model) => model.id),
    supportedModels: Object.freeze(supportedModels),
    unsupported: Object.freeze(unsupported),
  };
}

function classifyCached(discovered, catalog) {
  const byCatalogId = new Map(catalog.models.map((model) => [model.id, model]));
  const supportedModels = [];
  const unsupported = [];
  for (const id of discovered) {
    const model = byCatalogId.get(id);
    if (!model) {
      unsupported.push({ id, reason: "not in the Vertex support catalog" });
      continue;
    }
    if (!vertexAdapterIsImplemented(model.adapter)) {
      unsupported.push({
        id,
        adapter: model.adapter,
        reason: "Vertex adapter " + model.adapter + " is not implemented",
      });
      continue;
    }
    supportedModels.push(Object.freeze({
      ...model,
      requestProfile: vertexAdapterFor(model).requestProfile,
    }));
  }
  return {
    discovered: [...new Set(discovered)].sort(byId),
    supported: supportedModels.map((model) => model.id),
    supportedModels: Object.freeze(supportedModels),
    unsupported: Object.freeze(unsupported.sort((left, right) => byId(left.id, right.id))),
  };
}

function metadataMap(catalog, ids) {
  const selected = new Set(ids);
  return Object.fromEntries(
    catalog.models
      .filter((model) => selected.has(model.id))
      .map((model) => [model.id, catalogMetadata(model)]),
  );
}

export async function discoverVertexProviderModels(provider, options = {}) {
  const rawCatalog = options.catalog ?? readVertexSupportCatalog();
  const catalog = parseVertexSupportCatalog(rawCatalog);
  const settings = modelGardenSettings(provider, catalog);
  const fixture = fixtureValue(options);
  const credential = resolvedCredential(provider, options, fixture);
  const identity = credential
    ? discoveryIdentity(provider, credential, settings)
    : undefined;
  const fingerprint = identity ? identityFingerprint(identity) : undefined;
  const storeAnswer = options.cache !== false && fixture === undefined;
  let cached;
  if (storeAnswer && !options.refresh) {
    const held = readProviderCatalogCache(provider.id, { scope: options.scope });
    if (held?.identityFingerprint === fingerprint) cached = held;
  }

  let classified;
  let fetchedAt;
  let modelMetadata;
  let contextLengths;
  if (cached) {
    classified = classifyCached(cached.discovered, catalog);
    fetchedAt = cached.fetchedAt;
    modelMetadata = cached.modelMetadata || metadataMap(catalog, classified.supported);
    contextLengths = cached.contextLengths || Object.fromEntries(
      classified.supportedModels.map((model) => [model.id, model.capabilities.contextWindow]),
    );
  } else {
    const resources = await fetchPages(provider, settings, options, credential, fixture);
    classified = classify(resources, catalog);
    fetchedAt = new Date().toISOString();
    modelMetadata = metadataMap(catalog, classified.supported);
    contextLengths = Object.fromEntries(
      classified.supportedModels.map((model) => [model.id, model.capabilities.contextWindow]),
    );
    if (storeAnswer) {
      await withProviderCatalogCacheTransaction(async (cacheApi) => {
        const currentCredential = options.credential || resolveProviderCredential(provider);
        const currentIdentity = discoveryIdentity(provider, currentCredential, settings);
        if (identityFingerprint(currentIdentity) !== fingerprint) {
          throw credentialChangedError(provider);
        }
        cacheApi.write(provider.id, {
          discovered: classified.discovered,
          contextLengths,
          modelMetadata,
          fetchedAt,
          scope: options.scope,
          identityFingerprint: fingerprint,
          provenance: {
            schema: "codex-router/provider-catalog/v1",
            providerId: provider.id,
            endpoint:
              identity.baseUrl +
              "/" +
              trimSlashes(settings.garden.apiVersion || "v1beta1") +
              "/publishers",
            identityFingerprint: fingerprint,
            ...(options.scope ? { scope: options.scope } : {}),
          },
        });
      });
    }
  }

  const routeIds = new Set(providerCatalogRouteIds(provider.id));
  const registered = MODELS
    .filter((model) => routeIds.has(model.provider))
    .map((model) => model.upstreamModel)
    .sort();
  const registeredSet = new Set(registered);
  const unregistered = classified.supported.filter((id) => !registeredSet.has(id));
  const blocked = Object.fromEntries(classified.unsupported.map(({ id, reason }) => [id, reason]));
  const discoveredSet = new Set(classified.discovered);
  return {
    provider: provider.id,
    ...classified,
    registered,
    unregistered,
    addable: unregistered,
    blocked,
    unavailable: registered.filter((id) => !discoveredSet.has(id)),
    contextLengths,
    modelMetadata: mergeDiscoveredModels({
      providerId: provider.id,
      live: Object.values(modelMetadata),
    }),
    cached: Boolean(cached),
    stale: Boolean(cached?.stale),
    fetchedAt,
    note:
      "Vertex discovery reads Model Garden publisher models only. " +
      "Only models in the local support catalog with implemented adapters are selectable; " +
      "unsupported discoveries are reported but are not selectable or curated.",
  };
}
