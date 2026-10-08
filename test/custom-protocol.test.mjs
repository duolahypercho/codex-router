import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { openPort } from "./port-pool.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const temp = mkdtempSync(path.join(os.tmpdir(), "router-custom-protocol-"));
const overlay = path.join(temp, "models.json");
writeFileSync(overlay, JSON.stringify({ models: [] }));
process.env.MODEL_ROUTER_USER_MODELS = overlay;
const { readRegistryDocument } = await import("../src/model-registry.mjs");
const registry = readRegistryDocument(path.join(root, "config"));
const sample = registry.models.find((m) => m.provider === "custom");
const registryPath = path.join(temp, "registry.json");
const internal = "test-internal-protocol-key-123456789";
const env = { ...process.env, MODEL_ROUTER_REGISTRY: registryPath,
  MODEL_ROUTER_STATE_DIR: temp, CODEX_ROUTER_INTERNAL_KEY: internal,
  TEST_CUSTOM_PROTOCOL_KEY: "test-upstream-only-key" };
test.after(() => rmSync(temp, { recursive: true, force: true }));

function writeRegistry(protocol, baseUrl = "https://example.invalid/v1") {
  const doc = structuredClone(registry);
  const model = doc.models.find((m) => m.slug === sample.slug);
  model.endpoint = { baseUrl, protocol,
    credential: { file: "test.secret", environment: ["TEST_CUSTOM_PROTOCOL_KEY"] } };
  if (protocol === "openai-responses") model.supportedEndpoints = ["/responses"];
  writeFileSync(registryPath, JSON.stringify(doc));
}

test("custom model protocol selects the actual gateway transport without inheriting endpoint identity/auth", () => {
  for (const protocol of [undefined, "openai", "openai-responses", "anthropic"]) {
    writeRegistry(protocol);
    const code = `const r=await import('./src/model-registry.mjs');const c=await import('./src/litellm-config.mjs');const m=r.MODEL_BY_SLUG.get(${JSON.stringify(sample.slug)});console.log(JSON.stringify({p:r.providerForModel(m),e:r.endpointForModel(m),yaml:c.renderLiteLlmConfig()}));`;
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", code], {
      cwd: root, env, encoding: "utf8", windowsHide: true, timeout: 10_000,
    });
    assert.equal(result.status, 0, result.stderr);
    const value = JSON.parse(result.stdout);
    assert.equal(value.p.id, "custom");
    assert.equal(value.p.credential, undefined);
    assert.equal(value.p.directResponses, undefined);
    assert.equal(value.p.protocol, protocol || "openai");
    assert.equal(value.e.id, sample.slug);
    const deployment = value.yaml.split(`model_name: "${sample.gatewayModel}"`)[1].split("  - model_name:")[0];
    assert.ok(deployment.includes(`model: "${protocol === "anthropic" ? "anthropic/" : protocol === "openai-responses" ? "openai/responses/" : "openai/"}${sample.gatewayModel}"`));
    assert.equal(deployment.includes("use_chat_completions_api"), protocol !== "openai-responses");
  }
});

test("custom endpoint protocols are validated before publication", () => {
  for (const protocol of ["typo-responses", "", null, 1, {}, []]) {
    writeRegistry(protocol);
    const result = spawnSync(process.execPath, ["-e", "import('./src/model-registry.mjs')"], {
      cwd: root, env, encoding: "utf8", windowsHide: true, timeout: 10_000,
    });
    assert.equal(result.error, undefined);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /unsupported API protocol/);
  }
});

test("custom Responses endpoint metadata must match its conversational protocol", () => {
  writeRegistry("openai-responses");
  const doc = JSON.parse(readFileSync(registryPath, "utf8"));
  doc.models.find((model) => model.slug === sample.slug).supportedEndpoints = ["/chat/completions"];
  writeFileSync(registryPath, JSON.stringify(doc));
  const result = spawnSync(process.execPath, ["-e", "import('./src/model-registry.mjs')"], {
    cwd: root, env, encoding: "utf8", windowsHide: true, timeout: 10_000,
  });
  assert.equal(result.error, undefined);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /must support its provider's conversational endpoint/);
});

test("custom Responses forwarder sends /responses, preserves tool schema and isolates credentials", async () => {
  let observed;
  const upstream = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    observed = { path: req.url, auth: req.headers.authorization, body: JSON.parse(Buffer.concat(chunks)) };
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ id: "r-test", object: "response", status: "completed", output: [] }));
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  writeRegistry("openai-responses", `http://127.0.0.1:${upstream.address().port}/v1`);
  const port = await openPort();
  const child = spawn(process.execPath, ["src/api-forwarder.mjs"], {
    cwd: root, env: { ...env, CODEX_ROUTER_API_PORT: String(port) },
    stdio: ["ignore", "ignore", "pipe"], windowsHide: true,
  });
  let errors = "";
  child.stderr.on("data", (chunk) => { errors += chunk; });
  try {
    let ready = false;
    for (let i = 0; i < 150; i++) {
      try { ready = (await fetch(`http://127.0.0.1:${port}/health`, { headers: { authorization: `Bearer ${internal}` } })).ok; } catch {}
      if (ready) break;
      if (child.exitCode !== null) throw new Error(errors);
      await new Promise((resolve) => setTimeout(resolve, 40));
    }
    assert.ok(ready, errors);
    const body = { model: `responses/${sample.gatewayModel}`, input: [{ role: "user", content: "test" }],
      tools: [{ type: "function", name: "check", parameters: { type: "object", properties: {} } }], stream: false };
    const response = await fetch(`http://127.0.0.1:${port}/v1/responses`, { method: "POST",
      headers: { authorization: `Bearer ${internal}`, "content-type": "application/json" }, body: JSON.stringify(body) });
    assert.equal(response.status, 200, await response.text());
    assert.equal(observed.path, "/v1/responses");
    assert.equal(observed.auth, "Bearer test-upstream-only-key");
    assert.equal(observed.body.model, sample.upstreamModel);
    assert.deepEqual(observed.body.tools, body.tools);
    assert.ok(observed.body.input);
    assert.equal(observed.body.messages, undefined);
    const wrong = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, { method: "POST",
      headers: { authorization: `Bearer ${internal}`, "content-type": "application/json" }, body: JSON.stringify(body) });
    assert.equal(wrong.status, 400);
  } finally {
    child.kill();
    await new Promise((resolve) => child.exitCode !== null ? resolve() : child.once("exit", resolve));
    upstream.closeAllConnections();
    await new Promise((resolve) => upstream.close(resolve));
  }
});
