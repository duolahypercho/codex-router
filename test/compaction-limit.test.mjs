import test from "node:test";
import assert from "node:assert/strict";
import { shouldSkipRemoteCompactV2 } from "../src/compaction-limit.mjs";

test("remote compaction v2 is skipped when it would run under autoCompact", () => {
  const payload = {
    input: [
      { type: "message", content: "small" },
      { type: "compaction_trigger" },
    ],
  };
  const route = { contextWindow: 256_000, autoCompact: 200_000 };
  assert.equal(shouldSkipRemoteCompactV2(payload, route, JSON.stringify(payload)), true);
});

test("remote compaction v2 is not skipped when estimated input exceeds autoCompact", () => {
  const payload = {
    input: [
      { type: "message", content: "x".repeat(1_000_000) },
      { type: "compaction_trigger" },
    ],
  };
  const route = { contextWindow: 10_000, autoCompact: 8_000 };
  assert.equal(shouldSkipRemoteCompactV2(payload, route, JSON.stringify(payload)), false);
});

test("remote compaction v2 is not skipped without a route", () => {
  const payload = { input: [{ type: "compaction_trigger" }] };
  assert.equal(shouldSkipRemoteCompactV2(payload, undefined, "{}"), false);
});

test("remote compaction v2 is not skipped when the trigger is absent", () => {
  const payload = { input: [{ type: "message", content: "hello" }] };
  const route = { contextWindow: 256_000, autoCompact: 200_000 };
  assert.equal(shouldSkipRemoteCompactV2(payload, route, JSON.stringify(payload)), false);
});

test("remote compaction v2 is not skipped when autoCompact is missing", () => {
  const payload = { input: [{ type: "compaction_trigger" }] };
  const route = { contextWindow: 256_000 };
  assert.equal(shouldSkipRemoteCompactV2(payload, route, JSON.stringify(payload)), false);
});
