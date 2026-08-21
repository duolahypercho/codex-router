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
import { Badge, Button, EmptyState, PageHeader, SectionHeading } from "../components";
import { ProviderLogo } from "../provider-branding";
import { ServiceHealthPanel } from "../ServiceHealth";
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
  onRefresh,
  runAction,
}: {
  target?: RouterTarget;
  health?: RouterHealth;
  account?: AccountUsage;
  providerUsage?: ProviderUsageSnapshot;
  api?: RouterControlApi;
  refreshing: boolean;
  onRefresh: () => void;
  runAction: RunAction;
}) {
  const [modelQuery, setModelQuery] = useState("");
  const [modelLimit, setModelLimit] = useState(STATUS_MODEL_PAGE_SIZE);
  const [repairing, setRepairing] = useState(false);
  const [contextSavingsRange, setContextSavingsRange] = useState<ContextSavingsRangeKey>("24h");
  const [contextSavingsRangeSelectedByUser, setContextSavingsRangeSelectedByUser] = useState(false);
  // The same repair Settings runs, reached from the panel where a stopped
  // service first becomes visible. Settings stays the only page that renders
  // the diagnostic report; here the toast plus the refreshed health rows are
  // the whole answer, so this page keeps no report surface of its own.
  const repair = async () => {
    if (!api || repairing) return;
    setRepairing(true);
    try {
      await runAction("Repair installation", async () => {
        const report = await api.repairInstall();
        if (!report.ok) {
          const failed = report.checks?.find((check) => check.status === "fail");
          throw new Error(failed ? `${failed.name}: ${failed.detail || "check failed"}` : "Repair finished with failing checks.");
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

  const resetRows = buildResetRows(account, providerUsage);
  const nextReset = resetRows.find((row) => timestampFor(row.resetAt) > Date.now()) ?? resetRows[0];

  const summary = [
    {
      label: "Router",
      value: health ? health.ok ? "Online" : "Offline" : refreshing ? "Checking" : "Unavailable",
      detail: health?.version ? `Version ${health.version}` : health?.error || "Local health endpoint",
      tone: health?.ok ? "success" : "danger",
    },
    {
      label: "Running chats",
      value: exactNumber(chatCount),
      detail: "Unique active sessions",
    },
    {
      label: "Running agents",
      value: exactNumber(runningAgentCount),
      detail: "Named subagents currently in flight",
    },
    {
      label: "Live requests",
      value: exactNumber(activeRequestCount),
      detail: "Concurrent router work",
    },
    {
      label: "Model speed",
      value: fastest ? Number(fastest.observedTokensPerSecond).toFixed(1) : "Unmeasured",
      detail: fastest ? `tok/s · ${fastest.displayName || fastest.slug || "fastest sample"}` : "After a metered reply",
    },
    {
      label: "Context reused",
      value: hasCacheTelemetry ? compactNumber(cachedInputTokens) : "Not reported",
      detail: "Cached input, recent 24h",
    },
    {
      label: "Quota reset",
      value: nextReset ? resetCountdown(nextReset.resetAt) : "Not reported",
      detail: nextReset ? `${nextReset.provider}, ${nextReset.label}` : "No reset timestamp exposed",
    },
  ];

  return (
    <div className="usage-status-page status-page">
      <PageHeader
        eyebrow="Live operations"
        title="Status"
        description="Running chats, agents, model throughput, context reuse, request activity, and quota timing."
        onRefresh={onRefresh}
        refreshing={refreshing}
      />

      <StatusSummary items={summary} />

      <ServiceHealthPanel health={health} onRepair={api ? () => void repair() : undefined} repairing={repairing} />

      <div className="st-primary-grid">
        <section className="panel-section st-live-panel">
          <SectionHeading
            title="Router activity"
            description="Live work from the local health endpoint, grouped by chat and named agent."
          />
          <div className="st-router-state">
            <span className={`st-status-orb state-${state}`} aria-hidden="true"><i /></span>
            <div>
              <strong>{activityLabel(state)}</strong>
              <small>{activity?.model || (health?.ok
                ? "Ready for routed requests"
                : health?.error || "Router unavailable")}</small>
            </div>
            <Badge tone={health?.ok ? "success" : health ? "danger" : "neutral"}>
              {health?.ok ? "reachable" : health ? "offline" : "checking"}
            </Badge>
          </div>

          <div className="st-subsection-heading">
            <div>
              <h3>Live requests</h3>
              <p>Request metadata only. Prompts and responses are never shown here.</p>
            </div>
            <Badge tone={activeRequestCount ? "accent" : "neutral"}>{activeRequestCount} live</Badge>
          </div>

          {active.length ? (
            <div className="st-live-list" role="list" aria-label="Live router requests">
              {active.map((request, index) => {
                const isAgent = request.isSubagent === true
                  || Boolean(request.agentName)
                  || Boolean(request.agentNickname);
                const statusLabel = requestActivityLabel(state);
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
                        <strong>{requestTitle(request)}</strong>
                        <Badge tone={isAgent ? "accent" : "neutral"}>{isAgent ? "agent" : "chat"}</Badge>
                      </header>
                      <div className="st-request-meta">
                        <span>{request.provider || "router"}</span>
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
              title={activeRequestCount ? "Request is starting" : "Router is idle"}
              body={activeRequestCount
                ? "A request has entered the router and is waiting for route metadata."
                : "Running chats and named subagents will appear here as they route work."}
            />
          )}
        </section>

        <section className="panel-section st-context-panel">
          <SectionHeading
            title="Context efficiency"
            description="Accumulated cached input tokens saved across the last 24 hours, 7 days, and 30 days."
          />
          <div className="st-context-window-heading">
            <h3>Cached tokens saved</h3>
            <p>Reported prefix-cache reuse, summed across routed requests.</p>
          </div>
          <dl className="st-context-windows">
            {contextWindowRows.map((row) => (
              <div key={row.label}>
                <dt>{row.label}</dt>
                <dd>{row.value == null ? "Not reported" : compactNumber(row.value)}</dd>
                <small>{row.value == null ? "Waiting for a cache window" : `${exactNumber(row.value)} tokens saved`}</small>
              </div>
            ))}
          </dl>
          {hasCacheTelemetry ? (
            <>
              <dl className="st-context-stats">
                <div>
                  <dt>Cached input</dt>
                  <dd>{compactNumber(cachedInputTokens)}</dd>
                  <small>{exactNumber(cachedInputTokens)} tokens reused</small>
                </div>
                <div>
                  <dt>Input observed</dt>
                  <dd>{compactNumber(observedInputTokens)}</dd>
                  <small>Across {exactNumber(events.length)} recent events</small>
                </div>
                <div>
                  <dt>Reuse share</dt>
                  <dd>{cacheReusePercent == null ? "Not measured" : `${cacheReusePercent.toFixed(1)}%`}</dd>
                  <small>Cached input divided by input tokens</small>
                </div>
              </dl>
              <p className="st-telemetry-note">
                The detailed event view is capped at 1,000 routed events; the windows above use accumulated cache buckets.
                {estimatedInputEvents ? ` ${estimatedInputEvents} event${estimatedInputEvents === 1 ? " used" : "s used"} estimated input tokens.` : ""}
              </p>
            </>
          ) : (
            <EmptyState
              icon={<BrainCircuit size={20} />}
              title="No context reuse telemetry"
              body="Recent routed events have not reported cached input tokens."
            />
          )}
          <section className="st-context-savings" aria-labelledby="context-savings-title">
            <header>
              <div>
                <h3 id="context-savings-title">Tool-result compaction savings</h3>
                <p>Tokens removed from old tool results before the next upstream request.</p>
              </div>
              <div className="st-context-range-picker" role="radiogroup" aria-label="Compaction savings date range">
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
                  ? `No compactions in this window${(compactionStats.requests ?? 0) > 0 ? ` · ${exactNumber(compactionStats.requests)} recorded all-time` : ""}.`
                  : "Compaction savings will appear after the router records its first eligible result."}
              </p>
            )}
          </section>
        </section>
      </div>

      <section className="panel-section st-model-panel">
        <SectionHeading
          title="Model breakdown"
          description="Observed traffic, token mix, and output speed across connected providers."
          action={allModelRows.length ? (
            <label className="st-model-search">
              <Search aria-hidden size={13} strokeWidth={1.7} />
              <input
                aria-label="Filter models"
                value={modelQuery}
                onChange={(event) => {
                  setModelQuery(event.target.value);
                  setModelLimit(STATUS_MODEL_PAGE_SIZE);
                }}
                placeholder="Filter models"
              />
            </label>
          ) : undefined}
        />
        {visibleModels.length ? (
          <>
            <div className="st-model-list" aria-label="Model usage">
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
                Showing {exactNumber(visibleModels.length)} of {exactNumber(filteredModels.length)} models
              </span>
              {visibleModels.length < filteredModels.length ? (
                <Button
                  variant="ghost"
                  onClick={() => setModelLimit((value) => value + STATUS_MODEL_PAGE_SIZE)}
                >
                  Show more
                </Button>
              ) : filteredModels.length > STATUS_MODEL_PAGE_SIZE ? (
                <Button
                  variant="ghost"
                  onClick={() => setModelLimit(STATUS_MODEL_PAGE_SIZE)}
                >
                  Show fewer
                </Button>
              ) : null}
            </div>
          </>
        ) : (
          <EmptyState
            icon={modelQuery ? <SearchX size={20} /> : <Layers3 size={20} />}
            title={modelQuery ? "No models match" : "No model traffic available"}
            body={modelQuery
              ? "Try a model name, slug, or provider."
              : "A metered routed reply will establish the first model row."}
          />
        )}
      </section>

      <div className="st-secondary-grid">
        <section className="panel-section st-reset-panel">
          <SectionHeading
            title="Quota resets"
            description="Reset timestamps from ChatGPT and connected provider account APIs."
          />
          {resetRows.length ? (
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
                    <small>{row.label}{row.remaining == null ? "" : `, ${Math.round(row.remaining)}% left`}</small>
                  </span>
                  <time dateTime={dateTimeValue(row.resetAt)}>
                    <strong>{resetCountdown(row.resetAt)}</strong>
                    <small>{formatDateTime(row.resetAt)}</small>
                  </time>
                </article>
              ))}
            </div>
          ) : (
            <EmptyState
              icon={<Gauge size={20} />}
              title="No reset times reported"
              body="Balances and local traffic do not imply a reset schedule."
            />
          )}
        </section>

        <section className="panel-section st-speed-panel">
          <SectionHeading
            title="Speed leaders"
            description="Fastest observed output rates from successful requests, not synthetic benchmarks."
          />
          {speedRows.length ? (
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
                    <strong>{model.displayName || model.slug || "Unknown model"}</strong>
                    <small>{model.providerName}</small>
                  </span>
                  <span>
                    <strong>{Number(model.observedTokensPerSecond).toFixed(1)} tok/s</strong>
                    <small>{model.speedSampleCount
                      ? `${exactNumber(model.speedSampleCount)} successful samples`
                      : "Sample count unavailable"}</small>
                  </span>
                </article>
              ))}
            </div>
          ) : (
            <EmptyState
              icon={<Timer size={20} />}
              title="No speed samples yet"
              body="A successful metered reply with output tokens and duration will establish observed speed."
            />
          )}
        </section>

      </div>

      <section className="panel-section st-events-panel">
        <SectionHeading
          title="Recent router activity"
          description="Privacy-safe events from the recent 24-hour telemetry window."
        />
        {recentEvents.length ? (
          <div className="st-event-list">
            {recentEvents.map((event, index) => (
              <EventRow key={`${event.at}-${event.model}-${index}`} event={event} />
            ))}
          </div>
        ) : (
          <EmptyState
            icon={<Server size={20} />}
            title="No recent router traffic"
            body="This list fills after a request passes through the local router."
          />
        )}
      </section>
    </div>
  );
}

function StatusModelRow({ model, peak }: { model: StatusModelUsage; peak: number }) {
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
            <strong>{model.displayName || model.slug || "Unknown model"}</strong>
            <small>{model.providerName}</small>
          </span>
        </div>
        <strong>{total > 0 ? `${compactNumber(total)} tok` : `${model.requests || 0} req`}</strong>
      </div>
      <div
        className="st-model-meter"
        role="img"
        aria-label={`${exactNumber(total)} tokens compared with the busiest model in this view`}
      >
        <i style={{ width: `${width}%` }} />
      </div>
      <div className="st-model-facts">
        <span>{compactNumber(model.inputTokens || 0)} input</span>
        <span>{compactNumber(model.outputTokens || 0)} output</span>
        <span>{exactNumber(model.requests || 0)} requests</span>
        {Number.isFinite(speed) ? <span>{speed.toFixed(1)} tok/s</span> : <span>Speed unmeasured</span>}
        {model.speedSampleCount ? <span>{exactNumber(model.speedSampleCount)} speed samples</span> : null}
      </div>
    </article>
  );
}

function StatusSummary({ items }: {
  items: Array<{ label: string; value: string; detail: string; tone?: string }>;
}) {
  return (
    <dl className="st-summary-grid">
      {items.map((item) => (
        <div key={item.label} className={item.tone ? `tone-${item.tone}` : ""}>
          <dt>{item.label}</dt>
          <dd>{item.value}</dd>
          <small>{item.detail}</small>
        </div>
      ))}
    </dl>
  );
}

function EventRow({ event }: { event: UsageEventTelemetry }) {
  const success = Boolean(event.status && event.status >= 200 && event.status < 400);
  const failure = Boolean(event.status && event.status >= 400);
  const total = event.totalTokens ?? (
    event.inputTokens !== undefined || event.outputTokens !== undefined
      ? (event.inputTokens || 0) + (event.outputTokens || 0)
      : undefined
  );
  const flag = eventFlag(event);
  return (
    <article>
      <ProviderLogo
        providerId={event.provider || "router"}
        displayName={event.provider}
        size="small"
        className={failure ? "st-event-logo is-failure" : success ? "st-event-logo is-success" : "st-event-logo"}
      />
      <span className="st-event-model">
        <strong>{shortModelName(event.model || "Unknown model")}</strong>
        <small>{event.provider || "router"}</small>
      </span>
      <span className="st-event-metering">
        <strong>{total === undefined ? "Unmetered" : `${compactNumber(total)} tok`}</strong>
        <small>{event.cachedInputTokens === undefined
          ? "No cache detail"
          : `${compactNumber(event.cachedInputTokens)} cached`}</small>
      </span>
      <span className="st-event-duration">
        <strong>{event.durationMs ? formatDuration(event.durationMs) : "No duration"}</strong>
        <small>{event.status || "No status"}</small>
      </span>
      <span className="st-event-time">
        <time dateTime={dateTimeValue(event.at)}>{formatDateTime(event.at)}</time>
      </span>
      <span className="st-event-flag">
        {flag ? <Badge tone={failure ? "danger" : "warning"}>{flag}</Badge> : null}
      </span>
    </article>
  );
}

function buildResetRows(
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
      label: limitWindowLabel(metric.windowDurationMins, index),
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
        label: metric.label || "Usage limit",
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

function eventFlag(event: UsageEventTelemetry): string | null {
  if (event.streamAborted) return "truncated";
  if (event.emptyCompletionRetried) return "retried empty";
  if (event.emptyCompletion) return "empty reply";
  if (event.emptyCompletionGuardReleased) return "guard released";
  if (event.retries) return `${event.retries} retr${event.retries === 1 ? "y" : "ies"}`;
  if (event.estimatedInputTokens !== undefined) return "estimated input";
  return null;
}

function activityLabel(state: string): string {
  if (state === "generating") return "Thinking";
  if (state === "starting") return "Starting";
  if (state === "error") return "Error";
  if (state === "offline") return "Offline";
  return "Idle";
}

function requestActivityLabel(state: string): string {
  return state === "idle" ? "Working" : activityLabel(state);
}

function requestTitle(request: ActiveRequestTelemetry): string {
  return request.agentNickname
    || request.agentName
    || requestSessionName(request)
    || (request.model ? shortModelName(request.model) : "Routed request");
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
  const peak = Math.max(...buckets, 1);
  return (
    <div className="st-context-savings-chart">
      <div
        className="st-context-savings-bars"
        role="img"
        aria-label={`${exactNumber(savedTokens)} tokens saved across ${exactNumber(requests)} compacted requests in the last ${range.label}, with a peak of ${exactNumber(peak)} tokens per ${range.bucketLabel}`}
        style={{ gridTemplateColumns: `repeat(${Math.max(1, buckets.length)}, minmax(0, 1fr))` }}
      >
        {buckets.map((bucket, index) => (
          <span
            key={index}
            className={bucket > 0 ? "is-populated" : ""}
            style={{ height: bucket > 0 ? `${Math.max(5, (bucket / peak) * 54)}px` : "2px" }}
            title={`${exactNumber(bucket)} tokens saved`}
          />
        ))}
      </div>
      <footer>
        <span>{exactNumber(savedTokens)} tokens saved · {exactNumber(requests)} requests</span>
        <span>Peak {compactNumber(peak)}/{range.bucketLabel}</span>
      </footer>
    </div>
  );
}

function buildContextWindowRows(
  daily: Array<{ startDate: string; cachedInputTokens: number }>,
  last24h: number | undefined,
  hasTelemetry: boolean,
): Array<{ label: string; value: number | null }> {
  return [
    {
      label: "24 hours",
      value: last24h ?? cachedTokensForCalendarDays(daily, 1, hasTelemetry),
    },
    {
      label: "7 days",
      value: cachedTokensForCalendarDays(daily, 7, hasTelemetry),
    },
    {
      label: "30 days",
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
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  start.setDate(start.getDate() - Math.max(0, days - 1));
  const startTimestamp = start.getTime();
  const now = Date.now();
  return daily.reduce((total, bucket) => {
    const timestamp = Date.parse(`${bucket.startDate}T00:00:00`);
    if (!Number.isFinite(timestamp) || timestamp < startTimestamp || timestamp > now) return total;
    return total + Math.max(0, Number(bucket.cachedInputTokens) || 0);
  }, 0);
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

function timestampFor(value: number | string): number {
  const numeric = Number(value);
  return Number.isFinite(numeric)
    ? (numeric < 10_000_000_000 ? numeric * 1_000 : numeric)
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

function dateTimeValue(value: number | string): string {
  const timestamp = timestampFor(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : "";
}
