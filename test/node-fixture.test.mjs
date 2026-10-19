import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { spawnNodeFixture, waitForNodeFixture } from "./node-fixture.mjs";
import { openPort } from "./port-pool.mjs";

async function fixture(t, scenario, delayMs = 0) {
  const port = await openPort();
  const child = spawnNodeFixture(fileURLToPath(new URL("./fixtures/node-fixture-child.mjs", import.meta.url)), {
    env: { ...process.env, NODE_FIXTURE_PORT: String(port), NODE_FIXTURE_SCENARIO: scenario, NODE_FIXTURE_DELAY_MS: String(delayMs) },
  });
  const closed = new Promise(resolve => child.once("close", resolve));
  const messages = [];
  child.on("message", message => messages.push(message));
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await closed;
  });
  return { child, messages, url: `http://127.0.0.1:${port}/ready` };
}

test("cold module initialization does not consume the HTTP readiness budget", async t => {
  const warnings = [];
  t.mock.method(console, "error", message => warnings.push(message));
  const { child, url, messages } = await fixture(t, "ready", 1_250);
  await waitForNodeFixture(url, child, { timeoutMs: 1_000 });
  assert.ok(messages.some(message => message.nodeFixturePhase === "initialized"));
  assert.deepEqual(messages.filter(message => message.nodeFixturePhase).map(message => message.nodeFixturePhase), ["initialized", "binding", "listening"]);
  const listening = messages.find(message => message.nodeFixturePhase === "listening");
  assert.ok(listening.elapsedMs > 1_000, "initialization must exceed the HTTP readiness budget");
  assert.ok(messages.some(message => message.nodeFixtureRequest));
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /Slow Node fixture warm-up/);
  assert.match(warnings[0], /"phase":"listening"/);
  assert.match(warnings[0], /"listenCpu":/);
  assert.match(warnings[0], /"bindingMs":/);
});

test("a child that never listens still has a finite initialization deadline", async t => {
  const { child, url } = await fixture(t, "ready", 30_000);
  await assert.rejects(waitForNodeFixture(url, child, { warmupMs: 200 }), error => {
    assert.match(error.message, /warm-up timed out/);
    assert.match(error.message, /"phase":"(?:created|spawned|initialized)"/);
    return true;
  });
});

test("an initialization crash reports its exit and stderr before any HTTP probe", async t => {
  const { child, url, messages } = await fixture(t, "exit");
  await assert.rejects(waitForNodeFixture(url, child), error => {
    assert.match(error.message, /Child exited before readiness/);
    assert.match(error.message, /"exitCode":7/);
    assert.match(error.message, /fixture initialization failed/);
    return true;
  });
  assert.equal(messages.some(message => message.nodeFixtureRequest), false);
});

test("a listener that sends headers and stalls its body cannot report readiness", { timeout: 25_000 }, async t => {
  const { child, url, messages } = await fixture(t, "stall-body");
  await assert.rejects(waitForNodeFixture(url, child, { timeoutMs: 1_500, attemptMs: 500 }), /HTTP readiness timed out/);
  assert.ok(messages.some(message => message.nodeFixtureRequest), "the body-stall fault must have been reached");
});

test("a listening but unhealthy endpoint retains the bounded HTTP failure", async t => {
  const { child, url, messages } = await fixture(t, "not-ready");
  await assert.rejects(waitForNodeFixture(url, child, { timeoutMs: 1_500, attemptMs: 500 }), error => {
    assert.match(error.message, /HTTP readiness timed out/);
    assert.match(error.message, /"phase":"listening"/);
    assert.match(error.message, /"lastHTTPStatus":503/);
    return true;
  });
  assert.ok(messages.some(message => message.nodeFixtureRequest));
});
