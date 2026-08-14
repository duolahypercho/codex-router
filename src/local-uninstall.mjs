import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { removeLocalModel } from "./local-models.mjs";
import {
  readLocalDownload,
  writeLocalDownload,
} from "./local-download.mjs";
import { normalizeLocalModelTag } from "./local-model-ref.mjs";

const SELF = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(SELF), "..");

async function main() {
  const tag = normalizeLocalModelTag(process.argv[2]);
  const startedAt = Date.now();
  const existing = readLocalDownload();
  if (existing?.status === "cancelled") return;

  writeLocalDownload({
    version: 1,
    kind: "uninstall",
    tag,
    status: "uninstalling",
    detail: "Removing model from Ollama",
    percent: 0,
    startedAt,
    updatedAt: startedAt,
    controllerPid: null,
    workerPid: process.pid,
  });

  try {
    removeLocalModel(tag, { confirmed: true });
    if (readLocalDownload()?.status === "cancelled") return;

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
      workerPid: process.pid,
      ...(catalogError ? { catalogError } : {}),
      ...(restartError ? { restartError } : {}),
      error: undefined,
    });
  } catch (error) {
    if (readLocalDownload()?.status === "cancelled") return;
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
