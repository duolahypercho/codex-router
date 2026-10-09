import { Transform } from "node:stream";
import { StringDecoder } from "node:string_decoder";

export const REPETITIVE_GENERATION_CODE = "router_repetitive_generation";
const MAX_TAIL = 8192;
const MIN_REPEAT = 4096;
const MAX_PERIOD = 512;
const MAX_FRAME = 1024 * 1024;
const MAX_PARTS = 32;

export class RepetitiveGenerationError extends Error {
  constructor() {
    super("Stopped sustained repetitive assistant text. No router retry was made; review the partial answer before continuing.");
    this.name = "RepetitiveGenerationError";
    this.code = REPETITIVE_GENERATION_CODE;
    this.status = 400;
  }
}

// This is deliberately narrower than low substring diversity. JSON fixtures,
// code, repeated table rows and new numbered records are useful output too.
// A whole prose unit must repeat continuously across at least 4096 characters.
export function hasSustainedProseRepetition(text) {
  if (typeof text !== "string" || text.length < MIN_REPEAT) return false;
  if (/^\s*[\[{"`]/.test(text) || /```|~~~/.test(text)) return false;
  const tail = text.slice(-MAX_TAIL).replace(/\s+/g, " ");
  if (tail.length < MIN_REPEAT || /[{}\[\]`<>=;\\|]/.test(tail)) return false;
  const anchor = tail.slice(-32);
  let from = tail.length - 33;
  for (let attempt = 0; attempt < 32 && from >= 0; attempt++) {
    const previous = tail.lastIndexOf(anchor, from);
    if (previous < 0) return false;
    const period = tail.length - 32 - previous;
    if (period > MAX_PERIOD) return false;
    from = previous - 1;
    if (period < 12) continue;
    const unit = tail.slice(-period);
    if (!/[\p{L}]/u.test(unit) || !/[.!?。！？]/u.test(unit)) continue;
    let matches = true;
    for (let index = tail.length - MIN_REPEAT; index < tail.length - period; index++) {
      if (tail[index] !== tail[index + period]) { matches = false; break; }
    }
    if (matches) return true;
  }
  return false;
}

class TextPart {
  tail = "";
  startSeen = false;
  exempt = false;
  markerTail = "";
  checked = 0;
  add(delta) {
    // Keep structured-output identity even when its opening bracket has left
    // the bounded tail. Ignore complete code examples, not just their fences.
    for (let offset = 0; offset < delta.length; offset += 512) {
      const part = delta.slice(offset, offset + 512);
      if (!this.startSeen) {
        const first = part.match(/\S/);
        if (first) {
          this.startSeen = true;
          this.exempt = /[\[{"`]/.test(first[0]);
        }
      }
      const markers = this.markerTail + part;
      if (/```|~~~/.test(markers)) this.exempt = true;
      this.markerTail = markers.slice(-2);
      if (this.exempt) return;
      this.tail = (this.tail + part).slice(-MAX_TAIL);
      this.checked += part.length;
      if (this.checked >= 512) {
        this.checked = 0;
        if (hasSustainedProseRepetition(this.tail)) {
          throw new RepetitiveGenerationError();
        }
      }
    }
  }
}

// An observer: healthy bytes, framing and UTF-8 are forwarded unchanged. Large
// or malformed frames are passed through rather than introducing a new limit
// on legitimate responses. Each text part gets its own bounded detector.
export class GlmRepetitionGuard extends Transform {
  #decoder = new StringDecoder("utf8");
  #frameBuffer = Buffer.allocUnsafe(MAX_FRAME * 2);
  #characters = 0;
  #delimiterTail = "";
  #oversized = false;
  #parts = new Map();
  _transform(chunk, encoding, callback) {
    try {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding);
      this.#consume(this.#decoder.write(bytes));
      this.push(chunk);
      callback();
    } catch (error) { callback(error); }
  }
  _flush(callback) {
    try { this.#consume(this.#decoder.end()); callback(); }
    catch (error) { callback(error); }
  }
  #consume(text) {
    const boundaries = /\r\n\r\n|\n\n/g;
    let offset = 0;
    while (offset < text.length) {
      // Only a three-character suffix can participate in a cross-chunk SSE
      // delimiter. Scan new text once; never concatenate/rescan a growing frame.
      const crossing = (this.#delimiterTail + text.slice(offset, offset + 3)).match(/\r\n\r\n|\n\n/);
      boundaries.lastIndex = offset;
      const within = boundaries.exec(text);
      const cross = crossing && crossing.index < this.#delimiterTail.length;
      const relative = cross ? crossing.index - this.#delimiterTail.length : within?.index - offset;
      const delimiter = cross ? crossing[0] : within?.[0];
      if (delimiter === undefined) {
        this.#append(text.slice(offset));
        this.#delimiterTail = (this.#delimiterTail + text.slice(-3)).slice(-3);
        return;
      }
      if (relative > 0) this.#append(text.slice(offset, offset + relative));
      if (!this.#oversized) {
        const length = this.#characters + Math.min(0, relative);
        this.#frame(this.#frameBuffer.toString("utf16le", 0, length * 2));
      }
      offset += relative + delimiter.length;
      this.#characters = 0;
      this.#delimiterTail = "";
      this.#oversized = false;
    }
  }
  #append(text) {
    if (this.#oversized) return;
    if (this.#characters + text.length > MAX_FRAME) {
      this.#oversized = true;
      this.#characters = 0;
      return;
    }
    this.#frameBuffer.write(text, this.#characters * 2, "utf16le");
    this.#characters += text.length;
  }
  #frame(frame) {
    const data = frame.split(/\r?\n/).filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).replace(/^ /, "")).join("\n");
    let event;
    try { event = JSON.parse(data); } catch { return; }
    if (!event || typeof event !== "object") return;
    if (event.type === "response.output_text.delta" && typeof event.delta === "string") {
      const identity = event.item_id ?? event.output_index ?? "unidentified";
      const contentIndex = event.content_index ?? 0;
      if (!(typeof identity === "string" && identity.length <= 512 ||
            Number.isSafeInteger(identity) && identity >= 0) ||
          !Number.isSafeInteger(contentIndex) || contentIndex < 0) return;
      const key = JSON.stringify([identity, contentIndex]);
      if (!this.#parts.has(key)) {
        if (this.#parts.size >= MAX_PARTS) this.#parts.delete(this.#parts.keys().next().value);
        this.#parts.set(key, new TextPart());
      }
      this.#parts.get(key).add(event.delta);
    }
    const check = (text) => {
      if (hasSustainedProseRepetition(text)) throw new RepetitiveGenerationError();
    };
    const checkPart = (part) => { if (part?.type === "output_text") check(part.text); };
    const checkItem = (item) => {
      if (item?.type === "message" && (!item.role || item.role === "assistant") && Array.isArray(item.content)) {
        for (const part of item.content) checkPart(part);
      }
    };
    if (event.type === "response.output_text.done") check(event.text);
    if (["response.content_part.added", "response.content_part.done"].includes(event.type)) checkPart(event.part);
    if (["response.output_item.added", "response.output_item.done"].includes(event.type)) checkItem(event.item);
    if (["response.completed", "response.done"].includes(event.type) && Array.isArray(event.response?.output)) {
      for (const item of event.response.output) checkItem(item);
    }
    if (["response.completed", "response.done", "response.failed", "response.incomplete", "error"].includes(event.type)) this.#parts.clear();
  }
}

export function glmRepetitionGuardTransform(model, contentType) {
  if (model?.repetitionGuard !== true ||
      !/(?:^|\/)glm-5\.3(?:$|[-:])/i.test(model.upstreamModel || "") ||
      !/text\/event-stream/i.test(String(contentType))) return undefined;
  return new GlmRepetitionGuard();
}
