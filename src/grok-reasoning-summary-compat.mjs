import { Transform } from "node:stream";
import { TextDecoder } from "node:util";

const MAX_FRAME_BYTES = 256 * 1024;
const LF_FRAME_SEPARATOR = Buffer.from("\n\n");
const CRLF_FRAME_SEPARATOR = Buffer.from("\r\n\r\n");

// Grow geometrically and inspect each byte once so fragmented or unterminated
// frames cannot trigger repeated whole-buffer copies and delimiter scans.
class SseFrameAccumulator {
  #storage = Buffer.alloc(0);
  #length = 0;
  #maxFrameBytes;

  constructor(maxFrameBytes) {
    this.#maxFrameBytes = maxFrameBytes;
  }

  write(value, onFrame) {
    const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value);
    for (let index = 0; index < bytes.length; index += 1) {
      this.#append(bytes[index]);
      const separator = this.#separator();
      if (separator) {
        const original = this.take();
        if (original.length > this.#maxFrameBytes) {
          return {
            oversized: original,
            remainder: Buffer.from(bytes.subarray(index + 1)),
          };
        }
        const block = original.subarray(0, original.length - separator.length);
        if (onFrame(block, separator, original) === false) {
          return {
            stopped: true,
            remainder: Buffer.from(bytes.subarray(index + 1)),
          };
        }
        continue;
      }
      if (this.#length > this.#maxFrameBytes) {
        return {
          oversized: this.take(),
          remainder: Buffer.from(bytes.subarray(index + 1)),
        };
      }
    }
    return undefined;
  }

  flush(onFrame) {
    if (!this.#length) return;
    const original = this.take();
    onFrame(original, Buffer.alloc(0), original);
  }

  take() {
    if (!this.#length) return Buffer.alloc(0);
    const value = Buffer.from(this.#storage.subarray(0, this.#length));
    this.#length = 0;
    return value;
  }

  #append(byte) {
    const required = this.#length + 1;
    if (required > this.#storage.length) {
      const maximum = this.#maxFrameBytes + 1;
      const doubled = this.#storage.length ? this.#storage.length * 2 : 1024;
      const capacity = Math.min(maximum, Math.max(required, doubled));
      const next = Buffer.allocUnsafe(capacity);
      if (this.#length) this.#storage.copy(next, 0, 0, this.#length);
      this.#storage = next;
    }
    this.#storage[this.#length] = byte;
    this.#length = required;
  }

  #separator() {
    if (
      this.#length >= LF_FRAME_SEPARATOR.length
      && this.#storage[this.#length - 2] === 0x0a
      && this.#storage[this.#length - 1] === 0x0a
    ) {
      return LF_FRAME_SEPARATOR;
    }
    if (
      this.#length >= CRLF_FRAME_SEPARATOR.length
      && this.#storage[this.#length - 4] === 0x0d
      && this.#storage[this.#length - 3] === 0x0a
      && this.#storage[this.#length - 2] === 0x0d
      && this.#storage[this.#length - 1] === 0x0a
    ) {
      return CRLF_FRAME_SEPARATOR;
    }
    return undefined;
  }
}

function fatalUtf8(buffer) {
  return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(buffer);
}

function eventBlock(block) {
  const newline = block.includes("\r\n") ? "\r\n" : "\n";
  const lines = block.split(/\r?\n/u);
  const dataLineIndex = lines.findIndex((line) => line.startsWith("data:"));
  if (dataLineIndex === -1) return undefined;
  const dataText = lines[dataLineIndex].slice(5).trimStart();
  if (!dataText || dataText === "[DONE]") return undefined;
  try {
    return { lines, dataLineIndex, dataText, newline, event: JSON.parse(dataText) };
  } catch {
    return undefined;
  }
}

function rewrittenBlock(parsed, event) {
  const dataText = JSON.stringify(event);
  if (dataText === parsed.dataText) return parsed.lines.join(parsed.newline);
  const lines = [...parsed.lines];
  lines[parsed.dataLineIndex] = `data: ${dataText}`;
  return lines.join(parsed.newline);
}

function syntheticBlock(type, event, parsed) {
  const hasEventLine = parsed.lines.some((line) => line.startsWith("event:"));
  const lines = hasEventLine ? [`event: ${type}`] : [];
  lines.push(`data: ${JSON.stringify({ type, ...event })}`);
  return lines.join(parsed.newline);
}

function summaryText(item) {
  if (!Array.isArray(item?.summary)) return "";
  return item.summary
    .filter((part) => part?.type === "summary_text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("");
}

// LiteLLM's Chat Completions -> Responses bridge can open an empty message
// before Grok starts reasoning, and it hashes every reasoning delta into a
// different item_id. Codex drops those orphaned deltas, so the user sees
// silence while Grok is already streaming a summary. Normalize only that
// summary lifecycle; other providers and non-SSE responses never enter here.
export class GrokReasoningSummaryCompatTransform extends Transform {
  #frames;
  #disabled = false;
  #reasoning;
  #pendingMessage = [];
  #currentSeparator = "";
  #message;
  #shiftOutputIndexes = false;

  constructor({ maxFrameBytes = MAX_FRAME_BYTES } = {}) {
    super();
    const limit = Number.isInteger(maxFrameBytes) && maxFrameBytes > 0
      ? maxFrameBytes
      : MAX_FRAME_BYTES;
    this.#frames = new SseFrameAccumulator(limit);
  }

  _transform(chunk, _encoding, callback) {
    const piece = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    if (this.#disabled) {
      this.push(Buffer.from(piece));
      callback();
      return;
    }
    const outcome = this.#frames.write(piece, (block, separator, original) => (
      this.#emitFrame(block, separator, original)
    ));
    if (outcome?.oversized) this.#disable(outcome.oversized);
    if (outcome?.remainder?.length) this.push(outcome.remainder);
    callback();
  }

  _flush(callback) {
    if (this.#disabled) {
      const pending = this.#frames.take();
      if (pending.length) this.push(pending);
      callback();
      return;
    }
    this.#frames.flush((block, separator, original) => {
      this.#emitFrame(block, separator, original);
    });
    for (const piece of this.#flushPendingMessage(true)) this.push(Buffer.from(piece));
    callback();
  }

  #emitFrame(block, separator, original) {
    let text;
    try {
      text = fatalUtf8(block);
    } catch {
      this.#disable(original);
      return false;
    }
    this.#currentSeparator = separator.toString("ascii");
    for (const piece of this.#rewriteBlock(text)) {
      this.push(Buffer.concat([Buffer.from(piece), separator]));
    }
    this.#currentSeparator = "";
    return !this.#disabled;
  }

  #disable(original) {
    for (const piece of this.#flushPendingMessage(true)) this.push(Buffer.from(piece));
    if (original?.length) this.push(original);
    this.#disabled = true;
  }

  #common(parsed) {
    return {
      item_id: this.#reasoning.id,
      output_index: this.#reasoning.outputIndex,
      summary_index: 0,
      ...(typeof parsed.event.model === "string" ? { model: parsed.event.model } : {}),
    };
  }

  #reasoningItem(status = "completed") {
    return {
      id: this.#reasoning.id,
      type: "reasoning",
      status,
      summary: status === "completed" && this.#reasoning.partStarted
        ? [{ type: "summary_text", text: this.#reasoning.text }]
        : [],
    };
  }

  #shiftedEvent(event) {
    if (!this.#shiftOutputIndexes || !Number.isInteger(event?.output_index)) return event;
    return { ...event, output_index: event.output_index + 1 };
  }

  #flushPendingMessage(preserveSeparators = false) {
    const pending = this.#pendingMessage;
    this.#pendingMessage = [];
    return pending.map(({ parsed, separator }) => (
      rewrittenBlock(parsed, this.#shiftedEvent(parsed.event))
      + (preserveSeparators ? separator : "")
    ));
  }

  #startOrphanReasoning(parsed) {
    const event = parsed.event;
    const outputIndex = this.#message?.outputIndex
      ?? (Number.isInteger(event.output_index) ? event.output_index : 0);
    this.#shiftOutputIndexes = this.#pendingMessage.length > 0;
    this.#reasoning = {
      id: typeof event.item_id === "string" && event.item_id ? event.item_id : "rs_grok_summary",
      outputIndex,
      text: "",
      partStarted: false,
      textDone: false,
      partDone: false,
      itemDone: false,
      synthetic: true,
    };
    return [syntheticBlock(
      "response.output_item.added",
      {
        output_index: outputIndex,
        item: this.#reasoningItem("in_progress"),
        ...(typeof event.model === "string" ? { model: event.model } : {}),
      },
      parsed,
    )];
  }

  #startSummaryPart(parsed) {
    if (this.#reasoning.partStarted) return [];
    this.#reasoning.partStarted = true;
    return [syntheticBlock(
      "response.reasoning_summary_part.added",
      {
        ...this.#common(parsed),
        part: { type: "summary_text", text: "" },
      },
      parsed,
    )];
  }

  #finishReasoning(parsed) {
    if (!this.#reasoning || this.#reasoning.itemDone) return [];
    const output = [];
    output.push(...this.#startSummaryPart(parsed));
    if (!this.#reasoning.textDone) {
      this.#reasoning.textDone = true;
      output.push(syntheticBlock(
        "response.reasoning_summary_text.done",
        { ...this.#common(parsed), text: this.#reasoning.text },
        parsed,
      ));
    }
    if (!this.#reasoning.partDone) {
      this.#reasoning.partDone = true;
      output.push(syntheticBlock(
        "response.reasoning_summary_part.done",
        {
          ...this.#common(parsed),
          part: { type: "summary_text", text: this.#reasoning.text },
        },
        parsed,
      ));
    }
    this.#reasoning.itemDone = true;
    output.push(syntheticBlock(
      "response.output_item.done",
      {
        output_index: this.#reasoning.outputIndex,
        item: this.#reasoningItem(),
        ...(typeof parsed.event.model === "string" ? { model: parsed.event.model } : {}),
      },
      parsed,
    ));
    return output;
  }

  #rewriteBlock(block) {
    const parsed = eventBlock(block);
    if (!parsed) return [block];
    const event = parsed.event;
    const type = event?.type;

    if (!this.#reasoning && type === "response.output_item.added" && event?.item?.type === "message") {
      this.#message = {
        id: event.item.id,
        outputIndex: Number.isInteger(event.output_index) ? event.output_index : 0,
        text: "",
      };
      this.#pendingMessage.push({ parsed, separator: this.#currentSeparator });
      return [];
    }

    if (
      !this.#reasoning
      && this.#pendingMessage.length > 0
      && type === "response.content_part.added"
      && event.item_id === this.#message?.id
    ) {
      this.#pendingMessage.push({ parsed, separator: this.#currentSeparator });
      return [];
    }

    let prefix = [];
    if (
      !this.#reasoning
      && this.#pendingMessage.length > 0
      && type === "response.reasoning_summary_text.delta"
    ) {
      prefix = this.#startOrphanReasoning(parsed);
    } else if (!this.#reasoning && this.#pendingMessage.length > 0) {
      return [...this.#flushPendingMessage(), block];
    }

    if (type === "response.output_item.added" && event?.item?.type === "reasoning") {
      const id = typeof event.item.id === "string" ? event.item.id : "";
      // A canonical Responses item already has an array-valued summary. Leave
      // that lifecycle byte-identical, including any additional summary parts.
      if (!id || Array.isArray(event.item.summary)) return [block];
      this.#reasoning = {
        id,
        outputIndex: Number.isInteger(event.output_index) ? event.output_index : 0,
        text: summaryText(event.item),
        partStarted: false,
        textDone: false,
        partDone: false,
        itemDone: false,
        synthetic: false,
      };
      const item = Array.isArray(event.item.summary)
        ? event.item
        : { ...event.item, summary: [] };
      return [rewrittenBlock(parsed, item === event.item ? event : { ...event, item })];
    }

    if (!this.#reasoning) return [block];

    if (type === "response.reasoning_summary_part.added") {
      if (this.#reasoning.partStarted) return [];
      this.#reasoning.partStarted = true;
      return [rewrittenBlock(parsed, {
        ...event,
        ...this.#common(parsed),
        part: { type: "summary_text", text: "" },
      })];
    }

    if (type === "response.reasoning_summary_text.delta" && typeof event.delta === "string") {
      if (this.#reasoning.itemDone) return [];
      prefix.push(...this.#startSummaryPart(parsed));
      this.#reasoning.text += event.delta;
      return [...prefix, rewrittenBlock(parsed, {
        ...event,
        ...this.#common(parsed),
      })];
    }

    if (type === "response.reasoning_summary_text.done") {
      if (this.#reasoning.itemDone) return [];
      const prefix = this.#startSummaryPart(parsed);
      if (typeof event.text === "string") this.#reasoning.text = event.text;
      this.#reasoning.textDone = true;
      return [...prefix, rewrittenBlock(parsed, {
        ...event,
        ...this.#common(parsed),
        text: this.#reasoning.text,
      })];
    }

    if (type === "response.reasoning_summary_part.done") {
      if (this.#reasoning.itemDone) return [];
      const prefix = this.#startSummaryPart(parsed);
      const text = typeof event.part?.text === "string"
        ? event.part.text
        : this.#reasoning.text;
      this.#reasoning.text = text;
      this.#reasoning.partDone = true;
      return [...prefix, rewrittenBlock(parsed, {
        ...event,
        ...this.#common(parsed),
        part: { type: "summary_text", text },
      })];
    }

    if (type === "response.output_item.done" && event?.item?.type === "reasoning") {
      if (this.#reasoning.itemDone) return [];
      const prefix = [];
      if (this.#reasoning.partStarted && !this.#reasoning.textDone) {
        this.#reasoning.textDone = true;
        prefix.push(syntheticBlock(
          "response.reasoning_summary_text.done",
          { ...this.#common(parsed), text: this.#reasoning.text },
          parsed,
        ));
      }
      if (this.#reasoning.partStarted && !this.#reasoning.partDone) {
        this.#reasoning.partDone = true;
        prefix.push(syntheticBlock(
          "response.reasoning_summary_part.done",
          {
            ...this.#common(parsed),
            part: { type: "summary_text", text: this.#reasoning.text },
          },
          parsed,
        ));
      }
      const item = {
        ...event.item,
        id: this.#reasoning.id,
        status: "completed",
        summary: this.#reasoning.partStarted
          ? [{ type: "summary_text", text: this.#reasoning.text }]
          : [],
      };
      this.#reasoning.itemDone = true;
      return [...prefix, rewrittenBlock(parsed, {
        ...event,
        output_index: this.#reasoning.outputIndex,
        item,
      })];
    }

    const startsVisibleOutput = type === "response.output_text.delta"
      || type === "response.output_text.done"
      || (type === "response.output_item.added" && event?.item?.type !== "reasoning")
      || type === "response.function_call_arguments.delta";
    if (startsVisibleOutput && !this.#reasoning.itemDone) {
      prefix.push(...this.#finishReasoning(parsed), ...this.#flushPendingMessage());
    }

    if (
      type === "response.content_part.done"
      && event.item_id === this.#message?.id
      && event.part?.type === "reasoning_text"
    ) {
      return [...prefix, rewrittenBlock(parsed, this.#shiftedEvent({
        ...event,
        part: {
          type: "output_text",
          text: this.#message.text,
          annotations: [],
        },
      }))];
    }

    if (type === "response.output_text.delta" && event.item_id === this.#message?.id) {
      this.#message.text += typeof event.delta === "string" ? event.delta : "";
    } else if (type === "response.output_text.done" && event.item_id === this.#message?.id) {
      if (typeof event.text === "string") this.#message.text = event.text;
    }

    if (type === "response.completed" && Array.isArray(event.response?.output)) {
      prefix.push(...this.#finishReasoning(parsed), ...this.#flushPendingMessage());
      const nonReasoning = event.response.output
        .filter((item) => item?.type !== "reasoning")
        .map((item) => (
          item?.type === "message" && this.#message?.id
            ? { ...item, id: this.#message.id }
            : item
        ));
      const output = [this.#reasoningItem(), ...nonReasoning];
      const unchanged = !this.#reasoning.synthetic
        && JSON.stringify(output) === JSON.stringify(event.response.output);
      const next = unchanged
        ? event
        : { ...event, response: { ...event.response, output } };
      this.#reasoning = undefined;
      this.#shiftOutputIndexes = false;
      return [...prefix, rewrittenBlock(parsed, next)];
    }

    return [...prefix, rewrittenBlock(parsed, this.#shiftedEvent(event))];
  }
}

export function grokReasoningSummaryCompatTransform(provider, contentType = "") {
  const providerId = typeof provider === "string" ? provider : provider?.id;
  if (providerId !== "grok-oauth") return undefined;
  if (!String(contentType).toLowerCase().includes("text/event-stream")) return undefined;
  return new GrokReasoningSummaryCompatTransform();
}
