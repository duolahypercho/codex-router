import { Transform } from "node:stream";
import { StringDecoder } from "node:string_decoder";

import { HeaderlessSseDetector } from "./sse-prefix.mjs";

const MAX_JSON_CAPTURE_BYTES = 8 * 1024 * 1024;

// Bytes of *model-visible* request body per prompt token.
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
//
// That band only holds if the bytes handed to it are bytes the model reads.
// See NON_VISIBLE_KEY below for the one class that is not, and issue #266 for
// what happened when it was counted anyway.
const ESTIMATE_BYTES_PER_TOKEN = 3.3;

// Below this the substitution could not affect compaction anyway, and leaving
// small turns alone keeps the router out of responses whose reported numbers
// barely matter. It is a "do not bother" floor, not the safety property: the
// safety property is that only an explicit zero is ever replaced, and no
// tokenizer returns zero for a prompt that serializes to kilobytes.
const MIN_ESTIMATED_INPUT_TOKENS = 1_000;

// The one field of a routed body that is provably not prompt content.
//
// `encrypted_content` carries a reasoning item's ciphertext -- the hidden chain
// of thought, sealed by whoever produced it. No routed provider reads it: the
// gateway's Responses -> Chat Completions bridge drops reasoning items outright,
// and a Responses-native routed provider cannot decrypt another vendor's token.
// The router's own uses are already gone by the time a body is built --
// `normalizeRoutedInput` turns compaction items into visible text, and
// `normalizeRoutedAgentInput` inlines every collaboration payload as
// `input_text` -- so what remains here is ciphertext and nothing else.
//
// It is also the largest thing left in the body when it survives at all.
// `carryReasoningThroughInput` rewrites a reasoning item into assistant text
// when it can, and the ciphertext goes with it -- but only for an item that
// carries summary text and is immediately followed by the turn it belongs to.
// A reasoning item with an empty summary, which is what a provider returns when
// it has no summary to give, is forwarded whole. Measured through the router
// itself on a twelve-turn tool loop: with summaries, no ciphertext reaches the
// gateway at all; without them, every blob does and they are 64% of the body
// the router sends. That is the regime issue #266 was reported from, and 64%
// of the bytes charged at 3.3 each is where 3.9x-4.7x comes from.
//
// Everything else stays counted. JSON escaping (0.2%-3%) and structural
// scaffolding (1%-5%) are small and keep the estimate erring high, which is the
// direction that matters. Base64 image data is far larger than the tokens an
// image really costs, but what it really costs is a per-provider tiling formula
// the router has no business inventing, so it too stays counted at the byte
// rate -- wrong, but wrong upward.
//
// Subtracting what is provably invisible rather than summing what is visible is
// the point. An unrecognized field is counted by default, so a body shape
// nobody anticipated errs high instead of estimating near zero.
const NON_VISIBLE_KEY = Buffer.from('"encrypted_content"', "utf8");
const QUOTE = 0x22;
const BACKSLASH = 0x5c;
const COLON = 0x3a;

function isJsonSpace(byte) {
  return byte === 0x20 || byte === 0x09 || byte === 0x0a || byte === 0x0d;
}

// Bytes occupied by `encrypted_content` string values in a serialized body.
//
// A scan rather than a parse: these bodies reach a megabyte and a half, and the
// estimate runs on every routed turn, so building a second object graph to
// throw away is a cost with no answer attached. The scan is exact, not
// heuristic. Inside a JSON string every quote is escaped, so the unescaped byte
// sequence `"encrypted_content"` followed by a colon can only be a key -- a
// tool result that happens to quote this very JSON appears escaped and cannot
// match. The colon check is what separates the key from the identically named
// content-part `type` value that sits beside it.
function nonVisibleBytes(buffer) {
  let total = 0;
  let index = 0;
  while (index < buffer.length) {
    const key = buffer.indexOf(NON_VISIBLE_KEY, index);
    if (key === -1) break;
    let cursor = key + NON_VISIBLE_KEY.length;
    index = cursor;
    while (cursor < buffer.length && isJsonSpace(buffer[cursor])) cursor += 1;
    if (buffer[cursor] !== COLON) continue;
    cursor += 1;
    while (cursor < buffer.length && isJsonSpace(buffer[cursor])) cursor += 1;
    // `null`, or any non-string value, carries no bytes worth discounting.
    if (buffer[cursor] !== QUOTE) continue;
    const start = cursor;
    const end = endOfJsonString(buffer, start);
    // A body with no closing quote is truncated or not JSON at all. Discount
    // nothing rather than guess where the value stopped: over-counting is the
    // safe error, and this one would be unbounded.
    if (end === -1) break;
    total += end - start;
    index = end;
  }
  return total;
}

// The byte after the closing quote of the JSON string opening at `start`, or -1
// if it never closes. Hops quote to quote natively -- a ciphertext blob is tens
// of kilobytes with nothing to escape in it, and walking that a byte at a time
// in JS costs more than parsing the whole document.
function endOfJsonString(buffer, start) {
  let cursor = start + 1;
  while (cursor < buffer.length) {
    const quote = buffer.indexOf(QUOTE, cursor);
    if (quote === -1) return -1;
    // A quote is part of the value when an odd number of backslashes precede
    // it, and closes the value otherwise.
    let slashes = 0;
    while (quote - slashes - 1 > start && buffer[quote - slashes - 1] === BACKSLASH) {
      slashes += 1;
    }
    if (slashes % 2 === 0) return quote + 1;
    cursor = quote + 1;
  }
  return -1;
}

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
  // Providers that do prefix caching report the shared prefix they did not
  // have to re-process. DeepSeek-style APIs name it prompt_cache_hit_tokens;
  // OpenAI-compatible shapes carry it in input_tokens_details /
  // prompt_tokens_details.cached_tokens. The router forwards it for
  // diagnostics so the meter can show whether caching is actually happening.
  const cachedInputTokens = tokenCount(
    value.input_tokens_details?.cached_tokens ??
      value.prompt_tokens_details?.cached_tokens ??
      value.prompt_cache_hit_tokens,
  );
  // Reasoning tokens are the silent thinking tokens generated before visible
  // output. Providers report them in output_tokens_details.reasoning_tokens,
  // completion_tokens_details.reasoning_tokens, or reasoning_tokens directly.
  const reasoningTokens = tokenCount(
    value.output_tokens_details?.reasoning_tokens ??
      value.completion_tokens_details?.reasoning_tokens ??
      value.reasoning_tokens,
  );
  const retries = tokenCount(value.retries);
  const progressOnlyRetried =
    value.progress_only_retried === true || value.progressOnlyRetried === true;
  const billedInputTokens = tokenCount(
    value.billed_input_tokens ?? value.billed_prompt_tokens ?? value.billedInputTokens,
  );
  const billedOutputTokens = tokenCount(
    value.billed_output_tokens ?? value.billed_completion_tokens ?? value.billedOutputTokens,
  );
  return {
    inputTokens: inputTokens || 0,
    outputTokens: outputTokens || 0,
    totalTokens,
    ...(cachedInputTokens !== undefined ? { cachedInputTokens } : {}),
    ...(reasoningTokens !== undefined ? { reasoningTokens } : {}),
    ...(retries !== undefined && retries > 0 ? { retries } : {}),
    ...(progressOnlyRetried ? { progressOnlyRetried: true } : {}),
    ...(billedInputTokens !== undefined ? { billedInputTokens } : {}),
    ...(billedOutputTokens !== undefined ? { billedOutputTokens } : {}),
  };
}

// Add up the usage of two attempts at the same turn. A turn the router had to
// send twice cost twice; the meter has to say so, or the retry marker names a
// turn whose reported spend still looks like one attempt.
export function mergeTokenUsage(first, second) {
  if (!first) return second;
  if (!second) return first;
  const cachedInputTokens =
    first.cachedInputTokens === undefined && second.cachedInputTokens === undefined
      ? undefined
      : (first.cachedInputTokens || 0) + (second.cachedInputTokens || 0);
  const reasoningTokens =
    first.reasoningTokens === undefined && second.reasoningTokens === undefined
      ? undefined
      : (first.reasoningTokens || 0) + (second.reasoningTokens || 0);
  const retries =
    first.retries === undefined && second.retries === undefined
      ? undefined
      : (first.retries || 0) + (second.retries || 0);
  return {
    inputTokens: (first.inputTokens || 0) + (second.inputTokens || 0),
    outputTokens: (first.outputTokens || 0) + (second.outputTokens || 0),
    totalTokens: (first.totalTokens || 0) + (second.totalTokens || 0),
    ...(cachedInputTokens !== undefined ? { cachedInputTokens } : {}),
    ...(reasoningTokens !== undefined ? { reasoningTokens } : {}),
    ...(retries !== undefined && retries > 0 ? { retries } : {}),
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
//
// The bytes counted are the body minus its `encrypted_content` ciphertext.
// Anything that is not JSON -- a compressed frame, an opaque buffer, a plain
// string -- simply finds no key to discount and is counted whole, exactly as
// before.
export function estimateInputTokens(body, { contextWindow } = {}) {
  const buffer = Buffer.isBuffer(body) ? body : Buffer.from(String(body ?? ""), "utf8");
  const bytes = buffer.byteLength - nonVisibleBytes(buffer);
  const estimate = Math.ceil(bytes / ESTIMATE_BYTES_PER_TOKEN);
  if (estimate < MIN_ESTIMATED_INPUT_TOKENS) return undefined;
  // A request the provider answered cannot have exceeded the window, so the
  // estimate is never allowed to claim it did.
  //
  // Clamping to the window is the same value it always was, but it no longer
  // means the same thing. It used to fire on conversations nowhere near the
  // limit -- a body three quarters ciphertext crossed the window at a quarter
  // of its real size -- and because `autoCompact` is 85% of the window, a
  // clamped estimate sits above the compaction threshold by construction, so
  // every one of those turns compacted for nothing. That was the bug: not the
  // clamp, but what was allowed to reach it.
  //
  // Counting only model-visible bytes puts a floor under it. For the estimate
  // to exceed the window the visible text must exceed `contextWindow * 3.3`
  // bytes, and real text tokenizes between 3.3 (code) and 4.0 (prose) bytes per
  // token -- so a clamped estimate means the true count is between 82.5% and
  // 100% of the window. `autoCompact` sits at 85%. Compacting there is correct:
  // the conversation really is against the limit, and the alternative, reporting
  // something below the threshold, would skip the compaction and hand the next
  // turn to the provider to reject. Erring high costs a summary; erring low
  // costs the turn.
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
  #headerlessDetector;
  // When the first token of visible output arrived, relative to whenever the
  // caller says the request started. Headers are not this: a reasoning model
  // answers with headers and then thinks in silence for seconds before the
  // first token appears, and counting that silence as generation is what makes
  // a fast model read as slow. See #192.
  #firstTokenAt;
  #completedResponseObserved = false;
  #terminalErrorObserved = false;

  // `estimatedInputTokens` arrives only on routed requests large enough that a
  // reported zero cannot be true. Without it this transform observes and
  // forwards the response byte for byte, exactly as it always did.
  constructor(contentType = "", { estimatedInputTokens } = {}) {
    super();
    const declared = String(contentType).toLowerCase();
    this.#eventStream = declared.includes("text/event-stream");
    // The ChatGPT backend answers /responses with an SSE body and no
    // content-type header at all, so deciding on the header alone reads every
    // native turn as a JSON document, fails to parse it, and meters the turn
    // as zero tokens. When the header says nothing, the first bytes decide.
    this.#headerlessDetector =
      !this.#eventStream && !declared.includes("json")
        ? new HeaderlessSseDetector()
        : undefined;
    this.#estimate =
      Number.isInteger(estimatedInputTokens) && estimatedInputTokens > 0
        ? estimatedInputTokens
        : undefined;
  }

  _transform(chunk, _encoding, callback) {
    if (this.#headerlessDetector) {
      const detected = this.#headerlessDetector.write(chunk);
      if (detected.decision === "pending") {
        callback();
        return;
      }
      this.#headerlessDetector = undefined;
      this.#eventStream = detected.decision === "event-stream";
      for (const buffered of detected.chunks) this.#transformChunk(buffered);
      callback();
      return;
    }
    this.#transformChunk(chunk);
    callback();
  }

  #transformChunk(chunk) {
    if (this.#estimate === undefined) {
      this.#observeOnly(chunk);
      return;
    }
    if (this.#released) {
      this.push(chunk);
      return;
    }
    this.#pending = this.#pending.length ? Buffer.concat([this.#pending, chunk]) : chunk;
    if (this.#eventStream) {
      this.#consumeRewrittenLines();
      return;
    }
    // A non-streaming body has to be held to be rewritten. Oversized ones are
    // released and forwarded from then on, the way the observer stops
    // capturing past the same limit.
    if (this.#pending.length > MAX_JSON_CAPTURE_BYTES) this.#release();
  }

  _flush(callback) {
    if (this.#headerlessDetector) {
      const detected = this.#headerlessDetector.end();
      this.#headerlessDetector = undefined;
      this.#eventStream = detected.decision === "event-stream";
      for (const buffered of detected.chunks) this.#transformChunk(buffered);
    }
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
      if (payload?.type === "error") this.#terminalErrorObserved = true;
      this.#observe(payload);
      return payload;
    } catch {
      // Ignore non-JSON SSE fields while preserving the original stream.
      return undefined;
    }
  }

  #observe(payload) {
    this.#noteFirstToken(payload);
    if (payload?.type === "response.completed") this.#completedResponseObserved = true;
    const usage = tokenUsageFromPayload(payload);
    if (usage) this.#usage = usage;
  }

  // The first event that carries visible generated text. Reasoning summaries
  // and tool-call argument deltas are output the model is producing, so they
  // count too -- what must not count is the wait before any of it starts.
  #noteFirstToken(payload) {
    if (this.#firstTokenAt !== undefined) return;
    // Chat-completions bridges stream choices[].delta instead of typed events.
    // Check this first because chat.completion.chunk often has no `type` field.
    const chatDelta = payload?.choices?.[0]?.delta;
    const chatProducesOutput =
      typeof chatDelta?.content === "string" && chatDelta.content.length > 0;
    if (chatProducesOutput) {
      this.#firstTokenAt = Date.now();
      return;
    }
    const type = payload?.type;
    if (typeof type !== "string") return;
    const producesOutput =
      type === "response.output_text.delta" ||
      type === "response.reasoning_summary_text.delta" ||
      type === "response.function_call_arguments.delta" ||
      type === "response.audio_transcript.delta";
    if (producesOutput) this.#firstTokenAt = Date.now();
  }

  // Epoch milliseconds of the first generated token, or undefined when the
  // response never streamed one (a non-streaming reply, or an error).
  firstTokenAt() {
    return this.#firstTokenAt;
  }

  completedResponseObserved() {
    return this.#completedResponseObserved;
  }

  terminalErrorObserved() {
    return this.#terminalErrorObserved;
  }
}
