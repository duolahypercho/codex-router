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
    if (submissions.length === 1) request.socket.destroy();
    else response.writeHead(200, { "content-type": "text/plain" }).end("Synthetic replay success");
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
  assert.equal(relayFailure?.cause?.code, "UND_ERR_SOCKET");
  assert.equal(waited, true, "the predicate must change after the first retry decision");
  assert.equal(origin.submissions.length, 1, "a visible response must prevent a second real POST");
  assert.equal(relayResult, undefined, "the original transport failure remains the result");
  assert.equal(attempts.length, 1, "attempt metadata must describe only actual submissions");
});

test("transport retry gates are rechecked after backoff without losing response ownership", async (t) => {
  for (const gate of ["permission", "budget", "abort", "open"]) {
    await t.test(gate, async (subtest) => {
      const origin = await originFixture(subtest);
      let permitted = true;
      let clock = 0;
      const controller = new AbortController();
      const attempts = [];
      const pending = fetchWithRetry(origin.url, turn, {
        deliveryPolicy: "availability", retries: 1, backoffMs: 0, budgetMs: 100,
        signal: controller.signal, canRetry: () => permitted, now: () => clock,
        onAttempt: (attempt) => attempts.push(attempt),
        sleepImpl: async () => {
          if (gate === "permission") permitted = false;
          if (gate === "budget") clock = 100;
          if (gate === "abort") controller.abort();
        },
      });
      if (gate === "open") {
        const result = await pending;
        assert.equal(result.retries, 1);
        assert.equal(await result.response.text(), "Synthetic replay success");
        assert.equal(origin.submissions.length, 2);
        assert.equal(origin.submissions[0], origin.submissions[1]);
      } else {
        await assert.rejects(pending, (error) => gate === "abort"
          ? error === controller.signal.reason : error?.cause?.code === "UND_ERR_SOCKET");
        assert.equal(origin.submissions.length, 1);
      }
      assert.equal(attempts.length, gate === "open" ? 2 : 1);
    });
  }
});

test("received HTTP failures stay readable and are never disposed for an automatic retry", async () => {
  for (const deliveryPolicy of ["at-most-once", "availability"]) {
    for (const method of ["GET", "POST"]) {
      let submissions = 0;
      let canceled = 0;
      let slept = 0;
      const original = new Response("Synthetic original diagnostic", { status: 503 });
      original.body.cancel = async () => { canceled += 1; };
      const result = await fetchWithRetry("http://synthetic.invalid", { method }, {
        deliveryPolicy, retries: 2, fetchImpl: async () => { submissions += 1; return original; },
        sleepImpl: async () => { slept += 1; },
      });
      assert.equal(submissions, 1);
      assert.equal(canceled, 0);
      assert.equal(slept, 0);
      assert.equal(result.response, original);
      assert.equal(await result.response.text(), "Synthetic original diagnostic");
      assert.equal(result.retries, 0);
    }
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
