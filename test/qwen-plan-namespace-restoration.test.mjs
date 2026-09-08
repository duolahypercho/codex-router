import assert from "node:assert/strict";
import test from "node:test";

import {
  buildNamespaceLookupsFromTools,
  createResponsesStreamTransform,
  createResponsesJsonTransform,
} from "../src/openai-adapters.mjs";

// Test the namespace restoration for Qwen Plan collaboration tools
// Issue #568: Qwen Plan returns flattened names like "multi_agent_v1__spawn_agent"
// which Codex Desktop rejects. They need to be restored to namespaced format
// { namespace: "multi_agent_v1", name: "spawn_agent" }

test("buildNamespaceLookupsFromTools extracts flattened collaboration tool names", () => {
  const tools = [
    {
      type: "function",
      name: "multi_agent_v1__spawn_agent",
      description: "Spawn a new agent",
      parameters: {
        type: "object",
        properties: {
          task: { type: "string" },
        },
      },
    },
    {
      type: "function",
      name: "multi_agent_v1__update_agent",
      description: "Update an agent",
      parameters: {
        type: "object",
        properties: {
          agent_id: { type: "string" },
        },
      },
    },
    {
      type: "function",
      name: "regular_function",
      description: "A regular function without namespace",
      parameters: {
        type: "object",
        properties: {},
      },
    },
  ];

  const lookups = buildNamespaceLookupsFromTools(tools);

  // Should extract the two collaboration tools
  assert.equal(lookups.size, 2);

  // Check spawn_agent mapping
  const spawnAgent = lookups.get("multi_agent_v1__spawn_agent");
  assert.ok(spawnAgent, "spawn_agent should be in lookups");
  assert.equal(spawnAgent.namespace, "multi_agent_v1");
  assert.equal(spawnAgent.name, "spawn_agent");

  // Check update_agent mapping
  const updateAgent = lookups.get("multi_agent_v1__update_agent");
  assert.ok(updateAgent, "update_agent should be in lookups");
  assert.equal(updateAgent.namespace, "multi_agent_v1");
  assert.equal(updateAgent.name, "update_agent");

  // Regular function should not be in lookups
  assert.equal(lookups.get("regular_function"), undefined);
});

test("buildNamespaceLookupsFromTools handles Chat Completions format", () => {
  const tools = [
    {
      type: "function",
      function: {
        name: "multi_agent_v1__spawn_agent",
        description: "Spawn a new agent",
        parameters: {
          type: "object",
          properties: {
            task: { type: "string" },
          },
        },
      },
    },
  ];

  const lookups = buildNamespaceLookupsFromTools(tools);

  assert.equal(lookups.size, 1);
  const spawnAgent = lookups.get("multi_agent_v1__spawn_agent");
  assert.equal(spawnAgent.namespace, "multi_agent_v1");
  assert.equal(spawnAgent.name, "spawn_agent");
});

test("buildNamespaceLookupsFromTools handles namespace tools with nested names", () => {
  // When a tool comes from a type: "namespace" entry with a nested name,
  // it should be restored correctly
  const tools = [
    {
      type: "namespace",
      name: "mcp__node_repl",
      tools: [
        {
          type: "function",
          name: "execute",
          description: "Execute code",
          parameters: {
            type: "object",
            properties: {},
          },
        },
      ],
    },
    {
      type: "function",
      name: "mcp__node_repl__execute",
      description: "Execute code (flattened)",
      parameters: {
        type: "object",
        properties: {},
      },
    },
  ];

  const lookups = buildNamespaceLookupsFromTools(tools);

  // Flat __ join plus dotted inventory alias (#611).
  assert.equal(lookups.size, 2);
  const execute = lookups.get("mcp__node_repl__execute");
  assert.ok(execute, "Should restore tool from namespace entry");
  // Namespace preserves the full nested name
  assert.equal(execute.namespace, "mcp__node_repl");
  assert.equal(execute.name, "execute");
  assert.equal(lookups.get("mcp__node_repl.execute"), execute);
});

test("createResponsesStreamTransform restores namespaced function calls", async () => {
  const tools = [
    {
      type: "function",
      name: "multi_agent_v1__spawn_agent",
      description: "Spawn a new agent",
      parameters: {
        type: "object",
        properties: {
          task: { type: "string" },
        },
      },
    },
  ];

  const lookups = buildNamespaceLookupsFromTools(tools);
  const transform = createResponsesStreamTransform(lookups);

  // Simulate a Responses SSE stream with a flattened function call
  const sseInput = `event: response.output_item.added
data: {"type":"response.output_item.added","output_index":0,"item":{"type":"function_call","id":"call_123","name":"multi_agent_v1__spawn_agent","arguments":"{\\"task\\":\\"test\\"}","call_id":"call_123"}}

event: response.completed
data: {"type":"response.completed","response":{"id":"resp_123","output":[]}}

data: [DONE]

`;

  const chunks = [];
  transform.on("data", (chunk) => {
    chunks.push(chunk.toString("utf8"));
  });

  await new Promise((resolve, reject) => {
    transform.on("end", resolve);
    transform.on("error", reject);
    transform.write(sseInput);
    transform.end();
  });

  const output = chunks.join("");

  // The output should contain the restored namespace
  assert.ok(output.includes('"namespace":"multi_agent_v1"'), "Should restore namespace field");
  assert.ok(output.includes('"name":"spawn_agent"'), "Should restore name field");
  
  // Parse the SSE output to verify the structure
  const lines = output.split("\n");
  let outputItemData = null;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith("event: response.output_item.added")) {
      // Next line should be the data
      if (i + 1 < lines.length && lines[i + 1].startsWith("data: ")) {
        const dataLine = lines[i + 1].substring("data: ".length);
        outputItemData = JSON.parse(dataLine);
        break;
      }
    }
  }
  
  assert.ok(outputItemData, "Should find output_item.added event data");
  assert.equal(outputItemData.item.namespace, "multi_agent_v1");
  assert.equal(outputItemData.item.name, "spawn_agent");
});

test("createResponsesJsonTransform restores namespaced function calls", async () => {
  const tools = [
    {
      type: "function",
      name: "multi_agent_v1__spawn_agent",
      description: "Spawn a new agent",
      parameters: {
        type: "object",
        properties: {
          task: { type: "string" },
        },
      },
    },
  ];

  const lookups = buildNamespaceLookupsFromTools(tools);
  const transform = createResponsesJsonTransform(lookups);

  // Simulate a Responses JSON response with flattened function calls
  const jsonInput = JSON.stringify({
    id: "resp_123",
    output: [
      {
        type: "function_call",
        id: "call_123",
        name: "multi_agent_v1__spawn_agent",
        arguments: '{"task":"test"}',
        call_id: "call_123",
      },
    ],
  });

  const chunks = [];
  transform.on("data", (chunk) => {
    chunks.push(chunk.toString("utf8"));
  });

  await new Promise((resolve, reject) => {
    transform.on("end", resolve);
    transform.on("error", reject);
    transform.write(jsonInput);
    transform.end();
  });

  const output = JSON.parse(chunks.join(""));

  // The output should have the namespace restored
  assert.equal(output.output[0].namespace, "multi_agent_v1");
  assert.equal(output.output[0].name, "spawn_agent");
  assert.equal(output.output[0].arguments, '{"task":"test"}');
});

test("transforms preserve non-flattened function calls", async () => {
  const tools = [
    {
      type: "function",
      name: "regular_function",
      description: "A regular function",
      parameters: {
        type: "object",
        properties: {},
      },
    },
  ];

  const lookups = buildNamespaceLookupsFromTools(tools);
  const transform = createResponsesJsonTransform(lookups);

  const jsonInput = JSON.stringify({
    id: "resp_123",
    output: [
      {
        type: "function_call",
        id: "call_123",
        name: "regular_function",
        arguments: "{}",
        call_id: "call_123",
      },
    ],
  });

  const chunks = [];
  transform.on("data", (chunk) => {
    chunks.push(chunk.toString("utf8"));
  });

  await new Promise((resolve, reject) => {
    transform.on("end", resolve);
    transform.on("error", reject);
    transform.write(jsonInput);
    transform.end();
  });

  const output = JSON.parse(chunks.join(""));

  // Regular function should remain unchanged
  assert.equal(output.output[0].name, "regular_function");
  assert.equal(output.output[0].namespace, undefined);
});

test("transforms work with empty lookups", async () => {
  // When no flattened tools are present, transforms should work normally
  const transform = createResponsesJsonTransform(new Map());

  const jsonInput = JSON.stringify({
    id: "resp_123",
    output: [
      {
        type: "function_call",
        id: "call_123",
        name: "some_function",
        arguments: "{}",
        call_id: "call_123",
      },
    ],
  });

  const chunks = [];
  transform.on("data", (chunk) => {
    chunks.push(chunk.toString("utf8"));
  });

  await new Promise((resolve, reject) => {
    transform.on("end", resolve);
    transform.on("error", reject);
    transform.write(jsonInput);
    transform.end();
  });

  const output = JSON.parse(chunks.join(""));

  // Function should remain unchanged
  assert.equal(output.output[0].name, "some_function");
  assert.equal(output.output[0].namespace, undefined);
});

test("buildNamespaceLookupsFromTools ignores MCP-style names without namespace tools", () => {
  // MCP tools like "mcp__node_repl__js" should NOT be restored unless they
  // came from an actual type: "namespace" entry in the request
  const tools = [
    {
      type: "function",
      name: "mcp__node_repl__js",
      description: "Execute JavaScript",
      parameters: {
        type: "object",
        properties: {},
      },
    },
    {
      type: "function",
      name: "some__other__tool",
      description: "Some tool with delimiters",
      parameters: {
        type: "object",
        properties: {},
      },
    },
  ];

  const lookups = buildNamespaceLookupsFromTools(tools);

  // Should be empty because "mcp" and "some" are not known collaboration namespaces
  // and there are no type: "namespace" entries
  assert.equal(lookups.size, 0);
  assert.equal(lookups.get("mcp__node_repl__js"), undefined);
  assert.equal(lookups.get("some__other__tool"), undefined);
});

test("buildNamespaceLookupsFromTools restores tools from namespace entries", () => {
  // When tools come from actual type: "namespace" entries, they should be restored
  const tools = [
    {
      type: "namespace",
      name: "mcp__node_repl",
      tools: [
        {
          type: "function",
          name: "execute",
          description: "Execute code",
          parameters: {
            type: "object",
            properties: {},
          },
        },
      ],
    },
    {
      type: "function",
      name: "mcp__node_repl__execute",
      description: "Execute code",
      parameters: {
        type: "object",
        properties: {},
      },
    },
  ];

  const lookups = buildNamespaceLookupsFromTools(tools);

  // Should restore the tool that came from a namespace entry, plus dotted alias
  assert.equal(lookups.size, 2);
  const restored = lookups.get("mcp__node_repl__execute");
  assert.ok(restored, "Should restore tool from namespace entry");
  assert.equal(restored.namespace, "mcp__node_repl");
  assert.equal(restored.name, "execute");
  assert.equal(lookups.get("mcp__node_repl.execute"), restored);
});

test("MCP-style names are left unchanged in responses without namespace tools", async () => {
  // Verify that MCP-style function calls are NOT restored unless they came from namespace tools
  const tools = [
    {
      type: "function",
      name: "mcp__node_repl__js",
      description: "Execute JavaScript",
      parameters: {
        type: "object",
        properties: {},
      },
    },
  ];

  const lookups = buildNamespaceLookupsFromTools(tools);
  const transform = createResponsesJsonTransform(lookups);

  const jsonInput = JSON.stringify({
    id: "resp_123",
    output: [
      {
        type: "function_call",
        id: "call_123",
        name: "mcp__node_repl__js",
        arguments: '{"code":"console.log()"}',
        call_id: "call_123",
      },
    ],
  });

  const chunks = [];
  transform.on("data", (chunk) => {
    chunks.push(chunk.toString("utf8"));
  });

  await new Promise((resolve, reject) => {
    transform.on("end", resolve);
    transform.on("error", reject);
    transform.write(jsonInput);
    transform.end();
  });

  const output = JSON.parse(chunks.join(""));

  // MCP-style name should remain unchanged
  assert.equal(output.output[0].name, "mcp__node_repl__js");
  assert.equal(output.output[0].namespace, undefined);
});
