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

import { describeChildExit } from "./fatal-exit.mjs";

export const DEFAULT_MAX_RESTARTS = 5;
export const DEFAULT_RESTART_WINDOW_MS = 10 * 60_000;
export const DEFAULT_RESTART_BACKOFF_MS = 1_000;
export const MAX_RESTART_BACKOFF_MS = 30_000;

// A gateway can stop serving while its process stays alive. On Windows,
// LiteLLM's uvicorn accept loop can die to an asyncio proactor error
// (`WinError 64 ... Accept failed on a socket`, observed after a mid-stream
// upstream reset) and then never accept another connection, even though the
// Python process keeps running and `waitForExit` never fires. The exit-only
// supervisor above would leave every routed request talking to a closed port
// until a human restarted the service. So also poll the same liveness endpoint
// the router uses: a few consecutive failures mean the listener is gone, and
// the still-running child is stopped so the restart path below runs.
export const DEFAULT_HEALTH_INTERVAL_MS = 15_000;
export const DEFAULT_HEALTH_FAILURES = 3;

// A probe that times out is not the same evidence as one that is refused. A
// refused loopback connection means the listener is gone -- the case above --
// and a few in a row are conclusive. A timeout means something accepted the
// connection, or this machine was too starved to schedule the answer: under a
// load average in the hundreds a healthy LiteLLM misses a 4 s probe while it is
// still streaming a turn. Killing it on the short fuse cut that live stream,
// and the replacement then could not finish importing under the same load, so
// the router answered 502 for minutes. Timeouts therefore get a long fuse
// (~20 intervals, several minutes) that still ends a truly wedged event loop.
export const DEFAULT_HEALTH_STALL_FAILURES = 20;

// How many of start.mjs's cold-start health budgets a still-running
// replacement gets before it is stopped and counted as a failed restart.
export const DEFAULT_STARTUP_BUDGETS = 3;

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
    healthIntervalMs: positiveInteger(
      env.CODEX_ROUTER_GATEWAY_HEALTH_INTERVAL_MS,
      DEFAULT_HEALTH_INTERVAL_MS,
    ),
    healthFailures: positiveInteger(
      env.CODEX_ROUTER_GATEWAY_HEALTH_FAILURES,
      DEFAULT_HEALTH_FAILURES,
    ),
    healthStallFailures: positiveInteger(
      env.CODEX_ROUTER_GATEWAY_HEALTH_STALL_FAILURES,
      DEFAULT_HEALTH_STALL_FAILURES,
    ),
  };
}

function isRunning(child) {
  return Boolean(child) && child.exitCode === null && child.signalCode === null;
}

function reason(error) {
  return (error instanceof Error && error.message) || String(error);
}

// Resolve as soon as the child exits OR its liveness probe fails conclusively
// `healthFailures` times in a row (or times out `healthStallFailures` times in
// a row). The watchdog is marked stopped once the race is decided so it cannot
// keep probing a child that already exited.
async function waitForExitOrUnhealthy(
  current,
  {
    label,
    waitForExit,
    healthCheck,
    healthIntervalMs,
    healthFailures,
    healthStallFailures,
    isShuttingDown,
    sleep,
  },
) {
  const exit = waitForExit(current, label).then((result) => ({ kind: "exit", result }));
  let stopped = false;
  const watchdog = (async () => {
    let consecutive = 0;
    let conclusive = 0;
    while (!stopped) {
      await sleep(healthIntervalMs);
      if (stopped || isShuttingDown() || !isRunning(current)) return null;
      try {
        await healthCheck();
        consecutive = 0;
        conclusive = 0;
      } catch (error) {
        consecutive += 1;
        if (error?.probeOutcome !== "timeout") conclusive += 1;
        const stalled = consecutive >= Math.max(healthFailures, healthStallFailures);
        if (conclusive >= healthFailures || stalled) {
          return {
            kind: "unhealthy",
            result: {
              label,
              code: null,
              signal: null,
              reason: stalled
                ? `${consecutive} consecutive liveness failures, ${consecutive - conclusive} of them timeouts`
                : `${conclusive} consecutive liveness failures`,
            },
          };
        }
      }
    }
    return null;
  })();
  const winner = await Promise.race([exit, watchdog]);
  stopped = true;
  return winner ?? exit;
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
  healthCheck,
  healthIntervalMs = DEFAULT_HEALTH_INTERVAL_MS,
  healthFailures = DEFAULT_HEALTH_FAILURES,
  healthStallFailures = DEFAULT_HEALTH_STALL_FAILURES,
  startupBudgets = DEFAULT_STARTUP_BUDGETS,
} = {}) {
  let current = child;
  let restarts = 0;
  const failures = [];
  const healthMonitored = typeof healthCheck === "function";

  for (;;) {
    const outcome = healthMonitored
      ? await waitForExitOrUnhealthy(current, {
          label,
          waitForExit,
          healthCheck,
          healthIntervalMs,
          healthFailures,
          healthStallFailures,
          isShuttingDown,
          sleep,
        })
      : { kind: "exit", result: await waitForExit(current, label) };
    const exit = outcome.result;
    if (isShuttingDown()) return { ...exit, restarts };

    const at = now();
    failures.push(at);
    while (failures.length > 0 && at - failures[0] > windowMs) failures.shift();

    // The exit fragment names a Windows fatal status when the code is one
    // (src/fatal-exit.mjs) and renders byte-identical otherwise, so the
    // restart lines classify a native abort without changing any other shape.
    const describeExit = describeChildExit(exit);
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

    if (outcome.kind === "unhealthy") {
      log(
        `${label} stopped answering health checks (${exit.reason}); terminating the ` +
          `still-running process before restarting it.`,
      );
      // The process is alive but its listener is not. Stop it and wait for the
      // exit so the replacement can bind the same port.
      if (isRunning(current)) stop(current);
      await waitForExit(current, label);
    }

    restarts += 1;
    try {
      current = start();
      // A replacement that is still running when its health budget runs out is
      // usually a starved import, not a broken one: killing it restarts the
      // import from zero under the same load, and the loop never converges.
      // Give a live child a few more budgets before counting it as failed.
      for (let budget = 1; ; budget += 1) {
        try {
          await waitForHealth(current);
          break;
        } catch (error) {
          if (budget >= startupBudgets || !isRunning(current) || isShuttingDown()) throw error;
          log(
            `${label} is still starting (${reason(error)}); waiting instead of ` +
              `restarting its import (budget ${budget + 1} of ${startupBudgets}).`,
          );
        }
      }
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
