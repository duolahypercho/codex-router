/**
 * Capability-aware OpenAI protocol adapters.
 *
 * The router's normal routed path is Responses-shaped at the gateway and
 * LiteLLM performs the final provider translation.  These helpers keep the
 * protocol contract in one place for generic providers that opt in to an
 * explicit adapter/capability profile.  They are deliberately pure: a failed
 * capability conversion must never mutate the caller's replayable request.
 */

const DEFAULTS = Object.freeze({
  "openai-responses": Object.freeze({
    streaming: true,
    tools: true,
    parallelToolCalls: true,
    reasoning: "field-or-none",
    vision: true,
    webSearch: false,
    structuredOutput: true,
    maxOutputTokensField: "max_output_tokens",
  }),
  "openai-chat": Object.freeze({
    streaming: true,
    tools: true,
    parallelToolCalls: true,
    reasoning: "field-or-none",
    vision: true,
    webSearch: false,
    structuredOutput: true,
    maxOutputTokensField: "max_tokens",
  }),
});

function clone(value) {
  if (value === undefined) return value;
  // JSON is the wire format and this intentionally keeps the adapter's copy
  // limited to JSON values. structuredClone would preserve types a provider
  // cannot receive and would make malformed request fixtures less obvious.
  return JSON.parse(JSON.stringify(value));
}

function adapterId(value) {
  if (typeof value === "string") {
    if (value === "openai-responses" || value === "responses") return "openai-responses";
    return "openai-chat";
  }
  if (value?.adapter) return adapterId(value.adapter);
  if (value?.protocol === "openai-responses") return "openai-responses";
  return "openai-chat";
}

/** Return the normalized, conservative capability profile for an adapter. */
export function adapterCapabilities(adapter = "openai-chat", capabilities = {}) {
  const id = adapterId(adapter);
  const defaults = DEFAULTS[id];
  const supplied = capabilities && typeof capabilities === "object" && !Array.isArray(capabilities)
    ? capabilities
    : {};
  const result = { ...defaults, ...supplied };
  // An omitted capability is safe by default. A malformed value must not
  // accidentally grant a feature just because it is truthy.
  for (const key of ["streaming", "tools", "parallelToolCalls", "vision", "webSearch", "structuredOutput"]) {
    if (typeof result[key] !== "boolean") result[key] = Boolean(defaults[key]);
  }
  if (!["none", "field-or-none", "reasoning_effort", "thinking"].includes(result.reasoning)) {
    result.reasoning = defaults.reasoning;
  }
  if (!["max_tokens", "max_output_tokens", "none"].includes(result.maxOutputTokensField)) {
    result.maxOutputTokensField = defaults.maxOutputTokensField;
  }
  return Object.freeze(result);
}

function textPart(part, protocol) {
  if (!part || typeof part !== "object") return part;
  if (protocol === "openai-chat") {
    if (part.type === "input_text") return { ...part, type: "text" };
    if (part.type === "input_image") {
      const url = typeof part.image_url === "string" ? part.image_url : part.image_url?.url;
      return {
        type: "image_url",
        image_url: { url, ...(part.detail ? { detail: part.detail } : {}) },
      };
    }
  } else {
    if (part.type === "text") return { ...part, type: "input_text" };
    if (part.type === "image_url") {
      const url = typeof part.image_url === "string" ? part.image_url : part.image_url?.url;
      return {
        type: "input_image",
        image_url: url,
        ...(part.image_url?.detail || part.detail
          ? { detail: part.image_url?.detail || part.detail }
          : {}),
      };
    }
  }
  return part;
}

function normalizeContent(content, protocol) {
  if (!Array.isArray(content)) return content;
  return content.map((part) => textPart(part, protocol));
}

/** Convert Responses function tool definitions to Chat Completions shape. */
export function responsesToolsToChat(tools) {
  if (!Array.isArray(tools)) return tools;
  return tools.map((tool) => {
    if (!tool || tool.type !== "function" || tool.function) return clone(tool);
    const { name, description, parameters, strict } = tool;
    return {
      type: "function",
      function: {
        name,
        ...(description !== undefined ? { description } : {}),
        ...(parameters !== undefined ? { parameters } : {}),
        ...(strict !== undefined ? { strict } : {}),
      },
    };
  });
}

/** Convert Chat Completions function tool definitions to Responses shape. */
export function chatToolsToResponses(tools) {
  if (!Array.isArray(tools)) return tools;
  return tools.map((tool) => {
    if (!tool || tool.type !== "function" || !tool.function) return clone(tool);
    const fn = tool.function;
    return {
      type: "function",
      name: fn.name,
      ...(fn.description !== undefined ? { description: fn.description } : {}),
      ...(fn.parameters !== undefined ? { parameters: fn.parameters } : {}),
      ...(fn.strict !== undefined ? { strict: fn.strict } : {}),
    };
  });
}

function functionCallToChat(item) {
  const id = item.call_id || item.id;
  const name = item.name || item.function?.name;
  let args = item.arguments ?? item.function?.arguments ?? "{}";
  if (typeof args !== "string") args = JSON.stringify(args);
  return {
    role: "assistant",
    content: null,
    tool_calls: [{
      ...(id ? { id } : {}),
      type: "function",
      function: { name, arguments: args },
    }],
  };
}

/** Convert Responses `input` items into Chat Completions messages. */
export function responsesInputToChatMessages(input) {
  if (!Array.isArray(input)) return input;
  const messages = [];
  for (const item of input) {
    if (!item || typeof item !== "object") continue;
    if (item.type === "message") {
      messages.push({
        role: item.role || "user",
        content: normalizeContent(item.content, "openai-chat"),
        ...(item.name ? { name: item.name } : {}),
      });
      continue;
    }
    if (item.type === "function_call" || item.type === "custom_tool_call") {
      const previous = messages.at(-1);
      const call = functionCallToChat(item);
      if (
        previous?.role === "assistant" &&
        (Array.isArray(previous.tool_calls) || previous.reasoning_content !== undefined)
      ) {
        previous.tool_calls ||= [];
        previous.tool_calls.push(...call.tool_calls);
      } else {
        messages.push(call);
      }
      continue;
    }
    if (item.type === "function_call_output" || item.type === "custom_tool_call_output") {
      const output = item.output === undefined ? "" : typeof item.output === "string"
        ? item.output
        : JSON.stringify(item.output);
      messages.push({ role: "tool", tool_call_id: item.call_id || item.id, content: output });
      continue;
    }
    if (item.type === "reasoning") {
      const text = reasoningText(item);
      if (!text) continue;
      const previous = messages.at(-1);
      if (previous?.role === "assistant") previous.reasoning_content = text;
      else messages.push({ role: "assistant", content: null, reasoning_content: text });
    }
  }
  return messages;
}

function chatMessageToResponses(message) {
  const role = message.role || "user";
  const content = normalizeContent(message.content, "openai-responses");
  const output = [{
    type: "message",
    role,
    content: typeof content === "string"
      ? [{ type: "input_text", text: content }]
      : (content || []),
  }];
  if (message.reasoning_content) {
    output.unshift({
      type: "reasoning",
      summary: [{ type: "summary_text", text: message.reasoning_content }],
    });
  }
  for (const call of message.tool_calls || []) {
    const fn = call?.function || {};
    output.push({
      type: "function_call",
      call_id: call.id,
      name: fn.name,
      arguments: typeof fn.arguments === "string" ? fn.arguments : JSON.stringify(fn.arguments || {}),
    });
  }
  return output;
}

/** Convert Chat Completions messages to Responses `input` items. */
export function chatMessagesToResponsesInput(messages) {
  if (!Array.isArray(messages)) return messages;
  return messages.flatMap((message) => {
    if (!message || typeof message !== "object") return [];
    if (message.role === "tool") {
      return [{
        type: "function_call_output",
        call_id: message.tool_call_id,
        output: typeof message.content === "string" ? message.content : JSON.stringify(message.content ?? ""),
      }];
    }
    return chatMessageToResponses(message);
  });
}

function reasoningText(item) {
  if (typeof item?.reasoning_content === "string") return item.reasoning_content;
  if (typeof item?.content === "string") return item.content;
  const summary = item?.summary;
  if (Array.isArray(summary)) {
    return summary.map((part) => part?.text).filter((text) => typeof text === "string").join("\n");
  }
  return "";
}

function removeImages(value) {
  if (!Array.isArray(value)) return value;
  return value.flatMap((item) => {
    if (!item || typeof item !== "object") return [item];
    if (Array.isArray(item.content)) {
      const content = item.content.filter((part) => part?.type !== "image_url" && part?.type !== "input_image");
      return [{ ...item, content }];
    }
    if (item.type === "input_image" || item.type === "image_url") return [];
    return [item];
  });
}

function removeSearchTools(tools) {
  if (!Array.isArray(tools)) return tools;
  return tools.filter((tool) => !["web_search", "web_search_preview", "computer_use_preview"].includes(tool?.type));
}

/**
 * Omit fields that an explicit model capability profile says the upstream
 * cannot consume. The original payload is never modified.
 */
export function omitUnsupportedFields(payload, capabilities, adapter = "openai-chat") {
  const id = adapterId(adapter);
  const caps = adapterCapabilities(id, capabilities);
  const next = clone(payload) || {};
  if (!caps.streaming) delete next.stream;
  if (!caps.tools) {
    delete next.tools;
    delete next.tool_choice;
    delete next.parallel_tool_calls;
  } else if (!caps.parallelToolCalls) {
    delete next.parallel_tool_calls;
  }
  if (caps.reasoning === "none") {
    delete next.reasoning;
    delete next.reasoning_effort;
    delete next.thinking;
    delete next.think;
  }
  if (!caps.vision) {
    if (id === "openai-chat") next.messages = removeImages(next.messages);
    else next.input = removeImages(next.input);
  }
  if (!caps.webSearch) {
    delete next.web_search_options;
    if (Array.isArray(next.tools)) next.tools = removeSearchTools(next.tools);
  }
  if (!caps.structuredOutput) {
    delete next.response_format;
    delete next.text;
  }
  if (caps.maxOutputTokensField === "max_tokens" && next.max_output_tokens !== undefined) {
    next.max_tokens ??= next.max_output_tokens;
    delete next.max_output_tokens;
  } else if (caps.maxOutputTokensField === "max_output_tokens" && next.max_tokens !== undefined) {
    next.max_output_tokens ??= next.max_tokens;
    delete next.max_tokens;
  } else if (caps.maxOutputTokensField === "none") {
    delete next.max_tokens;
    delete next.max_output_tokens;
  }
  return next;
}

/** Normalize a request and translate its message/tool protocol. */
export function normalizeOpenAIRequest(payload, {
  adapter = "openai-chat",
  capabilities,
} = {}) {
  const id = adapterId(adapter);
  const next = clone(payload) || {};
  if (id === "openai-chat") {
    if (next.input !== undefined && next.messages === undefined) {
      next.messages = responsesInputToChatMessages(next.input);
      delete next.input;
    }
    if (next.tools) next.tools = responsesToolsToChat(next.tools);
  } else {
    if (next.messages !== undefined && next.input === undefined) {
      next.input = chatMessagesToResponsesInput(next.messages);
      delete next.messages;
    }
    if (next.tools) next.tools = chatToolsToResponses(next.tools);
    if (next.reasoning_effort !== undefined && next.reasoning === undefined) {
      next.reasoning = { effort: next.reasoning_effort };
    }
    delete next.reasoning_effort;
  }
  if (id === "openai-chat" && next.reasoning && next.reasoning_effort === undefined) {
    const effort = next.reasoning?.effort;
    if (effort) next.reasoning_effort = effort;
    delete next.reasoning;
  }
  return omitUnsupportedFields(next, capabilities, id);
}

/** Map a Responses SSE event to one or more Chat completion chunks. */
export function responsesEventToChatChunks(event, { id = "chatcmpl-router", model = "" } = {}) {
  if (!event || typeof event !== "object") return [];
  if (event.type === "response.output_text.delta") {
    return [{ id, object: "chat.completion.chunk", model, choices: [{ index: 0, delta: { content: event.delta || "" }, finish_reason: null }] }];
  }
  if (event.type === "response.reasoning_summary_text.delta" || event.type === "response.reasoning_text.delta") {
    return [{ id, object: "chat.completion.chunk", model, choices: [{ index: 0, delta: { reasoning_content: event.delta || "" }, finish_reason: null }] }];
  }
  if (event.type === "response.function_call_arguments.delta") {
    return [{ id, object: "chat.completion.chunk", model, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: event.call_id, type: "function", function: { name: event.name, arguments: event.delta || "" } }] }, finish_reason: null }] }];
  }
  if (event.type === "response.completed") {
    return [{ id, object: "chat.completion.chunk", model, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], ...(event.response?.usage ? { usage: event.response.usage } : {}) }];
  }
  return [];
}

/** Map a Chat completion stream chunk to Responses-compatible SSE events. */
export function chatChunkToResponsesEvents(chunk, { id = "resp_router", model = "" } = {}) {
  const choice = chunk?.choices?.[0];
  const delta = choice?.delta || {};
  const events = [];
  if (delta.content) events.push({ type: "response.output_text.delta", response_id: id, model, delta: delta.content });
  if (delta.reasoning_content) events.push({ type: "response.reasoning_summary_text.delta", response_id: id, model, delta: delta.reasoning_content });
  for (const call of delta.tool_calls || []) {
    const fn = call.function || {};
    events.push({ type: "response.function_call_arguments.delta", response_id: id, model, call_id: call.id, name: fn.name, delta: fn.arguments || "" });
  }
  if (choice?.finish_reason) events.push({ type: "response.completed", response: { id, model, status: "completed", usage: chunk.usage, output: [] } });
  return events;
}

export const OPENAI_ADAPTER_DEFAULTS = DEFAULTS;
