import assert from "node:assert/strict";
import { Readable, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import test from "node:test";
import {
  bridgeCustomTools, buildNamespaceLookups, flattenNamespaceTools,
  NamespaceToolCallTransform,
} from "../src/namespace-relay.mjs";
import {
  GROK_STRUCTURED_PATCH_CODEC, grokStructuredPatchEnabled,
  serializeStructuredPatch,
} from "../src/grok-structured-patch.mjs";

const native = { type: "custom", name: "apply_patch", description: "Keep project permissions.", format: { type: "grammar", syntax: "lark", definition: "native grammar unchanged" } };
const operations = { operations: [{ op: "add", path: "hello.txt", lines: ['Привет 🧙 "world"', ""] }] };
const args = JSON.stringify(operations);
const patch = serializeStructuredPatch(operations);
const codecs = new Map([["apply_patch", GROK_STRUCTURED_PATCH_CODEC]]);
function setup(tools = [native], input = [], choice) {
  const original = structuredClone(tools);
  const flattened = flattenNamespaceTools(tools);
  const namespaces = flattened.namespaces;
  const bridged = bridgeCustomTools(flattened.tools, input, namespaces, choice, undefined, { codecs });
  assert.deepEqual(tools, original);
  const lookups = buildNamespaceLookups(namespaces);
  const name = [...(lookups.customCodecs || [])][0]?.[0];
  return { ...bridged, namespaces, lookups, name };
}
function item(name, value = args) {
  return { type: "function_call", id: "fc_patch", call_id: "call_patch", name, arguments: value };
}
function frame(type, extra = {}) {
  return `event: ${type}\ndata: ${JSON.stringify({ type, ...extra })}\n\n`;
}
function events(name, value = args, { deltas = true, done = true, close = true, summary = true } = {}) {
  const call = item(name, value);
  const result = [frame("response.output_item.added", { output_index: 0, item: { ...call, arguments: "" } })];
  if (deltas) for (let i = 0; i < value.length; i += 1) result.push(frame("response.function_call_arguments.delta", { item_id: call.id, output_index: 0, delta: value.slice(i, i + 1) }));
  if (done) result.push(frame("response.function_call_arguments.done", { item_id: call.id, output_index: 0, arguments: value }));
  if (close) result.push(frame("response.output_item.done", { output_index: 0, item: call }));
  if (summary) result.push(frame("response.completed", { response: { output: [call] } }));
  return result;
}
async function relay(bridge, parts, contentType = "text/event-stream", options = {}) {
  const chunks = [];
  let error;
  try {
    await pipeline(Readable.from(parts), new NamespaceToolCallTransform(bridge.namespaces, contentType, "grok-oauth/grok-4.6", options), new Writable({ write(chunk, _encoding, next) { chunks.push(Buffer.from(chunk)); next(); } }));
  } catch (caught) { error = caught; }
  return { output: Buffer.concat(chunks).toString("utf8"), error };
}
function parsed(output) {
  return output.split(/\n\n/).filter(Boolean).map(x => JSON.parse(x.split("\n").find(l => l.startsWith("data: ")).slice(6)));
}

test("typed patches default on for supported OAuth routes; only literal 0 opts out", () => {
  for (const slug of ["grok-oauth/grok-4.6", "grok-oauth/grok-4.7", "grok-oauth/grok-4.5", "grok-api/grok-4.7", "openai/gpt-6-astra"]) {
    const supported = ["grok-oauth/grok-4.6", "grok-oauth/grok-4.7"].includes(slug);
    for (const flag of [undefined, "", "1", "true", "false", "0", " 0"]) {
      assert.equal(grokStructuredPatchEnabled({ slug }, { CODEX_ROUTER_GROK_STRUCTURED_PATCH: flag }), supported && flag !== "0", `${slug}: ${flag}`);
    }
  }
});

test("structured definitions preserve native grammar and failed historical inputs exactly", () => {
  const history = [
    { type: "custom_tool_call", id: "old", call_id: "old-call", name: "apply_patch", input: "*** Begin Patch ***\r\nunsupported/failed raw input\r\n" },
    { type: "custom_tool_call_output", call_id: "old-call", output: "Invalid patch format" },
  ];
  const bridge = setup([native], history, { type: "custom", name: "apply_patch" });
  assert.deepEqual(bridge.tools[0].parameters, GROK_STRUCTURED_PATCH_CODEC.parameters);
  assert.match(bridge.tools[0].description, /Keep project permissions/);
  assert.equal(JSON.parse(bridge.input[0].arguments).input, history[0].input);
  assert.equal(bridge.input[0].call_id, history[0].call_id);
  assert.deepEqual(bridge.input[1], { ...history[1], type: "function_call_output" });
  assert.deepEqual(bridge.toolChoice, { type: "function", name: bridge.name });
});

test("same-named ordinary and namespace tools retain distinct identities", async () => {
  const ordinary = { type: "function", name: "apply_patch", parameters: { type: "object", properties: {} } };
  const namespaced = { type: "namespace", name: "plugin", tools: [{ ...ordinary }] };
  const bridge = setup([native, ordinary, namespaced], [], { type: "allowed_tools", tools: [{ type: "custom", name: "apply_patch" }, { type: "function", name: "apply_patch" }] });
  assert.notEqual(bridge.name, "apply_patch");
  assert.deepEqual(bridge.tools.find(x => x.name === "apply_patch"), ordinary);
  assert.equal(bridge.toolChoice.tools[0].name, bridge.name);
  assert.equal(bridge.toolChoice.tools[1].name, "apply_patch");
  const result = await relay(bridge, events(bridge.name, args, { deltas: false }));
  assert.ifError(result.error);
  const close = parsed(result.output).find(x => x.type === "response.output_item.done").item;
  assert.equal(close.name, "apply_patch");
  assert.equal(close.type, "custom_tool_call");
  assert.equal(close.call_id, "call_patch");
});

test("history or forced choice without declared native tool does not enable codec", () => {
  const bridge = setup([], [{ type: "custom_tool_call", name: "apply_patch", call_id: "old", input: "raw" }], { type: "custom", name: "apply_patch" });
  assert.equal(bridge.lookups.customCodecs.size, 0);
  assert.equal(bridge.name, undefined);
});

test("one-byte SSE and argument fragmentation restores one complete native input", async () => {
  const bridge = setup();
  const bytes = Buffer.from(events(bridge.name).join(""));
  const result = await relay(bridge, Array.from(bytes, value => Buffer.from([value])));
  assert.ifError(result.error);
  const output = parsed(result.output);
  assert.equal(output.filter(x => x.type === "response.custom_tool_call_input.delta").length, 0);
  assert.equal(output.filter(x => x.type === "response.custom_tool_call_input.done").length, 1);
  assert.equal(output.find(x => x.type === "response.custom_tool_call_input.done").input, patch);
  assert.equal(output.find(x => x.type === "response.output_item.done").item.input, patch);
  assert.equal(output.at(-1).response.output[0].input, patch);
});

test("close-only, terminal-only and JSON responses preserve atomic compiled calls", async () => {
  for (const mode of ["close", "terminal", "json", "no-arguments-done"]) {
    const bridge = setup();
    const call = item(bridge.name);
    const parts = mode === "close" ? [frame("response.output_item.done", { item: call })]
      : mode === "terminal" ? [frame("response.completed", { response: { output: [call] } })]
      : mode === "json" ? [JSON.stringify({ output: [call] })]
      : events(bridge.name, args, { done: false });
    const result = await relay(bridge, parts, mode === "json" ? "application/json" : "text/event-stream");
    assert.ifError(result.error);
    assert.ok(result.output.includes(JSON.stringify(patch)), mode);
    assert.ok(result.output.includes('"custom_tool_call"'), mode);
  }
});

test("invalid structured inputs reject before any raw function call can pass through", async () => {
  for (const bad of ['{"operations":[]}', '{"input":"*** Begin Patch\\n*** Delete File: hello.txt\\n*** End Patch"}', '{"operations":[],"operations":[]}', '*** Begin Patch\n*** Delete File: hello.txt\n*** End Patch']) {
    for (const mode of ["stream", "atomic", "json"]) {
      const bridge = setup();
      const parts = mode === "stream" ? events(bridge.name, bad, { deltas: false })
        : mode === "atomic" ? [frame("response.output_item.done", { item: item(bridge.name, bad) })]
        : [JSON.stringify({ output: [item(bridge.name, bad)] })];
      const result = await relay(bridge, parts, mode === "json" ? "application/json" : "text/event-stream");
      assert.equal(result.error?.code, "ERR_NAMESPACE_RELAY_COMMITTED_STREAM", `${mode}: ${bad}`);
      assert.equal(result.output.includes('"type":"function_call"'), false);
      assert.equal(result.output.includes('"type":"response.output_item.done"'), false);
    }
  }
});

test("raw custom input cannot bypass an enabled structured codec", async () => {
  const bridge = setup();
  const call = { type: "custom_tool_call", name: "apply_patch", id: "bypass", call_id: "bypass", input: patch };
  for (const parts of [[frame("response.output_item.added", { item: call })], [frame("response.output_item.done", { item: call })], [frame("response.completed", { response: { output: [call] } })]]) {
    const result = await relay(bridge, parts);
    assert.ok(result.error);
    assert.equal(result.output, "");
  }
});

test("a raw custom call cannot bypass the codec under an undeclared namespace", async () => {
  const bridge = setup();
  const call = { type: "custom_tool_call", namespace: "functions", name: "apply_patch", id: "bypass_ns", call_id: "bypass_ns", input: patch };
  for (const parts of [[frame("response.output_item.added", { item: call })], [frame("response.output_item.done", { item: call })], [frame("response.completed", { response: { output: [call] } })]]) {
    const result = await relay(bridge, parts);
    assert.ok(result.error, JSON.stringify(parts));
    assert.equal(result.output, "");
  }
});

test("delta, done, close and terminal disagreement fail closed", async () => {
  const changed = JSON.stringify({ operations: [{ op: "delete", path: "hello.txt" }] });
  for (const stage of ["delta", "close", "terminal", "duplicate-close", "orphan-delta"]) {
    const bridge = setup();
    let parts = events(bridge.name, args, { deltas: false });
    if (stage === "delta") parts.splice(1, 0, frame("response.function_call_arguments.delta", { item_id: "fc_patch", delta: changed }));
    if (stage === "close") parts[2] = frame("response.output_item.done", { item: item(bridge.name, changed) });
    if (stage === "terminal") parts[3] = frame("response.completed", { response: { output: [item(bridge.name, changed)] } });
    if (stage === "duplicate-close") parts.splice(3, 0, parts[2]);
    if (stage === "orphan-delta") parts = [frame("response.function_call_arguments.delta", { item_id: "absent", delta: args })];
    const result = await relay(bridge, parts);
    assert.equal(result.error?.code, "ERR_NAMESPACE_RELAY_COMMITTED_STREAM", stage);
  }
});

test("codec-enabled malformed/oversized framing never uses legacy fail-open", async () => {
  for (const [body, type, options] of [
    ['{"output":[],"output":[]}', "application/json", {}],
    ["x".repeat(100), "application/json", { maxJsonCaptureBytes: 16 }],
    ["data: {broken}\n\n", "text/event-stream", {}],
    [frame("response.created", { response: { id: "x".repeat(100) } }), "text/event-stream", { maxSseFrameBytes: 32 }],
  ]) {
    const result = await relay(setup(), [body], type, options);
    assert.ok(result.error);
    assert.equal(result.output, "");
  }
});


test("invalid argument done reports a safe compiler category without committing an edit", async () => {
  const line = { kind: "add", text: "PRIVATE_SOURCE_TEXT" };
  for (const [hunks, code] of [
    [[{ anchor: "", lines: [line] }], "empty_anchor"],
    [[{ lines: [{ ...line, text: "PRIVATE_SOURCE_TEXT\n" }] }], "embedded_line_separator"],
    [[{ lines: [{ ...line, kind: "context" }] }], "no_change"],
    [[{ endOfFile: true, lines: [line] }, { lines: [line] }], "nonfinal_eof"],
  ]) {
    const bridge = setup();
    const value = JSON.stringify({ operations: [{ op: "update", path: "private-name.txt", hunks }] });
    const result = await relay(bridge, events(bridge.name, value));
    assert.equal(result.error?.code, "ERR_NAMESPACE_RELAY_COMMITTED_STREAM");
    assert.ok(result.error.message.includes(`invalid custom tool arguments done: ${code}`));
    assert.doesNotMatch(result.error.message, /PRIVATE_SOURCE_TEXT|private-name/);
    assert.doesNotMatch(result.output, /response.custom_tool_call_input.done|response.output_item.done|PRIVATE_SOURCE_TEXT|private-name/);
  }
  const bridge = setup();
  const valid = JSON.stringify({ operations: [{ op: "update", path: "x", hunks: [{ lines: [line] }] }] });
  const result = await relay(bridge, events(bridge.name, valid));
  assert.ifError(result.error);
  assert.equal(parsed(result.output).filter(x => x.type === "response.custom_tool_call_input.done").length, 1);
});


test("JSON and separator categories survive streaming without exposing or committing invalid edits", async () => {
  const privateText = "PRIVATE_SOURCE_TEXT";
  for (const [value, code] of [
    ["", "arguments_empty_json"],
    [JSON.stringify({ operations: "" }), "operations_empty_json"],
    [JSON.stringify({ operations: '[{"op":' }), "operations_invalid_json"],
    [JSON.stringify({ operations: '[{"op":"delete","op":"add","path":"PRIVATE_SOURCE_TEXT"}]' }), "operations_ambiguous_json"],
    [JSON.stringify({ operations: [{ op: "delete", path: `${privateText}\n` }] }), "embedded_path_separator"],
    [JSON.stringify({ operations: [{ op: "update", path: "x", hunks: [{ anchor: `${privateText}\n`, lines: [{ kind: "add", text: "x" }] }] }] }), "embedded_anchor_separator"],
  ]) {
    const bridge = setup();
    const result = await relay(bridge, events(bridge.name, value));
    assert.equal(result.error?.code, "ERR_NAMESPACE_RELAY_COMMITTED_STREAM");
    assert.ok(result.error.message.includes(`invalid custom tool arguments done: ${code}`));
    assert.doesNotMatch(result.error.message, /PRIVATE_SOURCE_TEXT/);
    assert.doesNotMatch(result.output, /response.custom_tool_call_input.done|response.output_item.done|PRIVATE_SOURCE_TEXT/);
  }
});
