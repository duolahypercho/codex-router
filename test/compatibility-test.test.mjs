import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";

import { renderCheckpoint } from "../src/compaction-checkpoint.mjs";
import { EXACT_ROUTE_PROBE_HEADER } from "../src/exact-route-probe.mjs";
import { compatibilityTest } from "../src/compatibility-test.mjs";

function jsonResponse(response, payload) {
  response.writeHead(200, { "Content-Type": "application/json" });
  response.end(JSON.stringify(payload));
}

async function bodyJson(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function compactResponse(body, echoMarker) {
  const inputText = body.input?.[0]?.content?.[0]?.text || "";
  const marker = inputText.match(/CODEX_ROUTER_COMPACT_[0-9a-f]{32}/u)?.[0] || "";
  const checkpoint = {
    version: 2,
    orientation: {
      objective: echoMarker ? marker : "",
      unverified: [],
      unknowns: [],
      blockers: [],
      next_step: "",
    },
    source_refs: { requirements: [], attempts: [], observations: [] },
    sources: {},
    recent_tail: [],
    recent_tail_truncated: false,
    counters: { U: 1, A: 1, C: 1, R: 1 },
  };
  return {
    output: [
      body.input[0],
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: renderCheckpoint(checkpoint) }],
      },
    ],
  };
}

async function startCompatibilityServer({
  echoToolResult = true,
  echoCompactionMarker = true,
} = {}) {
  const requests = [];
  const server = http.createServer(async (request, response) => {
    const body = await bodyJson(request);
    requests.push({ path: request.url, headers: request.headers, body });
    if (request.url.endsWith("/responses/compact")) {
      jsonResponse(response, compactResponse(body, echoCompactionMarker));
      return;
    }
    if (body.stream) {
      response.writeHead(200, { "Content-Type": "text/event-stream" });
      response.end([
        `data: ${JSON.stringify({ type: "response.output_text.delta", delta: "CODEX_ROUTER_STREAM_OK" })}`,
        "",
        `data: ${JSON.stringify({ type: "response.completed", response: { id: "resp-stream" } })}`,
        "",
        "data: [DONE]",
        "",
      ].join("\n"));
      return;
    }
    if (body.tool_choice === "required") {
      jsonResponse(response, {
        output: [{
          type: "function_call",
          name: "codex_router_probe",
          call_id: "call-probe",
          arguments: "{\"value\":\"ok\"}",
        }],
      });
      return;
    }
    if (Array.isArray(body.input)) {
      const toolResult = body.input.find((item) => item?.type === "function_call_output");
      jsonResponse(response, {
        output: [{
          type: "message",
          content: [{
            type: "output_text",
            text: echoToolResult ? toolResult?.output : "generic non-empty answer",
          }],
        }],
      });
      return;
    }
    jsonResponse(response, {
      output: [{
        type: "message",
        content: [{ type: "output_text", text: "CODEX_ROUTER_SMOKE_OK" }],
      }],
    });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return {
    requests,
    url: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
}

test("routed compatibility certification covers all five exact-route surfaces", async () => {
  const mock = await startCompatibilityServer();
  const previousBaseUrl = process.env.CODEX_ROUTER_BASE_URL;
  process.env.CODEX_ROUTER_BASE_URL = mock.url;
  try {
    const result = await compatibilityTest("ollama-cloud/glm-5.3", {
      reasoningEffort: "medium",
    });
    assert.equal(result.ok, true);
    assert.deepEqual(result.results.map((entry) => entry.name), [
      "basic response",
      "streaming",
      "tool calling",
      "stateless tool result",
      "compaction",
    ]);
    assert.equal(mock.requests.length, 5);
    assert.equal(
      mock.requests.every((entry) => entry.headers[EXACT_ROUTE_PROBE_HEADER] === "1"),
      true,
    );
    assert.deepEqual(mock.requests.map((entry) => entry.path), [
      "/responses",
      "/responses",
      "/responses",
      "/responses",
      "/responses/compact",
    ]);
    for (const entry of mock.requests) {
      assert.equal(entry.body.model, "ollama-cloud/glm-5.3");
      assert.equal(entry.body.reasoning.effort, "medium");
      assert.equal(entry.body.reasoning_effort, "medium");
    }
    assert.deepEqual(
      mock.requests[3].body.input.map((item) => item.type),
      ["message", "function_call", "function_call_output"],
    );
    const statelessInput = mock.requests[3].body.input;
    const marker = statelessInput[2].output;
    assert.match(marker, /^CODEX_ROUTER_TOOL_RESULT_[0-9a-f]{32}$/);
    assert.equal(JSON.stringify(statelessInput.slice(0, 2)).includes(marker), false);
  } finally {
    if (previousBaseUrl === undefined) delete process.env.CODEX_ROUTER_BASE_URL;
    else process.env.CODEX_ROUTER_BASE_URL = previousBaseUrl;
    await mock.close();
  }
});

test("compatibility certification rejects a nonempty answer that ignores the tool result", async () => {
  const mock = await startCompatibilityServer({ echoToolResult: false });
  const previousBaseUrl = process.env.CODEX_ROUTER_BASE_URL;
  process.env.CODEX_ROUTER_BASE_URL = mock.url;
  try {
    const result = await compatibilityTest("ollama-cloud/glm-5.3", { quick: false });
    assert.equal(result.ok, false);
    const stateless = result.results.find((entry) => entry.name === "stateless tool result");
    assert.equal(stateless?.ok, false);
    assert.equal(stateless?.detail, "stateless tool-result marker missing");
  } finally {
    if (previousBaseUrl === undefined) delete process.env.CODEX_ROUTER_BASE_URL;
    else process.env.CODEX_ROUTER_BASE_URL = previousBaseUrl;
    await mock.close();
  }
});

test("compatibility certification rejects replay-only compaction output", async () => {
  const mock = await startCompatibilityServer({ echoCompactionMarker: false });
  const previousBaseUrl = process.env.CODEX_ROUTER_BASE_URL;
  process.env.CODEX_ROUTER_BASE_URL = mock.url;
  try {
    const result = await compatibilityTest("ollama-cloud/glm-5.3", { quick: false });
    assert.equal(result.ok, false);
    const compact = result.results.find((entry) => entry.name === "compaction");
    assert.equal(compact?.ok, false);
    assert.equal(compact?.detail, "compaction checkpoint objective marker missing");
    const compactResponseBody = compactResponse(mock.requests[4].body, false);
    assert.match(
      JSON.stringify(compactResponseBody),
      /CODEX_ROUTER_COMPACT_[0-9a-f]{32}/u,
      "negative control must contain the replayed input that fooled the old oracle",
    );
  } finally {
    if (previousBaseUrl === undefined) delete process.env.CODEX_ROUTER_BASE_URL;
    else process.env.CODEX_ROUTER_BASE_URL = previousBaseUrl;
    await mock.close();
  }
});

test("compatibility certification refuses an unknown effort before spending quota", async () => {
  await assert.rejects(
    compatibilityTest("ollama-cloud/glm-5.3", { reasoningEffort: "extreme" }),
    /Unknown reasoning effort/,
  );
});
