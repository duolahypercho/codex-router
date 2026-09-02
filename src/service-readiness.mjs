import { waitForRouterHealth } from "./router-health.mjs";
import { LOG_PATH, STATE_DIR } from "./paths.mjs";
import { windowsScheduledTaskState } from "./windows-task-state.mjs";
import { diagnoseWindowsLaunchFailure, readLogTail } from "./windows-launch-diagnosis.mjs";

const TASK_LAUNCH_GRACE_MS = 15_000;
const TASK_STATE_POLL_MS = 1_000;
// A systemd unit with Restart=always re-enters "active" after every crash, so
// the unit state never reads "failed" during a crash loop and health alone
// cannot distinguish one from a slow start. The restart counter is what
// moves; this many restarts since the wait began is a crash loop.
const CRASH_LOOP_RESTARTS = 3;

function sleep(milliseconds) {
  return milliseconds <= 0
    ? Promise.resolve()
    : new Promise((resolve) => setTimeout(resolve, milliseconds));
}

// `waitForRouterHealth` reports failure as a resolved result object, not a
// rejection. Normalize both shapes so the guard can trust one contract:
// `healthy === true` only when the router actually answered.
async function settleHealth(waitForHealth, timeoutMs) {
  try {
    const health = await waitForHealth({ timeoutMs });
    return { healthy: health?.ok === true, health };
  } catch (error) {
    return { healthy: false, error };
  }
}

// A restart-count query failure is inconclusive, exactly like a failed Task
// Scheduler query on Windows, and never fails the wait by itself. The query
// receives the wait's remaining budget so a slow counter source (spawnSync on
// the Linux path) can bound itself inside the deadline instead of stretching
// it.
async function settleRestarts(getServiceRestarts, remainingMs) {
  try {
    const restarts = await getServiceRestarts(Math.max(0, remainingMs));
    return Number.isSafeInteger(restarts) && restarts >= 0 ? restarts : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Wait for router health while honoring Windows' authoritative task state.
 *
 * Task Scheduler can keep a stale instance entry (or a Running state) after
 * its launcher tree has died, so liveness is read from two places: the COM
 * instance enumeration, and a direct scan for a live process whose command
 * line references the generated launcher. Once both stop reporting a live
 * launch for longer than the launch grace, readiness fails with the task's
 * own result instead of polling health for the full budget. A query failure
 * is inconclusive and never fails the wait by itself.
 *
 * On the POSIX service managers the analogous early verdict is the restart
 * counter: a unit that accumulates restarts while health never answers is
 * crash-looping, and polling health for the full budget only delays the
 * operator's look at the service log. When no counter is available the wait
 * stays health-only, which is the shape macOS launchd has.
 */
export async function waitForServiceReadiness({
  platform = process.platform,
  timeoutMs = 300_000,
  launchGraceMs = TASK_LAUNCH_GRACE_MS,
  pollMs = TASK_STATE_POLL_MS,
  getWindowsTaskState = windowsScheduledTaskState,
  getServiceRestarts,
  waitForHealth = waitForRouterHealth,
  logPath = LOG_PATH,
} = {}) {
  const deadline = Date.now() + Math.max(0, timeoutMs);
  // Keep exactly one health attempt in flight for the whole operation; the
  // readiness guard may finish first and must not create an unhandled
  // rejection.
  const healthWinner = settleHealth(waitForHealth, Math.max(0, deadline - Date.now())).then(
    (outcome) => ({ kind: "health", outcome }),
  );
  const failureOf = (outcome) =>
    outcome.error ??
    new Error(outcome.health?.error || "service did not become healthy");

  if (platform !== "win32") {
    if (typeof getServiceRestarts !== "function") {
      const winner = await healthWinner;
      if (winner.outcome.healthy) return winner.outcome.health;
      throw failureOf(winner.outcome);
    }
    // Restart counts are compared against the value at wait start, not
    // absolute: a unit can carry restarts from before this install touched
    // it, and only restarts this wait observes are evidence of a loop.
    let baseline = await settleRestarts(getServiceRestarts, deadline - Date.now());
    let restartsSince = 0;
    while (Date.now() < deadline) {
      const winner = await Promise.race([
        healthWinner,
        sleep(Math.min(pollMs, deadline - Date.now())).then(() => null),
      ]);
      if (winner) {
        if (winner.outcome.healthy) return winner.outcome.health;
        throw failureOf(winner.outcome);
      }
      const restarts = await settleRestarts(getServiceRestarts, deadline - Date.now());
      if (restarts !== undefined) {
        baseline ??= restarts;
        restartsSince = Math.max(restartsSince, restarts - baseline);
        if (restartsSince >= CRASH_LOOP_RESTARTS) {
          // The counter query itself takes time, and health may settle while
          // it runs -- the poll race above gave up a tick ago. The counter
          // never overrides a verdict health has already reached, so the
          // crash-loop finding is reported only after one last bounded look.
          // That grace still belongs to the original readiness budget; a
          // threshold reached near the deadline must not add a fresh poll.
          const finalGraceMs = Math.max(0, Math.min(pollMs, deadline - Date.now()));
          const finalWinner = await Promise.race([
            healthWinner,
            sleep(finalGraceMs).then(() => null),
          ]);
          if (finalWinner) {
            if (finalWinner.outcome.healthy) return finalWinner.outcome.health;
            throw failureOf(finalWinner.outcome);
          }
          throw new Error(
            `The background service restarted ${restartsSince} times while ` +
              "waiting for it to become healthy; it is crash-looping. " +
              "Inspect `journalctl --user -u codex-router.service` and the " +
              `router log in ${STATE_DIR}.`,
          );
        }
      }
    }
    const winner = await healthWinner;
    if (winner.outcome.healthy) return winner.outcome.health;
    throw failureOf(winner.outcome);
  }

  let deadSince;
  while (Date.now() < deadline) {
    const winner = await Promise.race([
      healthWinner,
      sleep(Math.min(pollMs, deadline - Date.now())).then(() => null),
    ]);
    if (winner) {
      // The health attempt settles only after its full budget, which matches
      // this guard's own deadline, so an early settlement is a real verdict.
      if (winner.outcome.healthy) return winner.outcome.health;
      throw failureOf(winner.outcome);
    }

    let taskState;
    try {
      taskState = await getWindowsTaskState();
    } catch {
      taskState = undefined;
    }
    const launcherAlive =
      taskState?.launcherAlive === true ||
      (taskState?.launcherAlive === undefined && taskState?.instanceCount > 0);
    if (taskState && !launcherAlive) {
      deadSince ??= Date.now();
      if (Date.now() - deadSince >= launchGraceMs) {
        const result = Number.isSafeInteger(taskState.lastTaskResult)
          ? `0x${taskState.lastTaskResult.toString(16)}`
          : "unknown";
        // The task's own result is a bare exit code. When the router log
        // explains why the launch died, say that instead of leaving the
        // operator to reconcile "no running launcher" against a Node error
        // that names a file they can open (issue #548).
        const diagnosis = diagnoseWindowsLaunchFailure({ logText: readLogTail(logPath) });
        throw new Error(
          `Windows Scheduled Task has no running launcher process (LastTaskResult=${result}); router cannot become healthy.` +
            (diagnosis ? `\n${diagnosis}` : ""),
        );
      }
    } else if (launcherAlive) {
      deadSince = undefined;
    }
  }

  const winner = await healthWinner;
  if (winner.outcome.healthy) return winner.outcome.health;
  throw failureOf(winner.outcome);
}
