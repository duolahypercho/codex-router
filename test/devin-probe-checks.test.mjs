import assert from "node:assert/strict";
import test from "node:test";

import { auditMessage, fieldCensus } from "../src/protobuf-audit.mjs";
import {
  DEFAULT_MAX_TOKENS,
  liveTurnChecks,
  modelListChecks,
  parseProbeArgs,
  requestShapeChecks,
  streamFrameChecks,
  toolCallChecks,
} from "../src/devin-probe-checks.mjs";

const statusOf = (checks, name) => checks.find((check) => check.name === name)?.status;
const checkOf = (checks, name) => checks.find((check) => check.name === name);

// The stop-reason value the shipped descriptor set gives for a function call.
const FUNCTION_CALL = 10;

test("the published flags parse, and a defaulted live run is capped", () => {
  const parsed = parseProbeArgs(["--live", "--tools"]);
  assert.equal(parsed.live, true);
  assert.equal(parsed.tools, true);
  assert.equal(parsed.maxTokens, DEFAULT_MAX_TOKENS);
  assert.deepEqual(parsed.unknown, []);
  assert.deepEqual(parsed.errors, []);
});

test("nothing is spent unless --live is typed", () => {
  assert.equal(parseProbeArgs([]).live, false);
  assert.equal(parseProbeArgs(["--tools"]).live, false);
  assert.equal(parseProbeArgs(["--model", "x"]).live, false);
});

test("a mistyped flag is reported instead of quietly skipping the check it asked for", () => {
  // `--tool` used to leave a passing run that never attempted a tool call.
  const parsed = parseProbeArgs(["--live", "--tool"]);
  assert.deepEqual(parsed.unknown, ["--tool"]);
  assert.equal(parsed.tools, false);
});

test("a flag missing its value is an error, not a flag swallowing the next flag", () => {
  const parsed = parseProbeArgs(["--model", "--live"]);
  assert.deepEqual(parsed.errors, ["--model needs a value"]);
  assert.equal(parsed.model, undefined);
  assert.equal(parsed.live, false);
});

test("token and timeout caps refuse values that would remove the cap", () => {
  assert.match(parseProbeArgs(["--max-tokens", "0"]).errors[0], /positive number/);
  assert.match(parseProbeArgs(["--max-tokens", "lots"]).errors[0], /positive number/);
  assert.match(parseProbeArgs(["--timeout", "-3"]).errors[0], /positive number/);
  assert.equal(parseProbeArgs(["--max-tokens", "16"]).maxTokens, 16);
  assert.equal(parseProbeArgs(["--timeout", "30"]).timeoutMs, 30_000);
});

test("an empty model list is a failure, not an 'account advertises 0 models' pass", () => {
  const checks = modelListChecks({ models: [], census: [], httpStatus: 200 });
  assert.equal(statusOf(checks, "model list"), "fail");
  assert.match(checkOf(checks, "model list").observed, /decoded to nothing \(HTTP 200\)/);
});

test("an empty model list names the fields the response actually carried", () => {
  // The exact symptom of a renumbered model_uid: a well-formed response full of
  // fields, none of which this build knows.
  const census = [
    { no: 1, name: undefined, status: "unknown", path: [], wireTypeNames: ["length-delimited"], count: 3, totalBytes: 90 },
  ];
  const checks = modelListChecks({ models: [], census, httpStatus: 200 });
  assert.equal(statusOf(checks, "model list"), "fail");
  assert.match(checkOf(checks, "model list").observed, /field 1 \(length-delimited, 90B over 3\) -> UNKNOWN/);
});

test("a decoded model list passes and reports the entitlement spread", () => {
  const checks = modelListChecks({
    models: [
      { id: "a", premium: true, beta: false },
      { id: "b", premium: false, beta: true },
      { id: "c", premium: false, beta: false },
    ],
    census: [],
  });
  assert.equal(statusOf(checks, "model list"), "pass");
  assert.equal(checkOf(checks, "entitlement flags").detail, "1 premium, 1 beta, 1 standard");
});

test("a model that decoded without a uid fails even when the list is not empty", () => {
  const checks = modelListChecks({ models: [{ id: "a" }, { id: "" }], census: [] });
  assert.equal(statusOf(checks, "model uid field"), "fail");
});

test("a request that does not re-read as protobuf fails before anything is sent", () => {
  const checks = requestShapeChecks({ audit: { truncated: true, error: "truncated varint" }, requiredFields: [] });
  assert.equal(statusOf(checks, "request encoding"), "fail");
  assert.equal(checkOf(checks, "request encoding").observed, "truncated varint");
});

test("a request missing a field the upstream requires is named field by field", () => {
  const schema = { metadata: { no: 1, type: "string" }, chatModelUid: { no: 21, type: "string" } };
  const audit = auditMessage(Uint8Array.from([0x0a, 0x01, 0x61]), schema);
  const checks = requestShapeChecks({ audit, requiredFields: ["metadata", "chatModelUid"] });
  assert.equal(statusOf(checks, "request encoding"), "fail");
  assert.equal(checkOf(checks, "request encoding").observed, "missing chatModelUid");
});

test("a complete request passes and counts what it wrote", () => {
  const schema = { metadata: { no: 1, type: "string" }, prompt: { no: 2, type: "string" } };
  const audit = auditMessage(Uint8Array.from([0x0a, 0x01, 0x61, 0x12, 0x01, 0x62]), schema);
  const checks = requestShapeChecks({ audit, requiredFields: ["metadata", "prompt"] });
  assert.equal(statusOf(checks, "request encoding"), "pass");
  assert.match(checkOf(checks, "request encoding").detail, /2 field\(s\) written, 6 bytes/);
});

test("a stream that produced no message frame fails even though HTTP said 200", () => {
  const checks = streamFrameChecks({ frames: [], pending: 0, sawEndOfStream: false });
  assert.equal(statusOf(checks, "stream framing"), "fail");
  assert.equal(statusOf(checks, "end-of-stream terminator"), "fail");
});

test("a compressed frame fails loudly, because a decoder handed one returns an empty message", () => {
  const checks = streamFrameChecks({
    frames: [{ compressed: true, endOfStream: false }, { compressed: false, endOfStream: true }],
    pending: 0,
    sawEndOfStream: true,
    terminator: { malformed: false },
  });
  assert.equal(statusOf(checks, "frame compression"), "fail");
  assert.match(checkOf(checks, "frame compression").observed, /1 of 2 frames/);
});

test("trailing bytes that never formed a frame are a failure, not a short answer", () => {
  const checks = streamFrameChecks({
    frames: [{ compressed: false, endOfStream: false }],
    pending: 12,
    sawEndOfStream: false,
  });
  assert.equal(statusOf(checks, "stream completeness"), "fail");
  assert.match(checkOf(checks, "stream completeness").observed, /12 trailing byte/);
});

test("an error inside the terminator is a failure with its code and retriability spelled out", () => {
  const checks = streamFrameChecks({
    frames: [{ compressed: false, endOfStream: true }],
    pending: 0,
    sawEndOfStream: true,
    terminator: {
      malformed: false,
      error: { code: "invalid_argument", message: "chat_model_uid is required", status: 400, retriable: false, known: true },
    },
  });
  const check = checkOf(checks, "end-of-stream terminator");
  assert.equal(check.status, "fail");
  assert.match(check.detail, /chat_model_uid is required/);
  assert.match(check.observed, /code=invalid_argument known=true retriable=false mapped-status=400/);
});

test("a clean terminator with frames passes every framing check", () => {
  const checks = streamFrameChecks({
    frames: [{ compressed: false, endOfStream: false }, { compressed: false, endOfStream: true }],
    pending: 0,
    sawEndOfStream: true,
    terminator: { malformed: false },
  });
  assert.deepEqual(
    checks.map((check) => check.status),
    ["pass", "pass", "pass"],
  );
});

test("frames that decode to nothing fail, where the old probe printed 'streamed 0 characters'", () => {
  const checks = liveTurnChecks({ model: "m", text: "", thinking: "", toolCalls: [], census: [] });
  assert.equal(statusOf(checks, "turn produced output"), "fail");
});

test("a turn that produced only reasoning still counts as output", () => {
  const checks = liveTurnChecks({ model: "m", text: "", thinking: "thinking…", toolCalls: [] });
  assert.equal(statusOf(checks, "turn produced output"), "pass");
});

test("a model served under a different uid than requested is reported", () => {
  const checks = liveTurnChecks({ model: "asked", actualModelUid: "served", text: "hi" });
  const check = checkOf(checks, "served model");
  assert.equal(check.status, "warn");
  assert.equal(check.expected, "asked");
  assert.equal(check.observed, "served");
});

test("a turn with no usage warns rather than passing silently", () => {
  assert.equal(statusOf(liveTurnChecks({ model: "m", text: "hi" }), "usage accounting"), "warn");
  assert.equal(
    statusOf(liveTurnChecks({ model: "m", text: "hi", usage: { prompt_tokens: 10, completion_tokens: 3 } }), "usage accounting"),
    "pass",
  );
});

test("a run without --tools says outright that the deciding check was not attempted", () => {
  const checks = liveTurnChecks({ model: "m", text: "ready", wantsTools: false });
  const check = checkOf(checks, "tool calls");
  assert.equal(check.status, "skip");
  assert.match(check.detail, /--live --tools/);
});

test("a stop reason claiming a function call with no decoded call is named as a dropped call", () => {
  // The quiet failure this exists for. Without this line the run is
  // indistinguishable from a model that declined the tool.
  const census = [{ no: 19, name: undefined, status: "unknown", path: [], wireTypeNames: ["length-delimited"], count: 1, totalBytes: 44 }];
  const checks = toolCallChecks({
    wantsTools: true,
    toolCalls: [],
    stopReason: FUNCTION_CALL,
    functionCallStopReason: FUNCTION_CALL,
    census,
  });
  const check = checkOf(checks, "tool calls decoded");
  assert.equal(check.status, "fail");
  assert.match(check.detail, /dropped on the wire, not declined by the model/);
  assert.match(check.observed, /stopReason=10/);
  assert.match(check.observed, /field 19 \(length-delimited, 44B over 1\) -> UNKNOWN/);
});

test("no tool call plus an undecoded field is reported as a possible renumbering", () => {
  const census = [{ no: 19, name: undefined, status: "unknown", path: [], wireTypeNames: ["length-delimited"], count: 2, totalBytes: 80 }];
  const check = checkOf(
    toolCallChecks({ wantsTools: true, toolCalls: [], stopReason: 2, functionCallStopReason: FUNCTION_CALL, census }),
    "tool calls decoded",
  );
  assert.equal(check.status, "fail");
  assert.match(check.detail, /field number that was skipped/);
});

test("no tool call with every field understood is reported as the model declining, not as a wire fault", () => {
  const check = checkOf(
    toolCallChecks({
      wantsTools: true,
      toolCalls: [],
      stopReason: 2,
      functionCallStopReason: FUNCTION_CALL,
      census: [{ no: 3, name: "deltaText", status: "matched", path: [], wireTypeNames: ["length-delimited"], count: 4, totalBytes: 40 }],
      text: "I cannot call tools.",
    }),
    "tool calls decoded",
  );
  assert.equal(check.status, "fail");
  assert.match(check.detail, /the model declined a forced tool choice/);
  assert.match(check.observed, /answered in prose instead: I cannot call tools\./);
});

test("tool calls with no id fail, because the forwarder keys restatements by id", () => {
  const checks = toolCallChecks({
    wantsTools: true,
    toolCalls: [{ id: "", name: "ping", argumentsJson: "{}" }],
    functionCallStopReason: FUNCTION_CALL,
  });
  assert.equal(statusOf(checks, "tool calls decoded"), "pass");
  assert.equal(statusOf(checks, "tool call ids"), "fail");
});

test("arguments that are not JSON fail with the value that arrived", () => {
  const checks = toolCallChecks({
    wantsTools: true,
    toolCalls: [{ id: "a", name: "ping", argumentsJson: "value=1" }],
    functionCallStopReason: FUNCTION_CALL,
  });
  const check = checkOf(checks, "tool call arguments");
  assert.equal(check.status, "fail");
  assert.equal(check.observed, "value=1");
});

test("an unnamed tool call fails even when it carried an id and arguments", () => {
  const checks = toolCallChecks({
    wantsTools: true,
    toolCalls: [{ id: "a", name: "", argumentsJson: "{}" }],
    functionCallStopReason: FUNCTION_CALL,
  });
  assert.equal(statusOf(checks, "tool call names"), "fail");
});

test("a well-formed forced tool call passes every tool check", () => {
  const checks = toolCallChecks({
    wantsTools: true,
    toolCalls: [{ id: "call_1", name: "ping", argumentsJson: '{"value":1}' }],
    stopReason: FUNCTION_CALL,
    functionCallStopReason: FUNCTION_CALL,
  });
  assert.deepEqual(
    checks.map((check) => [check.name, check.status]),
    [
      ["tool calls decoded", "pass"],
      ["tool call ids", "pass"],
      ["tool call arguments", "pass"],
    ],
  );
});

test("a restated call is reported as a restatement rather than as a second call", () => {
  const checks = toolCallChecks({
    wantsTools: true,
    toolCalls: [
      { id: "call_1", name: "ping", argumentsJson: "{" },
      { id: "call_1", name: "ping", argumentsJson: '{"value":1}' },
    ],
    functionCallStopReason: FUNCTION_CALL,
  });
  assert.equal(statusOf(checks, "tool call restatement"), "info");
});

test("no tool checks run at all when --tools was not asked for", () => {
  assert.deepEqual(toolCallChecks({ wantsTools: false, toolCalls: [] }), []);
});

test("the census a real frame produces feeds the drop detector unchanged", () => {
  // End to end through the auditor: a frame carrying the tool call on field 19
  // instead of field 6, which is what a renumbering looks like on the wire.
  const schema = { deltaText: { no: 3, type: "string" }, deltaToolCalls: { no: 6, type: "message", message: {}, repeated: true } };
  const frame = Uint8Array.from([0x9a, 0x01, 0x02, 0x7b, 0x7d]);
  const census = fieldCensus(auditMessage(frame, schema));
  const check = checkOf(
    toolCallChecks({ wantsTools: true, toolCalls: [], stopReason: FUNCTION_CALL, functionCallStopReason: FUNCTION_CALL, census }),
    "tool calls decoded",
  );
  assert.match(check.observed, /field 19 \(length-delimited, 2B over 1\) -> UNKNOWN/);
});
