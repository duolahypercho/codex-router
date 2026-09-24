import { Transform } from "node:stream";
import { TextDecoder } from "node:util";

// LiteLLM's bridge echoes the request's instructions and full tool list in
// response.created, and a Codex Desktop tool list is larger than 256 KiB. A
// smaller pre-commit bound releases that first frame and turns the repair off
// for the whole stream, so match the namespace relay's prelude bound.
const MAX_FRAME_BYTES = 10 * 1024 * 1024;
const MAX_COMMITTED_FRAME_BYTES = 64 * 1024 * 1024;
const LF_FRAME_SEPARATOR = Buffer.from("\n\n");
const CRLF_FRAME_SEPARATOR = Buffer.from("\r\n\r\n");

class GrokReasoningSummaryCommittedStreamError extends Error {
  constructor(reason) {
    super(`Reasoning summary repair failed after stream mutation: ${reason}`);
    this.name = "GrokReasoningSummaryCommittedStreamError";
  }
}

// Grow geometrically and inspect each byte once so fragmented or unterminated
// frames cannot trigger repeated whole-buffer copies and delimiter scans.
class SseFrameAccumulator {
  #storage = Buffer.alloc(0);
  #length = 0;
  #maxFrameBytes;

  constructor(maxFrameBytes) {
    this.#maxFrameBytes = maxFrameBytes;
  }

  setMaxFrameBytes(maxFrameBytes) {
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

function summaryParts(item) {
  if (!Array.isArray(item?.summary)) return [];
  return item.summary.filter(
    (part) => part?.type === "summary_text" && typeof part.text === "string",
  );
}

function summaryText(item) {
  return summaryParts(item)
    .map((part) => part.text)
    .join("");
}

function isGatewayErrorEnvelope(event) {
  return event !== null && typeof event === "object" && !Array.isArray(event)
    && !Object.hasOwn(event, "type")
    && event.error !== null && typeof event.error === "object" && !Array.isArray(event.error);
}

// LiteLLM's Chat Completions -> Responses bridge can open an empty message
// before the model starts reasoning, and it hashes every reasoning delta into a
// different item_id. Codex drops those orphaned deltas, so the user sees no
// reasoning while the model is already streaming a summary. This was found on
// Grok and holds for every Chat Completions route through that bridge (Hy4,
// DeepSeek on resellers, ...). Normalize only that summary lifecycle; canonical
// streams pass byte-identical and non-SSE responses never enter here.
export class GrokReasoningSummaryCompatTransform extends Transform {
  #frames;
  #normalizeGatewayErrors;
  #disabled = false;
  #reasoning;
  #pendingMessage = [];
  #currentSeparator = "";
  #message;
  #shiftOutputIndexes = false;
  #maxCommittedFrameBytes;
  #mutationCommitted = false;
  #nextSequenceNumber;
  #repairedReasoningItems = [];
  #canonicalReasoningId;
  #gatewayErrorTerminal = false;

  constructor({
    maxFrameBytes = MAX_FRAME_BYTES,
    maxCommittedFrameBytes = MAX_COMMITTED_FRAME_BYTES,
    normalizeGatewayErrors = true,
  } = {}) {
    super();
    this.#normalizeGatewayErrors = normalizeGatewayErrors === true;
    const limit = Number.isInteger(maxFrameBytes) && maxFrameBytes > 0
      ? maxFrameBytes
      : MAX_FRAME_BYTES;
    const committedLimit = Number.isInteger(maxCommittedFrameBytes)
      && maxCommittedFrameBytes > 0
      ? maxCommittedFrameBytes
      : MAX_COMMITTED_FRAME_BYTES;
    this.#maxCommittedFrameBytes = Math.max(limit, committedLimit);
    this.#frames = new SseFrameAccumulator(limit);
  }

  _transform(chunk, _encoding, callback) {
    try {
      if (this.#gatewayErrorTerminal) {
        callback();
        return;
      }
      const piece = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      if (this.#disabled) {
        this.push(Buffer.from(piece));
        callback();
        return;
      }
      const outcome = this.#frames.write(piece, (block, separator, original) => (
        this.#emitFrame(block, separator, original)
      ));
      if (outcome?.oversized) this.#unsafeFrame(outcome.oversized, "SSE frame byte limit");
      if (!this.#gatewayErrorTerminal && outcome?.remainder?.length) this.push(outcome.remainder);
      callback();
    } catch (error) {
      callback(error);
    }
  }

  _flush(callback) {
    try {
      if (this.#gatewayErrorTerminal) {
        this.#frames.take();
        callback();
        return;
      }
      if (this.#disabled) {
        const pending = this.#frames.take();
        if (pending.length) this.push(pending);
        callback();
        return;
      }
      this.#frames.flush((block, separator, original) => {
        this.#emitFrame(block, separator, original);
      });
      if (this.#message?.prematureClose && !this.#message.textDone) {
        this.#pendingMessage = [];
      } else {
        for (const piece of this.#flushPendingMessage(true)) this.push(Buffer.from(piece));
      }
      callback();
    } catch (error) {
      callback(error);
    }
  }

  #emitFrame(block, separator, original) {
    let text;
    try {
      text = fatalUtf8(block);
    } catch {
      this.#unsafeFrame(original, "invalid UTF-8");
      return false;
    }
    this.#currentSeparator = separator.toString("ascii");
    const pieces = this.#rewriteBlock(text);
    const inferredSeparator = Buffer.from(text.includes("\r\n") ? "\r\n\r\n" : "\n\n");
    for (let index = 0; index < pieces.length; index += 1) {
      // The normalized terminal must be dispatchable even if the gateway
      // closed its last JSON frame without a blank line.
      const trailing = this.#gatewayErrorTerminal && !separator.length
        ? inferredSeparator
        : separator.length || index === pieces.length - 1
        ? separator
        : inferredSeparator;
      this.push(Buffer.concat([Buffer.from(pieces[index]), trailing]));
    }
    this.#currentSeparator = "";
    return !this.#disabled && !this.#gatewayErrorTerminal;
  }

  #disable(original) {
    for (const piece of this.#flushPendingMessage(true)) this.push(Buffer.from(piece));
    if (original?.length) this.push(original);
    this.#disabled = true;
  }

  #unsafeFrame(original, reason) {
    if (this.#mutationCommitted) {
      throw new GrokReasoningSummaryCommittedStreamError(reason);
    }
    this.#disable(original);
  }

  #commitMutation(parsed) {
    if (this.#mutationCommitted) return;
    const sequenceNumbers = [
      ...this.#pendingMessage.map(({ parsed: pending }) => pending.event?.sequence_number),
      parsed?.event?.sequence_number,
    ].filter(Number.isSafeInteger);
    if (sequenceNumbers.length) this.#nextSequenceNumber = Math.min(...sequenceNumbers);
    this.#mutationCommitted = true;
    this.#frames.setMaxFrameBytes(this.#maxCommittedFrameBytes);
  }

  #sequencedEvent(event) {
    if (!Number.isSafeInteger(this.#nextSequenceNumber)) return event;
    const next = { ...event, sequence_number: this.#nextSequenceNumber };
    this.#nextSequenceNumber += 1;
    return next;
  }

  #rewrittenBlock(parsed, event) {
    return rewrittenBlock(parsed, this.#sequencedEvent(event));
  }

  #syntheticBlock(type, event, parsed) {
    return syntheticBlock(type, this.#sequencedEvent(event), parsed);
  }

  #common(parsed) {
    return {
      item_id: this.#reasoning.id,
      output_index: this.#reasoning.outputIndex,
      summary_index: 0,
      ...(typeof parsed.event.model === "string" ? { model: parsed.event.model } : {}),
    };
  }

  #reasoningItem(status = this.#reasoning.status || "completed") {
    return {
      id: this.#reasoning.id,
      type: "reasoning",
      status,
      summary: status !== "in_progress" && this.#reasoning.partStarted
        ? [{ type: "summary_text", text: this.#reasoning.text }]
        : [],
    };
  }

  #rememberReasoningItem(item) {
    this.#repairedReasoningItems.push({
      outputIndex: this.#reasoning.outputIndex,
      item,
    });
  }

  #shiftedEvent(event) {
    if (!this.#shiftOutputIndexes || !Number.isInteger(event?.output_index)) return event;
    return { ...event, output_index: event.output_index + 1 };
  }

  #flushPendingMessage(preserveSeparators = false) {
    const pending = this.#pendingMessage;
    this.#pendingMessage = [];
    if (
      this.#message
      && pending.some(({ parsed }) => (
        parsed.event?.type === "response.output_text.delta"
        && typeof parsed.event.delta === "string"
        && parsed.event.delta.length > 0
      ))
    ) {
      this.#message.releasedText = true;
    }
    return pending.map(({ parsed, separator }) => (
      this.#rewrittenBlock(parsed, this.#shiftedEvent(parsed.event))
      + (preserveSeparators ? separator : "")
    ));
  }

  #isReasoningTextPartClose(type, event) {
    return type === "response.content_part.done"
      && event.item_id === this.#message?.id
      && event.part?.type === "reasoning_text";
  }

  #isResponseTerminal(type) {
    return type === "response.completed"
      || type === "response.done"
      || type === "response.incomplete";
  }

  #claimedOutputText(event) {
    return typeof event?.text === "string" ? event.text : this.#message?.text ?? "";
  }

  // LiteLLM can still emit `output_text.done` for the leaked prefix after it
  // closed the part as `reasoning_text`. That snapshot is not a finished
  // answer unless later deltas grew the text past the close.
  #isUnfinishedOutputTextDone(event) {
    return Boolean(
      this.#message?.prematureClose
      && !this.#message.textDone
      && this.#claimedOutputText(event) === (this.#message.textAtPrematureClose ?? "")
    );
  }

  // A held `output_text.done` that never grew into a finished sentence is
  // still leaked thinking: the 14:12 ImageGen retry stored
  // "I'll use the image generation" as `final_answer` after LiteLLM closed
  // that fragment as `output_text` (distinct from the reasoning_text match).
  // Short punctuated answers ("4.", "Done.") stay answers. A single token
  // with no whitespace (`CODEX_ROUTER_STREAM_OK`) is a finished marker, not
  // a mid-clause cut — treating every 20+ unpunctuated string as unfinished
  // 502'd the live streaming probe. Unmatched openers, trailing clause
  // marks, first-person planning openers, and dangling function words
  // remain unfinished.
  #isUnfinishedAssistantText(text) {
    const value = typeof text === "string" ? text.trimEnd() : "";
    if (!value) return true;
    const opens = (value.match(/[(\[{]/g) || []).length;
    const closes = (value.match(/[)\]}]/g) || []).length;
    if (opens > closes) return true;
    if (/[:,，、]$/u.test(value)) return true;
    if (/[.!?…]["'”’)\]]*$/u.test(value)) return false;
    if (!/\s/u.test(value)) return false;
    if (/^(I'll|I will|Let me|Let's|I'm going to|I am going to|I need to)\b/iu.test(value)) {
      return true;
    }
    return /\b(the|a|an|of|to|for|with|and|or|but)$/iu.test(value);
  }

  // Thinking copied onto `output_text` is the same string, or a prefix of the
  // thinking the finish sequence then closes as `reasoning_text`. A real
  // answer is a different string from that thinking.
  #isLeakedThinkingText(output, reasoning) {
    if (typeof output !== "string" || output.length === 0) return false;
    if (typeof reasoning !== "string" || reasoning.length === 0) return false;
    return reasoning === output || reasoning.startsWith(output);
  }

  #rewriteReasoningTextCloseToOutputText(parsed) {
    return this.#rewrittenBlock(parsed, this.#shiftedEvent({
      ...parsed.event,
      part: {
        type: "output_text",
        text: this.#message.text,
        annotations: [],
      },
    }));
  }

  #dropOrRewriteReasoningTextClose(parsed) {
    this.#commitMutation(parsed);
    const reasoning = typeof parsed.event?.part?.reasoning === "string"
      ? parsed.event.part.reasoning
      : "";
    if (!this.#message.textDone) {
      // LiteLLM's finish sequence emits `output_text.done` *before*
      // `content_part.done` `reasoning_text`. A done snapshot that is still
      // the thinking is truncated, same as close-then-same-done. A done
      // snapshot that is a different string is a real answer.
      if (
        this.#message.heldOutputTextDone
        && !this.#isLeakedThinkingText(this.#message.text, reasoning)
        && !this.#isUnfinishedAssistantText(this.#message.text)
      ) {
        this.#message.textDone = true;
        return [
          ...this.#flushPendingMessage(),
          this.#rewriteReasoningTextCloseToOutputText(parsed),
        ];
      }
      this.#message.prematureClose = true;
      this.#message.textAtPrematureClose = this.#message.text;
      return [];
    }
    return [this.#rewriteReasoningTextCloseToOutputText(parsed)];
  }

  #stripUnfinishedMessages(output) {
    if (!Array.isArray(output)) return output;
    return output.filter((item) => item?.type !== "message");
  }

  // A `reasoning_text` close before `output_text.done` is thinking, not the
  // end of the answer. If the stream then completes with only the prefix
  // that had already leaked onto `output_text`, withhold that message so
  // empty-completion can retry (or fail after a retry) instead of storing a
  // mid-sentence `final_answer`. Visible bytes that already left this stage
  // cannot be un-said, so that path becomes `response.incomplete`.
  #truncatedCompletion(parsed, event) {
    this.#pendingMessage = [];
    this.#commitMutation(parsed);
    const output = this.#stripUnfinishedMessages(event.response?.output);
    const response = event.response
      ? { ...event.response, output }
      : event.response;
    if (this.#message?.releasedText) {
      return [this.#rewrittenBlock(parsed, this.#shiftedEvent({
        ...event,
        type: "response.incomplete",
        response: response ? { ...response, status: "incomplete" } : response,
      }))];
    }
    return [this.#rewrittenBlock(parsed, this.#shiftedEvent({
      ...event,
      response,
    }))];
  }

  #startOrphanReasoning(parsed) {
    this.#commitMutation(parsed);
    const event = parsed.event;
    const outputIndex = this.#message?.outputIndex
      ?? (Number.isInteger(event.output_index) ? event.output_index : 0);
    this.#shiftOutputIndexes = this.#pendingMessage.length > 0;
    this.#reasoning = {
      id: typeof event.item_id === "string" && event.item_id ? event.item_id : "rs_reasoning_summary",
      outputIndex,
      text: "",
      partStarted: false,
      textDone: false,
      partDone: false,
      itemDone: false,
      status: "in_progress",
      synthetic: true,
    };
    return [this.#syntheticBlock(
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
    return [this.#syntheticBlock(
      "response.reasoning_summary_part.added",
      {
        ...this.#common(parsed),
        part: { type: "summary_text", text: "" },
      },
      parsed,
    )];
  }

  #finishReasoning(parsed, status = "completed") {
    if (!this.#reasoning || this.#reasoning.itemDone) return [];
    this.#reasoning.status = status;
    const output = [];
    output.push(...this.#startSummaryPart(parsed));
    if (!this.#reasoning.textDone) {
      this.#reasoning.textDone = true;
      output.push(this.#syntheticBlock(
        "response.reasoning_summary_text.done",
        { ...this.#common(parsed), text: this.#reasoning.text },
        parsed,
      ));
    }
    if (!this.#reasoning.partDone) {
      this.#reasoning.partDone = true;
      output.push(this.#syntheticBlock(
        "response.reasoning_summary_part.done",
        {
          ...this.#common(parsed),
          part: { type: "summary_text", text: this.#reasoning.text },
        },
        parsed,
      ));
    }
    this.#reasoning.itemDone = true;
    const item = this.#reasoningItem();
    output.push(this.#syntheticBlock(
      "response.output_item.done",
      {
        output_index: this.#reasoning.outputIndex,
        item,
        ...(typeof parsed.event.model === "string" ? { model: parsed.event.model } : {}),
      },
      parsed,
    ));
    this.#rememberReasoningItem(item);
    return output;
  }

  #rewriteBlock(block) {
    const parsed = eventBlock(block);
    if (!parsed) return [block];
    const event = parsed.event;
    const type = event?.type;

    // LiteLLM can turn a forwarder SSE error into an untyped gateway error,
    // then append empty message closes. Recognize only the top-level envelope;
    // text containing error-shaped JSON and canonical typed events stay intact.
    // The Grok OAuth wording is proven for that route alone, so other routes
    // relay the envelope byte-identical, after closing anything held here.
    if (isGatewayErrorEnvelope(event) && !this.#normalizeGatewayErrors) {
      return [
        ...this.#finishReasoning(parsed, "incomplete"),
        ...this.#flushPendingMessage(),
        block,
      ];
    }
    if (isGatewayErrorEnvelope(event)) {
      this.#commitMutation(parsed);
      const prefix = this.#finishReasoning(parsed, "incomplete");
      this.#pendingMessage = [];
      this.#gatewayErrorTerminal = true;
      // Gateway messages may contain stack traces or request payloads. Emit a
      // fixed safe error and suppress the rest of this upstream stream.
      return [...prefix, this.#syntheticBlock("error", {
        code: "local_router_stream_failed",
        message: "The Grok gateway could not complete the upstream response stream.",
        param: null,
      }, {
        ...parsed,
        lines: ["event: error"],
        newline: this.#currentSeparator === "\r\n\r\n" ? "\r\n" : parsed.newline,
      })];
    }

    if (!this.#reasoning && type === "response.output_item.added" && event?.item?.type === "message") {
      this.#message = {
        id: event.item.id,
        outputIndex: Number.isInteger(event.output_index) ? event.output_index : 0,
        text: "",
        textDone: false,
        prematureClose: false,
        textAtPrematureClose: "",
        releasedText: false,
        heldOutputTextDone: false,
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
      // LiteLLM can close the held message part as `reasoning_text` before
      // or after `output_text.done`, including after visible deltas have
      // already started. Hold those deltas (and the done snapshot) here:
      // flushing them would let Codex store a leaked prefix as
      // `final_answer` when the stream then completes.
      if (this.#isReasoningTextPartClose(type, event)) {
        return this.#dropOrRewriteReasoningTextClose(parsed);
      }
      if (type === "response.output_text.delta" && event.item_id === this.#message?.id) {
        this.#message.text += typeof event.delta === "string" ? event.delta : "";
        this.#pendingMessage.push({ parsed, separator: this.#currentSeparator });
        return [];
      }
      if (type === "response.output_text.done" && event.item_id === this.#message?.id) {
        if (this.#isUnfinishedOutputTextDone(event)) return [];
        if (typeof event.text === "string" && event.text.length > 0) {
          this.#message.text = event.text;
        }
        // LiteLLM 1.96's Chat Completions → Responses finish sequence emits
        // `output_text.done` before `content_part.done`. Committing here
        // stores a leaked prefix as `final_answer` when that close is then
        // `reasoning_text` (the GTA-style AAA ImageGen turn). Hold the
        // snapshot until the part close says whether the text grew into an
        // answer.
        this.#message.heldOutputTextDone = true;
        this.#pendingMessage.push({ parsed, separator: this.#currentSeparator });
        return [];
      }
      if (
        type === "response.content_part.done"
        && event.item_id === this.#message?.id
        && this.#message.heldOutputTextDone
        && !this.#message.textDone
        && event.part?.type === "output_text"
      ) {
        const text = typeof event.part.text === "string" && event.part.text
          ? event.part.text
          : this.#message.text;
        this.#message.text = text;
        if (this.#isUnfinishedAssistantText(text)) {
          this.#message.prematureClose = true;
          this.#message.textAtPrematureClose = text;
          return [];
        }
        this.#message.textDone = true;
        return [...this.#flushPendingMessage(), block];
      }
      if (
        this.#isResponseTerminal(type)
        && this.#message.heldOutputTextDone
        && !this.#message.textDone
        && this.#isUnfinishedAssistantText(this.#message.text)
      ) {
        this.#message.prematureClose = true;
        return this.#truncatedCompletion(parsed, event);
      }
      if (
        type === "response.output_item.done"
        && event.item?.type === "message"
        && event.item.id === this.#message?.id
        && !this.#message.textDone
        && this.#message.prematureClose
      ) {
        return [];
      }
      if (
        this.#isResponseTerminal(type)
        && this.#message.prematureClose
        && !this.#message.textDone
      ) {
        return this.#truncatedCompletion(parsed, event);
      }
      if (this.#message.prematureClose && !this.#message.textDone) {
        if (
          type === "response.output_item.added"
          && event?.item?.type
          && event.item.type !== "message"
          && event.item.type !== "reasoning"
        ) {
          this.#pendingMessage = [];
          return [block];
        }
        return [];
      }
      return [...this.#flushPendingMessage(), block];
    }

    if (type === "response.output_item.added" && event?.item?.type === "reasoning") {
      const id = typeof event.item.id === "string" ? event.item.id : "";
      // A canonical Responses item already has an array-valued summary. Leave
      // that lifecycle byte-identical, including any additional summary parts.
      if (!id) return [block];
      if (Array.isArray(event.item.summary)) {
        const output = this.#reasoning && !this.#reasoning.itemDone
          ? this.#finishReasoning(parsed)
          : [];
        if (this.#reasoning?.itemDone) {
          this.#canonicalReasoningId = id;
          return [...output, this.#rewrittenBlock(parsed, this.#shiftedEvent(event))];
        }
        return [block];
      }
      this.#commitMutation(parsed);
      this.#reasoning = {
        id,
        outputIndex: Number.isInteger(event.output_index) ? event.output_index : 0,
        text: summaryText(event.item),
        partStarted: false,
        textDone: false,
        partDone: false,
        itemDone: false,
        status: "in_progress",
        synthetic: false,
      };
      const item = { ...event.item, summary: [] };
      return [this.#rewrittenBlock(parsed, { ...event, item })];
    }

    if (!this.#reasoning) {
      if (this.#isReasoningTextPartClose(type, event) && this.#message) {
        return this.#dropOrRewriteReasoningTextClose(parsed);
      }
      if (
        type === "response.output_text.done"
        && event.item_id === this.#message?.id
        && this.#isUnfinishedOutputTextDone(event)
      ) {
        return [];
      }
      if (
        this.#isResponseTerminal(type)
        && this.#message?.prematureClose
        && !this.#message.textDone
      ) {
        return this.#truncatedCompletion(parsed, event);
      }
      return [block];
    }

    if (this.#canonicalReasoningId) {
      const canonicalLifecycle = (
        typeof type === "string"
        && type.startsWith("response.reasoning_summary_")
        && event.item_id === this.#canonicalReasoningId
      ) || (
        type === "response.output_item.done"
        && event.item?.type === "reasoning"
        && event.item.id === this.#canonicalReasoningId
      );
      if (canonicalLifecycle) {
        if (type === "response.output_item.done") this.#canonicalReasoningId = undefined;
        return [this.#rewrittenBlock(parsed, this.#shiftedEvent(event))];
      }
    }

    if (type === "response.reasoning_summary_part.added") {
      if (this.#reasoning.partStarted) return [];
      this.#reasoning.partStarted = true;
      return [this.#rewrittenBlock(parsed, {
        ...event,
        ...this.#common(parsed),
        part: { type: "summary_text", text: "" },
      })];
    }

    if (type === "response.reasoning_summary_text.delta" && typeof event.delta === "string") {
      if (this.#reasoning.itemDone) return [];
      prefix.push(...this.#startSummaryPart(parsed));
      this.#reasoning.text += event.delta;
      return [...prefix, this.#rewrittenBlock(parsed, {
        ...event,
        ...this.#common(parsed),
      })];
    }

    if (type === "response.reasoning_summary_text.done") {
      if (this.#reasoning.itemDone) return [];
      const prefix = this.#startSummaryPart(parsed);
      if (typeof event.text === "string") this.#reasoning.text = event.text;
      this.#reasoning.textDone = true;
      return [...prefix, this.#rewrittenBlock(parsed, {
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
      return [...prefix, this.#rewrittenBlock(parsed, {
        ...event,
        ...this.#common(parsed),
        part: { type: "summary_text", text },
      })];
    }

    if (type === "response.output_item.done" && event?.item?.type === "reasoning") {
      if (this.#reasoning.itemDone) return [];
      const prefix = [];
      const terminalParts = summaryParts(event.item);
      if (terminalParts.length && !this.#reasoning.textDone) {
        this.#reasoning.text = terminalParts.map((part) => part.text).join("");
      }
      if (!this.#reasoning.partStarted && terminalParts.length) {
        prefix.push(...this.#startSummaryPart(parsed));
      }
      if (this.#reasoning.partStarted && !this.#reasoning.textDone) {
        this.#reasoning.textDone = true;
        prefix.push(this.#syntheticBlock(
          "response.reasoning_summary_text.done",
          { ...this.#common(parsed), text: this.#reasoning.text },
          parsed,
        ));
      }
      if (this.#reasoning.partStarted && !this.#reasoning.partDone) {
        this.#reasoning.partDone = true;
        prefix.push(this.#syntheticBlock(
          "response.reasoning_summary_part.done",
          {
            ...this.#common(parsed),
            part: { type: "summary_text", text: this.#reasoning.text },
          },
          parsed,
        ));
      }
      const status = ["completed", "incomplete"].includes(event.item.status)
        ? event.item.status
        : "completed";
      this.#reasoning.status = status;
      const item = {
        ...event.item,
        id: this.#reasoning.id,
        status,
        summary: this.#reasoning.partStarted
          ? [{ type: "summary_text", text: this.#reasoning.text }]
          : [],
      };
      this.#reasoning.itemDone = true;
      this.#rememberReasoningItem(item);
      return [...prefix, this.#rewrittenBlock(parsed, {
        ...event,
        output_index: this.#reasoning.outputIndex,
        item,
      })];
    }

    const unfinishedMessageDone = type === "response.output_item.done"
      && event?.item?.type === "message"
      && event.item.id === this.#message?.id
      && this.#message
      && !this.#message.textDone
      && this.#message.prematureClose;
    const unfinishedOutputTextDone = type === "response.output_text.done"
      && event.item_id === this.#message?.id
      && this.#isUnfinishedOutputTextDone(event);
    const startsVisibleOutput = type === "response.output_text.delta"
      || (type === "response.output_text.done" && !unfinishedOutputTextDone)
      || type === "response.refusal.delta"
      || type === "response.refusal.done"
      || (type === "response.output_item.added" && event?.item?.type !== "reasoning")
      || (
        type === "response.output_item.done"
        && event?.item?.type !== "reasoning"
        && !unfinishedMessageDone
      )
      || type === "response.function_call_arguments.delta";
    if (startsVisibleOutput) {
      if (!this.#reasoning.itemDone) prefix.push(...this.#finishReasoning(parsed));
      prefix.push(...this.#flushPendingMessage());
    }

    if (type === "response.output_text.delta" && event.item_id === this.#message?.id) {
      this.#message.text += typeof event.delta === "string" ? event.delta : "";
      if (typeof event.delta === "string" && event.delta.length > 0) {
        this.#message.releasedText = true;
      }
    } else if (type === "response.output_text.done" && event.item_id === this.#message?.id) {
      if (!unfinishedOutputTextDone) {
        if (typeof event.text === "string") this.#message.text = event.text;
        this.#message.textDone = true;
      }
    }

    if (this.#isReasoningTextPartClose(type, event)) {
      // After the answer has finished, LiteLLM still labels this close as
      // thinking. Rewrite it so Codex stores `output_text`. Before that, the
      // same event is a premature close: keeping it would truncate a live
      // identity reply mid-sentence while later deltas are dropped.
      prefix.push(...this.#dropOrRewriteReasoningTextClose(parsed));
      return prefix;
    }

    if (unfinishedMessageDone || unfinishedOutputTextDone) return prefix;

    const failureTerminal = type === "response.failed"
      || type === "response.error"
      || type === "error";
    if (failureTerminal && !Array.isArray(event.response?.output)) {
      prefix.push(...this.#finishReasoning(parsed, "incomplete"));
      this.#pendingMessage = [];
      const rewritten = this.#rewrittenBlock(parsed, event);
      this.#reasoning = undefined;
      this.#repairedReasoningItems = [];
      this.#canonicalReasoningId = undefined;
      this.#shiftOutputIndexes = false;
      return [...prefix, rewritten];
    }

    const terminalResponse = type === "response.completed"
      || type === "response.incomplete"
      || type === "response.done"
      || failureTerminal;
    if (
      this.#isResponseTerminal(type)
      && this.#message?.prematureClose
      && !this.#message.textDone
    ) {
      if (!this.#reasoning.itemDone) prefix.push(...this.#finishReasoning(parsed, "incomplete"));
      prefix.push(...this.#truncatedCompletion(parsed, event));
      this.#reasoning = undefined;
      this.#repairedReasoningItems = [];
      this.#canonicalReasoningId = undefined;
      this.#shiftOutputIndexes = false;
      return prefix;
    }
    if (terminalResponse && Array.isArray(event.response?.output)) {
      const itemStatus = type === "response.completed" ? "completed" : "incomplete";
      prefix.push(
        ...this.#finishReasoning(parsed, itemStatus),
        ...this.#flushPendingMessage(),
      );
      const repaired = [...this.#repairedReasoningItems]
        .sort((left, right) => left.outputIndex - right.outputIndex);
      const output = event.response.output.map((item) => (
        item?.type === "message" && this.#message?.id
          ? { ...item, id: this.#message.id }
          : item
      ));
      for (const repair of repaired) {
        const index = Math.min(Math.max(repair.outputIndex, 0), output.length);
        if (output[index]?.type === "reasoning") output[index] = repair.item;
        else output.splice(index, 0, repair.item);
      }
      const unchanged = !this.#reasoning.synthetic
        && JSON.stringify(output) === JSON.stringify(event.response.output);
      const next = unchanged
        ? event
        : { ...event, response: { ...event.response, output } };
      const rewritten = this.#rewrittenBlock(parsed, next);
      this.#reasoning = undefined;
      this.#repairedReasoningItems = [];
      this.#canonicalReasoningId = undefined;
      this.#shiftOutputIndexes = false;
      return [...prefix, rewritten];
    }

    return [...prefix, this.#rewrittenBlock(parsed, this.#shiftedEvent(event))];
  }
}

// Grok OAuth keeps its gateway-error normalization. Every other provider whose
// turns LiteLLM translates from Chat Completions gets the summary repair only.
// Direct DeepSeek has its own reasoning bridge repair in
// deepseek-tool-message-compat.mjs. Native Responses providers skip this
// bridge. Anthropic Messages providers do not: litellm-config.mjs still sets
// `use_chat_completions_api: true` for them, so every `protocol: "anthropic"`
// route arrives as the same message-first, hashed
// `reasoning_summary_text.delta` / `content_part.done` `reasoning_text` stream
// this transform repairs. Leaving them out classified those turns empty.
export function reasoningSummaryCompatTransform(provider, contentType = "") {
  if (!String(contentType).toLowerCase().includes("text/event-stream")) return undefined;
  const providerId = typeof provider === "string" ? provider : provider?.id;
  if (providerId === "grok-oauth") return new GrokReasoningSummaryCompatTransform();
  if (!provider || typeof provider !== "object" || providerId === "deepseek") return undefined;
  const protocol = provider.protocol ?? "openai";
  if (protocol !== "openai" && protocol !== "anthropic") return undefined;
  return new GrokReasoningSummaryCompatTransform({ normalizeGatewayErrors: false });
}
