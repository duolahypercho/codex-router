import { getLanguage, getLocale, t } from "./i18n.mjs";

const DAY_MS = 24 * 60 * 60 * 1_000;

export function clampPercent(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  return Math.min(100, Math.max(0, number));
}

export function compactTokens(value) {
  const tokens = Math.max(0, Number(value) || 0);
  if (tokens < 1_000) return Math.round(tokens).toLocaleString(getLocale());
  if (tokens < 1_000_000) return `${trimFixed(tokens / 1_000, tokens < 10_000 ? 1 : 0)}k`;
  return `${trimFixed(tokens / 1_000_000, tokens < 10_000_000 ? 1 : 0)}m`;
}

export function exactTokens(value) {
  return Math.max(0, Math.round(Number(value) || 0)).toLocaleString(getLocale());
}

export function modelMatchesQuery(model, query, providerName = "") {
  const needle = String(query || "").trim().toLocaleLowerCase();
  if (!needle) return true;
  return [model?.displayName, model?.slug, model?.provider, providerName]
    .filter(Boolean)
    .join(" ")
    .toLocaleLowerCase()
    .includes(needle);
}

export function localDateKey(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function dailySeries(buckets = [], days = 7, today = new Date()) {
  const indexed = new Map(
    buckets.map((bucket) => [String(bucket.startDate), bucket]),
  );
  const anchor = new Date(today.getFullYear(), today.getMonth(), today.getDate(), 12);
  return Array.from({ length: days }, (_, index) => {
    const date = new Date(anchor.getTime() - (days - index - 1) * DAY_MS);
    const key = localDateKey(date);
    const bucket = indexed.get(key);
    return {
      key,
      label: new Intl.DateTimeFormat(getLocale(), { weekday: "short" }).format(date),
      longLabel: new Intl.DateTimeFormat(getLocale(), {
        month: "short",
        day: "numeric",
      }).format(date),
      tokens: Number(bucket?.tokens) || 0,
      ...(bucket?.displaySource ? { displaySource: bucket.displaySource } : {}),
    };
  });
}

export function chartGeometry(series, width = 328, height = 112, padding = 10) {
  const values = series.map((point) => Math.max(0, Number(point.tokens) || 0));
  const ceiling = Math.max(...values, 1);
  const usableWidth = width - padding * 2;
  const usableHeight = height - padding * 2;
  const points = values.map((value, index) => ({
    x: padding + (values.length === 1 ? usableWidth / 2 : (index / (values.length - 1)) * usableWidth),
    y: padding + usableHeight - (value / ceiling) * usableHeight,
    value,
  }));
  const line = smoothPath(points);
  const baseline = height - padding;
  const area = points.length
    ? `${line} L ${points.at(-1).x.toFixed(2)} ${baseline} L ${points[0].x.toFixed(2)} ${baseline} Z`
    : "";
  return { points, line, area, ceiling };
}

// Providers label their own quota windows, and the router passes those labels
// through in English. Translate the labels the router emits, keep the generic
// "N-hour"/"N-week" wording readable, and hand anything unrecognized back
// unchanged rather than inventing a name for it.
const QUOTA_LABEL_KEYS = new Map([
  ["5-hour limit", "usage.fiveHourLimit"],
  ["current window", "usage.currentWindow"],
  ["daily diem allowance", "usage.dailyDiemAllowance"],
  ["diem balance", "usage.diemBalance"],
  ["monthly credits", "usage.monthlyCredits"],
  ["monthly limit", "usage.monthlyLimit"],
  ["rolling limit", "usage.rollingLimit"],
  ["rolling window", "usage.rollingWindow"],
  ["weekly limit", "usage.weeklyLimit"],
]);

export function quotaMetricLabel(label, fallbackKey) {
  const raw = String(label ?? "").trim();
  const key = QUOTA_LABEL_KEYS.get(raw.toLowerCase());
  if (key) return t(key);
  const hours = raw.match(/^(\d+)-hour limit$/i);
  if (hours) return t("usage.hourLimit", { hours: hours[1] });
  const weeks = raw.match(/^(\d+)-week limit$/i);
  if (weeks) return t("usage.weekLimit", { weeks: weeks[1] });
  return fallbackKey ? t(fallbackKey) : raw;
}

// The engine declares its own reasoning levels and the value keeps the level's
// own name on the wire. Only the label is translated, and the raw level rides
// along in parentheses so the displayed name and the stored value cannot drift
// apart. English keeps the bare level the rest of the surface already shows.
const EFFORT_LABEL_KEYS = {
  none: "effort.none",
  minimal: "effort.minimal",
  low: "effort.low",
  medium: "effort.medium",
  high: "effort.high",
  xhigh: "effort.extraHigh",
  max: "effort.maximum",
  ultra: "effort.ultra",
};

export function localizedEffortLabel(effort) {
  const token = String(effort ?? "").trim();
  const key = Object.hasOwn(EFFORT_LABEL_KEYS, token.toLowerCase()) ? EFFORT_LABEL_KEYS[token.toLowerCase()] : undefined;
  if (!key || getLanguage() === "en") return token;
  return `${t(key)} (${token})`;
}

export function quotaWindow(metric = {}) {
  const label = String(metric.label || "").toLowerCase().replace(/[–—]/g, "-");
  const minutes = Number(metric.windowDurationMins);
  if (label.includes("rolling")) {
    return { key: "rolling", label: quotaMetricLabel(metric.label, "usage.rollingLimit") };
  }
  if (
    label.includes("5-hour") ||
    label.includes("5 hour") ||
    label.includes("five-hour") ||
    minutes === 300
  ) {
    return { key: "five-hour", label: quotaMetricLabel(metric.label, "usage.fiveHourLimit") };
  }
  if (label.includes("week") || minutes === 10_080) {
    return { key: "weekly", label: quotaMetricLabel(metric.label, "usage.weeklyLimit") };
  }
  if (label.includes("month") || minutes === 43_200) {
    return { key: "monthly", label: quotaMetricLabel(metric.label, "usage.monthlyLimit") };
  }
  return null;
}

export function metricPercent(metric = {}) {
  const direct = clampPercent(metric.usedPercent);
  if (direct !== null) return direct;
  const used = Number(metric.used);
  const limit = Number(metric.limit);
  return Number.isFinite(used) && Number.isFinite(limit) && limit > 0
    ? clampPercent((used / limit) * 100)
    : null;
}

// Quota data is normalized internally as percentage used, but the tray's
// allowance surfaces should answer the operator's question: how much is left.
// Prefer an explicitly reported remaining value, then derive it from the
// provider's used counters or percentage.
export function metricRemainingPercent(metric = {}) {
  const direct = clampPercent(metric.remainingPercent);
  if (direct !== null) return direct;
  const used = metricPercent(metric);
  return used === null ? null : 100 - used;
}

// OpenAI's account stream is authoritative whenever it contains a date. The
// local OpenAI provider stream is a narrower, router-only meter, so it may fill
// an absent account date but must never replace or augment an account bucket.
export function accountBucketsWithRouterFallback(accountBuckets = [], routerBuckets = []) {
  const merged = new Map();
  for (const bucket of routerBuckets) {
    if (bucket?.startDate == null) continue;
    merged.set(String(bucket.startDate), { ...bucket, displaySource: "router-fallback" });
  }
  for (const bucket of accountBuckets) {
    if (bucket?.startDate == null) continue;
    merged.set(String(bucket.startDate), { ...bucket, displaySource: "account" });
  }
  return [...merged.values()].sort((left, right) => String(left.startDate).localeCompare(String(right.startDate)));
}

export function buildQuotaCards({ account, providerUsage, providerSetup } = {}) {
  const cards = [];
  const seen = new Set();
  const add = (providerId, providerName, metric, source = "account") => {
    if (!metric || metric.kind && metric.kind !== "quota") return;
    const window = quotaWindow(metric);
    if (!window) return;
    const key = `${providerId}:${window.key}`;
    if (seen.has(key)) return;
    seen.add(key);
    cards.push({
      key,
      providerId,
      providerName,
      source,
      window: window.key,
      label: window.label,
      usedPercent: metricPercent(metric),
      remainingPercent: metricRemainingPercent(metric),
      resetAt: Number(metric.resetsAt ?? metric.resetAt) || null,
    });
  };

  if (account?.primary) add("openai", "ChatGPT", account.primary);
  if (account?.secondary) add("openai", "ChatGPT", account.secondary);

  const configured = new Set(
    (providerSetup?.providers || [])
      .filter((provider) => provider.configured)
      .map((provider) => provider.id),
  );
  for (const provider of providerUsage?.providers || []) {
    if (!configured.has(provider.id)) continue;
    for (const metric of provider.account?.metrics || []) {
      add(provider.id, provider.displayName || provider.id, metric, "provider");
    }
  }
  return cards;
}

export function sourceOptions({ account, providerUsage, providerSetup } = {}) {
  const options = [];
  if (account?.dailyUsageBuckets) {
    const localOpenAiBuckets = providerUsage?.providers?.find((provider) => provider.id === "openai")?.dailyUsageBuckets || [];
    const buckets = accountBucketsWithRouterFallback(account.dailyUsageBuckets, localOpenAiBuckets);
    const fallbackDays = buckets.filter((bucket) => bucket.displaySource === "router-fallback").length;
    options.push({
      id: "openai",
      name: fallbackDays > 0 ? t("usage.chatgptWithFallback") : "ChatGPT",
      buckets,
      kind: "account",
      fallbackDays,
    });
  }
  const configured = new Set(
    (providerSetup?.providers || [])
      .filter((provider) => provider.configured)
      .map((provider) => provider.id),
  );
  for (const provider of providerUsage?.providers || []) {
    if (!configured.has(provider.id)) continue;
    options.push({
      id: provider.id,
      name: provider.displayName || provider.id,
      buckets: provider.dailyUsageBuckets || [],
      kind: "provider",
    });
  }
  return options;
}

export function formatReset(unixSeconds, now = new Date()) {
  if (!Number.isFinite(Number(unixSeconds)) || Number(unixSeconds) <= 0) return t("usage.resetUnavailable");
  const date = new Date(Number(unixSeconds) * 1_000);
  const sameDay = localDateKey(date) === localDateKey(now);
  const tomorrow = localDateKey(date) === localDateKey(new Date(now.getTime() + DAY_MS));
  const time = new Intl.DateTimeFormat(getLocale(), {
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
  if (sameDay) return t("usage.resetsToday", { time });
  if (tomorrow) return t("usage.resetsTomorrow", { time });
  return t("usage.resetsAt", { date: new Intl.DateTimeFormat(getLocale(), {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(date) });
}

export function todayTokens(source, today = new Date()) {
  const key = localDateKey(today);
  return Number((source?.buckets || []).find((bucket) => bucket.startDate === key)?.tokens) || 0;
}

export function sevenDayTokens(source, today = new Date()) {
  return dailySeries(source?.buckets || [], 7, today).reduce((total, point) => total + point.tokens, 0);
}

export function visibleLocalDownload(localModels = {}) {
  const download = localModels?.download;
  if (!download) return null;
  // A cancelled pull is a terminal tombstone used by the worker to avoid
  // resurrecting progress after SIGTERM. It is not user-visible work; Cancel
  // should remove the operation card rather than leave a stale result behind.
  if (download.status === "cancelled") return null;
  if (download.status !== "done" || !download.tag) return download;
  const installed = new Set((localModels.models || []).map((model) => model.tag));
  // A completed removal normally disappears once its row is gone. Keep a
  // terminal warning visible when publication failed, though, so “removed”
  // is not silently mistaken for “the catalog is already refreshed.”
  return installed.has(download.tag) || download.catalogError || download.restartError ? download : null;
}

export function observedModelSpeed(providerUsage, providerId, modelSlug) {
  if (!modelSlug) return null;
  const displayName = String(modelSlug).split("/").at(-1);
  const providers = providerUsage?.providers || [];
  const preferred = providers.find((provider) => provider.id === providerId);
  const candidates = preferred ? [preferred, ...providers.filter((provider) => provider !== preferred)] : providers;
  const model = candidates
    .flatMap((provider) => provider.models || [])
    .find((entry) => entry.slug === modelSlug || entry.displayName === displayName);
  if (model?.observedTokensPerSecond === null || model?.observedTokensPerSecond === undefined) {
    return null;
  }
  const speed = Number(model?.observedTokensPerSecond);
  return Number.isFinite(speed) && speed >= 0
    ? { speed, samples: Math.max(0, Number(model.speedSampleCount) || 0) }
    : null;
}

// Router health reports its activity in English tokens. The panel shows the
// label for a state it knows and the raw token for one it does not, so an
// unknown state stays visible instead of being relabelled as something else.
const ACTIVITY_STATE_KEYS = {
  generating: "status.thinking",
  starting: "status.starting",
  offline: "status.offline",
  error: "status.error",
  idle: "status.idle",
};

export function activityStateLabel(state, fallbackKey = "status.idle") {
  const token = String(state ?? "").trim();
  if (!token) return t(fallbackKey);
  const key = Object.hasOwn(ACTIVITY_STATE_KEYS, token) ? ACTIVITY_STATE_KEYS[token] : undefined;
  return key ? t(key) : token;
}

// The dependencies the router reports on, in render order. The Grok OAuth
// forwarder is a fifth local port with its own probe, so it belongs here
// alongside the other two forwarders rather than being reported by nobody.
const SERVICE_ROWS = [
  ["gateway", "health.gateway"],
  ["oauth", "health.oauthForwarder"],
  ["api", "health.apiForwarder"],
  ["grokOauth", "health.grokForwarder"],
];
const FORWARDER_IDS = new Set(["oauth", "api", "grokOauth"]);

// Keep the tray's health language deliberately small. The router endpoint
// already tells us which local dependency is reachable; this helper turns
// that payload into rows the compact status view can scan at a glance.
export function serviceHealthRows(health) {
  const degraded = new Set(
    Array.isArray(health?.degraded) ? health.degraded.map((service) => String(service)) : [],
  );
  const hasHealth = Boolean(health && typeof health === "object");
  const routerKnown = typeof health?.ok === "boolean";
  const rows = [{
    id: "router",
    label: t("health.router"),
    state: !routerKnown ? "unknown" : health.ok ? "ready" : degraded.size ? "degraded" : "offline",
    status: !routerKnown
      ? t("health.stateUnknown")
      : health.ok ? t("health.stateReady") : degraded.size ? t("health.stateDegraded") : t("health.stateOffline"),
    detail: !routerKnown
      ? t("health.detailWaiting")
      : health.ok
        ? t("health.detailServing")
        : degraded.size
          ? t(degraded.size === 1 ? "health.dependencyAttentionOne" : "health.dependencyAttentionMany", {
              count: degraded.size,
            })
          : t("health.detailEndpointUnavailable"),
  }];

  for (const [id, labelKey] of SERVICE_ROWS) {
    const label = t(labelKey);
    const service = health?.[id];
    const shouldShow = id === "gateway" || Boolean(service) || degraded.has(id);
    if (!shouldShow) continue;
    // An absent per-service payload is not the same as no information: a
    // router that reported `ok` has already probed every dependency it knows
    // about, so an id missing from `degraded` is reachable. Rendering it as
    // Unknown made a healthy install look like it had never answered. Kept in
    // step with apps/control-center/src/service-health.ts.
    const inferredReady = !service && health?.ok === true && !degraded.has(id);
    const state = !hasHealth || !service
      ? degraded.has(id) ? "offline" : inferredReady ? "ready" : "unknown"
      : service.enabled === false && !degraded.has(id)
        ? "standby"
        : service.reachable === false || degraded.has(id)
          ? "offline"
          : service.reachable === true ? "ready" : "unknown";
    rows.push({
      id,
      label,
      state,
      status: t({
        ready: "health.stateReady",
        degraded: "health.stateDegraded",
        offline: "health.stateOffline",
        standby: "health.stateStandby",
        unknown: "health.stateUnknown",
      }[state]),
      detail: !hasHealth || !service
        ? degraded.has(id)
          ? t("health.detailUnreachable")
          : inferredReady ? t("health.detailReachable") : t("health.detailWaiting")
        : service.enabled === false && !degraded.has(id)
          ? t("health.detailNotEnabled")
          : service.reachable === false || degraded.has(id)
            ? t("health.detailUnreachable")
            : service.reachable === true ? t("health.detailReachable") : t("health.detailWaiting"),
    });
  }

  const forwarders = rows.filter((row) => FORWARDER_IDS.has(row.id));
  if (!forwarders.length) {
    rows.push({
      id: "forwarders",
      label: t("health.externalForwarders"),
      state: hasHealth ? "standby" : "unknown",
      status: hasHealth ? t("health.stateStandby") : t("health.stateUnknown"),
      detail: hasHealth ? t("health.detailNoForwarders") : t("health.detailWaiting"),
    });
  }
  return rows;
}

// The router's browser panel answers only the reading half of the command
// table, and says so in platform_info. A future surface that advertises no
// restriction still carries the full table, so nothing is refused there.
export function readOnlyCapabilities(platform) {
  const capabilities = platform?.capabilities;
  return capabilities?.readOnly === true ? capabilities : null;
}

// Answered from the lists the surface sent, never from a copy of the allowlist
// kept here: a second copy is the drift this exists to prevent. The commands a
// read-only surface answers from its own process (show/hide, island state) are
// permitted too, because it does answer them.
export function commandRefused(capabilities, command) {
  if (!capabilities || !command) return false;
  const allowed = capabilities.allowedCommands || [];
  const local = capabilities.localCommands || [];
  return !allowed.includes(command) && !local.includes(command);
}

// Absent is not "on". src/tool-result-aging-state.mjs defaults the feature off
// when nobody has answered, so a snapshot the panel could not read has to
// render off rather than promise ageing that is not happening.
export function toolResultAgingChecked(aging) {
  return aging?.enabled === true;
}

function smoothPath(points) {
  if (!points.length) return "";
  if (points.length === 1) return `M ${points[0].x.toFixed(2)} ${points[0].y.toFixed(2)}`;
  let path = `M ${points[0].x.toFixed(2)} ${points[0].y.toFixed(2)}`;
  for (let index = 1; index < points.length; index += 1) {
    const previous = points[index - 1];
    const current = points[index];
    const midpoint = (previous.x + current.x) / 2;
    path += ` C ${midpoint.toFixed(2)} ${previous.y.toFixed(2)}, ${midpoint.toFixed(2)} ${current.y.toFixed(2)}, ${current.x.toFixed(2)} ${current.y.toFixed(2)}`;
  }
  return path;
}

function trimFixed(value, digits) {
  return value.toFixed(digits).replace(/\.0$/, "");
}
