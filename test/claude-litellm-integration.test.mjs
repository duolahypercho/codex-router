import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const litellm = path.join(
  root,
  ".venv",
  process.platform === "win32" ? "Scripts" : "bin",
  process.platform === "win32" ? "litellm.exe" : "litellm",
);
const enabled = process.env.MODEL_ROUTER_LITELLM_INTEGRATION === "1";
const INTERNAL_KEY = "claude-e2e-internal-service-key-with-sufficient-length";
const CALLER_KEY = "claude-e2e-caller-capability-with-sufficient-length";
const PROVIDER_KEY = "claude-e2e-provider-key";

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const port = address.port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function freePorts(count) {
  const ports = new Set();
  while (ports.size < count) ports.add(await freePort());
  return [...ports];
}

async function requestJson(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function sendJson(response, status, payload) {
  const body = Buffer.from(JSON.stringify(payload), "utf8");
  response.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": String(body.length),
  });
  response.end(body);
}

function completion(message, finishReason = "stop", id = "chatcmpl-claude-e2e") {
  return {
    id,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1_000),
    model: "kimi-k3",
    choices: [{ index: 0, message, finish_reason: finishReason }],
    usage: { prompt_tokens: 12, completion_tokens: 4, total_tokens: 16 },
  };
}

async function stopProcess(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([
    new Promise((resolve) => child.once("exit", resolve)),
    new Promise((resolve) => setTimeout(resolve, 5_000)),
  ]);
  if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
}

async function waitForRouter(port, child, errors) {
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`Claude integration stack exited early: ${errors()}`);
    }
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`, {
        signal: AbortSignal.timeout(1_000),
      });
      if (response.ok) return;
    } catch {
      // LiteLLM is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`Timed out waiting for Claude integration stack: ${errors()}`);
}

test(
  "Claude Messages survives the real LiteLLM adapter with images, tools, results, and streaming",
  {
    skip: !enabled
      ? "set MODEL_ROUTER_LITELLM_INTEGRATION=1 for the pinned-adapter integration test"
      : !existsSync(litellm)
        ? "run ./install.sh --target claude --prepare-only first"
        : false,
    timeout: 90_000,
  },
  async () => {
    const [mockPort, routerPort, gatewayPort, oauthPort, apiPort] = await freePorts(5);
    const rootDir = mkdtempSync(path.join(os.tmpdir(), "claude-litellm-e2e-"));
    const stateDir = path.join(rootDir, "state");
    mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    writeFileSync(path.join(stateDir, "internal-secret"), `${INTERNAL_KEY}\n`, { mode: 0o600 });
    writeFileSync(path.join(stateDir, "caller-secret"), `${CALLER_KEY}\n`, { mode: 0o600 });
    writeFileSync(path.join(stateDir, "kimi-api-key.secret"), `${PROVIDER_KEY}\n`, {
      mode: 0o600,
    });
    writeFileSync(
      path.join(stateDir, "enabled-providers.json"),
      `${JSON.stringify({ version: 1, providers: ["kimi-api"] })}\n`,
      { mode: 0o600 },
    );

    const received = [];
    let mockFailure;
    const mock = http.createServer(async (request, response) => {
      try {
        assert.equal(request.method, "POST");
        assert.equal(request.url, "/v1/chat/completions");
        assert.equal(request.headers.authorization, `Bearer ${PROVIDER_KEY}`);
        assert.equal(request.headers["x-api-key"], undefined);
        assert.equal(request.headers["chatgpt-account-id"], undefined);
        const body = await requestJson(request);
        received.push(body);
        assert.equal(body.model, "kimi-k3");
        assert.equal(body.reasoning_effort, "max");
        const hasToolResult = body.messages.some(
          (message) => message.role === "tool" && message.tool_call_id === "call_inspect",
        );
        if (body.tools?.length && !hasToolResult) {
          const userContent = body.messages.find((message) => message.role === "user")?.content;
          assert.ok(Array.isArray(userContent));
          assert.ok(userContent.some((part) => part.type === "image_url"));
          assert.equal(body.tools[0].function.name, "inspect_image");
        }

        if (body.stream) {
          response.writeHead(200, {
            "Content-Type": "text/event-stream; charset=utf-8",
            "Cache-Control": "no-cache",
          });
          const base = {
            id: "chatcmpl-claude-stream",
            object: "chat.completion.chunk",
            created: Math.floor(Date.now() / 1_000),
            model: "kimi-k3",
          };
          const choices =
            body.tools?.length && !hasToolResult
              ? [
                  {
                    index: 0,
                    delta: {
                      role: "assistant",
                      tool_calls: [
                        {
                          index: 0,
                          id: "call_inspect",
                          type: "function",
                          function: { name: "inspect_image", arguments: "" },
                        },
                      ],
                    },
                    finish_reason: null,
                  },
                  {
                    index: 0,
                    delta: {
                      tool_calls: [
                        { index: 0, function: { arguments: '{"result":"seen"}' } },
                      ],
                    },
                    finish_reason: null,
                  },
                  { index: 0, delta: {}, finish_reason: "tool_calls" },
                ]
              : [
                  { index: 0, delta: { role: "assistant" }, finish_reason: null },
                  {
                    index: 0,
                    delta: { content: hasToolResult ? "tool result ok" : "stream ok" },
                    finish_reason: null,
                  },
                  { index: 0, delta: {}, finish_reason: "stop" },
                ];
          for (const choice of choices) {
            response.write(`data: ${JSON.stringify({ ...base, choices: [choice] })}\n\n`);
          }
          response.end("data: [DONE]\n\n");
          return;
        }

        if (hasToolResult) {
          sendJson(
            response,
            200,
            completion(
              { role: "assistant", content: "tool result ok" },
              "stop",
              "chatcmpl-claude-e2e-tool-result",
            ),
          );
          return;
        }

        sendJson(
          response,
          200,
          completion(
            {
              role: "assistant",
              content: null,
              tool_calls: [
                {
                  id: "call_inspect",
                  type: "function",
                  function: { name: "inspect_image", arguments: '{"result":"seen"}' },
                },
              ],
            },
            "tool_calls",
          ),
        );
      } catch (error) {
        mockFailure = error instanceof Error ? error : new Error(String(error));
        if (!response.headersSent) {
          sendJson(response, 400, { error: { message: "mock validation failed" } });
        } else if (!response.writableEnded) {
          response.destroy();
        }
      }
    });
    await new Promise((resolve, reject) => {
      mock.once("error", reject);
      mock.listen(mockPort, "127.0.0.1", resolve);
    });

    const stack = spawn(process.execPath, [path.join(root, "src", "start.mjs")], {
      cwd: root,
      env: {
        ...process.env,
        MODEL_ROUTER_TARGET: "claude",
        MODEL_ROUTER_STATE_DIR: stateDir,
        MODEL_ROUTER_PORT: String(routerPort),
        MODEL_ROUTER_GATEWAY_PORT: String(gatewayPort),
        MODEL_ROUTER_OAUTH_PORT: String(oauthPort),
        MODEL_ROUTER_API_PORT: String(apiPort),
        KIMI_API_BASE_URL: `http://127.0.0.1:${mockPort}/v1`,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stackOutput = "";
    stack.stdout.setEncoding("utf8");
    stack.stderr.setEncoding("utf8");
    stack.stdout.on("data", (chunk) => {
      stackOutput += chunk;
    });
    stack.stderr.on("data", (chunk) => {
      stackOutput += chunk;
    });

    try {
      await waitForRouter(routerPort, stack, () => stackOutput);
      const headers = {
        Authorization: `Bearer ${CALLER_KEY}`,
        "Content-Type": "application/json",
        "anthropic-version": "2023-06-01",
      };
      const first = await fetch(`http://127.0.0.1:${routerPort}/v1/messages`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          model: "kimi-api/kimi-k3",
          max_tokens: 64,
          messages: [
            {
              role: "user",
              content: [
                { type: "text", text: "Inspect this image." },
                {
                  type: "image",
                  source: {
                    type: "base64",
                    media_type: "image/png",
                    data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
                  },
                },
              ],
            },
          ],
          tools: [
            {
              name: "inspect_image",
              description: "Inspect an image",
              input_schema: {
                type: "object",
                properties: { result: { type: "string" } },
                required: ["result"],
              },
            },
          ],
        }),
      });
      const firstBody = await first.text();
      assert.equal(first.status, 200, firstBody);
      const toolMessage = JSON.parse(firstBody);
      assert.equal(toolMessage.type, "message");
      const toolUse = toolMessage.content.find((part) => part.type === "tool_use");
      assert.equal(toolUse.type, "tool_use");
      assert.equal(toolUse.id, "call_inspect");
      assert.equal(toolUse.name, "inspect_image");
      assert.deepEqual(toolUse.input, { result: "seen" });

      const standardToolUse = {
        type: toolUse.type,
        id: toolUse.id,
        name: toolUse.name,
        input: toolUse.input,
      };
      const toolResultRequest = {
        model: "kimi-api/kimi-k3",
        max_tokens: 64,
        messages: [
          { role: "user", content: "Use the image tool." },
          { role: "assistant", content: [standardToolUse] },
          {
            role: "user",
            content: [
              { type: "tool_result", tool_use_id: "call_inspect", content: "done" },
            ],
          },
        ],
        tools: [
          {
            name: "inspect_image",
            description: "Inspect an image",
            input_schema: { type: "object", properties: {} },
          },
        ],
      };

      const second = await fetch(`http://127.0.0.1:${routerPort}/v1/messages`, {
        method: "POST",
        headers,
        body: JSON.stringify({ ...toolResultRequest, stream: true }),
      });
      const secondBody = await second.text();
      assert.equal(second.status, 200, secondBody);
      assert.match(secondBody, /event: message_start/);
      assert.match(secondBody, /kimi-api\/kimi-k3/);
      assert.doesNotMatch(secondBody, /"model":"kimi-api-k3"/);
      assert.match(secondBody, /tool result ok/);
      assert.match(secondBody, /event: message_stop/);

      const third = await fetch(`http://127.0.0.1:${routerPort}/v1/messages`, {
        method: "POST",
        headers,
        body: JSON.stringify(toolResultRequest),
      });
      const thirdBody = await third.text();
      assert.equal(third.status, 200, thirdBody);
      const thirdMessage = JSON.parse(thirdBody);
      assert.equal(thirdMessage.model, "kimi-api/kimi-k3");
      assert.equal(thirdMessage.content[0].type, "text");
      assert.equal(thirdMessage.content[0].text, "tool result ok");

      assert.equal(received.length, 3);
      assert.ok(
        received[1].messages.some(
          (message) => message.role === "tool" && message.tool_call_id === "call_inspect",
        ),
      );
      assert.ok(
        received[2].messages.some(
          (message) => message.role === "tool" && message.tool_call_id === "call_inspect",
        ),
      );
      assert.equal(mockFailure, undefined, mockFailure?.stack);
    } finally {
      await stopProcess(stack);
      await new Promise((resolve) => mock.close(resolve));
      rmSync(rootDir, { recursive: true, force: true });
    }
  },
);
