import { useMemo, useState } from "react";
import {
  Activity,
  ArrowUpRight,
  BarChart3,
  CircleGauge,
  Clock3,
  Gauge,
  Server,
  Waypoints,
} from "lucide-react";
import { Badge, Button, EmptyState, InlineNotice, PageHeader, PanelSkeleton, SectionHeading, SkeletonBlock } from "../components";
import { ProviderLogo } from "../provider-branding";
import { ServiceHealthPanel } from "../ServiceHealth";
import { useOptimisticValues, type RunAction } from "../useOptimisticValues";
import {
  classNames,
  compactNumber,
  exactNumber,
  formatDateTime,
  formatDuration,
  remainingPercent,
} from "../lib";
import type {
  AccountUsage,
  ActiveRequest,
  PresenceSnapshot,
  ProviderSetupSnapshot,
  ProviderUsageSnapshot,
  RouterControlApi,
  RouterDataReady,
  RouterDashboardSnapshot,
  RouterHealth,
  RouterTarget,
  UsageEvent,
  UsageBucket,
  UsageMetric,
  ViewId,
  ModelViewFocus,
} from "../types";
import "./dashboard.css";

type Tone = "success" | "warning" | "danger" | "accent";

interface SummaryTile {
  id: string;
  label: string;
  icon: typeof Activity;
  value: string;
  detail: string;
  tone?: Tone;
  meter?: number;
  view: ViewId;
  viewLabel: string;
  pending?: boolean;
}

interface MetricEntry {
  provider: string;
  label: string;
  metric: UsageMetric;
}

interface TrafficBucket {
  key: string;
  label: string;
  fullLabel: string;
  tokens: number;
  requests: number;
  measuredTokens: boolean;
  regularInputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  measuredBreakdown: boolean;
}

type TrafficRange = 24 | 7 | 30;
type TokenActivityMode = "daily" | "weekly" | "cumulative";

interface TokenActivityDay {
  date: Date;
  dateKey: string;
  tokens: number;
  measured: boolean;
  weekIndex: number;
  dayIndex: number;
}

interface TokenActivityViewDay extends TokenActivityDay {
  displayTokens: number;
  tooltip: string;
}

interface TokenActivityMonth {
  label: string;
  weekIndex: number;
}

interface TrafficBreakdownRow {
  id: string;
  label: string;
  providerId?: string;
  provider?: string;
  tokens: number;
  requests: number;
  measuredTokens: boolean;
  share: number;
  scope?: "rolling 24h" | "90-day ledger";
  inputTokens?: number | null;
  cachedInputTokens?: number | null;
  outputTokens?: number | null;
  tokensPerSecond?: number | null;
  speedSampleCount?: number;
}

interface ModelBreakdownAccumulator extends TrafficBreakdownRow {
  inputTotal: number;
  cachedTotal: number;
  outputTotal: number;
  inputMeasured: boolean;
  cacheMeasured: boolean;
  outputMeasured: boolean;
  speedSamples: number[];
}

const RECENT_EVENT_LIMIT = 5;
const TOKEN_ACTIVITY_WEEKS = 53;

export function DashboardPage({
  target,
  dashboard,
  health,
  account,
  providerUsage,
  api,
  refreshing,
  dataReady,
  onRefresh,
  onNavigate,
  runAction,
}: {
  target?: RouterTarget;
  dashboard?: RouterDashboardSnapshot;
  health?: RouterHealth;
  account?: AccountUsage;
  providerUsage?: ProviderUsageSnapshot;
  setup?: ProviderSetupSnapshot;
  presence?: PresenceSnapshot;
  api?: RouterControlApi;
  runAction?: RunAction;
  refreshing: boolean;
  dataReady: RouterDataReady;
  onRefresh: () => void;
  onNavigate: (view: ViewId, modelFocus?: ModelViewFocus) => void;
}) {
  const [trafficRange, setTrafficRange] = useState<TrafficRange>(24);
  const healthPending = !dataReady.health && !health;
  const snapshotPending = !dataReady.snapshot && !target;
  const routesPending = !dataReady.snapshot && !dashboard;
  const accountPending = !dataReady.accountUsage && !account;
  const providerUsagePending = !dataReady.providerUsage && !providerUsage;
  const quotaPending = !account && !providerUsage && (accountPending || providerUsagePending);
  // Every prop can be undefined on first paint and after a failed refresh, so
  // each tile below separates three cases: still loading, reported-but-absent,
  // and a genuine zero. A missing field must never render as 0.
  const pending = refreshing ? "Checking" : "Unavailable";

  const activity = health?.activity;
  const active: ActiveRequest[] = activity?.active ?? [];
  const activityMeasured = Boolean(health && activity);
  const liveCount = activityMeasured ? activity?.activeCount ?? active.length : null;
  const chatCount = uniqueCount(active.map((request) =>
    request.sessionId ?? request.sessionName ?? request.threadId ?? request.id,
  ));
  const subagents = active.filter((request) =>
    request.isSubagent === true
    || Boolean(request.agentName)
    || Boolean(request.agentNickname),
  );
  const routerState = health
    ? health.ok ? activity?.state || "idle" : "offline"
    : refreshing ? "starting" : "offline";

  const providers = providerUsage?.providers ?? [];
  const routeProviders = dashboard?.providers ?? [];
  const authoritativeRoutes = useMemo(
    () => new Map(routeProviders.map((provider) => [provider.id, provider.enabled])),
    [routeProviders],
  );
  const routeMutations = useOptimisticValues(
    authoritativeRoutes,
    runAction ?? (async (_label, action) => { await action(); }),
  );
  const telemetryEvents24h = recentWindowEvents(target?.usageEvents, Date.now());
  const eventTokens24h = sumEventTokens(telemetryEvents24h);
  const eventRequests24h = eventsCountOrNull(target?.usageEvents, telemetryEvents24h);
  const reportedTokens24h = sumReported(providers.map((provider) => provider.last24hTokens));
  const reportedRequests24h = sumReported(providers.map((provider) => provider.last24hRequests));
  // Older installed routers expose the same bounded event stream but predate
  // the provider-level rolling counters. Use it as a presentation fallback so
  // a real day of traffic is not painted as empty during an app/router update.
  const tokens24h = reportedTokens24h ?? eventTokens24h;
  const requests24h = reportedRequests24h ?? eventRequests24h;
  const usageMeasured = Boolean(providerUsage || target?.usageEvents);

  const metrics = useMemo(() => collectMetrics(account, providerUsage), [account, providerUsage]);
  const quotaLoaded = Boolean(account || providerUsage);
  const nextReset = useMemo(() => {
    const now = Date.now();
    return metrics
      .map((entry) => ({ entry, resetAt: resetAtOf(entry.metric) }))
      .filter((row): row is { entry: MetricEntry; resetAt: number | string } =>
        row.resetAt !== undefined && timestampFor(row.resetAt) > now,
      )
      .sort((left, right) => timestampFor(left.resetAt) - timestampFor(right.resetAt))[0];
  }, [metrics]);
  const lowestAllowance = useMemo(() => {
    return metrics
      .map((entry) => ({ entry, percent: remainingPercent(entry.metric) }))
      .filter((row): row is { entry: MetricEntry; percent: number } => row.percent !== null)
      .sort((left, right) => left.percent - right.percent)[0];
  }, [metrics]);
  const allowanceTone: Tone | undefined = lowestAllowance
    ? lowestAllowance.percent < 15 ? "danger" : lowestAllowance.percent < 35 ? "warning" : undefined
    : undefined;

  const events: UsageEvent[] | undefined = target?.usageEvents;
  const recentEvents = events ? [...events].reverse().slice(0, RECENT_EVENT_LIMIT) : [];

  // The provider snapshot gives us accurate rolling totals, while the bounded
  // event stream gives the dashboard an honest hourly shape. Keep this local to
  // the renderer: it is a presentation view and must not become a second
  // accounting ledger in the router.
  const trafficBuckets = buildTrafficBuckets(events, providerUsage, trafficRange, Date.now());
  const providerBreakdown = buildProviderBreakdown(providerUsage, events, Date.now());
  const modelBreakdown = buildModelBreakdown(providerUsage, events, Date.now());
  const trafficHasRequests = trafficBuckets.some((bucket) => bucket.requests > 0);
  const trafficHasTokens = trafficBuckets.some((bucket) => bucket.measuredTokens);

  const tiles: SummaryTile[] = [
    {
      id: "router",
      label: "Router state",
      icon: Activity,
      value: health ? health.ok ? "Online" : "Offline" : pending,
      detail: health
        ? health.ok
          ? `${activityLabel(routerState)}${health.version ? ` · version ${health.version}` : ""}`
          : health.error || "The local health endpoint did not answer"
        : refreshing ? "Contacting the local health endpoint" : "Router health has not been read",
      tone: health ? health.ok ? "success" : "danger" : undefined,
      view: "status",
      viewLabel: "Status",
      pending: healthPending,
    },
    {
      id: "live",
      label: "Live now",
      icon: Waypoints,
      value: !health ? pending : activityMeasured ? exactNumber(liveCount) : "Not measured",
      detail: !health
        ? "Waiting for the first health response"
        : activityMeasured
          ? `${exactNumber(chatCount)} ${plural(chatCount, "chat")} · ${exactNumber(subagents.length)} ${plural(subagents.length, "subagent")}`
          : "This router build does not report live activity",
      tone: activityMeasured && (liveCount || 0) > 0 ? "accent" : undefined,
      view: "status",
      viewLabel: "Status",
      pending: healthPending,
    },
    {
      id: "tokens",
      label: "Tokens, last 24h",
      icon: CircleGauge,
      value: !usageMeasured ? pending : tokens24h === null ? "Not measured" : compactNumber(tokens24h),
      detail: !usageMeasured
        ? "Waiting for router usage telemetry"
        : tokens24h === null
          ? "No provider or event reports a rolling 24-hour window"
          : `${exactNumber(tokens24h)} router tokens${requests24h === null ? "" : ` · ${exactNumber(requests24h)} ${plural(requests24h, "request")}`} · ${reportedTokens24h !== null ? "sum of provider rows" : "sum of recent event details"}`,
      view: "usage",
      viewLabel: "Usage",
      pending: snapshotPending && !providerUsage,
    },
    {
      id: "reset",
      label: "Next quota reset",
      icon: Clock3,
      value: !quotaLoaded ? pending : nextReset ? resetCountdown(nextReset.resetAt) : "Not reported",
      detail: !quotaLoaded
        ? "Waiting for account and provider usage"
        : nextReset
          ? `${nextReset.entry.provider}, ${nextReset.entry.label} · ${formatDateTime(nextReset.resetAt)}`
          : "No connected account exposed a reset timestamp",
      view: "usage",
      viewLabel: "Usage",
      pending: quotaPending,
    },
    {
      id: "allowance",
      label: "Lowest allowance",
      icon: Gauge,
      value: !quotaLoaded
        ? pending
        : lowestAllowance ? `${Math.round(lowestAllowance.percent)}% left` : "Not measured",
      detail: !quotaLoaded
        ? "Waiting for account and provider usage"
        : lowestAllowance
          ? `${lowestAllowance.entry.provider}, ${lowestAllowance.entry.label}${account?.planType ? ` · ${friendlyPlanName(account.planType)} plan` : ""}`
          : "No connected account reports a remaining share",
      tone: allowanceTone,
      meter: lowestAllowance ? lowestAllowance.percent : undefined,
      view: "usage",
      viewLabel: "Usage",
      pending: quotaPending,
    },
  ];

  return (
    <div className="dashboard-page page-stack">
      <PageHeader
        eyebrow="At a glance"
        title="Dashboard"
        description="Router health, live work, recent traffic, and the accounts closest to running out. Every tile opens the page that owns the detail."
        onRefresh={onRefresh}
        refreshing={refreshing}
      />

      {!api ? (
        <InlineNotice tone="warning" title="Desktop bridge unavailable">
          Open this window through the Codex Router desktop app to read live router data.
        </InlineNotice>
      ) : health && !health.ok && health.error ? (
        <InlineNotice tone="danger" title="Router health check failed">{health.error}</InlineNotice>
      ) : null}

      <div className="db-summary-grid" role="list" aria-label="Router summary">
        {tiles.map((tile) => {
          const Icon = tile.icon;
          return (
            <button
              key={tile.id}
              type="button"
              role="listitem"
              className={classNames("db-summary-cell", tile.tone && `tone-${tile.tone}`)}
              aria-label={`${tile.label}: ${tile.value}. ${tile.detail}. Open ${tile.viewLabel}.`}
              onClick={() => onNavigate(tile.view)}
            >
              <span className="db-summary-label">
                <Icon aria-hidden size={12} strokeWidth={1.8} />
                {tile.label}
              </span>
              {tile.pending ? (
                <SkeletonBlock className="db-skeleton-summary-value" />
              ) : <strong className="db-summary-value">{tile.value}</strong>}
              {tile.meter === undefined ? null : (
                <span className="db-summary-meter" aria-hidden="true">
                  <i style={{ width: `${Math.max(2, Math.min(100, tile.meter))}%` }} />
                </span>
              )}
              {tile.pending ? (
                <SkeletonBlock className="db-skeleton-summary-detail" />
              ) : <small className="db-summary-detail">{tile.detail}</small>}
              <span className="db-summary-link" aria-hidden="true">
                View {tile.viewLabel}
                <ArrowUpRight aria-hidden size={11} strokeWidth={1.9} />
              </span>
            </button>
          );
        })}
      </div>

      <div className="db-traffic-grid">
        <section className="panel-section db-traffic-panel">
          <SectionHeading
            title={`Traffic, ${trafficRangeLabel(trafficRange)}`}
            description={trafficDescription(trafficRange)}
            action={(
              <div className="db-traffic-actions">
                <TrafficRangePicker value={trafficRange} onChange={setTrafficRange} />
                <Button variant="ghost" aria-label="Open Usage" onClick={() => onNavigate("usage")}>
                  <BarChart3 aria-hidden size={13} strokeWidth={1.7} />
                  Usage
                </Button>
              </div>
            )}
          />
          {snapshotPending ? (
            <PanelSkeleton label="Loading router traffic" count={4} />
          ) : !events ? (
            <EmptyState
              icon={<BarChart3 size={20} />}
              title={refreshing ? "Reading router telemetry" : "Router telemetry unavailable"}
              body="Traffic appears once the router snapshot loads."
            />
          ) : trafficHasRequests ? (
            <TrafficTrend buckets={trafficBuckets} hasTokens={trafficHasTokens} range={trafficRange} />
          ) : (
            <EmptyState
              icon={<BarChart3 size={20} />}
              title={`No requests in ${trafficRangeLabel(trafficRange)}`}
              body="The chart will fill as a request passes through the local router."
            />
          )}
          {events ? (
            <p className="db-panel-note db-traffic-note">
              {trafficHasTokens
                ? `${exactNumber(trafficBuckets.reduce((sum, bucket) => sum + bucket.tokens, 0))} measured tokens across ${exactNumber(trafficBuckets.reduce((sum, bucket) => sum + bucket.requests, 0))} requests in ${trafficRangeLabel(trafficRange)}. ${trafficRange === 24 ? "Hourly bars use the latest 1,000 event details." : "Daily bars use the retained provider ledger when available."}`
                : trafficHasRequests
                  ? `${exactNumber(trafficBuckets.reduce((sum, bucket) => sum + bucket.requests, 0))} requests observed in ${trafficRangeLabel(trafficRange)}, but token counts were not reported by the upstream responses.`
                  : `The router returned an empty ${trafficRangeLabel(trafficRange)} telemetry window; this is different from a failed health check.`}
            </p>
          ) : null}
        </section>

      </div>

      <TokenActivity
        events={events}
        providerUsage={providerUsage}
        refreshing={refreshing}
        loading={snapshotPending && !providerUsage}
      />

      <div className="db-panel-grid db-dashboard-details">
        <section className="panel-section db-breakdown-panel">
          <SectionHeading
            title="Provider and model mix"
            description={providerUsage ? "Rolling provider totals and the busiest models on this router; model rows include 24-hour input, cache, output, and speed." : "Breakdowns appear with the provider usage snapshot."}
            action={(
              <Button variant="ghost" aria-label="Open Status" onClick={() => onNavigate("status")}>
                <Activity aria-hidden size={13} strokeWidth={1.7} />
                Details
              </Button>
            )}
          />
          {providerUsagePending ? (
            <PanelSkeleton label="Loading provider and model usage" count={4} />
          ) : <div className="db-breakdown-stack">
            <BreakdownGroup
              title="Providers"
              emptyTitle={providerUsage ? "No metered provider traffic" : refreshing ? "Reading providers" : "Provider usage unavailable"}
              emptyBody={providerUsage ? "Connected providers have not served a metered request in the rolling window." : "Refresh after the provider usage snapshot becomes available."}
              rows={providerBreakdown}
              providerRows
            />
            <BreakdownGroup
              title={modelBreakdownScopeTitle(modelBreakdown)}
              emptyTitle={events === undefined && providerUsage === undefined ? "No model usage yet" : "No model traffic"}
              emptyBody={modelBreakdown.length ? "" : "A model appears after it serves a request with usage metadata."}
              rows={modelBreakdown}
            />
          </div>}
        </section>
      </div>

      <section className="panel-section db-events-panel">
        <SectionHeading
          title="Recent activity"
          description="The last few routed requests from the rolling 24-hour telemetry window, with output speed and token mix when reported."
          action={(
            <Button variant="ghost" aria-label="Open Status" onClick={() => onNavigate("status")}>
              <Activity aria-hidden size={13} strokeWidth={1.7} />
              Status
            </Button>
          )}
        />
        {snapshotPending ? (
          <PanelSkeleton label="Loading recent router activity" count={5} />
        ) : recentEvents.length ? (
          <div className="db-event-list">
            {recentEvents.map((event, index) => (
              <DashboardEventRow key={`${event.at}-${event.model || "model"}-${index}`} event={event} />
            ))}
          </div>
        ) : (
          <EmptyState
            icon={<Server size={20} />}
            title={events ? "No recent router traffic" : refreshing ? "Reading router telemetry" : "Router telemetry unavailable"}
            body={events
              ? "This list fills after a request passes through the local router."
              : "Recent requests appear once the router snapshot loads."}
          />
        )}
      </section>

      <RouteDashboardPanel
        providers={routeProviders}
        routeMutations={routeMutations}
        api={api}
        onNavigate={onNavigate}
        loading={routesPending}
      />

      {healthPending ? (
        <SkeletonBlock className="db-skeleton-health" />
      ) : (
        <ServiceHealthPanel health={health} compact onOpen={() => onNavigate("status")} />
      )}
    </div>
  );
}

function RouteDashboardPanel({
  providers,
  routeMutations,
  api,
  onNavigate,
  loading,
}: {
  providers: RouterDashboardSnapshot["providers"];
  routeMutations: {
    value: (key: string, fallback: boolean) => boolean;
    mutate: (key: string, next: boolean, label: string, action: () => Promise<unknown>) => Promise<void>;
  };
  api?: RouterControlApi;
  onNavigate: (view: ViewId, modelFocus?: ModelViewFocus) => void;
  loading: boolean;
}) {
  const visible = providers.filter((provider) => provider.kind !== "per-model");
  return (
    <section className="db-route-dashboard" aria-labelledby="db-route-dashboard-title">
      <SectionHeading
        title="Provider routes"
        description="Enable or disable validated provider routes. Changes are saved atomically and shared with the tray."
        action={<Button variant="ghost" onClick={() => onNavigate("models")}>Manage models</Button>}
      />
      {loading ? (
        <PanelSkeleton label="Loading provider routes" count={3} />
      ) : visible.length === 0 ? (
        <EmptyState title="No provider routes" body="Connect a provider to make a route available here." />
      ) : (
        <div className="db-route-list" role="list" aria-label="Provider routes">
          {visible.map((provider) => {
            const enabled = routeMutations.value(provider.id, provider.enabled);
            return (
              <div className="db-route-row" key={provider.id} role="listitem">
                <ProviderLogo providerId={provider.id} displayName={provider.displayName} size="small" />
                <div className="db-route-copy">
                  <strong>{provider.displayName}</strong>
                  <small>{enabled ? "Route enabled" : "Route disabled"}</small>
                </div>
                <Badge tone={enabled ? "success" : "neutral"}>{enabled ? "Enabled" : "Disabled"}</Badge>
                <Button
                  variant={enabled ? "secondary" : "primary"}
                  type="button"
                  disabled={!api}
                  aria-pressed={enabled}
                  aria-label={`${enabled ? "Disable" : "Enable"} ${provider.displayName}`}
                  onClick={() => {
                    if (!api) return;
                    const next = !enabled;
                    void routeMutations.mutate(
                      provider.id,
                      next,
                      `${next ? "Enable" : "Disable"} ${provider.displayName}`,
                      () => api.setProviderEnabled(provider.id, next),
                    );
                  }}
                >
                  {enabled ? "Disable" : "Enable"}
                </Button>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

function TokenActivity({
  events,
  providerUsage,
  refreshing,
  loading,
}: {
  events?: UsageEvent[];
  providerUsage?: ProviderUsageSnapshot;
  refreshing: boolean;
  loading: boolean;
}) {
  const [mode, setMode] = useState<TokenActivityMode>("daily");
  const activity = useMemo(
    () => buildTokenActivity(events, providerUsage, Date.now()),
    [events, providerUsage],
  );
  const viewDays = useMemo(
    () => tokenActivityForMode(activity.days, mode),
    [activity.days, mode],
  );
  const levels = useMemo(
    () => tokenActivityLevels(viewDays.map((day) => day.displayTokens)),
    [viewDays],
  );
  const total = activity.days.reduce((sum, day) => sum + day.tokens, 0);
  const activeDays = activity.days.filter((day) => day.tokens > 0).length;

  return (
    <section className="panel-section db-token-activity">
      <div className="db-token-activity-heading">
        <div>
          <h2>Token activity</h2>
          <p>
            {providerUsage
              ? `${exactNumber(total)} measured tokens across the last year`
              : refreshing
                ? "Reading the retained router ledger"
                : events
                  ? "Recent event telemetry; retained daily totals are unavailable"
                  : "Token history appears after the router reports usage"}
          </p>
        </div>
        <div className="db-token-mode" role="radiogroup" aria-label="Token activity display">
          {(["daily", "weekly", "cumulative"] as const).map((option) => (
            <button
              key={option}
              type="button"
              role="radio"
              aria-checked={mode === option}
              className={mode === option ? "is-active" : ""}
              onClick={() => setMode(option)}
            >
              {capitalize(option)}
            </button>
          ))}
        </div>
      </div>

      {loading ? (
        <PanelSkeleton label="Loading retained token activity" count={2} />
      ) : <><div className="db-token-calendar-scroll">
        <div className="db-token-calendar">
          <div className="db-token-cells" role="grid" aria-label={`${capitalize(mode)} token activity for the last year`}>
            {viewDays.map((day) => {
              const level = levelForTokenActivity(day.displayTokens, levels);
              const isFuture = day.date.getTime() > activity.today;
              return (
                <span
                  key={day.dateKey}
                  role="gridcell"
                  tabIndex={isFuture ? -1 : 0}
                  aria-label={day.tooltip}
                  data-edge={day.weekIndex > TOKEN_ACTIVITY_WEEKS - 16 ? "end" : undefined}
                  data-row={day.dayIndex < 2 ? "top" : day.dayIndex > 4 ? "bottom" : undefined}
                  className={classNames(
                    "db-token-day",
                    `level-${level}`,
                    isFuture && "is-future",
                  )}
                  style={{
                    gridColumn: day.weekIndex + 1,
                    gridRow: day.dayIndex + 1,
                  }}
                >
                  <span className="db-token-tooltip" role="tooltip">{day.tooltip}</span>
                </span>
              );
            })}
          </div>
          <div className="db-token-months" aria-hidden="true">
            {activity.months.map((month) => (
              <span
                key={`${month.label}-${month.weekIndex}`}
                style={{ gridColumn: `${month.weekIndex + 1} / span ${Math.min(4, TOKEN_ACTIVITY_WEEKS - month.weekIndex)}` }}
              >
                {month.label}
              </span>
            ))}
          </div>
        </div>
      </div>

      <div className="db-token-activity-footer">
        <span>{activeDays ? `${exactNumber(activeDays)} active ${plural(activeDays, "day")}` : "No measured activity yet"}</span>
        <span className="db-token-scale" aria-label="Token activity intensity from less to more">
          Less
          {[0, 1, 2, 3, 4].map((level) => <i key={level} className={`level-${level}`} />)}
          More
        </span>
      </div></>}
    </section>
  );
}

function TrafficRangePicker({ value, onChange }: {
  value: TrafficRange;
  onChange: (value: TrafficRange) => void;
}) {
  return (
    <div className="db-range-picker" role="radiogroup" aria-label="Dashboard traffic range">
      {([24, 7, 30] as const).map((range) => (
        <button
          type="button"
          key={range}
          role="radio"
          aria-checked={value === range}
          className={value === range ? "is-active" : ""}
          onClick={() => onChange(range)}
        >
          {range === 24 ? "24h" : `${range}d`}
        </button>
      ))}
    </div>
  );
}

function TrafficTrend({ buckets, hasTokens, range }: { buckets: TrafficBucket[]; hasTokens: boolean; range: TrafficRange }) {
  const maxTokens = Math.max(...buckets.map((bucket) => bucket.tokens), 1);
  const maxRequests = Math.max(...buckets.map((bucket) => bucket.requests), 1);
  const hasBreakdown = buckets.some((bucket) => bucket.measuredBreakdown);
  return (
    <div
      className="db-trend"
      role="img"
      aria-label={`${range === 24 ? "Hourly" : "Daily"} router traffic for ${trafficRangeLabel(range)}${hasTokens ? hasBreakdown ? " split into regular input, cached input, and output" : " by tokens" : " by requests"}`}
    >
      <div className="db-trend-scale" aria-hidden="true">
        <span>{hasTokens ? compactNumber(maxTokens) : exactNumber(maxRequests)}</span>
        <span>0</span>
      </div>
      <div
        className="db-trend-bars"
        style={{ gridTemplateColumns: `repeat(${Math.max(1, buckets.length)}, minmax(0, 1fr))` }}
      >
        {buckets.map((bucket, index) => {
          const ratio = hasTokens
            ? bucket.tokens / maxTokens
            : bucket.requests / maxRequests;
          const height = ratio > 0 ? Math.max(4, ratio * 100) : 0;
          const parts = trafficParts(bucket);
          const breakdown = bucket.measuredBreakdown
            ? parts.filter((part) => part.tokens > 0).map((part) => `${part.label}: ${exactNumber(part.tokens)}`)
            : [];
          const label = [
            `${bucket.fullLabel}.`,
            bucket.measuredTokens ? `Total: ${exactNumber(bucket.tokens)} tokens.` : "Token count not reported.",
            ...breakdown.map((item) => `${item}.`),
            `Requests: ${exactNumber(bucket.requests)}.`,
          ].join(" ");
          const edge = index === 0 ? "start" : index === buckets.length - 1 ? "end" : undefined;
          return (
            <span
              className="db-trend-slot"
              key={bucket.key}
              aria-label={label}
              data-edge={edge}
              role="img"
              tabIndex={0}
            >
              {hasBreakdown ? (
                <span className="db-trend-stack" style={{ height: `${height}%` }}>
                  {trafficParts(bucket).map((part) => (
                    <i
                      key={part.tone}
                      className={part.tone}
                      style={{ height: `${bucket.tokens > 0 ? (part.tokens / bucket.tokens) * 100 : 0}%` }}
                    />
                  ))}
                </span>
              ) : <i style={{ height: `${height}%` }} />}
              <TrafficTooltip bucket={bucket} parts={parts} />
            </span>
          );
        })}
      </div>
      <div className="db-trend-axis" aria-hidden="true">
        <span>{buckets[0]?.label}</span>
        <span>{buckets[Math.floor(buckets.length / 2)]?.label}</span>
        <span>{buckets.at(-1)?.label}</span>
      </div>
      <div className="db-trend-legend" aria-hidden="true">
        {hasBreakdown ? (
          <>
            <span className="is-regular">Regular input</span>
            <span className="is-cached">Cached input</span>
            <span className="is-output">Output</span>
          </>
        ) : <span className="is-token">{hasTokens ? "Tokens" : "Requests"}</span>}
        <span className="is-request">Request volume</span>
      </div>
    </div>
  );
}

function TrafficTooltip({ bucket, parts }: { bucket: TrafficBucket; parts: TrafficPart[] }) {
  const visibleParts = bucket.measuredBreakdown ? parts.filter((part) => part.tokens > 0) : [];
  return (
    <span className="db-trend-tooltip" aria-hidden="true">
      <span className="db-trend-tooltip-date">{bucket.fullLabel}</span>
      {bucket.measuredTokens ? (
        <>
          <strong className="db-trend-tooltip-total">{compactNumber(bucket.tokens).toUpperCase()} tokens</strong>
          <span className="db-trend-tooltip-exact">{exactNumber(bucket.tokens)} total tokens</span>
        </>
      ) : (
        <strong className="db-trend-tooltip-total">Token count not reported</strong>
      )}
      <span className="db-trend-tooltip-rows">
        {visibleParts.map((part) => (
          <span className={`db-trend-tooltip-row is-${part.tone}`} key={part.tone}>
            <i aria-hidden="true" />
            <span>{part.label}</span>
            <strong>{exactNumber(part.tokens)}</strong>
          </span>
        ))}
        <span className="db-trend-tooltip-row is-requests">
          <i aria-hidden="true" />
          <span>Requests</span>
          <strong>{exactNumber(bucket.requests)}</strong>
        </span>
      </span>
      {!bucket.measuredTokens ? (
        <span className="db-trend-tooltip-note">The upstream response did not include token counts.</span>
      ) : !bucket.measuredBreakdown ? (
        <span className="db-trend-tooltip-note">Input and output details were not reported for this hour.</span>
      ) : null}
    </span>
  );
}

function BreakdownGroup({
  title,
  rows,
  providerRows = false,
  emptyTitle,
  emptyBody,
}: {
  title: string;
  rows: TrafficBreakdownRow[];
  providerRows?: boolean;
  emptyTitle: string;
  emptyBody: string;
}) {
  const visibleRows = rows.slice(0, 5);
  const max = Math.max(...visibleRows.map((row) => row.tokens), 1);
  return (
    <div className="db-breakdown-group">
      <div className="db-breakdown-heading">
        <h3>{title}</h3>
        {rows.length > visibleRows.length ? <small>Top {visibleRows.length} of {rows.length}</small> : null}
      </div>
      {visibleRows.length ? (
        <div className="db-breakdown-list" role="list" aria-label={`${title} usage breakdown`}>
          {visibleRows.map((row) => (
            <div className="db-breakdown-row" role="listitem" key={row.id}>
              <ProviderLogo
                providerId={row.providerId || row.id.replace(/^provider:/, "")}
                displayName={row.provider || row.label}
                size="small"
                className="db-breakdown-logo"
              />
              <div className="db-breakdown-label">
                <strong title={row.label}>{row.label}</strong>
                <small>{row.provider ? `${row.provider} · ` : ""}{exactNumber(row.requests)} {plural(row.requests, "request")}{row.measuredTokens ? ` · ${compactNumber(row.tokens)} tok` : " · tokens not reported"}</small>
                {!providerRows ? <ModelBreakdownFacts row={row} /> : null}
                <span className="db-breakdown-meter" aria-hidden="true"><i style={{ width: `${row.tokens > 0 ? Math.max(2, (row.tokens / max) * 100) : 0}%` }} /></span>
              </div>
              <strong className="db-breakdown-value">{row.measuredTokens ? compactNumber(row.tokens) : "—"}</strong>
            </div>
          ))}
        </div>
      ) : (
        <div className="db-breakdown-empty">
          <strong>{emptyTitle}</strong>
          <p>{emptyBody}</p>
        </div>
      )}
    </div>
  );
}

function ModelBreakdownFacts({ row }: { row: TrafficBreakdownRow }) {
  const facts: Array<{ label: string; tone: "input" | "cached" | "output" | "speed" }> = [];
  if (row.inputTokens != null) facts.push({ label: `${compactNumber(row.inputTokens)} input`, tone: "input" });
  if (row.cachedInputTokens != null) facts.push({ label: `${compactNumber(row.cachedInputTokens)} cache`, tone: "cached" });
  if (row.outputTokens != null) facts.push({ label: `${compactNumber(row.outputTokens)} output`, tone: "output" });
  if (row.tokensPerSecond != null) facts.push({ label: formatTokensPerSecond(row.tokensPerSecond), tone: "speed" });
  if (!facts.length) return null;
  return (
    <span
      className="db-breakdown-facts"
      title={facts.map((fact) => fact.label).join(" · ")}
    >
      {facts.map((fact) => <span className={`is-${fact.tone}`} key={fact.label}>{fact.label}</span>)}
    </span>
  );
}

function DashboardEventRow({ event }: { event: UsageEvent }) {
  const status = event.status;
  const tone: Tone | "neutral" = status === undefined
    ? "neutral"
    : status >= 400 ? "danger" : status >= 200 ? "success" : "neutral";
  const total = tokenCountFromEvent(event);
  const speed = tokensPerSecondFromEvent(event);
  const breakdown = tokenBreakdownFromEvent(event);
  const tokenFacts = formatEventTokenFacts(total, breakdown);
  return (
    <article>
      <ProviderLogo
        providerId={event.provider || "router"}
        displayName={event.provider}
        size="small"
        className="db-event-logo"
      />
      <span className="db-event-model">
        <strong>{shortModelName(event.model || "Unknown model")}</strong>
        <small>{event.provider || "router"}</small>
      </span>
      <span className="db-event-metering">
        <strong>{speed == null ? "Speed unmeasured" : formatTokensPerSecond(speed)}</strong>
        <small title={tokenFacts}>{tokenFacts}</small>
      </span>
      <span className="db-event-duration">
        <strong>{event.durationMs === undefined ? "No duration" : formatDuration(event.durationMs)}</strong>
        <small>{formatDateTime(event.at)}</small>
      </span>
      <span className="db-event-status">
        <Badge tone={tone === "neutral" ? "neutral" : tone}>
          {status === undefined ? "no status" : String(status)}
        </Badge>
      </span>
    </article>
  );
}

function collectMetrics(
  account?: AccountUsage,
  providerUsage?: ProviderUsageSnapshot,
): MetricEntry[] {
  const entries: MetricEntry[] = [];
  for (const [index, metric] of [account?.primary, account?.secondary].entries()) {
    if (!metric) continue;
    entries.push({
      provider: "ChatGPT",
      label: limitWindowLabel(metric.windowDurationMins, index),
      metric,
    });
  }
  for (const provider of providerUsage?.providers ?? []) {
    for (const metric of provider.account?.metrics ?? []) {
      entries.push({
        provider: provider.displayName,
        label: metric.label || "Usage limit",
        metric,
      });
    }
  }
  return entries;
}

const HOUR_MS = 60 * 60 * 1_000;
const DAY_MS = 24 * HOUR_MS;

function buildTokenActivity(
  events: UsageEvent[] | undefined,
  providerUsage: ProviderUsageSnapshot | undefined,
  now: number,
): { days: TokenActivityDay[]; months: TokenActivityMonth[]; today: number } {
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  const first = new Date(today);
  first.setDate(first.getDate() - first.getDay() - ((TOKEN_ACTIVITY_WEEKS - 1) * 7));

  const tokensByDay = new Map<string, number>();
  const measuredDays = new Set<string>();
  const retainedProviders = providerUsage?.retained?.providers;
  const providers = retainedProviders?.length
    ? retainedProviders
    : providerUsage?.providers ?? [];
  let dailyRows = 0;

  for (const provider of providers) {
    for (const bucket of provider.dailyUsageBuckets ?? []) {
      const dateKey = normalizeDateKey(bucket.startDate);
      if (!dateKey) continue;
      dailyRows += 1;
      measuredDays.add(dateKey);
      tokensByDay.set(dateKey, (tokensByDay.get(dateKey) ?? 0) + Math.max(0, Number(bucket.tokens) || 0));
    }
  }

  if (dailyRows === 0) {
    for (const event of events ?? []) {
      const at = new Date(event.at);
      if (!Number.isFinite(at.getTime())) continue;
      const dateKey = localDateKey(at);
      const tokens = tokenCountFromEvent(event);
      if (tokens === null) continue;
      measuredDays.add(dateKey);
      tokensByDay.set(dateKey, (tokensByDay.get(dateKey) ?? 0) + tokens);
    }
  }

  const days = Array.from({ length: TOKEN_ACTIVITY_WEEKS * 7 }, (_, index) => {
    const date = new Date(first);
    date.setDate(first.getDate() + index);
    const dateKey = localDateKey(date);
    return {
      date,
      dateKey,
      tokens: tokensByDay.get(dateKey) ?? 0,
      measured: measuredDays.has(dateKey),
      weekIndex: Math.floor(index / 7),
      dayIndex: date.getDay(),
    };
  });

  const monthFormatter = new Intl.DateTimeFormat("en-US", { month: "short" });
  const months: TokenActivityMonth[] = [];
  let previousMonth = -1;
  for (const day of days) {
    const month = day.date.getMonth();
    if (month === previousMonth) continue;
    previousMonth = month;
    if (day.date.getDate() > 7) continue;
    months.push({ label: monthFormatter.format(day.date), weekIndex: day.weekIndex });
  }

  return { days, months, today: today.getTime() };
}

function tokenActivityForMode(
  days: TokenActivityDay[],
  mode: TokenActivityMode,
): TokenActivityViewDay[] {
  const dateFormatter = new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
  const weeklyTotals = new Map<number, number>();
  for (const day of days) {
    weeklyTotals.set(day.weekIndex, (weeklyTotals.get(day.weekIndex) ?? 0) + day.tokens);
  }

  let cumulative = 0;
  return days.map((day) => {
    cumulative += day.tokens;
    if (mode === "weekly") {
      const weekStart = days[day.weekIndex * 7]?.date ?? day.date;
      const weekEnd = days[(day.weekIndex * 7) + 6]?.date ?? day.date;
      const displayTokens = weeklyTotals.get(day.weekIndex) ?? 0;
      return {
        ...day,
        displayTokens,
        tooltip: `${exactNumber(displayTokens)} tokens from ${dateFormatter.format(weekStart)} to ${dateFormatter.format(weekEnd)}`,
      };
    }
    if (mode === "cumulative") {
      return {
        ...day,
        displayTokens: cumulative,
        tooltip: `${exactNumber(cumulative)} cumulative tokens through ${dateFormatter.format(day.date)}`,
      };
    }
    return {
      ...day,
      displayTokens: day.tokens,
      tooltip: `${exactNumber(day.tokens)} tokens on ${dateFormatter.format(day.date)}`,
    };
  });
}

function tokenActivityLevels(values: number[]): number {
  return Math.max(0, ...values.filter((value) => Number.isFinite(value)));
}

function levelForTokenActivity(tokens: number, max: number): number {
  if (tokens <= 0 || max <= 0) return 0;
  return Math.max(1, Math.min(4, Math.ceil((Math.log1p(tokens) / Math.log1p(max)) * 4)));
}

function normalizeDateKey(value: string): string | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  return match ? `${match[1]}-${match[2]}-${match[3]}` : null;
}

function localDateKey(date: Date): string {
  const year = date.getFullYear();
  const month = `${date.getMonth() + 1}`.padStart(2, "0");
  const day = `${date.getDate()}`.padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function trafficRangeLabel(range: TrafficRange): string {
  return range === 24 ? "the last 24 hours" : `the last ${range} days`;
}

function trafficDescription(range: TrafficRange): string {
  return range === 24
    ? "Hourly local buckets from router request telemetry. This is observed traffic, not provider billing."
    : "Daily local buckets from the retained router ledger. This is observed traffic, not provider billing.";
}

function buildTrafficBuckets(
  events: UsageEvent[] | undefined,
  providerUsage: ProviderUsageSnapshot | undefined,
  range: TrafficRange,
  now: number,
): TrafficBucket[] {
  return range === 24
    ? buildHourlyTrafficBuckets(events, now)
    : buildDailyTrafficBuckets(events, providerUsage, range, now);
}

function buildHourlyTrafficBuckets(events: UsageEvent[] | undefined, now: number): TrafficBucket[] {
  const anchor = new Date(now);
  anchor.setMinutes(0, 0, 0);
  const first = anchor.getTime() - (23 * HOUR_MS);
  const formatter = new Intl.DateTimeFormat("en-US", { hour: "numeric" });
  const fullFormatter = new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
  });
  const buckets = Array.from({ length: 24 }, (_, index) => {
    const start = new Date(first + index * HOUR_MS);
    return {
      key: start.toISOString(),
      label: formatter.format(start),
      fullLabel: fullFormatter.format(start),
      tokens: 0,
      requests: 0,
      measuredTokens: false,
      regularInputTokens: 0,
      cachedInputTokens: 0,
      outputTokens: 0,
      measuredBreakdown: false,
    };
  });
  for (const event of events ?? []) {
    const at = Date.parse(event.at);
    if (!Number.isFinite(at) || at < first || at >= anchor.getTime() + HOUR_MS) continue;
    const index = Math.floor((at - first) / HOUR_MS);
    if (index < 0 || index >= buckets.length) continue;
    const bucket = buckets[index];
    bucket.requests += 1;
    const tokens = tokenCountFromEvent(event);
    if (tokens !== null) {
      bucket.tokens += tokens;
      bucket.measuredTokens = true;
    }
    const breakdown = trafficPartsFromEvent(event);
    if (breakdown) {
      bucket.regularInputTokens += breakdown.regularInputTokens;
      bucket.cachedInputTokens += breakdown.cachedInputTokens;
      bucket.outputTokens += breakdown.outputTokens;
      bucket.measuredBreakdown = true;
    }
  }
  return buckets;
}

function buildDailyTrafficBuckets(
  events: UsageEvent[] | undefined,
  providerUsage: ProviderUsageSnapshot | undefined,
  range: Exclude<TrafficRange, 24>,
  now: number,
): TrafficBucket[] {
  const anchor = new Date(now);
  anchor.setHours(0, 0, 0, 0);
  const first = anchor.getTime() - (range - 1) * DAY_MS;
  const labelFormatter = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" });
  const fullFormatter = new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: range === 30 ? "numeric" : undefined,
  });
  const buckets = Array.from({ length: range }, (_, index) => {
    const start = new Date(first + index * DAY_MS);
    return {
      key: start.toISOString(),
      label: labelFormatter.format(start),
      fullLabel: fullFormatter.format(start),
      tokens: 0,
      requests: 0,
      measuredTokens: false,
      regularInputTokens: 0,
      cachedInputTokens: 0,
      outputTokens: 0,
      measuredBreakdown: false,
    };
  });

  const retainedProviders = providerUsage?.retained?.providers;
  const providers = retainedProviders?.length
    ? retainedProviders
    : providerUsage?.providers ?? [];
  let providerBuckets = 0;
  for (const provider of providers) {
    for (const usageBucket of provider.dailyUsageBuckets ?? []) {
      const index = indexForLocalDay(usageBucket.startDate, first, range);
      if (index === null) continue;
      const bucket = buckets[index];
      providerBuckets += 1;
      const tokens = optionalNumber(usageBucket.tokens);
      if (tokens !== null) {
        bucket.tokens += tokens;
        bucket.measuredTokens = true;
      }
      const requests = optionalNumber(usageBucket.requests);
      if (requests !== null) bucket.requests += requests;
      const breakdown = trafficPartsFromUsageBucket(usageBucket);
      if (breakdown) {
        bucket.regularInputTokens += breakdown.regularInputTokens;
        bucket.cachedInputTokens += breakdown.cachedInputTokens;
        bucket.outputTokens += breakdown.outputTokens;
        bucket.measuredBreakdown = true;
      }
    }
  }

  // A mixed-version snapshot can have no daily provider rows yet. Keep the
  // chart useful while it catches up by deriving the same daily shape from
  // the bounded event details, without adding those events to provider rows.
  if (providerBuckets === 0) {
    for (const event of events ?? []) {
      const at = Date.parse(event.at);
      if (!Number.isFinite(at) || at < first || at >= anchor.getTime() + DAY_MS) continue;
      const index = Math.floor((at - first) / DAY_MS);
      if (index < 0 || index >= buckets.length) continue;
      const bucket = buckets[index];
      bucket.requests += 1;
      const tokens = tokenCountFromEvent(event);
      if (tokens !== null) {
        bucket.tokens += tokens;
        bucket.measuredTokens = true;
      }
      const breakdown = trafficPartsFromEvent(event);
      if (breakdown) {
        bucket.regularInputTokens += breakdown.regularInputTokens;
        bucket.cachedInputTokens += breakdown.cachedInputTokens;
        bucket.outputTokens += breakdown.outputTokens;
        bucket.measuredBreakdown = true;
      }
    }
  }
  return buckets;
}

function indexForLocalDay(value: string, first: number, count: number): number | null {
  const date = new Date(`${value}T00:00:00`);
  if (!Number.isFinite(date.getTime())) return null;
  const index = Math.floor((date.getTime() - first) / DAY_MS);
  return index >= 0 && index < count ? index : null;
}

function trafficPartsFromUsageBucket(bucket: UsageBucket): {
  regularInputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
} | null {
  const input = optionalNumber(bucket.inputTokens);
  const cached = optionalNumber(bucket.cachedInputTokens);
  const output = optionalNumber(bucket.outputTokens);
  if (input === null && cached === null && output === null) return null;
  const inputTokens = input ?? 0;
  const cachedInputTokens = input === null ? cached ?? 0 : Math.min(inputTokens, cached ?? 0);
  return {
    regularInputTokens: Math.max(0, inputTokens - cachedInputTokens),
    cachedInputTokens,
    outputTokens: output ?? 0,
  };
}

type TrafficPart = {
  tone: "regular-input" | "cached-input" | "output" | "other";
  label: string;
  tokens: number;
};

function trafficParts(bucket: TrafficBucket): TrafficPart[] {
  const known = bucket.regularInputTokens + bucket.cachedInputTokens + bucket.outputTokens;
  return [
    { tone: "regular-input", label: "regular input", tokens: bucket.regularInputTokens },
    { tone: "cached-input", label: "cached input", tokens: bucket.cachedInputTokens },
    { tone: "output", label: "output", tokens: bucket.outputTokens },
    { tone: "other", label: "unattributed tokens", tokens: Math.max(0, bucket.tokens - known) },
  ];
}

function trafficPartsFromEvent(event: UsageEvent): Omit<TrafficBucket, "key" | "label" | "fullLabel" | "tokens" | "requests" | "measuredTokens" | "measuredBreakdown"> | null {
  const input = optionalNumber(event.billedInputTokens ?? event.inputTokens);
  const cached = optionalNumber(event.cachedInputTokens);
  const output = optionalNumber(event.billedOutputTokens ?? event.outputTokens);
  if (input === null && cached === null && output === null) return null;
  const inputTokens = input ?? 0;
  const cachedInputTokens = input === null ? cached ?? 0 : Math.min(inputTokens, cached ?? 0);
  return {
    regularInputTokens: Math.max(0, inputTokens - cachedInputTokens),
    cachedInputTokens,
    outputTokens: output ?? 0,
  };
}

function buildProviderBreakdown(
  providerUsage: ProviderUsageSnapshot | undefined,
  events: UsageEvent[] | undefined,
  now: number,
): TrafficBreakdownRow[] {
  const eventRows = new Map<string, { requests: number; tokens: number; measuredTokens: boolean }>();
  for (const event of recentWindowEvents(events, now)) {
    const id = event.provider || "unknown";
    const previous = eventRows.get(id) ?? { requests: 0, tokens: 0, measuredTokens: false };
    previous.requests += 1;
    const tokens = tokenCountFromEvent(event);
    if (tokens !== null) {
      previous.tokens += tokens;
      previous.measuredTokens = true;
    }
    eventRows.set(id, previous);
  }
  const names = new Map((providerUsage?.providers ?? []).map((provider) => [provider.id, provider.displayName]));
  const rows = new Map<string, TrafficBreakdownRow>();
  for (const provider of providerUsage?.providers ?? []) {
    const eventRow = eventRows.get(provider.id);
    const snapshotRequests = optionalNumber(provider.last24hRequests);
    const snapshotTokens = optionalNumber(provider.last24hTokens);
    // A health snapshot and the event stream can be sampled a few milliseconds
    // apart. Preserve the larger observed value instead of briefly painting a
    // provider as idle while the other source already has its latest request.
    const requests = Math.max(snapshotRequests ?? 0, eventRow?.requests ?? 0);
    const measuredTokens = snapshotTokens !== null || Boolean(eventRow?.measuredTokens);
    const tokens = Math.max(snapshotTokens ?? 0, eventRow?.tokens ?? 0);
    if (requests <= 0 && tokens <= 0 && !eventRow?.measuredTokens) continue;
    rows.set(provider.id, {
      id: `provider:${provider.id}`,
      label: provider.displayName,
      providerId: provider.id,
      tokens,
      requests,
      measuredTokens,
      share: 0,
      scope: "rolling 24h",
    });
  }
  for (const [providerId, eventRow] of eventRows) {
    if (rows.has(providerId) || (eventRow.requests <= 0 && !eventRow.measuredTokens)) continue;
    rows.set(providerId, {
      id: `provider:${providerId}`,
      label: names.get(providerId) || providerId,
      providerId,
      tokens: eventRow.tokens,
      requests: eventRow.requests,
      measuredTokens: eventRow.measuredTokens,
      share: 0,
      scope: "rolling 24h",
    });
  }
  return withBreakdownShares([...rows.values()]);
}

function buildModelBreakdown(
  providerUsage: ProviderUsageSnapshot | undefined,
  events: UsageEvent[] | undefined,
  now: number,
): TrafficBreakdownRow[] {
  const names = new Map((providerUsage?.providers ?? []).map((provider) => [provider.id, provider.displayName]));
  const eventRows = new Map<string, ModelBreakdownAccumulator>();
  for (const event of recentWindowEvents(events, now)) {
    const model = event.model || "unknown";
    const provider = event.provider || "unknown";
    const id = `${provider}:${model}`;
    const previous = eventRows.get(id) ?? {
      id,
      label: shortModelName(model),
      providerId: provider,
      provider: names.get(provider) || provider,
      tokens: 0,
      requests: 0,
      measuredTokens: false,
      share: 0,
      scope: "rolling 24h",
      inputTotal: 0,
      cachedTotal: 0,
      outputTotal: 0,
      inputMeasured: false,
      cacheMeasured: false,
      outputMeasured: false,
      speedSamples: [],
    };
    previous.requests += 1;
    const tokens = tokenCountFromEvent(event);
    if (tokens !== null) {
      previous.tokens += tokens;
      previous.measuredTokens = true;
    }
    const breakdown = tokenBreakdownFromEvent(event);
    if (breakdown.inputTokens !== null) {
      previous.inputTotal += breakdown.inputTokens;
      previous.inputMeasured = true;
    }
    if (breakdown.cachedInputTokens !== null) {
      previous.cachedTotal += breakdown.cachedInputTokens;
      previous.cacheMeasured = true;
    }
    if (breakdown.outputTokens !== null) {
      previous.outputTotal += breakdown.outputTokens;
      previous.outputMeasured = true;
    }
    const speed = tokensPerSecondFromEvent(event);
    if (speed !== null) previous.speedSamples.push(speed);
    eventRows.set(id, previous);
  }
  if (eventRows.size) {
    return withBreakdownShares([...eventRows.values()].map((row) => ({
      ...row,
      inputTokens: row.inputMeasured ? row.inputTotal : null,
      cachedInputTokens: row.cacheMeasured ? row.cachedTotal : null,
      outputTokens: row.outputMeasured ? row.outputTotal : null,
      tokensPerSecond: median(row.speedSamples),
      speedSampleCount: row.speedSamples.length,
    })));
  }

  // The event stream may be empty while the provider snapshot still has a
  // useful long-window model ledger (for example after the app was reopened).
  // Keep that fallback explicitly labelled so the UI never implies it is a
  // rolling 24-hour figure.
  const fallback = (providerUsage?.providers ?? []).flatMap((provider) =>
    (provider.models ?? [])
      .filter((model) => (model.requests || 0) > 0 || (model.totalTokens || 0) > 0)
      .map((model) => ({
        id: `${provider.id}:${model.slug || model.displayName || "unknown"}`,
        label: model.displayName || shortModelName(model.slug || "unknown"),
        providerId: provider.id,
        provider: provider.displayName,
        tokens: Number(model.totalTokens) || 0,
        requests: Number(model.requests) || 0,
        measuredTokens: Number.isFinite(Number(model.totalTokens)),
        share: 0,
        scope: "90-day ledger" as const,
        inputTokens: Number.isFinite(Number(model.inputTokens)) ? Number(model.inputTokens) : null,
        cachedInputTokens: null,
        outputTokens: Number.isFinite(Number(model.outputTokens)) ? Number(model.outputTokens) : null,
        tokensPerSecond: Number.isFinite(Number(model.observedTokensPerSecond))
          ? Number(model.observedTokensPerSecond)
          : null,
        speedSampleCount: Number(model.speedSampleCount) || 0,
      })),
  );
  return withBreakdownShares(fallback);
}

function modelBreakdownScopeTitle(rows: TrafficBreakdownRow[]): string {
  return rows[0]?.scope === "90-day ledger" ? "Models, 90-day ledger" : "Models, last 24 hours";
}

function recentWindowEvents(events: UsageEvent[] | undefined, now: number): UsageEvent[] {
  if (!events) return [];
  const cutoff = now - 24 * HOUR_MS;
  return events.filter((event) => {
    const at = Date.parse(event.at);
    return Number.isFinite(at) && at >= cutoff && at <= now;
  });
}

function tokenCountFromEvent(event: UsageEvent): number | null {
  const explicit = optionalNumber(event.totalTokens);
  if (explicit !== null) return explicit;
  const input = optionalNumber(event.billedInputTokens ?? event.inputTokens);
  const output = optionalNumber(event.billedOutputTokens ?? event.outputTokens);
  return input !== null || output !== null ? (input || 0) + (output || 0) : null;
}

interface EventTokenBreakdown {
  inputTokens: number | null;
  cachedInputTokens: number | null;
  outputTokens: number | null;
}

function tokenBreakdownFromEvent(event: UsageEvent): EventTokenBreakdown {
  const input = optionalNumber(event.billedInputTokens ?? event.inputTokens);
  const cached = optionalNumber(event.cachedInputTokens);
  const output = optionalNumber(event.billedOutputTokens ?? event.outputTokens);
  return {
    inputTokens: input,
    cachedInputTokens: cached === null ? null : input === null ? cached : Math.min(input, cached),
    outputTokens: output,
  };
}

function tokensPerSecondFromEvent(event: UsageEvent): number | null {
  const output = optionalNumber(event.outputTokens);
  const durationMs = optionalNumber(event.durationMs);
  const firstTokenMs = optionalNumber(event.firstTokenMs);
  if (output === null || output <= 0 || durationMs === null || durationMs <= 0 || firstTokenMs === null) return null;
  if (event.status === undefined || event.status < 200 || event.status >= 400) return null;
  if (
    event.retries
    || event.streamAborted
    || event.emptyCompletion
    || event.emptyCompletionRetried
    || event.progressOnlyRetried
    || event.emptyCompletionUnrepairable
  ) return null;
  const generationDurationMs = durationMs - firstTokenMs;
  if (generationDurationMs <= 0) return null;
  const rate = (output * 1_000) / generationDurationMs;
  return Number.isFinite(rate) && rate <= 500 ? Math.round(rate * 10) / 10 : null;
}

function median(values: number[]): number | null {
  const sorted = values.filter((value) => Number.isFinite(value)).sort((left, right) => left - right);
  if (!sorted.length) return null;
  return Math.round(sorted[Math.floor(sorted.length / 2)] * 10) / 10;
}

function formatTokensPerSecond(value: number): string {
  return `${value.toFixed(1)} tok/s`;
}

function formatEventTokenFacts(total: number | null, breakdown: EventTokenBreakdown): string {
  const facts: string[] = [];
  if (total !== null) facts.push(`${compactNumber(total)} tok`);
  if (breakdown.inputTokens !== null) facts.push(`${compactNumber(breakdown.inputTokens)} input`);
  if (breakdown.cachedInputTokens !== null) facts.push(`${compactNumber(breakdown.cachedInputTokens)} cache`);
  if (breakdown.outputTokens !== null) facts.push(`${compactNumber(breakdown.outputTokens)} output`);
  return facts.length ? facts.join(" · ") : "No token usage reported";
}

function optionalNumber(value: number | string | null | undefined): number | null {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function sumEventTokens(events: UsageEvent[]): number | null {
  let total = 0;
  let measured = false;
  for (const event of events) {
    const tokens = tokenCountFromEvent(event);
    if (tokens === null) continue;
    total += tokens;
    measured = true;
  }
  return measured ? total : null;
}

function eventsCountOrNull(
  events: UsageEvent[] | undefined,
  recent: UsageEvent[],
): number | null {
  return events === undefined ? null : recent.length;
}

function withBreakdownShares(rows: TrafficBreakdownRow[]): TrafficBreakdownRow[] {
  const measuredTotal = rows.reduce((sum, row) => sum + (row.measuredTokens ? row.tokens : 0), 0);
  const requestTotal = rows.reduce((sum, row) => sum + row.requests, 0);
  return rows
    .map((row) => ({
      ...row,
      share: measuredTotal > 0
        ? (row.measuredTokens ? row.tokens : 0) / measuredTotal
        : requestTotal > 0 ? row.requests / requestTotal : 0,
    }))
    .sort((left, right) => right.tokens - left.tokens || right.requests - left.requests);
}

function resetAtOf(metric: UsageMetric): number | string | undefined {
  return metric.resetAt ?? metric.resetsAt;
}

// Returns null when no source reported the field at all, so a build that cannot
// measure a value never renders as a confident zero.
function sumReported(values: Array<number | undefined>): number | null {
  const reported = values.filter((value): value is number => Number.isFinite(Number(value)));
  return reported.length ? reported.reduce((sum, value) => sum + value, 0) : null;
}

function uniqueCount(values: Array<string | undefined>): number {
  // An older health payload may omit identifiers. Count those requests by
  // position instead of silently turning a busy router into "0 chats".
  return new Set(values.map((value, index) => value || `unknown-${index}`)).size;
}

function plural(count: number, word: string): string {
  return count === 1 ? word : `${word}s`;
}

function activityLabel(state: string): string {
  if (state === "generating") return "Thinking";
  if (state === "starting") return "Starting";
  if (state === "error") return "Error";
  if (state === "offline") return "Offline";
  return "Idle";
}

function shortModelName(model: string): string {
  return model.split("/").filter(Boolean).at(-1) || model;
}

function friendlyPlanName(value: string): string {
  return value
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (character) => character.toUpperCase());
}

function limitWindowLabel(minutes: number | undefined, index: number): string {
  if (!Number.isFinite(Number(minutes))) return index === 0 ? "primary limit" : "secondary limit";
  const value = Number(minutes);
  if (value >= 1_440 && value % 1_440 === 0) {
    const days = value / 1_440;
    if (days === 1) return "daily limit";
    if (days === 7) return "weekly limit";
    return `${days}-day limit`;
  }
  if (value >= 60 && value % 60 === 0) return `${value / 60}-hour limit`;
  return `${value}-minute limit`;
}

function timestampFor(value: number | string): number {
  const numeric = Number(value);
  return Number.isFinite(numeric)
    ? numeric < 10_000_000_000 ? numeric * 1_000 : numeric
    : new Date(value).getTime();
}

function resetCountdown(value: number | string): string {
  const remaining = timestampFor(value) - Date.now();
  if (!Number.isFinite(remaining)) return "Time unavailable";
  if (remaining <= 0) return "Refresh due";
  const minutes = Math.ceil(remaining / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m`;
  const days = Math.floor(hours / 24);
  return `${days}d ${hours % 24}h`;
}
