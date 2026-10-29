import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  isLocalModelEnabled,
  LOCAL_MODELS_STATE_PATH,
  setLocalModelEnabled,
} from "./local-models.mjs";
import {
  readLocalDownload,
  writeLocalDownload,
} from "./local-download.mjs";
import { normalizeLocalModelTag } from "./local-model-ref.mjs";
import { processStartIdentity } from "./process-identity.mjs";
import { ollamaCommand } from "./ollama-runtime.mjs";
import {
  aggregateRollbackError,
  applyModelOverlayPublication,
  captureModelOverlayFiles,
  restoreModelOverlayFiles,
  restorePublishedModelOverlay,
  transactModelOverlayMutation,
} from "./model-overlay-publication.mjs";
import { withModelOverlayLock } from "./model-overlay-lock.mjs";
import { PROVIDER_SELECTION_PATH } from "./paths.mjs";
import { USER_MODELS_PATH } from "./user-models.mjs";

const SELF = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(SELF), "..");

export function removeLocalModelFromDisk(
  tag,
  {
    spawn = spawnSync,
    command = ollamaCommand() || "ollama",
  } = {},
) {
  const result = spawn(command, ["rm", tag], { encoding: "utf8" });
  if (result?.error) throw result.error;
  if (result?.status !== 0) {
    const detail = String(result?.stderr || "").trim();
    throw new Error(`\`ollama rm ${tag}\` failed${detail ? `: ${detail}` : "."}`);
  }
  return tag;
}

export async function uninstallLocalModelTransaction(
  tag,
  {
    enabled = isLocalModelEnabled,
    disable = (model) => setLocalModelEnabled(model, false),
    remove = removeLocalModelFromDisk,
    capture = () => captureModelOverlayFiles([
      LOCAL_MODELS_STATE_PATH,
      USER_MODELS_PATH,
      PROVIDER_SELECTION_PATH,
    ]),
    restoreFiles = restoreModelOverlayFiles,
    applyPublication = applyModelOverlayPublication,
    restartService,
    cancelled = () => false,
  } = {},
) {
  return withModelOverlayLock(async () => {
    // The enabled decision and snapshot must be made after acquiring the
    // process-wide lock. This operation keeps the lock through physical
    // removal as well, because a failed `ollama rm` must not restore a stale
    // overlay over another process's successful selection.
    const wasEnabled = enabled(tag);
    const snapshots = await capture();
    const restore = () => restoreFiles(snapshots);
    await transactModelOverlayMutation({
      lock: false,
      mutate: () => disable(tag),
      restore,
      restart: wasEnabled,
      applyPublication,
      restartService,
    });
    if (cancelled()) {
      await restorePublishedModelOverlay({
        restore,
        restart: wasEnabled,
        applyPublication,
        restartService,
      });
      return { cancelled: true, removed: false, wasEnabled };
    }

    try {
      remove(tag);
    } catch (operationError) {
      try {
        await restorePublishedModelOverlay({
          restore,
          restart: wasEnabled,
          applyPublication,
          restartService,
        });
      } catch (rollbackError) {
        throw aggregateRollbackError(operationError, rollbackError);
      }
      throw operationError;
    }
    return { cancelled: false, removed: true, wasEnabled };
  });
}

async function main() {
  const tag = normalizeLocalModelTag(process.argv[2]);
  const startedAt = Date.now();
  const existing = readLocalDownload();
  if (existing?.status === "cancelled") return;
  const workerIdentity = processStartIdentity(process.pid);

  writeLocalDownload({
    version: 1,
    kind: "uninstall",
    tag,
    status: "uninstalling",
    detail: "Withdrawing model route before removal",
    percent: 0,
    startedAt,
    updatedAt: startedAt,
    controllerPid: null,
    workerPid: process.pid,
    workerIdentity,
  });

  try {
    const removal = await uninstallLocalModelTransaction(tag, {
      cancelled: () => readLocalDownload()?.status === "cancelled",
    });
    if (removal.cancelled) return;

    const finalized = spawnSync(
      process.execPath,
      [path.join(REPO_ROOT, "src", "control.mjs"), "local-models", "finalize-uninstall", tag],
      {
        cwd: REPO_ROOT,
        env: { ...process.env, MODEL_ROUTER_TARGET: "codex" },
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        windowsHide: true,
      },
    );
    let publication = {};
    if (typeof finalized.stdout === "string" && finalized.stdout.trim()) {
      try {
        publication = JSON.parse(finalized.stdout.trim());
      } catch {
        // A successful removal is still truthful even if a future control
        // build adds human-readable output around the finalization JSON.
      }
    }
    const catalogError = publication.catalogError || (
      finalized.error || finalized.status !== 0
        ? "The model was removed, but the Codex catalog could not be refreshed."
        : undefined
    );
    const restartError = publication.restartError;
    const detail = catalogError
      ? "Model removed · catalog refresh needed"
      : restartError
        ? "Model removed · router restart needed"
        : "Model removed";
    writeLocalDownload({
      ...readLocalDownload(),
      version: 1,
      kind: "uninstall",
      tag,
      status: "done",
      detail,
      percent: 100,
      startedAt,
      updatedAt: Date.now(),
      controllerPid: null,
      workerPid: null,
      ...(catalogError ? { catalogError } : {}),
      ...(restartError ? { restartError } : {}),
      error: undefined,
    });
  } catch (error) {
    writeLocalDownload({
      ...readLocalDownload(),
      version: 1,
      kind: "uninstall",
      tag,
      status: "error",
      detail: "Removal failed",
      percent: 0,
      startedAt,
      updatedAt: Date.now(),
      controllerPid: null,
      workerPid: process.pid,
      error: error instanceof Error ? error.message : String(error),
    });
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === SELF) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
