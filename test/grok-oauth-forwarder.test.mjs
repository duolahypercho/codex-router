import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import http from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { openPort } from "./port-pool.mjs";

import {
  hostedSearchEnabledFor,
  mergeHostedSearchTools,
  toResponsesRequest,
} from "../src/grok-oauth-forwarder.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const INTERNAL_KEY = "test-grok-internal-service-key-with-sufficient-length";

function sse(events) {
  return `${events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}`).join("\n\n")}\n\n`;
}

async function mockBackend(handler) {
  const server = http.createServer(handler);
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return { server, port: server.address().port };
}

function startForwarder(port, backendPort, authPath, extraEnv = {}) {
  const child = spawn(process.execPath, [path.join(root, "src", "grok-oauth-forwarder.mjs")], {
    cwd: root,
    env: {
      ...process.env,
      MODEL_ROUTER_TARGET: "codex",
      MODEL_ROUTER_INTERNAL_KEY: INTERNAL_KEY,
      MODEL_ROUTER_GROK_OAUTH_PORT: String(port),
      GROK_CLI_CHAT_PROXY_BASE_URL: `http://127.0.0.1:${backendPort}`,
      GROK_CLI: path.join(root, "test", "fixtures", "missing-grok-cli"),
      GROK_AUTH_PATH: authPath,
      MODEL_ROUTER_QUIET: "1",
      ...extraEnv,
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  child.stderr.setEncoding("utf8");
  let errors = "";
  child.stderr.on("data", (c) => (errors += c));
  child.testErrors = () => errors;
  return child;
}

const auth = { Authorization: `Bearer ${INTERNAL_KEY}`, "Content-Type": "application/json" };

async function waitHealth(base, child) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`exited: ${child.testErrors()}`);
    try {
      const r = await fetch(`${base}/health`, { headers: auth });
      if (r.ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 40));
  }
  throw new Error(`health timeout: ${child.testErrors()}`);
}

async function stop(child) {
  if (child.exitCode !== null) return;
  child.kill("SIGTERM");
  await new Promise((r) => child.once("exit", r));
}

function writeSession(dir) {
  const authPath = path.join(dir, "auth.json");
  writeFileSync(
    authPath,
    JSON.stringify({ "https://auth.x.ai::test-client-id": { key: "fake-access" } }),
    { mode: 0o600 },
  );
  return authPath;
}

test("translates Chat Completions to Grok Responses and back (text + tools)", async () => {
  let captured;
  let capturedHeaders;
  const backend = await mockBackend(async (req, res) => {
    capturedHeaders = req.headers;
    const chunks = [];
    for await (const c of req) chunks.push(c);
    captured = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    // Hosted search tools are always present; only emit client function-call
    // events when the request includes a client function tool.
    const hasClientFunction = Array.isArray(captured.tools)
      && captured.tools.some((tool) => tool.type === "function");
    if (hasClientFunction) {
      res.end(
        sse([
          { type: "response.output_item.added", item: { type: "function_call", id: "fc_1", call_id: "call_1", name: "get_weather" } },
          { type: "response.function_call_arguments.delta", item_id: "fc_1", delta: '{"city":' },
          { type: "response.function_call_arguments.delta", item_id: "fc_1", delta: '"SF"}' },
          { type: "response.output_item.done", item: { type: "function_call", id: "fc_1", call_id: "call_1", name: "get_weather", arguments: '{"city":"SF"}' } },
          { type: "response.completed", response: { usage: { input_tokens: 10, output_tokens: 8 } } },
        ]),
      );
    } else {
      res.end(
        sse([
          { type: "response.output_text.delta", delta: "po" },
          { type: "response.output_text.delta", delta: "ng" },
          { type: "response.completed", response: { usage: { input_tokens: 13, output_tokens: 5 } } },
        ]),
      );
    }
  });
  const port = await openPort();
  const dir = mkdtempSync(path.join(os.tmpdir(), "grok-oauth-fwd-"));
  const child = startForwarder(port, backend.port, writeSession(dir));
  const base = `http://127.0.0.1:${port}`;

  try {
    await waitHealth(base, child);

    // Auth is required.
    assert.equal((await fetch(`${base}/v1/chat/completions`, { method: "POST" })).status, 401);

    // Non-streaming text, and the upstream request is a valid Responses request.
    const textResp = await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({
        model: "grok-4.5",
        messages: [
          { role: "system", content: "Be terse." },
          { role: "user", content: "ping" },
        ],
        stream: false,
      }),
    });
    const text = await textResp.json();
    assert.equal(text.object, "chat.completion");
    assert.equal(text.choices[0].message.content, "pong");
    assert.equal(text.choices[0].finish_reason, "stop");
    assert.equal(text.usage.prompt_tokens, 13);
    assert.equal(text.usage.completion_tokens, 5);
    // Request translation: system -> instructions, user -> input message, stream forced true.
    assert.equal(captured.model, "grok-4.5");
    assert.equal(captured.instructions, "Be terse.");
    assert.equal(captured.stream, true);
    assert.equal(captured.input.at(-1).role, "user");
    assert.equal(captured.input.at(-1).content[0].type, "input_text");
    // Free Grok OAuth path injects hosted web_search + x_search like Grok Build.
    assert.deepEqual(
      captured.tools.filter((tool) => tool.type === "web_search" || tool.type === "x_search"),
      [{ type: "web_search" }, { type: "x_search" }],
    );
    assert.equal(capturedHeaders.authorization, "Bearer fake-access");
    assert.equal(capturedHeaders["x-xai-token-auth"], "xai-grok-cli");
    assert.equal(capturedHeaders["x-authenticateresponse"], "authenticate-response");
    assert.match(capturedHeaders["x-grok-client-version"], /^\d+\.\d+\.\d+$/);
    assert.equal(capturedHeaders["x-grok-client-identifier"], "grok-shell");
    assert.equal(capturedHeaders["x-grok-client-mode"], "headless");
    assert.equal(capturedHeaders["x-grok-model-override"], "grok-4.5");
    assert.equal(capturedHeaders["x-grok-turn-idx"], "1");
    assert.equal(capturedHeaders["x-grok-conv-id"], capturedHeaders["x-grok-session-id"]);
    assert.match(capturedHeaders["x-grok-req-id"], /^[0-9a-f-]{36}$/);
    assert.match(capturedHeaders["x-grok-agent-id"], /^[0-9a-f-]{36}$/);
    assert.match(capturedHeaders["user-agent"], /^grok-shell\/\d+\.\d+\.\d+ \(.+; .+\)$/);

    for (const [effort, expected] of [["none", "low"], ["low", "low"], ["medium", "medium"], ["high", "high"], ["xhigh", "high"], ["max", "high"]]) {
      const effortResponse = await fetch(`${base}/v1/chat/completions`, {
        method: "POST",
        headers: auth,
        body: JSON.stringify({
          model: "grok-4.5",
          messages: [{ role: "user", content: "ping" }],
          reasoning_effort: effort,
        }),
      });
      assert.equal(effortResponse.status, 200);
      await effortResponse.json();
      assert.equal(captured.reasoning?.effort, expected);
    }

    const xhighResponse = await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({
        model: "grok-4.6",
        messages: [{ role: "user", content: "ping" }],
        reasoning_effort: "xhigh",
      }),
    });
    assert.equal(xhighResponse.status, 200);
    await xhighResponse.json();
    assert.equal(captured.reasoning?.effort, "xhigh");

    // Streaming text.
    const streamResp = await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({
        model: "grok-4.5",
        messages: [{ role: "user", content: "ping" }],
        stream: true,
      }),
    });
    const body = await streamResp.text();
    assert.match(body, /"delta":\{"role":"assistant"/);
    assert.match(body, /"content":"po"/);
    assert.match(body, /"content":"ng"/);
    assert.match(body, /"finish_reason":"stop"/);
    assert.match(body, /data: \[DONE\]/);

    // Tool calls (non-streaming): function_call items -> tool_calls.
    const toolResp = await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({
        model: "grok-4.5",
        messages: [{ role: "user", content: "weather in SF?" }],
        tools: [
          { type: "function", function: { name: "get_weather", parameters: { type: "object" } } },
        ],
        stream: false,
      }),
    });
    const tool = await toolResp.json();
    assert.equal(tool.choices[0].finish_reason, "tool_calls");
    assert.equal(tool.choices[0].message.tool_calls[0].function.name, "get_weather");
    assert.equal(tool.choices[0].message.tool_calls[0].function.arguments, '{"city":"SF"}');
    // Request translation carried the tool definition through and kept hosted search.
    assert.equal(captured.tools[0].name, "get_weather");
    assert.deepEqual(
      captured.tools.filter((tool) => tool.type !== "function"),
      [{ type: "web_search" }, { type: "x_search" }],
    );
  } finally {
    await stop(child);
    await new Promise((r) => backend.server.close(r));
    rmSync(dir, { recursive: true, force: true });
  }
});

test("returns 401 when the Grok session is missing", async () => {
  const backend = await mockBackend((req, res) => res.end(""));
  const port = await openPort();
  const dir = mkdtempSync(path.join(os.tmpdir(), "grok-fwd-nosession-"));
  const child = startForwarder(port, backend.port, path.join(dir, "auth.json"));
  const base = `http://127.0.0.1:${port}`;
  try {
    await waitHealth(base, child);
    const resp = await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ model: "grok-4.5", messages: [{ role: "user", content: "hi" }] }),
    });
    assert.equal(resp.status, 401);
  } finally {
    await stop(child);
    await new Promise((r) => backend.server.close(r));
    rmSync(dir, { recursive: true, force: true });
  }
});

test("mergeHostedSearchTools injects x_search and web_search by default", () => {
  assert.deepEqual(mergeHostedSearchTools([]), [
    { type: "web_search" },
    { type: "x_search" },
  ]);
  assert.deepEqual(
    mergeHostedSearchTools([
      {
        type: "function",
        name: "read_file",
        description: "read",
        parameters: { type: "object" },
        strict: false,
      },
      {
        type: "function",
        name: "web_search",
        description: "local",
        parameters: { type: "object" },
        strict: false,
      },
    ]),
    [
      {
        type: "function",
        name: "read_file",
        description: "read",
        parameters: { type: "object" },
        strict: false,
      },
      { type: "web_search" },
      { type: "x_search" },
    ],
  );
});

test("mergeHostedSearchTools can be disabled", () => {
  assert.deepEqual(
    mergeHostedSearchTools(
      [{ type: "function", name: "read_file", parameters: { type: "object" }, strict: false }],
      { enabled: false },
    ),
    [{ type: "function", name: "read_file", parameters: { type: "object" }, strict: false }],
  );
});

test("mergeHostedSearchTools drops repeated function names", () => {
  assert.deepEqual(
    mergeHostedSearchTools(
      [
        { type: "function", name: "file_write", description: "native", parameters: { type: "object" }, strict: false },
        { type: "function", name: "file_write", description: "collab", parameters: { type: "object" }, strict: false },
        { type: "function", name: "bash", parameters: { type: "object" }, strict: false },
      ],
      { enabled: false },
    ),
    [
      { type: "function", name: "file_write", description: "native", parameters: { type: "object" }, strict: false },
      { type: "function", name: "bash", parameters: { type: "object" }, strict: false },
    ],
  );
});

test("toResponsesRequest sends each duplicated tool name upstream once", () => {
  const request = toResponsesRequest({
    model: "grok-4.5",
    messages: [{ role: "user", content: "write a file" }],
    tools: [
      { type: "function", function: { name: "file_write", parameters: { type: "object" } } },
      { type: "function", function: { name: "file_write", parameters: { type: "object" } } },
    ],
  });
  const fileWrites = request.tools.filter((tool) => tool.name === "file_write");
  assert.equal(fileWrites.length, 1);
});

test("toResponsesRequest always includes hosted search tools when enabled", () => {
  const request = toResponsesRequest({
    model: "grok-4.5",
    messages: [{ role: "user", content: "latest from X?" }],
    tools: [
      { type: "function", function: { name: "bash", parameters: { type: "object" } } },
    ],
  });
  assert.equal(request.tools.some((tool) => tool.type === "x_search"), true);
  assert.equal(request.tools.some((tool) => tool.type === "web_search"), true);
  assert.equal(request.tools.some((tool) => tool.name === "bash"), true);
});

test("toResponsesRequest omits hosted search tools when disabled", () => {
  const request = toResponsesRequest(
    {
      model: "grok-4.5",
      messages: [{ role: "user", content: "latest from X?" }],
      tools: [
        { type: "function", function: { name: "bash", parameters: { type: "object" } } },
      ],
    },
    { hostedSearchEnabled: false },
  );
  assert.equal(request.tools.some((tool) => tool.type === "x_search"), false);
  assert.equal(request.tools.some((tool) => tool.type === "web_search"), false);
  assert.equal(request.tools.some((tool) => tool.name === "bash"), true);
});

test("hostedSearchEnabledFor follows the registry searchTool declaration", () => {
  const models = [
    {
      provider: "grok-oauth",
      upstreamModel: "grok-4.5",
      searchTool: { mode: "hosted" },
    },
    {
      provider: "grok-oauth",
      upstreamModel: "grok-4.6",
      searchTool: { mode: "hosted" },
    },
    { provider: "grok-oauth", upstreamModel: "grok-4.5-mini" },
    { provider: "kimi-oauth", upstreamModel: "kimi-k3", searchTool: { mode: "hosted" } },
  ];
  assert.equal(hostedSearchEnabledFor("grok-4.5", models), true);
  assert.equal(hostedSearchEnabledFor("grok-4.6", models), true);
  // No declaration means conservative plain function calling.
  assert.equal(hostedSearchEnabledFor("grok-4.5-mini", models), false);
  // Another provider's declaration must not leak into this forwarder.
  assert.equal(hostedSearchEnabledFor("kimi-k3", models), false);
});

test("hostedSearchEnabledFor covers the checked-in Grok OAuth model", () => {
  assert.equal(hostedSearchEnabledFor("grok-4.5"), true);
  assert.equal(hostedSearchEnabledFor("grok-4.6"), true);
});

test("toResponsesRequest preserves the client's image detail level", () => {
  const request = toResponsesRequest({
    model: "grok-4.5",
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: "what is in this screenshot?" },
          { type: "image_url", image_url: { url: "data:image/png;base64,AAAA", detail: "high" } },
          { type: "image_url", image_url: { url: "data:image/png;base64,BBBB" } },
        ],
      },
    ],
  });
  const images = request.input[0].content.filter((part) => part.type === "input_image");
  assert.equal(images.length, 2);
  assert.equal(images[0].detail, "high");
  // Absent detail must stay absent, not default to a resolution choice.
  assert.equal("detail" in images[1], false);
});

// xAI routes by `x-grok-conv-id` so a conversation stays on the server holding
// its KV cache. A fresh id per request scatters the turns and the cache is
// never read: measured at 3.9% cached across an append-only session, against
// 78.4% once the id was derived from the conversation.
test("upstream headers keep one conversation on one conv-id", async () => {
  const { conversationIdForTest } = await import("../src/grok-oauth-forwarder.mjs");
  const opening = [
    { role: "system", content: "You are Codex." },
    { role: "user", content: "run the thing" },
  ];
  const turnOne = conversationIdForTest(opening);
  // The next turn appends a tool call and its result; the opening is untouched.
  const turnTwo = conversationIdForTest([
    ...opening,
    { role: "assistant", content: "", tool_calls: [{ id: "c1", function: { name: "sh" } }] },
    { role: "tool", tool_call_id: "c1", content: "ok" },
    { role: "user", content: "and again" },
  ]);
  assert.equal(turnTwo, turnOne);
  assert.match(turnOne, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  // A different conversation must not share the cache slot.
  assert.notEqual(
    conversationIdForTest([{ role: "system", content: "You are Codex." }, { role: "user", content: "other" }]),
    turnOne,
  );
});

test("streams visible output before the upstream turn completes", async () => {
  let releaseCompletion;
  const completionGate = new Promise((resolve) => {
    releaseCompletion = resolve;
  });
  const backend = await mockBackend(async (_req, res) => {
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.write(sse([{ type: "response.output_text.delta", delta: "working" }]));
    await completionGate;
    res.end(
      sse([
        { type: "response.completed", response: { usage: { input_tokens: 10, output_tokens: 2 } } },
      ]),
    );
  });
  const port = await openPort();
  const dir = mkdtempSync(path.join(os.tmpdir(), "grok-oauth-live-stream-"));
  const child = startForwarder(port, backend.port, writeSession(dir));
  const base = `http://127.0.0.1:${port}`;
  try {
    await waitHealth(base, child);
    const resp = await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({
        model: "grok-4.6",
        messages: [{ role: "user", content: "continue" }],
        stream: true,
      }),
    });
    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let body = "";
    let timeout;
    await Promise.race([
      (async () => {
        while (!body.includes('"content":"working"')) {
          const { value, done } = await reader.read();
          if (done) break;
          body += decoder.decode(value, { stream: true });
        }
      })(),
      new Promise((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error("visible output was buffered until completion")),
          2_000,
        );
      }),
    ]);
    clearTimeout(timeout);
    assert.match(body, /"content":"working"/);
    releaseCompletion();
    for (;;) {
      const { done } = await reader.read();
      if (done) break;
    }
  } finally {
    releaseCompletion?.();
    await stop(child);
    await new Promise((r) => backend.server.close(r));
    rmSync(dir, { recursive: true, force: true });
  }
});

test("streams a function call that appears only in a final unterminated SSE block", async () => {
  let inbound = 0;
  const backend = await mockBackend(async (_req, res) => {
    inbound += 1;
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    const event = {
      type: "response.output_item.done",
      item: {
        type: "function_call",
        id: "fc_done",
        call_id: "call_done",
        name: "exec_command",
        arguments: '{"cmd":"dir"}',
      },
    };
    res.end(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n`);
  });
  const port = await openPort();
  const dir = mkdtempSync(path.join(os.tmpdir(), "grok-oauth-final-block-"));
  const child = startForwarder(port, backend.port, writeSession(dir));
  const base = `http://127.0.0.1:${port}`;
  try {
    await waitHealth(base, child);
    const resp = await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({
        model: "grok-4.6",
        messages: [{ role: "user", content: "run it" }],
        tools: [{ type: "function", function: { name: "exec_command", parameters: { type: "object" } } }],
        stream: true,
      }),
    });
    const body = await resp.text();
    assert.match(body, /"finish_reason":"tool_calls"/);
    assert.match(body, /exec_command/);
    assert.match(body, /\\"cmd\\":\\"dir\\"/);
    assert.equal(inbound, 1);
  } finally {
    await stop(child);
    await new Promise((r) => backend.server.close(r));
    rmSync(dir, { recursive: true, force: true });
  }
});

const PROGRESS_EVENTS = [
  { type: "response.output_text.delta", delta: "Next I will update the deck." },
  {
    type: "response.completed",
    response: {
      usage: {
        input_tokens: 105_882,
        output_tokens: 1_660,
        output_tokens_details: { reasoning_tokens: 1_620 },
      },
    },
  },
];

const TOOL_EVENTS = [
  {
    type: "response.output_item.done",
    item: {
      type: "function_call",
      id: "fc_retry",
      call_id: "call_retry",
      name: "exec_command",
      arguments: '{"cmd":"dir"}',
    },
  },
  {
    type: "response.completed",
    response: {
      usage: {
        input_tokens: 106_000,
        output_tokens: 40,
        output_tokens_details: { reasoning_tokens: 10 },
      },
    },
  },
];

test("does not retry a short reasoning-heavy answer when the client offered no tools", async () => {
  let inbound = 0;
  const backend = await mockBackend(async (_req, res) => {
    inbound += 1;
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.end(sse(PROGRESS_EVENTS));
  });
  const port = await openPort();
  const dir = mkdtempSync(path.join(os.tmpdir(), "grok-oauth-no-tools-"));
  const child = startForwarder(port, backend.port, writeSession(dir));
  const base = `http://127.0.0.1:${port}`;
  try {
    await waitHealth(base, child);
    const resp = await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({
        model: "grok-4.6",
        messages: [{ role: "user", content: "update the deck" }],
        stream: false,
      }),
    });
    const json = await resp.json();
    assert.equal(json.choices[0].message.content, "Next I will update the deck.");
    assert.equal(json.choices[0].finish_reason, "stop");
    assert.equal(inbound, 1);
  } finally {
    await stop(child);
    await new Promise((r) => backend.server.close(r));
    rmSync(dir, { recursive: true, force: true });
  }
});

test("retries a progress-only stop once and prefers a retry that calls tools", async () => {
  let inbound = 0;
  const bodies = [];
  const backend = await mockBackend(async (req, res) => {
    inbound += 1;
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    bodies.push(Buffer.concat(chunks).toString("utf8"));
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.end(sse(inbound === 1 ? PROGRESS_EVENTS : TOOL_EVENTS));
  });
  const port = await openPort();
  const dir = mkdtempSync(path.join(os.tmpdir(), "grok-oauth-retry-tools-"));
  const child = startForwarder(port, backend.port, writeSession(dir));
  const base = `http://127.0.0.1:${port}`;
  try {
    await waitHealth(base, child);
    const resp = await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({
        model: "grok-4.6",
        messages: [
          { role: "system", content: "You are Codex." },
          { role: "user", content: "update the deck" },
        ],
        tools: [{ type: "function", function: { name: "exec_command", parameters: { type: "object" } } }],
        stream: false,
      }),
    });
    const json = await resp.json();
    assert.equal(inbound, 2);
    assert.equal(json.choices[0].finish_reason, "tool_calls");
    assert.equal(json.choices[0].message.content, "Next I will update the deck.");
    assert.equal(json.choices[0].message.tool_calls[0].function.name, "exec_command");
    assert.equal(json.usage.prompt_tokens, 105_882 + 106_000);
    assert.equal(json.usage.completion_tokens, 1_660 + 40);
    assert.equal(json.usage.retries, 1);
    assert.equal(json.usage.progress_only_retried, true);
    const retryBody = JSON.parse(bodies[1]);
    assert.equal(retryBody.instructions, "You are Codex.");
    assert.match(JSON.stringify(retryBody.input), /Continue the same task by calling tools now/);
    assert.match(child.testErrors(), /progress-only-retried=true/);
  } finally {
    await stop(child);
    await new Promise((r) => backend.server.close(r));
    rmSync(dir, { recursive: true, force: true });
  }
});

test("keeps the first progress-only answer when the retry also has no tools", async () => {
  let inbound = 0;
  const backend = await mockBackend(async (_req, res) => {
    inbound += 1;
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.end(
      sse(
        inbound === 1
          ? PROGRESS_EVENTS
          : [
              { type: "response.output_text.delta", delta: "Still thinking about it." },
              {
                type: "response.completed",
                response: {
                  usage: {
                    input_tokens: 106_000,
                    output_tokens: 500,
                    output_tokens_details: { reasoning_tokens: 480 },
                  },
                },
              },
            ],
      ),
    );
  });
  const port = await openPort();
  const dir = mkdtempSync(path.join(os.tmpdir(), "grok-oauth-keep-first-"));
  const child = startForwarder(port, backend.port, writeSession(dir));
  const base = `http://127.0.0.1:${port}`;
  try {
    await waitHealth(base, child);
    const resp = await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({
        model: "grok-4.6",
        messages: [{ role: "user", content: "update the deck" }],
        tools: [{ type: "function", function: { name: "exec_command", parameters: { type: "object" } } }],
        stream: false,
      }),
    });
    const json = await resp.json();
    assert.equal(inbound, 2);
    assert.equal(json.choices[0].message.content, "Next I will update the deck.");
    assert.equal(json.choices[0].finish_reason, "stop");
    assert.equal(json.usage.completion_tokens, 1_660 + 500);
    assert.equal(json.usage.retries, 1);
  } finally {
    await stop(child);
    await new Promise((r) => backend.server.close(r));
    rmSync(dir, { recursive: true, force: true });
  }
});

test("progress-only kill switch leaves the first attempt alone", async () => {
  let inbound = 0;
  const backend = await mockBackend(async (_req, res) => {
    inbound += 1;
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.end(sse(PROGRESS_EVENTS));
  });
  const port = await openPort();
  const dir = mkdtempSync(path.join(os.tmpdir(), "grok-oauth-kill-switch-"));
  const child = startForwarder(port, backend.port, writeSession(dir), {
    CODEX_ROUTER_GROK_PROGRESS_ONLY_RETRY: "0",
  });
  const base = `http://127.0.0.1:${port}`;
  try {
    await waitHealth(base, child);
    const resp = await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({
        model: "grok-4.6",
        messages: [{ role: "user", content: "update the deck" }],
        tools: [{ type: "function", function: { name: "exec_command", parameters: { type: "object" } } }],
        stream: false,
      }),
    });
    const json = await resp.json();
    assert.equal(inbound, 1);
    assert.equal(json.choices[0].finish_reason, "stop");
    assert.equal(json.usage.retries, undefined);
  } finally {
    await stop(child);
    await new Promise((r) => backend.server.close(r));
    rmSync(dir, { recursive: true, force: true });
  }
});

test("drains a failed progress-only retry and keeps the first answer", async () => {
  let inbound = 0;
  let secondBodyRead = false;
  const backend = await mockBackend(async (_req, res) => {
    inbound += 1;
    if (inbound === 1) {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.end(sse(PROGRESS_EVENTS));
      return;
    }
    res.writeHead(502, { "Content-Type": "text/plain" });
    res.write("upstream retry exploded");
    res.end();
    secondBodyRead = true;
  });
  const port = await openPort();
  const dir = mkdtempSync(path.join(os.tmpdir(), "grok-oauth-retry-fail-"));
  const child = startForwarder(port, backend.port, writeSession(dir));
  const base = `http://127.0.0.1:${port}`;
  try {
    await waitHealth(base, child);
    const resp = await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({
        model: "grok-4.6",
        messages: [{ role: "user", content: "update the deck" }],
        tools: [{ type: "function", function: { name: "exec_command", parameters: { type: "object" } } }],
        stream: false,
      }),
    });
    const json = await resp.json();
    assert.equal(inbound, 2);
    assert.equal(secondBodyRead, true);
    assert.equal(json.choices[0].message.content, "Next I will update the deck.");
    assert.match(child.testErrors(), /progress-only-retry-failed=true/);
  } finally {
    await stop(child);
    await new Promise((r) => backend.server.close(r));
    rmSync(dir, { recursive: true, force: true });
  }
});

test("streams a long tool-offered answer before the upstream turn completes", async () => {
  let releaseCompletion;
  const completionGate = new Promise((resolve) => {
    releaseCompletion = resolve;
  });
  const longText = "x".repeat(160);
  const backend = await mockBackend(async (_req, res) => {
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.write(sse([{ type: "response.output_text.delta", delta: longText }]));
    await completionGate;
    res.end(
      sse([
        { type: "response.completed", response: { usage: { input_tokens: 10, output_tokens: 40 } } },
      ]),
    );
  });
  const port = await openPort();
  const dir = mkdtempSync(path.join(os.tmpdir(), "grok-oauth-live-long-"));
  const child = startForwarder(port, backend.port, writeSession(dir));
  const base = `http://127.0.0.1:${port}`;
  try {
    await waitHealth(base, child);
    const resp = await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({
        model: "grok-4.6",
        messages: [{ role: "user", content: "continue" }],
        tools: [{ type: "function", function: { name: "exec_command", parameters: { type: "object" } } }],
        stream: true,
      }),
    });
    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let body = "";
    let timeout;
    await Promise.race([
      (async () => {
        while (!body.includes(longText)) {
          const { value, done } = await reader.read();
          if (done) break;
          body += decoder.decode(value, { stream: true });
        }
      })(),
      new Promise((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error("long visible output was buffered until completion")),
          2_000,
        );
      }),
    ]);
    clearTimeout(timeout);
    assert.match(body, new RegExp(longText));
    releaseCompletion();
    for (;;) {
      const { done } = await reader.read();
      if (done) break;
    }
  } finally {
    releaseCompletion?.();
    await stop(child);
    await new Promise((r) => backend.server.close(r));
    rmSync(dir, { recursive: true, force: true });
  }
});

async function readAll(resp) {
  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let body = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    body += decoder.decode(value, { stream: true });
  }
  return body;
}

test("streams a short tool-offered answer before the upstream turn completes", async () => {
  let releaseCompletion;
  const completionGate = new Promise((resolve) => {
    releaseCompletion = resolve;
  });
  const backend = await mockBackend(async (_req, res) => {
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.write(sse([{ type: "response.output_text.delta", delta: "Done." }]));
    await completionGate;
    res.end(
      sse([
        {
          type: "response.completed",
          response: { usage: { input_tokens: 20, output_tokens: 5 } },
        },
      ]),
    );
  });
  const port = await openPort();
  const dir = mkdtempSync(path.join(os.tmpdir(), "grok-oauth-live-short-"));
  const child = startForwarder(port, backend.port, writeSession(dir));
  const base = `http://127.0.0.1:${port}`;
  try {
    await waitHealth(base, child);
    const resp = await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({
        model: "grok-4.6",
        messages: [{ role: "user", content: "say done" }],
        tools: [{ type: "function", function: { name: "exec_command", parameters: { type: "object" } } }],
        stream: true,
      }),
    });
    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let body = "";
    let timeout;
    await Promise.race([
      (async () => {
        while (!body.includes('"content":"Done."')) {
          const { value, done } = await reader.read();
          if (done) break;
          body += decoder.decode(value, { stream: true });
        }
      })(),
      new Promise((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error("short visible output was buffered until completion")),
          2_000,
        );
      }),
    ]);
    clearTimeout(timeout);
    assert.match(body, /"content":"Done\."/);
    releaseCompletion();
    for (;;) {
      const { done } = await reader.read();
      if (done) break;
    }
  } finally {
    releaseCompletion?.();
    await stop(child);
    await new Promise((r) => backend.server.close(r));
    rmSync(dir, { recursive: true, force: true });
  }
});

test("appends retry tool-call deltas onto a live progress-only stream", async () => {
  let inbound = 0;
  const backend = await mockBackend(async (_req, res) => {
    inbound += 1;
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.end(sse(inbound === 1 ? PROGRESS_EVENTS : TOOL_EVENTS));
  });
  const port = await openPort();
  const dir = mkdtempSync(path.join(os.tmpdir(), "grok-oauth-stream-retry-"));
  const child = startForwarder(port, backend.port, writeSession(dir));
  const base = `http://127.0.0.1:${port}`;
  try {
    await waitHealth(base, child);
    const resp = await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({
        model: "grok-4.6",
        messages: [{ role: "user", content: "update the deck" }],
        tools: [{ type: "function", function: { name: "exec_command", parameters: { type: "object" } } }],
        stream: true,
      }),
    });
    const body = await readAll(resp);
    assert.equal(inbound, 2);
    assert.match(body, /Next I will update the deck/);
    assert.match(body, /exec_command/);
    assert.match(body, /"finish_reason":"tool_calls"/);
    assert.match(body, /"progress_only_retried":true/);
  } finally {
    await stop(child);
    await new Promise((r) => backend.server.close(r));
    rmSync(dir, { recursive: true, force: true });
  }
});

test("keeps the first streamed answer when the retry also has no tools", async () => {
  let inbound = 0;
  const backend = await mockBackend(async (_req, res) => {
    inbound += 1;
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.end(
      sse(
        inbound === 1
          ? PROGRESS_EVENTS
          : [
              { type: "response.output_text.delta", delta: "Still thinking about it." },
              {
                type: "response.completed",
                response: {
                  usage: {
                    input_tokens: 106_000,
                    output_tokens: 500,
                    output_tokens_details: { reasoning_tokens: 480 },
                  },
                },
              },
            ],
      ),
    );
  });
  const port = await openPort();
  const dir = mkdtempSync(path.join(os.tmpdir(), "grok-oauth-stream-keep-"));
  const child = startForwarder(port, backend.port, writeSession(dir));
  const base = `http://127.0.0.1:${port}`;
  try {
    await waitHealth(base, child);
    const resp = await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({
        model: "grok-4.6",
        messages: [{ role: "user", content: "update the deck" }],
        tools: [{ type: "function", function: { name: "exec_command", parameters: { type: "object" } } }],
        stream: true,
      }),
    });
    const body = await readAll(resp);
    assert.equal(inbound, 2);
    assert.match(body, /Next I will update the deck/);
    assert.doesNotMatch(body, /Still thinking about it/);
    assert.match(body, /"finish_reason":"stop"/);
  } finally {
    await stop(child);
    await new Promise((r) => backend.server.close(r));
    rmSync(dir, { recursive: true, force: true });
  }
});
