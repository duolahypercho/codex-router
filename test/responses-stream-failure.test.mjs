import assert from "node:assert/strict";
import { Readable, Transform, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import test from "node:test";

import { endStreamedResponse, markResponsesStream, writeStreamErrorEvent } from "../src/http-utils.mjs";
import { EmptyCompletionGuard, EmptyCompletionTerminalGuard } from "../src/empty-completion-guard.mjs";
import { responsesStreamFailureTransform } from "../src/responses-stream-failure.mjs";

const TYPE = "text/event-stream";
const identity = { id: "resp_announced", object: "response", model: "fixture/model", created_at: 1_791_388_800 };
const frame = (payload, newline = "\n") => `event: ${payload.type}${newline}data: ${JSON.stringify(payload)}${newline}${newline}`;
const created = (overrides = {}) => ({ type: "response.created", sequence_number: 0, response: { ...identity, status: "in_progress", output: [], ...overrides } });

function response(type = TYPE) {
  return {
    chunks: [], headersSent: false, writableEnded: false, destroyed: false,
    getHeader: () => type,
    write(chunk) { this.headersSent = true; this.chunks.push(Buffer.from(chunk)); },
    end() { this.writableEnded = true; },
    body() { return Buffer.concat(this.chunks).toString("utf8"); },
  };
}

function observe(target, chunks, options) {
  const observer = responsesStreamFailureTransform(target, TYPE, options);
  observer.on("data", (chunk) => target.write(chunk));
  for (const chunk of chunks) observer.write(chunk);
  return observer;
}

function events(body) {
  return body.split(/\r?\n\r?\n/).flatMap((block) => {
    const data = block.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()).join("\n");
    try { return [JSON.parse(data)]; } catch { return []; }
  });
}

function fail(target, options = {}) {
  writeStreamErrorEvent(target, { code: "local_router_stream_failed", message: "fixture diagnosed cause", ...options });
  return events(target.body()).at(-1);
}

test("a tracked failure keeps announced identity, next sequence, enum error, and empty required defaults", () => {
  const target = response();
  markResponsesStream(target, { model: "requested/model" });
  const observer = observe(target, [frame(created()), frame({ type: "response.output_text.delta", sequence_number: 7, delta: "partial" })]);
  const failure = fail(target, { code: "invalid_function_call_arguments" });
  assert.equal(failure.type, "response.failed");
  assert.equal(failure.sequence_number, 8);
  assert.equal(failure.code, "invalid_function_call_arguments");
  assert.deepEqual(failure.response, {
    ...identity, status: "failed", error: { code: "server_error", message: "fixture diagnosed cause" },
    output: [], parallel_tool_calls: false, tool_choice: "none", tools: [],
  });
  assert.doesNotMatch(target.body(), /\[DONE\]/);
  observer.destroy();
});

test("each UTF-8/CRLF byte is forwarded before a whole event is available", () => {
  const target = response();
  markResponsesStream(target);
  const source = Buffer.from(frame(created({ model: "fixture/模型" }), "\r\n"));
  const observer = observe(target, []);
  for (let index = 0; index < source.length; index += 1) {
    observer.write(source.subarray(index, index + 1));
    assert.equal(target.chunks.length, index + 1, "the observer delayed output for an event boundary");
  }
  assert.deepEqual(Buffer.concat(target.chunks), source);
  assert.equal(fail(target).response.model, "fixture/模型");
  observer.destroy();
});

test("SSE comments and multiline JSON retain exact chunks and framing", () => {
  const target = response();
  markResponsesStream(target);
  const payload = created();
  const source = `: keepalive\r\n\r\nevent: response.created\r\ndata: {"type":"response.created",\r\ndata: "sequence_number":0,"response":${JSON.stringify(payload.response)}}\r\n\r\n`;
  const chunks = [Buffer.from(source.slice(0, 13)), Buffer.from(source.slice(13))];
  const observer = observe(target, chunks);
  assert.deepEqual(target.chunks, chunks);
  assert.equal(fail(target).response.id, identity.id);
  observer.destroy();
});

test("updating the request model does not erase an already announced identity", () => {
  const target = response();
  markResponsesStream(target, { model: "requested/model" });
  const observer = observe(target, [frame(created())]);
  markResponsesStream(target, { model: "other/requested-model" });
  assert.deepEqual(fail(target).response, {
    ...identity, status: "failed", error: { code: "server_error", message: "fixture diagnosed cause" },
    output: [], parallel_tool_calls: false, tool_choice: "none", tools: [],
  });
  observer.destroy();
});

test("the requested model can supply an omitted model without inventing identity or date", () => {
  const target = response();
  markResponsesStream(target, { model: "requested/model" });
  const { model: _model, ...snapshot } = created().response;
  const observer = observe(target, [frame({ ...created(), response: snapshot })]);
  const failure = fail(target);
  assert.equal(failure.response.model, "requested/model");
  assert.equal(failure.response.id, identity.id);
  assert.equal(failure.response.created_at, identity.created_at);
  observer.destroy();
});

test("a discarded empty first attempt never leaks its identity into the retry", async () => {
  const target = response();
  markResponsesStream(target, { model: "requested/model" });
  const first = new EmptyCompletionGuard(TYPE, { maxPreludeMs: 30_000 });
  await pipeline(
    Readable.from([frame(created({ id: "resp_discarded" })), frame({ type: "response.completed", sequence_number: 1, response: { ...identity, id: "resp_discarded", status: "completed", output: [] } })]),
    first, new EmptyCompletionTerminalGuard(first, TYPE), responsesStreamFailureTransform(target, TYPE),
    new Writable({ write(chunk, _encoding, callback) { target.write(chunk); callback(); } }),
  );
  assert.equal(first.suppressedPrologue(), true);
  assert.equal(target.body(), "");
  assert.equal(target.headersSent, false);
  const observer = observe(target, [frame(created({ id: "resp_retry" }))]);
  const failure = fail(target);
  assert.equal(failure.response.id, "resp_retry");
  assert.equal(failure.sequence_number, 1);
  assert.doesNotMatch(target.body(), /resp_discarded/);
  observer.destroy();
});

test("the final observer uses rewritten identity and injected egress sequence numbers", async () => {
  const target = response();
  markResponsesStream(target);
  const rewrite = new Transform({
    transform(_chunk, _encoding, callback) {
      this.push(frame({ ...created(), sequence_number: 10, response: { ...created().response, id: "resp_rewritten" } }));
      callback(null, frame({ type: "response.in_progress", sequence_number: 23, response: { ...identity, id: "resp_rewritten" } }));
    },
  });
  await pipeline(Readable.from([frame(created())]), rewrite, responsesStreamFailureTransform(target, TYPE), new Writable({ write(chunk, _encoding, callback) { target.write(chunk); callback(); } }));
  const failure = fail(target);
  assert.equal(failure.response.id, "resp_rewritten");
  assert.equal(failure.sequence_number, 24);
  assert.doesNotMatch(target.body(), /resp_announced/);
});

test("an unnumbered metadata heartbeat preserves the last numbered event", () => {
  const target = response();
  markResponsesStream(target);
  const observer = observe(target, [frame(created()), frame({ type: "response.in_progress", response: { ...identity, status: "in_progress", output: [] } })]);
  assert.equal(fail(target).sequence_number, 1);
  observer.destroy();
});

for (const [name, change] of [
  ["no announcing response", []],
  ["no trusted sequence", [frame({ ...created(), sequence_number: undefined })]],
  ["missing timestamp", [frame(created({ created_at: undefined }))]],
  ["changed response ID", [frame(created()), frame({ type: "response.in_progress", sequence_number: 1, response: { ...identity, id: "foreign_id" } })]],
  ["changed model", [frame(created()), frame({ type: "response.in_progress", sequence_number: 1, response: { ...identity, model: "other/model" } })]],
  ["changed timestamp", [frame(created()), frame({ type: "response.in_progress", sequence_number: 1, response: { ...identity, created_at: 2 } })]],
  ["nonmonotonic sequence", [frame(created()), frame({ type: "response.output_text.delta", sequence_number: 0, delta: "x" })]],
  ["negative sequence", [frame({ ...created(), sequence_number: -1 })]],
  ["fractional sequence", [frame({ ...created(), sequence_number: 1.5 })]],
  ["unsafe sequence", [frame({ ...created(), sequence_number: Number.MAX_SAFE_INTEGER })]],
  ["invalid identity", [frame(created({ id: "bad\nidentity" }))]],
  ["oversized identity", [frame(created({ id: "x".repeat(513) }))]],
  ["invalid UTF-8", [Buffer.from([0xff]), Buffer.from("\n\n"), frame(created())]],
  ["malformed complete JSON frame", ['data: {broken}\n\n', frame(created())]],
  ["event-name mismatch", [frame(created()).replace("event: response.created", "event: response.in_progress")]],
  ["unknown typed event carrying plausible identity", [frame({ type: "response.unknown", sequence_number: 0, response: identity })]],
  ["untyped event carrying plausible identity", [`data: ${JSON.stringify({ sequence_number: 0, response: identity })}\n\n`]],
  ["unknown identity event after a real announcement", [frame(created()), frame({ type: "unknown", sequence_number: 1, response: identity })]],
  ["malformed announcing frame after a real announcement", [frame(created()), frame({ type: "response.created", sequence_number: 1, response: [] })]],
]) {
  test(`${name} falls back honestly without an invented Response`, () => {
    const target = response();
    markResponsesStream(target, { model: "requested/model" });
    const observer = observe(target, change);
    const failure = fail(target);
    assert.deepEqual(failure, { type: "error", code: "local_router_stream_failed", message: "fixture diagnosed cause", param: null });
    assert.doesNotMatch(target.body(), /event: response.failed|\[DONE\]/);
    observer.destroy();
  });
}

test("an unexpected raw DONE invalidates context without manufacturing another provider Response", () => {
  const target = response();
  markResponsesStream(target);
  const observer = observe(target, [frame(created()), "data: [DONE]\n\n"]);
  const failure = fail(target);
  assert.equal(failure.type, "error");
  assert.doesNotMatch(target.chunks.at(-1).toString(), /response.failed|\[DONE\]/);
  observer.destroy();
});

test("harmless JSON pings leave a real announced identity and numbering intact", () => {
  const target = response();
  markResponsesStream(target);
  const observer = observe(target, [frame(created()), 'event: ping\ndata: {"type":"ping","cost":"0"}\n\n']);
  assert.equal(fail(target).response.id, identity.id);
  observer.destroy();
});

test("missing both the announced and requested model uses the generic fallback", () => {
  const target = response();
  markResponsesStream(target);
  const { model: _model, ...snapshot } = created().response;
  const observer = observe(target, [frame({ ...created(), response: snapshot })]);
  assert.equal(fail(target).type, "error");
  observer.destroy();
});

test("oversized frames drain unchanged with bounded parsing and cannot restore trust", () => {
  const target = response();
  markResponsesStream(target);
  const observer = observe(target, [], { maxEventBytes: 512 });
  const chunks = [frame(created()), `data: {"instructions":"${"x".repeat(1_000_000)}`, '"}\n\n', frame({ type: "response.output_text.delta", sequence_number: 1, delta: "after oversized frame" })].map((chunk) => Buffer.from(chunk));
  for (const chunk of chunks) observer.write(chunk);
  assert.deepEqual(target.chunks, chunks);
  assert.equal(fail(target).type, "error");
  observer.destroy();
});

test("the parser finds a terminal event after discarding an oversized frame", () => {
  const target = response();
  markResponsesStream(target);
  const observer = observe(target, ["data: " + "x".repeat(2_000), "\n\n", frame({ type: "response.completed", sequence_number: 1, response: { ...identity, status: "completed", output: [] } })], { maxEventBytes: 512 });
  const before = target.body();
  assert.equal(writeStreamErrorEvent(target, { code: "late", message: "late failure" }), false);
  assert.equal(target.body(), before);
  observer.destroy();
});

for (const [name, upstream] of [
  ["legacy response.error", { type: "response.error", sequence_number: 1, response: { ...identity, status: "failed", error: { code: "server_error", message: "provider fixture cause" } } }],
  ["generic error", { type: "error", sequence_number: 1, code: "server_error", message: "provider fixture cause" }],
  ["generic nested error", { type: "error", sequence_number: 1, error: { code: "server_error", message: "provider fixture cause" } }],
  ["completion without a Response", { type: "response.completed", sequence_number: 1 }],
  ["completion with a null Response", { type: "response.completed", sequence_number: 1, response: null }],
]) {
  test(`${name} cannot hide a diagnosed local Responses failure`, () => {
    const target = response();
    markResponsesStream(target);
    const chunks = [frame(created()), frame(upstream)].map((value) => Buffer.from(value));
    const observer = observe(target, chunks);
    assert.deepEqual(target.chunks, chunks, "the upstream bytes must stay unchanged");
    const failure = fail(target);
    assert.equal(failure.type, "response.failed");
    assert.equal(failure.sequence_number, 2);
    assert.equal(failure.response.id, identity.id);
    assert.equal(failure.response.error.message, "fixture diagnosed cause");
    assert.equal(events(target.body()).filter((event) => event.type === "response.failed").length, 1);
    observer.destroy();
  });
}

for (const type of ["response.completed", "response.failed", "response.incomplete"]) {
  test(`does not append another failure after ${type}`, () => {
    const target = response();
    markResponsesStream(target);
    const observer = observe(target, [frame(created()), frame({ type, sequence_number: 1, response: { ...identity, status: type === "response.completed" ? "completed" : "failed", output: [] } })]);
    const before = target.body();
    endStreamedResponse(target);
    assert.equal(target.body(), before);
    assert.equal(target.writableEnded, true);
    observer.destroy();
  });
}

test("a consumed completion stays terminal even when its SSE event field differs", () => {
  const target = response();
  markResponsesStream(target);
  const terminal = frame({ type: "response.completed", sequence_number: 1, response: { ...identity, status: "completed", output: [] } }).replace("event: response.completed", "event: ping");
  const observer = observe(target, [frame(created()), terminal]);
  const before = target.body();
  endStreamedResponse(target);
  assert.equal(target.body(), before);
  assert.equal(target.writableEnded, true);
  observer.destroy();
});

test("consumed completion IDs are separate from bounded metadata trust", () => {
  // Installed Codex accepts any string ID as completion. Wrong/missing IDs
  // in a present Response immediately fail parsing, so those also consume the
  // terminal rather than leave room to append another local Response.
  for (const id of [identity.id, "", "x".repeat(513), "control\nid\u0000", null, 42, { id: "wrong type" }, undefined]) {
    const target = response();
    markResponsesStream(target);
    const observer = observe(target, [frame(created()), frame({ type: "response.completed", sequence_number: 1, response: { id } })]);
    const before = target.body();
    endStreamedResponse(target);
    assert.equal(target.body(), before, String(id));
    assert.equal(target.writableEnded, true);
    observer.destroy();
  }
});

test("a malformed present terminal snapshot preserves the client's consumed parse failure", () => {
  for (const snapshot of [0, false, 42, "not-a-response", []]) {
    const target = response();
    markResponsesStream(target);
    const observer = observe(target, [frame(created()), frame({ type: "response.completed", sequence_number: 1, response: snapshot })]);
    const before = target.body();
    endStreamedResponse(target);
    assert.equal(target.body(), before);
    observer.destroy();
  }
  for (const type of ["response.failed", "response.incomplete"]) {
    const target = response();
    markResponsesStream(target);
    const observer = observe(target, [frame(created()), frame({ type, sequence_number: 1 })]);
    const before = target.body();
    endStreamedResponse(target);
    assert.equal(target.body(), before);
    observer.destroy();
  }
});

test("a valid unfinished data line contributes its sequence before the failure prefix dispatches it", () => {
  const target = response();
  markResponsesStream(target);
  const observer = observe(target, [frame(created()), 'data: {"type":"response.output_text.delta","sequence_number":4,"delta":"visible"}']);
  const failure = fail(target);
  assert.equal(failure.type, "response.failed");
  assert.equal(failure.sequence_number, 5);
  assert.equal(events(target.body())[1].delta, "visible");
  observer.destroy();
});

test("an interrupted invalid data line does not absorb a typed failure or change its known identity", () => {
  const target = response();
  markResponsesStream(target);
  const observer = observe(target, [frame(created()), 'data: {"type":"response.output_text.delta","sequence_number":4,"delta":"unterminated']);
  assert.equal(fail(target).response.id, identity.id);
  assert.doesNotMatch(target.body(), /unterminatedevent/);
  observer.destroy();
});

test("a valid unfinished terminal frame is closed without appending another terminal", () => {
  const target = response();
  markResponsesStream(target);
  const unfinished = 'data: ' + JSON.stringify({ type: "response.completed", sequence_number: 1, response: { ...identity, status: "completed", output: [] } });
  const observer = observe(target, [frame(created()), unfinished]);
  endStreamedResponse(target);
  assert.equal(target.body(), frame(created()) + unfinished + "\n\n");
  assert.equal(events(target.body()).at(-1).type, "response.completed");
  observer.destroy();
});

test("only one local terminal is injected, including generic fallback", () => {
  for (const announced of [true, false]) {
    const target = response();
    markResponsesStream(target);
    const observer = observe(target, announced ? [frame(created())] : []);
    fail(target);
    const before = target.body();
    assert.equal(writeStreamErrorEvent(target, { code: "another", message: "another cause" }), false);
    assert.equal(target.body(), before);
    observer.destroy();
  }
});

test("marked failures bound strings and never stringify an unknown error object", () => {
  for (const message of ["\n".repeat(50_000), "😀".repeat(50_000), { secret: "must-not-be-serialized" }]) {
    const target = response();
    markResponsesStream(target);
    const observer = observe(target, [frame(created())]);
    const before = target.chunks.length;
    const failure = fail(target, { message, code: "\n".repeat(50_000) });
    assert.equal(failure.type, "response.failed");
    assert.ok(target.chunks[before].length < 16 * 1024, "the injected frame exceeded its finite payload budget");
    assert.doesNotMatch(target.body(), /must-not-be-serialized/);
    assert.equal(failure.response.error.message.isWellFormed(), true);
    observer.destroy();
  }
});

test("unmarked SSE retains its exact generic error frame and JSON gains no frame", () => {
  const target = response();
  assert.equal(responsesStreamFailureTransform(target, TYPE), undefined);
  fail(target);
  assert.equal(target.body(), '\n\nevent: error\ndata: {"type":"error","code":"local_router_stream_failed","message":"fixture diagnosed cause","param":null}\n\n');
  const json = response("application/json");
  markResponsesStream(json);
  assert.equal(responsesStreamFailureTransform(json, "application/json"), undefined);
  endStreamedResponse(json);
  assert.equal(json.body(), "");
  assert.equal(json.writableEnded, true);
});
