import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { callerBaseUrl } from "../src/caller-auth.mjs";
import { openPort } from "./port-pool.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const INTERNAL_KEY = "test-internal-service-key-with-sufficient-length";
const CALLER_KEY = "test-router-caller-capability-with-sufficient-length";

async function mockServer(handler) {
  const server = http.createServer(handler);
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return { server, port: server.address().port };
}

function run(env) {
  const stateDir = mkdtempSync(path.join(os.tmpdir(), "router-resilience-state-"));
  const child = spawn(process.execPath, [path.join(root, "src", "router.mjs")], {
    cwd: root,
    env: {
      ...process.env,
      MODEL_ROUTER_STATE_DIR: stateDir,
      CODEX_ROUTER_CALLER_KEY: CALLER_KEY,
      CODEX_ROUTER_INTERNAL_KEY: INTERNAL_KEY,
      KIMI_INTERNAL_KEY: INTERNAL_KEY,
      CODEX_ROUTER_SHOW_ALL_MODELS: "1",
      CODEX_ROUTER_QUIET: "1",
      ...env,
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  child.stderr.setEncoding("utf8");
  let errors = "";
  child.stderr.on("data", (chunk) => {
    errors += chunk;
  });
  child.testErrors = () => errors;
  child.stateDir = stateDir;
  return child;
}

function usageEvents(stateDir) {
  const file = path.join(stateDir, "usage-events.jsonl");
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

// The router meters after it has already answered the client, so the request
// can resolve before the event reaches disk. Poll rather than sleep.
async function waitForUsageEvents(stateDir, count, child) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const events = usageEvents(stateDir);
    if (events.length >= count) return events;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for ${count} usage events: ${child.testErrors()}`);
}

async function waitFor(url, child) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`Child exited early (${child.exitCode}): ${child.testErrors()}`);
    }
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // Not bound yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for ${url}: ${child.testErrors()}`);
}

async function stopChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  await new Promise((resolve) => child.once("exit", resolve));
}

async function closeServer(server) {
  await new Promise((resolve) => server.close(resolve));
}

function relayEventStream(payload) {
  const argumentsText = JSON.stringify({ payload });
  const events = [
    {
      type: "response.output_item.added",
      item: {
        type: "function_call",
        id: "fc_relay",
        name: "relay_external_agent_payload",
        arguments: "",
      },
    },
    {
      type: "response.function_call_arguments.done",
      item_id: "fc_relay",
      arguments: argumentsText,
    },
    { type: "response.completed", response: { status: "completed", output: [] } },
  ];
  return `${events
    .map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
    .join("")}data: [DONE]\n\n`;
}

function encryptedRelayBody(encrypted = "gAAAAA-shared-payload=") {
  return {
    model: "deepseek/deepseek-v4-pro",
    stream: false,
    input: [
      {
        type: "agent_message",
        content: [
          {
            type: "input_text",
            text: "Message Type: NEW_TASK\nTask name: /root/critic\nSender: /root\nPayload:\n",
          },
          { type: "encrypted_content", encrypted_content: encrypted },
        ],
      },
    ],
  };
}

function rawPipelinedExchange(port, payload) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: "127.0.0.1", port });
    let settled = false;
    let output = "";
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      callback(value);
    };
    socket.setEncoding("utf8");
    socket.setTimeout(3_000, () => {
      socket.destroy();
      finish(reject, new Error("Timed out waiting for pipelined router responses."));
    });
    socket.on("data", (chunk) => {
      output += chunk;
    });
    socket.once("error", (error) => finish(reject, error));
    socket.once("end", () => finish(resolve, output));
    socket.once("connect", () => socket.end(payload));
  });
}

// Read the routed turn with the raw client so a socket reset stays
// distinguishable from a complete message. A reset mid-chunked-body leaves
// `response.complete` false, which is the transport failure a reqwest client
// reports as "error decoding response body".
function readRouted(port, body) {
  const base = new URL(`${callerBaseUrl(port, CALLER_KEY)}/responses`);
  return new Promise((resolve, reject) => {
    const request = http.request(
      {
        host: "127.0.0.1",
        port,
        path: base.pathname,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer codex-caller-auth",
        },
      },
      (response) => {
        let text = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => {
          text += chunk;
        });
        const done = () =>
          resolve({ status: response.statusCode, body: text, complete: response.complete });
        response.once("end", done);
        response.once("close", done);
        response.once("error", done);
      },
    );
    request.once("error", reject);
    request.end(JSON.stringify(body));
  });
}

// A gateway that dies partway through an SSE body used to reach the client as a
// bare socket reset: `.pipe()` never forwarded the error, so the response stayed
// half-written until the top-level handler destroyed it, and the log said only
// "[codex-router] request failed".
test("a gateway that dies mid-stream ends the routed body and logs the cause", async () => {
  const gateway = await mockServer((request, response) => {
    if (request.method === "GET" && request.url === "/health") {
      const payload = Buffer.from(JSON.stringify({ ok: true }), "utf8");
      response.writeHead(200, {
        "Content-Type": "application/json",
        "Content-Length": String(payload.length),
      });
      response.end(payload);
      return;
    }
    response.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache",
    });
    response.write('event: response.created\ndata: {"type":"response.created"}\n\n');
    response.write(
      'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"partial"}\n\n',
    );
    // Reset the upstream socket without the terminating chunk, exactly as an
    // edge that drops a live stream does.
    setTimeout(() => response.destroy(), 60);
  });
  const routerPort = await openPort();
  const router = run({
    CODEX_ROUTER_PORT: String(routerPort),
    CODEX_ROUTER_GATEWAY_BASE_URL: `http://127.0.0.1:${gateway.port}/v1`,
    CODEX_ROUTER_OAUTH_HEALTH_URL: `http://127.0.0.1:${gateway.port}/health`,
    CODEX_ROUTER_API_HEALTH_URL: `http://127.0.0.1:${gateway.port}/health`,
    CODEX_ROUTER_GROK_OAUTH_HEALTH_URL: `http://127.0.0.1:${gateway.port}/health`,
    CODEX_ROUTER_GATEWAY_HEALTH_URL: `http://127.0.0.1:${gateway.port}/health`,
  });

  try {
    await waitFor(`${callerBaseUrl(routerPort, CALLER_KEY)}/models`, router);

    const result = await readRouted(routerPort, {
      model: "deepseek/deepseek-v4-pro",
      input: "hello",
      stream: true,
    });

    assert.equal(result.status, 200);
    assert.equal(
      result.complete,
      true,
      "the chunked body was reset instead of reaching its terminator",
    );
    // What the upstream managed to send survives, and the failure is stated
    // rather than passed off as a short successful turn.
    assert.match(result.body, /event: response\.created/);
    assert.match(result.body, /event: error/);
    assert.match(result.body, /local_router_stream_failed/);
    // The terminal event is the only place a cause can still reach the client
    // once the head is committed. Without it Codex reports a stream that just
    // stopped as `stream disconnected before completion`, which names nothing.
    assert.match(result.body, /closed early|reset the connection/);

    // The log has to name the cause; the bare string it used to write is why
    // this was undiagnosable in production.
    // A wait, not a bound: nothing here is asserting how *fast* the router
    // logs, only that it does, and 2s was short enough that a loaded machine
    // could still be scheduling the write. Wait as long as the rest of this
    // file waits for anything else. A router that never logs the cause still
    // fails on the assertion below, which is the property under test.
    const deadline = Date.now() + 10_000;
    while (!/request failed: /.test(router.testErrors()) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.match(router.testErrors(), /\[codex-router\] request failed: \w+: .+/);

    // The turn is truncated, not successful: the meter must record a failure
    // carrying the abort marker instead of the committed 200 the client
    // never finished reading.
    const [event] = await waitForUsageEvents(router.stateDir, 1, router);
    assert.equal(event.model, "deepseek/deepseek-v4-pro");
    assert.equal(event.provider, "deepseek");
    assert.equal(event.status, 502);
    assert.equal(event.streamAborted, true);
  } finally {
    await stopChild(router);
    await closeServer(gateway.server);
  }
});

test("the execution deadline aborts before releasing the in-flight slot", async () => {
  let upstreamAborted = false;
  const gateway = await mockServer(async (request, response) => {
    if (request.method === "GET" && request.url === "/health") {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ ok: true }));
      return;
    }
    request.once("aborted", () => {
      upstreamAborted = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    if (!response.writableEnded) {
      response.writeHead(200, {
        "Content-Type": "application/json",
        Connection: "close",
      });
      response.end(JSON.stringify({ id: "late", object: "response", output: [] }));
    }
  });
  const routerPort = await openPort();
  const router = run({
    CODEX_ROUTER_PORT: String(routerPort),
    CODEX_ROUTER_REQUEST_EXECUTION_TIMEOUT_MS: "80",
    CODEX_ROUTER_GATEWAY_BASE_URL: `http://127.0.0.1:${gateway.port}/v1`,
    CODEX_ROUTER_OAUTH_HEALTH_URL: `http://127.0.0.1:${gateway.port}/health`,
    CODEX_ROUTER_API_HEALTH_URL: `http://127.0.0.1:${gateway.port}/health`,
    CODEX_ROUTER_GROK_OAUTH_HEALTH_URL: `http://127.0.0.1:${gateway.port}/health`,
    CODEX_ROUTER_GATEWAY_HEALTH_URL: `http://127.0.0.1:${gateway.port}/health`,
  });
  try {
    await waitFor(`http://127.0.0.1:${routerPort}/health`, router);
    const response = await fetch(`${callerBaseUrl(routerPort, CALLER_KEY)}/responses`, {
      method: "POST",
      headers: {
        Authorization: "Bearer codex-caller-auth",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ model: "deepseek/deepseek-v4-pro", input: "deadline" }),
    });
    const responseBody = await response.json();
    assert.equal(response.status, 504, JSON.stringify(responseBody));
    assert.equal(responseBody.error.type, "router_request_timeout");
    const health = await fetch(`${callerBaseUrl(routerPort, CALLER_KEY)}/health`).then((r) => r.json());
    assert.equal(health.resources.inFlightRequests, 0);
    assert.equal(health.activity.state, "error");
    const events = await waitForUsageEvents(router.stateDir, 1, router);
    assert.equal(events[0].status, 504);
    assert.equal(events[0].requestDeadlineExceeded, true);
    const abortDeadline = Date.now() + 1_000;
    while (!upstreamAborted && Date.now() < abortDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(upstreamAborted, true);
  } finally {
    await stopChild(router);
    gateway.server.closeAllConnections?.();
    gateway.server.closeIdleConnections?.();
    gateway.server.close(() => {});
  }
});

test("activity record retention never cancels or releases a live request", async () => {
  let requestStarted;
  const started = new Promise((resolve) => {
    requestStarted = resolve;
  });
  const gateway = await mockServer(async (request, response) => {
    if (request.method === "GET" && request.url === "/health") {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ ok: true }));
      return;
    }
    requestStarted();
    await new Promise((resolve) => setTimeout(resolve, 160));
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ id: "long-lived", object: "response", output: [] }));
  });
  const routerPort = await openPort();
  const router = run({
    CODEX_ROUTER_PORT: String(routerPort),
    CODEX_ROUTER_ACTIVITY_RECORD_RETENTION_MS: "40",
    CODEX_ROUTER_REQUEST_EXECUTION_TIMEOUT_MS: "1000",
    CODEX_ROUTER_GATEWAY_BASE_URL: `http://127.0.0.1:${gateway.port}/v1`,
    CODEX_ROUTER_OAUTH_HEALTH_URL: `http://127.0.0.1:${gateway.port}/health`,
    CODEX_ROUTER_API_HEALTH_URL: `http://127.0.0.1:${gateway.port}/health`,
    CODEX_ROUTER_GROK_OAUTH_HEALTH_URL: `http://127.0.0.1:${gateway.port}/health`,
    CODEX_ROUTER_GATEWAY_HEALTH_URL: `http://127.0.0.1:${gateway.port}/health`,
  });
  try {
    await waitFor(`http://127.0.0.1:${routerPort}/health`, router);
    const pending = fetch(`${callerBaseUrl(routerPort, CALLER_KEY)}/responses`, {
      method: "POST",
      headers: {
        Authorization: "Bearer codex-caller-auth",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ model: "deepseek/deepseek-v4-pro", input: "long" }),
    });
    await started;

    const retentionDeadline = Date.now() + 1_000;
    let health;
    do {
      health = await fetch(`${callerBaseUrl(routerPort, CALLER_KEY)}/health`).then((r) => r.json());
      if (health.activity.activeCount === 0) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    } while (Date.now() < retentionDeadline);
    assert.equal(health.activity.activeCount, 0);
    assert.equal(health.resources.inFlightRequests, 1);

    const response = await pending;
    assert.equal(response.status, 200, await response.text());
    const settled = await fetch(`${callerBaseUrl(routerPort, CALLER_KEY)}/health`).then((r) => r.json());
    assert.equal(settled.resources.inFlightRequests, 0);
  } finally {
    await stopChild(router);
    await closeServer(gateway.server);
  }
});

test("same encrypted payload shares one relay and expiry removes the retained plaintext", async () => {
  let nativeRequests = 0;
  let gatewayRequests = 0;
  let markGatewayRequestsStarted;
  const gatewayRequestsStarted = new Promise((resolve) => {
    markGatewayRequestsStarted = resolve;
  });
  let releaseGateway;
  const gatewayReleased = new Promise((resolve) => {
    releaseGateway = resolve;
  });
  const native = await mockServer(async (_request, response) => {
    nativeRequests += 1;
    await new Promise((resolve) => setTimeout(resolve, 60));
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    response.end(relayEventStream("coalesced payload"));
  });
  const gateway = await mockServer(async (request, response) => {
    if (request.method === "GET" && request.url === "/health") {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ ok: true }));
      return;
    }
    gatewayRequests += 1;
    if (gatewayRequests === 2) markGatewayRequestsStarted();
    await gatewayReleased;
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ id: "r-coalesced", output: [] }));
  });
  const routerPort = await openPort();
  const router = run({
    CODEX_ROUTER_PORT: String(routerPort),
    CODEX_ROUTER_AGENT_PAYLOAD_CACHE_TTL_MS: "2000",
    CODEX_NATIVE_BASE_URL: `http://127.0.0.1:${native.port}/backend-api/codex`,
    CODEX_ROUTER_GATEWAY_BASE_URL: `http://127.0.0.1:${gateway.port}/v1`,
    CODEX_ROUTER_OAUTH_HEALTH_URL: `http://127.0.0.1:${gateway.port}/health`,
    CODEX_ROUTER_API_HEALTH_URL: `http://127.0.0.1:${gateway.port}/health`,
    CODEX_ROUTER_GROK_OAUTH_HEALTH_URL: `http://127.0.0.1:${gateway.port}/health`,
    CODEX_ROUTER_GATEWAY_HEALTH_URL: `http://127.0.0.1:${gateway.port}/health`,
  });
  const body = {
    model: "deepseek/deepseek-v4-pro",
    stream: false,
    input: [
      {
        type: "agent_message",
        content: [
          {
            type: "input_text",
            text: "Message Type: NEW_TASK\nTask name: /root/critic\nSender: /root\nPayload:\n",
          },
          { type: "encrypted_content", encrypted_content: "gAAAAA-coalesced=" },
        ],
      },
    ],
  };
  const headers = {
    Authorization: "Bearer CHATGPT_SESSION_TOKEN",
    "ChatGPT-Account-Id": "account-a",
    "Content-Type": "application/json",
  };
  try {
    await waitFor(`http://127.0.0.1:${routerPort}/health`, router);
    const firstPending = fetch(`${callerBaseUrl(routerPort, CALLER_KEY)}/responses`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
    const secondPending = fetch(`${callerBaseUrl(routerPort, CALLER_KEY)}/responses`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
    await Promise.race([
      gatewayRequestsStarted,
      new Promise((_, reject) => {
        const timer = setTimeout(
          () => reject(new Error(`Timed out waiting for routed payloads: ${router.testErrors()}`)),
          5_000,
        );
        timer.unref?.();
      }),
    ]);
    // The router retains the plaintext before forwarding either routed turn.
    // Hold both gateway responses so slow process startup and downstream work
    // cannot consume the cache TTL before this retention assertion.
    const retained = await fetch(`${callerBaseUrl(routerPort, CALLER_KEY)}/health`).then((r) => r.json());
    assert.equal(nativeRequests, 1);
    assert.equal(retained.resources.maxDecodedBodyBytes, 256 * 1024 * 1024);
    assert.equal(retained.resources.agentPayloadCache.entries, 1);
    assert.ok(retained.resources.agentPayloadCache.coalesced >= 1);

    releaseGateway();
    const [first, second] = await Promise.all([
      firstPending,
      secondPending,
    ]);
    assert.equal(first.status, 200, await first.text());
    assert.equal(second.status, 200, await second.text());
    const expiryDeadline = Date.now() + 4_000;
    let expired;
    do {
      await new Promise((resolve) => setTimeout(resolve, 50));
      expired = await fetch(`${callerBaseUrl(routerPort, CALLER_KEY)}/health`).then((r) => r.json());
      if (expired.resources.agentPayloadCache.entries === 0) break;
    } while (Date.now() < expiryDeadline);
    assert.equal(expired.resources.agentPayloadCache.entries, 0);
    assert.equal(expired.resources.agentPayloadCache.bytes, 0);
    assert.ok(expired.resources.agentPayloadCache.expirations >= 1);
  } finally {
    releaseGateway();
    await stopChild(router);
    await Promise.all([closeServer(native.server), closeServer(gateway.server)]);
  }
});

test("conflicting relay snapshots never reach the provider or populate the task cache", async () => {
  let nativeRequests = 0;
  let gatewayRequests = 0;
  const native = await mockServer(async (_request, response) => {
    nativeRequests += 1;
    const conflict = { type: "response.output_item.done", item: {
      type: "function_call", id: "fc_relay", name: "relay_external_agent_payload",
      arguments: JSON.stringify({ payload: "PRIVATE_REPLACEMENT" }),
    } };
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    response.end(relayEventStream("PRIVATE_ORIGINAL").replace("event: response.completed",
      `data: ${JSON.stringify(conflict)}\n\nevent: response.completed`));
  });
  const gateway = await mockServer(async (request, response) => {
    if (request.method !== "GET") gatewayRequests += 1;
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ ok: true, output: [] }));
  });
  const routerPort = await openPort();
  const router = run({
    CODEX_ROUTER_PORT: String(routerPort),
    CODEX_NATIVE_BASE_URL: `http://127.0.0.1:${native.port}/backend-api/codex`,
    CODEX_ROUTER_GATEWAY_BASE_URL: `http://127.0.0.1:${gateway.port}/v1`,
  });
  try {
    await waitFor(`${callerBaseUrl(routerPort, CALLER_KEY)}/models`, router);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const response = await fetch(`${callerBaseUrl(routerPort, CALLER_KEY)}/responses`, {
        method: "POST", headers: { Authorization: "Bearer synthetic-native-session",
          "ChatGPT-Account-Id": "synthetic-account", "Content-Type": "application/json" },
        body: JSON.stringify(encryptedRelayBody()),
      });
      assert.equal(response.status, 502);
      const body = await response.text();
      assert.equal(JSON.parse(body).error.code, "ERR_NATIVE_AGENT_RELAY_CONFLICTING_ARGUMENTS");
      assert.doesNotMatch(body, /PRIVATE_ORIGINAL|PRIVATE_REPLACEMENT/);
    }
    assert.equal(nativeRequests, 2, "neither response may enter the successful task cache");
    assert.equal(gatewayRequests, 0, "ambiguous task bytes must not reach the routed provider");
  } finally {
    await stopChild(router);
    await Promise.all([closeServer(native.server), closeServer(gateway.server)]);
  }
});

test("same ciphertext never coalesces or caches across native accounts", async () => {
  const nativeRequests = [];
  const native = await mockServer(async (request, response) => {
    nativeRequests.push({
      account: request.headers["chatgpt-account-id"],
      authorization: request.headers.authorization,
    });
    await new Promise((resolve) => setTimeout(resolve, 60));
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    response.end(relayEventStream(`payload for ${request.headers["chatgpt-account-id"]}`));
  });
  let gatewayRequests = 0;
  const gateway = await mockServer(async (request, response) => {
    if (request.method === "GET" && request.url === "/health") {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ ok: true }));
      return;
    }
    gatewayRequests += 1;
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ id: "account-scoped", output: [] }));
  });
  const routerPort = await openPort();
  const router = run({
    CODEX_ROUTER_PORT: String(routerPort),
    CODEX_NATIVE_BASE_URL: `http://127.0.0.1:${native.port}/backend-api/codex`,
    CODEX_ROUTER_GATEWAY_BASE_URL: `http://127.0.0.1:${gateway.port}/v1`,
    CODEX_ROUTER_OAUTH_HEALTH_URL: `http://127.0.0.1:${gateway.port}/health`,
    CODEX_ROUTER_API_HEALTH_URL: `http://127.0.0.1:${gateway.port}/health`,
    CODEX_ROUTER_GROK_OAUTH_HEALTH_URL: `http://127.0.0.1:${gateway.port}/health`,
    CODEX_ROUTER_GATEWAY_HEALTH_URL: `http://127.0.0.1:${gateway.port}/health`,
  });
  const body = JSON.stringify(encryptedRelayBody("gAAAAA-account-boundary="));
  const requestFor = (account) =>
    fetch(`${callerBaseUrl(routerPort, CALLER_KEY)}/responses`, {
      method: "POST",
      headers: {
        Authorization: `Bearer session-${account}`,
        "ChatGPT-Account-Id": account,
        "Content-Type": "application/json",
      },
      body,
    });
  try {
    await waitFor(`http://127.0.0.1:${routerPort}/health`, router);
    const [first, second] = await Promise.all([
      requestFor("account-a"),
      requestFor("account-b"),
    ]);
    assert.equal(first.status, 200, await first.text());
    assert.equal(second.status, 200, await second.text());
    assert.equal(gatewayRequests, 2);
    assert.deepEqual(
      nativeRequests
        .map(({ account, authorization }) => `${account}:${authorization}`)
        .sort(),
      ["account-a:Bearer session-account-a", "account-b:Bearer session-account-b"],
    );
  } finally {
    await stopChild(router);
    await Promise.all([closeServer(native.server), closeServer(gateway.server)]);
  }
});

test("canceling one coalesced relay waiter does not abort another", async () => {
  let nativeRequests = 0;
  let nativeAborted = false;
  let relayStarted;
  const started = new Promise((resolve) => {
    relayStarted = resolve;
  });
  const native = await mockServer(async (request, response) => {
    nativeRequests += 1;
    request.once("aborted", () => {
      nativeAborted = true;
    });
    relayStarted();
    await new Promise((resolve) => setTimeout(resolve, 150));
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    response.end(relayEventStream("shared result"));
  });
  const gateway = await mockServer(async (request, response) => {
    if (request.method === "GET" && request.url === "/health") {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ ok: true }));
      return;
    }
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ id: "surviving-waiter", output: [] }));
  });
  const routerPort = await openPort();
  const router = run({
    CODEX_ROUTER_PORT: String(routerPort),
    CODEX_NATIVE_BASE_URL: `http://127.0.0.1:${native.port}/backend-api/codex`,
    CODEX_ROUTER_GATEWAY_BASE_URL: `http://127.0.0.1:${gateway.port}/v1`,
    CODEX_ROUTER_OAUTH_HEALTH_URL: `http://127.0.0.1:${gateway.port}/health`,
    CODEX_ROUTER_API_HEALTH_URL: `http://127.0.0.1:${gateway.port}/health`,
    CODEX_ROUTER_GROK_OAUTH_HEALTH_URL: `http://127.0.0.1:${gateway.port}/health`,
    CODEX_ROUTER_GATEWAY_HEALTH_URL: `http://127.0.0.1:${gateway.port}/health`,
  });
  const controller = new AbortController();
  const headers = {
    Authorization: "Bearer shared-session",
    "ChatGPT-Account-Id": "shared-account",
    "Content-Type": "application/json",
  };
  const body = JSON.stringify(encryptedRelayBody("gAAAAA-cancel-boundary="));
  try {
    await waitFor(`http://127.0.0.1:${routerPort}/health`, router);
    const first = fetch(`${callerBaseUrl(routerPort, CALLER_KEY)}/responses`, {
      method: "POST",
      headers,
      body,
      signal: controller.signal,
    }).catch((error) => error);
    await started;
    const second = fetch(`${callerBaseUrl(routerPort, CALLER_KEY)}/responses`, {
      method: "POST",
      headers,
      body,
    });

    const coalescingDeadline = Date.now() + 1_000;
    let health;
    do {
      health = await fetch(`${callerBaseUrl(routerPort, CALLER_KEY)}/health`).then((r) => r.json());
      if (health.resources.agentPayloadCache.coalesced >= 1) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    } while (Date.now() < coalescingDeadline);
    assert.ok(health.resources.agentPayloadCache.coalesced >= 1);

    controller.abort();
    assert.ok((await first) instanceof Error);
    const surviving = await second;
    assert.equal(surviving.status, 200, await surviving.text());
    assert.equal(nativeRequests, 1);
    assert.equal(nativeAborted, false);
  } finally {
    controller.abort();
    await stopChild(router);
    await Promise.all([closeServer(native.server), closeServer(gateway.server)]);
  }
});

test("canceling every coalesced relay waiter aborts the one shared native request", async () => {
  let nativeRequests = 0;
  let markNativeAborted;
  const nativeAborted = new Promise((resolve) => {
    markNativeAborted = resolve;
  });
  let relayStarted;
  const started = new Promise((resolve) => {
    relayStarted = resolve;
  });
  const native = await mockServer((request, response) => {
    nativeRequests += 1;
    let marked = false;
    const mark = () => {
      if (marked) return;
      marked = true;
      markNativeAborted();
    };
    request.once("aborted", mark);
    response.once("close", mark);
    relayStarted();
  });
  let gatewayRequests = 0;
  const gateway = await mockServer((request, response) => {
    if (request.method === "GET" && request.url === "/health") {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ ok: true }));
      return;
    }
    gatewayRequests += 1;
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ id: "unexpected", output: [] }));
  });
  const routerPort = await openPort();
  const router = run({
    CODEX_ROUTER_PORT: String(routerPort),
    CODEX_NATIVE_BASE_URL: `http://127.0.0.1:${native.port}/backend-api/codex`,
    CODEX_ROUTER_GATEWAY_BASE_URL: `http://127.0.0.1:${gateway.port}/v1`,
    CODEX_ROUTER_OAUTH_HEALTH_URL: `http://127.0.0.1:${gateway.port}/health`,
    CODEX_ROUTER_API_HEALTH_URL: `http://127.0.0.1:${gateway.port}/health`,
    CODEX_ROUTER_GROK_OAUTH_HEALTH_URL: `http://127.0.0.1:${gateway.port}/health`,
    CODEX_ROUTER_GATEWAY_HEALTH_URL: `http://127.0.0.1:${gateway.port}/health`,
  });
  const firstController = new AbortController();
  const secondController = new AbortController();
  const headers = {
    Authorization: "Bearer shared-session",
    "ChatGPT-Account-Id": "shared-account",
    "Content-Type": "application/json",
  };
  const body = JSON.stringify(encryptedRelayBody("gAAAAA-all-canceled="));
  try {
    await waitFor(`http://127.0.0.1:${routerPort}/health`, router);
    const first = fetch(`${callerBaseUrl(routerPort, CALLER_KEY)}/responses`, {
      method: "POST",
      headers,
      body,
      signal: firstController.signal,
    }).catch((error) => error);
    await started;
    const second = fetch(`${callerBaseUrl(routerPort, CALLER_KEY)}/responses`, {
      method: "POST",
      headers,
      body,
      signal: secondController.signal,
    }).catch((error) => error);

    const coalescingDeadline = Date.now() + 1_000;
    let health;
    do {
      health = await fetch(`${callerBaseUrl(routerPort, CALLER_KEY)}/health`).then((r) => r.json());
      if (health.resources.agentPayloadCache.coalesced >= 1) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    } while (Date.now() < coalescingDeadline);
    assert.ok(health.resources.agentPayloadCache.coalesced >= 1);

    firstController.abort();
    secondController.abort();
    assert.ok((await first) instanceof Error);
    assert.ok((await second) instanceof Error);
    await Promise.race([
      nativeAborted,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("shared native relay was not aborted")), 1_000),
      ),
    ]);
    assert.equal(nativeRequests, 1);
    assert.equal(gatewayRequests, 0);
  } finally {
    firstController.abort();
    secondController.abort();
    await stopChild(router);
    await Promise.all([closeServer(native.server), closeServer(gateway.server)]);
  }
});

test("active request admission is bounded and rejects later bodies after draining them", async () => {
  let gatewayRequests = 0;
  let firstRequestSeen;
  const firstRequestReady = new Promise((resolve) => {
    firstRequestSeen = resolve;
  });
  const gateway = await mockServer((request, response) => {
    if (request.method === "GET" && request.url === "/health") {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ ok: true }));
      return;
    }
    gatewayRequests += 1;
    firstRequestSeen();
    request.once("aborted", () => {
      response.destroy();
    });
  });
  const routerPort = await openPort();
  const router = run({
    CODEX_ROUTER_PORT: String(routerPort),
    CODEX_ROUTER_MAX_ACTIVE_REQUESTS: "1",
    CODEX_ROUTER_GATEWAY_BASE_URL: `http://127.0.0.1:${gateway.port}/v1`,
    CODEX_ROUTER_OAUTH_HEALTH_URL: `http://127.0.0.1:${gateway.port}/health`,
    CODEX_ROUTER_API_HEALTH_URL: `http://127.0.0.1:${gateway.port}/health`,
    CODEX_ROUTER_GROK_OAUTH_HEALTH_URL: `http://127.0.0.1:${gateway.port}/health`,
    CODEX_ROUTER_GATEWAY_HEALTH_URL: `http://127.0.0.1:${gateway.port}/health`,
  });
  const firstAbort = new AbortController();
  try {
    await waitFor(`http://127.0.0.1:${routerPort}/health`, router);
    const first = fetch(`${callerBaseUrl(routerPort, CALLER_KEY)}/responses`, {
      method: "POST",
      headers: {
        Authorization: "Bearer codex-caller-auth",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ model: "deepseek/deepseek-v4-pro", input: "hold" }),
      signal: firstAbort.signal,
    }).catch((error) => error);
    await firstRequestReady;

    const rejected = await fetch(`${callerBaseUrl(routerPort, CALLER_KEY)}/responses`, {
      method: "POST",
      headers: {
        Authorization: "Bearer codex-caller-auth",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ model: "deepseek/deepseek-v4-pro", input: "reject" }),
    });
    const rejectedBody = await rejected.json();
    assert.equal(rejected.status, 429, JSON.stringify(rejectedBody));
    assert.equal(rejectedBody.error.code, "ERR_ROUTER_ACTIVE_REQUEST_LIMIT");
    assert.equal(gatewayRequests, 1);

    const rejectedUrl = new URL(`${callerBaseUrl(routerPort, CALLER_KEY)}/responses`);
    const healthUrl = new URL(`${callerBaseUrl(routerPort, CALLER_KEY)}/health`);
    const pipelinedBody = JSON.stringify({
      model: "deepseek/deepseek-v4-pro",
      // Keep the following request beyond Node's 64 KiB stream buffer. Without
      // request.resume(), the negative control stalls before parsing the GET.
      input: "x".repeat(256 * 1024),
    });
    const pipelined = await rawPipelinedExchange(
      routerPort,
      [
        `POST ${rejectedUrl.pathname} HTTP/1.1\r\n`,
        `Host: 127.0.0.1:${routerPort}\r\n`,
        "Authorization: Bearer codex-caller-auth\r\n",
        "Content-Type: application/json\r\n",
        `Content-Length: ${Buffer.byteLength(pipelinedBody)}\r\n`,
        "Connection: keep-alive\r\n\r\n",
        pipelinedBody,
        `GET ${healthUrl.pathname} HTTP/1.1\r\n`,
        `Host: 127.0.0.1:${routerPort}\r\n`,
        "Connection: close\r\n\r\n",
      ].join(""),
    );
    const statuses = [...pipelined.matchAll(/HTTP\/1\.1 (\d{3})/g)].map((match) =>
      Number(match[1]),
    );
    assert.deepEqual(statuses, [429, 200], pipelined);
    assert.equal(gatewayRequests, 1, "the rejected pipeline never reaches upstream");

    firstAbort.abort();
    const firstResult = await first;
    assert.ok(firstResult instanceof Error, `expected aborted first request, got ${firstResult}`);
  } finally {
    firstAbort.abort();
    await stopChild(router);
    await closeServer(gateway.server);
  }
});

// A client that cancels mid-stream is not an upstream failure: the router
// meters the turn as 0 rather than the committed 200 or a fabricated 5xx.
test("a client cancel mid-stream meters 0 and never claims an upstream failure", async () => {
  const gateway = await mockServer((request, response) => {
    if (request.method === "GET" && request.url === "/health") {
      const payload = Buffer.from(JSON.stringify({ ok: true }), "utf8");
      response.writeHead(200, {
        "Content-Type": "application/json",
        "Content-Length": String(payload.length),
      });
      response.end(payload);
      return;
    }
    // Hold the stream open; the client is the one leaving.
    response.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8" });
    response.write('event: response.created\ndata: {"type":"response.created"}\n\n');
  });
  const routerPort = await openPort();
  const router = run({
    CODEX_ROUTER_PORT: String(routerPort),
    CODEX_ROUTER_GATEWAY_BASE_URL: `http://127.0.0.1:${gateway.port}/v1`,
    CODEX_ROUTER_OAUTH_HEALTH_URL: `http://127.0.0.1:${gateway.port}/health`,
    CODEX_ROUTER_API_HEALTH_URL: `http://127.0.0.1:${gateway.port}/health`,
    CODEX_ROUTER_GROK_OAUTH_HEALTH_URL: `http://127.0.0.1:${gateway.port}/health`,
    CODEX_ROUTER_GATEWAY_HEALTH_URL: `http://127.0.0.1:${gateway.port}/health`,
  });

  try {
    await waitFor(`${callerBaseUrl(routerPort, CALLER_KEY)}/models`, router);

    // Read with the raw client so the cancel is a real socket hangup, the
    // same path Codex uses when the user stops a generation.
    await new Promise((resolve) => {
      const request = http.request(
        {
          host: "127.0.0.1",
          port: routerPort,
          path: `${callerBaseUrl(routerPort, CALLER_KEY)}/responses`,
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: "Bearer codex-caller-auth",
          },
        },
        (response) => {
          response.once("data", () => {
            request.destroy();
            resolve();
          });
        },
      );
      request.once("error", resolve);
      request.end(
        JSON.stringify({ model: "deepseek/deepseek-v4-pro", input: "hello", stream: true }),
      );
    });

    const [event] = await waitForUsageEvents(router.stateDir, 1, router);
    assert.equal(event.model, "deepseek/deepseek-v4-pro");
    assert.equal(event.status, 0);
    assert.equal("streamAborted" in event, false);
    // No 502 marker and no failure log: the cancel was never an upstream
    // error, so it must not push the error state either.
    assert.doesNotMatch(router.testErrors(), /request failed/);
    const health = await fetch(`http://127.0.0.1:${routerPort}/health`).then((r) => r.json());
    assert.equal(health.activity.state, "idle");
  } finally {
    await stopChild(router);
    await closeServer(gateway.server);
  }
});

// A bare `listen()` failure is an unhandled 'error' event: the process exits
// silently, the supervisor restarts it, and the port is never bound with
// nothing in the log to say why.
test("a taken port exits with a named cause and a distinguishable code", async () => {
  const holder = net.createServer();
  await new Promise((resolve, reject) => {
    holder.once("error", reject);
    holder.listen(0, "127.0.0.1", resolve);
  });
  const takenPort = holder.address().port;
  const router = run({ CODEX_ROUTER_PORT: String(takenPort) });

  try {
    const exitCode = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("router never exited")), 10_000);
      router.once("exit", (code) => {
        clearTimeout(timer);
        resolve(code);
      });
    });
    assert.equal(exitCode, 98);
    assert.match(router.testErrors(), /cannot listen: 127\.0\.0\.1:\d+ is already in use/);
  } finally {
    await stopChild(router);
    await new Promise((resolve) => holder.close(resolve));
  }
});

// The router must keep answering /health and keep routing when the selection
// file names a provider this build does not have; that read used to throw out
// of the first statement of healthPayload().
test("a selection file naming an unknown provider does not wedge the router", async () => {
  const stateDir = mkdtempSync(path.join(os.tmpdir(), "router-resilience-selection-"));
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(
    path.join(stateDir, "enabled-providers.json"),
    `${JSON.stringify({
      version: 1,
      providers: ["deepseek", "provider-from-a-newer-build"],
    })}\n`,
    { mode: 0o600 },
  );
  const gateway = await mockServer((request, response) => {
    const payload = Buffer.from(JSON.stringify({ ok: true, route: "external" }), "utf8");
    response.writeHead(200, {
      "Content-Type": "application/json",
      "Content-Length": String(payload.length),
    });
    response.end(payload);
  });
  const routerPort = await openPort();
  const router = run({
    CODEX_ROUTER_PORT: String(routerPort),
    CODEX_ROUTER_STATE_DIR: stateDir,
    MODEL_ROUTER_STATE_DIR: stateDir,
    CODEX_ROUTER_SHOW_ALL_MODELS: "0",
    CODEX_ROUTER_GATEWAY_BASE_URL: `http://127.0.0.1:${gateway.port}/v1`,
    CODEX_ROUTER_OAUTH_HEALTH_URL: `http://127.0.0.1:${gateway.port}/health`,
    CODEX_ROUTER_API_HEALTH_URL: `http://127.0.0.1:${gateway.port}/health`,
    CODEX_ROUTER_GROK_OAUTH_HEALTH_URL: `http://127.0.0.1:${gateway.port}/health`,
    CODEX_ROUTER_GATEWAY_HEALTH_URL: `http://127.0.0.1:${gateway.port}/health`,
  });

  try {
    await waitFor(`http://127.0.0.1:${routerPort}/health`, router);
    const health = await fetch(`http://127.0.0.1:${routerPort}/health`);
    assert.equal(health.status, 200);
    assert.equal((await health.json()).ok, true);

    // The known provider in the same file still routes.
    const routed = await fetch(`${callerBaseUrl(routerPort, CALLER_KEY)}/responses`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer codex-caller-auth",
      },
      body: JSON.stringify({ model: "deepseek/deepseek-v4-pro", input: "hello" }),
    });
    assert.equal(routed.status, 200);
  } finally {
    await stopChild(router);
    await closeServer(gateway.server);
    rmSync(stateDir, { recursive: true, force: true });
  }
});

// Codex's HTTP client pools idle connections for 90 seconds and ignores the
// `Keep-Alive: timeout=` header the router advertises, so Node's 5-second
// default made the server close sockets the client still believed were live.
// Reusing one of those answered the next turn with a FIN instead of a
// response, which reqwest reports as "error sending request for url" and
// Codex surfaces as "stream disconnected before completion". The idle gap
// here is longer than that old default and shorter than the pool it has to
// outlast.
test("an idle keep-alive connection survives past Node's default timeout", async () => {
  const gateway = await mockServer((request, response) => {
    const payload = Buffer.from(JSON.stringify({ ok: true }), "utf8");
    response.writeHead(200, {
      "Content-Type": "application/json",
      "Content-Length": String(payload.length),
    });
    response.end(payload);
  });
  const routerPort = await openPort();
  const router = run({
    CODEX_ROUTER_PORT: String(routerPort),
    CODEX_ROUTER_GATEWAY_BASE_URL: `http://127.0.0.1:${gateway.port}/v1`,
    CODEX_ROUTER_OAUTH_HEALTH_URL: `http://127.0.0.1:${gateway.port}/health`,
    CODEX_ROUTER_API_HEALTH_URL: `http://127.0.0.1:${gateway.port}/health`,
    CODEX_ROUTER_GROK_OAUTH_HEALTH_URL: `http://127.0.0.1:${gateway.port}/health`,
    CODEX_ROUTER_GATEWAY_HEALTH_URL: `http://127.0.0.1:${gateway.port}/health`,
  });
  const IDLE_MS = 6_500;

  try {
    await waitFor(`http://127.0.0.1:${routerPort}/health`, router);

    const socket = net.connect(routerPort, "127.0.0.1");
    try {
      const request =
        "GET /health HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: keep-alive\r\n\r\n";
      // A raw socket is the only way to hold one connection across the idle
      // gap; an agent would be free to open a second one and hide the bug.
      const exchange = () =>
        new Promise((resolve, reject) => {
          let text = "";
          const onData = (chunk) => {
            text += chunk.toString("utf8");
            if (text.includes("\r\n\r\n") && text.trimEnd().endsWith("}")) done(resolve, text);
          };
          const onEnd = () =>
            done(reject, undefined, new Error("server closed the idle connection"));
          const onError = (error) => done(reject, undefined, error);
          function done(settle, value, error) {
            socket.off("data", onData);
            socket.off("end", onEnd);
            socket.off("error", onError);
            clearTimeout(timer);
            error ? settle(error) : settle(value);
          }
          const timer = setTimeout(
            () => done(reject, undefined, new Error("no response on the reused connection")),
            5_000,
          );
          socket.on("data", onData);
          socket.once("end", onEnd);
          socket.once("error", onError);
          socket.write(request);
        });

      const first = await exchange();
      assert.match(first, /^HTTP\/1\.1 200/);
      // The advertised timeout is what a client that does read the header
      // (undici, curl) paces itself by, so it has to move with the setting.
      assert.match(first, /Keep-Alive: timeout=120/);

      await new Promise((resolve) => setTimeout(resolve, IDLE_MS));
      assert.equal(
        socket.destroyed,
        false,
        `the router closed an idle connection within ${IDLE_MS}ms`,
      );

      const second = await exchange();
      assert.match(second, /^HTTP\/1\.1 200/);
    } finally {
      socket.destroy();
    }
  } finally {
    await stopChild(router);
    await closeServer(gateway.server);
  }
});

test("protected activity follows a quiet stream through reasoning and client cancellation", async () => {
  const threadId = "11111111-1111-4111-8111-111111111111";
  let upstreamResponse;
  let upstreamClosed = false;
  let requestCount = 0;
  let signalStarted;
  const started = new Promise((resolve) => { signalStarted = resolve; });
  const gateway = await mockServer((request, response) => {
    if (request.method === "GET") {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end('{"ok":true}');
      return;
    }
    requestCount += 1;
    upstreamResponse = response;
    response.once("close", () => { upstreamClosed = true; });
    signalStarted();
  });
  const routerPort = await openPort();
  const router = run({
    CODEX_ROUTER_PORT: String(routerPort),
    CODEX_ROUTER_ACTIVITY_RECORD_RETENTION_MS: "40",
    CODEX_ROUTER_GATEWAY_BASE_URL: `http://127.0.0.1:${gateway.port}/v1`,
    CODEX_ROUTER_OAUTH_HEALTH_URL: `http://127.0.0.1:${gateway.port}/health`,
    CODEX_ROUTER_API_HEALTH_URL: `http://127.0.0.1:${gateway.port}/health`,
    CODEX_ROUTER_GROK_OAUTH_HEALTH_URL: `http://127.0.0.1:${gateway.port}/health`,
    CODEX_ROUTER_GATEWAY_HEALTH_URL: `http://127.0.0.1:${gateway.port}/health`,
  });
  const base = callerBaseUrl(routerPort, CALLER_KEY);
  const controller = new AbortController();
  const snapshot = () => fetch(`${base}/activity?threadId=${threadId}`).then((r) => r.json());
  async function until(predicate) {
    const end = Date.now() + 3_000;
    while (Date.now() < end) {
      const state = await snapshot();
      if (predicate(state)) return state;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.fail(`activity did not reach expected state: ${JSON.stringify(await snapshot())}`);
  }
  let pending;
  try {
    await waitFor(`http://127.0.0.1:${routerPort}/health`, router);
    assert.equal((await fetch(`http://127.0.0.1:${routerPort}/v1/activity`)).status, 401);
    assert.equal((await fetch(`${base}/activity?threadId=invalid%2Fid`)).status, 400);
    pending = fetch(`${base}/responses`, {
      method: "POST", signal: controller.signal,
      headers: { "Content-Type": "application/json", session_id: threadId },
      body: JSON.stringify({ model: "grok-oauth/grok-4.6", stream: true, input: "private-prompt-marker" }),
    }).then(async (response) => { await response.text(); }).catch(() => {});
    await started;
    const quiet = await snapshot();
    assert.equal(quiet.active.length, 1);
    assert.equal(quiet.active[0].phase, "awaiting_upstream");
    assert.equal(quiet.active[0].upstreamAttempts, 1);
    assert.equal(quiet.active[0].lastEventAt, undefined);
    const requestId = quiet.active[0].requestId;
    // Presentation retention must not hide a still-pending operation.
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.equal((await snapshot()).active[0].requestId, requestId);
    upstreamResponse.writeHead(200, { "Content-Type": "text/event-stream" });
    upstreamResponse.write('data: {"type":"response.reasoning_summary_text.delta","item_id":"rs_live","output_index":0,"summary_index":0,"delta":"private-output-marker"}\n\n');
    const generating = await until((s) => s.active[0]?.phase === "reasoning");
    assert.equal(generating.active[0].receivedEvents, 1);
    assert.ok(generating.active[0].lastByteAt >= quiet.active[0].startedAt);
    assert.doesNotMatch(JSON.stringify(generating), /private-prompt-marker|private-output-marker/);
    assert.equal((await fetch(`${base}/activity?threadId=other`).then((r) => r.json())).active.length, 0);
    controller.abort();
    await pending;
    const settled = await until((s) => s.recent.some((r) => r.requestId === requestId));
    assert.equal(settled.active.length, 0);
    assert.equal(settled.recent[0].state, "canceled");
    assert.equal(settled.recent[0].cancelReason, "client_disconnected");
    const closeDeadline = Date.now() + 1_000;
    while (!upstreamClosed && Date.now() < closeDeadline) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(upstreamClosed, true);
    assert.equal(requestCount, 1);
  } finally {
    controller.abort();
    await pending;
    await stopChild(router);
    gateway.server.closeAllConnections?.();
    await closeServer(gateway.server);
  }
});
