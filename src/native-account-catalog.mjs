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

// Compare the numeric release triple of two client versions. A prerelease
// suffix is deliberately ignored: it never widens the model list, and treating
// "unparseable" as "not older" keeps the guard below from ever blocking a
// refresh it cannot reason about.
export function olderClientVersion(candidate, reference) {
  const triple = (value) => {
    const match = /^(\d+)\.(\d+)\.(\d+)/.exec(String(value || ""));
    return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : undefined;
  };
  const left = triple(candidate);
  const right = triple(reference);
  if (!left || !right) return false;
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) return left[index] < right[index];
  }
  return false;
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

  const safeCurrent = validCatalog(current.catalog) && !containsRoutedSlugs(current.catalog);
  // models_cache.json is Codex's own cache, and this endpoint gates the model
  // list on client_version: measured against the live endpoint, 0.150.0 is not
  // offered gpt-6-astra while 0.153.4 is. If the Codex this router resolved is
  // older than the client that last wrote the cache -- an outdated `codex` on
  // PATH while the user runs a newer Codex, say -- then our answer is the
  // poorer one, and writing it would take a model away from the Codex actually
  // running (issue #645). Leave the richer cache alone and say why.
  if (safeCurrent && olderClientVersion(clientVersion, current.catalog.client_version)) {
    return { status: "stale-client", fingerprint: current.fingerprint };
  }

  const accountHeaders = await headersProvider();
  if (!accountHeaders?.authorization) return { status: "unavailable" };

  // The account endpoint varies its answer on `client_version`: a Codex
  // upgrade is exactly the moment a newly gated native joins the list, which
  // is how GPT-6-Astra went missing for router installs (issue #645). An ETag
  // earned under the previous client_version does not describe the answer
  // this one would receive, so replaying it invites a 304 that pins the
  // picker to the pre-upgrade catalog for good. Revalidate only within the
  // version that issued the validator; across a version change, ask outright.
  const etag = safeCurrent && current.catalog.client_version === clientVersion
    ? safeEtag(current.catalog.etag)
    : undefined;
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
    if (response.status === 304) {
      await Promise.resolve(response.body?.cancel?.()).catch(() => undefined);
      // Only a conditional request can be answered 304, and one is sent only
      // when the cached validator belongs to this client_version. A 304 to an
      // unconditional request is a server ignoring us, and blessing the stale
      // body as current is precisely the freeze this guard exists to prevent.
      if (!etag) return { status: "failed" };
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
