import assert from "node:assert/strict";
import test from "node:test";

import {
  CONNECT_CODE_STATUS,
  COMPRESSED_FLAG,
  END_STREAM_FLAG,
  connectStatusFor,
  createEnvelopeScanner,
  encodeEnvelope,
  isKnownConnectCode,
  isRetriableConnectCode,
  parseEndStreamPayload,
  scanEnvelopes,
} from "../src/connect-stream-audit.mjs";

const utf8 = (text) => new TextEncoder().encode(text);
const concat = (...parts) => {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
};

test("a frame header is five bytes: one flag byte and a big-endian length", () => {
  const framed = encodeEnvelope(utf8("abc"));
  assert.deepEqual([...framed], [0, 0, 0, 0, 3, 97, 98, 99]);
});

test("a payload longer than 255 bytes gets a big-endian length, not a little-endian one", () => {
  const framed = encodeEnvelope(new Uint8Array(300));
  assert.deepEqual([...framed.subarray(0, 5)], [0, 0, 0, 1, 44]);
});

test("frames are read back in order with their flags", () => {
  const stream = concat(encodeEnvelope(utf8("one")), encodeEnvelope(utf8("{}"), { flags: END_STREAM_FLAG }));
  const { frames, pending, sawEndOfStream } = scanEnvelopes(stream);

  assert.equal(pending, 0);
  assert.equal(sawEndOfStream, true);
  assert.deepEqual(
    frames.map((frame) => ({ index: frame.index, endOfStream: frame.endOfStream, length: frame.length })),
    [
      { index: 0, endOfStream: false, length: 3 },
      { index: 1, endOfStream: true, length: 2 },
    ],
  );
});

test("a frame split across chunk boundaries is invisible to the caller", () => {
  const stream = concat(encodeEnvelope(utf8("hello")), encodeEnvelope(utf8("world")));
  for (const size of [1, 2, 3, 4, 5, 6, 7, 9, 13]) {
    const scanner = createEnvelopeScanner();
    const payloads = [];
    for (let offset = 0; offset < stream.length; offset += size) {
      for (const frame of scanner.push(stream.subarray(offset, offset + size))) {
        payloads.push(new TextDecoder().decode(frame.payload));
      }
    }
    assert.deepEqual(payloads, ["hello", "world"], `chunk size ${size}`);
    assert.equal(scanner.pending, 0, `chunk size ${size}`);
  }
});

test("a header split across two chunks does not produce a short frame", () => {
  const stream = encodeEnvelope(utf8("abcd"));
  const scanner = createEnvelopeScanner();
  assert.deepEqual(scanner.push(stream.subarray(0, 3)), []);
  assert.equal(scanner.pending, 3);
  const frames = scanner.push(stream.subarray(3));
  assert.equal(frames.length, 1);
  assert.equal(new TextDecoder().decode(frames[0].payload), "abcd");
});

test("a zero-length frame is a frame, not the end of the stream", () => {
  const { frames, sawEndOfStream } = scanEnvelopes(encodeEnvelope(new Uint8Array(0)));
  assert.equal(frames.length, 1);
  assert.equal(frames[0].length, 0);
  assert.equal(sawEndOfStream, false);
});

test("bytes that never completed a frame are reported rather than dropped", () => {
  // The symptom of a connection dying mid-frame. A transport yields everything
  // before it and stops, which reads as a short answer.
  const stream = concat(encodeEnvelope(utf8("done")), encodeEnvelope(utf8("cut off")).subarray(0, 7));
  const { frames, pending, sawEndOfStream } = scanEnvelopes(stream);
  assert.equal(frames.length, 1);
  assert.equal(pending, 7);
  assert.equal(sawEndOfStream, false);
});

test("the compressed flag is surfaced, because a decoder handed gzip returns an empty message", () => {
  const { frames } = scanEnvelopes(encodeEnvelope(utf8("gz"), { flags: COMPRESSED_FLAG }));
  assert.equal(frames[0].compressed, true);
  assert.equal(frames[0].endOfStream, false);
});

test("a frame can be both compressed and the terminator", () => {
  const { frames } = scanEnvelopes(encodeEnvelope(utf8("{}"), { flags: COMPRESSED_FLAG | END_STREAM_FLAG }));
  assert.equal(frames[0].compressed, true);
  assert.equal(frames[0].endOfStream, true);
});

test("a clean terminator carries no error", () => {
  const parsed = parseEndStreamPayload(utf8("{}"));
  assert.equal(parsed.malformed, false);
  assert.equal(parsed.error, undefined);
});

test("an empty terminator body is treated as clean, not as malformed", () => {
  const parsed = parseEndStreamPayload(new Uint8Array(0));
  assert.equal(parsed.malformed, false);
  assert.equal(parsed.error, undefined);
});

test("an error inside the terminator is read even though HTTP already said 200", () => {
  const parsed = parseEndStreamPayload(
    utf8(JSON.stringify({ error: { code: "invalid_argument", message: "chat_model_uid is required" } })),
  );
  assert.equal(parsed.malformed, false);
  assert.deepEqual(parsed.error, {
    code: "invalid_argument",
    message: "chat_model_uid is required",
    status: 400,
    retriable: false,
    known: true,
  });
});

test("a terminator that is not JSON is malformed, which is not the same as success", () => {
  const parsed = parseEndStreamPayload(utf8("<html>502 Bad Gateway</html>"));
  assert.equal(parsed.malformed, true);
  assert.equal(parsed.error, undefined);
  assert.match(parsed.text, /502 Bad Gateway/);
});

test("a terminator error with an unrecognised code is reported as unknown rather than silently mapped", () => {
  const parsed = parseEndStreamPayload(utf8(JSON.stringify({ error: { code: "teapot" } })));
  assert.equal(parsed.error.known, false);
  assert.equal(parsed.error.status, 502);
});

test("every Connect error code maps to a status, including the ones a partial table misses", () => {
  // A code that falls through to 502 is read upstream as a transient fault and
  // retried. `unimplemented` -- the answer to a wrong service path or method
  // name -- must never be retried, and neither must `invalid_argument`.
  assert.equal(Object.keys(CONNECT_CODE_STATUS).length, 16);
  assert.equal(connectStatusFor("unimplemented"), 501);
  assert.equal(connectStatusFor("invalid_argument"), 400);
  assert.equal(connectStatusFor("unauthenticated"), 401);
  assert.equal(connectStatusFor("permission_denied"), 403);
  assert.equal(connectStatusFor("resource_exhausted"), 429);
  assert.equal(connectStatusFor("unavailable"), 503);
  assert.equal(connectStatusFor("deadline_exceeded"), 504);
  assert.equal(connectStatusFor("already_exists"), 409);
  assert.equal(connectStatusFor("aborted"), 409);
  assert.equal(connectStatusFor("out_of_range"), 400);
  assert.equal(connectStatusFor("data_loss"), 500);
  assert.equal(connectStatusFor("canceled"), 499);
});

test("an unrecognised or absent code falls back to the caller's status", () => {
  assert.equal(connectStatusFor(undefined, 418), 418);
  assert.equal(connectStatusFor("not_a_code", 418), 418);
  assert.equal(connectStatusFor("INVALID_ARGUMENT"), 400);
  assert.equal(isKnownConnectCode("not_a_code"), false);
  assert.equal(isKnownConnectCode("internal"), true);
});

test("only codes another attempt could change are retriable", () => {
  for (const code of ["unavailable", "resource_exhausted", "deadline_exceeded", "aborted"]) {
    assert.equal(isRetriableConnectCode(code), true, code);
  }
  for (const code of ["invalid_argument", "unimplemented", "unauthenticated", "permission_denied", "not_found"]) {
    assert.equal(isRetriableConnectCode(code), false, code);
  }
});
