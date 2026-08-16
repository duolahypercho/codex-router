// Translation between the Gemini generateContent API and the Responses API.
//
// Gemini CLI cannot speak anything but Gemini: with `GEMINI_API_KEY` set it
// builds a `@google/genai` client and calls `{baseUrl}/v1beta/models/{model}:
// {method}` directly (see `createContentGenerator` in @google/gemini-cli-core).
// So a client integration for it needs a Gemini-shaped surface, which is the
// one thing AGENTS.md tells the harness integration not to add for itself.
//
// The rule behind that instruction still holds, though, and this module is how:
// nothing here talks to a provider. It converts a Gemini request into a
// Responses request and a Responses answer back into a Gemini answer, and
// `gemini-surface.mjs` sends the middle through the router's own
// `/v1/responses` endpoint. There is still exactly one request path to keep
// correct -- tool-result ageing, the vision bridge, prompt-token substitution,
// upstream retry, failover, and usage accounting all sit on it -- and this file
// is a pure function on either side of it.

// @google/genai's GOOGLE_AI_API_DEFAULT_VERSION. The SDK joins the configured
// base URL and this string itself, so serving any other version means the CLI's
// requests 404 against a surface that is otherwise complete.
export const GEMINI_API_VERSION = "v1beta";

const MODELS_PREFIX = `/${GEMINI_API_VERSION}/models`;
// `embedContent` is recognized here but not served: parsing it is what lets the
// surface answer with a 501 that names the limit instead of a bare 404 that
// looks like a broken base URL. Gemini CLI calls it from `baseLlmClient` only,
// never from the turn loop.
const SUPPORTED_METHODS = new Set([
  "generateContent",
  "streamGenerateContent",
  "countTokens",
  "embedContent",
]);

export const GEMINI_GENERATION_METHODS = Object.freeze([
  "generateContent",
  "streamGenerateContent",
  "countTokens",
]);

// The same crude ratio `response-usage.mjs` uses for prompt estimates. It needs
// no tokenizer download and is measured against the bytes that would go
// upstream rather than against a model of the conversation.
const ESTIMATE_BYTES_PER_TOKEN = 4;

/**
 * Splits a Gemini request path into its model and method.
 *
 * Router slugs carry a slash (`vendor/model`), and the SDK renders
 * `models/{model}:{method}` verbatim -- so the model is everything between the
 * prefix and the *last* colon, not the first path segment. An unrecognized
 * shape returns undefined rather than a guess: the surface answers those with a
 * 404 that names the path, which is a far better failure than routing a
 * `tunedModels/...` request to whatever slug the parse happened to produce.
 */
export function parseGeminiPath(pathname) {
  if (typeof pathname !== "string") return undefined;
  const withoutQuery = pathname.split("?", 1)[0];
  if (withoutQuery === MODELS_PREFIX || withoutQuery === `${MODELS_PREFIX}/`) {
    return { method: "list" };
  }
  if (!withoutQuery.startsWith(`${MODELS_PREFIX}/`)) return undefined;
  const remainder = withoutQuery.slice(MODELS_PREFIX.length + 1);
  const separator = remainder.lastIndexOf(":");
  if (separator <= 0) return undefined;
  const model = remainder.slice(0, separator);
  const method = remainder.slice(separator + 1);
  if (!model || !SUPPORTED_METHODS.has(method)) return undefined;
  return { model, method };
}

function textOf(value) {
  if (typeof value === "string") return value;
  if (value && typeof value === "object") {
    const parts = Array.isArray(value.parts) ? value.parts : [];
    const text = parts
      .map((part) => (typeof part?.text === "string" ? part.text : ""))
      .filter(Boolean)
      .join("\n");
    return text || undefined;
  }
  return undefined;
}

function inlineDataUrl(inlineData) {
  const mimeType = String(inlineData?.mimeType || "application/octet-stream");
  const data = String(inlineData?.data || "");
  return `data:${mimeType};base64,${data}`;
}

// Gemini omits `id` on both halves of a tool exchange whenever the caller did
// not supply one, so the pairing has to be rebuilt positionally: the nth call
// to a tool answers the nth response for that tool. Responses silently drops a
// `function_call_output` whose `call_id` matches no call, and to the model that
// reads as a tool that was asked and never answered.
function callIdAllocator() {
  const calls = new Map();
  const results = new Map();
  const next = (counter, name) => {
    const index = counter.get(name) || 0;
    counter.set(name, index + 1);
    return `gemini_${name}_${index}`;
  };
  return {
    forCall: (name, id) => (id ? String(id) : next(calls, name)),
    forResult: (name, id) => (id ? String(id) : next(results, name)),
  };
}

function userParts(parts, items, ids) {
  const content = [];
  for (const part of parts) {
    if (typeof part?.text === "string" && part.text) {
      content.push({ type: "input_text", text: part.text });
      continue;
    }
    if (part?.inlineData) {
      content.push({ type: "input_image", image_url: inlineDataUrl(part.inlineData) });
      continue;
    }
    if (part?.fileData?.fileUri) {
      content.push({ type: "input_image", image_url: String(part.fileData.fileUri) });
      continue;
    }
    if (part?.functionResponse) {
      const name = String(part.functionResponse.name || "");
      items.push({
        type: "function_call_output",
        call_id: ids.forResult(name, part.functionResponse.id),
        output: JSON.stringify(part.functionResponse.response ?? {}),
      });
    }
  }
  if (content.length) items.push({ type: "message", role: "user", content });
}

function modelParts(parts, items, ids) {
  const text = [];
  for (const part of parts) {
    // `thought: true` is the model's own reasoning. Replaying it as an ordinary
    // assistant message would put private reasoning into the visible transcript
    // on every subsequent turn of the conversation.
    if (typeof part?.text === "string" && part.text && !part.thought) {
      text.push(part.text);
      continue;
    }
    if (part?.functionCall) {
      const name = String(part.functionCall.name || "");
      items.push({
        type: "function_call",
        call_id: ids.forCall(name, part.functionCall.id),
        name,
        arguments: JSON.stringify(part.functionCall.args ?? {}),
      });
    }
  }
  if (text.length) {
    items.push({
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text: text.join("\n") }],
    });
  }
}

// A FunctionDeclaration can spell its schema two ways, and the one Gemini CLI
// actually uses is the second: `tools.js` writes `parametersJsonSchema` for
// every built-in tool and validates incoming calls against that same field.
// Reading only `parameters` therefore sent the whole tool set upstream with no
// schema at all -- the model invented argument names, and the CLI rejected each
// call with "params must have required property 'file_path'". The raw JSON
// Schema wins when both are present; `parameters` is the older Schema-proto
// spelling and may be a lossy rendering of it.
function declarationSchema(declaration) {
  if (declaration.parametersJsonSchema) return declaration.parametersJsonSchema;
  if (declaration.parameters) return declaration.parameters;
  // Not omitted: a provider on the chat-completions path rejects a function
  // whose parameters are absent, and "takes no arguments" is a schema.
  return { type: "object", properties: {} };
}

function responsesTools(tools) {
  const declared = [];
  for (const tool of tools || []) {
    for (const declaration of tool?.functionDeclarations || []) {
      if (!declaration?.name) continue;
      const entry = { type: "function", name: String(declaration.name) };
      if (declaration.description) entry.description = String(declaration.description);
      entry.parameters = declarationSchema(declaration);
      declared.push(entry);
    }
  }
  return declared.length ? declared : undefined;
}

function toolChoice(toolConfig) {
  const mode = String(toolConfig?.functionCallingConfig?.mode || "").toUpperCase();
  if (mode === "ANY") return "required";
  if (mode === "NONE") return "none";
  if (mode === "AUTO") return "auto";
  return undefined;
}

// Gemini spends a token budget; Responses picks a rung on a ladder. There is no
// exact correspondence, so the mapping is stated in one place and kept coarse
// rather than spread through the surface as arithmetic nobody can review. A
// negative budget is Gemini's "decide for me", which is what medium means here.
function reasoningEffort(thinkingConfig) {
  if (!thinkingConfig || typeof thinkingConfig !== "object") return undefined;
  const budget = thinkingConfig.thinkingBudget;
  if (!Number.isFinite(budget)) return undefined;
  if (budget === 0) return "minimal";
  if (budget < 0) return "medium";
  if (budget <= 1024) return "low";
  if (budget <= 8192) return "medium";
  return "high";
}

/**
 * Builds the Responses request for one Gemini turn.
 *
 * `instructions` rather than a leading system message on purpose: Responses
 * carries the system prompt out of band, and folding it into the input array
 * puts it in the transcript where tool-result ageing is entitled to drop it.
 */
export function geminiToResponsesPayload({ model, body, stream = false }) {
  const request = body && typeof body === "object" ? body : {};
  const ids = callIdAllocator();
  const items = [];
  const contents = Array.isArray(request.contents)
    ? request.contents
    : request.contents
      ? [request.contents]
      : [];
  for (const content of contents) {
    const parts = Array.isArray(content?.parts) ? content.parts : [];
    if (String(content?.role || "user") === "model") modelParts(parts, items, ids);
    else userParts(parts, items, ids);
  }

  const generation = request.generationConfig || {};
  const payload = { model: String(model), input: items, stream: Boolean(stream) };
  const instructions = textOf(request.systemInstruction);
  if (instructions) payload.instructions = instructions;
  const tools = responsesTools(request.tools);
  if (tools) payload.tools = tools;
  const choice = toolChoice(request.toolConfig);
  if (choice) payload.tool_choice = choice;
  if (Number.isFinite(generation.temperature)) payload.temperature = generation.temperature;
  if (Number.isFinite(generation.topP)) payload.top_p = generation.topP;
  if (Number.isFinite(generation.maxOutputTokens)) {
    payload.max_output_tokens = generation.maxOutputTokens;
  }
  const effort = reasoningEffort(generation.thinkingConfig);
  // Absent, not defaulted: with no thinking config the router applies the
  // model's own request profile, which knows more about that model than a
  // budget the client never sent.
  if (effort) payload.reasoning = { effort };
  return payload;
}

function parseArguments(value) {
  if (typeof value !== "string" || !value) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function functionCallPart(item) {
  const call = { name: String(item?.name || ""), args: parseArguments(item?.arguments) };
  const id = item?.call_id || item?.id;
  return { functionCall: id ? { id: String(id), ...call } : call };
}

function reasoningText(item) {
  const summary = Array.isArray(item?.summary) ? item.summary : [];
  return summary
    .map((entry) => (typeof entry?.text === "string" ? entry.text : ""))
    .filter(Boolean)
    .join("\n");
}

function messageText(item) {
  const content = Array.isArray(item?.content) ? item.content : [];
  return content
    .map((entry) =>
      entry?.type === "output_text" || entry?.type === "text"
        ? String(entry.text || "")
        : "",
    )
    .filter(Boolean)
    .join("");
}

function finishReasonFor(payload) {
  if (payload?.status === "failed" || payload?.error) return "OTHER";
  const reason = payload?.incomplete_details?.reason;
  if (reason === "max_output_tokens") return "MAX_TOKENS";
  if (reason === "content_filter") return "SAFETY";
  if (reason) return "OTHER";
  return "STOP";
}

function usageMetadata(usage) {
  if (!usage || typeof usage !== "object") return undefined;
  const prompt = usage.input_tokens ?? usage.prompt_tokens;
  const output = usage.output_tokens ?? usage.completion_tokens;
  const total = usage.total_tokens ?? (Number(prompt || 0) + Number(output || 0));
  const metadata = {
    promptTokenCount: Number(prompt || 0),
    candidatesTokenCount: Number(output || 0),
    totalTokenCount: Number(total || 0),
  };
  const reasoning = usage.output_tokens_details?.reasoning_tokens;
  if (Number.isFinite(reasoning)) metadata.thoughtsTokenCount = Number(reasoning);
  const cached = usage.input_tokens_details?.cached_tokens;
  if (Number.isFinite(cached)) metadata.cachedContentTokenCount = Number(cached);
  return metadata;
}

/** One non-streaming Responses payload as one Gemini GenerateContentResponse. */
export function responsesPayloadToGemini(payload, { model } = {}) {
  const output = Array.isArray(payload?.output) ? payload.output : [];
  const parts = [];
  for (const item of output) {
    if (item?.type === "reasoning") {
      const text = reasoningText(item);
      if (text) parts.push({ text, thought: true });
      continue;
    }
    if (item?.type === "message") {
      const text = messageText(item);
      if (text) parts.push({ text });
      continue;
    }
    if (item?.type === "function_call") parts.push(functionCallPart(item));
  }
  const response = {
    candidates: [
      {
        content: { role: "model", parts },
        finishReason: finishReasonFor(payload),
        index: 0,
      },
    ],
  };
  const usage = usageMetadata(payload?.usage);
  if (usage) response.usageMetadata = usage;
  const version = payload?.model || model;
  if (version) response.modelVersion = String(version);
  if (payload?.id) response.responseId = String(payload.id);
  return response;
}

function candidateChunk(parts, { model, finishReason, usage, responseId } = {}) {
  const candidate = { content: { role: "model", parts }, index: 0 };
  if (finishReason) candidate.finishReason = finishReason;
  const chunk = { candidates: [candidate] };
  if (usage) chunk.usageMetadata = usage;
  if (model) chunk.modelVersion = String(model);
  if (responseId) chunk.responseId = String(responseId);
  return chunk;
}

/**
 * Converts a Responses event stream into Gemini stream chunks.
 *
 * Each returned object is a whole `GenerateContentResponse`, which is what the
 * SDK's `alt=sse` reader expects in every `data:` frame -- it is not a delta
 * format of its own.
 *
 * `finish()` exists because the SDK waits for a `finishReason` before it
 * considers a turn over. An upstream that drops mid-stream would otherwise
 * leave the CLI holding an open turn until its own timeout expires.
 */
export function createGeminiStreamTranslator({ model } = {}) {
  let finished = false;
  let emittedAnything = false;
  return {
    push(event) {
      const type = event?.type;
      if (type === "response.output_text.delta" && event.delta) {
        emittedAnything = true;
        return [candidateChunk([{ text: String(event.delta) }], { model })];
      }
      if (type === "response.reasoning_summary_text.delta" && event.delta) {
        emittedAnything = true;
        return [candidateChunk([{ text: String(event.delta), thought: true }], { model })];
      }
      // Only on `done`: an added item carries no arguments yet, and emitting it
      // twice makes the CLI run the tool twice.
      if (type === "response.output_item.done" && event.item?.type === "function_call") {
        emittedAnything = true;
        return [candidateChunk([functionCallPart(event.item)], { model })];
      }
      if (
        type === "response.completed" ||
        type === "response.failed" ||
        type === "response.incomplete"
      ) {
        if (finished) return [];
        finished = true;
        const response = event.response || {};
        return [
          candidateChunk([], {
            model: response.model || model,
            finishReason: finishReasonFor(response),
            usage: usageMetadata(response.usage),
            responseId: response.id,
          }),
        ];
      }
      return [];
    },
    finish() {
      if (finished) return [];
      finished = true;
      return [
        candidateChunk([], {
          model,
          finishReason: emittedAnything ? "STOP" : "OTHER",
        }),
      ];
    },
  };
}

/** The routed set as a `models.list` page. */
export function geminiModelListPayload(models) {
  return {
    models: (models || []).map((model) => {
      const window = Number.isInteger(model?.contextWindow) && model.contextWindow > 0
        ? model.contextWindow
        : 131072;
      return {
        name: `models/${model.slug}`,
        displayName: String(model.displayName || model.slug),
        description: "Routed by Codex Router.",
        inputTokenLimit: window,
        outputTokenLimit: window,
        supportedGenerationMethods: [...GEMINI_GENERATION_METHODS],
      };
    }),
  };
}

/**
 * A byte-count estimate for `countTokens`.
 *
 * There is no upstream to ask: the providers behind the router do not all
 * expose a counting endpoint, and spending a real turn to answer a count would
 * bill the user for a question they asked for free. A client that gets no
 * number at all cannot decide whether to compact, so a crude estimate is the
 * better failure -- the same tradeoff `estimateInputTokens` already makes for
 * prompt accounting.
 */
export function estimateGeminiTokens(body) {
  const serialized = JSON.stringify(body?.contents ?? body ?? "");
  const bytes = Buffer.byteLength(serialized === undefined ? "" : serialized, "utf8");
  if (!body || !Array.isArray(body.contents) || !body.contents.length) return 0;
  return Math.ceil(bytes / ESTIMATE_BYTES_PER_TOKEN);
}
