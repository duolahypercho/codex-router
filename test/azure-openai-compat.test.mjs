import assert from "node:assert/strict";
import test from "node:test";

import { normalizeAzureOpenAIResponsesRequest } from "../src/azure-openai-compat.mjs";

test("azure-kmamc removes image_gen and aliases collaboration for its provider", () => {
  const imageGen = {
    type: "namespace",
    name: "image_gen",
    tools: [{
      type: "function",
      name: "imagegen",
      parameters: { type: "object" },
    }],
  };

  const collaboration = {
    type: "namespace",
    name: "collaboration",
    tools: [{
      type: "function",
      name: "spawn_agent",
      parameters: { type: "object" },
    }],
  };

  const shell = {
    type: "function",
    name: "shell",
    parameters: { type: "object" },
  };

  const payload = {
    tools: [
      imageGen,
      { type: "image_generation" },
      { type: "function", name: "image_gen.imagegen" },
      { type: "function", name: "image_gen__imagegen" },
      collaboration,
      shell,
    ],
  };

  const normalized = normalizeAzureOpenAIResponsesRequest(payload, {
    providerId: "azure-kmamc",
    route: "/responses",
  });

  assert.deepEqual(normalized.tools, [{ ...collaboration, name: "agents" }, shell]);
  assert.equal(payload.tools.length, 6);
});

test("other providers remain byte-shape untouched", () => {
  const payload = {
    tools: [{ type: "namespace", name: "image_gen", tools: [] }],
  };

  const normalized = normalizeAzureOpenAIResponsesRequest(payload, {
    providerId: "another-provider",
    route: "/responses",
  });

  assert.strictEqual(normalized, payload);
});

test("other Azure namespaces remain untouched", () => {
  const collaboration = {
    type: "namespace",
    name: "analytics",
    tools: [{ type: "function", name: "spawn_agent" }],
  };

  const payload = { tools: [collaboration] };

  const normalized = normalizeAzureOpenAIResponsesRequest(payload, {
    providerId: "azure-kmamc",
    route: "/responses",
  });

  assert.strictEqual(normalized, payload);
});

test("Azure collaboration alias preserves tool history and the caller's request", () => {
  const collaboration = {
    type: "namespace",
    name: "collaboration",
    tools: [
      { type: "function", name: "spawn_agent", parameters: {
        type: "object",
        properties: { message: { type: "string", encrypted: true } },
      } },
      { type: "function", name: "wait_agent", parameters: { type: "object" } },
    ],
  };
  const call = {
    type: "function_call",
    name: "spawn_agent",
    namespace: "collaboration",
    call_id: "call_1",
    arguments: '{"task_name":"probe","message":"hello"}',
  };
  const output = { type: "function_call_output", call_id: "call_1", output: "done" };
  const payload = {
    tools: [collaboration],
    input: [call, output],
    tool_choice: { type: "function", name: "spawn_agent", namespace: "collaboration" },
  };
  const normalized = normalizeAzureOpenAIResponsesRequest(payload, {
    providerId: "azure-kmamc",
    route: "/responses",
  });

  assert.equal(normalized.tools[0].name, "agents");
  assert.deepEqual(normalized.tools[0].tools[0].parameters.properties.message, { type: "string" });
  assert.deepEqual(normalized.input, [{ ...call, namespace: "agents" }, output]);
  assert.deepEqual(normalized.tool_choice, { ...payload.tool_choice, namespace: "agents" });
  assert.equal(payload.tools[0].name, "collaboration");
  assert.equal(payload.input[0].namespace, "collaboration");
});

test("Azure collaboration message tools use plaintext schemas without changing other tools", () => {
  const spawn = {
    type: "function",
    name: "collaboration__spawn_agent",
    parameters: {
      type: "object",
      properties: {
        task_name: { type: "string" },
        message: { type: "string", encrypted: true },
      },
      required: ["task_name", "message"],
    },
  };
  const shell = {
    type: "function",
    name: "exec_command",
    parameters: {
      type: "object",
      properties: { command: { type: "string", encrypted: true } },
    },
  };
  const payload = { tools: [spawn, shell] };
  const normalized = normalizeAzureOpenAIResponsesRequest(payload, {
    providerId: "azure-kmamc",
    route: "/responses",
  });

  assert.deepEqual(normalized.tools[0].parameters.properties.message, { type: "string" });
  assert.strictEqual(normalized.tools[1], shell);
  assert.equal(spawn.parameters.properties.message.encrypted, true);
});

test("Azure nested collaboration namespace uses plaintext message parameters", () => {
  const collaboration = {
    type: "namespace",
    name: "agents",
    tools: [
      { type: "function", name: "spawn_agent", parameters: {
        type: "object",
        properties: { message: { type: "string", encrypted: true } },
      } },
      { type: "function", name: "wait_agent", parameters: {
        type: "object",
        properties: { target: { type: "string", encrypted: true } },
      } },
    ],
  };
  const payload = { tools: [collaboration] };
  const normalized = normalizeAzureOpenAIResponsesRequest(payload, {
    providerId: "azure-kmamc",
    route: "/responses",
  });

  assert.deepEqual(normalized.tools[0].tools[0].parameters.properties.message, { type: "string" });
  assert.strictEqual(normalized.tools[0].tools[1], collaboration.tools[1]);
  assert.equal(collaboration.tools[0].parameters.properties.message.encrypted, true);
});
