import { execFileSync } from "node:child_process";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

import {
  applyKeepAliveTimeouts,
  endStreamedResponse,
  formatErrorChain,
  httpErrorStatus,
  installGracefulShutdown,
  readRequestBody,
  reportListenFailure,
  requireInternalAuth,
  writeEventStreamHead,
  writeJson,
} from "./http-utils.mjs";
import { PORTS } from "./paths.mjs";
import { MODELS } from "./model-registry.mjs";
import { ensureFreshGrokOAuthToken } from "./grok-oauth-session.mjs";
import { grokOAuthStatus } from "./grok-oauth-status.mjs";
import { normalizeSchemaLiterals, objectRootToolSchema } from "./tool-schema-root.mjs";
import {
  shouldAliasViewImageForGrok,
  toolNameForCodex,
  toolNameForGrok,
} from "./grok-oauth-tool-alias.mjs";
import {
  applyResponsesEvent,
  classifyAfterToolRepair,
  createTurnState,
  DEFAULT_PROGRESS_ONLY_MAX_TEXT,
  DEFAULT_PROGRESS_ONLY_MIN_OUTPUT_TOKENS,
  finalizeTurn,
  isProgressOnlyStop,
  lastClientMessageWasToolResult,
  mergeMappedUsage,
  parseSseBlockEvent,
  requestOffersClientTools,
  selectedRetryUsage,
  shouldPreferRetryTurn,
  toolCallDeltas,
  withProgressOnlyNudge,
} from "./grok-oauth-turn.mjs";
import { VERSION } from "./version.mjs";
import { installStableFetchTransport } from "./fetch-transport.mjs";

installStableFetchTransport();

// LiteLLM speaks OpenAI Chat Completions to this forwarder. It reuses the
// official Grok CLI OAuth session and translates to xAI's Responses proxy.

const LISTEN_HOST = process.env.MODEL_ROUTER_GROK_OAUTH_HOST || "127.0.0.1";
const LISTEN_PORT = Number(process.env.MODEL_ROUTER_GROK_OAUTH_PORT || PORTS.grokOauth);
const GROK_BASE = (
  process.env.GROK_CLI_CHAT_PROXY_BASE_URL || "https://cli-chat-proxy.grok.com/v1"
).replace(/\/+$/, "");
const INTERNAL_KEY = process.env.MODEL_ROUTER_INTERNAL_KEY;
const QUIET = process.env.MODEL_ROUTER_QUIET === "1";
const PROGRESS_ONLY_RETRY = process.env.CODEX_ROUTER_GROK_PROGRESS_ONLY_RETRY !== "0";
const PROGRESS_ONLY_MAX_TEXT = envNonNegativeInt(
  "CODEX_ROUTER_GROK_PROGRESS_ONLY_MAX_TEXT",
  DEFAULT_PROGRESS_ONLY_MAX_TEXT,
);
const PROGRESS_ONLY_MIN_OUTPUT_TOKENS = envNonNegativeInt(
  "CODEX_ROUTER_GROK_PROGRESS_ONLY_MIN_OUTPUT_TOKENS",
  DEFAULT_PROGRESS_ONLY_MIN_OUTPUT_TOKENS,
);
const MAX_PROGRESS_ONLY_CONVERSATIONS = 1_024;
const progressOnlyConversations = new Set();

function envNonNegativeInt(name, fallback) {
  const parsed = Number(process.env[name]);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : fallback;
}

function rememberProgressOnlyConversation(id) {
  if (!id) return;
  // Refresh insertion order so the bounded set retains recently affected
  // conversations rather than the first conversations seen by the process.
  progressOnlyConversations.delete(id);
  progressOnlyConversations.add(id);
  while (progressOnlyConversations.size > MAX_PROGRESS_ONLY_CONVERSATIONS) {
    progressOnlyConversations.delete(progressOnlyConversations.values().next().value);
  }
}

async function drainUpstreamBody(body) {
  if (!body) return;
  try {
    if (typeof body.cancel === "function") {
      await body.cancel();
      return;
    }
  } catch {
    // Fall through to a read-drain when cancel is unavailable or rejected.
  }
  try {
    await body.arrayBuffer();
  } catch {
    // A failed retry must not leave the socket unread.
  }
}

// Hosted search tools run on xAI's Responses backend, matching Grok Build:
// attach bare web_search + x_search and let the model choose when/how to search.
// No router-side filters or search env config — that is agentic server-side work.
const HOSTED_SEARCH_TOOLS = Object.freeze([
  { type: "web_search" },
  { type: "x_search" },
]);
const HOSTED_SEARCH_FUNCTION_NAMES = new Set(["web_search", "x_search"]);

// The registry entry is the single capability source: hosted search attaches
// only when the slug that resolves to this upstream model declares it, so a
// curated model without the flag keeps plain function calling. The forwarder
// receives the upstream model id (LiteLLM translates OAuth slugs before the
// request arrives), so the lookup goes provider + upstreamModel, not slug.
export function hostedSearchEnabledFor(upstreamModel, models = MODELS) {
  return models.some(
    (model) =>
      model.provider === "grok-oauth" &&
      model.upstreamModel === upstreamModel &&
      model.searchTool?.mode === "hosted",
  );
}

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
      const image = { type: "input_image", image_url: part.image_url.url };
      // Codex only attaches a detail level when the catalog entry advertises
      // supports_image_detail_original; forward it untouched so the backend
      // sees the client's resolution intent instead of a silent downgrade.
      if (typeof part.image_url.detail === "string" && part.image_url.detail) {
        image.detail = part.image_url.detail;
      }
      parts.push(image);
    } else if (typeof part?.text === "string") {
      parts.push({ type: textType, text: part.text });
    }
  }
  return parts.length ? parts : [{ type: textType, text: "" }];
}

function mapEffort(effort, model) {
  if (effort === "minimal") return "low";
  if (["none", "low"].includes(effort)) return "low";
  if (effort === "xhigh") return model === "grok-4.6" ? "xhigh" : "high";
  if (effort === "max") return "high";
  return ["medium", "high"].includes(effort) ? effort : undefined;
}

// Merge client function tools with bare hosted search tools.
// Hosted tools are type-tagged (web_search / x_search), not function tools.
// Drop any client function with the same name so the backend owns search.
// The xAI backend rejects the whole request when a function name repeats
// ("Duplicate function definition provided"), so only the first definition
// of each name is forwarded.
export function mergeHostedSearchTools(clientTools = [], { enabled = true } = {}) {
  const seenNames = new Set();
  const functions = (Array.isArray(clientTools) ? clientTools : []).filter((tool) => {
    if (tool?.type !== "function" || HOSTED_SEARCH_FUNCTION_NAMES.has(tool.name)) {
      return false;
    }
    if (seenNames.has(tool.name)) return false;
    seenNames.add(tool.name);
    return true;
  });
  if (!enabled) return functions;
  const hosted = HOSTED_SEARCH_TOOLS.filter(
    (hostedTool) => !functions.some((tool) => tool.type === hostedTool.type),
  );
  return [...functions, ...hosted];
}

function normalizeToolImageUrl(url) {
  if (typeof url !== "string") return url;

  const prefix = "data:application/octet-stream;base64,";
  if (!url.startsWith(prefix)) return url;

  const base64 = url.slice(prefix.length);
  let bytes;
  try {
    bytes = Buffer.from(base64.slice(0, 64), "base64");
  } catch {
    return url;
  }

  let mime;
  if (
    bytes.length >= 3 &&
    bytes[0] === 0xff &&
    bytes[1] === 0xd8 &&
    bytes[2] === 0xff
  ) {
    mime = "image/jpeg";
  } else if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47
  ) {
    mime = "image/png";
  } else if (
    bytes.length >= 6 &&
    bytes.toString("ascii", 0, 3) === "GIF"
  ) {
    mime = "image/gif";
  } else if (
    bytes.length >= 12 &&
    bytes.toString("ascii", 0, 4) === "RIFF" &&
    bytes.toString("ascii", 8, 12) === "WEBP"
  ) {
    mime = "image/webp";
  } else {
    return url;
  }

  return `data:${mime};base64,${base64}`;
}

function normalizeToolOutputForGrok(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return JSON.stringify(content ?? "");

  // Only image-bearing output becomes a Responses content-item array. Other
  // structured tool results keep the existing JSON-text behavior.
  const parts = [];
  let hasImage = false;

  for (const part of content) {
    if (!part || typeof part !== "object") continue;

    if (
      ["text", "input_text", "output_text"].includes(part.type) &&
      typeof part.text === "string" &&
      part.text
    ) {
      parts.push({ type: "input_text", text: part.text });
      continue;
    }

    let imageUrl;
    let detail;

    if (part.type === "input_image") {
      imageUrl = part.image_url;
      if (typeof part.detail === "string") detail = part.detail;
    } else if (part.type === "image_url") {
      imageUrl =
        typeof part.image_url === "string"
          ? part.image_url
          : part.image_url?.url;

      if (typeof part.detail === "string") {
        detail = part.detail;
      } else if (
        part.image_url &&
        typeof part.image_url !== "string" &&
        typeof part.image_url.detail === "string"
      ) {
        detail = part.image_url.detail;
      }
    }

    if (typeof imageUrl === "string" && imageUrl) {
      hasImage = true;

      const normalizedImage = {
        type: "input_image",
        image_url: normalizeToolImageUrl(imageUrl),
      };

      if (typeof detail === "string" && detail) {
        normalizedImage.detail = detail;
      }

      parts.push(normalizedImage);
    }
  }

  return hasImage ? parts : JSON.stringify(content ?? "");
}

// Chat Completions request -> Codex Responses request.
export function toResponsesRequest(chat, options = {}) {
  const input = [];
  let instructions;
  const viewImageAlias = shouldAliasViewImageForGrok(chat);
  for (const message of chat.messages || []) {
    const role = message.role;
    if (role === "system" || role === "developer") {
      const text = contentToText(message.content);
      instructions = instructions ? `${instructions}\n\n${text}` : text;
    } else if (role === "tool") {
      input.push({
        type: "function_call_output",
        call_id: message.tool_call_id,
        output: normalizeToolOutputForGrok(message.content),
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
          name: toolNameForGrok(call.function?.name, { viewImageAlias }),
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
  const effort = mapEffort(chat.reasoning_effort, chat.model);
  if (effort) request.reasoning = { effort };
  const clientTools = Array.isArray(chat.tools)
    ? chat.tools
        .filter((tool) => tool?.type === "function" && tool.function?.name)
        .map((tool) => ({
          type: "function",
          name: toolNameForGrok(tool.function.name, { viewImageAlias }),
          description: tool.function.description,
          // xAI 400s the whole request over a union-rooted parameter schema,
          // which Codex's own `automation_update` app tool ships. It rejects
          // every non-object root, so this keeps objectRootToolSchema's full
          // collapse rather than the narrower providerToolSchema the shared
          // relay uses -- and additionally drops literals that contradict their
          // declared type, which the relay now does for every provider.
          parameters: objectRootToolSchema(
            normalizeSchemaLiterals(
              tool.function.parameters || { type: "object", properties: {} },
            ),
          ),
          strict: false,
        }))
    : [];
  const tools = mergeHostedSearchTools(clientTools, {
    enabled: options.hostedSearchEnabled !== false,
  });
  if (tools.length) {
    request.tools = tools;
    if (chat.tool_choice) {
      request.tool_choice =
        typeof chat.tool_choice === "object" && chat.tool_choice.function?.name
          ? (() => {
              // Chat Completions nests a named function under `function`, but
              // the xAI Responses boundary accepts the flat Responses shape.
              // Do the protocol conversion here while applying the scoped
              // alias; forwarding the nested object makes the provider reject
              // the request before it can select the renamed tool.
              const { function: functionChoice, ...responsesChoice } = chat.tool_choice;
              return {
                ...responsesChoice,
                name: toolNameForGrok(functionChoice.name, { viewImageAlias }),
              };
            })()
          : chat.tool_choice;
    }
  }
  return request;
}

// xAI routes by `x-grok-conv-id` so that every turn of one conversation lands
// on the server holding its KV cache; their docs name a wrong or changing
// conversation id as the first thing to check when `cached_tokens` stays at
// zero. A fresh UUID per request sends each turn somewhere else, and the cache
// is never read: measured over a four-turn append-only session, 128 / 4608 /
// 128 / 0 cached tokens against a 31k prompt that was identical up to the
// appended tail every time.
//
// The conversation's own opening messages are the stable key. Codex appends and
// never rewrites them, so hashing the first two pins every turn of a session to
// one server while keeping separate sessions apart. Formatted as a UUID because
// that is what the header carries everywhere else.
export function conversationIdForTest(messages) {
  return conversationId(messages);
}

function conversationId(messages) {
  const anchor = [];
  for (const message of Array.isArray(messages) ? messages : []) {
    const content =
      typeof message?.content === "string" ? message.content : JSON.stringify(message?.content);
    anchor.push(`${message?.role}:${content}`);
    if (anchor.length === 2) break;
  }
  if (anchor.length === 0) return randomUUID();
  const digest = createHash("sha256").update(anchor.join("\n")).digest("hex");
  return [
    digest.slice(0, 8),
    digest.slice(8, 12),
    digest.slice(12, 16),
    digest.slice(16, 20),
    digest.slice(20, 32),
  ].join("-");
}

function upstreamHeaders(accessToken, model, messages, requestId = randomUUID()) {
  const sessionId = conversationId(messages);
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
    "x-grok-req-id": requestId,
    "x-grok-model-override": model,
    "x-grok-session-id": sessionId,
    "x-grok-agent-id": randomUUID(),
    "x-grok-turn-idx": "1",
    "User-Agent": grokUserAgent(),
  };
}

function upstreamAttemptTiming(label, attempt, endedAt = Date.now()) {
  if (!attempt) return "";
  const sinceStart = (value) =>
    Number.isFinite(value) ? Math.max(0, value - attempt.startedAt) : "none";
  return [
    `${label}_req=${attempt.requestId}`,
    `${label}_headers_ms=${sinceStart(attempt.headersAt)}`,
    `${label}_first_event_ms=${sinceStart(attempt.firstEventAt)}`,
    `${label}_total_ms=${sinceStart(attempt.endedAt ?? endedAt)}`,
  ].join(" ");
}

function logUpstreamPhaseFailure(label, model, attempt, error) {
  console.error(
    `[grok-oauth] upstream-phase-failed=true phase=${label} model=${model} ${upstreamAttemptTiming(label, attempt)} error=${error?.name || "Error"}`,
  );
}

// Parse the upstream Responses SSE and invoke callbacks per normalized event.
function nextSseBoundary(buffer) {
  const crlf = buffer.indexOf("\r\n\r\n");
  const lf = buffer.indexOf("\n\n");
  if (crlf === -1 && lf === -1) return null;
  if (crlf === -1) return { at: lf, size: 2 };
  if (lf === -1) return { at: crlf, size: 4 };
  return crlf < lf ? { at: crlf, size: 4 } : { at: lf, size: 2 };
}

function dispatchSseBlock(rawEvent, handlers) {
  const event = parseSseBlockEvent(rawEvent);
  if (event === undefined) return;
  handlers(event);
}

async function consumeResponsesStream(upstreamBody, handlers) {
  const reader = upstreamBody.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let boundary;
    while ((boundary = nextSseBoundary(buffer))) {
      const rawEvent = buffer.slice(0, boundary.at);
      buffer = buffer.slice(boundary.at + boundary.size);
      dispatchSseBlock(rawEvent, handlers);
    }
  }
  buffer += decoder.decode();
  if (buffer.trim()) dispatchSseBlock(buffer, handlers);
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
  const hostedSearchEnabled = hostedSearchEnabledFor(model);
  const viewImageAlias = shouldAliasViewImageForGrok(chat);
  const responsesRequest = toResponsesRequest(chat, { hostedSearchEnabled });
  const holdOptions = {
    maxText: PROGRESS_ONLY_MAX_TEXT,
    minOutputTokens: PROGRESS_ONLY_MIN_OUTPUT_TOKENS,
  };
  const afterToolResult = lastClientMessageWasToolResult(chat);
  const mayRetry =
    PROGRESS_ONLY_RETRY && (afterToolResult || requestOffersClientTools(chat));
  const strictAfterToolRepair = PROGRESS_ONLY_RETRY && afterToolResult;
  const conversationKey = conversationId(chat?.messages);
  // Attempt 1 normally stays live. Once this exact conversation has actually
  // produced a progress-only stop, buffer only its next short visible prefix.
  // That prevents an aborted/retried turn from committing the same status
  // sentence again without imposing the old first-byte hold on healthy chats.
  let bufferShortProgress =
    wantsStream &&
    mayRetry &&
    (strictAfterToolRepair || progressOnlyConversations.has(conversationKey));

  const controller = new AbortController();
  request.once("aborted", () => controller.abort());
  response.once("close", () => {
    if (!response.writableEnded) controller.abort();
  });

  const requestUpstream = async (accessToken, body) => {
    const attempt = {
      requestId: randomUUID(),
      startedAt: Date.now(),
    };
    try {
      attempt.response = await fetch(`${GROK_BASE}/responses`, {
        method: "POST",
        headers: upstreamHeaders(accessToken, model, chat?.messages, attempt.requestId),
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      attempt.headersAt = Date.now();
      return attempt;
    } catch (error) {
      attempt.endedAt = Date.now();
      if (error && typeof error === "object") {
        try {
          error.grokUpstreamAttempt = attempt;
        } catch {
          // A non-extensible transport error still keeps its original cause.
        }
      }
      throw error;
    }
  };
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
  let firstAttempt;
  try {
    firstAttempt = await requestUpstream(accessToken, responsesRequest);
  } catch (error) {
    logUpstreamPhaseFailure("attempt", model, error?.grokUpstreamAttempt, error);
    throw error;
  }
  let upstream = firstAttempt.response;
  if (upstream.status === 401) {
    await upstream.arrayBuffer();
    try {
      accessToken = await ensureFreshGrokOAuthToken({ force: true });
      firstAttempt = await requestUpstream(accessToken, responsesRequest);
      upstream = firstAttempt.response;
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
  const turnState = createTurnState({
    toolNameMapper: (name) => toolNameForCodex(name, { viewImageAlias }),
  });
  let emittedDeltaCount = 0;
  const heldStrictContentDeltas = [];
  let streamStarted = false;

  const startStream = () => {
    if (!wantsStream || streamStarted) return;
    writeEventStreamHead(response, 200, {
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    response.write(OPENAI_ROLE_CHUNK(id, created, model, { role: "assistant", content: "" }));
    streamStarted = true;
  };

  // A post-tool turn can only be classified after its terminal event. Open the
  // SSE response immediately, but hold all visible text so Codex sees liveness
  // and reasoning without accepting an uncertified progress sentence.
  // Once the head is committed, a failed repair becomes one terminal SSE error.
  if (wantsStream) startStream();

  const emitHeldStrictContent = () => {
    if (!wantsStream || !streamStarted || heldStrictContentDeltas.length === 0) return;
    for (const delta of heldStrictContentDeltas) {
      response.write(OPENAI_ROLE_CHUNK(id, created, model, delta));
    }
    heldStrictContentDeltas.length = 0;
  };

  const emitPendingDeltas = () => {
    if (!wantsStream || !streamStarted) return;
    while (emittedDeltaCount < turnState.deltas.length) {
      const delta = turnState.deltas[emittedDeltaCount];
      if (
        strictAfterToolRepair &&
        Object.hasOwn(delta, "content") &&
        turnState.toolCalls.length === 0
      ) {
        heldStrictContentDeltas.push(delta);
        emittedDeltaCount += 1;
        continue;
      }
      // A client tool call certifies attempt 1 as actionable. Release any
      // earlier prose before its tool delta so the original event order stays
      // intact; a no-tool attempt remains held through terminal classification.
      if (strictAfterToolRepair && turnState.toolCalls.length > 0) {
        emitHeldStrictContent();
      }
      if (
        bufferShortProgress &&
        Object.hasOwn(delta, "content") &&
        turnState.toolCalls.length === 0 &&
        turnState.contentText.length <= PROGRESS_ONLY_MAX_TEXT
      ) {
        return;
      }
      response.write(
        OPENAI_ROLE_CHUNK(id, created, model, delta),
      );
      emittedDeltaCount += 1;
    }
  };

  try {
    await consumeResponsesStream(upstream.body, (event) => {
      firstAttempt.firstEventAt ??= Date.now();
      applyResponsesEvent(turnState, event);
      emitPendingDeltas();
    });
    firstAttempt.endedAt = Date.now();
  } catch (error) {
    firstAttempt.endedAt = Date.now();
    logUpstreamPhaseFailure("attempt", model, firstAttempt, error);
    throw error;
  }

  let turn = finalizeTurn(turnState);
  emitPendingDeltas();
  let retried = false;
  let repairFailure;
  let repairAttempt;
  let strictRepairOutputEmitted = false;

  const progressOnly = isProgressOnlyStop(turn, { ...holdOptions, afterToolResult });
  if (progressOnly) rememberProgressOnlyConversation(conversationKey);
  if (progressOnly && strictAfterToolRepair && !mayRetry) {
    repairFailure = {
      code: "progress_only_no_client_tools",
      message:
        "Grok stopped after a tool result, but the repair request had no callable client tools.",
    };
  } else if (mayRetry && progressOnly) {
    const retryChat = withProgressOnlyNudge(chat, { afterToolResult });
    const retryRequest = toResponsesRequest(retryChat, { hostedSearchEnabled });
    let secondUpstream;
    try {
      repairAttempt = await requestUpstream(accessToken, retryRequest);
      secondUpstream = repairAttempt.response;
    } catch (error) {
      repairAttempt = error?.grokUpstreamAttempt;
      console.error(
        `[grok-oauth] progress-only-retry-failed=true model=${model} ${upstreamAttemptTiming("repair", repairAttempt)} error=${error?.name || "Error"}`,
      );
      secondUpstream = undefined;
    }
    if (secondUpstream && (!secondUpstream.ok || !secondUpstream.body)) {
      await drainUpstreamBody(secondUpstream.body);
      repairAttempt.endedAt = Date.now();
      console.error(
        `[grok-oauth] progress-only-retry-failed=true model=${model} status=${secondUpstream.status} ${upstreamAttemptTiming("repair", repairAttempt)}`,
      );
      if (strictAfterToolRepair) {
        repairFailure = {
          code: "progress_only_retry_failed",
          message: "Grok stopped after a tool result and its repair request failed upstream.",
        };
      }
    } else if (secondUpstream?.body) {
      const secondState = createTurnState({
        toolNameMapper: (name) => toolNameForCodex(name, { viewImageAlias }),
      });
      let emittedRepairDeltaCount = 0;
      try {
        await consumeResponsesStream(secondUpstream.body, (event) => {
          repairAttempt.firstEventAt ??= Date.now();
          applyResponsesEvent(secondState, event);
          if (wantsStream && streamStarted && strictAfterToolRepair) {
            while (emittedRepairDeltaCount < secondState.deltas.length) {
              const delta = secondState.deltas[emittedRepairDeltaCount];
              if (Object.hasOwn(delta, "reasoning_content")) {
                response.write(OPENAI_ROLE_CHUNK(id, created, model, delta));
              }
              emittedRepairDeltaCount += 1;
            }
          }
        });
        repairAttempt.endedAt = Date.now();
      } catch (error) {
        repairAttempt.endedAt = Date.now();
        logUpstreamPhaseFailure("repair", model, repairAttempt, error);
        throw error;
      }
      const second = finalizeTurn(secondState);
      retried = true;
      const repair = strictAfterToolRepair
        ? classifyAfterToolRepair(second)
        : { action: shouldPreferRetryTurn(second) ? "tools" : "first" };
      console.error(
        `[grok-oauth] progress-only-retried=true retries=1 model=${model} prefer=${repair.action} ${upstreamAttemptTiming("attempt", firstAttempt)} ${upstreamAttemptTiming("repair", repairAttempt)}`,
      );
      if (repair.action === "tools") {
        const usage = strictAfterToolRepair
          ? selectedRetryUsage(turn.usage, second.usage)
          : mergeMappedUsage(turn.usage, second.usage);
        if (wantsStream && streamStarted) {
          // The repair stayed reasoning-only on the wire until certification.
          // Its tool deltas are now safe and are emitted exactly once here.
          for (const delta of toolCallDeltas(second)) {
            response.write(OPENAI_ROLE_CHUNK(id, created, model, delta));
          }
          strictRepairOutputEmitted = strictAfterToolRepair;
        }
        turn = {
          contentText: strictAfterToolRepair ? "" : turn.contentText,
          reasoningText: strictAfterToolRepair ? second.reasoningText : turn.reasoningText,
          toolCalls: second.toolCalls,
          usage,
          deltas: strictAfterToolRepair
            ? toolCallDeltas(second)
            : [...turn.deltas, ...toolCallDeltas(second)],
          finishReason: "tool_calls",
        };
        if (streamStarted) emittedDeltaCount = turn.deltas.length;
      } else if (repair.action === "final") {
        if (wantsStream && streamStarted && strictAfterToolRepair) {
          response.write(
            OPENAI_ROLE_CHUNK(id, created, model, { content: repair.contentText }),
          );
          strictRepairOutputEmitted = true;
        }
        turn = {
          contentText: repair.contentText,
          reasoningText: second.reasoningText,
          toolCalls: [],
          usage: selectedRetryUsage(turn.usage, second.usage),
          deltas: [{ content: repair.contentText }],
          finishReason: "stop",
        };
        emittedDeltaCount = 0;
      } else if (repair.action === "fail") {
        repairFailure = {
          code: "progress_only_unrepairable",
          message:
            "Grok stopped after a tool result. The router retried once, but the retry neither called a tool nor returned a certified final answer.",
        };
      } else {
        turn = { ...turn, usage: mergeMappedUsage(turn.usage, second.usage) };
      }
    } else if (strictAfterToolRepair) {
      repairFailure = {
        code: "progress_only_retry_failed",
        message: "Grok stopped after a tool result and its repair request produced no response.",
      };
    }
  }

  if (repairFailure) {
    console.error(
      `[grok-oauth] progress-only-unrepairable=true model=${model} code=${repairFailure.code} ${upstreamAttemptTiming("attempt", firstAttempt)} ${upstreamAttemptTiming("repair", repairAttempt)}`,
    );
    if (wantsStream && streamStarted) {
      endStreamedResponse(response, { message: repairFailure.message });
      return;
    }
    writeJson(response, 502, {
      error: {
        message: repairFailure.message,
        type: "api_error",
        code: repairFailure.code,
      },
    });
    return;
  }

  // A normal short answer, a failed optional repair, or the keep-first branch
  // must still deliver attempt 1. The retry-tools branch has already advanced
  // emittedDeltaCount past the suppressed prefix, so releasing is a no-op there.
  bufferShortProgress = false;

  if (wantsStream) {
    const wasStarted = streamStarted;
    startStream();
    if (wasStarted && !strictRepairOutputEmitted) {
      emitPendingDeltas();
      emitHeldStrictContent();
    } else if (!wasStarted) {
      for (const delta of turn.deltas || []) {
        response.write(OPENAI_ROLE_CHUNK(id, created, model, delta));
      }
      emittedDeltaCount = turn.deltas?.length || 0;
    }
    response.write(OPENAI_ROLE_CHUNK(id, created, model, {}, turn.finishReason));
    if (turn.usage) {
      response.write(
        `data: ${JSON.stringify({ id, object: "chat.completion.chunk", created, model, choices: [], usage: turn.usage })}\n\n`,
      );
    }
    response.write("data: [DONE]\n\n");
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

  if (!QUIET && !retried) {
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
      // Names and codes only: a refresh failure can wrap upstream response
      // text in its message, and bodies never belong in the log (#171).
      console.error(
        `[grok-oauth] request failed: ${formatErrorChain(error, { messages: false })}`,
      );
      if (!response.headersSent) {
        writeJson(response, status, {
          error: {
            type: status >= 500 ? "api_error" : "invalid_request_error",
            message: "The Grok OAuth forwarder could not complete the request.",
          },
        });
      } else if (!response.writableEnded) {
        endStreamedResponse(response, {
          message: "The Grok OAuth forwarder lost the upstream response stream.",
        });
      }
    });
  });

  applyKeepAliveTimeouts(server);
  reportListenFailure(server, { label: "grok-oauth", host: LISTEN_HOST, port: LISTEN_PORT });
  server.listen(LISTEN_PORT, LISTEN_HOST, () => {
    console.error("[grok-oauth] listening");
  });

  installGracefulShutdown(server, { label: "grok-oauth" });
}
