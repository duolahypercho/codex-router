import { spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  readFileSync,
  statSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { withAtomicStateLock } from "./atomic-state-lock.mjs";
import { writePrivateJson } from "./file-security.mjs";
import { RUNTIME_PROVIDERS } from "./model-registry.mjs";
import {
  PASSIVE_CATALOG_REFRESH_PATH,
  SOURCE_ROOT,
  TARGET,
} from "./paths.mjs";
import { detachedOperationEnvironment } from "./process-tree.mjs";

const SELF = fileURLToPath(import.meta.url);
const STATE_VERSION = 1;
const MAX_STATE_BYTES = 64 * 1024;
const MIN_CONFIGURED_DELAY_MS = 60_000;
const MAX_CONFIGURED_DELAY_MS = 7 * 24 * 60 * 60_000;

export const PASSIVE_CATALOG_REFRESH_INTERVAL_MS = 24 * 60 * 60_000;
export const PASSIVE_CATALOG_REFRESH_FAILURE_BASE_MS = 60 * 60_000;
export const PASSIVE_CATALOG_REFRESH_FAILURE_MAX_MS = 24 * 60 * 60_000;
export const PASSIVE_CATALOG_REFRESH_IDLE_MS = 30_000;

function boundedDelay(value, fallback, { minimum = MIN_CONFIGURED_DELAY_MS } = {}) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < minimum) return fallback;
  return Math.min(MAX_CONFIGURED_DELAY_MS, Math.floor(parsed));
}

export function passiveCatalogRefreshOptions(environment = process.env) {
  return {
    disabled: environment.CODEX_ROUTER_DISABLE_PASSIVE_CATALOG_REFRESH === "1",
    intervalMs: boundedDelay(
      environment.CODEX_ROUTER_PASSIVE_CATALOG_REFRESH_INTERVAL_MS,
      PASSIVE_CATALOG_REFRESH_INTERVAL_MS,
    ),
    failureBaseMs: boundedDelay(
      environment.CODEX_ROUTER_PASSIVE_CATALOG_REFRESH_FAILURE_BASE_MS,
      PASSIVE_CATALOG_REFRESH_FAILURE_BASE_MS,
    ),
    failureMaxMs: boundedDelay(
      environment.CODEX_ROUTER_PASSIVE_CATALOG_REFRESH_FAILURE_MAX_MS,
      PASSIVE_CATALOG_REFRESH_FAILURE_MAX_MS,
    ),
    idleMs: boundedDelay(
      environment.CODEX_ROUTER_PASSIVE_CATALOG_REFRESH_IDLE_MS,
      PASSIVE_CATALOG_REFRESH_IDLE_MS,
      { minimum: 1_000 },
    ),
  };
}

function finiteTimestamp(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function normalizedState(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  if (value.version !== STATE_VERSION) return undefined;
  const nextEligibleAt = finiteTimestamp(value.nextEligibleAt);
  if (nextEligibleAt === undefined) return undefined;
  const consecutiveFailures = Number.isSafeInteger(value.consecutiveFailures) &&
      value.consecutiveFailures >= 0 && value.consecutiveFailures <= 64
    ? value.consecutiveFailures
    : undefined;
  if (consecutiveFailures === undefined) return undefined;
  return {
    version: STATE_VERSION,
    nextEligibleAt,
    consecutiveFailures,
    ...(finiteTimestamp(value.lastAttemptAt) !== undefined
      ? { lastAttemptAt: value.lastAttemptAt }
      : {}),
    ...(finiteTimestamp(value.lastSuccessAt) !== undefined
      ? { lastSuccessAt: value.lastSuccessAt }
      : {}),
    ...(finiteTimestamp(value.lastFailureAt) !== undefined
      ? { lastFailureAt: value.lastFailureAt }
      : {}),
    ...(typeof value.lastChanged === "boolean"
      ? { lastChanged: value.lastChanged }
      : {}),
    ...(Number.isSafeInteger(value.lastChangedCount) && value.lastChangedCount >= 0
      ? { lastChangedCount: Math.min(value.lastChangedCount, 10_000) }
      : {}),
  };
}

export function readPassiveCatalogRefreshState({
  file = PASSIVE_CATALOG_REFRESH_PATH,
} = {}) {
  try {
    if (!existsSync(file)) return undefined;
    const link = lstatSync(file);
    if (!link.isFile() || link.isSymbolicLink() || statSync(file).size > MAX_STATE_BYTES) {
      return undefined;
    }
    return normalizedState(JSON.parse(readFileSync(file, "utf8")));
  } catch {
    // This is scheduling metadata, never an authority. A corrupt, oversized,
    // or foreign file becomes one due check; the worker atomically replaces it
    // before any network request so it cannot create a request loop.
    return undefined;
  }
}

function writeState(file, state) {
  writePrivateJson(file, state, { directoryMode: 0o700 });
  return state;
}

function withStateLock(file, operation, lock = withAtomicStateLock) {
  return lock(file, operation, { waitMs: 2_000 });
}

export function passiveCatalogRefreshConfigured(providers = RUNTIME_PROVIDERS) {
  return [...providers.values()].some((provider) => provider.mirrorNativeModels === true);
}

export function reservePassiveCatalogRefresh({
  file = PASSIVE_CATALOG_REFRESH_PATH,
  now = Date.now(),
  failureBaseMs = PASSIVE_CATALOG_REFRESH_FAILURE_BASE_MS,
  readState = readPassiveCatalogRefreshState,
  lock,
} = {}) {
  return withStateLock(file, () => {
    const current = readState({ file });
    if (current && current.nextEligibleAt > now) {
      return { reserved: false, state: current };
    }
    const state = writeState(file, {
      version: STATE_VERSION,
      ...(current || {}),
      lastAttemptAt: now,
      nextEligibleAt: now + failureBaseMs,
      consecutiveFailures: current?.consecutiveFailures || 0,
    });
    return { reserved: true, state };
  }, lock);
}

export function recordPassiveCatalogRefreshSuccess({
  changed = false,
  changedCount = 0,
} = {}, {
  file = PASSIVE_CATALOG_REFRESH_PATH,
  now = Date.now(),
  intervalMs = PASSIVE_CATALOG_REFRESH_INTERVAL_MS,
  readState = readPassiveCatalogRefreshState,
  lock,
} = {}) {
  return withStateLock(file, () => {
    const current = readState({ file });
    return writeState(file, {
      version: STATE_VERSION,
      ...(current?.lastAttemptAt !== undefined
        ? { lastAttemptAt: current.lastAttemptAt }
        : {}),
      lastSuccessAt: now,
      nextEligibleAt: now + intervalMs,
      consecutiveFailures: 0,
      lastChanged: changed === true,
      lastChangedCount: Number.isSafeInteger(changedCount) && changedCount > 0
        ? Math.min(changedCount, 10_000)
        : 0,
    });
  }, lock);
}

export function recordPassiveCatalogRefreshFailure({
  file = PASSIVE_CATALOG_REFRESH_PATH,
  now = Date.now(),
  failureBaseMs = PASSIVE_CATALOG_REFRESH_FAILURE_BASE_MS,
  failureMaxMs = PASSIVE_CATALOG_REFRESH_FAILURE_MAX_MS,
  readState = readPassiveCatalogRefreshState,
  lock,
} = {}) {
  return withStateLock(file, () => {
    const current = readState({ file });
    const failures = Math.min(64, (current?.consecutiveFailures || 0) + 1);
    const multiplier = 2 ** Math.min(30, failures - 1);
    const delay = Math.min(failureMaxMs, failureBaseMs * multiplier);
    return writeState(file, {
      version: STATE_VERSION,
      ...(current?.lastAttemptAt !== undefined
        ? { lastAttemptAt: current.lastAttemptAt }
        : {}),
      ...(current?.lastSuccessAt !== undefined
        ? { lastSuccessAt: current.lastSuccessAt }
        : {}),
      lastFailureAt: now,
      nextEligibleAt: now + delay,
      consecutiveFailures: failures,
      ...(current?.lastChanged !== undefined
        ? { lastChanged: current.lastChanged }
        : {}),
      ...(current?.lastChangedCount !== undefined
        ? { lastChangedCount: current.lastChangedCount }
        : {}),
    });
  }, lock);
}

export function passiveMirrorSummary(output) {
  for (const line of String(output || "").split(/\r?\n/)) {
    if (!line.trim().startsWith("{")) continue;
    try {
      const value = JSON.parse(line);
      if (
        Number.isSafeInteger(value?.providers) &&
        typeof value?.changed === "boolean" &&
        Array.isArray(value?.added) &&
        Array.isArray(value?.updated)
      ) {
        return {
          changed: value.changed,
          changedCount: value.added.length + value.updated.length,
        };
      }
    } catch {
      // Other refresh output is human-readable or belongs to catalog status.
    }
  }
  return { changed: false, changedCount: 0 };
}

export function runPassiveCatalogRefreshWorker({
  providers = RUNTIME_PROVIDERS,
  reserve = reservePassiveCatalogRefresh,
  recordSuccess = recordPassiveCatalogRefreshSuccess,
  recordFailure = recordPassiveCatalogRefreshFailure,
  runner = spawnSync,
  executable = process.execPath,
  sourceRoot = SOURCE_ROOT,
  environment = process.env,
  options = passiveCatalogRefreshOptions(environment),
} = {}) {
  if (options.disabled || !passiveCatalogRefreshConfigured(providers)) {
    return { ran: false, reason: "disabled" };
  }
  const reservation = reserve({
    failureBaseMs: options.failureBaseMs,
  });
  if (!reservation.reserved) return { ran: false, reason: "cooldown" };

  let result;
  try {
    result = runner(
      executable,
      [path.join(sourceRoot, "src", "refresh-catalog.mjs")],
      {
        cwd: sourceRoot,
        env: detachedOperationEnvironment(environment, {
          MODEL_ROUTER_TARGET: "codex",
          CODEX_ROUTER_PASSIVE_REFRESH_WORKER: "1",
        }),
        encoding: "utf8",
        maxBuffer: 32 * 1024 * 1024,
        timeout: 15 * 60_000,
        windowsHide: true,
      },
    );
  } catch {
    result = { status: null, error: true };
  }
  if (result.error || result.status !== 0) {
    recordFailure({
      failureBaseMs: options.failureBaseMs,
      failureMaxMs: options.failureMaxMs,
    });
    return { ran: true, ok: false };
  }
  const summary = passiveMirrorSummary(result.stdout);
  recordSuccess(summary, { intervalMs: options.intervalMs });
  return { ran: true, ok: true, ...summary };
}

function defaultSpawnWorker({ environment = process.env } = {}) {
  const child = spawn(process.execPath, [SELF, "--worker"], {
    cwd: SOURCE_ROOT,
    env: detachedOperationEnvironment(environment, { MODEL_ROUTER_TARGET: TARGET }),
    detached: true,
    stdio: ["ignore", "ignore", "inherit"],
    windowsHide: true,
  });
  child.unref();
  return child;
}

export function createPassiveCatalogRefreshScheduler({
  enabled = passiveCatalogRefreshConfigured(),
  options = passiveCatalogRefreshOptions(),
  now = Date.now,
  activeRequests = () => 0,
  readState = readPassiveCatalogRefreshState,
  spawnWorker = defaultSpawnWorker,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
} = {}) {
  let timer;
  let child;
  let nextEligibleAt = enabled && !options.disabled
    ? readState()?.nextEligibleAt || 0
    : Number.POSITIVE_INFINITY;

  const childFinished = () => {
    child = undefined;
    nextEligibleAt = readState()?.nextEligibleAt ||
      (now() + options.failureBaseMs);
  };

  const schedule = () => {
    if (!enabled || options.disabled) return false;
    if (child || timer || now() < nextEligibleAt || activeRequests() > 0) return false;
    timer = setTimer(() => {
      timer = undefined;
      if (activeRequests() > 0) return;
      const current = readState();
      nextEligibleAt = current?.nextEligibleAt || 0;
      if (now() < nextEligibleAt) return;
      // A worker that dies before reserving its durable attempt must still be
      // coalesced in this process. The worker writes the same provisional
      // cooldown before making any network request, which covers restarts.
      nextEligibleAt = now() + options.failureBaseMs;
      try {
        child = spawnWorker({ environment: process.env });
        let finished = false;
        const finish = () => {
          if (finished) return;
          finished = true;
          childFinished();
        };
        child.once("error", finish);
        child.once("exit", finish);
      } catch {
        childFinished();
      }
    }, options.idleMs);
    timer.unref?.();
    return true;
  };

  const noteActivityStarted = () => {
    if (!timer) return;
    clearTimer(timer);
    timer = undefined;
  };

  const noteActivityFinished = () => {
    if (activeRequests() === 0) schedule();
  };

  return Object.freeze({ schedule, noteActivityStarted, noteActivityFinished });
}

if (process.argv[1] && path.resolve(process.argv[1]) === SELF && process.argv[2] === "--worker") {
  try {
    const result = runPassiveCatalogRefreshWorker();
    if (result.ran && !result.ok) {
      console.error("[codex-router] passive model-catalog refresh failed; retry is backed off.");
      process.exitCode = 1;
    } else if (result.changed) {
      console.error(
        `[codex-router] passive model-catalog refresh published ${result.changedCount} change(s); fully quit and reopen Codex to reload its picker.`,
      );
    }
  } catch {
    // Never print a discovery error here: an upstream error can contain a URL
    // or provider response. The durable failure state is enough to back off.
    console.error("[codex-router] passive model-catalog refresh failed; retry is backed off.");
    process.exitCode = 1;
  }
}
