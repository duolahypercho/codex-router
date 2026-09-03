import assert from "node:assert/strict";
import test from "node:test";

import {
  processCommandLine,
  processStartIdentity,
  processStartIdentityProbe,
} from "../src/process-identity.mjs";

test("Windows process identity probes are bounded", () => {
  let invocation;
  const spawn = (command, args, options) => {
    invocation = { command, args, options };
    return { status: null, stdout: "", error: Object.assign(new Error("timed out"), { code: "ETIMEDOUT" }) };
  };

  assert.equal(processStartIdentity(4242, { spawn, platform: "win32" }), undefined);
  assert.equal(invocation.command, "powershell.exe");
  assert.equal(invocation.options.windowsHide, true);
  assert.equal(invocation.options.timeout, 5_000);
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
  assert.ok(invocations.every(({ options }) => options.timeout === 5_000));
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
