// Rewrites gateway error bodies before they reach Codex. LiteLLM reports
// failures as a chain of internal exception names plus routing metadata
// ("litellm.ServiceUnavailableError: ... Received Model Group=..."), which
// reads like a router bug. These helpers name the provider that actually
// failed and keep only the innermost upstream message as detail.

const DETAIL_LIMIT = 300;

// LiteLLM appends its routing state after the upstream message; neither line
// helps the caller and both leak internal gateway naming.
const ROUTING_NOISE = [
  /\.?\s*Received Model Group=[\s\S]*$/,
  /\s*Available Model Group Fallbacks=[\s\S]*$/,
];

// Wrapper prefixes stack recursively (litellm.XError: XError: OpenAIException - ...),
// so stripping repeats until the message stops changing.
const WRAPPER_PREFIXES = [
  /^litellm\.[A-Za-z]+:\s*/,
  /^[A-Za-z]+Error:\s*/,
  /^[A-Za-z]+Exception\s*-\s*/,
];

// Providers disagree on where the human-readable message lives: OpenAI-style
// error.message, bare error strings, top-level message (Alibaba), FastAPI
// detail, or MiniMax's base_resp.status_msg. The type-ish field (OpenAI type,
// Google status) rides along for quota classification.
function parseUpstreamError(bodyText) {
  if (typeof bodyText !== "string" || !bodyText) return { message: "", type: undefined };
  try {
    const parsed = JSON.parse(bodyText);
    const error = parsed?.error;
    const message =
      (typeof error === "string" && error) ||
      (typeof error?.message === "string" && error.message) ||
      (typeof parsed?.base_resp?.status_msg === "string" && parsed.base_resp.status_msg) ||
      (typeof parsed?.message === "string" && parsed.message) ||
      (typeof parsed?.detail === "string" && parsed.detail) ||
      bodyText;
    const type = [error?.type, error?.status].find((value) => typeof value === "string");
    return { message, type };
  } catch {
    // Non-JSON bodies (HTML gateway pages, plain text) pass through as-is.
    return { message: bodyText, type: undefined };
  }
}

export function extractUpstreamDetail(bodyText) {
  let message = parseUpstreamError(bodyText).message;
  for (const pattern of ROUTING_NOISE) message = message.replace(pattern, "");
  let previous;
  do {
    previous = message;
    for (const pattern of WRAPPER_PREFIXES) message = message.replace(pattern, "");
  } while (message !== previous);
  message = message.trim();
  return message.length > DETAIL_LIMIT ? message.slice(0, DETAIL_LIMIT) : message;
}

// Providers report exhausted usage under many statuses (OpenAI 429
// insufficient_quota, DeepSeek 402, xAI 403, Anthropic 400), so the body has
// to be checked before the status mapping — a quota 429 must not advise
// "retry", and a no-credits 403 must not blame credentials.
const QUOTA_PATTERNS = [
  /insufficient[_\s]quota/i,
  /exceeded your current quota/i,
  /insufficient (?:balance|credits?)/i,
  /credit balance is too low/i,
  /(?:no|any|out of) credits/i,
  // Both word orders occur in the wild: "usage limit reached" (zai) and
  // "reached your usage limit" (Kimi).
  /usage limit(?:s)? (?:reached|exceeded|hit)/i,
  /reached your (?:usage|monthly|daily) limit/i,
  /(?:monthly|daily|plan) usage limit/i,
  /purchase extra usage/i,
  /upgrade your plan/i,
  /quota\b[^.]*\bexhausted/i,
  /quota (?:exceeded|exhausted|will be refreshed)/i,
  /\barrears\b/i,
  /balance (?:is )?(?:too low|not enough|insufficient)/i,
  // Chinese-market providers (Alibaba, SiliconFlow, zai, Moonshot) report
  // exhausted balance or quota in Chinese.
  /余额不足/,
  /欠费/,
  /额度(?:不足|已用完)/,
];

// A plan that never included this API is not a rejected credential and not an
// exhausted balance: nothing the operator does with keys or top-ups changes it.
// Command Code answers a Go-plan key with "Your Go plan doesn't include API
// access. Upgrade to Provider or higher", which read as bad credentials and
// sent people back through setup.
const ENTITLEMENT_PATTERNS = [
  /plan does(?:n't| not) include/i,
  /not included (?:in|with) your .{0,40}plan/i,
  /upgrade to [\w\s]{1,30}(?:or higher|plan)/i,
  /requires? (?:the |a |an )?[\w\s]{1,30}plan/i,
  /plan does(?:n't| not) support/i,
  /no api access/i,
];

function isPlanEntitlement(detail) {
  return ENTITLEMENT_PATTERNS.some((pattern) => pattern.test(detail));
}

function isOutOfUsage(detail, errorType) {
  if (typeof errorType === "string" && /quota|billing|resource_exhausted/i.test(errorType)) {
    return true;
  }
  return QUOTA_PATTERNS.some((pattern) => pattern.test(detail));
}

// The same two questions `describeFailure` asks, in the same order, answered for
// a caller that needs to *act* on the distinction rather than word it. Exported
// as one function rather than as the two predicates, because the order is the
// load-bearing part: "upgrade your plan" appears in both pattern sets, so a
// caller that asked about quota first would read a permanent entitlement failure
// as an exhausted balance. Keeping the ordering here means there is one place it
// can be got right.
//
// Returns "entitlement" (a plan that never included this API -- nothing the
// operator does with keys or top-ups changes it), "out_of_usage" (an exhausted
// balance or plan limit, which time or a top-up fixes), or undefined for
// everything else, including every 5xx: the origin ran, and what it said about
// quota is not evidence about the caller's.
export function upstreamFailureKind({ status, bodyText }) {
  if (!(Number(status) < 500)) return undefined;
  const detail = extractUpstreamDetail(bodyText);
  if (isPlanEntitlement(detail)) return "entitlement";
  if (isOutOfUsage(detail, parseUpstreamError(bodyText).type)) return "out_of_usage";
  return undefined;
}

function describeFailure({
  status,
  detail,
  errorType,
  modelName,
  providerName,
  providerKind,
  retryAfterSeconds,
}) {
  // Ahead of both the quota and the credential branches: an entitlement
  // failure is the only one of the three that neither a top-up nor a new key
  // can resolve, and its wording overlaps with both.
  if (status < 500 && isPlanEntitlement(detail)) {
    return {
      type: "billing_error",
      message: `${providerName} accepted the credential, but this plan does not include the API that serves ${modelName}. Upgrade the plan on your ${providerName} account; re-entering or refreshing the credential will not help.`,
    };
  }
  if (status < 500 && isOutOfUsage(detail, errorType)) {
    return {
      type: "billing_error",
      message: `You have run out of usage at ${providerName} for ${modelName}. Top up or check the plan on your ${providerName} account.`,
    };
  }
  if (status === 401 || status === 403) {
    // OAuth sessions are repaired by signing in again, not by re-entering an
    // API key through setup — the wrong advice would send users in circles.
    if (providerKind === "oauth") {
      return {
        type: "authentication_error",
        message: `${providerName} rejected the OAuth session while serving ${modelName}. Sign in to ${providerName} again.`,
      };
    }
    return {
      type: "authentication_error",
      message: `${providerName} rejected the stored credentials while serving ${modelName}. Re-run codex-router setup to refresh them.`,
    };
  }
  if (status === 402) {
    return {
      type: "billing_error",
      message: `${providerName} reports a billing or quota problem for ${modelName}. Check the plan on your ${providerName} account.`,
    };
  }
  if (status === 404) {
    return {
      type: "invalid_request_error",
      message: `${providerName} no longer recognizes the upstream model behind ${modelName}. It may have been renamed or removed.`,
    };
  }
  if (status === 429) {
    const hint = Number.isFinite(retryAfterSeconds)
      ? `Retry in about ${retryAfterSeconds}s.`
      : "Wait a bit and retry.";
    return {
      type: "rate_limit_error",
      message: `${providerName} is rate-limiting ${modelName}. ${hint}`,
    };
  }
  if (status >= 500) {
    return {
      type: "server_error",
      message: `Something is wrong at ${providerName}: ${modelName} is unavailable right now. Retry in a few minutes or switch models.`,
    };
  }
  return {
    type: "invalid_request_error",
    message: `${providerName} rejected the request for ${modelName}.`,
  };
}

export function translateGatewayError({
  status,
  bodyText,
  modelName,
  providerName,
  providerKind,
  retryAfterSeconds,
}) {
  const detail = extractUpstreamDetail(bodyText);
  const failure = describeFailure({
    status,
    detail,
    errorType: parseUpstreamError(bodyText).type,
    modelName,
    providerName,
    providerKind,
    retryAfterSeconds,
  });
  const suffix = detail ? ` (HTTP ${status}: ${detail})` : ` (HTTP ${status})`;
  return {
    error: {
      message: `${failure.message}${suffix}`,
      type: failure.type,
      param: null,
      code: String(status),
    },
  };
}
