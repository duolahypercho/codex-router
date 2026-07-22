import assert from "node:assert/strict";
import test from "node:test";

import { waitForRouterHealth } from "../src/router-health.mjs";

test("router health waits through a transient startup failure", async () => {
  let requests = 0;
  const health = await waitForRouterHealth({
    target: "codex",
    timeoutMs: 100,
    intervalMs: 1,
    fetchImpl: async () => {
      requests += 1;
      if (requests === 1) throw new Error("connection refused");
      return new Response(JSON.stringify({ service: "codex-router", version: "test" }), {
        status: 200,
      });
    },
  });

  assert.equal(requests, 2);
  assert.equal(health.ok, true);
  assert.equal(health.payload.version, "test");
});

test("router health rejects a different service on the configured port", async () => {
  const health = await waitForRouterHealth({
    target: "codex",
    timeoutMs: 0,
    fetchImpl: async () => new Response(JSON.stringify({ service: "another-router" })),
  });

  assert.equal(health.ok, false);
  assert.match(health.error, /different service/);
});
