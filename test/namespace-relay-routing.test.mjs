import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import http from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { GROK_PATCH_HOOK_PREFIX, GROK_PATCH_HOOK_HEADER, GROK_PATCH_HOOK_CAPABILITY } from "../src/grok-patch-hook-transport.mjs";
import { callerBaseUrl } from "../src/caller-auth.mjs";
import { GROK_STRUCTURED_PATCH_CODEC, serializeStructuredPatch } from "../src/grok-structured-patch.mjs";
import {
  APPLY_PATCH_TOOL_NAME,
  GROK_APPLY_PATCH_CREATE_EXAMPLE,
  GROK_APPLY_PATCH_GUIDANCE_MARKER,
  GROK_APPLY_PATCH_UPDATE_EXAMPLE,
} from "../src/grok-apply-patch-guidance.mjs";

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

function preflattenedBoundedMcpPayload(
  stream = true,
  model = "opencode-go-responses/gpt-5.6-luna",
) {
  const serverName = "neon__apm__production__snapshot__read_only";
  const namespace = `mcp__${serverName}`;
  const name = "get_monitor_snapshot_with_complete_context";
  return {
    model,
    stream,
    input: [
      { type: "message", role: "user", content: "Call the monitor snapshot tool." },
      {
        type: "function_call",
        namespace,
        name,
        call_id: "call_previous_snapshot",
        arguments: "{}",
      },
      {
        type: "function_call_output",
        call_id: "call_previous_snapshot",
        output: "previous snapshot",
      },
    ],
    tools: [{
      type: "function",
      name: `${namespace}__${name}`,
      description: "Long preflattened MCP fixture.",
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
                source: { kind: "mcp", server_name: serverName },
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
    requestHeaders = {},
    prepareRouterEnv,
    visionJsonBody,
    expectedStatus = 200,
  } = {},
) {
  const gatewayBodies = [];
  const gatewayHeaders = [];
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
      gatewayHeaders.push(request.headers);
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
        ...requestHeaders,
      },
      body: JSON.stringify(requestPayload(stream, model)),
    });
    assert.equal(response.status, expectedStatus, `router status ${response.status}`);
    const clientBody = await response.text();
    return { gatewayBodies, gatewayHeaders, visionBodies, clientBody, router, status: response.status };
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

test("Command Code forced tool choice uses the same bounded alias as its tool", async () => {
  const longName =
    "mcp__openai_api_key_local_confirmation__confirm_openai_api_key_local_destination";
  assert.equal(longName.length, 80);

  for (const model of [
    "commandcode/deepseek-v4-flash",
    "commandcode-messages/claude-fable-5.1",
  ]) {
    const result = await scenario(false, {
      model,
      requestPayload: (stream, routeModel) => ({
        model: routeModel,
        stream,
        input: "Call the required tool.",
        tools: [{
          type: "function",
          name: longName,
          parameters: { type: "object", properties: {}, additionalProperties: false },
        }],
        tool_choice: { type: "function", name: longName },
      }),
      jsonBody: () => ({ id: "commandcode_choice", output: [] }),
    });

    assert.equal(result.gatewayBodies.length, 1, model);
    const outgoing = result.gatewayBodies[0];
    const providerTool = outgoing.tools.find((tool) => tool.name !== "web_search");
    assert.ok(providerTool.name.length <= 64, model);
    assert.notEqual(providerTool.name, longName, model);
    assert.deepEqual(
      outgoing.tool_choice,
      { type: "function", name: providerTool.name },
      model,
    );
  }
});

test("bounded routes preserve one alias for pre-flattened MCP definitions and history", async () => {
  const namespace = "mcp__neon__apm__production__snapshot__read_only";
  const name = "get_monitor_snapshot_with_complete_context";
  const wireName = `${namespace}__${name}`;
  for (const stream of [true, false]) {
    const result = await scenario(stream, {
      model: "opencode-go-responses/gpt-5.6-luna",
      requestPayload: preflattenedBoundedMcpPayload,
      sseBody: (outgoing) => {
        const providerName = outgoing.tools.find(
          (tool) => tool.description === "Long preflattened MCP fixture.",
        ).name;
        return [
          sseEvent({
            type: "response.output_item.done",
            item: {
              type: "function_call",
              name: providerName,
              call_id: "call_snapshot",
              arguments: "{}",
            },
          }),
          sseEvent({ type: "response.completed" }),
          "data: [DONE]\n\n",
        ].join("");
      },
      jsonBody: (outgoing) => {
        const providerName = outgoing.tools.find(
          (tool) => tool.description === "Long preflattened MCP fixture.",
        ).name;
        return {
          id: "resp_preflattened_bounded",
          output: [{
            type: "function_call",
            name: providerName,
            call_id: "call_snapshot",
            arguments: "{}",
          }],
        };
      },
    });
    assert.equal(result.gatewayBodies.length, 1);
    const outgoing = result.gatewayBodies[0];
    assert.equal(outgoing.client_metadata, undefined);
    const providerTool = outgoing.tools.find(
      (tool) => tool.description === "Long preflattened MCP fixture.",
    );
    assert.notEqual(providerTool.name, wireName);
    assert.ok(providerTool.name.length <= 64);
    const historyCall = outgoing.input.find(
      (item) => item.call_id === "call_previous_snapshot",
    );
    assert.equal(historyCall.name, providerTool.name);
    assert.equal(historyCall.namespace, undefined);

    const call = stream
      ? functionCallsFromSse(result.clientBody).get("call_snapshot")
      : JSON.parse(result.clientBody).output[0];
    assert.deepEqual(
      { namespace: call.namespace, name: call.name },
      { namespace, name },
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

// Codex dispatches by the native identity whichever upstream answers, so a
// route that forwards the flat declarations unchanged must still restore the
// call. Without turn metadata nothing identifies an MCP tool, and the flat
// name stays exactly as the provider returned it.
test("Responses-native routes preserve pre-flattened tools and restore call identities", async () => {
  for (const [stream, metadata] of [[true, true], [false, true], [true, false], [false, false]]) {
    const payload = preflattenedCommandCodeMcpPayload(stream, "meta/muse-spark-1.2");
    if (!metadata) delete payload.client_metadata;
    const name = payload.tools[0].name;
    const prior = { type: "function_call", name, call_id: "call_prior", arguments: "{}" };
    payload.input = [
      { type: "message", role: "user", content: "Call the monitor snapshot tool again." },
      prior,
      { type: "function_call_output", call_id: prior.call_id, output: "{}" },
    ];
    payload.tool_choice = { type: "function", name };
    const call = { ...prior, call_id: "call_flat_response" };
    const result = await scenario(stream, {
      model: payload.model,
      requestPayload: () => payload,
      sseBody: () => [
        sseEvent({ type: "response.output_item.done", item: call }),
        sseEvent({ type: "response.completed" }),
        "data: [DONE]\n\n",
      ].join(""),
      jsonBody: () => ({ id: "resp_flat_json", output: [call] }),
    });
    assert.equal(result.gatewayBodies.length, 1);
    const outgoing = result.gatewayBodies[0];
    assert.equal(outgoing.model, "meta-muse-spark-1-2");
    assert.equal(
      JSON.stringify(outgoing.tools),
      JSON.stringify(payload.tools),
      "do not synthesize namespace declarations",
    );
    assert.equal(JSON.stringify(outgoing.input), JSON.stringify(payload.input));
    assert.equal(outgoing.tool_choice, "auto", "retain Meta's existing tool-choice policy");
    const returned = stream
      ? functionCallsFromSse(result.clientBody).get(call.call_id)
      : JSON.parse(result.clientBody).output[0];
    assert.deepEqual(
      returned,
      metadata
        ? { ...call, namespace: "mcp__apmneonsnapshotro", name: "get_monitor_snapshot" }
        : call,
      metadata ? "restore the identity Codex dispatches by" : "never infer from a name prefix",
    );
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
  const longTool = body.tools.find(
    (tool) => tool.type === "function" && tool.parameters?.properties?.branch,
  );
  const patchTool = body.tools.find(
    (tool) => tool.type === "function" && tool.parameters?.properties?.input,
  );
  return [
    {
      type: "function_call",
      name: body.tool_choice?.name || longTool.name,
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
      "other Console Go models keep recursive refs without model-specific evidence",
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

test("OpenCode Go Muse removes recursive tool refs in both response modes", async () => {
  for (const stream of [true, false]) {
    const result = await scenario(stream, {
      model: "opencode-go-responses/muse-spark-1.2-contributor",
      requestPayload: (requestStream, model) => {
        const payload = goCompatibilityRequestPayload(requestStream, model);
        const discovered = payload.input
          .find((item) => item.type === "tool_search_output")
          .tools[0].tools[0];
        discovered.description = "MUSE_RECURSIVE_DISCOVERED_SENTINEL";
        discovered.inputSchema = {
          type: "object",
          properties: { node: { $ref: "#/$defs/node" } },
          $defs: {
            node: {
              type: "object",
              properties: {
                label: { type: "string" },
                child: {
                  $ref: "#/$defs/node",
                  description: "optional child",
                },
              },
            },
          },
        };
        return payload;
      },
      sseBody: goCompatibilitySseBody,
      jsonBody: goCompatibilityJsonBody,
    });
    const outgoing = result.gatewayBodies[0];
    assert.equal(
      outgoing.model,
      "opencode-go-responses-muse-spark-1-2-contributor",
    );
    assert.equal(outgoing.tool_choice, "auto");

    const liveTool = outgoing.tools.find(
      (tool) => tool.parameters?.properties?.branch,
    );
    assert.equal(liveTool.parameters.properties.node.$ref, "#/$defs/node");
    assert.deepEqual(liveTool.parameters.$defs.node.properties.child, {});
    assert.deepEqual(liveTool.inputSchema.$defs.node.properties.child, {});

    const discovered = outgoing.tools.find(
      (tool) => tool.description === "MUSE_RECURSIVE_DISCOVERED_SENTINEL",
    );
    assert.ok(discovered, "stored tool-search definitions remain available");
    assert.equal(discovered.parameters.properties.node.$ref, "#/$defs/node");
    assert.deepEqual(discovered.parameters.$defs.node.properties.child, {
      description: "optional child",
    });
    assert.deepEqual(discovered.inputSchema.$defs.node.properties.child, {
      description: "optional child",
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

const GROK_V4A_GRAMMAR = [
  "start: begin_patch hunk+ end_patch",
  'begin_patch: "*** Begin Patch" LF',
  'end_patch: "*** End Patch" LF?',
  "",
  "hunk: add_hunk | delete_hunk | update_hunk",
  'add_hunk: "*** Add File: " filename LF add_line+',
  "%import common.LF",
].join("\n");

const GROK_PATCH_UNICODE = [
  "*** Begin Patch",
  '*** Add File: café "quotes".txt',
  "+hello “unicode”",
  "*** End Patch",
].join("\n");

function grokApplyPatchPayload(stream, model) {
  return {
    model,
    stream,
    input: [
      { type: "message", role: "user", content: [{ type: "input_text", text: "patch notes" }] },
      {
        type: "custom_tool_call",
        id: "ctc_history",
        call_id: "call_history",
        name: APPLY_PATCH_TOOL_NAME,
        input: "*** Begin Patch\n*** Add File: seed.txt\n+before\n*** End Patch",
      },
      { type: "custom_tool_call_output", call_id: "call_history", output: "Done!" },
    ],
    tools: [
      {
        type: "custom",
        name: APPLY_PATCH_TOOL_NAME,
        description: "Apply a patch.",
        format: { type: "grammar", syntax: "lark", definition: GROK_V4A_GRAMMAR },
      },
      {
        type: "function",
        name: APPLY_PATCH_TOOL_NAME,
        description: "ordinary same-name function",
        parameters: { type: "object", properties: { path: { type: "string" } } },
      },
      { type: "custom", name: "future_custom", description: "leave me" },
    ],
  };
}

function grokApplyPatchSseBody() {
  return [
    sseEvent({
      type: "response.output_item.added",
      item: {
        type: "custom_tool_call",
        id: "ctc_unicode",
        call_id: "call_unicode",
        name: APPLY_PATCH_TOOL_NAME,
        input: "",
      },
    }),
    sseEvent({
      type: "response.custom_tool_call_input.delta",
      item_id: "ctc_unicode",
      delta: GROK_PATCH_UNICODE,
    }),
    sseEvent({
      type: "response.output_item.done",
      item: {
        type: "custom_tool_call",
        id: "ctc_unicode",
        call_id: "call_unicode",
        name: APPLY_PATCH_TOOL_NAME,
        input: GROK_PATCH_UNICODE,
      },
    }),
    sseEvent({ type: "response.completed" }),
    "data: [DONE]\n\n",
  ].join("");
}

test("Grok 4.6 OAuth annotates native custom apply_patch and leaves history, collisions, and other models alone", async () => {
  const guided = await scenario(true, {
    model: "grok-oauth/grok-4.6",
    requestPayload: grokApplyPatchPayload,
    sseBody: grokApplyPatchSseBody,
  });
  const outgoing = guided.gatewayBodies[0];
  const custom = outgoing.tools.find((tool) => tool.type === "custom" && tool.name === APPLY_PATCH_TOOL_NAME);
  const ordinary = outgoing.tools.find((tool) => tool.type === "function" && tool.name === APPLY_PATCH_TOOL_NAME);
  const otherCustom = outgoing.tools.find((tool) => tool.type === "custom" && tool.name === "future_custom");
  assert.ok(custom, "native custom apply_patch still reaches LiteLLM as a custom tool");
  assert.equal(custom.description.startsWith("Apply a patch."), true);
  assert.equal(custom.description.includes(GROK_APPLY_PATCH_GUIDANCE_MARKER), true);
  assert.equal(custom.description.includes(GROK_APPLY_PATCH_CREATE_EXAMPLE), true);
  assert.equal(custom.description.includes(GROK_APPLY_PATCH_UPDATE_EXAMPLE), true);
  assert.doesNotMatch(custom.description, /```/);
  assert.deepEqual(custom.format, {
    type: "grammar",
    syntax: "lark",
    definition: GROK_V4A_GRAMMAR,
  });
  assert.deepEqual(ordinary.description, "ordinary same-name function");
  assert.equal(ordinary.description.includes(GROK_APPLY_PATCH_GUIDANCE_MARKER), false);
  assert.deepEqual(otherCustom.description, "leave me");
  const history = outgoing.input.find((item) => item.call_id === "call_history");
  assert.equal(history.type, "custom_tool_call");
  assert.equal(history.id, "ctc_history");
  assert.equal(history.name, APPLY_PATCH_TOOL_NAME);
  assert.equal(history.input, "*** Begin Patch\n*** Add File: seed.txt\n+before\n*** End Patch");
  const restoredByCallId = new Map();
  for (const item of responseItemsFromSse(guided.clientBody)) {
    if (item?.call_id) restoredByCallId.set(item.call_id, item);
  }
  const restored = restoredByCallId.get("call_unicode");
  assert.equal(restored.type, "custom_tool_call");
  assert.equal(restored.id, "ctc_unicode");
  assert.equal(restored.input, GROK_PATCH_UNICODE);

  const unguided = await scenario(true, {
    model: "grok-oauth/grok-4.5",
    requestPayload: grokApplyPatchPayload,
    sseBody: grokApplyPatchSseBody,
  });
  const control = unguided.gatewayBodies[0].tools.find(
    (tool) => tool.type === "custom" && tool.name === APPLY_PATCH_TOOL_NAME,
  );
  assert.equal(control.description, "Apply a patch.");
  assert.deepEqual(control.format, {
    type: "grammar",
    syntax: "lark",
    definition: GROK_V4A_GRAMMAR,
  });
  assert.equal(control.description.includes(GROK_APPLY_PATCH_GUIDANCE_MARKER), false);
});

const STRUCTURED_OPERATIONS = {
  operations: [{ op: "add", path: 'café "quotes".txt', lines: ["hello “unicode”"] }],
};
function structuredPatchCall(body) {
  const tool = body.tools.find((tool) => tool.parameters?.properties?.operations);
  assert.ok(tool, "the Router must declare the structured tool to the gateway");
  return {
    type: "function_call", id: "fc_structured", call_id: "call_structured",
    name: tool.name, arguments: JSON.stringify(STRUCTURED_OPERATIONS),
  };
}
function structuredPatchSse(body) {
  const call = structuredPatchCall(body);
  return [
    sseEvent({ type: "response.output_item.added", output_index: 0, item: { ...call, arguments: "" } }),
    sseEvent({ type: "response.function_call_arguments.delta", item_id: call.id, output_index: 0, delta: call.arguments }),
    sseEvent({ type: "response.function_call_arguments.done", item_id: call.id, output_index: 0, arguments: call.arguments }),
    sseEvent({ type: "response.output_item.done", output_index: 0, item: call }),
    sseEvent({ type: "response.completed", response: { output: [call] } }),
    "data: [DONE]\n\n",
  ].join("");
}

test("Grok structured patch opt-in crosses the real Router with collision, choice and historical identity intact", async () => {
  for (const stream of [true, false]) {
    const result = await scenario(stream, {
      model: "grok-oauth/grok-4.6",
      routerEnv: { CODEX_ROUTER_GROK_STRUCTURED_PATCH: "1" },
      requestPayload: (stream, model) => ({ ...grokApplyPatchPayload(stream, model), tool_choice: { type: "custom", name: "apply_patch" } }),
      sseBody: structuredPatchSse,
      jsonBody: (body) => ({ id: "response_structured", output: [structuredPatchCall(body)] }),
    });
    assert.equal(result.gatewayBodies.length, 1, "one request, no hidden model retry");
    const outgoing = result.gatewayBodies[0];
    const tool = outgoing.tools.find((tool) => tool.parameters?.properties?.operations);
    assert.deepEqual(tool.parameters, GROK_STRUCTURED_PATCH_CODEC.parameters);
    assert.notEqual(tool.name, "apply_patch", "ordinary same-name function keeps its name");
    assert.equal(outgoing.tools.find((tool) => tool.name === "apply_patch").description, "ordinary same-name function");
    assert.deepEqual(outgoing.tools.find((tool) => tool.name === "future_custom"), { type: "custom", name: "future_custom", description: "leave me" });
    assert.deepEqual(outgoing.tool_choice, { type: "function", name: tool.name });
    const old = outgoing.input.find((item) => item.call_id === "call_history");
    assert.equal(old.name, tool.name);
    assert.equal(old.id, "ctc_history");
    assert.equal(JSON.parse(old.arguments).input, grokApplyPatchPayload(stream, outgoing.model).input[1].input);
    assert.deepEqual(outgoing.input.find((item) => item.type === "function_call_output"), { type: "function_call_output", call_id: "call_history", output: "Done!" });
    const items = stream ? responseItemsFromSse(result.clientBody) : JSON.parse(result.clientBody).output;
    const restored = items.filter((item) => item.call_id === "call_structured").at(-1);
    assert.deepEqual(restored, { type: "custom_tool_call", id: "fc_structured", call_id: "call_structured", name: "apply_patch", input: serializeStructuredPatch(STRUCTURED_OPERATIONS) });
    assert.equal(result.clientBody.includes('"operations"'), false);
  }
});

test("the enabled flag leaves another route and undeclared native patch requests unchanged", async () => {
  const control = await scenario(true, {
    model: "grok-oauth/grok-4.5",
    routerEnv: { CODEX_ROUTER_GROK_STRUCTURED_PATCH: "1" },
    requestPayload: grokApplyPatchPayload,
    sseBody: grokApplyPatchSseBody,
  });
  const disabled = await scenario(true, {
    model: "grok-oauth/grok-4.5",
    routerEnv: { CODEX_ROUTER_GROK_STRUCTURED_PATCH: "0" },
    requestPayload: grokApplyPatchPayload,
    sseBody: grokApplyPatchSseBody,
  });
  assert.deepEqual(control.gatewayBodies, disabled.gatewayBodies);
  assert.equal(control.clientBody, disabled.clientBody);
  const undeclared = await scenario(false, {
    model: "grok-oauth/grok-4.6",
    routerEnv: { CODEX_ROUTER_GROK_STRUCTURED_PATCH: "1" },
    requestPayload: (stream, model) => {
      const payload = grokApplyPatchPayload(stream, model);
      payload.tools = payload.tools.filter((tool) => tool.type !== "custom" || tool.name !== "apply_patch");
      return payload;
    },
    jsonBody: () => ({ id: "response_no_patch", output: [{ type: "message", content: [{ type: "output_text", text: "ok" }] }] }),
  });
  assert.equal(undeclared.gatewayBodies[0].tools.some((tool) => tool.parameters?.properties?.operations), false);
  assert.equal(undeclared.gatewayBodies[0].input.find((item) => item.call_id === "call_history").type, "custom_tool_call");
});

test("negotiated hook crosses real Router with exact raw history and native framing", async () => {
  for (const stream of [false, true]) {
    const raw = ' \n{"operations":[],"number":1.0,"escaped":"\\u0061","unicode":"🧙"}\n';
    const result = await scenario(stream, {
      model: "grok-oauth/grok-4.6",
      routerEnv: { CODEX_ROUTER_GROK_PATCH_HOOK: "1" },
      requestHeaders: { [GROK_PATCH_HOOK_HEADER]: GROK_PATCH_HOOK_CAPABILITY },
      requestPayload: (stream, model) => {
        const payload = grokApplyPatchPayload(stream, model);
        payload.input[1].input = GROK_PATCH_HOOK_PREFIX + raw;
        payload.input[2].output = "Native hook denied invalid arguments";
        payload.tool_choice = { type: "custom", name: "apply_patch" };
        return payload;
      },
      jsonBody: body => ({ output: [{ ...structuredPatchCall(body), arguments: raw }] }),
      sseBody: body => {
        const call = { ...structuredPatchCall(body), arguments: raw };
        return sseEvent({ type: "response.output_item.done", item: call }) + sseEvent({ type: "response.completed", response: { output: [call] } });
      },
    });
    assert.equal(result.gatewayBodies.length, 1);
    assert.equal(result.gatewayHeaders[0][GROK_PATCH_HOOK_HEADER], undefined, "client capability must not leak to provider");
    const outgoing = result.gatewayBodies[0];
    const declared = outgoing.tools.find(t => t.parameters?.properties?.operations);
    assert.ok(declared);
    assert.notEqual(declared.name, "apply_patch");
    assert.equal(outgoing.input.find(i => i.call_id === "call_history").arguments, raw);
    assert.deepEqual(outgoing.tool_choice, { type: "function", name: declared.name });
    assert.deepEqual(outgoing.input.find(i => i.type === "function_call_output"), { type: "function_call_output", call_id: "call_history", output: "Native hook denied invalid arguments" });
    const items = stream ? responseItemsFromSse(result.clientBody) : JSON.parse(result.clientBody).output;
    assert.deepEqual(items.filter(i => i.call_id === "call_structured").at(-1), { type: "custom_tool_call", id: "fc_structured", call_id: "call_structured", name: "apply_patch", input: GROK_PATCH_HOOK_PREFIX + raw });
  }
});

test("real Router requires both hook opt-ins and exact model, without affecting v2", async () => {
  for (const [model, flag, declaration, old] of [
    ["grok-oauth/grok-4.6", "1", undefined, false],
    ["grok-oauth/grok-4.6", "0", GROK_PATCH_HOOK_CAPABILITY, false],
    ["grok-oauth/grok-4.6", "1", "structured-patch-v2", false],
    ["grok-oauth/grok-4.5", "1", GROK_PATCH_HOOK_CAPABILITY, false],
    ["grok-oauth/grok-4.6", "1", undefined, true],
  ]) {
    const result = await scenario(false, {
      model, routerEnv: { CODEX_ROUTER_GROK_PATCH_HOOK: flag, CODEX_ROUTER_GROK_STRUCTURED_PATCH: old ? "1" : "0" },
      requestHeaders: declaration ? { [GROK_PATCH_HOOK_HEADER]: declaration } : {},
      requestPayload: grokApplyPatchPayload,
      jsonBody: body => ({ output: old ? [structuredPatchCall(body)] : [] }),
    });
    assert.equal(result.gatewayBodies[0].tools.some(t => t.parameters?.properties?.operations), old);
    if (old) assert.equal(JSON.parse(result.clientBody).output[0].input, serializeStructuredPatch(STRUCTURED_OPERATIONS));
  }
});

test("routed turns label assistant messages the way native turns do", async () => {
  const assistantMessage = (id, text) => ({
    id,
    type: "message",
    role: "assistant",
    status: "completed",
    content: [{ type: "output_text", text, annotations: [] }],
  });
  const messageEvents = (index, item) => [
    sseEvent({ type: "response.output_item.added", output_index: index, item: { ...item, content: [] } }),
    sseEvent({ type: "response.output_text.delta", output_index: index, item_id: item.id, delta: item.content[0].text }),
    sseEvent({ type: "response.output_item.done", output_index: index, item }),
  ];
  const lastMessage = (body, id) =>
    responseItemsFromSse(body).filter((item) => item.type === "message" && item.id === id).at(-1);

  const toolTurn = await scenario(true, {
    model: "opencode-go/deepseek-v4.1-flash",
    sseBody: () => [
      sseEvent({ type: "response.created", response: { id: "resp_note" } }),
      ...messageEvents(0, assistantMessage("msg_note", "Checking the config.")),
      sseEvent({
        type: "response.output_item.added",
        output_index: 1,
        item: { type: "function_call", name: "exec_command", call_id: "call_exec", arguments: "" },
      }),
      sseEvent({
        type: "response.output_item.done",
        output_index: 1,
        item: { type: "function_call", name: "exec_command", call_id: "call_exec", arguments: "{}" },
      }),
      sseEvent({ type: "response.completed", response: { id: "resp_note", output: [] } }),
      "data: [DONE]\n\n",
    ].join(""),
  });
  assert.equal(lastMessage(toolTurn.clientBody, "msg_note").phase, "commentary");
  assert.equal(functionCallsFromSse(toolTurn.clientBody).get("call_exec").phase, undefined);

  const answerTurn = await scenario(true, {
    model: "opencode-go/deepseek-v4.1-flash",
    sseBody: () => [
      sseEvent({ type: "response.created", response: { id: "resp_answer" } }),
      ...messageEvents(0, assistantMessage("msg_answer", "Done.")),
      sseEvent({ type: "response.completed", response: { id: "resp_answer", output: [] } }),
      "data: [DONE]\n\n",
    ].join(""),
  });
  assert.equal(lastMessage(answerTurn.clientBody, "msg_answer").phase, "final_answer");
});

test("routed native apply_patch relays LiteLLM arguments that are not a leading content wrapper", async () => {
  const patch = "*** Begin Patch\n*** Update File: src/a.js\n@@\n-const a = 1;\n+const re = /\\d+/;\n*** End Patch";
  // What pinned LiteLLM 1.96 emits when the provider's arguments are not a
  // leading {"content": ...} wrapper: legacy argument events carry the
  // provider text verbatim, and the completed custom_tool_call carries
  // unwrap_custom_tool_arguments() of it.
  const calls = [
    { id: "call_input_key", arguments: JSON.stringify({ input: patch }), input: JSON.stringify({ input: patch }) },
    { id: "call_content_second", arguments: JSON.stringify({ path: "src/a.js", content: patch }), input: patch },
  ];
  const sseBody = () => [
    sseEvent({ type: "response.created", response: { id: "resp_litellm_custom" } }),
    ...calls.flatMap((call, index) => [
      sseEvent({
        type: "response.output_item.added",
        output_index: index,
        item: { type: "custom_tool_call", id: call.id, call_id: call.id, name: "apply_patch", input: "", status: "in_progress" },
      }),
      ...call.arguments.match(/[\s\S]{1,10}/g).map((delta) => sseEvent({
        type: "response.function_call_arguments.delta",
        output_index: index,
        item_id: call.id,
        delta,
      })),
      sseEvent({
        type: "response.function_call_arguments.done",
        output_index: index,
        item_id: call.id,
        arguments: call.arguments,
      }),
      sseEvent({
        type: "response.output_item.done",
        output_index: index,
        item: { type: "custom_tool_call", id: call.id, call_id: call.id, name: "apply_patch", input: call.input, status: "completed" },
      }),
    ]),
    sseEvent({ type: "response.completed", response: { id: "resp_litellm_custom", output: [] } }),
    "data: [DONE]\n\n",
  ].join("");
  const result = await scenario(true, {
    model: "opencode-go/deepseek-v4.1-flash",
    requestPayload: (stream, model) => ({
      model,
      stream,
      input: "Apply the patch.",
      tools: [{
        type: "custom",
        name: "apply_patch",
        description: "Apply a patch.",
        format: { type: "grammar", syntax: "lark", definition: "start: /[\\s\\S]+/" },
      }],
    }),
    sseBody,
  });
  assert.ok(
    result.gatewayBodies[0].tools.some((tool) => tool.type === "custom" && tool.name === "apply_patch"),
    "native apply_patch still reaches LiteLLM as a custom tool",
  );
  const events = result.clientBody.split(/\r?\n/)
    .filter((line) => line.startsWith("data: {"))
    .map((line) => JSON.parse(line.slice(6)));
  assert.equal(events.some((event) => event.type === "error" || event.type === "response.failed"), false);
  assert.ok(events.some((event) => event.type === "response.completed"), "the turn completes instead of aborting");
  for (const call of calls) {
    const inputDone = events.find((event) =>
      event.type === "response.custom_tool_call_input.done" && event.item_id === call.id);
    assert.equal(inputDone?.input, call.input, `${call.id} input.done`);
    const closed = events.find((event) =>
      event.type === "response.output_item.done" && event.item?.call_id === call.id);
    assert.equal(closed.item.type, "custom_tool_call");
    assert.equal(closed.item.input, call.input, `${call.id} item input`);
  }
});

test("a routed turn whose tool calls leaked into the reasoning channel still runs them", async () => {
  // Captured from rollout 01a0924e (opencode-go hy4-preview, 12 September 2026):
  // the model wrote its calls as text on the reasoning channel, nothing reached
  // the tool_calls array, and Codex ended the turn on an empty assistant
  // message -- "Worked for 3m 58s" with no answer under it.
  const n = "6124c78e";
  const leaked =
    "Boot is running. Let me keep reading the behavior code while it comes up." +
    `<tool_calls:${n}><tool_call:${n}>exec_command` +
    `<arg_key:${n}>cmd</arg_key:${n}><arg_value:${n}>tail -5 .qa/eo-up.log</arg_value:${n}>` +
    `<arg_key:${n}>workdir</arg_key:${n}><arg_value:${n}>/tmp/eo</arg_value:${n}>` +
    `</tool_call:${n}></tool_calls:${n}>`;
  const emptyMessage = {
    id: "msg_blank",
    type: "message",
    role: "assistant",
    status: "completed",
    content: [],
  };
  const result = await scenario(true, {
    // The route the capture came from. Recovery is Hy4-only on purpose: this
    // markup is Hy4's native tool-call syntax, and scanning every routed
    // provider's text for it would turn prose that merely quotes it into
    // executed calls.
    model: "opencode-go/hy4-preview",
    sseBody: () => [
      sseEvent({ type: "response.created", response: { id: "resp_leak" } }),
      sseEvent({
        type: "response.output_item.added",
        output_index: 0,
        item: { type: "reasoning", id: "rs_leak", summary: [] },
      }),
      sseEvent({
        type: "response.reasoning_summary_text.delta",
        output_index: 0,
        item_id: "rs_leak",
        delta: leaked,
      }),
      sseEvent({
        type: "response.reasoning_summary_text.done",
        output_index: 0,
        item_id: "rs_leak",
        text: leaked,
      }),
      sseEvent({
        type: "response.output_item.done",
        output_index: 0,
        item: { type: "reasoning", id: "rs_leak", summary: [{ type: "summary_text", text: leaked }] },
      }),
      sseEvent({ type: "response.output_item.added", output_index: 1, item: emptyMessage }),
      sseEvent({ type: "response.output_item.done", output_index: 1, item: emptyMessage }),
      sseEvent({ type: "response.completed", response: { id: "resp_leak", output: [] } }),
      "data: [DONE]\n\n",
    ].join(""),
  });

  const calls = [...functionCallsFromSse(result.clientBody).values()];
  assert.equal(calls.length, 1, "the leaked call reaches Codex as a real tool call");
  assert.equal(calls[0].name, "exec_command");
  assert.deepEqual(JSON.parse(calls[0].arguments), {
    cmd: "tail -5 .qa/eo-up.log",
    workdir: "/tmp/eo",
  });
  // The markup itself never reaches the client, and the reasoning it was buried
  // in still does.
  assert.ok(!result.clientBody.includes("arg_key"));
  assert.ok(!result.clientBody.includes("tool_calls:"));
  assert.ok(result.clientBody.includes("Let me keep reading the behavior code"));
  // The recovered call lands before the turn closes, so the blank message is
  // labelled commentary rather than becoming the turn's final answer.
  const blank = responseItemsFromSse(result.clientBody)
    .filter((item) => item.type === "message" && item.id === "msg_blank")
    .at(-1);
  assert.equal(blank.phase, "commentary");
});

test("hy4's prior reasoning is replayed as thinking, never as its own visible prose", async () => {
  // Rollout 01a0928e (opencode-go hy4-preview, 12 September 2026): once the
  // model's past reasoning was replayed to it as ordinary assistant text, it
  // stopped using the reasoning channel (174 reasoning tokens -> 0 at one
  // step) and looped on its last progress note -- 2, 4, 5, 8, then 16 copies.
  const history = [
    { type: "message", role: "user", content: [{ type: "input_text", text: "why is the NPC life awkward?" }] },
    {
      type: "reasoning",
      id: "rs_prior",
      summary: [{ type: "summary_text", text: "PRIOR_THINKING: look at the locomotion code first." }],
    },
    {
      type: "message",
      role: "assistant",
      id: "msg_prior",
      content: [{ type: "output_text", text: "Let me read the locomotion code." }],
    },
    { type: "function_call", name: "exec_command", call_id: "call_prior", arguments: '{"cmd":"ls src"}' },
    { type: "function_call_output", call_id: "call_prior", output: "pedestrians.js" },
  ];
  const outgoingFor = async (model) => {
    const result = await scenario(true, {
      model,
      requestPayload: (stream, slug) => ({ model: slug, stream, input: history }),
    });
    return result.gatewayBodies[0];
  };

  // Hy4 by profile, and the same rule reached by upstream family on routes
  // whose profiles say nothing about replay (GLM has no profile here, Kimi K3
  // carries a sampling profile).
  for (const slug of ["opencode-go/hy4-preview", "opencode-go/glm-5.3", "opencode-go/kimi-k3"]) {
    const outgoing = await outgoingFor(slug);
    const assistant = outgoing.input.find((item) => item.type === "message" && item.role === "assistant");
    assert.ok(assistant, `${slug}: the assistant turn survives`);
    const parts = assistant.content.map((part) => `${part.type}:${part.text}`);
    assert.deepEqual(parts, [
      "thinking:PRIOR_THINKING: look at the locomotion code first.",
      "output_text:Let me read the locomotion code.",
    ], slug);
    assert.equal(
      outgoing.input.some((item) => item.type === "reasoning"),
      false,
      `${slug}: the carried reasoning item is consumed, so it cannot also become a user message`,
    );
  }

  // A chat route with no thinking contract keeps the old shape: reasoning is
  // merged as text, since LiteLLM would otherwise drop it.
  const plain = await outgoingFor("opencode-go/kimi-k2.6");
  const plainAssistant = plain.input.find((item) => item.type === "message" && item.role === "assistant");
  assert.equal(plainAssistant.content[0].type, "output_text");
  assert.equal(plainAssistant.content[0].text, "PRIOR_THINKING: look at the locomotion code first.");
});
