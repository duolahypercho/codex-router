import assert from "node:assert/strict";
import { Readable, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import test from "node:test";

import {
  labelResponseOutput,
  MessagePhaseTransform,
  messagePhaseTransform,
  withoutInputMessagePhase,
} from "../src/message-phase.mjs";

function block(event, sep = "\n\n") {
  return `event: ${event.type}\ndata: ${JSON.stringify(event)}${sep}`;
}

async function label(input, { chunkSize = 0, maxHeldBytes } = {}) {
  const transform = new MessagePhaseTransform(maxHeldBytes ? { maxHeldBytes } : {});
  const chunks = [];
  const collector = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(Buffer.from(chunk));
      callback();
    },
  });
  const buffer = Buffer.from(input);
  const source = [];
  if (chunkSize > 0) {
    for (let at = 0; at < buffer.length; at += chunkSize) source.push(buffer.subarray(at, at + chunkSize));
  } else {
    source.push(buffer);
  }
  await pipeline(Readable.from(source), transform, collector);
  return Buffer.concat(chunks);
}

function events(body) {
  return body
    .toString("utf8")
    .split(/\r?\n\r?\n/)
    .map((frame) => frame.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim()).join("\n"))
    .filter((data) => data && data !== "[DONE]")
    .map((data) => JSON.parse(data));
}

const message = (id, text, extra = {}) => ({
  id,
  type: "message",
  role: "assistant",
  status: "completed",
  content: [{ type: "output_text", text, annotations: [] }],
  ...extra,
});
const call = (id) => ({ id, type: "function_call", call_id: id, name: "exec_command", arguments: "{}" });
const reasoning = (id) => ({ id, type: "reasoning", summary: [{ type: "summary_text", text: "Thinking." }] });

function reasoningFrames(index, item) {
  return [
    block({ type: "response.output_item.added", output_index: index, item: { ...item, summary: [] } }),
    block({
      type: "response.reasoning_summary_text.delta",
      output_index: index,
      item_id: item.id,
      summary_index: 0,
      delta: item.summary[0].text,
    }),
    block({ type: "response.output_item.done", output_index: index, item }),
  ];
}

function messageFrames(index, item) {
  return [
    block({ type: "response.output_item.added", output_index: index, item: { ...item, content: [] } }),
    block({ type: "response.output_text.delta", output_index: index, item_id: item.id, delta: item.content[0].text }),
    block({ type: "response.output_item.done", output_index: index, item }),
  ];
}

function callFrames(index, item) {
  return [
    block({ type: "response.output_item.added", output_index: index, item: { ...item, arguments: "" } }),
    block({ type: "response.function_call_arguments.done", output_index: index, item_id: item.id, arguments: "{}" }),
    block({ type: "response.output_item.done", output_index: index, item }),
  ];
}

function donePhases(body) {
  return events(body)
    .filter((event) => event.type === "response.output_item.done" && event.item.type === "message")
    .map((event) => `${event.item.id}:${event.item.phase}`);
}

const TOOL_TURN = [
  block({ type: "response.created", response: { id: "r1" } }),
  ...messageFrames(0, message("m1", "Checking the config.")),
  ...callFrames(1, call("c1")),
  block({ type: "response.completed", response: { id: "r1", output: [message("m1", "Checking the config."), call("c1")] } }),
  "data: [DONE]\n\n",
].join("");

const ANSWER_TURN = [
  block({ type: "response.created", response: { id: "r2" } }),
  ...messageFrames(0, message("m2", "Done.")),
  block({ type: "response.completed", response: { id: "r2", output: [message("m2", "Done.")] } }),
  "data: [DONE]\n\n",
].join("");

test("a message followed by a tool call is commentary", async () => {
  const out = await label(TOOL_TURN);
  assert.deepEqual(donePhases(out), ["m1:commentary"]);
  const completed = events(out).find((event) => event.type === "response.completed");
  assert.equal(completed.response.output[0].phase, "commentary");
  assert.equal(completed.response.output[1].phase, undefined);
});

test("the last message of a completed response is the final answer", async () => {
  const out = await label(ANSWER_TURN);
  assert.deepEqual(donePhases(out), ["m2:final_answer"]);
  const completed = events(out).find((event) => event.type === "response.completed");
  assert.equal(completed.response.output[0].phase, "final_answer");
});

test("consecutive messages: only the last one is the final answer", async () => {
  const input = [
    ...messageFrames(0, message("m1", "First.")),
    ...messageFrames(1, message("m2", "Second.")),
    block({ type: "response.completed", response: { id: "r", output: [message("m1", "First."), message("m2", "Second.")] } }),
  ].join("");
  const out = await label(input);
  assert.deepEqual(donePhases(out), ["m1:commentary", "m2:final_answer"]);
  const completed = events(out).find((event) => event.type === "response.completed");
  assert.deepEqual(completed.response.output.map((item) => item.phase), ["commentary", "final_answer"]);
});

test("labels only message done frames; every other frame and the order are unchanged", async () => {
  const out = await label(TOOL_TURN);
  const before = events(Buffer.from(TOOL_TURN));
  const after = events(out);
  assert.equal(after.length, before.length);
  after.forEach((event, index) => {
    assert.equal(event.type, before[index].type, `event ${index} type`);
    if (event.type === "response.output_item.done" && event.item.type === "message") {
      assert.deepEqual({ ...event.item, phase: undefined }, { ...before[index].item, phase: undefined });
    } else if (event.type !== "response.completed") {
      assert.deepEqual(event, before[index], `event ${index}`);
    }
  });
});

test("labels identically regardless of upstream chunk boundaries", async () => {
  const whole = await label(TOOL_TURN);
  for (const chunkSize of [1, 7, 64, 500]) {
    assert.deepEqual(await label(TOOL_TURN, { chunkSize }), whole, `chunkSize=${chunkSize}`);
  }
});

test("a phase the provider already sent is never overwritten", async () => {
  const input = [
    ...messageFrames(0, message("m1", "Native.", { phase: "commentary" })),
    block({ type: "response.completed", response: { id: "r", output: [message("m1", "Native.", { phase: "commentary" })] } }),
    "data: [DONE]\n\n",
  ].join("");
  assert.equal((await label(input)).toString("utf8"), input);
});

test("tool-only and message-free streams pass through byte-for-byte", async () => {
  const input = [
    block({ type: "response.created", response: { id: "r" } }),
    ...callFrames(0, call("c1")),
    block({ type: "response.completed", response: { id: "r", output: [call("c1")] } }),
    "data: [DONE]\n\n",
  ].join("");
  assert.equal((await label(input)).toString("utf8"), input);
});

test("failed, incomplete, errored, and unterminated responses release the message unlabelled", async () => {
  const head = messageFrames(0, message("m1", "Partial.")).join("");
  for (const tail of [
    block({ type: "response.failed", response: { id: "r", error: { message: "boom" } } }),
    block({ type: "response.incomplete", response: { id: "r", status: "incomplete", output: [] } }),
    block({ type: "error", error: { message: "boom" } }),
    "data: [DONE]\n\n",
    "",
  ]) {
    const input = head + tail;
    assert.equal((await label(input)).toString("utf8"), input, JSON.stringify(tail.slice(0, 40)));
  }
});

test("frames held behind the message keep their order and bytes", async () => {
  const input = [
    ...messageFrames(0, message("m1", "Wait.")),
    ": keep-alive\n\n",
    block({ type: "response.in_progress", response: { id: "r" } }),
    ...callFrames(1, call("c1")),
  ].join("");
  const out = (await label(input)).toString("utf8");
  const labelledDone = out.indexOf('"phase":"commentary"');
  const comment = out.indexOf(": keep-alive");
  const progress = out.indexOf('"response.in_progress"');
  const callAdded = out.indexOf('"type":"function_call"');
  assert.ok(labelledDone !== -1 && labelledDone < comment && comment < progress && progress < callAdded);
  assert.equal(out.replace(',"phase":"commentary"', ""), input);
});

test("exceeding the hold bound releases the message unlabelled", async () => {
  const input = [
    ...messageFrames(0, message("m1", "Slow.")),
    ...Array.from({ length: 20 }, (_, index) => `: filler ${"x".repeat(32)} ${index}\n\n`),
    ...callFrames(1, call("c1")),
  ].join("");
  assert.equal((await label(input, { maxHeldBytes: 256 })).toString("utf8"), input);
});

test("CRLF framing and extra field lines are preserved when labelling", async () => {
  const crlfBlock = (event, prefix = "") =>
    `${prefix}event: ${event.type}\r\ndata: ${JSON.stringify(event)}\r\n\r\n`;
  const input = [
    crlfBlock({ type: "response.output_item.added", output_index: 0, item: { ...message("m1", "x"), content: [] } }),
    crlfBlock({ type: "response.output_item.done", output_index: 0, item: message("m1", "x") }, "id: 7\r\n"),
    crlfBlock({ type: "response.completed", response: { id: "r", output: [] } }),
  ].join("");
  const out = (await label(input)).toString("utf8");
  assert.deepEqual(donePhases(Buffer.from(out)), ["m1:final_answer"]);
  assert.ok(out.includes("id: 7\r\nevent: response.output_item.done\r\ndata: "));
  assert.ok(!/[^\r]\n/.test(out), "every line ending stays CRLF");
});

test("invalid UTF-8 disables labelling and relays the original bytes", async () => {
  const invalid = Buffer.concat([
    Buffer.from(messageFrames(0, message("m1", "x")).join("")),
    Buffer.from([0x64, 0x61, 0x74, 0x61, 0x3a, 0x20, 0xff, 0x0a, 0x0a]),
    Buffer.from(ANSWER_TURN),
  ]);
  assert.deepEqual(await label(invalid), invalid);
});

test("labelResponseOutput leaves labelled and non-message output alone", () => {
  assert.equal(labelResponseOutput([call("c1")]), undefined);
  assert.equal(labelResponseOutput([message("m1", "x", { phase: "final_answer" })]), undefined);
  assert.equal(labelResponseOutput(undefined), undefined);
});

test("labelResponseOutput lets only tool calls and messages make a message commentary", () => {
  const phases = (output) => labelResponseOutput(output).map((item) => item.phase);
  assert.deepEqual(phases([message("m1", "x"), reasoning("rs1")]), ["final_answer", undefined]);
  assert.deepEqual(phases([message("m1", "x"), reasoning("rs1"), call("c1")]), ["commentary", undefined, undefined]);
  assert.deepEqual(phases([message("m1", "x"), reasoning("rs1"), message("m2", "y"), reasoning("rs2")]), [
    "commentary",
    undefined,
    "final_answer",
    undefined,
  ]);
});

test("a message followed only by reasoning is still the final answer", async () => {
  const input = [
    block({ type: "response.created", response: { id: "r" } }),
    ...messageFrames(0, message("m1", "Done.")),
    ...reasoningFrames(1, reasoning("rs1")),
    block({ type: "response.completed", response: { id: "r", output: [message("m1", "Done."), reasoning("rs1")] } }),
    "data: [DONE]\n\n",
  ].join("");
  const out = await label(input);
  assert.deepEqual(donePhases(out), ["m1:final_answer"]);
  const completed = events(out).find((event) => event.type === "response.completed");
  assert.deepEqual(completed.response.output.map((item) => item.phase), ["final_answer", undefined]);
  assert.equal(out.toString("utf8").replaceAll(',"phase":"final_answer"', ""), input);
});

test("reasoning between a message and a tool call is held, and the message stays commentary", async () => {
  const input = [
    ...messageFrames(0, message("m1", "Checking.")),
    ...reasoningFrames(1, reasoning("rs1")),
    ...callFrames(2, call("c1")),
    block({
      type: "response.completed",
      response: { id: "r", output: [message("m1", "Checking."), reasoning("rs1"), call("c1")] },
    }),
  ].join("");
  const out = await label(input);
  assert.deepEqual(donePhases(out), ["m1:commentary"]);
  const completed = events(out).find((event) => event.type === "response.completed");
  assert.deepEqual(completed.response.output.map((item) => item.phase), ["commentary", undefined, undefined]);
  assert.equal(out.toString("utf8").replaceAll(',"phase":"commentary"', ""), input);
  for (const chunkSize of [1, 13, 256]) {
    assert.deepEqual(await label(input, { chunkSize }), out, `chunkSize=${chunkSize}`);
  }
});

test("an incomplete response keeps earlier commentary but labels neither its last message nor its snapshot", async () => {
  const output = [message("m1", "Checking."), call("c1"), message("m2", "Truncat")];
  const input = [
    ...messageFrames(0, output[0]),
    ...callFrames(1, output[1]),
    ...messageFrames(2, output[2]),
    block({
      type: "response.incomplete",
      response: { id: "r", status: "incomplete", incomplete_details: { reason: "max_output_tokens" }, output },
    }),
  ].join("");
  const out = await label(input);
  assert.deepEqual(donePhases(out), ["m1:commentary", "m2:undefined"]);
  const incomplete = events(out).find((event) => event.type === "response.incomplete");
  assert.deepEqual(incomplete.response.output.map((item) => item.phase), [undefined, undefined, undefined]);
});

test("reasoning held behind a message still respects the hold bound", async () => {
  const input = [
    ...messageFrames(0, message("m1", "Slow.")),
    block({ type: "response.output_item.added", output_index: 1, item: { ...reasoning("rs1"), summary: [] } }),
    ...Array.from({ length: 20 }, (_, index) =>
      block({
        type: "response.reasoning_summary_text.delta",
        output_index: 1,
        item_id: "rs1",
        summary_index: 0,
        delta: `${"x".repeat(32)} ${index}`,
      })),
    block({ type: "response.output_item.done", output_index: 1, item: reasoning("rs1") }),
    block({ type: "response.completed", response: { id: "r", output: [] } }),
  ].join("");
  assert.equal((await label(input, { maxHeldBytes: 512 })).toString("utf8"), input);
});

test("an upstream error destroys the stage with its held frame; a clean end releases it", async () => {
  const head = messageFrames(0, message("m1", "Partial.")).join("");
  const chunks = [];
  const source = new Readable({ read() {} });
  const collector = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(Buffer.from(chunk));
      callback();
    },
  });
  const run = pipeline(source, new MessagePhaseTransform(), collector);
  source.push(head);
  for (let turn = 0; turn < 1000 && !Buffer.concat(chunks).includes("response.output_text.delta"); turn += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  source.destroy(new Error("upstream reset"));
  await assert.rejects(run, /upstream reset/);
  const relayed = Buffer.concat(chunks).toString("utf8");
  assert.ok(relayed.includes('"response.output_text.delta"'), "frames before the message done were relayed");
  assert.ok(!relayed.includes('"response.output_item.done"'), "the held done frame is lost with the stream");
  // Control: the same frames ending cleanly release the held frame untouched.
  assert.equal((await label(head)).toString("utf8"), head);
});

test("withoutInputMessagePhase omits phase from message input items only", () => {
  const input = [
    { type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] },
    message("m1", "Checking.", { phase: "commentary" }),
    { ...call("c1"), phase: "commentary" },
    { role: "assistant", content: "Done.", phase: "final_answer" },
  ];
  const out = withoutInputMessagePhase(input);
  assert.deepEqual(out.map((item) => Object.hasOwn(item, "phase")), [false, false, true, false]);
  assert.equal(out[0], input[0]);
  assert.deepEqual(out[1], message("m1", "Checking."));
  assert.equal(input[1].phase, "commentary", "the caller's input is not mutated");
  const clean = [input[0], call("c1")];
  assert.equal(withoutInputMessagePhase(clean), clean);
  assert.equal(withoutInputMessagePhase("text"), "text");
  assert.equal(withoutInputMessagePhase(undefined), undefined);
});

test("the factory attaches only to event streams", () => {
  assert.ok(messagePhaseTransform("text/event-stream; charset=utf-8") instanceof MessagePhaseTransform);
  assert.equal(messagePhaseTransform("application/json"), undefined);
});
