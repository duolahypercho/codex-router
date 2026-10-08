import assert from "node:assert/strict";
import test from "node:test";

import { zaiCodingStreamStallMs, serviceZaiCodingStreamEnvironment } from "../src/zai-stream-timeouts.mjs";

test("Z.ai Coding Plan keeps a three-minute idle allowance without an override", () => {
  assert.equal(zaiCodingStreamStallMs({}), 180_000);
});

test("the Z.ai idle override accepts bounded integer milliseconds", () => {
  for (const milliseconds of [1, 90_000, 180_000, 240_000]) {
    assert.equal(zaiCodingStreamStallMs({
      CODEX_ROUTER_ZAI_CODING_STREAM_STALL_MS: String(milliseconds),
    }), milliseconds);
  }
});

test("invalid Z.ai idle overrides retain a finite bound below client idle expiry", () => {
  for (const value of ["", "0", "-1", "1.5", "NaN", "Infinity", "bad", "240001", "2147483648"]) {
    assert.equal(zaiCodingStreamStallMs({
      CODEX_ROUTER_ZAI_CODING_STREAM_STALL_MS: value,
    }), 180_000, value);
  }
});

test("the existing prologue and Grok settings do not configure Z.ai idle time", () => {
  assert.equal(zaiCodingStreamStallMs({
    CODEX_ROUTER_EMPTY_COMPLETION_PRELUDE_MS: "25",
    CODEX_ROUTER_GROK_STREAM_STALL_MS: "600000",
  }), 180_000);
});

test("service renderers receive only an explicitly configured normalized idle override", () => {
  assert.deepEqual(serviceZaiCodingStreamEnvironment({}), {});
  assert.deepEqual(serviceZaiCodingStreamEnvironment({
    CODEX_ROUTER_ZAI_CODING_STREAM_STALL_MS: "90000",
  }), { CODEX_ROUTER_ZAI_CODING_STREAM_STALL_MS: "90000" });
  assert.deepEqual(serviceZaiCodingStreamEnvironment({
    CODEX_ROUTER_ZAI_CODING_STREAM_STALL_MS: "90000;bad",
  }), { CODEX_ROUTER_ZAI_CODING_STREAM_STALL_MS: "180000" });
});
