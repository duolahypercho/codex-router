import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import http from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { openPort } from "./port-pool.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const internalKey = "test-go-json-replay-internal-key-with-length";

test("Go JSON response keeps its headers and bytes, then replays reasoning on the next tool turn", async () => {
  const state = mkdtempSync(path.join(os.tmpdir(), "go-json-forwarder-"));
  const body = Buffer.from(JSON.stringify({ choices: [{
    finish_reason: "tool_calls",
    message: { reasoning_content: "complete thought", tool_calls: [{ id: "call_header" }] },
  }] }));
  const requests = [];
  const upstream = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    requests.push(JSON.parse(Buffer.concat(chunks)));
    response.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    response.end(body);
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const port = await openPort();
  const child = spawn(process.execPath, [path.join(root, "src", "api-forwarder.mjs")], {
    cwd: root,
    env: {
      ...process.env,
      CODEX_HOME: path.join(state, "codex"),
      MODEL_ROUTER_TARGET: "codex",
      MODEL_ROUTER_INTERNAL_KEY: internalKey,
      MODEL_ROUTER_API_PORT: String(port),
      MODEL_ROUTER_STATE_DIR: state,
      MODEL_ROUTER_QUIET: "1",
      OPENCODE_GO_BASE_URL: `http://127.0.0.1:${upstream.address().port}/v1`,
      OPENCODE_GO_API_KEY: "TEST_GO_KEY",
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
  try {
    const base = `http://127.0.0.1:${port}`;
    const deadline = Date.now() + 5000;
    for (;;) {
      if (child.exitCode !== null) throw new Error(`forwarder exited: ${stderr}`);
      try {
        const ready = await fetch(`${base}/health`, { headers: { Authorization: `Bearer ${internalKey}` } });
        if (ready.ok) break;
      } catch {}
      if (Date.now() > deadline) throw new Error(`forwarder not ready: ${stderr}`);
      await new Promise((resolve) => setTimeout(resolve, 40));
    }
    const response = await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${internalKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: "opencode-go-deepseek-v4-1-flash", messages: [{ role: "user", content: "test" }] }),
    });
    assert.equal(response.status, 200, await response.clone().text());
    assert.equal(response.headers.get("content-type"), "application/json; charset=utf-8");
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), body);
    const followUp = await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${internalKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "opencode-go-deepseek-v4-1-flash",
        messages: [
          { role: "user", content: "test" },
          { role: "assistant", content: null, tool_calls: [{ id: "call_header", type: "function", function: { name: "lookup", arguments: "{}" } }] },
          { role: "tool", tool_call_id: "call_header", content: "42" },
        ],
      }),
    });
    assert.equal(followUp.status, 200, await followUp.clone().text());
    assert.equal(requests.length, 2);
    assert.equal(requests[1].messages.find((message) => message.role === "assistant")?.reasoning_content, "complete thought");
  } finally {
    child.kill("SIGTERM");
    if (child.exitCode === null) await new Promise((resolve) => child.once("exit", resolve));
    upstream.closeAllConnections();
    await new Promise((resolve) => upstream.close(resolve));
    rmSync(state, { recursive: true, force: true });
  }
});
