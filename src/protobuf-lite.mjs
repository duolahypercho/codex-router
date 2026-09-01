// The Cursor Agent edge needs a deliberately tiny subset of protobuf. Keeping
// this wire helper local avoids adding a generated-code runtime (and generated
// artifacts copied from a proprietary client) for a protocol surface that uses
// only varints and length-delimited values.

export function encodeVarint(value) {
  let remaining = BigInt(value);
  if (remaining < 0n) throw new Error("Negative protobuf varints are not supported here.");
  const bytes = [];
  do {
    let byte = Number(remaining & 0x7fn);
    remaining >>= 7n;
    if (remaining) byte |= 0x80;
    bytes.push(byte);
  } while (remaining);
  return Buffer.from(bytes);
}

export function encodeBytesField(number, value) {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value);
  return Buffer.concat([
    encodeVarint((BigInt(number) << 3n) | 2n),
    encodeVarint(bytes.length),
    bytes,
  ]);
}

export function encodeStringField(number, value) {
  return encodeBytesField(number, Buffer.from(String(value), "utf8"));
}

export function encodeMessageField(number, value) {
  return encodeBytesField(number, value);
}

export function encodeVarintField(number, value) {
  return Buffer.concat([
    encodeVarint(BigInt(number) << 3n),
    encodeVarint(value),
  ]);
}

export function encodeDoubleField(number, value) {
  const bytes = Buffer.alloc(8);
  bytes.writeDoubleLE(Number(value));
  return Buffer.concat([
    encodeVarint((BigInt(number) << 3n) | 1n),
    bytes,
  ]);
}

export function decodeVarint(buffer, offset = 0) {
  let value = 0n;
  let shift = 0n;
  for (let index = offset; index < buffer.length && shift <= 63n; index += 1) {
    const byte = buffer[index];
    value |= BigInt(byte & 0x7f) << shift;
    if (!(byte & 0x80)) return { value, offset: index + 1 };
    shift += 7n;
  }
  throw new Error("Malformed protobuf varint.");
}

export function decodeFields(buffer) {
  const fields = [];
  let offset = 0;
  while (offset < buffer.length) {
    const tag = decodeVarint(buffer, offset);
    offset = tag.offset;
    const number = Number(tag.value >> 3n);
    const wireType = Number(tag.value & 7n);
    if (!number) throw new Error("Malformed protobuf field number.");
    if (wireType === 0) {
      const decoded = decodeVarint(buffer, offset);
      fields.push({ number, wireType, value: decoded.value });
      offset = decoded.offset;
      continue;
    }
    if (wireType === 1) {
      if (offset + 8 > buffer.length) throw new Error("Truncated protobuf fixed64 field.");
      fields.push({ number, wireType, value: buffer.subarray(offset, offset + 8) });
      offset += 8;
      continue;
    }
    if (wireType === 2) {
      const decoded = decodeVarint(buffer, offset);
      offset = decoded.offset;
      const length = Number(decoded.value);
      if (!Number.isSafeInteger(length) || offset + length > buffer.length) {
        throw new Error("Truncated protobuf length-delimited field.");
      }
      fields.push({ number, wireType, value: buffer.subarray(offset, offset + length) });
      offset += length;
      continue;
    }
    if (wireType === 5) {
      if (offset + 4 > buffer.length) throw new Error("Truncated protobuf fixed32 field.");
      fields.push({ number, wireType, value: buffer.subarray(offset, offset + 4) });
      offset += 4;
      continue;
    }
    throw new Error(`Unsupported protobuf wire type ${wireType}.`);
  }
  return fields;
}

export function fieldValues(buffer, number) {
  return decodeFields(buffer).filter((field) => field.number === number).map((field) => field.value);
}

export function bytesField(buffer, number) {
  const value = fieldValues(buffer, number)[0];
  return Buffer.isBuffer(value) ? value : undefined;
}

export function stringField(buffer, number) {
  return bytesField(buffer, number)?.toString("utf8");
}

export function varintField(buffer, number) {
  const value = fieldValues(buffer, number)[0];
  return typeof value === "bigint" ? value : undefined;
}

export function connectEnvelope(payload, flags = 0) {
  const header = Buffer.alloc(5);
  header[0] = flags;
  header.writeUInt32BE(payload.length, 1);
  return Buffer.concat([header, payload]);
}

export function decodeConnectEnvelope(buffer) {
  if (buffer.length < 5) throw new Error("Truncated Connect envelope.");
  const length = buffer.readUInt32BE(1);
  if (buffer.length < 5 + length) throw new Error("Truncated Connect envelope payload.");
  return { flags: buffer[0], payload: buffer.subarray(5, 5 + length) };
}
