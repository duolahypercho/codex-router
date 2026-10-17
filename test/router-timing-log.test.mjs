import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, existsSync, readFileSync, rmSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { callerBaseUrl } from "../src/caller-auth.mjs";
import { GROK_TIMING_HEADER } from "../src/grok-request-timing.mjs";
import { EXACT_ROUTE_PROBE_HEADER } from "../src/exact-route-probe.mjs";
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
  const stateDir = mkdtempSync(path.join(os.tmpdir(), "router-timing-state-"));
  const child = spawn(process.execPath, [path.join(root, "src", "router.mjs")], {
    cwd: root,
    env: {
      ...process.env,
      MODEL_ROUTER_STATE_DIR: stateDir,
      CODEX_ROUTER_CALLER_KEY: CALLER_KEY,
      CODEX_ROUTER_INTERNAL_KEY: INTERNAL_KEY,
      KIMI_INTERNAL_KEY: INTERNAL_KEY,
      CODEX_ROUTER_SHOW_ALL_MODELS: "1",
      // The production LaunchAgent hard-sets CODEX_ROUTER_QUIET=1; the timing
      // line must fire anyway, so the test runs in that exact mode.
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
  if (child.exitCode !== null || child.signalCode !== null) {
    rmSync(child.stateDir, { recursive: true, force: true });
    return;
  }
  child.kill("SIGTERM");
  await new Promise((resolve) => child.once("exit", resolve));
  // The spawned router writes usage events into a per-run state dir; once the
  // process is gone nothing reads it again, so take the temp root with it.
  rmSync(child.stateDir, { recursive: true, force: true });
}

async function closeServer(server) {
  await new Promise((resolve) => server.close(resolve));
}

function routerEnv(gatewayPort, routerPort) {
  return {
    CODEX_ROUTER_PORT: String(routerPort),
    CODEX_ROUTER_GATEWAY_BASE_URL: `http://127.0.0.1:${gatewayPort}/v1`,
    CODEX_ROUTER_OAUTH_HEALTH_URL: `http://127.0.0.1:${gatewayPort}/health`,
    CODEX_ROUTER_API_HEALTH_URL: `http://127.0.0.1:${gatewayPort}/health`,
    CODEX_ROUTER_GROK_OAUTH_HEALTH_URL: `http://127.0.0.1:${gatewayPort}/health`,
    CODEX_ROUTER_GATEWAY_HEALTH_URL: `http://127.0.0.1:${gatewayPort}/health`,
  };
}

function routedRequest(port, input) {
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
        response.resume();
        const done = () => resolve(response.statusCode);
        response.once("end", done);
        response.once("close", done);
        response.once("error", done);
      },
    );
    request.once("error", reject);
    request.end(
      JSON.stringify({ model: "deepseek/deepseek-v4-pro", input, stream: true }),
    );
  });
}

async function waitForTimings(child, count) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const lines = child.testErrors().match(/\[codex-router\] timing [^\n]+/g) || [];
    if (lines.length >= count) return lines;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for ${count} timing lines: ${child.testErrors()}`);
}

test("every routed turn writes a timestamped timing line with cache tokens", async () => {
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
    const completed = {
      type: "response.completed",
      response: {
        id: "resp_timing",
        usage: {
          input_tokens: 100,
          output_tokens: 5,
          total_tokens: 105,
          input_tokens_details: { cached_tokens: 90 },
        },
      },
    };
    response.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8" });
    response.end(
      `event: response.output_text.delta\ndata: ${JSON.stringify({ type: "response.output_text.delta", delta: "ok" })}\n\n` +
        `event: response.completed\ndata: ${JSON.stringify(completed)}\n\ndata: [DONE]\n\n`,
    );
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
    const base = new URL(`${callerBaseUrl(routerPort, CALLER_KEY)}/responses`);
    await new Promise((resolve, reject) => {
      const request = http.request(
        {
          host: "127.0.0.1",
          port: routerPort,
          path: base.pathname,
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: "Bearer codex-caller-auth",
          },
        },
        (response) => {
          response.resume();
          response.once("end", resolve);
        },
      );
      request.once("error", reject);
      request.end(
        JSON.stringify({ model: "deepseek/deepseek-v4-pro", input: "hello", stream: true }),
      );
    });

    const deadline = Date.now() + 5_000;
    while (!/\[codex-router\] timing /.test(router.testErrors()) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    const timing = router.testErrors().match(/\[codex-router\] timing [^\n]+/)?.[0];
    assert.ok(timing, `timing line missing; stderr: ${router.testErrors()}`);
    // The line is timestamped and carries every field needed to answer "who
    // is slow": total wall time, time until the upstream answered, output
    // tokens, and the provider's own reported cache hits.
    assert.match(timing, /at=\d{4}-\d{2}-\d{2}T/);
    assert.match(timing, /total_ms=\d+/);
    assert.match(timing, /upstream_ms=\d+/);
    assert.match(timing, /out_tokens=5/);
    assert.match(timing, /cached_tokens=90/);
    const [usageEvent] = readFileSync(
      path.join(router.stateDir, "usage-events.jsonl"),
      "utf8",
    )
      .trim()
      .split("\n")
      .map(JSON.parse);
    assert.ok(usageEvent.responseStartMs >= 0);
    assert.ok(usageEvent.responseStartMs <= usageEvent.durationMs);
  } finally {
    await stopChild(router);
    await closeServer(gateway.server);
  }
});

test("timing covers non-2xx, thrown fetch, and mid-stream failures", async () => {
  const gateway = await mockServer(async (request, response) => {
    if (request.method === "GET" && request.url === "/health") {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ ok: true }));
      return;
    }
    let raw = "";
    for await (const chunk of request) raw += chunk;
    const input = JSON.parse(raw).input;
    if (input === "explicit-zero") {
      response.writeHead(200, { "Content-Type": "text/event-stream" });
      response.end(
        'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"ok"}\n\n' +
          'event: response.completed\ndata: {"type":"response.completed","response":{"output":[],"usage":{"input_tokens":4,"output_tokens":0,"total_tokens":4,"input_tokens_details":{"cached_tokens":0}}}}\n\ndata: [DONE]\n\n',
      );
      return;
    }
    if (input === "non-2xx") {
      response.writeHead(429, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ error: { message: "limited" } }));
      return;
    }
    if (input === "thrown") {
      response.socket.destroy();
      return;
    }
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    response.write(
      'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"partial"}\n\n',
    );
    setTimeout(() => response.destroy(), 20);
  });
  const routerPort = await openPort();
  const router = run(routerEnv(gateway.port, routerPort));

  try {
    await waitFor(`${callerBaseUrl(routerPort, CALLER_KEY)}/models`, router);

    assert.equal(await routedRequest(routerPort, "explicit-zero"), 200);
    let timings = await waitForTimings(router, 1);
    assert.match(timings[0], /status=200 .*out_tokens=0 cached_tokens=0/);

    assert.equal(await routedRequest(routerPort, "non-2xx"), 429);
    timings = await waitForTimings(router, 2);
    assert.match(timings[1], /status=429 .*upstream_ms=\d+/);
    assert.match(timings[1], /out_tokens=unknown cached_tokens=unknown/);

    assert.equal(await routedRequest(routerPort, "thrown"), 502);
    timings = await waitForTimings(router, 3);
    assert.match(timings[2], /status=502 .*upstream_ms=\d+/);
    assert.match(timings[2], /out_tokens=unknown cached_tokens=unknown/);

    await routedRequest(routerPort, "stream-fail");
    timings = await waitForTimings(router, 4);
    assert.match(timings[3], /status=502 .*upstream_ms=\d+/);
    assert.match(timings[3], /out_tokens=unknown cached_tokens=unknown/);

    const health = await fetch(`http://127.0.0.1:${routerPort}/health`);
    assert.equal((await health.json()).activity.state, "error");
  } finally {
    await stopChild(router);
    await closeServer(gateway.server);
  }
});

test("Grok compaction shares reasoning, correlation and measured stages, including failure, skip and cancellation", async () => {
  let mode = "success";
  const requests = [];
  let received;
  const gateway = await mockServer(async (request, response) => {
    if (request.method === "GET") return response.end('{}');
    let raw = "";
    for await (const chunk of request) raw += chunk;
    requests.push(JSON.parse(raw));
    received?.();
    if (mode === "cancel") return;
    if (mode === "failure") {
      response.writeHead(400, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ error: { message: "synthetic compaction rejection" } }));
      return;
    }
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ object: "response", status: "completed", output: [
      { type: "message", role: "assistant", content: [{ type: "output_text", text: "synthetic summary" }] },
    ], usage: { input_tokens: 150, output_tokens: 5, total_tokens: 155 } }));
  });
  const routerPort = await openPort();
  const router = run(routerEnv(gateway.port, routerPort));
  const base = callerBaseUrl(routerPort, CALLER_KEY);
  const timings = () => router.testErrors().split("\n").filter(line => line.startsWith("[grok-timing] "))
    .map(line => JSON.parse(line.slice("[grok-timing] ".length)));
  const usage = () => {
    const file = path.join(router.stateDir, "usage-events.jsonl");
    if (!existsSync(file)) return [];
    const text = readFileSync(file, "utf8");
    return text.slice(0, text.lastIndexOf("\n")).split("\n").filter(Boolean).map(JSON.parse);
  };
  async function recorded(count) {
    const deadline = Date.now() + 5000;
    while ((timings().length < count || usage().length < count) && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.equal(timings().length, count, router.testErrors());
    assert.equal(usage().length, count);
    return { timing: timings().at(-1), row: usage().at(-1) };
  }
  function compact({ v2 = true, stream = false, content = "short history", ...extra } = {}, signal) {
    return fetch(`${base}/responses${v2 ? "" : "/compact"}`, {
      method: "POST", headers: { "Content-Type": "application/json", [EXACT_ROUTE_PROBE_HEADER]: "1" }, signal,
      body: JSON.stringify({ model: "grok-oauth/grok-4.7", stream,
        tools: [{ type: "function", name: "write_stdin", parameters: { type: "object", properties: { session_id: { type: "integer" } } } }],
        input: [{ type: "message", role: "user", content }, ...(v2 ? [{ type: "compaction_trigger" }] : [])],
        extra_headers: { [GROK_TIMING_HEADER]: "forged" }, ...extra }),
    });
  }
  try {
    await waitFor(`${base}/models`, router);
    let count = 0;
    for (const options of [
      { v2: false, reasoning: { effort: "medium", summary: "detailed" } },
      { reasoning_effort: "high" },
      { stream: true },
    ]) {
      const response = await compact(options);
      const body = await response.text();
      assert.equal(response.status, 200, body);
      const { timing, row } = await recorded(++count);
      const sent = requests.at(-1);
      assert.equal(timing.requestId, row.requestId);
      assert.equal(sent.extra_headers[GROK_TIMING_HEADER], row.requestId);
      assert.deepEqual(sent.extra_body?.reasoning_effort, options.reasoning ?? options.reasoning_effort);
      assert.deepEqual(sent.tools, [], "a summary never dispatches client tools");
      assert.equal(sent.tool_choice, "none", "a summary also forbids ambient hosted tools");
      assert.equal(timing.requestKind, "compaction");
      assert.equal(row.requestKind, "compaction");
      assert.equal(row.providerToolCount, 0);
      assert.equal(row.generationOutcome, "completed");
      assert.equal(row.httpStatus, 200);
      assert.equal(timing.toolSurfaces.client.known.write_stdin.count, 1);
      assert.equal(timing.toolSurfaces.gateway.count, 0);
      assert.ok(timing.preparedMs >= timing.parsedMs);
      assert.ok(timing.firstGatewayDispatchMs >= timing.preparedMs);
      assert.ok(timing.firstGatewayHeadersMs >= timing.firstGatewayDispatchMs);
      assert.ok(timing.terminalMs >= timing.firstGatewayHeadersMs);
      assert.equal(timing.terminal, "completed");
      assert.doesNotMatch(JSON.stringify({ timing, row }), /short history|synthetic summary|forged/);
    }
    mode = "failure";
    const failed = await compact({ stream: true });
    await failed.text();
    const failure = await recorded(++count);
    assert.equal(failure.row.generationOutcome, "failed");
    assert.equal(failure.row.httpStatus, failed.status);
    assert.equal(failure.timing.terminal, "failed");
    assert.ok(failure.timing.terminalMs >= failure.timing.firstGatewayHeadersMs);
    assert.equal((await (await fetch(`http://127.0.0.1:${routerPort}/health`)).json()).activity.state, "error");

    // A skip has no provider work. It must not fabricate dispatch/headers.
    const requestsBefore = requests.length;
    const skipped = await compact({ content: "history ".repeat(5000) });
    assert.equal(skipped.status, 200, await skipped.text());
    const skip = await recorded(++count);
    assert.equal(requests.length, requestsBefore);
    assert.equal(skip.timing.requestKind, "compaction");
    assert.equal(skip.timing.terminal, "completed");
    assert.equal(skip.timing.firstGatewayDispatchMs, undefined);
    assert.equal(skip.row.generationOutcome, "completed");

    mode = "cancel";
    const controller = new AbortController();
    const dispatched = new Promise(resolve => { received = resolve; });
    const pending = compact({}, controller.signal);
    const cancelled = assert.rejects(pending, { name: "AbortError" });
    await dispatched;
    controller.abort();
    await cancelled;
    const cancel = await recorded(++count);
    assert.equal(cancel.row.generationOutcome, "canceled");
    assert.equal(cancel.timing.outcome, "connection_closed");
    assert.equal(cancel.timing.terminal, undefined);
    assert.equal(cancel.timing.firstGatewayHeadersMs, undefined);
    assert.ok(Number.isInteger(cancel.timing.firstGatewayDispatchMs));
  } finally {
    await stopChild(router);
    gateway.server.closeAllConnections();
    await closeServer(gateway.server);
  }
});
