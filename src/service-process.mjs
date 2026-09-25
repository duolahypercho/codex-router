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

// Build the record, or say precisely why it could not be built. The reason is
// part of the contract rather than a debug string: the operator's next move is
// completely different for "this host cannot run the probe right now" than for
// "the probe answered and the answer disagreed", and the original failure
// message said neither -- a cold-host startup failure read as
// "could not verify its own start.mjs process identity" while the actual cause
// was twenty-two ACL-helper timeouts in the same log.
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
  if (!safe) {
    return { failure: "pid-invalid", detail: `pid ${String(pid)} is not a usable process id` };
  }

  const processIdentity = identity(safe, { platform, budget: probeBudget });
  if (!processIdentity) {
    return {
      failure: "identity-unavailable",
      detail: "the identity probe did not answer within its budget",
    };
  }

  const liveCommandLine = commandLine(safe, { platform, budget: probeBudget });
  if (!liveCommandLine) {
    return {
      failure: "command-line-unavailable",
      detail: "the command-line probe did not answer within its budget",
    };
  }
  const entrypoint = entrypointFor(sourceRoot);
  if (!normalized(liveCommandLine).includes(entrypoint)) {
    return {
      failure: "command-line-mismatch",
      detail: `the live command line does not contain ${entrypoint}`,
    };
  }

  return {
    state: {
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
    },
  };
}

export function buildServiceProcessState(options = {}) {
  return probeServiceProcessState(options).state;
}

export function writeServiceProcessState(options = {}) {
  const probe = probeServiceProcessState({
    ...options,
    // The one call site allowed to wait out a cold powershell.exe: this runs
    // before any child starts, and there is no enclosing deadline to outlive.
    probeBudget: COLD_START_WINDOWS_PROBE_BUDGET,
  });
  if (!probe.state) {
    throw new Error(
      "The Windows service could not verify its own start.mjs process identity; refusing to run " +
        `without a stoppable process record (${probe.failure}: ${probe.detail}).`,
    );
  }
  writePrivateJson(options.statePath || SERVICE_PROCESS_STATE_PATH, probe.state, {
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
  return probe.state;
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

// Whether a stop may clear the record because the tree is accounted for. Only
// an ANSWERED "not ours" qualifies: "unknown" means the probe could not run, and
// clearing on that would strand a live tree while reporting the stop complete --
// the same conflation the ownership tri-state exists to remove, one layer down.
// Named rather than inlined so the rule is testable; the defect it guards
// against was an `ownership !== "owned"` reading of the same two facts.
export function serviceRecordSettled({ ownership, portListening } = {}) {
  return ownership === "foreign" && !portListening;
}

// True when the recorded state still describes a live process this router
// started. Everything that stops or signals a managed process goes through
// this, so a server somebody else is running is never touched.
export function serviceProcessOwns(state, options = {}) {
  return serviceProcessOwnership(state, options) === "owned";
}

// The same question with the third answer a caller that is about to signal a
// process needs: "owned", "foreign", or "unknown" when the probe could not run
// at all. An ANSWERED "absent" is foreign -- the record is stale, not
// unidentifiable -- and that distinction comes from the probe, which is the
// default seam. `identity` is the historical seam, taken only when supplied; it
// cannot distinguish absent from unanswerable, so a non-answer maps to
// "unknown" exactly as it did before.
//
// The default being the probe is not a detail: when the probe was the opt-in
// instead, the stop path -- which passes neither seam -- took the collapsing
// branch, so an absent process read as "unknown", serviceRecordSettled could
// never be true, and the record was never cleared after a successful stop.
//
// serviceProcessOwns collapses unknown into "not owned", which is the safe
// answer for permission but the wrong one to *report* as a completed stop, and
// the wrong one to clear the record on: clearing on unknown strands a live tree
// while reporting the stop complete.
export function serviceProcessOwnership(
  state,
  {
    platform = process.platform,
    identity,
    probe,
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
  if (identity) {
    const live = identity(pid, { platform, budget: probeBudget });
    if (live === undefined) return "unknown";
    if (live !== state.processIdentity) return "foreign";
  } else {
    const probed = (probe ?? processStartIdentityProbe)(pid, { platform, budget: probeBudget });
    if (probed.state === "absent") return "foreign";
    if (probed.state === "unknown") return "unknown";
    if (probed.identity !== state.processIdentity) return "foreign";
  }
  const liveCommandLine = commandLine(pid, { platform, budget: probeBudget });
  if (liveCommandLine === undefined) return "unknown";
  return normalized(liveCommandLine).includes(entrypoint) ? "owned" : "foreign";
}
