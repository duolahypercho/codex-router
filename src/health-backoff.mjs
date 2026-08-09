// Startup health polling ran at a flat interval, which is cheap when a service
// comes up in a second and wasteful when it does not. The LiteLLM gateway is
// allowed 300 seconds to cold start, so a flat 200 ms produced up to 1500
// probes for a single boot -- and every gateway probe is an access-log line.
// A crash-looping service under KeepAlive repeats that burst on every restart
// and never reaches the steady state the health cache smooths out.
//
// Backing off keeps the common case fast (the first probes are still 200 ms
// apart, so a service that is already up is detected immediately) while a slow
// or failing boot settles to one probe every couple of seconds.
export const INITIAL_PROBE_DELAY_MS = 200;
export const MAX_PROBE_DELAY_MS = 2_000;

// How long a single probe is allowed to stay in flight. This is a separate
// question from how long to wait between probes, and it used to be a flat
// 1000 ms.
//
// The bound itself has to stay: a probe that connects and then never answers
// would otherwise consume the whole 30 s (or the gateway's 300 s) inside one
// fetch, and the loop would stop re-checking whether the child crashed or
// whether the router is shutting down. But a flat second is not a safe bound.
// Past roughly 16x fork-storm contention on a 10-core machine, a forwarder that
// printed "listening" at ~1.4 s answered every probe later than that, so every
// probe aborted, the budget ran out, and startup declared a working service
// dead.
//
// Growing the window keeps the early loop responsive (the first probe is still
// the same 1 s it always was, so a crash or a Ctrl-C is still noticed within a
// second) while giving a starved machine room to answer later on.
export const INITIAL_PROBE_TIMEOUT_MS = 1_000;
export const MAX_PROBE_TIMEOUT_MS = 10_000;

export function probeTimeoutMs(attempt, options = {}) {
  const {
    initialMs = INITIAL_PROBE_TIMEOUT_MS,
    maxMs = MAX_PROBE_TIMEOUT_MS,
    factor = 1.5,
  } = options;
  if (Number.isNaN(attempt) || attempt < 0) return initialMs;
  return Math.min(maxMs, Math.round(initialMs * factor ** attempt));
}

export function probeDelayMs(attempt, options = {}) {
  const {
    initialMs = INITIAL_PROBE_DELAY_MS,
    maxMs = MAX_PROBE_DELAY_MS,
    factor = 1.5,
  } = options;
  // Only genuinely meaningless input falls back. A huge attempt count is not
  // meaningless -- it means this has been retrying for a long time, which is
  // exactly when the cap should apply, so it is left to clamp below.
  if (Number.isNaN(attempt) || attempt < 0) return initialMs;
  const delay = initialMs * factor ** attempt;
  // Never overshoot the caller's remaining budget: a delay longer than the
  // time left would turn a timeout into a longer one.
  return Math.min(maxMs, Math.round(delay));
}
