// SSE joins repeated `data:` fields with a line feed before dispatch.
// Reading only the first field truncates multiline JSON.
export function sseDataFromBlock(rawEvent) {
  if (typeof rawEvent !== "string" || !rawEvent) return undefined;
  const dataLines = [];
  for (const line of rawEvent.split(/\r?\n/)) {
    if (!line.startsWith("data:")) continue;
    const value = line.slice(5);
    dataLines.push(value.startsWith(" ") ? value.slice(1) : value);
  }
  return dataLines.length ? dataLines.join("\n") : undefined;
}

const TOOL_ITEM_TYPES = new Set(["function_call", "custom_tool_call"]);

export function createTurnState() {
  return {
    contentText: "",
    toolCalls: [],
    toolByItemId: new Map(),
    usage: undefined,
    deltas: [],
  };
}

export function mapUpstreamUsage(usage) {
  if (!usage || typeof usage !== "object") return undefined;
  const prompt = Number(usage.input_tokens ?? usage.prompt_tokens ?? 0);
  const completion = Number(usage.output_tokens ?? usage.completion_tokens ?? 0);
  const mapped = {
    prompt_tokens: Number.isFinite(prompt) ? prompt : 0,
    completion_tokens: Number.isFinite(completion) ? completion : 0,
    total_tokens:
      (Number.isFinite(prompt) ? prompt : 0) + (Number.isFinite(completion) ? completion : 0),
  };
  const cached = Number(usage.input_tokens_details?.cached_tokens);
  if (Number.isFinite(cached)) {
    mapped.prompt_tokens_details = { cached_tokens: cached };
  }
  const reasoning = Number(
    usage.output_tokens_details?.reasoning_tokens ?? usage.reasoning_tokens,
  );
  if (Number.isFinite(reasoning)) {
    mapped.completion_tokens_details = { reasoning_tokens: reasoning };
  }
  return mapped;
}

function toolArguments(item) {
  if (typeof item?.arguments === "string") return item.arguments;
  if (typeof item?.input === "string") return item.input;
  return "";
}

function streamedToolArguments(state, index) {
  return state.deltas
    .flatMap((delta) => delta.tool_calls || [])
    .filter((call) => call.index === index)
    .map((call) => call.function?.arguments || "")
    .join("");
}

function pushToolArgumentDelta(state, entry, delta) {
  if (!entry || !delta) return;
  const index = state.toolCalls.indexOf(entry);
  state.deltas.push({
    tool_calls: [{ index, function: { arguments: delta } }],
  });
}

function appendToolArgumentDelta(state, itemId, delta) {
  const entry = itemId ? state.toolByItemId.get(itemId) : undefined;
  if (!entry || !delta) return;
  entry.function.arguments += delta;
  pushToolArgumentDelta(state, entry, delta);
}

function backfillToolArgumentDeltas(state) {
  state.toolCalls.forEach((entry, index) => {
    const finalArgs = entry.function.arguments || "";
    const streamed = streamedToolArguments(state, index);
    if (!finalArgs || streamed === finalArgs) return;
    const extra = finalArgs.startsWith(streamed) ? finalArgs.slice(streamed.length) : finalArgs;
    pushToolArgumentDelta(state, entry, extra);
  });
}

function ensureToolCall(state, item, itemId, { complete = false } = {}) {
  if (!item || !TOOL_ITEM_TYPES.has(item.type)) return undefined;
  const key = itemId || item.id || item.call_id;
  let entry = key ? state.toolByItemId.get(key) : undefined;
  if (!entry) {
    const args = toolArguments(item);
    entry = {
      id: item.call_id || item.id || key,
      type: "function",
      function: { name: item.name || "", arguments: args },
    };
    state.toolCalls.push(entry);
    if (key) state.toolByItemId.set(key, entry);
    state.deltas.push({
      tool_calls: [
        {
          index: state.toolCalls.length - 1,
          id: entry.id,
          type: "function",
          function: { name: entry.function.name, arguments: complete ? args : "" },
        },
      ],
    });
  } else {
    if (item.name) entry.function.name = item.name;
    const args = toolArguments(item);
    if (args) entry.function.arguments = args;
  }
  return entry;
}

export function applyResponsesEvent(state, event) {
  if (!event || typeof event !== "object") return state;
  switch (event.type) {
    case "response.output_text.delta": {
      if (event.delta) {
        state.contentText += event.delta;
        state.deltas.push({ content: event.delta });
      }
      break;
    }
    case "response.output_item.added":
    case "response.output_item.done": {
      const item = event.item;
      if (TOOL_ITEM_TYPES.has(item?.type)) {
        ensureToolCall(state, item, item.id, {
          complete: event.type === "response.output_item.done",
        });
      }
      break;
    }
    case "response.function_call_arguments.delta":
    case "response.custom_tool_call_input.delta": {
      appendToolArgumentDelta(state, event.item_id, event.delta);
      break;
    }
    case "response.function_call_arguments.done":
    case "response.custom_tool_call_input.done": {
      const complete = event.arguments ?? event.input ?? event.text;
      if (typeof complete === "string") {
        const entry = event.item_id ? state.toolByItemId.get(event.item_id) : undefined;
        if (entry) {
          const extra = complete.startsWith(entry.function.arguments)
            ? complete.slice(entry.function.arguments.length)
            : complete;
          entry.function.arguments = complete;
          pushToolArgumentDelta(state, entry, extra);
        }
      }
      break;
    }
    case "response.completed": {
      state.usage = mapUpstreamUsage(event.response?.usage);
      break;
    }
    default:
      break;
  }
  return state;
}

export function finalizeTurn(state) {
  backfillToolArgumentDeltas(state);
  return {
    contentText: state.contentText,
    toolCalls: state.toolCalls,
    usage: state.usage,
    deltas: state.deltas,
    finishReason: state.toolCalls.length ? "tool_calls" : "stop",
  };
}

export function collectResponsesEvents(events) {
  const state = createTurnState();
  for (const event of events || []) applyResponsesEvent(state, event);
  return finalizeTurn(state);
}
