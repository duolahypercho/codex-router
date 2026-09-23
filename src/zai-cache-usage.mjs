import { Transform } from "node:stream";

const LINE_FEED = 0x0a;

// Z.ai reports authoritative prompt/cache usage on the same terminal chunk as
// finish_reason. LiteLLM 1.95/1.96 loses usage details on that choice-bearing
// shape, but preserves the standard OpenAI usage-only terminal chunk. Normalize
// the provider stream before it reaches LiteLLM and mirror cached_tokens into
// the compatibility field LiteLLM already understands. Never infer usage.
function cachedTokens(payload) {
  const value = payload?.usage?.prompt_tokens_details?.cached_tokens;
  return Number.isInteger(value) && value >= 0 ? value : undefined;
}

function usageObject(payload) {
  const usage = payload?.usage;
  return usage && typeof usage === "object" && !Array.isArray(usage) && Object.keys(usage).length
    ? usage
    : undefined;
}

function choiceBearingUsage(payload) {
  return Array.isArray(payload?.choices) && payload.choices.length > 0 && usageObject(payload);
}

export class ZaiCacheUsageCompatTransform extends Transform {
  #pending = Buffer.alloc(0);

  _transform(chunk, _encoding, callback) {
    this.#pending = this.#pending.length ? Buffer.concat([this.#pending, chunk]) : chunk;
    this.#consumeLines();
    callback();
  }

  _flush(callback) {
    this.#consumeLines(true);
    callback();
  }

  #consumeLines(flush = false) {
    while (true) {
      const index = this.#pending.indexOf(LINE_FEED);
      if (index === -1) break;
      const line = this.#pending.subarray(0, index + 1);
      this.#pending = this.#pending.subarray(index + 1);
      this.push(this.#rewriteLine(line));
    }
    if (flush && this.#pending.length) {
      this.push(this.#rewriteLine(this.#pending));
      this.#pending = Buffer.alloc(0);
    }
  }

  #rewriteLine(line) {
    const text = line.toString("utf8");
    const terminator = text.endsWith("\r\n") ? "\r\n" : text.endsWith("\n") ? "\n" : "";
    const content = terminator ? text.slice(0, -terminator.length) : text;
    if (!content.startsWith("data:")) return line;
    const data = content.slice(5).trim();
    if (!data || data === "[DONE]") return line;
    let payload;
    try {
      payload = JSON.parse(data);
    } catch {
      return line;
    }

    const usage = usageObject(payload);
    if (usage === undefined) return line;
    const cached = cachedTokens(payload);
    let changed = false;
    if (cached !== undefined && usage.prompt_cache_hit_tokens === undefined) {
      usage.prompt_cache_hit_tokens = cached;
      changed = true;
    }

    if (!choiceBearingUsage(payload)) {
      return changed ? Buffer.from(`data: ${JSON.stringify(payload)}${terminator}`, "utf8") : line;
    }

    const terminal = { ...payload };
    delete terminal.usage;
    const usageOnly = { ...payload, choices: [], usage };
    const separator = terminator || "\n";
    return Buffer.from(
      `data: ${JSON.stringify(terminal)}${separator}${separator}data: ${JSON.stringify(usageOnly)}${terminator}`,
      "utf8",
    );
  }
}

// opencode-go (Console Go /v1/chat/completions) sends the same shape: usage on
// the finish_reason chunk with a non-empty choices array, then [DONE]. LiteLLM
// 1.96 discards it (BerriAI/litellm#36168), so Codex reports cached_tokens=0
// even though Go caches the prefix (verified 2026-08-26: mimo-v2.5 returned
// cached_tokens 2560/2571 on a repeated prefix when called directly).
const CHOICE_BEARING_USAGE_PROVIDERS = ["zai-api", "zai-coding", "opencode-go", "openrouter"];

export function zaiCacheUsageTransform(providerId, contentType = "") {
  if (!CHOICE_BEARING_USAGE_PROVIDERS.includes(String(providerId))) return undefined;
  if (!String(contentType).toLowerCase().includes("text/event-stream")) return undefined;
  return new ZaiCacheUsageCompatTransform();
}
