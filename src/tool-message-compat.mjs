import { Transform } from "node:stream";
import { StringDecoder } from "node:string_decoder";

function parsedEventBlock(block) {
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

function isToolCall(item) {
  return item?.type === "function_call" || item?.type === "custom_tool_call";
}

function isBlankPart(part) {
  if (!part || typeof part !== "object") return false;
  if (!["output_text", "text"].includes(part.type)) return false;
  return typeof part.text !== "string" || part.text.trim() === "";
}

function hasNonblankMessageText(part) {
  return (
    part != null &&
    typeof part === "object" &&
    ["output_text", "text"].includes(part.type) &&
    typeof part.text === "string" &&
    part.text.trim() !== ""
  );
}

function isBlankMessage(item) {
  if (item?.type !== "message") return false;
  if (typeof item.content === "string") return item.content.trim() === "";
  if (!Array.isArray(item.content)) return false;
  return item.content.length === 0 || item.content.every(isBlankPart);
}

function itemId(value) {
  return typeof value === "string" && value ? value : undefined;
}

function eventBelongsToMessage(event, id) {
  if (!id || !event) return false;
  if (
    ["response.output_item.added", "response.output_item.done"].includes(event.type) &&
    event.item?.type === "message"
  ) {
    return itemId(event.item.id) === id;
  }
  return (
    [
      "response.content_part.added",
      "response.output_text.delta",
      "response.output_text.done",
      "response.content_part.done",
    ].includes(event.type) && itemId(event.item_id) === id
  );
}

// Removes the empty message lifecycle that LiteLLM appends to a tool-only
// Chat-Completions -> Responses stream. LiteLLM may announce that message from
// an initial empty role chunk before the provider emits its tool call, so the
// announcement is held until text proves the message is real.
export class ToolMessageCompatTransform extends Transform {
  #decoder = new StringDecoder("utf8");
  #buffer = "";
  #announcedMessages = new Set();
  #heldFrames = [];
  #heldMessageId;
  #messagesWithText = new Set();
  #sawToolCall = false;
  #suppressedMessages = new Set();

  _transform(chunk, _encoding, callback) {
    this.#buffer += this.#decoder.write(chunk);
    this.#emitCompleteBlocks();
    callback();
  }

  _flush(callback) {
    this.#buffer += this.#decoder.end();
    this.#emitCompleteBlocks(true);
    for (const piece of this.#drainHeldFrames()) this.push(Buffer.from(piece));
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
        for (const piece of this.#rewriteFrame(block, "")) this.push(Buffer.from(piece));
        return;
      }
      const block = this.#buffer.slice(0, index);
      this.#buffer = this.#buffer.slice(index + separator.length);
      for (const piece of this.#rewriteFrame(block, separator)) {
        this.push(Buffer.from(piece));
      }
    }
  }

  #messageIsUnannouncedAndBlank(id, blank) {
    return (
      this.#sawToolCall &&
      Boolean(id) &&
      blank &&
      !this.#announcedMessages.has(id) &&
      !this.#messagesWithText.has(id)
    );
  }

  #drainHeldFrames(suppressId) {
    const held = this.#heldFrames;
    this.#heldFrames = [];
    this.#heldMessageId = undefined;
    if (!suppressId) return held.map((frame) => frame.original);

    this.#suppressedMessages.add(suppressId);
    const output = [];
    for (const frame of held) {
      const event = frame.parsed?.event;
      if (eventBelongsToMessage(event, suppressId)) continue;
      if (event?.type !== "response.completed" || !Array.isArray(event.response?.output)) {
        output.push(frame.original);
        continue;
      }
      const filtered = event.response.output.filter(
        (item) => !(itemId(item?.id) === suppressId && isBlankMessage(item)),
      );
      output.push(
        filtered.length === event.response.output.length
          ? frame.original
          : `${rewrittenBlock(frame.parsed, {
              ...event,
              response: { ...event.response, output: filtered },
            })}${frame.separator}`,
      );
    }
    return output;
  }

  #holdFrame(parsed, original, separator) {
    const event = parsed.event;
    const type = event?.type;
    const heldId = this.#heldMessageId;

    if (
      type === "response.output_item.added" &&
      event?.item?.type === "message" &&
      itemId(event.item.id) !== heldId
    ) {
      const released = this.#drainHeldFrames();
      const id = itemId(event.item.id);
      if (!id) return [...released, original];
      this.#announcedMessages.add(id);
      this.#heldMessageId = id;
      this.#heldFrames.push({ original, parsed, separator });
      return released;
    }

    this.#heldFrames.push({ original, parsed, separator });
    if (
      ["response.output_item.added", "response.output_item.done"].includes(type) &&
      isToolCall(event?.item)
    ) {
      this.#sawToolCall = true;
    }

    const nonblankText =
      (type === "response.output_text.delta" &&
        itemId(event.item_id) === heldId &&
        typeof event.delta === "string" &&
        event.delta.trim() !== "") ||
      (type === "response.output_text.done" &&
        itemId(event.item_id) === heldId &&
        typeof event.text === "string" &&
        event.text.trim() !== "") ||
      (type === "response.content_part.done" &&
        itemId(event.item_id) === heldId &&
        hasNonblankMessageText(event.part)) ||
      (type === "response.output_item.done" &&
        itemId(event.item?.id) === heldId &&
        event.item?.type === "message" &&
        !isBlankMessage(event.item));
    if (nonblankText) {
      this.#messagesWithText.add(heldId);
      return this.#drainHeldFrames();
    }

    if (
      type === "response.output_item.done" &&
      itemId(event.item?.id) === heldId &&
      isBlankMessage(event.item)
    ) {
      return this.#drainHeldFrames(this.#sawToolCall ? heldId : undefined);
    }

    if (type === "response.completed") {
      const output = Array.isArray(event.response?.output) ? event.response.output : [];
      const hasToolCall = output.some(isToolCall);
      const hasBlankHeldMessage = output.some(
        (item) => itemId(item?.id) === heldId && isBlankMessage(item),
      );
      return this.#drainHeldFrames(
        hasToolCall && hasBlankHeldMessage ? heldId : undefined,
      );
    }

    return [];
  }

  #rewriteFrame(block, separator) {
    const original = `${block}${separator}`;
    const parsed = parsedEventBlock(block);
    if (!parsed) {
      if (!this.#heldMessageId) return [original];
      this.#heldFrames.push({ original, parsed: undefined, separator });
      return block.includes("data: [DONE]") ? this.#drainHeldFrames() : [];
    }
    if (this.#heldMessageId) return this.#holdFrame(parsed, original, separator);

    const event = parsed.event;
    const type = event?.type;

    if (
      ["response.output_item.added", "response.output_item.done"].includes(type) &&
      isToolCall(event?.item)
    ) {
      this.#sawToolCall = true;
      return [original];
    }

    if (type === "response.output_item.added" && event?.item?.type === "message") {
      const id = itemId(event.item.id);
      if (!id) return [original];
      this.#announcedMessages.add(id);
      this.#heldMessageId = id;
      this.#heldFrames.push({ original, parsed, separator });
      return [];
    }

    if (type === "response.content_part.added") {
      const id = itemId(event.item_id);
      if (id) this.#announcedMessages.add(id);
      return [original];
    }

    if (type === "response.output_text.delta") {
      const id = itemId(event.item_id);
      if (id && typeof event.delta === "string" && event.delta.trim() !== "") {
        this.#messagesWithText.add(id);
      }
      return [original];
    }

    if (type === "response.output_text.done") {
      const id = itemId(event.item_id);
      if (id && typeof event.text === "string" && event.text.trim() !== "") {
        this.#messagesWithText.add(id);
      }
      return this.#messageIsUnannouncedAndBlank(
        id,
        typeof event.text === "string" && event.text.trim() === "",
      )
        ? []
        : [original];
    }

    if (type === "response.content_part.done") {
      const id = itemId(event.item_id);
      if (id && hasNonblankMessageText(event.part)) this.#messagesWithText.add(id);
      return this.#messageIsUnannouncedAndBlank(id, isBlankPart(event.part))
        ? []
        : [original];
    }

    if (type === "response.output_item.done" && event?.item?.type === "message") {
      const id = itemId(event.item.id);
      return this.#messageIsUnannouncedAndBlank(id, isBlankMessage(event.item))
        ? []
        : [original];
    }

    if (type === "response.completed" && Array.isArray(event?.response?.output)) {
      const output = event.response.output;
      const hasToolCall = output.some(isToolCall);
      if (!hasToolCall) return [original];
      this.#sawToolCall = true;
      const filtered = output.filter((item) => {
        if (!isBlankMessage(item)) return true;
        const id = itemId(item.id);
        if (id && this.#suppressedMessages.has(id)) return false;
        return !this.#messageIsUnannouncedAndBlank(id, true);
      });
      if (filtered.length === output.length) return [original];
      return [
        `${rewrittenBlock(parsed, {
            ...event,
            response: { ...event.response, output: filtered },
          })}${separator}`,
      ];
    }

    return [original];
  }
}

export function toolMessageCompatTransform(contentType = "") {
  if (!String(contentType).toLowerCase().includes("text/event-stream")) {
    return undefined;
  }
  return new ToolMessageCompatTransform();
}
