import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import http from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  buildHostedSearchTools,
  mergeHostedSearchTools,
  resolveHostedSearchConfig,
  toResponsesRequest,
} from "../src/grok-oauth-forwarder.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const INTERNAL_KEY = "test-grok-internal-service-key-with-sufficient-length";

function sse(events) {
  return `${events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}`).join("\n\n")}\n\n`;
}

async function openPort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function mockBackend(handler) {
  const server = http.createServer(handler);
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return { server, port: server.address().port };
}

function startForwarder(port, backendPort, authPath) {
  const child = spawn(process.execPath, [path.join(root, "src", "grok-oauth-forwarder.mjs")], {
    cwd: root,
    env: {
      ...process.env,
      MODEL_ROUTER_TARGET: "cursor",
      MODEL_ROUTER_INTERNAL_KEY: INTERNAL_KEY,
      MODEL_ROUTER_GROK_OAUTH_PORT: String(port),
      GROK_CLI_CHAT_PROXY_BASE_URL: `http://127.0.0.1:${backendPort}`,
      GROK_CLI: path.join(root, "test", "fixtures", "missing-grok-cli"),
      GROK_AUTH_PATH: authPath,
      MODEL_ROUTER_QUIET: "1",
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

test("resolveHostedSearchConfig maps x/web tool parameters", () => {
  const config = resolveHostedSearchConfig(
    {
      x_search: {
        allowed_x_handles: ["elonmusk", "@xai"],
        from_date: "2026-07-01",
        enable_image_understanding: true,
      },
      web_search: {
        allowed_domains: ["x.ai", "docs.x.ai", "extra.example"],
        enable_image_search: true,
      },
    },
    { GROK_OAUTH_HOSTED_SEARCH: "1" },
  );
  assert.equal(config.enabled, true);
  assert.deepEqual(config.xSearch, {
    allowed_x_handles: ["elonmusk", "xai"],
    from_date: "2026-07-01",
    enable_image_understanding: true,
  });
  assert.deepEqual(config.webSearch, {
    allowed_domains: ["x.ai", "docs.x.ai", "extra.example"],
    enable_image_search: true,
  });
  assert.deepEqual(buildHostedSearchTools(config), [
    {
      type: "web_search",
      allowed_domains: ["x.ai", "docs.x.ai", "extra.example"],
      enable_image_search: true,
    },
    {
      type: "x_search",
      allowed_x_handles: ["elonmusk", "xai"],
      from_date: "2026-07-01",
      enable_image_understanding: true,
    },
  ]);
});

test("resolveHostedSearchConfig accepts legacy search_parameters sources", () => {
  const config = resolveHostedSearchConfig(
    {
      search_parameters: {
        mode: "on",
        from_date: "2026-06-01",
        to_date: "2026-07-01",
        sources: [
          {
            type: "x",
            included_x_handles: ["openai", "xai"],
            excluded_x_handles: ["spam"],
            post_favorite_count: 10,
          },
        ],
      },
    },
    {},
  );
  assert.equal(config.includeX, true);
  assert.equal(config.includeWeb, false);
  // allowed wins when both present.
  assert.deepEqual(config.xSearch, {
    allowed_x_handles: ["openai", "xai"],
    from_date: "2026-06-01",
    to_date: "2026-07-01",
  });
  assert.deepEqual(config.ignoredLegacyFields, ["post_favorite_count"]);
  assert.deepEqual(buildHostedSearchTools(config), [
    {
      type: "x_search",
      allowed_x_handles: ["openai", "xai"],
      from_date: "2026-06-01",
      to_date: "2026-07-01",
    },
  ]);
});

test("toResponsesRequest applies env-configured search parameters", () => {
  const request = toResponsesRequest(
    {
      model: "grok-4.5",
      messages: [{ role: "user", content: "latest from X?" }],
    },
    {
      env: {
        GROK_OAUTH_HOSTED_SEARCH: "1",
        GROK_OAUTH_X_SEARCH_ALLOWED_HANDLES: "elonmusk,xai",
        GROK_OAUTH_X_SEARCH_FROM_DATE: "2026-07-01",
        GROK_OAUTH_WEB_SEARCH_ALLOWED_DOMAINS: "x.ai",
      },
    },
  );
  const x = request.tools.find((tool) => tool.type === "x_search");
  const web = request.tools.find((tool) => tool.type === "web_search");
  assert.deepEqual(x, {
    type: "x_search",
    allowed_x_handles: ["elonmusk", "xai"],
    from_date: "2026-07-01",
  });
  assert.deepEqual(web, {
    type: "web_search",
    allowed_domains: ["x.ai"],
  });
});

test("search mode off disables hosted tools", () => {
  const request = toResponsesRequest(
    {
      model: "grok-4.5",
      messages: [{ role: "user", content: "no search" }],
      search_parameters: { mode: "off" },
    },
    { env: { GROK_OAUTH_HOSTED_SEARCH: "1" } },
  );
  assert.equal(request.tools, undefined);
});
