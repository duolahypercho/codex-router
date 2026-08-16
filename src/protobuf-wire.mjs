// A minimal protobuf reader/writer for the handful of messages the Devin CLI
// provider needs. The repository ships two runtime dependencies and hand-rolls
// its other structural parsers (`yaml-structure.mjs`, `toml-structure.mjs`), so
// a wire codec small enough to audit in one sitting is preferred over a
// general-purpose protobuf library.
//
// Schemas are declarative field tables:
//   { fieldName: { no: 3, type: "string" } }
// with `repeated: true` for repeated fields and `message: SCHEMA` for nested
// ones. Unknown fields decode into nothing and encode from nothing: this codec
// only has to round-trip what the router itself puts on the wire.

const WIRE_VARINT = 0;
const WIRE_FIXED64 = 1;
const WIRE_LENGTH = 2;
const WIRE_FIXED32 = 5;

const VARINT_TYPES = new Set(["bool", "enum", "int32", "int64", "uint32", "uint64", "sint32", "sint64"]);

class Writer {
  constructor() {
    this.chunks = [];
  }

  bytes(value) {
    this.chunks.push(value);
    return this;
  }

  varint(value) {
    let remaining = typeof value === "bigint" ? value : BigInt(Math.trunc(Number(value) || 0));
    if (remaining < 0n) remaining += 1n << 64n;
    const out = [];
    do {
      let byte = Number(remaining & 0x7fn);
      remaining >>= 7n;
      if (remaining > 0n) byte |= 0x80;
      out.push(byte);
    } while (remaining > 0n);
    return this.bytes(Uint8Array.from(out));
  }

  tag(fieldNumber, wireType) {
    return this.varint(fieldNumber * 8 + wireType);
  }

  finish() {
    let total = 0;
    for (const chunk of this.chunks) total += chunk.length;
    const out = new Uint8Array(total);
    let offset = 0;
    for (const chunk of this.chunks) {
      out.set(chunk, offset);
      offset += chunk.length;
    }
    return out;
  }
}

function zigzag(value, bits) {
  const wide = BigInt(Math.trunc(Number(value) || 0));
  const limit = BigInt(bits);
  return BigInt.asUintN(bits, (wide << 1n) ^ (wide >> (limit - 1n)));
}

function unzigzag(value) {
  return (value >> 1n) ^ -(value & 1n);
}

function writeScalar(writer, fieldNumber, type, value) {
  if (VARINT_TYPES.has(type)) {
    writer.tag(fieldNumber, WIRE_VARINT);
    if (type === "bool") return writer.varint(value ? 1 : 0);
    if (type === "sint32") return writer.varint(zigzag(value, 32));
    if (type === "sint64") return writer.varint(zigzag(value, 64));
    return writer.varint(value);
  }
  if (type === "string") {
    const encoded = new TextEncoder().encode(String(value));
    writer.tag(fieldNumber, WIRE_LENGTH).varint(encoded.length);
    return writer.bytes(encoded);
  }
  if (type === "bytes") {
    const encoded = value instanceof Uint8Array ? value : Uint8Array.from(value || []);
    writer.tag(fieldNumber, WIRE_LENGTH).varint(encoded.length);
    return writer.bytes(encoded);
  }
  if (type === "double") {
    const buffer = new Uint8Array(8);
    new DataView(buffer.buffer).setFloat64(0, Number(value) || 0, true);
    writer.tag(fieldNumber, WIRE_FIXED64);
    return writer.bytes(buffer);
  }
  if (type === "float") {
    const buffer = new Uint8Array(4);
    new DataView(buffer.buffer).setFloat32(0, Number(value) || 0, true);
    writer.tag(fieldNumber, WIRE_FIXED32);
    return writer.bytes(buffer);
  }
  throw new Error(`protobuf: unsupported field type ${type}`);
}

export function encodeMessage(schema, value) {
  const writer = new Writer();
  if (!value || typeof value !== "object") return writer.finish();
  for (const [name, field] of Object.entries(schema)) {
    const held = value[name];
    if (held === undefined || held === null) continue;
    const items = field.repeated ? (Array.isArray(held) ? held : [held]) : [held];
    for (const item of items) {
      if (item === undefined || item === null) continue;
      if (field.type === "message") {
        const nested = encodeMessage(field.message, item);
        writer.tag(field.no, WIRE_LENGTH).varint(nested.length).bytes(nested);
        continue;
      }
      writeScalar(writer, field.no, field.type, item);
    }
  }
  return writer.finish();
}

class Reader {
  constructor(buffer) {
    this.buffer = buffer;
    this.offset = 0;
  }

  get done() {
    return this.offset >= this.buffer.length;
  }

  varint() {
    let result = 0n;
    let shift = 0n;
    for (;;) {
      if (this.done) throw new Error("protobuf: truncated varint");
      const byte = this.buffer[this.offset++];
      result |= BigInt(byte & 0x7f) << shift;
      if ((byte & 0x80) === 0) return result;
      shift += 7n;
      if (shift > 63n) throw new Error("protobuf: varint overflow");
    }
  }

  slice(length) {
    if (this.offset + length > this.buffer.length) throw new Error("protobuf: truncated field");
    const out = this.buffer.subarray(this.offset, this.offset + length);
    this.offset += length;
    return out;
  }
}

function readScalar(reader, wireType, type) {
  if (wireType === WIRE_VARINT) {
    const raw = reader.varint();
    if (type === "bool") return raw !== 0n;
    if (type === "sint32" || type === "sint64") return Number(unzigzag(raw));
    if (type === "int32") return Number(BigInt.asIntN(32, raw));
    if (type === "int64") return Number(BigInt.asIntN(64, raw));
    return Number(raw);
  }
  if (wireType === WIRE_LENGTH) {
    const bytes = reader.slice(Number(reader.varint()));
    if (type === "string") return new TextDecoder().decode(bytes);
    return Uint8Array.from(bytes);
  }
  if (wireType === WIRE_FIXED64) {
    const bytes = reader.slice(8);
    const view = new DataView(bytes.buffer, bytes.byteOffset, 8);
    return type === "double" ? view.getFloat64(0, true) : Number(view.getBigUint64(0, true));
  }
  if (wireType === WIRE_FIXED32) {
    const bytes = reader.slice(4);
    const view = new DataView(bytes.buffer, bytes.byteOffset, 4);
    return type === "float" ? view.getFloat32(0, true) : view.getUint32(0, true);
  }
  throw new Error(`protobuf: unsupported wire type ${wireType}`);
}

function skip(reader, wireType) {
  if (wireType === WIRE_VARINT) return void reader.varint();
  if (wireType === WIRE_LENGTH) return void reader.slice(Number(reader.varint()));
  if (wireType === WIRE_FIXED64) return void reader.slice(8);
  if (wireType === WIRE_FIXED32) return void reader.slice(4);
  throw new Error(`protobuf: unsupported wire type ${wireType}`);
}

export function decodeMessage(schema, buffer) {
  const byNumber = new Map();
  for (const [name, field] of Object.entries(schema)) byNumber.set(field.no, { name, field });
  const reader = new Reader(buffer instanceof Uint8Array ? buffer : Uint8Array.from(buffer || []));
  const out = {};
  while (!reader.done) {
    const tag = Number(reader.varint());
    const fieldNumber = tag >>> 3;
    const wireType = tag & 7;
    const known = byNumber.get(fieldNumber);
    // An unknown field is expected traffic, not a fault: the upstream adds
    // fields without notice and a strict decoder would fail whole turns.
    if (!known) {
      skip(reader, wireType);
      continue;
    }
    const { name, field } = known;
    let value;
    if (field.type === "message") {
      if (wireType !== WIRE_LENGTH) {
        skip(reader, wireType);
        continue;
      }
      value = decodeMessage(field.message, reader.slice(Number(reader.varint())));
    } else if (field.repeated && VARINT_TYPES.has(field.type) && wireType === WIRE_LENGTH) {
      // A packed repeated scalar arrives as one length-delimited run.
      const packed = new Reader(reader.slice(Number(reader.varint())));
      const collected = out[name] || (out[name] = []);
      while (!packed.done) collected.push(readScalar(packed, WIRE_VARINT, field.type));
      continue;
    } else {
      value = readScalar(reader, wireType, field.type);
    }
    if (field.repeated) (out[name] || (out[name] = [])).push(value);
    else out[name] = value;
  }
  return out;
}
