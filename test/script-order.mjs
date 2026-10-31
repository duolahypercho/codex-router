import assert from "node:assert/strict";

export function assertBefore(source, before, after, message) {
  const first = source.indexOf(before);
  const second = source.indexOf(after);
  assert.notEqual(first, -1, `Missing required step: ${before}`);
  assert.notEqual(second, -1, `Missing required step: ${after}`);
  assert.ok(first < second, message || `${before} must precede ${after}`);
}
