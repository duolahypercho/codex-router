import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { WebSocket } from "undici";
import { createChatGPTSubscriptionAccount, readChatGPTAccountPoolState, writeChatGPTAccountPoolState } from "../src/chatgpt-account-pool.mjs";
import { setChatGPTAccountRouting } from "../src/chatgpt-account-routing.mjs";
import { writePrivateJson } from "../src/file-security.mjs";
import { callerBaseUrl } from "../src/caller-auth.mjs";
import { RESPONSES_WEBSOCKET_BETA } from "../src/ws-frames.mjs";
import { openPort } from "./port-pool.mjs";
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CALLER = "synthetic-local-caller-with-enough-characters";

async function harness(t, mode = "fill-first") {
  const root = mkdtempSync(path.join(os.tmpdir(), "chatgpt-routing-router-"));
  const state = path.join(root, "state"); mkdirSync(state, { mode: 0o700 });
  const homesDir = path.join(state, "chatgpt-accounts");
  const poolPath = path.join(state, "chatgpt-account-pool.json");
  const routingPath = path.join(state, "chatgpt-account-routing.json");
  for (const [index, accountId] of ["one", "two"].entries()) {
    const account = createChatGPTSubscriptionAccount({ label: accountId, filePath: poolPath, homesDir });
    const pool = readChatGPTAccountPoolState(poolPath); pool.accounts[account.id].identity = { accountId }; pool.accounts[account.id].priority = 2 - index;
    writeChatGPTAccountPoolState(pool, poolPath);
    const access = `e30.${Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 86400 })).toString("base64url")}.${accountId}`;
    writePrivateJson(path.join(homesDir, account.id, "auth.json"), { tokens: { access_token: access, account_id: accountId } });
  }
  await setChatGPTAccountRouting(mode, { filePath: routingPath });
  const seen = []; let rejectOne = true; let holdNext = false;
  const upstream = http.createServer(async (request, response) => {
    for await (const _chunk of request) { /* Drain the compressed native body. */ }
    if (request.url === "/health") { response.end('{"ok":true,"status":"healthy"}'); return; }
    seen.push({ account: request.headers["chatgpt-account-id"], authorization: request.headers.authorization });
    if (rejectOne && request.headers["chatgpt-account-id"] === "one") {
      response.writeHead(429, { "content-type": "application/json", "retry-after": "120" }); response.end('{"error":{"type":"usage_limit_reached"}}'); return;
    }
    if (request.url.endsWith("/compact")) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end('{"output":[{"type":"compaction","encrypted_content":"synthetic-summary"}]}'); return;
    }
    response.writeHead(200, { "content-type": "text/event-stream" });
    if (holdNext) { holdNext = false; response.write('data: {"type":"response.output_text.delta","delta":"partial"}\n\n'); return; }
    response.end('data: {"type":"response.output_text.delta","delta":"ok"}\n\ndata: {"type":"response.completed","response":{"id":"resp_synthetic","output":[{"type":"message","role":"assistant","content":[{"type":"output_text","text":"ok"}]}],"usage":{"input_tokens":1,"output_tokens":1}}}\n\n');
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const upstreamPort = upstream.address().port; const routerPort = await openPort(); let stderr = "";
  const spawnOptions = {
    cwd: repo,
    env: { ...process.env, CODEX_HOME: path.join(root, "codex"), MODEL_ROUTER_STATE_DIR: state, CODEX_ROUTER_CALLER_KEY: CALLER, CODEX_ROUTER_INTERNAL_KEY: "synthetic-internal-key-with-enough-characters", CODEX_ROUTER_PORT: String(routerPort), CODEX_NATIVE_BASE_URL: `http://127.0.0.1:${upstreamPort}`, CODEX_ROUTER_GATEWAY_BASE_URL: `http://127.0.0.1:${upstreamPort}/v1`, CODEX_ROUTER_GATEWAY_HEALTH_URL: `http://127.0.0.1:${upstreamPort}/health`, CODEX_ROUTER_OAUTH_HEALTH_URL: `http://127.0.0.1:${upstreamPort}/health`, CODEX_ROUTER_API_HEALTH_URL: `http://127.0.0.1:${upstreamPort}/health`, CODEX_ROUTER_GROK_OAUTH_HEALTH_URL: `http://127.0.0.1:${upstreamPort}/health`, CODEX_ROUTER_NO_DISCOVERY: "0", CODEX_ROUTER_NATIVE_SESSION_FALLBACK: "0", CODEX_ROUTER_QUIET: "1" },
    stdio: ["ignore", "ignore", "pipe"],
  };
  const start = () => {
    const childProcess = spawn(process.execPath, ["src/router.mjs"], spawnOptions);
    childProcess.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    return childProcess;
  };
  let child = start();
  const stop = async () => {
    if (child.exitCode === null && child.signalCode === null) { const stopped = new Promise((resolve) => child.once("exit", resolve)); child.kill(); await stopped; }
  };
  t.after(async () => {
    await stop();
    upstream.closeAllConnections(); await new Promise((resolve) => upstream.close(resolve)); rmSync(root, { recursive: true, force: true });
  });
  const ready = async () => {
    for (let tries = 0; tries < 150; tries++) {
      if (child.exitCode !== null) throw new Error(stderr);
      try { const response = await fetch(`http://127.0.0.1:${routerPort}/health`); if ((await response.json()).service) break; } catch { /* The router is starting. */ }
      await new Promise((resolve) => setTimeout(resolve, 30));
      if (tries === 149) throw new Error(`Startup timeout: ${stderr}`);
    }
  };
  await ready();
  let url = `${callerBaseUrl(routerPort, CALLER)}/responses`;
  const headers = { "content-type": "application/json", authorization: "Bearer original-codex-login", "chatgpt-account-id": "one", session_id: "synthetic-session" };
  const post = async (session, input = [{ role: "user", content: "hello" }], extra = {}) => {
    const response = await fetch(url, { method: "POST", headers: { ...headers, session_id: session }, body: JSON.stringify({ model: "gpt-5.4", stream: true, store: false, input, ...extra }) });
    return { status: response.status, text: await response.text() };
  };
  return { get url() { return url; }, headers, post, seen, setRejectOne(value) { rejectOne = value; }, holdNext() { holdNext = true; }, logs: () => stderr,
    async restartCaller(caller) {
      await stop(); spawnOptions.env.CODEX_ROUTER_CALLER_KEY = caller;
      child = start(); await ready(); url = `${callerBaseUrl(routerPort, caller)}/responses`;
    },
  };
}

test("native HTTP quota swaps actual upstream account headers and continuation stays on owner", async (t) => {
  const h = await harness(t);
  const first = await h.post("http"); assert.equal(first.status, 200); assert.match(first.text, /ok/);
  assert.deepEqual(h.seen.map((entry) => entry.account), ["one", "two"]);
  assert.notEqual(h.seen[0].authorization, h.seen[1].authorization);
  const continuation = await h.post("http", [{ type: "reasoning", encrypted_content: "synthetic-cipher" }]);
  assert.equal(continuation.status, 200); assert.equal(h.seen.at(-1).account, "two");
  assert.doesNotMatch(h.logs(), /e30\.|Bearer original|access_token/);
});

test("pool off preserves caller credentials and does not perform quota switching", async (t) => {
  const h = await harness(t, "off");
  const result = await h.post("off"); assert.equal(result.status, 429);
  assert.ok(h.seen.length >= 1); assert.ok(h.seen.every((entry) => entry.authorization === "Bearer original-codex-login" && entry.account === "one"));
});

test("client WebSocket uses the shared HTTP pool and maintains account ownership on chained turns", async (t) => {
  const h = await harness(t);
  const socket = new WebSocket(h.url.replace("http:", "ws:"), { headers: { ...h.headers, "openai-beta": RESPONSES_WEBSOCKET_BETA } });
  t.after(() => socket.close());
  await new Promise((resolve, reject) => { socket.addEventListener("open", resolve, { once: true }); socket.addEventListener("error", reject, { once: true }); });
  const turn = (input, previous_response_id) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("WebSocket turn timeout")), 5000);
    const handler = (event) => {
      const value = JSON.parse(event.data);
      if (value.type === "error" || value.type === "response.failed") { clearTimeout(timer); socket.removeEventListener("message", handler); reject(new Error(JSON.stringify(value))); }
      if (value.type === "response.completed") { clearTimeout(timer); socket.removeEventListener("message", handler); resolve(value); }
    };
    socket.addEventListener("message", handler);
    socket.send(JSON.stringify({ type: "response.create", stream: true, store: false, model: "gpt-5.4", input, ...(previous_response_id ? { previous_response_id } : {}) }));
  });
  const first = await turn([{ role: "user", content: "hello" }]);
  assert.deepEqual(h.seen.map((entry) => entry.account), ["one", "two"]);
  await turn([{ role: "user", content: "again" }], first.response.id);
  assert.equal(h.seen.at(-1).account, "two");
  socket.close();
});


test("compact V1 and V2 requests use the established conversation account", async (t) => {
  const h = await harness(t);
  await h.post("compact");
  const headers = { ...h.headers, session_id: "compact" };
  const compact = await fetch(`${h.url}/compact`, { method: "POST", headers, body: JSON.stringify({ model: "gpt-5.4", previous_response_id: "resp_synthetic", input: [{ type: "reasoning", encrypted_content: "cipher" }] }) });
  assert.equal(compact.status, 200); assert.match(await compact.text(), /synthetic-summary/); assert.equal(h.seen.at(-1).account, "two");
  const v2 = await h.post("compact", [{ type: "reasoning", encrypted_content: "cipher" }, { type: "compaction_trigger" }]);
  assert.equal(v2.status, 200); assert.equal(h.seen.at(-1).account, "two");
});

test("client cancellation releases the Router conversation lease for the next turn", async (t) => {
  const h = await harness(t); await h.post("cancel"); h.holdNext();
  const controller = new AbortController();
  const response = await fetch(h.url, { method: "POST", signal: controller.signal, headers: { ...h.headers, session_id: "cancel" }, body: JSON.stringify({ model: "gpt-5.4", stream: true, store: false, input: [{ role: "user", content: "hold" }] }) });
  const reader = response.body.getReader(); await reader.read(); controller.abort(); await reader.cancel().catch(() => {});
  const next = await h.post("cancel"); assert.equal(next.status, 200); assert.equal(h.seen.at(-1).account, "two");
});

test("restarting with a rotated caller capability preserves native continuation ownership and refuses unverified children", async (t) => {
  const h = await harness(t, "round-robin"); h.setRejectOne(false);
  await h.post("first"); await h.post("parent");
  assert.deepEqual(h.seen.map((entry) => entry.account), ["one", "two"]);
  const staleUrl = h.url;
  await h.restartCaller("synthetic-rotated-caller-with-enough-characters");
  const stale = await fetch(staleUrl, { method: "POST", headers: h.headers, body: JSON.stringify({ model: "gpt-5.4", input: "hello" }) });
  assert.equal(stale.status, 401); await stale.text();
  const continuation = await h.post("parent", [{ type: "reasoning", encrypted_content: "parent-cipher" }]);
  assert.equal(continuation.status, 200); assert.equal(h.seen.at(-1).account, "two");
  const child = await fetch(h.url, { method: "POST", headers: { ...h.headers, "thread-id": "child", "x-codex-parent-thread-id": "parent" }, body: JSON.stringify({ model: "gpt-5.4", input: [{ role: "user", content: "child" }] }) });
  assert.equal(child.status, 503); assert.match(await child.text(), /live marker-return verification/); assert.equal(h.seen.length, 3);
});

test("native Code Interpreter requests with container.file_ids do not replay under another account", async (t) => {
  const h = await harness(t);
  const response = await h.post("owned-files", [{ role: "user", content: "read the file" }], { tools: [{ type: "code_interpreter", container: { type: "auto", file_ids: ["file_synthetic"] } }] });
  assert.equal(response.status, 429); assert.match(response.text, /usage_limit_reached/);
  assert.deepEqual(h.seen.map((entry) => entry.account), ["one"]);
});

test("native HTTP and client WebSocket collaboration declarations make zero upstream requests", async (t) => {
  const h = await harness(t); h.setRejectOne(false);
  for (const extra of [
    { tools: [{ type: "namespace", name: "collaboration", tools: [{ type: "function", name: "spawn_agent", parameters: {} }] }] },
    { client_metadata: { "x-codex-parent-thread-id": "parent" } },
    { client_metadata: { "x-openai-subagent": "child" } },
    { tools: [{ type: "function", name: "collaboration__send_message", parameters: {} }] },
    { input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "Message Type: NEW_TASK\nTask name: /root/child\nSender: /root\nPayload:\n" }, { type: "encrypted_content", encrypted_content: "gAAAAA-synthetic=" }] }] },
    { input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "Message Type: FOLLOWUP_" }, { type: "input_text", text: "TASK\nPayload:\n" }, { type: "encrypted_content", encrypted_content: "gAAAAA-synthetic=" }] }] },
    { model: "kimi-oauth/k3", input: [{ type: "agent_message", content: [{ type: "input_text", text: "Message Type: NEW_TASK\nTask name: /root/child\nSender: /root\nPayload:\n" }, { type: "encrypted_content", encrypted_content: "gAAAAA-synthetic=" }] }] },
  ]) {
    const response = await h.post("blocked", undefined, extra);
    assert.equal(response.status, 503); assert.match(response.text, /live marker-return verification/);
  }
  assert.equal(h.seen.length, 0);
  const socket = new WebSocket(h.url.replace("http:", "ws:"), { headers: { ...h.headers, "openai-beta": RESPONSES_WEBSOCKET_BETA } });
  t.after(() => socket.close());
  await new Promise((resolve, reject) => { socket.addEventListener("open", resolve, { once: true }); socket.addEventListener("error", reject, { once: true }); });
  const refused = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("WebSocket refusal timeout")), 5000);
    socket.addEventListener("message", (event) => { clearTimeout(timer); resolve(JSON.parse(event.data)); }, { once: true });
  });
  socket.send(JSON.stringify({ type: "response.create", stream: true, store: false, model: "gpt-5.4", input: [{ role: "user", content: "child" }], client_metadata: { "x-codex-parent-thread-id": "parent" } }));
  assert.match(JSON.stringify(await refused), /live marker-return verification/);
  assert.equal(h.seen.length, 0); socket.close();
});
