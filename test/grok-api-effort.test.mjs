import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import http from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { openPort } from "./port-pool.mjs";

// The xai-reasoning profile keeps only the rungs a model declares: grok-4.7
// publishes xhigh and must receive it, while grok-4.5 stops at high (#861).
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const root = mkdtempSync(path.join(os.tmpdir(), "codex-router-grok-api-effort-"));
const stateDir = path.join(root, "state");
const internalKey = "test-grok-api-effort-internal-key-with-length";

test.after(() => rmSync(root, { recursive: true, force: true }));

async function waitForHealth(baseUrl, child, stderr) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`forwarder exited: ${stderr()}`);
    try {
      const response = await fetch(`${baseUrl}/health`, {
        headers: { Authorization: `Bearer ${internalKey}` },
      });
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  throw new Error(`forwarder never became healthy: ${stderr()}`);
}

test("grok-api forwards xhigh only to a model that declares it", async () => {
  const captured = [];
  const upstream = http.createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => { body += chunk; });
    request.once("end", () => {
      captured.push(JSON.parse(body));
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({
        id: "chatcmpl_effort",
        object: "chat.completion",
        model: "grok",
        choices: [{ index: 0, message: { role: "assistant", content: "OK" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }));
    });
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const forwarderPort = await openPort();
  const child = spawn(process.execPath, [path.join(repoRoot, "src", "api-forwarder.mjs")], {
    cwd: repoRoot,
    env: {
      ...process.env,
      CODEX_HOME: path.join(root, "codex"),
      MODEL_ROUTER_TARGET: "codex",
      MODEL_ROUTER_INTERNAL_KEY: internalKey,
      MODEL_ROUTER_API_PORT: String(forwarderPort),
      MODEL_ROUTER_STATE_DIR: stateDir,
      CODEX_ROUTER_STATE_DIR: stateDir,
      MODEL_ROUTER_USER_MODELS: path.join(root, "user-models.json"),
      MODEL_ROUTER_PROVIDER_CREDENTIAL_STORE: path.join(stateDir, "provider-credentials.json"),
      MODEL_ROUTER_API_KEY_POOL_PATH: path.join(stateDir, "provider-api-key-pools.json"),
      MODEL_ROUTER_QUIET: "1",
      XAI_API_BASE_URL: `http://127.0.0.1:${upstream.address().port}/v1`,
      XAI_API_KEY: "TEST_XAI_KEY",
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  child.stderr.setEncoding("utf8");
  let errors = "";
  child.stderr.on("data", (chunk) => { errors += chunk; });

  try {
    const baseUrl = `http://127.0.0.1:${forwarderPort}`;
    await waitForHealth(baseUrl, child, () => errors);
    const send = async (model, effort) => {
      const response = await fetch(`${baseUrl}/v1/chat/completions`, {
        method: "POST",
        headers: { Authorization: `Bearer ${internalKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({ model, reasoning_effort: effort, messages: [{ role: "user", content: "hi" }] }),
      });
      assert.equal(response.status, 200, errors);
      await response.json();
      return captured.at(-1).reasoning_effort;
    };
    assert.equal(await send("grok-api-grok-4-7", "xhigh"), "xhigh");
    assert.equal(await send("grok-api-grok-4-7", "medium"), "medium");
    assert.equal(await send("grok-api-grok-4-7", "max"), "high");
    assert.equal(await send("grok-api-grok-4-5", "xhigh"), "high");
  } finally {
    child.kill("SIGTERM");
    if (child.exitCode === null) await new Promise((resolve) => child.once("exit", resolve));
    await new Promise((resolve) => upstream.close(resolve));
  }
});
