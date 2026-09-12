import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { callerBaseUrl } from "../src/caller-auth.mjs";
import { childOutput, waitForListeners } from "./listener-readiness.mjs";
import { openPort } from "./port-pool.mjs";

import {
  deepSeekCustomToolNames,
  deepSeekResponsesEffort,
  deepSeekResponsesInput,
  usesDeepSeekResponses,
} from "../src/deepseek-responses.mjs";
import { providerForModel } from "../src/model-registry.mjs";

test("native Responses is confined to the current direct DeepSeek Flash model", () => {
  const current = { provider: "deepseek", upstreamModel: "deepseek-flash" };
  assert.equal(usesDeepSeekResponses(current), true);
  const native = providerForModel(current);
  const legacy = providerForModel({ ...current, upstreamModel: "deepseek-v4-flash" });
  assert.deepEqual(native, { ...legacy, protocol: "openai-responses" });
  for (const model of [
    { ...current, upstreamModel: "deepseek-v4-flash" },
    { ...current, upstreamModel: "deepseek-chat" },
    { ...current, provider: "opencode-go" },
    { ...current, provider: "commandcode" },
    undefined,
  ]) assert.equal(usesDeepSeekResponses(model), false);
});

test("native DeepSeek effort aliases follow the current endpoint contract", () => {
  for (const [input, expected] of [
    ["none", "none"], ["minimal", "low"], ["low", "low"],
    ["medium", "high"], ["high", "high"], ["xhigh", "high"],
    ["max", "max"], ["ultra", "max"], [undefined, "high"],
  ]) assert.equal(deepSeekResponsesEffort(input), expected);
});

test("native reasoning replays once without becoming visible message text", () => {
  const answer = { type: "message", role: "assistant", content: "visible answer" };
  const input = [
    { type: "reasoning", content: [{ type: "reasoning_text", text: "full reasoning" }, { type: "reasoning_text", text: "second part" }], summary: [{ text: "partial summary" }] },
    answer,
    { type: "reasoning", summary: [{ text: "legacy summary" }], encrypted_content: "opaque" },
    { type: "reasoning", content: "legacy plaintext" },
    { type: "reasoning", summary: "legacy string summary", content: null },
    { type: "reasoning", encrypted_content: "opaque" },
  ];
  const original = structuredClone(input);
  const normalized = deepSeekResponsesInput(input);
  assert.deepEqual(normalized, [
    { type: "reasoning", content: [{ type: "reasoning_text", text: "full reasoning" }, { type: "reasoning_text", text: "second part" }] }, answer,
    { type: "reasoning", content: [{ type: "reasoning_text", text: "legacy summary" }] },
    { type: "reasoning", content: [{ type: "reasoning_text", text: "legacy plaintext" }] },
    { type: "reasoning", content: [{ type: "reasoning_text", text: "legacy string summary" }] },
  ]);
  assert.deepEqual(deepSeekResponsesInput(normalized), normalized, "router and forwarder normalization must be idempotent");
  assert.deepEqual(input, original);
  assert.equal(deepSeekResponsesInput("plain prompt"), "plain prompt");
});

test("only unsupported custom tools require the function bridge", () => {
  assert.deepEqual(deepSeekCustomToolNames(
    [{ type: "custom", name: "apply_patch" }, { type: "custom", name: "exec" }],
    [{ type: "custom_tool_call", name: "older_tool" }],
    { type: "custom", name: "exec" },
  ), ["exec", "older_tool"]);
});

test("native DeepSeek receives delegated tasks as supported user messages", () => {
  const content = [
    { type: "input_text", text: "Message Type: NEW_TASK\nPayload:\n" },
    { type: "input_text", text: "Preserve this bounded task exactly.\nSecond line." },
    { type: "input_image", file_id: "file-reference" },
  ];
  const input = [{ type: "agent_message", author: "/root", recipient: "/root/worker", content }];
  const original = structuredClone(input);
  const normalized = deepSeekResponsesInput(input);
  assert.deepEqual(normalized, [{ type: "message", role: "user", content }]);
  assert.deepEqual(deepSeekResponsesInput(normalized), normalized);
  assert.deepEqual(input, original);
});

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const INTERNAL_KEY = "test-internal-service-key-with-sufficient-length";
const CALLER_KEY = "test-router-caller-capability-with-sufficient-length";
const MODEL = "deepseek/deepseek-v4.1-flash";
const TEXT = "Both checks pass. Final content check complete.";
const REASONING = "The synthetic pixel was inspected.";
const IMAGE = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAAY0lEQVR4nO3PQQ3AIADAQEALAhGJsIngcVnSU9DOfe74s6UDXjWgNaA1oDWgNaA1oDWgNaA1oDWgNaA1oDWgNaA1oDWgNaA1oDWgNaA1oDWgNaA1oDWgNaA1oDWgNaA1oDWgfRdzAdh+IIyPAAAAAElFTkSuQmCC";

async function server(handler) {
  const instance = http.createServer(handler);
  await new Promise((resolve) => instance.listen(0, "127.0.0.1", resolve));
  return instance;
}

async function readJson(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks));
}

function frames(toolName, { custom = false, customInput = false } = {}) {
  const events = [];
  const add = (type, fields) => events.push({ type, sequence_number: events.length, ...fields });
  const response = { id: "resp_fixture", object: "response", created_at: 1, model: "deepseek-flash", status: "in_progress", output: [] };
  add("response.created", { response });
  add("response.in_progress", { response });
  const output = [];
  for (const [index, type, id, text] of [
    [0, "reasoning", "rs_fixture", REASONING],
    [1, "message", "msg_fixture", TEXT],
  ]) {
    const item = { type, id, status: "in_progress", ...(type === "message" ? { role: "assistant" } : {}), content: [] };
    const partType = type === "reasoning" ? "reasoning_text" : "output_text";
    const part = { type: partType, text, ...(type === "message" ? { annotations: [] } : {}) };
    const fields = { output_index: index, item_id: id, content_index: 0 };
    add("response.output_item.added", { output_index: index, item });
    add("response.content_part.added", { ...fields, part: { ...part, text: "" } });
    for (const delta of [text.slice(0, 11), text.slice(11)]) add(`response.${partType}.delta`, { ...fields, delta });
    add(`response.${partType}.done`, { ...fields, text });
    add("response.content_part.done", { ...fields, part });
    const completed = { ...item, status: "completed", content: [part] };
    add("response.output_item.done", { output_index: index, item: completed });
    output.push(completed);
  }
  if (toolName) {
    const value = custom ? "*** Begin Patch\n*** End Patch" : customInput ? '{"input":"synthetic raw input"}' : '{"ok":true}';
    const field = custom ? "input" : "arguments";
    const kind = custom ? "custom_tool_call_input" : "function_call_arguments";
    const item = { type: custom ? "custom_tool_call" : "function_call", id: "fc_fixture", call_id: "call_fixture", name: toolName, [field]: "", status: "in_progress" };
    add("response.output_item.added", { output_index: 2, item });
    for (const delta of [value.slice(0, 4), value.slice(4)]) {
      add(`response.${kind}.delta`, { output_index: 2, item_id: item.id, delta });
    }
    add(`response.${kind}.done`, { output_index: 2, item_id: item.id, [field]: value });
    const completed = { ...item, status: "completed", [field]: value };
    add("response.output_item.done", { output_index: 2, item: completed });
    output.push(completed);
  }
  add("response.completed", { response: { ...response, status: "completed", output, usage: {
    input_tokens: 1234, output_tokens: 25, total_tokens: 1259,
    input_tokens_details: { cached_tokens: 1000 }, output_tokens_details: { reasoning_tokens: 7 },
  } } });
  return events;
}

function parseEvents(body) {
  return body.split(/\r?\n\r?\n/).flatMap((frame) => {
    const data = frame.split(/\r?\n/).filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart()).join("\n");
    if (!data || data === "[DONE]") return [];
    return [JSON.parse(data)];
  });
}

function assertTranscript(events) {
  const deltas = events.filter((event) => event.type === "response.output_text.delta").map((event) => event.delta).join("");
  const done = events.filter((event) => event.type === "response.output_text.done").map((event) => event.text).join("");
  const messages = events.filter((event) => event.type === "response.output_item.done" && event.item.type === "message");
  const completed = events.find((event) => event.type === "response.completed");
  assert.equal(deltas, TEXT);
  assert.equal(deltas, done);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].item.content[0].text, TEXT);
  assert.equal(completed.response.output.find((item) => item.type === "message").content[0].text, TEXT);
  assert.equal(completed.response.usage.input_tokens, 1234);
  assert.equal(completed.response.usage.input_tokens_details.cached_tokens, 1000);
  assert.equal(completed.response.usage.output_tokens_details.reasoning_tokens, 7);
  assert.equal(events.filter((event) => event.type === "response.reasoning_text.delta").map((event) => event.delta).join(""), REASONING);
  const opened = new Map();
  for (const event of events) {
    if (event.type === "response.output_item.added") opened.set(event.item.id, event.output_index);
    if (event.item_id) assert.equal(opened.get(event.item_id), event.output_index, "delta/done must refer to the same opened item");
  }
}

test("direct DeepSeek Responses preserves images, reasoning, tools and stream boundaries", async () => {
  const state = mkdtempSync(path.join(os.tmpdir(), "deepseek-responses-test-"));
  const codexHome = path.join(state, "codex");
  mkdirSync(codexHome);
  const legacy = JSON.parse(readFileSync(path.join(root, "config/deepseek/deepseek-v4-flashvision-exp.json"))).models[0];
  writeFileSync(path.join(state, "user-models.json"), JSON.stringify({ version: 1, models: [{ ...legacy, slug: MODEL, gatewayModel: "deepseek-v4-1-flash", upstreamModel: "deepseek-flash", compHash: "native-responses-test" }] }));
  writeFileSync(path.join(state, "enabled-providers.json"), JSON.stringify({ version: 1, providers: ["deepseek"] }));
  const requests = [];
  let gatewayRequests = 0;
  let mode = "normal";
  let upstreamClosed = false;
  const gateway = await server((_request, response) => {
    gatewayRequests += 1;
    response.writeHead(503); response.end("DeepSeek must not reach LiteLLM");
  });
  const upstream = await server(async (request, response) => {
    const body = await readJson(request);
    requests.push({ path: request.url, body });
    // Match the live endpoint's sequence requirement. A fixture that accepted
    // reasoning.content strings concealed the real request-deserialization 400.
    if (Array.isArray(body.input) && body.input.some((item) => item.type === "reasoning" &&
      (!Array.isArray(item.content) || item.content.some((part) =>
        part?.type !== "reasoning_text" || typeof part.text !== "string")))) {
      response.writeHead(400, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ error: { type: "invalid_request_error", message: "reasoning.content must be a sequence of reasoning_text parts" } })); return;
    }
    if (mode === "early-error") {
      response.writeHead(400, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ error: { type: "invalid_request_error", message: "fixture rejection" } })); return;
    }
    const name = mode === "registered-tool" ? body.tools.find((tool) => tool.description === "Registered client tool").name
      : mode === "tool" ? "fixture__probe" : mode === "custom" ? "apply_patch"
      : mode === "unsupported-custom" ? "exec"
        : mode === "namespaced-custom" ? body.tools.find((tool) => tool.description === "Synthetic namespaced freeform tool.").name
          : undefined;
    const events = frames(name, { custom: mode === "custom", customInput: ["unsupported-custom", "namespaced-custom"].includes(mode) });
    if (mode === "bad-id") events.at(-1).response.id = "resp_wrong";
    if (body.stream === false) {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify(events.at(-1).response)); return;
    }
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    if (mode === "cancel" || mode === "disconnect") {
      response.on("close", () => { upstreamClosed = true; });
      response.write(events.slice(0, 5).map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""));
      if (mode === "disconnect") setTimeout(() => response.destroy(), 50);
      return;
    }
    const bytes = Buffer.from(events.map((event) => `event: ${event.type}\r\ndata: ${JSON.stringify(event)}\r\n\r\n`).join(""));
    for (let index = 0; index < bytes.length; index += 37) {
      response.write(bytes.subarray(index, index + 37));
      await new Promise((resolve) => setImmediate(resolve));
    }
    response.end();
  });
  const routerPort = await openPort();
  const forwarderPort = await openPort();
  const env = {
    PATH: process.env.PATH, HOME: state, CODEX_HOME: codexHome,
    MODEL_ROUTER_STATE_DIR: state, CODEX_ROUTER_STATE_DIR: state,
    MODEL_ROUTER_USER_MODELS: path.join(state, "user-models.json"),
    CODEX_ROUTER_INTERNAL_KEY: INTERNAL_KEY, CODEX_ROUTER_CALLER_KEY: CALLER_KEY,
    CODEX_ROUTER_SHOW_ALL_MODELS: "1", CODEX_ROUTER_QUIET: "1", CODEX_ROUTER_DISABLE_DISCOVERY: "1",
    CODEX_ROUTER_PORT: String(routerPort), CODEX_ROUTER_API_PORT: String(forwarderPort),
    CODEX_ROUTER_GATEWAY_BASE_URL: `http://127.0.0.1:${gateway.address().port}/v1`,
    DEEPSEEK_API_BASE_URL: `http://127.0.0.1:${upstream.address().port}`,
    DEEPSEEK_API_KEY: "TEST_DEEPSEEK_API_KEY",
  };
  // The router names a failed upstream connection only on stderr, so a
  // discarded stream turned a CI failure into a bare "502 !== 200".
  const output = childOutput();
  const children = ["api-forwarder.mjs", "router.mjs"].map((script) => output.capture(script,
    spawn(process.execPath, [path.join(root, "src", script)], { cwd: root, env, stdio: ["ignore", "ignore", "pipe"] })));
  const base = callerBaseUrl(routerPort, CALLER_KEY);
  const send = (input, options = {}) => fetch(`${base}/responses`, {
    method: "POST", headers: { "Content-Type": "application/json", "x-openai-subagent": "fixture" },
    body: JSON.stringify({ model: MODEL, input, stream: true, reasoning: { effort: "max" }, max_output_tokens: 1024, tools: [{ type: "namespace", name: "fixture", tools: [{ type: "function", name: "probe", parameters: { type: "object", properties: { ok: { type: "boolean" } } } }] }, { type: "custom", name: "apply_patch" }], ...options }),
  });
  try {
    const rejectedString = await fetch(`http://127.0.0.1:${upstream.address().port}/responses`, {
      method: "POST", body: JSON.stringify({ input: [{ type: "reasoning", content: "invalid string fixture" }] }),
    });
    assert.equal(rejectedString.status, 400, "the provider fixture must reject the shape rejected by the live API");
    await rejectedString.text();
    await waitForListeners([
      { name: "api-forwarder /health", url: `http://127.0.0.1:${forwarderPort}/health`, headers: { Authorization: `Bearer ${INTERNAL_KEY}` } },
      { name: "router /models", url: `${base}/models` },
    ], { children, output });
    for (const imagePart of [undefined, { type: "input_image", image_url: IMAGE, detail: "original" }, { type: "input_image", file_id: "file-api-fixture" }]) {
      const input = [{ type: "message", role: "user", content: [{ type: "input_text", text: "Inspect the synthetic pixel." }, ...(imagePart ? [imagePart] : [])] }];
      const result = await send(input);
      assert.equal(result.status, 200, String(output));
      assertTranscript(parseEvents(await result.text()));
      assert.deepEqual(requests.at(-1).body.input, input);
      assert.equal(requests.at(-1).path, "/responses");
      assert.equal(requests.at(-1).body.stream, true);
      assert.deepEqual(requests.at(-1).body.reasoning, { effort: "max" });
      assert.equal(requests.at(-1).body.thinking, undefined);
      assert.equal(requests.at(-1).body.reasoning_effort, undefined);
      assert.equal(requests.at(-1).body.messages, undefined);
    }
    const delegated = ["NEW_TASK", "FOLLOWUP_TASK", "MESSAGE"].map((kind) => ({
      type: "agent_message",
      content: [
        { type: "input_text", text: `Message Type: ${kind}\nTask name: /root/worker\nSender: /root\nPayload:\n` },
        { type: "encrypted_content", encrypted_content: `Synthetic ${kind} task\nKeep this text exact.` },
      ],
    }));
    const expectedDelegated = delegated.map((item) => ({
      type: "message", role: "user",
      content: [item.content[0], { type: "input_text", text: item.content[1].encrypted_content }],
    }));
    const delegatedResult = await send(delegated);
    assert.equal(delegatedResult.status, 200);
    assertTranscript(parseEvents(await delegatedResult.text()));
    assert.deepEqual(requests.at(-1).body.input, expectedDelegated,
      "the provider ignores Codex agent_message items, even when the task was decrypted");
    assert.ok(requests.at(-1).body.tools.some((tool) =>
      tool.type === "function" && tool.name === "fixture__probe"),
    "delegated task input must not hide the available namespace tool");
    mode = "tool";
    const history = [
      { type: "message", role: "user", content: "Review the image." },
      { type: "reasoning", content: [{ type: "reasoning_text", text: "PRIOR_REASONING" }] },
      { type: "message", role: "assistant", phase: "commentary", content: [{ type: "output_text", text: "PRIOR_ANSWER" }] },
      { type: "function_call", name: "probe", namespace: "fixture", call_id: "call_previous", arguments: "{}" },
      { type: "function_call_output", call_id: "call_previous", output: [{ type: "input_text", text: "fixture" }, { type: "input_image", image_url: IMAGE, detail: "original" }] },
    ];
    const result = await send(history);
    const events = parseEvents(await result.text());
    assertTranscript(events);
    const call = events.find((event) => event.type === "response.output_item.done" && event.item.type === "function_call").item;
    assert.equal(call.namespace, "fixture"); assert.equal(call.name, "probe"); assert.equal(call.arguments, '{"ok":true}');
    const requestText = JSON.stringify(requests.at(-1).body.input);
    assert.equal(requestText.split("PRIOR_REASONING").length - 1, 1);
    assert.equal(requestText.split("PRIOR_ANSWER").length - 1, 1);
    assert.deepEqual(requests.at(-1).body.input.find((item) => item.type === "reasoning"), history[1]);
    // Built-in Responses providers keep Codex's message phase; only
    // operator-configured Responses endpoints have it removed.
    assert.equal(requests.at(-1).body.input.find((item) => item.role === "assistant")?.phase, "commentary");
    assert.deepEqual(requests.at(-1).body.input.at(-1).output, history.at(-1).output);
    const legacyHistory = structuredClone(history);
    legacyHistory[1] = { type: "reasoning", summary: [{ type: "summary_text", text: "PRIOR_REASONING" }], content: null };
    const legacyResult = await send(legacyHistory);
    assert.equal(legacyResult.status, 200);
    assertTranscript(parseEvents(await legacyResult.text()));
    assert.deepEqual(requests.at(-1).body.input.find((item) => item.type === "reasoning"), history[1]);
    mode = "custom";
    const custom = parseEvents(await (await send("Use the fixture custom tool.")).text());
    assertTranscript(custom);
    assert.equal(custom.find((event) => event.type === "response.output_item.done" && event.item.type === "custom_tool_call").item.input, "*** Begin Patch\n*** End Patch");
    mode = "unsupported-custom";
    const bridged = parseEvents(await (await send("Use the freeform fixture.", {
      tools: [{ type: "custom", name: "exec", description: "Synthetic freeform tool." }],
      tool_choice: { type: "custom", name: "exec" },
    })).text());
    assertTranscript(bridged);
    assert.equal(requests.at(-1).body.tools[0].type, "function");
    assert.equal(requests.at(-1).body.tool_choice.type, "function");
    assert.equal(bridged.find((event) => event.type === "response.output_item.done" && event.item.type === "custom_tool_call").item.input, "synthetic raw input");
    mode = "namespaced-custom";
    for (const [namespace, collision] of [
      ["functions", false], ["functions", true], ["collaboration", false], ["collaboration", true],
    ]) {
      const prior = { type: "custom_tool_call", name: "exec", namespace, call_id: "call_prior_custom", input: "synthetic prior input" };
      const result = await send([
        ...history.slice(0, 3), prior,
        { type: "custom_tool_call_output", call_id: prior.call_id, output: "synthetic prior output" },
      ], {
        tools: [
          { type: "namespace", name: namespace, tools: [{ type: "custom", name: "exec", description: "Synthetic namespaced freeform tool." }] },
          ...(collision ? [{ type: "function", name: `${namespace}__exec`, parameters: { type: "object", properties: {} } }] : []),
        ],
        tool_choice: { type: "custom", name: "exec", namespace },
      });
      assert.equal(result.status, 200);
      const events = parseEvents(await result.text());
      assertTranscript(events);
      const sent = requests.at(-1).body;
      const providerName = sent.tools[0].name;
      if (collision) assert.notEqual(providerName, `${namespace}__exec`, "the plain function keeps its own identity");
      assert.equal(sent.input.find((item) => item.call_id === prior.call_id).name, providerName);
      assert.equal(sent.input.find((item) => item.call_id === prior.call_id).namespace, undefined);
      assert.deepEqual(sent.tool_choice, { type: "function", name: providerName });
      for (const event of events) {
        for (const item of event.item ? [event.item] : event.response?.output || []) {
          if (item.type !== "custom_tool_call") continue;
          assert.equal(item.name, "exec");
          assert.equal(item.namespace, namespace);
          if (item.status === "completed") assert.equal(item.input, "synthetic raw input");
        }
      }
      assert.equal(events.filter((event) => event.type === "response.custom_tool_call_input.delta")
        .map((event) => event.delta).join(""), "synthetic raw input");
    }
    mode = "registered-tool";
    for (const [namespace, name, source] of [
      ["image_gen", "imagegen", { kind: "harness" }],
      ["clock", "curr_time", { kind: "harness" }],
      ["codex_app", "list_projects", { kind: "harness" }],
      ["mcp__node_repl", "js", { kind: "mcp", server_name: "node_repl" }],
    ]) {
      const result = await send("Use the explicitly registered tool.", {
        tools: [{ type: "function", name: `${namespace}__${name}`, description: "Registered client tool", parameters: { type: "object" } }],
        client_metadata: {
          "x-codex-turn-metadata": JSON.stringify({
            tool_namespaces_info: {
              [namespace]: {
                name: namespace,
                functions: { [name]: { name, direct: true, source } },
              },
            },
          }),
        },
      });
      assert.equal(result.status, 200);
      const events = parseEvents(await result.text());
      assertTranscript(events);
      assert.ok(events.some((event) =>
        event.type === "response.output_item.done" && event.item.type === "function_call"));
      for (const event of events) {
        for (const item of event.item ? [event.item] : event.response?.output || []) {
          if (item.type !== "function_call") continue;
          assert.equal(item.namespace, namespace);
          assert.equal(item.name, name);
          if (item.status === "completed") assert.equal(item.arguments, '{"ok":true}');
        }
      }
    }
    mode = "normal";
    const compact = await fetch(`${base}/responses/compact`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: MODEL, input: [...history, ...delegated] }),
    });
    assert.equal(compact.status, 200);
    await compact.text();
    assert.equal(requests.at(-1).path, "/responses");
    assert.equal(requests.at(-1).body.stream, false);
    assert.equal(requests.at(-1).body.messages, undefined);
    const compactInput = requests.at(-1).body.input;
    for (const expected of expectedDelegated) {
      assert.deepEqual(compactInput.find((item) =>
        item.content?.[0]?.text === expected.content[0].text), expected);
    }
    assert.equal(compactInput.some((item) => item.type === "agent_message"), false);
    mode = "bad-id";
    const invalid = parseEvents(await (await send("Invalid terminal identity fixture.")).text());
    assert.ok(invalid.some((event) => event.type === "error" && event.code === "invalid_responses_stream"));
    assert.equal(invalid.filter((event) => event.type === "response.output_text.delta").map((event) => event.delta).join(""), TEXT);
    mode = "early-error";
    const countBeforeError = requests.length;
    assert.equal((await send("Reject once.")).status, 400);
    assert.equal(requests.length, countBeforeError + 1);
    for (mode of ["disconnect", "cancel"]) {
      const countBefore = requests.length;
      upstreamClosed = false;
      const controller = new AbortController();
      const response = await fetch(`${base}/responses`, { method: "POST", headers: { "Content-Type": "application/json" }, signal: controller.signal, body: JSON.stringify({ model: MODEL, input: "Partial stream fixture.", stream: true }) });
      const reader = response.body.getReader();
      const first = await reader.read();
      assert.equal(first.done, false);
      if (mode === "cancel") controller.abort();
      try { while (!(await reader.read()).done) { /* drain until failure */ } } catch { /* expected stream interruption */ }
      for (let attempt = 0; attempt < 100 && !upstreamClosed; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 10));
      assert.equal(upstreamClosed, true);
      assert.equal(requests.length, countBefore + 1, "no retry after relaying the first bytes");
    }
    assert.equal(gatewayRequests, 0, "direct DeepSeek must never enter the Chat/fake-stream gateway");
  } finally {
    for (const child of children) child.kill("SIGTERM");
    await Promise.all(children.map((child) => child.exitCode !== null ? undefined : new Promise((resolve) => child.once("exit", resolve))));
    for (const instance of [gateway, upstream]) { instance.closeAllConnections(); await new Promise((resolve) => instance.close(resolve)); }
    rmSync(state, { recursive: true, force: true });
  }
});

test("the stream oracle rejects cumulative deltas and duplicate text", () => {
  const duplicate = frames();
  const delta = duplicate.find((event) => event.type === "response.output_text.delta");
  delta.delta += TEXT;
  assert.throws(() => assertTranscript(duplicate));
});
