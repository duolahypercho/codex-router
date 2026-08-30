import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import http from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { callerBaseUrl } from "../src/caller-auth.mjs";

// End-to-end proof of the namespace relay through the REAL router: a routed
// request carrying the client's namespace toolset must reach the (mock)
// gateway with every namespace flattened into plain functions -- including the
// MCP namespaces (mcp__node_repl__js and friends) that LiteLLM's bridge drops
// when left as namespace entries -- and function calls streaming back must be
// restored to the client's native { name, namespace } shape. The router must
// not execute any app tool itself. The whole scenario runs twice and must
// produce byte-identical outgoing and incoming bodies (determinism).

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CALLER_KEY = "test-router-caller-capability-with-sufficient-length";
const INTERNAL_KEY = "test-internal-service-key-with-sufficient-length";
const IMAGE =
  "data:image/png;base64," +
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

function routerBase(port) {
  return callerBaseUrl(port, CALLER_KEY);
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

async function openPort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(typeof address === "object" && address);
  const port = address.port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function mockServer(handler) {
  const server = http.createServer(handler);
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(typeof address === "object" && address);
  return { server, port: address.port };
}

function run(script, env) {
  const stateIsolation =
    env?.MODEL_ROUTER_STATE_DIR || env?.CODEX_ROUTER_STATE_DIR
      ? {}
      : { MODEL_ROUTER_STATE_DIR: mkdtempSync(path.join(os.tmpdir(), "relay-routing-state-")) };
  const child = spawn(process.execPath, [path.join(root, "src", script)], {
    cwd: root,
    env: {
      ...process.env,
      ...stateIsolation,
      CODEX_ROUTER_CALLER_KEY: CALLER_KEY,
      CODEX_ROUTER_INTERNAL_KEY: INTERNAL_KEY,
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

// The namespace inventory the Codex client actually sends on routed requests
// (captured live): plain tools, collaboration, a reduced codex_app, and MCP
// namespaces -- including mcp__node_repl, the in-app browser / computer-use
// runtime, and a server whose namespace name contains the delimiter.
function routedRequestPayload(stream = true, model = "opencode-go/deepseek-v4-flash") {
  return {
    model,
    stream,
    input: [
      { type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] },
      {
        type: "function_call",
        name: "create_thread",
        namespace: "codex_app",
        call_id: "call_hist",
        arguments: "{}",
      },
      { type: "function_call_output", call_id: "call_hist", output: "{}" },
    ],
    tools: [
      {
        type: "tool_search",
        execution: "client",
        description: "Search deferred tools.",
        parameters: {
          type: "object",
          properties: {
            query: { type: "string" },
            limit: { type: "number" },
          },
          required: ["query"],
          additionalProperties: false,
        },
      },
      { type: "function", name: "exec_command" },
      { type: "function", name: "view_image" },
      {
        type: "namespace",
        name: "collaboration",
        tools: [
          { type: "function", name: "spawn_agent" },
          { type: "function", name: "wait_agent" },
        ],
      },
      {
        type: "namespace",
        name: "codex_app",
        tools: [
          { type: "function", name: "load_workspace_dependencies" },
          { type: "function", name: "navigate_to_codex_page" },
          { type: "function", name: "read_thread_terminal" },
        ],
      },
      {
        type: "namespace",
        name: "mcp__node_repl",
        tools: [
          { type: "function", name: "js" },
          { type: "function", name: "js_reset" },
        ],
      },
      {
        type: "namespace",
        name: "mcp__codex_apps__github",
        tools: [
          {
            type: "function",
            name: "fetch_issue",
            inputSchema: {
              type: "object",
              properties: {
                owner: { type: "string" },
                repo: { type: "string" },
                issue_number: { type: "integer", minimum: 1 },
              },
              required: ["owner", "repo", "issue_number"],
              additionalProperties: false,
            },
          },
        ],
      },
    ],
  };
}

// Reproduce the reported Codex 0.149.1 custom-provider shape: namespace tools
// are already flat when they reach the router, while canonical turn metadata
// still carries the native identity Codex will use for dispatch.
function preflattenedCommandCodeMcpPayload(
  stream = true,
  model = "commandcode/deepseek-v4-flash",
) {
  const namespace = "mcp__apmneonsnapshotro";
  const name = "get_monitor_snapshot";
  return {
    model,
    stream,
    input: "Call the monitor snapshot tool.",
    tools: [{
      type: "function",
      name: `${namespace}__${name}`,
      parameters: { type: "object", properties: {}, additionalProperties: false },
    }],
    client_metadata: {
      "x-codex-turn-metadata": JSON.stringify({
        tool_namespaces_info: {
          [namespace]: {
            name: namespace,
            functions: {
              [name]: {
                name,
                direct: true,
                code_mode_name: null,
                deferred: false,
                source: { kind: "mcp", server_name: "apmneonsnapshotro" },
              },
            },
          },
        },
      }),
    },
  };
}

function routedToolSearchHistoryPayload(
  stream = true,
  model = "opencode-go/deepseek-v4-flash",
) {
  const payload = routedRequestPayload(stream, model);
  payload.tools.push({
    type: "function",
    name: "mcp__calendar__create_event",
    description: "Current live schema.",
    parameters: {
      type: "object",
      properties: { live: { type: "boolean" } },
    },
  });
  payload.input.push(
    {
      type: "tool_search_call",
      call_id: "search-history-1",
      execution: "client",
      arguments: { query: "calendar", limit: 2 },
    },
    {
      type: "tool_search_call",
      call_id: "search-history-2",
      execution: "client",
      arguments: { query: "mail", limit: 1 },
    },
    {
      type: "tool_search_output",
      call_id: "search-history-1",
      status: "completed",
      execution: "client",
      tools: [
        {
          type: "namespace",
          name: "mcp__calendar",
          description: "Calendar tools.",
          tools: [
            {
              type: "function",
              name: "create_event",
              parameters: {
                type: "object",
                properties: { stale: { type: "string" } },
              },
            },
            {
              type: "function",
              name: "delete_event",
              parameters: {
                type: "object",
                properties: { id: { type: "string" } },
                required: ["id"],
                additionalProperties: false,
              },
            },
          ],
        },
      ],
    },
    {
      type: "tool_search_output",
      call_id: "search-history-2",
      status: "completed",
      execution: "client",
      tools: [
        {
          type: "function",
          name: "list_messages",
          parameters: {
            type: "object",
            properties: { query: { type: "string" } },
          },
        },
      ],
    },
  );
  return payload;
}

function groqToolSurfacePayload(
  stream,
  model,
  {
    plainTools = 111,
    discoveredTools = 0,
    toolSearch = false,
    input = [{ type: "message", role: "user", content: "hi" }],
    toolChoice,
  } = {},
) {
  const payload = {
    model,
    stream,
    input,
    tools: [
      ...(toolSearch ? [{
        type: "tool_search",
        execution: "client",
        description: "Search deferred tools.",
        parameters: {
          type: "object",
          properties: { query: { type: "string" } },
          required: ["query"],
        },
      }] : []),
      ...Array.from({ length: plainTools }, (_, index) => ({
        type: "function",
        name: `core_tool_${index}`,
        parameters: { type: "object" },
      })),
      {
        type: "namespace",
        name: "codex_app",
        tools: [
          { type: "function", name: "load_workspace_dependencies" },
          { type: "function", name: "navigate_to_codex_page" },
          { type: "function", name: "read_thread_terminal" },
        ],
      },
    ],
    ...(toolChoice === undefined ? {} : { tool_choice: toolChoice }),
  };
  if (discoveredTools > 0) {
    payload.input.push(
      {
        type: "tool_search_call",
        call_id: "groq-history-search",
        execution: "client",
        arguments: { query: "deferred" },
      },
      {
        type: "tool_search_output",
        call_id: "groq-history-search",
        status: "completed",
        execution: "client",
        tools: Array.from({ length: discoveredTools }, (_, index) => ({
          type: "function",
          name: `discovered_tool_${index}`,
          parameters: { type: "object" },
        })),
      },
    );
  }
  return payload;
}

function groqReferencedHistoryOverflowPayload(stream, model) {
  const payload = groqToolSurfacePayload(stream, model, { discoveredTools: 0 });
  const tools = Array.from({ length: 15 }, (_, index) => ({
    type: "function",
    name: `referenced_discovery_${index}`,
    parameters: { type: "object" },
  }));
  payload.input.push(
    {
      type: "tool_search_call",
      call_id: "referenced-overflow-search",
      execution: "client",
      arguments: { query: "referenced" },
    },
    {
      type: "tool_search_output",
      call_id: "referenced-overflow-search",
      status: "completed",
      execution: "client",
      tools,
    },
    ...tools.map((tool, index) => ({
      type: "function_call",
      name: tool.name,
      call_id: `referenced-call-${index}`,
      arguments: "{}",
    })),
  );
  return payload;
}

function groqForcedDiscoveryPayload(stream, model, { plainTools = 124 } = {}) {
  return groqToolSurfacePayload(stream, model, {
    plainTools,
    input: [
      { type: "message", role: "user", content: "hi" },
      {
        type: "tool_search_call",
        call_id: "forced-discovery-search",
        execution: "client",
        arguments: { query: "forced" },
      },
      {
        type: "tool_search_output",
        call_id: "forced-discovery-search",
        status: "completed",
        execution: "client",
        tools: [{
          type: "namespace",
          name: "mcp__forced",
          tools: [
            { type: "function", name: "unused", parameters: { type: "object" } },
            { type: "function", name: "required", parameters: { type: "object" } },
          ],
        }],
      },
    ],
    toolChoice: {
      type: "function",
      namespace: "mcp__forced",
      function: { name: "required" },
    },
  });
}

function groqInjectedAppHistoryPayload(stream, model) {
  return groqToolSurfacePayload(stream, model, {
    input: [
      { type: "message", role: "user", content: "hi" },
      {
        type: "function_call",
        name: "create_thread",
        namespace: "codex_app",
        call_id: "prior-create-thread",
        arguments: "{}",
      },
      {
        type: "function_call_output",
        call_id: "prior-create-thread",
        output: "{}",
      },
    ],
  });
}

function groqForcedAppChoicePayload(stream, model) {
  return groqToolSurfacePayload(stream, model, {
    toolChoice: {
      type: "function",
      name: "codex_app__send_message_to_thread",
    },
  });
}

function groqNestedForcedAppChoicePayload(stream, model, { plainTools = 111 } = {}) {
  return groqToolSurfacePayload(stream, model, {
    plainTools,
    toolChoice: {
      type: "function",
      namespace: "codex_app",
      function: { name: "create_thread" },
    },
  });
}

function groqAllowedAppChoicePayload(stream, model) {
  return groqToolSurfacePayload(stream, model, {
    toolSearch: true,
    toolChoice: {
      type: "allowed_tools",
      mode: "required",
      tools: [
        { type: "function", namespace: "codex_app", name: "send_message_to_thread" },
        { type: "function", function: { name: "codex_app__read_thread" } },
        { type: "custom", name: "apply_patch" },
        { type: "tool_search", execution: "client" },
      ],
    },
  });
}

function groqResponseCollisionPayload(stream, model) {
  const payload = groqToolSurfacePayload(stream, model, {
    plainTools: 110,
    input: [
      { type: "message", role: "user", content: "hi" },
      {
        type: "function_call",
        name: "codex_app__create_thread",
        call_id: "plain-collision",
        arguments: "{}",
      },
      {
        type: "function_call",
        namespace: "codex_app",
        name: "create_thread",
        call_id: "app-collision",
        arguments: '{"model":"fixed"}',
      },
    ],
  });
  payload.tools.push({
    type: "function",
    name: "codex_app__create_thread",
    parameters: { type: "object" },
  });
  return payload;
}

function groqReferencedAppOverflowPayload(stream, model) {
  return groqToolSurfacePayload(stream, model, {
    plainTools: 125,
    input: [{
      type: "function_call",
      name: "create_thread",
      namespace: "codex_app",
      call_id: "overflow-create-thread",
      arguments: "{}",
    }],
  });
}

function groqModelSwitchHistoryPayload(stream, model, { referencedTools = 1 } = {}) {
  const discovered = Array.from({ length: 15 }, (_, index) => ({
    type: "function",
    name: `switched_tool_${index}`,
    parameters: { type: "object" },
  }));
  const payload = groqToolSurfacePayload(stream, model);
  payload.input.push(
    {
      type: "tool_search_call",
      call_id: "prior-model-search",
      execution: "client",
      arguments: { query: "switched" },
    },
    {
      type: "tool_search_output",
      call_id: "prior-model-search",
      status: "completed",
      execution: "client",
      tools: [{
        type: "namespace",
        name: "mcp__switched",
        tools: discovered,
      }],
    },
    ...discovered.slice(15 - referencedTools).map((tool, index) => ({
      type: "function_call",
      name: tool.name,
      namespace: "mcp__switched",
      call_id: `switched-call-${index}`,
      arguments: "{}",
    })),
  );
  return payload;
}

function groqModelFixture() {
  const directory = mkdtempSync(path.join(os.tmpdir(), "groq-tool-surface-"));
  const userModels = path.join(directory, "user-models.json");
  writeFileSync(
    userModels,
    JSON.stringify({
      version: 1,
      models: [
        {
          slug: "groq/tool-limit-fixture",
          gatewayModel: "groq-tool-limit-fixture",
          upstreamModel: "openai/gpt-oss-120b",
          provider: "groq",
          listed: true,
          displayName: "Groq tool-limit fixture",
          description: "Local routing test fixture.",
          priority: 500,
          defaultEffort: "high",
          reasoningLevels: [{ effort: "high", description: "Adaptive reasoning" }],
          contextWindow: 131072,
          autoCompact: 111411,
          inputModalities: ["text"],
          compHash: "groq-tool-limit-fixture-user-v1",
        },
      ],
    }),
    "utf8",
  );
  return { directory, userModels, model: "groq/tool-limit-fixture" };
}

function sseEvent(event) {
  return `data: ${JSON.stringify(event)}\n\n`;
}

// The gateway answers with an SSE stream carrying function calls in the
// flattened form a chat-completions bridge would emit, plus one ordinary call.
function gatewaySseBody() {
  return [
    sseEvent({ type: "response.created" }),
    sseEvent({
      type: "response.output_item.added",
      item: {
        type: "function_call",
        name: "mcp__node_repl__js",
        call_id: "call_browser",
      },
    }),
    sseEvent({
      type: "response.output_item.done",
      item: {
        type: "function_call",
        name: "mcp__node_repl__js",
        call_id: "call_browser",
        arguments: "{}",
      },
    }),
    sseEvent({
      type: "response.output_item.done",
      item: {
        type: "function_call",
        name: "codex_app__create_thread",
        call_id: "call_thread",
        arguments: "{}",
      },
    }),
    sseEvent({
      type: "response.output_item.done",
      item: {
        type: "function_call",
        name: "codex_app__create_thread",
        call_id: "call_explicit_thread",
        arguments: JSON.stringify({ model: "gpt-5.6-terra" }),
      },
    }),
    sseEvent({
      type: "response.output_item.done",
      item: {
        type: "function_call",
        name: "codex_app__send_message_to_thread",
        call_id: "call_followup",
        arguments: JSON.stringify({ threadId: "thread_1", prompt: "continue" }),
      },
    }),
    sseEvent({
      type: "response.output_item.done",
      item: {
        type: "function_call",
        name: "codex_app__create_thread",
        call_id: "call_cloud_thread",
        arguments: JSON.stringify({
          prompt: "cloud",
          target: { type: "chatgptWorkCloud" },
        }),
      },
    }),
    sseEvent({
      type: "response.output_item.done",
      item: {
        type: "function_call",
        name: "collaboration__spawn_agent",
        call_id: "call_agent",
        arguments: "{}",
      },
    }),
    sseEvent({
      type: "response.output_item.done",
      item: {
        type: "function_call",
        name: "exec_command",
        call_id: "call_exec",
        arguments: "{}",
      },
    }),
    sseEvent({
      type: "response.output_item.done",
      item: {
        type: "function_call",
        name: "tool_search",
        call_id: "call_search",
        arguments: JSON.stringify({ query: "calendar", limit: 2 }),
      },
    }),
    sseEvent({ type: "response.completed" }),
    "data: [DONE]\n\n",
  ].join("");
}

function gatewayJsonBody() {
  return {
    id: "resp_json",
    output: [
      {
        type: "function_call",
        name: "mcp__node_repl__js",
        call_id: "call_browser",
        arguments: "{}",
      },
      {
        type: "function_call",
        name: "codex_app__create_thread",
        call_id: "call_thread",
        arguments: "{}",
      },
      {
        type: "function_call",
        name: "codex_app__create_thread",
        call_id: "call_explicit_thread",
        arguments: JSON.stringify({ model: "gpt-5.6-terra" }),
      },
      {
        type: "function_call",
        name: "codex_app__send_message_to_thread",
        call_id: "call_followup",
        arguments: JSON.stringify({ threadId: "thread_1", prompt: "continue" }),
      },
      {
        type: "function_call",
        name: "codex_app__create_thread",
        call_id: "call_cloud_thread",
        arguments: JSON.stringify({
          prompt: "cloud",
          target: { type: "chatgptWorkCloud" },
        }),
      },
      {
        type: "function_call",
        name: "exec_command",
        call_id: "call_exec",
        arguments: "{}",
      },
      {
        type: "function_call",
        name: "tool_search",
        call_id: "call_search",
        arguments: JSON.stringify({ query: "calendar", limit: 2 }),
      },
    ],
  };
}

function responsesProviderSseBody() {
  return [
    sseEvent({
      type: "response.output_item.done",
      item: {
        type: "function_call",
        name: "create_thread",
        namespace: "codex_app",
        call_id: "call_native_thread",
        arguments: JSON.stringify({ prompt: "hi", target: { type: "projectless" } }),
      },
    }),
    sseEvent({ type: "response.completed" }),
    "data: [DONE]\n\n",
  ].join("");
}

function responsesProviderJsonBody() {
  return {
    id: "resp_native_json",
    output: [
      {
        type: "function_call",
        name: "create_thread",
        namespace: "codex_app",
        call_id: "call_native_thread",
        arguments: JSON.stringify({ prompt: "hi", target: { type: "projectless" } }),
      },
    ],
  };
}

function responseItemsFromSse(body) {
  const items = [];
  for (const line of body.split(/\r?\n/)) {
    if (!line.startsWith("data:")) continue;
    const data = line.slice(5).trimStart();
    if (!data || data === "[DONE]") continue;
    let event;
    try {
      event = JSON.parse(data);
    } catch {
      continue;
    }
    if (event?.item) items.push(event.item);
  }
  return items;
}

function functionCallsFromSse(body) {
  const calls = new Map();
  for (const item of responseItemsFromSse(body)) {
    if (item?.type === "function_call") calls.set(item.call_id, item);
  }
  return calls;
}

async function scenario(
  stream = true,
  {
    endpoint = "/responses",
    model = "opencode-go/deepseek-v4-flash",
    sseBody = gatewaySseBody,
    jsonBody = gatewayJsonBody,
    requestPayload = routedRequestPayload,
    routerEnv = {},
    prepareRouterEnv,
    visionJsonBody,
    expectedStatus = 200,
  } = {},
) {
  const gatewayBodies = [];
  const visionBodies = [];
  const gateway = await mockServer(async (request, response) => {
    if (request.url === "/vision/v1/chat/completions" && visionJsonBody) {
      const visionBody = await bodyJson(request);
      visionBodies.push(visionBody);
      json(
        response,
        200,
        typeof visionJsonBody === "function" ? visionJsonBody(visionBody) : visionJsonBody,
      );
      return;
    }
    if (request.url === "/v1/responses") {
      const gatewayBody = await bodyJson(request);
      gatewayBodies.push(gatewayBody);
      if (gatewayBody.stream === false) {
        json(response, 200, jsonBody(gatewayBody));
        return;
      }
      const body = Buffer.from(sseBody(gatewayBody), "utf8");
      response.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Content-Length": String(body.length),
      });
      response.end(body);
      return;
    }
    json(response, 404, { error: { message: `unexpected ${request.url}` } });
  });
  const routerPort = await openPort();
  const preparedRouterEnv = prepareRouterEnv
    ? prepareRouterEnv({ gatewayPort: gateway.port })
    : {};
  const router = run("router.mjs", {
    CODEX_ROUTER_PORT: String(routerPort),
    CODEX_ROUTER_GATEWAY_BASE_URL: `http://127.0.0.1:${gateway.port}/v1`,
    CODEX_ROUTER_QUIET: "1",
    ...routerEnv,
    ...preparedRouterEnv,
  });
  try {
    await waitFor(`${routerBase(routerPort)}/models`, router);
    const response = await fetch(`${routerBase(routerPort)}${endpoint}`, {
      method: "POST",
      headers: {
        Authorization: "Bearer CODEX_CALLER_SECRET",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(requestPayload(stream, model)),
    });
    assert.equal(response.status, expectedStatus, `router status ${response.status}`);
    const clientBody = await response.text();
    return { gatewayBodies, visionBodies, clientBody, router, status: response.status };
  } finally {
    await stopChild(router);
    await closeServer(gateway.server);
  }
}

test("a curated no-search Groq model routes a 129-tool expansion safely", async () => {
  const fixture = groqModelFixture();
  try {
    const result = await scenario(false, {
      model: fixture.model,
      requestPayload: (stream, model) => groqToolSurfacePayload(stream, model),
      jsonBody: () => ({ id: "groq-safe", output: [] }),
      routerEnv: { MODEL_ROUTER_USER_MODELS: fixture.userModels },
    });
    assert.equal(result.gatewayBodies.length, 1);
    const outgoing = result.gatewayBodies[0];
    assert.equal(outgoing.model, "groq-tool-limit-fixture");
    assert.ok(outgoing.tools.length <= 128);
    assert.equal(outgoing.tools.length, 114);
    const names = new Set(outgoing.tools.map((tool) => tool.name));
    for (let index = 0; index < 111; index += 1) {
      assert.ok(names.has(`core_tool_${index}`), `core_tool_${index} survives`);
    }
    for (const name of [
      "codex_app__load_workspace_dependencies",
      "codex_app__navigate_to_codex_page",
      "codex_app__read_thread_terminal",
    ]) {
      assert.ok(names.has(name), `${name} survives`);
    }
    assert.equal(names.has("tool_search"), false);
    assert.equal(names.has("codex_app__create_thread"), false);
    assert.equal(names.has("plugin_management__uninstall_plugin"), false);
  } finally {
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test("Groq refuses more than 128 client tools before contacting the gateway", async () => {
  const fixture = groqModelFixture();
  try {
    const result = await scenario(false, {
      model: fixture.model,
      requestPayload: (stream, model) =>
        groqToolSurfacePayload(stream, model, { plainTools: 126 }),
      routerEnv: { MODEL_ROUTER_USER_MODELS: fixture.userModels },
      expectedStatus: 400,
    });
    assert.equal(result.gatewayBodies.length, 0);
    const error = JSON.parse(result.clientBody).error;
    assert.deepEqual(
      {
        type: error.type,
        code: error.code,
        provider: error.provider,
        limit: error.limit,
      },
      {
        type: "provider_compatibility_error",
        code: "groq_tool_limit_exceeded",
        provider: "groq",
        limit: 128,
      },
    );
  } finally {
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test("Groq re-adds a deferred app definition used by prior native history", async () => {
  const fixture = groqModelFixture();
  try {
    const result = await scenario(false, {
      model: fixture.model,
      requestPayload: groqInjectedAppHistoryPayload,
      jsonBody: () => ({ id: "groq-prior-app-history", output: [] }),
      routerEnv: { MODEL_ROUTER_USER_MODELS: fixture.userModels },
    });
    assert.equal(result.gatewayBodies.length, 1);
    const outgoing = result.gatewayBodies[0];
    assert.ok(outgoing.tools.some((tool) => tool.name === "codex_app__create_thread"));
    const call = outgoing.input.find((item) => item.call_id === "prior-create-thread");
    assert.equal(call.name, "codex_app__create_thread");
    assert.equal(call.namespace, undefined);
  } finally {
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test("Groq re-adds and flattens a forced deferred app choice", async () => {
  const fixture = groqModelFixture();
  try {
    const result = await scenario(false, {
      model: fixture.model,
      requestPayload: groqForcedAppChoicePayload,
      jsonBody: () => ({ id: "groq-forced-app-choice", output: [] }),
      routerEnv: { MODEL_ROUTER_USER_MODELS: fixture.userModels },
    });
    assert.equal(result.gatewayBodies.length, 1);
    const outgoing = result.gatewayBodies[0];
    assert.ok(
      outgoing.tools.some((tool) => tool.name === "codex_app__send_message_to_thread"),
    );
    assert.deepEqual(outgoing.tool_choice, {
      type: "function",
      name: "codex_app__send_message_to_thread",
    });
  } finally {
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test("Groq admits nested and mixed allowed-tools choices through the same identity map", async () => {
  const fixture = groqModelFixture();
  try {
    const nested = await scenario(false, {
      model: fixture.model,
      requestPayload: groqNestedForcedAppChoicePayload,
      jsonBody: () => ({ id: "groq-nested-choice", output: [] }),
      routerEnv: { MODEL_ROUTER_USER_MODELS: fixture.userModels },
    });
    assert.equal(nested.gatewayBodies.length, 1);
    assert.ok(
      nested.gatewayBodies[0].tools.some((tool) => tool.name === "codex_app__create_thread"),
    );
    assert.deepEqual(nested.gatewayBodies[0].tool_choice, {
      type: "function",
      function: { name: "codex_app__create_thread" },
    });

    const allowed = await scenario(false, {
      model: fixture.model,
      requestPayload: groqAllowedAppChoicePayload,
      jsonBody: () => ({ id: "groq-allowed-choice", output: [] }),
      routerEnv: { MODEL_ROUTER_USER_MODELS: fixture.userModels },
    });
    assert.equal(allowed.gatewayBodies.length, 1);
    const outgoing = allowed.gatewayBodies[0];
    assert.ok(
      outgoing.tools.some((tool) => tool.name === "codex_app__send_message_to_thread"),
    );
    assert.ok(outgoing.tools.some((tool) => tool.name === "codex_app__read_thread"));
    assert.deepEqual(outgoing.tool_choice, {
      type: "allowed_tools",
      mode: "required",
      tools: [
        { type: "function", name: "codex_app__send_message_to_thread" },
        { type: "function", function: { name: "codex_app__read_thread" } },
        { type: "custom", name: "apply_patch" },
        { type: "function", name: "tool_search" },
      ],
    });
  } finally {
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test("Groq refuses a nested absent forced app at exactly 128 before upstream", async () => {
  const fixture = groqModelFixture();
  try {
    const result = await scenario(false, {
      model: fixture.model,
      requestPayload: (stream, model) =>
        groqNestedForcedAppChoicePayload(stream, model, { plainTools: 125 }),
      routerEnv: { MODEL_ROUTER_USER_MODELS: fixture.userModels },
      expectedStatus: 400,
    });
    assert.equal(result.gatewayBodies.length, 0);
    const error = JSON.parse(result.clientBody).error;
    assert.equal(error.code, "groq_tool_limit_exceeded");
    assert.match(error.message, /request references 1 deferred app tools/);
    assert.match(error.message, /only 0 slots remain/);
  } finally {
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test("Groq response aliases distinguish a plain flattened spelling from the app tool", async () => {
  const fixture = groqModelFixture();
  try {
    const result = await scenario(false, {
      model: fixture.model,
      requestPayload: groqResponseCollisionPayload,
      jsonBody: (outgoing) => {
        const plain = outgoing.input.find((item) => item.call_id === "plain-collision");
        const app = outgoing.input.find((item) => item.call_id === "app-collision");
        assert.notEqual(plain.name, app.name);
        assert.equal(plain.namespace, undefined);
        assert.equal(app.namespace, undefined);
        return {
          id: "groq-response-collision",
          output: [
            { type: "function_call", name: plain.name, call_id: "plain-result", arguments: "{}" },
            {
              type: "function_call",
              name: app.name,
              call_id: "app-result",
              arguments: '{"model":"fixed"}',
            },
          ],
        };
      },
      routerEnv: { MODEL_ROUTER_USER_MODELS: fixture.userModels },
    });
    assert.equal(result.gatewayBodies.length, 1);
    const response = JSON.parse(result.clientBody);
    assert.deepEqual(response.output, [
      {
        type: "function_call",
        name: "codex_app__create_thread",
        call_id: "plain-result",
        arguments: "{}",
      },
      {
        type: "function_call",
        name: "create_thread",
        namespace: "codex_app",
        call_id: "app-result",
        arguments: '{"model":"fixed"}',
      },
    ]);
  } finally {
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test("Groq refuses referenced app overflow before contacting the gateway", async () => {
  const fixture = groqModelFixture();
  try {
    const result = await scenario(false, {
      model: fixture.model,
      requestPayload: groqReferencedAppOverflowPayload,
      routerEnv: { MODEL_ROUTER_USER_MODELS: fixture.userModels },
      expectedStatus: 400,
    });
    assert.equal(result.gatewayBodies.length, 0);
    const error = JSON.parse(result.clientBody).error;
    assert.equal(error.type, "provider_compatibility_error");
    assert.equal(error.code, "groq_tool_limit_exceeded");
    assert.equal(error.provider, "groq");
    assert.equal(error.limit, 128);
    assert.match(error.message, /request references 1 deferred app tools/);
    assert.match(error.message, /only 0 slots remain/);
  } finally {
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test("Groq preserves model-switch discoveries while dropping stale search controls", async () => {
  const fixture = groqModelFixture();
  try {
    const result = await scenario(false, {
      model: fixture.model,
      requestPayload: groqModelSwitchHistoryPayload,
      jsonBody: () => ({
        id: "groq-model-switch-history",
        output: [{
          type: "function_call",
          name: "mcp__switched__switched_tool_14",
          call_id: "switched-again",
          arguments: "{}",
        }],
      }),
      routerEnv: { MODEL_ROUTER_USER_MODELS: fixture.userModels },
    });
    assert.equal(result.gatewayBodies.length, 1);
    const outgoing = result.gatewayBodies[0];
    assert.equal(outgoing.tools.length, 128);
    assert.ok(
      outgoing.tools.some((tool) => tool.name === "mcp__switched__switched_tool_14"),
      "the later referenced discovery survives capacity selection",
    );
    assert.equal(
      outgoing.input.some(
        (item) => item.type === "tool_search_call" || item.type === "tool_search_output",
      ),
      false,
    );
    const storedCall = outgoing.input.find((item) => item.call_id === "switched-call-0");
    assert.equal(storedCall.name, "mcp__switched__switched_tool_14");
    assert.equal(storedCall.namespace, undefined);
    assert.equal(
      outgoing.input.some(
        (item) => item.type === "function_call" && item.namespace !== undefined,
      ),
      false,
      "no native namespace field reaches the chat bridge",
    );
    const response = JSON.parse(result.clientBody);
    assert.deepEqual(response.output[0], {
      type: "function_call",
      name: "switched_tool_14",
      namespace: "mcp__switched",
      call_id: "switched-again",
      arguments: "{}",
    });
  } finally {
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test("Groq reserves a forced model-switch discovery and refuses it when no slot remains", async () => {
  const fixture = groqModelFixture();
  try {
    const admitted = await scenario(false, {
      model: fixture.model,
      requestPayload: groqForcedDiscoveryPayload,
      jsonBody: () => ({ id: "groq-forced-discovery", output: [] }),
      routerEnv: { MODEL_ROUTER_USER_MODELS: fixture.userModels },
    });
    assert.equal(admitted.gatewayBodies.length, 1);
    const outgoing = admitted.gatewayBodies[0];
    assert.equal(outgoing.tools.length, 128);
    assert.ok(outgoing.tools.some((tool) => tool.name === "mcp__forced__required"));
    assert.equal(outgoing.tools.some((tool) => tool.name === "mcp__forced__unused"), false);
    assert.deepEqual(outgoing.tool_choice, {
      type: "function",
      function: { name: "mcp__forced__required" },
    });
    assert.equal(
      outgoing.input.some(
        (item) => item.type === "tool_search_call" || item.type === "tool_search_output",
      ),
      false,
    );

    const refused = await scenario(false, {
      model: fixture.model,
      requestPayload: (stream, model) =>
        groqForcedDiscoveryPayload(stream, model, { plainTools: 125 }),
      routerEnv: { MODEL_ROUTER_USER_MODELS: fixture.userModels },
      expectedStatus: 400,
    });
    assert.equal(refused.gatewayBodies.length, 0);
    const error = JSON.parse(refused.clientBody).error;
    assert.equal(error.code, "groq_tool_limit_exceeded");
    assert.match(error.message, /stored history references 1 discovered tools/);
    assert.match(error.message, /only 0 slots remain/);
  } finally {
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test("Groq refuses referenced discovery overflow before contacting the gateway", async () => {
  const fixture = groqModelFixture();
  try {
    const result = await scenario(false, {
      model: fixture.model,
      requestPayload: groqReferencedHistoryOverflowPayload,
      routerEnv: { MODEL_ROUTER_USER_MODELS: fixture.userModels },
      expectedStatus: 400,
    });
    assert.equal(result.gatewayBodies.length, 0);
    const error = JSON.parse(result.clientBody).error;
    assert.equal(error.type, "provider_compatibility_error");
    assert.equal(error.code, "groq_tool_limit_exceeded");
    assert.equal(error.provider, "groq");
    assert.equal(error.limit, 128);
    assert.match(error.message, /stored history references 15 discovered tools/);
    assert.match(error.message, /only 14 slots remain/);
  } finally {
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test("Groq rejects a known history overflow before spending a vision or gateway call", async () => {
  const fixture = groqModelFixture();
  const stateDirectory = mkdtempSync(path.join(os.tmpdir(), "groq-preflight-vision-state-"));
  try {
    const result = await scenario(false, {
      model: fixture.model,
      requestPayload: (stream, model) => {
        const payload = groqReferencedHistoryOverflowPayload(stream, model);
        payload.input[0] = {
          type: "message",
          role: "user",
          content: [
            { type: "input_text", text: "read this" },
            { type: "input_image", image_url: IMAGE },
          ],
        };
        return payload;
      },
      routerEnv: { MODEL_ROUTER_USER_MODELS: fixture.userModels },
      prepareRouterEnv: ({ gatewayPort }) => {
        writeFileSync(
          path.join(stateDirectory, "vision-bridge.json"),
          JSON.stringify({
            version: 1,
            enabled: true,
            engine: "local",
            effort: null,
            local: {
              model: "mock-vision-1b",
              baseUrl: `http://127.0.0.1:${gatewayPort}/vision/v1`,
            },
          }),
          { encoding: "utf8", mode: 0o600 },
        );
        return { MODEL_ROUTER_STATE_DIR: stateDirectory };
      },
      visionJsonBody: {
        choices: [{ message: { role: "assistant", content: "an image" } }],
      },
      expectedStatus: 400,
    });
    assert.equal(result.visionBodies.length, 0);
    assert.equal(result.gatewayBodies.length, 0);
    const error = JSON.parse(result.clientBody).error;
    assert.equal(error.code, "groq_tool_limit_exceeded");
  } finally {
    rmSync(stateDirectory, { recursive: true, force: true });
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test("non-Groq routes preserve the full expanded and discovered tool surface", async () => {
  const result = await scenario(false, {
    requestPayload: (stream, model) => groqToolSurfacePayload(stream, model, {
      plainTools: 110,
      discoveredTools: 20,
      toolSearch: true,
    }),
    jsonBody: () => ({ id: "non-groq-unchanged", output: [] }),
  });
  assert.equal(result.gatewayBodies.length, 1);
  const outgoing = result.gatewayBodies[0];
  assert.equal(outgoing.tools.length, 149);
  const names = new Set(outgoing.tools.map((tool) => tool.name));
  assert.ok(names.has("codex_app__create_thread"));
  assert.ok(names.has("plugin_management__uninstall_plugin"));
  for (let index = 0; index < 20; index += 1) {
    assert.ok(names.has(`discovered_tool_${index}`));
  }
  const searchOutput = outgoing.input.find(
    (item) => item.call_id === "groq-history-search" && item.type === "function_call_output",
  );
  assert.equal(JSON.parse(searchOutput.output).tools.length, 20);
});

test("routed request flattens every namespace to the gateway and restores calls to the client", async () => {
  const first = await scenario();
  const second = await scenario();
  // Determinism: two identical runs produce byte-identical outgoing and
  // incoming bodies.
  assert.equal(second.gatewayBodies.length, 1);
  assert.deepEqual(second.gatewayBodies, first.gatewayBodies);
  assert.equal(second.clientBody, first.clientBody);

  const outgoing = first.gatewayBodies[0];
  assert.equal(outgoing.model, "opencode-go-deepseek-v4-flash");
  const names = outgoing.tools.map((tool) => tool.name);

  // The full native toolset reaches the provider in the flattened form,
  // including the MCP namespaces the bridge drops when left as namespace
  // entries.
  assert.ok(names.includes("collaboration__spawn_agent"), "collaboration flattened");
  assert.ok(names.includes("codex_app__create_thread"), "merged codex_app tool flattened");
  assert.ok(names.includes("mcp__node_repl__js"), "node_repl js flattened");
  assert.ok(names.includes("mcp__node_repl__js_reset"), "node_repl js_reset flattened");
  assert.ok(names.includes("tool_search"), "native tool_search exposed as a function");
  assert.ok(
    names.includes("mcp__codex_apps__github__fetch_issue"),
    "nested-namespace MCP tool flattened",
  );
  assert.ok(names.includes("exec_command"), "plain tools untouched");
  assert.ok(
    outgoing.tools.every((tool) => tool?.type !== "namespace"),
    "no namespace entries reach the gateway",
  );
  assert.ok(
    outgoing.tools.every((tool) => tool?.type !== "tool_search"),
    "native deferred-search controls do not reach a function-only provider",
  );
  const toolSearch = outgoing.tools.find((tool) => tool.name === "tool_search");
  assert.equal(toolSearch.type, "function");
  assert.deepEqual(toolSearch.parameters.required, ["query"]);
  // The merged codex_app tool definitions keep their schema.
  const createThread = outgoing.tools.find((tool) => tool.name === "codex_app__create_thread");
  assert.ok(createThread?.inputSchema, "create_thread schema survives the relay");
  assert.equal(createThread.inputSchema.type, "object");
  const fetchIssue = outgoing.tools.find(
    (tool) => tool.name === "mcp__codex_apps__github__fetch_issue",
  );
  assert.deepEqual(fetchIssue?.parameters, {
    type: "object",
    properties: {
      owner: { type: "string" },
      repo: { type: "string" },
      issue_number: { type: "integer", minimum: 1 },
    },
    required: ["owner", "repo", "issue_number"],
    additionalProperties: false,
  });

  // Stored namespaced calls in the input history are renamed to match the
  // flattened tool list the model sees.
  const historyCall = outgoing.input.find((item) => item?.type === "function_call");
  assert.equal(historyCall.name, "codex_app__create_thread");
  assert.equal(historyCall.namespace, undefined);
  // Historical calls are evidence, not fresh outbound actions. Rewriting
  // their model would change the transcript the provider is meant to see.
  assert.deepEqual(JSON.parse(historyCall.arguments), {});

  // Function calls streaming back are restored to the client's native
  // namespace shape so the app dispatches them itself.
  const calls = functionCallsFromSse(first.clientBody);
  assert.deepEqual(
    { name: calls.get("call_browser").name, namespace: calls.get("call_browser").namespace },
    { name: "js", namespace: "mcp__node_repl" },
  );
  assert.deepEqual(
    { name: calls.get("call_thread").name, namespace: calls.get("call_thread").namespace },
    { name: "create_thread", namespace: "codex_app" },
  );
  assert.deepEqual(JSON.parse(calls.get("call_thread").arguments), {
    model: "opencode-go/deepseek-v4-flash",
  });
  assert.deepEqual(JSON.parse(calls.get("call_explicit_thread").arguments), {
    model: "gpt-5.6-terra",
  });
  assert.deepEqual(JSON.parse(calls.get("call_followup").arguments), {
    threadId: "thread_1",
    prompt: "continue",
  });
  assert.deepEqual(JSON.parse(calls.get("call_cloud_thread").arguments), {
    prompt: "cloud",
    target: { type: "chatgptWorkCloud" },
  });
  assert.deepEqual(
    { name: calls.get("call_agent").name, namespace: calls.get("call_agent").namespace },
    { name: "spawn_agent", namespace: "collaboration" },
  );
  // Ordinary calls pass through untouched -- no namespace invented.
  assert.equal(calls.get("call_exec").name, "exec_command");
  assert.equal(calls.get("call_exec").namespace, undefined);
  const searchCall = responseItemsFromSse(first.clientBody).find(
    (item) => item.call_id === "call_search",
  );
  assert.deepEqual(searchCall, {
    type: "tool_search_call",
    call_id: "call_search",
    execution: "client",
    arguments: { query: "calendar", limit: 2 },
  });
  // The router never executed any app tool: the gateway saw exactly one
  // request and the client saw exactly the relayed calls.
  assert.equal(first.gatewayBodies.length, 1);
});

test("Command Code models restore MCP calls Codex pre-flattened before the router", async () => {
  const flatName = "mcp__apmneonsnapshotro__get_monitor_snapshot";
  for (const model of [
    "commandcode/deepseek-v4-flash",
    "commandcode/hy4-preview",
  ]) {
    const streamed = await scenario(true, {
      model,
      requestPayload: preflattenedCommandCodeMcpPayload,
      sseBody: () => [
        sseEvent({
          type: "response.output_item.done",
          item: {
            type: "function_call",
            name: flatName,
            call_id: "call_snapshot",
            arguments: "{}",
          },
        }),
        sseEvent({ type: "response.completed" }),
        "data: [DONE]\n\n",
      ].join(""),
    });
    assert.equal(streamed.gatewayBodies.length, 1, model);
    assert.equal(streamed.gatewayBodies[0].client_metadata, undefined, model);
    assert.ok(
      streamed.gatewayBodies[0].tools.some((tool) => tool.name === flatName),
      model,
    );
    const call = functionCallsFromSse(streamed.clientBody).get("call_snapshot");
    assert.deepEqual(
      { name: call.name, namespace: call.namespace },
      { name: "get_monitor_snapshot", namespace: "mcp__apmneonsnapshotro" },
      model,
    );
  }
});

test("non-streaming routed responses restore namespace calls before client dispatch", async () => {
  const result = await scenario(false);
  assert.equal(result.gatewayBodies.length, 1);
  assert.equal(result.gatewayBodies[0].stream, false);

  const client = JSON.parse(result.clientBody);
  assert.deepEqual(
    { name: client.output[0].name, namespace: client.output[0].namespace },
    { name: "js", namespace: "mcp__node_repl" },
  );
  assert.deepEqual(
    { name: client.output[1].name, namespace: client.output[1].namespace },
    { name: "create_thread", namespace: "codex_app" },
  );
  assert.deepEqual(JSON.parse(client.output[1].arguments), {
    model: "opencode-go/deepseek-v4-flash",
  });
  assert.deepEqual(JSON.parse(client.output[2].arguments), {
    model: "gpt-5.6-terra",
  });
  assert.deepEqual(
    { name: client.output[2].name, namespace: client.output[2].namespace },
    { name: "create_thread", namespace: "codex_app" },
  );
  assert.deepEqual(JSON.parse(client.output[3].arguments), {
    threadId: "thread_1",
    prompt: "continue",
  });
  assert.deepEqual(
    { name: client.output[3].name, namespace: client.output[3].namespace },
    { name: "send_message_to_thread", namespace: "codex_app" },
  );
  assert.deepEqual(JSON.parse(client.output[4].arguments), {
    prompt: "cloud",
    target: { type: "chatgptWorkCloud" },
  });
  assert.deepEqual(
    { name: client.output[4].name, namespace: client.output[4].namespace },
    { name: "create_thread", namespace: "codex_app" },
  );
  assert.equal(client.output[5].name, "exec_command");
  assert.equal(client.output[5].namespace, undefined);
  assert.deepEqual(client.output[6], {
    type: "tool_search_call",
    call_id: "call_search",
    execution: "client",
    arguments: { query: "calendar", limit: 2 },
  });
});

test("routed tool_search history declares discovered tools and restores their calls", async () => {
  const searchedCall = {
    type: "function_call",
    name: "mcp__calendar__delete_event",
    call_id: "delete-1",
    arguments: JSON.stringify({ id: "evt-1" }),
  };
  const options = {
    requestPayload: routedToolSearchHistoryPayload,
    sseBody: () =>
      [
        sseEvent({ type: "response.output_item.done", item: searchedCall }),
        sseEvent({
          type: "response.completed",
          response: { id: "resp-search", output: [searchedCall] },
        }),
        "data: [DONE]\n\n",
      ].join(""),
    jsonBody: () => ({ id: "resp-search-json", output: [searchedCall] }),
  };

  for (const stream of [true, false]) {
    const result = await scenario(stream, options);
    const outgoing = result.gatewayBodies[0];
    const historyCall = outgoing.input.find(
      (item) => item.call_id === "search-history-1" && item.type === "function_call",
    );
    assert.deepEqual(historyCall, {
      type: "function_call",
      name: "tool_search",
      call_id: "search-history-1",
      arguments: '{"query":"calendar","limit":2}',
    });
    assert.deepEqual(
      outgoing.input.find(
        (item) => item.call_id === "search-history-2" && item.type === "function_call",
      ),
      {
        type: "function_call",
        name: "tool_search",
        call_id: "search-history-2",
        arguments: '{"query":"mail","limit":1}',
      },
    );
    const historyOutput = outgoing.input.find(
      (item) =>
        item.call_id === "search-history-1" && item.type === "function_call_output",
    );
    assert.deepEqual(
      JSON.parse(historyOutput.output).tools.map((tool) => tool.name),
      ["mcp__calendar__delete_event"],
    );
    const secondHistoryOutput = outgoing.input.find(
      (item) =>
        item.call_id === "search-history-2" && item.type === "function_call_output",
    );
    assert.deepEqual(
      JSON.parse(secondHistoryOutput.output).tools.map((tool) => tool.name),
      ["list_messages"],
    );
    assert.equal(
      outgoing.input.some(
        (item) => item.type === "tool_search_call" || item.type === "tool_search_output",
      ),
      false,
      "batched native search history never leaks to a chat-completions provider",
    );
    assert.equal(
      outgoing.tools.filter((tool) => tool.name === "mcp__calendar__create_event").length,
      1,
      "live top-level schemas take precedence over searched history",
    );
    assert.ok(
      outgoing.tools.some((tool) => tool.name === "mcp__calendar__delete_event"),
      "the searched tool is declared to the chat-completions provider",
    );
    assert.ok(outgoing.tools.some((tool) => tool.name === "list_messages"));

    const clientCall = stream
      ? responseItemsFromSse(result.clientBody).find((item) => item.call_id === "delete-1")
      : JSON.parse(result.clientBody).output[0];
    assert.deepEqual(clientCall, {
      type: "function_call",
      name: "delete_event",
      namespace: "mcp__calendar",
      call_id: "delete-1",
      arguments: '{"id":"evt-1"}',
    });
  }
});

test("Responses-native routed providers inherit the model on fresh local thread calls", async () => {
  const options = {
    model: "meta/muse-spark-1.2",
    sseBody: responsesProviderSseBody,
    jsonBody: responsesProviderJsonBody,
    requestPayload: routedToolSearchHistoryPayload,
  };
  const streamed = await scenario(true, options);
  assert.equal(streamed.gatewayBodies[0].model, "meta-muse-spark-1-2");
  assert.ok(
    streamed.gatewayBodies[0].tools.some((tool) => tool?.type === "namespace"),
    "Responses-native tools stay namespaced",
  );
  assert.ok(
    streamed.gatewayBodies[0].tools.some((tool) => tool?.type === "tool_search"),
    "Responses-native tool_search stays native",
  );
  assert.ok(
    streamed.gatewayBodies[0].input.some((item) => item?.type === "tool_search_call"),
    "Responses-native search history is not translated",
  );
  assert.equal(
    streamed.gatewayBodies[0].tools.some((tool) => tool?.name === "list_messages"),
    false,
    "native tool_search_output history remains authoritative without top-level injection",
  );
  const streamedCall = functionCallsFromSse(streamed.clientBody).get("call_native_thread");
  assert.deepEqual(JSON.parse(streamedCall.arguments), {
    prompt: "hi",
    target: { type: "projectless" },
    model: "meta/muse-spark-1.2",
  });

  const nonStreaming = await scenario(false, options);
  const nonStreamingCall = JSON.parse(nonStreaming.clientBody).output[0];
  assert.deepEqual(JSON.parse(nonStreamingCall.arguments), {
    prompt: "hi",
    target: { type: "projectless" },
    model: "meta/muse-spark-1.2",
  });
});

const GO_NAMESPACE = "mcp__codex_apps__github";
const GO_LONG_TOOL = "list_repository_pull_request_review_comments_for_branch";
const GO_DISCOVERED_NAMESPACE = "mcp__calendar_connector_with_a_long_namespace";
const GO_DISCOVERED_TOOL = "delete_an_event_and_notify_every_participant";
const GO_PATCH = "*** Begin Patch\n*** End Patch";

function goCompatibilityRequestPayload(
  stream = true,
  model = "opencode-go-responses/gpt-5.6-luna",
) {
  return {
    model,
    stream,
    tool_choice: { type: "function", name: GO_LONG_TOOL, namespace: GO_NAMESPACE },
    tools: [
      {
        type: "tool_search",
        execution: "client",
        description: "Search deferred tools.",
        parameters: {
          type: "object",
          properties: { query: { type: "string" } },
          required: ["query"],
          additionalProperties: false,
        },
      },
      { type: "function", name: "exec_command", parameters: { type: "object" } },
      {
        type: "namespace",
        name: GO_NAMESPACE,
        tools: [
          {
            type: "function",
            name: GO_LONG_TOOL,
            inputSchema: {
              type: "object",
              properties: {
                branch: { type: "string" },
                node: { $ref: "#/$defs/node" },
              },
              required: ["branch"],
              additionalProperties: false,
              $defs: {
                node: {
                  type: "object",
                  properties: { child: { $ref: "#/$defs/node" } },
                },
              },
            },
          },
        ],
      },
      {
        type: "namespace",
        name: "codex_app",
        tools: [{ type: "function", name: "read_thread_terminal" }],
      },
      {
        type: "custom",
        name: "apply_patch",
        format: { type: "grammar", syntax: "lark", definition: "start: /.+/" },
      },
      {
        type: "custom",
        name: "future_custom",
        description: "FUTURE_CUSTOM_SENTINEL",
      },
      {
        type: "web_search",
        search_content_types: ["text", "image"],
        search_context_size: "medium",
      },
    ],
    input: [
      { type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] },
      {
        type: "function_call",
        name: GO_LONG_TOOL,
        namespace: GO_NAMESPACE,
        call_id: "history-long",
        arguments: '{"branch":"main"}',
      },
      { type: "function_call_output", call_id: "history-long", output: "[]" },
      {
        type: "tool_search_call",
        call_id: "search-long",
        execution: "client",
        arguments: { query: "calendar" },
      },
      {
        type: "tool_search_output",
        call_id: "search-long",
        status: "completed",
        execution: "client",
        tools: [
          {
            type: "namespace",
            name: GO_DISCOVERED_NAMESPACE,
            tools: [{ type: "function", name: GO_DISCOVERED_TOOL }],
          },
        ],
      },
      {
        type: "function_call",
        name: GO_DISCOVERED_TOOL,
        namespace: GO_DISCOVERED_NAMESPACE,
        call_id: "history-discovered",
        arguments: "{}",
      },
      { type: "function_call_output", call_id: "history-discovered", output: "done" },
      {
        type: "custom_tool_call",
        name: "apply_patch",
        call_id: "history-patch",
        input: GO_PATCH,
      },
      { type: "custom_tool_call_output", call_id: "history-patch", output: "Done!" },
      {
        type: "custom_tool_call",
        name: "future_custom",
        call_id: "history-future-custom",
        input: "opaque future input",
      },
      {
        type: "custom_tool_call_output",
        call_id: "history-future-custom",
        output: "future done",
      },
    ],
  };
}

function goProviderCalls(body) {
  const patchTool = body.tools.find(
    (tool) => tool.type === "function" && tool.parameters?.properties?.input,
  );
  return [
    {
      type: "function_call",
      name: body.tool_choice.name,
      call_id: "call-long",
      arguments: '{"branch":"main"}',
    },
    {
      type: "function_call",
      name: "tool_search",
      call_id: "call-search",
      arguments: '{"query":"calendar"}',
    },
    {
      type: "function_call",
      name: patchTool.name,
      call_id: "call-patch",
      arguments: JSON.stringify({ input: GO_PATCH }),
    },
  ];
}

function goCompatibilitySseBody(body) {
  const calls = goProviderCalls(body);
  return [
    ...calls.map((item) => sseEvent({ type: "response.output_item.done", item })),
    sseEvent({
      type: "response.completed",
      response: { id: "resp-go", status: "completed", output: calls },
    }),
    "data: [DONE]\n\n",
  ].join("");
}

function goCompatibilityJsonBody(body) {
  return { id: "resp-go-json", status: "completed", output: goProviderCalls(body) };
}

test("OpenCode Go Responses uses one bounded function-tool contract in both response modes", async () => {
  for (const stream of [true, false]) {
    const result = await scenario(stream, {
      model: "opencode-go-responses/gpt-5.6-luna",
      requestPayload: goCompatibilityRequestPayload,
      sseBody: goCompatibilitySseBody,
      jsonBody: goCompatibilityJsonBody,
    });
    const outgoing = result.gatewayBodies[0];
    assert.equal(outgoing.model, "opencode-go-responses-gpt-5-6-luna");
    assert.ok(
      outgoing.tools.every(
        (tool) => !["namespace", "custom", "tool_search"].includes(tool?.type),
      ),
      "unsupported native tool discriminators do not reach Console Go",
    );
    assert.ok(
      outgoing.tools
        .filter((tool) => tool?.type === "function")
        .every((tool) => tool.name.length <= 64),
      "every provider-visible function name stays within Console Go's cap",
    );
    const webSearch = outgoing.tools.find((tool) => tool.type === "web_search");
    assert.equal("search_content_types" in webSearch, false);
    assert.equal(webSearch.search_context_size, "medium");
    assert.ok(outgoing.tools.some((tool) => tool.type === "function" && tool.name === "tool_search"));
    assert.ok(outgoing.tools.some((tool) => tool.name === "codex_app__read_thread_terminal"));
    assert.equal(
      outgoing.tools.some((tool) => tool.name === "codex_app__create_thread"),
      false,
      "the chat-only deferred app snapshot is not injected on Console Go Responses",
    );
    assert.ok(
      outgoing.tools.some(
        (tool) => tool.type === "function" && tool.parameters?.properties?.input,
      ),
      "the custom patch tool is bridged instead of dropped",
    );
    assert.ok(
      outgoing.tools.some(
        (tool) =>
          tool.type === "function" && tool.description === "FUTURE_CUSTOM_SENTINEL",
      ),
      "Console Go bridges every custom discriminator present in the request",
    );

    const longAlias = outgoing.tool_choice.name;
    assert.equal(outgoing.tool_choice.namespace, undefined);
    assert.ok(longAlias.length <= 64);
    assert.notEqual(longAlias, `${GO_NAMESPACE}__${GO_LONG_TOOL}`);
    const longTool = outgoing.tools.find((tool) => tool.name === longAlias);
    assert.equal(
      longTool.parameters.$defs.node.properties.child.$ref,
      "#/$defs/node",
      "Console Go keeps recursive refs because no upstream rejection established otherwise",
    );
    assert.equal(
      outgoing.input.find((item) => item.call_id === "history-long").name,
      longAlias,
    );
    const discoveredHistory = outgoing.input.find(
      (item) => item.call_id === "history-discovered",
    );
    assert.ok(discoveredHistory.name.length <= 64);
    assert.equal(discoveredHistory.namespace, undefined);
    assert.ok(outgoing.tools.some((tool) => tool.name === discoveredHistory.name));
    assert.equal(
      outgoing.input.find((item) => item.call_id === "search-long").type,
      "function_call",
    );
    assert.equal(
      outgoing.input.some(
        (item) => item.type === "tool_search_call" || item.type === "tool_search_output",
      ),
      false,
    );
    assert.equal(
      outgoing.input.find((item) => item.call_id === "history-patch").type,
      "function_call",
    );
    const futureCustom = outgoing.input.find(
      (item) => item.call_id === "history-future-custom" && item.type === "function_call",
    );
    assert.deepEqual(JSON.parse(futureCustom.arguments), { input: "opaque future input" });

    const clientItems = stream
      ? responseItemsFromSse(result.clientBody)
      : JSON.parse(result.clientBody).output;
    assert.deepEqual(clientItems[0], {
      type: "function_call",
      name: GO_LONG_TOOL,
      namespace: GO_NAMESPACE,
      call_id: "call-long",
      arguments: '{"branch":"main"}',
    });
    assert.deepEqual(clientItems[1], {
      type: "tool_search_call",
      execution: "client",
      call_id: "call-search",
      arguments: { query: "calendar" },
    });
    assert.deepEqual(clientItems[2], {
      type: "custom_tool_call",
      name: "apply_patch",
      call_id: "call-patch",
      input: GO_PATCH,
    });
  }
});

test("OpenCode Go compaction removes native tool history before the strict endpoint", async () => {
  const result = await scenario(false, {
    endpoint: "/responses/compact",
    model: "opencode-go-responses/gpt-5.6-luna",
    requestPayload: (_stream, model) => {
      const ordinary = goCompatibilityRequestPayload(false, model);
      ordinary.input.push(
        {
          type: "custom_tool_call",
          name: "another_custom_tool",
          call_id: "history-other-custom",
          input: "opaque input",
        },
        {
          type: "custom_tool_call_output",
          call_id: "history-other-custom",
          output: "opaque output",
        },
        {
          type: "custom_tool_call_output",
          call_id: "orphan-custom-output",
          output: "must not cross the strict boundary",
        },
      );
      return {
        model,
        tools: [{ type: "custom", name: "future_custom" }],
        tool_choice: { type: "custom", name: "future_custom" },
        input: ordinary.input,
      };
    },
    jsonBody: () => ({
      id: "resp-go-compact",
      status: "completed",
      output: [
        {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "history compacted" }],
        },
      ],
    }),
  });
  const outgoing = result.gatewayBodies[0];
  assert.equal(outgoing.model, "opencode-go-responses-gpt-5-6-luna");
  assert.deepEqual(outgoing.tools, []);
  assert.equal(outgoing.tool_choice, undefined);
  assert.equal(
    outgoing.input.some(
      (item) =>
        ["custom_tool_call", "custom_tool_call_output", "tool_search_call", "tool_search_output"]
          .includes(item?.type) || item?.namespace !== undefined,
    ),
    false,
  );
  assert.equal(
    outgoing.input.some((item) => item.call_id === "search-long"),
    false,
    "deferred search schemas are omitted when compaction sends no live tools",
  );
  assert.ok(
    outgoing.input
      .filter((item) => item?.type === "function_call")
      .every((item) => item.name.length <= 64),
  );
  const namespaced = outgoing.input.find((item) => item.call_id === "history-long");
  assert.equal(namespaced.type, "function_call");
  assert.equal(namespaced.namespace, undefined);
  const custom = outgoing.input.find((item) => item.call_id === "history-patch");
  assert.equal(custom.type, "function_call");
  assert.deepEqual(JSON.parse(custom.arguments), { input: GO_PATCH });
  const otherCustom = outgoing.input.find(
    (item) => item.call_id === "history-other-custom" && item.type === "function_call",
  );
  assert.deepEqual(JSON.parse(otherCustom.arguments), { input: "opaque input" });
  assert.equal(
    outgoing.input.some((item) => item.call_id === "orphan-custom-output"),
    false,
  );
});
