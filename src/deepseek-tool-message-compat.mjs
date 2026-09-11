import { Transform } from "node:stream";
import { isDeepStrictEqual, TextDecoder } from "node:util";

import { jsonNumberIsStableForRewrite } from "./json-number-rewrite.mjs";

const MAX_CANDIDATE_BYTES = 64 * 1024;
const MAX_CANDIDATE_MS = 1_000;
const MAX_DIRECT_CAPTURE_MS = 60_000;
// LiteLLM's Chat Completions bridge echoes the request's instructions and full
// tools array in response.created and response.in_progress: measured against
// the pinned 1.96.0, a 300-tool list makes each of those frames 409 KiB. A
// frame over this pre-commit bound is released raw and turns the repair off
// for the rest of the stream, so match the namespace relay's prelude bound.
const MAX_FRAME_BYTES = 10 * 1024 * 1024;
const MAX_JSON_BYTES = 8 * 1024 * 1024;
const MAX_JSON_MS = 1_000;
const MAX_JSON_DEPTH = 256;
// The uniqueness scan's per-frame budgets scale with the frame bound, at the
// density the 256 KiB bound allowed: one member per 32 bytes and one key code
// unit per 2 bytes. A Desktop tool list is member-dense JSON Schema, so a
// fixed 8 KiB member budget would fail that same frame open.
const MAX_FRAME_JSON_MEMBERS = MAX_FRAME_BYTES / 32;
const MAX_BODY_JSON_MEMBERS = 64 * 1024;
const MAX_FRAME_JSON_KEY_CODE_UNITS = MAX_FRAME_BYTES / 2;
// Frame storage above an ordinary event's size is dropped once its frame is
// taken, so one large prelude does not pin that capacity for the whole stream.
const RETAINED_FRAME_STORAGE_BYTES = 256 * 1024;
const MAX_BODY_JSON_KEY_CODE_UNITS = 1024 * 1024;
const LF_FRAME_SEPARATOR = Buffer.from("\n\n");
const CRLF_FRAME_SEPARATOR = Buffer.from("\r\n\r\n");
const TERMINAL_ONLY_CANDIDATE_SLOT = Symbol("terminal-only-candidate");
const RESPONSE_EVENT_KEYS = new Set(["type", "sequence_number", "response"]);
const OUTPUT_ITEM_EVENT_KEYS = new Set([
  "type",
  "sequence_number",
  "output_index",
  "item",
]);
const CONTENT_PART_EVENT_KEYS = new Set([
  "type",
  "sequence_number",
  "item_id",
  "output_index",
  "content_index",
  "part",
]);
const TEXT_DELTA_EVENT_KEYS = new Set([
  "type",
  "sequence_number",
  "item_id",
  "output_index",
  "content_index",
  "delta",
  "logprobs",
  "obfuscation",
]);
const TEXT_DONE_EVENT_KEYS = new Set([
  "type",
  "sequence_number",
  "item_id",
  "output_index",
  "content_index",
  "text",
  "logprobs",
]);
const TOOL_DELTA_EVENT_KEYS = new Set([
  "type",
  "sequence_number",
  "item_id",
  "output_index",
  "delta",
  "obfuscation",
]);
const FUNCTION_DONE_EVENT_KEYS = new Set([
  "type",
  "sequence_number",
  "item_id",
  "output_index",
  "arguments",
]);
const CUSTOM_DONE_EVENT_KEYS = new Set([
  "type",
  "sequence_number",
  "item_id",
  "output_index",
  "input",
]);
const REASONING_PART_EVENT_KEYS = new Set([
  "type",
  "sequence_number",
  "item_id",
  "output_index",
  "summary_index",
  "content_index",
  "part",
]);
const REASONING_TEXT_DELTA_EVENT_KEYS = new Set([
  "type",
  "sequence_number",
  "item_id",
  "output_index",
  "summary_index",
  "content_index",
  "delta",
  "obfuscation",
]);
const REASONING_TEXT_DONE_EVENT_KEYS = new Set([
  "type",
  "sequence_number",
  "item_id",
  "output_index",
  "summary_index",
  "content_index",
  "text",
]);
const CANDIDATE_MESSAGE_KEYS = new Set([
  "id",
  "type",
  "status",
  "role",
  "content",
  "phase",
]);
const FUNCTION_CALL_KEYS = new Set([
  "id",
  "type",
  "status",
  "arguments",
  "call_id",
  "name",
]);
const CUSTOM_TOOL_CALL_KEYS = new Set([
  "id",
  "type",
  "status",
  "input",
  "call_id",
  "name",
]);
const REASONING_ITEM_KEYS = new Set([
  "id",
  "type",
  "status",
  "summary",
  "content",
  "encrypted_content",
]);
const REASONING_PART_KEYS = new Set(["type", "text"]);
const EMPTY_REASONING_PART_KEYS = new Set(["type", "reasoning"]);
const REFUSAL_PART_KEYS = new Set(["type", "refusal"]);
const TERMINAL_EMPTY_PART_KEYS = new Set([
  "type",
  "text",
  "annotations",
  "logprobs",
]);
const TERMINAL_EMPTY_MESSAGE_KEYS = new Set([
  "id",
  "type",
  "status",
  "role",
  "content",
  "phase",
]);
const DIRECT_MESSAGE_KEYS = new Set(["id", "type", "status", "role", "content"]);
const DIRECT_REASONING_ITEM_KEYS = new Set([
  "id",
  "type",
  "status",
  "role",
  "content",
]);
const DIRECT_REASONING_OUTPUT_PART_KEYS = new Set([
  "type",
  "text",
  "annotations",
]);
const DIRECT_HISTORICAL_RESPONSE_KEYS = new Set(["id", "status", "output"]);

// Keep an undecided SSE frame in one reusable, geometrically grown buffer.
// Every input byte is copied and scanned once; completing a frame makes the
// one independent copy its lifecycle may need to retain. This avoids both the
// repeated Buffer.concat of a fragmented frame and the repeated whole-buffer
// delimiter scans that otherwise make one-byte upstream chunks quadratic.
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
        const original = this.take();
        return {
          oversized: original,
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
    if (this.#storage.length > RETAINED_FRAME_STORAGE_BYTES) {
      this.#storage = Buffer.alloc(0);
    }
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
      this.#length >= LF_FRAME_SEPARATOR.length &&
      this.#storage[this.#length - 2] === 0x0a &&
      this.#storage[this.#length - 1] === 0x0a
    ) {
      return LF_FRAME_SEPARATOR;
    }
    if (
      this.#length >= CRLF_FRAME_SEPARATOR.length &&
      this.#storage[this.#length - 4] === 0x0d &&
      this.#storage[this.#length - 3] === 0x0a &&
      this.#storage[this.#length - 2] === 0x0d &&
      this.#storage[this.#length - 1] === 0x0a
    ) {
      return CRLF_FRAME_SEPARATOR;
    }
    return undefined;
  }
}

const EVENT_KEYS = new Map([
  ["response.created", RESPONSE_EVENT_KEYS],
  ["response.in_progress", RESPONSE_EVENT_KEYS],
  ["response.completed", RESPONSE_EVENT_KEYS],
  ["response.output_item.added", OUTPUT_ITEM_EVENT_KEYS],
  ["response.output_item.done", OUTPUT_ITEM_EVENT_KEYS],
  ["response.content_part.added", CONTENT_PART_EVENT_KEYS],
  ["response.content_part.done", CONTENT_PART_EVENT_KEYS],
  ["response.output_text.delta", TEXT_DELTA_EVENT_KEYS],
  ["response.output_text.done", TEXT_DONE_EVENT_KEYS],
  ["response.function_call_arguments.delta", TOOL_DELTA_EVENT_KEYS],
  ["response.function_call_arguments.done", FUNCTION_DONE_EVENT_KEYS],
  ["response.custom_tool_call_input.delta", TOOL_DELTA_EVENT_KEYS],
  ["response.custom_tool_call_input.done", CUSTOM_DONE_EVENT_KEYS],
  ["response.reasoning_summary_part.added", REASONING_PART_EVENT_KEYS],
  ["response.reasoning_summary_part.done", REASONING_PART_EVENT_KEYS],
  ["response.reasoning_summary_text.delta", REASONING_TEXT_DELTA_EVENT_KEYS],
  ["response.reasoning_summary_text.done", REASONING_TEXT_DONE_EVENT_KEYS],
  ["response.reasoning_text.delta", REASONING_TEXT_DELTA_EVENT_KEYS],
  ["response.reasoning_text.done", REASONING_TEXT_DONE_EVENT_KEYS],
]);

function plainObject(value) {
  return value != null && typeof value === "object" && !Array.isArray(value)
    ? value
    : undefined;
}

function exactKeys(value, allowed) {
  const object = plainObject(value);
  return object !== undefined && Object.keys(object).every((key) => allowed.has(key));
}

function validSequenceNumber(event) {
  return event.sequence_number === undefined ||
    (Number.isInteger(event.sequence_number) && event.sequence_number >= 0);
}

function validObfuscation(event) {
  return event.obfuscation === undefined || typeof event.obfuscation === "string";
}

function exactEventKeys(event) {
  const allowed = EVENT_KEYS.get(event?.type);
  const object = plainObject(event);
  return allowed !== undefined && object !== undefined &&
    Object.keys(object).every((key) => allowed.has(key) || key === "model") &&
    validSequenceNumber(event);
}

function fatalUtf8(buffer) {
  // Preserve a leading BOM as a real code point. It is not part of the
  // confirmed bridge grammar, so the parser will fail open instead of silently
  // dropping three raw bytes while decoding a frame or JSON body.
  return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(buffer);
}

// JSON.parse silently keeps only the last occurrence of a duplicate object
// member and accepts numbers that JSON.stringify cannot reproduce faithfully.
// Either is unsafe here because a later stringify could erase an earlier
// visible/error value or change numeric provenance. Scan the bounded source
// first, decoding object keys so equivalent escape spellings compare as the
// same member and rejecting the parsed-number classes that are lossy on the
// return trip.
function strictJsonPreflight(source, limits) {
  let offset = 0;
  let rootState = "value";
  let memberCount = 0;
  let keyCodeUnits = 0;
  const stack = [];

  const whitespace = (code) => (
    code === 0x20 || code === 0x09 || code === 0x0a || code === 0x0d
  );
  const hexValue = (code) => {
    if (code >= 0x30 && code <= 0x39) return code - 0x30;
    if (code >= 0x41 && code <= 0x46) return code - 0x41 + 10;
    if (code >= 0x61 && code <= 0x66) return code - 0x61 + 10;
    return -1;
  };
  const scanString = (decodeKey = false) => {
    if (source.charCodeAt(offset) !== 0x22) return undefined;
    offset += 1;
    let segmentStart = offset;
    let decodedLength = 0;
    const parts = decodeKey ? [] : undefined;
    const appendRawSegment = (end) => {
      if (!decodeKey || end === segmentStart) return true;
      decodedLength += end - segmentStart;
      if (keyCodeUnits + decodedLength > limits.maxKeyCodeUnits) return false;
      parts.push(source.slice(segmentStart, end));
      return true;
    };
    while (offset < source.length) {
      const code = source.charCodeAt(offset);
      if (code === 0x22) {
        if (!appendRawSegment(offset)) return undefined;
        offset += 1;
        return decodeKey
          ? { key: parts.join(""), codeUnits: decodedLength }
          : { codeUnits: 0 };
      }
      if (code < 0x20) return undefined;
      if (code !== 0x5c) {
        offset += 1;
        continue;
      }
      if (!appendRawSegment(offset)) return undefined;
      offset += 1;
      if (offset >= source.length) return undefined;
      const escape = source[offset];
      let decoded;
      if (escape === "u") {
        if (offset + 4 >= source.length) return undefined;
        let value = 0;
        for (let index = 1; index <= 4; index += 1) {
          const hex = hexValue(source.charCodeAt(offset + index));
          if (hex < 0) return undefined;
          value = (value * 16) + hex;
        }
        decoded = String.fromCharCode(value);
        offset += 5;
      } else {
        const escapes = {
          '"': '"',
          "\\": "\\",
          "/": "/",
          b: "\b",
          f: "\f",
          n: "\n",
          r: "\r",
          t: "\t",
        };
        decoded = escapes[escape];
        if (decoded === undefined) return undefined;
        offset += 1;
      }
      if (decodeKey) {
        decodedLength += 1;
        if (keyCodeUnits + decodedLength > limits.maxKeyCodeUnits) return undefined;
        parts.push(decoded);
      }
      segmentStart = offset;
    }
    return undefined;
  };
  const scanNumber = () => {
    const start = offset;
    if (source[offset] === "-") offset += 1;
    if (source[offset] === "0") {
      offset += 1;
    } else {
      const first = source.charCodeAt(offset);
      if (first < 0x31 || first > 0x39) return false;
      offset += 1;
      while (source.charCodeAt(offset) >= 0x30 && source.charCodeAt(offset) <= 0x39) {
        offset += 1;
      }
    }
    if (source[offset] === ".") {
      offset += 1;
      const first = source.charCodeAt(offset);
      if (first < 0x30 || first > 0x39) return false;
      while (source.charCodeAt(offset) >= 0x30 && source.charCodeAt(offset) <= 0x39) {
        offset += 1;
      }
    }
    if (source[offset] === "e" || source[offset] === "E") {
      offset += 1;
      if (source[offset] === "+" || source[offset] === "-") offset += 1;
      const first = source.charCodeAt(offset);
      if (first < 0x30 || first > 0x39) return false;
      while (source.charCodeAt(offset) >= 0x30 && source.charCodeAt(offset) <= 0x39) {
        offset += 1;
      }
    }
    return jsonNumberIsStableForRewrite(source.slice(start, offset));
  };
  const completeValue = () => {
    const parent = stack.at(-1);
    if (!parent) {
      if (rootState !== "value") return false;
      rootState = "done";
      return true;
    }
    if (parent.state !== "value") return false;
    parent.state = "commaOrEnd";
    return true;
  };
  const beginContainer = (kind) => {
    if (stack.length >= limits.maxDepth) return false;
    stack.push(kind === "object"
      ? { kind, state: "keyOrEnd", keys: new Set() }
      : { kind, state: "valueOrEnd" });
    return true;
  };
  const scanValue = () => {
    const token = source[offset];
    if (token === "{") {
      offset += 1;
      return beginContainer("object");
    }
    if (token === "[") {
      offset += 1;
      return beginContainer("array");
    }
    if (token === '"') {
      if (!scanString()) return false;
      return completeValue();
    }
    for (const literal of ["true", "false", "null"]) {
      if (source.startsWith(literal, offset)) {
        offset += literal.length;
        return completeValue();
      }
    }
    if (token === "-" || (token >= "0" && token <= "9")) {
      if (!scanNumber()) return false;
      return completeValue();
    }
    return false;
  };

  while (offset < source.length) {
    while (offset < source.length && whitespace(source.charCodeAt(offset))) offset += 1;
    if (offset >= source.length) break;
    const frame = stack.at(-1);
    if (!frame) {
      if (rootState !== "value" || !scanValue()) return false;
      continue;
    }
    const token = source[offset];
    if (frame.kind === "object") {
      if (frame.state === "keyOrEnd" || frame.state === "key") {
        if (frame.state === "keyOrEnd" && token === "}") {
          offset += 1;
          stack.pop();
          if (!completeValue()) return false;
          continue;
        }
        const parsed = scanString(true);
        if (!parsed) return false;
        memberCount += 1;
        keyCodeUnits += parsed.codeUnits;
        if (
          memberCount > limits.maxMembers ||
          keyCodeUnits > limits.maxKeyCodeUnits ||
          frame.keys.has(parsed.key)
        ) return false;
        frame.keys.add(parsed.key);
        frame.state = "colon";
        continue;
      }
      if (frame.state === "colon") {
        if (token !== ":") return false;
        offset += 1;
        frame.state = "value";
        continue;
      }
      if (frame.state === "value") {
        if (!scanValue()) return false;
        continue;
      }
      if (token === ",") {
        offset += 1;
        frame.state = "key";
        continue;
      }
      if (token === "}") {
        offset += 1;
        stack.pop();
        if (!completeValue()) return false;
        continue;
      }
      return false;
    }
    if (frame.state === "valueOrEnd" && token === "]") {
      offset += 1;
      stack.pop();
      if (!completeValue()) return false;
      continue;
    }
    if (frame.state === "valueOrEnd" || frame.state === "value") {
      frame.state = "value";
      if (!scanValue()) return false;
      continue;
    }
    if (token === ",") {
      offset += 1;
      frame.state = "value";
      continue;
    }
    if (token === "]") {
      offset += 1;
      stack.pop();
      if (!completeValue()) return false;
      continue;
    }
    return false;
  }
  return rootState === "done" && stack.length === 0;
}

// Function-call arguments are JSON carried inside a JSON string. When an
// eligible lifecycle is reserialized, validate the complete argument strings
// with the same numeric and duplicate-member preflight instead of treating the
// inner document as opaque trusted evidence. Empty opening arguments and
// partial delta strings are deliberately excluded.
function strictFunctionArgumentJson(value, limits) {
  const pending = [value];
  while (pending.length) {
    const current = pending.pop();
    if (Array.isArray(current)) {
      for (const entry of current) pending.push(entry);
      continue;
    }
    const object = plainObject(current);
    if (!object) continue;
    let source;
    if (object.type === "function_call" && typeof object.arguments === "string") {
      source = object.arguments;
    } else if (
      object.type === "response.function_call_arguments.done" &&
      typeof object.arguments === "string"
    ) {
      source = object.arguments;
    }
    if (source) {
      try {
        if (!strictJsonPreflight(source, limits)) return false;
        JSON.parse(source);
      } catch {
        return false;
      }
    }
    for (const entry of Object.values(object)) pending.push(entry);
  }
  return true;
}

function parsedBlock(blockBytes, jsonLimits) {
  let block;
  try {
    block = fatalUtf8(blockBytes);
  } catch {
    return { invalidUtf8: true };
  }
  const newline = block.includes("\r\n") ? "\r\n" : "\n";
  const lines = block.split(/\r?\n/);
  const dataLineIndexes = lines
    .map((line, index) => (line.startsWith("data:") ? index : -1))
    .filter((index) => index !== -1);
  const eventLines = lines.filter((line) => line.startsWith("event:"));
  const unknownLines = lines.filter((line) => {
    return line !== "" && !line.startsWith("data:") && !line.startsWith("event:");
  });
  if (
    dataLineIndexes.length !== 1 ||
    eventLines.length > 1 ||
    unknownLines.length > 0
  ) {
    return { malformed: true };
  }
  const [dataLineIndex] = dataLineIndexes;
  const dataValue = lines[dataLineIndex].slice(5);
  // The SSE grammar removes at most one U+0020 after a field colon. Leave
  // every other code point to JSON.parse: it accepts JSON's own ASCII
  // whitespace, while a BOM or non-JSON Unicode whitespace remains invalid
  // instead of being silently normalized into trusted bridge evidence.
  const dataText = dataValue.startsWith(" ") ? dataValue.slice(1) : dataValue;
  if (!dataText) return { malformed: true };
  if (dataText === "[DONE]") {
    return eventLines.length === 0 ? { done: true } : { malformed: true };
  }
  try {
    if (!strictJsonPreflight(dataText, jsonLimits)) return { malformed: true };
    const event = JSON.parse(dataText);
    if (!strictFunctionArgumentJson(event, jsonLimits)) return { malformed: true };
    if (eventLines.length === 1) {
      const eventValue = eventLines[0].slice(6);
      const declaredType = eventValue.startsWith(" ")
        ? eventValue.slice(1)
        : eventValue;
      if (declaredType !== event?.type) return { malformed: true };
    }
    return { parsed: { lines, dataLineIndex, newline, event } };
  } catch {
    return { malformed: true };
  }
}

function rewrittenBlock(parsed, event, separator) {
  const lines = [...parsed.lines];
  lines[parsed.dataLineIndex] = `data: ${JSON.stringify(event)}`;
  return Buffer.from(`${lines.join(parsed.newline)}${separator}`);
}

function rewrittenEventBlock(parsed, event, separator) {
  const lines = parsed.lines.map((line) => (
    line.startsWith("event:") ? `event: ${event.type}` : line
  ));
  lines[parsed.dataLineIndex] = `data: ${JSON.stringify(event)}`;
  return Buffer.from(`${lines.join(parsed.newline)}${separator}`);
}

function itemId(value) {
  return typeof value === "string" && value ? value : undefined;
}

function eventItemReference(event) {
  const direct = itemId(event?.item_id);
  const nested = itemId(event?.item?.id);
  return {
    id: direct ?? nested,
    conflict: direct !== undefined && nested !== undefined && direct !== nested,
  };
}

function eventItemId(event) {
  return eventItemReference(event).id;
}

function isToolCall(item) {
  return item?.type === "function_call" || item?.type === "custom_tool_call";
}

function candidateStart(item) {
  return (
    exactKeys(item, CANDIDATE_MESSAGE_KEYS) &&
    item?.type === "message" &&
    item.role === "assistant" &&
    item.status === "in_progress" &&
    Array.isArray(item.content) &&
    item.content.length === 0 &&
    (item.phase === undefined || item.phase === null)
  );
}

function finiteLimit(value, fallback, { minimum = 0, integer = false } = {}) {
  if (!Number.isFinite(value) || value < minimum) return fallback;
  return integer ? Math.floor(value) : value;
}

function jsonScanLimits(
  { maxJsonDepth, maxJsonMembers, maxJsonKeyCodeUnits },
  { maxMembers, maxKeyCodeUnits },
) {
  const capped = (value, maximum) => Math.min(
    finiteLimit(value, maximum, { minimum: 1, integer: true }),
    maximum,
  );
  return {
    maxDepth: capped(maxJsonDepth, MAX_JSON_DEPTH),
    maxMembers: capped(maxJsonMembers, maxMembers),
    maxKeyCodeUnits: capped(maxJsonKeyCodeUnits, maxKeyCodeUnits),
  };
}

function exactEmptyPart(part) {
  return (
    exactKeys(part, TERMINAL_EMPTY_PART_KEYS) &&
    ["output_text", "text"].includes(part.type) &&
    part.text === "" &&
    (part.annotations === undefined ||
      (Array.isArray(part.annotations) && part.annotations.length === 0)) &&
    (part.logprobs === undefined || part.logprobs === null ||
      (Array.isArray(part.logprobs) && part.logprobs.length === 0))
  );
}

function exactEmptyMessage(item) {
  return (
    exactKeys(item, CANDIDATE_MESSAGE_KEYS) &&
    item?.type === "message" &&
    item.role === "assistant" &&
    item.status === "completed" &&
    Array.isArray(item.content) &&
    item.content.length === 1 &&
    item.content.every(exactEmptyPart) &&
    itemId(item.id) !== undefined &&
    (item.phase === undefined || item.phase === null)
  );
}

// LiteLLM 1.96.0's terminal Chat-Completions -> Responses object represents
// the same empty text part as either null or an omitted `text` property. The
// streamed lifecycle is kept stricter above: every event must still explicitly
// prove an empty string before we consider suppressing it.
function exactTerminalEmptyPart(part) {
  return (
    part != null &&
    typeof part === "object" &&
    !Array.isArray(part) &&
    Object.keys(part).every((key) => TERMINAL_EMPTY_PART_KEYS.has(key)) &&
    ["output_text", "text"].includes(part.type) &&
    (part.text === "" || part.text === null || part.text === undefined) &&
    (part.annotations === undefined ||
      (Array.isArray(part.annotations) && part.annotations.length === 0)) &&
    (part.logprobs === undefined || part.logprobs === null ||
      (Array.isArray(part.logprobs) && part.logprobs.length === 0))
  );
}

function exactCompletedEmptyMessage(item) {
  return (
    exactKeys(item, TERMINAL_EMPTY_MESSAGE_KEYS) &&
    item?.type === "message" &&
    item.role === "assistant" &&
    item.status === "completed" &&
    Array.isArray(item.content) &&
    item.content.length === 1 &&
    item.content.every(exactTerminalEmptyPart) &&
    itemId(item.id) !== undefined &&
    (item.phase === undefined || item.phase === null)
  );
}

function exactVisibleTextPart(part) {
  return (
    exactKeys(part, TERMINAL_EMPTY_PART_KEYS) &&
    ["output_text", "text"].includes(part.type) &&
    typeof part.text === "string" &&
    (part.annotations === undefined || Array.isArray(part.annotations)) &&
    (part.logprobs === undefined || part.logprobs === null ||
      Array.isArray(part.logprobs))
  );
}

function exactRefusalPart(part) {
  return (
    exactKeys(part, REFUSAL_PART_KEYS) &&
    part.type === "refusal" &&
    typeof part.refusal === "string"
  );
}

function exactCompletedMessage(item) {
  return (
    exactKeys(item, TERMINAL_EMPTY_MESSAGE_KEYS) &&
    item?.type === "message" &&
    itemId(item.id) !== undefined &&
    item.status === "completed" &&
    item.role === "assistant" &&
    Array.isArray(item.content) &&
    item.content.length > 0 &&
    item.content.every((part) => {
      return exactTerminalEmptyPart(part) ||
        exactVisibleTextPart(part) ||
        exactRefusalPart(part);
    }) &&
    (item.phase === undefined || item.phase === null || typeof item.phase === "string")
  );
}

function isReasoningItem(item) {
  return item?.type === "reasoning";
}

function exactReasoningArrayPart(part, type) {
  return (
    exactKeys(part, REASONING_PART_KEYS) &&
    part.type === type &&
    typeof part.text === "string"
  );
}

function exactReasoningItem(item, { completed = false } = {}) {
  return (
    exactKeys(item, REASONING_ITEM_KEYS) &&
    item?.type === "reasoning" &&
    itemId(item.id) !== undefined &&
    (item.status === undefined || item.status === (completed ? "completed" : "in_progress")) &&
    (item.summary === undefined ||
      (Array.isArray(item.summary) &&
        item.summary.every((part) => exactReasoningArrayPart(part, "summary_text")))) &&
    (item.content === undefined ||
      (Array.isArray(item.content) &&
        item.content.every((part) => exactReasoningArrayPart(part, "reasoning_text")))) &&
    (item.encrypted_content === undefined || item.encrypted_content === null ||
      typeof item.encrypted_content === "string")
  );
}

function toolValueField(type) {
  return type === "function_call" ? "arguments" : "input";
}

function exactToolCall(item, { completed = false } = {}) {
  if (!isToolCall(item)) return false;
  const allowed = item.type === "function_call" ? FUNCTION_CALL_KEYS : CUSTOM_TOOL_CALL_KEYS;
  const valueField = toolValueField(item.type);
  return (
    exactKeys(item, allowed) &&
    itemId(item.id) !== undefined &&
    itemId(item.call_id) !== undefined &&
    typeof item.name === "string" &&
    item.name.length > 0 &&
    typeof item[valueField] === "string" &&
    item.status === (completed ? "completed" : "in_progress")
  );
}

function hasValidToolCallIdentity(item, options) {
  return exactToolCall(item, options);
}

function matchesToolCallIdentity(item, expected) {
  return (
    expected !== undefined &&
    hasValidToolCallIdentity(item, { completed: true }) &&
    item.type === expected.type &&
    item.name === expected.name &&
    item.call_id === expected.callId &&
    item[toolValueField(item.type)] === expected.value
  );
}

// Non-streaming Responses bodies have no lifecycle events to corroborate an
// empty message. Keep the proof deliberately narrower: the item must be a
// completed, exactly empty assistant message, and the only output allowed
// between it and the function call that proves the bridge pattern is
// reasoning. A visible/refusal/unknown item ends that candidate.
function removableJsonMessageIndexes(output) {
  if (!Array.isArray(output)) return [];
  const removable = [];
  let pending;
  let ambiguousRun = false;
  for (let index = 0; index < output.length; index += 1) {
    const item = output[index];
    if (exactCompletedEmptyMessage(item)) {
      // Two empty messages with no intervening tool are ambiguous. Preserve
      // both instead of letting one tool retroactively prove both envelopes.
      if (pending !== undefined || ambiguousRun) {
        pending = undefined;
        ambiguousRun = true;
      } else {
        pending = index;
      }
      continue;
    }
    if (ambiguousRun) {
      if (!exactReasoningItem(item, { completed: true })) ambiguousRun = false;
      continue;
    }
    if (pending === undefined) continue;
    if (hasValidToolCallIdentity(item, { completed: true })) {
      removable.push(pending);
      pending = undefined;
      continue;
    }
    if (!exactReasoningItem(item, { completed: true })) pending = undefined;
  }
  return removable;
}

function jsonResponseOutput(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return undefined;
  if (payload.error !== undefined && payload.error !== null) return undefined;
  if (payload.object !== "response" || payload.status !== "completed") return undefined;
  const responseId = itemId(payload.id);
  if (!responseId || !Array.isArray(payload.output)) return undefined;
  const ids = new Set([responseId]);
  for (const item of payload.output) {
    const id = itemId(item?.id);
    if (!id || ids.has(id)) return undefined;
    ids.add(id);
    if (item?.type === "message") {
      if (!exactCompletedMessage(item)) return undefined;
      continue;
    }
    if (isReasoningItem(item)) {
      if (!exactReasoningItem(item, { completed: true })) return undefined;
      continue;
    }
    if (!hasValidToolCallIdentity(item, { completed: true })) return undefined;
  }
  return payload.output;
}

function successfulResponseEnvelope(response, status, responseId) {
  return (
    plainObject(response) !== undefined &&
    itemId(response.id) !== undefined &&
    (responseId === undefined || response.id === responseId) &&
    response.object === "response" &&
    response.status === status &&
    (response.error === undefined || response.error === null) &&
    Array.isArray(response.output)
  );
}

function exactReasoningPart(part) {
  return (
    exactKeys(part, REASONING_PART_KEYS) &&
    part.type === "summary_text" &&
    typeof part.text === "string"
  );
}

function eventIndexMatches(event, record) {
  return (
    eventItemId(event) === record.id &&
    Number.isInteger(event.output_index) &&
    event.output_index === record.outputIndex
  );
}

function terminalCandidateLifecycle(event, candidateId) {
  return (
    eventItemId(event) === candidateId &&
    [
      "response.content_part.added",
      "response.output_text.delta",
      "response.output_text.done",
      "response.content_part.done",
      "response.output_item.done",
    ].includes(event?.type)
  );
}

function exactOwnKeys(value, keys) {
  const object = plainObject(value);
  if (!object || Object.keys(object).length !== keys.length) return false;
  return keys.every((key) => Object.prototype.hasOwnProperty.call(object, key));
}

function exactDirectEvent(event, type, keys, { model } = {}) {
  const expected = model === undefined ? keys : [...keys, "model"];
  return (
    exactOwnKeys(event, expected) &&
    event.type === type &&
    (model === undefined ? event.model === undefined : event.model === model)
  );
}

function exactDirectCandidateStart(item) {
  return (
    exactOwnKeys(item, [...DIRECT_MESSAGE_KEYS]) &&
    candidateStart(item)
  );
}

function exactDirectEmptyPart(part) {
  return (
    exactOwnKeys(part, ["type", "text", "annotations"]) &&
    part.type === "output_text" &&
    part.text === "" &&
    Array.isArray(part.annotations) &&
    part.annotations.length === 0
  );
}

function exactDirectCompletedBlank(item, { omittedText = false } = {}) {
  if (
    !exactOwnKeys(item, [...DIRECT_MESSAGE_KEYS]) ||
    item.type !== "message" ||
    item.status !== "completed" ||
    item.role !== "assistant" ||
    !itemId(item.id) ||
    !Array.isArray(item.content) ||
    item.content.length !== 1
  ) return false;
  const [part] = item.content;
  if (omittedText) {
    return (
      exactOwnKeys(part, ["type", "annotations"]) &&
      part.type === "output_text" &&
      Array.isArray(part.annotations) &&
      part.annotations.length === 0
    );
  }
  return exactDirectEmptyPart(part);
}

function exactDirectReasoningItem(item, text) {
  if (
    !exactOwnKeys(item, [...DIRECT_REASONING_ITEM_KEYS]) ||
    !itemId(item.id)?.startsWith("rs_") ||
    item.type !== "reasoning" ||
    item.status !== "completed" ||
    item.role !== "assistant" ||
    !Array.isArray(item.content) ||
    item.content.length !== 1
  ) return false;
  const [part] = item.content;
  return (
    exactOwnKeys(part, [...DIRECT_REASONING_OUTPUT_PART_KEYS]) &&
    part.type === "output_text" &&
    part.text === text &&
    Array.isArray(part.annotations) &&
    part.annotations.length === 0
  );
}

function directToolIdentity(item) {
  if (!exactToolCall(item)) return undefined;
  return item.type === "function_call"
    ? {
        id: item.id,
        callId: item.call_id,
        name: item.name,
        arguments: item.arguments,
      }
    : undefined;
}

function exactDirectCompletedTool(item, tool, expectedArguments) {
  return Boolean(
    tool &&
    exactToolCall(item, { completed: true }) &&
    item.type === "function_call" &&
    item.id === tool.id &&
    item.call_id === tool.callId &&
    item.name === tool.name &&
    item.arguments === expectedArguments
  );
}

// Direct DeepSeek has produced two provider-specific bridge defects that do
// not share the generic translated-route grammar. The historical bridge
// omitted response.created entirely and buried private reasoning in the empty
// message's close. The current LiteLLM 1.96.0 bridge emits a normal prelude but
// attaches reasoning deltas to that same empty message, later synthesizing a
// malformed reasoning item and a second blank terminal item.
//
// Keep both fingerprints here, behind the direct provider id. Each grammar is
// ordered, identity-bound, model-bound where the wire supplies provenance,
// and bounded. Any deviation releases the held bytes unchanged and disables
// the repair for the rest of the response.
export class DeepseekToolMessageCompatTransform extends Transform {
  #frames;
  #capture;
  #disabled = false;
  #finished = false;
  #prelude = "start";
  #openingResponseId;
  #model;
  #maxCandidateBytes;
  #maxCandidateMs;
  #maxCaptureMs;
  #maxFrameBytes;
  #jsonLimits;
  #watchdogTimer;
  #deadlineTimer;

  constructor({
    maxCandidateBytes = MAX_CANDIDATE_BYTES,
    maxCandidateMs = MAX_CANDIDATE_MS,
    maxCaptureMs = MAX_DIRECT_CAPTURE_MS,
    maxFrameBytes = MAX_FRAME_BYTES,
    maxJsonDepth,
    maxJsonMembers,
    maxJsonKeyCodeUnits,
  } = {}) {
    super();
    this.#maxCandidateBytes = finiteLimit(
      maxCandidateBytes,
      MAX_CANDIDATE_BYTES,
      { integer: true },
    );
    this.#maxCandidateMs = finiteLimit(maxCandidateMs, MAX_CANDIDATE_MS);
    this.#maxCaptureMs = finiteLimit(maxCaptureMs, MAX_DIRECT_CAPTURE_MS);
    this.#maxFrameBytes = finiteLimit(maxFrameBytes, MAX_FRAME_BYTES, {
      minimum: 1,
      integer: true,
    });
    this.#frames = new SseFrameAccumulator(this.#maxFrameBytes);
    this.#jsonLimits = jsonScanLimits(
      { maxJsonDepth, maxJsonMembers, maxJsonKeyCodeUnits },
      {
        maxMembers: MAX_FRAME_JSON_MEMBERS,
        maxKeyCodeUnits: MAX_FRAME_JSON_KEY_CODE_UNITS,
      },
    );
  }

  _transform(chunk, _encoding, callback) {
    const piece = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    if (this.#disabled || this.#finished) {
      this.push(Buffer.from(piece));
      callback();
      return;
    }
    const outcome = this.#frames.write(piece, (block, separator, original) => {
      this.#handleBlock(block, separator, original);
      return !this.#disabled && !this.#finished;
    });
    if (outcome?.oversized) this.#oversizedFrame(outcome.oversized);
    if (outcome?.remainder?.length) this.push(outcome.remainder);
    callback();
  }

  _flush(callback) {
    this.#clearTimers();
    if (this.#disabled || this.#finished) {
      this.#pushPendingFrameBytes();
      callback();
      return;
    }
    this.#frames.flush((block, separator, original) => {
      this.#handleBlock(block, separator, original);
    });
    if (["completed", "sentinel"].includes(this.#capture?.stage)) {
      this.#finishAtEof();
    } else if (this.#capture) this.#failOpen();
    this.#pushPendingFrameBytes();
    callback();
  }

  _destroy(error, callback) {
    this.#clearTimers();
    callback(error);
  }

  #handleBlock(block, separator, original = Buffer.concat([block, separator])) {
    const parsedResult = parsedBlock(block, this.#jsonLimits);
    const frame = {
      original,
      parsed: parsedResult.parsed,
      separator: separator.toString("ascii"),
    };
    if (parsedResult.invalidUtf8 || parsedResult.malformed) {
      this.#failOpen(frame);
      return;
    }
    if (parsedResult.done) {
      if (this.#capture?.stage === "completed") {
        this.#holdSentinel(frame);
      } else if (this.#capture) {
        this.#failOpen(frame);
      } else if (!this.#disabled) {
        this.push(frame.original);
        this.#finished = true;
      }
      return;
    }
    const event = frame.parsed?.event;
    if (!event || eventItemReference(event).conflict) {
      this.#failOpen(frame);
      return;
    }
    if (!this.#capture) {
      this.#handlePrelude(frame, event);
      return;
    }
    const valid = this.#capture.mode === "historical"
      ? this.#advanceHistorical(frame, event)
      : this.#advanceCurrent(frame, event);
    if (!valid) this.#failOpen(frame);
  }

  #handlePrelude(frame, event) {
    if (this.#prelude === "start" && this.#acceptCurrentPrelude(event, "created")) {
      this.#prelude = "created";
      this.push(frame.original);
      return;
    }
    if (this.#prelude === "created" && this.#acceptCurrentPrelude(event, "in_progress")) {
      this.#prelude = "ready";
      this.push(frame.original);
      return;
    }
    if (this.#prelude === "start" && this.#historicalCandidateStart(event)) {
      this.#startCapture(frame, event, "historical");
      return;
    }
    if (this.#prelude === "ready" && this.#currentCandidateStart(event)) {
      this.#startCapture(frame, event, "current");
      return;
    }
    this.#failOpen(frame);
  }

  #acceptCurrentPrelude(event, phase) {
    const type = phase === "created" ? "response.created" : "response.in_progress";
    if (
      !exactOwnKeys(event, ["type", "response", "model"]) ||
      event.type !== type ||
      typeof event.model !== "string" ||
      !event.model
    ) return false;
    if (phase === "created") {
      if (
        !successfulResponseEnvelope(event.response, "in_progress") ||
        event.response.output.length !== 0 ||
        event.response.model !== event.model ||
        !event.response.id.startsWith("resp_")
      ) return false;
      this.#openingResponseId = event.response.id;
      this.#model = event.model;
      return true;
    }
    return (
      event.model === this.#model &&
      successfulResponseEnvelope(event.response, "in_progress", this.#openingResponseId) &&
      event.response.output.length === 0 &&
      event.response.model === this.#model
    );
  }

  #historicalCandidateStart(event) {
    return (
      exactDirectEvent(
        event,
        "response.output_item.added",
        ["type", "output_index", "sequence_number", "item"],
      ) &&
      event.output_index === 0 &&
      event.sequence_number === 1 &&
      exactDirectCandidateStart(event.item)
    );
  }

  #currentCandidateStart(event) {
    return (
      exactDirectEvent(
        event,
        "response.output_item.added",
        ["type", "output_index", "item"],
        { model: this.#model },
      ) &&
      event.output_index === 0 &&
      exactDirectCandidateStart(event.item) &&
      ![this.#openingResponseId].includes(event.item.id)
    );
  }

  #startCapture(frame, event, mode) {
    this.#capture = {
      mode,
      stage: "candidate-added",
      candidateId: event.item.id,
      frames: [],
      bytes: 0,
      reasoningFrames: [],
      reasoningText: "",
      toolFrames: [],
      tool: undefined,
      toolArguments: "",
      sawToolDelta: false,
      terminalTool: undefined,
      terminalReasoning: undefined,
      terminalBlank: undefined,
      sentinel: undefined,
    };
    this.#startDeadline();
    this.#hold(frame);
  }

  #advanceHistorical(frame, event) {
    const capture = this.#capture;
    if (!capture) return false;
    const id = capture.candidateId;
    let valid = false;
    if (capture.stage === "candidate-added") {
      valid = exactDirectEvent(
        event,
        "response.content_part.added",
        [
          "type",
          "item_id",
          "output_index",
          "content_index",
          "sequence_number",
          "part",
        ],
      ) && event.item_id === id && event.output_index === 0 &&
        event.content_index === 0 && event.sequence_number === 2 &&
        exactDirectEmptyPart(event.part);
      if (valid) capture.stage = "candidate-part";
    } else if (capture.stage === "candidate-part") {
      const tool = directToolIdentity(event.item);
      valid = exactDirectEvent(
        event,
        "response.output_item.added",
        ["type", "output_index", "sequence_number", "item"],
      ) && event.output_index === 1 && event.sequence_number === 3 &&
        tool !== undefined && tool.arguments === "" &&
        ![id].includes(tool.id);
      if (valid) {
        capture.tool = tool;
        capture.toolFrames.push(frame);
        capture.stage = "tool-added";
      }
    } else if (capture.stage === "tool-added") {
      valid = exactDirectEvent(
        event,
        "response.function_call_arguments.delta",
        ["type", "item_id", "output_index", "sequence_number", "delta"],
      ) && event.item_id === capture.tool.id && event.output_index === 1 &&
        event.sequence_number === 4 && typeof event.delta === "string" &&
        event.delta.length > 0;
      if (valid) {
        capture.toolArguments = event.delta;
        capture.sawToolDelta = true;
        capture.toolFrames.push(frame);
        capture.stage = "tool-delta";
      }
    } else if (capture.stage === "tool-delta") {
      valid = exactDirectEvent(
        event,
        "response.output_item.done",
        ["type", "output_index", "sequence_number", "item"],
      ) && event.output_index === 1 && event.sequence_number === 5 &&
        exactDirectCompletedTool(event.item, capture.tool, capture.toolArguments);
      if (valid) {
        capture.terminalTool = event.item;
        capture.toolFrames.push(frame);
        capture.stage = "tool-done";
      }
    } else if (capture.stage === "tool-done") {
      valid = exactDirectEvent(
        event,
        "response.output_text.done",
        [
          "type",
          "item_id",
          "output_index",
          "content_index",
          "sequence_number",
          "text",
        ],
      ) && event.item_id === id && event.output_index === 0 &&
        event.content_index === 0 && event.sequence_number === 6 && event.text === "";
      if (valid) capture.stage = "text-done";
    } else if (capture.stage === "text-done") {
      valid = exactDirectEvent(
        event,
        "response.content_part.done",
        [
          "type",
          "item_id",
          "output_index",
          "content_index",
          "sequence_number",
          "part",
        ],
      ) && event.item_id === id && event.output_index === 0 &&
        event.content_index === 0 && event.sequence_number === 7 &&
        exactOwnKeys(event.part, ["type", "reasoning"]) &&
        event.part.type === "reasoning_text" &&
        typeof event.part.reasoning === "string" && event.part.reasoning.length > 0;
      if (valid) capture.stage = "part-done";
    } else if (capture.stage === "part-done") {
      valid = exactDirectEvent(
        event,
        "response.output_item.done",
        ["type", "output_index", "sequence_number", "item"],
      ) && event.output_index === 0 && event.sequence_number === 8 &&
        exactDirectCompletedBlank(event.item) && event.item.id === id;
      if (valid) capture.stage = "candidate-done";
    } else if (capture.stage === "candidate-done") {
      valid = this.#acceptHistoricalCompleted(event);
      if (valid) {
        this.#hold(frame);
        if (this.#capture) this.#capture.stage = "completed";
        return true;
      }
    }
    if (!valid) return false;
    this.#hold(frame);
    return true;
  }

  #acceptHistoricalCompleted(event) {
    const capture = this.#capture;
    if (
      !capture ||
      !exactDirectEvent(
        event,
        "response.completed",
        ["type", "sequence_number", "response"],
      ) ||
      event.sequence_number !== 9 ||
      !exactOwnKeys(event.response, [...DIRECT_HISTORICAL_RESPONSE_KEYS]) ||
      !itemId(event.response.id)?.startsWith("resp_") ||
      event.response.status !== "completed" ||
      !Array.isArray(event.response.output) ||
      event.response.output.length !== 2
    ) return false;
    const [blank, tool] = event.response.output;
    if (
      !exactDirectCompletedBlank(blank) ||
      blank.id !== capture.candidateId ||
      !exactDirectCompletedTool(tool, capture.tool, capture.toolArguments)
    ) return false;
    const ids = new Set([
      event.response.id,
      capture.candidateId,
      capture.tool.id,
    ]);
    if (ids.size !== 3) return false;
    capture.terminalTool = tool;
    return true;
  }

  #advanceCurrent(frame, event) {
    const capture = this.#capture;
    if (!capture) return false;
    const id = capture.candidateId;
    let valid = false;
    if (capture.stage === "candidate-added") {
      valid = exactDirectEvent(
        event,
        "response.content_part.added",
        ["type", "item_id", "output_index", "content_index", "part"],
        { model: this.#model },
      ) && event.item_id === id && event.output_index === 0 &&
        event.content_index === 0 && exactDirectEmptyPart(event.part);
      if (valid) capture.stage = "reasoning";
    } else if (capture.stage === "reasoning") {
      if (exactDirectEvent(
        event,
        "response.reasoning_summary_text.delta",
        ["type", "item_id", "output_index", "delta"],
        { model: this.#model },
      )) {
        valid = event.item_id === id && event.output_index === 0 &&
          typeof event.delta === "string" && event.delta.length > 0;
        if (valid) {
          capture.reasoningText += event.delta;
          capture.reasoningFrames.push(frame);
        }
      } else {
        const tool = directToolIdentity(event.item);
        valid = capture.reasoningFrames.length > 0 &&
          exactDirectEvent(
            event,
            "response.output_item.added",
            ["type", "output_index", "item"],
            { model: this.#model },
          ) && event.output_index === 1 && tool !== undefined &&
          tool.arguments === "" &&
          ![this.#openingResponseId, id].includes(tool.id);
        if (valid) {
          capture.tool = tool;
          capture.toolFrames.push(frame);
          capture.stage = "tool-added";
        }
      }
    } else if (capture.stage === "tool-added") {
      if (exactDirectEvent(
        event,
        "response.function_call_arguments.delta",
        ["type", "item_id", "output_index", "delta"],
        { model: this.#model },
      )) {
        valid = event.item_id === capture.tool.id && event.output_index === 1 &&
          typeof event.delta === "string" && event.delta.length > 0;
        if (valid) {
          capture.toolArguments += event.delta;
          capture.sawToolDelta = true;
          capture.toolFrames.push(frame);
        }
      } else {
        valid = capture.sawToolDelta && exactDirectEvent(
          event,
          "response.function_call_arguments.done",
          ["type", "item_id", "output_index", "arguments"],
          { model: this.#model },
        ) && event.item_id === capture.tool.id && event.output_index === 1 &&
          event.arguments === capture.toolArguments;
        if (valid) {
          capture.toolFrames.push(frame);
          capture.stage = "arguments-done";
        }
      }
    } else if (capture.stage === "arguments-done") {
      valid = exactDirectEvent(
        event,
        "response.output_item.done",
        ["type", "output_index", "sequence_number", "item"],
        { model: this.#model },
      ) && event.output_index === 1 && event.sequence_number === 16 &&
        exactDirectCompletedTool(event.item, capture.tool, capture.toolArguments);
      if (valid) {
        capture.terminalTool = event.item;
        capture.toolFrames.push(frame);
        capture.stage = "tool-done";
      }
    } else if (capture.stage === "tool-done") {
      valid = exactDirectEvent(
        event,
        "response.output_text.done",
        ["type", "item_id", "output_index", "content_index", "text"],
        { model: this.#model },
      ) && event.item_id === id && event.output_index === 0 &&
        event.content_index === 0 && event.text === "";
      if (valid) capture.stage = "text-done";
    } else if (capture.stage === "text-done") {
      valid = exactDirectEvent(
        event,
        "response.content_part.done",
        ["type", "item_id", "output_index", "content_index", "part"],
        { model: this.#model },
      ) && event.item_id === id && event.output_index === 0 &&
        event.content_index === 0 && exactOwnKeys(event.part, ["type", "reasoning"]) &&
        event.part.type === "reasoning_text" &&
        event.part.reasoning === capture.reasoningText;
      if (valid) capture.stage = "part-done";
    } else if (capture.stage === "part-done") {
      valid = exactDirectEvent(
        event,
        "response.output_item.done",
        ["type", "output_index", "sequence_number", "item"],
        { model: this.#model },
      ) && event.output_index === 0 && event.sequence_number === 1 &&
        exactDirectCompletedBlank(event.item) && event.item.id === id;
      if (valid) capture.stage = "candidate-done";
    } else if (capture.stage === "candidate-done") {
      valid = this.#acceptCurrentCompleted(event);
      if (valid) {
        this.#hold(frame);
        if (this.#capture) this.#capture.stage = "completed";
        return true;
      }
    }
    if (!valid) return false;
    this.#hold(frame);
    return true;
  }

  #acceptCurrentCompleted(event) {
    const capture = this.#capture;
    if (
      !capture ||
      !exactDirectEvent(
        event,
        "response.completed",
        ["type", "response"],
        { model: this.#model },
      ) ||
      !successfulResponseEnvelope(event.response, "completed") ||
      event.response.id === this.#openingResponseId ||
      !event.response.id.startsWith("resp_") ||
      event.response.model !== this.#model ||
      event.response.output.length !== 3
    ) return false;
    const [reasoning, blank, tool] = event.response.output;
    if (
      !exactDirectReasoningItem(reasoning, capture.reasoningText) ||
      !exactDirectCompletedBlank(blank, { omittedText: true }) ||
      blank.id === capture.candidateId ||
      !exactDirectCompletedTool(tool, capture.tool, capture.toolArguments)
    ) return false;
    const ids = new Set([
      this.#openingResponseId,
      event.response.id,
      capture.candidateId,
      reasoning.id,
      blank.id,
      capture.tool.id,
    ]);
    if (ids.size !== 6) return false;
    capture.terminalReasoning = reasoning;
    capture.terminalBlank = blank;
    capture.terminalTool = tool;
    return true;
  }

  #repairCapture() {
    if (this.#capture?.mode === "historical") this.#repairHistorical();
    else if (this.#capture?.mode === "current") this.#repairCurrent();
  }

  #finishAtEof() {
    const sentinel = this.#capture?.sentinel;
    this.#repairCapture();
    if (sentinel) this.push(sentinel.original);
  }

  #repairHistorical() {
    const capture = this.#capture;
    if (!capture) return;
    this.#capture = undefined;
    this.#clearTimers();
    for (const frame of capture.frames) {
      const event = frame.parsed.event;
      const attached = eventItemId(event);
      if (attached === capture.candidateId) continue;
      if (event.type === "response.completed") {
        this.push(rewrittenBlock(frame.parsed, {
          ...event,
          response: { ...event.response, output: [capture.terminalTool] },
        }, frame.separator));
        continue;
      }
      if (attached === capture.tool.id && event.output_index === 1) {
        this.push(rewrittenBlock(
          frame.parsed,
          { ...event, output_index: 0 },
          frame.separator,
        ));
      }
    }
    this.#finished = true;
  }

  #repairCurrent() {
    const capture = this.#capture;
    if (!capture) return;
    this.#capture = undefined;
    this.#clearTimers();
    const reasoning = {
      id: capture.terminalReasoning.id,
      type: "reasoning",
      status: "completed",
      summary: [{ type: "summary_text", text: capture.reasoningText }],
    };
    const inProgressReasoning = {
      id: reasoning.id,
      type: "reasoning",
      status: "in_progress",
      summary: [],
    };
    const template = capture.frames[0];
    const emit = (event) => this.push(
      rewrittenEventBlock(template.parsed, event, template.separator),
    );
    emit({
      type: "response.output_item.added",
      output_index: 0,
      item: inProgressReasoning,
      model: this.#model,
    });
    emit({
      type: "response.reasoning_summary_part.added",
      item_id: reasoning.id,
      output_index: 0,
      summary_index: 0,
      part: { type: "summary_text", text: "" },
      model: this.#model,
    });
    for (const frame of capture.reasoningFrames) {
      this.push(rewrittenBlock(frame.parsed, {
        ...frame.parsed.event,
        item_id: reasoning.id,
        summary_index: 0,
      }, frame.separator));
    }
    emit({
      type: "response.reasoning_summary_text.done",
      item_id: reasoning.id,
      output_index: 0,
      summary_index: 0,
      text: capture.reasoningText,
      model: this.#model,
    });
    emit({
      type: "response.reasoning_summary_part.done",
      item_id: reasoning.id,
      output_index: 0,
      summary_index: 0,
      part: { type: "summary_text", text: capture.reasoningText },
      model: this.#model,
    });
    emit({
      type: "response.output_item.done",
      output_index: 0,
      item: reasoning,
      model: this.#model,
    });
    for (const frame of capture.toolFrames) this.push(frame.original);
    const completed = capture.frames.at(-1);
    this.push(rewrittenBlock(completed.parsed, {
      ...completed.parsed.event,
      response: {
        ...completed.parsed.event.response,
        output: [reasoning, capture.terminalTool],
      },
    }, completed.separator));
    this.#finished = true;
  }

  #hold(frame) {
    if (!this.#capture) return;
    if (this.#capture.bytes + frame.original.length > this.#maxCandidateBytes) {
      this.#failOpen(frame);
      return;
    }
    this.#capture.frames.push(frame);
    this.#capture.bytes += frame.original.length;
    this.#resetWatchdog();
  }

  #holdSentinel(frame) {
    if (!this.#capture || this.#capture.sentinel) {
      this.#failOpen(frame);
      return;
    }
    if (this.#capture.bytes + frame.original.length > this.#maxCandidateBytes) {
      this.#failOpen(frame);
      return;
    }
    this.#capture.sentinel = frame;
    this.#capture.bytes += frame.original.length;
    this.#capture.stage = "sentinel";
    this.#resetWatchdog();
  }

  #failOpen(extraFrame) {
    const capture = this.#capture;
    this.#capture = undefined;
    this.#clearTimers();
    if (capture) {
      for (const frame of capture.frames) this.push(frame.original);
      if (capture.sentinel) this.push(capture.sentinel.original);
    }
    if (extraFrame) this.push(extraFrame.original);
    this.#disabled = true;
  }

  #oversizedFrame(original) {
    const frame = { original: Buffer.isBuffer(original) ? original : Buffer.from(original) };
    this.#failOpen(frame);
  }

  #pushPendingFrameBytes() {
    const pending = this.#frames.take();
    if (pending.length) this.push(pending);
  }

  #resetWatchdog() {
    this.#clearWatchdog();
    if (!this.#capture) return;
    this.#watchdogTimer = setTimeout(() => {
      this.#failOpen();
      this.#pushPendingFrameBytes();
    }, this.#maxCandidateMs);
    this.#watchdogTimer.unref?.();
  }

  #startDeadline() {
    if (this.#deadlineTimer || !this.#capture) return;
    this.#deadlineTimer = setTimeout(() => {
      this.#failOpen();
      this.#pushPendingFrameBytes();
    }, this.#maxCaptureMs);
    this.#deadlineTimer.unref?.();
  }

  #clearWatchdog() {
    if (!this.#watchdogTimer) return;
    clearTimeout(this.#watchdogTimer);
    this.#watchdogTimer = undefined;
  }

  #clearTimers() {
    this.#clearWatchdog();
    if (!this.#deadlineTimer) return;
    clearTimeout(this.#deadlineTimer);
    this.#deadlineTimer = undefined;
  }
}

// LiteLLM's Chat-Completions/Anthropic -> Responses bridge can announce an
// empty assistant message before a tool call, then close that message after
// the call. Codex renders the empty lifecycle as a separate assistant turn.
//
// The tool cannot be renumbered until the preceding message is conclusively
// known to be empty: a legitimate mixed text/tool response has the same prefix.
// This transform therefore holds only that ambiguous interval under strict
// byte and time budgets. Every ambiguous, malformed, large, or slow shape fails
// open byte-for-byte and permanently disables the repair for that response.
export class TranslatedToolMessageCompatTransform extends Transform {
  #frames;
  #capture;
  #disabled = false;
  #finished = false;
  #responseId;
  #sawInProgress = false;
  #items = new Map();
  #indexItems = new Map();
  #lastSequence = -1;
  #usedTerminalCandidateSequenceReset = false;
  #modelProvenanceInitialized = false;
  #eventModelPresent = false;
  #eventModel;
  #responseModelPresent = false;
  #responseModel;
  #allowTerminalOnlyCandidate;
  #preludeBytes = 0;
  #maxCandidateBytes;
  #maxCandidateMs;
  #maxFrameBytes;
  #jsonLimits;
  #timer;

  constructor({
    maxCandidateBytes = MAX_CANDIDATE_BYTES,
    maxCandidateMs = MAX_CANDIDATE_MS,
    maxFrameBytes = MAX_FRAME_BYTES,
    maxJsonDepth,
    maxJsonMembers,
    maxJsonKeyCodeUnits,
    allowTerminalOnlyCandidate = false,
  } = {}) {
    super();
    this.#maxCandidateBytes = finiteLimit(
      maxCandidateBytes,
      MAX_CANDIDATE_BYTES,
      { integer: true },
    );
    this.#maxCandidateMs = finiteLimit(maxCandidateMs, MAX_CANDIDATE_MS);
    this.#maxFrameBytes = finiteLimit(maxFrameBytes, MAX_FRAME_BYTES, {
      minimum: 1,
      integer: true,
    });
    this.#frames = new SseFrameAccumulator(this.#maxFrameBytes);
    this.#jsonLimits = jsonScanLimits(
      { maxJsonDepth, maxJsonMembers, maxJsonKeyCodeUnits },
      {
        maxMembers: MAX_FRAME_JSON_MEMBERS,
        maxKeyCodeUnits: MAX_FRAME_JSON_KEY_CODE_UNITS,
      },
    );
    this.#allowTerminalOnlyCandidate = allowTerminalOnlyCandidate === true;
  }

  _transform(chunk, _encoding, callback) {
    const piece = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    if (this.#disabled || this.#finished) {
      this.push(Buffer.from(piece));
      callback();
      return;
    }
    const outcome = this.#frames.write(piece, (block, separator, original) => {
      this.#handleBlock(block, separator, original);
      return !this.#disabled && !this.#finished;
    });
    if (outcome?.oversized) this.#oversizedFrame(outcome.oversized);
    if (outcome?.remainder?.length) this.push(outcome.remainder);
    callback();
  }

  _flush(callback) {
    this.#clearTimer();
    if (this.#disabled || this.#finished) {
      this.#pushPendingFrameBytes();
      callback();
      return;
    }
    this.#frames.flush((block, separator, original) => {
      this.#handleBlock(block, separator, original);
    });
    if (["completed", "sentinel"].includes(this.#capture?.stage)) {
      this.#suppress();
    } else if (this.#capture) this.#failOpen();
    this.#pushPendingFrameBytes();
    callback();
  }

  _destroy(error, callback) {
    this.#clearTimer();
    callback(error);
  }

  #handleBlock(block, separator, original = Buffer.concat([block, separator])) {
    const parsedResult = parsedBlock(block, this.#jsonLimits);
    const frame = {
      original,
      parsed: parsedResult.parsed,
      separator: separator.toString("ascii"),
    };
    if (parsedResult.invalidUtf8 || parsedResult.malformed) {
      this.#failOpen(frame);
      return;
    }
    if (parsedResult.done) {
      if (this.#capture?.stage === "completed") {
        this.#holdSentinel(frame);
      } else if (this.#capture) {
        this.#failOpen(frame);
      } else {
        this.push(frame.original);
        this.#finished = true;
      }
      return;
    }
    if (!frame.parsed) {
      this.#failOpen(frame);
      return;
    }
    const event = frame.parsed.event;
    if (["completed", "sentinel"].includes(this.#capture?.stage)) {
      this.#failOpen(frame);
      return;
    }
    if (
      !exactEventKeys(event) ||
      eventItemReference(event).conflict ||
      !this.#acceptModelProvenance(event) ||
      !this.#acceptSequence(event)
    ) {
      this.#failOpen(frame);
      return;
    }

    if (event.type === "response.created") {
      if (
        this.#responseId !== undefined ||
        !successfulResponseEnvelope(event.response, "in_progress") ||
        event.response.output.length !== 0
      ) {
        this.#failOpen(frame);
        return;
      }
      this.#responseId = event.response.id;
      this.push(frame.original);
      return;
    }

    if (this.#responseId === undefined) {
      this.#failOpen(frame);
      return;
    }

    if (event.type === "response.in_progress") {
      if (
        this.#sawInProgress ||
        this.#capture ||
        this.#items.size > 0 ||
        !successfulResponseEnvelope(event.response, "in_progress", this.#responseId) ||
        event.response.output.length !== 0
      ) {
        this.#failOpen(frame);
        return;
      }
      this.#sawInProgress = true;
      this.push(frame.original);
      return;
    }

    if (event.type === "response.completed") {
      this.#handleCompleted(frame, event);
      return;
    }

    if (event.type === "response.output_item.added") {
      this.#handleAdded(frame, event);
      return;
    }

    this.#handleItemLifecycle(frame, event);
  }

  #acceptSequence(event) {
    if (event.sequence_number === undefined) return true;
    if (event.sequence_number > this.#lastSequence) {
      this.#lastSequence = event.sequence_number;
      return true;
    }

    // LiteLLM 1.96.0 hard-codes sequence_number=1 on the terminal
    // output_item.done for the empty Chat-Completions bridge message, even
    // after it has emitted higher-numbered tool events. Admit only that one
    // pinned wire defect, after the active candidate and its tool evidence are
    // already known. Keep the high-water mark so every later numbered event
    // must still advance the real stream sequence.
    const id = eventItemId(event);
    const record = id ? this.#items.get(id) : undefined;
    if (
      this.#usedTerminalCandidateSequenceReset ||
      this.#lastSequence <= 1 ||
      event.sequence_number !== 1 ||
      event.type !== "response.output_item.done" ||
      !this.#capture ||
      record?.kind !== "candidate" ||
      record.done ||
      !record.sawTool ||
      !eventIndexMatches(event, record) ||
      !exactEmptyMessage(event.item) ||
      event.item.id !== record.id
    ) return false;

    this.#usedTerminalCandidateSequenceReset = true;
    return true;
  }

  #acceptModelProvenance(event) {
    const eventModelPresent = Object.prototype.hasOwnProperty.call(event, "model");
    const eventModel = event.model;
    const responseEvent = plainObject(event.response);
    const responseModelPresent = responseEvent !== undefined &&
      Object.prototype.hasOwnProperty.call(responseEvent, "model");
    const responseModel = responseEvent?.model;
    if (
      (eventModelPresent && (typeof eventModel !== "string" || !eventModel)) ||
      (responseModelPresent && (typeof responseModel !== "string" || !responseModel)) ||
      (eventModelPresent && responseModelPresent && eventModel !== responseModel)
    ) return false;

    if (!this.#modelProvenanceInitialized) {
      if (event.type !== "response.created") return false;
      this.#eventModelPresent = eventModelPresent;
      this.#eventModel = eventModel;
      this.#responseModelPresent = responseModelPresent;
      this.#responseModel = responseModel;
      this.#modelProvenanceInitialized = true;
      return true;
    }

    if (
      eventModelPresent !== this.#eventModelPresent ||
      (eventModelPresent && eventModel !== this.#eventModel)
    ) return false;
    if (responseEvent !== undefined && (
      responseModelPresent !== this.#responseModelPresent ||
      (responseModelPresent && responseModel !== this.#responseModel)
    )) return false;
    return true;
  }

  #handleAdded(frame, event) {
    const id = itemId(event.item?.id);
    const outputIndex = event.output_index;
    if (this.#capture?.candidates.some(
      (candidate) => candidate.terminalOnly && candidate.id !== undefined,
    )) {
      this.#failOpen(frame);
      return;
    }
    const terminalOnlyStart = this.#canStartTerminalOnlyCandidate(event);
    if (terminalOnlyStart) this.#startTerminalOnlyCandidate();
    if (
      !id ||
      !Number.isInteger(outputIndex) ||
      outputIndex < 0 ||
      outputIndex !== this.#indexItems.size ||
      this.#items.has(id) ||
      this.#indexItems.has(outputIndex)
    ) {
      this.#failOpen(frame);
      return;
    }

    let record;
    if (candidateStart(event.item)) {
      const previous = this.#capture?.candidates.at(-1);
      if (
        previous &&
        (!previous.sawTool ||
          !previous.done ||
          [...this.#items.values()].some((item) => !item.done))
      ) {
        this.#failOpen(frame);
        return;
      }
      record = {
        id,
        outputIndex,
        kind: "candidate",
        done: false,
        sawTool: false,
        contentStarted: false,
        textDone: false,
        partDone: false,
      };
    } else if (exactReasoningItem(event.item)) {
      record = {
        id,
        outputIndex,
        kind: "reasoning",
        done: false,
        parts: new Set(),
        partDones: new Set(),
        textDones: new Set(),
        textDeltas: new Set(),
        textValues: new Map(),
        doneTexts: new Map(),
        terminalItem: undefined,
      };
    } else if (exactToolCall(event.item)) {
      const valueField = toolValueField(event.item.type);
      record = {
        id,
        outputIndex,
        kind: event.item.type,
        done: false,
        name: event.item.name,
        callId: event.item.call_id,
        valueField,
        delta: event.item[valueField],
        value: undefined,
        valueDone: false,
      };
    } else {
      // A visible assistant message or an unknown output item makes the whole
      // envelope ineligible. Nothing before this point has been rewritten.
      this.#failOpen(frame);
      return;
    }

    if (record.kind !== "candidate" && !this.#trackPrelude(frame)) return;

    this.#items.set(id, record);
    this.#indexItems.set(outputIndex, id);
    if (record.kind === "candidate") {
      if (!this.#capture) {
        this.#capture = {
          frames: [],
          bytes: 0,
          candidates: [],
          stage: "active",
          sentinel: undefined,
        };
        this.#startTimer();
      }
      this.#capture.candidates.push(record);
    } else if (isToolCall(event.item) && this.#capture) {
      this.#capture.candidates.at(-1).sawTool = true;
    }
    this.#pushOrHold(frame);
  }

  #canStartTerminalOnlyCandidate(event) {
    return Boolean(
      this.#allowTerminalOnlyCandidate &&
      !this.#capture &&
      this.#items.size === 0 &&
      this.#indexItems.size === 0 &&
      this.#sawInProgress &&
      this.#eventModelPresent &&
      this.#responseModelPresent &&
      this.#responseId?.startsWith("resp_") &&
      event.output_index === 1 &&
      exactToolCall(event.item)
    );
  }

  #startTerminalOnlyCandidate() {
    const candidate = {
      id: undefined,
      outputIndex: 0,
      kind: "candidate",
      done: false,
      sawTool: false,
      contentStarted: true,
      textDone: false,
      partDone: false,
      terminalOnly: true,
    };
    this.#capture = {
      frames: [],
      bytes: 0,
      candidates: [candidate],
      stage: "active",
      sentinel: undefined,
    };
    this.#indexItems.set(0, TERMINAL_ONLY_CANDIDATE_SLOT);
    this.#startTimer();
  }

  #handleItemLifecycle(frame, event) {
    const id = eventItemId(event);
    let record = id ? this.#items.get(id) : undefined;
    if (!record) record = this.#bindTerminalOnlyCandidate(event, id);
    if (!record || !eventIndexMatches(event, record)) {
      this.#failOpen(frame);
      return;
    }
    if (!this.#trackPrelude(frame)) return;

    let valid = false;
    if (record.kind === "candidate") {
      valid = this.#advanceCandidate(event, record);
    } else if (record.kind === "reasoning") {
      valid = this.#advanceReasoning(event, record);
    } else {
      valid = this.#advanceTool(event, record);
    }
    if (!valid) {
      this.#failOpen(frame);
      return;
    }
    this.#pushOrHold(frame);
  }

  #bindTerminalOnlyCandidate(event, id) {
    const candidate = this.#capture?.candidates.at(-1);
    const observed = [...this.#items.values()];
    if (
      !id ||
      !candidate?.terminalOnly ||
      candidate.id !== undefined ||
      event.type !== "response.output_text.done" ||
      event.output_index !== 0 ||
      event.content_index !== 0 ||
      event.text !== "" ||
      !(event.logprobs === undefined || event.logprobs === null ||
        (Array.isArray(event.logprobs) && event.logprobs.length === 0)) ||
      observed.length === 0 ||
      observed.some((record) => record.kind === "candidate" || !record.done) ||
      this.#items.has(id) ||
      this.#indexItems.get(0) !== TERMINAL_ONLY_CANDIDATE_SLOT
    ) return undefined;
    candidate.id = id;
    this.#items.set(id, candidate);
    this.#indexItems.set(0, id);
    return candidate;
  }

  #trackPrelude(frame) {
    if (this.#capture) return true;
    if (this.#preludeBytes + frame.original.length > this.#maxCandidateBytes) {
      this.#failOpen(frame);
      return false;
    }
    this.#preludeBytes += frame.original.length;
    return true;
  }

  #advanceCandidate(event, record) {
    if (record.done || !terminalCandidateLifecycle(event, record.id)) return false;
    if (event.type === "response.content_part.added") {
      if (
        record.contentStarted ||
        event.content_index !== 0 ||
        !exactEmptyPart(event.part)
      ) return false;
      record.contentStarted = true;
      return true;
    }
    if (event.type === "response.output_text.delta") {
      return (
        record.contentStarted &&
        !record.textDone &&
        !record.partDone &&
        event.content_index === 0 &&
        event.delta === "" &&
        validObfuscation(event) &&
        (event.logprobs === undefined || event.logprobs === null ||
          (Array.isArray(event.logprobs) && event.logprobs.length === 0))
      );
    }
    if (event.type === "response.output_text.done") {
      if (
        !record.contentStarted ||
        record.textDone ||
        record.partDone ||
        event.content_index !== 0 ||
        event.text !== "" ||
        !(event.logprobs === undefined || event.logprobs === null ||
          (Array.isArray(event.logprobs) && event.logprobs.length === 0))
      ) return false;
      record.textDone = true;
      return true;
    }
    if (event.type === "response.content_part.done") {
      if (
        !record.contentStarted ||
        !record.textDone ||
        record.partDone ||
        event.content_index !== 0 ||
        !(
          exactEmptyPart(event.part) ||
          (exactKeys(event.part, EMPTY_REASONING_PART_KEYS) &&
            event.part.type === "reasoning_text" &&
            event.part.reasoning === "")
        )
      ) return false;
      record.partDone = true;
      return true;
    }
    if (event.type !== "response.output_item.done") return false;
    if (
      !exactEmptyMessage(event.item) ||
      event.item.id !== record.id ||
      (record.contentStarted && (!record.textDone || !record.partDone))
    ) return false;
    record.done = true;
    return true;
  }

  #advanceTool(event, record) {
    if (record.done) return false;
    const isFunction = record.kind === "function_call";
    const deltaType = isFunction
      ? "response.function_call_arguments.delta"
      : "response.custom_tool_call_input.delta";
    const doneType = isFunction
      ? "response.function_call_arguments.done"
      : "response.custom_tool_call_input.done";
    if (event.type === deltaType) {
      if (
        record.valueDone ||
        typeof event.delta !== "string" ||
        !validObfuscation(event)
      ) return false;
      record.delta += event.delta;
      return true;
    }
    if (event.type === doneType) {
      const value = event[record.valueField];
      if (
        record.valueDone ||
        typeof value !== "string" ||
        (record.delta && record.delta !== value)
      ) return false;
      record.value = value;
      record.valueDone = true;
      return true;
    }
    if (event.type !== "response.output_item.done") return false;
    const expected = {
      type: record.kind,
      name: record.name,
      callId: record.callId,
      value: record.valueDone
        ? record.value
        : record.delta || event.item?.[record.valueField],
    };
    if (
      event.item?.id !== record.id ||
      !matchesToolCallIdentity(event.item, expected)
    ) return false;
    record.value = event.item[record.valueField];
    record.valueDone = true;
    record.done = true;
    return true;
  }

  #reasoningIndex(event, prefix) {
    const expectedKey = prefix === "summary" ? "summary_index" : "content_index";
    const otherKey = prefix === "summary" ? "content_index" : "summary_index";
    if (
      !Number.isInteger(event[expectedKey]) ||
      event[expectedKey] < 0 ||
      event[otherKey] !== undefined
    ) return undefined;
    return `${prefix}:${event[expectedKey]}`;
  }

  #advanceReasoning(event, record) {
    if (record.done) return false;
    if (event.type === "response.output_item.done") {
      if (
        event.item?.id !== record.id ||
        !exactReasoningItem(event.item, { completed: true }) ||
        !this.#reasoningLifecycleMatchesTerminal(event.item, record)
      ) return false;
      for (const key of record.parts) if (!record.partDones.has(key)) return false;
      for (const key of record.textDeltas) if (!record.textDones.has(key)) return false;
      record.terminalItem = event.item;
      record.done = true;
      return true;
    }

    const summary = event.type.startsWith("response.reasoning_summary_");
    const reasoningText = event.type.startsWith("response.reasoning_text.");
    if (!summary && !reasoningText) return false;
    const key = this.#reasoningIndex(event, summary ? "summary" : "content");
    if (!key) return false;
    if (event.type.endsWith("part.added")) {
      if (record.parts.has(key) || !exactReasoningPart(event.part)) return false;
      record.parts.add(key);
      record.textValues.set(key, event.part.text);
      return true;
    }
    if (event.type.endsWith("part.done")) {
      if (
        !record.parts.has(key) ||
        record.partDones.has(key) ||
        !exactReasoningPart(event.part) ||
        (record.textDeltas.has(key) && !record.textDones.has(key)) ||
        event.part.text !== (record.doneTexts.get(key) ?? record.textValues.get(key))
      ) return false;
      record.partDones.add(key);
      return true;
    }
    if (event.type.endsWith(".delta")) {
      if (
        !record.parts.has(key) ||
        record.partDones.has(key) ||
        record.textDones.has(key) ||
        typeof event.delta !== "string" ||
        !validObfuscation(event)
      ) {
        return false;
      }
      record.textDeltas.add(key);
      record.textValues.set(key, `${record.textValues.get(key) ?? ""}${event.delta}`);
      return true;
    }
    if (event.type.endsWith(".done")) {
      if (
        !record.parts.has(key) ||
        record.partDones.has(key) ||
        record.textDones.has(key) ||
        typeof event.text !== "string" ||
        (record.textDeltas.has(key) && event.text !== record.textValues.get(key))
      ) return false;
      record.textDones.add(key);
      record.doneTexts.set(key, event.text);
      return true;
    }
    return false;
  }

  #reasoningLifecycleMatchesTerminal(item, record) {
    for (const [prefix, field, type] of [
      ["summary", "summary", "summary_text"],
      ["content", "content", "reasoning_text"],
    ]) {
      const keys = [...record.parts].filter((key) => key.startsWith(`${prefix}:`));
      if (!keys.length) continue;
      const parts = item[field];
      if (!Array.isArray(parts) || parts.length !== keys.length) return false;
      for (let index = 0; index < parts.length; index += 1) {
        const key = `${prefix}:${index}`;
        const text = record.doneTexts.get(key) ?? record.textValues.get(key);
        if (
          !record.parts.has(key) ||
          !record.partDones.has(key) ||
          !isDeepStrictEqual(parts[index], { type, text })
        ) return false;
      }
    }
    return true;
  }

  #handleCompleted(frame, event) {
    const terminalResponseId = itemId(event.response?.id);
    if (
      !successfulResponseEnvelope(event.response, "completed") ||
      !this.#acceptTerminalResponseId(terminalResponseId)
    ) {
      this.#failOpen(frame);
      return;
    }
    if (!this.#capture) {
      this.push(frame.original);
      this.#finished = true;
      return;
    }
    if (!this.#terminalMatchesCapture(event.response.output, terminalResponseId)) {
      this.#failOpen(frame);
      return;
    }
    this.#hold(frame);
    if (this.#capture) this.#capture.stage = "completed";
  }

  #acceptTerminalResponseId(terminalResponseId) {
    const terminalOnly = this.#capture?.candidates.some(
      (candidate) => candidate.terminalOnly,
    );
    if (terminalOnly) {
      return Boolean(
        terminalResponseId !== this.#responseId &&
        this.#sawInProgress &&
        this.#usedTerminalCandidateSequenceReset &&
        this.#eventModelPresent &&
        this.#responseModelPresent &&
        this.#responseId?.startsWith("resp_") &&
        terminalResponseId?.startsWith("resp_")
      );
    }
    if (terminalResponseId === this.#responseId) return true;
    // The same pinned LiteLLM bridge that resets the empty message's terminal
    // sequence also rebuilds response.completed under a new resp_* id. Permit
    // that identity change only after the whole distinctive wire contract has
    // been observed: in-progress envelope, consistent explicit model fields,
    // an active captured candidate, and the one admitted terminal reset. The
    // completed output still has to corroborate every streamed item below.
    return Boolean(
      this.#capture &&
      this.#sawInProgress &&
      this.#usedTerminalCandidateSequenceReset &&
      this.#eventModelPresent &&
      this.#responseModelPresent &&
      this.#responseId?.startsWith("resp_") &&
      terminalResponseId?.startsWith("resp_")
    );
  }

  #pushOrHold(frame) {
    if (this.#capture) this.#hold(frame);
    else this.push(frame.original);
  }

  #hold(frame) {
    if (!this.#capture) return;
    const bytes = frame.original.length;
    if (this.#capture.bytes + bytes > this.#maxCandidateBytes) {
      this.#failOpen(frame);
      return;
    }
    this.#capture.frames.push(frame);
    this.#capture.bytes += bytes;
  }

  #holdSentinel(frame) {
    if (!this.#capture || this.#capture.sentinel) {
      this.#failOpen(frame);
      return;
    }
    const bytes = frame.original.length;
    if (this.#capture.bytes + bytes > this.#maxCandidateBytes) {
      this.#failOpen(frame);
      return;
    }
    this.#capture.sentinel = frame;
    this.#capture.bytes += bytes;
    this.#capture.stage = "sentinel";
  }

  #terminalMatchesCapture(output, terminalResponseId = this.#responseId) {
    if (output.length !== this.#items.size) return false;
    const ids = new Set([this.#responseId, terminalResponseId]);
    for (let index = 0; index < output.length; index += 1) {
      const recordId = this.#indexItems.get(index);
      const record = recordId ? this.#items.get(recordId) : undefined;
      const item = output[index];
      const id = itemId(item?.id);
      if (!record || !record.done) return false;
      if (!id || ids.has(id)) return false;
      ids.add(id);
      if (record.kind === "candidate") {
        if (!record.sawTool || !exactCompletedEmptyMessage(item)) return false;
        if (record.terminalOnly && id !== record.id) return false;
        // The pinned LiteLLM bridge uses a generated msg_* ID for streaming,
        // but the originating chat-completion ID for this exact terminal
        // empty item. Permit only that candidate slot to change identity; a
        // collision with any other streamed item remains ambiguous.
        if (id !== record.id && this.#items.has(id)) return false;
        continue;
      }
      if (id !== record.id) return false;
      if (record.kind === "reasoning") {
        if (
          !exactReasoningItem(item, { completed: true }) ||
          !record.terminalItem ||
          !isDeepStrictEqual(item, record.terminalItem)
        ) return false;
        continue;
      }
      if (!matchesToolCallIdentity(item, {
        type: record.kind,
        name: record.name,
        callId: record.callId,
        value: record.value,
      })) return false;
    }
    return true;
  }

  #suppress() {
    const capture = this.#capture;
    if (!capture) return;
    this.#capture = undefined;
    const items = capture.candidates
      .map(({ id, outputIndex }) => ({ id, outputIndex }))
      .sort((left, right) => left.outputIndex - right.outputIndex);
    const suppressed = {
      items,
      streamIds: new Set(items.map(({ id }) => id)),
      outputIndexes: new Set(items.map(({ outputIndex }) => outputIndex)),
    };
    this.#clearTimer();
    for (const frame of capture.frames) this.#pushCompacted(frame, suppressed);
    if (capture.sentinel) this.push(capture.sentinel.original);
    this.#finished = true;
  }

  #failOpen(extraFrame) {
    const capture = this.#capture;
    this.#capture = undefined;
    this.#clearTimer();
    if (capture) {
      for (const frame of capture.frames) this.push(frame.original);
      if (capture.sentinel) this.push(capture.sentinel.original);
    }
    if (extraFrame) this.push(extraFrame.original);
    this.#disabled = true;
  }

  #pushCompacted(frame, suppressed) {
    const event = frame.parsed?.event;
    if (!event || !suppressed) {
      this.push(frame.original);
      return;
    }
    const attachedId = eventItemId(event);
    if (
      suppressed.streamIds.has(attachedId) &&
      (event.type === "response.output_item.added" ||
        terminalCandidateLifecycle(event, attachedId))
    ) return;
    let next = event;
    let changed = false;
    if (Number.isInteger(event.output_index)) {
      const shift = suppressed.items.filter(
        ({ outputIndex }) => outputIndex < event.output_index,
      ).length;
      if (shift > 0) next = { ...next, output_index: event.output_index - shift };
      changed = shift > 0;
    }
    if (event.type === "response.completed" && Array.isArray(event.response?.output)) {
      const output = event.response.output.filter(
        (_item, index) => !suppressed.outputIndexes.has(index),
      );
      next = {
        ...next,
        response: {
          ...event.response,
          output,
        },
      };
      changed ||= output.length !== event.response.output.length;
    }
    this.push(changed ? rewrittenBlock(frame.parsed, next, frame.separator) : frame.original);
  }

  #oversizedFrame(original) {
    const frame = { original: Buffer.isBuffer(original) ? original : Buffer.from(original) };
    if (this.#capture) this.#failOpen(frame);
    else {
      this.push(frame.original);
      this.#disabled = true;
    }
  }

  #pushPendingFrameBytes() {
    const pending = this.#frames.take();
    if (pending.length) this.push(pending);
  }

  #startTimer() {
    if (this.#timer || !this.#capture) return;
    this.#timer = setTimeout(() => {
      this.#failOpen();
      this.#pushPendingFrameBytes();
    }, this.#maxCandidateMs);
    this.#timer.unref?.();
  }

  #clearTimer() {
    if (!this.#timer) return;
    clearTimeout(this.#timer);
    this.#timer = undefined;
  }
}

// Non-streaming translated responses can be normalized without inventing an
// event lifecycle. Hold one bounded JSON body, change only exact empty message
// items proven by a later function call, and release malformed, oversized, or
// slow bodies byte-for-byte.
export class TranslatedToolMessageJsonCompatTransform extends Transform {
  #pending = [];
  #pendingBytes = 0;
  #released = false;
  #maxBytes;
  #maxMs;
  #jsonLimits;
  #timer;

  constructor({
    maxBytes = MAX_JSON_BYTES,
    maxMs = MAX_JSON_MS,
    maxJsonDepth,
    maxJsonMembers,
    maxJsonKeyCodeUnits,
  } = {}) {
    super();
    this.#maxBytes = finiteLimit(maxBytes, MAX_JSON_BYTES, {
      minimum: 1,
      integer: true,
    });
    this.#maxMs = finiteLimit(maxMs, MAX_JSON_MS);
    this.#jsonLimits = jsonScanLimits(
      { maxJsonDepth, maxJsonMembers, maxJsonKeyCodeUnits },
      {
        maxMembers: MAX_BODY_JSON_MEMBERS,
        maxKeyCodeUnits: MAX_BODY_JSON_KEY_CODE_UNITS,
      },
    );
  }

  _transform(chunk, _encoding, callback) {
    if (this.#released) {
      this.push(chunk);
      callback();
      return;
    }
    const piece = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    this.#startTimer();
    if (this.#pendingBytes + piece.length > this.#maxBytes) {
      this.#clearTimer();
      this.#releasePending();
      this.push(piece);
      this.#released = true;
      callback();
      return;
    }
    this.#pending.push(piece);
    this.#pendingBytes += piece.length;
    callback();
  }

  _flush(callback) {
    this.#clearTimer();
    const body = Buffer.concat(this.#pending, this.#pendingBytes);
    this.#pending = [];
    this.#pendingBytes = 0;
    if (this.#released || !body.length) {
      if (body.length) this.push(body);
      callback();
      return;
    }
    try {
      const source = fatalUtf8(body);
      if (!strictJsonPreflight(source, this.#jsonLimits)) {
        this.push(body);
        callback();
        return;
      }
      const payload = JSON.parse(source);
      if (!strictFunctionArgumentJson(payload, this.#jsonLimits)) {
        this.push(body);
        callback();
        return;
      }
      const output = jsonResponseOutput(payload);
      const indexes = removableJsonMessageIndexes(output);
      if (!indexes.length) {
        this.push(body);
      } else {
        const removed = new Set(indexes);
        this.push(Buffer.from(JSON.stringify({
          ...payload,
          output: output.filter((_item, index) => !removed.has(index)),
        })));
      }
    } catch {
      this.push(body);
    }
    callback();
  }

  _destroy(error, callback) {
    this.#clearTimer();
    callback(error);
  }

  #startTimer() {
    if (this.#timer || this.#released) return;
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      this.#releasePending();
      this.#released = true;
    }, this.#maxMs);
    this.#timer.unref?.();
  }

  #clearTimer() {
    if (!this.#timer) return;
    clearTimeout(this.#timer);
    this.#timer = undefined;
  }

  #releasePending() {
    for (const piece of this.#pending) this.push(piece);
    this.#pending = [];
    this.#pendingBytes = 0;
  }
}

function translatedProtocol(provider) {
  if (!provider || typeof provider !== "object") return false;
  const protocol = provider.protocol ?? "openai";
  return protocol === "openai" || protocol === "anthropic";
}

export function translatedToolMessageCompatTransform(provider, contentType = "") {
  if (!translatedProtocol(provider)) return undefined;
  const mediaType = String(contentType).split(";", 1)[0].trim().toLowerCase();
  if (mediaType === "text/event-stream") {
    if (provider.id === "deepseek") return new DeepseekToolMessageCompatTransform();
    return new TranslatedToolMessageCompatTransform({
      // LiteLLM's Anthropic bridge can omit the empty message's opening events
      // and reveal its index-zero slot only after the first tool has closed.
      // The stream transform admits that exact terminal-only lifecycle only on
      // providers whose upstream protocol is Messages.
      allowTerminalOnlyCandidate: provider.protocol === "anthropic",
    });
  }
  if (mediaType === "application/json" || mediaType.endsWith("+json")) {
    return new TranslatedToolMessageJsonCompatTransform();
  }
  return undefined;
}

// Preserve the previous provider-specific factory for internal consumers while
// keeping its original SSE-only behavior.
export function deepseekToolMessageCompatTransform(providerId, contentType = "") {
  if (String(providerId) !== "deepseek") return undefined;
  return String(contentType).toLowerCase().includes("text/event-stream")
    ? new DeepseekToolMessageCompatTransform()
    : undefined;
}
