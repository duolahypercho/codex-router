import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

const stateDir = mkdtempSync(path.join(os.tmpdir(), "model-failover-test-"));
process.env.CODEX_ROUTER_STATE_DIR = stateDir;

const {
  FAILOVER_TIER,
  MAX_COOLDOWN_MS,
  MIN_RATE_LIMIT_COOLDOWN_SECONDS,
  PROVIDER_COOLDOWNS_PATH,
  classifyRoutedFailure,
  clearAllProviderCooldowns,
  clearProviderCooldown,
  failoverTier,
  failoverTierCounts,
  providerCooldown,
  rankFailoverCandidates,
  readFailoverSettings,
  readProviderCooldowns,
  recordProviderCooldown,
  setFailoverChain,
  setFailoverEnabled,
} = await import("../src/model-failover.mjs");

const NOW = Date.parse("2026-08-15T12:00:00.000Z");

function quotaBody(message) {
  return JSON.stringify({ error: { message } });
}

// -- classification ----------------------------------------------------------

test("classifyRoutedFailure swaps on exhausted usage across provider dialects", () => {
  const bodies = [
    // OpenAI-style insufficient_quota, DeepSeek/Anthropic balance wording, zai
    // and Kimi plan limits, and the Chinese-market phrasing.
    "You exceeded your current quota, please check your plan and billing details.",
    "Your credit balance is too low to access the Anthropic API.",
    "usage limit reached for your GLM Coding Plan",
    "You have reached your monthly limit.",
    "余额不足",
  ];
  for (const message of bodies) {
    const verdict = classifyRoutedFailure({ status: 429, bodyText: quotaBody(message), now: NOW });
    assert.equal(verdict.swap, true, message);
    assert.equal(verdict.reason, "out_of_usage", message);
  }
});

test("classifyRoutedFailure swaps on OpenCode FreeUsageLimitError", () => {
  const verdict = classifyRoutedFailure({
    status: 429,
    bodyText: JSON.stringify({
      error: {
        type: "FreeUsageLimitError",
        message: "Rate limit exceeded",
      },
    }),
    now: NOW,
  });
  assert.deepEqual(verdict, { swap: true, reason: "out_of_usage" });
});

test("classifyRoutedFailure swaps only a marked provider transport 5xx", () => {
  assert.deepEqual(
    classifyRoutedFailure({
      status: 502,
      bodyText: JSON.stringify({ error: { type: "provider_transport_error" } }),
    }),
    { swap: true, reason: "transport" },
  );
  assert.deepEqual(
    classifyRoutedFailure({ status: 502, bodyText: "provider unavailable" }),
    { swap: false },
  );
});

test("classifyRoutedFailure recognizes the observed Z.ai five-hour window message", () => {
  const verdict = classifyRoutedFailure({
    status: 429,
    bodyText: quotaBody(
      "Usage limit reached for 5 hour. Your limit will reset at 2026-08-21 04:40:42.",
    ),
    now: NOW,
  });
  assert.deepEqual(verdict, { swap: true, reason: "out_of_usage" });
});

test("classifyRoutedFailure swaps on 402 whatever the body says", () => {
  const verdict = classifyRoutedFailure({ status: 402, bodyText: "{}", now: NOW });
  assert.deepEqual(verdict, { swap: true, reason: "out_of_usage" });
});

test("classifyRoutedFailure records no window when the provider named none", () => {
  const verdict = classifyRoutedFailure({
    status: 429,
    bodyText: quotaBody("insufficient_quota"),
    now: NOW,
  });
  assert.equal(verdict.swap, true);
  assert.equal(verdict.until, undefined);
});

test("classifyRoutedFailure carries the provider's own reset time", () => {
  const verdict = classifyRoutedFailure({
    status: 429,
    bodyText: quotaBody("insufficient_quota"),
    retryAfterSeconds: 900,
    now: NOW,
  });
  assert.equal(verdict.until, new Date(NOW + 900_000).toISOString());
});

test("classifyRoutedFailure swaps on a rate limit only when it is long", () => {
  const short = classifyRoutedFailure({
    status: 429,
    bodyText: quotaBody("Too many requests"),
    retryAfterSeconds: MIN_RATE_LIMIT_COOLDOWN_SECONDS,
    now: NOW,
  });
  assert.equal(short.swap, false);

  const long = classifyRoutedFailure({
    status: 429,
    bodyText: quotaBody("Too many requests"),
    retryAfterSeconds: 600,
    now: NOW,
  });
  assert.deepEqual(long, {
    swap: true,
    reason: "rate_limited",
    until: new Date(NOW + 600_000).toISOString(),
  });
});

test("classifyRoutedFailure never swaps an entitlement failure for a quota one", () => {
  // "upgrade your plan" appears in both pattern sets; a plan that never
  // included the API is not something another model's quota can fix, and the
  // operator has to read the real message.
  const verdict = classifyRoutedFailure({
    status: 403,
    bodyText: quotaBody("Your Go plan doesn't include API access. Upgrade to Provider or higher."),
    now: NOW,
  });
  assert.equal(verdict.swap, false);
});

test("classifyRoutedFailure leaves every other failure exactly as it was", () => {
  const cases = [
    { status: 400, bodyText: quotaBody("Invalid request") },
    { status: 401, bodyText: quotaBody("Incorrect API key provided") },
    { status: 403, bodyText: quotaBody("Forbidden") },
    { status: 404, bodyText: quotaBody("model not found") },
    { status: 429, bodyText: quotaBody("Too many requests") },
    { status: 500, bodyText: quotaBody("insufficient_quota") },
    { status: 503, bodyText: quotaBody("insufficient_quota") },
  ];
  for (const one of cases) {
    assert.equal(classifyRoutedFailure({ ...one, now: NOW }).swap, false, String(one.status));
  }
});

// -- cooldowns ---------------------------------------------------------------

test("recordProviderCooldown stores only a window the provider reported", (t) => {
  t.after(() => clearAllProviderCooldowns());
  assert.equal(recordProviderCooldown("zai-coding", { reason: "out_of_usage" }), undefined);
  assert.deepEqual(readProviderCooldowns({ now: NOW }), {});
});

test("providerCooldown expires by itself and needs no sweeper", (t) => {
  t.after(() => clearAllProviderCooldowns());
  recordProviderCooldown("zai-coding", {
    until: new Date(NOW + 60_000).toISOString(),
    reason: "out_of_usage",
    now: NOW,
  });
  assert.equal(providerCooldown("zai-coding", { now: NOW })?.reason, "out_of_usage");
  assert.equal(providerCooldown("zai-coding", { now: NOW + 61_000 }), undefined);
});

test("a cooldown is capped so a malformed reset cannot strand a model", (t) => {
  t.after(() => clearAllProviderCooldowns());
  const entry = recordProviderCooldown("zai-coding", {
    // Some gateways send epoch seconds where seconds-from-now belong.
    until: new Date(NOW + 400 * 24 * 60 * 60 * 1_000).toISOString(),
    now: NOW,
  });
  assert.equal(Date.parse(entry.until), NOW + MAX_COOLDOWN_MS);
});

test("a cooldown is recorded against the whole variant family", (t) => {
  t.after(() => clearAllProviderCooldowns());
  // Protocol variants share one credential and therefore one quota, so a
  // variant that reported empty must cool its parent down too.
  recordProviderCooldown("opencode-go-responses", {
    until: new Date(NOW + 60_000).toISOString(),
    now: NOW,
  });
  assert.ok(providerCooldown("opencode-go", { now: NOW }));
});

test("a later hop may sharpen the reason but never invent the window", (t) => {
  t.after(() => clearAllProviderCooldowns());
  // api-forwarder sees the provider's Retry-After but not its body, so it can
  // only say "429". The router reads the body and knows the plan is exhausted.
  recordProviderCooldown("zai-coding", {
    until: new Date(NOW + 1_800_000).toISOString(),
    reason: "rate_limited",
    now: NOW,
  });
  const refined = recordProviderCooldown("zai-coding", { reason: "out_of_usage", now: NOW });
  assert.equal(refined.reason, "out_of_usage");
  // The window itself is untouched by the refinement.
  assert.equal(refined.until, new Date(NOW + 1_800_000).toISOString());
  // And a reason alone still cannot cool a provider that is not already cooled.
  assert.equal(recordProviderCooldown("kimi-api", { reason: "out_of_usage", now: NOW }), undefined);
  assert.equal(providerCooldown("kimi-api", { now: NOW }), undefined);
});

test("clearProviderCooldown lets a provider back in on its first success", (t) => {
  t.after(() => clearAllProviderCooldowns());
  recordProviderCooldown("zai-coding", { until: new Date(NOW + 60_000).toISOString(), now: NOW });
  assert.equal(clearProviderCooldown("zai-coding"), true);
  assert.equal(providerCooldown("zai-coding", { now: NOW }), undefined);
});

test("an unreadable cooldown document means nothing is cooled down", (t) => {
  t.after(() => clearAllProviderCooldowns());
  writeFileSync(PROVIDER_COOLDOWNS_PATH, "{not json", "utf8");
  assert.deepEqual(readProviderCooldowns({ now: NOW }), {});
});

// -- ranking -----------------------------------------------------------------

const FROM = { slug: "zai-coding/glm-5.3", provider: "zai-coding", contextWindow: 1_048_576 };

function model(slug, provider, extra = {}) {
  return {
    slug,
    provider,
    priority: 50,
    contextWindow: 262_144,
    inputModalities: ["text"],
    ...extra,
  };
}

test("rankFailoverCandidates puts free models ahead of paid ones", () => {
  const ranked = rankFailoverCandidates(
    [
      model("kimi/k3", "kimi", { priority: 10 }),
      model("opencode-free/big-pickle", "opencode-free", { priority: 90 }),
    ],
    { from: FROM },
  );
  assert.deepEqual(
    ranked.map((entry) => entry.model.slug),
    ["opencode-free/big-pickle", "kimi/k3"],
  );
  assert.equal(ranked[0].tier, FAILOVER_TIER.free);
  assert.equal(ranked[1].tier, FAILOVER_TIER.subscription);
});

test("rankFailoverCandidates orders a tier by the registry's own preference", () => {
  const ranked = rankFailoverCandidates(
    [model("kimi/k3", "kimi", { priority: 60 }), model("deepseek/v4", "deepseek", { priority: 20 })],
    { from: FROM },
  );
  assert.deepEqual(
    ranked.map((entry) => entry.model.slug),
    ["deepseek/v4", "kimi/k3"],
  );
});

test("rankFailoverCandidates never routes back into the same quota", () => {
  const ranked = rankFailoverCandidates(
    [
      model("zai-coding/glm-5.2", "zai-coding"),
      // A protocol variant of the exhausted provider shares its credential.
      model("zai-coding/glm-5.1", "zai-coding"),
      model("kimi/k3", "kimi"),
    ],
    { from: FROM },
  );
  assert.deepEqual(
    ranked.map((entry) => entry.model.slug),
    ["kimi/k3"],
  );
});

test("rankFailoverCandidates will not trade a quota error for a context error", () => {
  const ranked = rankFailoverCandidates(
    [model("kimi/k3", "kimi", { contextWindow: 262_144 }), model("gemini/g4", "gemini", { contextWindow: 1_048_576 })],
    { from: FROM, estimatedTokens: 400_000 },
  );
  assert.deepEqual(
    ranked.map((entry) => entry.model.slug),
    ["gemini/g4"],
  );
});

test("rankFailoverCandidates skips a provider that is already cooled down", (t) => {
  t.after(() => clearAllProviderCooldowns());
  recordProviderCooldown("kimi", { until: new Date(NOW + 600_000).toISOString(), now: NOW });
  const ranked = rankFailoverCandidates(
    [model("kimi/k3", "kimi"), model("deepseek/v4", "deepseek")],
    { from: FROM, now: NOW },
  );
  assert.deepEqual(
    ranked.map((entry) => entry.model.slug),
    ["deepseek/v4"],
  );
});

test("rankFailoverCandidates keeps a collaboration turn on a v2 model", () => {
  const ranked = rankFailoverCandidates(
    [
      model("kimi/k3", "kimi", { multiAgentVersion: "v1" }),
      model("deepseek/v4", "deepseek", { multiAgentVersion: "v2" }),
    ],
    { from: FROM, needsMultiAgentV2: true },
  );
  assert.deepEqual(
    ranked.map((entry) => entry.model.slug),
    ["deepseek/v4"],
  );
});

test("rankFailoverCandidates preserves the selected search execution mode", () => {
  const from = model("source/hosted", "source", {
    searchTool: { mode: "hosted" },
  });
  const ranked = rankFailoverCandidates(
    [
      model("hosted/compatible", "hosted", { searchTool: { mode: "hosted" } }),
      model("standalone/incompatible", "standalone", {
        searchTool: { mode: "standalone" },
      }),
      model("plain/incompatible", "plain"),
    ],
    { from, needsSearch: true },
  );
  assert.deepEqual(ranked.map((entry) => entry.model.slug), ["hosted/compatible"]);
});

test("rankFailoverCandidates leaves a search-capable model's ordinary turn unrestricted", () => {
  const ranked = rankFailoverCandidates(
    [model("plain/candidate", "plain")],
    {
      from: model("source/hosted", "source", { searchTool: { mode: "hosted" } }),
    },
  );
  assert.deepEqual(ranked.map((entry) => entry.model.slug), ["plain/candidate"]);
});

test("rankFailoverCandidates ignores ambient search intent without source capability", () => {
  const ranked = rankFailoverCandidates(
    [model("plain/candidate", "plain")],
    {
      from: model("source/plain", "source"),
      needsSearch: true,
    },
  );
  assert.deepEqual(ranked.map((entry) => entry.model.slug), ["plain/candidate"]);
});

test("rankFailoverCandidates does not guess after search capability disappears", () => {
  const ranked = rankFailoverCandidates(
    [model("hosted/candidate", "hosted", { searchTool: { mode: "hosted" } })],
    { from: model("source/plain", "source"), hasSearchHistory: true },
  );
  assert.deepEqual(ranked, []);
});

test("rankFailoverCandidates preserves an explicitly snapshotted absent mode", () => {
  const ranked = rankFailoverCandidates(
    [model("hosted/candidate", "hosted", { searchTool: { mode: "hosted" } })],
    {
      from: model("source/hosted", "source", { searchTool: { mode: "hosted" } }),
      needsSearch: true,
      hasSearchHistory: true,
      requiredSearchMode: undefined,
    },
  );
  assert.deepEqual(ranked, []);
});

test("rankFailoverCandidates refuses a model the registry bars from the vision bridge", () => {
  const ranked = rankFailoverCandidates(
    [
      model("kimi/k3", "kimi", { visionBridge: false }),
      model("deepseek/v4", "deepseek"),
      model("gemini/g4", "gemini", { inputModalities: ["text", "image"] }),
    ],
    { from: FROM, needsImage: true },
  );
  assert.deepEqual(
    ranked.map((entry) => entry.model.slug).sort(),
    ["deepseek/v4", "gemini/g4"],
  );
});

test("rankFailoverCandidates returns nothing rather than something unsuitable", () => {
  assert.deepEqual(rankFailoverCandidates([model("zai-coding/glm-5.2", "zai-coding")], { from: FROM }), []);
  assert.deepEqual(rankFailoverCandidates([], { from: FROM }), []);
  assert.deepEqual(rankFailoverCandidates(undefined, { from: FROM }), []);
});

test("rankFailoverCandidates never turns a failure into a browser-automation turn", () => {
  const browser = model("chatgpt-web/light", "chatgpt-web", { contextWindow: 41_000 });
  assert.deepEqual(
    rankFailoverCandidates([browser], { from: FROM, chain: [browser.slug] }),
    [],
  );
});

test("a named chain is used verbatim, minus entries this build cannot route to", () => {
  const ranked = rankFailoverCandidates(
    [
      model("kimi/k3", "kimi", { priority: 90 }),
      model("opencode-free/big-pickle", "opencode-free", { priority: 10 }),
    ],
    { from: FROM, chain: ["kimi/k3", "gone/removed-model", "opencode-free/big-pickle"] },
  );
  assert.deepEqual(
    ranked.map((entry) => entry.model.slug),
    ["kimi/k3", "opencode-free/big-pickle"],
  );
});

test("failoverTierCounts separates free, local, and paid rather than promising an order", () => {
  const counts = failoverTierCounts([
    model("opencode-free/big-pickle", "opencode-free"),
    model("kilo-free/x:free", "kilo-free"),
    model("local/qwen3", "local"),
    model("kimi-api/kimi-k3", "kimi-api"),
    model("zai-api/glm-5.2", "zai-api"),
  ]);
  // Local is counted apart from free: it costs nothing and is still never
  // chosen automatically, so folding it into `free` would let a surface promise
  // a first stop that cannot happen.
  assert.deepEqual(counts, { free: 2, local: 1, subscription: 2 });
  // The case every install starts in: nothing curated, so nothing cheaper to
  // try first, and no surface may claim otherwise.
  assert.deepEqual(failoverTierCounts([model("kimi-api/kimi-k3", "kimi-api")]), {
    free: 0,
    local: 0,
    subscription: 1,
  });
  assert.deepEqual(failoverTierCounts([]), { free: 0, local: 0, subscription: 0 });
  assert.deepEqual(failoverTierCounts(undefined), { free: 0, local: 0, subscription: 0 });
});

test("failoverTier reads free from the registry rather than a name", () => {
  assert.equal(failoverTier(model("opencode-free/big-pickle", "opencode-free")), FAILOVER_TIER.free);
  assert.equal(failoverTier(model("local/qwen3", "local")), FAILOVER_TIER.free);
  assert.equal(failoverTier(model("kimi/k3", "kimi")), FAILOVER_TIER.subscription);
  // A provider this build does not know is never assumed to be free.
  assert.equal(failoverTier(model("gone/removed", "gone")), FAILOVER_TIER.subscription);
});

test("a model on this machine is never chosen automatically, but can be named", () => {
  const auto = rankFailoverCandidates(
    [model("local/qwen3", "local"), model("kimi/k3", "kimi")],
    { from: FROM },
  );
  assert.deepEqual(
    auto.map((entry) => entry.model.slug),
    ["kimi/k3"],
  );

  const named = rankFailoverCandidates(
    [model("local/qwen3", "local"), model("kimi/k3", "kimi")],
    { from: FROM, chain: ["local/qwen3"] },
  );
  assert.deepEqual(
    named.map((entry) => entry.model.slug),
    ["local/qwen3"],
  );
});

// -- settings ----------------------------------------------------------------

test("failover is on for an install that has never answered the question", () => {
  assert.equal(readFailoverSettings().enabled, true);
  assert.equal(readFailoverSettings().defaulted, true);
});

test("an operator's off is remembered verbatim", () => {
  setFailoverEnabled(false);
  assert.equal(readFailoverSettings().enabled, false);
  assert.equal(readFailoverSettings().defaulted, undefined);
  setFailoverEnabled(true);
  assert.equal(readFailoverSettings().enabled, true);
});

test("setFailoverChain accepts comma-separated slugs and auto clears it", () => {
  assert.deepEqual(setFailoverChain(["a/one,b/two", " c/three "]).chain, [
    "a/one",
    "b/two",
    "c/three",
  ]);
  assert.deepEqual(setFailoverChain([]).chain, []);
});
