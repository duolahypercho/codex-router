import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { STATE_DIR } from "./paths.mjs";

export const USAGE_EVENTS_PATH = path.join(STATE_DIR, "usage-events.jsonl");

function safeText(value, fallback) {
  const text = typeof value === "string" ? value.trim() : "";
  return (text || fallback).slice(0, 160);
}

export function recordUsageEvent({ model, provider, status, durationMs, at = Date.now() }) {
  const event = {
    at: new Date(at).toISOString(),
    model: safeText(model, "unknown"),
    provider: safeText(provider, "unknown"),
    status: Number.isInteger(status) ? status : 0,
    durationMs: Number.isFinite(durationMs) ? Math.max(0, Math.round(durationMs)) : 0,
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
      .map((event) => ({
        at: event.at,
        model: safeText(event.model, "unknown"),
        provider: safeText(event.provider, "unknown"),
        status: Number.isInteger(event.status) ? event.status : 0,
        durationMs: Number.isFinite(event.durationMs) ? Math.max(0, Math.round(event.durationMs)) : 0,
      }));
  } catch {
    return [];
  }
}
