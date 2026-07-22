import { readFileSync } from "node:fs";
import http from "node:http";
import { randomUUID } from "node:crypto";
import {
  brotliDecompressSync,
  gunzipSync,
  inflateSync,
  zstdDecompressSync,
} from "node:zlib";

import {
  assertCallerSecret,
  authenticatedRoute,
} from "./caller-auth.mjs";
import {
  HOP_BY_HOP_HEADERS,
  httpErrorStatus,
  MAX_BODY_BYTES,
  pipeResponse,
  readRequestBody,
  writeJson,
} from "./http-utils.mjs";
import { MERGED_CATALOG_PATH, PORTS, loopback } from "./paths.mjs";
import { MODEL_BY_SLUG, providerForModel } from "./model-registry.mjs";
import { readProviderSelection } from "./provider-selection.mjs";
import { ResponseUsageTransform } from "./response-usage.mjs";
import { recordUsageEvent } from "./usage-events.mjs";
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
const ERROR_STATUS_DURATION_MS = 8_000;

let requestSequence = 0;
const activeRequests = new Map();
let lastUsedProvider;
let lastUsedModel;
let errorStatusUntil = 0;

if (!INTERNAL_KEY) throw new Error("CODEX_ROUTER_INTERNAL_KEY is required.");
assertCallerSecret(CALLER_KEY);

function activityPayload() {
  const active = [...activeRequests.values()].filter(
    (entry) => entry && typeof entry === "object" && entry.provider,
  );
  const latest = active.at(-1);
  const provider = latest?.provider || lastUsedProvider;
  const model = latest?.model || lastUsedModel;
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
  };
}

function beginRequestActivity() {
  const requestId = ++requestSequence;
  activeRequests.set(requestId, null);
  let finished = false;
  return {
    setRoute({ provider, model } = {}) {
      if (!provider) return;
      const entry = {
        id: String(requestId),
        provider,
        ...(model ? { model } : {}),
        startedAt: Date.now(),
      };
      activeRequests.set(requestId, entry);
      lastUsedProvider = provider;
      if (model) lastUsedModel = model;
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
      const options = { maxOutputLength: MAX_BODY_BYTES };
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
    const wrapped = new Error(
      `Unable to decompress request body: ${error instanceof Error ? error.message : String(error)}`,
    );
    wrapped.status = 400;
    throw wrapped;
  }
  if (decoded.length > MAX_BODY_BYTES) {
    const error = new Error("Decoded request body is too large.");
    error.status = 413;
    throw error;
  }
  return decoded;
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

function catalogModels() {
  try {
    const parsed = JSON.parse(readFileSync(CATALOG_PATH, "utf8"));
    return Array.isArray(parsed.models) ? parsed.models : [];
  } catch {
    return [];
  }
}

async function serviceHealth(url) {
  try {
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${INTERNAL_KEY}` },
      signal: AbortSignal.timeout(1_000),
    });
    const raw = await response.json().catch(() => undefined);
    const payload = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
    return { ...payload, reachable: response.ok };
  } catch {
    return { reachable: false };
  }
}

async function healthPayload() {
  const [oauth, api, gateway] = await Promise.all([
    serviceHealth(OAUTH_HEALTH),
    serviceHealth(API_HEALTH),
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
    });
}

function normalizeNativeInput(input) {
  if (!Array.isArray(input)) return input;
  return input.map((item) => {
    if (item?.type !== "compaction") return item;
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

async function summarize(payload, route, signal) {
  const originalInput = Array.isArray(payload.input) ? payload.input : [];
  const body = {
    ...payload,
    model: route.gatewayModel,
    stream: false,
    tools: [],
    tool_choice: "none",
    input: [
      ...normalizeRoutedInput(originalInput),
      messageItem(COMPACT_PROMPT),
    ],
  };
  delete body.previous_response_id;
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
  if (!upstream.ok) return { ok: false, status: upstream.status, payload: parsed };
  return { ok: true, summary: extractResponseText(parsed), input: originalInput };
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

async function handleRoutedCompaction(response, payload, route, signal, v2) {
  const result = await summarize(payload, route, signal);
  if (!result.ok) {
    writeJson(response, result.status, result.payload);
    return;
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
    return;
  }
  writeJson(response, 200, { output: compactOutput(result.input, result.summary) });
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
  try {
    if (!requireCodexTransport(request, response)) return;
    const encoded = await readRequestBody(request);
    const body = decodeBody(encoded, request.headers["content-encoding"]);
    const payload = parseBody(body);
    const requestedModel = typeof payload.model === "string" ? payload.model : "";
    const registeredRoute = MODEL_BY_SLUG.get(requestedModel);
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
    activity.setRoute({
      provider: route?.provider || "openai",
      model: requestedModel || undefined,
    });
    const compactV1 = /\/responses\/compact$/.test(requestUrl.pathname);
    const compactV2 =
      route &&
      Array.isArray(payload.input) &&
      payload.input.at(-1)?.type === "compaction_trigger";

    const controller = new AbortController();
    request.once("aborted", () => controller.abort());
    response.once("close", () => {
      if (!response.writableEnded) controller.abort();
    });

    if (route && (compactV1 || compactV2)) {
      await handleRoutedCompaction(response, payload, route, controller.signal, compactV2);
      return;
    }

    let target;
    let headers;
    let routedBody;
    if (route) {
      const routed = {
        ...payload,
        model: route.gatewayModel,
        input: normalizeRoutedInput(payload.input),
      };
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
      routedBody = Buffer.from(JSON.stringify(native), "utf8");
    }

    const upstream = await fetch(target, {
      method: "POST",
      headers,
      body: routedBody,
      signal: controller.signal,
    });
    const usageTransform = route
      ? new ResponseUsageTransform(upstream.headers.get("content-type") || "")
      : undefined;
    await pipeResponse(upstream, response, HOP_BY_HOP_HEADERS, usageTransform);
    const usage = usageTransform?.tokenUsage();
    recordUsageEvent({
      model: requestedModel,
      provider: route?.provider || "openai",
      status: upstream.status,
      durationMs: Date.now() - startedAt,
      ...usage,
    });
    if (!QUIET) {
      console.error(
        `[codex-router] model=${requestedModel || "unknown"} provider=${route?.provider || "openai"} status=${upstream.status}`,
      );
    }
  } catch (error) {
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
  writeJson(response, 404, {
    error: { type: "proxy_route_not_found", message: "Unsupported router route." },
  });
}

const server = http.createServer((request, response) => {
  handleRequest(request, response).catch((error) => {
    const status = httpErrorStatus(error);
    console.error("[codex-router] request failed");
    if (!response.headersSent) {
      writeJson(response, status, {
        error: {
          type: "local_router_error",
          message: "The local router could not complete the request.",
        },
      });
    } else if (!response.writableEnded) {
      response.destroy();
    }
  });
});

server.on("upgrade", (_request, socket) => {
  socket.end(
    "HTTP/1.1 426 Upgrade Required\r\nConnection: close\r\nContent-Length: 0\r\n\r\n",
  );
});
server.requestTimeout = 0;
server.headersTimeout = 65_000;
server.listen(LISTEN_PORT, LISTEN_HOST, () => {
  console.error("[codex-router] listening");
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
