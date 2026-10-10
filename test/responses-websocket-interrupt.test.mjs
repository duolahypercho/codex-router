import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import test from "node:test";

import { authenticatedRoute } from "../src/caller-auth.mjs";
import {
  handleResponsesWebSocketUpgrade,
  RESPONSES_WEBSOCKET_BETA,
} from "../src/responses-websocket.mjs";

const CALLER_KEY = "test-responses-ws-interrupt-caller-capability-0123456789abcdef";

function waitFor(predicate, timeoutMs = 3_000) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const check = () => {
      if (predicate()) return resolve();
      if (Date.now() - started > timeoutMs) return reject(new Error("condition timed out"));
      setTimeout(check, 10);
    };
    check();
  });
}

function maskedFrame(opcode, payload) {
  const data = Buffer.from(payload || "", "utf8");
  const mask = Buffer.from([0x1f, 0x6b, 0xc3, 0x09]);
  const masked = Buffer.alloc(data.length);
  for (let index = 0; index < data.length; index += 1) {
    masked[index] = data[index] ^ mask[index & 3];
  }
  return Buffer.concat([
    Buffer.from([0x80 | opcode, 0x80 | data.length]),
    mask,
    masked,
  ]);
}

function makePeer(socket, initial = Buffer.alloc(0)) {
  let buffer = Buffer.from(initial);
  const frames = [];
  const waiters = [];
  const consume = () => {
    while (buffer.length >= 2) {
      const opcode = buffer[0] & 0x0f;
      let length = buffer[1] & 0x7f;
      let offset = 2;
      if (length === 126) {
        if (buffer.length < 4) return;
        length = buffer.readUInt16BE(2);
        offset = 4;
      } else if (length === 127) {
        if (buffer.length < 10) return;
        length = Number(buffer.readBigUInt64BE(2));
        offset = 10;
      }
      if (buffer.length < offset + length) return;
      const payload = buffer.subarray(offset, offset + length);
      buffer = buffer.subarray(offset + length);
      const frame = { opcode, payload };
      const waiter = waiters.shift();
      if (waiter) waiter.resolve(frame);
      else frames.push(frame);
    }
  };
  socket.on("data", (chunk) => {
    buffer = buffer.length ? Buffer.concat([buffer, chunk]) : Buffer.from(chunk);
    consume();
  });
  const api = {
    frames,
    sendJson(value) {
      socket.write(maskedFrame(0x1, JSON.stringify(value)));
    },
    nextJson(timeoutMs = 3_000) {
      const queued = frames.shift();
      if (queued && queued.opcode === 0x1) {
        return Promise.resolve(JSON.parse(queued.payload.toString("utf8")));
      }
      if (queued) return this.nextJson(timeoutMs);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("no message arrived")), timeoutMs);
        const waiter = {
          resolve: (frame) => {
            if (frame.opcode !== 0x1) {
              waiters.push(waiter);
              return;
            }
            clearTimeout(timer);
            resolve(JSON.parse(frame.payload.toString("utf8")));
          },
        };
        waiters.push(waiter);
      });
    },
  };
  return api;
}

// The internal plane holds the first turn open after response.created; the
// second turn completes normally.
async function startEdge() {
  let holding = false;
  let internalClosed = false;
  const server = http.createServer(async (request, response) => {
    const route = authenticatedRoute(
      new URL(request.url, "http://127.0.0.1").pathname,
      CALLER_KEY,
    );
    if (route !== "/v1/responses") {
      response.writeHead(401).end();
      return;
    }
    response.writeHead(200, { "content-type": "text/event-stream" });
    if (!holding) {
      holding = true;
      response.write(`event: response.created\ndata: ${JSON.stringify({
        type: "response.created",
        response: { id: "resp_hold", status: "in_progress" },
      })}\n\n`);
      request.on("close", () => {
        internalClosed = true;
      });
      return;
    }
    for (const event of [
      { type: "response.created", response: { id: "resp_done", status: "in_progress" } },
      { type: "response.completed", response: { id: "resp_done", status: "completed" } },
    ]) {
      response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    }
    response.end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  const sockets = new Set();
  server.on("upgrade", (request, socket, head) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    handleResponsesWebSocketUpgrade(request, socket, head, {
      callerKey: CALLER_KEY,
      responsesUrl: `http://127.0.0.1:${port}/_codex-router/${CALLER_KEY}/v1/responses`,
    });
  });
  return {
    port,
    internalClosed: () => internalClosed,
    close() {
      for (const socket of sockets) socket.destroy();
      server.closeAllConnections();
      return new Promise((resolve) => server.close(resolve));
    },
  };
}

async function connectPeer(port) {
  const socket = net.connect(port, "127.0.0.1");
  await new Promise((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("error", reject);
  });
  socket.write([
    `GET /_codex-router/${CALLER_KEY}/v1/responses HTTP/1.1`,
    `Host: 127.0.0.1:${port}`,
    "Upgrade: websocket",
    "Connection: Upgrade",
    `Sec-WebSocket-Key: ${Buffer.alloc(16).fill(3).toString("base64")}`,
    "Sec-WebSocket-Version: 13",
    `OpenAI-Beta: ${RESPONSES_WEBSOCKET_BETA}`,
    "",
    "",
  ].join("\r\n"));
  let received = Buffer.alloc(0);
  const rest = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("handshake timed out")), 2_000);
    const onData = (chunk) => {
      received = Buffer.concat([received, chunk]);
      const end = received.indexOf("\r\n\r\n");
      if (end === -1) return;
      clearTimeout(timer);
      socket.off("data", onData);
      resolve(received.subarray(end + 4));
    };
    socket.on("data", onData);
    socket.once("error", reject);
  });
  return makePeer(socket, rest);
}

test("an interrupt frame cancels the in-flight turn without an error frame", async (t) => {
  const edge = await startEdge();
  t.after(() => edge.close());
  const peer = await connectPeer(edge.port);

  peer.sendJson({
    type: "response.create",
    model: "hold-model",
    input: [{ type: "message", role: "user", content: "hi" }],
    stream: true,
  });
  const created = await peer.nextJson();
  assert.equal(created.type, "response.created");

  peer.sendJson({
    type: "response.interrupt",
    response_id: "resp_hold",
    discard_partial_items: false,
  });
  const cancelled = await peer.nextJson();
  assert.equal(cancelled.type, "response.cancelled");
  assert.equal(cancelled.response_id, "resp_hold");
  await waitFor(() => edge.internalClosed());
  assert.equal(edge.internalClosed(), true);

  // The socket stays usable and no synthetic error follows the cancellation.
  peer.sendJson({
    type: "response.create",
    model: "hold-model",
    input: [{ type: "message", role: "user", content: "next" }],
    stream: true,
  });
  const terminal = await peer.nextJson();
  assert.equal(terminal.type, "response.created");
  const done = await peer.nextJson();
  assert.equal(done.type, "response.completed");
});

test("an interrupt with no turn in flight is answered, not rejected", async (t) => {
  const edge = await startEdge();
  t.after(() => edge.close());
  const peer = await connectPeer(edge.port);
  peer.sendJson({ type: "response.interrupt", response_id: "resp_none" });
  const cancelled = await peer.nextJson();
  assert.equal(cancelled.type, "response.cancelled");
  assert.equal(cancelled.response_id, "resp_none");
});
