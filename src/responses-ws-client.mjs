// The client half of the Responses WebSocket protocol
// (`responses_websockets=2026-02-06`). The local edge in responses-websocket.mjs
// speaks this protocol as a *server* for Codex; this module speaks it as a
// *client* toward upstreams that support it, so a provider connection can carry
// incremental turns instead of a fresh HTTP POST of the whole conversation.
//
// The socket is hand-rolled over node:net/node:tls for the same reasons the
// edge is hand-rolled: WHATWG/undici WebSocket cannot send client pings (a
// silent reasoning turn would be idle-killed between the router and the
// provider), and a refused upgrade surfaces there as a bare 1006 with no
// status or `OpenAI-Beta` response header, which is exactly the signal this
// client needs in order to fall back to HTTP without logging a false error.

import { randomBytes } from "node:crypto";
import net from "node:net";
import tls from "node:tls";

import { MAX_BODY_BYTES, MAX_BUFFERED_RESPONSE_BYTES } from "./http-utils.mjs";
import { environmentHttpProxyConfigured } from "./proxy-environment.mjs";
import {
  RESPONSES_WEBSOCKET_BETA,
  WebSocketFrameParser,
  closePayload,
  encodeMaskedFrame,
} from "./ws-frames.mjs";

// One import site for callers that wire both directions of the protocol.
export { RESPONSES_WEBSOCKET_BETA } from "./ws-frames.mjs";

export const RESPONSES_WS_PRELUDE_TIMEOUT_MS = Number(
  process.env.MODEL_ROUTER_WS_PRELUDE_TIMEOUT_MS ||
    process.env.CODEX_ROUTER_WS_PRELUDE_TIMEOUT_MS ||
    60_000,
);

const HANDSHAKE_TIMEOUT_MS = 10_000;
const HANDSHAKE_HEADER_LIMIT_BYTES = 16 * 1_024;
const DEFAULT_PING_INTERVAL_MS = 30_000;
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

function headerLines(headers) {
  return Object.entries(headers)
    .filter(([, value]) => value !== undefined)
    .map(([name, value]) => `${name}: ${value}`)
    .join("\r\n");
}

function parseHandshake(buffer) {
  const headerEnd = buffer.indexOf("\r\n\r\n");
  if (headerEnd === -1) return undefined;
  const head = buffer.subarray(0, headerEnd).toString("latin1");
  const lines = head.split("\r\n");
  const statusMatch = /^HTTP\/1\.[01] (\d{3})/.exec(lines[0] || "");
  const status = statusMatch ? Number(statusMatch[1]) : undefined;
  const headers = {};
  for (const line of lines.slice(1)) {
    const separator = line.indexOf(":");
    if (separator === -1) continue;
    const name = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).trim();
    headers[name] = value;
  }
  return { status, headers, rest: buffer.subarray(headerEnd + 4) };
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
    // Frames can arrive in the same TCP chunk as the 101 handshake, before
    // any consumer attached a handler. Buffer them instead of dropping: a
    // provider that answers eagerly (or a close during a slow attach) must
    // not be silently swallowed by a default no-op.
    this.jsonHandler = undefined;
    this.jsonQueue = [];
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
        if (this.jsonHandler) this.jsonHandler(value);
        else this.jsonQueue.push(value);
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
        this.markClosed();
      },
      onFail: (code, reason) => this.close(code, reason),
    });
    socket.on("data", (chunk) => this.parser.feed(chunk));
    socket.on("error", () => this.markClosed());
    socket.on("close", () => this.markClosed());
    socket.on("end", () => this.markClosed());
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
    const secure = target.protocol === "wss:";
    const port = Number(target.port) || (secure ? 443 : 80);
    const socket = secure
      ? tls.connect({ host: target.hostname, port, servername: target.hostname, lookup, rejectUnauthorized: true })
      : net.connect({ host: target.hostname, port, lookup });

    const failHandshake = (error) => {
      socket.destroy();
      throw error;
    };
    const onAbort = () => failHandshake(new WsTransportError("WebSocket connect aborted.", "ERR_WS_ABORTED"));
    signal?.addEventListener("abort", onAbort, { once: true });

    const handshake = await new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new WsTransportError("WebSocket handshake timed out.", "ERR_WS_HANDSHAKE_TIMEOUT")),
        handshakeTimeoutMs,
      );
      timer.unref?.();
      let buffer = Buffer.alloc(0);
      const finish = (error, result) => {
        clearTimeout(timer);
        socket.off("data", onData);
        socket.off("error", onError);
        if (error) {
          socket.destroy();
          reject(error);
          return;
        }
        resolve(result);
      };
      const onError = () =>
        finish(new WsTransportError("WebSocket connect failed.", "ERR_WS_CONNECT"));
      const onData = (chunk) => {
        buffer = buffer.length
          ? Buffer.concat([buffer, chunk], buffer.length + chunk.length)
          : Buffer.from(chunk);
        if (buffer.length > maxHandshakeBytes) {
          finish(new WsTransportError("WebSocket handshake response too large.", "ERR_WS_HANDSHAKE_OVERRUN"));
          return;
        }
        const parsed = parseHandshake(buffer);
        if (!parsed) return;
        if (parsed.status !== 101 || parsed.headers.upgrade?.toLowerCase() !== "websocket") {
          // Capture the response the way a browser cannot: a 426 with an
          // `OpenAI-Beta` header is the upstream's own "use HTTP" instruction.
          finish(
            new WsUpgradeRefusedError(
              `Upstream refused the WebSocket upgrade with status ${parsed.status ?? "malformed"}.`,
              { status: parsed.status, headers: parsed.headers },
            ),
          );
          return;
        }
        finish(undefined, { rest: parsed.rest });
      };
      socket.once("error", onError);
      socket.on("data", onData);
      const extraHeaderLines = headerLines({
        // The beta contract is this transport's version negotiation; it goes
        // on every handshake unless the caller overrides it explicitly.
        "openai-beta": RESPONSES_WEBSOCKET_BETA,
        ...Object.fromEntries(
          Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value]),
        ),
      });
      socket.write(
        [
          `GET ${target.pathname}${target.search} HTTP/1.1`,
          `Host: ${target.host}`,
          "Upgrade: websocket",
          "Connection: Upgrade",
          `Sec-WebSocket-Key: ${randomBytes(16).toString("base64")}`,
          "Sec-WebSocket-Version: 13",
          ...(extraHeaderLines ? [extraHeaderLines] : []),
          "",
          "",
        ].join("\r\n"),
      );
    }).catch((error) => {
      signal?.removeEventListener("abort", onAbort);
      throw error;
    });
    signal?.removeEventListener("abort", onAbort);
    if (signal?.aborted) {
      socket.destroy();
      throw new WsTransportError("WebSocket connect aborted.", "ERR_WS_ABORTED");
    }
    const client = new ResponsesWebSocketClient({ socket, pingIntervalMs });
    if (handshake.rest?.length) client.parser.feed(handshake.rest);
    return client;
  }

  set onJson(handler) {
    this.jsonHandler = handler;
    const queued = this.jsonQueue;
    this.jsonQueue = [];
    for (const value of queued) handler(value);
  }

  get onJson() {
    return this.jsonHandler;
  }

  set onClose(handler) {
    this.closeHandler = handler;
    if (this.closeQueued) {
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
    this.socket.end();
    this.markClosed();
  }

  abort() {
    if (this.closed) return;
    this.closeSent = true;
    this.socket.destroy();
    this.markClosed();
  }
}

export function headersFromMetadataFrames(frames) {
  // Both metadata frames carry a `headers` object of response headers that
  // HTTP would have delivered on the response head; fold them into one dict.
  const headers = {};
  for (const frame of frames) {
    const value = frame?.headers;
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    for (const [name, headerValue] of Object.entries(value)) {
      if (typeof headerValue === "string" || typeof headerValue === "number") {
        headers[name] = String(headerValue);
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
    let settled = false;
    let streamEnded = false;
    let sawTerminal = false;
    const metadataFrames = [];
    let queued = [];
    let streamController = undefined;
    let streamStarted = false;
    let eventBytes = 0;
    let settledCallbackRun = false;
    const settledCallback = () => {
      if (settledCallbackRun) return;
      settledCallbackRun = true;
      onSettled?.();
    };
    const preludeTimer = setTimeout(() => {
      // Nothing arrived at all. The provider may have accepted the turn or
      // not; silently resending is how double-billing happens, so fail it.
      // Settle before aborting: abort fires onClose synchronously, and the
      // close handler must not win the race with this rejection.
      settle(() => reject(new WsTransportError(
        "Upstream produced no Responses event before the prelude timeout.",
        "ERR_WS_PRELUDE_TIMEOUT",
      )));
      settledCallback();
      client.abort();
    }, preludeTimeoutMs);
    preludeTimer.unref?.();

    const endStream = () => {
      if (streamEnded) return;
      streamEnded = true;
      try {
        streamController?.close();
      } catch {
        // Already closed by cancel() from a downstream consumer.
      }
    };

    const startStream = () => {
      streamStarted = true;
      const body = new ReadableStream({
        start(controller) {
          streamController = controller;
          for (const event of queued) controller.enqueue(sseBytes(event));
          queued = undefined;
        },
        cancel() {
          // The downstream consumer went away; stop the upstream turn.
          streamEnded = true;
          settledCallback();
          client.abort();
        },
      });
      const headers = new Headers({
        "content-type": "text/event-stream",
        ...headersFromMetadataFrames(metadataFrames),
      });
      settle(() => resolve({ status: 200, ok: true, headers, body }));
    };

    const settle = (complete) => {
      if (settled) return;
      settled = true;
      clearTimeout(preludeTimer);
      complete();
    };

    const handleFrame = (frame) => {
      if (frame?.type === "response.metadata" || frame?.type === "codex.response.metadata") {
        metadataFrames.push(frame);
        return;
      }
      if (frame?.type === "codex.rate_limits") {
        metadataFrames.push({ headers: rateLimitHeadersFromEvents([frame]) });
        return;
      }
      if (frame?.type === "error") {
        const status = Number.isInteger(frame.status) && frame.status >= 400 && frame.status <= 599
          ? frame.status
          : 502;
        const headers = new Headers({
          "content-type": "application/json",
          ...(frame.headers && typeof frame.headers === "object" && !Array.isArray(frame.headers)
            ? Object.fromEntries(
                Object.entries(frame.headers)
                  .filter(([, value]) => typeof value === "string")
                  .map(([name, value]) => [name, value]),
              )
            : {}),
        });
        settle(() => {
          client.close(1000, "error frame");
          settledCallback();
          resolve({
            status,
            ok: false,
            headers,
            body: new Response(JSON.stringify({ error: frame.error ?? {} })).body,
          });
        });
        return;
      }
      if (!frame || typeof frame.type !== "string") return;
      // An ordinary Responses event. The first one commits the stream head;
      // every later event (including the terminal one) rides the same body.
      eventBytes += Buffer.byteLength(JSON.stringify(frame), "utf8");
      if (eventBytes > maxEventBytes) {
        settle(() => {
          client.abort();
          settledCallback();
          reject(new WsTransportError("Responses event exceeds the buffered bound.", "ERR_WS_EVENT_TOO_LARGE"));
        });
        return;
      }
      if (!streamStarted) {
        queued.push(frame);
        startStream();
      } else if (queued) {
        queued.push(frame);
      } else {
        try {
          streamController?.enqueue(sseBytes(frame));
        } catch {
          // The stream was cancelled mid-flight; the abort in cancel() is
          // already tearing the connection down.
        }
      }
      if (TERMINAL_EVENT_TYPES.has(frame.type)) {
        sawTerminal = true;
        settle(() => {});
        endStream();
        settledCallback();
      }
    };

    client.onJson = handleFrame;
    client.onClose = () => {
      if (!settled) {
        settle(() => {
          settledCallback();
          reject(new WsTransportError("Upstream WebSocket closed before the turn completed.", "ERR_WS_CLOSED_MID_TURN"));
        });
        return;
      }
      if (streamEnded) return;
      if (sawTerminal) {
        // The terminal event already ended the stream; a close after it is
        // the socket being recycled and must not corrupt the body.
        endStream();
        return;
      }
      // The turn died mid-stream with no terminal event. Ending the body
      // cleanly would hand the downstream pipeline a truncated SSE stream
      // that looks complete; error it so the failure is observable.
      streamEnded = true;
      try {
        streamController?.error(
          new WsTransportError("Upstream WebSocket closed mid-turn.", "ERR_WS_CLOSED_MID_TURN"),
        );
      } catch {
        // The stream was already cancelled by the consumer.
      }
    };
    const onAbort = () => {
      settle(() => {
        settledCallback();
        reject(new WsTransportError("Request aborted.", "ERR_WS_ABORTED"));
      });
      client.abort();
    };
    signal?.addEventListener("abort", onAbort, { once: true });

    client.sendJson({ type: "response.create", ...requestBody }).then((sent) => {
      if (!sent) {
        settle(() => {
          settledCallback();
          reject(new WsTransportError("Upstream WebSocket was not writable.", "ERR_WS_NOT_WRITABLE"));
        });
      }
    }, (error) => {
      settle(() => {
        settledCallback();
        reject(error instanceof Error ? error : new WsTransportError(String(error)));
      });
    });
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
  // Opt-in: the ChatGPT backend answers the upgrade with a 401 today, and the
  // native-retry contract tests model that HTTP-only upstream request for
  // request. An operator whose upstream does speak the protocol (or a future
  // backend that does) sets MODEL_ROUTER_NATIVE_TRANSPORT=websocket.
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
