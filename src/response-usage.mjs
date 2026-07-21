import { Transform } from "node:stream";
import { StringDecoder } from "node:string_decoder";

const MAX_JSON_CAPTURE_BYTES = 8 * 1024 * 1024;

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

export class ResponseUsageTransform extends Transform {
  #eventStream;
  #decoder = new StringDecoder("utf8");
  #buffer = "";
  #capturedBytes = 0;
  #usage;

  constructor(contentType = "") {
    super();
    this.#eventStream = String(contentType).toLowerCase().includes("text/event-stream");
  }

  _transform(chunk, _encoding, callback) {
    this.push(chunk);
    if (this.#eventStream) {
      this.#buffer += this.#decoder.write(chunk);
      this.#consumeEventLines();
    } else if (this.#capturedBytes <= MAX_JSON_CAPTURE_BYTES) {
      this.#capturedBytes += chunk.length;
      if (this.#capturedBytes <= MAX_JSON_CAPTURE_BYTES) {
        this.#buffer += this.#decoder.write(chunk);
      } else {
        this.#buffer = "";
      }
    }
    callback();
  }

  _flush(callback) {
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
  }

  tokenUsage() {
    return this.#usage;
  }

  #consumeEventLines(flush = false) {
    const lines = this.#buffer.split(/\r?\n/);
    this.#buffer = flush ? "" : lines.pop() || "";
    for (const line of lines) {
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (!data || data === "[DONE]") continue;
      try {
        this.#observe(JSON.parse(data));
      } catch {
        // Ignore non-JSON SSE fields while preserving the original stream.
      }
    }
  }

  #observe(payload) {
    const usage = tokenUsageFromPayload(payload);
    if (usage) this.#usage = usage;
  }
}
