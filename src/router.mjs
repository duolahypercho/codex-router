import { readFileSync } from "node:fs";
import http from "node:http";
import { createHash, randomUUID } from "node:crypto";
import {
  brotliDecompressSync,
  gunzipSync,
  inflateSync,
  zstdCompress,
  zstdDecompressSync,
} from "node:zlib";
import { promisify } from "node:util";

import {
  assertCallerSecret,
  authenticatedRoute,
  secretEqual,
} from "./caller-auth.mjs";
import {
  applyKeepAliveTimeouts,
  endStreamedResponse,
  finishResponse,
  formatErrorChain,
  HOP_BY_HOP_HEADERS,
  httpErrorStatus,
  pipeResponse,
  readRequestBody,
  writeJson,
} from "./http-utils.mjs";
import { EmptyCompletionGuard } from "./empty-completion-guard.mjs";
import {
  MERGED_CATALOG_PATH,
  NATIVE_CATALOG_PATH,
  PORTS,
  loopback,
} from "./paths.mjs";
import { MODEL_BY_SLUG, PROVIDERS, providerForModel } from "./model-registry.mjs";
import { createHealthCache } from "./health-cache.mjs";
import { readNativeAliases } from "./native-alias.mjs";
import { readNativeRedirect } from "./native-redirect.mjs";
import {
  canonicalProviderId,
  readProviderSelection,
  selectedConfiguredListedModels,
} from "./provider-selection.mjs";
import {
  estimateInputTokens,
  mergeTokenUsage,
  ResponseUsageTransform,
  tokenUsageFromPayload,
} from "./response-usage.mjs";
import { fetchWithRetry } from "./upstream-retry.mjs";
import {
  NamespaceToolCallTransform,
  flattenNamespacedHistory,
  flattenNamespaceTools,
} from "./namespace-relay.mjs";
import { mergeCodexAppTools } from "./codex-app-tools.mjs";
import { activityMetadataFromHeaders } from "./codex-session-names.mjs";
import { translateGatewayError } from "./error-translation.mjs";
import { recordUsageEvent } from "./usage-events.mjs";
import {
  classifySsePrefix,
  HEADERLESS_SSE_SNIFF_BYTES,
  HEADERLESS_SSE_SNIFF_MS,
} from "./sse-prefix.mjs";
import {
  describeImage,
  evidenceCache,
  hasNativeSession,
  inputHasImage,
  nativeAccountKey,
  resolveVisionEngines,
  stripImages,
  substituteImages,
  supportsImageInput,
} from "./vision-bridge.mjs";
import { readHiddenModels } from "./model-picker-state.mjs";
import { readVisionBridgeSettings } from "./vision-bridge-state.mjs";
import { installedNativeVisionEngines } from "./vision-engines.mjs";
import { ageToolResults } from "./tool-result-aging.mjs";
import {
  nativeToolResultAgingEnabled,
  toolResultAgingEnabled,
} from "./tool-result-aging-state.mjs";
import { VERSION } from "./version.mjs";
import { nativeSessionHeaders } from "./codex-native-session.mjs";

const LISTEN_HOST =
  process.env.CODEX_ROUTER_HOST || process.env.KIMI_ROUTER_HOST || "127.0.0.1";
const LISTEN_PORT = Number(
  process.env.CODEX_ROUTER_PORT || process.env.KIMI_ROUTER_PORT || PORTS.router,
);
const NATIVE_BASE = (
  process.env.CODEX_NATIVE_BASE_URL || "https://chatgpt.com/backend-api/codex"
).replace(/\/+$/, "");
const GATEWAY_BASE = (
  process.env.CODEX_ROUTER_GATEWAY_BASE_URL ||
  process.env.KIMI_GATEWAY_BASE_URL ||
  loopback(PORTS.gateway, "/v1")
).replace(/\/+$/, "");
const OAUTH_HEALTH =
  process.env.CODEX_ROUTER_OAUTH_HEALTH_URL ||
  process.env.KIMI_OAUTH_HEALTH_URL ||
  loopback(PORTS.oauth, "/health");
const API_HEALTH =
  process.env.CODEX_ROUTER_API_HEALTH_URL ||
  process.env.KIMI_API_HEALTH_URL ||
  loopback(PORTS.api, "/health");
const GATEWAY_HEALTH =
  process.env.CODEX_ROUTER_GATEWAY_HEALTH_URL ||
  process.env.KIMI_GATEWAY_HEALTH_URL ||
  loopback(PORTS.gateway, "/health/liveliness");
const CATALOG_PATH =
  process.env.CODEX_ROUTER_CATALOG || process.env.KIMI_ROUTER_CATALOG || MERGED_CATALOG_PATH;
const INTERNAL_KEY =
  process.env.CODEX_ROUTER_INTERNAL_KEY || process.env.KIMI_INTERNAL_KEY;
const CALLER_KEY = process.env.CODEX_ROUTER_CALLER_KEY;
const QUIET =
  process.env.CODEX_ROUTER_QUIET === "1" || process.env.KIMI_PROXY_QUIET === "1";
// Kill switch for the zero-prompt-token substitution (#95). It is on because a
// provider that reports no prompt tokens breaks compaction outright, but an
// operator who would rather see the provider's own numbers can turn it off
// without downgrading the router.
const ZERO_INPUT_ESTIMATE = process.env.CODEX_ROUTER_ZERO_INPUT_ESTIMATE !== "0";
// Kill switch for the empty-completion guard and its single retry. It is on
// because an empty completion is otherwise invisible -- the client records the
// turn as a silent success -- but the retry re-sends the whole prompt, so an
// operator who would rather pay once and see the raw upstream behaviour can
// turn it off without downgrading the router.
const EMPTY_COMPLETION_RETRY =
  process.env.CODEX_ROUTER_EMPTY_COMPLETION_RETRY !== "0";
const ERROR_STATUS_DURATION_MS = 8_000;
const configuredDecodedBodyBytes = Number(
  process.env.MODEL_ROUTER_MAX_DECODED_BODY_BYTES ||
    process.env.CODEX_ROUTER_MAX_DECODED_BODY_BYTES ||
    256 * 1024 * 1024,
);
const MAX_DECODED_BODY_BYTES =
  Number.isFinite(configuredDecodedBodyBytes) && configuredDecodedBodyBytes > 0
    ? Math.floor(configuredDecodedBodyBytes)
    : 256 * 1024 * 1024;
// No single Codex turn streams for this long. Anything still marked in-flight
// past this point leaked (crashed client, half-closed socket) and would
// otherwise inflate the tray activity count until the router restarts.
const STALE_ACTIVITY_MS = 15 * 60_000;
const NATIVE_IMAGE_PATHS = new Set([
  "/images/edits",
  "/images/generations",
  "/v1/images/edits",
  "/v1/images/generations",
]);
const NATIVE_SEARCH_PATHS = new Set(["/alpha/search", "/v1/alpha/search"]);
const AGENT_PAYLOAD_RELAY_TOOL = "relay_external_agent_payload";
const AGENT_PAYLOAD_CACHE_TTL_MS = 15 * 60 * 1_000;
const AGENT_PAYLOAD_CACHE_MAX_BYTES = 8 * 1024 * 1024;
const AGENT_PAYLOAD_CACHE_MAX_ENTRIES = 256;
const agentPayloadCache = new Map();
let agentPayloadCacheBytes = 0;

let requestSequence = 0;
const activeRequests = new Map();
let lastUsedProvider;
let lastUsedModel;
let lastUsedSessionName;
let errorStatusUntil = 0;

if (!INTERNAL_KEY) throw new Error("CODEX_ROUTER_INTERNAL_KEY is required.");
assertCallerSecret(CALLER_KEY);

function pruneStaleActivity(now = Date.now()) {
  for (const [requestId, entry] of activeRequests) {
    if (now - (entry?.startedAt ?? 0) > STALE_ACTIVITY_MS) {
      activeRequests.delete(requestId);
    }
  }
}

function activityPayload() {
  pruneStaleActivity();
  const active = [...activeRequests.values()].filter(
    (entry) => entry && typeof entry === "object" && entry.provider,
  );
  const latest = active.at(-1);
  const provider = latest?.provider || lastUsedProvider;
  const model = latest?.model || lastUsedModel;
  const sessionName = latest?.sessionName || lastUsedSessionName;
  return {
    state:
      activeRequests.size > 0
        ? "generating"
        : Date.now() < errorStatusUntil
          ? "error"
          : "idle",
    activeCount: activeRequests.size,
    active,
    ...(provider ? { provider } : {}),
    ...(model ? { model } : {}),
    ...(sessionName ? { sessionName } : {}),
  };
}

function beginRequestActivity() {
  const requestId = ++requestSequence;
  const startedAt = Date.now();
  activeRequests.set(requestId, { startedAt });
  let finished = false;
  return {
    setRoute({ provider, model, sessionName, ...metadata } = {}) {
      if (!provider) return;
      const entry = {
        id: String(requestId),
        provider,
        ...(model ? { model } : {}),
        ...(sessionName ? { sessionName } : {}),
        ...metadata,
        startedAt,
      };
      activeRequests.set(requestId, entry);
      lastUsedProvider = provider;
      if (model) lastUsedModel = model;
      if (sessionName) lastUsedSessionName = sessionName;
    },
    finish(status) {
      if (finished) return;
      finished = true;
      activeRequests.delete(requestId);
      if (status >= 400) errorStatusUntil = Date.now() + ERROR_STATUS_DURATION_MS;
    },
  };
}

const FORWARD_HEADERS = new Set([
  "authorization",
  "chatgpt-account-id",
  "openai-beta",
  "originator",
  "session_id",
  "session-id",
  "thread-id",
  "x-client-request-id",
  "x-codex-beta-features",
  "x-codex-installation-id",
  "x-codex-parent-thread-id",
  "x-codex-turn-metadata",
  "x-codex-turn-state",
  "x-codex-window-id",
  "x-oai-attestation",
  "x-openai-subagent",
  "x-responsesapi-include-timing-metrics",
]);

const COMPACT_PROMPT = `You are performing a CONTEXT CHECKPOINT COMPACTION. Create a handoff summary for another language model that will resume the task.

Include current progress, key decisions, constraints, user preferences, remaining steps, and critical data or references. Be concise, structured, and focused on seamless continuation.`;
const SUMMARY_PREFIX =
  "Another language model started this task and produced a continuation summary. Use it to continue without repeating completed work:";
const COMPACTION_PREFIX = "kcr1:";

function parseBody(buffer) {
  try {
    const value = JSON.parse(buffer.toString("utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("Request JSON must be an object.");
    }
    return value;
  } catch (error) {
    const wrapped = new Error(
      `Invalid JSON request: ${error instanceof Error ? error.message : String(error)}`,
    );
    wrapped.status = 400;
    throw wrapped;
  }
}

function decodeBody(body, contentEncoding) {
  const value = Array.isArray(contentEncoding)
    ? contentEncoding.join(",")
    : String(contentEncoding || "");
  const encodings = value
    .split(",")
    .map((encoding) => encoding.trim().toLowerCase())
    .filter((encoding) => encoding && encoding !== "identity")
    .reverse();
  let decoded = body;
  try {
    for (const encoding of encodings) {
      const options = { maxOutputLength: MAX_DECODED_BODY_BYTES };
      if (encoding === "zstd") decoded = zstdDecompressSync(decoded, options);
      else if (encoding === "gzip" || encoding === "x-gzip") {
        decoded = gunzipSync(decoded, options);
      } else if (encoding === "deflate") decoded = inflateSync(decoded, options);
      else if (encoding === "br") decoded = brotliDecompressSync(decoded, options);
      else {
        const error = new Error(`Unsupported Content-Encoding: ${encoding}`);
        error.status = 415;
        throw error;
      }
    }
  } catch (error) {
    if (error?.status) throw error;
    if (error?.code === "ERR_BUFFER_TOO_LARGE") {
      const wrapped = new Error(
        `Decoded request body exceeds ${MAX_DECODED_BODY_BYTES} bytes.`,
      );
      wrapped.status = 413;
      throw wrapped;
    }
    const wrapped = new Error(
      `Unable to decompress request body: ${error instanceof Error ? error.message : String(error)}`,
    );
    wrapped.status = 400;
    throw wrapped;
  }
  if (decoded.length > MAX_DECODED_BODY_BYTES) {
    const error = new Error("Decoded request body is too large.");
    error.status = 413;
    throw error;
  }
  return decoded;
}

// Codex compresses its own request bodies with zstd, and the Codex backend
// accepts them. The router has to inflate one to route it, and a decoded body
// cannot travel under the caller's Content-Encoding, so every turn used to go
// up the link as full inflated JSON: 2.6x more bytes than the client sent,
// measured across a week of real turns. Compressing it again costs about 10ms
// off the event loop on a 2 MB turn. Small bodies are left alone, where a TLS
// record or two is the whole payload and compression buys nothing.
const MIN_COMPRESSED_BODY_BYTES = 16 * 1024;
const compressBody = promisify(zstdCompress);

async function compressedNativeBody(body, headers) {
  if (body.length < MIN_COMPRESSED_BODY_BYTES) return body;
  try {
    const compressed = await compressBody(body);
    // Incompressible payloads (base64 image data, mostly) would only pay the
    // decode cost on the far side for nothing.
    if (compressed.length >= body.length) return body;
    headers["Content-Encoding"] = "zstd";
    return compressed;
  } catch {
    // Compression is an optimization, never a requirement: the plain body is
    // always a valid request, so a zstd failure must not fail the turn.
    return body;
  }
}

function nativeHeaders(request) {
  const headers = {
    "Content-Type": "application/json",
    "Accept-Encoding": "identity",
  };
  for (const name of FORWARD_HEADERS) {
    const value = request.headers[name];
    if (value !== undefined) {
      headers[name] = Array.isArray(value) ? value.join(", ") : value;
    }
  }
  // A caller that brought its own upstream session is relayed exactly as it
  // arrived -- Codex always does, so nothing about a Codex turn changes here.
  //
  // "Brought none" is not the same as "sent no header". The harness
  // authenticates to this router with the router's *own* caller key, as a
  // bearer token, because a provider route has nowhere else to put a
  // credential. That key means "you may use this router"; it is not an OpenAI
  // credential, and forwarding it upstream earns exactly the "API key is
  // invalid" it deserves -- besides handing a local secret to a remote host.
  // So a router-local key counts as no upstream credential at all.
  const presented = bearerToken(headers.authorization);
  const routerLocal =
    presented !== undefined &&
    (secretEqual(presented, CALLER_KEY || "") || secretEqual(presented, INTERNAL_KEY || ""));
  if (!headers.authorization || routerLocal) {
    const fallback = nativeSessionHeaders();
    if (fallback) {
      Object.assign(headers, fallback);
    } else if (routerLocal) {
      // Nothing to substitute. Send no credential rather than this one: the
      // upstream 401 is the same either way, and a router secret must never
      // leave the machine.
      delete headers.authorization;
    }
  }
  return headers;
}

// The token out of an `Authorization: Bearer <token>` header, or undefined for
// any other scheme -- which is relayed untouched rather than inspected.
//
// Parsed rather than matched. `/^Bearer\s+(.+)$/` reads well and backtracks
// polynomially on a header of many spaces and no token, and this runs on a
// header an unauthenticated caller controls. Scanning is linear and needs no
// reasoning about which quantifiers can overlap.
const BEARER_PREFIX = "bearer";
function bearerToken(value) {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (trimmed.length <= BEARER_PREFIX.length) return undefined;
  if (trimmed.slice(0, BEARER_PREFIX.length).toLowerCase() !== BEARER_PREFIX) return undefined;
  // The scheme and the token must be separated by whitespace, or `BearerX` and
  // `Bearer X` would parse the same.
  const separator = trimmed[BEARER_PREFIX.length];
  if (separator !== " " && separator !== "\t") return undefined;
  const token = trimmed.slice(BEARER_PREFIX.length + 1).trim();
  return token || undefined;
}

// True when the caller authenticated to this router and brought no upstream
// credential of its own -- the harness, and anything else pointed at a managed
// caller base URL. Codex is never this.
function callerBroughtNoUpstreamCredential(request) {
  const presented = bearerToken(request.headers.authorization);
  if (presented === undefined) return request.headers.authorization === undefined;
  return secretEqual(presented, CALLER_KEY || "") || secretEqual(presented, INTERNAL_KEY || "");
}

// ChatGPT's own backend accepts a narrower request than the public Responses
// API does. Codex knows the difference and complies; a generic OpenAI client
// does not, and every one of these comes back as a bare 400 that names a single
// parameter. Measured against the live endpoint rather than guessed.
const NATIVE_UNSUPPORTED_PARAMS = Object.freeze([
  "temperature",
  "top_p",
  "presence_penalty",
  "frequency_penalty",
  "max_tokens",
  "max_output_tokens",
  "metadata",
  "seed",
  "user",
  "truncation",
]);

/**
 * Make a generic Responses request acceptable to the native endpoint.
 *
 * Applied only for a caller whose session this router substituted, so a Codex
 * turn is never rewritten -- Codex sends a compliant request already, and the
 * promise that its traffic is byte-identical is worth more than the tidiness of
 * one shared path.
 */
function normalizeNativeForSubstitutedCaller(payload) {
  // Not optional upstream: `store` must be false, and anything else is a 400.
  payload.store = false;
  for (const key of NATIVE_UNSUPPORTED_PARAMS) delete payload[key];
  return payload;
}

function routedHeaders() {
  return {
    Authorization: `Bearer ${INTERNAL_KEY}`,
    "Content-Type": "application/json",
    "Accept-Encoding": "identity",
    "User-Agent": `codex-router/${VERSION}`,
  };
}

// LiteLLM translates Codex Responses requests into Chat Completions only after
// this router hands the turn to the gateway. A profile that rejects forced
// tool choices therefore has to be normalized here, before that translation
// can cause the upstream model to emit an invalid forced call.
function normalizeAutoToolChoice(payload, route) {
  if (
    ["auto-tool-choice", "ollama-cloud-auto-tool-choice"].includes(route.requestProfile) &&
    payload.tool_choice !== undefined &&
    payload.tool_choice !== "none"
  ) {
    payload.tool_choice = "auto";
  }
}

function nativeTarget(pathname, search = "") {
  const withoutV1 = pathname.replace(/^\/v1(?=\/|$)/, "");
  return `${NATIVE_BASE}${withoutV1}${search}`;
}

// Provider-level query_params are applied by Codex to every request sent to
// that provider. Signed routing temporarily reuses a user's provider identity,
// so relaying the caller's arbitrary query string would send API keys or other
// provider secrets to ChatGPT. Native Responses and image routes need no query
// string. Web search owns one fixed client hint; preserve only that exact value.
function nativeRequestSearch(requestUrl) {
  return NATIVE_SEARCH_PATHS.has(requestUrl.pathname) &&
    requestUrl.searchParams.get("source") === "codex"
    ? "?source=codex"
    : "";
}

// The safety line for an upstream retry: has the caller seen anything yet?
//
// `pipeResponse` assigns `response.statusCode` and calls `copyResponseHeaders`,
// which only stages values with `setHeader` -- neither touches the socket.
// Node flushes the head on the first body write, or on `end()` for a bodyless
// upstream, and that is exactly when `headersSent` flips. So `headersSent` is
// "at least the status line has been committed", which is the condition that
// makes a retry unsafe: replaying then would append a second response to a
// stream the client is already reading.
//
// `writableEnded`/`destroyed` cover the answers that never set headers through
// this path (an early `writeJson`, a client that hung up). The structural
// guarantee is stronger than the predicate: every retry happens inside
// `fetchWithRetry`, which returns before any of this function's callers touch
// `response` at all. This is the check that would notice if that ever stopped
// being true.
function nothingRelayed(response) {
  return !response.headersSent && !response.writableEnded && !response.destroyed;
}

// The empty-completion retry can produce a substituted prompt count on either
// attempt, and both prompts were sent. Add them so the substitution total
// matches the two-attempt turn the rest of the usage event describes; absent
// on both sides it stays absent, so an ordinary turn keeps its exact shape.
function sumEstimatedInputTokens(first, second) {
  if (first === undefined) return second;
  if (second === undefined) return first;
  return first + second;
}

const HEADERLESS_SSE_TIMEOUT = Symbol("headerless-sse-timeout");
const MAX_REJECTED_RETRY_USAGE_BYTES = 8 * 1024 * 1024;

async function readHeaderlessSseChunk(reader, timeoutMs) {
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve(HEADERLESS_SSE_TIMEOUT), timeoutMs);
    timer.unref?.();
  });
  try {
    return await Promise.race([reader.read(), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

function responseWithBody(upstream, body) {
  return new Response(body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: upstream.headers,
  });
}

// Rejected retries are still upstream requests and may be billed. Drain only
// a complete bounded body through the ordinary usage observer; an oversized,
// stalled, or failed body has unknowable usage and is canceled without
// inventing token counts.
async function observeRejectedRetryUsage(upstream, signal) {
  if (!upstream?.body) return undefined;
  const reader = upstream.body.getReader();
  const observer = new ResponseUsageTransform(
    upstream.headers.get("content-type") || "",
  );
  observer.on("data", () => {});
  const deadline = Date.now() + HEADERLESS_SSE_SNIFF_MS;
  let total = 0;
  try {
    while (true) {
      const result = await readHeaderlessSseChunk(
        reader,
        Math.max(0, deadline - Date.now()),
      );
      if (result === HEADERLESS_SSE_TIMEOUT) {
        void reader.cancel().catch(() => {});
        observer.destroy();
        return undefined;
      }
      if (result.done) break;
      total += result.value?.byteLength || 0;
      if (total > MAX_REJECTED_RETRY_USAGE_BYTES) {
        void reader.cancel().catch(() => {});
        observer.destroy();
        return undefined;
      }
      if (result.value?.byteLength) observer.write(Buffer.from(result.value));
    }
    await new Promise((resolve, reject) => {
      observer.once("finish", resolve);
      observer.once("error", reject);
      observer.end();
    });
    return observer.tokenUsage();
  } catch {
    void reader.cancel().catch(() => {});
    observer.destroy();
    signal?.throwIfAborted();
    return undefined;
  }
}

// A retry without Content-Type is still compatible when its bytes prove it is
// SSE. Peek through one tee branch, then relay the untouched branch through
// the normal transforms. A headerless JSON body is rejected before any of it
// reaches the client, preserving the deterministic protocol-error contract.
async function prepareEventStreamRetry(upstream) {
  const contentType = String(upstream?.headers?.get("content-type") || "").trim();
  if (contentType.toLowerCase().includes("text/event-stream")) {
    return { response: upstream, pipelineContentType: contentType };
  }
  if (contentType) return { rejectedResponse: upstream };
  if (!upstream?.body) return undefined;

  const [probe, relay] = upstream.body.tee();
  const reader = probe.getReader();
  let prefix = Buffer.alloc(0);
  let compatible = false;
  const deadline = Date.now() + HEADERLESS_SSE_SNIFF_MS;
  try {
    while (prefix.length < HEADERLESS_SSE_SNIFF_BYTES) {
      const result = await readHeaderlessSseChunk(
        reader,
        Math.max(0, deadline - Date.now()),
      );
      if (result === HEADERLESS_SSE_TIMEOUT) break;
      if (result.done) {
        compatible = classifySsePrefix(prefix, { end: true }) === "event-stream";
        break;
      }
      if (result.value?.byteLength) {
        const remaining = HEADERLESS_SSE_SNIFF_BYTES - prefix.length;
        prefix = Buffer.concat([
          prefix,
          Buffer.from(result.value).subarray(0, remaining),
        ]);
        const decision = classifySsePrefix(prefix);
        if (decision === "event-stream") {
          compatible = true;
          break;
        }
        if (decision === "other") break;
      }
    }
  } catch (error) {
    void reader.cancel().catch(() => {});
    void relay.cancel().catch(() => {});
    throw error;
  }

  if (!compatible) {
    void reader.cancel().catch(() => {});
    return { rejectedResponse: responseWithBody(upstream, relay) };
  }
  void reader.cancel().catch(() => {});
  return {
    response: responseWithBody(upstream, relay),
    pipelineContentType: "text/event-stream",
  };
}

// `pipeResponse` stages the upstream head before the first body byte. The
// empty-completion gate can finish without emitting that byte, leaving a head
// that is still replaceable. Clear it before selecting the retry or a synthetic
// protocol error so no first-attempt header survives into the one response the
// client actually receives.
function clearStagedResponseHead(response) {
  if (response.headersSent) {
    throw new Error("Cannot replace a response head after it was sent.");
  }
  for (const name of response.getHeaderNames()) response.removeHeader(name);
  response.statusCode = 200;
}

function writeEmptyCompletionError(response, code, message) {
  clearStagedResponseHead(response);
  writeJson(response, 502, {
    error: {
      type: code,
      code,
      message,
    },
  });
}

function timingMetric(value) {
  return Number.isFinite(value) ? String(value) : "unknown";
}

// Never gated on QUIET. A production LaunchAgent hard-sets `CODEX_ROUTER_QUIET=1`,
// which suppresses the per-request status line, and a silent retry is worse
// than no retry: a flaky upstream would look like an upstream that got better.
// Response bodies are never logged, so a retry records the status or the
// transport error's own name and code and nothing else.
function logUpstreamRetry({ attempt, retries, status, error, delayMs }, model, routePath) {
  const cause = status
    ? `status=${status}`
    : `error=${error?.name || "Error"}${error?.cause?.code ? `/${error.cause.code}` : ""}`;
  console.error(
    `[codex-router] native upstream retry ${attempt}/${retries} ${cause} ` +
      `model=${model || "unknown"} path=${routePath} delayMs=${delayMs}`,
  );
}

function catalogModels() {
  try {
    const parsed = JSON.parse(readFileSync(CATALOG_PATH, "utf8"));
    return Array.isArray(parsed.models) ? parsed.models : [];
  } catch {
    return [];
  }
}

// Shared across every /health request so a polling companion collapses into
// one probe per service per window instead of three per poll.
const healthCache = createHealthCache();

function serviceHealth(url) {
  return healthCache(url, () => probeService(url));
}

async function probeService(url) {
  try {
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${INTERNAL_KEY}` },
      signal: AbortSignal.timeout(3_000),
    });
    const raw = await response.json().catch(() => undefined);
    const payload = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
    return { ...payload, reachable: response.ok };
  } catch {
    return { reachable: false };
  }
}

async function healthPayload() {
  const enabled = new Set(readProviderSelection());
  const apiEnabled = [...PROVIDERS.values()].some(
    (provider) => enabled.has(provider.id) && provider.kind === "openai-compatible",
  );
  const [oauth, api, gateway] = await Promise.all([
    enabled.has("kimi-oauth")
      ? serviceHealth(OAUTH_HEALTH)
      : { reachable: true, enabled: false },
    apiEnabled ? serviceHealth(API_HEALTH) : { reachable: true, enabled: false },
    serviceHealth(GATEWAY_HEALTH),
  ]);
  return {
    ok: oauth.reachable && api.reachable && gateway.reachable,
    service: "codex-router",
    version: VERSION,
    router: "ready",
    activity: activityPayload(),
    oauth,
    api,
    gateway,
  };
}

function encodeSummary(summary) {
  return COMPACTION_PREFIX + Buffer.from(summary, "utf8").toString("base64");
}

function decodeSummary(value) {
  if (typeof value !== "string" || !value.startsWith(COMPACTION_PREFIX)) return undefined;
  try {
    return Buffer.from(value.slice(COMPACTION_PREFIX.length), "base64").toString("utf8");
  } catch {
    return undefined;
  }
}

function messageItem(text) {
  return {
    type: "message",
    role: "user",
    content: [{ type: "input_text", text }],
  };
}

function normalizeRoutedInput(input) {
  if (!Array.isArray(input)) return input;
  return input
    .filter((item) => item?.type !== "compaction_trigger")
    .map((item) => {
      if (item?.type !== "compaction") return item;
      const summary = decodeSummary(item.encrypted_content);
      return messageItem(
        summary
          ? `${SUMMARY_PREFIX}\n\n${summary}`
          : "[Earlier conversation history was compacted in an unreadable format.]",
      );
    })
    .map((item) => {
      // LiteLLM rejects messages whose text content is empty; Codex emits
      // such filler assistant messages around tool calls. Strip empty text
      // parts, and drop messages that carry nothing at all.
      if (item?.type !== "message" || !Array.isArray(item.content)) return item;
      const content = item.content.filter((part) => {
        if (!part || typeof part !== "object") return true;
        if (
          (part.type === "input_text" ||
            part.type === "output_text" ||
            part.type === "text") &&
          typeof part.text === "string" &&
          part.text.trim() === ""
        ) {
          return false;
        }
        return true;
      });
      return { ...item, content };
    })
    .filter((item) => {
      if (item?.type !== "message") return true;
      if (Array.isArray(item.tool_calls) && item.tool_calls.length > 0) return true;
      if (typeof item.content === "string") return item.content.trim() !== "";
      if (Array.isArray(item.content)) return item.content.length > 0;
      return true;
    });
}

function nativeAgentRelayModel() {
  const configured = String(process.env.MODEL_ROUTER_AGENT_RELAY_MODEL || "").trim();
  if (configured) return configured;
  try {
    const parsed = JSON.parse(readFileSync(NATIVE_CATALOG_PATH, "utf8"));
    const models = Array.isArray(parsed?.models) ? parsed.models : [];
    const preferred = models.find((model) => model?.slug === "gpt-5.6-sol");
    const listed = models.find(
      (model) => typeof model?.slug === "string" && model.visibility === "list",
    );
    const available = models.find((model) => typeof model?.slug === "string");
    return preferred?.slug || listed?.slug || available?.slug || "gpt-5.6-sol";
  } catch {
    return "gpt-5.6-sol";
  }
}

// Every `encrypted_content` value OpenAI issues is a Fernet token: the version
// byte 0x80 followed by a big-endian timestamp whose leading bytes stay zero
// for the rest of the century, which base64url-encodes to the fixed `gAAAAA`
// prefix over the base64url alphabet with no whitespace. This is the whole
// detection predicate -- the plaintext is never inspected.
const NATIVE_ENCRYPTED_TOKEN = /^gAAAAA[A-Za-z0-9_-]+={0,2}$/;

function isNativeEncryptedToken(value) {
  return typeof value === "string" && NATIVE_ENCRYPTED_TOKEN.test(value);
}

function encryptedAgentPayload(item) {
  if (!Array.isArray(item?.content)) return undefined;
  const visibleText = item.content
    .filter(
      (part) =>
        ["input_text", "text"].includes(part?.type) && typeof part.text === "string",
    )
    .map((part) => part.text)
    .join("");
  if (!/Message Type:\s*(?:NEW_TASK|MESSAGE|FOLLOWUP_TASK|FINAL_ANSWER)\b[\s\S]*\nPayload:\s*$/i.test(visibleText)) {
    return undefined;
  }
  const encrypted = item.content.find(
    (part) =>
      part?.type === "encrypted_content" &&
      typeof part.encrypted_content === "string" &&
      part.encrypted_content.length > 0,
  );
  if (!encrypted) return undefined;
  return {
    content: encrypted.encrypted_content,
    native: isNativeEncryptedToken(encrypted.encrypted_content),
  };
}

function parseRelayedAgentPayload(payload) {
  const output = payload?.item
    ? [payload.item]
    : Array.isArray(payload?.output)
      ? payload.output
      : Array.isArray(payload?.response?.output)
        ? payload.response.output
        : [];
  const call = output.find(
    (item) => item?.type === "function_call" && item.name === AGENT_PAYLOAD_RELAY_TOOL,
  );
  if (!call) return undefined;
  return parseRelayedAgentArguments(call.arguments);
}

function parseRelayedAgentArguments(value) {
  try {
    const args = typeof value === "string" ? JSON.parse(value) : value;
    return typeof args?.payload === "string" ? args.payload : undefined;
  } catch {
    return undefined;
  }
}

function parseRelayedAgentPayloadSse(bytes) {
  const events = bytes.toString("utf8").split(/\r?\n\r?\n/);
  const relayItems = new Set();
  let argumentDeltas = "";
  for (const rawEvent of events) {
    const data = rawEvent
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n")
      .trim();
    if (!data || data === "[DONE]") continue;
    try {
      const event = JSON.parse(data);
      if (
        event?.type === "response.output_item.added" &&
        event.item?.type === "function_call" &&
        event.item.name === AGENT_PAYLOAD_RELAY_TOOL
      ) {
        if (event.item.id) relayItems.add(event.item.id);
        if (event.item.call_id) relayItems.add(event.item.call_id);
      }
      const relatedArgumentEvent =
        relayItems.size === 0 ||
        relayItems.has(event?.item_id) ||
        relayItems.has(event?.call_id);
      if (
        event?.type === "response.function_call_arguments.delta" &&
        relatedArgumentEvent &&
        typeof event.delta === "string"
      ) {
        argumentDeltas += event.delta;
      }
      if (
        event?.type === "response.function_call_arguments.done" &&
        relatedArgumentEvent
      ) {
        const completed = parseRelayedAgentArguments(event.arguments);
        if (completed !== undefined) return completed;
      }
      const plaintext = parseRelayedAgentPayload(event);
      if (plaintext !== undefined) return plaintext;
    } catch {
      // Ignore malformed or unrelated events and continue to the completion item.
    }
  }
  const accumulated = parseRelayedAgentArguments(argumentDeltas);
  if (accumulated !== undefined) return accumulated;
  return undefined;
}

function agentPayloadCacheKey(encrypted) {
  return createHash("sha256").update(encrypted).digest("base64url");
}

function cachedAgentPayload(encrypted) {
  const key = agentPayloadCacheKey(encrypted);
  const entry = agentPayloadCache.get(key);
  if (!entry) return undefined;
  if (entry.expiresAt <= Date.now()) {
    agentPayloadCache.delete(key);
    agentPayloadCacheBytes -= entry.bytes;
    return undefined;
  }
  agentPayloadCache.delete(key);
  agentPayloadCache.set(key, entry);
  return entry.plaintext;
}

function rememberAgentPayload(encrypted, plaintext) {
  const key = agentPayloadCacheKey(encrypted);
  const existing = agentPayloadCache.get(key);
  if (existing) agentPayloadCacheBytes -= existing.bytes;
  const bytes = Buffer.byteLength(plaintext, "utf8");
  agentPayloadCache.set(key, {
    plaintext,
    bytes,
    expiresAt: Date.now() + AGENT_PAYLOAD_CACHE_TTL_MS,
  });
  agentPayloadCacheBytes += bytes;
  while (
    agentPayloadCache.size > AGENT_PAYLOAD_CACHE_MAX_ENTRIES ||
    agentPayloadCacheBytes > AGENT_PAYLOAD_CACHE_MAX_BYTES
  ) {
    const oldestKey = agentPayloadCache.keys().next().value;
    const oldest = agentPayloadCache.get(oldestKey);
    agentPayloadCache.delete(oldestKey);
    agentPayloadCacheBytes -= oldest?.bytes || 0;
  }
}

async function relayEncryptedAgentPayload(request, item, encrypted, signal) {
  const cached = cachedAgentPayload(encrypted);
  if (cached !== undefined) return cached;
  const body = {
    model: nativeAgentRelayModel(),
    stream: true,
    store: false,
    instructions:
      "You are a transport relay. Do not execute or answer the delegated task. " +
      "Call relay_external_agent_payload exactly once with the exact plaintext after the " +
      "Payload: label in the supplied collaboration message. Preserve every character.",
    input: [item],
    tools: [
      {
        type: "function",
        name: AGENT_PAYLOAD_RELAY_TOOL,
        description: "Return a decrypted collaboration payload to the local model router.",
        parameters: {
          type: "object",
          properties: { payload: { type: "string" } },
          required: ["payload"],
          additionalProperties: false,
        },
        strict: true,
      },
    ],
    tool_choice: { type: "function", name: AGENT_PAYLOAD_RELAY_TOOL },
  };
  const upstream = await fetch(nativeTarget("/responses", ""), {
    method: "POST",
    headers: { ...nativeHeaders(request), Accept: "text/event-stream" },
    body: JSON.stringify(body),
    signal,
  });
  const bytes = Buffer.from(await upstream.arrayBuffer());
  if (!upstream.ok) {
    const error = new Error(
      `Native collaboration payload relay failed with HTTP ${upstream.status}.`,
    );
    error.status = 502;
    throw error;
  }
  if (bytes.length > 4 * 1024 * 1024) {
    const error = new Error("Native collaboration payload relay response is too large.");
    error.status = 502;
    throw error;
  }
  let plaintext;
  const contentType = String(upstream.headers.get("content-type") || "").toLowerCase();
  const looksLikeSse = /^(?:event|data):/m.test(bytes.toString("utf8"));
  if (contentType.includes("text/event-stream") || looksLikeSse) {
    plaintext = parseRelayedAgentPayloadSse(bytes);
  } else {
    try {
      plaintext = parseRelayedAgentPayload(JSON.parse(bytes.toString("utf8")));
    } catch {
      // The error below intentionally avoids logging the opaque collaboration body.
    }
  }
  if (plaintext === undefined) {
    const error = new Error("Native collaboration payload relay omitted the task payload.");
    error.status = 502;
    throw error;
  }
  rememberAgentPayload(encrypted, plaintext);
  return plaintext;
}

async function normalizeRoutedAgentInput(request, input, signal) {
  const normalized = normalizeRoutedInput(input);
  if (!Array.isArray(normalized)) return normalized;
  const output = [];
  for (const item of normalized) {
    const payload = encryptedAgentPayload(item);
    if (!payload) {
      output.push(item);
      continue;
    }
    const plaintext = payload.native
      ? await relayEncryptedAgentPayload(request, item, payload.content, signal)
      : payload.content;
    output.push({
      ...item,
      content: [
        ...item.content.filter((part) => part?.type !== "encrypted_content"),
        { type: "input_text", text: plaintext },
      ],
    });
  }
  return output;
}

// Which bill a bridged read lands on. A registry engine names its own provider;
// a native engine spends the signed-in ChatGPT plan, which the tray already
// calls `openai`; a local engine spends nothing but electricity.
function visionEngineProvider(engine) {
  if (engine.native) return "openai";
  if (engine.local) return "local";
  return engine.provider || "unknown";
}

// The cache only stops a *finished* read from being bought twice. Codex sends
// concurrent requests, and one turn can carry the same image more than once, so
// two reads of one screenshot were routinely in flight together -- both missing
// the cache because neither had returned yet, and the engine charged twice for
// one transcript. Seen in production: two overlapping reads of a single pasted
// image, three seconds apart. Waiters share the first read's outcome, failure
// included, because retrying an image the engine just refused buys the same
// refusal again.
const visionReadsInFlight = new Map();

// Codex resends the whole conversation every turn, so the same screenshot
// arrives again on every follow-up. Without the hash cache a five-turn
// conversation about one image would buy the same transcript five times.
async function visionEvidenceFor(url, engine, request, effort, question = "", retryDelaysMs) {
  // A native engine is spent on the caller's own ChatGPT session, so it can
  // only be reached with the headers this very request arrived with. The router
  // never stores those.
  const nativeCall = request
    ? { baseUrl: NATIVE_BASE, headers: nativeHeaders(request) }
    : undefined;
  // For a native engine the account is part of the identity of a transcript
  // too. That call is authorized by the caller's live session, and a cache hit
  // skips the call along with every re-check that this session may still spend
  // this model. Landing on an entry takes the identical image bytes, so this is
  // an entitlement boundary rather than a confidentiality one -- but it is
  // still a boundary. Gateway and local engines keep the key they had: neither
  // is scoped to a caller.
  const account = engine.native ? nativeAccountKey(nativeCall?.headers) : "";
  // The effort is part of the identity of a transcript: raising it and pasting
  // the same screenshot again must re-read it, not replay the cheaper pass.
  // The question is part of that identity too -- the same screenshot read for
  // "what is the total?" and for "which rows are overdue?" are different
  // readings -- but the evidence cache keys on the question itself, so folding
  // it into this string as well would only key it twice.
  const key = `${engine.slug}\u0000${effort || "default"}\u0000${account}\u0000${url}`;
  const cached = evidenceCache.get(key, question);
  // A cache hit buys nothing, so it records nothing: the events file is a
  // record of spend, not of calls the router avoided.
  if (cached !== undefined) return cached;
  const readKey = `${key}\u0000${question}`;
  const running = visionReadsInFlight.get(readKey);
  if (running) return running;
  // Deliberately not tied to the caller's AbortSignal. The read is shared, so
  // one client's cancellation would abort a read another live request is
  // waiting on and cost it an image it could have had. `describeImage` bounds
  // itself with its own timeout, and an abandoned read still fills the cache
  // for the retry that usually follows.
  const read = readVisionEvidence({ url, engine, nativeCall, effort, question, key, retryDelaysMs });
  visionReadsInFlight.set(readKey, read);
  try {
    return await read;
  } finally {
    visionReadsInFlight.delete(readKey);
  }
}

// A bridged read is a request the operator never asked for by name, billed to
// whichever engine won the ranking. It rides the same usage-events pipeline
// every routed turn uses, so `usage-events.jsonl` and `control probe` show
// that a vision call happened, against which model, and whether it worked --
// otherwise the very first read on an install that enabled nothing would
// leave no trace at all. Token counts are not available here (`describeImage`
// returns the transcript, not the envelope), so the event carries what it
// honestly has.
async function readVisionEvidence({ url, engine, nativeCall, effort, question, key, retryDelaysMs }) {
  const startedAt = Date.now();
  let status = 0;
  try {
    const text = await describeImage({
      engine,
      imageUrl: url,
      gatewayBase: GATEWAY_BASE,
      headers: routedHeaders(),
      nativeCall,
      effort,
      question,
      ...(retryDelaysMs ? { retryDelaysMs } : {}),
    });
    status = 200;
    return evidenceCache.set(key, question, text);
  } finally {
    recordUsageEvent({
      model: engine.slug,
      provider: visionEngineProvider(engine),
      status,
      durationMs: Date.now() - startedAt,
    });
  }
}

// DeepSeek thinking mode rejects a tool-call turn whose assistant message
// carries no reasoning_content. LiteLLM's Responses->chat translation drops
// `reasoning` input items entirely, so the reasoning text never reaches the
// provider. Replace each reasoning item with a synthetic assistant message
// carrying the reasoning text; LiteLLM merges it into the following
// function_call's assistant message, and the forwarder's replay attaches it as
// `reasoning_content` on the tool-call message. In-place, no-op when there is
// nothing to carry.
function carryReasoningThroughInput(input) {
  if (!Array.isArray(input) || input.length < 2) return;
  for (let i = 0; i < input.length - 1; i += 1) {
    const item = input[i];
    if (item?.type !== "reasoning") continue;
    const text = reasoningItemText(item);
    if (!text) continue;
    const next = input[i + 1];
    // DeepSeek emits reasoning directly before a function_call, or before an
    // empty assistant message that announces the call. Carry the reasoning in
    // both cases; otherwise LiteLLM's Responses->chat translation drops it and
    // the tool-call turn 400s for missing `reasoning_content`.
    const nextIsCall = next?.type === "function_call";
    const nextIsEmptyAssistant =
      next?.type === "message" &&
      next?.role === "assistant" &&
      assistantMessageText(next) === "";
    if (!nextIsCall && !nextIsEmptyAssistant) continue;
    // Replace the reasoning item with an assistant message carrying its text.
    input[i] = {
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text }],
    };
  }
}

// Text of an assistant message item, or "" when it has no readable text.
function assistantMessageText(item) {
  if (!Array.isArray(item?.content)) return "";
  return item.content
    .map((part) => (part && typeof part.text === "string" ? part.text : ""))
    .join("");
}

function reasoningItemText(item) {
  const summary = item.summary;
  if (typeof summary === "string" && summary) return summary;
  if (Array.isArray(summary)) {
    const text = summary
      .map((part) => (part && typeof part.text === "string" ? part.text : undefined))
      .filter(Boolean)
      .join("\n");
    if (text) return text;
  }
  const content = item.content;
  if (typeof content === "string" && content) return content;
  // Some thinking providers (DeepSeek among them) return reasoning with
  // `content` as an array of output_text parts rather than a summary string.
  // Without this, the reasoning never reaches the chat history and the
  // following tool-call turn 400s for missing `reasoning_content`.
  if (Array.isArray(content)) {
    const text = content
      .map((part) => (part && typeof part.text === "string" ? part.text : undefined))
      .filter(Boolean)
      .join("\n");
    if (text) return text;
  }
  return undefined;
}

// Text-only models get their images read by a vision-capable model the
// operator already enabled. Turns without images cost nothing here, and a
// model that reads images itself is never touched.
async function bridgeVisionInput(input, route, request) {
  if (!inputHasImage(input)) return input;
  if (supportsImageInput(route)) return input;
  if (route.visionBridge === false) {
    return stripImages(input, `${route.displayName || route.slug} cannot read images`).input;
  }
  const settings = readVisionBridgeSettings();
  // Nothing below is evaluated unless `resolveVisionEngines` is actually going to
  // rank candidates, which it is not when the bridge is off and not when the
  // engine is pinned to `local`. Both of those used to pay for this list anyway:
  // `selectedConfiguredListedModels()` probes every provider's credential
  // synchronously, spawning `/usr/bin/security` once per provider per keychain
  // service on macOS, and this runs inside the request handler -- so a bridge
  // that was switched off still stalled the event loop for ~250ms on every
  // pasted image, for every other in-flight request as well.
  //
  // The set itself is unchanged. It is still exactly the selected, credentialed,
  // listed models, plus native candidates that need two things at once, neither
  // sufficient alone. The shared helper (`src/vision-engines.mjs`) applies the
  // same auth gate the catalog build and the tray apply -- this path used to
  // read the capture off disk with no gate at all. But every on-disk artifact is
  // reused across a failed probe by design, so a sign-out leaves them naming an
  // engine nothing can call. The caller's live session is the evidence that
  // cannot be stale, so it has to hold too: without one there is no native
  // engine to nominate, and a pin naming one stops resolving on the very next
  // paste rather than at the next catalog rebuild.
  const engines = resolveVisionEngines(
    () => [
      ...selectedConfiguredListedModels(),
      ...(request && hasNativeSession(nativeHeaders(request))
        ? installedNativeVisionEngines({ hidden: readHiddenModels() })
        : []),
    ],
    settings,
  );
  if (!engines.length) {
    // The catalog only advertises image input while an engine resolves, so
    // this is the race where one went away mid-conversation, or a client that
    // attached an image regardless.
    return stripImages(
      input,
      "the router's vision bridge is off or has no enabled vision model to read it with",
    ).input;
  }
  const { effort } = settings;
  let fellBack = 0;
  // Each engine in turn until one reads the image. The first is the operator's
  // choice and answers nearly always; the rest exist so a lapsed session or a
  // provider outage costs a slower read rather than the whole image.
  const readWithAnyEngine = async (url, question) => {
    let lastError;
    for (const [index, engine] of engines.entries()) {
      // Retry the engine only when there is nothing else to try. Waiting out a
      // 250ms + 1s ladder against an endpoint that is down, when a working
      // engine is sitting right behind it, is how a fallback that works turns
      // into a paste that takes half a minute -- measured at 30-52s before this
      // line existed. Another provider beats another attempt.
      const last = index === engines.length - 1;
      try {
        const text = await visionEvidenceFor(
          url,
          engine,
          request,
          effort,
          question,
          last ? undefined : [],
        );
        if (index) fellBack += 1;
        return { text, engineName: engine.displayName || engine.slug };
      } catch (error) {
        lastError = error;
      }
    }
    // Every engine refused, so the turn says what the last one said -- the
    // operator's own engine is named first in the log line above it.
    throw lastError;
  };
  const result = await substituteImages(input, (url, _ordinal, question) =>
    readWithAnyEngine(url, question),
  );
  // Never gated on QUIET, for the same reason the retry line is not: a
  // production LaunchAgent hard-sets `CODEX_ROUTER_QUIET=1`, and this is the
  // one line that says the router spent an engine's quota on a paste nobody
  // named. Silent automatic spending is the failure mode; the log carries a
  // model, an engine, and counts -- never a transcript.
  console.error(
    `[codex-router] vision-bridge model=${route.slug} engine=${engines[0].slug} ` +
      `images=${result.images} described=${result.described} failed=${result.failed}` +
      (fellBack ? ` fellBack=${fellBack}` : ""),
  );
  return result.input;
}

// OpenAI-issued reasoning `encrypted_content` is an opaque token (Fernet-style,
// e.g. "gAAAAAB...") with no whitespace. Some local Responses providers (notably
// Ollama) mimic the reasoning-item shape but fill `encrypted_content` with the
// plain-text reasoning summary. Codex stores those items, and when the
// conversation is later replayed to OpenAI's native Responses API, OpenAI
// rejects the undecryptable blob with "Encrypted content could not be decrypted
// or parsed." Strip the non-opaque value before sending to native; the item's
// `summary` still carries the readable reasoning.
function isOpaqueEncryptedContent(value) {
  return typeof value === "string" && value.length > 0 && !/\s/.test(value);
}

function sanitizeReasoningForNative(item) {
  if (item?.encrypted_content === undefined) return item;
  if (isOpaqueEncryptedContent(item.encrypted_content)) return item;
  const { encrypted_content, ...rest } = item;
  return rest;
}

// The mirror of normalizeRoutedAgentInput. When the parent agent is routed, its
// turn never touches the native backend, so Codex has no opaque ciphertext to
// put in a delegated task and stores the payload as plain text under
// `encrypted_content`. A native child replays that item to OpenAI, which
// rejects the whole request with "Encrypted function output content could not
// be decrypted or decoded" and the subagent dies before returning an answer.
// Inline the payload as ordinary text so the native child can read it.
//
// Codex renders every handoff between agents as an `agent_message`, whose
// content schema accepts only `input_text`, `input_image`, and
// `encrypted_content` -- so `output_text` is not an option, and the readable
// handoff has nowhere else to live. Matching the collaboration envelope covers
// only the four `Message Type:` headers whose visible text ends at `Payload:`;
// any other rendering reached OpenAI unchanged and failed replay and
// `/responses/compact` alike, so the conversation could neither continue nor
// compact. Normalize at the schema level instead.
//
// Classify on the ciphertext format alone (`isNativeEncryptedToken`), never on
// what the plaintext looks like. A value that fails that shape is one the
// native backend would reject anyway, so rewriting it replaces a certain
// failure; a value that passes is forwarded byte-identical. Keying off the
// stored value rather than a router-written sentinel is deliberate: the router
// never authors these items -- Codex does, from the routed model's
// collaboration tool call -- so there is no write site to mark, and a marker
// would in any case abandon the already-broken conversations this recovers.
function normalizeAgentMessageForNative(item) {
  if (item?.type !== "agent_message" || !Array.isArray(item.content)) return item;
  let changed = false;
  const content = item.content.map((part) => {
    if (part?.type !== "encrypted_content") return part;
    const value = part.encrypted_content;
    if (typeof value !== "string" || value.length === 0) return part;
    if (isNativeEncryptedToken(value)) return part;
    changed = true;
    return { type: "input_text", text: value };
  });
  return changed ? { ...item, content } : item;
}

function sanitizeCollaborationForNative(item) {
  const normalized = normalizeAgentMessageForNative(item);
  if (normalized !== item) return normalized;
  // Anything outside an `agent_message` is only rewritten when it carries a
  // recognizable collaboration envelope, which is where the payload belongs.
  const payload = encryptedAgentPayload(item);
  if (!payload || payload.native) return item;
  return {
    ...item,
    content: [
      ...item.content.filter((part) => part?.type !== "encrypted_content"),
      { type: "input_text", text: payload.content },
    ],
  };
}

function normalizeNativeInput(input) {
  if (!Array.isArray(input)) return input;
  return input.map((item) => {
    if (item?.type === "reasoning") return sanitizeReasoningForNative(item);
    if (item?.type !== "compaction") return sanitizeCollaborationForNative(item);
    const summary = decodeSummary(item.encrypted_content);
    return summary === undefined
      ? item
      : messageItem(`${SUMMARY_PREFIX}\n\n${summary}`);
  });
}

function extractUserMessages(input) {
  if (!Array.isArray(input)) return [];
  const messages = [];
  for (const item of input) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    if (item.type !== undefined && item.type !== "message") continue;
    if (item.role !== "user") continue;
    const text = Array.isArray(item.content)
      ? item.content
          .filter((part) =>
            ["input_text", "text"].includes(part?.type) && typeof part.text === "string",
          )
          .map((part) => part.text)
          .join("")
      : typeof item.content === "string"
        ? item.content
        : "";
    if (text.trim()) messages.push(text);
  }
  return messages;
}

// The v1 compact response shape follows Codex's replacement-history contract.
function compactOutput(input, summary) {
  const budget = 80_000;
  const selected = [];
  let remaining = budget;
  const messages = extractUserMessages(input);
  for (let index = messages.length - 1; index >= 0 && remaining > 0; index -= 1) {
    const value = messages[index];
    if (value.length <= remaining) {
      selected.push(value);
      remaining -= value.length;
    } else {
      selected.push(value.slice(value.length - remaining));
      break;
    }
  }
  selected.reverse();
  return [
    ...selected.map(messageItem),
    messageItem(summary.trim() ? `${SUMMARY_PREFIX}\n${summary}` : "(no summary available)"),
  ];
}

function extractResponseText(payload) {
  if (typeof payload?.output_text === "string") return payload.output_text;
  const text = [];
  for (const item of Array.isArray(payload?.output) ? payload.output : []) {
    for (const part of Array.isArray(item?.content) ? item.content : []) {
      if (
        ["output_text", "text"].includes(part?.type) &&
        typeof part.text === "string"
      ) {
        text.push(part.text);
      }
    }
  }
  const chatText = payload?.choices?.[0]?.message?.content;
  if (typeof chatText === "string") text.push(chatText);
  return text.join("\n");
}

async function summarize(request, payload, route, signal) {
  const originalInput = Array.isArray(payload.input) ? payload.input : [];
  // Compaction replays the whole conversation, so any image still in it would
  // reach the text-only model unbridged and fail the compaction rather than
  // the turn. The evidence is already cached from the turn that pasted it.
  //
  // It replays the collaboration items too, so the agent-payload resolution a
  // routed turn performs has to happen here as well -- otherwise a compaction
  // inside a `/goal` or subagent session summarizes opaque payloads. The relay
  // is cached by ciphertext, so a conversation whose turns already resolved
  // costs nothing extra here.
  const normalized = await normalizeRoutedAgentInput(request, originalInput, signal);
  const aged = ageToolResults(normalized, { enabled: toolResultAgingEnabled() });
  const bridged = await bridgeVisionInput(
    aged.input,
    route,
    request,
  );
  const body = {
    ...payload,
    model: route.gatewayModel,
    stream: false,
    // An empty tool list already disables tool use on every forwarder, and
    // xAI rejects tool_choice "none" paired with it, so the field is omitted
    // rather than sent redundantly.
    tools: [],
    input: [...bridged, messageItem(COMPACT_PROMPT)],
  };
  normalizeAutoToolChoice(body, route);
  delete body.previous_response_id;
  delete body.client_metadata;
  // Compaction re-enters the same provider as the routed turn; Fireworks
  // rejects this OpenAI search parameter at that boundary too.
  if (providerForModel(route)?.id === "fireworks") delete body.web_search_options;
  const upstream = await fetch(`${GATEWAY_BASE}/responses`, {
    method: "POST",
    headers: routedHeaders(),
    body: JSON.stringify(body),
    signal,
  });
  const bytes = Buffer.from(await upstream.arrayBuffer());
  if (bytes.length > 32 * 1024 * 1024) {
    return {
      ok: false,
      status: 502,
      payload: { error: { message: "Compact response is too large." } },
      toolResultAging: aged.stats,
    };
  }
  const parsed = JSON.parse(bytes.toString("utf8"));
  // Compaction is a plain non-streaming call, so the usage block (when the
  // provider sends one) is already in hand. `tokenUsageFromPayload` returns
  // undefined when it is absent, and `recordUsageEvent` then omits the token
  // fields entirely rather than metering an invented zero.
  const usage = tokenUsageFromPayload(parsed);
  if (!upstream.ok) {
    return {
      ok: false,
      status: upstream.status,
      payload: parsed,
      usage,
      toolResultAging: aged.stats,
    };
  }
  return {
    ok: true,
    summary: extractResponseText(parsed),
    input: originalInput,
    usage,
    toolResultAging: aged.stats,
  };
}

function compactionSnapshot(model, item, status = "completed") {
  return {
    id: `resp_${randomUUID().replaceAll("-", "")}`,
    object: "response",
    created_at: Math.floor(Date.now() / 1_000),
    status,
    model,
    output: item ? [item] : [],
    usage: null,
  };
}

function writeCompactionSse(response, model, summary) {
  const item = {
    type: "compaction",
    id: `cmp_${randomUUID().replaceAll("-", "")}`,
    encrypted_content: encodeSummary(summary),
  };
  const created = compactionSnapshot(model, undefined, "in_progress");
  const completed = { ...created, status: "completed", output: [item] };
  const events = [
    ["response.created", { response: created }],
    ["response.output_item.done", { output_index: 0, item }],
    ["response.completed", { response: completed }],
  ];
  response.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  events.forEach(([type, data], sequence) => {
    response.write(
      `event: ${type}\ndata: ${JSON.stringify({ type, sequence_number: sequence, ...data })}\n\n`,
    );
  });
  response.end("data: [DONE]\n\n");
}

// Returns what the request path needs to meter and log the compaction, so a
// routed compaction leaves the same telemetry trail as any other routed turn.
async function handleRoutedCompaction(request, response, payload, route, signal, v2) {
  const result = await summarize(request, payload, route, signal);
  if (!result.ok) {
    writeJson(response, result.status, result.payload);
    return {
      status: result.status,
      usage: result.usage,
      toolResultAging: result.toolResultAging,
    };
  }
  if (v2) {
    if (payload.stream === false) {
      const item = {
        type: "compaction",
        id: `cmp_${randomUUID().replaceAll("-", "")}`,
        encrypted_content: encodeSummary(result.summary),
      };
      writeJson(response, 200, compactionSnapshot(payload.model, item));
    } else {
      writeCompactionSse(response, payload.model, result.summary);
    }
    return {
      status: 200,
      usage: result.usage,
      toolResultAging: result.toolResultAging,
    };
  }
  writeJson(response, 200, { output: compactOutput(result.input, result.summary) });
  return {
    status: 200,
    usage: result.usage,
    toolResultAging: result.toolResultAging,
  };
}

async function handleModels(response) {
  const data = catalogModels().map((model) => ({
    id: model.slug,
    object: "model",
    owned_by: MODEL_BY_SLUG.has(model.slug)
      ? providerForModel(MODEL_BY_SLUG.get(model.slug)).ownedBy
      : "openai",
  }));
  writeJson(response, 200, { object: "list", data });
}

function requireCodexTransport(request, response) {
  if (request.headers.origin || request.headers["sec-fetch-site"]) {
    writeJson(response, 403, {
      error: {
        type: "browser_request_rejected",
        message: "Browser-originated requests are not accepted by the local model router.",
      },
    });
    return false;
  }
  const contentType = String(request.headers["content-type"] || "")
    .split(";", 1)[0]
    .trim()
    .toLowerCase();
  if (contentType !== "application/json") {
    writeJson(response, 415, {
      error: {
        type: "unsupported_media_type",
        message: "Codex router requests require Content-Type: application/json.",
      },
    });
    return false;
  }
  return true;
}

async function handleResponses(request, response, requestUrl) {
  const startedAt = Date.now();
  const activity = beginRequestActivity();
  let clientGone = false;
  let requestedModel = "";
  let route;
  let upstreamRetries;
  let upstreamLatencyMs;
  let firstTokenMs;
  let usageTransform;
  let emptyCompletionGuard;
  let retryUsageTransform;
  let retryEmptyCompletionGuard;
  let retryUsage;
  let usage;
  let estimatedInputTokens;
  let toolResultAging;
  let emptyCompletion = false;
  let emptyCompletionRetried = false;
  let guardReleasedForBudget = false;
  let finalStatus;
  let activityStatus;
  let usageRecorded = false;
  try {
    if (!requireCodexTransport(request, response)) return;
    const encoded = await readRequestBody(request);
    const body = decodeBody(encoded, request.headers["content-encoding"]);
    const payload = parseBody(body);
    requestedModel = typeof payload.model === "string" ? payload.model : "";
    let registeredRoute =
      MODEL_BY_SLUG.get(requestedModel) ??
      MODEL_BY_SLUG.get(readNativeAliases()[requestedModel]);
    // An unregistered model on this endpoint is native GPT traffic -- Codex's
    // background agent sessions arrive here hardwired to a native slug no
    // matter which model the user picked. With the redirect opted in, send
    // them to the configured routed model; a target that is unknown or whose
    // provider is hidden leaves the turn native rather than trading a quota
    // failure for a routing error.
    if (!registeredRoute && requestedModel) {
      const redirect = MODEL_BY_SLUG.get(readNativeRedirect());
      if (redirect && readProviderSelection().includes(redirect.provider)) {
        registeredRoute = redirect;
      }
    }
    route = registeredRoute && readProviderSelection().includes(registeredRoute.provider)
      ? registeredRoute
      : undefined;
    if (registeredRoute && !route) {
      writeJson(response, 409, {
        error: {
          type: "provider_not_enabled",
          provider: registeredRoute.provider,
          message: `Provider ${registeredRoute.provider} is hidden. Run ./bin/providers enable ${registeredRoute.provider}.`,
        },
      });
      return;
    }
    // Activity and usage attribute protocol variants to their canonical
    // family so the tray Island and graphs show one provider per subscription.
    activity.setRoute({
      provider: route ? canonicalProviderId(route.provider) : "openai",
      model: route?.slug || requestedModel || undefined,
      ...activityMetadataFromHeaders(request.headers),
    });
    const compactV1 = /\/responses\/compact$/.test(requestUrl.pathname);
    const compactV2 =
      route &&
      Array.isArray(payload.input) &&
      payload.input.at(-1)?.type === "compaction_trigger";

    const controller = new AbortController();
    request.once("aborted", () => {
      clientGone = true;
      controller.abort();
    });
    response.once("close", () => {
      if (!response.writableEnded) {
        clientGone = true;
        controller.abort();
      }
    });

    if (route && (compactV1 || compactV2)) {
      const compaction = await handleRoutedCompaction(
        request,
        response,
        payload,
        route,
        controller.signal,
        compactV2,
      );
      // Compaction used to return here without metering or logging, so neither
      // a successful nor a failed one appeared anywhere in the router's own
      // telemetry. Mirror the ordinary request path exactly.
      recordUsageEvent({
        model: route.slug,
        provider: canonicalProviderId(route.provider),
        status: compaction.status,
        durationMs: Date.now() - startedAt,
        ...compaction.usage,
        ...compaction.toolResultAging,
      });
      usage = compaction.usage;
      finalStatus = compaction.status;
      activityStatus = compaction.status;
      usageRecorded = true;
      if (!QUIET) {
        console.error(
          `[codex-router] model=${requestedModel || "unknown"} provider=${route.provider} status=${compaction.status}`,
        );
      }
      return;
    }

    let target;
    let headers;
    let routedBody;
    let namespacesFlattened = false;
    let flattenedNamespaces = new Map();
    if (route) {
      const normalized = await normalizeRoutedAgentInput(
        request,
        payload.input,
        controller.signal,
      );
      const aged = ageToolResults(normalized, { enabled: toolResultAgingEnabled() });
      toolResultAging = aged.stats;
      const input = await bridgeVisionInput(
        aged.input,
        route,
        request,
      );
      // DeepSeek thinking mode requires the assistant's reasoning to be
      // replayed on tool-call turns, but LiteLLM's Responses->chat translation
      // drops `reasoning` input items entirely. Merge each reasoning summary
      // into the following assistant function_call message's content so the
      // translation carries it; the forwarder then attaches it as
      // `reasoning_content` on the tool-call message.
      carryReasoningThroughInput(input);
      const provider = providerForModel(route);
      // LiteLLM's Responses -> Chat Completions bridge drops namespace tools,
      // which is how the client ships the collaboration runtime, the app
      // toolset (threads, automations, navigation), and every MCP server
      // (node_repl, peekaboo, github, ...). Chat-completions providers need
      // every namespace flattened into ordinary functions; the response
      // transform maps calls back to the client's native namespace shape.
      if (provider?.protocol !== "openai-responses") {
        // Relay the app's full native toolset (threads, automations, app
        // navigation) to the provider. The client registers these tools with
        // deferLoading and executes the calls natively, but only sends a
        // reduced codex_app namespace on routed requests; merge the deferred
        // definitions in so routed models see what native models see. The
        // router never executes these calls -- the app owns thread, automation,
        // and navigation state -- it only relays definitions and results.
        const merged = mergeCodexAppTools(payload.tools);
        if (merged.merged) payload.tools = merged.tools;
        const flattened = flattenNamespaceTools(payload.tools);
        namespacesFlattened = flattened.flattened;
        if (namespacesFlattened) {
          payload.tools = flattened.tools;
          flattenedNamespaces = flattened.namespaces;
        }
      } else {
        // Responses-native providers keep the namespace tools untouched, so
        // nothing is flattened and the payload is left alone. The inventory is
        // still built, because the response transform reads the exact
        // spawn_agent model enum off it to drop an invented or stale optional
        // override before Codex validates the call.
        flattenedNamespaces = flattenNamespaceTools(payload.tools).namespaces;
      }
      let routedInput = input;
      // The stored call history must use the same tool names as the tool
      // list, or the model copies the bare names out of its own transcript.
      if (namespacesFlattened) {
        routedInput = flattenNamespacedHistory(routedInput, flattenedNamespaces);
      }
      const routed = {
        ...payload,
        model: route.gatewayModel,
        input: routedInput,
      };
      normalizeAutoToolChoice(routed, route);
      // Native OpenAI traffic keeps client_metadata; routed providers do not
      // consume it and the strict ones reject the unknown field.
      delete routed.client_metadata;
      // Codex sends reasoning as an object. LiteLLM's Ollama path tests that
      // value for membership of a string set, which raises on a dict and fails
      // the whole turn -- 210 of them here before this was caught. Ollama has
      // no reasoning-effort concept to map it onto anyway, so drop it rather
      // than translate it into something the model never asked for.
      if (provider?.keyless) {
        delete routed.reasoning;
        delete routed.reasoning_effort;
      }
      if (provider?.id === "fireworks") delete routed.web_search_options;
      target = `${GATEWAY_BASE}/responses`;
      headers = routedHeaders();
      routedBody = Buffer.from(JSON.stringify(routed), "utf8");
    } else {
      const native = { ...payload };
      if (Array.isArray(payload.input)) {
        native.input = normalizeNativeInput(payload.input);
        // Native turns leave here as stateless full conversations (the
        // previous_response_id below is stripped), so an old tool result costs
        // its full size on every turn of this path too. Compaction turns are
        // exempt: compactV1 keeps its chaining, and a summary should read the
        // true content rather than a receipt.
        if (!compactV1) {
          const aged = ageToolResults(native.input, {
            enabled: nativeToolResultAgingEnabled(),
          });
          native.input = aged.input;
          toolResultAging = aged.stats;
        }
      }
      if (!compactV1) delete native.previous_response_id;
      if (callerBroughtNoUpstreamCredential(request)) {
        normalizeNativeForSubstitutedCaller(native);
      }
      target = nativeTarget(requestUrl.pathname);
      headers = nativeHeaders(request);
      routedBody = await compressedNativeBody(
        Buffer.from(JSON.stringify(native), "utf8"),
        headers,
      );
    }

    // `routedBody` is a fully materialized Buffer -- plain JSON, or the zstd
    // frame `compressedNativeBody` produced together with the matching
    // `Content-Encoding` header. Both are computed once, above, so every
    // attempt replays the identical bytes under the identical encoding. Nothing
    // here consumes a stream, which is what makes the request replayable at
    // all.
    const { response: upstream, retries } = await fetchWithRetry(
      target,
      {
        method: "POST",
        headers,
        body: routedBody,
        signal: controller.signal,
      },
      {
        // Routed traffic terminates at the local gateway, which has its own
        // error translation and Retry-After handling below; leave it exactly
        // as it was.
        retries: route ? 0 : undefined,
        canRetry: () => nothingRelayed(response),
        onRetry: (event) => logUpstreamRetry(event, requestedModel, requestUrl.pathname),
      },
    );
    upstreamRetries = retries;
    // Time until the upstream chain answered the request. Everything before
    // this is router-side work (body read, normalization, flattening, vision
    // bridge) plus the upstream's own time to produce response headers. For a
    // routed turn that means the full router -> litellm -> api-forwarder ->
    // provider path, so a stall here is the provider's, not the router's.
    upstreamLatencyMs = Date.now() - startedAt;
    // Gateway error bodies leak LiteLLM's internal exception chain, which
    // reads like a router bug. Rewrite them to name the provider that failed.
    // Native traffic passes through untouched: OpenAI errors are already clear.
    if (route && !upstream.ok) {
      const provider = providerForModel(route);
      const retryAfterHeader = upstream.headers.get("retry-after");
      const retryAfterSeconds = Number(retryAfterHeader);
      if (retryAfterHeader) response.setHeader("Retry-After", retryAfterHeader);
      writeJson(
        response,
        upstream.status,
        translateGatewayError({
          status: upstream.status,
          bodyText: await upstream.text(),
          modelName: route.displayName || route.slug,
          providerName: provider?.ownedBy || provider?.displayName || route.provider,
          providerKind: provider?.kind,
          retryAfterSeconds: Number.isFinite(retryAfterSeconds)
            ? retryAfterSeconds
            : undefined,
        }),
      );
      recordUsageEvent({
        model: route.slug,
        provider: canonicalProviderId(route.provider),
        status: upstream.status,
        durationMs: Date.now() - startedAt,
        responseStartMs: upstreamLatencyMs,
        firstTokenMs,
      });
      finalStatus = upstream.status;
      activityStatus = upstream.status;
      usageRecorded = true;
      if (!QUIET) {
        console.error(
          `[codex-router] model=${requestedModel || "unknown"} provider=${route.provider} status=${upstream.status}`,
        );
      }
      return;
    }
    // Native OpenAI responses carry the same `usage` shape as routed ones, so
    // meter both paths; without this, native traffic reports zero tokens.
    //
    // A routed provider that answers a large prompt with `input_tokens: 0` is
    // reporting something that cannot be true, and Codex reads exactly that
    // number to decide when to compact -- opencode's Go endpoint did it for a
    // whole model family and sessions ran past the context window and died
    // (#95). The estimate below is offered only for those responses; the
    // predicate is structural (this request, these bytes, an explicit zero),
    // so it cannot fire on a provider that reports correctly and it disables
    // itself the moment the upstream starts reporting again.
    const upstreamContentType = upstream.headers.get("content-type") || "";
    const createResponsePipeline = (contentType) => {
      const usageObserver = new ResponseUsageTransform(contentType, {
        estimatedInputTokens:
          ZERO_INPUT_ESTIMATE && route
            ? estimateInputTokens(routedBody, { contextWindow: route.contextWindow })
            : undefined,
      });
      const transforms = [usageObserver];
      // Every attempt uses the same normal transform pipeline. In particular,
      // a tool call recovered by the retry must still have its flattened
      // namespace restored before Codex sees it.
      if (route) {
        transforms.push(
          new NamespaceToolCallTransform(flattenedNamespaces, contentType, route.slug),
        );
      }
      const guard =
        route && EMPTY_COMPLETION_RETRY
          ? new EmptyCompletionGuard(contentType)
          : undefined;
      if (guard) transforms.push(guard);
      return { transforms, usageObserver, guard };
    };
    const firstPipeline = createResponsePipeline(upstreamContentType);
    usageTransform = firstPipeline.usageObserver;
    emptyCompletionGuard = firstPipeline.guard;
    const relayOpen = Boolean(emptyCompletionGuard);
    await pipeResponse(upstream, response, HOP_BY_HOP_HEADERS, firstPipeline.transforms, {
      leaveOpen: relayOpen,
    });
    usage = usageTransform?.tokenUsage();
    // Time to the first generated token, which is what an output-tokens-per-
    // second figure has to divide by. `upstreamLatencyMs` stops at the response
    // headers, and on a reasoning model the gap between the two is seconds of
    // silent thinking that would otherwise be charged to the generation rate.
    const firstTokenAt = usageTransform?.firstTokenAt?.();
    if (firstTokenAt !== undefined) firstTokenMs = firstTokenAt - startedAt;
    estimatedInputTokens = usageTransform?.substitutedInputTokens();
    // The `close` listener above sets `clientGone` when the client's socket
    // goes away, but `pipeResponse` can resolve before that event fires: the
    // response socket is already destroyed at that point. Read the state
    // directly as well so a cancel that races the close event still meters 0.
    const clientWalkedAway =
      clientGone || (response.destroyed && !response.writableFinished);
    finalStatus = clientWalkedAway ? 0 : upstream.status;
    emptyCompletion = emptyCompletionGuard?.isEmpty() === true && !clientWalkedAway;
    // The guard releases long turns at its byte/time budget without a verdict.
    // Those turns may have been empty completions the router chose not to
    // retry, which must stay distinguishable from healthy long turns in the
    // meter — otherwise a 40-second reasoning-only empty completion reads as a
    // successful 40-second turn.
    guardReleasedForBudget =
      emptyCompletionGuard?.releasedForBudget() === true && !clientWalkedAway;
    if (emptyCompletion) {
      // The upstream answered 200 with nothing. Retry the identical request
      // once: same bytes, same headers, same signal. The guard discarded the
      // whole first stream, so the retry supplies the only head, response id,
      // sequence space, reasoning, and output the client ever receives.
      emptyCompletionRetried = true;
      let upstream2;
      try {
        const retried = await fetchWithRetry(
          target,
          {
            method: "POST",
            headers,
            body: routedBody,
            signal: controller.signal,
          },
          {
            retries: 0,
            canRetry: () => nothingRelayed(response),
            onRetry: (event) => logUpstreamRetry(event, requestedModel, requestUrl.pathname),
          },
        );
        upstream2 = retried.response;
        upstreamRetries = (upstreamRetries || 0) + retried.retries;
      } catch (error) {
        if (clientGone) throw error;
        console.error(
          `[codex-router] empty-completion retry transport failed model=${requestedModel || "unknown"} provider=${route.provider} error=${error?.name || "Error"}${error?.cause?.code ? `/${error.cause.code}` : ""}`,
        );
        writeEmptyCompletionError(
          response,
          "empty_completion_retry_failed",
          "The model returned an empty completion and the router's retry failed upstream.",
        );
        finalStatus = 502;
      }
      if (upstream2) {
        const preparedRetry = upstream2.body
          ? await prepareEventStreamRetry(upstream2)
          : undefined;
        const compatibleRetry = upstream2.ok && preparedRetry?.response;
        if (!compatibleRetry) {
          const rejectedResponse =
            preparedRetry?.rejectedResponse ?? preparedRetry?.response ?? upstream2;
          retryUsage = await observeRejectedRetryUsage(
            rejectedResponse,
            controller.signal,
          );
          const rejectedClientWalkedAway =
            clientGone || (response.destroyed && !response.writableFinished);
          if (rejectedClientWalkedAway) {
            emptyCompletion = false;
            controller.abort();
            controller.signal.throwIfAborted();
          }
          await rejectedResponse.body?.cancel().catch(() => {});
          writeEmptyCompletionError(
            response,
            upstream2.ok
              ? "empty_completion_retry_protocol_error"
              : "empty_completion_retry_failed",
            upstream2.ok
              ? "The model returned an empty completion and the router's retry returned an incompatible response."
              : "The model returned an empty completion and the router's retry failed upstream.",
          );
          finalStatus = 502;
        } else {
          upstream2 = compatibleRetry;
          clearStagedResponseHead(response);
          const retryContentType = preparedRetry.pipelineContentType;
          const secondPipeline = createResponsePipeline(retryContentType);
          retryUsageTransform = secondPipeline.usageObserver;
          retryEmptyCompletionGuard = secondPipeline.guard;
          await pipeResponse(
            upstream2,
            response,
            HOP_BY_HOP_HEADERS,
            secondPipeline.transforms,
            { leaveOpen: true },
          );
          const retryClientWalkedAway =
            clientGone || (response.destroyed && !response.writableFinished);
          guardReleasedForBudget =
            guardReleasedForBudget ||
            (retryEmptyCompletionGuard?.releasedForBudget() === true &&
              !retryClientWalkedAway);
          if (retryClientWalkedAway) {
            finalStatus = 0;
            if (secondPipeline.guard.hasContent()) emptyCompletion = false;
          } else if (secondPipeline.guard.isEmpty()) {
            writeEmptyCompletionError(
              response,
              "empty_completion",
              "The model returned an empty completion. The router retried once and the completion was empty again.",
            );
            finalStatus = 502;
          } else {
            finalStatus = upstream2.status;
            emptyCompletion = false;
          }
          retryUsage = retryUsageTransform?.tokenUsage();
        }
      }
      // Both attempts were billed, so the meter reports both. A retry that
      // fails before returning a body still preserves the known first-attempt
      // usage instead of dropping it with the transport error.
      usage = mergeTokenUsage(usage, retryUsage ?? retryUsageTransform?.tokenUsage());
      estimatedInputTokens = sumEstimatedInputTokens(
        estimatedInputTokens,
        retryUsageTransform?.substitutedInputTokens(),
      );
    }
    // The classification gate keeps the response open until the selected
    // attempt is known; end exactly that one response once.
    if (relayOpen) await finishResponse(response);
    // `retries` separates "it never failed" from "it failed and the router
    // absorbed it", both of which otherwise record a plain 200;
    // `estimatedInputTokens` separates a count the provider sent from one the
    // router had to invent. Neither is inferable from the rest of the event.
    // A stream that completed, or a client that walked away, both land here:
    // `pipeResponse` resolves for a canceled generation (the response socket
    // is already gone) and only rejects for an upstream that actually failed.
    // A cancel is not a router failure, so it meters as 0 rather than the
    // committed 200 that the client never finished reading.
    recordUsageEvent({
      model: route?.slug || requestedModel,
      provider: route ? canonicalProviderId(route.provider) : "openai",
      status: finalStatus,
      durationMs: Date.now() - startedAt,
      responseStartMs: upstreamLatencyMs,
      firstTokenMs,
      retries: upstreamRetries,
      ...usage,
      estimatedInputTokens,
      ...toolResultAging,
      ...(emptyCompletion ? { emptyCompletion: true } : {}),
      ...(emptyCompletionRetried ? { emptyCompletionRetried: true } : {}),
      ...(guardReleasedForBudget ? { emptyCompletionGuardReleased: true } : {}),
    });
    usageRecorded = true;
    activityStatus = finalStatus;
    if (!QUIET) {
      // The substitution is named in the log line as well as the usage event:
      // a router that quietly invents token counts is its own trap.
      console.error(
        `[codex-router] model=${requestedModel || "unknown"} provider=${route?.provider || "openai"} status=${finalStatus}${
          upstreamRetries ? ` retries=${upstreamRetries}` : ""
        }${estimatedInputTokens ? ` estimated-input-tokens=${estimatedInputTokens}` : ""}${
          toolResultAging?.toolResultBytesSaved
            ? ` aged-tool-results=${toolResultAging.toolResultsAged} saved-tool-bytes=${toolResultAging.toolResultBytesSaved}`
            : ""
        }${
          emptyCompletionRetried ? " empty-completion-retried=true" : ""
        }${emptyCompletion ? " empty-completion=true" : ""}`,
      );
    }
  } catch (error) {
    upstreamLatencyMs ??= Date.now() - startedAt;
    if (retryEmptyCompletionGuard?.hasContent()) emptyCompletion = false;
    if (!clientGone) {
      // A pipeline can fail after either guard has released its held bytes but
      // before the success path samples the accessor. Preserve that verdict in
      // the failure event too.
      guardReleasedForBudget =
        guardReleasedForBudget ||
        emptyCompletionGuard?.releasedForBudget() === true ||
        retryEmptyCompletionGuard?.releasedForBudget() === true;
    }
    if (usageTransform) {
      usage = mergeTokenUsage(
        usageTransform.tokenUsage(),
        retryUsageTransform?.tokenUsage() ?? retryUsage,
      );
      estimatedInputTokens = sumEstimatedInputTokens(
        usageTransform.substitutedInputTokens(),
        retryUsageTransform?.substitutedInputTokens(),
      );
    }
    // A client that walked away (canceled generation, closed stream) is not
    // a router failure; only surface errors the router or upstream produced.
    if (clientGone) {
      // Once the retry has started, a disconnect can make its outcome
      // unknowable. Do not report the first attempt's empty classification as
      // the terminal outcome of a turn the client canceled mid-retry.
      emptyCompletion = false;
      finalStatus = 0;
      activityStatus = 0;
      if (!usageRecorded) {
        recordUsageEvent({
          model: route?.slug || requestedModel,
          provider: route ? canonicalProviderId(route.provider) : "openai",
          status: 0,
          durationMs: Date.now() - startedAt,
          responseStartMs: upstreamLatencyMs,
        firstTokenMs,
          retries: upstreamRetries,
          ...usage,
          estimatedInputTokens,
          ...toolResultAging,
          ...(emptyCompletion ? { emptyCompletion: true } : {}),
          ...(emptyCompletionRetried ? { emptyCompletionRetried: true } : {}),
        });
        usageRecorded = true;
      }
      return;
    }
    // A stream that died after committing its head is a 502 even though the
    // HTTP status can no longer change. Preserve whatever usage transforms had
    // already observed; `streamAborted` distinguishes that partial stream from
    // an ordinary upstream or router failure before a head existed.
    finalStatus = response.headersSent ? 502 : httpErrorStatus(error);
    activityStatus = finalStatus;
    if (!usageRecorded) {
      recordUsageEvent({
        model: route?.slug || requestedModel,
        provider: route ? canonicalProviderId(route.provider) : "openai",
        status: finalStatus,
        durationMs: Date.now() - startedAt,
        responseStartMs: upstreamLatencyMs,
        firstTokenMs,
        retries: upstreamRetries,
        ...usage,
        estimatedInputTokens,
        ...toolResultAging,
        ...(response.headersSent ? { streamAborted: true } : {}),
        ...(emptyCompletion ? { emptyCompletion: true } : {}),
        ...(emptyCompletionRetried ? { emptyCompletionRetried: true } : {}),
        ...(guardReleasedForBudget ? { emptyCompletionGuardReleased: true } : {}),
      });
      usageRecorded = true;
    }
    throw error;
  } finally {
    const status = activityStatus ?? finalStatus ?? response.statusCode;
    activity.finish(status);
    // Timestamped per-request timing for latency diagnosis. Never gated on
    // QUIET: the production LaunchAgent hard-sets CODEX_ROUTER_QUIET=1. A
    // missing provider count is logged as unknown, not zero; an explicit zero
    // remains zero so a real cache miss is distinguishable from absent data.
    console.error(
      `[codex-router] timing at=${new Date().toISOString()} model=${requestedModel || "unknown"} provider=${route?.provider || "openai"} status=${status} total_ms=${Date.now() - startedAt} upstream_ms=${timingMetric(upstreamLatencyMs)} out_tokens=${timingMetric(usage?.outputTokens)} cached_tokens=${timingMetric(usage?.cachedInputTokens)}${
        estimatedInputTokens ? ` est_input=${estimatedInputTokens}` : ""
      }`,
    );
  }
}

async function handleNativeRequest(request, response, requestUrl, defaultModel) {
  const startedAt = Date.now();
  const activity = beginRequestActivity();
  let clientGone = false;
  let requestedModel = defaultModel;
  try {
    if (!requireCodexTransport(request, response)) return;
    const encoded = await readRequestBody(request);
    const body = decodeBody(encoded, request.headers["content-encoding"]);
    const payload = parseBody(body);
    requestedModel =
      typeof payload.model === "string" ? payload.model : defaultModel;
    activity.setRoute({
      provider: "openai",
      model: requestedModel,
      ...activityMetadataFromHeaders(request.headers),
    });

    const controller = new AbortController();
    request.once("aborted", () => {
      clientGone = true;
      controller.abort();
    });
    response.once("close", () => {
      if (!response.writableEnded) {
        clientGone = true;
        controller.abort();
      }
    });

    const headers = nativeHeaders(request);
    // Same replayable-Buffer rule as the turn path: encode once, outside the
    // retry, so every attempt carries identical bytes under identical headers.
    const imageBody = await compressedNativeBody(body, headers);
    const { response: upstream, retries: upstreamRetries } = await fetchWithRetry(
      nativeTarget(requestUrl.pathname, nativeRequestSearch(requestUrl)),
      {
        method: "POST",
        headers,
        body: imageBody,
        signal: controller.signal,
      },
      {
        // Images do not retry. The retryable statuses were chosen to mean "no
        // response was obtained", but that is reasoning rather than something
        // observable from here, and Cloudflare can emit 520 after reaching the
        // origin. On a turn a wrong guess costs a duplicated request; on an
        // image generation it costs the operator a second billed image. The
        // failure this exists to absorb was reported on /v1/responses, so the
        // turn path keeps the benefit and the billed path keeps the old
        // behaviour until a captured 5xx proves it is safe.
        retries: 0,
        canRetry: () => nothingRelayed(response),
        onRetry: (event) => logUpstreamRetry(event, requestedModel, requestUrl.pathname),
      },
    );
    await pipeResponse(upstream, response, HOP_BY_HOP_HEADERS);
    recordUsageEvent({
      model: requestedModel,
      provider: "openai",
      status: upstream.status,
      durationMs: Date.now() - startedAt,
      retries: upstreamRetries,
    });
    if (!QUIET) {
      console.error(
        `[codex-router] model=${requestedModel} provider=openai status=${upstream.status}${upstreamRetries ? ` retries=${upstreamRetries}` : ""}`,
      );
    }
  } catch (error) {
    // A failure with no usage event is invisible to the diagnostic that
    // separates "the upstream failed" from "the request died inside the
    // router" — the distinction #171 turned on. Meter this path the way the
    // turn path does: a departed client as 0, everything else by its status.
    if (clientGone) {
      recordUsageEvent({
        model: requestedModel,
        provider: "openai",
        status: 0,
        durationMs: Date.now() - startedAt,
      });
      activity.finish(0);
      return;
    }
    const status = response.headersSent ? 502 : httpErrorStatus(error);
    recordUsageEvent({
      model: requestedModel,
      provider: "openai",
      status,
      durationMs: Date.now() - startedAt,
      ...(response.headersSent ? { streamAborted: true } : {}),
    });
    activity.finish(status);
    throw error;
  } finally {
    activity.finish(response.statusCode);
  }
}

async function handleRequest(request, response) {
  const requestUrl = new URL(
    request.url || "/",
    `http://${request.headers.host || LISTEN_HOST}`,
  );
  if (request.method === "GET" && requestUrl.pathname === "/health") {
    const health = await healthPayload();
    writeJson(response, health.ok ? 200 : 503, {
      ok: health.ok,
      service: health.service,
      version: health.version,
      activity: health.activity,
    });
    return;
  }

  const route = authenticatedRoute(requestUrl.pathname, CALLER_KEY);
  if (!route) {
    writeJson(response, 401, {
      error: {
        type: "authentication_error",
        message: "This local router endpoint requires its configured caller capability.",
      },
    });
    return;
  }
  requestUrl.pathname = route;

  if (
    request.method === "GET" &&
    ["/health", "/v1/health"].includes(requestUrl.pathname)
  ) {
    const health = await healthPayload();
    writeJson(response, health.ok ? 200 : 503, health);
    return;
  }
  if (request.method === "GET" && ["/models", "/v1/models"].includes(requestUrl.pathname)) {
    await handleModels(response);
    return;
  }
  if (request.method === "OPTIONS") {
    response.writeHead(204);
    response.end();
    return;
  }
  if (
    request.method === "POST" &&
    ["/responses", "/v1/responses", "/responses/compact", "/v1/responses/compact"].includes(
      requestUrl.pathname,
    )
  ) {
    await handleResponses(request, response, requestUrl);
    return;
  }
  if (request.method === "POST" && NATIVE_IMAGE_PATHS.has(requestUrl.pathname)) {
    await handleNativeRequest(request, response, requestUrl, "gpt-image-2");
    return;
  }
  if (request.method === "POST" && NATIVE_SEARCH_PATHS.has(requestUrl.pathname)) {
    await handleNativeRequest(request, response, requestUrl, "web-search");
    return;
  }
  writeJson(response, 404, {
    error: { type: "proxy_route_not_found", message: "Unsupported router route." },
  });
}

const server = http.createServer((request, response) => {
  handleRequest(request, response).catch((error) => {
    const status = httpErrorStatus(error);
    // The bare string this used to log made every mid-stream failure
    // indistinguishable in production, and stopping at the top error was the
    // second half of the same problem: a native connect failure logs
    // `TypeError: fetch failed` with the socket-level code buried on its cause
    // (#171). The whole chain belongs in the log; response bodies never do.
    console.error(`[codex-router] request failed: ${formatErrorChain(error)}`);
    if (!response.headersSent) {
      writeJson(response, status, {
        error: {
          type: "local_router_error",
          message: "The local router could not complete the request.",
        },
      });
    } else {
      // The body is already streaming, so there is no status left to change.
      // Destroying here reset the socket and cost the chunked terminator,
      // which the client reported only as a decode failure.
      endStreamedResponse(response);
    }
  });
});

server.on("upgrade", (_request, socket) => {
  socket.on("error", () => {});
  socket.end(
    "HTTP/1.1 426 Upgrade Required\r\nConnection: close\r\nContent-Length: 0\r\n\r\n",
  );
});
// Without this an 'error' event is unhandled and the process exits silently.
// Under a supervisor that reads as a crash loop with the port never bound and
// nothing in the log saying why, so name the cause and use exit codes a
// supervisor and a human can tell apart.
server.on("error", (error) => {
  if (error?.code === "EADDRINUSE") {
    console.error(
      `[codex-router] cannot listen: ${LISTEN_HOST}:${LISTEN_PORT} is already in use. Another router or an unrelated process holds it; stop that process, then start the service again.`,
    );
    process.exit(98);
  }
  if (error?.code === "EACCES") {
    console.error(
      `[codex-router] cannot listen: permission denied binding ${LISTEN_HOST}:${LISTEN_PORT}.`,
    );
    process.exit(97);
  }
  console.error(
    `[codex-router] server error: ${
      error instanceof Error ? `${error.name}: ${error.message}` : String(error)
    }${error?.code ? ` (${error.code})` : ""}`,
  );
  process.exit(96);
});
// One escaped error here takes native and routed traffic down together, and
// the default crash leaves nothing in the service log but the supervisor's
// exit line — #171 recorded `exited (code=4294967295)` on Windows with no way
// to tell an in-process crash from an external kill. Name the failure and its
// whole cause chain before exiting, and use exit codes distinct from the
// listen-failure ones above so the supervisor's line alone classifies the
// death. The exit itself stays: after an uncaught throw the process state is
// unknowable, and the service manager owns the restart.
process.on("uncaughtException", (error) => {
  console.error(`[codex-router] uncaught exception: ${formatErrorChain(error)}`);
  if (error?.stack) console.error(error.stack);
  process.exit(95);
});
process.on("unhandledRejection", (reason) => {
  console.error(`[codex-router] unhandled rejection: ${formatErrorChain(reason)}`);
  if (reason?.stack) console.error(reason.stack);
  process.exit(94);
});
server.requestTimeout = 0;
applyKeepAliveTimeouts(server);
server.listen(LISTEN_PORT, LISTEN_HOST, () => {
  console.error("[codex-router] listening");
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
