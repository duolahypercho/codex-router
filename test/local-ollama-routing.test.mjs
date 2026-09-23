import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import http from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { callerBaseUrl } from "../src/caller-auth.mjs";
import { openPort } from "./port-pool.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const INTERNAL_KEY = "test-internal-service-key-with-sufficient-length";
const CALLER_KEY = "test-router-caller-capability-with-sufficient-length";
const LOCAL_SLUG = "local/qwen3.8:27b-mlx";
const LOCAL_GATEWAY_MODEL = "local-qwen3-8-27b-mlx";

function localFixture() {
  const directory = mkdtempSync(path.join(os.tmpdir(), "local-ollama-route-"));
  const userModels = path.join(directory, "user-models.json");
  writeFileSync(
    userModels,
    JSON.stringify({
      version: 1,
      models: [
        {
          slug: LOCAL_SLUG,
          gatewayModel: LOCAL_GATEWAY_MODEL,
          upstreamModel: "qwen3.8:27b-mlx",
          provider: "local",
          listed: true,
          displayName: "Qwen3.8 27B MLX (local, experimental)",
          description: "Test fixture.",
          priority: 900,
          defaultEffort: "high",
          reasoningLevels: [{ effort: "high", description: "Adaptive reasoning" }],
          contextWindow: 32768,
          autoCompact: 28000,
          inputModalities: ["text"],
          supportsApplyPatchTool: false,
          multiAgentVersion: "v1",
          compHash: "local-qwen3-8-27b-mlx-user-v1",
        },
      ],
    }),
    { encoding: "utf8", mode: 0o600 },
  );
  writeFileSync(
    path.join(directory, "enabled-providers.json"),
    `${JSON.stringify({ version: 1, providers: ["local"] })}\n`,
    { encoding: "utf8", mode: 0o600 },
  );
  return { directory, userModels };
}

function json(response, status, payload) {
  const body = Buffer.from(JSON.stringify(payload), "utf8");
  response.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": String(body.length),
  });
  response.end(body);
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

function startRouter(fixture, gatewayPort, routerPort) {
  const child = spawn(process.execPath, [path.join(root, "src", "router.mjs")], {
    cwd: root,
    env: {
      ...process.env,
      CODEX_ROUTER_CALLER_KEY: CALLER_KEY,
      CODEX_ROUTER_INTERNAL_KEY: INTERNAL_KEY,
      KIMI_INTERNAL_KEY: INTERNAL_KEY,
      CODEX_ROUTER_PORT: String(routerPort),
      CODEX_ROUTER_STATE_DIR: fixture.directory,
      MODEL_ROUTER_USER_MODELS: fixture.userModels,
      CODEX_ROUTER_GATEWAY_BASE_URL: `http://127.0.0.1:${gatewayPort}/v1`,
      CODEX_ROUTER_OAUTH_HEALTH_URL: `http://127.0.0.1:${gatewayPort}/health`,
      CODEX_ROUTER_API_HEALTH_URL: `http://127.0.0.1:${gatewayPort}/health`,
      CODEX_ROUTER_GROK_OAUTH_HEALTH_URL: `http://127.0.0.1:${gatewayPort}/health`,
      CODEX_ROUTER_GATEWAY_HEALTH_URL: `http://127.0.0.1:${gatewayPort}/health`,
      CODEX_ROUTER_QUIET: "1",
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

async function waitForRouter(port, child) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`Router exited early (${child.exitCode}): ${child.testErrors()}`);
    }
    try {
      const response = await fetch(`${callerBaseUrl(port, CALLER_KEY)}/models`);
      if (response.ok) return;
    } catch {
      // It has not bound the port yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for router: ${child.testErrors()}`);
}

async function stop(child, server) {
  if (child.exitCode === null && child.signalCode === null) {
    child.kill("SIGTERM");
    await new Promise((resolve) => child.once("exit", resolve));
  }
  await new Promise((resolve) => server.close(resolve));
}

test("local LiteLLM routes are single-shot Ollama-native deployments", () => {
  const fixture = localFixture();
  try {
    const result = spawnSync(
      process.execPath,
      [
        "-e",
        "import('./src/litellm-config.mjs').then(({renderLiteLlmConfig}) => process.stdout.write(renderLiteLlmConfig()))",
      ],
      {
        cwd: root,
        encoding: "utf8",
        env: { ...process.env, MODEL_ROUTER_USER_MODELS: fixture.userModels },
      },
    );
    assert.equal(result.status, 0, result.stderr);
    const marker = `model_name: \"${LOCAL_GATEWAY_MODEL}\"`;
    assert.equal(result.stdout.split(marker).length - 1, 1, "the local model was deployed twice");
    const block = result.stdout.slice(result.stdout.indexOf(marker));
    assert.match(block, /model: "ollama_chat\/qwen3\.8:27b-mlx"/);
    assert.match(block, /num_ctx: 16384/);
    assert.match(block, /num_retries: 0/);
  } finally {
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test("the router forwards one local input and one tool definition without tag-specific expansion", async () => {
  const fixture = localFixture();
  const requests = [];
  const gateway = await mockServer(async (request, response) => {
    if (request.method === "GET") {
      json(response, 200, { ok: true });
      return;
    }
    requests.push(await bodyJson(request));
    json(response, 200, { id: "resp_local", object: "response", status: "completed", output: [] });
  });
  const routerPort = await openPort();
  const router = startRouter(fixture, gateway.port, routerPort);
  try {
    await waitForRouter(routerPort, router);
    const inputMarker = "LOCAL_INPUT_MARKER_67f16b";
    const instructionMarker = "LOCAL_INSTRUCTION_MARKER_713c2a";
    const toolMarker = "LOCAL_TOOL_MARKER_8df411";
    const response = await fetch(`${callerBaseUrl(routerPort, CALLER_KEY)}/responses`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: LOCAL_SLUG,
        instructions: instructionMarker,
        reasoning: { effort: "high" },
        input: [
          {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: inputMarker }],
          },
        ],
        tools: [
          {
            type: "function",
            name: "local_payload_probe",
            description: toolMarker,
            parameters: { type: "object", properties: {} },
          },
        ],
      }),
    });
    assert.equal(response.status, 200, router.testErrors());
    assert.equal(requests.length, 1);
    const forwarded = requests[0];
    assert.equal(forwarded.model, LOCAL_GATEWAY_MODEL);
    assert.equal(forwarded.instructions, instructionMarker);
    assert.deepEqual(forwarded.input, [
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: inputMarker }],
      },
    ]);
    assert.equal(forwarded.tools.filter((tool) => tool?.name === "local_payload_probe").length, 1);
    assert.equal(forwarded.reasoning, undefined, "Ollama must not receive Codex's reasoning object");
    const serialized = JSON.stringify(forwarded);
    for (const marker of [inputMarker, instructionMarker, toolMarker]) {
      assert.equal(serialized.split(marker).length - 1, 1, `${marker} was expanded or duplicated`);
    }
  } finally {
    await stop(router, gateway.server);
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test("an Ollama context rejection reaches Codex once as context_length_exceeded", async () => {
  const fixture = localFixture();
  let requests = 0;
  const gateway = await mockServer(async (request, response) => {
    if (request.method === "GET") {
      json(response, 200, { ok: true });
      return;
    }
    await bodyJson(request);
    requests += 1;
    json(response, 500, {
      error: {
        message:
          "litellm.APIConnectionError: APIConnectionError: OllamaException - input length (269931 tokens) exceeds the model's maximum context length (262144 tokens). LiteLLM Retried: 2 times",
        code: "500",
      },
    });
  });
  const routerPort = await openPort();
  const router = startRouter(fixture, gateway.port, routerPort);
  try {
    await waitForRouter(routerPort, router);
    const response = await fetch(`${callerBaseUrl(routerPort, CALLER_KEY)}/responses`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: LOCAL_SLUG, input: "hello" }),
    });
    assert.equal(response.status, 400, router.testErrors());
    assert.equal(requests, 1, "the deterministic rejection was retried by the router");
    const payload = await response.json();
    assert.equal(payload.error.type, "invalid_request_error");
    assert.equal(payload.error.code, "context_length_exceeded");
    assert.equal(payload.error.param, "input");
    assert.match(payload.error.message, /^Ollama could not run/);
    assert.match(payload.error.message, /269,931 tokens/);
    assert.match(payload.error.message, /not high demand/);
  } finally {
    await stop(router, gateway.server);
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test("compaction requests to keyless providers also drop reasoning flags", async () => {
  const fixture = localFixture();
  const requests = [];
  const gateway = await mockServer(async (request, response) => {
    if (request.method === "GET") {
      json(response, 200, { ok: true });
      return;
    }
    requests.push(await bodyJson(request));
    json(response, 200, { id: "resp_compact", object: "response", status: "completed", output: [] });
  });
  const routerPort = await openPort();
  const router = startRouter(fixture, gateway.port, routerPort);
  try {
    await waitForRouter(routerPort, router);
    const response = await fetch(`${callerBaseUrl(routerPort, CALLER_KEY)}/responses/compact`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: LOCAL_SLUG,
        reasoning: { effort: "high" },
        reasoning_effort: "high",
        input: "Compaction test input.",
      }),
    });
    assert.equal(response.status, 200, router.testErrors());
    assert.equal(requests.length, 1);
    const forwarded = requests[0];
    assert.equal(forwarded.reasoning, undefined, "Ollama must not receive Codex's reasoning object on compaction");
    assert.equal(forwarded.reasoning_effort, undefined, "Ollama must not receive Codex's reasoning_effort on compaction");

  } finally {
    await stop(router, gateway.server);
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});