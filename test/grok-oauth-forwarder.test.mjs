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
import {
  APPLY_PATCH_TOOL_NAME,
  GROK_APPLY_PATCH_CREATE_EXAMPLE,
  GROK_APPLY_PATCH_GUIDANCE_MARKER,
  GROK_APPLY_PATCH_GUIDANCE_ROUTE,
  GROK_APPLY_PATCH_UPDATE_EXAMPLE,
  applyGrokApplyPatchGuidance,
} from "../src/grok-apply-patch-guidance.mjs";

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

// The forwarder writes its diagnostics to stderr after it has finished
// answering the client, so a request that has already resolved proves nothing
// about what the parent has read from the child's pipe yet. Wait for the
// marker rather than asserting on one snapshot: that race turned into a
// macOS-only CI flake whose stderr held only "[grok-oauth] listening".
async function waitChildError(child, pattern, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const errors = child.testErrors();
    if (pattern.test(errors)) return errors;
    if (child.exitCode !== null) throw new Error(`exited before log marker: ${errors}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`stderr marker timeout: ${child.testErrors()}`);
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
    const clientFunction = Array.isArray(captured.tools)
      ? captured.tools.find((tool) => tool.type === "function")
      : undefined;
    if (clientFunction) {
      const argumentsJson = clientFunction.name === "inspect_image"
        ? '{"path":"C:\\\\image.jpg"}'
        : '{"city":"SF"}';
      res.end(
        sse([
          { type: "response.output_item.added", item: { type: "function_call", id: "fc_1", call_id: "call_1", name: clientFunction.name } },
          { type: "response.function_call_arguments.delta", item_id: "fc_1", delta: argumentsJson },
          { type: "response.output_item.done", item: { type: "function_call", id: "fc_1", call_id: "call_1", name: clientFunction.name, arguments: argumentsJson } },
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

    // Grok 4.6 receives the provider-selectable alias, while Codex gets its
    // native tool name back from the streamed function-call response.
    const imageResp = await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({
        model: "grok-4.6",
        messages: [{ role: "user", content: "inspect the image" }],
        tools: [
          { type: "function", function: { name: "view_image", parameters: { type: "object" } } },
        ],
        stream: false,
      }),
    });
    const imageTool = await imageResp.json();
    assert.equal(captured.tools[0].name, "inspect_image");
    assert.equal(imageTool.choices[0].finish_reason, "tool_calls");
    assert.equal(imageTool.choices[0].message.tool_calls[0].function.name, "view_image");
    assert.equal(
      imageTool.choices[0].message.tool_calls[0].function.arguments,
      '{"path":"C:\\\\image.jpg"}',
    );
  } finally {
    await stop(child);
    await new Promise((r) => backend.server.close(r));
    rmSync(dir, { recursive: true, force: true });
  }
});

test("emits one terminal SSE error when the upstream stream fails mid-turn", async () => {
  const backend = await mockBackend((_req, res) => {
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.write(sse([{ type: "response.output_text.delta", delta: "partial" }]));
    // A real socket failure makes fetch's body reader reject after the first
    // chunk, exercising the forwarder's top-level HTTP error handler.
    setImmediate(() => res.destroy());
  });
  const port = await openPort();
  const dir = mkdtempSync(path.join(os.tmpdir(), "grok-oauth-midstream-error-"));
  const child = startForwarder(port, backend.port, writeSession(dir));
  try {
    await waitHealth(`http://127.0.0.1:${port}`, child);
    const result = await new Promise((resolve, reject) => {
      const req = http.request(
        {
          hostname: "127.0.0.1",
          port,
          path: "/v1/chat/completions",
          method: "POST",
          headers: {
            ...auth,
            "Content-Length": Buffer.byteLength(
              JSON.stringify({
                model: "grok-4.6",
                messages: [{ role: "user", content: "continue" }],
                stream: true,
              }),
            ),
          },
        },
        (response) => {
          let body = "";
          response.setEncoding("utf8");
          response.on("data", (chunk) => {
            body += chunk;
          });
          response.once("error", reject);
          response.once("aborted", () => reject(new Error("forwarder response was aborted")));
          response.once("end", () => resolve({ status: response.statusCode, body }));
        },
      );
      req.once("error", reject);
      req.end(
        JSON.stringify({
          model: "grok-4.6",
          messages: [{ role: "user", content: "continue" }],
          stream: true,
        }),
      );
    });
    assert.equal(result.status, 200);
    assert.match(result.body, /"content":"partial"/);
    assert.equal((result.body.match(/event: error/g) || []).length, 1);
    assert.match(result.body, /local_router_stream_failed/);
    assert.doesNotMatch(result.body, /data: \[DONE\]/);
    await waitChildError(
      child,
      /upstream-phase-failed=true phase=attempt model=grok-4\.6 attempt_req=[0-9a-f-]{36} attempt_headers_ms=\d+ attempt_first_event_ms=\d+ attempt_total_ms=\d+ error=(?:TypeError|AbortError)/,
    );
  } finally {
    await stop(child);
    await new Promise((r) => backend.server.close(r));
    rmSync(dir, { recursive: true, force: true });
  }
});

test("streams xAI reasoning deltas as chat reasoning_content", async () => {
  const backend = await mockBackend(async (req, res) => {
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.end(
      sse([
        { type: "response.reasoning_summary_text.delta", delta: "先想" },
        { type: "response.reasoning_text.delta", delta: "再想" },
        { type: "response.output_text.delta", delta: "答案" },
        { type: "response.completed", response: { usage: { input_tokens: 8, output_tokens: 12 } } },
      ]),
    );
  });
  const port = await openPort();
  const dir = mkdtempSync(path.join(os.tmpdir(), "grok-oauth-reason-"));
  const child = startForwarder(port, backend.port, writeSession(dir));
  const base = `http://127.0.0.1:${port}`;
  try {
    await waitHealth(base, child);
    const streamed = await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({
        model: "grok-4.6",
        messages: [{ role: "user", content: "ping" }],
        stream: true,
      }),
    });
    const body = await streamed.text();
    assert.match(body, /"reasoning_content":"先想"/);
    assert.match(body, /"reasoning_content":"再想"/);
    assert.match(body, /"content":"答案"/);
    const complete = await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({
        model: "grok-4.6",
        messages: [{ role: "user", content: "ping" }],
      }),
    });
    const json = await complete.json();
    assert.equal(json.choices[0].message.reasoning_content, "先想再想");
    assert.equal(json.choices[0].message.content, "答案");
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

test("toResponsesRequest copies known service_tier and omits anything else", () => {
  const priority = toResponsesRequest({
    model: "grok-4.6",
    messages: [{ role: "user", content: "ping" }],
    service_tier: "priority",
  });
  assert.equal(priority.service_tier, "priority");

  const standard = toResponsesRequest({
    model: "grok-4.6",
    messages: [{ role: "user", content: "ping" }],
    service_tier: "default",
  });
  assert.equal(standard.service_tier, "default");

  const omitted = toResponsesRequest({
    model: "grok-4.6",
    messages: [{ role: "user", content: "ping" }],
  });
  assert.equal("service_tier" in omitted, false);

  const empty = toResponsesRequest({
    model: "grok-4.6",
    messages: [{ role: "user", content: "ping" }],
    service_tier: "  ",
  });
  assert.equal("service_tier" in empty, false);

  const unknown = toResponsesRequest({
    model: "grok-4.6",
    messages: [{ role: "user", content: "ping" }],
    service_tier: "flex",
  });
  assert.equal("service_tier" in unknown, false);
  assert.equal("service_tier" in toResponsesRequest({ model: "grok-4.5", messages: [], service_tier: "priority" }), false);
});

test("toResponsesRequest aliases view_image only at the Grok boundary", () => {
  const request = toResponsesRequest({
    model: "grok-4.6",
    messages: [
      {
        role: "assistant",
        content: "",
        tool_calls: [
          {
            id: "call_image",
            type: "function",
            function: { name: "view_image", arguments: '{"path":"C:\\\\image.jpg"}' },
          },
        ],
      },
    ],
    tools: [
      {
        type: "function",
        function: {
          name: "view_image",
          description: "View a local image.",
          parameters: { type: "object", properties: { path: { type: "string" } } },
        },
      },
    ],
    tool_choice: { type: "function", function: { name: "view_image" } },
  });

  assert.equal(request.tools.find((tool) => tool.type === "function").name, "inspect_image");
  assert.equal(request.input[0].name, "inspect_image");
  assert.deepEqual(request.tool_choice, { type: "function", name: "inspect_image" });
});

test("toResponsesRequest does not alias view_image over a real inspect_image", () => {
  const request = toResponsesRequest({
    model: "grok-4.6",
    messages: [{ role: "user", content: "inspect it" }],
    tools: [
      { type: "function", function: { name: "view_image", parameters: { type: "object" } } },
      { type: "function", function: { name: "inspect_image", parameters: { type: "object" } } },
    ],
    tool_choice: { type: "function", function: { name: "view_image" } },
  });

  const names = request.tools
    .filter((tool) => tool.type === "function")
    .map((tool) => tool.name);
  assert.deepEqual(names, ["view_image", "inspect_image"]);
  assert.deepEqual(request.tool_choice, { type: "function", name: "view_image" });
});

test("toResponsesRequest leaves view_image unchanged for other Grok models", () => {
  const request = toResponsesRequest({
    model: "grok-4.5",
    messages: [{ role: "user", content: "inspect it" }],
    tools: [
      { type: "function", function: { name: "view_image", parameters: { type: "object" } } },
    ],
  });

  assert.equal(
    request.tools.find((tool) => tool.type === "function").name,
    "view_image",
  );
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

test("toResponsesRequest preserves structured image tool outputs", () => {
  function toolOutput(content) {
    const request = toResponsesRequest(
      {
        model: "grok-4.6",
        messages: [
          {
            role: "assistant",
            content: "",
            tool_calls: [
              {
                id: "call_1",
                type: "function",
                function: { name: "view_image", arguments: "{}" },
              },
            ],
          },
          {
            role: "tool",
            tool_call_id: "call_1",
            content,
          },
        ],
      },
      { hostedSearchEnabled: false },
    );

    return request.input.find(
      (item) => item.type === "function_call_output",
    ).output;
  }

  // Existing string tool outputs remain unchanged.
  assert.equal(toolOutput("plain text result"), "plain text result");

  // Structured non-image outputs keep the existing JSON-string behavior.
  assert.equal(
    toolOutput([{ type: "text", text: "hello" }]),
    JSON.stringify([{ type: "text", text: "hello" }]),
  );

  // Native Codex image tool results remain multimodal and preserve detail.
  assert.deepEqual(
    toolOutput([
      {
        type: "input_image",
        image_url: "data:image/jpeg;base64,/9j/AA==",
        detail: "original",
      },
    ]),
    [
      {
        type: "input_image",
        image_url: "data:image/jpeg;base64,/9j/AA==",
        detail: "original",
      },
    ],
  );

  // Mixed multimodal output preserves the original part ordering.
  assert.deepEqual(
    toolOutput([
      {
        type: "input_image",
        image_url: "data:image/jpeg;base64,/9j/AA==",
        detail: "original",
      },
      { type: "text", text: "between images" },
      {
        type: "input_image",
        image_url: "data:image/png;base64,iVBORw0KGgo=",
        detail: "high",
      },
    ]),
    [
      {
        type: "input_image",
        image_url: "data:image/jpeg;base64,/9j/AA==",
        detail: "original",
      },
      { type: "input_text", text: "between images" },
      {
        type: "input_image",
        image_url: "data:image/png;base64,iVBORw0KGgo=",
        detail: "high",
      },
    ],
  );

  // Some tool transports label image data as generic octet-stream.
  // Recover a usable image MIME type from the encoded file signature.
  for (const [mime, base64] of [
    ["image/jpeg", "/9j/AA=="],
    ["image/png", "iVBORw0KGgo="],
    ["image/gif", "R0lGODlh"],
    ["image/webp", "UklGRgAAAABXRUJQ"],
  ]) {
    assert.deepEqual(
      toolOutput([
        {
          type: "image_url",
          image_url: {
            url: `data:application/octet-stream;base64,${base64}`,
            detail: "low",
          },
        },
      ]),
      [
        {
          type: "input_image",
          image_url: `data:${mime};base64,${base64}`,
          detail: "low",
        },
      ],
    );
  }
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

test("streams a done-only function call with an unterminated successful terminal SSE block", async () => {
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
    res.write(sse([event]));
    res.end('event: response.completed\ndata: {"type":"response.completed"}\n');
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

test("buffers a proven progress-only prefix without losing a healthy short answer", async () => {
  let inbound = 0;
  const backend = await mockBackend(async (_req, res) => {
    inbound += 1;
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    if (inbound <= 2) {
      res.end(sse(PROGRESS_EVENTS));
      return;
    }
    if (inbound === 3) {
      res.end(
        sse([
          { type: "response.output_text.delta", delta: "Done." },
          { type: "response.completed", response: { usage: { input_tokens: 20, output_tokens: 5 } } },
        ]),
      );
      return;
    }
    res.write(sse([{ type: "response.output_text.delta", delta: "Next I will update the deck." }]));
    setImmediate(() => res.destroy());
  });
  const port = await openPort();
  const dir = mkdtempSync(path.join(os.tmpdir(), "grok-oauth-repeat-abort-"));
  const child = startForwarder(port, backend.port, writeSession(dir));
  const base = `http://127.0.0.1:${port}`;
  const opening = [
    { role: "system", content: "You are Codex." },
    { role: "user", content: "update the deck" },
  ];
  const tools = [
    { type: "function", function: { name: "exec_command", parameters: { type: "object" } } },
  ];
  try {
    await waitHealth(base, child);
    const first = await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ model: "grok-4.6", messages: opening, tools, stream: false }),
    });
    assert.equal(first.status, 200);
    assert.equal(inbound, 2);

    const followUpMessages = [
      ...opening,
      { role: "assistant", content: "Next I will update the deck." },
      { role: "user", content: "continue" },
    ];
    const healthy = await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({
        model: "grok-4.6",
        messages: followUpMessages,
        tools,
        stream: true,
      }),
    });
    const healthyBody = await readAll(healthy);
    assert.equal(healthy.status, 200);
    assert.equal(inbound, 3);
    assert.match(healthyBody, /"content":"Done\."/);
    assert.match(healthyBody, /data: \[DONE\]/);

    const repeated = await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({
        model: "grok-4.6",
        messages: followUpMessages,
        tools,
        stream: true,
      }),
    });
    const body = await readAll(repeated);
    assert.equal(repeated.status, 200);
    assert.equal(inbound, 4);
    assert.doesNotMatch(body, /Next I will update the deck/);
    assert.equal((body.match(/event: error/g) || []).length, 1);
    assert.match(body, /local_router_stream_failed/);
    assert.doesNotMatch(body, /data: \[DONE\]/);
  } finally {
    await stop(child);
    await new Promise((r) => backend.server.close(r));
    rmSync(dir, { recursive: true, force: true });
  }
});

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
    const events = (inbound === 1 ? PROGRESS_EVENTS : TOOL_EVENTS).map(event =>
      event.response ? { ...event, response: { ...event.response, service_tier: inbound === 1 ? "default" : "priority" } } : event);
    res.end(sse(events));
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
        service_tier: "priority",
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
    assert.equal(json.service_tier, undefined);
    assert.equal(json.provider_specific_fields?.grok_service_tier, undefined);
    assert.equal(resp.headers.get("x-codex-router-grok-service-tier"), null);
    assert.equal(JSON.parse(bodies[0]).service_tier, "priority");
    const retryBody = JSON.parse(bodies[1]);
    assert.equal(retryBody.service_tier, "priority");
    assert.equal(retryBody.instructions, "You are Codex.");
    // No prior tool result, so the decline-first nudge stays. See
    // "a finished task ... declines" and the after-tool case below.
    assert.match(
      JSON.stringify(retryBody.input),
      /already completed the task, restate the final answer and call no tool/,
    );
    assert.match(JSON.stringify(retryBody.input), /Otherwise continue the same task now/);
    await waitChildError(child, /progress-only-retried=true/);
  } finally {
    await stop(child);
    await new Promise((r) => backend.server.close(r));
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a short stop after a tool result is nudged to continue, regardless of wording", async () => {
  let inbound = 0;
  const bodies = [];
  const backend = await mockBackend(async (req, res) => {
    inbound += 1;
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    bodies.push(Buffer.concat(chunks).toString("utf8"));
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.end(
      sse(
        inbound === 1
          ? [
              { type: "response.output_text.delta", delta: "The figures are ready." },
              {
                type: "response.completed",
                response: {
                  usage: {
                    input_tokens: 12_000,
                    output_tokens: 95,
                    output_tokens_details: { reasoning_tokens: 40 },
                  },
                },
              },
            ]
          : [
              {
                type: "response.output_item.done",
                item: {
                  type: "function_call",
                  id: "fc_view",
                  call_id: "call_view",
                  name: "view_image",
                  arguments: '{"path":"figures.png"}',
                },
              },
              {
                type: "response.completed",
                response: { usage: { input_tokens: 12_100, output_tokens: 40 } },
              },
            ],
      ),
    );
  });
  const port = await openPort();
  const dir = mkdtempSync(path.join(os.tmpdir(), "grok-oauth-plan-"));
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
          { role: "assistant", tool_calls: [{ id: "call_py", type: "function", function: { name: "exec_command", arguments: "{}" } }] },
          { role: "tool", tool_call_id: "call_py", content: "wrote figures.png" },
        ],
        tools: [{ type: "function", function: { name: "view_image", parameters: { type: "object" } } }],
        stream: false,
      }),
    });
    const json = await resp.json();
    assert.equal(inbound, 2);
    assert.equal(json.choices[0].finish_reason, "tool_calls");
    assert.equal(json.choices[0].message.content, null);
    assert.equal(json.choices[0].message.tool_calls[0].function.name, "view_image");
    assert.equal(json.usage.prompt_tokens, 12_100);
    assert.equal(json.usage.billed_prompt_tokens, 24_100);
    assert.match(
      JSON.parse(bodies[1]).instructions,
      /The previous tool call finished/,
    );
    assert.doesNotMatch(
      JSON.parse(bodies[1]).instructions,
      /already completed the task/,
    );
    assert.match(JSON.stringify(JSON.parse(bodies[1]).tools), /__codex_router_submit_final/);
    assert.equal(JSON.parse(bodies[1]).tool_choice, "required");
  } finally {
    await stop(child);
    await new Promise((r) => backend.server.close(r));
    rmSync(dir, { recursive: true, force: true });
  }
});

test("opens a post-tool stream before classification while holding uncertified text", async () => {
  let inbound = 0;
  const uncertifiedProgress = "I will inspect the figure next. ".repeat(8);
  assert.ok(uncertifiedProgress.length > 120);
  let releaseFirstAttempt;
  const firstAttemptGate = new Promise((resolve) => {
    releaseFirstAttempt = resolve;
  });
  const backend = await mockBackend(async (_req, res) => {
    inbound += 1;
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    if (inbound === 1) {
      res.flushHeaders();
      res.write(
        sse([
          { type: "response.reasoning_summary_text.delta", delta: "Checking the tool result." },
          { type: "response.output_text.delta", delta: uncertifiedProgress },
        ]),
      );
      await firstAttemptGate;
      res.end(
        sse([
          { type: "response.completed", response: { usage: { input_tokens: 150_000, output_tokens: 180 } } },
        ]),
      );
      return;
    }
    res.end(
      sse([
        { type: "response.reasoning_summary_text.delta", delta: "Certifying the final answer." },
        {
          type: "response.output_item.done",
          item: {
            type: "function_call",
            id: "fc_final",
            call_id: "call_final",
            name: "__codex_router_submit_final",
            arguments: JSON.stringify({ answer: "The chart axis is months." }),
          },
        },
        { type: "response.completed", response: { usage: { input_tokens: 151_000, output_tokens: 90 } } },
      ]),
    );
  });
  const port = await openPort();
  const dir = mkdtempSync(path.join(os.tmpdir(), "grok-oauth-post-tool-live-"));
  const child = startForwarder(port, backend.port, writeSession(dir));
  try {
    await waitHealth(`http://127.0.0.1:${port}`, child);
    let responseTimeout;
    const resp = await Promise.race([
      fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
        method: "POST",
        headers: auth,
        body: JSON.stringify({
          model: "grok-4.6",
          messages: [
            { role: "assistant", tool_calls: [{ id: "c1", type: "function", function: { name: "exec_command", arguments: "{}" } }] },
            { role: "tool", tool_call_id: "c1", content: "rendered page" },
          ],
          tools: [{ type: "function", function: { name: "view_image", parameters: { type: "object" } } }],
          stream: true,
        }),
      }),
      new Promise((_, reject) => {
        responseTimeout = setTimeout(
          () => reject(new Error("post-tool response head stayed buffered")),
          2_000,
        );
      }),
    ]);
    clearTimeout(responseTimeout);
    assert.equal(resp.status, 200);

    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let body = "";
    let reasoningTimeout;
    await Promise.race([
      (async () => {
        while (!body.includes("Checking the tool result.")) {
          const { value, done } = await reader.read();
          if (done) break;
          body += decoder.decode(value, { stream: true });
        }
      })(),
      new Promise((_, reject) => {
        reasoningTimeout = setTimeout(
          () => reject(new Error("post-tool reasoning stayed buffered")),
          2_000,
        );
      }),
    ]);
    clearTimeout(reasoningTimeout);
    assert.match(body, /"role":"assistant"/);
    assert.match(body, /"reasoning_content":"Checking the tool result\."/);
    assert.doesNotMatch(body, /I will inspect the figure next/);

    releaseFirstAttempt();
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      body += decoder.decode(value, { stream: true });
    }
    assert.equal(inbound, 2);
    assert.doesNotMatch(body, /I will inspect the figure next/);
    assert.match(body, /"reasoning_content":"Certifying the final answer\."/);
    assert.match(body, /"content":"The chart axis is months\."/);
    assert.doesNotMatch(body, /__codex_router_submit_final/);
    assert.match(body, /data: \[DONE\]/);
    await waitChildError(
      child,
      /progress-only-retried=true retries=1 model=grok-4\.6 prefer=final attempt_req=[0-9a-f-]{36} attempt_headers_ms=\d+ attempt_first_event_ms=\d+ attempt_total_ms=\d+ repair_req=[0-9a-f-]{36} repair_headers_ms=\d+ repair_first_event_ms=\d+ repair_total_ms=\d+/,
    );
  } finally {
    releaseFirstAttempt?.();
    await stop(child);
    await new Promise((r) => backend.server.close(r));
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a streamed post-tool repair exposes reasoning and only the certified tool call", async () => {
  let inbound = 0;
  const backend = await mockBackend(async (_req, res) => {
    inbound += 1;
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.end(
      sse(
        inbound === 1
          ? [
              { type: "response.output_text.delta", delta: "I will inspect the figure next." },
              { type: "response.completed", response: { usage: { input_tokens: 150_000, output_tokens: 180 } } },
            ]
          : [
              { type: "response.reasoning_summary_text.delta", delta: "Selecting the next tool." },
              ...TOOL_EVENTS,
            ],
      ),
    );
  });
  const port = await openPort();
  const dir = mkdtempSync(path.join(os.tmpdir(), "grok-oauth-post-tool-live-call-"));
  const child = startForwarder(port, backend.port, writeSession(dir));
  try {
    await waitHealth(`http://127.0.0.1:${port}`, child);
    const resp = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({
        model: "grok-4.6",
        messages: [
          { role: "assistant", tool_calls: [{ id: "c1", type: "function", function: { name: "exec_command", arguments: "{}" } }] },
          { role: "tool", tool_call_id: "c1", content: "rendered page" },
        ],
        tools: [{ type: "function", function: { name: "exec_command", parameters: { type: "object" } } }],
        stream: true,
      }),
    });
    const body = await readAll(resp);
    assert.equal(resp.status, 200);
    assert.equal(inbound, 2);
    assert.doesNotMatch(body, /I will inspect the figure next/);
    assert.match(body, /"reasoning_content":"Selecting the next tool\."/);
    assert.match(body, /"name":"exec_command"/);
    assert.match(body, /"finish_reason":"tool_calls"/);
    assert.match(body, /data: \[DONE\]/);
  } finally {
    await stop(child);
    await new Promise((r) => backend.server.close(r));
    rmSync(dir, { recursive: true, force: true });
  }
});

test("post-tool repair releases held actions only after a successful terminal", async (t) => {
  let scenario;
  const backend = await mockBackend(async (_req, res) => {
    const current = scenario;
    current.inbound += 1;
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    if (current.inbound === 1) {
      res.end(sse([
        { type: "response.output_text.delta", delta: "Uncertified progress." },
        { type: "response.completed", response: { usage: { input_tokens: 100, output_tokens: 20 } } },
      ]));
      return;
    }
    const name = current.privateFinal ? "__codex_router_submit_final" : "exec_command";
    const args = JSON.stringify(current.privateFinal
      ? { answer: "Certified repair answer." }
      : { cmd: "repair-command" });
    res.write(sse([
      { type: "response.output_item.added", item: { type: "function_call", id: "fc_repair", call_id: "call_repair", name } },
      { type: "response.function_call_arguments.delta", item_id: "fc_repair", delta: args },
      { type: "response.output_item.done", item: { type: "function_call", id: "fc_repair", call_id: "call_repair", name, arguments: args } },
      // Reading this marker proves the preceding call frames were processed
      // before the terminal gate is released; reasoning must remain live.
      { type: "response.reasoning_summary_text.delta", delta: "Repair call prepared." },
    ]));
    current.repairReady.resolve();
    await current.terminalGate.promise;
    if (current.terminal === "eof") {
      res.end("data: [DONE]\n\n");
    } else if (current.terminal === "truncated") {
      res.end('event: response.completed\ndata: {"type":"response.comp');
    } else {
      res.end(sse([{
        type: `response.${current.terminal}`,
        response: {
          status: current.terminal,
          usage: { input_tokens: 110, output_tokens: 30 },
          ...(current.terminal === "failed" ? { error: { message: "private upstream failure detail" } } : {}),
        },
      }]));
    }
  });
  const port = await openPort();
  const dir = mkdtempSync(path.join(os.tmpdir(), "grok-oauth-repair-terminal-"));
  const child = startForwarder(port, backend.port, writeSession(dir));
  const base = `http://127.0.0.1:${port}`;
  const within = async (promise, message) => {
    let timeout;
    try {
      return await Promise.race([
        promise,
        new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error(message)), 2_000); }),
      ]);
    } finally {
      clearTimeout(timeout);
    }
  };
  try {
    await waitHealth(base, child);
    for (const stream of [false, true]) {
      for (const privateFinal of [false, true]) {
        for (const terminal of ["completed", "failed", "incomplete", "eof", "truncated"]) {
          await t.test(`${stream ? "SSE" : "JSON"} ${privateFinal ? "private final" : "client tool"}: ${terminal}`, async () => {
            scenario = { stream, privateFinal, terminal, inbound: 0,
              repairReady: Promise.withResolvers(), terminalGate: Promise.withResolvers() };
            const responsePromise = fetch(`${base}/v1/chat/completions`, {
              method: "POST", headers: auth,
              body: JSON.stringify({
                model: "grok-4.6",
                messages: [
                  { role: "assistant", tool_calls: [{ id: "c1", type: "function", function: { name: "exec_command", arguments: "{}" } }] },
                  { role: "tool", tool_call_id: "c1", content: "rendered page" },
                ],
                tools: [{ type: "function", function: { name: "exec_command", parameters: { type: "object" } } }],
                stream,
              }),
            });
            try {
              await within(scenario.repairReady.promise, "repair attempt did not start");
              let resp;
              let reader;
              let body = "";
              const decoder = new TextDecoder();
              if (stream) {
                resp = await within(responsePromise, "SSE response head stayed buffered");
                reader = resp.body.getReader();
                await within((async () => {
                  while (!body.includes("Repair call prepared.")) {
                    const { value, done } = await reader.read();
                    if (done) throw new Error("response ended before the terminal gate");
                    body += decoder.decode(value, { stream: true });
                  }
                })(), "repair reasoning stayed buffered");
                assert.doesNotMatch(body, /Uncertified progress|tool_calls|repair-command|Certified repair answer|__codex_router_submit_final|\[DONE\]/);
              }
              scenario.terminalGate.resolve();
              resp ??= await responsePromise;
              if (reader) {
                for (;;) {
                  const { value, done } = await reader.read();
                  if (done) break;
                  body += decoder.decode(value, { stream: true });
                }
                body += decoder.decode();
              } else {
                body = await resp.text();
              }
              assert.equal(scenario.inbound, 2, "a failed repair must never replay");
              assert.doesNotMatch(body, /Uncertified progress|__codex_router_submit_final|private upstream failure detail/);
              if (terminal === "completed") {
                assert.equal(resp.status, 200);
                if (stream) {
                  assert.equal((body.match(/data: \[DONE\]/g) || []).length, 1);
                  assert.doesNotMatch(body, /event: error/);
                  assert.equal((body.match(privateFinal ? /"content":"Certified repair answer\."/g : /"name":"exec_command"/g) || []).length, 1);
                  assert.match(body, privateFinal ? /"finish_reason":"stop"/ : /"finish_reason":"tool_calls"/);
                } else {
                  const json = JSON.parse(body);
                  assert.equal(json.choices[0].finish_reason, privateFinal ? "stop" : "tool_calls");
                  if (privateFinal) assert.equal(json.choices[0].message.content, "Certified repair answer.");
                  else assert.equal(json.choices[0].message.tool_calls[0].function.arguments, '{"cmd":"repair-command"}');
                }
              } else {
                assert.doesNotMatch(body, /repair-command|Certified repair answer|"name":"exec_command"|"finish_reason":"(?:stop|tool_calls)"|\[DONE\]/);
                if (stream) {
                  assert.equal(resp.status, 200);
                  assert.equal((body.match(/event: error/g) || []).length, 1);
                  assert.match(body, /local_router_stream_failed/);
                } else {
                  assert.equal(resp.status, 502);
                  assert.equal(JSON.parse(body).error.code, `grok_upstream_response_${["eof", "truncated"].includes(terminal) ? "missing" : terminal}`);
                  assert.doesNotMatch(body, /choices|tool_calls/);
                }
              }
            } finally {
              scenario.terminalGate.resolve();
              await responsePromise.then((resp) => resp.body?.cancel().catch(() => {})).catch(() => {});
            }
          });
        }
      }
    }
  } finally {
    scenario?.terminalGate.resolve();
    await stop(child);
    await new Promise((r) => backend.server.close(r));
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an unsuccessful first turn emits one error without replaying its live client tool", async (t) => {
  let terminal;
  let inbound;
  const backend = await mockBackend(async (_req, res) => {
    inbound += 1;
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.write(sse(TOOL_EVENTS.filter((event) => event.type !== "response.completed")));
    res.end(terminal === "missing" ? "data: [DONE]\n\n" : sse([{ type: `response.${terminal}` }]));
  });
  const port = await openPort();
  const dir = mkdtempSync(path.join(os.tmpdir(), "grok-oauth-terminal-no-replay-"));
  const child = startForwarder(port, backend.port, writeSession(dir));
  const base = `http://127.0.0.1:${port}`;
  try {
    await waitHealth(base, child);
    for (terminal of ["failed", "incomplete", "missing"]) {
      for (const stream of [false, true]) {
        await t.test(`${stream ? "SSE" : "JSON"}: ${terminal}`, async () => {
          inbound = 0;
          const resp = await fetch(`${base}/v1/chat/completions`, {
            method: "POST", headers: auth,
            body: JSON.stringify({
              model: "grok-4.6",
              messages: [
                { role: "assistant", tool_calls: [{ id: "c1", type: "function", function: { name: "exec_command", arguments: "{}" } }] },
                { role: "tool", tool_call_id: "c1", content: "rendered page" },
              ],
              tools: [{ type: "function", function: { name: "exec_command", parameters: { type: "object" } } }],
              stream,
            }),
          });
          const body = await resp.text();
          assert.equal(inbound, 1);
          assert.doesNotMatch(body, /"finish_reason":"(?:stop|tool_calls)"|\[DONE\]/);
          if (stream) {
            assert.equal(resp.status, 200);
            assert.equal((body.match(/"name":"exec_command"/g) || []).length, 1);
            assert.equal((body.match(/event: error/g) || []).length, 1);
            assert.match(body, /local_router_stream_failed/);
          } else {
            assert.equal(resp.status, 502);
            assert.equal(JSON.parse(body).error.code, `grok_upstream_response_${terminal}`);
            assert.doesNotMatch(body, /tool_calls/);
          }
        });
      }
    }
  } finally {
    await stop(child);
    await new Promise((r) => backend.server.close(r));
    rmSync(dir, { recursive: true, force: true });
  }
});

test("after-tool retry returns a certified final answer without leaking the internal tool", async () => {
  let inbound = 0;
  const backend = await mockBackend(async (_req, res) => {
    inbound += 1;
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.end(
      sse(
        inbound === 1
          ? [
              { type: "response.output_text.delta", delta: "I will inspect the figure next." },
              { type: "response.completed", response: { usage: { input_tokens: 150_000, output_tokens: 180 } } },
            ]
          : [
              {
                type: "response.output_item.done",
                item: {
                  type: "function_call",
                  id: "fc_final",
                  call_id: "call_final",
                  name: "__codex_router_submit_final",
                  arguments: JSON.stringify({ answer: "The chart axis is months." }),
                },
              },
              { type: "response.completed", response: { usage: { input_tokens: 151_000, output_tokens: 90 } } },
            ],
      ),
    );
  });
  const port = await openPort();
  const dir = mkdtempSync(path.join(os.tmpdir(), "grok-oauth-certified-final-"));
  const child = startForwarder(port, backend.port, writeSession(dir));
  try {
    await waitHealth(`http://127.0.0.1:${port}`, child);
    const resp = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({
        model: "grok-4.6",
        messages: [
          { role: "assistant", tool_calls: [{ id: "c1", type: "function", function: { name: "exec_command", arguments: "{}" } }] },
          { role: "tool", tool_call_id: "c1", content: "rendered page" },
        ],
        tools: [{ type: "function", function: { name: "view_image", parameters: { type: "object" } } }],
        stream: false,
      }),
    });
    const json = await resp.json();
    assert.equal(resp.status, 200);
    assert.equal(inbound, 2);
    assert.equal(json.choices[0].finish_reason, "stop");
    assert.equal(json.choices[0].message.content, "The chart axis is months.");
    assert.doesNotMatch(JSON.stringify(json), /__codex_router_submit_final/);
    assert.equal(json.usage.prompt_tokens, 151_000);
    assert.equal(json.usage.billed_prompt_tokens, 301_000);
  } finally {
    await stop(child);
    await new Promise((r) => backend.server.close(r));
    rmSync(dir, { recursive: true, force: true });
  }
});

test("double-empty after a tool result is an explicit terminal error, never a clean stop", async () => {
  let inbound = 0;
  const backend = await mockBackend(async (_req, res) => {
    inbound += 1;
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.end(
      sse([
        ...(inbound === 1 ? [{ type: "response.output_text.delta", delta: "\n" }] : []),
        { type: "response.completed", response: { usage: { input_tokens: 150_000, output_tokens: 90 } } },
      ]),
    );
  });
  const port = await openPort();
  const dir = mkdtempSync(path.join(os.tmpdir(), "grok-oauth-double-empty-"));
  const child = startForwarder(port, backend.port, writeSession(dir));
  try {
    await waitHealth(`http://127.0.0.1:${port}`, child);
    for (const stream of [false, true]) {
      inbound = 0;
      const resp = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
        method: "POST",
        headers: auth,
        body: JSON.stringify({
          model: "grok-4.6",
          messages: [
            { role: "assistant", tool_calls: [{ id: "c1", type: "function", function: { name: "exec_command", arguments: "{}" } }] },
            { role: "tool", tool_call_id: "c1", content: "rendered page" },
          ],
          tools: [{ type: "function", function: { name: "view_image", parameters: { type: "object" } } }],
          stream,
        }),
      });
      const body = await resp.text();
      assert.equal(inbound, 2);
      if (stream) {
        assert.equal(resp.status, 200);
        assert.equal((body.match(/event: error/g) || []).length, 1);
        assert.match(body, /local_router_stream_failed/);
        assert.match(body, /Grok stopped after a tool result/);
        assert.doesNotMatch(body, /"finish_reason":"(?:stop|tool_calls)"|\[DONE\]/);
      } else {
        assert.equal(resp.status, 502);
        assert.match(body, /progress_only_unrepairable/);
        assert.doesNotMatch(body, /finish_reason|\[DONE\]/);
      }
    }
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

// A finished task answered in one line is byte-for-byte the shape the trigger
// looks for, so the retry fires on it and always will. What must not happen is
// the retry manufacturing a tool call the model never meant to make and the
// forwarder grafting it onto the answer -- the client would then run it. The
// nudge's no-tool branch is what routes this into keep-first.
test("a finished task answered in one line declines the retry instead of calling a tool", async () => {
  let inbound = 0;
  const bodies = [];
  const backend = await mockBackend(async (req, res) => {
    inbound += 1;
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    bodies.push(Buffer.concat(chunks).toString("utf8"));
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.end(
      sse(
        inbound === 1
          ? [
              { type: "response.output_text.delta", delta: "Yes, that is correct." },
              {
                type: "response.completed",
                response: {
                  usage: {
                    input_tokens: 5_000,
                    output_tokens: 1_500,
                    output_tokens_details: { reasoning_tokens: 1_490 },
                  },
                },
              },
            ]
          : // The model takes the no-tool branch the nudge offers.
            [
              { type: "response.output_text.delta", delta: "Yes. Nothing further to do." },
              {
                type: "response.completed",
                response: { usage: { input_tokens: 5_010, output_tokens: 60 } },
              },
            ],
      ),
    );
  });
  const port = await openPort();
  const dir = mkdtempSync(path.join(os.tmpdir(), "grok-oauth-finished-"));
  const child = startForwarder(port, backend.port, writeSession(dir));
  const base = `http://127.0.0.1:${port}`;
  try {
    await waitHealth(base, child);
    const resp = await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({
        model: "grok-4.6",
        messages: [{ role: "user", content: "Is the config right?" }],
        tools: [
          { type: "function", function: { name: "exec_command", parameters: { type: "object" } } },
        ],
        stream: false,
      }),
    });
    const json = await resp.json();
    assert.equal(inbound, 2);
    assert.equal(json.choices[0].finish_reason, "stop");
    assert.equal(json.choices[0].message.content, "Yes, that is correct.");
    assert.equal(json.choices[0].message.tool_calls, undefined);
    // Both attempts were billed, and the marker says so.
    assert.equal(json.usage.prompt_tokens, 5_000 + 5_010);
    assert.equal(json.usage.progress_only_retried, true);
    const retryBody = JSON.parse(bodies[1]);
    assert.match(
      JSON.stringify(retryBody.input),
      /already completed the task, restate the final answer and call no tool/,
    );
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
    await waitChildError(child, /progress-only-retry-failed=true/);
  } finally {
    await stop(child);
    await new Promise((r) => backend.server.close(r));
    rmSync(dir, { recursive: true, force: true });
  }
});

test("stops reading an upstream that keeps its socket open after the terminal event", async () => {
  let held;
  const backend = await mockBackend(async (_req, res) => {
    held = res;
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.write(sse([
      { type: "response.output_text.delta", delta: "Finished without closing." },
      { type: "response.completed", response: { usage: { input_tokens: 10, output_tokens: 4 } } },
    ]));
  });
  const port = await openPort();
  const dir = mkdtempSync(path.join(os.tmpdir(), "grok-oauth-open-after-terminal-"));
  const child = startForwarder(port, backend.port, writeSession(dir));
  const base = `http://127.0.0.1:${port}`;
  try {
    await waitHealth(base, child);
    const started = Date.now();
    const resp = await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({
        model: "grok-4.6",
        messages: [{ role: "user", content: "finish" }],
        stream: false,
      }),
      signal: AbortSignal.timeout(5_000),
    });
    const json = await resp.json();
    assert.equal(resp.status, 200, JSON.stringify(json));
    assert.equal(json.choices[0].message.content, "Finished without closing.");
    assert.ok(Date.now() - started < 5_000, "waited for the upstream to close its socket");
  } finally {
    held?.end();
    await stop(child);
    await new Promise((r) => backend.server.close(r));
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a streamed optional progress-only retry that fails keeps the first answer", async () => {
  let inbound = 0;
  const backend = await mockBackend(async (req, res) => {
    for await (const _chunk of req) {
      // Drain the request before answering.
    }
    inbound += 1;
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.end(sse(inbound === 1
      ? PROGRESS_EVENTS
      : [{ type: "response.failed", response: { status: "failed" } }]));
  });
  const port = await openPort();
  const dir = mkdtempSync(path.join(os.tmpdir(), "grok-oauth-optional-retry-stream-"));
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
    const text = await resp.text();
    assert.equal(resp.status, 200, text);
    assert.equal(inbound, 2);
    assert.match(text, /Next I will update the deck\./);
    assert.match(text, /"finish_reason":"stop"/);
    assert.doesNotMatch(text, /"error"/);
    await waitChildError(child, /progress-only-retry-failed=true .*terminal=failed/);
  } finally {
    await stop(child);
    await new Promise((r) => backend.server.close(r));
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an optional progress-only retry that does not complete keeps the first answer", async () => {
  for (const [label, retryEvents] of [
    ["failed", [{ type: "response.failed", response: { status: "failed", usage: { input_tokens: 90, output_tokens: 3 } } }]],
    ["incomplete", [{ type: "response.incomplete", response: { status: "incomplete" } }]],
    ["missing", [{ type: "response.output_text.delta", delta: "partial retry text" }]],
  ]) {
    let inbound = 0;
    const backend = await mockBackend(async (req, res) => {
      for await (const _chunk of req) {
        // Drain the request before answering.
      }
      inbound += 1;
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.end(sse(inbound === 1 ? PROGRESS_EVENTS : retryEvents));
    });
    const port = await openPort();
    const dir = mkdtempSync(path.join(os.tmpdir(), `grok-oauth-optional-retry-${label}-`));
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
      assert.equal(resp.status, 200, `${label}: ${JSON.stringify(json)}`);
      assert.equal(inbound, 2, label);
      assert.equal(json.choices[0].message.content, "Next I will update the deck.", label);
      assert.equal(json.choices[0].finish_reason, "stop", label);
      assert.doesNotMatch(json.choices[0].message.content, /partial retry text/, label);
      await waitChildError(
        child,
        new RegExp(`progress-only-retry-failed=true .*terminal=${label}`),
      ).catch((error) => { throw new Error(`${label}: ${error.message}`); });
    } finally {
      await stop(child);
      await new Promise((r) => backend.server.close(r));
      rmSync(dir, { recursive: true, force: true });
    }
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

const V4A_GRAMMAR = [
  "start: begin_patch hunk+ end_patch",
  'begin_patch: "*** Begin Patch" LF',
  'end_patch: "*** End Patch" LF?',
  "",
  "hunk: add_hunk | delete_hunk | update_hunk",
  'add_hunk: "*** Add File: " filename LF add_line+',
  'delete_hunk: "*** Delete File: " filename LF',
  'update_hunk: "*** Update File: " filename LF change_move? change?',
  "filename: /(.+)/",
  'add_line: "+" /(.+)/ LF -> line',
  "",
  'change_move: "*** Move to: " filename LF',
  "change: (change_context | change_line)+ eof_line?",
  'change_context: ("@@" | "@@ " /(.+)/) LF',
  'change_line: ("+" | "-" | " ") /(.+)/ LF',
  'eof_line: "*** End of File" LF',
  "",
  "%import common.LF",
].join("\n");

// Hand-built LiteLLM 1.96 custom-tool function shape. Live conversion through
// the installed proxy is scripts/verify-grok-apply-patch-guidance.mjs.
function litellmCustomToolFunctionShape(tool) {
  const syntax = typeof tool.format?.syntax === "string" && tool.format.syntax ? tool.format.syntax : "lark";
  const definition = typeof tool.format?.definition === "string" ? tool.format.definition : "";
  const description = `${tool.description || ""}\n\nFormat:\n\`\`\`${syntax}\n${definition}\n\`\`\``;
  return {
    type: "function",
    function: {
      name: tool.name,
      description,
      parameters: {
        type: "object",
        properties: {
          content: {
            type: "string",
            description: `The ${tool.name} content following the specified format`,
          },
        },
        required: ["content"],
      },
    },
  };
}

test("Grok 4.6 apply_patch guidance reaches the forwarder in LiteLLM's custom-tool function shape", () => {
  const originalDescription = "Apply a patch.";
  const originalFormat = { type: "grammar", syntax: "lark", definition: V4A_GRAMMAR };
  const ordinary = { type: "function", name: APPLY_PATCH_TOOL_NAME, parameters: { type: "object" } };
  const native = applyGrokApplyPatchGuidance(
    [
      {
        type: "custom",
        name: APPLY_PATCH_TOOL_NAME,
        description: originalDescription,
        format: originalFormat,
      },
      ordinary,
    ],
    { slug: GROK_APPLY_PATCH_GUIDANCE_ROUTE },
  )[0];
  assert.equal(native.type, "custom");
  assert.equal(native.format, originalFormat);
  assert.deepEqual(native.format, {
    type: "grammar",
    syntax: "lark",
    definition: V4A_GRAMMAR,
  });
  assert.equal(native.description.includes(GROK_APPLY_PATCH_GUIDANCE_MARKER), true);
  assert.equal(native.description.includes(GROK_APPLY_PATCH_CREATE_EXAMPLE), true);
  assert.equal(native.description.includes(GROK_APPLY_PATCH_UPDATE_EXAMPLE), true);

  const chatTool = litellmCustomToolFunctionShape(native);
  const formatFence = chatTool.function.description.match(/Format:\n```lark\n([\s\S]*)\n```$/);
  assert.ok(formatFence, "LiteLLM-shaped description keeps grammar in a Format fence");
  assert.equal(formatFence[1], V4A_GRAMMAR);
  const beforeFormat = chatTool.function.description.slice(
    0,
    chatTool.function.description.indexOf("\n\nFormat:"),
  );
  assert.equal(beforeFormat.includes(originalDescription), true);
  assert.equal(beforeFormat.includes(GROK_APPLY_PATCH_CREATE_EXAMPLE), true);
  assert.deepEqual(chatTool.function.parameters.required, ["content"]);

  const forwarded = toResponsesRequest({
    model: "grok-4.6",
    messages: [{ role: "user", content: "patch notes.txt" }],
    tools: [chatTool, { type: "function", function: { name: APPLY_PATCH_TOOL_NAME, description: "ordinary same-name function", parameters: ordinary.parameters } }],
  });
  const applyPatch = forwarded.tools.find((tool) => tool.type === "function" && tool.name === APPLY_PATCH_TOOL_NAME);
  assert.ok(applyPatch);
  assert.equal(applyPatch.description, chatTool.function.description);
  assert.deepEqual(applyPatch.parameters.required, ["content"]);
  assert.equal(
    forwarded.tools.filter((tool) => tool.type === "function" && tool.name === APPLY_PATCH_TOOL_NAME).length,
    1,
    "the Grok forwarder keeps one apply_patch definition and does not merge guidance onto a same-named ordinary function",
  );
});

test("Grok forwarder keeps apply_patch call ids and streamed unicode quotes newlines verbatim", async () => {
  const rawPatch = [
    "*** Begin Patch",
    '*** Add File: café "quotes".txt',
    "+hello “unicode”",
    "*** End Patch",
  ].join("\n");
  const wrapped = JSON.stringify({ content: rawPatch });
  const malformed = "*** Begin Patch\nnot-a-json-object";
  let captured;
  const backend = await mockBackend(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    captured = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    const call = captured.input.find((item) => item.type === "function_call");
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.end(
      sse([
        {
          type: "response.output_item.added",
          item: {
            type: "function_call",
            id: "fc_unicode",
            call_id: "call_unicode",
            name: APPLY_PATCH_TOOL_NAME,
          },
        },
        {
          type: "response.function_call_arguments.delta",
          item_id: "fc_unicode",
          delta: call?.arguments === malformed ? malformed : wrapped,
        },
        {
          type: "response.output_item.done",
          item: {
            type: "function_call",
            id: "fc_unicode",
            call_id: "call_unicode",
            name: APPLY_PATCH_TOOL_NAME,
            arguments: call?.arguments === malformed ? malformed : wrapped,
          },
        },
        { type: "response.completed", response: { usage: { input_tokens: 11, output_tokens: 9 } } },
      ]),
    );
  });
  const port = await openPort();
  const dir = mkdtempSync(path.join(os.tmpdir(), "grok-oauth-patch-guidance-"));
  const child = startForwarder(port, backend.port, writeSession(dir));
  const base = `http://127.0.0.1:${port}`;
  try {
    await waitHealth(base, child);
    const tools = [
      {
        type: "function",
        function: {
          name: APPLY_PATCH_TOOL_NAME,
          description: `Apply a patch.\n\n${GROK_APPLY_PATCH_GUIDANCE_MARKER}`,
          parameters: {
            type: "object",
            properties: { content: { type: "string" } },
            required: ["content"],
          },
        },
      },
    ];
    const streamed = await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({
        model: "grok-4.6",
        messages: [
          { role: "user", content: "edit café" },
          {
            role: "assistant",
            tool_calls: [
              {
                id: "call_history",
                type: "function",
                function: { name: APPLY_PATCH_TOOL_NAME, arguments: wrapped },
              },
            ],
          },
          { role: "tool", tool_call_id: "call_history", content: "Done!" },
        ],
        tools,
        stream: true,
      }),
    });
    const streamBody = await streamed.text();
    assert.equal(captured.input.find((item) => item.type === "function_call").call_id, "call_history");
    assert.equal(captured.input.find((item) => item.type === "function_call").arguments, wrapped);
    assert.match(streamBody, /"id":"call_unicode"/);
    const streamedArguments = [];
    for (const line of streamBody.split(/\n/)) {
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (!data || data === "[DONE]") continue;
      let parsed;
      try {
        parsed = JSON.parse(data);
      } catch {
        continue;
      }
      const deltaArgs = parsed.choices?.[0]?.delta?.tool_calls?.[0]?.function?.arguments;
      if (typeof deltaArgs === "string") streamedArguments.push(deltaArgs);
    }
    assert.equal(streamedArguments.join(""), wrapped);
    assert.equal(JSON.parse(streamedArguments.join("")).content, rawPatch);

    const malformedResp = await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({
        model: "grok-4.6",
        messages: [
          { role: "user", content: "edit again" },
          {
            role: "assistant",
            tool_calls: [
              {
                id: "call_malformed",
                type: "function",
                function: { name: APPLY_PATCH_TOOL_NAME, arguments: malformed },
              },
            ],
          },
          { role: "tool", tool_call_id: "call_malformed", content: "Failed" },
        ],
        tools,
        stream: false,
      }),
    });
    const malformedJson = await malformedResp.json();
    assert.equal(captured.input.find((item) => item.type === "function_call").arguments, malformed);
    assert.equal(
      malformedJson.choices[0].message.tool_calls[0].function.arguments,
      malformed,
    );
  } finally {
    await stop(child);
    await new Promise((r) => backend.server.close(r));
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Grok 4.5 does not receive apply_patch V4A guidance from this route", () => {
  const tools = [
    {
      type: "custom",
      name: APPLY_PATCH_TOOL_NAME,
      format: { type: "grammar", syntax: "lark", definition: V4A_GRAMMAR },
    },
  ];
  assert.equal(applyGrokApplyPatchGuidance(tools, { slug: "grok-oauth/grok-4.5" }), tools);
  const forwarded = toResponsesRequest({
    model: "grok-4.5",
    messages: [{ role: "user", content: "patch" }],
    tools: [
      {
        type: "function",
        function: {
          name: APPLY_PATCH_TOOL_NAME,
          description: "Apply a patch.",
          parameters: { type: "object", properties: { content: { type: "string" } } },
        },
      },
    ],
  });
  const applyPatch = forwarded.tools.find((tool) => tool.name === APPLY_PATCH_TOOL_NAME);
  assert.equal(applyPatch.description, "Apply a patch.");
  assert.equal(applyPatch.description.includes(GROK_APPLY_PATCH_GUIDANCE_MARKER), false);
});
