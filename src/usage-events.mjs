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
  billedInputTokens,
  cachedInputTokens,
  outputTokens,
  billedOutputTokens,
  reasoningTokens,
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
  // True when the guard retried once against the same request body, either
  // after a proven empty completion or after a pre-content safety limit.
  // `status` describes the retry's own outcome; the token counts cover both
  // attempts, because both were sent and both were billed. This marker is what
  // says the reported spend belongs to two attempts at one turn.
  emptyCompletionRetried,
  // True when the Grok OAuth forwarder retried a progress-only stop. New rows
  // keep the selected attempt in the ordinary token fields and the aggregate
  // provider spend in billedInputTokens / billedOutputTokens. Historical rows
  // summed both attempts into the ordinary fields.
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
  // The byte or time safety limit ended the pre-content hold while no output
  // had reached the client. Current routers retry that attempt once and fail
  // explicitly if the retry also reaches the limit; historical routers used
  // `emptyCompletionGuardReleased` for the old fail-open behavior above.
  emptyCompletionPreludeLimit,
  // Present only when the router replaced an upstream `input_tokens: 0` with
  // its own estimate on the way to Codex (#95). The reported counts above stay
  // exactly as the provider sent them, so an estimated turn is never mistaken
  // for the provider having recovered -- and a run of these events is the
  // signal that it has not.
  estimatedInputTokens,
  // True when the router canceled a request at its separately configured
  // execution deadline. Activity-record retention never sets this field.
  requestDeadlineExceeded,
  // Present only when the routed request compacted old results or pressure-
  // shaped noisy results. Counts and bytes describe the request sent upstream,
  // never the result contents themselves.
  toolResultsAged,
  toolResultsShaped,
  toolResultBytesBefore,
  toolResultBytesAfter,
  toolResultBytesSaved,
  toolResultShapeBytesSaved,
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
  // Codex standalone search normally spends the caller's native ChatGPT
  // session. These fields distinguish an explicitly configured external
  // sidecar request and whether it was served from its account-scoped cache.
  searchSidecar,
  searchCacheHit,
  searchResults,
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
    ...(requestDeadlineExceeded === true ? { requestDeadlineExceeded: true } : {}),
    ...(emptyCompletionPreludeLimit === "bytes" ||
    emptyCompletionPreludeLimit === "time"
      ? { emptyCompletionPreludeLimit }
      : {}),
    ...(safeRetryCount(retries) !== undefined ? { retries: safeRetryCount(retries) } : {}),
    ...(typeof failoverFrom === "string" && failoverFrom.trim()
      ? { failoverFrom: safeText(failoverFrom, "unknown") }
      : {}),
    ...(searchSidecar === true ? { searchSidecar: true } : {}),
    ...(searchSidecar === true && typeof searchCacheHit === "boolean"
      ? { searchCacheHit }
      : {}),
    ...(searchSidecar === true && safeTokenCount(searchResults) !== undefined
      ? { searchResults: safeTokenCount(searchResults) }
      : {}),
    ...(safeTokenCount(inputTokens) !== undefined
      ? { inputTokens: safeTokenCount(inputTokens) }
      : {}),
    ...(safeTokenCount(billedInputTokens) !== undefined
      ? { billedInputTokens: safeTokenCount(billedInputTokens) }
      : {}),
    ...(safeTokenCount(cachedInputTokens) !== undefined
      ? { cachedInputTokens: safeTokenCount(cachedInputTokens) }
      : {}),
    ...(safeTokenCount(outputTokens) !== undefined
      ? { outputTokens: safeTokenCount(outputTokens) }
      : {}),
    ...(safeTokenCount(billedOutputTokens) !== undefined
      ? { billedOutputTokens: safeTokenCount(billedOutputTokens) }
      : {}),
    ...(safeTokenCount(reasoningTokens) !== undefined
      ? { reasoningTokens: safeTokenCount(reasoningTokens) }
      : {}),
    ...(safeTokenCount(totalTokens) !== undefined
      ? { totalTokens: safeTokenCount(totalTokens) }
      : {}),
    ...(safeTokenCount(estimatedInputTokens) !== undefined
      ? { estimatedInputTokens: safeTokenCount(estimatedInputTokens) }
      : {}),
    ...(safeTokenCount(toolResultsAged) ? { toolResultsAged: safeTokenCount(toolResultsAged) } : {}),
    ...(safeTokenCount(toolResultsShaped)
      ? { toolResultsShaped: safeTokenCount(toolResultsShaped) }
      : {}),
    ...(safeTokenCount(toolResultBytesBefore)
      ? { toolResultBytesBefore: safeTokenCount(toolResultBytesBefore) }
      : {}),
    ...(safeTokenCount(toolResultBytesAfter)
      ? { toolResultBytesAfter: safeTokenCount(toolResultBytesAfter) }
      : {}),
    ...(safeTokenCount(toolResultBytesSaved)
      ? { toolResultBytesSaved: safeTokenCount(toolResultBytesSaved) }
      : {}),
    ...(safeTokenCount(toolResultShapeBytesSaved)
      ? { toolResultShapeBytesSaved: safeTokenCount(toolResultShapeBytesSaved) }
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
    resultsShaped: 0,
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
        line.includes('"toolResultsAged"') ||
        line.includes('"toolResultsShaped"') ||
        line.includes('"toolResultsEvaluated"');
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
      const resultsShaped = safeTokenCount(event?.toolResultsShaped);
      const resultsCompacted = (resultsAged ?? 0) + (resultsShaped ?? 0);
      if (resultsCompacted) {
        totals.requests += 1;
        totals.resultsAged += resultsAged ?? 0;
        totals.resultsShaped += resultsShaped ?? 0;
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
          const side = cacheSums[index][resultsCompacted ? "aged" : "unaged"];
          side[0] += inputTokens;
          side[1] += Math.min(cachedInputTokens, inputTokens);
          totals.ranges[range.key].cache[resultsCompacted ? "agedTurns" : "unagedTurns"] += 1;
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

// Every row writes `at` as `new Date(at).toISOString()`, and that fixed-width
// UTC format sorts as text in the same order it sorts in time. Comparing the
// raw substring lets a long window skip most of an append-only ledger without
// parsing it, which is what makes filtering before capping affordable.
const AT_FIELD = '"at":"';

function lineOlderThan(line, cutoffIso) {
  const start = line.indexOf(AT_FIELD);
  if (start === -1) return false;
  const from = start + AT_FIELD.length;
  const end = line.indexOf('"', from);
  if (end === -1) return false;
  const at = line.slice(from, end);
  // Only the canonical toISOString() shape compares correctly as text. Anything
  // else is left for the authoritative Date.parse check, which still runs.
  if (at.length !== cutoffIso.length || at[at.length - 1] !== "Z") return false;
  return at < cutoffIso;
}

// The cap a caller gets when it does not choose one. Exported so a consumer
// that reads the window once and derives several views from it can apply the
// same bound without restating the number.
export const RECENT_USAGE_EVENT_LIMIT = 1_000;

export function recentUsageEvents({
  sinceMs = 24 * 60 * 60 * 1000,
  limit = RECENT_USAGE_EVENT_LIMIT,
} = {}) {
  if (!existsSync(USAGE_EVENTS_PATH)) return [];
  const cutoff = Date.now() - sinceMs;
  let cutoffIso = "";
  try {
    cutoffIso = new Date(cutoff).toISOString();
  } catch {
    // An out-of-range window has no text form; the parse-time check covers it.
    cutoffIso = "";
  }
  try {
    const events = usageEventLines()
      .filter(Boolean)
      // The window is applied BEFORE the cap, never after. Capping first spent
      // the budget on rows the window then threw away, so a long read on a busy
      // install silently lost its oldest days: at ~6k events/day the 100k cap a
      // 90-day snapshot passes covers barely two weeks of ledger, and the
      // missing remainder looked exactly like an idle month.
      .filter((line) => !cutoffIso || !lineOlderThan(line, cutoffIso))
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
      // Cap the kept events, keeping the most recent ones, so the limit bounds
      // the answer rather than the search. Infinity is an explicit opt-in for
      // consumers such as the retained-lifetime ledger that must not silently
      // drop older rows.
      .slice(Number.isFinite(limit) ? -Math.max(1, limit) : undefined)
      .map((event) => {
        const inputTokens = safeTokenCount(event.inputTokens);
        const billedInputTokens = safeTokenCount(event.billedInputTokens);
        const cachedInputTokens = safeTokenCount(event.cachedInputTokens);
        const outputTokens = safeTokenCount(event.outputTokens);
        const billedOutputTokens = safeTokenCount(event.billedOutputTokens);
        const reasoningTokens = safeTokenCount(event.reasoningTokens);
        const totalTokens = safeTokenCount(event.totalTokens);
        const retries = safeRetryCount(event.retries);
        const estimatedInputTokens = safeTokenCount(event.estimatedInputTokens);
        const toolResultsAged = safeTokenCount(event.toolResultsAged);
        const toolResultsShaped = safeTokenCount(event.toolResultsShaped);
        const toolResultBytesBefore = safeTokenCount(event.toolResultBytesBefore);
        const toolResultBytesAfter = safeTokenCount(event.toolResultBytesAfter);
        const toolResultBytesSaved = safeTokenCount(event.toolResultBytesSaved);
        const toolResultShapeBytesSaved = safeTokenCount(event.toolResultShapeBytesSaved);
        const searchResults = safeTokenCount(event.searchResults);
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
          ...(event.emptyCompletionPreludeLimit === "bytes" ||
          event.emptyCompletionPreludeLimit === "time"
            ? { emptyCompletionPreludeLimit: event.emptyCompletionPreludeLimit }
            : {}),
          ...(retries !== undefined ? { retries } : {}),
          ...(event.searchSidecar === true ? { searchSidecar: true } : {}),
          ...(event.searchSidecar === true && typeof event.searchCacheHit === "boolean"
            ? { searchCacheHit: event.searchCacheHit }
            : {}),
          ...(event.searchSidecar === true && searchResults !== undefined
            ? { searchResults }
            : {}),
          ...(inputTokens !== undefined ? { inputTokens } : {}),
          ...(billedInputTokens !== undefined ? { billedInputTokens } : {}),
          ...(cachedInputTokens !== undefined ? { cachedInputTokens } : {}),
          ...(outputTokens !== undefined ? { outputTokens } : {}),
          ...(billedOutputTokens !== undefined ? { billedOutputTokens } : {}),
          ...(reasoningTokens !== undefined ? { reasoningTokens } : {}),
          ...(totalTokens !== undefined ? { totalTokens } : {}),
          ...(estimatedInputTokens !== undefined ? { estimatedInputTokens } : {}),
          ...(toolResultsAged ? { toolResultsAged } : {}),
          ...(toolResultsShaped ? { toolResultsShaped } : {}),
          ...(toolResultBytesBefore ? { toolResultBytesBefore } : {}),
          ...(toolResultBytesAfter ? { toolResultBytesAfter } : {}),
          ...(toolResultBytesSaved ? { toolResultBytesSaved } : {}),
          ...(toolResultShapeBytesSaved ? { toolResultShapeBytesSaved } : {}),
        };
      });
    return events;
  } catch {
    return [];
  }
}

// The Control Center's hourly traffic chart was built entirely from
// recentUsageEvents(), whose default cap is 1,000 rows. An ordinary busy day is
// many times that -- 9,000 events in 24 hours is routine -- so the most recent
// 1,000 covered under two hours: twenty-two of the twenty-four bars were drawn
// empty, and the caption reported that truncated sum as the day's total while
// the summary tile beside it added up every provider row. Aggregate the whole
// window here and ship 24 small buckets instead. The chart gets an honest shape
// and a total that agrees with the tile, and the payload stays bounded however
// busy the router was.
export const HOURLY_USAGE_ROLLUP_HOURS = 24;

// Both helpers mirror the renderer's tokenCountFromEvent/trafficPartsFromEvent
// exactly, including the billed-over-raw preference and the cached-share clamp.
// recentUsageEvents() omits an absent count rather than writing a zero, so an
// unreported field stays distinguishable from a measured zero.
function rollupTokenCount(event) {
  if (event.totalTokens !== undefined) return event.totalTokens;
  const input = event.billedInputTokens ?? event.inputTokens;
  const output = event.billedOutputTokens ?? event.outputTokens;
  if (input === undefined && output === undefined) return undefined;
  return (input ?? 0) + (output ?? 0);
}

function rollupTokenParts(event) {
  const input = event.billedInputTokens ?? event.inputTokens;
  const cached = event.cachedInputTokens;
  const output = event.billedOutputTokens ?? event.outputTokens;
  if (input === undefined && cached === undefined && output === undefined) return undefined;
  const inputTokens = input ?? 0;
  const cachedInputTokens = input === undefined
    ? cached ?? 0
    : Math.min(inputTokens, cached ?? 0);
  return {
    regularInputTokens: Math.max(0, inputTokens - cachedInputTokens),
    cachedInputTokens,
    outputTokens: output ?? 0,
  };
}

export function hourlyUsageRollup({
  hours = HOURLY_USAGE_ROLLUP_HOURS,
  now = Date.now(),
  readEvents = recentUsageEvents,
} = {}) {
  const span = Math.max(1, Math.min(24 * 31, Math.floor(hours) || 0));
  // Keep clock-hour labels, but cover the exact rolling window. When `now`
  // sits between hour boundaries, the window touches both an oldest partial
  // hour and the current partial hour, so it can span `hours + 1` clock buckets.
  const windowStart = now - span * HOUR_MS;
  const firstAnchor = new Date(windowStart);
  firstAnchor.setMinutes(0, 0, 0);
  const lastAnchor = new Date(now);
  lastAnchor.setMinutes(0, 0, 0);
  const first = firstAnchor.getTime();
  const lastHour = lastAnchor.getTime();
  const lastBucket = now === lastHour ? lastHour - HOUR_MS : lastHour;
  const bucketCount = Math.floor((lastBucket - first) / HOUR_MS) + 1;
  const buckets = Array.from({ length: bucketCount }, (_, index) => ({
    startedAt: new Date(first + index * HOUR_MS).toISOString(),
    tokens: 0,
    requests: 0,
    measuredTokens: false,
    regularInputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    measuredBreakdown: false,
  }));
  // Reading the whole window is the point: the cap this replaces is the defect.
  const events = readEvents({
    sinceMs: Math.max(HOUR_MS, now - first),
    limit: Number.POSITIVE_INFINITY,
  });
  for (const event of events) {
    const at = Date.parse(event?.at);
    if (!Number.isFinite(at) || at < windowStart || at >= now) continue;
    const index = Math.floor((at - first) / HOUR_MS);
    if (index < 0 || index >= buckets.length) continue;
    const bucket = buckets[index];
    bucket.requests += 1;
    const tokens = rollupTokenCount(event);
    if (tokens !== undefined) {
      bucket.tokens += tokens;
      bucket.measuredTokens = true;
    }
    const parts = rollupTokenParts(event);
    if (parts) {
      bucket.regularInputTokens += parts.regularInputTokens;
      bucket.cachedInputTokens += parts.cachedInputTokens;
      bucket.outputTokens += parts.outputTokens;
      bucket.measuredBreakdown = true;
    }
  }
  return buckets;
}

// The append-only ledger is the source of truth for "everything this router
// has observed". Keep this separate from recentUsageEvents' bounded default so
// callers have to opt into the potentially larger read explicitly.
export function allUsageEvents({ limit = Number.POSITIVE_INFINITY } = {}) {
  return recentUsageEvents({ sinceMs: Number.POSITIVE_INFINITY, limit });
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
