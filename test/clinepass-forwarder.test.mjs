import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { openPort } from "./port-pool.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const internalKey = "clinepass-test-internal-key-with-sufficient-length";

test("ClinePass completion envelopes are unwrapped without changing other response contracts", async (t) => {
  const state = mkdtempSync(path.join(os.tmpdir(), "clinepass-forwarder-"));
  let fixture;
  const requests = [];
  const upstream = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    requests.push({ headers: request.headers, body: JSON.parse(Buffer.concat(chunks)) });
    response.writeHead(fixture.status || 200, {
      "Content-Type": fixture.contentType || "application/json; charset=utf-8",
      "Content-Length": Buffer.byteLength(fixture.body),
      "x-request-id": "clinepass-fixture-request",
      "x-ratelimit-remaining-requests": "7",
    });
    // Split a multibyte character as well as the JSON envelope across writes.
    const bytes = Buffer.from(fixture.body);
    const unicodeOffset = bytes.indexOf(Buffer.from("世"));
    const split = unicodeOffset >= 0 ? unicodeOffset + 1 : 31;
    response.write(bytes.subarray(0, split));
    response.end(bytes.subarray(split));
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const port = await openPort();
  const endpoint = `http://127.0.0.1:${upstream.address().port}/v1`;
  const child = spawn(process.execPath, [path.join(root, "src", "api-forwarder.mjs")], {
    cwd: root,
    env: {
      ...process.env,
      CODEX_HOME: path.join(state, "codex"),
      MODEL_ROUTER_TARGET: "codex",
      MODEL_ROUTER_STATE_DIR: state,
      MODEL_ROUTER_INTERNAL_KEY: internalKey,
      MODEL_ROUTER_API_PORT: String(port),
      MODEL_ROUTER_QUIET: "1",
      MODEL_ROUTER_MAX_BUFFERED_RESPONSE_BYTES: "4096",
      CLINE_API_BASE_URL: endpoint,
      CLINE_API_KEY: "TEST_CLINEPASS_KEY",
      DEEPSEEK_API_BASE_URL: endpoint,
      DEEPSEEK_API_KEY: "TEST_DEEPSEEK_KEY",
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
  try {
    const base = `http://127.0.0.1:${port}`;
    const headers = { Authorization: `Bearer ${internalKey}`, "Content-Type": "application/json" };
    const deadline = Date.now() + 10_000;
    for (;;) {
      if (child.exitCode !== null) throw new Error(`forwarder exited: ${stderr}`);
      try {
        if ((await fetch(`${base}/health`, { headers })).ok) break;
      } catch {}
      if (Date.now() > deadline) throw new Error(`forwarder not ready: ${stderr}`);
      await new Promise((resolve) => setTimeout(resolve, 40));
    }
    const completion = {
      id: "chatcmpl-clinepass",
      object: "chat.completion",
      model: "deepseek-v4-flash",
      choices: [{ index: 0, message: {
        role: "assistant", content: "Merhaba 世界",
        reasoning_content: "Keep the tool result.",
        tool_calls: [{ id: "call_1", type: "function", function: { name: "lookup", arguments: '{"id":1}' } }],
      }, finish_reason: "tool_calls" }],
      usage: { prompt_tokens: 120, completion_tokens: 9, total_tokens: 129 },
    };
    const envelope = JSON.stringify({ success: true, data: completion });
    const cases = [
      { name: "successful envelope", body: envelope, expected: JSON.stringify(completion) },
      { name: "empty choices", body: '{"success":true,"data":{"choices":[]}}', expected: '{"choices":[]}' },
      { name: "ordinary completion", body: `  ${JSON.stringify(completion)}\n` },
      { name: "unsuccessful envelope", body: JSON.stringify({ success: false, data: completion, error: "empty response content" }) },
      { name: "non-boolean success", body: JSON.stringify({ success: "true", data: completion }) },
      { name: "missing choices", body: '{"success":true,"data":{"id":"missing"}}' },
      { name: "invalid choices", body: '{"success":true,"data":{"choices":{}}}' },
      { name: "non-object data", body: '{"success":true,"data":[]}' },
      { name: "malformed JSON", body: '{"success":true,' },
      { name: "HTTP error", status: 429, body: envelope },
      { name: "bodyless success", status: 204, body: "" },
      { name: "SSE", contentType: "text/event-stream", body: 'data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n', stream: true },
      { name: "other provider", model: "deepseek-legacy-chat", body: envelope },
      { name: "oversized JSON", body: JSON.stringify({ success: true, data: { ...completion, padding: "x".repeat(5000) } }), expectedStatus: 502 },
    ];
    for (const entry of cases) {
      await t.test(entry.name, async () => {
        fixture = entry;
        const response = await fetch(`${base}/v1/chat/completions`, {
          method: "POST", headers,
          body: JSON.stringify({ model: entry.model || "clinepass-deepseek-v4-flash", stream: entry.stream || false, messages: [{ role: "user", content: "test" }] }),
        });
        const body = await response.text();
        assert.equal(response.status, entry.expectedStatus || entry.status || 200, body);
        if (entry.expectedStatus) {
          assert.equal(JSON.parse(body).error.type, "provider_api_proxy_error");
          return;
        }
        assert.equal(body, entry.expected || entry.body);
        assert.equal(response.headers.get("content-type"), entry.contentType || "application/json; charset=utf-8");
        assert.equal(response.headers.get("x-request-id"), "clinepass-fixture-request");
        assert.equal(response.headers.get("x-ratelimit-remaining-requests"), "7");
        assert.equal(requests.at(-1).headers.authorization, `Bearer ${entry.model ? "TEST_DEEPSEEK_KEY" : "TEST_CLINEPASS_KEY"}`);
        assert.equal(requests.at(-1).body.stream, entry.stream || false);
      });
    }
    assert.equal(requests.length, cases.length, "each caller request sends exactly one upstream request");
  } finally {
    if (child.exitCode === null) {
      child.kill("SIGTERM");
      await new Promise((resolve) => child.once("exit", resolve));
    }
    upstream.closeAllConnections();
    await new Promise((resolve) => upstream.close(resolve));
    rmSync(state, { recursive: true, force: true });
  }
});
