import { readFileSync } from "node:fs";
import http from "node:http";
import { createHash, randomUUID } from "node:crypto";
import {
  brotliDecompressSync,
  gunzipSync,
  inflateSync,
  zstdCompress,
  zstdDecompress,
} from "node:zlib";
import { promisify } from "node:util";

import {
  assertCallerSecret,
  authenticatedRoute,
  callerBaseUrl,
  secretEqual,
} from "./caller-auth.mjs";
import {
  CHECKPOINT_WARNING,
  COMPACTION_PROMPT,
  encodeCheckpoint,
  finalizeCheckpoint,
  isRouterCompactionValue,
  LEGACY_V1_SUMMARY_PREFIX,
  LEGACY_WARNING,
  prepareCompaction,
  renderCheckpoint,
  renderCompactionValue,
} from "./compaction-checkpoint.mjs";
import { handlePanelRequest, isPanelRoute } from "./desktop-panel.mjs";
import { handleGeminiRequest, isGeminiRoute } from "./gemini-surface.mjs";
import { handleCursorRequest, isCursorRoute } from "./cursor-surface.mjs";
import { handleClaudeRequest, isClaudeRoute } from "./claude-surface.mjs";
import { routedClientModels } from "./routed-client-models.mjs";
import {
  applyKeepAliveTimeouts,
  copyResponseHeaders,
  endStreamedResponse,
  finishResponse,
  formatErrorChain,
  HOP_BY_HOP_HEADERS,
  MAX_BUFFERED_RESPONSE_BYTES,
  httpErrorStatus,
  installGracefulShutdown,
  pipeResponse,
  readResponseBody,
  readRequestBody,
  writeEventStreamHead,
  writeJson,
  writeStreamErrorEvent,
  zstdFrameContentSize,
} from "./http-utils.mjs";
import {
  EmptyCompletionGuard,
  EmptyCompletionTerminalGuard,
  isEmptyCompletionPreludeLimitError,
} from "./empty-completion-guard.mjs";
import { itemLifecycleNormalizerTransform } from "./item-lifecycle-normalizer.mjs";
import { reasoningTagStripperTransform } from "./reasoning-tag-stripper.mjs";
import {
  ZaiResponsesCompatTransform,
  zaiResponsesCompatTransform,
} from "./zai-responses-compat.mjs";
import { grokReasoningSummaryCompatTransform } from "./grok-reasoning-summary-compat.mjs";
import { translatedToolMessageCompatTransform } from "./deepseek-tool-message-compat.mjs";
import { exactRouteProbeRequested } from "./exact-route-probe.mjs";
import {
  MERGED_CATALOG_PATH,
  NATIVE_CATALOG_PATH,
  PORTS,
  loopback,
} from "./paths.mjs";
import {
  MODEL_BY_SLUG,
  RUNTIME_PROVIDERS,
  providerForModel,
} from "./model-registry.mjs";
import { createHealthCache } from "./health-cache.mjs";
import { discoveryDisabled } from "./discovery-mode.mjs";
import { readNativeAliases } from "./native-alias.mjs";
import { nativeContextVariantBase } from "./native-context-variants.mjs";
import { readNativeRedirect } from "./native-redirect.mjs";
import {
  executeSearchSidecar,
  SearchSidecarError,
} from "./search-sidecar.mjs";
import { searchSidecarBindingForModel } from "./search-sidecar-state.mjs";
import {
  routedModelPreservesSearchContract,
  routedModelSearchMode,
  searchModePreservesSearchContract,
  stripUnsupportedHostedSearch,
  unsupportedSearchContractError,
} from "./search-capability.mjs";
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
  agentMessagesAsUserMessages,
  bridgeCustomTools,
  downgradeOriginalImageDetail,
  flattenNamespacedHistory,
  flattenNamespaceTools,
  flattenToolChoice,
  flattenToolSearchHistory,
  recoverPreflattenedMcpTools,
  repairToolSchemaRoots,
  strictOpenCodeCompactionInput,
  stripSearchContentTypes,
  ToolSearchHistoryCapacityError,
} from "./namespace-relay.mjs";
import {
  chatProviderToolSurface,
  GROQ_MAX_TOOLS,
  GroqToolLimitError,
  GROQ_TOOL_LIMIT_CODE,
} from "./chat-tool-surface.mjs";
import { collaborationToolAvailable, pendingInterruptTargets } from "./subagent-completion.mjs";
import {
  FAILOVER_BUDGET_MS,
  MAX_FAILOVER_HOPS,
  classifyRoutedFailure,
  clearProviderCooldown,
  providerCooldown,
  rankFailoverCandidates,
  readFailoverSettings,
  recordProviderCooldown,
} from "./model-failover.mjs";
import { cooldownScope } from "./provider-cooldown.mjs";
import { retryAfterSeconds } from "./rate-limit-headers.mjs";
import {
  awaitingSpawnProof,
  recordSpawnFailure,
  recordSpawnObserved,
  spawnProofRevocable,
  subagentProofSnapshot,
} from "./subagent-proofs.mjs";
import { forgetChildSpawn, observeChildTurn } from "./subagent-turns.mjs";
import { subagentEffort } from "./multi-agent-state.mjs";
import {
  rankSubagentCandidates,
  subagentEligibility,
  subagentFallbackPlan,
} from "./subagent-routing.mjs";
import {
  activityMetadataFromHeaders,
  threadIdFromHeaders,
} from "./codex-session-names.mjs";
import { gatewayErrorStatus, translateGatewayError } from "./error-translation.mjs";
import { describeTransportFailure } from "./transport-failure.mjs";
import {
  endpointCapabilityError,
  supportsOpenAIModelEndpoint,
} from "./openai-endpoint-policy.mjs";
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
import {
  nativeSessionHeaders,
  nativeSessionTokenMatches,
} from "./codex-native-session.mjs";
import {
  installStableFetchTransport,
  loopbackProbeFetch,
} from "./fetch-transport.mjs";
import { handleResponsesWebSocketUpgrade } from "./responses-websocket.mjs";
import {
  directResponsesBody,
  directResponsesHeaders,
  directResponsesTarget,
  isDirectResponsesProvider,
} from "./direct-responses-provider.mjs";

installStableFetchTransport();

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
const API_BASE = (
  process.env.CODEX_ROUTER_API_BASE_URL ||
  loopback(PORTS.api, "/v1")
).replace(/\/+$/, "");
const GROK_OAUTH_HEALTH =
  process.env.CODEX_ROUTER_GROK_OAUTH_HEALTH_URL ||
  loopback(PORTS.grokOauth, "/health");
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
function positiveByteLimit(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function safeForwardedRequestId(value) {
  return typeof value === "string" &&
      value.length <= 200 &&
      /^[A-Za-z0-9._:-]+$/.test(value)
    ? value
    : undefined;
}

const EMBEDDINGS_MAX_BODY_BYTES = positiveByteLimit(
  process.env.CODEX_ROUTER_EMBEDDINGS_MAX_BODY_BYTES,
  8 * 1024 * 1024,
);
const EMBEDDINGS_MAX_RESPONSE_BYTES = positiveByteLimit(
  process.env.CODEX_ROUTER_EMBEDDINGS_MAX_RESPONSE_BYTES,
  8 * 1024 * 1024,
);
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
const configuredEmptyCompletionPreludeMs = Number(
  process.env.CODEX_ROUTER_EMPTY_COMPLETION_PRELUDE_MS || 30_000,
);
const EMPTY_COMPLETION_PRELUDE_MS =
  Number.isFinite(configuredEmptyCompletionPreludeMs) &&
  configuredEmptyCompletionPreludeMs >= 0
    ? configuredEmptyCompletionPreludeMs
    : 30_000;
const configuredEmptyCompletionPreludeBytes = Number(
  process.env.CODEX_ROUTER_EMPTY_COMPLETION_PRELUDE_BYTES || 1024 * 1024,
);
const EMPTY_COMPLETION_PRELUDE_BYTES =
  Number.isFinite(configuredEmptyCompletionPreludeBytes) &&
  configuredEmptyCompletionPreludeBytes >= 0
    ? Math.floor(configuredEmptyCompletionPreludeBytes)
    : 1024 * 1024;
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
const configuredActiveRequests = Number(
  process.env.MODEL_ROUTER_MAX_ACTIVE_REQUESTS ||
    process.env.CODEX_ROUTER_MAX_ACTIVE_REQUESTS ||
    64,
);
export const MAX_ACTIVE_REQUESTS =
  Number.isFinite(configuredActiveRequests) && configuredActiveRequests > 0
    ? Math.floor(configuredActiveRequests)
    : 64;
// This bounds only the tray's activity records. It must not cancel an operation
// or release its admission slot: a healthy SSE turn can outlive presentation
// bookkeeping and still retain real buffers and an upstream connection.
const configuredActivityRecordRetentionMs = Number(
  process.env.MODEL_ROUTER_ACTIVITY_RECORD_RETENTION_MS ||
    process.env.CODEX_ROUTER_ACTIVITY_RECORD_RETENTION_MS ||
    15 * 60_000,
);
const ACTIVITY_RECORD_RETENTION_MS =
  Number.isFinite(configuredActivityRecordRetentionMs) &&
  configuredActivityRecordRetentionMs > 0
    ? Math.floor(configuredActivityRecordRetentionMs)
    : 15 * 60_000;
// Execution has its own deliberately conservative deadline. Keeping it
// independent from tray retention prevents a 15-minute accounting cleanup from
// becoming a compatibility-breaking timeout for long reasoning or SSE turns.
const configuredRequestExecutionTimeoutMs = Number(
  process.env.MODEL_ROUTER_REQUEST_EXECUTION_TIMEOUT_MS ||
    process.env.CODEX_ROUTER_REQUEST_EXECUTION_TIMEOUT_MS ||
    24 * 60 * 60_000,
);
const REQUEST_EXECUTION_TIMEOUT_MS =
  Number.isFinite(configuredRequestExecutionTimeoutMs) &&
  configuredRequestExecutionTimeoutMs > 0
    ? Math.floor(configuredRequestExecutionTimeoutMs)
    : 24 * 60 * 60_000;
const NATIVE_IMAGE_PATHS = new Set([
  "/images/edits",
  "/images/generations",
  "/v1/images/edits",
  "/v1/images/generations",
]);
const NATIVE_SEARCH_PATHS = new Set(["/alpha/search", "/v1/alpha/search"]);
const AGENT_PAYLOAD_RELAY_TOOL = "relay_external_agent_payload";
const configuredAgentPayloadCacheTtlMs = Number(
  process.env.MODEL_ROUTER_AGENT_PAYLOAD_CACHE_TTL_MS ||
    process.env.CODEX_ROUTER_AGENT_PAYLOAD_CACHE_TTL_MS ||
    15 * 60 * 1_000,
);
const AGENT_PAYLOAD_CACHE_TTL_MS =
  Number.isFinite(configuredAgentPayloadCacheTtlMs) && configuredAgentPayloadCacheTtlMs > 0
    ? Math.floor(configuredAgentPayloadCacheTtlMs)
    : 15 * 60 * 1_000;
const AGENT_PAYLOAD_CACHE_MAX_BYTES = 8 * 1024 * 1024;
const AGENT_PAYLOAD_CACHE_MAX_ENTRIES = 256;
const agentPayloadCache = new Map();
const agentPayloadCacheInFlight = new Map();
let agentPayloadCacheBytes = 0;
const agentPayloadCacheMetrics = {
  hits: 0,
  misses: 0,
  expirations: 0,
  evictions: 0,
  coalesced: 0,
};

let requestSequence = 0;
const activityRecords = new Map();
const inFlightRequests = new Map();
let lastUsedProvider;
let lastUsedModel;
let lastUsedSessionName;
let errorStatusUntil = 0;

if (!INTERNAL_KEY) throw new Error("CODEX_ROUTER_INTERNAL_KEY is required.");
assertCallerSecret(CALLER_KEY);

function pruneExpiredActivityRecords(now = Date.now()) {
  for (const [requestId, entry] of activityRecords) {
    if (now - (entry?.startedAt ?? 0) > ACTIVITY_RECORD_RETENTION_MS) {
      activityRecords.delete(requestId);
    }
  }
}

function activityPayload() {
  pruneExpiredActivityRecords();
  const active = [...activityRecords.values()].filter(
    (entry) => entry && typeof entry === "object" && entry.provider,
  );
  const latest = active.at(-1);
  const provider = latest?.provider || lastUsedProvider;
  const model = latest?.model || lastUsedModel;
  const sessionName = latest?.sessionName || lastUsedSessionName;
  return {
    state:
      activityRecords.size > 0
        ? "generating"
        : Date.now() < errorStatusUntil
          ? "error"
          : "idle",
    activeCount: activityRecords.size,
    active,
    ...(provider ? { provider } : {}),
    ...(model ? { model } : {}),
    ...(sessionName ? { sessionName } : {}),
  };
}

function resourceLimitsPayload() {
  purgeExpiredAgentPayloads();
  return {
    inFlightRequests: inFlightRequests.size,
    maxActiveRequests: MAX_ACTIVE_REQUESTS,
    activityRecordRetentionMs: ACTIVITY_RECORD_RETENTION_MS,
    requestExecutionTimeoutMs: REQUEST_EXECUTION_TIMEOUT_MS,
    maxDecodedBodyBytes: MAX_DECODED_BODY_BYTES,
    maxBufferedResponseBytes: MAX_BUFFERED_RESPONSE_BYTES,
    agentPayloadCache: {
      entries: agentPayloadCache.size,
      bytes: agentPayloadCacheBytes,
      maxEntries: AGENT_PAYLOAD_CACHE_MAX_ENTRIES,
      maxBytes: AGENT_PAYLOAD_CACHE_MAX_BYTES,
      ttlMs: AGENT_PAYLOAD_CACHE_TTL_MS,
      inFlight: agentPayloadCacheInFlight.size,
      ...agentPayloadCacheMetrics,
    },
  };
}

function beginRequestActivity({ request, response, controller } = {}) {
  pruneExpiredActivityRecords();
  if (inFlightRequests.size >= MAX_ACTIVE_REQUESTS) {
    request?.resume?.();
    const error = new Error(
      `The router is at its active request limit (${MAX_ACTIVE_REQUESTS}).`,
    );
    error.status = 429;
    error.code = "ERR_ROUTER_ACTIVE_REQUEST_LIMIT";
    throw error;
  }
  const requestId = ++requestSequence;
  const startedAt = Date.now();
  let finished = false;
  let deadlineExceeded = false;
  let executionTimer;
  const finish = (status) => {
    if (finished) return;
    finished = true;
    if (executionTimer) clearTimeout(executionTimer);
    activityRecords.delete(requestId);
    inFlightRequests.delete(requestId);
    if (status >= 400) errorStatusUntil = Date.now() + ERROR_STATUS_DURATION_MS;
  };
  const abortAtExecutionDeadline = () => {
    if (finished || deadlineExceeded) return;
    deadlineExceeded = true;
    const error = new Error("Router request exceeded its execution deadline.");
    error.code = "ERR_ROUTER_REQUEST_TIMEOUT";
    error.status = 504;
    controller?.abort(error);
    request?.resume?.();
    // Keep the in-flight entry until the handler has released the upstream,
    // buffers, and usage path. The timer marks the deadline; `finish` releases
    // accounting only after the aborted operation has actually settled.
  };
  executionTimer = setTimeout(
    abortAtExecutionDeadline,
    REQUEST_EXECUTION_TIMEOUT_MS + 1,
  );
  executionTimer.unref?.();
  inFlightRequests.set(requestId, { startedAt });
  activityRecords.set(requestId, { startedAt });
  return {
    setRoute({ provider, model, sessionName, ...metadata } = {}) {
      if (!provider || finished) return;
      // Once presentation bookkeeping expires, later route updates must not
      // resurrect it. The operation remains counted in `inFlightRequests`.
      if (!activityRecords.has(requestId)) return;
      const entry = {
        ...(activityRecords.get(requestId) || {}),
        id: String(requestId),
        provider,
        ...(model ? { model } : {}),
        ...(sessionName ? { sessionName } : {}),
        ...metadata,
        startedAt,
      };
      activityRecords.set(requestId, entry);
      lastUsedProvider = provider;
      if (model) lastUsedModel = model;
      if (sessionName) lastUsedSessionName = sessionName;
    },
    finish,
    deadlineExceeded: () => deadlineExceeded,
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
  "traceparent",
  "tracestate",
  "x-client-request-id",
  "x-codex-beta-features",
  "x-codex-installation-id",
  "x-codex-parent-thread-id",
  "x-codex-turn-metadata",
  "x-codex-turn-state",
  "x-codex-window-id",
  "x-oai-attestation",
  "x-openai-internal-codex-responses-lite",
  "x-openai-subagent",
  "x-responsesapi-include-timing-metrics",
]);

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

// Large Codex turns parse several megabytes of JSON on the event loop. Yield
// first so an already-accepted GET /health can answer instead of sitting
// behind that parse and looking like a dead router to the tray.
async function parseBodyAsync(buffer) {
  await new Promise((resolve) => setImmediate(resolve));
  return parseBody(buffer);
}

function bindClientAbort(request, response, onAbort) {
  const abort = () => onAbort();
  request.once("aborted", abort);
  response.once("close", () => {
    if (!response.writableEnded) abort();
  });
  if (request.aborted || response.destroyed) abort();
}

// Codex zstd-compresses every request body, so this runs on every turn and
// the buffer grows with the conversation. The one-shot synchronous decoder
// inflated it on the event loop, and that path is the one implicated in an
// intermittent native abort on Windows (issue #465: exit 0xC0000409 with no JS
// frame, always at the end of a long session with a large accumulated
// context, always right after a successful turn). It has not been reproduced
// here, so the change is defensive rather than a confirmed fix: the declared
// frame size is checked before any native code runs, and the decoder itself is
// the asynchronous one, which keeps a multi-megabyte inflate off the thread
// that is serving every other request.
const decompressZstd = promisify(zstdDecompress);

async function decodeBody(
  body,
  contentEncoding,
  { maxBytes = MAX_DECODED_BODY_BYTES } = {},
) {
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
      const options = { maxOutputLength: maxBytes };
      if (encoding === "zstd") {
        // A frame that announces an oversize payload gets the same 413 the
        // output cap would produce, reached without handing the native decoder
        // a body it was never going to be allowed to finish.
        const declared = zstdFrameContentSize(decoded);
        if (declared !== undefined && declared > maxBytes) {
          const error = new Error(`Decoded request body exceeds ${maxBytes} bytes.`);
          error.status = 413;
          throw error;
        }
        decoded = await decompressZstd(decoded, options);
      } else if (encoding === "gzip" || encoding === "x-gzip") {
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
        `Decoded request body exceeds ${maxBytes} bytes.`,
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
  if (decoded.length > maxBytes) {
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

function authenticatedDirectV1Route(request, pathname) {
  if (pathname !== "/v1" && !pathname.startsWith("/v1/")) return undefined;
  const presented = bearerToken(request.headers.authorization);
  if (presented === undefined) return undefined;
  if (secretEqual(presented, CALLER_KEY || "") || nativeSessionTokenMatches(presented)) {
    return pathname;
  }
  return undefined;
}

function authenticatedCallerRoute(request, requestUrl) {
  return (
    authenticatedRoute(requestUrl.pathname, CALLER_KEY) ||
    authenticatedDirectV1Route(request, requestUrl.pathname)
  );
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
const NATIVE_STATELESS_REASONING_INCLUDE = "reasoning.encrypted_content";

/**
 * Make a generic Responses request acceptable to the native endpoint.
 *
 * Applied only for a caller whose session this router substituted, so a Codex
 * turn is never rewritten -- Codex sends a compliant request already, and the
 * promise that its traffic is byte-identical is worth more than the tidiness of
 * one shared path.
 */
function normalizeNativeForSubstitutedCaller(payload, { compact = false } = {}) {
  // Ordinary Responses turns on ChatGPT's backend are stateless: `store` must
  // be false, and anything else is a 400. The dedicated compact endpoint has
  // a narrower CompactionInput contract that does not define or send this field.
  // Injecting `store: false` there also makes its referenced `rs_...` items
  // look deliberately unpersisted, so omit the field rather than choosing a
  // persistence policy the compact request never exposed.
  if (compact) {
    delete payload.store;
    // `/responses/compact` has its own narrow request schema. `include` belongs
    // to ordinary Responses creation and must not leak across this boundary if
    // a generic caller reuses its normal request options for compaction.
    delete payload.include;
  } else {
    payload.store = false;
    // The encrypted reasoning payload is the continuation token for a
    // stateless Responses conversation. A caller that expected storage may not
    // have requested it; forcing store=false without also requesting this field
    // leaves only rs_ ids for the next turn, which cannot be retrieved.
    if (payload.include === undefined) {
      payload.include = [NATIVE_STATELESS_REASONING_INCLUDE];
    } else if (
      Array.isArray(payload.include) &&
      !payload.include.includes(NATIVE_STATELESS_REASONING_INCLUDE)
    ) {
      payload.include = [...payload.include, NATIVE_STATELESS_REASONING_INCLUDE];
    }
  }
  for (const key of NATIVE_UNSUPPORTED_PARAMS) delete payload[key];
  return payload;
}

/**
 * Remove the legacy cache-retention shape that GPT-5.6 rejects.
 *
 * Current Codex builds can still emit the old top-level field on a later turn.
 * Omitting it keeps implicit prompt caching active. A caller that already uses
 * `prompt_cache_options` passes through unchanged.
 */
function normalizeNativePromptCacheCompatibility(payload) {
  if (/^gpt-5\.6(?:-|$)/.test(String(payload.model || ""))) {
    delete payload.prompt_cache_retention;
  }
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

function routedSearchCompatibility(payload, route) {
  const searchMode = routedModelSearchMode(route);
  const provider = providerForModel(route);
  const compatiblePayload = provider?.generic !== true || searchMode !== undefined
    ? payload
    : stripUnsupportedHostedSearch(payload, { model: route.slug });
  return { payload: compatiblePayload, searchMode };
}

function inputHasWebSearchHistory(input) {
  return Array.isArray(input) && input.some((item) => item?.type === "web_search_call");
}

function payloadHasHostedSearchIntent(payload) {
  const tools = Array.isArray(payload?.tools) ? payload.tools : [];
  const include = Array.isArray(payload?.include) ? payload.include : [];
  return Boolean(
    payload?.web_search_options !== undefined ||
    tools.some((tool) => ["web_search", "web_search_preview"].includes(tool?.type)) ||
    ["web_search", "web_search_preview"].includes(payload?.tool_choice?.type) ||
    include.some(
      (entry) => typeof entry === "string" && entry.startsWith("web_search_call."),
    )
  );
}

function snapshotRoutedSearch(payload, route) {
  const compatible = routedSearchCompatibility(payload, route);
  payload = compatible.payload;
  return {
    payload,
    searchMode: compatible.searchMode,
    needsSearch: payloadHasHostedSearchIntent(payload),
  };
}

function routedSearchContract(snapshot, input) {
  const hasSearchHistory = inputHasWebSearchHistory(input);
  return {
    needsSearch: snapshot.needsSearch,
    hasSearchHistory,
    requiredMode: snapshot.needsSearch || hasSearchHistory ? snapshot.searchMode : undefined,
  };
}

function assertRoutedSearchContract(route, builtSearchMode, contract) {
  if (
    searchModePreservesSearchContract(builtSearchMode, contract) &&
    routedModelPreservesSearchContract(route, contract)
  ) return;
  throw unsupportedSearchContractError(route?.slug);
}

// The documented Zen Free pair has two different wire contracts: Ox uses Chat
// Completions and Muse Contributor Free uses Responses. Their observed strict
// tool/input limitations do not establish a contract for paid Zen, Go, or any
// other free model, so keep this compatibility boundary exact.
function needsZenFreeToolCompatibility(route) {
  const providerId = providerForModel(route)?.id;
  return (
    (providerId === "opencode-free-responses" &&
      (route.upstreamModel === "muse-spark-1.2-contributor-free" ||
        route.upstreamModel === "muse-spark-1.3-contributor-free"))
  );
}

// Console Go's Responses endpoint is Responses-shaped but implements only the
// ordinary function-tool subset: namespace/custom/deferred-search controls are
// rejected, as are function names over 64 characters. Keep this exact to the
// Go Responses variant; paid Zen and other Responses providers retain their
// native contract until their own upstream proves otherwise.
function needsConsoleGoResponsesToolCompatibility(route) {
  return providerForModel(route)?.id === "opencode-go-responses";
}

function rejectsWebSearchOptions(route) {
  return ["fireworks", "opencode-go"].includes(providerForModel(route)?.id);
}

function needsStrictOpenCodeToolCompatibility(route) {
  return (
    needsZenFreeToolCompatibility(route) ||
    needsConsoleGoResponsesToolCompatibility(route)
  );
}

// Both Muse Contributor Responses routes reject a tool list containing a
// recursive local JSON-Schema reference before the model sees the request.
// Keep the paid Console Go gate model-specific: its other Responses models
// retain recursive schemas until their own endpoint establishes the same
// restriction.
function needsNonRecursiveOpenCodeToolCompatibility(route) {
  const providerId = providerForModel(route)?.id;
  return (
    needsZenFreeToolCompatibility(route) ||
    (providerId === "opencode-go-responses" &&
      route.upstreamModel === "muse-spark-1.2-contributor")
  );
}

// Moonshot accepts only pure `$ref` pointers into `#/$defs/`, and rejects the
// whole request -- not the one tool -- over any other pointer (issue #353) or a
// definition reference carrying sibling keywords. The OAuth and platform-key
// routes are separate products, but their first-party validators share this
// schema flavor. Console Go's Kimi K2.7 Code route has now returned the same
// validator error (#488), so include that exact measured route without
// projecting the behavior onto unrelated OpenCode Go models.
const MOONSHOT_PROVIDER_IDS = new Set(["kimi-oauth", "kimi-api", "kimi-api-cn"]);
const OPENCODE_GO_MOONSHOT_MODELS = new Set(["kimi-k2.7-code"]);

function needsMoonshotSchemaCompatibility(route) {
  const providerId = providerForModel(route)?.id;
  return (
    MOONSHOT_PROVIDER_IDS.has(providerId) ||
    (providerId === "opencode-go" &&
      OPENCODE_GO_MOONSHOT_MODELS.has(route.upstreamModel))
  );
}

function zenFreeCompatibleInput(input, route) {
  if (!needsZenFreeToolCompatibility(route)) return input;
  return downgradeOriginalImageDetail(agentMessagesAsUserMessages(input));
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

async function boundedResponseText(
  upstream,
  maxBytes = MAX_BUFFERED_RESPONSE_BYTES,
  signal,
) {
  try {
    return (await readResponseBody(upstream, { maxBytes, signal })).toString("utf8");
  } catch (error) {
    if (signal?.aborted) throw error;
    return "";
  }
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

// Codex treats a streamed Responses `error` event as terminal, but can keep a
// Grok OAuth turn open while its HTTP client retries a bare gateway 5xx. The
// local Grok gateway has already exhausted its bounded retries by the time this
// branch runs, so a second retry loop in the client only turns a stated outage
// into a stale Working badge. Preserve every other provider's existing HTTP
// contract, plus ordinary JSON errors for non-streaming Grok calls and its
// actionable 4xx responses; only the observed terminal Grok shape crosses the
// Responses SSE boundary this way.
function writeTranslatedGatewayError(
  response,
  status,
  payload,
  { provider, stream = false } = {},
) {
  if (provider === "grok-oauth" && stream && status >= 500) {
    writeEventStreamHead(response);
    writeStreamErrorEvent(response, {
      code: payload?.error?.type || "server_error",
      message: payload?.error?.message || "The routed provider could not complete the request.",
    });
    response.end();
    return;
  }
  writeJson(response, status, payload);
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
const healthCache = createHealthCache({ staleWhileRevalidate: true });

function serviceHealth(url) {
  return healthCache(url, () => probeService(url));
}

async function probeService(url) {
  try {
    // No dispatcher argument: `loopbackProbeFetch` owns one shared probe pool
    // for the process, so this cannot fork a second one.
    const response = await loopbackProbeFetch(url, {
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
  const apiEnabled = [...RUNTIME_PROVIDERS.values()].some(
    (provider) => provider.kind === "openai-compatible" && (
      provider.generic === true || enabled.has(provider.id)
    ),
  );
  const [oauth, api, grokOauth, gateway] = await Promise.all([
    enabled.has("kimi-oauth")
      ? serviceHealth(OAUTH_HEALTH)
      : { reachable: true, enabled: false },
    apiEnabled ? serviceHealth(API_HEALTH) : { reachable: true, enabled: false },
    // The Grok OAuth forwarder is started unconditionally but is only a real
    // dependency for an operator who selected the provider, so it is gated the
    // way the Kimi OAuth forwarder is: an unselected provider reports standby
    // rather than being probed on a port nobody routes through.
    enabled.has("grok-oauth")
      ? serviceHealth(GROK_OAUTH_HEALTH)
      : { reachable: true, enabled: false },
    serviceHealth(GATEWAY_HEALTH),
  ]);
  // Naming the unreachable dependency is the difference between "the router is
  // broken" and "the gateway is restarting". It costs nothing to carry: these
  // are four fixed local service names, so it is safe on the unauthenticated
  // leaf too, which is the only one `waitForRouterHealth` and therefore doctor
  // can read.
  const degraded = [
    ["oauth", oauth],
    ["api", api],
    ["grokOauth", grokOauth],
    ["gateway", gateway],
  ]
    .filter(([, service]) => !service.reachable)
    .map(([name]) => name);
  return {
    ok: degraded.length === 0,
    service: "codex-router",
    version: VERSION,
    router: "ready",
    degraded,
    activity: activityPayload(),
    resources: resourceLimitsPayload(),
    oauth,
    api,
    grokOauth,
    gateway,
  };
}

// Generic providers are enabled by their own explicit descriptor and never
// enter the built-in provider-selection document. The runtime registry
// contains only descriptors whose enabled flag is true, so presence there is
// the generic equivalent of a selected built-in provider. Credential
// readiness remains the API forwarder's boundary, where an unavailable bound
// reference produces the promised 503 instead of being mislabeled as hidden.
function routeProviderEnabled(providerId) {
  const provider = RUNTIME_PROVIDERS.get(providerId);
  return provider?.generic === true || readProviderSelection().includes(providerId);
}

function messageItem(text) {
  return {
    type: "message",
    role: "user",
    content: [{ type: "input_text", text }],
  };
}

function normalizeOrphanAppToolOutput(item) {
  if (
    item?.type !== "function_call_output" ||
    item.namespace !== "codex_app" ||
    typeof item.name !== "string" ||
    !item.name ||
    (typeof item.call_id === "string" && item.call_id) ||
    item.output === undefined
  ) {
    return item;
  }
  // Codex app-server can persist a standalone app-tool result without the
  // originating call. A synthetic call_id would still have no matching call,
  // while strict Responses providers reject the original item outright.
  // Preserve the result as ordinary readable history instead. Scope the
  // recovery to named codex_app outputs so every other malformed tool item
  // continues to fail closed at the provider adapter.
  const output =
    typeof item.output === "string" ? item.output : JSON.stringify(item.output);
  return messageItem(`[Codex app tool result: codex_app.${item.name}]\n${output}`);
}

function normalizeProviderAppToolOutputs(input) {
  if (!Array.isArray(input)) return input;
  return input.map(normalizeOrphanAppToolOutput);
}

function normalizeRoutedInput(input) {
  if (!Array.isArray(input)) return input;
  return input
    .filter((item) => item?.type !== "compaction_trigger")
    .map((item) => {
      if (item?.type !== "compaction") return item;
      return messageItem(renderCompactionValue(item.encrypted_content));
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

function nativeRelayContext(request) {
  const headers = nativeHeaders(request);
  const authorization =
    typeof headers.authorization === "string" ? headers.authorization : "";
  const account = nativeAccountKey(headers);
  // The digest is an in-memory partition key only. It prevents a cache hit or
  // coalesced relay from bypassing the native authorization check for another
  // resolved credential/account pair without retaining either identifier.
  const accountScope = createHash("sha256")
    .update(authorization)
    .update("\0")
    .update(account)
    .digest("base64url");
  return { accountScope, headers };
}

function agentPayloadCacheKey(encrypted, accountScope) {
  return createHash("sha256")
    .update(accountScope)
    .update("\0")
    .update(encrypted)
    .digest("base64url");
}

function evictAgentPayload(key, { expired = false, evicted = false } = {}) {
  const entry = agentPayloadCache.get(key);
  if (!entry) return;
  const bytes = entry.bytes || 0;
  // Drop the retained reference eagerly. JavaScript strings cannot be securely
  // erased, so this is cache eviction and must never be described otherwise.
  entry.plaintext = "";
  entry.bytes = 0;
  agentPayloadCache.delete(key);
  agentPayloadCacheBytes = Math.max(0, agentPayloadCacheBytes - bytes);
  if (expired) agentPayloadCacheMetrics.expirations += 1;
  if (evicted) agentPayloadCacheMetrics.evictions += 1;
}

function purgeExpiredAgentPayloads(now = Date.now()) {
  for (const [key, entry] of agentPayloadCache) {
    if (entry.expiresAt <= now) evictAgentPayload(key, { expired: true });
  }
}

function cachedAgentPayload(key) {
  purgeExpiredAgentPayloads();
  const entry = agentPayloadCache.get(key);
  if (!entry) {
    agentPayloadCacheMetrics.misses += 1;
    return undefined;
  }
  agentPayloadCache.delete(key);
  agentPayloadCache.set(key, entry);
  agentPayloadCacheMetrics.hits += 1;
  return entry.plaintext;
}

function rememberAgentPayload(key, plaintext) {
  purgeExpiredAgentPayloads();
  const existing = agentPayloadCache.get(key);
  if (existing) evictAgentPayload(key);
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
    evictAgentPayload(oldestKey, { evicted: true });
  }
}

const agentPayloadCachePurgeTimer = setInterval(
  () => purgeExpiredAgentPayloads(),
  Math.min(AGENT_PAYLOAD_CACHE_TTL_MS, 60_000),
);
agentPayloadCachePurgeTimer.unref?.();

// Periodically check for native catalog drift (new models in models_cache.json).
// When Codex updates its cache while router is running, detect and republish
// automatically without waiting for user to restart router or run provider commands.
const nativeCatalogDriftCheckTimer = setInterval(
  async () => {
    try {
      const { republishOnNativeDrift } = await import("./native-catalog-drift.mjs");
      await republishOnNativeDrift();
    } catch (error) {
      // Drift check is best-effort; log but don't crash the router
      if (!String(error.message).includes("Native catalog drift detected")) {
        console.error(`[codex-router] Periodic native drift check failed: ${error.message}`);
      }
    }
  },
  5 * 60_000, // Every 5 minutes
);
nativeCatalogDriftCheckTimer.unref?.();

async function relayEncryptedAgentPayloadOnce(
  item,
  cacheKey,
  headers,
  signal,
) {
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
    headers: { ...headers, Accept: "text/event-stream" },
    body: JSON.stringify(body),
    signal,
  });
  const bytes = await readResponseBody(upstream, {
    maxBytes: 4 * 1024 * 1024,
    signal,
  });
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
  rememberAgentPayload(cacheKey, plaintext);
  return plaintext;
}

function relayWaiterAbortReason(signal) {
  if (signal?.reason instanceof Error) return signal.reason;
  const error = new Error("The relay waiter was aborted.");
  error.name = "AbortError";
  return error;
}

function waitForAgentPayloadRelay(pending, signal) {
  pending.waiters += 1;
  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = () => signal?.removeEventListener("abort", onAbort);
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      cleanup();
      callback(value);
    };
    const onAbort = () => finish(reject, relayWaiterAbortReason(signal));
    if (signal?.aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener("abort", onAbort, { once: true });
    pending.promise.then(
      (value) => finish(resolve, value),
      (error) => finish(reject, error),
    );
  }).finally(() => {
    pending.waiters = Math.max(0, pending.waiters - 1);
    if (pending.waiters === 0 && !pending.settled) {
      pending.controller.abort(new Error("Every relay waiter disconnected."));
    }
  });
}

async function relayEncryptedAgentPayload(request, item, encrypted, signal) {
  const { accountScope, headers } = nativeRelayContext(request);
  const key = agentPayloadCacheKey(encrypted, accountScope);
  const cached = cachedAgentPayload(key);
  if (cached !== undefined) return cached;
  const pending = agentPayloadCacheInFlight.get(key);
  if (pending) {
    agentPayloadCacheMetrics.coalesced += 1;
    return waitForAgentPayloadRelay(pending, signal);
  }
  const controller = new AbortController();
  const operation = {
    controller,
    promise: undefined,
    settled: false,
    waiters: 0,
  };
  operation.promise = relayEncryptedAgentPayloadOnce(
    item,
    key,
    headers,
    controller.signal,
  ).finally(() => {
    operation.settled = true;
    if (agentPayloadCacheInFlight.get(key) === operation) {
      agentPayloadCacheInFlight.delete(key);
    }
  });
  // If every waiter disconnects, the shared operation is aborted and may
  // reject after nobody remains to await it. Mark that rejection observed.
  operation.promise.catch(() => {});
  agentPayloadCacheInFlight.set(key, operation);
  return waitForAgentPayloadRelay(operation, signal);
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

// A provider can report account quota exhaustion without a trustworthy reset
// header. Do not invent a provider cooldown in that case, but also do not buy
// the exact same failed image read again on every rapid follow-up turn. This is
// deliberately a short, per-read anti-storm backoff rather than a claim about
// when the provider quota resets. Provider-named reset windows still use the
// durable cooldown store below.
const VISION_FAILURE_BACKOFF_MS = 60_000;
const VISION_FAILURE_CACHE_MAX_ENTRIES = 128;
const visionFailedReads = new Map();

function visionFailureCacheKey(readKey) {
  return createHash("sha256").update(readKey).digest("base64url");
}

function cachedVisionFailure(readKey, now = Date.now()) {
  const cacheKey = visionFailureCacheKey(readKey);
  const cached = visionFailedReads.get(cacheKey);
  if (!cached) return undefined;
  if (cached.expiresAt > now) return cached.error;
  visionFailedReads.delete(cacheKey);
  return undefined;
}

function rememberVisionFailure(readKey, error, now = Date.now()) {
  // A reset-bearing 429 is handled by providerCooldown(), which is broader and
  // more accurate. The negative cache exists only for quota exhaustion where
  // the provider named no usable reset window.
  if (error?.failureKind !== "out_of_usage" || error?.cooldownUntil) return;
  const cacheKey = visionFailureCacheKey(readKey);
  visionFailedReads.delete(cacheKey);
  visionFailedReads.set(cacheKey, { error, expiresAt: now + VISION_FAILURE_BACKOFF_MS });
  while (visionFailedReads.size > VISION_FAILURE_CACHE_MAX_ENTRIES) {
    visionFailedReads.delete(visionFailedReads.keys().next().value);
  }
}

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
  const failed = cachedVisionFailure(readKey);
  if (failed) throw failed;
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
  } catch (error) {
    rememberVisionFailure(readKey, error);
    throw error;
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
  } catch (error) {
    const errorStatus = Number(error?.status);
    if (Number.isFinite(errorStatus)) status = errorStatus;
    const reason =
      error?.failureKind === "out_of_usage"
        ? "out_of_usage"
        : errorStatus === 429 && error?.cooldownUntil
          ? "rate_limited"
          : undefined;
    if (reason && error?.cooldownUntil) {
      recordProviderCooldown(visionEngineProvider(engine), {
        until: error.cooldownUntil,
        reason,
      });
    }
    throw error;
  } finally {
    recordUsageEvent({
      model: engine.slug,
      provider: visionEngineProvider(engine),
      status,
      durationMs: Date.now() - startedAt,
    });
  }
}

// DeepSeek thinking mode rejects a turn whose assistant message carries no
// reasoning_content. LiteLLM's Responses->chat translation drops `reasoning`
// input items entirely (`_transform_responses_api_input_item_to_chat_completion_message`
// returns nothing for an item whose `content` is null, which is the shape
// Codex stores), so the reasoning text never reaches the provider at all.
// Carry each run of reasoning items onto the assistant turn it belongs to, and
// the translation keeps it as that message's content. In-place, no-op when
// there is nothing to carry.
//
// Every assistant turn needs covering, not only the ones that call a tool.
// This used to carry the reasoning solely into a following `function_call` or
// an empty assistant filler, which is the shape of a tool loop -- so a turn
// that answers in prose lost its reasoning, and the provider refused the
// *next* request for a reasoning_content it had never been given. A subagent
// always ends that way, which is why spawning one failed every time and an
// ordinary tool loop did not (#256).
function carryReasoningThroughInput(input, { nativeThinking = false } = {}) {
  if (!Array.isArray(input) || input.length < 2) return;
  for (let index = 0; index < input.length - 1; index += 1) {
    if (input[index]?.type !== "reasoning") continue;
    // One assistant turn can emit several reasoning items in a row, and they
    // all belong to the turn that follows. Carrying only the item nearest the
    // turn dropped everything the model thought before it.
    let end = index;
    const texts = [];
    while (end < input.length && input[end]?.type === "reasoning") {
      const text = reasoningItemText(input[end]);
      if (text) texts.push(text);
      end += 1;
    }
    const text = texts.join("\n");
    const next = input[end];
    // Only the last item of the run is rewritten. The earlier ones stay
    // `reasoning` items, which the translation drops -- their text is already
    // in the joined value, and leaving them in place keeps the array the same
    // length for every other pass over it.
    if (text && next) {
      if (next.type === "function_call" || next.type === "custom_tool_call") {
        input[end - 1] = assistantTextItem(text, nativeThinking);
      } else if (next.type === "message" && next.role === "assistant") {
        // Merged into the assistant message rather than inserted in front of
        // it. A separate message would put two assistant turns back to back,
        // which the same strict chat-completions providers reject outright --
        // and the tool-call branch above ends up merged anyway, because
        // LiteLLM folds a following function_call into the assistant message
        // it already emitted.
        input[end] = mergeAssistantText(next, text, nativeThinking);
      }
    }
    index = end - 1;
  }
}

// A trailing model turn is a destructive rewrite: it discards part of the
// caller's conversation. Only Google's own provider gets that behavior from
// identity. Resellers and custom endpoints must opt in per model after their
// endpoint has proved that it rejects a prefilled model turn.
function requiresTrailingUserTurn(route) {
  const provider = providerForModel(route);
  if (
    provider?.generic !== true &&
    (provider?.id === "gemini-api" || provider?.ownedBy?.toLowerCase?.() === "google")
  ) {
    return true;
  }
  return route?.requiresTrailingUserTurn === true;
}

function assistantTextItem(text, nativeThinking = false) {
  return {
    type: "message",
    role: "assistant",
    content: [{ type: nativeThinking ? "thinking" : "output_text", text }],
  };
}

// The reasoning goes in front of the answer it produced. `content` is an array
// of parts on everything Codex stores, but a bare string is equally legal on
// the Responses API, so both shapes are handled rather than assumed away.
function mergeAssistantText(item, text, nativeThinking = false) {
  const part = { type: nativeThinking ? "thinking" : "output_text", text };
  if (typeof item.content === "string") {
    return {
      ...item,
      content: item.content
        ? [part, { type: "output_text", text: item.content }]
        : [part],
    };
  }
  return {
    ...item,
    content: [part, ...(Array.isArray(item.content) ? item.content : [])],
  };
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
  // A quota exhaustion is account/provider-wide evidence, not a reason to walk
  // every model slug backed by that same account. Keep this set scoped to the
  // current bridge call when the provider did not name a reset window; that
  // avoids duplicate spend without inventing how long the quota will stay
  // empty. A provider-named window is persisted by readVisionEvidence instead.
  const exhaustedProviders = new Set();
  // Each engine in turn until one reads the image. The first is the operator's
  // choice and answers nearly always; the rest exist so a lapsed session or a
  // provider outage costs a slower read rather than the whole image.
  const readWithAnyEngine = async (url, question) => {
    let lastError;
    for (const [index, engine] of engines.entries()) {
      // The same identity the window was recorded under: a separately billed
      // variant shares this account's credential but not its allowance.
      const provider = cooldownScope(visionEngineProvider(engine));
      const cooled = providerCooldown(provider);
      if (cooled || exhaustedProviders.has(provider)) {
        lastError ??= new Error(
          `${engine.displayName || engine.slug} is temporarily unavailable because its provider reported a quota or rate limit`,
        );
        continue;
      }
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
        if (error?.failureKind === "out_of_usage") exhaustedProviders.add(provider);
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

// Credential-bearing callers keep the historical format repair below: they
// can fall back to the native stored-item namespace after an unreadable
// encrypted payload is removed. A substituted caller has no such namespace,
// so its stateless repair must be stricter about provenance. In particular,
// the wire contract calls `encrypted_content` opaque; a token's current shape
// cannot prove which backend issued it.
function isOpaqueEncryptedContent(value) {
  // Preserve the historical direct-credential behavior. The field's wire
  // contract is opaque, so a future valid format must not be discarded merely
  // because it stops using today's Fernet-shaped prefix.
  return typeof value === "string" && value.length > 0 && !/\s/.test(value);
}

function reasoningSummaryText(item) {
  if (!Array.isArray(item?.summary) || item.summary.length === 0) return undefined;
  const canonical = item.summary.every((part) => {
    return (
      part != null &&
      typeof part === "object" &&
      !Array.isArray(part) &&
      Object.keys(part).every((key) => key === "type" || key === "text") &&
      part.type === "summary_text" &&
      typeof part.text === "string"
    );
  });
  if (!canonical) return undefined;
  const text = item.summary.map((part) => part.text).join("");
  return text.length > 0 ? text : undefined;
}

function sanitizeReasoningForNative(item, { stateless = false } = {}) {
  if (item?.encrypted_content === undefined) return stateless ? undefined : item;
  if (stateless) {
    // Translated Responses providers have been observed copying the visible
    // reasoning summary into `encrypted_content`. Exact equality is evidence
    // local to this item that the value is a plaintext echo, not a continuation
    // token. Drop that foreign item rather than asking native storage to resolve
    // its `rs_` id. Preserve every other non-empty opaque value byte-identical:
    // its format is intentionally unspecified and may evolve.
    if (
      typeof item.encrypted_content !== "string" ||
      item.encrypted_content.length === 0
    ) return undefined;
    const summary = reasoningSummaryText(item);
    return summary !== undefined && item.encrypted_content === summary ? undefined : item;
  }
  if (isOpaqueEncryptedContent(item.encrypted_content)) return item;
  const { encrypted_content: _encryptedContent, ...storedItem } = item;
  return storedItem;
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

function normalizeNativeInput(
  input,
  { statelessReasoning = false, dropUnstoredReasoningReferences = false } = {},
) {
  if (!Array.isArray(input)) return input;
  return input.flatMap((item) => {
    if (item?.type === "reasoning") {
      const reasoning = sanitizeReasoningForNative(item, {
        stateless: statelessReasoning,
      });
      return reasoning === undefined ? [] : [reasoning];
    }
    if (
      dropUnstoredReasoningReferences &&
      item?.type === "item_reference" &&
      typeof item.id === "string" &&
      item.id.startsWith("rs_")
    ) {
      // A substituted caller has no native storage namespace to resolve an
      // `rs_` reference against. Full reasoning items with encrypted content
      // remain above; bare references cannot be made stateless and are dropped.
      return [];
    }
    if (item?.type !== "compaction") return [sanitizeCollaborationForNative(item)];
    return [isRouterCompactionValue(item.encrypted_content)
      ? messageItem(renderCompactionValue(item.encrypted_content))
      : item];
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
    if (
      text.trim() &&
      !text.startsWith(CHECKPOINT_WARNING) &&
      !text.startsWith(LEGACY_WARNING) &&
      !text.startsWith(LEGACY_V1_SUMMARY_PREFIX)
    ) {
      messages.push(text);
    }
  }
  return messages;
}

// The v1 compact response shape follows Codex's replacement-history contract.
function compactOutput(input, checkpoint) {
  const budget = 80_000;
  const selected = [];
  let remaining = budget;
  // Older requirements survive through bounded KCR2 evidence, not as stale
  // ordinary messages that can be mistaken for the user's current request.
  const messages = extractUserMessages(input).slice(-2);
  for (let index = messages.length - 1; index >= 0 && remaining > 0; index -= 1) {
    const value = messages[index];
    if (value.length <= remaining) {
      selected.push(value);
      remaining -= value.length;
    } else {
      // A message that does not fit is not replayed as an unmarked fragment
      // that reads like a complete request. It is not lost either: it is
      // retained inside the bounded checkpoint, flagged `truncated`.
      break;
    }
  }
  selected.reverse();
  return [
    ...selected.map(messageItem),
    messageItem(renderCheckpoint(checkpoint)),
  ];
}

// Output item types that are never the model's contract answer. Reasoning is
// a draft the provider exposes separately; the rest are tool traffic. Naming
// what to refuse -- rather than requiring `type === "message"` -- keeps a
// routed provider whose Responses-shaped items omit `type` or carry a vendor
// tag from silently contributing nothing to a compaction.
const NON_ANSWER_OUTPUT_TYPES = new Set([
  "reasoning",
  "function_call",
  "function_call_output",
  "custom_tool_call",
  "custom_tool_call_output",
  "local_shell_call",
  "local_shell_call_output",
  "computer_call",
  "computer_call_output",
  "tool_search_call",
  "tool_search_output",
  "web_search_call",
  "file_search_call",
  "image_generation_call",
  "code_interpreter_call",
  "mcp_call",
  "mcp_list_tools",
  "mcp_approval_request",
  "compaction",
  "compaction_trigger",
]);

function outputItemText(item) {
  const text = [];
  for (const part of Array.isArray(item?.content) ? item.content : []) {
    if (
      ["output_text", "text"].includes(part?.type) &&
      typeof part.text === "string" &&
      part.text.length > 0
    ) {
      text.push(part.text);
    }
  }
  return text;
}

function extractResponseText(payload) {
  if (typeof payload?.output_text === "string" && payload.output_text.length > 0) {
    return payload.output_text;
  }
  const output = Array.isArray(payload?.output) ? payload.output : [];
  // A provider that tags its answer is read strictly, so private reasoning is
  // never mistaken for the final message.
  const tagged = output
    .filter((item) => item?.type === "message")
    .flatMap(outputItemText);
  if (tagged.length > 0) return tagged.join("\n");
  // Otherwise fall back to any item that is not known tool or reasoning
  // traffic, which is the only way a non-standard Responses shim contributes
  // its answer at all.
  const untagged = output
    .filter((item) => !NON_ANSWER_OUTPUT_TYPES.has(item?.type))
    .flatMap(outputItemText);
  if (untagged.length > 0) return untagged.join("\n");
  const chatText = payload?.choices?.[0]?.message?.content;
  return typeof chatText === "string" ? chatText : "";
}

// The models a compaction may be tried on, best first, without sending
// anything. The conversation's own model leads unless it has already said it
// is empty, in which case asking it again only buys the same rejection.
function compactionAttempts(route, aged, searchContract, { allowFailover = true } = {}) {
  if (!allowFailover) return [route];
  const settings = readFailoverSettings();
  if (!settings.enabled) return [route];
  const candidates = rankFailoverCandidates(
    selectedConfiguredListedModels().filter((model) => (
      !readHiddenModels().has(model.slug) &&
      !isDirectResponsesProvider(providerForModel(model))
    )),
    {
      from: route,
      // The transcript being summarized is nearly all of the request, so its
      // serialized size is the honest measure of what a candidate must hold.
      estimatedTokens: estimateInputTokens(JSON.stringify(aged.input ?? [])),
      needsImage: inputHasImage(aged.input),
      needsSearch: searchContract.needsSearch,
      hasSearchHistory: searchContract.hasSearchHistory,
      requiredSearchMode: searchContract.requiredMode,
      // Compaction sends `tools: []`, so no candidate needs the collaboration
      // proof to serve one.
      chain: settings.chain,
    },
  )
    .slice(0, MAX_FAILOVER_HOPS)
    .map((entry) => entry.model);
  if (!candidates.length) return [route];
  return providerCooldown(route.provider) ? candidates : [route, ...candidates];
}

// One compaction attempt against one model. Everything route-dependent lives
// here so a compaction can be moved to another model exactly like an ordinary
// turn -- a compaction that fails ends the session just as hard, because the
// conversation cannot get under its context limit without one.
async function summarizeWith(
  request,
  payload,
  route,
  aged,
  prepared,
  signal,
  { searchContract } = {},
) {
  const compatibleInput = zenFreeCompatibleInput(
    normalizeProviderAppToolOutputs(aged.input),
    route,
  );
  const providerInput = needsConsoleGoResponsesToolCompatibility(route)
    ? strictOpenCodeCompactionInput(compatibleInput, payload.tools, {
        maxNameLength: 64,
      })
    : needsZenFreeToolCompatibility(route)
      ? bridgeCustomTools(
        [],
        compatibleInput,
        new Map(),
      ).input
      : compatibleInput;
  const bridged = await bridgeVisionInput(
    providerInput,
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
    input: [
      ...bridged,
      messageItem(prepared.catalogText),
      messageItem(COMPACTION_PROMPT),
    ],
  };
  delete body.tool_choice;
  normalizeAutoToolChoice(body, route);
  delete body.previous_response_id;
  delete body.client_metadata;
  // Compaction re-enters the same provider as the routed turn. Strict Chat
  // Completions surfaces reject this OpenAI search parameter even though it
  // is unrelated to the compaction body.
  if (rejectsWebSearchOptions(route)) delete body.web_search_options;
  const searchCompatibility = routedSearchCompatibility(body, route);
  const serialized = JSON.stringify(searchCompatibility.payload);
  // Candidate capability may depend on a sidecar credential or binding that
  // changed while image bridging was in flight. Preserve both the mode used
  // to construct this exact body and the live mode at the send boundary: a
  // disappear/reappear cycle must not authorize an already-stripped request.
  if (
    !searchModePreservesSearchContract(searchCompatibility.searchMode, searchContract) ||
    !routedModelPreservesSearchContract(route, searchContract)
  ) {
    return { searchCapabilityChanged: true };
  }
  const upstream = await fetch(`${GATEWAY_BASE}/responses`, {
    method: "POST",
    headers: routedHeaders(),
    body: serialized,
    signal,
  });
  return { upstream, bridged, bytes: Buffer.byteLength(serialized, "utf8") };
}

async function summarize(request, payload, route, signal, { allowFailover = true } = {}) {
  // The conversation's selected route owns the capability contract. Resolve
  // it before normalization so a fallback cannot add back ambient search that
  // the selected model never advertised. Compaction itself sends no tools or
  // tool choice, so discard those turn-only declarations before checking the
  // provider-bound compact shape; an impossible ordinary turn must fail, but
  // an ambient choice that compaction never forwards must not end the session.
  payload = { ...payload, tools: [] };
  delete payload.tool_choice;
  const searchSnapshot = snapshotRoutedSearch(payload, route);
  payload = searchSnapshot.payload;
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
  const searchContract = routedSearchContract(searchSnapshot, normalized);
  // Evidence is extracted before tool-result aging rewrites old output bytes.
  // The summarizer may select source IDs, but only this deterministic pass can
  // decide which source types and machine outcomes enter a kcr2 checkpoint.
  const prepared = prepareCompaction(normalized);
  const agingEnabled = toolResultAgingEnabled();
  const aged = ageToolResults(normalized, {
    enabled: agingEnabled,
    // The client has already decided this conversation needs compaction. Dense
    // RTK-style shaping gives its summarizer more distinct evidence without
    // changing ordinary turns, and every shaped result keeps the exact rerun path.
    denseShaping: agingEnabled,
  });

  // The models this compaction may be moved to, in order, starting with the one
  // the conversation is on. A provider already known to be empty is dropped
  // rather than asked, exactly as on the turn path. Nothing is sent while this
  // list is built.
  const attempts = compactionAttempts(route, aged, searchContract, { allowFailover });
  // Attempts that were sent and rejected, kept so the caller can meter each one.
  const failed = [];
  let last;
  for (let index = 0; index < attempts.length; index += 1) {
    const attemptRoute = attempts[index];
    if (
      !routedModelPreservesSearchContract(attemptRoute, searchContract)
    ) {
      if (attemptRoute === route) throw unsupportedSearchContractError(route.slug);
      logFailover(route, attemptRoute, "compaction/search-capability-changed", "not-sent", "skipped");
      if (index + 1 === attempts.length && !attempts.includes(route)) attempts.push(route);
      continue;
    }
    const sent = await summarizeWith(
      request,
      payload,
      attemptRoute,
      aged,
      prepared,
      signal,
      { searchContract },
    );
    if (sent.searchCapabilityChanged) {
      if (attemptRoute === route) throw unsupportedSearchContractError(route.slug);
      logFailover(route, attemptRoute, "compaction/search-capability-changed", "not-sent", "skipped");
      if (index + 1 === attempts.length && !attempts.includes(route)) attempts.push(route);
      continue;
    }
    let bytes;
    try {
      bytes = await readResponseBody(sent.upstream, {
        maxBytes: 32 * 1024 * 1024,
        signal,
      });
    } catch (error) {
      if (error?.code === "ERR_UPSTREAM_RESPONSE_TOO_LARGE") {
        return {
          ok: false,
          status: 502,
          payload: { error: { message: "Compact response is too large." } },
          toolResultAging: aged.stats,
        };
      }
      throw error;
    }
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
    if (sent.upstream.ok) {
      clearProviderCooldown(attemptRoute.provider);
      const answer = extractResponseText(parsed);
      // finalizeCheckpoint turns empty model output into a structurally valid
      // checkpoint, so an upstream whose answer this router cannot read would
      // otherwise report ok with nothing in it. Say so where an operator sees
      // it rather than shipping a silently empty summary.
      if (!answer.trim() && !QUIET) {
        console.error(
          `[codex-router] compaction read no model text model=${attemptRoute.slug} provider=${canonicalProviderId(attemptRoute.provider)}`,
        );
      }
      return {
        ok: true,
        checkpoint: finalizeCheckpoint(answer, prepared),
        input: originalInput,
        usage,
        toolResultAging: aged.stats,
        route: attemptRoute,
        failed,
        ...(attemptRoute === route ? {} : { failoverFrom: route.slug }),
      };
    }
    // Each attempt that failed was still sent and still billed, so it is
    // metered on its own row exactly as on the turn path -- otherwise a
    // compaction the router rescued would leave no trace of the provider that
    // could not serve it.
    failed.push({ route: attemptRoute, status: sent.upstream.status, usage });
    // The first failure is the one reported if every attempt fails: it came
    // from the model the conversation is actually on, which is the one the
    // operator can do something about.
    last ??= {
      ok: false,
      status: sent.upstream.status,
      payload: parsed,
      usage,
      toolResultAging: aged.stats,
      route: attemptRoute,
    };
    const verdict = classifyRoutedFailure({
      status: sent.upstream.status,
      bodyText: bytes.toString("utf8"),
      retryAfterSeconds: retryAfterSeconds(sent.upstream.headers),
    });
    if (!allowFailover) return { ...last, failed };
    if (!verdict.swap) return { ...last, failed };
    recordProviderCooldown(attemptRoute.provider, verdict);
    if (index + 1 < attempts.length) {
      logFailover(
        attemptRoute,
        attempts[index + 1],
        `compaction/${verdict.reason}`,
        sent.upstream.status,
        "retrying",
      );
    }
  }
  return last && { ...last, failed };
}

function recordCompactionUsage(result, route, startedAt) {
  const servedRoute = result?.route || route;
  const failed = (result?.failed || []).filter((entry) => entry.route !== servedRoute);
  for (const attempt of failed) {
    recordUsageEvent({
      model: attempt.route.slug,
      provider: canonicalProviderId(attempt.route.provider),
      status: attempt.status,
      durationMs: Date.now() - startedAt,
      ...attempt.usage,
    });
  }
  recordUsageEvent({
    model: servedRoute.slug,
    provider: canonicalProviderId(servedRoute.provider),
    status: result?.ok ? 200 : result?.status || 502,
    durationMs: Date.now() - startedAt,
    ...result?.usage,
    ...result?.toolResultAging,
    ...(result?.failoverFrom ? { failoverFrom: result.failoverFrom } : {}),
  });
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

function writeCompactionSse(response, model, checkpoint) {
  const item = {
    type: "compaction",
    id: `cmp_${randomUUID().replaceAll("-", "")}`,
    encrypted_content: encodeCheckpoint(checkpoint),
  };
  const created = compactionSnapshot(model, undefined, "in_progress");
  const completed = { ...created, status: "completed", output: [item] };
  const events = [
    ["response.created", { response: created }],
    ["response.output_item.done", { output_index: 0, item }],
    ["response.completed", { response: completed }],
  ];
  writeEventStreamHead(response);
  events.forEach(([type, data], sequence) => {
    response.write(
      `event: ${type}\ndata: ${JSON.stringify({ type, sequence_number: sequence, ...data })}\n\n`,
    );
  });
  response.end("data: [DONE]\n\n");
}

// Returns what the request path needs to meter and log the compaction, so a
// routed compaction leaves the same telemetry trail as any other routed turn.
async function handleRoutedCompaction(
  request,
  response,
  payload,
  route,
  signal,
  v2,
  { allowFailover = true } = {},
) {
  const result = await summarize(request, payload, route, signal, { allowFailover });
  // A compaction moved to another model is metered against the model that
  // actually produced the summary, the same as any other turn.
  const served = {
    route: result.route,
    // Only the attempts that lost; the winner is metered by the caller.
    failed: (result.failed || []).filter((entry) => entry.route !== result.route),
    ...(result.failoverFrom ? { failoverFrom: result.failoverFrom } : {}),
  };
  if (!result.ok) {
    writeJson(response, result.status, result.payload);
    return {
      status: result.status,
      usage: result.usage,
      toolResultAging: result.toolResultAging,
      ...served,
    };
  }
  if (v2) {
    if (payload.stream === false) {
      const item = {
        type: "compaction",
        id: `cmp_${randomUUID().replaceAll("-", "")}`,
        encrypted_content: encodeCheckpoint(result.checkpoint),
      };
      writeJson(response, 200, compactionSnapshot(payload.model, item));
    } else {
      writeCompactionSse(response, payload.model, result.checkpoint);
    }
    return {
      status: 200,
      usage: result.usage,
      toolResultAging: result.toolResultAging,
      ...served,
    };
  }
  writeJson(response, 200, { output: compactOutput(result.input, result.checkpoint) });
  return {
    status: 200,
    usage: result.usage,
    toolResultAging: result.toolResultAging,
    ...served,
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

// What the Gemini surface will accept a turn for.
//
// Deliberately the catalog the router already serves on `/v1/models`, not the
// narrower set the Gemini settings document was published with. The gate exists
// so a typo cannot fall through to the native path and quietly become a
// ChatGPT-session request; being *stricter* than the published list would
// instead refuse a model the user was legitimately offered, and a native model
// whose session has since expired is better served by the provider's own 401
// than by a 404 that misdescribes why.
function geminiRoutedModels() {
  return catalogModels().map((model) => ({
    slug: String(model.slug),
    displayName: model.display_name || model.displayName || String(model.slug),
    contextWindow: Number.isFinite(model.context_window)
      ? model.context_window
      : model.contextWindow,
  }));
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

// Older releases advertised a locally probed route as experimental and then
// refined that record from `x-openai-subagent` traffic. Keep observing only
// those historical experimental records so upgrades preserve useful evidence,
// but never treat the result as catalog authority: local traffic can neither
// promote nor demote the exact checked-in registry certificate. A 400/422 is
// useful negative application evidence; transient failures prove nothing. A
// clean 200 proves only one HTTP turn completed, not that a delegated task did.

function observeSubagentOutcome(request, route, status, options = {}) {
  if (!route) return;
  try {
    if (!request.headers["x-openai-subagent"]) return;
    const proofs = subagentProofSnapshot();
    if (!spawnProofRevocable(route.slug, proofs)) return;
    const spawnId = threadIdFromHeaders(request.headers);
    const settle = (reason, detail = { status }) => {
      recordSpawnFailure(route.slug, { reason, ...detail });
      forgetChildSpawn(spawnId);
      console.error(
        `[codex-router] legacy subagent evidence rejected: ${route.slug} ${reason}; ` +
          "the route still requires a reviewed repository v2 certificate",
      );
    };
    if (status === 400 || status === 422) {
      settle(
        `child turn rejected with HTTP ${status}` +
          (proofs[route.slug]?.status === "proven"
            ? ", revoking the child role it had already served"
            : ""),
      );
      return;
    }
    if (status !== 200 || options.emptyCompletion) return;
    if (awaitingSpawnProof(route.slug, proofs)) {
      recordSpawnObserved(route.slug, { status });
      console.error(
        `[codex-router] legacy subagent evidence observed: ${route.slug} served one child HTTP turn; ` +
          "this remains diagnostic and is not a repository v2 certificate",
      );
    }
    const spawn = observeChildTurn({
      spawnId,
      slug: route.slug,
      autoCompact: route.autoCompact,
      event: {
        status,
        inputTokens: options.usage?.inputTokens,
        estimatedInputTokens: options.estimatedInputTokens,
        emptyCompletionRetried: options.emptyCompletionRetried,
        progressOnlyRetried: options.progressOnlyRetried === true,
      },
    });
    if (!spawn?.exceeded) return;
    settle(
      `one child spawn ran ${spawn.turns} turns and produced ${spawn.newInputTokens} new input ` +
        `tokens without converging, past the ${spawn.budget}-token ceiling this model's own ` +
        "auto-compact budget sets",
      // Deliberately no `status`: every turn of this spawn answered 200, and
      // recording one of them as the failure would read as a rejection that
      // never happened. The counts are the evidence.
      { turns: spawn.turns, newInputTokens: spawn.newInputTokens },
    );
  } catch {
    // Observation is bookkeeping; it must never fail the turn it watched.
  }
}

// Everything about a routed request that depends on which model is serving it.
//
// Extracted so it can run more than once for a single turn: a turn whose
// provider reports it has no usage left is rebuilt for another model and sent
// again, and that second build has to start from exactly what the first one
// started from. Two things in here would quietly corrupt a second pass if it
// did not.
//
//   - The tool list is rewritten for chat-completions providers (merged,
//     flattened, schema-repaired). `flattenNamespaceTools` only recognizes
//     items of `type: "namespace"`, so a second pass over already-flattened
//     tools returns an *empty* namespace map -- shipping plausible tools with
//     no way to map the model's calls back to the client's namespace shape.
//   - `carryReasoningThroughInput` replaces `reasoning` items in place, so a
//     responses-native second pass would find the reasoning already gone.
//
// Both are avoided the same way: nothing here writes to `payload` or to
// `agedInput`. The tool list is a local, and the input array is copied before
// anything rewrites it.
async function buildRoutedRequest({ request, payload, route, agedInput }) {
  const searchCompatibility = routedSearchCompatibility(payload, route);
  payload = searchCompatibility.payload;
  let namespacesFlattened = false;
  let flattenedNamespaces = new Map();
  const provider = providerForModel(route);
  const chatCompletionsProvider = provider?.protocol !== "openai-responses";
  const consoleGoResponsesCompatibility = needsConsoleGoResponsesToolCompatibility(route);
  const compatibleInput = zenFreeCompatibleInput(
    normalizeProviderAppToolOutputs(agedInput),
    route,
  );
  // Image substitution may spend another provider's quota. Every Groq tool
  // limit that is already knowable from the client request and stored history
  // must fail locally before that work starts; the normal post-bridge pass
  // below runs again so any later transformation cannot bypass the invariant.
  if (provider?.id === "groq" && chatCompletionsProvider) {
    const preflight = chatProviderToolSurface(payload.tools, provider.id, {
      input: compatibleInput,
      toolChoice: payload.tool_choice,
    });
    try {
      flattenToolSearchHistory(
        compatibleInput,
        preflight.tools,
        preflight.namespaces,
        {
          maxTools: GROQ_MAX_TOOLS,
          recoverWithoutRelay: true,
          toolChoice: payload.tool_choice,
        },
      );
    } catch (error) {
      if (!(error instanceof ToolSearchHistoryCapacityError)) throw error;
      throw new GroqToolLimitError({
        clientToolCount: preflight.tools.length,
        expandedToolCount: preflight.tools.length + error.required,
        historyToolCapacity: error.available,
        historyToolCount: error.required,
      });
    }
  }
  const bridged = await bridgeVisionInput(
    compatibleInput,
    route,
    request,
  );
  // `bridgeVisionInput` returns its argument unchanged when there is no image
  // to read, and `carryReasoningThroughInput` writes into the array it is
  // given -- so without this copy the first build would rewrite the shared
  // aged input and a second build would start from the result.
  //
  // Copied only when it *is* an array. `input` is equally legal as a bare
  // string, and spreading one of those produces an array of single characters
  // -- a turn that still reaches the provider, and still reads as a 200,
  // having quietly replaced the prompt with its own letters.
  const input = Array.isArray(bridged) ? [...bridged] : bridged;
  // Thinking chat providers need the assistant's reasoning replayed, but
  // LiteLLM drops Responses `reasoning` input items. Generic providers keep
  // the established visible-content carry used for DeepSeek. GLM's native
  // preserved-thinking contract needs reasoning kept structurally separate so
  // the API forwarder can restore it as `reasoning_content` before Z.ai.
  carryReasoningThroughInput(input, {
    nativeThinking: chatCompletionsProvider && route.requestProfile === "glm-thinking",
  });
  // Models marked requiresTrailingUserTurn reject requests ending with a model
  // turn. Pop trailing assistant messages, reasoning, or subagent outputs.
  if (requiresTrailingUserTurn(route)) {
    while (
      input.length > 0 &&
      (input[input.length - 1]?.role === "assistant" ||
        input[input.length - 1]?.type === "reasoning" ||
        input[input.length - 1]?.type === "function_call" ||
        input[input.length - 1]?.type === "custom_tool_call" ||
        (input[input.length - 1]?.type === "message" &&
          input[input.length - 1]?.role === "assistant"))
    ) {
      input.pop();
    }
  }
  let tools = payload.tools;
  // LiteLLM's Responses -> Chat Completions bridge drops namespace tools, which
  // is how the client ships the collaboration runtime, the app toolset
  // (threads, automations, navigation), and every MCP server (node_repl,
  // peekaboo, github, ...). Chat-completions providers need every namespace
  // flattened into ordinary functions; the response transform maps calls back
  // to the client's native namespace shape.
  if (chatCompletionsProvider) {
    // Relay the app's full native toolset (threads, automations, app
    // navigation) to the provider. The client registers these tools with
    // deferLoading and executes the calls natively, but only sends a reduced
    // codex_app namespace on routed requests; normally merge the deferred
    // definitions in so routed models see what native models see. A provider
    // with a hard tool cap may omit unreferenced injected definitions and add
    // back only those required by stored calls or a forced choice. The router
    // never executes these calls -- the app owns thread, automation, and
    // navigation state -- it only relays definitions and results.
    const flattened = chatProviderToolSurface(tools, provider?.id, {
      input,
      toolChoice: payload.tool_choice,
    });
    namespacesFlattened = flattened.flattened;
    flattenedNamespaces = flattened.namespaces;
    if (namespacesFlattened) {
      tools = flattened.tools;
    }
  } else if (consoleGoResponsesCompatibility) {
    // Console Go exposes a Responses endpoint but rejects the native tool
    // discriminators Codex sends. Translate only its tool boundary; unlike the
    // chat-completions branch, do not inject the deferred codex_app snapshot.
    const flattened = flattenNamespaceTools(tools, { maxNameLength: 64 });
    namespacesFlattened = flattened.flattened;
    flattenedNamespaces = flattened.namespaces;
    tools = flattened.tools;
  } else {
    // Responses-native providers keep the namespace tools untouched, so nothing
    // is flattened and the list is left alone. The inventory is still built,
    // because the response transform reads the exact spawn_agent model enum off
    // it to drop an invented or stale optional override before Codex validates
    // the call.
    flattenedNamespaces = flattenNamespaceTools(tools, {
      bridgeToolSearch: false,
    }).namespaces;
    // Keeping the namespace shape is not the same as keeping a parameter root
    // strict Responses providers may reject. Run the shared root repair on the
    // tools alone without flattening their native representation.
    tools = repairToolSchemaRoots(tools);
  }
  // Recent Codex clients flatten namespace tools before sending them to a
  // custom Responses provider. Their canonical turn metadata is the only
  // request-local source that can distinguish that MCP identity from an
  // ordinary function whose literal name happens to contain `__`.
  if (
    recoverPreflattenedMcpTools(
      tools,
      payload.client_metadata,
      flattenedNamespaces,
    )
  ) {
    namespacesFlattened = true;
  }
  if (needsNonRecursiveOpenCodeToolCompatibility(route)) {
    // Run after namespace flattening so both native children and ordinary
    // function tools are repaired in the exact shape the endpoint validates.
    tools = repairToolSchemaRoots(tools, { nonRecursive: true });
  }
  if (needsStrictOpenCodeToolCompatibility(route)) {
    tools = stripSearchContentTypes(tools);
  }
  if (needsMoonshotSchemaCompatibility(route)) {
    // After the namespace flattening above, so the connector tools Codex ships
    // inside `codex_app` are repaired in the shape Moonshot actually receives.
    tools = repairToolSchemaRoots(tools, { inlineForeignRefs: true });
  }
  let routedInput = input;
  let routedToolChoice = payload.tool_choice;
  if (needsStrictOpenCodeToolCompatibility(route)) {
    const customTools = bridgeCustomTools(
      tools,
      routedInput,
      flattenedNamespaces,
      routedToolChoice,
      undefined,
      consoleGoResponsesCompatibility
        ? { maxNameLength: 64, bridgeAll: true }
        : undefined,
    );
    tools = customTools.tools;
    routedInput = customTools.input;
    routedToolChoice = customTools.toolChoice;
  }
  if (chatCompletionsProvider || consoleGoResponsesCompatibility) {
    let searchHistory;
    try {
      searchHistory = flattenToolSearchHistory(
        routedInput,
        tools,
        flattenedNamespaces,
        provider?.id === "groq"
          ? {
              maxTools: GROQ_MAX_TOOLS,
              recoverWithoutRelay: true,
              toolChoice: routedToolChoice,
            }
          : undefined,
      );
    } catch (error) {
      if (provider?.id !== "groq" || !(error instanceof ToolSearchHistoryCapacityError)) {
        throw error;
      }
      throw new GroqToolLimitError({
        clientToolCount: tools.length,
        expandedToolCount: tools.length + error.required,
        historyToolCapacity: error.available,
        historyToolCount: error.required,
      });
    }
    routedInput = searchHistory.input;
    tools = searchHistory.tools;
    if (
      provider?.id === "groq" &&
      (searchHistory.flattened || flattenedNamespaces.size > 0)
    ) {
      namespacesFlattened = true;
    }
    if (needsNonRecursiveOpenCodeToolCompatibility(route)) {
      // Stored tool-search results can introduce definitions after the first
      // repair pass, so enforce the same boundary on the expanded inventory.
      tools = repairToolSchemaRoots(tools, { nonRecursive: true });
    }
  }
  // The stored call history must use the same tool names as the tool list, or
  // the model copies the bare names out of its own transcript.
  if (namespacesFlattened) {
    routedInput = flattenNamespacedHistory(routedInput, flattenedNamespaces);
    if (provider?.id === "groq") {
      routedToolChoice = flattenToolChoice(
        routedToolChoice,
        flattenedNamespaces,
      );
    }
  }
  if (consoleGoResponsesCompatibility) {
    routedToolChoice = flattenToolChoice(routedToolChoice, flattenedNamespaces);
  }
  const routed = {
    ...payload,
    tools,
    model: route.gatewayModel,
    input: routedInput,
  };
  if (routedToolChoice !== payload.tool_choice) routed.tool_choice = routedToolChoice;
  // Codex chooses a child's model; this is where an operator gets to choose its
  // depth. Applied only to turns Codex marked as a child, so a parent
  // conversation on the same model is untouched -- running one model
  // differently in the two roles is the whole point.
  //
  // The level is deliberately not validated against the model here. A provider
  // that rejects an unsupported effort says so in a way the operator can read,
  // whereas silently dropping the setting looks like the feature never worked.
  const childEffort = request.headers["x-openai-subagent"]
    ? subagentEffort(route.slug)
    : undefined;
  // This leaves on the Responses API, where the effort travels inside
  // `reasoning`. A flat `reasoning_effort` is a Chat Completions field:
  // LiteLLM's Responses bridge derives its own effort from `reasoning` whenever
  // the client sent one -- and Codex always does -- then that derived value
  // overwrites anything flat the router set, so a flat-only override never
  // reaches the provider. Set both: `reasoning.effort` is what actually
  // travels, and the flat field is what a bare chat-completions gateway reads.
  if (childEffort) {
    routed.reasoning_effort = childEffort;
    routed.reasoning = { ...(routed.reasoning || {}), effort: childEffort };
  }
  normalizeAutoToolChoice(routed, route);
  // Native OpenAI traffic keeps client_metadata; routed providers do not
  // consume it and the strict ones reject the unknown field.
  delete routed.client_metadata;
  // Codex sends reasoning as an object. LiteLLM's Ollama path tests that value
  // for membership of a string set, which raises on a dict and fails the whole
  // turn -- 210 of them here before this was caught. Ollama has no
  // reasoning-effort concept to map it onto anyway, so drop it rather than
  // translate it into something the model never asked for.
  if (provider?.keyless) {
    delete routed.reasoning;
    delete routed.reasoning_effort;
  }
  if (rejectsWebSearchOptions(route)) delete routed.web_search_options;
  return {
    body: Buffer.from(JSON.stringify(routed), "utf8"),
    target: `${GATEWAY_BASE}/responses`,
    headers: routedHeaders(),
    // The exact mode used while constructing this body. Failover compares it
    // with the immutable source contract as well as live state immediately
    // before send, so transient sidecar changes cannot validate stale bytes.
    searchMode: searchCompatibility.searchMode,
    namespacesFlattened,
    flattenedNamespaces,
    // Close finished children the parent left Working. Only when the
    // collaboration toolset is actually available on this turn.
    pendingInterrupts: pendingInterruptTargets(
      needsZenFreeToolCompatibility(route) ? agedInput : input,
      {
        namespaces: flattenedNamespaces,
      },
    ),
  };
}

// Normalize once and age from that pristine input for every route that may
// actually serve the turn. Ordinary turns compact only consumed old results;
// the client owns context-pressure detection and whole-history compaction.
async function prepareRoutedRequest({
  request,
  payload,
  route,
  normalizedInput,
  agingEnabled,
}) {
  const aged = ageToolResults(normalizedInput, {
    enabled: agingEnabled,
  });
  const built = await buildRoutedRequest({
    request,
    payload,
    route,
    agedInput: aged.input,
  });
  return {
    ...built,
    agedInput: aged.input,
    toolResultAging: aged.stats,
  };
}

// The models this turn could be moved to, best first. Deliberately computed
// only after a failure is already known: `selectedConfiguredListedModels()`
// probes every provider's credential synchronously and spawns
// `/usr/bin/security` per keychain service on macOS, which would cost every
// healthy turn about 250ms of blocked event loop for nothing.
function failoverCandidates({ route, agedInput, flattenedNamespaces, searchContract, chain }) {
  const hidden = readHiddenModels();
  return rankFailoverCandidates(
    selectedConfiguredListedModels().filter((model) => (
      !hidden.has(model.slug) &&
      !isDirectResponsesProvider(providerForModel(model))
    )),
    {
      from: route,
      // Context fit is checked after rebuilding the request for each
      // destination below. Using this route's body here can reject a candidate
      // whose provider-specific request shape fits that same conversation into
      // its smaller window.
      needsImage: inputHasImage(agedInput),
      // Only a turn that can actually spawn children needs a model that has
      // been through the collaboration proof. A child answering its own turn
      // does not.
      needsMultiAgentV2: collaborationToolAvailable(flattenedNamespaces),
      needsSearch: searchContract.needsSearch,
      hasSearchHistory: searchContract.hasSearchHistory,
      requiredSearchMode: searchContract.requiredMode,
      chain,
    },
  );
}

// Transport failover for a child turn is stricter than the general quota path:
// every destination must be the exact checked-in v2 route Codex was allowed to
// spawn as an agent. Runtime health may remove a route, but it cannot certify
// one or change its provider identity.
function subagentTransportFailoverCandidates({ request, route, agedInput, searchContract, chain }) {
  if (!request.headers["x-openai-subagent"]) return [];
  // The header describes the caller's turn; it is not certification evidence.
  // Require the failed route itself to carry the repository's exact v2 proof
  // before that metadata can select this stricter recovery path.
  if (subagentEligibility(route)) return [];
  const hidden = readHiddenModels();
  let ranked = rankSubagentCandidates(
    selectedConfiguredListedModels().filter((model) => (
      !hidden.has(model.slug) &&
      !isDirectResponsesProvider(providerForModel(model))
    )),
    {
      chain,
      requiredCapabilities: [
        "tools",
        ...(inputHasImage(agedInput) ? ["vision"] : []),
      ],
    },
  );
  ranked = ranked.filter(
    (candidate) => routedModelPreservesSearchContract(candidate.model, searchContract),
  );
  return subagentFallbackPlan(ranked, {
    failureKind: "transport",
    failedTarget: route,
    maxAttempts: MAX_FAILOVER_HOPS,
  })?.attempts || [];
}

function routedRequestFits(route, body) {
  const estimatedTokens = estimateInputTokens(body);
  return (
    !Number.isFinite(estimatedTokens) ||
    !Number.isFinite(route?.contextWindow) ||
    route.contextWindow >= estimatedTokens
  );
}

function candidateBuildCompatibilityCode(error) {
  if (error?.code === "model_search_not_supported") return error.code;
  if (error?.code === GROQ_TOOL_LIMIT_CODE && error?.provider === "groq") return error.code;
  return undefined;
}

// `status` is always what the *asked-for* model said; `outcome` is what the
// candidate did about it. Reporting one number for both was actively
// misleading: a hop rejected with its own 400 printed
// `reason=out_of_usage status=400`, which reads as the exhausted provider
// having answered 400 and sent a reader looking for a quota bug that was not
// there. They are two different events and now say so.
//
// Never gated on CODEX_ROUTER_QUIET, which a production LaunchAgent hard-sets.
// A silent swap makes an exhausted provider look healthy and leaves the
// operator wondering why the answers changed character.
function logFailover(from, to, reason, status, outcome) {
  console.error(
    `[codex-router] failover model=${from.slug} status=${status} reason=${reason} -> ${
      to ? to.slug : "none"
    } outcome=${outcome}`,
  );
}

// Moves a turn whose provider reported it has no usage left onto another model.
//
// Legal only because nothing has been relayed: this runs before `pipeResponse`,
// and `nothingRelayed` is re-checked before every hop. Returns the state the
// caller should switch to, or undefined to keep the original failure -- which
// is the honest answer whenever no candidate can serve this conversation.
async function attemptModelFailover({
  request,
  response,
  payload,
  route,
  agedInput,
  flattenedNamespaces,
  verdict,
  status,
  signal,
  normalizedInput,
  agingEnabled,
  searchContract,
}) {
  const settings = readFailoverSettings();
  if (!settings.enabled) return undefined;
  const transportFallback = verdict.reason === "transport";
  const candidates = transportFallback
    ? subagentTransportFailoverCandidates({
        request,
        route,
        agedInput,
        searchContract,
        chain: settings.chain,
      })
    : failoverCandidates({
        route,
        agedInput,
        flattenedNamespaces,
        searchContract,
        chain: settings.chain,
      }).slice(0, MAX_FAILOVER_HOPS);
  if (!candidates.length) {
    logFailover(route, undefined, verdict.reason, status, "no-candidate");
    return undefined;
  }
  const startedAt = Date.now();
  for (const { model } of candidates) {
    // The caller left, or something has been relayed since the last check.
    // Either way this turn is over: a hop would be work for nobody, or a second
    // response grafted onto a stream the client is already reading.
    if (signal.aborted || !nothingRelayed(response)) return undefined;
    // A turn that has already spent this long recovering is better off
    // reporting the failure it started with than spending more of the user's
    // time on another guess.
    if (Date.now() - startedAt >= FAILOVER_BUDGET_MS) break;
    let built;
    let upstream;
    try {
      built = await prepareRoutedRequest({
        request,
        payload,
        route: model,
        normalizedInput,
        agingEnabled,
      });
      if (!routedRequestFits(model, built.body)) {
        logFailover(route, model, verdict.reason, status, "context-too-small");
        continue;
      }
      if (
        !searchModePreservesSearchContract(built.searchMode, searchContract) ||
        !routedModelPreservesSearchContract(model, searchContract)
      ) {
        logFailover(route, model, verdict.reason, status, "search-capability-changed");
        continue;
      }
      upstream = await fetch(built.target, {
        method: "POST",
        headers: built.headers,
        body: built.body,
        signal,
      });
    } catch (error) {
      if (signal.aborted) throw error;
      const compatibilityCode = candidateBuildCompatibilityCode(error);
      logFailover(
        route,
        model,
        verdict.reason,
        status,
        compatibilityCode
          ? `compatibility/${compatibilityCode}`
          : `transport/${error?.name || "Error"}`,
      );
      continue;
    }
    if (upstream.ok) {
      logFailover(route, model, verdict.reason, status, upstream.status);
      return { route: model, built, upstream };
    }
    // The candidate failed too. If it failed the same way, believe it and take
    // it out of the running for the next turn as well; anything else is that
    // model's own problem and not evidence about the operator's chosen one.
    const hopBodyText = await boundedResponseText(
      upstream,
      MAX_BUFFERED_RESPONSE_BYTES,
      signal,
    );
    const hopVerdict = classifyRoutedFailure({
      status: upstream.status,
      bodyText: hopBodyText,
      retryAfterSeconds: retryAfterSeconds(upstream.headers),
    });
    // A transport retry stops as soon as another provider gives any real HTTP
    // answer. Walking onward would turn an application failure into a silent
    // cross-provider retry, outside the authority this path was given.
    if (transportFallback && hopVerdict.reason !== "transport") {
      logFailover(route, model, verdict.reason, status, upstream.status);
      return { route: model, built, upstream, failedBodyText: hopBodyText };
    }
    if (hopVerdict.swap) recordProviderCooldown(model.provider, hopVerdict);
    logFailover(route, model, verdict.reason, status, upstream.status);
  }
  return undefined;
}

// The local answer an idle install gives instead of native forwarding. With
// discovery disabled the native path is impossible by construction -- the
// session fallback never reads auth.json -- so traffic that would leave for
// chatgpt.com is refused before any upstream fetch, keeping the --no-discovery
// promise that nothing leaves this machine.
function writeIdleNoProviderError(response) {
  writeJson(response, 503, {
    error: {
      type: "router_idle_no_provider",
      message:
        "This router was installed without providers and with credential discovery disabled " +
        "(--no-provider --no-discovery), so no traffic leaves this machine. " +
        "Re-run setup without those flags to enable a provider.",
    },
  });
}

async function handleResponses(request, response, requestUrl) {
  const startedAt = Date.now();
  const controller = new AbortController();
  const activity = beginRequestActivity({ request, response, controller });
  let clientGone = false;
  let requestedModel = "";
  let route;
  let directResponses = false;
  let upstreamRetries;
  let upstreamStatus;
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
  let pendingInterrupts = [];
  let emptyCompletion = false;
  let emptyCompletionRetried = false;
  // The model the operator actually asked for, when this turn ended up being
  // served by a different one. Present only on a turn the router rescued.
  let failoverFrom;
  // An empty turn the router could not repair because the attempt was already
  // relayed. Distinct from `emptyCompletionRetried` in the meter: one is a
  // failure the router absorbed, the other a failure it had to hand to the
  // client, and only the second is visible to the user.
  let emptyCompletionUnrepairable = false;
  let emptyCompletionPreludeLimit;
  let preludeLimitRetryable = false;
  let finalStatus;
  let activityStatus;
  let usageRecorded = false;
  bindClientAbort(request, response, () => {
    clientGone = true;
    controller.abort();
  });
  try {
    if (!requireCodexTransport(request, response)) return;
    const exactRouteProbe = exactRouteProbeRequested(request.headers);
    const encoded = await readRequestBody(request, { signal: controller.signal });
    const body = await decodeBody(encoded, request.headers["content-encoding"]);
    let payload = await parseBodyAsync(body);
    controller.signal.throwIfAborted();
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
      if (redirect && routeProviderEnabled(redirect.provider)) {
        registeredRoute = redirect;
      }
    }
    route = registeredRoute && routeProviderEnabled(registeredRoute.provider)
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
    // Anything without a route from here on is native GPT traffic. An install
    // that merely hid every provider keeps its native passthrough -- that has
    // always worked -- but an idle --no-discovery install answers locally.
    if (!route && discoveryDisabled()) {
      writeIdleNoProviderError(response);
      return;
    }
    // Activity and usage attribute protocol variants to their canonical
    // family so the tray Island and graphs show one provider per subscription.
    activity.setRoute({
      provider: route ? canonicalProviderId(route.provider) : "openai",
      model: route?.slug || requestedModel || undefined,
      ...activityMetadataFromHeaders(request.headers),
    });
    directResponses = route
      ? isDirectResponsesProvider(providerForModel(route))
      : false;
    const compactV1 = /\/responses\/compact$/.test(requestUrl.pathname);
    // Codex remote compaction V2 uses the ordinary Responses endpoint with a
    // terminal trigger. Detect the protocol shape before route dispatch so the
    // native path can also preserve the full tool results being summarized.
    const compactV2 =
      Array.isArray(payload.input) &&
      payload.input.at(-1)?.type === "compaction_trigger";

    if (route && !directResponses && (compactV1 || compactV2)) {
      const compaction = await handleRoutedCompaction(
        request,
        response,
        payload,
        route,
        controller.signal,
        compactV2,
        { allowFailover: !exactRouteProbe },
      );
      const compacted = compaction.route || route;
      recordCompactionUsage(compaction, route, startedAt);
      usage = compaction.usage;
      finalStatus = compaction.status;
      activityStatus = compaction.status;
      usageRecorded = true;
      // The compaction chose its own model inside `summarize`, so the outer
      // route still names the one the conversation is on. Adopt what actually
      // served before returning, or the timing line emitted in `finally` would
      // credit the exhausted provider with this turn's 200.
      route = compacted;
      failoverFrom ??= compaction.failoverFrom;
      if (!QUIET) {
        console.error(
          `[codex-router] model=${compacted.slug} provider=${compacted.provider} status=${compaction.status}${
            compaction.failoverFrom ? ` failover-from=${compaction.failoverFrom}` : ""
          }`,
        );
      }
      return;
    }

    let target;
    let headers;
    let routedBody;
    let builtSearchMode;
    let namespacesFlattened = false;
    let flattenedNamespaces = new Map();
    // The route-independent half of the input, computed once. Failing the turn
    // over to another model rebuilds its provider-specific request from these
    // pristine normalized items, so an encrypted-payload relay is paid for once.
    let normalizedInput;
    let agingEnabled = false;
    let agedInput;
    let searchContract;
    // Adopts a rebuilt request for a different model. Everything downstream --
    // the response transforms, the prompt-token estimate, the empty-completion
    // retry -- reads these, so all of them have to move together or the turn
    // would be relayed through one model's namespace map while another model
    // answered it.
    const adoptRoute = (nextRoute, built) => {
      failoverFrom ??= route.slug;
      route = nextRoute;
      namespacesFlattened = built.namespacesFlattened;
      flattenedNamespaces = built.flattenedNamespaces;
      pendingInterrupts = built.pendingInterrupts;
      agedInput = built.agedInput;
      toolResultAging = built.toolResultAging;
      target = built.target;
      headers = built.headers;
      routedBody = built.body;
      builtSearchMode = built.searchMode;
      // The tray Island has to name the model that is actually answering.
      activity.setRoute({
        provider: canonicalProviderId(route.provider),
        model: route.slug,
        ...activityMetadataFromHeaders(request.headers),
      });
    };
    if (route && directResponses) {
      const provider = providerForModel(route);
      target = directResponsesTarget(provider, requestUrl.pathname, requestUrl.search);
      headers = directResponsesHeaders(request.headers);
      routedBody = directResponsesBody(payload, route);
    } else if (route) {
      // Resolve the selected route's search contract once, before encrypted
      // handoff normalization or any other external work. A later failover may
      // not reintroduce ambient search that this route never advertised.
      const searchSnapshot = snapshotRoutedSearch(payload, route);
      payload = searchSnapshot.payload;
      normalizedInput = await normalizeRoutedAgentInput(
        request,
        payload.input,
        controller.signal,
      );
      searchContract = routedSearchContract(searchSnapshot, normalizedInput);
      agingEnabled = toolResultAgingEnabled();
      const built = await prepareRoutedRequest({
        request,
        payload,
        route,
        normalizedInput,
        agingEnabled,
      });
      toolResultAging = built.toolResultAging;
      agedInput = built.agedInput;
      namespacesFlattened = built.namespacesFlattened;
      flattenedNamespaces = built.flattenedNamespaces;
      pendingInterrupts = built.pendingInterrupts;
      target = built.target;
      headers = built.headers;
      routedBody = built.body;
      builtSearchMode = built.searchMode;
      // This provider has already said it would be empty until a named time.
      // Sending anyway buys one guaranteed rejection per turn for as long as
      // the window lasts, so move now and skip the dead round trip. The body
      // just built is thrown away, which costs one local serialization -- far
      // less than the request it avoids. The cooldown expires by itself, so
      // the operator's chosen model comes back without anyone doing anything.
      const settings = readFailoverSettings();
      const cooled = !exactRouteProbe && settings.enabled
        ? providerCooldown(route.provider)
        : undefined;
      if (cooled) {
        const candidates = failoverCandidates({
          route,
          agedInput,
          flattenedNamespaces,
          searchContract,
          chain: settings.chain,
        }).slice(0, MAX_FAILOVER_HOPS);
        for (const next of candidates) {
          let candidate;
          try {
            candidate = await prepareRoutedRequest({
              request,
              payload,
              route: next.model,
              normalizedInput,
              agingEnabled,
            });
          } catch (error) {
            const compatibilityCode = candidateBuildCompatibilityCode(error);
            if (!compatibilityCode) throw error;
            logFailover(
              route,
              next.model,
              `cooled_until_${cooled.until}`,
              "not-sent",
              `compatibility/${compatibilityCode}`,
            );
            continue;
          }
          if (
            !searchModePreservesSearchContract(candidate.searchMode, searchContract) ||
            !routedModelPreservesSearchContract(next.model, searchContract)
          ) {
            logFailover(
              route,
              next.model,
              `cooled_until_${cooled.until}`,
              "not-sent",
              "search-capability-changed",
            );
          } else if (routedRequestFits(next.model, candidate.body)) {
            logFailover(route, next.model, `cooled_until_${cooled.until}`, "not-sent", "swapped");
            adoptRoute(next.model, candidate);
            break;
          } else {
            logFailover(
              route,
              next.model,
              `cooled_until_${cooled.until}`,
              "not-sent",
              "context-too-small",
            );
          }
        }
      }
    } else {
      const native = { ...payload };
      const substitutedCaller = callerBroughtNoUpstreamCredential(request);
      // An extended-window variant is the model it was derived from, published
      // under a second slug so the picker can offer a different context
      // window (`src/native-context-variants.mjs`). chatgpt.com has never
      // heard of that slug, so it is translated back here -- the last point
      // before the turn leaves. Everything the operator reads keeps the slug
      // they picked: `requestedModel` is untouched, so activity, usage, and
      // the log still name the model the picker showed.
      const variantBase = nativeContextVariantBase(native.model);
      if (variantBase) native.model = variantBase;
      normalizeNativePromptCacheCompatibility(native);
      if (Array.isArray(payload.input)) {
        native.input = normalizeNativeInput(payload.input, {
          // Every substituted caller needs provenance-safe full reasoning.
          // V1 compaction alone has a stored-reference contract, so it keeps
          // bare rs_ references while ordinary/V2 stateless replay drops them.
          statelessReasoning: substitutedCaller,
          dropUnstoredReasoningReferences: substitutedCaller && !compactV1,
        });
        // Native turns leave here as stateless full conversations (the
        // previous_response_id below is stripped), so an old tool result costs
        // its full size on every turn of this path too. Compaction turns are
        // exempt: compactV1 keeps its chaining, and a summary should read the
        // true content rather than a receipt.
        if (!compactV1 && !compactV2) {
          const aged = ageToolResults(native.input, {
            enabled: nativeToolResultAgingEnabled(),
          });
          native.input = aged.input;
          toolResultAging = aged.stats;
        }
      }
      // SF and other native multi-agent parents hit this path (model_provider
      // openai). They have the same Working-badge bug, so inventory the tools
      // and queue missing interrupt_agent closes the same way as routed turns.
      flattenedNamespaces = flattenNamespaceTools(payload.tools, {
        bridgeToolSearch: false,
      }).namespaces;
      pendingInterrupts = pendingInterruptTargets(native.input ?? payload.input, {
        namespaces: flattenedNamespaces,
      });
      if (!compactV1) delete native.previous_response_id;
      if (substitutedCaller) {
        normalizeNativeForSubstitutedCaller(native, { compact: compactV1 });
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
    // The selected route is subject to the same immutable built-bytes and
    // live capability contract as every fallback. This catches unsupported
    // search history and sidecar changes after normalization before any
    // provider-bound bytes leave the router.
    if (route && !directResponses) {
      assertRoutedSearchContract(route, builtSearchMode, searchContract);
    }
    let { response: upstream, retries } = await fetchWithRetry(
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
    upstreamStatus = upstream.status;
    // Time until the upstream chain answered the request. Everything before
    // this is router-side work (body read, normalization, flattening, vision
    // bridge) plus the upstream's own time to produce response headers. For a
    // routed turn that means the full router -> litellm -> api-forwarder ->
    // provider path, so a stall here is the provider's, not the router's.
    upstreamLatencyMs = Date.now() - startedAt;
    // The body of a failed routed attempt, read once: the failover classifier
    // and the error translation below both need it, and it can only be read
    // once. Nothing is relayed either way, so reading it is free.
    let failedBodyText;
    if (route && !directResponses && !upstream.ok) {
      failedBodyText = await boundedResponseText(
        upstream,
        MAX_BUFFERED_RESPONSE_BYTES,
        controller.signal,
      );
      const verdict = classifyRoutedFailure({
        status: upstream.status,
        bodyText: failedBodyText,
        retryAfterSeconds: retryAfterSeconds(upstream.headers),
      });
      if (verdict.swap && !exactRouteProbe) {
        // Believe the provider about when it will be back before trying anyone
        // else, so the next turn skips it instead of paying for the same
        // rejection again.
        recordProviderCooldown(route.provider, verdict);
        const moved = await attemptModelFailover({
          request,
          response,
          payload,
          route,
          agedInput,
          flattenedNamespaces,
          verdict,
          status: upstream.status,
          signal: controller.signal,
          normalizedInput,
          agingEnabled,
          searchContract,
        });
        if (moved) {
          // The attempt that failed is still a turn that happened and still
          // cost the provider something, so it is metered on its own row. The
          // serving row below carries `failoverFrom`, which is what makes a
          // rescued turn distinguishable from one that never failed.
          recordUsageEvent({
            model: route.slug,
            provider: canonicalProviderId(route.provider),
            status: upstream.status,
            durationMs: Date.now() - startedAt,
            responseStartMs: upstreamLatencyMs,
          });
          adoptRoute(moved.route, moved.built);
          upstream = moved.upstream;
          upstreamStatus = upstream.status;
          failedBodyText = moved.failedBodyText;
        }
      }
    }
    // A provider that just answered is not out of usage, whatever this router
    // recorded earlier: a quota that refilled early, a limit the operator
    // raised, or a reset time the provider got wrong all end the same way, and
    // a real answer is better evidence than anything on disk.
    if (route && !directResponses && upstream.ok) clearProviderCooldown(route.provider);
    // The direct bridge owns its own explicit failure vocabulary. It has not
    // passed through LiteLLM, so translating the body as a gateway exception
    // would erase the actionable browser/login/UI-drift error it produced.
    if (route && directResponses && !upstream.ok) {
      await pipeResponse(upstream, response, HOP_BY_HOP_HEADERS);
      recordUsageEvent({
        model: route.slug,
        provider: canonicalProviderId(route.provider),
        status: upstream.status,
        durationMs: Date.now() - startedAt,
        responseStartMs: upstreamLatencyMs,
      });
      observeSubagentOutcome(request, route, upstream.status);
      finalStatus = upstream.status;
      activityStatus = upstream.status;
      usageRecorded = true;
      return;
    }
    // Gateway error bodies leak LiteLLM's internal exception chain, which
    // reads like a router bug. Rewrite them to name the provider that failed.
    // Native traffic passes through untouched: OpenAI errors are already clear.
    if (route && !upstream.ok) {
      const provider = providerForModel(route);
      const retryAfterHeader = upstream.headers.get("retry-after");
      const retrySeconds = retryAfterSeconds(upstream.headers);
      const translatedStatus = gatewayErrorStatus({
        status: upstream.status,
        bodyText: failedBodyText,
      });
      if (retryAfterHeader) response.setHeader("Retry-After", retryAfterHeader);
      const translatedError = translateGatewayError({
        status: upstream.status,
        // Already drained above so the failover classifier could read it; a
        // second `.text()` on the same response yields "".
        bodyText: failedBodyText ?? "",
        modelName: route.displayName || route.slug,
        providerName:
          provider?.transport === "ollama"
            ? "Ollama"
            : provider?.ownedBy || provider?.displayName || route.provider,
        providerKind: provider?.kind,
        providerAuthMode: provider?.authMode,
        retryAfterSeconds: retrySeconds,
      });
      writeTranslatedGatewayError(response, translatedStatus, translatedError, {
        provider: route.provider,
        stream: payload.stream === true,
      });
      recordUsageEvent({
        model: route.slug,
        provider: canonicalProviderId(route.provider),
        status: upstream.status,
        durationMs: Date.now() - startedAt,
        responseStartMs: upstreamLatencyMs,
        firstTokenMs,
      });
      observeSubagentOutcome(request, route, upstream.status);
      finalStatus = translatedStatus;
      activityStatus = translatedStatus;
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
          ZERO_INPUT_ESTIMATE && route && !directResponses
            ? estimateInputTokens(routedBody, { contextWindow: route.contextWindow })
            : undefined,
      });
      const transforms = [usageObserver];
      let envelopeCompat = !directResponses && route
        ? zaiResponsesCompatTransform(route.provider, contentType)
        : undefined;
      // Z.ai Responses streams from GLM-5.3 can start assistant text after
      // reasoning without its message envelope. Keep that repair provider-scoped.
      if (
        !envelopeCompat &&
        route?.provider === "zai-coding" &&
        String(contentType).toLowerCase().includes("text/event-stream")
      ) {
        envelopeCompat = new ZaiResponsesCompatTransform();
      }
      if (envelopeCompat) transforms.push(envelopeCompat);
      const grokReasoningSummaryCompat = !directResponses && route
        ? grokReasoningSummaryCompatTransform(providerForModel(route), contentType)
        : undefined;
      if (grokReasoningSummaryCompat) transforms.push(grokReasoningSummaryCompat);
      // LiteLLM can add blank assistant envelopes while translating either
      // Chat Completions or Messages. The factory refuses native traffic and
      // providers that already speak Responses, so those paths gain no stage.
      const translatedToolMessageCompat = !directResponses && route
        ? translatedToolMessageCompatTransform(providerForModel(route), contentType)
        : undefined;
      if (translatedToolMessageCompat) transforms.push(translatedToolMessageCompat);
      // Restore flattened namespace calls for routed chat-completions providers
      // and pin an omitted spawn_agent model to every routed parent, including
      // providers that already speak Responses. Also inject missing finished-
      // child interrupts for both routed and native multi-agent parents (San
      // Francisco uses native GPT).
      if (route || pendingInterrupts.length > 0) {
        transforms.push(
          new NamespaceToolCallTransform(
            flattenedNamespaces,
            contentType,
            route?.slug,
            // A native stream is attached only for the injection, so it must
            // not pick up the routed-provider rewrites on the way through.
            { pendingInterrupts, injectOnly: !route },
          ),
        );
      }
      const guard =
        route && !directResponses && EMPTY_COMPLETION_RETRY
          ? new EmptyCompletionGuard(contentType, {
              maxPreludeBytes: EMPTY_COMPLETION_PRELUDE_BYTES,
              maxPreludeMs: EMPTY_COMPLETION_PRELUDE_MS,
            })
          : undefined;
      if (guard) {
        transforms.push(
          guard,
          new EmptyCompletionTerminalGuard(guard, contentType, {
            maxHeldTerminalBytes: EMPTY_COMPLETION_PRELUDE_BYTES,
          }),
        );
      }
      // Strip inline `<think>...</think>` reasoning that routed providers leak
      // into the visible answer, when their chat-completions -> Responses bridge
      // relays the model's chain-of-thought as `output_text` instead of on the
      // reasoning channel. Runs before the lifecycle normalizer so the reorder
      // sees already-cleaned message text. Native OpenAI streams (no route) never
      // carry these tags and are left untouched.
      const tagStripper = route ? reasoningTagStripperTransform(contentType) : undefined;
      if (tagStripper) transforms.push(tagStripper);
      // Restore sequential output-item lifecycles for routed providers, whose
      // chat-completions -> Responses bridge can leave an assistant `message`
      // item open across a `function_call` item and close it late, making Codex
      // render the same turn's text twice. Runs last so it normalizes the final
      // egress stream after every other rewrite/injection. Native OpenAI streams
      // (no route) are already well-formed and left untouched.
      const itemNormalizer = route
        ? itemLifecycleNormalizerTransform(contentType)
        : undefined;
      if (itemNormalizer) transforms.push(itemNormalizer);
      return { transforms, usageObserver, guard };
    };
    const firstPipeline = createResponsePipeline(upstreamContentType);
    usageTransform = firstPipeline.usageObserver;
    emptyCompletionGuard = firstPipeline.guard;
    const relayOpen = Boolean(emptyCompletionGuard);
    let streamedPreludeFailureKind;
    try {
      await pipeResponse(
        upstream,
        response,
        HOP_BY_HOP_HEADERS,
        firstPipeline.transforms,
        { leaveOpen: relayOpen },
      );
    } catch (error) {
      if (isEmptyCompletionPreludeLimitError(error) && !clientGone) {
        emptyCompletionPreludeLimit = error.kind;
        if (nothingRelayed(response)) {
          preludeLimitRetryable = true;
        } else {
          streamedPreludeFailureKind = error.kind;
          emptyCompletionUnrepairable = true;
          writeStreamErrorEvent(response, {
            code: "precontent_limit",
            message:
              error.kind === "time"
                ? "The model stopped producing output before the router's stream deadline."
                : "The model exceeded the router's bounded stream parser before producing output.",
          });
        }
      } else {
        throw error;
      }
    }
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
    const nativeCompletedBeforeClose =
      !route && usageTransform?.completedResponseObserved() === true;
    const clientWalkedAway =
      (clientGone || (response.destroyed && !response.writableFinished)) &&
      !nativeCompletedBeforeClose;
    finalStatus = clientWalkedAway ? 0 : upstream.status;
    if (
      !clientWalkedAway &&
      route?.provider === "grok-oauth" &&
      usageTransform?.terminalErrorObserved?.() === true
    ) {
      // The Grok forwarder has already committed the HTTP 200 SSE head when a
      // post-tool repair can fail. Keep the client-visible terminal event, but
      // account for the turn as a provider failure rather than a success.
      finalStatus = 502;
    }
    if (streamedPreludeFailureKind && !clientWalkedAway) finalStatus = 502;
    emptyCompletion = emptyCompletionGuard?.isEmpty() === true && !clientWalkedAway;
    emptyCompletionPreludeLimit ||=
      emptyCompletionGuard?.preludeLimitKind?.();
    // A pre-content limit used to release the staged bytes and stop parsing,
    // which could turn an unknown stream into a successful-looking empty
    // response. The byte limit now fails while every byte is replaceable so
    // the retry below can recover it. The time limit still releases for
    // latency, but keeps parsing so a terminal empty turn becomes a stated SSE
    // error instead of a blank success.
    // The turn produced nothing, but the guard had already released it: the
    // upstream proved it was generating (reasoning), so the head, response id,
    // and prologue are on the wire. A second attempt would graft a second
    // response onto a stream the client is already reading. State the failure
    // instead. This is the case the hold used to cover, priced honestly — the
    // hold cost every reasoning turn up to its full budget of dead air, and
    // bought a silent rescue on roughly one routed turn in a thousand.
    if (emptyCompletion && emptyCompletionGuard?.suppressedPrologue() !== true) {
      emptyCompletionUnrepairable = true;
      writeStreamErrorEvent(response, {
        code: emptyCompletionPreludeLimit
          ? "precontent_limit"
          : "empty_completion",
        message: emptyCompletionPreludeLimit
          ? "The model produced no output before the router's safety limit and then completed without output. The response had already started, so the router could not retry it safely."
          : "The model streamed reasoning but produced no output. The router could not retry because the response had already started.",
      });
      finalStatus = 502;
    } else if (emptyCompletion || preludeLimitRetryable) {
      // The upstream answered 200 with nothing and never proved otherwise, so
      // the guard still holds every byte. Retry the identical request once:
      // same bytes, same headers, same signal. The discarded first stream means
      // the retry supplies the only head, response id, sequence space,
      // reasoning, and output the client ever receives.
      let upstream2;
      // The held first response creates another asynchronous boundary: a
      // sidecar can be disabled or lose its credential while that stream is
      // being classified. Revalidate immediately before replaying the exact
      // bytes so the repair path cannot outlive the contract they encode. The
      // discarded attempt's staged headers are no longer authoritative even
      // when this check fails and the router writes its own local response.
      clearStagedResponseHead(response);
      if (route && !directResponses) {
        assertRoutedSearchContract(route, builtSearchMode, searchContract);
      }
      emptyCompletionRetried = true;
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
          emptyCompletionPreludeLimit
            ? "precontent_limit_retry_failed"
            : "empty_completion_retry_failed",
          emptyCompletionPreludeLimit
            ? "The model produced no output before the router's safety limit and the retry failed upstream."
            : "The model returned an empty completion and the router's retry failed upstream.",
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
            emptyCompletionPreludeLimit
              ? upstream2.ok
                ? "precontent_limit_retry_protocol_error"
                : "precontent_limit_retry_failed"
              : upstream2.ok
                ? "empty_completion_retry_protocol_error"
                : "empty_completion_retry_failed",
            emptyCompletionPreludeLimit
              ? upstream2.ok
                ? "The model produced no output before the router's safety limit and the retry returned an incompatible response."
                : "The model produced no output before the router's safety limit and the retry failed upstream."
              : upstream2.ok
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
          let retryPreludeFailureKind;
          let retryStreamedPreludeFailureKind;
          try {
            await pipeResponse(
              upstream2,
              response,
              HOP_BY_HOP_HEADERS,
              secondPipeline.transforms,
              { leaveOpen: true },
            );
          } catch (error) {
            if (isEmptyCompletionPreludeLimitError(error) && !clientGone) {
              emptyCompletionPreludeLimit ||= error.kind;
              if (nothingRelayed(response)) {
                retryPreludeFailureKind = error.kind;
              } else {
                retryStreamedPreludeFailureKind = error.kind;
                emptyCompletionUnrepairable = true;
                writeStreamErrorEvent(response, {
                  code: "precontent_limit",
                  message:
                    error.kind === "time"
                      ? "The retry stopped producing output before the router's stream deadline."
                      : "The retry exceeded the router's bounded stream parser before producing output.",
                });
              }
            } else {
              throw error;
            }
          }
          const retryClientWalkedAway =
            clientGone || (response.destroyed && !response.writableFinished);
          emptyCompletionPreludeLimit ||=
            retryEmptyCompletionGuard?.preludeLimitKind?.();
          if (retryClientWalkedAway) {
            finalStatus = 0;
            if (secondPipeline.guard.hasContent()) emptyCompletion = false;
          } else if (retryStreamedPreludeFailureKind) {
            finalStatus = 502;
          } else if (
            retryEmptyCompletionGuard.isEmpty() &&
            retryEmptyCompletionGuard.suppressedPrologue() !== true
          ) {
            emptyCompletionUnrepairable = true;
            writeStreamErrorEvent(response, {
              code: emptyCompletionPreludeLimit
                ? "precontent_limit"
                : "empty_completion",
              message: emptyCompletionPreludeLimit
                ? "The retry produced no output before the router's safety limit and then completed without output."
                : "The retry streamed reasoning but completed without output.",
            });
            finalStatus = 502;
          } else if (retryPreludeFailureKind) {
            writeEmptyCompletionError(
              response,
              "precontent_limit",
              "The model produced no output before the router's safety limit. The router retried once and the retry reached a safety limit again.",
            );
            finalStatus = 502;
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
      ...usage,
      estimatedInputTokens,
      ...toolResultAging,
      retries: (upstreamRetries || 0) + (usage?.retries || 0) || undefined,
      ...(emptyCompletion ? { emptyCompletion: true } : {}),
      ...(emptyCompletionRetried ? { emptyCompletionRetried: true } : {}),
      ...(usage?.progressOnlyRetried ? { progressOnlyRetried: true } : {}),
      ...(emptyCompletionUnrepairable ? { emptyCompletionUnrepairable: true } : {}),
      ...(emptyCompletionPreludeLimit
        ? { emptyCompletionPreludeLimit }
        : {}),
      ...(failoverFrom ? { failoverFrom } : {}),
    });
    // The same usage this turn just metered, and the same two disqualifiers
    // context-window-drift.mjs applies to it: a substituted estimate and a
    // retry-doubled count are not measurements of what the child sent.
    observeSubagentOutcome(request, route, finalStatus, {
      emptyCompletion,
      usage,
      estimatedInputTokens,
      emptyCompletionRetried,
      progressOnlyRetried: usage?.progressOnlyRetried === true,
    });
    usageRecorded = true;
    activityStatus = finalStatus;
    if (!QUIET) {
      // The substitution is named in the log line as well as the usage event:
      // a router that quietly invents token counts is its own trap.
      console.error(
        `[codex-router] model=${route?.slug || requestedModel || "unknown"} provider=${route?.provider || "openai"} status=${finalStatus}${
          upstreamRetries ? ` retries=${upstreamRetries}` : ""
        }${estimatedInputTokens ? ` estimated-input-tokens=${estimatedInputTokens}` : ""}${
          toolResultAging?.toolResultBytesSaved
            ? ` aged-tool-results=${toolResultAging.toolResultsAged} saved-tool-bytes=${toolResultAging.toolResultBytesSaved}`
            : ""
        }${
          emptyCompletionRetried ? " empty-completion-retried=true" : ""
        }${
          emptyCompletionUnrepairable ? " empty-completion-unrepairable=true" : ""
        }${emptyCompletion ? " empty-completion=true" : ""}${
          emptyCompletionPreludeLimit
            ? ` empty-completion-prelude-limit=${emptyCompletionPreludeLimit}`
            : ""
        }${
          failoverFrom ? ` failover-from=${failoverFrom}` : ""
        }`,
      );
    }
  } catch (error) {
    upstreamLatencyMs ??= Date.now() - startedAt;
    if (activity.deadlineExceeded()) {
      finalStatus = 504;
      activityStatus = 504;
      if (!usageRecorded) {
        recordUsageEvent({
          model: route?.slug || requestedModel,
          provider: route ? canonicalProviderId(route.provider) : "openai",
          status: 504,
          durationMs: Date.now() - startedAt,
          responseStartMs: upstreamLatencyMs,
          requestDeadlineExceeded: true,
        });
        usageRecorded = true;
      }
      if (!response.headersSent) {
        writeJson(response, 504, {
          error: {
            type: "router_request_timeout",
            message: "The router canceled a request that exceeded its execution deadline.",
          },
        });
      } else {
        endStreamedResponse(response, {
          message: "The router canceled a request that exceeded its execution deadline.",
        });
      }
      return;
    }
    if (
      error?.code === GROQ_TOOL_LIMIT_CODE &&
      error?.provider === "groq" &&
      !response.headersSent
    ) {
      finalStatus = error.status;
      activityStatus = error.status;
      writeJson(response, error.status, {
        error: {
          type: "provider_compatibility_error",
          code: error.code,
          provider: error.provider,
          limit: error.limit,
          message: error.message,
        },
      });
      recordUsageEvent({
        model: route?.slug || requestedModel,
        provider: route ? canonicalProviderId(route.provider) : "openai",
        status: error.status,
        durationMs: Date.now() - startedAt,
        responseStartMs: upstreamLatencyMs,
      });
      usageRecorded = true;
      return;
    }
    if (error?.code === "model_search_not_supported" && !response.headersSent) {
      finalStatus = error.status;
      activityStatus = error.status;
      writeJson(response, error.status, {
        error: {
          type: error.code,
          message: error.message,
        },
      });
      recordUsageEvent({
        model: route?.slug || requestedModel,
        provider: route ? canonicalProviderId(route.provider) : "openai",
        status: error.status,
        durationMs: Date.now() - startedAt,
        responseStartMs: upstreamLatencyMs,
        ...usage,
        estimatedInputTokens,
        ...toolResultAging,
        ...(emptyCompletion ? { emptyCompletion: true } : {}),
        ...(emptyCompletionPreludeLimit
          ? { emptyCompletionPreludeLimit }
          : {}),
        ...(failoverFrom ? { failoverFrom } : {}),
      });
      usageRecorded = true;
      return;
    }
    if (retryEmptyCompletionGuard?.hasContent()) emptyCompletion = false;
    if (usageTransform) {
      usage = mergeTokenUsage(
        usageTransform.tokenUsage(),
        retryUsageTransform?.tokenUsage() ?? retryUsage,
      );
      estimatedInputTokens = sumEstimatedInputTokens(
        usageTransform.substitutedInputTokens(),
        retryUsageTransform?.substitutedInputTokens(),
      );
      const firstTokenAt = usageTransform.firstTokenAt?.();
      if (firstTokenAt !== undefined) firstTokenMs = firstTokenAt - startedAt;
    }
    // Codex may close a native stream immediately after response.completed.
    // That is a successful terminal turn, not a canceled generation.
    if (!route && clientGone && usageTransform?.completedResponseObserved() === true) {
      finalStatus = upstreamStatus ?? response.statusCode;
      activityStatus = finalStatus;
      if (!usageRecorded) {
        recordUsageEvent({
          model: requestedModel,
          provider: "openai",
          status: finalStatus,
          durationMs: Date.now() - startedAt,
          responseStartMs: upstreamLatencyMs,
          firstTokenMs,
          ...usage,
          estimatedInputTokens,
          ...toolResultAging,
          retries: (upstreamRetries || 0) + (usage?.retries || 0) || undefined,
        });
        usageRecorded = true;
      }
      if (!QUIET) {
        console.error(
          `[codex-router] model=${requestedModel || "unknown"} provider=openai status=${finalStatus}${
            upstreamRetries ? ` retries=${upstreamRetries}` : ""
          }`,
        );
      }
      return;
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
        ...(emptyCompletionPreludeLimit
          ? { emptyCompletionPreludeLimit }
          : {}),
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
    // `model` and `provider` always name the pair that actually served the
    // turn, so the two never disagree. On a turn the router moved, that is the
    // fallback -- and `failover_from` carries what was asked for. Reading them
    // the other way round (the asked-for model beside the serving provider)
    // describes a combination that never ran.
    console.error(
      `[codex-router] timing at=${new Date().toISOString()} model=${route?.slug || requestedModel || "unknown"} provider=${route?.provider || "openai"} status=${status} total_ms=${Date.now() - startedAt} upstream_ms=${timingMetric(upstreamLatencyMs)} out_tokens=${timingMetric(usage?.outputTokens)} cached_tokens=${timingMetric(usage?.cachedInputTokens)}${
        estimatedInputTokens ? ` est_input=${estimatedInputTokens}` : ""
      }${failoverFrom ? ` failover_from=${failoverFrom}` : ""}`,
    );
  }
}

async function handleNativeRequest(request, response, requestUrl, defaultModel) {
  const startedAt = Date.now();
  const controller = new AbortController();
  const activity = beginRequestActivity({ request, response, controller });
  let clientGone = false;
  let requestedModel = defaultModel;
  let servingProvider = "openai";
  bindClientAbort(request, response, () => {
    clientGone = true;
    controller.abort();
  });
  try {
    if (!requireCodexTransport(request, response)) return;
    let body;
    let payload;
    const searchRequest = defaultModel === "web-search";
    // A search binding is selected by the exact routed slug inside Codex's
    // authenticated search request. Parse it before asking for a native
    // session; otherwise a deliberately external sidecar would still require
    // and leak the request to ChatGPT. Image requests keep their old ordering.
    if (searchRequest) {
      const encoded = await readRequestBody(request, { signal: controller.signal });
      body = await decodeBody(encoded, request.headers["content-encoding"]);
      payload = await parseBodyAsync(body);
      requestedModel = typeof payload.model === "string" ? payload.model : defaultModel;
      const binding = searchSidecarBindingForModel(requestedModel);
      if (binding) {
        servingProvider = `search:${binding.providerId}`;
        activity.setRoute({
          provider: servingProvider,
          model: requestedModel,
          ...activityMetadataFromHeaders(request.headers),
        });
        const routedModel = MODEL_BY_SLUG.get(requestedModel);
        if (
          !routedModel ||
          !routeProviderEnabled(routedModel.provider) ||
          routedModel.searchTool !== undefined
        ) {
          throw new SearchSidecarError(
            "The selected model is not eligible for its configured search sidecar.",
            { code: "search_sidecar_model_ineligible", status: 409 },
          );
        }
        const accountId = String(request.headers["chatgpt-account-id"] || "");
        const installationId = String(request.headers["x-codex-installation-id"] || "");
        // The local caller capability proves authorization, not account
        // identity. If Codex supplies no account id, use a one-request nonce
        // so the cache cannot cross an account switch on the same install.
        const accountScope = createHash("sha256")
          .update(String(request.headers.authorization || ""))
          .update("\0")
          .update(accountId || randomUUID())
          .update("\0")
          .update(installationId)
          .digest("base64url");
        const sidecar = await executeSearchSidecar({
          binding,
          payload,
          accountScope,
          signal: controller.signal,
        });
        writeJson(response, 200, sidecar.response);
        recordUsageEvent({
          model: requestedModel,
          provider: servingProvider,
          status: 200,
          durationMs: Date.now() - startedAt,
          retries: Math.max(0, (sidecar.telemetry?.attempts || 1) - 1),
          searchSidecar: true,
          searchCacheHit: sidecar.telemetry?.cacheHit === true,
          searchResults: sidecar.telemetry?.results,
        });
        if (!QUIET) {
          console.error(
            `[codex-router] model=${requestedModel} provider=${servingProvider} status=200 attempts=${sidecar.telemetry?.attempts || 0} cache_hit=${sidecar.telemetry?.cacheHit === true}`,
          );
        }
        return;
      }
    }

    // Image requests and unbound web-search turns remain native-only; an idle
    // install refuses them locally rather than forwarding to chatgpt.com.
    if (discoveryDisabled()) {
      writeIdleNoProviderError(response);
      return;
    }
    const headers = nativeHeaders(request);
    if (!hasNativeSession(headers)) {
      writeJson(response, 401, {
        error: {
          type: "native_session_required",
          message: "This native OpenAI route requires an active ChatGPT/Codex session.",
        },
      });
      return;
    }
    if (!payload) {
      const encoded = await readRequestBody(request, { signal: controller.signal });
      body = await decodeBody(encoded, request.headers["content-encoding"]);
      payload = await parseBodyAsync(body);
    }
    controller.signal.throwIfAborted();
    requestedModel =
      typeof payload.model === "string" ? payload.model : defaultModel;
    activity.setRoute({
      provider: "openai",
      model: requestedModel,
      ...activityMetadataFromHeaders(request.headers),
    });

    // The same slug translation the turn path does, for the same reason: these
    // endpoints normally carry their own model ("gpt-image-2", the search
    // model), but nothing stops a client from naming the picked one, and an
    // extended-window slug means nothing to chatgpt.com. The bytes are only
    // re-encoded when a variant is actually present, so every other request on
    // this path is forwarded exactly as it arrived.
    const variantBase = nativeContextVariantBase(payload.model);
    const outgoing = variantBase
      ? Buffer.from(JSON.stringify({ ...payload, model: variantBase }), "utf8")
      : body;
    // Same replayable-Buffer rule as the turn path: encode once, outside the
    // retry, so every attempt carries identical bytes under identical headers.
    const imageBody = await compressedNativeBody(outgoing, headers);
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
    if (activity.deadlineExceeded()) {
      const status = 504;
      if (!response.headersSent) {
        writeJson(response, status, {
          error: {
            type: "router_request_timeout",
            message: "The router canceled a request that exceeded its execution deadline.",
          },
        });
      } else {
        endStreamedResponse(response, {
          message: "The router canceled a request that exceeded its execution deadline.",
        });
      }
      recordUsageEvent({
        model: requestedModel,
        provider: servingProvider,
        status,
        durationMs: Date.now() - startedAt,
        ...(response.headersSent ? { streamAborted: true } : {}),
        requestDeadlineExceeded: true,
      });
      activity.finish(status);
      return;
    }
    // A failure with no usage event is invisible to the diagnostic that
    // separates "the upstream failed" from "the request died inside the
    // router" — the distinction #171 turned on. Meter this path the way the
    // turn path does: a departed client as 0, everything else by its status.
    if (clientGone) {
      recordUsageEvent({
        model: requestedModel,
        provider: servingProvider,
        status: 0,
        durationMs: Date.now() - startedAt,
      });
      activity.finish(0);
      return;
    }
    if (error instanceof SearchSidecarError && !response.headersSent) {
      const status = error.status;
      writeJson(response, status, {
        error: {
          type: error.code,
          message: error.message,
        },
      });
      recordUsageEvent({
        model: requestedModel,
        provider: servingProvider,
        status,
        durationMs: Date.now() - startedAt,
        retries: Math.max(0, (error.telemetry?.attempts || 1) - 1),
        searchSidecar: true,
        searchCacheHit: false,
      });
      activity.finish(status);
      return;
    }
    const status = response.headersSent ? 502 : httpErrorStatus(error);
    recordUsageEvent({
      model: requestedModel,
      provider: servingProvider,
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

async function handleEmbeddings(request, response, requestUrl) {
  const startedAt = Date.now();
  const controller = new AbortController();
  const activity = beginRequestActivity({ request, response, controller });
  let clientGone = false;
  let requestedModel = "";
  let route;
  let status = 0;
  bindClientAbort(request, response, () => {
    clientGone = true;
    controller.abort();
  });
  try {
    if (!requireCodexTransport(request, response)) {
      status = response.statusCode;
      return;
    }
    const encoded = await readRequestBody(request, {
      maxBytes: EMBEDDINGS_MAX_BODY_BYTES,
      signal: controller.signal,
    });
    const body = await decodeBody(encoded, request.headers["content-encoding"], {
      maxBytes: EMBEDDINGS_MAX_BODY_BYTES,
    });
    const payload = await parseBodyAsync(body);
    controller.signal.throwIfAborted();
    requestedModel = typeof payload.model === "string" ? payload.model : "";
    route = MODEL_BY_SLUG.get(requestedModel);
    if (!route) {
      status = 400;
      writeJson(response, status, {
        error: {
          type: "unknown_model",
          code: "unknown_model",
          message: "The embeddings request must name a registered routed model.",
        },
      });
      return;
    }
    activity.setRoute({
      provider: canonicalProviderId(route.provider),
      model: route.slug,
      ...activityMetadataFromHeaders(request.headers),
    });
    if (!routeProviderEnabled(route.provider)) {
      status = 409;
      writeJson(response, status, {
        error: {
          type: "provider_not_enabled",
          code: "provider_not_enabled",
          provider: route.provider,
          message: `Provider ${route.provider} is hidden. Run ./bin/providers enable ${route.provider}.`,
        },
      });
      return;
    }
    const provider = providerForModel(route);
    if (!supportsOpenAIModelEndpoint("/embeddings", { model: route, provider })) {
      const error = endpointCapabilityError("/embeddings", route);
      status = error.status;
      writeJson(response, status, {
        error: {
          type: error.code,
          code: error.code,
          message: error.message,
        },
      });
      return;
    }
    const headers = routedHeaders();
    const requestId = safeForwardedRequestId(request.headers["x-request-id"]);
    if (requestId) headers["X-Request-Id"] = requestId;
    const upstream = await fetch(
      `${API_BASE}/embeddings${nativeRequestSearch(requestUrl)}`,
      {
        method: "POST",
        headers,
        body: Buffer.from(
          JSON.stringify({ ...payload, model: route.gatewayModel }),
          "utf8",
        ),
        signal: controller.signal,
        // A 307/308 replays the POST body. The internal capability hop must
        // never let a replaced or misconfigured forwarder redirect a billable
        // embeddings request to another destination.
        redirect: "error",
      },
    );
    const responseBody = await readResponseBody(upstream, {
      maxBytes: EMBEDDINGS_MAX_RESPONSE_BYTES,
      signal: controller.signal,
    });
    controller.signal.throwIfAborted();
    status = upstream.status;
    response.statusCode = upstream.status;
    copyResponseHeaders(upstream, response, HOP_BY_HOP_HEADERS);
    response.end(responseBody);
  } catch (error) {
    if (clientGone) {
      status = 0;
      return;
    }
    if (activity.deadlineExceeded()) {
      status = 504;
      if (!response.headersSent) {
        writeJson(response, status, {
          error: {
            type: "router_request_timeout",
            code: "router_request_timeout",
            message: "The router canceled an embeddings request that exceeded its execution deadline.",
          },
        });
      }
      return;
    }
    status = httpErrorStatus(error);
    throw error;
  } finally {
    if (requestedModel) {
      recordUsageEvent({
        model: route?.slug || requestedModel,
        provider: route ? canonicalProviderId(route.provider) : "unknown",
        status,
        durationMs: Date.now() - startedAt,
      });
    }
    activity.finish(status);
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
      degraded: health.degraded,
      activity: health.activity,
    });
    return;
  }

  const route = authenticatedCallerRoute(request, requestUrl);
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

  // Behind the caller capability, like every other local endpoint: the panel
  // reads the same data the tray does, so it is gated the same way.
  if (isPanelRoute(route) && (await handlePanelRequest(request, response, route, { writeJson }))) {
    return;
  }

  // Cursor has two different client protocols. The desktop app reaches the
  // OpenAI-compatible `/cursor/v1` leaf, while Cursor Agent uses its Connect
  // control plane. Both translate and re-enter this router's `/v1/responses`
  // path, so providers, retries, failover, accounting, and caller authority
  // remain shared with every other client.
  if (isCursorRoute(route)) {
    await handleCursorRequest(request, response, route, {
      responsesUrl: `${callerBaseUrl(LISTEN_PORT, CALLER_KEY)}/responses`,
      routedModels: routedClientModels,
    });
    return;
  }

  // Claude Code speaks Anthropic Messages. This leaf translates that protocol
  // and re-enters the canonical Responses path, so routing, failover, usage,
  // and provider credentials stay on the same shared plane as every client.
  if (isClaudeRoute(route)) {
    await handleClaudeRequest(request, response, route, {
      responsesUrl: `${callerBaseUrl(LISTEN_PORT, CALLER_KEY)}/responses`,
      routedModels: routedClientModels,
    });
    return;
  }

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
  // Gemini CLI speaks nothing but the Gemini API, so it gets its own leaf
  // behind the same capability. The handler translates and re-enters
  // `/v1/responses` over the loopback rather than reaching a provider itself --
  // there is still exactly one request path to keep correct.
  if (isGeminiRoute(requestUrl.pathname)) {
    await handleGeminiRequest(request, response, requestUrl.pathname, {
      responsesUrl: `${callerBaseUrl(LISTEN_PORT, CALLER_KEY)}/responses`,
      routedModels: geminiRoutedModels,
    });
    return;
  }
  if (request.method === "OPTIONS") {
    response.writeHead(204);
    response.end();
    return;
  }
  if (
    request.method === "POST" &&
    ["/embeddings", "/v1/embeddings"].includes(requestUrl.pathname)
  ) {
    await handleEmbeddings(request, response, requestUrl);
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
    // A socket-level failure is the one class of error whose cause is safe to
    // state and useless to withhold: it names a host and a network condition,
    // never a credential or an upstream body. Without it Codex reports only
    // its own transport wording -- `stream disconnected before completion` --
    // and an unreachable upstream is indistinguishable from a router bug.
    const transport = describeTransportFailure(error);
    if (!response.headersSent) {
      writeJson(response, status, {
        error: {
          type: "local_router_error",
          code: transport?.code || error?.code,
          message: transport
            ? `The local router could not complete the request: ${transport.cause}.${transport.hint}`
            : "The local router could not complete the request.",
        },
      });
    } else {
      // The body is already streaming, so there is no status left to change.
      // Destroying here reset the socket and cost the chunked terminator,
      // which the client reported only as a decode failure. The event code
      // stays `local_router_stream_failed`: a diagnosed cause is extra detail
      // about the same failure, not a different one for a client to branch on.
      endStreamedResponse(response, {
        message: transport
          ? `The local router lost the upstream response stream: ${transport.cause}.${transport.hint}`
          : undefined,
      });
    }
  });
});

server.on("upgrade", (request, socket, head) => {
  handleResponsesWebSocketUpgrade(request, socket, head, {
    callerKey: CALLER_KEY,
    authenticateUpgrade: authenticatedCallerRoute,
    // The WebSocket is an edge translation only. Every complete request
    // re-enters this caller-authenticated HTTP route, so routing, provider
    // credentials, retries, failover, transforms, usage, and cancellation all
    // continue to have one implementation.
    responsesUrl: `${callerBaseUrl(LISTEN_PORT, CALLER_KEY)}/responses`,
  });
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

installGracefulShutdown(server, { label: "codex-router" });
