import http from "node:http";

import {
  HOP_BY_HOP_HEADERS,
  httpErrorStatus,
  pipeResponse,
  readRequestBody,
  requireInternalAuth,
  writeJson,
} from "./http-utils.mjs";
import { PORTS, TARGET } from "./paths.mjs";
import {
  API_MODELS,
  MODEL_BY_GATEWAY_ID,
  PROVIDERS,
  providerForModel,
} from "./model-registry.mjs";
import {
  credentialStatus,
  resolveProviderCredential,
} from "./provider-credentials.mjs";
import { VERSION } from "./version.mjs";

const LISTEN_HOST =
  process.env.MODEL_ROUTER_API_HOST ||
  (TARGET === "codex"
    ? process.env.CODEX_ROUTER_API_HOST || process.env.KIMI_API_FORWARD_HOST
    : undefined) ||
  "127.0.0.1";
const LISTEN_PORT = Number(
  process.env.MODEL_ROUTER_API_PORT ||
    (TARGET === "codex"
      ? process.env.CODEX_ROUTER_API_PORT || process.env.KIMI_API_FORWARD_PORT
      : undefined) ||
    PORTS.api,
);
const INTERNAL_KEY =
  process.env.MODEL_ROUTER_INTERNAL_KEY ||
  (TARGET === "codex"
    ? process.env.CODEX_ROUTER_INTERNAL_KEY || process.env.KIMI_INTERNAL_KEY
    : undefined);
const QUIET =
  process.env.MODEL_ROUTER_QUIET === "1" ||
  (TARGET === "codex" &&
    (process.env.CODEX_ROUTER_QUIET === "1" || process.env.KIMI_PROXY_QUIET === "1"));

if (!INTERNAL_KEY) throw new Error("MODEL_ROUTER_INTERNAL_KEY is required.");

function providerBaseUrl(provider) {
  return String(process.env[provider.baseUrlEnv] || provider.baseUrl).replace(/\/+$/, "");
}

function deepSeekEffort(value) {
  return ["xhigh", "max", "ultra"].includes(value) ? "max" : "high";
}

function normalizeBody(buffer, contentType) {
  if (!buffer.length || !String(contentType || "").includes("application/json")) {
    const error = new Error("API-provider requests require a JSON body.");
    error.status = 400;
    throw error;
  }
  const payload = JSON.parse(buffer.toString("utf8"));
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    const error = new Error("Request JSON must be an object.");
    error.status = 400;
    throw error;
  }
  const model = MODEL_BY_GATEWAY_ID.get(payload.model);
  const provider = model && providerForModel(model);
  if (!model || provider?.kind !== "openai-compatible") {
    const error = new Error(`Unknown API gateway model: ${String(payload.model || "missing")}`);
    error.status = 400;
    throw error;
  }

  payload.model = model.upstreamModel;
  if (model.requestProfile === "kimi-k3") {
    payload.reasoning_effort = "max";
    delete payload.thinking;
  } else if (model.requestProfile === "deepseek-thinking") {
    payload.thinking = { type: "enabled" };
    payload.reasoning_effort = deepSeekEffort(payload.reasoning_effort);
    delete payload.temperature;
    delete payload.top_p;
    delete payload.presence_penalty;
    delete payload.frequency_penalty;
  } else if (model.requestProfile === "deepseek-nonthinking") {
    payload.thinking = { type: "disabled" };
    delete payload.reasoning_effort;
  }
  return { body: Buffer.from(JSON.stringify(payload), "utf8"), model, provider };
}

function upstreamHeaders(requestHeaders, body, apiKey) {
  const headers = {};
  for (const [name, value] of Object.entries(requestHeaders)) {
    const lower = name.toLowerCase();
    if (HOP_BY_HOP_HEADERS.has(lower) || lower === "authorization") continue;
    if (lower.startsWith("x-msh-") || lower.startsWith("x-codex-")) continue;
    if (lower.startsWith("x-openai-") || lower === "chatgpt-account-id") continue;
    if (lower === "originator" || lower === "user-agent" || lower === "accept-encoding") {
      continue;
    }
    if (value !== undefined) headers[name] = Array.isArray(value) ? value.join(", ") : value;
  }
  headers.Authorization = `Bearer ${apiKey}`;
  headers["User-Agent"] = `codex-router/${VERSION}`;
  headers["Accept-Encoding"] = "identity";
  if (body.length) headers["Content-Length"] = String(body.length);
  return headers;
}

function healthPayload() {
  const providers = {};
  for (const provider of PROVIDERS.values()) {
    if (provider.kind !== "openai-compatible") continue;
    const status = credentialStatus(provider);
    providers[provider.id] = {
      credential_present: status.configured,
      ...(status.configured
        ? { credential_source: status.source }
        : { setup: status.setup }),
    };
  }
  return { ok: true, service: "codex-router-api-forwarder", providers };
}

function localModels(response) {
  writeJson(response, 200, {
    object: "list",
    data: API_MODELS.map((model) => ({
      id: model.gatewayModel,
      object: "model",
      owned_by: providerForModel(model).ownedBy,
    })),
  });
}

async function handleRequest(request, response) {
  const startedAt = Date.now();
  const requestUrl = new URL(
    request.url || "/",
    `http://${request.headers.host || LISTEN_HOST}`,
  );
  if (!requireInternalAuth(request, response, INTERNAL_KEY)) return;
  if (request.method === "GET" && requestUrl.pathname === "/health") {
    writeJson(response, 200, healthPayload());
    return;
  }

  const route = requestUrl.pathname.replace(/^\/v1(?=\/|$)/, "");
  if (request.method === "GET" && route === "/models") {
    localModels(response);
    return;
  }
  if (request.method !== "POST" || route !== "/chat/completions") {
    writeJson(response, 404, {
      error: { type: "proxy_route_not_found", message: "Unsupported API-provider route." },
    });
    return;
  }

  const original = await readRequestBody(request);
  const normalized = normalizeBody(original, request.headers["content-type"]);
  const credential = resolveProviderCredential(normalized.provider);
  if (!credential) {
    const setup = credentialStatus(normalized.provider).setup;
    writeJson(response, 503, {
      error: {
        type: "provider_api_key_missing",
        provider: normalized.provider.id,
        message: `${normalized.provider.displayName} key is not configured. ${setup}.`,
      },
    });
    return;
  }

  const controller = new AbortController();
  request.once("aborted", () => controller.abort());
  response.once("close", () => {
    if (!response.writableEnded) controller.abort();
  });
  const target = `${providerBaseUrl(normalized.provider)}${route}${requestUrl.search}`;
  const upstream = await fetch(target, {
    method: request.method,
    headers: upstreamHeaders(request.headers, normalized.body, credential.value),
    body: normalized.body,
    signal: controller.signal,
  });
  await pipeResponse(upstream, response);
  if (!QUIET) {
    console.error(
      `[api-forwarder] provider=${normalized.provider.id} model=${normalized.model.upstreamModel} status=${upstream.status} duration_ms=${Date.now() - startedAt}`,
    );
  }
}

const server = http.createServer((request, response) => {
  handleRequest(request, response).catch((error) => {
    const status = httpErrorStatus(error);
    console.error("[api-forwarder] request failed");
    if (!response.headersSent) {
      writeJson(response, status, {
        error: {
          type: "provider_api_proxy_error",
          message: "The API-provider forwarder could not complete the request.",
        },
      });
    } else if (!response.writableEnded) {
      response.destroy();
    }
  });
});

server.listen(LISTEN_PORT, LISTEN_HOST, () => {
  console.error("[api-forwarder] listening");
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
