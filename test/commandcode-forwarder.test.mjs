import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import http from "node:http";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { openPort } from "./port-pool.mjs";
import { commandCodeCredentialVerifier, ROUTE_RECHECK_MS } from "../src/commandcode-plan.mjs";
import { upsertProviderApiKey } from "../src/provider-api-key-pool.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const internalKey = "test-commandcode-internal-service-key-with-length";

const TURN = [
  { type: "start" },
  { type: "text-start", id: "t" },
  { type: "text-delta", id: "t", text: "OK" },
  { type: "text-end", id: "t" },
  { type: "finish-step", finishReason: "stop", usage: { inputTokens: 5, outputTokens: 1, totalTokens: 6 } },
];

// Stands in for api.commandcode.ai: the documented API refuses a Go-plan
// account exactly the way the live gateway does, and the CLI's own route
// answers the same turn.
function mockCommandCode() {
  const calls = { providerApi: 0, generate: 0, generateBodies: [] };
  const server = http.createServer((request, response) => {
    let raw = "";
    request.on("data", (chunk) => {
      raw += chunk;
    });
    request.on("end", () => {
      if (request.url.startsWith("/provider/v1/")) {
        calls.providerApi += 1;
        const body = JSON.stringify({
          error: {
            message:
              "Your Go plan doesn't include API access. Upgrade to Provider or higher at https://commandcode.ai/billing to use these endpoints.",
            type: "permission_error",
            code: "upgrade_required",
          },
        });
        response.writeHead(403, { "Content-Type": "application/json" });
        response.end(body);
        return;
      }
      if (request.url === "/alpha/generate") {
        calls.generate += 1;
        calls.generateBodies.push(JSON.parse(raw));
        response.writeHead(200, {
          "Content-Type": "text/event-stream",
          "x-ratelimit-limit-requests": "100",
          "x-ratelimit-remaining-requests": "97",
        });
        for (const event of TURN) response.write(`${JSON.stringify(event)}\n`);
        response.end();
        return;
      }
      response.writeHead(404).end("{}");
    });
  });
  return { server, calls };
}

async function listen(server, port) {
  await new Promise((resolve) => server.listen(port, "127.0.0.1", resolve));
}

async function waitForHealth(base, headers, child, errors) {
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`forwarder exited: ${errors()}`);
    try {
      const health = await fetch(`${base}/health`, { headers });
      if (health.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  throw new Error(`forwarder never became healthy: ${errors()}`);
}

async function waitForFile(target, child, errors) {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    if (existsSync(target)) return;
    if (child.exitCode !== null) throw new Error(`forwarder exited: ${errors()}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`forwarder did not persist ${path.basename(target)}: ${errors()}`);
}

test("a plan-refused Command Code account is served through the CLI route", async () => {
  const stateDir = mkdtempSync(path.join(os.tmpdir(), "commandcode-forwarder-state-"));
  const cliHome = mkdtempSync(path.join(os.tmpdir(), "commandcode-forwarder-home-"));
  const upstreamPort = await openPort();
  const forwarderPort = await openPort();
  const { server, calls } = mockCommandCode();
  await listen(server, upstreamPort);

  const child = spawn(process.execPath, [path.join(root, "src", "api-forwarder.mjs")], {
    cwd: root,
    env: {
      ...process.env,
      MODEL_ROUTER_TARGET: "codex",
      MODEL_ROUTER_INTERNAL_KEY: internalKey,
      MODEL_ROUTER_API_PORT: String(forwarderPort),
      MODEL_ROUTER_STATE_DIR: stateDir,
      MODEL_ROUTER_QUIET: "1",
      COMMANDCODE_BASE_URL: `http://127.0.0.1:${upstreamPort}/provider/v1`,
      COMMAND_CODE_API_KEY: "user_test_key",
      COMMANDCODE_CLI_HOME: cliHome,
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  child.stderr.setEncoding("utf8");
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });

  const base = `http://127.0.0.1:${forwarderPort}`;
  const headers = { Authorization: `Bearer ${internalKey}`, "Content-Type": "application/json" };
  try {
    await waitForHealth(base, headers, child, () => stderr);

    const turn = () =>
      fetch(`${base}/v1/chat/completions`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          model: "commandcode-deepseek-v4-flash",
          stream: true,
          messages: [{ role: "user", content: "hi" }],
        }),
      });

    const first = await turn();
    assert.equal(first.status, 200);
    const firstBody = await first.text();
    assert.match(firstBody, /"content":"OK"/);
    assert.ok(firstBody.endsWith("data: [DONE]\n\n"));
    assert.equal(calls.providerApi, 1);
    assert.equal(calls.generate, 1);
    // The envelope that left carries the upstream model id and the schema-strict
    // config the route validates.
    assert.equal(calls.generateBodies[0].params.model, "deepseek/deepseek-v4-flash");
    assert.equal(calls.generateBodies[0].memory, "");
    assert.equal(calls.generateBodies[0].config.environment, "production");

    // The refusal was written down, so the second turn never buys it again.
    const planPath = path.join(stateDir, "commandcode-plan.json");
    assert.ok(existsSync(planPath));
    const remembered = JSON.parse(readFileSync(planPath, "utf8")).commandcode.credentials;
    assert.equal(Object.values(remembered)[0].providerApi, false);

    const second = await turn();
    assert.equal(second.status, 200);
    assert.match(await second.text(), /"content":"OK"/);
    assert.equal(calls.providerApi, 1, "the documented API must not be asked twice");
    assert.equal(calls.generate, 2);

    // The plan route meters the same subscription, so its quota headers are
    // harvested the same way a forwarded provider's are.
    const limits = JSON.parse(readFileSync(path.join(stateDir, "rate-limits.json"), "utf8"));
    assert.equal(limits.commandcode.requests.remaining, 97);
    assert.equal(limits.commandcode.requests.limit, 100);
  } finally {
    if (child.exitCode === null) {
      child.kill("SIGTERM");
      await new Promise((resolve) => child.once("exit", resolve));
    }
    await new Promise((resolve) => server.close(resolve));
    rmSync(stateDir, { recursive: true, force: true });
    rmSync(cliHome, { recursive: true, force: true });
  }
});

test("a 403 that is not the plan refusal is relayed, not routed around", async () => {
  const stateDir = mkdtempSync(path.join(os.tmpdir(), "commandcode-forwarder-state-"));
  const cliHome = mkdtempSync(path.join(os.tmpdir(), "commandcode-forwarder-home-"));
  const upstreamPort = await openPort();
  const forwarderPort = await openPort();
  let generateCalls = 0;
  const server = http.createServer((request, response) => {
    request.resume();
    request.on("end", () => {
      if (request.url === "/alpha/generate") generateCalls += 1;
      response.writeHead(403, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ error: { message: "Region not supported", type: "permission_error" } }));
    });
  });
  await listen(server, upstreamPort);

  const child = spawn(process.execPath, [path.join(root, "src", "api-forwarder.mjs")], {
    cwd: root,
    env: {
      ...process.env,
      MODEL_ROUTER_TARGET: "codex",
      MODEL_ROUTER_INTERNAL_KEY: internalKey,
      MODEL_ROUTER_API_PORT: String(forwarderPort),
      MODEL_ROUTER_STATE_DIR: stateDir,
      MODEL_ROUTER_QUIET: "1",
      COMMANDCODE_BASE_URL: `http://127.0.0.1:${upstreamPort}/provider/v1`,
      COMMAND_CODE_API_KEY: "user_test_key",
      COMMANDCODE_CLI_HOME: cliHome,
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  child.stderr.setEncoding("utf8");
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });

  const base = `http://127.0.0.1:${forwarderPort}`;
  const headers = { Authorization: `Bearer ${internalKey}`, "Content-Type": "application/json" };
  try {
    await waitForHealth(base, headers, child, () => stderr);
    const response = await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: "commandcode-deepseek-v4-flash",
        messages: [{ role: "user", content: "hi" }],
      }),
    });
    assert.equal(response.status, 403);
    assert.match((await response.json()).error.message, /Region not supported/);
    assert.equal(generateCalls, 0);
    // Nothing was learned about the plan, so nothing was written down.
    assert.equal(existsSync(path.join(stateDir, "commandcode-plan.json")), false);
  } finally {
    if (child.exitCode === null) {
      child.kill("SIGTERM");
      await new Promise((resolve) => child.once("exit", resolve));
    }
    await new Promise((resolve) => server.close(resolve));
    rmSync(stateDir, { recursive: true, force: true });
    rmSync(cliHome, { recursive: true, force: true });
  }
});

test("pooled Command Code failover uses the winning key for its plan route", async () => {
  const stateDir = mkdtempSync(path.join(os.tmpdir(), "commandcode-forwarder-pool-state-"));
  const cliHome = mkdtempSync(path.join(os.tmpdir(), "commandcode-forwarder-pool-home-"));
  const credentialStorePath = path.join(stateDir, "provider-credentials.json");
  const poolStatePath = path.join(stateDir, "provider-api-key-pools.json");
  const routerPort = await openPort();
  for (const name of ["COMMAND_CODE_API_KEY", "COMMANDCODE_API_KEY"]) {
    execFileSync(process.execPath, [
      path.join(root, "src", "control.mjs"),
      "key-pool",
      "commandcode",
      "add-env",
      name,
    ], {
      cwd: root,
      env: {
        ...process.env,
        MODEL_ROUTER_TARGET: "codex",
        MODEL_ROUTER_STATE_DIR: stateDir,
        MODEL_ROUTER_PROVIDER_CREDENTIAL_STORE: credentialStorePath,
        MODEL_ROUTER_API_KEY_POOL_PATH: poolStatePath,
        CODEX_ROUTER_PORT: String(routerPort),
        CODEX_ROUTER_SERVICE_PLATFORM: "darwin",
        MODEL_ROUTER_LAUNCH_AGENTS_DIR: path.join(stateDir, "launch-agents"),
      },
      stdio: "ignore",
    });
  }
  const upstreamPort = await openPort();
  const forwarderPort = await openPort();
  const calls = [];
  let providerCalls = 0;
  const server = http.createServer((request, response) => {
    const authorization = request.headers.authorization;
    calls.push({ url: request.url, authorization });
    request.resume();
    request.on("end", () => {
      if (request.url.startsWith("/provider/v1/") && providerCalls++ === 0) {
        response.writeHead(429, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ error: { message: "rate limited" } }));
        return;
      }
      if (request.url.startsWith("/provider/v1/")) {
        response.writeHead(403, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ error: { code: "upgrade_required", message: "Upgrade to API access" } }));
        return;
      }
      if (request.url === "/alpha/generate") {
        response.writeHead(200, {
          "Content-Type": "text/event-stream",
          "x-ratelimit-limit-requests": "100",
          "x-ratelimit-remaining-requests": "88",
        });
        for (const event of TURN) response.write(`${JSON.stringify(event)}\n`);
        response.end();
        return;
      }
      response.writeHead(404).end("{}");
    });
  });
  await listen(server, upstreamPort);
  const child = spawn(process.execPath, [path.join(root, "src", "api-forwarder.mjs")], {
    cwd: root,
    env: {
      ...process.env,
      MODEL_ROUTER_TARGET: "codex",
      MODEL_ROUTER_INTERNAL_KEY: internalKey,
      MODEL_ROUTER_API_PORT: String(forwarderPort),
      MODEL_ROUTER_STATE_DIR: stateDir,
      MODEL_ROUTER_PROVIDER_CREDENTIAL_STORE: credentialStorePath,
      MODEL_ROUTER_API_KEY_POOL_PATH: poolStatePath,
      MODEL_ROUTER_QUIET: "1",
      COMMANDCODE_BASE_URL: `http://127.0.0.1:${upstreamPort}/provider/v1`,
      COMMAND_CODE_API_KEY: "POOL_A",
      COMMANDCODE_API_KEY: "POOL_B",
      COMMANDCODE_CLI_HOME: cliHome,
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  child.stderr.setEncoding("utf8");
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const base = `http://127.0.0.1:${forwarderPort}`;
  const headers = { Authorization: `Bearer ${internalKey}`, "Content-Type": "application/json" };
  try {
    await waitForHealth(base, headers, child, () => stderr);
    const response = await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: "commandcode-deepseek-v4-flash",
        stream: true,
        messages: [{ role: "user", content: "hi" }],
      }),
    });
    assert.equal(response.status, 200);
    assert.match(await response.text(), /"content":"OK"/);
    assert.equal(calls.length, 3);
    assert.notEqual(calls[0].authorization, calls[1].authorization);
    assert.equal(calls[2].authorization, calls[1].authorization);
    assert.equal(calls[2].url, "/alpha/generate");
    const plan = JSON.parse(readFileSync(path.join(stateDir, "commandcode-plan.json"), "utf8"));
    const winningFingerprint = commandCodeCredentialVerifier(
      calls[1].authorization.replace(/^Bearer /, ""),
      { salt: plan.commandcode.credentialDerivation.salt },
    ).verifier;
    assert.equal(
      plan.commandcode.credentials[winningFingerprint].providerApi,
      false,
      "the winning credential keeps its independently derived route",
    );
    const limitsPath = path.join(stateDir, "rate-limits.json");
    await waitForFile(limitsPath, child, () => stderr);
    const limits = JSON.parse(readFileSync(limitsPath, "utf8"));
    assert.equal(limits.commandcode.requests.remaining, 88);
    assert.equal(limits.commandcode.requests.limit, 100);
  } finally {
    if (child.exitCode === null) {
      child.kill("SIGTERM");
      await new Promise((resolve) => child.once("exit", resolve));
    }
    await new Promise((resolve) => server.close(resolve));
    rmSync(stateDir, { recursive: true, force: true });
    rmSync(cliHome, { recursive: true, force: true });
  }
});

test("an intermediate pooled plan limit stays per-key until the winning response", async () => {
  const stateDir = mkdtempSync(path.join(os.tmpdir(), "commandcode-forwarder-plan-rotate-state-"));
  const cliHome = mkdtempSync(path.join(os.tmpdir(), "commandcode-forwarder-plan-rotate-home-"));
  const credentialStorePath = path.join(stateDir, "provider-credentials.json");
  const poolStatePath = path.join(stateDir, "provider-api-key-pools.json");
  const routerPort = await openPort();
  for (const name of ["COMMAND_CODE_API_KEY", "COMMANDCODE_API_KEY"]) {
    execFileSync(process.execPath, [
      path.join(root, "src", "control.mjs"),
      "key-pool",
      "commandcode",
      "add-env",
      name,
    ], {
      cwd: root,
      env: {
        ...process.env,
        MODEL_ROUTER_TARGET: "codex",
        MODEL_ROUTER_STATE_DIR: stateDir,
        MODEL_ROUTER_PROVIDER_CREDENTIAL_STORE: credentialStorePath,
        MODEL_ROUTER_API_KEY_POOL_PATH: poolStatePath,
        CODEX_ROUTER_PORT: String(routerPort),
        CODEX_ROUTER_SERVICE_PLATFORM: "darwin",
        MODEL_ROUTER_LAUNCH_AGENTS_DIR: path.join(stateDir, "launch-agents"),
      },
      stdio: "ignore",
    });
  }
  const references = JSON.parse(readFileSync(credentialStorePath, "utf8")).credentials;
  const firstId = references.find((entry) => entry.secretRef.name === "COMMAND_CODE_API_KEY").id;
  const secondId = references.find((entry) => entry.secretRef.name === "COMMANDCODE_API_KEY").id;
  await upsertProviderApiKey("commandcode", { id: firstId, priority: 2 }, { filePath: poolStatePath });
  await upsertProviderApiKey("commandcode", { id: secondId, priority: 1 }, { filePath: poolStatePath });
  const firstVerifier = commandCodeCredentialVerifier("PLAN_A", { salt: Buffer.alloc(16, 1) });
  writeFileSync(path.join(stateDir, "commandcode-plan.json"), `${JSON.stringify({
    commandcode: {
      credentialDerivation: { version: firstVerifier.version, salt: firstVerifier.salt },
      credentials: {
        [firstVerifier.verifier]: {
          providerApi: false,
          observedAt: new Date().toISOString(),
        },
      },
    },
  }, null, 2)}\n`, { mode: 0o600 });

  const upstreamPort = await openPort();
  const forwarderPort = await openPort();
  const calls = [];
  let releaseWinner;
  const winnerReleased = new Promise((resolve) => { releaseWinner = resolve; });
  let markWinnerSeen;
  const winnerSeen = new Promise((resolve) => { markWinnerSeen = resolve; });
  const server = http.createServer((request, response) => {
    const authorization = request.headers.authorization;
    calls.push({ url: request.url, authorization });
    request.resume();
    request.on("end", async () => {
      if (request.url === "/alpha/generate" && authorization === "Bearer PLAN_A") {
        response.writeHead(429, {
          "Content-Type": "application/json",
          "Retry-After": "300",
          "x-ratelimit-limit-requests": "100",
          "x-ratelimit-remaining-requests": "0",
          "x-ratelimit-reset-requests": "300",
        });
        response.end(JSON.stringify({ message: "plan key rate limited" }));
        return;
      }
      if (request.url.startsWith("/provider/v1/") && authorization === "Bearer PROVIDER_B") {
        markWinnerSeen();
        await winnerReleased;
        response.writeHead(200, {
          "Content-Type": "application/json",
          "x-ratelimit-limit-requests": "100",
          "x-ratelimit-remaining-requests": "77",
          "x-ratelimit-reset-requests": "300",
        });
        response.end(JSON.stringify({
          id: "chatcmpl_plan_rotate",
          object: "chat.completion",
          model: "deepseek/deepseek-v4-flash",
          choices: [{ index: 0, message: { role: "assistant", content: "KEY_B" }, finish_reason: "stop" }],
        }));
        return;
      }
      response.writeHead(500, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ error: { message: "unexpected route" } }));
    });
  });
  await listen(server, upstreamPort);
  const child = spawn(process.execPath, [path.join(root, "src", "api-forwarder.mjs")], {
    cwd: root,
    env: {
      ...process.env,
      MODEL_ROUTER_TARGET: "codex",
      MODEL_ROUTER_INTERNAL_KEY: internalKey,
      MODEL_ROUTER_API_PORT: String(forwarderPort),
      MODEL_ROUTER_STATE_DIR: stateDir,
      MODEL_ROUTER_PROVIDER_CREDENTIAL_STORE: credentialStorePath,
      MODEL_ROUTER_API_KEY_POOL_PATH: poolStatePath,
      MODEL_ROUTER_QUIET: "1",
      COMMANDCODE_BASE_URL: `http://127.0.0.1:${upstreamPort}/provider/v1`,
      COMMAND_CODE_API_KEY: "PLAN_A",
      COMMANDCODE_API_KEY: "PROVIDER_B",
      COMMANDCODE_CLI_HOME: cliHome,
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  child.stderr.setEncoding("utf8");
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const base = `http://127.0.0.1:${forwarderPort}`;
  const headers = { Authorization: `Bearer ${internalKey}`, "Content-Type": "application/json" };
  try {
    await waitForHealth(base, headers, child, () => stderr);
    const responsePending = fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: "commandcode-deepseek-v4-flash",
        messages: [{ role: "user", content: "hi" }],
      }),
    });
    await winnerSeen;
    assert.equal(
      existsSync(path.join(stateDir, "rate-limits.json")),
      false,
      "an intermediate key's limit must not become provider-wide telemetry",
    );
    assert.equal(
      existsSync(path.join(stateDir, "provider-cooldowns.json")),
      false,
      "an intermediate key's reset must not cool every key in the provider",
    );
    releaseWinner();
    const response = await responsePending;
    assert.equal(response.status, 200);
    assert.equal((await response.json()).choices[0].message.content, "KEY_B");
    assert.deepEqual(calls, [
      { url: "/alpha/generate", authorization: "Bearer PLAN_A" },
      { url: "/provider/v1/chat/completions", authorization: "Bearer PROVIDER_B" },
    ]);
    const limitsPath = path.join(stateDir, "rate-limits.json");
    await waitForFile(limitsPath, child, () => stderr);
    const limits = JSON.parse(readFileSync(limitsPath, "utf8"));
    assert.equal(limits.commandcode.requests.remaining, 77);
    assert.equal(limits.commandcode.requests.limit, 100);
    assert.equal(existsSync(path.join(stateDir, "provider-cooldowns.json")), false);
  } finally {
    releaseWinner();
    if (child.exitCode === null) {
      child.kill("SIGTERM");
      await new Promise((resolve) => child.once("exit", resolve));
    }
    await new Promise((resolve) => server.close(resolve));
    rmSync(stateDir, { recursive: true, force: true });
    rmSync(cliHome, { recursive: true, force: true });
  }
});

test("pooled Command Code recheck success is cached against the exact winning key", async () => {
  const stateDir = mkdtempSync(path.join(os.tmpdir(), "commandcode-forwarder-recheck-state-"));
  const cliHome = mkdtempSync(path.join(os.tmpdir(), "commandcode-forwarder-recheck-home-"));
  const credentialStorePath = path.join(stateDir, "provider-credentials.json");
  const poolStatePath = path.join(stateDir, "provider-api-key-pools.json");
  const routerPort = await openPort();
  for (const name of ["COMMAND_CODE_API_KEY", "COMMANDCODE_API_KEY"]) {
    execFileSync(process.execPath, [
      path.join(root, "src", "control.mjs"),
      "key-pool",
      "commandcode",
      "add-env",
      name,
    ], {
      cwd: root,
      env: {
        ...process.env,
        MODEL_ROUTER_TARGET: "codex",
        MODEL_ROUTER_STATE_DIR: stateDir,
        MODEL_ROUTER_PROVIDER_CREDENTIAL_STORE: credentialStorePath,
        MODEL_ROUTER_API_KEY_POOL_PATH: poolStatePath,
        CODEX_ROUTER_PORT: String(routerPort),
        CODEX_ROUTER_SERVICE_PLATFORM: "darwin",
        MODEL_ROUTER_LAUNCH_AGENTS_DIR: path.join(stateDir, "launch-agents"),
      },
      stdio: "ignore",
    });
  }
  const references = JSON.parse(readFileSync(credentialStorePath, "utf8")).credentials;
  const firstId = references.find((entry) => entry.secretRef.name === "COMMAND_CODE_API_KEY").id;
  const secondId = references.find((entry) => entry.secretRef.name === "COMMANDCODE_API_KEY").id;
  await upsertProviderApiKey("commandcode", { id: firstId, priority: 2 }, { filePath: poolStatePath });
  await upsertProviderApiKey("commandcode", { id: secondId, priority: 1 }, { filePath: poolStatePath });
  const planPath = path.join(stateDir, "commandcode-plan.json");
  const poolBVerifier = commandCodeCredentialVerifier("POOL_B", { salt: Buffer.alloc(16, 2) });
  writeFileSync(planPath, `${JSON.stringify({
    commandcode: {
      credentialDerivation: { version: poolBVerifier.version, salt: poolBVerifier.salt },
      credentials: {
        [poolBVerifier.verifier]: {
          providerApi: false,
          observedAt: new Date(Date.now() - ROUTE_RECHECK_MS - 1_000).toISOString(),
        },
      },
    },
  }, null, 2)}\n`, { mode: 0o600 });

  const upstreamPort = await openPort();
  const forwarderPort = await openPort();
  const authorizations = [];
  const server = http.createServer((request, response) => {
    const authorization = request.headers.authorization;
    authorizations.push(authorization);
    request.resume();
    request.on("end", () => {
      if (authorization === "Bearer POOL_A") {
        response.writeHead(429, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ error: { message: "rate limited" } }));
        return;
      }
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({
        id: "chatcmpl_commandcode_pool_recheck",
        object: "chat.completion",
        model: "deepseek/deepseek-v4-flash",
        choices: [{ index: 0, message: { role: "assistant", content: "WINNER_B" }, finish_reason: "stop" }],
      }));
    });
  });
  await listen(server, upstreamPort);
  const child = spawn(process.execPath, [path.join(root, "src", "api-forwarder.mjs")], {
    cwd: root,
    env: {
      ...process.env,
      MODEL_ROUTER_TARGET: "codex",
      MODEL_ROUTER_INTERNAL_KEY: internalKey,
      MODEL_ROUTER_API_PORT: String(forwarderPort),
      MODEL_ROUTER_STATE_DIR: stateDir,
      MODEL_ROUTER_PROVIDER_CREDENTIAL_STORE: credentialStorePath,
      MODEL_ROUTER_API_KEY_POOL_PATH: poolStatePath,
      MODEL_ROUTER_QUIET: "1",
      COMMANDCODE_BASE_URL: `http://127.0.0.1:${upstreamPort}/provider/v1`,
      COMMAND_CODE_API_KEY: "POOL_A",
      COMMANDCODE_API_KEY: "POOL_B",
      COMMANDCODE_CLI_HOME: cliHome,
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  child.stderr.setEncoding("utf8");
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const base = `http://127.0.0.1:${forwarderPort}`;
  const headers = { Authorization: `Bearer ${internalKey}`, "Content-Type": "application/json" };
  try {
    await waitForHealth(base, headers, child, () => stderr);
    const response = await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: "commandcode-deepseek-v4-flash",
        messages: [{ role: "user", content: "hi" }],
      }),
    });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).choices[0].message.content, "WINNER_B");
    assert.deepEqual(authorizations, ["Bearer POOL_A", "Bearer POOL_B"]);
    const plan = JSON.parse(readFileSync(planPath, "utf8"));
    const winnerFingerprint = commandCodeCredentialVerifier("POOL_B", {
      salt: plan.commandcode.credentialDerivation.salt,
    }).verifier;
    assert.equal(plan.commandcode.credentials[winnerFingerprint].providerApi, true);
    const losingFingerprint = commandCodeCredentialVerifier("POOL_A", {
      salt: plan.commandcode.credentialDerivation.salt,
    }).verifier;
    assert.equal(plan.commandcode.credentials[losingFingerprint], undefined);
  } finally {
    if (child.exitCode === null) {
      child.kill("SIGTERM");
      await new Promise((resolve) => child.once("exit", resolve));
    }
    await new Promise((resolve) => server.close(resolve));
    rmSync(stateDir, { recursive: true, force: true });
    rmSync(cliHome, { recursive: true, force: true });
  }
});
