import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";

import {
  createCursorPublicServer,
  cursorPublicBasePath,
  redactCursorPublicUrl,
} from "../src/cursor-public-edge.mjs";
import { cursorModelId } from "../src/cursor-model-id.mjs";

const SECRET = "cursor-public-test-secret-with-sufficient-length";

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(server.address().port));
  });
}

function close(server) {
  return new Promise((resolve) => server.close(resolve));
}

test("Cursor public edge exposes only the secret-bearing app surface", async () => {
  const upstream = http.createServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ output: [] }));
  });
  const upstreamPort = await listen(upstream);
  const edge = createCursorPublicServer({
    publicSecret: SECRET,
    responsesUrl: `http://127.0.0.1:${upstreamPort}/responses`,
    routedModels: () => ({ models: [{ slug: "provider/model" }] }),
  });
  const port = await listen(edge);
  try {
    const prefix = cursorPublicBasePath(SECRET);
    const catalog = await fetch(`http://127.0.0.1:${port}${prefix}/models`);
    assert.equal(catalog.status, 200);
    assert.deepEqual((await catalog.json()).data.map((model) => model.id), [cursorModelId("provider/model")]);
    assert.equal((await fetch(`http://127.0.0.1:${port}/v1/models`)).status, 404);
    assert.equal((await fetch(`http://127.0.0.1:${port}${prefix}/responses`)).status, 404);
    assert.equal(
      redactCursorPublicUrl(`https://edge.example${prefix}`),
      "https://edge.example/_codex-router-cursor/[REDACTED]/v1",
    );
  } finally {
    await Promise.all([close(edge), close(upstream)]);
  }
});
