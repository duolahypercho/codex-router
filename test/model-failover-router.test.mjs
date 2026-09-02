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
const V2_PRIMARY = { slug: "grok-api/grok-4.5", gatewayModel: "grok-api-grok-4-5" };
const V2_FALLBACK = { slug: "kimi-api/kimi-k3", gatewayModel: "kimi-api-k3" };
const V2_THIRD = { slug: "zai-coding/glm-5.3", gatewayModel: "zai-coding-glm-5-3" };
const GROQ_CANDIDATE = {
  slug: "groq/tool-limit-failover-fixture",
  gatewayModel: "groq-tool-limit-failover-fixture",
  upstreamModel: "openai/gpt-oss-120b",
  provider: "groq",
  listed: true,
  displayName: "Groq tool-limit failover fixture",
  description: "Local routing test fixture.",
  priority: 500,
  defaultEffort: "high",
  reasoningLevels: [{ effort: "high", description: "Adaptive reasoning" }],
  contextWindow: 131_072,
  autoCompact: 111_411,
  inputModalities: ["text"],
  compHash: "groq-tool-limit-failover-fixture-v1",
};
const GENERIC_SEARCH_INCOMPATIBLE = {
  slug: "strict-generic/plain-search-incompatible",
  gatewayModel: "strict-generic-plain-search-incompatible",
  upstreamModel: "plain-search-incompatible",
  provider: "strict-generic",
  listed: true,
  displayName: "Strict generic search-incompatible fixture",
  description: "Local routing test fixture.",
  priority: 501,
  defaultEffort: "high",
  reasoningLevels: [{ effort: "high", description: "Adaptive reasoning" }],
  contextWindow: 131_072,
  autoCompact: 111_411,
  inputModalities: ["text"],
  compHash: "strict-generic-search-incompatible-fixture-v1",
};
// The Go plan route the Zen fixture must stay independent of: a checked-in
// model on the parent provider, credentialed by the same key file.
const GO_PLAN_MODEL = { slug: "opencode-go/glm-5.3", gatewayModel: "opencode-go-glm-5-3" };
const ZEN_CANDIDATE = {
  slug: "opencode-zen/glm-5.3",
  gatewayModel: "opencode-zen-glm-5-3",
  upstreamModel: "glm-5.3",
  provider: "opencode-zen",
  listed: true,
  displayName: "opencode Zen GLM 5.3",
  description: "Local routing test fixture.",
  priority: 502,
  defaultEffort: "high",
  reasoningLevels: [{ effort: "high", description: "Adaptive reasoning" }],
  contextWindow: 131_072,
  autoCompact: 111_411,
  inputModalities: ["text"],
  compHash: "opencode-zen-failover-fixture-v1",
};
const STRICT_GENERIC_PROVIDER = {
  id: "strict-generic",
  displayName: "Strict generic fixture",
  baseUrl: "https://strict.example.test/v1",
  adapter: "openai-chat",
  headers: {},
  allowPrivate: false,
  enabled: true,
};

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

// A burst rate limit rather than an exhausted plan: nothing here reads as
// quota, so the window the provider names in `Retry-After` is the only reason
// the turn is allowed to move.
const BURST_RATE_LIMIT_BODY = JSON.stringify({
  error: {
    message: "Rate limit reached for requests. Please slow down and try again.",
    type: "rate_limit_error",
    code: "429",
  },
});

const FREE_USAGE_BODY = JSON.stringify({
  error: {
    type: "FreeUsageLimitError",
    message: "Rate limit exceeded",
  },
});

const BAD_KEY_BODY = JSON.stringify({
  error: { message: "Incorrect API key provided.", type: "invalid_request_error", code: "401" },
});

const TRANSPORT_BODY = JSON.stringify({
  error: {
    type: "provider_transport_error",
    code: "ECONNRESET",
    message: "The provider connection failed before a response was available.",
  },
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

function run(
  env,
  {
    chain = [FALLBACK.slug],
    enabled = true,
    cooldowns,
    toolResultAging = false,
    userModels,
    genericProviders,
    v2Credentials = false,
  } = {},
) {
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
  if (toolResultAging) {
    writeFileSync(
      path.join(stateDir, "tool-result-aging.json"),
      JSON.stringify({ version: 1, enabled: true, nativeEnabled: false }),
      "utf8",
    );
  }
  if (Array.isArray(userModels)) {
    writeFileSync(
      path.join(stateDir, "user-models.json"),
      JSON.stringify({ version: 1, models: userModels }),
      "utf8",
    );
  }
  if (Array.isArray(genericProviders)) {
    writeFileSync(
      path.join(stateDir, "generic-providers.json"),
      JSON.stringify({ version: 1, providers: genericProviders }),
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
  // The genuinely Responses-native provider used by the protocol-crossing
  // cases. OpenCode Go Responses has a function-only compatibility boundary,
  // so it is no longer a valid exemplar for preserving native namespaces.
  writeFileSync(path.join(stateDir, "meta-api-key.secret"), "test-meta-key\n", {
    encoding: "utf8",
    mode: 0o600,
  });
  // The pressure test deliberately uses Console Go's smaller context window;
  // its request has no tools, so the provider's function-only compatibility
  // boundary is not part of that assertion.
  writeFileSync(path.join(stateDir, "opencode-go-api-key.secret"), "test-opencode-go-key\n", {
    encoding: "utf8",
    mode: 0o600,
  });
  if (userModels?.some((model) => model?.provider === "groq")) {
    writeFileSync(path.join(stateDir, "groq-api-key.secret"), "test-groq-key\n", {
      encoding: "utf8",
      mode: 0o600,
    });
  }
  if (v2Credentials) {
    for (const [file, key] of [
      ["xai-api-key.secret", "test-xai-key"],
      ["kimi-api-key.secret", "test-kimi-key"],
      ["zai-coding-api-key.secret", "test-zai-coding-key"],
    ]) {
      writeFileSync(path.join(stateDir, file), `${key}\n`, {
        encoding: "utf8",
        mode: 0o600,
      });
    }
  }
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
    CODEX_ROUTER_GROK_OAUTH_HEALTH_URL: `http://127.0.0.1:${gatewayPort}/health`,
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

function readRouted(port, body, { endpoint = "/responses", headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const base = new URL(`${callerBaseUrl(port, CALLER_KEY)}${endpoint}`);
    const request = http.request(
      {
        host: "127.0.0.1",
        port,
        path: base.pathname,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer codex-caller-auth",
          ...headers,
        },
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
    assert.match(child.testErrors(), /-> zai-api\/glm-5\.2 outcome=200/);
  } finally {
    await stopChild(child);
    await closeServer(gw.server);
  }
});

test("a marked provider transport failure moves a subagent to a checked-in v2 route", async () => {
  const seen = [];
  const gw = await gateway(async (request, response) => {
    const body = await bodyJson(request);
    seen.push(body);
    if (body.model === V2_PRIMARY.gatewayModel) {
      response.writeHead(502, { "Content-Type": "application/json" });
      response.end(TRANSPORT_BODY);
      return;
    }
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    response.end(contentSse("subagent-transport-fallback"));
  });
  const routerPort = await openPort();
  const child = run(routerEnv(gw.port, routerPort), {
    chain: [V2_FALLBACK.slug],
    v2Credentials: true,
  });
  try {
    await waitFor(`http://127.0.0.1:${routerPort}/health`, child);
    const result = await readRouted(
      routerPort,
      { ...TURN_BODY, model: V2_PRIMARY.slug },
      { headers: { "x-openai-subagent": "review-child" } },
    );

    assert.deepEqual(seen.map((body) => body.model), [
      V2_PRIMARY.gatewayModel,
      V2_FALLBACK.gatewayModel,
    ]);
    assert.equal(result.status, 200);
    assert.match(result.body, /answered-by-subagent-transport-fallback/);
    assert.doesNotMatch(result.body, /provider_transport_error/);
    assert.match(child.testErrors(), /reason=transport/);
  } finally {
    await stopChild(child);
    await closeServer(gw.server);
  }
});

test("subagent transport failover preserves search history execution mode", async () => {
  const seen = [];
  const gw = await gateway(async (request, response) => {
    seen.push(await bodyJson(request));
    response.writeHead(502, { "Content-Type": "application/json" });
    response.end(TRANSPORT_BODY);
  });
  const routerPort = await openPort();
  const child = run(routerEnv(gw.port, routerPort), {
    chain: [V2_FALLBACK.slug],
    v2Credentials: true,
  });
  try {
    await waitFor(`http://127.0.0.1:${routerPort}/health`, child);
    const result = await readRouted(
      routerPort,
      {
        ...TURN_BODY,
        model: V2_THIRD.slug,
        input: [{ type: "web_search_call", id: "search-history" }],
      },
      { headers: { "x-openai-subagent": "review-child" } },
    );

    assert.deepEqual(seen.map((body) => body.model), [V2_THIRD.gatewayModel]);
    assert.equal(result.status, 502);
    assert.match(child.testErrors(), /reason=transport -> none outcome=no-candidate/);
  } finally {
    await stopChild(child);
    await closeServer(gw.server);
  }
});

test("a marked provider transport failure does not move an ordinary turn", async () => {
  const seen = [];
  const gw = await gateway(async (request, response) => {
    seen.push(await bodyJson(request));
    response.writeHead(502, { "Content-Type": "application/json" });
    response.end(TRANSPORT_BODY);
  });
  const routerPort = await openPort();
  const child = run(routerEnv(gw.port, routerPort), {
    chain: [V2_FALLBACK.slug],
    v2Credentials: true,
  });
  try {
    await waitFor(`http://127.0.0.1:${routerPort}/health`, child);
    const result = await readRouted(routerPort, { ...TURN_BODY, model: V2_PRIMARY.slug });

    assert.deepEqual(seen.map((body) => body.model), [V2_PRIMARY.gatewayModel]);
    assert.equal(result.status, 502);
    assert.match(child.testErrors(), /reason=transport -> none outcome=no-candidate/);
  } finally {
    await stopChild(child);
    await closeServer(gw.server);
  }
});

test("a subagent header cannot grant fallback authority to an unverified route", async () => {
  const seen = [];
  const gw = await gateway(async (request, response) => {
    seen.push(await bodyJson(request));
    response.writeHead(502, { "Content-Type": "application/json" });
    response.end(TRANSPORT_BODY);
  });
  const routerPort = await openPort();
  const child = run(routerEnv(gw.port, routerPort), {
    chain: [V2_FALLBACK.slug],
    v2Credentials: true,
  });
  try {
    await waitFor(`http://127.0.0.1:${routerPort}/health`, child);
    const result = await readRouted(
      routerPort,
      TURN_BODY,
      { headers: { "x-openai-subagent": "caller-claimed-child" } },
    );

    assert.deepEqual(seen.map((body) => body.model), [PRIMARY.gatewayModel]);
    assert.equal(result.status, 502);
    assert.match(child.testErrors(), /reason=transport -> none outcome=no-candidate/);
  } finally {
    await stopChild(child);
    await closeServer(gw.server);
  }
});

test("subagent transport failover stops on the first application response", async () => {
  const seen = [];
  const gw = await gateway(async (request, response) => {
    const body = await bodyJson(request);
    seen.push(body);
    if (body.model === V2_PRIMARY.gatewayModel) {
      response.writeHead(502, { "Content-Type": "application/json" });
      response.end(TRANSPORT_BODY);
      return;
    }
    if (body.model === V2_FALLBACK.gatewayModel) {
      response.writeHead(400, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ error: { message: "bad request" } }));
      return;
    }
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    response.end(contentSse("must-not-run"));
  });
  const routerPort = await openPort();
  const child = run(routerEnv(gw.port, routerPort), {
    chain: [V2_FALLBACK.slug, V2_THIRD.slug],
    v2Credentials: true,
  });
  try {
    await waitFor(`http://127.0.0.1:${routerPort}/health`, child);
    const result = await readRouted(
      routerPort,
      { ...TURN_BODY, model: V2_PRIMARY.slug },
      { headers: { "x-openai-subagent": "review-child" } },
    );

    assert.deepEqual(seen.map((body) => body.model), [
      V2_PRIMARY.gatewayModel,
      V2_FALLBACK.gatewayModel,
    ]);
    assert.equal(result.status, 400);
    assert.doesNotMatch(result.body, /must-not-run/);
  } finally {
    await stopChild(child);
    await closeServer(gw.server);
  }
});

test("an exact-route probe never certifies a turn or compaction served by failover", async () => {
  const seen = [];
  const gw = await gateway(async (request, response) => {
    assert.equal(
      request.headers["x-codex-router-exact-route"],
      undefined,
      "the router leaked its local probe control header to the gateway",
    );
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
    response.end(contentSse("fallback-must-not-run"));
  });
  const routerPort = await openPort();
  const child = run(routerEnv(gw.port, routerPort), {
    cooldowns: {
      deepseek: {
        until: new Date(Date.now() + 30 * 60_000).toISOString(),
        reason: "out_of_usage",
      },
    },
  });
  const exactHeaders = { "x-codex-router-exact-route": "1" };
  try {
    await waitFor(`http://127.0.0.1:${routerPort}/health`, child);

    const turn = await readRouted(routerPort, TURN_BODY, { headers: exactHeaders });
    assert.equal(turn.status, 429);
    assert.match(turn.body, /quota|usage|billing/i);

    const compact = await readRouted(
      routerPort,
      {
        model: PRIMARY.slug,
        input: [
          {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "Remember 42." }],
          },
        ],
      },
      { endpoint: "/responses/compact", headers: exactHeaders },
    );
    assert.equal(compact.status, 429);
    assert.match(compact.body, /quota|usage|billing/i);

    assert.deepEqual(
      seen.map((body) => body.model),
      [PRIMARY.gatewayModel, PRIMARY.gatewayModel],
      "the exact-route marker still contacted a fallback model",
    );
    const events = await waitForUsageEvents(child.stateDir, 2, child);
    assert.equal(events.every((event) => event.model === PRIMARY.slug), true);
    assert.equal(events.every((event) => event.failoverFrom === undefined), true);
    assert.doesNotMatch(child.testErrors(), /failover model=/);
  } finally {
    await stopChild(child);
    await closeServer(gw.server);
  }
});

test("the router fails over OpenCode FreeUsageLimitError without leaking the original error", async () => {
  const seen = [];
  const gw = await gateway(async (request, response) => {
    const body = await bodyJson(request);
    seen.push(body);
    if (body.model === PRIMARY.gatewayModel) {
      const payload = Buffer.from(FREE_USAGE_BODY, "utf8");
      response.writeHead(429, {
        "Content-Type": "application/json",
        "Content-Length": String(payload.length),
      });
      response.end(payload);
      return;
    }
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    response.end(contentSse("free-limit-fallback"));
  });
  const routerPort = await openPort();
  const child = run(routerEnv(gw.port, routerPort));
  try {
    await waitFor(`http://127.0.0.1:${routerPort}/health`, child);
    const result = await readRouted(routerPort, TURN_BODY);
    assert.deepEqual(seen.map((body) => body.model), [PRIMARY.gatewayModel, FALLBACK.gatewayModel]);
    assert.equal(result.status, 200);
    assert.match(result.body, /answered-by-free-limit-fallback/);
    assert.doesNotMatch(result.body, /FreeUsageLimitError|Rate limit exceeded/);
    assert.match(child.testErrors(), /failover model=deepseek\/deepseek-v4-pro/);
    const events = await waitForUsageEvents(child.stateDir, 2, child);
    assert.equal(events.find((event) => event.model === PRIMARY.slug).status, 429);
    assert.equal(events.find((event) => event.model === FALLBACK.slug).status, 200);
  } finally {
    await stopChild(child);
    await closeServer(gw.server);
  }
});

test("translates an OpenCode FreeUsageLimitError when no fallback is eligible", async () => {
  const gw = await gateway(async (_request, response) => {
    const payload = Buffer.from(FREE_USAGE_BODY, "utf8");
    response.writeHead(429, {
      "Content-Type": "application/json",
      "Content-Length": String(payload.length),
    });
    response.end(payload);
  });
  const routerPort = await openPort();
  const child = run(routerEnv(gw.port, routerPort), { chain: ["gone/removed-model"] });
  try {
    await waitFor(`http://127.0.0.1:${routerPort}/health`, child);
    const result = await readRouted(routerPort, TURN_BODY);
    assert.equal(result.status, 429);
    const translated = JSON.parse(result.body);
    assert.equal(translated.error.type, "billing_error");
    assert.match(translated.error.message, /run out of usage/i);
    assert.doesNotMatch(result.body, /FreeUsageLimitError/);
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
    assert.match(child.testErrors(), /failover model=deepseek\/deepseek-v4-pro.*-> none outcome=no-candidate/s);
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

test("cooldown failover skips a locally incompatible Groq candidate", async () => {
  const seen = [];
  const gw = await gateway(async (request, response) => {
    const body = await bodyJson(request);
    seen.push(body);
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    response.end(contentSse("safe-candidate"));
  });
  const routerPort = await openPort();
  const child = run(routerEnv(gw.port, routerPort), {
    chain: [GROQ_CANDIDATE.slug, FALLBACK.slug],
    cooldowns: {
      deepseek: {
        until: new Date(Date.now() + 30 * 60_000).toISOString(),
        reason: "out_of_usage",
      },
    },
    userModels: [GROQ_CANDIDATE],
  });
  try {
    await waitFor(`http://127.0.0.1:${routerPort}/health`, child);
    const result = await readRouted(routerPort, {
      ...TURN_BODY,
      tools: Array.from({ length: 129 }, (_, index) => ({
        type: "function",
        name: `client_tool_${index}`,
        parameters: { type: "object" },
      })),
    });
    assert.equal(result.status, 200);
    assert.match(result.body, /answered-by-safe-candidate/);
    assert.equal(seen.length, 1, "neither the cooled route nor rejected Groq candidate is sent");
    assert.equal(seen[0].model, FALLBACK.gatewayModel);

    const logs = child.testErrors();
    assert.match(
      logs,
      /-> groq\/tool-limit-failover-fixture outcome=compatibility\/groq_tool_limit_exceeded/,
    );
    assert.match(logs, /-> zai-api\/glm-5\.2 outcome=swapped/);

    const events = await waitForUsageEvents(child.stateDir, 1, child);
    assert.equal(events.length, 1);
    assert.equal(events[0].model, FALLBACK.slug);
    assert.equal(events[0].provider, "zai-api");
    assert.equal(events[0].failoverFrom, PRIMARY.slug);
    assert.equal(events[0].status, 200);
  } finally {
    await stopChild(child);
    await closeServer(gw.server);
  }
});

test("cooldown failover skips a generic candidate rejected by search compatibility", async () => {
  const seen = [];
  const gw = await gateway(async (request, response) => {
    const body = await bodyJson(request);
    seen.push(body);
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    response.end(contentSse("safe-candidate"));
  });
  const routerPort = await openPort();
  const child = run(routerEnv(gw.port, routerPort), {
    chain: [GENERIC_SEARCH_INCOMPATIBLE.slug, FALLBACK.slug],
    cooldowns: {
      deepseek: {
        until: new Date(Date.now() + 30 * 60_000).toISOString(),
        reason: "out_of_usage",
      },
    },
    userModels: [GENERIC_SEARCH_INCOMPATIBLE],
    genericProviders: [STRICT_GENERIC_PROVIDER],
  });
  try {
    await waitFor(`http://127.0.0.1:${routerPort}/health`, child);
    const result = await readRouted(routerPort, {
      ...TURN_BODY,
      tools: [{ type: "web_search" }],
      tool_choice: "required",
    });
    assert.equal(result.status, 200);
    assert.match(result.body, /answered-by-safe-candidate/);
    assert.equal(seen.length, 1, "neither the cooled route nor rejected generic candidate is sent");
    assert.equal(seen[0].model, FALLBACK.gatewayModel);

    const logs = child.testErrors();
    assert.match(
      logs,
      /-> strict-generic\/plain-search-incompatible outcome=compatibility\/model_search_not_supported/,
    );
    assert.match(logs, /-> zai-api\/glm-5\.2 outcome=swapped/);
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

// -- crossing the protocol line ----------------------------------------------
//
// The rebuild trap in AGENTS.md, exercised. A chat-completions provider needs
// every namespace flattened into ordinary functions; a responses-native one
// needs the namespace shape kept. A failover that crosses that line has to
// rebuild for the *destination*, not reship the first build's tools -- and a
// second pass over an already-flattened list would return an empty namespace
// map, shipping plausible tools the response transform can no longer map back.

const RESPONSES_MODEL = {
  slug: "meta/muse-spark-1.2",
  gatewayModel: "meta-muse-spark-1-2",
};

test("failover keeps the newest tool result exact for the serving model", async () => {
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
    response.end(contentSse("exact-fallback"));
  });
  const routerPort = await openPort();
  const child = run(routerEnv(gw.port, routerPort), {
    chain: [RESPONSES_MODEL.slug],
    toolResultAging: true,
  });
  const value = "repeated candidate progress\n".repeat(12_000);
  const input = [
    { type: "function_call", call_id: "latest", name: "exec_command", arguments: "{}" },
    { type: "function_call_output", call_id: "latest", output: value },
  ];
  try {
    await waitFor(`http://127.0.0.1:${routerPort}/health`, child);
    const result = await readRouted(routerPort, {
      model: PRIMARY.slug,
      stream: true,
      instructions: "Base instructions.",
      input,
    });
    assert.equal(result.status, 200);
    assert.equal(seen.length, 2);
    assert.equal(seen[0].model, PRIMARY.gatewayModel);
    assert.equal(seen[0].input[1].output, value);
    assert.equal(seen[0].instructions, "Base instructions.");
    assert.equal(seen[1].model, RESPONSES_MODEL.gatewayModel);
    assert.equal(seen[1].input[1].output, value);
    assert.equal(seen[1].instructions, "Base instructions.");
    const events = await waitForUsageEvents(child.stateDir, 2, child);
    assert.equal(
      events.find((event) => event.model === RESPONSES_MODEL.slug).toolResultsShaped,
      undefined,
    );
  } finally {
    await stopChild(child);
    await closeServer(gw.server);
  }
});

const NAMESPACE_TOOLS = [
  {
    type: "namespace",
    name: "collaboration",
    tools: [
      {
        type: "function",
        name: "spawn_agent",
        description: "Spawn a child agent.",
        parameters: {
          type: "object",
          properties: { task: { type: "string" } },
          required: ["task"],
          additionalProperties: false,
        },
      },
    ],
  },
];

function toolNames(body) {
  return (body.tools || []).map((tool) => `${tool.type}:${tool.name}`).sort();
}

test("a chat-completions turn failing over to a responses provider keeps the namespace", async () => {
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
    response.end(contentSse("responses-fallback"));
  });
  const routerPort = await openPort();
  const child = run(routerEnv(gw.port, routerPort), { chain: [RESPONSES_MODEL.slug] });
  try {
    await waitFor(`http://127.0.0.1:${routerPort}/health`, child);
    const result = await readRouted(routerPort, { ...TURN_BODY, tools: NAMESPACE_TOOLS });
    assert.equal(result.status, 200);
    assert.equal(seen.length, 2);
    const [first, second] = seen;
    assert.equal(first.model, PRIMARY.gatewayModel);
    assert.equal(second.model, RESPONSES_MODEL.gatewayModel);

    // The chat-completions attempt flattened the namespace into plain functions
    // (alongside the merged codex_app toolset, which only that branch adds).
    assert.ok(toolNames(first).includes("function:collaboration__spawn_agent"));
    assert.ok(!toolNames(first).some((name) => name.startsWith("namespace:")));
    // The responses-native attempt must have been rebuilt from the pristine
    // payload and kept the namespace intact. A flattened name here is the exact
    // regression this guards: the second build reusing the first's rewritten
    // tool list, which also yields an empty namespace map.
    assert.deepEqual(toolNames(second), ["namespace:collaboration"]);
    assert.equal(second.tools[0].tools[0].name, "spawn_agent");
  } finally {
    await stopChild(child);
    await closeServer(gw.server);
  }
});

test("a responses turn failing over to a chat-completions provider flattens it", async () => {
  const seen = [];
  const gw = await gateway(async (request, response) => {
    const body = await bodyJson(request);
    seen.push(body);
    if (body.model === RESPONSES_MODEL.gatewayModel) {
      const payload = Buffer.from(QUOTA_BODY, "utf8");
      response.writeHead(429, {
        "Content-Type": "application/json",
        "Content-Length": String(payload.length),
      });
      response.end(payload);
      return;
    }
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    response.end(contentSse("chat-fallback"));
  });
  const routerPort = await openPort();
  const child = run(routerEnv(gw.port, routerPort), { chain: [FALLBACK.slug] });
  try {
    await waitFor(`http://127.0.0.1:${routerPort}/health`, child);
    const result = await readRouted(routerPort, {
      model: RESPONSES_MODEL.slug,
      input: "hello",
      stream: true,
      tools: NAMESPACE_TOOLS,
    });
    assert.equal(result.status, 200);
    assert.equal(seen.length, 2);
    const [first, second] = seen;
    assert.deepEqual(toolNames(first), ["namespace:collaboration"]);
    // Rebuilt for a chat-completions destination: the namespace is gone and the
    // call is an ordinary function the provider can actually invoke.
    assert.ok(toolNames(second).includes("function:collaboration__spawn_agent"));
    assert.ok(!toolNames(second).some((name) => name.startsWith("namespace:")));
  } finally {
    await stopChild(child);
    await closeServer(gw.server);
  }
});

// A fallback that answers with a flattened tool call. The response transform has
// to map it back to the client's namespace shape using the *fallback's* map and
// slug -- the ones adopted during the swap, not the exhausted model's.
function toolCallSse(name) {
  const args = JSON.stringify({ task: "audit the map" });
  const events = [
    { type: "response.created", response: { id: "r-tool" } },
    {
      type: "response.output_item.added",
      item: { type: "function_call", id: "fc_1", name, arguments: "" },
    },
    { type: "response.function_call_arguments.delta", item_id: "fc_1", delta: args },
    { type: "response.function_call_arguments.done", item_id: "fc_1", arguments: args },
    {
      type: "response.output_item.done",
      item: { type: "function_call", id: "fc_1", name, arguments: args },
    },
    {
      type: "response.completed",
      response: {
        id: "r-tool",
        output: [{ type: "function_call", id: "fc_1", name, arguments: args }],
        usage: { input_tokens: 10, output_tokens: 3, total_tokens: 13 },
      },
    },
  ];
  return `${events
    .map((entry) => `event: ${entry.type}\ndata: ${JSON.stringify(entry)}\n\n`)
    .join("")}data: [DONE]\n\n`;
}

test("a tool call from the fallback is mapped back to the client's namespace", async () => {
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
    response.end(toolCallSse("collaboration__spawn_agent"));
  });
  const routerPort = await openPort();
  const child = run(routerEnv(gw.port, routerPort));
  try {
    await waitFor(`http://127.0.0.1:${routerPort}/health`, child);
    const result = await readRouted(routerPort, { ...TURN_BODY, tools: NAMESPACE_TOOLS });
    assert.equal(result.status, 200);
    assert.equal(seen.length, 2);
    // Restored to the namespaced shape Codex registered, not the flattened name
    // the provider was given. Without the swap adopting the fallback's namespace
    // map, the call would reach the client as `collaboration__spawn_agent` and
    // Codex would reject a tool it never registered.
    assert.match(result.body, /"namespace":"collaboration"/);
    assert.match(result.body, /"name":"spawn_agent"/);
    assert.doesNotMatch(result.body, /"name":"collaboration__spawn_agent"/);
  } finally {
    await stopChild(child);
    await closeServer(gw.server);
  }
});

test("failover walks past a candidate that is also out of usage", async () => {
  const seen = [];
  const gw = await gateway(async (request, response) => {
    const body = await bodyJson(request);
    seen.push(body.model);
    if (body.model === RESPONSES_MODEL.gatewayModel) {
      response.writeHead(200, { "Content-Type": "text/event-stream" });
      response.end(contentSse("second-candidate"));
      return;
    }
    // Both the asked-for model and the first candidate report empty.
    const payload = Buffer.from(QUOTA_BODY, "utf8");
    response.writeHead(429, {
      "Content-Type": "application/json",
      "Content-Length": String(payload.length),
    });
    response.end(payload);
  });
  const routerPort = await openPort();
  const child = run(routerEnv(gw.port, routerPort), {
    chain: [FALLBACK.slug, RESPONSES_MODEL.slug],
  });
  try {
    await waitFor(`http://127.0.0.1:${routerPort}/health`, child);
    const result = await readRouted(routerPort, TURN_BODY);
    assert.equal(result.status, 200);
    assert.match(result.body, /answered-by-second-candidate/);
    // Asked model, first candidate, second candidate -- and no further, because
    // the hop bound stops there.
    assert.deepEqual(seen, [
      PRIMARY.gatewayModel,
      FALLBACK.gatewayModel,
      RESPONSES_MODEL.gatewayModel,
    ]);
    // The candidate that also reported empty is cooled down on its own account.
    const events = await waitForUsageEvents(child.stateDir, 2, child);
    assert.equal(events.at(-1).failoverFrom, PRIMARY.slug);
    assert.equal(events.at(-1).model, RESPONSES_MODEL.slug);
  } finally {
    await stopChild(child);
    await closeServer(gw.server);
  }
});

test("the hop bound stops after two candidates rather than walking the catalog", async () => {
  const seen = [];
  const gw = await gateway(async (request, response) => {
    const body = await bodyJson(request);
    seen.push(body.model);
    const payload = Buffer.from(QUOTA_BODY, "utf8");
    response.writeHead(429, {
      "Content-Type": "application/json",
      "Content-Length": String(payload.length),
    });
    response.end(payload);
  });
  const routerPort = await openPort();
  const child = run(routerEnv(gw.port, routerPort), {
    chain: [FALLBACK.slug, RESPONSES_MODEL.slug, "kimi-api/kimi-k3"],
  });
  try {
    await waitFor(`http://127.0.0.1:${routerPort}/health`, child);
    const result = await readRouted(routerPort, TURN_BODY);
    // Everything failed, so the operator reads the failure their own model gave.
    assert.equal(result.status, 429);
    assert.equal(JSON.parse(result.body).error.type, "billing_error");
    // One asked-for attempt plus at most MAX_FAILOVER_HOPS candidates.
    assert.equal(seen.length, 3);
    assert.equal(seen[0], PRIMARY.gatewayModel);
  } finally {
    await stopChild(child);
    await closeServer(gw.server);
  }
});

test("a non-streaming turn fails over the same way", async () => {
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
    const payload = Buffer.from(
      JSON.stringify({
        id: "r-json",
        object: "response",
        model: body.model,
        output: [
          {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "answered-by-json-fallback" }],
          },
        ],
        usage: { input_tokens: 10, output_tokens: 4, total_tokens: 14 },
      }),
      "utf8",
    );
    response.writeHead(200, {
      "Content-Type": "application/json",
      "Content-Length": String(payload.length),
    });
    response.end(payload);
  });
  const routerPort = await openPort();
  const child = run(routerEnv(gw.port, routerPort));
  try {
    await waitFor(`http://127.0.0.1:${routerPort}/health`, child);
    const result = await readRouted(routerPort, { ...TURN_BODY, stream: false });
    assert.equal(result.status, 200);
    assert.equal(seen.length, 2);
    assert.equal(seen[1].model, FALLBACK.gatewayModel);
    assert.match(result.body, /answered-by-json-fallback/);
  } finally {
    await stopChild(child);
    await closeServer(gw.server);
  }
});

test("a client that leaves mid-failover does not hang or crash the router", async () => {
  let fallbackStarted = 0;
  // Resolved the instant the fallback hop reaches the gateway. The abort has to
  // land *during* that hop, and the only honest way to know the hop is in
  // flight is to be told by the end that received it. A wall-clock delay only
  // guesses at it: on a loaded machine the router had not finished the 429 and
  // reopened against the fallback before the guess expired, so the caller left
  // before there was a failover to leave, and the run failed on
  // `fallbackStarted >= 1` roughly one time in five.
  let announceFallback;
  const fallbackInFlight = new Promise((resolve) => {
    announceFallback = resolve;
  });
  const gw = await gateway(async (request, response) => {
    const body = await bodyJson(request);
    if (body.model === PRIMARY.gatewayModel) {
      const payload = Buffer.from(QUOTA_BODY, "utf8");
      response.writeHead(429, {
        "Content-Type": "application/json",
        "Content-Length": String(payload.length),
      });
      response.end(payload);
      return;
    }
    // The fallback is slow, so the abort lands while the hop is in flight --
    // the window the failover loop has to notice the caller is gone. The hold
    // is far longer than the abort needs, so the abort is inside it whatever
    // the machine is doing.
    fallbackStarted += 1;
    announceFallback();
    setTimeout(() => {
      if (response.writableEnded) return;
      response.writeHead(200, { "Content-Type": "text/event-stream" });
      response.end(contentSse("late"));
    }, 3_000);
  });
  const routerPort = await openPort();
  const child = run(routerEnv(gw.port, routerPort));
  try {
    await waitFor(`http://127.0.0.1:${routerPort}/health`, child);
    const base = new URL(`${callerBaseUrl(routerPort, CALLER_KEY)}/responses`);
    let leave;
    const aborted = new Promise((resolve) => {
      const outbound = http.request(
        {
          host: "127.0.0.1",
          port: routerPort,
          path: base.pathname,
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: "Bearer x" },
        },
        (response) => response.resume(),
      );
      outbound.on("error", () => resolve());
      outbound.end(JSON.stringify(TURN_BODY));
      leave = () => {
        outbound.destroy();
        resolve();
      };
    });
    // Leave as soon as the fallback hop is on the gateway's floor. The deadline
    // is only there so a router that never gets that far fails on the assertion
    // below rather than hanging the run.
    let deadline;
    await Promise.race([
      fallbackInFlight,
      new Promise((resolve) => {
        deadline = setTimeout(resolve, 20_000);
      }),
    ]);
    clearTimeout(deadline);
    leave();
    await aborted;

    // The router must still be serving, and a later turn must behave normally.
    await waitFor(`http://127.0.0.1:${routerPort}/health`, child);
    assert.equal(child.exitCode, null, `router exited: ${child.testErrors()}`);
    assert.ok(fallbackStarted >= 1, "the failover hop should have been attempted");
    // A departed caller meters as 0 rather than as a committed success.
    const events = await waitForUsageEvents(child.stateDir, 1, child);
    assert.ok(events.length >= 1);
    assert.doesNotMatch(child.testErrors(), /UnhandledPromiseRejection|FATAL/);
  } finally {
    await stopChild(child);
    await closeServer(gw.server);
  }
});

test("a rate limit that names its window as an HTTP-date still fails over", async () => {
  // RFC 9110 lets `Retry-After` be an HTTP-date as well as delay-seconds, and a
  // gateway in front of an origin sends the date form. Read as a bare number it
  // is NaN, which the classifier discards -- so the turn used to die on a
  // provider that had said exactly when it would be back, and every later turn
  // paid the same refusal again because no cooldown was recorded either.
  const seen = [];
  const gw = await gateway(async (request, response) => {
    const body = await bodyJson(request);
    seen.push(body);
    if (body.model === PRIMARY.gatewayModel) {
      const payload = Buffer.from(BURST_RATE_LIMIT_BODY, "utf8");
      response.writeHead(429, {
        "Content-Type": "application/json",
        "Retry-After": new Date(Date.now() + 30 * 60_000).toUTCString(),
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
    assert.equal(result.status, 200);
    assert.match(result.body, /answered-by-fallback/);
    assert.equal(seen.length, 2);
    assert.equal(seen[1].model, FALLBACK.gatewayModel);

    // The named window is believed, so the next turn skips the limited
    // provider instead of spending another round trip on the same refusal.
    const cooldowns = JSON.parse(
      readFileSync(path.join(child.stateDir, "provider-cooldowns.json"), "utf8"),
    );
    assert.equal(cooldowns.deepseek.reason, "rate_limited");
    assert.ok(Date.parse(cooldowns.deepseek.until) > Date.now());
    const second = await readRouted(routerPort, TURN_BODY);
    assert.equal(second.status, 200);
    assert.equal(seen.length, 3);
    assert.equal(seen[2].model, FALLBACK.gatewayModel);
  } finally {
    await stopChild(child);
    await closeServer(gw.server);
  }
});

test("a closed Go plan window does not withdraw the separately billed Zen route", async () => {
  // opencode Zen shares Go's credential and selection toggle, so its provider
  // id resolves to `opencode-go` everywhere selection is concerned. Its bill
  // does not: Zen is metered at its own endpoint. A window recorded for the Go
  // plan used to withdraw Zen too, and the operator's chosen model was
  // silently answered by a different provider.
  const seen = [];
  const gw = await gateway(async (request, response) => {
    const body = await bodyJson(request);
    seen.push(body.model);
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    response.end(contentSse(body.model));
  });
  const routerPort = await openPort();
  const child = run(routerEnv(gw.port, routerPort), {
    userModels: [ZEN_CANDIDATE],
    cooldowns: {
      "opencode-go": {
        until: new Date(Date.now() + 30 * 60_000).toISOString(),
        reason: "out_of_usage",
      },
    },
  });
  try {
    await waitFor(`http://127.0.0.1:${routerPort}/health`, child);
    const zen = await readRouted(routerPort, { ...TURN_BODY, model: ZEN_CANDIDATE.slug });
    assert.equal(zen.status, 200);
    assert.match(zen.body, new RegExp(`answered-by-${ZEN_CANDIDATE.gatewayModel}`));
    assert.deepEqual(seen, [ZEN_CANDIDATE.gatewayModel]);
    assert.doesNotMatch(child.testErrors(), /cooled_until_/);

    // The plan the window was actually recorded for is still skipped: a
    // protocol variant is the same subscription, and this test must not pass
    // by disabling cooldowns.
    const go = await readRouted(routerPort, { ...TURN_BODY, model: GO_PLAN_MODEL.slug });
    assert.equal(go.status, 200);
    assert.equal(seen.length, 2);
    assert.equal(seen[1], FALLBACK.gatewayModel);
    assert.match(child.testErrors(), /cooled_until_/);
  } finally {
    await stopChild(child);
    await closeServer(gw.server);
  }
});

test("an exhausted Zen balance cools Zen rather than the Go subscription", async () => {
  const seen = [];
  const gw = await gateway(async (request, response) => {
    const body = await bodyJson(request);
    seen.push(body.model);
    if (body.model === ZEN_CANDIDATE.gatewayModel) {
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
    response.end(contentSse(body.model));
  });
  const routerPort = await openPort();
  const child = run(routerEnv(gw.port, routerPort), { userModels: [ZEN_CANDIDATE] });
  try {
    await waitFor(`http://127.0.0.1:${routerPort}/health`, child);
    const zen = await readRouted(routerPort, { ...TURN_BODY, model: ZEN_CANDIDATE.slug });
    assert.equal(zen.status, 200);
    assert.deepEqual(seen, [ZEN_CANDIDATE.gatewayModel, FALLBACK.gatewayModel]);

    const cooldowns = JSON.parse(
      readFileSync(path.join(child.stateDir, "provider-cooldowns.json"), "utf8"),
    );
    assert.equal(cooldowns["opencode-zen"].reason, "out_of_usage");
    assert.equal(cooldowns["opencode-go"], undefined);

    // The Go plan was never asked about, so it is still served.
    const go = await readRouted(routerPort, { ...TURN_BODY, model: GO_PLAN_MODEL.slug });
    assert.equal(go.status, 200);
    assert.equal(seen.at(-1), GO_PLAN_MODEL.gatewayModel);
  } finally {
    await stopChild(child);
    await closeServer(gw.server);
  }
});

test("a rate limit with no usable window asks for patience", async () => {
  // Two ways a 429 can carry no wait worth quoting, and they used to be the
  // same bug in opposite directions. `headers.get()` answers null for a header
  // that was never sent and `Number(null)` is 0 -- finite, so the translated
  // error advised retrying "in about 0s". An explicit `Retry-After: 0` is a
  // real answer the parser now keeps as 0, and it must reach the operator as
  // the same patient sentence rather than as that rounding-bug wording.
  const gw = await gateway(async (request, response) => {
    const body = await bodyJson(request);
    const payload = Buffer.from(BURST_RATE_LIMIT_BODY, "utf8");
    response.writeHead(429, {
      "Content-Type": "application/json",
      "Content-Length": String(payload.length),
      // The first turn sends no header at all; the second names zero.
      ...(body.instructions === "zero" ? { "Retry-After": "0" } : {}),
    });
    response.end(payload);
  });
  const routerPort = await openPort();
  const child = run(routerEnv(gw.port, routerPort), { enabled: false, chain: [] });
  try {
    await waitFor(`http://127.0.0.1:${routerPort}/health`, child);
    for (const instructions of ["absent", "zero"]) {
      const result = await readRouted(routerPort, { ...TURN_BODY, instructions });
      assert.equal(result.status, 429);
      const message = JSON.parse(result.body).error.message;
      assert.match(message, /Wait a bit and retry\./);
      assert.doesNotMatch(message, /Retry in about 0s/);
    }
  } finally {
    await stopChild(child);
    await closeServer(gw.server);
  }
});
