import { Transform } from "node:stream";

// Replay of a thinking model's own reasoning.
//
// opencode's Go plan (like DeepSeek's own API) rejects a thinking-mode
// assistant tool call whose `reasoning_content` is missing:
//
//   "Upstream request failed: [invalid_request_error] The `reasoning_content`
//    in the thinking mode must be passed back to the API."
//
// The forwarder already guarantees the *field* exists (issue #809), but an
// empty string does not satisfy this contract. Measured live against the Go
// plan, 2026-09-21, with an identical tool-call history:
//
//   deepseek-v4.1-flash, no reasoning_content          -> 400
//   deepseek-v4.1-flash, reasoning_content: ""         -> 400
//   deepseek-v4.1-flash, the model's own reasoning     -> 200
//   deepseek-v4-flash / glm-5.2 (no replay contract)   -> 200
//
// The client cannot always supply it: a compacted history or a stateless
// tool-result replay never saw the reasoning. The router did stream it, so this
// module taps the upstream stream read-only and remembers the text per
// tool-call id -- which history preserves, so the match survives compaction.
//
// Cost and safety:
//   * only models that require the contract pay for the tap;
//   * the parsers pre-check the raw chunk with a substring test before any
//     JSON work, and keep at most one turn's text in memory;
//   * the cache is a Map with LRU eviction by entry count and total characters;
//   * reasoning is stored whole or not at all -- a truncated replay is not the
//     same reasoning, and the model reads it as prose it once wrote;
//   * no byte on the wire changes, so upstream prefixes (and their cache hits)
//     are untouched; the only prompt change is the addition this exists for.

const MAX_ENTRIES = 512;
const MAX_CHARS = 400_000;
const MAX_TURN_CHARS = 400_000;
const MAX_JSON_RESPONSE_BYTES = 4 * 1024 * 1024;

const byToolCall = new Map(); // tool_call id -> reasoning text, oldest first
let storedChars = 0;

function evictToBounds() {
  while (byToolCall.size > MAX_ENTRIES || storedChars > MAX_CHARS) {
    const oldest = byToolCall.keys().next();
    if (oldest.done) break;
    storedChars -= byToolCall.get(oldest.value)?.length || 0;
    byToolCall.delete(oldest.value);
  }
}

export function rememberReasoningForToolCalls(toolCallIds, reasoning) {
  const text = typeof reasoning === "string" ? reasoning : "";
  if (!text || text.length > MAX_CHARS) return 0;
  if (!Array.isArray(toolCallIds) || toolCallIds.length === 0) return 0;
  let stored = 0;
  for (const id of toolCallIds) {
    if (typeof id !== "string" || id.length === 0) continue;
    // Re-insert at the tail so the most recently useful turn survives.
    const previous = byToolCall.get(id);
    if (previous !== undefined) {
      storedChars -= previous.length;
      byToolCall.delete(id);
    }
    byToolCall.set(id, text);
    storedChars += text.length;
    stored += 1;
  }
  evictToBounds();
  return stored;
}

export function reasoningForToolCalls(toolCallIds) {
  if (!Array.isArray(toolCallIds)) return undefined;
  for (const id of toolCallIds) {
    if (typeof id !== "string") continue;
    const text = byToolCall.get(id);
    if (text === undefined) continue;
    byToolCall.delete(id);
    byToolCall.set(id, text);
    return text;
  }
  return undefined;
}

export function reasoningReplayCacheStats() {
  return { entries: byToolCall.size, chars: storedChars };
}

export function resetReasoningReplayCache() {
  byToolCall.clear();
  storedChars = 0;
}

// Tool-call ids on an assistant message, in wire order.
export function toolCallIdsOf(message) {
  if (!Array.isArray(message?.tool_calls)) return [];
  return message.tool_calls
    .map((call) => (typeof call?.id === "string" ? call.id : ""))
    .filter(Boolean);
}

function collectToolCallIds(value) {
  if (!Array.isArray(value)) return [];
  const ids = [];
  for (const call of value) {
    const id = call?.id;
    if (typeof id === "string" && id.length > 0) ids.push(id);
  }
  return ids;
}

// A read-only tap for an upstream Chat Completions SSE stream. It forwards
// every byte unchanged (a Transform that re-emits what it receives) and, when
// the turn ends, stores the reasoning it saw against the tool calls it saw.
//
// The order matters: reasoning deltas arrive before the tool-call deltas that
// carry the ids, so both are buffered and the store happens at the end.
export function createReasoningReplayTap({ onStore } = {}) {
  let reasoning = "";
  let toolCallIds = [];
  let buffer = "";

  const endsTurn = (payload) => {
    if (payload === "[DONE]") return true;
    const finish = payload?.choices?.[0]?.finish_reason;
    return typeof finish === "string" && finish.length > 0;
  };

  const ingest = (payload) => {
    const choice = payload?.choices?.[0];
    if (!choice) return;
    const message = choice.message;
    if (message && typeof message === "object") {
      if (typeof message.reasoning_content === "string" && message.reasoning_content) {
        reasoning = message.reasoning_content;
      }
      const ids = collectToolCallIds(message.tool_calls);
      if (ids.length) toolCallIds = ids;
    }
    const delta = choice.delta;
    if (delta && typeof delta === "object") {
      if (typeof delta.reasoning_content === "string") {
        if (reasoning.length + delta.reasoning_content.length <= MAX_TURN_CHARS) {
          reasoning += delta.reasoning_content;
        }
      }
      const ids = collectToolCallIds(delta.tool_calls);
      if (ids.length) toolCallIds = [...new Set([...toolCallIds, ...ids])];
    }
  };

  const finish = () => {
    if (reasoning && toolCallIds.length) {
      const stored = rememberReasoningForToolCalls(toolCallIds, reasoning);
      onStore?.({ stored, chars: reasoning.length, toolCallIds });
    }
    reasoning = "";
    toolCallIds = [];
  };

  return new Transform({
    transform(chunk, _encoding, callback) {
      try {
        const text = chunk.toString("utf8");
        buffer += text;
        // Cheap pre-check: skip JSON work for chunks that cannot carry either.
        if (text.includes("reasoning_content") || text.includes("tool_calls") || text.includes("finish_reason")) {
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";
          for (const line of lines) {
            if (!line.startsWith("data:")) continue;
            const payloadText = line.slice(5).trim();
            if (!payloadText) continue;
            if (payloadText === "[DONE]") {
              finish();
              continue;
            }
            try {
              const payload = JSON.parse(payloadText);
              ingest(payload);
              if (endsTurn(payload)) finish();
            } catch {
              // A partial or non-JSON data line is not this tap's business.
            }
          }
        } else if (buffer.includes("\n")) {
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";
        }
      } catch {
        // Observation must never disturb the relay.
      }
      callback(null, chunk);
    },
    flush(callback) {
      finish();
      callback();
    },
  });
}

// LiteLLM can request a non-streaming Chat Completions response for a Codex
// Responses turn. Observe a complete successful JSON response without changing
// its bytes; incomplete or oversized responses must never seed replay.
export function createReasoningReplayJsonTap({ onStore } = {}) {
  const chunks = [];
  let bytes = 0;
  let eligible = true;
  return new Transform({
    transform(chunk, _encoding, callback) {
      if (eligible) {
        bytes += chunk.length;
        if (bytes <= MAX_JSON_RESPONSE_BYTES) chunks.push(Buffer.from(chunk));
        else {
          eligible = false;
          chunks.length = 0;
        }
      }
      callback(null, chunk);
    },
    flush(callback) {
      if (eligible && bytes > 0) {
        try {
          const decoded = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks, bytes));
          const payload = JSON.parse(decoded);
          if (!Array.isArray(payload?.choices)) throw new Error("missing choices");
          for (const choice of payload.choices) {
            if (choice?.finish_reason !== "tool_calls" && choice?.finish_reason !== "stop") continue;
            const reasoning = choice.message?.reasoning_content;
            const toolCallIds = collectToolCallIds(choice.message?.tool_calls);
            const stored = rememberReasoningForToolCalls(toolCallIds, reasoning);
            if (stored) onStore?.({ stored, chars: reasoning.length, toolCallIds });
          }
        } catch {
          // Invalid JSON or UTF-8 cannot supply the model's exact reasoning.
        }
      }
      callback();
    },
  });
}
