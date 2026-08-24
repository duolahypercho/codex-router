import assert from "node:assert/strict";
import test from "node:test";

import {
  adapterCapabilities,
  chatChunkToResponsesEvents,
  chatMessagesToResponsesInput,
  chatToolsToResponses,
  normalizeOpenAIRequest,
  omitUnsupportedFields,
  responsesEventToChatChunks,
  responsesInputToChatMessages,
  responsesToolsToChat,
} from "../src/openai-adapters.mjs";

test("adapter profiles stay conservative and select the correct token field", () => {
  assert.equal(adapterCapabilities("openai-chat").maxOutputTokensField, "max_tokens");
  assert.equal(adapterCapabilities("openai-responses").maxOutputTokensField, "max_output_tokens");
  assert.equal(
    adapterCapabilities("openai-chat", { vision: false, parallelToolCalls: false }).vision,
    false,
  );
  // Invalid metadata cannot grant a capability by accident.
  assert.equal(adapterCapabilities("openai-chat", { tools: "yes" }).tools, true);
});

test("Responses function tools become Chat Completions tools without mutating input", () => {
  const tools = [{
    type: "function",
    name: "lookup",
    description: "Look up a value",
    parameters: { type: "object", properties: { key: { type: "string" } } },
    strict: true,
  }];
  const converted = responsesToolsToChat(tools);
  assert.deepEqual(converted, [{
    type: "function",
    function: {
      name: "lookup",
      description: "Look up a value",
      parameters: { type: "object", properties: { key: { type: "string" } } },
      strict: true,
    },
  }]);
  assert.deepEqual(tools, [{
    type: "function",
    name: "lookup",
    description: "Look up a value",
    parameters: { type: "object", properties: { key: { type: "string" } } },
    strict: true,
  }]);
});

test("Chat function tools become Responses tools", () => {
  assert.deepEqual(
    chatToolsToResponses([{
      type: "function",
      function: { name: "lookup", description: "Look up", parameters: { type: "object" } },
    }]),
    [{ type: "function", name: "lookup", description: "Look up", parameters: { type: "object" } }],
  );
});

test("Responses input preserves text, image, reasoning, tool calls, and results in Chat shape", () => {
  const messages = responsesInputToChatMessages([
    { type: "message", role: "user", content: [{ type: "input_text", text: "read" }, { type: "input_image", image_url: "data:image/png;base64,AAA" }] },
    { type: "reasoning", summary: [{ type: "summary_text", text: "think" }] },
    { type: "function_call", call_id: "call-1", name: "lookup", arguments: '{"key":"x"}' },
    { type: "function_call_output", call_id: "call-1", output: "value" },
  ]);
  assert.deepEqual(messages, [
    { role: "user", content: [{ type: "text", text: "read" }, { type: "image_url", image_url: { url: "data:image/png;base64,AAA" } }] },
    { role: "assistant", content: null, reasoning_content: "think", tool_calls: [{ id: "call-1", type: "function", function: { name: "lookup", arguments: '{"key":"x"}' } }] },
    { role: "tool", tool_call_id: "call-1", content: "value" },
  ]);
});

test("Chat messages round-trip to Responses input", () => {
  assert.deepEqual(
    chatMessagesToResponsesInput([
      { role: "system", content: "be brief" },
      { role: "assistant", reasoning_content: "think", content: "answer", tool_calls: [{ id: "call-1", type: "function", function: { name: "lookup", arguments: "{}" } }] },
      { role: "tool", tool_call_id: "call-1", content: "done" },
    ]),
    [
      { type: "message", role: "system", content: [{ type: "input_text", text: "be brief" }] },
      { type: "reasoning", summary: [{ type: "summary_text", text: "think" }] },
      { type: "message", role: "assistant", content: [{ type: "input_text", text: "answer" }] },
      { type: "function_call", call_id: "call-1", name: "lookup", arguments: "{}" },
      { type: "function_call_output", call_id: "call-1", output: "done" },
    ],
  );
});

test("unsupported fields are omitted by explicit capability, including images/search/reasoning", () => {
  const input = {
    stream: true,
    tools: [{ type: "function", function: { name: "lookup" } }, { type: "web_search" }],
    tool_choice: "required",
    parallel_tool_calls: true,
    reasoning_effort: "high",
    web_search_options: { search_context_size: "high" },
    response_format: { type: "json_object" },
    max_output_tokens: 50,
    messages: [{ role: "user", content: [{ type: "text", text: "hi" }, { type: "image_url", image_url: { url: "data:image/png;base64,AAA" } }] }],
  };
  const output = omitUnsupportedFields(input, {
    streaming: false,
    tools: false,
    parallelToolCalls: false,
    reasoning: "none",
    vision: false,
    webSearch: false,
    structuredOutput: false,
    maxOutputTokensField: "max_tokens",
  }, "openai-chat");
  assert.equal(output.stream, undefined);
  assert.equal(output.tools, undefined);
  assert.equal(output.tool_choice, undefined);
  assert.equal(output.parallel_tool_calls, undefined);
  assert.equal(output.reasoning_effort, undefined);
  assert.equal(output.web_search_options, undefined);
  assert.equal(output.response_format, undefined);
  assert.equal(output.max_tokens, 50);
  assert.deepEqual(output.messages[0].content, [{ type: "text", text: "hi" }]);
  assert.match(JSON.stringify(input), /image_url/);
});

test("normalizeOpenAIRequest selects protocol conversion and reasoning field", () => {
  const chat = normalizeOpenAIRequest({
    input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hello" }] }],
    tools: [{ type: "function", name: "lookup", parameters: { type: "object" } }],
    reasoning: { effort: "high" },
    max_output_tokens: 10,
  }, { adapter: "openai-chat" });
  assert.deepEqual(chat.messages, [{ role: "user", content: [{ type: "text", text: "hello" }] }]);
  assert.equal(chat.input, undefined);
  assert.equal(chat.reasoning, undefined);
  assert.equal(chat.reasoning_effort, "high");
  assert.equal(chat.max_tokens, 10);
  assert.deepEqual(chat.tools, [{ type: "function", function: { name: "lookup", parameters: { type: "object" } } }]);

  const responses = normalizeOpenAIRequest({
    messages: [{ role: "user", content: "hello" }],
    reasoning_effort: "low",
    max_tokens: 10,
  }, { adapter: "openai-responses" });
  assert.equal(responses.messages, undefined);
  assert.deepEqual(responses.input, [{ type: "message", role: "user", content: [{ type: "input_text", text: "hello" }] }]);
  assert.deepEqual(responses.reasoning, { effort: "low" });
  assert.equal(responses.max_output_tokens, 10);
});

test("stream event adapters preserve text, reasoning, tools, completion and usage", () => {
  assert.deepEqual(
    responsesEventToChatChunks({ type: "response.output_text.delta", delta: "hi" }, { id: "r1", model: "m" }),
    [{ id: "r1", object: "chat.completion.chunk", model: "m", choices: [{ index: 0, delta: { content: "hi" }, finish_reason: null }] }],
  );
  assert.deepEqual(
    responsesEventToChatChunks({ type: "response.function_call_arguments.delta", call_id: "c1", name: "lookup", delta: "{}" }),
    [{ id: "chatcmpl-router", object: "chat.completion.chunk", model: "", choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "c1", type: "function", function: { name: "lookup", arguments: "{}" } }] }, finish_reason: null }] }],
  );
  assert.deepEqual(
    chatChunkToResponsesEvents({ choices: [{ delta: { content: "hi", reasoning_content: "think", tool_calls: [{ id: "c1", function: { name: "lookup", arguments: "{}" } }] }, finish_reason: "stop" }], usage: { prompt_tokens: 1 } }, { id: "r1", model: "m" }),
    [
      { type: "response.output_text.delta", response_id: "r1", model: "m", delta: "hi" },
      { type: "response.reasoning_summary_text.delta", response_id: "r1", model: "m", delta: "think" },
      { type: "response.function_call_arguments.delta", response_id: "r1", model: "m", call_id: "c1", name: "lookup", delta: "{}" },
      { type: "response.completed", response: { id: "r1", model: "m", status: "completed", usage: { prompt_tokens: 1 }, output: [] } },
    ],
  );
});

