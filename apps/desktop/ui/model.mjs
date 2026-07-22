const DAY_MS = 24 * 60 * 60 * 1_000;

export function clampPercent(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  return Math.min(100, Math.max(0, number));
}

export function compactTokens(value) {
  const tokens = Math.max(0, Number(value) || 0);
  if (tokens < 1_000) return Math.round(tokens).toLocaleString("en-US");
  if (tokens < 1_000_000) return `${trimFixed(tokens / 1_000, tokens < 10_000 ? 1 : 0)}k`;
  return `${trimFixed(tokens / 1_000_000, tokens < 10_000_000 ? 1 : 0)}m`;
}

export function exactTokens(value) {
  return Math.max(0, Math.round(Number(value) || 0)).toLocaleString("en-US");
}

export function localDateKey(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function dailySeries(buckets = [], days = 7, today = new Date()) {
  const indexed = new Map(
    buckets.map((bucket) => [String(bucket.startDate), Number(bucket.tokens) || 0]),
  );
  const anchor = new Date(today.getFullYear(), today.getMonth(), today.getDate(), 12);
  return Array.from({ length: days }, (_, index) => {
    const date = new Date(anchor.getTime() - (days - index - 1) * DAY_MS);
    const key = localDateKey(date);
    return {
      key,
      label: new Intl.DateTimeFormat("en-US", { weekday: "short" }).format(date),
      longLabel: new Intl.DateTimeFormat("en-US", {
        month: "short",
        day: "numeric",
      }).format(date),
      tokens: indexed.get(key) ?? 0,
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

export function quotaWindow(metric = {}) {
  const label = String(metric.label || "").toLowerCase().replace(/[–—]/g, "-");
  const minutes = Number(metric.windowDurationMins);
  if (
    label.includes("5-hour") ||
    label.includes("5 hour") ||
    label.includes("five-hour") ||
    minutes === 300
  ) {
    return { key: "five-hour", label: "5-hour limit" };
  }
  if (label.includes("week") || minutes === 10_080) {
    return { key: "weekly", label: "Weekly limit" };
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
    options.push({
      id: "openai",
      name: "ChatGPT",
      buckets: account.dailyUsageBuckets,
      kind: "account",
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
  if (!Number.isFinite(Number(unixSeconds)) || Number(unixSeconds) <= 0) return "Reset time unavailable";
  const date = new Date(Number(unixSeconds) * 1_000);
  const sameDay = localDateKey(date) === localDateKey(now);
  const tomorrow = localDateKey(date) === localDateKey(new Date(now.getTime() + DAY_MS));
  const time = new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
  if (sameDay) return `Resets today at ${time}`;
  if (tomorrow) return `Resets tomorrow at ${time}`;
  return `Resets ${new Intl.DateTimeFormat("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(date)}`;
}

export function todayTokens(source, today = new Date()) {
  const key = localDateKey(today);
  return Number((source?.buckets || []).find((bucket) => bucket.startDate === key)?.tokens) || 0;
}

export function sevenDayTokens(source, today = new Date()) {
  return dailySeries(source?.buckets || [], 7, today).reduce((total, point) => total + point.tokens, 0);
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
