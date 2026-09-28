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

// The route's whole contract is that it is inert unless the request is bound to
// this one provider on this one endpoint. These lock that in by identity, so a
// later refactor cannot widen the gate without a failing test.
test("the Azure normalizer is inert for every other provider and route", () => {
  const payload = {
    tools: [{
      type: "namespace",
      name: "collaboration",
      tools: [{
        type: "function",
        name: "spawn_agent",
        parameters: {
          type: "object",
          properties: { message: { type: "string", encrypted: true } },
        },
      }],
    }],
  };

  for (const providerId of [
    "deepseek", "openrouter", "kimi", "zai", "grok", "opencode", "commandcode",
    "minimax", "github-copilot", "meta", "vertex",
    // Near misses: the gate is an exact match, not a prefix or a fold.
    "azure-kmamcx", "azure-kmam", "Azure-KMAMC", "",
  ]) {
    assert.strictEqual(
      normalizeAzureOpenAIResponsesRequest(payload, { providerId, route: "/responses" }),
      payload,
      `provider ${JSON.stringify(providerId)} must pass through by identity`,
    );
  }

  for (const route of ["/chat/completions", "/messages", "/embeddings", "/decisions", ""]) {
    assert.strictEqual(
      normalizeAzureOpenAIResponsesRequest(payload, { providerId: "azure-kmamc", route }),
      payload,
      `route ${JSON.stringify(route)} must pass through by identity`,
    );
  }

  assert.strictEqual(normalizeAzureOpenAIResponsesRequest(payload), payload);
  assert.strictEqual(normalizeAzureOpenAIResponsesRequest(payload, {}), payload);
});

test("normalizing an already-normalized Azure payload is a no-op", () => {
  const payload = {
    tools: [{
      type: "namespace",
      name: "collaboration",
      tools: [{
        type: "function",
        name: "spawn_agent",
        parameters: {
          type: "object",
          properties: { message: { type: "string", encrypted: true } },
        },
      }],
    }],
  };
  const options = { providerId: "azure-kmamc", route: "/responses" };

  const once = normalizeAzureOpenAIResponsesRequest(payload, options);
  assert.equal(once.tools[0].name, "agents");
  // A second pass has nothing left to rename or strip, so it must return the
  // same object rather than allocating an equal one.
  assert.strictEqual(normalizeAzureOpenAIResponsesRequest(once, options), once);
});

test("the Azure normalizer never mutates the caller's payload", () => {
  const spawn = {
    type: "function",
    name: "spawn_agent",
    parameters: {
      type: "object",
      properties: { message: { type: "string", encrypted: true } },
    },
  };
  const namespace = { type: "namespace", name: "collaboration", tools: [spawn] };
  const call = {
    type: "function_call",
    name: "spawn_agent",
    namespace: "collaboration",
    call_id: "call_1",
    arguments: '{"task_name":"probe","message":"hello"}',
  };
  const payload = {
    tools: [namespace],
    input: [call],
    tool_choice: { type: "function", name: "spawn_agent", namespace: "collaboration" },
  };

  normalizeAzureOpenAIResponsesRequest(payload, {
    providerId: "azure-kmamc",
    route: "/responses",
  });

  assert.equal(payload.tools[0].name, "collaboration");
  assert.equal(spawn.parameters.properties.message.encrypted, true);
  assert.equal(payload.input[0].namespace, "collaboration");
  assert.equal(payload.tool_choice.namespace, "collaboration");
});

test("an Azure request left with no tools omits the key instead of sending an empty list", () => {
  const payload = {
    tools: [
      { type: "image_generation" },
      { type: "namespace", name: "image_gen", tools: [{ type: "function", name: "imagegen" }] },
      { type: "function", name: "image_gen.imagegen" },
      { type: "function", name: "image_gen__imagegen" },
    ],
  };

  const normalized = normalizeAzureOpenAIResponsesRequest(payload, {
    providerId: "azure-kmamc",
    route: "/responses",
  });

  assert.ok(!("tools" in normalized), "an empty tool list must not be forwarded");
  assert.equal(payload.tools.length, 4);
});

test("a flattened Azure collaboration tool keeps its declared name", () => {
  // Only the schema annotation is Azure's problem; the literal tool name is the
  // client's own and has no response-side restore, so renaming it here would
  // hand the caller a tool it never declared.
  const spawn = {
    type: "function",
    name: "collaboration__spawn_agent",
    parameters: {
      type: "object",
      properties: { message: { type: "string", encrypted: true } },
    },
  };

  const normalized = normalizeAzureOpenAIResponsesRequest({ tools: [spawn] }, {
    providerId: "azure-kmamc",
    route: "/responses",
  });

  assert.equal(normalized.tools[0].name, "collaboration__spawn_agent");
  assert.equal(normalized.tools[0].parameters.properties.message.encrypted, undefined);
});

test("Azure history is aliased only when the request declares the namespace", () => {
  // With no `collaboration` namespace among the tools there is nothing to alias
  // to, so history and tool choice are left exactly as the caller sent them.
  const payload = {
    tools: [{ type: "function", name: "shell", parameters: { type: "object" } }],
    input: [{
      type: "function_call",
      name: "spawn_agent",
      namespace: "collaboration",
      call_id: "call_1",
      arguments: "{}",
    }],
    tool_choice: { type: "function", name: "spawn_agent", namespace: "collaboration" },
  };

  const normalized = normalizeAzureOpenAIResponsesRequest(payload, {
    providerId: "azure-kmamc",
    route: "/responses",
  });

  assert.strictEqual(normalized, payload);
});
