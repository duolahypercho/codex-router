import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import http from "node:http";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { callerBaseUrl } from "../src/caller-auth.mjs";
import { openPort } from "./port-pool.mjs";

// Router-level guarantees for cache-affinity session headers:
// the Claude surface's ingress tag never leaves the machine, routed providers
// never receive session headers, and a native Codex turn is relayed unchanged.

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const INTERNAL_KEY = "test-internal-service-key-with-sufficient-length";
const CALLER_KEY = "test-router-caller-capability-with-sufficient-length";
const SESSION = "0b9f1c2e-1111-4a5b-8c7d-000000000001";
const SESSION_HEADERS = {
  session_id: SESSION,
  "session-id": SESSION,
  "x-codex-router-surface": "claude",
};

async function capture(handler) {
  const seen = [];
  const server = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const raw = Buffer.concat(chunks).toString("utf8");
    if (request.method === "GET") {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ ok: true, credential_present: true }));
      return;
    }
    seen.push({ url: request.url, headers: request.headers, raw });
    handler(response);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, port: server.address().port, seen };
}

function completed(response) {
  response.writeHead(200, { "Content-Type": "application/json" });
  response.end(JSON.stringify({
    id: "resp_affinity",
    status: "completed",
    output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "ok" }] }],
    usage: { input_tokens: 5, output_tokens: 1, total_tokens: 6 },
  }));
}

async function withRouter(run) {
  const native = await capture(completed);
  const gateway = await capture(completed);
  const stateDir = mkdtempSync(path.join(os.tmpdir(), "session-affinity-router-"));
  const port = await openPort();
  const health = `http://127.0.0.1:${gateway.port}/health`;
  const child = spawn(process.execPath, [path.join(root, "src", "router.mjs")], {
    cwd: root,
    env: {
      ...process.env,
      CODEX_HOME: path.join(stateDir, "codex-home"),
      MODEL_ROUTER_STATE_DIR: stateDir,
      CODEX_ROUTER_CALLER_KEY: CALLER_KEY,
      CODEX_ROUTER_INTERNAL_KEY: INTERNAL_KEY,
      KIMI_INTERNAL_KEY: INTERNAL_KEY,
      CODEX_ROUTER_SHOW_ALL_MODELS: "1",
      CODEX_ROUTER_QUIET: "1",
      CODEX_ROUTER_PORT: String(port),
      CODEX_NATIVE_BASE_URL: `http://127.0.0.1:${native.port}/backend-api/codex`,
      CODEX_ROUTER_GATEWAY_BASE_URL: `http://127.0.0.1:${gateway.port}/v1`,
      CODEX_ROUTER_OAUTH_HEALTH_URL: health,
      CODEX_ROUTER_API_HEALTH_URL: health,
      CODEX_ROUTER_GROK_OAUTH_HEALTH_URL: health,
      CODEX_ROUTER_GATEWAY_HEALTH_URL: health,
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let errors = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => { errors += chunk; });
  const base = callerBaseUrl(port, CALLER_KEY);
  try {
    const deadline = Date.now() + 5_000;
    for (;;) {
      if (child.exitCode !== null) throw new Error(`router exited: ${errors}`);
      try { if ((await fetch(`${base}/models`)).ok) break; } catch { /* not bound yet */ }
      if (Date.now() > deadline) throw new Error(`router did not start: ${errors}`);
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    await run({ base, native, gateway, stateDir });
  } finally {
    if (child.exitCode === null) {
      child.kill("SIGTERM");
      await new Promise((resolve) => child.once("exit", resolve));
    }
    await Promise.all([native, gateway].map(({ server }) => new Promise((resolve) => server.close(resolve))));
    rmSync(stateDir, { recursive: true, force: true });
  }
}

function usageRows(stateDir) {
  const file = path.join(stateDir, "usage-events.jsonl");
  return existsSync(file)
    ? readFileSync(file, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line))
    : [];
}

async function waitForRows(stateDir, count) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const rows = usageRows(stateDir);
    if (rows.length >= count) return rows;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`expected ${count} usage rows`);
}

test("a native Codex turn reaches the backend byte-identical with its session headers", async () => {
  await withRouter(async ({ base, native }) => {
    const body = JSON.stringify({
      model: "gpt-5.6-sol",
      input: "native turn",
      prompt_cache_key: SESSION,
      store: false,
      stream: false,
    });
    const response = await fetch(`${base}/responses`, {
      method: "POST",
      headers: {
        Authorization: "Bearer native-session-token",
        "Content-Type": "application/json",
        session_id: SESSION,
        "x-codex-turn-metadata": JSON.stringify({ thread_id: SESSION }),
      },
      body,
    });
    assert.equal(response.status, 200, await response.text());
    assert.equal(native.seen.length, 1);
    const [upstream] = native.seen;
    assert.equal(upstream.raw, body);
    assert.equal(upstream.headers.session_id, SESSION);
    assert.equal(upstream.headers.authorization, "Bearer native-session-token");
    assert.equal(upstream.headers["x-codex-router-surface"], undefined);
  });
});

test("the Claude surface tag stays local while its session reaches the native backend", async () => {
  await withRouter(async ({ base, native, stateDir }) => {
    const response = await fetch(`${base}/responses`, {
      method: "POST",
      headers: {
        Authorization: "Bearer native-session-token",
        "Content-Type": "application/json",
        ...SESSION_HEADERS,
      },
      body: JSON.stringify({ model: "gpt-5.6-sol", input: "translated turn", stream: false }),
    });
    assert.equal(response.status, 200, await response.text());
    const [upstream] = native.seen;
    assert.equal(upstream.headers.session_id, SESSION);
    assert.equal(upstream.headers["session-id"], SESSION);
    assert.equal(upstream.headers["x-codex-router-surface"], undefined);
    const [row] = await waitForRows(stateDir, 1);
    assert.equal(row.surface, "claude");
    assert.match(row.affinity, /^[a-f0-9]{12}$/);
    assert.ok(!JSON.stringify(row).includes(SESSION));
  });
});

test("routed providers never receive session or surface headers", async () => {
  await withRouter(async ({ base, gateway }) => {
    const response = await fetch(`${base}/responses`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...SESSION_HEADERS },
      body: JSON.stringify({
        model: "grok-oauth/grok-4.6",
        input: [{ type: "message", role: "user", content: "hello" }],
      }),
    });
    assert.equal(response.status, 200, await response.text());
    assert.ok(gateway.seen.length >= 1);
    for (const { headers } of gateway.seen) {
      assert.equal(headers.session_id, undefined);
      assert.equal(headers["session-id"], undefined);
      assert.equal(headers["x-codex-router-surface"], undefined);
    }
  });
});
