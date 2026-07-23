import { readFileSync } from "node:fs";
import http from "node:http";

import { assertCallerSecret, secretEqual } from "./caller-auth.mjs";
import {
  HOP_BY_HOP_HEADERS,
  httpErrorStatus,
  pipeResponse,
  readRequestBody,
  writeJson,
} from "./http-utils.mjs";
import {
  CALLER_SECRET_PATH,
  INTERNAL_SECRET_PATH,
  PORTS,
  loopback,
} from "./paths.mjs";
import {
  MODEL_BY_GATEWAY_ID,
  MODEL_BY_SLUG,
  providerForModel,
} from "./model-registry.mjs";
import {
  readProviderSelection,
  selectedListedModels,
} from "./provider-selection.mjs";
import { VERSION } from "./version.mjs";

// Cursor speaks the OpenAI Chat Completions API and the LiteLLM gateway already
// speaks it too, so this frontend is a thin authenticating reverse proxy — it
// never translates protocols, it only authenticates the caller, validates the
// model against the enabled registry, and swaps in the internal service key.

const LISTEN_HOST = process.env.CURSOR_ROUTER_HOST || "127.0.0.1";
const LISTEN_PORT = Number(process.env.CURSOR_ROUTER_PORT || PORTS.router);
const GATEWAY_BASE = (
  process.env.MODEL_ROUTER_GATEWAY_BASE_URL || loopback(PORTS.gateway, "/v1")
).replace(/\/+$/, "");
const OAUTH_HEALTH =
  process.env.MODEL_ROUTER_OAUTH_HEALTH_URL || loopback(PORTS.oauth, "/health");
const API_HEALTH =
  process.env.MODEL_ROUTER_API_HEALTH_URL || loopback(PORTS.api, "/health");
const GATEWAY_HEALTH =
  process.env.MODEL_ROUTER_GATEWAY_HEALTH_URL ||
  loopback(PORTS.gateway, "/health/liveliness");
const QUIET = process.env.MODEL_ROUTER_QUIET === "1";

function requiredSecret(target, label) {
  try {
    return assertCallerSecret(readFileSync(target, "utf8").trim());
  } catch {
    throw new Error(
      `${label} is missing or invalid; run ./bin/model-router cursor doctor --fix.`,
    );
  }
}

const INTERNAL_KEY =
  process.env.MODEL_ROUTER_INTERNAL_KEY ||
  requiredSecret(INTERNAL_SECRET_PATH, "The internal service key");
const CALLER_KEY =
  process.env.CURSOR_ROUTER_CALLER_KEY ||
  process.env.MODEL_ROUTER_CALLER_KEY ||
  requiredSecret(CALLER_SECRET_PATH, "The Cursor caller key");

function openAiError(response, status, message, type = "invalid_request_error") {
  writeJson(response, status, { error: { message, type, code: null } });
}

function authorized(request) {
  const authorization = request.headers.authorization;
  const apiKey = request.headers["x-api-key"];
  return (
    secretEqual(authorization, `Bearer ${CALLER_KEY}`) ||
    secretEqual(apiKey, CALLER_KEY)
  );
}

function requireCallerAuth(request, response) {
  if (authorized(request)) return true;
  openAiError(
    response,
    401,
    "The local Cursor router requires its configured caller key.",
    "authentication_error",
  );
  return false;
}

// Only a real remote web page (http/https, non-loopback host) is the threat.
// Electron apps like Cursor send app-scheme/null/loopback origins
// plus Sec-Fetch-* headers legitimately; the caller key is the real auth.
function isRemoteWebOrigin(origin) {
  if (!origin || origin === "null") return false;
  let url;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  return !["127.0.0.1", "localhost", "::1", "[::1]"].includes(url.hostname);
}

function requireDesktopTransport(request, response) {
  const origin = request.headers.origin;
  if (isRemoteWebOrigin(origin)) {
    if (!QUIET) console.error(`[cursor-router] rejected remote web origin ${origin}`);
    openAiError(
      response,
      403,
      "Browser-originated requests are not accepted by the local Cursor router.",
      "permission_error",
    );
    return false;
  }
  const encoding = String(request.headers["content-encoding"] || "identity").toLowerCase();
  if (encoding !== "identity") {
    openAiError(response, 415, "Compressed Cursor router requests are not supported.");
    return false;
  }
  const contentType = String(request.headers["content-type"] || "")
    .split(";", 1)[0]
    .trim()
    .toLowerCase();
  if (contentType !== "application/json") {
    openAiError(
      response,
      415,
      "Cursor router requests require Content-Type: application/json.",
    );
    return false;
  }
  return true;
}

function parsePayload(buffer) {
  let payload;
  try {
    payload = JSON.parse(buffer.toString("utf8"));
  } catch {
    const error = new Error("The request body is not valid JSON.");
    error.status = 400;
    throw error;
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    const error = new Error("The request JSON must be an object.");
    error.status = 400;
    throw error;
  }
  return payload;
}

// Accept either the gateway model id (what /models advertises) or the registry
// slug, so a hand-typed Cursor config still resolves.
function resolveModel(requested) {
  return MODEL_BY_GATEWAY_ID.get(requested) || MODEL_BY_SLUG.get(requested);
}

function enabledRoute(modelId) {
  const registered = resolveModel(modelId);
  if (!registered) return { error: "unknown" };
  if (!readProviderSelection().includes(registered.provider)) {
    return { error: "disabled", model: registered };
  }
  return { model: registered };
}

function gatewayHeaders(request) {
  const headers = {
    Authorization: `Bearer ${INTERNAL_KEY}`,
    "Content-Type": "application/json",
    "Accept-Encoding": "identity",
    "User-Agent": `codex-router-cursor/${VERSION}`,
  };
  const accept = request.headers.accept;
  if (accept !== undefined) headers.Accept = Array.isArray(accept) ? accept.join(", ") : accept;
  return headers;
}

async function serviceHealth(url) {
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
  const [oauth, api, gateway] = await Promise.all([
    serviceHealth(OAUTH_HEALTH),
    serviceHealth(API_HEALTH),
    serviceHealth(GATEWAY_HEALTH),
  ]);
  return {
    ok: oauth.reachable && api.reachable && gateway.reachable,
    service: "cursor-router",
    version: VERSION,
    router: "ready",
    oauth,
    api,
    gateway,
  };
}

function handleModels(response) {
  const data = selectedListedModels().map((model) => ({
    id: model.gatewayModel,
    object: "model",
    created: 0,
    owned_by: providerForModel(model).ownedBy,
  }));
  writeJson(response, 200, { object: "list", data });
}

async function handleChatCompletions(request, response) {
  if (!requireDesktopTransport(request, response)) return;
  const raw = await readRequestBody(request);
  const payload = parsePayload(raw);
  const requestedModel = typeof payload.model === "string" ? payload.model : "";
  const route = enabledRoute(requestedModel);
  if (route.error === "unknown") {
    openAiError(
      response,
      400,
      "The requested model is not registered with the local Cursor router.",
      "model_not_found",
    );
    return;
  }
  if (route.error === "disabled") {
    openAiError(
      response,
      409,
      `Provider ${route.model.provider} is not enabled for the Cursor target.`,
      "provider_not_enabled",
    );
    return;
  }

  // Forward the original bytes untouched when the model already matches the
  // gateway id; only re-serialize when we resolved a slug alias.
  const body =
    payload.model === route.model.gatewayModel
      ? raw
      : Buffer.from(
          JSON.stringify({ ...payload, model: route.model.gatewayModel }),
          "utf8",
        );

  const controller = new AbortController();
  request.once("aborted", () => controller.abort());
  response.once("close", () => {
    if (!response.writableEnded) controller.abort();
  });
  const upstream = await fetch(`${GATEWAY_BASE}/chat/completions`, {
    method: "POST",
    headers: gatewayHeaders(request),
    body,
    signal: controller.signal,
  });
  // OpenAI-to-OpenAI: stream and non-stream responses pipe through unchanged.
  await pipeResponse(upstream, response, HOP_BY_HOP_HEADERS);
  if (!QUIET) {
    console.error(
      `[cursor-router] model=${route.model.gatewayModel} provider=${route.model.provider} status=${upstream.status}`,
    );
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
    });
    return;
  }
  if (!requireCallerAuth(request, response)) return;

  const route = requestUrl.pathname.replace(/^\/v1(?=\/|$)/, "");
  if (request.method === "GET" && route === "/health") {
    const health = await healthPayload();
    writeJson(response, health.ok ? 200 : 503, health);
    return;
  }
  if (request.method === "GET" && route === "/models") {
    handleModels(response);
    return;
  }
  if (request.method === "POST" && route === "/chat/completions") {
    await handleChatCompletions(request, response);
    return;
  }
  openAiError(response, 404, "Unsupported Cursor router route.", "not_found_error");
}

const server = http.createServer((request, response) => {
  handleRequest(request, response).catch((error) => {
    const status = httpErrorStatus(error);
    console.error("[cursor-router] request failed");
    if (!response.headersSent) {
      openAiError(
        response,
        status,
        status >= 500
          ? "The local Cursor router could not complete the request."
          : "The Cursor request was rejected.",
        status >= 500 ? "api_error" : "invalid_request_error",
      );
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
  console.error("[cursor-router] listening");
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
