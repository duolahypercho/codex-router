import assert from "node:assert/strict";
import http from "node:http";

const host = "127.0.0.1";
const port = Number(process.env.KIMI_TEST_MOCK_PORT || "45110");
const expectedKey = process.env.KIMI_TEST_EXPECTED_KEY || "TEST_KIMI_API_KEY";
const expectedModel = process.env.KIMI_TEST_EXPECTED_MODEL || "kimi-k3";
const expectedEffort = process.env.KIMI_TEST_EXPECTED_EFFORT || "max";
const expectThinking = process.env.KIMI_TEST_EXPECT_THINKING === "1";

async function readJson(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function json(response, status, payload) {
  const body = Buffer.from(JSON.stringify(payload), "utf8");
  response.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": String(body.length),
  });
  response.end(body);
}

function chunk(id, delta, finishReason = null) {
  return {
    id,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1_000),
    model: expectedModel,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  };
}

const server = http.createServer(async (request, response) => {
  try {
    if (request.method === "GET" && request.url === "/health") {
      json(response, 200, { ok: true });
      return;
    }
    if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
      json(response, 404, { error: { message: "route not found" } });
      return;
    }
    const body = await readJson(request);
    assert.equal(request.headers.authorization, `Bearer ${expectedKey}`);
    assert.equal(request.headers["chatgpt-account-id"], undefined);
    assert.equal(request.headers["x-codex-installation-id"], undefined);
    assert.equal(body.model, expectedModel);
    if (expectedEffort === "none") assert.equal(body.reasoning_effort, undefined);
    else assert.equal(body.reasoning_effort, expectedEffort);
    if (expectThinking) assert.deepEqual(body.thinking, { type: "enabled" });
    console.error(`[mock-kimi-api] validated isolated ${expectedModel} request`);

    if (!body.stream) {
      json(response, 200, {
        id: "chatcmpl-kimi-test",
        object: "chat.completion",
        created: Math.floor(Date.now() / 1_000),
        model: expectedModel,
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: "KIMI_API_REPO_OK" },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      });
      return;
    }

    const id = "chatcmpl-kimi-test";
    response.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    for (const value of [
      chunk(id, { role: "assistant" }),
      chunk(id, { content: "KIMI_API_REPO_OK" }),
      chunk(id, {}, "stop"),
    ]) {
      response.write(`data: ${JSON.stringify(value)}\n\n`);
    }
    response.end("data: [DONE]\n\n");
  } catch (error) {
    console.error(`[mock-kimi-api] ${error instanceof Error ? error.message : String(error)}`);
    if (!response.headersSent) {
      json(response, 400, { error: { message: "mock validation failed" } });
    } else if (!response.writableEnded) {
      response.destroy();
    }
  }
});

server.listen(port, host, () => {
  console.error(`[mock-kimi-api] listening on http://${host}:${port}`);
});
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
