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

test("a generic Responses gateway receives replayed messages without Codex's phase label", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "generic-responses-phase-"));
  const providersFile = path.join(directory, "generic-providers.json");
  const userModelsFile = path.join(directory, "user-models.json");
  const stateDir = path.join(directory, "state");
  const upstreamRequests = [];
  const upstream = await listen(async (request, response) => {
    upstreamRequests.push({ url: request.url, body: await requestJson(request) });
    json(response, 200, {
      id: "resp_generic_1",
      object: "response",
      status: "completed",
      model: upstreamRequests.at(-1).body.model,
      output: [{
        id: "msg_generic_1",
        type: "message",
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text: "ok", annotations: [] }],
      }],
    });
  });
  const model = userModelEntry({
    providerId: "responses-gateway",
    upstreamId: "responses-model",
    priority: 100,
  });
  writeFileSync(providersFile, `${JSON.stringify({
    version: 1,
    providers: [{
      id: "responses-gateway",
      displayName: "Responses Gateway",
      baseUrl: `http://127.0.0.1:${upstream.port}/v1`,
      adapter: "openai-responses",
      headers: {},
      allowPrivate: true,
      enabled: true,
    }],
  }, null, 2)}\n`);
  writeFileSync(userModelsFile, `${JSON.stringify({ version: 1, models: [model] }, null, 2)}\n`);
  const forwarderPort = await openPort();
  const forwarder = runForwarder({
    MODEL_ROUTER_API_PORT: String(forwarderPort),
    MODEL_ROUTER_STATE_DIR: stateDir,
    MODEL_ROUTER_GENERIC_PROVIDERS: providersFile,
    MODEL_ROUTER_USER_MODELS: userModelsFile,
  });
  const commentary = {
    type: "message",
    role: "assistant",
    content: [{ type: "output_text", text: "Checking." }],
  };
  const answer = {
    type: "message",
    role: "assistant",
    content: [{ type: "output_text", text: "Done." }],
  };
  const input = [
    { type: "message", role: "user", content: [{ type: "input_text", text: "Inspect it." }] },
    { ...commentary, phase: "commentary" },
    { type: "function_call", call_id: "call_1", name: "inspect", arguments: "{}" },
    { type: "function_call_output", call_id: "call_1", output: "fine" },
    { ...answer, phase: "final_answer" },
    { type: "message", role: "user", content: [{ type: "input_text", text: "Again." }] },
  ];

  try {
    await waitForForwarder(forwarderPort, forwarder);
    const response = await fetch(`http://127.0.0.1:${forwarderPort}/v1/responses`, {
      method: "POST",
      headers: { Authorization: `Bearer ${INTERNAL_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: `responses/${model.gatewayModel}`, input }),
    });
    assert.equal(response.status, 200, forwarder.testErrors());
    assert.equal((await response.json()).output[0].content[0].text, "ok");

    assert.equal(upstreamRequests.length, 1);
    assert.equal(upstreamRequests[0].url, "/v1/responses");
    const sent = upstreamRequests[0].body;
    assert.equal(sent.model, model.upstreamModel);
    assert.deepEqual(sent.input, [input[0], commentary, input[2], input[3], answer, input[5]]);
  } finally {
    await stop(forwarder);
    await close(upstream.server);
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a generic Responses gateway repairs empty namespace descriptions for strict validators", async () => {
  // From a real strict generic Responses deployment (Azure OpenAI /openai/v1
  // via a generic `openai-responses` provider): Codex serializes some harness
  // namespaces with an empty/missing `description`, which OpenAI accepts
  // leniently but strict validators reject before inference with
  // `Invalid 'input[0].tools[N].description': empty string` (openai/codex#37422)
  // or `Missing required parameter` (openai/codex#37952). The historical
  // failure involved the `image_gen`/`imagegen` surface while collaboration,
  // app, MCP, shell, and ordinary tools carried valid descriptions.
  // The forwarder must repair only the missing contract field -- never delete
  // tools -- so a strict endpoint receives a valid payload with every
  // capability preserved.
  const directory = mkdtempSync(path.join(os.tmpdir(), "generic-responses-namespace-desc-"));
  const providersFile = path.join(directory, "generic-providers.json");
  const userModelsFile = path.join(directory, "user-models.json");
  const stateDir = path.join(directory, "state");
  const upstreamRequests = [];
  const upstream = await listen(async (request, response) => {
    const body = await requestJson(request);
    upstreamRequests.push({ url: request.url, headers: request.headers, body });
    for (let index = 0; index < (body.tools || []).length; index += 1) {
      const tool = body.tools[index];
      if (tool?.type !== "namespace") continue;
      if (!("description" in tool)) {
        json(response, 400, { error: {
          message: `Missing required parameter: 'input[0].tools[${index}].description'.`,
          type: "invalid_request_error", param: `input[0].tools[${index}].description`, code: "missing_required_parameter",
        } });
        return;
      }
      if (typeof tool.description !== "string" || tool.description.length < 1) {
        json(response, 400, { error: {
          message: `Invalid 'input[0].tools[${index}].description': empty string. Expected a string with minimum length 1, but got an empty string instead.`,
          type: "invalid_request_error", param: `input[0].tools[${index}].description`, code: "empty_string",
        } });
        return;
      }
    }
    json(response, 200, {
      id: "resp_strict_1",
      object: "response",
      status: "completed",
      model: body.model,
      output: [{
        id: "msg_strict_1",
        type: "message",
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text: "ok", annotations: [] }],
      }],
    });
  });
  const model = userModelEntry({
    providerId: "strict-gateway",
    upstreamId: "strict-model",
    priority: 100,
  });
  writeFileSync(providersFile, `${JSON.stringify({
    version: 1,
    providers: [{
      id: "strict-gateway",
      displayName: "Strict Gateway",
      baseUrl: `http://127.0.0.1:${upstream.port}/v1`,
      adapter: "openai-responses",
      headers: {},
      allowPrivate: true,
      enabled: true,
    }],
  }, null, 2)}\n`);
  writeFileSync(userModelsFile, `${JSON.stringify({ version: 1, models: [model] }, null, 2)}\n`);
  const forwarderPort = await openPort();
  const forwarder = runForwarder({
    MODEL_ROUTER_API_PORT: String(forwarderPort),
    MODEL_ROUTER_STATE_DIR: stateDir,
    MODEL_ROUTER_GENERIC_PROVIDERS: providersFile,
    MODEL_ROUTER_USER_MODELS: userModelsFile,
  });
  const imageGenInner = {
    type: "function",
    name: "imagegen",
    description: "Generate an image.",
    parameters: { type: "object", properties: { prompt: { type: "string" } }, required: ["prompt"] },
  };
  const collaborationInner = {
    type: "function",
    name: "spawn_agent",
    description: "Spawn a subagent.",
    parameters: { type: "object" },
  };
  const appInner = {
    type: "function",
    name: "create_thread",
    description: "Create a thread.",
    parameters: { type: "object" },
  };
  const mcpInner = {
    type: "function",
    name: "js",
    description: "Run JS.",
    parameters: { type: "object" },
  };
  const shellTool = {
    type: "function",
    name: "exec_command",
    description: "Run a shell command.",
    parameters: { type: "object" },
  };
  const ordinaryTool = {
    type: "function",
    name: "get_weather",
    description: "Get weather.",
    parameters: { type: "object" },
  };
  const tools = [
    { type: "namespace", name: "image_gen", description: "", tools: [imageGenInner] },
    { type: "namespace", name: "collaboration", description: "Collaboration tools.", tools: [collaborationInner] },
    { type: "namespace", name: "codex_app", description: "Tools provided by the Codex app.", tools: [appInner] },
    { type: "namespace", name: "mcp__node_repl", description: "MCP node repl.", tools: [mcpInner] },
    // Missing description is the second strict-validator failure shape (#37952).
    { type: "namespace", name: "mcp__calendar", tools: [{ type: "function", name: "create_event", description: "Create.", parameters: { type: "object" } }] },
    shellTool,
    ordinaryTool,
  ];

  try {
    await waitForForwarder(forwarderPort, forwarder);
    const response = await fetch(`http://127.0.0.1:${forwarderPort}/v1/responses`, {
      method: "POST",
      headers: { Authorization: `Bearer ${INTERNAL_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: `responses/${model.gatewayModel}`,
        input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }],
        tools,
      }),
    });
    assert.equal(response.status, 200, forwarder.testErrors());
    assert.equal((await response.json()).output[0].content[0].text, "ok");

    assert.equal(upstreamRequests.length, 1);
    assert.equal(upstreamRequests[0].url, "/v1/responses");
    const sent = upstreamRequests[0].body;
    assert.equal(sent.model, model.upstreamModel);
    // No credential leakage: generic keyless forwarding sends no auth, and the
    // body must not carry credential material.
    assert.equal(upstreamRequests[0].headers.authorization, undefined);
    assert.ok(!JSON.stringify(sent).includes("cred_"));
    assert.ok(!JSON.stringify(sent).includes(INTERNAL_KEY));

    assert.equal(sent.tools.length, tools.length, "no tool is deleted to make the request pass");
    const byName = new Map(sent.tools.map((tool) => [tool.name, tool]));
    // The strict failure shape is repaired, not removed: image_gen keeps its
    // identity and inner tool, with a non-empty description.
    assert.deepEqual(byName.get("image_gen").tools, [imageGenInner]);
    assert.equal(byName.get("image_gen").type, "namespace");
    assert.ok(typeof byName.get("image_gen").description === "string" && byName.get("image_gen").description.length > 0);
    // A namespace with no description at all is repaired the same way.
    assert.equal(byName.get("mcp__calendar").type, "namespace");
    assert.ok(typeof byName.get("mcp__calendar").description === "string" && byName.get("mcp__calendar").description.length > 0);
    assert.equal(byName.get("mcp__calendar").tools.length, 1);
    // Ordinary, collaboration, MCP, shell/app tools are preserved verbatim.
    assert.deepEqual(byName.get("collaboration"), tools[1]);
    assert.deepEqual(byName.get("codex_app"), tools[2]);
    assert.deepEqual(byName.get("mcp__node_repl"), tools[3]);
    assert.deepEqual(byName.get("exec_command"), shellTool);
    assert.deepEqual(byName.get("get_weather"), ordinaryTool);
  } finally {
    await stop(forwarder);
    await close(upstream.server);
    rmSync(directory, { recursive: true, force: true });
  }
});

test("forwarder preserves types only for curated Moonshot flattening", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "moonshot-flatten-"));
  const userModelsFile = path.join(directory, "user-models.json");
  const bodies = [];
  const upstream = await listen(async (request, response) => {
    bodies.push(await requestJson(request));
    json(response, 200, { id: "test", object: "chat.completion", choices: [
      { index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" },
    ] });
  });
  const models = [
    userModelEntry({ providerId: "kimi-api", upstreamId: "curated-flatten", priority: 100, metadata: { toolSchemaRecursion: "flatten" } }),
    userModelEntry({ providerId: "opencode-go", upstreamId: "flatten-control", priority: 101, metadata: { toolSchemaRecursion: "flatten" } }),
    userModelEntry({ providerId: "opencode-go", upstreamId: "plain-control", priority: 102 }),
  ];
  writeFileSync(userModelsFile, JSON.stringify({ version: 1, models }));
  const port = await openPort();
  const child = runForwarder({
    MODEL_ROUTER_API_PORT: String(port),
    MODEL_ROUTER_STATE_DIR: path.join(directory, "state"),
    MODEL_ROUTER_USER_MODELS: userModelsFile,
    OPENCODE_GO_BASE_URL: `http://127.0.0.1:${upstream.port}/v1`,
    OPENCODE_API_KEY: "test-only-key",
    KIMI_API_KEY: "test-only-key",
    KIMI_API_BASE_URL: `http://127.0.0.1:${upstream.port}/v1`,
    MODEL_ROUTER_QUIET: "0",
  });
  const schema = { type: "object", properties: { root: { $ref: "#/$defs/N" } },
    $defs: { N: { type: "object", properties: { child: { $ref: "#/$defs/N" } } } } };
  try {
    await waitForForwarder(port, child);
    for (const model of models) {
      const response = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
        method: "POST", headers: { Authorization: `Bearer ${INTERNAL_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({ model: model.gatewayModel, messages: [{ role: "user", content: "test" }],
          tools: [{ type: "function", function: { name: "inspect", parameters: schema } }] }),
      });
      assert.equal(response.status, 200, `${await response.text()} ${child.testErrors()}`);
    }
    const edges = bodies.map((body) => body.tools[0].function.parameters.$defs.N.properties.child);
    assert.deepEqual(edges, [{ type: "object" }, {}, { $ref: "#/$defs/N" }]);
  } finally {
    await stop(child);
    await close(upstream.server);
    rmSync(directory, { recursive: true, force: true });
  }
});

test("direct Meta Muse Spark 1.3 Contributor flattens recursive tool schemas", async () => {
  // Issue #792: Meta's direct Responses endpoint answers a Codex turn carrying
  // a self-referencing tool schema with HTTP 400
  // `Recursive JSON schemas are not currently supported` before inference,
  // losing the whole turn downstream of the gateway. The live-verified
  // 1.3-contributor route must break only the cycle-closing edge; the
  // same-provider 1.3 route keeps its schema byte-identical as the control.
  const directory = mkdtempSync(path.join(os.tmpdir(), "meta-recursive-schema-"));
  const bodies = [];
  const upstream = await listen(async (request, response) => {
    bodies.push({ url: request.url, body: await requestJson(request) });
    json(response, 200, {
      id: `resp_meta_${bodies.length}`,
      object: "response",
      status: "completed",
      model: bodies.at(-1).body.model,
      output: [{
        id: "msg_meta_1",
        type: "message",
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text: "ok", annotations: [] }],
      }],
    });
  });
  const port = await openPort();
  const child = runForwarder({
    MODEL_ROUTER_API_PORT: String(port),
    MODEL_ROUTER_STATE_DIR: path.join(directory, "state"),
    META_API_KEY: "test-only-key",
    META_BASE_URL: `http://127.0.0.1:${upstream.port}/v1`,
    MODEL_ROUTER_QUIET: "0",
  });
  const schema = { type: "object", properties: { root: { $ref: "#/$defs/Node" } },
    $defs: { Node: { type: "object", properties: { child: { $ref: "#/$defs/Node" } } } } };
  const send = async (gatewayModel) => {
    const response = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
      method: "POST",
      headers: { Authorization: `Bearer ${INTERNAL_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: `responses/${gatewayModel}`,
        input: [{ role: "user", content: [{ type: "input_text", text: "Use the tool." }] }],
        tools: [{ type: "function", name: "inspect", description: "Inspect.", parameters: schema }],
      }),
    });
    assert.equal(response.status, 200, child.testErrors());
    return response.json();
  };
  try {
    await waitForForwarder(port, child);
    const flattened = await send("meta-muse-spark-1-3-contributor");
    assert.equal(flattened.output[0].content[0].text, "ok");
    const control = await send("meta-muse-spark-1-3");
    assert.equal(control.output[0].content[0].text, "ok");
    assert.equal(bodies.length, 2);
    assert.ok(bodies.every((entry) => entry.url === "/v1/responses"));
    assert.equal(bodies[0].body.model, "muse-spark-1.3-contributor");
    assert.equal(bodies[1].body.model, "muse-spark-1.3");
    // The cycle-closing recursive edge is blanked on the verified route...
    const repaired = bodies[0].body.tools[0].parameters;
    assert.deepEqual(repaired.$defs.Node.properties.child, {});
    // ...while every acyclic edge and the declared type survive...
    assert.deepEqual(repaired.properties.root, { $ref: "#/$defs/Node" });
    assert.equal(repaired.$defs.Node.type, "object");
    // ...and the control route keeps its schema byte-identical.
    assert.deepEqual(bodies[1].body.tools[0].parameters, schema);
  } finally {
    await stop(child);
    await close(upstream.server);
    rmSync(directory, { recursive: true, force: true });
  }
});

test("Meta replaces a replayed empty function-call argument string, and only that", async () => {
  // Measured live: a Muse Spark thread called an MCP tool with no arguments at
  // all (`pattern is required` came back), Codex recorded `arguments: ""`, and
  // every later request in that thread was refused with HTTP 400
  // "`arguments` must be valid JSON" before inference. The repair is scoped to
  // absent/empty/whitespace, so a real but unparseable string is never silently
  // rewritten into a call the model never made.
  const directory = mkdtempSync(path.join(os.tmpdir(), "meta-empty-arguments-"));
  const bodies = [];
  const upstream = await listen(async (request, response) => {
    bodies.push({ url: request.url, body: await requestJson(request) });
    json(response, 200, {
      id: `resp_args_${bodies.length}`,
      object: "response",
      status: "completed",
      model: bodies.at(-1).body.model,
      output: [{
        id: "msg_args_1",
        type: "message",
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text: "ok", annotations: [] }],
      }],
    });
  });
  const port = await openPort();
  const child = runForwarder({
    MODEL_ROUTER_API_PORT: String(port),
    MODEL_ROUTER_STATE_DIR: path.join(directory, "state"),
    META_API_KEY: "test-only-key",
    META_BASE_URL: `http://127.0.0.1:${upstream.port}/v1`,
    MODEL_ROUTER_QUIET: "0",
  });
  const send = async (gatewayModel, arguments_) => {
    const response = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
      method: "POST",
      headers: { Authorization: `Bearer ${INTERNAL_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: `responses/${gatewayModel}`,
        input: [
          { role: "user", content: [{ type: "input_text", text: "hi" }] },
          { type: "function_call", name: "search_code", arguments: arguments_, call_id: "call_a" },
          { type: "function_call_output", call_id: "call_a", output: "pattern is required" },
        ],
      }),
    });
    assert.equal(response.status, 200, child.testErrors());
    return response.json();
  };
  try {
    await waitForForwarder(port, child);
    await send("meta-muse-spark-1-3-contributor", "");
    await send("meta-muse-spark-1-3-contributor", "   ");
    await send("meta-muse-spark-1-3-contributor", '{"pattern":"x",');
    await send("meta-muse-spark-1-3-contributor", '{"pattern":"x"}');
    const sentCall = (index) => bodies[index].body.input.find((item) => item.type === "function_call");
    assert.equal(sentCall(0).arguments, "{}");
    assert.equal(sentCall(1).arguments, "{}");
    // An unparseable non-empty string is a different failure: left as it came.
    assert.equal(sentCall(2).arguments, '{"pattern":"x",');
    assert.equal(sentCall(3).arguments, '{"pattern":"x"}');
  } finally {
    await stop(child);
    await close(upstream.server);
    rmSync(directory, { recursive: true, force: true });
  }
});

test("dashscope-reasoning folds onto the documented ladder and downgrades Qwen's forced tool choice", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "generic-dashscope-reasoning-"));
  const providersFile = path.join(directory, "generic-providers.json");
  const userModelsFile = path.join(directory, "user-models.json");
  const upstreamRequests = [];
  const upstream = await listen(async (request, response) => {
    upstreamRequests.push({ url: request.url, body: await requestJson(request) });
    json(response, 200, {
      id: `resp_dashscope_${upstreamRequests.length}`,
      object: "response",
      status: "completed",
      model: upstreamRequests.at(-1).body.model,
      output: [{
        id: "msg_dashscope_1",
        type: "message",
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text: "ok", annotations: [] }],
      }],
    });
  });
  // Model Studio documents a ladder per upstream family, so the profile has to
  // read the model rather than a single provider-wide table. Kimi K3 is sold by
  // DashScope with no row in that table: it keeps whatever the client sent.
  const models = [
    ["qwen3.8-max", "dashscope-reasoning"],
    ["glm-5.3", "dashscope-reasoning"],
    ["deepseek-v4.1-flash", "dashscope-reasoning"],
    ["deepseek-v4-flash-0731", "dashscope-reasoning"],
    ["kimi-k3", undefined],
  ].map(([upstreamId, requestProfile], index) => userModelEntry({
    providerId: "dashscope",
    upstreamId,
    requestProfile,
    priority: 100 + index,
  }));
  writeFileSync(providersFile, `${JSON.stringify({
    version: 1,
    providers: [{
      id: "dashscope",
      displayName: "Alibaba DashScope",
      baseUrl: `http://127.0.0.1:${upstream.port}/compatible-mode/v1`,
      adapter: "openai-responses",
      headers: {},
      allowPrivate: true,
      enabled: true,
    }],
  }, null, 2)}\n`);
  writeFileSync(userModelsFile, `${JSON.stringify({ version: 1, models }, null, 2)}\n`);
  const forwarderPort = await openPort();
  const forwarder = runForwarder({
    MODEL_ROUTER_API_PORT: String(forwarderPort),
    MODEL_ROUTER_STATE_DIR: path.join(directory, "state"),
    MODEL_ROUTER_GENERIC_PROVIDERS: providersFile,
    MODEL_ROUTER_USER_MODELS: userModelsFile,
  });
  const modelByUpstreamId = new Map(models.map((model) => [model.upstreamModel, model]));

  async function send(upstreamId, effort) {
    const model = modelByUpstreamId.get(upstreamId);
    const response = await fetch(`http://127.0.0.1:${forwarderPort}/v1/responses`, {
      method: "POST",
      headers: { Authorization: `Bearer ${INTERNAL_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: `responses/${model.gatewayModel}`,
        input: [{ role: "user", content: [{ type: "input_text", text: "Think it through." }] }],
        reasoning: { effort },
        tool_choice: "required",
        tools: [{ type: "function", name: "inspect", description: "Inspect.", parameters: { type: "object" } }],
      }),
    });
    assert.equal(response.status, 200, `${await response.text()} ${forwarder.testErrors()}`);
    return upstreamRequests.at(-1).body;
  }

  try {
    await waitForForwarder(forwarderPort, forwarder);
    // Qwen3.8's ladder is none/low/medium/xhigh with xhigh the model default.
    // Codex has no `none`, so `minimal` is the thinking-off rung, and the
    // doc's own fold sends high and max to xhigh.
    assert.deepEqual((await send("qwen3.8-max", "minimal")).reasoning, { effort: "none" });
    assert.deepEqual((await send("qwen3.8-max", "high")).reasoning, { effort: "xhigh" });
    // GLM-5.3 is low/high/max, with the doc sending medium to high and every
    // rung above it to max. `none` is a 400, so an unmapped rung is dropped.
    assert.deepEqual((await send("glm-5.3", "minimal")).reasoning, { effort: "low" });
    assert.deepEqual((await send("glm-5.3", "xhigh")).reasoning, { effort: "max" });
    assert.equal((await send("glm-5.3", "none")).reasoning, undefined);
    // DeepSeek V4.1 Flash is none/high/max: low and medium fold up onto high.
    assert.deepEqual((await send("deepseek-v4.1-flash", "medium")).reasoning, { effort: "high" });
    assert.deepEqual((await send("deepseek-v4.1-flash", "max")).reasoning, { effort: "max" });
    // The dated V4 snapshots document `low` as a real rung, so it must not
    // inherit the undated family's fold of low onto high.
    assert.deepEqual((await send("deepseek-v4-flash-0731", "low")).reasoning, { effort: "low" });
    assert.deepEqual((await send("deepseek-v4-flash-0731", "minimal")).reasoning, { effort: "none" });
    // No row, no fold: the rung the client sent survives byte-identically.
    assert.deepEqual((await send("kimi-k3", "high")).reasoning, { effort: "high" });

    const sent = upstreamRequests.map((entry) => entry.body);
    assert.ok(sent.every((body) => body.reasoning_effort === undefined));
    assert.equal(sent[0].tool_choice, "auto");
    assert.equal(sent[1].tool_choice, "auto");
    for (const body of sent.slice(2)) {
      assert.equal(body.tool_choice, "required");
    }
  } finally {
    await stop(forwarder);
    await close(upstream.server);
    rmSync(directory, { recursive: true, force: true });
  }
});


test("dashscope-reasoning writes the flat spelling on a chat-completions DashScope provider", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "generic-dashscope-chat-"));
  const providersFile = path.join(directory, "generic-providers.json");
  const userModelsFile = path.join(directory, "user-models.json");
  const upstreamRequests = [];
  const upstream = await listen(async (request, response) => {
    upstreamRequests.push(await requestJson(request));
    json(response, 200, {
      id: `chatcmpl_dashscope_${upstreamRequests.length}`,
      object: "chat.completion",
      model: upstreamRequests.at(-1).model,
      choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
    });
  });
  const model = userModelEntry({
    providerId: "dashscope",
    upstreamId: "qwen3.8-max",
    requestProfile: "dashscope-reasoning",
    priority: 100,
  });
  writeFileSync(providersFile, `${JSON.stringify({
    version: 1,
    providers: [{
      id: "dashscope",
      displayName: "Alibaba DashScope",
      baseUrl: `http://127.0.0.1:${upstream.port}/compatible-mode/v1`,
      adapter: "openai-chat",
      headers: {},
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

  try {
    await waitForForwarder(forwarderPort, forwarder);
    const response = await fetch(`http://127.0.0.1:${forwarderPort}/v1/chat/completions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${INTERNAL_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: model.gatewayModel,
        messages: [{ role: "user", content: "Think it through." }],
        reasoning: { effort: "minimal" },
        tool_choice: "required",
        tools: [{
          type: "function",
          function: { name: "inspect", description: "Inspect.", parameters: { type: "object" } },
        }],
      }),
    });
    assert.equal(response.status, 200, `${await response.text()} ${forwarder.testErrors()}`);
    const body = upstreamRequests.at(-1);
    assert.equal(body.reasoning_effort, "none");
    assert.equal(body.reasoning, undefined);
    assert.equal(body.tool_choice, "auto");
  } finally {
    await stop(forwarder);
    await close(upstream.server);
    rmSync(directory, { recursive: true, force: true });
  }
});
