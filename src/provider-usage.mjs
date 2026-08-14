import { PROVIDERS } from "./model-registry.mjs";
import { providerAccountUsageSnapshot } from "./provider-account-usage.mjs";
import { readProviderSelection } from "./provider-selection.mjs";
import { recentUsageEvents } from "./usage-events.mjs";

function dateKey(value) {
  const date = new Date(value);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function nonnegative(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.round(number) : 0;
}

function optionalNonnegative(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.round(number) : undefined;
}

// Routed slugs are provider-qualified (`kimi-oauth/k3`); native ones are bare
// (`gpt-5.6-sol`). The tray groups under a provider already, so drop the prefix.
function modelDisplayName(slug) {
  const slash = slug.lastIndexOf("/");
  return slash === -1 ? slug : slug.slice(slash + 1) || slug;
}

// Native OpenAI traffic never routes through a registry provider, so seed a
// bucket for it; otherwise the busiest models on the box are dropped outright.
// This is router-observed traffic only — subscription quota still comes from
// the separate Codex account-usage path.
const NATIVE_OPENAI = {
  id: "openai",
  displayName: "ChatGPT (native)",
  kind: "oauth",
};

export function aggregateProviderUsage(events, { days = 90, now = Date.now() } = {}) {
  const cutoff = now - days * 24 * 60 * 60 * 1_000;
  // Protocol variants never appear as usage rows: their events, quota
  // headers, and activity are all folded into the canonical family provider.
  const byProvider = new Map(
    [NATIVE_OPENAI, ...[...PROVIDERS.values()].filter((provider) => !provider.variantOf)].map((provider) => [
      provider.id,
      {
        id: provider.id,
        displayName: provider.displayName,
        credentialType: provider.kind === "oauth" ? "oauth" : "api",
        scope: "local-router",
        requests: 0,
        successfulRequests: 0,
        meteredRequests: 0,
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        daily: new Map(),
        models: new Map(),
      },
    ]),
  );

  for (const event of events) {
    const at = Date.parse(event?.at);
    const provider = byProvider.get(event?.provider);
    if (!provider || !Number.isFinite(at) || at < cutoff || at > now) continue;
    if (
      event.meteringVersion !== 1 &&
      event.totalTokens === undefined &&
      event.inputTokens === undefined &&
      event.outputTokens === undefined
    ) continue;
    provider.requests += 1;
    if (event.status >= 200 && event.status < 400) provider.successfulRequests += 1;
    const inputTokens = nonnegative(event.inputTokens);
    const outputTokens = nonnegative(event.outputTokens);
    const totalTokens = nonnegative(
      event.totalTokens ?? (event.inputTokens !== undefined || event.outputTokens !== undefined
        ? inputTokens + outputTokens
        : 0),
    );
    if (
      event.totalTokens !== undefined ||
      event.inputTokens !== undefined ||
      event.outputTokens !== undefined
    ) {
      provider.meteredRequests += 1;
    }
    provider.inputTokens += inputTokens;
    provider.outputTokens += outputTokens;
    provider.totalTokens += totalTokens;
    const day = dateKey(at);
    const bucket = provider.daily.get(day) || { startDate: day, tokens: 0, requests: 0 };
    bucket.tokens += totalTokens;
    bucket.requests += 1;
    provider.daily.set(day, bucket);

    const slug = typeof event.model === "string" && event.model ? event.model : "unknown";
    const model = provider.models.get(slug) || {
      slug,
      displayName: modelDisplayName(slug),
      requests: 0,
      successfulRequests: 0,
      meteredRequests: 0,
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      speedSamples: [],
      firstTokenSamples: [],
      lastUsedAt: new Date(at).toISOString(),
    };
    model.requests += 1;
    if (event.status >= 200 && event.status < 400) model.successfulRequests += 1;
    if (
      event.totalTokens !== undefined ||
      event.inputTokens !== undefined ||
      event.outputTokens !== undefined
    ) {
      model.meteredRequests += 1;
    }
    model.inputTokens += inputTokens;
    model.outputTokens += outputTokens;
    model.totalTokens += totalTokens;
    const durationMs = nonnegative(event.durationMs);
    const responseStartMs = optionalNonnegative(event.responseStartMs);
    // Output tokens per second is defined as the rate *after* the first token,
    // with the wait before it reported separately as time-to-first-token --
    // that is how every published benchmark states it, and it is the only
    // split that does not change with reply length. Dividing by the time since
    // the response headers instead buries a reasoning model's silent thinking
    // in the denominator, which made a 31-token reply read at 12 tok/s and a
    // 426-token one at 69 on the same model.
    const firstTokenMs = optionalNonnegative(event.firstTokenMs);
    const generationDurationMs = durationMs - (firstTokenMs ?? durationMs);
    const measurable =
      event.status >= 200 &&
      event.status < 400 &&
      !event.retries &&
      event.emptyCompletion !== true &&
      event.emptyCompletionRetried !== true &&
      event.emptyCompletionGuardReleased !== true;
    if (measurable && outputTokens > 0 && firstTokenMs !== undefined && generationDurationMs > 0) {
      model.speedSamples.push({ outputTokens, generationDurationMs });
      // Keep the displayed rate current instead of averaging the model's
      // entire 90-day usage history. Twenty replies smooth one-off bursts
      // without letting old sessions dominate the result.
      if (model.speedSamples.length > 20) model.speedSamples.shift();
    }
    // Time-to-first-token stands on its own: it is the pause the operator
    // actually feels before anything appears, and on a reasoning model it is
    // roughly half the request. Sampled from the same events, so a turn that
    // is unfit for a rate is unfit for this too.
    if (measurable && firstTokenMs !== undefined && firstTokenMs > 0 && firstTokenMs <= durationMs) {
      model.firstTokenSamples.push(firstTokenMs);
      if (model.firstTokenSamples.length > 20) model.firstTokenSamples.shift();
    }
    if (at >= Date.parse(model.lastUsedAt)) model.lastUsedAt = new Date(at).toISOString();
    provider.models.set(slug, model);
  }

  return {
    fetchedAt: new Date(now).toISOString(),
    scope: "local-router",
    providers: [...byProvider.values()].map(({ daily, models, ...provider }) => ({
      ...provider,
      dailyUsageBuckets: [...daily.values()].sort((left, right) =>
        left.startDate.localeCompare(right.startDate),
      ),
      models: [...models.values()]
        .map(({ speedSamples, firstTokenSamples, ...model }) => {
          const speedOutputTokens = speedSamples.reduce(
            (total, sample) => total + sample.outputTokens,
            0,
          );
          const speedDurationMs = speedSamples.reduce(
            (total, sample) => total + sample.generationDurationMs,
            0,
          );
          return {
            ...model,
            speedSampleCount: speedSamples.length,
            // Median, not mean: one cold start or one queued request would
            // drag an average far more than it reflects a typical turn.
            observedFirstTokenMs: firstTokenSamples.length
              ? [...firstTokenSamples].sort((left, right) => left - right)[
                  Math.floor(firstTokenSamples.length / 2)
                ]
              : null,
            observedTokensPerSecond:
              speedDurationMs > 0
                ? Math.round((speedOutputTokens * 1_000 * 10) / speedDurationMs) / 10
                : null,
          };
        })
        .sort(
          (left, right) => right.totalTokens - left.totalTokens || right.requests - left.requests,
        ),
    })),
  };
}

export async function providerUsageSnapshot(options = {}) {
  const days = options.days || 90;
  const snapshot = aggregateProviderUsage(
    recentUsageEvents({ sinceMs: days * 24 * 60 * 60 * 1_000, limit: 100_000 }),
    { ...options, days },
  );
  const accounts = await providerAccountUsageSnapshot({
    ...options,
    providerIds: readProviderSelection(),
  });
  return {
    ...snapshot,
    providers: snapshot.providers.map((provider) => ({
      ...provider,
      // Consumers decode `account` as a required field, so never leave it unset
      // for providers the account layer does not cover (native OpenAI).
      account: accounts[provider.id] || {
        status: "local-only",
        source: "local-router",
        metrics: [],
        message: "Router-observed traffic; subscription quota is tracked separately.",
      },
    })),
  };
}
