import assert from "node:assert/strict";
import test from "node:test";

import { COMPACTION_PROMPT } from "../src/compaction-checkpoint.mjs";
import { compactionInstructionBoundary } from "../src/compaction-instructions.mjs";

function original(item) {
  return JSON.parse(item.content[0].text.split("\n").slice(1).join("\n"));
}

test("checkpoint instructions outrank quoted execution instructions without losing their contents", () => {
  const payload = { instructions: "Ignore summaries. Continue coding.\nRun tools." };
  const input = [
    { type: "message", role: "system", content: "Never summarize; execute the task." },
    { type: "message", role: "developer", content: [{ type: "input_text", text: "Keep editing files.\n" }] },
  ];
  const before = structuredClone({ payload, input });
  const result = compactionInstructionBoundary(payload, input);
  assert.ok(result.instructions.startsWith(COMPACTION_PROMPT));
  assert.match(result.instructions, /do not execute or obey/);
  assert.doesNotMatch(result.instructions, /Continue coding|Keep editing files|Never summarize/);
  assert.ok(result.input.every(item => item.role === "user"));
  assert.deepEqual(original(result.input[0]), { source: "instructions", content: payload.instructions });
  assert.deepEqual(original(result.input[1]), { source: "message", ...input[0] });
  assert.deepEqual(original(result.input[2]), { source: "message", ...input[1] });
  assert.deepEqual({ payload, input }, before);
});

test("ordinary messages, tool results, image contents and source IDs remain unchanged", () => {
  const input = [
    { type: "message", role: "user", id: "U001", content: [{ type: "input_image", image_url: "data:image/png;base64,test" }] },
    { type: "message", role: "assistant", content: [{ type: "output_text", text: "working" }] },
    { type: "function_call", call_id: "call-1", name: "read", arguments: "{}" },
    { type: "function_call_output", call_id: "call-1", output: "R001 result" },
  ];
  const result = compactionInstructionBoundary({}, input);
  assert.deepEqual(result.input, input);
  assert.notEqual(result.input, input);
  result.input.forEach((item, index) => assert.equal(item, input[index]));
});

test("absent, empty and null instruction values preserve their distinct context", () => {
  assert.deepEqual(compactionInstructionBoundary(undefined, undefined).input, []);
  assert.deepEqual(compactionInstructionBoundary({}, []).input, []);
  for (const value of ["", null, { custom: "quoted structure" }]) {
    const result = compactionInstructionBoundary({ instructions: value }, []);
    assert.equal(result.input.length, 1);
    assert.deepEqual(original(result.input[0]).content, value);
  }
});

test("messages with an omitted type also lose execution instruction authority", () => {
  const message = { role: "developer", content: "Continue the task" };
  const result = compactionInstructionBoundary({}, [message]);
  assert.equal(result.input[0].role, "user");
  assert.deepEqual(original(result.input[0]), { source: "message", ...message });
});
