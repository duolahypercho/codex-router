import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { closeHttpFixture, observeHttpFixture } from "./http-fixture.mjs";

async function listen(server) {
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  return server.address().port;
}

test("HTTP fixture metadata does not consume the application request body", async () => {
  const server = http.createServer();
  const snapshot = observeHttpFixture(server);
  server.on("request", async (request, response) => {
    assert.equal(request.readableFlowing, null);
    let body = "";
    for await (const chunk of request) body += chunk;
    assert.equal(body, "synthetic-body");
    response.end("ok");
  });
  const port = await listen(server);
  try {
    const response = await fetch(`http://127.0.0.1:${port}/v1/responses?private=query`, {
      method: "POST", body: "synthetic-body",
    });
    assert.equal(await response.text(), "ok");
    const [entry] = snapshot();
    assert.equal(entry.method, "POST");
    assert.equal(entry.path, "v1/responses");
    assert.equal(entry.requestEnded, true);
    assert.equal(entry.responseFinished, true);
    assert.doesNotMatch(JSON.stringify(entry), /synthetic-body|private|query/);
  } finally {
    await closeHttpFixture(server);
  }
});

test("HTTP fixture teardown releases an abandoned active headers-only response", { timeout: 5_000 }, async () => {
  const server = http.createServer((_request, response) => {
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    response.flushHeaders();
  });
  const snapshot = observeHttpFixture(server);
  const port = await listen(server);
  let request;
  await new Promise((resolve, reject) => {
    request = http.get(`http://127.0.0.1:${port}/v1/responses`, response => {
      response.on("error", () => {});
      resolve();
    });
    request.on("error", reject);
  });
  // Positive control for the old cleanup: close() alone leaves the active
  // response open, even though it has stopped accepting new connections.
  let closed = false;
  const closing = new Promise(resolve => server.close(() => { closed = true; resolve(); }));
  let deadline;
  try {
    await delay(50);
    assert.equal(closed, false);
    assert.equal(snapshot()[0].responseEnded, false);
    await Promise.race([
      closeHttpFixture(server),
      new Promise((_resolve, reject) => {
        deadline = setTimeout(() => reject(new Error("fixture cleanup left an active response open")), 1_000);
      }),
    ]);
    await closing;
    assert.equal(closed, true);
  } finally {
    clearTimeout(deadline);
    request.destroy();
    server.closeAllConnections();
  }
});
