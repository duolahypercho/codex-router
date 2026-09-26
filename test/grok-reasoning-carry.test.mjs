import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import http from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { openPort } from "./port-pool.mjs";
import { toResponsesRequest } from "../src/grok-oauth-forwarder.mjs";
import {
  certifiedReasoningItems,
  createReasoningCarryStore,
  reasoningCarryEnabled,
  reasoningCarryScope,
} from "../src/grok-reasoning-carry.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const INTERNAL_KEY = "test-grok-internal-service-key-with-sufficient-length";
const REASONING = { type: "reasoning", id: "rs_fixture", summary: [{ type: "summary_text", text: "plan" }],
  encrypted_content: "ENC_FIXTURE_TURN_1" };

test("store keeps only certified encrypted reasoning, keyed by session and first call", () => {
  const store = createReasoningCarryStore({ maxEntries: 2, ttlMs: 1_000 });
  const items = certifiedReasoningItems([REASONING, { type: "reasoning", id: "rs_plain", summary: [] },
    { type: "function_call", call_id: "call_1" }]);
  assert.deepEqual(items.map((item) => item.id), ["rs_fixture"]);
  store.remember("s1", ["call_1", "call_2"], items, 0);
  assert.equal(store.recall("s1", ["call_1", "call_2"], 10)[0].encrypted_content, "ENC_FIXTURE_TURN_1");
  assert.equal(store.recall("s2", ["call_1"], 10), undefined, "another session must not receive it");
  assert.equal(store.recall("s1", ["call_1"], 2_000), undefined, "expired entries are not replayed");
  store.remember("s1", ["a"], items, 0);
  store.remember("s1", ["b"], items, 0);
  store.remember("s1", ["c"], items, 0);
  assert.equal(store.recall("s1", ["a"], 1), undefined, "oldest entry is evicted at capacity");
  assert.equal(store.stats().entries, 2);
  assert.equal(reasoningCarryEnabled({ CODEX_ROUTER_GROK_REASONING_CARRY: "0" }), false);
});

test("store scope includes the model, so another Grok model never receives the reasoning", () => {
  const store = createReasoningCarryStore();
  const items = certifiedReasoningItems([REASONING]);
  store.remember(reasoningCarryScope("conv-1", "grok-4.7"), ["call_1"], items, 0);
  assert.equal(store.recall(reasoningCarryScope("conv-1", "grok-4.7"), ["call_1"], 1)[0].encrypted_content,
    "ENC_FIXTURE_TURN_1");
  assert.equal(store.recall(reasoningCarryScope("conv-1", "grok-4.5"), ["call_1"], 1), undefined,
    "a different model in the same conversation must miss");
  assert.equal(store.recall(reasoningCarryScope("conv-2", "grok-4.7"), ["call_1"], 1), undefined);
  assert.equal(reasoningCarryScope("", "grok-4.7"), undefined, "no conversation, no scope");
});

test("toResponsesRequest puts carried reasoning in front of the turn that produced it", () => {
  const chat = { model: "grok-4.7", reasoning_effort: "high", messages: [
    { role: "user", content: "task" },
    { role: "assistant", content: "checking",
      tool_calls: [{ id: "call_1", type: "function", function: { name: "exec_command", arguments: "{}" } }] },
    { role: "tool", tool_call_id: "call_1", content: "ok" },
  ] };
  const carried = toResponsesRequest(chat, { recallReasoning: (ids) => ids[0] === "call_1" ? [REASONING] : undefined });
  assert.deepEqual(carried.input.map((item) => item.type),
    ["message", "reasoning", "message", "function_call", "function_call_output"]);
  assert.equal(carried.input[1].encrypted_content, "ENC_FIXTURE_TURN_1");
  assert.deepEqual(carried.include, ["reasoning.encrypted_content"]);
  const missed = toResponsesRequest(chat, { recallReasoning: () => undefined });
  assert.equal(missed.input.some((item) => item.type === "reasoning"), false, "a miss sends no invented reasoning");
  assert.equal(toResponsesRequest(chat).include, undefined, "without the store the request is unchanged");
});

function sse(events) {
  return events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join("");
}

test("forwarder returns xAI's encrypted reasoning on the next tool-loop request", async () => {
  const seen = [];
  let failNext = false;
  const backend = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    seen.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
    const turn = seen.length;
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    const events = [
      { type: "response.output_item.done", output_index: 0, item: { ...REASONING, encrypted_content: `ENC_TURN_${turn}` } },
      { type: "response.output_item.added", output_index: 1, item: { type: "function_call", id: `fc_${turn}`, call_id: `call_${turn}`, name: "exec_command", arguments: "" } },
      { type: "response.output_item.done", output_index: 1, item: { type: "function_call", id: `fc_${turn}`, call_id: `call_${turn}`, name: "exec_command", arguments: "{\"cmd\":\"ls\"}" } },
      failNext
        ? { type: "response.failed", response: { status: "failed", error: { code: "x", message: "fixture" } } }
        : { type: "response.completed", response: { status: "completed", usage: { input_tokens: 5, output_tokens: 5 } } },
    ];
    response.end(sse(events));
  });
  await new Promise((resolve) => backend.listen(0, "127.0.0.1", resolve));
  const dir = mkdtempSync(path.join(os.tmpdir(), "grok-reasoning-carry-"));
  const authPath = path.join(dir, "auth.json");
  writeFileSync(authPath, JSON.stringify({ "https://auth.x.ai::test-client-id": { key: "fake-access" } }), { mode: 0o600 });
  const port = await openPort();
  const child = spawn(process.execPath, [path.join(root, "src", "grok-oauth-forwarder.mjs")], {
    cwd: root, stdio: ["ignore", "ignore", "pipe"],
    env: { ...process.env, MODEL_ROUTER_TARGET: "codex", MODEL_ROUTER_INTERNAL_KEY: INTERNAL_KEY,
      MODEL_ROUTER_GROK_OAUTH_PORT: String(port), GROK_CLI_CHAT_PROXY_BASE_URL: `http://127.0.0.1:${backend.address().port}`,
      GROK_CLI: path.join(root, "test", "fixtures", "missing-grok-cli"), GROK_AUTH_PATH: authPath,
      MODEL_ROUTER_STATE_DIR: path.join(dir, "state"), MODEL_ROUTER_QUIET: "1",
      CODEX_ROUTER_GROK_PROGRESS_ONLY_RETRY: "0" },
  });
  const base = `http://127.0.0.1:${port}`;
  const headers = { Authorization: `Bearer ${INTERNAL_KEY}`, "Content-Type": "application/json" };
  const history = (task, turns) => {
    // Codex opens every request with its instructions and the task, so the
    // forwarder's conversation id (the first two messages) is stable per turn.
    const messages = [{ role: "system", content: "fixture instructions" }, { role: "user", content: task }];
    for (const turn of turns) {
      messages.push({ role: "assistant", content: "", tool_calls: [{ id: `call_${turn}`, type: "function", function: { name: "exec_command", arguments: "{\"cmd\":\"ls\"}" } }] });
      messages.push({ role: "tool", tool_call_id: `call_${turn}`, content: "fixture output" });
    }
    return messages;
  };
  const post = async (task, turns, model = "grok-4.7") => (await fetch(`${base}/v1/chat/completions`, {
    method: "POST", headers, body: JSON.stringify({ model, stream: true, reasoning_effort: "high", messages: history(task, turns),
      tools: [{ type: "function", function: { name: "exec_command", parameters: { type: "object", properties: {} } } }] }) })).text();
  try {
    for (let i = 0; i < 100; i++) {
      try { if ((await fetch(`${base}/health`, { headers })).ok) break; } catch {}
      await new Promise((r) => setTimeout(r, 40));
    }
    await post("audit fixture A", []);
    await post("audit fixture A", [1]);
    const second = seen[1].input;
    const at = second.findIndex((item) => item.type === "reasoning");
    assert.equal(second[at].encrypted_content, "ENC_TURN_1");
    assert.equal(second[at + 1].type, "function_call");
    assert.equal(second[at + 1].call_id, "call_1");
    assert.deepEqual(seen[1].include, ["reasoning.encrypted_content"]);

    await post("audit fixture B", [1]);
    assert.equal(seen[2].input.some((item) => item.type === "reasoning"), false, "no cross-conversation replay");

    failNext = true;
    await post("audit fixture A", [1, 2]);
    failNext = false;
    await post("audit fixture A", [1, 2, 3]);
    const afterFailure = seen[4].input.filter((item) => item.type === "reasoning").map((item) => item.encrypted_content);
    assert.deepEqual(afterFailure, ["ENC_TURN_1", "ENC_TURN_2"], "a failed response must not be replayed");
    await post("audit fixture A", [1], "grok-4.5");
    assert.equal(seen[5].input.some((item) => item.type === "reasoning"), false,
      "reasoning from grok-4.7 must not be replayed to another model mid-thread");
    const health = await (await fetch(`${base}/health`, { headers })).json();
    assert.equal(health.reasoningCarry.version, 1);
    assert.ok(health.reasoningCarry.hits >= 3);
  } finally {
    child.kill("SIGTERM");
    await new Promise((r) => child.once("exit", r));
    await new Promise((r) => backend.close(r));
    rmSync(dir, { recursive: true, force: true });
  }
});
