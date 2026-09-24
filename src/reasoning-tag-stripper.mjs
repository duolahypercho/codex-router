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

// Hy4 Preview writes its native markup with a per-message nonce suffix --
// `</think:6124c78e>`, the same delimiter family as the `<tool_calls:6124c78e>`
// calls `src/leaked-tool-call-recovery.mjs` parses back into real tool calls. A
// serving stack that consumes the opening tag but relays the close leaves the
// model's planning prose in `output_text`, terminated by an orphan
// `</think:NONCE>` (#654, reproduced on `commandcode/hy4-preview`: several
// stored assistant messages carried internal prose and that delimiter, an
// 8-character hex nonce, with no matching open anywhere in the message; one
// turn ended on `</arg_value:NONCE>` instead). The bare grammar above sees
// neither spelling, so Hy4 routes get a second grammar that reads the suffix --
// and, because an orphan close means the reasoning it was closing has already
// been written to the visible channel, drops the text in front of it.
//
// Both extensions are gated (`nonceDelimiters`) to the routes that speak this
// markup, for the same reason the tool-call recovery is. A nonce-suffixed
// delimiter is unmistakable, but "everything before this is not the answer" is
// a destructive reading to hand to prose that merely quotes one. A plain
// `</think>` therefore keeps its prefix on every route, gated or not: that
// spelling is ordinary enough to appear in an answer *about* reasoning tags.
const MAX_NONCE = 32;
// These names open no span of their own here. A `<tool_calls:N>...` span is the
// recovery transform's business -- it runs first, and deliberately relays a span
// it cannot parse verbatim so a human can see what the model wrote -- and
// re-reading one as reasoning would delete that verbatim relay. They join the
// grammar only so an *orphan* close, the one shape recovery cannot repair
// because its opening tag never arrived, terminates the leak the way
// `</think:NONCE>` does.
const NONCE_MARKUP_NAMES = ["tool_calls", "tool_call", "arg_key", "arg_value"];
const NONCE_CHARS = /^[0-9a-zA-Z]*$/;
// Ceiling on the leading whitespace the streaming stripper will hold back while
// it waits to learn whether a tag is coming. Every observed leak opens its
// reasoning tag in the first delta, so a message that has produced this much
// whitespace and nothing else is not a leak -- it is an answer whose own
// indentation must be emitted rather than buffered without bound.
const MAX_PENDING_LEAD = 8192;

const NAMES_ALT = TAG_NAMES.join("|");
const MARKUP_ALT = NONCE_MARKUP_NAMES.join("|");
const SUFFIX = `(?::[0-9a-zA-Z]{1,${MAX_NONCE}})`;

function isReasoningName(name) {
  return TAG_NAMES.includes(name);
}

// Split a matched tag into the parts the machines switch on. `nonce` is the
// empty string for the bare `<think>` spelling.
function parseTag(tag) {
  const opening = tag[1] !== "/";
  const body = tag.slice(opening ? 1 : 2, -1);
  const colon = body.indexOf(":");
  if (colon === -1) return { name: body, nonce: "", opening };
  return { name: body.slice(0, colon), nonce: body.slice(colon + 1), opening };
}

// The next tag in `s` at or after `from`: its index, text, name, nonce and
// direction. `re` must be a global regexp; its `lastIndex` is always set here.
function nextTag(s, from, re) {
  re.lastIndex = from;
  const m = re.exec(s);
  if (!m) return undefined;
  return { at: m.index, tag: m[0], ...parseTag(m[0]) };
}

// Longest suffix of `s` that could still grow into a tag is held back rather
// than emitted as literal text, so a tag split across deltas ("<th" then
// "ink>...", or "</think:61" then "24c78e>") is not missed.
function tagPrefixTest(nonce, names) {
  const prefixes = new Set();
  for (const name of names) {
    for (let i = 1; i <= name.length; i++) prefixes.add(name.slice(0, i));
  }
  const whole = new Set(names);
  return (s) => {
    if (s[0] !== "<") return false;
    let rest = s.slice(1);
    if (rest.startsWith("/")) rest = rest.slice(1);
    if (rest === "") return true;
    const colon = rest.indexOf(":");
    if (colon === -1) return prefixes.has(rest);
    if (!nonce) return false;
    const suffix = rest.slice(colon + 1);
    return whole.has(rest.slice(0, colon)) && suffix.length <= MAX_NONCE && NONCE_CHARS.test(suffix);
  };
}

function buildGrammar(nonce) {
  const tag = nonce
    ? `</?(?:${NAMES_ALT})${SUFFIX}?>|</?(?:${MARKUP_ALT})${SUFFIX}>`
    : `</?(?:${NAMES_ALT})>`;
  const open = nonce ? `<(?:${NAMES_ALT})${SUFFIX}?>|<(?:${MARKUP_ALT})${SUFFIX}>` : `<(?:${NAMES_ALT})>`;
  const close = nonce ? `</(?:${NAMES_ALT})${SUFFIX}?>` : `</(?:${NAMES_ALT})>`;
  const names = nonce ? [...TAG_NAMES, ...NONCE_MARKUP_NAMES] : TAG_NAMES;
  return {
    nonce,
    // Every tag the machines react to, in stream order.
    tagRe: new RegExp(tag, "g"),
    // Reasoning closes only: what ends a think span.
    closeRe: new RegExp(close, "g"),
    openRe: new RegExp(open, "g"),
    // Open-to-nearest-close, any reasoning name to any reasoning name
    // (non-greedy) -- matches the streaming machine, which closes on the first
    // close tag it sees.
    spanRe: new RegExp(`(?:<(?:${NAMES_ALT})${nonce ? `${SUFFIX}?` : ""}>)[\\s\\S]*?(?:${close})`, "g"),
    orphanRe: new RegExp(`</?(?:${NAMES_ALT})${nonce ? `${SUFFIX}?` : ""}>`, "g"),
    hasRe: new RegExp(tag),
    isTagPrefix: tagPrefixTest(nonce, names),
    maxTagLen: Math.max(
      ...names.map((name) => name.length + 3 + (nonce ? MAX_NONCE + 1 : 0)),
    ),
  };
}

const PLAIN_GRAMMAR = buildGrammar(false);
const NONCE_GRAMMAR = buildGrammar(true);

function grammarFor(options) {
  return options?.nonceDelimiters === true ? NONCE_GRAMMAR : PLAIN_GRAMMAR;
}

// Index just past the last close tag that terminates leaked reasoning: a
// nonce-suffixed close, outside any think span, whose matching open has not
// appeared earlier in the message. Walks the same state machine as the stream
// so the two agree on which closes are orphans. 0 when there is none.
function terminatorEnd(text, grammar) {
  const opened = new Set();
  let cut = 0;
  let think = false;
  for (let m = nextTag(text, 0, grammar.tagRe); m; m = nextTag(text, m.at + m.tag.length, grammar.tagRe)) {
    const key = `${m.name}:${m.nonce}`;
    if (m.opening) {
      if (m.nonce) opened.add(key);
      if (!think && isReasoningName(m.name)) think = true;
      continue;
    }
    if (think) {
      if (isReasoningName(m.name)) think = false;
      continue;
    }
    if (m.nonce && !opened.has(key)) cut = m.at + m.tag.length;
  }
  return cut;
}

// Strip reasoning tags from a complete string. Used for `output_text.done` and
// stored message content, where the whole text is in hand.
export function stripThinkTags(text, options) {
  if (typeof text !== "string") return text;
  const grammar = grammarFor(options);
  if (!grammar.hasRe.test(text)) return text;
  const cut = grammar.nonce ? terminatorEnd(text, grammar) : 0;
  let stripped = text.slice(cut).replace(grammar.spanRe, "").replace(grammar.orphanRe, "");
  // A stripped leading block leaves the whitespace that framed it; drop it so the
  // answer does not render behind a blank line. Only when something was removed.
  if (stripped !== text) stripped = stripped.replace(/^\s+/, "");
  return stripped;
}

// Incremental stripper for the streamed delta channel. `feed` returns the text
// safe to emit so far; `flush` returns whatever remains once the stream ends.
// The concatenation of every `feed`/`flush` return equals `stripThinkTags` of
// the concatenated input, with one unavoidable exception: text the stream has
// already emitted cannot be retracted. That covers `stripThinkTags` dropping the
// message's leading whitespace whenever it removed a tag *anywhere*, including
// one that appears after visible text has already been streamed, and -- on the
// gated nonce grammar -- the reasoning prose in front of an orphan
// `</think:NONCE>`, which is only knowable as reasoning once that close arrives.
// Every case where the removal is knowable by the time the first visible
// character is emitted -- which is every whitespace case, since the reasoning
// block is what comes first -- does agree. A message that opens with more than
// `MAX_PENDING_LEAD` bytes of unbroken whitespace settles the same way, for the
// same reason. All of it is display-only: `output_text.done` and
// `output_item.done` bypass this class and clean the complete text through
// `stripThinkTags`, so the stored and re-rendered message is correct regardless.
class ThinkStreamStripper {
  #grammar;
  #mode = "normal";
  #carry = "";
  #leadSettled = false;
  #removedTag = false;
  #pendingLead = "";
  // `name:nonce` of every opening tag seen so far, so a close that repeats one
  // is read as the end of its own span rather than as a leak terminator.
  #opened = new Set();

  constructor(grammar = PLAIN_GRAMMAR) {
    this.#grammar = grammar;
  }

  #partialHold(s) {
    const max = Math.min(s.length, this.#grammar.maxTagLen - 1);
    for (let k = max; k >= 1; k--) {
      if (this.#grammar.isTagPrefix(s.slice(s.length - k))) return k;
    }
    return 0;
  }

  // Opening tags inside a discarded think span still count as seen, or the
  // close that matches one would look like an orphan terminator afterwards.
  #noteOpens(discarded) {
    if (!this.#grammar.nonce || !discarded) return;
    for (
      let m = nextTag(discarded, 0, this.#grammar.openRe);
      m;
      m = nextTag(discarded, m.at + m.tag.length, this.#grammar.openRe)
    ) {
      if (m.nonce) this.#opened.add(`${m.name}:${m.nonce}`);
    }
  }

  feed(chunk) {
    this.#carry += chunk;
    let out = "";
    for (;;) {
      if (this.#mode === "normal") {
        const found = nextTag(this.#carry, 0, this.#grammar.tagRe);
        if (found) {
          const head = this.#carry.slice(0, found.at);
          this.#carry = this.#carry.slice(found.at + found.tag.length);
          const key = `${found.name}:${found.nonce}`;
          if (found.opening) {
            if (found.nonce) this.#opened.add(key);
            if (isReasoningName(found.name)) {
              out += head;
              this.#removedTag = true;
              this.#mode = "think";
            } else {
              // Tool-call markup: left exactly as the model wrote it.
              out += head + found.tag;
            }
            continue;
          }
          if (found.nonce && !this.#opened.has(key)) {
            // An orphan nonce close terminates leaked reasoning: everything in
            // front of it belongs to the reasoning channel. Only what this
            // stripper still holds can be taken back -- bytes already emitted on
            // earlier deltas are gone, and the `.done`/item snapshots are what
            // make the stored message right.
            out = "";
            this.#removedTag = true;
            this.#leadSettled = false;
            this.#pendingLead = "";
            continue;
          }
          if (isReasoningName(found.name)) {
            out += head;
            this.#removedTag = true;
          } else {
            out += head + found.tag;
          }
          continue;
        }
        const hold = this.#partialHold(this.#carry);
        out += this.#carry.slice(0, this.#carry.length - hold);
        this.#carry = this.#carry.slice(this.#carry.length - hold);
        break;
      }
      // think mode: discard until the first close tag, holding a possible partial.
      const close = nextTag(this.#carry, 0, this.#grammar.closeRe);
      if (close) {
        this.#noteOpens(this.#carry.slice(0, close.at));
        this.#carry = this.#carry.slice(close.at + close.tag.length);
        this.#removedTag = true;
        this.#mode = "normal";
        continue;
      }
      const hold = this.#partialHold(this.#carry);
      this.#noteOpens(this.#carry.slice(0, this.#carry.length - hold));
      this.#carry = this.#carry.slice(this.#carry.length - hold);
      break;
    }
    return this.#lead(out);
  }

  flush() {
    // Unterminated reasoning (still in think mode) is discarded; normal-mode
    // remainder -- including a lone `<` that never became a tag -- is emitted.
    const out = this.#mode === "normal" ? this.#carry : "";
    this.#carry = "";
    const tail = this.#lead(out);
    if (tail) return tail;
    // A message that was only ever whitespace still ends as that whitespace
    // unless a tag was stripped out of it.
    const held = this.#removedTag ? "" : this.#pendingLead;
    this.#pendingLead = "";
    return held;
  }

  // `stripThinkTags` drops the message's leading whitespace only when it
  // actually removed a tag; an untouched message keeps its own indentation and
  // is returned by identity. The stream cannot know which case it is in until
  // it reaches the first visible character, so hold that whitespace back rather
  // than emitting it (which would keep it in text a tag is about to be stripped
  // from) or dropping it (which would eat it from a message that has no tags at
  // all -- every ordinary answer that happens to begin with a newline).
  //
  // Holding is bounded on both axes. Once a tag has been removed the answer is
  // known to be trimmed, so nothing is held at all. Otherwise only the new
  // chunk is scanned -- `#pendingLead` is whitespace by construction, so
  // re-trimming the accumulation would cost O(n) per delta and O(n^2) over a
  // run of whitespace-only ones -- and the accumulation gives up at
  // `MAX_PENDING_LEAD`, emitting what it holds instead of growing further.
  #lead(out) {
    if (this.#leadSettled) return out;
    if (!out) return "";
    const visibleAt = out.search(/\S/);
    if (this.#removedTag) {
      // A tag is already gone, so this message's leading whitespace is trimmed
      // either way and none of it needs keeping.
      this.#pendingLead = "";
      if (visibleAt === -1) return "";
      this.#leadSettled = true;
      return out.slice(visibleAt);
    }
    if (visibleAt === -1) {
      if (this.#pendingLead.length + out.length > MAX_PENDING_LEAD) {
        // Past the ceiling this is the answer's own whitespace, not a preamble
        // to a tag. Emit it and stop holding; a tag arriving after this point
        // is the documented case the stream cannot retract.
        const settled = this.#pendingLead + out;
        this.#pendingLead = "";
        this.#leadSettled = true;
        return settled;
      }
      this.#pendingLead += out;
      return "";
    }
    this.#leadSettled = true;
    const held = this.#pendingLead;
    this.#pendingLead = "";
    return held + out;
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

function cleanMessageItem(item, options) {
  if (item?.type !== "message" || !Array.isArray(item.content)) return item;
  let changed = false;
  const content = item.content.map((part) => {
    if (part?.type === "output_text" && typeof part.text === "string") {
      const cleaned = stripThinkTags(part.text, options);
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
  #options;
  #grammar;

  // `nonceDelimiters: true` adds Hy4's `</think:NONCE>` family to the grammar
  // and the orphan-close rule that goes with it. Off by default: see the note
  // on `NONCE_MARKUP_NAMES`.
  constructor(options = {}) {
    super();
    this.#options = options;
    this.#grammar = grammarFor(options);
  }

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
      stream = new ThinkStreamStripper(this.#grammar);
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
      const cleaned = stripThinkTags(event.text, this.#options);
      if (cleaned === event.text) return block;
      return rewrittenBlock(parsed, { ...event, text: cleaned });
    }

    if (type === "response.output_item.done" && event?.item?.type === "message") {
      const item = cleanMessageItem(event.item, this.#options);
      if (item === event.item) return block;
      return rewrittenBlock(parsed, { ...event, item });
    }

    return block;
  }
}

export function reasoningTagStripperTransform(contentType = "", options = {}) {
  if (!String(contentType).toLowerCase().includes("text/event-stream")) return undefined;
  return new ReasoningTagStripper(options);
}
