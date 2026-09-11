import assert from "node:assert/strict";
import { Readable, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";

import {
  EmptyCompletionGuard,
  EmptyCompletionPreludeLimitError,
  EmptyCompletionTerminalGuard,
} from "../src/empty-completion-guard.mjs";

async function runGuard(
  input,
  {
    contentType = "text/event-stream; charset=utf-8",
    chunkSize = 0,
    maxPreludeBytes,
    maxPreludeMs,
  } = {},
) {
  const guard = new EmptyCompletionGuard(contentType, {
    ...(maxPreludeBytes === undefined ? {} : { maxPreludeBytes }),
    ...(maxPreludeMs === undefined ? {} : { maxPreludeMs }),
  });
  const chunks = [];
  const collector = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(Buffer.from(chunk));
      callback();
    },
  });
  // `chunkSize` splits the body at arbitrary offsets so a test can prove the
  // guard's decision does not depend on upstream chunk boundaries.
  const source = [];
  if (chunkSize > 0) {
    for (let at = 0; at < input.length; at += chunkSize) {
      source.push(Buffer.from(input.slice(at, at + chunkSize)));
    }
  } else {
    source.push(Buffer.from(input));
  }
  await pipeline(Readable.from(source), guard, collector);
  return {
    body: Buffer.concat(chunks).toString("utf8"),
    empty: guard.isEmpty(),
    suppressed: guard.suppressedPrologue(),
    live: guard.releasedForLiveness(),
    preludeLimit: guard.preludeLimitKind(),
  };
}

const CONTENT_TURN = [
  'event: response.created',
  'data: {"type":"response.created","response":{"id":"r1"}}',
  "",
  'event: response.output_text.delta',
  'data: {"type":"response.output_text.delta","delta":"Hello"}',
  "",
  'event: response.output_text.done',
  'data: {"type":"response.output_text.done","text":"Hello"}',
  "",
  'event: response.completed',
  'data: {"type":"response.completed","response":{"id":"r1","output":[]}}',
  "",
  'event: response.done',
  'data: {"type":"response.done","response":{"id":"r1"}}',
  "",
].join("\n");

// Empty after visibly generating. The reasoning delta is liveness: it ends the
// hold, so the attempt reaches the client and can no longer be swapped out for
// a retry behind its back. Still classified empty.
const EMPTY_TURN = [
  'event: response.created',
  'data: {"type":"response.created","response":{"id":"r1"}}',
  "",
  'event: response.reasoning_text.delta',
  'data: {"type":"response.reasoning_text.delta","delta":"thinking..."}',
  "",
  'event: response.completed',
  'data: {"type":"response.completed","response":{"id":"r1","output":[]}}',
  "",
  'event: response.done',
  'data: {"type":"response.done","response":{"id":"r1"}}',
  "",
].join("\n");

// Empty without ever proving it was generating: prologue, then a terminal. The
// hold costs nothing here (a silent upstream has no prologue worth waiting for)
// and buys everything, so this attempt is discarded whole and retried.
const SILENT_TURN = [
  'event: response.created',
  'data: {"type":"response.created","response":{"id":"r1"}}',
  "",
  'event: response.in_progress',
  'data: {"type":"response.in_progress","response":{"id":"r1"}}',
  "",
  'event: response.completed',
  'data: {"type":"response.completed","response":{"id":"r1","output":[]}}',
  "",
  'event: response.done',
  'data: {"type":"response.done","response":{"id":"r1"}}',
  "",
].join("\n");

const TOOL_CALL_TURN = [
  'event: response.created',
  'data: {"type":"response.created","response":{"id":"r1"}}',
  "",
  'event: response.output_item.added',
  'data: {"type":"response.output_item.added","item":{"type":"function_call","name":"exec_command"}}',
  "",
  'event: response.function_call_arguments.delta',
  'data: {"type":"response.function_call_arguments.delta","delta":"ls -la"}',
  "",
  'event: response.output_item.done',
  'data: {"type":"response.output_item.done","item":{"type":"function_call","name":"exec_command","arguments":"ls -la"}}',
  "",
  'event: response.completed',
  'data: {"type":"response.completed","response":{"id":"r1","output":[]}}',
  "",
  'event: response.done',
  'data: {"type":"response.done","response":{"id":"r1"}}',
  "",
].join("\n");

test("a failure terminal is released at once instead of being held to a limit", async () => {
  for (const [label, prologue, failure] of [
    ["typed error before any event", "", 'event: error\ndata: {"type":"error","error":{"message":"refused"}}\n\n'],
    ["untyped failed response", "", 'data: {"type":"response.failed","response":{"id":"r1","status":"failed"}}\n\n'],
    [
      "error after a liveness release",
      'event: response.reasoning_summary_text.delta\ndata: {"type":"response.reasoning_summary_text.delta","delta":"x"}\n\n',
      'event: error\ndata: {"type":"error","error":{"message":"refused"}}\n\n',
    ],
  ]) {
    const guard = new EmptyCompletionGuard("text/event-stream", {
      maxPreludeMs: 1_000,
      maxStreamStallMs: 250,
    });
    const output = [];
    const errors = [];
    guard.on("data", (chunk) => output.push(Buffer.from(chunk).toString("utf8")));
    guard.on("error", (error) => errors.push(error));
    // The upstream states its failure and then keeps the socket open.
    if (prologue) guard.write(prologue);
    guard.write(failure);
    await delay(60);
    assert.equal(output.join(""), prologue + failure, `${label}: failure was held`);
    await delay(1_100);
    assert.deepEqual(errors, [], `${label}: a limit fired after the upstream's own verdict`);
    assert.equal(guard.preludeLimitKind(), undefined, label);
    guard.end();
    await new Promise((resolve) => guard.once("end", resolve));
    assert.equal(guard.isEmpty(), false, `${label}: a failure is not an empty completion`);
    assert.equal(guard.suppressedPrologue(), false, label);
  }
});

test("a turn with output text passes through untouched and is not empty", async () => {
  const { body, empty } = await runGuard(CONTENT_TURN);
  assert.equal(empty, false);
  assert.match(body, /Hello/);
  assert.match(body, /response\.completed/);
  assert.match(body, /response\.done/);
});

test("a silent turn is flagged empty and the entire attempt is discarded", async () => {
  const { body, empty, suppressed, live } = await runGuard(SILENT_TURN);
  assert.equal(empty, true);
  assert.equal(suppressed, true);
  assert.equal(live, false);
  assert.equal(body, "");
});

test("a reasoning-only turn is still empty but is relayed, not suppressed", async () => {
  const { body, empty, suppressed, live } = await runGuard(EMPTY_TURN);
  assert.equal(empty, true);
  // The verdict survives the release: the caller learns the turn produced
  // nothing, and learns it cannot fix that invisibly.
  assert.equal(suppressed, false);
  assert.equal(live, true);
  assert.equal(body, EMPTY_TURN);
});

test("terminal events stay hidden when a released reasoning turn is empty", async () => {
  const guard = new EmptyCompletionGuard("text/event-stream");
  const terminalGuard = new EmptyCompletionTerminalGuard(
    guard,
    "text/event-stream",
  );
  const chunks = [];
  await pipeline(
    Readable.from([Buffer.from(EMPTY_TURN)]),
    guard,
    terminalGuard,
    new Writable({
      write(chunk, _encoding, callback) {
        chunks.push(Buffer.from(chunk));
        callback();
      },
    }),
  );
  const body = Buffer.concat(chunks).toString("utf8");
  assert.equal(guard.isEmpty(), true);
  assert.match(body, /reasoning_text\.delta/);
  assert.doesNotMatch(body, /response\.completed|response\.done/);
});

test("held terminal events have a byte bound", async () => {
  const guard = new EmptyCompletionGuard("text/event-stream");
  const terminalGuard = new EmptyCompletionTerminalGuard(
    guard,
    "text/event-stream",
    { maxHeldTerminalBytes: 120 },
  );
  const repeatedDone = [
    "event: response.reasoning_text.delta",
    'data: {"type":"response.reasoning_text.delta","delta":"thinking"}',
    "",
    ...Array.from({ length: 8 }, () => [
      "event: response.done",
      'data: {"type":"response.done","response":{"id":"r1"}}',
      "",
    ]).flat(),
    "",
  ].join("\n");
  await assert.rejects(
    pipeline(
      Readable.from([Buffer.from(repeatedDone)]),
      guard,
      terminalGuard,
      new Writable({
        write(_chunk, _encoding, callback) {
          callback();
        },
      }),
    ),
    (error) =>
      error instanceof EmptyCompletionPreludeLimitError && error.kind === "bytes",
  );
});

test("terminal events pass through when the released turn has content", async () => {
  const guard = new EmptyCompletionGuard("text/event-stream");
  const terminalGuard = new EmptyCompletionTerminalGuard(
    guard,
    "text/event-stream",
  );
  const chunks = [];
  await pipeline(
    Readable.from([Buffer.from(CONTENT_TURN)]),
    guard,
    terminalGuard,
    new Writable({
      write(chunk, _encoding, callback) {
        chunks.push(Buffer.from(chunk));
        callback();
      },
    }),
  );
  assert.equal(Buffer.concat(chunks).toString("utf8"), CONTENT_TURN);
});

test("reasoning ends the hold before the terminal event arrives", async () => {
  // The point of the release is latency, so prove the bytes leave the guard
  // while the stream is still open rather than at flush.
  const guard = new EmptyCompletionGuard("text/event-stream");
  const seen = [];
  guard.on("data", (chunk) => seen.push(Buffer.from(chunk).toString("utf8")));
  const split = EMPTY_TURN.indexOf("event: response.completed");
  guard.write(Buffer.from(EMPTY_TURN.slice(0, split)));
  assert.match(seen.join(""), /reasoning_text\.delta/);
  guard.end(Buffer.from(EMPTY_TURN.slice(split)));
  await new Promise((resolve) => guard.on("end", resolve).resume());
  assert.equal(guard.isEmpty(), true);
  assert.equal(guard.suppressedPrologue(), false);
});

test("a reasoning turn that then produces content is not empty", async () => {
  const input = [
    "event: response.reasoning_text.delta",
    'data: {"type":"response.reasoning_text.delta","delta":"thinking..."}',
    "",
    "event: response.output_text.delta",
    'data: {"type":"response.output_text.delta","delta":"Hello"}',
    "",
    "event: response.completed",
    'data: {"type":"response.completed","response":{"output":[]}}',
    "",
  ].join("\n");
  const { body, empty, live } = await runGuard(input, { chunkSize: 13 });
  assert.equal(empty, false);
  assert.equal(live, true);
  assert.equal(body, input);
});

test("content clears the post-reasoning stall timer", async () => {
  async function* delayedFinish() {
    yield Buffer.from([
      "event: response.reasoning_text.delta",
      'data: {"type":"response.reasoning_text.delta","delta":"thinking"}',
      "",
      "event: response.output_text.delta",
      'data: {"type":"response.output_text.delta","delta":"answer"}',
      "",
      "",
    ].join("\n"));
    await new Promise((resolve) => setTimeout(resolve, 30));
    yield Buffer.from([
      "event: response.completed",
      'data: {"type":"response.completed","response":{"output":[]}}',
      "",
      "",
    ].join("\n"));
  }
  const guard = new EmptyCompletionGuard("text/event-stream", {
    maxPreludeMs: 100,
    maxStreamStallMs: 5,
  });
  const chunks = [];
  await pipeline(
    Readable.from(delayedFinish()),
    guard,
    new Writable({
      write(chunk, _encoding, callback) {
        chunks.push(Buffer.from(chunk));
        callback();
      },
    }),
  );
  assert.equal(guard.hasContent(), true);
  assert.equal(guard.isEmpty(), false);
  assert.match(Buffer.concat(chunks).toString("utf8"), /answer/);
});

test("a reasoning item announces liveness when no summary is streamed", async () => {
  const input = [
    "event: response.output_item.added",
    'data: {"type":"response.output_item.added","item":{"type":"reasoning","id":"rs_1"}}',
    "",
    "event: response.completed",
    'data: {"type":"response.completed","response":{"output":[]}}',
    "",
  ].join("\n");
  const { body, empty, suppressed } = await runGuard(input);
  assert.equal(empty, true);
  assert.equal(suppressed, false);
  assert.equal(body, input);
});

test("a content turn is released byte for byte after classification", async () => {
  const { body, empty } = await runGuard(CONTENT_TURN, { chunkSize: 11 });
  assert.equal(empty, false);
  assert.equal(body, CONTENT_TURN);
});

test("a tool-call turn is not empty and its terminal events survive", async () => {
  const { body, empty } = await runGuard(TOOL_CALL_TURN);
  assert.equal(empty, false);
  assert.match(body, /function_call_arguments\.delta/);
  assert.match(body, /response\.completed/);
});

test("custom tool input events count as content", async () => {
  const input = [
    "event: response.custom_tool_call_input.delta",
    'data: {"type":"response.custom_tool_call_input.delta","delta":"move pointer"}',
    "",
    "event: response.completed",
    'data: {"type":"response.completed","response":{"output":[]}}',
    "",
  ].join("\n");
  const { body, empty } = await runGuard(input);
  assert.equal(empty, false);
  assert.equal(body, input);
});

test("a completed custom tool call counts as content", async () => {
  const input = [
    "event: response.completed",
    `data: ${JSON.stringify({
      type: "response.completed",
      response: {
        output: [{ type: "custom_tool_call", name: "computer", input: "move pointer" }],
      },
    })}`,
    "",
  ].join("\n");
  const { body, empty } = await runGuard(input);
  assert.equal(empty, false);
  assert.equal(body, input);
});

test("refusal events count as content", async () => {
  const input = [
    "event: response.refusal.delta",
    'data: {"type":"response.refusal.delta","delta":"I cannot help with that."}',
    "",
    "event: response.completed",
    'data: {"type":"response.completed","response":{"output":[]}}',
    "",
  ].join("\n");
  const { body, empty } = await runGuard(input);
  assert.equal(empty, false);
  assert.equal(body, input);
});

test("refusal output parts count as content", async () => {
  const input = [
    "event: response.content_part.done",
    'data: {"type":"response.content_part.done","part":{"type":"refusal","refusal":"I cannot help with that."}}',
    "",
    "event: response.completed",
    `data: ${JSON.stringify({
      type: "response.completed",
      response: {
        output: [
          {
            type: "message",
            content: [{ type: "refusal", refusal: "I cannot help with that." }],
          },
        ],
      },
    })}`,
    "",
  ].join("\n");
  const { body, empty } = await runGuard(input);
  assert.equal(empty, false);
  assert.equal(body, input);
});

test("a stream that ends with only [DONE] is empty", async () => {
  const input = [
    'event: response.created',
    'data: {"type":"response.created"}',
    "",
    "data: [DONE]",
    "",
  ].join("\n");
  const { body, empty } = await runGuard(input);
  assert.equal(empty, true);
  assert.doesNotMatch(body, /\[DONE\]/);
});

// Some gateways stream no deltas at all and deliver the whole turn inside the
// terminal `response.completed`. The guard has to read that payload before it
// decides to hold the event, or the one event carrying the answer is the one
// event it suppresses -- turning a good turn into a retried, then failed, one.
const COMPLETED_CARRIES_OUTPUT = [
  'event: response.created',
  'data: {"type":"response.created","response":{"id":"r1"}}',
  "",
  "event: response.completed",
  `data: ${JSON.stringify({
    type: "response.completed",
    response: {
      id: "r1",
      output: [{ type: "message", content: [{ type: "output_text", text: "Here is the answer" }] }],
    },
  })}`,
  "",
  "data: [DONE]",
  "",
].join("\n");

test("a turn whose only content rides on response.completed is not empty", async () => {
  const { body, empty } = await runGuard(COMPLETED_CARRIES_OUTPUT);
  assert.equal(empty, false);
  assert.match(body, /Here is the answer/);
  assert.match(body, /\[DONE\]/);
});

test("the completed-only turn survives arbitrary chunk boundaries", async () => {
  const { body, empty } = await runGuard(COMPLETED_CARRIES_OUTPUT, { chunkSize: 17 });
  assert.equal(empty, false);
  assert.match(body, /Here is the answer/);
});

test("chat-completions deltas count as content", async () => {
  const input = [
    `data: ${JSON.stringify({ choices: [{ delta: { content: "Hello" } }] })}`,
    "",
    `data: ${JSON.stringify({ choices: [{ delta: { content: " world" }, finish_reason: "stop" }] })}`,
    "",
    "data: [DONE]",
    "",
  ].join("\n");
  const { body, empty } = await runGuard(input);
  assert.equal(empty, false);
  assert.match(body, /\[DONE\]/);
});

test("a chat-completions refusal delta counts as content", async () => {
  const input = [
    `data: ${JSON.stringify({ choices: [{ delta: { refusal: "I cannot help with that." } }] })}`,
    "",
    "data: [DONE]",
    "",
  ].join("\n");
  const { body, empty } = await runGuard(input);
  assert.equal(empty, false);
  assert.equal(body, input);
});

test("a chat-completions tool call counts as content", async () => {
  const input = [
    `data: ${JSON.stringify({
      choices: [{ delta: { tool_calls: [{ index: 0, function: { name: "exec_command" } }] } }],
    })}`,
    "",
    "data: [DONE]",
    "",
  ].join("\n");
  assert.equal((await runGuard(input)).empty, false);
});

test("a chat-completions turn with only reasoning is empty but relayed", async () => {
  const input = [
    `data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: "thinking..." } }] })}`,
    "",
    "data: [DONE]",
    "",
  ].join("\n");
  const { body, empty, suppressed, live } = await runGuard(input);
  assert.equal(empty, true);
  assert.equal(suppressed, false);
  assert.equal(live, true);
  assert.equal(body, input);
});

test("a chat-completions `reasoning` field is liveness too", async () => {
  // DeepSeek sends `reasoning_content`; several resellers relay `reasoning`.
  const input = [
    `data: ${JSON.stringify({ choices: [{ delta: { reasoning: "thinking..." } }] })}`,
    "",
    "data: [DONE]",
    "",
  ].join("\n");
  const { empty, suppressed } = await runGuard(input);
  assert.equal(empty, true);
  assert.equal(suppressed, false);
});

test("multiple data fields are joined per the SSE dispatch algorithm", async () => {
  const input = [
    "event: response.output_text.delta",
    'data: {"type":"response.output_text.delta",',
    'data: "delta":"multiline"}',
    "",
    "data: [DONE]",
    "",
  ].join("\n");
  const { body, empty } = await runGuard(input, { chunkSize: 7 });
  assert.equal(empty, false);
  assert.equal(body, input);
});

test("the pre-content time bound also covers a headerless SSE attempt", async () => {
  const split = SILENT_TURN.indexOf("event: response.completed");
  async function* delayedTurn() {
    yield Buffer.from(SILENT_TURN.slice(0, split));
    await new Promise((resolve) => setTimeout(resolve, 20));
    yield Buffer.from(SILENT_TURN.slice(split));
  }
  const guard = new EmptyCompletionGuard("", {
    maxPreludeMs: 5,
    maxStreamStallMs: 100,
  });
  const chunks = [];
  await pipeline(
    Readable.from(delayedTurn()),
    guard,
    new Writable({
      write(chunk, _encoding, callback) {
        chunks.push(Buffer.from(chunk));
        callback();
      },
    }),
  );
  assert.equal(guard.isEmpty(), true);
  assert.equal(guard.suppressedPrologue(), false);
  assert.equal(guard.preludeLimitKind(), "time");
  assert.equal(Buffer.concat(chunks).toString("utf8"), SILENT_TURN);
});

test("headerless SSE detection spans a split BOM, comments, and blank lines", async () => {
  const input = Buffer.from(`\uFEFF: keepalive\r\n\r\n\n${CONTENT_TURN}`, "utf8");
  const guard = new EmptyCompletionGuard("");
  const chunks = [];
  await pipeline(
    Readable.from([...input].map((byte) => Buffer.from([byte]))),
    guard,
    new Writable({
      write(chunk, _encoding, callback) {
        chunks.push(Buffer.from(chunk));
        callback();
      },
    }),
  );
  assert.equal(guard.isEmpty(), false);
  assert.equal(guard.hasContent(), true);
  assert.deepEqual(Buffer.concat(chunks), input);
});

test("non-SSE bodies pass through byte for byte and are never empty", async () => {
  const json = JSON.stringify({
    id: "resp_1",
    output: [{ type: "message", content: [{ type: "output_text", text: "hi" }] }],
  });
  const { body, empty } = await runGuard(json, { contentType: "application/json" });
  assert.equal(empty, false);
  assert.equal(body, json);
});

test("a byte limit fails before relaying any staged bytes", async () => {
  const guard = new EmptyCompletionGuard("text/event-stream", { maxPreludeBytes: 1 });
  const chunks = [];
  await assert.rejects(
    pipeline(
      Readable.from([Buffer.from(SILENT_TURN)]),
      guard,
      new Writable({
        write(chunk, _encoding, callback) {
          chunks.push(Buffer.from(chunk));
          callback();
        },
      }),
    ),
    (error) =>
      error instanceof EmptyCompletionPreludeLimitError && error.kind === "bytes",
  );
  assert.equal(guard.isEmpty(), false);
  assert.equal(guard.suppressedPrologue(), true);
  assert.equal(Buffer.concat(chunks).length, 0);
});

test("a large parseable prologue is relayed at the byte budget and later content wins", async () => {
  const prologue = [
    "event: response.created",
    `data: ${JSON.stringify({
      type: "response.created",
      response: { id: "r1", metadata: "x".repeat(256) },
    })}`,
    "",
    "",
  ].join("\n");
  const answer = [
    "event: response.output_text.delta",
    'data: {"type":"response.output_text.delta","delta":"ok"}',
    "",
    "event: response.completed",
    'data: {"type":"response.completed","response":{"id":"r1","output":[]}}',
    "",
    "",
  ].join("\n");
  const guard = new EmptyCompletionGuard("text/event-stream", {
    maxPreludeBytes: 64,
    maxPreludeMs: 1_000,
  });
  const chunks = [];
  await pipeline(
    Readable.from([Buffer.from(prologue), Buffer.from(answer)]),
    guard,
    new Writable({
      write(chunk, _encoding, callback) {
        chunks.push(Buffer.from(chunk));
        callback();
      },
    }),
  );
  assert.equal(guard.hasContent(), true);
  assert.equal(guard.isEmpty(), false);
  assert.equal(guard.suppressedPrologue(), false);
  assert.equal(guard.preludeLimitKind(), "bytes");
  assert.equal(Buffer.concat(chunks).toString("utf8"), prologue + answer);
});

test("a fragmented initial event can finish before the prelude verdict", async () => {
  const prologue = `event: response.created\ndata: ${JSON.stringify({
    type: "response.created",
    response: { id: "r1", tools: Array.from({ length: 32 }, (_, index) => ({
      type: "function", name: `tool_${index}`, description: "x".repeat(45_000),
      parameters: { type: "object", properties: {} },
    })) },
  })}\n\n`;
  const answer = 'event: response.output_item.added\n'
    + 'data: {"type":"response.output_item.added","item":{"type":"function_call","name":"tool_0","call_id":"call_1","arguments":"{}"}}\n\n';
  assert.ok(Buffer.byteLength(prologue) > 1024 * 1024);
  for (const chunkSize of [0, 1024, 64 * 1024]) {
    const result = await runGuard(prologue + answer, { chunkSize });
    assert.equal(result.body, prologue + answer);
    assert.equal(result.empty, false);
    assert.equal(result.suppressed, false);
  }
});

test("a fragmented prelude still hides empty terminal events after release", async () => {
  const prologue = `event: response.created\ndata: ${JSON.stringify({
    type: "response.created", response: { id: "r1", metadata: "x".repeat(256) },
  })}\n\n`;
  const terminal = 'event: response.completed\n'
    + 'data: {"type":"response.completed","response":{"id":"r1","output":[]}}\n\n';
  async function* fragmentedTurn() {
    for (let at = 0; at < prologue.length; at += 32) yield prologue.slice(at, at + 32);
    yield terminal;
  }
  const guard = new EmptyCompletionGuard("text/event-stream", { maxPreludeBytes: 64 });
  const chunks = [];
  await pipeline(
    Readable.from(fragmentedTurn()),
    guard,
    new EmptyCompletionTerminalGuard(guard, "text/event-stream"),
    new Writable({
      write(chunk, _encoding, callback) {
        chunks.push(Buffer.from(chunk));
        callback();
      },
    }),
  );
  assert.equal(Buffer.concat(chunks).toString("utf8"), prologue);
  assert.equal(guard.isEmpty(), true);
  assert.equal(guard.suppressedPrologue(), false);
});

test("a valid event does not excuse a later oversized unterminated event", async () => {
  const created = [
    "event: response.created",
    'data: {"type":"response.created","response":{"id":"r1"}}',
    "",
    "",
  ].join("\n");
  const guard = new EmptyCompletionGuard("text/event-stream", {
    maxPreludeBytes: 64,
    maxPreludeMs: 1_000,
  });
  const chunks = [];
  await assert.rejects(
    pipeline(
      Readable.from([
        Buffer.from(created + `event: response.in_progress\ndata: ${"x".repeat(11 * 1024 * 1024)}`),
      ]),
      guard,
      new Writable({
        write(chunk, _encoding, callback) {
          chunks.push(Buffer.from(chunk));
          callback();
        },
      }),
    ),
    (error) =>
      error instanceof EmptyCompletionPreludeLimitError && error.kind === "bytes",
  );
  assert.equal(guard.suppressedPrologue(), true);
  assert.equal(Buffer.concat(chunks).length, 0);
});

test("malformed completed blocks cannot accumulate behind an unfinished event", async () => {
  await assert.rejects(
    runGuard("data: invalid\n\n".repeat(16) + 'data: {', { maxPreludeBytes: 64 }),
    (error) => error instanceof EmptyCompletionPreludeLimitError && error.kind === "bytes",
  );
});

test("a time limit relays the staged stream but keeps its empty verdict", async () => {
  const split = SILENT_TURN.indexOf("event: response.completed");
  async function* delayedTurn() {
    yield Buffer.from(SILENT_TURN.slice(0, split));
    await new Promise((resolve) => setTimeout(resolve, 20));
    yield Buffer.from(SILENT_TURN.slice(split));
  }
  const guard = new EmptyCompletionGuard("", {
    maxPreludeMs: 5,
    maxStreamStallMs: 100,
  });
  const chunks = [];
  await pipeline(
    Readable.from(delayedTurn()),
    guard,
    new Writable({
      write(chunk, _encoding, callback) {
        chunks.push(Buffer.from(chunk));
        callback();
      },
    }),
  );
  assert.equal(guard.isEmpty(), true);
  assert.equal(guard.suppressedPrologue(), false);
  assert.equal(guard.preludeLimitKind(), "time");
  assert.equal(Buffer.concat(chunks).toString("utf8"), SILENT_TURN);
});

test("a headers-only stream fails the time bound before relaying anything", async () => {
  async function* delayedBody() {
    await new Promise((resolve) => setTimeout(resolve, 30));
    yield Buffer.from(CONTENT_TURN);
  }
  const guard = new EmptyCompletionGuard("text/event-stream", {
    maxPreludeMs: 5,
  });
  const chunks = [];
  await assert.rejects(
    pipeline(
      Readable.from(delayedBody()),
      guard,
      new Writable({
        write(chunk, _encoding, callback) {
          chunks.push(Buffer.from(chunk));
          callback();
        },
      }),
    ),
    (error) =>
      error instanceof EmptyCompletionPreludeLimitError && error.kind === "time",
  );
  assert.equal(guard.suppressedPrologue(), true);
  assert.equal(Buffer.concat(chunks).length, 0);
});

test("post-release parsing is bounded for an unterminated event", async () => {
  const reasoning = [
    "event: response.reasoning_text.delta",
    'data: {"type":"response.reasoning_text.delta","delta":"thinking"}',
    "",
    "",
  ].join("\n");
  const guard = new EmptyCompletionGuard("text/event-stream", {
    maxPreludeBytes: 1024 * 1024, // 1MB pre-release limit
    maxPreludeMs: 1_000,
  });
  const chunks = [];
  // Post-release limit is 10MB, so send >10MB in an unterminated event
  const hugeUnterminated = `event: response.in_progress\ndata: ${"x".repeat(11 * 1024 * 1024)}`;
  await assert.rejects(
    pipeline(
      Readable.from([
        Buffer.from(reasoning),
        Buffer.from(hugeUnterminated),
      ]),
      guard,
      new Writable({
        write(chunk, _encoding, callback) {
          chunks.push(Buffer.from(chunk));
          callback();
        },
      }),
    ),
    (error) =>
      error instanceof EmptyCompletionPreludeLimitError && error.kind === "bytes",
  );
  assert.equal(guard.suppressedPrologue(), false);
  assert.match(Buffer.concat(chunks).toString("utf8"), /thinking/);
});

test("a content release is unaffected by the pre-content limits", async () => {
  const { empty } = await runGuard(CONTENT_TURN);
  assert.equal(empty, false);
  // content release goes through the same runGuard pipeline, so re-run with a
  // direct guard to assert the accessor stays false for a content verdict
  const guard = new EmptyCompletionGuard("text/event-stream");
  await pipeline(
    Readable.from([Buffer.from(CONTENT_TURN)]),
    guard,
    new Writable({
      write(_chunk, _encoding, callback) {
        callback();
      },
    }),
  );
  assert.equal(guard.hasContent(), true);
});

test("a terminal event whose data fails to parse is indeterminate, not empty", async () => {
  const input = [
    "event: response.created",
    'data: {"type":"response.created","response":{"id":"r1"}}',
    "",
    "event: response.completed",
    "data: {not valid json",
    "",
    "event: response.done",
    'data: {"type":"response.done","response":{"id":"r1"}}',
    "",
  ].join("\n");
  const guard = new EmptyCompletionGuard("text/event-stream");
  const chunks = [];
  await pipeline(
    Readable.from([Buffer.from(input)]),
    guard,
    new Writable({
      write(chunk, _encoding, callback) {
        chunks.push(Buffer.from(chunk));
        callback();
      },
    }),
  );
  // A parse failure at the terminal event is not evidence of "nothing was
  // produced": the guard must not declare the turn empty and force a retry.
  assert.equal(guard.isEmpty(), false);
  assert.equal(guard.hasContent(), false);
  assert.equal(Buffer.concat(chunks).toString("utf8"), input);
});
