import { Transform } from "node:stream";
import { StringDecoder } from "node:string_decoder";

function isMiniMaxModel(model) {
  return [model?.provider, model?.upstreamModel, model?.gatewayModel, model?.slug]
    .some((value) => typeof value === "string" && value.toLowerCase().includes("minimax"));
}

function stripThinking(text) {
  return typeof text === "string"
    ? text.replace(/<think\b[^>]*>[\s\S]*?<\/think\s*>/gi, "")
    : text;
}

function parseSseBlock(block) {
  const lines = block.split(/\r?\n/);
  const index = lines.findIndex((line) => line.startsWith("data:"));
  if (index === -1) return undefined;
  const data = lines[index].slice(5).trim();
  if (!data || data === "[DONE]") return undefined;
  try {
    return { lines, index, event: JSON.parse(data) };
  } catch {
    return undefined;
  }
}

function rewrite(block, parsed, event) {
  const lines = [...parsed.lines];
  lines[parsed.index] = `data: ${JSON.stringify(event)}`;
  return lines.join(block.includes("\r\n") ? "\r\n" : "\n");
}

function rewriteTextFields(value, sanitize = stripThinking) {
  if (!value || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((entry) => rewriteTextFields(entry, sanitize));
  const copy = { ...value };
  for (const key of ["text", "delta"]) {
    if (typeof copy[key] === "string") copy[key] = sanitize(copy[key]);
  }
  if (copy.item) copy.item = rewriteTextFields(copy.item, sanitize);
  if (copy.part) copy.part = rewriteTextFields(copy.part, sanitize);
  if (copy.output) copy.output = rewriteTextFields(copy.output, sanitize);
  if (copy.content) copy.content = rewriteTextFields(copy.content, sanitize);
  return copy;
}

export class MiniMaxResponsesCompatTransform extends Transform {
  #decoder = new StringDecoder("utf8");
  #buffer = "";
  #insideThink = false;
  #pending = "";

  _transform(chunk, _encoding, callback) {
    this.#buffer += this.#decoder.write(chunk);
    this.#emit(false);
    callback();
  }

  _flush(callback) {
    this.#buffer += this.#decoder.end();
    this.#emit(true);
    callback();
  }

  #emit(flush) {
    while (this.#buffer.length) {
      const lf = this.#buffer.indexOf("\n\n");
      if (lf === -1) {
        if (!flush) return;
        const block = this.#buffer;
        this.#buffer = "";
        this.push(Buffer.from(this.#rewrite(block)));
        return;
      }
      const block = this.#buffer.slice(0, lf);
      this.#buffer = this.#buffer.slice(lf + 2);
      this.push(Buffer.from(`${this.#rewrite(block)}\n\n`));
    }
  }

  #rewrite(block) {
    const parsed = parseSseBlock(block);
    if (!parsed) return block;
    const next = rewriteTextFields(parsed.event, (text) => this.#consume(text));
    return rewrite(block, parsed, next);
  }

  #consume(text) {
    if (typeof text !== "string") return text;
    let input = this.#pending + text;
    this.#pending = "";
    let output = "";
    while (input) {
      if (this.#insideThink) {
        const close = input.search(/<\/think\s*>/i);
        if (close === -1) return output;
        input = input.slice(close).replace(/^<\/think\s*>/i, "");
        this.#insideThink = false;
        continue;
      }
      const open = input.search(/<think\b[^>]*>/i);
      if (open === -1) {
        const partial = input.match(/<\/?think\b[^>]*$/i)?.[0];
        if (partial) {
          this.#pending = partial;
          return output + input.slice(0, -partial.length);
        }
        return output + input;
      }
      output += input.slice(0, open);
      input = input.slice(open).replace(/^<think\b[^>]*>/i, "");
      this.#insideThink = true;
    }
    return output;
  }
}

export function minimaxResponsesCompatTransform(model, contentType = "") {
  if (!isMiniMaxModel(model) || !contentType.toLowerCase().includes("text/event-stream")) {
    return undefined;
  }
  return new MiniMaxResponsesCompatTransform();
}
