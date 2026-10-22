import {
  actualServiceTierFromValue,
} from "./request-diagnostics.mjs";
import { estimateInputTokens } from "./response-usage.mjs";
import { DEFAULT_IMAGE_TOKEN_BOUND } from "./prompt-image-usage.mjs";

// Count the final provider request, after tool alternatives, hosted tools and
// repair instructions have been added. This is an explicit estimate, separate
// from xAI's cumulative bill across internal inferences. Never tokenize sealed
// reasoning as plaintext or treat it as a measured context count.
export function grokContextFields(request, usage) {
  const estimate = estimateInputTokens(JSON.stringify(request), {
    minimumTokens: 0, maxTokensPerImage: DEFAULT_IMAGE_TOKEN_BOUND,
  });
  const fields = { grok_context_input_tokens: estimate };
  for (const [source, target] of [["billed_prompt_tokens", "grok_billed_input_tokens"], ["billed_completion_tokens", "grok_billed_output_tokens"]]) {
    if (Number.isSafeInteger(usage?.[source]) && usage[source] >= 0) fields[target] = usage[source];
  }
  return { provider_specific_fields: fields };
}

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

// Parse one SSE block to a JSON event. Malformed JSON is a skipped event;
// the caller must not wrap `handlers()` in the same try/catch.
export function parseSseBlockEvent(rawEvent) {
  const data = sseDataFromBlock(rawEvent);
  if (!data || data === "[DONE]") return undefined;
  try {
    return JSON.parse(data);
  } catch {
    return undefined;
  }
}

export const REPAIR_FINAL_TOOL = "__codex_router_submit_final";
// Decide whether to continue or finish on the first post-tool generation.
// Multiple independent client actions are allowed; the private final must stand alone.
const afterToolInstruction = (finalTool) =>
  "The previous tool call finished. Continue the user's task now. " +
  "Call the next task tool or tools if more work is needed, " +
  "or give the complete final answer if the task is fully done. " +
  (finalTool ? `You may also call ${finalTool} alone with that final answer. ` : "") +
  "Use the actual tool results to decide what remains; do not repeat completed work unnecessarily.";

export function allowsAutomaticToolChoice(chat) {
  return chat?.tool_choice === undefined || chat.tool_choice === "auto";
}

export function privateFinalToolName(chat) {
  const names = new Set((chat?.tools || []).map((tool) => tool?.function?.name));
  let name = REPAIR_FINAL_TOOL;
  for (let suffix = 1; names.has(name); suffix += 1) name = `${REPAIR_FINAL_TOOL}_${suffix}`;
  return name;
}

const REPAIR_FINAL_TOOL_DEFINITION = {
  type: "function",
  function: {
    name: REPAIR_FINAL_TOOL,
    description: "Submit the complete final answer only when the user's task is fully finished.",
    parameters: {
      type: "object",
      properties: { answer: { type: "string" } },
      required: ["answer"],
      additionalProperties: false,
    },
  },
};

// The last non-system message is a tool result. This identifies continuation
// context, not whether the user's task is semantically complete.
export function lastClientMessageWasToolResult(chat) {
  const messages = Array.isArray(chat?.messages) ? chat.messages : [];
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!message || message.role === "system") continue;
    return message.role === "tool";
  }
  return false;
}

// A completed pre-tool response belongs to the caller, even when it is empty.
// Only an empty post-tool continuation has an established recovery contract.
export function isProgressOnlyStop(turn, { afterToolResult = false } = {}) {
  if (!afterToolResult || turn?.terminalStatus !== "completed" || turn.toolCalls?.length > 0) return false;
  return !String(turn.contentText ?? "").trim();
}

// A successful terminal may finish with native text, client tools, or the
// optional private final. Reject malformed/mixed actions and empty output.
export function classifyAfterToolRepair(second, { finalTool = REPAIR_FINAL_TOOL, privateFinalOffered = true, clientToolNames } = {}) {
  // An item-level close only finishes that call's arguments. It does not
  // certify the response: failed, incomplete, and truncated attempts can all
  // contain a complete-looking client call or private final-answer call.
  if (second?.terminalStatus !== "completed") return { action: "fail" };
  const calls = Array.isArray(second?.toolCalls) ? second.toolCalls : [];
  // A completed text response is a native final, not a protocol violation.
  // Requiring a synthetic tool here can force an otherwise finished model to
  // invent actions or generate indefinitely while trying to satisfy the choice.
  if (!calls.length) {
    const contentText = typeof second.contentText === "string" ? second.contentText.trim() : "";
    return contentText ? { action: "final", contentText } : { action: "fail" };
  }
  const finalCalls = calls.filter((call) => call?.function?.name === finalTool);
  if (finalCalls.length && !privateFinalOffered) return { action: "fail" };
  if (!finalCalls.length) {
    return calls.every((call) => call?.function?.name &&
      (!clientToolNames || clientToolNames.has(call.function.name)))
      ? { action: "tools" } : { action: "fail" };
  }
  // Prose is still held here. A single valid private final is authoritative:
  // discard preceding commentary rather than turning a completed answer into
  // a protocol error. Mixing it with a client action remains forbidden.
  if (calls.length !== 1) return { action: "fail" };
  const [call] = finalCalls;
  let args;
  try {
    args = JSON.parse(call.function.arguments || "{}");
  } catch {
    return { action: "fail" };
  }
  const finalText = typeof args?.answer === "string" ? args.answer.trim() : "";
  if (!finalText || !args || Array.isArray(args) || Object.keys(args).length !== 1) return { action: "fail" };
  return { action: "final", contentText: finalText };
}

// Codex needs the context size of the selected attempt, not the sum of two
// prompts. Keep aggregate billed usage in explicit extension fields so a
// retry cannot make a ~150k context look like ~300k to the client.
export function selectedRetryUsage(first, second) {
  const selected = second || first;
  const usage = selected ? { ...selected } : {};
  delete usage.service_tier;
  delete usage.billed_service_tier;
  const billedPromptTokens =
    (first?.prompt_tokens || 0) + (second?.prompt_tokens || 0);
  const billedCompletionTokens =
    (first?.completion_tokens || 0) + (second?.completion_tokens || 0);
  return {
    ...usage,
    retries: 1,
    progress_only_retried: true,
    billed_prompt_tokens: billedPromptTokens,
    billed_completion_tokens: billedCompletionTokens,
  };
}

export function toolCallDeltas(turn) {
  return (turn?.deltas || []).filter(
    (delta) => Array.isArray(delta.tool_calls) && delta.tool_calls.length > 0,
  );
}

export function withProgressOnlyNudge(chat, {
  afterToolResult = false,
  finalTool = privateFinalToolName(chat),
  maxTools = 350,
  clientToolCount = Array.isArray(chat?.tools) ? chat.tools.length : 0,
} = {}) {
  // Explicit caller choices are authoritative, including on a recovery attempt.
  if (!afterToolResult || !allowsAutomaticToolChoice(chat)) return chat;
  const offerPrivateFinal = afterToolResult && clientToolCount < maxTools;
  const messages = Array.isArray(chat?.messages) ? chat.messages : [];
  const nudged = {
    ...chat,
    messages: [
      ...messages,
      {
        // Keep the tool result as the last model input. A trailing user message
        // starts a new conversational turn on xAI and can make a forced tool
        // choice complete empty. Developer text is hoisted into `instructions`.
        role: "developer",
        content: afterToolInstruction(offerPrivateFinal ? finalTool : undefined),
      },
    ],
  };
  if (!offerPrivateFinal) return nudged;
  const tools = Array.isArray(chat?.tools) ? chat.tools : [];
  return {
    ...nudged,
    tools: [
      ...tools,
      { ...REPAIR_FINAL_TOOL_DEFINITION, function: { ...REPAIR_FINAL_TOOL_DEFINITION.function, name: finalTool } },
    ],
    tool_choice: "auto",
  };
}

const TOOL_ITEM_TYPES = new Set(["function_call", "custom_tool_call"]);

export function createTurnState({ toolNameMapper = (name) => name } = {}) {
  return {
    contentText: "",
    reasoningText: "",
    toolCalls: [],
    toolByItemId: new Map(),
    usage: undefined,
    serviceTier: undefined,
    serviceTierUnknown: false,
    terminalStatus: undefined,
    deltas: [],
    toolNameMapper,
  };
}

export function chatServiceTierFields(turn) {
  // LiteLLM's Responses bridge drops the standard Chat field but preserves
  // provider_specific_fields. Carry only provider-reported bounded metadata.
  if (turn?.serviceTierUnknown) return { provider_specific_fields: { grok_service_tier: "unknown" } };
  if (turn?.serviceTier) return {
    service_tier: turn.serviceTier,
    provider_specific_fields: { grok_service_tier: turn.serviceTier },
  };
  return {};
}

function attachActualServiceTier(state, response) {
  const actual = actualServiceTierFromValue(response?.service_tier);
  state.serviceTier = actual.kind === "known" ? actual.value : undefined;
  state.serviceTierUnknown = actual.kind === "unknown";
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

function reconcileToolArguments(state, entry, complete) {
  const streamed = streamedToolArguments(state, state.toolCalls.indexOf(entry));
  if (!complete.startsWith(streamed)) {
    throw Object.assign(new Error("Grok tool argument snapshots disagree with the streamed arguments."), {
      status: 502,
      code: "grok_tool_arguments_mismatch",
    });
  }
  entry.function.arguments = complete;
  pushToolArgumentDelta(state, entry, complete.slice(streamed.length));
}

function appendToolArgumentDelta(state, itemId, delta) {
  const entry = itemId ? state.toolByItemId.get(itemId) : undefined;
  if (!entry || !delta) return;
  entry.function.arguments += delta;
  pushToolArgumentDelta(state, entry, delta);
}

function backfillToolArgumentDeltas(state) {
  state.toolCalls.forEach((entry) => {
    const finalArgs = entry.function.arguments || "";
    reconcileToolArguments(state, entry, finalArgs);
  });
}

function ensureToolCall(state, item, itemId) {
  if (!item || !TOOL_ITEM_TYPES.has(item.type)) return undefined;
  const key = itemId || item.id || item.call_id;
  let entry = key ? state.toolByItemId.get(key) : undefined;
  if (!entry) {
    const args = toolArguments(item);
    entry = {
      id: item.call_id || item.id || key,
      type: "function",
      function: { name: state.toolNameMapper(item.name || ""), arguments: args },
    };
    state.toolCalls.push(entry);
    if (key) state.toolByItemId.set(key, entry);
    state.deltas.push({
      tool_calls: [
        {
          index: state.toolCalls.length - 1,
          id: entry.id,
          type: "function",
          function: { name: entry.function.name, arguments: args },
        },
      ],
    });
  } else {
    if (item.name) entry.function.name = state.toolNameMapper(item.name);
    const args = toolArguments(item);
    if (typeof item.arguments === "string" || typeof item.input === "string") {
      reconcileToolArguments(state, entry, args);
    }
  }
  return entry;
}

function completedStatus(response) {
  const status = response?.status;
  if (!status || status === "completed") return "completed";
  return status === "failed" ? "failed" : "incomplete";
}

function recordTerminal(state, terminalStatus, response) {
  state.terminalStatus = terminalStatus;
  state.usage = mapUpstreamUsage(response?.usage);
  attachActualServiceTier(state, response);
}

export function applyResponsesEvent(state, event) {
  if (!event || typeof event !== "object") return state;
  // The first terminal seals the attempt. A failure cannot be revived, and a
  // completed terminal certifies only what preceded it: content, reasoning,
  // tool, or terminal frames after it were never covered by a successful
  // terminal and cannot add actions or change the outcome. In particular,
  // [DONE] is never success evidence.
  if (state.terminalStatus) return state;
  switch (event.type) {
    case "response.output_text.delta": {
      if (event.delta) {
        state.contentText += event.delta;
        state.deltas.push({ content: event.delta });
      }
      break;
    }
    // xAI streams grok-4.6 summaries as reasoning_summary_text, and also
    // documents reasoning_text. Both belong on the chat `reasoning_content`
    // field so LiteLLM can put them back on the Responses reasoning channel
    // Codex uses to show-then-collapse thinking.
    case "response.reasoning_summary_text.delta":
    case "response.reasoning_text.delta": {
      if (event.delta) {
        state.reasoningText += event.delta;
        state.deltas.push({ reasoning_content: event.delta });
      }
      break;
    }
    case "response.output_item.added":
    case "response.output_item.done": {
      const item = event.item;
      if (TOOL_ITEM_TYPES.has(item?.type)) {
        ensureToolCall(state, item, item.id);
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
          reconcileToolArguments(state, entry, complete);
        }
      }
      break;
    }
    case "response.completed": {
      if (completedStatus(event.response) === "completed") {
        for (const item of event.response?.output || []) {
          if (TOOL_ITEM_TYPES.has(item?.type)) ensureToolCall(state, item, item.id);
        }
      }
      recordTerminal(state, completedStatus(event.response), event.response);
      break;
    }
    case "response.failed":
    case "error": {
      recordTerminal(state, "failed", event.response);
      break;
    }
    case "response.incomplete": {
      recordTerminal(state, "incomplete", event.response);
      break;
    }
    default:
      break;
  }
  return state;
}

export function finalizeTurn(state) {
  const terminalStatus = state.terminalStatus || "missing";
  if (terminalStatus === "completed") backfillToolArgumentDeltas(state);
  return {
    contentText: state.contentText,
    reasoningText: state.reasoningText,
    toolCalls: state.toolCalls,
    usage: state.usage,
    serviceTier: state.serviceTier,
    serviceTierUnknown: state.serviceTierUnknown === true,
    deltas: state.deltas,
    terminalStatus,
    finishReason: terminalStatus === "completed"
      ? state.toolCalls.length ? "tool_calls" : "stop"
      : null,
  };
}

export function collectResponsesEvents(events) {
  const state = createTurnState();
  for (const event of events || []) applyResponsesEvent(state, event);
  return finalizeTurn(state);
}
