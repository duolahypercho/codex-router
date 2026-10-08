import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import http from "node:http";
import { Readable } from "node:stream";
import test from "node:test";

import {
  applyKeepAliveTimeouts,
  installGracefulShutdown,
  markResponsesStream,
  writeEventStreamHead,
} from "../src/http-utils.mjs";
import { responsesStreamFailureTransform } from "../src/responses-stream-failure.mjs";

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve(server.address().port));
  });
}

// The handler is driven through a custom event rather than a real signal so a
// test never depends on the runner's own signal disposition.
const SHUTDOWN_EVENT = "codex-router-test-shutdown";

function shutdownHarness(server, { drainMs, flushMs }) {
  let exitCode;
  const exited = new Promise((resolve) => {
    installGracefulShutdown(server, {
      label: "test",
      signals: [SHUTDOWN_EVENT],
      drainMs,
      flushMs,
      exit: (code) => {
        exitCode = code;
        resolve(code);
      },
    });
  });
  return { exited, code: () => exitCode };
}

function get(port, path = "/") {
  return new Promise((resolve, reject) => {
    const request = http.get({ host: "127.0.0.1", port, path }, resolve);
    request.on("error", reject);
  });
}

// One reader for the whole body, so waiting for the first chunk does not
// consume it: `firstChunk` settles as soon as anything arrives and `body`
// still resolves with everything.
function read(response) {
  let body = "";
  let sawChunk;
  const firstChunk = new Promise((resolve) => {
    sawChunk = resolve;
  });
  const done = new Promise((resolve, reject) => {
    response.setEncoding("utf8");
    response.on("data", (chunk) => {
      body += chunk;
      sawChunk();
    });
    response.on("end", () => resolve(body));
    // A reset socket surfaces here (and as `aborted`), which is exactly the
    // failure this shutdown path exists to avoid.
    response.on("error", reject);
  });
  return { firstChunk, body: done };
}

// The regression: a restart used to SIGKILL the router while a turn was
// streaming, and the reset socket cost the chunked terminator. Codex reported
// that as `stream disconnected before completion: error decoding response
// body` -- a transport fault where the truth was "a model was published".
// A drained shutdown must leave the client with a well-formed body it can
// read to the end, carrying a terminal `error` event that says what happened.
test("a streaming response is ended, not reset, when the service shuts down", async () => {
  const server = http.createServer((_request, response) => {
    writeEventStreamHead(response);
    response.write("data: first\n\n");
    // Never ended: a live turn at the moment the restart lands.
  });
  applyKeepAliveTimeouts(server);
  const port = await listen(server);
  const { exited } = shutdownHarness(server, { drainMs: 25 });

  const response = await get(port, "/stream");
  const stream = read(response);
  await stream.firstChunk;
  process.emit(SHUTDOWN_EVENT);

  const body = await stream.body;
  assert.equal(response.complete, true);
  assert.match(body, /^data: first\n\n/);
  assert.match(body, /\nevent: error\n/);
  const frame = JSON.parse(body.slice(body.indexOf('data: {')).replace(/^data: /, "").trim());
  assert.equal(frame.code, "local_router_stream_failed");
  assert.match(frame.message, /restarting/);
  assert.equal(await exited, 0);
  process.removeAllListeners(SHUTDOWN_EVENT);
});

// A request still waiting on an upstream has no committed head, so it can
// still be answered with a status instead of an empty-looking 200.
test("a request with no head sent yet is answered 503 when the service shuts down", async () => {
  let arrived;
  const received = new Promise((resolve) => {
    arrived = resolve;
  });
  const server = http.createServer(() => {
    // Never answered: the upstream call is still outstanding.
    arrived();
  });
  applyKeepAliveTimeouts(server);
  const port = await listen(server);
  const { exited } = shutdownHarness(server, { drainMs: 25 });

  const pending = get(port, "/responses");
  await received;
  process.emit(SHUTDOWN_EVENT);
  const response = await pending;
  const body = await read(response).body;
  assert.equal(response.statusCode, 503);
  assert.equal(JSON.parse(body).error.type, "local_router_restarting");
  assert.equal(await exited, 0);
  process.removeAllListeners(SHUTDOWN_EVENT);
});

test("shutdown retains marked Responses identity and sends a typed failure before clean EOF", async () => {
  const identity = { id: "resp_shutdown", model: "fixture/model", created_at: 1_791_388_800 };
  const prologue = `event: response.created\ndata: ${JSON.stringify({ type: "response.created", sequence_number: 9, response: identity })}\n\n`;
  const server = http.createServer((_request, response) => {
    markResponsesStream(response);
    writeEventStreamHead(response);
    Readable.from([prologue]).pipe(responsesStreamFailureTransform(response, "text/event-stream")).pipe(response, { end: false });
  });
  applyKeepAliveTimeouts(server);
  const port = await listen(server);
  const { exited } = shutdownHarness(server, { drainMs: 25 });
  const response = await get(port, "/responses");
  const stream = read(response);
  await stream.firstChunk;
  process.emit(SHUTDOWN_EVENT);
  const body = await stream.body;
  assert.equal(response.complete, true);
  const block = body.split(/\r?\n\r?\n/).find((value) => value.startsWith("event: response.failed"));
  assert.ok(block);
  const failure = JSON.parse(block.split("\n").find((line) => line.startsWith("data: ")).slice(6));
  assert.equal(failure.sequence_number, 10);
  assert.equal(failure.response.id, identity.id);
  assert.equal(failure.response.error.code, "server_error");
  assert.match(failure.response.error.message, /restarting/);
  assert.doesNotMatch(body, /\[DONE\]|response.completed/);
  assert.equal(await exited, 0);
  process.removeAllListeners(SHUTDOWN_EVENT);
});

// The drain exists for turns in flight. With none, the shutdown must not wait
// on it -- and the two-minute idle keep-alive sockets the server deliberately
// holds must not delay the exit either.
test("an idle service exits without waiting out the drain window", async () => {
  const server = http.createServer((_request, response) => response.end("ok"));
  applyKeepAliveTimeouts(server);
  const port = await listen(server);
  const { exited } = shutdownHarness(server, { drainMs: 30_000 });

  const response = await get(port, "/health");
  await read(response).body;
  const startedAt = Date.now();
  process.emit(SHUTDOWN_EVENT);
  assert.equal(await exited, 0);
  assert.ok(Date.now() - startedAt < 5_000, "shutdown waited on the drain window");
  process.removeAllListeners(SHUTDOWN_EVENT);
});

// A canceled transformed stream can close its ServerResponse before Node
// releases the connection from server.close(). The response tracker is empty
// in that state, so returning early from shutdown leaves the process waiting on
// the two-minute keep-alive timeout. The backstop applies to that untracked
// state as well as to responses that are still visibly live.
test("a pending server close is bounded when no response remains tracked", async () => {
  const signal = `${SHUTDOWN_EVENT}-untracked`;
  const server = new EventEmitter();
  let forced = 0;
  server.close = () => {};
  server.closeIdleConnections = () => {};
  server.closeAllConnections = () => {
    forced += 1;
  };

  const exited = new Promise((resolve) => {
    installGracefulShutdown(server, {
      label: "test-untracked",
      signals: [signal],
      drainMs: 25,
      flushMs: 25,
      exit: resolve,
    });
  });
  process.emit(signal);

  // The shutdown backstop runs on timers it deliberately unrefs, because a
  // real process always has the listening socket keeping the loop alive. This
  // fake server holds nothing, so without a ref'd handle of our own the loop
  // can empty -- and the runner cancel this still-pending test -- before the
  // 25ms drain window ever fires. Hold the loop open until the exit lands.
  const keepLoopAlive = setInterval(() => {}, 10);
  try {
    assert.equal(await exited, 0);
    assert.equal(forced, 1);
  } finally {
    clearInterval(keepLoopAlive);
    process.removeAllListeners(signal);
  }
});
