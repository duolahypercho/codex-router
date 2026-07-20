import { readFileSync } from "node:fs";
import http from "node:http";

import {
  assertCallerSecret,
  secretEqual,
} from "./caller-auth.mjs";
import {
  collectAnthropicSse,
  createAnthropicSseModelTransform,
} from "./anthropic-stream.mjs";
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
  MODEL_BY_SLUG,
  providerForModel,
} from "./model-registry.mjs";
import {
  readProviderSelection,
  selectedListedModels,
} from "./provider-selection.mjs";
import { VERSION } from "./version.mjs";

const LISTEN_HOST = process.env.CLAUDE_ROUTER_HOST || "127.0.0.1";
const LISTEN_PORT = Number(process.env.CLAUDE_ROUTER_PORT || PORTS.router);
const GATEWAY_BASE = (
  process.env.MODEL_ROUTER_GATEWAY_BASE_URL ||
  loopback(PORTS.gateway, "/v1")
).replace(/\/+$/, "");
const OAUTH_HEALTH =
  process.env.MODEL_ROUTER_OAUTH_HEALTH_URL ||
  loopback(PORTS.oauth, "/health");
const API_HEALTH =
  process.env.MODEL_ROUTER_API_HEALTH_URL ||
  loopback(PORTS.api, "/health");
const GATEWAY_HEALTH =
  process.env.MODEL_ROUTER_GATEWAY_HEALTH_URL ||
  loopback(PORTS.gateway, "/health/liveliness");
const QUIET = process.env.MODEL_ROUTER_QUIET === "1";

function requiredSecret(target, label) {
  try {
    return assertCallerSecret(readFileSync(target, "utf8").trim());
  } catch {
    throw new Error(`${label} is missing or invalid; run ./bin/model-router claude doctor --fix.`);
  }
}

const INTERNAL_KEY =
  process.env.MODEL_ROUTER_INTERNAL_KEY ||
  requiredSecret(INTERNAL_SECRET_PATH, "The internal service key");
const CALLER_KEY =
  process.env.CLAUDE_ROUTER_CALLER_KEY ||
  process.env.MODEL_ROUTER_CALLER_KEY ||
  requiredSecret(CALLER_SECRET_PATH, "The Claude caller key");

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
  writeJson(response, 401, {
    type: "error",
    error: {
      type: "authentication_error",
      message: "The local Claude router requires its configured caller key.",
    },
  });
  return false;
}

function requireDesktopTransport(request, response) {
  if (request.headers.origin || request.headers["sec-fetch-site"]) {
    writeJson(response, 403, {
      type: "error",
      error: {
        type: "permission_error",
        message: "Browser-originated requests are not accepted by the local Claude router.",
      },
    });
    return false;
  }
  const encoding = String(request.headers["content-encoding"] || "identity").toLowerCase();
  if (encoding !== "identity") {
    writeJson(response, 415, {
      type: "error",
      error: {
        type: "invalid_request_error",
        message: "Compressed Claude router requests are not supported.",
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
      type: "error",
      error: {
        type: "invalid_request_error",
        message: "Claude router requests require Content-Type: application/json.",
      },
    });
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

function enabledRoute(modelId) {
  const registered = MODEL_BY_SLUG.get(modelId);
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
    "User-Agent": `codex-router-claude/${VERSION}`,
    "anthropic-version": String(request.headers["anthropic-version"] || "2023-06-01"),
  };
  const accept = request.headers.accept;
  if (accept !== undefined) headers.Accept = Array.isArray(accept) ? accept.join(", ") : accept;
  const beta = request.headers["anthropic-beta"];
  if (beta !== undefined) {
    headers["anthropic-beta"] = Array.isArray(beta) ? beta.join(", ") : beta;
  }
  return headers;
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
    service: "claude-router",
    version: VERSION,
    router: "ready",
    oauth,
    api,
    gateway,
  };
}

function handleModels(response) {
  const data = selectedListedModels().map((model) => ({
    id: model.slug,
    type: "model",
    display_name: model.displayName,
    owned_by: providerForModel(model).ownedBy,
  }));
  writeJson(response, 200, {
    data,
    has_more: false,
    first_id: data[0]?.id || null,
    last_id: data.at(-1)?.id || null,
  });
}

async function handleMessages(request, response) {
  if (!requireDesktopTransport(request, response)) return;
  const payload = parsePayload(await readRequestBody(request));
  const requestedModel = typeof payload.model === "string" ? payload.model : "";
  const route = enabledRoute(requestedModel);
  if (route.error === "unknown") {
    writeJson(response, 400, {
      type: "error",
      error: {
        type: "invalid_request_error",
        message: "The requested model is not registered with the local Claude router.",
      },
    });
    return;
  }
  if (route.error === "disabled") {
    writeJson(response, 409, {
      type: "error",
      error: {
        type: "provider_not_enabled",
        provider: route.model.provider,
        message: `Provider ${route.model.provider} is not enabled for the Claude target.`,
      },
    });
    return;
  }

  const clientWantsStream = payload.stream === true;
  const body = Buffer.from(
    JSON.stringify({
      ...payload,
      model: route.model.gatewayModel,
      ...(!clientWantsStream ? { stream: true } : {}),
    }),
    "utf8",
  );
  const controller = new AbortController();
  request.once("aborted", () => controller.abort());
  response.once("close", () => {
    if (!response.writableEnded) controller.abort();
  });
  const upstream = await fetch(`${GATEWAY_BASE}/messages`, {
    method: "POST",
    headers: gatewayHeaders(request),
    body,
    signal: controller.signal,
  });
  if (!upstream.ok) {
    await pipeResponse(upstream, response, HOP_BY_HOP_HEADERS);
  } else if (clientWantsStream) {
    await pipeResponse(
      upstream,
      response,
      HOP_BY_HOP_HEADERS,
      createAnthropicSseModelTransform(requestedModel),
    );
  } else {
    const message = collectAnthropicSse(await upstream.text(), requestedModel);
    writeJson(response, 200, message);
  }
  if (!QUIET) {
    console.error(
      `[claude-router] model=${requestedModel} provider=${route.model.provider} status=${upstream.status}`,
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
  if (request.method === "POST" && route === "/messages") {
    await handleMessages(request, response);
    return;
  }
  writeJson(response, 404, {
    type: "error",
    error: {
      type: "not_found_error",
      message: "Unsupported Claude router route.",
    },
  });
}

const server = http.createServer((request, response) => {
  handleRequest(request, response).catch((error) => {
    const status = httpErrorStatus(error);
    console.error("[claude-router] request failed");
    if (!response.headersSent) {
      writeJson(response, status, {
        type: "error",
        error: {
          type: status >= 500 ? "api_error" : "invalid_request_error",
          message:
            status >= 500
              ? "The local Claude router could not complete the request."
              : "The Claude request was rejected.",
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
  console.error("[claude-router] listening");
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
