import assert from "node:assert/strict";
import http from "node:http";
import { Transform } from "node:stream";
import test from "node:test";

import { endStreamedResponse, pipeResponse } from "../src/http-utils.mjs";

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve(server.address().port));
  });
}

function close(server) {
  return new Promise((resolve) => server.close(resolve));
}

// A client that hangs up mid-stream makes the response emit "close" without
// ever emitting "finish" or "error". pipeResponse must still settle, otherwise
// the router's in-flight counter never releases the request.
test("pipeResponse settles when the client disconnects mid-stream", async () => {
  let settled = false;
  let pipeError;

  const server = http.createServer(async (request, response) => {
    const upstream = {
      status: 200,
      headers: new Map([["content-type", "text/event-stream"]]),
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("data: first\n\n"));
          // Never closed: the stream stays open like a live SSE upstream.
        },
      }),
    };
    try {
      await pipeResponse(upstream, response, new Set());
    } catch (error) {
      pipeError = error;
    }
    settled = true;
  });

  const port = await listen(server);

  await new Promise((resolve, reject) => {
    const request = http.request({ host: "127.0.0.1", port, path: "/" }, (response) => {
      response.once("data", () => {
        request.destroy();
        resolve();
      });
    });
    request.once("error", () => resolve());
    request.end();
  });

  const deadline = Date.now() + 2_000;
  while (!settled && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  await close(server);
  assert.equal(settled, true, "pipeResponse never settled after client disconnect");
  assert.equal(pipeError, undefined);
});

test("pipeResponse resolves after a complete response", async () => {
  let settled = false;

  const server = http.createServer(async (request, response) => {
    const upstream = {
      status: 200,
      headers: new Map([["content-type", "text/plain"]]),
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("done"));
          controller.close();
        },
      }),
    };
    await pipeResponse(upstream, response, new Set());
    settled = true;
  });

  const port = await listen(server);
  const body = await fetch(`http://127.0.0.1:${port}/`).then((r) => r.text());

  await close(server);
  assert.equal(body, "done");
  assert.equal(settled, true);
});

// Read a response with the raw client so a socket reset is distinguishable
// from a complete message: a reset mid-chunked-body emits "aborted"/"error"
// and never "end", which is exactly what a reqwest client reports as
// "error decoding response body".
function readRaw(port) {
  return new Promise((resolve, reject) => {
    const request = http.request({ host: "127.0.0.1", port, path: "/" }, (response) => {
      let body = "";
      let aborted = false;
      response.setEncoding("utf8");
      response.on("data", (chunk) => {
        body += chunk;
      });
      response.once("aborted", () => {
        aborted = true;
      });
      response.once("error", () => {
        aborted = true;
      });
      response.once("end", () => resolve({ body, aborted, complete: response.complete }));
      response.once("close", () => {
        if (!response.complete) resolve({ body, aborted: true, complete: false });
      });
    });
    request.once("error", reject);
    request.end();
  });
}

function failingSseUpstream(message) {
  return {
    status: 200,
    headers: new Map([["content-type", "text/event-stream"]]),
    body: new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("data: first\n\n"));
        setTimeout(() => controller.error(new Error(message)), 10);
      },
    }),
  };
}

// `.pipe()` forwards neither errors nor destroy, so an upstream body that
// failed mid-stream left the response half-written and open; the router then
// reset the socket, and the client saw only a transport decode failure with no
// cause. `pipeline` must surface the error with its message so the router can
// log it, and must leave the response endable so the chunked body terminates.
test("an upstream body that fails mid-stream ends the chunked body instead of resetting", async () => {
  let pipeError;
  let headersCommitted;
  const logged = [];
  const transform = new Transform({
    transform(chunk, _encoding, callback) {
      callback(null, chunk);
    },
  });

  const server = http.createServer(async (request, response) => {
    try {
      await pipeResponse(
        failingSseUpstream("upstream exploded"),
        response,
        new Set(),
        [transform],
      );
    } catch (error) {
      pipeError = error;
      // The router keys its meter off this: an upstream failure after the
      // head was committed must record an abort, not the committed 200.
      headersCommitted = response.headersSent;
      // The router's top-level handler: log the cause, then terminate the
      // stream gracefully rather than destroying the socket.
      logged.push(
        `[codex-router] request failed: ${
          error instanceof Error ? `${error.name}: ${error.message}` : String(error)
        }`,
      );
      endStreamedResponse(response);
    }
  });

  const port = await listen(server);
  const result = await readRaw(port);
  await close(server);

  assert.equal(pipeError instanceof Error, true, "the upstream failure must surface");
  assert.equal(pipeError.message, "upstream exploded");
  assert.equal(
    headersCommitted,
    true,
    "the failure surfaced after the 200 head was already committed",
  );
  // The message is what made this diagnosable at all; the old handler logged a
  // bare string with no error attached.
  assert.deepEqual(logged, ["[codex-router] request failed: Error: upstream exploded"]);

  assert.equal(result.aborted, false, "the socket was reset instead of ending the body");
  assert.equal(result.complete, true, "the chunked body never reached its terminator");
  assert.match(result.body, /data: first/);
  // A silently truncated SSE stream reads to the client as a short successful
  // turn, so the failure is stated as a terminal event before the clean end.
  assert.match(result.body, /event: error/);
  assert.match(result.body, /local_router_stream_failed/);
  // The frame also carries the wire's terminator. Without it a client whose
  // parser waits for end-of-stream reports "stream closed before
  // response.completed" / "error decoding response body" instead of the failure
  // stated right above it (measured 2026-09-21 on a routed client).
  assert.match(result.body, /data: \[DONE\]/);

  // `pipeline` tears the whole chain down; `.pipe()` left the transform alive.
  assert.equal(transform.destroyed, true, "the failure did not destroy the chain");
});

// The case above fails between two complete events, which is the lucky one. A
// real reset lands wherever it lands, and transforms forward upstream's chunk
// boundaries verbatim, so the client is often left holding an unterminated
// `data:` line. Writing the terminal frame straight onto it produces no error
// event at all: a conforming parser reads `event: error` as more of the
// previous event's data, so the one signal saying the router lost the stream
// becomes garbage glued to the last delta.
test("a mid-line upstream failure still yields a parseable terminal error event", async () => {
  const partial = 'data: {"type":"response.output_text.delta","delta":"unterminated';
  const upstream = {
    status: 200,
    headers: new Map([["content-type", "text/event-stream"]]),
    body: new ReadableStream({
      start(controller) {
        // No trailing newline: the stream dies mid-field.
        controller.enqueue(new TextEncoder().encode(partial));
        setTimeout(() => controller.error(new Error("reset mid-line")), 10);
      },
    }),
  };

  const server = http.createServer(async (request, response) => {
    try {
      await pipeResponse(upstream, response, new Set(), []);
    } catch {
      endStreamedResponse(response);
    }
  });

  const port = await listen(server);
  const result = await readRaw(port);
  await close(server);

  assert.equal(result.complete, true, "the chunked body never reached its terminator");

  // The field name must begin a line of its own. Without the blank-line prefix
  // this assertion fails: the body reads "...unterminatedevent: error".
  assert.match(
    result.body,
    /\nevent: error\n/,
    "the terminal frame was glued onto the unterminated data line",
  );

  // And the frame must survive an actual SSE parse rather than merely appearing
  // in the bytes: split on the blank-line dispatch boundary and require an
  // event whose own `event:` field is `error` and whose data parses.
  const events = result.body.split(/\r?\n\r?\n/).filter((block) => block.trim());
  const errorEvent = events.find((block) => /^event: error$/m.test(block));
  assert.ok(errorEvent, "no dispatched event declared itself an error");
  const dataLine = errorEvent.split(/\r?\n/).find((line) => line.startsWith("data: "));
  assert.equal(
    JSON.parse(dataLine.slice(6)).code,
    "local_router_stream_failed",
    "the terminal frame did not carry the router's failure code",
  );

  // The truncated delta is unavoidable -- upstream died there -- but it must
  // not have absorbed the router's frame.
  assert.equal(
    /unterminatedevent/.test(result.body),
    false,
    "router protocol text leaked into the model's output span",
  );

  // A dispatched end marker must follow, so a parser that waits for
  // end-of-stream sees a complete stream rather than a transport failure.
  assert.ok(
    events.some((block) => block.trim() === "data: [DONE]"),
    "the terminal frame did not carry the wire's end marker",
  );
});

// Only SSE gets a terminal event. Injecting one into a JSON body would corrupt
// it; a truncated JSON body already fails the client's parser, and a clean end
// still beats a reset because the failure is a parse error rather than an
// unexplained transport reset.
test("a non-SSE body is ended without an injected event frame", async () => {
  let pipeError;

  const server = http.createServer(async (request, response) => {
    const upstream = {
      status: 200,
      headers: new Map([["content-type", "application/json"]]),
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"partial":'));
          setTimeout(() => controller.error(new Error("upstream exploded")), 10);
        },
      }),
    };
    try {
      await pipeResponse(upstream, response, new Set());
    } catch (error) {
      pipeError = error;
      endStreamedResponse(response);
    }
  });

  const port = await listen(server);
  const result = await readRaw(port);
  await close(server);

  assert.equal(pipeError.message, "upstream exploded");
  assert.equal(result.aborted, false);
  assert.equal(result.complete, true);
  assert.equal(result.body, '{"partial":');
});

// A response that already ended, or whose client is gone, must not be written
// to again.
test("endStreamedResponse is a no-op on a finished or destroyed response", async () => {
  const server = http.createServer((request, response) => {
    response.setHeader("content-type", "text/event-stream");
    response.end("data: done\n\n");
    endStreamedResponse(response);
    response.destroy();
    endStreamedResponse(response);
  });

  const port = await listen(server);
  const result = await readRaw(port);
  await close(server);

  assert.equal(result.body, "data: done\n\n");
});

// A stream that dies after its head is committed can no longer change status,
// so the terminal error event is the only place the cause can reach the user.
// Codex reports a stream that just stops as `stream disconnected before
// completion`, which names nothing.
test("endStreamedResponse states a diagnosed cause instead of the generic one", async () => {
  const server = http.createServer((request, response) => {
    response.setHeader("content-type", "text/event-stream");
    response.write("data: partial\n\n");
    endStreamedResponse(response, {
      message:
        "The local router lost the upstream response stream: chatgpt.com reset the connection.",
    });
  });

  const port = await listen(server);
  const result = await readRaw(port);
  await close(server);

  assert.match(result.body, /event: error/);
  // Parse the error frame's own data line (the body's first `data:` line is the
  // partial delta): the terminal frame now also carries the wire's end marker,
  // so the body after it is not a bare JSON payload.
  const errorFrame = result.body.slice(result.body.indexOf("event: error"));
  const dataLine = errorFrame.split(/\r?\n/).find((line) => line.startsWith("data: "));
  const data = JSON.parse(dataLine.slice(6));
  // The code is the stable half a client may branch on; only the message
  // gains the cause.
  assert.equal(data.code, "local_router_stream_failed");
  assert.equal(
    data.message,
    "The local router lost the upstream response stream: chatgpt.com reset the connection.",
  );
});

test("endStreamedResponse keeps its generic wording when nothing was diagnosed", async () => {
  const server = http.createServer((request, response) => {
    response.setHeader("content-type", "text/event-stream");
    response.write("data: partial\n\n");
    endStreamedResponse(response, { message: undefined });
  });

  const port = await listen(server);
  const result = await readRaw(port);
  await close(server);

  const errorFrame = result.body.slice(result.body.indexOf("event: error"));
  const dataLine = errorFrame.split(/\r?\n/).find((line) => line.startsWith("data: "));
  const data = JSON.parse(dataLine.slice(6));
  assert.equal(data.code, "local_router_stream_failed");
  assert.match(data.message, /lost the upstream response stream/);
});
