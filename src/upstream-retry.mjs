// Bounded retry for an upstream request that failed before any byte of the
// response reached the caller.
//
// ChatGPT's edge intermittently answers a native turn with
// "upstream connect error or disconnect/reset before headers", and the router
// relayed that 503 straight through. "Before headers" is the whole point: no
// response bytes ever existed, so the request can be sent again and the caller
// never learns it happened. Codex reacts to the relayed 5xx by spending one of
// its own five reconnects on a failure that one short retry absorbs.
//
// The safety rule this module exists to enforce: a retry is only ever legal
// while nothing has been relayed. That is guaranteed structurally -- the loop
// runs entirely before the caller touches its own `ServerResponse` -- and the
// `canRetry` predicate is the second line of defence, re-checked before every
// single retry. Retrying after partial output would duplicate the stream.

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

// Statuses that mean an intermediary never obtained a usable response from the
// origin, so the request itself was not served and sending it again is not a
// second execution:
//
//   502/503/504  gateway/edge failure, the reported case
//   520-524      Cloudflare-only edge failures; a live usage log recorded 520
//                alongside the 503s, which is what proves the failure is
//                happening at chatgpt.com's edge
//
// Deliberately absent:
//
//   429  quota and rate limiting. Retrying it blindly makes the condition
//        worse, and honouring `Retry-After` would mean sleeping for as long as
//        the upstream asks -- exactly the multi-second hang this bound exists
//        to avoid. It is relayed so the caller and the user see it.
//   4xx  deterministic. The same request produces the same answer.
//   500  the origin ran and failed. Unlike the edge statuses above, a repeat
//        risks a second execution of work that already happened.
export const RETRYABLE_STATUSES = new Set([502, 503, 504, 520, 521, 522, 523, 524]);

// Transport failures where no response ever started. `fetch` reports these as
// a generic TypeError whose cause carries the socket-level code.
//
// ENOTFOUND, EADDRNOTAVAIL, and ENOBUFS joined after #171: a Windows machine
// under loopback churn failed native connects repeatedly while the same
// origin answered other requests in the same window, which is the transient
// shape this bound exists to absorb. All three fail before a connection
// exists — a name that did not resolve, no ephemeral port to bind, no kernel
// buffer for the socket — so a retry can never be a second execution.
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

// A backoff that a departing caller does not have to sit through: an abort
// resolves the wait immediately so the loop can stop on its next check.
export function sleep(ms, signal) {
  if (!(ms > 0)) return Promise.resolve();
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
    fetchImpl = fetch,
    sleepImpl = sleep,
    now = Date.now,
  } = options;
  const startedAt = now();
  let attempt = 0;
  for (;;) {
    let response;
    let failure;
    try {
      response = await fetchImpl(target, init);
    } catch (error) {
      failure = error;
    }
    if (attempt >= retries) return settle(response, failure, attempt);
    const retryable = failure
      ? isRetryableTransportError(failure)
      : isRetryableStatus(response?.status);
    if (!retryable) return settle(response, failure, attempt);
    // The caller is gone, or has already relayed something. Either way this
    // request is over: a retry would be work for nobody, or a duplicated
    // stream.
    if (signal?.aborted || canRetry?.() === false) {
      return settle(response, failure, attempt);
    }
    // This attempt was not cheap, so the failure was not the fast one a retry
    // absorbs. Relay it rather than spending the same time again.
    if (now() - startedAt >= budgetMs) return settle(response, failure, attempt);
    await discardBody(response);
    const delayMs = backoffMs * BACKOFF_FACTOR ** attempt;
    attempt += 1;
    onRetry?.({
      attempt,
      retries,
      status: response?.status,
      error: failure,
      delayMs,
    });
    await sleepImpl(delayMs, signal);
    if (signal?.aborted) throw abortError(signal);
  }
}
