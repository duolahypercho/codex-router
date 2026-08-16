import assert from "node:assert/strict";
import test from "node:test";

import { decodeMessage, encodeMessage } from "../src/protobuf-wire.mjs";

const NESTED = { name: { no: 1, type: "string" } };
const SCHEMA = {
  text: { no: 1, type: "string" },
  count: { no: 2, type: "uint64" },
  flag: { no: 3, type: "bool" },
  ratio: { no: 4, type: "double" },
  tags: { no: 5, type: "string", repeated: true },
  child: { no: 6, type: "message", message: NESTED },
  children: { no: 7, type: "message", message: NESTED, repeated: true },
  kind: { no: 8, type: "enum" },
  blob: { no: 9, type: "bytes" },
  scores: { no: 10, type: "int32", repeated: true },
};

test("encodes a string field with the field number and length protobuf specifies", () => {
  // field 1, wire type 2 -> tag byte 0x0a; length 2; "hi"
  const encoded = encodeMessage({ text: { no: 1, type: "string" } }, { text: "hi" });
  assert.deepEqual([...encoded], [0x0a, 0x02, 0x68, 0x69]);
});

test("encodes a varint field larger than one byte", () => {
  // field 2, wire type 0 -> tag 0x10; 300 -> 0xac 0x02
  const encoded = encodeMessage({ count: { no: 2, type: "uint64" } }, { count: 300 });
  assert.deepEqual([...encoded], [0x10, 0xac, 0x02]);
});

test("round-trips every supported field shape", () => {
  const value = {
    text: "hello",
    count: 4_294_967_296,
    flag: true,
    ratio: 0.95,
    tags: ["a", "b"],
    child: { name: "one" },
    children: [{ name: "two" }, { name: "three" }],
    kind: 5,
    blob: Uint8Array.from([1, 2, 3]),
  };
  const decoded = decodeMessage(SCHEMA, encodeMessage(SCHEMA, value));
  assert.equal(decoded.text, "hello");
  assert.equal(decoded.count, 4_294_967_296);
  assert.equal(decoded.flag, true);
  assert.ok(Math.abs(decoded.ratio - 0.95) < 1e-12);
  assert.deepEqual(decoded.tags, ["a", "b"]);
  assert.deepEqual(decoded.child, { name: "one" });
  assert.deepEqual(decoded.children, [{ name: "two" }, { name: "three" }]);
  assert.equal(decoded.kind, 5);
  assert.deepEqual([...decoded.blob], [1, 2, 3]);
});

test("omits absent fields rather than writing proto3 defaults", () => {
  assert.equal(encodeMessage(SCHEMA, { text: undefined, count: null }).length, 0);
});

test("writes a false boolean and a zero, which are meaningful on an optional field", () => {
  const encoded = encodeMessage(SCHEMA, { flag: false, count: 0 });
  const decoded = decodeMessage(SCHEMA, encoded);
  assert.equal(decoded.flag, false);
  assert.equal(decoded.count, 0);
});

// The upstream adds fields without notice. A decoder that failed on one would
// fail whole turns for a field the router never reads.
test("skips unknown fields of every wire type instead of failing", () => {
  const wide = {
    ...SCHEMA,
    extraVarint: { no: 40, type: "uint64" },
    extraString: { no: 41, type: "string" },
    extraDouble: { no: 42, type: "double" },
    extraFloat: { no: 43, type: "float" },
  };
  const encoded = encodeMessage(wide, {
    text: "kept",
    extraVarint: 9,
    extraString: "dropped",
    extraDouble: 1.5,
    extraFloat: 2.5,
  });
  const decoded = decodeMessage(SCHEMA, encoded);
  assert.equal(decoded.text, "kept");
  assert.equal(decoded.extraString, undefined);
});

test("reads a packed repeated scalar, which is how the upstream sends enum lists", () => {
  // field 10, wire type 2 (packed) -> tag 0x52; length 3; values 1,2,3
  const packed = Uint8Array.from([0x52, 0x03, 0x01, 0x02, 0x03]);
  assert.deepEqual(decodeMessage(SCHEMA, packed).scores, [1, 2, 3]);
});

test("reads an unpacked repeated scalar too", () => {
  const unpacked = Uint8Array.from([0x50, 0x01, 0x50, 0x02]);
  assert.deepEqual(decodeMessage(SCHEMA, unpacked).scores, [1, 2]);
});

test("refuses a truncated field rather than returning a half-read message", () => {
  assert.throws(() => decodeMessage(SCHEMA, Uint8Array.from([0x0a, 0x05, 0x68])), /truncated/);
});
