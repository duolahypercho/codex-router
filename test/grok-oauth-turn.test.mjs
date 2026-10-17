import assert from "node:assert/strict";
import test from "node:test";

import {
  applyResponsesEvent,
  chatServiceTierFields,
  classifyAfterToolRepair,
  collectResponsesEvents,
  createTurnState,
  finalizeTurn,
  isProgressOnlyStop,
  lastClientMessageWasToolResult,
  mergeMappedUsage,
  parseSseBlockEvent,
  requestOffersClientTools,
  REPAIR_FINAL_TOOL,
  selectedRetryUsage,
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

test("createTurnState can restore a provider-facing tool alias", () => {
  const state = createTurnState({
    toolNameMapper: (name) => (name === "inspect_image" ? "view_image" : name),
  });
  applyResponsesEvent(state, {
    type: "response.output_item.done",
    item: {
      type: "function_call",
      id: "fc_image",
      call_id: "call_image",
      name: "inspect_image",
      arguments: '{"path":"C:\\\\image.jpg"}',
    },
  });
  applyResponsesEvent(state, { type: "response.completed" });
  const turn = finalizeTurn(state);
  assert.equal(turn.toolCalls[0].function.name, "view_image");
  assert.equal(turn.deltas[0].tool_calls[0].function.name, "view_image");
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
    { type: "response.completed" },
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
    { type: "response.completed" },
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

test("collectResponsesEvents maps xAI reasoning deltas onto reasoning_content", () => {
  const turn = collectResponsesEvents([
    { type: "response.reasoning_summary_text.delta", delta: "先想" },
    { type: "response.reasoning_text.delta", delta: "再想" },
    { type: "response.output_text.delta", delta: "答案" },
    { type: "response.completed" },
  ]);
  assert.equal(turn.reasoningText, "先想再想");
  assert.equal(turn.contentText, "答案");
  assert.deepEqual(turn.deltas, [
    { reasoning_content: "先想" },
    { reasoning_content: "再想" },
    { content: "答案" },
  ]);
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
    terminalStatus: "completed",
    contentText: "Still thinking about it.",
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

test("isProgressOnlyStop repairs only an empty completed response after a tool result", () => {
  const stop = {
    terminalStatus: "completed",
    contentText: "The figures are ready.",
    toolCalls: [],
    usage: { completion_tokens: 95 },
  };
  assert.equal(isProgressOnlyStop(stop, { afterToolResult: true }), false);
  assert.equal(isProgressOnlyStop({ ...stop, contentText: " \n" }, { afterToolResult: true }), true);
  assert.equal(isProgressOnlyStop(stop), false);
  assert.equal(isProgressOnlyStop({ ...stop, toolCalls: [{ id: "c1" }] }, { afterToolResult: true }), false);
});

test("isProgressOnlyStop accepts native long prose after a tool result", () => {
  assert.equal(
    isProgressOnlyStop(
      {
        terminalStatus: "completed",
        contentText: "This may look final, but the router cannot infer task completion. ".repeat(4),
        toolCalls: [],
        usage: { completion_tokens: 20 },
      },
      { afterToolResult: true },
    ),
    false,
  );
});

test("lastClientMessageWasToolResult ignores system and user tails", () => {
  assert.equal(lastClientMessageWasToolResult({ messages: [] }), false);
  assert.equal(
    lastClientMessageWasToolResult({
      messages: [{ role: "user", content: "go" }],
    }),
    false,
  );
  assert.equal(
    lastClientMessageWasToolResult({
      messages: [
        { role: "system", content: "You are Codex." },
        { role: "assistant", tool_calls: [{ id: "c1" }] },
        { role: "tool", tool_call_id: "c1", content: "ok" },
      ],
    }),
    true,
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
  assert.equal(shouldPreferRetryTurn({ terminalStatus: "completed", toolCalls: [] }), false);
  assert.equal(shouldPreferRetryTurn({ terminalStatus: "completed", toolCalls: [{ id: "c1" }] }), true);
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

test("withProgressOnlyNudge leads with continue after a tool result", () => {
  const nudged = withProgressOnlyNudge(
    { messages: [{ role: "tool", content: "ok" }] },
    { afterToolResult: true },
  );
  assert.equal(nudged.messages.at(-1).role, "developer");
  assert.match(nudged.messages.at(-1).content, /^The previous tool call finished/);
  assert.match(nudged.messages.at(-1).content, /Call the next task tool/);
  assert.match(nudged.messages.at(-1).content, new RegExp(REPAIR_FINAL_TOOL));
  assert.equal(nudged.tool_choice, "auto");
  assert.equal(nudged.tools.at(-1).function.name, REPAIR_FINAL_TOOL);
  assert.doesNotMatch(nudged.messages.at(-1).content, /^If your previous message already completed/);
});

test("classifyAfterToolRepair accepts tools, native text and an optional private final", () => {
  assert.deepEqual(
    classifyAfterToolRepair({
      terminalStatus: "completed",
      toolCalls: [{ id: "c1", function: { name: "exec_command", arguments: "{}" } }],
      contentText: "status",
    }),
    { action: "tools" },
  );
  assert.deepEqual(
    classifyAfterToolRepair({
      terminalStatus: "completed",
      toolCalls: [
        { function: { name: REPAIR_FINAL_TOOL, arguments: JSON.stringify({ answer: "Done." }) } },
      ],
    }),
    { action: "final", contentText: "Done." },
  );
  assert.deepEqual(classifyAfterToolRepair({ terminalStatus: "completed", toolCalls: [], contentText: "Still working." }), {
    action: "final", contentText: "Still working.",
  });
  for (const contentText of [undefined, "", " \n\t"]) {
    assert.deepEqual(classifyAfterToolRepair({ terminalStatus: "completed", toolCalls: [], contentText }), { action: "fail" });
  }
  assert.deepEqual(
    classifyAfterToolRepair({
      terminalStatus: "completed",
      toolCalls: [
        { function: { name: REPAIR_FINAL_TOOL, arguments: JSON.stringify({ answer: "   " }) } },
      ],
    }),
    { action: "fail" },
  );
  assert.deepEqual(classifyAfterToolRepair({
    terminalStatus: "completed",
    toolCalls: [{ function: { name: REPAIR_FINAL_TOOL, arguments: "{" } }],
  }), {
    action: "fail",
  });
});

test("post-tool nudge offers its private final only within the explicit client tool capacity", () => {
  for (const maxTools of [348, 350]) {
    for (const clientToolCount of [maxTools - 1, maxTools]) {
      const tools = Array.from({ length: clientToolCount }, (_, index) => ({
        type: "function", function: { name: `fixture_${index}` },
      }));
      const nudged = withProgressOnlyNudge({ tools, messages: [{ role: "tool", content: "done" }] }, {
        afterToolResult: true, maxTools, clientToolCount,
      });
      const offered = clientToolCount < maxTools;
      assert.equal(nudged.tools.length, offered ? clientToolCount + 1 : clientToolCount);
      assert.equal(nudged.messages.at(-1).content.includes(REPAIR_FINAL_TOOL), offered);
      assert.deepEqual(classifyAfterToolRepair({ terminalStatus: "completed", toolCalls: [{
        function: { name: REPAIR_FINAL_TOOL, arguments: '{"answer":"Done."}' },
      }] }, { privateFinalOffered: offered, clientToolNames: new Set(tools.map(tool => tool.function.name)) }),
      offered ? { action: "final", contentText: "Done." } : { action: "fail" });
    }
  }
});

test("native final text still requires a successful terminal", () => {
  for (const terminalStatus of ["completed", "failed", "incomplete", "missing"]) {
    const turn = collectResponsesEvents([
      { type: "response.output_text.delta", delta: "Native final answer." },
      ...(terminalStatus === "missing" ? [] : [{ type: `response.${terminalStatus}` }]),
    ]);
    assert.deepEqual(classifyAfterToolRepair(turn), terminalStatus === "completed"
      ? { action: "final", contentText: "Native final answer." }
      : { action: "fail" });
  }
});

test("only response.completed certifies a tool call or private final answer", () => {
  for (const name of ["exec_command", REPAIR_FINAL_TOOL]) {
    const call = {
      type: "response.output_item.done",
      item: {
        type: "function_call", id: "fc_terminal", call_id: "call_terminal", name,
        arguments: JSON.stringify(name === REPAIR_FINAL_TOOL ? { answer: "Done." } : { cmd: "dir" }),
      },
    };
    for (const terminalStatus of ["completed", "failed", "incomplete", "missing"]) {
      const turn = collectResponsesEvents([
        call,
        ...(terminalStatus === "missing" ? [] : [{ type: `response.${terminalStatus}` }]),
      ]);
      assert.equal(turn.terminalStatus, terminalStatus);
      assert.equal(turn.finishReason, terminalStatus === "completed" ? "tool_calls" : null);
      assert.deepEqual(classifyAfterToolRepair(turn), terminalStatus === "completed"
        ? name === REPAIR_FINAL_TOOL ? { action: "final", contentText: "Done." } : { action: "tools" }
        : { action: "fail" });
      assert.equal(shouldPreferRetryTurn(turn), terminalStatus === "completed");
    }
  }
});

test("a failed or missing terminal cannot become a progress-only retry", () => {
  for (const terminalStatus of [undefined, "failed", "incomplete", "missing"]) {
    const turn = { terminalStatus, contentText: "Continuing.", usage: { completion_tokens: 1660 } };
    assert.equal(isProgressOnlyStop(turn), false);
    assert.equal(isProgressOnlyStop(turn, { afterToolResult: true }), false);
  }
});

test("an upstream failure cannot be revived by later completed or tool events", () => {
  for (const failure of [
    { type: "response.failed" },
    { type: "response.incomplete" },
    { type: "error" },
    { type: "response.completed", response: { status: "failed" } },
    { type: "response.completed", response: { status: "incomplete" } },
  ]) {
    const turn = collectResponsesEvents([
      failure,
      { type: "response.output_item.done", item: { type: "function_call", id: "late", name: "exec_command", arguments: "{}" } },
      { type: "response.completed" },
    ]);
    assert.equal(turn.finishReason, null);
    assert.equal(turn.toolCalls.length, 0);
    assert.deepEqual(classifyAfterToolRepair(turn), { action: "fail" });
  }
});

test("selectedRetryUsage reports selected context and separate aggregate billing", () => {
  const usage = selectedRetryUsage(
    { prompt_tokens: 150_000, completion_tokens: 180, total_tokens: 150_180 },
    { prompt_tokens: 151_000, completion_tokens: 90, total_tokens: 151_090 },
  );
  assert.equal(usage.prompt_tokens, 151_000);
  assert.equal(usage.completion_tokens, 90);
  assert.equal(usage.total_tokens, 151_090);
  assert.equal(usage.billed_prompt_tokens, 301_000);
  assert.equal(usage.billed_completion_tokens, 270);
  assert.equal(usage.retries, 1);
  assert.equal(usage.progress_only_retried, true);
});

test("collectResponsesEvents keeps known actual service_tier distinct from missing and unknown", () => {
  const priority = collectResponsesEvents([
    { type: "response.output_text.delta", delta: "ok" },
    {
      type: "response.completed",
      response: { service_tier: "priority", usage: { input_tokens: 3, output_tokens: 1 } },
    },
  ]);
  assert.equal(priority.serviceTier, "priority");
  assert.equal(priority.serviceTierUnknown, false);
  assert.deepEqual(chatServiceTierFields(priority), { service_tier: "priority", provider_specific_fields: { grok_service_tier: "priority" } });

  const standard = collectResponsesEvents([
    {
      type: "response.completed",
      response: { service_tier: "default", usage: { input_tokens: 3, output_tokens: 1 } },
    },
  ]);
  assert.equal(standard.serviceTier, "default");
  assert.deepEqual(chatServiceTierFields(standard), { service_tier: "default", provider_specific_fields: { grok_service_tier: "default" } });

  const missing = collectResponsesEvents([
    { type: "response.completed", response: { usage: { input_tokens: 3, output_tokens: 1 } } },
  ]);
  assert.equal(missing.serviceTier, undefined);
  assert.equal(missing.serviceTierUnknown, false);
  assert.deepEqual(chatServiceTierFields(missing), {});

  const unknown = collectResponsesEvents([
    {
      type: "response.completed",
      response: { service_tier: "flex", usage: { input_tokens: 3, output_tokens: 1 } },
    },
  ]);
  assert.equal(unknown.serviceTier, undefined);
  assert.equal(unknown.serviceTierUnknown, true);
  assert.deepEqual(chatServiceTierFields(unknown), { provider_specific_fields: { grok_service_tier: "unknown" } });
});

test("selectedRetryUsage keeps selected tokens without labeling billed usage as a tier", () => {
  const usage = selectedRetryUsage(
    { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
    { prompt_tokens: 11, completion_tokens: 3, total_tokens: 14, service_tier: "priority", billed_service_tier: "priority" },
  );
  assert.equal("service_tier" in usage, false);
  assert.equal("billed_service_tier" in usage, false);
});

test("mergeMappedUsage omits actual service_tier from aggregated retry billing", () => {
  const merged = mergeMappedUsage(
    { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12, service_tier: "default" },
    { prompt_tokens: 11, completion_tokens: 3, total_tokens: 14, service_tier: "priority" },
  );
  assert.equal("service_tier" in merged, false);
  assert.equal(merged.retries, 1);
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

test("a completed terminal seals the attempt against late tool, text, and reasoning frames", () => {
  const turn = collectResponsesEvents([
    { type: "response.output_text.delta", delta: "Done." },
    {
      type: "response.completed",
      response: { status: "completed", usage: { input_tokens: 9, output_tokens: 2 } },
    },
    {
      type: "response.output_item.done",
      item: { type: "function_call", id: "fc_late", call_id: "call_late", name: "exec_command", arguments: "{\"cmd\":\"rm -rf /\"}" },
    },
    { type: "response.function_call_arguments.delta", item_id: "fc_late", delta: "{}" },
    { type: "response.output_text.delta", delta: " extra" },
    { type: "response.reasoning_summary_text.delta", delta: "late thought" },
  ]);
  assert.equal(turn.terminalStatus, "completed");
  assert.equal(turn.finishReason, "stop");
  assert.deepEqual(turn.toolCalls, []);
  assert.equal(turn.contentText, "Done.");
  assert.equal(turn.reasoningText, "");
  assert.equal(turn.usage.completion_tokens, 2);
  assert.equal(turn.deltas.some((delta) => delta.tool_calls), false);
});

test("a later terminal cannot change a sealed attempt in either direction", () => {
  for (const late of [
    { type: "response.failed", response: { status: "failed" } },
    { type: "response.incomplete", response: { status: "incomplete", usage: { input_tokens: 9, output_tokens: 5 } } },
    { type: "response.completed", response: { status: "failed", service_tier: "priority" } },
    { type: "error" },
  ]) {
    const turn = collectResponsesEvents([
      {
        type: "response.output_item.done",
        item: { type: "function_call", id: "fc_1", call_id: "call_1", name: "exec_command", arguments: "{}" },
      },
      { type: "response.completed", response: { status: "completed", usage: { input_tokens: 9, output_tokens: 3 } } },
      late,
    ]);
    assert.equal(turn.terminalStatus, "completed", late.type);
    assert.equal(turn.finishReason, "tool_calls", late.type);
    assert.equal(turn.toolCalls.length, 1, late.type);
    assert.equal(turn.usage.completion_tokens, 3, late.type);
    assert.equal(turn.serviceTier, undefined, late.type);
  }
  const failed = collectResponsesEvents([
    { type: "response.failed", response: { status: "failed" } },
    { type: "response.completed", response: { status: "completed" } },
  ]);
  assert.equal(failed.terminalStatus, "failed");
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
