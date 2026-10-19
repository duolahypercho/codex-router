import { spawn } from "node:child_process";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";

import { redactCallerUrl } from "../src/caller-auth.mjs";

const observations = new WeakMap();
const STDERR_TAIL = 8_000;
const bootstrap = new URL("./node-fixture-bootstrap.mjs", import.meta.url).href;

export function spawnNodeFixture(script, { cwd, env, nodeArgs = [] } = {}) {
  const state = { started: performance.now(), phase: "created", listeners: new Map(), stderr: "" };
  const child = spawn(process.execPath, [...nodeArgs, "--import", bootstrap, script], {
    cwd, env, windowsHide: true, stdio: ["ignore", "ignore", "pipe", "ipc"],
  });
  observations.set(child, state);
  child.once("spawn", () => { state.phase = "spawned"; });
  child.once("error", error => { state.error = error; });
  child.on("message", message => {
    if (message?.nodeFixturePhase === "initialized") {
      state.phase = "initialized";
      state.initializedMs = performance.now() - state.started;
    } else if (message?.nodeFixturePhase === "binding") {
      state.phase = "binding";
      state.bindingMs = performance.now() - state.started;
      state.bindingCpu = message.cpu;
    } else if (message?.nodeFixturePhase === "listening" && Number.isInteger(message.port)) {
      state.phase = "listening";
      state.listeners.set(message.port, performance.now() - state.started);
      state.listenCpu = message.cpu;
    }
  });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", chunk => { state.stderr = `${state.stderr}${chunk}`.slice(-STDERR_TAIL); });
  child.testErrors = () => state.stderr;
  return child;
}

function failure(child, state, url, reason) {
  const timings = {
    phase: state.phase,
    elapsedMs: Math.round(performance.now() - state.started),
    initializedMs: state.initializedMs === undefined ? null : Math.round(state.initializedMs),
    bindingMs: state.bindingMs === undefined ? null : Math.round(state.bindingMs),
    bindingCpu: state.bindingCpu,
    listeners: [...state.listeners].map(([port, ms]) => ({ port, elapsedMs: Math.round(ms) })),
    listenCpu: state.listenCpu,
    exitCode: child.exitCode,
    signal: child.signalCode,
    lastHTTPStatus: state.lastHTTPStatus,
    lastProbe: state.lastProbe,
  };
  return new Error(`${reason} waiting for ${redactCallerUrl(url)}; startup=${JSON.stringify(timings)}\n${state.stderr}`);
}

function assertAlive(child, state, url) {
  if (state.error) throw failure(child, state, url, `Child could not start (${state.error.code || state.error.name})`);
  if (child.exitCode !== null || child.signalCode !== null) {
    throw failure(child, state, url, "Child exited before readiness");
  }
}

// These are functional tests, not a five-second cold-start benchmark. Wait
// for the actual listener separately; keep the existing HTTP readiness bound
// after it is listening. A live socket that never answers is still bounded.
export async function waitForNodeFixture(url, child, {
  headers = {}, warmupMs = 15_000, timeoutMs = 5_000, attemptMs = 1_000,
} = {}) {
  const state = observations.get(child);
  if (!state) throw new Error("Readiness requires an observed Node fixture.");
  const port = Number(new URL(url).port) || 80;
  while (!state.listeners.has(port)) {
    assertAlive(child, state, url);
    if (performance.now() - state.started >= warmupMs) {
      throw failure(child, state, url, "Node fixture warm-up timed out");
    }
    await delay(25);
  }
  if (state.listeners.get(port) > warmupMs) throw failure(child, state, url, "Node fixture warm-up timed out");
  if (state.listeners.get(port) > timeoutMs) {
    // Preserve evidence of the former failure threshold even when startup
    // eventually succeeds; separating budgets must not hide slow starts.
    console.error(failure(child, state, url, "Slow Node fixture warm-up").message);
  }
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    assertAlive(child, state, url);
    try {
      const remaining = Math.max(1, Math.ceil(Math.min(attemptMs, deadline - performance.now())));
      const response = await fetch(url, { headers, signal: AbortSignal.timeout(remaining) });
      state.lastHTTPStatus = response.status;
      // Drain the body within the same bound, including a peer that sends
      // headers and then stalls. A headers-only success is not readiness.
      await response.arrayBuffer();
      state.lastProbe = `HTTP ${response.status}`;
      if (response.ok && performance.now() <= deadline) return;
    } catch (error) {
      state.lastProbe = error.cause?.code || error.name;
    }
    await delay(25);
  }
  throw failure(child, state, url, "HTTP readiness timed out");
}
