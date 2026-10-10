// Bounded retries require two independent conditions: the caller has received
// no output, and replay is permitted by the delivery policy. Before-response
// reset and 5xx do not prove that a generation POST was never executed.

import { connectTimeoutMs } from "./connect-timeout.mjs";

const MAX_RETRIES = 5;
const MAX_BACKOFF_MS = 5_000;
const MAX_BUDGET_MS = 60_000;
const MAX_CAUSE_DEPTH = 8;

const DEFAULT_RETRIES = 2;
const DEFAULT_BACKOFF_MS = 250;
// Backoff grows 250ms -> 750ms, so two retries add at most one second of
// waiting to a request that was going to fail anyway. Codex retries roughly
// five times on its own and the two loops multiply, so the router's share has
// to stay small enough that the product is still a fast failure.
const BACKOFF_FACTOR = 3;
// Retry only while the request has been cheap so far. Most of the retryable
// failures below arrive in milliseconds, but two do not: a 504 the edge spent
// half a minute producing, and a connect timeout. The 504 stays relayed --
// tripling it turns a slow failure into a hang, which is worse than the 503
// this exists to absorb.
//
// The connect timeout is the opposite case and the reason this budget is
// derived rather than fixed. It is bounded at `connectTimeoutMs()` by the
// dispatcher, so it is fast enough to afford: three bounded attempts plus
// backoff still fit the worst case a single undici-default (10s) attempt used
// to cost. Undici's old default outran the previous fixed 5s budget, which
// made the connect codes in RETRYABLE_ERROR_CODES structurally unreachable --
// every connect timeout was relayed as a 502 and no connect retry was ever
// logged (2026-09-21 incident). Deriving the floor from the same bound keeps
// the two from drifting apart again when the connect timeout is tuned.
const DEFAULT_BUDGET_MS = Math.min(
  MAX_BUDGET_MS,
  Math.max(5_000, 3 * connectTimeoutMs()),
);

function clampedInteger(raw, fallback, min, max) {
  const value = Number(raw);
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(value)));
}

export const NATIVE_RETRY_LIMIT = clampedInteger(
  process.env.CODEX_ROUTER_NATIVE_RETRIES,
  DEFAULT_RETRIES,
  0,
  MAX_RETRIES,
);
export const NATIVE_RETRY_BACKOFF_MS = clampedInteger(
  process.env.CODEX_ROUTER_NATIVE_RETRY_BACKOFF_MS,
  DEFAULT_BACKOFF_MS,
  0,
  MAX_BACKOFF_MS,
);
export const NATIVE_RETRY_BUDGET_MS = clampedInteger(
  process.env.CODEX_ROUTER_NATIVE_RETRY_BUDGET_MS,
  DEFAULT_BUDGET_MS,
  0,
  MAX_BUDGET_MS,
);

// These statuses can be retried for safe methods or an explicit availability
// policy. None proves that an origin did not execute a generation POST.
// 429, other 4xx and origin 500 remain outside this transient retry policy.
export const RETRYABLE_STATUSES = new Set([502, 503, 504, 520, 521, 522, 523, 524]);

// Transient transport errors. Most do not establish delivery state: a socket
// can reset after the origin has received and executed the entire request.
const RETRYABLE_ERROR_CODES = new Set([
  "EADDRNOTAVAIL",
  "ECONNABORTED",
  "ECONNREFUSED",
  "ECONNRESET",
  "EAI_AGAIN",
  "EHOSTUNREACH",
  "ENETDOWN",
  "ENETUNREACH",
  "ENOBUFS",
  "ENOTFOUND",
  "EPIPE",
  "ETIMEDOUT",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_SOCKET",
]);

export function isRetryableStatus(status) {
  return RETRYABLE_STATUSES.has(Number(status));
}

export function isRetryableTransportError(error) {
  if (!error) return false;
  // An abort is the caller leaving, and a router-side error (a body that is too
  // large, an unsupported encoding) carries its own HTTP status and would fail
  // identically every time.
  if (error.name === "AbortError" || error.name === "TimeoutError") return false;
  if (error.status) return false;
  let cause = error;
  for (let depth = 0; cause && depth < MAX_CAUSE_DEPTH; depth += 1) {
    if (typeof cause.code === "string" && RETRYABLE_ERROR_CODES.has(cause.code)) return true;
    cause = cause.cause;
  }
  return false;
}

export const NATIVE_RETRY_POLICY =
  process.env.CODEX_ROUTER_NATIVE_RETRY_POLICY === "availability"
    ? "availability" : "at-most-once";

const UNSENT_CODES = new Set([
  "ENOTFOUND", "EAI_AGAIN", "ECONNREFUSED", "EADDRNOTAVAIL", "UND_ERR_CONNECT_TIMEOUT",
]);
const CONNECT_CODES = new Set([
  "ECONNRESET", "ECONNABORTED", "EHOSTUNREACH", "ENETDOWN", "ENETUNREACH", "ENOBUFS", "ETIMEDOUT",
]);

export function transportDeliveryState(error) {
  for (let cause = error, depth = 0; cause && depth < MAX_CAUSE_DEPTH; cause = cause.cause, depth += 1) {
    if (UNSENT_CODES.has(cause.code) ||
        (["connect", "bind", "getaddrinfo"].includes(cause.syscall) && CONNECT_CODES.has(cause.code))) {
      return "not_sent";
    }
  }
  return "possibly_sent";
}

function transportErrorCode(error) {
  for (let cause = error, depth = 0; cause && depth < MAX_CAUSE_DEPTH; cause = cause.cause, depth += 1) {
    if (RETRYABLE_ERROR_CODES.has(cause.code)) return cause.code;
  }
  return undefined;
}

// A backoff that a departing caller does not have to sit through: an abort
// resolves the wait immediately so the loop can stop on its next check.
export function sleep(ms, signal) {
  if (signal?.aborted || !(ms > 0)) return Promise.resolve();
  return new Promise((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      signal?.removeEventListener?.("abort", finish);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    signal?.addEventListener?.("abort", finish, { once: true });
  });
}

function abortError(signal) {
  if (signal?.reason instanceof Error) return signal.reason;
  const error = new Error("The upstream request was aborted by the caller.");
  error.name = "AbortError";
  return error;
}

// A failed attempt still owns a socket until its body is drained or cancelled.
async function discardBody(response) {
  try {
    await response?.body?.cancel();
  } catch {
    // The connection is already gone, which is the state we wanted anyway.
  }
}

function settle(response, failure, retries) {
  if (failure) throw failure;
  return { response, retries };
}

// Returns `{ response, retries }` where `retries` counts the attempts beyond
// the first, so a caller can tell "succeeded immediately" from "succeeded on
// the second try" and record the difference.
export async function fetchWithRetry(target, init = {}, options = {}) {
  const {
    retries = NATIVE_RETRY_LIMIT,
    backoffMs = NATIVE_RETRY_BACKOFF_MS,
    budgetMs = NATIVE_RETRY_BUDGET_MS,
    signal = init.signal,
    canRetry,
    onRetry,
    onAttempt,
    deliveryPolicy = NATIVE_RETRY_POLICY,
    fetchImpl = fetch,
    sleepImpl = sleep,
    now = Date.now,
  } = options;
  const startedAt = now();
  // GET/HEAD/OPTIONS can be repeated without generation side effects. A POST
  // needs positive pre-send evidence unless the operator accepts uncertainty.
  const safeMethod = ["GET", "HEAD", "OPTIONS"].includes(String(init.method ?? "GET").toUpperCase());
  const availability = deliveryPolicy === "availability";
  let attempt = 0;
  for (;;) {
    let response;
    let failure;
    const attemptStartedAt = now();
    try {
      response = await fetchImpl(target, init);
    } catch (error) {
      failure = error;
    }
    const deliveryState = failure ? transportDeliveryState(failure) : "response_started";
    const retryable = failure
      ? isRetryableTransportError(failure)
      : isRetryableStatus(response?.status);
    const permitted = safeMethod || availability || deliveryState === "not_sent";
    const retryScheduled = attempt < retries && retryable && permitted &&
      !signal?.aborted && canRetry?.() !== false && now() - startedAt < budgetMs;
    onAttempt?.({
      attempt: attempt + 1,
      ...(response ? { status: response.status } : {}),
      ...(transportErrorCode(failure) ? { errorCode: transportErrorCode(failure) } : {}),
      deliveryState,
      durationMs: Math.max(0, now() - attemptStartedAt),
      retryScheduled,
    });
    if (!retryScheduled) return settle(response, failure, attempt);
    const delayMs = backoffMs * BACKOFF_FACTOR ** attempt;
    onRetry?.({
      attempt: attempt + 1,
      retries,
      status: response?.status,
      error: failure,
      delayMs,
      deliveryState,
      deliveryPolicy: availability ? "availability" : "at-most-once",
    });
    await sleepImpl(delayMs, signal);
    if (signal?.aborted) {
      await discardBody(response);
      throw abortError(signal);
    }
    // Delivery permission can change while waiting: the caller may receive
    // bytes, or the total retry allowance may expire. Keep the last response
    // readable unless a replacement will actually be submitted.
    if (canRetry?.() === false || now() - startedAt >= budgetMs) {
      return settle(response, failure, attempt);
    }
    await discardBody(response);
    if (signal?.aborted) throw abortError(signal);
    if (canRetry?.() === false || now() - startedAt >= budgetMs) {
      return settle(response, failure, attempt);
    }
    attempt += 1;
  }
}
