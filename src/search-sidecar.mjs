// Explicit, provider-agnostic web search. This module is intentionally not
// wired into the router until a caller supplies an authorization gate and a
// provider adapter.

export const SEARCH_SIDECAR_DEFAULTS = Object.freeze({
  timeoutMs: 10_000,
  maxResults: 8,
  cacheTtlMs: 60_000,
  cacheMaxEntries: 128,
  maxAttempts: 2,
  retryDelayMs: 100,
});

const MAX_QUERY_LENGTH = 2_000;
const MAX_RESULT_LENGTH = 2_000;
const MAX_URL_LENGTH = 4_096;
const RETRYABLE_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);
const SEARCH_MODES = new Set(["auto", "native", "sidecar"]);
const CONFIG_KEYS = new Set([
  "enabled",
  "providerId",
  "credentialRef",
  "destination",
  "timeoutMs",
  "maxResults",
  "cacheTtlMs",
  "cacheMaxEntries",
  "maxAttempts",
  "retryDelayMs",
]);
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;

function positiveInteger(value, name, { max } = {}) {
  if (!Number.isInteger(value) || value < 1 || (max !== undefined && value > max)) {
    throw new Error(`${name} must be a positive integer${max ? ` no greater than ${max}` : ""}.`);
  }
  return value;
}

function nonNegativeInteger(value, name, { max } = {}) {
  if (!Number.isInteger(value) || value < 0 || (max !== undefined && value > max)) {
    throw new Error(`${name} must be a non-negative integer${max ? ` no greater than ${max}` : ""}.`);
  }
  return value;
}

function cleanString(value, name, max) {
  if (typeof value !== "string" || !value.trim() || value.length > max || CONTROL_CHARACTERS.test(value)) {
    throw new Error(`${name} must be a non-empty string of at most ${max} characters.`);
  }
  return value.trim();
}

function opaqueRef(value, name, max) {
  const result = cleanString(value, name, max);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(result)) {
    throw new Error(`${name} must be an opaque reference without whitespace or special characters.`);
  }
  return result;
}

function unsafeHostname(hostname) {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (normalized === "localhost" || normalized.endsWith(".localhost") || normalized.includes(":")) return true;
  const ipv4 = normalized.split(".").map((part) => Number(part));
  if (ipv4.length !== 4 || !ipv4.every((part) => Number.isInteger(part) && part >= 0 && part <= 255)) return false;
  return ipv4[0] === 0 || ipv4[0] === 10 || ipv4[0] === 127 || (ipv4[0] === 169 && ipv4[1] === 254)
    || (ipv4[0] === 172 && ipv4[1] >= 16 && ipv4[1] <= 31) || (ipv4[0] === 192 && ipv4[1] === 168);
}

function normalizeDestination(value) {
  const raw = cleanString(value, "destination", MAX_URL_LENGTH);
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error("destination must be an absolute HTTPS URL.");
  }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.hash) {
    throw new Error("destination must be an HTTPS URL without credentials or a fragment.");
  }
  if (unsafeHostname(parsed.hostname)) throw new Error("destination must not target localhost or a private address.");
  return parsed.toString();
}

function sanitizeText(value, name, max) {
  if (typeof value !== "string" || !value.trim() || value.length > max) {
    throw new Error(`${name} must be a non-empty string of at most ${max} characters.`);
  }
  const text = value.replace(/[\u0000-\u001f\u007f]/g, " ");
  const sanitized = text.replace(/<\s*(script|style)[^>]*>[\s\S]*?<\/\s*\1\s*>/gi, " ").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
  if (!sanitized) throw new Error(`${name} must contain visible text.`);
  return sanitized;
}

/**
 * Normalize only non-secret sidecar metadata. `credentialRef` is an opaque
 * reference resolved by the provider adapter; secret values are rejected.
 */
export function normalizeSearchSidecarConfig(value = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Search sidecar config must be an object.");
  }
  for (const key of Object.keys(value)) {
    if (!CONFIG_KEYS.has(key)) throw new Error(`Search sidecar config does not accept ${key}.`);
  }
  const enabled = value.enabled === true;
  if (value.enabled !== undefined && typeof value.enabled !== "boolean") {
    throw new Error("Search sidecar enabled must be a boolean.");
  }
  const result = {
    enabled,
    ...(value.providerId !== undefined ? { providerId: opaqueRef(value.providerId, "providerId", 128) } : {}),
    ...(value.credentialRef !== undefined ? { credentialRef: opaqueRef(value.credentialRef, "credentialRef", 256) } : {}),
    ...(value.destination !== undefined ? { destination: normalizeDestination(value.destination) } : {}),
    timeoutMs: value.timeoutMs === undefined ? SEARCH_SIDECAR_DEFAULTS.timeoutMs : positiveInteger(value.timeoutMs, "timeoutMs", { max: 120_000 }),
    maxResults: value.maxResults === undefined ? SEARCH_SIDECAR_DEFAULTS.maxResults : positiveInteger(value.maxResults, "maxResults", { max: 50 }),
    cacheTtlMs: value.cacheTtlMs === undefined ? SEARCH_SIDECAR_DEFAULTS.cacheTtlMs : nonNegativeInteger(value.cacheTtlMs, "cacheTtlMs", { max: 86_400_000 }),
    cacheMaxEntries: value.cacheMaxEntries === undefined ? SEARCH_SIDECAR_DEFAULTS.cacheMaxEntries : positiveInteger(value.cacheMaxEntries, "cacheMaxEntries", { max: 2_000 }),
    maxAttempts: value.maxAttempts === undefined ? SEARCH_SIDECAR_DEFAULTS.maxAttempts : positiveInteger(value.maxAttempts, "maxAttempts", { max: 3 }),
    retryDelayMs: value.retryDelayMs === undefined ? SEARCH_SIDECAR_DEFAULTS.retryDelayMs : nonNegativeInteger(value.retryDelayMs, "retryDelayMs", { max: 10_000 }),
  };
  if (result.enabled && !result.providerId) throw new Error("An enabled search sidecar needs providerId.");
  if (result.enabled && !result.credentialRef) throw new Error("An enabled search sidecar needs credentialRef.");
  if (result.enabled && !result.destination) throw new Error("An enabled search sidecar needs destination.");
  return Object.freeze(result);
}

/** Resolve only an explicitly requested sidecar; auto mode never falls back. */
export function resolveSearchTransport({ modelCapabilities = {}, sidecar, mode = "auto", invocationAuthorized = false } = {}) {
  if (!SEARCH_MODES.has(mode)) throw new Error(`Unknown search mode ${mode}.`);
  const native = modelCapabilities?.supportsSearch === true;
  const configured = sidecar?.enabled === true;
  if (mode === "native") return native ? "native" : "disabled";
  if (mode === "sidecar") return configured && invocationAuthorized === true ? "sidecar" : "disabled";
  if (native) return "native";
  return "disabled";
}

export function normalizeSearchRequest(request, maxResults = SEARCH_SIDECAR_DEFAULTS.maxResults) {
  const value = typeof request === "string" ? { query: request } : request;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Search request must be an object or query string.");
  }
  const query = cleanString(value.query, "query", MAX_QUERY_LENGTH);
  const requested = value.maxResults === undefined ? maxResults : value.maxResults;
  return Object.freeze({
    query,
    maxResults: positiveInteger(requested, "maxResults", { max: 50 }),
  });
}

function normalizeResult(value, index) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Search result ${index + 1} is not an object.`);
  }
  const url = cleanString(value.url, `results[${index}].url`, MAX_URL_LENGTH);
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`results[${index}].url must be an absolute URL.`);
  }
  if (!/^https?:$/.test(parsed.protocol) || parsed.username || parsed.password || parsed.hash) {
    throw new Error(`results[${index}].url must be an HTTP(S) URL without credentials or a fragment.`);
  }
  if (unsafeHostname(parsed.hostname)) throw new Error(`results[${index}].url must not target localhost or a private address.`);
  return {
    title: sanitizeText(value.title || parsed.hostname, `results[${index}].title`, MAX_RESULT_LENGTH),
    url: parsed.toString(),
    ...(value.snippet === undefined ? {} : { snippet: sanitizeText(value.snippet, `results[${index}].snippet`, MAX_RESULT_LENGTH) }),
    ...(value.publishedAt === undefined ? {} : { publishedAt: sanitizeText(value.publishedAt, `results[${index}].publishedAt`, 128) }),
  };
}

export function normalizeSearchResponse(payload, request) {
  const raw = Array.isArray(payload) ? payload : payload?.results;
  if (!Array.isArray(raw)) throw new Error("Search sidecar returned no results array.");
  const normalizedRequest = normalizeSearchRequest(request);
  const results = raw.slice(0, normalizedRequest.maxResults).map(normalizeResult);
  return {
    query: normalizedRequest.query,
    results,
    citations: results.map((result, index) => ({ index: index + 1, title: result.title, url: result.url })),
  };
}

function statusOf(error) {
  const value = error?.status ?? error?.statusCode ?? error?.response?.status;
  const status = Number(value);
  return Number.isInteger(status) ? status : undefined;
}

function retryable(error) {
  if (error?.retryable === false) return false;
  const status = statusOf(error);
  return error?.retryable === true || (status !== undefined && RETRYABLE_STATUSES.has(status));
}

export class SearchSidecarError extends Error {
  constructor(message, { code = "search_sidecar_failed", status, telemetry, cause } = {}) {
    super(message, { cause });
    this.name = "SearchSidecarError";
    this.code = code;
    if (status !== undefined) this.status = status;
    this.telemetry = telemetry;
  }
}

function abortError(code) {
  return new SearchSidecarError(
    code === "search_sidecar_timeout" ? "Search sidecar timed out." : "Search sidecar was cancelled.",
    { code },
  );
}

async function invokeBounded(fn, input, { signal, timeoutMs }) {
  if (signal?.aborted) throw abortError("search_sidecar_cancelled");
  const controller = new AbortController();
  let timeoutHandle;
  let onParentAbort;
  let rejectAbort;
  const abortPromise = new Promise((_, reject) => { rejectAbort = reject; });
  const abort = (error) => {
    if (!controller.signal.aborted) controller.abort(error);
    rejectAbort(error);
  };
  onParentAbort = () => abort(abortError("search_sidecar_cancelled"));
  signal?.addEventListener("abort", onParentAbort, { once: true });
  timeoutHandle = setTimeout(() => abort(abortError("search_sidecar_timeout")), timeoutMs);
  try {
    const result = Promise.resolve().then(() => fn({ ...input, signal: controller.signal }));
    return await Promise.race([result, abortPromise]);
  } finally {
    clearTimeout(timeoutHandle);
    signal?.removeEventListener("abort", onParentAbort);
  }
}

/** Small TTL + insertion-order cache. It stores normalized public results only. */
export function createSearchCache({ maxEntries = SEARCH_SIDECAR_DEFAULTS.cacheMaxEntries, ttlMs = SEARCH_SIDECAR_DEFAULTS.cacheTtlMs, now = () => Date.now() } = {}) {
  positiveInteger(maxEntries, "maxEntries", { max: 2_000 });
  nonNegativeInteger(ttlMs, "ttlMs", { max: 86_400_000 });
  const entries = new Map();
  return {
    get(key) {
      const entry = entries.get(key);
      if (!entry || now() - entry.at >= ttlMs) {
        if (entry) entries.delete(key);
        return undefined;
      }
      entries.delete(key);
      entries.set(key, entry);
      return structuredClone(entry.value);
    },
    set(key, value) {
      entries.delete(key);
      entries.set(key, { at: now(), value: structuredClone(value) });
      while (entries.size > maxEntries) entries.delete(entries.keys().next().value);
    },
    clear() { entries.clear(); },
    get size() { return entries.size; },
  };
}

/** Execute one authorized sidecar search. The adapter owns credential lookup. */
export async function searchWithSidecar({ config, request, accountId, model, authorize, searchImpl, signal, cache, now = () => Date.now(), sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) } = {}) {
  const sidecar = normalizeSearchSidecarConfig(config);
  if (!sidecar.enabled) throw new SearchSidecarError("Search sidecar is disabled.", { code: "search_sidecar_disabled" });
  if (typeof authorize !== "function") throw new SearchSidecarError("Search sidecar invocation is not authorized.", { code: "search_sidecar_unauthorized" });
  if (typeof searchImpl !== "function") throw new Error("searchImpl must be a function.");
  const normalized = normalizeSearchRequest(request, sidecar.maxResults);
  const normalizedAccountId = cleanString(accountId, "accountId", 256);
  const normalizedModel = cleanString(model, "model", 256);
  const authorizationInput = {
    accountId: normalizedAccountId,
    model: normalizedModel,
    providerId: sidecar.providerId,
    destination: sidecar.destination,
    request: normalized,
  };
  let authorized;
  try {
    authorized = await invokeBounded(authorize, authorizationInput, { signal, timeoutMs: sidecar.timeoutMs });
  } catch (error) {
    if (error instanceof SearchSidecarError) throw error;
    throw new SearchSidecarError("Search sidecar invocation is not authorized.", { code: "search_sidecar_unauthorized", cause: error });
  }
  if (authorized !== true) throw new SearchSidecarError("Search sidecar invocation is not authorized.", { code: "search_sidecar_unauthorized" });
  const key = JSON.stringify({
    accountId: normalizedAccountId,
    model: normalizedModel,
    providerId: sidecar.providerId,
    credentialRef: sidecar.credentialRef,
    destination: sidecar.destination,
    query: normalized.query,
    maxResults: normalized.maxResults,
  });
  const cached = cache?.get(key);
  if (cached) return { ...cached, telemetry: { ...(cached.telemetry || {}), cacheHit: true } };

  const started = now();
  let attempts = 0;
  for (; attempts < sidecar.maxAttempts; attempts += 1) {
    try {
      const payload = await invokeBounded(searchImpl, {
        query: normalized.query,
        maxResults: normalized.maxResults,
        accountId: normalizedAccountId,
        model: normalizedModel,
        credentialRef: sidecar.credentialRef,
        providerId: sidecar.providerId,
        destination: sidecar.destination,
      }, { signal, timeoutMs: sidecar.timeoutMs });
      const output = normalizeSearchResponse(payload, normalized);
      const result = {
        ...output,
        telemetry: {
          cacheHit: false,
          attempts: attempts + 1,
          durationMs: Math.max(0, now() - started),
          providerId: sidecar.providerId,
          model: normalizedModel,
        },
      };
      cache?.set(key, result);
      return result;
    } catch (error) {
      if (error instanceof SearchSidecarError && ["search_sidecar_timeout", "search_sidecar_cancelled"].includes(error.code)) {
        error.telemetry = { cacheHit: false, attempts: attempts + 1, durationMs: Math.max(0, now() - started), providerId: sidecar.providerId, model: normalizedModel };
        throw error;
      }
      if (!retryable(error) || attempts + 1 >= sidecar.maxAttempts) {
        throw new SearchSidecarError(error?.message || "Search sidecar request failed.", {
          status: statusOf(error),
          telemetry: { cacheHit: false, attempts: attempts + 1, durationMs: Math.max(0, now() - started), providerId: sidecar.providerId, model: normalizedModel },
          cause: error,
        });
      }
      const delayMs = sidecar.retryDelayMs * 2 ** attempts;
      await invokeBounded(() => sleep(delayMs), {}, { signal, timeoutMs: Math.max(sidecar.timeoutMs, delayMs + 10) });
    }
  }
  throw new SearchSidecarError("Search sidecar request failed.");
}
