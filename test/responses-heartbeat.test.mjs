import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";

import { ResponsesHeartbeatTransform } from "../src/responses-heartbeat.mjs";

const CREATED =
  'event: response.created\ndata: {"type":"response.created","sequence_number":1,"response":' +
  '{"id":"resp_1","object":"response","created_at":1700000000,"model":"grok-4.6","status":"in_progress",' +
  '"instructions":"private-instructions-marker","tools":[{"type":"function","name":"read_file"}],"output":[]}}\n\n';
const REASONING =
  'event: response.reasoning_summary_text.delta\ndata: {"type":"response.reasoning_summary_text.delta","delta":"thinking"}\n\n';
const COMPLETED =
  'event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp_1","status":"completed","output":[]}}\n\n';
const HEARTBEAT_BLOCK = /event: response\.in_progress\ndata: [^\n]*\n\n/g;

function collect(transform) {
  const chunks = [];
  transform.on("data", (chunk) => chunks.push(Buffer.from(chunk).toString("utf8")));
  return () => chunks.join("");
}

function heartbeats(text) {
  return [...text.matchAll(HEARTBEAT_BLOCK)].map((match) =>
    JSON.parse(match[0].slice(match[0].indexOf("data: ") + 6)),
  );
}

test("a silent announced stream relays identity-only heartbeats and leaves every byte intact", async () => {
  const heartbeat = new ResponsesHeartbeatTransform({ intervalMs: 40 });
  const read = collect(heartbeat);
  heartbeat.write(CREATED);
  heartbeat.write(REASONING);
  await delay(170);
  const beats = heartbeats(read());
  assert.ok(beats.length >= 2, read());
  assert.deepEqual(beats[0], {
    type: "response.in_progress",
    response: {
      id: "resp_1",
      object: "response",
      created_at: 1700000000,
      model: "grok-4.6",
      status: "in_progress",
      output: [],
    },
  });
  assert.doesNotMatch(JSON.stringify(beats), /private-instructions-marker|read_file|thinking/);
  heartbeat.end(COMPLETED);
  await new Promise((resolve) => heartbeat.once("end", resolve));
  const settled = read();
  assert.equal(settled.replace(HEARTBEAT_BLOCK, ""), CREATED + REASONING + COMPLETED);
  await delay(120);
  assert.equal(read(), settled, "no heartbeat after the stream ends");
});

test("no heartbeat before the client has seen response.created", async () => {
  const heartbeat = new ResponsesHeartbeatTransform({ intervalMs: 30 });
  const read = collect(heartbeat);
  heartbeat.write(REASONING);
  await delay(140);
  assert.equal(read(), REASONING);
  heartbeat.destroy();
});

test("no heartbeat is spliced into a partially relayed event", async () => {
  const heartbeat = new ResponsesHeartbeatTransform({ intervalMs: 30 });
  const read = collect(heartbeat);
  const partialEvent = 'event: response.output_text.delta\ndata: {"type":"response.output_text.delta",';
  heartbeat.write(CREATED);
  await delay(80);
  const beforePartial = heartbeats(read()).length;
  assert.ok(beforePartial >= 1);
  heartbeat.write(partialEvent);
  await delay(140);
  assert.equal(heartbeats(read()).length, beforePartial, "a heartbeat interrupted a partial event");
  heartbeat.write('"delta":"hi"}\n\n');
  await delay(80);
  const text = read();
  assert.ok(heartbeats(text).length > beforePartial, "heartbeats resume at the next boundary");
  assert.ok(text.includes(`${partialEvent}"delta":"hi"}\n\n`), "the split event reached the client whole");
  heartbeat.destroy();
});

test("any terminal event, typed or untyped, stops the heartbeat", async () => {
  for (const terminal of [
    COMPLETED,
    'event: response.failed\ndata: {"type":"response.failed","response":{"id":"resp_1"}}\n\n',
    'data: {"type":"error","error":{"message":"refused"}}\n\n',
    'data: {"type":"response.incomplete","response":{"id":"resp_1"}}\n\n',
    "data: [DONE]\n\n",
  ]) {
    const heartbeat = new ResponsesHeartbeatTransform({ intervalMs: 30 });
    const read = collect(heartbeat);
    heartbeat.write(CREATED);
    heartbeat.write(terminal);
    await delay(120);
    assert.equal(read(), CREATED + terminal, terminal);
    heartbeat.destroy();
  }
});

test("a terminal too large to parse still stops the heartbeat", async () => {
  const heartbeat = new ResponsesHeartbeatTransform({ intervalMs: 30 });
  const read = collect(heartbeat);
  const oversized = `data: {"type":"response.completed","response":{"id":"resp_1","output":[{"type":"message","content":[{"type":"output_text","text":"${"x".repeat(4 * 1024 * 1024 + 16)}"}]}]}}\n\n`;
  heartbeat.write(CREATED);
  heartbeat.write(oversized);
  await delay(150);
  assert.equal(heartbeats(read()).length, 0, "a heartbeat followed an oversized terminal");
  heartbeat.destroy();
});

test("an active stream never receives a heartbeat", async () => {
  const heartbeat = new ResponsesHeartbeatTransform({ intervalMs: 80 });
  const read = collect(heartbeat);
  heartbeat.write(CREATED);
  for (let i = 0; i < 8; i += 1) {
    await delay(20);
    heartbeat.write(REASONING);
  }
  assert.equal(heartbeats(read()).length, 0);
  heartbeat.destroy();
});

test("CRLF-framed streams are recognized at their boundaries", async () => {
  const heartbeat = new ResponsesHeartbeatTransform({ intervalMs: 30 });
  const read = collect(heartbeat);
  heartbeat.write(CREATED.replaceAll("\n", "\r\n"));
  await delay(100);
  assert.ok(heartbeats(read()).length >= 1, read());
  heartbeat.destroy();
});


test("an oversized partial event disables heartbeat observation even after identity was announced", async () => {
  for (const announced of [false, true]) {
    const heartbeat = new ResponsesHeartbeatTransform({ intervalMs: 30 });
    const read = collect(heartbeat);
    const prefix = announced ? CREATED : "";
    if (announced) heartbeat.write(CREATED);
    const piece = "x".repeat(1024 * 1024);
    for (let index = 0; index < 5; index += 1) heartbeat.write(piece);
    heartbeat.write("\n\n" + CREATED);
    await delay(100);
    assert.equal(heartbeats(read()).length, 0, "observation must stay disabled after losing a bounded frame");
    assert.equal(read(), prefix + piece.repeat(5) + "\n\n" + CREATED);
    heartbeat.destroy();
  }
});
