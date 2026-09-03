// OpenCode's anonymous catalog exposes documented free models on Chat
// Completions and one on Responses. Keep this mapping deliberately separate
// from paid Zen and the Go subscription family: those providers have different
// catalogs and billing semantics.
//
// Zen's live /models response publishes ids, `object`, `created`, and
// `owned_by` -- no context limit and no effort control for any model. Without
// documented metadata every free id falls back to the generic 131,072 window
// and a single `high` effort, which compacts every tool-bearing turn on a
// million-token route (#266) and hides an effort ladder the model really has
// (#352).
//
// Everything below comes from OpenCode's own published model metadata (the
// `opencode` provider in https://models.dev/api.json, whose record points at
// https://opencode.ai/zen/v1 and https://opencode.ai/docs/zen). That dataset
// keys `limit` and `reasoning_options` per *free id*, not per model, and
// demonstrably records a smaller window when the free route is capped below
// the paid one -- `deepseek-v4-flash` publishes 1,000,000 while
// `deepseek-v4-flash-free` publishes 200,000, and `minimax-m3` publishes
// 512,000 against `minimax-m3-free`'s 200,000. So a free id's figure describes
// the free route's own served cap.
//
// A documented window is stored only when curation's 0.85 auto-compact ratio
// still leaves at least the id's published `limit.output` in reserve, so
// compaction fires before a completion can overrun the window the entry just
// declared. Where it does not, the id keeps the conservative default and says
// so in its own description rather than declaring a window a full-length
// answer can walk off the end of. Two live free ids are therefore absent from
// this table entirely, because neither their window nor an effort ladder
// survives that test: `mimo-v2.5-free` (200,000 window, 32,000 output, so
// 0.85 leaves 30,000) and `nemotron-3.5-lightning-free` (262,144 window and a
// 262,144 output limit, which no ratio can reserve room for). Both publish an
// empty `reasoning_options`. They keep the stock "conservative default
// metadata" description, which is this repository's existing way of saying
// every value in the entry is a default rather than a documented capability.
//
// Evidence is restated in `descriptions` because that is where this
// repository records metadata that is not a conservative default (see
// config/zai/coding/glm-5.3.json). A future figure in Zen's own /models
// response is still preferred by curate-models, because that one describes the
// served route first-hand.

const UNDOCUMENTED_EFFORTS =
  "OpenCode documents no effort control for this free id -- its `reasoning_options` in " +
  "that record is empty -- so the stored single `high` level is this repository's " +
  "conservative default, not an advertised capability.";

const OPENCODE_FREE_MODELS = Object.freeze({
  "muse-spark-1.2-contributor-free": Object.freeze({
    contextWindow: 1_048_576,
    outputLimit: 131_072,
    reasoningLevels: Object.freeze(["minimal", "low", "medium", "high", "xhigh"]),
    requestProfile: "auto-tool-choice",
    displayName: "Muse Spark 1.2 Contributor Free (OpenCode Free)",
    summary:
      "Muse Spark 1.2 Contributor Free through OpenCode Zen's anonymous Responses route.",
    contextNote:
      "The 1,048,576-token window is OpenCode's own published figure for this exact free id " +
      "(the `opencode` provider in models.dev/api.json), not the paid model's: that dataset " +
      "publishes a smaller window on free ids whose route is capped below their paid twin, " +
      "and this one is not. Zen's /models endpoint publishes no context limits.",
    reasoningNote:
      "The minimal/low/medium/high/xhigh ladder is that same record's `reasoning_options` " +
      "for this free id; Zen's /models endpoint advertises no effort control.",
  }),
  "muse-spark-1.3-contributor-free": Object.freeze({
    contextWindow: 1_048_576,
    outputLimit: 131_072,
    reasoningLevels: Object.freeze(["minimal", "low", "medium", "high", "xhigh"]),
    requestProfile: "auto-tool-choice",
    displayName: "Muse Spark 1.3 Contributor Free (OpenCode Free)",
    summary:
      "Muse Spark 1.3 Contributor Free through OpenCode Zen's anonymous Responses route.",
    contextNote:
      "The 1,048,576-token window is OpenCode's own published figure for this exact free id " +
      "(the `opencode` provider in models.dev/api.json), not the paid model's: that dataset " +
      "publishes a smaller window on free ids whose route is capped below their paid twin, " +
      "and this one is not. Zen's /models endpoint publishes no context limits.",
    reasoningNote:
      "The minimal/low/medium/high/xhigh ladder is that same record's `reasoning_options` " +
      "for this free id; Zen's /models endpoint advertises no effort control.",
  }),
  "nemotron-3-ultra-free": Object.freeze({
    contextWindow: 1_000_000,
    outputLimit: 128_000,
    summary: "Nemotron 3 Ultra Free through OpenCode Zen's anonymous Chat Completions route.",
    contextNote:
      "The 1,000,000-token window is OpenCode's own published figure for this exact free id " +
      "(the `opencode` provider in models.dev/api.json); the catalog carries no paid Nemotron " +
      "entry for a model-level number to have been copied from, and it publishes a smaller " +
      "window on free ids whose route is capped lower. Zen's /models endpoint publishes no " +
      "context limits.",
    reasoningNote: UNDOCUMENTED_EFFORTS,
  }),
  "laguna-s-2.1-free": Object.freeze({
    contextWindow: 256_000,
    outputLimit: 32_000,
    reasoningLevels: Object.freeze(["low", "medium", "high"]),
    summary: "Laguna S 2.1 Free through OpenCode Zen's anonymous Chat Completions route.",
    contextNote:
      "The 256,000-token window is OpenCode's own published figure for this exact free id " +
      "(the `opencode` provider in models.dev/api.json); the catalog carries no paid Laguna " +
      "entry for a model-level number to have been copied from, and it publishes a smaller " +
      "window on free ids whose route is capped lower. Zen's /models endpoint publishes no " +
      "context limits.",
    reasoningNote:
      "The low/medium/high ladder is that same record's `reasoning_options` for this free id; " +
      "Zen's /models endpoint advertises no effort control.",
  }),
  // Window deliberately withheld: documented, but not safely declarable.
  "deepseek-v4-flash-free": Object.freeze({
    outputLimit: 128_000,
    reasoningLevels: Object.freeze(["low", "high", "max"]),
    summary: "DeepSeek V4 Flash Free through OpenCode Zen's anonymous Chat Completions route.",
    contextNote:
      "The context window is unknown here and stays on the conservative default. models.dev " +
      "does publish 200,000 for this free id (throttled from the paid `deepseek-v4-flash`'s " +
      "1,000,000), but curation's 0.85 auto-compact ratio would leave only 30,000 tokens " +
      "against the same record's 128,000-token output limit, so declaring 200,000 would let a " +
      "full-length completion overrun the window the entry just declared.",
    reasoningNote:
      "The low/high/max ladder is that same record's `reasoning_options` for this free id; " +
      "Zen's /models endpoint advertises no effort control.",
  }),
  "hy3-free": Object.freeze({
    outputLimit: 64_000,
    reasoningLevels: Object.freeze(["low", "medium", "high"]),
    summary: "Hy3 Free through OpenCode Zen's anonymous Chat Completions route.",
    contextNote:
      "The context window is unknown here and stays on the conservative default. models.dev " +
      "does publish 190,000 for this free id, but curation's 0.85 auto-compact ratio would " +
      "leave only 28,500 tokens against the same record's 64,000-token output limit, so " +
      "declaring 190,000 would let a full-length completion overrun the window the entry just " +
      "declared.",
    reasoningNote:
      "The low/medium/high ladder is that same record's `reasoning_options` for this free id; " +
      "Zen's /models endpoint advertises no effort control.",
  }),
});

const CURATION_ROUTES = Object.freeze({
  "chatgpt-web": Object.freeze({
    providers: Object.freeze(["chatgpt-web"]),
    protocols: Object.freeze(["Responses"]),
    messagesModels: Object.freeze([]),
    responsesModels: Object.freeze([]),
    primaryModels: Object.freeze([
      "chatgpt-web/luna",
      "chatgpt-web/think",
      "chatgpt-web/light",
      "chatgpt-web/medium",
      "chatgpt-web/high",
      "chatgpt-web/extra-high",
      "chatgpt-web/pro",
    ]),
    models: Object.freeze({
      "chatgpt-web/luna": Object.freeze({
        reasoningLevels: Object.freeze(["low"]),
        summary: "ChatGPT Web Luna through the account-bound local browser bridge.",
      }),
      "chatgpt-web/think": Object.freeze({
        reasoningLevels: Object.freeze(["low"]),
        summary: "ChatGPT Web Think through the account-bound local browser bridge.",
      }),
      "chatgpt-web/light": Object.freeze({
        reasoningLevels: Object.freeze(["low"]),
        summary: "ChatGPT Web Instant through the account-bound local browser bridge.",
      }),
      "chatgpt-web/medium": Object.freeze({
        reasoningLevels: Object.freeze(["medium"]),
        summary: "ChatGPT Web Medium through the account-bound local browser bridge.",
      }),
      "chatgpt-web/high": Object.freeze({
        reasoningLevels: Object.freeze(["high"]),
        summary: "ChatGPT Web High through the account-bound local browser bridge.",
      }),
      "chatgpt-web/extra-high": Object.freeze({
        reasoningLevels: Object.freeze(["xhigh"]),
        summary: "ChatGPT Web Extra High through the account-bound local browser bridge.",
      }),
      "chatgpt-web/pro": Object.freeze({
        reasoningLevels: Object.freeze(["ultra"]),
        summary: "ChatGPT Web Pro through the account-bound local browser bridge.",
      }),
    }),
  }),
  "commandcode": Object.freeze({
    providers: Object.freeze(["commandcode", "commandcode-messages"]),
    protocols: Object.freeze(["Chat", "Messages"]),
    messagesProvider: "commandcode-messages",
    messagesModels: Object.freeze([
      "claude-fable-5",
      "claude-fable-5-1",
      "claude-haiku-4-5-20251001",
      "claude-opus-4-8",
      "claude-opus-5",
      "claude-sonnet-5",
    ]),
    responsesModels: Object.freeze([]),
    primaryModels: Object.freeze([
      "MiniMaxAI/MiniMax-M2.7",
      "MiniMaxAI/MiniMax-M3",
      "Qwen/Qwen3.7-Flash",
      "Qwen/Qwen3.7-Max",
      "Qwen/Qwen3.7-Plus",
      "Qwen/Qwen3.8-Flash",
      "Qwen/Qwen3.8-Max",
      "Qwen/Qwen3.8-Max-0902",
      "deepseek/deepseek-v4-flash",
      "deepseek/deepseek-v4-pro",
      "google/gemini-3.5-flash",
      "google/gemini-3.7-flash",
      "google/gemini-3.8-flash",
      "gpt-5.5",
      "gpt-5.6-luna",
      "gpt-5.6-sol",
      "gpt-5.6-terra",
      "meta/muse-spark-1.2",
      "moonshotai/Kimi-K2.7-Code",
      "moonshotai/Kimi-K2.7-Code-Highspeed",
      "moonshotai/Kimi-K3",
      "nvidia/nemotron-3-ultra-550b-a55b",
      "poolside/laguna-s-2.1-free",
      "sakana/fugu-ultra",
      "stealth/ox-alpha",
      "stepfun/Step-3.7-Flash",
      "tencent/hy3-paid",
      "tencent/hy4-preview",
      "thinkingmachines/inkling",
      "thinkingmachines/inkling-small",
      "xai/grok-4.5",
      "xai/grok-4.6",
      "xiaomi/mimo-v2.5-pro",
      "z-ai/glm-5.3-flash",
      "zai-org/GLM-5.2",
      "zai-org/GLM-5.2-Fast",
      "zai-org/GLM-5.3",
    ]),
    models: Object.freeze({}),
  }),
  "opencode-go": Object.freeze({
    providers: Object.freeze([
      "opencode-go",
      "opencode-go-messages",
      "opencode-go-responses",
    ]),
    protocols: Object.freeze(["Chat", "Messages", "Responses"]),
    messagesProvider: "opencode-go-messages",
    messagesModels: Object.freeze([
      "minimax-m2.5",
      "minimax-m2.7",
      "minimax-m3",
      "qwen3.6-plus",
      "qwen3.7-max",
      "qwen3.7-plus",
      "qwen3.8-flash",
      "qwen3.8-max",
    ]),
    responsesProvider: "opencode-go-responses",
    responsesModels: Object.freeze([
      "gpt-5.6-luna",
      "grok-4.5",
      "grok-4.6",
      "muse-spark-1.2-contributor",
      "muse-spark-1.3-contributor",
    ]),
    primaryModels: Object.freeze([
      "deepseek-v4-flash",
      "deepseek-v4-flash-vision-exp",
      "deepseek-v4-pro",
      "glm-5",
      "glm-5.1",
      "glm-5.2",
      "glm-5.3",
      "glm-5.3-flash",
      "hy3",
      "hy4-preview",
      "kimi-k2.5",
      "kimi-k2.6",
      "kimi-k2.7-code",
      "kimi-k3",
      "longcat-2.0",
      "mimo-v2.5",
      "mimo-v2.5-pro",
      "qwen3.5-plus",
      "x-preview-f",
    ]),
    models: Object.freeze({}),
  }),
  "opencode-free": Object.freeze({
    providers: Object.freeze(["opencode-free", "opencode-free-responses"]),
    protocols: Object.freeze(["Chat", "Responses"]),
    responsesProvider: "opencode-free-responses",
    responsesModels: Object.freeze([
      "muse-spark-1.2-contributor-free",
      "muse-spark-1.3-contributor-free",
    ]),
    primaryModels: Object.freeze([
      "big-pickle",
      "deepseek-v4-flash-free",
      "hy3-free",
      "laguna-s-2.1-free",
      "mimo-v2.5-free",
      "nemotron-3-ultra-free",
      "nemotron-3.5-lightning-free",
    ]),
    models: OPENCODE_FREE_MODELS,
  }),
});

const PRIMARY_BY_PROVIDER = new Map(
  Object.entries(CURATION_ROUTES).flatMap(([primary, route]) =>
    route.providers.map((provider) => [provider, primary]),
  ),
);

export function curationPrimaryProviderId(providerId) {
  return PRIMARY_BY_PROVIDER.get(providerId) || providerId;
}

export function curationProviderIds(providerId) {
  const primary = curationPrimaryProviderId(providerId);
  return [...(CURATION_ROUTES[primary]?.providers || [primary])];
}

function curatedModelRouteSelection(providerId, upstreamModel, { existingProvider } = {}) {
  const primary = curationPrimaryProviderId(providerId);
  const route = CURATION_ROUTES[primary];
  if (route?.responsesModels.includes(upstreamModel)) {
    return { providerId: route.responsesProvider };
  }
  if (route?.messagesModels?.includes(upstreamModel)) {
    return { providerId: route.messagesProvider };
  }
  if (route?.primaryModels?.includes(upstreamModel)) return { providerId: primary };
  if (route?.providers.length > 1) {
    // Preserve a route the operator already chose, but never invent a protocol
    // for a newly discovered id. OpenCode's one /models catalog backs Chat,
    // Messages, and Responses; the payload does not say which wire contract a
    // new id accepts, and guessing Chat makes a picker entry that can fail on
    // its very first request.
    if (existingProvider && route.providers.includes(existingProvider)) {
      return { providerId: existingProvider };
    }
    const protocols = route.protocols || ["API"];
    const protocolList = protocols.length === 1
      ? protocols[0]
      : `${protocols.slice(0, -1).join(", ")}${
        protocols.length > 2 ? "," : ""
      } or ${protocols.at(-1)}`;
    return {
      blockedReason:
        `The provider catalog lists ${upstreamModel}. `
        + `This Codex Router version has not verified whether the model uses ${protocolList}, `
        + `so it cannot be added safely. This is a router compatibility limitation; `
        + `a future update can enable it after testing.`,
    };
  }
  return { providerId: primary };
}

// Discovery and UI surfaces need the same fail-closed protocol verdict as the
// curation write path, but a disabled candidate is ordinary control data rather
// than an exception. Undefined means the model has a settled route.
export function curatedModelBlockReason(providerId, upstreamModel, options = {}) {
  return curatedModelRouteSelection(providerId, upstreamModel, options).blockedReason;
}

export function curatedModelProviderId(providerId, upstreamModel, options = {}) {
  const selection = curatedModelRouteSelection(providerId, upstreamModel, options);
  if (selection.blockedReason) throw new Error(selection.blockedReason);
  return selection.providerId;
}

function curatedModelRecord(providerId, upstreamModel) {
  const primary = curationPrimaryProviderId(providerId);
  return CURATION_ROUTES[primary]?.models?.[upstreamModel];
}

export function curatedModelContextLength(providerId, upstreamModel) {
  return curatedModelRecord(providerId, upstreamModel)?.contextWindow;
}

// The output limit OpenCode publishes for this id. Exported so the safety
// margin behind a declared window is checkable rather than a claim in a
// comment: auto-compaction has to fire while at least this many tokens are
// still free, or a full-length completion runs past the declared window.
export function curatedModelOutputLimit(providerId, upstreamModel) {
  return curatedModelRecord(providerId, upstreamModel)?.outputLimit;
}

// The documented effort ladder for an id, or undefined when OpenCode publishes
// none. Curation turns this into `reasoningLevels`; an id without one keeps
// the single `high` default rather than inventing levels the route may reject.
export function curatedModelReasoningLevels(providerId, upstreamModel) {
  const levels = curatedModelRecord(providerId, upstreamModel)?.reasoningLevels;
  return levels ? [...levels] : undefined;
}

// A documented, model-specific wire repair for curated routes. This is kept
// beside the same exact-id metadata as context and effort because applying it
// provider-wide would weaken forced tool choices for unrelated models.
export function curatedModelRequestProfile(providerId, upstreamModel) {
  return curatedModelRecord(providerId, upstreamModel)?.requestProfile;
}

// A stable picker label for ids whose upstream name is opaque. Curation reads
// this when building user-model entries, and the registry applies it to
// existing curated rows that still carry the generic "(curated)" fallback.
export function curatedModelDisplayName(providerId, upstreamModel) {
  return curatedModelRecord(providerId, upstreamModel)?.displayName;
}

// The picker text that carries the sourcing for every value this module knows
// about -- and, just as importantly, names the capabilities it does not know,
// so a reader can tell a documented value from a conservative default without
// leaving the entry. Undefined for an id this module documents nothing for;
// that entry keeps the generic "conservative default metadata" description,
// which already means every value in it is a default.
// A clause is omitted when the stored value did not come from this module --
// a window the provider's live catalog advertised, or a ladder the operator
// set with --efforts. The note has to describe what the entry actually holds.
export function curatedModelDescription(
  providerId,
  upstreamModel,
  { omitContextNote = false, omitReasoningNote = false } = {},
) {
  const record = curatedModelRecord(providerId, upstreamModel);
  if (!record) return undefined;
  return [
    record.summary,
    omitContextNote ? undefined : record.contextNote,
    omitReasoningNote ? undefined : record.reasoningNote,
  ]
    .filter(Boolean)
    .join(" ");
}

// Every id this module carries metadata for. Tests enumerate it to prove each
// declared window keeps its output limit in reserve.
export function curatedModelIds(providerId) {
  const primary = curationPrimaryProviderId(providerId);
  return Object.keys(CURATION_ROUTES[primary]?.models || {});
}
