// The LiteLLM gateway is the one child of the service that is not ours. It is
// a large Python process pinned by `requirements/python.txt`, and a bug
// anywhere in that tree can end the process rather than the request -- issue
// #261 is exactly that: mapping an upstream 429 raised out of the request
// handler and the proxy exited 1.
//
// Before this module, `start.mjs` raced every child's exit and tore the whole
// service down when any of them died, so a gateway crash took the router and
// all three forwarders with it. The OS supervisor (launchd KeepAlive, systemd
// Restart=always, Task Scheduler) does bring the service back, but it brings
// back *everything*: the router's in-memory state is discarded and the gateway
// pays a cold Python import that start.mjs itself allows up to five minutes
// for. For that whole window clients get a refused connection -- "Connection
// error", with nothing naming the gateway as the cause.
//
// Restarting only the gateway keeps the router listening, so a crash costs one
// stalled request instead of the session: the router answers with a translated
// upstream error, `/health` reports `gateway.reachable: false` and returns 503,
// and doctor's "Router health" check sees it.
//
// Three rules keep the restart from being worse than the crash:
//
//   1. **Only after the gateway has been healthy once.** A gateway that never
//      came up is a configuration or dependency failure, and retrying it hides
//      the message the operator needs. Startup failure is unchanged: it still
//      throws out of `main()` and takes the service down.
//   2. **Bounded, in a window.** At most `maxRestarts` failures inside
//      `windowMs`; past that the supervisor returns and the service exits so
//      the OS supervisor performs a genuinely clean restart. Without the
//      window, an install that crashes once a week would eventually exhaust a
//      lifetime budget and stop being restarted at all; without the bound, a
//      gateway that dies on every request becomes a spawn loop.
//   3. **Never silent.** Every crash, every restart, and the decision to stop
//      restarting are logged unconditionally -- the production LaunchAgent
//      hard-sets `CODEX_ROUTER_QUIET`, and a router that quietly resurrects a
//      crashing gateway is indistinguishable from one that never failed.

export const DEFAULT_MAX_RESTARTS = 5;
export const DEFAULT_RESTART_WINDOW_MS = 10 * 60_000;
export const DEFAULT_RESTART_BACKOFF_MS = 1_000;
export const MAX_RESTART_BACKOFF_MS = 30_000;

// Doubling from the base, capped. The cap matters more than the curve: a
// gateway that crashes on a poisoned request recovers on the first restart,
// while one that dies on startup must not be respawned faster than it takes to
// read the failure in the log.
export function restartBackoffMs(attempt, base = DEFAULT_RESTART_BACKOFF_MS) {
  const index = Number.isFinite(attempt) && attempt > 0 ? Math.floor(attempt) : 0;
  const step = Math.max(0, base) * 2 ** Math.min(index, 16);
  return Math.min(step, MAX_RESTART_BACKOFF_MS);
}

function positiveInteger(value, fallback, { allowZero = false } = {}) {
  if (value === undefined || value === null || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  const floored = Math.floor(parsed);
  if (floored < 0) return fallback;
  if (floored === 0 && !allowZero) return fallback;
  return floored;
}

// `CODEX_ROUTER_GATEWAY_RESTARTS=0` disables supervision entirely and restores
// the pre-#261 behaviour, which is what a bisect or a crash investigation
// wants: the process should die where it died.
export function gatewaySupervisorLimits(env = process.env) {
  return {
    maxRestarts: positiveInteger(env.CODEX_ROUTER_GATEWAY_RESTARTS, DEFAULT_MAX_RESTARTS, {
      allowZero: true,
    }),
    backoffMs: positiveInteger(
      env.CODEX_ROUTER_GATEWAY_RESTART_BACKOFF_MS,
      DEFAULT_RESTART_BACKOFF_MS,
      { allowZero: true },
    ),
    windowMs: positiveInteger(
      env.CODEX_ROUTER_GATEWAY_RESTART_WINDOW_MS,
      DEFAULT_RESTART_WINDOW_MS,
    ),
  };
}

function isRunning(child) {
  return Boolean(child) && child.exitCode === null && child.signalCode === null;
}

function reason(error) {
  return (error instanceof Error && error.message) || String(error);
}

/**
 * Watch an already-healthy gateway child and restart it in place when it dies.
 *
 * Resolves with the same shape `waitForExit` produces -- `{ label, code,
 * signal }` -- so the caller can keep racing it against the other children.
 * `restarts` counts the crashes seen, and `exhausted` is true when the loop
 * gave up rather than the service shutting down.
 */
export async function superviseGateway({
  label = "LiteLLM gateway",
  child,
  start,
  waitForExit,
  waitForHealth,
  stop = (target) => target.kill("SIGTERM"),
  isShuttingDown = () => false,
  log = (message) => console.error(message),
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now = Date.now,
  maxRestarts = DEFAULT_MAX_RESTARTS,
  windowMs = DEFAULT_RESTART_WINDOW_MS,
  backoffMs = DEFAULT_RESTART_BACKOFF_MS,
} = {}) {
  let current = child;
  let restarts = 0;
  const failures = [];

  for (;;) {
    const exit = await waitForExit(current, label);
    if (isShuttingDown()) return { ...exit, restarts };

    const at = now();
    failures.push(at);
    while (failures.length > 0 && at - failures[0] > windowMs) failures.shift();

    const describeExit = `code=${String(exit.code)}, signal=${String(exit.signal)}`;
    if (maxRestarts <= 0 || failures.length > maxRestarts) {
      log(
        maxRestarts <= 0
          ? `${label} exited (${describeExit}); restarts are disabled.`
          : `${label} exited (${describeExit}) after ${failures.length - 1} restart(s) ` +
            `within ${Math.round(windowMs / 1000)}s; not restarting it again.`,
      );
      return { ...exit, restarts, exhausted: true };
    }

    const wait = restartBackoffMs(failures.length - 1, backoffMs);
    log(
      `${label} exited (${describeExit}); restarting in ${wait} ms ` +
        `(restart ${failures.length} of ${maxRestarts}). The router stays up; ` +
        `requests fail with an upstream error until it answers again.`,
    );
    await sleep(wait);
    if (isShuttingDown()) return { ...exit, restarts };

    restarts += 1;
    try {
      current = start();
      await waitForHealth(current);
      log(`${label} is healthy again after ${restarts} restart(s).`);
    } catch (error) {
      log(`${label} did not come back: ${reason(error)}.`);
      // A child that is alive but never became healthy would leave the loop
      // parked on a `waitForExit` that resolves only when something else kills
      // it, so end it here and let the next iteration count it.
      if (isRunning(current)) stop(current);
    }
  }
}
