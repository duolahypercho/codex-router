import { spawn } from "node:child_process";
import {
  accessSync,
  constants as fsConstants,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_TIMEOUT_MS = 30_000;
// A restart-bearing overlay transaction owns two 640-second publication
// epochs plus nested process-tree cleanup. Keep a finite ceiling beyond the
// 1,320-second catalog UI owner instead of truncating it to the old 11 minutes.
const MAX_TIMEOUT_MS = 22 * 60_000;
const MAX_OUTPUT_BYTES = 2 * 1024 * 1024;
const SECRET_WORD = /(api[_ -]?key|access[_ -]?token|refresh[_ -]?token|password|secret|credential)/i;
const APP_CONTRACT_LIMIT = 1024 * 1024;
const WINDOWS_EXECUTABLE_EXTENSIONS = [".exe", ".com", ".cmd", ".bat"];
const TREE_EXIT_WAIT_MS = 5_000;
const OWNER_SIGNAL_CLEANUP_MS = 10_000;
const OWNER_SIGNAL_LEVEL_RESERVE_MS = 500;
const OWNER_SIGNAL_GROUP_EXIT_WAIT_MS = 250;
const OWNER_SIGNAL_CLOSE_WAIT_MS = 200;
const OWNER_SIGNAL_BUDGET_ENV = "CODEX_ROUTER_OWNER_SIGNAL_BUDGET_MS";
const OWNER_SIGNAL_BARRIER_DIR_ENV = "CODEX_ROUTER_OWNER_SIGNAL_BARRIER_DIR";
const OWNER_SIGNAL_BARRIER_PREFIX = "barrier-";
const MAX_OWNER_SIGNAL_BARRIER_MS = 11 * 60_000;
const MAX_OWNER_SIGNAL_BARRIER_FILE_BYTES = 1_024;
const OWNER_SIGNALS = ["SIGINT", "SIGTERM"];

const ownedCommandTrees = new Map();
const ownerSignalHandlers = new Map();
let ownerSignalInProgress;

function ownerSignalError(signal) {
  return Object.assign(new Error(`The Control Center command owner received ${signal}.`), {
    code: "router_operation_interrupted",
    signal,
  });
}

function signalExitCode(signal) {
  return signal === "SIGINT" ? 130 : 143;
}

function removeOwnerSignalHandlers() {
  for (const [signal, handler] of ownerSignalHandlers) process.removeListener(signal, handler);
  ownerSignalHandlers.clear();
}

function ownerSignalBudget(environment = process.env) {
  const configured = Number(environment?.[OWNER_SIGNAL_BUDGET_ENV]);
  return Number.isSafeInteger(configured)
    && configured >= OWNER_SIGNAL_LEVEL_RESERVE_MS
    && configured <= OWNER_SIGNAL_CLEANUP_MS
    ? configured
    : undefined;
}

function contractedOwnerSignalBudget(environment = process.env) {
  const inherited = ownerSignalBudget(environment);
  if (environment?.[OWNER_SIGNAL_BUDGET_ENV] !== undefined && inherited === undefined) {
    const error = new Error("The inherited owner-signal cleanup budget is invalid.");
    error.code = "router_operation_signal_budget_invalid";
    throw error;
  }
  const contracted = (inherited ?? OWNER_SIGNAL_CLEANUP_MS) - OWNER_SIGNAL_LEVEL_RESERVE_MS;
  if (contracted < OWNER_SIGNAL_LEVEL_RESERVE_MS) {
    const error = new Error("The nested command tree exhausted its owner-signal cleanup reserve.");
    error.code = "router_operation_signal_depth_exceeded";
    throw error;
  }
  return contracted;
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
    ownerSignalBudgetMs: OWNER_SIGNAL_LEVEL_RESERVE_MS,
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
      || lease.ownerSignalBudgetMs < OWNER_SIGNAL_LEVEL_RESERVE_MS
      || lease.ownerSignalBudgetMs > OWNER_SIGNAL_CLEANUP_MS
    ) {
      active.push(conservativeOwnerSignalBarrier());
      continue;
    }
    if (lease.pid === ignorePid || !processAlive(lease.pid)) continue;
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

function createOwnerSignalCoordinator() {
  const directory = mkdtempSync(path.join(os.tmpdir(), "codex-router-owner-signal-"));
  let released = false;
  return {
    directory,
    release: () => {
      if (released) return;
      released = true;
      try {
        rmSync(directory, { recursive: true, force: true });
      } catch {
        // Completion is already proven by the process-tree boundary. Do not
        // hang the IPC promise on best-effort temporary-directory cleanup.
      }
    },
  };
}

async function forwardOwnerSignal(signal) {
  if (ownerSignalInProgress) return;
  ownerSignalInProgress = signal;
  const exitCode = signalExitCode(signal);
  const trees = [...ownedCommandTrees.values()];
  const remoteBarrierBudget = trees.reduce((maximum, tree) => Math.max(
    maximum,
    ownerSignalBarrierWaits(tree.barrierDirectory).shutdownMs,
  ), 0);
  const forcedExit = setTimeout(
    () => process.exit(exitCode),
    Math.max(
      ownerSignalBudget(process.env) ?? OWNER_SIGNAL_CLEANUP_MS,
      remoteBarrierBudget,
    ),
  );
  await Promise.allSettled(trees.map((tree) => tree.cleanup(signal)));
  clearTimeout(forcedExit);
  removeOwnerSignalHandlers();
  process.exit(exitCode);
}

function registerOwnedCommandTree(cleanup, { barrierDirectory } = {}) {
  const token = Symbol("owned-command-tree");
  ownedCommandTrees.set(token, { cleanup, barrierDirectory });
  if (ownerSignalHandlers.size === 0) {
    for (const signal of OWNER_SIGNALS) {
      const handler = () => { void forwardOwnerSignal(signal); };
      ownerSignalHandlers.set(signal, handler);
      process.on(signal, handler);
    }
  }
  return () => {
    ownedCommandTrees.delete(token);
    if (ownedCommandTrees.size === 0 && !ownerSignalInProgress) removeOwnerSignalHandlers();
  };
}

function pathEntries(
  environment,
  platform = process.platform,
  hostExecPath = process.execPath,
) {
  const home = os.homedir();
  const configuredNode = environment.CODEX_ROUTER_NODE_BIN;
  const candidates = [
    ...(configuredNode && path.isAbsolute(configuredNode) ? [path.dirname(configuredNode)] : []),
    ...String(environment.PATH || "").split(path.delimiter),
    ...(path.isAbsolute(hostExecPath) ? [path.dirname(hostExecPath)] : []),
    // GUI applications on macOS and Linux are commonly launched without the
    // login-shell PATH. Keep these explicit locations in the same search set
    // the Control Center uses when reporting an installed runtime.
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin",
    path.join(home, ".npm-global", "bin"),
    path.join(home, ".local", "bin"),
    path.join(home, ".volta", "bin"),
    path.join(home, ".asdf", "shims"),
    path.join(home, ".nvm", "current", "bin"),
    ...(platform === "win32"
      ? [
          environment.ProgramFiles ? path.join(environment.ProgramFiles, "nodejs") : undefined,
          environment.LOCALAPPDATA ? path.join(environment.LOCALAPPDATA, "Programs", "nodejs") : undefined,
          environment.APPDATA ? path.join(environment.APPDATA, "npm") : undefined,
        ]
      : []),
  ];
  return [...new Set(candidates.filter((candidate) => candidate && path.isAbsolute(candidate)))];
}

/**
 * Validate that a path can be executed, and return the path as named.
 *
 * The link target is resolved only to prove the entry is a regular file. The
 * name itself must be preserved: a version-manager shim such as volta's is one
 * dispatcher binary that decides what to run from the name it was invoked
 * under, so `~/.volta/bin/node` -> `volta-shim` only behaves as Node while it
 * is still called `node`. Returning the resolved target would hand a launcher
 * that refuses to start to `bin/install`, which records it in the background
 * service. `command -v` reports the unresolved path for the same reason.
 */
function runnableExecutable(candidate, platform = process.platform) {
  if (!candidate || !path.isAbsolute(candidate)) return undefined;
  try {
    accessSync(candidate, platform === "win32" ? fsConstants.F_OK : fsConstants.X_OK);
    return statSync(realpathSync(candidate)).isFile() ? candidate : undefined;
  } catch {
    return undefined;
  }
}

function discoverExecutable(
  environment,
  executable,
  platform = process.platform,
  hostExecPath = process.execPath,
) {
  const configured = executable === "node"
    ? runnableExecutable(environment.CODEX_ROUTER_NODE_BIN, platform)
    : undefined;
  if (configured) return configured;
  const names = platform === "win32" && !path.extname(executable)
    ? WINDOWS_EXECUTABLE_EXTENSIONS.map((extension) => `${executable}${extension}`)
    : [executable];
  for (const directory of pathEntries(environment, platform, hostExecPath)) {
    for (const name of names) {
      const found = runnableExecutable(path.join(directory, name), platform);
      if (found) return found;
    }
  }
  return undefined;
}

/**
 * Desktop apps do not inherit a user's login-shell environment. Keep the
 * router child commands able to invoke the checked-out POSIX/PowerShell
 * installers by adding the directory containing a real Node executable to
 * PATH. The router entrypoint itself can run inside Electron, but bin/install
 * intentionally uses `node` and `npm` by name.
 */
export function runtimeEnvironment(
  environment = process.env,
  {
    platform = process.platform,
    hostExecPath = process.execPath,
  } = {},
) {
  const node = discoverExecutable(environment, "node", platform, hostExecPath);
  if (!node) {
    // Do not hand an invalid explicit path to the installer. It would look
    // deliberate in the generated service definition and fail on every boot.
    const cleaned = { ...environment };
    delete cleaned.CODEX_ROUTER_NODE_BIN;
    return cleaned;
  }
  const npm = discoverExecutable(environment, "npm", platform, hostExecPath);
  const runtimeDirectories = [
    path.dirname(node),
    ...(npm ? [path.dirname(npm)] : []),
  ];
  const existing = String(environment.PATH || "")
    .split(path.delimiter)
    .filter(Boolean);
  const PATH = [
    ...runtimeDirectories,
    ...existing.filter((entry) => !runtimeDirectories.includes(entry)),
  ].join(path.delimiter);
  return {
    ...environment,
    PATH,
    // bin/install and install.ps1 re-resolve the runtime for the background
    // service. Naming the executable the app itself found keeps a GUI-started
    // install from picking a different Node than the one on this PATH, and it
    // is the value the installer trusts before any PATH lookup.
    CODEX_ROUTER_NODE_BIN: node,
  };
}

function pathIsInside(candidate, directory, platform = process.platform) {
  const pathApi = platform === "win32" ? path.win32 : path;
  const relative = pathApi.relative(pathApi.resolve(directory), pathApi.resolve(candidate));
  return relative === "" || (!relative.startsWith(`..${pathApi.sep}`) && !pathApi.isAbsolute(relative));
}

// Detached tray maintenance outlives the packaged UI and may replace its
// directory. On
// POSIX the mapped Electron executable can be unlinked safely; Windows locks
// it until every process exits, so running `control tray refresh` through that
// same executable makes the updater wait on its own package forever. The
// installer already requires and records a real Node runtime: use that exact
// external node.exe on Windows, and refuse rather than falling back to the
// packaged Electron binary.
export function detachedControlRuntime(
  environment = process.env,
  {
    platform = process.platform,
    execPath = process.execPath,
    electron = Boolean(process.versions.electron),
  } = {},
) {
  const childEnvironment = runtimeEnvironment(environment, {
    platform,
    hostExecPath: execPath,
  });
  if (platform === "win32" && electron) {
    const executable = discoverExecutable(childEnvironment, "node", platform, execPath);
    const packageDirectory = path.win32.dirname(execPath);
    if (
      !executable
      || path.win32.basename(executable).toLowerCase() !== "node.exe"
      || pathIsInside(executable, packageDirectory, platform)
    ) {
      throw new Error("A trusted external node.exe is required to refresh the Windows Control Center.");
    }
    delete childEnvironment.ELECTRON_RUN_AS_NODE;
    return { executable, environment: childEnvironment };
  }
  if (electron) childEnvironment.ELECTRON_RUN_AS_NODE = "1";
  return { executable: execPath, environment: childEnvironment };
}

function validSourceRoot(candidate) {
  if (!candidate || typeof candidate !== "string") return undefined;
  try {
    const root = realpathSync(path.resolve(candidate));
    const sourceDirectory = path.join(root, "src");
    const controlScript = path.join(root, "src", "control.mjs");
    const binaryDirectory = path.join(root, "bin");
    const controlBinary = path.join(root, "bin", "control");
    if (!existsSync(controlScript) || !existsSync(controlBinary)) return undefined;
    const required = [
      { stat: statSync(root), directory: true },
      { stat: statSync(sourceDirectory), directory: true },
      { stat: statSync(binaryDirectory), directory: true },
      { stat: statSync(controlScript), directory: false },
      { stat: statSync(controlBinary), directory: false },
    ];
    if (required.some((item) => item.directory ? !item.stat.isDirectory() : !item.stat.isFile())) {
      return undefined;
    }
    const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
    if (uid !== undefined) {
      if ((required.at(-1).stat.mode & 0o111) === 0) return undefined;
      for (const { stat } of required) {
        if (stat.uid !== uid && stat.uid !== 0) return undefined;
        if ((stat.mode & 0o022) !== 0) return undefined;
      }
    }
    return root;
  } catch {
    return undefined;
  }
}

function markedSourceRoot(marker) {
  if (!marker) return undefined;
  try {
    return validSourceRoot(readFileSync(marker, "utf8").trim());
  } catch {
    return undefined;
  }
}

function stateDirectory() {
  return (
    process.env.MODEL_ROUTER_STATE_DIR ||
    process.env.CODEX_ROUTER_STATE_DIR ||
    process.env.KIMI_CODEX_STATE_DIR ||
    path.join(process.env.CODEX_HOME || path.join(os.homedir(), ".codex"), "codex-router")
  );
}

/**
 * The control center can be launched from a development checkout while the
 * installed service and its generated state belong to another checkout. The
 * manifest is the router's ownership record; prefer it over the UI's own
 * checkout so writes and catalog rebuilds use the same registry as the live
 * service. Invalid or missing manifests are deliberately ignored and the
 * normal trusted-root fallback remains available.
 */
function recordedInstallManifest() {
  try {
    const manifestPath = path.join(stateDirectory(), "install-manifest.json");
    const directoryStat = statSync(path.dirname(manifestPath));
    const manifestStat = statSync(manifestPath);
    if (!directoryStat.isDirectory() || !manifestStat.isFile() || manifestStat.size > APP_CONTRACT_LIMIT) return undefined;
    const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
    if (
      uid !== undefined
      && (
        directoryStat.uid !== uid
        || (directoryStat.mode & 0o077) !== 0
        || manifestStat.uid !== uid
        || (manifestStat.mode & 0o077) !== 0
      )
    ) return undefined;
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    const recorded = manifest?.version === 1 ? manifest.current?.sourceRoot : undefined;
    const sourceRoot = validSourceRoot(recorded);
    if (!sourceRoot) return undefined;
    const rawPackageManager = manifest.current?.packageManager;
    const packageManager = rawPackageManager === null
      ? null
      : typeof rawPackageManager === "string" && /^[a-z0-9][a-z0-9._-]{0,80}$/i.test(rawPackageManager)
        ? rawPackageManager
        : undefined;
    // Only the proxy opt-in is read back, never the addresses: restoring an
    // address the environment does not name is `inheritedProxyEnvironment`'s
    // decision to defer, and AGENTS.md says not to widen that trigger here.
    const recordedProxy = manifest.current?.proxyEnvironment;
    const proxyOptIn = recordedProxy
      && typeof recordedProxy === "object"
      && !Array.isArray(recordedProxy)
      && recordedProxy.NODE_USE_ENV_PROXY === "1"
      ? "1"
      : undefined;
    return { sourceRoot, packageManager, proxyOptIn };
  } catch {
    return undefined;
  }
}

function recordedSourceRoot() {
  return recordedInstallManifest()?.sourceRoot;
}

function companionSourceRoots() {
  const candidates = [];
  if (typeof process.resourcesPath === "string" && process.resourcesPath) {
    candidates.push(path.join(process.resourcesPath, "router-root"));
  }
  if (process.platform === "darwin") {
    candidates.push(
      path.join(os.homedir(), "Applications", "Codex Router.app", "Contents", "Resources", "router-root"),
      path.join(os.homedir(), "Applications", "Model Router.app", "Contents", "Resources", "router-root"),
    );
  }
  return candidates.map(markedSourceRoot).filter(Boolean);
}

/** The stable checkout locations written by the platform installers. */
export function standardSourceRoots({
  platform = process.platform,
  environment = process.env,
  home = os.homedir(),
} = {}) {
  if (platform === "win32") {
    return environment.LOCALAPPDATA
      ? [path.join(environment.LOCALAPPDATA, "codex-router")]
      : [];
  }
  return [
    ...(environment.XDG_DATA_HOME
      ? [path.join(environment.XDG_DATA_HOME, "codex-router")]
      : []),
    path.join(home, ".local", "share", "codex-router"),
  ];
}

/** Resolve the checkout that owns the router. Never accept an arbitrary cwd. */
export function discoverSourceRoot() {
  // An explicit root is an operator/package-manager decision and must retain
  // precedence. It is still validated below, so a bad override cannot make
  // the app execute an arbitrary path.
  for (const explicit of [process.env.CODEX_ROUTER_SOURCE_ROOT, process.env.MODEL_ROUTER_SOURCE_ROOT]) {
    if (!explicit) continue;
    const root = validSourceRoot(explicit);
    if (root) return root;
  }
  const candidates = [
    recordedSourceRoot(),
    ...companionSourceRoots(),
    path.resolve(HERE, "..", "..", ".."),
    ...standardSourceRoots(),
    // Retained for installations made by router versions that predate the
    // stable platform-specific checkout path.
    path.join(os.homedir(), ".codex-router"),
  ];
  for (const candidate of candidates) {
    const root = validSourceRoot(candidate);
    if (root) return root;
  }
  throw new Error("Codex Router source root could not be located.");
}

function appControlContract(packagePath, { trustedCheckout = false } = {}) {
  try {
    const stat = statSync(packagePath);
    if (!stat.isFile() || stat.size > APP_CONTRACT_LIMIT) return undefined;
    if (trustedCheckout) {
      const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
      const parents = [path.dirname(packagePath), path.dirname(path.dirname(packagePath))];
      const parentStats = parents.map((directory) => statSync(directory));
      if (parentStats.some((item) => !item.isDirectory())) return undefined;
      if (
        uid !== undefined
        && [stat, ...parentStats].some((item) => (item.uid !== uid && item.uid !== 0) || (item.mode & 0o022) !== 0)
      ) return undefined;
    }
    const manifest = JSON.parse(readFileSync(packagePath, "utf8"));
    if (
      typeof manifest?.version !== "string"
      || !manifest.version.trim()
      || !Number.isInteger(manifest.controlProtocol)
      || manifest.controlProtocol < 1
    ) return undefined;
    return { version: manifest.version, controlProtocol: manifest.controlProtocol };
  } catch {
    return undefined;
  }
}

/** Refuse UI mutations when the app and installed control argv contract differ. */
export function assertMutationCompatibility(sourceRoot = discoverSourceRoot()) {
  const bundled = appControlContract(path.join(HERE, "..", "package.json"));
  const installed = appControlContract(
    path.join(sourceRoot, "apps", "control-center", "package.json"),
    { trustedCheckout: true },
  );
  if (
    bundled
    && installed
    && bundled.version === installed.version
    && bundled.controlProtocol === installed.controlProtocol
  ) return { bundled, installed };
  throw new Error(
    "This Control Center does not match the installed Codex Router control protocol. "
      + "Install or update the router and desktop app from the same build, then reopen the app.",
  );
}

export function safeFailure(message) {
  const text = String(message || "Router command failed.")
    .split("\n")
    .filter((line) => !SECRET_WORD.test(line))
    .join("\n")
    .replace(/(?:sk|key|token|secret)[-_A-Za-z0-9]{12,}/gi, "[redacted]");
  return text.slice(0, 1000) || "Router command failed.";
}

function killChildFallback(child) {
  try { child.kill("SIGKILL"); } catch { /* the process already exited */ }
}

function windowsPowerShell(environment = process.env) {
  const systemRoot = environment.SystemRoot || environment.WINDIR;
  const systemPowerShell = systemRoot
    ? path.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
    : undefined;
  return systemPowerShell && existsSync(systemPowerShell) ? systemPowerShell : "powershell.exe";
}

export function windowsJobProcessInvocation(
  command,
  args,
  {
    sourceRoot,
    environment = process.env,
    ownerPid = process.pid,
    windowsHide = true,
    windowsVerbatimArguments = false,
  },
) {
  const payload = Buffer.from(JSON.stringify({
    command,
    arguments: [...args],
    ownerProcessId: ownerPid,
    windowsHide: Boolean(windowsHide),
    windowsVerbatimArguments: Boolean(windowsVerbatimArguments),
  }), "utf8").toString("base64");
  return {
    command: windowsPowerShell(environment),
    args: [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy", "Bypass",
      "-File", path.join(sourceRoot, "src", "windows-process-tree.ps1"),
      payload,
    ],
  };
}

function processGroupAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    if (error?.code === "EPERM") return true;
    if (error?.code === "ESRCH") return false;
    throw error;
  }
}

async function waitForProcessGroupExit(pid, timeoutMs) {
  const deadline = Date.now() + Math.max(0, timeoutMs);
  while (processGroupAlive(pid)) {
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 20));
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
  } = {},
) {
  const startedAt = Date.now();
  const ordinaryDeadline = startedAt + Math.max(0, graceMs);
  while (processGroupAlive(pid)) {
    const barrierGraceMs = ownerSignalBarrierWaits(barrierDirectory, {
      ignorePid: barrierOwnerPid,
      ownBudgetMs: barrierOwnBudgetMs,
    }).graceMs;
    const deadline = Math.max(ordinaryDeadline, startedAt + barrierGraceMs);
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return true;
}

function treeCleanupError(pid) {
  return Object.assign(
    new Error(`The Control Center could not prove process group ${pid} terminated.`),
    { code: "router_process_tree_cleanup_failed" },
  );
}

async function waitForChildClose(child, timeoutMs = TREE_EXIT_WAIT_MS) {
  if (
    child?.exitCode !== null && child?.exitCode !== undefined
    || child?.signalCode !== null && child?.signalCode !== undefined
  ) return true;
  return new Promise((resolve) => {
    let settled = false;
    const finish = (closed) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.removeListener("close", onClose);
      child.removeListener("error", onClose);
      resolve(closed);
    };
    const onClose = () => finish(true);
    const timer = setTimeout(() => finish(false), timeoutMs);
    child.once("close", onClose);
    child.once("error", onClose);
  });
}

/**
 * A control command can spawn installers, service helpers, and other children.
 * Killing only the direct Node process on timeout leaves those descendants
 * mutating the installation after the UI reports failure. Keep the command in
 * its own POSIX process group or a kill-on-close Windows Job Object.
 */
export async function terminateProcessTree(
  child,
  {
    initialSignal = "SIGTERM",
    graceMs = 250,
    exitWaitMs = TREE_EXIT_WAIT_MS,
    barrierDirectory,
    barrierOwnerPid = process.pid,
    barrierOwnBudgetMs = ownerSignalBudget(process.env) ?? OWNER_SIGNAL_CLEANUP_MS,
  } = {},
) {
  if (!child?.pid) {
    killChildFallback(child);
    return;
  }
  if (process.platform === "win32") {
    await new Promise((resolve) => {
      const systemRoot = process.env.SystemRoot;
      const systemTaskkill = systemRoot ? path.join(systemRoot, "System32", "taskkill.exe") : undefined;
      const command = systemTaskkill && existsSync(systemTaskkill) ? systemTaskkill : "taskkill.exe";
      let settled = false;
      let killer;
      const finish = (successful) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (!successful) killChildFallback(child);
        resolve();
      };
      const timer = setTimeout(() => {
        try { killer?.kill("SIGKILL"); } catch { /* best effort */ }
        finish(false);
      }, 5_000);
      timer.unref();
      try {
        killer = spawn(command, ["/PID", String(child.pid), "/T", "/F"], {
          shell: false,
          windowsHide: true,
          stdio: "ignore",
        });
        killer.once("error", () => finish(false));
        killer.once("close", (code) => finish(code === 0));
      } catch {
        finish(false);
      }
    });
    if (!(await waitForChildClose(child))) throw treeCleanupError(child.pid);
    return;
  }

  if (!processGroupAlive(child.pid)) return;
  try { process.kill(-child.pid, initialSignal); }
  catch (error) {
    if (error?.code === "ESRCH") return;
    throw treeCleanupError(child.pid);
  }
  // Even if the group leader exits promptly, a descendant may ignore TERM.
  // Hold the mutation open through the escalation so app quit cannot cancel it.
  if (barrierDirectory) {
    if (await waitForProcessGroupExitWithOwnerSignalBarriers(child.pid, graceMs, {
      barrierDirectory,
      barrierOwnerPid,
      barrierOwnBudgetMs,
    })) return;
  } else if (await waitForProcessGroupExit(child.pid, graceMs)) return;
  try { process.kill(-child.pid, "SIGKILL"); }
  catch (error) {
    if (error?.code === "ESRCH") return;
    throw treeCleanupError(child.pid);
  }
  if (!(await waitForProcessGroupExit(child.pid, exitWaitMs))) {
    throw treeCleanupError(child.pid);
  }
}

/**
 * Run one of the fixed router commands. `args` are always an argv array and
 * never pass through a shell. `stdin` is used solely for API credentials.
 */
function runEntrypoint(entry, args = [], {
  stdin,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  maxOutputBytes = MAX_OUTPUT_BYTES,
  allowNonZero = false,
  environmentOverrides = {},
} = {}) {
  if (ownerSignalInProgress) throw ownerSignalError(ownerSignalInProgress);
  if (!Array.isArray(args) || args.some((arg) => typeof arg !== "string" || arg.includes("\0"))) {
    throw new TypeError("Router command arguments must be strings.");
  }
  if (
    !environmentOverrides
    || typeof environmentOverrides !== "object"
    || Array.isArray(environmentOverrides)
    || Object.entries(environmentOverrides).some(([key, value]) => (
      !/^[A-Z][A-Z0-9_]*$/.test(key)
      || typeof value !== "string"
      || value.includes("\0")
    ))
  ) throw new TypeError("Router command environment overrides must be string values.");
  const sourceRoot = discoverSourceRoot();
  const runtimeBaseline = runtimeEnvironment(process.env);
  // A desktop app starts a fresh ordinary operation epoch. It may have been
  // launched by a previous repair/update command, so never let that deadline
  // poison every later click. The owner-signal budget is read separately from
  // process.env and contracted below when this app really is a nested owner.
  delete runtimeBaseline.CODEX_ROUTER_OPERATION_DEADLINE_MS;
  delete runtimeBaseline.CODEX_ROUTER_OPERATION_TIMEOUT_MS;
  delete runtimeBaseline.CODEX_ROUTER_OPERATION_CHILD;
  delete runtimeBaseline[OWNER_SIGNAL_BUDGET_ENV];
  delete runtimeBaseline[OWNER_SIGNAL_BARRIER_DIR_ENV];
  const childEnvironment = {
    ...runtimeBaseline,
    MODEL_ROUTER_SOURCE_ROOT: sourceRoot,
    MODEL_ROUTER_TARGET: "codex",
    ...(process.versions.electron ? { ELECTRON_RUN_AS_NODE: "1" } : {}),
    ...environmentOverrides,
  };
  const recordedInstall = recordedInstallManifest();
  // The address and the permission to use it are separate answers, and this
  // app is launched by the desktop session rather than by the service: it
  // inherits HTTP_PROXY from the login environment but nothing that says Node
  // may use it. A router child then dials a proxied host directly and reports
  // the connect timeout as the provider failing -- which is how a reachable
  // Venice catalog came back as "fetch failed". The service definition already
  // resolves this the same way; see serviceProxyEnvironment().
  if (
    recordedInstall?.sourceRoot === sourceRoot
    && recordedInstall.proxyOptIn === "1"
    && childEnvironment.NODE_USE_ENV_PROXY === undefined
    && (
      childEnvironment.HTTP_PROXY ?? childEnvironment.http_proxy
      ?? childEnvironment.HTTPS_PROXY ?? childEnvironment.https_proxy
    )
  ) {
    childEnvironment.NODE_USE_ENV_PROXY = "1";
  }
  if (recordedInstall?.sourceRoot === sourceRoot && recordedInstall.packageManager !== undefined) {
    if (recordedInstall.packageManager === null) delete childEnvironment.CODEX_ROUTER_PACKAGE_MANAGER;
    else childEnvironment.CODEX_ROUTER_PACKAGE_MANAGER = recordedInstall.packageManager;
  }
  const boundedTimeoutMs = Math.max(250, Math.min(timeoutMs, MAX_TIMEOUT_MS));
  const cleanupMarginMs = Math.min(10_000, Math.max(1, boundedTimeoutMs - 1));
  const maximumInnerMs = Math.max(1, boundedTimeoutMs - cleanupMarginMs);
  const requestedInnerMs = Number(childEnvironment.CODEX_ROUTER_OPERATION_TIMEOUT_MS);
  const innerTimeoutMs = Number.isSafeInteger(requestedInnerMs) && requestedInnerMs > 0
    ? Math.min(requestedInnerMs, maximumInnerMs)
    : maximumInnerMs;
  const requestedDeadline = Number(childEnvironment.CODEX_ROUTER_OPERATION_DEADLINE_MS);
  const innerDeadline = Number.isSafeInteger(requestedDeadline) && requestedDeadline > 0
    ? Math.min(requestedDeadline, Date.now() + innerTimeoutMs)
    : Date.now() + innerTimeoutMs;
  childEnvironment.CODEX_ROUTER_OPERATION_TIMEOUT_MS = String(innerTimeoutMs);
  childEnvironment.CODEX_ROUTER_OPERATION_DEADLINE_MS = String(innerDeadline);
  // This Electron runner already owns and terminates the complete process
  // group. Mark control as the bounded child so it does not add a redundant
  // nested owner whose cleanup reserve would consume short 20s read budgets.
  childEnvironment.CODEX_ROUTER_OPERATION_CHILD = "1";
  const childSignalBudget = contractedOwnerSignalBudget(process.env);
  childEnvironment[OWNER_SIGNAL_BUDGET_ENV] = String(childSignalBudget);
  const coordinator = createOwnerSignalCoordinator();
  childEnvironment[OWNER_SIGNAL_BARRIER_DIR_ENV] = coordinator.directory;
  return new Promise((resolve, reject) => {
    // A packaged Electron binary can run trusted Node entrypoints without a
    // separately installed runtime. In CLI/tests process.execPath is already
    // Node; in the desktop host ELECTRON_RUN_AS_NODE switches that same signed
    // executable into its Node mode.
    const invocation = process.platform === "win32"
      ? windowsJobProcessInvocation(process.execPath, [entry, ...args], {
          sourceRoot,
          environment: childEnvironment,
        })
      : { command: process.execPath, args: [entry, ...args] };
    let child;
    try {
      child = spawn(invocation.command, invocation.args, {
        cwd: sourceRoot,
        detached: process.platform !== "win32",
        env: childEnvironment,
        shell: false,
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (error) {
      coordinator.release();
      reject(error);
      return;
    }
    let stdout = "";
    let stderr = "";
    let bytes = 0;
    let settled = false;
    let aborting = false;
    let discardOutput = false;
    let terminalError;
    let terminationPromise;
    let timer;
    let unregisterOwner = () => {};
    let childCloseResolve;
    let childClosed = false;
    const childClose = new Promise((resolveClose) => { childCloseResolve = resolveClose; });
    const waitForCapturedClose = async (timeoutMs = TREE_EXIT_WAIT_MS) => {
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
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      unregisterOwner();
      coordinator.release();
      fn(value);
    };
    const abortCommand = (error, { initialSignal = "SIGTERM", ownerSignal = false } = {}) => {
      if (settled) return Promise.resolve();
      if (terminationPromise) return terminationPromise;
      aborting = true;
      discardOutput = true;
      clearTimeout(timer);
      terminationPromise = (async () => {
        try {
          const ownBudget = ownerSignalBudget(process.env) ?? OWNER_SIGNAL_CLEANUP_MS;
          await terminateProcessTree(child, {
            initialSignal,
            graceMs: ownerSignal ? childSignalBudget : 250,
            exitWaitMs: ownerSignal ? OWNER_SIGNAL_GROUP_EXIT_WAIT_MS : TREE_EXIT_WAIT_MS,
            barrierDirectory: coordinator.directory,
            barrierOwnerPid: process.pid,
            barrierOwnBudgetMs: ownBudget,
          });
          if (!(await waitForCapturedClose(
            ownerSignal ? OWNER_SIGNAL_CLOSE_WAIT_MS : TREE_EXIT_WAIT_MS,
          ))) throw treeCleanupError(child.pid);
          finish(reject, error);
        } catch (cleanupError) {
          finish(reject, new AggregateError(
            [error, cleanupError],
            "The Control Center command failed and its process tree could not be fully terminated.",
            { cause: error },
          ));
        }
      })();
      return terminationPromise;
    };
    timer = setTimeout(() => {
      void abortCommand(new Error("Router command timed out."));
    }, boundedTimeoutMs);
    child.stdout.on("data", (chunk) => {
      if (settled || discardOutput) return;
      bytes += chunk.length;
      if (bytes > maxOutputBytes) {
        const error = new Error("Router command output exceeded its limit.");
        if (aborting) {
          terminalError = error;
          discardOutput = true;
        } else {
          void abortCommand(error);
        }
        return;
      }
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      if (settled || discardOutput) return;
      // Keep stderr in memory only; never write it to a log or console.
      if (stderr.length < 16_384) {
        stderr += chunk.toString("utf8").slice(0, 16_384 - stderr.length);
      }
    });
    child.stdin.on("error", () => { /* termination can close the pipe mid-write */ });
    child.on("error", (error) => {
      if (!aborting) finish(reject, new Error(safeFailure(error.message)));
    });
    const settleLeaderExit = (code, signal) => {
      if (aborting || settled) return;
      aborting = true;
      clearTimeout(timer);
      terminationPromise = (async () => {
        try {
          // The Windows Job Object owner closes only after every member is
          // gone. POSIX requires this explicit residual-group retirement when
          // the direct child exits before a grandchild.
          if (process.platform !== "win32") {
            await terminateProcessTree(child, {
              barrierDirectory: coordinator.directory,
              barrierOwnerPid: process.pid,
            });
            if (!(await waitForCapturedClose())) throw treeCleanupError(child.pid);
          }
          if (terminalError) {
            finish(reject, terminalError);
            return;
          }
          if (code === 0 || allowNonZero) finish(resolve, { stdout, stderr, code, signal });
          else finish(reject, new Error(safeFailure(stderr) || `Router command failed (${code ?? signal}).`));
        } catch (error) {
          finish(reject, error);
        }
      })();
    };
    child.on("exit", (code, signal) => {
      if (process.platform !== "win32") settleLeaderExit(code, signal);
    });
    child.on("close", (code, signal) => {
      childClosed = true;
      childCloseResolve();
      if (process.platform === "win32") settleLeaderExit(code, signal);
    });
    unregisterOwner = registerOwnedCommandTree((ownerSignal) => (
      abortCommand(ownerSignalError(ownerSignal), {
        initialSignal: ownerSignal,
        ownerSignal: true,
      })
    ), { barrierDirectory: coordinator.directory });
    if (stdin === undefined) child.stdin.end();
    else {
      if (typeof stdin !== "string" && !Buffer.isBuffer(stdin)) {
        void abortCommand(new TypeError("Credential input must be text."));
      } else {
        child.stdin.end(stdin);
      }
    }
  });
}

export function runControlDetached(
  args = [],
  {
    sourceRoot = discoverSourceRoot(),
    runtime = detachedControlRuntime(),
    spawnImpl = spawn,
  } = {},
) {
  if (!Array.isArray(args) || args.some((arg) => typeof arg !== "string" || arg.includes("\0"))) {
    throw new TypeError("Router command arguments must be strings.");
  }
  const childEnvironment = {
    ...runtime.environment,
    MODEL_ROUTER_SOURCE_ROOT: sourceRoot,
    MODEL_ROUTER_TARGET: "codex",
  };
  // These detached commands deliberately outlive this UI request (maintenance
  // may replace the packaged app). They start a fresh bounded operation rather
  // than inheriting an almost-expired deadline from their launcher.
  delete childEnvironment.CODEX_ROUTER_OPERATION_DEADLINE_MS;
  delete childEnvironment.CODEX_ROUTER_OPERATION_TIMEOUT_MS;
  delete childEnvironment.CODEX_ROUTER_OPERATION_CHILD;
  delete childEnvironment[OWNER_SIGNAL_BUDGET_ENV];
  delete childEnvironment[OWNER_SIGNAL_BARRIER_DIR_ENV];
  return new Promise((resolve, reject) => {
    const child = spawnImpl(
      runtime.executable,
      [path.join(sourceRoot, "src", "control.mjs"), ...args],
      {
        cwd: sourceRoot,
        detached: true,
        env: childEnvironment,
        shell: false,
        windowsHide: true,
        stdio: "ignore",
      },
    );
    let settled = false;
    // `spawn()` returning a ChildProcess is not proof that the OS accepted the
    // executable. Resolve only at Node's spawn event; a missing or denied
    // runtime emits error first and must reach the UI as a failed action.
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      reject(new Error(safeFailure(error?.message || "Detached router command could not start.")));
    });
    child.once("spawn", () => {
      if (settled) return;
      settled = true;
      // Tray maintenance may atomically replace this very packaged app. With
      // no pipe owned by the UI and a detached process group, it remains alive
      // after the parent accepts the updater's graceful quit request.
      child.unref();
      resolve(child.pid);
    });
  });
}

export function runControl(args = [], options = {}) {
  if (!Array.isArray(args) || args.some((arg) => typeof arg !== "string" || arg.includes("\0"))) {
    throw new TypeError("Router command arguments must be strings.");
  }
  const sourceRoot = discoverSourceRoot();
  return runEntrypoint(path.join(sourceRoot, "src", "control.mjs"), args, options);
}

export async function runControlJson(args = [], options = {}) {
  const result = await runControl(args, options);
  try {
    return JSON.parse(result.stdout.trim());
  } catch {
    throw new Error("Router returned invalid JSON.");
  }
}

export async function runRouterScript(scriptName, args = [], options = {}) {
  if (!/^[a-z0-9-]+\.mjs$/i.test(scriptName)) throw new Error("Invalid router script.");
  const sourceRoot = discoverSourceRoot();
  const script = path.join(sourceRoot, "src", scriptName);
  if (!existsSync(script)) throw new Error("Router script is unavailable.");
  if (!Array.isArray(args) || args.some((arg) => typeof arg !== "string" || arg.includes("\0"))) {
    throw new TypeError("Router script arguments must be strings.");
  }
  return runEntrypoint(script, args, options);
}
