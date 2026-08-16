import assert from "node:assert/strict";
import test from "node:test";

import {
  auditMessage,
  describeCensusRow,
  expectedWireTypes,
  fieldCensus,
  mismatchedFieldRows,
  scanFields,
  unknownFieldRows,
  wireTypeName,
} from "../src/protobuf-audit.mjs";

// Bytes are written by hand rather than produced by the encoder under audit.
// An auditor checked against its own writer proves the two agree, which is not
// the claim anyone needs.
const bytes = (...values) => Uint8Array.from(values.flat());
const ascii = (text) => [...text].map((character) => character.charCodeAt(0));
// Tags above field 15 need two varint bytes; spelling that out here keeps the
// fixtures honest about what the wire really looks like.
const varint = (value) => {
  const out = [];
  let remaining = value;
  do {
    const byte = remaining & 0x7f;
    remaining >>>= 7;
    out.push(remaining > 0 ? byte | 0x80 : byte);
  } while (remaining > 0);
  return out;
};
const stringField = (no, text) => [...varint(no * 8 + 2), text.length, ...ascii(text)];
const varintField = (no, value) => [...varint(no * 8), value];

// The subset of the Cascade response this repository claims to understand.
const TOOL_CALL = Object.freeze({
  id: { no: 1, type: "string" },
  name: { no: 2, type: "string" },
  argumentsJson: { no: 3, type: "string" },
});
const RESPONSE = Object.freeze({
  messageId: { no: 1, type: "string" },
  deltaText: { no: 3, type: "string" },
  stopReason: { no: 5, type: "enum" },
  deltaToolCalls: { no: 6, type: "message", message: TOOL_CALL, repeated: true },
});

test("a hand-written frame is reported field by field with its wire type", () => {
  const frame = bytes(stringField(3, "hi"), varintField(5, 10));
  const scan = scanFields(frame);

  assert.equal(scan.truncated, false);
  assert.deepEqual(
    scan.fields.map(({ no, wireType, byteLength }) => ({ no, wireType, byteLength })),
    [
      { no: 3, wireType: 2, byteLength: 2 },
      { no: 5, wireType: 0, byteLength: 1 },
    ],
  );
});

test("a field the schema does not name is reported, not skipped", () => {
  // This is the whole reason the module exists. A protobuf decoder skips field
  // 19 silently; a tester needs to be told it was there.
  const frame = bytes(stringField(3, "ok"), stringField(19, "surprise"));
  const audit = auditMessage(frame, RESPONSE);

  assert.deepEqual(
    audit.matched.map((entry) => entry.name),
    ["deltaText"],
  );
  assert.deepEqual(
    audit.unknown.map((entry) => ({ no: entry.no, wireTypeName: entry.wireTypeName, byteLength: entry.byteLength })),
    [{ no: 19, wireTypeName: "length-delimited", byteLength: 8 }],
  );
});

test("a two-byte tag is read as one field, so field numbers above 15 are not misread", () => {
  // 19 << 3 | 2 == 154, which does not fit in one varint byte.
  const frame = bytes([0x9a, 0x01, 0x03], ascii("abc"));
  const scan = scanFields(frame);
  assert.equal(scan.fields.length, 1);
  assert.equal(scan.fields[0].no, 19);
  assert.equal(scan.fields[0].wireType, 2);
});

test("a field arriving on the wrong wire type is a mismatch, not an unknown", () => {
  // deltaText is declared `string`, which may only arrive length-delimited.
  const audit = auditMessage(bytes(varintField(3, 7)), RESPONSE);
  assert.equal(audit.matched.length, 0);
  assert.equal(audit.unknown.length, 0);
  assert.deepEqual(
    audit.mismatched.map((entry) => ({ no: entry.no, name: entry.name, observed: entry.wireTypeName })),
    [{ no: 3, name: "deltaText", observed: "varint" }],
  );
  assert.deepEqual(audit.mismatched[0].expectedWireTypeNames, ["length-delimited"]);
});

test("nested message fields are audited against their own table", () => {
  const call = bytes(stringField(1, "a"), stringField(2, "ping"), stringField(3, "{}"));
  const frame = bytes([6 * 8 + 2, call.length], [...call]);
  const audit = auditMessage(frame, RESPONSE);

  assert.equal(audit.matched.length, 1);
  assert.deepEqual(
    audit.matched[0].child.matched.map((entry) => entry.name),
    ["id", "name", "argumentsJson"],
  );
});

test("an unknown field inside a nested message is reported with its path", () => {
  const call = bytes(stringField(1, "a"), stringField(9, "moved"));
  const frame = bytes([6 * 8 + 2, call.length], [...call]);
  const census = fieldCensus(auditMessage(frame, RESPONSE));

  const unknown = unknownFieldRows(census);
  assert.equal(unknown.length, 1);
  assert.deepEqual(unknown[0].path, ["deltaToolCalls"]);
  assert.equal(unknown[0].no, 9);
  assert.match(describeCensusRow(unknown[0]), /^deltaToolCalls\.field 9 \(length-delimited, 5B over 1\) -> UNKNOWN$/);
});

test("field contents never survive into the audit result", () => {
  // The probe's output is written to be pasted into a public issue, and these
  // payloads carry prompt text and model output.
  const audit = auditMessage(bytes(stringField(3, "secret prompt text")), RESPONSE);
  const serialized = JSON.stringify(audit);
  assert.equal(serialized.includes("secret"), false);
  assert.equal(audit.matched[0].byteLength, 18);
});

test("a frame that ends mid-field reports what it read plus the failure", () => {
  const truncated = bytes(stringField(3, "ok"), [3 * 8 + 2, 20], ascii("short"));
  const audit = auditMessage(truncated, RESPONSE);
  assert.equal(audit.truncated, true);
  assert.match(audit.error, /runs past the end/);
  assert.equal(audit.matched.length, 1);
});

test("a truncated varint does not throw out of the auditor", () => {
  const scan = scanFields(bytes([5 * 8, 0x80]));
  assert.equal(scan.truncated, true);
  assert.match(scan.error, /truncated varint/);
});

test("a zero field number is refused rather than reported as field 0", () => {
  const scan = scanFields(bytes([0x02, 0x00]));
  assert.equal(scan.truncated, true);
  assert.match(scan.error, /field number 0/);
});

test("group wire types are reported as unsupported instead of being guessed at", () => {
  const scan = scanFields(bytes([3 * 8 + 3]));
  assert.equal(scan.truncated, true);
  assert.match(scan.error, /wire type 3/);
});

test("the census folds many frames into one row per field", () => {
  const audits = [
    auditMessage(bytes(stringField(3, "ab")), RESPONSE),
    auditMessage(bytes(stringField(3, "cde")), RESPONSE),
    auditMessage(bytes(stringField(19, "x")), RESPONSE),
  ];
  const census = fieldCensus(audits);

  const text = census.find((row) => row.no === 3);
  assert.equal(text.count, 2);
  assert.equal(text.totalBytes, 5);
  assert.equal(text.name, "deltaText");
  assert.equal(unknownFieldRows(census).length, 1);
  assert.equal(mismatchedFieldRows(census).length, 0);
});

test("a repeated numeric field may arrive packed or unpacked, a singular one may not", () => {
  assert.deepEqual(expectedWireTypes("uint32", true), [0, 2]);
  assert.deepEqual(expectedWireTypes("uint32", false), [0]);
  assert.deepEqual(expectedWireTypes("string", true), [2]);
  assert.deepEqual(expectedWireTypes("double", false), [1]);
  assert.deepEqual(expectedWireTypes("float", false), [5]);
  assert.deepEqual(expectedWireTypes("nonsense"), []);
  assert.equal(wireTypeName(7), "wire-type-7");
});

test("fixed-width fields are measured, not misread as length prefixes", () => {
  const frame = bytes([5 * 8 + 1], [1, 2, 3, 4, 5, 6, 7, 8], [6 * 8 + 5], [1, 2, 3, 4]);
  const scan = scanFields(frame);
  assert.deepEqual(
    scan.fields.map((field) => [field.no, field.wireTypeName, field.byteLength]),
    [
      [5, "fixed64", 8],
      [6, "fixed32", 4],
    ],
  );
});

test("an empty message audits to nothing rather than failing", () => {
  const audit = auditMessage(new Uint8Array(0), RESPONSE);
  assert.equal(audit.truncated, false);
  assert.deepEqual(audit.observations, []);
  assert.deepEqual(fieldCensus(audit), []);
});
