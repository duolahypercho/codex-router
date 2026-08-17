import assert from "node:assert/strict";
import test from "node:test";

import {
  applyResponsesEvent,
  collectResponsesEvents,
  createTurnState,
  isProgressOnlyStop,
  mergeMappedUsage,
  parseSseBlockEvent,
  requestOffersClientTools,
  shouldPreferRetryTurn,
  sseDataFromBlock,
  toolCallDeltas,
  withProgressOnlyNudge,
} from "../src/grok-oauth-turn.mjs";

test("collectResponsesEvents keeps a function_call that only appears in output_item.done", () => {
  const turn = collectResponsesEvents([
    {
      type: "response.output_item.done",
      item: {
        type: "function_call",
        id: "fc_1",
        call_id: "call_1",
        name: "exec_command",
        arguments: '{"cmd":"dir"}',
      },
    },
    { type: "response.completed", response: { usage: { input_tokens: 10, output_tokens: 8 } } },
  ]);
  assert.equal(turn.finishReason, "tool_calls");
  assert.equal(turn.toolCalls.length, 1);
  assert.equal(turn.toolCalls[0].function.name, "exec_command");
  assert.equal(turn.toolCalls[0].function.arguments, '{"cmd":"dir"}');
  assert.equal(turn.deltas[0].tool_calls[0].function.arguments, '{"cmd":"dir"}');
});

test("finalizeTurn backfills streamed arguments when added is followed by done without deltas", () => {
  const turn = collectResponsesEvents([
    {
      type: "response.output_item.added",
      item: { type: "function_call", id: "fc_1", call_id: "call_1", name: "exec_command" },
    },
    {
      type: "response.output_item.done",
      item: {
        type: "function_call",
        id: "fc_1",
        call_id: "call_1",
        name: "exec_command",
        arguments: '{"cmd":"dir"}',
      },
    },
  ]);
  const streamedArgs = turn.deltas
    .flatMap((delta) => delta.tool_calls || [])
    .map((call) => call.function?.arguments || "")
    .join("");
  assert.equal(turn.toolCalls[0].function.arguments, '{"cmd":"dir"}');
  assert.equal(streamedArgs, '{"cmd":"dir"}');
});

test("collectResponsesEvents maps custom_tool_call onto a function tool call", () => {
  const turn = collectResponsesEvents([
    {
      type: "response.output_item.added",
      item: { type: "custom_tool_call", id: "ctc_1", call_id: "call_9", name: "exec" },
    },
    { type: "response.custom_tool_call_input.delta", item_id: "ctc_1", delta: '{"x":1}' },
    {
      type: "response.output_item.done",
      item: {
        type: "custom_tool_call",
        id: "ctc_1",
        call_id: "call_9",
        name: "exec",
        input: '{"x":1}',
      },
    },
  ]);
  assert.equal(turn.toolCalls[0].id, "call_9");
  assert.equal(turn.toolCalls[0].function.name, "exec");
  assert.equal(turn.toolCalls[0].function.arguments, '{"x":1}');
});

test("collectResponsesEvents copies reasoning tokens into usage details", () => {
  const turn = collectResponsesEvents([
    { type: "response.output_text.delta", delta: "ok" },
    {
      type: "response.completed",
      response: {
        usage: {
          input_tokens: 100,
          output_tokens: 1660,
          output_tokens_details: { reasoning_tokens: 1600 },
        },
      },
    },
  ]);
  assert.equal(turn.contentText, "ok");
  assert.equal(turn.usage.completion_tokens, 1660);
  assert.equal(turn.usage.completion_tokens_details.reasoning_tokens, 1600);
});

test("collectResponsesEvents preserves cached input tokens from the upstream usage", () => {
  const turn = collectResponsesEvents([
    {
      type: "response.completed",
      response: {
        usage: {
          input_tokens: 100,
          output_tokens: 20,
          input_tokens_details: { cached_tokens: 80 },
        },
      },
    },
  ]);
  assert.equal(turn.usage.prompt_tokens_details.cached_tokens, 80);
});

test("applyResponsesEvent accumulates output text", () => {
  const state = createTurnState();
  applyResponsesEvent(state, { type: "response.output_text.delta", delta: "先" });
  applyResponsesEvent(state, { type: "response.output_text.delta", delta: "看" });
  assert.equal(state.contentText, "先看");
});

test("sseDataFromBlock joins repeated data fields the way SSE requires", () => {
  const payload = { type: "response.output_text.delta", delta: "hi" };
  const pretty = JSON.stringify(payload, null, 2);
  const block = pretty
    .split("\n")
    .map((line) => `data: ${line}`)
    .join("\n");
  const joined = sseDataFromBlock(`event: response.output_text.delta\n${block}`);
  assert.equal(joined, pretty);
  assert.deepEqual(JSON.parse(joined), payload);
});

test("sseDataFromBlock keeps a single data field", () => {
  assert.equal(sseDataFromBlock("data: [DONE]"), "[DONE]");
  assert.equal(sseDataFromBlock("event: ping"), undefined);
});

test("parseSseBlockEvent skips malformed JSON and leaves handlers to throw", () => {
  assert.equal(parseSseBlockEvent("data: {not json"), undefined);
  assert.equal(parseSseBlockEvent("data: [DONE]"), undefined);
  assert.deepEqual(parseSseBlockEvent('data: {"type":"response.output_text.delta","delta":"x"}'), {
    type: "response.output_text.delta",
    delta: "x",
  });
});

test("isProgressOnlyStop requires short text, no tools, and enough output tokens", () => {
  const progress = {
    contentText: "Next I will update the deck.",
    toolCalls: [],
    usage: { completion_tokens: 1660 },
  };
  assert.equal(isProgressOnlyStop(progress), true);
  assert.equal(isProgressOnlyStop({ ...progress, toolCalls: [{ id: "c1" }] }), false);
  assert.equal(
    isProgressOnlyStop({ ...progress, contentText: "x".repeat(121) }),
    false,
  );
  assert.equal(
    isProgressOnlyStop({ ...progress, usage: { completion_tokens: 12 } }),
    false,
  );
});

test("requestOffersClientTools ignores hosted-only or empty tool lists", () => {
  assert.equal(requestOffersClientTools({}), false);
  assert.equal(requestOffersClientTools({ tools: [] }), false);
  assert.equal(
    requestOffersClientTools({ tools: [{ type: "web_search" }] }),
    false,
  );
  assert.equal(
    requestOffersClientTools({
      tools: [{ type: "function", function: { name: "exec_command" } }],
    }),
    true,
  );
});

test("shouldPreferRetryTurn keeps the first answer when the retry also has no tools", () => {
  assert.equal(shouldPreferRetryTurn({ toolCalls: [] }), false);
  assert.equal(shouldPreferRetryTurn({ toolCalls: [{ id: "c1" }] }), true);
});

test("withProgressOnlyNudge appends a user message so the instructions prefix stays put", () => {
  const nudged = withProgressOnlyNudge({
    model: "grok-4.6",
    messages: [
      { role: "system", content: "You are Codex." },
      { role: "user", content: "update the deck" },
    ],
  });
  assert.equal(nudged.messages[0].role, "system");
  assert.equal(nudged.messages.at(-1).role, "user");
  // The no-tool branch comes first so a finished turn can decline rather than
  // invent a call the client would run.
  assert.match(nudged.messages.at(-1).content, /^If your previous message already completed/);
  assert.match(nudged.messages.at(-1).content, /call no tool/);
  assert.match(nudged.messages.at(-1).content, /Otherwise continue the same task now/);
});

test("mergeMappedUsage adds both attempts and marks retries", () => {
  const merged = mergeMappedUsage(
    {
      prompt_tokens: 100,
      completion_tokens: 1660,
      total_tokens: 1760,
      prompt_tokens_details: { cached_tokens: 80 },
      completion_tokens_details: { reasoning_tokens: 1600 },
    },
    {
      prompt_tokens: 110,
      completion_tokens: 40,
      total_tokens: 150,
      prompt_tokens_details: { cached_tokens: 80 },
      completion_tokens_details: { reasoning_tokens: 10 },
    },
  );
  assert.equal(merged.prompt_tokens, 210);
  assert.equal(merged.completion_tokens, 1700);
  assert.equal(merged.total_tokens, 1910);
  assert.equal(merged.prompt_tokens_details.cached_tokens, 160);
  assert.equal(merged.completion_tokens_details.reasoning_tokens, 1610);
  assert.equal(merged.retries, 1);
  assert.equal(merged.progress_only_retried, true);
});

test("mergeMappedUsage still marks retries when one attempt reported no usage", () => {
  const onlySecond = mergeMappedUsage(undefined, {
    prompt_tokens: 10,
    completion_tokens: 4,
    total_tokens: 14,
  });
  assert.equal(onlySecond.prompt_tokens, 10);
  assert.equal(onlySecond.retries, 1);
  assert.equal(onlySecond.progress_only_retried, true);
});

test("toolCallDeltas drops text and keeps only tool-call chunks", () => {
  const deltas = toolCallDeltas({
    deltas: [
      { content: "Next I will update the deck." },
      { tool_calls: [{ index: 0, function: { name: "exec_command", arguments: "{" } }] },
      { content: "ignored retry prose" },
    ],
  });
  assert.equal(deltas.length, 1);
  assert.equal(deltas[0].tool_calls[0].function.name, "exec_command");
});
