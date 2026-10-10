import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { callerBaseUrl } from "../src/caller-auth.mjs";
import { openPort } from "./port-pool.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const caller = "synthetic-outcome-caller-key-sufficient-length";
const internal = "synthetic-outcome-internal-key-sufficient-length";
const frame = (payload) => `data: ${JSON.stringify(payload)}\n\n`;

test("real native Router records HTTP delivery and terminal generation outcomes independently", { timeout: 60_000 }, async () => {
  const scratch = mkdtempSync(path.join(os.tmpdir(), "router-outcome-only-"));
  const codexHome = path.join(scratch, "codex");
  mkdirSync(codexHome);
  let terminal;
  let posts = 0;
  const upstream = http.createServer(async (request, response) => {
    if (request.method === "GET") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end('{"ok":true,"credential_present":true}');
      return;
    }
    for await (const _chunk of request) { /* Consume the complete synthetic POST. */ }
    posts += 1;
    if (terminal.startsWith("json-")) {
      const status = terminal.slice(5);
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ id: `r_${posts}`, object: "response",
        ...(status === "missing" ? {} : { status }),
        output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "Synthetic partial output" }] }],
        usage: { input_tokens: 50, output_tokens: 10 } }));
      return;
    }
    response.writeHead(200, { "content-type": "text/event-stream" });
    const initial = { id: `r_${posts}`, object: "response", status: "in_progress", output: [] };
    const item = { id: `msg_${posts}`, type: "message", role: "assistant", status: "completed",
      content: [{ type: "output_text", text: "Synthetic partial output", annotations: [] }] };
    response.write(frame({ type: "response.created", response: initial }));
    response.write(frame({ type: "response.output_item.added", output_index: 0, item: { ...item, status: "in_progress", content: [] } }));
    response.write(frame({ type: "response.content_part.added", output_index: 0, content_index: 0, part: { type: "output_text", text: "", annotations: [] } }));
    response.write(frame({ type: "response.output_text.delta", output_index: 0, content_index: 0, item_id: item.id, delta: item.content[0].text }));
    if (terminal !== "eof") {
      response.write(frame({ type: "response.output_text.done", output_index: 0, content_index: 0, item_id: item.id, text: item.content[0].text }));
      response.write(frame({ type: "response.output_item.done", output_index: 0, item }));
      response.write(frame({ type: terminal === "embedded-failure" ? "response.completed" : `response.${terminal}`,
        response: { ...initial, status: terminal === "embedded-failure" ? "failed" : terminal,
          output: [item], usage: { input_tokens: 50, output_tokens: 10 } } }));
    }
    response.end();
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const upstreamBase = `http://127.0.0.1:${upstream.address().port}`;
  const port = await openPort();
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (/^(MODEL_ROUTER_|CODEX_ROUTER_|ROUTER_PLANE_)/.test(key)) delete env[key];
  Object.assign(env, {
    CODEX_HOME: codexHome, MODEL_ROUTER_STATE_DIR: scratch, CODEX_ROUTER_STATE_DIR: scratch,
    CODEX_ROUTER_PORT: String(port), CODEX_ROUTER_CALLER_KEY: caller,
    CODEX_ROUTER_INTERNAL_KEY: internal, KIMI_INTERNAL_KEY: internal,
    CODEX_NATIVE_BASE_URL: upstreamBase, CODEX_ROUTER_NO_DISCOVERY: "0",
    CODEX_ROUTER_SHOW_ALL_MODELS: "1", CODEX_ROUTER_QUIET: "1",
    CODEX_ROUTER_GATEWAY_HEALTH_URL: upstreamBase, CODEX_ROUTER_API_HEALTH_URL: upstreamBase,
  });
  const child = spawn(process.execPath, [path.join(root, "src/router.mjs")], { cwd: root, env,
    stdio: ["ignore", "ignore", "pipe"], windowsHide: true });
  let errors = "";
  child.stderr.on("data", (chunk) => { errors += chunk; });
  const base = callerBaseUrl(port, caller);
  async function waitUntil(predicate) {
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      if (child.exitCode !== null) throw new Error(`isolated Router exited: ${errors}`);
      if (await predicate()) return;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error(`isolated Router timed out: ${errors}`);
  }
  function ledger() {
    try { return readFileSync(path.join(scratch, "usage-events.jsonl"), "utf8").trim().split("\n").filter(Boolean).map(JSON.parse); }
    catch (error) { if (error.code === "ENOENT") return []; throw error; }
  }
  try {
    await waitUntil(async () => { try { return (await fetch(`${base}/models`)).ok; } catch { return false; } });
    let count = 0;
    for (const [kind, outcome] of [["completed", "completed"], ["failed", "failed"], ["incomplete", "incomplete"], ["embedded-failure", "failed"], ["eof", "indeterminate"], ["json-completed", "completed"], ["json-failed", "failed"], ["json-missing", "indeterminate"]]) {
      terminal = kind;
      const response = await fetch(`${base}/responses`, {
        method: "POST", headers: { "content-type": "application/json", authorization: "Bearer synthetic-native-session" },
        body: JSON.stringify({ model: "gpt-6.1-sol", stream: !kind.startsWith("json-"), input: "Synthetic local regression only", tools: [] }),
        signal: AbortSignal.timeout(10_000),
      });
      const body = await response.text();
      assert.equal(response.status, 200, body);
      assert.match(body, /Synthetic partial output/);
      await waitUntil(() => ledger().length > count);
      count += 1;
      const event = ledger().at(-1);
      assert.equal(event.httpStatus, 200, kind);
      assert.equal(event.generationOutcome, outcome, kind);
      if (kind !== "eof") {
        assert.equal(event.inputTokens, 50, "failed generations still retain measured usage");
        assert.equal(event.outputTokens, 10);
      }
      const activity = await (await fetch(`${base}/activity`)).json();
      const recent = activity.recent.find((entry) => entry.requestId === event.requestId);
      assert.equal(recent.generationOutcome, outcome, kind);
      assert.equal(recent.httpStatus, 200, kind);
    }
    assert.equal(posts, count, "semantic failure must not replay the generation");
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
      await new Promise((resolve) => child.once("exit", resolve));
    }
    upstream.closeAllConnections();
    await new Promise((resolve) => upstream.close(resolve));
    rmSync(scratch, { recursive: true, force: true });
  }
});
