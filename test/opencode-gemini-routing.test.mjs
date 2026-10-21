import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { openPort } from "./port-pool.mjs";
import {
  ensureOpenCodeGeminiThoughtSignatures,
  isOpenCodeGeminiModel,
  OPENCODE_GEMINI_MODEL,
  OPENCODE_GEMINI_THOUGHT_SIGNATURE_SENTINEL,
  openCodeGeminiModelFromRoute,
} from "../src/opencode-gemini.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const temp = mkdtempSync(path.join(os.tmpdir(), "router-opencode-gemini-"));
const overlay = path.join(temp, "user-models.json");
const credential = path.join(temp, "opencode-go-api-key.secret");
const internal = "test-internal-gemini-key-123456789";
const model = {
  slug: `opencode-go/${OPENCODE_GEMINI_MODEL}`,
  gatewayModel: "opencode-go-gemini-4-argon-contributor",
  upstreamModel: OPENCODE_GEMINI_MODEL,
  provider: "opencode-go",
  listed: true,
  displayName: "Gemini 4 Argon Contributor (OpenCode Go)",
  description: "Test route",
  priority: 100,
  defaultEffort: "high",
  reasoningLevels: [
    { effort: "low", description: "Low" },
    { effort: "medium", description: "Medium" },
    { effort: "high", description: "High" },
  ],
  contextWindow: 1_048_576,
  autoCompact: 890_000,
  inputModalities: ["text", "image"],
  compHash: "opencode-go-gemini-4-argon-contributor-user-v1",
};
writeFileSync(overlay, JSON.stringify({ version: 1, models: [model] }));
writeFileSync(credential, "test-opencode-go-key\n", { mode: 0o600 });
process.env.MODEL_ROUTER_USER_MODELS = overlay;

const { renderLiteLlmConfig } = await import("../src/litellm-config.mjs");
test.after(() => rmSync(temp, { recursive: true, force: true }));

test("OpenCode Gemini renders through the native API forwarder", () => {
  const rendered = renderLiteLlmConfig();
  const deployment = rendered
    .split(`model_name: "${model.gatewayModel}"`)[1]
    .split("  - model_name:")[0];

  assert.equal(isOpenCodeGeminiModel(model), true);
  assert.match(deployment, /model: "gemini\/gemini-4-argon-contributor"/);
  assert.match(
    deployment,
    /api_base: "os\.environ\/CODEX_ROUTER_API_FORWARD_BASE_URL"/,
  );
  assert.match(deployment, /api_key: "os\.environ\/CODEX_ROUTER_INTERNAL_KEY"/);
  assert.match(deployment, /use_chat_completions_api: true/);
});

test("OpenCode Gemini route and tool history get native compatibility repairs", () => {
  const route = `/models/${OPENCODE_GEMINI_MODEL}:streamGenerateContent`;
  assert.equal(openCodeGeminiModelFromRoute(route), OPENCODE_GEMINI_MODEL);
  assert.equal(openCodeGeminiModelFromRoute("/chat/completions"), undefined);

  const payload = {
    contents: [{
      role: "model",
      parts: [{ function_call: { name: "probe", args: { value: "ok" } } }],
    }],
  };
  ensureOpenCodeGeminiThoughtSignatures(payload);
  assert.equal(
    payload.contents[0].parts[0].thought_signature,
    OPENCODE_GEMINI_THOUGHT_SIGNATURE_SENTINEL,
  );
});

test("API forwarder handles the native Gemini route and replaces internal auth", async () => {
  let observed;
  const upstream = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    observed = {
      path: request.url,
      auth: request.headers.authorization,
      googleKey: request.headers["x-goog-api-key"],
      session: request.headers["x-opencode-session"],
      body: JSON.parse(Buffer.concat(chunks)),
    };
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      candidates: [{ content: { role: "model", parts: [{ text: "ok" }] } }],
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
      OPENCODE_GEMINI_BASE_URL:
        `http://127.0.0.1:${upstream.address().port}/v1`,
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

    const body = {
      contents: [{
        role: "model",
        parts: [{ function_call: { name: "probe", args: { value: "ok" } } }],
      }],
    };
    const response = await fetch(
      `http://127.0.0.1:${port}/v1/models/${OPENCODE_GEMINI_MODEL}:generateContent`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-goog-api-key": internal,
        },
        body: JSON.stringify(body),
      },
    );
    assert.equal(response.status, 200, await response.text());
    assert.equal(
      observed.path,
      `/v1/models/${OPENCODE_GEMINI_MODEL}:generateContent`,
    );
    assert.equal(observed.auth, "Bearer test-opencode-go-key");
    assert.equal(observed.googleKey, undefined);
    assert.equal(typeof observed.session, "string");
    assert.ok(observed.session.length > 0);
    assert.equal(
      observed.body.contents[0].parts[0].thought_signature,
      OPENCODE_GEMINI_THOUGHT_SIGNATURE_SENTINEL,
    );
  } finally {
    child.kill();
    await new Promise((resolve) =>
      child.exitCode !== null ? resolve() : child.once("exit", resolve),
    );
    upstream.closeAllConnections();
    await new Promise((resolve) => upstream.close(resolve));
  }
});
