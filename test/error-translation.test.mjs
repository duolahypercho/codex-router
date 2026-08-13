import assert from "node:assert/strict";
import test from "node:test";

import {
  extractUpstreamDetail,
  translateGatewayError,
} from "../src/error-translation.mjs";

const LITELLM_503_BODY = JSON.stringify({
  error: {
    message:
      "litellm.ServiceUnavailableError: ServiceUnavailableError: OpenAIException - Upstream request failed: Endpoint is unavailable.. Received Model Group=opencode-go-grok-4-5\nAvailable Model Group Fallbacks=None",
    type: null,
    param: null,
    code: "503",
  },
});

test("extractUpstreamDetail strips LiteLLM wrappers and routing noise", () => {
  const detail = extractUpstreamDetail(LITELLM_503_BODY);
  assert.equal(detail, "Upstream request failed: Endpoint is unavailable.");
});

test("extractUpstreamDetail handles a bare string error field", () => {
  const detail = extractUpstreamDetail(JSON.stringify({ error: "quota exceeded" }));
  assert.equal(detail, "quota exceeded");
});

test("extractUpstreamDetail falls back to truncated raw text for non-JSON bodies", () => {
  const detail = extractUpstreamDetail(`<html>${"x".repeat(500)}</html>`);
  assert.ok(detail.length <= 300);
  assert.ok(detail.startsWith("<html>"));
});

test("extractUpstreamDetail returns empty string for empty bodies", () => {
  assert.equal(extractUpstreamDetail(""), "");
  assert.equal(extractUpstreamDetail(undefined), "");
});

test("a 5xx names the provider and keeps the upstream detail", () => {
  const payload = translateGatewayError({
    status: 503,
    bodyText: LITELLM_503_BODY,
    modelName: "Grok 4.5 (opencode Go)",
    providerName: "opencode",
  });
  assert.equal(
    payload.error.message,
    "Something is wrong at opencode: Grok 4.5 (opencode Go) is unavailable right now. Retry in a few minutes or switch models. (HTTP 503: Upstream request failed: Endpoint is unavailable.)",
  );
  assert.equal(payload.error.type, "server_error");
  assert.equal(payload.error.code, "503");
  assert.ok(!payload.error.message.includes("litellm"));
  assert.ok(!payload.error.message.includes("Model Group"));
});

test("a 429 mentions rate limiting and the retry hint", () => {
  const payload = translateGatewayError({
    status: 429,
    bodyText: JSON.stringify({ error: { message: "rate limited" } }),
    modelName: "Kimi K3",
    providerName: "kimi",
    retryAfterSeconds: 30,
  });
  assert.equal(
    payload.error.message,
    "kimi is rate-limiting Kimi K3. Retry in about 30s. (HTTP 429: rate limited)",
  );
  assert.equal(payload.error.type, "rate_limit_error");
});

test("a 429 without retry-after still reads cleanly", () => {
  const payload = translateGatewayError({
    status: 429,
    bodyText: "",
    modelName: "Kimi K3",
    providerName: "kimi",
  });
  assert.equal(
    payload.error.message,
    "kimi is rate-limiting Kimi K3. Wait a bit and retry. (HTTP 429)",
  );
});

test("a 401 points at credentials and setup", () => {
  const payload = translateGatewayError({
    status: 401,
    bodyText: JSON.stringify({ error: { message: "invalid api key" } }),
    modelName: "DeepSeek V4 Pro",
    providerName: "deepseek",
  });
  assert.equal(
    payload.error.message,
    "deepseek rejected the stored credentials while serving DeepSeek V4 Pro. Re-run codex-router setup to refresh them. (HTTP 401: invalid api key)",
  );
  assert.equal(payload.error.type, "authentication_error");
});

test("a 401 from an OAuth provider says sign in again, not re-run setup", () => {
  const payload = translateGatewayError({
    status: 401,
    bodyText: JSON.stringify({
      error: {
        message: "Kimi OAuth was rejected; run `kimi login` again.",
        type: "authentication_error",
      },
    }),
    modelName: "Kimi K3",
    providerName: "kimi",
    providerKind: "oauth",
  });
  assert.equal(
    payload.error.message,
    "kimi rejected the OAuth session while serving Kimi K3. Sign in to kimi again. (HTTP 401: Kimi OAuth was rejected; run `kimi login` again.)",
  );
  assert.equal(payload.error.type, "authentication_error");
  assert.ok(!payload.error.message.includes("codex-router setup"));
});

// Captured from a live Kimi OAuth 403: an exhausted plan arrives on the same
// status as a rejected session, so the body has to win. Telling the user to
// sign in again would send them through a login that cannot fix anything.
test("an OAuth 403 whose body reports an exhausted plan is out-of-usage, not a sign-in prompt", () => {
  const payload = translateGatewayError({
    status: 403,
    bodyText: JSON.stringify({
      error: {
        message:
          "You've reached your usage limit for this billing cycle. Your quota will be refreshed in the next cycle. To continue now, purchase extra usage or upgrade your plan: https://www.kimi.com/code/#pricing",
      },
    }),
    modelName: "Kimi K3 (OAuth)",
    providerName: "kimi",
    providerKind: "oauth",
  });
  assert.equal(payload.error.type, "billing_error");
  assert.ok(payload.error.message.startsWith("You have run out of usage at kimi"));
  assert.ok(!payload.error.message.includes("Sign in"));
});

test("a usage-limit body in either word order is out-of-usage", () => {
  for (const message of [
    "Usage limit reached for this billing period.",
    "You have reached your usage limit.",
    "Monthly usage limit exceeded.",
  ]) {
    const payload = translateGatewayError({
      status: 429,
      bodyText: JSON.stringify({ error: { message } }),
      modelName: "Test Model",
      providerName: "testprovider",
    });
    assert.equal(payload.error.type, "billing_error", `not classified: ${message}`);
  }
});

test("a 403 from an OAuth provider also asks for a fresh sign-in", () => {
  const payload = translateGatewayError({
    status: 403,
    bodyText: "",
    modelName: "Grok 4.5 (OAuth)",
    providerName: "xai",
    providerKind: "oauth",
  });
  assert.equal(
    payload.error.message,
    "xai rejected the OAuth session while serving Grok 4.5 (OAuth). Sign in to xai again. (HTTP 403)",
  );
  assert.equal(payload.error.type, "authentication_error");
});

test("a 402 points at billing", () => {
  const payload = translateGatewayError({
    status: 402,
    bodyText: "",
    modelName: "GLM 5.2",
    providerName: "zai",
  });
  assert.equal(
    payload.error.message,
    "zai reports a billing or quota problem for GLM 5.2. Check the plan on your zai account. (HTTP 402)",
  );
  assert.equal(payload.error.type, "billing_error");
});

test("a 404 explains the upstream model is gone", () => {
  const payload = translateGatewayError({
    status: 404,
    bodyText: "",
    modelName: "Grok 4.5 (opencode Go)",
    providerName: "opencode",
  });
  assert.equal(
    payload.error.message,
    "opencode no longer recognizes the upstream model behind Grok 4.5 (opencode Go). It may have been renamed or removed. (HTTP 404)",
  );
  assert.equal(payload.error.type, "invalid_request_error");
});

test("a 429 whose body says quota is exhausted becomes an out-of-usage error, not a retry hint", () => {
  const payload = translateGatewayError({
    status: 429,
    bodyText: JSON.stringify({
      error: {
        message:
          "You exceeded your current quota, please check your plan and billing details.",
        type: "insufficient_quota",
      },
    }),
    modelName: "GPT 5.6 Luna (opencode)",
    providerName: "opencode",
  });
  assert.equal(
    payload.error.message,
    "You have run out of usage at opencode for GPT 5.6 Luna (opencode). Top up or check the plan on your opencode account. (HTTP 429: You exceeded your current quota, please check your plan and billing details.)",
  );
  assert.equal(payload.error.type, "billing_error");
  assert.ok(!payload.error.message.includes("Wait a bit"));
});

test("a 402 insufficient-balance body becomes an out-of-usage error", () => {
  const payload = translateGatewayError({
    status: 402,
    bodyText: JSON.stringify({ error: { message: "Insufficient Balance" } }),
    modelName: "DeepSeek V4 Pro",
    providerName: "deepseek",
  });
  assert.equal(
    payload.error.message,
    "You have run out of usage at deepseek for DeepSeek V4 Pro. Top up or check the plan on your deepseek account. (HTTP 402: Insufficient Balance)",
  );
  assert.equal(payload.error.type, "billing_error");
});

test("a 403 about missing credits is out-of-usage, not a credential error", () => {
  const payload = translateGatewayError({
    status: 403,
    bodyText: JSON.stringify({
      error: { message: "Your team does not have any credits to make this request." },
    }),
    modelName: "Grok 4.5",
    providerName: "xai",
  });
  assert.equal(payload.error.type, "billing_error");
  assert.ok(payload.error.message.startsWith("You have run out of usage at xai"));
  assert.ok(!payload.error.message.includes("credentials"));
});

test("a low credit balance body is out-of-usage even on a 400", () => {
  const payload = translateGatewayError({
    status: 400,
    bodyText: JSON.stringify({
      error: {
        message:
          "Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.",
      },
    }),
    modelName: "Claude Fable 5",
    providerName: "anthropic",
  });
  assert.equal(payload.error.type, "billing_error");
  assert.ok(payload.error.message.startsWith("You have run out of usage at anthropic"));
});

test("a usage-limit-reached body on a subscription plan is out-of-usage", () => {
  const payload = translateGatewayError({
    status: 429,
    bodyText: JSON.stringify({
      error: { message: "Usage limit reached for this billing period." },
    }),
    modelName: "GLM 5.2",
    providerName: "zai",
  });
  assert.equal(payload.error.type, "billing_error");
  assert.ok(payload.error.message.startsWith("You have run out of usage at zai"));
});

test("OpenRouter-style insufficient credits is out-of-usage", () => {
  const payload = translateGatewayError({
    status: 402,
    bodyText: JSON.stringify({
      error: { message: "Insufficient credits. Add more using https://openrouter.ai/credits" },
    }),
    modelName: "GLM 5.2 (OpenRouter)",
    providerName: "openrouter",
  });
  assert.equal(payload.error.type, "billing_error");
  assert.ok(payload.error.message.startsWith("You have run out of usage at openrouter"));
});

test("Google-style RESOURCE_EXHAUSTED status is out-of-usage", () => {
  const payload = translateGatewayError({
    status: 429,
    bodyText: JSON.stringify({
      error: {
        message: "Quota metric exhausted for generate_content_free_tier_requests.",
        status: "RESOURCE_EXHAUSTED",
      },
    }),
    modelName: "Gemini 3.1 Pro",
    providerName: "google",
  });
  assert.equal(payload.error.type, "billing_error");
  assert.ok(payload.error.message.startsWith("You have run out of usage at google"));
});

test("Moonshot-style account in arrears is out-of-usage", () => {
  const payload = translateGatewayError({
    status: 429,
    bodyText: JSON.stringify({
      error: { message: "Your account is in arrears, please top up.", type: "exceeded_current_query_capacity_error" },
    }),
    modelName: "Kimi K3 (API)",
    providerName: "kimi",
  });
  assert.equal(payload.error.type, "billing_error");
  assert.ok(payload.error.message.startsWith("You have run out of usage at kimi"));
});

test("a Chinese insufficient-balance body is out-of-usage", () => {
  const payload = translateGatewayError({
    status: 403,
    bodyText: JSON.stringify({ message: "账户余额不足，请充值", code: 30011 }),
    modelName: "Qwen 3.8 Max",
    providerName: "alibaba",
  });
  assert.equal(payload.error.type, "billing_error");
  assert.ok(payload.error.message.startsWith("You have run out of usage at alibaba"));
});

test("a MiniMax base_resp error body is readable and classified", () => {
  const payload = translateGatewayError({
    status: 429,
    bodyText: JSON.stringify({
      base_resp: { status_code: 1008, status_msg: "insufficient balance" },
    }),
    modelName: "MiniMax M3",
    providerName: "minimax",
  });
  assert.equal(payload.error.type, "billing_error");
  assert.ok(payload.error.message.includes("(HTTP 429: insufficient balance)"));
});

test("a top-level detail field (FastAPI style) is used as the detail", () => {
  const payload = translateGatewayError({
    status: 503,
    bodyText: JSON.stringify({ detail: "model is overloaded" }),
    modelName: "HY3 (opencode Go)",
    providerName: "opencode",
  });
  assert.ok(payload.error.message.includes("(HTTP 503: model is overloaded)"));
});

test("a plain rate-limit 429 still gets the retry hint, not the quota message", () => {
  const payload = translateGatewayError({
    status: 429,
    bodyText: JSON.stringify({
      error: { message: "Rate limit exceeded: 10 requests per minute." },
    }),
    modelName: "Kimi K3",
    providerName: "kimi",
  });
  assert.equal(payload.error.type, "rate_limit_error");
  assert.ok(payload.error.message.includes("rate-limiting"));
});

test("an unclassified 4xx still names the provider", () => {
  const payload = translateGatewayError({
    status: 422,
    bodyText: JSON.stringify({ error: { message: "bad payload" } }),
    modelName: "Qwen 3.8 Max",
    providerName: "alibaba",
  });
  assert.equal(
    payload.error.message,
    "alibaba rejected the request for Qwen 3.8 Max. (HTTP 422: bad payload)",
  );
  assert.equal(payload.error.type, "invalid_request_error");
});

test("a plan without API access is not reported as a bad credential", () => {
  // Command Code's verbatim answer to a valid Go-plan key on /provider/v1.
  const translated = translateGatewayError({
    status: 403,
    bodyText: JSON.stringify({
      error: {
        message:
          "Your Go plan doesn't include API access. Upgrade to Provider or higher at https://commandcode.ai/billing to use these endpoints.",
      },
    }),
    modelName: "DeepSeek V4 Flash (Command Code)",
    providerName: "commandcode",
    providerKind: "openai-compatible",
  });
  assert.equal(translated.error.type, "billing_error");
  assert.match(translated.error.message, /plan does not include the API/);
  // The two fixes that would waste the operator's time must not be suggested.
  assert.doesNotMatch(translated.error.message, /rejected the stored credentials/);
  assert.doesNotMatch(translated.error.message, /Re-run codex-router setup/);
  assert.doesNotMatch(translated.error.message, /run out of usage/);
  // The provider's own wording still rides along.
  assert.match(translated.error.message, /Upgrade to Provider or higher/);
});

test("a genuine 403 credential rejection still says so", () => {
  const translated = translateGatewayError({
    status: 403,
    bodyText: JSON.stringify({ error: { message: "Invalid API key provided" } }),
    modelName: "Kimi K3 (Command Code)",
    providerName: "commandcode",
    providerKind: "openai-compatible",
  });
  assert.equal(translated.error.type, "authentication_error");
  assert.match(translated.error.message, /rejected the stored credentials/);
});

// Regression for #179: LiteLLM cools a deployment down on a 401 and then
// answers with its own 429 "No deployments available". Telling the user to wait
// out a rejected credential loops them forever.
const COOLED_DOWN_401 = `{"error":{"message":"No deployments available for selected model, Try again in 51 seconds. ${"x".repeat(400)} cooldown_list=[('abc', {'exception_received': 'AuthenticationError', 'status_code': '401'})]"}}`;

test("a cooled-down 401 is reported as an auth failure, not a rate limit", () => {
  const translated = translateGatewayError({
    status: 429,
    bodyText: COOLED_DOWN_401,
    modelName: "kimi-k3",
    providerName: "Kimi",
    providerKind: "api",
  });
  assert.equal(translated.error.type, "authentication_error");
  assert.match(translated.error.message, /Re-run codex-router setup/);
  // The status on the wire stays truthful; only the classification changes.
  assert.equal(translated.error.code, "429");
});

test("a cooled-down 401 on an OAuth provider advises signing in again", () => {
  const translated = translateGatewayError({
    status: 429,
    bodyText: COOLED_DOWN_401,
    modelName: "kimi-k3",
    providerName: "Kimi",
    providerKind: "oauth",
  });
  assert.equal(translated.error.type, "authentication_error");
  assert.match(translated.error.message, /Sign in to Kimi again/);
});

test("a genuine rate limit is still a rate limit", () => {
  const translated = translateGatewayError({
    status: 429,
    bodyText: JSON.stringify({ error: { message: "rate limit exceeded" } }),
    modelName: "kimi-k3",
    providerName: "Kimi",
    providerKind: "api",
    retryAfterSeconds: 30,
  });
  assert.equal(translated.error.type, "rate_limit_error");
});

test("a cooldown caused by a 429 is not reclassified", () => {
  const translated = translateGatewayError({
    status: 429,
    bodyText: COOLED_DOWN_401.replace("'401'", "'429'"),
    modelName: "kimi-k3",
    providerName: "Kimi",
    providerKind: "api",
  });
  assert.equal(translated.error.type, "rate_limit_error");
});
