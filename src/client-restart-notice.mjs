import { spawnSync } from "node:child_process";

const PROCESS_PROBE_TIMEOUT_MS = 5_000;

// Clients that read their routing configuration once, at process start.
//
// Only those belong here. The DeepSeek Harness reloads `settings.yaml` on the
// next request, so a running harness is never stale and naming it would be the
// same busywork `targetRestartHint` already refuses to print.
const STARTUP_CONFIGURED_TARGETS = new Set(["codex", "gemini", "cursor"]);

// What a running client looks like in a process listing.
//
// Codex ships as a framework inside the desktop app, so the app bundle and the
// framework are both worth matching: a user who sees "ChatGPT" in their dock
// and "Codex" in this message should still connect the two.
const CLIENT_PROCESS_PATTERNS = {
  codex: [/Codex Framework/i, /ChatGPT\.app/i, /(^|\/)codex(\s|$)/],
  gemini: [/(^|\/)gemini(\s|$)/],
  cursor: [/Cursor\.app/i, /(^|[\\/])Cursor(?:\.exe)?(?:\s|$)/i],
};

// This router's own processes carry `codex` in nearly every path they run
// from, so a naive match reports the router as the client it is asking the
// user to restart. Excluding the checkout by name is what keeps the notice
// about Codex rather than about ourselves.
const SELF_PATTERN = /codex-router|model-router/i;

/**
 * PIDs of the target client that are running right now.
 *
 * Best effort by design: a probe that cannot enumerate processes returns an
 * empty list, and the caller falls back to the unconditional advice. Failing
 * to detect a running client must never be worse than never having looked.
 */
export function runningClientProcesses(
  target,
  { spawn = spawnSync, platform = process.platform } = {},
) {
  const patterns = CLIENT_PROCESS_PATTERNS[target];
  if (!patterns) return [];
  let lines;
  try {
    if (platform === "win32") {
      const script =
        "Get-CimInstance Win32_Process | " +
        "ForEach-Object { [Console]::Out.WriteLine($_.ProcessId.ToString() + ' ' + " +
        "$_.ParentProcessId.ToString() + ' ' + $_.CommandLine) }";
      const result = spawn(
        "powershell.exe",
        ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
        { encoding: "utf8", windowsHide: true, timeout: PROCESS_PROBE_TIMEOUT_MS },
      );
      if (result.status !== 0) return [];
      lines = String(result.stdout || "").split(/\r?\n/);
    } else {
      const result = spawn("ps", ["-axo", "pid=,ppid=,args="], {
        encoding: "utf8",
        timeout: PROCESS_PROBE_TIMEOUT_MS,
      });
      if (result.status !== 0) return [];
      lines = String(result.stdout || "").split("\n");
    }
  } catch {
    return [];
  }
  const found = [];
  for (const line of lines) {
    const match = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (!match) continue;
    const pid = Number(match[1]);
    const parentPid = Number(match[2]);
    const command = match[3].trim();
    if (!command || SELF_PATTERN.test(command)) continue;
    if (pid === process.pid) continue;
    if (!patterns.some((pattern) => pattern.test(command))) continue;
    found.push({ pid, parentPid, command });
  }
  return found;
}

/**
 * The restart advice, made specific when the client is demonstrably running.
 *
 * `bin/install` rewrites the client's configuration and then prints "fully quit
 * and reopen" unconditionally, as one line among ten. A client that was already
 * running when its configuration changed keeps serving the previous routing
 * until it restarts, and the failure that follows -- a connection error naming
 * neither the install nor the client -- reads as a network fault. Advice the
 * user cannot tell applies to them right now is advice they scroll past, so say
 * it only when it is true, and say which process it is about.
 */
export function clientRestartNotice(
  target,
  { processes, ...probeOptions } = {},
) {
  if (!STARTUP_CONFIGURED_TARGETS.has(target)) return undefined;
  const running = processes ?? runningClientProcesses(target, probeOptions);
  const name = target === "gemini" ? "Gemini CLI" : target === "cursor" ? "Cursor" : "Codex";
  if (running.length === 0) {
    return `${name} is not running; it reads this configuration the next time it starts.`;
  }
  // A desktop client is a tree: one process the user launched and a dozen
  // helpers it spawned. Listing all of them buries the only number worth
  // acting on, so report the roots -- the processes whose parent is not itself
  // part of the match -- and count the rest.
  const pids = new Set(running.map((entry) => entry.pid));
  const roots = running
    .filter((entry) => !pids.has(entry.parentPid))
    .map((entry) => entry.pid)
    .sort((a, b) => a - b);
  // A tree whose root was already reaped leaves only orphans; naming the
  // lowest survivor beats naming none.
  const named = roots.length > 0 ? Math.min(...roots) : Math.min(...pids);
  const others = running.length - 1;
  const subject =
    `PID ${named}` +
    (others > 0 ? ` and ${others} other process${others === 1 ? "" : "es"}` : "");
  return (
    `${name} is running right now (${subject}) and loaded its routing ` +
    `configuration at startup. Fully quit and reopen it, then start a new ` +
    `task -- until you do, it keeps using the previous configuration.`
  );
}
