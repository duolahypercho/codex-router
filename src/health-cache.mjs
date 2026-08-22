// The companion polls the router's /health continuously, and every one of
// those fanned out to three downstream probes -- including the gateway's
// /health/liveliness, which LiteLLM's uvicorn logs a line for. On an idle
// machine that measured 2.5 probes a second, roughly 16.6 MB of log a day,
// none of it carrying information: the answer cannot meaningfully change
// between two probes a fraction of a second apart.
//
// A short TTL collapses a burst of polls into one probe. It is deliberately
// short: the tray shows live service status, so a stale "reachable" is a lie
// with a shelf life, and a few seconds is the most that is honest.
export const DEFAULT_HEALTH_TTL_MS = 3_000;
// Stale-while-revalidate must not serve an hours-old "reachable" to doctor on a
// tray-less machine that has not polled since the gateway died. The TTL is the
// companion's refresh cadence; this is the hard bound on how old a nonblocking
// snapshot may be before `/health` waits for a live probe.
export const DEFAULT_MAX_STALE_MS = 15_000;

export function createHealthCache({
  ttlMs = DEFAULT_HEALTH_TTL_MS,
  maxStaleMs = DEFAULT_MAX_STALE_MS,
  now = () => Date.now(),
  staleWhileRevalidate = false,
} = {}) {
  const entries = new Map();

  function canServeStale(existing) {
    if (!staleWhileRevalidate || existing?.lastValue === undefined) return false;
    return now() - existing.lastValueAt <= maxStaleMs;
  }

  return function cachedProbe(key, probe) {
    const existing = entries.get(key);
    const fresh = Boolean(existing) && now() - existing.at < ttlMs;
    // Concurrent callers share the in-flight promise rather than each starting
    // their own probe, so a burst of polls costs one request, not one each.
    if (fresh) {
      if (canServeStale(existing)) return Promise.resolve(existing.lastValue);
      // A refresh that threw leaves the value behind but no promise: its own
      // settled promise resolves to that snapshot, and replaying it here would
      // hand back an answer older than `maxStaleMs`. Fall through and probe.
      if (existing.promise) return existing.promise;
    }
    if (existing?.promise && existing.refreshing) {
      if (canServeStale(existing)) return Promise.resolve(existing.lastValue);
      return existing.promise;
    }

    const promise = Promise.resolve()
      .then(probe)
      .then((value) => {
        const current = entries.get(key);
        if (current?.promise === promise) {
          const observedAt = now();
          entries.set(key, {
            at: observedAt,
            lastValueAt: observedAt,
            promise,
            lastValue: value,
            refreshing: false,
          });
        }
        return value;
      })
      .catch((error) => {
        const current = entries.get(key);
        // The last answer may stand in for a failed refresh only while it is
        // inside the same `maxStaleMs` bound the nonblocking paths enforce.
        // Without that check a probe that starts throwing pins `/health` to
        // whatever it last saw, so a gateway that died an hour ago keeps
        // reporting reachable for as long as the process lives. `lastValueAt`
        // deliberately is not touched: the snapshot does not get younger
        // because a probe failed, and this bound is what expires it.
        if (canServeStale(current)) {
          entries.set(key, {
            at: now(),
            lastValueAt: current.lastValueAt,
            // Drop the settled promise rather than caching it as this entry's
            // answer: it resolves to the snapshot above, and the fresh-window
            // short circuit would replay it past `maxStaleMs`.
            promise: undefined,
            lastValue: current.lastValue,
            refreshing: false,
          });
          return current.lastValue;
        }
        // A thrown probe must not be cached as an answer: drop it so the next
        // caller retries instead of inheriting the failure for the whole TTL.
        if (current?.promise === promise) entries.delete(key);
        throw error;
      });

    if (canServeStale(existing)) {
      entries.set(key, {
        at: now(),
        lastValueAt: existing.lastValueAt,
        promise,
        lastValue: existing.lastValue,
        refreshing: true,
      });
      return Promise.resolve(existing.lastValue);
    }

    entries.set(key, {
      at: now(),
      lastValueAt: existing?.lastValueAt,
      promise,
      lastValue: existing?.lastValue,
      refreshing: true,
    });
    return promise;
  };
}
