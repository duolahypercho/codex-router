import { randomUUID } from "node:crypto";
import { constants as bufferConstants } from "node:buffer";
import { TextDecoder } from "node:util";
import { boundImagePayload, boundedJsonByteLength, MAX_REQUEST_JSON_DEPTH } from "./prompt-image-budget.mjs";

import { authenticatedRoute, secretEqual } from "./caller-auth.mjs";
import {
  MAX_BODY_BYTES,
  MAX_BUFFERED_RESPONSE_BYTES,
  readResponseBody,
} from "./http-utils.mjs";
import { HeaderlessSseDetector } from "./sse-prefix.mjs";
import {
  MAX_FRAGMENT_FRAMES,
  RESPONSES_WEBSOCKET_BETA,
  WebSocketFrameParser,
  acceptUpgrade,
  closePayload,
  encodeFrame,
  rejectUpgrade,
  validWebSocketKey,
} from "./ws-frames.mjs";

// The beta token moved to ws-frames.mjs, which both directions of the
// protocol import; re-exported here for existing importers.
export { RESPONSES_WEBSOCKET_BETA } from "./ws-frames.mjs";

const RESPONSE_ROUTES = new Set(["/responses", "/v1/responses"]);
const FORWARDED_REQUEST_HEADERS = new Set([
  "authorization",
  "chatgpt-account-id",
  "openai-beta",
  "originator",
  "session_id",
  "session-id",
  "thread-id",
  "traceparent",
  "tracestate",
  "user-agent",
  "version",
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
const SAFE_RESPONSE_HEADERS = new Set([
  "openai-model",
  "retry-after",
  "x-codex-safety-buffering-enabled",
  "x-codex-safety-buffering-faster-model",
  "x-codex-turn-state",
  "x-models-etag",
  "x-reasoning-included",
]);
const WS_ONLY_CLIENT_METADATA_KEYS = new Set([
  "ws_request_header_traceparent",
  "ws_request_header_tracestate",
  "ws_request_header_x_openai_internal_codex_responses_lite",
  "x-codex-ws-stream-request-start-ms",
]);
const PER_REQUEST_IDENTITY_HEADERS = new Set([
  "session_id",
  "session-id",
  "thread-id",
  "traceparent",
  "tracestate",
  "x-client-request-id",
  "x-codex-installation-id",
  "x-codex-parent-thread-id",
  "x-codex-turn-metadata",
  "x-codex-turn-state",
  "x-codex-window-id",
  "x-openai-internal-codex-responses-lite",
  "x-openai-subagent",
]);
const MAX_QUEUED_REQUESTS = 2;
const MAX_INTERRUPT_PENDING_ITEMS = 256;
const MAX_TURN_METADATA_HEADER_BYTES = 8 * 1_024;
const MAX_RATE_LIMIT_FAMILIES = 16;
const MAX_RATE_LIMIT_FAMILY_CANDIDATES = 64;
const MAX_RATE_LIMIT_ID_BYTES = 64;
const MAX_RATE_LIMIT_NUMBER_BYTES = 64;
const MAX_RATE_LIMIT_TEXT_BYTES = 256;
const MAX_ERROR_PLAN_TYPE_BYTES = 128;
// openai/codex@63d2138 deserializes `resets_at` as an i64, then accepts it
// only when chrono 0.4.43 can construct a DateTime<Utc> from the seconds.
const MIN_CODEX_RESET_AT = -8_334_601_228_800;
const MAX_CODEX_RESET_AT = 8_210_266_876_799;
const RATE_LIMIT_FAMILY_ANCHOR = /^x-([a-z0-9]+(?:-[a-z0-9]+)*)-primary-used-percent$/;
const RATE_LIMIT_FAMILY_ID = /^[a-z0-9]+(?:[-_][a-z0-9]+)*$/i;
const RATE_LIMIT_REACHED_TYPES = new Set([
  "rate_limit_reached",
  "workspace_owner_credits_depleted",
  "workspace_member_credits_depleted",
  "workspace_owner_usage_limit_reached",
  "workspace_member_usage_limit_reached",
]);

function headerTokens(value) {
  return String(value || "")
    .split(",")
    .map((token) => token.trim().toLowerCase())
    .filter(Boolean);
}

function requestHasBeta(request) {
  return String(request.headers["openai-beta"] || "")
    .split(",")
    .map((value) => value.trim())
    .includes(RESPONSES_WEBSOCKET_BETA);
}

function isCallerAuthorization(value, callerKey) {
  if (typeof value !== "string") return false;
  const [scheme, ...rest] = value.trim().split(/[ \t]+/);
  return (
    scheme?.toLowerCase() === "bearer" &&
    rest.length === 1 &&
    secretEqual(rest[0], callerKey)
  );
}

function safeHeaderValue(value) {
  return typeof value === "string" && !value.includes("\r") && !value.includes("\n")
    ? value
    : undefined;
}

function metadataObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : undefined;
}

function canonicalClientMetadata(value) {
  const metadata = metadataObject(value);
  if (!metadata) return value;
  const canonical = { ...metadata };
  for (const name of WS_ONLY_CLIENT_METADATA_KEYS) delete canonical[name];
  return Object.keys(canonical).length > 0 ? canonical : undefined;
}

function compatibilityTurnMetadataHeader(value) {
  const encoded = safeHeaderValue(value);
  if (encoded === undefined) return undefined;
  let parsed;
  try {
    parsed = JSON.parse(encoded);
  } catch {
    return undefined;
  }
  const metadata = metadataObject(parsed);
  if (!metadata) return undefined;
  const compatibility = { ...metadata };
  // Official Codex deliberately keeps this unbounded inventory in canonical
  // client_metadata only. Projecting it into a header can exceed Node's
  // aggregate header limit before the loopback request reaches the router.
  delete compatibility.tool_namespaces_info;
  const headerValue = JSON.stringify(compatibility).replace(/[\u007f-\uffff]/g, (character) =>
    `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`
  );
  return Buffer.byteLength(headerValue, "utf8") <= MAX_TURN_METADATA_HEADER_BYTES
    ? headerValue
    : undefined;
}

function metadataHeaderProjections(value) {
  const metadata = metadataObject(value);
  if (!metadata) return new Map();
  const projected = new Map();
  for (const [metadataName, headerNames] of [
    ["session_id", ["session-id"]],
    ["thread_id", ["thread-id", "x-client-request-id"]],
    ["traceparent", ["traceparent"]],
    ["tracestate", ["tracestate"]],
    ["x-codex-installation-id", ["x-codex-installation-id"]],
    ["x-codex-parent-thread-id", ["x-codex-parent-thread-id"]],
    ["x-codex-turn-metadata", ["x-codex-turn-metadata"]],
    ["x-codex-turn-state", ["x-codex-turn-state"]],
    ["x-codex-window-id", ["x-codex-window-id"]],
    ["x-openai-subagent", ["x-openai-subagent"]],
    ["ws_request_header_traceparent", ["traceparent"]],
    ["ws_request_header_tracestate", ["tracestate"]],
    [
      "ws_request_header_x_openai_internal_codex_responses_lite",
      ["x-openai-internal-codex-responses-lite"],
    ],
  ]) {
    const headerValue = metadataName === "x-codex-turn-metadata"
      ? compatibilityTurnMetadataHeader(metadata[metadataName])
      : safeHeaderValue(metadata[metadataName]);
    if (headerValue !== undefined) {
      for (const headerName of headerNames) projected.set(headerName, headerValue);
    }
  }
  return projected;
}

function metadataTurnId(value) {
  const metadata = metadataObject(value);
  const encoded = metadata?.["x-codex-turn-metadata"];
  if (typeof encoded !== "string") return undefined;
  try {
    const parsed = JSON.parse(encoded);
    return typeof parsed?.turn_id === "string" && parsed.turn_id ? parsed.turn_id : undefined;
  } catch {
    return undefined;
  }
}

function loopbackHeaders(
  request,
  callerKey,
  clientMetadata,
  turnState,
  internalAuthorization,
) {
  const headers = {
    accept: "text/event-stream",
    "content-type": "application/json",
  };
  for (const name of FORWARDED_REQUEST_HEADERS) {
    let value = request.headers[name];
    if (value === undefined) continue;
    if (name === "authorization" && isCallerAuthorization(value, callerKey)) continue;
    // This beta token describes the edge transport. The internal hop is plain
    // HTTP Responses and must not advertise a WebSocket protocol to either the
    // router's native forwarder or a provider. Preserve any unrelated beta
    // flags the caller supplied.
    if (name === "openai-beta") {
      value = String(value)
        .split(",")
        .map((token) => token.trim())
        .filter((token) => token && token !== RESPONSES_WEBSOCKET_BETA)
        .join(", ");
      if (!value) continue;
    }
    headers[name] = Array.isArray(value) ? value.join(", ") : value;
  }
  // The handshake can be a startup prewarm, while each frame carries the
  // authoritative paid-turn metadata. Never let compatibility headers frozen
  // at upgrade time win over the per-request projection (or survive when the
  // current frame deliberately omits them).
  for (const name of PER_REQUEST_IDENTITY_HEADERS) delete headers[name];
  for (const [name, value] of metadataHeaderProjections(clientMetadata)) {
    headers[name] = value;
  }
  const currentTurnId = metadataTurnId(clientMetadata);
  const storedTurnState =
    turnState && (!currentTurnId || !turnState.turnId || currentTurnId === turnState.turnId)
      ? turnState.value
      : undefined;
  if (!headers["x-codex-turn-state"] && storedTurnState) {
    headers["x-codex-turn-state"] = storedTurnState;
  }
  const internalAuth = safeHeaderValue(internalAuthorization);
  if (internalAuth) headers.authorization = internalAuth;
  return headers;
}

function responseHeaders(response, { includeRateLimits = false } = {}) {
  const headers = {};
  for (const name of SAFE_RESPONSE_HEADERS) {
    const value = response.headers.get(name);
    if (value !== null) headers[name] = value;
  }
  if (includeRateLimits) Object.assign(headers, rateLimitResponseHeaders(response.headers));
  return Object.keys(headers).length > 0 ? headers : undefined;
}

async function sendSuccessfulResponseHeaders(peer, response) {
  const headers = responseHeaders(response) || {};
  const turnState = headers["x-codex-turn-state"];
  if (turnState !== undefined) {
    // Current Codex accepts sticky state only from response.metadata.
    if (!(await peer.sendJsonWithBackpressure({
      type: "response.metadata",
      headers: { "x-codex-turn-state": turnState },
    }))) return false;
  }

  const codexMetadataHeaders = {};
  for (const name of [
    "openai-model",
    "x-codex-safety-buffering-enabled",
    "x-codex-safety-buffering-faster-model",
    "x-models-etag",
  ]) {
    if (headers[name] !== undefined) codexMetadataHeaders[name] = headers[name];
  }
  if (Object.keys(codexMetadataHeaders).length > 0) {
    if (!(await peer.sendJsonWithBackpressure({
      type: "codex.response.metadata",
      headers: codexMetadataHeaders,
    }))) return false;
  }

  for (const rateLimits of rateLimitEvents(response.headers)) {
    if (!(await peer.sendJsonWithBackpressure(rateLimits))) return false;
  }

  if (headers["x-reasoning-included"] !== undefined) {
    // Codex reads this flag only from the HTTP 101 response. The internal HTTP
    // response arrives after that handshake, so no truthful WebSocket event can
    // retrofit it. Intentionally omit it instead of claiming transport parity.
  }
  return true;
}

function boundedRateLimitHeader(headers, name, maxBytes = MAX_RATE_LIMIT_TEXT_BYTES) {
  const raw = headers.get(name);
  if (
    raw === null ||
    raw.length === 0 ||
    Buffer.byteLength(raw, "utf8") > maxBytes ||
    /[\u0000-\u001f\u007f]/.test(raw)
  ) return undefined;
  return raw;
}

function finiteHeaderNumber(headers, name, { integer = false } = {}) {
  const raw = boundedRateLimitHeader(headers, name, MAX_RATE_LIMIT_NUMBER_BYTES);
  if (raw === undefined) return undefined;
  const pattern = integer
    ? /^[+-]?\d+$/
    : /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;
  if (!pattern.test(raw)) return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value)) return undefined;
  if (integer && !Number.isSafeInteger(value)) return undefined;
  return value;
}

function booleanHeader(headers, name) {
  const value = boundedRateLimitHeader(headers, name, 5)?.toLowerCase();
  if (value === "true" || value === "1") return true;
  if (value === "false" || value === "0") return false;
  return undefined;
}

function rateLimitWindow(headers, prefix) {
  const usedPercent = finiteHeaderNumber(headers, `${prefix}-used-percent`);
  if (usedPercent === undefined) return undefined;
  const windowMinutes = finiteHeaderNumber(headers, `${prefix}-window-minutes`, {
    integer: true,
  });
  const resetAt = finiteHeaderNumber(headers, `${prefix}-reset-at`, { integer: true });
  if (usedPercent === 0 && (!windowMinutes || windowMinutes === 0) && resetAt === undefined) {
    return undefined;
  }
  return {
    used_percent: usedPercent,
    ...(windowMinutes !== undefined ? { window_minutes: windowMinutes } : {}),
    ...(resetAt !== undefined ? { reset_at: resetAt } : {}),
  };
}

function rateLimitSnapshot(headers, familyId) {
  const headerFamilyId = familyId.replaceAll("_", "-");
  const prefix = `x-${headerFamilyId}`;
  const primary = rateLimitWindow(headers, `${prefix}-primary`);
  const secondary = rateLimitWindow(headers, `${prefix}-secondary`);
  const hasCredits = booleanHeader(headers, "x-codex-credits-has-credits");
  const unlimited = booleanHeader(headers, "x-codex-credits-unlimited");
  const balance = boundedRateLimitHeader(headers, "x-codex-credits-balance")?.trim();
  const credits = hasCredits !== undefined && unlimited !== undefined
    ? {
      has_credits: hasCredits,
      unlimited,
      ...(balance ? { balance } : {}),
    }
    : undefined;
  const limitName = boundedRateLimitHeader(headers, `${prefix}-limit-name`)?.trim();
  return {
    familyId,
    primary,
    secondary,
    credits,
    ...(limitName ? { limitName } : {}),
  };
}

function rateLimitEvent(snapshot) {
  const { familyId, primary, secondary, credits, limitName } = snapshot;
  return {
    type: "codex.rate_limits",
    metered_limit_name: familyId,
    ...(limitName ? { limit_name: limitName } : {}),
    ...(primary || secondary
      ? { rate_limits: { ...(primary ? { primary } : {}), ...(secondary ? { secondary } : {}) } }
      : {}),
    ...(credits ? { credits } : {}),
  };
}

function rateLimitSnapshots(headers) {
  const familyIds = new Set();
  for (const [name] of headers) {
    const match = RATE_LIMIT_FAMILY_ANCHOR.exec(name);
    if (!match) continue;
    const rawFamilyId = match[1];
    if (Buffer.byteLength(rawFamilyId, "ascii") > MAX_RATE_LIMIT_ID_BYTES) continue;
    const familyId = rawFamilyId.replaceAll("-", "_");
    if (familyId === "codex") continue;
    familyIds.add(familyId);
    if (familyIds.size >= MAX_RATE_LIMIT_FAMILY_CANDIDATES) break;
  }

  const snapshots = [];
  const defaultSnapshot = rateLimitSnapshot(headers, "codex");
  if (defaultSnapshot.primary || defaultSnapshot.secondary || defaultSnapshot.credits) {
    snapshots.push(defaultSnapshot);
  }
  for (const familyId of [...familyIds].sort()) {
    const snapshot = rateLimitSnapshot(headers, familyId);
    if (snapshot.primary || snapshot.secondary || snapshot.credits) snapshots.push(snapshot);
    if (snapshots.length >= MAX_RATE_LIMIT_FAMILIES) break;
  }
  return snapshots;
}

function rateLimitEvents(headers) {
  return rateLimitSnapshots(headers).map(rateLimitEvent);
}

function rateLimitResponseHeaders(headers) {
  const projected = {};
  const projectedFamilyIds = new Set();
  for (const snapshot of rateLimitSnapshots(headers)) {
    const prefix = `x-${snapshot.familyId.replaceAll("_", "-")}`;
    const discoveryUsedPercent = finiteHeaderNumber(headers, `${prefix}-primary-used-percent`);
    if (snapshot.familyId !== "codex" && discoveryUsedPercent === undefined) continue;
    if (snapshot.familyId !== "codex" && !snapshot.primary) {
      // A valid all-zero primary window is still the header that lets Codex
      // rediscover this named family after unwrapping the WebSocket error.
      projected[`${prefix}-primary-used-percent`] = String(discoveryUsedPercent);
    }
    for (const [windowName, window] of [
      ["primary", snapshot.primary],
      ["secondary", snapshot.secondary],
    ]) {
      if (!window) continue;
      projected[`${prefix}-${windowName}-used-percent`] = String(window.used_percent);
      if (window.window_minutes !== undefined) {
        projected[`${prefix}-${windowName}-window-minutes`] = String(window.window_minutes);
      }
      if (window.reset_at !== undefined) {
        projected[`${prefix}-${windowName}-reset-at`] = String(window.reset_at);
      }
    }
    if (snapshot.limitName) projected[`${prefix}-limit-name`] = snapshot.limitName;
    if (snapshot.credits) {
      projected["x-codex-credits-has-credits"] = String(snapshot.credits.has_credits);
      projected["x-codex-credits-unlimited"] = String(snapshot.credits.unlimited);
      if (snapshot.credits.balance !== undefined) {
        projected["x-codex-credits-balance"] = snapshot.credits.balance;
      }
    }
    projectedFamilyIds.add(snapshot.familyId);
  }
  const activeLimit = boundedRateLimitHeader(
    headers,
    "x-codex-active-limit",
    MAX_RATE_LIMIT_ID_BYTES,
  )?.trim();
  if (activeLimit && RATE_LIMIT_FAMILY_ID.test(activeLimit)) {
    const normalizedActiveLimit = activeLimit.toLowerCase().replaceAll("-", "_");
    if (projectedFamilyIds.has(normalizedActiveLimit)) {
      projected["x-codex-active-limit"] = normalizedActiveLimit;
    }
  }
  const reachedType = boundedRateLimitHeader(
    headers,
    "x-codex-rate-limit-reached-type",
    MAX_RATE_LIMIT_ID_BYTES,
  )?.trim();
  if (RATE_LIMIT_REACHED_TYPES.has(reachedType)) {
    projected["x-codex-rate-limit-reached-type"] = reachedType;
  }
  return projected;
}

// The frame's byte cap is already enforced. Reject pathological nesting before
// JSON.parse allocates a tree, counting delimiters only outside quoted strings.
function jsonNestingAllowed(text) {
  let depth = 0, quoted = false, escaped = false;
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    if (quoted) {
      if (escaped) escaped = false;
      else if (code === 0x5c) escaped = true;
      else if (code === 0x22) quoted = false;
    } else if (code === 0x22) quoted = true;
    else if (code === 0x7b || code === 0x5b) {
      if (++depth > MAX_REQUEST_JSON_DEPTH) return false;
    } else if (code === 0x7d || code === 0x5d) depth--;
  }
  return true;
}

function continuationState(input, output, maxBytes) {
  const bounded = boundImagePayload([...input, ...output], {
    protectPending: true, maxTokens: Infinity,
    maxBodyBytes: maxBytes, bodyBytes: boundedJsonByteLength({ input, output }),
  });
  const state = { input: bounded.input.slice(0, input.length), output: bounded.input.slice(input.length) };
  return boundedJsonByteLength(state, maxBytes) <= maxBytes ? state : undefined;
}

function continuationItemKey(item) {
  if (typeof item?.call_id === "string" && item.call_id) return `call:${item.call_id}`;
  if (typeof item?.id === "string" && item.id) return `id:${item.id}`;
  return undefined;
}

function reconciledContinuationOutput(completedOutput, outputItems) {
  if (!Array.isArray(completedOutput)) return outputItems;
  if (!Array.isArray(outputItems) || outputItems.length === 0) return completedOutput;

  const doneByKey = new Map();
  for (const item of outputItems) {
    const key = continuationItemKey(item);
    if (key) doneByKey.set(key, item);
  }

  const used = new Set();
  const reconciled = completedOutput.map((item) => {
    const key = continuationItemKey(item);
    const done = key ? doneByKey.get(key) : undefined;
    if (!done) return item;
    used.add(done);
    return done;
  });
  for (const item of outputItems) {
    if (!used.has(item)) reconciled.push(item);
  }
  return reconciled;
}
function errorShape(body, fallback) {
  let parsed;
  try {
    parsed = JSON.parse(body.toString("utf8"));
  } catch {
    parsed = undefined;
  }
  const source = parsed?.error && typeof parsed.error === "object"
    ? parsed.error
    : parsed && typeof parsed === "object"
      ? parsed
      : {};
  const planType = typeof source.plan_type === "string" &&
      Buffer.byteLength(source.plan_type, "utf8") <= MAX_ERROR_PLAN_TYPE_BYTES
    ? source.plan_type
    : undefined;
  const resetsAt = Number.isSafeInteger(source.resets_at) &&
      source.resets_at >= MIN_CODEX_RESET_AT &&
      source.resets_at <= MAX_CODEX_RESET_AT
    ? source.resets_at
    : undefined;
  return {
    type: typeof source.type === "string" ? source.type : fallback.type,
    ...(typeof source.code === "string" ? { code: source.code } : {}),
    message: typeof source.message === "string" ? source.message : fallback.message,
    ...(planType !== undefined ? { plan_type: planType } : {}),
    ...(resetsAt !== undefined ? { resets_at: resetsAt } : {}),
  };
}

function responseWithBody(upstream, body) {
  return new Response(body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: upstream.headers,
  });
}

async function sniffUndeclaredResponse(upstream, signal) {
  if (!upstream.body) return { kind: "other", response: upstream };
  const [probe, relay] = upstream.body.tee();
  const reader = probe.getReader();
  const detector = new HeaderlessSseDetector();
  let decision = "pending";
  try {
    while (decision === "pending") {
      signal?.throwIfAborted();
      const result = await reader.read();
      if (result.done) {
        decision = detector.end().decision;
        break;
      }
      decision = detector.write(result.value).decision;
    }
  } catch (error) {
    void relay.cancel().catch(() => {});
    throw error;
  } finally {
    void reader.cancel().catch(() => {});
  }
  return {
    kind: decision === "event-stream" ? "event-stream" : "other",
    response: responseWithBody(upstream, relay),
  };
}

async function relaySse(body, onEvent, { signal, maxEventBytes }) {
  if (!body) throw new Error("The internal Responses endpoint returned no stream.");
  const reader = body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let text = "";
  let dataLines = [];
  let dataChars = 0;
  const checkLineSize = (line) => {
    if (Buffer.byteLength(line, "utf8") <= maxEventBytes) return;
    const error = new Error(`Responses SSE line exceeds ${maxEventBytes} bytes.`);
    error.code = "ERR_RESPONSES_WS_EVENT_TOO_LARGE";
    throw error;
  };
  const dispatch = async () => {
    if (dataLines.length === 0) return true;
    const data = dataLines.join("\n");
    dataLines = [];
    dataChars = 0;
    if (data === "[DONE]") return true;
    return onEvent(data);
  };
  const consumeLine = async (line) => {
    checkLineSize(line);
    if (line.endsWith("\r")) line = line.slice(0, -1);
    if (line === "") return dispatch();
    if (line.startsWith(":")) return true;
    if (!line.startsWith("data:")) return true;
    let value = line.slice(5);
    if (value.startsWith(" ")) value = value.slice(1);
    // Count the separator as well as the data. Without that byte, an event
    // made from an unbounded number of empty `data:` lines could grow the
    // line array without ever advancing the payload limit.
    dataChars += Buffer.byteLength(value, "utf8") + 1;
    if (dataChars > maxEventBytes) {
      const error = new Error(`Responses SSE event exceeds ${maxEventBytes} bytes.`);
      error.code = "ERR_RESPONSES_WS_EVENT_TOO_LARGE";
      throw error;
    }
    dataLines.push(value);
    return true;
  };
  try {
    while (true) {
      if (signal.aborted) throw signal.reason || new Error("WebSocket closed.");
      const { done, value } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
      // An HTTP chunk can contain many bounded events. Check each complete
      // line while consuming it, then bound only the unfinished line left over.
      let newline;
      while ((newline = text.indexOf("\n")) !== -1) {
        const line = text.slice(0, newline);
        text = text.slice(newline + 1);
        if ((await consumeLine(line)) === false) return;
      }
      checkLineSize(text);
    }
    text += decoder.decode();
    if (text && (await consumeLine(text)) === false) return;
    await dispatch();
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock?.();
  }
}

class ResponsesWebSocketPeer {
  constructor(socket, request, options) {
    this.socket = socket;
    this.request = request;
    this.options = options;
    this.closed = false;
    this.closeSent = false;
    this.pendingRequests = 0;
    this.queue = Promise.resolve();
    this.abortController = new AbortController();
    this.continuations = new Map();
    this.turnState = undefined;
    this.activeResponse = undefined;
    this.lastResponseId = undefined;
    // The peer is the server side, so it parses masked client frames and
    // answers pings itself; the shared codec owns every frame-level rule.
    this.parser = new WebSocketFrameParser({
      expectMasked: true,
      maxMessageBytes: options.maxMessageBytes || MAX_BODY_BYTES,
      maxFragmentFrames: options.maxFragmentFrames || MAX_FRAGMENT_FRAMES,
      onText: (text) => this.enqueue(text),
      onBinary: () =>
        this.fail(1003, "Binary Responses WebSocket messages are not supported."),
      onPing: (payload) => this.send(0xa, payload),
      onPong: () => {},
      onClose: ({ code, reason }) => {
        if (!this.closeSent) {
          this.closeSent = true;
          this.send(0x8, code === undefined ? Buffer.alloc(0) : closePayload(code, reason));
        }
        this.socket.end();
        this.abort();
      },
      onFail: (code, reason) => this.fail(code, reason),
    });
  }

  start(head) {
    this.socket.on("error", () => this.abort({ hard: true }));
    this.socket.on("close", () => this.abort({ hard: true }));
    this.socket.on("end", () => this.abort({ hard: true }));
    this.socket.on("data", (chunk) => this.parser.feed(chunk));
    if (head?.length) this.parser.feed(head);
    this.socket.resume?.();
  }

  // `hard` is for transport-level ends (FIN, reset, error): the peer is not
  // reading any more, so a queued frame can never drain and waiting for it
  // would hold the descriptor open. A received close frame keeps the graceful
  // path so the close reply still flushes before the socket is released.
  abort({ hard = false } = {}) {
    if (this.closed) {
      // A close reply may still be blocked in destroySoon(). A later FIN or
      // error must release the transport without repeating turn cancellation.
      if (hard && !this.socket.destroyed) this.socket.destroy();
      return;
    }
    this.closed = true;
    this.parser.stop();
    this.abortController.abort(new Error("Responses WebSocket closed."));
    this.continuations.clear();
    // The upgraded socket came from http.Server, which allows half-open
    // connections, so a peer that goes away without a close frame ends only
    // the readable side. Nothing else closes the writable side, and Node keeps
    // the descriptor until something does: one leaked handle per dropped
    // connection, for the life of the process.
    if (this.socket.destroyed) return;
    if (hard) this.socket.destroy();
    else this.socket.destroySoon();
  }

  send(opcode, payload) {
    if (this.closed || this.socket.destroyed || !this.socket.writable) return false;
    return this.socket.write(encodeFrame(opcode, payload));
  }

  sendJson(value) {
    return this.send(0x1, Buffer.from(JSON.stringify(value), "utf8"));
  }

  async sendJsonWithBackpressure(value) {
    if (this.sendJson(value)) return true;
    if (this.closed || this.socket.destroyed) return false;
    await new Promise((resolve) => {
      const finish = () => {
        this.socket.off("drain", finish);
        this.socket.off("close", finish);
        this.socket.off("error", finish);
        resolve();
      };
      this.socket.once("drain", finish);
      this.socket.once("close", finish);
      this.socket.once("error", finish);
    });
    return !this.closed && !this.socket.destroyed;
  }

  sendError(status, error, headers) {
    this.sendJson({
      type: "error",
      status,
      error,
      ...(headers ? { headers } : {}),
    });
  }

  fail(code, reason) {
    if (this.closed) return;
    if (!this.closeSent) {
      this.closeSent = true;
      this.send(0x8, closePayload(code, reason));
    }
    this.socket.end();
    this.abort();
  }

  enqueue(text) {
    // Control messages must bypass the generation queue: queuing interrupt
    // behind the turn it interrupts leaves a 400 for the following turn.
    const request = this.parseRequest(text);
    if (!request) return;
    if (request.type === "response.interrupt") {
      this.interrupt(request);
      return;
    }
    this.pendingRequests += 1;
    if (this.pendingRequests > MAX_QUEUED_REQUESTS) {
      this.fail(1008, "Too many queued Responses requests.");
      return;
    }
    this.queue = this.queue
      .then(() => this.process(request))
      .catch(() => {
        if (!this.closed) {
          this.sendError(500, {
            type: "local_router_error",
            message: "The local router could not complete the WebSocket request.",
          });
        }
      })
      .finally(() => {
        this.pendingRequests -= 1;
      });
  }

  parseRequest(text) {
    if (this.closed) return;
    if (!jsonNestingAllowed(text)) {
      this.sendError(400, {
        type: "invalid_request_error",
        message: "Responses request JSON is nested too deeply.",
      });
      return;
    }
    let request;
    try {
      request = JSON.parse(text);
    } catch {
      this.sendError(400, {
        type: "invalid_request_error",
        message: "Responses WebSocket messages must contain valid JSON.",
      });
      return;
    }
    if (!request || typeof request !== "object" || Array.isArray(request) ||
        !["response.create", "response.interrupt"].includes(request.type)) {
      this.sendError(400, {
        type: "invalid_request_error",
        code: "unsupported_websocket_event",
        message: "Responses WebSocket messages must have type response.create or response.interrupt.",
      });
      return;
    }
    return request;
  }

  interrupt(request) {
    if (typeof request.response_id !== "string" || !request.response_id ||
        request.mode !== "discard_partial_items") {
      this.sendError(400, {
        type: "invalid_request_error",
        message: "response.interrupt requires response_id and mode=discard_partial_items.",
      });
      return;
    }
    const active = this.activeResponse;
    // Completion can win the race with a client's interrupt frame. Its
    // terminal event already settles the turn; do not poison socket reuse.
    if (request.response_id === this.lastResponseId && active?.id !== request.response_id) return;
    if (!active || active.id !== request.response_id) {
      this.sendError(400, {
        type: "invalid_request_error",
        code: "response_not_found",
        message: "The response to interrupt is not active on this connection.",
      });
      return;
    }
    if (active.interrupted || active.terminalSent) return;
    active.interrupted = true;
    this.sendJson({
      type: "response.interrupt.accepted", response_id: active.id,
      sequence_number: active.nextSequence++,
    });
    active.controller.abort(new Error("Responses generation interrupted by the client."));
  }

  async finishInterrupted(active) {
    for (const [output_index, item_id] of active.pendingItems) {
      if (!(await this.sendJsonWithBackpressure({
        type: "response.output_item.interrupted", response_id: active.id,
        item_id, output_index, sequence_number: active.nextSequence++,
      }))) return;
    }
    const terminal = {
      type: "response.incomplete", sequence_number: active.nextSequence++,
      response: {
        id: active.id, object: "response", status: "incomplete",
        incomplete_details: { reason: "interrupted" },
        output: active.completedItems,
        ...(active.usage ? { usage: active.usage } : {}),
      },
    };
    if (boundedJsonByteLength(terminal, this.options.maxEventBytes) > this.options.maxEventBytes) {
      this.continuations.clear();
      this.sendError(502, {
        type: "ERR_RESPONSES_WS_INTERRUPT_STATE_TOO_LARGE",
        message: "The interrupted response exceeds the bounded WebSocket snapshot size; resend the full context.",
      });
      return;
    }
    active.terminalSent = true;
    if (!(await this.sendJsonWithBackpressure(terminal))) return;
    this.lastResponseId = active.id;
    this.continuations.clear();
    const continuation = continuationState(
      active.input, active.completedItems, this.options.maxContinuationBytes,
    );
    if (continuation && !active.continuationOverflow) this.continuations.set(active.id, continuation);
  }

  async process(request) {
    if (this.closed) return;
    if (!Array.isArray(request.input) || request.stream !== true) {
      this.sendError(400, {
        type: "invalid_request_error",
        message: "response.create requires an input array and stream=true.",
      });
      return;
    }

    const fullRequest = { ...request };
    const clientMetadata = fullRequest.client_metadata;
    delete fullRequest.type;
    delete fullRequest.generate;
    delete fullRequest.previous_response_id;
    // client_metadata is the canonical per-request Codex metadata transport.
    // Keep it on the internal HTTP body so native traffic receives it; the
    // ordinary router path already removes it from routed-provider payloads.
    // Only WebSocket timing/trace projections are translated to headers and
    // removed from the HTTP body.
    const canonicalMetadata = canonicalClientMetadata(clientMetadata);
    if (canonicalMetadata === undefined) delete fullRequest.client_metadata;
    else fullRequest.client_metadata = canonicalMetadata;
    const previousId = typeof request.previous_response_id === "string"
      ? request.previous_response_id
      : undefined;
    if (previousId) {
      const previous = this.continuations.get(previousId);
      if (!previous) {
        this.sendError(409, {
          type: "invalid_request_error",
          code: "previous_response_not_found",
          message: "Previous response was not found. Retrying the full request.",
        });
        return;
      }
      fullRequest.input = [
        ...previous.input,
        ...previous.output,
        ...request.input,
      ];
    }
    // Codex's ResponseCreateWsRequest serializes every stable non-input field
    // on incremental frames; only `input` becomes the suffix and
    // `previous_response_id` names its baseline. Keep the current envelope as
    // authority. Inheriting absent fields from an earlier request would turn a
    // meaningful omission (for example no tools) into stale configuration.
    let boundedImages;
    try {
      boundedImages = boundImagePayload(fullRequest.input, {
        protectPending: true, maxTokens: Infinity,
        maxBodyBytes: this.options.maxMessageBytes, bodyBytes: boundedJsonByteLength(fullRequest),
      });
    } catch {
      this.sendError(400, {
        type: "invalid_request_error",
        message: "Responses request JSON is nested too deeply.",
      });
      return;
    }
    fullRequest.input = boundedImages.input;
    if (boundedImages.stats.imageReferencesDropped > 0) {
      console.error(`[codex-router] bounded WebSocket image history dropped=${boundedImages.stats.imageReferencesDropped} image-bytes-saved=${boundedImages.stats.imageBytesSaved}`);
    }
    if (boundedJsonByteLength(fullRequest, this.options.maxMessageBytes) > this.options.maxMessageBytes) {
      this.sendError(413, {
        type: "request_too_large",
        message: `Reconstructed Responses request exceeds ${this.options.maxMessageBytes} bytes.`,
      });
      return;
    }
    const encoded = Buffer.from(JSON.stringify(fullRequest), "utf8");

    if (request.generate === false) {
      const responseId = `resp_router_prewarm_${randomUUID().replaceAll("-", "")}`;
      this.lastResponseId = responseId;
      this.continuations.clear();
      const continuation = continuationState(fullRequest.input, [], this.options.maxContinuationBytes);
      if (continuation) this.continuations.set(responseId, continuation);
      await this.sendJsonWithBackpressure({
        type: "response.created",
        response: { id: responseId },
      });
      await this.sendJsonWithBackpressure({
        type: "response.completed",
        response: {
          id: responseId,
          usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
        },
      });
      return;
    }

    const controller = new AbortController();
    const active = {
      controller, id: undefined, interrupted: false, terminalSent: false,
      nextSequence: 0, completedItems: [], pendingItems: new Map(),
      input: fullRequest.input, continuationOverflow: false,
      completedBytes: 0, pendingBytes: 0,
    };
    this.activeResponse = active;
    const onClose = () => controller.abort(this.abortController.signal.reason);
    this.abortController.signal.addEventListener("abort", onClose, { once: true });
    let upstream;
    try {
      upstream = await this.options.fetchImpl(this.options.responsesUrl, {
        method: "POST",
        headers: loopbackHeaders(
          this.request,
          this.options.callerKey,
          clientMetadata,
          this.turnState,
          this.options.internalAuthorization,
        ),
        body: encoded,
        signal: controller.signal,
      });
      if (!upstream.ok) {
        const body = await readResponseBody(upstream, {
          maxBytes: this.options.maxErrorBytes,
          signal: controller.signal,
        });
        this.sendError(
          upstream.status,
          errorShape(body, {
            type: "local_router_error",
            message: "The local router rejected the Responses request.",
          }),
          responseHeaders(upstream, { includeRateLimits: true }),
        );
        return;
      }
      const responseTurnState = safeHeaderValue(upstream.headers.get("x-codex-turn-state"));
      const currentTurnId = metadataTurnId(clientMetadata);
      if (
        responseTurnState &&
        (!this.turnState?.value || (currentTurnId && currentTurnId !== this.turnState.turnId))
      ) {
        this.turnState = { value: responseTurnState, turnId: currentTurnId };
      }
      let contentType = String(upstream.headers.get("content-type") || "").toLowerCase();
      const declaredMediaType = contentType.split(";", 1)[0].trim();
      const declaredJson =
        declaredMediaType === "application/json" || declaredMediaType.endsWith("+json");
      if (!contentType.includes("text/event-stream") && !declaredJson) {
        // A completed internal request must not be discarded solely because a
        // loopback hop omitted or misdeclared Content-Type. Sniff only enough
        // bytes to prove SSE framing; otherwise retain the untouched body and
        // validate it through the bounded completed-JSON path below.
        const detected = await sniffUndeclaredResponse(upstream, controller.signal);
        upstream = detected.response;
        if (detected.kind === "event-stream") contentType = "text/event-stream";
      }
      if (!contentType.includes("text/event-stream")) {
        const body = await readResponseBody(upstream, {
          maxBytes: this.options.maxEventBytes,
          signal: controller.signal,
        });
        let completedResponse;
        try {
          completedResponse = JSON.parse(body.toString("utf8"));
        } catch {
          this.sendError(502, {
            type: "local_router_protocol_error",
            message: "The internal Responses endpoint returned invalid response JSON.",
          });
          return;
        }
        if (
          !completedResponse ||
          typeof completedResponse !== "object" ||
          Array.isArray(completedResponse) ||
          typeof completedResponse.id !== "string" ||
          completedResponse.id.length === 0 ||
          completedResponse.status !== "completed" ||
          !Array.isArray(completedResponse.output)
        ) {
          this.sendError(502, {
            type: "local_router_protocol_error",
            message: "The internal Responses endpoint returned an invalid completed response.",
          });
          return;
        }
        if (!(await sendSuccessfulResponseHeaders(this, upstream))) return;
        active.id = completedResponse.id;
        // The JSON origin has already completed these items and charged its
        // usage, even if downstream write backpressure delays their delivery.
        active.completedItems = completedResponse.output;
        active.usage = completedResponse.usage;
        if (!(await this.sendJsonWithBackpressure({
          type: "response.created",
          response: { ...completedResponse, status: "in_progress", output: [] },
        }))) return;
        for (const [outputIndex, item] of completedResponse.output.entries()) {
          if (active.interrupted) return;
          if (!(await this.sendJsonWithBackpressure({
            type: "response.output_item.done",
            output_index: outputIndex,
            item,
          }))) return;
        }
        if (active.interrupted) return;
        active.terminalSent = true;
        if (!(await this.sendJsonWithBackpressure({
          type: "response.completed",
          response: completedResponse,
        }))) return;
        this.lastResponseId = completedResponse.id;
        this.continuations.clear();
        const continuation = continuationState(
          fullRequest.input,
          completedResponse.output,
          this.options.maxContinuationBytes,
        );
        if (continuation) this.continuations.set(completedResponse.id, continuation);
        return;
      }
      if (!(await sendSuccessfulResponseHeaders(this, upstream))) return;
      const outputItems = [];
      let outputItemsBytes = 0;
      let continuationOverflow = false;
      let completed;
      let terminalFailure = false;
      let terminalSeen = false;
      await relaySse(
        upstream.body,
        async (data) => {
          let event;
          try {
            event = JSON.parse(data);
          } catch {
            const error = new Error("The internal Responses endpoint emitted invalid SSE JSON.");
            error.code = "ERR_RESPONSES_WS_INVALID_SSE";
            throw error;
          }
          if (!event || typeof event !== "object" || Array.isArray(event)) return true;
          // Do not let post-terminal trailers mutate interruption snapshots.
          if (terminalSeen) return true;
          if (active.interrupted) return false;
          if (Number.isSafeInteger(event.sequence_number) && event.sequence_number >= 0) {
            active.nextSequence = Math.max(active.nextSequence, event.sequence_number + 1);
          }
          if (event.type === "response.created" && typeof event.response?.id === "string") active.id = event.response.id;
          if (event.response?.usage && typeof event.response.usage === "object") active.usage = event.response.usage;
          if (event.type === "response.output_item.added" &&
              Number.isSafeInteger(event.output_index) && event.output_index >= 0 &&
              typeof event.item?.id === "string") {
            const previous = active.pendingItems.get(event.output_index);
            const pendingBytes = active.pendingBytes - Buffer.byteLength(previous || "")
              + Buffer.byteLength(event.item.id);
            if (pendingBytes > this.options.maxEventBytes ||
                (!previous && active.pendingItems.size >= MAX_INTERRUPT_PENDING_ITEMS)) {
              const error = new Error("The interrupted response item tracker exceeds its bounded size.");
              error.code = "ERR_RESPONSES_WS_INTERRUPT_STATE_TOO_LARGE";
              throw error;
            }
            active.pendingItems.set(event.output_index, event.item.id);
            active.pendingBytes = pendingBytes;
          }
          if (event.type === "response.output_item.done") {
            active.pendingBytes -= Buffer.byteLength(active.pendingItems.get(event.output_index) || "");
            active.pendingItems.delete(event.output_index);
          }
          // Match the Responses client: the first terminal event ends the
          // logical response. Drain the HTTP body for clean accounting and
          // connection reuse, but never graft a provider trailer onto the next
          // continuation baseline.
          // Native Codex maps WebSocket `error` events only when they carry
          // an HTTP failure status. SSE can instead signal failure by ending
          // its body; the persistent socket has no such turn boundary.
          if (event.type === "error" &&
              !(Number.isInteger(event.status) && event.status >= 400 && event.status <= 599)) {
            event = { ...event, status: 502 };
          }
          if (["response.completed", "response.failed", "response.incomplete", "error"].includes(event.type)) {
            active.terminalSent = true;
            if (active.id) this.lastResponseId = active.id;
          }
          if (event.type === "response.output_item.done" && event.item) {
            const itemBytes = Buffer.byteLength(JSON.stringify(event.item), "utf8");
            if (active.completedBytes + itemBytes > this.options.maxEventBytes) {
              const error = new Error("The interrupted response snapshot exceeds its bounded size.");
              error.code = "ERR_RESPONSES_WS_INTERRUPT_STATE_TOO_LARGE";
              throw error;
            }
            active.completedItems.push(event.item);
            active.completedBytes += itemBytes;
            if (outputItemsBytes + itemBytes <= this.options.maxContinuationBytes) {
              outputItems.push(event.item);
              outputItemsBytes += itemBytes;
            } else {
              continuationOverflow = true;
              active.continuationOverflow = true;
            }
          }
          if (!(await this.sendJsonWithBackpressure(event))) return false;
          if (event.type === "response.completed") {
            completed = event.response;
            terminalSeen = true;
            return true;
          }
          if (["error", "response.failed", "response.incomplete"].includes(event.type)) {
            terminalFailure = true;
            terminalSeen = true;
            // Codex ends the turn on this event and may send its retry on the
            // same socket, where it queues behind this drain. A gateway that
            // holds the stream open after a failure must not stall that retry.
            setTimeout(() => controller.abort(), 5_000).unref?.();
            return true;
          }
          return true;
        },
        {
          signal: controller.signal,
          maxEventBytes: this.options.maxEventBytes,
        },
      );
      if (completed?.id && !terminalFailure) {
        const output = reconciledContinuationOutput(completed.output, outputItems);
        this.continuations.clear();
        const continuation = !continuationOverflow
          ? continuationState(
            fullRequest.input,
            output,
            this.options.maxContinuationBytes,
          )
          : undefined;
        if (continuation) this.continuations.set(completed.id, continuation);
      } else if (!terminalFailure && !this.closed && !active.interrupted) {
        this.sendError(502, {
          type: "local_router_stream_failed",
          message: "The internal Responses stream ended before response.completed.",
        });
      }
    } catch (error) {
      if (!this.closed && !controller.signal.aborted) {
        this.sendError(502, {
          type: error?.code || "local_router_stream_failed",
          message: "The local router lost the internal Responses stream.",
        });
      }
    } finally {
      this.abortController.signal.removeEventListener("abort", onClose);
      controller.abort();
      if (active.interrupted && !active.terminalSent && !this.closed) await this.finishInterrupted(active);
      if (this.activeResponse === active) this.activeResponse = undefined;
    }
  }
}

export function handleResponsesWebSocketUpgrade(
  request,
  socket,
  head,
  {
    callerKey,
    responsesUrl,
    authenticateUpgrade,
    internalAuthorization,
    fetchImpl = fetch,
    maxMessageBytes = MAX_BODY_BYTES,
    maxEventBytes = MAX_BUFFERED_RESPONSE_BYTES,
    maxErrorBytes = MAX_BUFFERED_RESPONSE_BYTES,
    maxContinuationBytes = maxMessageBytes,
    maxFragmentFrames = MAX_FRAGMENT_FRAMES,
  },
) {
  maxMessageBytes = Number.isFinite(maxMessageBytes) && maxMessageBytes > 0
    ? Math.min(Math.floor(maxMessageBytes), bufferConstants.MAX_STRING_LENGTH)
    : Math.min(
      Number.isFinite(MAX_BODY_BYTES) && MAX_BODY_BYTES > 0 ? Math.floor(MAX_BODY_BYTES) : 128 * 1024 * 1024,
      bufferConstants.MAX_STRING_LENGTH,
    );
  maxEventBytes = Number.isFinite(maxEventBytes) && maxEventBytes > 0
    ? Math.floor(maxEventBytes)
    : MAX_BUFFERED_RESPONSE_BYTES;
  maxErrorBytes = Number.isFinite(maxErrorBytes) && maxErrorBytes > 0
    ? Math.floor(maxErrorBytes)
    : MAX_BUFFERED_RESPONSE_BYTES;
  maxContinuationBytes = Number.isFinite(maxContinuationBytes) && maxContinuationBytes > 0
    ? Math.floor(maxContinuationBytes)
    : maxMessageBytes;
  maxFragmentFrames = Number.isFinite(maxFragmentFrames) && maxFragmentFrames > 0
    ? Math.floor(maxFragmentFrames)
    : MAX_FRAGMENT_FRAMES;
  socket.on("error", () => {});
  let requestUrl;
  try {
    requestUrl = new URL(request.url || "/", `http://${request.headers.host || "127.0.0.1"}`);
  } catch {
    rejectUpgrade(socket, 400, "Invalid WebSocket request URL.");
    return false;
  }
  // Keep authentication policy outside the frame/parser implementation. Main
  // uses the capability-bearing path today; a caller surface that validates a
  // direct bearer can inject the same pre-101 decision without weakening or
  // duplicating the WebSocket protocol boundary.
  let route;
  try {
    route = authenticateUpgrade
      ? authenticateUpgrade(request, requestUrl)
      : authenticatedRoute(requestUrl.pathname, callerKey);
  } catch {
    route = undefined;
  }
  if (!route) {
    rejectUpgrade(
      socket,
      401,
      "This local router endpoint requires its configured caller authentication.",
    );
    return false;
  }
  if (!RESPONSE_ROUTES.has(route)) {
    rejectUpgrade(socket, 404, "Unsupported router WebSocket route.");
    return false;
  }
  if (request.headers.origin || request.headers["sec-fetch-site"]) {
    rejectUpgrade(socket, 403, "Browser-originated WebSocket requests are not accepted.");
    return false;
  }
  if (
    request.method !== "GET" ||
    String(request.headers.upgrade || "").toLowerCase() !== "websocket" ||
    !headerTokens(request.headers.connection).includes("upgrade") ||
    request.headers["sec-websocket-version"] !== "13" ||
    !validWebSocketKey(request.headers["sec-websocket-key"])
  ) {
    rejectUpgrade(socket, 426, "A valid RFC 6455 WebSocket upgrade is required.", {
      "Sec-WebSocket-Version": "13",
    });
    return false;
  }
  if (!requestHasBeta(request)) {
    rejectUpgrade(
      socket,
      426,
      `OpenAI-Beta: ${RESPONSES_WEBSOCKET_BETA} is required.`,
      { "OpenAI-Beta": RESPONSES_WEBSOCKET_BETA },
    );
    return false;
  }
  acceptUpgrade(request, socket);
  new ResponsesWebSocketPeer(socket, request, {
    callerKey,
    responsesUrl,
    internalAuthorization,
    fetchImpl,
    maxMessageBytes,
    maxEventBytes,
    maxErrorBytes,
    maxContinuationBytes,
    maxFragmentFrames,
  }).start(head);
  return true;
}
