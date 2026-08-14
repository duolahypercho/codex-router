import { spawnSync } from "node:child_process";

// A PID alone is not an identity: the operating system reuses them, and a
// router that remembers only a number can eventually send a signal to whatever
// inherited it. Pair the PID with the process's start time and executable, and
// require both to match before acting on it.
//
// Extracted from ollama-runtime.mjs when the harness web server needed the same
// guarantee. Nothing here is specific to either program.
export function processStartIdentity(
  pid,
  { spawn = spawnSync, platform = process.platform } = {},
) {
  if (!Number.isSafeInteger(pid) || pid < 1) return undefined;
  try {
    if (platform === "win32") {
      const script =
        `$p = Get-Process -Id ${pid} -ErrorAction Stop; ` +
        `[Console]::Out.Write($p.StartTime.ToUniversalTime().Ticks.ToString() + '|' + $p.Path)`;
      const result = spawn(
        "powershell.exe",
        ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
        { encoding: "utf8", windowsHide: true },
      );
      return result.status === 0 ? String(result.stdout || "").trim() || undefined : undefined;
    }
    const result = spawn("ps", ["-p", String(pid), "-o", "lstart=", "-o", "comm="], {
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
export function stateOwnsProcess(state, { identity = processStartIdentity } = {}) {
  return Boolean(
    state?.managed &&
      Number.isSafeInteger(state.pid) &&
      state.pid > 0 &&
      typeof state.processIdentity === "string" &&
      state.processIdentity.length > 0 &&
      identity(state.pid) === state.processIdentity,
  );
}
