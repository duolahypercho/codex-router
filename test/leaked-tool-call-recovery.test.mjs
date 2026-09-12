import assert from "node:assert/strict";
import { Readable, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import test from "node:test";

import {
  LeakedToolCallRecovery,
  leakedToolCallRecoveryTransform,
  parseLeakedToolCalls,
  usesLeakedToolCallRecovery,
} from "../src/leaked-tool-call-recovery.mjs";

const N = "6124c78e";

// Captured verbatim from rollout 01a0924e-de19-7042-9b8b-aef75e701ea9 (opencode-go
// hy4-preview, 12 September 2026): the turn that ended with "Worked for 3m 58s"
// and no assistant message at all.
const LIVE_REASONING =
  "Boot is running. Let me keep reading the behavior code while it comes up." +
  `<tool_calls:${N}><tool_call:${N}>exec_command` +
  `<arg_key:${N}>cmd</arg_key:${N}>` +
  `<arg_value:${N}>sleep 20; tail -5 .qa/eo-up.log</arg_value:${N}>` +
  `<arg_key:${N}>workdir</arg_key:${N}>` +
  `<arg_value:${N}>/Users/ziwenxu/Desktop/Code/EarthOnline</arg_value:${N}>` +
  `</tool_call:${N}>` +
  `<tool_call:${N}>exec_command` +
  `<arg_key:${N}>cmd</arg_key:${N}>` +
  `<arg_value:${N}>grep -n "turnRate" src/pedestrians.js</arg_value:${N}>` +
  `<arg_key:${N}>workdir</arg_key:${N}>` +
  `<arg_value:${N}>/Users/ziwenxu/Desktop/Code/EarthOnline</arg_value:${N}>` +
  `</tool_call:${N}></tool_calls:${N}>`;

function block(event, sep = "\n\n") {
  return `event: ${event.type}\ndata: ${JSON.stringify(event)}${sep}`;
}

async function run(input, { chunkSize = 0 } = {}) {
  const transform = new LeakedToolCallRecovery();
  const chunks = [];
  const sink = new Writable({
    write(chunk, _e, cb) {
      chunks.push(Buffer.from(chunk));
      cb();
    },
  });
  const source = [];
  if (chunkSize > 0) {
    const buf = Buffer.from(input);
    for (let at = 0; at < buf.length; at += chunkSize) {
      source.push(buf.subarray(at, at + chunkSize));
    }
  } else {
    source.push(Buffer.from(input));
  }
  await pipeline(Readable.from(source), transform, sink);
  return { body: Buffer.concat(chunks).toString("utf8"), transform };
}

function events(body) {
  const out = [];
  for (const chunk of body.split(/\r?\n\r?\n/)) {
    const line = chunk.split(/\r?\n/).find((l) => l.startsWith("data:"));
    if (!line) continue;
    const text = line.slice(5).trim();
    if (!text || text === "[DONE]") continue;
    try {
      out.push(JSON.parse(text));
    } catch {
      // not a JSON event
    }
  }
  return out;
}

function functionCalls(body) {
  return events(body)
    .filter((e) => e.type === "response.output_item.done" && e.item?.type === "function_call")
    .map((e) => ({ name: e.item.name, arguments: e.item.arguments, output_index: e.output_index }));
}

test("parses the live capture into the two calls the model meant to make", () => {
  const parsed = parseLeakedToolCalls(LIVE_REASONING);
  assert.ok(parsed);
  assert.equal(parsed.cleaned, "Boot is running. Let me keep reading the behavior code while it comes up.");
  assert.deepEqual(
    parsed.calls.map((c) => c.name),
    ["exec_command", "exec_command"],
  );
  assert.deepEqual(JSON.parse(parsed.calls[0].arguments), {
    cmd: "sleep 20; tail -5 .qa/eo-up.log",
    workdir: "/Users/ziwenxu/Desktop/Code/EarthOnline",
  });
  assert.deepEqual(JSON.parse(parsed.calls[1].arguments), {
    cmd: 'grep -n "turnRate" src/pedestrians.js',
    workdir: "/Users/ziwenxu/Desktop/Code/EarthOnline",
  });
});

test("parses the shape the tool probe captured on the commandcode route", () => {
  // From the 28 August 2026 agent-check report for commandcode/hy4-preview,
  // which failed its tool-call check with exactly this text.
  const parsed = parseLeakedToolCalls(
    `We need to output:\n\n<tool_calls:${N}><tool_call:${N}>codex_router_probe` +
      `<arg_key:${N}>value</arg_key:${N}><arg_value:${N}>ok</arg_value:${N}>` +
      `</tool_call:${N}></tool_calls:${N}>`,
  );
  assert.ok(parsed);
  assert.equal(parsed.cleaned, "We need to output:");
  assert.equal(parsed.calls.length, 1);
  assert.equal(parsed.calls[0].name, "codex_router_probe");
  assert.deepEqual(JSON.parse(parsed.calls[0].arguments), { value: "ok" });
});

test("text without the markup is left exactly alone", () => {
  assert.equal(parseLeakedToolCalls("Let me look at the locomotion code."), undefined);
  assert.equal(parseLeakedToolCalls("a < b and c > d"), undefined);
  assert.equal(parseLeakedToolCalls(""), undefined);
  assert.equal(parseLeakedToolCalls(undefined), undefined);
});

test("malformed markup is never eaten", () => {
  // Unterminated span.
  assert.equal(parseLeakedToolCalls(`prose <tool_calls:${N}><tool_call:${N}>x`), undefined);
  // Nonce mismatch between open and close.
  assert.equal(
    parseLeakedToolCalls(`<tool_calls:${N}><tool_call:${N}>x</tool_call:${N}></tool_calls:deadbeef>`),
    undefined,
  );
  // Opening marker without a nonce.
  assert.equal(parseLeakedToolCalls("<tool_calls:>nope</tool_calls:>"), undefined);
  // A name that is not a tool name.
  assert.equal(
    parseLeakedToolCalls(`<tool_calls:${N}><tool_call:${N}>not a name</tool_call:${N}></tool_calls:${N}>`),
    undefined,
  );
});

test("a declared number or boolean survives, and a command string does not become one", () => {
  const parsed = parseLeakedToolCalls(
    `<tool_calls:${N}><tool_call:${N}>exec_command` +
      `<arg_key:${N}>timeout_ms</arg_key:${N}><arg_value:${N}>20000</arg_value:${N}>` +
      `<arg_key:${N}>login</arg_key:${N}><arg_value:${N}>true</arg_value:${N}>` +
      `<arg_key:${N}>cmd</arg_key:${N}><arg_value:${N}>chmod 0755 run.sh</arg_value:${N}>` +
      `</tool_call:${N}></tool_calls:${N}>`,
  );
  assert.deepEqual(JSON.parse(parsed.calls[0].arguments), {
    timeout_ms: 20000,
    login: true,
    cmd: "chmod 0755 run.sh",
  });
});

test("the dead turn now ends with the model's two calls", async () => {
  const stream =
    block({ type: "response.created", sequence_number: 1, response: { id: "resp_1" } }) +
    block({
      type: "response.output_item.added",
      sequence_number: 2,
      output_index: 0,
      item: { type: "reasoning", id: "rs_1", summary: [] },
    }) +
    block({
      type: "response.reasoning_summary_text.delta",
      sequence_number: 3,
      output_index: 0,
      delta: LIVE_REASONING,
    }) +
    block({
      type: "response.reasoning_summary_text.done",
      sequence_number: 4,
      output_index: 0,
      text: LIVE_REASONING,
    }) +
    block({
      type: "response.output_item.done",
      sequence_number: 5,
      output_index: 0,
      item: { type: "reasoning", id: "rs_1", summary: [{ type: "summary_text", text: LIVE_REASONING }] },
    }) +
    block({
      type: "response.output_item.added",
      sequence_number: 6,
      output_index: 1,
      item: { type: "message", id: "msg_1", role: "assistant", content: [] },
    }) +
    block({
      type: "response.output_item.done",
      sequence_number: 7,
      output_index: 1,
      item: { type: "message", id: "msg_1", role: "assistant", content: [] },
    }) +
    block({
      type: "response.completed",
      sequence_number: 8,
      response: {
        id: "resp_1",
        output: [
          { type: "reasoning", id: "rs_1" },
          { type: "message", id: "msg_1", content: [] },
        ],
      },
    });

  const { body, transform } = await run(stream);
  const calls = functionCalls(body);
  assert.equal(transform.recoveredCalls(), 2);
  assert.equal(calls.length, 2);
  assert.deepEqual(
    calls.map((c) => c.name),
    ["exec_command", "exec_command"],
  );
  assert.deepEqual(JSON.parse(calls[0].arguments), {
    cmd: "sleep 20; tail -5 .qa/eo-up.log",
    workdir: "/Users/ziwenxu/Desktop/Code/EarthOnline",
  });
  // Fresh, unique call ids so replayed history never collides.
  const ids = events(body)
    .filter((e) => e.item?.type === "function_call")
    .map((e) => e.item.call_id);
  assert.equal(new Set(ids).size, 2);
  for (const id of ids) assert.match(id, /^call_router_recovered_[0-9a-f]{32}$/);

  // Both calls sit ahead of the terminal event and are mirrored into its output.
  const types = events(body).map((e) => e.type);
  const completedAt = types.indexOf("response.completed");
  const lastCallAt = types.lastIndexOf("response.output_item.done");
  assert.ok(lastCallAt < completedAt);
  const completed = events(body).find((e) => e.type === "response.completed");
  assert.deepEqual(
    completed.response.output.filter((i) => i.type === "function_call").map((i) => i.name),
    ["exec_command", "exec_command"],
  );
  // They come after the items that were already open, on their own indices.
  assert.deepEqual(
    calls.map((c) => c.output_index),
    [2, 3],
  );
});

test("the markup never reaches the client as reasoning text", async () => {
  const stream =
    block({ type: "response.reasoning_summary_text.delta", output_index: 0, delta: LIVE_REASONING }) +
    block({ type: "response.reasoning_summary_text.done", output_index: 0, text: LIVE_REASONING }) +
    block({
      type: "response.output_item.done",
      output_index: 0,
      item: { type: "reasoning", summary: [{ type: "summary_text", text: LIVE_REASONING }] },
    }) +
    block({ type: "response.completed", response: { id: "r", output: [] } });
  const { body } = await run(stream);
  assert.ok(!body.includes("tool_calls:"));
  assert.ok(!body.includes("arg_key"));
  assert.ok(body.includes("Let me keep reading the behavior code"));
});

test("one item's calls are recovered once, however many channels repeat its text", async () => {
  // delta + done snapshot + stored item all carry the same span.
  const stream =
    block({ type: "response.reasoning_summary_text.delta", output_index: 0, delta: LIVE_REASONING }) +
    block({ type: "response.reasoning_summary_text.done", output_index: 0, text: LIVE_REASONING }) +
    block({
      type: "response.output_item.done",
      output_index: 0,
      item: { type: "reasoning", summary: [{ type: "summary_text", text: LIVE_REASONING }] },
    }) +
    block({ type: "response.completed", response: { id: "r", output: [] } });
  const { body, transform } = await run(stream);
  assert.equal(transform.recoveredCalls(), 2);
  assert.equal(functionCalls(body).length, 2);
});

test("a span split across deltas is recovered, at every chunk size", async () => {
  const head = LIVE_REASONING.slice(0, 90);
  const mid = LIVE_REASONING.slice(90, 200);
  const tail = LIVE_REASONING.slice(200);
  const stream =
    block({ type: "response.reasoning_summary_text.delta", output_index: 0, delta: head }) +
    block({ type: "response.reasoning_summary_text.delta", output_index: 0, delta: mid }) +
    block({ type: "response.reasoning_summary_text.delta", output_index: 0, delta: tail }) +
    block({ type: "response.completed", response: { id: "r", output: [] } });
  for (const chunkSize of [0, 1, 7, 64, 4096]) {
    const { body } = await run(stream, { chunkSize });
    const calls = functionCalls(body);
    assert.equal(calls.length, 2, `chunkSize=${chunkSize}`);
    assert.ok(!body.includes("arg_key"), `chunkSize=${chunkSize}`);
    assert.ok(body.includes("Boot is running."), `chunkSize=${chunkSize}`);
  }
});

test("the same leak on the content channel is recovered too", async () => {
  const stream =
    block({ type: "response.output_text.delta", output_index: 0, delta: LIVE_REASONING }) +
    block({
      type: "response.output_item.done",
      output_index: 0,
      item: { type: "message", role: "assistant", content: [{ type: "output_text", text: LIVE_REASONING }] },
    }) +
    block({ type: "response.completed", response: { id: "r", output: [] } });
  const { body } = await run(stream);
  assert.equal(functionCalls(body).length, 2);
  const message = events(body).find((e) => e.item?.type === "message");
  assert.equal(
    message.item.content[0].text,
    "Boot is running. Let me keep reading the behavior code while it comes up.",
  );
});

test("a clean stream is relayed byte-for-byte", async () => {
  const stream =
    block({ type: "response.created", sequence_number: 1, response: { id: "r" } }) +
    block({ type: "response.output_text.delta", output_index: 0, delta: "Paris" }) +
    block({
      type: "response.output_item.done",
      output_index: 0,
      item: { type: "message", content: [{ type: "output_text", text: "Paris" }] },
    }) +
    block({
      type: "response.completed",
      response: { id: "r", output: [{ type: "message", content: [] }] },
    }) +
    "data: [DONE]\n\n";
  for (const chunkSize of [0, 1, 13, 512]) {
    const { body, transform } = await run(stream, { chunkSize });
    assert.equal(body, stream, `chunkSize=${chunkSize}`);
    assert.equal(transform.recoveredCalls(), 0);
  }
});

test("a real function_call stream is untouched", async () => {
  const stream =
    block({
      type: "response.output_item.done",
      output_index: 0,
      item: { type: "function_call", name: "exec_command", call_id: "c1", arguments: '{"cmd":"ls"}' },
    }) +
    block({ type: "response.completed", response: { id: "r", output: [] } });
  const { body, transform } = await run(stream);
  assert.equal(body, stream);
  assert.equal(transform.recoveredCalls(), 0);
});

test("CRLF framing is preserved", async () => {
  const stream =
    block({ type: "response.reasoning_summary_text.done", output_index: 0, text: LIVE_REASONING }, "\r\n\r\n") +
    block({ type: "response.completed", response: { id: "r", output: [] } }, "\r\n\r\n");
  const { body } = await run(stream);
  assert.equal(functionCalls(body).length, 2);
  assert.ok(!body.includes("\n\n\n"));
  assert.ok(body.includes("\r\n\r\n"));
});

test("invalid UTF-8 disables rewriting and relays the original bytes", async () => {
  const head = Buffer.from(
    block({ type: "response.reasoning_summary_text.done", output_index: 0, text: LIVE_REASONING }),
  );
  const bad = Buffer.concat([Buffer.from("data: "), Buffer.from([0xff, 0xfe]), Buffer.from("\n\n")]);
  const tail = Buffer.from(block({ type: "response.completed", response: { id: "r", output: [] } }));
  const transform = new LeakedToolCallRecovery();
  const chunks = [];
  const sink = new Writable({
    write(chunk, _e, cb) {
      chunks.push(Buffer.from(chunk));
      cb();
    },
  });
  await pipeline(Readable.from([Buffer.concat([head, bad, tail])]), transform, sink);
  const out = Buffer.concat(chunks);
  assert.ok(out.includes(Buffer.from([0xff, 0xfe])));
  assert.ok(out.includes(Buffer.from("response.completed")));
});

test("the factory only attaches to event streams", () => {
  assert.equal(leakedToolCallRecoveryTransform("application/json"), undefined);
  assert.equal(leakedToolCallRecoveryTransform(""), undefined);
  assert.ok(leakedToolCallRecoveryTransform("text/event-stream; charset=utf-8"));
});

test("two spans in one item are both recovered, and neither is recovered twice", async () => {
  const span = (cmd) =>
    `<tool_calls:${N}><tool_call:${N}>exec_command` +
    `<arg_key:${N}>cmd</arg_key:${N}><arg_value:${N}>${cmd}</arg_value:${N}>` +
    `</tool_call:${N}></tool_calls:${N}>`;
  const whole = `first ${span("ls")} then ${span("pwd")}`;
  const stream =
    // The spans arrive in separate deltas, then the snapshot and the stored
    // item each repeat both.
    block({ type: "response.reasoning_summary_text.delta", output_index: 0, delta: `first ${span("ls")} then ` }) +
    block({ type: "response.reasoning_summary_text.delta", output_index: 0, delta: span("pwd") }) +
    block({ type: "response.reasoning_summary_text.done", output_index: 0, text: whole }) +
    block({
      type: "response.output_item.done",
      output_index: 0,
      item: { type: "reasoning", summary: [{ type: "summary_text", text: whole }] },
    }) +
    block({ type: "response.completed", response: { id: "r", output: [] } });
  const { body, transform } = await run(stream);
  assert.equal(transform.recoveredCalls(), 2);
  assert.deepEqual(
    functionCalls(body).map((c) => JSON.parse(c.arguments).cmd),
    ["ls", "pwd"],
  );
});

test("a snapshot that only repeats the deltas adds nothing", async () => {
  const stream =
    block({ type: "response.reasoning_summary_text.delta", output_index: 0, delta: LIVE_REASONING }) +
    block({ type: "response.reasoning_summary_text.done", output_index: 0, text: LIVE_REASONING }) +
    block({ type: "response.completed", response: { id: "r", output: [] } });
  const { transform } = await run(stream);
  assert.equal(transform.recoveredCalls(), 2);
});

test("only the snapshot carries the span when the provider sends no deltas", async () => {
  const stream =
    block({ type: "response.reasoning_summary_text.done", output_index: 0, text: LIVE_REASONING }) +
    block({ type: "response.completed", response: { id: "r", output: [] } });
  const { body, transform } = await run(stream);
  assert.equal(transform.recoveredCalls(), 2);
  assert.equal(functionCalls(body).length, 2);
});

test("only the stored item carries the span when there is no snapshot either", async () => {
  const stream =
    block({
      type: "response.output_item.done",
      output_index: 0,
      item: { type: "reasoning", summary: [{ type: "summary_text", text: LIVE_REASONING }] },
    }) +
    block({ type: "response.completed", response: { id: "r", output: [] } });
  const { body, transform } = await run(stream);
  assert.equal(transform.recoveredCalls(), 2);
  assert.equal(functionCalls(body).length, 2);
});

test("calls recovered from different items both reach the client", async () => {
  const stream =
    block({ type: "response.reasoning_summary_text.done", output_index: 0, text: LIVE_REASONING }) +
    block({
      type: "response.output_text.done",
      output_index: 1,
      text:
        `<tool_calls:${N}><tool_call:${N}>update_plan` +
        `<arg_key:${N}>note</arg_key:${N}><arg_value:${N}>done</arg_value:${N}>` +
        `</tool_call:${N}></tool_calls:${N}>`,
    }) +
    block({ type: "response.completed", response: { id: "r", output: [] } });
  const { body } = await run(stream);
  assert.deepEqual(
    functionCalls(body).map((c) => c.name),
    ["exec_command", "exec_command", "update_plan"],
  );
});

test("a stream that ends without a terminal event still hands over its calls", async () => {
  const stream = block({
    type: "response.reasoning_summary_text.done",
    output_index: 0,
    text: LIVE_REASONING,
  });
  const { body } = await run(stream);
  assert.equal(functionCalls(body).length, 2);
});

test("recovery is offered to Hy4 routes and to nothing else", () => {
  // This markup is Hy4's own tool-call syntax. Scanning every routed provider's
  // text for it would make prose that merely *quotes* it -- a diff, a web page,
  // this repository's own source -- into executed tool calls.
  for (const upstreamModel of ["hy4-preview", "tencent/hy4-preview"]) {
    assert.equal(usesLeakedToolCallRecovery({ upstreamModel }), true, upstreamModel);
  }
  for (const route of [
    null,
    undefined,
    {},
    { upstreamModel: "glm-5.3" },
    { upstreamModel: "deepseek-v4-flash" },
    { upstreamModel: "grok-4.6" },
    { upstreamModel: "moonshotai/kimi-k2.6" },
    { upstreamModel: "evil-hy4-preview-x" },
    { upstreamModel: "hy4-preview-turbo" },
  ]) {
    assert.equal(usesLeakedToolCallRecovery(route), false, JSON.stringify(route));
  }
});

test("one item's calls are recovered once even when both channels carry the span", async () => {
  // `summary` and `content` are two renderings of one item's thinking. Sharing
  // a span stream between them made the second reading look like a genuine
  // extension of the first, and the call was recovered -- and executed -- twice.
  const both =
    block({ type: "response.reasoning_summary_text.delta", output_index: 0, delta: LIVE_REASONING }) +
    block({ type: "response.reasoning_text.delta", output_index: 0, delta: LIVE_REASONING }) +
    block({ type: "response.completed", response: { id: "r", output: [] } });
  assert.equal(functionCalls((await run(both)).body).length, 2);

  const storedBoth =
    block({
      type: "response.output_item.done",
      output_index: 0,
      item: {
        type: "reasoning",
        summary: [{ type: "summary_text", text: LIVE_REASONING }],
        content: [{ type: "reasoning_text", text: LIVE_REASONING }],
      },
    }) +
    block({ type: "response.completed", response: { id: "r", output: [] } });
  assert.equal(functionCalls((await run(storedBoth)).body).length, 2);
});

test("an unterminated span is scanned once, not re-scanned per delta", async () => {
  // Held as one growing string this was quadratic -- every indexOf re-flattened
  // the rope -- and `_transform` is synchronous, so a 1.25 MB unterminated span
  // blocked the router's event loop for 21.5 s against 0.8 s for the same bytes
  // with no span open. Assert the shape of the curve, not a wall-clock number.
  const chunk = "x".repeat(64);
  async function elapsed(bytes) {
    let stream = block({ type: "response.created", response: { id: "r" } }) +
      block({ type: "response.reasoning_text.delta", output_index: 0, delta: `<tool_calls:${N}>` });
    for (let sent = 0; sent < bytes; sent += chunk.length) {
      stream += block({ type: "response.reasoning_text.delta", output_index: 0, delta: chunk });
    }
    stream += block({ type: "response.completed", response: { id: "r", output: [] } });
    const started = process.hrtime.bigint();
    await run(stream);
    return Number(process.hrtime.bigint() - started) / 1e6;
  }
  const small = await elapsed(128 * 1024);
  const large = await elapsed(512 * 1024);
  // Four times the bytes. Linear would be ~4x; the quadratic version was ~16x.
  // Allow generous slack for a loaded machine and still catch a return to O(n^2).
  assert.ok(large < small * 9, `128 KiB took ${small} ms, 512 KiB took ${large} ms`);
});
