import path from "node:path";

import { SOURCE_ROOT } from "./paths.mjs";
import {
  operationDeadlineFromEnvironment,
  remainingOperationMs,
  runOperationProcessTree,
  runProcessTree,
} from "./process-tree.mjs";
import { waitForRouterHealth } from "./router-health.mjs";
import { childNodeBinary } from "./stable-node.mjs";

const SERVICE_SCRIPT = path.join(SOURCE_ROOT, "src", "service.mjs");
const SERVICE_STATUS_OPERATION_MS = 10_000;
const SERVICE_PROCESS_OWNER_RESERVE_MS = 10_000;
const SERVICE_PLATFORM_COMMAND_RESERVE_MS = 10_000;
const SERVICE_READINESS_ALLOWANCE_MS = 300_000;
export const ROUTER_SERVICE_RESTART_MINIMUM_MS =
  SERVICE_STATUS_OPERATION_MS
  + SERVICE_PROCESS_OWNER_RESERVE_MS
  + SERVICE_PLATFORM_COMMAND_RESERVE_MS
  + SERVICE_READINESS_ALLOWANCE_MS;
export const ROUTER_SERVICE_RESTART_OPERATION_MS =
  ROUTER_SERVICE_RESTART_MINIMUM_MS + 1_000;
const SERVICE_RESTART_PHASE_MINIMUM_MS =
  SERVICE_PROCESS_OWNER_RESERVE_MS
  + SERVICE_PLATFORM_COMMAND_RESERVE_MS
  + SERVICE_READINESS_ALLOWANCE_MS;

function serviceOperationDeadline(deadline, env) {
  const boundedEnvironment = Number.isSafeInteger(deadline)
    ? { ...env, CODEX_ROUTER_OPERATION_DEADLINE_MS: String(deadline) }
    : env;
  return operationDeadlineFromEnvironment(boundedEnvironment, {
    timeoutMs: ROUTER_SERVICE_RESTART_OPERATION_MS,
    maximumMs: ROUTER_SERVICE_RESTART_OPERATION_MS,
  });
}

function serviceStatusDeadline(deadline, env) {
  const boundedEnvironment = Number.isSafeInteger(deadline)
    ? { ...env, CODEX_ROUTER_OPERATION_DEADLINE_MS: String(deadline) }
    : env;
  return operationDeadlineFromEnvironment(boundedEnvironment, {
    timeoutMs: SERVICE_STATUS_OPERATION_MS,
    maximumMs: SERVICE_STATUS_OPERATION_MS,
  });
}

export function routerServiceRestartCommand(platform = process.platform) {
  return platform === "win32"
    ? "node .\\src\\control.mjs service restart"
    : "./bin/control service restart";
}

function assertOperationActive(signal, deadline) {
  if (signal?.aborted) {
    throw signal.reason instanceof Error
      ? signal.reason
      : new Error("The router operation was aborted.");
  }
  remainingOperationMs(deadline, signal, {
    message: "The router operation deadline expired before service readiness completed.",
  });
}

function assertOperationAllowance(signal, deadline, minimumMs, message) {
  const remaining = remainingOperationMs(deadline, signal, { message });
  if (remaining !== undefined && remaining < minimumMs) {
    const error = new Error(message);
    error.code = "router_operation_timeout";
    throw error;
  }
}

async function invokeService(
  args,
  {
    spawn,
    env,
    signal,
    deadline,
    stdio = "capture",
    childOwnsOperations = true,
  },
) {
  const run = spawn
    ? async (command, commandArgs, options) => spawn(command, commandArgs, {
      ...options,
      encoding: "utf8",
      ...(stdio === "inherit" ? { stdio: "inherit" } : {}),
    })
    : runProcessTree;
  const options = {
    cwd: SOURCE_ROOT,
    env,
    signal,
    deadline,
    stdio,
  };
  // Restarts also come from workers that can outlive a Node upgrade (a model
  // download, a curation transaction), and `brew upgrade node` deletes the keg
  // this process runs from, so name a Node that is still there.
  const node = childNodeBinary({ environment: env ?? process.env });
  return childOwnsOperations
    ? runOperationProcessTree(node, [SERVICE_SCRIPT, ...args], { ...options, run })
    : run(node, [SERVICE_SCRIPT, ...args], options);
}

export async function routerServiceStatus({
  spawn,
  env = process.env,
  signal,
  deadline,
} = {}) {
  const operationDeadline = serviceStatusDeadline(deadline, env);
  assertOperationActive(signal, operationDeadline);
  const result = await invokeService(["status"], {
    spawn,
    env,
    signal,
    deadline: operationDeadline,
    childOwnsOperations: false,
  });
  assertOperationActive(signal, operationDeadline);
  if (result.error || result.status !== 0) {
    return { installed: false, statusUnknown: true };
  }
  try {
    const parsed = JSON.parse(result.stdout);
    if (
      typeof parsed?.installed !== "boolean" ||
      typeof parsed?.loaded !== "boolean" ||
      typeof parsed?.state !== "string"
    ) {
      return { installed: false, statusUnknown: true };
    }
    return {
      installed: parsed.installed,
      loaded: parsed.loaded,
      state: parsed.state,
    };
  } catch {
    return { installed: false, statusUnknown: true };
  }
}

function environmentMutationError(message) {
  const error = new Error(message);
  error.code = "provider_api_key_pool_service_environment_stale";
  return error;
}

export async function environmentPoolMutationServiceStatus({
  spawn,
  env = process.env,
  waitForHealth = waitForRouterHealth,
  signal,
  deadline,
} = {}) {
  const status = await routerServiceStatus({ spawn, env, signal, deadline });
  if (status.statusUnknown) {
    throw environmentMutationError(
      "Cannot safely add an environment-backed API-key pool entry because the background service state could not be verified. " +
        "Repair or stop the service, then retry; publishing while ownership is unknown could expose a route that cannot authenticate.",
    );
  }
  if (status.loaded) {
    throw environmentMutationError(
      "Cannot add an environment-backed API-key pool entry while the managed router service is running. " +
        "Stop the service, repeat the command with every pooled variable set, then rerun the installer; " +
        "a restart alone does not rewrite the service environment.",
    );
  }

  let health;
  try {
    health = await waitForHealth({ timeoutMs: 0, requestTimeoutMs: 1_000 });
  } catch {
    health = { ok: false };
  }
  const liveRouter = health?.ok === true || health?.degradedPayload?.service === "codex-router";
  if (liveRouter) {
    throw environmentMutationError(
      "Cannot add an environment-backed API-key pool entry while a live router process is already serving. " +
        "Stop the foreground router, repeat the command from the environment containing every pooled variable, then start it again.",
    );
  }
  if (health?.connectionRefused !== true) {
    throw environmentMutationError(
      "Cannot safely add an environment-backed API-key pool entry because the router process state could not be verified. " +
        "Stop or repair the router, then retry; only a confirmed empty loopback port is safe to publish against.",
    );
  }
  return {
    ...status,
    serviceReinstallRequired: status.installed === true,
  };
}

export function environmentPoolRemovalReminder(status) {
  if (status?.installed === true) {
    return (
      "Environment-backed pool metadata removed. Rerun the installer to remove the retired secret " +
      "from the managed service definition; a service restart alone replays the old definition.\n"
    );
  }
  if (status?.statusUnknown) {
    return (
      "Environment-backed pool metadata removed. Background service status could not be verified; " +
      "if one is installed, rerun the installer to remove the retired secret from its definition; " +
      "a restart alone may replay the old definition.\n"
    );
  }
  if (status?.loaded === true) {
    return (
      "Environment-backed pool metadata removed. Stop and restart the loaded router process to " +
      "drop the retired variable from its inherited environment.\n"
    );
  }
  return (
    "Environment-backed pool metadata removed. Restart any foreground router to drop the retired " +
    "variable from its process environment.\n"
  );
}

export async function restartRouterServiceIfInstalled({
  spawn,
  env = process.env,
  signal,
  deadline,
} = {}) {
  const operationDeadline = serviceOperationDeadline(deadline, env);
  if (!(await routerServiceStatus({
    spawn,
    env,
    signal,
    deadline: operationDeadline,
  })).installed) return false;
  assertOperationAllowance(
    signal,
    operationDeadline,
    SERVICE_RESTART_PHASE_MINIMUM_MS,
    "The service operation deadline cannot preserve the full router readiness allowance.",
  );
  const result = await invokeService(["restart"], {
    spawn,
    env,
    signal,
    deadline: operationDeadline,
    stdio: "inherit",
  });
  assertOperationActive(signal, operationDeadline);
  if (result.error || result.status !== 0) {
    throw new Error(
      "The router service could not be restarted; routes requiring fresh process state " +
        `will not go live until it is. Retry with \`${routerServiceRestartCommand()}\`.`,
    );
  }
  return true;
}
