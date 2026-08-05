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
import { parseRateLimitHeaders } from "./rate-limit-headers.mjs";
import { recordRateLimitSnapshot } from "./rate-limit-state.mjs";
import { readProviderSelection } from "./provider-selection.mjs";
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

// Strict chat-completions providers (e.g. MiniMax) reject a turn whose tool
// result messages do not immediately follow the assistant message carrying the
// matching tool_calls. When the upstream Responses-API history is translated to
// chat completions, an assistant turn that produced both tool_calls and a text
// message can arrive as two consecutive assistant messages (one with
// tool_calls, one with the text), so the tool results no longer follow the
// tool-call-bearing assistant. Coalesce runs of consecutive assistant messages
// into a single assistant message (combining content and tool_calls) so the
// chat-completions contract holds. This is a safe normalization: consecutive
// assistant messages are not a valid multi-turn shape, so merging them cannot
// change a well-formed conversation.
function combineAssistantContent(target, source) {
  const sourceContent = source.content;
  if (sourceContent === undefined || sourceContent === null) return;
  const targetContent = target.content;
  if (targetContent === undefined || targetContent === null || targetContent === "") {
    target.content = sourceContent;
    return;
  }
  if (typeof targetContent === "string" && typeof sourceContent === "string") {
    target.content = `${targetContent}\n${sourceContent}`;
    return;
  }
  const targetBlocks = Array.isArray(targetContent) ? targetContent : [targetContent];
  const sourceBlocks = Array.isArray(sourceContent) ? sourceContent : [sourceContent];
  target.content = [...targetBlocks, ...sourceBlocks];
}

function coalesceAssistantMessages(messages) {
  if (!Array.isArray(messages) || messages.length < 2) return messages;
  const coalesced = [];
  for (const message of messages) {
    const previous = coalesced[coalesced.length - 1];
    if (
      message?.role === "assistant" &&
      previous?.role === "assistant" &&
      (Array.isArray(previous.tool_calls) || Array.isArray(message.tool_calls))
    ) {
      combineAssistantContent(previous, message);
      if (Array.isArray(message.tool_calls) && message.tool_calls.length) {
        previous.tool_calls = [...(previous.tool_calls || []), ...message.tool_calls];
      }
      continue;
    }
    coalesced.push(message);
  }
  return coalesced;
}

// Strict chat-completions providers (Console Go / MiniMax / similar) reject any
// assistant tool_calls message whose matching tool results are incomplete or
// separated by non-tool traffic. LiteLLM's Responses->chat translation and
// Codex remote compact can emit orphan tool_calls after interrupted tool runs
// or partial history. Insert synthetic tool results for missing call ids so
// the request stays well-formed. Prefer a short machine-readable stub over
// dropping history, which would erase useful prior context.
const SYNTHETIC_TOOL_RESULT =
  "[tool result unavailable: prior tool execution was interrupted or omitted from history]";

function toolCallIds(message) {
  if (!Array.isArray(message?.tool_calls)) return [];
  return message.tool_calls
    .map((call) => (typeof call?.id === "string" ? call.id : ""))
    .filter(Boolean);
}

function ensureToolResultsForCalls(messages) {
  if (!Array.isArray(messages) || messages.length === 0) return messages;
  const repaired = [];
  let index = 0;
  while (index < messages.length) {
    const message = messages[index];
    // Tool rows are only valid immediately after their assistant tool_calls.
    // Anything else (orphans after compaction, duplicates after intervening
    // turns) is dropped so strict providers do not reject the whole request.
    if (message?.role === "tool") {
      index += 1;
      continue;
    }

    repaired.push(message);
    const callIds = toolCallIds(message);
    if (message?.role !== "assistant" || callIds.length === 0) {
      index += 1;
      continue;
    }

    index += 1;
    const toolsById = new Map();
    while (index < messages.length && messages[index]?.role === "tool") {
      const toolMessage = messages[index];
      const toolCallId =
        typeof toolMessage?.tool_call_id === "string" ? toolMessage.tool_call_id : "";
      if (toolCallId && callIds.includes(toolCallId) && !toolsById.has(toolCallId)) {
        toolsById.set(toolCallId, toolMessage);
      }
      index += 1;
    }

    for (const callId of callIds) {
      repaired.push(
        toolsById.get(callId) || {
          role: "tool",
          tool_call_id: callId,
          content: SYNTHETIC_TOOL_RESULT,
        },
      );
    }
  }
  return repaired;
}

function sanitizeChatToolHistory(messages) {
  if (!Array.isArray(messages)) return messages;
  return ensureToolResultsForCalls(coalesceAssistantMessages(messages));
}

function normalizeBody(buffer, contentType, route) {
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
  const requestedModel = String(payload.model || "");
  // LiteLLM's Responses bridge prefixes the gateway id with `responses/` on
  // the upstream wire format; the forwarder still owns the id translation.
  const model =
    MODEL_BY_GATEWAY_ID.get(requestedModel.replace(/^responses\//, "")) ||
    MODEL_BY_GATEWAY_ID.get(requestedModel);
  const provider = model && providerForModel(model);
  if (!model || provider?.kind !== "openai-compatible") {
    const error = new Error(`Unknown API gateway model: ${String(payload.model || "missing")}`);
    error.status = 400;
    throw error;
  }
  const protocolSurface = model.protocol || provider.protocol;
  const expectedRoute =
    protocolSurface === "anthropic"
      ? "/messages"
      : protocolSurface === "openai-responses"
        ? "/responses"
        : "/chat/completions";
  if (route !== expectedRoute) {
    const error = new Error(`Model ${model.gatewayModel} does not support ${route}.`);
    error.status = 400;
    throw error;
  }

  payload.model = model.upstreamModel;
  if (Array.isArray(payload.messages)) {
    payload.messages = sanitizeChatToolHistory(payload.messages);
  }
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
  } else if (model.requestProfile === "ollama-cloud") {
    // Ollama's OpenAI-compatible surface does not document reasoning_effort;
    // hosted models reason by default, so drop the parameter.
    delete payload.reasoning_effort;
  } else if (model.requestProfile === "qwen-plan") {
    // DashScope's OpenAI-compatible mode does not document reasoning_effort;
    // Qwen3.7 models reason adaptively by default, so drop the parameter
    // rather than risk an invalid-parameter rejection.
    delete payload.reasoning_effort;
    // Qwen rejects forced tool choices in thinking mode
    // ("tool_choice ... does not support being set to required or object");
    // downgrade to auto so tool calls stay available.
    if (payload.tool_choice !== undefined && payload.tool_choice !== "none") {
      payload.tool_choice = "auto";
    }
  } else if (model.requestProfile === "glm-thinking") {
    payload.thinking = { type: "enabled" };
    if (["xhigh", "max", "ultra"].includes(payload.reasoning_effort)) {
      payload.reasoning_effort = "max";
    } else {
      // Z.ai documents only the maximum tier; leave other levels to the
      // upstream default rather than sending an unsupported value.
      delete payload.reasoning_effort;
    }
    // Z.ai requires temperature 1.0 with thinking enabled; drop sampling
    // overrides so the upstream default applies.
    delete payload.temperature;
    delete payload.top_p;
  } else if (model.requestProfile === "xai-reasoning") {
    if (!["low", "medium", "high"].includes(payload.reasoning_effort)) {
      payload.reasoning_effort = "high";
    }
    delete payload.presence_penalty;
    delete payload.frequency_penalty;
    delete payload.stop;
  } else if (model.requestProfile === "anthropic-reasoning") {
    delete payload.reasoning_effort;
    payload.thinking = { type: "adaptive" };
    payload.output_config = { effort: "high" };
  } else if (model.requestProfile === "minimax-m3") {
    // MiniMax uses its own thinking control on the OpenAI-compatible
    // Chat Completions endpoint instead of reasoning_effort.
    delete payload.reasoning_effort;
    payload.thinking = { type: "adaptive" };
  }
  return { body: Buffer.from(JSON.stringify(payload), "utf8"), model, provider };
}

function upstreamHeaders(requestHeaders, body, apiKey, provider) {
  const headers = {};
  for (const [name, value] of Object.entries(requestHeaders)) {
    const lower = name.toLowerCase();
    if (HOP_BY_HOP_HEADERS.has(lower) || lower === "authorization" || lower === "x-api-key") continue;
    if (lower.startsWith("x-msh-") || lower.startsWith("x-codex-")) continue;
    if (lower.startsWith("x-openai-") || lower === "chatgpt-account-id") continue;
    if (lower === "originator" || lower === "user-agent" || lower === "accept-encoding") {
      continue;
    }
    if (value !== undefined) headers[name] = Array.isArray(value) ? value.join(", ") : value;
  }
  if (provider.protocol === "anthropic") {
    headers["x-api-key"] = apiKey;
    headers["anthropic-version"] ||= "2023-06-01";
  } else {
    headers.Authorization = `Bearer ${apiKey}`;
  }
  headers["User-Agent"] = `codex-router/${VERSION}`;
  headers["Accept-Encoding"] = "identity";
  if (body.length) headers["Content-Length"] = String(body.length);
  return headers;
}

function healthPayload() {
  const providers = {};
  const enabled = new Set(readProviderSelection());
  for (const provider of PROVIDERS.values()) {
    if (provider.kind !== "openai-compatible" || !enabled.has(provider.id)) continue;
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
  if (
    request.method !== "POST" ||
    !["/chat/completions", "/messages", "/responses"].includes(route)
  ) {
    writeJson(response, 404, {
      error: { type: "proxy_route_not_found", message: "Unsupported API-provider route." },
    });
    return;
  }

  const original = await readRequestBody(request);
  const normalized = normalizeBody(original, request.headers["content-type"], route);
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
    headers: upstreamHeaders(request.headers, normalized.body, credential.value, normalized.provider),
    body: normalized.body,
    signal: controller.signal,
  });
  await pipeResponse(upstream, response);
  // Harvest the provider's own quota report from the response it just sent.
  // Costs no extra request and works for any provider that emits the standard
  // headers, so a newly added provider reports limits without bespoke code.
  // Recorded after the body streams because persisting is synchronous I/O and
  // must never sit in time-to-first-byte.
  const rateLimit = parseRateLimitHeaders(upstream.headers);
  if (rateLimit) recordRateLimitSnapshot(normalized.provider.id, rateLimit);
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
