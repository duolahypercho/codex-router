import { spawn } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

import { harnessCliPath } from "./dsh-install.mjs";
import { protectPrivateFile } from "./file-security.mjs";
import { spawnEnvironment } from "./npm-global-install.mjs";
import { STATE_DIR } from "./paths.mjs";
import { processStartIdentity, stateOwnsProcess } from "./process-identity.mjs";
import { spawnableCommand } from "./spawnable-command.mjs";

// Starting and finding the harness's browser UI, so the tray can offer "Open"
// instead of leaving somebody to remember a command and a port.
//
// The harness serves on 127.0.0.1:3080 by default -- its own shipped default,
// not something this router chose or writes -- and `dsh web --port` overrides
// it. That override is why the port is a setting here rather than a constant:
// a user who moved theirs must not be sent to a dead URL.
export const DSH_WEB_PORT = Number.parseInt(process.env.MODEL_ROUTER_DSH_WEB_PORT || "3080", 10);
export const DSH_WEB_HOST = process.env.MODEL_ROUTER_DSH_WEB_HOST || "127.0.0.1";

const STATE_PATH = process.env.MODEL_ROUTER_DSH_WEB_STATE || path.join(STATE_DIR, "dsh-web.json");
const LOG_PATH = path.join(STATE_DIR, "dsh-web.log");

const READY_TIMEOUT_MS = 90_000;
const READY_INTERVAL_MS = 400;
const PROBE_TIMEOUT_MS = 1_500;
// How long an unresponsive server gets after SIGKILL before the stop is
// reported as failed. A killed process is reaped in milliseconds; this only has
// to outlast the scheduler.
const KILL_GRACE_MS = 2_000;

export function dshWebUrl({ port = DSH_WEB_PORT, host = DSH_WEB_HOST } = {}) {
  return `http://${host}:${port}`;
}

function readState() {
  if (!existsSync(STATE_PATH)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(STATE_PATH, "utf8"));
    return parsed?.version === 1 ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function writeState(state) {
  mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
  const temporary = `${STATE_PATH}.tmp.${process.pid}`;
  writeFileSync(temporary, `${JSON.stringify({ version: 1, ...state }, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  protectPrivateFile(temporary);
  renameSync(temporary, STATE_PATH);
  protectPrivateFile(STATE_PATH);
}

// Reachability, not identity. Whether the URL the button would open actually
// answers is the whole of what the button needs to decide; asserting that the
// listener is the harness would mean fingerprinting somebody else's HTML.
export async function probeDshWeb({
  port = DSH_WEB_PORT,
  host = DSH_WEB_HOST,
  fetchImpl = fetch,
  timeoutMs = PROBE_TIMEOUT_MS,
} = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(dshWebUrl({ port, host }), {
      method: "GET",
      signal: controller.signal,
      redirect: "manual",
    });
    // Any HTTP answer means the port is served. A 404 from the harness's own
    // router is still a running harness.
    return { reachable: true, status: response.status };
  } catch (error) {
    return { reachable: false, error: error?.message };
  } finally {
    clearTimeout(timer);
  }
}

export async function dshWebState({ fetchImpl = fetch, identity = processStartIdentity } = {}) {
  const state = readState();
  const managed = stateOwnsProcess(state, { identity });
  const port = managed && state?.port ? state.port : DSH_WEB_PORT;
  const probe = await probeDshWeb({ port, fetchImpl });
  return {
    running: probe.reachable,
    // A server this router did not start is reported, never stopped. Somebody
    // else's `dsh web` in a terminal is the common case, and killing it to
    // replace it with an identical one would be pure rudeness.
    managed: managed && probe.reachable,
    url: dshWebUrl({ port }),
    port,
    pid: managed ? state.pid : undefined,
  };
}

function waitFor(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export async function startDshWeb({
  port = DSH_WEB_PORT,
  fetchImpl = fetch,
  identity = processStartIdentity,
  timeoutMs = READY_TIMEOUT_MS,
} = {}) {
  // Adopt rather than collide. The harness binds a fixed port, so a second
  // launch does not pick another one -- it exits with EADDRINUSE and takes the
  // click with it.
  const existing = await dshWebState({ fetchImpl, identity });
  if (existing.running) return { ...existing, startedNow: false };

  const binary = harnessCliPath();
  if (!binary) throw new Error("DeepSeek Harness is not installed. Install it first.");

  mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
  const logFd = openSync(LOG_PATH, "a", 0o600);
  // On Windows `dsh` resolves to a `.cmd` shim, and Node has refused to spawn
  // one without a shell since the CVE-2024-27980 fix -- a raw spawn answers
  // EINVAL, so the tray's Start button could never have worked there. Every
  // other caller of this binary already goes through `spawnableCommand`; this
  // one was the exception it exists to prevent.
  const command = spawnableCommand(binary, ["web", "--port", String(port)]);
  let child;
  try {
    child = spawn(command.command, command.args, {
      ...command.options,
      detached: true,
      stdio: ["ignore", logFd, logFd],
      windowsHide: true,
      env: spawnEnvironment(),
    });
  } finally {
    closeSync(logFd);
  }
  child?.unref?.();

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const probe = await probeDshWeb({ port, fetchImpl });
    if (probe.reachable) break;
    await waitFor(READY_INTERVAL_MS);
  }
  const probe = await probeDshWeb({ port, fetchImpl });
  if (!probe.reachable) {
    throw new Error(
      `DeepSeek Harness was started but did not answer on ${dshWebUrl({ port })}. See ${LOG_PATH}.`,
    );
  }

  const processIdentity = identity(child?.pid);
  if (processIdentity) {
    writeState({ managed: true, pid: child.pid, port, processIdentity });
  }
  return {
    running: true,
    managed: Boolean(processIdentity),
    url: dshWebUrl({ port }),
    port,
    pid: child?.pid,
    startedNow: true,
    logPath: LOG_PATH,
  };
}

// Stops only the exact server this router started, for the same reason the
// Ollama daemon is treated that way: a reachable port with no matching identity
// belongs to somebody else.
export async function stopDshWeb({
  identity = processStartIdentity,
  kill = process.kill,
  timeoutMs = 5_000,
} = {}) {
  const state = readState();
  if (!stateOwnsProcess(state, { identity })) {
    return { stopped: false, reason: "external-or-unmanaged" };
  }
  // Ownership is the liveness test, not bare PID presence: a recycled PID
  // carries a different start time and comm, so it reads as gone rather than as
  // a process this router may signal again.
  const stillOurs = () => stateOwnsProcess(state, { identity });
  const waitForExit = async (limitMs) => {
    const deadline = Date.now() + limitMs;
    while (Date.now() < deadline) {
      if (!stillOurs()) return true;
      await waitFor(100);
    }
    return !stillOurs();
  };

  try {
    kill(state.pid, "SIGTERM");
  } catch {
    return { stopped: false, reason: "signal-failed" };
  }
  if (!(await waitForExit(timeoutMs))) {
    // SIGTERM is a request. Reporting success without checking is what leaves a
    // harness holding the port while the ownership record says nobody started
    // it -- after which the tray reads it as externally started forever, and
    // this function refuses to touch it. Escalate the way the Ollama runtime
    // does before giving up.
    try {
      kill(state.pid, "SIGKILL");
    } catch {
      // Gone between the check and the signal is the good case. A real failure
      // is caught by the confirmation below rather than assumed here.
    }
    if (!(await waitForExit(KILL_GRACE_MS))) {
      // The record is left intact on purpose: it is the only thing that still
      // identifies this process as ours to stop on the next attempt.
      return { stopped: false, pid: state.pid, reason: "still-running" };
    }
  }
  writeState({ managed: false });
  return { stopped: true, pid: state.pid };
}
