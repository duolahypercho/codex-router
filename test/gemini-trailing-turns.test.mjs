import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import http from "node:http";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { callerBaseUrl } from "../src/caller-auth.mjs";
import { openPort } from "./port-pool.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const INTERNAL_KEY = "test-internal-service-key-with-sufficient-length";
const CALLER_KEY = "test-router-caller-capability-with-sufficient-length";

function json(response, status, payload) {
  response.writeHead(status, { "Content-Type": "application/json" });
  response.end(JSON.stringify(payload));
}

async function bodyJson(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

async function mockServer(handler) {
  const server = http.createServer(handler);
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return { server, port: server.address().port };
}

function run(script, env) {
  const child = spawn(process.execPath, [path.join(ROOT, "src", script)], {
    cwd: ROOT,
    env: {
      ...process.env,
      CODEX_ROUTER_CALLER_KEY: CALLER_KEY,
      CODEX_ROUTER_INTERNAL_KEY: INTERNAL_KEY,
      KIMI_INTERNAL_KEY: INTERNAL_KEY,
      CODEX_ROUTER_SHOW_ALL_MODELS: "1",
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
  return child;
}

async function waitFor(url, child, headers = {}) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`Child exited early (${child.exitCode}): ${child.testErrors()}`);
    }
    try {
      const response = await fetch(url, { headers });
      if (response.ok) return;
    } catch {
      // The child has not bound its port yet.
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

function curatedModels(genericBaseUrl = "https://generic-google.example.test/v1") {
  const dir = mkdtempSync(path.join(os.tmpdir(), "gemini-trailing-turns-"));
  const file = path.join(dir, "user-models.json");
  const providersFile = path.join(dir, "generic-providers.json");
  const model = ({ provider, id, gatewayModel, upstreamModel, requiresTrailingUserTurn }) => ({
    slug: `${provider}/${id}`,
    gatewayModel,
    upstreamModel,
    provider,
    listed: true,
    displayName: `${id} (curated)`,
    description: "Test fixture.",
    priority: 500,
    defaultEffort: "high",
    reasoningLevels: [{ effort: "high", description: "Adaptive reasoning" }],
    contextWindow: 131072,
    autoCompact: 110000,
    inputModalities: ["text"],
    compHash: `${gatewayModel}-user-v1`,
    ...(requiresTrailingUserTurn === undefined ? {} : { requiresTrailingUserTurn }),
  });
  // No identifier says Gemini here: the official provider identity is the
  // only reason this route is destructive.
  const official = model({
    provider: "gemini-api",
    id: "opaque-official",
    gatewayModel: "google-opaque-gateway",
    upstreamModel: "google/opaque-model",
  });
  // A reseller may opt in after proving its endpoint rejects a trailing model
  // turn, even when all of its identifiers are aliases.
  const optedIn = model({
    provider: "openrouter",
    id: "opaque-opt-in",
    gatewayModel: "openrouter-opaque-opt-in",
    upstreamModel: "reseller/opaque-model",
    requiresTrailingUserTurn: true,
  });
  // The broad Gemini classifier still sees this name for non-destructive
  // compatibility transforms, but it must not discard conversation history.
  const namedReseller = model({
    provider: "openrouter",
    id: "gemini-named",
    gatewayModel: "openrouter-GEMINI-named",
    upstreamModel: "reseller/opaque-model",
  });
  const other = model({
    provider: "openrouter",
    id: "plain",
    gatewayModel: "openrouter-plain",
    upstreamModel: "reseller/plain-model",
  });
  // Generic provider identity is operator-owned. A valid id that happens to
  // match a built-in provider's `ownedBy` value must not inherit that
  // provider's destructive compatibility behavior.
  const genericGoogle = model({
    provider: "google",
    id: "ordinary-generic",
    gatewayModel: "google-ordinary-generic",
    upstreamModel: "vendor/ordinary-generic",
  });
  const claude55 = ["opus", "sonnet", "haiku"].map((family) => {
    const id = `claude-${family}-5-5`;
    return model({
      provider: "anthropic-api",
      id,
      gatewayModel: `anthropic-api-${id}`,
      upstreamModel: id,
    });
  });
  writeFileSync(
    file,
    JSON.stringify({
      version: 1,
      models: [official, optedIn, namedReseller, other, genericGoogle, ...claude55],
    }),
    "utf8",
  );
  writeFileSync(
    providersFile,
    JSON.stringify({
      version: 1,
      providers: [{
        id: "google",
        displayName: "Operator Google Alias",
        baseUrl: genericBaseUrl,
        adapter: "openai-chat",
        headers: {},
        allowPrivate: genericBaseUrl.startsWith("http://127.0.0.1:"),
        enabled: true,
      }],
    }),
    "utf8",
  );
  return {
    dir,
    file,
    providersFile,
    official: { gateway: official.gatewayModel, slug: official.slug },
    optedIn: { gateway: optedIn.gatewayModel, slug: optedIn.slug },
    namedReseller: { gateway: namedReseller.gatewayModel, slug: namedReseller.slug },
    other: { gateway: other.gatewayModel, slug: other.slug },
    genericGoogle: { gateway: genericGoogle.gatewayModel, slug: genericGoogle.slug },
    claude55: claude55.map((entry) => ({ gateway: entry.gatewayModel, slug: entry.slug })),
  };
}

test("API forwarder trims strict-provider and Anthropic 5.5 trailing model turns", async () => {
  const upstreamRequests = [];
  const upstream = await mockServer(async (request, response) => {
    upstreamRequests.push(await bodyJson(request));
    json(response, 200, { choices: [] });
  });
  const models = curatedModels(`http://127.0.0.1:${upstream.port}/v1`);
  const stateDir = mkdtempSync(path.join(os.tmpdir(), "gemini-forwarder-state-"));
  const forwarderPort = await openPort();
  const forwarder = run("api-forwarder.mjs", {
    CODEX_ROUTER_API_PORT: String(forwarderPort),
    MODEL_ROUTER_STATE_DIR: stateDir,
    MODEL_ROUTER_GENERIC_PROVIDERS: models.providersFile,
    MODEL_ROUTER_USER_MODELS: models.file,
    OPENROUTER_API_BASE_URL: `http://127.0.0.1:${upstream.port}`,
    OPENROUTER_API_KEY: "TEST_OPENROUTER_API_KEY",
    GEMINI_API_BASE_URL: `http://127.0.0.1:${upstream.port}`,
    GEMINI_API_KEY: "TEST_GEMINI_API_KEY",
    ANTHROPIC_API_BASE_URL: `http://127.0.0.1:${upstream.port}/v1`,
    ANTHROPIC_API_KEY: "TEST_ANTHROPIC_API_KEY",
    CODEX_ROUTER_QUIET: "1",
  });

  async function forward(model, route = "/chat/completions") {
    const response = await fetch(`http://127.0.0.1:${forwarderPort}/v1${route}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${INTERNAL_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: "user", content: "hello" },
          { role: "assistant", content: "interrupted answer" },
        ],
      }),
    });
    assert.equal(response.status, 200, forwarder.testErrors());
  }

  try {
    await waitFor(`http://127.0.0.1:${forwarderPort}/health`, forwarder, {
      Authorization: `Bearer ${INTERNAL_KEY}`,
    });
    await forward(models.official.gateway);
    assert.deepEqual(upstreamRequests.at(-1).messages, [{ role: "user", content: "hello" }]);

    await forward(models.optedIn.gateway);
    assert.deepEqual(upstreamRequests.at(-1).messages, [{ role: "user", content: "hello" }]);

    await forward(models.namedReseller.gateway);
    assert.deepEqual(upstreamRequests.at(-1).messages, [
      { role: "user", content: "hello" },
      { role: "assistant", content: "interrupted answer" },
    ]);

    await forward(models.other.gateway);
    assert.deepEqual(upstreamRequests.at(-1).messages, [
      { role: "user", content: "hello" },
      { role: "assistant", content: "interrupted answer" },
    ]);

    await forward(models.genericGoogle.gateway);
    assert.deepEqual(upstreamRequests.at(-1).messages, [
      { role: "user", content: "hello" },
      { role: "assistant", content: "interrupted answer" },
    ]);
    for (const model of models.claude55) {
      await forward(model.gateway, "/messages");
      assert.deepEqual(upstreamRequests.at(-1).messages, [{ role: "user", content: "hello" }]);
    }
  } finally {
    await stopChild(forwarder);
    await closeServer(upstream.server);
    rmSync(models.dir, { recursive: true, force: true });
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("router trims strict-provider and Anthropic 5.5 trailing Responses model turns", async () => {
  const gatewayRequests = [];
  const healthRequests = [];
  const gateway = await mockServer(async (request, response) => {
    if (request.method === "GET" && request.url?.endsWith("-health")) {
      healthRequests.push(request.url);
      json(response, 200, { ok: true });
      return;
    }
    gatewayRequests.push(await bodyJson(request));
    json(response, 200, { id: "resp_test", object: "response", output: [] });
  });
  const models = curatedModels();
  const stateDir = mkdtempSync(path.join(os.tmpdir(), "gemini-router-state-"));
  writeFileSync(
    path.join(stateDir, "enabled-providers.json"),
    `${JSON.stringify({ version: 1, providers: [] })}\n`,
  );
  const routerPort = await openPort();
  const router = run("router.mjs", {
    CODEX_ROUTER_PORT: String(routerPort),
    CODEX_ROUTER_SHOW_ALL_MODELS: "0",
    MODEL_ROUTER_STATE_DIR: stateDir,
    MODEL_ROUTER_GENERIC_PROVIDERS: models.providersFile,
    MODEL_ROUTER_USER_MODELS: models.file,
    CODEX_ROUTER_GATEWAY_BASE_URL: `http://127.0.0.1:${gateway.port}/v1`,
    CODEX_ROUTER_API_HEALTH_URL: `http://127.0.0.1:${gateway.port}/api-health`,
    CODEX_ROUTER_GATEWAY_HEALTH_URL: `http://127.0.0.1:${gateway.port}/gateway-health`,
    CODEX_ROUTER_QUIET: "1",
  });

  async function route(model) {
    const response = await fetch(`${callerBaseUrl(routerPort, CALLER_KEY)}/responses`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        input: [
          {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "hello" }],
          },
          {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "interrupted answer" }],
          },
        ],
      }),
    });
    assert.equal(response.status, 200, router.testErrors());
  }

  try {
    await waitFor(`${callerBaseUrl(routerPort, CALLER_KEY)}/models`, router);
    const health = await fetch(`${callerBaseUrl(routerPort, CALLER_KEY)}/health`);
    const healthPayload = await health.json();
    assert.equal(health.status, 200, JSON.stringify(healthPayload));
    assert.equal(healthPayload.api.reachable, true);
    assert.ok(healthRequests.includes("/api-health"));
    writeFileSync(
      path.join(stateDir, "enabled-providers.json"),
      `${JSON.stringify({ version: 1, providers: ["gemini-api", "openrouter", "anthropic-api"] })}\n`,
    );

    await route(models.official.slug);
    assert.deepEqual(gatewayRequests.at(-1).input, [
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "hello" }],
      },
    ]);

    await route(models.optedIn.slug);
    assert.deepEqual(gatewayRequests.at(-1).input, [
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "hello" }],
      },
    ]);

    await route(models.namedReseller.slug);
    assert.equal(gatewayRequests.at(-1).input.length, 2);
    assert.equal(gatewayRequests.at(-1).input.at(-1).role, "assistant");

    await route(models.other.slug);
    assert.equal(gatewayRequests.at(-1).input.length, 2);
    assert.equal(gatewayRequests.at(-1).input.at(-1).role, "assistant");

    await route(models.genericGoogle.slug);
    assert.equal(gatewayRequests.at(-1).input.length, 2);
    assert.equal(gatewayRequests.at(-1).input.at(-1).role, "assistant");
    for (const model of models.claude55) {
      await route(model.slug);
      assert.deepEqual(gatewayRequests.at(-1).input, [
        {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "hello" }],
        },
      ]);
    }
  } finally {
    await stopChild(router);
    await closeServer(gateway.server);
    rmSync(models.dir, { recursive: true, force: true });
    rmSync(stateDir, { recursive: true, force: true });
  }
});
