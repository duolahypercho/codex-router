import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_MAX_RESTARTS,
  MAX_RESTART_BACKOFF_MS,
  gatewaySupervisorLimits,
  restartBackoffMs,
  superviseGateway,
} from "../src/gateway-supervisor.mjs";

// A stand-in for a spawned process that is only ever asked the two questions
// start.mjs asks: has it exited, and when does it exit.
function fakeChild(id) {
  const child = { id, exitCode: null, signalCode: null, killed: [] };
  child.resolvers = [];
  child.kill = (signal) => {
    child.killed.push(signal);
    child.exit(0, signal);
  };
  child.exit = (code, signal = null) => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.exitCode = signal ? null : code;
    child.signalCode = signal;
    for (const resolve of child.resolvers.splice(0)) resolve({ code, signal });
  };
  return child;
}

function harness({ health = () => Promise.resolve(), limits = {} } = {}) {
  const spawned = [];
  const logs = [];
  let shuttingDown = false;
  const slept = [];

  const start = () => {
    const child = fakeChild(spawned.length);
    spawned.push(child);
    return child;
  };
  const waitForExit = (child, label) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      return Promise.resolve({ label, code: child.exitCode, signal: child.signalCode });
    }
    return new Promise((resolve) => {
      child.resolvers.push(({ code, signal }) => resolve({ label, code, signal }));
    });
  };

  const first = start();
  const done = superviseGateway({
    child: first,
    start,
    waitForExit,
    waitForHealth: (child) => health(child, spawned.indexOf(child)),
    isShuttingDown: () => shuttingDown,
    log: (message) => logs.push(message),
    sleep: async (ms) => {
      slept.push(ms);
    },
    ...limits,
  });

  return {
    done,
    spawned,
    logs,
    slept,
    shutDown: () => {
      shuttingDown = true;
    },
  };
}

// The whole point of #261: a gateway that dies mid-session must not take the
// router with it. The supervisor's contract is that it keeps waiting -- it does
// not resolve, so start.mjs's `Promise.race` never fires and nothing is torn
// down -- and that a replacement is spawned.
test("a gateway that exits 1 mid-session is replaced instead of ending the service", async () => {
  const supervisor = harness();
  let settled = false;
  supervisor.done.then(() => {
    settled = true;
  });

  supervisor.spawned[0].exit(1);
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(settled, false, "the service was torn down by a gateway crash");
  assert.equal(supervisor.spawned.length, 2, "no replacement gateway was spawned");
  assert.match(supervisor.logs[0], /exited \(code=1, signal=null\); restarting in 1000 ms/);
  assert.match(supervisor.logs[0], /router stays up/);
  assert.match(supervisor.logs[1], /healthy again after 1 restart/);

  supervisor.shutDown();
  supervisor.spawned[1].exit(0);
  await supervisor.done;
});

test("restarts back off and stay inside the bound, then the service gives up", async () => {
  const supervisor = harness({ limits: { maxRestarts: 3 } });
  const settled = supervisor.done;

  for (let index = 0; index < 4; index += 1) {
    supervisor.spawned[index].exit(1);
    // Let the loop observe the exit, sleep, respawn and re-probe health.
    for (let tick = 0; tick < 6; tick += 1) {
      await new Promise((resolve) => setImmediate(resolve));
    }
  }

  const result = await settled;
  assert.equal(result.exhausted, true);
  assert.equal(result.code, 1);
  assert.equal(result.restarts, 3);
  assert.equal(supervisor.spawned.length, 4, "the bound did not stop the spawn loop");
  assert.deepEqual(supervisor.slept, [1_000, 2_000, 4_000]);
  assert.match(
    supervisor.logs.at(-1),
    /exited \(code=1, signal=null\) after 3 restart\(s\) within \d+s; not restarting it again/,
  );
});

test("a replacement that never becomes healthy is stopped and counted", async () => {
  const supervisor = harness({
    limits: { maxRestarts: 1 },
    health: async (child, index) => {
      if (index > 0) throw new Error("LiteLLM gateway exited before becoming healthy.");
    },
  });
  const settled = supervisor.done;

  supervisor.spawned[0].exit(1);
  const result = await settled;

  assert.equal(result.exhausted, true);
  assert.deepEqual(supervisor.spawned[1].killed, ["SIGTERM"]);
  assert.match(
    supervisor.logs.find((line) => line.includes("did not come back")) ?? "",
    /did not come back: LiteLLM gateway exited before becoming healthy/,
  );
});

test("shutting down is not a crash and never respawns", async () => {
  const supervisor = harness();
  supervisor.shutDown();
  supervisor.spawned[0].exit(null, "SIGTERM");

  const result = await supervisor.done;
  assert.equal(result.signal, "SIGTERM");
  assert.equal(result.restarts, 0);
  assert.equal(supervisor.spawned.length, 1);
  assert.deepEqual(supervisor.logs, []);
});

test("supervision can be turned off entirely", async () => {
  const supervisor = harness({ limits: { maxRestarts: 0 } });
  supervisor.spawned[0].exit(1);

  const result = await supervisor.done;
  assert.equal(result.exhausted, true);
  assert.equal(supervisor.spawned.length, 1);
  assert.match(supervisor.logs[0], /restarts are disabled/);
});

test("the backoff doubles from the base and is capped", () => {
  assert.equal(restartBackoffMs(0), 1_000);
  assert.equal(restartBackoffMs(1), 2_000);
  assert.equal(restartBackoffMs(4), 16_000);
  assert.equal(restartBackoffMs(9), MAX_RESTART_BACKOFF_MS);
  assert.equal(restartBackoffMs(0, 250), 250);
});

test("limits come from the environment and fall back on nonsense", () => {
  assert.deepEqual(gatewaySupervisorLimits({}), {
    maxRestarts: DEFAULT_MAX_RESTARTS,
    backoffMs: 1_000,
    windowMs: 600_000,
  });
  assert.equal(gatewaySupervisorLimits({ CODEX_ROUTER_GATEWAY_RESTARTS: "0" }).maxRestarts, 0);
  assert.equal(
    gatewaySupervisorLimits({ CODEX_ROUTER_GATEWAY_RESTARTS: "-3" }).maxRestarts,
    DEFAULT_MAX_RESTARTS,
  );
  assert.equal(
    gatewaySupervisorLimits({ CODEX_ROUTER_GATEWAY_RESTARTS: "not-a-number" }).maxRestarts,
    DEFAULT_MAX_RESTARTS,
  );
  assert.equal(
    gatewaySupervisorLimits({ CODEX_ROUTER_GATEWAY_RESTART_WINDOW_MS: "1000" }).windowMs,
    1_000,
  );
});

// The window is what keeps a long-lived install restartable: five crashes over
// a year must not exhaust the same budget five crashes in a minute does.
test("failures outside the window do not count against the bound", async () => {
  let clock = 0;
  const spawned = [];
  const start = () => {
    const child = fakeChild(spawned.length);
    spawned.push(child);
    return child;
  };
  const waitForExit = (child, label) =>
    child.exitCode !== null || child.signalCode !== null
      ? Promise.resolve({ label, code: child.exitCode, signal: child.signalCode })
      : new Promise((resolve) => {
          child.resolvers.push(({ code, signal }) => resolve({ label, code, signal }));
        });

  const first = start();
  const done = superviseGateway({
    child: first,
    start,
    waitForExit,
    waitForHealth: async () => {},
    log: () => {},
    sleep: async () => {},
    now: () => clock,
    maxRestarts: 1,
    windowMs: 60_000,
  });

  for (let index = 0; index < 5; index += 1) {
    clock += 120_000;
    spawned[index].exit(1);
    for (let tick = 0; tick < 6; tick += 1) {
      await new Promise((resolve) => setImmediate(resolve));
    }
  }

  assert.equal(spawned.length, 6, "an aged-out failure was still charged to the bound");

  // Two crashes inside one window do exhaust it: this one lands a millisecond
  // after the fifth, so both are still in the window and the bound of 1 is
  // exceeded.
  clock += 1;
  spawned[5].exit(1);
  const result = await done;
  assert.equal(result.exhausted, true);
  assert.equal(spawned.length, 6, "the bound did not stop the spawn loop");
});
