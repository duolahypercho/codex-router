import { StringDecoder } from "node:string_decoder";
import { Transform } from "node:stream";

// Codex ends a routed stream after five minutes without a complete SSE data
// event (`stream_idle_timeout_ms`, default 300000) and then sends the whole
// turn again, which bills the provider a second time. A comment line or a
// WebSocket ping does not reset that timer; a parsed data event does. A Grok
// OAuth turn can legitimately reason for longer than five minutes with nothing
// to send, so while such a stream is silent this transform relays a
// `response.in_progress` event -- a lifecycle event every Responses client
// already receives at the start of a turn and ignores -- and the client's idle
// timer then measures a live upstream instead of a quiet one.
//
// It never authors content. It repeats only the identity of the response the
// stream itself announced, only at an SSE event boundary, only after the client
// has seen `response.created`, and never after a terminal event. It runs
// after the content rewrites; only the final bounded failure-metadata observer
// follows it, preserving the heartbeat's bytes.
const TERMINAL_EVENT_TYPES = new Set([
  "response.completed",
  "response.failed",
  "response.incomplete",
  "response.done",
  "error",
]);
const SNAPSHOT_EVENT_TYPES = new Set(["response.created", "response.in_progress"]);
// The announcing event can carry the full instructions and tool list. Parse it
// only within this bound; a larger one simply leaves the heartbeat off.
const MAX_SNAPSHOT_EVENT_CHARS = 4 * 1024 * 1024;

function eventOf(block) {
  let eventType;
  const data = [];
  for (const line of block.split(/\r?\n/)) {
    if (line.startsWith("event:")) eventType = line.slice(6).trim();
    else if (line.startsWith("data:")) {
      const value = line.slice(5);
      data.push(value.startsWith(" ") ? value.slice(1) : value);
    }
  }
  return { eventType, dataText: data.length ? data.join("\n") : undefined };
}

function responseIdentity(response) {
  if (!response || typeof response !== "object" || typeof response.id !== "string") return undefined;
  return {
    id: response.id,
    object: "response",
    ...(Number.isFinite(response.created_at) ? { created_at: response.created_at } : {}),
    ...(typeof response.model === "string" ? { model: response.model } : {}),
    status: "in_progress",
    output: [],
  };
}

export class ResponsesHeartbeatTransform extends Transform {
  #intervalMs;
  #decoder = new StringDecoder("utf8");
  #parseBuffer = "";
  #identity;
  #terminal = false;
  #timer;

  constructor({ intervalMs }) {
    super();
    this.#intervalMs = intervalMs;
  }

  _transform(chunk, _encoding, callback) {
    this.push(chunk);
    if (!this.#terminal) {
      this.#parseBuffer += this.#decoder.write(chunk);
      const blocks = this.#parseBuffer.split(/\r?\n\r?\n/);
      this.#parseBuffer = blocks.pop() || "";
      for (const block of blocks) this.#observe(block);
      if (this.#parseBuffer.length > MAX_SNAPSHOT_EVENT_CHARS && !this.#identity) {
        // An unbounded partial event before any announcement: stop trying.
        this.#terminal = true;
      }
      this.#arm();
    }
    callback();
  }

  _flush(callback) {
    this.#stop();
    callback();
  }

  _destroy(error, callback) {
    this.#stop();
    callback(error);
  }

  #observe(block) {
    const { eventType, dataText } = eventOf(block);
    let type = eventType;
    let payload;
    if (dataText && dataText !== "[DONE]" && dataText.length <= MAX_SNAPSHOT_EVENT_CHARS &&
        (type === undefined || SNAPSHOT_EVENT_TYPES.has(type))) {
      try {
        payload = JSON.parse(dataText);
        type ??= payload?.type;
      } catch {
        // Not JSON: nothing to learn from this block.
      }
    }
    // An event too large to parse can still be a terminal. Its top-level type
    // precedes the payload it carries, so read it from the start of the data.
    if (type === undefined && dataText && dataText.length > MAX_SNAPSHOT_EVENT_CHARS) {
      type = /"type"\s*:\s*"([^"]{1,64})"/.exec(dataText.slice(0, 256))?.[1];
    }
    if (TERMINAL_EVENT_TYPES.has(type) || dataText === "[DONE]") {
      this.#stop();
      return;
    }
    if (SNAPSHOT_EVENT_TYPES.has(type)) {
      this.#identity = responseIdentity(payload?.response) ?? this.#identity;
    }
  }

  #arm() {
    if (this.#timer) clearTimeout(this.#timer);
    if (this.#terminal) return;
    this.#timer = setTimeout(() => this.#beat(), this.#intervalMs);
    this.#timer.unref?.();
  }

  #beat() {
    this.#timer = undefined;
    if (this.#terminal || this.destroyed || this.writableEnded) return;
    // Mid-event bytes are still owed to the client; a heartbeat there would
    // corrupt the event being relayed.
    if (this.#identity && this.#parseBuffer === "") {
      this.push(
        `event: response.in_progress\ndata: ${JSON.stringify({
          type: "response.in_progress",
          response: this.#identity,
        })}\n\n`,
      );
    }
    this.#arm();
  }

  #stop() {
    this.#terminal = true;
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = undefined;
  }
}
