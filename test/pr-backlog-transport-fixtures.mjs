import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { zstdDecompressSync } from "node:zlib";
import { ResponsesWebSocketClient, collectResponsesRequest } from "../src/responses-ws-client.mjs";
import { ProviderWebSocketPool, providerPoolRegistry } from "../src/provider-ws-pool.mjs";
import { userModelEntry } from "../src/user-models.mjs";
import { openPort } from "./port-pool.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const CALLER = "transport-e2e-caller-capability-0123456789abcdef";
const INTERNAL = "transport-e2e-internal-key-0123456789abcdef";
const BETA = "responses_websockets=2026-02-06";
const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(predicate, message = "condition timed out", ms = 5_000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await delay(10);
  }
  assert.fail(message);
}

// Independent RFC 6455 wire oracle: neither the production codec nor its
// server edge participates in mock provider handshakes, masking or framing.
function wireFrame(value, { masked = false, opcode = 1 } = {}) {
  const data = Buffer.isBuffer(value) ? value : Buffer.from(JSON.stringify(value));
  const size = data.length < 126 ? 2 : data.length <= 65535 ? 4 : 10;
  const header = Buffer.alloc(size);
  header[0] = 0x80 | opcode;
  header[1] = (masked ? 0x80 : 0) | (size === 2 ? data.length : size === 4 ? 126 : 127);
  if (size === 4) header.writeUInt16BE(data.length, 2);
  if (size === 10) header.writeBigUInt64BE(BigInt(data.length), 2);
  if (!masked) return Buffer.concat([header, data]);
  const mask = Buffer.from([17, 29, 41, 53]);
  return Buffer.concat([header, mask, Buffer.from(data.map((byte, i) => byte ^ mask[i % 4]))]);
}
function receiveFrames(socket, expectMasked, callback, onError, initial = Buffer.alloc(0)) {
  let bytes = Buffer.alloc(0);
  const consume = (chunk) => {
    try {
      bytes = Buffer.concat([bytes, chunk]);
      while (bytes.length >= 2) {
        assert.equal(Boolean(bytes[1] & 0x80), expectMasked, "incorrect RFC masking direction");
        assert.equal(bytes[0] & 0x80, 0x80, "fixture accepts complete messages only");
        const opcode = bytes[0] & 15;
        let length = bytes[1] & 127;
        let offset = 2;
        if (length === 126) { if (bytes.length < 4) return; length = bytes.readUInt16BE(2); offset = 4; }
        if (length === 127) { if (bytes.length < 10) return; length = Number(bytes.readBigUInt64BE(2)); offset = 10; }
        const prefix = offset + (expectMasked ? 4 : 0);
        if (bytes.length < prefix + length) return;
        const data = Buffer.from(bytes.subarray(prefix, prefix + length));
        if (expectMasked) for (let i = 0; i < data.length; i++) data[i] ^= bytes[offset + i % 4];
        bytes = bytes.subarray(prefix + length);
        callback(opcode, data);
      }
    } catch (error) { onError(error); socket.destroy(); }
  };
  socket.on("data", consume);
  if (initial.length) consume(initial);
}
function events(id = "resp_test", text = "transport-ok") {
  const item = { id: `msg_${id}`, type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text, annotations: [] }] };
  return [
    { type: "response.created", response: { id, object: "response", status: "in_progress", output: [] } },
    { type: "response.output_item.added", output_index: 0, item: { ...item, status: "in_progress", content: [] } },
    { type: "response.content_part.added", item_id: item.id, output_index: 0, content_index: 0, part: { type: "output_text", text: "", annotations: [] } },
    { type: "response.output_text.delta", item_id: item.id, output_index: 0, content_index: 0, delta: text },
    { type: "response.output_text.done", item_id: item.id, output_index: 0, content_index: 0, text },
    { type: "response.output_item.done", output_index: 0, item },
    { type: "response.completed", response: { id, object: "response", status: "completed", output: [item], usage: { input_tokens: 3, output_tokens: 2, total_tokens: 5 } } },
  ];
}
function sendEvents(socket, values) { socket.write(Buffer.concat(values.map((value) => wireFrame(value)))); }
function sse(response, values) {
  response.writeHead(200, { "content-type": "text/event-stream" });
  response.end(values.map((value) => `event: ${value.type}\ndata: ${JSON.stringify(value)}\n\n`).join(""));
}
async function rawProvider(t, { upgrade, turn, httpTurn } = {}) {
  const sockets = new Set();
  const upgrades = [], turns = [], httpTurns = [], errors = [];
  const server = http.createServer(async (request, response) => {
    try {
      if (request.method !== "POST") { response.writeHead(200).end('{"data":[]}'); return; }
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const raw = Buffer.concat(chunks);
      const decoded = request.headers["content-encoding"] === "zstd" ? zstdDecompressSync(raw) : raw;
      const entry = { body: JSON.parse(decoded), raw, headers: request.headers, url: request.url };
      httpTurns.push(entry);
      if (httpTurn) await httpTurn(entry, response);
      else sse(response, events(`resp_http_${httpTurns.length}`));
    } catch (error) { errors.push(error); response.destroy(); }
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => {});
    socket.on("end", () => socket.end());
  });
  server.on("upgrade", (request, socket, head) => {
    const entry = { headers: request.headers, url: request.url, socket, id: upgrades.length + 1 };
    upgrades.push(entry);
    const accept = createHash("sha1").update(request.headers["sec-websocket-key"] + GUID).digest("base64");
    const handshake = (extra = [], coalesced = Buffer.alloc(0)) => socket.write(Buffer.concat([
      Buffer.from(["HTTP/1.1 101 Switching Protocols", "Upgrade: websocket", "Connection: Upgrade", `Sec-WebSocket-Accept: ${accept}`, ...extra, "", ""].join("\r\n")), coalesced,
    ]));
    try {
      if (upgrade?.(entry, handshake, accept) === false) return;
      handshake();
      receiveFrames(socket, true, (opcode, data) => {
        if (opcode === 8) { socket.end(wireFrame(data, { opcode: 8 })); return; }
        if (opcode === 9) { socket.write(wireFrame(data, { opcode: 10 })); return; }
        assert.equal(opcode, 1);
        const body = JSON.parse(data);
        assert.equal(body.type, "response.create");
        const requestTurn = { ...entry, body };
        turns.push(requestTurn);
        if (turn) turn(requestTurn, turns.length);
        else sendEvents(socket, events(`resp_ws_${turns.length}`));
      }, (error) => errors.push(error), head);
    } catch (error) { errors.push(error); socket.destroy(); }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
    assert.deepEqual(errors, [], "independent mock provider rejected production wire behavior");
  });
  const port = server.address().port;
  return { port, url: `ws://127.0.0.1:${port}/v1/responses`, upgrades, turns, httpTurns, sockets };
}
const requestBody = (text = "hello") => ({ model: "raw-model", stream: true, input: [{ role: "user", content: text }] });
async function connect(t, provider, options = {}) {
  const client = await ResponsesWebSocketClient.connect(provider.url, { pingIntervalMs: 0, ...options });
  t.after(() => client.abort());
  return client;
}
async function consume(result) { return new Response(result.body).text(); }
async function stop(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, "exit");
  child.kill("SIGTERM");
  const timer = setTimeout(() => child.kill("SIGKILL"), 3_000);
  try { await exited; } finally { clearTimeout(timer); }
}
function startProcess(t, script, env) {
  // Children inherit no operator credentials, proxy, state paths or routing knobs.
  const child = spawn(process.execPath, [path.join(root, "src", script)], {
    cwd: root, stdio: ["ignore", "ignore", "pipe"],
    env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, ...env },
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  child.diagnostics = () => stderr;
  t.after(() => stop(child));
  return child;
}
async function ready(child, url, key) {
  await until(async () => {
    assert.equal(child.exitCode, null, child.diagnostics());
    try {
      const response = await fetch(url, { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(500) });
      await response.arrayBuffer();
      return response.ok;
    } catch { return false; }
  }, `process did not listen: ${child.diagnostics()}`, 15_000);
}
async function stack(t, provider, { native = false, credential = false, transport = "websocket", env = {} } = {}) {
  const directory = mkdtempSync(path.join(os.tmpdir(), "router-transport-e2e-"));
  const state = path.join(directory, "state");
  mkdirSync(state);
  const children = [];
  t.after(async () => { await Promise.all(children.map(stop)); rmSync(directory, { recursive: true, force: true }); });
  const model = userModelEntry({ providerId: "e2e-ws", upstreamId: "provider-model", priority: 1 });
  const providerFile = path.join(directory, "generic-providers.json");
  const modelsFile = path.join(directory, "user-models.json");
  const descriptor = { id: "e2e-ws", displayName: "E2E WS", baseUrl: `http://127.0.0.1:${provider.port}/v1`, adapter: "openai-responses", transport, headers: { "X-Tenant": "tenant-a" }, allowPrivate: true, enabled: true };
  const credentialFile = path.join(state, "generic-provider-credentials", "e2e-ws.key");
  const writeCredential = (value) => writeFileSync(credentialFile, value, { mode: 0o600 });
  if (credential) {
    descriptor.credentialRef = "cred_transport_e2e_0123456789";
    mkdirSync(path.dirname(credentialFile), { mode: 0o700 });
    writeCredential("fixture-provider-a");
    const timestamp = "2026-01-01T00:00:00.000Z";
    writeFileSync(path.join(state, "provider-credentials.json"), JSON.stringify({ schemaVersion: 2, credentials: [{
      id: descriptor.credentialRef, providerId: "e2e-ws", providerType: "generic", kind: "api_key", state: "active",
      secretRef: { type: "provider-file", providerId: "e2e-ws", target: "codex" }, createdAt: timestamp, updatedAt: timestamp,
    }] }), { mode: 0o600 });
  }
  const writeProvider = () => writeFileSync(providerFile, JSON.stringify({ version: 1, providers: [descriptor] }));
  writeProvider();
  writeFileSync(modelsFile, JSON.stringify({ version: 1, models: [model] }));
  const routerPort = await openPort(), apiPort = await openPort();
  const baseEnv = {
    HOME: directory, CODEX_HOME: path.join(directory, "codex"), MODEL_ROUTER_TARGET: "codex",
    MODEL_ROUTER_STATE_DIR: state, MODEL_ROUTER_GENERIC_PROVIDERS: providerFile, MODEL_ROUTER_USER_MODELS: modelsFile,
    CODEX_ROUTER_CALLER_KEY: CALLER, MODEL_ROUTER_INTERNAL_KEY: INTERNAL, CODEX_ROUTER_INTERNAL_KEY: INTERNAL,
    MODEL_ROUTER_API_PORT: String(apiPort), CODEX_ROUTER_PORT: String(routerPort),
    CODEX_ROUTER_API_BASE_URL: `http://127.0.0.1:${apiPort}/v1`, CODEX_ROUTER_API_HEALTH_URL: `http://127.0.0.1:${apiPort}/health`,
    CODEX_ROUTER_GATEWAY_BASE_URL: `http://127.0.0.1:${provider.port}/gateway`,
    CODEX_ROUTER_GATEWAY_HEALTH_URL: `http://127.0.0.1:${provider.port}/health`,
    CODEX_NATIVE_BASE_URL: `http://127.0.0.1:${provider.port}/backend-api/codex`,
    CODEX_ROUTER_SHOW_ALL_MODELS: "1", MODEL_ROUTER_QUIET: "1", CODEX_ROUTER_QUIET: "1",
    CODEX_ROUTER_NO_DISCOVERY: native || credential ? "0" : "1", MODEL_ROUTER_WS_PRELUDE_TIMEOUT_MS: "180",
    ...env,
  };
  const forwarder = startProcess(t, "api-forwarder.mjs", baseEnv);
  children.push(forwarder);
  await ready(forwarder, `http://127.0.0.1:${apiPort}/health`, INTERNAL);
  const router = startProcess(t, "router.mjs", baseEnv);
  children.push(router);
  const base = `http://127.0.0.1:${routerPort}/_codex-router/${CALLER}/v1`;
  await ready(router, `${base}/models`, CALLER);
  const post = (body = {}, headers = {}) => fetch(`${base}/responses`, {
    method: "POST", headers: { Authorization: `Bearer ${native ? "fixture-native-bearer" : CALLER}`, "Content-Type": "application/json", ...headers },
    body: JSON.stringify({ ...requestBody(), model: native ? "gpt-5.6-sol" : model.slug, ...body }), signal: AbortSignal.timeout(10_000),
  });
  return { post, model, descriptor, writeProvider, writeCredential, base, routerPort, apiPort, state, router, forwarder };
}
async function publicPeer(t, port) {
  const socket = net.connect({ host: "127.0.0.1", port });
  t.after(() => socket.destroy());
  await once(socket, "connect");
  // The key must contain 16 bytes, independent of the production generator.
  const wsKey = Buffer.from("0123456789abcdef").toString("base64");
  const initial = await new Promise((resolve, reject) => {
    let data = Buffer.alloc(0);
    const onData = (chunk) => {
      data = Buffer.concat([data, chunk]);
      const end = data.indexOf("\r\n\r\n");
      if (end < 0) return;
      socket.off("data", onData);
      try { assert.match(data.subarray(0, end).toString(), /^HTTP\/1\.1 101/); resolve(data.subarray(end + 4)); }
      catch (error) { reject(error); }
    };
    socket.on("data", onData);
    socket.once("error", reject);
    socket.write([`GET /_codex-router/${CALLER}/v1/responses HTTP/1.1`, `Host: 127.0.0.1:${port}`, "Connection: Upgrade", "Upgrade: websocket", `Sec-WebSocket-Key: ${wsKey}`, "Sec-WebSocket-Version: 13", `OpenAI-Beta: ${BETA}`, "", ""].join("\r\n"));
  });
  const values = [], errors = [];
  receiveFrames(socket, false, (opcode, data) => { if (opcode === 1) values.push(JSON.parse(data)); }, (error) => errors.push(error), initial);
  return {
    async turn(body) {
      values.length = 0;
      socket.write(wireFrame({ ...body, type: "response.create" }, { masked: true }));
      await until(() => values.some((value) => ["response.completed", "response.failed", "error"].includes(value.type)), "public WS turn did not terminate");
      assert.deepEqual(errors, []);
      return [...values];
    },
  };
}

export async function runTransportScenarios(t) {
  await t.test("RFC handshake rejects invalid controls, aborts safely and bounds headers independently of coalesced frames", async (t) => {
    const provider = await rawProvider(t, { upgrade: (entry, handshake, accept) => {
      const mode = new URL(entry.url, "http://local").searchParams.get("mode");
      if (mode === "valid-large-frame") { handshake([], wireFrame({ type: "response.metadata", padding: "x".repeat(20_000) })); return false; }
      if (mode === "fin") { entry.socket.end(); return false; }
      if (mode === "stall") return false;
      const lines = ["HTTP/1.1 101 Switching Protocols", "Upgrade: websocket", `Connection: ${mode === "connection" ? "close" : "Upgrade"}`, `Sec-WebSocket-Accept: ${mode === "accept" ? "wrong" : accept}`];
      if (mode === "extension") lines.push("Sec-WebSocket-Extensions: permessage-deflate");
      if (mode === "protocol") lines.push("Sec-WebSocket-Protocol: surprise");
      if (mode === "header") lines.push("Bad Header: rejected");
      if (mode === "overrun") lines.push(`X-Pad: ${"x".repeat(17_000)}`);
      if (mode) { entry.socket.write([...lines, "", ""].join("\r\n")); return false; }
    } });
    for (const mode of ["accept", "connection", "extension", "protocol", "header", "overrun", "fin", "stall"]) {
      const code = mode === "stall" ? "ERR_WS_HANDSHAKE_TIMEOUT" : mode === "fin" ? "ERR_WS_CONNECT" : mode === "overrun" ? "ERR_WS_HANDSHAKE_OVERRUN" : mode === "header" ? "ERR_INVALID_HTTP_TOKEN" : "ERR_WS_HANDSHAKE";
      await assert.rejects(ResponsesWebSocketClient.connect(`${provider.url}?mode=${mode}`, { handshakeTimeoutMs: mode === "stall" ? 50 : 5_000, pingIntervalMs: 0 }), { code }, `${mode} was accepted or failed for an unrelated reason`);
    }
    const valid = await ResponsesWebSocketClient.connect(`${provider.url}?mode=valid-large-frame`, { pingIntervalMs: 0 });
    assert.equal(valid.closed, false, "frame bytes counted toward the 16KiB HTTP header limit");
    valid.abort();
    const count = provider.upgrades.length;
    await assert.rejects(ResponsesWebSocketClient.connect(provider.url, { signal: AbortSignal.abort() }), /aborted/);
    await assert.rejects(ResponsesWebSocketClient.connect(provider.url, { headers: { "X-Injected": "ok\r\nAuthorization: stolen" } }), /Invalid character/);
    assert.equal(provider.upgrades.length, count, "pre-abort or invalid header opened a connection");
    const signal = new AbortController();
    const pending = ResponsesWebSocketClient.connect(`${provider.url}?mode=stall`, { signal: signal.signal });
    const rejection = assert.rejects(pending, /aborted/);
    await until(() => provider.upgrades.length > count);
    signal.abort();
    await rejection;
    await until(() => provider.sockets.size === 0, "failed handshake sockets leaked");
  });

  await t.test("stream ownership releases once, removes old abort listeners and rejects late frames from a completed lease", async (t) => {
    let held;
    const provider = await rawProvider(t, { turn: (entry, index) => {
      if (index === 2) { held = entry; sendEvents(entry.socket, [events("resp_second")[0]]); return; }
      const values = events(`resp_${index}`);
      if (index === 3) values.push({ type: "response.output_text.delta", delta: "STALE_PREVIOUS_TURN" });
      sendEvents(entry.socket, values);
    } });
    const pool = new ProviderWebSocketPool({ maxConnections: 1, connect: (signal) => ResponsesWebSocketClient.connect(provider.url, { signal, pingIntervalMs: 0 }) });
    t.after(() => pool.closeAll());
    const old = new AbortController();
    let settled = 0;
    const first = await pool.acquire();
    assert.match(await consume(await collectResponsesRequest(first.connection, requestBody(), { signal: old.signal, onSettled: () => { settled++; first.release(); } })), /response.completed/);
    const second = await pool.acquire();
    assert.equal(second.connection, first.connection);
    const secondHead = await collectResponsesRequest(second.connection, requestBody(), { onSettled: () => { settled++; second.release(); } });
    old.abort();
    assert.equal(second.connection.closed, false, "completed request's abort poisoned the next lease");
    sendEvents(held.socket, events("resp_second").slice(1));
    assert.match(await consume(secondHead), /transport-ok/);
    assert.equal(settled, 2);
    const third = await pool.acquire();
    const thirdBody = await consume(await collectResponsesRequest(third.connection, requestBody(), { onSettled: () => third.release() }));
    assert.doesNotMatch(thirdBody, /STALE_PREVIOUS_TURN/);
    await until(() => third.connection.closed, "extra frame did not poison idle connection");
    const fourth = await pool.acquire();
    assert.notEqual(fourth.connection, third.connection);
    assert.doesNotMatch(await consume(await collectResponsesRequest(fourth.connection, requestBody(), { onSettled: () => fourth.release() })), /STALE_PREVIOUS_TURN/);
    assert.equal(provider.upgrades.length, 2);
    assert.equal(provider.turns.length, 4);
  });

  await t.test("post-prelude errors, metadata injection, cancellation, limits and slow consumers terminate or backpressure without leaking leases", async (t) => {
    for (const mode of ["error", "metadata", "overflow", "drop", "cancel", "abort", "silent", "slow"]) await t.test(mode, async (t) => {
      let socket;
      const provider = await rawProvider(t, { turn: (entry) => {
        socket = entry.socket;
        if (mode === "silent") return;
        if (mode === "metadata") { sendEvents(socket, [{ type: "response.metadata", headers: { "bad header": "injected" } }]); return; }
        sendEvents(socket, [events()[0]]);
        setImmediate(() => {
          if (mode === "error") sendEvents(socket, [{ type: "error", status: 502, error: { message: "fixture error" } }]);
          if (mode === "overflow") sendEvents(socket, [{ type: "response.output_text.delta", delta: "x".repeat(16_384) }]);
          if (mode === "drop") socket.destroy();
          if (mode === "slow") sendEvents(socket, [{ type: "response.output_text.delta", delta: "x".repeat(128 * 1024) }]);
        });
      } });
      const client = await connect(t, provider);
      const controller = new AbortController();
      let settled = 0;
      const options = { signal: controller.signal, preludeTimeoutMs: 60, maxEventBytes: mode === "overflow" ? 1_024 : 1024 * 1024, onSettled: () => settled++ };
      if (mode === "metadata" || mode === "silent") {
        await assert.rejects(collectResponsesRequest(client, requestBody(), options));
      } else {
        const response = await collectResponsesRequest(client, requestBody(), options);
        if (mode === "cancel") await response.body.cancel();
        else if (mode === "abort") { controller.abort(); await assert.rejects(consume(response), /aborted/); }
        else if (mode === "slow") {
          await until(() => client.socket.isPaused(), "slow reader did not pause upstream reads");
          assert.equal(settled, 0);
          const reader = response.body.getReader();
          await reader.read(); await reader.read();
          await until(() => !client.socket.isPaused(), "drained consumer did not resume upstream reads");
          sendEvents(socket, [events().at(-1)]);
          while (!(await reader.read()).done) {}
        } else await assert.rejects(consume(response));
      }
      assert.equal(settled, 1, "turn completion did not release exactly once");
      if (mode !== "slow") assert.equal(client.closed, true, "failed turn left reusable socket");
    });
  });

  await t.test("pool handles queued and opening cancellation, replacement, shutdown and bounded identity affinity", async (t) => {
    let stalled = true;
    const provider = await rawProvider(t, { upgrade: () => stalled ? false : undefined });
    const pool = new ProviderWebSocketPool({ maxConnections: 1, acquireTimeoutMs: 1000, idleEvictMs: 30, connect: (signal) => ResponsesWebSocketClient.connect(provider.url, { signal, pingIntervalMs: 0 }) });
    t.after(() => pool.closeAll());
    const openingAbort = new AbortController();
    const opening = pool.acquire(openingAbort.signal);
    const openingRejected = assert.rejects(opening);
    await until(() => provider.upgrades.length === 1);
    const replacement = pool.acquire();
    stalled = false;
    openingAbort.abort();
    await openingRejected;
    const lease = await replacement;
    assert.equal(provider.upgrades.length, 2, "failed opening did not refill waiting capacity");
    const queuedAbort = new AbortController();
    const queued = pool.acquire(queuedAbort.signal);
    const queuedRejected = assert.rejects(queued);
    queuedAbort.abort();
    await queuedRejected;
    assert.equal(pool.waiters.length, 0);
    const next = pool.acquire();
    lease.connection.abort(); lease.release();
    const nextLease = await next;
    assert.equal(provider.upgrades.length, 3, "unhealthy release did not open replacement");
    nextLease.release();
    await until(() => pool.idle.length === 0 && nextLease.connection.closed, "idle connection was not evicted");
    stalled = true;
    const duringClose = pool.acquire();
    const duringCloseRejected = assert.rejects(duringClose);
    await until(() => provider.upgrades.length === 4);
    const waitingClose = assert.rejects(pool.acquire());
    pool.closeAll();
    await Promise.all([duringCloseRejected, waitingClose]);
    await assert.rejects(pool.acquire(), /closed/);
    await until(() => pool.opening.size === 0 && pool.leased.size === 0 && pool.waiters.length === 0);
    stalled = false;
    let finishOpening;
    const opened = await connect(t, provider);
    const latePool = new ProviderWebSocketPool({ connect: () => new Promise((resolve) => { finishOpening = resolve; }) });
    t.after(() => latePool.closeAll());
    const lateAcquisition = assert.rejects(latePool.acquire());
    await until(() => finishOpening);
    latePool.closeAll();
    await lateAcquisition;
    finishOpening(opened);
    await until(() => opened.closed && latePool.opening.size === 0, "late successful connection escaped shutdown");
    let identity = "a";
    const registry = providerPoolRegistry({ resolveProvider: () => ({ wsTarget: () => ({ url: provider.url, headers: { "X-Tenant": identity } }) }) });
    t.after(() => registry.closeAll());
    const a = await registry.poolFor("one"), same = await registry.poolFor("one");
    assert.equal(a, same);
    identity = "b";
    assert.notEqual(await registry.poolFor("one"), a);
    const otherRegistry = providerPoolRegistry({ resolveProvider: () => ({ wsTarget: () => ({ url: provider.url, headers: {} }) }) });
    t.after(() => otherRegistry.closeAll());
    assert.notEqual(await otherRegistry.poolFor("one"), a, "separate registry resolvers shared global state");
    for (let i = 0; i < 62; i++) { identity = String(i); await registry.poolFor("one"); }
    identity = "overflow";
    await assert.rejects(registry.poolFor("one"), /capacity/);
  });

  await t.test("real router and forwarder preserve canonical HTTP and public WS turns, reuse connections and rotate static identity", async (t) => {
    const provider = await rawProvider(t);
    const app = await stack(t, provider);
    const body = {
      input: [{ role: "user", content: "canonical question" }],
      client_metadata: { local_only: "must-not-reach-provider" }, access_programs: ["private-program"],
      tools: [{ type: "namespace", name: "workspace", description: "", tools: [{ type: "function", name: "lookup", description: "lookup", parameters: { type: "object", properties: {} } }] }],
    };
    for (let i = 0; i < 2; i++) {
      const response = await app.post(body);
      assert.equal(response.status, 200, await response.clone().text());
      assert.match(await response.text(), /transport-ok/);
    }
    assert.equal(provider.upgrades.length, 1, "sequential canonical turns did not reuse upstream");
    const peer = await publicPeer(t, app.routerPort);
    const publicEvents = await peer.turn({ ...requestBody(), model: app.model.slug });
    assert.ok(publicEvents.some((event) => event.type === "response.completed"));
    assert.equal(provider.httpTurns.length, 0);
    assert.equal(provider.turns.length, 3);
    for (const turn of provider.turns) {
      assert.equal(turn.body.model, "provider-model", "route slug leaked upstream");
      assert.equal(turn.body.client_metadata, undefined, "router-only metadata leaked upstream");
      assert.equal(turn.body.access_programs, undefined);
      assert.notEqual(turn.headers.authorization, `Bearer ${CALLER}`);
      assert.notEqual(turn.headers.authorization, `Bearer ${INTERNAL}`);
    }
    assert.equal(provider.turns[0].body.tools[0].type, "namespace", "native Responses declaration was flattened");
    assert.equal(provider.turns[0].body.tools[0].description, "Tools in the workspace namespace.", "canonical namespace description repair bypassed");
    assert.equal(provider.turns[0].body.tools[0].tools[0].name, "lookup");
    app.descriptor.headers["X-Tenant"] = "tenant-b"; app.writeProvider();
    const rotated = await app.post();
    assert.equal(rotated.status, 200);
    await rotated.text();
    await until(() => provider.turns.length === 4);
    assert.equal(provider.upgrades.length, 2, "edited identity reused stale handshake");
    assert.equal(provider.turns.at(-1).headers["x-tenant"], "tenant-b");
    const before = provider.turns.length;
    app.descriptor.enabled = false; app.writeProvider();
    const disabled = await app.post();
    assert.ok(disabled.status >= 400);
    await disabled.text();
    assert.equal(provider.turns.length, before, "disabled provider reused existing pool");
    await until(() => {
      try { return readFileSync(path.join(app.state, "usage-events.jsonl"), "utf8").includes(app.model.slug); } catch { return false; }
    }, "canonical usage accounting did not record routed turn");
    assert.equal(app.router.exitCode, null, app.router.diagnostics());
    assert.equal(app.forwarder.exitCode, null, app.forwarder.diagnostics());
  });

  await t.test("real process fallback is pre-send only; post-send failures never duplicate generations", async (t) => {
    for (const mode of ["refused", "drop", "silent", "metadata", "late-error", "prelude-limit"]) await t.test(mode, async (t) => {
      const provider = await rawProvider(t, {
        upgrade: (entry) => {
          if (mode === "refused") { entry.socket.end("HTTP/1.1 426 Upgrade Required\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"); return false; }
        },
        turn: (entry) => {
          if (mode === "drop") entry.socket.destroy();
          if (mode === "metadata") sendEvents(entry.socket, [{ type: "response.metadata", headers: { "Invalid Header": "bad" } }]);
          if (mode === "prelude-limit") sendEvents(entry.socket, [events()[0]]);
          if (mode === "late-error") {
            sendEvents(entry.socket, [events()[0]]);
            setTimeout(() => sendEvents(entry.socket, [{ type: "error", status: 502, error: { message: "upstream failed" } }]), 20);
          }
        },
      });
      const app = await stack(t, provider, { env: mode === "prelude-limit" ? { CODEX_ROUTER_EMPTY_COMPLETION_PRELUDE_MS: "60" } : {} });
      const response = await app.post();
      const text = await response.text();
      if (mode === "refused") {
        assert.equal(response.status, 200, text);
        assert.match(text, /transport-ok/);
        assert.equal(provider.httpTurns.length, 1);
        assert.equal(provider.turns.length, 0);
        const again = await app.post(); await again.text();
        assert.equal(provider.upgrades.length, 1, "breaker retried refused upgrade");
        assert.equal(provider.httpTurns.length, 2);
      } else {
        assert.ok(response.status >= 400 || /error|failed/.test(text), "post-send failure looked successful");
        assert.equal(provider.turns.length, 1, "post-send failure replayed generation");
        assert.equal(provider.httpTurns.length, 0, "post-send failure fell back to HTTP");
        assert.equal(app.router.exitCode, null, app.router.diagnostics());
        assert.equal(app.forwarder.exitCode, null, app.forwarder.diagnostics());
      }
    });
  });

  await t.test("generic credential rotation changes handshake affinity and request query remains confined", async (t) => {
    const provider = await rawProvider(t);
    const app = await stack(t, provider, { credential: true });
    let response = await app.post();
    assert.equal(response.status, 200, await response.clone().text());
    await response.text();
    app.writeCredential("fixture-provider-b");
    response = await app.post();
    assert.equal(response.status, 200, await response.clone().text());
    await response.text();
    assert.equal(provider.upgrades.length, 2, "rotated credential reused old authenticated socket");
    assert.equal(provider.turns[0].headers.authorization, "Bearer fixture-provider-a");
    assert.equal(provider.turns[1].headers.authorization, "Bearer fixture-provider-b");
    response = await fetch(`http://127.0.0.1:${app.apiPort}/v1/responses?tenant_query=e2e`, {
      method: "POST", headers: { Authorization: `Bearer ${INTERNAL}`, "Content-Type": "application/json" },
      body: JSON.stringify({ ...requestBody(), model: app.model.gatewayModel }), signal: AbortSignal.timeout(5_000),
    });
    assert.equal(response.status, 200, await response.clone().text());
    await response.text();
    assert.equal(provider.turns.at(-1).url, "/v1/responses?tenant_query=e2e");
    assert.equal(provider.turns.at(-1).headers.authorization, "Bearer fixture-provider-b");
  });

  await t.test("native remains opt-in, fallback preserves zstd and WS affinity preserves forwarded identity", async (t) => {
    for (const mode of ["default", "fallback", "websocket"]) await t.test(mode, async (t) => {
      const provider = await rawProvider(t, { upgrade: (entry) => {
        if (mode === "fallback") { entry.socket.end("HTTP/1.1 426 Upgrade Required\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"); return false; }
      } });
      const app = await stack(t, provider, { native: true, env: mode === "default" ? {} : { MODEL_ROUTER_NATIVE_TRANSPORT: "websocket" } });
      const text = "native compressed turn ".repeat(2000);
      const headers = { "session_id": "session-a", "thread-id": "thread-a", "originator": "e2e-native", "x-codex-turn-state": "state-a" };
      for (let i = 0; i < 2; i++) {
        const response = await app.post({ input: [{ role: "user", content: text }] }, headers);
        assert.equal(response.status, 200, await response.clone().text());
        assert.match(await response.text(), /transport-ok/);
      }
      if (mode === "websocket") {
        assert.equal(provider.upgrades.length, 1);
        assert.equal(provider.httpTurns.length, 0);
        for (const entry of provider.turns) {
          assert.equal(entry.headers.authorization, "Bearer fixture-native-bearer");
          for (const [key, value] of Object.entries(headers)) assert.equal(entry.headers[key], value);
        }
        const changed = await app.post({}, { ...headers, "x-codex-turn-state": "state-b" }); await changed.text();
        assert.equal(provider.upgrades.length, 2, "turn identity reused stale handshake");
      } else {
        assert.equal(provider.upgrades.length, mode === "default" ? 0 : 1);
        assert.equal(provider.httpTurns.length, 2);
        for (const entry of provider.httpTurns) {
          assert.equal(entry.headers["content-encoding"], "zstd");
          assert.equal(entry.body.input[0].content, text);
          assert.equal(entry.headers.authorization, "Bearer fixture-native-bearer");
          for (const [key, value] of Object.entries(headers)) assert.equal(entry.headers[key], value);
        }
      }
    });
  });
}
