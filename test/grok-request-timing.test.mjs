import test from "node:test";
import assert from "node:assert/strict";
import { createGrokRequestTiming, grokTimingHeaders, GROK_TIMING_HEADER, setGrokTimingRequestId } from "../src/grok-request-timing.mjs";

const id = "01234567-89ab-4cde-8fab-0123456789ab:42";
function fixture(layer = "forwarder") {
  let clock = 100;
  const rows = [];
  const timing = createGrokRequestTiming({ layer, requestId: id, now: () => clock,
    wallNow: () => 0, emit: row => rows.push(structuredClone(row)) });
  return { timing, rows, at: value => { clock = 100 + value; } };
}

test("timing separates queue, provider work and held action on a monotonic clock", () => {
  const { timing: t, rows, at } = fixture();
  t.identify("grok-4.7", { effort: "medium", summary: "private text" }, "medium");
  at(2); t.mark("parsedMs"); at(5); t.mark("preparedMs");
  const a = t.attempt(id); at(7); a.mark("queuedMs"); at(27); a.mark("dispatchMs");
  at(32); a.headers(200);
  at(40); a.event({ type: "response.reasoning_text.delta", delta: "private reasoning" });
  at(50); a.event({ type: "response.function_call_arguments.delta", delta: "private arguments" });
  at(51); a.event({ type: "response.output_item.done", item: { type: "function_call", name: "private tool" } });
  at(80); a.event({ type: "response.completed", response: { status: "completed" } }); a.end("stream_end");
  at(82); t.delta({ tool_calls: [{}] }); at(85); t.finish("response_finished", 200);
  t.finish("connection_closed", 200);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].requestId, id);
  assert.equal(rows[0].firstActionMs, 82);
  assert.equal(rows[0].totalMs, 85);
  assert.equal(rows[0].forwardedReasoningEffort, "medium");
  assert.deepEqual(rows[0].attempts[0], { index: 1, upstreamRequestId: id, queuedMs: 7, dispatchMs: 27,
    headersMs: 32, httpStatus: 200, firstEventMs: 40, firstReasoningMs: 40, firstToolMs: 50,
    firstToolReadyMs: 51, terminalMs: 80, terminal: "completed", endMs: 80, outcome: "stream_end" });
  assert.doesNotMatch(JSON.stringify(rows), /private/);
});

test("cancelled and failed attempts remain distinct from a certified response", () => {
  const { timing: t, rows, at } = fixture();
  const first = t.attempt(id); first.mark("dispatchMs"); at(8); first.headers(401); first.end("http_error");
  const second = t.attempt(id); at(10); second.mark("queuedMs"); at(12); t.finish("connection_closed", 200);
  at(99); second.headers(200); second.end("stream_end");
  assert.equal(rows[0].attempts[0].outcome, "http_error");
  assert.equal(rows[0].attempts[1].outcome, "cancelled");
  assert.equal(rows[0].attempts[1].endMs, 12);
  assert.equal(rows[0].attempts[1].dispatchMs, undefined);
});

test("router observes first egress events once and ignores events after terminal", () => {
  const { timing: t, rows, at } = fixture("router");
  at(3); t.event({ type: "response.output_text.delta", delta: "text" });
  at(6); t.event({ type: "response.output_text.delta", delta: "more" });
  at(8); t.event({ object: "response", status: "completed" });
  at(9); t.event({ type: "response.reasoning_text.delta", delta: "late" }); t.finish("response_finished", 200);
  assert.equal(rows[0].firstTextMs, 3);
  assert.equal(rows[0].terminalMs, 8);
  assert.equal(rows[0].firstReasoningMs, undefined);
});

test("diagnostics admit only bounded schema fields and owned correlation headers", () => {
  const { timing: t, rows } = fixture();
  t.identify("private path/token", { effort: "secret" }, "private"); t.mark("private");
  t.kind("private"); t.tools("private", [{ type: "function", name: "private" }]);
  t.parallelTools("private", false);
  t.parallelTools("client", "secret");
  t.parallelTools("gateway", false);
  t.parallelTools("upstream", true);
  t.kind("compaction");
  t.tools("gateway", [{ type: "function", name: "write_stdin", description: "private", parameters: {
    type: "object", properties: { session_id: { type: "integer" }, secret: { const: "private" } },
  } }]);
  for (let i = 0; i < 20; i++) t.attempt("private value").headers(999);
  t.finish("private outcome", 999);
  t.kind("generation"); t.tools("upstream", []);
  t.parallelTools("gateway", true);
  assert.deepEqual(rows[0].parallelToolCalls, { client: null, gateway: false, upstream: true });
  assert.equal(rows[0].attempts.length, 8);
  assert.equal(rows[0].requestKind, "compaction");
  assert.deepEqual(Object.keys(rows[0].toolSurfaces), ["gateway"]);
  assert.deepEqual(rows[0].toolSurfaces.gateway.known.write_stdin.declarations[0].parameters, ["session_id"]);
  assert.equal(rows[0].model, undefined);
  assert.equal(rows[0].requestedReasoningEffort, null);
  assert.doesNotMatch(JSON.stringify(rows), /private|secret/);
  const request = {};
  setGrokTimingRequestId(request, id);
  assert.deepEqual(grokTimingHeaders(request, { "X-Codex-Router-Request-Id": "forged", other: "preserved" }),
    { other: "preserved", [GROK_TIMING_HEADER]: id });
  assert.equal(grokTimingHeaders({}, undefined), undefined);
  const rejected = {};
  setGrokTimingRequestId(rejected, "secret");
  assert.equal(grokTimingHeaders(rejected, undefined), undefined);
});


test("native client search records tool readiness after namespace restoration", () => {
  const { timing: t, rows, at } = fixture("router");
  at(3); t.event({ type: "response.output_item.added", item: { type: "tool_search_call" } });
  at(5); t.event({ type: "response.output_item.done", item: { type: "tool_search_call" } });
  at(6); t.event({ type: "response.completed", response: { status: "completed" } });
  t.finish("response_finished", 200);
  assert.equal(rows[0].firstToolMs, 3);
  assert.equal(rows[0].firstToolReadyMs, 5);
  assert.equal(rows[0].terminal, "completed");
});
