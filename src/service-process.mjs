import { readFileSync, unlinkSync } from "node:fs";
import path from "node:path";

import { writePrivateJson } from "./file-security.mjs";
import {
  PORTS,
  SERVICE_PROCESS_STATE_PATH,
  SOURCE_ROOT,
  STATE_DIR,
} from "./paths.mjs";
import {
  COLD_START_WINDOWS_PROBE_BUDGET,
  processCommandLine,
  processStartIdentity,
} from "./process-identity.mjs";

const STATE_VERSION = 1;

function normalized(value) {
  return String(value || "").replaceAll("\\", "/").toLowerCase();
}

function entrypointFor(sourceRoot) {
  return normalized(path.join(sourceRoot, "src", "start.mjs"));
}

function safePid(pid) {
  return Number.isSafeInteger(pid) && pid > 0 ? pid : undefined;
}

export function buildServiceProcessState({
  pid = process.pid,
  platform = process.platform,
  identity = processStartIdentity,
  commandLine = processCommandLine,
  sourceRoot = SOURCE_ROOT,
  stateDir = STATE_DIR,
  ports = PORTS,
  probeBudget,
} = {}) {
  const safe = safePid(pid);
  if (!safe) return undefined;
  const processIdentity = identity(safe, { platform, budget: probeBudget });
  const liveCommandLine = commandLine(safe, { platform, budget: probeBudget });
  if (!processIdentity || !liveCommandLine) return undefined;
  const entrypoint = entrypointFor(sourceRoot);
  if (!normalized(liveCommandLine).includes(entrypoint)) return undefined;
  return {
    version: STATE_VERSION,
    managed: true,
    pid: safe,
    processIdentity: String(processIdentity),
    commandLine: String(liveCommandLine),
    sourceRoot: path.resolve(sourceRoot),
    stateDir: path.resolve(stateDir),
    ports: Object.fromEntries(
      Object.entries(ports || {})
        .filter(([, value]) => Number.isSafeInteger(value) && value > 0)
        .map(([name, value]) => [name, value]),
    ),
    startedAt: Date.now(),
  };
}

export function writeServiceProcessState(options = {}) {
  const state = buildServiceProcessState({
    ...options,
    // The one call site allowed to wait out a cold powershell.exe: this runs
    // before any child starts, and there is no enclosing deadline to outlive.
    probeBudget: COLD_START_WINDOWS_PROBE_BUDGET,
  });
  if (!state) {
    throw new Error(
      "The Windows service could not verify its own start.mjs process identity; refusing to run without a stoppable process record.",
    );
  }
  writePrivateJson(options.statePath || SERVICE_PROCESS_STATE_PATH, state, {
    // This record is the only thing that lets the Windows service manager stop
    // the tree it owns, so losing the write is fatal -- but a PowerShell that
    // cannot start must not be what loses it. It carries a PID, an identity
    // string, paths and ports, never a credential, and what makes it safe to
    // act on is the verification in serviceProcessOwns below, not its secrecy:
    // a hand-edited record for another checkout is rejected on sourceRoot,
    // stateDir, command line and identity before any PID can be signalled.
    //
    // The fallback is the state directory's inherited ACL (SYSTEM,
    // Administrators and the owner all hold FullControl on this profile path),
    // not an owner-only one. That is a weaker ACL on a non-secret file for as
    // long as the helper cannot run; the alternative was refusing to start the
    // whole router over it.
    hardenFailure: "warn",
  });
  return state;
}

export function readServiceProcessState(statePath = SERVICE_PROCESS_STATE_PATH) {
  try {
    const state = JSON.parse(readFileSync(statePath, "utf8"));
    return state?.version === STATE_VERSION && state?.managed === true ? state : undefined;
  } catch {
    return undefined;
  }
}

export function clearServiceProcessState(statePath = SERVICE_PROCESS_STATE_PATH) {
  try {
    unlinkSync(statePath);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

export function serviceProcessOwns(
  state,
  {
    platform = process.platform,
    identity = processStartIdentity,
    commandLine = processCommandLine,
    sourceRoot = SOURCE_ROOT,
    stateDir = STATE_DIR,
    // Deliberately the tight default: this runs inside a service stop that
    // declares 15s and a restart phase that reserves 10s for the process-owner
    // check, so it must not be able to wait out a cold host.
    probeBudget,
  } = {},
) {
  const pid = safePid(state?.pid);
  if (
    !state ||
    state.version !== STATE_VERSION ||
    state.managed !== true ||
    !pid ||
    typeof state.processIdentity !== "string" ||
    !state.processIdentity ||
    typeof state.commandLine !== "string" ||
    !state.commandLine ||
    typeof state.sourceRoot !== "string" ||
    !state.sourceRoot ||
    typeof state.stateDir !== "string" ||
    !state.stateDir
  ) {
    return false;
  }
  // The record lives in a user-writable state directory. Require both path
  // anchors to still be this installation before a PID can be terminated; a
  // hand-edited record for another checkout must never become a kill switch.
  if (
    normalized(state.sourceRoot) !== normalized(path.resolve(sourceRoot)) ||
    normalized(state.stateDir) !== normalized(path.resolve(stateDir))
  ) {
    return false;
  }
  const entrypoint = entrypointFor(state.sourceRoot);
  if (!normalized(state.commandLine).includes(entrypoint)) return false;
  if (identity(pid, { platform, budget: probeBudget }) !== state.processIdentity) return false;
  const liveCommandLine = commandLine(pid, { platform, budget: probeBudget });
  return Boolean(liveCommandLine && normalized(liveCommandLine).includes(entrypoint));
}
