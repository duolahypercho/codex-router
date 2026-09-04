import { Transform } from "node:stream";

const RESPONSE_PROTOCOL = "openai-responses";
const NAMESPACE_DELIMITER = "__";

// Known collaboration namespaces that require restoration. This is the exact
// set of v1/v2 native collaboration tools that Codex flattens and expects to
// see restored. MCP tools (mcp__*) are never restored here - they follow a
// different flatten contract and are handled by namespace-relay.mjs.
const COLLABORATION_NAMESPACES = new Set([
  "multi_agent_v1",
  "collaboration", // v2 native collaboration namespace
]);

// Build a lookup map from flattened collaboration tool names back to their
// native namespaced form. Only restores tools from actual type: "namespace"
// entries in the request, or known collaboration namespaces. This prevents
// false positives like treating "mcp__node_repl__js" as a collaboration tool.
export function buildNamespaceLookupsFromTools(tools) {
  const flatToNative = new Map();
  if (!Array.isArray(tools)) return flatToNative;
  
  // First, collect namespace tools to build the authoritative mapping
  const namespaceTools = new Map();
  for (const tool of tools) {
    if (!tool || typeof tool !== "object" || Array.isArray(tool)) continue;
    
    if (tool.type === "namespace" && typeof tool.name === "string" && Array.isArray(tool.tools)) {
      // This is a type: "namespace" entry, record all its child tools
      for (const child of tool.tools) {
        if (child?.type !== "function" || typeof child.name !== "string" || !child.name) continue;
        const flattenedName = `${tool.name}${NAMESPACE_DELIMITER}${child.name}`;
        namespaceTools.set(flattenedName, { namespace: tool.name, name: child.name });
      }
    }
  }
  
  // Namespace containers alone are enough to restore calls (Responses-native
  // providers keep that shape). Seed the map before scanning flat functions.
  for (const [flattenedName, native] of namespaceTools) {
    flatToNative.set(flattenedName, native);
    const dotted = `${native.namespace}.${native.name}`;
    if (!flatToNative.has(dotted)) flatToNative.set(dotted, native);
  }

  // Second pass: look for flattened function names
  for (const tool of tools) {
    if (!tool || typeof tool !== "object" || Array.isArray(tool)) continue;
    if (tool.type === "namespace") continue; // Skip namespace containers
    
    // Extract function name from either Responses format (tool.name) or 
    // Chat Completions format (tool.function.name)
    const functionName = tool.name || tool.function?.name;
    if (typeof functionName !== "string" || !functionName) continue;
    
    // Check if this looks like a flattened name
    const delimiterIndex = functionName.indexOf(NAMESPACE_DELIMITER);
    if (delimiterIndex === -1) continue;
    
    // If this name was from a namespace tool, use that mapping
    if (namespaceTools.has(functionName)) {
      flatToNative.set(functionName, namespaceTools.get(functionName));
      continue;
    }
    
    // Otherwise, only restore known collaboration namespaces to avoid false positives
    // Split on first delimiter: "multi_agent_v1__spawn_agent" -> ["multi_agent_v1", "spawn_agent"]
    const firstDelimiterEnd = delimiterIndex + NAMESPACE_DELIMITER.length;
    const namespace = functionName.substring(0, delimiterIndex);
    const name = functionName.substring(firstDelimiterEnd);
    
    if (COLLABORATION_NAMESPACES.has(namespace)) {
      flatToNative.set(functionName, { namespace, name });
    }
  }
  
  return flatToNative;
}

// Restore a function call from flattened name to namespaced shape
function restoreNamespacedFunctionCall(call, flatToNative) {
  if (!call || typeof call !== "object" || !flatToNative.size) return call;
  
  const callName = call.name;
  if (typeof callName !== "string") return call;
  
  const native = flatToNative.get(callName);
  if (!native) return call;
  
  // Return the call with namespace restored and flattened name removed
  return {
    ...call,
    name: native.name,
    namespace: native.namespace,
  };
}

function adapterError(message, code = "invalid_responses_request") {
  const error = new Error(message);
  error.status = 400;
  error.code = code;
  return error;
}

function upstreamResponseError(message, code = "invalid_responses_response") {
  const error = new Error(message);
  error.status = 502;
  error.code = code;
  return error;
}

function clone(value) {
  if (value === undefined) return undefined;
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    throw adapterError("The Responses request must contain JSON values.");
  }
}

function object(value, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw adapterError(`${name} must be an object.`);
  }
  return value;
}

function contentToResponses(content) {
  if (content === undefined || content === null) return content;
  if (typeof content === "string") return [{ type: "input_text", text: content }];
  if (!Array.isArray(content)) return clone(content);
  return content.map((part) => {
    if (!part || typeof part !== "object" || Array.isArray(part)) return clone(part);
    if (part.type === "text") return { ...part, type: "input_text" };
    if (part.type === "image_url") {
      const imageUrl = typeof part.image_url === "string" ? part.image_url : part.image_url?.url;
      if (!imageUrl) throw adapterError("An image_url content part requires a URL.");
      return {
        type: "input_image",
        image_url: imageUrl,
        ...(part.detail || part.image_url?.detail ? { detail: part.detail || part.image_url.detail } : {}),
      };
    }
    return clone(part);
  });
}

function chatMessageToResponses(message) {
  object(message, "message");
  const role = typeof message.role === "string" && message.role ? message.role : "user";
  if (role === "tool") {
    if (typeof message.tool_call_id !== "string" || !message.tool_call_id) {
      throw adapterError("A tool message requires tool_call_id.");
    }
    return [{
      type: "function_call_output",
      call_id: message.tool_call_id,
      output: typeof message.content === "string" ? message.content : JSON.stringify(message.content ?? ""),
    }];
  }
  const output = [];
  if (typeof message.reasoning_content === "string" && message.reasoning_content) {
    output.push({ type: "reasoning", summary: [{ type: "summary_text", text: message.reasoning_content }] });
  }
  const content = contentToResponses(message.content);
  output.push({
    type: "message",
    role,
    content: content === undefined || content === null ? [] : content,
    ...(typeof message.name === "string" && message.name ? { name: message.name } : {}),
  });
  if (message.tool_calls !== undefined && !Array.isArray(message.tool_calls)) {
    throw adapterError("message.tool_calls must be an array.");
  }
  for (const call of message.tool_calls || []) {
    object(call, "tool call");
    const fn = object(call.function || {}, "tool call function");
    if (typeof call.id !== "string" || !call.id || typeof fn.name !== "string" || !fn.name) {
      throw adapterError("A function tool call requires id and function name.");
    }
    const args = typeof fn.arguments === "string" ? fn.arguments : JSON.stringify(fn.arguments ?? {});
    output.push({ type: "function_call", call_id: call.id, name: fn.name, arguments: args });
  }
  return output;
}

function chatMessagesToResponses(messages) {
  if (!Array.isArray(messages)) return messages;
  return messages.flatMap((message) => chatMessageToResponses(message));
}

function normalizeTool(tool) {
  if (!tool || typeof tool !== "object" || Array.isArray(tool)) return clone(tool);
  if (tool.type !== "function" || !tool.function) return clone(tool);
  const fn = object(tool.function, "function tool");
  if (typeof fn.name !== "string" || !fn.name) throw adapterError("A function tool requires a name.");
  const { function: _function, ...rest } = tool;
  return { ...rest, name: fn.name, ...(fn.description !== undefined ? { description: fn.description } : {}), ...(fn.parameters !== undefined ? { parameters: fn.parameters } : {}), ...(fn.strict !== undefined ? { strict: fn.strict } : {}) };
}

function normalizeToolChoice(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  if (value.type !== "function" || !value.function) return clone(value);
  const name = value.function.name;
  if (typeof name !== "string" || !name) throw adapterError("A function tool_choice requires a name.");
  return { type: "function", name };
}

function normalizeResponseFormat(payload) {
  if (payload.response_format === undefined) return;
  if (payload.text !== undefined) throw adapterError("Use either response_format or text.format, not both.");
  const format = object(payload.response_format, "response_format");
  if (format.type === "json_object") {
    payload.text = { format: { type: "json_object" } };
  } else if (format.type === "json_schema") {
    const schema = object(format.json_schema, "response_format.json_schema");
    payload.text = {
      format: {
        type: "json_schema",
        ...(schema.name !== undefined ? { name: schema.name } : {}),
        ...(schema.description !== undefined ? { description: schema.description } : {}),
        ...(schema.schema !== undefined ? { schema: schema.schema } : {}),
        ...(schema.strict !== undefined ? { strict: schema.strict } : {}),
      },
    };
  } else {
    throw adapterError(`Unsupported response_format type ${String(format.type)}.`);
  }
  delete payload.response_format;
}

function normalizeResponsesRequest(payload) {
  const next = object(clone(payload), "Responses request");
  if (typeof next.model !== "string" || !next.model) throw adapterError("A Responses request requires model.");
  if (next.input !== undefined && next.messages !== undefined) {
    throw adapterError("A Responses request cannot contain both input and messages.");
  }
  if (next.input === undefined && next.messages !== undefined) {
    next.input = chatMessagesToResponses(next.messages);
    delete next.messages;
  }
  if (next.input !== undefined && !Array.isArray(next.input) && typeof next.input !== "string") {
    throw adapterError("Responses input must be a string or array.");
  }
  if (Array.isArray(next.input)) {
    next.input = next.input.map((item) => {
      object(item, "input item");
      if (item.type === "message" && item.content !== undefined) {
        return { ...item, content: contentToResponses(item.content) };
      }
      if (
        item.type === "function_call" &&
        (typeof item.call_id !== "string" || !item.call_id || typeof item.name !== "string" || !item.name)
      ) {
        throw adapterError("A function_call input item requires call_id and name.");
      }
      if (
        item.type === "function_call_output" &&
        (typeof item.call_id !== "string" || !item.call_id || item.output === undefined)
      ) {
        throw adapterError("A function_call_output input item requires call_id and output.");
      }
      return clone(item);
    });
  }
  if (next.tools !== undefined && !Array.isArray(next.tools)) {
    throw adapterError("tools must be an array.");
  }
  if (Array.isArray(next.tools)) next.tools = next.tools.map(normalizeTool);
  if (next.tool_choice !== undefined) next.tool_choice = normalizeToolChoice(next.tool_choice);
  if (next.reasoning_effort !== undefined) {
    if (next.reasoning !== undefined) throw adapterError("Use either reasoning or reasoning_effort, not both.");
    next.reasoning = { effort: next.reasoning_effort };
    delete next.reasoning_effort;
  }
  if (next.max_tokens !== undefined) {
    if (next.max_output_tokens !== undefined && next.max_output_tokens !== next.max_tokens) {
      throw adapterError("max_tokens and max_output_tokens must not disagree.");
    }
    next.max_output_tokens ??= next.max_tokens;
    delete next.max_tokens;
  }
  normalizeResponseFormat(next);
  if (next.parallel_tool_calls !== undefined && typeof next.parallel_tool_calls !== "boolean") {
    throw adapterError("parallel_tool_calls must be a boolean.");
  }
  if (next.stream !== undefined && typeof next.stream !== "boolean") {
    throw adapterError("stream must be a boolean.");
  }
  return next;
}

function normalizeResponseBody(payload, flatToNative) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw upstreamResponseError("The upstream Responses response must be an object.");
  }
  const next = clone(payload);
  if (next.output !== undefined && !Array.isArray(next.output)) {
    throw upstreamResponseError("The upstream Responses response has an invalid output array.");
  }
  
  // Restore namespaces in function call items within the output array
  if (Array.isArray(next.output) && flatToNative && flatToNative.size > 0) {
    next.output = next.output.map((item) => {
      if (item && typeof item === "object" && item.type === "function_call") {
        return restoreNamespacedFunctionCall(item, flatToNative);
      }
      return item;
    });
  }
  
  return next;
}

function parseFrame(frame) {
  const lines = frame.replace(/\r/g, "").split("\n");
  const data = [];
  let event;
  let id;
  let retry;
  for (const line of lines) {
    if (!line || line.startsWith(":")) continue;
    const separator = line.indexOf(":");
    const field = separator === -1 ? line : line.slice(0, separator);
    const value = separator === -1 ? "" : line.slice(separator + 1).replace(/^ /, "");
    if (field === "event") event = value;
    else if (field === "id") id = value;
    else if (field === "retry") retry = value;
    else if (field === "data") data.push(value);
  }
  return { event, id, retry, data: data.join("\n") };
}

function frameData(frame) {
  if (frame.data === "[DONE]" || frame.data === "") return frame.data;
  try {
    return JSON.parse(frame.data);
  } catch {
    throw upstreamResponseError(
      "The upstream Responses stream emitted malformed JSON event data.",
      "invalid_responses_stream",
    );
  }
}

function serializeFrame(frame, data = frame.data) {
  const lines = [];
  if (frame.event) lines.push(`event: ${frame.event}`);
  if (frame.id !== undefined) lines.push(`id: ${frame.id}`);
  if (frame.retry !== undefined) lines.push(`retry: ${frame.retry}`);
  const text = typeof data === "string" ? data : JSON.stringify(data);
  for (const line of String(text).split("\n")) lines.push(`data: ${line}`);
  return `${lines.join("\n")}\n\n`;
}

function streamState() {
  return {
    responseId: undefined,
    outputIndex: 0,
    itemIndexes: new Map(),
    sawEvent: false,
    terminal: false,
    invalid: false,
  };
}

const TERMINAL_EVENTS = new Set([
  "response.completed",
  "response.incomplete",
  "response.failed",
  "response.error",
]);

function validOutputIndex(value) {
  return Number.isInteger(value) && value >= 0;
}

function invalidStream(state, message) {
  if (state.invalid) return "";
  state.invalid = true;
  state.terminal = true;
  return serializeFrame({ event: "error" }, {
    type: "error",
    code: "invalid_responses_stream",
    message,
    param: null,
  });
}

function rememberStreamIndex(state, key, index) {
  if (!key) return true;
  const previous = state.itemIndexes.get(key);
  if (previous !== undefined && previous !== index) return false;
  state.itemIndexes.set(key, index);
  return true;
}

function normalizeResponsesEvent(frame, state, flatToNative) {
  const data = frameData(frame);
  state.sawEvent = true;
  if (state.invalid) return "";
  if (state.terminal && data !== "[DONE]") {
    return invalidStream(state, "The Responses stream emitted data after its terminal event.");
  }
  if (frame.event === "error") state.terminal = true;
  if (data === "[DONE]") {
    if (!state.terminal) {
      return invalidStream(state, "The Responses stream ended without a terminal event.");
    }
    state.terminal = true;
    return serializeFrame(frame, data);
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) return serializeFrame(frame, data);
  if (typeof data.type === "string" && TERMINAL_EVENTS.has(data.type)) state.terminal = true;
  if (data.type === "response.created") {
    const responseId = data.response?.id || data.response_id;
    if (state.responseId && responseId && state.responseId !== responseId) {
      return invalidStream(state, "The Responses stream changed response IDs.");
    }
    state.responseId ||= responseId;
  }
  if (data.type === "response.output_item.added") {
    const item = data.item && typeof data.item === "object" ? data.item : undefined;
    if (!item) return invalidStream(state, "A Responses output item event requires an item.");
    if (Object.hasOwn(data, "output_index") && !validOutputIndex(data.output_index)) {
      return invalidStream(state, "A Responses output item used an invalid output index.");
    }
    if (Object.hasOwn(item, "output_index") && !validOutputIndex(item.output_index)) {
      return invalidStream(state, "A Responses output item used an invalid item index.");
    }
    if (validOutputIndex(data.output_index) && validOutputIndex(item.output_index) && data.output_index !== item.output_index) {
      return invalidStream(state, "A Responses output item used conflicting output indices.");
    }
    let index = validOutputIndex(data.output_index) ? data.output_index : item.output_index;
    if (!validOutputIndex(index)) index = state.outputIndex;
    if (index !== state.outputIndex) {
      return invalidStream(state, "A Responses output item used a non-sequential output index.");
    }
    if (item.type === "function_call" && !item.id && !item.call_id) {
      return invalidStream(state, "A Responses function call item requires an id or call_id.");
    }
    if (!rememberStreamIndex(state, item.id, index) || !rememberStreamIndex(state, item.call_id, index)) {
      return invalidStream(state, "A Responses output item reused an ID with a different index.");
    }
    state.outputIndex = index + 1;
    if (!validOutputIndex(data.output_index)) data.output_index = index;
    
    // Restore namespace for function call items
    if (item.type === "function_call" && flatToNative && flatToNative.size > 0) {
      const restored = restoreNamespacedFunctionCall(item, flatToNative);
      if (restored !== item) {
        data.item = restored;
      }
    }
  }
  if (data.type === "response.function_call_arguments.delta" || data.type === "response.function_call_arguments.done") {
    const key = data.call_id || data.item_id;
    if (typeof key !== "string" || !key) {
      return invalidStream(state, "A Responses function call arguments event requires call_id or item_id.");
    }
    if (Object.hasOwn(data, "output_index") && !validOutputIndex(data.output_index)) {
      return invalidStream(state, "A Responses function call arguments event used an invalid output index.");
    }
    const index = state.itemIndexes.get(key);
    if (!validOutputIndex(index)) {
      return invalidStream(state, "A Responses function call arguments event referenced an unknown item.");
    }
    if (validOutputIndex(data.output_index) && data.output_index !== index) {
      return invalidStream(state, "A Responses function call arguments event used the wrong output index.");
    }
    if (!validOutputIndex(data.output_index)) data.output_index = index;
  }
  if (data.type === "response.output_text.delta" && !validOutputIndex(data.output_index) && state.outputIndex > 0) {
    data.output_index = state.outputIndex - 1;
  }
  if (data.type === "response.completed" && data.response && typeof data.response === "object") {
    if (state.responseId && data.response.id && data.response.id !== state.responseId) {
      return invalidStream(state, "The Responses completion used a different response ID.");
    }
    if (state.responseId && !data.response.id) data.response.id = state.responseId;
  }
  return serializeFrame(frame, data);
}

export function createResponsesStreamTransform(flatToNative = new Map()) {
  let buffer = "";
  const state = streamState();
  const decoder = new TextDecoder();
  const nextBoundary = (value) => {
    const match = /\r?\n\r?\n/.exec(value);
    return match ? { index: match.index, length: match[0].length } : undefined;
  };
  return new Transform({
    transform(chunk, _encoding, callback) {
      try {
        buffer += typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true });
        let boundary;
        while ((boundary = nextBoundary(buffer))) {
          const frame = buffer.slice(0, boundary.index);
          buffer = buffer.slice(boundary.index + boundary.length);
          if (frame.trim()) {
            const normalized = normalizeResponsesEvent(parseFrame(frame), state, flatToNative);
            if (normalized) this.push(normalized);
          }
        }
        callback();
      } catch (error) {
        callback(error);
      }
    },
    flush(callback) {
      try {
        buffer += decoder.decode();
        if (buffer.trim()) {
          const normalized = normalizeResponsesEvent(parseFrame(buffer), state, flatToNative);
          if (normalized) this.push(normalized);
        }
        if (state.sawEvent && !state.terminal && !state.invalid) {
          this.push(serializeFrame({ event: "error" }, {
            type: "error",
            code: "upstream_stream_incomplete",
            message: "The upstream Responses stream ended before a terminal event.",
            param: null,
          }));
        }
        callback();
      } catch (error) {
        callback(error);
      }
    },
  });
}

export function createResponsesJsonTransform(flatToNative = new Map()) {
  let body = "";
  return new Transform({
    transform(chunk, _encoding, callback) {
      body += typeof chunk === "string" ? chunk : chunk.toString("utf8");
      callback();
    },
    flush(callback) {
      let parsed;
      try {
        parsed = JSON.parse(body);
      } catch {
        callback(upstreamResponseError("The upstream Responses response was not valid JSON."));
        return;
      }
      try {
        this.push(JSON.stringify(normalizeResponseBody(parsed, flatToNative)));
      } catch (error) {
        callback(error);
        return;
      }
      callback();
    },
  });
}

export function normalizeOpenAIRequest(payload, { adapter = RESPONSE_PROTOCOL } = {}) {
  if (adapter !== RESPONSE_PROTOCOL && adapter !== "responses") {
    throw adapterError(`Unsupported OpenAI adapter ${String(adapter)}.`, "unsupported_openai_adapter");
  }
  return normalizeResponsesRequest(payload);
}

export function normalizeOpenAIResponse(payload) {
  return normalizeResponseBody(payload);
}
