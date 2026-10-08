import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { childOutput, waitForListeners } from "./listener-readiness.mjs";
import { openPort } from "./port-pool.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const frame = (data) => `event: ${data.type}\ndata: ${JSON.stringify(data)}\n\n`;

test("refusal diagnostics contain bounded model IDs and no request or response content", async () => {
  const state = mkdtempSync(path.join(os.tmpdir(), "responses-refusal-diagnostics-"));
  const internalKey = "private-fixture-internal-key-with-length";
  const apiKey = "private-fixture-provider-key";
  const privateInput = "PRIVATE_REQUEST_CANARY";
  const privateOutput = "PRIVATE_RESPONSE_CANARY";
  const upstreamModel = `fixture\n[forged] ${"x".repeat(300)}`;
  let requests = 0;
  const upstream = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks));
    requests += 1;
    assert.equal(body.model, upstreamModel);
    assert.equal(request.headers.authorization, `Bearer ${apiKey}`);
    assert.ok(body.input.includes(privateInput));
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    const identity = { id: privateOutput, object: "response", model: upstreamModel, status: "in_progress", output: [] };
    response.write(frame({ type: "response.created", response: identity }));
    if (body.input.startsWith("truncated")) { response.end(); return; }
    response.end(frame({ type: "response.completed", response: {
      ...identity, id: body.input.startsWith("invalid") ? "different" : identity.id,
      status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: privateOutput }] }],
    } }));
  });
  let child;
  try {
    const provider = JSON.parse(readFileSync(path.join(repoRoot, "config/meta/meta.json"))).providers[0];
    provider.credential = { ...provider.credential, legacyFiles: [], keychainServices: [] };
    const model = JSON.parse(readFileSync(path.join(repoRoot, "config/meta/muse-spark-1.3.json"))).models[0];
    writeFileSync(path.join(state, "registry.json"), JSON.stringify({ version: 1, providers: [provider], models: [model] }));
    writeFileSync(path.join(state, "user-models.json"), JSON.stringify({ version: 1, models: [{
      ...model, slug: "meta/private-fixture", gatewayModel: "private-fixture", upstreamModel,
      displayName: "Private fixture", compHash: "private-fixture-v1",
    }] }));
    writeFileSync(path.join(state, "enabled-providers.json"), JSON.stringify({ version: 1, providers: ["meta"] }));
    await new Promise((resolve, reject) => {
      upstream.once("error", reject);
      upstream.listen(0, "127.0.0.1", resolve);
    });
    const port = await openPort();
    // All state, credentials and provider traffic belong to this fixture.
    child = spawn(process.execPath, [path.join(repoRoot, "src/api-forwarder.mjs")], {
      cwd: repoRoot,
      env: {
        PATH: process.env.PATH, HOME: state, CODEX_HOME: path.join(state, "codex"),
        MODEL_ROUTER_TARGET: "codex", MODEL_ROUTER_STATE_DIR: state,
        MODEL_ROUTER_REGISTRY: path.join(state, "registry.json"),
        MODEL_ROUTER_USER_MODELS: path.join(state, "user-models.json"),
        MODEL_ROUTER_INTERNAL_KEY: internalKey, MODEL_ROUTER_API_HOST: "127.0.0.1",
        MODEL_ROUTER_API_PORT: String(port), MODEL_ROUTER_QUIET: "1",
        META_BASE_URL: `http://127.0.0.1:${upstream.address().port}/v1`, META_API_KEY: apiKey,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const output = childOutput();
    output.capture("api-forwarder", child);
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    const headers = { Authorization: `Bearer ${internalKey}`, "Content-Type": "application/json" };
    const base = `http://127.0.0.1:${port}`;
    await waitForListeners([{ url: `${base}/health`, headers, name: "api-forwarder" }], { children: [child], output });
    for (const mode of ["invalid", "truncated", "valid"]) {
      const before = stderr.length;
      const response = await fetch(`${base}/v1/responses`, {
        method: "POST", headers, signal: AbortSignal.timeout(5_000),
        body: JSON.stringify({ model: "private-fixture", stream: true, input: `${mode}|${privateInput}` }),
      });
      assert.equal(response.status, 200);
      const body = await response.text();
      if (mode !== "valid") {
        const deadline = Date.now() + 2_000;
        while (!stderr.slice(before).includes("\n") && Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
      }
      const log = stderr.slice(before);
      const lines = log.split(/\r?\n/).filter(Boolean);
      assert.equal(lines.length, mode === "valid" ? 0 : 1);
      if (mode !== "valid") {
        assert.ok(lines[0].includes(`model=${JSON.stringify(upstreamModel.slice(0, 256))}: `));
        assert.ok(lines[0].length < 1_000, "model metadata must not make an unbounded log line");
        assert.doesNotMatch(lines[0], /x{257}/);
      }
      for (const value of [privateInput, privateOutput, internalKey, apiKey]) assert.ok(!log.includes(value));
      assert.ok(!log.includes("\n[forged]"));
      assert.equal(requests, ["invalid", "truncated", "valid"].indexOf(mode) + 1, "logging must not replay the turn");
      if (mode === "invalid") assert.match(body, /invalid_responses_stream/);
      if (mode === "truncated") assert.match(body, /upstream_stream_incomplete/);
      if (mode === "valid") assert.ok(body.includes(privateOutput));
    }
  } finally {
    if (child?.exitCode === null) {
      const exited = once(child, "exit");
      child.kill("SIGTERM");
      await exited;
    }
    upstream.closeAllConnections();
    await new Promise((resolve) => upstream.close(resolve));
    rmSync(state, { recursive: true, force: true });
  }
});
