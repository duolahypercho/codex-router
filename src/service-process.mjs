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
  processStartIdentityProbe,
} from "./process-identity.mjs";
import { startupTimeoutMs } from "./startup-timeout.mjs";

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

// `bin/start --foreground` and `codex-router.ps1 start --foreground` enter
// through src/foreground-start.mjs, the explicit unmanaged debugging
// supervisor. Its command line names foreground-start.mjs, never
// src/start.mjs, so it could never pass the entrypoint check below -- and it
// must not try: this record is the Windows service manager's handle on the
// OS-service payload, a direct src/start.mjs, and only that payload refuses to
// run without it. The opt-out is an explicit flag rather than a comparison of
// process.argv[1] with this checkout's start.mjs because the flag fails
// closed: every other importer still records, where a casing or junction
// difference in argv would let a managed start silently skip its record.
let foregroundSupervisor = false;

export function markForegroundSupervisor() {
  foregroundSupervisor = true;
}

export function isForegroundSupervisor() {
  return foregroundSupervisor;
}

export function shouldRecordServiceProcess({
  platform = process.platform,
  foreground = foregroundSupervisor,
} = {}) {
  return platform === "win32" && !foreground;
}

export function probeServiceProcessState({
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
  if (!safe) return { failure: "pid-invalid" };
  const processIdentity = identity(safe, { platform, budget: probeBudget });
  if (!processIdentity) return { failure: "identity-unavailable" };
  const liveCommandLine = commandLine(safe, { platform, budget: probeBudget });
  if (!liveCommandLine) return { failure: "command-line-unavailable" };
  const entrypoint = entrypointFor(sourceRoot);
  if (!normalized(liveCommandLine).includes(entrypoint)) return { failure: "command-line-mismatch" };
  const state = {
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
  return { state };
}

export function buildServiceProcessState(options = {}) {
  return probeServiceProcessState(options).state;
}

export function writeServiceProcessState(options = {}) {
  const probe = probeServiceProcessState({
    ...options,
    // The one call site allowed to wait out a cold powershell.exe: this runs
    // before any child starts, and there is no enclosing deadline to outlive.
    probeBudget: {
      ...COLD_START_WINDOWS_PROBE_BUDGET,
      timeoutMs: startupTimeoutMs(
        "CODEX_ROUTER_WINDOWS_PROCESS_PROBE_TIMEOUT_MS",
        COLD_START_WINDOWS_PROBE_BUDGET.timeoutMs,
      ),
    },
  });
  if (!probe.state) {
    const error = new Error(
      "The Windows service could not verify its own start.mjs process identity; "
        + `refusing to run without a stoppable process record (${probe.failure}).`,
    );
    error.serviceProcessFailure = probe.failure;
    throw error;
  }
  const state = probe.state;
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

function validServiceProcessRecord(state) {
  return Boolean(state && state.version === STATE_VERSION && state.managed === true &&
    safePid(state.pid) && ["processIdentity", "commandLine", "sourceRoot", "stateDir"]
      .every((key) => typeof state[key] === "string" && state[key].length > 0));
}

export function readServiceProcessState(statePath = SERVICE_PROCESS_STATE_PATH, { strict = false } = {}) {
  try {
    const state = JSON.parse(readFileSync(statePath, "utf8"));
    if (strict && !validServiceProcessRecord(state)) throw new Error("Invalid service process record.");
    if (state?.version === STATE_VERSION && state?.managed === true) return state;
    if (strict) throw new Error("Invalid service process record.");
    return undefined;
  } catch (error) {
    if (strict && error?.code !== "ENOENT") {
      throw new Error("The service process record could not be read or validated.");
    }
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

export function serviceRecordSettled({ ownership, portListening } = {}) {
  return ownership === "foreign" && portListening === false;
}

export function serviceProcessOwns(state, options = {}) {
  return serviceProcessOwnership(state, options) === "owned";
}

// Permission to signal and proof of shutdown are different questions. Keep an
// unavailable OS probe distinct from an answered absent or foreign process.
export function serviceProcessOwnership(
  state,
  {
    platform = process.platform,
    identity,
    probe = processStartIdentityProbe,
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
  if (!validServiceProcessRecord(state)) {
    return "foreign";
  }
  // The record lives in a user-writable state directory. Require both path
  // anchors to still be this installation before a PID can be terminated; a
  // hand-edited record for another checkout must never become a kill switch.
  if (
    normalized(state.sourceRoot) !== normalized(path.resolve(sourceRoot)) ||
    normalized(state.stateDir) !== normalized(path.resolve(stateDir))
  ) {
    return "foreign";
  }
  const entrypoint = entrypointFor(state.sourceRoot);
  if (!normalized(state.commandLine).includes(entrypoint)) return "foreign";
  try {
    if (identity) {
      // Preserve the historical injected identity seam. A non-answer cannot
      // distinguish absence from an unavailable probe.
      const live = identity(pid, { platform, budget: probeBudget });
      if (!live) return "unknown";
      if (live !== state.processIdentity) return "foreign";
    } else {
      const result = probe(pid, { platform, budget: probeBudget });
      if (result?.state === "absent") return "foreign";
      if (result?.state !== "alive" || !result.identity) return "unknown";
      if (result.identity !== state.processIdentity) return "foreign";
    }
    const liveCommandLine = commandLine(pid, { platform, budget: probeBudget });
    if (!liveCommandLine) return "unknown";
    return normalized(liveCommandLine).includes(entrypoint) ? "owned" : "foreign";
  } catch {
    return "unknown";
  }
}
