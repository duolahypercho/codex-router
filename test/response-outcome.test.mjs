import assert from "node:assert/strict";
import test from "node:test";
import { ResponseOutcomeObserver, responseOutcomeFromPayload, resolveGenerationOutcome, usageEventSucceeded } from "../src/response-outcome.mjs";

test("generation terminals, embedded status and unknown envelopes are classified conservatively", () => {
  for (const [payload, expected] of [
    [{ type: "response.completed", response: { status: "completed" } }, "completed"],
    [{ type: "response.completed", response: { status: "failed" } }, "failed"],
    [{ type: "response.completed", response: { status: "incomplete" } }, "incomplete"],
    [{ type: "response.completed", response: { status: "future_status" } }, "indeterminate"],
    [{ type: "response.failed" }, "failed"],
    [{ type: "error" }, "failed"],
    [{ type: "response.cancelled" }, "canceled"],
    [{ object: "response", output: [], status: "in_progress" }, "indeterminate"],
    [{ object: "response", output: [] }, "indeterminate"],
    [{ output: [], status: "completed" }, "completed"],
    [{ choices: [{ finish_reason: "length" }] }, "incomplete"],
    [{ choices: [{ finish_reason: "tool_calls" }] }, "completed"],
    [{ type: "response.output_text.delta", delta: "looks complete" }, undefined],
  ]) assert.equal(responseOutcomeFromPayload(payload), expected, JSON.stringify(payload));
});

test("one attempt cannot erase its failure but a distinct attempt has an independent outcome", () => {
  const observer = new ResponseOutcomeObserver();
  observer.observe({ type: "response.failed" });
  observer.observe({ type: "response.completed" });
  assert.equal(observer.outcome(), "failed");
  observer.reset();
  observer.observe({ type: "response.completed" });
  assert.equal(observer.outcome(), "completed");
  assert.equal(resolveGenerationOutcome({ observed: "completed", status: 200, failed: true }), "failed");
  assert.equal(resolveGenerationOutcome({ observed: "failed", status: 0, canceled: true }), "failed");
  assert.equal(resolveGenerationOutcome({ status: 200, expectsTerminal: true }), "indeterminate");
  assert.equal(resolveGenerationOutcome({ status: 0 }), "canceled");
});

test("success aggregates prefer protocol outcomes without rewriting historical evidence", () => {
  assert.equal(usageEventSucceeded({ status: 200, generationOutcome: "failed" }), false);
  assert.equal(usageEventSucceeded({ status: 200, generationOutcome: "indeterminate" }), false);
  assert.equal(usageEventSucceeded({ status: 200, generationOutcome: "completed" }), true);
  assert.equal(usageEventSucceeded({ status: 200, streamAborted: true }), false);
  assert.equal(usageEventSucceeded({ status: 200 }), true);
});
