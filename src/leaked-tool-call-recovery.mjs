import { randomUUID } from "node:crypto";
import { Transform } from "node:stream";

// Tencent Hy4 Preview has a native tool-call syntax of its own. When a serving
// stack fails to parse it, the model's calls arrive as ordinary *text* on the
// reasoning channel and nothing reaches the `tool_calls` array, so LiteLLM's
// chat-completions -> Responses bridge relays a reasoning item followed by an
// assistant message with empty content and no `function_call`:
//
//   ...Let me keep reading the behavior code while it comes up.
//   <tool_calls:6124c78e><tool_call:6124c78e>exec_command
//     <arg_key:6124c78e>cmd</arg_key:6124c78e>
//     <arg_value:6124c78e>tail -5 .qa/eo-up.log</arg_value:6124c78e>
//   </tool_call:6124c78e></tool_calls:6124c78e>
//
// Codex reads that as "an assistant message with nothing in it", ends the turn,
// and writes `task_complete` with `last_agent_message: null`. The user sees the
// "Worked for 3m 58s" group and no answer at all -- the turn dies silently in
// the middle of the model's own work.
//
// This transform parses the leaked markup back into real `function_call` output
// items and strips it from the text it was buried in. The calls are the model's
// own -- nothing here authors a call the model did not write, and a stream
// without the markup is passed through byte-for-byte.
//
// The delimiter carries a per-family constant (`6124c78e` in every capture to
// date, on both the commandcode and opencode-go routes), but it is read from
// the opening tag rather than hardcoded, and the closing tag must repeat it.
//
// Text held back while a span is still open is released as soon as the span
// resolves one way or the other. The one case it is not is a stream that ends
// mid-span with no `.done` snapshot and no stored item: those delta bytes are
// dropped rather than relayed as half a tag. The item's own text is cleaned
// independently, so the transcript still carries what the model wrote.

// Hy4 Preview is the only family that emits this syntax, so it is the only one
// whose text is reinterpreted. Scanning every routed provider would make any
// prose that merely *quotes* the markup -- a diff, a web page, this repository's
// own source -- into executed tool calls, which is a prompt-injection channel
// rather than a repair. `upstreamModel` carries it on every shipped route
// (`hy4-preview` on opencode Go, `tencent/hy4-preview` elsewhere), including
// the Command Code route that ships no `requestProfile`.
export function usesLeakedToolCallRecovery(route) {
  const upstream = route?.upstreamModel;
  return typeof upstream === "string" && /(?:^|\/)hy4-preview$/.test(upstream);
}

const OPEN_MARKER = "<tool_calls:";
const NONCE = "[0-9a-zA-Z]{1,32}";
const OPEN_RE = new RegExp(`^<tool_calls:(${NONCE})>`);
// Longest an opening tag can be before it is decidably not one.
const MAX_OPEN_LEN = OPEN_MARKER.length + 32 + 1;
// A captured span holds the model's tool arguments, which can be a sizable
// patch or file body. Bound it anyway: past this the capture is released
// verbatim and recovery gives up for the rest of the stream rather than
// buffering an unterminated span without limit.
const MAX_CAPTURE_BYTES = 4 * 1024 * 1024;
// Tool names Codex accepts, including the flattened `mcp__server__tool` form.
const NAME_RE = /^[A-Za-z0-9_.-]{1,128}$/;

// A leaked argument value is always written as text. Accept the JSON reading
// only when the text *is* its own JSON form -- `20000` -> 20000, `true` -> true,
// `{"a":1}` -> the object -- so a declared number or boolean survives the round
// trip. Everything else (shell commands, paths, prose, `0755`) stays the exact
// string the model wrote. The one casualty is an argument whose intended string
// value is also valid JSON, such as a literal "123"; that is rarer than a
// genuine numeric argument, and both shapes are visible in the relayed call.
function readArgumentValue(raw) {
  try {
    const parsed = JSON.parse(raw);
    if (JSON.stringify(parsed) === raw) return parsed;
  } catch {
    // Not JSON at all: the common case.
  }
  return raw;
}

// Parse the inside of one `<tool_calls:N>...</tool_calls:N>` span. Returns
// undefined -- leaving the span verbatim -- on anything malformed, so text that
// merely resembles the markup is never eaten.
function parseSpanBody(body, nonce) {
  const openCall = `<tool_call:${nonce}>`;
  const closeCall = `</tool_call:${nonce}>`;
  const openKey = `<arg_key:${nonce}>`;
  const closeKey = `</arg_key:${nonce}>`;
  const openValue = `<arg_value:${nonce}>`;
  const closeValue = `</arg_value:${nonce}>`;
  const calls = [];
  let rest = body;
  while (rest.trim()) {
    const start = rest.indexOf(openCall);
    if (start === -1) return undefined;
    const end = rest.indexOf(closeCall, start + openCall.length);
    if (end === -1) return undefined;
    const inner = rest.slice(start + openCall.length, end);
    rest = rest.slice(end + closeCall.length);

    // The name is the bare text between the call tag and its first argument.
    const firstKey = inner.indexOf(openKey);
    const name = (firstKey === -1 ? inner : inner.slice(0, firstKey)).trim();
    if (!NAME_RE.test(name)) return undefined;

    const args = {};
    let argsRest = firstKey === -1 ? "" : inner.slice(firstKey);
    while (argsRest.includes(openKey)) {
      const keyStart = argsRest.indexOf(openKey);
      const keyEnd = argsRest.indexOf(closeKey, keyStart + openKey.length);
      if (keyEnd === -1) return undefined;
      const valueStart = argsRest.indexOf(openValue, keyEnd + closeKey.length);
      if (valueStart === -1) return undefined;
      const valueEnd = argsRest.indexOf(closeValue, valueStart + openValue.length);
      if (valueEnd === -1) return undefined;
      const key = argsRest.slice(keyStart + openKey.length, keyEnd);
      if (!key) return undefined;
      args[key] = readArgumentValue(argsRest.slice(valueStart + openValue.length, valueEnd));
      argsRest = argsRest.slice(valueEnd + closeValue.length);
    }
    calls.push({ name, arguments: JSON.stringify(args) });
  }
  return calls.length ? calls : undefined;
}

// Strip every well-formed leaked span from a complete string and return the
// calls it carried. Returns undefined when the text carries no recoverable
// call, so callers can relay the original untouched.
export function parseLeakedToolCalls(text) {
  if (typeof text !== "string" || !text.includes(OPEN_MARKER)) return undefined;
  const calls = [];
  let cleaned = "";
  let rest = text;
  for (;;) {
    const at = rest.indexOf(OPEN_MARKER);
    if (at === -1) {
      cleaned += rest;
      break;
    }
    const head = OPEN_RE.exec(rest.slice(at));
    if (!head) {
      // `<tool_calls:` without a well-formed nonce and `>`: ordinary text.
      cleaned += rest.slice(0, at + OPEN_MARKER.length);
      rest = rest.slice(at + OPEN_MARKER.length);
      continue;
    }
    const closeTag = `</tool_calls:${head[1]}>`;
    const closeAt = rest.indexOf(closeTag, at + head[0].length);
    if (closeAt === -1) {
      // Unterminated: relay what the model actually wrote.
      cleaned += rest;
      break;
    }
    const parsed = parseSpanBody(rest.slice(at + head[0].length, closeAt), head[1]);
    if (!parsed) {
      cleaned += rest.slice(0, closeAt + closeTag.length);
      rest = rest.slice(closeAt + closeTag.length);
      continue;
    }
    cleaned += rest.slice(0, at);
    calls.push(...parsed);
    rest = rest.slice(closeAt + closeTag.length);
  }
  if (!calls.length) return undefined;
  // The markup follows the model's last sentence; drop the gap it left behind.
  return { cleaned: cleaned.replace(/\s+$/, ""), calls };
}

// Incremental stripper for one output item's delta channel. `feed` returns the
// text safe to emit so far and `flush` whatever remains, so a span split across
// deltas is never relayed as visible text. Recovered calls accumulate in
// `calls`.
class LeakedSpanStream {
  calls = [];
  #mode = "normal";
  #carry = "";
  // A span arrives over many deltas. Holding it as one growing string and
  // re-scanning it per delta is quadratic -- every `indexOf` re-flattens the
  // concatenation rope -- and `_transform` is synchronous, so the cost is paid
  // by every concurrent request on the router. Measured before this was made
  // linear: a 1.25 MB unterminated span blocked the event loop for 21.5 s
  // against 0.8 s for the same bytes with no span open, and the capture bound
  // is 4 MiB. So the parts are kept unjoined and each delta is scanned once.
  #parts = [];
  #capturedLen = 0;
  // First bytes only: enough to decide the opening tag, which cannot change.
  #capturedHead = "";
  #head = null;
  // Content not yet scanned for the closing tag, and where it starts in the
  // capture. Carries a closeTag-length overlap so a tag that straddles a delta
  // boundary is still found.
  #unsearched = "";
  #unsearchedBase = 0;
  #bailed = false;

  // Longest suffix of `s` that could still become an opening marker.
  #partialHold(s) {
    const max = Math.min(s.length, OPEN_MARKER.length - 1);
    for (let k = max; k >= 1; k--) {
      if (OPEN_MARKER.startsWith(s.slice(s.length - k))) return k;
    }
    return 0;
  }

  feed(chunk) {
    if (this.#bailed) return chunk;
    let out = "";
    let input = chunk;
    for (;;) {
      if (this.#mode === "normal") {
        this.#carry += input;
        input = "";
        const at = this.#carry.indexOf(OPEN_MARKER);
        if (at === -1) {
          const hold = this.#partialHold(this.#carry);
          out += this.#carry.slice(0, this.#carry.length - hold);
          this.#carry = this.#carry.slice(this.#carry.length - hold);
          return out;
        }
        out += this.#carry.slice(0, at);
        input = this.#carry.slice(at);
        this.#carry = "";
        this.#mode = "capture";
        continue;
      }

      if (input) {
        this.#parts.push(input);
        this.#capturedLen += input.length;
        if (this.#capturedHead.length < MAX_OPEN_LEN) {
          this.#capturedHead = (this.#capturedHead + input).slice(0, MAX_OPEN_LEN);
        }
        this.#unsearched += input;
        input = "";
      }
      // Decided once: the opening tag cannot change as the capture grows.
      const head = this.#head ?? (this.#head = OPEN_RE.exec(this.#capturedHead));
      if (!head) {
        // Still short of a decision, unless it can no longer become a marker.
        if (this.#capturedLen < MAX_OPEN_LEN) {
          this.#head = null;
          return out;
        }
        out += this.#release();
        continue;
      }
      const closeTag = `</tool_calls:${head[1]}>`;
      const at = this.#unsearched.indexOf(closeTag);
      if (at === -1) {
        // Keep only enough to catch a tag split across this boundary.
        const keep = Math.min(this.#unsearched.length, closeTag.length - 1);
        this.#unsearchedBase += this.#unsearched.length - keep;
        this.#unsearched = this.#unsearched.slice(this.#unsearched.length - keep);
        if (this.#capturedLen > MAX_CAPTURE_BYTES) {
          this.#bailed = true;
          out += this.#release();
          return out;
        }
        return out;
      }
      const closeAt = this.#unsearchedBase + at;
      const all = this.#parts.join("");
      const span = all.slice(0, closeAt + closeTag.length);
      const remainder = all.slice(closeAt + closeTag.length);
      const parsed = parseLeakedToolCalls(span);
      this.#resetCapture();
      this.#mode = "normal";
      if (parsed) this.calls.push(...parsed.calls);
      else out += span;
      input = remainder;
    }
  }

  flush() {
    const out = this.#release();
    this.#carry = "";
    return out;
  }

  #resetCapture() {
    this.#parts = [];
    this.#capturedLen = 0;
    this.#capturedHead = "";
    this.#head = null;
    this.#unsearched = "";
    this.#unsearchedBase = 0;
  }

  // Return the buffered text to the visible channel and go back to scanning.
  #release() {
    const out = this.#carry + this.#parts.join("");
    this.#carry = "";
    this.#resetCapture();
    this.#mode = "normal";
    return out;
  }
}

const CRLF_SEP = Buffer.from("\r\n\r\n");
const LF_SEP = Buffer.from("\n\n");

function fatalUtf8(buffer) {
  return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(buffer);
}

function findFrameEnd(buffer) {
  const crlf = buffer.indexOf(CRLF_SEP);
  const lf = buffer.indexOf(LF_SEP);
  if (crlf !== -1 && (lf === -1 || crlf <= lf)) return { index: crlf, separator: CRLF_SEP };
  if (lf !== -1) return { index: lf, separator: LF_SEP };
  return undefined;
}

function eventBlock(block) {
  const newline = block.includes("\r\n") ? "\r\n" : "\n";
  const lines = block.split(/\r?\n/);
  const dataLineIndex = lines.findIndex((line) => line.startsWith("data:"));
  if (dataLineIndex === -1) return undefined;
  const dataText = lines[dataLineIndex].slice(5).replace(/^ /, "");
  if (!dataText) return undefined;
  if (dataText === "[DONE]") return { lines, dataLineIndex, newline, sentinel: true };
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

// Clean the text parts a stored item carries, without collecting from it.
function cleanTextParts(parts, key) {
  if (!Array.isArray(parts)) return { parts, changed: false, calls: [] };
  const calls = [];
  let changed = false;
  const next = parts.map((part) => {
    if (typeof part?.[key] !== "string") return part;
    const parsed = parseLeakedToolCalls(part[key]);
    if (!parsed) return part;
    changed = true;
    calls.push(...parsed.calls);
    return { ...part, [key]: parsed.cleaned };
  });
  return { parts: changed ? next : parts, changed, calls };
}

const TERMINAL_TYPES = new Set(["response.completed", "response.done"]);

export class LeakedToolCallRecovery extends Transform {
  #buffer = Buffer.alloc(0);
  #passthrough = false;
  #streams = new Map();
  // Per output index, the signatures already recovered from it. One item's text
  // reaches this transform up to three times -- as deltas, as the `.done`
  // snapshot, and inside the stored item -- and each reading is cumulative, so
  // a reading is taken only for the calls it adds beyond the last one.
  #collected = new Map();
  #recovered = [];
  #injected = false;
  #lastSequence = 0;
  #maxOutputIndex = -1;
  #lineEnding = "\n";

  recoveredCalls() {
    return this.#recovered.length;
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
    if (!this.#passthrough) this.#emitBlocks(true);
    if (this.#buffer.length) this.push(this.#buffer);
    this.#buffer = Buffer.alloc(0);
    // A stream that ended without a terminal event still hands Codex the calls
    // it managed to recover; nothing else in the pipeline can reconstruct them.
    if (!this.#passthrough) {
      const trailing = this.#injectionBlocks();
      if (trailing) this.push(trailing);
    }
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

  // One stream per channel, not per item. The summary and content channels of a
  // single reasoning item each carry their own delta sequence; sharing a stream
  // between them appends the second channel's calls to the first's, and the
  // cumulative-reading dedupe in `#collect` then reads the repeat as a genuine
  // extension -- recovering, and executing, the same call twice.
  #streamFor(index, channel) {
    const key = `${Number.isInteger(index) ? index : 0}\u0000${channel}`;
    let stream = this.#streams.get(key);
    if (!stream) {
      stream = new LeakedSpanStream();
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
      const original = this.#buffer.subarray(0, found.index + found.separator.length);
      this.#buffer = this.#buffer.subarray(found.index + found.separator.length);
      this.#emitFrame(original, found.separator, block);
    }
  }

  #emitFrame(original, separator, block = original) {
    let text;
    try {
      text = fatalUtf8(block);
    } catch {
      // Non-UTF-8 frames are relayed untouched, and recovery stops: a stream
      // this transform cannot read is one it must not rewrite.
      this.#disable(original);
      return;
    }
    let rewritten;
    try {
      rewritten = this.#rewrite(text, separator);
    } catch {
      this.#disable(original);
      return;
    }
    if (rewritten === null) return;
    if (rewritten.prefix?.length) this.push(rewritten.prefix);
    if (rewritten.text === text) {
      this.push(Buffer.from(original));
      return;
    }
    this.push(Buffer.concat([Buffer.from(rewritten.text), separator]));
  }

  // Returns `{ prefix, text }` for the frame, or null to drop it (a delta whose
  // whole payload was markup).
  #rewrite(block, separator) {
    const parsed = eventBlock(block);
    if (!parsed) return { text: block };
    if (separator?.length) this.#lineEnding = separator.length === 4 ? "\r\n" : "\n";
    if (parsed.sentinel) return { prefix: this.#injectionBlocks(), text: block };

    const event = parsed.event;
    const type = event?.type;
    if (Number.isInteger(event?.sequence_number)) {
      this.#lastSequence = Math.max(this.#lastSequence, event.sequence_number);
    }
    if (Number.isInteger(event?.output_index)) {
      this.#maxOutputIndex = Math.max(this.#maxOutputIndex, event.output_index);
    }

    if (TERMINAL_TYPES.has(type)) {
      const prefix = this.#injectionBlocks();
      if (!this.#recovered.length) return { prefix, text: block };
      return { prefix, text: rewrittenBlock(parsed, this.#mergeIntoTerminal(event)) };
    }

    if (
      (type === "response.reasoning_summary_text.delta" ||
        type === "response.reasoning_text.delta" ||
        type === "response.output_text.delta") &&
      typeof event.delta === "string"
    ) {
      const stream = this.#streamFor(event.output_index, type);
      const before = stream.calls.length;
      const cleaned = stream.feed(event.delta);
      this.#take(event.output_index, stream, before);
      if (cleaned === event.delta) return { text: block };
      if (!cleaned.length) return null;
      return { text: rewrittenBlock(parsed, { ...event, delta: cleaned }) };
    }

    if (
      (type === "response.reasoning_summary_text.done" ||
        type === "response.reasoning_text.done" ||
        type === "response.output_text.done") &&
      typeof event.text === "string"
    ) {
      // The `.done` snapshot closes the same channel its deltas opened.
      const stream = this.#streamFor(event.output_index, type.replace(/\.done$/, ".delta"));
      const before = stream.calls.length;
      stream.flush();
      this.#take(event.output_index, stream, before);
      // The snapshot repeats the whole item text. Strip the markup here too --
      // and collect from it when the delta channel never carried it.
      const result = parseLeakedToolCalls(event.text);
      if (!result) return { text: block };
      this.#collect(event.output_index, result.calls);
      return { text: rewrittenBlock(parsed, { ...event, text: result.cleaned }) };
    }

    if (type === "response.output_item.done" && event?.item) {
      const item = this.#cleanItem(event.item, event.output_index);
      if (item === event.item) return { text: block };
      return { text: rewrittenBlock(parsed, { ...event, item }) };
    }

    return { text: block };
  }

  #cleanItem(item, outputIndex) {
    if (item?.type === "reasoning") {
      const summary = cleanTextParts(item.summary, "text");
      const content = cleanTextParts(item.content, "text");
      if (!summary.changed && !content.changed) return item;
      // `summary` and `content` are two renderings of one item's thinking. When
      // both carry the span they describe the same calls, so take the fuller
      // reading rather than concatenating them into a duplicate.
      this.#collect(
        outputIndex,
        summary.calls.length >= content.calls.length ? summary.calls : content.calls,
      );
      return { ...item, summary: summary.parts, content: content.parts };
    }
    if (item?.type === "message") {
      const content = cleanTextParts(item.content, "text");
      if (!content.changed) return item;
      this.#collect(outputIndex, content.calls);
      return { ...item, content: content.parts };
    }
    return item;
  }

  #take(outputIndex, stream, before) {
    if (stream.calls.length === before) return;
    // Pass the whole run, not the new slice: `#collect` deduplicates by
    // comparing a reading against what this index already produced.
    this.#collect(outputIndex, stream.calls);
  }

  // Take a reading of one output item's calls. A reading that repeats what the
  // index already produced adds nothing; one that extends it contributes only
  // the tail. A reading that disagrees with the first is discarded rather than
  // relayed twice.
  #collect(outputIndex, calls) {
    if (!calls.length) return;
    const key = Number.isInteger(outputIndex) ? outputIndex : 0;
    const signatures = calls.map((call) => `${call.name}\u0000${call.arguments}`);
    const seen = this.#collected.get(key) ?? [];
    let matched = 0;
    while (matched < seen.length && seen[matched] === signatures[matched]) matched += 1;
    if (matched !== seen.length) return;
    const fresh = calls.slice(matched);
    if (!fresh.length) return;
    this.#collected.set(key, signatures);
    this.#recovered.push(
      ...fresh.map((call) => ({
        type: "function_call",
        name: call.name,
        call_id: `call_router_recovered_${randomUUID().replaceAll("-", "")}`,
        arguments: call.arguments,
      })),
    );
  }

  // Emit the recovered calls as real output items, once, immediately before the
  // event that closes the turn.
  #injectionBlocks() {
    if (this.#injected || !this.#recovered.length) return undefined;
    this.#injected = true;
    const nl = this.#lineEnding;
    const blocks = [];
    for (const item of this.#recovered) {
      const outputIndex = ++this.#maxOutputIndex;
      const added = {
        type: "response.output_item.added",
        sequence_number: ++this.#lastSequence,
        output_index: outputIndex,
        item: { ...item, arguments: "" },
      };
      const done = {
        type: "response.output_item.done",
        sequence_number: ++this.#lastSequence,
        output_index: outputIndex,
        item,
      };
      for (const event of [added, done]) {
        blocks.push(
          Buffer.from(
            `event: ${event.type}${nl}data: ${JSON.stringify(event)}${nl}${nl}`,
            "utf8",
          ),
        );
      }
    }
    return blocks.length ? Buffer.concat(blocks) : undefined;
  }

  // Mirror the injected calls into the terminal event's item list so a consumer
  // that rebuilds the turn from `response.output` sees them too.
  #mergeIntoTerminal(event) {
    const output = event?.response?.output;
    if (!Array.isArray(output)) return event;
    return {
      ...event,
      response: { ...event.response, output: [...output, ...this.#recovered] },
    };
  }
}

export function leakedToolCallRecoveryTransform(contentType = "") {
  if (!String(contentType).toLowerCase().includes("text/event-stream")) return undefined;
  return new LeakedToolCallRecovery();
}
