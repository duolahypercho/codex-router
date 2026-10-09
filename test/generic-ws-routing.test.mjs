import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { handleResponsesWebSocketUpgrade } from "../src/responses-websocket.mjs";
import { userModelEntry } from "../src/user-models.mjs";
import { validateGenericProvider } from "../src/generic-provider-state.mjs";
import { openPort } from "./port-pool.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const INTERNAL_KEY = "generic-ws-routing-internal-key-with-sufficient-length";

// A fake provider that speaks the Responses WebSocket protocol by running the
// router's own edge module as its server side. `onTurn` answers the
// provider's HTTP plane; static-header confinement is asserted at the
// upgrade, the way a real provider would check its own key.
async function startWsProvider(onTurn) {
  const upgradeRequests = [];
  const internalBodies = [];
  // Upgraded sockets leave the server's own connection tracking, so cleanup
  // must destroy them explicitly or `server.close()` waits forever on a
  // pooled client's idle connection.
  const sockets = new Set();
  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url, "http://127.0.0.1");
    if (url.pathname !== "/v1/responses" || request.method !== "POST") {
      response.writeHead(404).end();
      return;
    }
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    internalBodies.push(body);
    await onTurn(body, response);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  server.on("upgrade", (request, socket, head) => {
    upgradeRequests.push(request);
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    handleResponsesWebSocketUpgrade(request, socket, head, {
      callerKey: "unused-by-this-fake",
      authenticateUpgrade: (upgradeRequest) =>
        upgradeRequest.headers["x-tenant"] === "operator-owned" ? "/v1/responses" : undefined,
      responsesUrl: `http://127.0.0.1:${port}/v1/responses`,
    });
  });
  return { server, port, upgradeRequests, internalBodies, sockets };
}

function sseTurn(response, id) {
  response.writeHead(200, { "content-type": "text/event-stream" });
  for (const event of [
    { type: "response.created", response: { id, status: "in_progress" } },
    { type: "response.output_text.delta", delta: "ws-ok" },
    { type: "response.completed", response: { id, status: "completed", usage: { total_tokens: 7 } } },
  ]) {
    response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
  }
  response.end();
}

async function readText(response) {
  let text = "";
  // undici body chunks are plain Uint8Array, whose toString() ignores the
  // encoding argument and returns comma-joined char codes; wrap in Buffer.
  for await (const chunk of response.body) text += Buffer.from(chunk).toString("utf8");
  return text;
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

async function postResponses(port, model) {
  return fetch(`http://127.0.0.1:${port}/v1/responses`, {
    method: "POST",
    headers: { Authorization: `Bearer ${INTERNAL_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      input: [{ type: "message", role: "user", content: "hi" }],
      stream: true,
    }),
  });
}

async function stop(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  await new Promise((resolve) => child.once("exit", resolve));
}

test("a websocket-transport provider streams through a pooled upstream connection", async (t) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "generic-ws-routing-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const provider = await startWsProvider((body, response) => sseTurn(response, `resp_${provider?.internalBodies?.length ?? 1}`));
  t.after(() => new Promise((resolve) => {
    for (const socket of provider.sockets) socket.destroy();
    provider.server.closeAllConnections();
    provider.server.close(resolve);
  }));

  const model = userModelEntry({ providerId: "mixed-ws", upstreamId: "gpt-ws-test", priority: 100 });
  const providersFile = path.join(directory, "generic-providers.json");
  const userModelsFile = path.join(directory, "user-models.json");
  writeFileSync(providersFile, `${JSON.stringify({
    version: 1,
    providers: [{
      id: "mixed-ws",
      displayName: "Mixed WS Gateway",
      baseUrl: `http://127.0.0.1:${provider.port}/v1`,
      adapter: "openai-responses",
      transport: "websocket",
      headers: { "X-Tenant": "operator-owned" },
      allowPrivate: true,
      enabled: true,
    }],
  }, null, 2)}\n`);
  writeFileSync(userModelsFile, `${JSON.stringify({ version: 1, models: [model] }, null, 2)}\n`);

  const forwarderPort = await openPort();
  const forwarder = runForwarder({
    MODEL_ROUTER_API_PORT: String(forwarderPort),
    MODEL_ROUTER_STATE_DIR: path.join(directory, "state"),
    MODEL_ROUTER_GENERIC_PROVIDERS: providersFile,
    MODEL_ROUTER_USER_MODELS: userModelsFile,
  });
  t.after(() => stop(forwarder));
  await waitForForwarder(forwarderPort, forwarder);

  const first = await postResponses(forwarderPort, model.gatewayModel);
  assert.equal(first.status, 200);
  assert.match(first.headers.get("content-type") || "", /text\/event-stream/);
  const firstBody = await readText(first);
  assert.match(firstBody, /response\.completed/);

  const second = await postResponses(forwarderPort, model.gatewayModel);
  assert.equal(second.status, 200);
  await readText(second);

  // Exactly one upstream WebSocket served both turns: the pool reused it.
  assert.equal(provider.upgradeRequests.length, 1);
  const upgrade = provider.upgradeRequests[0];
  assert.equal(upgrade.headers["x-tenant"], "operator-owned");
  // The internal key must never leave the machine, and the upgrade carried
  // the beta contract.
  assert.notEqual(upgrade.headers.authorization, `Bearer ${INTERNAL_KEY}`);
  assert.match(upgrade.headers["openai-beta"] || "", /responses_websockets=/);
  // Both turns reached the provider's HTTP plane as full Responses requests
  // with the upstream model id, not the gateway id.
  assert.equal(provider.internalBodies.length, 2);
  for (const body of provider.internalBodies) {
    assert.equal(body.model, "gpt-ws-test");
  }
});

test("a refused upgrade falls back to the HTTP path for that turn", async (t) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "generic-ws-fallback-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));

  const upgradeAttempts = [];
  const httpTurns = [];
  const server = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    httpTurns.push(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"));
    sseTurn(response, "resp_http_fallback");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  server.on("upgrade", (request, socket) => {
    upgradeAttempts.push(request);
    socket.end(
      [
        "HTTP/1.1 426 Upgrade Required",
        "Connection: close",
        "OpenAI-Beta: responses_websockets=2026-02-06",
        "Content-Length: 0",
        "",
        "",
      ].join("\r\n"),
    );
  });
  t.after(() => new Promise((resolve) => {
    server.closeAllConnections();
    server.close(resolve);
  }));

  const model = userModelEntry({ providerId: "refusing-ws", upstreamId: "gpt-ws-refusing", priority: 100 });
  const providersFile = path.join(directory, "generic-providers.json");
  const userModelsFile = path.join(directory, "user-models.json");
  writeFileSync(providersFile, `${JSON.stringify({
    version: 1,
    providers: [{
      id: "refusing-ws",
      displayName: "Refusing WS Gateway",
      baseUrl: `http://127.0.0.1:${port}/v1`,
      adapter: "openai-responses",
      transport: "websocket",
      allowPrivate: true,
      enabled: true,
    }],
  }, null, 2)}\n`);
  writeFileSync(userModelsFile, `${JSON.stringify({ version: 1, models: [model] }, null, 2)}\n`);

  const forwarderPort = await openPort();
  const forwarder = runForwarder({
    MODEL_ROUTER_API_PORT: String(forwarderPort),
    MODEL_ROUTER_STATE_DIR: path.join(directory, "state"),
    MODEL_ROUTER_GENERIC_PROVIDERS: providersFile,
    MODEL_ROUTER_USER_MODELS: userModelsFile,
  });
  t.after(() => stop(forwarder));
  await waitForForwarder(forwarderPort, forwarder);

  const response = await postResponses(forwarderPort, model.gatewayModel);
  assert.equal(response.status, 200);
  const body = await readText(response);
  assert.match(body, /response\.completed/);
  assert.equal(upgradeAttempts.length, 1);
  assert.equal(httpTurns.length, 1);
  assert.equal(httpTurns[0].model, "gpt-ws-refusing");
  assert.match(forwarder.testErrors(), /websocket transport unavailable/);
});

test("the transport flag is validated against the adapter", () => {
  const base = {
    id: "schema-provider",
    displayName: "Schema Provider",
    baseUrl: "https://provider.example.com/v1",
    allowPrivate: false,
    enabled: true,
  };
  assert.equal(validateGenericProvider({ ...base, adapter: "openai-responses", transport: "websocket" }).transport, "websocket");
  assert.equal(validateGenericProvider({ ...base, adapter: "openai-responses" }).transport, undefined);
  assert.throws(
    () => validateGenericProvider({ ...base, adapter: "openai-chat", transport: "websocket" }),
    /requires adapter openai-responses/,
  );
  assert.throws(
    () => validateGenericProvider({ ...base, adapter: "openai-responses", transport: "grpc" }),
    /transport must be one of/,
  );
});
