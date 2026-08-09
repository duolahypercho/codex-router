import { Transform } from "node:stream";
import { StringDecoder } from "node:string_decoder";

const MAX_JSON_CAPTURE_BYTES = 8 * 1024 * 1024;

// Bytes of forwarded request body per prompt token.
//
// The familiar rule is four characters per token, which is roughly where plain
// English lands. Source code and tool output -- what a Codex session is mostly
// made of -- tokenize denser, near 3.3, and JSON serialization adds only about
// 4% on top of the text it carries (measured on a request built from this
// repository's own files: 369,460 body bytes over 354,429 model-visible
// characters). Taking the dense figure as the divisor assumes the whole
// conversation tokenizes like code, which is the assumption that errs high on
// everything else.
//
// The direction is arithmetic, not taste. Compaction fires at 900,000 tokens
// of a 1,048,576-token window, a margin of 14%, so an estimate more than 14%
// low still lets the provider reject the turn -- the failure this exists to
// prevent -- while a high estimate only compacts sooner, which costs context
// the session can be summarized out of. Against real text this lands between
// about 1.0x (code-heavy) and 1.3x (prose-heavy) of the true count, so
// compaction fires somewhere between 690,000 and 900,000 real tokens.
const ESTIMATE_BYTES_PER_TOKEN = 3.3;

// Below this the substitution could not affect compaction anyway, and leaving
// small turns alone keeps the router out of responses whose reported numbers
// barely matter. It is a "do not bother" floor, not the safety property: the
// safety property is that only an explicit zero is ever replaced, and no
// tokenizer returns zero for a prompt that serializes to kilobytes.
const MIN_ESTIMATED_INPUT_TOKENS = 1_000;

function tokenCount(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.round(number) : undefined;
}

export function normalizeTokenUsage(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const inputTokens = tokenCount(value.input_tokens ?? value.prompt_tokens);
  const outputTokens = tokenCount(value.output_tokens ?? value.completion_tokens);
  const explicitTotal = tokenCount(value.total_tokens);
  const totalTokens = explicitTotal ??
    (inputTokens !== undefined || outputTokens !== undefined
      ? (inputTokens || 0) + (outputTokens || 0)
      : undefined);
  if (totalTokens === undefined) return undefined;
  return {
    inputTokens: inputTokens || 0,
    outputTokens: outputTokens || 0,
    totalTokens,
  };
}

export function tokenUsageFromPayload(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return undefined;
  for (const candidate of [payload.usage, payload.response?.usage]) {
    const usage = normalizeTokenUsage(candidate);
    if (usage) return usage;
  }
  return undefined;
}

// Estimates the prompt tokens in a request the router has already serialized.
//
// Character-count-over-a-ratio is crude, but it is predictable, needs no
// dependency and no tokenizer download, and it is measured against the exact
// bytes that went upstream rather than against a model of the conversation.
// Returns undefined when the request is too small for the estimate to matter,
// which is also what keeps it away from genuinely small turns.
export function estimateInputTokens(body, { contextWindow } = {}) {
  const bytes = Buffer.isBuffer(body)
    ? body.byteLength
    : Buffer.byteLength(String(body ?? ""), "utf8");
  const estimate = Math.ceil(bytes / ESTIMATE_BYTES_PER_TOKEN);
  if (estimate < MIN_ESTIMATED_INPUT_TOKENS) return undefined;
  // A request the provider answered cannot have exceeded the window, so the
  // estimate is never allowed to claim it did.
  return Number.isInteger(contextWindow) && contextWindow > 0
    ? Math.min(estimate, contextWindow)
    : estimate;
}

// True only when the upstream explicitly said the prompt was empty. A missing
// key, a null, a string, or any positive count is left alone: the router
// replaces a value it knows to be false, never one it merely dislikes. `null`
// in particular means "no count yet", not "no tokens", and `Number(null)` is 0,
// so the type is checked rather than coerced.
function reportsZeroPromptTokens(usage) {
  if (!usage || typeof usage !== "object" || Array.isArray(usage)) return false;
  for (const key of ["input_tokens", "prompt_tokens"]) {
    if (typeof usage[key] === "number" && usage[key] === 0) return true;
  }
  return false;
}

function withEstimatedPromptTokens(usage, estimate) {
  const outputTokens = tokenCount(usage.output_tokens ?? usage.completion_tokens) || 0;
  const next = { ...usage, total_tokens: estimate + outputTokens };
  if ("input_tokens" in usage) next.input_tokens = estimate;
  if ("prompt_tokens" in usage) next.prompt_tokens = estimate;
  return next;
}

// Returns a copy of a payload whose zero prompt count has been replaced by the
// estimate, or undefined when the payload does not qualify.
export function substituteZeroInputUsage(payload, estimate) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return undefined;
  if (!Number.isInteger(estimate) || estimate <= 0) return undefined;
  if (reportsZeroPromptTokens(payload.usage)) {
    return { ...payload, usage: withEstimatedPromptTokens(payload.usage, estimate) };
  }
  const nested = payload.response;
  if (
    nested &&
    typeof nested === "object" &&
    !Array.isArray(nested) &&
    reportsZeroPromptTokens(nested.usage)
  ) {
    return {
      ...payload,
      response: { ...nested, usage: withEstimatedPromptTokens(nested.usage, estimate) },
    };
  }
  return undefined;
}

const LINE_FEED = 0x0a;

export class ResponseUsageTransform extends Transform {
  #eventStream;
  #decoder = new StringDecoder("utf8");
  #buffer = "";
  #capturedBytes = 0;
  #usage;
  #estimate;
  #substituted;
  // Rewrite mode holds the raw bytes rather than decoded text: everything the
  // router is not rewriting has to leave as the exact buffer that arrived, so
  // a malformed or non-UTF-8 byte can never be replaced on its way through.
  #pending = Buffer.alloc(0);
  #released = false;

  // `estimatedInputTokens` arrives only on routed requests large enough that a
  // reported zero cannot be true. Without it this transform observes and
  // forwards the response byte for byte, exactly as it always did.
  constructor(contentType = "", { estimatedInputTokens } = {}) {
    super();
    this.#eventStream = String(contentType).toLowerCase().includes("text/event-stream");
    this.#estimate =
      Number.isInteger(estimatedInputTokens) && estimatedInputTokens > 0
        ? estimatedInputTokens
        : undefined;
  }

  _transform(chunk, _encoding, callback) {
    if (this.#estimate === undefined) {
      this.#observeOnly(chunk);
      callback();
      return;
    }
    if (this.#released) {
      this.push(chunk);
      callback();
      return;
    }
    this.#pending = this.#pending.length ? Buffer.concat([this.#pending, chunk]) : chunk;
    if (this.#eventStream) {
      this.#consumeRewrittenLines();
      callback();
      return;
    }
    // A non-streaming body has to be held to be rewritten. Oversized ones are
    // released and forwarded from then on, the way the observer stops
    // capturing past the same limit.
    if (this.#pending.length > MAX_JSON_CAPTURE_BYTES) this.#release();
    callback();
  }

  _flush(callback) {
    if (this.#estimate === undefined) {
      this.#buffer += this.#decoder.end();
      if (this.#eventStream) {
        this.#consumeEventLines(true);
      } else if (this.#buffer) {
        try {
          this.#observe(JSON.parse(this.#buffer));
        } catch {
          // The response remains untouched when optional usage parsing fails.
        }
      }
      callback();
      return;
    }
    if (this.#eventStream) {
      this.#consumeRewrittenLines(true);
      callback();
      return;
    }
    const body = this.#pending;
    this.#pending = Buffer.alloc(0);
    if (this.#released || !body.length) {
      if (body.length) this.push(body);
      callback();
      return;
    }
    let payload;
    try {
      payload = JSON.parse(body.toString("utf8"));
    } catch {
      this.push(body);
      callback();
      return;
    }
    this.#observe(payload);
    const substituted = substituteZeroInputUsage(payload, this.#estimate);
    this.#substituted = substituted ? this.#estimate : undefined;
    this.push(substituted ? Buffer.from(JSON.stringify(substituted), "utf8") : body);
    callback();
  }

  tokenUsage() {
    return this.#usage;
  }

  // The estimate written into the response, or undefined when the upstream
  // reported its own prompt count. Never folded into `tokenUsage()`: what the
  // provider said and what the router substituted stay separate all the way
  // into the usage event.
  substitutedInputTokens() {
    return this.#substituted;
  }

  #observeOnly(chunk) {
    this.push(chunk);
    if (this.#eventStream) {
      this.#buffer += this.#decoder.write(chunk);
      this.#consumeEventLines();
      return;
    }
    if (this.#capturedBytes > MAX_JSON_CAPTURE_BYTES) return;
    this.#capturedBytes += chunk.length;
    if (this.#capturedBytes <= MAX_JSON_CAPTURE_BYTES) {
      this.#buffer += this.#decoder.write(chunk);
    } else {
      this.#buffer = "";
    }
  }

  #release() {
    this.#released = true;
    if (this.#pending.length) this.push(this.#pending);
    this.#pending = Buffer.alloc(0);
  }

  #consumeEventLines(flush = false) {
    const lines = this.#buffer.split(/\r?\n/);
    this.#buffer = flush ? "" : lines.pop() || "";
    for (const line of lines) this.#observeEventLine(line);
  }

  // Each complete line is forwarded as soon as it is whole, carrying its own
  // terminator, so framing survives byte for byte and nothing is buffered
  // beyond the line currently being written.
  #consumeRewrittenLines(flush = false) {
    while (true) {
      const index = this.#pending.indexOf(LINE_FEED);
      if (index === -1) break;
      const line = this.#pending.subarray(0, index + 1);
      this.#pending = this.#pending.subarray(index + 1);
      this.push(this.#rewriteEventLine(line) || line);
    }
    if (flush && this.#pending.length) {
      const line = this.#pending;
      this.#pending = Buffer.alloc(0);
      this.push(this.#rewriteEventLine(line) || line);
    }
  }

  // Returns the replacement line, or undefined to forward the original bytes.
  #rewriteEventLine(line) {
    const text = line.toString("utf8");
    const terminator = text.endsWith("\r\n") ? "\r\n" : text.endsWith("\n") ? "\n" : "";
    const content = terminator ? text.slice(0, -terminator.length) : text;
    const payload = this.#observeEventLine(content);
    if (payload === undefined) return undefined;
    const substituted = substituteZeroInputUsage(payload, this.#estimate);
    if (substituted) {
      this.#substituted = this.#estimate;
      return Buffer.from(`data: ${JSON.stringify(substituted)}${terminator}`, "utf8");
    }
    // Codex reads the last usage it is given, so a later event that reports its
    // own prompt count supersedes an earlier substituted one -- in telemetry as
    // well as in the stream.
    if (tokenUsageFromPayload(payload)) this.#substituted = undefined;
    return undefined;
  }

  #observeEventLine(line) {
    if (!line.startsWith("data:")) return undefined;
    const data = line.slice(5).trim();
    if (!data || data === "[DONE]") return undefined;
    try {
      const payload = JSON.parse(data);
      this.#observe(payload);
      return payload;
    } catch {
      // Ignore non-JSON SSE fields while preserving the original stream.
      return undefined;
    }
  }

  #observe(payload) {
    const usage = tokenUsageFromPayload(payload);
    if (usage) this.#usage = usage;
  }
}
