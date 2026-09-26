import assert from "node:assert/strict";
import test from "node:test";

import {
  COLD_START_WINDOWS_PROBE_BUDGET,
  processCommandLine,
  processStartIdentity,
  processStartIdentityProbe,
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
