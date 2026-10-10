import type { MessageKey, Translate } from "./i18n.ts";
import type { GenerationOutcome, GenerationOutcomeStats, UsageEvent } from "./types";

const OUTCOMES: GenerationOutcome[] = ["completed", "failed", "incomplete", "canceled", "indeterminate"];
const LABELS: Record<GenerationOutcome, MessageKey> = {
  completed: "generation.completed",
  failed: "generation.failed",
  incomplete: "generation.incomplete",
  canceled: "generation.canceled",
  indeterminate: "generation.indeterminate",
};
type OutcomeTone = "success" | "danger" | "warning" | "neutral";
const TONES: Record<GenerationOutcome, OutcomeTone> = {
  completed: "success", failed: "danger", incomplete: "warning", canceled: "neutral", indeterminate: "warning",
};

export function knownGenerationOutcome(value: unknown): GenerationOutcome | undefined {
  return OUTCOMES.includes(value as GenerationOutcome) ? value as GenerationOutcome : undefined;
}

export function eventHttpStatus(event: UsageEvent): number | undefined {
  const status = event.httpStatus ?? event.status;
  return Number.isInteger(status) && status! >= 100 && status! <= 599 ? status : undefined;
}

export function eventGenerationPresentation(event: UsageEvent, t: Translate) {
  const outcome = knownGenerationOutcome(event.generationOutcome);
  const status = eventHttpStatus(event);
  const label = t(outcome ? LABELS[outcome] : "generation.notRecorded");
  const httpLabel = status === undefined ? t("generation.httpNotRecorded") : t("generation.httpStatus", { status });
  // A historical HTTP 200 proves delivery, never successful generation.
  const tone: OutcomeTone = status !== undefined && status >= 400
    ? "danger" : outcome ? TONES[outcome] : "neutral";
  return { outcome, label, httpLabel, tone, detail: t("generation.eventDetail", { http: httpLabel, outcome: label }) };
}

export function eventGenerationCompleted(event: UsageEvent): boolean {
  const status = eventHttpStatus(event);
  return event.generationOutcome === "completed" && status !== undefined && status >= 200 && status < 400;
}

export function recordGenerationOutcome(stats: GenerationOutcomeStats, event: UsageEvent): void {
  const outcome = knownGenerationOutcome(event.generationOutcome);
  if (outcome) {
    stats.outcomeCounts ??= {};
    stats.outcomeCounts[outcome] = (stats.outcomeCounts[outcome] ?? 0) + 1;
  } else stats.legacyOutcomeRequests = (stats.legacyOutcomeRequests ?? 0) + 1;
}

export function generationOutcomesSummary(stats: GenerationOutcomeStats, t: Translate): string | undefined {
  const parts: string[] = [];
  let recorded = 0;
  for (const outcome of OUTCOMES) {
    const count = countValue(stats.outcomeCounts?.[outcome]);
    recorded += count;
    if (count) parts.push(t("generation.count", { count, outcome: t(LABELS[outcome]) }));
  }
  // Old snapshots omit both fields. Do not relabel their successfulRequests
  // compatibility counter as completed generations.
  const legacy = Math.max(countValue(stats.legacyOutcomeRequests), countValue(stats.requests) - recorded);
  if (legacy) parts.push(t("generation.count", { count: legacy, outcome: t("generation.notRecorded") }));
  return parts.length ? parts.join(" · ") : undefined;
}

function countValue(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;
}
