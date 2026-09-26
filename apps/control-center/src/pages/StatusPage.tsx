import { backendText } from "../backend-text";
import { useEffect, useState } from "react";
import {
  Activity,
  BrainCircuit,
  Gauge,
  Layers3,
  Search,
  SearchX,
  Server,
  Timer,
} from "lucide-react";
import { Badge, Button, EmptyState, PageHeader, PanelSkeleton, SectionHeading, SkeletonBlock } from "../components";
import { ProviderLogo } from "../provider-branding";
import { ServiceHealthPanel } from "../ServiceHealth";
import { useI18n } from "../i18n-react";
import type { Translate } from "../i18n";
import {
  compactNumber,
  exactNumber,
  formatDateTime,
  formatDuration,
  remainingPercent,
} from "../lib";
import type {
  AccountUsage,
  ActiveRequest,
  ProviderUsageSnapshot,
  ProviderModelUsage,
  RouterControlApi,
  RouterDataReady,
  RouterHealth,
  RouterTarget,
  UsageEvent,
  UsageMetric,
} from "../types";
import "./usage-status.css";
import "./providers-models.css";

type RunAction = (label: string, action: () => Promise<unknown>) => Promise<void>;

type ActiveRequestTelemetry = ActiveRequest & {
  sessionName?: string;
  sessionId?: string;
  threadId?: string;
  parentThreadId?: string;
  agentNickname?: string;
  isSubagent?: boolean;
};

type UsageEventTelemetry = UsageEvent & {
  inputTokens?: number;
  cachedInputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  estimatedInputTokens?: number;
  retries?: number;
  streamAborted?: boolean;
  emptyCompletion?: boolean;
  emptyCompletionRetried?: boolean;
  emptyCompletionGuardReleased?: boolean;
  emptyCompletionPreludeLimit?: "bytes" | "time";
};

type StatusModelUsage = ProviderModelUsage & {
  providerId: string;
  providerName: string;
};

const STATUS_MODEL_PAGE_SIZE = 12;
const CONTEXT_SAVINGS_RANGES = [
  { key: "24h", label: "24H", bucketLabel: "hour" },
  { key: "7d", label: "7D", bucketLabel: "day" },
  { key: "30d", label: "30D", bucketLabel: "day" },
] as const;

type ContextSavingsRangeKey = typeof CONTEXT_SAVINGS_RANGES[number]["key"];

interface ResetRow {
  id: string;
  providerId: string;
  provider: string;
  label: string;
  remaining: number | null;
  resetAt: number | string;
}

export function StatusPage({
  target,
  health,
  account,
  providerUsage,
  api,
  refreshing,
  dataReady,
  onRefresh,
  runAction,
}: {
  target?: RouterTarget;
  health?: RouterHealth;
  account?: AccountUsage;
  providerUsage?: ProviderUsageSnapshot;
  api?: RouterControlApi;
  refreshing: boolean;
  dataReady: RouterDataReady;
  onRefresh: () => void;
  runAction: RunAction;
}) {
  const [modelQuery, setModelQuery] = useState("");
  const [modelLimit, setModelLimit] = useState(STATUS_MODEL_PAGE_SIZE);
  const [repairing, setRepairing] = useState(false);
  const [contextSavingsRange, setContextSavingsRange] = useState<ContextSavingsRangeKey>("24h");
  const [contextSavingsRangeSelectedByUser, setContextSavingsRangeSelectedByUser] = useState(false);
  const t = useI18n();
  const healthPending = !dataReady.health && !health;
  const snapshotPending = !dataReady.snapshot && !target;
  const usagePending = (!dataReady.accountUsage && !account)
    || (!dataReady.providerUsage && !providerUsage);
  // The same repair Settings runs, reached from the panel where a stopped
  // service first becomes visible. Settings stays the only page that renders
  // the diagnostic report; here the toast plus the refreshed health rows are
  // the whole answer, so this page keeps no report surface of its own.
  const repair = async () => {
    if (!api || repairing) return;
    setRepairing(true);
    try {
      await runAction(t("status.repair"), async () => {
        const report = await api.repairInstall();
        if (!report.ok) {
          const failed = report.checks?.find((check) => check.status === "fail");
          throw new Error(failed ? `${failed.name}: ${failed.detail || t("status.repair.checkFailed")}` : t("status.repair.failingChecks"));
        }
        return report;
      });
    } finally {
      setRepairing(false);
    }
  };
  const activity = health?.activity;
  const active = (activity?.active ?? []) as ActiveRequestTelemetry[];
  const activeRequestCount = activity?.activeCount ?? active.length;
  const chatCount = uniqueCount(active.map((request) =>
    request.sessionId
    || request.sessionName
    || request.sessionTitle
    || request.threadId
    || request.id,
  ));
  const namedAgents = active.filter((request) =>
    request.isSubagent === true
    || Boolean(request.agentName)
    || Boolean(request.agentNickname),
  );
  const runningAgentCount = uniqueCount(namedAgents.map((request) =>
    request.threadId
    || `${request.sessionId || request.sessionName || "session"}:${request.agentNickname || request.agentName}`
    || request.id,
  ));

  const state = health
    ? health.ok
      ? activity?.state || "idle"
      : "offline"
    : refreshing
      ? "starting"
      : "offline";

  const speedRows = (providerUsage?.providers ?? [])
    .flatMap((provider) => (provider.models ?? []).map((model) => ({
      ...model,
      providerId: provider.id,
      providerName: provider.displayName,
    })))
    .filter((model) => Number.isFinite(Number(model.observedTokensPerSecond)))
    .sort((left, right) =>
      Number(right.observedTokensPerSecond) - Number(left.observedTokensPerSecond)
      || (right.speedSampleCount || 0) - (left.speedSampleCount || 0),
    );
  const fastest = speedRows[0];

  const allModelRows = (providerUsage?.providers ?? [])
    .flatMap((provider) => (provider.models ?? []).map((model) => ({
      ...model,
      providerId: provider.id,
      providerName: provider.displayName,
    })))
    .sort(modelUsageSort);
  const filteredModels = allModelRows.filter((model) => {
    const needle = modelQuery.trim().toLowerCase();
    return !needle || `${model.displayName || ""} ${model.slug || ""} ${model.providerName}`
      .toLowerCase()
      .includes(needle);
  });
  const visibleModels = filteredModels.slice(0, modelLimit);
  const modelPeak = Math.max(...filteredModels.map((model) => model.totalTokens || 0), 1);

  const events = ((target?.usageEvents ?? []) as UsageEventTelemetry[]);
  const recentEvents = [...events].reverse().slice(0, 12);
  const hasEventCacheTelemetry = events.some((event) =>
    Object.prototype.hasOwnProperty.call(event, "cachedInputTokens"),
  );
  const contextEfficiency = providerUsage?.contextEfficiency;
  const dailyCachedInputTokens = contextEfficiency?.dailyCachedInputTokens ?? [];
  const hasCacheTelemetry = hasEventCacheTelemetry
    || contextEfficiency?.last24hCachedInputTokens !== undefined
    || dailyCachedInputTokens.length > 0;
  const eventCachedInputTokens = events.reduce((sum, event) => sum + (event.cachedInputTokens || 0), 0);
  const cachedInputTokens = contextEfficiency?.last24hCachedInputTokens
    ?? eventCachedInputTokens;
  const observedInputTokens = events.reduce((sum, event) => sum + (event.inputTokens || 0), 0);
  const cacheReusePercent = observedInputTokens > 0
    ? Math.min(100, (cachedInputTokens / observedInputTokens) * 100)
    : null;
  const estimatedInputEvents = events.filter((event) =>
    Number.isFinite(Number(event.estimatedInputTokens)),
  ).length;
  const contextWindowRows = buildContextWindowRows(
    dailyCachedInputTokens,
    contextEfficiency?.last24hCachedInputTokens ?? (hasEventCacheTelemetry ? eventCachedInputTokens : undefined),
    hasCacheTelemetry,
    t,
  );
  const compactionStats = target?.modelSettings?.toolResultAging?.stats;
  const compactionRange = compactionStats?.ranges?.[contextSavingsRange];
  const compactionBuckets = compactionRange?.buckets ?? [];
  const hasCompactionBuckets = compactionBuckets.some((bucket) => bucket > 0);
  const selectedCompactionRange = CONTEXT_SAVINGS_RANGES.find((range) => range.key === contextSavingsRange)!;

  // The snapshot arrives after the first render, so a state initializer cannot
  // choose a populated range. Prefer 24H when it has data, otherwise reveal
  // the nearest useful history once; an explicit operator selection is never
  // overwritten.
  useEffect(() => {
    if (contextSavingsRangeSelectedByUser || !compactionStats?.ranges) return;
    if ((compactionStats.ranges[contextSavingsRange]?.requests ?? 0) > 0) return;
    const firstPopulated = CONTEXT_SAVINGS_RANGES.find((range) =>
      (compactionStats.ranges?.[range.key]?.requests ?? 0) > 0,
    );
    if (firstPopulated) setContextSavingsRange(firstPopulated.key);
  }, [compactionStats, contextSavingsRange, contextSavingsRangeSelectedByUser]);

  const resetRows = buildResetRows(t, account, providerUsage);
  const nextReset = resetRows.find((row) => timestampFor(row.resetAt) > Date.now()) ?? resetRows[0];

  const summary = [
    {
      label: t("status.summary.router"),
      value: health ? health.ok ? t("status.summary.online") : t("status.summary.offline") : refreshing ? t("status.summary.checking") : t("status.summary.unavailable"),
      detail: health?.version ? t("status.summary.version", { version: health.version }) : health?.error || t("status.summary.localHealthEndpoint"),
      tone: health?.ok ? "success" : "danger",
      pending: healthPending,
    },
    {
      label: t("status.summary.runningChats"),
      value: exactNumber(chatCount),
      detail: t("status.summary.uniqueActiveSessions"),
      pending: healthPending,
    },
    {
      label: t("status.summary.runningAgents"),
      value: exactNumber(runningAgentCount),
      detail: t("status.summary.namedSubagents"),
      pending: healthPending,
    },
    {
      label: t("status.summary.liveRequests"),
      value: exactNumber(activeRequestCount),
      detail: t("status.summary.concurrentWork"),
      pending: healthPending,
    },
    {
      label: t("status.summary.modelSpeed"),
      value: fastest ? Number(fastest.observedTokensPerSecond).toFixed(1) : t("status.summary.unmeasured"),
      detail: fastest ? t("status.summary.tokPerSec", { name: fastest.displayName || fastest.slug || t("status.summary.fastestSample") }) : t("status.summary.afterMeteredReply"),
      pending: !dataReady.providerUsage && !providerUsage,
    },
    {
      label: t("status.summary.contextReused"),
      value: hasCacheTelemetry ? compactNumber(cachedInputTokens) : t("status.summary.notReported"),
      detail: t("status.summary.cachedInputRecent24h"),
      pending: snapshotPending && !providerUsage,
    },
    {
      label: t("status.summary.quotaReset"),
      value: nextReset ? resetCountdown(nextReset.resetAt, t) : t("status.summary.notReported"),
      detail: nextReset ? `${nextReset.provider}, ${nextReset.label}` : t("status.summary.noResetTimestamp"),
      pending: usagePending,
    },
  ];

  return (
    <div className="usage-status-page status-page">
      <PageHeader
        eyebrow={t("status.eyebrow")}
        title={t("status.title")}
        description={t("status.description")}
        onRefresh={onRefresh}
        refreshing={refreshing}
      />

      <StatusSummary items={summary} />

      {healthPending ? (
        <section className="panel-section st-service-loading" aria-label={t("status.loading.serviceHealth")} aria-busy="true">
          <PanelSkeleton label={t("status.loading.serviceHealth")} count={2} />
        </section>
      ) : (
        <ServiceHealthPanel health={health} onRepair={api ? () => void repair() : undefined} repairing={repairing} />
      )}

      <div className="st-primary-grid">
        <section className={`panel-section st-live-panel${healthPending ? " is-partition-loading" : ""}`} aria-busy={healthPending}>
          {healthPending ? <div className="st-partition-skeleton"><PanelSkeleton label={t("status.loading.liveActivity")} count={4} /></div> : null}
          <SectionHeading
            title={t("status.routerActivity.title")}
            description={t("status.routerActivity.description")}
          />
          <div className="st-router-state">
            <RouterActivityOrb state={state} />
            <div>
              <strong>{activityLabel(state, t)}</strong>
              <small>{activity?.model || (health?.ok
                ? t("status.router.readyForRequests")
                : health?.error || t("status.router.unavailable"))}</small>
            </div>
            <Badge tone={health?.ok ? "success" : health ? "danger" : "neutral"}>
              {health?.ok ? t("status.badge.reachable") : health ? t("status.badge.offline") : t("status.badge.checking")}
            </Badge>
          </div>

          <div className="st-subsection-heading">
            <div>
              <h3>{t("status.liveRequests.title")}</h3>
              <p>{t("status.liveRequests.description")}</p>
            </div>
            <Badge tone={activeRequestCount ? "accent" : "neutral"}>{t("status.liveCount", { count: activeRequestCount })}</Badge>
          </div>

          {active.length ? (
            <div className="st-live-list" role="list" aria-label={t("status.liveRequestsAria")}>
              {active.map((request, index) => {
                const isAgent = request.isSubagent === true
                  || Boolean(request.agentName)
                  || Boolean(request.agentNickname);
                const statusLabel = requestActivityLabel(state, t);
                return (
                  <article role="listitem" key={request.id || `${request.model}-${index}`}>
                    <ProviderLogo
                      providerId={request.provider || "openai"}
                      displayName={request.provider}
                      size="small"
                      className="st-request-logo"
                    />
                    <div className="st-request-body">
                      <header>
                        <strong>{requestTitle(request, t)}</strong>
                        <Badge tone={isAgent ? "accent" : "neutral"}>{isAgent ? t("status.agent") : t("status.chat")}</Badge>
                      </header>
                      <div className="st-request-meta">
                        <span>{request.provider || t("status.routerFallback")}</span>
                        {request.model ? <span>{shortModelName(request.model)}</span> : null}
                        {requestSessionName(request) ? <span>{requestSessionName(request)}</span> : null}
                      </div>
                    </div>
                    <time>
                      <strong>{statusLabel}</strong>
                      <span>· {liveElapsedLabel(request)}</span>
                    </time>
                  </article>
                );
              })}
            </div>
          ) : (
            <EmptyState
              icon={<Activity size={20} />}
              title={activeRequestCount ? t("status.empty.requestStarting") : t("status.empty.routerIdle")}
              body={activeRequestCount
                ? t("status.empty.requestStartingBody")
                : t("status.empty.routerIdleBody")}
            />
          )}
        </section>

        <section className={`panel-section st-context-panel${snapshotPending && !providerUsage ? " is-partition-loading" : ""}`} aria-busy={snapshotPending && !providerUsage}>
          {snapshotPending && !providerUsage ? <div className="st-partition-skeleton"><PanelSkeleton label={t("status.loading.contextEfficiency")} count={4} /></div> : null}
          <SectionHeading
            title={t("status.context.title")}
            description={t("status.context.description")}
          />
          <div className="st-context-window-heading">
            <h3>{t("status.context.cachedSaved")}</h3>
            <p>{t("status.context.cachedSavedDesc")}</p>
          </div>
          <dl className="st-context-windows">
            {contextWindowRows.map((row) => (
              <div key={row.label}>
                <dt>{row.label}</dt>
                <dd>{row.value == null ? t("status.summary.notReported") : compactNumber(row.value)}</dd>
                <small>{row.value == null ? t("status.context.waitingCacheWindow") : t("status.context.tokensSaved", { count: exactNumber(row.value) })}</small>
              </div>
            ))}
          </dl>
          {hasCacheTelemetry ? (
            <>
              <dl className="st-context-stats">
                <div>
                  <dt>{t("status.context.cachedInput")}</dt>
                  <dd>{compactNumber(cachedInputTokens)}</dd>
                  <small>{t("status.context.tokensReused", { count: exactNumber(cachedInputTokens) })}</small>
                </div>
                <div>
                  <dt>{t("status.context.inputObserved")}</dt>
                  <dd>{compactNumber(observedInputTokens)}</dd>
                  <small>{t("status.context.acrossEvents", { count: exactNumber(events.length) })}</small>
                </div>
                <div>
                  <dt>{t("status.context.reuseShare")}</dt>
                  <dd>{cacheReusePercent == null ? t("status.context.notMeasured") : `${cacheReusePercent.toFixed(1)}%`}</dd>
                  <small>{t("status.context.reuseShareDesc")}</small>
                </div>
              </dl>
              <p className="st-telemetry-note">
                {t("status.context.telemetryNote")}
                {estimatedInputEvents ? ` ${estimatedInputEvents === 1 ? t("status.context.estimatedOne", { count: estimatedInputEvents }) : t("status.context.estimatedMany", { count: estimatedInputEvents })}` : ""}
              </p>
            </>
          ) : (
            <EmptyState
              icon={<BrainCircuit size={20} />}
              title={t("status.context.noTelemetry")}
              body={t("status.context.noTelemetryBody")}
            />
          )}
          <section className="st-context-savings" aria-labelledby="context-savings-title">
            <header>
              <div>
                <h3 id="context-savings-title">{t("status.context.compactionTitle")}</h3>
                <p>{t("status.context.compactionDesc")}</p>
              </div>
              <div className="st-context-range-picker" role="radiogroup" aria-label={t("status.context.compactionRangeAria")}>
                {CONTEXT_SAVINGS_RANGES.map((range) => (
                  <button
                    type="button"
                    key={range.key}
                    role="radio"
                    aria-checked={contextSavingsRange === range.key}
                    className={contextSavingsRange === range.key ? "is-active" : ""}
                    onClick={() => {
                      setContextSavingsRange(range.key);
                      setContextSavingsRangeSelectedByUser(true);
                    }}
                  >
                    {range.label}
                  </button>
                ))}
              </div>
            </header>
            {compactionStats && hasCompactionBuckets ? (
              <ContextSavingsChart
                buckets={compactionBuckets}
                range={selectedCompactionRange}
                savedTokens={compactionRange?.savedTokens ?? 0}
                requests={compactionRange?.requests ?? 0}
              />
            ) : (
              <p className="st-context-savings-empty">
                {compactionStats
                  ? `${t("status.context.noCompactions")}${(compactionStats.requests ?? 0) > 0 ? ` · ${t("status.context.recordedAllTime", { count: exactNumber(compactionStats.requests) })}` : ""}.`
                  : t("status.context.compactionEmpty")}
              </p>
            )}
          </section>
        </section>
      </div>

      <section className="panel-section st-model-panel">
        <SectionHeading
          title={t("status.models.title")}
          description={t("status.models.description")}
          action={allModelRows.length ? (
            <label className="st-model-search">
              <Search aria-hidden size={13} strokeWidth={1.7} />
              <input
                aria-label={t("status.models.filter")}
                value={modelQuery}
                onChange={(event) => {
                  setModelQuery(event.target.value);
                  setModelLimit(STATUS_MODEL_PAGE_SIZE);
                }}
                placeholder={t("status.models.filter")}
              />
            </label>
          ) : undefined}
        />
        {!dataReady.providerUsage && !providerUsage ? (
          <PanelSkeleton label={t("status.loading.modelUsage")} count={6} />
        ) : visibleModels.length ? (
          <>
            <div className="st-model-list" aria-label={t("status.models.aria")}>
              {visibleModels.map((model) => (
                <StatusModelRow
                  key={`${model.providerId}/${model.slug || model.displayName}`}
                  model={model}
                  peak={modelPeak}
                />
              ))}
            </div>
            <div className="st-model-pagination" aria-live="polite">
              <span>
                {t("status.models.showing", { shown: exactNumber(visibleModels.length), total: exactNumber(filteredModels.length) })}
              </span>
              {visibleModels.length < filteredModels.length ? (
                <Button
                  variant="ghost"
                  onClick={() => setModelLimit((value) => value + STATUS_MODEL_PAGE_SIZE)}
                >
                  {t("status.models.showMore")}
                </Button>
              ) : filteredModels.length > STATUS_MODEL_PAGE_SIZE ? (
                <Button
                  variant="ghost"
                  onClick={() => setModelLimit(STATUS_MODEL_PAGE_SIZE)}
                >
                  {t("status.models.showFewer")}
                </Button>
              ) : null}
            </div>
          </>
        ) : (
          <EmptyState
            icon={modelQuery ? <SearchX size={20} /> : <Layers3 size={20} />}
            title={modelQuery ? t("status.models.noMatch") : t("status.models.noTraffic")}
            body={modelQuery
              ? t("status.models.noMatchBody")
              : t("status.models.noTrafficBody")}
          />
        )}
      </section>

      <div className="st-secondary-grid">
        <section className="panel-section st-reset-panel">
          <SectionHeading
            title={t("status.quota.title")}
            description={t("status.quota.description")}
          />
          {usagePending ? (
            <PanelSkeleton label={t("status.loading.quotaResets")} count={3} />
          ) : resetRows.length ? (
            <div className="st-reset-list">
              {resetRows.slice(0, 10).map((row) => (
                <article key={row.id}>
                  <ProviderLogo
                    providerId={row.providerId}
                    displayName={row.provider}
                    size="small"
                    className="st-list-logo"
                  />
                  <span>
                    <strong>{row.provider}</strong>
                    <small>{row.label}{row.remaining == null ? "" : `, ${t("status.quota.percentLeft", { percent: Math.round(row.remaining) })}`}</small>
                  </span>
                  <time dateTime={dateTimeValue(row.resetAt)}>
                    <strong>{resetCountdown(row.resetAt, t)}</strong>
                    <small>{formatDateTime(row.resetAt, t)}</small>
                  </time>
                </article>
              ))}
            </div>
          ) : (
            <EmptyState
              icon={<Gauge size={20} />}
              title={t("status.quota.empty")}
              body={t("status.quota.emptyBody")}
            />
          )}
        </section>

        <section className="panel-section st-speed-panel">
          <SectionHeading
            title={t("status.speed.title")}
            description={t("status.speed.description")}
          />
          {!dataReady.providerUsage && !providerUsage ? (
            <PanelSkeleton label={t("status.loading.modelSpeed")} count={3} />
          ) : speedRows.length ? (
            <div className="st-speed-list">
              {speedRows.slice(0, 12).map((model) => (
                <article key={`${model.providerId}/${model.slug || model.displayName}`}>
                  <ProviderLogo
                    providerId={model.providerId}
                    displayName={model.providerName}
                    size="small"
                    className="st-list-logo"
                  />
                  <span>
                    <strong>{model.displayName || model.slug || t("status.model.unknown")}</strong>
                    <small>{model.providerName}</small>
                  </span>
                  <span>
                    <strong>{Number(model.observedTokensPerSecond).toFixed(1)} tok/s</strong>
                    <small>{model.speedSampleCount
                      ? t("status.speed.successfulSamples", { count: exactNumber(model.speedSampleCount) })
                      : t("status.speed.sampleUnavailable")}</small>
                  </span>
                </article>
              ))}
            </div>
          ) : (
            <EmptyState
              icon={<Timer size={20} />}
              title={t("status.speed.empty")}
              body={t("status.speed.emptyBody")}
            />
          )}
        </section>

      </div>

      <section className="panel-section st-events-panel">
        <SectionHeading
          title={t("status.recent.title")}
          description={t("status.recent.description")}
        />
        {snapshotPending ? (
          <PanelSkeleton label={t("status.loading.recentActivity")} count={5} />
        ) : recentEvents.length ? (
          <div className="st-event-list">
            {recentEvents.map((event, index) => (
              <EventRow key={`${event.at}-${event.model}-${index}`} event={event} />
            ))}
          </div>
        ) : (
          <EmptyState
            icon={<Server size={20} />}
            title={t("status.recent.empty")}
            body={t("status.recent.emptyBody")}
          />
        )}
      </section>
    </div>
  );
}

function RouterActivityOrb({ state }: { state: string }) {
  return (
    <span className={`st-status-orb state-${state}`} aria-hidden="true">
      <i className="st-orb-core" />
      <span className="st-orb-particle" />
      <span className="st-orb-particle" />
      <span className="st-orb-particle" />
      <span className="st-orb-particle" />
      <span className="st-orb-particle" />
      <span className="st-orb-particle" />
    </span>
  );
}

function StatusModelRow({ model, peak }: { model: StatusModelUsage; peak: number }) {
  const t = useI18n();
  const total = model.totalTokens || 0;
  const width = Math.max(total > 0 ? 1.5 : 0, (total / peak) * 100);
  const speed = Number(model.observedTokensPerSecond);
  return (
    <article className="st-model-row">
      <div className="st-model-heading">
        <div className="st-model-identity">
          <ProviderLogo
            providerId={model.providerId}
            displayName={model.providerName}
            size="small"
            className="st-list-logo"
          />
          <span>
            <strong>{model.displayName || model.slug || t("status.model.unknown")}</strong>
            <small>{model.providerName}</small>
          </span>
        </div>
        <strong>{total > 0 ? t("status.model.tok", { count: compactNumber(total) }) : t("status.model.req", { count: model.requests || 0 })}</strong>
      </div>
      <div
        className="st-model-meter"
        role="img"
        aria-label={t("status.model.meterAria", { count: exactNumber(total) })}
      >
        <i style={{ width: `${width}%` }} />
      </div>
      <div className="st-model-facts">
        <span>{t("status.model.input", { count: compactNumber(model.inputTokens || 0) })}</span>
        <span>{t("status.model.output", { count: compactNumber(model.outputTokens || 0) })}</span>
        <span>{t("status.model.requests", { count: exactNumber(model.requests || 0) })}</span>
        {Number.isFinite(speed) ? <span>{speed.toFixed(1)} tok/s</span> : <span>{t("status.model.speedUnmeasured")}</span>}
        {model.speedSampleCount ? <span>{t("status.model.speedSamples", { count: exactNumber(model.speedSampleCount) })}</span> : null}
      </div>
    </article>
  );
}

function StatusSummary({ items }: {
  items: Array<{ label: string; value: string; detail: string; tone?: string; pending?: boolean }>;
}) {
  return (
    <dl className="st-summary-grid">
      {items.map((item) => (
        <div key={item.label} className={item.tone ? `tone-${item.tone}` : ""}>
          <dt>{item.label}</dt>
          {item.pending ? <SkeletonBlock className="st-skeleton-summary-value" /> : <dd>{item.value}</dd>}
          {item.pending ? <SkeletonBlock className="st-skeleton-summary-detail" /> : <small>{item.detail}</small>}
        </div>
      ))}
    </dl>
  );
}

function EventRow({ event }: { event: UsageEventTelemetry }) {
  const t = useI18n();
  const success = Boolean(event.status && event.status >= 200 && event.status < 400);
  const failure = Boolean(event.status && event.status >= 400);
  const total = event.totalTokens ?? (
    event.inputTokens !== undefined || event.outputTokens !== undefined
      ? (event.inputTokens || 0) + (event.outputTokens || 0)
      : undefined
  );
  const flag = eventFlag(event, t);
  return (
    <article>
      <ProviderLogo
        providerId={event.provider || "router"}
        displayName={event.provider}
        size="small"
        className={failure ? "st-event-logo is-failure" : success ? "st-event-logo is-success" : "st-event-logo"}
      />
      <span className="st-event-model">
        <strong>{shortModelName(event.model || t("status.model.unknown"))}</strong>
        <small>{event.provider || t("status.routerFallback")}</small>
      </span>
      <span className="st-event-metering">
        <strong>{total === undefined ? t("status.event.unmetered") : t("status.model.tok", { count: compactNumber(total) })}</strong>
        <small>{event.cachedInputTokens === undefined
          ? t("status.event.noCacheDetail")
          : t("status.event.cached", { count: compactNumber(event.cachedInputTokens) })}</small>
      </span>
      <span className="st-event-duration">
        <strong>{event.durationMs ? formatDuration(event.durationMs) : t("status.event.noDuration")}</strong>
        <small>{event.status || t("status.event.noStatus")}</small>
      </span>
      <span className="st-event-time">
        <time dateTime={dateTimeValue(event.at)}>{formatDateTime(event.at, t)}</time>
      </span>
      <span className="st-event-flag">
        {flag ? <Badge tone={failure ? "danger" : "warning"}>{flag}</Badge> : null}
      </span>
    </article>
  );
}

function buildResetRows(
  t: Translate,
  account?: AccountUsage,
  providerUsage?: ProviderUsageSnapshot,
): ResetRow[] {
  const rows: ResetRow[] = [];
  for (const [index, metric] of [account?.primary, account?.secondary].entries()) {
    if (!metric) continue;
    const resetAt = metric.resetAt || metric.resetsAt;
    if (!resetAt) continue;
    rows.push({
      id: `chatgpt-${index}`,
      providerId: "openai",
      provider: "ChatGPT",
      label: limitWindowLabel(metric.windowDurationMins, index, t),
      remaining: remainingPercent(metric),
      resetAt,
    });
  }
  for (const provider of providerUsage?.providers ?? []) {
    for (const [index, metric] of (provider.account?.metrics ?? []).entries()) {
      const resetAt = metric.resetAt || metric.resetsAt;
      if (!resetAt) continue;
      rows.push({
        id: `${provider.id}-${index}-${metric.label}`,
        providerId: provider.id,
        provider: provider.displayName,
        label: backendText(metric.label, t) || t("status.usageLimit"),
        remaining: remainingPercent(metric),
        resetAt,
      });
    }
  }
  return rows.sort((left, right) => {
    const leftTime = timestampFor(left.resetAt);
    const rightTime = timestampFor(right.resetAt);
    const leftPast = leftTime <= Date.now();
    const rightPast = rightTime <= Date.now();
    if (leftPast !== rightPast) return leftPast ? 1 : -1;
    return leftTime - rightTime;
  });
}

function eventFlag(event: UsageEventTelemetry, t: Translate): string | null {
  if (event.streamAborted) return t("status.flag.truncated");
  if (event.emptyCompletionPreludeLimit) {
    return t("status.flag.guardLimit", { limit: event.emptyCompletionPreludeLimit });
  }
  if (event.emptyCompletionRetried) return t("status.flag.retriedEmpty");
  if (event.emptyCompletion) return t("status.flag.emptyReply");
  if (event.emptyCompletionGuardReleased) return t("status.flag.guardReleased");
  if (event.retries) return event.retries === 1
    ? t("status.flag.retryOne", { count: event.retries })
    : t("status.flag.retryMany", { count: event.retries });
  if (event.estimatedInputTokens !== undefined) return t("status.flag.estimatedInput");
  return null;
}

function activityLabel(state: string, t: Translate): string {
  if (state === "generating") return t("status.activity.thinking");
  if (state === "starting") return t("status.activity.starting");
  if (state === "error") return t("status.activity.error");
  if (state === "offline") return t("status.activity.offline");
  return t("status.activity.idle");
}

function requestActivityLabel(state: string, t: Translate): string {
  return state === "idle" ? t("status.activity.working") : activityLabel(state, t);
}

function requestTitle(request: ActiveRequestTelemetry, t: Translate): string {
  return request.agentNickname
    || request.agentName
    || requestSessionName(request)
    || (request.model ? shortModelName(request.model) : t("status.request.routedRequest"));
}

function requestSessionName(request: ActiveRequestTelemetry): string | undefined {
  return request.sessionName || request.sessionTitle;
}

function shortModelName(model: string): string {
  return model.split("/").filter(Boolean).at(-1) || model;
}

function uniqueCount(values: Array<string | undefined>): number {
  return new Set(values.filter((value): value is string => Boolean(value))).size;
}

function modelUsageSort(left: StatusModelUsage, right: StatusModelUsage): number {
  return (right.totalTokens || 0) - (left.totalTokens || 0)
    || (right.requests || 0) - (left.requests || 0)
    || (left.displayName || left.slug || "").localeCompare(right.displayName || right.slug || "")
    || left.providerName.localeCompare(right.providerName);
}

function elapsedFrom(startedAt: number | string | undefined): number {
  if (startedAt === undefined) return 0;
  const numeric = Number(startedAt);
  const start = Number.isFinite(numeric)
    ? numeric < 10_000_000_000 ? numeric * 1_000 : numeric
    : new Date(startedAt).getTime();
  return Number.isFinite(start) ? Math.max(0, Date.now() - start) : 0;
}

function liveElapsedLabel(request: ActiveRequestTelemetry): string {
  const milliseconds = request.elapsedMs ?? elapsedFrom(request.startedAt);
  const seconds = Math.floor(Math.max(0, milliseconds) / 1_000);
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

function ContextSavingsChart({
  buckets,
  range,
  savedTokens,
  requests,
}: {
  buckets: number[];
  range: typeof CONTEXT_SAVINGS_RANGES[number];
  savedTokens: number;
  requests: number;
}) {
  const t = useI18n();
  const peak = Math.max(...buckets, 1);
  return (
    <div className="st-context-savings-chart">
      <div
        className="st-context-savings-bars"
        role="img"
        aria-label={t("status.chart.aria", {
          saved: exactNumber(savedTokens),
          requests: exactNumber(requests),
          range: range.label,
          peak: exactNumber(peak),
          bucket: range.bucketLabel,
        })}
        style={{ gridTemplateColumns: `repeat(${Math.max(1, buckets.length)}, minmax(0, 1fr))` }}
      >
        {buckets.map((bucket, index) => (
          <span
            key={index}
            className={bucket > 0 ? "is-populated" : ""}
            style={{ height: bucket > 0 ? `${Math.max(5, (bucket / peak) * 54)}px` : "2px" }}
            title={t("status.chart.tokensSavedTitle", { count: exactNumber(bucket) })}
          />
        ))}
      </div>
      <footer>
        <span>{t("status.chart.footer", { saved: exactNumber(savedTokens), requests: exactNumber(requests) })}</span>
        <span>{t("status.chart.peak", { peak: compactNumber(peak), bucket: range.bucketLabel })}</span>
      </footer>
    </div>
  );
}

function buildContextWindowRows(
  daily: Array<{ startDate: string; cachedInputTokens: number }>,
  last24h: number | undefined,
  hasTelemetry: boolean,
  t: Translate,
): Array<{ label: string; value: number | null }> {
  return [
    {
      label: t("status.context.window.24h"),
      value: last24h ?? cachedTokensForCalendarDays(daily, 1, hasTelemetry),
    },
    {
      label: t("status.context.window.7d"),
      value: cachedTokensForCalendarDays(daily, 7, hasTelemetry),
    },
    {
      label: t("status.context.window.30d"),
      value: cachedTokensForCalendarDays(daily, 30, hasTelemetry),
    },
  ];
}

function cachedTokensForCalendarDays(
  daily: Array<{ startDate: string; cachedInputTokens: number }>,
  days: number,
  hasTelemetry: boolean,
): number | null {
  if (!daily.length) return hasTelemetry ? 0 : null;
  // Bucket keys are UTC days, so the window bounding them has to be as well.
  const start = new Date();
  start.setUTCHours(0, 0, 0, 0);
  start.setUTCDate(start.getUTCDate() - Math.max(0, days - 1));
  const startTimestamp = start.getTime();
  const now = Date.now();
  return daily.reduce((total, bucket) => {
    const timestamp = Date.parse(`${bucket.startDate}T00:00:00Z`);
    if (!Number.isFinite(timestamp) || timestamp < startTimestamp || timestamp > now) return total;
    return total + Math.max(0, Number(bucket.cachedInputTokens) || 0);
  }, 0);
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
    ? (numeric < 10_000_000_000 ? numeric * 1_000 : numeric)
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

function dateTimeValue(value: number | string): string {
  const timestamp = timestampFor(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : "";
}
