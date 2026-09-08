import type { UsageBucket, UsageMetric } from "./types";

export type AccountBucketSource = "account" | "router-fallback";
export type AccountDisplayBucket = UsageBucket & { displaySource: AccountBucketSource };

export function compactNumber(value: number | null | undefined): string {
  const number = Math.max(0, Number(value) || 0);
  if (number < 1_000) return Math.round(number).toLocaleString("en-US");
  if (number < 1_000_000) return `${trim(number / 1_000, number < 10_000 ? 1 : 0)}k`;
  if (number < 1_000_000_000) return `${trim(number / 1_000_000, number < 10_000_000 ? 1 : 0)}m`;
  return `${trim(number / 1_000_000_000, number < 10_000_000_000 ? 1 : 0)}b`;
}

export function exactNumber(value: number | null | undefined): string {
  return Math.max(0, Math.round(Number(value) || 0)).toLocaleString("en-US");
}

export function formatContext(value: number | null | undefined): string {
  if (!Number.isFinite(Number(value)) || Number(value) <= 0) return "Managed";
  return `${compactNumber(Number(value))} tokens`;
}

export function formatBytesGb(value: number | null | undefined): string {
  if (!Number.isFinite(Number(value))) return "Size unknown";
  return `${Number(value).toFixed(Number(value) < 10 ? 1 : 0)} GB`;
}

export function formatDateTime(value: number | string | null | undefined): string {
  if (value === null || value === undefined || value === "") return "Not reported";
  const numeric = Number(value);
  const date = Number.isFinite(numeric)
    ? new Date(numeric < 10_000_000_000 ? numeric * 1_000 : numeric)
    : new Date(value);
  if (Number.isNaN(date.getTime())) return "Not reported";
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

export function formatDuration(milliseconds: number | null | undefined): string {
  const value = Math.max(0, Number(milliseconds) || 0);
  if (value < 1_000) return `${Math.round(value)} ms`;
  if (value < 60_000) return `${(value / 1_000).toFixed(value < 10_000 ? 1 : 0)} sec`;
  return `${Math.floor(value / 60_000)}m ${Math.round((value % 60_000) / 1_000)}s`;
}

export function metricValue(metric: UsageMetric): string {
  if (metric.kind === "balance" && Number.isFinite(Number(metric.value))) {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: metric.currency || "USD",
      maximumFractionDigits: 2,
    }).format(Number(metric.value));
  }
  if (Number.isFinite(Number(metric.remainingPercent))) return `${Math.round(Number(metric.remainingPercent))}% left`;
  if (Number.isFinite(Number(metric.usedPercent))) return `${Math.round(100 - Number(metric.usedPercent))}% left`;
  if (Number.isFinite(Number(metric.remaining))) return `${compactNumber(Number(metric.remaining))} left`;
  return "Reported";
}

export function remainingPercent(metric: UsageMetric): number | null {
  if (Number.isFinite(Number(metric.remainingPercent))) {
    return Math.max(0, Math.min(100, Number(metric.remainingPercent)));
  }
  if (Number.isFinite(Number(metric.usedPercent))) {
    return Math.max(0, Math.min(100, 100 - Number(metric.usedPercent)));
  }
  if (Number.isFinite(Number(metric.remaining)) && Number.isFinite(Number(metric.limit)) && Number(metric.limit) > 0) {
    return Math.max(0, Math.min(100, (Number(metric.remaining) / Number(metric.limit)) * 100));
  }
  return null;
}

// The window has to be walked in UTC days, because that is the day space every
// bucket key is written in -- the router keys its own buckets that way and
// OpenAI's account stream reports them that way. Walking local days asked for
// "the local day of the same name", which east of UTC is a different window
// than the bucket measured, and left the newest slot with no bucket to match
// until the offset had elapsed: an account mid-session read as zero all morning.
export function bucketRange(buckets: UsageBucket[] = [], days: number): UsageBucket[] {
  const index = new Map(buckets.map((bucket) => [bucket.startDate, bucket]));
  const anchor = new Date();
  anchor.setUTCHours(12, 0, 0, 0);
  return Array.from({ length: days }, (_, offset) => {
    const date = new Date(anchor);
    date.setUTCDate(anchor.getUTCDate() - (days - offset - 1));
    const key = date.toISOString().slice(0, 10);
    const existing = index.get(key);
    return existing
      ? { ...existing, startDate: key, tokens: Number(existing.tokens) || 0 }
      : { startDate: key, tokens: 0 };
  });
}

// OpenAI's account stream is authoritative whenever it contains a date. The
// local OpenAI provider stream is a narrower, router-only meter, so it may fill
// an absent account date but must never replace or augment an account bucket.
export function accountBucketsWithRouterFallback(
  accountBuckets: UsageBucket[] = [],
  routerBuckets: UsageBucket[] = [],
): AccountDisplayBucket[] {
  const merged = new Map<string, AccountDisplayBucket>();
  for (const bucket of routerBuckets) {
    merged.set(bucket.startDate, { ...bucket, displaySource: "router-fallback" });
  }
  for (const bucket of accountBuckets) {
    merged.set(bucket.startDate, { ...bucket, displaySource: "account" });
  }
  return [...merged.values()].sort((left, right) => left.startDate.localeCompare(right.startDate));
}

export function classNames(...values: Array<string | false | null | undefined>): string {
  return values.filter(Boolean).join(" ");
}

function trim(value: number, digits: number): string {
  return value.toFixed(digits).replace(/\.0$/, "");
}
