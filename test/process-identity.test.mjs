import assert from "node:assert/strict";
import test from "node:test";

import {
  COLD_START_WINDOWS_PROBE_BUDGET,
  processCommandLine,
  processStartIdentity,
  processStartIdentityProbe,
  stateOwnership,
} from "../src/process-identity.mjs";

// The absolute system PowerShell is preferred and a host without it falls back
// to PATH, so match the executable rather than one spelling.
const POWERSHELL = /powershell\.exe$/i;
// The default is deliberately the tight budget this probe has always had: it is
// spent inside a service stop that declares 15s and a restart phase that
// reserves 10s for the process-owner check, so it must not grow here.
const DEFAULT_TIMEOUT_MS = 5_000;

function timedOut() {
  return { status: null, stdout: "", error: Object.assign(new Error("timed out"), { code: "ETIMEDOUT" }) };
}

test("the default Windows probe budget stays tight for bounded callers", () => {
  const invocations = [];
  const spawn = (command, args, options) => {
    invocations.push({ command, args, options });
    return timedOut();
  };

  assert.equal(processStartIdentity(4242, { spawn, platform: "win32" }), undefined);
  // One attempt: a bounded caller must not spend a second cold-start window.
  assert.equal(invocations.length, 1);
  assert.ok(invocations.every(({ command }) => POWERSHELL.test(command)));
  assert.ok(invocations.every(({ options }) => options.windowsHide === true));
  assert.ok(invocations.every(({ options }) => options.timeout === DEFAULT_TIMEOUT_MS));
});

test("the cold-start budget retries a timed-out probe and can still answer", () => {
  let attempts = 0;
  const spawn = (_command, _args, options) => {
    attempts += 1;
    assert.equal(options.timeout, COLD_START_WINDOWS_PROBE_BUDGET.timeoutMs);
    if (attempts === 1) return timedOut();
    return { status: 0, stdout: "639257393357701209|C:\\Program Files\\nodejs\\node.exe" };
  };

  assert.equal(
    processStartIdentity(4242, { spawn, platform: "win32", budget: COLD_START_WINDOWS_PROBE_BUDGET }),
    "639257393357701209|C:\\Program Files\\nodejs\\node.exe",
  );
  assert.equal(attempts, 2);
});

test("a Windows probe that answered is never retried", () => {
  let attempts = 0;
  const spawn = () => {
    attempts += 1;
    return { status: 3, stdout: "" };
  };

  assert.deepEqual(
    processStartIdentityProbe(4242, {
      spawn,
      platform: "win32",
      budget: COLD_START_WINDOWS_PROBE_BUDGET,
    }),
    { state: "absent" },
  );
  assert.equal(attempts, 1);
});

test("a malformed budget cannot widen the probe", () => {
  const invocations = [];
  const spawn = (_command, _args, options) => {
    invocations.push(options);
    return timedOut();
  };

  assert.equal(
    processStartIdentity(4242, { spawn, platform: "win32", budget: { timeoutMs: -1, attempts: 0 } }),
    undefined,
  );
  assert.equal(invocations.length, 1);
  assert.equal(invocations[0].timeout, DEFAULT_TIMEOUT_MS);
});

test("Windows command-line fallback bounds both CIM and WMI probes", () => {
  const invocations = [];
  const spawn = (command, args, options) => {
    invocations.push({ command, args, options });
    if (invocations.length === 1) return { status: 1, stdout: "" };
    return { status: 0, stdout: 'node "C:\\router\\src\\start.mjs"' };
  };

  assert.equal(
    processCommandLine(4242, { spawn, platform: "win32" }),
    'node "C:\\router\\src\\start.mjs"',
  );
  assert.equal(invocations.length, 2);
  assert.match(invocations[0].args.at(-1), /Get-CimInstance/);
  assert.match(invocations[1].args.at(-1), /Get-WmiObject/);
  assert.ok(invocations.every(({ options }) => options.timeout === DEFAULT_TIMEOUT_MS));
});

test("a timed-out command-line probe is retried only on the cold-start budget", () => {
  const invocations = [];
  const spawn = (_command, args) => {
    invocations.push(String(args.at(-1)));
    if (invocations.length <= 2) return timedOut();
    return { status: 0, stdout: 'node "C:\\router\\src\\start.mjs"' };
  };

  assert.equal(
    processCommandLine(4242, { spawn, platform: "win32", budget: COLD_START_WINDOWS_PROBE_BUDGET }),
    'node "C:\\router\\src\\start.mjs"',
  );
  // CIM, then its retry, then the WMI fallback that answers.
  assert.equal(invocations.length, 3);
});

test("non-Windows process probes keep their existing spawn options", () => {
  let options;
  const spawn = (_command, _args, receivedOptions) => {
    options = receivedOptions;
    return { status: 0, stdout: "Mon Aug 18 00:00:00 2026 /usr/bin/node" };
  };

  assert.equal(
    processStartIdentity(4242, { spawn, platform: "linux" }),
    "Mon Aug 18 00:00:00 2026 /usr/bin/node",
  );
  assert.equal(Object.hasOwn(options, "timeout"), false);
});

// The Windows probe answers `<start-time ticks>|<executable>`. The comparison
// stays exact: a start time that differs by a single tick is a different
// process start, and an identity this process cannot verify is not an identity
// it may act on.
function osIdentity(startedAtMs, executable = "C:\\Program Files\\nodejs\\node.exe") {
  const ticks = BigInt(startedAtMs) * 10000n + 621355968000000000n;
  return `${ticks}|${executable}`;
}

test("ownership reports unknown when the probe could not answer", () => {
  const state = { managed: true, pid: 4242, processIdentity: osIdentity(1790149832010) };
  const alive = (value) => () => ({ state: "alive", identity: value });
  assert.equal(stateOwnership(state, { probe: () => ({ state: "unknown" }) }), "unknown");
  assert.equal(stateOwnership(state, { probe: alive(osIdentity(1790149832010)) }), "owned");
  // A start time one tick away is a different process, not a rounding error.
  assert.equal(stateOwnership(state, { probe: alive(osIdentity(1790149832011)) }), "foreign");
  assert.equal(stateOwnership(state, { probe: alive("not-an-identity") }), "foreign");
  // An answered "absent" is foreign, not unknown: the record is stale, and
  // calling that unidentifiable would describe a process that has already
  // exited as if it were still running.
  assert.equal(stateOwnership(state, { probe: () => ({ state: "absent" }) }), "foreign");
});

test("ownership refuses a state that is not a managed record", () => {
  const alive = { state: "alive", identity: osIdentity(1790149832010) };
  assert.equal(stateOwnership(undefined, { probe: () => alive }), "foreign");
  assert.equal(stateOwnership({ managed: false, pid: 1 }, { probe: () => alive }), "foreign");
  assert.equal(stateOwnership({ managed: true, pid: 0 }, { probe: () => alive }), "foreign");
  // The probe is never consulted for a record that cannot describe our process.
  assert.equal(
    stateOwnership({ managed: true, pid: 1 }, { probe: () => { throw new Error("must not be called"); } }),
    "foreign",
  );
});

test("process identity probes distinguish an absent process from an unknown probe failure", () => {
  assert.deepEqual(
    processStartIdentityProbe(4242, {
      platform: "linux",
      spawn: () => ({ status: 1, stdout: "" }),
    }),
    { state: "absent" },
  );
  assert.deepEqual(
    processStartIdentityProbe(4242, {
      platform: "linux",
      spawn: () => ({ status: null, stdout: "", error: new Error("probe failed") }),
    }),
    { state: "unknown" },
  );
});
