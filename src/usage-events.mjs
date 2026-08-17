import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
} from "node:fs";
import path from "node:path";

import { STATE_DIR } from "./paths.mjs";
import { canonicalProviderId } from "./provider-selection.mjs";
import { acceptedInputTokens } from "./context-window-drift.mjs";

export const USAGE_EVENTS_PATH = path.join(STATE_DIR, "usage-events.jsonl");

// A single status probe asks for both the recent events and the aging totals,
// and this file only grows -- nothing rotates it. Reading it twice per probe
// costs two linear scans that get slower for the life of the install, and the
// desktop app polls every 60s. Cache the split once, keyed on size and mtime so
// any append invalidates it.
let lineCache = { key: undefined, lines: [] };

function usageEventLines() {
  if (!existsSync(USAGE_EVENTS_PATH)) {
    lineCache = { key: undefined, lines: [] };
    return lineCache.lines;
  }
  let key;
  try {
    const stats = statSync(USAGE_EVENTS_PATH);
    key = `${stats.size}:${stats.mtimeMs}`;
  } catch {
    key = undefined;
  }
  if (key !== undefined && key === lineCache.key) return lineCache.lines;
  let lines;
  try {
    lines = readFileSync(USAGE_EVENTS_PATH, "utf8").split("\n");
  } catch {
    lines = [];
  }
  lineCache = { key, lines };
  return lines;
}

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
  // Milliseconds from receiving the request until the upstream response
  // headers arrived. Together with durationMs this isolates the streamed
  // generation phase from prompt processing, queueing, and router setup.
  // Historical rows omit it and must not be used for generation-rate math.
  responseStartMs,
  // Milliseconds from receiving the request until the first generated token
  // reached the client. This -- not responseStartMs -- is the split an
  // output-tokens-per-second figure divides by, matching how the industry
  // reports it: tokens after the first token, with the wait before it counted
  // separately as time-to-first-token.
  firstTokenMs,
  inputTokens,
  cachedInputTokens,
  outputTokens,
  totalTokens,
  retries,
  // True when the upstream stream died after its 200 head was already
  // committed, so `status` had to be rewritten (e.g. 502) and this marker is
  // the only thing that says the turn was truncated rather than successful.
  // Absent on ordinary events so old rows keep their exact shape.
  streamAborted,
  // True when the upstream answered 200 with `response.completed` but never
  // produced output text or a tool call, and the router suppressed the empty
  // completion instead of letting the client record a silent success.
  emptyCompletion,
  // True when the empty completion above was retried once against the same
  // request body. `status` describes the retry's own outcome; the token counts
  // cover both attempts, because both were sent and both were billed. This
  // marker is what says the reported spend belongs to two attempts at one turn.
  emptyCompletionRetried,
  // True when the Grok OAuth forwarder retried a progress-only stop and summed
  // both attempts into this event. Distinct from transport `retries`, which do
  // not double the token counts.
  progressOnlyRetried,
  // True when the turn was empty and the router could not repair it, because
  // the attempt had already been relayed: the upstream proved it was generating
  // before it produced nothing, so the hold was over and a retry would have
  // grafted a second response onto a stream the client was already reading.
  // Kept apart from `emptyCompletionRetried` because this failure reaches the
  // user and that one does not.
  emptyCompletionUnrepairable,
  // True when the guard released the stream at its byte/time hold budget
  // without a verdict, so this turn may have been an empty completion the
  // router chose not to retry. Kept apart from `emptyCompletion` because the
  // release is the conservative path: the turn is relayed as-is and cannot be
  // proven empty, but it must not read as a guaranteed-healthy turn either.
  emptyCompletionGuardReleased,
  // Present only when the router replaced an upstream `input_tokens: 0` with
  // its own estimate on the way to Codex (#95). The reported counts above stay
  // exactly as the provider sent them, so an estimated turn is never mistaken
  // for the provider having recovered -- and a run of these events is the
  // signal that it has not.
  estimatedInputTokens,
  // Present only when the routed request compacted old, already-consumed tool
  // results. Counts and bytes describe the request sent upstream, never the
  // result contents themselves.
  toolResultsAged,
  toolResultBytesBefore,
  toolResultBytesAfter,
  toolResultBytesSaved,
  // Present whenever the aging pass ran, even when it changed nothing. Every
  // count above is omitted when zero, so without these an operator who enables
  // aging and sees an empty ledger cannot tell whether the pass never ran or
  // ran and found every result under the floor. `BytesLargest` separates the
  // two: compare it against the eligibility floor.
  toolResultsEvaluated,
  toolResultBytesLargest,
  // Present only on a turn the router moved to another model because the one
  // the operator asked for reported it had no usage left. `model` and
  // `provider` above name what actually served the turn; this names what was
  // asked for. Without it a rescued turn is indistinguishable from an operator
  // who simply changed models, which is the difference between "your provider
  // is empty" and "you switched".
  failoverFrom,
  at = Date.now(),
}) {
  const event = {
    meteringVersion: 1,
    at: new Date(at).toISOString(),
    model: safeText(model, "unknown"),
    provider: safeText(provider, "unknown"),
    status: Number.isInteger(status) ? status : 0,
    durationMs: Number.isFinite(durationMs) ? Math.max(0, Math.round(durationMs)) : 0,
    ...(safeTokenCount(responseStartMs) !== undefined
      ? { responseStartMs: safeTokenCount(responseStartMs) }
      : {}),
    ...(safeTokenCount(firstTokenMs) !== undefined
      ? { firstTokenMs: safeTokenCount(firstTokenMs) }
      : {}),
    ...(streamAborted === true ? { streamAborted: true } : {}),
    ...(emptyCompletion === true ? { emptyCompletion: true } : {}),
    ...(emptyCompletionRetried === true ? { emptyCompletionRetried: true } : {}),
    ...(progressOnlyRetried === true ? { progressOnlyRetried: true } : {}),
    ...(emptyCompletionUnrepairable === true
      ? { emptyCompletionUnrepairable: true }
      : {}),
    ...(emptyCompletionGuardReleased === true
      ? { emptyCompletionGuardReleased: true }
      : {}),
    ...(safeRetryCount(retries) !== undefined ? { retries: safeRetryCount(retries) } : {}),
    ...(typeof failoverFrom === "string" && failoverFrom.trim()
      ? { failoverFrom: safeText(failoverFrom, "unknown") }
      : {}),
    ...(safeTokenCount(inputTokens) !== undefined
      ? { inputTokens: safeTokenCount(inputTokens) }
      : {}),
    ...(safeTokenCount(cachedInputTokens) !== undefined
      ? { cachedInputTokens: safeTokenCount(cachedInputTokens) }
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
    ...(safeTokenCount(toolResultsAged) ? { toolResultsAged: safeTokenCount(toolResultsAged) } : {}),
    ...(safeTokenCount(toolResultBytesBefore)
      ? { toolResultBytesBefore: safeTokenCount(toolResultBytesBefore) }
      : {}),
    ...(safeTokenCount(toolResultBytesAfter)
      ? { toolResultBytesAfter: safeTokenCount(toolResultBytesAfter) }
      : {}),
    ...(safeTokenCount(toolResultBytesSaved)
      ? { toolResultBytesSaved: safeTokenCount(toolResultBytesSaved) }
      : {}),
    // Zero is meaningful here -- it says the pass ran and saw no tool results
    // at all -- so these are written whenever defined rather than when truthy.
    ...(safeTokenCount(toolResultsEvaluated) !== undefined
      ? { toolResultsEvaluated: safeTokenCount(toolResultsEvaluated) }
      : {}),
    ...(safeTokenCount(toolResultBytesLargest) !== undefined
      ? { toolResultBytesLargest: safeTokenCount(toolResultBytesLargest) }
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

// Tool-result aging writes its per-request savings into the shared usage
// events, so the running total is derived here rather than kept as a second
// counter that could drift. Bytes are what the router actually measured;
// the token figure is the usual ~4 bytes/token estimate and is labelled as
// such everywhere it surfaces.
const BYTES_PER_TOKEN_ESTIMATE = 4;

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
// The tray's range tabs. Buckets are fixed-length and end at the current
// hour/day so a quiet stretch reads as a gap instead of reflowing the chart.
const AGING_RANGES = [
  { key: "24h", bucketMs: HOUR_MS, buckets: 24 },
  { key: "7d", bucketMs: DAY_MS, buckets: 7 },
  { key: "30d", bucketMs: DAY_MS, buckets: 30 },
];

function emptyRange(buckets) {
  return {
    savedTokens: 0,
    requests: 0,
    buckets: new Array(buckets).fill(0),
    // Measured prompt-cache rates in this window, split by whether the
    // request carried compacted results. Only providers that report
    // cachedInputTokens contribute (native GPT does; most routed do not), so
    // either rate can be null when nothing measurable happened.
    cache: { agedRate: null, unagedRate: null, agedTurns: 0, unagedTurns: 0 },
  };
}

export function toolResultAgingTotals({ now = Date.now() } = {}) {
  const totals = {
    requests: 0,
    // Requests where the pass ran, whether or not it changed anything, plus the
    // largest single result any of them saw. `evaluatedRequests` above zero
    // with `requests` at zero is the signature of a workload whose results all
    // sit under the eligibility floor: proof the pass is wired in, and the
    // number that says by how much it missed.
    evaluatedRequests: 0,
    largestResultBytes: 0,
    resultsAged: 0,
    bytesSaved: 0,
    estimatedTokensSaved: 0,
    firstAt: undefined,
    lastAt: undefined,
    ranges: Object.fromEntries(
      AGING_RANGES.map((range) => [range.key, emptyRange(range.buckets)]),
    ),
  };
  if (!existsSync(USAGE_EVENTS_PATH)) return totals;
  const floors = AGING_RANGES.map((range) => now - (now % range.bucketMs));
  const cacheSums = AGING_RANGES.map(() => ({ aged: [0, 0], unaged: [0, 0] }));
  try {
    for (const line of usageEventLines()) {
      // Pre-filter: aging stats and cache telemetry are both rare fields.
      const hasAging =
        line.includes('"toolResultsAged"') || line.includes('"toolResultsEvaluated"');
      const hasCache = line.includes('"cachedInputTokens"');
      if (!hasAging && !hasCache) continue;
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        continue;
      }
      const at = typeof event?.at === "string" ? Date.parse(event.at) : NaN;
      const evaluated = safeTokenCount(event?.toolResultsEvaluated);
      if (evaluated !== undefined) {
        totals.evaluatedRequests += 1;
        const largest = safeTokenCount(event?.toolResultBytesLargest) ?? 0;
        if (largest > totals.largestResultBytes) totals.largestResultBytes = largest;
      }
      const resultsAged = safeTokenCount(event?.toolResultsAged);
      if (resultsAged) {
        totals.requests += 1;
        totals.resultsAged += resultsAged;
        const bytesSaved = safeTokenCount(event.toolResultBytesSaved) ?? 0;
        totals.bytesSaved += bytesSaved;
        if (typeof event.at === "string") {
          totals.firstAt = totals.firstAt ?? event.at;
          totals.lastAt = event.at;
        }
        if (Number.isFinite(at)) {
          const savedTokens = Math.round(bytesSaved / BYTES_PER_TOKEN_ESTIMATE);
          AGING_RANGES.forEach((range, index) => {
            const bucket =
              range.buckets - 1 - Math.floor((floors[index] - (at - (at % range.bucketMs))) / range.bucketMs);
            if (bucket >= 0 && bucket < range.buckets) {
              const slot = totals.ranges[range.key];
              slot.buckets[bucket] += savedTokens;
              slot.savedTokens += savedTokens;
              slot.requests += 1;
            }
          });
        }
      }
      const inputTokens = safeTokenCount(event?.inputTokens);
      const cachedInputTokens = safeTokenCount(event?.cachedInputTokens);
      if (hasCache && inputTokens && cachedInputTokens !== undefined && Number.isFinite(at)) {
        AGING_RANGES.forEach((range, index) => {
          if (at < now - range.bucketMs * range.buckets) return;
          const side = cacheSums[index][resultsAged ? "aged" : "unaged"];
          side[0] += inputTokens;
          side[1] += Math.min(cachedInputTokens, inputTokens);
          totals.ranges[range.key].cache[resultsAged ? "agedTurns" : "unagedTurns"] += 1;
        });
      }
    }
  } catch {
    // Telemetry must never break a status surface; report what was readable.
  }
  totals.estimatedTokensSaved = Math.round(totals.bytesSaved / BYTES_PER_TOKEN_ESTIMATE);
  const rate = ([input, cached]) =>
    input ? Math.round((cached / input) * 1_000) / 1_000 : null;
  AGING_RANGES.forEach((range, index) => {
    totals.ranges[range.key].cache.agedRate = rate(cacheSums[index].aged);
    totals.ranges[range.key].cache.unagedRate = rate(cacheSums[index].unaged);
  });
  return totals;
}

export function recentUsageEvents({ sinceMs = 24 * 60 * 60 * 1000, limit = 1_000 } = {}) {
  if (!existsSync(USAGE_EVENTS_PATH)) return [];
  const cutoff = Date.now() - sinceMs;
  try {
    return usageEventLines()
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
        const cachedInputTokens = safeTokenCount(event.cachedInputTokens);
        const outputTokens = safeTokenCount(event.outputTokens);
        const totalTokens = safeTokenCount(event.totalTokens);
        const retries = safeRetryCount(event.retries);
        const estimatedInputTokens = safeTokenCount(event.estimatedInputTokens);
        const toolResultsAged = safeTokenCount(event.toolResultsAged);
        const toolResultBytesBefore = safeTokenCount(event.toolResultBytesBefore);
        const toolResultBytesAfter = safeTokenCount(event.toolResultBytesAfter);
        const toolResultBytesSaved = safeTokenCount(event.toolResultBytesSaved);
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
          ...(safeTokenCount(event.responseStartMs) !== undefined
            ? { responseStartMs: safeTokenCount(event.responseStartMs) }
            : {}),
          ...(safeTokenCount(event.firstTokenMs) !== undefined
            ? { firstTokenMs: safeTokenCount(event.firstTokenMs) }
            : {}),
          ...(event.streamAborted === true ? { streamAborted: true } : {}),
          ...(event.emptyCompletion === true ? { emptyCompletion: true } : {}),
          ...(event.emptyCompletionUnrepairable === true
            ? { emptyCompletionUnrepairable: true }
            : {}),
          ...(event.emptyCompletionRetried === true
            ? { emptyCompletionRetried: true }
            : {}),
          ...(event.progressOnlyRetried === true ? { progressOnlyRetried: true } : {}),
          ...(event.emptyCompletionGuardReleased === true
            ? { emptyCompletionGuardReleased: true }
            : {}),
          ...(retries !== undefined ? { retries } : {}),
          ...(inputTokens !== undefined ? { inputTokens } : {}),
          ...(cachedInputTokens !== undefined ? { cachedInputTokens } : {}),
          ...(outputTokens !== undefined ? { outputTokens } : {}),
          ...(totalTokens !== undefined ? { totalTokens } : {}),
          ...(estimatedInputTokens !== undefined ? { estimatedInputTokens } : {}),
          ...(toolResultsAged ? { toolResultsAged } : {}),
          ...(toolResultBytesBefore ? { toolResultBytesBefore } : {}),
          ...(toolResultBytesAfter ? { toolResultBytesAfter } : {}),
          ...(toolResultBytesSaved ? { toolResultBytesSaved } : {}),
        };
      });
  } catch {
    return [];
  }
}

// Highest prompt each model has been observed to have accepted, scanned across
// the whole ledger rather than a recent window: the turn that disproves a
// declared context window may be months old and must not age out of the
// evidence. Streamed line by line with a cheap pre-filter, because the ledger
// only grows and parsing every row to find a maximum is wasteful.
export function observedInputCeilings() {
  const highest = new Map();
  if (!existsSync(USAGE_EVENTS_PATH)) return highest;
  try {
    for (const line of usageEventLines()) {
      if (!line.includes('"inputTokens"')) continue;
      // A substituted estimate cannot disprove a provider's own limit.
      if (line.includes('"estimatedInputTokens"')) continue;
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        continue;
      }
      const accepted = acceptedInputTokens(event);
      if (accepted === undefined) continue;
      if (accepted > (highest.get(event.model) ?? 0)) highest.set(event.model, accepted);
    }
  } catch {
    // Telemetry must never break a status surface; report what was readable.
  }
  return highest;
}
