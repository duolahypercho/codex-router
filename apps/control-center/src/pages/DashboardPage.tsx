import { backendText } from "../backend-text";
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
import { useI18n } from "../i18n-react";
import { translatorLocale, type Translate } from "../i18n";
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
  UsageEventHour,
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
  const t = useI18n();
  // Every prop can be undefined on first paint and after a failed refresh, so
  // each tile below separates three cases: still loading, reported-but-absent,
  // and a genuine zero. A missing field must never render as 0.
  const pending = refreshing ? t("status.summary.checking") : t("status.summary.unavailable");

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
  const eventHours: UsageEventHour[] | undefined = target?.usageEventHours;
  const telemetryEvents24h = recentWindowEvents(target?.usageEvents, Date.now());
  const eventTokens24h = sumEventTokens(telemetryEvents24h);
  const eventRequests24h = eventsCountOrNull(target?.usageEvents, telemetryEvents24h);
  const rollupTokens24h = eventHours?.some((hour) => hour.measuredTokens)
    ? eventHours.reduce((sum, hour) => sum + hour.tokens, 0)
    : null;
  const rollupRequests24h = eventHours?.length
    ? eventHours.reduce((sum, hour) => sum + hour.requests, 0)
    : null;
  const reportedTokens24h = sumReported(providers.map((provider) => provider.last24hTokens));
  const reportedRequests24h = sumReported(providers.map((provider) => provider.last24hRequests));
  // Older installed routers expose the same bounded event stream but predate
  // the provider-level rolling counters. Use it as a presentation fallback so
  // a real day of traffic is not painted as empty during an app/router update.
  // The rollup sits between the two: it covers the whole window, where the
  // event sample is capped and understates a busy day by an order of magnitude.
  const tokens24h = reportedTokens24h ?? rollupTokens24h ?? eventTokens24h;
  const requests24h = reportedRequests24h ?? rollupRequests24h ?? eventRequests24h;
  const usageMeasured = Boolean(providerUsage || target?.usageEvents || eventHours?.length);

  const metrics = useMemo(() => collectMetrics(t, account, providerUsage), [account, providerUsage, t]);
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
  const trafficBuckets = buildTrafficBuckets(events, providerUsage, eventHours, trafficRange, Date.now(), t);
  const providerBreakdown = buildProviderBreakdown(providerUsage, events, Date.now());
  const modelBreakdown = buildModelBreakdown(providerUsage, events, Date.now());
  const trafficHasRequests = trafficBuckets.some((bucket) => bucket.requests > 0);
  const trafficHasTokens = trafficBuckets.some((bucket) => bucket.measuredTokens);

  const tiles: SummaryTile[] = [
    {
      id: "router",
      label: t("dashboard.tile.routerState"),
      icon: Activity,
      value: health ? health.ok ? t("status.summary.online") : t("status.summary.offline") : pending,
      detail: health
        ? health.ok
          ? `${activityLabel(routerState, t)}${health.version ? t("dashboard.tile.version", { version: health.version }) : ""}`
          : health.error || t("dashboard.tile.healthNoAnswer")
        : refreshing ? t("dashboard.tile.contacting") : t("dashboard.tile.healthUnread"),
      tone: health ? health.ok ? "success" : "danger" : undefined,
      view: "status",
      viewLabel: t("dashboard.view.status"),
      pending: healthPending,
    },
    {
      id: "live",
      label: t("dashboard.tile.liveNow"),
      icon: Waypoints,
      value: !health ? pending : activityMeasured ? exactNumber(liveCount) : t("dashboard.tile.notMeasured"),
      detail: !health
        ? t("dashboard.tile.waitingHealth")
        : activityMeasured
          ? `${exactNumber(chatCount)} ${t(chatCount === 1 ? "dashboard.word.chat" : "dashboard.word.chats")} · ${exactNumber(subagents.length)} ${t(subagents.length === 1 ? "dashboard.word.subagent" : "dashboard.word.subagents")}`
          : t("dashboard.tile.liveUnreported"),
      tone: activityMeasured && (liveCount || 0) > 0 ? "accent" : undefined,
      view: "status",
      viewLabel: t("dashboard.view.status"),
      pending: healthPending,
    },
    {
      id: "tokens",
      label: t("dashboard.tile.tokensLabel"),
      icon: CircleGauge,
      value: !usageMeasured ? pending : tokens24h === null ? t("dashboard.tile.notMeasured") : compactNumber(tokens24h),
      detail: !usageMeasured
        ? t("dashboard.tile.waitingTelemetry")
        : tokens24h === null
          ? t("dashboard.tile.noRollingWindow")
          : `${t("dashboard.tile.routerTokens", { count: exactNumber(tokens24h) })}${requests24h === null ? "" : t("dashboard.tile.requestsSuffix", { count: exactNumber(requests24h), word: t(requests24h === 1 ? "dashboard.word.request" : "dashboard.word.requests") })} · ${reportedTokens24h !== null ? t("dashboard.tile.source.providerRows") : rollupTokens24h !== null ? t("dashboard.tile.source.hourlyRollup") : t("dashboard.tile.source.eventDetails")}`,
      view: "usage",
      viewLabel: t("dashboard.view.usage"),
      pending: snapshotPending && !providerUsage,
    },
    {
      id: "reset",
      label: t("dashboard.tile.nextReset"),
      icon: Clock3,
      value: !quotaLoaded ? pending : nextReset ? resetCountdown(nextReset.resetAt, t) : t("dashboard.tile.notReported"),
      detail: !quotaLoaded
        ? t("dashboard.tile.waitingUsage")
        : nextReset
          ? `${nextReset.entry.provider}, ${nextReset.entry.label} · ${formatDateTime(nextReset.resetAt, t)}`
          : t("dashboard.tile.noResetTimestamp"),
      view: "usage",
      viewLabel: t("dashboard.view.usage"),
      pending: quotaPending,
    },
    {
      id: "allowance",
      label: t("dashboard.tile.lowestAllowance"),
      icon: Gauge,
      value: !quotaLoaded
        ? pending
        : lowestAllowance ? t("dashboard.tile.percentLeft", { percent: Math.round(lowestAllowance.percent) }) : t("dashboard.tile.notMeasured"),
      detail: !quotaLoaded
        ? t("dashboard.tile.waitingUsage")
        : lowestAllowance
          ? `${lowestAllowance.entry.provider}, ${lowestAllowance.entry.label}${account?.planType ? t("dashboard.tile.plan", { plan: friendlyPlanName(account.planType) }) : ""}`
          : t("dashboard.tile.noRemainingShare"),
      tone: allowanceTone,
      meter: lowestAllowance ? lowestAllowance.percent : undefined,
      view: "usage",
      viewLabel: t("dashboard.view.usage"),
      pending: quotaPending,
    },
  ];

  return (
    <div className="dashboard-page page-stack">
      <PageHeader
        eyebrow={t("dashboard.eyebrow")}
        title={t("dashboard.title")}
        description={t("dashboard.description")}
        onRefresh={onRefresh}
        refreshing={refreshing}
      />

      {!api ? (
        <InlineNotice tone="warning" title={t("dashboard.bridge.title")}>
          {t("dashboard.bridge.body")}
        </InlineNotice>
      ) : health && !health.ok && health.error ? (
        <InlineNotice tone="danger" title={t("dashboard.healthFailed.title")}>{health.error}</InlineNotice>
      ) : null}

      <div className="db-summary-grid" role="list" aria-label={t("dashboard.summaryAria")}>
        {tiles.map((tile) => {
          const Icon = tile.icon;
          return (
            <button
              key={tile.id}
              type="button"
              role="listitem"
              className={classNames("db-summary-cell", tile.tone && `tone-${tile.tone}`)}
              aria-label={`${tile.label}: ${tile.value}. ${tile.detail}. ${t("dashboard.tile.open", { view: tile.viewLabel })}`}
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
                {t("dashboard.tile.viewLink", { view: tile.viewLabel })}
                <ArrowUpRight aria-hidden size={11} strokeWidth={1.9} />
              </span>
            </button>
          );
        })}
      </div>

      <div className="db-traffic-grid">
        <section className="panel-section db-traffic-panel">
          <SectionHeading
            title={t("dashboard.traffic.title", { range: trafficRangeLabel(trafficRange, t) })}
            description={trafficDescription(trafficRange, t)}
            action={(
              <div className="db-traffic-actions">
                <TrafficRangePicker value={trafficRange} onChange={setTrafficRange} />
                <Button variant="ghost" aria-label={t("dashboard.openUsage")} onClick={() => onNavigate("usage")}>
                  <BarChart3 aria-hidden size={13} strokeWidth={1.7} />
                  {t("dashboard.usage")}
                </Button>
              </div>
            )}
          />
          {snapshotPending ? (
            <PanelSkeleton label={t("dashboard.loading.traffic")} count={4} />
          ) : !events ? (
            <EmptyState
              icon={<BarChart3 size={20} />}
              title={refreshing ? t("dashboard.traffic.reading") : t("dashboard.traffic.unavailable")}
              body={t("dashboard.traffic.emptyBody")}
            />
          ) : trafficHasRequests ? (
            <TrafficTrend buckets={trafficBuckets} hasTokens={trafficHasTokens} range={trafficRange} />
          ) : (
            <EmptyState
              icon={<BarChart3 size={20} />}
              title={t("dashboard.traffic.noRequests", { range: trafficRangeLabel(trafficRange, t) })}
              body={t("dashboard.traffic.chartFill")}
            />
          )}
          {events ? (
            <p className="db-panel-note db-traffic-note">
              {trafficHasTokens
                ? `${t("dashboard.traffic.measured", { tokens: exactNumber(trafficBuckets.reduce((sum, bucket) => sum + bucket.tokens, 0)), requests: exactNumber(trafficBuckets.reduce((sum, bucket) => sum + bucket.requests, 0)), range: trafficRangeLabel(trafficRange, t) })} ${trafficRange === 24 ? eventHours?.length ? t("dashboard.traffic.hourlyRollup") : t("dashboard.traffic.hourlyEvents") : t("dashboard.traffic.dailyLedger")}`
                : trafficHasRequests
                  ? t("dashboard.traffic.requestsObserved", { requests: exactNumber(trafficBuckets.reduce((sum, bucket) => sum + bucket.requests, 0)), range: trafficRangeLabel(trafficRange, t) })
                  : t("dashboard.traffic.emptyWindow", { range: trafficRangeLabel(trafficRange, t) })}
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
            title={t("dashboard.mix.title")}
            description={providerUsage ? t("dashboard.mix.description") : t("dashboard.mix.pending")}
            action={(
              <Button variant="ghost" aria-label={t("dashboard.openStatus")} onClick={() => onNavigate("status")}>
                <Activity aria-hidden size={13} strokeWidth={1.7} />
                {t("dashboard.details")}
              </Button>
            )}
          />
          {providerUsagePending ? (
            <PanelSkeleton label={t("dashboard.loading.mix")} count={4} />
          ) : <div className="db-breakdown-stack">
            <BreakdownGroup
              title={t("dashboard.mix.providers")}
              emptyTitle={providerUsage ? t("dashboard.mix.noProviderTraffic") : refreshing ? t("dashboard.mix.readingProviders") : t("dashboard.mix.providerUnavailable")}
              emptyBody={providerUsage ? t("dashboard.mix.providerEmpty") : t("dashboard.mix.providerEmptyPending")}
              rows={providerBreakdown}
              providerRows
            />
            <BreakdownGroup
              title={modelBreakdownScopeTitle(modelBreakdown, t)}
              emptyTitle={events === undefined && providerUsage === undefined ? t("dashboard.mix.noModelUsage") : t("dashboard.mix.noModelTraffic")}
              emptyBody={modelBreakdown.length ? "" : t("dashboard.mix.modelEmpty")}
              rows={modelBreakdown}
            />
          </div>}
        </section>
      </div>

      <section className="panel-section db-events-panel">
        <SectionHeading
          title={t("dashboard.recent.title")}
          description={t("dashboard.recent.description")}
          action={(
            <Button variant="ghost" aria-label={t("dashboard.openStatus")} onClick={() => onNavigate("status")}>
              <Activity aria-hidden size={13} strokeWidth={1.7} />
              {t("dashboard.status")}
            </Button>
          )}
        />
        {snapshotPending ? (
          <PanelSkeleton label={t("dashboard.loading.recent")} count={5} />
        ) : recentEvents.length ? (
          <div className="db-event-list">
            {recentEvents.map((event, index) => (
              <DashboardEventRow key={`${event.at}-${event.model || "model"}-${index}`} event={event} />
            ))}
          </div>
        ) : (
          <EmptyState
            icon={<Server size={20} />}
            title={events ? t("dashboard.recent.noTraffic") : refreshing ? t("dashboard.traffic.reading") : t("dashboard.traffic.unavailable")}
            body={events
              ? t("dashboard.recent.fill")
              : t("dashboard.recent.pending")}
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
  const t = useI18n();
  const visible = providers.filter((provider) => provider.kind !== "per-model");
  return (
    <section className="db-route-dashboard" aria-labelledby="db-route-dashboard-title">
      <SectionHeading
        title={t("dashboard.routes.title")}
        description={t("dashboard.routes.description")}
        action={<Button variant="ghost" onClick={() => onNavigate("models")}>{t("dashboard.routes.manage")}</Button>}
      />
      {loading ? (
        <PanelSkeleton label={t("dashboard.loading.routes")} count={3} />
      ) : visible.length === 0 ? (
        <EmptyState title={t("dashboard.routes.empty")} body={t("dashboard.routes.emptyBody")} />
      ) : (
        <div className="db-route-list" role="list" aria-label={t("dashboard.routes.aria")}>
          {visible.map((provider) => {
            const enabled = routeMutations.value(provider.id, provider.enabled);
            return (
              <div className="db-route-row" key={provider.id} role="listitem">
                <ProviderLogo providerId={provider.id} displayName={provider.displayName} size="small" />
                <div className="db-route-copy">
                  <strong>{provider.displayName}</strong>
                  <small>{enabled ? t("dashboard.routes.enabled") : t("dashboard.routes.disabled")}</small>
                </div>
                <Badge tone={enabled ? "success" : "neutral"}>{enabled ? t("dashboard.routes.enabledBadge") : t("dashboard.routes.disabledBadge")}</Badge>
                <Button
                  variant={enabled ? "secondary" : "primary"}
                  type="button"
                  disabled={!api}
                  aria-pressed={enabled}
                  aria-label={`${enabled ? t("dashboard.routes.disable") : t("dashboard.routes.enable")} ${provider.displayName}`}
                  onClick={() => {
                    if (!api) return;
                    const next = !enabled;
                    void routeMutations.mutate(
                      provider.id,
                      next,
                      `${next ? t("dashboard.routes.enable") : t("dashboard.routes.disable")} ${provider.displayName}`,
                      () => api.setProviderEnabled(provider.id, next),
                    );
                  }}
                >
                  {enabled ? t("dashboard.routes.disable") : t("dashboard.routes.enable")}
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
  const t = useI18n();
  const [mode, setMode] = useState<TokenActivityMode>("daily");
  const activity = useMemo(
    () => buildTokenActivity(events, providerUsage, Date.now(), t),
    [events, providerUsage, t],
  );
  const viewDays = useMemo(
    () => tokenActivityForMode(activity.days, mode, t),
    [activity.days, mode, t],
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
          <h2>{t("dashboard.activity.title")}</h2>
          <p>
            {providerUsage
              ? t("dashboard.activity.lastYear", { count: exactNumber(total) })
              : refreshing
                ? t("dashboard.activity.reading")
                : events
                  ? t("dashboard.activity.eventsOnly")
                  : t("dashboard.activity.pending")}
          </p>
        </div>
        <div className="db-token-mode" role="radiogroup" aria-label={t("dashboard.activity.modeAria")}>
          {(["daily", "weekly", "cumulative"] as const).map((option) => (
            <button
              key={option}
              type="button"
              role="radio"
              aria-checked={mode === option}
              className={mode === option ? "is-active" : ""}
              onClick={() => setMode(option)}
            >
              {t(option === "daily" ? "dashboard.mode.daily" : option === "weekly" ? "dashboard.mode.weekly" : "dashboard.mode.cumulative")}
            </button>
          ))}
        </div>
      </div>

      {loading ? (
        <PanelSkeleton label={t("dashboard.loading.activity")} count={2} />
      ) : <><div className="db-token-calendar-scroll">
        <div className="db-token-calendar">
          <div className="db-token-cells" role="grid" aria-label={t("dashboard.activity.gridAria", { mode: t(mode === "daily" ? "dashboard.mode.daily" : mode === "weekly" ? "dashboard.mode.weekly" : "dashboard.mode.cumulative") })}>
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
        <span>{activeDays ? t(activeDays === 1 ? "dashboard.activity.activeDay" : "dashboard.activity.activeDays", { count: exactNumber(activeDays) }) : t("dashboard.activity.noActivity")}</span>
        <span className="db-token-scale" aria-label={t("dashboard.activity.scaleAria")}>
          {t("dashboard.activity.less")}
          {[0, 1, 2, 3, 4].map((level) => <i key={level} className={`level-${level}`} />)}
          {t("dashboard.activity.more")}
        </span>
      </div></>}
    </section>
  );
}

function TrafficRangePicker({ value, onChange }: {
  value: TrafficRange;
  onChange: (value: TrafficRange) => void;
}) {
  const t = useI18n();
  return (
    <div className="db-range-picker" role="radiogroup" aria-label={t("dashboard.rangeAria")}>
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
  const t = useI18n();
  const maxTokens = Math.max(...buckets.map((bucket) => bucket.tokens), 1);
  const maxRequests = Math.max(...buckets.map((bucket) => bucket.requests), 1);
  const hasBreakdown = buckets.some((bucket) => bucket.measuredBreakdown);
  const bucketLabel = range === 24 ? t("dashboard.trend.hourly") : t("dashboard.trend.daily");
  const breakdownLabel = hasTokens
    ? hasBreakdown ? t("dashboard.trend.split") : t("dashboard.trend.byTokens")
    : t("dashboard.trend.byRequests");
  return (
    <div
      className="db-trend"
      role="img"
      aria-label={t("dashboard.trend.aria", { bucket: bucketLabel, range: trafficRangeLabel(range, t), breakdown: breakdownLabel })}
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
          const parts = trafficParts(bucket, t);
          const breakdown = bucket.measuredBreakdown
            ? parts.filter((part) => part.tokens > 0).map((part) => t("dashboard.trend.partValue", { label: part.label, count: exactNumber(part.tokens) }))
            : [];
          const label = [
            `${bucket.fullLabel}.`,
            bucket.measuredTokens ? t("dashboard.trend.total", { count: exactNumber(bucket.tokens) }) : t("dashboard.trend.noTokens"),
            ...breakdown.map((item) => `${item}.`),
            t("dashboard.trend.requestsCount", { count: exactNumber(bucket.requests) }),
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
                  {trafficParts(bucket, t).map((part) => (
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
            <span className="is-regular">{t("dashboard.trend.regular")}</span>
            <span className="is-cached">{t("dashboard.trend.cached")}</span>
            <span className="is-output">{t("dashboard.trend.output")}</span>
          </>
        ) : <span className="is-token">{hasTokens ? t("dashboard.trend.tokens") : t("dashboard.trend.requests")}</span>}
        <span className="is-request">{t("dashboard.trend.requestVolume")}</span>
      </div>
    </div>
  );
}

function TrafficTooltip({ bucket, parts }: { bucket: TrafficBucket; parts: TrafficPart[] }) {
  const t = useI18n();
  const visibleParts = bucket.measuredBreakdown ? parts.filter((part) => part.tokens > 0) : [];
  return (
    <span className="db-trend-tooltip" aria-hidden="true">
      <span className="db-trend-tooltip-date">{bucket.fullLabel}</span>
      {bucket.measuredTokens ? (
        <>
          <strong className="db-trend-tooltip-total">{t("dashboard.tooltip.tokens", { count: compactNumber(bucket.tokens).toUpperCase() })}</strong>
          <span className="db-trend-tooltip-exact">{t("dashboard.tooltip.totalTokens", { count: exactNumber(bucket.tokens) })}</span>
        </>
      ) : (
        <strong className="db-trend-tooltip-total">{t("dashboard.tooltip.noTokens")}</strong>
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
          <span>{t("dashboard.tooltip.requests")}</span>
          <strong>{exactNumber(bucket.requests)}</strong>
        </span>
      </span>
      {!bucket.measuredTokens ? (
        <span className="db-trend-tooltip-note">{t("dashboard.tooltip.noUpstreamTokens")}</span>
      ) : !bucket.measuredBreakdown ? (
        <span className="db-trend-tooltip-note">{t("dashboard.tooltip.noBreakdown")}</span>
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
  const t = useI18n();
  const visibleRows = rows.slice(0, 5);
  const max = Math.max(...visibleRows.map((row) => row.tokens), 1);
  return (
    <div className="db-breakdown-group">
      <div className="db-breakdown-heading">
        <h3>{title}</h3>
        {rows.length > visibleRows.length ? <small>{t("dashboard.breakdown.top", { shown: visibleRows.length, total: rows.length })}</small> : null}
      </div>
      {visibleRows.length ? (
        <div className="db-breakdown-list" role="list" aria-label={t("dashboard.breakdown.aria", { title })}>
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
                <small>{row.provider ? `${row.provider} · ` : ""}{exactNumber(row.requests)} {t(row.requests === 1 ? "dashboard.word.request" : "dashboard.word.requests")}{row.measuredTokens ? ` · ${compactNumber(row.tokens)} tok` : t("dashboard.breakdown.tokensNotReported")}</small>
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
  const t = useI18n();
  const facts: Array<{ label: string; tone: "input" | "cached" | "output" | "speed" }> = [];
  if (row.inputTokens != null) facts.push({ label: t("dashboard.facts.input", { count: compactNumber(row.inputTokens) }), tone: "input" });
  if (row.cachedInputTokens != null) facts.push({ label: t("dashboard.facts.cache", { count: compactNumber(row.cachedInputTokens) }), tone: "cached" });
  if (row.outputTokens != null) facts.push({ label: t("dashboard.facts.output", { count: compactNumber(row.outputTokens) }), tone: "output" });
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
  const t = useI18n();
  const status = event.status;
  const tone: Tone | "neutral" = status === undefined
    ? "neutral"
    : status >= 400 ? "danger" : status >= 200 ? "success" : "neutral";
  const total = tokenCountFromEvent(event);
  const speed = tokensPerSecondFromEvent(event);
  const breakdown = tokenBreakdownFromEvent(event);
  const tokenFacts = formatEventTokenFacts(total, breakdown, t);
  return (
    <article>
      <ProviderLogo
        providerId={event.provider || t("dashboard.event.router")}
        displayName={event.provider}
        size="small"
        className="db-event-logo"
      />
      <span className="db-event-model">
        <strong>{shortModelName(event.model || t("dashboard.event.unknownModel"))}</strong>
        <small>{event.provider || t("dashboard.event.router")}</small>
      </span>
      <span className="db-event-metering">
        <strong>{speed == null ? t("dashboard.event.speedUnmeasured") : formatTokensPerSecond(speed)}</strong>
        <small title={tokenFacts}>{tokenFacts}</small>
      </span>
      <span className="db-event-duration">
        <strong>{event.durationMs === undefined ? t("dashboard.event.noDuration") : formatDuration(event.durationMs)}</strong>
        <small>{formatDateTime(event.at, t)}</small>
      </span>
      <span className="db-event-status">
        <Badge tone={tone === "neutral" ? "neutral" : tone}>
          {status === undefined ? t("dashboard.event.noStatus") : String(status)}
        </Badge>
      </span>
    </article>
  );
}

function collectMetrics(
  t: Translate,
  account?: AccountUsage,
  providerUsage?: ProviderUsageSnapshot,
): MetricEntry[] {
  const entries: MetricEntry[] = [];
  for (const [index, metric] of [account?.primary, account?.secondary].entries()) {
    if (!metric) continue;
    entries.push({
      provider: "ChatGPT",
      label: limitWindowLabel(metric.windowDurationMins, index, t),
      metric,
    });
  }
  for (const provider of providerUsage?.providers ?? []) {
    for (const metric of provider.account?.metrics ?? []) {
      entries.push({
        provider: provider.displayName,
        label: backendText(metric.label, t) || t("status.usageLimit"),
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
  t: Translate,
): { days: TokenActivityDay[]; months: TokenActivityMonth[]; today: number } {
  const today = new Date(now);
  today.setUTCHours(0, 0, 0, 0);
  const first = new Date(today);
  first.setUTCDate(first.getUTCDate() - first.getUTCDay() - ((TOKEN_ACTIVITY_WEEKS - 1) * 7));

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
      const dateKey = usageDateKey(at);
      const tokens = tokenCountFromEvent(event);
      if (tokens === null) continue;
      measuredDays.add(dateKey);
      tokensByDay.set(dateKey, (tokensByDay.get(dateKey) ?? 0) + tokens);
    }
  }

  const days = Array.from({ length: TOKEN_ACTIVITY_WEEKS * 7 }, (_, index) => {
    const date = new Date(first);
    date.setUTCDate(first.getUTCDate() + index);
    const dateKey = usageDateKey(date);
    return {
      date,
      dateKey,
      tokens: tokensByDay.get(dateKey) ?? 0,
      measured: measuredDays.has(dateKey),
      weekIndex: Math.floor(index / 7),
      dayIndex: date.getUTCDay(),
    };
  });

  const monthFormatter = new Intl.DateTimeFormat(translatorLocale(t), { month: "short", timeZone: "UTC" });
  const months: TokenActivityMonth[] = [];
  let previousMonth = -1;
  for (const day of days) {
    const month = day.date.getUTCMonth();
    if (month === previousMonth) continue;
    previousMonth = month;
    if (day.date.getUTCDate() > 7) continue;
    months.push({ label: monthFormatter.format(day.date), weekIndex: day.weekIndex });
  }

  return { days, months, today: today.getTime() };
}

function tokenActivityForMode(
  days: TokenActivityDay[],
  mode: TokenActivityMode,
  t: Translate,
): TokenActivityViewDay[] {
  const dateFormatter = new Intl.DateTimeFormat(translatorLocale(t), {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
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
        tooltip: t("dashboard.activity.weeklyTooltip", { count: exactNumber(displayTokens), start: dateFormatter.format(weekStart), end: dateFormatter.format(weekEnd) }),
      };
    }
    if (mode === "cumulative") {
      return {
        ...day,
        displayTokens: cumulative,
        tooltip: t("dashboard.activity.cumulativeTooltip", { count: exactNumber(cumulative), date: dateFormatter.format(day.date) }),
      };
    }
    return {
      ...day,
      displayTokens: day.tokens,
      tooltip: t("dashboard.activity.dailyTooltip", { count: exactNumber(day.tokens), date: dateFormatter.format(day.date) }),
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

// Usage day keys are UTC days wherever they come from -- the router writes them
// that way and OpenAI's account stream reports them that way -- so the grid this
// compares them against has to be built in the same day space.
function usageDateKey(date: Date): string {
  const year = date.getUTCFullYear();
  const month = `${date.getUTCMonth() + 1}`.padStart(2, "0");
  const day = `${date.getUTCDate()}`.padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function trafficRangeLabel(range: TrafficRange, t: Translate): string {
  return range === 24 ? t("dashboard.range.last24h") : t("dashboard.range.lastDays", { range });
}

function trafficDescription(range: TrafficRange, t: Translate): string {
  return range === 24
    ? t("dashboard.traffic.hourly")
    : t("dashboard.traffic.daily");
}

function buildTrafficBuckets(
  events: UsageEvent[] | undefined,
  providerUsage: ProviderUsageSnapshot | undefined,
  hours: UsageEventHour[] | undefined,
  range: TrafficRange,
  now: number,
  t: Translate,
): TrafficBucket[] {
  return range === 24
    ? buildHourlyTrafficBuckets(events, hours, now, t)
    : buildDailyTrafficBuckets(events, providerUsage, range, now, t);
}

// `events` is a bounded sample -- the router caps it at 1,000 rows -- so on a
// busy day it covers a couple of hours, not twenty-four. Summing it drew most
// of the day empty and printed a fraction of the day's tokens as the day's
// total, right next to a summary tile that added up every provider row. The
// router now publishes an hourly rollup over the uncapped window; the sample
// remains the fallback for a router that predates it.
function hourlyBucketsFromRollup(hours: UsageEventHour[], t: Translate): TrafficBucket[] {
  const hourLabelFormatter = new Intl.DateTimeFormat(translatorLocale(t), { hour: "numeric" });
  const hourFullLabelFormatter = new Intl.DateTimeFormat(translatorLocale(t), {
    month: "short", day: "numeric", hour: "numeric",
  });
  // Label each bar from the hour the router actually measured rather than from
  // a grid anchored on the renderer's clock. The two agree until the hour turns
  // over between the snapshot and the render, and then this keeps the newest
  // measured hour on the chart instead of blanking it until the next poll.
  return hours.map((hour) => {
    const start = new Date(hour.startedAt);
    return {
      key: hour.startedAt,
      label: hourLabelFormatter.format(start),
      fullLabel: hourFullLabelFormatter.format(start),
      tokens: hour.tokens,
      requests: hour.requests,
      measuredTokens: hour.measuredTokens,
      regularInputTokens: hour.regularInputTokens,
      cachedInputTokens: hour.cachedInputTokens,
      outputTokens: hour.outputTokens,
      measuredBreakdown: hour.measuredBreakdown,
    };
  });
}

function buildHourlyTrafficBuckets(
  events: UsageEvent[] | undefined,
  hours: UsageEventHour[] | undefined,
  now: number,
  t: Translate,
): TrafficBucket[] {
  if (hours?.length) return hourlyBucketsFromRollup(hours, t);
  const windowStart = now - 24 * HOUR_MS;
  const firstAnchor = new Date(windowStart);
  firstAnchor.setMinutes(0, 0, 0);
  const lastAnchor = new Date(now);
  lastAnchor.setMinutes(0, 0, 0);
  const first = firstAnchor.getTime();
  const lastHour = lastAnchor.getTime();
  const lastBucket = now === lastHour ? lastHour - HOUR_MS : lastHour;
  const bucketCount = Math.floor((lastBucket - first) / HOUR_MS) + 1;
  const formatter = new Intl.DateTimeFormat(translatorLocale(t), { hour: "numeric" });
  const fullFormatter = new Intl.DateTimeFormat(translatorLocale(t), {
    month: "short",
    day: "numeric",
    hour: "numeric",
  });
  const buckets = Array.from({ length: bucketCount }, (_, index) => {
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
    if (!Number.isFinite(at) || at < windowStart || at >= now) continue;
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
  t: Translate,
): TrafficBucket[] {
  // Daily buckets are keyed by UTC day, both by the router and by OpenAI's
  // account stream. Anchoring this grid on local midnight put each bucket on
  // the local day of the same name -- a different window than the one it
  // measured, by the machine's offset -- and left the newest local day with no
  // bucket to match until that offset had elapsed. Grid and labels are UTC so a
  // bar names the day its number is from.
  const anchor = new Date(now);
  anchor.setUTCHours(0, 0, 0, 0);
  const first = anchor.getTime() - (range - 1) * DAY_MS;
  const labelFormatter = new Intl.DateTimeFormat(translatorLocale(t), {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
  const fullFormatter = new Intl.DateTimeFormat(translatorLocale(t), {
    month: "short",
    day: "numeric",
    year: range === 30 ? "numeric" : undefined,
    timeZone: "UTC",
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
      const index = indexForUsageDay(usageBucket.startDate, first, range);
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

function indexForUsageDay(value: string, first: number, count: number): number | null {
  // `T00:00:00` with no zone is local midnight; the key is a UTC day.
  const date = new Date(`${value}T00:00:00Z`);
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

function trafficParts(bucket: TrafficBucket, t: Translate): TrafficPart[] {
  const known = bucket.regularInputTokens + bucket.cachedInputTokens + bucket.outputTokens;
  return [
    { tone: "regular-input", label: t("usage.token.regularInput"), tokens: bucket.regularInputTokens },
    { tone: "cached-input", label: t("usage.token.cachedInput"), tokens: bucket.cachedInputTokens },
    { tone: "output", label: t("usage.token.output"), tokens: bucket.outputTokens },
    { tone: "other", label: t("usage.token.other"), tokens: Math.max(0, bucket.tokens - known) },
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

function modelBreakdownScopeTitle(rows: TrafficBreakdownRow[], t: Translate): string {
  return rows[0]?.scope === "90-day ledger" ? t("dashboard.mix.modelsLedger") : t("dashboard.mix.models24h");
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
  // Same rule as provider-usage.mjs: count the tokens generated inside the
  // timed window. Reasoning that was streamed started the clock, so it stays
  // in; reasoning that ran silently before the first visible token belongs to
  // TTFT and is subtracted. A reasoning count above the output count means the
  // provider reports visible tokens only, so the inclusive total is rebuilt.
  const reasoningTokens = Math.max(0, optionalNumber(event.reasoningTokens) ?? 0);
  const inclusiveOutput = reasoningTokens > output ? output + reasoningTokens : output;
  const speedOutput = event.reasoningStreamed === false
    ? Math.max(0, inclusiveOutput - reasoningTokens)
    : inclusiveOutput;
  const rate = (speedOutput * 1_000) / generationDurationMs;
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

function formatEventTokenFacts(total: number | null, breakdown: EventTokenBreakdown, t: Translate): string {
  const facts: string[] = [];
  if (total !== null) facts.push(t("dashboard.facts.tok", { count: compactNumber(total) }));
  if (breakdown.inputTokens !== null) facts.push(t("dashboard.facts.input", { count: compactNumber(breakdown.inputTokens) }));
  if (breakdown.cachedInputTokens !== null) facts.push(t("dashboard.facts.cache", { count: compactNumber(breakdown.cachedInputTokens) }));
  if (breakdown.outputTokens !== null) facts.push(t("dashboard.facts.output", { count: compactNumber(breakdown.outputTokens) }));
  return facts.length ? facts.join(" · ") : t("dashboard.facts.none");
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

function activityLabel(state: string, t: Translate): string {
  if (state === "generating") return t("status.activity.thinking");
  if (state === "starting") return t("status.activity.starting");
  if (state === "error") return t("status.activity.error");
  if (state === "offline") return t("status.activity.offline");
  return t("status.activity.idle");
}

function shortModelName(model: string): string {
  return model.split("/").filter(Boolean).at(-1) || model;
}

function friendlyPlanName(value: string): string {
  return value
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (character) => character.toUpperCase());
}

function limitWindowLabel(minutes: number | undefined, index: number, t: Translate): string {
  if (!Number.isFinite(Number(minutes))) return index === 0 ? t("status.limit.primary") : t("status.limit.secondary");
  const value = Number(minutes);
  if (value >= 1_440 && value % 1_440 === 0) {
    const days = value / 1_440;
    if (days === 1) return t("status.limit.daily");
    if (days === 7) return t("status.limit.weekly");
    return t("status.limit.days", { days });
  }
  if (value >= 60 && value % 60 === 0) return t("status.limit.hours", { hours: value / 60 });
  return t("status.limit.minutes", { minutes: value });
}

function timestampFor(value: number | string): number {
  const numeric = Number(value);
  return Number.isFinite(numeric)
    ? numeric < 10_000_000_000 ? numeric * 1_000 : numeric
    : new Date(value).getTime();
}

function resetCountdown(value: number | string, t: Translate): string {
  const remaining = timestampFor(value) - Date.now();
  if (!Number.isFinite(remaining)) return t("status.countdown.unavailable");
  if (remaining <= 0) return t("status.countdown.refreshDue");
  const minutes = Math.ceil(remaining / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m`;
  const days = Math.floor(hours / 24);
  return `${days}d ${hours % 24}h`;
}
