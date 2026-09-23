import assert from "node:assert/strict";
import test from "node:test";

import { superviseGateway } from "../src/gateway-supervisor.mjs";
import {
  describeChildExit,
  fatalExitFollowUp,
  isWindowsFatalExit,
} from "../src/fatal-exit.mjs";

// Issue #465: the service log recorded a Windows native abort as a bare
// number -- `[codex-router] Codex router exited (code=3221226505,
// signal=null).` -- which identifies no subsystem. The exit fragment must name
// a Windows fatal status when the code is one, and ordinary or signalled exits
// must render byte-identical to before.

test("ordinary and signalled exits render exactly as before", () => {
  assert.equal(describeChildExit({ code: 1, signal: null }), "code=1, signal=null");
  assert.equal(describeChildExit({ code: 0, signal: null }), "code=0, signal=null");
  assert.equal(describeChildExit({ code: 95, signal: null }), "code=95, signal=null");
  assert.equal(
    describeChildExit({ code: null, signal: "SIGTERM" }),
    "code=null, signal=SIGTERM",
  );
  // Just below the NTSTATUS error range: not a fatal status, no annotation.
  assert.equal(
    describeChildExit({ code: 0xbfffffff, signal: null }),
    "code=3221225471, signal=null",
  );
  assert.equal(isWindowsFatalExit({ code: 1, signal: null }), false);
  assert.equal(isWindowsFatalExit({ code: null, signal: "SIGTERM" }), false);
  assert.equal(isWindowsFatalExit({ code: 0xbfffffff, signal: null }), false);
});

test("the #465 abort is named in the exit fragment", () => {
  assert.equal(
    describeChildExit({ code: 3221226505, signal: null }),
    "code=3221226505, signal=null (0xC0000409 STATUS_STACK_BUFFER_OVERRUN)",
  );
  assert.equal(isWindowsFatalExit({ code: 3221226505, signal: null }), true);
});

test("the signed spelling of a fatal status classifies the same death", () => {
  // Upstream reports print -1073740791 where the service log prints
  // 3221226505; both are 0xC0000409. The original rendering is preserved and
  // the interpretation is appended.
  assert.equal(
    describeChildExit({ code: -1073740791, signal: null }),
    "code=-1073740791, signal=null (0xC0000409 STATUS_STACK_BUFFER_OVERRUN)",
  );
  assert.equal(isWindowsFatalExit({ code: -1073740791, signal: null }), true);
});

test("the other fatal statuses supervisors must classify are named", () => {
  const cases = [
    [3221225477, "0xC0000005 STATUS_ACCESS_VIOLATION"],
    [3221225501, "0xC000001D STATUS_ILLEGAL_INSTRUCTION"],
    [3221226356, "0xC0000374 STATUS_HEAP_CORRUPTION"],
    [3221225725, "0xC00000FD STATUS_STACK_OVERFLOW"],
  ];
  for (const [code, named] of cases) {
    assert.equal(
      describeChildExit({ code, signal: null }),
      `code=${code}, signal=null (${named})`,
    );
    assert.equal(isWindowsFatalExit({ code, signal: null }), true);
  }
});

test("an unlisted NTSTATUS-range code gains hex but no invented name", () => {
  // #171 recorded `exited (code=4294967295)` on Windows: fatal-range, but no
  // name is claimed for it.
  assert.equal(
    describeChildExit({ code: 4294967295, signal: null }),
    "code=4294967295, signal=null (0xFFFFFFFF)",
  );
  assert.equal(
    describeChildExit({ code: 0xc0000000, signal: null }),
    "code=3221225472, signal=null (0xC0000000)",
  );
});

test("non-integer codes never throw and never classify", () => {
  assert.equal(
    describeChildExit({ code: "3221226505", signal: null }),
    "code=3221226505, signal=null",
  );
  assert.equal(
    describeChildExit({ code: undefined, signal: null }),
    "code=undefined, signal=null",
  );
  assert.equal(isWindowsFatalExit({ code: "3221226505", signal: null }), false);
  assert.equal(fatalExitFollowUp({ code: "3221226505", signal: null }), undefined);
});

test("only a native abort earns the capture pointer", () => {
  assert.equal(fatalExitFollowUp({ code: 1, signal: null }), undefined);
  assert.equal(fatalExitFollowUp({ code: 0, signal: null }), undefined);
  assert.equal(fatalExitFollowUp({ code: null, signal: "SIGTERM" }), undefined);
  assert.equal(fatalExitFollowUp({ code: 3221225471, signal: null }), undefined);

  const followUp = fatalExitFollowUp({ code: 3221226505, signal: null });
  assert.match(followUp, /0xC0000409 STATUS_STACK_BUFFER_OVERRUN/);
  // The pointer must be credential-safe: exclusion flags named, raw
  // report/dump upload forbidden, fast-fail parameter 0 called out as the
  // piece that distinguishes the subsystems.
  assert.match(followUp, /--report-on-fatalerror/);
  assert.match(followUp, /--report-exclude-env/);
  assert.match(followUp, /--report-exclude-network/);
  assert.match(followUp, /parameter 0/);
  assert.match(followUp, /Do not upload raw reports or dumps/);
  assert.match(followUp, /#465/);
});

// The supervisor's restart line is the record that survives when the service
// itself stays up (the gateway is restarted in place), so the wiring matters
// there too: a fatal gateway abort must be named and must still restart.
test("a gateway that dies with a Windows fatal status is named and still restarted", async () => {
  const logs = [];
  const child = { exitCode: null, signalCode: null, resolvers: [] };
  const waitForExit = (target, label) => {
    if (target.exitCode !== null || target.signalCode !== null) {
      return Promise.resolve({ label, code: target.exitCode, signal: target.signalCode });
    }
    return new Promise((resolve) => {
      target.resolvers.push(({ code, signal }) => resolve({ label, code, signal }));
    });
  };
  let shuttingDown = false;
  const replacements = [];
  const done = superviseGateway({
    child,
    start: () => {
      const next = { exitCode: null, signalCode: null, resolvers: [] };
      replacements.push(next);
      return next;
    },
    waitForExit,
    waitForHealth: () => Promise.resolve(),
    isShuttingDown: () => shuttingDown,
    log: (message) => logs.push(message),
    sleep: async () => {},
  });
  let settled = false;
  void done.then(() => {
    settled = true;
  });

  child.exitCode = 3221226505;
  for (const resolve of child.resolvers.splice(0)) resolve({ code: 3221226505, signal: null });
  for (let tick = 0; tick < 6; tick += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }

  assert.equal(settled, false, "a fatal gateway abort must not end the service");
  assert.equal(replacements.length, 1, "no replacement gateway was spawned");
  assert.match(
    logs[0],
    /exited \(code=3221226505, signal=null \(0xC0000409 STATUS_STACK_BUFFER_OVERRUN\)\); restarting/,
  );
  assert.match(logs[1], /healthy again after 1 restart/);

  shuttingDown = true;
  replacements[0].exitCode = 0;
  for (const resolve of replacements[0].resolvers.splice(0)) resolve({ code: 0, signal: null });
  await done;
});
