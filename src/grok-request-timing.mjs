import { randomUUID } from "node:crypto";
import { grokToolDiagnostics } from "./grok-tool-diagnostics.mjs";

export const GROK_TIMING_HEADER = "x-codex-router-request-id";
const requestIds = new WeakMap();
const ID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}(?::[0-9]{1,12})?$/i;
const EFFORTS = new Set(["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"]);
const MARKS = new Set(["parsedMs", "preparedMs", "firstGatewayDispatchMs", "firstGatewayHeadersMs",
  "queuedMs", "dispatchMs", "headersMs", "firstEventMs", "firstReasoningMs", "firstTextMs",
  "firstToolMs", "firstToolReadyMs", "terminalMs", "endMs", "firstActionMs"]);
const TERMINALS = new Map([["response.completed", "completed"], ["response.failed", "failed"],
  ["response.incomplete", "incomplete"], ["error", "failed"]]);

export function setGrokTimingRequestId(request, id) {
  if (typeof id === "string" && ID.test(id)) requestIds.set(request, id);
}

// The caller cannot forge the correlation ID through extra_headers. This local
// header terminates at the forwarder; upstreamHeaders never forwards it to xAI.
export function grokTimingHeaders(request, headers) {
  const id = requestIds.get(request);
  if (!id) return headers;
  const entries = headers && typeof headers === "object" && !Array.isArray(headers)
    ? Object.entries(headers).filter(([key]) => key.toLowerCase() !== GROK_TIMING_HEADER) : [];
  return { ...Object.fromEntries(entries), [GROK_TIMING_HEADER]: id };
}

function effort(value) {
  const candidate = value && typeof value === "object" ? value.effort : value;
  return EFFORTS.has(candidate) ? candidate : null;
}

function observeEvent(target, mark, event) {
  if (target.terminal !== undefined) return;
  if (event?.object === "response" && event.status) {
    event = { type: `response.${event.status}`, response: event };
  }
  mark("firstEventMs");
  if (typeof event?.delta === "string" && event.delta.length) {
    if (["response.reasoning_summary_text.delta", "response.reasoning_text.delta"].includes(event.type)) mark("firstReasoningMs");
    if (event.type === "response.output_text.delta") mark("firstTextMs");
    if (["response.function_call_arguments.delta", "response.custom_tool_call_input.delta"].includes(event.type)) mark("firstToolMs");
  }
  if (["function_call", "custom_tool_call", "tool_search_call"].includes(event?.item?.type)) {
    if (["response.output_item.added", "response.output_item.done"].includes(event.type)) mark("firstToolMs");
    if (event.type === "response.output_item.done") mark("firstToolReadyMs");
  }
  if (TERMINALS.has(event?.type) && target.terminal === undefined) {
    mark("terminalMs");
    const status = event.response?.status;
    target.terminal = event.type === "response.completed" && ["failed", "incomplete"].includes(status)
      ? status : TERMINALS.get(event.type);
  }
}

// Durations use one monotonic clock, relative to receipt in this process.
// Wall time is only for joining independent process logs. No payload text,
// headers, URLs, error messages, or reasoning content are retained.
export function createGrokRequestTiming({ layer, requestId, now = () => performance.now(),
  wallNow = () => Date.now(), emit = row => console.error(`[grok-timing] ${JSON.stringify(row)}`) }) {
  if (!["router", "forwarder"].includes(layer)) throw new TypeError("Unknown timing layer");
  const started = now();
  const row = { version: 1, layer, requestId: typeof requestId === "string" && ID.test(requestId) ? requestId : randomUUID(),
    startedAt: new Date(wallNow()).toISOString(), attempts: [] };
  let finished = false;
  const stamp = () => Math.max(0, Math.round(now() - started));
  const marker = target => name => {
    if (!finished && MARKS.has(name) && target[name] === undefined) target[name] = stamp();
  };
  const mark = marker(row);
  return {
    mark,
    kind(value) {
      if (!finished && ["generation", "compaction"].includes(value)) row.requestKind = value;
    },
    tools(stage, tools) {
      if (!finished && ["client", "gateway", "upstream"].includes(stage)) {
        (row.toolSurfaces ??= {})[stage] = grokToolDiagnostics(tools);
      }
    },
    parallelTools(stage, value) {
      if (!finished && ["client", "gateway", "upstream"].includes(stage)) {
        (row.parallelToolCalls ??= {})[stage] = typeof value === "boolean" ? value : null;
      }
    },
    identify(model, requested, forwarded) {
      if (finished) return;
      // Only catalogue-shaped Grok model names, never arbitrary caller text.
      if (typeof model === "string" && /^(?:grok-oauth\/)?grok-[a-z0-9.-]{1,64}$/.test(model)) row.model = model;
      row.requestedReasoningEffort = effort(requested);
      if (layer === "forwarder") row.forwardedReasoningEffort = effort(forwarded);
    },
    event(event) { if (!finished) observeEvent(row, mark, event); },
    delta(delta) {
      if (typeof delta?.content === "string" && delta.content.length || Array.isArray(delta?.tool_calls) && delta.tool_calls.length) mark("firstActionMs");
    },
    attempt(id) {
      const data = { index: row.attempts.length + 1 };
      if (typeof id === "string" && ID.test(id)) data.upstreamRequestId = id;
      // Auth refresh plus bounded repair is at most three attempts today.
      // Keep a hard diagnostics bound if future callers change that policy.
      if (!finished && row.attempts.length < 8) row.attempts.push(data);
      const attemptMark = marker(data);
      return {
        mark: attemptMark,
        event(event) { if (!finished) observeEvent(data, attemptMark, event); },
        headers(status) {
          if (finished) return;
          attemptMark("headersMs");
          if (Number.isInteger(status) && status >= 100 && status <= 599) data.httpStatus = status;
        },
        end(outcome) {
          attemptMark("endMs");
          if (!finished && ["stream_end", "transport_error", "cancelled", "http_error"].includes(outcome)) data.outcome = outcome;
        },
      };
    },
    finish(outcome, status) {
      if (finished) return;
      row.totalMs = stamp();
      row.outcome = outcome === "response_finished" ? outcome : "connection_closed";
      for (const attempt of row.attempts) {
        if (attempt.endMs === undefined) {
          attempt.endMs = row.totalMs;
          attempt.outcome = row.outcome === "connection_closed" ? "cancelled" : "unfinished";
        }
      }
      if (Number.isInteger(status) && status >= 100 && status <= 599) row.httpStatus = status;
      finished = true;
      emit(row);
    },
  };
}
