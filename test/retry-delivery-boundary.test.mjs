import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";

import { fetchWithRetry, sleep } from "../src/upstream-retry.mjs";

async function listen(t, handler) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  return `http://127.0.0.1:${server.address().port}`;
}

async function originFixture(t) {
  const submissions = [];
  const url = await listen(t, async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    submissions.push(Buffer.concat(chunks).toString());
    response.writeHead(submissions.length === 1 ? 503 : 200, { "content-type": "text/plain" });
    response.end(submissions.length === 1 ? "Synthetic complete-POST failure" : "Synthetic replay success");
  });
  return { url, submissions };
}

const turn = { method: "POST", body: JSON.stringify({ input: "Synthetic executed generation" }) };

test("a caller-visible byte during retry backoff closes the delivery gate", { timeout: 10_000 }, async (t) => {
  const origin = await originFixture(t);
  let clientSawByte;
  const sawByte = new Promise((resolve) => { clientSawByte = resolve; });
  let relayResult;
  let relayFailure;
  let relaySettled;
  const settled = new Promise((resolve) => { relaySettled = resolve; });
  let waited = false;
  const attempts = [];
  const caller = await listen(t, async (_request, response) => {
    try {
      relayResult = await fetchWithRetry(origin.url, turn, {
        deliveryPolicy: "availability", retries: 1, backoffMs: 10, budgetMs: 10_000,
        canRetry: () => !response.headersSent,
        onAttempt: (attempt) => attempts.push(attempt),
        sleepImpl: async () => {
          waited = true;
          response.writeHead(200, { "content-type": "text/event-stream" });
          response.write("data: Synthetic caller-visible progress\n\n");
          await sawByte;
        },
      });
    } catch (error) { relayFailure = error; }
    finally { response.end("data: Synthetic relay settled\n\n"); relaySettled(); }
  });
  const response = await fetch(caller, { signal: AbortSignal.timeout(5_000) });
  const reader = response.body.getReader();
  const first = await reader.read();
  assert.match(Buffer.from(first.value).toString(), /Synthetic caller-visible progress/);
  clientSawByte();
  while (!(await reader.read()).done) { /* Drain the owned caller connection. */ }
  await settled;
  assert.ifError(relayFailure);
  assert.equal(waited, true, "the predicate must change after the first retry decision");
  assert.equal(origin.submissions.length, 1, "a visible response must prevent a second real POST");
  assert.equal(relayResult.retries, 0, "a canceled plan is not a submitted retry");
  assert.equal(attempts.length, 1, "attempt metadata must describe only actual submissions");
});

test("a retry predicate revoked during backoff prevents another POST before any output", { timeout: 10_000 }, async (t) => {
  const origin = await originFixture(t);
  let permitted = true;
  let waits = 0;
  const attempts = [];
  const result = await fetchWithRetry(origin.url, turn, {
    deliveryPolicy: "availability", retries: 1, backoffMs: 10, budgetMs: 10_000,
    canRetry: () => permitted,
    onAttempt: (attempt) => attempts.push(attempt),
    sleepImpl: async () => { waits += 1; permitted = false; },
  });
  assert.equal(waits, 1, "the initial decision must permit entering backoff");
  assert.equal(origin.submissions.length, 1, "revoking the predicate must stop the pending replay");
  assert.equal(result.retries, 0);
  assert.equal(attempts.length, 1);
  assert.equal(await result.response.text(), "Synthetic complete-POST failure", "a canceled backoff must keep the original failure readable");
});

test("the total retry budget must still permit submission after backoff", { timeout: 10_000 }, async (t) => {
  for (const elapsed of [100, 101, 99]) {
    await t.test(`backoff finishes at ${elapsed}ms of a 100ms budget`, async (subtest) => {
      const origin = await originFixture(subtest);
      let clock = 0;
      let waits = 0;
      const attempts = [];
      const result = await fetchWithRetry(origin.url, turn, {
        deliveryPolicy: "availability", retries: 1, backoffMs: 10, budgetMs: 100,
        now: () => clock,
        onAttempt: (attempt) => attempts.push(attempt),
        sleepImpl: async () => { waits += 1; clock = elapsed; },
      });
      const expected = elapsed < 100 ? 2 : 1;
      assert.equal(waits, 1, "the budget must expire during backoff, not during the first attempt");
      assert.equal(origin.submissions.length, expected, "a POST may be resubmitted only while the total budget remains open");
      assert.equal(result.retries, expected - 1, "retry counts must count additional real submissions");
      assert.equal(attempts.length, expected);
      assert.equal(result.response.status, expected === 2 ? 200 : 503);
      assert.equal(await result.response.text(), expected === 2 ? "Synthetic replay success" : "Synthetic complete-POST failure");
    });
  }
});

test("an asynchronous response cancellation is also a delivery-gate boundary", { timeout: 10_000 }, async (t) => {
  for (const change of ["caller permission", "total budget"]) {
    await t.test(change, async (subtest) => {
      const origin = await originFixture(subtest);
      let permitted = true;
      let clock = 0;
      let cancellations = 0;
      const result = await fetchWithRetry(origin.url, turn, {
        deliveryPolicy: "availability", retries: 1, backoffMs: 0, budgetMs: 100,
        canRetry: () => permitted, now: () => clock,
        fetchImpl: async (target, init) => {
          // Keep the real HTTP POST and Response. Instrument only the awaited
          // body cancellation to deterministically expose a concurrent change.
          const response = await fetch(target, init);
          const cancel = response.body.cancel.bind(response.body);
          response.body.cancel = async (...args) => {
            await cancel(...args);
            await Promise.resolve();
            cancellations += 1;
            if (change === "caller permission") permitted = false;
            else clock = 100;
          };
          return response;
        },
        sleepImpl: async () => {},
      });
      assert.equal(cancellations, 1, "the condition must change after cancellation begins");
      assert.equal(origin.submissions.length, 1, "no real POST may cross a gate revoked during body cancellation");
      assert.equal(result.retries, 0);
    });
  }
});

test("retry sleep observes an already-aborted signal without registering a stale wait", { timeout: 2_000 }, async () => {
  const controller = new AbortController();
  controller.abort();
  let settled = false;
  const pending = sleep(250, controller.signal).then(() => { settled = true; });
  await new Promise((resolve) => setImmediate(resolve));
  const immediate = settled;
  await pending;
  assert.equal(immediate, true, "an abort before sleep must close the wait immediately");
});
