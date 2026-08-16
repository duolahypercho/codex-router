import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { callerBaseUrl } from "../src/caller-auth.mjs";
import { openPort } from "./port-pool.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const INTERNAL_KEY = "test-internal-service-key-with-sufficient-length";
const CALLER_KEY = "test-router-caller-capability-with-sufficient-length";

// The model the turn asks for, and the one the router is told to move it to.
// The fallback is named explicitly rather than left to the ranking so the
// assertion does not depend on which providers the developer's own machine has
// credentials for.
const PRIMARY = { slug: "deepseek/deepseek-v4-pro", gatewayModel: "deepseek-v4-pro" };
const FALLBACK = { slug: "zai-api/glm-5.2", gatewayModel: "zai-api-glm-5-2" };

const TURN_BODY = { model: PRIMARY.slug, input: "hello", stream: true };

// Marker text is what proves whose bytes reached the client.
function contentSse(marker) {
  return [
    `data: ${JSON.stringify({ type: "response.created", response: { id: `r-${marker}` } })}`,
    "",
    `data: ${JSON.stringify({
      type: "response.output_text.delta",
      delta: `answered-by-${marker}`,
    })}`,
    "",
    `data: ${JSON.stringify({
      type: "response.completed",
      response: {
        id: `r-${marker}`,
        output: [
          { type: "message", role: "assistant", content: [{ type: "output_text", text: marker }] },
        ],
        usage: { input_tokens: 100, output_tokens: 5, total_tokens: 105 },
      },
    })}`,
    "",
    "data: [DONE]",
    "",
  ].join("\n");
}

const QUOTA_BODY = JSON.stringify({
  error: {
    message:
      "litellm.RateLimitError: RateLimitError: OpenAIException - You have exceeded your current quota, please check your plan and billing details.",
    type: "insufficient_quota",
    code: "429",
  },
});

const BAD_KEY_BODY = JSON.stringify({
  error: { message: "Incorrect API key provided.", type: "invalid_request_error", code: "401" },
});

async function mockServer(handler) {
  const server = http.createServer(handler);
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return { server, port: server.address().port };
}

function gateway(handler) {
  return mockServer((request, response) => {
    if (request.method === "GET" && request.url === "/health") {
      const payload = Buffer.from(JSON.stringify({ ok: true }), "utf8");
      response.writeHead(200, {
        "Content-Type": "application/json",
        "Content-Length": String(payload.length),
      });
      response.end(payload);
      return;
    }
    handler(request, response);
  });
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

function run(env, { chain = [FALLBACK.slug], enabled = true, cooldowns } = {}) {
  const stateDir = mkdtempSync(path.join(os.tmpdir(), "model-failover-router-state-"));
  if (chain !== null) {
    writeFileSync(
      path.join(stateDir, "failover.json"),
      JSON.stringify({ version: 1, enabled, chain }),
      "utf8",
    );
  }
  if (cooldowns) {
    writeFileSync(
      path.join(stateDir, "provider-cooldowns.json"),
      JSON.stringify(cooldowns),
      "utf8",
    );
  }
  // A candidate has to be one the operator could actually reach, and
  // `configuredProviderIds()` only counts a *persistent* credential -- an
  // environment variable deliberately does not qualify. Write the file the
  // provider's registry entry names, so the fallback is credentialed here and
  // nowhere else on the machine.
  writeFileSync(path.join(stateDir, "zai-api-key.secret"), "test-zai-platform-key\n", {
    encoding: "utf8",
    mode: 0o600,
  });
  const child = spawn(process.execPath, [path.join(root, "src", "router.mjs")], {
    cwd: root,
    env: {
      ...process.env,
      MODEL_ROUTER_STATE_DIR: stateDir,
      CODEX_ROUTER_CALLER_KEY: CALLER_KEY,
      CODEX_ROUTER_INTERNAL_KEY: INTERNAL_KEY,
      KIMI_INTERNAL_KEY: INTERNAL_KEY,
      CODEX_ROUTER_SHOW_ALL_MODELS: "1",
      // The failover log line must survive the flag a production LaunchAgent
      // hard-sets, so every test here runs with it on.
      CODEX_ROUTER_QUIET: "1",
      // Makes the fallback provider credentialed without touching a keychain.
      ZAI_PLATFORM_API_KEY: "test-zai-platform-key",
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

function routerEnv(gatewayPort, routerPort) {
  return {
    CODEX_ROUTER_PORT: String(routerPort),
    CODEX_ROUTER_GATEWAY_BASE_URL: `http://127.0.0.1:${gatewayPort}/v1`,
    CODEX_ROUTER_OAUTH_HEALTH_URL: `http://127.0.0.1:${gatewayPort}/health`,
    CODEX_ROUTER_API_HEALTH_URL: `http://127.0.0.1:${gatewayPort}/health`,
    CODEX_ROUTER_GATEWAY_HEALTH_URL: `http://127.0.0.1:${gatewayPort}/health`,
  };
}

function usageEvents(stateDir) {
  const file = path.join(stateDir, "usage-events.jsonl");
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

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
  const deadline = Date.now() + 10_000;
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

function readRouted(port, body) {
  return new Promise((resolve, reject) => {
    const base = new URL(`${callerBaseUrl(port, CALLER_KEY)}/responses`);
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
        const done = () =>
          resolve({
            status: response.statusCode,
            headers: response.headers,
            body: text,
            complete: response.complete,
          });
        response.once("end", done);
        response.once("close", done);
        response.once("error", done);
      },
    );
    request.once("error", reject);
    request.end(JSON.stringify(body));
  });
}

function streamGateway() {
  const seen = [];
  return {
    seen,
    handler: async (request, response, decide) => {
      const body = await bodyJson(request);
      seen.push(body);
      decide(body, response);
    },
  };
}

test("a turn whose provider is out of usage is served by the next model", async () => {
  const seen = [];
  const gw = await gateway(async (request, response) => {
    const body = await bodyJson(request);
    seen.push(body);
    if (body.model === PRIMARY.gatewayModel) {
      const payload = Buffer.from(QUOTA_BODY, "utf8");
      response.writeHead(429, {
        "Content-Type": "application/json",
        "Content-Length": String(payload.length),
      });
      response.end(payload);
      return;
    }
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    response.end(contentSse("fallback"));
  });
  const routerPort = await openPort();
  const child = run(routerEnv(gw.port, routerPort));
  try {
    await waitFor(`http://127.0.0.1:${routerPort}/health`, child);
    const result = await readRouted(routerPort, TURN_BODY);

    // Exactly two upstream attempts: the exhausted model, then the fallback.
    assert.equal(seen.length, 2);
    assert.equal(seen[0].model, PRIMARY.gatewayModel);
    assert.equal(seen[1].model, FALLBACK.gatewayModel);

    // The client saw one clean 200 carrying only the fallback's bytes. The
    // failed attempt must never appear in the stream.
    assert.equal(result.status, 200);
    assert.equal(result.complete, true);
    assert.match(result.body, /answered-by-fallback/);
    assert.doesNotMatch(result.body, /exceeded your current quota/);

    // Both attempts are metered, and the serving row names what was asked for.
    const events = await waitForUsageEvents(child.stateDir, 2, child);
    const failed = events.find((event) => event.model === PRIMARY.slug);
    const served = events.find((event) => event.model === FALLBACK.slug);
    assert.equal(failed.status, 429);
    assert.equal(failed.failoverFrom, undefined);
    assert.equal(served.status, 200);
    assert.equal(served.failoverFrom, PRIMARY.slug);

    // The swap is never silent, even with the quiet flag a LaunchAgent sets.
    assert.match(child.testErrors(), /failover model=deepseek\/deepseek-v4-pro/);
    assert.match(child.testErrors(), /reason=out_of_usage/);
    assert.match(child.testErrors(), /-> zai-api\/glm-5\.2/);
  } finally {
    await stopChild(child);
    await closeServer(gw.server);
  }
});

test("the exhausted provider is skipped outright on the next turn", async () => {
  const seen = [];
  const gw = await gateway(async (request, response) => {
    const body = await bodyJson(request);
    seen.push(body);
    if (body.model === PRIMARY.gatewayModel) {
      // Names when it will be back, which is what the router is allowed to
      // believe. Without this header the next turn must ask again.
      const payload = Buffer.from(QUOTA_BODY, "utf8");
      response.writeHead(429, {
        "Content-Type": "application/json",
        "Retry-After": "1800",
        "Content-Length": String(payload.length),
      });
      response.end(payload);
      return;
    }
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    response.end(contentSse("fallback"));
  });
  const routerPort = await openPort();
  const child = run(routerEnv(gw.port, routerPort));
  try {
    await waitFor(`http://127.0.0.1:${routerPort}/health`, child);
    await readRouted(routerPort, TURN_BODY);
    assert.equal(seen.length, 2);

    const second = await readRouted(routerPort, TURN_BODY);
    // One attempt this time: the cooled-down provider is never contacted.
    assert.equal(seen.length, 3);
    assert.equal(seen[2].model, FALLBACK.gatewayModel);
    assert.equal(second.status, 200);
    assert.match(second.body, /answered-by-fallback/);
    assert.match(child.testErrors(), /reason=cooled_until_/);

    const cooldowns = JSON.parse(
      readFileSync(path.join(child.stateDir, "provider-cooldowns.json"), "utf8"),
    );
    assert.equal(cooldowns.deepseek.reason, "out_of_usage");
    assert.ok(Date.parse(cooldowns.deepseek.until) > Date.now());
  } finally {
    await stopChild(child);
    await closeServer(gw.server);
  }
});

test("a rejected credential keeps its own error and is never swapped away", async () => {
  const seen = [];
  const gw = await gateway(async (request, response) => {
    const body = await bodyJson(request);
    seen.push(body);
    const payload = Buffer.from(BAD_KEY_BODY, "utf8");
    response.writeHead(401, {
      "Content-Type": "application/json",
      "Content-Length": String(payload.length),
    });
    response.end(payload);
  });
  const routerPort = await openPort();
  const child = run(routerEnv(gw.port, routerPort));
  try {
    await waitFor(`http://127.0.0.1:${routerPort}/health`, child);
    const result = await readRouted(routerPort, TURN_BODY);
    // Exactly one attempt, and the operator still reads the real cause.
    assert.equal(seen.length, 1);
    assert.equal(result.status, 401);
    const payload = JSON.parse(result.body);
    assert.equal(payload.error.type, "authentication_error");
    assert.match(payload.error.message, /DeepSeek/i);
    assert.doesNotMatch(child.testErrors(), /failover/);
  } finally {
    await stopChild(child);
    await closeServer(gw.server);
  }
});

test("with nothing eligible the original failure is returned unchanged", async () => {
  const seen = [];
  const gw = await gateway(async (request, response) => {
    const body = await bodyJson(request);
    seen.push(body);
    const payload = Buffer.from(QUOTA_BODY, "utf8");
    response.writeHead(429, {
      "Content-Type": "application/json",
      "Content-Length": String(payload.length),
    });
    response.end(payload);
  });
  const routerPort = await openPort();
  // A chain naming only a model this build cannot route to leaves no candidate.
  const child = run(routerEnv(gw.port, routerPort), { chain: ["gone/removed-model"] });
  try {
    await waitFor(`http://127.0.0.1:${routerPort}/health`, child);
    const result = await readRouted(routerPort, TURN_BODY);
    assert.equal(seen.length, 1);
    assert.equal(result.status, 429);
    const payload = JSON.parse(result.body);
    assert.equal(payload.error.type, "billing_error");
    assert.match(payload.error.message, /run out of usage/i);
    // The turn still says out loud that it looked and found nothing.
    assert.match(child.testErrors(), /failover model=deepseek\/deepseek-v4-pro.*-> none/s);
  } finally {
    await stopChild(child);
    await closeServer(gw.server);
  }
});

test("an operator who turned failover off keeps the plain error", async () => {
  const seen = [];
  const gw = await gateway(async (request, response) => {
    const body = await bodyJson(request);
    seen.push(body);
    const payload = Buffer.from(QUOTA_BODY, "utf8");
    response.writeHead(429, {
      "Content-Type": "application/json",
      "Content-Length": String(payload.length),
    });
    response.end(payload);
  });
  const routerPort = await openPort();
  const child = run(routerEnv(gw.port, routerPort), { enabled: false, chain: [] });
  try {
    await waitFor(`http://127.0.0.1:${routerPort}/health`, child);
    const result = await readRouted(routerPort, TURN_BODY);
    assert.equal(seen.length, 1);
    assert.equal(result.status, 429);
    assert.doesNotMatch(child.testErrors(), /failover/);
  } finally {
    await stopChild(child);
    await closeServer(gw.server);
  }
});

test("a provider that answers again clears the cooldown this router recorded", async () => {
  const seen = [];
  const gw = await gateway(async (request, response) => {
    const body = await bodyJson(request);
    seen.push(body);
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    response.end(contentSse("primary"));
  });
  const routerPort = await openPort();
  const child = run(routerEnv(gw.port, routerPort), {
    // A stale window recorded earlier, for a provider that is in fact fine.
    // With nothing eligible to move to, the turn stays on the operator's own
    // model -- and its success is what retires the window. (A cooldown with a
    // candidate behind it is never probed; it expires on its own clock.)
    chain: ["gone/removed-model"],
    cooldowns: {
      deepseek: {
        until: new Date(Date.now() + 30 * 60_000).toISOString(),
        reason: "out_of_usage",
      },
    },
  });
  try {
    await waitFor(`http://127.0.0.1:${routerPort}/health`, child);
    const result = await readRouted(routerPort, TURN_BODY);
    assert.equal(result.status, 200);
    assert.match(result.body, /answered-by-primary/);
    await waitForUsageEvents(child.stateDir, 1, child);
    const cooldowns = JSON.parse(
      readFileSync(path.join(child.stateDir, "provider-cooldowns.json"), "utf8"),
    );
    assert.equal(cooldowns.deepseek, undefined);
  } finally {
    await stopChild(child);
    await closeServer(gw.server);
  }
});

test("a fallback rebuild carries the full request, not a model swap", async () => {
  // The routed body is rebuilt for the fallback from the pristine payload.
  // The regression this guards is a second build over already-flattened tools,
  // which yields a plausible tool list with an empty namespace map.
  const seen = [];
  const gw = await gateway(async (request, response) => {
    const body = await bodyJson(request);
    seen.push(body);
    if (body.model === PRIMARY.gatewayModel) {
      const payload = Buffer.from(QUOTA_BODY, "utf8");
      response.writeHead(429, {
        "Content-Type": "application/json",
        "Content-Length": String(payload.length),
      });
      response.end(payload);
      return;
    }
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    response.end(contentSse("fallback"));
  });
  const routerPort = await openPort();
  const child = run(routerEnv(gw.port, routerPort));
  try {
    await waitFor(`http://127.0.0.1:${routerPort}/health`, child);
    await readRouted(routerPort, {
      ...TURN_BODY,
      tools: [
        {
          type: "namespace",
          name: "collaboration",
          tools: [
            {
              type: "function",
              name: "spawn_agent",
              description: "Spawn a child agent.",
              parameters: { type: "object", properties: {}, additionalProperties: false },
            },
          ],
        },
      ],
    });
    assert.equal(seen.length, 2);
    const [first, second] = seen;
    // Both attempts flattened the namespace the same way, from the same source.
    const names = (body) => (body.tools || []).map((tool) => tool.name).sort();
    assert.deepEqual(names(second), names(first));
    assert.ok(names(second).includes("collaboration__spawn_agent"));
    // A bare string is as legal an `input` as an array, and the rebuild must
    // hand the fallback the same prompt -- not the same prompt spread into its
    // own letters, which reaches the provider and still reads as a 200.
    assert.equal(first.input, "hello");
    assert.equal(second.input, "hello");
  } finally {
    await stopChild(child);
    await closeServer(gw.server);
  }
});
