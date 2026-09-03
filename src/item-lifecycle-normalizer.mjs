import { Transform } from "node:stream";

// LiteLLM's chat-completions -> Responses bridge (use_chat_completions_api) can
// emit output items with overlapping lifecycles when one Qwen turn carries both
// assistant text and a tool call: the `message` item is opened and its text
// streamed, then a `function_call` item is opened AND closed, and only then does
// the message item's `output_item.done` arrive. The Responses contract requires
// each output item to be `done` before the next `output_item.added`. Codex's TUI
// finalizes the streamed message into a committed cell when the function_call
// barges in, then commits it a second time when the delayed message
// `output_item.done` lands at the end -- the same assistant sentence renders
// twice, with the tool call after it.
//
// This transform restores sequential item lifecycles without rewriting any event
// body: while an item is open, events for a *different* output index are held and
// replayed once the open item closes, so every item is opened, streamed, and
// closed in full before the next one begins. Blocks pass through byte-for-byte;
// only their order changes, and only when the upstream actually interleaves.
// Clean streams (each item added -> done before the next added) emit unchanged.
// Invalid UTF-8 frames disable rewriting and relay the original bytes.
const CRLF_SEP = Buffer.from("\r\n\r\n");
const LF_SEP = Buffer.from("\n\n");

function fatalUtf8(buffer) {
  return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(buffer);
}

function parseBlock(block) {
  // The SSE spec joins repeated `data:` fields with a line feed before dispatch;
  // overwriting them would truncate valid multiline JSON.
  const dataLines = [];
  for (const line of block.split(/\r?\n/)) {
    if (line.startsWith("data:")) {
      const value = line.slice(5);
      dataLines.push(value.startsWith(" ") ? value.slice(1) : value);
    }
  }
  if (!dataLines.length) return undefined;
  const dataText = dataLines.join("\n");
  if (dataText === "[DONE]") return { terminal: true };
  try {
    return { event: JSON.parse(dataText) };
  } catch {
    return undefined;
  }
}

// `response.completed`/`response.done` close the turn and must follow every
// output item, so any held item events are flushed ahead of them.
const TERMINAL_TYPES = new Set(["response.completed", "response.done"]);

function findFrameEnd(buffer) {
  const crlf = buffer.indexOf(CRLF_SEP);
  const lf = buffer.indexOf(LF_SEP);
  if (crlf !== -1 && (lf === -1 || crlf <= lf)) {
    return { index: crlf, separator: CRLF_SEP };
  }
  if (lf !== -1) return { index: lf, separator: LF_SEP };
  return undefined;
}

export class ItemLifecycleNormalizer extends Transform {
  #buffer = Buffer.alloc(0);
  #passthrough = false;
  // Output index of the item currently open in the *emitted* stream (its
  // `output_item.added` was pushed but its `output_item.done` has not), or
  // undefined when no item is open.
  #openIndex;
  // FIFO groups of blocks held for indices that opened while a different item was
  // still open. Each group collects the blocks for one output index.
  #queue = [];

  _transform(chunk, encoding, callback) {
    const piece = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding);
    if (this.#passthrough) {
      this.push(piece);
      callback();
      return;
    }
    this.#buffer = this.#buffer.length ? Buffer.concat([this.#buffer, piece]) : piece;
    this.#drainBuffer(false);
    callback();
  }

  _flush(callback) {
    if (this.#passthrough) {
      if (this.#buffer.length) this.push(this.#buffer);
      this.#buffer = Buffer.alloc(0);
      callback();
      return;
    }
    this.#drainBuffer(true);
    // Anything still held (an upstream that ended without closing its open item)
    // is emitted rather than dropped.
    this.#flushHeld();
    callback();
  }

  #disable(original) {
    this.#flushHeld();
    if (original?.length) this.push(original);
    if (this.#buffer.length) {
      this.push(this.#buffer);
      this.#buffer = Buffer.alloc(0);
    }
    this.#passthrough = true;
  }

  #drainBuffer(flush) {
    while (this.#buffer.length && !this.#passthrough) {
      const found = findFrameEnd(this.#buffer);
      if (!found) {
        if (!flush) return;
        const original = this.#buffer;
        this.#buffer = Buffer.alloc(0);
        this.#handleFrame(original, Buffer.alloc(0));
        return;
      }
      const block = this.#buffer.subarray(0, found.index);
      const separator = found.separator;
      const original = this.#buffer.subarray(0, found.index + separator.length);
      this.#buffer = this.#buffer.subarray(found.index + separator.length);
      this.#handleFrame(original, separator, block);
    }
  }

  #handleFrame(original, separator, block = original) {
    let text;
    try {
      text = fatalUtf8(block);
    } catch {
      this.#disable(original);
      return;
    }
    this.#handle(text, separator, original, parseBlock(text));
  }

  #emitOriginal(original) {
    this.push(Buffer.from(original));
  }

  #handle(text, separator, original, parsed = parseBlock(text)) {
    // Comments, heartbeats, and unparseable blocks are not item-scoped; relay
    // them in place.
    if (!parsed) {
      this.#emitOriginal(original);
      return;
    }
    if (parsed.terminal) {
      this.#flushHeld();
      this.#emitOriginal(original);
      return;
    }
    const event = parsed.event;
    const type = event?.type;
    if (TERMINAL_TYPES.has(type)) {
      this.#flushHeld();
      this.#emitOriginal(original);
      return;
    }
    const idx = Number.isInteger(event?.output_index) ? event.output_index : undefined;
    // Stream-level events (`response.created`, `response.in_progress`, error
    // frames) carry no output index and are relayed in order.
    if (idx === undefined) {
      this.#emitOriginal(original);
      return;
    }
    if (this.#openIndex === undefined) {
      this.#emitOriginal(original);
      if (type === "response.output_item.added") this.#openIndex = idx;
      return;
    }
    if (idx === this.#openIndex) {
      this.#emitOriginal(original);
      if (type === "response.output_item.done") {
        this.#openIndex = undefined;
        this.#drainHeld();
      }
      return;
    }
    // An event for a different item while one is still open: hold it until the
    // open item closes, preserving arrival order within its own index.
    this.#hold(idx, { original, type, index: idx });
  }

  #hold(idx, block) {
    let group = this.#queue.find((g) => g.index === idx);
    if (!group) {
      group = { index: idx, blocks: [] };
      this.#queue.push(group);
    }
    group.blocks.push(block);
  }

  // Promote held groups now that no item is open. A group whose events include
  // its own `output_item.done` closes and lets the next group promote; a group
  // still mid-stream becomes the open item, and its remaining live events relay
  // in place until it closes.
  #drainHeld() {
    while (this.#openIndex === undefined && this.#queue.length) {
      const group = this.#queue.shift();
      for (const block of group.blocks) {
        this.#emitOriginal(block.original);
        if (block.type === "response.output_item.added") this.#openIndex = block.index;
        else if (block.type === "response.output_item.done") this.#openIndex = undefined;
      }
      if (this.#openIndex !== undefined) return;
    }
  }

  // Emit every held block in FIFO order, regardless of open state. Used before a
  // terminal event and at end of stream so no item events are lost.
  #flushHeld() {
    for (const group of this.#queue) {
      for (const block of group.blocks) this.#emitOriginal(block.original);
    }
    this.#queue = [];
    this.#openIndex = undefined;
  }
}

export function itemLifecycleNormalizerTransform(contentType = "") {
  if (!String(contentType).toLowerCase().includes("text/event-stream")) return undefined;
  return new ItemLifecycleNormalizer();
}
