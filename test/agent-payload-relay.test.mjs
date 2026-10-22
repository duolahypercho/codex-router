import assert from "node:assert/strict";
import test from "node:test";
import { agentRelayHeaders, parseAgentRelayResponse } from "../src/agent-payload-relay.mjs";
const item = { type: "function_call", id: "fc_relay", call_id: "call_relay", name: "relay_external_agent_payload", arguments: JSON.stringify({ payload: "exact\n task\t " }) };
const done = { type: "response.completed", response: { status: "completed", output: [] } };
const added = { type: "response.output_item.added", item: { ...item, arguments: "" } };
const args = { type: "response.function_call_arguments.done", item_id: item.id, arguments: item.arguments };
const sse = events => Buffer.from(events.map(e => `event: ${e.type}\r\ndata: ${JSON.stringify(e)}\r\n\r\n`).join("") + "data: [DONE]\r\n\r\n");
const fails = (events, code) => assert.throws(() => parseAgentRelayResponse(sse(events)), { code: `ERR_NATIVE_AGENT_RELAY_${code}` });

test("relay isolates transport dialect and turn affinity while preserving credentials", () => {
  const original = { authorization: "Bearer synthetic", "chatgpt-account-id": "synthetic-account", "Content-Type": "application/json", "Accept-Encoding": "identity", "x-openai-internal-codex-responses-lite": "true", "x-codex-turn-state": "caller-state", "session_id": "caller-session", "x-openai-subagent": "review" };
  assert.deepEqual(agentRelayHeaders(original), { authorization: original.authorization, "chatgpt-account-id": original["chatgpt-account-id"], "Content-Type": "application/json", "Accept-Encoding": "identity" });
  assert.equal(original["x-openai-internal-codex-responses-lite"], "true");
});
test("completed relay preserves exact payload and accepts mislabeled SSE", () => {
  assert.equal(parseAgentRelayResponse(sse([added, args, done]), "application/octet-stream"), "exact\n task\t ");
  assert.equal(parseAgentRelayResponse(sse([{ type: "response.completed", response: { status: "completed", output: [item] } }])), "exact\n task\t ");
  assert.equal(parseAgentRelayResponse(Buffer.from(JSON.stringify({ status: "completed", output: [item] }))), "exact\n task\t ");
});
test("SSE event name supplies a missing JSON type", () => {
  const bytes = Buffer.from(`event: response.completed\ndata: ${JSON.stringify({ response: { status: "completed", output: [item] } })}\n\n`);
  assert.equal(parseAgentRelayResponse(bytes), "exact\n task\t ");
});
test("a later failed terminal wins over an already complete payload", () => {
  for (const event of [{ type: "response.failed", response: { error: { code: "internal_error", message: "PRIVATE TASK" } } }, { type: "error", error: { message: "PRIVATE TASK" } }]) {
    fails([added, args, event], "UPSTREAM_FAILED");
    try { parseAgentRelayResponse(sse([added, args, event])); } catch (e) { assert.doesNotMatch(String(e), /PRIVATE TASK|exact/); }
  }
});
test("incomplete and silently closed responses cannot populate the relay cache", () => {
  fails([added, args], "INCOMPLETE");
  fails([added, args, { type: "response.incomplete", response: { status: "incomplete" } }], "INCOMPLETE");
  fails([added, { type: "response.function_call_arguments.delta", item_id: item.id, delta: item.arguments }], "INCOMPLETE");
});
test("SSE rate and auth failures preserve actionable status without provider text", () => {
  for (const [code, status, expected] of [["rate_limit_exceeded", 429, "RATE_LIMITED"], ["usage_limit_reached", 429, "RATE_LIMITED"], ["token_expired", 401, "UNAUTHORIZED"]]) {
    assert.throws(() => parseAgentRelayResponse(sse([{ type: "error", error: { code, message: "secret" } }])), { status, code: `ERR_NATIVE_AGENT_RELAY_${expected}` });
  }
});
test("unrelated arguments and multiple task calls are refused", () => {
  fails([{ ...added, item: { ...item, name: "unrelated" } }, args, done], "MISSING_PAYLOAD");
  fails([{ type: "response.completed", response: { output: [item, { ...item, id: "fc_other", call_id: "call_other" }] } }], "AMBIGUOUS_PAYLOAD");
  fails([added, { ...args, item_id: "fc_other" }, done], "INVALID_ARGUMENTS");
});
test("invalid task shape and malformed events are diagnosed safely", () => {
  for (const argumentsText of ['{}', '{"payload":3}', '{"payload":"ok","extra":true}', 'invalid']) {
    fails([added, { ...args, arguments: argumentsText }, done], "INVALID_ARGUMENTS");
  }
  assert.throws(() => parseAgentRelayResponse(Buffer.from('event: response.completed\ndata: invalid\n\n')), { code: "ERR_NATIVE_AGENT_RELAY_INVALID_STREAM" });
});

test("JSON relay requires a completed response and validates envelope shape", () => {
  for (const status of [undefined, "in_progress", "queued", "cancelled", "incomplete"]) {
    assert.throws(() => parseAgentRelayResponse(Buffer.from(JSON.stringify({ status, output: [item] }))), { code: "ERR_NATIVE_AGENT_RELAY_INCOMPLETE" });
  }
  for (const body of [null, [], { status: "completed", output: {} }, { response: { status: "completed", output: "private" } }]) {
    assert.throws(() => parseAgentRelayResponse(Buffer.from(JSON.stringify(body)), null), { code: "ERR_NATIVE_AGENT_RELAY_INVALID_STREAM" });
  }
});

test("a completed SSE event cannot conceal a noncompleted response status", () => {
  for (const status of ["queued", "in_progress", "cancelled"]) {
    fails([{ type: "response.completed", response: { status, output: [item] } }], "INCOMPLETE");
  }
});

test("outer JSON errors cannot be concealed by an inner completed response", () => {
  const body = { error: { code: "rate_limit_exceeded", message: "PRIVATE" }, response: { status: "completed", output: [item] } };
  assert.throws(() => parseAgentRelayResponse(Buffer.from(JSON.stringify(body))), { status: 429, code: "ERR_NATIVE_AGENT_RELAY_RATE_LIMITED" });
});

test("relay snapshots extend the observed argument prefix without replacing task bytes", () => {
  const prefix = item.arguments.slice(0, 10);
  const partial = { ...added, item: { ...item, arguments: prefix } };
  const delta = { type: "response.function_call_arguments.delta", item_id: item.id, delta: item.arguments.slice(10, 15) };
  assert.equal(parseAgentRelayResponse(sse([partial, delta, args, { type: "response.output_item.done", item }, { ...done, response: { status: "completed", output: [item] } }])), "exact\n task\t ");
  const conflicting = JSON.stringify({ payload: "PRIVATE_REPLACEMENT" });
  const snapshots = [
    { ...added, item: { ...item, arguments: conflicting } },
    { ...args, arguments: conflicting },
    { type: "response.output_item.done", item: { ...item, arguments: conflicting } },
    { ...done, response: { status: "completed", output: [{ ...item, arguments: conflicting }] } },
  ];
  for (const event of snapshots) {
    fails([partial, delta, args, event, done], "CONFLICTING_ARGUMENTS");
  }
  fails([partial, delta, { ...args, arguments: prefix }, done], "CONFLICTING_ARGUMENTS");
});
