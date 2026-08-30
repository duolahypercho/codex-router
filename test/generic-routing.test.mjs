import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { userModelEntry } from "../src/user-models.mjs";
import { openPort } from "./port-pool.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const INTERNAL_KEY = "generic-routing-internal-key-with-sufficient-length";

function json(response, status, payload) {
  const body = Buffer.from(JSON.stringify(payload), "utf8");
  response.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": String(body.length),
  });
  response.end(body);
}

async function requestJson(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

async function listen(handler) {
  const server = http.createServer(handler);
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return { server, port: address.port };
}

async function close(server) {
  await new Promise((resolve) => server.close(resolve));
}

function runForwarder(env) {
  const child = spawn(process.execPath, [path.join(root, "src", "api-forwarder.mjs")], {
    cwd: root,
    env: {
      ...process.env,
      MODEL_ROUTER_TARGET: "codex",
      MODEL_ROUTER_INTERNAL_KEY: INTERNAL_KEY,
      MODEL_ROUTER_QUIET: "1",
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

async function waitForForwarder(port, child) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`Forwarder exited early (${child.exitCode}): ${child.testErrors()}`);
    }
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`, {
        headers: { Authorization: `Bearer ${INTERNAL_KEY}` },
      });
      if (response.ok) return;
    } catch {
      // Listener is not ready yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Forwarder did not become healthy: ${child.testErrors()}`);
}

async function stop(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  await new Promise((resolve) => child.once("exit", resolve));
}

test("one generic gateway routes ordinary and explicitly profiled models without inference", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "generic-routing-"));
  const providersFile = path.join(directory, "generic-providers.json");
  const userModelsFile = path.join(directory, "user-models.json");
  const stateDir = path.join(directory, "state");
  const upstreamRequests = [];
  const upstream = await listen(async (request, response) => {
    upstreamRequests.push({
      url: request.url,
      headers: request.headers,
      body: await requestJson(request),
    });
    json(response, 200, {
      id: `chatcmpl-${upstreamRequests.length}`,
      object: "chat.completion",
      model: upstreamRequests.at(-1).body.model,
      choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
    });
  });
  const ordinary = userModelEntry({
    providerId: "mixed-gateway",
    upstreamId: "gemini-named-but-ordinary",
    priority: 100,
  });
  const profiled = userModelEntry({
    providerId: "mixed-gateway",
    upstreamId: "strict-profiled-model",
    requestProfile: "codex-encrypted-schema",
    priority: 101,
  });
  const autoToolChoice = userModelEntry({
    providerId: "mixed-gateway",
    upstreamId: "auto-tool-choice-model",
    requestProfile: "auto-tool-choice",
    priority: 102,
  });
  writeFileSync(providersFile, `${JSON.stringify({
    version: 1,
    providers: [{
      id: "mixed-gateway",
      displayName: "Mixed Gateway",
      baseUrl: `http://127.0.0.1:${upstream.port}/v1`,
      adapter: "openai-chat",
      headers: { "X-Tenant": "operator-owned" },
      allowPrivate: true,
      enabled: true,
    }],
  }, null, 2)}\n`);
  writeFileSync(userModelsFile, `${JSON.stringify({
    version: 1,
    models: [ordinary, profiled, autoToolChoice],
  }, null, 2)}\n`);
  const forwarderPort = await openPort();
  const forwarder = runForwarder({
    MODEL_ROUTER_API_PORT: String(forwarderPort),
    MODEL_ROUTER_STATE_DIR: stateDir,
    MODEL_ROUTER_GENERIC_PROVIDERS: providersFile,
    MODEL_ROUTER_USER_MODELS: userModelsFile,
  });
  const schema = {
    type: "object",
    encrypted: true,
    properties: {
      value: { type: "string", encrypted: true },
      encrypted: {
        type: "object",
        properties: { retained: { type: "boolean" } },
      },
    },
    required: ["value", "encrypted"],
  };

  try {
    await waitForForwarder(forwarderPort, forwarder);
    const health = await fetch(`http://127.0.0.1:${forwarderPort}/health`, {
      headers: { Authorization: `Bearer ${INTERNAL_KEY}` },
    });
    assert.equal(health.status, 200);
    assert.deepEqual((await health.json()).providers["mixed-gateway"], {
      generic: true,
      credential_present: true,
      credential_source: "not required",
    });
    for (const model of [ordinary, profiled, autoToolChoice]) {
      const response = await fetch(`http://127.0.0.1:${forwarderPort}/v1/chat/completions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${INTERNAL_KEY}`,
          "Content-Type": "application/json",
          "X-Tenant": "caller-must-not-win",
          "X-Ordinary-Metadata": "kept",
        },
        body: JSON.stringify({
          model: model.gatewayModel,
          messages: [{ role: "user", content: "Use the tool." }],
          web_search_options: { search_context_size: "medium" },
          tools: [{
            type: "function",
            function: { name: "inspect", description: "Inspect data.", parameters: schema },
          }, { type: "web_search" }],
          tool_choice: "required",
        }),
      });
      assert.equal(response.status, 200, forwarder.testErrors());
      assert.equal((await response.json()).choices[0].message.content, "ok");
    }

    assert.equal(upstreamRequests.length, 3);
    assert.ok(upstreamRequests.every((entry) => entry.url === "/v1/chat/completions"));
    assert.ok(upstreamRequests.every((entry) => entry.headers.authorization === undefined));
    assert.ok(upstreamRequests.every((entry) => entry.headers["x-tenant"] === "operator-owned"));
    assert.ok(upstreamRequests.every((entry) => entry.headers["x-ordinary-metadata"] === "kept"));
    assert.equal(upstreamRequests[0].body.model, ordinary.upstreamModel);
    assert.deepEqual(upstreamRequests[0].body.web_search_options, {
      search_context_size: "medium",
    });
    assert.deepEqual(upstreamRequests[0].body.tools[1], { type: "web_search" });
    assert.deepEqual(upstreamRequests[0].body.tools[0].function.parameters, schema);
    assert.equal(upstreamRequests[1].body.model, profiled.upstreamModel);
    const normalized = upstreamRequests[1].body.tools[0].function.parameters;
    assert.equal("encrypted" in normalized, false);
    assert.equal("encrypted" in normalized.properties.value, false);
    assert.deepEqual(normalized.properties.encrypted, schema.properties.encrypted);
    assert.deepEqual(normalized.required, ["value", "encrypted"]);
    assert.equal(upstreamRequests[0].body.tool_choice, "required");
    assert.equal(upstreamRequests[1].body.tool_choice, "required");
    assert.equal(upstreamRequests[2].body.model, autoToolChoice.upstreamModel);
    assert.equal(upstreamRequests[2].body.tool_choice, "auto");
  } finally {
    await stop(forwarder);
    await close(upstream.server);
    rmSync(directory, { recursive: true, force: true });
  }
});
