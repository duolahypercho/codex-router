import { execFile } from "node:child_process";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);
const registrationQuery = `
ObjC.import("AppKit");
const pid = Number($.NSProcessInfo.processInfo.environment.objectForKey("ROUTER_SMOKE_PID").js);
const apps = $.NSRunningApplication.runningApplicationsWithBundleIdentifier("io.github.codex-router.tray");
let result = { registered: false };
for (let index = 0; index < apps.count; index += 1) {
  const app = apps.objectAtIndex(index);
  if (Number(app.processIdentifier) !== pid) continue;
  result = { pid, finishedLaunching: Boolean(app.isFinishedLaunching), bundlePath: app.bundleURL.path.js };
  break;
}
JSON.stringify(result);
`;

function processAlive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { if (error.code === "ESRCH") return false; throw error; }
}

async function queryRegistration({ pid, timeoutMs }) {
  const { stdout } = await run("/usr/bin/osascript", ["-l", "JavaScript", "-e", registrationQuery], {
    env: { ...process.env, ROUTER_SMOKE_PID: String(pid) },
    timeout: timeoutMs, killSignal: "SIGKILL", maxBuffer: 64 * 1024,
  });
  return JSON.parse(stdout);
}

// A live PID alone does not establish that AppKit can receive an open/reopen
// event. Wait for this exact host and bundle, without retrying a crashed app.
export async function waitForMacosAppReady({ pid, appPath, timeoutMs = 30_000, pollMs = 250 }, {
  query = queryRegistration, alive = processAlive, now = () => performance.now(), pause = sleep,
} = {}) {
  if (!Number.isSafeInteger(pid) || pid <= 0 || typeof appPath !== "string" || !appPath ||
      !Number.isFinite(timeoutMs) || timeoutMs <= 0 || !Number.isFinite(pollMs) || pollMs <= 0) {
    throw new TypeError("Expected a positive host PID, application path and bounded wait settings.");
  }
  const expectedPath = path.resolve(appPath);
  const deadline = now() + timeoutMs;
  while (now() < deadline) {
    if (!alive(pid)) throw new Error("Unified macOS host exited before AppKit finished launching.");
    const state = await query({ pid, timeoutMs: Math.max(1, Math.min(3_000, deadline - now())) });
    if (!alive(pid)) throw new Error("Unified macOS host exited while querying AppKit readiness.");
    if (now() >= deadline) break;
    if (state?.pid === pid && state.finishedLaunching === true &&
        typeof state.bundlePath === "string" && path.resolve(state.bundlePath) === expectedPath) return;
    await pause(Math.min(pollMs, Math.max(0, deadline - now())));
  }
  throw new Error("Timed out waiting for the exact unified macOS host to finish launching in AppKit.");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  waitForMacosAppReady({ pid: Number(process.argv[2]), appPath: process.argv[3] }).catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
