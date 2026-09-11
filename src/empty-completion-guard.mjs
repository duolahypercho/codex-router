import { Transform } from "node:stream";
import { StringDecoder } from "node:string_decoder";

import { HeaderlessSseDetector } from "./sse-prefix.mjs";

const MAX_PRECONTENT_BYTES = 1024 * 1024;
const MAX_PRECONTENT_MS = 30_000;
// An individual event can echo tool schemas or carry a large reasoning delta.
// Bound its unfinished frame separately from the accumulated prelude hold.
const MAX_INCOMPLETE_EVENT_BYTES = 10 * 1024 * 1024;

export class EmptyCompletionPreludeLimitError extends Error {
  constructor(kind) {
    super(
      kind === "time"
        ? "The upstream produced no client-visible output before the pre-content deadline."
        : "The upstream exceeded the pre-content byte limit without producing client-visible output.",
    );
    this.name = "EmptyCompletionPreludeLimitError";
    this.code = "EMPTY_COMPLETION_PRELUDE_LIMIT";
    this.kind = kind;
  }
}

export function isEmptyCompletionPreludeLimitError(error) {
  return (
    error instanceof EmptyCompletionPreludeLimitError ||
    (error?.code === "EMPTY_COMPLETION_PRELUDE_LIMIT" &&
      (error?.kind === "time" || error?.kind === "bytes"))
  );
}

// A terminal SSE event for a Responses turn. `response.completed` is the
// protocol's end-of-response marker; `response.done` is the stream terminator
// that follows it; `data: [DONE]` is the chat-completions sentinel some
// gateways emit instead. All three close the response, so the guard holds
// them until it knows the turn actually produced something.
function isTerminalEvent(eventType, dataText) {
  return (
    dataText === "[DONE]" ||
    eventType === "response.completed" ||
    eventType === "response.done"
  );
}

const FAILURE_TERMINAL_EVENT_TYPES = new Set(["error", "response.failed", "response.incomplete"]);

// An upstream that states the turn failed: a typed failure event, or an
// untyped `data:` payload whose JSON names one.
function isFailureTerminalEvent(eventType, dataText) {
  if (FAILURE_TERMINAL_EVENT_TYPES.has(eventType)) return true;
  if (eventType !== undefined || !dataText || dataText === "[DONE]") return false;
  try {
    return FAILURE_TERMINAL_EVENT_TYPES.has(JSON.parse(dataText)?.type);
  } catch {
    return false;
  }
}

function sseFields(block) {
  let eventType = undefined;
  const dataLines = [];
  for (const line of block.split(/\r?\n/)) {
    if (line.startsWith("event:")) eventType = line.slice(6).trim();
    else if (line.startsWith("data:")) {
      const value = line.slice(5);
      dataLines.push(value.startsWith(" ") ? value.slice(1) : value);
    }
  }
  return {
    eventType,
    // The SSE algorithm joins repeated data fields with a line feed before
    // dispatch. Overwriting them truncates valid multiline JSON.
    dataText: dataLines.length ? dataLines.join("\n") : undefined,
  };
}

function nextSseBlock(buffer) {
  const lf = buffer.indexOf("\n\n");
  const crlf = buffer.indexOf("\r\n\r\n");
  if (lf < 0 && crlf < 0) return undefined;
  if (crlf >= 0 && (lf < 0 || crlf < lf)) {
    return { end: crlf + 4, bodyEnd: crlf };
  }
  return { end: lf + 2, bodyEnd: lf };
}

// The empty-completion guard may release a stream after reasoning or a time
// bound so the caller can see progress and cancel it. The terminal event must
// still stay behind the verdict: Codex is allowed to stop reading as soon as
// `response.completed` arrives, so an error appended after that event is not a
// stated failure at all. This small downstream transform holds terminal blocks
// until the paired guard has observed content. If the turn is empty, the router
// writes its error after this transform finishes and before any terminal marker
// can reach the client.
export class EmptyCompletionTerminalGuard extends Transform {
  #guard;
  #eventStream;
  #headerlessDetector;
  #pending = Buffer.alloc(0);
  #heldTerminal = [];
  #heldTerminalBytes = 0;
  #maxHeldTerminalBytes;

  constructor(
    guard,
    contentType = "",
    { maxHeldTerminalBytes = MAX_PRECONTENT_BYTES } = {},
  ) {
    super();
    this.#guard = guard;
    this.#maxHeldTerminalBytes =
      Number.isFinite(maxHeldTerminalBytes) && maxHeldTerminalBytes >= 0
        ? Math.floor(maxHeldTerminalBytes)
        : MAX_PRECONTENT_BYTES;
    const declared = String(contentType).toLowerCase();
    this.#eventStream = declared.includes("text/event-stream");
    this.#headerlessDetector =
      !this.#eventStream && !declared.includes("json")
        ? new HeaderlessSseDetector()
        : undefined;
  }

  _transform(chunk, _encoding, callback) {
    try {
      if (this.#headerlessDetector) {
        const detected = this.#headerlessDetector.write(chunk);
        if (detected.decision === "pending") {
          callback();
          return;
        }
        this.#headerlessDetector = undefined;
        this.#eventStream = detected.decision === "event-stream";
        for (const buffered of detected.chunks) this.#consume(buffered);
        callback();
        return;
      }
      this.#consume(chunk);
      callback();
    } catch (error) {
      callback(error);
    }
  }

  _flush(callback) {
    try {
      if (this.#headerlessDetector) {
        const detected = this.#headerlessDetector.end();
        this.#headerlessDetector = undefined;
        this.#eventStream = detected.decision === "event-stream";
        for (const buffered of detected.chunks) this.#consume(buffered);
      }
      if (!this.#eventStream) {
        if (this.#pending.length) this.push(this.#pending);
      } else {
        if (this.#guard.hasContent()) this.#releaseTerminal();
        // A non-terminal final block may omit its trailing blank line. A held
        // terminal is deliberately dropped when the paired guard found no
        // content, leaving the router's subsequent `event: error` observable.
        if (this.#pending.length) {
          const { eventType, dataText } = sseFields(this.#pending.toString("utf8"));
          if (!isTerminalEvent(eventType, dataText)) this.push(this.#pending);
          else if (this.#guard.hasContent()) this.push(this.#pending);
        }
      }
      this.#pending = Buffer.alloc(0);
      this.#heldTerminal = [];
      this.#heldTerminalBytes = 0;
      callback();
    } catch (error) {
      callback(error);
    }
  }

  #consume(chunk) {
    const bytes = Buffer.from(chunk);
    if (!this.#eventStream) {
      this.push(bytes);
      return;
    }
    if (this.#guard.hasContent() && this.#pending.length === 0) {
      this.#releaseTerminal();
      this.push(bytes);
      return;
    }
    this.#pending =
      this.#pending.length === 0
        ? bytes
        : Buffer.concat([this.#pending, bytes], this.#pending.length + bytes.length);
    while (true) {
      const boundary = nextSseBlock(this.#pending);
      if (!boundary) break;
      const raw = this.#pending.subarray(0, boundary.end);
      const block = this.#pending.subarray(0, boundary.bodyEnd).toString("utf8");
      this.#pending = this.#pending.subarray(boundary.end);
      const { eventType, dataText } = sseFields(block);
      if (isTerminalEvent(eventType, dataText)) {
        if (this.#guard.hasContent()) this.push(raw);
        else {
          this.#heldTerminal.push(Buffer.from(raw));
          this.#heldTerminalBytes += raw.length;
          if (this.#heldTerminalBytes > this.#maxHeldTerminalBytes) {
            throw new EmptyCompletionPreludeLimitError("bytes");
          }
        }
      } else {
        if (this.#guard.hasContent()) this.#releaseTerminal();
        this.push(raw);
      }
    }
    if (this.#guard.hasContent()) {
      this.#releaseTerminal();
      if (this.#pending.length) {
        this.push(this.#pending);
        this.#pending = Buffer.alloc(0);
      }
    }
  }

  #releaseTerminal() {
    for (const block of this.#heldTerminal) this.push(block);
    this.#heldTerminal = [];
    this.#heldTerminalBytes = 0;
  }
}

function partHasContent(part) {
  if (!part || typeof part !== "object") return false;
  return (
    (typeof part.text === "string" && part.text.length > 0) ||
    (typeof part.refusal === "string" && part.refusal.length > 0)
  );
}

function itemHasContent(item) {
  if (!item || typeof item !== "object") return false;
  if (item.type === "function_call" || item.type === "custom_tool_call") return true;
  if (item.type && item.type !== "message") return false;
  if (Array.isArray(item.content)) return item.content.some(partHasContent);
  return partHasContent(item);
}

function outputHasContent(output) {
  if (!Array.isArray(output)) return false;
  return output.some(itemHasContent);
}

// Chat-completions SSE carries no `event:` line at all: the content lives in
// `choices[].delta.content` (or `.message.content` on a non-streamed chunk),
// and tool calls in `choices[].delta.tool_calls`. A gateway that relays that
// shape through the Responses path would otherwise look contentless to every
// check above and turn ordinary turns into empty completions.
function chunkHasChatContent(data) {
  const choices = data?.choices;
  if (!Array.isArray(choices)) return false;
  return choices.some((choice) => {
    const delta = choice?.delta ?? choice?.message;
    if (!delta || typeof delta !== "object") return false;
    if (Array.isArray(delta.tool_calls) && delta.tool_calls.length > 0) return true;
    if (typeof delta.refusal === "string") return delta.refusal.length > 0;
    if (typeof delta.content === "string") return delta.content.length > 0;
    // Some gateways send content as an array of parts, same as Responses.
    if (Array.isArray(delta.content)) return itemHasContent(delta);
    return false;
  });
}

// Liveness is proof the upstream is generating without being output the client
// can act on. Reasoning is the canonical case, and it is why liveness exists as
// a separate verdict: on a reasoning model the gap between the first reasoning
// delta and the first output token is seconds to minutes, and holding that gap
// is what turns a healthy turn into a frozen screen. Measured against
// deepseek-v4-pro, the hold moved the client's first byte from 517 ms to
// 30,638 ms — the byte/time budget, not the model, decided when the caller saw
// anything. Liveness ends the hold. It deliberately does not count as content,
// so the emptiness verdict below is unchanged: a turn that streams only
// reasoning and then completes with nothing is still classified empty, it just
// can no longer be repaired invisibly.
function isLivenessEvent(eventType, data) {
  if (typeof eventType === "string") {
    if (/reasoning/.test(eventType)) {
      if (/\.delta$/.test(eventType)) {
        return typeof data?.delta === "string" && data.delta.length > 0;
      }
      // `.added`/`.done` on a reasoning part carry no delta of their own but
      // still only appear once the model has started producing.
      if (/\.(?:added|done)$/.test(eventType)) return true;
    }
    // Responses streams without summaries announce reasoning as an output item
    // rather than as a typed reasoning event.
    if (
      eventType === "response.output_item.added" &&
      data?.item?.type === "reasoning"
    ) {
      return true;
    }
  }
  const choices = data?.choices;
  if (!Array.isArray(choices)) return false;
  return choices.some((choice) => {
    const delta = choice?.delta ?? choice?.message;
    if (!delta || typeof delta !== "object") return false;
    // `reasoning_content` is DeepSeek's field; `reasoning` is what several
    // OpenAI-compatible resellers relay instead.
    const reasoning = delta.reasoning_content ?? delta.reasoning;
    return typeof reasoning === "string" && reasoning.length > 0;
  });
}

// Content means something the client can act on: output text or a tool call.
// Reasoning deltas are deliberately not content — a turn that streams only
// reasoning and then completes with nothing is exactly the empty completion
// this guard exists to catch. See `isLivenessEvent` for what reasoning does
// instead: it ends the hold without settling the verdict.
function isContentEvent(eventType, data) {
  if (typeof eventType === "string") {
    if (/(?:^|\.)output_text\.delta$/.test(eventType)) {
      return typeof data?.delta === "string" && data.delta.length > 0;
    }
    if (/(?:^|\.)output_text\.done$/.test(eventType)) {
      return typeof data?.text === "string" && data.text.length > 0;
    }
    if (/(?:^|\.)refusal\.delta$/.test(eventType)) {
      return typeof data?.delta === "string" && data.delta.length > 0;
    }
    if (/(?:^|\.)refusal\.done$/.test(eventType)) {
      return typeof data?.refusal === "string" && data.refusal.length > 0;
    }
    if (
      /(?:function_call_arguments|custom_tool_call_input)\.(?:delta|done)$/.test(
        eventType,
      )
    ) {
      return true;
    }
    if (
      eventType === "response.content_part.added" ||
      eventType === "response.content_part.done"
    ) {
      return partHasContent(data?.part);
    }
    if (
      eventType === "response.output_item.added" ||
      eventType === "response.output_item.done" ||
      eventType === "message.output_item.done"
    ) {
      return itemHasContent(data?.item);
    }
    // The completed payload carries the full output on some gateways -- the
    // whole turn arrives in one terminal event with no deltas ahead of it. A
    // completed event with output is a real turn; one with an empty output
    // array is the empty completion. This is checked before the terminal
    // branch holds the event, or a turn whose only content rides on
    // `response.completed` would be suppressed and retried as if it were
    // silent.
    if (eventType === "response.completed" || eventType === "message.completed") {
      return outputHasContent(data?.response?.output);
    }
  }
  return chunkHasChatContent(data);
}

// Watches a routed Responses stream for the "empty completion" failure mode:
// the upstream answers 200 and emits `response.completed` but never produced
// output text or a tool call. The client has no code path for "the model said
// nothing", so it silently marks the turn done — the "random stop" the app
// cannot explain.
//
// The hold exists only to make the retry invisible: an empty first attempt must
// contribute no response id, sequence number, or other prologue bytes to the
// retry the caller ultimately sees. That is worth paying for when the upstream
// is silent, because a silent upstream has no prologue worth waiting for. It is
// not worth paying for when the upstream is visibly generating — so a liveness
// event ends the hold and the guard keeps watching from behind the relay. The
// turn can still be classified empty afterwards; what it loses is the ability
// to be repaired without the client noticing, which `suppressedPrologue()`
// reports so the caller can retry silently or state the failure instead.
export class EmptyCompletionGuard extends Transform {
  #eventStream;
  #decoder = new StringDecoder("utf8");
  #parseBuffer = "";
  #chunks = [];
  #bufferedBytes = 0;
  #sawContent = false;
  #sawTerminal = false;
  #sawParseableEvent = false;
  #empty = false;
  #released = false;
  #keepParsingAfterRelease = false;
  #releasedForLiveness = false;
  #preludeLimitKind;
  #suppressedPrologue = false;
  #headerlessDetector;
  #maxPreludeBytes;
  #maxPreludeMs;
  #maxStreamStallMs;
  #timer;
  #receivedBytes = 0;

  constructor(
    contentType = "",
    {
      maxPreludeBytes = MAX_PRECONTENT_BYTES,
      maxPreludeMs = MAX_PRECONTENT_MS,
      maxStreamStallMs = maxPreludeMs,
    } = {},
  ) {
    super();
    const declared = String(contentType).toLowerCase();
    this.#eventStream = declared.includes("text/event-stream");
    this.#headerlessDetector =
      !this.#eventStream && !declared.includes("json")
        ? new HeaderlessSseDetector()
        : undefined;
    this.#maxPreludeBytes =
      Number.isFinite(maxPreludeBytes) && maxPreludeBytes >= 0
        ? Math.floor(maxPreludeBytes)
        : MAX_PRECONTENT_BYTES;
    this.#maxPreludeMs =
      Number.isFinite(maxPreludeMs) && maxPreludeMs >= 0
        ? maxPreludeMs
        : MAX_PRECONTENT_MS;
    this.#maxStreamStallMs =
      Number.isFinite(maxStreamStallMs) && maxStreamStallMs >= 0
        ? maxStreamStallMs
        : this.#maxPreludeMs;
    if (this.#eventStream || this.#headerlessDetector) this.#startTimer();
  }

  isEmpty() {
    return this.#empty;
  }

  hasContent() {
    return this.#sawContent;
  }

  // True when the hold ended because the upstream proved it was generating
  // rather than because it produced content. The stream was relayed in full and
  // on time; the verdict, if any, arrives later.
  releasedForLiveness() {
    return this.#releasedForLiveness;
  }

  preludeLimitKind() {
    return this.#preludeLimitKind;
  }

  // True when the guard still held every byte at the moment it declared the
  // turn empty. Only then can the caller retry invisibly: the client has seen
  // no head, no response id, and no sequence numbers from the failed attempt.
  // An empty turn without this is real and must be reported, not retried — a
  // second attempt would graft a second head onto a stream already in flight.
  suppressedPrologue() {
    return this.#suppressedPrologue;
  }

  _transform(chunk, _encoding, callback) {
    try {
      this.#receivedBytes += Buffer.byteLength(chunk);
      if (this.#headerlessDetector) {
        const detected = this.#headerlessDetector.write(chunk);
        if (detected.decision === "pending") {
          callback();
          return;
        }
        this.#headerlessDetector = undefined;
        this.#eventStream = detected.decision === "event-stream";
        if (this.#eventStream) this.#startTimer();
        for (const buffered of detected.chunks) this.#transformChunk(buffered);
        callback();
        return;
      }
      this.#transformChunk(chunk);
      callback();
    } catch (error) {
      callback(error);
    }
  }

  #transformChunk(chunk) {
    if (!this.#eventStream) {
      // Non-streaming bodies pass through untouched; only streamed turns
      // exhibit the empty-completion failure.
      this.push(chunk);
      return;
    }
    const bytes = Buffer.from(chunk);
    if (this.#released) {
      this.push(bytes);
      // A liveness or time-limit release ends the hold, not the question. Keep
      // parsing from behind the relay so a turn that later produces nothing is
      // still recognized — it just gets reported instead of retried.
      if (!this.#settled()) {
        this.#parseBuffer += this.#decoder.write(bytes);
        this.#consumeBlocks();
        if (
          !this.#settled() &&
          Buffer.byteLength(this.#parseBuffer) > MAX_INCOMPLETE_EVENT_BYTES
        ) {
          this.#failPrelude("bytes");
        }
        if (!this.#settled()) this.#startTimer({ reset: true });
      }
      return;
    }
    this.#chunks.push(bytes);
    this.#bufferedBytes += bytes.length;
    this.#parseBuffer += this.#decoder.write(bytes);
    this.#consumeBlocks();
    if (!this.#released && this.#bufferedBytes > this.#maxPreludeBytes) {
      const pendingBytes = Buffer.byteLength(this.#parseBuffer);
      // Let a fragmented first event finish before classifying it. Retain at
      // most one bounded unfinished frame beyond the prelude budget; completed
      // malformed blocks cannot accumulate behind a small unfinished tail.
      if (
        !this.#sawTerminal &&
        pendingBytes > 0 &&
        pendingBytes <= MAX_INCOMPLETE_EVENT_BYTES &&
        this.#bufferedBytes - pendingBytes <= this.#maxPreludeBytes
      ) {
        return;
      }
      // A large but well-framed prologue is not a broken stream. Providers can
      // echo substantial response metadata before the first delta; relaying a
      // completed JSON event bounds our staging memory while parsing behind
      // the relay preserves the eventual empty/content verdict. Oversized
      // unfinished frames and unparseable completed bodies still fail closed.
      if (
        this.#sawParseableEvent &&
        !this.#sawTerminal &&
        pendingBytes <= MAX_INCOMPLETE_EVENT_BYTES
      ) {
        this.#release({ preludeLimit: "bytes" });
      } else {
        this.#failPrelude("bytes");
      }
    }
  }

  // No further parsing can change the outcome: either the turn produced content
  // or the hold ended for a reason that also ended the verdict (a content
  // release or an unparseable terminal).
  #settled() {
    return this.#sawContent || (this.#released && !this.#keepParsingAfterRelease);
  }

  _flush(callback) {
    try {
      if (this.#headerlessDetector) {
        const detected = this.#headerlessDetector.end();
        this.#headerlessDetector = undefined;
        this.#eventStream = detected.decision === "event-stream";
        if (this.#eventStream) this.#startTimer();
        for (const buffered of detected.chunks) this.#transformChunk(buffered);
      }
      this.#clearTimer();
      if (!this.#eventStream) {
        this.push(this.#decoder.end());
        callback();
        return;
      }
      if (this.#released) {
        // A stream released for liveness or the time limit was relayed in full,
        // so there is nothing left to push — but its verdict is still owed.
        // Finish parsing and record it; the caller reads `suppressedPrologue()`
        // to learn that this one cannot be retried behind the client's back.
        if (!this.#settled()) {
          this.#parseBuffer += this.#decoder.end();
          if (this.#parseBuffer) {
            this.#classifyBlock(this.#parseBuffer);
            this.#parseBuffer = "";
          }
          if (!this.#sawContent && this.#sawTerminal) this.#empty = true;
        }
        callback();
        return;
      }
      this.#parseBuffer += this.#decoder.end();
      if (this.#parseBuffer) {
        // The final block may lack its trailing blank line; it is still a
        // complete SSE block for our purposes.
        this.#classifyBlock(this.#parseBuffer);
        this.#parseBuffer = "";
      }
      if (!this.#sawContent && this.#sawTerminal) {
        this.#empty = true;
        // Every byte is still held, so the retry can replace this attempt whole.
        this.#suppressedPrologue = true;
        this.#chunks = [];
        this.#bufferedBytes = 0;
      } else {
        // A clean EOF without a protocol terminal is not proof of an empty
        // completion. Preserve it and let ordinary stream handling decide.
        this.#release();
      }
      callback();
    } catch (error) {
      callback(error);
    }
  }

  _destroy(error, callback) {
    this.#clearTimer();
    callback(error);
  }

  #consumeBlocks() {
    const blocks = this.#parseBuffer.split(/\r?\n\r?\n/);
    this.#parseBuffer = blocks.pop() || "";
    for (const block of blocks) {
      this.#classifyBlock(block);
      if (this.#settled()) return;
    }
  }

  #classifyBlock(block) {
    const { eventType, dataText } = this.#fields(block);
    if (dataText === "[DONE]") {
      this.#sawParseableEvent = true;
    } else if (dataText) {
      try {
        JSON.parse(dataText);
        this.#sawParseableEvent = true;
      } catch {
        // `#contentOf` below keeps malformed terminal data indeterminate. The
        // byte-budget decision remains fail-closed unless another complete
        // JSON event already established framing.
      }
    }
    // Content is decided before the terminal check: a gateway that puts the
    // whole turn in `response.completed` emits a terminal event that is also
    // the only content event in the stream.
    const content = this.#contentOf(eventType, dataText);
    if (content === true) {
      this.#sawContent = true;
      this.#clearTimer();
      this.#release();
      return;
    }
    // A failure terminal is the upstream's own verdict, not an empty
    // completion. Holding it would only delay the error the client needs
    // (until the prelude or stall timer, which then reports a second failure),
    // and retrying it would replay a request the provider already refused.
    if (isFailureTerminalEvent(eventType, dataText)) {
      this.#clearTimer();
      this.#release();
      // A stream already released for liveness or a time limit stops parsing
      // and stops its stall timer too: the failure is the verdict.
      this.#keepParsingAfterRelease = false;
      return;
    }
    if (isTerminalEvent(eventType, dataText)) {
      // A terminal event whose payload cannot be parsed is not evidence of an
      // empty completion — the very event that would carry the output is the
      // one we could not read. Release the stream (indeterminate) rather than
      // declaring the turn empty and forcing a retry of a possibly valid one.
      if (content === undefined) {
        this.#release();
        return;
      }
      this.#sawTerminal = true;
      return;
    }
    // Neither content nor terminal. If it proves the upstream is generating,
    // stop holding: the cost of the hold is paid by every reasoning turn, while
    // the empty completions it repairs are a fraction of a percent of them.
    if (!this.#released && this.#livenessOf(eventType, dataText) === true) {
      this.#release({ liveness: true });
    }
  }

  #release({ liveness = false, preludeLimit } = {}) {
    if (this.#released) return;
    this.#released = true;
    if (liveness) this.#releasedForLiveness = true;
    if (preludeLimit === "time" || preludeLimit === "bytes") {
      this.#preludeLimitKind = preludeLimit;
    }
    this.#keepParsingAfterRelease = liveness || Boolean(preludeLimit);
    this.#clearTimer();
    for (const chunk of this.#chunks) this.push(chunk);
    this.#chunks = [];
    this.#bufferedBytes = 0;
    // A liveness or time-limit release keeps parsing, and the buffer holds the
    // partial block straddling the release. Dropping it would corrupt the very
    // block the verdict may depend on. Every other release is done reading.
    if (!this.#keepParsingAfterRelease) this.#parseBuffer = "";
    else if (!this.#settled()) this.#startTimer();
  }

  #clearTimer() {
    if (this.#timer) {
      clearTimeout(this.#timer);
      this.#timer = undefined;
    }
  }

  #startTimer({ reset = false } = {}) {
    if (reset) this.#clearTimer();
    if (this.#timer || this.#settled()) return;
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      if (this.#settled()) return;
      if (this.#released) {
        // Once the prologue is visible, this is a stall bound. End a stream
        // that stopped producing complete events instead of letting a routed
        // request sit open for minutes with no answer.
        this.#failPrelude("time");
      } else if (this.#receivedBytes === 0 || this.#headerlessDetector) {
        // Headers-only responses and undecidable headerless bodies have
        // nothing safe to release. Fail while the first attempt is still fully
        // replaceable so the router can retry it once.
        this.#failPrelude("time");
      } else {
        // A time limit is otherwise a latency bound, not evidence the stream is
        // broken. Relay the staged prologue so a healthy slow model remains
        // cancellable, then keep parsing behind the relay.
        this.#release({ preludeLimit: "time" });
      }
    }, this.#released ? this.#maxStreamStallMs : this.#maxPreludeMs);
    this.#timer.unref?.();
  }

  #failPrelude(kind) {
    this.#clearTimer();
    this.#preludeLimitKind = kind;
    this.#suppressedPrologue = !this.#released;
    this.#chunks = [];
    this.#bufferedBytes = 0;
    this.#parseBuffer = "";
    const error = new EmptyCompletionPreludeLimitError(kind);
    if (kind === "time") this.destroy(error);
    else throw error;
  }

  #fields(block) {
    return sseFields(block);
  }

  // Liveness never decides the verdict, only the hold, so an unparseable block
  // is simply "not yet proven alive" rather than the indeterminate that
  // `#contentOf` has to preserve.
  #livenessOf(eventType, dataText) {
    if (!dataText || dataText === "[DONE]") return false;
    try {
      const data = JSON.parse(dataText);
      return isLivenessEvent(eventType ?? data?.type, data);
    } catch {
      return false;
    }
  }

  #contentOf(eventType, dataText) {
    if (!dataText || dataText === "[DONE]") return false;
    try {
      const data = JSON.parse(dataText);
      return isContentEvent(eventType ?? data?.type, data);
    } catch {
      // Indeterminate, not "no content": the payload could not be parsed, so
      // the absence of recognized content says nothing about whether the turn
      // produced output. Callers must not treat this as evidence of an empty
      // completion.
      return undefined;
    }
  }
}
