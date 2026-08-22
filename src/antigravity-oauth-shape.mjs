import { randomUUID } from "node:crypto";

import { foldInterveningAssistantMessages } from "./http-utils.mjs";
import {
  normalizeSchemaLiterals,
  objectRootToolSchema,
} from "./tool-schema-root.mjs";

const DEFAULT_MAX_OUTPUT_TOKENS = 65535;
const GEMINI_THOUGHT_SIGNATURE_SENTINEL = "skip_thought_signature_validator";
export const GEMINI_THOUGHT_SIGNATURE_SEPARATOR = "__thought__";

const MODEL_FAMILIES = Object.freeze({
  "gemini-3.1-pro": Object.freeze({
    defaultEffort: "low",
    maxOutputTokens: 65535,
    thinkingBudgets: Object.freeze({ low: 1001, high: 10001 }),
    models: Object.freeze({
      low: "gemini-3.1-pro-low",
      high: "gemini-pro-agent",
    }),
  }),
  "gemini-3.5-flash": Object.freeze({
    defaultEffort: "medium",
    maxOutputTokens: 65536,
    thinkingBudgets: Object.freeze({ low: 1000, medium: 4000, high: 10000 }),
    models: Object.freeze({
      low: "gemini-3.5-flash-extra-low",
      medium: "gemini-3.5-flash-low",
      high: "gemini-3-flash-agent",
    }),
  }),
  "gemini-3.6-flash": Object.freeze({
    defaultEffort: "medium",
    maxOutputTokens: 65536,
    thinkingBudgets: Object.freeze({ low: 1000, medium: 4000, high: 10000 }),
    models: Object.freeze({
      low: "gemini-3.6-flash-low",
      medium: "gemini-3.6-flash-medium",
      high: "gemini-3.6-flash-high",
    }),
  }),
  "gemini-3.7-flash": Object.freeze({
    defaultEffort: "medium",
    maxOutputTokens: 65536,
    thinkingBudgets: Object.freeze({ low: 1000, medium: 4000, high: -1 }),
    models: Object.freeze({
      low: "gemini-3.7-flash-low",
      medium: "gemini-3.7-flash-medium",
      high: "gemini-3.7-flash-high",
    }),
  }),
});

const EFFORT_BUDGET = Object.freeze({
  minimal: 2048,
  low: 4096,
  medium: 8192,
  high: 16384,
  xhigh: 32768,
  max: 32768,
  ultra: 32768,
});

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export class AntigravityShapeError extends Error {
  constructor(message, { status = 502, code = "antigravity_response_error" } = {}) {
    super(message);
    this.name = "AntigravityShapeError";
    this.status = status;
    this.code = code;
    this.expose = true;
  }
}

function splitThoughtSignature(id) {
  const value = typeof id === "string" ? id : "";
  const at = value.indexOf(GEMINI_THOUGHT_SIGNATURE_SEPARATOR);
  if (at === -1) return { id: value, signature: undefined };
  return {
    id: value.slice(0, at),
    signature: value.slice(at + GEMINI_THOUGHT_SIGNATURE_SEPARATOR.length) || undefined,
  };
}

function toolCallIdentity(call) {
  const decoded = splitThoughtSignature(call?.id);
  return {
    id: decoded.id,
    signature:
      call?.thought_signature ||
      call?.provider_specific_fields?.thought_signature ||
      call?.function?.provider_specific_fields?.thought_signature ||
      call?.extra_content?.google?.thought_signature ||
      decoded.signature,
  };
}

function signedToolCallId(id, signature) {
  if (!signature || !id) return id;
  return `${splitThoughtSignature(id).id}${GEMINI_THOUGHT_SIGNATURE_SEPARATOR}${signature}`;
}

function textFromContent(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((part) => part && (part.type === "text" || typeof part.text === "string"))
    .map((part) => part.text || "")
    .join("");
}

function imageParts(content) {
  if (!Array.isArray(content)) return [];
  const parts = [];
  for (const part of content) {
    const url =
      typeof part?.image_url === "string" ? part.image_url : part?.image_url?.url;
    if (typeof url !== "string" || !url) continue;
    const dataMatch = url.match(/^data:([^;,]+);base64,(.+)$/);
    if (dataMatch) {
      parts.push({
        inlineData: { mimeType: dataMatch[1], data: dataMatch[2] },
      });
    } else if (/^https?:\/\//.test(url)) {
      parts.push({ fileData: { fileUri: url } });
    }
  }
  return parts;
}

function functionCallPart(call, { includeThoughtSignature = true } = {}) {
  let args;
  try {
    args = JSON.parse(call.function?.arguments || "{}");
  } catch {
    args = {};
  }
  const identity = toolCallIdentity(call);
  return {
    ...(includeThoughtSignature
      ? { thoughtSignature: identity.signature || GEMINI_THOUGHT_SIGNATURE_SENTINEL }
      : {}),
    functionCall: {
      name: call.function?.name || "",
      args: isPlainObject(args) ? args : {},
      ...(identity.id ? { id: identity.id } : {}),
    },
  };
}

function functionResponsePart(message, callIdToName) {
  let response = message.content;
  if (typeof response === "string") {
    try {
      response = JSON.parse(response);
    } catch {
      response = { output: response };
    }
  }
  const id = splitThoughtSignature(message.tool_call_id).id;
  if (!isPlainObject(response)) response = { output: response };
  return {
    functionResponse: {
      ...(id && callIdToName.get(id) ? { name: callIdToName.get(id) } : {}),
      ...(id ? { id } : {}),
      response,
    },
  };
}

function callIdToNameMap(messages) {
  const map = new Map();
  for (const message of messages) {
    if (!message || message.role !== "assistant") continue;
    for (const call of Array.isArray(message.tool_calls) ? message.tool_calls : []) {
      const id = splitThoughtSignature(call?.id).id;
      if (id && call?.function?.name) map.set(id, call.function.name);
    }
  }
  return map;
}

// Gemini function responses are grouped into one user content whose parts each
// answer a model functionCall. Chat Completions puts each result in its own
// `tool` message, so adjacent tool messages are collapsed here.
function messagesToContents(messages) {
  const contents = [];
  const systemText = [];
  const callIdToName = callIdToNameMap(messages);
  let pendingToolResponses = [];

  const flushToolResponses = () => {
    if (pendingToolResponses.length === 0) return;
    contents.push({ role: "user", parts: pendingToolResponses });
    pendingToolResponses = [];
  };

  for (const message of messages) {
    if (!message || typeof message !== "object") continue;
    if (message.role === "system" || message.role === "developer") {
      const text = textFromContent(message.content);
      if (text) systemText.push(text);
      continue;
    }
    if (message.role === "tool") {
      pendingToolResponses.push(functionResponsePart(message, callIdToName));
      continue;
    }
    flushToolResponses();
    if (message.role === "assistant") {
      const parts = [];
      const text = textFromContent(message.content);
      if (text) parts.push({ text });
      const calls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
      for (let index = 0; index < calls.length; index += 1) {
        parts.push(functionCallPart(calls[index], { includeThoughtSignature: index === 0 }));
      }
      if (parts.length) contents.push({ role: "model", parts });
      continue;
    }
    // user (and any unknown role) -> user content
    const parts = [];
    const text = textFromContent(message.content);
    if (text) parts.push({ text });
    parts.push(...imageParts(message.content));
    if (parts.length) contents.push({ role: "user", parts });
  }
  flushToolResponses();
  return { contents, systemText: systemText.join("\n\n") };
}

const MAX_SCHEMA_DEPTH = 16;

function resolveLocalSchemaRef(ref, root) {
  if (typeof ref !== "string" || !ref.startsWith("#/")) return undefined;
  let current = root;
  for (const rawSegment of ref.slice(2).split("/")) {
    if (!isPlainObject(current)) return undefined;
    const segment = rawSegment.replace(/~1/g, "/").replace(/~0/g, "~");
    current = current[segment];
  }
  return isPlainObject(current) ? current : undefined;
}

// Google accepts no JSON Schema references. Expand local references before
// removing `$defs`, otherwise a ref-rooted Codex tool silently becomes `{}`.
// A recursive reference cannot be represented by Google's protobuf Schema;
// retain its declared object shape at the cycle boundary instead of recursing.
function dereferenceAntigravitySchema(schema, root = schema, stack = new Set(), depth = 0) {
  if (!isPlainObject(schema) || depth > MAX_SCHEMA_DEPTH) return schema;
  let source = schema;
  let nextStack = stack;
  if (typeof schema.$ref === "string") {
    const resolved = resolveLocalSchemaRef(schema.$ref, root);
    if (resolved && !stack.has(schema.$ref)) {
      nextStack = new Set(stack);
      nextStack.add(schema.$ref);
      source = { ...resolved, ...schema };
      delete source.$ref;
    } else {
      source = { ...schema };
      delete source.$ref;
      if (resolved?.type === "object" || isPlainObject(resolved?.properties)) {
        source.type ||= "object";
      }
    }
  }

  const next = { ...source };
  for (const keyword of ["properties", "patternProperties", "$defs", "definitions"]) {
    if (!isPlainObject(source[keyword])) continue;
    next[keyword] = Object.fromEntries(
      Object.entries(source[keyword]).map(([name, child]) => [
        name,
        dereferenceAntigravitySchema(child, root, nextStack, depth + 1),
      ]),
    );
  }
  for (const keyword of [
    "items",
    "additionalProperties",
    "contains",
    "not",
    "if",
    "then",
    "else",
    "propertyNames",
  ]) {
    if (isPlainObject(source[keyword])) {
      next[keyword] = dereferenceAntigravitySchema(
        source[keyword],
        root,
        nextStack,
        depth + 1,
      );
    } else if (Array.isArray(source[keyword])) {
      next[keyword] = source[keyword].map((child) =>
        dereferenceAntigravitySchema(child, root, nextStack, depth + 1),
      );
    }
  }
  for (const keyword of ["anyOf", "oneOf", "allOf", "prefixItems"]) {
    if (!Array.isArray(source[keyword])) continue;
    next[keyword] = source[keyword].map((child) =>
      dereferenceAntigravitySchema(child, root, nextStack, depth + 1),
    );
  }
  return next;
}

const UNSUPPORTED_SCHEMA_KEYWORDS = Object.freeze([
  "$schema",
  "$id",
  "$anchor",
  "$dynamicAnchor",
  "$dynamicRef",
  "$comment",
  "$ref",
  "$defs",
  "definitions",
  "additionalProperties",
  "default",
  "examples",
  "title",
  "format",
  "pattern",
  "contentMediaType",
  "contentEncoding",
  "encrypted",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "minimum",
  "maximum",
  "multipleOf",
  "minLength",
  "maxLength",
  "minItems",
  "maxItems",
  "minProperties",
  "maxProperties",
  "minContains",
  "maxContains",
  "uniqueItems",
  "prefixItems",
  "patternProperties",
  "propertyNames",
  "contains",
  "not",
  "if",
  "then",
  "else",
  "dependentRequired",
  "dependentSchemas",
  "unevaluatedProperties",
  "unevaluatedItems",
  "readOnly",
  "writeOnly",
  "deprecated",
]);

// Antigravity's protobuf-backed schema layer rejects annotations and
// validation keywords that ordinary JSON Schema permits. This pass is pure:
// tool schemas are caller-owned objects and must never be mutated in place.
function cleanAntigravitySchema(schema, depth = 0) {
  if (!isPlainObject(schema) || depth > MAX_SCHEMA_DEPTH) return schema;
  const next = {};
  for (const [key, value] of Object.entries(schema)) {
    if (UNSUPPORTED_SCHEMA_KEYWORDS.includes(key)) continue;
    if (key === "const") {
      if (!Array.isArray(schema.enum)) next.enum = [value];
      continue;
    }
    if (["properties"].includes(key) && isPlainObject(value)) {
      next[key] = Object.fromEntries(
        Object.entries(value).map(([name, child]) => [
          name,
          cleanAntigravitySchema(child, depth + 1),
        ]),
      );
      continue;
    }
    if (["items"].includes(key) && isPlainObject(value)) {
      next[key] = cleanAntigravitySchema(value, depth + 1);
      continue;
    }
    if (["anyOf", "oneOf", "allOf"].includes(key) && Array.isArray(value)) {
      next[key] = value.map((child) => cleanAntigravitySchema(child, depth + 1));
      continue;
    }
    next[key] = value;
  }
  if (Array.isArray(next.type)) {
    next.type = next.type.find((type) => type !== "null") || next.type[0];
  }
  return next;
}

function antigravityToolSchema(schema) {
  const normalized = normalizeSchemaLiterals(schema);
  if (!isPlainObject(normalized)) return { type: "object", properties: {} };
  const dereferenced = dereferenceAntigravitySchema(normalized);
  // Flatten while definitions are still present and references are already
  // materialized; stripping first is what used to erase ref-heavy tools.
  const objectRoot = objectRootToolSchema(dereferenced);
  return cleanAntigravitySchema(objectRoot);
}

function antigravityToolName(name) {
  const cleaned = String(name || "")
    .replace(/[^a-zA-Z0-9_.:-]/g, "_")
    .replace(/^[^a-zA-Z_]+/, "");
  return cleaned || "tool";
}

function functionDeclarations(chat) {
  return (Array.isArray(chat.tools) ? chat.tools : [])
    .filter((tool) => tool?.type === "function" && tool.function?.name)
    .map((tool) => ({
      name: antigravityToolName(tool.function.name),
      description: tool.function.description,
      parameters: antigravityToolSchema(
        tool.function.parameters || { type: "object", properties: {} },
      ),
    }));
}

function modelFamily(model) {
  const value = String(model || "");
  for (const [base, family] of Object.entries(MODEL_FAMILIES)) {
    if (value === base) return { base, family, suffixEffort: undefined };
    for (const effort of Object.keys(family.models)) {
      if (value === `${base}-${effort}`) return { base, family, suffixEffort: effort };
    }
    if (value.startsWith(`${base}-`)) {
      return { base, family, suffixEffort: value.slice(base.length + 1) };
    }
  }
  return undefined;
}

function positiveTokenLimit(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? Math.floor(numeric) : undefined;
}

function resolveAntigravityModel(chat) {
  const requestedModel = String(chat?.model || "");
  const resolvedFamily = modelFamily(requestedModel);
  if (!resolvedFamily) {
    const callerLimit = positiveTokenLimit(
      chat?.max_completion_tokens ?? chat?.max_tokens,
    );
    return {
      model: requestedModel,
      effort: undefined,
      maxOutputTokens: callerLimit
        ? Math.min(callerLimit, DEFAULT_MAX_OUTPUT_TOKENS)
        : DEFAULT_MAX_OUTPUT_TOKENS,
    };
  }
  const { base, family, suffixEffort } = resolvedFamily;
  const effort = String(
    chat?.reasoning_effort || suffixEffort || family.defaultEffort,
  ).toLowerCase();
  if (!Object.hasOwn(family.models, effort)) {
    throw new AntigravityShapeError(
      `Reasoning effort ${JSON.stringify(effort)} is not supported by ${base}.`,
      { status: 400, code: "unsupported_reasoning_effort" },
    );
  }
  const callerLimit = positiveTokenLimit(chat?.max_completion_tokens ?? chat?.max_tokens);
  return {
    model: family.models[effort],
    effort,
    thinkingBudget: family.thinkingBudgets[effort],
    maxOutputTokens: callerLimit
      ? Math.min(callerLimit, family.maxOutputTokens)
      : family.maxOutputTokens,
  };
}

export function toAntigravityRequest(chat, { projectId = "", requestId = undefined } = {}) {
  foldInterveningAssistantMessages(chat?.messages);
  const { contents, systemText } = messagesToContents(chat?.messages || []);
  const resolved = resolveAntigravityModel(chat);
  const request = {
    contents,
    generationConfig: {
      maxOutputTokens: resolved.maxOutputTokens,
    },
  };
  if (systemText) {
    request.systemInstruction = { role: "user", parts: [{ text: systemText }] };
  }
  const genericEffort = EFFORT_BUDGET[chat?.reasoning_effort];
  if (Number.isFinite(resolved.thinkingBudget)) {
    request.generationConfig.thinkingConfig = {
      thinkingBudget: resolved.thinkingBudget,
      includeThoughts: true,
    };
  } else if (genericEffort) {
    request.generationConfig.thinkingConfig = {
      thinkingBudget: genericEffort,
      includeThoughts: true,
    };
  }
  const declarations = functionDeclarations(chat);
  if (declarations.length) {
    request.tools = [{ functionDeclarations: declarations }];
    request.toolConfig = { functionCallingConfig: { mode: "VALIDATED" } };
  }

  return {
    project: projectId || "",
    model: resolved.model,
    request,
    requestType: "agent",
    userAgent: "antigravity",
    requestId: requestId || `agent-${randomRequestId()}`,
  };
}

function randomRequestId() {
  return randomUUID();
}

// ---------------------------------------------------------------------------
// Response translation: Gemini `streamGenerateContent` SSE -> OpenAI Chat
// Completions chunks.

export function mapAntigravityUsage(usageMetadata) {
  if (!usageMetadata || typeof usageMetadata !== "object") return undefined;
  const finiteCount = (value) => {
    const numeric = Number(value ?? 0);
    return Number.isFinite(numeric) && numeric >= 0 ? numeric : 0;
  };
  const prompt = finiteCount(usageMetadata.promptTokenCount);
  const candidates = finiteCount(usageMetadata.candidatesTokenCount);
  const thoughts = finiteCount(usageMetadata.thoughtsTokenCount);
  const completion = candidates + thoughts;
  const computedTotal = prompt + completion;
  const reportedTotal = Number(usageMetadata.totalTokenCount);
  const usage = {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens:
      Number.isFinite(reportedTotal) && reportedTotal >= computedTotal
        ? reportedTotal
        : computedTotal,
  };
  const cached = Number(usageMetadata.cachedContentTokenCount);
  if (Number.isFinite(cached) && cached >= 0) {
    usage.prompt_tokens_details = { cached_tokens: cached };
  }
  if (thoughts > 0 || usageMetadata.thoughtsTokenCount !== undefined) {
    usage.completion_tokens_details = { reasoning_tokens: thoughts };
  }
  return usage;
}

export function createAntigravityTurnState() {
  return {
    contentText: "",
    reasoningText: "",
    toolCalls: [],
    toolByKey: new Map(),
    usage: undefined,
    finishReason: undefined,
    deltas: [],
    pendingThoughtSignature: undefined,
    sawCandidate: false,
    sawTerminal: false,
    sawMeaningfulOutput: false,
  };
}

function pushContentDelta(state, delta) {
  if (!delta) return;
  state.contentText += delta;
  state.deltas.push({ content: delta });
  state.sawMeaningfulOutput = true;
}

function pushReasoningDelta(state, delta) {
  if (!delta) return;
  state.reasoningText += delta;
  state.deltas.push({ reasoning_content: delta });
  state.sawMeaningfulOutput = true;
}

function ensureToolCall(state, call, thoughtSignature) {
  const rawId = splitThoughtSignature(call?.id).id;
  const signature = thoughtSignature || call?.thoughtSignature;
  // Google may omit functionCall.id. Two calls to the same function are still
  // distinct calls, so only a real upstream id is safe as a merge key.
  const key = rawId || undefined;
  let entry = key ? state.toolByKey.get(key) : undefined;
  if (!entry) {
    const id = rawId || `call_${randomUUID()}`;
    entry = {
      id: signedToolCallId(id, signature),
      type: "function",
      function: { name: call?.name || "", arguments: "" },
      ...(signature
        ? { provider_specific_fields: { thought_signature: signature } }
        : {}),
    };
    state.toolCalls.push(entry);
    if (key) state.toolByKey.set(key, entry);
    state.deltas.push({
      tool_calls: [
        {
          index: state.toolCalls.length - 1,
          id: entry.id,
          type: "function",
          function: { name: entry.function.name, arguments: "" },
        },
      ],
    });
  }
  if (call?.name) entry.function.name = call.name;
  if (signature && !entry.provider_specific_fields?.thought_signature) {
    entry.id = signedToolCallId(rawId || entry.id, signature);
    entry.provider_specific_fields = { thought_signature: signature };
  }
  if (isPlainObject(call?.args) || call?.args === undefined) {
    const serialized = JSON.stringify(isPlainObject(call?.args) ? call.args : {});
    if (serialized !== entry.function.arguments) {
      entry.function.arguments = serialized;
      state.deltas.push({
        tool_calls: [
          {
            index: state.toolCalls.indexOf(entry),
            function: { arguments: serialized },
          },
        ],
      });
    }
  }
  state.sawMeaningfulOutput = true;
  return entry;
}

function embeddedPayloadError(error) {
  if (!error || typeof error !== "object") return undefined;
  const upstreamStatus = Number(error.code ?? error.statusCode);
  const status =
    Number.isInteger(upstreamStatus) && upstreamStatus >= 400 && upstreamStatus <= 599
      ? upstreamStatus
      : 502;
  return new AntigravityShapeError(
    typeof error.message === "string" && error.message
      ? `Google Antigravity returned an embedded error: ${error.message}`
      : "Google Antigravity returned an embedded stream error.",
    { status, code: String(error.status || error.code || "antigravity_stream_error") },
  );
}

const CONTENT_FILTER_FINISH_REASONS = new Set([
  "SAFETY",
  "PROHIBITED_CONTENT",
  "RECITATION",
  "BLOCKLIST",
  "SPII",
  "IMAGE_SAFETY",
]);

// Applies one Gemini SSE `data:` payload. Parts arrive incrementally, so text
// parts append to the running candidate and functionCall parts merge by id.
export function applyAntigravitySsePayload(state, payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new AntigravityShapeError("Google Antigravity sent a malformed stream payload.");
  }
  const topLevelError = embeddedPayloadError(payload.error);
  if (topLevelError) throw topLevelError;
  const response =
    isPlainObject(payload.response) &&
    (payload.response.candidates !== undefined ||
      payload.response.usageMetadata !== undefined ||
      payload.response.promptFeedback !== undefined ||
      payload.response.error !== undefined)
      ? payload.response
      : payload;
  const responseError = embeddedPayloadError(response.error);
  if (responseError) throw responseError;
  const blockReason = response.promptFeedback?.blockReason;
  if (typeof blockReason === "string" && blockReason && blockReason !== "BLOCK_REASON_UNSPECIFIED") {
    throw new AntigravityShapeError(
      `Google Antigravity blocked the prompt (${blockReason}).`,
      { status: 400, code: "content_filter" },
    );
  }
  const candidates = Array.isArray(response.candidates) ? response.candidates : [];
  for (const candidate of candidates) {
    state.sawCandidate = true;
    const parts = Array.isArray(candidate?.content?.parts) ? candidate.content.parts : [];
    for (const part of parts) {
      if (!part || typeof part !== "object") continue;
      const partSignature =
        typeof part.thoughtSignature === "string" && part.thoughtSignature
          ? part.thoughtSignature
          : undefined;
      if (typeof part.text === "string" && part.text.length > 0) {
        if (part.thought === true) pushReasoningDelta(state, part.text);
        else pushContentDelta(state, part.text);
      }
      if (part.functionCall) {
        ensureToolCall(
          state,
          part.functionCall,
          partSignature || state.pendingThoughtSignature,
        );
        state.pendingThoughtSignature = undefined;
      } else if (
        partSignature &&
        part.thought === true &&
        (part.text === undefined || part.text === "")
      ) {
        state.pendingThoughtSignature = partSignature;
      }
    }
    if (typeof candidate.finishReason === "string") {
      state.finishReason = candidate.finishReason;
      state.sawTerminal = true;
    }
  }
  if (response.usageMetadata) {
    state.usage = mapAntigravityUsage(response.usageMetadata);
  }
  return state;
}

export function finalizeAntigravityTurn(state) {
  if (!state.sawCandidate) {
    throw new AntigravityShapeError(
      "Google Antigravity ended its stream without returning a candidate.",
      { code: "missing_candidate" },
    );
  }
  if (!state.sawTerminal) {
    throw new AntigravityShapeError(
      "Google Antigravity ended its stream before the candidate completed.",
      { code: "incomplete_stream" },
    );
  }
  const contentFiltered = CONTENT_FILTER_FINISH_REASONS.has(state.finishReason);
  if (!state.sawMeaningfulOutput && !contentFiltered) {
    throw new AntigravityShapeError(
      "Google Antigravity completed without returning output.",
      { code: "empty_response" },
    );
  }
  const finishReason = state.toolCalls.length
    ? "tool_calls"
    : state.finishReason === "MAX_TOKENS"
      ? "length"
      : contentFiltered
        ? "content_filter"
        : "stop";
  return {
    contentText: state.contentText,
    reasoningText: state.reasoningText,
    toolCalls: state.toolCalls,
    usage: state.usage,
    deltas: state.deltas,
    finishReason,
  };
}
