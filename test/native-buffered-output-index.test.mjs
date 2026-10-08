import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

import { foldResponsesSse } from "../src/native-buffered-response.mjs";

const item = (id) => ({ id, type: "message", role: "assistant", content: [] });
const frame = (event) => `data: ${JSON.stringify(event)}\n\n`;
const done = (output = []) => frame({
  type: "response.completed",
  response: { id: "resp_index", status: "completed", output },
});
const output = (index, value) => frame({
  type: "response.output_item.done", output_index: index, item: value,
});

test("native folding retains sparse output indices outside the array-index range", () => {
  const result = foldResponsesSse(output(2 ** 32, item("late")) + output(0, item("first")) + done());
  assert.equal(result.status, 200);
  assert.deepEqual(result.body.output, [item("first"), item("late")]);
});

test("native folding work is bounded by received items rather than the largest index", () => {
  const moduleUrl = new URL("../src/native-buffered-response.mjs", import.meta.url).href;
  const wire = output(2 ** 32 - 2, item("large")) + done();
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", `
    import { foldResponsesSse } from ${JSON.stringify(moduleUrl)};
    process.stdout.write(JSON.stringify(foldResponsesSse(${JSON.stringify(wire)})));
  `], { encoding: "utf8", timeout: 10_000, windowsHide: true });
  assert.equal(child.error, undefined, "a single sparse item must not scan billions of empty slots");
  assert.equal(child.status, 0, child.stderr);
  assert.deepEqual(JSON.parse(child.stdout).body.output, [item("large")]);
});

test("native folding keeps index order, replacements, and unindexed fallback items", () => {
  const wire = output(3, item("old")) + output(1, item("first")) +
    output(3, item("replacement")) + output(undefined, item("unindexed")) + done();
  assert.deepEqual(foldResponsesSse(wire).body.output, [
    item("first"), item("replacement"), item("unindexed"),
  ]);
  assert.deepEqual(foldResponsesSse(wire + done([item("snapshot")])).body.output, [item("snapshot")]);
});

test("malformed native output indices fail instead of silently dropping items", () => {
  for (const index of [-1, 0.5, "0", null, Number.MAX_SAFE_INTEGER + 1]) {
    const result = foldResponsesSse(output(index, item("invalid")) + done());
    assert.equal(result.status, 502, String(index));
    assert.equal(result.body.error.code, "native_stream_invalid_output_index", String(index));
    assert.equal(result.body.output, undefined, "a rejected item is not returned as usable output");
  }
});
