import { Transform } from "node:stream";

const CRLF_SEP = Buffer.from("\r\n\r\n");
const LF_SEP = Buffer.from("\n\n");
const EMPTY = Buffer.alloc(0);

function fatalUtf8(buffer) {
  return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(buffer);
}

function eventBlock(block) {
  const newline = block.includes("\r\n") ? "\r\n" : "\n";
  const lines = block.split(/\r?\n/);
  const dataLineIndex = lines.findIndex((line) => line.startsWith("data:"));
  if (dataLineIndex === -1) return undefined;
  const dataText = lines[dataLineIndex].slice(5).trimStart();
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

function syntheticBlock(type, event, parsed) {
  const hasEventLine = parsed.lines.some((line) => line.startsWith("event:"));
  const lines = hasEventLine ? [`event: ${type}`] : [];
  lines.push(`data: ${JSON.stringify({ type, ...event })}`);
  return lines.join(parsed.newline);
}

function messageText(item) {
  if (typeof item?.content === "string") return item.content;
  if (!Array.isArray(item?.content)) return "";
  return item.content
    .filter((part) => part?.type === "output_text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("");
}

// A malformed Z.ai close can put its private reasoning part inside the
// assistant message item itself, rather than only in content_part.done. Keep
// visible output parts and replace the hidden part with the text observed from
// the stream. Never relay a reasoning_text/thinking part as message content.
function sanitizeMessageItem(item, fallbackText = "") {
  if (item?.type !== "message" || !Array.isArray(item.content)) return item;
  let changed = false;
  const content = [];
  for (const part of item.content) {
    if (!part || typeof part !== "object") {
      content.push(part);
      continue;
    }
    const hidden =
      part.type === "reasoning_text" ||
      part.type === "reasoning" ||
      part.type === "thinking" ||
      typeof part.reasoning === "string";
    if (hidden) {
      changed = true;
      continue;
    }
    content.push(part);
  }
  if (!changed) return item;
  if (!content.length) {
    content.push({ type: "output_text", text: fallbackText, annotations: [] });
  }
  return { ...item, content };
}

// LiteLLM 1.96's Chat Completions -> Responses bridge opens a reasoning item
// when the first upstream chunk carries reasoning, closes it, and then streams
// the assistant text with no `output_item.added` / `content_part.added`, on the
// reasoning item's own `output_index`, closing the part as `reasoning_text`.
// Codex logs `OutputTextDelta without active item` for every such delta. First
// seen on Z.ai GLM-5.3, then on OpenRouter (MiMo V2.6 Flash, Space Bunny
// Alpha); the pinned LiteLLM emits it for any Chat Completions upstream whose
// reply starts with reasoning. This stage injects the missing envelope, moves
// the message to the next free output index, and never relays reasoning as
// message content. A stream that already carries its envelope is unchanged.
//
// Framing is byte-level: a block this stage does not change is relayed as the
// exact bytes that arrived, and a frame that is not valid UTF-8 switches
// rewriting off for the rest of the stream and relays everything verbatim.
export class ZaiResponsesCompatTransform extends Transform {
  #buffer = Buffer.alloc(0);
  #passthrough = false;
  #maxOutputIndex = -1;
  #message;
  // Items the upstream opened as something other than a message. Their content
  // parts belong to them, so they must never be adopted as a message envelope.
  #otherItems = new Set();

  _transform(chunk, encoding, callback) {
    const piece = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding);
    if (this.#passthrough) {
      this.push(piece);
      callback();
      return;
    }
    this.#buffer = this.#buffer.length ? Buffer.concat([this.#buffer, piece]) : piece;
    this.#emitCompleteBlocks();
    callback();
  }

  _flush(callback) {
    if (this.#passthrough) {
      if (this.#buffer.length) this.push(this.#buffer);
      this.#buffer = Buffer.alloc(0);
    } else {
      this.#emitCompleteBlocks(true);
    }
    callback();
  }

  #emitCompleteBlocks(flush = false) {
    while (this.#buffer.length && !this.#passthrough) {
      const crlf = this.#buffer.indexOf(CRLF_SEP);
      const lf = this.#buffer.indexOf(LF_SEP);
      let index = -1;
      let separator = EMPTY;
      if (crlf !== -1 && (lf === -1 || crlf <= lf)) {
        index = crlf;
        separator = CRLF_SEP;
      } else if (lf !== -1) {
        index = lf;
        separator = LF_SEP;
      }
      if (index === -1 && !flush) return;
      const end = index === -1 ? this.#buffer.length : index;
      const original = this.#buffer.subarray(0, end + separator.length);
      const bytes = this.#buffer.subarray(0, end);
      this.#buffer = this.#buffer.subarray(end + separator.length);
      let block;
      try {
        block = fatalUtf8(bytes);
      } catch {
        this.push(Buffer.from(original));
        if (this.#buffer.length) this.push(Buffer.from(this.#buffer));
        this.#buffer = Buffer.alloc(0);
        this.#passthrough = true;
        return;
      }
      const pieces = this.#rewriteBlock(block);
      if (pieces.length === 1 && pieces[0] === block) {
        this.push(Buffer.from(original));
        continue;
      }
      for (const piece of pieces) this.push(Buffer.concat([Buffer.from(piece), separator]));
    }
  }

  #messageIndex(event) {
    if (this.#message) return this.#message.outputIndex;
    const reported = Number.isInteger(event?.output_index) ? event.output_index : 0;
    return this.#maxOutputIndex >= 0
      ? Math.max(this.#maxOutputIndex + 1, reported)
      : reported;
  }

  #retireMessage() {
    if (Number.isInteger(this.#message?.outputIndex)) {
      this.#maxOutputIndex = Math.max(this.#maxOutputIndex, this.#message.outputIndex);
    }
    this.#message = undefined;
  }

  #startMessage(event, parsed) {
    const id = String(event?.item_id || "");
    if (this.#message && id && this.#message.id !== id) this.#retireMessage();
    const outputIndex = this.#messageIndex(event);
    const contentIndex = Number.isInteger(event?.content_index) ? event.content_index : 0;
    this.#message = {
      id,
      outputIndex,
      contentIndex,
      text: "",
      contentStarted: true,
    };
    this.#maxOutputIndex = Math.max(this.#maxOutputIndex, outputIndex);
    const common = {
      output_index: outputIndex,
      ...(typeof event?.model === "string" ? { model: event.model } : {}),
    };
    return [
      syntheticBlock("response.output_item.added", {
        ...common,
        item: {
          id: this.#message.id,
          type: "message",
          status: "in_progress",
          role: "assistant",
          content: [],
        },
      }, parsed),
      syntheticBlock("response.content_part.added", {
        ...common,
        item_id: this.#message.id,
        content_index: contentIndex,
        part: { type: "output_text", text: "", annotations: [] },
      }, parsed),
    ];
  }

  #rewriteMessageEvent(event) {
    if (!this.#message) return event;
    if (event.output_index === this.#message.outputIndex) return event;
    return { ...event, output_index: this.#message.outputIndex };
  }

  #rewriteBlock(block) {
    const parsed = eventBlock(block);
    if (!parsed) return [block];
    const event = parsed.event;
    const type = event?.type;
    if (
      event?.item_id
      && this.#otherItems.has(String(event.item_id))
      && (type?.startsWith("response.content_part.") || type?.startsWith("response.output_text."))
    ) {
      return [block];
    }
    if (type === "response.output_item.added") {
      if (Number.isInteger(event.output_index)) {
        this.#maxOutputIndex = Math.max(this.#maxOutputIndex, event.output_index);
      }
      if (event?.item?.type && event.item.type !== "message" && event.item.id) {
        this.#otherItems.add(String(event.item.id));
      }
      if (event?.item?.type === "message") {
        const item = sanitizeMessageItem(event.item);
        this.#message = {
          id: String(item.id || ""),
          outputIndex: Number.isInteger(event.output_index) ? event.output_index : 0,
          contentIndex: 0,
          text: messageText(item),
          contentStarted: false,
        };
        if (item !== event.item) {
          return [rewrittenBlock(parsed, { ...event, item })];
        }
      }
      return [block];
    }

    if (type === "response.content_part.added" && event?.item_id) {
      const itemId = String(event.item_id);
      if (this.#message && this.#message.id !== itemId) this.#retireMessage();
      if (!this.#message) {
        // LiteLLM can omit only output_item.added. Adopt the existing content
        // part and inject the missing item envelope without duplicating this
        // part in the stream.
        const injected = this.#startMessage(event, parsed);
        if (event.part?.type === "output_text" && typeof event.part.text === "string") {
          this.#message.text = event.part.text;
        }
        const next = this.#rewriteMessageEvent(event);
        return [
          injected[0],
          next === event ? block : rewrittenBlock(parsed, next),
        ];
      }
      this.#message.contentStarted = true;
      const next = this.#rewriteMessageEvent(event);
      return [
        next === event ? block : rewrittenBlock(parsed, next),
      ];
    }

    if (type === "response.output_item.done" && event?.item?.type === "reasoning") {
      if (Number.isInteger(event.output_index)) {
        this.#maxOutputIndex = Math.max(this.#maxOutputIndex, event.output_index);
      }
      return [block];
    }

    if (type === "response.output_text.delta" || type === "response.output_text.done") {
      const itemId = String(event?.item_id || "");
      if (this.#message && itemId && this.#message.id !== itemId) this.#retireMessage();
      const injected = this.#message ? [] : this.#startMessage(event, parsed);
      let next = this.#rewriteMessageEvent(event);
      if (type === "response.output_text.delta" && typeof event.delta === "string") {
        this.#message.text += event.delta;
      }
      if (type === "response.output_text.done" && typeof event.text === "string") {
        this.#message.text = event.text;
      }
      return [...injected, next === event ? block : rewrittenBlock(parsed, next)];
    }

    if (type === "response.content_part.done" && event?.item_id) {
      const itemId = String(event.item_id);
      const injected = [];
      if (this.#message && this.#message.id !== itemId) this.#retireMessage();
      if (!this.#message) injected.push(...this.#startMessage(event, parsed));
      let next = this.#rewriteMessageEvent(event);
      const part = event.part;
      if (part?.type !== "output_text" || typeof part?.reasoning === "string") {
        next = {
          ...next,
          part: {
            type: "output_text",
            text: this.#message.text,
            annotations: Array.isArray(part?.annotations) ? part.annotations : [],
          },
        };
      }
      if (part?.type === "output_text" && typeof part.text === "string") {
        this.#message.text = part.text;
      }
      return [
        ...injected,
        next === event ? block : rewrittenBlock(parsed, next),
      ];
    }

    if (type === "response.output_item.done" && event?.item?.type === "message") {
      const itemId = String(event.item.id || "");
      const injected = [];
      if (this.#message && itemId && this.#message.id !== itemId) this.#retireMessage();
      if (!this.#message) {
        injected.push(...this.#startMessage({ ...event, item_id: itemId }, parsed));
      }
      const item = sanitizeMessageItem(event.item, this.#message.text);
      this.#message.text = messageText(item) || this.#message.text;
      const next = this.#rewriteMessageEvent(
        item === event.item ? event : { ...event, item },
      );
      return [
        ...injected,
        next === event ? block : rewrittenBlock(parsed, next),
      ];
    }

    return [block];
  }
}

// Every routed provider whose turns LiteLLM translates from Chat Completions
// (`protocol: "openai"`, the default) gets the envelope repair. Native traffic
// has no provider and never gains the stage. `openai-responses` providers skip
// the bridge. Direct DeepSeek has its own bridge repair in
// deepseek-tool-message-compat.mjs. Anthropic Messages routes also cross the
// bridge, but arrive message-first with their envelope; widening this to them,
// or to another protocol, needs a captured stream from that protocol first.
export function messageEnvelopeCompatTransform(provider, contentType = "") {
  if (!String(contentType).toLowerCase().includes("text/event-stream")) return undefined;
  if (!provider || typeof provider !== "object" || !provider.id) return undefined;
  if (provider.id === "deepseek") return undefined;
  if ((provider.protocol ?? "openai") !== "openai") return undefined;
  return new ZaiResponsesCompatTransform();
}
