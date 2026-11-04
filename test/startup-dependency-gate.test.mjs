import assert from "node:assert/strict";
import test from "node:test";

import {
  createStartupDependencyGate,
  MAX_STARTUP_HOLD_MS,
  parseStartupHoldMs,
} from "../src/startup-dependency-gate.mjs";

const tick = (ms = 5) => new Promise((resolve) => setTimeout(resolve, ms));
const GATEWAY = ["gateway"];

function settledFlag(promise) {
  const state = { settled: false };
  promise.then(() => {
    state.settled = true;
  });
  return state;
}

test("a hold of zero never polls and never delays a request", async () => {
  let polls = 0;
  const gate = createStartupDependencyGate({
    holdMs: 0,
    dependencies: GATEWAY,
    isReady: async () => {
      polls += 1;
      return false;
    },
  });
  await gate.wait({ dependencies: GATEWAY });
  assert.equal(polls, 0);
  assert.equal(gate.isOpen(), true);
});

test("holds a request until its dependency first reports ready", async () => {
  let ready = false;
  const logs = [];
  const gate = createStartupDependencyGate({
    holdMs: 5_000,
    dependencies: GATEWAY,
    intervalMs: 1,
    isReady: async () => ready,
    log: (message) => logs.push(message),
  });
  const waiting = gate.wait({ dependencies: GATEWAY });
  const state = settledFlag(waiting);
  await tick(20);
  assert.equal(state.settled, false);
  ready = true;
  await waiting;
  assert.equal(logs.length, 1);
  assert.match(logs[0], /held a routed request for \d+ ms until gateway started/);
});

test("a request waits only for the dependencies its own route uses", async () => {
  const healthy = new Set(["api"]);
  const gate = createStartupDependencyGate({
    holdMs: 5_000,
    dependencies: ["api", "gateway"],
    intervalMs: 1,
    isReady: async (name) => healthy.has(name),
  });
  // A direct Responses provider must not wait out a LiteLLM cold start.
  await gate.wait({ dependencies: ["api"] });
  assert.equal(gate.isOpen(), false);

  const viaGateway = gate.wait({ dependencies: ["api", "gateway"] });
  const state = settledFlag(viaGateway);
  await tick(20);
  assert.equal(state.settled, false);
  healthy.add("gateway");
  await viaGateway;
  assert.equal(gate.isOpen(), true);
});

test("native turns and unknown services are never held", async () => {
  const logs = [];
  const gate = createStartupDependencyGate({
    holdMs: 5_000,
    dependencies: GATEWAY,
    intervalMs: 1,
    isReady: async () => false,
    log: (message) => logs.push(message),
  });
  await gate.wait({ dependencies: [] });
  await gate.wait();
  await gate.wait({ dependencies: ["ollama"] });
  assert.deepEqual(logs, []);
});

test("once open it stays open, so a later gateway crash is never held", async () => {
  let ready = true;
  let polls = 0;
  const gate = createStartupDependencyGate({
    holdMs: 5_000,
    dependencies: GATEWAY,
    intervalMs: 1,
    isReady: async () => {
      polls += 1;
      return ready;
    },
  });
  await gate.wait({ dependencies: GATEWAY });
  const pollsWhenOpened = polls;
  ready = false;
  await tick(20);
  await gate.wait({ dependencies: GATEWAY });
  assert.equal(polls, pollsWhenOpened);
});

test("releases held requests when the bound runs out, and names what is missing", async () => {
  const logs = [];
  const gate = createStartupDependencyGate({
    holdMs: 30,
    dependencies: ["api", "gateway"],
    intervalMs: 1,
    isReady: async (name) => name === "api",
    log: (message) => logs.push(message),
  });
  await gate.wait({ dependencies: GATEWAY });
  assert.equal(gate.isOpen(), true);
  assert.match(logs[0], /not healthy after 30 ms: gateway$/);
});

test("a probe that throws counts as not ready rather than ending the gate", async () => {
  let calls = 0;
  const gate = createStartupDependencyGate({
    holdMs: 5_000,
    dependencies: GATEWAY,
    intervalMs: 1,
    isReady: async () => {
      calls += 1;
      if (calls < 3) throw new Error("probe failed");
      return true;
    },
  });
  await gate.wait({ dependencies: GATEWAY });
  assert.equal(calls, 3);
});

test("a caller that disconnects stops waiting and is not logged as held", async () => {
  let ready = false;
  const logs = [];
  const gate = createStartupDependencyGate({
    holdMs: 5_000,
    dependencies: GATEWAY,
    intervalMs: 1,
    isReady: async () => ready,
    log: (message) => logs.push(message),
  });
  const controller = new AbortController();
  const waiting = gate.wait({ dependencies: GATEWAY, signal: controller.signal });
  controller.abort();
  await waiting;
  assert.equal(gate.isOpen(), false);
  ready = true;
  await gate.wait({ dependencies: GATEWAY });
  assert.equal(gate.isOpen(), true);
  await tick();
  assert.equal(logs.filter((line) => /held a routed request/.test(line)).length, 1);
});

test("an already aborted caller does not wait at all", async () => {
  const gate = createStartupDependencyGate({
    holdMs: 50,
    dependencies: GATEWAY,
    intervalMs: 1,
    isReady: async () => false,
  });
  await gate.wait({ dependencies: GATEWAY, signal: AbortSignal.abort() });
  assert.equal(gate.isOpen(), false);
  await gate.wait({ dependencies: GATEWAY });
});

test("the hold setting is off unless it is a valid positive value", () => {
  for (const value of [undefined, "", "abc", "-1", "0", "1.5", "Infinity"]) {
    assert.equal(parseStartupHoldMs(value), 0, String(value));
  }
  assert.equal(parseStartupHoldMs("60000"), 60_000);
  assert.equal(parseStartupHoldMs(String(MAX_STARTUP_HOLD_MS + 1)), MAX_STARTUP_HOLD_MS);
});
