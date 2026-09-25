import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

// The default budget is deliberately the tight one this probe has always had.
// It is spent inside bounded operations -- a Windows service stop that declares
// 15s, a restart phase that reserves 10s for the process-owner check and must
// still leave the router's own readiness allowance intact -- so widening it
// here would let a slow probe outlive the deadline of the operation that asked
// for it. A caller that can afford to wait out a cold powershell.exe has to
// ask: only the service-process record does, with
// COLD_START_WINDOWS_PROBE_BUDGET.
const DEFAULT_WINDOWS_PROBE_BUDGET = Object.freeze({ timeoutMs: 5_000, attempts: 1 });

// The service-process record is written before anything else starts, on a path
// with no enclosing deadline, so it is the one caller that can spend a cold
// host's latency instead of failing the whole service.
//
// Measured 2026-09-23, on a Windows boot under logon load: every powershell.exe
// spawn exceeded fifteen seconds -- the private-file ACL helper, which allows
// 15s, logged `spawnSync powershell.exe ETIMEDOUT` twenty-two times in one boot
// window -- while this probe allowed five. start.mjs could not record its own
// identity, refused to run without a stoppable process record, and the task's
// one-minute heartbeat relaunched it into the same failure for forty minutes
// while the desktop client showed "Reconnecting... waiting for network". The
// same probes measure 0.9-1.6s on an idle host, which is why this only ever
// appeared after a restart. The 45s allowance matches the interpreter probe in
// start.mjs, which is already treated as a scheduling artifact rather than a
//
// The retry is deliberately not a silent fallback: a probe that answers with a
// non-zero exit is a decision, not a stall, and is returned as-is. Only a
// timeout -- where nothing was learned -- spends a second attempt.
export const COLD_START_WINDOWS_PROBE_BUDGET = Object.freeze({ timeoutMs: 45_000, attempts: 2 });

// The absolute system PowerShell, for the same reason process-tree.mjs resolves
// it: a PATH entry that shadows powershell.exe must not decide whether this
// process can prove which PID it is about to signal.
function windowsPowerShell(environment = process.env) {
  const systemRoot = environment.SystemRoot || environment.WINDIR;
  const systemPowerShell = systemRoot
    ? path.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
    : undefined;
  return systemPowerShell && existsSync(systemPowerShell) ? systemPowerShell : "powershell.exe";
}

function windowsProbeBudget(budget) {
  const timeoutMs = Number.isSafeInteger(budget?.timeoutMs) && budget.timeoutMs > 0
    ? budget.timeoutMs
    : DEFAULT_WINDOWS_PROBE_BUDGET.timeoutMs;
  const attempts = Number.isSafeInteger(budget?.attempts) && budget.attempts > 0
    ? budget.attempts
    : DEFAULT_WINDOWS_PROBE_BUDGET.attempts;
  return { timeoutMs, attempts };
}

function windowsProbeTimedOut(result) {
  return result?.error?.code === "ETIMEDOUT";
}

// One bounded Windows probe, retried only while the previous attempt timed out.
function windowsProbe(script, { spawn, environment, budget }) {
  const { timeoutMs, attempts } = windowsProbeBudget(budget);
  let result;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    result = spawn(
      windowsPowerShell(environment),
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
      {
        encoding: "utf8",
        windowsHide: true,
        timeout: timeoutMs,
      },
    );
    if (!windowsProbeTimedOut(result)) return result;
  }
  return result;
}

// A PID alone is not an identity: the operating system reuses them, and a
// router that remembers only a number can eventually send a signal to whatever
// inherited it. Pair the PID with the process's start time and executable, and
// require both to match before acting on it.
//
// Extracted from ollama-runtime.mjs when the harness web server needed the same
// guarantee. Nothing here is specific to either program.
export function processStartIdentity(
  pid,
  { spawn = spawnSync, platform = process.platform, environment = process.env, budget } = {},
) {
  const result = processStartIdentityProbe(pid, { spawn, platform, environment, budget });
  return result.state === "alive" ? result.identity : undefined;
}

export function processStartIdentityProbe(
  pid,
  { spawn = spawnSync, platform = process.platform, environment = process.env, budget } = {},
) {
  if (!Number.isSafeInteger(pid) || pid < 1) return { state: "unknown" };
  try {
    if (platform === "win32") {
      const script =
        `$p = Get-Process -Id ${pid} -ErrorAction SilentlyContinue; ` +
        "if ($null -eq $p) { exit 3 }; " +
        `[Console]::Out.Write($p.StartTime.ToUniversalTime().Ticks.ToString() + '|' + $p.Path)`;
      const result = windowsProbe(script, { spawn, environment, budget });
      const identity = String(result.stdout || "").trim();
      if (result.status === 0 && identity) return { state: "alive", identity };
      if (result.status === 3) return { state: "absent" };
      return { state: "unknown" };
    }
    const result = spawn("ps", ["-p", String(pid), "-o", "lstart=", "-o", "comm="], {
      encoding: "utf8",
    });
    const identity = String(result.stdout || "").trim();
    if (result.status === 0 && identity) return { state: "alive", identity };
    if (result.status === 1) return { state: "absent" };
    return { state: "unknown" };
  } catch {
    return { state: "unknown" };
  }
}

// Return the command line for a live process. A start time and executable are
// enough to reject PID reuse, but they do not prove that a Node process belongs
// to this checkout. The Windows service uses this extra identity before it
// recursively terminates the router tree.
//
// There is deliberately no fallback for this probe. It is the anchor that
// proves the live PID is running THIS checkout's start.mjs; a record that
// asserted its own command line would replace that proof with a self-declared
// value, and a caller about to send SIGKILL is the wrong place to relax it.
// A host where no PowerShell call can run therefore still fails closed here,
// which is the intended answer rather than a gap.
export function processCommandLine(
  pid,
  { spawn = spawnSync, platform = process.platform, environment = process.env, budget } = {},
) {
  if (!Number.isSafeInteger(pid) || pid < 1) return undefined;
  try {
    if (platform === "win32") {
      const scripts = [
        `$p = Get-CimInstance Win32_Process -Filter \"ProcessId = ${pid}\" -ErrorAction Stop; [Console]::Out.Write($p.CommandLine)`,
        `$p = Get-WmiObject Win32_Process -Filter \"ProcessId = ${pid}\" -ErrorAction Stop; [Console]::Out.Write($p.CommandLine)`,
      ];
      for (const script of scripts) {
        const result = windowsProbe(script, { spawn, environment, budget });
        const value = String(result.stdout || "").trim();
        if (result.status === 0 && value) return value;
      }
      return undefined;
    }
    const result = spawn("ps", ["-p", String(pid), "-o", "args="], {
      encoding: "utf8",
    });
    return result.status === 0 ? String(result.stdout || "").trim() || undefined : undefined;
  } catch {
    return undefined;
  }
}

// True when the recorded state still describes a live process this router
// started. Everything that stops or signals a managed process goes through
// this, so a server somebody else is running is never touched.
export function stateOwnsProcess(state, options = {}) {
  return stateOwnership(state, options) === "owned";
}

// The same question with the third answer a caller about to signal a process
// needs: "owned", "foreign", or "unknown" when the probe could not run at all.
// An ANSWERED "absent" is foreign, not unknown -- the record is simply stale,
// and reporting that as "could not be identified" would describe a process that
// has already exited as if it were still running.
//
// Two seams. The PROBE is the default, because only it can tell an absent
// process from an unanswerable one -- which is the whole point, and which the
// stop path needs without asking. `identity` is the historical seam, taken only
// when a caller supplies it (four call sites in dsh-web.mjs and
// ollama-runtime.mjs do); it cannot distinguish the two, so a non-answer maps to
// "unknown", exactly what those callers got before, and they only read the
// boolean.
//
// Ordering matters and was got wrong once: making `probe` win only when passed
// explicitly left the stop path on the collapsing branch, so an absent process
// read as "unknown", the record was never cleared after a successful stop, and
// the warning described a gone process as unidentifiable. The default is the
// probe; the legacy branch is the opt-in.
//
// Collapsing unknown into foreign is how a cold host silently skips killing the
// tree it owns; collapsing it into owned is how an unrelated process gets
// signalled. Callers that only need permission to act keep using
// stateOwnsProcess, which treats unknown as not-owned.
export function stateOwnership(state, { identity, probe, budget } = {}) {
  if (
    !state?.managed ||
    !Number.isSafeInteger(state.pid) ||
    state.pid <= 0 ||
    typeof state.processIdentity !== "string" ||
    state.processIdentity.length === 0
  ) {
    return "foreign";
  }
  if (identity) {
    const live = identity(state.pid, { budget });
    if (live === undefined) return "unknown";
    return live === state.processIdentity ? "owned" : "foreign";
  }
  const probed = (probe ?? processStartIdentityProbe)(state.pid, { budget });
  if (probed.state === "absent") return "foreign";
  if (probed.state === "unknown") return "unknown";
  return probed.identity === state.processIdentity ? "owned" : "foreign";
}
