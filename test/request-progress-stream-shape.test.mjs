import assert from "node:assert/strict";
import test from "node:test";

import { createRequestProgress } from "../src/request-progress.mjs";

// Isolated-build-only diagnostic shape for truncated-stream diagnosis
// (metadata only: event types, completed seen, failure seen, counts).
// Never carries prompts, bodies, tool args, keys, headers, or URLs.

test("stream shape records first/last event and completed seen (metadata only)", () => {
  const tracker = createRequestProgress();
  const request = tracker.begin();
  request.event({ type: "response.created", response: { id: "resp-1" } });
  request.event({ type: "response.output_text.delta", delta: "hello" });
  let snap = tracker.snapshot().active[0];
  assert.equal(snap.firstEventType, "response.created");
  assert.equal(snap.lastEventType, "response.output_text.delta");
  assert.equal(snap.completedSeen, undefined);
  assert.equal(snap.terminalFailureSeen, undefined);
  assert.equal(snap.receivedEvents, 2);
  assert.doesNotMatch(JSON.stringify(snap), /hello/);
  request.event({ type: "response.completed", response: { status: "completed" } });
  snap = tracker.snapshot().active[0];
  assert.equal(snap.lastEventType, "response.completed");
  assert.equal(snap.completedSeen, true);
  request.finish(200);
  assert.equal(tracker.snapshot().recent[0].completedSeen, true);
});

test("truncated stream before completed leaves completed unseen and no terminal", () => {
  const tracker = createRequestProgress();
  const request = tracker.begin();
  request.event({ type: "response.created" });
  request.event({ type: "response.output_text.delta", delta: "partial" });
  request.finish(502);
  const [record] = tracker.snapshot().recent;
  assert.equal(record.firstEventType, "response.created");
  assert.equal(record.lastEventType, "response.output_text.delta");
  assert.equal(record.completedSeen, undefined);
  assert.equal(record.state, "failed");
  assert.equal(record.status, 502);
});

test("terminal failure is flagged separately from completed", () => {
  const tracker = createRequestProgress();
  const request = tracker.begin();
  request.event({ type: "response.failed" });
  request.finish(200);
  const [record] = tracker.snapshot().recent;
  assert.equal(record.terminalEvent, "response.failed");
  assert.equal(record.terminalFailureSeen, true);
  assert.equal(record.completedSeen, undefined);
  assert.equal(record.state, "failed");
});

test("retry clears terminal failure flag like terminal event", () => {
  const tracker = createRequestProgress();
  const request = tracker.begin();
  request.attempt();
  request.event({ type: "response.failed" });
  request.attempt();
  const snap = tracker.snapshot().active[0];
  assert.equal(snap.terminalEvent, undefined);
  assert.equal(snap.terminalFailureSeen, undefined);
  assert.equal(snap.upstreamAttempts, 2);
});

test("unknown upstream event names cannot carry content into diagnostics", () => {
  const tracker = createRequestProgress();
  const request = tracker.begin();
  for (const type of ["private-token-example", "response.private_token_example.delta", "https://secret.example/"]) {
    request.event({ type });
  }
  let snap = tracker.snapshot().active[0];
  assert.equal(snap.firstEventType, undefined);
  assert.equal(snap.lastEventType, undefined);
  assert.doesNotMatch(JSON.stringify(snap), /private|secret/);
  request.event({ type: "response.created" });
  request.event({ type: "another-private-token" });
  snap = tracker.snapshot().active[0];
  assert.equal(snap.firstEventType, "response.created");
  assert.equal(snap.lastEventType, "response.created");
});
