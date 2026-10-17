import { isUtf8 } from "node:buffer";
import { Transform } from "node:stream";
import { jsonArgumentsAreUnambiguous } from "./namespace-relay.mjs";
import { actualServiceTierFromValue } from "./request-diagnostics.mjs";

const MAX_EVENT_BYTES = 4 * 1024 * 1024;

// LiteLLM drops Chat's service_tier while translating to Responses, but carries
// provider_specific_fields. Only an actual upstream report may populate it.
export function grokChatServiceTierBody(body) {
  if (!isUtf8(body)) return { body };
  const raw = body.toString("utf8");
  let payload;
  try { payload = JSON.parse(raw); } catch { return { body }; }
  if (!payload || typeof payload !== "object" || Array.isArray(payload) ||
      !Array.isArray(payload.choices) || !jsonArgumentsAreUnambiguous(raw)) return { body };
  const actual = actualServiceTierFromValue(payload.service_tier);
  if (actual.kind === "missing") return { body };
  const serviceTier = actual.kind === "known" ? actual.value : "unknown";
  const extra = payload.provider_specific_fields;
  // Do not discard malformed/unknown vendor metadata to add optional telemetry.
  if (extra !== undefined && (!extra || typeof extra !== "object" || Array.isArray(extra))) {
    return { body, serviceTier };
  }
  if (actual.kind === "known") payload.service_tier = serviceTier;
  else delete payload.service_tier;
  payload.provider_specific_fields = { ...extra, grok_service_tier: serviceTier };
  return { body: Buffer.from(JSON.stringify(payload)), serviceTier };
}

function boundary(buffer) {
  const lf = buffer.indexOf("\n\n");
  const crlf = buffer.indexOf("\r\n\r\n");
  if (lf < 0 && crlf < 0) return undefined;
  return crlf >= 0 && (lf < 0 || crlf < lf) ? crlf + 4 : lf + 2;
}

// Keep the ordinary SSE stream incremental. Oversized or ambiguous events are
// relayed unchanged rather than retaining an unbounded optional parse buffer.
export class GrokChatServiceTierTransform extends Transform {
  #pending = Buffer.alloc(0);
  #passthrough = false;

  _transform(chunk, encoding, callback) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding);
    this.#pending = this.#pending.length ? Buffer.concat([this.#pending, bytes]) : bytes;
    let end;
    while ((end = boundary(this.#pending)) !== undefined) {
      const frame = this.#pending.subarray(0, end);
      this.#pending = this.#pending.subarray(end);
      this.push(this.#passthrough || frame.length > MAX_EVENT_BYTES ? frame : this.#rewrite(frame));
      this.#passthrough = false;
    }
    if (this.#passthrough || this.#pending.length > MAX_EVENT_BYTES) {
      // Retain only enough suffix to recognize a delimiter split across chunks.
      const release = Math.max(0, this.#pending.length - 3);
      if (release) this.push(this.#pending.subarray(0, release));
      this.#pending = Buffer.from(this.#pending.subarray(release));
      this.#passthrough = true;
    }
    callback();
  }

  _flush(callback) {
    if (this.#pending.length) this.push(this.#passthrough ? this.#pending : this.#rewrite(this.#pending));
    callback();
  }

  #rewrite(frame) {
    if (!isUtf8(frame)) return frame;
    const text = frame.toString("utf8");
    const data = text.split(/\r?\n/).filter(line => line.startsWith("data:"))
      .map(line => line.slice(5).replace(/^ /, "")).join("\n");
    if (!data || data === "[DONE]") return frame;
    const original = Buffer.from(data);
    const normalized = grokChatServiceTierBody(original);
    if (normalized.body === original) return frame;
    let replaced = false;
    return Buffer.from(text.replace(/^data:[^\r\n]*(\r?\n|$)/gm, (_line, ending) => {
      if (replaced) return "";
      replaced = true;
      return `data: ${normalized.body.toString("utf8")}${ending}`;
    }));
  }
}
