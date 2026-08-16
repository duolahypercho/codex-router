// The other half of the `/alpha/generate` bridge: turning what the route
// answers back into what the caller asked for.
//
// The response is newline-delimited JSON, not SSE -- no `data:` prefix, no
// `event:` lines, one JSON object per line. A logical block (reasoning, text,
// or one tool call) is keyed by `id`, and blocks interleave: a live stream was
// observed emitting `text-start` before the `reasoning-end` of the reasoning
// block preceding it. OpenAI chunks tolerate that directly; Anthropic content
// blocks do not, so the Anthropic side serializes blocks and closes the open
// one before opening the next.
//
// One trap worth naming: the incremental tool events key on `id`, but the
// final redundant `tool-call` event keys on `toolCallId`. Reading only `id`
// silently drops it, and on a model that skips the incremental events that is
// the whole tool call.

const FINISH_REASONS = new Map([
  ["stop", { openai: "stop", anthropic: "end_turn" }],
  ["length", { openai: "length", anthropic: "max_tokens" }],
  ["tool-calls", { openai: "tool_calls", anthropic: "tool_use" }],
  ["content-filter", { openai: "content_filter", anthropic: "end_turn" }],
  ["error", { openai: "stop", anthropic: "end_turn" }],
]);

function finishReason(raw, protocol) {
  const mapped = FINISH_REASONS.get(String(raw || "stop"));
  return mapped ? mapped[protocol] : protocol === "anthropic" ? "end_turn" : "stop";
}

// `inputTokens` follows the Vercel AI SDK convention and already *includes*
// the cached tokens. OpenAI's shape wants the same total with cached reported
// separately, so it maps straight across; Anthropic's `input_tokens` excludes
// cache reads, so the cached count is subtracted there instead of being
// double-counted into the caller's cost math.
function openAiUsage(usage) {
  if (!usage) return undefined;
  const cached = Number(usage.cachedInputTokens || 0);
  return {
    prompt_tokens: Number(usage.inputTokens || 0),
    completion_tokens: Number(usage.outputTokens || 0),
    total_tokens: Number(usage.totalTokens || 0),
    ...(cached ? { prompt_tokens_details: { cached_tokens: cached } } : {}),
    ...(usage.reasoningTokens
      ? { completion_tokens_details: { reasoning_tokens: Number(usage.reasoningTokens) } }
      : {}),
  };
}

function anthropicUsage(usage) {
  if (!usage) return { input_tokens: 0, output_tokens: 0 };
  const cached = Number(usage.cachedInputTokens || 0);
  return {
    input_tokens: Math.max(0, Number(usage.inputTokens || 0) - cached),
    output_tokens: Number(usage.outputTokens || 0),
    ...(cached ? { cache_read_input_tokens: cached } : {}),
  };
}

function sse(data, event) {
  return `${event ? `event: ${event}\n` : ""}data: ${JSON.stringify(data)}\n\n`;
}

/**
 * Incremental translator from `/alpha/generate` events to one caller protocol.
 *
 * `push(event)` returns the SSE text to write for that event (possibly empty).
 * `finish()` closes whatever the stream left open -- a stream that ends with
 * neither `finish-step` nor `finish` still has to terminate cleanly, because a
 * caller waiting on a terminal event would otherwise hang on a dead socket.
 */
export class GenerateTranslator {
  constructor({ protocol = "openai", model = "", id, created = Math.floor(Date.now() / 1000) } = {}) {
    this.protocol = protocol;
    this.model = model;
    this.id = id || `chatcmpl-${Math.random().toString(36).slice(2, 12)}`;
    this.created = created;
    this.started = false;
    this.finished = false;
    this.usage = undefined;
    this.finishReasonRaw = "stop";
    this.error = undefined;
    // Anthropic serialization state.
    this.blockIndex = -1;
    this.openBlock = undefined;
    // OpenAI tool-call slots, and the ids already emitted so the redundant
    // trailing `tool-call` event cannot fire a second, duplicate call.
    this.toolIndexes = new Map();
    this.toolNames = new Map();
    this.completedTools = new Set();
    // Non-streaming assembly.
    this.text = "";
    this.reasoning = "";
    this.toolCalls = [];
  }

  push(event) {
    if (this.finished || !event || typeof event !== "object") return "";
    switch (event.type) {
      case "start":
        return this.#start();
      case "reasoning-start":
        return this.#blockStart(event.id, "reasoning");
      case "reasoning-delta":
        this.reasoning += String(event.text ?? "");
        return this.#delta(event.id, "reasoning", String(event.text ?? ""));
      case "text-start":
        return this.#blockStart(event.id, "text");
      case "text-delta":
        this.text += String(event.text ?? "");
        return this.#delta(event.id, "text", String(event.text ?? ""));
      case "reasoning-end":
      case "text-end":
        return this.#blockEnd(event.id);
      case "tool-input-start":
        return this.#toolStart(event.id, event.toolName);
      case "tool-input-delta":
        return this.#toolDelta(event.id, String(event.delta ?? ""));
      case "tool-input-end":
        return this.#toolEnd(event.id);
      case "tool-call":
        return this.#toolComplete(event);
      case "finish-step":
      case "finish":
        if (event.usage) this.usage = event.usage;
        if (event.totalUsage) this.usage = event.totalUsage;
        if (event.finishReason) this.finishReasonRaw = event.finishReason;
        return "";
      case "error":
        this.error = event.error?.message || event.message || "Command Code stream error";
        return "";
      default:
        // `start-step` echoes the resolved upstream request and carries no
        // content; unknown future events are ignored rather than fatal.
        return "";
    }
  }

  finish() {
    if (this.finished) return "";
    this.finished = true;
    let out = this.started ? "" : this.#start();
    out += this.#closeOpenBlock();
    if (this.protocol === "anthropic") {
      out += sse(
        {
          type: "message_delta",
          delta: { stop_reason: finishReason(this.finishReasonRaw, "anthropic"), stop_sequence: null },
          usage: anthropicUsage(this.usage),
        },
        "message_delta",
      );
      out += sse({ type: "message_stop" }, "message_stop");
      return out;
    }
    const usage = openAiUsage(this.usage);
    out += sse({
      ...this.#chunkShell(),
      choices: [{ index: 0, delta: {}, finish_reason: finishReason(this.finishReasonRaw, "openai") }],
      ...(usage ? { usage } : {}),
    });
    out += "data: [DONE]\n\n";
    return out;
  }

  /** The whole answer, for a caller that did not ask for a stream. */
  body() {
    if (this.protocol === "anthropic") {
      const content = [];
      if (this.reasoning) content.push({ type: "thinking", thinking: this.reasoning, signature: "" });
      if (this.text) content.push({ type: "text", text: this.text });
      for (const call of this.toolCalls) {
        content.push({ type: "tool_use", id: call.id, name: call.name, input: safeJson(call.arguments) });
      }
      return {
        id: this.id,
        type: "message",
        role: "assistant",
        model: this.model,
        content,
        stop_reason: finishReason(this.finishReasonRaw, "anthropic"),
        stop_sequence: null,
        usage: anthropicUsage(this.usage),
      };
    }
    const message = { role: "assistant", content: this.text || null };
    if (this.reasoning) message.reasoning_content = this.reasoning;
    if (this.toolCalls.length) {
      message.tool_calls = this.toolCalls.map((call) => ({
        id: call.id,
        type: "function",
        function: { name: call.name, arguments: call.arguments || "{}" },
      }));
    }
    const usage = openAiUsage(this.usage);
    return {
      id: this.id,
      object: "chat.completion",
      created: this.created,
      model: this.model,
      choices: [
        { index: 0, message, finish_reason: finishReason(this.finishReasonRaw, "openai") },
      ],
      ...(usage ? { usage } : {}),
    };
  }

  #chunkShell() {
    return { id: this.id, object: "chat.completion.chunk", created: this.created, model: this.model };
  }

  #start() {
    if (this.started) return "";
    this.started = true;
    if (this.protocol === "anthropic") {
      return sse(
        {
          type: "message_start",
          message: {
            id: this.id,
            type: "message",
            role: "assistant",
            model: this.model,
            content: [],
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: 0, output_tokens: 0 },
          },
        },
        "message_start",
      );
    }
    return sse({
      ...this.#chunkShell(),
      choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }],
    });
  }

  #closeOpenBlock() {
    if (this.protocol !== "anthropic" || !this.openBlock) return "";
    this.openBlock = undefined;
    return sse({ type: "content_block_stop", index: this.blockIndex }, "content_block_stop");
  }

  #blockStart(id, kind) {
    let out = this.started ? "" : this.#start();
    if (this.protocol !== "anthropic") return out;
    out += this.#closeOpenBlock();
    this.blockIndex += 1;
    this.openBlock = { id, kind };
    const contentBlock =
      kind === "reasoning" ? { type: "thinking", thinking: "" } : { type: "text", text: "" };
    return (
      out +
      sse({ type: "content_block_start", index: this.blockIndex, content_block: contentBlock }, "content_block_start")
    );
  }

  #blockEnd(id) {
    // A late end for a block another start already displaced is not an error;
    // the displacement already closed it.
    if (this.protocol !== "anthropic" || this.openBlock?.id !== id) return "";
    return this.#closeOpenBlock();
  }

  #delta(id, kind, text) {
    if (!text) return this.started ? "" : this.#start();
    let out = this.started ? "" : this.#start();
    if (this.protocol !== "anthropic") {
      return (
        out +
        sse({
          ...this.#chunkShell(),
          choices: [
            {
              index: 0,
              delta: kind === "reasoning" ? { reasoning_content: text } : { content: text },
              finish_reason: null,
            },
          ],
        })
      );
    }
    // A delta for a block that never opened (or that a later start displaced)
    // still has content the caller must see, so open a block for it.
    if (this.openBlock?.id !== id) out += this.#blockStart(id, kind);
    return (
      out +
      sse(
        {
          type: "content_block_delta",
          index: this.blockIndex,
          delta:
            kind === "reasoning" ? { type: "thinking_delta", thinking: text } : { type: "text_delta", text },
        },
        "content_block_delta",
      )
    );
  }

  #toolStart(id, toolName) {
    if (!id || this.toolIndexes.has(id)) return "";
    let out = this.started ? "" : this.#start();
    const name = String(toolName || "tool");
    this.toolNames.set(id, name);
    this.toolCalls.push({ id, name, arguments: "" });
    if (this.protocol === "anthropic") {
      out += this.#closeOpenBlock();
      this.blockIndex += 1;
      this.openBlock = { id, kind: "tool" };
      this.toolIndexes.set(id, this.blockIndex);
      return (
        out +
        sse(
          {
            type: "content_block_start",
            index: this.blockIndex,
            content_block: { type: "tool_use", id, name, input: {} },
          },
          "content_block_start",
        )
      );
    }
    const index = this.toolIndexes.size;
    this.toolIndexes.set(id, index);
    return (
      out +
      sse({
        ...this.#chunkShell(),
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [{ index, id, type: "function", function: { name, arguments: "" } }],
            },
            finish_reason: null,
          },
        ],
      })
    );
  }

  #toolDelta(id, delta) {
    if (!delta) return "";
    let out = "";
    if (!this.toolIndexes.has(id)) out += this.#toolStart(id, this.toolNames.get(id));
    const call = this.toolCalls.find((entry) => entry.id === id);
    if (call) call.arguments += delta;
    const index = this.toolIndexes.get(id);
    if (this.protocol === "anthropic") {
      return (
        out +
        sse(
          {
            type: "content_block_delta",
            index,
            delta: { type: "input_json_delta", partial_json: delta },
          },
          "content_block_delta",
        )
      );
    }
    return (
      out +
      sse({
        ...this.#chunkShell(),
        choices: [
          {
            index: 0,
            delta: { tool_calls: [{ index, function: { arguments: delta } }] },
            finish_reason: null,
          },
        ],
      })
    );
  }

  #toolEnd(id) {
    this.completedTools.add(id);
    if (this.protocol !== "anthropic" || this.openBlock?.id !== id) return "";
    return this.#closeOpenBlock();
  }

  // The redundant trailing event. It is the only tool signal some models emit,
  // so it must be honored -- and it must not double-fire when the incremental
  // events already delivered the same call.
  #toolComplete(event) {
    const id = event.toolCallId || event.id;
    if (!id || this.completedTools.has(id) || this.toolIndexes.has(id)) {
      this.completedTools.add(id);
      return "";
    }
    const args = JSON.stringify(event.input ?? {});
    let out = this.#toolStart(id, event.toolName);
    out += this.#toolDelta(id, args);
    out += this.#toolEnd(id);
    return out;
  }
}

function safeJson(raw) {
  try {
    const parsed = JSON.parse(raw || "{}");
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * Split a byte stream into `/alpha/generate` events.
 *
 * Kept separate from the translator so a partial line at a chunk boundary is
 * handled in one place: the route splits JSON objects across TCP reads, and a
 * parser that assumed whole lines would drop content at random under load.
 */
export async function* readGenerateEvents(stream) {
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of stream) {
    buffer += decoder.decode(chunk, { stream: true });
    let newline = buffer.indexOf("\n");
    while (newline !== -1) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line) {
        const event = parseEvent(line);
        if (event) yield event;
      }
      newline = buffer.indexOf("\n");
    }
  }
  const tail = buffer.trim();
  if (tail) {
    const event = parseEvent(tail);
    if (event) yield event;
  }
}

function parseEvent(line) {
  try {
    // The gateway answers `text/event-stream` for this route but sends bare
    // JSON lines. Should it ever start prefixing them, the prefix is stripped
    // rather than turning every event into a parse failure.
    const payload = line.startsWith("data:") ? line.slice(5).trim() : line;
    if (!payload || payload === "[DONE]") return undefined;
    return JSON.parse(payload);
  } catch {
    return undefined;
  }
}
