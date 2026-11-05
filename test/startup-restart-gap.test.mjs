import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { callerBaseUrl } from "../src/caller-auth.mjs";
import { freePort } from "./port-pool.mjs";

// A service restart used to leave the router port closed until LiteLLM finished
// its cold start, because start.mjs spawned the router only after the gateway
// was healthy. Codex's own retries ran out inside that window and reported
// `stream disconnected before completion: Connection refused (os error 61)`.
// These cases drive the real start.mjs against a stand-in gateway whose cold
// start is held open for as long as each case needs.

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CALLER_KEY = "restart-gap-caller-key-with-sufficient-length";
const INTERNAL_KEY = "restart-gap-internal-key-with-sufficient-length";
const ROUTED_MARKER = "ROUTED_THROUGH_STAND_IN_GATEWAY";
const NATIVE_MARKER = "NATIVE_WHILE_GATEWAY_COLD";
const READY_LINE = /\[codex-router\] ready \(authenticated loopback endpoint\)/;

// The cold start ends when the test creates this file, so no case races a timer.
function writeFakeGateway(rootDir, releaseFile) {
  const script = path.join(rootDir, "fake-gateway.mjs");
  writeFileSync(
    script,
    `import { existsSync } from "node:fs";
import { createServer } from "node:http";
const args = process.argv.slice(2);
const port = Number(args[args.indexOf("--port") + 1]);
const release = ${JSON.stringify(releaseFile)};
const server = createServer((request, response) => {
  if ((request.url || "").startsWith("/quit")) {
    response.writeHead(200).end("stopping");
    setTimeout(() => process.exit(0), 10);
    return;
  }
  if (request.method === "POST") {
    request.resume();
    request.on("end", () => {
      const body = JSON.stringify({
        id: "resp_restart_gap",
        object: "response",
        status: "completed",
        model: "stand-in",
        output: [{
          id: "msg_restart_gap",
          type: "message",
          role: "assistant",
          status: "completed",
          content: [{ type: "output_text", text: ${JSON.stringify(ROUTED_MARKER)}, annotations: [] }],
        }],
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
      });
      response.writeHead(200, { "content-type": "application/json" }).end(body);
    });
    return;
  }
  response.writeHead(200, { "content-type": "application/json" }).end('{"status":"healthy"}');
});
const poll = setInterval(() => {
  if (!existsSync(release)) return;
  clearInterval(poll);
  server.listen(port, "127.0.0.1");
}, 25);
`,
    { mode: 0o600 },
  );
  if (process.platform === "win32") {
    const target = path.join(rootDir, "fake-litellm.cmd");
    writeFileSync(target, `@echo off\r\n"${process.execPath}" "${script}" %*\r\n`);
    return target;
  }
  const target = path.join(rootDir, "fake-litellm");
  writeFileSync(target, `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`, { mode: 0o700 });
  return target;
}

async function startStack({ routerPort: fixedRouterPort } = {}) {
  const [routerPort, gatewayPort, oauthPort, apiPort, grokOauthPort, nativePort] = await Promise.all([
    fixedRouterPort ?? freePort(),
    freePort(),
    freePort(),
    freePort(),
    freePort(),
    freePort(),
  ]);
  const rootDir = mkdtempSync(path.join(os.tmpdir(), "model-router-restart-gap-"));
  const stateDir = path.join(rootDir, "state");
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  writeFileSync(path.join(stateDir, "internal-secret"), `${INTERNAL_KEY}\n`, { mode: 0o600 });
  writeFileSync(path.join(stateDir, "caller-secret"), `${CALLER_KEY}\n`, { mode: 0o600 });
  writeFileSync(path.join(stateDir, "anthropic-api-key.secret"), "restart-gap-provider-key\n", { mode: 0o600 });
  writeFileSync(
    path.join(stateDir, "enabled-providers.json"),
    `${JSON.stringify({ version: 1, providers: ["anthropic-api"] })}\n`,
    { mode: 0o600 },
  );
  const releaseFile = path.join(rootDir, "gateway-may-listen");

  const native = http.createServer((request, response) => {
    request.resume();
    request.on("end", () => {
      response.writeHead(200, { "content-type": "application/json" }).end(
        JSON.stringify({ id: "resp_native", object: "response", status: "completed", marker: NATIVE_MARKER }),
      );
    });
  });
  await new Promise((resolve, reject) => {
    native.once("error", reject);
    native.listen(nativePort, "127.0.0.1", resolve);
  });

  const child = spawn(process.execPath, [path.join(root, "src", "start.mjs")], {
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
      MODEL_ROUTER_LITELLM_BIN: writeFakeGateway(rootDir, releaseFile),
      CODEX_NATIVE_BASE_URL: `http://127.0.0.1:${nativePort}`,
      CODEX_ROUTER_NATIVE_RETRIES: "0",
      CODEX_ROUTER_HOME: rootDir,
      CODEX_HOME: rootDir,
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  const stack = { child, errors: "", exited: undefined, routerPort, gatewayPort, releaseFile };
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    stack.errors += chunk;
  });
  child.once("exit", (code, signal) => {
    stack.exited = { code, signal };
  });
  stack.releaseGateway = () => writeFileSync(releaseFile, "go\n");
  stack.stop = async () => {
    if (!stack.exited) child.kill("SIGTERM");
    const deadline = Date.now() + 15_000;
    while (!stack.exited && Date.now() < deadline) await delay(50);
    if (!stack.exited) child.kill("SIGKILL");
    // On Windows the service holds the cmd.exe hop rather than the stand-in.
    await fetch(`http://127.0.0.1:${gatewayPort}/quit`, { signal: AbortSignal.timeout(1_000) }).catch(() => {});
    await new Promise((resolve) => native.close(resolve));
    await delay(100);
    rmSync(rootDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  };
  return stack;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function until(stack, describe, probe, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (stack.exited) {
      throw new Error(`service exited (${JSON.stringify(stack.exited)}) before ${describe}:\n${stack.errors}`);
    }
    const value = await probe();
    if (value) return value;
    await delay(50);
  }
  throw new Error(`never saw ${describe} in ${timeoutMs} ms:\n${stack.errors}`);
}

async function routerHealth(port) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(3_000) });
    return { status: response.status, body: await response.json() };
  } catch {
    return undefined;
  }
}

function postResponses(port, model) {
  return fetch(`${callerBaseUrl(port, CALLER_KEY)}/responses`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer restart-gap-chatgpt-session",
      "ChatGPT-Account-ID": "restart-gap-account",
    },
    body: JSON.stringify({ model, input: "ping", stream: false }),
    signal: AbortSignal.timeout(90_000),
  });
}

test("the router serves native turns during a gateway cold start and holds routed ones", { timeout: 180_000 }, async () => {
  const stack = await startStack();
  try {
    // The defect itself: this port used to stay closed until the gateway was up.
    const cold = await until(stack, "the router port opening", () => routerHealth(stack.routerPort));
    assert.equal(cold.status, 503);
    assert.equal(cold.body.service, "codex-router");
    assert.ok(cold.body.degraded.includes("gateway"), JSON.stringify(cold.body));
    assert.doesNotMatch(stack.errors, READY_LINE);

    // Native GPT never needed the gateway, so its cold start must not delay it.
    const nativeResponse = await postResponses(stack.routerPort, "gpt-restart-gap-native");
    const nativeBody = await nativeResponse.text();
    assert.equal(nativeResponse.status, 200, `${nativeBody}\n${stack.errors}`);
    assert.match(nativeBody, new RegExp(NATIVE_MARKER));
    assert.doesNotMatch(stack.errors, READY_LINE);

    // A routed turn has nowhere to go yet, so it waits instead of failing.
    let routedSettled = false;
    const routed = postResponses(stack.routerPort, "anthropic-api/claude-opus-4.8").finally(() => {
      routedSettled = true;
    });
    await delay(1_500);
    assert.equal(routedSettled, false, `the routed turn did not wait:\n${stack.errors}`);

    stack.releaseGateway();
    const routedResponse = await routed;
    const routedBody = await routedResponse.text();
    assert.equal(routedResponse.status, 200, `${routedBody}\n${stack.errors}`);
    assert.match(routedBody, new RegExp(ROUTED_MARKER));
    assert.match(stack.errors, /held a routed request for \d+ ms until .*gateway.* started/);

    await until(stack, "startup finishing", () => READY_LINE.test(stack.errors));
    assert.equal((await routerHealth(stack.routerPort))?.status, 200, stack.errors);
    assert.doesNotMatch(stack.errors, new RegExp(CALLER_KEY));
    assert.doesNotMatch(stack.errors, new RegExp(INTERNAL_KEY));
  } finally {
    await stack.stop();
  }
});

test("a router that cannot bind fails startup at once instead of waiting out the gateway", { timeout: 120_000 }, async () => {
  const routerPort = await freePort();
  const squatter = net.createServer();
  await new Promise((resolve, reject) => {
    squatter.once("error", reject);
    squatter.listen(routerPort, "127.0.0.1", resolve);
  });
  // The gateway is never released, so only the router's exit can end startup
  // inside this budget; the gateway's own allowance is five minutes.
  const stack = await startStack({ routerPort });
  try {
    const deadline = Date.now() + 60_000;
    while (!stack.exited && Date.now() < deadline) await delay(50);
    assert.ok(stack.exited, `startup kept waiting on the gateway:\n${stack.errors}`);
    assert.equal(stack.exited.code, 1, stack.errors);
    assert.match(stack.errors, /cannot listen: 127\.0\.0\.1:\d+ is already in use/);
    assert.match(stack.errors, /startup failed: Codex router exited before becoming healthy\./);
  } finally {
    await stack.stop();
    await new Promise((resolve) => squatter.close(resolve));
  }
});
