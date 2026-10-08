import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { protectPrivateFile } from "./file-security.mjs";
import { withModelOverlayLock } from "./model-overlay-lock.mjs";
import { routerNodeBinary } from "./node-runtime.mjs";
import {
  ROUTER_SERVICE_RESTART_MINIMUM_MS,
  ROUTER_SERVICE_RESTART_OPERATION_MS,
} from "./router-restart.mjs";
import {
  contractOperationDeadline,
  operationDeadlineFromEnvironment,
  remainingOperationMs,
  runDuringOwnerSignalCleanup,
  runOperationProcessTree,
  runProcessTree,
  withOwnerSignalExitBarrier,
} from "./process-tree.mjs";

const SELF = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(SELF), "..");
const CHILD_ARGUMENT = "--publish-in-fresh-process";
const OVERLAY_PUBLISH_OPERATION_MS = 5 * 60_000;
// Publishing and restarting are sequential. Reserve the restart's complete
// status/owner/platform/readiness envelope plus handoff margin instead of
// handing both phases the same nominal five-minute parent deadline.
const OVERLAY_SERVICE_RESTART_RESERVE_MS =
  ROUTER_SERVICE_RESTART_OPERATION_MS + 9_000;
const OVERLAY_RESTARTING_PUBLICATION_MS =
  OVERLAY_PUBLISH_OPERATION_MS + OVERLAY_SERVICE_RESTART_RESERVE_MS;
const OVERLAY_RESTARTING_PUBLICATION_MINIMUM_MS =
  OVERLAY_PUBLISH_OPERATION_MS + ROUTER_SERVICE_RESTART_MINIMUM_MS;
const DEFAULT_OVERLAY_TRANSACTION_MS = 2 * OVERLAY_RESTARTING_PUBLICATION_MS;
const MAX_OVERLAY_TRANSACTION_MS = DEFAULT_OVERLAY_TRANSACTION_MS;

function overlayPublicationDeadline(
  deadline,
  environment = process.env,
  { restart = false } = {},
) {
  const boundedEnvironment = Number.isSafeInteger(deadline)
    ? { ...environment, CODEX_ROUTER_OPERATION_DEADLINE_MS: String(deadline) }
    : environment;
  const maximumMs = restart
    ? OVERLAY_RESTARTING_PUBLICATION_MS
    : OVERLAY_PUBLISH_OPERATION_MS;
  return operationDeadlineFromEnvironment(boundedEnvironment, {
    timeoutMs: maximumMs,
    maximumMs,
  });
}

function overlayTransactionDeadline(deadline, environment = process.env) {
  const boundedEnvironment = Number.isSafeInteger(deadline)
    ? { ...environment, CODEX_ROUTER_OPERATION_DEADLINE_MS: String(deadline) }
    : environment;
  return operationDeadlineFromEnvironment(boundedEnvironment, {
    timeoutMs: DEFAULT_OVERLAY_TRANSACTION_MS,
    maximumMs: MAX_OVERLAY_TRANSACTION_MS,
  });
}

function overlayRollbackDeadline(restart) {
  // This epoch deliberately ignores both caller cancellation and the caller's
  // absolute deadline. Forward work was contracted before mutation to leave
  // room for it, but an uncooperative mutation or a late thrown error must not
  // turn an already-expired caller epoch into an immediate rollback failure.
  return operationDeadlineFromEnvironment({}, {
    timeoutMs: restart
      ? OVERLAY_RESTARTING_PUBLICATION_MS
      : OVERLAY_PUBLISH_OPERATION_MS,
    maximumMs: restart
      ? OVERLAY_RESTARTING_PUBLICATION_MS
      : OVERLAY_PUBLISH_OPERATION_MS,
  });
}

function assertRestartingPublicationAllowance(deadline, signal) {
  const remaining = remainingOperationMs(deadline, signal, {
    message: "The model-overlay deadline cannot preserve publication and router readiness.",
  });
  if (
    remaining !== undefined
    && remaining < OVERLAY_RESTARTING_PUBLICATION_MINIMUM_MS
  ) {
    const error = new Error(
      "The model-overlay deadline cannot preserve publication and the full router readiness allowance.",
    );
    error.code = "router_operation_timeout";
    throw error;
  }
}

function assertServiceRestartAllowance(deadline, signal) {
  const remaining = remainingOperationMs(deadline, signal, {
    message: "The model-overlay deadline cannot preserve router readiness.",
  });
  if (
    remaining !== undefined
    && remaining < ROUTER_SERVICE_RESTART_MINIMUM_MS
  ) {
    const error = new Error(
      "The model-overlay deadline cannot preserve the full router readiness allowance.",
    );
    error.code = "router_operation_timeout";
    throw error;
  }
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function asError(error) {
  return error instanceof Error ? error : new Error(String(error));
}

// JSON-serializable on purpose: a detached uninstall worker can carry the
// pre-withdrawal state in its protected progress document if a caller needs to
// hand the transaction across a process boundary.
export function captureModelOverlayFiles(
  files,
  {
    exists = existsSync,
    read = readFileSync,
  } = {},
) {
  return [...new Set(files.map((file) => path.resolve(file)))].map((file) => {
    const existed = exists(file);
    return {
      path: file,
      existed,
      contents: existed ? Buffer.from(read(file)).toString("base64") : null,
    };
  });
}

export function restoreModelOverlayFiles(
  snapshots,
  {
    exists = existsSync,
    mkdir = mkdirSync,
    write = writeFileSync,
    chmod = chmodSync,
    protect = protectPrivateFile,
    unlink = unlinkSync,
  } = {},
) {
  for (const snapshot of snapshots) {
    if (!snapshot?.path || !path.isAbsolute(snapshot.path)) {
      throw new Error("A model-overlay snapshot has no absolute path.");
    }
    if (!snapshot.existed) {
      if (exists(snapshot.path)) unlink(snapshot.path);
      continue;
    }
    mkdir(path.dirname(snapshot.path), { recursive: true, mode: 0o700 });
    write(snapshot.path, Buffer.from(snapshot.contents || "", "base64"), { mode: 0o600 });
    chmod(snapshot.path, 0o600);
    // chmod is the complete privacy boundary on POSIX, but it does not remove
    // inherited ACLs on Windows. A rollback can recreate a file that was
    // deleted during the failed mutation, so apply the same owner-only ACL
    // protection as every normal private-state write.
    protect(snapshot.path);
  }
  return snapshots;
}

/**
 * Rebuild the shared routing plane, then every installed client's model list.
 *
 * This is exported for dependency-injected tests and for the fresh child below.
 * Callers that have already loaded model-registry.mjs must use
 * publishModelOverlayFresh(): user-model overlays are read at module load, so
 * rebuilding in their process can silently publish the pre-mutation model set.
 */
export async function rebuildModelOverlayPublication({
  writeGateway,
  refreshTargets,
  signal,
  deadline,
} = {}) {
  const write = writeGateway ||
    (await import("./litellm-config.mjs")).writeLiteLlmConfig;
  const refresh = refreshTargets ||
    (await import("./target-integration.mjs")).refreshTargetPickerIfInstalled;

  const operationDeadline = overlayPublicationDeadline(deadline);
  remainingOperationMs(operationDeadline, signal);
  const gatewayPath = write();
  remainingOperationMs(operationDeadline, signal);
  const targetsRefreshed = await refresh({ signal, deadline: operationDeadline });
  return { gatewayPath, targetsRefreshed };
}

/**
 * Publish from a new Node process so the registry observes the overlay that was
 * just committed to disk. The child also provides one fail-closed ordering
 * point: the gateway is written before any Codex, DSH, or Gemini publication.
 */
export async function publishModelOverlayFresh({
  run = runProcessTree,
  sourceRoot = REPO_ROOT,
  environment = process.env,
  executable = routerNodeBinary(environment),
  signal,
  deadline,
} = {}) {
  const operationDeadline = overlayPublicationDeadline(deadline, environment);
  const result = await runOperationProcessTree(executable, [SELF, CHILD_ARGUMENT], {
    cwd: sourceRoot,
    env: environment,
    childEnvironment: {
      MODEL_ROUTER_TARGET: "codex",
    },
    signal,
    deadline: operationDeadline,
    run,
    encoding: "utf8",
    windowsHide: true,
  });
  if (result?.status !== 0) {
    const detail = String(result?.stderr || "").trim();
    throw new Error(detail || "The shared model routes could not be published.");
  }
  return { published: true };
}

/**
 * Complete publication and, when requested, reload the installed router.
 *
 * A synchronous toggle is fail-closed: its publication or restart error is
 * thrown. A download/removal has already changed physical state, so its caller
 * asks for warningOnly and receives the same catalogError/restartError fields
 * the existing progress surfaces understand instead of a false operation
 * failure.
 */
export async function applyModelOverlayPublication({
  warningOnly = false,
  restart = false,
  publish = publishModelOverlayFresh,
  restartService,
  signal,
  deadline,
} = {}) {
  const operationDeadline = overlayPublicationDeadline(deadline, process.env, { restart });
  const warnings = {};
  try {
    let publishDeadline = operationDeadline;
    if (restart) {
      assertRestartingPublicationAllowance(operationDeadline, signal);
      publishDeadline = contractOperationDeadline(operationDeadline, {
        reserveMs: OVERLAY_SERVICE_RESTART_RESERVE_MS,
        message: "The model-overlay publication has no remaining service-restart epoch.",
      });
    } else remainingOperationMs(operationDeadline, signal);
    await publish({ signal, deadline: publishDeadline });
  } catch (error) {
    if (!warningOnly) throw error;
    warnings.catalogError = errorMessage(error);
    // A restart is the commit point for the running service. Do not load an
    // overlay whose gateway/client publication did not finish; the completed
    // physical operation remains truthful and its warning tells the operator
    // that publication (and therefore restart) is still needed.
    return warnings;
  }

  if (restart) {
    try {
      const reload = restartService || (async (operation) => {
        const { restartRouterServiceIfInstalled } = await import("./router-restart.mjs");
        return restartRouterServiceIfInstalled(operation);
      });
      assertServiceRestartAllowance(operationDeadline, signal);
      await reload({ signal, deadline: operationDeadline });
    } catch (error) {
      if (!warningOnly) throw error;
      warnings.restartError = errorMessage(error);
    }
  }
  return warnings;
}

export async function restorePublishedModelOverlay({
  restore,
  restart = false,
  warningOnly = false,
  applyPublication = applyModelOverlayPublication,
  restartService,
  signal,
  deadline,
} = {}) {
  const operationDeadline = overlayPublicationDeadline(deadline, process.env, { restart });
  // The durable overlay snapshot is the transaction's source of truth. Always
  // restore it first, even when forward publication consumed the remaining
  // budget; the best-effort client/gateway republish below may then report an
  // aggregated deadline failure without leaving the failed mutation on disk.
  await restore();
  remainingOperationMs(operationDeadline, signal);
  await applyPublication({
    restart,
    restartService,
    warningOnly,
    signal,
    deadline: operationDeadline,
  });
}

export function aggregateRollbackError(operationError, rollbackError) {
  return new AggregateError(
    [asError(operationError), asError(rollbackError)],
    "The model-overlay operation failed and its previous state could not be fully restored.",
    { cause: asError(operationError) },
  );
}

/**
 * Mutate state, publish it, and restart only after publication succeeds.
 * Any failure restores the exact prior state and republishes/restarts that
 * state. The original error is preserved when rollback succeeds; an
 * AggregateError makes a failed rollback impossible to mistake for success.
 */
export async function transactModelOverlayMutation({
  files,
  capture,
  mutate,
  restore,
  restart = false,
  warningOnly = false,
  applyPublication = applyModelOverlayPublication,
  restartService,
  lock = true,
  signal,
  deadline,
} = {}) {
  const operationDeadline = overlayTransactionDeadline(deadline);
  const transaction = async () => {
    // Capture only after the cross-process lock is held. Capturing before the
    // lock lets a queued operation retain a stale snapshot and roll back a
    // later successful mutation when its own publication fails.
    const snapshots = capture
      ? await capture()
      : files
        ? captureModelOverlayFiles(files)
        : undefined;
    const restoreState = snapshots === undefined
      ? restore
      : (nextSnapshots = snapshots) => restore
        ? restore(nextSnapshots)
        : restoreModelOverlayFiles(nextSnapshots);

    const restartRequested = typeof restart === "function" ? await restart() : restart;
    const rollbackReserveMs = restartRequested
      ? OVERLAY_RESTARTING_PUBLICATION_MS
      : OVERLAY_PUBLISH_OPERATION_MS;
    // Restart-bearing forward and rollback phases each own a complete
    // five-minute publication budget followed by a complete service-restart
    // budget. Contract the caller before mutation, never after it has changed
    // durable state.
    const forwardDeadline = contractOperationDeadline(operationDeadline, {
      reserveMs: rollbackReserveMs,
      message: "The model-overlay operation has no remaining semantic rollback epoch.",
    });
    if (restartRequested) {
      assertRestartingPublicationAllowance(forwardDeadline, signal);
    }
    return withOwnerSignalExitBarrier(async (ownerSignal) => {
      const forwardSignal = signal
        ? AbortSignal.any([signal, ownerSignal])
        : ownerSignal;
      try {
        remainingOperationMs(forwardDeadline, forwardSignal);
        await mutate();
        remainingOperationMs(forwardDeadline, forwardSignal);
        return await applyPublication({
          restart: restartRequested,
          restartService,
          warningOnly,
          signal: forwardSignal,
          deadline: forwardDeadline,
        });
      } catch (operationError) {
        try {
          if (!restoreState) throw new Error("A model-overlay transaction has no rollback state.");
          const rollbackDeadline = overlayRollbackDeadline(restartRequested);
          await runDuringOwnerSignalCleanup(() => restorePublishedModelOverlay({
            restore: restoreState,
            restart: restartRequested,
            // Forward warning-only publication is appropriate only after an
            // irreversible physical operation. Rollback is the consistency
            // boundary and must never turn a failed republish/restart into a
            // warning that lets divergent durable and running state pass.
            warningOnly: false,
            applyPublication,
            restartService,
            signal: undefined,
            deadline: rollbackDeadline,
          }));
        } catch (rollbackError) {
          throw aggregateRollbackError(operationError, rollbackError);
        }
        throw operationError;
      }
    }, {
      // A received owner signal may interrupt forward publication immediately.
      // Keep the process alive long enough for the independent rollback epoch
      // plus its child-tree cleanup margin, without extending normal callers.
      timeoutMs: rollbackReserveMs + 10_000,
    });
  };
  return lock ? withModelOverlayLock(transaction) : transaction();
}

if (process.argv[1] && path.resolve(process.argv[1]) === SELF) {
  if (process.argv[2] !== CHILD_ARGUMENT) {
    console.error(`Usage: node ${path.basename(SELF)} ${CHILD_ARGUMENT}`);
    process.exit(2);
  }
  try {
    const result = await rebuildModelOverlayPublication();
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    console.error(errorMessage(error));
    process.exit(1);
  }
}
