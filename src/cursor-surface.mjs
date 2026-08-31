import { randomUUID } from "node:crypto";
import {
  brotliDecompressSync,
  gunzipSync,
  inflateSync,
  zstdDecompressSync,
} from "node:zlib";

import { readRequestBody, writeJson } from "./http-utils.mjs";
import { directLoopbackFetch } from "./fetch-transport.mjs";
import {
  cursorCatalogSelections,
  cursorRoutedSlug,
  resolveCursorModel,
} from "./cursor-model-id.mjs";
import {
  bytesField,
  connectEnvelope,
  decodeConnectEnvelope,
  encodeDoubleField,
  encodeMessageField,
  encodeStringField,
  encodeVarintField,
  fieldValues,
  stringField,
  varintField,
} from "./protobuf-lite.mjs";

const CURSOR_APP_PREFIX = "/cursor";
const MAX_CURSOR_BODY_BYTES = 32 * 1024 * 1024;
const SESSION_TTL_MS = 5 * 60 * 1000;
const MAX_TOOL_ROUNDS = 32;

const CLI_RUN_PATH = "/agent.v1.AgentService/RunSSE";
const CLI_APPEND_PATH = "/aiserver.v1.BidiService/BidiAppend";
const CLI_USABLE_MODELS_PATHS = new Set([
  "/agent.v1.AgentService/GetUsableModels",
  "/aiserver.v1.AiService/GetUsableModels",
]);
const CLI_DEFAULT_MODEL_PATHS = new Set([
  "/agent.v1.AgentService/GetDefaultModelForCli",
  "/aiserver.v1.AiService/GetDefaultModelForCli",
]);

const sessions = new Map();

const CURSOR_LOCAL_TOOLS = [
  {
    type: "function",
    name: "read_file",
    description: "Read a text file from the local workspace. Cursor performs the read locally.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string" },
        offset: { type: "integer", minimum: 0 },
        limit: { type: "integer", minimum: 1 },
      },
      required: ["path"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "run_terminal_command",
    description: "Run a shell command in the local workspace through Cursor's permission-controlled executor.",
    parameters: {
      type: "object",
      properties: {
        command: { type: "string" },
        timeout: { type: "number", minimum: 0 },
      },
      required: ["command"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "edit_file",
    description: "Apply exact text replacements to a local file through Cursor's permission-controlled editor.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string" },
        edits: {
          type: "array",
          minItems: 1,
          items: {
            type: "object",
            properties: {
              old_text: { type: "string" },
              new_text: { type: "string" },
            },
            required: ["old_text", "new_text"],
            additionalProperties: false,
          },
        },
      },
      required: ["path", "edits"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "write_file",
    description: "Write complete content to a local file through Cursor's permission-controlled writer.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string" },
        content: { type: "string" },
      },
      required: ["path", "content"],
      additionalProperties: false,
    },
  },
];

const CURSOR_EXEC_TOOLS = new Map([
  ["read_file", { argsField: 45, resultField: 46, toolCallField: 61 }],
  ["run_terminal_command", { argsField: 46, resultField: 47, toolCallField: 62 }],
  ["edit_file", { argsField: 47, resultField: 48, toolCallField: 63 }],
  ["write_file", { argsField: 48, resultField: 49, toolCallField: 64 }],
]);

function repeatedBytes(buffer, number) {
  return fieldValues(buffer, number).filter(Buffer.isBuffer);
}

function messageField(buffer, number) {
  return bytesField(buffer, number);
}

function jsonBody(buffer) {
  try {
    return JSON.parse(buffer.toString("utf8"));
  } catch {
    const error = new Error("Cursor sent malformed JSON.");
    error.status = 400;
    throw error;
  }
}

function decodedRequestBody(buffer, headers) {
  const encoding = String(headers["content-encoding"] || "identity").trim().toLowerCase();
  if (!encoding || encoding === "identity") return buffer;
  if (encoding === "gzip") return gunzipSync(buffer, { maxOutputLength: MAX_CURSOR_BODY_BYTES });
  if (encoding === "deflate") return inflateSync(buffer, { maxOutputLength: MAX_CURSOR_BODY_BYTES });
  if (encoding === "br") return brotliDecompressSync(buffer, { maxOutputLength: MAX_CURSOR_BODY_BYTES });
  if (encoding === "zstd") return zstdDecompressSync(buffer, { maxOutputLength: MAX_CURSOR_BODY_BYTES });
  throw Object.assign(new Error(`Cursor used unsupported content encoding ${encoding}.`), { status: 415 });
}

function cursorModels(routedModels) {
  const published = routedModels();
  const models = Array.isArray(published) ? published : published?.models;
  if (!Array.isArray(models)) return [];
  return models.filter((model) => model?.slug).map((model) => ({
    ...model,
    slug: String(model.slug),
    displayName: model.displayName || model.display_name || String(model.slug),
  }));
}

function cursorSelections(routedModels) {
  return cursorCatalogSelections(cursorModels(routedModels));
}

function defaultCursorSelection(selections) {
  const ranked = [...selections].sort(
    (left, right) =>
      (right.model?.priority ?? 0) - (left.model?.priority ?? 0) ||
      left.slug.localeCompare(right.slug),
  );
  const model = ranked[0]?.model;
  return ranked.find((selection) =>
    selection.model === model && selection.effort === model?.defaultEffort
  ) || ranked.find((selection) => selection.model === model);
}

function assertRoutedCursorModel(model, routedModels) {
  const selection = resolveCursorModel(model, cursorModels(routedModels));
  if (!selection) {
    throw Object.assign(new Error(`${model || "The requested model"} is not published to Cursor.`), {
      status: 404,
    });
  }
  return selection;
}

function responseText(payload) {
  if (typeof payload?.output_text === "string") return payload.output_text;
  return (Array.isArray(payload?.output) ? payload.output : [])
    .filter((item) => item?.type === "message")
    .flatMap((item) => (Array.isArray(item?.content) ? item.content : []))
    .filter((content) => content?.type === "output_text" && typeof content.text === "string")
    .map((content) => content.text)
    .join("");
}

function responseToolCalls(payload) {
  return (Array.isArray(payload?.output) ? payload.output : [])
    .filter((item) => item?.type === "function_call" && item.name)
    .map((item) => ({
      id: item.call_id || item.id || `call_${randomUUID().replaceAll("-", "")}`,
      type: "function",
      function: {
        name: String(item.name),
        arguments: typeof item.arguments === "string" ? item.arguments : JSON.stringify(item.arguments || {}),
      },
    }));
}

function responsesUsage(payload) {
  const usage = payload?.usage || {};
  return {
    prompt_tokens: Number(usage.input_tokens || 0),
    completion_tokens: Number(usage.output_tokens || 0),
    total_tokens: Number(usage.total_tokens || usage.input_tokens || 0) +
      (usage.total_tokens ? 0 : Number(usage.output_tokens || 0)),
  };
}

function chatTools(tools) {
  if (!Array.isArray(tools)) return undefined;
  const converted = tools.flatMap((tool) => {
    if (tool?.type === "function" && tool.function?.name) {
      return [{
        type: "function",
        name: String(tool.function.name),
        description: tool.function.description,
        parameters: tool.function.parameters || { type: "object", properties: {} },
      }];
    }
    if (tool?.type === "function" && tool.name) return [tool];
    return [];
  });
  return converted.length ? converted : undefined;
}

function chatToolChoice(choice) {
  if (!choice || typeof choice === "string") return choice;
  if (choice.type === "function" && choice.function?.name) {
    return { type: "function", name: String(choice.function.name) };
  }
  return choice;
}

function textFromContent(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((part) => ["text", "input_text", "output_text"].includes(part?.type))
    .map((part) => part.text || "")
    .join("");
}

function userInputContent(content) {
  if (!Array.isArray(content)) return textFromContent(content);
  const hasImage = content.some((part) => ["image_url", "input_image"].includes(part?.type));
  if (!hasImage) return textFromContent(content);
  return content.flatMap((part) => {
    if (["text", "input_text"].includes(part?.type) && typeof part.text === "string") {
      return [{ type: "input_text", text: part.text }];
    }
    if (part?.type === "image_url") {
      const imageUrl = typeof part.image_url === "string" ? part.image_url : part.image_url?.url;
      return imageUrl ? [{
        type: "input_image",
        image_url: imageUrl,
        ...(part.image_url?.detail ? { detail: part.image_url.detail } : {}),
      }] : [];
    }
    if (part?.type === "input_image" && part.image_url) return [part];
    return [];
  });
}

// Cursor Agent builds an OpenAI-compatible request at its backend, but some
// releases put Responses fields on the chat-completions URL and others leave
// Anthropic tool blocks in `messages`. Normalize both shapes before re-entering
// the router's one canonical Responses path.
export function cursorChatToResponses(payload) {
  const model = cursorRoutedSlug(payload?.model);
  if (!model) throw Object.assign(new Error("Cursor did not name a model."), { status: 400 });
  const reasoning = payload?.reasoning?.effort
    ? payload.reasoning
    : payload?.reasoning_effort
      ? { effort: payload.reasoning_effort }
      : undefined;
  if (!Array.isArray(payload?.messages)) {
    const converted = {
      ...payload,
      model,
      stream: false,
      tools: chatTools(payload?.tools),
      ...(reasoning ? { reasoning } : {}),
    };
    delete converted.reasoning_effort;
    return converted;
  }

  const input = [];
  for (const message of payload.messages) {
    const role = message?.role;
    const blocks = Array.isArray(message?.content) ? message.content : [];
    const text = textFromContent(message?.content);
    if (role === "system" || role === "developer") continue;
    const messageContent = role === "assistant" ? text : userInputContent(message?.content);
    if ((Array.isArray(messageContent) && messageContent.length) || messageContent) {
      input.push({ role: role === "assistant" ? "assistant" : "user", content: messageContent });
    }
    for (const block of blocks) {
      if (role === "assistant" && block?.type === "tool_use" && block.name) {
        input.push({
          type: "function_call",
          call_id: block.id || `call_${randomUUID().replaceAll("-", "")}`,
          name: String(block.name),
          arguments: JSON.stringify(block.input || {}),
        });
      }
      if (block?.type === "tool_result" && block.tool_use_id) {
        input.push({
          type: "function_call_output",
          call_id: String(block.tool_use_id),
          output: textFromContent(block.content),
        });
      }
    }
    if (role === "tool" && message.tool_call_id) {
      input.push({
        type: "function_call_output",
        call_id: String(message.tool_call_id),
        output: textFromContent(message.content),
      });
    }
    if (role === "assistant" && Array.isArray(message.tool_calls)) {
      for (const call of message.tool_calls) {
        if (!call?.function?.name) continue;
        input.push({
          type: "function_call",
          call_id: call.id || `call_${randomUUID().replaceAll("-", "")}`,
          name: String(call.function.name),
          arguments: typeof call.function.arguments === "string"
            ? call.function.arguments
            : JSON.stringify(call.function.arguments || {}),
        });
      }
    }
  }
  const instructions = payload.messages
    .filter((message) => ["system", "developer"].includes(message?.role))
    .map((message) => textFromContent(message.content))
    .filter(Boolean)
    .join("\n\n");
  return {
    model,
    input,
    ...(instructions ? { instructions } : {}),
    ...(payload.max_tokens || payload.max_completion_tokens
      ? { max_output_tokens: payload.max_completion_tokens || payload.max_tokens }
      : {}),
    ...(payload.temperature !== undefined ? { temperature: payload.temperature } : {}),
    ...(reasoning ? { reasoning } : {}),
    ...(chatTools(payload.tools) ? { tools: chatTools(payload.tools) } : {}),
    ...(payload.tool_choice !== undefined ? { tool_choice: chatToolChoice(payload.tool_choice) } : {}),
    stream: false,
  };
}

function chatCompletion(payload, requestedModel) {
  const toolCalls = responseToolCalls(payload);
  return {
    id: payload?.id || `chatcmpl_${randomUUID().replaceAll("-", "")}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: requestedModel,
    choices: [{
      index: 0,
      message: {
        role: "assistant",
        content: responseText(payload) || null,
        ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
      },
      finish_reason: toolCalls.length ? "tool_calls" : "stop",
    }],
    usage: responsesUsage(payload),
  };
}

function writeChatStream(response, completion) {
  response.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
  const message = completion.choices[0].message;
  const chunk = {
    id: completion.id,
    object: "chat.completion.chunk",
    created: completion.created,
    model: completion.model,
    choices: [{
      index: 0,
      delta: {
        role: "assistant",
        ...(message.content ? { content: message.content } : {}),
        ...(message.tool_calls ? { tool_calls: message.tool_calls.map((call, index) => ({ index, ...call })) } : {}),
      },
      finish_reason: completion.choices[0].finish_reason,
    }],
  };
  response.write(`data: ${JSON.stringify(chunk)}\n\n`);
  response.end("data: [DONE]\n\n");
}

async function callResponses(responsesUrl, payload, signal) {
  const upstream = await directLoopbackFetch(responsesUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
    signal,
  });
  const text = await upstream.text();
  let parsed;
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch {
    parsed = { error: { type: "cursor_upstream_decode_error", message: "The routed response was not JSON." } };
  }
  if (!upstream.ok) {
    const error = new Error(parsed?.error?.message || `The routed model returned HTTP ${upstream.status}.`);
    error.status = upstream.status;
    error.payload = parsed;
    throw error;
  }
  return parsed;
}

async function handleCursorApp(request, response, route, { responsesUrl, routedModels }) {
  if (request.method === "GET" && ["/cursor/models", "/cursor/v1/models"].includes(route)) {
    const data = cursorSelections(routedModels).map((selection) => ({
      id: selection.alias,
      object: "model",
      owned_by: "codex-router",
    }));
    writeJson(response, 200, { object: "list", data });
    return true;
  }
  if (request.method !== "POST" || !["/cursor/chat/completions", "/cursor/v1/chat/completions"].includes(route)) {
    return false;
  }
  const encoded = await readRequestBody(request, { maxBytes: MAX_CURSOR_BODY_BYTES });
  const body = jsonBody(decodedRequestBody(encoded, request.headers));
  const requestedModel = String(body.model || "");
  const selection = assertRoutedCursorModel(requestedModel, routedModels);
  const payload = cursorChatToResponses({ ...body, model: selection.slug });
  if (selection.effort) {
    payload.reasoning = { ...(payload.reasoning || {}), effort: selection.effort };
  }
  const controller = new AbortController();
  request.once("aborted", () => controller.abort());
  try {
    const result = await callResponses(responsesUrl, payload, controller.signal);
    const completion = chatCompletion(result, requestedModel);
    if (body.stream === false) writeJson(response, 200, completion);
    else writeChatStream(response, completion);
  } catch (error) {
    writeJson(response, error.status || 502, error.payload || {
      error: { type: "cursor_router_error", message: error.message },
    });
  }
  return true;
}

function modelDetails(selection) {
  const id = selection.alias;
  const displayName = selection.displayName || selection.model?.displayName || selection.slug;
  return Buffer.concat([
    encodeStringField(1, id),
    encodeStringField(3, id),
    encodeStringField(4, `${displayName} (Codex Router)`),
    encodeStringField(5, `${displayName} (Codex Router)`),
    encodeStringField(6, id),
  ]);
}

function usableModels(models) {
  return Buffer.concat(models.map((model) => encodeMessageField(1, modelDetails(model))));
}

function defaultModel(model) {
  return model ? encodeMessageField(1, modelDetails(model)) : Buffer.alloc(0);
}

function writeProto(response, payload = Buffer.alloc(0)) {
  response.writeHead(200, {
    "content-type": "application/proto",
    "connect-protocol-version": "1",
  });
  response.end(payload);
}

function jwt() {
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "none", typ: "JWT" })}.${encode({ sub: "codex-router", exp: 4_102_444_800 })}.`;
}

function cursorHistory(history) {
  if (!history) return [];
  const input = [];
  for (const wrapper of repeatedBytes(history, 1)) {
    const user = messageField(wrapper, 1);
    const assistant = messageField(wrapper, 2);
    const tool = messageField(wrapper, 3);
    if (user) {
      const text = repeatedBytes(user, 1)
        .map((content) => messageField(content, 1))
        .filter(Boolean)
        .map((content) => stringField(content, 1) || "")
        .join("");
      if (text) input.push({ role: "user", content: text });
    }
    if (assistant) {
      let text = "";
      for (const content of repeatedBytes(assistant, 1)) {
        const textContent = messageField(content, 1);
        const call = messageField(content, 4);
        if (textContent) text += stringField(textContent, 1) || "";
        if (call) input.push({
          type: "function_call",
          call_id: stringField(call, 1) || `call_${randomUUID().replaceAll("-", "")}`,
          name: stringField(call, 2) || "unknown",
          arguments: stringField(call, 3) || "{}",
        });
      }
      if (text) input.push({ role: "assistant", content: text });
    }
    if (tool) {
      const output = repeatedBytes(tool, 3)
        .map((content) => messageField(content, 1))
        .filter(Boolean)
        .map((content) => stringField(content, 1) || "")
        .join("");
      input.push({
        type: "function_call_output",
        call_id: stringField(tool, 1) || "unknown",
        output,
      });
    }
  }
  return input;
}

function cursorAgentTools(tools) {
  // Cursor's MCP executor has a separate typed argument/result protocol. Do
  // not advertise those declarations until that protocol is mapped; the four
  // built-ins below are executed by Cursor itself and retain its permissions.
  void tools;
  return CURSOR_LOCAL_TOOLS;
}

export function cursorAgentRunRequest(clientMessage) {
  const run = messageField(clientMessage, 1);
  if (!run) return undefined;
  const requested = messageField(run, 9);
  const details = messageField(run, 3);
  const model = stringField(requested || Buffer.alloc(0), 1) ||
    stringField(details || Buffer.alloc(0), 1);
  const action = messageField(run, 2);
  const userAction = action && messageField(action, 1);
  const userMessage = userAction && messageField(userAction, 1);
  const prompt = userMessage && stringField(userMessage, 1);
  const input = userAction ? cursorHistory(messageField(userAction, 7)) : [];
  if (userAction) {
    for (const prepended of repeatedBytes(userAction, 4)) {
      const text = stringField(prepended, 1);
      if (text) input.push({ role: "user", content: text });
    }
  }
  if (prompt) input.push({ role: "user", content: prompt });
  return {
    model,
    input,
    instructions: stringField(run, 8) || undefined,
    tools: cursorAgentTools(messageField(run, 4)),
    stream: false,
  };
}

function requiredString(value, name) {
  if (typeof value !== "string" || !value.length) {
    throw new Error(`Cursor tool argument ${name} must be a non-empty string.`);
  }
  return value;
}

function stringValue(value, name) {
  if (typeof value !== "string") {
    throw new Error(`Cursor tool argument ${name} must be a string.`);
  }
  return value;
}

function optionalUnsignedInteger(value, name, { minimum = 0 } = {}) {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new Error(`Cursor tool argument ${name} must be an integer of at least ${minimum}.`);
  }
  return value;
}

function cursorExecArgs(toolCall) {
  let args;
  try {
    args = JSON.parse(toolCall.function.arguments || "{}");
  } catch {
    throw new Error(`${toolCall.function.name} received malformed JSON arguments.`);
  }
  if (!args || typeof args !== "object" || Array.isArray(args)) {
    throw new Error(`${toolCall.function.name} arguments must be an object.`);
  }
  switch (toolCall.function.name) {
    case "read_file": {
      const fields = [encodeStringField(1, requiredString(args.path, "path"))];
      const offset = optionalUnsignedInteger(args.offset, "offset");
      const limit = optionalUnsignedInteger(args.limit, "limit", { minimum: 1 });
      if (offset !== undefined) fields.push(encodeVarintField(2, offset));
      if (limit !== undefined) fields.push(encodeVarintField(3, limit));
      return Buffer.concat(fields);
    }
    case "run_terminal_command": {
      const fields = [encodeStringField(1, requiredString(args.command, "command"))];
      if (args.timeout !== undefined) {
        const timeout = Number(args.timeout);
        if (!Number.isFinite(timeout) || timeout < 0) {
          throw new Error("Cursor tool argument timeout must be a non-negative number.");
        }
        fields.push(encodeDoubleField(2, timeout));
      }
      return Buffer.concat(fields);
    }
    case "edit_file": {
      if (!Array.isArray(args.edits) || !args.edits.length) {
        throw new Error("Cursor tool argument edits must be a non-empty array.");
      }
      const fields = [encodeStringField(1, requiredString(args.path, "path"))];
      for (const edit of args.edits) {
        if (!edit || typeof edit !== "object" || Array.isArray(edit)) {
          throw new Error("Every Cursor edit must be an object.");
        }
        fields.push(encodeMessageField(2, Buffer.concat([
          encodeStringField(1, stringValue(edit.old_text, "edits[].old_text")),
          encodeStringField(2, stringValue(edit.new_text, "edits[].new_text")),
        ])));
      }
      return Buffer.concat(fields);
    }
    case "write_file":
      return Buffer.concat([
        encodeStringField(1, requiredString(args.path, "path")),
        encodeStringField(2, stringValue(args.content, "content")),
      ]);
    default:
      throw new Error(`${toolCall.function.name} is not a Cursor local-execution tool.`);
  }
}

function cursorToolCallMessage(toolCall, args, result) {
  const mapping = CURSOR_EXEC_TOOLS.get(toolCall.function.name);
  const typedCall = Buffer.concat([
    encodeMessageField(1, args),
    ...(result ? [encodeMessageField(2, result)] : []),
  ]);
  return Buffer.concat([
    encodeMessageField(mapping.toolCallField, typedCall),
    encodeStringField(57, toolCall.id),
  ]);
}

function cursorToolUpdate(field, toolCall, args, result) {
  const update = Buffer.concat([
    encodeStringField(1, toolCall.id),
    encodeMessageField(2, cursorToolCallMessage(toolCall, args, result)),
  ]);
  return encodeMessageField(1, encodeMessageField(field, update));
}

function cursorExecServerMessage(id, toolCall, args) {
  const mapping = CURSOR_EXEC_TOOLS.get(toolCall.function.name);
  const exec = Buffer.concat([
    encodeVarintField(1, id),
    encodeStringField(15, toolCall.id),
    encodeMessageField(mapping.argsField, args),
  ]);
  return encodeMessageField(2, exec);
}

function cursorExecClientMessage(clientMessage) {
  const exec = messageField(clientMessage, 2);
  if (!exec) return undefined;
  const id = varintField(exec, 1);
  if (id === undefined) return undefined;
  return { id: Number(id), exec };
}

function cursorExecClientError(clientMessage) {
  const control = messageField(clientMessage, 5);
  const thrown = control && messageField(control, 2);
  if (!thrown) return undefined;
  const id = varintField(thrown, 1);
  if (id === undefined) return undefined;
  return { id: Number(id), error: stringField(thrown, 2) || "Cursor's local executor failed." };
}

function cursorExecOutput(toolCall, exec) {
  const mapping = CURSOR_EXEC_TOOLS.get(toolCall.function.name);
  const result = messageField(exec, mapping.resultField);
  if (!result) throw new Error(`Cursor returned no ${toolCall.function.name} result.`);
  const success = messageField(result, 1);
  const error = messageField(result, 2);
  const rejected = messageField(result, 3);
  if (error) return { result, output: `Error: ${stringField(error, 1) || "The local tool failed."}` };
  if (rejected) return { result, output: `Rejected: ${stringField(rejected, 1) || "The local tool was rejected."}` };
  if (!success) return { result, output: "The local tool returned no result." };
  if (toolCall.function.name === "edit_file") {
    return {
      result,
      output: [stringField(success, 1), stringField(success, 2)].filter(Boolean).join("\n"),
    };
  }
  return { result, output: stringField(success, 1) || "The local tool completed successfully." };
}

function textUpdate(text) {
  const delta = encodeStringField(1, text);
  const update = encodeMessageField(1, delta);
  return encodeMessageField(1, update);
}

function turnEnded(usage) {
  const fields = [];
  if (usage?.input_tokens !== undefined) fields.push(encodeVarintField(1, usage.input_tokens));
  if (usage?.output_tokens !== undefined) fields.push(encodeVarintField(2, usage.output_tokens));
  if (usage?.input_tokens_details?.cached_tokens !== undefined) {
    fields.push(encodeVarintField(3, usage.input_tokens_details.cached_tokens));
  }
  if (usage?.output_tokens_details?.reasoning_tokens !== undefined) {
    fields.push(encodeVarintField(5, usage.output_tokens_details.reasoning_tokens));
  }
  const update = encodeMessageField(14, Buffer.concat(fields));
  return encodeMessageField(1, update);
}

function writeConnectMessage(response, payload) {
  response.write(connectEnvelope(payload));
}

function endConnect(response, error) {
  const payload = error
    ? { error: { code: "internal", message: error.message || "The routed model failed." } }
    : {};
  response.end(connectEnvelope(Buffer.from(JSON.stringify(payload)), 2));
}

function requestIdFromRunBody(body) {
  const envelope = decodeConnectEnvelope(body);
  return stringField(envelope.payload, 1);
}

function appendPayload(body) {
  const requestIdMessage = messageField(body, 2);
  const requestId = requestIdMessage && stringField(requestIdMessage, 1);
  const binary = messageField(body, 4);
  const hex = stringField(body, 1);
  let payload = binary;
  if (!payload && hex) {
    if (!/^(?:[0-9a-fA-F]{2})+$/.test(hex)) throw new Error("Cursor sent malformed hex protobuf data.");
    payload = Buffer.from(hex, "hex");
  }
  return { requestId, payload, seqno: varintField(body, 3) || 0n };
}

function sessionFor(requestId) {
  let session = sessions.get(requestId);
  if (session) return session;
  session = {
    requestId,
    payloads: new Map(),
    response: undefined,
    running: false,
    nextExecId: 1,
    pendingExecs: new Map(),
  };
  session.timer = setTimeout(() => {
    if (session.response && !session.response.writableEnded) {
      endConnect(session.response, new Error("Cursor did not finish uploading its request."));
    }
    finishSession(session);
  }, SESSION_TTL_MS);
  session.timer.unref?.();
  sessions.set(requestId, session);
  return session;
}

function finishSession(session) {
  clearTimeout(session.timer);
  sessions.delete(session.requestId);
  for (const pending of session.pendingExecs.values()) {
    pending.reject(new Error("Cursor closed the local-execution stream."));
  }
  session.pendingExecs.clear();
}

function receiveCursorClientMessage(session, payload) {
  const failure = cursorExecClientError(payload);
  if (failure) {
    const pending = session.pendingExecs.get(failure.id);
    if (pending) {
      session.pendingExecs.delete(failure.id);
      pending.reject(new Error(failure.error));
    }
    return true;
  }
  const message = cursorExecClientMessage(payload);
  if (!message) return false;
  const pending = session.pendingExecs.get(message.id);
  if (pending) {
    session.pendingExecs.delete(message.id);
    pending.resolve(message.exec);
  }
  return true;
}

function cursorExecution(session, toolCall) {
  const args = cursorExecArgs(toolCall);
  const id = session.nextExecId;
  session.nextExecId += 1;
  const result = new Promise((resolve, reject) => {
    session.pendingExecs.set(id, { resolve, reject });
  });
  writeConnectMessage(session.response, cursorToolUpdate(2, toolCall, args));
  writeConnectMessage(session.response, cursorExecServerMessage(id, toolCall, args));
  return result.then((exec) => {
    const completed = cursorExecOutput(toolCall, exec);
    writeConnectMessage(session.response, cursorToolUpdate(3, toolCall, args, completed.result));
    return completed.output;
  });
}

function addUsage(total, usage = {}) {
  total.input_tokens += Number(usage.input_tokens || 0);
  total.output_tokens += Number(usage.output_tokens || 0);
  total.input_tokens_details.cached_tokens += Number(usage.input_tokens_details?.cached_tokens || 0);
  total.output_tokens_details.reasoning_tokens += Number(usage.output_tokens_details?.reasoning_tokens || 0);
}

async function maybeRunSession(session, responsesUrl, routedModels) {
  if (session.running || !session.response || !session.payloads.size) return;
  const request = [...session.payloads.entries()]
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([, payload]) => cursorAgentRunRequest(payload))
    .find(Boolean);
  if (!request) return;
  session.running = true;
  try {
    if (!request.model) throw Object.assign(new Error("Cursor did not select a routed model."), { status: 400 });
    const selection = assertRoutedCursorModel(request.model, routedModels);
    request.model = selection.slug;
    if (selection.effort) {
      request.reasoning = { ...(request.reasoning || {}), effort: selection.effort };
    }
    const usage = {
      input_tokens: 0,
      output_tokens: 0,
      input_tokens_details: { cached_tokens: 0 },
      output_tokens_details: { reasoning_tokens: 0 },
    };
    let completed = false;
    for (let round = 0; round < MAX_TOOL_ROUNDS; round += 1) {
      const result = await callResponses(responsesUrl, {
        ...request,
        ...(request.instructions ? {} : { instructions: "You are responding through Cursor Agent CLI." }),
      });
      addUsage(usage, result.usage);
      const text = responseText(result);
      if (text) writeConnectMessage(session.response, textUpdate(text));
      const toolCalls = responseToolCalls(result);
      if (!toolCalls.length) {
        completed = true;
        break;
      }
      request.input.push(...toolCalls.map((toolCall) => ({
        type: "function_call",
        call_id: toolCall.id,
        name: toolCall.function.name,
        arguments: toolCall.function.arguments,
      })));
      for (const toolCall of toolCalls) {
        if (!CURSOR_EXEC_TOOLS.has(toolCall.function.name)) {
          throw new Error(`The routed model called unsupported Cursor tool ${toolCall.function.name}.`);
        }
        const output = await cursorExecution(session, toolCall);
        request.input.push({ type: "function_call_output", call_id: toolCall.id, output });
      }
    }
    if (!completed) throw new Error(`Cursor exceeded ${MAX_TOOL_ROUNDS} local tool rounds.`);
    writeConnectMessage(session.response, turnEnded(usage));
    endConnect(session.response);
  } catch (error) {
    console.error(
      `[codex-router] Cursor CLI turn failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    endConnect(session.response, error);
  } finally {
    finishSession(session);
  }
}

async function handleCursorCli(request, response, route, { responsesUrl, routedModels }) {
  if (request.method === "POST" && ["/auth/exchange_user_api_key", "/auth/refresh"].includes(route)) {
    const token = jwt();
    writeJson(response, 200, { accessToken: token, refreshToken: token });
    return true;
  }
  if (request.method !== "POST") return false;
  const models = cursorModels(routedModels);
  const selections = cursorCatalogSelections(models);
  if (CLI_USABLE_MODELS_PATHS.has(route)) {
    writeProto(response, usableModels(selections));
    return true;
  }
  if (CLI_DEFAULT_MODEL_PATHS.has(route)) {
    writeProto(response, defaultModel(defaultCursorSelection(selections)));
    return true;
  }
  if (route === "/aiserver.v1.ServerConfigService/GetServerConfig") {
    // Http2Config.FORCE_ALL_DISABLED. Cursor otherwise attempts h2c on the same
    // URL it just used over HTTP/1 for auth and catalog requests.
    writeProto(response, encodeVarintField(7, 1));
    return true;
  }
  if (route === CLI_RUN_PATH) {
    const encoded = await readRequestBody(request, { maxBytes: MAX_CURSOR_BODY_BYTES });
    const body = decodedRequestBody(encoded, request.headers);
    const requestId = requestIdFromRunBody(body);
    if (!requestId) throw Object.assign(new Error("Cursor omitted its request ID."), { status: 400 });
    response.writeHead(200, {
      "content-type": "application/connect+proto",
      "connect-protocol-version": "1",
      "cache-control": "no-cache",
    });
    const session = sessionFor(requestId);
    session.response = response;
    response.once("close", () => {
      if (!response.writableEnded) finishSession(session);
    });
    void maybeRunSession(session, responsesUrl, routedModels);
    return true;
  }
  if (route === CLI_APPEND_PATH) {
    const encoded = await readRequestBody(request, { maxBytes: MAX_CURSOR_BODY_BYTES });
    const body = decodedRequestBody(encoded, request.headers);
    const append = appendPayload(body);
    if (!append.requestId || !append.payload) {
      throw Object.assign(new Error("Cursor sent an incomplete BidiAppend request."), { status: 400 });
    }
    const session = sessionFor(append.requestId);
    if (!receiveCursorClientMessage(session, append.payload)) {
      session.payloads.set(append.seqno, append.payload);
    }
    writeProto(response);
    void maybeRunSession(session, responsesUrl, routedModels);
    return true;
  }

  // The CLI asks a number of optional dashboard, telemetry, and configuration
  // RPCs before a turn. Empty protobuf messages are their backward-compatible
  // "not configured" value. JSON telemetry receives an empty JSON object.
  const contentType = String(request.headers["content-type"] || "").toLowerCase();
  if (contentType.includes("json")) writeJson(response, 200, {});
  else writeProto(response);
  return true;
}

export function isCursorRoute(route) {
  return route.startsWith(`${CURSOR_APP_PREFIX}/`) ||
    route.startsWith("/auth/") ||
    route.startsWith("/agent.v1.") ||
    route.startsWith("/aiserver.v1.") ||
    route === "/v1/traces";
}

export async function handleCursorRequest(request, response, route, options) {
  if (route.startsWith(`${CURSOR_APP_PREFIX}/`)) {
    return handleCursorApp(request, response, route, options);
  }
  return handleCursorCli(request, response, route, options);
}
