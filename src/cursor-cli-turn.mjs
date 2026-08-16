// Translation between the router's chat-completions traffic and the one shape
// `cursor-agent -p` accepts: a single prompt in, a stream of NDJSON events out.
//
// Everything here is pure. The process launching, the HTTP surface, and the
// concurrency bound live in cursor-cli-bridge.mjs, so the awkward part -- the
// event schema, which is Cursor's and can change under us -- stays testable
// without spawning anything.

// Verified against cursor-agent 2026.08.11-e8db854, whose stream-json emitter
// produces exactly:
//
//   {"type":"system","subtype":"init","model":...,"session_id":...}
//   {"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":...}]}}
//   {"type":"tool_call","subtype":"started"|"completed",...}
//   {"type":"result","subtype":"success","is_error":false,"result":"...","usage":{...}}
//
// A type this module does not recognize is ignored rather than treated as an
// error: Cursor adds event types between releases, and a router that 500s on a
// new one turns a cosmetic upstream change into an outage.

const ROLE_LABEL = Object.freeze({
  user: "User",
  assistant: "Assistant",
  tool: "Tool result",
  function: "Tool result",
});

function partText(part) {
  if (typeof part === "string") return part;
  if (!part || typeof part !== "object") return "";
  if (typeof part.text === "string") return part.text;
  // The router's vision bridge sits upstream of every provider, so an image
  // part reaching here came from a caller that skipped it. Naming the gap is
  // more useful than dropping the part silently or failing the whole turn --
  // cursor-agent -p has no way to accept the bytes either way.
  if (part.type === "image_url" || part.type === "input_image") {
    return "[image omitted: cursor-agent accepts text prompts only]";
  }
  return "";
}

export function messageText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map(partText).filter(Boolean).join("\n");
  }
  return "";
}

function toolCallSummary(message) {
  const calls = Array.isArray(message?.tool_calls) ? message.tool_calls : [];
  return calls
    .map((call) => {
      const name = String(call?.function?.name || call?.name || "tool").trim();
      const args = String(call?.function?.arguments || "").trim();
      return `Assistant called ${name}${args ? ` with ${args}` : ""}`;
    })
    .join("\n");
}

const SYSTEM_ROLES = new Set(["system", "developer"]);

/**
 * One chat-completions `messages` array, flattened into one prompt.
 *
 * cursor-agent has its own session store and its own idea of a conversation,
 * but the router is the thing that owns conversation state here -- every turn
 * arrives complete, and reusing a Cursor session would make the same request
 * produce different answers depending on what a previous caller happened to
 * say. So each turn is a fresh, stateless run and the history is rendered into
 * the prompt.
 */
export function buildCursorPrompt(messages) {
  const list = Array.isArray(messages) ? messages : [];
  const system = [];
  const turns = [];
  for (const message of list) {
    const role = String(message?.role || "user").toLowerCase();
    const text = messageText(message?.content);
    if (SYSTEM_ROLES.has(role)) {
      if (text) system.push(text);
      continue;
    }
    const body = role === "assistant" ? [text, toolCallSummary(message)].filter(Boolean).join("\n") : text;
    if (body) turns.push({ role, text: body });
  }
  const preamble = system.join("\n\n").trim();
  // The overwhelmingly common shape is one system prompt and one user turn.
  // Wrapping that in transcript scaffolding would put "User:" in front of a
  // question nobody asked in a conversation, which measurably changes how an
  // agent answers it.
  if (turns.length === 1 && turns[0].role === "user") {
    return [preamble, turns[0].text].filter(Boolean).join("\n\n");
  }
  if (!turns.length) return preamble;
  const transcript = turns
    .map((turn) => `${ROLE_LABEL[turn.role] || "User"}: ${turn.text}`)
    .join("\n\n");
  return [
    preamble,
    "Below is the conversation so far.",
    transcript,
    "Reply to the final message. Answer directly, with no transcript prefix of your own.",
  ]
    .filter(Boolean)
    .join("\n\n");
}

/**
 * Incremental NDJSON reader.
 *
 * cursor-agent writes one JSON object per line, but a pipe splits on buffer
 * boundaries and not on newlines, so a naive `chunk.split("\n").map(JSON.parse)`
 * corrupts any event that straddles a read -- which in practice is every long
 * assistant delta.
 */
export function createEventReader() {
  let buffer = "";
  return {
    push(chunk) {
      buffer += String(chunk);
      const events = [];
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (line) {
          try {
            events.push(JSON.parse(line));
          } catch {
            // Not our line. cursor-agent occasionally writes an unstructured
            // warning to stdout ahead of the stream; dropping it is right,
            // aborting the turn over it is not.
          }
        }
        newline = buffer.indexOf("\n");
      }
      return events;
    },
    // Whatever is left when the process exits without a trailing newline.
    flush() {
      const line = buffer.trim();
      buffer = "";
      if (!line) return [];
      try {
        return [JSON.parse(line)];
      } catch {
        return [];
      }
    },
  };
}

/**
 * The text an `assistant` event carries, whether delta or whole message.
 */
export function assistantText(event) {
  if (event?.type !== "assistant") return "";
  const content = event?.message?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((part) => part?.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("");
}

/**
 * Accumulates assistant text without counting the same words twice.
 *
 * `--stream-partial-output` does not replace the message-level emitter, it
 * runs *alongside* it: cursor-agent writes one `assistant` event per text
 * delta and then a final one carrying the whole accumulated message. A live
 * turn answering "391" produces two `assistant` events both reading "391", so
 * concatenating every one of them streams "391391" to the caller. Reading the
 * bundle suggested the emitters were alternatives; they are not, and only a
 * real turn showed it.
 *
 * The flush is identified by what makes it a flush: its text is everything
 * accumulated so far. Compared against the accumulator rather than keyed on
 * `timestamp_ms`, which the message-level emitter sets conditionally and so
 * cannot be relied on to tell the two apart.
 */
export function createAssistantAccumulator() {
  let accumulated = "";
  return {
    /** The new text this event contributes -- "" when it is a repeat flush. */
    push(event) {
      const text = assistantText(event);
      if (!text) return "";
      // The whole message again: nothing new to emit.
      if (accumulated && text === accumulated) return "";
      // A flush that restates everything and adds a tail: emit only the tail.
      if (accumulated && text.startsWith(accumulated)) {
        const tail = text.slice(accumulated.length);
        accumulated = text;
        return tail;
      }
      accumulated += text;
      return text;
    },
    text() {
      return accumulated;
    },
  };
}

export function isResult(event) {
  return event?.type === "result";
}

function positiveInteger(value) {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

// cursor-agent reports usage under two spellings depending on which emitter
// produced the result. The bundle's snake_case form is what a read of the
// source suggests; the first live turn through this bridge returned camelCase
// (`{"inputTokens":18951,"outputTokens":53,"cacheReadTokens":3200}`), and
// reading only the documented one meant every real turn silently reported no
// usage at all. Accept both rather than betting on which emitter runs.
function usageField(usage, ...names) {
  for (const name of names) {
    const value = positiveInteger(usage[name]);
    if (value) return value;
  }
  return 0;
}

/**
 * Cursor's usage block, in the field names chat-completions callers read.
 *
 * `input_tokens` already excludes the cached counts in the shape the CLI
 * emits, so the totals are added rather than assumed to overlap. A turn that
 * reports nothing yields undefined instead of a row of zeros -- the router's
 * usage accounting distinguishes "no data" from "no tokens", and zeros would
 * be recorded as a genuine free turn.
 */
export function usageFromResult(event) {
  const usage = event?.usage;
  if (!usage || typeof usage !== "object") return undefined;
  const prompt = usageField(usage, "input_tokens", "inputTokens");
  const completion = usageField(usage, "output_tokens", "outputTokens");
  const cacheRead = usageField(usage, "cache_read_tokens", "cacheReadTokens");
  const cacheWrite = usageField(usage, "cache_write_tokens", "cacheWriteTokens");
  if (!prompt && !completion && !cacheRead && !cacheWrite) return undefined;
  return {
    prompt_tokens: prompt + cacheRead + cacheWrite,
    completion_tokens: completion,
    total_tokens: prompt + cacheRead + cacheWrite + completion,
    ...(cacheRead
      ? { prompt_tokens_details: { cached_tokens: cacheRead } }
      : {}),
  };
}

/**
 * Did the run fail, and what should the caller be told?
 *
 * `is_error` is the CLI's own verdict and is trusted; the message is whatever
 * it put in `result`, because that is where a refusal, a quota error, and a
 * model-not-entitled error all land.
 */
export function resultError(event) {
  if (!isResult(event)) return undefined;
  if (event.is_error !== true && event.subtype !== "error") return undefined;
  const text = String(event.result || event.error || "").trim();
  return text || "cursor-agent reported an error with no detail";
}

export function resultText(event) {
  return isResult(event) ? String(event.result || "") : "";
}
