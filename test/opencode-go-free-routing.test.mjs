import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { openPort } from "./port-pool.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const temp = mkdtempSync(path.join(os.tmpdir(), "router-opencode-go-free-"));
const overlay = path.join(temp, "user-models.json");
const credential = path.join(temp, "opencode-go-api-key.secret");
const internal = "test-internal-opencode-free-key-123456789";

const FREE_MODELS = [
  {
    slug: "opencode-go/beam-free",
    gatewayModel: "opencode-go-beam-free",
    upstreamModel: "beam-free",
    provider: "opencode-go",
    listed: true,
    displayName: "Beam Free",
    description: "Test route",
    priority: 100,
    defaultEffort: "high",
    reasoningLevels: [
      { effort: "low", description: "Low" },
      { effort: "medium", description: "Medium" },
      { effort: "high", description: "High" },
      { effort: "xhigh", description: "Extra deep" },
      { effort: "max", description: "Max" },
    ],
    contextWindow: 1_048_576,
    autoCompact: 891_289,
    inputModalities: ["text"],
    isFree: true,
    compHash: "opencode-go-beam-free-user-v1",
  },
  {
    slug: "opencode-go/longcat-2.5-preview-free",
    gatewayModel: "opencode-go-longcat-2-5-preview-free",
    upstreamModel: "longcat-2.5-preview-free",
    provider: "opencode-go",
    listed: true,
    displayName: "LongCat 2.5 Preview Free",
    description: "Test route",
    priority: 100,
    defaultEffort: "high",
    reasoningLevels: [{ effort: "high", description: "Adaptive reasoning" }],
    contextWindow: 1_000_000,
    autoCompact: 850_000,
    inputModalities: ["text", "image"],
    isFree: true,
    compHash: "opencode-go-longcat-2-5-preview-free-user-v1",
  },
  {
    slug: "opencode-go/minimax-m3.1-flash-free",
    gatewayModel: "opencode-go-minimax-m3-1-flash-free",
    upstreamModel: "minimax-m3.1-flash-free",
    provider: "opencode-go",
    listed: true,
    displayName: "MiniMax M3.1 Flash Free",
    description: "Test route",
    priority: 100,
    defaultEffort: "high",
    reasoningLevels: [
      { effort: "low", description: "Low" },
      { effort: "medium", description: "Medium" },
      { effort: "high", description: "High" },
      { effort: "xhigh", description: "Extra deep" },
      { effort: "max", description: "Max" },
    ],
    contextWindow: 1_000_000,
    autoCompact: 488_000,
    inputModalities: ["text", "image"],
    isFree: true,
    compHash: "opencode-go-minimax-m3-1-flash-free-user-v1",
  },
];

writeFileSync(overlay, JSON.stringify({ version: 1, models: FREE_MODELS }));
writeFileSync(credential, "test-opencode-go-key\n", { mode: 0o600 });
process.env.MODEL_ROUTER_USER_MODELS = overlay;

const { renderLiteLlmConfig } = await import("../src/litellm-config.mjs");
test.after(() => rmSync(temp, { recursive: true, force: true }));

// The Go free ids are ordinary Chat Completions routes on the subscription
// endpoint: they need the Go credential and the session header, and nothing
// else distinguishes them from a paid route. This is the wire contract the
// free routes have to keep.
test("every OpenCode Go free route renders as a Chat Completions deployment", () => {
  const rendered = renderLiteLlmConfig();
  for (const model of FREE_MODELS) {
    const deployment = rendered
      .split(`model_name: "${model.gatewayModel}"`)[1]
      ?.split("  - model_name:")[0];
    assert.ok(deployment, `${model.gatewayModel} has no deployment`);
    // The Chat route is addressed by its gateway model: the forwarder maps
    // that name back to the upstream id it sends OpenCode.
    assert.match(deployment, new RegExp(`model: "openai/${model.gatewayModel}"`));
    assert.match(
      deployment,
      /api_base: "os\.environ\/CODEX_ROUTER_API_FORWARD_BASE_URL"/,
    );
    assert.match(deployment, /api_key: "os\.environ\/CODEX_ROUTER_INTERNAL_KEY"/);
    assert.match(deployment, /use_chat_completions_api: true/);
  }
});

test("the API forwarder sends each free route upstream with the Go credential", async () => {
  const observed = [];
  const upstream = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks));
    observed.push({
      path: request.url,
      auth: request.headers.authorization,
      session: request.headers["x-opencode-session"],
      body,
    });
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      id: "chatcmpl-test",
      object: "chat.completion",
      created: 1792553360,
      model: body.model,
      choices: [{
        index: 0,
        finish_reason: "stop",
        message: { role: "assistant", content: "ok" },
      }],
    }));
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const port = await openPort();
  const child = spawn(process.execPath, ["src/api-forwarder.mjs"], {
    cwd: root,
    env: {
      ...process.env,
      MODEL_ROUTER_STATE_DIR: temp,
      MODEL_ROUTER_USER_MODELS: overlay,
      MODEL_ROUTER_API_PORT: String(port),
      CODEX_ROUTER_INTERNAL_KEY: internal,
      OPENCODE_GO_BASE_URL: `http://127.0.0.1:${upstream.address().port}/v1`,
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let errors = "";
  child.stderr.on("data", (chunk) => { errors += chunk; });
  try {
    let ready = false;
    for (let index = 0; index < 150; index += 1) {
      try {
        ready = (await fetch(`http://127.0.0.1:${port}/health`, {
          headers: { authorization: `Bearer ${internal}` },
        })).ok;
      } catch {
        // Wait for the forwarder to bind.
      }
      if (ready) break;
      if (child.exitCode !== null) throw new Error(errors);
      await new Promise((resolve) => setTimeout(resolve, 40));
    }
    assert.ok(ready, errors);

    for (const model of FREE_MODELS) {
      const response = await fetch(
        `http://127.0.0.1:${port}/v1/chat/completions`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${internal}`,
          },
          body: JSON.stringify({
            model: model.gatewayModel,
            messages: [{ role: "user", content: "Say OK" }],
          }),
        },
      );
      assert.equal(response.status, 200, await response.text());
      const sent = observed.at(-1);
      assert.equal(sent.path, "/v1/chat/completions");
      // The Go credential travels upstream, and the session header OpenCode
      // requires to route the request travels with it.
      assert.equal(sent.auth, "Bearer test-opencode-go-key");
      assert.equal(typeof sent.session, "string");
      assert.ok(sent.session.length > 0);
      assert.equal(sent.body.model, model.upstreamModel);
    }
  } finally {
    child.kill();
    await new Promise((resolve) =>
      child.exitCode !== null ? resolve() : child.once("exit", resolve),
    );
    upstream.closeAllConnections();
    await new Promise((resolve) => upstream.close(resolve));
  }
});
