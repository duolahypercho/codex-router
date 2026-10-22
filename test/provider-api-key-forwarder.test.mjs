import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import http from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { openPort } from "./port-pool.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const root = mkdtempSync(path.join(os.tmpdir(), "codex-router-api-key-forwarder-"));
const stateDir = path.join(root, "state");
const credentialStorePath = path.join(stateDir, "provider-credentials.json");
const poolStatePath = path.join(stateDir, "provider-api-key-pools.json");
const internalKey = "test-provider-pool-internal-key-with-length";
process.env.CODEX_HOME = path.join(root, "codex");
process.env.CODEX_ROUTER_STATE_DIR = stateDir;
process.env.MODEL_ROUTER_PROVIDER_CREDENTIAL_STORE = credentialStorePath;
process.env.MODEL_ROUTER_PROVIDER_CREDENTIAL_MIGRATIONS = path.join(stateDir, "migrations", "provider-credentials");
process.env.MODEL_ROUTER_API_KEY_POOL_PATH = poolStatePath;

const { addEnvironmentCredentialToPool } = await import("../src/provider-api-key-control.mjs");
const { readProviderApiKeyPoolState } = await import("../src/provider-api-key-pool.mjs");
const { readRateLimitSnapshots } = await import("../src/rate-limit-state.mjs");

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return server.address().port;
}

async function waitForHealth(baseUrl, child, stderr) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`forwarder exited: ${stderr()}`);
    try {
      const response = await fetch(`${baseUrl}/health`, {
        headers: { Authorization: `Bearer ${internalKey}` },
      });
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  throw new Error(`forwarder never became healthy: ${stderr()}`);
}

test.after(() => rmSync(root, { recursive: true, force: true }));

test("pooled keys rotate on 429 and relay success despite invalid reset headers", async () => {
  for (const environmentName of ["OPENCODE_API_KEY", "OPENCODE_GO_API_KEY"]) {
    await addEnvironmentCredentialToPool("opencode-go", environmentName, {
      credentialStorePath,
      poolStatePath,
    });
  }

  const authorizations = [];
  const upstream = http.createServer((request, response) => {
    const authorization = request.headers.authorization;
    authorizations.push(authorization);
    request.resume();
    request.once("end", () => {
      if (authorizations.length === 1) {
        response.writeHead(429, {
          "Content-Type": "application/json",
          "Retry-After": "137",
          "X-RateLimit-Limit-Requests": "100",
          "X-RateLimit-Remaining-Requests": "0",
          "X-RateLimit-Reset-Requests": "137",
        });
        response.end(JSON.stringify({ error: { message: "rate limited" } }));
        return;
      }
      response.writeHead(200, {
        "Content-Type": "application/json",
        "X-RateLimit-Limit-Requests": "100",
        "X-RateLimit-Remaining-Requests": "73",
        // Passive telemetry must not discard an already successful paid call.
        "X-RateLimit-Reset-Requests": "8640000000000001",
        "Retry-After": "1e20",
        // Token headers remain provider-level telemetry; assigning them to a
        // pooled key would conflate a different quota unit.
        "X-RateLimit-Limit-Tokens": "9000",
        "X-RateLimit-Remaining-Tokens": "8000",
        "X-RateLimit-Reset-Tokens": `${"9".repeat(309)}h`,
      });
      response.end(JSON.stringify({
        id: "chatcmpl_pool_success",
        object: "chat.completion",
        model: "mimo-v2.5",
        choices: [{ index: 0, message: { role: "assistant", content: "SECOND_KEY_OK" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }));
    });
  });
  const upstreamPort = await listen(upstream);
  const forwarderPort = await openPort();
  const child = spawn(process.execPath, [path.join(repoRoot, "src", "api-forwarder.mjs")], {
    cwd: repoRoot,
    env: {
      ...process.env,
      MODEL_ROUTER_TARGET: "codex",
      MODEL_ROUTER_INTERNAL_KEY: internalKey,
      MODEL_ROUTER_API_PORT: String(forwarderPort),
      MODEL_ROUTER_STATE_DIR: stateDir,
      MODEL_ROUTER_PROVIDER_CREDENTIAL_STORE: credentialStorePath,
      MODEL_ROUTER_API_KEY_POOL_PATH: poolStatePath,
      MODEL_ROUTER_QUIET: "1",
      OPENCODE_GO_BASE_URL: `http://127.0.0.1:${upstreamPort}/v1`,
      OPENCODE_API_KEY: "POOL_KEY_ONE",
      OPENCODE_GO_API_KEY: "POOL_KEY_TWO",
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  child.stderr.setEncoding("utf8");
  let errors = "";
  child.stderr.on("data", (chunk) => { errors += chunk; });

  try {
    const baseUrl = `http://127.0.0.1:${forwarderPort}`;
    await waitForHealth(baseUrl, child, () => errors);
    const response = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${internalKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "opencode-go-mimo-v2-5",
        messages: [{ role: "user", content: "test" }],
      }),
    });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).choices[0].message.content, "SECOND_KEY_OK");
    assert.equal(authorizations.length, 2);
    assert.notEqual(authorizations[0], authorizations[1]);
    assert.deepEqual(new Set(authorizations), new Set(["Bearer POOL_KEY_ONE", "Bearer POOL_KEY_TWO"]));
    const pool = readProviderApiKeyPoolState(poolStatePath).providers["opencode-go"];
    const limited = Object.values(pool.credentials).find((entry) => entry.health.lastStatus === 429);
    const successful = Object.values(pool.credentials).find((entry) => entry.health.lastStatus === 200);
    assert.ok(limited, "the failed credential should retain its own rate-limit outcome");
    assert.ok(successful, "the winning credential should retain its own quota outcome");
    assert.deepEqual(
      { unit: limited.quota.unit, limit: limited.quota.limit, remaining: limited.quota.remaining },
      { unit: "requests", limit: 100, remaining: 0 },
    );
    assert.deepEqual(
      { unit: successful.quota.unit, limit: successful.quota.limit, remaining: successful.quota.remaining },
      { unit: "requests", limit: 100, remaining: 73 },
    );
    assert.equal(successful.quota.resetAt, undefined);
    assert.equal(successful.health.cooldownUntil, undefined);
    // Telemetry is written after the response body is relayed. Wait for the
    // winning observation rather than racing the forwarder's final write.
    let snapshot;
    const snapshotDeadline = Date.now() + 2_000;
    while (Date.now() < snapshotDeadline) {
      snapshot = readRateLimitSnapshots()["opencode-go"];
      if (snapshot?.requests?.remaining === 73) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.ok(snapshot, "the winning response should record its quota counters");
    assert.deepEqual(snapshot.requests, { limit: 100, remaining: 73 });
    assert.deepEqual(snapshot.tokens, { limit: 9000, remaining: 8000 });
    assert.equal(snapshot.retryAt, undefined);
    const cooldownMs = Date.parse(limited.health.cooldownUntil) - Date.now();
    assert.ok(cooldownMs >= 130_000 && cooldownMs <= 140_000, `unexpected cooldown ${cooldownMs}ms`);
  } finally {
    child.kill("SIGTERM");
    if (child.exitCode === null) await new Promise((resolve) => child.once("exit", resolve));
    await new Promise((resolve) => upstream.close(resolve));
  }
});

test("Grok API forwards opt-in Fast and preserves provider-reported tiers in JSON and SSE", async () => {
  const planned = [];
  const captured = [];
  const upstream = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks));
    const plan = planned[captured.length];
    captured.push({ body, authorization: request.headers.authorization });
    const result = { id: "chatcmpl_grok_tier_fixture", object: body.stream ? "chat.completion.chunk" : "chat.completion",
      model: body.model, choices: [], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      provider_specific_fields: { fixture: "retained" },
      ...(plan.reported === undefined ? {} : { service_tier: plan.reported }) };
    if (body.stream) {
      response.writeHead(200, { "Content-Type": "text/event-stream", "x-codex-router-grok-service-tier": "priority" });
      response.write('data: {"choices":[{"index":0,"delta":{"content":"Привет"}}]}\n\n');
      response.end(`data: ${JSON.stringify(result)}\n\ndata: [DONE]\n\n`);
    } else {
      result.choices = [{ index: 0, message: { role: "assistant", content: "Fixture complete." }, finish_reason: "stop" }];
      const bytes = JSON.stringify(result);
      response.writeHead(200, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(bytes),
        "x-codex-router-grok-service-tier": "priority" });
      response.end(bytes);
    }
  });
  const upstreamPort = await listen(upstream);
  const forwarderPort = await openPort();
  const child = spawn(process.execPath, [path.join(repoRoot, "src", "api-forwarder.mjs")], {
    cwd: repoRoot,
    env: { ...process.env, MODEL_ROUTER_TARGET: "codex", MODEL_ROUTER_INTERNAL_KEY: internalKey,
      MODEL_ROUTER_API_PORT: String(forwarderPort), MODEL_ROUTER_QUIET: "1",
      MODEL_ROUTER_API_KEY_POOL_PATH: path.join(root, "grok-tier-pools.json"),
      XAI_API_BASE_URL: `http://127.0.0.1:${upstreamPort}/v1`, XAI_API_KEY: "GROK_API_FIXTURE_KEY",
      OPENCODE_GO_BASE_URL: `http://127.0.0.1:${upstreamPort}/v1`, OPENCODE_GO_API_KEY: "POOL_KEY_TWO" },
    stdio: ["ignore", "ignore", "pipe"],
  });
  child.stderr.setEncoding("utf8");
  let errors = "";
  child.stderr.on("data", chunk => { errors += chunk; });
  const base = `http://127.0.0.1:${forwarderPort}`;
  const send = payload => fetch(`${base}/v1/chat/completions`, { method: "POST",
    headers: { Authorization: `Bearer ${internalKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ messages: [{ role: "user", content: "Synthetic tier fixture." }], ...payload }) });
  try {
    await waitForHealth(base, child, () => errors);
    for (const model of ["grok-api-grok-4-5", "grok-api-grok-4-7"]) for (const stream of [false, true]) {
      for (const [requested, reported, expected] of [
        ["priority", "priority", "priority"], ["priority", "default", "default"],
        ["priority", undefined, undefined], ["default", "future-tier", "unknown"],
        [undefined, "default", "default"],
      ]) {
        planned.push({ reported });
        const response = await send({ model, stream, ...(requested ? { service_tier: requested } : {}) });
        assert.equal(response.status, 200);
        assert.equal(response.headers.get("x-codex-router-grok-service-tier"), stream ? null : expected ?? null);
        assert.equal(captured.at(-1).body.model, model === "grok-api-grok-4-5" ? "grok-4.5" : "grok-4.7");
        assert.equal(captured.at(-1).body.service_tier, requested, "an omitted tier must remain opt-in");
        assert.equal(captured.at(-1).authorization, "Bearer GROK_API_FIXTURE_KEY");
        let result;
        if (stream) {
          assert.match(response.headers.get("content-type"), /text\/event-stream/);
          const text = await response.text();
          assert.match(text, /Привет/);
          assert.ok(text.endsWith("data: [DONE]\n\n"));
          result = JSON.parse(text.split("\n\n")[1].slice(5));
        } else {
          assert.equal(response.headers.get("content-length"), null, "rewritten JSON must not retain the upstream byte count");
          result = await response.json();
        }
        assert.equal(result.provider_specific_fields.grok_service_tier, expected);
        assert.equal(result.provider_specific_fields.fixture, "retained");
        assert.equal(result.service_tier, reported === "future-tier" ? undefined : reported);
      }
    }
    // The compatibility marker belongs only to first-party Grok API traffic.
    planned.push({ reported: "priority" });
    const other = await send({ model: "opencode-go-mimo-v2-5", service_tier: "priority" });
    assert.equal(other.status, 200);
    assert.equal(other.headers.get("x-codex-router-grok-service-tier"), "priority", "unrelated providers retain their existing header policy");
    const untouched = await other.json();
    assert.equal(untouched.service_tier, "priority");
    assert.deepEqual(untouched.provider_specific_fields, { fixture: "retained" });
    assert.equal(captured.length, 21, "every local fixture request is single-shot");
  } finally {
    child.kill("SIGTERM");
    if (child.exitCode === null) await new Promise(resolve => child.once("exit", resolve));
    upstream.closeAllConnections();
    await new Promise(resolve => upstream.close(resolve));
  }
});
