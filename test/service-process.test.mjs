import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  buildServiceProcessState,
  clearServiceProcessState,
  serviceProcessOwns,
  writeServiceProcessState,
} from "../src/service-process.mjs";

const root = path.join(os.tmpdir(), "codex-router-checkout");
const stateDir = path.join(os.tmpdir(), "codex-router-service-state");

function identity() {
  return "2026-08-18T00:00:00Z|node.exe";
}

function commandLine() {
  return `node "${root}/src/start.mjs"`;
}

test("service process state requires the router start.mjs command line", () => {
  const state = buildServiceProcessState({
    pid: 4242,
    platform: "win32",
    identity,
    commandLine,
    sourceRoot: root,
    stateDir,
    ports: { router: 4202, api: 4203 },
  });
  assert.equal(state.pid, 4242);
  assert.equal(state.managed, true);
  assert.deepEqual(state.ports, { router: 4202, api: 4203 });
  assert.equal(
    serviceProcessOwns(state, {
      platform: "win32",
      identity,
      commandLine,
      sourceRoot: root,
      stateDir,
    }),
    true,
  );
  assert.equal(
    serviceProcessOwns(state, {
      platform: "win32",
      identity,
      commandLine: () => "node C:/other/src/start.mjs",
      sourceRoot: root,
      stateDir,
    }),
    false,
  );
  assert.equal(
    buildServiceProcessState({
      pid: 4242,
      platform: "win32",
      identity,
      commandLine: () => "node C:/other/src/start.mjs",
      sourceRoot: root,
      stateDir,
    }),
    undefined,
  );
});

// The service-process record is written on an unbounded startup path, so it may
// wait out a cold powershell.exe. Every ownership check runs inside a bounded
// operation instead -- a Windows service stop that declares 15s, and a restart
// phase that reserves 10s for this exact check and must still leave the
// router's own readiness allowance intact -- so it must keep the tight default.
// Measured 2026-09-23: the first attempt at this patch widened the budget for
// both, which would have let the stop path overrun its own reserve by an order
// of magnitude and made `service restart` report failure after it had already
// restarted the service.
test("only the service-process record opts into the cold-start probe budget", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "codex-router-probe-budget-"));
  const statePath = path.join(directory, "service-process.json");
  const seen = [];
  const capture = (value) => (_pid, options) => {
    seen.push(options);
    return value;
  };
  try {
    writeServiceProcessState({
      pid: 4242,
      platform: "win32",
      identity: capture(identity()),
      commandLine: capture(commandLine()),
      sourceRoot: root,
      stateDir,
      statePath,
    });
    assert.ok(seen.length > 0);
    assert.ok(
      seen.every(({ budget }) => budget?.timeoutMs === 45_000 && budget?.attempts === 2),
      JSON.stringify(seen),
    );

    const state = buildServiceProcessState({
      pid: 4242,
      platform: "win32",
      identity,
      commandLine,
      sourceRoot: root,
      stateDir,
    });
    seen.length = 0;
    assert.equal(
      serviceProcessOwns(state, {
        platform: "win32",
        identity: capture(identity()),
        commandLine: capture(commandLine()),
        sourceRoot: root,
        stateDir,
      }),
      true,
    );
    assert.ok(seen.length > 0);
    assert.ok(seen.every(({ budget }) => budget === undefined), JSON.stringify(seen));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("service process state is private, readable, and removable", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "codex-router-service-state-"));
  const statePath = path.join(directory, "service-process.json");
  try {
    const state = writeServiceProcessState({
      pid: 4242,
      platform: "win32",
      identity,
      commandLine,
      sourceRoot: root,
      stateDir,
      statePath,
    });
    assert.equal(JSON.parse(readFileSync(statePath, "utf8")).pid, state.pid);
    clearServiceProcessState(statePath);
    assert.throws(() => readFileSync(statePath, "utf8"), { code: "ENOENT" });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
