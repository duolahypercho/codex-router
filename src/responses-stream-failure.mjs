import { Transform } from "node:stream";

const contexts = new WeakMap();
const MAX_EVENT_BYTES = 4 * 1024 * 1024;
const MAX_ID_BYTES = 512;
const MAX_MESSAGE_CHARS = 2_048;
const MAX_CODE_CHARS = 128;
const DEFAULT_MESSAGE = "The local router lost the upstream response stream.";
const TERMINALS = new Set([
  "response.completed", "response.failed", "response.incomplete",
]);
const RESPONSE_EVENTS = new Set([
  ...TERMINALS,
  "response.error", "error",
  "response.created", "response.queued", "response.in_progress", "response.done",
  "response.output_item.added", "response.output_item.done",
  "response.content_part.added", "response.content_part.done",
  "response.output_text.delta", "response.output_text.done", "response.output_text.annotation.added",
  "response.refusal.delta", "response.refusal.done",
  "response.reasoning_text.delta", "response.reasoning_text.done",
  "response.reasoning_summary_text.delta", "response.reasoning_summary_text.done",
  "response.reasoning_summary_part.added", "response.reasoning_summary_part.done",
  "response.function_call_arguments.delta", "response.function_call_arguments.done",
  "response.custom_tool_call_input.delta", "response.custom_tool_call_input.done",
]);

function identityText(value) {
  return typeof value === "string" && value.length > 0 &&
    value.length <= MAX_ID_BYTES && Buffer.byteLength(value) <= MAX_ID_BYTES &&
    value.isWellFormed() &&
    !/[\u0000-\u001f\u007f]/.test(value)
    ? value : undefined;
}

export function markResponsesStream(response, { model, minimalFailure = false } = {}) {
  if (!response || (typeof response !== "object" && typeof response !== "function")) return;
  let context = contexts.get(response);
  if (!context) {
    context = { trusted: true, terminal: false };
    contexts.set(response, context);
  }
  const requestedModel = identityText(model);
  if (requestedModel) {
    context.requestedModel = requestedModel;
    if (!context.modelAnnounced) context.model = requestedModel;
  }
  if (minimalFailure === true) context.minimalFailure = true;
}

// Observes only bytes leaving the final rewrite/holding/heartbeat stage. Each
// chunk is passed through immediately; the bounded parse copy is never output.
// No response body, instructions, tools, or output items survive a parsed frame.
export function responsesStreamFailureTransform(response, contentType, { maxEventBytes = MAX_EVENT_BYTES } = {}) {
  const context = contexts.get(response);
  if (!context || !String(contentType).toLowerCase().includes("text/event-stream")) return undefined;
  if (!Number.isSafeInteger(maxEventBytes) || maxEventBytes < 1 || maxEventBytes > MAX_EVENT_BYTES) {
    throw new RangeError("Responses failure metadata parse budget must be between 1 byte and 4 MiB.");
  }
  // A replaceable attempt has not sent a head or body. Its retry must not use
  // any identity or sequence from an earlier, discarded pipeline.
  if (!response.headersSent) {
    context.id = undefined;
    context.createdAt = undefined;
    context.model = context.requestedModel;
    context.modelAnnounced = false;
    context.nextSequence = undefined;
    context.trusted = true;
    context.terminal = false;
  } else if (context.observer) {
    // Starting another attempt after announcing a response cannot substitute
    // its identity. Keep forwarding, but stop manufacturing a typed snapshot.
    context.trusted = false;
  }
  const observer = new FailureMetadataTransform(context, maxEventBytes);
  context.observer = observer;
  return observer;
}

class FailureMetadataTransform extends Transform {
  #context;
  #limit;
  #buffer;
  #bytes = 0;
  #dropping = false;
  #lineLength = 0;
  #lastByte;

  constructor(context, limit) {
    super();
    this.#context = context;
    this.#limit = limit;
  }

  _transform(chunk, encoding, callback) {
    if (this.#context.observer === this && !this.#context.terminal) {
      this.#consume(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding));
    }
    callback(null, chunk);
  }

  #append(bytes) {
    if (this.#dropping || !bytes.length) return;
    if (this.#bytes + bytes.length > this.#limit) {
      this.#context.trusted = false;
      this.#buffer = undefined;
      this.#bytes = 0;
      this.#dropping = true;
      return;
    }
    const required = this.#bytes + bytes.length;
    if (!this.#buffer || this.#buffer.length < required) {
      const capacity = Math.min(this.#limit, Math.max(required, (this.#buffer?.length || 2_048) * 2));
      const buffer = Buffer.allocUnsafe(capacity);
      this.#buffer?.copy(buffer, 0, 0, this.#bytes);
      this.#buffer = buffer;
    }
    // Copy into one bounded allocation, rather than retaining chunk slices or
    // an unbounded list of tiny chunks/backing allocations.
    bytes.copy(this.#buffer, this.#bytes);
    this.#bytes += bytes.length;
  }

  #consume(chunk) {
    let offset = 0;
    while (offset < chunk.length && !this.#context.terminal) {
      const newline = chunk.indexOf(10, offset);
      const end = newline === -1 ? chunk.length : newline;
      const piece = chunk.subarray(offset, end);
      this.#append(piece);
      if (piece.length) {
        this.#lineLength = Math.min(2, this.#lineLength + piece.length);
        this.#lastByte = piece[piece.length - 1];
      }
      if (newline === -1) break;
      this.#append(chunk.subarray(newline, newline + 1));
      const blank = this.#lineLength === 0 || (this.#lineLength === 1 && this.#lastByte === 13);
      this.#lineLength = 0;
      this.#lastByte = undefined;
      if (blank) this.#finishFrame();
      offset = newline + 1;
    }
  }

  #finishFrame({ partial = false } = {}) {
    if (!this.#dropping && this.#bytes) {
      let payload;
      let eventType;
      try {
        const text = new TextDecoder("utf-8", { fatal: true }).decode(this.#buffer.subarray(0, this.#bytes));
        const data = [];
        for (const line of text.split(/\r?\n/)) {
          if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
          else if (line.startsWith("event:")) eventType = line.slice(6).trim();
        }
        if (data.length) payload = JSON.parse(data.join("\n"));
      } catch {
        // An upstream death commonly leaves an invalid partial JSON field.
        // It cannot have announced another valid identity or sequence.
        if (!partial) this.#context.trusted = false;
      }
      if (payload !== undefined) this.#observe(payload, eventType);
    }
    this.#buffer = undefined;
    this.#bytes = 0;
    this.#dropping = false;
  }

  #observe(payload, eventType) {
    const context = this.#context;
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      context.trusted = false;
      return;
    }
    if (!RESPONSE_EVENTS.has(payload.type)) {
      // Comments/pings/other inert extensions do not carry Response identity
      // or sequence. Unknown identity-bearing events cannot establish either.
      if (Object.hasOwn(payload, "sequence_number") || Object.hasOwn(payload, "response") ||
          Object.hasOwn(payload, "response_id")) context.trusted = false;
      return;
    }
    // Codex consumes failed/incomplete immediately, even as parse failures.
    // A completion without a non-null Response is ignored; other snapshots
    // complete or fail parsing. Consumption must not depend on whether
    // that metadata is bounded and trustworthy enough to author our snapshot.
    // Legacy response.error/generic error frames do not terminate Codex.
    if (TERMINALS.has(payload.type) &&
        (payload.type !== "response.completed" ||
          (Object.hasOwn(payload, "response") && payload.response !== null))) {
      context.terminal = true;
    }
    if (eventType && eventType !== payload.type) context.trusted = false;
    if (Object.hasOwn(payload, "sequence_number")) {
      const sequence = payload.sequence_number;
      if (!Number.isSafeInteger(sequence) || sequence < 0 || sequence >= Number.MAX_SAFE_INTEGER ||
          (context.nextSequence !== undefined && sequence < context.nextSequence)) {
        context.trusted = false;
      } else {
        context.nextSequence = sequence + 1;
      }
    }
    const snapshot = payload.response;
    if (payload.type === "response.completed" && Object.hasOwn(payload, "response") && snapshot !== null &&
        (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot) || !identityText(snapshot.id))) {
      context.trusted = false;
    }
    const id = snapshot?.id ?? payload.response_id;
    const announcesIdentity = ["response.created", "response.in_progress", "response.queued"].includes(payload.type);
    if (announcesIdentity && (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot) ||
        !identityText(snapshot.id))) context.trusted = false;
    if (id !== undefined) {
      const validId = identityText(id);
      if (!validId || (context.id && context.id !== validId)) context.trusted = false;
      else if (announcesIdentity) context.id = validId;
    }
    if (announcesIdentity && snapshot && typeof snapshot === "object" && !Array.isArray(snapshot)) {
      if (Object.hasOwn(snapshot, "model")) {
        const model = identityText(snapshot.model);
        if (!model || (context.modelAnnounced && context.model !== model)) context.trusted = false;
        else { context.model = model; context.modelAnnounced = true; }
      }
      if (Object.hasOwn(snapshot, "created_at")) {
        const date = snapshot.created_at;
        if (!Number.isFinite(date) || date < 0 || date > Number.MAX_SAFE_INTEGER ||
            (context.createdAt !== undefined && context.createdAt !== date)) context.trusted = false;
        else context.createdAt = date;
      }
    }
  }

  finishForFailure() {
    const pending = this.#bytes > 0 || this.#dropping;
    // The helper's leading blank lines will dispatch a valid unfinished data
    // line. Account for its sequence/terminal before authoring the next event.
    this.#finishFrame({ partial: true });
    this.#lineLength = 0;
    this.#lastByte = undefined;
    return pending;
  }
}

export function responsesStreamFailure(response, { code, message, localRejection = false }) {
  const context = contexts.get(response);
  if (!context) return undefined;
  const pending = context.observer?.finishForFailure() === true;
  if (context.terminal) return { terminal: true, closePendingFrame: pending };
  context.terminal = true;
  const safeMessage = typeof message === "string" && message
    ? message.slice(0, MAX_MESSAGE_CHARS).toWellFormed() : DEFAULT_MESSAGE;
  const safeCode = typeof code === "string" && code ? code.slice(0, MAX_CODE_CHARS).toWellFormed() : "local_router_stream_failed";
  // Codex classifies invalid_prompt as terminal; ordinary server_error stream
  // failures remain retryable. Use this only for a deliberate local rejection.
  const errorCode = localRejection === true ? "invalid_prompt" : "server_error";
  if (!context.trusted || !context.id || !context.model || context.createdAt === undefined ||
      context.nextSequence === undefined) {
    // Missing or untrusted metadata cannot justify an upstream snapshot.
    // Native Codex streams opt into a local failure envelope because Codex
    // ignores generic errors except for its flex-unavailable case. This needs
    // no invented identity/date/sequence/usage and retains server_error policy.
    if (context.minimalFailure === true || localRejection === true) {
      return { event: { type: "response.failed", code: safeCode,
        response: { status: "failed", error: { code: errorCode, message: safeMessage } } } };
    }
    return { event: { type: "error", code: safeCode, message: safeMessage, param: null } };
  }
  return {
    event: {
      type: "response.failed",
      sequence_number: context.nextSequence,
      code: safeCode,
      response: {
        id: context.id,
        object: "response",
        created_at: context.createdAt,
        model: context.model,
        status: "failed",
        error: { code: errorCode, message: safeMessage },
        output: [],
        parallel_tool_calls: false,
        tool_choice: "none",
        tools: [],
      },
    },
  };
}
