import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { nativeReasoningFamily, usesNativeChatReasoning } from "../src/chat-reasoning.mjs";
import { MODEL_BY_SLUG } from "../src/model-registry.mjs";
import { childOutput, waitForListeners } from "./listener-readiness.mjs";

test("native chat reasoning stays scoped to established history contracts", () => {
  assert.equal(usesNativeChatReasoning({ requestProfile: "glm-thinking" }), true);
  assert.equal(usesNativeChatReasoning({ requestProfile: "deepseek-thinking" }), true);
  // Every hy4 route that thinks shares this profile (opencode-go, openrouter,
  // nano-gpt, nousresearch); clinepass does not.
  assert.equal(usesNativeChatReasoning({ requestProfile: "hy4-reasoning" }), true);
  assert.equal(usesNativeChatReasoning({
    provider: "commandcode", upstreamModel: "deepseek/deepseek-v4-flash",
  }), true);
  for (const model of [
    undefined,
    // With no `upstreamModel` this asserted nothing: String(undefined ?? "")
    // matches no family, so it passed whether or not the alias was swept in.
    // `deepseek-chat` is the real shipped id, and it ships thinking disabled.
    { provider: "deepseek", upstreamModel: "deepseek-chat", requestProfile: "deepseek-nonthinking" },
    { provider: "custom", upstreamModel: "deepseek/deepseek-v4-flash" },
    // Non-thinking Kimi stays out: k2.6 does not preserve thinking, and no
    // reseller route for k2.7 was probed.
    { provider: "commandcode", upstreamModel: "moonshotai/kimi-k2.6" },
    { provider: "opencode-go", upstreamModel: "kimi-k2.6" },
    { provider: "nousresearch", upstreamModel: "moonshotai/kimi-k2.7-code" },
    // Anthropic-protocol variants carry reasoning as thinking blocks.
    { provider: "commandcode-messages", upstreamModel: "deepseek/deepseek-v4-flash" },
    { provider: "opencode-go-messages", upstreamModel: "MiniMax-M2.5" },
    { provider: "clinepass", requestProfile: "clinepass", upstreamModel: "tencent/hy4-preview" },
    // Resellers that were never probed keep their existing channel.
    { provider: "nousresearch", upstreamModel: "z-ai/glm-5.3" },
    { provider: "venice", upstreamModel: "glm-5.3" },
    { provider: "qwen-plan", requestProfile: "qwen-plan", upstreamModel: "qwen3.8-max" },
  ]) {
    assert.equal(usesNativeChatReasoning(model), false, JSON.stringify(model));
  }
});


// Hand-built objects cannot catch a family that accidentally matches a route
// nobody listed. `deepseek-chat` slipped past exactly that way: the negative
// above omitted `upstreamModel`, so it asserted nothing, and an unanchored
// /(^|\/)deepseek/i swept in a non-thinking alias. This sweeps the real
// catalog instead, so the next accidental match fails here.
test("no shipped route enters the contract without thinking evidence", () => {
  const THINKING_PROFILES = new Set([
    "glm-thinking", "deepseek-thinking", "hy4-reasoning",
  ]);
  let checked = 0;
  for (const [slug, model] of MODEL_BY_SLUG) {
    if (!usesNativeChatReasoning(model)) continue;
    checked += 1;

    // A route in the contract is there because its profile says it thinks, or
    // because its upstream model is in the family table, or because it is the
    // legacy Command Code DeepSeek Flash special case. Nothing else.
    const byProfile = THINKING_PROFILES.has(model.requestProfile);
    const byFamily = nativeReasoningFamily(model) !== undefined;
    const legacy =
      model.provider === "commandcode" &&
      model.upstreamModel === "deepseek/deepseek-v4-flash";
    assert.ok(byProfile || byFamily || legacy, `${slug} replays reasoning with no stated evidence`);

    // A profile that disables thinking must never be in the contract, however
    // its upstream id is spelled.
    assert.ok(
      !/-nonthinking$/.test(model.requestProfile ?? ""),
      `${slug} disables thinking yet replays reasoning_content`,
    );
  }
  assert.ok(checked > 0, "expected shipped routes in the native reasoning contract");
});

// The rule belongs to the upstream model, so the same family is recognised
// with or without a vendor prefix and whatever request profile the reseller
// route happens to carry. Every positive here answered a live single-turn
// probe with a reasoning item on 12 September 2026.
test("thinking families behind Chat Completions resellers replay reasoning natively", () => {
  const positives = [
    ["deepseek", { provider: "opencode-go", upstreamModel: "deepseek-v4.1-flash", requestProfile: "auto-tool-choice" }],
    ["deepseek", { provider: "openrouter", upstreamModel: "deepseek/deepseek-v4.1-flash", requestProfile: "auto-tool-choice" }],
    ["deepseek", { provider: "commandcode", upstreamModel: "deepseek/deepseek-v4-pro" }],
    ["glm", { provider: "opencode-go", upstreamModel: "glm-5.2" }],
    ["glm", { provider: "opencode-go", upstreamModel: "glm-5.3-flash", requestProfile: "ox-alpha" }],
    ["glm", { provider: "openrouter", upstreamModel: "z-ai/glm-5.3" }],
    ["glm", { provider: "commandcode", upstreamModel: "zai-org/GLM-5.3" }],
    ["kimi-k3", { provider: "opencode-go", upstreamModel: "kimi-k3", requestProfile: "kimi-k3" }],
    ["kimi-k3", { provider: "commandcode", upstreamModel: "moonshotai/Kimi-K3", requestProfile: "kimi-k3" }],
    ["kimi-k3", { provider: "kimi-api", upstreamModel: "kimi-k3", requestProfile: "kimi-k3" }],
    ["minimax-m3", { provider: "minimax-token-plan", upstreamModel: "MiniMax-M3", requestProfile: "minimax-m3" }],
    ["hunyuan", { provider: "opencode-go", upstreamModel: "hy3" }],
    ["hunyuan", { provider: "commandcode", upstreamModel: "tencent/hy3-paid" }],
    ["hunyuan", { provider: "commandcode", upstreamModel: "tencent/hy4-preview" }],
  ];
  for (const [family, model] of positives) {
    assert.equal(nativeReasoningFamily(model), family, JSON.stringify(model));
    assert.equal(usesNativeChatReasoning(model), true, JSON.stringify(model));
  }
  // A family match on a provider outside the table is not enough.
  assert.equal(nativeReasoningFamily({ provider: "nousresearch", upstreamModel: "deepseek/deepseek-v4-pro" }), undefined);
  // A prefix that merely contains the family name is not the family.
  assert.equal(nativeReasoningFamily({ provider: "opencode-go", upstreamModel: "not-glm-5" }), undefined);
  assert.equal(nativeReasoningFamily({ provider: "opencode-go", upstreamModel: "kimi-k3-mini" }), undefined);
});

// Optional, offline integration with the installed version pinned in requirements/python.txt.
// No provider requests; an explicitly supplied invalid runtime must fail.
const python = process.env.MODEL_ROUTER_TEST_LITELLM_PYTHON;
test("pinned LiteLLM replays Chat reasoning exactly once", { skip: !python, timeout: 120000 }, async (t) => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const version = readFileSync(path.join(root, "requirements/python.txt"), "utf8")
    .match(/^litellm==([^\s]+)/m)?.[1];
  assert.ok(version, "LiteLLM must be pinned in the repository lock");
  // Fail before starting services if the explicitly supplied runtime is unusable.
  execFileSync(python, ["-c", "import importlib.metadata, sys; assert importlib.metadata.version('litellm') == sys.argv[1]", version], {
    timeout: 5000, env: { PATH: process.env.PATH, PYTHONNOUSERSITE: "1" }, stdio: "pipe",
  });
  const state = mkdtempSync(path.join(os.tmpdir(), "chat-reasoning-proof-"));
  const internal = "test-chat-reasoning-internal-key-with-sufficient-length";
  const caller = "test-chat-reasoning-caller-key-with-sufficient-length";
  const servers = [];
  const children = [];
  const requests = [];
  let negativeControl = false;

  async function listen(handler) {
    const server = http.createServer(handler);
    servers.push(server);
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    return server;
  }
  async function port() {
    const server = await listen();
    const value = server.address().port;
    await new Promise((resolve) => server.close(resolve));
    return value;
  }
  async function bodyJson(request) {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    return JSON.parse(Buffer.concat(chunks));
  }
  function respond(response, status, body) {
    response.writeHead(status, { "Content-Type": "application/json" });
    response.end(JSON.stringify(body));
  }
  const input = [
    { type: "message", role: "user", content: "Start the synthetic check." },
    { type: "reasoning", summary: [{ type: "summary_text", text: "SUMMARY_REASONING" }], content: null },
    { type: "message", role: "assistant", content: "FIRST_VISIBLE" },
    { type: "message", role: "user", content: "Call the synthetic tool." },
    { type: "reasoning", content: "TOOL_REASONING_ONE" },
    { type: "reasoning", content: [{ type: "reasoning_text", text: "TOOL_REASONING_TWO" }] },
    { type: "function_call", name: "probe", call_id: "call_fixture", arguments: "{}" },
    { type: "function_call_output", call_id: "call_fixture", output: "fixture result" },
    { type: "reasoning", content: [{ type: "reasoning_text", text: "ANSWER_REASONING" }] },
    { type: "message", role: "assistant", content: [{ type: "output_text", text: "FINAL_VISIBLE" }] },
    { type: "message", role: "user", content: "Continue the synthetic check." },
  ];
  function assertHistory(messages) {
    const serialized = JSON.stringify(messages);
    for (const marker of ["SUMMARY_REASONING", "TOOL_REASONING_ONE", "TOOL_REASONING_TWO", "ANSWER_REASONING"]) {
      assert.equal(serialized.split(marker).length - 1, 1, `${marker} must occur exactly once`);
      const owner = messages.find((message) => message.reasoning_content?.includes(marker));
      assert.equal(owner?.role, "assistant", `${marker} must belong to assistant reasoning`);
      assert.equal(messages.some((message) => JSON.stringify(message.content)?.includes(marker)), false,
        "Reasoning must not become visible assistant or user text");
    }
    for (const marker of ["FIRST_VISIBLE", "FINAL_VISIBLE"]) {
      assert.equal(serialized.split(marker).length - 1, 1, "Visible answers must remain exactly once");
    }
    const toolTurn = messages.find((message) => message.tool_calls?.[0]?.id === "call_fixture");
    assert.equal(toolTurn.reasoning_content, "TOOL_REASONING_ONE\nTOOL_REASONING_TWO");
  }

  try {
    const codexHome = path.join(state, "codex");
    mkdirSync(codexHome);
    const cleanEnv = {
      PATH: process.env.PATH, HOME: state, CODEX_HOME: codexHome,
      XDG_CONFIG_HOME: path.join(state, "config"),
      LITELLM_LOCAL_MODEL_COST_MAP: "True", DO_NOT_TRACK: "1", PYTHONUNBUFFERED: "1",
    };
    const upstream = await listen(async (request, response) => {
      requests.push(await bodyJson(request));
      respond(response, 200, {
        id: "chatcmpl-fixture", object: "chat.completion", created: 1, model: "fixture",
        choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 100, completion_tokens: 1, total_tokens: 101 },
      });
    });
    const routerPort = await port();
    const forwarderPort = await port();
    const pythonCode = String.raw`
import asyncio, importlib.metadata, json, sys
import litellm
assert importlib.metadata.version("litellm") == sys.argv[2]
litellm.suppress_debug_info = True
litellm.drop_params = True
payload = json.load(sys.stdin)
payload.update(model="openai/" + payload["model"], api_base=sys.argv[1],
               api_key="test-chat-reasoning-internal-key-with-sufficient-length",
               use_chat_completions_api=True)
async def main():
    result = await litellm.aresponses(**payload)
    print(result.model_dump_json(exclude_none=True))
asyncio.run(main())
  `;
    const gateway = await listen(async (request, response) => {
      const payload = await bodyJson(request);
      if (negativeControl) {
        // Reintroduce the original content-bearing item left by the old carry.
        // The actual pinned translator must expose the resulting duplicate.
        payload.input.splice(1, 0, { type: "reasoning", content: "TOOL_REASONING_ONE" });
      }
      const child = spawn(python, ["-c", pythonCode, `http://127.0.0.1:${forwarderPort}/v1`, version], {
        env: cleanEnv, stdio: ["pipe", "pipe", "pipe"],
      });
      children.push(child);
      child.stdin.end(JSON.stringify(payload));
      let stdout = ""; let stderr = "";
      child.stdout.on("data", (chunk) => { stdout += chunk; });
      child.stderr.on("data", (chunk) => { stderr += chunk; });
      child.once("error", (error) => respond(response, 502, { error: { message: error.message } }));
      child.once("exit", (code) => {
        if (code !== 0) respond(response, 502, { error: { message: stderr || "Offline translator failed" } });
        else { response.writeHead(200, { "Content-Type": "application/json" }); response.end(stdout); }
      });
    });
    const env = {
      ...cleanEnv, MODEL_ROUTER_STATE_DIR: state, CODEX_ROUTER_STATE_DIR: state,
      CODEX_ROUTER_CALLER_KEY: caller, CODEX_ROUTER_INTERNAL_KEY: internal,
      CODEX_ROUTER_PORT: String(routerPort), CODEX_ROUTER_API_PORT: String(forwarderPort),
      CODEX_ROUTER_GATEWAY_BASE_URL: `http://127.0.0.1:${gateway.address().port}/v1`,
      CODEX_ROUTER_SHOW_ALL_MODELS: "1", CODEX_ROUTER_QUIET: "1", CODEX_ROUTER_DISABLE_DISCOVERY: "1",
      DEEPSEEK_API_BASE_URL: `http://127.0.0.1:${upstream.address().port}/v1`, DEEPSEEK_API_KEY: "TEST_DEEPSEEK_KEY",
      ZAI_CODING_BASE_URL: `http://127.0.0.1:${upstream.address().port}/v1`, ZAI_API_KEY: "TEST_ZAI_KEY",
      COMMANDCODE_BASE_URL: `http://127.0.0.1:${upstream.address().port}/v1`, COMMAND_CODE_API_KEY: "TEST_COMMANDCODE_KEY",
    };
    const output = childOutput();
    const services = ["api-forwarder.mjs", "router.mjs"].map((script) => output.capture(script,
      spawn(process.execPath, [path.join(root, "src", script)], { cwd: root, env, stdio: ["ignore", "ignore", "pipe"] })));
    children.push(...services);
    const base = `http://127.0.0.1:${routerPort}/_codex-router/${caller}/v1`;
    await waitForListeners([
      { name: "api-forwarder /health", url: `http://127.0.0.1:${forwarderPort}/health`, headers: { Authorization: `Bearer ${internal}` } },
      { name: "router /models", url: `${base}/models` },
    ], { children: services, output });
    for (const model of ["zai-coding/glm-5.3", "deepseek/deepseek-v4-flash", "commandcode/deepseek-v4-flash"]) {
      for (negativeControl of [false, true]) {
        const response = await fetch(`${base}/responses`, {
          method: "POST", headers: { "Content-Type": "application/json" }, signal: AbortSignal.timeout(30000),
          body: JSON.stringify({ model, input, stream: false, tools: [{ type: "function", name: "probe", parameters: { type: "object", properties: {} } }] }),
        });
        assert.equal(response.status, 200, `${await response.text()}\n${output}`);
        if (negativeControl) assert.throws(() => assertHistory(requests.at(-1).messages), /must occur exactly once/);
        else assertHistory(requests.at(-1).messages);
        t.diagnostic(JSON.stringify({ model, litellm: version, negativeControl, status: "passed" }));
      }
    }
  } finally {
    for (const child of children) if (child.exitCode === null) child.kill("SIGTERM");
    await Promise.all(children.map((child) => child.exitCode !== null ? undefined : new Promise((resolve) => child.once("exit", resolve))));
    for (const server of servers) if (server.listening) {
      server.closeAllConnections(); await new Promise((resolve) => server.close(resolve));
    }
    rmSync(state, { recursive: true, force: true });
  }
});
