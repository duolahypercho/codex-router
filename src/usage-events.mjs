import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { STATE_DIR } from "./paths.mjs";
import { canonicalProviderId } from "./provider-selection.mjs";

export const USAGE_EVENTS_PATH = path.join(STATE_DIR, "usage-events.jsonl");

function safeText(value, fallback) {
  const text = typeof value === "string" ? value.trim() : "";
  return (text || fallback).slice(0, 160);
}

function safeTokenCount(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.round(number) : undefined;
}

// Retries are recorded only when there were any, so an ordinary event keeps the
// exact shape it always had. A transparently absorbed upstream failure records
// a 200 like any other turn, and this field is the only thing that says the
// upstream is flaky rather than healthy.
function safeRetryCount(value) {
  const count = safeTokenCount(value);
  return count ? count : undefined;
}

export function recordUsageEvent({
  model,
  provider,
  status,
  durationMs,
  inputTokens,
  outputTokens,
  totalTokens,
  retries,
  // Present only when the router replaced an upstream `input_tokens: 0` with
  // its own estimate on the way to Codex (#95). The reported counts above stay
  // exactly as the provider sent them, so an estimated turn is never mistaken
  // for the provider having recovered -- and a run of these events is the
  // signal that it has not.
  estimatedInputTokens,
  at = Date.now(),
}) {
  const event = {
    meteringVersion: 1,
    at: new Date(at).toISOString(),
    model: safeText(model, "unknown"),
    provider: safeText(provider, "unknown"),
    status: Number.isInteger(status) ? status : 0,
    durationMs: Number.isFinite(durationMs) ? Math.max(0, Math.round(durationMs)) : 0,
    ...(safeRetryCount(retries) !== undefined ? { retries: safeRetryCount(retries) } : {}),
    ...(safeTokenCount(inputTokens) !== undefined
      ? { inputTokens: safeTokenCount(inputTokens) }
      : {}),
    ...(safeTokenCount(outputTokens) !== undefined
      ? { outputTokens: safeTokenCount(outputTokens) }
      : {}),
    ...(safeTokenCount(totalTokens) !== undefined
      ? { totalTokens: safeTokenCount(totalTokens) }
      : {}),
    ...(safeTokenCount(estimatedInputTokens) !== undefined
      ? { estimatedInputTokens: safeTokenCount(estimatedInputTokens) }
      : {}),
  };
  try {
    mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
    appendFileSync(USAGE_EVENTS_PATH, `${JSON.stringify(event)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    chmodSync(USAGE_EVENTS_PATH, 0o600);
  } catch {
    // Usage telemetry must never interrupt or fail a model request.
  }
}

export function recentUsageEvents({ sinceMs = 24 * 60 * 60 * 1000, limit = 1_000 } = {}) {
  if (!existsSync(USAGE_EVENTS_PATH)) return [];
  const cutoff = Date.now() - sinceMs;
  try {
    return readFileSync(USAGE_EVENTS_PATH, "utf8")
      .split("\n")
      .filter(Boolean)
      .slice(-Math.max(1, limit))
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return undefined;
        }
      })
      .filter(
        (event) =>
          event &&
          typeof event.at === "string" &&
          Date.parse(event.at) >= cutoff &&
          typeof event.model === "string" &&
          typeof event.provider === "string",
      )
      .map((event) => {
        const inputTokens = safeTokenCount(event.inputTokens);
        const outputTokens = safeTokenCount(event.outputTokens);
        const totalTokens = safeTokenCount(event.totalTokens);
        const retries = safeRetryCount(event.retries);
        const estimatedInputTokens = safeTokenCount(event.estimatedInputTokens);
        return {
          ...(event.meteringVersion === 1 ? { meteringVersion: 1 } : {}),
          at: event.at,
          model: safeText(event.model, "unknown"),
          // Historical events may carry a protocol-variant provider id; fold
          // the whole family into its canonical provider so usage stays one
          // series per subscription.
          provider: canonicalProviderId(safeText(event.provider, "unknown")),
          status: Number.isInteger(event.status) ? event.status : 0,
          durationMs: Number.isFinite(event.durationMs)
            ? Math.max(0, Math.round(event.durationMs))
            : 0,
          ...(retries !== undefined ? { retries } : {}),
          ...(inputTokens !== undefined ? { inputTokens } : {}),
          ...(outputTokens !== undefined ? { outputTokens } : {}),
          ...(totalTokens !== undefined ? { totalTokens } : {}),
          ...(estimatedInputTokens !== undefined ? { estimatedInputTokens } : {}),
        };
      });
  } catch {
    return [];
  }
}
