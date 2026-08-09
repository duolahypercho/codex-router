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
} from "./caller-auth.mjs";
import {
  endStreamedResponse,
  HOP_BY_HOP_HEADERS,
  httpErrorStatus,
  pipeResponse,
  readRequestBody,
  writeJson,
} from "./http-utils.mjs";
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
  ResponseUsageTransform,
  tokenUsageFromPayload,
} from "./response-usage.mjs";
import { fetchWithRetry } from "./upstream-retry.mjs";
import {
  CollaborationToolCallTransform,
  flattenCollaborationHistory,
  flattenCollaborationNamespaceTools,
} from "./collaboration-namespace.mjs";
import { activityMetadataFromHeaders } from "./codex-session-names.mjs";
import { translateGatewayError } from "./error-translation.mjs";
import { recordUsageEvent } from "./usage-events.mjs";
import {
  describeImage,
  evidenceCache,
  hasNativeSession,
  inputHasImage,
  nativeAccountKey,
  resolveVisionEngine,
  stripImages,
  substituteImages,
  supportsImageInput,
} from "./vision-bridge.mjs";
import { readHiddenModels } from "./model-picker-state.mjs";
import { readVisionBridgeSettings } from "./vision-bridge-state.mjs";
import { installedNativeVisionEngines } from "./vision-engines.mjs";
import { VERSION } from "./version.mjs";

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
  return headers;
}

function routedHeaders() {
  return {
    Authorization: `Bearer ${INTERNAL_KEY}`,
    "Content-Type": "application/json",
    "Accept-Encoding": "identity",
    "User-Agent": `codex-router/${VERSION}`,
  };
}

function nativeTarget(pathname, search) {
  const withoutV1 = pathname.replace(/^\/v1(?=\/|$)/, "");
  return `${NATIVE_BASE}${withoutV1}${search}`;
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

// Codex resends the whole conversation every turn, so the same screenshot
// arrives again on every follow-up. Without the hash cache a five-turn
// conversation about one image would buy the same transcript five times.
async function visionEvidenceFor(url, engine, signal, request, effort) {
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
  const key = `${engine.slug}\u0000${effort || "default"}\u0000${account}\u0000${url}`;
  const cached = evidenceCache.get(key);
  if (cached !== undefined) return cached;
  const text = await describeImage({
    engine,
    imageUrl: url,
    gatewayBase: GATEWAY_BASE,
    headers: routedHeaders(),
    nativeCall,
    effort,
    signal,
  });
  return evidenceCache.set(key, text);
}

// Text-only models get their images read by a vision-capable model the
// operator already enabled. Turns without images cost nothing here, and a
// model that reads images itself is never touched.
async function bridgeVisionInput(input, route, signal, request) {
  if (!inputHasImage(input)) return input;
  if (supportsImageInput(route)) return input;
  if (route.visionBridge === false) {
    return stripImages(input, `${route.displayName || route.slug} cannot read images`).input;
  }
  // Native candidates need two things at once, and neither is sufficient alone.
  // The shared helper (`src/vision-engines.mjs`) applies the same auth gate the
  // catalog build and the tray apply -- this path used to read the capture off
  // disk with no gate at all. But every on-disk artifact is reused across a
  // failed probe by design, so a sign-out leaves them naming an engine nothing
  // can call. The caller's live session is the evidence that cannot be stale,
  // so it has to hold too: without one there is no native engine to nominate,
  // and a pin naming one stops resolving on the very next paste rather than at
  // the next catalog rebuild.
  const nativeEngines =
    request && hasNativeSession(nativeHeaders(request))
      ? installedNativeVisionEngines({ hidden: readHiddenModels() })
      : [];
  const engine = resolveVisionEngine(
    [...selectedConfiguredListedModels(), ...nativeEngines],
    readVisionBridgeSettings(),
  );
  if (!engine) {
    // The catalog only advertises image input while an engine resolves, so
    // this is the race where one went away mid-conversation, or a client that
    // attached an image regardless.
    return stripImages(
      input,
      "the router's vision bridge is off or has no enabled vision model to read it with",
    ).input;
  }
  const engineName = engine.displayName || engine.slug;
  const { effort } = readVisionBridgeSettings();
  const result = await substituteImages(input, async (url) => ({
    text: await visionEvidenceFor(url, engine, signal, request, effort),
    engineName,
  }));
  if (!QUIET) {
    console.error(
      `[codex-router] vision-bridge model=${route.slug} engine=${engine.slug} ` +
        `images=${result.images} described=${result.described} failed=${result.failed}`,
    );
  }
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
  const bridged = await bridgeVisionInput(
    await normalizeRoutedAgentInput(request, originalInput, signal),
    route,
    signal,
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
  delete body.previous_response_id;
  delete body.client_metadata;
  const upstream = await fetch(`${GATEWAY_BASE}/responses`, {
    method: "POST",
    headers: routedHeaders(),
    body: JSON.stringify(body),
    signal,
  });
  const bytes = Buffer.from(await upstream.arrayBuffer());
  if (bytes.length > 32 * 1024 * 1024) {
    return { ok: false, status: 502, payload: { error: { message: "Compact response is too large." } } };
  }
  const parsed = JSON.parse(bytes.toString("utf8"));
  // Compaction is a plain non-streaming call, so the usage block (when the
  // provider sends one) is already in hand. `tokenUsageFromPayload` returns
  // undefined when it is absent, and `recordUsageEvent` then omits the token
  // fields entirely rather than metering an invented zero.
  const usage = tokenUsageFromPayload(parsed);
  if (!upstream.ok) {
    return { ok: false, status: upstream.status, payload: parsed, usage };
  }
  return { ok: true, summary: extractResponseText(parsed), input: originalInput, usage };
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
    return { status: result.status, usage: result.usage };
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
    return { status: 200, usage: result.usage };
  }
  writeJson(response, 200, { output: compactOutput(result.input, result.summary) });
  return { status: 200, usage: result.usage };
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
  try {
    if (!requireCodexTransport(request, response)) return;
    const encoded = await readRequestBody(request);
    const body = decodeBody(encoded, request.headers["content-encoding"]);
    const payload = parseBody(body);
    const requestedModel = typeof payload.model === "string" ? payload.model : "";
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
    const route = registeredRoute && readProviderSelection().includes(registeredRoute.provider)
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
      });
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
    let collaborationFlattened = false;
    if (route) {
      const input = await bridgeVisionInput(
        await normalizeRoutedAgentInput(request, payload.input, controller.signal),
        route,
        controller.signal,
        request,
      );
      const provider = providerForModel(route);
      // LiteLLM's Responses -> Chat Completions bridge drops namespace tools.
      // Chat-completions providers need the collaboration namespace flattened
      // into ordinary functions; the response transform maps calls back.
      if (provider?.protocol !== "openai-responses") {
        const flattened = flattenCollaborationNamespaceTools(payload.tools);
        collaborationFlattened = flattened.flattened;
        if (collaborationFlattened) payload.tools = flattened.tools;
      }
      const routed = {
        ...payload,
        model: route.gatewayModel,
        // The stored call history must use the same tool names as the tool
        // list, or the model copies the bare names out of its own transcript.
        input: collaborationFlattened ? flattenCollaborationHistory(input) : input,
      };
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
      target = `${GATEWAY_BASE}/responses`;
      headers = routedHeaders();
      routedBody = Buffer.from(JSON.stringify(routed), "utf8");
    } else {
      const native = { ...payload };
      if (Array.isArray(payload.input)) {
        native.input = normalizeNativeInput(payload.input);
      }
      if (!compactV1) delete native.previous_response_id;
      target = nativeTarget(requestUrl.pathname, requestUrl.search);
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
    const { response: upstream, retries: upstreamRetries } = await fetchWithRetry(
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
      });
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
    const usageTransform = new ResponseUsageTransform(
      upstream.headers.get("content-type") || "",
      {
        estimatedInputTokens:
          ZERO_INPUT_ESTIMATE && route
            ? estimateInputTokens(routedBody, { contextWindow: route.contextWindow })
            : undefined,
      },
    );
    const transforms = [usageTransform];
    if (collaborationFlattened) {
      transforms.push(new CollaborationToolCallTransform());
    }
    await pipeResponse(upstream, response, HOP_BY_HOP_HEADERS, transforms);
    const usage = usageTransform?.tokenUsage();
    const estimatedInputTokens = usageTransform?.substitutedInputTokens();
    // `retries` separates "it never failed" from "it failed and the router
    // absorbed it", both of which otherwise record a plain 200;
    // `estimatedInputTokens` separates a count the provider sent from one the
    // router had to invent. Neither is inferable from the rest of the event.
    recordUsageEvent({
      model: route?.slug || requestedModel,
      provider: route ? canonicalProviderId(route.provider) : "openai",
      status: upstream.status,
      durationMs: Date.now() - startedAt,
      retries: upstreamRetries,
      ...usage,
      estimatedInputTokens,
    });
    if (!QUIET) {
      // The substitution is named in the log line as well as the usage event:
      // a router that quietly invents token counts is its own trap.
      console.error(
        `[codex-router] model=${requestedModel || "unknown"} provider=${route?.provider || "openai"} status=${upstream.status}${
          upstreamRetries ? ` retries=${upstreamRetries}` : ""
        }${estimatedInputTokens ? ` estimated-input-tokens=${estimatedInputTokens}` : ""}`,
      );
    }
  } catch (error) {
    // A client that walked away (canceled generation, closed stream) is not
    // a router failure; only surface errors the router or upstream produced.
    if (clientGone) {
      activity.finish(0);
      return;
    }
    activity.finish(500);
    throw error;
  } finally {
    activity.finish(response.statusCode);
  }
}

async function handleNativeImage(request, response, requestUrl) {
  const startedAt = Date.now();
  const activity = beginRequestActivity();
  let clientGone = false;
  try {
    if (!requireCodexTransport(request, response)) return;
    const encoded = await readRequestBody(request);
    const body = decodeBody(encoded, request.headers["content-encoding"]);
    const payload = parseBody(body);
    const requestedModel =
      typeof payload.model === "string" ? payload.model : "gpt-image-2";
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
      nativeTarget(requestUrl.pathname, requestUrl.search),
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
    if (clientGone) {
      activity.finish(0);
      return;
    }
    activity.finish(500);
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
    await handleNativeImage(request, response, requestUrl);
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
    // indistinguishable in production. The cause belongs in the log; response
    // bodies never do, so only the error's own message and code are recorded.
    console.error(
      `[codex-router] request failed: ${
        error instanceof Error ? `${error.name}: ${error.message}` : String(error)
      }${error?.code ? ` (${error.code})` : ""}`,
    );
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
server.requestTimeout = 0;
server.headersTimeout = 65_000;
server.listen(LISTEN_PORT, LISTEN_HOST, () => {
  console.error("[codex-router] listening");
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
