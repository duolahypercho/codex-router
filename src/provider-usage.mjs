import { PROVIDERS } from "./model-registry.mjs";
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

export function aggregateProviderUsage(events, { days = 90, now = Date.now() } = {}) {
  const cutoff = now - days * 24 * 60 * 60 * 1_000;
  const byProvider = new Map(
    [...PROVIDERS.values()].map((provider) => [
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
  }

  return {
    fetchedAt: new Date(now).toISOString(),
    scope: "local-router",
    providers: [...byProvider.values()].map(({ daily, ...provider }) => ({
      ...provider,
      dailyUsageBuckets: [...daily.values()].sort((left, right) =>
        left.startDate.localeCompare(right.startDate),
      ),
    })),
  };
}

export function providerUsageSnapshot(options = {}) {
  const days = options.days || 90;
  return aggregateProviderUsage(
    recentUsageEvents({ sinceMs: days * 24 * 60 * 60 * 1_000, limit: 100_000 }),
    { ...options, days },
  );
}
