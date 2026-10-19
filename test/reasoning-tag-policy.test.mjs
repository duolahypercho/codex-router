import assert from "node:assert/strict";
import { Readable, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import test from "node:test";

import {
  REASONING_TAG_POLICIES,
  reasoningTagOptionsForRoute,
  reasoningTagPolicyKnown,
  reasoningTagPolicyProblem,
} from "../src/reasoning-tag-policy.mjs";
import { reasoningTagStripperTransform, stripThinkTags } from "../src/reasoning-tag-stripper.mjs";

function frame(event) {
  return `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}

async function routedText(route, text) {
  const input = frame({ type: "response.output_text.delta", output_index: 0, delta: text }) +
    frame({ type: "response.output_text.done", output_index: 0, text }) +
    frame({ type: "response.output_item.done", output_index: 0,
      item: { type: "message", role: "assistant", content: [{ type: "output_text", text }] } });
  const options = reasoningTagOptionsForRoute(route);
  const transform = options ? reasoningTagStripperTransform("text/event-stream", options) : undefined;
  if (!transform) return { input, output: input };
  const chunks = [];
  await pipeline(Readable.from([Buffer.from(input)]), transform, new Writable({
    write(chunk, _encoding, callback) { chunks.push(chunk); callback(); },
  }));
  return { input, output: Buffer.concat(chunks).toString("utf8") };
}

function textEvents(output) {
  return output.split("\n\n").flatMap((block) => {
    const data = block.split("\n").find((line) => line.startsWith("data: "));
    if (!data) return [];
    const event = JSON.parse(data.slice(6));
    return event.delta !== undefined ? [event.delta] : event.text !== undefined ? [event.text] :
      event.item ? [event.item.content[0].text] : [];
  });
}

test("unknown native Responses routes preserve literal XML and reasoning-tag examples byte-for-byte", async () => {
  const text = "XML: `<reason>disk full</reason>`.\n```xml\n<think>visible sample</think>\n```\nTail: <th";
  for (const route of [undefined,
    { provider: "custom", upstreamModel: "z-ai/glm-5.3", endpoint: { protocol: "openai-responses" } },
    { provider: "runtime-responses", upstreamModel: "grok-4.6", protocol: "openai-responses" },
    { provider: "openrouter", upstreamModel: "qwen/qwen3.8-flash" },
    { provider: "custom", upstreamModel: "Qwen/Qwen3.8-27B", requestProfile: "qwen38-community" },
    { provider: "zai-coding", upstreamModel: "glm-5.3", requestProfile: "glm-thinking" },
  ]) {
    assert.equal(reasoningTagOptionsForRoute(route), undefined);
    const { input, output } = await routedText(route, text);
    assert.equal(output, input);
  }
});

test("explicit legacy opt-in cleans an evidenced inline leak even over Responses", async () => {
  const route = { provider: "custom", upstreamModel: "vendor/model", reasoningTagPolicy: "legacy-inline",
    endpoint: { protocol: "openai-responses" } };
  assert.deepEqual(reasoningTagOptionsForRoute(route), { plainDelimiters: true, nonceDelimiters: false });
  const { output } = await routedText(route, "<think>hidden</think>\nVisible answer");
  assert.deepEqual(textEvents(output), ["Visible answer", "Visible answer", "Visible answer"]);
});

test("captured legacy default is exact-route scoped and explicit preserve overrides it", async () => {
  const captured = { provider: "qwen-plan", upstreamModel: "qwen3.8-flash", requestProfile: "qwen-plan" };
  assert.deepEqual(reasoningTagOptionsForRoute(captured), { plainDelimiters: true, nonceDelimiters: false });
  for (const changed of [
    { ...captured, upstreamModel: "qwen3.8-max" },
    { ...captured, provider: "custom" },
    { requestProfile: "qwen-plan" },
    { ...captured, reasoningTagPolicy: "preserve" },
  ]) assert.equal(reasoningTagOptionsForRoute(changed), undefined);
  const text = "`<reason>this is legitimate XML</reason>`";
  const { input, output } = await routedText({ ...captured, reasoningTagPolicy: "preserve" }, text);
  assert.equal(output, input);
});

test("Hy4 defaults to nonce-only grammar, preserves bare tags, and honors explicit preserve", async () => {
  const route = { provider: "commandcode", upstreamModel: "hy4-preview" };
  const options = reasoningTagOptionsForRoute(route);
  assert.deepEqual(options, { plainDelimiters: false, nonceDelimiters: true });
  const literal = "XML: <reason>disk full</reason> and <think>visible</think>.";
  const { input, output } = await routedText(route, literal);
  assert.equal(output, input);
  assert.equal(stripThinkTags("hidden</think:abc123>Answer", options), "Answer");
  assert.equal(stripThinkTags("<think:abc123>hidden</think:abc123>Answer", options), "Answer");
  assert.equal(reasoningTagOptionsForRoute({ ...route, reasoningTagPolicy: "preserve" }), undefined);
  assert.deepEqual(reasoningTagOptionsForRoute({ ...route, reasoningTagPolicy: "legacy-inline" }),
    { plainDelimiters: true, nonceDelimiters: true });
  assert.deepEqual(reasoningTagOptionsForRoute({ ...route, reasoningTagPolicy: "hy4-nonce" }), options);
});

test("policy validation rejects unknown values and cannot lend Hy4 semantics to other models", () => {
  assert.deepEqual(REASONING_TAG_POLICIES, ["preserve", "legacy-inline", "hy4-nonce"]);
  for (const policy of REASONING_TAG_POLICIES) assert.equal(reasoningTagPolicyKnown(policy), true);
  for (const policy of [null, true, 1, "legacy", {}, ["preserve"]]) {
    assert.equal(reasoningTagPolicyKnown(policy), false);
    assert.match(reasoningTagPolicyProblem({ reasoningTagPolicy: policy }), /invalid reasoningTagPolicy/);
    assert.throws(() => reasoningTagOptionsForRoute({ reasoningTagPolicy: policy }), /invalid reasoningTagPolicy/);
  }
  const forged = { provider: "custom", upstreamModel: "ordinary-model", reasoningTagPolicy: "hy4-nonce" };
  assert.match(reasoningTagPolicyProblem(forged), /only use reasoningTagPolicy hy4-nonce/);
  assert.throws(() => reasoningTagOptionsForRoute(forged), /only use reasoningTagPolicy hy4-nonce/);
  assert.deepEqual(reasoningTagOptionsForRoute({ ...forged, reasoningTagPolicy: "legacy-inline" }),
    { plainDelimiters: true, nonceDelimiters: false });
});
