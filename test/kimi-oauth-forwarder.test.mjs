import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { openPort } from "./port-pool.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const internalKey = "test-kimi-internal-service-key-with-sufficient-length";

async function stop(child) {
  if (child.exitCode !== null) return;
  child.kill("SIGTERM");
  await new Promise((resolve) => child.once("exit", resolve));
}

test("Kimi OAuth forwarder returns an actionable 401 when login is required", async () => {
  const home = mkdtempSync(path.join(os.tmpdir(), "kimi-oauth-forwarder-"));
  const devicePath = path.join(home, "device_id");
  writeFileSync(devicePath, "test-device-id\n", { mode: 0o600 });
  const port = await openPort();
  const child = spawn(process.execPath, [path.join(root, "src", "oauth-forwarder.mjs")], {
    cwd: root,
    env: {
      ...process.env,
      MODEL_ROUTER_TARGET: "codex",
      MODEL_ROUTER_INTERNAL_KEY: internalKey,
      MODEL_ROUTER_OAUTH_PORT: String(port),
      KIMI_CODE_HOME: home,
      KIMI_CODE_BASE_URL: "http://127.0.0.1:1/v1",
      MODEL_ROUTER_QUIET: "1",
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  child.stderr.setEncoding("utf8");
  let errors = "";
  child.stderr.on("data", (chunk) => { errors += chunk; });
  const base = `http://127.0.0.1:${port}`;
  const headers = {
    Authorization: `Bearer ${internalKey}`,
    "Content-Type": "application/json",
  };

  try {
    const deadline = Date.now() + 5_000;
    let ready = false;
    while (Date.now() < deadline) {
      if (child.exitCode !== null) throw new Error(`forwarder exited: ${errors}`);
      try {
        const health = await fetch(`${base}/health`, { headers });
        if (health.ok) {
          ready = true;
          break;
        }
      } catch {}
      await new Promise((resolve) => setTimeout(resolve, 40));
    }
    assert.equal(ready, true, errors);
    const response = await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify({ model: "k3", messages: [{ role: "user", content: "hi" }] }),
    });
    assert.equal(response.status, 401);
    const body = await response.json();
    assert.equal(body.error.type, "authentication_error");
    assert.match(body.error.message, /kimi login/);
  } finally {
    await stop(child);
    unlinkSync(devicePath);
    rmSync(home, { recursive: true, force: true });
  }
});

test("Kimi OAuth forwarder strips client_metadata and access_programs before upstream", async () => {
  const home = mkdtempSync(path.join(os.tmpdir(), "kimi-oauth-forwarder-"));
  const devicePath = path.join(home, "device_id");
  writeFileSync(devicePath, "test-device-id\n", { mode: 0o600 });
  mkdirSync(path.join(home, "credentials"), { recursive: true, mode: 0o700 });
  writeFileSync(
    path.join(home, "credentials", "kimi-code.json"),
    JSON.stringify({
      access_token: "test-oauth-access",
      refresh_token: "test-oauth-refresh",
      expires_at: Math.floor(Date.now() / 1_000) + 3_600,
      expires_in: 3_600,
      scope: "kimi-code",
      token_type: "Bearer",
    }),
    { mode: 0o600 },
  );

  const upstreamRequests = [];
  const upstream = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    upstreamRequests.push({
      headers: request.headers,
      body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
    });
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: "ok" } }] }));
  });
  await new Promise((resolve, reject) => {
    upstream.once("error", reject);
    upstream.listen(0, "127.0.0.1", resolve);
  });
  const upstreamPort = upstream.address().port;
  const port = await openPort();
  const child = spawn(process.execPath, [path.join(root, "src", "oauth-forwarder.mjs")], {
    cwd: root,
    env: {
      ...process.env,
      MODEL_ROUTER_TARGET: "codex",
      MODEL_ROUTER_INTERNAL_KEY: internalKey,
      MODEL_ROUTER_OAUTH_PORT: String(port),
      KIMI_CODE_HOME: home,
      KIMI_CODE_BASE_URL: `http://127.0.0.1:${upstreamPort}/v1`,
      MODEL_ROUTER_QUIET: "1",
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  child.stderr.setEncoding("utf8");
  let errors = "";
  child.stderr.on("data", (chunk) => { errors += chunk; });
  const base = `http://127.0.0.1:${port}`;
  const headers = {
    Authorization: `Bearer ${internalKey}`,
    "Content-Type": "application/json",
  };

  try {
    const deadline = Date.now() + 5_000;
    let ready = false;
    while (Date.now() < deadline) {
      if (child.exitCode !== null) throw new Error(`forwarder exited: ${errors}`);
      try {
        const health = await fetch(`${base}/health`, { headers });
        if (health.ok) {
          ready = true;
          break;
        }
      } catch {}
      await new Promise((resolve) => setTimeout(resolve, 40));
    }
    assert.equal(ready, true, errors);
    const messages = [{ role: "user", content: "hi" }];
    const response = await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: "k3",
        messages,
        reasoning_effort: "medium",
        client_metadata: { workspace: "caller-owned" },
        access_programs: { cyber: "standard" },
      }),
    });
    assert.equal(response.status, 200, errors);
    await response.json();
    assert.equal(upstreamRequests.length, 1);
    // The request went through normalizeKimiBody: thinking is forced on and
    // the k3 effort ladder is applied, so these assertions prove the observed
    // body is the normalized one rather than an untouched relay.
    assert.deepEqual(upstreamRequests[0].body.messages, messages);
    assert.deepEqual(upstreamRequests[0].body.thinking, { type: "enabled" });
    assert.equal(upstreamRequests[0].body.reasoning_effort, "high");
    assert.equal(upstreamRequests[0].body.client_metadata, undefined);
    assert.equal(upstreamRequests[0].body.access_programs, undefined);
    assert.equal(upstreamRequests[0].headers.authorization, "Bearer test-oauth-access");
  } finally {
    await stop(child);
    await new Promise((resolve) => upstream.close(resolve));
    rmSync(home, { recursive: true, force: true });
  }
});
