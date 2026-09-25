import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  buildServiceProcessState,
  clearServiceProcessState,
  probeServiceProcessState,
  serviceProcessOwnership,
  serviceProcessOwns,
  serviceRecordSettled,
  writeServiceProcessState,
} from "../src/service-process.mjs";
import { processStartIdentityProbe } from "../src/process-identity.mjs";

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
      probe: () => ({ state: "alive", identity: identity() }),
      commandLine,
      sourceRoot: root,
      stateDir,
    }),
    true,
  );
  assert.equal(
    serviceProcessOwns(state, {
      platform: "win32",
      probe: () => ({ state: "alive", identity: identity() }),
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
        probe: capture({ state: "alive", identity: identity() }),
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

// The writer has exactly one way to obtain its identity and one way to prove
// the PID is this checkout: the OS probes. A host where neither can run still
// fails closed, and that is deliberate -- a record that asserted its own
// command line would replace the ownership proof with a self-declared value,
// which is the wrong trade in front of a SIGKILL. What changes here is that the
// refusal now says which probe failed, because "could not verify" was true of
// three different situations with three different fixes.
test("an unprobeable identity reports its own failure", () => {
  const probe = probeServiceProcessState({
    pid: 4242,
    platform: "win32",
    identity: () => undefined,
    commandLine,
    sourceRoot: root,
    stateDir,
  });
  assert.equal(probe.state, undefined);
  assert.equal(probe.failure, "identity-unavailable");
  assert.match(probe.detail, /did not answer/);
});

test("an unprobeable command line reports its own failure, not a generic one", () => {
  const probe = probeServiceProcessState({
    pid: 4242,
    platform: "win32",
    identity: () => "2026-08-18T00:00:00Z|node.exe",
    commandLine: () => undefined,
    sourceRoot: root,
    stateDir,
  });
  assert.equal(probe.state, undefined);
  assert.equal(probe.failure, "command-line-unavailable");
});

test("a command line for another checkout is reported as a mismatch", () => {
  const probe = probeServiceProcessState({
    pid: 4242,
    platform: "win32",
    identity: () => "2026-08-18T00:00:00Z|node.exe",
    commandLine: () => "node C:/other/src/start.mjs",
    sourceRoot: root,
    stateDir,
  });
  assert.equal(probe.state, undefined);
  assert.equal(probe.failure, "command-line-mismatch");
  assert.match(probe.detail, /does not contain/);
});

// The failure the operator actually reads. It used to say only that the
// identity could not be verified, which is true of three different situations
// with three different fixes.
test("the refusal names the probe outcome", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "codex-router-probe-failure-"));
  const statePath = path.join(directory, "service-process.json");
  try {
    assert.throws(
      () =>
        writeServiceProcessState({
          pid: 4242,
          platform: "win32",
          identity: () => undefined,
          commandLine: () => undefined,
          sourceRoot: root,
          stateDir,
          statePath,
        }),
      (error) => {
        assert.match(error.message, /identity-unavailable/);
        assert.match(error.message, /did not answer within its budget/);
        return true;
      },
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

// A pid nothing owns, so the absent path can be exercised against the real
// probe rather than an injected one. Windows allocates pids in multiples of 4;
// signal 0 is Node's documented existence test.
function freePid() {
  for (let candidate = 4_000_000; candidate > 3_900_000; candidate -= 4) {
    try {
      process.kill(candidate, 0);
    } catch (error) {
      if (error?.code === "ESRCH") return candidate;
    }
  }
  return undefined;
}

// The regression this exists for: the probe must be the DEFAULT seam. When it
// was the opt-in instead, the stop path -- which passes neither seam -- took the
// collapsing identity branch, so an absent process read as "unknown",
// serviceRecordSettled could never be true, and the record was never cleared
// after a successful stop. Every other tri-state test injects `probe`, so none
// of them could see it.
//
// The call below deliberately passes no seam, which is the point. On a cold or
// saturated host the default probe can itself time out, and "unknown" is then
// the correct answer -- so the assertion is gated on the host being able to
// answer, rather than reporting a scheduling artifact as a defect. That keeps
// this test honest on the host class the patch exists for: it still fails
// whenever the probe answers and the default collapses absent into unknown.
test("the default seam distinguishes an absent process from an unanswerable one", (t) => {
  const pid = freePid();
  assert.ok(pid, "expected to find a free pid");
  const direct = processStartIdentityProbe(pid, { platform: process.platform });
  if (direct.state !== "absent") {
    t.skip(`the identity probe did not report the free pid as absent (${direct.state})`);
    return;
  }
  const state = buildServiceProcessState({
    pid: 4242,
    platform: "win32",
    identity,
    commandLine,
    sourceRoot: root,
    stateDir,
  });
  assert.equal(
    serviceProcessOwnership(
      { ...state, pid },
      { platform: process.platform, commandLine, sourceRoot: root, stateDir },
    ),
    "foreign",
  );
});

test("ownership distinguishes not-ours from could-not-tell", () => {
  const state = buildServiceProcessState({
    pid: 4242,
    platform: "win32",
    identity,
    commandLine,
    sourceRoot: root,
    stateDir,
  });
  const base = { platform: "win32", commandLine, sourceRoot: root, stateDir };
  const alive = { state: "alive", identity: identity() };
  assert.equal(serviceProcessOwnership(state, { ...base, probe: () => ({ state: "unknown" }) }), "unknown");
  assert.equal(serviceProcessOwnership(state, { ...base, probe: () => alive }), "owned");
  assert.equal(
    serviceProcessOwnership(state, { ...base, probe: () => ({ state: "alive", identity: "2026-08-18T00:00:01Z|node.exe" }) }),
    "foreign",
  );
  // An answered "absent" is a stale record, not an unidentifiable one.
  assert.equal(serviceProcessOwnership(state, { ...base, probe: () => ({ state: "absent" }) }), "foreign");
  // The boolean form keeps collapsing unknown into not-owned, which is the safe
  // answer for permission to act.
  assert.equal(serviceProcessOwns(state, { ...base, probe: () => ({ state: "unknown" }) }), false);
});

// The regression this guards: the stop path used a boolean for the
// record-clear decision, so an unanswerable probe read as "the tree is gone"
// and the record was cleared while the tree could still be running -- reporting
// a completed stop that never happened, which is the failure this whole patch
// exists to remove.
test("only an answered not-ours settles the record", () => {
  assert.equal(serviceRecordSettled({ ownership: "foreign", portListening: false }), true);
  assert.equal(serviceRecordSettled({ ownership: "foreign", portListening: true }), false);
  assert.equal(serviceRecordSettled({ ownership: "owned", portListening: false }), false);
  assert.equal(serviceRecordSettled({ ownership: "owned", portListening: true }), false);
  assert.equal(serviceRecordSettled({ ownership: "unknown", portListening: false }), false);
  assert.equal(serviceRecordSettled({ ownership: "unknown", portListening: true }), false);
});
