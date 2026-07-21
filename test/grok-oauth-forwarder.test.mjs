import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import http from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

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
    if (Array.isArray(captured.tools) && captured.tools.length) {
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
    // Request translation carried the tool definition through.
    assert.equal(captured.tools[0].name, "get_weather");
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
