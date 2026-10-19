import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Agent, ProxyAgent, fetch } from "undici";

import { fetchWithRetry, transportDeliveryState } from "../src/upstream-retry.mjs";
import { describeTransportFailure } from "../src/transport-failure.mjs";
import { callerBaseUrl } from "../src/caller-auth.mjs";
import { openPort } from "./port-pool.mjs";
import { loopbackTlsCredentials } from "./loopback-tls-fixture.mjs";

// Generate fresh credentials and trust only this loopback certificate.
const { cert, key } = loopbackTlsCredentials();
const body = JSON.stringify({ input: "Synthetic generation that must execute at most once" });

async function listen(t, server) {
  const sockets = new Set();
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    socket.on("error", () => {});
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
  });
  return server.address().port;
}

async function fixture(t, { failures = 0, responseMode = "complete", proxy = false } = {}) {
  const submissions = [];
  const failedHellos = [];
  let connections = 0;
  const origin = https.createServer({ key, cert }, async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    submissions.push(Buffer.concat(chunks).toString());
    if (responseMode === "reset-after-post") {
      request.socket.destroy();
    } else if (responseMode === "reset-after-output") {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write('data: {"type":"response.created"}\n\n');
      // Give fetch the headers, then close the actual TLS stream mid-body.
      setTimeout(() => request.socket.destroy(), 20).unref();
    } else if (responseMode === "responses") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ id: "resp_synthetic_tls_retry", object: "response", status: "completed", output: [] }));
    } else {
      response.end("Synthetic successful response");
    }
  });
  const originPort = await listen(t, origin);
  const outboundSockets = new Set();
  const bridge = net.createServer((socket) => {
    connections += 1;
    if (connections <= failures) {
      socket.once("data", (hello) => {
        failedHellos.push(Buffer.from(hello));
        socket.end();
      });
      return;
    }
    const upstream = net.connect({ host: "127.0.0.1", port: originPort });
    outboundSockets.add(upstream);
    upstream.once("close", () => outboundSockets.delete(upstream));
    upstream.on("error", () => socket.destroy());
    socket.once("close", () => upstream.destroy());
    socket.pipe(upstream).pipe(socket);
  });
  const bridgePort = await listen(t, bridge);
  let dispatcher;
  if (proxy) {
    const forwardProxy = http.createServer();
    forwardProxy.on("connect", (_request, socket, head) => {
      const upstream = net.connect({ host: "127.0.0.1", port: bridgePort });
      outboundSockets.add(upstream);
      upstream.once("close", () => outboundSockets.delete(upstream));
      upstream.on("error", () => socket.destroy());
      socket.once("close", () => upstream.destroy());
      upstream.once("connect", () => {
        socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        if (head.length) upstream.write(head);
        socket.pipe(upstream).pipe(socket);
      });
    });
    const proxyPort = await listen(t, forwardProxy);
    dispatcher = new ProxyAgent({ uri: `http://127.0.0.1:${proxyPort}`, requestTls: { ca: cert }, connectTimeout: 1_000 });
  } else {
    dispatcher = new Agent({ allowH2: false, connect: { ca: cert }, connectTimeout: 1_000 });
  }
  t.after(async () => {
    for (const socket of outboundSockets) socket.destroy();
    await dispatcher.destroy();
  });
  return {
    url: `https://127.0.0.1:${bridgePort}/responses`, submissions, failedHellos,
    connections: () => connections,
    fetchImpl: (url, init) => fetch(url, { ...init, dispatcher }),
  };
}

function options(origin, attempts, overrides = {}) {
  return {
    deliveryPolicy: "at-most-once", retries: 2, backoffMs: 0, budgetMs: 5_000,
    fetchImpl: origin.fetchImpl, onAttempt: (attempt) => attempts.push(attempt), ...overrides,
  };
}

test("real pre-TLS disconnects retry directly and through CONNECT without duplicate POSTs", { timeout: 10_000 }, async (t) => {
  for (const proxy of [false, true]) {
    await t.test(proxy ? "HTTP CONNECT proxy" : "direct TLS", async (subtest) => {
      const origin = await fixture(subtest, { failures: 2, proxy });
      const attempts = [];
      const result = await fetchWithRetry(origin.url, { method: "POST", body }, options(origin, attempts));
      assert.equal(await result.response.text(), "Synthetic successful response");
      assert.equal(result.retries, 2);
      assert.equal(origin.connections(), 3);
      assert.deepEqual(origin.submissions, [body], "the origin must execute only one HTTP POST");
      assert.equal(origin.failedHellos.length, 2);
      assert(origin.failedHellos.every((hello) => hello[0] === 22), "the failed peers receive TLS handshake records only");
      assert.deepEqual(attempts.map((attempt) => attempt.deliveryState), ["not_sent", "not_sent", "response_started"]);
      assert.deepEqual(attempts.map((attempt) => attempt.retryScheduled), [true, true, false]);
      assert.deepEqual(attempts.slice(0, 2).map((attempt) => attempt.errorCode), ["ECONNRESET", "ECONNRESET"]);
    });
  }
});

test("an exhausted real pre-TLS failure has bounded attempts and actionable host diagnostics", { timeout: 10_000 }, async (t) => {
  const origin = await fixture(t, { failures: Infinity });
  const attempts = [];
  let failure;
  await assert.rejects(fetchWithRetry(origin.url, { method: "POST", body }, options(origin, attempts)), (error) => {
    failure = error;
    return error.cause.code === "ECONNRESET";
  });
  assert.equal(origin.connections(), 3);
  assert.equal(origin.submissions.length, 0);
  assert.equal(attempts.length, 3);
  assert.deepEqual(attempts.map((attempt) => attempt.retryScheduled), [true, true, false]);
  assert.equal(failure.cause.syscall, undefined, "exercise Node's actual pre-TLS error shape");
  assert.equal(transportDeliveryState(failure), "not_sent");
  const diagnosis = describeTransportFailure(failure);
  assert.match(diagnosis.cause, /127\.0\.0\.1/);
  assert.match(diagnosis.cause, /before.*TLS/);
});

test("a real TLS socket reset after accepting a POST remains ambiguous and is never replayed", { timeout: 10_000 }, async (t) => {
  const origin = await fixture(t, { responseMode: "reset-after-post" });
  const attempts = [];
  await assert.rejects(fetchWithRetry(origin.url, { method: "POST", body }, options(origin, attempts)), (error) => {
    assert.equal(transportDeliveryState(error), "possibly_sent");
    return error.cause.code === "UND_ERR_SOCKET";
  });
  assert.deepEqual(origin.submissions, [body]);
  assert.equal(origin.connections(), 1);
  assert.equal(attempts.length, 1);
  assert.equal(attempts[0].retryScheduled, false);
});

test("a real upstream stream closed after output is never replayed", { timeout: 10_000 }, async (t) => {
  const origin = await fixture(t, { responseMode: "reset-after-output" });
  const attempts = [];
  const result = await fetchWithRetry(origin.url, { method: "POST", body }, options(origin, attempts));
  assert.equal(result.response.status, 200);
  const reader = result.response.body.getReader();
  const first = await reader.read();
  assert.match(Buffer.from(first.value).toString(), /response.created/);
  await assert.rejects(reader.read(), /terminated/);
  assert.deepEqual(origin.submissions, [body]);
  assert.equal(result.retries, 0);
  assert.equal(attempts.length, 1);
});

test("a pre-TLS retry still observes cancellation, output permission, budget, and disabled retries", { timeout: 10_000 }, async (t) => {
  for (const gate of ["cancellation", "output permission", "budget", "disabled retries"]) {
    await t.test(gate, async (subtest) => {
      const origin = await fixture(subtest, { failures: 1 });
      const attempts = [];
      const controller = new AbortController();
      let allowed = true;
      let clock = 0;
      const override = {
        now: () => clock, canRetry: () => allowed,
        retries: gate === "disabled retries" ? 0 : 2,
        sleepImpl: async () => {
          if (gate === "cancellation") controller.abort();
          if (gate === "output permission") allowed = false;
          if (gate === "budget") clock = 5_000;
        },
      };
      await assert.rejects(fetchWithRetry(origin.url, { method: "POST", body, signal: controller.signal }, options(origin, attempts, override)));
      assert.equal(origin.connections(), 1);
      assert.equal(origin.submissions.length, 0);
      assert.equal(attempts.length, 1);
      assert.equal(attempts[0].deliveryState, "not_sent");
    });
  }
});

test("generic resets and similar error messages do not establish pre-TLS delivery evidence", () => {
  const message = "Client network socket disconnected before secure TLS connection was established";
  for (const [code, text] of [["ECONNRESET", "socket hang up"], ["ECONNRESET", `${message}: untrusted suffix`], ["UND_ERR_SOCKET", message]]) {
    const error = new TypeError("fetch failed", { cause: Object.assign(new Error(text), { code }) });
    assert.equal(transportDeliveryState(error), "possibly_sent");
  }
});

test("a spawned native router recovers pre-TLS resets and records the real retry boundary", { timeout: 30_000 }, async (t) => {
  const origin = await fixture(t, { failures: 2, responseMode: "responses" });
  const root = fileURLToPath(new URL("../", import.meta.url));
  const state = mkdtempSync(path.join(os.tmpdir(), "pre-tls-router-"));
  const certPath = path.join(state, "loopback-cert.pem");
  writeFileSync(certPath, cert);
  const port = await openPort();
  const callerKey = "synthetic-pre-tls-caller-key-with-sufficient-length";
  const base = callerBaseUrl(port, callerKey);
  const child = spawn(process.execPath, [path.join(root, "src/router.mjs")], {
    cwd: root, windowsHide: true, stdio: ["ignore", "ignore", "pipe"],
    env: {
      ...process.env, CODEX_HOME: path.join(state, "codex"), MODEL_ROUTER_STATE_DIR: state,
      CODEX_ROUTER_STATE_DIR: state, MODEL_ROUTER_USER_MODELS: path.join(state, "user-models.json"),
      CODEX_ROUTER_PORT: String(port), CODEX_NATIVE_BASE_URL: origin.url,
      CODEX_ROUTER_GATEWAY_BASE_URL: origin.url, CODEX_ROUTER_SHOW_ALL_MODELS: "1",
      CODEX_ROUTER_CALLER_KEY: callerKey, CODEX_ROUTER_INTERNAL_KEY: "synthetic-internal-key-with-sufficient-length",
      CODEX_ROUTER_NATIVE_RETRY_POLICY: "at-most-once", CODEX_ROUTER_NATIVE_RETRY_BACKOFF_MS: "0",
      CODEX_ROUTER_NATIVE_RETRIES: "2", CODEX_ROUTER_QUIET: "1",
      NODE_EXTRA_CA_CERTS: certPath,
      http_proxy: "", https_proxy: "", HTTP_PROXY: "", HTTPS_PROXY: "", NODE_USE_ENV_PROXY: "0",
    },
  });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = new Promise((resolve) => child.once("exit", resolve));
      child.kill("SIGTERM");
      await exited;
    }
    const resolved = path.resolve(state);
    assert(resolved.startsWith(`${path.resolve(os.tmpdir())}${path.sep}`) && path.basename(resolved).startsWith("pre-tls-router-"));
    rmSync(resolved, { recursive: true, force: true });
  });
  const until = Date.now() + 20_000;
  for (;;) {
    assert.equal(child.exitCode, null, stderr);
    try { if ((await globalThis.fetch(`${base}/models`)).ok) break; } catch { /* Not bound yet. */ }
    assert(Date.now() < until, `Local router startup timed out: ${stderr}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  const result = await globalThis.fetch(`${base}/responses`, {
    method: "POST", headers: { Authorization: "Bearer synthetic-native-session", "Content-Type": "application/json" },
    body: JSON.stringify({ model: "gpt-6.1-sol", stream: false, input: "Synthetic local native turn" }),
    signal: AbortSignal.timeout(10_000),
  });
  assert.equal(result.status, 200, stderr);
  assert.equal((await result.json()).status, "completed");
  assert.equal(origin.submissions.length, 1);
  assert.equal(origin.failedHellos.length, 2);
  assert.match(stderr, /native upstream retry 1\/2 error=TypeError\/ECONNRESET/);
  assert.match(stderr, /native upstream retry 2\/2 error=TypeError\/ECONNRESET/);
  const ledger = path.join(state, "usage-events.jsonl");
  while (!existsSync(ledger) || !readFileSync(ledger, "utf8").trim()) {
    assert(Date.now() < until, "Native router did not record the recovered request");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  const event = JSON.parse(readFileSync(ledger, "utf8").trim().split("\n").at(-1));
  assert.equal(event.deliveryPolicy, "at-most-once");
  assert.equal(event.retries, 2);
  assert.deepEqual(event.upstreamAttempts.map((attempt) => attempt.deliveryState), ["not_sent", "not_sent", "response_started"]);
});
