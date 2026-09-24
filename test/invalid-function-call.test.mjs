import assert from "node:assert/strict";
import { Readable, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import test from "node:test";

import {
  INVALID_FUNCTION_CALL_ARGUMENTS_CODE,
  InvalidCompletedFunctionCallTransform,
  InvalidFunctionCallArgumentsError,
  findUnusableCompletedFunctionCall,
  findUnusableFunctionCallArguments,
  functionCallArgumentsAreJson,
  historyFunctionCallArgumentsError,
  isLocalToolArgumentConversionFailure,
  localToolArgumentConversionError,
} from "../src/invalid-function-call.mjs";

const UNTERMINATED = '{"cmd":"echo hello';
const VALID = '{"cmd":"echo hello"}';

function sse(event) {
  return `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}

async function collect(transform, chunks) {
  const output = [];
  await pipeline(
    Readable.from(chunks),
    transform,
    new Writable({
      write(chunk, _encoding, callback) {
        output.push(Buffer.from(chunk));
        callback();
      },
    }),
  );
  return Buffer.concat(output);
}

async function collectUntilError(transform, chunks) {
  const output = [];
  let error;
  try {
    await pipeline(
      Readable.from(chunks),
      transform,
      new Writable({
        write(chunk, _encoding, callback) {
          output.push(Buffer.from(chunk));
          callback();
        },
      }),
    );
  } catch (caught) {
    error = caught;
  }
  assert.ok(error, "the transform should fail the completed invalid call");
  return { output: Buffer.concat(output), error };
}

test("functionCallArgumentsAreJson allows empty, objects, and parseable JSON", () => {
  assert.equal(functionCallArgumentsAreJson(""), true);
  assert.equal(functionCallArgumentsAreJson("   "), true);
  assert.equal(functionCallArgumentsAreJson(VALID), true);
  assert.equal(functionCallArgumentsAreJson("[]"), true);
  assert.equal(functionCallArgumentsAreJson({ cmd: "x" }), true);
  assert.equal(functionCallArgumentsAreJson(UNTERMINATED), false);
  assert.equal(functionCallArgumentsAreJson("{"), false);
});

test("findUnusableFunctionCallArguments names the stored call and omits the body", () => {
  const found = findUnusableFunctionCallArguments([
    { type: "message", role: "user", content: [{ type: "input_text", text: "run it" }] },
    {
      type: "function_call",
      name: "exec_command",
      call_id: "call_abc",
      id: "fc_abc",
      arguments: UNTERMINATED,
    },
  ]);
  assert.equal(found.toolName, "exec_command");
  assert.equal(found.callId, "call_abc");
  assert.equal(found.param, "input[1]");
  assert.match(found.jsonError, /Unterminated string|Unexpected end/i);
  const payload = historyFunctionCallArgumentsError(found);
  assert.equal(payload.error.code, INVALID_FUNCTION_CALL_ARGUMENTS_CODE);
  assert.equal(payload.error.type, "invalid_request_error");
  assert.match(payload.error.message, /not a provider rejection/);
  assert.match(payload.error.message, /exec_command/);
  assert.match(payload.error.message, /call_abc/);
  assert.doesNotMatch(payload.error.message, /echo hello/);
});

test("findUnusableFunctionCallArguments inspects chat-shaped tool_calls", () => {
  const found = findUnusableFunctionCallArguments([
    {
      type: "message",
      role: "assistant",
      tool_calls: [
        {
          id: "call_chat",
          function: { name: "exec_command", arguments: UNTERMINATED },
        },
      ],
    },
  ]);
  assert.equal(found.toolName, "exec_command");
  assert.equal(found.callId, "call_chat");
  assert.equal(found.param, "input[0].tool_calls[0]");
});

test("findUnusableFunctionCallArguments ignores valid, empty, and custom tool calls", () => {
  assert.equal(
    findUnusableFunctionCallArguments([
      { type: "function_call", name: "exec_command", arguments: VALID },
      { type: "function_call", name: "exec_command", arguments: "" },
      { type: "custom_tool_call", name: "apply_patch", input: "*** Begin Patch" },
      { type: "message", role: "user", content: "hi" },
    ]),
    undefined,
  );
  assert.equal(findUnusableFunctionCallArguments("just a prompt"), undefined);
});

test("duplicate-key JSON still parses, so history is not refused", () => {
  assert.equal(
    findUnusableFunctionCallArguments([
      { type: "function_call", name: "exec_command", arguments: '{"a":1,"a":2}' },
    ]),
    undefined,
  );
});

test("a raw-codec function_call keeps malformed arguments for the native hook", () => {
  const lookups = {
    customCodecs: new Map([["apply_patch", { preserveRawArguments: true }]]),
  };
  assert.equal(
    findUnusableFunctionCallArguments(
      [{ type: "function_call", name: "apply_patch", arguments: "*** Begin Patch" }],
      { lookups },
    ),
    undefined,
  );
});

test("isLocalToolArgumentConversionFailure matches LiteLLM's Anthropic invoke error", () => {
  const body = JSON.stringify({
    error: {
      message:
        "Failed to parse tool call arguments for tool 'exec_command' (Anthropic tool invoke). " +
        "Error: Unterminated string starting at: line 1 column 8 (char 7).\n" +
        '{"cmd":"usage limit reached for your GLM Coding Plan"}',
    },
  });
  assert.equal(isLocalToolArgumentConversionFailure(body), true);
  const translated = localToolArgumentConversionError(body);
  assert.equal(translated.error.code, INVALID_FUNCTION_CALL_ARGUMENTS_CODE);
  assert.match(translated.error.message, /exec_command/);
  assert.match(translated.error.message, /not a provider rejection/);
  assert.doesNotMatch(translated.error.message, /usage limit reached/);
  assert.doesNotMatch(translated.error.message, /opencode rejected/);
  assert.equal(isLocalToolArgumentConversionFailure("insufficient_quota"), false);
});

test("a completed unterminated function_call fails before the done frame is relayed", async () => {
  const added = sse({
    type: "response.output_item.added",
    item: {
      type: "function_call",
      id: "fc_1",
      call_id: "call_1",
      name: "exec_command",
      arguments: "",
    },
  });
  const delta = sse({
    type: "response.function_call_arguments.delta",
    item_id: "fc_1",
    delta: UNTERMINATED,
  });
  const done = sse({
    type: "response.function_call_arguments.done",
    item_id: "fc_1",
    call_id: "call_1",
    arguments: UNTERMINATED,
  });
  const closed = sse({
    type: "response.output_item.done",
    item: {
      type: "function_call",
      id: "fc_1",
      call_id: "call_1",
      name: "exec_command",
      arguments: UNTERMINATED,
    },
  });
  const { output, error } = await collectUntilError(
    new InvalidCompletedFunctionCallTransform(),
    [Buffer.from(added + delta + done + closed, "utf8")],
  );
  assert.equal(error.code, INVALID_FUNCTION_CALL_ARGUMENTS_CODE);
  assert.ok(error instanceof InvalidFunctionCallArgumentsError);
  assert.equal(error.status, 502);
  assert.match(error.message, /exec_command/);
  assert.match(error.message, /did not relay the completed item/);
  const text = output.toString("utf8");
  assert.doesNotMatch(text, /output_item\.added/);
  assert.doesNotMatch(text, /function_call_arguments\.delta/);
  assert.doesNotMatch(text, /function_call_arguments\.done/);
  assert.doesNotMatch(text, /output_item\.done/);
});

test("a done frame without a name still fails and names the tool from added", async () => {
  const added = sse({
    type: "response.output_item.added",
    item: {
      type: "function_call",
      id: "fc_anon",
      call_id: "call_anon",
      name: "exec_command",
      arguments: "",
    },
  });
  const done = sse({
    type: "response.function_call_arguments.done",
    item_id: "fc_anon",
    call_id: "call_anon",
    arguments: UNTERMINATED,
  });
  const { output, error } = await collectUntilError(
    new InvalidCompletedFunctionCallTransform(),
    [Buffer.from(added + done, "utf8")],
  );
  assert.equal(error.toolName, "exec_command");
  assert.match(error.message, /exec_command/);
  assert.doesNotMatch(output.toString("utf8"), /output_item\.added/);
  assert.doesNotMatch(output.toString("utf8"), /function_call_arguments\.done/);
});

test("a valid completed function_call stream is byte-identical", async () => {
  const source = [
    sse({
      type: "response.output_item.added",
      item: {
        type: "function_call",
        id: "fc_ok",
        call_id: "call_ok",
        name: "exec_command",
        arguments: "",
      },
    }),
    sse({
      type: "response.function_call_arguments.done",
      item_id: "fc_ok",
      arguments: VALID,
    }),
    sse({
      type: "response.output_item.done",
      item: {
        type: "function_call",
        id: "fc_ok",
        call_id: "call_ok",
        name: "exec_command",
        arguments: VALID,
      },
    }),
  ].join("");
  const output = await collect(
    new InvalidCompletedFunctionCallTransform(),
    [Buffer.from(source, "utf8")],
  );
  assert.equal(output.toString("utf8"), source);
});

test("raw-codec malformed arguments still pass through the stream transform", async () => {
  const source = sse({
    type: "response.function_call_arguments.done",
    item_id: "fc_patch",
    name: "apply_patch",
    arguments: "*** Begin Patch\n*** End Patch",
  });
  const output = await collect(
    new InvalidCompletedFunctionCallTransform({
      customCodecs: new Map([["apply_patch", { preserveRawArguments: true }]]),
    }),
    [Buffer.from(source, "utf8")],
  );
  assert.equal(output.toString("utf8"), source);
});

test("a non-streaming completed response with unterminated arguments is refused", async () => {
  const payload = {
    output: [
      {
        type: "function_call",
        name: "exec_command",
        call_id: "call_json",
        arguments: UNTERMINATED,
      },
    ],
  };
  assert.equal(
    findUnusableCompletedFunctionCall(payload)?.toolName,
    "exec_command",
  );
  const body = JSON.stringify(payload);
  const { output, error } = await collectUntilError(
    new InvalidCompletedFunctionCallTransform(undefined, false),
    [Buffer.from(body, "utf8")],
  );
  assert.equal(error.code, INVALID_FUNCTION_CALL_ARGUMENTS_CODE);
  assert.equal(output.length, 0);
});
