import http from "node:http";

import {
  applyKeepAliveTimeouts,
  endStreamedResponse,
  formatErrorChain,
  HOP_BY_HOP_HEADERS,
  httpErrorStatus,
  installGracefulShutdown,
  pipeResponse,
  readRequestBody,
  readResponseBody,
  reportListenFailure,
  requireInternalAuth,
  writeJson,
} from "./http-utils.mjs";
import { PORTS, TARGET } from "./paths.mjs";
import {
  API_MODELS,
  MODEL_BY_GATEWAY_ID,
  PROVIDERS,
  RUNTIME_PROVIDERS,
  providerForModel,
  endpointForModel,
  resolveProviderBaseUrl,
} from "./model-registry.mjs";
import {
  cooldownUntil,
  parseRateLimitHeaders,
  requestQuotaFromRateLimitHeaders,
  retryAfterSeconds,
} from "./rate-limit-headers.mjs";
import { recordRateLimitSnapshot } from "./rate-limit-state.mjs";
import { recordProviderCooldown } from "./model-failover.mjs";
import { canonicalProviderId, readProviderSelection } from "./provider-selection.mjs";
import { stripImages, supportsImageInput } from "./vision-bridge.mjs";
import {
  credentialLabel,
  credentialStatus,
} from "./provider-credentials.mjs";
import {
  ensureFreshGitHubCopilotSession,
  githubCopilotRequestHeaders,
} from "./github-copilot-session.mjs";
import {
  commandCodeRoute,
  isUpgradeRequired,
  recordCommandCodeRoute,
} from "./commandcode-plan.mjs";
import { relayCommandCodeGenerate } from "./commandcode-relay.mjs";
import { VERSION } from "./version.mjs";
import { installStableFetchTransport } from "./fetch-transport.mjs";
import { zaiCacheUsageTransform } from "./zai-cache-usage.mjs";
import {
  buildNamespaceLookupsFromTools,
  createResponsesJsonTransform,
  createResponsesStreamTransform,
  normalizeOpenAIRequest,
} from "./openai-adapters.mjs";
import { threadIdFromHeaders } from "./codex-session-names.mjs";
import { applyOpenCodeSessionHeaders } from "./opencode-session.mjs";
import {
  effectiveProviderCredentialStatus,
  providerApiKeyAuthoritySnapshot,
  recordProviderApiKeyRequestOutcome,
  resolveProviderApiKeyForRequest,
  resolveStoredCredential,
} from "./provider-api-key-routing.mjs";
import {
  runProviderApiKeyAttempts,
} from "./provider-api-key-pool.mjs";
import {
  nonRecursiveToolSchema,
  stripCodexEncryptedSchemaAnnotation,
} from "./tool-schema-root.mjs";
import { requestGenericProvider } from "./generic-providers.mjs";
import { genericProviderConfigured } from "./generic-provider-readiness.mjs";
import { providerTransportError } from "./transport-failure.mjs";
import {
  endpointCapabilityError,
  supportsOpenAIModelEndpoint,
} from "./openai-endpoint-policy.mjs";

installStableFetchTransport();

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

// One line per provider per process: the refusal repeats on every request,
// and the point is that the operator learns about it, not that the log fills.
const warnedBaseUrlOverrides = new Set();

function providerBaseUrl(provider) {
  const { baseUrl, refusedOverride } = resolveProviderBaseUrl(provider);
  if (refusedOverride && !warnedBaseUrlOverrides.has(provider.id)) {
    warnedBaseUrlOverrides.add(provider.id);
    console.error(
      `[api-forwarder] ${provider.baseUrlEnv} ignored: keyless provider ${provider.id} sends no credential, so it stays on its loopback endpoint`,
    );
  }
  return baseUrl;
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

// HY4 itself documents two native modes: high and no_think. OpenAI-compatible
// relays expose the off switch as `none`; the relays that offer an intermediate
// tier add `low`. Codex's picker has no `none` rung, so these checked-in routes
// advertise `minimal` as the no-thinking choice and translate it here. Do not
// borrow the rest of Codex's ladder: medium and above collapse to HY4's native
// high mode, while low is forwarded only when the route explicitly publishes it.
function hy4Effort(value, levels) {
  if (["none", "minimal"].includes(value)) return "none";
  if (value === "low" && levels.includes("low")) return "low";
  if (["low", "medium", "high", "xhigh", "max", "ultra"].includes(value)) {
    return "high";
  }
  return undefined;
}

// Some upstreams document reasoning_effort per model rather than per vendor:
// GLM-5.2 answers to high/max, while GLM-5.3 and the certified GLM-5.3-Flash
// routes add a low tier (low/high/max, max the upstream default). So the
// accepted rungs travel with the model, and
// the requested effort is clamped onto the ladder its own registry entry
// declares instead of onto a fixed map -- otherwise GLM-5.3's low tier could
// never be reached. Codex's top rungs always mean "as deep as this model
// goes"; anything else takes the nearest declared rung at or below it, and a
// request under the model's floor lands on that floor. An absent or unknown
// value is treated as "high", which is what the two-tier map sent before this
// generalization.
const EFFORT_LADDER = ["minimal", "low", "medium", "high", "xhigh", "max", "ultra"];

function declaredEffort(value, levels) {
  const declared = levels
    .filter((effort) => EFFORT_LADDER.includes(effort))
    .sort((left, right) => EFFORT_LADDER.indexOf(left) - EFFORT_LADDER.indexOf(right));
  if (!declared.length) return undefined;
  if (["xhigh", "max", "ultra"].includes(value)) return declared.at(-1);
  const requested = EFFORT_LADDER.indexOf(value);
  const ceiling = requested === -1 ? EFFORT_LADDER.indexOf("high") : requested;
  const atOrBelow = declared.filter((effort) => EFFORT_LADDER.indexOf(effort) <= ceiling);
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

function restoreGlmReasoningContent(messages) {
  if (!Array.isArray(messages)) return messages;
  return messages.map((message) => {
    if (message?.role !== "assistant" || !Array.isArray(message.content)) return message;
    const reasoning = [];
    const visible = [];
    let sawThinking = false;
    for (const part of message.content) {
      if (part?.type === "thinking") {
        // A malformed or signature-only thinking block must never fall through
        // as ordinary assistant content. LiteLLM normally supplies `text`,
        // while a few adapters use `thinking`; accept either spelling only
        // when it is a non-empty string, and drop the block otherwise.
        sawThinking = true;
        const text = [part.text, part.thinking].find(
          (value) => typeof value === "string" && value,
        );
        if (typeof text === "string" && text) {
          reasoning.push(text);
        }
        continue;
      }
      visible.push(part);
    }
    if (!sawThinking) return message;
    const restored = {
      ...message,
      content: visible.length ? visible : null,
    };
    if (
      reasoning.length &&
      !(typeof message.reasoning_content === "string" && message.reasoning_content)
    ) {
      restored.reasoning_content = reasoning.join("\n");
    }
    return restored;
  });
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

function isGeminiProvider(provider, model) {
  if (provider?.generic === true) return false;
  if (provider?.id === "gemini-api" || provider?.ownedBy?.toLowerCase?.() === "google") {
    return true;
  }
  return [
    provider?.id,
    provider?.ownedBy,
    model?.provider,
    model?.slug,
    model?.upstreamModel,
    model?.gatewayModel,
    model?.model,
  ].some((value) => typeof value === "string" && value.toLowerCase().includes("gemini"));
}

function stripEncryptedToolSchemaAnnotations(payload, protocol) {
  if (!Array.isArray(payload.tools)) return;
  let changed = false;
  const tools = payload.tools.map((tool) => {
    if (!tool || typeof tool !== "object" || Array.isArray(tool) || tool.type !== "function") {
      return tool;
    }
    if (protocol === "openai-responses") {
      const repaired = stripCodexEncryptedSchemaAnnotation(tool.parameters);
      if (repaired === tool.parameters) return tool;
      changed = true;
      return { ...tool, parameters: repaired };
    }
    const fn = tool.function;
    if (!fn || typeof fn !== "object" || Array.isArray(fn)) return tool;
    const repaired = stripCodexEncryptedSchemaAnnotation(fn.parameters);
    if (repaired === fn.parameters) return tool;
    changed = true;
    return { ...tool, function: { ...fn, parameters: repaired } };
  });
  if (changed) payload.tools = tools;
}

// Meta's Console API behind opencode answers a self-referencing tool schema
// with a bare 400 naming neither the tool nor the definition, and the turn is
// lost. Measured against that endpoint, an ordinary `$ref`/`$defs` pair is
// accepted and only a reference re-entering its own ancestor is refused, so
// `nonRecursiveToolSchema` -- which blanks exactly the cycle-closing edge and
// returns any other schema by identity -- is the whole fix. The namespace relay
// already uses it for the same reason.
function flattenRecursiveToolSchemas(payload, protocol) {
  if (!Array.isArray(payload.tools)) return;
  let changed = false;
  const tools = payload.tools.map((tool) => {
    if (!tool || typeof tool !== "object" || Array.isArray(tool) || tool.type !== "function") {
      return tool;
    }
    if (protocol === "openai-responses") {
      const flattened = nonRecursiveToolSchema(tool.parameters);
      if (flattened === tool.parameters) return tool;
      changed = true;
      return { ...tool, parameters: flattened };
    }
    const fn = tool.function;
    if (!fn || typeof fn !== "object" || Array.isArray(fn)) return tool;
    const flattened = nonRecursiveToolSchema(fn.parameters);
    if (flattened === fn.parameters) return tool;
    changed = true;
    return { ...tool, function: { ...fn, parameters: flattened } };
  });
  if (!changed) return;
  payload.tools = tools;
  // Never quieted: a tool the model may call has lost part of its argument
  // shape, and an unattended service is exactly where that must not be silent.
  console.error(
    "[api-forwarder] broke recursive $ref cycles in tool schema(s) for this request",
  );
}

// A trailing model turn is a destructive rewrite: it discards part of the
// caller's conversation. Only Google's own provider gets that behavior from
// identity. Resellers and custom endpoints must opt in per model after their
// endpoint has proved that it rejects a prefilled model turn.
function requiresTrailingUserTurn(provider, model) {
  return (
    (provider?.generic !== true && (
      provider?.id === "gemini-api" ||
      provider?.ownedBy?.toLowerCase?.() === "google"
    )) ||
    model?.requiresTrailingUserTurn === true
  );
}

// Both Command Code entries -- the chat-completions catalog and the Messages
// variant that carries the Claude models -- reach the same account, so both
// answer to the same plan entitlement and the same fallback route.
function isCommandCodeProvider(provider) {
  return provider?.ownedBy === "commandcode";
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

function trimTrailingModelTurns(messages) {
  const trimmed = [...messages];
  while (trimmed.length > 0 && trimmed[trimmed.length - 1]?.role === "assistant") {
    trimmed.pop();
  }
  return trimmed;
}

function sanitizeChatToolHistory(messages, provider, model) {
  if (!Array.isArray(messages)) return messages;
  const repaired = ensureToolResultsForCalls(coalesceAssistantMessages(messages));
  let cleaned = repaired;
  if (isGeminiProvider(provider, model)) {
    cleaned = ensureGeminiThoughtSignatures(sanitizeGeminiImageContent(repaired));
  }
  return requiresTrailingUserTurn(provider, model) ? trimTrailingModelTurns(cleaned) : cleaned;
}

// The Qwen3.8 chat template counts a turn as one of these three roles. Probing
// the live community endpoint with one-message-token requests measured the rule
// exactly: `[system, user]` 200s, while `[user, system, user]`,
// `[user, assistant, system]`, and `[system, system, user]` each 400 with
// "System message must be at the beginning." So: at most one `system`, and it
// must sit ahead of the first turn. `developer` is not a turn and is not
// counted -- `[developer, system, user]`, `[user, developer, user]`, and
// `[developer, developer, user]` all 200 -- which is why "the beginning" means
// "before the first turn" rather than index 0, and why nothing here moves,
// merges, or rewrites a developer message.
const QWEN38_TURN_ROLES = new Set(["user", "assistant", "tool"]);

function qwen38SystemOrderIsLegal(messages) {
  let systems = 0;
  let sawTurn = false;
  for (const message of messages) {
    const role = message?.role;
    if (role === "system") {
      systems += 1;
      if (systems > 1 || sawTurn) return false;
    } else if (QWEN38_TURN_ROLES.has(role)) {
      sawTurn = true;
    }
  }
  return true;
}

// Content arrives as a plain string or as OpenAI content parts, and Codex sends
// both shapes on this route. Strings join with a blank line so the merged
// instructions read as separate paragraphs; parts lists concatenate. A mixed
// merge promotes the strings to text parts rather than stringifying the parts,
// because flattening a parts list would drop everything that is not text.
function combineQwen38SystemContent(contents) {
  if (contents.every((content) => typeof content === "string")) return contents.join("\n\n");
  return contents.flatMap((content) =>
    typeof content === "string" ? [{ type: "text", text: content }] : content,
  );
}

// A compatibility repair, and it is not free: instructions the caller placed
// mid-conversation end up hoisted ahead of the first turn, so the model reads
// them as opening context instead of as a later correction. That is a real
// change in meaning, accepted only because this endpoint answers the original
// ordering with a 400 and no answer at all. Every non-system message keeps its
// position, and the merged text keeps the callers' relative order.
function normalizeQwen38SystemMessages(messages) {
  if (!Array.isArray(messages) || qwen38SystemOrderIsLegal(messages)) return messages;
  const rest = [];
  const contents = [];
  let first;
  let firstSystemSlot = -1;
  for (const message of messages) {
    if (message?.role !== "system") {
      rest.push(message);
      continue;
    }
    if (firstSystemSlot === -1) {
      firstSystemSlot = rest.length;
      first = message;
    }
    const content = message.content;
    if (content === undefined || content === null || content === "") continue;
    contents.push(content);
  }
  const firstTurn = rest.findIndex((message) => QWEN38_TURN_ROLES.has(message?.role));
  // Ahead of the first turn, and no earlier than where the caller's own first
  // system message sat -- so a leading `developer` message keeps its lead.
  const insertAt = firstTurn === -1 ? firstSystemSlot : Math.min(firstSystemSlot, firstTurn);
  const merged = { ...first, content: combineQwen38SystemContent(contents) };
  return [...rest.slice(0, insertAt), merged, ...rest.slice(insertAt)];
}

// Meta's Responses surface validates the hosted search tool against the legacy
// `web_search_preview` schema: any other tool carrying `search_content_types`
// is answered with HTTP 400 "`tools[].search_content_types` is only supported
// for web_search_preview tools" (param `tools[].search_content_types`).
//
// The field is dropped, never renamed and never moved onto another tool. What
// the caller asked for is a search-result content filter; the endpoint that
// refuses the field is telling us it will not apply it, and inventing a
// `web_search_preview` tool to carry it would change which hosted tool the
// model is offered.
//
// The returned array is a copy only when something was actually removed, so a
// request with no such tool is forwarded byte-identical to what arrived.
function stripSearchContentTypes(tools) {
  if (!Array.isArray(tools)) return tools;
  let stripped = false;
  const repaired = tools.map((tool) => {
    if (
      !tool ||
      typeof tool !== "object" ||
      Array.isArray(tool) ||
      tool.type === "web_search_preview" ||
      !("search_content_types" in tool)
    ) {
      return tool;
    }
    stripped = true;
    const { search_content_types: _refused, ...rest } = tool;
    return rest;
  });
  return stripped ? repaired : tools;
}

/**
 * Strip empty `tools: []` and dangling `tool_choice` from a payload.
 * Returns whether the payload was changed.
 * 
 * The vLLM build in qwen38-community and other strict upstreams (>=0.20 Pydantic)
 * refuse an empty tools array. Codex sends `tools: []` on compaction and plain chat,
 * so without this strip every compaction against strict providers 400s. An empty tools
 * array is valid for lenient providers and explicitly permitted by OpenAI's schema, so
 * the repair belongs at this last hop rather than in the compaction path. Omitting the
 * empty field is also valid for providers like OpenCode Go.
 * 
 * Drops tool_choice only when an empty tools: [] was actually stripped, not when tools
 * was never present. Requests with tool_choice but no tools field are forwarded as-is
 * for profiles that need them.
 */
function stripEmptyTools(payload) {
  let changed = false;
  const hadEmptyTools = Array.isArray(payload.tools) && payload.tools.length === 0;
  if (hadEmptyTools) {
    delete payload.tools;
    changed = true;
    if ("tool_choice" in payload) {
      delete payload.tool_choice;
      changed = true;
    }
  }
  return changed;
}

function normalizeBody(buffer, contentType, route) {
  if (!buffer.length || !String(contentType || "").includes("application/json")) {
    const error = new Error("API-provider requests require a JSON body.");
    error.status = 400;
    throw error;
  }
  let payload = JSON.parse(buffer.toString("utf8"));
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
  if (
    route === "/embeddings"
      ? !supportsOpenAIModelEndpoint(route, { model, provider })
      : route !== expectedRoute ||
        (model.supportedEndpoints !== undefined &&
          !supportsOpenAIModelEndpoint(route, { model, provider }))
  ) {
    if (route === "/embeddings" || model.supportedEndpoints !== undefined) {
      throw endpointCapabilityError(route, model);
    }
    const error = new Error(`Model ${model.gatewayModel} does not support ${route}.`);
    error.status = 400;
    throw error;
  }

  payload.model = model.upstreamModel;
  // Embeddings have their own wire contract. Keep every provider-specific
  // input field unchanged and never send the body through a chat adapter.
  if (route === "/embeddings") {
    const endpoint = endpointForModel(model);
    return {
      body: Buffer.from(JSON.stringify(payload), "utf8"),
      model,
      provider,
      endpoint,
      payload,
    };
  }

  // Responses providers get one checked boundary here. The request remains a
  // Responses request, but legacy aliases are normalized before any provider
  // sees it and the original payload remains available for retries.
  if (provider.protocol === "openai-responses") {
    payload = normalizeOpenAIRequest(payload);
  }

  // OpenAI Chat Completions providers place terminal usage in a final empty
  // choices chunk only when the caller opts into it. Keep this normalization
  // on the provider's Chat Completions surface: Responses and Anthropic
  // endpoints have different stream contracts, and a provider that declares
  // either protocol must not receive an OpenAI-only stream_options field.
  if (
    route === "/chat/completions" &&
    payload.stream === true &&
    (provider.protocol === undefined || provider.protocol === "openai")
  ) {
    const streamOptions = payload.stream_options;
    payload.stream_options = {
      ...(streamOptions && typeof streamOptions === "object" && !Array.isArray(streamOptions)
        ? streamOptions
        : {}),
      include_usage: true,
    };
  }

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
  // Fireworks and OpenCode Console Go reject this OpenAI search parameter
  // instead of ignoring it. Keep the repair provider-scoped: other compatible
  // chat surfaces use the option and must retain it.
  if (["fireworks", "opencode-go"].includes(provider.id)) {
    delete payload.web_search_options;
  }
  // Meta refuses `search_content_types` on anything but a `web_search_preview`
  // tool, and Codex only ever sends the current spelling: its hosted search
  // tool is `type: "web_search"`, carrying search_content_types beside
  // external_web_access, indexed_web_access, filters, user_location, and
  // search_context_size (read out of the shipped 0.147 binary, which contains
  // no occurrence of `web_search_preview` at all). The tool is declared on the
  // turn whenever web search is enabled, not only when the model searches, so
  // the reporter's "running anything" is literal: every turn 400s and the
  // provider is unusable rather than degraded (#286).
  //
  // Deliberately scoped to Meta and not applied everywhere. OpenAI documents
  // `search_content_types` on `web_search` and *not* on `web_search_preview`,
  // which is the reverse of what this endpoint enforces, so Meta is running an
  // older fork of the schema rather than being the strict reader of it.
  // Stripping the field for every provider would take a documented parameter
  // away from responses-native providers that do follow the current spec, such
  // as GitHub Copilot. Console Go Responses has its separately measured strict
  // tool boundary applied in the router before this hop. A caller that does send
  // Meta a real `web_search_preview` tool keeps the field, because that is the
  // one tool this endpoint accepts it on.
  if (provider.id === "meta" && Array.isArray(payload.tools)) {
    payload.tools = stripSearchContentTypes(payload.tools);
  }
  // Strip empty tools array and dangling tool_choice for all routes.
  // Strict upstreams (vLLM >=0.20 Pydantic) refuse both, and Codex sends
  // tools: [] on compaction and plain chat. Log when a request is changed.
  if (stripEmptyTools(payload)) {
    if (!QUIET) {
      console.error(
        `[api-forwarder] model=${model.gatewayModel} stripped empty tools/tool_choice`,
      );
    }
  }
  if (Array.isArray(payload.messages)) {
    payload.messages = sanitizeChatToolHistory(payload.messages, provider, model);
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
  if (model.requestProfile === "codex-encrypted-schema") {
    stripEncryptedToolSchemaAnnotations(payload, provider.protocol);
  }
  // Deliberately its own statement rather than a branch of the profile chain
  // below: this is an upstream limitation, and every route that has it also
  // needs a request profile of its own, which the single-valued field cannot
  // express.
  if (model.toolSchemaRecursion === "flatten") {
    flattenRecursiveToolSchemas(payload, provider.protocol);
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
  } else if (model.requestProfile === "hy4-reasoning") {
    if (payload.reasoning_effort !== undefined) {
      const effort = hy4Effort(
        payload.reasoning_effort,
        (model.reasoningLevels || []).map((level) => level.effort),
      );
      if (effort) payload.reasoning_effort = effort;
      else delete payload.reasoning_effort;
    }
  } else if (
    ["ollama-cloud-glm-5-3", "ollama-cloud-glm-5-3-flash"].includes(model.requestProfile)
  ) {
    // GLM-5.3 and GLM-5.3-Flash always think and reject every rung outside low/high/max.
    // Clamp Codex-only rungs onto the ladder this entry declares instead of
    // letting the generic Ollama map send none/medium and get a 400. The
    // router can send both the flat chat-completions field and the nested
    // Responses spelling; the nested value is authoritative, so clamp it and
    // synchronize the flat field to the same rung.
    const levels = (model.reasoningLevels || []).map((level) => level.effort);
    if (payload.reasoning?.effort !== undefined) {
      const effort = declaredEffort(payload.reasoning.effort, levels);
      if (effort) payload.reasoning.effort = effort;
      else delete payload.reasoning.effort;
    }
    if (payload.reasoning_effort !== undefined) {
      const effort = declaredEffort(payload.reasoning_effort, levels);
      if (effort) payload.reasoning_effort = effort;
      else delete payload.reasoning_effort;
    }
    if (payload.reasoning?.effort !== undefined) {
      payload.reasoning_effort = payload.reasoning.effort;
    }
    delete payload.think;
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
    payload.thinking = { type: "enabled", clear_thinking: false };
    payload.messages = restoreGlmReasoningContent(payload.messages);
    // Each GLM entry declares exactly the tiers Z.ai documents for it, and the
    // requested effort is clamped onto them. Models whose registry entry offers
    // a single level (GLM-5-Turbo, GLM-4.7) do not support the parameter at
    // all. Read the count off the entry rather than naming models here: this
    // list is what goes stale when a route is added.
    const levels = (model.reasoningLevels || []).map((level) => level.effort);
    if (levels.length > 1) {
      payload.reasoning_effort = declaredEffort(payload.reasoning_effort, levels);
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
  } else if (model.requestProfile === "qwen38-community") {
    // The community endpoint's vLLM build validates reasoning_effort against a
    // literal set -- none, minimal, low, medium, high, xhigh, max -- and
    // answers anything else with a 400 naming the whole enum (measured against
    // the live endpoint, not read off the model card). The Codex ladder is
    // that set plus `ultra`, so `ultra` is the one value that has to be folded,
    // and it folds onto `max` because that is the tier it is asking for.
    // Everything else passes through as the literal the endpoint accepts.
    if (payload.reasoning_effort === "ultra") payload.reasoning_effort = "max";
    // The same endpoint also refuses tool_choice when tools is absent or still
    // empty after the global strip ("When using `tool_choice`, `tools` must be
    // set"). Drop dangling tool_choice for this profile only.
    if (!Array.isArray(payload.tools) || payload.tools.length === 0) {
      delete payload.tool_choice;
    }
    // Third measured refusal on the same endpoint: "System message must be at
    // the beginning." A conversation that already satisfies the rule is left
    // byte-identical -- see normalizeQwen38SystemMessages for the rule, the
    // developer-role exemption, and what the repair costs.
    if (Array.isArray(payload.messages)) {
      payload.messages = normalizeQwen38SystemMessages(payload.messages);
    }
  } else if (model.requestProfile === "minimax-m3") {
    // MiniMax uses its own thinking control on the OpenAI-compatible
    // Chat Completions endpoint instead of reasoning_effort.
    //
    // Without `reasoning_split`, MiniMax embeds the chain of thought in
    // `content` as literal <think>...</think> markup, so it renders as
    // ordinary assistant text in any client that does not know the vendor
    // format. With it, the reasoning arrives in `reasoning_content` -- which
    // this router already relays as reasoning -- and `content` carries only
    // the answer. A live probe against api.minimax.io confirmed both halves:
    // HTTP 200 either way, `<think>` present in `content` without the flag and
    // absent with it, alongside a populated `reasoning_content`.
    //
    // This is why there is no output filter here. Stripping the markup
    // downstream means running a state machine over every streamed field, and
    // the fields it would have to walk include tool-call argument deltas --
    // where a patch that merely mentions <think> would be corrupted into
    // invalid JSON. Fixing the leak at the source removes that whole class of
    // failure instead of managing it.
    delete payload.reasoning_effort;
    payload.thinking = { type: "adaptive" };
    payload.reasoning_split = true;
  } else if (model.requestProfile === "ox-alpha") {
    // Ox Alpha's named GLM-5.3-Flash successor always thinks, and both
    // checked-in routes using this legacy-named profile validate
    // reasoning_effort against the rungs the model accepts -- an off-ladder value comes
    // back as HTTP 400 "This model always engages in thinking and cannot be
    // disabled" rather than being ignored. Both accept low/high/max. Codex can
    // send any rung it knows: an installation older than 0.143 has no `max` in its enum at all,
    // so the catalog clamps this model's default down to `xhigh` and that is
    // what arrives here. Clamping onto the entry's own declared ladder is what
    // keeps both of those cases off the 400.
    if (payload.reasoning_effort !== undefined) {
      const effort = declaredEffort(
        payload.reasoning_effort,
        (model.reasoningLevels || []).map((level) => level.effort),
      );
      if (effort) payload.reasoning_effort = effort;
      else delete payload.reasoning_effort;
    }
    // Absent means the upstream's own default, which is the top rung. The
    // routes document no `thinking` switch, and thinking cannot be turned off.
    delete payload.thinking;
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
  // The provider still answers protocol, auth profile, and identity; the
  // endpoint answers where the request goes and what authenticates it. For
  // every provider but a per-model-endpoint one they are the same object.
  const endpoint = endpointForModel(model);
  return {
    body: Buffer.from(JSON.stringify(payload), "utf8"),
    model,
    provider,
    endpoint,
    payload,
    responseAdapter: provider.protocol === "openai-responses" ? "responses" : undefined,
  };
}

function upstreamHeaders(requestHeaders, body, apiKey, provider, extraHeaders = {}, endpoint = provider) {
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
  if (provider.generic === true || endpoint.authMode === "anonymous") {
    // The upstream explicitly permits anonymous access -- for a reseller's
    // free-model subset, a single allowlisted community endpoint, or the
    // generic-provider boundary which injects its own confined credential.
    // Never forward the gateway's internal bearer token to any of them.
  } else if (provider.protocol === "anthropic") {
    headers["x-api-key"] = apiKey;
    headers["anthropic-version"] ||= "2023-06-01";
  } else {
    headers.Authorization = `Bearer ${apiKey}`;
  }
  headers["User-Agent"] = `codex-router/${VERSION}`;
  headers["Accept-Encoding"] = "identity";
  Object.assign(headers, extraHeaders);
  // OpenCode Go/Zen affinity must win over any session.headers merge above:
  // starting 2026-09-06 their edge may refuse requests without this header.
  applyOpenCodeSessionHeaders(headers, {
    provider,
    requestHeaders,
    body,
  });
  // Content-Length is fetch's to compute. An explicit copy is at best
  // redundant, and the HTTP/1.1 dispatcher rejects the request outright
  // (UND_ERR_INVALID_ARG) when a caller-supplied value accompanies a body.
  return headers;
}

async function relayUpstreamResponse(
  normalized,
  upstream,
  response,
  startedAt,
  telemetryUpstream = upstream,
) {
  const upstreamContentType = upstream.headers.get("content-type") || "";
  const responsesStream = normalized.responseAdapter === "responses" &&
    upstream.ok && upstreamContentType.toLowerCase().includes("text/event-stream");
  const responsesJson = normalized.responseAdapter === "responses" &&
    upstream.ok && upstreamContentType.toLowerCase().includes("application/json");
  
  // Build namespace lookups from the flattened tools in the request payload
  // to restore namespaced function calls (e.g., "multi_agent_v1__spawn_agent" 
  // back to { namespace: "multi_agent_v1", name: "spawn_agent" })
  const flatToNative = (responsesStream || responsesJson)
    ? buildNamespaceLookupsFromTools(normalized.payload?.tools)
    : new Map();
  
  const transform = [
    responsesStream ? createResponsesStreamTransform(flatToNative) : undefined,
    responsesJson ? createResponsesJsonTransform(flatToNative) : undefined,
    zaiCacheUsageTransform(normalized.provider.id, upstreamContentType),
  ].filter(Boolean);
  const denylist = transform.length
    ? new Set([...HOP_BY_HOP_HEADERS, "content-type"])
    : undefined;
  if (responsesStream) response.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  if (responsesJson) response.setHeader("Content-Type", "application/json; charset=utf-8");
  await pipeResponse(upstream, response, denylist, transform);
  recordUpstreamLimits(normalized, telemetryUpstream);
  if (!QUIET) {
    console.error(
      `[api-forwarder] provider=${normalized.provider.id} model=${normalized.model.upstreamModel} status=${upstream.status} duration_ms=${Date.now() - startedAt}`,
    );
  }
}

async function upstreamSession(provider, credential, payload, options = {}, endpoint = provider) {
  if (provider.authProfile !== "github-copilot") {
    return { apiKey: credential.value, baseUrl: providerBaseUrl(endpoint), headers: {} };
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

// Harvest the provider's own quota report from the response it just sent.
// Costs no extra request and works for any provider that emits the standard
// headers, so a newly added provider reports limits without bespoke code.
// Called after the body streams because persisting is synchronous I/O and must
// never sit in time-to-first-byte.
function recordUpstreamLimits(normalized, upstream) {
  const rateLimit = parseRateLimitHeaders(upstream.headers);
  // Variant-routed responses meter the same upstream subscription, so quota
  // headers land under the family's canonical provider id.
  if (rateLimit) recordRateLimitSnapshot(canonicalProviderId(normalized.provider.id), rateLimit);
  // This hop is the only place the provider's own status and headers are seen
  // before LiteLLM restates them, so it is the only place a reset time the
  // gateway does not relay can still be read. A failure that names when the
  // caller may return is worth recording: the router reads it to skip a
  // provider it already knows is empty instead of buying the same rejection
  // once per turn. Only a failure, and only a window the provider itself
  // named -- a healthy response is never a reason to stop using a provider.
  if (upstream.ok) return;
  const until = cooldownUntil(rateLimit);
  if (!until) return;
  // The provider id is passed through unresolved: `recordProviderCooldown`
  // keys the window by cooldown scope, and pre-canonicalizing here would file
  // a separately billed variant's window under the subscription it does not
  // share.
  recordProviderCooldown(normalized.provider.id, {
    until,
    reason: upstream.status === 429 ? "rate_limited" : "out_of_usage",
  });
}

function healthPayload() {
  const providers = {};
  let ok = true;
  const enabled = new Set(readProviderSelection());
  const poolAuthoritySnapshot = providerApiKeyAuthoritySnapshot();
  for (const provider of RUNTIME_PROVIDERS.values()) {
    if (provider.kind !== "openai-compatible") continue;
    if (provider.generic === true) {
      const configured = genericProviderConfigured(provider.id);
      providers[provider.id] = {
        generic: true,
        credential_present: configured,
        credential_source: provider.credentialRef ? "bound credential reference" : "not required",
      };
      continue;
    }
    if (!enabled.has(provider.id)) continue;
    const status = effectiveProviderCredentialStatus(provider, {
      poolAuthoritySnapshot,
    });
    if (status.pooled && status.configured !== true) ok = false;
    providers[provider.id] = {
      credential_present: status.configured,
      ...(status.configured
        ? { credential_source: status.source }
        : { setup: status.setup }),
      ...(status.pooled
        ? {
            api_key_pool: {
              configured: true,
              valid: poolAuthoritySnapshot.valid,
              usable: status.poolReadiness?.usable === true,
              reason: status.poolReadiness?.reason || "invalid_pool_state",
              credential_count: status.poolReadiness?.credentialCount || 0,
              eligible_credential_count: status.poolReadiness?.eligibleCredentialCount || 0,
              resolvable_credential_count: status.poolReadiness?.resolvableCredentialCount || 0,
            },
          }
        : {}),
    };
  }
  return { ok, service: "codex-router-api-forwarder", providers };
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
    const health = healthPayload();
    writeJson(response, health.ok ? 200 : 503, health);
    return;
  }

  const route = requestUrl.pathname.replace(/^\/v1(?=\/|$)/, "");
  if (request.method === "GET" && route === "/models") {
    localModels(response);
    return;
  }
  if (
    request.method !== "POST" ||
    !["/chat/completions", "/messages", "/responses", "/embeddings"].includes(route)
  ) {
    writeJson(response, 404, {
      error: { type: "proxy_route_not_found", message: "Unsupported API-provider route." },
    });
    return;
  }

  const original = await readRequestBody(request);
  const normalized = normalizeBody(original, request.headers["content-type"], route);
  const controller = new AbortController();
  request.once("aborted", () => controller.abort());
  response.once("close", () => {
    if (!response.writableEnded) controller.abort();
  });

  // Generic providers own a stricter request boundary than checked-in routes:
  // it re-reads the operator descriptor, revalidates DNS, rejects redirects,
  // and injects only the credential reference bound to that provider. Do not
  // resolve it through the built-in credential path or construct its URL here;
  // either would bypass the confinement #404 established.
  if (normalized.provider.generic === true) {
    const { response: upstream, dispatcher } = await requestGenericProvider(
      normalized.provider.id,
      `${route}${requestUrl.search}`,
      {
        method: request.method,
        headers: upstreamHeaders(
          request.headers,
          normalized.body,
          undefined,
          normalized.provider,
        ),
        body: normalized.body,
        signal: controller.signal,
        // A model generation lives as long as its caller. Discovery and the
        // explicit provider test remain separately bounded.
        timeoutMs: 0,
      },
    );
    try {
      await relayUpstreamResponse(normalized, upstream, response, startedAt);
    } finally {
      await dispatcher?.close().catch(() => undefined);
    }
    return;
  }

  // Resolved against the endpoint, not the provider: a per-model endpoint keeps
  // its credential under its own slug, so two custom models on two hosts never
  // share a key and one missing key never blocks the other model. A configured
  // pool is authoritative; the routing helper deliberately refuses to fall
  // back to the legacy single key when the pool has no usable entry.
  const poolRouting = await resolveProviderApiKeyForRequest(normalized.endpoint, {
    sessionId: threadIdFromHeaders(request.headers),
  });
  const credential = poolRouting.credential;
  if (!credential) {
    const setup = poolRouting.pooled
      ? "Add a usable credential reference to the provider API-key pool."
      : credentialStatus(normalized.endpoint).setup;
    const credentialType = credentialLabel(normalized.endpoint);
    const label = credentialType === "API key" ? "key" : credentialType.toLowerCase();
    // Name whichever of the two the operator would go and configure. For a
    // per-model endpoint the provider is a container, so "Custom key is not
    // configured" would not say which model to fix.
    const subject = normalized.provider.perModelEndpoint
      ? normalized.model.displayName || normalized.model.slug
      : normalized.provider.displayName;
    writeJson(response, 503, {
      error: {
        type: poolRouting.pooled
          ? "provider_api_key_pool_unavailable"
          : credentialType === "API key"
            ? "provider_api_key_missing"
            : "provider_credential_missing",
        provider: normalized.provider.id,
        message: `${subject} ${label} is not configured. ${setup}.`,
      },
    });
    return;
  }

  // Command Code's documented API is an entitlement, not a credential: the
  // same key that runs its CLI is refused by /provider/v1 on the plans most of
  // its customers buy. The CLI's own route serves those plans, so an account
  // already known to be refused goes straight there rather than paying a 403
  // for the privilege of finding out again.
  let routedCredentialValue = credential.value;
  let commandCode = isCommandCodeProvider(normalized.provider)
    ? (() => {
        const id = canonicalProviderId(normalized.provider.id);
        return { id, ...commandCodeRoute(id, routedCredentialValue) };
      })()
    : undefined;
  const relayThroughPlan = async (
    apiKey = routedCredentialValue,
    { recordOutcome = true, deferErrors = false } = {},
  ) => {
    const outcome = await relayCommandCodeGenerate({
      payload: normalized.payload,
      model: normalized.model,
      provider: normalized.provider,
      apiKey,
      baseUrl: providerBaseUrl(normalized.endpoint),
      response,
      signal: controller.signal,
      deferErrors,
    });
    // The plan route meters the same subscription and answers the same quota
    // headers. A direct or pool-selected outcome reports those limits here;
    // intermediate pooled failures defer them until another key wins so one
    // credential cannot cool the whole provider before failover finishes.
    if (recordOutcome) {
      await recordProviderApiKeyRequestOutcome(poolRouting, normalized.endpoint, {
        status: outcome.status,
        ok: outcome.ok,
        committed: true,
        error: outcome.ok ? undefined : `upstream status ${outcome.status}`,
      });
      recordUpstreamLimits(normalized, outcome);
    }
    if (!QUIET) {
      console.error(
        `[api-forwarder] provider=${normalized.provider.id} model=${normalized.model.upstreamModel} ` +
          `route=alpha-generate status=${outcome.status} duration_ms=${Date.now() - startedAt}`,
      );
    }
    return outcome;
  };
  if (!poolRouting.pooled && route !== "/embeddings" && commandCode?.route === "plan") {
    await relayThroughPlan();
    return;
  }
  // Fetch may detach a Buffer's backing ArrayBuffer while sending it. Copilot
  // can replay once after refreshing account routing, so use one immutable
  // string for both attempts instead of trying to reuse detached bytes.
  const upstreamBody = normalized.provider.authProfile === "github-copilot"
    ? normalized.body.toString("utf8")
    : normalized.body;
  let session;
  let target;
  let upstream;
  let deferredUpstreamLimits;
  if (poolRouting.pooled && route !== "/embeddings") {
    const pooled = await runProviderApiKeyAttempts(normalized.endpoint.id, {
      filePath: undefined,
      resolveCredential: (credentialId) =>
        resolveStoredCredential(normalized.endpoint, credentialId),
      sessionId: threadIdFromHeaders(request.headers),
      isResponseCommitted: () => response.headersSent || response.writableEnded || response.writableFinished,
      send: async ({ apiKey, credentialId }) => {
        const attemptCommandCode = isCommandCodeProvider(normalized.provider)
          ? (() => {
              const id = canonicalProviderId(normalized.provider.id);
              return { id, ...commandCodeRoute(id, apiKey) };
            })()
          : undefined;
        if (attemptCommandCode?.route === "plan") {
          const outcome = await relayThroughPlan(apiKey, {
            recordOutcome: false,
            deferErrors: true,
          });
          const upstreamHeaders = outcome.headers;
          return {
            ...outcome,
            headers: outcome.responseHeaders || upstreamHeaders,
            upstreamHeaders,
            retryAfterSeconds: retryAfterSeconds(upstreamHeaders),
            quota: requestQuotaFromRateLimitHeaders(upstreamHeaders),
            committed: outcome.committed === true,
            route: "plan",
            credentialId,
          };
        }
        const attemptCredential = { ...credential, value: apiKey };
        let attemptSession = await upstreamSession(
          normalized.provider,
          attemptCredential,
          normalized.payload,
          {},
          normalized.endpoint,
        );
        let attemptTarget = `${attemptSession.baseUrl}${route}${requestUrl.search}`;
        const sendAttempt = () => fetch(attemptTarget, {
          method: request.method,
          headers: upstreamHeaders(
            request.headers,
            upstreamBody,
            attemptSession.apiKey,
            normalized.provider,
            attemptSession.headers,
            normalized.endpoint,
          ),
          body: upstreamBody,
          signal: controller.signal,
          redirect: route === "/embeddings" ? "error" : "follow",
        });
        let attemptResponse = await sendAttempt();
        // The source credential can still be valid when Copilot changes the
        // account's inference endpoint or short-lived routing token. Preserve
        // the existing same-key force-refresh contract inside each pool
        // attempt; only a second 401 proves this credential should be cooled
        // and the next pool entry tried.
        if (normalized.provider.authProfile === "github-copilot" && attemptResponse.status === 401) {
          await attemptResponse.body?.cancel().catch(() => undefined);
          attemptSession = await upstreamSession(
            normalized.provider,
            attemptCredential,
            normalized.payload,
            { force: true },
            normalized.endpoint,
          );
          attemptTarget = `${attemptSession.baseUrl}${route}${requestUrl.search}`;
          attemptResponse = await sendAttempt();
        }
        if (!attemptResponse.ok) {
          const bodyText = (await readResponseBody(attemptResponse, {
            signal: controller.signal,
          })).toString("utf8");
          if (attemptCommandCode && attemptResponse.status === 403) {
            let refusal;
            try {
              refusal = JSON.parse(bodyText);
            } catch {
              refusal = undefined;
            }
            if (isUpgradeRequired(attemptResponse.status, refusal)) {
              recordCommandCodeRoute(attemptCommandCode.id, apiKey, { providerApi: false });
              const outcome = await relayThroughPlan(apiKey, {
                recordOutcome: false,
                deferErrors: true,
              });
              const upstreamHeaders = outcome.headers;
              return {
                ...outcome,
                headers: outcome.responseHeaders || upstreamHeaders,
                upstreamHeaders,
                retryAfterSeconds: retryAfterSeconds(upstreamHeaders),
                quota: requestQuotaFromRateLimitHeaders(upstreamHeaders),
                committed: outcome.committed === true,
                route: "plan",
                credentialId,
              };
            }
          }
          return {
            status: attemptResponse.status,
            ok: false,
            committed: false,
            retryAfterSeconds: retryAfterSeconds(attemptResponse.headers),
            quota: requestQuotaFromRateLimitHeaders(attemptResponse.headers),
            bodyText,
            headers: attemptResponse.headers,
            session: attemptSession,
            target: attemptTarget,
          };
        }
        return {
          status: attemptResponse.status,
          ok: true,
          committed: false,
          response: attemptResponse,
          headers: attemptResponse.headers,
          quota: requestQuotaFromRateLimitHeaders(attemptResponse.headers),
          session: attemptSession,
          target: attemptTarget,
        };
      },
    });
    const result = pooled.result;
    if (result?.upstreamHeaders) {
      // Plan attempts keep their provider headers separate from the safe error
      // headers relayed to the caller. Only the result the pool selected may
      // update provider-wide telemetry; rejected intermediate keys already
      // recorded their quota and cooldown in per-credential pool state.
      deferredUpstreamLimits = { ...result, headers: result.upstreamHeaders };
    }
    if (pooled.committed || result?.committed) {
      // A committed attempt owns the response even when its relay throws. Let
      // the server-level error path terminate that existing stream; falling
      // through would try to create a second JSON response after its head.
      if (pooled.error) throw pooled.error;
      if (deferredUpstreamLimits) recordUpstreamLimits(normalized, deferredUpstreamLimits);
      return;
    }
    if (!result || (result.response === undefined && result.bodyText === undefined)) {
      writeJson(response, 503, {
        error: {
          type: "provider_api_key_pool_unavailable",
          message: "The provider API-key pool could not complete this request before response bytes were committed.",
        },
      });
      return;
    }
    session = result.session;
    target = result.target;
    if (isCommandCodeProvider(normalized.provider) && pooled.credentialValue) {
      const id = canonicalProviderId(normalized.provider.id);
      routedCredentialValue = pooled.credentialValue;
      commandCode = { id, ...commandCodeRoute(id, routedCredentialValue) };
    }
    upstream = result.response || new Response(result.bodyText || "", {
      status: result.status,
      headers: result.headers,
    });
  } else {
    session = await upstreamSession(
      normalized.provider,
      credential,
      normalized.payload,
      {},
      normalized.endpoint,
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
        normalized.endpoint,
      ),
      body: upstreamBody,
      signal: controller.signal,
      redirect: route === "/embeddings" ? "error" : "follow",
    });
    // Embeddings can be billed even when the response never reaches the
    // caller. Select one pool credential above and record its outcome, but do
    // not replay the same input through another credential after a 401, 429,
    // or transport failure. Chat/Responses keep their established pool
    // failover contract.
    if (poolRouting.pooled && route === "/embeddings") {
      await recordProviderApiKeyRequestOutcome(poolRouting, normalized.endpoint, {
        status: upstream.status,
        ok: upstream.ok,
        committed: false,
        error: upstream.ok ? undefined : `upstream status ${upstream.status}`,
        retryAfterSeconds: retryAfterSeconds(upstream.headers),
        quota: requestQuotaFromRateLimitHeaders(upstream.headers),
      });
    }
  }
  // Account routing can change with plan or policy. Re-resolve and replay once
  // before any response byte reaches the caller; every other status is relayed.
  if (
    !poolRouting.pooled &&
    route !== "/embeddings" &&
    normalized.provider.authProfile === "github-copilot" &&
    upstream.status === 401
  ) {
    await upstream.body?.cancel().catch(() => undefined);
    session = await upstreamSession(
      normalized.provider,
      credential,
      normalized.payload,
      { force: true },
      normalized.endpoint,
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
        normalized.endpoint,
      ),
      body: upstreamBody,
      signal: controller.signal,
    });
  }
  // Falling back here is legal for the same reason the Copilot replay above
  // is: nothing has been relayed yet. The refusal is read rather than piped
  // because only its body distinguishes "this plan has no API access" from
  // every other 403 a gateway can send, and a plan refusal must not reach the
  // caller as a failed turn when a working route exists.
  if (
    commandCode &&
    !poolRouting.pooled &&
    route !== "/embeddings" &&
    upstream.status === 403
  ) {
    const raw = (await readResponseBody(upstream, { signal: controller.signal })).toString("utf8");
    let refusal;
    try {
      refusal = JSON.parse(raw);
    } catch {
      refusal = undefined;
    }
    if (isUpgradeRequired(upstream.status, refusal)) {
      recordCommandCodeRoute(commandCode.id, routedCredentialValue, { providerApi: false });
      await relayThroughPlan();
      return;
    }
    writeJson(
      response,
      403,
      refusal || {
        error: {
          type: "provider_error",
          message: raw.slice(0, 400) || "Command Code refused the request.",
        },
      },
    );
    return;
  }
  // Only written when the account was previously known to be refused and its
  // re-check window came due, so a healthy Provider-plan account never rewrites
  // this state once per turn to repeat what it already said.
  if (commandCode?.recheck && upstream.ok) {
    recordCommandCodeRoute(commandCode.id, routedCredentialValue, { providerApi: true });
  }
  await relayUpstreamResponse(
    normalized,
    upstream,
    response,
    startedAt,
    deferredUpstreamLimits || upstream,
  );
}

const server = http.createServer((request, response) => {
  handleRequest(request, response).catch((error) => {
    const status = httpErrorStatus(error);
    const transport = providerTransportError(error);
    // Names and codes only: a forwarder failure can wrap upstream response
    // text in its message, and bodies never belong in the log. The code chain
    // is what distinguishes a dead socket from a refused connect (#171).
    console.error(
      `[api-forwarder] request failed: ${formatErrorChain(error, { messages: false })}`,
    );
    if (!response.headersSent) {
      writeJson(response, status, {
        error: transport || {
          type: "provider_api_proxy_error",
          message: "The API-provider forwarder could not complete the request.",
        },
      });
    } else if (!response.writableEnded) {
      endStreamedResponse(response, {
        message: "The API-provider forwarder lost the upstream response stream.",
      });
    }
  });
});

applyKeepAliveTimeouts(server);
reportListenFailure(server, { label: "api-forwarder", host: LISTEN_HOST, port: LISTEN_PORT });
server.listen(LISTEN_PORT, LISTEN_HOST, () => {
  console.error("[api-forwarder] listening");
});

installGracefulShutdown(server, { label: "api-forwarder" });
