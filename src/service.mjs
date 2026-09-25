import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { SOURCE_ROOT } from "./paths.mjs";
import { clearStartupAttempts } from "./startup-attempts.mjs";
import { stopManagedOllama } from "./ollama-runtime.mjs";
import { waitForServiceReadiness } from "./service-readiness.mjs";
import { withServiceOperationLock } from "./service-operation-lock.mjs";
import { environmentProxyOptedIn } from "./proxy-environment.mjs";

const platform = process.env.CODEX_ROUTER_SERVICE_PLATFORM || process.platform;
const script = {
  darwin: "service-macos.mjs",
  linux: "service-linux.mjs",
  win32: "service-windows.mjs",
}[platform];

if (!script) {
  throw new Error(`Unsupported background-service platform: ${platform}`);
}

const mutatingCommands = new Set(["install", "uninstall", "start", "stop", "restart"]);
const readinessCommands = new Set(["install", "start", "restart"]);
const shutdownCommands = new Set(["stop", "uninstall"]);
// start.mjs allows the LiteLLM gateway 300s to cold start, so the readiness
// wait has to cover at least that. A shorter wait reports failure while the
// service is still booting, and the installer's rollback then uninstalls the
// service and reverts the app config out from under a router that goes on to
// come up healthy seconds later.
const READINESS_TIMEOUT_MS = 300_000;
// The service is installed and running; only the health wait ran out. Both
// installers read this to skip the service teardown in their rollback, so a
// slow cold start no longer uninstalls a working install (#760). 75 is
// EX_TEMPFAIL -- "try again", which is exactly the contract here.
export const READINESS_TIMEOUT_EXIT_CODE = 75;
// router-restart.mjs reserves this phase before the readiness wait. Check it
// again in the child before the service-manager mutation so an independently
// invoked or stale inherited deadline cannot make a restart deterministically
// short of its health contract.
const PLATFORM_COMMAND_RESERVE_MS = 10_000;
const operationDeadline = (() => {
  const value = Number(process.env.CODEX_ROUTER_OPERATION_DEADLINE_MS);
  return Number.isSafeInteger(value) && value > 0 ? value : undefined;
})();

function remainingOperationMs(limit = Number.POSITIVE_INFINITY) {
  if (operationDeadline === undefined) return Number.isFinite(limit) ? limit : undefined;
  const remaining = operationDeadline - Date.now();
  if (remaining <= 0) throw new Error("The router operation deadline expired.");
  return Math.max(1, Math.min(remaining, limit));
}
// One restart-count query runs on every readiness poll, synchronously. A
// systemctl that never answers must cost the wait a bounded slice, not the
// whole readiness budget, so the query is killed and read as inconclusive.
const RESTART_QUERY_TIMEOUT_MS = 5_000;

export async function runServiceCommandUnlocked(
  command = "status",
  args = [command],
) {
  // The wrapper below is a separate Node process, so a direct
  // `node --use-env-proxy src/service.mjs ...` invocation would otherwise lose
  // its CLI-only opt-in before the platform renderer can persist it.
  const childEnvironment = {
    ...process.env,
    ...(environmentProxyOptedIn() ? { NODE_USE_ENV_PROXY: "1" } : {}),
  };
  // An explicit start, restart or install is an operator decision, and the
  // automatic retry back-off must never refuse it. Clearing here rather than in
  // each platform renderer is what makes that true on every host: the Windows
  // renderer also clears before its own /Run, but the macOS and Linux renderers
  // had no equivalent, so an operator's restart could be gated on the machine
  // that is not Windows.
  if (mutatingCommands.has(command)) {
    try {
      clearStartupAttempts();
    } catch (error) {
      // A record that cannot be removed must not stop the operator's command;
      // this same command and the kill switch both remain available.
      console.error(
        "[model-router] warning: could not clear the startup back-off record: " +
          `${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  // Synchronous service renderers can own grandchildren. Do not apply a
  // direct-child timeout here: it could orphan those descendants and let them
  // mutate the service after the UI reports failure. The outer desktop runner
  // owns process-tree termination; this preflight and the readiness wait keep
  // every cooperative phase on the shared inner deadline.
  const platformBudgetMs = remainingOperationMs();
  if (
    platformBudgetMs !== undefined
    && platformBudgetMs < PLATFORM_COMMAND_RESERVE_MS + READINESS_TIMEOUT_MS
  ) {
    throw new Error(
      "The service operation deadline cannot preserve its platform and 300-second readiness allowances.",
    );
  }
  const result = spawnSync(
    process.execPath,
    [path.join(SOURCE_ROOT, "src", script), ...args],
    { stdio: "inherit", env: childEnvironment },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) return result.status ?? 1;
  // A server that was already running is external and stopManagedOllama() is
  // a no-op. Only the exact detached `ollama serve` process this router
  // started is coupled to an explicit router shutdown. Installs and restarts
  // deliberately keep it alive across the brief service handoff.
  if (shutdownCommands.has(command)) await stopManagedOllama();
  if (!readinessCommands.has(command)) return 0;

  const readinessBudgetMs = remainingOperationMs();
  if (readinessBudgetMs < READINESS_TIMEOUT_MS) {
    throw new Error(
      "The service operation deadline did not preserve the full 300-second router readiness allowance.",
    );
  }
  const health = await waitForServiceReadiness({
    timeoutMs: READINESS_TIMEOUT_MS,
    // Only the Linux service manager exposes an automatic-restart counter
    // this guard can read; Windows readiness carries its own task-state
    // guard, and launchd has no equivalent counter.
    ...(script === "service-linux.mjs"
      ? {
          // The readiness guard passes whatever budget it has left, so the
          // fixed slice below can never stretch the wait past its deadline.
          getServiceRestarts: (remainingMs) => {
            if (!(remainingMs > 0)) return undefined;
            const counter = spawnSync(
              process.execPath,
              [path.join(SOURCE_ROOT, "src", script), "restart-count"],
              {
                encoding: "utf8",
                env: childEnvironment,
                timeout: Math.min(RESTART_QUERY_TIMEOUT_MS, remainingMs),
                killSignal: "SIGKILL",
              },
            );
            if (counter.error || counter.status !== 0) return undefined;
            try {
              const parsed = JSON.parse(counter.stdout);
              return typeof parsed.restarts === "number" ? parsed.restarts : undefined;
            } catch {
              return undefined;
            }
          },
        }
      : {}),
  }).catch((error) => {
    // A crash loop or a dead launcher is broken and keeps rejecting, so the
    // caller's rollback still runs for it. Only the "still starting" timeout
    // is converted into a status, because the service it installed is
    // genuinely there and working towards health.
    if (error?.readinessTimeout !== true) throw error;
    return { ok: false, readinessTimeout: true, error: error.message };
  });
  if (health.ok) return 0;
  if (health.readinessTimeout) {
    // Distinct from 1 so an installer can tell "the service is installed and
    // still starting" from "the install failed". Uninstalling here deletes a
    // registered task and its launchers out from under a router that goes on
    // to come up seconds later -- which is what left #760's reporter with a
    // start-codex-router.cmd that the install had correctly written.
    console.error(
      `Router did not become healthy within ${READINESS_TIMEOUT_MS / 1_000} seconds: ${health.error}`,
    );
    console.error(
      "The background service is installed and still starting. Leave it in place and check `service status`; a first cold start with a large model set can exceed this wait.",
    );
    return READINESS_TIMEOUT_EXIT_CODE;
  }
  console.error(
    `Router did not become healthy within ${READINESS_TIMEOUT_MS / 1_000} seconds: ${health.error}`,
  );
  return 1;
}

export async function runServiceCli(args = process.argv.slice(2)) {
  const command = args[0] || "status";
  const commandArgs = args.length ? args : [command];
  return mutatingCommands.has(command)
    ? withServiceOperationLock(() => runServiceCommandUnlocked(command, commandArgs))
    : runServiceCommandUnlocked(command, commandArgs);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exit(await runServiceCli());
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
