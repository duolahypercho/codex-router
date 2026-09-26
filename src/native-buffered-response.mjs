// ChatGPT's Codex backend only streams: a Responses request without
// `stream: true` is a bare `{"detail":"Stream must be set to true"}` 400, and
// a string `input` is `{"detail":"Input must be a list"}`. The public Responses
// API accepts both, so a generic client pointed at this router gets a 400 that
// names neither the model nor the requirement (#862). Codex itself always
// streams and always sends a list, so nothing here touches a Codex turn.
import { parseSseBlockEvent } from "./grok-oauth-turn.mjs";

/**
 * The array form of a string `input`, as the public Responses API reads it:
 * one user message. Anything that is not a string is returned unchanged.
 */
export function nativeInputAsList(input) {
  if (typeof input !== "string") return input;
  return [
    {
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: input }],
    },
  ];
}

const TERMINAL_OK = new Set(["response.completed", "response.incomplete"]);
const TERMINAL_FAILED = new Set(["response.failed", "error"]);

/**
 * Fold a Responses SSE body into the single JSON object a non-streaming
 * caller expects.
 *
 * The native backend's terminal snapshot can carry an empty `output` and leave
 * the items to the `response.output_item.done` events, so the items are
 * collected along the way and used whenever the snapshot omits them.
 *
 * @returns {{ status: number, body: object }}
 */
export function foldResponsesSse(text) {
  const items = [];
  let terminal;
  let failure;
  for (const block of String(text || "").split(/\r?\n\r?\n/)) {
    const event = parseSseBlockEvent(block);
    if (!event || typeof event !== "object") continue;
    if (event.type === "response.output_item.done" && event.item) {
      const index = Number.isInteger(event.output_index) ? event.output_index : items.length;
      items[index] = event.item;
    } else if (TERMINAL_OK.has(event.type) && event.response) {
      terminal = event.response;
    } else if (TERMINAL_FAILED.has(event.type)) {
      failure = event;
    }
  }
  if (terminal && !failure) {
    const collected = items.filter(Boolean);
    const output = Array.isArray(terminal.output) && terminal.output.length > 0
      ? terminal.output
      : collected;
    return { status: 200, body: { ...terminal, output } };
  }
  const stated = failure?.response?.error || failure?.error || failure;
  const message = typeof stated?.message === "string" && stated.message
    ? stated.message
    : "The native response stream ended before the response completed.";
  return {
    status: 502,
    body: {
      error: {
        type: "upstream_error",
        code: typeof stated?.code === "string" ? stated.code : "native_stream_incomplete",
        message,
      },
    },
  };
}
