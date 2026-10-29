import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { callerBaseUrl } from "../src/caller-auth.mjs";
import { openPort } from "./port-pool.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const parentState = mkdtempSync(path.join(os.tmpdir(), "redirect-parent-"));
const isolated = { MODEL_ROUTER_STATE_DIR: parentState, CODEX_ROUTER_STATE_DIR: parentState,
  MODEL_ROUTER_USER_MODELS: path.join(parentState, "user-models.json") };
const prior = Object.fromEntries(Object.keys(isolated).map(key => [key, process.env[key]]));
Object.assign(process.env, isolated);
test.after(() => {
  for (const [key, value] of Object.entries(prior)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  rmSync(parentState, { recursive: true, force: true });
});
const { readRegistryDocument } = await import("../src/model-registry.mjs");
const { describeImage } = await import("../src/vision-bridge.mjs");
const { generationRedirectRefusal, rejectGenerationRedirect } = await import("../src/generation-redirect.mjs");
const { classifyRoutedFailure } = await import("../src/model-failover.mjs");
const { runProviderApiKeyAttempts, upsertProviderApiKey } = await import("../src/provider-api-key-pool.mjs");
const registry = readRegistryDocument(path.join(root, "config"));
const sample = registry.models.find(model => model.provider === "custom");
const internal = "synthetic-redirect-internal-capability";
const caller = "synthetic-redirect-caller-capability";
const image = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const statuses = [301, 302, 303, 307, 308];
const completed = { id: "resp_redirect_control", object: "response", status: "completed", output: [
  { id: "msg_redirect_control", type: "message", role: "assistant", status: "completed",
    content: [{ type: "output_text", text: "local control", annotations: [] }] },
] };

async function fixture(t) {
  const directory = mkdtempSync(path.join(os.tmpdir(), "generation-redirect-"));
  const servers = [], children = [];
  const observed = { origin: 0, target: 0, models: [], status: 307, unconfiguredApi: 0 };
  t.after(async () => {
    for (const child of children) {
      if (child.exitCode === null && child.signalCode === null) {
        const exited = new Promise(resolve => child.once("exit", resolve));
        child.kill("SIGTERM");
        await exited;
      }
    }
    for (const server of servers) {
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    }
    assert.ok(path.resolve(directory).startsWith(`${path.resolve(os.tmpdir())}${path.sep}`));
    rmSync(directory, { recursive: true, force: true });
    assert.equal(observed.unconfiguredApi, 0, "every direct API request must use the fixture-owned forwarder");
  });
  const listen = async handler => {
    const server = http.createServer(handler);
    servers.push(server);
    await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
    return `http://127.0.0.1:${server.address().port}`;
  };
  // Missing route wiring must fail locally, never reach an installed forwarder.
  const unconfiguredApi = await listen(async (request, response) => {
    for await (const chunk of request) { /* consume only synthetic fixture data */ }
    observed.unconfiguredApi += 1;
    response.writeHead(401, { "content-type": "application/json" });
    response.end('{"error":{"message":"fixture API route was not configured"}}');
  });
  const target = await listen(async (request, response) => {
    for await (const chunk of request) { /* consume any redirected request */ }
    observed.target += 1;
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(completed));
  });
  const origin = await listen(async (request, response) => {
    if (request.method === "GET" && request.url === "/health") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end('{"ok":true,"credential_present":true}');
      return;
    }
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    observed.origin += 1;
    const payload = JSON.parse(Buffer.concat(chunks));
    observed.models.push(payload.model);
    if (payload.model === observed.textModel) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(completed));
      return;
    }
    response.writeHead(observed.status, { location: observed.redirectTarget ?? `${target}/sensitive-location?credential=synthetic-only` });
    response.end("redirect response with synthetic private detail");
  });
  const doc = structuredClone(registry);
  const models = ["openai-responses", "openai", "anthropic"].map((protocol, index) => ({
    ...sample, slug: `custom/redirect-${index}`, gatewayModel: `custom-redirect-${index}`,
    upstreamModel: `redirect-${index}`, inputModalities: ["text"], visionBridge: undefined,
    supportedEndpoints: protocol === "anthropic" ? undefined : [protocol === "openai-responses" ? "/responses" : "/chat/completions"],
    endpoint: { baseUrl: `${origin}/v1`, protocol, keyless: true },
  }));
  // Keep checked-in alias targets valid; only the synthetic models are called.
  doc.models.push(...models);
  const registryPath = path.join(directory, "registry.json");
  writeFileSync(registryPath, JSON.stringify(doc));
  writeFileSync(path.join(directory, "enabled-providers.json"), JSON.stringify({ version: 1, providers: ["custom"] }));
  const environment = { ...process.env };
  for (const key of Object.keys(environment)) if (/^(MODEL_ROUTER_|CODEX_ROUTER_|KIMI_|GROK_|CODEX_NATIVE_)/.test(key)) delete environment[key];
  Object.assign(environment, {
    HOME: directory, USERPROFILE: directory, APPDATA: path.join(directory, "appdata"), LOCALAPPDATA: path.join(directory, "localappdata"),
    CODEX_HOME: path.join(directory, "codex"), MODEL_ROUTER_STATE_DIR: directory, CODEX_ROUTER_STATE_DIR: directory,
    MODEL_ROUTER_REGISTRY: registryPath, MODEL_ROUTER_USER_MODELS: path.join(directory, "user-models.json"),
    MODEL_ROUTER_GENERIC_PROVIDERS: path.join(directory, "generic-providers.json"),
    CODEX_ROUTER_CALLER_KEY: caller, CODEX_ROUTER_INTERNAL_KEY: internal, KIMI_INTERNAL_KEY: internal,
    CODEX_ROUTER_NO_DISCOVERY: "1", CODEX_ROUTER_SHOW_ALL_MODELS: "1", CODEX_ROUTER_QUIET: "1",
    CODEX_ROUTER_GATEWAY_BASE_URL: `${origin}/v1`, CODEX_NATIVE_BASE_URL: origin,
    CODEX_ROUTER_API_BASE_URL: `${unconfiguredApi}/v1`, CODEX_ROUTER_API_HEALTH_URL: `${unconfiguredApi}/health`,
  });
  mkdirSync(environment.CODEX_HOME);
  async function start(script, overrides = {}) {
    const port = await openPort();
    const child = spawn(process.execPath, [`src/${script}.mjs`], { cwd: root,
      env: { ...environment, ...overrides, CODEX_ROUTER_PORT: String(port), CODEX_ROUTER_API_PORT: String(port) },
      stdio: ["ignore", "ignore", "pipe"], windowsHide: true });
    children.push(child);
    let errors = "";
    child.stderr.on("data", chunk => { errors += chunk; observed.childErrors = errors; });
    const base = script === "router" ? callerBaseUrl(port, caller) : `http://127.0.0.1:${port}/v1`;
    const deadline = Date.now() + 30_000;
    let ready = false;
    while (Date.now() < deadline) {
      assert.equal(child.exitCode, null, errors);
      try {
        const url = script === "router" ? `${base}/models` : `http://127.0.0.1:${port}/health`;
        const response = await fetch(url, { headers: { authorization: `Bearer ${internal}` }, signal: AbortSignal.timeout(500) });
        if (response.ok) { ready = true; break; }
      } catch { /* wait for the owned child's listener */ }
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    assert.ok(ready, errors);
    return base;
  }
  return { directory, origin, observed, models, registryPath, doc, start };
}

test("API generation redirects never reach the second origin or expose its Location", { timeout: 60_000 }, async t => {
  const f = await fixture(t);
  const base = await f.start("api-forwarder");
  for (const [index, endpoint] of [[0, "/responses"], [1, "/chat/completions"], [2, "/messages"]]) {
    for (const status of statuses) {
      f.observed.status = status;
      const before = f.observed.origin;
      const payload = { model: `${index === 0 ? "responses/" : ""}${f.models[index].gatewayModel}`, stream: false,
        ...(index === 0 ? { input: [{ role: "user", content: "local redirect regression" }] }
          : { max_tokens: 10, messages: [{ role: "user", content: "local redirect regression" }] }) };
      const response = await fetch(base + endpoint, { method: "POST", redirect: "manual",
        headers: { authorization: `Bearer ${internal}`, "content-type": "application/json" },
        body: JSON.stringify(payload), signal: AbortSignal.timeout(5_000) });
      const body = await response.text();
      assert.equal(response.status, 400, `${endpoint}/${status}: ${body}`);
      assert.equal(response.headers.get("location"), null);
      assert.match(body, /final API endpoint/);
      assert.equal(classifyRoutedFailure({ status: response.status, bodyText: body }).swap, false);
      assert.doesNotMatch(body, /sensitive-location|synthetic-only|private detail/);
      assert.equal(f.observed.origin, before + 1);
      assert.equal(f.observed.target, 0);
    }
  }
});

test("routed generation redirects do not replay a consumed request", { timeout: 60_000 }, async t => {
  const f = await fixture(t);
  const base = await f.start("router");
  for (const status of statuses) {
    f.observed.status = status;
    const before = f.observed.origin;
    const response = await fetch(`${base}/responses`, { method: "POST", redirect: "manual",
      headers: { "content-type": "application/json" }, body: JSON.stringify({ model: f.models[1].slug, stream: false, input: "local only" }),
      signal: AbortSignal.timeout(5_000) });
    const body = await response.text();
    assert.equal(response.status, 502, body);
    assert.equal(response.headers.get("location"), null);
    assert.doesNotMatch(body, /sensitive-location|synthetic-only/);
    assert.equal(f.observed.origin, before + 1);
    assert.equal(f.observed.target, 0);
  }
});

test("local native and gateway vision redirects submit once and refuse the target", { timeout: 30_000 }, async t => {
  const f = await fixture(t);
  for (const engine of [
    { slug: "local/redirect", gatewayModel: "local-redirect", local: true, baseUrl: `${f.origin}/v1` },
    { slug: "gpt-vision-redirect", gatewayModel: "gpt-vision-redirect", native: true },
    { slug: "custom/vision-redirect", gatewayModel: "vision-redirect" },
  ]) {
    for (const status of statuses) {
      f.observed.status = status;
      const before = f.observed.origin;
      await assert.rejects(describeImage({ engine, imageUrl: image, gatewayBase: `${f.origin}/v1`,
        nativeCall: { baseUrl: f.origin, headers: { authorization: "Bearer synthetic-native-session" } },
        headers: { "content-type": "application/json" } }),
      error => error.code === "upstream_redirect_refused" && !/sensitive-location|synthetic-only/.test(error.message));
      assert.equal(f.observed.origin, before + 1, `${engine.slug}/${status}`);
      assert.equal(f.observed.target, 0);
    }
  }
});

test("a refused redirect target cannot make the Router replay through the API forwarder", { timeout: 30_000 }, async t => {
  const f = await fixture(t);
  writeFileSync(path.join(f.directory, "compatibility-layer.json"), JSON.stringify({ version: 1, enabled: false }));
  f.observed.redirectTarget = `http://127.0.0.1:${await openPort()}/v1/responses`;
  const api = await f.start("api-forwarder");
  const base = await f.start("router", {
    CODEX_ROUTER_API_BASE_URL: api, CODEX_ROUTER_API_HEALTH_URL: new URL("/health", api).href,
  });
  const response = await fetch(`${base}/responses`, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: f.models[0].slug, stream: false, input: "local consumed POST regression" }),
    signal: AbortSignal.timeout(10_000) });
  const body = await response.text();
  assert.equal(f.observed.origin, 1, "a failure connecting to the redirect destination cannot replay the consumed first POST");
  assert.equal(response.status, 400, body);
  assert.equal(f.observed.target, 0);
});

test("a vision read does not repeat an API forwarder's encoded redirect refusal", { timeout: 30_000 }, async t => {
  const f = await fixture(t);
  const base = await f.start("api-forwarder");
  await assert.rejects(describeImage({ engine: f.models[0], imageUrl: image,
    gatewayBase: base, headers: { authorization: `Bearer ${internal}`, "content-type": "application/json" } }),
  error => {
    assert.equal(f.observed.origin, 1, "an encoded redirect refusal must not retry its origin");
    return error.code === "upstream_redirect_refused" && error.status === 400;
  });
  assert.equal(f.observed.target, 0);
});

test("an encoded refusal stays sanitized and ordinary errors retain their classification", () => {
  for (const body of ["not JSON", "null", "42", "{}", '{"error":{"type":"provider_api_proxy_error"}}']) {
    assert.equal(generationRedirectRefusal(body), undefined);
  }
  const error = generationRedirectRefusal(JSON.stringify({ error: { type: "provider_redirect_refused",
    message: "synthetic private body", location: "https://private.example.test/?token=synthetic-only" } }));
  assert.equal(error.code, "upstream_redirect_refused");
  assert.equal(error.status, 502);
  assert.doesNotMatch(error.message, /private|synthetic-only/);
});

test("a redirected vision read does not try another engine", { timeout: 30_000 }, async t => {
  const f = await fixture(t);
  for (const model of f.doc.models) model.inputModalities = ["text"];
  for (const model of f.models) {
    model.endpoint.protocol = "openai-responses";
    model.supportedEndpoints = ["/responses"];
  }
  for (const model of f.models.slice(0, 2)) model.inputModalities = ["text", "image"];
  writeFileSync(f.registryPath, JSON.stringify(f.doc));
  writeFileSync(path.join(f.directory, "vision-bridge.json"), JSON.stringify({
    version: 1, enabled: true, engine: f.models[0].slug, effort: null,
  }));
  f.observed.textModel = f.models[2].upstreamModel;
  const api = await f.start("api-forwarder");
  const base = await f.start("router", {
    CODEX_ROUTER_NO_DISCOVERY: "0", CODEX_ROUTER_GATEWAY_BASE_URL: api,
    CODEX_ROUTER_API_BASE_URL: api, CODEX_ROUTER_API_HEALTH_URL: new URL("/health", api).href,
  });
  const response = await fetch(`${base}/responses`, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: f.models[2].slug, stream: false, input: [{ type: "message", role: "user", content: [
      { type: "input_text", text: "read this local synthetic image" }, { type: "input_image", image_url: image },
    ] }] }), signal: AbortSignal.timeout(10_000) });
  const body = await response.text();
  assert.equal(response.status, 200, body);
  assert.equal(f.observed.models.filter(model => model === f.models[0].upstreamModel).length, 1, JSON.stringify(f.observed));
  assert.equal(f.observed.models.filter(model => model === f.models[1].upstreamModel).length, 0, "a consumed vision request must not move to another engine");
  assert.equal(f.observed.models.filter(model => model === f.observed.textModel).length, 1, "the normal text turn still completes with unreadable-image evidence");
  assert.equal(f.observed.target, 0);
});

test("an explicit redirect refusal cannot rotate a key pool", async () => {
  const filePath = path.join(parentState, "redirect-pool.json");
  for (const suffix of ["first", "second"]) await upsertProviderApiKey("openrouter", { id: `cred_redirect_${suffix}` }, { filePath });
  let sends = 0;
  const result = await runProviderApiKeyAttempts("openrouter", { filePath, resolveCredential: id => `synthetic-pool-key-${id}`,
    isResponseCommitted: () => false, backoffMs: 0,
    send: async () => { sends += 1; return rejectGenerationRedirect(new Response(null, { status: 307 })); } });
  assert.equal(sends, 1);
  assert.equal(result.error.code, "upstream_redirect_refused");
  assert.equal(result.attempts.length, 1);
});

test("LiteLLM does not retry an encoded endpoint configuration failure", {
  skip: !process.env.MODEL_ROUTER_TEST_LITELLM_PYTHON, timeout: 60_000,
}, async t => {
  const f = await fixture(t);
  const base = await f.start("api-forwarder");
  const child = spawn(process.env.MODEL_ROUTER_TEST_LITELLM_PYTHON,
    ["-B", path.join(root, "test/fixtures/generation-redirect-litellm.py"), base, f.models[1].gatewayModel],
    { cwd: f.directory, env: { ...process.env, MODEL_ROUTER_TEST_INTERNAL_KEY: internal,
      LITELLM_LOCAL_MODEL_COST_MAP: "True", DO_NOT_TRACK: "1" },
      windowsHide: true, stdio: ["ignore", "pipe", "pipe"], signal: AbortSignal.timeout(45_000) });
  let output = "", errors = "";
  child.stdout.on("data", chunk => { output = (output + chunk).slice(-8_000); });
  child.stderr.on("data", chunk => { errors = (errors + chunk).slice(-8_000); });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill(); });
  const exit = await new Promise((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
  assert.equal(f.observed.origin, 1, `the compatibility layer must not replay a known redirect refusal: ${output}\n${errors}`);
  assert.equal(exit, 0, errors);
  assert.match(output, /"status": 400/);
  assert.equal(f.observed.target, 0);
});
