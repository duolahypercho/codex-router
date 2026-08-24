// Explicit, provider-agnostic web search for models that cannot consume the
// native search tool.  This module only coordinates a caller-supplied search
// adapter: credentials stay in the provider boundary and ordinary text turns
// never reach it by accident.

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

function own(value, key) {
  return value !== null && typeof value === "object" && Object.hasOwn(value, key);
}

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
  if (typeof value !== "string" || !value.trim() || value.length > max) {
    throw new Error(`${name} must be a non-empty string of at most ${max} characters.`);
  }
  return value.trim();
}

/**
 * Normalize only non-secret sidecar metadata. `credentialRef` is an opaque
 * reference resolved by the provider adapter; secret values are rejected.
 */
export function normalizeSearchSidecarConfig(value = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Search sidecar config must be an object.");
  }
  for (const key of ["apiKey", "token", "secret", "password", "authorization"]) {
    if (own(value, key)) throw new Error(`Search sidecar config cannot contain ${key}.`);
  }
  const enabled = value.enabled === true;
  if (value.enabled !== undefined && typeof value.enabled !== "boolean") {
    throw new Error("Search sidecar enabled must be a boolean.");
  }
  const result = {
    enabled,
    ...(value.providerId !== undefined ? { providerId: cleanString(value.providerId, "providerId", 128) } : {}),
    ...(value.credentialRef !== undefined ? { credentialRef: cleanString(value.credentialRef, "credentialRef", 256) } : {}),
    timeoutMs: value.timeoutMs === undefined ? SEARCH_SIDECAR_DEFAULTS.timeoutMs : positiveInteger(value.timeoutMs, "timeoutMs", { max: 120_000 }),
    maxResults: value.maxResults === undefined ? SEARCH_SIDECAR_DEFAULTS.maxResults : positiveInteger(value.maxResults, "maxResults", { max: 50 }),
    cacheTtlMs: value.cacheTtlMs === undefined ? SEARCH_SIDECAR_DEFAULTS.cacheTtlMs : nonNegativeInteger(value.cacheTtlMs, "cacheTtlMs", { max: 86_400_000 }),
    cacheMaxEntries: value.cacheMaxEntries === undefined ? SEARCH_SIDECAR_DEFAULTS.cacheMaxEntries : positiveInteger(value.cacheMaxEntries, "cacheMaxEntries", { max: 2_000 }),
    maxAttempts: value.maxAttempts === undefined ? SEARCH_SIDECAR_DEFAULTS.maxAttempts : positiveInteger(value.maxAttempts, "maxAttempts", { max: 3 }),
    retryDelayMs: value.retryDelayMs === undefined ? SEARCH_SIDECAR_DEFAULTS.retryDelayMs : nonNegativeInteger(value.retryDelayMs, "retryDelayMs", { max: 10_000 }),
  };
  if (result.enabled && !result.providerId) throw new Error("An enabled search sidecar needs providerId.");
  if (result.enabled && !result.credentialRef) throw new Error("An enabled search sidecar needs credentialRef.");
  return Object.freeze(result);
}

/** Resolve native/sidecar transport without model-name conditionals. */
export function resolveSearchTransport({ modelCapabilities = {}, sidecar, mode = "auto" } = {}) {
  if (!SEARCH_MODES.has(mode)) throw new Error(`Unknown search mode ${mode}.`);
  const native = modelCapabilities?.supportsSearch === true;
  const configured = sidecar?.enabled === true;
  if (mode === "native") return native ? "native" : "disabled";
  if (mode === "sidecar") return configured ? "sidecar" : "disabled";
  if (native) return "native";
  return configured ? "sidecar" : "disabled";
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
  if (!/^https?:$/.test(parsed.protocol)) throw new Error(`results[${index}].url must use http or https.`);
  return {
    title: cleanString(value.title || parsed.hostname, `results[${index}].title`, MAX_RESULT_LENGTH),
    url,
    ...(value.snippet === undefined ? {} : { snippet: cleanString(value.snippet, `results[${index}].snippet`, MAX_RESULT_LENGTH) }),
    ...(value.publishedAt === undefined ? {} : { publishedAt: cleanString(value.publishedAt, `results[${index}].publishedAt`, 128) }),
  };
}

export function normalizeSearchResponse(payload, request) {
  const raw = Array.isArray(payload) ? payload : payload?.results;
  if (!Array.isArray(raw)) throw new Error("Search sidecar returned no results array.");
  const results = raw.slice(0, request.maxResults).map(normalizeResult);
  return {
    query: request.query,
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

function combinedSignal(signal, timeoutMs) {
  const timeout = AbortSignal.timeout(timeoutMs);
  if (!signal) return timeout;
  return AbortSignal.any([signal, timeout]);
}

function abortReason(signal, timeoutMs) {
  if (signal?.aborted) {
    return signal.reason?.name === "TimeoutError" || signal.reason?.code === "ERR_ABORTED"
      ? "timeout"
      : "cancelled";
  }
  return timeoutMs ? "timeout" : "cancelled";
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

/** Execute one explicit sidecar search. The adapter owns credential lookup. */
export async function searchWithSidecar({ config, request, searchImpl, signal, cache, now = () => Date.now(), sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) } = {}) {
  const sidecar = normalizeSearchSidecarConfig(config);
  if (!sidecar.enabled) throw new SearchSidecarError("Search sidecar is disabled.", { code: "search_sidecar_disabled" });
  if (typeof searchImpl !== "function") throw new Error("searchImpl must be a function.");
  const normalized = normalizeSearchRequest(request, sidecar.maxResults);
  const key = `${sidecar.providerId}:${normalized.query}:${normalized.maxResults}`;
  const cached = cache?.get(key);
  if (cached) return { ...cached, telemetry: { ...(cached.telemetry || {}), cacheHit: true } };

  const started = now();
  let attempts = 0;
  for (; attempts < sidecar.maxAttempts; attempts += 1) {
    const requestSignal = combinedSignal(signal, sidecar.timeoutMs);
    try {
      const payload = await searchImpl({
        query: normalized.query,
        maxResults: normalized.maxResults,
        credentialRef: sidecar.credentialRef,
        providerId: sidecar.providerId,
        signal: requestSignal,
      });
      // An adapter may resolve after aborting if its underlying client does
      // not propagate AbortSignal. Never turn that late payload into a
      // successful result after the sidecar deadline/caller cancellation.
      if (requestSignal.aborted || signal?.aborted) {
        const reason = abortReason(requestSignal, sidecar.timeoutMs);
        throw new SearchSidecarError(`Search sidecar ${reason}.`, {
          code: reason === "timeout" ? "search_sidecar_timeout" : "search_sidecar_cancelled",
        });
      }
      const output = normalizeSearchResponse(payload, normalized);
      const result = {
        ...output,
        telemetry: {
          cacheHit: false,
          attempts: attempts + 1,
          durationMs: Math.max(0, now() - started),
          providerId: sidecar.providerId,
        },
      };
      cache?.set(key, result);
      return result;
    } catch (error) {
      if (requestSignal.aborted || signal?.aborted) {
        const reason = abortReason(requestSignal, sidecar.timeoutMs);
        throw new SearchSidecarError(`Search sidecar ${reason}.`, {
          code: reason === "timeout" ? "search_sidecar_timeout" : "search_sidecar_cancelled",
          telemetry: { cacheHit: false, attempts: attempts + 1, durationMs: Math.max(0, now() - started), providerId: sidecar.providerId },
          cause: error,
        });
      }
      if (!retryable(error) || attempts + 1 >= sidecar.maxAttempts) {
        throw new SearchSidecarError(error?.message || "Search sidecar request failed.", {
          status: statusOf(error),
          telemetry: { cacheHit: false, attempts: attempts + 1, durationMs: Math.max(0, now() - started), providerId: sidecar.providerId },
          cause: error,
        });
      }
      await sleep(sidecar.retryDelayMs * 2 ** attempts);
    }
  }
  throw new SearchSidecarError("Search sidecar request failed.");
}
