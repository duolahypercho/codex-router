import { randomUUID } from "node:crypto";

import { GenerateTranslator } from "./commandcode-stream.mjs";
import { directLoopbackFetch } from "./fetch-transport.mjs";
import {
  formatErrorChain,
  readRequestBody,
  writeJson,
} from "./http-utils.mjs";
import { claudeModelId, claudeRoutedSlug } from "./claude-model-id.mjs";

export const CLAUDE_ROUTE_PREFIX = "/anthropic";
const MAX_BODY_BYTES = 32 * 1024 * 1024;
const PING_INTERVAL_MS = 15_000;

export function isClaudeRoute(route) {
  return typeof route === "string" &&
    (route === CLAUDE_ROUTE_PREFIX || route.startsWith(`${CLAUDE_ROUTE_PREFIX}/`));
}

function publishedModels(routedModels) {
  const published = routedModels();
  const models = Array.isArray(published) ? published : published?.models;
  if (!Array.isArray(models)) return [];
  return models.filter((model) => model?.slug).map((model) => ({
    ...model,
    slug: String(model.slug),
    displayName: model.displayName || model.display_name || String(model.slug),
  }));
}

function assertPublishedModel(requested, routedModels) {
  const slug = claudeRoutedSlug(requested);
  if (!publishedModels(routedModels).some((model) => model.slug === slug)) {
    throw Object.assign(new Error(`${requested || "The requested model"} is not published to Claude Code.`), {
      status: 404,
      type: "not_found_error",
    });
  }
  return slug;
}

function jsonBody(buffer) {
  try {
    const payload = JSON.parse(buffer.toString("utf8"));
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error();
    return payload;
  } catch {
    throw Object.assign(new Error("Claude Code sent malformed JSON."), {
      status: 400,
      type: "invalid_request_error",
    });
  }
}

function textBlocks(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((part) => part?.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("\n");
}

function imageBlock(part) {
  if (part?.type !== "image" || !part.source) return undefined;
  if (part.source.type === "base64" && part.source.media_type && part.source.data) {
    return {
      type: "input_image",
      image_url: `data:${part.source.media_type};base64,${part.source.data}`,
    };
  }
  if (part.source.type === "url" && part.source.url) {
    return { type: "input_image", image_url: String(part.source.url) };
  }
  return undefined;
}

function inputTextPart(text) {
  return { type: "input_text", text: String(text || "") };
}

function messageContent(blocks) {
  const content = [];
  for (const part of blocks) {
    if (typeof part === "string") content.push(inputTextPart(part));
    else if (part?.type === "text") content.push(inputTextPart(part.text));
    else {
      const image = imageBlock(part);
      if (image) content.push(image);
    }
  }
  return content;
}

function toolResultOutput(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return JSON.stringify(content ?? "");
  return content.map((part) => {
    if (typeof part === "string") return part;
    if (part?.type === "text") return String(part.text || "");
    if (part?.type === "image") return "[Image returned by tool]";
    return JSON.stringify(part);
  }).join("\n");
}

function appendMessageInput(input, role, content) {
  if (!content.length) return;
  input.push({
    role: role === "assistant" ? "assistant" : "user",
    content,
  });
}

function anthropicMessagesInput(messages) {
  const input = [];
  for (const message of Array.isArray(messages) ? messages : []) {
    const role = message?.role === "assistant" ? "assistant" : "user";
    const blocks = typeof message?.content === "string"
      ? [{ type: "text", text: message.content }]
      : Array.isArray(message?.content) ? message.content : [];
    let pending = [];
    const flush = () => {
      appendMessageInput(input, role, messageContent(pending));
      pending = [];
    };
    for (const block of blocks) {
      if (block?.type === "tool_use" && block.name) {
        flush();
        input.push({
          type: "function_call",
          call_id: String(block.id || `call_${randomUUID().replaceAll("-", "")}`),
          name: String(block.name),
          arguments: JSON.stringify(block.input || {}),
        });
      } else if (block?.type === "tool_result" && block.tool_use_id) {
        flush();
        input.push({
          type: "function_call_output",
          call_id: String(block.tool_use_id),
          output: toolResultOutput(block.content),
        });
      } else if (!["thinking", "redacted_thinking"].includes(block?.type)) {
        pending.push(block);
      }
    }
    flush();
  }
  return input;
}

function responsesTools(tools) {
  if (!Array.isArray(tools)) return undefined;
  const converted = tools.flatMap((tool) => {
    if (!tool?.name) return [];
    return [{
      type: "function",
      name: String(tool.name),
      ...(tool.description ? { description: String(tool.description) } : {}),
      parameters: tool.input_schema || { type: "object", properties: {} },
      ...(typeof tool.strict === "boolean" ? { strict: tool.strict } : {}),
    }];
  });
  return converted.length ? converted : undefined;
}

function responsesToolChoice(choice) {
  if (!choice || choice.type === "auto") return "auto";
  if (choice.type === "none") return "none";
  if (choice.type === "any") return "required";
  if (choice.type === "tool" && choice.name) {
    return { type: "function", name: String(choice.name) };
  }
  return "auto";
}

function requestedEffort(payload) {
  const effort = payload?.output_config?.effort;
  if (["minimal", "low", "medium", "high", "xhigh", "max", "ultra"].includes(effort)) {
    return effort;
  }
  if (["adaptive", "enabled"].includes(payload?.thinking?.type)) return "high";
  return undefined;
}

export function claudeMessagesToResponses(payload) {
  const requestedModel = String(payload?.model || "");
  if (!requestedModel) {
    throw Object.assign(new Error("Claude Code did not name a model."), {
      status: 400,
      type: "invalid_request_error",
    });
  }
  const tools = responsesTools(payload.tools);
  const effort = requestedEffort(payload);
  const instructions = textBlocks(payload.system);
  return {
    model: claudeRoutedSlug(requestedModel),
    input: anthropicMessagesInput(payload.messages),
    ...(instructions ? { instructions } : {}),
    ...(Number.isFinite(Number(payload.max_tokens))
      ? { max_output_tokens: Math.max(1, Number(payload.max_tokens)) }
      : {}),
    ...(payload.temperature !== undefined ? { temperature: payload.temperature } : {}),
    ...(payload.top_p !== undefined ? { top_p: payload.top_p } : {}),
    ...(tools ? { tools } : {}),
    ...(payload.tool_choice ? { tool_choice: responsesToolChoice(payload.tool_choice) } : {}),
    ...(effort ? { reasoning: { effort, summary: "auto" } } : {}),
    stream: payload.stream === true,
  };
}

function outputTextParts(payload) {
  return (Array.isArray(payload?.output) ? payload.output : [])
    .filter((item) => item?.type === "message")
    .flatMap((item) => Array.isArray(item.content) ? item.content : [])
    .filter((part) => part?.type === "output_text" && typeof part.text === "string")
    .map((part) => ({ type: "text", text: part.text }));
}

function outputToolParts(payload) {
  return (Array.isArray(payload?.output) ? payload.output : [])
    .filter((item) => item?.type === "function_call" && item.name)
    .map((item) => {
      let input = {};
      try {
        input = JSON.parse(typeof item.arguments === "string" ? item.arguments : JSON.stringify(item.arguments || {}));
      } catch { /* malformed provider arguments remain an empty object */ }
      return {
        type: "tool_use",
        id: String(item.call_id || item.id || `call_${randomUUID().replaceAll("-", "")}`),
        name: String(item.name),
        input,
      };
    });
}

function anthropicUsage(usage = {}) {
  const cached = Number(usage.input_tokens_details?.cached_tokens || 0);
  return {
    input_tokens: Math.max(0, Number(usage.input_tokens || 0) - cached),
    output_tokens: Number(usage.output_tokens || 0),
    ...(cached ? { cache_read_input_tokens: cached } : {}),
  };
}

export function responsesToClaudeMessage(payload, requestedModel) {
  const content = [...outputTextParts(payload), ...outputToolParts(payload)];
  return {
    id: String(payload?.id || `msg_${randomUUID().replaceAll("-", "")}`),
    type: "message",
    role: "assistant",
    model: requestedModel,
    content,
    stop_reason: content.some((part) => part.type === "tool_use") ? "tool_use" :
      payload?.status === "incomplete" ? "max_tokens" : "end_turn",
    stop_sequence: null,
    usage: anthropicUsage(payload?.usage),
  };
}

function usageForTranslator(usage = {}) {
  return {
    inputTokens: Number(usage.input_tokens || 0),
    outputTokens: Number(usage.output_tokens || 0),
    totalTokens: Number(usage.total_tokens || 0),
    cachedInputTokens: Number(usage.input_tokens_details?.cached_tokens || 0),
    reasoningTokens: Number(usage.output_tokens_details?.reasoning_tokens || 0),
  };
}

async function* sseFrames(body) {
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true }).replaceAll("\r", "");
    let boundary = buffer.indexOf("\n\n");
    while (boundary !== -1) {
      const raw = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      const data = raw.split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).replace(/^ /, ""))
        .join("\n");
      if (data && data !== "[DONE]") {
        try { yield JSON.parse(data); } catch { /* the canonical path owns malformed-stream errors */ }
      }
      boundary = buffer.indexOf("\n\n");
    }
  }
}

function writeClaudeError(response, status, type, message) {
  writeJson(response, status, {
    type: "error",
    error: { type: type || "api_error", message },
  });
}

function transportRejected(request, response) {
  if (request.headers.origin || request.headers["sec-fetch-site"]) {
    writeClaudeError(response, 403, "permission_error", "Browser-originated requests are not accepted by the local model router.");
    return true;
  }
  const contentType = String(request.headers["content-type"] || "").split(";", 1)[0].trim().toLowerCase();
  if (contentType !== "application/json") {
    writeClaudeError(response, 415, "invalid_request_error", "Claude router requests require Content-Type: application/json.");
    return true;
  }
  return false;
}

async function upstreamError(upstream) {
  const text = await upstream.text();
  try {
    const parsed = JSON.parse(text);
    return {
      type: parsed?.error?.type || "api_error",
      message: parsed?.error?.message || parsed?.message || `The routed model returned HTTP ${upstream.status}.`,
    };
  } catch {
    return { type: "api_error", message: text || `The routed model returned HTTP ${upstream.status}.` };
  }
}

function streamEvent(response, translator, event, state) {
  const itemId = String(event.item_id ?? event.output_index ?? "output");
  if (event.type === "response.created") {
    response.write(translator.push({ type: "start" }));
    return;
  }
  if (event.type === "response.output_text.delta") {
    state.content = true;
    response.write(translator.push({ type: "text-delta", id: itemId, text: event.delta || "" }));
    return;
  }
  if (event.type === "response.output_text.done") {
    response.write(translator.push({ type: "text-end", id: itemId }));
    return;
  }
  if (event.type === "response.output_item.added" && event.item?.type === "function_call") {
    const id = String(event.item.call_id || event.item.id || itemId);
    state.tools.set(event.item.id || itemId, { id, name: event.item.name, deltas: false });
    state.content = true;
    response.write(translator.push({ type: "tool-input-start", id, toolName: event.item.name }));
    return;
  }
  if (event.type === "response.function_call_arguments.delta") {
    const tool = state.tools.get(event.item_id || itemId) || { id: itemId, name: "tool", deltas: false };
    tool.deltas = true;
    state.tools.set(event.item_id || itemId, tool);
    state.content = true;
    response.write(translator.push({ type: "tool-input-delta", id: tool.id, delta: event.delta || "" }));
    return;
  }
  if (event.type === "response.output_item.done" && event.item?.type === "function_call") {
    const tool = state.tools.get(event.item.id || itemId) || {
      id: String(event.item.call_id || event.item.id || itemId),
      name: event.item.name,
      deltas: false,
    };
    if (tool.deltas) response.write(translator.push({ type: "tool-input-end", id: tool.id }));
    else response.write(translator.push({
      type: "tool-call",
      toolCallId: tool.id,
      toolName: tool.name,
      input: (() => { try { return JSON.parse(event.item.arguments || "{}"); } catch { return {}; } })(),
    }));
    return;
  }
  if (event.type === "response.completed") {
    if (!state.content && event.response) {
      const fallback = responsesToClaudeMessage(event.response, state.requestedModel);
      for (const part of fallback.content) {
        if (part.type === "text") response.write(translator.push({ type: "text-delta", id: "fallback", text: part.text }));
        else response.write(translator.push({ type: "tool-call", toolCallId: part.id, toolName: part.name, input: part.input }));
      }
    }
    response.write(translator.push({
      type: "finish",
      finishReason: outputToolParts(event.response).length ? "tool-calls" : "stop",
      totalUsage: usageForTranslator(event.response?.usage),
    }));
    state.completed = true;
  }
}

async function handleStream(request, response, upstream, requestedModel) {
  response.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  });
  const translator = new GenerateTranslator({
    protocol: "anthropic",
    model: requestedModel,
    id: `msg_${randomUUID().replaceAll("-", "")}`,
  });
  const state = { content: false, completed: false, failed: false, requestedModel, tools: new Map() };
  const ping = setInterval(() => {
    if (!response.destroyed) response.write(`event: ping\ndata: ${JSON.stringify({ type: "ping" })}\n\n`);
  }, PING_INTERVAL_MS);
  ping.unref?.();
  try {
    for await (const event of sseFrames(upstream.body)) {
      if (["response.failed", "response.error", "error"].includes(event?.type)) {
        const message = event?.error?.message || event?.response?.error?.message || "The routed model failed.";
        response.write(`event: error\ndata: ${JSON.stringify({ type: "error", error: { type: "api_error", message } })}\n\n`);
        state.completed = true;
        state.failed = true;
        break;
      }
      streamEvent(response, translator, event, state);
    }
    if (!state.failed) response.write(translator.finish());
    response.end();
  } finally {
    clearInterval(ping);
  }
}

export async function handleClaudeRequest(request, response, route, { responsesUrl, routedModels }) {
  if (request.method === "HEAD" && route === `${CLAUDE_ROUTE_PREFIX}/api/hello`) {
    response.writeHead(200);
    response.end();
    return true;
  }
  if (request.method === "GET" && [
    `${CLAUDE_ROUTE_PREFIX}/models`,
    `${CLAUDE_ROUTE_PREFIX}/v1/models`,
  ].includes(route)) {
    writeJson(response, 200, {
      data: publishedModels(routedModels).map((model) => ({
        id: claudeModelId(model.slug),
        display_name: `${model.displayName} (Codex Router)`,
        type: "model",
        created_at: "1970-01-01T00:00:00Z",
      })),
      has_more: false,
      first_id: null,
      last_id: null,
    });
    return true;
  }
  const countTokens = request.method === "POST" && route === `${CLAUDE_ROUTE_PREFIX}/v1/messages/count_tokens`;
  const messages = request.method === "POST" && route === `${CLAUDE_ROUTE_PREFIX}/v1/messages`;
  if (!countTokens && !messages) return false;
  if (transportRejected(request, response)) return true;
  try {
    const body = jsonBody(await readRequestBody(request, { maxBytes: MAX_BODY_BYTES }));
    assertPublishedModel(body.model, routedModels);
    if (countTokens) {
      writeJson(response, 200, { input_tokens: Math.max(1, Math.ceil(Buffer.byteLength(JSON.stringify(body), "utf8") / 4)) });
      return true;
    }
    const requestedModel = String(body.model);
    const payload = claudeMessagesToResponses(body);
    payload.model = assertPublishedModel(payload.model, routedModels);
    const controller = new AbortController();
    request.once("aborted", () => controller.abort());
    const upstream = await directLoopbackFetch(responsesUrl, {
      method: "POST",
      headers: { "content-type": "application/json", accept: payload.stream ? "text/event-stream" : "application/json" },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    if (!upstream.ok) {
      const error = await upstreamError(upstream);
      writeClaudeError(response, upstream.status, error.type, error.message);
      return true;
    }
    if (payload.stream) await handleStream(request, response, upstream, requestedModel);
    else writeJson(response, 200, responsesToClaudeMessage(await upstream.json(), requestedModel));
  } catch (error) {
    if (!response.headersSent) {
      writeClaudeError(
        response,
        error?.status || 502,
        error?.type || "api_error",
        formatErrorChain(error),
      );
    } else if (!response.writableEnded) {
      response.end();
    }
  }
  return true;
}
