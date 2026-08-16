import assert from "node:assert/strict";
import test from "node:test";

import { CHAT_MESSAGE_SOURCE, STOP_REASON } from "../src/devin-proto.mjs";
import {
  buildChatMessageRequest,
  finishReasonFor,
  usageFrom,
  withToolDescriptions,
} from "../src/devin-cli-turn.mjs";

function ids() {
  let next = 0;
  return () => `id-${(next += 1)}`;
}

function build(chat, overrides = {}) {
  return buildChatMessageRequest(chat, { token: "tok", modelUid: "glm-5-2", newId: ids(), ...overrides });
}

test("carries the system prompt in `prompt`, not as a chat message", () => {
  const request = build({
    messages: [
      { role: "system", content: "Be terse." },
      { role: "user", content: "hi" },
    ],
  });
  assert.equal(request.prompt, "Be terse.");
  assert.equal(request.chatMessagePrompts.length, 1);
  assert.equal(request.chatMessagePrompts[0].source, CHAT_MESSAGE_SOURCE.USER);
});

test("treats a developer message as a system message", () => {
  const request = build({ messages: [{ role: "developer", content: "rules" }, { role: "user", content: "hi" }] });
  assert.equal(request.prompt, "rules");
});

// Cascade has no assistant source; the shipped client sends prior model turns
// as SYSTEM and a turn built any other way is rejected upstream.
test("maps an assistant turn to the SYSTEM source with its tool calls attached", () => {
  const request = build({
    messages: [
      { role: "user", content: "read a file" },
      {
        role: "assistant",
        content: "",
        tool_calls: [{ id: "call_1", type: "function", function: { name: "read", arguments: '{"p":"a"}' } }],
      },
      { role: "tool", tool_call_id: "call_1", content: "contents" },
    ],
  });
  const [user, assistantTurn, toolResult] = request.chatMessagePrompts;
  assert.equal(user.source, CHAT_MESSAGE_SOURCE.USER);
  assert.equal(assistantTurn.source, CHAT_MESSAGE_SOURCE.SYSTEM);
  assert.deepEqual(assistantTurn.toolCalls, [{ id: "call_1", name: "read", argumentsJson: '{"p":"a"}' }]);
  assert.equal(toolResult.source, CHAT_MESSAGE_SOURCE.TOOL);
  assert.equal(toolResult.toolCallId, "call_1");
});

// Replaying a historical image fails the whole request with invalid_argument,
// so only the current turn may carry image data.
test("attaches images from the current turn and replaces older ones with a placeholder", () => {
  const image = {
    type: "image_url",
    image_url: { url: "data:image/png;base64,AAAA" },
  };
  const request = build({
    messages: [
      { role: "user", content: [{ type: "text", text: "old" }, image] },
      { role: "assistant", content: "ok" },
      { role: "user", content: [{ type: "text", text: "new" }, image] },
    ],
  });
  const [historical, , current] = request.chatMessagePrompts;
  assert.equal(historical.images, undefined);
  assert.match(historical.prompt, /\[Image omitted from history\]/);
  assert.deepEqual(current.images, [{ mimeType: "image/png", base64Data: "AAAA" }]);
});

test("sends tool definitions with their JSON schema serialized", () => {
  const request = build({
    messages: [{ role: "user", content: "go" }],
    tools: [
      {
        type: "function",
        function: {
          name: "read",
          description: "Read a file.",
          parameters: { type: "object", properties: { path: { type: "string" } } },
        },
      },
    ],
  });
  assert.equal(request.tools.length, 1);
  assert.equal(request.tools[0].name, "read");
  assert.deepEqual(JSON.parse(request.tools[0].jsonSchemaString).properties.path, { type: "string" });
});

test("omits parameters-less tools' schema as an empty object rather than null", () => {
  const request = build({
    messages: [{ role: "user", content: "go" }],
    tools: [{ type: "function", function: { name: "ping", description: "d" } }],
  });
  assert.deepEqual(JSON.parse(request.tools[0].jsonSchemaString), { type: "object", properties: {} });
});

test("maps a named tool choice to toolName and a keyword to optionName", () => {
  const named = build({
    messages: [{ role: "user", content: "go" }],
    tool_choice: { type: "function", function: { name: "read" } },
  });
  assert.deepEqual(named.toolChoice, { toolName: "read" });
  const keyword = build({ messages: [{ role: "user", content: "go" }], tool_choice: "required" });
  assert.deepEqual(keyword.toolChoice, { optionName: "required" });
});

test("appends a tool description block to the system prompt", () => {
  const prompt = withToolDescriptions("Be terse.", [
    { function: { name: "read", description: "Read a <file>." } },
    { function: { name: "nodesc" } },
  ]);
  assert.match(prompt, /^Be terse\.\n\n# tools descriptions\n/);
  assert.match(prompt, /<tool name="read">/);
  assert.match(prompt, /Read a &lt;file&gt;\./);
  assert.doesNotMatch(prompt, /nodesc/);
});

test("leaves the system prompt alone when no tool carries a description", () => {
  assert.equal(withToolDescriptions("Be terse.", []), "Be terse.");
});

test("honours an explicit max_tokens and falls back otherwise", () => {
  assert.equal(build({ messages: [], max_tokens: 512 }).configuration.maxTokens, 512);
  assert.equal(build({ messages: [] }).configuration.maxTokens, 128_000);
});

test("disables parallel tool calls only when the caller asked", () => {
  assert.equal(build({ messages: [], parallel_tool_calls: false }).disableParallelToolCalls, true);
  assert.equal(build({ messages: [] }).disableParallelToolCalls, undefined);
});

test("puts the session token in metadata where the upstream reads it", () => {
  assert.equal(build({ messages: [] }).metadata.apiKey, "tok");
  assert.equal(build({ messages: [] }).chatModelUid, "glm-5-2");
});

test("reports a tool-call finish whenever a call was seen, whatever the stop reason", () => {
  assert.equal(finishReasonFor(STOP_REASON.STOP_PATTERN, true), "tool_calls");
  assert.equal(finishReasonFor(STOP_REASON.FUNCTION_CALL, false), "tool_calls");
  assert.equal(finishReasonFor(STOP_REASON.MAX_TOKENS, false), "length");
  assert.equal(finishReasonFor(STOP_REASON.CONTENT_FILTER, false), "content_filter");
  assert.equal(finishReasonFor(STOP_REASON.STOP_PATTERN, false), "stop");
});

test("translates usage, including cached prompt tokens", () => {
  assert.deepEqual(usageFrom({ inputTokens: 10, outputTokens: 4, cacheReadTokens: 6 }), {
    prompt_tokens: 10,
    completion_tokens: 4,
    total_tokens: 14,
    prompt_tokens_details: { cached_tokens: 6 },
  });
  assert.equal(usageFrom(undefined), undefined);
});
