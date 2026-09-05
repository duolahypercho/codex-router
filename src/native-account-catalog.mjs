import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";

import { Agent, EnvHttpProxyAgent, fetch as undiciFetch } from "undici";

import { nativeAccountCatalogHeaders } from "./codex-native-session.mjs";
import { codexVersion } from "./codex-binary.mjs";
import { secretEqual } from "./caller-auth.mjs";
import { withCatalogPublicationLock } from "./catalog-publication-lock.mjs";
import { discoveryDisabled } from "./discovery-mode.mjs";
import { writePrivateJsonAsync } from "./file-security.mjs";
import { MODEL_BY_SLUG } from "./model-registry.mjs";
import { MODELS_CACHE_PATH } from "./paths.mjs";
import { environmentHttpProxyConfigured } from "./proxy-environment.mjs";

export const NATIVE_ACCOUNT_CATALOG_TTL_MS = 5 * 60_000;
const MAX_ACCOUNT_CATALOG_BYTES = 32 * 1024 * 1024;
const ACCOUNT_CATALOG_TIMEOUT_MS = 5_000;
const ACCOUNT_CATALOG_BASE_URL = "https://chatgpt.com/backend-api/codex/models";

function validCatalog(value) {
  return value && Array.isArray(value.models) && value.models.length > 0;
}

function containsRoutedSlugs(catalog) {
  return Boolean(
    catalog?.models?.some((model) => MODEL_BY_SLUG.has(String(model?.slug || ""))),
  );
}

function modelsFingerprint(models) {
  return createHash("sha256").update(JSON.stringify(models)).digest("hex");
}

function safeEtag(value) {
  return typeof value === "string"
    && value.length > 0
    && value.length <= 1024
    && !/[\0\r\n]/.test(value)
    ? value
    : undefined;
}

function sameAccountSession(before, after) {
  if (!after?.authorization) return false;
  const beforeAccount = before?.["chatgpt-account-id"];
  const afterAccount = after?.["chatgpt-account-id"];
  if (beforeAccount || afterAccount) {
    return Boolean(beforeAccount && beforeAccount === afterAccount);
  }
  return secretEqual(before.authorization, after.authorization);
}

export function readModelsCache(cachePath = MODELS_CACHE_PATH) {
  const missing = { catalog: undefined, fingerprint: undefined };
  if (!existsSync(cachePath)) return missing;
  try {
    const parsed = JSON.parse(readFileSync(cachePath, "utf8"));
    if (!validCatalog(parsed)) return missing;
    return {
      catalog: parsed,
      fingerprint: modelsFingerprint(parsed.models),
    };
  } catch {
    return missing;
  }
}

export function codexClientVersion(value = codexVersion()) {
  const match = /(?:^|\s)(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)(?:\s|$)/.exec(
    String(value || ""),
  );
  return match?.[1];
}

function cacheIsFresh(cache, clientVersion, now) {
  if (!validCatalog(cache) || containsRoutedSlugs(cache)) return false;
  if (cache.client_version !== clientVersion) return false;
  const fetchedAt = Date.parse(cache.fetched_at);
  const age = now - fetchedAt;
  return Number.isFinite(fetchedAt) && age >= 0 && age < NATIVE_ACCOUNT_CATALOG_TTL_MS;
}

async function boundedJson(response, maxBytes = MAX_ACCOUNT_CATALOG_BYTES) {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await Promise.resolve(response.body?.cancel?.()).catch(() => undefined);
    return undefined;
  }
  if (!response.body) return undefined;
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel().catch(() => undefined);
        return undefined;
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock?.();
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return undefined;
  }
}

function accountCatalogDispatcher({
  environment = process.env,
  execArgv = process.execArgv,
  AgentClass = Agent,
  EnvHttpProxyAgentClass = EnvHttpProxyAgent,
} = {}) {
  const DispatcherClass = environmentHttpProxyConfigured(environment, execArgv)
    ? EnvHttpProxyAgentClass
    : AgentClass;
  return new DispatcherClass({
    allowH2: false,
    pipelining: 1,
    headersTimeout: ACCOUNT_CATALOG_TIMEOUT_MS,
    bodyTimeout: ACCOUNT_CATALOG_TIMEOUT_MS,
  });
}

/**
 * Refresh Codex's account cache without depending on Codex to ignore its
 * configured static router catalog. HTTP, schema, and cache-write failures are
 * intentionally represented as status only: the caller keeps the last cache
 * and bundled catalog. Lock failures still surface because proceeding across
 * an account-switch transaction would be unsafe.
 */
async function refreshNativeAccountCatalogUnlocked({
  cachePath = MODELS_CACHE_PATH,
  force = false,
  now = Date.now(),
  version,
  versionProvider = codexClientVersion,
  fetchImpl = undiciFetch,
  headersProvider = nativeAccountCatalogHeaders,
  dispatcherFactory = accountCatalogDispatcher,
  writeCache = writePrivateJsonAsync,
  timeoutMs = ACCOUNT_CATALOG_TIMEOUT_MS,
} = {}) {
  const clientVersion = version || versionProvider();
  if (!clientVersion) return { status: "unavailable" };

  const current = readModelsCache(cachePath);
  if (!force && cacheIsFresh(current.catalog, clientVersion, now)) {
    return { status: "fresh", fingerprint: current.fingerprint };
  }

  const accountHeaders = await headersProvider();
  if (!accountHeaders?.authorization) return { status: "unavailable" };

  const safeCurrent = validCatalog(current.catalog) && !containsRoutedSlugs(current.catalog);
  const etag = safeCurrent ? safeEtag(current.catalog.etag) : undefined;
  // Keep the credential sink fixed. Tests replace the transport, never the
  // destination, so this helper cannot be repurposed to send Codex auth to an
  // operator-controlled URL.
  const url = new URL(ACCOUNT_CATALOG_BASE_URL);
  url.searchParams.set("client_version", clientVersion);
  const headers = {
    ...accountHeaders,
    accept: "application/json",
    originator: "codex_router",
    "user-agent": `codex-router/${clientVersion}`,
    ...(etag ? { "if-none-match": etag } : {}),
  };
  const useDispatcher = fetchImpl === undiciFetch;
  let dispatcher;
  try {
    dispatcher = useDispatcher ? dispatcherFactory() : undefined;
    const response = await fetchImpl(url.toString(), {
      method: "GET",
      headers,
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
      ...(dispatcher ? { dispatcher } : {}),
    });
    if (response.status === 304 && safeCurrent) {
      await Promise.resolve(response.body?.cancel?.()).catch(() => undefined);
      // A client upgrade invalidates Codex's own cache even when the account
      // ETag is unchanged. Restamp that one transition so later checks can use
      // the normal TTL without rewriting a large unchanged cache every cycle.
      if (current.catalog.client_version !== clientVersion) {
        if (!sameAccountSession(accountHeaders, await headersProvider())) {
          return { status: "failed" };
        }
        await writeCache(
          cachePath,
          {
            ...current.catalog,
            fetched_at: new Date(now).toISOString(),
            client_version: clientVersion,
          },
          { directoryMode: 0o700 },
        );
      }
      return { status: "not-modified", fingerprint: current.fingerprint };
    }
    if (!response.ok || response.status >= 300) {
      await Promise.resolve(response.body?.cancel?.()).catch(() => undefined);
      return { status: "failed" };
    }
    const parsed = await boundedJson(response);
    if (!validCatalog(parsed) || containsRoutedSlugs(parsed)) {
      return { status: "failed" };
    }
    // Account switching also owns models_cache.json. The publication lock
    // serializes router-managed switches; this second identity read closes the
    // remaining race with an official Codex login change during the request.
    if (!sameAccountSession(accountHeaders, await headersProvider())) {
      return { status: "failed" };
    }
    const fingerprint = modelsFingerprint(parsed.models);
    const responseEtag = safeEtag(response.headers.get("etag"));
    if (
      safeCurrent
      && fingerprint === current.fingerprint
      && (!responseEtag || responseEtag === etag)
    ) {
      return { status: "unchanged", fingerprint };
    }
    await writeCache(
      cachePath,
      {
        fetched_at: new Date(now).toISOString(),
        ...(responseEtag ? { etag: responseEtag } : {}),
        client_version: clientVersion,
        models: parsed.models,
      },
      { directoryMode: 0o700 },
    );
    return {
      status: safeCurrent && fingerprint === current.fingerprint
        ? "revalidated"
        : "updated",
      fingerprint,
    };
  } catch {
    return { status: "failed" };
  } finally {
    await dispatcher?.close().catch(() => undefined);
  }
}

export async function refreshNativeAccountCatalog({
  discoveryOff = discoveryDisabled,
  lock = withCatalogPublicationLock,
  lockOptions,
  ...options
} = {}) {
  // This guard precedes the lock, cache read, auth read, Codex spawn, and
  // network request. --no-discovery promises that all account-derived
  // artifacts stay untouched, including models_cache.json.
  if (discoveryOff()) return { status: "disabled" };
  return lock(
    () => discoveryOff()
      ? { status: "disabled" }
      : refreshNativeAccountCatalogUnlocked(options),
    lockOptions,
  );
}
