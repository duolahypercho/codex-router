import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import http from "node:http";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { openPort } from "./port-pool.mjs";

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
    assert.equal(JSON.parse(readFileSync(planPath, "utf8")).commandcode.providerApi, false);

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
