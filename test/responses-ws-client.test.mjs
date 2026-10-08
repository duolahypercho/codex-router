import assert from "node:assert/strict";
import http from "node:http";
import { createHash, randomBytes } from "node:crypto";
import { Readable } from "node:stream";
import test from "node:test";

import { authenticatedRoute } from "../src/caller-auth.mjs";
import { handleResponsesWebSocketUpgrade } from "../src/responses-websocket.mjs";
import {
  RESPONSES_WEBSOCKET_BETA,
  ResponsesWebSocketClient,
  WsUpgradeRefusedError,
  collectResponsesRequest,
  markWsTransportFailure,
  nativeWebSocketTransportEnabled,
  rateLimitHeadersFromEvents,
  responsesWebSocketUrl,
  responsesWebSocketTransportUsable,
  wsTransportAvailable,
} from "../src/responses-ws-client.mjs";

const CALLER_KEY = "test-responses-ws-client-caller-capability-0123456789abcdef";

function waitFor(predicate, timeoutMs = 2_000) {
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

// A fake provider that is itself the router's WebSocket edge: it speaks the
// exact same protocol the real upstreams speak, because they all implement
// the same contract the edge implements. `internalHandler` decides what the
// provider's own HTTP plane answers, which the edge converts into frames.
async function startFakeProvider(internalHandler) {
  const upgradeRequests = [];
  const server = http.createServer(async (request, response) => {
    try {
      const route = authenticatedRoute(
        new URL(request.url, "http://127.0.0.1").pathname,
        CALLER_KEY,
      );
      if (route !== "/v1/responses") {
        response.writeHead(401).end();
        return;
      }
      await internalHandler(request, response);
    } catch (error) {
      response.writeHead(500).end(String(error));
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  server.on("upgrade", (request, socket, head) => {
    upgradeRequests.push(request);
    handleResponsesWebSocketUpgrade(request, socket, head, {
      callerKey: CALLER_KEY,
      responsesUrl: `http://127.0.0.1:${port}/_codex-router/${CALLER_KEY}/v1/responses`,
    });
  });
  return { server, port, upgradeRequests };
}

function sseResponse(response, events, { headers = {} } = {}) {
  response.writeHead(200, { "content-type": "text/event-stream", ...headers });
  for (const event of events) {
    response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
  }
  response.end();
}

async function readBody(result) {
  let text = "";
  for await (const chunk of Readable.fromWeb(result.body)) text += chunk.toString("utf8");
  return text;
}

// Tests must not leak a live upstream into the next one: a still-open client
// socket keeps `server.close()` pending forever and stalls the whole file.
function shutdown(providerOrUpstream, ...clients) {
  for (const client of clients) client?.abort();
  const server = providerOrUpstream.server ?? providerOrUpstream;
  server.closeAllConnections?.();
  return new Promise((resolve) => server.close(resolve));
}

// A hand-rolled upstream for cases the edge cannot play: refused upgrades,
// silent preludes, mid-turn deaths, and control-frame behaviour.
async function startRawUpstream({ onUpgrade } = {}) {
  const server = http.createServer((request, response) => {
    response.writeHead(404).end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  const sockets = new Set();
  server.on("upgrade", (request, socket, head) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    if (onUpgrade) {
      onUpgrade(request, socket, head);
      return;
    }
    const accept = createHash("sha1")
      .update(`${request.headers["sec-websocket-key"]}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
      .digest("base64");
    socket.write(
      [
        "HTTP/1.1 101 Switching Protocols",
        "Upgrade: websocket",
        "Connection: Upgrade",
        `Sec-WebSocket-Accept: ${accept}`,
        "",
        "",
      ].join("\r\n"),
    );
  });
  return {
    server,
    port,
    close() {
      for (const socket of sockets) socket.destroy();
      return new Promise((resolve) => server.close(resolve));
    },
  };
}

function unmaskedFrame(opcode, payload) {
  const data = Buffer.from(payload || "", "utf8");
  return Buffer.concat([Buffer.from([0x80 | opcode, data.length]), data]);
}

// Minimal server-side frame reader: complete masked client frames only.
function frameReader(socket) {
  let buffer = Buffer.alloc(0);
  const frames = [];
  const waiters = [];
  const consume = () => {
    while (buffer.length >= 2) {
      const opcode = buffer[0] & 0x0f;
      const masked = Boolean(buffer[1] & 0x80);
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
      if (buffer.length < offset + (masked ? 4 : 0) + length) return;
      const mask = masked ? buffer.subarray(offset, offset + 4) : undefined;
      const encoded = buffer.subarray(offset + (masked ? 4 : 0), offset + (masked ? 4 : 0) + length);
      const payload = Buffer.allocUnsafe(length);
      for (let index = 0; index < length; index += 1) {
        payload[index] = encoded[index] ^ (mask ? mask[index & 3] : 0);
      }
      buffer = buffer.subarray(offset + (masked ? 4 : 0) + length);
      const frame = { opcode, masked, payload };
      const waiter = waiters.shift();
      if (waiter) waiter.resolve(frame);
      else frames.push(frame);
    }
  };
  socket.on("data", (chunk) => {
    buffer = buffer.length ? Buffer.concat([buffer, chunk]) : Buffer.from(chunk);
    consume();
  });
  return {
    next(timeoutMs = 2_000) {
      const frame = frames.shift();
      if (frame) return Promise.resolve(frame);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("no frame arrived")), timeoutMs);
        waiters.push({
          resolve: (value) => {
            clearTimeout(timer);
            resolve(value);
          },
        });
      });
    },
  };
}

test("connects with provider auth and the beta contract", async () => {
  const provider = await startFakeProvider((request, response) => {
    sseResponse(response, [
      { type: "response.created", response: { id: "resp_1", status: "in_progress" } },
      { type: "response.completed", response: { id: "resp_1", status: "completed" } },
    ]);
  });
  try {
    const client = await ResponsesWebSocketClient.connect(
      `ws://127.0.0.1:${provider.port}/_codex-router/${CALLER_KEY}/v1/responses`,
      { headers: { Authorization: "Bearer provider-key" } },
    );
    const result = await collectResponsesRequest(client, {
      model: "gpt-test",
      input: [{ type: "message", role: "user", content: "hi" }],
      stream: true,
    });
    assert.equal(result.status, 200);
    await readBody(result);
    await waitFor(() => provider.upgradeRequests.length === 1);
    const upgrade = provider.upgradeRequests[0];
    assert.equal(upgrade.headers.authorization, "Bearer provider-key");
    assert.equal(upgrade.headers["openai-beta"], RESPONSES_WEBSOCKET_BETA);
    assert.equal(upgrade.headers.origin, undefined);
    assert.equal(upgrade.headers["sec-fetch-site"], undefined);
    client.close(1000, "done");
  } finally {
    await shutdown(provider);
  }
});

test("relays a streamed turn as SSE bytes and folds prelude headers", async () => {
  const provider = await startFakeProvider((request, response) => {
    sseResponse(
      response,
      [
        { type: "response.created", response: { id: "resp_2", status: "in_progress" } },
        { type: "response.output_text.delta", delta: "hello " },
        { type: "response.output_text.delta", delta: "world" },
        {
          type: "response.completed",
          response: { id: "resp_2", status: "completed", usage: { total: 12 } },
        },
      ],
      {
        headers: {
          "x-codex-turn-state": "sticky-turn",
          "x-codex-primary-used-percent": "42",
          "x-codex-primary-reset-at": "1791000000",
          "openai-model": "gpt-test-server",
        },
      },
    );
  });
  try {
    const client = await ResponsesWebSocketClient.connect(
      `ws://127.0.0.1:${provider.port}/_codex-router/${CALLER_KEY}/v1/responses`,
      { headers: { Authorization: "Bearer provider-key" } },
    );
    const result = await collectResponsesRequest(client, {
      model: "gpt-test",
      input: [],
      stream: true,
    });
    assert.equal(result.status, 200);
    assert.equal(result.headers.get("content-type"), "text/event-stream");
    assert.equal(result.headers.get("x-codex-turn-state"), "sticky-turn");
    assert.equal(result.headers.get("openai-model"), "gpt-test-server");
    assert.equal(result.headers.get("x-codex-primary-used-percent"), "42");
    assert.equal(result.headers.get("x-codex-primary-reset-at"), "1791000000");
    const text = await readBody(result);
    assert.match(text, /event: response\.created\ndata: \{"type":"response\.created"/);
    assert.match(text, /event: response\.output_text\.delta\ndata: \{"type":"response\.output_text\.delta","delta":"hello "\}/);
    assert.match(text, /event: response\.completed\ndata: .*\{"total":12\}.*\}/);
    client.close(1000, "done");
  } finally {
    await shutdown(provider);
  }
});

test("maps error frames to a non-ok response with rate-limit headers", async () => {
  const provider = await startFakeProvider((request, response) => {
    response.writeHead(429, { "content-type": "application/json", "retry-after": "7" });
    response.end(
      JSON.stringify({
        error: { type: "usage_limit", code: "usage_limit_reached", message: "limit" },
      }),
    );
  });
  try {
    const client = await ResponsesWebSocketClient.connect(
      `ws://127.0.0.1:${provider.port}/_codex-router/${CALLER_KEY}/v1/responses`,
      { headers: { Authorization: "Bearer provider-key" } },
    );
    const result = await collectResponsesRequest(client, {
      model: "gpt-test",
      input: [],
      stream: true,
    });
    assert.equal(result.status, 429);
    assert.equal(result.headers.get("retry-after"), "7");
    const body = JSON.parse(await readBody(result));
    assert.equal(body.error.code, "usage_limit_reached");
  } finally {
    await shutdown(provider);
  }
});

test("falls back to HTTP when the upgrade is refused with 426 and a beta hint", async () => {
  const upstream = await startRawUpstream({
    onUpgrade: (request, socket) => {
      socket.end(
        [
          "HTTP/1.1 426 Upgrade Required",
          "Connection: close",
          `OpenAI-Beta: ${RESPONSES_WEBSOCKET_BETA}`,
          "Content-Length: 0",
          "",
          "",
        ].join("\r\n"),
      );
    },
  });
  try {
    await assert.rejects(
      ResponsesWebSocketClient.connect(`ws://127.0.0.1:${upstream.port}/v1/responses`, {
        headers: { Authorization: "Bearer provider-key" },
      }),
      (error) => {
        assert.ok(error instanceof WsUpgradeRefusedError);
        assert.equal(error.status, 426);
        assert.equal(error.headers["openai-beta"], RESPONSES_WEBSOCKET_BETA);
        assert.equal(error.fallbackToHttp, true);
        return true;
      },
    );
  } finally {
    await upstream.close();
  }
});

test("errors the body when the upstream dies mid-turn without a terminal event", async () => {
  const upstream = await startRawUpstream();
  let upstreamSocket;
  const originalOnUpgrade = upstream.server.listeners("upgrade")[0];
  upstream.server.removeAllListeners("upgrade");
  upstream.server.on("upgrade", (request, socket, head) => {
    upstreamSocket = socket;
    originalOnUpgrade(request, socket, head);
    socket.write(
      unmaskedFrame(
        0x1,
        JSON.stringify({ type: "response.created", response: { id: "resp_3", status: "in_progress" } }),
      ),
    );
  });
  try {
    const client = await ResponsesWebSocketClient.connect(
      `ws://127.0.0.1:${upstream.port}/v1/responses`,
      { headers: { Authorization: "Bearer provider-key" } },
    );
    const result = await collectResponsesRequest(client, { model: "gpt-test", input: [], stream: true });
    assert.equal(result.status, 200);
    // The turn is now in flight with no terminal event coming; kill the
    // provider side and the body must surface an error, not a clean end.
    await waitFor(() => upstreamSocket);
    upstreamSocket.destroy();
    await assert.rejects(readBody(result), /mid-turn|ERR_WS_CLOSED_MID_TURN|terminated/i);
  } finally {
    await shutdown(upstream);
    upstreamSocket?.destroy();
  }
});

test("sends masked frames, client pings when idle, and answers server pings", async () => {
  const upstream = await startRawUpstream();
  const upgradeSockets = [];
  const originalOnUpgrade = upstream.server.listeners("upgrade")[0];
  upstream.server.removeAllListeners("upgrade");
  upstream.server.on("upgrade", (request, socket, head) => {
    originalOnUpgrade(request, socket, head);
    upgradeSockets.push(socket);
  });
  try {
    const client = await ResponsesWebSocketClient.connect(
      `ws://127.0.0.1:${upstream.port}/v1/responses`,
      { headers: { Authorization: "Bearer provider-key" }, pingIntervalMs: 20 },
    );
    await client.sendJson({ type: "response.create", input: [], stream: true });
    await waitFor(() => upgradeSockets.length === 1);
    const reader = frameReader(upgradeSockets[0]);
    const message = await reader.next();
    assert.equal(message.opcode, 0x1);
    assert.equal(message.masked, true);
    assert.equal(JSON.parse(message.payload.toString("utf8")).type, "response.create");
    // The idle timer may fire several pings before we look; the contract is
    // that they are masked opcode-9 frames, not their exact cadence.
    let ping;
    do {
      ping = await reader.next();
    } while (ping.opcode !== 0x9);
    assert.equal(ping.masked, true);
    // A server-initiated ping must be answered with a masked pong.
    upgradeSockets[0].write(unmaskedFrame(0x9, "srv-ping"));
    let pong;
    do {
      pong = await reader.next();
    } while (pong.opcode !== 0xa);
    assert.equal(pong.masked, true);
    assert.equal(pong.payload.toString("utf8"), "srv-ping");
    client.close(1000, "done");
  } finally {
    await upstream.close();
  }
});

test("times out a silent prelude without resending", async () => {
  const upstream = await startRawUpstream({
    onUpgrade: (request, socket) => {
      const accept = createHash("sha1")
        .update(`${request.headers["sec-websocket-key"]}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
        .digest("base64");
      socket.write(
        `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
      );
      // Then silence forever.
    },
  });
  try {
    const client = await ResponsesWebSocketClient.connect(
      `ws://127.0.0.1:${upstream.port}/v1/responses`,
      { headers: { Authorization: "Bearer provider-key" } },
    );
    await assert.rejects(
      collectResponsesRequest(client, { model: "gpt-test", input: [], stream: true }, { preludeTimeoutMs: 150 }),
      (error) => {
        assert.match(error.code, /ERR_WS_PRELUDE_TIMEOUT/);
        return true;
      },
    );
  } finally {
    await upstream.close();
  }
});

test("aborts an in-flight turn when the caller signal fires", async () => {
  const upstream = await startRawUpstream({
    onUpgrade: (request, socket) => {
      const accept = createHash("sha1")
        .update(`${request.headers["sec-websocket-key"]}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
        .digest("base64");
      socket.write(
        `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
      );
    },
  });
  try {
    const controller = new AbortController();
    const client = await ResponsesWebSocketClient.connect(
      `ws://127.0.0.1:${upstream.port}/v1/responses`,
      { headers: { Authorization: "Bearer provider-key" }, signal: controller.signal },
    );
    setTimeout(() => controller.abort(), 30);
    await assert.rejects(
      collectResponsesRequest(client, { model: "gpt-test", input: [], stream: true }, { signal: controller.signal }),
      (error) => {
        assert.match(error.code, /ERR_WS_ABORTED|ERR_WS_CLOSED_MID_TURN/);
        return true;
      },
    );
  } finally {
    await upstream.close();
  }
});

test("rateLimitHeadersFromEvents reconstructs the family header set", () => {
  const headers = rateLimitHeadersFromEvents([
    {
      type: "codex.rate_limits",
      metered_limit_name: "codex_bengalfox",
      limit_name: "gpt-test-sonic",
      rate_limits: {
        primary: { used_percent: 80, window_minutes: 1440, reset_at: 1700000100 },
        secondary: { used_percent: 10 },
      },
      credits: { has_credits: true, unlimited: false, balance: "12.50" },
    },
    { type: "codex.rate_limits", metered_limit_name: "codex" },
  ]);
  assert.deepEqual(headers, {
    "x-codex-bengalfox-primary-used-percent": "80",
    "x-codex-bengalfox-primary-window-minutes": "1440",
    "x-codex-bengalfox-primary-reset-at": "1700000100",
    "x-codex-bengalfox-secondary-used-percent": "10",
    "x-codex-bengalfox-limit-name": "gpt-test-sonic",
    "x-codex-credits-has-credits": "true",
    "x-codex-credits-unlimited": "false",
    "x-codex-credits-balance": "12.50",
  });
});

test("transport gates: breaker, native default, proxy self-disable, url derivation", () => {
  assert.equal(wsTransportAvailable("provider-a"), true);
  markWsTransportFailure("provider-a", 60_000);
  assert.equal(wsTransportAvailable("provider-a"), false);
  assert.equal(wsTransportAvailable("provider-b"), true);

  assert.equal(nativeWebSocketTransportEnabled({}), false);
  assert.equal(
    nativeWebSocketTransportEnabled({ CODEX_ROUTER_NATIVE_TRANSPORT: "websocket" }),
    true,
  );
  assert.equal(
    nativeWebSocketTransportEnabled({
      CODEX_ROUTER_NATIVE_TRANSPORT: "http",
      MODEL_ROUTER_NATIVE_TRANSPORT: "websocket",
    }),
    true,
  );

  assert.equal(responsesWebSocketTransportUsable({}), true);
  // Node's proxy support is opt-in; a bare HTTPS_PROXY does not reroute the
  // HTTP fetches either, so the WebSocket transport stays on. Only a proxy
  // that is actually in effect disables it.
  assert.equal(
    responsesWebSocketTransportUsable({ HTTPS_PROXY: "http://proxy:1" }),
    true,
  );
  assert.equal(
    responsesWebSocketTransportUsable({
      NODE_USE_ENV_PROXY: "1",
      HTTPS_PROXY: "http://proxy:1",
    }),
    false,
  );

  assert.equal(
    responsesWebSocketUrl("https://codex.example.com/v1/responses?x=1").href,
    "wss://codex.example.com/v1/responses?x=1",
  );
  assert.equal(
    responsesWebSocketUrl("http://127.0.0.1:4203/v1/responses").href,
    "ws://127.0.0.1:4203/v1/responses",
  );
});
