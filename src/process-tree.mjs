import { spawn } from "node:child_process";
import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_KILL_GRACE_MS = 250;
const DEFAULT_MAX_OUTPUT_BYTES = 2 * 1024 * 1024;
const DEFAULT_CHILD_CLEANUP_RESERVE_MS = 10_000;
const DEFAULT_TREE_EXIT_WAIT_MS = 5_000;
const OWNER_SIGNAL_CLEANUP_MS = 10_000;
const OWNER_SIGNAL_LEVEL_RESERVE_MS = 500;
const OWNER_SIGNAL_GROUP_EXIT_WAIT_MS = 250;
const OWNER_SIGNAL_CLOSE_WAIT_MS = 200;
const MIN_OWNER_SIGNAL_BUDGET_MS = OWNER_SIGNAL_LEVEL_RESERVE_MS;
const OWNER_SIGNAL_BUDGET_ENV = "CODEX_ROUTER_OWNER_SIGNAL_BUDGET_MS";
const OWNER_SIGNAL_BARRIER_DIR_ENV = "CODEX_ROUTER_OWNER_SIGNAL_BARRIER_DIR";
const OWNER_SIGNAL_BARRIER_PREFIX = "barrier-";
const MAX_OWNER_SIGNAL_BARRIER_MS = 11 * 60_000;
const MAX_OWNER_SIGNAL_BARRIER_FILE_BYTES = 1_024;
const OWNER_SIGNALS = ["SIGINT", "SIGTERM"];
const WINDOWS_JOB_RUNNER = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "windows-process-tree.ps1",
);

const ownedProcessTrees = new Map();
const ownerSignalBarriers = new Map();
const ownerSignalHandlers = new Map();
const ownerSignalContext = new AsyncLocalStorage();
let ownerSignalInProgress;

function signalExitCode(signal) {
  return signal === "SIGINT" ? 130 : 143;
}

function ownerSignalError(signal) {
  return Object.assign(new Error(`The router command owner received ${signal}.`), {
    code: "router_operation_interrupted",
    signal,
  });
}

function removeOwnerSignalHandlers() {
  for (const [signal, handler] of ownerSignalHandlers) {
    process.removeListener(signal, handler);
  }
  ownerSignalHandlers.clear();
}

function ownerSignalBudget(environment = process.env) {
  const configured = Number(environment?.[OWNER_SIGNAL_BUDGET_ENV]);
  return Number.isSafeInteger(configured)
    && configured >= MIN_OWNER_SIGNAL_BUDGET_MS
    && configured <= OWNER_SIGNAL_CLEANUP_MS
    ? configured
    : undefined;
}

function ownerSignalCoordinatorDirectory(environment = process.env) {
  const configured = environment?.[OWNER_SIGNAL_BARRIER_DIR_ENV];
  if (configured === undefined) return undefined;
  const invalid = () => {
    const error = new Error("The inherited owner-signal barrier coordinator is invalid.");
    error.code = "router_operation_signal_barrier_invalid";
    throw error;
  };
  if (typeof configured !== "string" || !path.isAbsolute(configured)) invalid();
  try {
    const stat = lstatSync(configured);
    if (!stat.isDirectory() || stat.isSymbolicLink()) invalid();
    if (process.platform !== "win32" && (stat.mode & 0o077) !== 0) invalid();
    if (
      typeof process.getuid === "function"
      && stat.uid !== process.getuid()
    ) invalid();
  } catch (error) {
    if (error?.code === "router_operation_signal_barrier_invalid") throw error;
    invalid();
  }
  return configured;
}

function prepareOwnerSignalCoordinator(
  environment,
  { create = false } = {},
) {
  const inherited = ownerSignalCoordinatorDirectory(environment);
  if (inherited || !create) {
    return {
      directory: inherited,
      environment,
      release: () => {},
    };
  }
  const directory = mkdtempSync(path.join(os.tmpdir(), "codex-router-owner-signal-"));
  let released = false;
  return {
    directory,
    environment: { ...environment, [OWNER_SIGNAL_BARRIER_DIR_ENV]: directory },
    release: () => {
      if (released) return;
      released = true;
      try {
        rmSync(directory, { recursive: true, force: true });
      } catch {
        // The process tree is already proven empty. A best-effort temporary
        // coordinator cleanup must not strand the caller's completion path.
      }
    },
  };
}

function processAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === "EPERM") return true;
    if (error?.code === "ESRCH") return false;
    return true;
  }
}

function conservativeOwnerSignalBarrier() {
  return {
    pid: undefined,
    timeoutMs: MAX_OWNER_SIGNAL_BARRIER_MS,
    ownerSignalBudgetMs: MIN_OWNER_SIGNAL_BUDGET_MS,
  };
}

function activeOwnerSignalBarriers(directory, { ignorePid = process.pid } = {}) {
  if (!directory) return [];
  let names;
  try {
    names = readdirSync(directory).filter((name) => (
      name.startsWith(OWNER_SIGNAL_BARRIER_PREFIX) && name.endsWith(".json")
    ));
  } catch (error) {
    return error?.code === "ENOENT" ? [] : [conservativeOwnerSignalBarrier()];
  }
  const active = [];
  for (const name of names) {
    const file = path.join(directory, name);
    let lease;
    try {
      if (statSync(file).size > MAX_OWNER_SIGNAL_BARRIER_FILE_BYTES) {
        active.push(conservativeOwnerSignalBarrier());
        continue;
      }
      lease = JSON.parse(readFileSync(file, "utf8"));
    } catch (error) {
      if (error?.code === "ENOENT") continue;
      active.push(conservativeOwnerSignalBarrier());
      continue;
    }
    if (
      lease?.version !== 1
      || !Number.isSafeInteger(lease.pid)
      || lease.pid <= 0
      || !Number.isSafeInteger(lease.timeoutMs)
      || lease.timeoutMs <= 0
      || lease.timeoutMs > MAX_OWNER_SIGNAL_BARRIER_MS
      || !Number.isSafeInteger(lease.ownerSignalBudgetMs)
      || lease.ownerSignalBudgetMs < MIN_OWNER_SIGNAL_BUDGET_MS
      || lease.ownerSignalBudgetMs > OWNER_SIGNAL_CLEANUP_MS
    ) {
      active.push(conservativeOwnerSignalBarrier());
      continue;
    }
    if (lease.pid === ignorePid) continue;
    if (!processAlive(lease.pid)) {
      try { unlinkSync(file); } catch { /* another owner already retired it */ }
      continue;
    }
    active.push(lease);
  }
  return active;
}

function ownerSignalBarrierWaits(
  directory,
  {
    ignorePid = process.pid,
    ownBudgetMs = ownerSignalBudget(process.env) ?? OWNER_SIGNAL_CLEANUP_MS,
  } = {},
) {
  let graceMs = 0;
  let shutdownMs = 0;
  for (const barrier of activeOwnerSignalBarriers(directory, { ignorePid })) {
    const ancestorReserveMs = Math.max(0, ownBudgetMs - barrier.ownerSignalBudgetMs);
    // The barrier owner exits at timeoutMs. Each ancestor waits one complete
    // contracted level beyond that owner, so the direct parent never races the
    // barrier's own forced-exit timer and every additional parent remains later
    // than its child's bounded group-retirement and captured-pipe close path.
    graceMs = Math.max(
      graceMs,
      barrier.timeoutMs + ancestorReserveMs,
    );
    shutdownMs = Math.max(
      shutdownMs,
      barrier.timeoutMs + ancestorReserveMs + OWNER_SIGNAL_LEVEL_RESERVE_MS,
    );
  }
  return { graceMs, shutdownMs };
}

function registerOwnerSignalBarrierLease(timeoutMs) {
  const directory = ownerSignalCoordinatorDirectory(process.env);
  if (!directory) return () => {};
  const localOwnerBudgetMs = ownerSignalBudget(process.env) ?? OWNER_SIGNAL_CLEANUP_MS;
  const id = `${process.pid}-${randomUUID()}`;
  const temporary = path.join(directory, `.${OWNER_SIGNAL_BARRIER_PREFIX}${id}.tmp`);
  const file = path.join(directory, `${OWNER_SIGNAL_BARRIER_PREFIX}${id}.json`);
  try {
    writeFileSync(temporary, JSON.stringify({
      version: 1,
      pid: process.pid,
      // forwardOwnerSignal retains the ordinary owner cleanup budget even for
      // a shorter barrier. Publish the actual maximum, not merely the callback
      // timeout, so a parent never assumes this process must already be gone.
      timeoutMs: Math.max(timeoutMs, localOwnerBudgetMs),
      ownerSignalBudgetMs: localOwnerBudgetMs,
    }), { flag: "wx", mode: 0o600 });
    renameSync(temporary, file);
  } catch (cause) {
    try { unlinkSync(temporary); } catch { /* nothing was published */ }
    const error = new Error("The owner-signal exit barrier could not be registered with its parent.");
    error.code = "router_owner_signal_barrier_registration_failed";
    error.cause = cause;
    throw error;
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    try { unlinkSync(file); } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  };
}

function contractedOwnerSignalBudget(
  environment = process.env,
  { childMayOwnProcessTrees = false } = {},
) {
  const inherited = ownerSignalBudget(environment);
  if (environment?.[OWNER_SIGNAL_BUDGET_ENV] !== undefined && inherited === undefined) {
    const error = new Error("The inherited owner-signal cleanup budget is invalid.");
    error.code = "router_operation_signal_budget_invalid";
    throw error;
  }
  if (
    inherited === undefined
    && !childMayOwnProcessTrees
    && environment?.CODEX_ROUTER_OPERATION_CHILD !== "1"
  ) {
    return undefined;
  }
  const contracted = (inherited ?? OWNER_SIGNAL_CLEANUP_MS) - OWNER_SIGNAL_LEVEL_RESERVE_MS;
  if (contracted < MIN_OWNER_SIGNAL_BUDGET_MS) {
    const error = new Error("The nested process tree exhausted its owner-signal cleanup reserve.");
    error.code = "router_operation_signal_depth_exceeded";
    throw error;
  }
  return contracted;
}

function ensureOwnerSignalHandlers() {
  if (ownerSignalHandlers.size > 0) return;
  for (const signal of OWNER_SIGNALS) {
    const handler = () => { void forwardOwnerSignal(signal); };
    ownerSignalHandlers.set(signal, handler);
    process.on(signal, handler);
  }
}

function maybeRemoveOwnerSignalHandlers() {
  if (
    ownedProcessTrees.size === 0
    && ownerSignalBarriers.size === 0
    && !ownerSignalInProgress
  ) removeOwnerSignalHandlers();
}

async function forwardOwnerSignal(signal) {
  if (ownerSignalInProgress) return;
  ownerSignalInProgress = signal;
  const exitCode = signalExitCode(signal);
  const barriers = [...ownerSignalBarriers.values()];
  const cleanups = [...ownedProcessTrees.values()];
  const interruption = ownerSignalError(signal);
  for (const barrier of barriers) barrier.controller.abort(interruption);
  const barrierBudget = barriers.reduce(
    (maximum, barrier) => Math.max(maximum, barrier.timeoutMs),
    0,
  );
  const remoteBarrierBudget = cleanups.reduce((maximum, tree) => Math.max(
    maximum,
    ownerSignalBarrierWaits(tree.barrierDirectory).shutdownMs,
  ), 0);
  const forcedExit = setTimeout(
    () => process.exit(exitCode),
    Math.max(
      ownerSignalBudget(process.env) ?? OWNER_SIGNAL_CLEANUP_MS,
      barrierBudget,
      remoteBarrierBudget,
    ),
  );
  await Promise.allSettled([
    ...cleanups.map((tree) => tree.cleanup(signal)),
    ...barriers.map((barrier) => barrier.promise),
  ]);
  clearTimeout(forcedExit);
  removeOwnerSignalHandlers();
  process.exit(exitCode);
}

function registerOwnedProcessTree(cleanup, { barrierDirectory } = {}) {
  const token = Symbol("owned-process-tree");
  ownedProcessTrees.set(token, { cleanup, barrierDirectory });
  ensureOwnerSignalHandlers();
  return () => {
    ownedProcessTrees.delete(token);
    maybeRemoveOwnerSignalHandlers();
  };
}

/**
 * Keep the owner alive while a durable mutation reaches either its commit
 * point or its semantic rollback point. The timeout is consulted only after
 * an owner signal; it never lengthens the operation's own deadline.
 */
export async function withOwnerSignalExitBarrier(
  callback,
  { timeoutMs = OWNER_SIGNAL_CLEANUP_MS } = {},
) {
  if (typeof callback !== "function") throw new TypeError("An owner-signal barrier requires a callback.");
  if (
    !Number.isSafeInteger(timeoutMs)
    || timeoutMs <= 0
    || timeoutMs > MAX_OWNER_SIGNAL_BARRIER_MS
  ) throw new TypeError("An owner-signal barrier requires a finite bounded timeout.");
  if (ownerSignalInProgress) throw ownerSignalError(ownerSignalInProgress);
  const releaseLease = registerOwnerSignalBarrierLease(timeoutMs);
  let release;
  const promise = new Promise((resolve) => { release = resolve; });
  const controller = new AbortController();
  const token = Symbol("owner-signal-barrier");
  ownerSignalBarriers.set(token, { promise, timeoutMs, controller });
  ensureOwnerSignalHandlers();
  try {
    return await ownerSignalContext.run(
      { barrierToken: token, cleanupAllowed: false },
      () => callback(controller.signal),
    );
  } finally {
    ownerSignalBarriers.delete(token);
    release();
    releaseLease();
    maybeRemoveOwnerSignalHandlers();
  }
}

/** Permit only cleanup work already protected by an owner-signal barrier. */
export function runDuringOwnerSignalCleanup(callback) {
  if (typeof callback !== "function") throw new TypeError("Owner-signal cleanup requires a callback.");
  const context = ownerSignalContext.getStore();
  if (!context?.barrierToken || !ownerSignalBarriers.has(context.barrierToken)) {
    const error = new Error("Owner-signal cleanup is allowed only inside a registered exit barrier.");
    error.code = "router_owner_signal_cleanup_unprotected";
    throw error;
  }
  return ownerSignalContext.run({ ...context, cleanupAllowed: true }, callback);
}

function abortReason(signal, fallback = "The router operation was aborted.") {
  return signal?.reason instanceof Error ? signal.reason : new Error(fallback);
}

export function operationDeadlineFromEnvironment(
  env = process.env,
  { timeoutMs, maximumMs } = {},
) {
  const explicitDeadline = Number(env.CODEX_ROUTER_OPERATION_DEADLINE_MS);
  if (Number.isSafeInteger(explicitDeadline) && explicitDeadline > 0) {
    return Number.isSafeInteger(maximumMs) && maximumMs > 0
      ? Math.min(explicitDeadline, Date.now() + maximumMs)
      : explicitDeadline;
  }
  const requested = Number(env.CODEX_ROUTER_OPERATION_TIMEOUT_MS);
  const fallback = Number(timeoutMs);
  let duration = Number.isSafeInteger(requested) && requested > 0 ? requested : fallback;
  if (!Number.isSafeInteger(duration) || duration <= 0) return undefined;
  if (Number.isSafeInteger(maximumMs) && maximumMs > 0) {
    duration = Math.min(duration, maximumMs);
  }
  return Date.now() + duration;
}

export function detachedOperationEnvironment(env = process.env, overrides = {}) {
  const detached = { ...env };
  delete detached.CODEX_ROUTER_OPERATION_DEADLINE_MS;
  delete detached.CODEX_ROUTER_OPERATION_TIMEOUT_MS;
  delete detached.CODEX_ROUTER_OPERATION_CHILD;
  delete detached[OWNER_SIGNAL_BUDGET_ENV];
  delete detached[OWNER_SIGNAL_BARRIER_DIR_ENV];
  return { ...detached, ...overrides };
}

export function boundedOperationChild(
  env = process.env,
  { maximumMs, now = Date.now } = {},
) {
  if (env.CODEX_ROUTER_OPERATION_CHILD !== "1") return false;
  const deadline = Number(env.CODEX_ROUTER_OPERATION_DEADLINE_MS);
  if (!Number.isSafeInteger(deadline) || deadline <= 0) return false;
  if (Number.isSafeInteger(maximumMs) && maximumMs > 0 && deadline > now() + maximumMs) {
    return false;
  }
  // A forged or inherited expired marker must fail before mutation rather than
  // suppressing the default outer boundary and silently running unbounded.
  remainingOperationMs(deadline, undefined, { now });
  return true;
}

export function remainingOperationMs(
  deadline,
  signal,
  { now = Date.now, message = "The router operation deadline expired." } = {},
) {
  if (signal?.aborted) throw abortReason(signal);
  if (!Number.isSafeInteger(deadline)) return undefined;
  const remaining = deadline - now();
  if (remaining <= 0) {
    const error = new Error(message);
    error.code = "router_operation_timeout";
    throw error;
  }
  return remaining;
}

export function contractOperationDeadline(
  deadline,
  {
    reserveMs = DEFAULT_CHILD_CLEANUP_RESERVE_MS,
    now = Date.now,
    message = "The router operation deadline has no remaining child cleanup margin.",
  } = {},
) {
  const remaining = remainingOperationMs(deadline, undefined, { now, message });
  if (remaining === undefined) return undefined;
  const reserve = Number.isSafeInteger(reserveMs) && reserveMs > 0
    ? reserveMs
    : DEFAULT_CHILD_CLEANUP_RESERVE_MS;
  if (remaining <= reserve) {
    const error = new Error(message);
    error.code = "router_operation_timeout";
    throw error;
  }
  return deadline - reserve;
}

function killChildFallback(child, signal = "SIGKILL") {
  try {
    child?.kill(signal);
  } catch {
    // The process already exited.
  }
}

/**
 * Returns the PowerShell executable path for process tree termination.
 * Uses a bare command name to avoid environment taint while still working
 * regardless of Windows installation drive.
 */
function windowsPowerShell() {
  // Use bare "powershell.exe" which Windows will resolve via PATH
  // This avoids reading SystemRoot/WINDIR from environment while still
  // working on any Windows installation (C:, D:, etc.)
  return "powershell.exe";
}

/**
 * Windows has no process-group primitive equivalent to kill(-pgid). A target
 * may exit after spawning a descendant, at which point taskkill /T can no
 * longer walk through the dead parent. Start the real target suspended inside
 * a kill-on-close Job Object instead. The PowerShell owner does not exit until
 * it has terminated and observed every remaining job member, so its close is a
 * trustworthy tree boundary on both success and failure.
 */
export function windowsJobProcessInvocation(
  command,
  args = [],
  {
    environment = process.env,
    ownerPid = process.pid,
    windowsHide = true,
    windowsVerbatimArguments = false,
    runner = WINDOWS_JOB_RUNNER,
  } = {},
) {
  const payload = Buffer.from(JSON.stringify({
    command,
    arguments: [...args],
    ownerProcessId: ownerPid,
    windowsHide: Boolean(windowsHide),
    windowsVerbatimArguments: Boolean(windowsVerbatimArguments),
  }), "utf8").toString("base64");
  return {
    command: windowsPowerShell(),
    args: [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy", "Bypass",
      "-File", runner,
      payload,
    ],
  };
}

function processGroupAlive(pid, kill = process.kill) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    kill(-pid, 0);
    return true;
  } catch (error) {
    if (error?.code === "EPERM") return true;
    if (error?.code === "ESRCH") return false;
    throw error;
  }
}

async function waitForProcessGroupExit(
  pid,
  timeoutMs,
  { kill = process.kill, intervalMs = 20 } = {},
) {
  const deadline = Date.now() + Math.max(0, timeoutMs);
  while (processGroupAlive(pid, kill)) {
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return true;
}

async function waitForProcessGroupExitWithOwnerSignalBarriers(
  pid,
  graceMs,
  {
    barrierDirectory,
    barrierOwnerPid = process.pid,
    barrierOwnBudgetMs = ownerSignalBudget(process.env) ?? OWNER_SIGNAL_CLEANUP_MS,
    kill = process.kill,
    intervalMs = 20,
  } = {},
) {
  const startedAt = Date.now();
  const ordinaryDeadline = startedAt + Math.max(0, graceMs);
  while (processGroupAlive(pid, kill)) {
    const barrierGraceMs = ownerSignalBarrierWaits(barrierDirectory, {
      ignorePid: barrierOwnerPid,
      ownBudgetMs: barrierOwnBudgetMs,
    }).graceMs;
    const deadline = Math.max(ordinaryDeadline, startedAt + barrierGraceMs);
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return true;
}

function treeCleanupError(pid) {
  return Object.assign(
    new Error(`The router could not prove process group ${pid} terminated.`),
    { code: "router_process_tree_cleanup_failed" },
  );
}

async function waitForChildClose(child, timeoutMs = DEFAULT_TREE_EXIT_WAIT_MS) {
  if (
    child?.exitCode !== null && child?.exitCode !== undefined
    || child?.signalCode !== null && child?.signalCode !== undefined
  ) return true;
  if (typeof child?.once !== "function") return true;
  return new Promise((resolve) => {
    let settled = false;
    const finish = (closed) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.removeListener?.("close", onClose);
      child.removeListener?.("error", onClose);
      resolve(closed);
    };
    const onClose = () => finish(true);
    const timer = setTimeout(() => finish(false), timeoutMs);
    child.once("close", onClose);
    child.once("error", onClose);
  });
}

async function terminateWindowsTree(
  child,
  { spawnImpl = spawn, environment = process.env } = {},
) {
  if (!child?.pid) {
    killChildFallback(child);
    return;
  }
  await new Promise((resolve) => {
    const systemRoot = environment.SystemRoot;
    const systemTaskkill = systemRoot
      ? path.join(systemRoot, "System32", "taskkill.exe")
      : undefined;
    const command = systemTaskkill && existsSync(systemTaskkill)
      ? systemTaskkill
      : "taskkill.exe";
    let killer;
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      killChildFallback(killer);
      killChildFallback(child);
      finish();
    }, 5_000);
    timer.unref?.();
    try {
      killer = spawnImpl(command, ["/PID", String(child.pid), "/T", "/F"], {
        shell: false,
        windowsHide: true,
        stdio: "ignore",
      });
      killer.once("error", () => {
        killChildFallback(child);
        finish();
      });
      killer.once("close", (code) => {
        if (code !== 0) killChildFallback(child);
        finish();
      });
    } catch {
      killChildFallback(child);
      finish();
    }
  });
  // taskkill returning only proves its own traversal completed. The Job
  // Object handle closes in the helper, so wait for that helper's close before
  // allowing a timeout/abort caller to observe that the tree is gone.
  if (!(await waitForChildClose(child))) throw treeCleanupError(child.pid);
}

export async function terminateProcessTree(
  child,
  {
    graceMs = DEFAULT_KILL_GRACE_MS,
    platform = process.platform,
    spawnImpl = spawn,
    environment = process.env,
    initialSignal = "SIGTERM",
    exitWaitMs = DEFAULT_TREE_EXIT_WAIT_MS,
    kill = process.kill,
    barrierDirectory,
    barrierOwnerPid = process.pid,
    barrierOwnBudgetMs = ownerSignalBudget(process.env) ?? OWNER_SIGNAL_CLEANUP_MS,
  } = {},
) {
  if (!child) return;
  if (platform === "win32") {
    await terminateWindowsTree(child, { spawnImpl, environment });
    return;
  }
  if (!child.pid) {
    killChildFallback(child);
    return;
  }
  if (!processGroupAlive(child.pid, kill)) return;
  try {
    kill(-child.pid, initialSignal);
  } catch (error) {
    if (error?.code === "ESRCH") return;
    throw treeCleanupError(child.pid);
  }
  if (barrierDirectory) {
    if (await waitForProcessGroupExitWithOwnerSignalBarriers(child.pid, graceMs, {
      barrierDirectory,
      barrierOwnerPid,
      barrierOwnBudgetMs,
      kill,
    })) return;
  } else if (await waitForProcessGroupExit(child.pid, graceMs, { kill })) return;
  try {
    kill(-child.pid, "SIGKILL");
  } catch (error) {
    if (error?.code === "ESRCH") return;
    throw treeCleanupError(child.pid);
  }
  if (!(await waitForProcessGroupExit(child.pid, exitWaitMs, { kill }))) {
    throw treeCleanupError(child.pid);
  }
}

/**
 * Spawn one command in its own POSIX process group or a kill-on-close Windows
 * Job Object, enforcing the same absolute deadline across every descendant.
 * This is the mutation-safe replacement for spawnSync timeouts, which can wait
 * forever when a child ignores the timeout signal.
 */
export function runProcessTree(
  command,
  args = [],
  {
    cwd,
    env = process.env,
    signal,
    deadline,
    stdio = "capture",
    encoding = "utf8",
    maxOutputBytes = DEFAULT_MAX_OUTPUT_BYTES,
    graceMs = DEFAULT_KILL_GRACE_MS,
    windowsHide = true,
    windowsVerbatimArguments = false,
    platform = process.platform,
    childMayOwnProcessTrees = false,
  } = {},
) {
  if (ownerSignalInProgress && ownerSignalContext.getStore()?.cleanupAllowed !== true) {
    throw ownerSignalError(ownerSignalInProgress);
  }
  const remaining = remainingOperationMs(deadline, signal);
  const childSignalBudget = contractedOwnerSignalBudget(env, { childMayOwnProcessTrees });
  const coordinator = prepareOwnerSignalCoordinator(env, { create: childMayOwnProcessTrees });
  const childEnvironment = childSignalBudget === undefined
    ? coordinator.environment
    : { ...coordinator.environment, [OWNER_SIGNAL_BUDGET_ENV]: String(childSignalBudget) };
  const effectiveWindowsHide = stdio === "inherit" ? false : windowsHide;
  return new Promise((resolve, reject) => {
    const invocation = platform === "win32"
      ? windowsJobProcessInvocation(command, args, {
          environment: env,
          // A command attached to the caller's terminal must remain a console
          // process. Captured/background work stays windowless.
          windowsHide: effectiveWindowsHide,
          windowsVerbatimArguments,
        })
      : { command, args };
    let child;
    try {
      child = spawn(invocation.command, invocation.args, {
        cwd,
        env: childEnvironment,
        detached: platform !== "win32",
        shell: false,
        windowsHide: effectiveWindowsHide,
        windowsVerbatimArguments: false,
        stdio: stdio === "inherit" ? "inherit" : ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      coordinator.release();
      reject(error);
      return;
    }
    let stdout = "";
    let stderr = "";
    let outputBytes = 0;
    let settled = false;
    let terminating = false;
    let discardOutput = false;
    let terminalError;
    let terminationPromise;
    let timer;
    let unregisterOwner = () => {};
    let childCloseResolve;
    let childClosed = false;
    const childClose = new Promise((resolveClose) => { childCloseResolve = resolveClose; });

    const waitForCapturedClose = async (timeoutMs = DEFAULT_TREE_EXIT_WAIT_MS) => {
      if (childClosed) return true;
      let timeout;
      const closed = await Promise.race([
        childClose.then(() => true),
        new Promise((resolveClose) => {
          timeout = setTimeout(() => resolveClose(false), timeoutMs);
        }),
      ]);
      clearTimeout(timeout);
      return closed;
    };

    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      unregisterOwner();
      coordinator.release();
    };
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      cleanup();
      callback(value);
    };
    const stop = (error, { initialSignal = "SIGTERM", ownerSignal = false } = {}) => {
      if (settled) return Promise.resolve();
      if (terminationPromise) return terminationPromise;
      terminating = true;
      discardOutput = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      terminationPromise = (async () => {
        try {
          const ownBudget = ownerSignalBudget(env) ?? OWNER_SIGNAL_CLEANUP_MS;
          await terminateProcessTree(child, {
            graceMs: ownerSignal && childSignalBudget !== undefined
              ? childSignalBudget
              : graceMs,
            platform,
            initialSignal,
            barrierDirectory: coordinator.directory,
            barrierOwnerPid: process.pid,
            barrierOwnBudgetMs: ownBudget,
            exitWaitMs: ownerSignal && childSignalBudget !== undefined
              ? Math.min(
                  OWNER_SIGNAL_GROUP_EXIT_WAIT_MS,
                  ownBudget - childSignalBudget - OWNER_SIGNAL_CLOSE_WAIT_MS,
                )
              : DEFAULT_TREE_EXIT_WAIT_MS,
          });
          if (!(await waitForCapturedClose(
            ownerSignal ? OWNER_SIGNAL_CLOSE_WAIT_MS : DEFAULT_TREE_EXIT_WAIT_MS,
          ))) throw treeCleanupError(child.pid);
          finish(reject, error);
        } catch (cleanupError) {
          finish(reject, new AggregateError(
            [error, cleanupError],
            "The router operation failed and its child process tree could not be fully terminated.",
            { cause: error },
          ));
        }
      })();
      return terminationPromise;
    };
    const onAbort = () => {
      void stop(abortReason(signal));
    };

    if (remaining !== undefined) {
      timer = setTimeout(() => {
        const error = new Error("The router operation deadline expired while a child process was running.");
        error.code = "router_operation_timeout";
        void stop(error);
      }, remaining);
      timer.unref?.();
    }
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
    unregisterOwner = registerOwnedProcessTree((ownerSignal) => (
      stop(ownerSignalError(ownerSignal), {
        initialSignal: ownerSignal,
        ownerSignal: true,
      })
    ), { barrierDirectory: coordinator.directory });

    const collect = (name, chunk) => {
      if (settled || discardOutput) return;
      outputBytes += chunk.length;
      if (outputBytes > maxOutputBytes) {
        const error = new Error("Router command output exceeded its safe limit.");
        error.code = "router_operation_output_limit";
        if (terminating) {
          terminalError = error;
          discardOutput = true;
        } else {
          void stop(error);
        }
        return;
      }
      if (name === "stdout") stdout += chunk.toString(encoding);
      else stderr += chunk.toString(encoding);
    };
    child.stdout?.on("data", (chunk) => collect("stdout", chunk));
    child.stderr?.on("data", (chunk) => collect("stderr", chunk));
    child.once("error", (error) => {
      if (!terminating) finish(reject, error);
    });
    const settleLeaderExit = (status, childSignal) => {
      if (terminating || settled) return;
      terminating = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      terminationPromise = (async () => {
        try {
          // The Windows helper closes only after its Job Object is empty. On
          // POSIX, the group leader can close while a detached grandchild is
          // still alive, so explicitly retire any residual group before the
          // caller is allowed to observe success or nonzero completion.
          if (platform !== "win32") {
            await terminateProcessTree(child, {
              graceMs,
              platform,
              barrierDirectory: coordinator.directory,
              barrierOwnerPid: process.pid,
            });
            if (!(await waitForCapturedClose())) throw treeCleanupError(child.pid);
          }
          if (terminalError) {
            finish(reject, terminalError);
            return;
          }
          finish(resolve, {
            status,
            signal: childSignal,
            stdout,
            stderr,
          });
        } catch (error) {
          finish(reject, error);
        }
      })();
    };
    child.once("exit", (status, childSignal) => {
      if (platform !== "win32") settleLeaderExit(status, childSignal);
    });
    child.once("close", (status, childSignal) => {
      childClosed = true;
      childCloseResolve();
      if (platform === "win32") settleLeaderExit(status, childSignal);
    });
  });
}

/**
 * Run a child under this operation's deadline while handing the child an
 * earlier deadline and owner-signal budget for any process trees it owns. The
 * cleanup reserves prevent equal-deadline or equal-signal timers in nested
 * groups from orphaning a grandchild.
 */
export function runOperationProcessTree(
  command,
  args = [],
  {
    deadline,
    env = process.env,
    childEnvironment = {},
    run = runProcessTree,
    ...options
  } = {},
) {
  if (!Number.isSafeInteger(deadline) || deadline <= 0) {
    const error = new TypeError("A finite absolute deadline is required for a router operation process tree.");
    error.code = "router_operation_deadline_required";
    throw error;
  }
  const childDeadline = contractOperationDeadline(deadline);
  const operationEnvironment = {
    ...env,
    ...childEnvironment,
    ...(Number.isSafeInteger(childDeadline)
      ? { CODEX_ROUTER_OPERATION_DEADLINE_MS: String(childDeadline) }
      : {}),
  };
  return run(command, args, {
    ...options,
    env: operationEnvironment,
    deadline,
    childMayOwnProcessTrees: true,
  });
}
