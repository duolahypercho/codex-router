import assert from "node:assert/strict";
import { Readable } from "node:stream";
import test from "node:test";
import { brotliCompressSync, deflateSync, gzipSync, zstdCompressSync } from "node:zlib";
import { readResponsesRequest } from "../src/responses-request-body.mjs";

const image = (bytes) => ({ type: "input_image", image_url: `data:image/png;base64,${"A".repeat(bytes)}`, detail: "original" });
const action = () => ({ type: "function_call", name: "view_image", call_id: "call", arguments: "{}" });
function request(payload, encoding) {
  let body = Buffer.from(JSON.stringify(payload));
  if (encoding === "gzip") body = gzipSync(body);
  if (encoding === "deflate") body = deflateSync(body);
  if (encoding === "br") body = brotliCompressSync(body);
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

for (const encoding of ["gzip", "deflate", "br", "zstd"]) {
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

test("every stacked decoding stage is capped even when final JSON is small", async () => {
  const small = gzipSync(Buffer.from('{"input":"small"}'));
  const header = Buffer.from(small.subarray(0, 10));
  header[3] |= 0x10; // A legal gzip comment that disappears in the next stage.
  const intermediate = Buffer.concat([header, Buffer.alloc(65_536, 65), Buffer.from([0]), small.subarray(10)]);
  const wire = gzipSync(intermediate);
  assert.ok(wire.length < 256);
  assert.ok(intermediate.length > 65_536);
  const stream = Readable.from([wire]);
  stream.headers = { "content-encoding": "gzip, gzip" };
  await assert.rejects(readResponsesRequest(stream, { maxBytes: 256, maxHistoryBytes: 256 }), { status: 413 });
});

test("each supported decoder caps its output before assembly", async () => {
  const original = { input: "x".repeat(8_192) };
  for (const encoding of [undefined, "gzip", "deflate", "br", "zstd"]) {
    const stream = request(original, encoding);
    await assert.rejects(readResponsesRequest(stream, {
      maxBytes: 16_384, maxHistoryBytes: 256, maxWireBytes: 16_384,
    }), (error) => error.status === 413 && /Decoded image history/.test(error.message));
  }
});

test("stacked gzip, deflate and Brotli retain JSON when every stage fits", async () => {
  const expected = { input: 'é文😀\\"\n\ud800', values: [true, null, false, 1e300] };
  const body = brotliCompressSync(deflateSync(gzipSync(Buffer.from(JSON.stringify(expected)))));
  const stream = Readable.from(Array.from(body, (byte) => Buffer.from([byte])));
  stream.headers = { "content-encoding": ["gzip", "deflate", "br"] };
  const { payload, stats } = await readResponsesRequest(stream, { maxBytes: 1_024, maxHistoryBytes: 1_024 });
  assert.deepEqual(payload, expected);
  assert.equal(stats.retainedBodyBytes, Buffer.byteLength(JSON.stringify(expected)));
});

test("malformed compressed data and excessive JSON nesting fail closed", async () => {
  const compressed = Readable.from([Buffer.from("not gzip data")]);
  compressed.headers = { "content-encoding": "gzip" };
  await assert.rejects(readResponsesRequest(compressed), { status: 400 });
  const deep = Readable.from([Buffer.from(`{"input":${"[".repeat(300)}0${"]".repeat(300)}}`)]);
  await assert.rejects(readResponsesRequest(deep), { status: 400 });
});

test("a cancellation during streaming tears down the pending reader", async () => {
  const controller = new AbortController();
  const stream = new Readable({ read() {} });
  stream.push(Buffer.from('{"input":"pending'));
  const result = readResponsesRequest(stream, { signal: controller.signal });
  controller.abort(new Error("mid-stream cancellation"));
  await assert.rejects(result, /mid-stream cancellation/);
  assert.equal(stream.destroyed, true);
});

test("a custom wire cap is enforced for chunked compressed bodies", async () => {
  const body = gzipSync(Buffer.from(JSON.stringify({ input: "within the decoded limit" })));
  const stream = Readable.from([body.subarray(0, 20), body.subarray(20)]);
  stream.headers = { "content-encoding": "gzip" };
  await assert.rejects(readResponsesRequest(stream, { maxBytes: 1_024, maxWireBytes: 20 }), { status: 413 });
  assert.equal(stream.readableEnded, true);
});

test("retained JSON budgets trim old images below the provider image ceiling", async () => {
  const old = Array.from({ length: 4 }, (_, index) => ({
    type: "function_call_output", call_id: `old-${index}`, output: [image(1_000)],
  }));
  const current = { type: "function_call_output", call_id: "current", output: [image(50)], marker: "keep" };
  const original = {
    input: [...old, action(), current],
    instructions: 'é文😀\\"\n\ud800'.repeat(4),
    tools: [{ type: "function", name: "view_image", parameters: { type: "object" } }],
  };
  assert.ok(Buffer.byteLength(JSON.stringify(original)) > 3_000);
  const { payload, stats } = await readResponsesRequest(request(original), { maxBytes: 3_000 });
  assert.ok(stats.imagesDropped > 0);
  assert.equal(stats.retainedBodyBytes, Buffer.byteLength(JSON.stringify(payload)));
  assert.ok(stats.retainedBodyBytes <= 3_000);
  assert.deepEqual(payload.input.at(-1), current);
  assert.deepEqual(payload.input.at(-2), action());
  assert.deepEqual(payload.tools, original.tools);
  assert.equal(payload.instructions, original.instructions);
});

test("request sizing does not serialize the assembled body before applying its cap", async () => {
  const expected = { input: 'é文😀\\"\n\ud800', metadata: { active: true }, values: [1e30, -0, null] };
  const stream = request(expected);
  const serialized = JSON.stringify(expected);
  const stringify = JSON.stringify;
  JSON.stringify = () => { throw new Error("whole-body serialization is forbidden during ingress sizing"); };
  try {
    const { payload, stats } = await readResponsesRequest(stream, { maxBytes: Buffer.byteLength(serialized) });
    assert.deepEqual(payload, JSON.parse(serialized));
    assert.equal(stats.retainedBodyBytes, Buffer.byteLength(serialized));
  } finally {
    JSON.stringify = stringify;
  }
});

test("irreducible aggregate text and protected newest images reject after trimming", async () => {
  const original = {
    input: [
      ...Array.from({ length: 4 }, () => ({ role: "user", content: [image(700)] })),
      action(),
      { type: "function_call_output", output: [image(50)] },
    ],
    instructions: "文".repeat(500),
  };
  await assert.rejects(readResponsesRequest(request(original), { maxBytes: 2_000 }), { status: 413 });
  await assert.rejects(readResponsesRequest(request({ input: [action(), { output: [image(2_000)] }] }), { maxBytes: 1_000 }), { status: 413 });
});
