import assert from "node:assert/strict";
import test from "node:test";

import { normalizeAzureOpenAIResponsesRequest } from "../src/azure-openai-compat.mjs";

test("azure-kmamc removes Codex image_gen namespace but preserves collaboration", () => {
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

  assert.deepEqual(normalized.tools, [collaboration, shell]);
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
    name: "collaboration",
    tools: [{ type: "function", name: "spawn_agent" }],
  };

  const payload = { tools: [collaboration] };

  const normalized = normalizeAzureOpenAIResponsesRequest(payload, {
    providerId: "azure-kmamc",
    route: "/responses",
  });

  assert.strictEqual(normalized, payload);
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
