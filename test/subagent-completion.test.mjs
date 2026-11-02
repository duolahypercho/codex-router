import assert from "node:assert/strict";
import { Readable } from "node:stream";
import test from "node:test";
import { subagentToolAvailable } from "../src/subagent-completion.mjs";
import { NamespaceToolCallTransform, flattenNamespaceTools } from "../src/namespace-relay.mjs";

// Old inferred-close options have no authority to add a lifecycle call.
const collect = async (body, type, namespaces) => {
  const chunks = [];
  for await (const chunk of Readable.from([body]).pipe(new NamespaceToolCallTransform(namespaces, type, undefined, { pendingInterrupts: ["/root/reviewer"] }))) chunks.push(chunk);
  return Buffer.concat(chunks).toString();
};

test("native tool availability still constrains failover without inferred child state", () => {
  for (const namespace of ["collaboration", "agents"]) {
    assert.equal(subagentToolAvailable(new Map([[namespace, new Set(["interrupt_agent"])]])), true);
  }
  assert.equal(subagentToolAvailable(new Map([["mcp__files", new Set(["interrupt_agent"])]])), false);
  assert.equal(subagentToolAvailable(new Map([["collaboration", new Set(["spawn_agent"])]])), false);
});

test("a model-authored follow-up is relayed without a router-authored interrupt", async () => {
  const { namespaces } = flattenNamespaceTools([{ type: "namespace", name: "collaboration", tools: [
    { type: "function", name: "followup_task" }, { type: "function", name: "interrupt_agent" },
  ] }]);
  const call = { type: "function_call", name: "collaboration__followup_task", call_id: "call_follow",
    arguments: JSON.stringify({ target: "/root/reviewer", message: "continue" }) };
  const output = JSON.parse(await collect(JSON.stringify({ output: [call] }), "application/json", namespaces));
  assert.equal(output.output.length, 1);
  assert.equal(output.output[0].name, "followup_task");
  assert.equal(output.output[0].namespace, "collaboration");
});

test("terminal-only streams and JSON acquire no lifecycle side effects", async () => {
  const namespaces = new Map([["collaboration", new Set(["interrupt_agent"])]]);
  for (const source of ['data: {"type":"response.completed","response":{"output":[]}}\n\n', 'data: [DONE]\n\n']) {
    assert.equal(await collect(source, "text/event-stream", namespaces), source);
  }
  const source = '{"output":[]}';
  assert.equal(await collect(source, "application/json", namespaces), source);
});

test("an explicit model-authored interrupt remains callable", async () => {
  const { namespaces } = flattenNamespaceTools([{ type: "namespace", name: "agents", tools: [
    { type: "function", name: "interrupt_agent" },
  ] }]);
  const source = { output: [{ type: "function_call", name: "agents__interrupt_agent", call_id: "call_stop", arguments: '{"target":"/root/reviewer"}' }] };
  const output = JSON.parse(await collect(JSON.stringify(source), "application/json", namespaces));
  assert.equal(output.output.length, 1);
  assert.equal(output.output[0].name, "interrupt_agent");
  assert.equal(output.output[0].namespace, "agents");
});
