import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import http from "node:http";
import test from "node:test";

import { waitForHealth } from "../src/health-probe.mjs";

const URL_UNDER_TEST = "http://127.0.0.1:1/health";

// A child process as far as waitForHealth is concerned: an exit code, a signal
// code, and an "exit" event.
class FakeChild extends EventEmitter {
  exitCode = null;
  signalCode = null;

  exit(code = 1) {
    this.exitCode = code;
    this.emit("exit", code, null);
  }
}

function jsonResponse(body = {}, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  };
}

// A service that is alive and listening but takes `answerAfterMs` to reply --
// the fork-storm case, where the machine is too starved to schedule the answer
// inside a narrow probe window. Honours the abort signal exactly as fetch does.
function answersAfter(answerAfterMs, body = {}) {
  const abortDurations = [];
  const impl = (_url, options = {}) =>
    new Promise((resolve, reject) => {
      const started = Date.now();
      const timer = setTimeout(() => resolve(jsonResponse(body)), answerAfterMs);
      const { signal } = options;
      if (!signal) return;
      const onAbort = () => {
        clearTimeout(timer);
        abortDurations.push(Date.now() - started);
        // Reject with the signal's own reason, which is what fetch does. For
        // AbortSignal.timeout that reason is a TimeoutError, and telling a
        // timeout apart from a refusal is the distinction this module exists
        // to draw -- a fake that flattened both to a plain Error would let a
        // broken classifier pass.
        reject(signal.reason ?? new Error("aborted"));
      };
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    });
  impl.abortDurations = abortDurations;
  return impl;
}

// Nothing is listening. On loopback that is an instant ECONNREFUSED, never a
// hang -- which is exactly why a refusal is real evidence and an abort is not.
function refusesInstantly() {
  const impl = () => {
    impl.calls += 1;
    return Promise.reject(
      Object.assign(new TypeError("fetch failed"), {
        cause: Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }),
      }),
    );
  };
  impl.calls = 0;
  return impl;
}

test("a healthy service that answers slower than the first probe window still comes up", async () => {
  // Measured on a 10-core macOS box past ~16x fork-storm contention: a
  // forwarder that printed "listening" at ~1.4 s answered every probe later
  // than the flat 1 s abort allowed, so a live service was declared dead.
  const fetchImpl = answersAfter(1_400);
  const started = Date.now();

  await waitForHealth({
    label: "API forwarder",
    url: URL_UNDER_TEST,
    timeoutMs: 5_000,
    fetchImpl,
  });

  const elapsed = Date.now() - started;
  assert.ok(elapsed < 4_500, `should not have burned the budget, took ${elapsed} ms`);
  // The first probe still aborts fast, so a service that is genuinely up is
  // still detected immediately; only the later probes widen.
  assert.ok(
    fetchImpl.abortDurations[0] < 1_300,
    `first probe window should stay ~1 s, was ${fetchImpl.abortDurations[0]} ms`,
  );
  assert.ok(
    fetchImpl.abortDurations.every((duration) => duration < 1_400),
    "no probe should have been aborted after the service was ready to answer",
  );
});

test("the probe window widens with each attempt instead of staying at one second", async () => {
  // Never answers: every probe is aborted by our own timeout, so the recorded
  // durations are the probe windows themselves.
  const fetchImpl = answersAfter(60_000);
  await assert.rejects(
    waitForHealth({
      label: "API forwarder",
      url: URL_UNDER_TEST,
      timeoutMs: 3_000,
      fetchImpl,
    }),
    /Timed out waiting for API forwarder/,
  );
  const [first, second] = fetchImpl.abortDurations;
  assert.ok(fetchImpl.abortDurations.length >= 2, "expected more than one probe");
  assert.ok(second > first + 200, `probe window should grow: ${first} ms then ${second} ms`);
});

test("a genuinely dead service still fails at the nominal budget", async () => {
  // Nothing ever listens and every probe is refused instantly. A refusal is
  // real evidence, so the budget must not be stretched by it.
  const fetchImpl = refusesInstantly();
  const started = Date.now();

  await assert.rejects(
    waitForHealth({
      label: "API forwarder",
      url: URL_UNDER_TEST,
      timeoutMs: 1_500,
      fetchImpl,
    }),
    /Timed out waiting for API forwarder to become healthy/,
  );

  const elapsed = Date.now() - started;
  assert.ok(elapsed >= 1_400, `should have used its budget, took ${elapsed} ms`);
  assert.ok(elapsed < 3_000, `should not have stretched the budget, took ${elapsed} ms`);
});

test("refused probes still back off rather than hammering the port", async () => {
  const fetchImpl = refusesInstantly();
  await assert.rejects(
    waitForHealth({
      label: "LiteLLM gateway",
      url: URL_UNDER_TEST,
      timeoutMs: 1_500,
      fetchImpl,
    }),
    /Timed out/,
  );
  // A flat/absent delay would issue thousands of probes in 1.5 s; the backoff
  // (200 ms -> 2 s) allows a handful.
  assert.ok(fetchImpl.calls <= 10, `expected a handful of probes, made ${fetchImpl.calls}`);
});

// A child that dies mid-probe is reported when that probe's own window closes,
// not the instant it exits. Aborting the in-flight fetch from the exit callback
// would report it sooner and crashes Node on Windows -- a libuv assertion in
// win/async.c, killing the process with 0xC0000409 while it was in the middle of
// reporting the very failure it had diagnosed. So the probe is left to its timer
// and only the sleep after it is skipped. The bound that matters is that the
// report still beats the old behaviour, which sat out the window *and* the sleep.
test("a child that dies while a probe is in flight is reported within one window", async () => {
  const child = new FakeChild();
  const fetchImpl = answersAfter(60_000);
  const killAt = { value: 0 };
  setTimeout(() => {
    killAt.value = Date.now();
    child.exit(1);
  }, 300);

  await assert.rejects(
    waitForHealth({
      label: "LiteLLM gateway",
      url: URL_UNDER_TEST,
      timeoutMs: 30_000,
      fetchImpl,
      child,
    }),
    /LiteLLM gateway exited before becoming healthy/,
  );
  // The first window is 1 s and the kill lands 300 ms into it, so the remaining
  // wait is under a second and no backoff follows it.
  const lag = Date.now() - killAt.value;
  assert.ok(lag < 1_200, `crash should surface within one probe window, took ${lag} ms`);
});

// Waking the sleep on the child's "exit" event would report this faster, and it
// is not worth what it costs: reaching into the loop from that callback crashes
// Node on Windows during startup teardown (0xC0000409, libuv win/async.c:94).
// So a dead child costs at most one backoff interval, exactly as it did before
// this module existed. The bound is asserted rather than left implicit, so
// nobody re-adds the listener believing the delay is an oversight.
test("a child that dies during the backoff sleep is reported within one interval", async () => {
  const child = new FakeChild();
  const fetchImpl = refusesInstantly();
  const killAt = { value: 0 };
  setTimeout(() => {
    killAt.value = Date.now();
    child.exit(1);
  }, 3_000);

  await assert.rejects(
    waitForHealth({
      label: "LiteLLM gateway",
      url: URL_UNDER_TEST,
      timeoutMs: 30_000,
      fetchImpl,
      child,
    }),
    /LiteLLM gateway exited before becoming healthy/,
  );
  // The backoff caps at 2 s, so the wait after the kill cannot exceed that plus
  // the instant refusal that follows it.
  const lag = Date.now() - killAt.value;
  assert.ok(lag < 2_500, `crash should surface within one backoff, took ${lag} ms`);
});

test("a child that already exited is reported without probing at all", async () => {
  const child = new FakeChild();
  child.exitCode = 1;
  const fetchImpl = refusesInstantly();

  await assert.rejects(
    waitForHealth({
      label: "API forwarder",
      url: URL_UNDER_TEST,
      timeoutMs: 30_000,
      fetchImpl,
      child,
    }),
    /API forwarder exited before becoming healthy/,
  );
  assert.equal(fetchImpl.calls, 0);
});

test("the timeout says whether the probes were refused or never answered", async () => {
  // Startup used to report both as a bare timeout, which is the reason a
  // starved-but-healthy service looked identical to a dead one in the log.
  await assert.rejects(
    waitForHealth({
      label: "API forwarder",
      url: URL_UNDER_TEST,
      timeoutMs: 800,
      fetchImpl: refusesInstantly(),
    }),
    /refused/,
  );
  await assert.rejects(
    waitForHealth({
      label: "API forwarder",
      url: URL_UNDER_TEST,
      timeoutMs: 800,
      fetchImpl: answersAfter(60_000),
    }),
    /did not answer within/,
  );
});

test("a real slow HTTP service is polled through fetch until it answers", async () => {
  // Every other case here injects a fetch. This one drives the loop through
  // the real one, so the abort classification is checked against undici's
  // actual behaviour rather than against the stub's.
  let requests = 0;
  const server = http.createServer((request, response) => {
    requests += 1;
    // Leave the first two probes hanging past their window, then answer.
    const delayMs = requests <= 2 ? 30_000 : 0;
    const timer = setTimeout(() => {
      if (response.destroyed) return;
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ service: "codex-router" }));
    }, delayMs);
    response.once("close", () => clearTimeout(timer));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();

  try {
    const started = Date.now();
    await waitForHealth({
      label: "Codex router",
      url: `http://127.0.0.1:${port}/health`,
      timeoutMs: 20_000,
      expectedService: "codex-router",
    });
    const elapsed = Date.now() - started;
    assert.equal(requests, 3);
    assert.ok(elapsed < 10_000, `should have widened, not waited out the budget: ${elapsed} ms`);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

test("a real closed port is refused rather than aborted", async () => {
  // The claim the fix rests on: on loopback, nothing listening refuses at once.
  // If that were not true, a refusal would not be the evidence it is treated as.
  const server = http.createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));

  const started = Date.now();
  await assert.rejects(
    waitForHealth({
      label: "API forwarder",
      url: `http://127.0.0.1:${port}/health`,
      timeoutMs: 1_200,
    }),
    /refused/,
  );
  assert.ok(Date.now() - started < 2_500, "a refused port must not stretch the budget");
});

test("a shutdown interrupts the wait", async () => {
  let shuttingDown = false;
  setTimeout(() => {
    shuttingDown = true;
  }, 100);
  await assert.rejects(
    waitForHealth({
      label: "API forwarder",
      url: URL_UNDER_TEST,
      timeoutMs: 30_000,
      fetchImpl: refusesInstantly(),
      isShuttingDown: () => shuttingDown,
    }),
    /Service startup was interrupted/,
  );
});

test("the frontend wait keeps checking that the right service answered", async () => {
  let answered = 0;
  const fetchImpl = () => {
    answered += 1;
    return Promise.resolve(
      jsonResponse({ service: answered < 3 ? "something-else" : "codex-router" }),
    );
  };

  await waitForHealth({
    label: "Codex router",
    url: URL_UNDER_TEST,
    timeoutMs: 5_000,
    expectedService: "codex-router",
    fetchImpl,
  });
  assert.equal(answered, 3);
});
