import assert from "node:assert/strict";
import { Readable } from "node:stream";
import test from "node:test";
import { gzipSync, zstdCompressSync } from "node:zlib";
import { readResponsesRequest } from "../src/responses-request-body.mjs";

const image = (bytes) => ({ type: "input_image", image_url: `data:image/png;base64,${"A".repeat(bytes)}`, detail: "original" });
const action = () => ({ type: "function_call", name: "view_image", call_id: "call", arguments: "{}" });
function request(payload, encoding) {
  let body = Buffer.from(JSON.stringify(payload));
  if (encoding === "gzip") body = gzipSync(body);
  if (encoding === "zstd") body = zstdCompressSync(body);
  const stream = Readable.from(Array.from({ length: Math.ceil(body.length / 65536) }, (_, index) => body.subarray(index * 65536, (index + 1) * 65536)));
  stream.headers = encoding ? { "content-encoding": encoding } : {};
  return stream;
}

test("JSON values, escapes and prototype keys keep JSON.parse semantics", async () => {
  const expected = JSON.parse('{"model":"gpt","input":"é\\n文😀","__proto__":{"polluted":true},"n":1e30,"yes":true,"no":false,"nil":null,"empty":[]}');
  const received = await readResponsesRequest(request(expected));
  assert.deepEqual(received.payload, expected);
  assert.equal(Object.getPrototypeOf(received.payload), Object.prototype);
});

test("Unicode and escapes stay exact across single-byte chunks", async () => {
  const expected = { input: 'é文😀\\"\n' };
  const stream = Readable.from(Array.from(Buffer.from(JSON.stringify(expected)), (byte) => Buffer.from([byte])));
  assert.deepEqual((await readResponsesRequest(stream)).payload, expected);
});

test("one huge number cannot bypass the scalar memory limit", async () => {
  const stream = Readable.from([Buffer.from(`{"number":${"1".repeat(2000)}}`)]);
  await assert.rejects(readResponsesRequest(stream, { maxBytes: 1000 }), { status: 413 });
});

test("a 140 MiB replay is bounded while all six current images stay exact", async () => {
  const input = [];
  for (let index = 0; index < 47; index++) {
    input.push(action(), { type: "function_call_output", call_id: "call", output: [image(3 * 1024 * 1024)] });
  }
  const current = Array.from({ length: 6 }, () => image(1024));
  input.push(action(), { type: "function_call_output", call_id: "current", output: current });
  const original = { model: "gpt-6.1-sol", instructions: "Keep the evidence", input };
  assert.ok(Buffer.byteLength(JSON.stringify(original)) > 128 * 1024 * 1024);
  const { payload, stats } = await readResponsesRequest(request(original));
  assert.deepEqual(payload.input.at(-1).output, current);
  assert.equal(payload.instructions, original.instructions);
  assert.ok(stats.imagesDropped > 30);
  assert.ok(Buffer.byteLength(JSON.stringify(payload)) < 35 * 1024 * 1024);
  assert.match(payload.input[1].output[0].text, /image omitted by Codex Router/);
  assert.equal(original.input[1].output[0].type, "input_image");
});

for (const encoding of ["gzip", "zstd"]) {
  test(`${encoding} histories follow the same JSON contract`, async () => {
    const expected = { model: "gpt", input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "é文" }] }] };
    const received = await readResponsesRequest(request(expected, encoding));
    assert.deepEqual(received.payload, expected);
  });
}

test("current images are never discarded to make a request fit", async () => {
  const stream = request({ input: [action(), { type: "function_call_output", output: [image(2000)] }] });
  await assert.rejects(readResponsesRequest(stream, { maxBytes: 1000 }), { status: 413 });
  assert.equal(stream.readableEnded, true);
});

test("a large old group can be reduced after its following model action", async () => {
  const old = { role: "user", content: Array.from({ length: 47 }, () => image(1024 * 1024)) };
  const current = { type: "function_call_output", output: [image(100)] };
  const { payload, stats } = await readResponsesRequest(request({ input: [old, action(), current] }), { maxBytes: 40 * 1024 * 1024 });
  assert.deepEqual(payload.input.at(-1), current);
  assert.ok(stats.imagesDropped > 0);
  assert.ok(JSON.stringify(payload).length < 40 * 1024 * 1024);
});

test("an already aborted request does not wait for data", async () => {
  const stream = new Readable({ read() {} });
  const signal = AbortSignal.abort(new Error("canceled"));
  await assert.rejects(readResponsesRequest(stream, { signal }), /canceled/);
  stream.destroy();
});

test("thousands of pending images remain intact without repeated trimming", async () => {
  const input = [action(), ...Array.from({ length: 4000 }, () => ({ type: "function_call_output", output: [image(16)] }))];
  const { payload, stats } = await readResponsesRequest(request({ input }));
  assert.deepEqual(payload.input, input);
  assert.equal(stats.imagesDropped, 0);
});

test("file references before a large current batch stay untouched and out of the retention scan", async () => {
  const input = [
    { role: "user", content: [{ type: "input_image", file_id: "file-reference" }] },
    action(),
    ...Array.from({ length: 8000 }, () => ({ type: "function_call_output", output: [image(16)] })),
  ];
  const { payload, stats } = await readResponsesRequest(request({ input }));
  assert.deepEqual(payload.input, input);
  assert.equal(stats.imagesDropped, 0);
});

test("wire, decoded, malformed and unsupported bodies fail explicitly", async () => {
  await assert.rejects(readResponsesRequest(request({ text: "large" }), { maxHistoryBytes: 4 }), { status: 413 });
  await assert.rejects(readResponsesRequest(request({ text: "large" }, "gzip"), { maxHistoryBytes: 32 }), { status: 413 });
  const malformed = Readable.from([Buffer.from('{"input":[')]);
  await assert.rejects(readResponsesRequest(malformed), { status: 400 });
  await assert.rejects(readResponsesRequest(request({ text: "x" }, "unknown")), { status: 415 });
});
