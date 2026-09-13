import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { usesNativeChatReasoning } from "../src/chat-reasoning.mjs";
import { childOutput, waitForListeners } from "./listener-readiness.mjs";
import { MODEL_BY_SLUG } from "../src/model-registry.mjs";

test("native chat reasoning stays scoped to established history contracts", () => {
  assert.equal(usesNativeChatReasoning({ requestProfile: "glm-thinking" }), true);
  assert.equal(usesNativeChatReasoning({ requestProfile: "deepseek-thinking" }), true);
  assert.equal(usesNativeChatReasoning({
    provider: "commandcode", upstreamModel: "deepseek/deepseek-v4-flash",
  }), true);
  // OpenCode Go reaches its DeepSeek, GLM, and Qwen thinking models over Chat
  // Completions with reseller-shaped profiles. Its DeepSeek routes keep the
  // vendor replay rule, which the profile checks alone cannot see: the measured
  // `opencode-go/deepseek-v4.1-flash` carries `auto-tool-choice`, so the carry
  // never ran and the provider rejected the following turn.
  for (const model of [
    { provider: "opencode-go", upstreamModel: "deepseek-v4.1-flash", requestProfile: "auto-tool-choice" },
    { provider: "opencode-go", upstreamModel: "deepseek-v4-flash" },
    { provider: "opencode-go", upstreamModel: "deepseek/deepseek-v4-pro" },
  ]) {
    assert.equal(usesNativeChatReasoning(model), true);
  }
  for (const model of [
    undefined,
    { provider: "deepseek", requestProfile: "deepseek-nonthinking" },
    { provider: "custom", upstreamModel: "deepseek/deepseek-v4-flash" },
    { provider: "commandcode", upstreamModel: "moonshotai/kimi-k2.6" },
    { provider: "commandcode-messages", upstreamModel: "deepseek/deepseek-v4-flash" },
    // Other OpenCode Go thinking models keep their existing replay channel:
    // only the DeepSeek upstream's requirement is established.
    { provider: "opencode-go", upstreamModel: "glm-5.3", requestProfile: "ox-alpha" },
    { provider: "opencode-go", upstreamModel: "kimi-k3", requestProfile: "kimi-k3" },
    // Anthropic-protocol variant: reasoning travels as thinking blocks, so the
    // `reasoning_content` restore must not be applied.
    { provider: "opencode-go-messages", requestProfile: "auto-tool-choice" },
  ]) {
    assert.equal(usesNativeChatReasoning(model), false);
  }
});

// The contract is per-upstream, not per-profile: the shipped OpenCode Go
// DeepSeek route carries `auto-tool-choice`, which no profile check in this
// module matches. Reading the registry keeps the assertion tied to the real
// configuration instead of hand-built objects that could drift away from it.
test("every shipped OpenCode Go DeepSeek route replays its reasoning", () => {
  const deepseekRoutes = [...MODEL_BY_SLUG.values()].filter(
    (model) => model.provider === "opencode-go" && /deepseek/i.test(model.upstreamModel ?? ""),
  );
  assert.ok(deepseekRoutes.length > 0, "expected shipped OpenCode Go DeepSeek routes");
  for (const route of deepseekRoutes) {
    assert.equal(usesNativeChatReasoning(route), true, route.slug);
  }

  // Everything else on that endpoint keeps its existing replay channel, and the
  // Anthropic-protocol variant is a different wire contract entirely, so a slug
  // that merely sits next to the Chat routes must not be swept in.
  for (const [slug, model] of MODEL_BY_SLUG) {
    if (model.provider !== "opencode-go" && model.provider !== "opencode-go-messages") continue;
    if (model.provider === "opencode-go" && /deepseek/i.test(model.upstreamModel ?? "")) continue;
    assert.equal(usesNativeChatReasoning(model), false, slug);
  }
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
