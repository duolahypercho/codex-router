import assert from "node:assert/strict";
import test from "node:test";

const {
  cooldownUntil,
  parseRateLimitHeaders,
  requestQuotaFromRateLimitHeaders,
  resetAt,
  retryAfterSeconds,
} = await import(
  "../src/rate-limit-headers.mjs"
);

const NOW = Date.parse("2026-07-25T12:00:00.000Z");

test("reset values normalize from every documented shape", () => {
  // Go-style durations (Groq, OpenAI).
  assert.equal(resetAt("7.66s", NOW), NOW + 7660);
  assert.equal(resetAt("2m59.56s", NOW), NOW + 179_560);
  assert.equal(resetAt("6m0s", NOW), NOW + 360_000);
  assert.equal(resetAt("1h2m3s", NOW), NOW + 3_723_000);
  // Bare seconds (retry-after).
  assert.equal(resetAt("60", NOW), NOW + 60_000);
  // Absolute timestamps (Anthropic).
  assert.equal(resetAt("2026-07-25T12:05:00Z", NOW), Date.parse("2026-07-25T12:05:00Z"));
  // Junk never produces a bogus window.
  assert.equal(resetAt("", NOW), undefined);
  assert.equal(resetAt("soon", NOW), undefined);
  assert.equal(resetAt(undefined, NOW), undefined);
});

test("openai-compatible headers become a normalized snapshot", () => {
  const snapshot = parseRateLimitHeaders(
    new Headers({
      "x-ratelimit-limit-requests": "14400",
      "x-ratelimit-remaining-requests": "14370",
      "x-ratelimit-reset-requests": "2m59.56s",
      "x-ratelimit-limit-tokens": "18000",
      "x-ratelimit-remaining-tokens": "17997",
      "x-ratelimit-reset-tokens": "7.66s",
    }),
    { now: NOW },
  );
  assert.deepEqual(snapshot, {
    requests: {
      limit: 14400,
      remaining: 14370,
      resetAt: new Date(NOW + 179_560).toISOString(),
    },
    tokens: {
      limit: 18000,
      remaining: 17997,
      resetAt: new Date(NOW + 7660).toISOString(),
    },
  });
});

test("anthropic's prefixed headers parse through the same path", () => {
  const snapshot = parseRateLimitHeaders(
    new Headers({
      "anthropic-ratelimit-requests-limit": "50",
      "anthropic-ratelimit-requests-remaining": "0",
      "anthropic-ratelimit-requests-reset": "2026-07-25T12:01:00Z",
    }),
    { now: NOW },
  );
  assert.deepEqual(snapshot.requests, {
    limit: 50,
    remaining: 0,
    resetAt: "2026-07-25T12:01:00.000Z",
  });
  assert.equal(snapshot.tokens, undefined);
});

test("only a complete request window becomes per-credential quota", () => {
  assert.deepEqual(
    requestQuotaFromRateLimitHeaders(
      new Headers({
        "x-ratelimit-limit-requests": "100",
        "x-ratelimit-remaining-requests": "37",
        "x-ratelimit-reset-requests": "60",
        "x-ratelimit-limit-tokens": "9000",
        "x-ratelimit-remaining-tokens": "1",
      }),
      { now: NOW },
    ),
    {
      unit: "requests",
      limit: 100,
      remaining: 37,
      resetAt: new Date(NOW + 60_000).toISOString(),
      observedAt: new Date(NOW).toISOString(),
    },
  );
  assert.equal(
    requestQuotaFromRateLimitHeaders(
      new Headers({ "x-ratelimit-limit-requests": "100" }),
      { now: NOW },
    ),
    undefined,
    "a partial window must not overwrite a complete observation",
  );
  assert.equal(
    requestQuotaFromRateLimitHeaders(
      new Headers({
        "x-ratelimit-limit-tokens": "9000",
        "x-ratelimit-remaining-tokens": "8000",
      }),
      { now: NOW },
    ),
    undefined,
    "token headers are not attributed to a pooled key",
  );
});

test("a provider that reports nothing yields no snapshot", () => {
  assert.equal(parseRateLimitHeaders(new Headers({ "content-type": "application/json" })), undefined);
  assert.equal(parseRateLimitHeaders(undefined), undefined);
  assert.equal(parseRateLimitHeaders({}), undefined);
});

test("cooldown only triggers on real exhaustion", () => {
  // Headroom left on both windows is not a cooldown.
  assert.equal(
    cooldownUntil({
      requests: { remaining: 12, resetAt: "2026-07-25T12:01:00.000Z" },
      tokens: { remaining: 900, resetAt: "2026-07-25T12:02:00.000Z" },
    }),
    undefined,
  );
  // An exhausted window is, and the latest reset wins so a retry never fires early.
  assert.equal(
    cooldownUntil({
      requests: { remaining: 0, resetAt: "2026-07-25T12:01:00.000Z" },
      tokens: { remaining: 0, resetAt: "2026-07-25T12:03:00.000Z" },
    }),
    "2026-07-25T12:03:00.000Z",
  );
  // An explicit retry-after is honored on its own.
  assert.equal(cooldownUntil({ retryAt: "2026-07-25T12:09:00.000Z" }), "2026-07-25T12:09:00.000Z");
  assert.equal(cooldownUntil(undefined), undefined);
});

test("retry-after reads RFC forms and the extensions providers actually send", () => {
  const seconds = (value) =>
    retryAfterSeconds(new Headers(value === undefined ? {} : { "retry-after": value }), {
      now: NOW,
    });
  // delay-seconds, the form most OpenAI-compatible providers send.
  assert.equal(seconds("120"), 120);
  // HTTP-date, equally legal and what a gateway in front of the origin sends.
  assert.equal(seconds("Sat, 25 Jul 2026 12:05:00 GMT"), 300);
  // Zero is a non-negative integer, so it is a provider saying "now" rather
  // than a provider saying nothing. The two must stay distinguishable here;
  // whether "now" is worth wording belongs to the caller.
  assert.equal(seconds("0"), 0);
  // A window that elapsed before the response was read says the same thing.
  assert.equal(seconds("Sat, 25 Jul 2026 11:59:00 GMT"), 0);
  // Not RFC grammar -- delay-seconds is an integer -- but providers do send
  // fractions, and `resetAt` has always read them. A sub-second wait keeps its
  // second rather than rounding into the zero that means "no wait".
  assert.equal(seconds("0.2"), 1);
  // Nothing usable, so the caller keeps its own judgement rather than
  // inheriting a window the provider never named.
  assert.equal(seconds(undefined), undefined);
  assert.equal(seconds("soon"), undefined);
  assert.equal(seconds("-5"), undefined);
  assert.equal(retryAfterSeconds(undefined, { now: NOW }), undefined);
  assert.equal(retryAfterSeconds({}, { now: NOW }), undefined);
});
