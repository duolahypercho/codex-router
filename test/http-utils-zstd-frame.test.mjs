import assert from "node:assert/strict";
import test from "node:test";
import { zstdCompressSync } from "node:zlib";

import { zstdFrameContentSize } from "../src/http-utils.mjs";

const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

// Hand-built frame headers, so every field width the parser understands is
// exercised regardless of which shape Node's encoder happens to emit.
function frame({ sizeFlag, singleSegment = false, dictionaryFlag = 0, size }) {
  const descriptor = (sizeFlag << 6) | (singleSegment ? 0x20 : 0) | dictionaryFlag;
  const parts = [MAGIC, Buffer.from([descriptor])];
  if (!singleSegment) parts.push(Buffer.from([0x00]));
  parts.push(Buffer.alloc([0, 1, 2, 4][dictionaryFlag]));
  const width = sizeFlag === 0 ? (singleSegment ? 1 : 0) : [0, 2, 4, 8][sizeFlag];
  if (width === 1) parts.push(Buffer.from([size]));
  else if (width === 2) {
    const field = Buffer.alloc(2);
    field.writeUInt16LE(size - 256);
    parts.push(field);
  } else if (width === 4) {
    const field = Buffer.alloc(4);
    field.writeUInt32LE(size);
    parts.push(field);
  } else if (width === 8) {
    const field = Buffer.alloc(8);
    field.writeBigUInt64LE(BigInt(size));
    parts.push(field);
  }
  return Buffer.concat(parts);
}

test("a real encoder's frame declares exactly the size it will inflate to", () => {
  // Spans the 1-byte, 2-byte, and 4-byte size forms an encoder picks by
  // payload length. The declared value is what the router compares against
  // its cap, so it has to equal the true length, not merely bound it.
  for (const length of [0, 1, 200, 255, 256, 300, 70_000, 2 * 1024 * 1024]) {
    const compressed = zstdCompressSync(Buffer.alloc(length, 0x61));
    assert.equal(zstdFrameContentSize(compressed), length, `length ${length}`);
  }
});

test("every header layout the format allows is read at the right offset", () => {
  assert.equal(zstdFrameContentSize(frame({ sizeFlag: 0, singleSegment: true, size: 200 })), 200);
  assert.equal(zstdFrameContentSize(frame({ sizeFlag: 1, size: 300 })), 300);
  assert.equal(zstdFrameContentSize(frame({ sizeFlag: 1, singleSegment: true, size: 300 })), 300);
  assert.equal(zstdFrameContentSize(frame({ sizeFlag: 2, size: 5_000_000 })), 5_000_000);
  assert.equal(zstdFrameContentSize(frame({ sizeFlag: 3, size: 7_000_000_000 })), 7_000_000_000);
  // A dictionary id shifts the size field by its own width.
  for (const dictionaryFlag of [1, 2, 3]) {
    assert.equal(
      zstdFrameContentSize(frame({ sizeFlag: 2, dictionaryFlag, size: 123_456 })),
      123_456,
      `dictionary flag ${dictionaryFlag}`,
    );
  }
});

test("a frame that omits its content size reports nothing rather than guessing", () => {
  // Size flag 0 without Single_Segment means no field at all, the shape a
  // streaming encoder produces.
  assert.equal(zstdFrameContentSize(frame({ sizeFlag: 0, size: 0 })), undefined);
});

test("bytes that are not a zstd frame, or not a whole header, report nothing", () => {
  assert.equal(zstdFrameContentSize(Buffer.from("{\"model\":\"x\"}")), undefined);
  assert.equal(zstdFrameContentSize(Buffer.alloc(0)), undefined);
  assert.equal(zstdFrameContentSize("not a buffer"), undefined);
  const whole = frame({ sizeFlag: 2, size: 4096 });
  for (let cut = 0; cut < whole.length; cut += 1) {
    assert.equal(zstdFrameContentSize(whole.subarray(0, cut)), undefined, `cut at ${cut}`);
  }
});

test("a declared size beyond the safe-integer range clamps instead of overflowing", () => {
  const header = frame({ sizeFlag: 3, size: 1 });
  header.writeBigUInt64LE(0xffffffffffffffffn, header.length - 8);
  assert.equal(zstdFrameContentSize(header), Number.MAX_SAFE_INTEGER);
});
