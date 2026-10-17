import assert from "node:assert/strict";
import test from "node:test";
import { grokBridgeRequest } from "../src/grok-request-compat.mjs";
import { GROK_TIMING_HEADER, setGrokTimingRequestId } from "../src/grok-request-timing.mjs";

test("one bridge policy preserves both reasoning forms and owned IDs for tool-free summaries", () => {
  const request = {};
  const id = "01234567-89ab-4cde-8fab-0123456789ab:42";
  setGrokTimingRequestId(request, id);
  for (const policy of [{ reasoning: { effort: "medium", summary: "detailed" } }, { reasoning_effort: "high" }, {}]) {
    const body = { ...policy, tools: [], stream: false, extra_body: { preserved: true },
      extra_headers: { "X-Codex-Router-Request-Id": "forged", preserved: "yes" } };
    const before = structuredClone(body);
    const actual = grokBridgeRequest(body, { provider: "grok-oauth" }, request);
    assert.deepEqual(actual.extra_headers, { preserved: "yes", [GROK_TIMING_HEADER]: id });
    assert.deepEqual(actual.extra_body, { preserved: true,
      ...(policy.reasoning || policy.reasoning_effort ? { reasoning_effort: policy.reasoning ?? policy.reasoning_effort } : {}) });
    assert.deepEqual(body, before);
    assert.deepEqual(actual.tools, []);
    assert.equal(actual.stream, false);
    assert.strictEqual(grokBridgeRequest(body, { provider: "grok-api" }, request), body);
  }
});
