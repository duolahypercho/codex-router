import assert from "node:assert/strict";
import { Readable } from "node:stream";
import test from "node:test";

import {
  NamespaceToolCallTransform,
  flattenNamespaceHistory,
  flattenNamespaceTools,
} from "../src/namespace-tools.mjs";

function collect(stream) {
  return new Promise((resolve, reject) => {
    let output = "";
    stream.on("data", (chunk) => {
      output += chunk.toString("utf8");
    });
    stream.on("end", () => resolve(output));
    stream.on("error", reject);
  });
}

function sse(events) {
  return events.map((event) => `data: ${JSON.stringify(event)}\n\n`);
}

test("flatten collaboration namespace into plain function tools", () => {
  const { tools, flattened } = flattenNamespaceTools([
    { type: "function", name: "exec_command" },
    {
      type: "namespace",
      name: "collaboration",
      tools: [
        { type: "function", name: "spawn_agent" },
        { type: "function", name: "wait_agent" },
      ],
    },
  ]);
  assert.equal(flattened, true);
  assert.deepEqual(
    tools.map((tool) => tool.name),
    ["exec_command", "collaboration__spawn_agent", "collaboration__wait_agent"],
  );
});

// The bug this module exists for: every namespace Codex sends is dropped by
// LiteLLM's chat-completions bridge, not just the collaboration one, so an MCP
// server's tools reached no routed model at all.
test("MCP and plugin namespaces are flattened too, keeping their schemas", () => {
  const { tools, flattened } = flattenNamespaceTools([
    {
      type: "namespace",
      name: "mcp__node_repl",
      tools: [
        {
          type: "function",
          name: "js",
          description: "Run JavaScript",
          parameters: { type: "object", properties: { code: { type: "string" } } },
        },
      ],
    },
    {
      type: "namespace",
      name: "browser",
      tools: [{ type: "function", name: "navigate" }],
    },
  ]);
  assert.equal(flattened, true);
  assert.deepEqual(
    tools.map((tool) => tool.name),
    ["mcp__node_repl__js", "browser__navigate"],
  );
  assert.equal(tools[0].description, "Run JavaScript");
  assert.deepEqual(tools[0].parameters, {
    type: "object",
    properties: { code: { type: "string" } },
  });
  // A namespace tool must not survive as a namespace: LiteLLM drops that type.
  assert.ok(tools.every((tool) => tool.type !== "namespace"));
});

test("a tool list without namespaces is returned untouched", () => {
  const original = [{ type: "function", name: "exec_command" }];
  const { tools, flattened, map } = flattenNamespaceTools(original);
  assert.equal(flattened, false);
  assert.equal(map, undefined);
  assert.equal(tools, original);
});

test("a flattened name too long for a provider is truncated and still restored", async () => {
  const namespace = `mcp__${"server".repeat(8)}`;
  const name = `${"tool".repeat(6)}_call`;
  const { tools, map } = flattenNamespaceTools([
    { type: "namespace", name: namespace, tools: [{ type: "function", name }] },
  ]);
  const flat = tools[0].name;
  assert.ok(flat.length <= 64, `${flat.length} exceeds the provider name limit`);
  assert.deepEqual(map.restore(flat), { namespace, name });
  // The same tool flattens to the same name on the next turn, or the stored
  // history stops matching the tool list.
  const again = flattenNamespaceTools([
    { type: "namespace", name: namespace, tools: [{ type: "function", name }] },
  ]);
  assert.equal(again.tools[0].name, flat);
});

test("namespace response transform restores namespace function calls", async () => {
  const { map } = flattenNamespaceTools([
    {
      type: "namespace",
      name: "collaboration",
      tools: [{ type: "function", name: "spawn_agent" }],
    },
  ]);
  const events = sse([
    { type: "response.created" },
    {
      type: "response.output_item.added",
      item: { type: "function_call", name: "collaboration__spawn_agent", call_id: "call_1" },
    },
    {
      type: "response.output_item.done",
      item: {
        type: "function_call",
        name: "collaboration__spawn_agent",
        call_id: "call_1",
        arguments: "{}",
      },
    },
  ]);
  const transform = new NamespaceToolCallTransform(map);
  const output = await collect(Readable.from(events).pipe(transform));
  assert.match(output, /"name":"spawn_agent"/);
  assert.match(output, /"namespace":"collaboration"/);
  assert.doesNotMatch(output, /collaboration__spawn_agent/);
});

test("an MCP tool call is restored to the namespace Codex dispatches on", async () => {
  const { map } = flattenNamespaceTools([
    {
      type: "namespace",
      name: "mcp__node_repl",
      tools: [{ type: "function", name: "js" }],
    },
  ]);
  const events = sse([
    {
      type: "response.output_item.done",
      item: {
        type: "function_call",
        name: "mcp__node_repl__js",
        call_id: "call_js",
        arguments: '{"code":"1+1"}',
      },
    },
  ]);
  const transform = new NamespaceToolCallTransform(map);
  const output = await collect(Readable.from(events).pipe(transform));
  assert.match(output, /"name":"js"/);
  assert.match(output, /"namespace":"mcp__node_repl"/);
  assert.match(output, /"arguments":"\{\\"code\\":\\"1\+1\\"\}"/);
  assert.match(output, /"call_id":"call_js"/);
});

test("stored namespace calls are renamed to match the flattened tools", () => {
  const { map } = flattenNamespaceTools([
    {
      type: "namespace",
      name: "collaboration",
      tools: [{ type: "function", name: "spawn_agent" }],
    },
    { type: "namespace", name: "mcp__node_repl", tools: [{ type: "function", name: "js" }] },
  ]);
  const input = flattenNamespaceHistory(
    [
      { type: "message", role: "user", content: [] },
      { type: "function_call", name: "exec_command", call_id: "call_0" },
      {
        type: "function_call",
        name: "spawn_agent",
        namespace: "collaboration",
        call_id: "call_1",
        arguments: "{}",
      },
      { type: "function_call_output", call_id: "call_1", output: "{}" },
      { type: "function_call", name: "js", namespace: "mcp__node_repl", call_id: "call_2" },
    ],
    map,
  );
  const call = input[2];
  assert.equal(call.name, "collaboration__spawn_agent");
  assert.equal(call.namespace, undefined);
  assert.equal(call.call_id, "call_1");
  assert.equal(call.arguments, "{}");
  assert.equal(input[4].name, "mcp__node_repl__js");
  assert.equal(input[4].namespace, undefined);
  // Unrelated items keep their identity so replay stays byte-comparable.
  assert.equal(input[1].name, "exec_command");
  assert.deepEqual(input[3], { type: "function_call_output", call_id: "call_1", output: "{}" });
});

test("namespace history rename is idempotent and leaves plain calls alone", () => {
  const { map } = flattenNamespaceTools([
    {
      type: "namespace",
      name: "collaboration",
      tools: [{ type: "function", name: "wait_agent" }],
    },
  ]);
  const alreadyFlat = {
    type: "function_call",
    name: "collaboration__wait_agent",
    call_id: "call_2",
  };
  const plain = { type: "function_call", name: "exec_command", call_id: "call_3" };
  const input = flattenNamespaceHistory([alreadyFlat, plain], map);
  assert.deepEqual(input[0], alreadyFlat);
  assert.deepEqual(input[1], plain);
});

test("namespace response transform restores collaboration on unprefixed calls", async () => {
  const { map } = flattenNamespaceTools([
    {
      type: "namespace",
      name: "collaboration",
      tools: [{ type: "function", name: "wait_agent" }],
    },
  ]);
  const events = sse([
    {
      type: "response.output_item.added",
      item: { type: "function_call", name: "spawn_agent", call_id: "call_plain" },
    },
    {
      type: "response.output_item.done",
      item: { type: "function_call", name: "spawn_agent", call_id: "call_plain", arguments: "{}" },
    },
  ]);
  const transform = new NamespaceToolCallTransform(map);
  const output = await collect(Readable.from(events).pipe(transform));
  assert.match(output, /"name":"spawn_agent"/);
  assert.match(output, /"namespace":"collaboration"/);
});

test("namespace response transform leaves ordinary function calls alone", async () => {
  const { map } = flattenNamespaceTools([
    {
      type: "namespace",
      name: "collaboration",
      tools: [{ type: "function", name: "spawn_agent" }],
    },
  ]);
  const events = sse([
    {
      type: "response.output_item.done",
      item: { type: "function_call", name: "exec_command", call_id: "call_exec", arguments: "{}" },
    },
  ]);
  const transform = new NamespaceToolCallTransform(map);
  const output = await collect(Readable.from(events).pipe(transform));
  assert.match(output, /"name":"exec_command"/);
  assert.doesNotMatch(output, /"namespace"/);
});

// Two namespaces exposing the same bare tool name cannot be attributed, and
// guessing would dispatch the call to the wrong server.
test("an ambiguous bare tool name is left for Codex to reject", async () => {
  const { map } = flattenNamespaceTools([
    { type: "namespace", name: "mcp__alpha", tools: [{ type: "function", name: "run" }] },
    { type: "namespace", name: "mcp__beta", tools: [{ type: "function", name: "run" }] },
  ]);
  assert.equal(map.namespaceForBareName("run"), undefined);
  const events = sse([
    {
      type: "response.output_item.done",
      item: { type: "function_call", name: "run", call_id: "call_ambiguous" },
    },
  ]);
  const output = await collect(Readable.from(events).pipe(new NamespaceToolCallTransform(map)));
  assert.doesNotMatch(output, /"namespace"/);
});

test("a bare tool name offered by one namespace is recovered", async () => {
  const { map } = flattenNamespaceTools([
    { type: "namespace", name: "mcp__node_repl", tools: [{ type: "function", name: "js" }] },
  ]);
  const events = sse([
    {
      type: "response.output_item.done",
      item: { type: "function_call", name: "js", call_id: "call_bare" },
    },
  ]);
  const output = await collect(Readable.from(events).pipe(new NamespaceToolCallTransform(map)));
  assert.match(output, /"namespace":"mcp__node_repl"/);
});
