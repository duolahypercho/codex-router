// A read-only auditor for protobuf bytes, used by provider probes.
//
// A protobuf decoder is deliberately forgiving: an unknown field number is
// skipped so that an upstream can add fields without breaking a live turn.
// That forgiveness is the reason a renumbered field is invisible. If the
// upstream moves `deltaToolCalls` from field 6 to field 19, a decoder returns
// a message with no tool calls and no error, and the turn reads exactly like a
// model that chose not to call a tool.
//
// This module exists to make that case loud. It walks the same bytes without a
// schema, reports every field number and wire type actually present, and then
// classifies each observation against a schema table as matched, wire-type
// mismatched, or unknown. A probe can then say "the frame carried field 19,
// which this build does not know" instead of "0 tool calls".
//
// Field *contents* are never retained. Payload bytes on this wire carry prompt
// text and model output, and a probe's output is meant to be pasted into a
// public issue, so the audit keeps byte counts and nothing else.

export const WIRE_VARINT = 0;
export const WIRE_FIXED64 = 1;
export const WIRE_LENGTH = 2;
export const WIRE_START_GROUP = 3;
export const WIRE_END_GROUP = 4;
export const WIRE_FIXED32 = 5;

export const WIRE_TYPE_NAMES = Object.freeze({
  0: "varint",
  1: "fixed64",
  2: "length-delimited",
  3: "start-group",
  4: "end-group",
  5: "fixed32",
});

const VARINT_TYPES = new Set(["bool", "enum", "int32", "int64", "uint32", "uint64", "sint32", "sint64"]);

export function wireTypeName(wireType) {
  return WIRE_TYPE_NAMES[wireType] || `wire-type-${wireType}`;
}

function toBytes(input) {
  if (input instanceof Uint8Array) return input;
  if (ArrayBuffer.isView(input)) return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  if (input instanceof ArrayBuffer) return new Uint8Array(input);
  return Uint8Array.from(input || []);
}

function readVarint(bytes, start) {
  let result = 0n;
  let shift = 0n;
  let offset = start;
  for (;;) {
    if (offset >= bytes.length) throw new Error("truncated varint");
    const byte = bytes[offset];
    offset += 1;
    result |= BigInt(byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) return [result, offset];
    shift += 7n;
    if (shift > 63n) throw new Error("varint overflow");
  }
}

// Which wire types a declared field type may legally arrive on. Repeated
// numeric fields may also arrive packed into one length-delimited run, so both
// forms are accepted for them; anything else is a genuine schema disagreement.
export function expectedWireTypes(type, repeated = false) {
  if (VARINT_TYPES.has(type)) return repeated ? [WIRE_VARINT, WIRE_LENGTH] : [WIRE_VARINT];
  if (type === "double") return repeated ? [WIRE_FIXED64, WIRE_LENGTH] : [WIRE_FIXED64];
  if (type === "float") return repeated ? [WIRE_FIXED32, WIRE_LENGTH] : [WIRE_FIXED32];
  if (type === "string" || type === "bytes" || type === "message") return [WIRE_LENGTH];
  return [];
}

// Walks the tag/value stream without consulting any schema. On malformed input
// it returns what it read plus `truncated: true` rather than throwing: a probe
// that stops at the first bad byte tells the tester less than one that reports
// "read 4 fields, then the varint at offset 91 ran off the end".
export function scanFields(input) {
  const bytes = toBytes(input);
  const fields = [];
  let offset = 0;
  try {
    while (offset < bytes.length) {
      const [tag, afterTag] = readVarint(bytes, offset);
      const no = Number(tag >> 3n);
      const wireType = Number(tag & 7n);
      if (no === 0) throw new Error("field number 0 is not a legal tag");
      let next = afterTag;
      let byteLength = 0;
      let value;
      if (wireType === WIRE_VARINT) {
        const [raw, after] = readVarint(bytes, next);
        value = raw;
        byteLength = after - next;
        next = after;
      } else if (wireType === WIRE_FIXED64) {
        if (next + 8 > bytes.length) throw new Error("truncated fixed64");
        byteLength = 8;
        next += 8;
      } else if (wireType === WIRE_FIXED32) {
        if (next + 4 > bytes.length) throw new Error("truncated fixed32");
        byteLength = 4;
        next += 4;
      } else if (wireType === WIRE_LENGTH) {
        const [rawLength, after] = readVarint(bytes, next);
        const length = Number(rawLength);
        if (!Number.isSafeInteger(length) || length < 0) throw new Error("unusable length prefix");
        if (after + length > bytes.length) throw new Error("length prefix runs past the end of the message");
        value = bytes.subarray(after, after + length);
        byteLength = length;
        next = after + length;
      } else {
        throw new Error(`wire type ${wireType} is not supported`);
      }
      fields.push({ no, wireType, wireTypeName: wireTypeName(wireType), byteLength, value });
      offset = next;
    }
  } catch (error) {
    return { fields, truncated: true, error: error.message, consumed: offset, size: bytes.length };
  }
  return { fields, truncated: false, error: undefined, consumed: offset, size: bytes.length };
}

function publicObservation(raw) {
  // `value` is deliberately dropped here: everything downstream of this call
  // may be printed or pasted into a public issue.
  return { no: raw.no, wireType: raw.wireType, wireTypeName: raw.wireTypeName, byteLength: raw.byteLength };
}

// Classifies every field on the wire against a schema table of the shape
// `{ fieldName: { no, type, repeated, message } }`. Nested message fields are
// audited recursively when the schema names a nested table, which is how a
// probe confirms the field numbers inside `deltaToolCalls` and not merely that
// something arrived on field 6.
export function auditMessage(input, schema, { depth = 4 } = {}) {
  const scan = scanFields(input);
  const byNumber = new Map();
  for (const [name, field] of Object.entries(schema || {})) byNumber.set(field.no, { name, field });

  const observations = [];
  for (const raw of scan.fields) {
    const known = byNumber.get(raw.no);
    if (!known) {
      observations.push({ ...publicObservation(raw), status: "unknown", name: undefined, declaredType: undefined });
      continue;
    }
    const allowed = expectedWireTypes(known.field.type, known.field.repeated);
    const status = allowed.includes(raw.wireType) ? "matched" : "mismatched";
    const observation = {
      ...publicObservation(raw),
      status,
      name: known.name,
      declaredType: known.field.type,
      expectedWireTypeNames: allowed.map(wireTypeName),
    };
    if (
      status === "matched" &&
      known.field.type === "message" &&
      known.field.message &&
      depth > 0 &&
      raw.value
    ) {
      observation.child = auditMessage(raw.value, known.field.message, { depth: depth - 1 });
    }
    observations.push(observation);
  }

  return {
    observations,
    truncated: scan.truncated,
    error: scan.error,
    size: scan.size,
    matched: observations.filter((entry) => entry.status === "matched"),
    mismatched: observations.filter((entry) => entry.status === "mismatched"),
    unknown: observations.filter((entry) => entry.status === "unknown"),
  };
}

// Folds any number of audits -- typically every frame of one stream -- into one
// row per field number, so a probe reports "field 19: unknown, length-delimited,
// seen 12x" once rather than per frame.
export function fieldCensus(audits, { path = [] } = {}) {
  const rows = new Map();
  const record = (observation, prefix) => {
    const key = `${prefix.join(".")}#${observation.no}`;
    const existing = rows.get(key);
    if (existing) {
      existing.count += 1;
      existing.totalBytes += observation.byteLength;
      if (!existing.wireTypeNames.includes(observation.wireTypeName)) {
        existing.wireTypeNames.push(observation.wireTypeName);
      }
      return;
    }
    rows.set(key, {
      key,
      path: prefix,
      no: observation.no,
      name: observation.name,
      status: observation.status,
      declaredType: observation.declaredType,
      wireTypeNames: [observation.wireTypeName],
      count: 1,
      totalBytes: observation.byteLength,
    });
  };
  const walk = (audit, prefix) => {
    for (const observation of audit?.observations || []) {
      record(observation, prefix);
      if (observation.child) walk(observation.child, [...prefix, observation.name]);
    }
  };
  for (const audit of Array.isArray(audits) ? audits : [audits]) walk(audit, path);
  return [...rows.values()].sort((left, right) => left.key.localeCompare(right.key, "en"));
}

export function describeCensusRow(row) {
  const where = row.path.length ? `${row.path.join(".")}.` : "";
  const label = row.status === "unknown" ? "UNKNOWN" : row.name;
  const types = row.wireTypeNames.join("/");
  return `${where}field ${row.no} (${types}, ${row.totalBytes}B over ${row.count}) -> ${label}`;
}

export function unknownFieldRows(census) {
  return census.filter((row) => row.status === "unknown");
}

export function mismatchedFieldRows(census) {
  return census.filter((row) => row.status === "mismatched");
}
