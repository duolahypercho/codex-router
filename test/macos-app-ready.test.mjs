import assert from "node:assert/strict";
import test from "node:test";
import { waitForMacosAppReady } from "../scripts/wait-macos-app-ready.mjs";

const options = { pid: 12345, appPath: "/fixture/Codex Router.app", timeoutMs: 20, pollMs: 5 };
const ready = { pid: options.pid, bundlePath: options.appPath, finishedLaunching: true };

function fixture(query, alive = () => true) {
  let time = 0;
  const observations = [];
  return {
    observations,
    advance: value => { time += value; },
    dependencies: {
      alive, now: () => time, pause: async value => { time += value; },
      query: async args => { observations.push(args); return query(args, observations.length); },
    },
  };
}

test("waits for registration, exact PID and completed AppKit launch", async () => {
  const states = [{ registered: false }, { ...ready, pid: 99999 }, { ...ready, finishedLaunching: false }, ready];
  const f = fixture((_args, attempt) => states[attempt - 1]);
  await waitForMacosAppReady(options, f.dependencies);
  assert.equal(f.observations.length, 4);
  assert.deepEqual(f.observations.map(value => value.timeoutMs), [20, 15, 10, 5]);
});

test("an unrelated application with the same PID cannot satisfy readiness", async () => {
  const f = fixture(() => ({ ...ready, bundlePath: "/different/Codex Router.app" }));
  await assert.rejects(waitForMacosAppReady(options, f.dependencies), /Timed out/);
  assert.equal(f.observations.length, 4);
});

test("a host that already exited fails before querying or waiting", async () => {
  const f = fixture(() => ready, () => false);
  await assert.rejects(waitForMacosAppReady(options, f.dependencies), /exited before/);
  assert.equal(f.observations.length, 0);
});

test("an exit during the readiness query cannot be hidden by a ready reply", async () => {
  let checks = 0;
  const f = fixture(() => ready, () => ++checks === 1);
  await assert.rejects(waitForMacosAppReady(options, f.dependencies), /exited while/);
  assert.equal(f.observations.length, 1);
});

test("registration never arriving has a bounded deadline", async () => {
  const f = fixture(() => ({ registered: false }));
  await assert.rejects(waitForMacosAppReady(options, f.dependencies), /Timed out/);
  assert.equal(f.observations.length, 4);
});

test("a ready reply arriving after the deadline is rejected", async () => {
  const f = fixture(() => { f.advance(25); return ready; });
  await assert.rejects(waitForMacosAppReady(options, f.dependencies), /Timed out/);
  assert.equal(f.observations.length, 1);
});

test("AppKit query failures are reported rather than retried as readiness", async () => {
  const error = new Error("synthetic AppKit query failed");
  const f = fixture(() => { throw error; });
  await assert.rejects(waitForMacosAppReady(options, f.dependencies), cause => cause === error);
  assert.equal(f.observations.length, 1);
});

test("invalid process and deadline inputs fail without querying", async () => {
  const f = fixture(() => ready);
  for (const change of [{ pid: 0 }, { pid: NaN }, { appPath: "" }, { timeoutMs: Infinity }, { pollMs: 0 }]) {
    await assert.rejects(waitForMacosAppReady({ ...options, ...change }, f.dependencies), TypeError);
  }
  assert.equal(f.observations.length, 0);
});
