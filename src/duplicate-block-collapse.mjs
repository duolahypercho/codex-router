import { Transform } from "node:stream";

// Collapse a run of identical consecutive blocks inside one assistant message.
//
// Observed on routed chat-completions turns: a short pre-tool progress line
// arrives twice in the streamed text -- as two clean, identically tokenized
// delta runs -- and the terminal `output_text.done` carries both copies. The
// capture proves the duplicate is in the wire bytes, so it is not a client
// rendering artifact and not a lifecycle reorder (every captured stream opens
// and closes each output item sequentially).
//
// The transform is deliberately narrow: it rewrites a message only when its
// entire text is a run of identical block repeats (`A\n\nA`, `A\n\nA\n\nB\n\nB`).
// Ordinary prose, which repeats a paragraph for emphasis at most rarely, is
// relayed byte-for-byte. It is a mitigation for an exact, measured shape, not a
// claim about the origin of the duplication.
//
// Ordering: this runs AFTER ItemLifecycleNormalizer, which guarantees an item is
// opened, streamed, and closed before the next one. Holding one message item's
// events is therefore safe. If any event from a different output index arrives
// while holding -- which the normalizer should have made impossible -- the hold
// is released verbatim rather than reordered.

// Two separate bounds, because the two things being measured differ by orders
// of magnitude. The collapse only ever inspects the visible answer text, which
// is small; the same item also carries the model's reasoning, which is
// routinely an order of magnitude larger and has nothing to do with the
// rewrite. Accounting them together made the guard fire on any thinking model
// that reasoned at length: a captured turn held 138 KB for its message item, of
// which 113 KB was reasoning, so the transform released the item verbatim and
// the duplicate survived. The absolute bound still exists, but it is a memory
// guard rather than the deciding factor for whether a collapse is attempted.
const MAX_HELD_TEXT_BYTES = 256 * 1024;
const MAX_HELD_BYTES = 4 * 1024 * 1024;
// A message item is held until it closes, and a long reasoning pass can easily
// outlast a short deadline. This bounds a genuinely stuck stream instead.
const MAX_HELD_MS = 120_000;

// Split on blank-line separators while keeping the separators, so rejoining is
// byte-exact for text the transform does not change.
function splitBlocks(text) {
  const parts = text.split(/(\n{2,})/);
  const out = [];
  for (let i = 0; i < parts.length; i += 2) {
    out.push({ block: parts[i], separator: parts[i + 1] ?? "" });
  }
  return out;
}

export function collapseRepeatedBlocks(text) {
  if (typeof text !== "string" || !text) return text;
  const blocks = splitBlocks(text);
  let previous;
  let out = "";
  let dropped = 0;
  let first = true;
  // The separator that connects the last surviving block to the next one. When a
  // duplicate is dropped, its own separator is retained as the connector, so
  // `A\n\nA\n\nB` keeps one blank line rather than collapsing to `AB`.
  let pendingSeparator = "";
  for (const { block, separator } of blocks) {
    if (!first && block === previous) {
      dropped += 1;
      pendingSeparator = separator;
      continue;
    }
    out += first ? block : pendingSeparator + block;
    previous = block;
    pendingSeparator = separator;
    first = false;
  }
  return dropped ? out : text;
}

class DuplicateBlockCollapse extends Transform {
  #buffer = Buffer.alloc(0);
  #passthrough = false;
  #holding;
  #startedAt = 0;

  _transform(chunk, encoding, callback) {
    const piece = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding);
    if (this.#passthrough) {
      this.push(piece);
      callback();
      return;
    }
    this.#buffer = this.#buffer.length ? Buffer.concat([this.#buffer, piece]) : piece;
    this.#drain(false);
    callback();
  }

  _flush(callback) {
    this.#releaseHeld();
    if (this.#buffer.length) {
      this.push(this.#buffer);
      this.#buffer = Buffer.alloc(0);
    }
    callback();
  }

  #disable(original) {
    this.#releaseHeld();
    if (original?.length) this.push(Buffer.from(original));
    if (this.#buffer.length) {
      this.push(this.#buffer);
      this.#buffer = Buffer.alloc(0);
    }
    this.#passthrough = true;
  }

  #drain(flush) {
    while (this.#buffer.length && !this.#passthrough) {
      const lf = this.#buffer.indexOf("\n\n");
      const crlf = this.#buffer.indexOf("\r\n\r\n");
      let end = -1;
      let sep = "";
      if (crlf !== -1 && (lf === -1 || crlf <= lf)) {
        end = crlf;
        sep = "\r\n\r\n";
      } else if (lf !== -1) {
        end = lf;
        sep = "\n\n";
      }
      if (end === -1) {
        if (!flush) return;
        const rest = this.#buffer;
        this.#buffer = Buffer.alloc(0);
        this.#handle(rest.toString("utf8"), "", rest);
        return;
      }
      const block = this.#buffer.subarray(0, end);
      const original = this.#buffer.subarray(0, end + sep.length);
      this.#buffer = this.#buffer.subarray(end + sep.length);
      this.#handle(block.toString("utf8"), sep, original);
    }
  }

  #handle(text, separator, original) {
    let event;
    try {
      const data = [];
      for (const line of text.split(/\r?\n/)) {
        if (line.startsWith("data:")) {
          const v = line.slice(5);
          data.push(v.startsWith(" ") ? v.slice(1) : v);
        }
      }
      if (!data.length) {
        this.#emit(original);
        return;
      }
      const dataText = data.join("\n");
      if (dataText === "[DONE]") {
        this.#releaseHeld();
        this.#emit(original);
        return;
      }
      event = JSON.parse(dataText);
    } catch {
      // Unparseable framing: relaying it untouched is always the safe answer.
      this.#emit(original);
      return;
    }

    const type = event?.type;
    const index = Number.isInteger(event?.output_index) ? event.output_index : undefined;

    if (type === "response.output_item.added" && event.item?.type === "message") {
      this.#releaseHeld();
      // The opening event belongs to the held item: it is replayed on release
      // (or carried into the rewrite), so it must be recorded, not swallowed.
      this.#holding = {
        index,
        events: [{ event, original, separator }],
        bytes: original.length,
        textBytes: 0,
      };
      this.#startedAt = Date.now();
      return;
    }

    if (this.#holding) {
      // A different item's events must never be reordered behind a held item.
      if (index !== undefined && index !== this.#holding.index) {
        this.#releaseHeld();
      } else if (
        this.#holding.textBytes > MAX_HELD_TEXT_BYTES ||
        this.#holding.bytes > MAX_HELD_BYTES ||
        Date.now() - this.#startedAt > MAX_HELD_MS
      ) {
        this.#releaseHeld();
      }
    }

    if (this.#holding && (index === this.#holding.index || index === undefined)) {
      this.#holding.events.push({ event, original, separator });
      this.#holding.bytes += original.length;
      if (
        type === "response.output_text.delta" &&
        typeof event.delta === "string"
      ) {
        this.#holding.textBytes += event.delta.length;
      }
      if (type === "response.output_item.done") this.#releaseHeld();
      return;
    }

    this.#emit(original);
  }

  #emit(buf) {
    this.push(Buffer.from(buf));
  }

  // Rebuild the held item: if its text is a pure block-repeat, emit one corrected
  // delta plus a corrected done event; otherwise replay the held bytes verbatim.
  #releaseHeld() {
    const held = this.#holding;
    this.#holding = undefined;
    if (!held) return;

    let text = "";
    for (const entry of held.events) {
      if (entry.event.type === "response.output_text.delta" && typeof entry.event.delta === "string") {
        text += entry.event.delta;
      }
    }
    const collapsed = collapseRepeatedBlocks(text);
    if (collapsed === text) {
      for (const entry of held.events) this.#emit(entry.original);
      return;
    }

    // Rewrite: keep the item's own open/done framing and drop the delta run,
    // replacing it with a single delta carrying the collapsed text.
    const rewritten = [];
    for (const entry of held.events) {
      const e = entry.event;
      if (e.type === "response.output_text.delta") continue;
      if (e.type === "response.output_text.done") rewritten.push({ ...e, text: collapsed });
      else if (e.type === "response.output_item.done" && e.item?.content) {
        rewritten.push({
          ...e,
          item: {
            ...e.item,
            content: e.item.content.map((part) =>
              part?.type === "output_text" ? { ...part, text: collapsed } : part,
            ),
          },
        });
      } else rewritten.push(e);
    }

    let inserted = false;
    for (const e of rewritten) {
      if (e.type === "response.output_text.done" && !inserted) {
        const delta = {
          type: "response.output_text.delta",
          output_index: e.output_index,
          item_id: e.item_id,
          content_index: e.content_index,
          delta: collapsed,
        };
        for (const key of Object.keys(delta)) {
          if (delta[key] === undefined) delete delta[key];
        }
        this.#emit(`data: ${JSON.stringify(delta)}\n\n`);
        inserted = true;
      }
      this.#emit(`data: ${JSON.stringify(e)}\n\n`);
    }
  }
}

export function duplicateBlockCollapseTransform(contentType = "") {
  if (!String(contentType).toLowerCase().includes("text/event-stream")) return undefined;
  return new DuplicateBlockCollapse();
}
