import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";

import { handleClaudeRequest } from "../src/claude-surface.mjs";

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

async function within(promise, label) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Timed out waiting for ${label}`)), 5_000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return server.address().port;
}

async function close(server) {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}

for (const [label, stream, sendHeaders] of [
  ["before upstream headers", false, false],
  ["during an upstream JSON body", false, true],
  ["during an upstream SSE body", true, true],
]) {
  test(`Claude client cancellation closes the canonical Responses request ${label}`, async (t) => {
    const received = deferred();
    const upstreamClosed = deferred();
    const handled = deferred();
    let surfaceResponse;
    let surface;
    let client;
    const upstream = http.createServer(async (request, response) => {
      response.once("close", () => upstreamClosed.resolve(response.writableEnded));
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      assert.equal(payload.stream, stream);
      if (sendHeaders) {
        response.writeHead(200, { "content-type": stream ? "text/event-stream" : "application/json" });
        response.write(stream
          ? 'event: response.created\ndata: {"type":"response.created","response":{"id":"resp-cancel"}}\n\n'
          : '{"id":"resp-cancel","output":[');
      }
      received.resolve();
      // Deliberately leave the response open until its caller cancels.
    });
    t.after(async () => {
      client?.destroy();
      if (surface) await close(surface);
      await close(upstream);
    });
    const upstreamPort = await listen(upstream);
    surface = http.createServer((request, response) => {
      surfaceResponse = response;
      const initialAbortedListeners = request.listenerCount("aborted");
      const initialCloseListeners = response.listenerCount("close");
      handleClaudeRequest(request, response, "/anthropic/v1/messages", {
        responsesUrl: `http://127.0.0.1:${upstreamPort}/v1/responses`,
        routedModels: () => [{ slug: "deepseek/test" }],
      }).then(() => handled.resolve({
        abortedListeners: request.listenerCount("aborted") - initialAbortedListeners,
        closeListeners: response.listenerCount("close") - initialCloseListeners,
      }));
    });
    const surfacePort = await listen(surface);
    const clientHeaders = deferred();
    client = http.request(`http://127.0.0.1:${surfacePort}/anthropic/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
    });
    client.on("error", () => {});
    client.on("response", (response) => {
      response.on("error", () => {});
      clientHeaders.resolve();
    });
    client.end(JSON.stringify({
      model: "deepseek/test", max_tokens: 32, stream,
      messages: [{ role: "user", content: "hi" }],
    }));
    await within(received.promise, "the upstream request");
    if (stream) await within(clientHeaders.promise, "the SSE response headers");
    // The request body has already completed, so IncomingMessage's aborted
    // event cannot detect this client closing its response connection.
    assert.equal(surfaceResponse.writableEnded, false);
    client.destroy();
    assert.equal(await within(upstreamClosed.promise, "upstream cancellation"), false);
    assert.deepEqual(await within(handled.promise, "the Claude handler to return"), {
      abortedListeners: 0,
      closeListeners: 0,
    });
  });
}

for (const stream of [false, true]) {
  test(`a normally completed Claude ${stream ? "SSE" : "JSON"} response releases cancellation listeners`, async (t) => {
    const handled = deferred();
    const payload = {
      id: "resp-complete", status: "completed",
      output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "done" }] }],
      usage: { input_tokens: 3, output_tokens: 1, total_tokens: 4 },
    };
    const upstream = http.createServer((request, response) => {
      request.resume();
      request.once("end", () => {
        response.writeHead(200, { "content-type": stream ? "text/event-stream" : "application/json" });
        response.end(stream
          ? `data: ${JSON.stringify({ type: "response.completed", response: payload })}\n\ndata: [DONE]\n\n`
          : JSON.stringify(payload));
      });
    });
    t.after(() => close(upstream));
    const upstreamPort = await listen(upstream);
    const surface = http.createServer((request, response) => {
      const initialAbortedListeners = request.listenerCount("aborted");
      const initialCloseListeners = response.listenerCount("close");
      handleClaudeRequest(request, response, "/anthropic/v1/messages", {
        responsesUrl: `http://127.0.0.1:${upstreamPort}/v1/responses`,
        routedModels: () => [{ slug: "deepseek/test" }],
      }).then(() => handled.resolve({
        abortedListeners: request.listenerCount("aborted") - initialAbortedListeners,
        closeListeners: response.listenerCount("close") - initialCloseListeners,
      }));
    });
    t.after(() => close(surface));
    const surfacePort = await listen(surface);
    const response = await fetch(`http://127.0.0.1:${surfacePort}/anthropic/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "deepseek/test", max_tokens: 32, stream,
        messages: [{ role: "user", content: "hi" }],
      }),
      signal: AbortSignal.timeout(5_000),
    });
    assert.equal(response.status, 200);
    if (stream) {
      const text = await response.text();
      assert.match(text, /"text":"done"/);
      assert.equal((text.match(/event: message_stop/g) || []).length, 1);
      assert.doesNotMatch(text, /event: error/);
    } else {
      const body = await response.json();
      assert.deepEqual(body.content, [{ type: "text", text: "done" }]);
      assert.equal(body.stop_reason, "end_turn");
    }
    assert.deepEqual(await within(handled.promise, "the completed Claude handler"), {
      abortedListeners: 0,
      closeListeners: 0,
    });
  });
}
