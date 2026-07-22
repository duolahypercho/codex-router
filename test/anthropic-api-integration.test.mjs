import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { callerBaseUrl } from "../src/caller-auth.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const litellm = path.join(
  root,
  ".venv",
  process.platform === "win32" ? "Scripts" : "bin",
  process.platform === "win32" ? "litellm.exe" : "litellm",
);
const enabled = process.env.MODEL_ROUTER_LITELLM_INTEGRATION === "1";
const INTERNAL_KEY = "anthropic-e2e-internal-service-key-with-sufficient-length";
const CALLER_KEY = "anthropic-e2e-caller-capability-with-sufficient-length";
const PROVIDER_KEY = "anthropic-e2e-provider-key";

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  await new Promise((resolve) => server.close(resolve));
  return address.port;
}

async function freePorts(count) {
  const ports = new Set();
  while (ports.size < count) ports.add(await freePort());
  return [...ports];
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

async function waitForRouter(port, child, output) {
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Integration stack exited early: ${output()}`);
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
  throw new Error(`Timed out waiting for the integration stack: ${output()}`);
}

test(
  "Codex Responses reaches Anthropic Messages through the real LiteLLM adapter",
  {
    skip: !enabled
      ? "set MODEL_ROUTER_LITELLM_INTEGRATION=1 for the pinned-adapter integration test"
      : !existsSync(litellm)
        ? "run ./install.sh --target codex --prepare-only first"
        : false,
    timeout: 90_000,
  },
  async () => {
    const [mockPort, routerPort, gatewayPort, oauthPort, apiPort, grokOauthPort] =
      await freePorts(6);
    const testRoot = mkdtempSync(path.join(os.tmpdir(), "codex-anthropic-e2e-"));
    const stateDir = path.join(testRoot, "state");
    mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    writeFileSync(path.join(stateDir, "internal-secret"), `${INTERNAL_KEY}\n`, { mode: 0o600 });
    writeFileSync(path.join(stateDir, "caller-secret"), `${CALLER_KEY}\n`, { mode: 0o600 });
    writeFileSync(path.join(stateDir, "anthropic-api-key.secret"), `${PROVIDER_KEY}\n`, {
      mode: 0o600,
    });
    writeFileSync(
      path.join(stateDir, "enabled-providers.json"),
      `${JSON.stringify({ version: 1, providers: ["anthropic-api"] })}\n`,
      { mode: 0o600 },
    );

    let received;
    const mock = http.createServer(async (request, response) => {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      received = {
        method: request.method,
        url: request.url,
        headers: request.headers,
        body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
      };
      const payload = JSON.stringify({
        id: "msg_anthropic_codex_e2e",
        type: "message",
        role: "assistant",
        model: "claude-opus-4-8",
        content: [{ type: "text", text: "ANTHROPIC_CODEX_REPO_OK" }],
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: { input_tokens: 8, output_tokens: 5 },
      });
      response.writeHead(200, {
        "Content-Type": "application/json",
        "Content-Length": String(Buffer.byteLength(payload)),
      });
      response.end(payload);
    });
    await new Promise((resolve, reject) => {
      mock.once("error", reject);
      mock.listen(mockPort, "127.0.0.1", resolve);
    });

    const stack = spawn(process.execPath, [path.join(root, "src", "start.mjs")], {
      cwd: root,
      env: {
        ...process.env,
        MODEL_ROUTER_TARGET: "codex",
        MODEL_ROUTER_STATE_DIR: stateDir,
        MODEL_ROUTER_PORT: String(routerPort),
        MODEL_ROUTER_GATEWAY_PORT: String(gatewayPort),
        MODEL_ROUTER_OAUTH_PORT: String(oauthPort),
        MODEL_ROUTER_API_PORT: String(apiPort),
        MODEL_ROUTER_GROK_OAUTH_PORT: String(grokOauthPort),
        ANTHROPIC_API_BASE_URL: `http://127.0.0.1:${mockPort}/v1`,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stackOutput = "";
    stack.stdout.setEncoding("utf8");
    stack.stderr.setEncoding("utf8");
    stack.stdout.on("data", (chunk) => { stackOutput += chunk; });
    stack.stderr.on("data", (chunk) => { stackOutput += chunk; });

    try {
      await waitForRouter(routerPort, stack, () => stackOutput);
      const response = await fetch(`${callerBaseUrl(routerPort, CALLER_KEY)}/responses`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "anthropic-api/claude-opus-4.8",
          input: "Reply with the repository marker.",
          reasoning: { effort: "high", summary: "auto" },
          stream: false,
        }),
      });
      const body = await response.text();
      assert.equal(response.status, 200, `${body}\n${stackOutput}`);
      assert.match(body, /ANTHROPIC_CODEX_REPO_OK/);
      assert.equal(received.method, "POST");
      assert.equal(received.url, "/v1/messages");
      assert.equal(received.headers["x-api-key"], PROVIDER_KEY);
      assert.equal(received.headers.authorization, undefined);
      assert.equal(received.headers["anthropic-version"], "2023-06-01");
      assert.equal(received.body.model, "claude-opus-4-8");
      assert.deepEqual(received.body.thinking, { type: "adaptive" });
      assert.deepEqual(received.body.output_config, { effort: "high" });
    } finally {
      await stopProcess(stack);
      await new Promise((resolve) => mock.close(resolve));
      rmSync(testRoot, { recursive: true, force: true });
    }
  },
);
