import { estimateInputTokens } from "./response-usage.mjs";
import { extractUpstreamDetail } from "./error-translation.mjs";

// Remote compaction V2 arrives through the ordinary Responses endpoint with a
// terminal `compaction_trigger` item rather than on `/responses/compact`.
export function isRemoteCompactV2Trigger(payload) {
  return (
    Array.isArray(payload?.input) &&
    payload.input.at(-1)?.type === "compaction_trigger"
  );
}

// How far under the route's budget the estimate has to land before the router
// is willing to act on it.
//
// Codex triggers on the token counts its provider reported; this is a
// bytes-over-a-ratio estimate of the same conversation. The two disagreeing is
// not by itself evidence that the trigger was spurious, and the two ways of
// being wrong do not cost the same: `src/response-usage.mjs` is explicit that
// erring high only costs a summary while erring low costs the turn, because a
// compaction that was skipped hands the next turn the whole history for the
// provider to reject. So the skip asks the estimate to clear the budget by
// more than the estimator's own error band instead of merely to sit below it,
// and a conversation anywhere near its limit keeps the summary.
export const COMPACTION_SKIP_HEADROOM = 0.8;

// The estimate has to be taken on the input the provider will actually read.
//
// `estimateInputTokens` discounts `encrypted_content`, which is right for the
// reasoning ciphertext no routed provider can decrypt -- but a compaction
// request's history is mostly the router's own prior checkpoints, which arrive
// in exactly that field and which `normalizeRoutedInput` expands back into
// visible text before the body goes upstream. Estimating the inbound body
// therefore discounts the very bytes the turn is made of: measured on a
// synthetic session holding 1,028,910 tokens of expanded checkpoints against a
// 900,000-token budget, the inbound body estimated at 6,235 tokens and a
// context that was genuinely full read as nearly empty. Callers pass the
// normalized input, so what is counted here is what goes upstream.
//
// Returns the estimate when the trigger can be skipped and undefined when it
// cannot, so a caller that wants to log the number does not estimate twice.
export function skippableCompactionTokens(normalizedInput, route) {
  if (!Array.isArray(normalizedInput)) return undefined;
  if (!Number.isFinite(route?.autoCompact) || route.autoCompact <= 0) return undefined;
  const estimatedTokens = estimateInputTokens(
    Buffer.from(JSON.stringify(normalizedInput), "utf8"),
    { contextWindow: route.contextWindow },
  );
  // `undefined` is the estimator's "too small to matter" floor, not a measured
  // zero. It is never read as evidence that the context is empty.
  if (estimatedTokens === undefined) return undefined;
  return estimatedTokens <= route.autoCompact * COMPACTION_SKIP_HEADROOM
    ? estimatedTokens
    : undefined;
}

const OPAQUE_BAD_REQUEST = /^(?:bad request|invalid request|request rejected)\.?$/i;
const GENERIC_ERROR_TYPE = /^(?:invalid[_ ]request(?:_error)?|bad[_ ]request(?:_error)?)$/i;

function positiveInteger(value) {
  return Number.isInteger(value) && value > 0 ? value : undefined;
}

function hasSpecificErrorMetadata(bodyText) {
  try {
    const parsed = JSON.parse(bodyText);
    const error = parsed?.error && typeof parsed.error === "object" ? parsed.error : parsed;
    const code = typeof error?.code === "string" ? error.code.trim() : "";
    const param = typeof error?.param === "string" ? error.param.trim() : "";
    const type = typeof error?.type === "string" ? error.type.trim() : "";
    return Boolean(code || param || (type && !GENERIC_ERROR_TYPE.test(type)));
  } catch {
    return false;
  }
}

// Native OpenAI traffic normally keeps its upstream errors byte-for-byte. A
// bare 400 such as `{ "detail": "Bad Request" }` carries no cause, though,
// and Codex's WebSocket bridge used to replace it with an even less useful
// local-router sentence. Only enrich that opaque case, and only when the
// request itself independently proves that it has reached the exact
// auto-compaction threshold published in Codex's native model catalog.
// Specific upstream errors remain authoritative and pass through untouched.
export function nativeContextPressureError({
  status,
  bodyText,
  bodyComplete = true,
  payload,
  model,
  compactionRequest = false,
}) {
  if (Number(status) !== 400 || !payload || typeof payload !== "object") return undefined;
  if (!bodyComplete || compactionRequest || isRemoteCompactV2Trigger(payload)) return undefined;
  const detail = extractUpstreamDetail(bodyText).trim();
  if (detail && !OPAQUE_BAD_REQUEST.test(detail)) return undefined;
  if (hasSpecificErrorMetadata(bodyText)) return undefined;

  const contextWindow = positiveInteger(model?.context_window ?? model?.contextWindow);
  const autoCompact = positiveInteger(
    model?.auto_compact_token_limit ?? model?.autoCompact,
  );
  if (!contextWindow || !autoCompact || autoCompact > contextWindow) return undefined;
  const estimate = estimateInputTokens(
    Buffer.from(JSON.stringify(payload), "utf8"),
    { contextWindow },
  );
  if (!Number.isFinite(estimate) || estimate < autoCompact) return undefined;

  const modelName = typeof model?.display_name === "string" && model.display_name
    ? model.display_name
    : typeof model?.slug === "string" && model.slug
      ? model.slug
      : typeof payload.model === "string" && payload.model
        ? payload.model
        : "the selected model";
  return {
    error: {
      type: "invalid_request_error",
      code: "context_compaction_required",
      param: "input",
      message:
        `OpenAI returned an opaque HTTP 400 for ${modelName}. The request is estimated at ` +
        `${estimate.toLocaleString("en-US")} tokens, at or above the model's ` +
        `${autoCompact.toLocaleString("en-US")}-token automatic-compaction limit. ` +
        "Compact the conversation or start a new task, then retry.",
    },
  };
}
