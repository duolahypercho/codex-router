import { Transform } from "node:stream";
import { StringDecoder } from "node:string_decoder";

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
  #decoder = new StringDecoder("utf8");
  #buffer = "";
  #reasoning;
  #pendingMessage = [];
  #currentSeparator = "";
  #message;
  #shiftOutputIndexes = false;

  _transform(chunk, _encoding, callback) {
    this.#buffer += this.#decoder.write(chunk);
    this.#emitCompleteBlocks();
    callback();
  }

  _flush(callback) {
    this.#buffer += this.#decoder.end();
    this.#emitCompleteBlocks(true);
    for (const piece of this.#flushPendingMessage(true)) this.push(Buffer.from(piece));
    callback();
  }

  #emitCompleteBlocks(flush = false) {
    while (this.#buffer.length) {
      const crlf = this.#buffer.indexOf("\r\n\r\n");
      const lf = this.#buffer.indexOf("\n\n");
      let index = -1;
      let separator = "";
      if (crlf !== -1 && (lf === -1 || crlf <= lf)) {
        index = crlf;
        separator = "\r\n\r\n";
      } else if (lf !== -1) {
        index = lf;
        separator = "\n\n";
      }
      if (index === -1) {
        if (!flush) return;
        const block = this.#buffer;
        this.#buffer = "";
        for (const piece of this.#rewriteBlock(block)) this.push(Buffer.from(piece));
        return;
      }
      const block = this.#buffer.slice(0, index);
      this.#buffer = this.#buffer.slice(index + separator.length);
      this.#currentSeparator = separator;
      for (const piece of this.#rewriteBlock(block)) {
        this.push(Buffer.from(`${piece}${separator}`));
      }
      this.#currentSeparator = "";
    }
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
    if (!this.#reasoning && type === "response.reasoning_summary_text.delta") {
      prefix = this.#startOrphanReasoning(parsed);
    } else if (!this.#reasoning && this.#pendingMessage.length > 0) {
      return [...this.#flushPendingMessage(), block];
    }

    if (type === "response.output_item.added" && event?.item?.type === "reasoning") {
      const id = typeof event.item.id === "string" ? event.item.id : "";
      if (!id) return [block];
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
