import { execFileSync } from "node:child_process";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

import {
  httpErrorStatus,
  readRequestBody,
  requireInternalAuth,
  writeJson,
} from "./http-utils.mjs";
import { PORTS } from "./paths.mjs";
import { ensureFreshGrokOAuthToken } from "./grok-oauth-session.mjs";
import { grokOAuthStatus } from "./grok-oauth-status.mjs";
import { VERSION } from "./version.mjs";

// LiteLLM speaks OpenAI Chat Completions to this forwarder. It reuses the
// official Grok CLI OAuth session and translates to xAI's Responses proxy.

const LISTEN_HOST = process.env.MODEL_ROUTER_GROK_OAUTH_HOST || "127.0.0.1";
const LISTEN_PORT = Number(process.env.MODEL_ROUTER_GROK_OAUTH_PORT || PORTS.grokOauth);
const GROK_BASE = (
  process.env.GROK_CLI_CHAT_PROXY_BASE_URL || "https://cli-chat-proxy.grok.com/v1"
).replace(/\/+$/, "");
const INTERNAL_KEY = process.env.MODEL_ROUTER_INTERNAL_KEY;
const QUIET = process.env.MODEL_ROUTER_QUIET === "1";

// Hosted search tools run on xAI's Responses backend (same surface Grok Build
// uses). They are free only to the extent the Grok OAuth account includes them.
// Set GROK_OAUTH_HOSTED_SEARCH=0 to disable injection.
//
// Tool parameters follow current xAI docs:
//   x_search: allowed_x_handles, excluded_x_handles, from_date, to_date,
//             enable_image_understanding, enable_video_understanding
//   web_search: allowed_domains, excluded_domains,
//               enable_image_understanding, enable_image_search
// Configure via GROK_OAUTH_SEARCH_PARAMETERS JSON, request-body fields, or
// the individual GROK_OAUTH_* env vars documented in README.
const HOSTED_SEARCH_ENABLED = !["0", "false", "off", "no"].includes(
  String(process.env.GROK_OAUTH_HOSTED_SEARCH || "1").toLowerCase(),
);
const HOSTED_SEARCH_FUNCTION_NAMES = new Set(["web_search", "x_search"]);

function grokClientVersion() {
  const fallbackVersion = VERSION.match(/\b(\d+\.\d+\.\d+)\b/)?.[1] || "0.0.0";
  const executable =
    process.env.GROK_CLI || path.join(process.env.GROK_HOME || path.join(os.homedir(), ".grok"), "bin", "grok");
  try {
    const output = execFileSync(executable, ["version"], {
      encoding: "utf8",
      timeout: 2_000,
      stdio: ["ignore", "pipe", "ignore"],
    });
    return output.match(/\b(\d+\.\d+\.\d+)\b/)?.[1] || fallbackVersion;
  } catch {
    return fallbackVersion;
  }
}

const GROK_CLIENT_VERSION = grokClientVersion();

function grokUserAgent() {
  const platform = { darwin: "macos", win32: "windows" }[process.platform] || process.platform;
  const architecture = { arm64: "aarch64", x64: "x86_64" }[process.arch] || process.arch;
  return `grok-shell/${GROK_CLIENT_VERSION} (${platform}; ${architecture})`;
}

function contentToText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((part) => part && (part.type === "text" || typeof part.text === "string"))
    .map((part) => part.text || "")
    .join("");
}

function messageContentParts(content, textType) {
  if (typeof content === "string") return [{ type: textType, text: content }];
  if (!Array.isArray(content)) return [{ type: textType, text: "" }];
  const parts = [];
  for (const part of content) {
    if (part?.type === "image_url" && part.image_url?.url) {
      parts.push({ type: "input_image", image_url: part.image_url.url });
    } else if (typeof part?.text === "string") {
      parts.push({ type: textType, text: part.text });
    }
  }
  return parts.length ? parts : [{ type: textType, text: "" }];
}

function mapEffort(effort) {
  if (effort === "minimal") return "low";
  if (["none", "low"].includes(effort)) return "low";
  if (["xhigh", "max"].includes(effort)) return "high";
  return ["medium", "high"].includes(effort) ? effort : undefined;
}

function truthyEnv(value, fallback = false) {
  if (value == null || value === "") return fallback;
  return !["0", "false", "off", "no"].includes(String(value).toLowerCase());
}

function splitList(value, { max } = {}) {
  if (value == null || value === "") return undefined;
  const items = (Array.isArray(value) ? value : String(value).split(/[\s,]+/))
    .map((item) => String(item).trim().replace(/^@/, ""))
    .filter(Boolean);
  if (!items.length) return undefined;
  return max ? items.slice(0, max) : items;
}

function isoDate(value) {
  if (value == null || value === "") return undefined;
  const text = String(value).trim();
  if (!text) return undefined;
  // Accept YYYY-MM-DD or full ISO8601; pass through if parseable.
  if (Number.isNaN(Date.parse(text))) return undefined;
  return text;
}

function parseJsonEnv(name) {
  const raw = process.env[name];
  if (!raw) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

function compactObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const out = {};
  for (const [key, item] of Object.entries(value)) {
    if (item == null || item === "") continue;
    if (Array.isArray(item) && item.length === 0) continue;
    out[key] = item;
  }
  return Object.keys(out).length ? out : undefined;
}

// Map current xAI tool params plus the older chat-completions SearchParameters
// shape (sources/mode/from_date/...) onto hosted tool objects.
export function resolveHostedSearchConfig(input = {}, env = process.env) {
  const body = input && typeof input === "object" ? input : {};
  const envJson = parseJsonEnv("GROK_OAUTH_SEARCH_PARAMETERS") || {};
  const legacy =
    body.search_parameters && typeof body.search_parameters === "object"
      ? body.search_parameters
      : envJson.search_parameters && typeof envJson.search_parameters === "object"
        ? envJson.search_parameters
        : {};

  const mode = String(legacy.mode || body.search_mode || env.GROK_OAUTH_SEARCH_MODE || "on").toLowerCase();
  let enabled = truthyEnv(env.GROK_OAUTH_HOSTED_SEARCH, true);
  if (mode === "off") enabled = false;
  if (body.hosted_search === false || body.hostedSearch === false) enabled = false;

  // Which tools to include. Default both; legacy sources can narrow this.
  let includeWeb = true;
  let includeX = true;
  const sources = Array.isArray(legacy.sources)
    ? legacy.sources
    : Array.isArray(body.sources)
      ? body.sources
      : Array.isArray(envJson.sources)
        ? envJson.sources
        : undefined;
  if (sources) {
    const types = new Set(
      sources
        .map((source) => (typeof source === "string" ? source : source?.type))
        .filter(Boolean)
        .map((type) => String(type).toLowerCase()),
    );
    if (types.size) {
      includeWeb = types.has("web") || types.has("news") || types.has("rss");
      includeX = types.has("x");
      // Empty/unknown source list still keeps defaults only when no typed sources.
      if (!includeWeb && !includeX) {
        includeWeb = true;
        includeX = true;
      }
    }
  }

  const xSource = Array.isArray(sources)
    ? sources.find((source) => (typeof source === "object" && source?.type === "x"))
    : undefined;
  const webSource = Array.isArray(sources)
    ? sources.find((source) => (typeof source === "object" && (source?.type === "web" || source?.type === "news")))
    : undefined;

  const xBody = body.x_search && typeof body.x_search === "object" ? body.x_search : {};
  const webBody = body.web_search && typeof body.web_search === "object" ? body.web_search : {};
  const xEnv = envJson.x_search && typeof envJson.x_search === "object" ? envJson.x_search : {};
  const webEnv = envJson.web_search && typeof envJson.web_search === "object" ? envJson.web_search : {};

  const fromDate =
    isoDate(xBody.from_date) ||
    isoDate(body.from_date) ||
    isoDate(legacy.from_date) ||
    isoDate(xEnv.from_date) ||
    isoDate(env.GROK_OAUTH_X_SEARCH_FROM_DATE) ||
    isoDate(env.GROK_OAUTH_SEARCH_FROM_DATE);
  const toDate =
    isoDate(xBody.to_date) ||
    isoDate(body.to_date) ||
    isoDate(legacy.to_date) ||
    isoDate(xEnv.to_date) ||
    isoDate(env.GROK_OAUTH_X_SEARCH_TO_DATE) ||
    isoDate(env.GROK_OAUTH_SEARCH_TO_DATE);

  const xSearch = compactObject({
    allowed_x_handles: splitList(
      xBody.allowed_x_handles ??
        xBody.included_x_handles ??
        xSource?.included_x_handles ??
        xSource?.x_handles ??
        xEnv.allowed_x_handles ??
        xEnv.included_x_handles ??
        env.GROK_OAUTH_X_SEARCH_ALLOWED_HANDLES,
      { max: 20 },
    ),
    excluded_x_handles: splitList(
      xBody.excluded_x_handles ??
        xSource?.excluded_x_handles ??
        xEnv.excluded_x_handles ??
        env.GROK_OAUTH_X_SEARCH_EXCLUDED_HANDLES,
      { max: 20 },
    ),
    from_date: fromDate,
    to_date: toDate,
    enable_image_understanding:
      xBody.enable_image_understanding ??
      xEnv.enable_image_understanding ??
      (env.GROK_OAUTH_X_SEARCH_ENABLE_IMAGE_UNDERSTANDING == null
        ? undefined
        : truthyEnv(env.GROK_OAUTH_X_SEARCH_ENABLE_IMAGE_UNDERSTANDING)),
    enable_video_understanding:
      xBody.enable_video_understanding ??
      xEnv.enable_video_understanding ??
      (env.GROK_OAUTH_X_SEARCH_ENABLE_VIDEO_UNDERSTANDING == null
        ? undefined
        : truthyEnv(env.GROK_OAUTH_X_SEARCH_ENABLE_VIDEO_UNDERSTANDING)),
  });

  // Mutually exclusive handle filters per xAI docs.
  if (xSearch?.allowed_x_handles && xSearch?.excluded_x_handles) {
    delete xSearch.excluded_x_handles;
  }

  const webSearch = compactObject({
    allowed_domains: splitList(
      webBody.allowed_domains ??
        webSource?.allowed_websites ??
        webEnv.allowed_domains ??
        env.GROK_OAUTH_WEB_SEARCH_ALLOWED_DOMAINS,
      { max: 5 },
    ),
    excluded_domains: splitList(
      webBody.excluded_domains ??
        webSource?.excluded_websites ??
        webEnv.excluded_domains ??
        env.GROK_OAUTH_WEB_SEARCH_EXCLUDED_DOMAINS,
      { max: 5 },
    ),
    enable_image_understanding:
      webBody.enable_image_understanding ??
      webEnv.enable_image_understanding ??
      (env.GROK_OAUTH_WEB_SEARCH_ENABLE_IMAGE_UNDERSTANDING == null
        ? undefined
        : truthyEnv(env.GROK_OAUTH_WEB_SEARCH_ENABLE_IMAGE_UNDERSTANDING)),
    enable_image_search:
      webBody.enable_image_search ??
      webEnv.enable_image_search ??
      (env.GROK_OAUTH_WEB_SEARCH_ENABLE_IMAGE_SEARCH == null
        ? undefined
        : truthyEnv(env.GROK_OAUTH_WEB_SEARCH_ENABLE_IMAGE_SEARCH)),
  });

  if (webSearch?.allowed_domains && webSearch?.excluded_domains) {
    delete webSearch.excluded_domains;
  }

  return {
    enabled,
    includeWeb,
    includeX,
    xSearch,
    webSearch,
    // Older chat field names that do not map to Responses tool params today.
    ignoredLegacyFields: [
      legacy.max_search_results != null ? "max_search_results" : null,
      legacy.return_citations != null ? "return_citations" : null,
      xSource?.post_favorite_count != null ? "post_favorite_count" : null,
      xSource?.post_view_count != null ? "post_view_count" : null,
    ].filter(Boolean),
  };
}

export function buildHostedSearchTools(config = resolveHostedSearchConfig()) {
  if (!config.enabled) return [];
  const tools = [];
  if (config.includeWeb) {
    tools.push(config.webSearch ? { type: "web_search", ...config.webSearch } : { type: "web_search" });
  }
  if (config.includeX) {
    tools.push(config.xSearch ? { type: "x_search", ...config.xSearch } : { type: "x_search" });
  }
  return tools;
}

// Merge client function tools with xAI hosted search tools.
// Hosted tools are type-tagged (web_search / x_search), not function tools.
// Drop any client function with the same name so the backend owns search.
export function mergeHostedSearchTools(
  clientTools = [],
  { enabled = HOSTED_SEARCH_ENABLED, hostedTools, searchConfig } = {},
) {
  const functions = (Array.isArray(clientTools) ? clientTools : []).filter(
    (tool) => tool?.type === "function" && !HOSTED_SEARCH_FUNCTION_NAMES.has(tool.name),
  );
  if (!enabled) return functions;
  const hosted =
    hostedTools ||
    buildHostedSearchTools(searchConfig || resolveHostedSearchConfig());
  // Avoid duplicating a hosted type if a client already sent one.
  const filteredHosted = hosted.filter(
    (hostedTool) => !functions.some((tool) => tool.type === hostedTool.type),
  );
  return [...functions, ...filteredHosted];
}

// Chat Completions request -> Codex Responses request.
export function toResponsesRequest(chat, options = {}) {
  const input = [];
  let instructions;
  for (const message of chat.messages || []) {
    const role = message.role;
    if (role === "system" || role === "developer") {
      const text = contentToText(message.content);
      instructions = instructions ? `${instructions}\n\n${text}` : text;
    } else if (role === "tool") {
      input.push({
        type: "function_call_output",
        call_id: message.tool_call_id,
        output:
          typeof message.content === "string"
            ? message.content
            : JSON.stringify(message.content ?? ""),
      });
    } else if (role === "assistant" && Array.isArray(message.tool_calls)) {
      const text = contentToText(message.content);
      if (text) {
        input.push({ type: "message", role: "assistant", content: [{ type: "output_text", text }] });
      }
      for (const call of message.tool_calls) {
        input.push({
          type: "function_call",
          call_id: call.id,
          name: call.function?.name,
          arguments: call.function?.arguments || "{}",
        });
      }
    } else {
      const textType = role === "assistant" ? "output_text" : "input_text";
      input.push({ type: "message", role, content: messageContentParts(message.content, textType) });
    }
  }

  const request = { model: chat.model, input, stream: true, store: false };
  if (instructions) request.instructions = instructions;
  const effort = mapEffort(chat.reasoning_effort);
  if (effort) request.reasoning = { effort };
  const clientTools = Array.isArray(chat.tools)
    ? chat.tools
        .filter((tool) => tool?.type === "function" && tool.function?.name)
        .map((tool) => ({
          type: "function",
          name: tool.function.name,
          description: tool.function.description,
          parameters: tool.function.parameters || { type: "object", properties: {} },
          strict: false,
        }))
    : [];
  const searchConfig = resolveHostedSearchConfig(
    {
      search_parameters: chat.search_parameters,
      search_mode: chat.search_mode,
      sources: chat.sources,
      from_date: chat.from_date,
      to_date: chat.to_date,
      x_search: chat.x_search,
      web_search: chat.web_search,
      hosted_search: chat.hosted_search ?? chat.hostedSearch,
      ...(options.search || {}),
    },
    options.env || process.env,
  );
  if (options.hostedSearchEnabled === false) searchConfig.enabled = false;
  if (options.hostedSearchEnabled === true) searchConfig.enabled = true;

  const tools = mergeHostedSearchTools(clientTools, {
    enabled: searchConfig.enabled,
    searchConfig,
  });
  if (tools.length) {
    request.tools = tools;
    if (chat.tool_choice) request.tool_choice = chat.tool_choice;
  }
  return request;
}

function upstreamHeaders(accessToken, model) {
  const sessionId = randomUUID();
  return {
    Authorization: `Bearer ${accessToken}`,
    "Content-Type": "application/json",
    Accept: "text/event-stream",
    "X-XAI-Token-Auth": "xai-grok-cli",
    "x-authenticateresponse": "authenticate-response",
    "x-grok-client-version": GROK_CLIENT_VERSION,
    "x-grok-client-identifier": "grok-shell",
    "x-grok-client-mode": "headless",
    "x-grok-conv-id": sessionId,
    "x-grok-req-id": randomUUID(),
    "x-grok-model-override": model,
    "x-grok-session-id": sessionId,
    "x-grok-agent-id": randomUUID(),
    "x-grok-turn-idx": "1",
    "User-Agent": grokUserAgent(),
  };
}

// Parse the upstream Responses SSE and invoke callbacks per normalized event.
async function consumeResponsesStream(upstreamBody, handlers) {
  const reader = upstreamBody.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let boundary;
    while ((boundary = buffer.indexOf("\n\n")) !== -1) {
      const rawEvent = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      const dataLine = rawEvent
        .split("\n")
        .find((line) => line.startsWith("data:"));
      if (!dataLine) continue;
      const data = dataLine.slice(5).trim();
      if (!data || data === "[DONE]") continue;
      let event;
      try {
        event = JSON.parse(data);
      } catch {
        continue;
      }
      handlers(event);
    }
  }
}

const OPENAI_ROLE_CHUNK = (id, created, model, delta, finishReason = null) =>
  `data: ${JSON.stringify({
    id,
    object: "chat.completion.chunk",
    created,
    model,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  })}\n\n`;

async function handleChatCompletions(request, response) {
  const chat = JSON.parse((await readRequestBody(request)).toString("utf8"));
  const wantsStream = chat.stream === true;
  const model = typeof chat.model === "string" ? chat.model : "";
  const responsesRequest = toResponsesRequest(chat);

  const controller = new AbortController();
  request.once("aborted", () => controller.abort());
  response.once("close", () => {
    if (!response.writableEnded) controller.abort();
  });

  const requestUpstream = (accessToken) => fetch(`${GROK_BASE}/responses`, {
    method: "POST",
    headers: upstreamHeaders(accessToken, model),
    body: JSON.stringify(responsesRequest),
    signal: controller.signal,
  });
  let accessToken;
  try {
    accessToken = await ensureFreshGrokOAuthToken();
  } catch {
    writeJson(response, 401, {
      error: {
        message: "Grok OAuth could not be refreshed; run `grok login --oauth`.",
        type: "authentication_error",
        code: null,
      },
    });
    return;
  }
  let upstream = await requestUpstream(accessToken);
  if (upstream.status === 401) {
    await upstream.arrayBuffer();
    try {
      accessToken = await ensureFreshGrokOAuthToken({ force: true });
      upstream = await requestUpstream(accessToken);
    } catch {
      writeJson(response, 401, {
        error: {
          message: "Grok OAuth could not be refreshed; run `grok login --oauth`.",
          type: "authentication_error",
          code: null,
        },
      });
      return;
    }
  }

  if (!upstream.ok || !upstream.body) {
    const detail = await upstream.text().catch(() => "");
    writeJson(response, upstream.status === 401 ? 401 : 502, {
      error: {
        message:
          upstream.status === 401
            ? "xAI rejected the Grok OAuth session; run `grok login --oauth`."
            : `Grok OAuth proxy error (HTTP ${upstream.status}).`,
        type: upstream.status === 401 ? "authentication_error" : "api_error",
        code: null,
        detail: detail.slice(0, 500) || undefined,
      },
    });
    return;
  }

  const id = `chatcmpl-${randomUUID()}`;
  const created = Math.floor(Date.now() / 1_000);
  const toolIndex = new Map();
  let contentText = "";
  let finishReason = "stop";
  let usage;

  if (wantsStream) {
    response.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    response.write(OPENAI_ROLE_CHUNK(id, created, model, { role: "assistant", content: "" }));
  }

  const onEvent = (event) => {
    switch (event.type) {
      case "response.output_text.delta": {
        contentText += event.delta || "";
        if (wantsStream && event.delta) {
          response.write(OPENAI_ROLE_CHUNK(id, created, model, { content: event.delta }));
        }
        break;
      }
      case "response.output_item.added": {
        const item = event.item;
        if (item?.type === "function_call") {
          const index = toolIndex.size;
          toolIndex.set(item.id, index);
          finishReason = "tool_calls";
          if (wantsStream) {
            response.write(
              OPENAI_ROLE_CHUNK(id, created, model, {
                tool_calls: [
                  {
                    index,
                    id: item.call_id || item.id,
                    type: "function",
                    function: { name: item.name || "", arguments: "" },
                  },
                ],
              }),
            );
          }
        }
        break;
      }
      case "response.function_call_arguments.delta": {
        const index = toolIndex.get(event.item_id) ?? 0;
        if (wantsStream && event.delta) {
          response.write(
            OPENAI_ROLE_CHUNK(id, created, model, {
              tool_calls: [{ index, function: { arguments: event.delta } }],
            }),
          );
        }
        break;
      }
      case "response.completed": {
        const u = event.response?.usage;
        if (u) {
          usage = {
            prompt_tokens: u.input_tokens ?? 0,
            completion_tokens: u.output_tokens ?? 0,
            total_tokens: (u.input_tokens ?? 0) + (u.output_tokens ?? 0),
          };
        }
        break;
      }
      default:
        break;
    }
  };

  // For a non-streaming client we still need the tool-call structure, so collect
  // the full output items from the completed event.
  const collectedToolCalls = [];
  const onEventCollecting = (event) => {
    onEvent(event);
    if (event.type === "response.output_item.done" && event.item?.type === "function_call") {
      collectedToolCalls.push({
        id: event.item.call_id || event.item.id,
        type: "function",
        function: { name: event.item.name, arguments: event.item.arguments || "" },
      });
    }
  };

  await consumeResponsesStream(upstream.body, wantsStream ? onEvent : onEventCollecting);

  if (wantsStream) {
    response.write(OPENAI_ROLE_CHUNK(id, created, model, {}, finishReason));
    if (usage) {
      response.write(
        `data: ${JSON.stringify({ id, object: "chat.completion.chunk", created, model, choices: [], usage })}\n\n`,
      );
    }
    response.write("data: [DONE]\n\n");
    response.end();
  } else {
    const message = { role: "assistant", content: contentText || null };
    if (collectedToolCalls.length) {
      message.tool_calls = collectedToolCalls;
      finishReason = "tool_calls";
    }
    writeJson(response, 200, {
      id,
      object: "chat.completion",
      created,
      model,
      choices: [{ index: 0, message, finish_reason: finishReason }],
      usage: usage || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    });
  }

  if (!QUIET) {
    console.error(`[grok-oauth] model=${model} status=${upstream.status}`);
  }
}

async function handleRequest(request, response) {
  if (!INTERNAL_KEY) {
    writeJson(response, 500, {
      error: {
        type: "api_error",
        message: "MODEL_ROUTER_INTERNAL_KEY is required.",
      },
    });
    return;
  }
  const requestUrl = new URL(request.url || "/", `http://${request.headers.host || LISTEN_HOST}`);
  if (!requireInternalAuth(request, response, INTERNAL_KEY)) return;
  if (request.method === "GET" && requestUrl.pathname === "/health") {
    const credentialPresent = grokOAuthStatus().configured;
    writeJson(response, 200, {
      ok: true,
      service: "codex-router-grok-oauth-forwarder",
      credential_present: credentialPresent,
    });
    return;
  }
  const route = requestUrl.pathname.replace(/^\/v1(?=\/|$)/, "");
  if (request.method === "POST" && route === "/chat/completions") {
    await handleChatCompletions(request, response);
    return;
  }
  writeJson(response, 404, {
    error: { type: "proxy_route_not_found", message: "Unsupported Grok OAuth route." },
  });
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isMain) {
  if (!INTERNAL_KEY) throw new Error("MODEL_ROUTER_INTERNAL_KEY is required.");
  const server = http.createServer((request, response) => {
    handleRequest(request, response).catch((error) => {
      const status = httpErrorStatus(error);
      console.error("[grok-oauth] request failed");
      if (!response.headersSent) {
        writeJson(response, status, {
          error: {
            type: status >= 500 ? "api_error" : "invalid_request_error",
            message: "The Grok OAuth forwarder could not complete the request.",
          },
        });
      } else if (!response.writableEnded) {
        response.destroy();
      }
    });
  });

  server.listen(LISTEN_PORT, LISTEN_HOST, () => {
    console.error("[grok-oauth] listening");
  });

  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.on(signal, () => server.close(() => process.exit(0)));
  }
}
