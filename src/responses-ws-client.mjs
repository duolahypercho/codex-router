// The client half of the Responses WebSocket protocol
// (`responses_websockets=2026-02-06`). The local edge in responses-websocket.mjs
// speaks this protocol as a *server* for Codex; this module speaks it as a
// *client* toward upstreams that support it, so a provider connection can carry
// sequential full requests without a fresh HTTP connection for every turn.
//
// The socket is hand-rolled over node:net/node:tls for the same reasons the
// edge is hand-rolled: WHATWG/undici WebSocket cannot send client pings (a
// silent reasoning turn would be idle-killed between the router and the
// provider), and a refused upgrade surfaces there as a bare 1006 with no
// status or `OpenAI-Beta` response header, which is exactly the signal this
// client needs in order to fall back to HTTP without logging a false error.

import { createHash, randomBytes } from "node:crypto";
import { validateHeaderName, validateHeaderValue } from "node:http";
import net from "node:net";
import tls from "node:tls";

import { MAX_BODY_BYTES, MAX_BUFFERED_RESPONSE_BYTES } from "./http-utils.mjs";
import { environmentHttpProxyConfigured } from "./proxy-environment.mjs";
import {
  RESPONSES_WEBSOCKET_BETA,
  WS_GUID,
  WebSocketFrameParser,
  closePayload,
  encodeMaskedFrame,
} from "./ws-frames.mjs";

// One import site for callers that wire both directions of the protocol.
export { RESPONSES_WEBSOCKET_BETA } from "./ws-frames.mjs";

const configuredPreludeMs = Number(
  process.env.MODEL_ROUTER_WS_PRELUDE_TIMEOUT_MS || process.env.CODEX_ROUTER_WS_PRELUDE_TIMEOUT_MS,
);
export const RESPONSES_WS_PRELUDE_TIMEOUT_MS = Number.isFinite(configuredPreludeMs) && configuredPreludeMs > 0
  ? Math.max(1, Math.min(300_000, Math.floor(configuredPreludeMs))) : 60_000;

const HANDSHAKE_TIMEOUT_MS = 10_000;
const HANDSHAKE_HEADER_LIMIT_BYTES = 16 * 1_024;
const DEFAULT_PING_INTERVAL_MS = 30_000;
const METADATA_EVENT_TYPES = new Set(["response.metadata", "codex.response.metadata", "codex.rate_limits"]);
const TERMINAL_EVENT_TYPES = new Set([
  "response.completed",
  "response.failed",
  "response.incomplete",
]);

// A provider that refuses the upgrade is not an error condition: it is the
// documented fallback signal. Callers check `fallbackToHttp` and retry the
// turn over the existing HTTP path, so a 426 costs one handshake, not a turn.
export class WsUpgradeRefusedError extends Error {
  constructor(message, { status, headers } = {}) {
    super(message);
    this.name = "WsUpgradeRefusedError";
    this.status = status;
    this.headers = headers;
    this.fallbackToHttp = true;
  }
}

export class WsTransportError extends Error {
  constructor(message, code = "ERR_WS_TRANSPORT") {
    super(message);
    this.name = "WsTransportError";
    this.code = code;
  }
}

export function responsesWebSocketUrl(httpUrl) {
  const url = new URL(httpUrl);
  if (url.protocol === "https:") url.protocol = "wss:";
  else if (url.protocol === "http:") url.protocol = "ws:";
  return url;
}

const RESERVED_HEADERS = new Set([
  "host", "connection", "upgrade", "content-length", "transfer-encoding",
  "sec-websocket-key", "sec-websocket-version", "sec-websocket-extensions",
  "sec-websocket-protocol", "proxy-authorization", "proxy-connection",
]);
const RESPONSE_TRANSPORT_HEADERS = new Set([
  ...RESERVED_HEADERS, "content-encoding", "content-type", "keep-alive", "trailer", "te",
]);

function headerLines(headers) {
  const lines = [];
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    validateHeaderName(name);
    validateHeaderValue(name, value);
    if (RESERVED_HEADERS.has(name.toLowerCase())) {
      throw new WsTransportError("Reserved WebSocket handshake header.");
    }
    lines.push(`${name}: ${value}`);
  }
  return lines.join("\r\n");
}

function parseHandshake(buffer, headerEnd) {
  const lines = buffer.subarray(0, headerEnd).toString("latin1").split("\r\n");
  const statusMatch = /^HTTP\/1\.[01] (\d{3})(?: |$)/.exec(lines[0] || "");
  if (!statusMatch) throw new WsTransportError("Malformed WebSocket handshake status.");
  const headers = Object.create(null);
  for (const line of lines.slice(1)) {
    const separator = line.indexOf(":");
    if (separator < 1) throw new WsTransportError("Malformed WebSocket handshake header.");
    const name = line.slice(0, separator).toLowerCase();
    const value = line.slice(separator + 1).trim();
    validateHeaderName(name);
    validateHeaderValue(name, value);
    headers[name] = headers[name] === undefined ? value : `${headers[name]}, ${value}`;
  }
  return { status: Number(statusMatch[1]), headers, rest: buffer.subarray(headerEnd + 4) };
}

export class ResponsesWebSocketClient {
  // One upgraded connection to one upstream. Requests are strictly sequential
  // on the wire (the protocol allows no multiplexing), so a pool that wants
  // concurrency leases several clients, never interleaves frames on one.
  //
  // Event handlers must be attached immediately after `connect` resolves and
  // before the first `sendJson`, the same contract the server peer uses.
  constructor({ socket, pingIntervalMs }) {
    this.socket = socket;
    this.closed = false;
    this.closeSent = false;
    // Connection metadata can arrive with the upgrade. Responses events
    // require an active turn and must never carry over to the next lease.
    this.acceptingResponses = false;
    this.hasSentRequest = false;
    this.jsonHandler = undefined;
    this.jsonQueue = [];
    this.jsonQueueBytes = 0;
    this.closeHandler = undefined;
    this.closeQueued = false;
    this.lastTrafficAt = Date.now();
    this.parser = new WebSocketFrameParser({
      expectMasked: false,
      maxMessageBytes: MAX_BODY_BYTES,
      onText: (text) => {
        this.lastTrafficAt = Date.now();
        let value;
        try {
          value = JSON.parse(text);
        } catch {
          // The upstream spoke non-JSON on a JSON protocol; the connection is
          // unusable, but an in-flight reader still deserves a clean failure.
          this.close(1002, "Upstream sent a non-JSON message.");
          return;
        }
        // A late frame from the previous lease cannot become a new turn's
        // prelude. Only initial connection metadata is valid before a turn.
        if (!this.acceptingResponses && (this.hasSentRequest || !METADATA_EVENT_TYPES.has(value?.type))) {
          this.abort();
          return;
        }
        if (this.jsonHandler) this.jsonHandler(value);
        else {
          this.jsonQueueBytes += Buffer.byteLength(text);
          if (this.jsonQueueBytes > MAX_BODY_BYTES || this.jsonQueue.length >= 1_024) {
            this.abort();
            return;
          }
          this.jsonQueue.push(value);
        }
      },
      onBinary: () => this.close(1003, "Binary messages are not supported."),
      onPing: (payload) => this.send(0xa, payload),
      onPong: () => {},
      onClose: ({ code, reason }) => {
        if (!this.closeSent) {
          this.closeSent = true;
          this.writeFrame(
            0x8,
            code === undefined ? Buffer.alloc(0) : closePayload(code, reason),
          );
        }
        this.socket.destroySoon();
        this.markClosed();
      },
      onFail: (code, reason) => this.close(code, reason),
    });
    socket.on("data", (chunk) => {
      try { this.parser.feed(chunk); } catch { this.abort(); }
    });
    socket.on("error", () => this.abort());
    socket.on("close", () => this.markClosed());
    socket.on("end", () => this.abort());
    this.pingTimer = pingIntervalMs
      ? setInterval(() => {
          if (this.closed) return;
          if (Date.now() - this.lastTrafficAt >= pingIntervalMs) {
            this.send(0x9, Buffer.from("codex-router-ping", "utf8"));
          }
        }, pingIntervalMs)
      : undefined;
    this.pingTimer?.unref?.();
  }

  static async connect(url, {
    headers = {},
    signal,
    lookup,
    pingIntervalMs = DEFAULT_PING_INTERVAL_MS,
    handshakeTimeoutMs = HANDSHAKE_TIMEOUT_MS,
    maxHandshakeBytes = HANDSHAKE_HEADER_LIMIT_BYTES,
  } = {}) {
    const target = url instanceof URL ? url : new URL(url);
    if (target.protocol !== "wss:" && target.protocol !== "ws:") {
      throw new WsTransportError(`Unsupported WebSocket protocol: ${target.protocol}`);
    }
    if (target.username || target.password || target.hash) {
      throw new WsTransportError("WebSocket URL must not contain credentials or a fragment.");
    }
    if (signal?.aborted) throw new WsTransportError("WebSocket connect aborted.", "ERR_WS_ABORTED");
    const extraHeaderLines = headerLines({
      "openai-beta": RESPONSES_WEBSOCKET_BETA,
      ...Object.fromEntries(Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value])),
    });
    const key = randomBytes(16).toString("base64");
    const expectedAccept = createHash("sha1").update(key + WS_GUID).digest("base64");
    const secure = target.protocol === "wss:";
    const hostname = target.hostname.replace(/^\[|\]$/g, "");
    const port = Number(target.port) || (secure ? 443 : 80);
    const socket = secure
      ? tls.connect({ host: hostname, port, servername: net.isIP(hostname) ? undefined : hostname, lookup, rejectUnauthorized: true })
      : net.connect({ host: hostname, port, lookup });
    const handshake = await new Promise((resolve, reject) => {
      let finished = false;
      let buffer = Buffer.alloc(0);
      const finish = (error, result) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        socket.off("data", onData);
        socket.off("error", onError);
        socket.off("end", onEnd);
        socket.off("close", onEnd);
        if (error) {
          socket.destroy();
          reject(error);
        } else {
          socket.pause();
          resolve(result);
        }
      };
      const onAbort = () => finish(new WsTransportError("WebSocket connect aborted.", "ERR_WS_ABORTED"));
      const onError = () => finish(new WsTransportError("WebSocket connect failed.", "ERR_WS_CONNECT"));
      const onEnd = () => finish(new WsTransportError("WebSocket closed during handshake.", "ERR_WS_CONNECT"));
      const timer = setTimeout(() => finish(new WsTransportError("WebSocket handshake timed out.", "ERR_WS_HANDSHAKE_TIMEOUT")), handshakeTimeoutMs);
      timer.unref?.();
      const onData = (chunk) => {
        buffer = Buffer.concat([buffer, chunk]);
        const headerEnd = buffer.indexOf("\r\n\r\n");
        if ((headerEnd < 0 ? buffer.length : headerEnd + 4) > maxHandshakeBytes) {
          finish(new WsTransportError("WebSocket handshake response too large.", "ERR_WS_HANDSHAKE_OVERRUN"));
          return;
        }
        if (headerEnd < 0) return;
        try {
          const parsed = parseHandshake(buffer, headerEnd);
          if (parsed.status !== 101) {
            finish(new WsUpgradeRefusedError(`Upstream refused WebSocket upgrade with status ${parsed.status}.`, parsed));
            return;
          }
          if (parsed.headers.upgrade?.toLowerCase() !== "websocket" ||
              !parsed.headers.connection?.toLowerCase().split(",").some((token) => token.trim() === "upgrade") ||
              parsed.headers["sec-websocket-accept"] !== expectedAccept ||
              parsed.headers["sec-websocket-extensions"] !== undefined ||
              parsed.headers["sec-websocket-protocol"] !== undefined) {
            throw new WsTransportError("Invalid WebSocket upgrade response.", "ERR_WS_HANDSHAKE");
          }
          finish(undefined, parsed);
        } catch (error) { finish(error); }
      };
      socket.once("error", onError);
      socket.once("end", onEnd);
      socket.once("close", onEnd);
      socket.on("data", onData);
      signal?.addEventListener("abort", onAbort, { once: true });
      if (signal?.aborted) { onAbort(); return; }
      socket.write([
        `GET ${target.pathname}${target.search} HTTP/1.1`,
        `Host: ${target.host}`, "Upgrade: websocket", "Connection: Upgrade",
        `Sec-WebSocket-Key: ${key}`, "Sec-WebSocket-Version: 13",
        ...(extraHeaderLines ? [extraHeaderLines] : []), "", "",
      ].join("\r\n"));
    });
    if (signal?.aborted) {
      socket.destroy();
      throw new WsTransportError("WebSocket connect aborted.", "ERR_WS_ABORTED");
    }
    const client = new ResponsesWebSocketClient({ socket, pingIntervalMs });
    if (handshake.rest?.length) client.parser.feed(handshake.rest);
    socket.resume();
    return client;
  }

  set onJson(handler) {
    this.jsonHandler = handler;
    const queued = this.jsonQueue;
    this.jsonQueue = [];
    this.jsonQueueBytes = 0;
    if (handler) for (const value of queued) {
      if (this.jsonHandler !== handler) break;
      handler(value);
    }
  }

  get onJson() {
    return this.jsonHandler;
  }

  set onClose(handler) {
    this.closeHandler = handler;
    if (handler && this.closeQueued) {
      this.closeQueued = false;
      handler();
    }
  }

  get onClose() {
    return this.closeHandler;
  }

  writeFrame(opcode, payload) {
    if (this.closed || this.socket.destroyed || !this.socket.writable) return false;
    return this.socket.write(encodeMaskedFrame(opcode, payload));
  }

  send(opcode, payload) {
    const sent = this.writeFrame(opcode, payload);
    if (sent) this.lastTrafficAt = Date.now();
    return sent;
  }

  async sendJson(value) {
    if (this.send(0x1, Buffer.from(JSON.stringify(value), "utf8"))) return true;
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

  idleRef(idle) {
    if (idle) {
      this.socket.unref?.();
      this.pingTimer?.unref?.();
    } else {
      this.socket.ref?.();
      this.pingTimer?.ref?.();
    }
  }

  markClosed() {
    if (this.closed) return;
    this.closed = true;
    this.parser.stop();
    clearInterval(this.pingTimer);
    if (this.closeHandler) {
      this.closeHandler();
    } else {
      this.closeQueued = true;
    }
  }

  close(code, reason) {
    if (this.closed) return;
    if (!this.closeSent) {
      this.closeSent = true;
      this.writeFrame(0x8, closePayload(code, reason));
    }
    this.socket.destroySoon();
    this.markClosed();
  }

  abort() {
    this.closeSent = true;
    this.socket.destroy();
    this.markClosed();
  }
}

export function headersFromMetadataFrames(frames) {
  // Both metadata frames carry a `headers` object of response headers that
  // HTTP would have delivered on the response head; fold them into one dict.
  const headers = Object.create(null);
  for (const frame of frames) {
    const value = frame?.headers;
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const connectionHeaders = new Set(String(value.connection || value.Connection || "").toLowerCase().split(",").map((name) => name.trim()));
    for (const [name, headerValue] of Object.entries(value)) {
      if (typeof headerValue === "string" || typeof headerValue === "number") {
        validateHeaderName(name);
        validateHeaderValue(name, headerValue);
        if (!RESPONSE_TRANSPORT_HEADERS.has(name.toLowerCase()) && !connectionHeaders.has(name.toLowerCase())) headers[name.toLowerCase()] = String(headerValue);
      }
    }
  }
  return headers;
}

function rateLimitWindowHeaders(prefix, windowName, window) {
  if (!window) return {};
  const headers = { [`${prefix}-${windowName}-used-percent`]: String(window.used_percent) };
  if (window.window_minutes !== undefined) {
    headers[`${prefix}-${windowName}-window-minutes`] = String(window.window_minutes);
  }
  if (window.reset_at !== undefined) {
    headers[`${prefix}-${windowName}-reset-at`] = String(window.reset_at);
  }
  return headers;
}

export function rateLimitHeadersFromEvents(events) {
  // The inverse of the edge's `codex.rate_limits` projection: rebuild the
  // `x-<family>-*` header set so the HTTP classification paths (rate-limit
  // cooldowns, usage recording) keep working on WebSocket turns unchanged.
  const headers = {};
  for (const event of events) {
    const familyId = typeof event?.metered_limit_name === "string" ? event.metered_limit_name : undefined;
    if (!familyId) continue;
    const prefix = `x-${familyId.replaceAll("_", "-")}`;
    const limits = event.rate_limits && typeof event.rate_limits === "object"
      ? event.rate_limits
      : {};
    Object.assign(headers, rateLimitWindowHeaders(prefix, "primary", limits.primary));
    Object.assign(headers, rateLimitWindowHeaders(prefix, "secondary", limits.secondary));
    if (typeof event.limit_name === "string" && event.limit_name) {
      headers[`${prefix}-limit-name`] = event.limit_name;
    }
    const credits = event.credits && typeof event.credits === "object" ? event.credits : undefined;
    if (credits && credits.has_credits !== undefined && credits.unlimited !== undefined) {
      headers["x-codex-credits-has-credits"] = String(credits.has_credits);
      headers["x-codex-credits-unlimited"] = String(credits.unlimited);
      if (credits.balance !== undefined) headers["x-codex-credits-balance"] = String(credits.balance);
    }
  }
  return headers;
}

function sseBytes(event) {
  return Buffer.from(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`, "utf8");
}

export async function collectResponsesRequest(client, requestBody, {
  signal,
  preludeTimeoutMs = RESPONSES_WS_PRELUDE_TIMEOUT_MS,
  maxEventBytes = MAX_BUFFERED_RESPONSE_BYTES,
  onSettled,
} = {}) {
  // Drive exactly one `response.create` over an idle client and resolve with
  // a fetch-`Response`-shaped result: the downstream pipeline (SSE transforms,
  // usage observers, error classification) consumes it without knowing the
  // upstream leg was a WebSocket. `onSettled` fires exactly once, when the
  // turn's body is complete (terminal event, error frame, cancellation, or
  // failure) -- the hook a connection pool releases its lease on.
  return new Promise((resolve, reject) => {
    let done = false;
    let streamController;
    const responseHeaders = new Headers({ "content-type": "text/event-stream" });
    let metadataBytes = 0;
    const cleanup = () => {
      clearTimeout(preludeTimer);
      signal?.removeEventListener("abort", onAbort);
      client.onJson = undefined;
      client.onClose = undefined;
    };
    const finish = (error, poison = false) => {
      if (done) return;
      done = true;
      client.acceptingResponses = false;
      cleanup();
      // Poison before release: a waiter may acquire synchronously in onSettled.
      if (poison) client.abort();
      else client.socket.resume();
      try {
        if (error) {
          if (streamController) streamController.error(error);
          else reject(error);
        } else streamController?.close();
      } finally { onSettled?.(); }
    };
    const onAbort = () => finish(new WsTransportError("Request aborted.", "ERR_WS_ABORTED"), true);
    const preludeTimer = setTimeout(() => finish(new WsTransportError(
      "Upstream produced no Responses event before the prelude timeout.", "ERR_WS_PRELUDE_TIMEOUT",
    ), true), preludeTimeoutMs);
    preludeTimer.unref?.();
    const handleFrame = (frame) => {
      if (done) return;
      try {
        if (METADATA_EVENT_TYPES.has(frame?.type)) {
          metadataBytes += Buffer.byteLength(JSON.stringify(frame));
          if (metadataBytes > HANDSHAKE_HEADER_LIMIT_BYTES) throw new WsTransportError("Responses metadata exceeds the buffered bound.");
          const metadata = frame.type === "codex.rate_limits" ? { headers: rateLimitHeadersFromEvents([frame]) } : frame;
          for (const [name, value] of Object.entries(headersFromMetadataFrames([metadata]))) responseHeaders.set(name, value);
          return;
        }
        if (frame?.type === "error") {
          const status = Number.isInteger(frame.status) && frame.status >= 400 && frame.status <= 599 ? frame.status : 502;
          if (streamController) {
            finish(new WsTransportError("Upstream returned an error during the Responses stream.", "ERR_WS_UPSTREAM"), true);
          } else {
            const headers = new Headers({ ...headersFromMetadataFrames([frame]), "content-type": "application/json" });
            finish(undefined, true);
            resolve({ status, ok: false, headers, body: new Response(JSON.stringify({ error: frame.error ?? {} })).body });
          }
          return;
        }
        if (!frame || typeof frame.type !== "string" || !/^response\.[a-z0-9_.]+$/.test(frame.type)) {
          throw new WsTransportError("Invalid Responses event.");
        }
        clearTimeout(preludeTimer);
        const bytes = sseBytes(frame);
        if (!streamController) {
          const body = new ReadableStream({
            start(controller) { streamController = controller; },
            pull() {
              if (!done) client.socket.resume();
            },
            cancel() { streamController = undefined; finish(undefined, true); },
          }, { highWaterMark: 64 * 1_024, size: (chunk) => chunk.byteLength });
          resolve({ status: 200, ok: true, headers: responseHeaders, body });
        }
        const bufferedBytes = Math.max(0, 64 * 1_024 - streamController.desiredSize) + bytes.length;
        if (bufferedBytes > maxEventBytes) throw new WsTransportError("Responses event exceeds the buffered bound.", "ERR_WS_EVENT_TOO_LARGE");
        streamController.enqueue(bytes);
        if (streamController.desiredSize <= 0) client.socket.pause();
        if (TERMINAL_EVENT_TYPES.has(frame.type)) finish();
      } catch (error) { finish(error, true); }
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) { onAbort(); return; }
    client.onClose = () => finish(new WsTransportError("Upstream WebSocket closed mid-turn.", "ERR_WS_CLOSED_MID_TURN"), true);
    if (done) return;
    client.onJson = handleFrame;
    if (done) return;
    client.acceptingResponses = true;
    client.hasSentRequest = true;
    client.sendJson({ ...requestBody, type: "response.create" }).then((sent) => {
      if (!sent) finish(new WsTransportError("Upstream WebSocket was not writable.", "ERR_WS_NOT_WRITABLE"), true);
    }, (error) => finish(error, true));
  });
}

const transportFailures = new Map();

export function markWsTransportFailure(key, retryAfterMs = 300_000) {
  transportFailures.set(key, Date.now() + retryAfterMs);
}

export function wsTransportAvailable(key, now = Date.now()) {
  const until = transportFailures.get(key);
  if (until === undefined || until <= now) {
    transportFailures.delete(key);
    return true;
  }
  return false;
}

export function nativeWebSocketTransportEnabled(environment = process.env) {
  // Preserve the existing HTTP retry contract by default. Operators whose
  // upstream supports this protocol opt in with MODEL_ROUTER_NATIVE_TRANSPORT.
  const raw = String(
    environment.MODEL_ROUTER_NATIVE_TRANSPORT ||
      environment.CODEX_ROUTER_NATIVE_TRANSPORT ||
      "http",
  ).trim().toLowerCase();
  return raw === "websocket" || raw === "ws";
}

export function responsesWebSocketTransportUsable(environment = process.env, execArgv = process.execArgv) {
  // A hand-rolled socket has no EnvHttpProxyAgent underneath it, so a proxy
  // in the environment silently blackholes the connect. Disable instead.
  return !environmentHttpProxyConfigured(environment, execArgv);
}

// The transport's operator knobs, preserved in the installed service so a
// shell-set value survives the launchd/systemd/Task Manager boundary.
export function responsesWsServiceEnvironment(environment = process.env) {
  const values = {};
  for (const name of [
    "MODEL_ROUTER_NATIVE_TRANSPORT",
    "CODEX_ROUTER_NATIVE_TRANSPORT",
    "MODEL_ROUTER_WS_PRELUDE_TIMEOUT_MS",
    "CODEX_ROUTER_WS_PRELUDE_TIMEOUT_MS",
  ]) {
    if (environment[name] !== undefined) values[name] = environment[name];
  }
  return values;
}
