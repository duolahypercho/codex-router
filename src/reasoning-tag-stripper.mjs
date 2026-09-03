import { Transform } from "node:stream";

// Qwen (and other reasoning models bridged through LiteLLM's chat-completions
// -> Responses path) sometimes emit their chain-of-thought inline in the
// content channel as `<think>...</think>` instead of on the structured
// reasoning channel. LiteLLM relays that inline block as ordinary
// `output_text`, so the visible answer is prefixed with the model's reasoning
// and, when the opening tag is consumed upstream but the close is not, with a
// bare `</think>`:
//
//   output_text = "<think>The capital of France is Paris.</think>\nParis"
//   output_text = "\n</think>\n\nThe real answer starts here"
//
// The tags also split across streamed deltas (`"<th"` then `"ink>..."`), so a
// naive per-delta replace misses them. This transform strips `<think>...</think>`
// spans and orphan `<think>`/`</think>` tags from the message text -- across the
// streamed `output_text.delta`s (buffering a possible partial tag), the
// terminal `output_text.done`, and the message item in `output_item.done` (the
// form that gets stored in the rollout). Reasoning that arrives on the proper
// channel (`reasoning_summary_text`) is untouched; so is every non-message item.

// Reasoning-delimiter names a model may leak inline. `<think>` is Qwen's and
// DeepSeek's native form and the only one seen in real sessions, but the same
// model varies the spelling (`<thinking>`, `<reason>`, `<reasoning>` observed
// live), so the whole family is stripped. These names are reasoning scaffolding,
// never prose a caller wants verbatim; the tradeoff is that a routed answer
// which deliberately prints a literal `<reason>` tag would lose it.
const TAG_NAMES = ["thinking", "reasoning", "think", "reason"]; // longest-first
const OPEN_TAGS = TAG_NAMES.map((name) => `<${name}>`);
const CLOSE_TAGS = TAG_NAMES.map((name) => `</${name}>`);
const ALL_TAGS = [...OPEN_TAGS, ...CLOSE_TAGS];
const MAX_TAG_LEN = Math.max(...ALL_TAGS.map((tag) => tag.length));
const NAMES_ALT = TAG_NAMES.join("|");
// Open-to-nearest-close, any name to any name (non-greedy) -- matches the
// streaming machine, which closes on the first close tag it sees.
const SPAN_RE = new RegExp(`<(?:${NAMES_ALT})>[\\s\\S]*?</(?:${NAMES_ALT})>`, "g");
const ORPHAN_RE = new RegExp(`</?(?:${NAMES_ALT})>`, "g");

function hasAnyTag(text) {
  return TAG_NAMES.some((name) => text.includes(`<${name}>`) || text.includes(`</${name}>`));
}

// The earliest tag in `s`: its index, length, and whether it opens a span.
function firstTag(s, tags) {
  let at = -1;
  let tag;
  for (const candidate of tags) {
    const i = s.indexOf(candidate);
    if (i !== -1 && (at === -1 || i < at)) {
      at = i;
      tag = candidate;
    }
  }
  return at === -1 ? undefined : { at, tag, opening: OPEN_TAGS.includes(tag) };
}

// Strip reasoning tags from a complete string. Used for `output_text.done` and
// stored message content, where the whole text is in hand.
export function stripThinkTags(text) {
  if (typeof text !== "string" || !hasAnyTag(text)) return text;
  let stripped = text.replace(SPAN_RE, "").replace(ORPHAN_RE, "");
  // A stripped leading block leaves the whitespace that framed it; drop it so the
  // answer does not render behind a blank line. Only when something was removed.
  if (stripped !== text) stripped = stripped.replace(/^\s+/, "");
  return stripped;
}

// Incremental stripper for the streamed delta channel. `feed` returns the text
// safe to emit so far; `flush` returns whatever remains once the stream ends.
// The concatenation of every `feed`/`flush` return equals `stripThinkTags` of
// the concatenated input.
class ThinkStreamStripper {
  #mode = "normal";
  #carry = "";
  #emittedVisible = false;

  // Longest suffix of `s` that is a proper prefix of any tag, so a tag split
  // across deltas is held back rather than emitted as literal text.
  #partialHold(s) {
    const max = Math.min(s.length, MAX_TAG_LEN - 1);
    for (let k = max; k >= 1; k--) {
      const suffix = s.slice(s.length - k);
      if (ALL_TAGS.some((tag) => tag.startsWith(suffix))) return k;
    }
    return 0;
  }

  feed(chunk) {
    this.#carry += chunk;
    let out = "";
    for (;;) {
      if (this.#mode === "normal") {
        const found = firstTag(this.#carry, ALL_TAGS);
        if (found) {
          out += this.#carry.slice(0, found.at);
          this.#carry = this.#carry.slice(found.at + found.tag.length);
          // Opening a span enters think mode; an orphan close is just dropped.
          if (found.opening) this.#mode = "think";
          continue;
        }
        const hold = this.#partialHold(this.#carry);
        out += this.#carry.slice(0, this.#carry.length - hold);
        this.#carry = this.#carry.slice(this.#carry.length - hold);
        break;
      }
      // think mode: discard until the first close tag, holding a possible partial.
      const close = firstTag(this.#carry, CLOSE_TAGS);
      if (close) {
        this.#carry = this.#carry.slice(close.at + close.tag.length);
        this.#mode = "normal";
        continue;
      }
      const hold = this.#partialHold(this.#carry);
      this.#carry = this.#carry.slice(this.#carry.length - hold);
      break;
    }
    return this.#leadTrim(out);
  }

  flush() {
    // Unterminated reasoning (still in think mode) is discarded; normal-mode
    // remainder -- including a lone `<` that never became a tag -- is emitted.
    const out = this.#mode === "normal" ? this.#carry : "";
    this.#carry = "";
    return this.#leadTrim(out);
  }

  // Trim leading whitespace only until the first visible character of the whole
  // message, matching `stripThinkTags`'s single leading trim.
  #leadTrim(out) {
    if (this.#emittedVisible) return out;
    const trimmed = out.replace(/^\s+/, "");
    if (trimmed.length > 0) this.#emittedVisible = true;
    return trimmed;
  }
}

function eventBlock(block) {
  const newline = block.includes("\r\n") ? "\r\n" : "\n";
  const lines = block.split(/\r?\n/);
  const dataLineIndex = lines.findIndex((line) => line.startsWith("data:"));
  if (dataLineIndex === -1) return undefined;
  const dataText = lines[dataLineIndex].slice(5).replace(/^ /, "");
  if (!dataText || dataText === "[DONE]") return undefined;
  try {
    return { lines, dataLineIndex, newline, event: JSON.parse(dataText) };
  } catch {
    return undefined;
  }
}

function rewrittenBlock(parsed, event) {
  const lines = [...parsed.lines];
  lines[parsed.dataLineIndex] = `data: ${JSON.stringify(event)}`;
  return lines.join(parsed.newline);
}

function cleanMessageItem(item) {
  if (item?.type !== "message" || !Array.isArray(item.content)) return item;
  let changed = false;
  const content = item.content.map((part) => {
    if (part?.type === "output_text" && typeof part.text === "string") {
      const cleaned = stripThinkTags(part.text);
      if (cleaned !== part.text) {
        changed = true;
        return { ...part, text: cleaned };
      }
    }
    return part;
  });
  return changed ? { ...item, content } : item;
}

const CRLF_SEP = Buffer.from("\r\n\r\n");
const LF_SEP = Buffer.from("\n\n");

function fatalUtf8(buffer) {
  return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(buffer);
}

function findFrameEnd(buffer) {
  const crlf = buffer.indexOf(CRLF_SEP);
  const lf = buffer.indexOf(LF_SEP);
  if (crlf !== -1 && (lf === -1 || crlf <= lf)) {
    return { index: crlf, separator: CRLF_SEP };
  }
  if (lf !== -1) return { index: lf, separator: LF_SEP };
  return undefined;
}

export class ReasoningTagStripper extends Transform {
  #buffer = Buffer.alloc(0);
  #passthrough = false;
  // One streaming stripper per message output index.
  #streams = new Map();

  _transform(chunk, encoding, callback) {
    const piece = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding);
    if (this.#passthrough) {
      this.push(piece);
      callback();
      return;
    }
    this.#buffer = this.#buffer.length ? Buffer.concat([this.#buffer, piece]) : piece;
    this.#emitBlocks(false);
    callback();
  }

  _flush(callback) {
    if (this.#passthrough) {
      if (this.#buffer.length) this.push(this.#buffer);
      this.#buffer = Buffer.alloc(0);
      callback();
      return;
    }
    this.#emitBlocks(true);
    callback();
  }

  #disable(original) {
    if (original?.length) this.push(original);
    if (this.#buffer.length) {
      this.push(this.#buffer);
      this.#buffer = Buffer.alloc(0);
    }
    this.#passthrough = true;
  }

  #streamFor(index) {
    const key = Number.isInteger(index) ? index : 0;
    let stream = this.#streams.get(key);
    if (!stream) {
      stream = new ThinkStreamStripper();
      this.#streams.set(key, stream);
    }
    return stream;
  }

  #emitBlocks(flush) {
    while (this.#buffer.length && !this.#passthrough) {
      const found = findFrameEnd(this.#buffer);
      if (!found) {
        if (!flush) return;
        const original = this.#buffer;
        this.#buffer = Buffer.alloc(0);
        this.#emitFrame(original, Buffer.alloc(0));
        return;
      }
      const block = this.#buffer.subarray(0, found.index);
      const separator = found.separator;
      const original = this.#buffer.subarray(0, found.index + separator.length);
      this.#buffer = this.#buffer.subarray(found.index + separator.length);
      this.#emitFrame(original, separator, block);
    }
  }

  #emitFrame(original, separator, block = original) {
    let text;
    try {
      text = fatalUtf8(block);
    } catch {
      this.#disable(original);
      return;
    }
    const piece = this.#rewrite(text);
    if (piece === null) return;
    if (piece === text) {
      this.push(Buffer.from(original));
      return;
    }
    this.push(Buffer.concat([Buffer.from(piece), separator]));
  }

  // Returns the (possibly rewritten) block text, or null to drop it (an
  // `output_text.delta` whose entire payload was reasoning).
  #rewrite(block) {
    const parsed = eventBlock(block);
    if (!parsed) return block;
    const event = parsed.event;
    const type = event?.type;

    if (type === "response.output_text.delta" && typeof event.delta === "string") {
      const cleaned = this.#streamFor(event.output_index).feed(event.delta);
      if (cleaned === event.delta) return block;
      if (cleaned.length === 0) return null;
      return rewrittenBlock(parsed, { ...event, delta: cleaned });
    }

    if (type === "response.output_text.done" && typeof event.text === "string") {
      // Settle the streaming state so a trailing partial tag is resolved, and
      // rewrite the terminal full-text snapshot to the cleaned form.
      this.#streamFor(event.output_index).flush();
      const cleaned = stripThinkTags(event.text);
      if (cleaned === event.text) return block;
      return rewrittenBlock(parsed, { ...event, text: cleaned });
    }

    if (type === "response.output_item.done" && event?.item?.type === "message") {
      const item = cleanMessageItem(event.item);
      if (item === event.item) return block;
      return rewrittenBlock(parsed, { ...event, item });
    }

    return block;
  }
}

export function reasoningTagStripperTransform(contentType = "") {
  if (!String(contentType).toLowerCase().includes("text/event-stream")) return undefined;
  return new ReasoningTagStripper();
}
