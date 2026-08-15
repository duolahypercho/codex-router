import http from "node:http";

import {
  applyKeepAliveTimeouts,
  formatErrorChain,
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
import { canonicalProviderId, readProviderSelection } from "./provider-selection.mjs";
import { stripImages, supportsImageInput } from "./vision-bridge.mjs";
import {
  credentialLabel,
  credentialStatus,
  resolveProviderCredential,
} from "./provider-credentials.mjs";
import {
  ensureFreshGitHubCopilotSession,
  githubCopilotRequestHeaders,
} from "./github-copilot-session.mjs";
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
  return String(
    provider.authMode === "anonymous" ? provider.baseUrl : process.env[provider.baseUrlEnv] || provider.baseUrl,
  ).replace(/\/+$/, "");
}

// DeepSeek documents low/high/max (docs also accept xhigh as a compat alias).
function deepSeekEffort(value) {
  if (["low", "minimal"].includes(value)) return "low";
  return ["xhigh", "max", "ultra"].includes(value) ? "max" : "high";
}

// Kimi K3 documents low/high/max; the platform maps common aliases the same
// way (medium collapses to high, xhigh to max). Unknown values are a 400
// upstream, so anything unrecognized falls back to the documented default.
function kimiK3Effort(value) {
  if (["low", "minimal"].includes(value)) return "low";
  if (["medium", "high"].includes(value)) return "high";
  if (["xhigh", "max", "ultra"].includes(value)) return "max";
  return undefined;
}

// Ollama's OpenAI-compatible surface documents reasoning_effort as of v0.18.0
// and validates it against high/medium/low/max/none, erroring on anything else
// -- so Codex-only rungs must be mapped instead of forwarded verbatim. Codex
// has no "none" rung, so "minimal" is the advertised no-thinking tier and is
// translated here to Ollama's "none". An unrecognized value falls back to the
// documented default rather than failing the turn.
function ollamaCloudEffort(value) {
  if (value === "minimal") return "none";
  if (value === "low") return "low";
  if (value === "medium") return "medium";
  if (["xhigh", "max", "ultra"].includes(value)) return "max";
  return "high";
}

// Z.ai documents reasoning_effort per model, not per vendor: GLM-5.2 answers
// to high/max, and GLM-5.3 adds a low tier (low/high/max, max the upstream
// default). So the accepted rungs travel with the model, and the requested
// effort is clamped onto the ladder its own registry entry declares instead of
// onto a fixed two-tier map -- otherwise GLM-5.3's low tier could never be
// reached. Codex's top rungs always mean "as deep as this model goes"; anything
// else takes the nearest declared rung at or below it, and a request under the
// model's floor lands on that floor. An absent or unknown value is treated as
// "high", which is what the two-tier map sent before this generalization.
const GLM_EFFORT_LADDER = ["minimal", "low", "medium", "high", "xhigh", "max", "ultra"];

function glmEffort(value, levels) {
  const declared = levels
    .filter((effort) => GLM_EFFORT_LADDER.includes(effort))
    .sort((left, right) => GLM_EFFORT_LADDER.indexOf(left) - GLM_EFFORT_LADDER.indexOf(right));
  if (!declared.length) return undefined;
  if (["xhigh", "max", "ultra"].includes(value)) return declared.at(-1);
  const requested = GLM_EFFORT_LADDER.indexOf(value);
  const ceiling = requested === -1 ? GLM_EFFORT_LADDER.indexOf("high") : requested;
  const atOrBelow = declared.filter((effort) => GLM_EFFORT_LADDER.indexOf(effort) <= ceiling);
  return atOrBelow.at(-1) || declared[0];
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

// LiteLLM and the Gemini OpenAI-compatible endpoint accept this sentinel in
// place of a real reasoning signature to skip thought-signature validation.
const GEMINI_THOUGHT_SIGNATURE_SENTINEL = "skip_thought_signature_validator";

function isGeminiProvider(provider) {
  return provider?.id === "gemini-api" || provider?.ownedBy === "google";
}

// Gemini 3.x thinking models reject assistant tool calls whose reasoning
// signature is missing, which is the normal state after compaction or after a
// history translated from another provider. The sentinel below is the
// documented opt-out for that validation. Only fill the gap: a genuine
// signature returned by Gemini must survive untouched or the model loses the
// reasoning it is being asked to continue from.
function ensureGeminiThoughtSignatures(messages) {
  return messages.map((message) => {
    if (message?.role !== "assistant" || !Array.isArray(message.tool_calls)) return message;
    let changed = false;
    const toolCalls = message.tool_calls.map((call) => {
      if (!call || typeof call !== "object") return call;
      const google = call.extra_content?.google;
      if (call.thought_signature || google?.thought_signature) return call;
      changed = true;
      return {
        ...call,
        thought_signature: GEMINI_THOUGHT_SIGNATURE_SENTINEL,
        extra_content: {
          ...(call.extra_content && typeof call.extra_content === "object"
            ? call.extra_content
            : {}),
          google: {
            ...(google && typeof google === "object" ? google : {}),
            thought_signature: GEMINI_THOUGHT_SIGNATURE_SENTINEL,
          },
        },
      };
    });
    return changed ? { ...message, tool_calls: toolCalls } : message;
  });
}

// Google's OpenAI-compatible endpoint accepts image parts only on user turns;
// an image_url/input_image part on an assistant or tool turn is rejected with
// "Invalid content part type: image_url", 400ing the whole turn. That shape is
// normal after a vision-capable tool returns a screenshot, so downgrade those
// non-user image parts to a text placeholder rather than lose the turn. User
// turns are left untouched so Gemini still sees the images it can read.
function sanitizeGeminiImageContent(messages) {
  return messages.map((message) => {
    if (!message || message.role === "user" || !Array.isArray(message.content)) return message;
    let changed = false;
    const content = message.content.map((part) => {
      if (!part || typeof part !== "object") return part;
      if (part.type !== "image_url" && part.type !== "input_image") return part;
      changed = true;
      const url =
        typeof part.image_url === "string"
          ? part.image_url
          : typeof part.image_url?.url === "string"
            ? part.image_url.url
            : typeof part.url === "string"
              ? part.url
              : "";
      const label = url && !url.startsWith("data:") ? `[Image: ${url}]` : "[Image]";
      return { type: "text", text: label };
    });
    return changed ? { ...message, content } : message;
  });
}

function sanitizeChatToolHistory(messages, provider) {
  if (!Array.isArray(messages)) return messages;
  const repaired = ensureToolResultsForCalls(coalesceAssistantMessages(messages));
  return isGeminiProvider(provider)
    ? ensureGeminiThoughtSignatures(sanitizeGeminiImageContent(repaired))
    : repaired;
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
  // Codex tags outbound payloads with caller identity that no upstream
  // provider consumes; strict providers reject the unknown field outright.
  delete payload.client_metadata;
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
  const expectedRoute =
    provider.protocol === "anthropic"
      ? "/messages"
      : provider.protocol === "openai-responses"
        ? "/responses"
        : "/chat/completions";
  if (route !== expectedRoute) {
    const error = new Error(`Model ${model.gatewayModel} does not support ${route}.`);
    error.status = 400;
    throw error;
  }

  payload.model = model.upstreamModel;
  // Google's OpenAI-compatible endpoint (/v1beta/openai/chat/completions)
  // rejects any field outside the OpenAI schema with a hard 400
  // (INVALID_ARGUMENT: Unknown name "..."). Two such fields reach this hop for
  // Gemini: web_search_options, and the thinking/think reasoning controls that
  // upstream reasoning translation attaches for Gemini 3.x thinking models.
  // Left in place the 400 surfaces as a misleading native-ChatGPT fallback
  // error rather than a routing failure, so strip them before forwarding.
  if (isGeminiProvider(provider)) {
    delete payload.web_search_options;
    delete payload.thinking;
    delete payload.think;
    // store and logit_bias are OpenAI-only; Google's surface accepts neither.
    // (frequency_penalty/presence_penalty/seed are supported, so they stay.)
    delete payload.store;
    delete payload.logit_bias;
  }
  // Fireworks rejects this OpenAI search parameter instead of ignoring it.
  // Other provider payloads keep it unchanged.
  if (provider.id === "fireworks") delete payload.web_search_options;
  if (Array.isArray(payload.messages)) {
    payload.messages = sanitizeChatToolHistory(payload.messages, provider);
  }
  if (provider.authProfile === "github-copilot") {
    // This is native ChatGPT account metadata, not an upstream scheduling
    // request Copilot accepts.
    delete payload.service_tier;
  }
  // An image here has bypassed the router's vision bridge. This forwarder sits
  // *downstream* of the gateway -- every routed model's `api_base` points at it
  // -- so Codex's own traffic arrives already bridged and never carries one.
  // What reaches this line is a client talking to the gateway directly, and the
  // provider's answer to an image part on a text-only model is a 400 naming a
  // JSON variant rather than an image, which reads as a router bug.
  //
  // Reading it here is deliberately not the answer. The engine call would have
  // to re-enter the gateway that is holding this very request open, so the fix
  // for wanting images read is to send them through the router, which is where
  // the bridge lives. Say that in the model's own turn instead of dropping the
  // part or letting the provider refuse the whole conversation.
  if (!supportsImageInput(model)) {
    const textPartType = provider.protocol === "openai-responses" ? "input_text" : "text";
    const reason =
      `${model.displayName || model.gatewayModel} cannot read images, and an image sent ` +
      "straight to the gateway skips the router's vision bridge";
    for (const field of ["messages", "input"]) {
      if (!Array.isArray(payload[field])) continue;
      const stripped = stripImages(payload[field], reason, { textPartType });
      if (!stripped.images) continue;
      payload[field] = stripped.input;
      // Never quieted: content the caller sent has been replaced, and an
      // unattended service is exactly where that must not happen in silence.
      console.error(
        `[api-forwarder] model=${model.gatewayModel} stripped=${stripped.images} ` +
          "image part(s) that bypassed the vision bridge",
      );
    }
  }
  if (model.requestProfile === "clinepass") {
    delete payload.reasoning_effort;
    delete payload.thinking;
    delete payload.top_p;
  } else if (model.requestProfile === "kimi-k3") {
    const effort = kimiK3Effort(payload.reasoning_effort);
    // Absent means the platform default (max); K3 rejects the thinking param.
    if (effort) payload.reasoning_effort = effort;
    else delete payload.reasoning_effort;
    delete payload.thinking;
  } else if (model.requestProfile === "deepseek-thinking") {
    payload.thinking = { type: "enabled" };
    payload.reasoning_effort = deepSeekEffort(payload.reasoning_effort);
    delete payload.temperature;
    delete payload.top_p;
    delete payload.presence_penalty;
    delete payload.frequency_penalty;
    // DeepSeek rejects forced tool choices while thinking is enabled
    // ("Thinking mode does not support this tool_choice"); downgrade to auto so
    // tool calls stay available. Codex sends "required" for the compatibility
    // probe and a function object for the subagent payload relay, so without
    // this both tool calling and routed subagents fail on every thinking model.
    if (payload.tool_choice !== undefined && payload.tool_choice !== "none") {
      payload.tool_choice = "auto";
    }
  } else if (model.requestProfile === "deepseek-nonthinking") {
    payload.thinking = { type: "disabled" };
    delete payload.reasoning_effort;
  } else if (
    ["ollama-cloud", "ollama-cloud-auto-tool-choice"].includes(model.requestProfile)
  ) {
    // Absent means the model's own default; Ollama enables thinking on capable
    // models when the parameter is omitted.
    if (payload.reasoning_effort !== undefined) {
      payload.reasoning_effort = ollamaCloudEffort(payload.reasoning_effort);
    }
    // The native think parameter is ignored on this endpoint.
    delete payload.think;
    // MiniMax M3 on Ollama Cloud accepts tool calls under auto but can emit
    // malformed arguments when Codex forces a particular tool. Preserve the
    // model-scoped exception on direct Chat Completions traffic too.
    if (
      model.requestProfile === "ollama-cloud-auto-tool-choice" &&
      payload.tool_choice !== undefined &&
      payload.tool_choice !== "none"
    ) {
      payload.tool_choice = "auto";
    }
  } else if (model.requestProfile === "qwen-plan") {
    // DashScope documents reasoning_effort only for the cross-vendor
    // DeepSeek/GLM models it resells (high/max; low/medium collapse to high,
    // xhigh to max). Qwen models have no documented effort control, so the
    // parameter is dropped for them.
    if ((model.reasoningLevels || []).length > 1) {
      payload.reasoning_effort = ["xhigh", "max", "ultra"].includes(payload.reasoning_effort)
        ? "max"
        : "high";
    } else {
      delete payload.reasoning_effort;
    }
    // Qwen rejects forced tool choices in thinking mode
    // ("tool_choice ... does not support being set to required or object");
    // downgrade to auto so tool calls stay available.
    if (payload.tool_choice !== undefined && payload.tool_choice !== "none") {
      payload.tool_choice = "auto";
    }
  } else if (model.requestProfile === "glm-thinking") {
    payload.thinking = { type: "enabled" };
    // Each GLM entry declares exactly the tiers Z.ai documents for it, and the
    // requested effort is clamped onto them. Models whose registry entry offers
    // a single level (GLM-5-Turbo, GLM-4.7) do not support the parameter at
    // all. Read the count off the entry rather than naming models here: this
    // list is what goes stale when a route is added.
    const levels = (model.reasoningLevels || []).map((level) => level.effort);
    if (levels.length > 1) {
      payload.reasoning_effort = glmEffort(payload.reasoning_effort, levels);
    } else {
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
    // Anthropic steers adaptive thinking via output_config.effort
    // (low/medium/high/xhigh/max, default high).
    const effort = { minimal: "low", ultra: "max" }[payload.reasoning_effort] ||
      (["low", "medium", "high", "xhigh", "max"].includes(payload.reasoning_effort)
        ? payload.reasoning_effort
        : "high");
    delete payload.reasoning_effort;
    payload.thinking = { type: "adaptive" };
    payload.output_config = { effort };
  } else if (model.requestProfile === "minimax-m3") {
    // MiniMax uses its own thinking control on the OpenAI-compatible
    // Chat Completions endpoint instead of reasoning_effort.
    delete payload.reasoning_effort;
    payload.thinking = { type: "adaptive" };
  } else if (model.requestProfile === "auto-tool-choice") {
    // Some models call tools happily under "auto" but reject being forced to,
    // the way DeepSeek and Qwen do in thinking mode. Their vendor profiles
    // above already handle it; this one exists for a model reached through a
    // reseller (OpenRouter, Together, Fireworks, ...), where the restriction
    // travels with the upstream model while the reseller's parameter surface
    // is plain OpenAI. So it normalizes the tool choice and nothing else:
    // borrowing qwen-plan for an OpenRouter-hosted Qwen would silently
    // collapse the picked effort onto DashScope's two-tier ladder.
    //
    // Deliberately not applied provider-wide. OpenRouter reports tool_choice
    // as a per-model entry in the `supported_parameters` of its own
    // /api/v1/models listing (filterable with ?supported_parameters=tool_choice),
    // and its default routing forwards a parameter an endpoint does not
    // support rather than refusing the request, so a rejection is the
    // upstream's and not the reseller's. Downgrading for every model behind
    // one reseller would let models that honor "required" decline the
    // compatibility probe and, worse, decline the forced function call the
    // subagent payload relay depends on.
    if (payload.tool_choice !== undefined && payload.tool_choice !== "none") {
      payload.tool_choice = "auto";
    }
  }
  return { body: Buffer.from(JSON.stringify(payload), "utf8"), model, provider, payload };
}

function upstreamHeaders(requestHeaders, body, apiKey, provider, extraHeaders = {}) {
  const headers = {};
  const providerIdentityHeaders = new Set([
    "copilot-integration-id",
    "copilot-vision-request",
    "editor-plugin-version",
    "editor-version",
    "openai-intent",
    "openai-organization",
    "x-github-api-version",
    "x-initiator",
    "x-request-id",
  ]);
  for (const [name, value] of Object.entries(requestHeaders)) {
    const lower = name.toLowerCase();
    if (HOP_BY_HOP_HEADERS.has(lower) || lower === "authorization" || lower === "x-api-key") continue;
    if (provider.authProfile === "github-copilot" && providerIdentityHeaders.has(lower)) continue;
    if (lower.startsWith("x-msh-") || lower.startsWith("x-codex-")) continue;
    if (lower.startsWith("x-openai-") || lower === "chatgpt-account-id") continue;
    if (lower === "originator" || lower === "user-agent" || lower === "accept-encoding") {
      continue;
    }
    if (value !== undefined) headers[name] = Array.isArray(value) ? value.join(", ") : value;
  }
  if (provider.authMode === "anonymous") {
    // The upstream explicitly permits anonymous access for the provider's
    // free-model subset. Never forward the gateway's internal bearer token.
  } else if (provider.protocol === "anthropic") {
    headers["x-api-key"] = apiKey;
    headers["anthropic-version"] ||= "2023-06-01";
  } else {
    headers.Authorization = `Bearer ${apiKey}`;
  }
  headers["User-Agent"] = `codex-router/${VERSION}`;
  headers["Accept-Encoding"] = "identity";
  Object.assign(headers, extraHeaders);
  if (body.length) headers["Content-Length"] = String(Buffer.byteLength(body));
  return headers;
}

async function upstreamSession(provider, credential, payload, options = {}) {
  if (provider.authProfile !== "github-copilot") {
    return { apiKey: credential.value, baseUrl: providerBaseUrl(provider), headers: {} };
  }
  const session = await ensureFreshGitHubCopilotSession(credential.value, options);
  return {
    apiKey: session.token,
    baseUrl: process.env[provider.baseUrlEnv]
      ? providerBaseUrl(provider)
      : session.baseUrl,
    headers: githubCopilotRequestHeaders(payload, session.token),
  };
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
    const credentialType = credentialLabel(normalized.provider);
    const label = credentialType === "API key" ? "key" : credentialType.toLowerCase();
    writeJson(response, 503, {
      error: {
        type: credentialType === "API key"
          ? "provider_api_key_missing"
          : "provider_credential_missing",
        provider: normalized.provider.id,
        message: `${normalized.provider.displayName} ${label} is not configured. ${setup}.`,
      },
    });
    return;
  }

  const controller = new AbortController();
  request.once("aborted", () => controller.abort());
  response.once("close", () => {
    if (!response.writableEnded) controller.abort();
  });
  // Fetch may detach a Buffer's backing ArrayBuffer while sending it. Copilot
  // can replay once after refreshing account routing, so use one immutable
  // string for both attempts instead of trying to reuse detached bytes.
  const upstreamBody = normalized.provider.authProfile === "github-copilot"
    ? normalized.body.toString("utf8")
    : normalized.body;
  let session = await upstreamSession(normalized.provider, credential, normalized.payload);
  let target = `${session.baseUrl}${route}${requestUrl.search}`;
  let upstream = await fetch(target, {
    method: request.method,
    headers: upstreamHeaders(
      request.headers,
      upstreamBody,
      session.apiKey,
      normalized.provider,
      session.headers,
    ),
    body: upstreamBody,
    signal: controller.signal,
  });
  // Account routing can change with plan or policy. Re-resolve and replay once
  // before any response byte reaches the caller; every other status is relayed.
  if (normalized.provider.authProfile === "github-copilot" && upstream.status === 401) {
    await upstream.body?.cancel().catch(() => undefined);
    session = await upstreamSession(
      normalized.provider,
      credential,
      normalized.payload,
      { force: true },
    );
    target = `${session.baseUrl}${route}${requestUrl.search}`;
    upstream = await fetch(target, {
      method: request.method,
      headers: upstreamHeaders(
        request.headers,
        upstreamBody,
        session.apiKey,
        normalized.provider,
        session.headers,
      ),
      body: upstreamBody,
      signal: controller.signal,
    });
  }
  await pipeResponse(upstream, response);
  // Harvest the provider's own quota report from the response it just sent.
  // Costs no extra request and works for any provider that emits the standard
  // headers, so a newly added provider reports limits without bespoke code.
  // Recorded after the body streams because persisting is synchronous I/O and
  // must never sit in time-to-first-byte.
  const rateLimit = parseRateLimitHeaders(upstream.headers);
  // Variant-routed responses meter the same upstream subscription, so quota
  // headers land under the family's canonical provider id.
  if (rateLimit) recordRateLimitSnapshot(canonicalProviderId(normalized.provider.id), rateLimit);
  if (!QUIET) {
    console.error(
      `[api-forwarder] provider=${normalized.provider.id} model=${normalized.model.upstreamModel} status=${upstream.status} duration_ms=${Date.now() - startedAt}`,
    );
  }
}

const server = http.createServer((request, response) => {
  handleRequest(request, response).catch((error) => {
    const status = httpErrorStatus(error);
    // Names and codes only: a forwarder failure can wrap upstream response
    // text in its message, and bodies never belong in the log. The code chain
    // is what distinguishes a dead socket from a refused connect (#171).
    console.error(
      `[api-forwarder] request failed: ${formatErrorChain(error, { messages: false })}`,
    );
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

applyKeepAliveTimeouts(server);
server.listen(LISTEN_PORT, LISTEN_HOST, () => {
  console.error("[api-forwarder] listening");
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
