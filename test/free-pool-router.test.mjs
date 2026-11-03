import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { callerBaseUrl, cursorCliBaseUrl } from "../src/caller-auth.mjs";
import { STATIC_FREE_POOL_CATALOG, freePoolMemberModels } from "../src/free-pool-catalog.mjs";
import { openPort } from "./port-pool.mjs";

// free/auto end to end against a mock gateway: the pool's own entry first,
// then each member in order, with drains persisted between turns and the
// mid-stream rule (nothing switches once text has reached the client).

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const INTERNAL_KEY = "test-internal-service-key-with-sufficient-length";
const CALLER_KEY = "test-router-caller-capability-with-sufficient-length";

const POOL = { slug: "free/auto", gatewayModel: "free-auto" };
const MEMBERS = freePoolMemberModels(STATIC_FREE_POOL_CATALOG);
const ORDER = [POOL, ...MEMBERS];

function contentSse(marker) {
  return [
    `data: ${JSON.stringify({ type: "response.created", response: { id: `r-${marker}` } })}`,
    "",
    `data: ${JSON.stringify({ type: "response.output_text.delta", delta: `answered-by-${marker}` })}`,
    "",
    `data: ${JSON.stringify({
      type: "response.completed",
      response: {
        id: `r-${marker}`,
        output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: marker }] }],
        usage: { input_tokens: 100, output_tokens: 5, total_tokens: 105 },
      },
    })}`,
    "",
    "data: [DONE]",
    "",
  ].join("\n");
}

async function gateway(handler) {
  const server = http.createServer((request, response) => {
    if (request.method === "GET" && request.url === "/health") {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ ok: true }));
      return;
    }
    handler(request, response);
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return { server, port: server.address().port };
}

function bodyJson(request) {
  return new Promise((resolve) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        resolve({});
      }
    });
  });
}

function jsonError(response, status, body, headers = {}) {
  const payload = Buffer.from(JSON.stringify(body), "utf8");
  response.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": String(payload.length),
    ...headers,
  });
  response.end(payload);
}

function run(gatewayPort, routerPort, { env = {}, drains } = {}) {
  const stateDir = mkdtempSync(path.join(os.tmpdir(), "free-pool-router-state-"));
  if (drains) {
    writeFileSync(path.join(stateDir, "free-pool-drains.json"), JSON.stringify({ version: 1, drains }), "utf8");
  }
  const child = spawn(process.execPath, [path.join(root, "src", "router.mjs")], {
    cwd: root,
    env: {
      ...process.env,
      MODEL_ROUTER_STATE_DIR: stateDir,
      CODEX_ROUTER_STATE_DIR: stateDir,
      CODEX_HOME: path.join(stateDir, "codex"),
      CODEX_ROUTER_CALLER_KEY: CALLER_KEY,
      CODEX_ROUTER_INTERNAL_KEY: INTERNAL_KEY,
      KIMI_INTERNAL_KEY: INTERNAL_KEY,
      CODEX_ROUTER_SHOW_ALL_MODELS: "1",
      CODEX_ROUTER_QUIET: "1",
      MODEL_ROUTER_FREE_POOL_REFRESH: "0",
      CODEX_ROUTER_PORT: String(routerPort),
      CODEX_ROUTER_GATEWAY_BASE_URL: `http://127.0.0.1:${gatewayPort}/v1`,
      CODEX_ROUTER_API_BASE_URL: `http://127.0.0.1:${gatewayPort}/v1`,
      CODEX_ROUTER_OAUTH_HEALTH_URL: `http://127.0.0.1:${gatewayPort}/health`,
      CODEX_ROUTER_API_HEALTH_URL: `http://127.0.0.1:${gatewayPort}/health`,
      CODEX_ROUTER_GROK_OAUTH_HEALTH_URL: `http://127.0.0.1:${gatewayPort}/health`,
      CODEX_ROUTER_GATEWAY_HEALTH_URL: `http://127.0.0.1:${gatewayPort}/health`,
      MODEL_ROUTER_ANTIGRAVITY_OAUTH_PORT: String(gatewayPort),
      MODEL_ROUTER_DEVIN_CLI_PORT: String(gatewayPort),
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
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Child exited early (${child.exitCode}): ${child.testErrors()}`);
    try {
      if ((await fetch(url)).ok) return;
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

function usageEvents(stateDir) {
  const file = path.join(stateDir, "usage-events.jsonl");
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

async function waitForUsage(stateDir, predicate, child) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const events = usageEvents(stateDir);
    if (predicate(events)) return events;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for usage rows: ${JSON.stringify(usageEvents(stateDir))} ${child.testErrors()}`);
}

function drainsOf(stateDir) {
  const file = path.join(stateDir, "free-pool-drains.json");
  return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")).drains : {};
}

function readRouted(port, body, { endpoint = "/responses" } = {}) {
  return new Promise((resolve, reject) => {
    const base = new URL(endpoint.startsWith("/cursor/")
      ? `${cursorCliBaseUrl(port, CALLER_KEY)}${endpoint}`
      : `${callerBaseUrl(port, CALLER_KEY)}${endpoint}`);
    const request = http.request(
      {
        host: "127.0.0.1",
        port,
        path: base.pathname,
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer codex-caller-auth" },
      },
      (response) => {
        let text = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => {
          text += chunk;
        });
        const done = () => resolve({ status: response.statusCode, body: text });
        response.once("end", done);
        response.once("close", done);
        response.once("error", done);
      },
    );
    request.once("error", reject);
    request.end(JSON.stringify(body));
  });
}

const TURN = { model: POOL.slug, input: "hello", stream: true };

async function withRouter(handler, options, body) {
  const seen = [];
  const gw = await gateway(async (request, response) => {
    const payload = await bodyJson(request);
    seen.push(payload.model);
    handler(payload, response, seen);
  });
  const routerPort = await openPort();
  const child = run(gw.port, routerPort, options);
  try {
    await waitFor(`http://127.0.0.1:${routerPort}/health`, child);
    await body({ routerPort, child, seen });
  } finally {
    await stopChild(child);
    await new Promise((resolve) => gw.server.close(resolve));
    rmSync(child.stateDir, { recursive: true, force: true });
  }
}

test("free/auto walks members in order past 429, quota and 5xx, drains them, and records every hop", async () => {
  await withRouter((payload, response) => {
    if (payload.model === ORDER[0].gatewayModel) {
      jsonError(response, 429, { error: { message: "Rate limit reached" } }, { "Retry-After": "90" });
    } else if (payload.model === ORDER[1].gatewayModel) {
      jsonError(response, 429, { error: { type: "FreeUsageLimitError", message: "free usage limit exceeded" } });
    } else if (payload.model === ORDER[2].gatewayModel) {
      jsonError(response, 503, { error: { message: "no upstreams available for this model" } });
    } else {
      response.writeHead(200, { "Content-Type": "text/event-stream" });
      response.end(contentSse(payload.model));
    }
  }, {}, async ({ routerPort, child, seen }) => {
    const result = await readRouted(routerPort, TURN);
    assert.equal(result.status, 200, result.body);
    assert.match(result.body, new RegExp(`answered-by-${ORDER[3].gatewayModel}`));
    assert.deepEqual(seen, ORDER.slice(0, 4).map((model) => model.gatewayModel));

    const drains = drainsOf(child.stateDir);
    assert.equal(drains[ORDER[0].slug].reason, "rate_limited");
    assert.equal(drains[ORDER[0].slug].status, 429);
    assert.equal(drains[ORDER[1].slug].reason, "free_quota");
    assert.equal(drains[ORDER[2].slug].reason, "model_unavailable");
    assert.equal(drains[ORDER[3].slug], undefined);

    const events = await waitForUsage(child.stateDir, (rows) => rows.some((row) => row.status === 200), child);
    const pool = events.filter((row) => row.freePool === "free/auto");
    assert.deepEqual(pool.map((row) => [row.model, row.status]), [
      [ORDER[0].slug, 429],
      [ORDER[1].slug, 429],
      [ORDER[2].slug, 503],
      [ORDER[3].slug, 200],
    ]);
    assert.deepEqual(pool.slice(0, 3).map((row) => row.freePoolReason), ["rate_limited", "free_quota", "model_unavailable"]);
    assert.equal(pool[3].failoverFrom, ORDER[0].slug);
    assert.equal(pool[3].inputTokens, 100);
    assert.equal(pool[3].outputTokens, 5);
    // The pool never writes the shared provider cooldown file.
    assert.equal(existsSync(path.join(child.stateDir, "provider-cooldowns.json")), false);

    // The next turn starts at the first member that is not drained.
    seen.length = 0;
    const again = await readRouted(routerPort, TURN);
    assert.equal(again.status, 200);
    assert.deepEqual(seen, [ORDER[3].gatewayModel]);
  });
});

test("free/auto never switches once text has streamed", async () => {
  await withRouter((payload, response) => {
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    response.write(`data: ${JSON.stringify({ type: "response.created", response: { id: "r-partial" } })}\n\n`);
    response.write(`data: ${JSON.stringify({ type: "response.output_text.delta", delta: `partial-from-${payload.model}` })}\n\n`);
    setTimeout(() => {
      response.write(`data: ${JSON.stringify({ type: "response.failed", response: { id: "r-partial", status: "failed", error: { code: "rate_limit_exceeded", message: "Rate limit reached" } } })}\n\n`);
      response.end();
    }, 50);
  }, {}, async ({ routerPort, child, seen }) => {
    const result = await readRouted(routerPort, TURN);
    assert.match(result.body, new RegExp(`partial-from-${POOL.gatewayModel}`));
    assert.deepEqual(seen, [POOL.gatewayModel]);
    for (const member of MEMBERS) assert.doesNotMatch(result.body, new RegExp(`partial-from-${member.gatewayModel}`));
    assert.deepEqual(drainsOf(child.stateDir), {});
  });
});

test("a plain request rejection is returned as-is instead of walking the pool", async () => {
  await withRouter((payload, response) => {
    jsonError(response, 400, { error: { message: "invalid tool schema", type: "invalid_request_error" } });
  }, {}, async ({ routerPort, child, seen }) => {
    const result = await readRouted(routerPort, TURN);
    assert.equal(result.status, 400);
    assert.deepEqual(seen, [POOL.gatewayModel]);
    assert.deepEqual(drainsOf(child.stateDir), {});
  });
});

test("when every member is drained free/auto answers a clear 429 and records it", async () => {
  await withRouter((payload, response) => {
    jsonError(response, 429, { error: { message: "free usage limit exceeded" } });
  }, {}, async ({ routerPort, child, seen }) => {
    const result = await readRouted(routerPort, TURN);
    assert.equal(result.status, 429);
    const error = JSON.parse(result.body).error;
    assert.equal(error.code, "free_pool_exhausted");
    assert.match(error.message, /free\/auto/);
    assert.ok(error.retry_at);
    assert.deepEqual(seen, ORDER.map((model) => model.gatewayModel));
    assert.equal(Object.keys(drainsOf(child.stateDir)).length, ORDER.length);

    // Already drained: the next turn fails fast without touching upstream.
    seen.length = 0;
    const fast = await readRouted(routerPort, TURN);
    assert.equal(fast.status, 429);
    assert.equal(JSON.parse(fast.body).error.code, "free_pool_exhausted");
    assert.deepEqual(seen, []);
    const events = await waitForUsage(
      child.stateDir,
      (rows) => rows.filter((row) => row.freePoolReason === "exhausted").length >= 2,
      child,
    );
    assert.equal(events.filter((row) => row.freePoolReason === "exhausted").length, 2);
  });
});

test("a member drained by an earlier run is skipped, and the prefer override reorders the pool", async () => {
  const until = new Date(Date.now() + 600_000).toISOString();
  await withRouter((payload, response) => {
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    response.end(contentSse(payload.model));
  }, {
    drains: { [POOL.slug]: { until, reason: "rate_limited", status: 429 } },
    env: { MODEL_ROUTER_FREE_POOL_PREFER: MEMBERS[2].upstreamModel },
  }, async ({ routerPort, seen }) => {
    const result = await readRouted(routerPort, TURN);
    assert.equal(result.status, 200);
    assert.deepEqual(seen, [MEMBERS[2].gatewayModel]);
  });
});

test("Chat Completions with model free/auto uses the same pool", async () => {
  await withRouter((payload, response) => {
    if (payload.model === POOL.gatewayModel) {
      jsonError(response, 503, { error: { message: "upstream overloaded" } });
      return;
    }
    if (payload.stream) {
      response.writeHead(200, { "Content-Type": "text/event-stream" });
      response.end(contentSse(payload.model));
      return;
    }
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({
      id: `r-${payload.model}`,
      object: "response",
      status: "completed",
      output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: `answered-by-${payload.model}` }] }],
      usage: { input_tokens: 100, output_tokens: 5, total_tokens: 105 },
    }));
  }, {}, async ({ routerPort, seen }) => {
    const result = await readRouted(
      routerPort,
      { model: POOL.slug, messages: [{ role: "user", content: "hello" }], stream: false },
      { endpoint: "/cursor/v1/chat/completions" },
    );
    assert.equal(result.status, 200, result.body);
    const body = JSON.parse(result.body);
    assert.match(body.choices[0].message.content, new RegExp(MEMBERS[0].gatewayModel));
    assert.deepEqual(seen, [POOL.gatewayModel, MEMBERS[0].gatewayModel]);
  });
});

test("the OpenAI-compatible model list offers free/auto and none of its members", async () => {
  await withRouter(() => {}, {}, async ({ routerPort }) => {
    const response = await fetch(`${cursorCliBaseUrl(routerPort, CALLER_KEY)}/cursor/v1/models`, {
      headers: { Authorization: "Bearer codex-caller-auth" },
    });
    assert.equal(response.status, 200);
    const ids = (await response.json()).data.map((model) => model.id);
    assert.ok(ids.some((id) => id.includes("free_auto")), ids.join(", "));
    for (const member of MEMBERS) {
      const fragment = member.slug.replace(/[^a-z0-9]+/gi, "_").toLowerCase();
      assert.equal(ids.some((id) => id.includes(fragment)), false, `${member.slug} leaked: ${ids.join(", ")}`);
    }
  });
});
