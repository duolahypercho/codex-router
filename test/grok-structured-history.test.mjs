import assert from "node:assert/strict";
import { Readable } from "node:stream";
import test from "node:test";
import {
  NamespaceToolCallTransform, bridgeCustomTools, buildNamespaceLookups,
  flattenNamespaceTools, flattenToolChoice, flattenToolSearchHistory,
  rewriteNamespaceResponsePayload,
} from "../src/namespace-relay.mjs";
import { GROK_STRUCTURED_PATCH_CODEC, serializeStructuredPatch } from "../src/grok-structured-patch.mjs";
import { GROK_PATCH_HOOK_CODEC, GROK_PATCH_HOOK_PREFIX } from "../src/grok-patch-hook-transport.mjs";

const PATCH = "*** Begin Patch\n*** Update File: before.txt\n*** Move to: after.txt\n@@\n-before\n+after\n*** End Patch\n";
const native = { type: "custom", name: "apply_patch", description: "Use raw patch text. Ask permission before editing protected files." };
const prior = (input = PATCH) => [
  { type: "custom_tool_call", id: "ctc_old", call_id: "old-call", name: "apply_patch", input },
  { type: "custom_tool_call_output", call_id: "old-call", output: "Permission denied; no files changed." },
];
function setup({ tools = [native], input = prior(), codec = GROK_STRUCTURED_PATCH_CODEC, maxNameLength = 64 } = {}) {
  const flat = flattenNamespaceTools(tools, { maxNameLength, aliasCollisions: true });
  const bridged = bridgeCustomTools(flat.tools, input, flat.namespaces,
    { type: "custom", name: "apply_patch" }, ["apply_patch"],
    { maxNameLength, codecs: new Map([["apply_patch", codec]]) });
  return { ...bridged, namespaces: flat.namespaces, lookups: buildNamespaceLookups(flat.namespaces) };
}
const currentTool = (result) => result.tools.find((tool) => tool.parameters?.properties?.operations);
const historyCall = (result) => result.input.find((item) => item.call_id === "old-call" && item.type === "function_call");
const event = (name, argumentsText = "{}", extra = {}) => ({ type: "response.output_item.done", item: {
  type: "function_call", id: "fc_new", call_id: "new-call", name, arguments: argumentsText, ...extra,
} });
async function relaySse(result, events) {
  let output = "";
  const transform = new NamespaceToolCallTransform(result.namespaces, "text/event-stream", "grok-oauth/grok-4.7");
  transform.on("data", chunk => { output += chunk; });
  const completion = new Promise((resolve, reject) => {
    transform.on("end", resolve); transform.on("error", reject);
  });
  Readable.from([events.map(item => `data: ${JSON.stringify(item)}\n\n`).join("")]).pipe(transform);
  await completion;
  return output;
}

test("native patch history retains exact bytes and denied result under a separate non-advertised identity", () => {
  const result = setup();
  const current = currentTool(result);
  assert.equal(current.name, "apply_patch_structured_v1");
  assert.equal(historyCall(result).name, "apply_patch_history_v1");
  assert.equal(historyCall(result).arguments, JSON.stringify({ input: PATCH }));
  assert.equal(historyCall(result).id, undefined);
  assert.deepEqual(result.input[1], { type: "function_call_output", call_id: "old-call", output: prior()[1].output });
  assert.equal(result.tools.some(tool => tool.name === historyCall(result).name), false);
  assert.deepEqual(flattenToolChoice(result.toolChoice, result.namespaces), { type: "function", name: current.name });
});

test("ordinary functions cannot collide with current or historical patch identities", () => {
  const ordinary = ["apply_patch_structured_v1", "apply_patch_history_v1"].map(name => ({ type: "function", name, parameters: { type: "object" } }));
  const result = setup({ tools: [native, ...ordinary] });
  assert.notEqual(currentTool(result).name, ordinary[0].name);
  assert.notEqual(historyCall(result).name, ordinary[1].name);
  assert.notEqual(currentTool(result).name, historyCall(result).name);
  assert.equal(result.tools.filter(tool => ordinary.some(item => item.name === tool.name)).length, 2);
});

test("JSON response cannot invoke a history identity, including forged custom or namespace shapes", () => {
  const result = setup();
  for (const extra of [{}, { namespace: "functions" }, { type: "custom_tool_call", input: PATCH }]) {
    const item = event(historyCall(result).name, "{}", extra).item;
    for (const payload of [{ item }, { output: [item] }, { response: { output: [item] } }]) {
      assert.throws(() => rewriteNamespaceResponsePayload(payload, result.lookups), /historical tool identity is not callable/);
    }
  }
});

test("SSE rejects historical identity before releasing a tool invocation", async () => {
  const result = setup();
  await assert.rejects(relaySse(result, [event(historyCall(result).name)]), /historical tool identity is not callable/);
});

test("a current structured invocation after legacy history restores the native patch", () => {
  const result = setup();
  const operations = [{ op: "add", path: "new.txt", lines: ["hello"] }];
  const rewritten = rewriteNamespaceResponsePayload(event(currentTool(result).name, JSON.stringify({ operations })), result.lookups);
  assert.deepEqual(rewritten.item, { type: "custom_tool_call", id: "fc_new", call_id: "new-call", name: "apply_patch", input: serializeStructuredPatch({ operations }) });
});

test("bounded and namespaced collisions keep historical and executable identities distinct", () => {
  const tools = [native, { type: "namespace", name: "apply_patch_structured", tools: [{ type: "function", name: "v1", parameters: { type: "object" } }] }];
  const result = setup({ tools, maxNameLength: 16 });
  const names = result.tools.map(tool => tool.name);
  assert.equal(new Set(names).size, names.length);
  assert.ok(names.every(name => name.length <= 16));
  assert.ok(historyCall(result).name.length <= 16);
  assert.equal(names.includes(historyCall(result).name), false);
});

test("history without a current native declaration grants no executable patch relay", () => {
  const result = setup({ tools: [] });
  assert.equal(result.tools.length, 0);
  assert.equal(result.lookups.customTools.size, 0);
  assert.equal(result.lookups.customCodecs.size, 0);
  assert.throws(() => rewriteNamespaceResponsePayload(event(historyCall(result).name), result.lookups), /historical tool identity is not callable/);
});

test("structured description leads with its schema contract and quotes client permissions verbatim", () => {
  const description = currentTool(setup()).description;
  assert.ok(description.indexOf("structured operations") < description.indexOf("Client execution reference"));
  assert.ok(description.endsWith(JSON.stringify(native.description)));
});

test("negotiated hook history keeps its current identity and byte-exact provider arguments", () => {
  const raw = ' {"operations": [ ]} ';
  const result = setup({ codec: GROK_PATCH_HOOK_CODEC, input: prior(GROK_PATCH_HOOK_PREFIX + raw) });
  assert.equal(historyCall(result).name, currentTool(result).name);
  assert.equal(historyCall(result).arguments, raw);
});

test("a later discovered function named like historical patch history receives a callable distinct alias", () => {
  const result = setup({ tools: [native, { type: "tool_search", execution: "client" }] });
  const historical = historyCall(result).name;
  const discovered = flattenToolSearchHistory([
    ...result.input,
    { type: "tool_search_call", call_id: "search", execution: "client", arguments: { query: "find" } },
    { type: "tool_search_output", call_id: "search", execution: "client", status: "completed", tools: [{ type: "function", name: historical, parameters: { type: "object", properties: {} } }] },
  ], result.tools, result.namespaces);
  const ordinary = discovered.tools.find(tool => !result.tools.includes(tool));
  assert.ok(ordinary);
  assert.notEqual(ordinary.name, historical);
  const output = rewriteNamespaceResponsePayload(event(ordinary.name), buildNamespaceLookups(result.namespaces));
  assert.equal(output.item.name, historical);
  assert.throws(() => rewriteNamespaceResponsePayload(event(historical), buildNamespaceLookups(result.namespaces)), /historical tool identity is not callable/);
});
