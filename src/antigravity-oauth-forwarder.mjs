import http from "node:http";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

import {
  ANTIGRAVITY_ENDPOINT,
  ANTIGRAVITY_PROD_ENDPOINT,
  antigravityUserAgent,
} from "./antigravity-oauth-constants.mjs";
import {
  applyAntigravitySsePayload,
  createAntigravityTurnState,
  finalizeAntigravityTurn,
  toAntigravityRequest,
} from "./antigravity-oauth-shape.mjs";
import {
  ensureFreshAntigravitySession,
} from "./antigravity-oauth-session.mjs";
import { ensureAntigravityProject } from "./antigravity-project.mjs";
import { antigravityOAuthStatus } from "./antigravity-oauth-status.mjs";
import { installStableFetchTransport } from "./fetch-transport.mjs";
import {
  applyKeepAliveTimeouts,
  formatErrorChain,
  httpErrorStatus,
  readRequestBody,
  reportListenFailure,
  requireInternalAuth,
  writeJson,
} from "./http-utils.mjs";
import { PORTS } from "./paths.mjs";

installStableFetchTransport();

const LISTEN_HOST = process.env.MODEL_ROUTER_ANTIGRAVITY_OAUTH_HOST || "127.0.0.1";
const LISTEN_PORT = Number(
  process.env.MODEL_ROUTER_ANTIGRAVITY_OAUTH_PORT || PORTS.antigravityOauth,
);
const INTERNAL_KEY = process.env.MODEL_ROUTER_INTERNAL_KEY;
const QUIET = process.env.MODEL_ROUTER_QUIET === "1";
const UPSTREAM_HEADER_TIMEOUT_MS = positiveTimeout(
  process.env.ANTIGRAVITY_HEADER_TIMEOUT_MS,
  180_000,
);
const UPSTREAM_IDLE_TIMEOUT_MS = positiveTimeout(
  process.env.ANTIGRAVITY_IDLE_TIMEOUT_MS,
  180_000,
);
const TERMINAL_USAGE_GRACE_MS = positiveTimeout(
  process.env.ANTIGRAVITY_TERMINAL_GRACE_MS,
  2_000,
);

const RETRYABLE_ENDPOINT_STATUSES = new Set([404, 408, 429, 500, 502, 503, 504]);
const SAFE_UPSTREAM_HEADERS = new Set([
  "retry-after",
  "ratelimit-limit",
  "ratelimit-remaining",
  "ratelimit-reset",
]);

function positiveTimeout(value, fallback) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? Math.floor(numeric) : fallback;
}

class AntigravityForwarderError extends Error {
  constructor(message, { status = 502, code = "antigravity_forwarder_error" } = {}) {
    super(message);
    this.name = "AntigravityForwarderError";
    this.status = status;
    this.code = code;
    this.expose = true;
  }
}

function upstreamHeaders(accessToken) {
  return {
    Authorization: `Bearer ${accessToken}`,
    "Content-Type": "application/json",
    Accept: "text/event-stream",
    "Accept-Encoding": "gzip",
    "User-Agent": antigravityUserAgent(),
  };
}

function nextSseBoundary(buffer) {
  const crlf = buffer.indexOf("\r\n\r\n");
  const lf = buffer.indexOf("\n\n");
  if (crlf === -1 && lf === -1) return null;
  if (crlf === -1) return { at: lf, size: 2 };
  if (lf === -1) return { at: crlf, size: 4 };
  return crlf < lf ? { at: crlf, size: 4 } : { at: lf, size: 2 };
}

function sseDataFromBlock(rawEvent) {
  if (typeof rawEvent !== "string" || !rawEvent) return undefined;
  const dataLines = [];
  for (const line of rawEvent.split(/\r?\n/)) {
    if (!line.startsWith("data:")) continue;
    const value = line.slice(5);
    dataLines.push(value.startsWith(" ") ? value.slice(1) : value);
  }
  return dataLines.length ? dataLines.join("\n") : undefined;
}

export function parseAntigravitySseEvent(rawEvent) {
  const data = sseDataFromBlock(rawEvent);
  if (!data) return undefined;
  if (data === "[DONE]") return { done: true };
  try {
    return { done: false, payload: JSON.parse(data) };
  } catch (error) {
    throw new AntigravityForwarderError(
      `Google Antigravity sent malformed SSE JSON: ${error.message}`,
      { code: "malformed_sse" },
    );
  }
}

function readWithTimeout(reader, timeoutMs, { terminal = false } = {}) {
  let timer;
  return Promise.race([
    reader.read().then((result) => ({ kind: "read", result })),
    new Promise((resolve) => {
      timer = setTimeout(() => resolve({ kind: terminal ? "terminal_timeout" : "timeout" }), timeoutMs);
      timer.unref?.();
    }),
  ]).finally(() => clearTimeout(timer));
}

export async function consumeAntigravitySseStream(
  body,
  handler,
  {
    idleTimeoutMs = UPSTREAM_IDLE_TIMEOUT_MS,
    terminalGraceMs = TERMINAL_USAGE_GRACE_MS,
    isTerminal = () => false,
    shouldStop = () => false,
  } = {},
) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let sawDone = false;
  try {
    for (;;) {
      const terminal = isTerminal();
      const outcome = await readWithTimeout(
        reader,
        terminal ? terminalGraceMs : idleTimeoutMs,
        { terminal },
      );
      if (outcome.kind === "terminal_timeout") break;
      if (outcome.kind === "timeout") {
        throw new AntigravityForwarderError(
          `Google Antigravity sent no stream data for ${idleTimeoutMs}ms.`,
          { status: 504, code: "upstream_idle_timeout" },
        );
      }
      const { value, done } = outcome.result;
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let boundary;
      while ((boundary = nextSseBoundary(buffer))) {
        const rawEvent = buffer.slice(0, boundary.at);
        buffer = buffer.slice(boundary.at + boundary.size);
        const event = parseAntigravitySseEvent(rawEvent);
        if (event?.done) {
          sawDone = true;
          break;
        }
        if (event) {
          await handler(event.payload);
          if (shouldStop()) {
            sawDone = true;
            break;
          }
        }
      }
      if (sawDone) break;
    }
    buffer += decoder.decode();
    if (!sawDone && buffer.trim()) {
      const event = parseAntigravitySseEvent(buffer);
      if (event?.done) sawDone = true;
      else if (event) await handler(event.payload);
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
}

function endpointCandidates() {
  return [...new Set([ANTIGRAVITY_ENDPOINT, ANTIGRAVITY_PROD_ENDPOINT])];
}

function composedAbortSignal(parentSignal, controller) {
  return parentSignal
    ? AbortSignal.any([parentSignal, controller.signal])
    : controller.signal;
}

async function fetchWithHeaderTimeout(endpoint, { accessToken, serializedBody, signal, fetchImpl }) {
  const timeoutController = new AbortController();
  const timer = setTimeout(() => {
    timeoutController.abort(
      new AntigravityForwarderError(
        `Google Antigravity did not return response headers within ${UPSTREAM_HEADER_TIMEOUT_MS}ms.`,
        { status: 504, code: "upstream_header_timeout" },
      ),
    );
  }, UPSTREAM_HEADER_TIMEOUT_MS);
  timer.unref?.();
  try {
    return await fetchImpl(
      `${endpoint.replace(/\/$/, "")}/v1internal:streamGenerateContent?alt=sse`,
      {
        method: "POST",
        headers: upstreamHeaders(accessToken),
        body: serializedBody,
        signal: composedAbortSignal(signal, timeoutController),
      },
    );
  } catch (error) {
    if (timeoutController.signal.aborted) throw timeoutController.signal.reason;
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function discardUpstream(upstream) {
  await upstream.body?.cancel().catch(() => {});
}

async function readUpstreamErrorDetail(upstream, maxBytes = 4096) {
  if (!upstream.body) return "";
  const reader = upstream.body.getReader();
  const decoder = new TextDecoder();
  let detail = "";
  let total = 0;
  try {
    while (total < maxBytes) {
      const outcome = await readWithTimeout(reader, UPSTREAM_IDLE_TIMEOUT_MS);
      if (outcome.kind !== "read") break;
      const { value, done } = outcome.result;
      if (done) break;
      const kept = value.subarray(0, Math.max(0, maxBytes - total));
      total += kept.byteLength;
      detail += decoder.decode(kept, { stream: true });
    }
    detail += decoder.decode();
    return detail;
  } finally {
    await reader.cancel().catch(() => {});
  }
}

export async function requestAntigravityUpstream({
  accessToken,
  serializedBody,
  signal,
  fetchImpl = fetch,
  endpoints = endpointCandidates(),
}) {
  try {
    let upstream;
    for (let index = 0; index < endpoints.length; index += 1) {
      upstream = await fetchWithHeaderTimeout(endpoints[index], {
        accessToken,
        serializedBody,
        signal,
        fetchImpl,
      });
      const hasFallback = index + 1 < endpoints.length;
      if (!hasFallback || !RETRYABLE_ENDPOINT_STATUSES.has(upstream.status)) return upstream;
      await discardUpstream(upstream);
    }
    return upstream;
  } catch (error) {
    if (signal?.aborted) {
      const callerError = new AntigravityForwarderError("The caller cancelled the request.", {
        status: 499,
        code: "caller_aborted",
      });
      callerError.callerAborted = true;
      callerError.cause = error;
      throw callerError;
    }
    if (error?.expose === true) throw error;
    const transportError = new AntigravityForwarderError(
      "The Antigravity OAuth forwarder could not reach Google.",
      { status: 502, code: "upstream_transport_error" },
    );
    transportError.cause = error;
    throw transportError;
  }
}

function safeUpstreamHeaders(headers) {
  const safe = {};
  for (const [name, value] of headers || []) {
    const lower = name.toLowerCase();
    if (SAFE_UPSTREAM_HEADERS.has(lower) || lower.startsWith("x-ratelimit-")) {
      safe[name] = value;
    }
  }
  return safe;
}

function clientStatusForUpstream(status) {
  if (status >= 400 && status <= 599) return status;
  return 502;
}

function errorMessageFromUpstream(status, detail) {
  if (status === 401) return "Google rejected the Antigravity OAuth session; run sign-in again.";
  const parsed = (() => {
    try {
      const value = JSON.parse(detail);
      return value?.error?.message || value?.message;
    } catch {
      return undefined;
    }
  })();
  const suffix = typeof parsed === "string" && parsed ? ` ${parsed}` : "";
  return `Antigravity OAuth upstream error (HTTP ${status}).${suffix}`;
}

export function antigravityUpstreamError(status, headers, detail = "") {
  const clientStatus = clientStatusForUpstream(status);
  return {
    status: clientStatus,
    headers: safeUpstreamHeaders(headers),
    body: {
      error: {
        message: errorMessageFromUpstream(status, detail),
        type: status === 401 ? "authentication_error" : "api_error",
        code: null,
        detail: detail.slice(0, 500) || undefined,
      },
    },
  };
}

function writeUpstreamError(response, upstream, detail) {
  const translated = antigravityUpstreamError(upstream.status, upstream.headers, detail);
  response.writeHead(translated.status, {
    "Content-Type": "application/json; charset=utf-8",
    ...translated.headers,
  });
  response.end(JSON.stringify(translated.body));
}

function writeWithBackpressure(response, chunk) {
  try {
    if (response.write(chunk)) return Promise.resolve();
  } catch (error) {
    error.responseWriteFailed = true;
    return Promise.reject(error);
  }
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      response.off("drain", onDrain);
      response.off("close", onClose);
      response.off("error", onError);
    };
    const onDrain = () => {
      cleanup();
      resolve();
    };
    const onClose = () => {
      cleanup();
      const error = new AntigravityForwarderError("The caller closed the response.", {
        status: 499,
        code: "caller_aborted",
      });
      error.callerAborted = true;
      reject(error);
    };
    const onError = (error) => {
      cleanup();
      error.responseWriteFailed = true;
      reject(error);
    };
    response.once("drain", onDrain);
    response.once("close", onClose);
    response.once("error", onError);
  });
}

const OPENAI_ROLE_CHUNK = (id, created, model, delta, finishReason = null) =>
  `data: ${JSON.stringify({
    id,
    object: "chat.completion.chunk",
    created,
    model,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  })}\n\n`;

function endOpenAiErrorStream(response, error, status) {
  if (response.writableEnded || response.destroyed) return;
  const providerCode = typeof error?.code === "string" ? error.code : "antigravity_stream_error";
  const body = {
    error: {
      message:
        error?.expose === true
          ? error.message
          : "The Antigravity OAuth forwarder could not complete the request.",
      type: status >= 500 ? "api_error" : "invalid_request_error",
      code: status,
      provider_code: providerCode,
    },
  };
  try {
    response.end(`data: ${JSON.stringify(body)}\n\n`);
  } catch {
    // The caller may disappear between the state check and the final write.
  }
}

async function handleChatCompletions(request, response) {
  let chat;
  try {
    chat = JSON.parse((await readRequestBody(request)).toString("utf8"));
  } catch {
    writeJson(response, 400, {
      error: {
        message: "The Antigravity OAuth forwarder expected a JSON request body.",
        type: "invalid_request_error",
        code: "invalid_json",
      },
    });
    return;
  }
  const wantsStream = chat.stream === true;
  const model = typeof chat.model === "string" ? chat.model : "";

  const controller = new AbortController();
  request.once("aborted", () => controller.abort());
  response.once("close", () => {
    if (!response.writableEnded) controller.abort();
  });

  const sessionAndProject = async ({ force = false } = {}) => {
    const session = await ensureFreshAntigravitySession({ force });
    return ensureAntigravityProject(session, { forceFallbackRefresh: force });
  };

  let context;
  try {
    context = await sessionAndProject();
  } catch (error) {
    const status = httpErrorStatus(error, 401);
    writeJson(response, status, {
      error: {
        message:
          error?.message ||
          (status === 401
            ? "Antigravity OAuth is not configured; run sign-in first."
            : "Antigravity OAuth could not prepare the Google session."),
        type: status === 401 || status === 403 ? "authentication_error" : "api_error",
        code: error?.code || null,
      },
    });
    return;
  }

  const requestId = `agent-${randomUUID()}`;
  let shapedBody;
  const makeUpstreamRequest = async (current) => {
    shapedBody = toAntigravityRequest(chat, {
      projectId: current.projectId,
      requestId,
    });
    return requestAntigravityUpstream({
      accessToken: current.session.access_token,
      serializedBody: JSON.stringify(shapedBody),
      signal: controller.signal,
    });
  };

  let upstream = await makeUpstreamRequest(context);
  if (upstream.status === 401) {
    await discardUpstream(upstream);
    try {
      context = await sessionAndProject({ force: true });
      // A forced refresh may load a different account snapshot. Rebuild both
      // access token and project in one body while retaining the request id.
      upstream = await makeUpstreamRequest(context);
    } catch (error) {
      const status = httpErrorStatus(error, 401);
      writeJson(response, status, {
        error: {
          message:
            error?.message || "Antigravity OAuth could not be refreshed; run sign-in again.",
          type: status === 401 || status === 403 ? "authentication_error" : "api_error",
          code: error?.code || null,
        },
      });
      return;
    }
  }

  if (!upstream.ok || !upstream.body) {
    const detail = await readUpstreamErrorDetail(upstream).catch(() => "");
    writeUpstreamError(response, upstream, detail);
    return;
  }

  const id = `chatcmpl-${randomUUID()}`;
  const created = Math.floor(Date.now() / 1_000);
  const state = createAntigravityTurnState();
  let emittedDeltaCount = 0;
  let streamStarted = false;
  const startStream = async () => {
    if (streamStarted) return;
    response.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      ...safeUpstreamHeaders(upstream.headers),
    });
    streamStarted = true;
    await writeWithBackpressure(
      response,
      OPENAI_ROLE_CHUNK(id, created, model, { role: "assistant", content: "" }),
    );
  };
  const flushDeltas = async () => {
    if (!wantsStream || emittedDeltaCount >= state.deltas.length) return;
    await startStream();
    while (emittedDeltaCount < state.deltas.length) {
      const delta = state.deltas[emittedDeltaCount++];
      await writeWithBackpressure(response, OPENAI_ROLE_CHUNK(id, created, model, delta));
    }
  };

  let turn;
  try {
    await consumeAntigravitySseStream(upstream.body, async (event) => {
      applyAntigravitySsePayload(state, event);
      await flushDeltas();
    }, {
      isTerminal: () => state.sawTerminal,
      shouldStop: () => state.sawTerminal && Boolean(state.usage),
    });
    turn = finalizeAntigravityTurn(state);
  } catch (error) {
    if (controller.signal.aborted) error.callerAborted = true;
    throw error;
  }

  if (wantsStream) {
    await flushDeltas();
    await startStream();
    await writeWithBackpressure(
      response,
      OPENAI_ROLE_CHUNK(id, created, model, {}, turn.finishReason),
    );
    if (turn.usage) {
      await writeWithBackpressure(
        response,
        `data: ${JSON.stringify({ id, object: "chat.completion.chunk", created, model, choices: [], usage: turn.usage })}\n\n`,
      );
    }
    await writeWithBackpressure(response, "data: [DONE]\n\n");
    response.end();
  } else {
    const message = { role: "assistant", content: turn.contentText || null };
    if (turn.reasoningText) message.reasoning_content = turn.reasoningText;
    if (turn.toolCalls.length) message.tool_calls = turn.toolCalls;
    writeJson(response, 200, {
      id,
      object: "chat.completion",
      created,
      model,
      choices: [{ index: 0, message, finish_reason: turn.finishReason }],
      usage: turn.usage || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    });
  }

  if (!QUIET) {
    console.error(`[antigravity-oauth] model=${model} status=${upstream.status}`);
  }
}

async function handleRequest(request, response) {
  if (!INTERNAL_KEY) {
    writeJson(response, 500, {
      error: { type: "api_error", message: "MODEL_ROUTER_INTERNAL_KEY is required." },
    });
    return;
  }
  const requestUrl = new URL(request.url || "/", `http://${request.headers.host || LISTEN_HOST}`);
  if (!requireInternalAuth(request, response, INTERNAL_KEY)) return;
  if (request.method === "GET" && requestUrl.pathname === "/health") {
    const status = antigravityOAuthStatus();
    writeJson(response, 200, {
      ok: true,
      service: "codex-router-antigravity-oauth-forwarder",
      credential_present: status.configured,
      ...(status.projectId ? { project_id: status.projectId } : {}),
    });
    return;
  }
  const route = requestUrl.pathname.replace(/^\/v1(?=\/|$)/, "");
  if (request.method === "POST" && route === "/chat/completions") {
    await handleChatCompletions(request, response);
    return;
  }
  writeJson(response, 404, {
    error: { type: "proxy_route_not_found", message: "Unsupported Antigravity OAuth route." },
  });
}

const isMain =
  process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isMain) {
  if (!INTERNAL_KEY) throw new Error("MODEL_ROUTER_INTERNAL_KEY is required.");
  const server = http.createServer((request, response) => {
    handleRequest(request, response).catch((error) => {
      const status = httpErrorStatus(error);
      if (error?.callerAborted || error?.responseWriteFailed || response.destroyed) return;
      console.error(
        `[antigravity-oauth] request failed: ${formatErrorChain(error, { messages: false })}`,
      );
      if (!response.headersSent) {
        writeJson(response, status, {
          error: {
            type: status >= 500 ? "api_error" : "invalid_request_error",
            message:
              error?.expose === true
                ? error.message
                : "The Antigravity OAuth forwarder could not complete the request.",
            code: error?.expose === true ? error.code || null : null,
          },
        });
      } else if (!response.writableEnded) {
        endOpenAiErrorStream(response, error, status);
      }
    });
  });

  applyKeepAliveTimeouts(server);
  reportListenFailure(server, {
    label: "antigravity-oauth",
    host: LISTEN_HOST,
    port: LISTEN_PORT,
  });
  server.listen(LISTEN_PORT, LISTEN_HOST, () => {
    console.error("[antigravity-oauth] listening");
  });

  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.on(signal, () => server.close(() => process.exit(0)));
  }
}
