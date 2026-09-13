import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";

import {
  DeepseekToolMessageCompatTransform,
  TranslatedToolMessageCompatTransform,
  TranslatedToolMessageJsonCompatTransform,
  deepseekToolMessageCompatTransform,
  translatedToolMessageCompatTransform,
} from "../src/deepseek-tool-message-compat.mjs";
import {
  NamespaceToolCallTransform,
  bridgeCustomTools,
  flattenNamespaceTools,
} from "../src/namespace-relay.mjs";

function block(event, newline = "\n") {
  return `event: ${event.type}${newline}data: ${JSON.stringify(event)}${newline}${newline}`;
}

function rawBlock(type, json, newline = "\n") {
  return `event: ${type}${newline}data: ${json}${newline}${newline}`;
}

function events(text) {
  return text
    .split(/\r?\n\r?\n/)
    .map((frame) => frame.split(/\r?\n/).find((line) => line.startsWith("data:")))
    .filter((line) => line && line !== "data: [DONE]")
    .map((line) => JSON.parse(line.slice(5).trimStart()));
}

async function transformed(input, options = {}, chunkSize = 0) {
  const stream = new TranslatedToolMessageCompatTransform(options);
  return transformedBy(stream, input, chunkSize);
}

async function transformedDirect(input, options = {}, chunkSize = 0) {
  const stream = new DeepseekToolMessageCompatTransform(options);
  return transformedBy(stream, input, chunkSize);
}

async function transformedBy(stream, input, chunkSize = 0) {
  let output = "";
  stream.setEncoding("utf8");
  stream.on("data", (chunk) => { output += chunk; });
  if (chunkSize > 0) {
    const bytes = Buffer.from(input);
    for (let at = 0; at < bytes.length; at += chunkSize) {
      stream.write(bytes.subarray(at, at + chunkSize));
    }
  } else {
    stream.write(input);
  }
  stream.end();
  await once(stream, "end");
  return output;
}

async function transformedBytes(input, options = {}, chunkSize = 0) {
  const stream = new TranslatedToolMessageCompatTransform(options);
  const output = [];
  stream.on("data", (chunk) => { output.push(Buffer.from(chunk)); });
  const bytes = Buffer.isBuffer(input) ? input : Buffer.from(input);
  if (chunkSize > 0) {
    for (let at = 0; at < bytes.length; at += chunkSize) {
      stream.write(bytes.subarray(at, at + chunkSize));
    }
  } else {
    stream.write(bytes);
  }
  stream.end();
  await once(stream, "end");
  return Buffer.concat(output);
}

async function transformedThroughNamespace(
  input,
  namespaces,
  options = {},
  chunkSize = 0,
) {
  const compat = new TranslatedToolMessageCompatTransform(options);
  const namespace = new NamespaceToolCallTransform(
    namespaces,
    "text/event-stream",
  );
  let output = "";
  namespace.setEncoding("utf8");
  namespace.on("data", (chunk) => { output += chunk; });
  compat.pipe(namespace);
  const bytes = Buffer.isBuffer(input) ? input : Buffer.from(input);
  if (chunkSize > 0) {
    for (let at = 0; at < bytes.length; at += chunkSize) {
      compat.write(bytes.subarray(at, at + chunkSize));
    }
  } else {
    compat.write(bytes);
  }
  compat.end();
  await once(namespace, "end");
  return output;
}

async function transformedBytesThroughNamespace(
  input,
  namespaces,
  {
    contentType = "text/event-stream",
    json = false,
    compatOptions = {},
  } = {},
  chunkSize = 0,
) {
  const compat = json
    ? new TranslatedToolMessageJsonCompatTransform(compatOptions)
    : new TranslatedToolMessageCompatTransform(compatOptions);
  const namespace = new NamespaceToolCallTransform(namespaces, contentType);
  const output = [];
  namespace.on("data", (chunk) => { output.push(Buffer.from(chunk)); });
  compat.pipe(namespace);
  const bytes = Buffer.isBuffer(input) ? input : Buffer.from(input);
  if (chunkSize > 0) {
    for (let at = 0; at < bytes.length; at += chunkSize) {
      compat.write(bytes.subarray(at, at + chunkSize));
    }
  } else {
    compat.write(bytes);
  }
  compat.end();
  await once(namespace, "end");
  return Buffer.concat(output);
}

async function transformedJson(input, options = {}, chunkSize = 0) {
  const stream = new TranslatedToolMessageJsonCompatTransform(options);
  let output = "";
  stream.setEncoding("utf8");
  stream.on("data", (chunk) => { output += chunk; });
  if (chunkSize > 0) {
    const bytes = Buffer.from(input);
    for (let at = 0; at < bytes.length; at += chunkSize) {
      stream.write(bytes.subarray(at, at + chunkSize));
    }
  } else {
    stream.write(input);
  }
  stream.end();
  await once(stream, "end");
  return output;
}

const blankMessage = {
  id: "msg_blank",
  type: "message",
  status: "completed",
  role: "assistant",
  content: [{ type: "output_text", text: "", annotations: [] }],
};

const functionCall = {
  id: "call_list",
  type: "function_call",
  call_id: "call_list",
  name: "exec_command",
  arguments: "{}",
  status: "completed",
};

function responseCreated(
  id = "resp_1",
  { newline = "\n", sequenceNumber, response = {} } = {},
) {
  const event = {
    type: "response.created",
    response: {
      id,
      object: "response",
      status: "in_progress",
      error: null,
      output: [],
      ...response,
    },
  };
  if (sequenceNumber !== undefined) event.sequence_number = sequenceNumber;
  return block(event, newline);
}

function responseCompleted(
  output,
  {
    id = "resp_1",
    newline = "\n",
    sequenceNumber,
    response = {},
  } = {},
) {
  const event = {
    type: "response.completed",
    response: {
      id,
      object: "response",
      status: "completed",
      error: null,
      output,
      ...response,
    },
  };
  if (sequenceNumber !== undefined) event.sequence_number = sequenceNumber;
  return block(event, newline);
}

function jsonResponse(output, overrides = {}) {
  return {
    id: "resp_json",
    object: "response",
    status: "completed",
    error: null,
    output,
    ...overrides,
  };
}

function phantomToolStream(
  newline = "\n",
  { terminalBlank = blankMessage, terminalReasoning = "" } = {},
) {
  return [
    responseCreated("resp_1", { newline, sequenceNumber: 0 }),
    block({
      type: "response.output_item.added",
      output_index: 0,
      sequence_number: 1,
      item: { ...blankMessage, status: "in_progress", content: [] },
    }, newline),
    block({
      type: "response.content_part.added",
      item_id: blankMessage.id,
      output_index: 0,
      content_index: 0,
      sequence_number: 2,
      part: { type: "output_text", text: "", annotations: [] },
    }, newline),
    block({
      type: "response.output_item.added",
      output_index: 1,
      sequence_number: 3,
      item: { ...functionCall, status: "in_progress", arguments: "" },
    }, newline),
    block({
      type: "response.function_call_arguments.delta",
      item_id: functionCall.id,
      output_index: 1,
      sequence_number: 4,
      delta: "{}",
    }, newline),
    block({
      type: "response.output_item.done",
      output_index: 1,
      sequence_number: 5,
      item: functionCall,
    }, newline),
    block({
      type: "response.output_text.done",
      item_id: blankMessage.id,
      output_index: 0,
      content_index: 0,
      sequence_number: 6,
      text: "",
    }, newline),
    block({
      type: "response.content_part.done",
      item_id: blankMessage.id,
      output_index: 0,
      content_index: 0,
      sequence_number: 7,
      part: { type: "reasoning_text", reasoning: terminalReasoning },
    }, newline),
    block({
      type: "response.output_item.done",
      output_index: 0,
      sequence_number: 8,
      item: blankMessage,
    }, newline),
    responseCompleted([terminalBlank, functionCall], {
      id: "resp_1",
      newline,
      sequenceNumber: 9,
    }),
    `data: [DONE]${newline}${newline}`,
  ].join("");
}

// LiteLLM 1.96.0 emits this non-monotonic sequence on its
// Chat-Completions -> Responses bridge. In particular, the terminal empty
// message item is hard-coded to sequence_number=1 after higher-numbered tool
// events, while its output_text/content_part closes are unnumbered.
function pinnedLiteLlmPhantomEvents() {
  const model = "opencode-go-deepseek-v4-flash";
  const inProgressResponse = {
    id: "resp_pinned_litellm",
    model,
    object: "response",
    status: "in_progress",
    error: null,
    output: [],
  };
  const wireEvents = [
    {
      type: "response.created",
      response: { ...inProgressResponse },
    },
    {
      type: "response.in_progress",
      response: { ...inProgressResponse },
    },
    {
      type: "response.output_item.added",
      output_index: 0,
      item: { ...blankMessage, status: "in_progress", content: [] },
    },
    {
      type: "response.content_part.added",
      item_id: blankMessage.id,
      output_index: 0,
      content_index: 0,
      part: { type: "output_text", text: "", annotations: [] },
    },
    {
      type: "response.output_item.added",
      output_index: 1,
      item: { ...functionCall, status: "in_progress", arguments: "" },
    },
    {
      type: "response.function_call_arguments.delta",
      item_id: functionCall.id,
      output_index: 1,
      delta: "{}",
    },
    {
      type: "response.function_call_arguments.done",
      item_id: functionCall.id,
      output_index: 1,
      arguments: "{}",
    },
    {
      type: "response.output_item.done",
      output_index: 1,
      sequence_number: 9,
      item: { ...functionCall },
    },
    {
      type: "response.output_text.done",
      item_id: blankMessage.id,
      output_index: 0,
      content_index: 0,
      text: "",
    },
    {
      type: "response.content_part.done",
      item_id: blankMessage.id,
      output_index: 0,
      content_index: 0,
      part: { type: "output_text", text: "", annotations: [] },
    },
    {
      type: "response.output_item.done",
      output_index: 0,
      sequence_number: 1,
      item: { ...blankMessage },
    },
    {
      type: "response.completed",
      response: {
        id: "resp_pinned_litellm_terminal",
        model,
        object: "response",
        status: "completed",
        error: null,
        output: [
          { ...blankMessage, id: "chatcmpl-pinned-terminal" },
          { ...functionCall },
        ],
      },
    },
  ];
  return wireEvents.map((event) => ({ ...event, model }));
}

function pinnedLiteLlmPhantomToolStream(mutate) {
  const wireEvents = pinnedLiteLlmPhantomEvents();
  if (mutate) mutate(wireEvents);
  return `${wireEvents.map((event) => block(event)).join("")}data: [DONE]\n\n`;
}

// LiteLLM's Anthropic -> Responses bridge omits the empty message's opening
// item/content events. Its first visible output item is therefore the tool at
// index one; the bridge reveals the index-zero phantom only while closing it.
function pinnedAnthropicTerminalOnlyEvents() {
  const wireEvents = pinnedLiteLlmPhantomEvents().filter((event) => !(
    (event.type === "response.output_item.added" && event.output_index === 0) ||
    (event.type === "response.content_part.added" && event.output_index === 0)
  ));
  const terminal = wireEvents.find((event) => event.type === "response.completed");
  terminal.response.output[0].id = blankMessage.id;
  return wireEvents;
}

function pinnedAnthropicTerminalOnlyStream(mutate) {
  const wireEvents = pinnedAnthropicTerminalOnlyEvents();
  if (mutate) mutate(wireEvents);
  return `${wireEvents.map((event) => block(event)).join("")}data: [DONE]\n\n`;
}

function pinnedAnthropicTerminalOnlyMultiToolStream() {
  const secondTool = {
    ...functionCall,
    id: "call_second",
    call_id: "call_second",
    name: "second_tool",
  };
  const source = pinnedAnthropicTerminalOnlyStream((wireEvents) => {
    const model = wireEvents[0].model;
    const firstCandidateClose = wireEvents.findIndex(
      (event) => event.type === "response.output_text.done",
    );
    wireEvents.splice(firstCandidateClose, 0,
      {
        type: "response.output_item.added",
        output_index: 2,
        item: { ...secondTool, status: "in_progress", arguments: "" },
        model,
      },
      {
        type: "response.function_call_arguments.delta",
        item_id: secondTool.id,
        output_index: 2,
        delta: "{}",
        model,
      },
      {
        type: "response.function_call_arguments.done",
        item_id: secondTool.id,
        output_index: 2,
        arguments: "{}",
        model,
      },
      {
        type: "response.output_item.done",
        output_index: 2,
        sequence_number: 10,
        item: secondTool,
        model,
      },
    );
    const terminal = wireEvents.find((event) => event.type === "response.completed");
    terminal.response.output.push(secondTool);
  });
  return { source, secondTool };
}

function historicalDirectDeepseekEvents() {
  const blank = { ...blankMessage, id: "msg_direct_historical" };
  const tool = {
    ...functionCall,
    id: "call_direct_historical",
    call_id: "call_direct_historical",
  };
  return [
    {
      type: "response.output_item.added",
      output_index: 0,
      sequence_number: 1,
      item: { ...blank, status: "in_progress", content: [] },
    },
    {
      type: "response.content_part.added",
      item_id: blank.id,
      output_index: 0,
      content_index: 0,
      sequence_number: 2,
      part: { type: "output_text", text: "", annotations: [] },
    },
    {
      type: "response.output_item.added",
      output_index: 1,
      sequence_number: 3,
      item: { ...tool, status: "in_progress", arguments: "" },
    },
    {
      type: "response.function_call_arguments.delta",
      item_id: tool.id,
      output_index: 1,
      sequence_number: 4,
      delta: "{}",
    },
    {
      type: "response.output_item.done",
      output_index: 1,
      sequence_number: 5,
      item: tool,
    },
    {
      type: "response.output_text.done",
      item_id: blank.id,
      output_index: 0,
      content_index: 0,
      sequence_number: 6,
      text: "",
    },
    {
      type: "response.content_part.done",
      item_id: blank.id,
      output_index: 0,
      content_index: 0,
      sequence_number: 7,
      part: { type: "reasoning_text", reasoning: "private reasoning" },
    },
    {
      type: "response.output_item.done",
      output_index: 0,
      sequence_number: 8,
      item: blank,
    },
    {
      type: "response.completed",
      sequence_number: 9,
      response: {
        id: "resp_direct_historical",
        status: "completed",
        output: [blank, tool],
      },
    },
  ];
}

function historicalDirectDeepseekStream(mutate) {
  const wireEvents = historicalDirectDeepseekEvents();
  if (mutate) mutate(wireEvents);
  return `${wireEvents.map((event) => block(event)).join("")}data: [DONE]\n\n`;
}

const currentDirectReasoning =
  "The user wants me to call codex_router_probe exactly once with value \"ok\", " +
  "and not answer normally. Let me do that.";

function currentDirectDeepseekEvents() {
  const model = "deepseek-v4-flash";
  const responseId = "resp_direct_live_open";
  const candidate = { ...blankMessage, id: "msg_direct_live" };
  const tool = {
    ...functionCall,
    id: "call_direct_live",
    call_id: "call_direct_live",
    name: "codex_router_probe",
    arguments: "{\"value\":\"ok\"}",
  };
  const inProgress = {
    id: responseId,
    model,
    object: "response",
    status: "in_progress",
    error: null,
    output: [],
  };
  const events = [
    { type: "response.created", response: { ...inProgress }, model },
    { type: "response.in_progress", response: { ...inProgress }, model },
    {
      type: "response.output_item.added",
      output_index: 0,
      item: { ...candidate, status: "in_progress", content: [] },
      model,
    },
    {
      type: "response.content_part.added",
      item_id: candidate.id,
      output_index: 0,
      content_index: 0,
      part: { type: "output_text", text: "", annotations: [] },
      model,
    },
  ];
  for (const delta of [
    "The user wants me to call codex_router_probe exactly once ",
    "with value \"ok\", and not answer normally. ",
    "Let me do that.",
  ]) {
    events.push({
      type: "response.reasoning_summary_text.delta",
      item_id: candidate.id,
      output_index: 0,
      delta,
      model,
    });
  }
  events.push(
    {
      type: "response.output_item.added",
      output_index: 1,
      item: { ...tool, status: "in_progress", arguments: "" },
      model,
    },
    {
      type: "response.function_call_arguments.delta",
      item_id: tool.id,
      output_index: 1,
      delta: "{\"value\":",
      model,
    },
    {
      type: "response.function_call_arguments.delta",
      item_id: tool.id,
      output_index: 1,
      delta: "\"ok\"}",
      model,
    },
    {
      type: "response.function_call_arguments.done",
      item_id: tool.id,
      output_index: 1,
      arguments: tool.arguments,
      model,
    },
    {
      type: "response.output_item.done",
      output_index: 1,
      sequence_number: 16,
      item: tool,
      model,
    },
    {
      type: "response.output_text.done",
      item_id: candidate.id,
      output_index: 0,
      content_index: 0,
      text: "",
      model,
    },
    {
      type: "response.content_part.done",
      item_id: candidate.id,
      output_index: 0,
      content_index: 0,
      part: { type: "reasoning_text", reasoning: currentDirectReasoning },
      model,
    },
    {
      type: "response.output_item.done",
      output_index: 0,
      sequence_number: 1,
      item: candidate,
      model,
    },
    {
      type: "response.completed",
      response: {
        id: "resp_direct_live_closed",
        model,
        object: "response",
        status: "completed",
        error: null,
        output: [
          {
            id: "rs_-8853496868378332836",
            type: "reasoning",
            status: "completed",
            role: "assistant",
            content: [{
              type: "output_text",
              text: currentDirectReasoning,
              annotations: [],
            }],
          },
          {
            id: "04847f40-ed33-4239-80d2-d392fe38fcc3",
            type: "message",
            status: "completed",
            role: "assistant",
            content: [{ type: "output_text", annotations: [] }],
          },
          tool,
        ],
        usage: { input_tokens: 17, output_tokens: 8, total_tokens: 25 },
      },
      model,
    },
  );
  return events;
}

function currentDirectDeepseekStream(mutate) {
  const wireEvents = currentDirectDeepseekEvents();
  if (mutate) mutate(wireEvents);
  return `${wireEvents.map((event) => block(event)).join("")}data: [DONE]\n\n`;
}

test("restores the merged direct-DeepSeek historical no-prelude regression", async () => {
  const source = historicalDirectDeepseekStream();
  const output = await transformedDirect(source, {}, 3);
  const seen = events(output);
  const tool = historicalDirectDeepseekEvents()[2].item;

  assert.equal(output.includes("msg_direct_historical"), false);
  assert.equal(output.includes("private reasoning"), false);
  assert.deepEqual(
    seen.filter((event) => eventItem(event) === tool.id)
      .map((event) => [event.type, event.output_index, event.sequence_number]),
    [
      ["response.output_item.added", 0, 3],
      ["response.function_call_arguments.delta", 0, 4],
      ["response.output_item.done", 0, 5],
    ],
  );
  assert.deepEqual(
    seen.find((event) => event.type === "response.completed").response.output,
    [{ ...tool, status: "completed", arguments: "{}" }],
  );
});

test("normalizes current direct-DeepSeek reasoning and removes only the blank slot", async () => {
  const sourceEvents = currentDirectDeepseekEvents();
  const source = currentDirectDeepseekStream();
  const output = await transformedDirect(source, {}, 2);
  const seen = events(output);
  const terminal = sourceEvents.at(-1).response;
  const incomingReasoning = terminal.output[0];
  const incomingBlank = terminal.output[1];
  const tool = terminal.output[2];
  const normalizedReasoning = {
    id: incomingReasoning.id,
    type: "reasoning",
    status: "completed",
    summary: [{ type: "summary_text", text: currentDirectReasoning }],
  };

  assert.equal(output.includes("msg_direct_live"), false);
  assert.equal(output.includes(incomingBlank.id), false);
  const lifecycle = seen.filter((event) => (
    eventItem(event) === normalizedReasoning.id || eventItem(event) === tool.id
  ));
  assert.deepEqual(
    lifecycle.map((event) => [event.type, eventItem(event), event.output_index]),
    [
      ["response.output_item.added", normalizedReasoning.id, 0],
      ["response.reasoning_summary_part.added", normalizedReasoning.id, 0],
      ["response.reasoning_summary_text.delta", normalizedReasoning.id, 0],
      ["response.reasoning_summary_text.delta", normalizedReasoning.id, 0],
      ["response.reasoning_summary_text.delta", normalizedReasoning.id, 0],
      ["response.reasoning_summary_text.done", normalizedReasoning.id, 0],
      ["response.reasoning_summary_part.done", normalizedReasoning.id, 0],
      ["response.output_item.done", normalizedReasoning.id, 0],
      ["response.output_item.added", tool.id, 1],
      ["response.function_call_arguments.delta", tool.id, 1],
      ["response.function_call_arguments.delta", tool.id, 1],
      ["response.function_call_arguments.done", tool.id, 1],
      ["response.output_item.done", tool.id, 1],
    ],
  );
  assert.equal(
    lifecycle
      .filter((event) => event.type === "response.reasoning_summary_text.delta")
      .map((event) => event.delta)
      .join(""),
    currentDirectReasoning,
  );
  assert.deepEqual(
    seen.filter((event) => event.sequence_number !== undefined)
      .map((event) => event.sequence_number),
    [16],
  );
  const completed = seen.find((event) => event.type === "response.completed").response;
  assert.deepEqual(completed.output, [normalizedReasoning, tool]);
  assert.deepEqual(completed.usage, terminal.usage);
});

test("current direct-DeepSeek grammar is provider-scoped", async () => {
  const source = currentDirectDeepseekStream();
  const direct = translatedToolMessageCompatTransform(
    { id: "deepseek", protocol: "openai" },
    "text/event-stream",
  );
  const translated = translatedToolMessageCompatTransform(
    { id: "opencode-go", protocol: "openai" },
    "text/event-stream",
  );
  const repaired = await transformedBy(direct, source, 1);
  assert.notEqual(repaired, source);
  assert.equal(repaired.includes("msg_direct_live"), false);
  assert.equal(await transformedBy(translated, source, 1), source);
});

test("current direct-DeepSeek repair fails open on adjacent reasoning and identity shapes", async (t) => {
  const mutations = new Map([
    ["mismatched reasoning close", (wireEvents) => {
      wireEvents.find((event) => event.type === "response.content_part.done")
        .part.reasoning += " changed";
    }],
    ["mismatched terminal reasoning", (wireEvents) => {
      wireEvents.at(-1).response.output[0].content[0].text = "different";
    }],
    ["missing terminal reasoning", (wireEvents) => {
      wireEvents.at(-1).response.output.shift();
    }],
    ["extra terminal reasoning", (wireEvents) => {
      wireEvents.at(-1).response.output.unshift({
        ...wireEvents.at(-1).response.output[0],
        id: "rs_extra",
      });
    }],
    ["reasoning id collision", (wireEvents) => {
      wireEvents.at(-1).response.output[0].id = "call_direct_live";
    }],
    ["terminal blank id collision", (wireEvents) => {
      wireEvents.at(-1).response.output[1].id = "msg_direct_live";
    }],
    ["wrong lifecycle ordering", (wireEvents) => {
      const done = wireEvents.findIndex(
        (event) => event.type === "response.function_call_arguments.done",
      );
      [wireEvents[done], wireEvents[done + 1]] = [wireEvents[done + 1], wireEvents[done]];
    }],
    ["visible streamed text", (wireEvents) => {
      wireEvents.find((event) => event.type === "response.output_text.done").text = "visible";
    }],
    ["visible terminal blank", (wireEvents) => {
      wireEvents.at(-1).response.output[1].content[0].text = "visible";
    }],
    ["changed model provenance", (wireEvents) => {
      wireEvents.find((event) => event.type === "response.output_text.done").model = "other";
    }],
    ["changed response model provenance", (wireEvents) => {
      wireEvents.at(-1).response.model = "other";
    }],
    ["unexpected lifecycle field", (wireEvents) => {
      wireEvents.find((event) => event.type === "response.output_text.done")
        .unexpected = true;
    }],
    ["missing in-progress envelope", (wireEvents) => {
      wireEvents.splice(1, 1);
    }],
    ["wrong terminal blank sequence", (wireEvents) => {
      wireEvents.find((event) => (
        event.type === "response.output_item.done" && event.output_index === 0
      )).sequence_number = 2;
    }],
    ["wrong tool terminal sequence", (wireEvents) => {
      wireEvents.find((event) => (
        event.type === "response.output_item.done" && event.output_index === 1
      )).sequence_number = 15;
    }],
    ["mismatched tool arguments", (wireEvents) => {
      wireEvents.find((event) => event.type === "response.function_call_arguments.done")
        .arguments = "{}";
    }],
    ["mismatched terminal tool identity", (wireEvents) => {
      wireEvents.at(-1).response.output[2] = {
        ...wireEvents.at(-1).response.output[2],
        call_id: "other_call",
      };
    }],
    ["unchanged terminal response id", (wireEvents) => {
      wireEvents.at(-1).response.id = "resp_direct_live_open";
    }],
    ["extra event after terminal envelope", (wireEvents) => {
      wireEvents.push({
        type: "response.output_item.added",
        output_index: 2,
        item: {
          id: "msg_after_terminal",
          type: "message",
          status: "in_progress",
          role: "assistant",
          content: [],
        },
        model: "deepseek-v4-flash",
      });
    }],
  ]);
  for (const [name, mutate] of mutations) {
    await t.test(name, async () => {
      const input = currentDirectDeepseekStream(mutate);
      assert.equal(await transformedDirect(input, {}, 1), input);
    });
  }
});

test("historical direct-DeepSeek grammar remains exact and bounded", async () => {
  for (const mutate of [
    (wireEvents) => {
      wireEvents.find((event) => event.type === "response.content_part.done")
        .part.reasoning = "";
    },
    (wireEvents) => {
      wireEvents.find((event) => event.type === "response.output_text.done").text = "visible";
    },
    (wireEvents) => {
      wireEvents.at(-1).response.output[0].id = "changed_blank";
    },
    (wireEvents) => {
      wireEvents.find((event) => event.type === "response.output_item.done")
        .sequence_number = 6;
    },
  ]) {
    const input = historicalDirectDeepseekStream(mutate);
    assert.equal(await transformedDirect(input, {}, 1), input);
  }
  const source = historicalDirectDeepseekStream();
  assert.equal(
    await transformedDirect(source, {
      maxCandidateBytes: 64,
      maxCandidateMs: 60_000,
    }),
    source,
  );
});

test("direct DeepSeek holds one terminal sentinel until EOF and rejects every trailer", async () => {
  const fixtures = [
    [historicalDirectDeepseekStream, "msg_direct_historical"],
    [currentDirectDeepseekStream, "msg_direct_live"],
  ];
  for (const [fixture, blankId] of fixtures) {
    const source = fixture();
    const stream = new DeepseekToolMessageCompatTransform();
    let heldOutput = "";
    stream.setEncoding("utf8");
    stream.on("data", (chunk) => { heldOutput += chunk; });
    stream.write(source);
    assert.equal(heldOutput.includes("[DONE]"), false);
    stream.end();
    await once(stream, "end");
    assert.equal(heldOutput.includes(blankId), false);
    assert.match(heldOutput, /data: \[DONE\]\n\n$/);

    const withoutSentinel = source.replace(/data: \[DONE\]\n\n$/, "");
    const eofOutput = await transformedDirect(withoutSentinel, {}, 1);
    assert.equal(eofOutput.includes(blankId), false);

    const trailingEvent = block({
      type: "response.output_item.added",
      output_index: 9,
      item: {
        id: "msg_after_done",
        type: "message",
        status: "in_progress",
        role: "assistant",
        content: [],
      },
    });
    for (const suffix of [
      "data: [DONE]\n\n",
      trailingEvent,
      "opaque trailing byte",
    ]) {
      const input = source + suffix;
      assert.equal(await transformedDirect(input, {}, 1), input);
    }
  }
});

test("direct DeepSeek watchdog measures inactivity rather than total capture time", async () => {
  const timeout = 1_000;
  const gap = 150;
  const frames = historicalDirectDeepseekEvents().map((event) => block(event));
  const source = `${frames.join("")}data: [DONE]\n\n`;
  const stream = new DeepseekToolMessageCompatTransform({ maxCandidateMs: timeout });
  let output = "";
  stream.setEncoding("utf8");
  stream.on("data", (chunk) => { output += chunk; });
  const started = Date.now();
  for (const frame of frames) {
    stream.write(frame);
    await new Promise((resolve) => setTimeout(resolve, gap));
  }
  stream.write("data: [DONE]\n\n");
  await new Promise((resolve) => setTimeout(resolve, gap));
  stream.end();
  await once(stream, "end");

  assert.ok(Date.now() - started > timeout);
  assert.equal(output.includes("msg_direct_historical"), false);
  assert.match(output, /data: \[DONE\]\n\n$/);
  assert.notEqual(output, source);
});

test("direct DeepSeek absolute deadline bounds an otherwise active capture", async () => {
  const absoluteTimeout = 1_000;
  const frames = currentDirectDeepseekEvents().slice(0, 5).map((event) => block(event));
  const stream = new DeepseekToolMessageCompatTransform({
    maxCandidateMs: 5_000,
    maxCaptureMs: absoluteTimeout,
  });
  let input = frames.join("");
  let output = "";
  stream.setEncoding("utf8");
  stream.on("data", (chunk) => { output += chunk; });
  stream.write(input);

  let interval;
  const released = new Promise((resolve, reject) => {
    const guard = setTimeout(
      () => reject(new Error("absolute capture deadline did not release the stream")),
      absoluteTimeout * 3,
    );
    stream.on("data", () => {
      if (!output.includes("msg_direct_live")) return;
      clearTimeout(guard);
      resolve();
    });
  });
  const deltaTemplate = currentDirectDeepseekEvents()[4];
  interval = setInterval(() => {
    const next = block({ ...deltaTemplate, delta: "still active" });
    input += next;
    stream.write(next);
  }, 100);

  try {
    await released;
  } finally {
    clearInterval(interval);
  }
  const tail = "opaque bytes after absolute release";
  input += tail;
  stream.end(tail);
  await once(stream, "end");
  assert.equal(output, input);
});

test("direct DeepSeek watchdog fails open after one inactive gap", async () => {
  const frames = historicalDirectDeepseekEvents().map((event) => block(event));
  const source = `${frames.join("")}data: [DONE]\n\n`;
  const stream = new DeepseekToolMessageCompatTransform({ maxCandidateMs: 20 });
  let output = "";
  stream.setEncoding("utf8");
  stream.on("data", (chunk) => { output += chunk; });
  stream.write(frames[0]);
  await new Promise((resolve) => setTimeout(resolve, 60));
  stream.end(`${frames.slice(1).join("")}data: [DONE]\n\n`);
  await once(stream, "end");
  assert.equal(output, source);
});

test("direct DeepSeek watchdog releases an incomplete frame byte-for-byte", async () => {
  const start = block(historicalDirectDeepseekEvents()[0]);
  const partial = "event: response.content_part.added\ndata: {\"type\":";
  const stream = new DeepseekToolMessageCompatTransform({ maxCandidateMs: 20 });
  let output = "";
  stream.setEncoding("utf8");
  stream.on("data", (chunk) => { output += chunk; });
  stream.write(start + partial);
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(output, start + partial);
  stream.end();
  await once(stream, "end");
  assert.equal(output, start + partial);
});

test("destroying a pending direct DeepSeek capture cancels both timers", async () => {
  const start = block(historicalDirectDeepseekEvents()[0]);
  const stream = new DeepseekToolMessageCompatTransform({
    maxCandidateMs: 20,
    maxCaptureMs: 25,
  });
  let output = "";
  let latePushes = 0;
  const push = stream.push.bind(stream);
  stream.push = (...args) => {
    latePushes += 1;
    return push(...args);
  };
  stream.on("data", (chunk) => { output += chunk.toString("utf8"); });
  stream.write(start);
  stream.destroy();
  await once(stream, "close");
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(output, "");
  assert.equal(latePushes, 0);
});

test("SSE field parsing removes only one optional ASCII space", async () => {
  const source = historicalDirectDeepseekStream();
  for (const prefix of ["data:  {", "data: \t  {"]) {
    const spaced = source.replace("data: {", prefix);
    const output = await transformedDirect(spaced, {}, 1);
    assert.equal(output.includes("msg_direct_historical"), false);
  }

  for (const invalid of [
    source.replace("data: {", "data: \ufeff{"),
    source.replace("data: {", "data: \u00a0{"),
    source.replace(
      "event: response.output_item.added",
      "event: \ufeffresponse.output_item.added",
    ),
    source.replace(
      "event: response.output_item.added",
      "event:  response.output_item.added",
    ),
  ]) {
    assert.equal(await transformedDirect(invalid, {}, 1), invalid);
  }
});

test("repairs LiteLLM 1.96.0's pinned terminal sequence reset", async () => {
  const source = pinnedLiteLlmPhantomToolStream();
  const output = await transformed(source, {}, 5);
  const seen = events(output);

  assert.equal(output.includes(blankMessage.id), false);
  assert.deepEqual(
    seen.filter((event) => eventItem(event) === functionCall.id)
      .map((event) => [event.type, event.output_index, event.sequence_number]),
    [
      ["response.output_item.added", 0, undefined],
      ["response.function_call_arguments.delta", 0, undefined],
      ["response.function_call_arguments.done", 0, undefined],
      ["response.output_item.done", 0, 9],
    ],
  );
  assert.deepEqual(
    seen.find((event) => event.type === "response.completed").response.output,
    [functionCall],
  );
});

test("repairs the Anthropic bridge's terminal-only phantom slot", async () => {
  const source = pinnedAnthropicTerminalOnlyStream();
  assert.equal(await transformed(source), source);

  const output = await transformed(source, { allowTerminalOnlyCandidate: true }, 3);
  const seen = events(output);
  assert.equal(output.includes(blankMessage.id), false);
  assert.deepEqual(
    seen.filter((event) => eventItem(event) === functionCall.id)
      .map((event) => [event.type, event.output_index]),
    [
      ["response.output_item.added", 0],
      ["response.function_call_arguments.delta", 0],
      ["response.function_call_arguments.done", 0],
      ["response.output_item.done", 0],
    ],
  );
  assert.deepEqual(
    seen.find((event) => event.type === "response.completed").response.output,
    [functionCall],
  );
});

test("only the Anthropic factory path admits a terminal-only phantom slot", async () => {
  const source = pinnedAnthropicTerminalOnlyStream();
  const anthropic = translatedToolMessageCompatTransform(
    { id: "opencode-go-messages", protocol: "anthropic" },
    "text/event-stream; charset=utf-8",
  );
  const openai = translatedToolMessageCompatTransform(
    { id: "opencode-go", protocol: "openai" },
    "text/event-stream; charset=utf-8",
  );
  const repaired = await transformedBy(anthropic, source, 2);
  assert.equal(repaired.includes(blankMessage.id), false);
  assert.equal(await transformedBy(openai, source, 2), source);
});

test("the terminal-only slot compacts multiple corroborated tool calls", async () => {
  const { source, secondTool } = pinnedAnthropicTerminalOnlyMultiToolStream();
  const output = await transformed(source, { allowTerminalOnlyCandidate: true }, 5);
  const seen = events(output);
  assert.deepEqual(
    seen.filter((event) => event.type === "response.output_item.done")
      .map((event) => [event.item.id, event.output_index]),
    [[functionCall.id, 0], [secondTool.id, 1]],
  );
  assert.deepEqual(
    seen.find((event) => event.type === "response.completed").response.output,
    [functionCall, secondTool],
  );
});

test("translated repairs commit only at EOF and every trailer fails open", async () => {
  const multiTool = pinnedAnthropicTerminalOnlyMultiToolStream();
  const fixtures = [
    ["classic", phantomToolStream(), {}, blankMessage.id],
    ["current OpenAI", pinnedLiteLlmPhantomToolStream(), {}, blankMessage.id],
    [
      "current terminal-only Anthropic",
      pinnedAnthropicTerminalOnlyStream(),
      { allowTerminalOnlyCandidate: true },
      blankMessage.id,
    ],
    [
      "terminal-only Anthropic with multiple tools",
      multiTool.source,
      { allowTerminalOnlyCandidate: true },
      blankMessage.id,
    ],
  ];
  const trailingEvent = block({
    type: "response.output_item.added",
    output_index: 9,
    item: {
      id: "msg_after_completed",
      type: "message",
      status: "in_progress",
      role: "assistant",
      content: [],
    },
  });
  const malformed = "event: response.created\ndata: {not-json}\n\n";

  for (const [name, source, options, blankId] of fixtures) {
    const stream = new TranslatedToolMessageCompatTransform(options);
    let held = "";
    stream.setEncoding("utf8");
    stream.on("data", (chunk) => { held += chunk; });
    stream.write(source);
    assert.equal(held.includes("response.completed"), false, `${name}: held terminal`);
    stream.end();
    await once(stream, "end");
    assert.equal(held.includes(blankId), false, `${name}: repaired blank`);
    assert.match(held, /data: \[DONE\]\n\n$/, `${name}: preserved sentinel`);

    const withoutSentinel = source.replace(/data: \[DONE\]\n\n$/, "");
    const eofOutput = await transformed(withoutSentinel, options, 3);
    assert.equal(eofOutput.includes(blankId), false, `${name}: EOF repair`);

    for (const input of [
      `${source}data: [DONE]\n\n`,
      source + trailingEvent,
      source + malformed,
      source + "opaque trailing byte",
      withoutSentinel + trailingEvent,
    ]) {
      assert.equal(await transformed(input, options, 1), input, `${name}: trailer`);
    }
  }
});

test("the terminal-only candidate exception fails open on adjacent shapes", async () => {
  const cases = [
    ["visible text close", (wireEvents) => {
      wireEvents.find((event) => event.type === "response.output_text.done").text = "visible";
    }],
    ["visible part close", (wireEvents) => {
      wireEvents.find((event) => event.type === "response.content_part.done").part.text = "visible";
    }],
    ["mismatched close id", (wireEvents) => {
      wireEvents.find((event) => event.type === "response.content_part.done").item_id = "msg_other";
    }],
    ["mismatched close index", (wireEvents) => {
      wireEvents.find((event) => event.type === "response.output_text.done").output_index = 1;
    }],
    ["changed terminal candidate id", (wireEvents) => {
      const terminal = wireEvents.find((event) => event.type === "response.completed");
      terminal.response.output[0].id = "chatcmpl-other";
    }],
    ["missing in-progress proof", (wireEvents) => {
      wireEvents.splice(wireEvents.findIndex((event) => event.type === "response.in_progress"), 1);
    }],
    ["missing response model proof", (wireEvents) => {
      for (const event of wireEvents) {
        if (event.response) delete event.response.model;
      }
    }],
    ["tool starts at index zero", (wireEvents) => {
      for (const event of wireEvents) {
        if (event.output_index === 1) event.output_index = 0;
      }
      const terminal = wireEvents.find((event) => event.type === "response.completed");
      terminal.response.output = [terminal.response.output[1], terminal.response.output[0]];
    }],
    ["candidate closes before the tool", (wireEvents) => {
      wireEvents.find(
        (event) => event.type === "response.function_call_arguments.done",
      ).sequence_number = 8;
      const firstClose = wireEvents.findIndex(
        (event) => event.type === "response.output_text.done",
      );
      const candidate = wireEvents.splice(firstClose, 3);
      const toolDone = wireEvents.findIndex(
        (event) => event.type === "response.output_item.done" && event.output_index === 1,
      );
      wireEvents.splice(toolDone, 0, ...candidate);
    }],
    ["a tool starts after the candidate suffix", (wireEvents) => {
      const model = wireEvents[0].model;
      const secondTool = {
        ...functionCall,
        id: "call_late",
        call_id: "call_late",
        name: "late_tool",
      };
      const afterTextDone = wireEvents.findIndex(
        (event) => event.type === "response.output_text.done",
      ) + 1;
      wireEvents.splice(afterTextDone, 0,
        {
          type: "response.output_item.added",
          output_index: 2,
          item: { ...secondTool, status: "in_progress", arguments: "" },
          model,
        },
        {
          type: "response.function_call_arguments.done",
          item_id: secondTool.id,
          output_index: 2,
          arguments: "{}",
          model,
        },
        {
          type: "response.output_item.done",
          output_index: 2,
          sequence_number: 10,
          item: secondTool,
          model,
        },
      );
      const terminal = wireEvents.find((event) => event.type === "response.completed");
      terminal.response.output.push(secondTool);
    }],
    ["candidate terminal does not reset", (wireEvents) => {
      wireEvents.find(
        (event) => event.type === "response.output_item.done" && event.output_index === 0,
      ).sequence_number = 10;
    }],
    ["no higher sequence precedes the reset", (wireEvents) => {
      wireEvents.find(
        (event) => event.type === "response.output_item.done" && event.output_index === 1,
      ).sequence_number = 1;
    }],
    ["terminal response id does not change", (wireEvents) => {
      const created = wireEvents.find((event) => event.type === "response.created");
      const terminal = wireEvents.find((event) => event.type === "response.completed");
      terminal.response.id = created.response.id;
    }],
  ];
  for (const [name, mutate] of cases) {
    const source = pinnedAnthropicTerminalOnlyStream(mutate);
    assert.equal(
      await transformed(source, { allowTerminalOnlyCandidate: true }, 7),
      source,
      name,
    );
  }
});

test("the pinned sequence exception fails open for every adjacent ambiguity", async () => {
  const cases = [
    ["a different reset value", (wireEvents) => {
      wireEvents[10].sequence_number = 2;
    }],
    ["a reset before tool evidence", (wireEvents) => {
      const [terminal] = wireEvents.splice(10, 1);
      wireEvents.splice(4, 0, terminal);
    }],
    ["a mismatched output index", (wireEvents) => {
      wireEvents[10].output_index = 1;
    }],
    ["a mismatched item id", (wireEvents) => {
      wireEvents[10].item = { ...wireEvents[10].item, id: "msg_other" };
    }],
    ["visible terminal content", (wireEvents) => {
      wireEvents[10].item = {
        ...wireEvents[10].item,
        content: [{ type: "output_text", text: "visible", annotations: [] }],
      };
    }],
    ["a reset on a tool item", (wireEvents) => {
      wireEvents[6].sequence_number = 8;
      wireEvents[7].sequence_number = 1;
    }],
    ["a second terminal reset", (wireEvents) => {
      wireEvents.splice(11, 0, {
        ...wireEvents[10],
        item: { ...wireEvents[10].item },
      });
    }],
    ["a later event below the retained high-water mark", (wireEvents) => {
      wireEvents[11].sequence_number = 9;
    }],
    ["a changed response id without the pinned reset", (wireEvents) => {
      wireEvents[10].sequence_number = 10;
    }],
    ["a changed response id outside the Responses namespace", (wireEvents) => {
      wireEvents[11].response.id = "chatcmpl-terminal";
    }],
    ["a changed response id without an in-progress envelope", (wireEvents) => {
      wireEvents.splice(1, 1);
    }],
  ];

  for (const [name, mutate] of cases) {
    const source = pinnedLiteLlmPhantomToolStream(mutate);
    assert.equal(await transformed(source, {}, 3), source, name);
  }
});

test("the pinned LiteLLM model field is consistent across the whole lifecycle", async () => {
  const cases = [
    ["a missing event model", (wireEvents) => {
      delete wireEvents[4].model;
    }],
    ["a changed event model", (wireEvents) => {
      wireEvents[5].model = "another-model";
    }],
    ["a non-string event model", (wireEvents) => {
      wireEvents[3].model = 7;
    }],
    ["a mismatched created response model", (wireEvents) => {
      wireEvents[0].response.model = "another-model";
    }],
    ["a missing completed response model", (wireEvents) => {
      delete wireEvents[11].response.model;
    }],
    ["a changed completed response model", (wireEvents) => {
      wireEvents[11].response.model = "another-model";
    }],
  ];

  for (const [name, mutate] of cases) {
    const source = pinnedLiteLlmPhantomToolStream(mutate);
    assert.equal(await transformed(source, {}, 4), source, name);
  }
});

test("a reasoning terminal cannot use the pinned candidate reset", async () => {
  const reasoning = {
    id: "rs_reset",
    type: "reasoning",
    status: "completed",
    summary: [],
  };
  const source = [
    responseCreated("resp_reasoning_reset", { sequenceNumber: 1 }),
    block({
      type: "response.output_item.added",
      output_index: 0,
      sequence_number: 2,
      item: { ...reasoning, status: "in_progress" },
    }),
    block({
      type: "response.output_item.done",
      output_index: 0,
      sequence_number: 1,
      item: reasoning,
    }),
  ].join("");
  assert.equal(await transformed(source), source);
});

test("removes DeepSeek's confirmed blank tool message and compacts indexes", async () => {
  const output = await transformed(phantomToolStream(), {}, 7);
  const seen = events(output);
  assert.equal(output.includes(blankMessage.id), false);
  assert.match(output, /data: \[DONE\]/);
  const toolEvents = seen.filter((event) => eventItem(event) === functionCall.id);
  assert.ok(toolEvents.length >= 3);
  assert.ok(toolEvents.every((event) => event.output_index === 0));
  assert.deepEqual(toolEvents.map((event) => event.sequence_number), [3, 4, 5]);
  assert.deepEqual(
    seen.find((event) => event.type === "response.completed").response.output,
    [functionCall],
  );
});

test("matches the pinned LiteLLM bridge's changed terminal id and null text", async () => {
  for (const content of [
    [{ type: "output_text", text: null, annotations: [] }],
    [{ type: "output_text", annotations: [] }],
  ]) {
    const terminalBlank = {
      ...blankMessage,
      id: "chatcmpl_probe",
      content,
    };
    const output = await transformed(phantomToolStream("\n", { terminalBlank }), {}, 3);
    const seen = events(output);
    assert.equal(output.includes(blankMessage.id), false);
    assert.equal(output.includes(terminalBlank.id), false);
    assert.deepEqual(
      seen.find((event) => event.type === "response.completed").response.output,
      [functionCall],
    );
  }
});

test("preserves real reasoning and ambiguous terminal identity byte-for-byte", async () => {
  const reasoning = phantomToolStream("\n", { terminalReasoning: "keep this reasoning" });
  assert.equal(await transformed(reasoning), reasoning);

  const collidingId = phantomToolStream("\n", {
    terminalBlank: {
      ...blankMessage,
      id: functionCall.id,
      content: [{ type: "output_text", text: null, annotations: [] }],
    },
  });
  assert.equal(await transformed(collidingId), collidingId);

  const visibleTerminal = phantomToolStream("\n", {
    terminalBlank: {
      ...blankMessage,
      id: "chatcmpl_visible",
      content: [{ type: "output_text", text: "real text", annotations: [] }],
    },
  });
  assert.equal(await transformed(visibleTerminal), visibleTerminal);
});

test("accepts only the pinned empty reasoning_text bridge terminator", async () => {
  const exact = block({
    type: "response.content_part.done",
    item_id: blankMessage.id,
    output_index: 0,
    content_index: 0,
    sequence_number: 7,
    part: { type: "reasoning_text", reasoning: "" },
  });
  const widened = block({
    type: "response.content_part.done",
    item_id: blankMessage.id,
    output_index: 0,
    content_index: 0,
    sequence_number: 7,
    part: { type: "reasoning_text", reasoning: "", unexpected: true },
  });
  const input = phantomToolStream().replace(exact, widened);
  assert.equal(await transformed(input), input);
});

function eventItem(event) {
  return event.item_id ?? event.item?.id;
}

test("preserves CRLF framing while compacting the stream", async () => {
  const output = await transformed(phantomToolStream("\r\n"), {}, 11);
  assert.ok(output.includes("\r\n\r\n"));
  assert.equal(output.replaceAll("\r\n\r\n", "").includes("\n\n"), false);
  assert.ok(events(output).every((event) => {
    return !Number.isInteger(event.output_index) || event.output_index === 0;
  }));
});

test("fails open when the candidate later contains visible text", async () => {
  const input = [
    responseCreated(),
    block({
      type: "response.output_item.added",
      output_index: 0,
      item: { ...blankMessage, status: "in_progress", content: [] },
    }),
    block({
      type: "response.content_part.added",
      output_index: 0,
      item_id: blankMessage.id,
      content_index: 0,
      part: { type: "output_text", text: "", annotations: [] },
    }),
    block({
      type: "response.output_text.delta",
      output_index: 0,
      item_id: blankMessage.id,
      content_index: 0,
      delta: "I will inspect it.",
    }),
    block({
      type: "response.output_item.added",
      output_index: 1,
      item: { ...functionCall, status: "in_progress", arguments: "" },
    }),
  ].join("");
  assert.equal(await transformed(input), input);
});

test("leaves a blank response without a tool call byte-identical", async () => {
  const input = [
    responseCreated(),
    block({
      type: "response.output_item.added",
      output_index: 0,
      item: { ...blankMessage, status: "in_progress", content: [] },
    }),
    block({ type: "response.output_item.done", output_index: 0, item: blankMessage }),
  ].join("");
  assert.equal(await transformed(input), input);
});

test("compacts separate reasoning and multiple later output items consistently", async () => {
  const reasoning = {
    id: "rs_1",
    type: "reasoning",
    status: "completed",
    summary: [],
  };
  const secondTool = { ...functionCall, id: "call_two", call_id: "call_two" };
  const input = [
    responseCreated("resp_reasoning"),
    block({
      type: "response.output_item.added",
      output_index: 0,
      item: { ...blankMessage, status: "in_progress", content: [] },
    }),
    block({
      type: "response.output_item.added",
      output_index: 1,
      item: { ...reasoning, status: "in_progress" },
    }),
    block({ type: "response.output_item.done", output_index: 1, item: reasoning }),
    block({
      type: "response.output_item.added",
      output_index: 2,
      item: { ...functionCall, status: "in_progress", arguments: "" },
    }),
    block({
      type: "response.function_call_arguments.done",
      output_index: 2,
      item_id: functionCall.id,
      arguments: "{}",
    }),
    block({ type: "response.output_item.done", output_index: 2, item: functionCall }),
    block({
      type: "response.output_item.added",
      output_index: 3,
      item: { ...secondTool, status: "in_progress", arguments: "" },
    }),
    block({
      type: "response.function_call_arguments.done",
      output_index: 3,
      item_id: secondTool.id,
      arguments: "{}",
    }),
    block({ type: "response.output_item.done", output_index: 3, item: secondTool }),
    block({ type: "response.output_item.done", output_index: 0, item: blankMessage }),
    responseCompleted([blankMessage, reasoning, functionCall, secondTool], {
      id: "resp_reasoning",
    }),
  ].join("");
  const seen = events(await transformed(input));
  assert.deepEqual(
    seen.filter((event) => event.type === "response.output_item.added")
      .map((event) => [event.item.id, event.output_index]),
    [[reasoning.id, 0], [functionCall.id, 1], [secondTool.id, 2]],
  );
  assert.equal(
    seen.find((event) => event.type === "response.function_call_arguments.done").output_index,
    1,
  );
  assert.deepEqual(
    seen.find((event) => event.type === "response.completed").response.output,
    [reasoning, functionCall, secondTool],
  );
});

test("removes multiple independently confirmed bridge messages in one stream", async () => {
  const firstBlank = { ...blankMessage, id: "msg_blank_one" };
  const secondBlank = { ...blankMessage, id: "msg_blank_two" };
  const firstTool = { ...functionCall, id: "call_one", call_id: "call_one" };
  const secondTool = { ...functionCall, id: "call_two", call_id: "call_two" };
  const reasoning = {
    id: "rs_between",
    type: "reasoning",
    status: "completed",
    summary: [],
  };
  const source = [
    responseCreated("resp_multiple", { sequenceNumber: 0 }),
    block({
      type: "response.output_item.added",
      output_index: 0,
      sequence_number: 1,
      item: { ...firstBlank, status: "in_progress", content: [] },
    }),
    block({
      type: "response.output_item.added",
      output_index: 1,
      sequence_number: 2,
      item: { ...firstTool, status: "in_progress", arguments: "" },
    }),
    block({
      type: "response.function_call_arguments.delta",
      item_id: firstTool.id,
      output_index: 1,
      sequence_number: 3,
      delta: "{}",
    }),
    block({
      type: "response.output_item.done",
      output_index: 1,
      sequence_number: 4,
      item: firstTool,
    }),
    block({
      type: "response.output_item.done",
      output_index: 0,
      sequence_number: 5,
      item: firstBlank,
    }),
    block({
      type: "response.output_item.added",
      output_index: 2,
      sequence_number: 6,
      item: { ...secondBlank, status: "in_progress", content: [] },
    }),
    block({
      type: "response.output_item.added",
      output_index: 3,
      sequence_number: 7,
      item: { ...reasoning, status: "in_progress" },
    }),
    block({
      type: "response.output_item.done",
      output_index: 3,
      sequence_number: 8,
      item: reasoning,
    }),
    block({
      type: "response.output_item.added",
      output_index: 4,
      sequence_number: 9,
      item: { ...secondTool, status: "in_progress", arguments: "" },
    }),
    block({
      type: "response.function_call_arguments.done",
      item_id: secondTool.id,
      output_index: 4,
      sequence_number: 10,
      arguments: "{}",
    }),
    block({
      type: "response.output_item.done",
      output_index: 4,
      sequence_number: 11,
      item: secondTool,
    }),
    block({
      type: "response.output_item.done",
      output_index: 2,
      sequence_number: 12,
      item: secondBlank,
    }),
    responseCompleted(
      [firstBlank, firstTool, secondBlank, reasoning, secondTool],
      { id: "resp_multiple", sequenceNumber: 13 },
    ),
  ].join("");

  const seen = events(await transformed(source, {}, 5));
  assert.deepEqual(
    seen
      .filter((event) => event.type === "response.output_item.added")
      .map((event) => [event.item.id, event.output_index]),
    [[firstTool.id, 0], [reasoning.id, 1], [secondTool.id, 2]],
  );
  assert.deepEqual(
    seen.map((event) => event.sequence_number),
    [0, 2, 3, 4, 7, 8, 9, 10, 11, 13],
  );
  assert.deepEqual(
    seen.find((event) => event.type === "response.completed").response.output,
    [firstTool, reasoning, secondTool],
  );
});

test("byte budget expiry releases the entire stream unchanged", async () => {
  const input = phantomToolStream();
  assert.equal(
    await transformed(input, { maxCandidateBytes: 32, maxCandidateMs: 60_000 }),
    input,
  );
});

test("timer expiry releases pending bytes and subsequent chunks immediately", async () => {
  const created = responseCreated();
  const start = block({
    type: "response.output_item.added",
    output_index: 0,
    item: { ...blankMessage, status: "in_progress", content: [] },
  });
  const tail = block({
    type: "response.output_item.added",
    output_index: 1,
    item: { ...functionCall, status: "in_progress", arguments: "" },
  });
  const stream = new TranslatedToolMessageCompatTransform({ maxCandidateMs: 5 });
  let output = "";
  stream.setEncoding("utf8");
  stream.on("data", (chunk) => { output += chunk; });
  stream.write(created + start);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(output, created + start);
  stream.write(tail);
  assert.equal(output, created + start + tail);
  stream.end();
  await once(stream, "end");
});

test("malformed and duplicate candidate lifecycles fail open", async () => {
  const created = responseCreated();
  const start = block({
    type: "response.output_item.added",
    output_index: 0,
    item: { ...blankMessage, status: "in_progress", content: [] },
  });
  const malformed = "event: response.output_item.added\ndata: {not-json}\n\n";
  assert.equal(await transformed(created + start + malformed), created + start + malformed);

  const duplicate = block({
    type: "response.output_item.added",
    output_index: 0,
    item: { ...blankMessage, status: "in_progress", content: [] },
  });
  assert.equal(await transformed(created + start + duplicate), created + start + duplicate);

  const second = block({
    type: "response.output_item.added",
    output_index: 1,
    item: { ...blankMessage, id: "msg_two", status: "in_progress", content: [] },
  });
  assert.equal(await transformed(created + start + second), created + start + second);
});

test("conflicting item references and non-assistant messages fail open", async () => {
  const created = responseCreated();
  const conflicting = block({
    type: "response.output_item.added",
    item_id: "msg_other",
    output_index: 0,
    item: { ...blankMessage, status: "in_progress", content: [] },
  });
  assert.equal(await transformed(created + conflicting), created + conflicting);

  const nonAssistant = block({
    type: "response.output_item.added",
    output_index: 0,
    item: {
      ...blankMessage,
      role: "user",
      status: "in_progress",
      content: [],
    },
  });
  assert.equal(await transformed(created + nonAssistant), created + nonAssistant);
});

test("refusal and unknown message parts are never classified as empty", async () => {
  const created = responseCreated();
  const start = block({
    type: "response.output_item.added",
    output_index: 0,
    item: { ...blankMessage, status: "in_progress", content: [] },
  });
  const tool = block({
    type: "response.output_item.added",
    output_index: 1,
    item: { ...functionCall, status: "in_progress", arguments: "" },
  });
  for (const part of [
    { type: "refusal", refusal: "cannot comply" },
    { type: "audio", audio: "opaque" },
  ]) {
    const close = block({
      type: "response.output_item.done",
      output_index: 0,
      item: { ...blankMessage, content: [part] },
    });
    assert.equal(
      await transformed(created + start + tool + close),
      created + start + tool + close,
    );
  }
  const refusal = block({
    type: "response.refusal.delta",
    output_index: 0,
    item_id: blankMessage.id,
    delta: "cannot comply",
  });
  assert.equal(
    await transformed(created + start + tool + refusal),
    created + start + tool + refusal,
  );
});

test("mismatched, duplicate, missing, and negative indexes fail open", async () => {
  const created = responseCreated();
  const start = block({
    type: "response.output_item.added",
    output_index: 0,
    item: { ...blankMessage, status: "in_progress", content: [] },
  });
  const toolAtOne = block({
    type: "response.output_item.added",
    output_index: 1,
    item: { ...functionCall, status: "in_progress", arguments: "" },
  });
  const wrongDelta = block({
    type: "response.function_call_arguments.delta",
    output_index: 0,
    item_id: functionCall.id,
    delta: "{}",
  });
  assert.equal(
    await transformed(created + start + toolAtOne + wrongDelta),
    created + start + toolAtOne + wrongDelta,
  );

  const duplicateIndex = block({
    type: "response.output_item.added",
    output_index: 1,
    item: {
      ...functionCall,
      id: "call_duplicate",
      call_id: "call_duplicate",
      status: "in_progress",
      arguments: "",
    },
  });
  assert.equal(
    await transformed(created + start + toolAtOne + duplicateIndex),
    created + start + toolAtOne + duplicateIndex,
  );

  const missingIndex = block({
    type: "response.function_call_arguments.done",
    item_id: functionCall.id,
    arguments: "{}",
  });
  assert.equal(
    await transformed(created + start + toolAtOne + missingIndex),
    created + start + toolAtOne + missingIndex,
  );

  const negative = block({
    type: "response.output_item.added",
    output_index: -1,
    item: { ...blankMessage, status: "in_progress", content: [] },
  });
  assert.equal(
    await transformed(created + negative + toolAtOne),
    created + negative + toolAtOne,
  );
});

test("tool proof requires a valid added lifecycle and matching terminal order", async () => {
  const created = responseCreated();
  const start = block({
    type: "response.output_item.added",
    output_index: 0,
    item: { ...blankMessage, status: "in_progress", content: [] },
  });
  const blankDone = block({
    type: "response.output_item.done",
    output_index: 0,
    item: blankMessage,
  });
  const toolDoneOnly = block({
    type: "response.output_item.done",
    output_index: 1,
    item: functionCall,
  });
  assert.equal(
    await transformed(created + start + toolDoneOnly + blankDone),
    created + start + toolDoneOnly + blankDone,
  );

  const terminalOnly = responseCompleted([blankMessage, functionCall]);
  assert.equal(
    await transformed(created + start + blankDone + terminalOnly),
    created + start + blankDone + terminalOnly,
  );

  const toolAdded = block({
    type: "response.output_item.added",
    output_index: 1,
    item: { ...functionCall, status: "in_progress", arguments: "" },
  });
  const malformedTool = block({
    type: "response.output_item.added",
    output_index: 1,
    item: { ...functionCall, name: "", status: "in_progress", arguments: "" },
  });
  assert.equal(
    await transformed(created + start + malformedTool + blankDone),
    created + start + malformedTool + blankDone,
  );

  const changedToolDone = block({
    type: "response.output_item.done",
    output_index: 1,
    item: { ...functionCall, name: "different_tool" },
  });
  assert.equal(
    await transformed(created + start + toolAdded + changedToolDone + blankDone),
    created + start + toolAdded + changedToolDone + blankDone,
  );

  const validToolDone = block({
    type: "response.output_item.done",
    output_index: 1,
    item: functionCall,
  });

  const wrongOrder = responseCompleted([functionCall, blankMessage]);
  assert.equal(
    await transformed(created + start + toolAdded + validToolDone + blankDone + wrongOrder),
    created + start + toolAdded + validToolDone + blankDone + wrongOrder,
  );

  const changedTool = responseCompleted([
    blankMessage,
    { ...functionCall, name: "different_tool" },
  ]);
  assert.equal(
    await transformed(created + start + toolAdded + validToolDone + blankDone + changedTool),
    created + start + toolAdded + validToolDone + blankDone + changedTool,
  );
});

test("an oversized unterminated frame fails open without retaining the body", async () => {
  const created = responseCreated();
  const start = block({
    type: "response.output_item.added",
    output_index: 0,
    item: { ...blankMessage, status: "in_progress", content: [] },
  });
  const tail = `data: ${"x".repeat(1_024)}`;
  assert.equal(
    await transformed(created + start + tail, {
      maxFrameBytes: 512,
      maxCandidateMs: 60_000,
    }),
    created + start + tail,
  );
});

test("delimiter-terminated frames and single-frame cap crossings are bounded", async () => {
  const created = responseCreated();
  const start = block({
    type: "response.output_item.added",
    output_index: 0,
    item: { ...blankMessage, status: "in_progress", content: [] },
  });
  const huge = block({
    type: "response.function_call_arguments.delta",
    output_index: 1,
    item_id: functionCall.id,
    delta: "x".repeat(2_000),
  });
  assert.equal(
    await transformed(created + start + huge, {
      maxFrameBytes: 512,
      maxCandidateMs: 60_000,
    }),
    created + start + huge,
  );

  const tool = block({
    type: "response.output_item.added",
    output_index: 1,
    item: { ...functionCall, status: "in_progress", arguments: "" },
  });
  assert.equal(
    await transformed(created + start + tool, {
      maxCandidateBytes: Buffer.byteLength(start) + 1,
      maxCandidateMs: 60_000,
    }),
    created + start + tool,
  );
});

// LiteLLM echoes the request's instructions and whole tools array in
// response.created and response.in_progress. Measured against the pinned
// 1.96.0, a 300-tool list makes each of those frames 409 KiB: larger than the
// old 256 KiB frame bound, and denser than its fixed 8 KiB member budget.
// Either one released that prelude raw and switched the repair off for the
// rest of the stream, which a bare mock envelope never reproduces.
function echoedDesktopPrelude() {
  return {
    instructions: `You are Codex. ${"i".repeat(16 * 1024)}`,
    tools: Array.from({ length: 300 }, (_, index) => ({
      type: "function",
      name: `mcp__server_${index % 12}__tool_${index}`,
      description: `Tool ${index}. ${"d".repeat(600)}`,
      parameters: {
        type: "object",
        properties: Object.fromEntries(Array.from({ length: 8 }, (_, field) => [
          `field_${field}`,
          { type: "string", description: `Field ${field} of tool ${index}.` },
        ])),
        required: ["field_0"],
        additionalProperties: false,
      },
    })),
  };
}

test("default bounds admit LiteLLM's echoed Desktop-sized prelude", async () => {
  const echo = echoedDesktopPrelude();
  const plain = responseCreated("resp_1", { sequenceNumber: 0 });
  const echoed = responseCreated("resp_1", { sequenceNumber: 0, response: echo });
  assert.ok(Buffer.byteLength(echoed) > 256 * 1024);
  const source = phantomToolStream().replace(plain, echoed);

  const translated = await transformed(source, { maxCandidateMs: 60_000 });
  assert.ok(translated.startsWith(echoed));
  assert.equal(translated.includes(blankMessage.id), false);
  assert.deepEqual(
    events(translated).find((event) => event.type === "response.completed").response.output,
    [functionCall],
  );

  const direct = await transformedDirect(
    currentDirectDeepseekStream((wireEvents) => {
      for (const event of wireEvents.slice(0, 2)) Object.assign(event.response, echo);
    }),
    { maxCandidateMs: 60_000 },
  );
  assert.equal(direct.includes("msg_direct_live"), false);
  const reasoning = events(direct)
    .find((event) => event.type === "response.completed").response.output[0];
  assert.equal(reasoning.type, "reasoning");
  assert.ok(reasoning.summary[0].text.length > 0);

  // The member budget is the second bound, and it is the one the byte bound
  // alone does not cover: the old fixed 8 KiB budget fails this same prelude
  // open byte-for-byte even though it fits the raised frame bound.
  assert.equal(
    await transformed(source, { maxJsonMembers: 8 * 1024, maxCandidateMs: 60_000 }),
    source,
  );
});

// The frame scanner jumps between line feeds instead of walking every byte,
// so the bytes before a candidate separator can still sit in storage from an
// earlier chunk. Splitting the same stream at every offset is what proves that
// boundary: a CRLF separator can be cut in three places, and a missed frame
// end silently changes what the repair sees.
test("a frame split at any byte boundary repairs identically", async () => {
  for (const newline of ["\n", "\r\n"]) {
    for (const [label, build, make] of [
      [
        "translated",
        () => phantomToolStream(newline),
        () => new TranslatedToolMessageCompatTransform({ maxCandidateMs: 60_000 }),
      ],
      [
        "direct",
        () => currentDirectDeepseekStream().replaceAll("\n", newline),
        () => new DeepseekToolMessageCompatTransform({ maxCandidateMs: 60_000 }),
      ],
    ]) {
      const source = build();
      const bytes = Buffer.from(source);
      const whole = await transformedBy(make(), bytes);
      for (let at = 1; at < bytes.length; at += 1) {
        const stream = make();
        let output = "";
        stream.setEncoding("utf8");
        stream.on("data", (chunk) => { output += chunk; });
        stream.write(bytes.subarray(0, at));
        stream.write(bytes.subarray(at));
        stream.end();
        await once(stream, "end");
        assert.equal(output, whole, `${label} ${JSON.stringify(newline)} split at ${at}`);
      }
    }
  }
});

test("one-byte fragmented frames use bounded concatenation in both SSE paths", async () => {
  const source = `event: opaque\ndata: ${"x".repeat(128 * 1024)}`;
  const options = {
    maxFrameBytes: Buffer.byteLength(source) + 1,
    maxCandidateMs: 60_000,
  };
  const originalConcat = Buffer.concat;
  let concatenations = 0;
  Buffer.concat = function countedConcat(...args) {
    concatenations += 1;
    return originalConcat.apply(this, args);
  };
  try {
    assert.equal(await transformed(source, options, 1), source);
    assert.equal(await transformedDirect(source, options, 1), source);
  } finally {
    Buffer.concat = originalConcat;
  }
  assert.ok(
    concatenations <= 4,
    `fragment accumulation performed ${concatenations} Buffer.concat calls`,
  );
});

test("dense one-byte fragmented tool frames compact in one transaction", async () => {
  const argumentText = `{"dense":"${"x".repeat(2_000)}"}`;
  const wireEvents = pinnedLiteLlmPhantomEvents();
  const deltaAt = wireEvents.findIndex(
    (event) => event.type === "response.function_call_arguments.delta",
  );
  const deltaTemplate = wireEvents[deltaAt];
  wireEvents.splice(
    deltaAt,
    1,
    ...[...argumentText].map((delta) => ({ ...deltaTemplate, delta })),
  );
  for (const event of wireEvents) {
    if (event.type === "response.function_call_arguments.done") {
      event.arguments = argumentText;
    } else if (
      event.type === "response.output_item.done" &&
      event.item?.type === "function_call"
    ) {
      event.item.arguments = argumentText;
    } else if (event.type === "response.completed") {
      event.response.output.find((item) => item.type === "function_call").arguments =
        argumentText;
    }
  }
  const source = `${wireEvents.map((event) => block(event)).join("")}data: [DONE]\n\n`;
  const output = await transformed(source, {
    maxCandidateBytes: Buffer.byteLength(source) + 1,
    maxCandidateMs: 60_000,
  }, 1);
  const seen = events(output);

  assert.equal(output.includes(blankMessage.id), false);
  assert.equal(
    seen.filter((event) => event.type === "response.function_call_arguments.delta").length,
    argumentText.length,
  );
  assert.equal(
    seen.find((event) => event.type === "response.completed")
      .response.output[0].arguments,
    argumentText,
  );
});

test("timer expiry also releases an incomplete buffered frame", async () => {
  const created = responseCreated();
  const start = block({
    type: "response.output_item.added",
    output_index: 0,
    item: { ...blankMessage, status: "in_progress", content: [] },
  });
  const partial = "event: response.output_item.added\ndata: {\"type\":";
  const stream = new TranslatedToolMessageCompatTransform({ maxCandidateMs: 5 });
  let output = "";
  stream.setEncoding("utf8");
  stream.on("data", (chunk) => { output += chunk; });
  stream.write(created + start + partial);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(output, created + start + partial);
  stream.end();
  await once(stream, "end");
});

test("destroying a pending stream clears its hold without later output", async () => {
  const created = responseCreated();
  const start = block({
    type: "response.output_item.added",
    output_index: 0,
    item: { ...blankMessage, status: "in_progress", content: [] },
  });
  const stream = new TranslatedToolMessageCompatTransform({ maxCandidateMs: 5 });
  let output = "";
  stream.on("data", (chunk) => { output += chunk.toString("utf8"); });
  stream.write(created + start);
  stream.destroy();
  await once(stream, "close");
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(output, created);
});

test("a post-completion event prevents suppression byte-for-byte", async () => {
  const untouched = "event: response.done\ndata:  {\"type\":\"response.done\",\"response\":{\"id\":\"r1\"}}\n\n";
  const input = phantomToolStream().replace("data: [DONE]\n\n", untouched);
  assert.equal(await transformed(input), input);
});

test("binds the response id and requires an exact successful terminal envelope", async () => {
  const source = phantomToolStream();
  const validCreated = responseCreated("resp_1", { sequenceNumber: 0 });
  const validCompleted = responseCompleted([blankMessage, functionCall], {
    sequenceNumber: 9,
  });
  const invalidCreated = [
    responseCreated("resp_1", {
      sequenceNumber: 0,
      response: { object: undefined },
    }),
    responseCreated("resp_1", {
      sequenceNumber: 0,
      response: { status: "completed" },
    }),
    responseCreated("", { sequenceNumber: 0 }),
    responseCreated("resp_1", {
      sequenceNumber: 0,
      response: { output: [blankMessage] },
    }),
  ];
  for (const created of invalidCreated) {
    const input = source.replace(validCreated, created);
    assert.equal(await transformed(input), input);
  }

  const invalidCompleted = [
    responseCompleted([blankMessage, functionCall], {
      id: "resp_other",
      sequenceNumber: 9,
    }),
    responseCompleted([blankMessage, functionCall], {
      sequenceNumber: 9,
      response: { object: undefined },
    }),
    responseCompleted([blankMessage, functionCall], {
      sequenceNumber: 9,
      response: { status: "incomplete" },
    }),
    responseCompleted([blankMessage, functionCall], {
      sequenceNumber: 9,
      response: { error: { message: "upstream failed" } },
    }),
    responseCompleted(
      [{ ...blankMessage, id: "resp_1" }, functionCall],
      { sequenceNumber: 9 },
    ),
    block({
      type: "response.completed",
      sequence_number: 9,
      unexpected: true,
      response: {
        id: "resp_1",
        object: "response",
        status: "completed",
        error: null,
        output: [blankMessage, functionCall],
      },
    }),
  ];
  for (const completed of invalidCompleted) {
    const input = source.replace(validCompleted, completed);
    assert.equal(await transformed(input), input);
  }
});

test("unknown item, event, and SSE frame fields disable compaction byte-for-byte", async () => {
  const created = responseCreated();
  const candidate = {
    type: "response.output_item.added",
    output_index: 0,
    item: { ...blankMessage, status: "in_progress", content: [] },
  };
  const reasoning = {
    id: "rs_strict",
    type: "reasoning",
    status: "in_progress",
    summary: [],
  };
  const custom = {
    id: "custom_strict",
    type: "custom_tool_call",
    status: "in_progress",
    call_id: "custom_strict",
    name: "shell",
    input: "",
  };
  const cases = [
    block({ ...candidate, unexpected: true }),
    block({ ...candidate, item: { ...candidate.item, unexpected: true } }),
    block({
      type: "response.output_item.added",
      output_index: 1,
      item: { ...reasoning, unexpected: true },
    }),
    block({
      type: "response.output_item.added",
      output_index: 1,
      item: {
        ...reasoning,
        summary: [{ type: "opaque_reasoning", text: "visible" }],
      },
    }),
    block({
      type: "response.output_item.added",
      output_index: 1,
      item: {
        ...reasoning,
        content: [{ type: "reasoning_text", reasoning: "ambiguous" }],
      },
    }),
    block({
      type: "response.output_item.added",
      output_index: 1,
      item: {
        ...functionCall,
        status: "in_progress",
        arguments: "",
        unexpected: true,
      },
    }),
    block({
      type: "response.output_item.added",
      output_index: 1,
      item: { ...custom, unexpected: true },
    }),
    [
      block({
        type: "response.output_item.added",
        output_index: 1,
        item: { ...functionCall, status: "in_progress", arguments: "" },
      }),
      block({
        type: "response.function_call_arguments.delta",
        output_index: 1,
        item_id: functionCall.id,
        delta: "{}",
        unexpected: true,
      }),
    ].join(""),
    [
      block({
        type: "response.output_item.added",
        output_index: 1,
        item: custom,
      }),
      block({
        type: "response.custom_tool_call_input.delta",
        output_index: 1,
        item_id: custom.id,
        delta: "echo",
        unexpected: true,
      }),
    ].join(""),
    [
      block({
        type: "response.output_item.added",
        output_index: 1,
        item: reasoning,
      }),
      block({
        type: "response.reasoning_summary_part.added",
        output_index: 1,
        item_id: reasoning.id,
        summary_index: 0,
        part: { type: "summary_text", text: "" },
        unexpected: true,
      }),
    ].join(""),
    block({
      type: "response.unknown.delta",
      output_index: 0,
      item_id: blankMessage.id,
      delta: "opaque",
    }),
    `id: opaque\n${block({
      type: "response.output_item.done",
      output_index: 0,
      item: blankMessage,
    })}`,
  ];
  for (const tail of cases) {
    const input = created + block(candidate) + tail;
    assert.equal(await transformed(input), input);
  }
});

test("ambiguous response, message, and tool lifecycle transitions fail open", async () => {
  const inProgress = block({
    type: "response.in_progress",
    response: {
      id: "resp_1",
      object: "response",
      status: "in_progress",
      error: null,
      output: [],
    },
  });
  const duplicateProgress = responseCreated() + inProgress + inProgress;
  assert.equal(await transformed(duplicateProgress), duplicateProgress);

  const source = phantomToolStream();
  const toolDone = block({
    type: "response.output_item.done",
    output_index: 1,
    sequence_number: 5,
    item: functionCall,
  });
  const mismatchedToolDone = block({
    type: "response.output_item.done",
    output_index: 1,
    sequence_number: 5,
    item: { ...functionCall, arguments: "[]" },
  });
  const mismatchedTool = source.replace(toolDone, mismatchedToolDone);
  assert.equal(await transformed(mismatchedTool), mismatchedTool);

  const candidateDone = block({
    type: "response.output_item.done",
    output_index: 0,
    sequence_number: 8,
    item: blankMessage,
  });
  const ambiguousCandidateDone = block({
    type: "response.output_item.done",
    output_index: 0,
    sequence_number: 8,
    item: {
      ...blankMessage,
      content: [blankMessage.content[0], { ...blankMessage.content[0] }],
    },
  });
  const ambiguousCandidate = source.replace(candidateDone, ambiguousCandidateDone);
  assert.equal(await transformed(ambiguousCandidate), ambiguousCandidate);

  const repeatedSequence = source.replace(
    '"output_index":1,"sequence_number":5',
    '"output_index":1,"sequence_number":4',
  );
  assert.notEqual(repeatedSequence, source);
  assert.equal(await transformed(repeatedSequence), repeatedSequence);

  const invalidObfuscation = [
    responseCreated(),
    block({
      type: "response.output_item.added",
      output_index: 0,
      item: { ...blankMessage, status: "in_progress", content: [] },
    }),
    block({
      type: "response.content_part.added",
      output_index: 0,
      item_id: blankMessage.id,
      content_index: 0,
      part: { type: "output_text", text: "", annotations: [] },
    }),
    block({
      type: "response.output_text.delta",
      output_index: 0,
      item_id: blankMessage.id,
      content_index: 0,
      delta: "",
      obfuscation: { unexpected: true },
    }),
  ].join("");
  assert.equal(await transformed(invalidObfuscation), invalidObfuscation);
});

test("pre-candidate tracking is bounded and becomes passthrough on overflow", async () => {
  const reasoning = {
    id: "rs_prelude",
    type: "reasoning",
    status: "in_progress",
    summary: [],
  };
  const input = [
    responseCreated(),
    block({
      type: "response.output_item.added",
      output_index: 0,
      item: reasoning,
    }),
    block({
      type: "response.output_item.done",
      output_index: 0,
      item: { ...reasoning, status: "completed" },
    }),
    phantomToolStream(),
  ].join("");
  assert.equal(
    await transformed(input, { maxCandidateBytes: 64, maxCandidateMs: 60_000 }),
    input,
  );
});

test("compacts a strictly confirmed custom-tool lifecycle without changing its identity", async () => {
  const custom = {
    id: "custom_shell",
    type: "custom_tool_call",
    status: "completed",
    call_id: "custom_shell_call",
    name: "shell",
    input: "echo ready",
  };
  const input = [
    responseCreated("resp_custom", { sequenceNumber: 0 }),
    block({
      type: "response.output_item.added",
      sequence_number: 1,
      output_index: 0,
      item: { ...blankMessage, status: "in_progress", content: [] },
    }),
    block({
      type: "response.output_item.added",
      sequence_number: 2,
      output_index: 1,
      item: { ...custom, status: "in_progress", input: "" },
    }),
    block({
      type: "response.custom_tool_call_input.delta",
      sequence_number: 3,
      output_index: 1,
      item_id: custom.id,
      delta: "echo ready",
    }),
    block({
      type: "response.custom_tool_call_input.done",
      sequence_number: 4,
      output_index: 1,
      item_id: custom.id,
      input: "echo ready",
    }),
    block({
      type: "response.output_item.done",
      sequence_number: 5,
      output_index: 1,
      item: custom,
    }),
    block({
      type: "response.output_item.done",
      sequence_number: 6,
      output_index: 0,
      item: blankMessage,
    }),
    responseCompleted([blankMessage, custom], {
      id: "resp_custom",
      sequenceNumber: 7,
    }),
  ].join("");

  const seen = events(await transformed(input, {}, 1));
  const customEvents = seen.filter((event) => eventItem(event) === custom.id);
  assert.deepEqual(
    customEvents.map((event) => [event.type, event.output_index, event.sequence_number]),
    [
      ["response.output_item.added", 0, 2],
      ["response.custom_tool_call_input.delta", 0, 3],
      ["response.custom_tool_call_input.done", 0, 4],
      ["response.output_item.done", 0, 5],
    ],
  );
  assert.deepEqual(
    seen.find((event) => event.type === "response.completed").response.output,
    [custom],
  );
});

test("blank compaction composes with ordinary, custom, and tool_search restoration", async () => {
  const flattened = flattenNamespaceTools([
    {
      type: "namespace",
      name: "mcp__files",
      tools: [{
        type: "function",
        name: "read_file",
        inputSchema: {
          type: "object",
          properties: { path: { type: "string" } },
          required: ["path"],
          additionalProperties: false,
        },
      }],
    },
    { type: "custom", name: "apply_patch" },
    {
      type: "tool_search",
      execution: "client",
      parameters: {
        type: "object",
        properties: { query: { type: "string" } },
        required: ["query"],
        additionalProperties: false,
      },
    },
  ]);
  const bridged = bridgeCustomTools(
    flattened.tools,
    [],
    flattened.namespaces,
  );
  const providerNames = new Set(bridged.tools.map((tool) => tool.name));
  assert.deepEqual(
    providerNames,
    new Set(["mcp__files__read_file", "apply_patch", "tool_search"]),
  );

  const tools = [
    {
      id: "call_namespace",
      type: "function_call",
      call_id: "call_namespace",
      name: "mcp__files__read_file",
      arguments: '{"path":"README.md"}',
      status: "completed",
    },
    {
      id: "call_custom",
      type: "function_call",
      call_id: "call_custom",
      name: "apply_patch",
      arguments: '{"input":"*** Begin Patch\\n*** End Patch"}',
      status: "completed",
    },
    {
      id: "call_search",
      type: "function_call",
      call_id: "call_search",
      name: "tool_search",
      arguments: '{"query":"calendar"}',
      status: "completed",
    },
  ];
  const wireEvents = pinnedLiteLlmPhantomEvents();
  const model = wireEvents[0].model;
  const lifecycle = (tool, outputIndex, sequenceNumber) => [
    {
      type: "response.output_item.added",
      output_index: outputIndex,
      item: { ...tool, status: "in_progress", arguments: "" },
      model,
    },
    {
      type: "response.function_call_arguments.delta",
      item_id: tool.id,
      output_index: outputIndex,
      delta: tool.arguments,
      model,
    },
    {
      type: "response.function_call_arguments.done",
      item_id: tool.id,
      output_index: outputIndex,
      arguments: tool.arguments,
      model,
    },
    {
      type: "response.output_item.done",
      output_index: outputIndex,
      sequence_number: sequenceNumber,
      item: tool,
      model,
    },
  ];
  wireEvents.splice(4, 4, ...lifecycle(tools[0], 1, 9));
  const candidateCloseAt = wireEvents.findIndex(
    (event) => event.type === "response.output_text.done",
  );
  wireEvents.splice(
    candidateCloseAt,
    0,
    ...lifecycle(tools[1], 2, 10),
    ...lifecycle(tools[2], 3, 11),
  );
  wireEvents.find((event) => event.type === "response.completed")
    .response.output = [
      { ...blankMessage, id: "chatcmpl-pinned-terminal" },
      ...tools,
    ];
  const source = `${wireEvents.map((event) => block(event)).join("")}data: [DONE]\n\n`;
  const output = await transformedThroughNamespace(
    source,
    flattened.namespaces,
    { maxCandidateMs: 60_000 },
    1,
  );
  const seen = events(output);
  const added = seen.filter((event) => event.type === "response.output_item.added");
  const completed = seen.find((event) => event.type === "response.completed");

  assert.equal(output.includes(blankMessage.id), false);
  assert.deepEqual(added.map((event) => event.output_index), [0, 1, 2]);
  assert.deepEqual(
    added.map((event) => [event.item.type, event.item.name, event.item.namespace]),
    [
      ["function_call", "read_file", "mcp__files"],
      ["custom_tool_call", "apply_patch", undefined],
      ["tool_search_call", undefined, undefined],
    ],
  );
  assert.deepEqual(
    completed.response.output.map((item) => item.type),
    ["function_call", "custom_tool_call", "tool_search_call"],
  );
  assert.equal(completed.response.output[0].namespace, "mcp__files");
  assert.equal(completed.response.output[0].name, "read_file");
  assert.equal(completed.response.output[1].input, "*** Begin Patch\n*** End Patch");
  assert.deepEqual(completed.response.output[2].arguments, { query: "calendar" });
});

test("compat and namespace stages preserve invalid UTF-8 byte-for-byte", async () => {
  const flattened = flattenNamespaceTools([{
    type: "namespace",
    name: "mcp__files",
    tools: [{
      type: "function",
      name: "read_file",
      inputSchema: {
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"],
        additionalProperties: false,
      },
    }],
  }]);
  const namespaceCall = {
    ...functionCall,
    name: "mcp__files__read_file",
    arguments: '{"path":"README.md"}',
  };
  const source = pinnedLiteLlmPhantomToolStream((wireEvents) => {
    for (const event of wireEvents) {
      if (event.type === "response.function_call_arguments.delta") {
        event.delta = namespaceCall.arguments;
      } else if (event.type === "response.function_call_arguments.done") {
        event.arguments = namespaceCall.arguments;
      } else if (event.item?.type === "function_call") {
        Object.assign(event.item, namespaceCall);
      } else if (event.type === "response.completed") {
        Object.assign(
          event.response.output.find((item) => item.type === "function_call"),
          namespaceCall,
        );
      }
    }
  });
  const insertAt = source.indexOf("event: response.output_item.added");
  assert.ok(insertAt > 0);
  const invalidSse = Buffer.concat([
    Buffer.from(source.slice(0, insertAt)),
    Buffer.from("event: opaque\ndata: ", "ascii"),
    Buffer.from([0xff]),
    Buffer.from("\n\n", "ascii"),
    Buffer.from(source.slice(insertAt)),
  ]);
  assert.deepEqual(
    await transformedBytesThroughNamespace(
      invalidSse,
      flattened.namespaces,
      {},
      1,
    ),
    invalidSse,
  );

  const jsonPrefix = Buffer.from(
    `{"id":"resp_invalid_utf8","status":"completed","output":[${JSON.stringify(blankMessage)},`,
  );
  const jsonSuffix = Buffer.from(
    `${JSON.stringify(namespaceCall)}],"opaque":"tail"}`,
  );
  const invalidJson = Buffer.concat([
    jsonPrefix,
    Buffer.from('{"invalid":"', "ascii"),
    Buffer.from([0xff]),
    Buffer.from('"},', "ascii"),
    jsonSuffix,
  ]);
  assert.deepEqual(
    await transformedBytesThroughNamespace(
      invalidJson,
      flattened.namespaces,
      { contentType: "application/json", json: true },
      1,
    ),
    invalidJson,
  );
});

test("compat and namespace stages jointly reject lossy numeric rewrites", async () => {
  const flattened = flattenNamespaceTools([{
    type: "namespace",
    name: "mcp__files",
    tools: [{
      type: "function",
      name: "read_file",
      inputSchema: {
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"],
        additionalProperties: false,
      },
    }],
  }]);
  const namespaceCall = {
    ...functionCall,
    name: "mcp__files__read_file",
    arguments: '{"path":"README.md"}',
  };
  const source = pinnedLiteLlmPhantomToolStream((wireEvents) => {
    for (const event of wireEvents) {
      if (event.type === "response.function_call_arguments.delta") {
        event.delta = namespaceCall.arguments;
      } else if (event.type === "response.function_call_arguments.done") {
        event.arguments = namespaceCall.arguments;
      } else if (event.item?.type === "function_call") {
        Object.assign(event.item, namespaceCall);
      } else if (event.type === "response.completed") {
        Object.assign(
          event.response.output.find((item) => item.type === "function_call"),
          namespaceCall,
        );
      }
    }
  });
  const jsonTemplate = JSON.stringify({
    id: "resp_lossy_composed",
    object: "response",
    error: null,
    status: "completed",
    numeric_provenance: 123,
    output: [blankMessage, namespaceCall],
  });

  for (const literal of [
    "1e-324",
    "1.0000000000000001",
    "0.10000000000000001",
  ]) {
    const unsafeSse = source.replace(
      '"error":null',
      `"error":null,"numeric_provenance":${literal}`,
    );
    assert.notEqual(unsafeSse, source);
    const unsafeSseBytes = Buffer.from(unsafeSse);
    assert.deepEqual(
      await transformedBytesThroughNamespace(
        unsafeSseBytes,
        flattened.namespaces,
        {},
        1,
      ),
      unsafeSseBytes,
      `SSE ${literal}`,
    );

    const unsafeJson = jsonTemplate.replace(
      '"numeric_provenance":123',
      `"numeric_provenance":${literal}`,
    );
    assert.notEqual(unsafeJson, jsonTemplate);
    const unsafeJsonBytes = Buffer.from(unsafeJson);
    assert.deepEqual(
      await transformedBytesThroughNamespace(
        unsafeJsonBytes,
        flattened.namespaces,
        { contentType: "application/json", json: true },
        1,
      ),
      unsafeJsonBytes,
      `JSON ${literal}`,
    );
  }
});

test("preserves real reasoning bytes, ids, and sequence numbers while compacting", async () => {
  const reasoningDone = {
    id: "rs_real",
    type: "reasoning",
    status: "completed",
    summary: [{ type: "summary_text", text: "real private reasoning" }],
  };
  const input = [
    responseCreated("resp_reasoning_real", { sequenceNumber: 0 }),
    block({
      type: "response.output_item.added",
      sequence_number: 1,
      output_index: 0,
      item: { ...blankMessage, status: "in_progress", content: [] },
    }),
    block({
      type: "response.output_item.added",
      sequence_number: 2,
      output_index: 1,
      item: { ...reasoningDone, status: "in_progress", summary: [] },
    }),
    block({
      type: "response.reasoning_summary_part.added",
      sequence_number: 3,
      item_id: reasoningDone.id,
      output_index: 1,
      summary_index: 0,
      part: { type: "summary_text", text: "" },
    }),
    block({
      type: "response.reasoning_summary_text.delta",
      sequence_number: 4,
      item_id: reasoningDone.id,
      output_index: 1,
      summary_index: 0,
      delta: "real private reasoning",
    }),
    block({
      type: "response.reasoning_summary_text.done",
      sequence_number: 5,
      item_id: reasoningDone.id,
      output_index: 1,
      summary_index: 0,
      text: "real private reasoning",
    }),
    block({
      type: "response.reasoning_summary_part.done",
      sequence_number: 6,
      item_id: reasoningDone.id,
      output_index: 1,
      summary_index: 0,
      part: { type: "summary_text", text: "real private reasoning" },
    }),
    block({
      type: "response.output_item.done",
      sequence_number: 7,
      output_index: 1,
      item: reasoningDone,
    }),
    block({
      type: "response.output_item.added",
      sequence_number: 8,
      output_index: 2,
      item: { ...functionCall, status: "in_progress", arguments: "" },
    }),
    block({
      type: "response.output_item.done",
      sequence_number: 9,
      output_index: 2,
      item: functionCall,
    }),
    block({
      type: "response.output_item.done",
      sequence_number: 10,
      output_index: 0,
      item: blankMessage,
    }),
    responseCompleted([blankMessage, reasoningDone, functionCall], {
      id: "resp_reasoning_real",
      sequenceNumber: 11,
    }),
  ].join("");

  const output = await transformed(input, {}, 1);
  assert.match(output, /real private reasoning/);
  const seen = events(output);
  assert.deepEqual(
    seen.map((event) => event.sequence_number),
    [0, 2, 3, 4, 5, 6, 7, 8, 9, 11],
  );
  assert.ok(
    seen
      .filter((event) => eventItem(event) === reasoningDone.id)
      .every((event) => event.output_index === 0),
  );
  assert.ok(
    seen
      .filter((event) => eventItem(event) === functionCall.id)
      .every((event) => event.output_index === 1),
  );
  assert.deepEqual(
    seen.find((event) => event.type === "response.completed").response.output,
    [reasoningDone, functionCall],
  );
});

test("reasoning output-item provenance must match the terminal response", async () => {
  const reasoningDone = {
    id: "rs_provenance",
    type: "reasoning",
    status: "completed",
    summary: [{ type: "summary_text", text: "alpha" }],
  };
  const terminalReasoning = {
    ...reasoningDone,
    summary: [{ type: "summary_text", text: "beta" }],
  };
  const input = [
    responseCreated("resp_reasoning_provenance", { sequenceNumber: 0 }),
    block({
      type: "response.output_item.added",
      sequence_number: 1,
      output_index: 0,
      item: { ...blankMessage, status: "in_progress", content: [] },
    }),
    block({
      type: "response.output_item.added",
      sequence_number: 2,
      output_index: 1,
      item: { ...reasoningDone, status: "in_progress", summary: [] },
    }),
    block({
      type: "response.output_item.done",
      sequence_number: 3,
      output_index: 1,
      item: reasoningDone,
    }),
    block({
      type: "response.output_item.added",
      sequence_number: 4,
      output_index: 2,
      item: { ...functionCall, status: "in_progress", arguments: "" },
    }),
    block({
      type: "response.output_item.done",
      sequence_number: 5,
      output_index: 2,
      item: functionCall,
    }),
    block({
      type: "response.output_item.done",
      sequence_number: 6,
      output_index: 0,
      item: blankMessage,
    }),
    responseCompleted([blankMessage, terminalReasoning, functionCall], {
      id: "resp_reasoning_provenance",
      sequenceNumber: 7,
    }),
  ].join("");

  assert.equal(await transformed(input, {}, 1), input);
});

test("a second response after a terminal envelope cancels the pending rewrite", async () => {
  const first = phantomToolStream().replace("data: [DONE]\n\n", "");
  const second = phantomToolStream()
    .replaceAll("resp_1", "resp_second")
    .replaceAll("msg_blank", "msg_second")
    .replaceAll("call_list", "call_second");
  const invalidTrailingBytes = Buffer.from([0xc0, 0xff, 0x00, 0x0a]);
  const input = Buffer.concat([
    Buffer.from(first),
    Buffer.from(second),
    invalidTrailingBytes,
  ]);
  assert.deepEqual(await transformedBytes(input, {}, 1), input);
});

test("invalid fragmented UTF-8 during a held candidate fails open byte-for-byte", async () => {
  const prefix = [
    responseCreated(),
    block({
      type: "response.output_item.added",
      output_index: 0,
      item: { ...blankMessage, status: "in_progress", content: [] },
    }),
  ].join("");
  const invalidFrame = Buffer.concat([
    Buffer.from("event: response.output_item.done\ndata: "),
    Buffer.from([0xc0]),
    Buffer.from("\n\n"),
  ]);
  const opaqueTail = Buffer.from([0xff, 0x00, 0x61, 0x0a]);
  const input = Buffer.concat([Buffer.from(prefix), invalidFrame, opaqueTail]);

  assert.deepEqual(await transformedBytes(input, {}, 1), input);

  const bomPrefixed = Buffer.concat([
    Buffer.from([0xef, 0xbb, 0xbf]),
    Buffer.from(phantomToolStream()),
  ]);
  assert.deepEqual(await transformedBytes(bomPrefixed, {}, 1), bomPrefixed);
});

test("a failed attempt cannot poison a fresh retry transform", async () => {
  const provider = { id: "deepseek", protocol: "openai" };
  const failed = translatedToolMessageCompatTransform(provider, "text/event-stream");
  const retry = translatedToolMessageCompatTransform(provider, "text/event-stream");
  const malformed = Buffer.concat([
    Buffer.from(responseCreated()),
    Buffer.from([0xc0]),
    Buffer.from("\n\n"),
  ]);
  const failedOutput = [];
  failed.on("data", (chunk) => { failedOutput.push(Buffer.from(chunk)); });
  failed.end(malformed);
  await once(failed, "end");
  assert.deepEqual(Buffer.concat(failedOutput), malformed);

  let retryOutput = "";
  retry.setEncoding("utf8");
  retry.on("data", (chunk) => { retryOutput += chunk; });
  retry.end(historicalDirectDeepseekStream());
  await once(retry, "end");
  const historicalTerminal = historicalDirectDeepseekEvents().at(-1).response;
  assert.equal(retryOutput.includes(historicalTerminal.output[0].id), false);
  assert.deepEqual(
    events(retryOutput).find((event) => event.type === "response.completed").response.output,
    [historicalTerminal.output[1]],
  );
});

test("duplicate SSE lifecycle members fail open before last-wins parsing", async () => {
  const source = phantomToolStream();
  const valid = block({
    type: "response.output_item.added",
    output_index: 0,
    sequence_number: 1,
    item: { ...blankMessage, status: "in_progress", content: [] },
  });
  const visible = {
    ...blankMessage,
    status: "in_progress",
    content: [{ type: "output_text", text: "MUST_KEEP_LIFECYCLE" }],
  };
  const duplicate = rawBlock(
    "response.output_item.added",
    `{"type":"response.output_item.added","output_index":0,"sequence_number":1,` +
      `"item":${JSON.stringify(visible)},` +
      `"\\u0069tem":${JSON.stringify({
        ...blankMessage,
        status: "in_progress",
        content: [],
      })}}`,
  );
  const input = source.replace(valid, duplicate);
  assert.notEqual(input, source);
  assert.equal(await transformed(input, {}, 1), input);
});

test("duplicate terminal SSE members preserve visible and error values byte-for-byte", async () => {
  const source = phantomToolStream();
  const completedEvent = {
    type: "response.completed",
    sequence_number: 9,
    response: {
      id: "resp_1",
      object: "response",
      status: "completed",
      error: null,
      output: [blankMessage, functionCall],
    },
  };
  const valid = responseCompleted([blankMessage, functionCall], {
    id: "resp_1",
    sequenceNumber: 9,
  });
  const visible = {
    id: "msg_must_keep",
    type: "message",
    status: "completed",
    role: "assistant",
    content: [{ type: "output_text", text: "MUST_KEEP_OUTPUT" }],
  };
  const json = JSON.stringify(completedEvent);
  const cases = [
    json.replace(
      `"output":${JSON.stringify(completedEvent.response.output)}`,
      `"output":${JSON.stringify([visible])},` +
        `"output":${JSON.stringify(completedEvent.response.output)}`,
    ),
    json.replace(
      '"error":null',
      '"error":{"message":"MUST_KEEP_ERROR"},"error":null',
    ),
    json.replace(
      '"status":"completed"',
      '"status":"failed","status":"completed"',
    ),
    json.replace('"text":""', '"text":"MUST_KEEP_TEXT","text":""'),
    json.replace(
      '"arguments":"{}"',
      '"arguments":"MUST_KEEP_TOOL","arguments":"{}"',
    ),
  ];
  for (const duplicateJson of cases) {
    const input = source.replace(
      valid,
      rawBlock("response.completed", duplicateJson),
    );
    assert.notEqual(input, source);
    assert.equal(await transformed(input, {}, 1), input);
  }
});

test("bounded uniqueness scanning fails open and accepts unique escaped keys", async () => {
  const source = phantomToolStream();
  for (const options of [
    { maxJsonDepth: 1 },
    { maxJsonMembers: 1 },
    { maxJsonKeyCodeUnits: 1 },
  ]) {
    assert.equal(await transformed(source, options, 1), source);
  }

  const escaped = source.replace(
    '"sequence_number":3',
    '"\\u0073equence_number":3',
  );
  assert.notEqual(escaped, source);
  const normalized = await transformed(escaped, {}, 1);
  assert.equal(normalized.includes(blankMessage.id), false);
  assert.deepEqual(
    events(normalized).find((event) => event.type === "response.completed").response.output,
    [functionCall],
  );
});

const lossyJsonNumbers = [
  "1e400",
  "-0",
  "9007199254740993",
  "1e-324",
  "1.0000000000000001",
  "0.10000000000000001",
];

test("SSE rewrites reject lossy outer and nested argument numbers", async () => {
  const source = phantomToolStream();
  const terminal = responseCompleted([blankMessage, functionCall], {
    id: "resp_1",
    sequenceNumber: 9,
  });
  for (const literal of lossyJsonNumbers) {
    const unsafeTerminal = terminal.replace(
      '"error":null',
      `"error":null,"numeric_provenance":${literal}`,
    );
    const input = source.replace(terminal, unsafeTerminal);
    assert.notEqual(input, source);
    assert.equal(await transformed(input, {}, 1), input, `outer ${literal}`);

    const argumentsJson = `{"numeric_provenance":${literal}}`;
    const nested = pinnedLiteLlmPhantomToolStream((wireEvents) => {
      for (const event of wireEvents) {
        if (event.type === "response.function_call_arguments.delta") {
          event.delta = argumentsJson;
        } else if (event.type === "response.function_call_arguments.done") {
          event.arguments = argumentsJson;
        } else if (
          event.type === "response.output_item.done" &&
          event.item?.type === "function_call"
        ) {
          event.item.arguments = argumentsJson;
        } else if (event.type === "response.completed") {
          event.response.output.find((item) => item.type === "function_call").arguments =
            argumentsJson;
        }
      }
    });
    assert.equal(await transformed(nested, {}, 1), nested, `nested ${literal}`);
  }

  const safeArguments = `{"numeric_provenance":${Number.MAX_SAFE_INTEGER}}`;
  const safe = pinnedLiteLlmPhantomToolStream((wireEvents) => {
    for (const event of wireEvents) {
      if (event.type === "response.function_call_arguments.delta") {
        event.delta = safeArguments;
      } else if (event.type === "response.function_call_arguments.done") {
        event.arguments = safeArguments;
      } else if (
        event.type === "response.output_item.done" &&
        event.item?.type === "function_call"
      ) {
        event.item.arguments = safeArguments;
      } else if (event.type === "response.completed") {
        event.response.output.find((item) => item.type === "function_call").arguments =
          safeArguments;
      }
    }
  });
  assert.equal((await transformed(safe, {}, 1)).includes(blankMessage.id), false);
});

test("direct DeepSeek terminal JSON keeps lossy numeric provenance byte-identical", async () => {
  const source = currentDirectDeepseekStream();
  for (const literal of [
    "1e-324",
    "1.0000000000000001",
    "0.10000000000000001",
  ]) {
    const input = source.replace('"input_tokens":17', `"input_tokens":${literal}`);
    assert.notEqual(input, source);
    assert.equal(await transformedDirect(input, {}, 1), input, literal);
  }
});

test("non-streaming responses remove only exact empty messages proven by tool traffic", async () => {
  const secondBlank = {
    ...blankMessage,
    id: "msg_second",
    content: [{ type: "output_text", text: null, annotations: [] }],
    phase: null,
  };
  const secondTool = { ...functionCall, id: "call_second", call_id: "call_second" };
  const reasoning = { id: "rs_json", type: "reasoning", summary: [{ type: "summary_text", text: "kept" }] };
  const visible = {
    id: "msg_visible",
    type: "message",
    status: "completed",
    role: "assistant",
    content: [{ type: "output_text", text: "done", annotations: [] }],
  };
  const payload = {
    id: "resp_json",
    object: "response",
    status: "completed",
    error: null,
    output: [blankMessage, reasoning, functionCall, secondBlank, secondTool, visible],
    usage: { input_tokens: 7, output_tokens: 3, total_tokens: 10 },
  };
  const result = JSON.parse(await transformedJson(JSON.stringify(payload, null, 2), {}, 7));
  assert.deepEqual(result, {
    ...payload,
    output: [reasoning, functionCall, secondTool, visible],
  });
});

test("duplicate non-streaming members never erase earlier output or metadata", async () => {
  const visible = {
    id: "msg_must_keep_json",
    type: "message",
    status: "completed",
    role: "assistant",
    content: [{ type: "output_text", text: "MUST_KEEP_OUTPUT" }],
  };
  const reasoning = {
    id: "rs_duplicate_json",
    type: "reasoning",
    status: "completed",
    summary: [{ type: "summary_text", text: "kept reasoning" }],
  };
  const base = JSON.stringify(jsonResponse([blankMessage, functionCall]));
  const reasoningBase = JSON.stringify(
    jsonResponse([blankMessage, reasoning, functionCall]),
  );
  const cases = [
    base.replace(
      `"output":${JSON.stringify([blankMessage, functionCall])}`,
      `"output":${JSON.stringify([visible])},` +
        `"output":${JSON.stringify([blankMessage, functionCall])}`,
    ),
    base.replace(
      '"error":null',
      '"error":{"message":"MUST_KEEP_ERROR"},"\\u0065rror":null',
    ),
    base.replace(
      '"status":"completed"',
      '"status":"failed","status":"completed"',
    ),
    base.replace('"text":""', '"text":"MUST_KEEP_TEXT","text":""'),
    base.replace(
      '"arguments":"{}"',
      '"arguments":"MUST_KEEP_TOOL","arguments":"{}"',
    ),
    reasoningBase.replace(
      `"summary":${JSON.stringify(reasoning.summary)}`,
      `"summary":[{"type":"summary_text","text":"MUST_KEEP_REASONING"}],` +
        `"summary":${JSON.stringify(reasoning.summary)}`,
    ),
  ];
  for (const input of cases) {
    assert.equal(await transformedJson(input, {}, 1), input);
  }
});

test("non-streaming uniqueness limits fail open while unique JSON remains eligible", async () => {
  const source = JSON.stringify(jsonResponse([blankMessage, functionCall]));
  for (const options of [
    { maxJsonDepth: 1 },
    { maxJsonMembers: 1 },
    { maxJsonKeyCodeUnits: 1 },
  ]) {
    assert.equal(await transformedJson(source, options, 1), source);
  }

  const unique = source.replace(
    '"error":null',
    '"\\u0065rror":null,"metadata":{' +
      '"astral":"\\ud83d\\ude00","lone":"\\ud800",' +
      `"fraction":-1.25e+3,"safe":${Number.MAX_SAFE_INTEGER}}`,
  );
  const normalized = await transformedJson(unique, {}, 1);
  assert.notEqual(normalized, unique);
  const payload = JSON.parse(normalized);
  assert.deepEqual(payload.output, [functionCall]);
  assert.equal(payload.metadata.astral, "😀");
  assert.equal(payload.metadata.lone, "\ud800");
  assert.equal(payload.metadata.fraction, -1250);
  assert.equal(payload.metadata.safe, Number.MAX_SAFE_INTEGER);
});

test("non-streaming rewrites reject lossy outer and nested argument numbers", async () => {
  const base = JSON.stringify(jsonResponse([blankMessage, functionCall]));
  for (const literal of lossyJsonNumbers) {
    const outer = base.replace(
      '"error":null',
      `"error":null,"metadata":{"numeric_provenance":${literal}}`,
    );
    assert.equal(await transformedJson(outer, {}, 1), outer, `outer ${literal}`);

    const nestedTool = {
      ...functionCall,
      arguments: `{"numeric_provenance":${literal}}`,
    };
    const nested = JSON.stringify(jsonResponse([blankMessage, nestedTool]));
    assert.equal(await transformedJson(nested, {}, 1), nested, `nested ${literal}`);
  }
});

test("non-streaming normalization requires a successful envelope and unique ids", async () => {
  const valid = jsonResponse([blankMessage, functionCall]);
  const invalidPayloads = [
    { ...valid, id: "" },
    { ...valid, object: undefined },
    { ...valid, object: "list" },
    { ...valid, status: undefined },
    { ...valid, status: "incomplete" },
    { ...valid, error: { message: "failed" } },
    jsonResponse([
      blankMessage,
      { ...functionCall, id: blankMessage.id },
    ]),
    jsonResponse([
      { ...blankMessage, id: "resp_json" },
      functionCall,
    ]),
    jsonResponse([
      { ...blankMessage, id: "" },
      functionCall,
    ]),
    jsonResponse([
      blankMessage,
      {
        id: "rs_unknown",
        type: "reasoning",
        summary: [{ type: "opaque_reasoning", text: "visible" }],
      },
      functionCall,
    ]),
  ];
  for (const payload of invalidPayloads) {
    const input = JSON.stringify(payload, null, 2);
    assert.equal(await transformedJson(input, {}, 1), input);
  }
});

test("non-streaming malformed neighboring messages make the whole body fail open", async () => {
  const secondBlank = { ...blankMessage, id: "msg_after_malformed" };
  const secondTool = {
    ...functionCall,
    id: "call_after_malformed",
    call_id: "call_after_malformed",
  };
  const baseNeighbor = {
    id: "msg_malformed_neighbor",
    type: "message",
    status: "completed",
    role: "assistant",
    content: [{ type: "output_text", text: "visible", annotations: [] }],
  };
  const malformedNeighbors = [
    { ...baseNeighbor, role: "user" },
    { ...baseNeighbor, content: "visible" },
    { ...baseNeighbor, content: [] },
    { ...baseNeighbor, content: [{ type: "opaque", value: "visible" }] },
    { ...baseNeighbor, phase: { value: "final" } },
  ];
  for (const neighbor of malformedNeighbors) {
    const input = JSON.stringify(
      jsonResponse([blankMessage, neighbor, secondBlank, secondTool]),
      null,
      2,
    );
    assert.equal(await transformedJson(input, {}, 1), input);
  }
});

test("non-streaming ambiguous, malformed, and oversized bodies fail open byte-for-byte", async () => {
  const secondBlank = { ...blankMessage, id: "msg_second" };
  const consecutive = JSON.stringify(
    jsonResponse([blankMessage, secondBlank, functionCall]),
    null,
    2,
  );
  assert.equal(await transformedJson(consecutive), consecutive);

  const visible = JSON.stringify(
    jsonResponse([
      blankMessage,
      {
        id: "msg_visible",
        type: "message",
        status: "completed",
        role: "assistant",
        content: [{ type: "output_text", text: "real text" }],
      },
      functionCall,
    ]),
    null,
    2,
  );
  assert.equal(await transformedJson(visible), visible);

  const malformed = "{not-json";
  assert.equal(await transformedJson(malformed), malformed);

  for (const output of [
    [{ ...blankMessage, id: undefined }, functionCall],
    [blankMessage, { ...functionCall, name: "" }],
    [blankMessage, { ...functionCall, call_id: undefined }],
    [
      { ...blankMessage, content: [{ type: "refusal", refusal: "kept" }] },
      functionCall,
    ],
  ]) {
    const malformedItems = JSON.stringify(jsonResponse(output), null, 2);
    assert.equal(await transformedJson(malformedItems), malformedItems);
  }

  const incomplete = JSON.stringify({
    id: "resp_incomplete",
    object: "response",
    status: "incomplete",
    error: null,
    output: [blankMessage, functionCall],
  }, null, 2);
  assert.equal(await transformedJson(incomplete), incomplete);

  const oversized = JSON.stringify(jsonResponse([blankMessage, functionCall], {
    opaque: "x".repeat(256),
  }));
  assert.equal(await transformedJson(oversized, { maxBytes: 64 }, 11), oversized);

  const invalidUtf8 = Buffer.from('{"output":"\xc0"}', "latin1");
  const stream = new TranslatedToolMessageJsonCompatTransform();
  const chunks = [];
  stream.on("data", (chunk) => { chunks.push(chunk); });
  stream.end(invalidUtf8);
  await once(stream, "end");
  assert.deepEqual(Buffer.concat(chunks), invalidUtf8);

  const bomJson = Buffer.concat([
    Buffer.from([0xef, 0xbb, 0xbf]),
    Buffer.from(JSON.stringify(jsonResponse([blankMessage, functionCall]))),
  ]);
  const bomStream = new TranslatedToolMessageJsonCompatTransform();
  const bomChunks = [];
  bomStream.on("data", (chunk) => { bomChunks.push(chunk); });
  bomStream.end(bomJson);
  await once(bomStream, "end");
  assert.deepEqual(Buffer.concat(bomChunks), bomJson);
});

test("a slow non-streaming body releases pending bytes and becomes passthrough", async () => {
  const source = JSON.stringify(jsonResponse([blankMessage, functionCall]));
  const split = Math.floor(source.length / 2);
  const stream = new TranslatedToolMessageJsonCompatTransform({ maxMs: 5 });
  let output = "";
  stream.setEncoding("utf8");
  stream.on("data", (chunk) => { output += chunk; });
  stream.write(source.slice(0, split));
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(output, source.slice(0, split));
  stream.end(source.slice(split));
  await once(stream, "end");
  assert.equal(output, source);
});

test("factory is translated-protocol scoped and returns fresh retry transforms", () => {
  const provider = { id: "deepseek" };
  const first = translatedToolMessageCompatTransform(provider, "text/event-stream");
  const retry = translatedToolMessageCompatTransform(provider, "text/event-stream");
  assert.ok(first instanceof DeepseekToolMessageCompatTransform);
  assert.ok(retry instanceof DeepseekToolMessageCompatTransform);
  assert.notEqual(first, retry);
  for (const translated of [
    { id: "opencode-go" },
    { id: "commandcode", protocol: "anthropic" },
    { id: "generic", protocol: "openai" },
  ]) {
    assert.ok(
      translatedToolMessageCompatTransform(translated, "text/event-stream")
        instanceof TranslatedToolMessageCompatTransform,
    );
  }
  assert.ok(
    translatedToolMessageCompatTransform(provider, "application/json; charset=utf-8")
      instanceof TranslatedToolMessageJsonCompatTransform,
  );
  assert.equal(
    translatedToolMessageCompatTransform(
      { id: "opencode-go-responses", protocol: "openai-responses" },
      "text/event-stream",
    ),
    undefined,
  );
  assert.equal(translatedToolMessageCompatTransform(undefined, "text/event-stream"), undefined);
  assert.equal(translatedToolMessageCompatTransform(provider, "text/plain"), undefined);
  assert.ok(
    deepseekToolMessageCompatTransform("deepseek", "TEXT/EVENT-STREAM; charset=utf-8")
      instanceof DeepseekToolMessageCompatTransform,
  );
  assert.equal(
    deepseekToolMessageCompatTransform("opencode-go", "text/event-stream"),
    undefined,
  );
  assert.equal(
    deepseekToolMessageCompatTransform("deepseek", "application/json"),
    undefined,
  );
});
