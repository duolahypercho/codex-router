// AI/ML API counts a routed request toward Codex Router only when it carries
// the attribution headers, and it must never hand them to anyone else. The
// gate is the destination host, so these tests are written against the real
// registry entry and the real baseUrl override, not a hand-made descriptor:
// what is being held is "the shipped aimlapi provider resolves to the gateway,
// and an override moves attribution with it".
import assert from "node:assert/strict";
import test from "node:test";

import {
  AIMLAPI_SOURCE,
  AIMLAPI_PARTNER_ID,
  aimlapiAttributionHeaders,
  applyAimlapiAttributionHeaders,
  endpointDestination,
  isAimlapiBaseUrl,
} from "../src/aimlapi-attribution.mjs";
import { PROVIDERS } from "../src/model-registry.mjs";

test("the host gate matches api.aimlapi.com exactly", () => {
  for (const url of [
    "https://api.aimlapi.com/v1",
    "https://api.aimlapi.com",
    "https://API.AIMLAPI.COM/v1",
  ]) assert.equal(isAimlapiBaseUrl(url), true, url);

  for (const url of [
    // The suffix cases are the whole reason this is an equality test.
    "https://api.aimlapi.com.example.net/v1",
    "https://notapi.aimlapi.com/v1",
    "https://aimlapi.com/v1",
    "https://openrouter.ai/api/v1",
    "http://127.0.0.1:1234/v1",
    "api.aimlapi.com/v1",
    "",
    undefined,
    null,
  ]) assert.equal(isAimlapiBaseUrl(url), false, String(url));
});

test("the shipped AI/ML API provider attributes its traffic", () => {
  const provider = PROVIDERS.get("aimlapi");
  assert.ok(provider, "the registry must ship an aimlapi provider");
  assert.equal(endpointDestination(provider, {}), "https://api.aimlapi.com/v1");

  const headers = { "User-Agent": "codex-router/test" };
  assert.equal(applyAimlapiAttributionHeaders(headers, { endpoint: provider, env: {} }), true);
  assert.equal(headers["X-AIMLAPI-Source"], AIMLAPI_SOURCE);
  assert.equal(headers["X-Title"], "Codex Router");
  assert.equal(headers["HTTP-Referer"], "https://github.com/duolahypercho/codex-router");
  // An unregistered partner id is silently ignored upstream, so an empty one is
  // sent as nothing at all rather than as a value that looks like it works.
  if (AIMLAPI_PARTNER_ID) {
    assert.match(AIMLAPI_PARTNER_ID, /^part_[A-Za-z0-9]{1,64}$/);
    assert.equal(headers["X-AIMLAPI-Partner-ID"], AIMLAPI_PARTNER_ID);
  } else {
    assert.equal("X-AIMLAPI-Partner-ID" in headers, false);
  }
});

test("attribution follows the destination, not the provider id", () => {
  const aimlapi = PROVIDERS.get("aimlapi");
  const openrouter = PROVIDERS.get("openrouter");

  // Moved off the gateway by its own override: no attribution to a host that
  // is not us.
  const moved = {};
  assert.equal(
    applyAimlapiAttributionHeaders(moved, {
      endpoint: aimlapi,
      env: { AIMLAPI_API_BASE_URL: "https://proxy.example.com/v1" },
    }),
    false,
  );
  assert.deepEqual(moved, {});

  // Another provider pointed at the gateway is our traffic and is attributed.
  const arrived = {};
  assert.equal(
    applyAimlapiAttributionHeaders(arrived, {
      endpoint: openrouter,
      env: { OPENROUTER_API_BASE_URL: "https://api.aimlapi.com/v1" },
    }),
    true,
  );
  assert.equal(arrived["X-AIMLAPI-Source"], AIMLAPI_SOURCE);

  // Left alone, OpenRouter gets nothing.
  const untouched = {};
  assert.equal(
    applyAimlapiAttributionHeaders(untouched, { endpoint: openrouter, env: {} }),
    false,
  );
  assert.deepEqual(untouched, {});
});

test("no other provider in the registry resolves onto the gateway", () => {
  const attributed = [...PROVIDERS.values()]
    .filter((provider) => isAimlapiBaseUrl(endpointDestination(provider, {})))
    .map((provider) => provider.id);
  assert.deepEqual(attributed, ["aimlapi"]);
});

test("the header set is fixed", () => {
  const expected = ["HTTP-Referer", "X-AIMLAPI-Source", "X-Title"];
  if (AIMLAPI_PARTNER_ID) expected.push("X-AIMLAPI-Partner-ID");
  assert.deepEqual(Object.keys(aimlapiAttributionHeaders()).sort(), expected.sort());
});

// Everything above tests the decision. This tests the seam: a real forwarder
// process, the shipped registry entry, and a real HTTP request. It is pointed
// at a local upstream because that is the only destination a test can own --
// which makes it the negative half by construction, and that is the half worth
// automating: a header that leaks to whatever host an override names is the
// failure that would go unnoticed. The positive half is verified live against
// the gateway (see the commit message).
import { spawn } from "node:child_process";
import http from "node:http";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { openPort } from "./port-pool.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const INTERNAL_KEY = "test-internal-service-key-with-sufficient-length";

test("a routed AI/ML API model reaches its upstream, and an override takes attribution with it", async () => {
  const seen = [];
  const upstream = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    seen.push({
      url: request.url,
      headers: request.headers,
      body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
    });
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({
      id: "chatcmpl-test",
      choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
    }));
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));

  const port = await openPort();
  const forwarder = spawn(process.execPath, [path.join(ROOT, "src", "api-forwarder.mjs")], {
    cwd: ROOT,
    env: {
      ...process.env,
      CODEX_ROUTER_INTERNAL_KEY: INTERNAL_KEY,
      CODEX_ROUTER_API_PORT: String(port),
      MODEL_ROUTER_STATE_DIR: mkdtempSync(path.join(os.tmpdir(), "aimlapi-attribution-")),
      CODEX_ROUTER_SHOW_ALL_MODELS: "1",
      CODEX_ROUTER_QUIET: "1",
      AIMLAPI_API_BASE_URL: `http://127.0.0.1:${upstream.address().port}`,
      AIMLAPI_API_KEY: "TEST_AIMLAPI_API_KEY",
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  forwarder.stderr.setEncoding("utf8");
  let errors = "";
  forwarder.stderr.on("data", (chunk) => { errors += chunk; });

  try {
    const deadline = Date.now() + 10_000;
    for (;;) {
      if (forwarder.exitCode !== null) throw new Error(`forwarder exited: ${errors}`);
      try {
        const health = await fetch(`http://127.0.0.1:${port}/health`, {
          headers: { Authorization: `Bearer ${INTERNAL_KEY}` },
        });
        if (health.ok) break;
      } catch {
        // not listening yet
      }
      if (Date.now() > deadline) throw new Error(`forwarder never came up: ${errors}`);
      await new Promise((resolve) => setTimeout(resolve, 50));
    }

    const response = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${INTERNAL_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "aimlapi-gpt-6-sol",
        messages: [{ role: "user", content: "hi" }],
      }),
    });
    assert.equal(response.status, 200, errors);

    assert.equal(seen.length, 1);
    // The registry entry routes, and it sends the gateway's own model id.
    assert.equal(seen[0].body.model, "openai/gpt-6-sol");
    assert.equal(seen[0].headers.authorization, "Bearer TEST_AIMLAPI_API_KEY");
    // Not the gateway, so not a word about who we are.
    for (const name of ["x-aimlapi-source", "x-aimlapi-partner-id", "x-title", "http-referer"]) {
      assert.equal(name in seen[0].headers, false, `${name} leaked to a non-gateway host`);
    }
  } finally {
    forwarder.kill("SIGTERM");
    await new Promise((resolve) => forwarder.once("exit", resolve));
    await new Promise((resolve) => upstream.close(resolve));
  }
});
