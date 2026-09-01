import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { assertCallerSecret, callerBaseUrl, redactCallerUrl } from "./caller-auth.mjs";
import {
  callerCapabilityBackupPath,
  discardCallerCapabilityBackup,
  restoreCallerCapability,
  swapCallerCapability,
} from "./caller-key-rotation.mjs";
import {
  beginCallerKeyRotationJournal,
  clearCallerKeyRotationJournal,
  readCallerKeyRotationJournal,
  updateCallerKeyRotationJournal,
} from "./caller-key-rotation-journal.mjs";
import { withCallerKeyRotationLock } from "./caller-key-rotation-lock.mjs";
import { withModelOverlayLock } from "./model-overlay-lock.mjs";
import { withLoginFreeRefreshLock } from "./login-free-refresh-lock.mjs";
import { privateFileIsProtected } from "./file-security.mjs";
import { withServiceOperationLock } from "./service-operation-lock.mjs";
import { runServiceCommandUnlocked } from "./service.mjs";
import { CALLER_SECRET_PATH, PORTS } from "./paths.mjs";
import { assertStateOwnership } from "./state-owner.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const refreshCommand = Object.freeze({
  codex: ["src/config-manager.mjs", ["caller-capability-refresh"]],
  dsh: ["src/dsh-config-manager.mjs", ["caller-capability-refresh"]],
  gemini: ["src/gemini-config-manager.mjs", ["caller-capability-refresh"]],
  openclaw: ["src/openclaw-config-manager.mjs", ["caller-capability-refresh"]],
});

function secretDigest(secret) {
  return createHash("sha256").update(secret).digest("hex");
}

function partialClient(label) {
  throw new Error(`Refusing caller capability rotation while ${label} has partial managed state; run its doctor/repair path first.`);
}

export function installedTargetsFromStatus({ codex = {}, dsh = {}, gemini = {}, openclaw = {} } = {}) {
  const targets = [];
  const codexStatePresent = codex.provider_mode_state_present === true || codex.signed_provider_state_present === true;
  const codexManagedArtifacts = codex.managed_router_artifacts_present === true;
  if (codex.mode === "router") {
    if (codex.config_protected !== true) partialClient("Codex");
    if (codex.provider_mode_state_present && !codex.login_free_managed) partialClient("Codex");
    if (codex.signed_provider_state_present && !codex.signed_routing_managed) partialClient("Codex");
    targets.push("codex");
  } else if (codexStatePresent || codexManagedArtifacts) {
    partialClient("Codex");
  }

  const dshRoute = dsh.routeInstalled === true;
  const dshCredential = dsh.credentialInstalled === true;
  if (dshRoute !== dshCredential) partialClient("DeepSeek Harness");
  if (dshRoute) targets.push("dsh");

  const geminiCatalog = gemini.installed === true;
  const geminiBase = gemini.baseUrlManaged === true;
  const geminiBlock = gemini.managedBlockPresent === true;
  const geminiManagedEvidence = geminiCatalog || geminiBase || geminiBlock;
  if (geminiManagedEvidence) {
    if (
      !geminiCatalog ||
      !geminiBase ||
      !geminiBlock ||
      gemini.envExists !== true ||
      gemini.documentReadable !== true ||
      (Array.isArray(gemini.conflicts) && gemini.conflicts.length)
    ) {
      partialClient("Gemini");
    }
    targets.push("gemini");
  }

  const openclawEvidence = openclaw.installed === true || openclaw.providerInstalled === true;
  if (openclawEvidence) {
    if (
      openclaw.installed !== true ||
      openclaw.providerInstalled !== true ||
      openclaw.baseUrlManaged !== true ||
      openclaw.configValid !== true ||
      openclaw.configProtected !== true
    ) {
      partialClient("OpenClaw");
    }
    targets.push("openclaw");
  }
  return targets;
}

function commandDetail(result, fallback) {
  if (result.error) return result.error.message;
  const detail = String(result.stderr || result.stdout || "").trim();
  return detail ? redactCallerUrl(detail.slice(-2_000)) : fallback;
}

export function runNodeCommand(script, args = []) {
  const result = spawnSync(process.execPath, [path.join(ROOT, script), ...args], {
    cwd: ROOT, env: process.env, encoding: "utf8", maxBuffer: 32 * 1024 * 1024,
  });
  if (result.error || result.status !== 0) throw new Error(commandDetail(result, `${script} failed.`));
  return String(result.stdout || "");
}

function parseJsonCommand(script, args, runNode = runNodeCommand) {
  const output = runNode(script, args);
  try { return JSON.parse(String(output || "")); }
  catch { throw new Error(`${script} returned invalid status JSON.`); }
}

export async function readManagedClientStatuses({ runNode = runNodeCommand } = {}) {
  return {
    codex: parseJsonCommand("src/config-manager.mjs", ["status"], runNode),
    dsh: parseJsonCommand("src/dsh-config-manager.mjs", ["status"], runNode),
    gemini: parseJsonCommand("src/gemini-config-manager.mjs", ["status"], runNode),
    openclaw: parseJsonCommand("src/openclaw-config-manager.mjs", ["status"], runNode),
  };
}

export async function readRouterServiceStatus({ runNode = runNodeCommand } = {}) {
  return parseJsonCommand("src/service.mjs", ["status"], runNode);
}

export function managedServiceIsRunning(service) {
  if (service?.installed !== true) return false;
  // All platform status renderers expose `loaded` as the service manager's
  // process-ownership signal. Linux names that state `active`, while launchd
  // can keep a job loaded through waiting, spawning, or shutdown transitions.
  // Retain the named running states for older callers and deterministic
  // fixtures that predate the shared `loaded` field.
  return service.loaded === true || service.state === "running" || service.state === "active";
}

async function validModelList(response) {
  if (response.status !== 200) return false;
  try {
    const body = await response.json();
    return body?.object === "list" && Array.isArray(body.data);
  } catch {
    return false;
  }
}

export async function verifyCurrentCallerCapability({ currentSecret, fetchImpl = fetch }) {
  try {
    const fresh = await fetchImpl(`${callerBaseUrl(PORTS.router, currentSecret)}/models`, { signal: AbortSignal.timeout(5_000) });
    if (!(await validModelList(fresh))) throw new Error("The new caller capability did not return a valid model list.");
  } catch (error) {
    if (error instanceof Error && /caller capability|valid model list/.test(error.message)) throw error;
    throw new Error("Router caller-capability verification failed.");
  }
}

export async function verifyCallerRotation({ previousSecret, currentSecret, fetchImpl = fetch }) {
  try {
    const fresh = await fetchImpl(`${callerBaseUrl(PORTS.router, currentSecret)}/models`, { signal: AbortSignal.timeout(5_000) });
    if (!(await validModelList(fresh))) throw new Error("The new caller capability did not return a valid model list.");
    const stale = await fetchImpl(`${callerBaseUrl(PORTS.router, previousSecret)}/models`, { signal: AbortSignal.timeout(5_000) });
    if (stale.status !== 401) throw new Error("The previous caller capability was not rejected with 401.");
  } catch (error) {
    if (error instanceof Error && /caller capability|valid model list|rejected with 401/.test(error.message)) throw error;
    throw new Error("Router caller-capability verification failed.");
  }
}

async function refreshTargets(targets, runNode) {
  for (const target of targets) {
    const [script, args] = refreshCommand[target];
    await runNode(script, args);
  }
}

function currentSecret(secretPath) {
  return assertCallerSecret(readFileSync(secretPath, "utf8").trim());
}

async function withCallerMutationLocks(operation) {
  return withModelOverlayLock(() => withLoginFreeRefreshLock(operation));
}

function callerServiceLock(secretPath, override) {
  return override || ((operation) => withServiceOperationLock(operation, {
    stateDir: path.dirname(secretPath),
  }));
}

async function runRouterServiceMutationUnlocked(command) {
  const status = await runServiceCommandUnlocked(command, [command]);
  if (status !== 0) throw new Error(`Router service ${command} failed.`);
}

export async function finalizeCallerKeyRotation({ journal, secretPath = CALLER_SECRET_PATH } = {}) {
  discardCallerCapabilityBackup({ secretPath, operationId: journal.operationId });
  clearCallerKeyRotationJournal({ operationId: journal.operationId });
}

async function recoverPendingCallerKeyRotationUnlocked({
  secretPath = CALLER_SECRET_PATH,
  runNode = runNodeCommand,
  readServiceStatus = () => readRouterServiceStatus({ runNode }),
  readJournal = () => readCallerKeyRotationJournal(),
  restoreSecret = restoreCallerCapability,
  discardBackup = discardCallerCapabilityBackup,
  clearJournal = clearCallerKeyRotationJournal,
  verifyServiceKeys = verifyCallerRotation,
  verifyCurrentKey = verifyCurrentCallerCapability,
  secretIsProtected = privateFileIsProtected,
  runServiceMutation = runRouterServiceMutationUnlocked,
} = {}) {
  const journal = await readJournal();
  if (!journal) return { recovered: false };

  if (journal.phase === "verified") {
    const live = currentSecret(secretPath);
    if (journal.currentSecretSha256 && secretDigest(live) !== journal.currentSecretSha256) {
      throw new Error("Verified caller rotation journal does not match the live capability; refusing cleanup.");
    }
    if (!secretIsProtected(secretPath)) {
      throw new Error("Verified caller rotation live capability is not private; refusing cleanup.");
    }
    discardBackup({ secretPath, operationId: journal.operationId });
    clearJournal({ operationId: journal.operationId });
    return { recovered: true, committed: true };
  }

  // Prove the rollback generation before touching a running service. A corrupt
  // or unprotected rollback must fail closed without taking a healthy router
  // down merely because recovery was attempted.
  const backupPath = callerCapabilityBackupPath(secretPath, journal.operationId);
  const backupExists = existsSync(backupPath);
  let rollbackSecret;
  if (backupExists) {
    if (!secretIsProtected(backupPath)) {
      throw new Error("Pending caller rotation rollback generation is not private; refusing recovery.");
    }
    rollbackSecret = currentSecret(backupPath);
    if (secretDigest(rollbackSecret) !== journal.previousSecretSha256) {
      throw new Error("Pending caller rotation rollback generation does not match its protected journal; refusing recovery.");
    }
  } else {
    rollbackSecret = currentSecret(secretPath);
    if (secretDigest(rollbackSecret) !== journal.previousSecretSha256) {
      throw new Error("Pending caller rotation has no rollback generation matching the live capability; refusing recovery.");
    }
    if (!secretIsProtected(secretPath)) {
      throw new Error("Pending caller rotation live rollback capability is not private; refusing recovery.");
    }
  }

  // Recovery owns the service lifecycle lock, so the current state is stable
  // while we inspect it. The journal records the pre-rotation intent, but a
  // service may have been started after the crashed rotation released its locks.
  // Stop that live generation before restoring disk/client state, then preserve
  // whichever running intent is newer: the journal's original state or the
  // operator-visible state observed at recovery time.
  const service = await readServiceStatus();
  const serviceRunningAtRecovery = managedServiceIsRunning(service);
  if (serviceRunningAtRecovery) await runServiceMutation("stop");
  const shouldRunAfterRecovery = journal.serviceWasRunning || serviceRunningAtRecovery;

  let restored;
  if (backupExists) {
    restored = restoreSecret({ secretPath, operationId: journal.operationId });
    if (!restored.restored || restored.currentSecret !== rollbackSecret || !secretIsProtected(secretPath)) {
      throw new Error("Pending caller rotation could not restore a private prior capability; refusing cleanup.");
    }
  } else {
    restored = { restored: false, currentSecret: rollbackSecret };
  }

  await refreshTargets(journal.targets, runNode);
  if (shouldRunAfterRecovery) {
    await runServiceMutation("start");
    if (restored.displacedSecret && restored.displacedSecret !== restored.currentSecret) {
      await verifyServiceKeys({ previousSecret: restored.displacedSecret, currentSecret: restored.currentSecret });
    } else {
      await verifyCurrentKey({ currentSecret: restored.currentSecret });
    }
  }
  discardBackup({ secretPath, operationId: journal.operationId });
  clearJournal({ operationId: journal.operationId });
  return { recovered: true, committed: false };
}

export async function recoverPendingCallerKeyRotation(options = {}) {
  const secretPath = options.secretPath || CALLER_SECRET_PATH;
  const withServiceLock = callerServiceLock(secretPath, options.withServiceLock);
  return withServiceLock(() => recoverPendingCallerKeyRotationUnlocked({
    ...options,
    secretPath,
  }));
}

export async function runCallerKeyRotation({
  readClientStatuses = () => readManagedClientStatuses(),
  readServiceStatus = () => readRouterServiceStatus(),
  runNode = runNodeCommand,
  withLock = withCallerKeyRotationLock,
  withMutationLocks = withCallerMutationLocks,
  withServiceLock,
  recoverPending = recoverPendingCallerKeyRotationUnlocked,
  rotateSecret = swapCallerCapability,
  beginJournal = beginCallerKeyRotationJournal,
  updateJournal = updateCallerKeyRotationJournal,
  finalizeRotation = finalizeCallerKeyRotation,
  recoverAfterFailure = recoverPendingCallerKeyRotationUnlocked,
  verifyServiceKeys = verifyCallerRotation,
  runServiceMutation = runRouterServiceMutationUnlocked,
  secretPath = CALLER_SECRET_PATH,
  assertOwnership = () => assertStateOwnership("rotate the router caller capability"),
} = {}) {
  assertOwnership();
  const serviceLock = callerServiceLock(secretPath, withServiceLock);
  return withLock(() => withMutationLocks(() => serviceLock(async () => {
    await recoverPending({
      secretPath, runNode, readServiceStatus, verifyServiceKeys, runServiceMutation,
    });
    const statuses = await readClientStatuses();
    const targets = installedTargetsFromStatus(statuses);
    const service = await readServiceStatus();
    const serviceWasRunning = managedServiceIsRunning(service);
    const previousSecret = currentSecret(secretPath);
    let journal = await beginJournal({ targets, serviceWasRunning, previousSecretSha256: secretDigest(previousSecret) });
    let swapped;
    try {
      if (serviceWasRunning) {
        await runServiceMutation("stop");
        journal = await updateJournal(journal, "service-stopped");
      }
      swapped = await rotateSecret({ secretPath, operationId: journal.operationId });
      journal = await updateJournal(journal, "secret-swapped", { patch: { currentSecretSha256: secretDigest(swapped.currentSecret) } });
      await refreshTargets(targets, runNode);
      journal = await updateJournal(journal, "clients-refreshed");
      if (serviceWasRunning) {
        await runServiceMutation("start");
        journal = await updateJournal(journal, "service-started");
        await verifyServiceKeys({ previousSecret: swapped.previousSecret, currentSecret: swapped.currentSecret });
      }
      journal = await updateJournal(journal, "verified");
      await finalizeRotation({ journal, secretPath });
      return { rotated: true, targets, serviceRestarted: serviceWasRunning };
    } catch (error) {
      let recoveryError;
      try {
        await recoverAfterFailure({ secretPath, runNode, readServiceStatus, verifyServiceKeys, runServiceMutation });
      } catch (caught) {
        recoveryError = caught;
      }
      if (recoveryError) {
        throw new Error(`${error instanceof Error ? error.message : String(error)}; caller capability recovery failed: ${recoveryError.message}`, { cause: error });
      }
      throw error;
    }
  })));
}

function restartNotice(targets, serviceRestarted) {
  const notes = [];
  if (targets.includes("codex")) notes.push("Fully quit and reopen Codex before continuing existing tasks.");
  if (targets.includes("gemini")) notes.push("Restart any running Gemini CLI session.");
  if (!serviceRestarted) notes.push("The router service was not running; its prior stopped state was preserved.");
  return notes.join(" ");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const command = process.argv[2] || "status";
  if (command !== "rotate" || process.argv.length !== 3) {
    console.error("Usage: caller-key rotate");
    process.exit(2);
  }
  try {
    const result = await runCallerKeyRotation();
    process.stdout.write(`Caller capability rotated. ${restartNotice(result.targets, result.serviceRestarted)}\n`);
  } catch (error) {
    console.error(`caller-key rotate failed: ${redactCallerUrl(error instanceof Error ? error.message : String(error))}`);
    process.exit(1);
  }
}
