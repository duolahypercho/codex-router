import { useEffect, useMemo, useRef, useState, type Ref } from "react";
import {
  ArrowUpRight,
  BarChart3,
  Coins,
  Gauge,
} from "lucide-react";
import { Badge, Button, EmptyState, PageHeader, PanelSkeleton, SectionHeading, SkeletonBlock } from "../components";
import {
  accountBucketsWithRouterFallback,
  bucketRange,
  classNames,
  compactNumber,
  exactNumber,
  formatDateTime,
  metricValue,
  remainingPercent,
  type AccountBucketSource,
} from "../lib";
import type {
  AccountUsage,
  ProviderUsage,
  ProviderUsageSnapshot,
  RouterControlApi,
  RouterDataReady,
  RouterTarget,
  UsageBucket,
  UsageEvent,
  UsageMetric,
} from "../types";
import type { Translate } from "../i18n";
import "./usage-status.css";

type UsageBucketWithRequests = UsageBucket & {
  requests?: number;
  displaySource?: AccountBucketSource;
};
type ProviderAccount = NonNullable<ProviderUsage["account"]> & {
  plan?: string;
};
interface UsageSource {
  id: string;
  kind: "aggregate" | "subscription" | "provider";
  name: string;
  detail: string;
  buckets: UsageBucketWithRequests[];
  metrics: UsageMetric[];
  requests: number | null;
  successfulRequests: number | null;
  meteredRequests: number | null;
  inputTokens: number | null;
  regularInputTokens: number | null;
  cachedInputTokens: number | null;
  // Older backends do not say whether a provider ever reported cache
  // telemetry; `null` keeps that unknown apart from a known-absent `false`.
  cacheTelemetrySeen?: boolean | null;
  outputTokens: number | null;
  totalTokens: number | null;
  last24hInputTokens: number | null;
  last24hRegularInputTokens: number | null;
  last24hCachedInputTokens: number | null;
  last24hOutputTokens: number | null;
  last24hTokens: number | null;
  last24hRequests: number | null;
  last24hMeteredRequests: number | null;
  enabled: boolean;
  accountStatus?: string;
  message?: string;
  dashboardUrl?: string;
  plan?: string;
  lifetimeTokens?: number | null;
  peakDailyTokens?: number | null;
  streakDays?: number | null;
  scopeLabel?: string;
  windowStart?: string | null;
}

// The status snapshot keeps a bounded 90-day view for fast rolling counters and
// also exposes the complete retained append-only ledger. Source rows lead with
// the retained total when that second view is available; the range picker still
// narrows the daily chart without changing the headline's all-retained scope.
const LEDGER_DAYS = 90;

interface AllowanceRow {
  id: string;
  source: UsageSource;
  metric: UsageMetric;
}

export function UsagePage({
  target,
  account,
  providerUsage,
  api,
  refreshing,
  dataReady,
  onRefresh,
  focusRequest,
  t,
}: {
  target?: RouterTarget;
  account?: AccountUsage;
  providerUsage?: ProviderUsageSnapshot;
  api?: RouterControlApi;
  refreshing: boolean;
  dataReady: RouterDataReady;
  onRefresh: () => void;
  focusRequest?: { id: number; sourceId?: string; allowance: boolean };
  t: Translate;
}) {
  const [range, setRange] = useState<7 | 30 | 90>(30);
  const [selected, setSelected] = useState("");
  const [allowanceFocused, setAllowanceFocused] = useState(false);
  const pageRef = useRef<HTMLDivElement>(null);
  const allowanceRef = useRef<HTMLElement>(null);
  const allowanceTargetRef = useRef<HTMLElement>(null);
  const handledFocusRequest = useRef<number | undefined>(undefined);

  const sources = useMemo(
    () => buildSources(t, target, account, providerUsage),
    [account, providerUsage, t, target],
  );

  useEffect(() => {
    if (selected && !sources.some((source) => source.id === selected)) setSelected("");
  }, [selected, sources]);

  // Prefer the rolling local-router stream so the headline remains useful
  // across midnight and timezone boundaries. The ChatGPT account stream stays
  // available for authoritative plan limits and calendar-day history.
  const source = sources.find((entry) => entry.id === selected)
    ?? sources.find((entry) => entry.id === "all-router")
    ?? sources.find((entry) => entry.kind === "subscription")
    ?? sources[0];

  const routerAggregate = sources.find((entry) => entry.id === "all-router");
  // The mixed display series may end in a local fallback. Keep the account
  // headline tied to OpenAI's raw stream so a router-only value is never
  // presented as the last globally reported day.
  const latestReportedBucket = source?.kind === "subscription"
    ? account?.dailyUsageBuckets?.at(-1)
    : undefined;
  const fetchedAt = source?.kind === "subscription"
    ? account?.fetchedAt
    : providerUsage?.fetchedAt;

  const buckets = useMemo(
    () => bucketsForRange(source?.buckets ?? [], range),
    [range, source?.buckets],
  );
  const bucketRequestsAvailable = buckets.some((bucket) => bucket.requests !== undefined);
  const rangeRequests = bucketRequestsAvailable
    ? buckets.reduce((sum, bucket) => sum + (bucket.requests || 0), 0)
    : null;
  const chartBreakdownAvailable = buckets.some((bucket) => tokenParts(bucket) !== null);
  const summary = source
    ? usageSummary(source, range, buckets, rangeRequests, t, latestReportedBucket)
    : [];
  const localFallbackDays = source?.kind === "subscription"
    ? buckets.filter((bucket) => bucket.displaySource === "router-fallback").length
    : 0;

  const allowances = useMemo<AllowanceRow[]>(() => {
    if (!source) return [];
    const candidates = [
      ...sources.filter((entry) => entry.id === source.id && entry.kind !== "aggregate"),
      ...sources.filter((entry) => entry.id !== source.id && entry.kind !== "aggregate"),
    ];
    return candidates.flatMap((entry) =>
      entry.metrics.map((metric, index) => ({
        id: `${entry.id}-${metric.label || metric.kind}-${index}`,
        source: entry,
        metric,
      })),
    );
  }, [source, sources]);

  // Selection focuses, it does not hide: every connected account keeps its
  // meters on the page so a routed provider can always be compared with its
  // neighbours, and the selected one is labelled rather than merely first (#824).
  const selectedAllowances = source && source.kind !== "aggregate"
    ? allowances.filter((row) => row.source.id === source.id)
    : [];
  const otherAllowances = selectedAllowances.length
    ? allowances.filter((row) => row.source.id !== source?.id)
    : allowances;

  const targetAllowanceSourceId = focusRequest?.allowance
    ? navigationSourceId(focusRequest.sourceId)
    : undefined;
  const targetAllowanceRows = targetAllowanceSourceId
    ? allowances.filter((row) => row.source.id === targetAllowanceSourceId)
    : [];
  const targetAllowanceRowId = (
    targetAllowanceRows
      .filter((row) => metricResetAt(row.metric) !== undefined)
      .sort((left, right) => metricResetAt(left.metric)! - metricResetAt(right.metric)!)[0]
    ?? targetAllowanceRows[0]
  )?.id;

  useEffect(() => {
    if (!focusRequest) return undefined;
    const preferred = navigationSourceId(focusRequest.sourceId);
    if (preferred && sources.some((entry) => entry.id === preferred)) setSelected(preferred);
    if (handledFocusRequest.current === focusRequest.id) return undefined;
    // A refresh can replace the usage rows. Let its committed data choose the
    // final target before marking this navigation request as handled.
    if (refreshing) return undefined;

    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (!focusRequest.allowance) {
      setAllowanceFocused(false);
      const scrollTimer = window.setTimeout(() => {
        pageRef.current?.scrollIntoView({ behavior: reducedMotion ? "auto" : "smooth", block: "start" });
        pageRef.current?.focus({ preventScroll: true });
        handledFocusRequest.current = focusRequest.id;
      }, 80);
      return () => window.clearTimeout(scrollTimer);
    }

    const preferredSource = preferred
      ? sources.find((entry) => entry.id === preferred)
      : undefined;
    if (preferredSource?.metrics.length && !allowanceTargetRef.current) return undefined;
    if (!allowanceTargetRef.current && !allowanceRef.current) return undefined;

    const focusAllowance = () => {
      const focusTarget = allowanceTargetRef.current ?? allowanceRef.current;
      if (!focusTarget) return false;
      focusTarget.scrollIntoView({ behavior: reducedMotion ? "auto" : "smooth", block: "center" });
      focusTarget.focus({ preventScroll: true });
      return true;
    };

    setAllowanceFocused(true);
    const scrollTimer = window.setTimeout(() => {
      // Selection and layout changes can replace a card between scheduling and
      // execution. Resolve the ref again rather than focusing a detached node.
      if (focusAllowance()) handledFocusRequest.current = focusRequest.id;
    }, 80);
    return () => window.clearTimeout(scrollTimer);
  }, [allowances.length, focusRequest, refreshing, sources, targetAllowanceRowId]);

  useEffect(() => {
    if (!allowanceFocused) return undefined;
    const clearTimer = window.setTimeout(() => setAllowanceFocused(false), 1_800);
    return () => window.clearTimeout(clearTimer);
  }, [allowanceFocused, focusRequest?.id]);

  const dashboardSources = useMemo(() => {
    const candidates = sources.filter((entry) => entry.kind !== "aggregate");
    return candidates.filter((entry, index, all) =>
      Boolean(entry.dashboardUrl)
      && all.findIndex((candidate) => candidate.dashboardUrl === entry.dashboardUrl) === index,
    );
  }, [source, sources]);

  return (
    <div ref={pageRef} tabIndex={-1} aria-label="Usage overview" className="usage-status-page usage-page">
      <PageHeader
        eyebrow="Allowance and traffic"
        title="Usage"
        description={`Account limits and balances stay separate from traffic measured by this router.${fetchedAt ? ` Snapshot fetched ${formatDateTime(fetchedAt)}.` : ""}`}
        onRefresh={onRefresh}
        refreshing={refreshing}
        actions={sources.length ? (
          <label className="us-source-select">
            <span>View</span>
            <select
              aria-label="Usage source"
              value={source?.id || ""}
              onChange={(event) => setSelected(event.target.value)}
            >
              {sources.map((entry) => (
                <option key={entry.id} value={entry.id}>{entry.name}</option>
              ))}
            </select>
          </label>
        ) : undefined}
      />

      {!source ? (
        !dataReady.snapshot || !dataReady.accountUsage || !dataReady.providerUsage ? <UsageLoading /> : (
          <EmptyState
            icon={<BarChart3 size={22} />}
            title="No usage sources available"
            body="Connect a provider or sign in to ChatGPT, then refresh usage."
          />
        )
      ) : (
        <>
          <UsageSummary items={summary} />
          <AggregateLedgerNote source={source} />

          <div className="us-primary-grid">
            <section className="panel-section us-chart-panel">
              <SectionHeading
                title={source.kind === "subscription"
                  ? localFallbackDays > 0 ? t("usage.fallback.chartTitle") : "Daily account tokens"
                  : "Daily router traffic"}
                description={source.kind === "subscription"
                  ? localFallbackDays > 0
                    ? t(
                        localFallbackDays === 1
                          ? "usage.fallback.chartDescriptionOne"
                          : "usage.fallback.chartDescription",
                        { name: source.name, count: localFallbackDays },
                      )
                    : chartBreakdownAvailable
                      ? `${source.name}, shown over the selected local date range with the reported input/cache/output split.`
                      : `${source.name}, shown over the selected local date range. The account API reports daily totals only.`
                  : `${source.name}, shown over the selected local date range. Router bars split regular input, cached input, and output.`}
                action={<RangePicker value={range} onChange={setRange} />}
              />
              {buckets.some((bucket) => bucket.tokens > 0) ? (
                <UsageChart
                  buckets={buckets}
                  sourceKind={source.kind}
                  t={t}
                />
              ) : (
                <div className="us-chart-empty">
                  <EmptyState
                    icon={<BarChart3 size={20} />}
                    title="No traffic in this range"
                    body={source.kind === "subscription"
                      ? "ChatGPT has not reported token usage for these dates."
                      : "No token usage was observed by the local router for these dates."}
                  />
                </div>
              )}
              <UsageChartHint sourceKind={source.kind} buckets={buckets} range={range} />
              <TokenMix source={source} buckets={buckets} range={range} />
              <div className="us-chart-caption">
                <span>{formatBucketDate(buckets[0]?.startDate)}</span>
                <span>{formatBucketDate(buckets.at(-1)?.startDate)}</span>
              </div>
              {source.kind === "subscription" && routerAggregate ? (
                <p className="us-live-note" role="status">
                  <strong>
                    {routerAggregate.last24hTokens == null
                      ? "Router traffic for the last 24 hours: not measured."
                      : `Router observed in the last 24 hours: ${exactNumber(routerAggregate.last24hTokens)} tokens.`}
                  </strong>
                  <span>
                    {routerAggregate.last24hTokens == null
                      ? "This install's router is not reporting a rolling 24-hour window, so the figure is missing rather than zero."
                      : "This is live local Codex traffic and is separate from ChatGPT's calendar-day account rollup."}
                  </span>
                </p>
              ) : null}
            </section>

            <section
              ref={allowanceRef}
              tabIndex={-1}
              aria-label="Accounts and allowances"
              className={`panel-section us-allowance-panel${allowanceFocused ? " is-navigation-focus" : ""}`}
            >
              <SectionHeading
                title="Accounts and allowances"
                description="Official quota windows and balances for every connected account."
              />
              {allowances.length ? (
                <>
                  {selectedAllowances.length ? (
                    <>
                      <p className="us-source-group-label">Selected · {source.name}</p>
                      <div className="us-metric-stack" aria-label={`${source.name} allowances`}>
                        {selectedAllowances.map((row) => (
                          <MetricCard
                            key={row.id}
                            source={row.source.name}
                            metric={row.metric}
                            cardRef={row.id === targetAllowanceRowId ? allowanceTargetRef : undefined}
                            navigationFocused={allowanceFocused && row.id === targetAllowanceRowId}
                          />
                        ))}
                      </div>
                      {otherAllowances.length ? (
                        <p className="us-source-group-label">Other connected accounts</p>
                      ) : null}
                    </>
                  ) : null}
                  {otherAllowances.length || !dataReady.accountUsage || !dataReady.providerUsage ? (
                    <div className="us-metric-stack" aria-label={selectedAllowances.length ? "Other account allowances" : "Account allowances"}>
                      {otherAllowances.map((row) => (
                        <MetricCard
                          key={row.id}
                          source={row.source.name}
                          metric={row.metric}
                          cardRef={row.id === targetAllowanceRowId ? allowanceTargetRef : undefined}
                          navigationFocused={allowanceFocused && row.id === targetAllowanceRowId}
                        />
                      ))}
                      {!dataReady.accountUsage || !dataReady.providerUsage ? (
                        <SkeletonBlock className="us-loading-metric" />
                      ) : null}
                    </div>
                  ) : null}
                </>
              ) : !dataReady.accountUsage || !dataReady.providerUsage ? (
                <PanelSkeleton label="Loading account allowances" count={2} />
              ) : (
                <EmptyState
                  icon={<Gauge size={20} />}
                  title="No account meter available"
                  body={source.message || "Local traffic remains available without estimating a quota."}
                />
              )}
              {dashboardSources.length ? (
                <div className="us-dashboard-links">
                  {dashboardSources.map((entry) => (
                    <Button
                      key={entry.id}
                      variant="ghost"
                      disabled={!api}
                      onClick={() => api && void api.openExternal(entry.dashboardUrl!)}
                    >
                      {entry.name} dashboard
                      <ArrowUpRight aria-hidden size={13} strokeWidth={1.7} />
                    </Button>
                  ))}
                </div>
              ) : null}
            </section>
          </div>

          <div className="us-secondary-grid">
            <section className="panel-section us-source-panel">
              <SectionHeading
                title="Usage sources"
                description="Local router totals and account-reported history are shown separately."
              />
              <div className="us-source-list" role="list">
                {sources.filter((entry) => entry.kind !== "subscription").map((entry) => (
                  <SourceRow
                    key={entry.id}
                    source={entry}
                    selected={entry.id === source.id}
                    onSelect={() => setSelected(entry.id)}
                    t={t}
                  />
                ))}
                {!dataReady.providerUsage ? (
                  <>
                    <SkeletonBlock className="us-loading-source" />
                    <SkeletonBlock className="us-loading-source" />
                  </>
                ) : null}
              </div>
              {sources.some((entry) => entry.kind === "subscription") ? (
                <>
                  <p className="us-source-group-label">Account-reported · excluded from router total</p>
                  <div className="us-source-list" role="list" aria-label="Account-reported usage">
                    {sources.filter((entry) => entry.kind === "subscription").map((entry) => (
                      <SourceRow
                        key={entry.id}
                        source={entry}
                        selected={entry.id === source.id}
                        onSelect={() => setSelected(entry.id)}
                        t={t}
                      />
                    ))}
                  </div>
                </>
              ) : null}
            </section>
          </div>
        </>
      )}
    </div>
  );
}

function buildSources(
  t: Translate,
  target?: RouterTarget,
  account?: AccountUsage,
  snapshot?: ProviderUsageSnapshot,
): UsageSource[] {
  const enabled = new Set(target?.enabledProviders ?? []);
  const eventFallback = rollingEventTotals(target?.usageEvents);
  const providerSources: UsageSource[] = [];
  const currentProviders = snapshot?.providers ?? [];
  const retainedProviders = snapshot?.retained?.providers ?? [];
  const currentById = new Map(currentProviders.map((provider) => [provider.id, provider]));
  const retainedById = new Map(retainedProviders.map((provider) => [provider.id, provider]));
  const providerIds = [...new Set([
    ...currentProviders.map((provider) => provider.id),
    ...retainedProviders.map((provider) => provider.id),
  ])];
  const hasRetainedLedger = Boolean(snapshot?.retained?.from);
  const retainedScopeLabel = hasRetainedLedger ? "All retained · router" : `Last ${LEDGER_DAYS} days · router`;
  const retainedFrom = snapshot?.retained?.from ?? null;

  for (const providerId of providerIds) {
    // Lead with all retained events when the backend provides them, while
    // borrowing account metadata and rolling counters from the bounded
    // snapshot. This keeps the provider rows reconcilable with the all-router
    // lifetime total without losing the fast 24-hour view.
    const recentProvider = currentById.get(providerId);
    const provider = retainedById.get(providerId) ?? recentProvider;
    if (!provider) continue;
    const providerAccount = recentProvider?.account as ProviderAccount | undefined;
    const metrics = providerAccount?.metrics ?? [];
    const hasTrafficIn = (entry?: ProviderUsage) => Boolean(
      (entry?.requests || 0) > 0
      || (entry?.totalTokens || 0) > 0
      || (entry?.inputTokens || 0) > 0
      || (entry?.outputTokens || 0) > 0
      || (entry?.last24hRequests || 0) > 0
      || (entry?.last24hTokens || 0) > 0
      || entry?.dailyUsageBuckets?.some((bucket) =>
        (bucket.tokens || 0) > 0 || (bucket.requests || 0) > 0,
      )
      || entry?.models?.some((model) => (model.requests || 0) > 0),
    );
    const hasTraffic = Boolean(
      hasTrafficIn(provider) || hasTrafficIn(recentProvider),
    );
    const hasAccount = metrics.length > 0 || providerAccount?.status === "available";
    if (!enabled.has(provider.id) && provider.id !== "openai" && !hasTraffic && !hasAccount) continue;

    // The row below and the `chatgpt-subscription` row are two meters over one
    // quota pool, not a double count: this one is what the router measured
    // locally for native ChatGPT traffic, the other is what OpenAI reports for
    // the same signed-in account. They can never agree, because the router
    // figure counts re-sent cached prompt tokens while OpenAI's rollup is its
    // own billed accounting. Naming the meter is what keeps an operator from
    // reading one subscription as two.
    const providerName = provider.id === "openai"
      ? "ChatGPT · measured by this router"
      : provider.displayName;
    providerSources.push({
      id: `provider:${provider.id}`,
      kind: "provider",
      name: providerName,
      detail: provider.id === "openai"
        ? `Same subscription OpenAI reports below, counted here across ${hasRetainedLedger ? "all retained" : `${LEDGER_DAYS}-day`} router events; the two totals are not comparable`
        : `${provider.credentialType?.toUpperCase() || "Provider"} traffic measured by this router${hasRetainedLedger ? " across all retained events" : ""}`,
      buckets: (provider.dailyUsageBuckets ?? []) as UsageBucketWithRequests[],
      metrics,
      // Never coerce an absent field to zero. A backend that predates a
      // counter reports nothing, and "0 tokens" is indistinguishable from
      // genuinely idle -- which is exactly how a version-skewed install reads
      // as "no traffic" to someone who has been routing all day.
      requests: provider.requests ?? null,
      successfulRequests: provider.successfulRequests ?? null,
      meteredRequests: provider.meteredRequests ?? null,
      inputTokens: provider.inputTokens ?? null,
      regularInputTokens: provider.regularInputTokens ?? null,
      cachedInputTokens: provider.cachedInputTokens ?? null,
      cacheTelemetrySeen: provider.cacheTelemetrySeen ?? null,
      outputTokens: provider.outputTokens ?? null,
      totalTokens: provider.totalTokens ?? null,
      last24hInputTokens: recentProvider?.last24hInputTokens ?? provider.last24hInputTokens ?? null,
      last24hRegularInputTokens: recentProvider?.last24hRegularInputTokens ?? provider.last24hRegularInputTokens ?? null,
      last24hCachedInputTokens: recentProvider?.last24hCachedInputTokens ?? provider.last24hCachedInputTokens ?? null,
      last24hOutputTokens: recentProvider?.last24hOutputTokens ?? provider.last24hOutputTokens ?? null,
      last24hTokens: recentProvider?.last24hTokens ?? provider.last24hTokens ?? null,
      last24hRequests: recentProvider?.last24hRequests ?? provider.last24hRequests ?? null,
      last24hMeteredRequests: recentProvider?.last24hMeteredRequests ?? provider.last24hMeteredRequests ?? null,
      enabled: provider.id === "openai" || enabled.has(provider.id),
      accountStatus: providerAccount?.status,
      message: providerAccount?.message,
      dashboardUrl: providerAccount?.dashboardUrl,
      plan: providerAccount?.plan,
      scopeLabel: retainedScopeLabel,
      windowStart: retainedFrom,
    });
  }

  const result: UsageSource[] = [];
  if (snapshot) {
    const reportedLast24Tokens = sumNullable(providerSources.map((source) => source.last24hTokens));
    const aggregateLast24 = {
      inputTokens: sumNullable(providerSources.map((source) => source.last24hInputTokens))
        ?? eventFallback?.inputTokens
        ?? null,
      regularInputTokens: sumNullable(providerSources.map((source) => source.last24hRegularInputTokens))
        ?? eventFallback?.regularInputTokens
        ?? null,
      cachedInputTokens: sumNullable(providerSources.map((source) => source.last24hCachedInputTokens))
        ?? eventFallback?.cachedInputTokens
        ?? null,
      outputTokens: sumNullable(providerSources.map((source) => source.last24hOutputTokens))
        ?? eventFallback?.outputTokens
        ?? null,
      tokens: reportedLast24Tokens
        ?? eventFallback?.tokens
        ?? null,
      requests: sumNullable(providerSources.map((source) => source.last24hRequests))
        ?? eventFallback?.requests
        ?? null,
      meteredRequests: sumNullable(providerSources.map((source) => source.last24hMeteredRequests))
        ?? eventFallback?.meteredRequests
        ?? null,
    };
    result.push({
      id: "all-router",
      kind: "aggregate",
      name: "This router · all providers",
      detail: `Sum of every provider measured by this router over its local ledger; excludes account usage reported by providers${reportedLast24Tokens == null && eventFallback?.tokens != null ? "; rolling window uses bounded event details until provider counters are available" : ""}`,
      buckets: mergeBuckets(providerSources.map((source) => source.buckets)),
      metrics: [],
      requests: sumNullable(providerSources.map((source) => source.requests)),
      successfulRequests: sumNullable(providerSources.map((source) => source.successfulRequests)),
      meteredRequests: sumNullable(providerSources.map((source) => source.meteredRequests)),
      inputTokens: sumNullable(providerSources.map((source) => source.inputTokens)),
      regularInputTokens: sumNullable(providerSources.map((source) => source.regularInputTokens)),
      cachedInputTokens: sumNullable(providerSources.map((source) => source.cachedInputTokens)),
      cacheTelemetrySeen: providerSources.some((source) => source.cacheTelemetrySeen === true)
        ? true
        : providerSources.every((source) => source.cacheTelemetrySeen === false) ? false : null,
      outputTokens: sumNullable(providerSources.map((source) => source.outputTokens)),
      totalTokens: sumNullable(providerSources.map((source) => source.totalTokens)),
      last24hInputTokens: aggregateLast24.inputTokens,
      last24hRegularInputTokens: aggregateLast24.regularInputTokens,
      last24hCachedInputTokens: aggregateLast24.cachedInputTokens,
      last24hOutputTokens: aggregateLast24.outputTokens,
      last24hTokens: aggregateLast24.tokens,
      last24hRequests: aggregateLast24.requests,
      last24hMeteredRequests: aggregateLast24.meteredRequests,
      enabled: true,
      accountStatus: "local-router",
      scopeLabel: retainedScopeLabel,
      windowStart: retainedFrom,
    });
  }

  if (account) {
    const localOpenAiBuckets = providerSources.find((entry) => entry.id === "provider:openai")?.buckets ?? [];
    const accountBuckets = accountBucketsWithRouterFallback(
      account.dailyUsageBuckets ?? [],
      localOpenAiBuckets,
    );
    const fallbackDays = accountBuckets.filter((bucket) => bucket.displaySource === "router-fallback").length;
    result.push({
      id: "chatgpt-subscription",
      kind: "subscription",
      name: fallbackDays > 0
        ? t("usage.fallback.source")
        : "ChatGPT account · reported by OpenAI",
      detail: account.planType
        ? fallbackDays > 0
          ? `${friendlyPlanName(account.planType)} plan · ${t(
              fallbackDays === 1 ? "usage.fallback.detailOne" : "usage.fallback.detail",
              { count: fallbackDays },
            )}`
          : `${friendlyPlanName(account.planType)} plan · account-level usage as OpenAI reports it; this view is not added to the all-router total`
        : fallbackDays > 0
          ? t(fallbackDays === 1 ? "usage.fallback.detailOne" : "usage.fallback.detail", { count: fallbackDays })
          : "Account-level usage as OpenAI reports it; this view is not added to the all-router total",
      buckets: accountBuckets,
      metrics: codexAccountMetrics(account),
      requests: null,
      successfulRequests: null,
      meteredRequests: null,
      inputTokens: null,
      regularInputTokens: null,
      cachedInputTokens: null,
      outputTokens: null,
      totalTokens: account.summary?.lifetimeTokens ?? null,
      last24hInputTokens: null,
      last24hRegularInputTokens: null,
      last24hCachedInputTokens: null,
      last24hOutputTokens: null,
      last24hTokens: null,
      last24hRequests: null,
      last24hMeteredRequests: null,
      enabled: true,
      accountStatus: "available",
      plan: account.planType,
      lifetimeTokens: account.summary?.lifetimeTokens ?? null,
      peakDailyTokens: account.summary?.peakDailyTokens ?? null,
      streakDays: account.summary?.currentStreakDays ?? null,
    });
  }

  // Keep the two ChatGPT meters next to each other so one subscription seen
  // twice never reads as two unrelated accounts.
  result.push(
    ...providerSources.filter((entry) => entry.id === "provider:openai"),
    ...providerSources.filter((entry) => entry.id !== "provider:openai"),
  );
  return result;
}

function usageSummary(
  source: UsageSource,
  range: number,
  rangeBuckets: UsageBucketWithRequests[],
  rangeRequests: number | null,
  t: Translate,
  latestReportedBucket?: UsageBucketWithRequests,
): Array<{ label: string; value: string; detail: string; tone?: TokenTone }> {
  const rangeTokens = rangeBuckets.reduce((sum, bucket) => sum + bucket.tokens, 0);
  if (source.kind === "subscription") {
    const latestTokens = latestReportedBucket?.tokens;
    const fallbackTokens = rangeBuckets
      .filter((bucket) => bucket.displaySource === "router-fallback")
      .reduce((sum, bucket) => sum + bucket.tokens, 0);
    const fallbackDays = rangeBuckets
      .filter((bucket) => bucket.displaySource === "router-fallback").length;
    const accountTokens = rangeTokens - fallbackTokens;
    return [
      {
        label: "Last reported day",
        value: latestTokens == null ? "Not reported" : compactNumber(latestTokens),
        detail: latestReportedBucket
          ? `${exactNumber(latestTokens)} account tokens · ${formatBucketDate(latestReportedBucket.startDate)}`
          : "ChatGPT has not published a daily bucket",
      },
      {
        label: `Last ${range} days`,
        value: compactNumber(rangeTokens),
        detail: fallbackDays > 0
          ? t("usage.fallback.summary", {
              total: exactNumber(rangeTokens),
              account: exactNumber(accountTokens),
              fallback: exactNumber(fallbackTokens),
            })
          : `${exactNumber(rangeTokens)} account tokens`,
      },
      { label: "Account lifetime", value: optionalCompact(source.lifetimeTokens), detail: "Reported by OpenAI" },
      { label: "Peak day", value: optionalCompact(source.peakDailyTokens), detail: "Account history" },
      { label: "Current streak", value: source.streakDays == null ? "Not reported" : `${source.streakDays} days`, detail: "Account activity" },
      { label: "Plan", value: source.plan ? friendlyPlanName(source.plan) : "Not reported", detail: "Signed-in account" },
    ];
  }

  const successRate = source.requests && source.successfulRequests != null
    ? (source.successfulRequests / source.requests) * 100
    : null;
  const cacheHitRate = source.cacheTelemetrySeen === false
    ? null
    : cacheHitRatePercent(source.cachedInputTokens, source.inputTokens);
  const last24hTokens = source.last24hTokens;
  const last24hRequests = source.last24hRequests;
  const last24hMeteredRequests = source.last24hMeteredRequests;
  const routerScope = source.scopeLabel || `Last ${LEDGER_DAYS} days · router`;
  const items: Array<{ label: string; value: string; detail: string; tone?: TokenTone }> = [
    ...(source.kind === "aggregate" ? [{
      label: "This router total",
      value: optionalCompact(source.totalTokens),
      detail: `Sum of every provider row · ${routerScope}`,
      tone: "total" as const,
    }] : []),
    {
      label: "Last 24 hours",
      value: last24hTokens == null ? "Not measured" : compactNumber(last24hTokens),
      detail: last24hTokens == null
        ? "Rolling router window unavailable"
        : `${exactNumber(last24hTokens)} router tokens${last24hRequests == null ? "" : ` · ${exactNumber(last24hRequests)} requests`}${last24hMeteredRequests == null || last24hMeteredRequests === last24hRequests ? "" : ` · ${exactNumber(last24hMeteredRequests)} metered`}`,
    },
    {
      label: `Last ${range} days`,
      value: compactNumber(rangeTokens),
      detail: `${exactNumber(rangeTokens)} router tokens · selected range`,
    },
    {
      label: "Requests",
      value: rangeRequests == null ? optionalCompact(source.requests) : compactNumber(rangeRequests),
      detail: rangeRequests == null
        ? `${routerScope} · not this range`
        : `Selected ${range}-day range`,
    },
    {
      label: "Regular input",
      value: optionalCompact(source.regularInputTokens),
      detail: `${routerScope} · cache excluded`,
      tone: "regular" as const,
    },
    {
      label: "Cached input",
      value: cacheHitRate == null
        ? optionalCompact(source.cachedInputTokens)
        : `${compactNumber(source.cachedInputTokens!)} (${formatPercent(cacheHitRate)})`,
      detail: cacheHitRate == null
        ? `${routerScope} · hit rate not reported`
        : `${routerScope} · ${formatPercent(cacheHitRate)} of reported input`,
      tone: "cached" as const,
    },
    {
      label: "Output",
      value: optionalCompact(source.outputTokens),
      detail: `${routerScope} · not this range`,
      tone: "output" as const,
    },
    {
      label: "Successful",
      value: successRate == null ? "Not measured" : `${successRate.toFixed(successRate < 99 ? 1 : 0)}%`,
      detail: source.meteredRequests == null
        ? `Router outcomes · ${routerScope}`
        : `${exactNumber(source.meteredRequests)} metered · ${routerScope}`,
    },
  ];
  return items;
}

type TokenTone = "total" | "regular" | "cached" | "output";

function UsageSummary({ items }: { items: Array<{ label: string; value: string; detail: string; tone?: TokenTone }> }) {
  const variant = items.length >= 8 ? "is-aggregate" : items.length === 7 ? "is-router" : "is-subscription";
  return (
    <dl className={`us-summary-grid ${variant}`}>
      {items.map((item) => (
        <div key={item.label} className={item.tone ? `tone-${item.tone}` : undefined}>
          <dt>{item.label}</dt>
          <dd>{item.value}</dd>
          <small title={item.detail}>{item.detail}</small>
        </div>
      ))}
    </dl>
  );
}

function AggregateLedgerNote({ source }: { source: UsageSource }) {
  if (source.kind !== "aggregate") return null;
  const input = source.inputTokens;
  const regular = source.regularInputTokens;
  const cached = source.cachedInputTokens;
  const output = source.outputTokens;
  const total = source.totalTokens;
  const scope = source.scopeLabel || `Last ${LEDGER_DAYS} days · router`;
  const since = source.windowStart ? ` since ${source.windowStart.slice(0, 10)}` : "";
  return (
    <div className="us-aggregate-note" role="status">
      <strong>This router total is the sum of every measured provider row.</strong>
      <span>
        {total == null
          ? "The aggregate is not reported because at least one provider is missing a counter."
          : `${exactNumber(total)} tokens in ${scope.toLowerCase()}${since}${input == null || output == null ? "." : ` = ${exactNumber(input)} input + ${exactNumber(output)} output.`}`}
        {regular != null && cached != null
          ? ` Input is split into ${exactNumber(regular)} regular and ${exactNumber(cached)} cached; cached input is a subset of input, not an extra total.`
          : " Input/cache split is not reported by every provider yet."}
      </span>
    </div>
  );
}

function TokenMix({ source, buckets, range }: {
  source: UsageSource;
  buckets: UsageBucketWithRequests[];
  range: 7 | 30 | 90;
}) {
  const completeRangeMix = hasCompleteTokenBreakdown(buckets)
    && (source.kind !== "subscription"
      || !buckets.some((bucket) => bucket.displaySource === "router-fallback"));
  const bucketMix = buckets.reduce((totals, bucket) => {
    const parts = tokenParts(bucket);
    if (!parts) return totals;
    totals.regular += parts.find((part) => part.tone === "regular-input")?.tokens ?? 0;
    totals.cached += parts.find((part) => part.tone === "cached-input")?.tokens ?? 0;
    totals.output += parts.find((part) => part.tone === "output")?.tokens ?? 0;
    return totals;
  }, { regular: 0, cached: 0, output: 0 });
  const input = source.kind === "subscription" ? null : source.last24hInputTokens;
  const recentRegular = source.kind === "subscription"
    ? null
    : source.last24hRegularInputTokens
      ?? (input != null && source.last24hCachedInputTokens != null
        ? Math.max(0, input - source.last24hCachedInputTokens)
        : null);
  const recentCached = source.kind === "subscription" ? null : source.last24hCachedInputTokens;
  const recentOutput = source.kind === "subscription" ? null : source.last24hOutputTokens;
  const regular = completeRangeMix ? bucketMix.regular : recentRegular;
  const cached = completeRangeMix ? bucketMix.cached : recentCached;
  const output = completeRangeMix ? bucketMix.output : recentOutput;
  if (regular == null && cached == null && output == null) return null;
  const scope = completeRangeMix ? `selected ${range}-day range` : "last 24h";
  const rows = [
    { label: "Regular input", value: regular, tone: "regular" as const },
    { label: "Cached input", value: cached, tone: "cached" as const },
    { label: "Output", value: output, tone: "output" as const },
  ];
  return (
    <div className="us-token-mix" aria-label={`Token mix for ${scope}`}>
      {rows.map((row) => (
        <div key={row.label} className={`tone-${row.tone}`}>
          <span>{row.label}</span>
          <strong>{row.value == null ? "Not reported" : exactNumber(row.value)}</strong>
          <small>{scope}</small>
        </div>
      ))}
    </div>
  );
}

function RangePicker({ value, onChange }: {
  value: 7 | 30 | 90;
  onChange: (value: 7 | 30 | 90) => void;
}) {
  return (
    <div className="us-range-picker" role="radiogroup" aria-label="Usage date range">
      {([7, 30, 90] as const).map((days) => (
        <button
          type="button"
          key={days}
          role="radio"
          aria-checked={value === days}
          className={value === days ? "is-active" : ""}
          onClick={() => onChange(days)}
        >
          {days}D
        </button>
      ))}
    </div>
  );
}

function UsageChart({ buckets, sourceKind, t }: {
  buckets: UsageBucketWithRequests[];
  sourceKind: UsageSource["kind"];
  t: Translate;
}) {
  const width = 840;
  const height = 228;
  const paddingX = 14;
  const paddingY = 15;
  const tokenMax = Math.max(...buckets.map((bucket) => bucket.tokens), 1);
  const innerWidth = width - paddingX * 2;
  const innerHeight = height - paddingY * 2;
  const barSlot = innerWidth / Math.max(1, buckets.length);
  const barWidth = Math.max(2, Math.min(9, barSlot * 0.45));
  const breakdownAvailable = buckets.some((bucket) => tokenParts(bucket) !== null);
  const fallbackDays = buckets.filter((bucket) => bucket.displaySource === "router-fallback").length;
  const sourceLabel = sourceKind === "subscription" ? "Daily account" : "Daily router";
  const breakdownLabel = breakdownAvailable
    ? " split into regular input, cached input, and output"
    : " shown as account totals";
  const ariaLabel = fallbackDays > 0
    ? t(fallbackDays === 1 ? "usage.fallback.chartAriaOne" : "usage.fallback.chartAria", { count: fallbackDays })
    : `${sourceLabel} token usage${breakdownLabel}`;

  return (
    <div
      className="us-chart-wrap"
      role="group"
      aria-label={ariaLabel}
    >
      <div className="us-chart-legend" aria-hidden="true">
        {breakdownAvailable ? (
          <>
            {sourceKind === "subscription" && fallbackDays > 0 ? <span className="is-account">Account total</span> : null}
            <span className="is-regular">Regular input</span>
            <span className="is-cached">Cached input</span>
            <span className="is-output">Output</span>
          </>
        ) : <span className={sourceKind === "subscription" ? "is-account" : "is-token"}>{sourceKind === "subscription" ? "Account total" : "Tokens"}</span>}
        {fallbackDays > 0 ? <span className="is-router-fallback">{t("usage.fallback.legend")}</span> : null}
      </div>
      <div className="us-chart-scale" aria-hidden="true">
        <strong>{compactNumber(tokenMax)}</strong>
        <span>0</span>
      </div>
      <svg viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" aria-hidden="true">
        <g className="us-chart-grid">
          {[0.25, 0.5, 0.75, 1].map((ratio) => (
            <line
              key={ratio}
              x1="0"
              x2={width}
              y1={height - paddingY - innerHeight * ratio}
              y2={height - paddingY - innerHeight * ratio}
            />
          ))}
        </g>
        <g className="us-chart-token-bars">
          {buckets.map((bucket, index) => {
            const x = paddingX + index * barSlot + barSlot / 2 - barWidth / 2;
            const parts = breakdownAvailable ? tokenParts(bucket) : null;
            if (!parts) {
              const barHeight = (bucket.tokens / tokenMax) * innerHeight;
              return (
                <rect
                  key={`${bucket.startDate}-tokens`}
                  className={classNames(
                    "total",
                    bucket.displaySource === "router-fallback" && "router-fallback",
                  )}
                  x={x}
                  y={height - paddingY - barHeight}
                  width={barWidth}
                  height={Math.max(bucket.tokens ? 2 : 0, barHeight)}
                  rx="2"
                >
                  <title>{`${formatBucketDate(bucket.startDate)}: ${exactNumber(bucket.tokens)} tokens`}</title>
                </rect>
              );
            }
            let consumed = 0;
            return (
              <g key={`${bucket.startDate}-tokens`}>
                {parts.map((part) => {
                  const barHeight = (part.tokens / tokenMax) * innerHeight;
                  const y = height - paddingY - consumed - barHeight;
                  consumed += barHeight;
                  if (barHeight <= 0) return null;
                  return (
                    <rect
                      key={`${bucket.startDate}-${part.tone}`}
                      className={classNames(
                        part.tone,
                        bucket.displaySource === "router-fallback" && "router-fallback",
                      )}
                      x={x}
                      y={y}
                      width={barWidth}
                      height={Math.max(1, barHeight)}
                      rx={part.tone === "output" || part.tone === "other" ? "1" : "0"}
                    >
                      <title>{`${formatBucketDate(bucket.startDate)}: ${exactNumber(part.tokens)} ${part.label}`}</title>
                    </rect>
                  );
                })}
              </g>
            );
          })}
        </g>
      </svg>
      <div
        className="us-chart-hit-grid"
        style={{
          gridTemplateColumns: `repeat(${Math.max(1, buckets.length)}, minmax(0, 1fr))`,
          left: `${(paddingX / width) * 100}%`,
          right: `${(paddingX / width) * 100}%`,
        }}
      >
        {buckets.map((bucket, index) => {
          const parts = tokenParts(bucket);
          const breakdownItems = parts?.filter((part) => part.tokens > 0)
            .map((part) => `${part.label}: ${exactNumber(part.tokens)}`) ?? [];
          const label = [
            `${formatBucketDate(bucket.startDate)}.`,
            `Total: ${exactNumber(bucket.tokens)} tokens.`,
            ...(bucket.displaySource === "router-fallback"
              ? [t("usage.fallback.point")]
              : []),
            ...breakdownItems.map((item) => `${item}.`),
          ].join(" ");
          const edge = buckets.length === 1
            ? "single"
            : index === 0
              ? "start"
              : index === buckets.length - 1
                ? "end"
                : undefined;
          return (
            <button
              type="button"
              key={bucket.startDate}
              aria-label={label}
              data-edge={edge}
            >
              <ChartTooltip bucket={bucket} parts={parts} sourceKind={sourceKind} t={t} />
            </button>
          );
        })}
      </div>
    </div>
  );
}

function UsageChartHint({ sourceKind, buckets, range }: {
  sourceKind: UsageSource["kind"];
  buckets: UsageBucketWithRequests[];
  range: 7 | 30 | 90;
}) {
  const breakdownComplete = hasCompleteTokenBreakdown(buckets)
    && (sourceKind !== "subscription"
      || !buckets.some((bucket) => bucket.displaySource === "router-fallback"));
  if (sourceKind === "subscription") {
    return (
      <p className="us-chart-hint is-account" role="note">
        <strong>Account graph</strong>
        <span>
          {breakdownComplete
            ? `The account API supplied the input/cache/output split for this ${range}-day range.`
            : "OpenAI supplies daily account totals only here; use “This router · all providers” for regular input, cached input, and output."}
        </span>
      </p>
    );
  }
  return (
    <p className="us-chart-hint" role="note">
      <strong>Token key</strong>
      <span>
        {breakdownComplete
          ? "Cached input is a subset of input, so it is shown as its own color and is not added a second time."
          : "This router snapshot did not report an input/cache/output split for the selected range."}
      </span>
    </p>
  );
}

type TokenPart = { tone: "regular-input" | "cached-input" | "output" | "other"; label: string; tokens: number };

function tokenParts(bucket: UsageBucketWithRequests): TokenPart[] | null {
  const hasBreakdown = bucket.inputTokens !== undefined
    || bucket.cachedInputTokens !== undefined
    || bucket.outputTokens !== undefined;
  if (!hasBreakdown) return null;
  const inputReported = bucket.inputTokens !== undefined;
  const input = Math.max(0, Number(bucket.inputTokens) || 0);
  const rawCached = Math.max(0, Number(bucket.cachedInputTokens) || 0);
  const cached = inputReported ? Math.min(input, rawCached) : Math.min(bucket.tokens, rawCached);
  const regular = Math.max(0, input - cached);
  const output = Math.max(0, Number(bucket.outputTokens) || 0);
  const other = Math.max(0, bucket.tokens - regular - cached - output);
  return [
    { tone: "regular-input", label: "regular input", tokens: regular },
    { tone: "cached-input", label: "cached input", tokens: cached },
    { tone: "output", label: "output", tokens: output },
    { tone: "other", label: "unattributed tokens", tokens: other },
  ];
}

// A range-level mix can claim the selected scope only when every day carrying
// tokens has a split. Padded zero days need no split, but one account-total or
// fallback-only partial bucket makes an aggregate input/cache/output sum
// incomplete and therefore unsafe to label as the whole range.
function hasCompleteTokenBreakdown(buckets: UsageBucketWithRequests[]): boolean {
  const tokenBuckets = buckets.filter((bucket) => bucket.tokens > 0);
  return tokenBuckets.length > 0
    && tokenBuckets.every((bucket) => tokenParts(bucket) !== null);
}

function ChartTooltip({ bucket, parts, sourceKind, t }: {
  bucket: UsageBucketWithRequests;
  parts: TokenPart[] | null;
  sourceKind: UsageSource["kind"];
  t: Translate;
}) {
  const visibleParts = parts?.filter((part) => part.tokens > 0) ?? [];
  const hasRows = visibleParts.length > 0;
  return (
    <span className="us-chart-tooltip" aria-hidden="true">
      <span className="us-chart-tooltip-date">{formatBucketDate(bucket.startDate)}</span>
      <strong className="us-chart-tooltip-total">{compactNumber(bucket.tokens).toUpperCase()} tokens</strong>
      <span className="us-chart-tooltip-exact">{exactNumber(bucket.tokens)} total tokens</span>
      {hasRows ? (
        <span className="us-chart-tooltip-rows">
          {visibleParts.map((part) => (
            <span className={`us-chart-tooltip-row is-${part.tone}`} key={part.tone}>
              <i aria-hidden="true" />
              <span>{part.label}</span>
              <strong>{exactNumber(part.tokens)}</strong>
            </span>
          ))}
        </span>
      ) : bucket.displaySource !== "router-fallback" ? (
        <span className="us-chart-tooltip-note">
          {sourceKind === "subscription"
            ? "The account API reports a daily total for this day; input, cached input, and output are not available."
            : "Input and output details were not reported for this day."}
        </span>
      ) : null}
      {bucket.displaySource === "router-fallback" ? (
        <span className="us-chart-tooltip-note is-router-fallback">
          {t("usage.fallback.tooltip")}
        </span>
      ) : null}
    </span>
  );
}

function MetricCard({ source, metric, cardRef, navigationFocused = false }: {
  source: string;
  metric: UsageMetric;
  cardRef?: Ref<HTMLElement>;
  navigationFocused?: boolean;
}) {
  const remaining = remainingPercent(metric);
  const tone = remaining !== null && remaining < 15
    ? "danger"
    : remaining !== null && remaining < 35
      ? "warning"
      : "neutral";
  const reset = metricResetAt(metric);
  const label = metric.label || (metric.kind === "balance" ? "Balance" : "Usage limit");
  const resetLabel = reset !== undefined
    ? `Resets ${formatDateTime(reset)} (${resetCountdown(reset)})`
    : "No reset reported";
  return (
    <article
      ref={cardRef}
      tabIndex={cardRef ? -1 : undefined}
      aria-label={`${source}, ${label}, ${metricValue(metric)}. ${resetLabel}`}
      className={`us-metric-card${navigationFocused ? " is-navigation-focus" : ""}`}
    >
      <header>
        <span className="us-metric-source">{source}</span>
        <Badge tone={tone}>{metricValue(metric)}</Badge>
      </header>
      <div className="us-metric-title">
        {metric.kind === "balance"
          ? <Coins aria-hidden size={15} strokeWidth={1.7} />
          : <Gauge aria-hidden size={15} strokeWidth={1.7} />}
        <strong>{label}</strong>
      </div>
      {remaining !== null ? (
        <progress
          className={`us-quota-progress tone-${tone}`}
          max="100"
          value={remaining}
          aria-label={`${metric.label || "Quota"}: ${Math.round(remaining)} percent remaining`}
        />
      ) : null}
      {metric.kind !== "balance" && hasMetricCounts(metric) ? (
        <dl className="us-metric-facts">
          <div><dt>Used</dt><dd>{formatMetricCount(metric.used, metric.unit)}</dd></div>
          <div><dt>Remaining</dt><dd>{formatMetricCount(metric.remaining, metric.unit)}</dd></div>
          <div><dt>Limit</dt><dd>{formatMetricCount(metric.limit, metric.unit)}</dd></div>
        </dl>
      ) : null}
      {metric.detail ? <p>{metric.detail}</p> : null}
      <footer>
        {reset !== undefined ? (
          <time dateTime={dateTimeValue(reset)}>
            {resetLabel}
          </time>
        ) : "No reset reported"}
      </footer>
    </article>
  );
}

function navigationSourceId(sourceId?: string): string | undefined {
  if (!sourceId) return undefined;
  // The menu-bar/widget Codex source is the account-reported stream used for
  // its graph and reset windows, not the separate traffic ledger observed by
  // this router.
  return sourceId === "openai" ? "chatgpt-subscription" : `provider:${sourceId}`;
}

function metricResetAt(metric: UsageMetric): number | undefined {
  const reset = metric.resetAt ?? metric.resetsAt;
  return Number.isFinite(reset) ? reset : undefined;
}

function SourceRow({ source, selected, onSelect, t }: {
  source: UsageSource;
  selected: boolean;
  onSelect: () => void;
  t: Translate;
}) {
  const primary = source.metrics[0];
  const isSubscription = source.kind === "subscription";
  // One column, one unit. A quota metric answers a different question than a
  // token count and cannot be added to one, so the row leads with the same
  // measure the aggregate above sums -- tokens -- and keeps the account meter
  // as a second line. Rows that add up are the whole point of the list.
  const measuredTokens = isSubscription
    ? source.buckets.length
      ? bucketsForRange(source.buckets, 7).reduce((sum, bucket) => sum + bucket.tokens, 0)
      : null
    : source.totalTokens ?? source.last24hTokens;
  const subscriptionUsesFallback = isSubscription
    && bucketsForRange(source.buckets, 7)
      .some((bucket) => bucket.displaySource === "router-fallback");
  const windowLabel = isSubscription
    ? subscriptionUsesFallback ? t("usage.fallback.lastSeven") : "Last 7 days · OpenAI"
    : source.totalTokens == null ? "Last 24 hours · router" : source.scopeLabel || `Last ${LEDGER_DAYS} days · router`;
  const recentRouterTokens = !isSubscription && source.last24hTokens != null
    ? `${compactNumber(source.last24hTokens)} tok · last 24h`
    : null;
  const status = source.kind === "aggregate"
    ? "All data"
    : isSubscription
      ? source.plan ? friendlyPlanName(source.plan) : "Signed in"
      : source.enabled ? "Enabled" : "Historical";
  const tone = source.enabled ? "success" : "neutral";
  const quota = primary ? `${metricValue(primary)} · ${primary.label || "Account meter"}` : "";
  return (
    <button
      type="button"
      role="listitem"
      className={selected ? "is-active" : ""}
      aria-pressed={selected}
      onClick={onSelect}
      title={`${source.name} — ${source.detail}${quota ? ` — ${quota}` : ""}`}
    >
      <span className="us-source-name">
        <strong>{source.name}</strong>
        <small>{source.detail}</small>
      </span>
      <span className="us-source-value">
        {/* Absent is not zero: a backend that never reported this window says
            nothing, and printing "0 tok" for it is what makes a fully booked
            day read as an idle one. */}
        <strong>{measuredTokens == null ? "Not measured" : `${compactNumber(measuredTokens)} tok`}</strong>
        <small>{windowLabel}</small>
        {recentRouterTokens ? <small>{recentRouterTokens}</small> : null}
        {quota ? <small>{quota}</small> : null}
      </span>
      <span className="us-source-badges">
        {selected ? <Badge tone="accent">Selected</Badge> : null}
        <Badge tone={tone}>{status}</Badge>
      </span>
    </button>
  );
}

function UsageLoading() {
  return (
    <div className="us-loading" role="status" aria-live="polite">
      <span className="visually-hidden">Loading account and router usage</span>
      <div className="us-loading-summary">{Array.from({ length: 7 }, (_, index) => <SkeletonBlock key={index} />)}</div>
      <div className="us-loading-panels"><SkeletonBlock /><SkeletonBlock /></div>
    </div>
  );
}

function codexAccountMetrics(account: AccountUsage): UsageMetric[] {
  const metrics: UsageMetric[] = [];
  [account.primary, account.secondary].forEach((window, index) => {
    if (!window) return;
    metrics.push({
      ...window,
      kind: "quota",
      label: limitWindowLabel(window.windowDurationMins, index),
      detail: account.planType ? `${friendlyPlanName(account.planType)} plan` : "ChatGPT account limit",
    });
  });
  return metrics;
}

function limitWindowLabel(minutes: number | undefined, index: number): string {
  if (!Number.isFinite(Number(minutes))) return index === 0 ? "Primary limit" : "Secondary limit";
  const value = Number(minutes);
  if (value >= 1_440 && value % 1_440 === 0) {
    const days = value / 1_440;
    if (days === 1) return "Daily limit";
    if (days === 7) return "Weekly limit";
    return `${days}-day limit`;
  }
  if (value >= 60 && value % 60 === 0) return `${value / 60}-hour limit`;
  return `${value}-minute limit`;
}

function mergeBuckets(groups: UsageBucketWithRequests[][]): UsageBucketWithRequests[] {
  const merged = new Map<string, UsageBucketWithRequests>();
  for (const bucket of groups.flat()) {
    const previous = merged.get(bucket.startDate) ?? {
      startDate: bucket.startDate,
      tokens: 0,
      requests: 0,
    };
    previous.tokens += Number(bucket.tokens) || 0;
    previous.requests = (previous.requests || 0) + (Number(bucket.requests) || 0);
    for (const key of ["inputTokens", "cachedInputTokens", "outputTokens"] as const) {
      if (bucket[key] !== undefined) {
        previous[key] = (previous[key] || 0) + (Number(bucket[key]) || 0);
      }
    }
    merged.set(bucket.startDate, previous);
  }
  return [...merged.values()].sort((left, right) => left.startDate.localeCompare(right.startDate));
}

function bucketsForRange(buckets: UsageBucketWithRequests[], days: number): UsageBucketWithRequests[] {
  const dates = bucketRange(buckets, days) as UsageBucketWithRequests[];
  const requests = new Map(buckets.map((bucket) => [bucket.startDate, bucket.requests]));
  const hasRequestData = buckets.some((bucket) => bucket.requests !== undefined);
  const hasDisplaySources = buckets.some((bucket) => bucket.displaySource !== undefined);
  return dates.map((bucket) => ({
    ...bucket,
    ...(hasRequestData && (!hasDisplaySources || bucket.displaySource === "router-fallback")
      ? { requests: Number(requests.get(bucket.startDate)) || 0 }
      : {}),
  }));
}

// A mixed-version snapshot -- one provider reporting a counter another has
// never heard of -- used to silently drop the missing rows and present the
// remainder as the total. An aggregate that omits contributors is worse than no
// aggregate, so any missing contributor makes the whole figure unmeasured.
function sumNullable(values: Array<number | null>): number | null {
  if (!values.length || values.some((value) => value == null)) return null;
  return values.reduce<number>((total, value) => total + (value as number), 0);
}

// Older installed routers expose the bounded event stream but not the newer
// provider-level rolling counters. Keep the aggregate useful during that
// version skew; this fallback is intentionally labelled in the source detail
// because the event stream is capped by the control snapshot.
function rollingEventTotals(events: UsageEvent[] | undefined, now = Date.now()): {
  requests: number;
  meteredRequests: number;
  inputTokens: number | null;
  regularInputTokens: number | null;
  cachedInputTokens: number | null;
  outputTokens: number | null;
  tokens: number | null;
} | null {
  if (!events) return null;
  const cutoff = now - 24 * 60 * 60 * 1_000;
  let requests = 0;
  let meteredRequests = 0;
  let measured = false;
  let cacheTelemetry = false;
  let inputTokens = 0;
  let regularInputTokens = 0;
  let cachedInputTokens = 0;
  let outputTokens = 0;
  let tokens = 0;
  for (const event of events) {
    const at = Date.parse(event.at);
    if (!Number.isFinite(at) || at < cutoff || at > now) continue;
    requests += 1;
    const input = optionalEventNumber(event.billedInputTokens ?? event.inputTokens);
    const output = optionalEventNumber(event.billedOutputTokens ?? event.outputTokens);
    const explicitTotal = optionalEventNumber(event.totalTokens);
    if (input === null && output === null && explicitTotal === null) continue;
    meteredRequests += 1;
    measured = true;
    const inputValue = input ?? 0;
    const cached = optionalEventNumber(event.cachedInputTokens);
    const cachedValue = cached === null
      ? 0
      : input === null ? cached : Math.min(inputValue, cached);
    inputTokens += inputValue;
    regularInputTokens += Math.max(0, inputValue - cachedValue);
    cachedInputTokens += cachedValue;
    outputTokens += output ?? 0;
    tokens += explicitTotal ?? inputValue + (output ?? 0);
    if (cached !== null) cacheTelemetry = true;
  }
  return {
    requests,
    meteredRequests,
    inputTokens: measured ? inputTokens : null,
    regularInputTokens: measured ? regularInputTokens : null,
    cachedInputTokens: measured && cacheTelemetry ? cachedInputTokens : null,
    outputTokens: measured ? outputTokens : null,
    tokens: measured ? tokens : null,
  };
}

function optionalEventNumber(value: number | undefined): number | null {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.round(number) : null;
}

function optionalCompact(value: number | null | undefined): string {
  return value == null ? "Not reported" : compactNumber(value);
}

// A rate needs both halves reported: a route that meters cached tokens but
// never reports prompt totals (or the reverse) has no ratio, and "0%" there
// would be indistinguishable from a real cold cache (#826).
export function cacheHitRatePercent(
  cachedInputTokens: number | null | undefined,
  inputTokens: number | null | undefined,
): number | null {
  if (cachedInputTokens == null || inputTokens == null) return null;
  if (!Number.isFinite(cachedInputTokens) || !Number.isFinite(inputTokens) || inputTokens <= 0) return null;
  return Math.min(100, Math.max(0, (cachedInputTokens / inputTokens) * 100));
}

function formatPercent(value: number): string {
  return `${value.toFixed(value > 0 && value < 10 ? 1 : 0)}%`;
}

function friendlyPlanName(value: string): string {
  return value
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (character) => character.toUpperCase());
}

function formatBucketDate(value?: string): string {
  if (!value) return "No data";
  const date = new Date(`${value}T12:00:00`);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" }).format(date);
}

function hasMetricCounts(metric: UsageMetric): boolean {
  return [metric.used, metric.remaining, metric.limit].some((value) => Number.isFinite(Number(value)));
}

function formatMetricCount(value: number | undefined, unit?: string): string {
  if (!Number.isFinite(Number(value))) return "Not reported";
  const formatted = exactNumber(value);
  return unit ? `${formatted} ${unit}` : formatted;
}

function resetCountdown(value: number | string): string {
  const numeric = Number(value);
  const timestamp = Number.isFinite(numeric)
    ? (numeric < 10_000_000_000 ? numeric * 1_000 : numeric)
    : new Date(value).getTime();
  if (!Number.isFinite(timestamp)) return "time unavailable";
  const remaining = timestamp - Date.now();
  if (remaining <= 0) return "refresh due";
  const minutes = Math.ceil(remaining / 60_000);
  if (minutes < 60) return `in ${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `in ${hours}h ${minutes % 60}m`;
  const days = Math.floor(hours / 24);
  return `in ${days}d ${hours % 24}h`;
}

function dateTimeValue(value: number | string): string {
  const numeric = Number(value);
  const date = Number.isFinite(numeric)
    ? new Date(numeric < 10_000_000_000 ? numeric * 1_000 : numeric)
    : new Date(value);
  return Number.isNaN(date.getTime()) ? "" : date.toISOString();
}
