import assert from "node:assert/strict";
import { Readable } from "node:stream";
import test from "node:test";

import {
  NamespaceToolCallTransform,
  buildNamespaceLookups,
  flattenNamespacedHistory,
  flattenNamespaceTools,
  rewriteNamespaceFunctionCall,
  rewriteNamespaceResponsePayload,
} from "../src/namespace-relay.mjs";
import { mergeCodexAppTools } from "../src/codex-app-tools.mjs";

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

// The reduced codex_app namespace the client actually sends on routed requests
// (captured live: load_workspace_dependencies, navigate_to_codex_page,
// read_thread_terminal), plus the collaboration and MCP namespaces that
// LiteLLM's Responses -> Chat Completions bridge drops unless flattened.
function clientRoutedTools() {
  return [
    { type: "function", name: "exec_command" },
    { type: "function", name: "view_image" },
    {
      type: "namespace",
      name: "collaboration",
      tools: [
        {
          type: "function",
          name: "spawn_agent",
          inputSchema: {
            type: "object",
            properties: {
              model: {
                anyOf: [
                  { type: "string", enum: ["gpt-5.6-sol", "gpt-5.6-terra"] },
                  { type: "null" },
                ],
              },
            },
          },
        },
        { type: "function", name: "wait_agent" },
      ],
    },
    {
      type: "namespace",
      name: "codex_app",
      tools: [
        { type: "function", name: "load_workspace_dependencies" },
        { type: "function", name: "navigate_to_codex_page" },
        { type: "function", name: "read_thread_terminal" },
      ],
    },
    {
      type: "namespace",
      name: "mcp__node_repl",
      tools: [
        { type: "function", name: "js" },
        { type: "function", name: "js_reset" },
      ],
    },
    {
      type: "namespace",
      name: "mcp__codex_apps__github",
      tools: [{ type: "function", name: "fetch_issue" }],
    },
  ];
}

test("flattenNamespaceTools flattens every namespace, including MCP ones", () => {
  const { tools, flattened, namespaces } = flattenNamespaceTools(clientRoutedTools());
  assert.equal(flattened, true);
  const names = tools.map((tool) => tool.name);
  // Plain tools untouched.
  assert.ok(names.includes("exec_command"));
  assert.ok(names.includes("view_image"));
  // Collaboration flattened.
  assert.ok(names.includes("collaboration__spawn_agent"));
  assert.ok(names.includes("collaboration__wait_agent"));
  // App tools flattened.
  assert.ok(names.includes("codex_app__load_workspace_dependencies"));
  assert.ok(names.includes("codex_app__navigate_to_codex_page"));
  assert.ok(names.includes("codex_app__read_thread_terminal"));
  // MCP namespaces flattened -- the browser/computer-use runtime (node_repl
  // js) and MCP servers whose namespace names themselves contain the
  // delimiter.
  assert.ok(names.includes("mcp__node_repl__js"));
  assert.ok(names.includes("mcp__node_repl__js_reset"));
  assert.ok(names.includes("mcp__codex_apps__github__fetch_issue"));
  // No namespace entries survive.
  assert.ok(tools.every((tool) => tool?.type !== "namespace"), "no namespace entries remain");
  // The map records exactly the flattened namespaces and their tools.
  assert.deepEqual([...namespaces.get("collaboration")].sort(), ["spawn_agent", "wait_agent"]);
  assert.deepEqual([...namespaces.get("mcp__node_repl")].sort(), ["js", "js_reset"]);
  assert.deepEqual([...namespaces.get("mcp__codex_apps__github")], ["fetch_issue"]);
});

test("flattenNamespaceTools keeps the full tool schema on flattened entries", () => {
  const schema = {
    type: "object",
    properties: { target: { type: "object" } },
    required: ["target"],
    additionalProperties: false,
  };
  const { tools } = flattenNamespaceTools([
    {
      type: "namespace",
      name: "codex_app",
      tools: [
        { type: "function", name: "create_thread", description: "Create a thread", inputSchema: schema, strict: true },
      ],
    },
  ]);
  const flat = tools[0];
  assert.equal(flat.name, "codex_app__create_thread");
  assert.equal(flat.description, "Create a thread");
  assert.deepEqual(flat.inputSchema, schema);
  assert.deepEqual(flat.parameters, schema);
  assert.equal(flat.strict, true);
});

test("flattenNamespaceTools preserves a supplied provider parameter schema", () => {
  const inputSchema = { type: "object", properties: { stale: { type: "string" } } };
  const parameters = { type: "object", properties: { current: { type: "integer" } } };
  const { tools } = flattenNamespaceTools([
    {
      type: "namespace",
      name: "mcp__example",
      tools: [{ type: "function", name: "read", inputSchema, parameters }],
    },
  ]);
  assert.deepEqual(tools[0].parameters, parameters);
  assert.deepEqual(tools[0].inputSchema, inputSchema);
});

test("flattenNamespaceTools drops the deferred-loading control after expanding namespaces", () => {
  const { tools, flattened } = flattenNamespaceTools([
    { type: "tool_search" },
    {
      type: "namespace",
      name: "mcp__example",
      tools: [{ type: "function", name: "read" }],
    },
  ]);
  assert.equal(flattened, true);
  assert.deepEqual(tools, [{ type: "function", name: "mcp__example__read" }]);
});

test("flattenNamespaceTools handles non-array and empty input", () => {
  assert.deepEqual(flattenNamespaceTools(undefined), {
    tools: undefined,
    flattened: false,
    namespaces: new Map(),
  });
  const { tools, flattened, namespaces } = flattenNamespaceTools([
    { type: "function", name: "exec_command" },
    { type: "namespace", name: "empty", tools: [] },
  ]);
  assert.equal(flattened, false);
  assert.equal(namespaces.size, 0);
  assert.equal(tools.length, 1);
});

test("full inventory survives merge + flatten with nothing dropped", () => {
  const inventory = [
    ...clientRoutedTools(),
    { type: "function", name: "write_stdin" },
    { type: "function", name: "update_plan" },
    { type: "function", name: "request_user_input" },
    { type: "function", name: "apply_patch" },
    { type: "function", name: "web_search" },
  ];
  const merged = mergeCodexAppTools(inventory);
  assert.equal(merged.merged, true);
  const { tools, flattened } = flattenNamespaceTools(merged.tools);
  assert.equal(flattened, true);
  const names = tools.map((tool) => tool.name);
  // Nothing standard dropped.
  for (const name of ["exec_command", "write_stdin", "update_plan", "apply_patch", "view_image", "web_search"]) {
    assert.ok(names.includes(name), `${name} must survive`);
  }
  // Agent tools present (flattened).
  for (const name of ["collaboration__spawn_agent", "collaboration__wait_agent"]) {
    assert.ok(names.includes(name), `${name} must survive`);
  }
  // Thread + automation + app tools present (flattened) after the merge fills
  // the deferred codex_app definitions.
  for (const name of ["codex_app__create_thread", "codex_app__list_threads", "codex_app__automation_update", "codex_app__read_thread"]) {
    assert.ok(names.includes(name), `${name} must survive`);
  }
  // MCP namespaces flattened too -- the old relay left them to the bridge,
  // which dropped them, so routed models never saw node_repl (the in-app
  // browser and computer-use runtime) or any other MCP server.
  assert.ok(names.includes("mcp__node_repl__js"), "mcp__node_repl__js must survive");
});

test("stored namespaced calls are renamed to match the flattened tools", () => {
  const merged = mergeCodexAppTools(clientRoutedTools());
  const { namespaces } = flattenNamespaceTools(merged.tools);
  const input = flattenNamespacedHistory(
    [
      { type: "message", role: "user", content: [] },
      { type: "function_call", name: "exec_command", call_id: "call_0" },
      {
        type: "function_call",
        name: "create_thread",
        namespace: "codex_app",
        call_id: "call_1",
        arguments: "{}",
      },
      {
        type: "function_call",
        name: "spawn_agent",
        namespace: "collaboration",
        call_id: "call_2",
        arguments: "{}",
      },
      {
        type: "function_call",
        name: "js",
        namespace: "mcp__node_repl",
        call_id: "call_3",
        arguments: "{}",
      },
      { type: "function_call_output", call_id: "call_1", output: "{}" },
    ],
    namespaces,
  );
  assert.equal(input[2].name, "codex_app__create_thread");
  assert.equal(input[2].namespace, undefined);
  assert.equal(input[2].call_id, "call_1");
  assert.equal(input[3].name, "collaboration__spawn_agent");
  assert.equal(input[3].namespace, undefined);
  assert.equal(input[4].name, "mcp__node_repl__js");
  assert.equal(input[4].namespace, undefined);
  // Unrelated items keep their identity so replay stays byte-comparable.
  assert.equal(input[1].name, "exec_command");
  assert.deepEqual(input[5], { type: "function_call_output", call_id: "call_1", output: "{}" });
});

test("history rename is idempotent and leaves other namespaces alone", () => {
  const { namespaces } = flattenNamespaceTools(clientRoutedTools());
  const alreadyFlat = {
    type: "function_call",
    name: "codex_app__list_threads",
    namespace: "codex_app",
    call_id: "call_2",
  };
  const unknownNamespace = {
    type: "function_call",
    name: "mystery",
    namespace: "not_flattened",
    call_id: "call_3",
  };
  const input = flattenNamespacedHistory([alreadyFlat, unknownNamespace], namespaces);
  assert.equal(input[0].name, "codex_app__list_threads");
  assert.equal(input[0].namespace, "codex_app");
  assert.deepEqual(input[1], unknownNamespace);
});

test("history rename recovers calls stored without a namespace field", () => {
  const { namespaces } = flattenNamespaceTools([
    {
      type: "namespace",
      name: "collaboration",
      tools: [{ type: "function", name: "spawn_agent" }],
    },
  ]);
  const input = flattenNamespacedHistory(
    [{ type: "function_call", name: "spawn_agent", call_id: "call_1" }],
    namespaces,
  );
  assert.equal(input[0].name, "collaboration__spawn_agent");
});

test("response transform restores flattened calls to the native namespace shape", async () => {
  const merged = mergeCodexAppTools(clientRoutedTools());
  const { namespaces } = flattenNamespaceTools(merged.tools);
  const events = [
    { type: "response.created" },
    {
      type: "response.output_item.added",
      item: {
        type: "function_call",
        name: "collaboration__spawn_agent",
        call_id: "call_1",
      },
    },
    {
      type: "response.output_item.done",
      item: {
        type: "function_call",
        name: "codex_app__create_thread",
        call_id: "call_2",
        arguments: "{}",
      },
    },
    {
      type: "response.output_item.done",
      item: {
        type: "function_call",
        name: "mcp__node_repl__js",
        call_id: "call_3",
        arguments: "{}",
      },
    },
    {
      type: "response.output_item.done",
      item: {
        type: "function_call",
        name: "mcp__codex_apps__github__fetch_issue",
        call_id: "call_4",
        arguments: "{}",
      },
    },
  ].map((event) => `data: ${JSON.stringify(event)}\n\n`);
  const transform = new NamespaceToolCallTransform(namespaces);
  const output = await collect(Readable.from(events).pipe(transform));
  assert.match(output, /"name":"spawn_agent"/);
  assert.match(output, /"namespace":"collaboration"/);
  assert.match(output, /"name":"create_thread"/);
  assert.match(output, /"namespace":"codex_app"/);
  assert.match(output, /"name":"js"/);
  assert.match(output, /"namespace":"mcp__node_repl"/);
  assert.match(output, /"name":"fetch_issue"/);
  assert.match(output, /"namespace":"mcp__codex_apps__github"/);
  assert.doesNotMatch(output, /collaboration__spawn_agent|codex_app__create_thread|mcp__node_repl__js/);
});

test("response transform restores namespace on unambiguous unprefixed calls", async () => {
  // Mirror the routed pipeline: merge fills the deferred codex_app tools
  // (create_thread among them), then every namespace is flattened.
  const merged = mergeCodexAppTools(clientRoutedTools());
  const { namespaces } = flattenNamespaceTools(merged.tools);
  const events = [
    {
      type: "response.output_item.done",
      item: {
        type: "function_call",
        name: "spawn_agent",
        call_id: "call_plain",
        arguments: "{}",
      },
    },
    {
      type: "response.output_item.done",
      item: {
        type: "function_call",
        name: "create_thread",
        call_id: "call_plain2",
        arguments: "{}",
      },
    },
  ].map((event) => `data: ${JSON.stringify(event)}\n\n`);
  const transform = new NamespaceToolCallTransform(namespaces);
  const output = await collect(Readable.from(events).pipe(transform));
  assert.match(output, /"name":"spawn_agent"/);
  assert.match(output, /"namespace":"collaboration"/);
  assert.match(output, /"name":"create_thread"/);
  assert.match(output, /"namespace":"codex_app"/);
});

test("response transform drops a spawn-agent model override not offered by the tool schema", async () => {
  const { namespaces } = flattenNamespaceTools(clientRoutedTools());
  const lookups = buildNamespaceLookups(namespaces);
  const invalid = rewriteNamespaceResponsePayload(
    {
      output: [
        {
          type: "function_call",
          name: "collaboration__spawn_agent",
          arguments: JSON.stringify({ message: "verify", model: "gpt-5.6-luna" }),
        },
      ],
    },
    lookups,
  );
  assert.deepEqual(JSON.parse(invalid.output[0].arguments), { message: "verify" });

  const valid = rewriteNamespaceResponsePayload(
    {
      output: [
        {
          type: "function_call",
          name: "collaboration__spawn_agent",
          arguments: JSON.stringify({ message: "verify", model: "gpt-5.6-terra" }),
        },
      ],
    },
    lookups,
  );
  assert.deepEqual(JSON.parse(valid.output[0].arguments), {
    message: "verify",
    model: "gpt-5.6-terra",
  });
});

test("response transform detects headerless SSE after split framing prelude", async () => {
  const { namespaces } = flattenNamespaceTools(clientRoutedTools());
  const body = Buffer.from(
    [
      "\uFEFF: keepalive\r\n\r\n",
      "\n",
      `data: ${JSON.stringify({
        type: "response.output_item.done",
        item: {
          type: "function_call",
          name: "collaboration__spawn_agent",
          call_id: "call_split_prefix",
          arguments: "{}",
        },
      })}\n\n`,
    ].join(""),
    "utf8",
  );
  const transform = new NamespaceToolCallTransform(namespaces, "");
  const output = await collect(
    Readable.from([...body].map((byte) => Buffer.from([byte]))).pipe(transform),
  );
  assert.match(output, /"name":"spawn_agent"/);
  assert.match(output, /"namespace":"collaboration"/);
  assert.doesNotMatch(output, /collaboration__spawn_agent/);
});

test("response transform restores declared and headerless non-streaming JSON output", async () => {
  const merged = mergeCodexAppTools(clientRoutedTools());
  const { namespaces } = flattenNamespaceTools(merged.tools);
  const payload = {
    id: "resp_json",
    output: [
      {
        type: "function_call",
        name: "codex_app__create_thread",
        call_id: "call_thread",
        arguments: "{}",
      },
      {
        type: "function_call",
        name: "mcp__node_repl__js",
        call_id: "call_browser",
        arguments: "{}",
      },
      {
        type: "function_call",
        name: "exec_command",
        call_id: "call_plain",
        arguments: "{}",
      },
    ],
  };
  const body = JSON.stringify(payload);
  for (const contentType of ["application/json", ""]) {
    const transform = new NamespaceToolCallTransform(namespaces, contentType);
    const output = JSON.parse(
      await collect(Readable.from([body.slice(0, 1), body.slice(1)]).pipe(transform)),
    );
    assert.deepEqual(
      { name: output.output[0].name, namespace: output.output[0].namespace },
      { name: "create_thread", namespace: "codex_app" },
    );
    assert.deepEqual(
      { name: output.output[1].name, namespace: output.output[1].namespace },
      { name: "js", namespace: "mcp__node_repl" },
    );
    assert.equal(output.output[2].name, "exec_command");
    assert.equal(output.output[2].namespace, undefined);
  }
});

test("non-streaming rewrite covers nested output and leaves malformed JSON untouched", async () => {
  const { namespaces } = flattenNamespaceTools([
    {
      type: "namespace",
      name: "collaboration",
      tools: [{ type: "function", name: "spawn_agent" }],
    },
  ]);
  const lookups = buildNamespaceLookups(namespaces);
  const rewritten = rewriteNamespaceResponsePayload(
    {
      response: {
        output: [{ type: "function_call", name: "collaboration__spawn_agent" }],
      },
    },
    lookups,
  );
  assert.deepEqual(rewritten.response.output[0], {
    type: "function_call",
    name: "spawn_agent",
    namespace: "collaboration",
  });

  const malformed = "{not valid json\n";
  const transform = new NamespaceToolCallTransform(namespaces, "application/json");
  assert.equal(await collect(Readable.from([malformed]).pipe(transform)), malformed);
});

test("response transform leaves ambiguous and ordinary calls alone", async () => {
  // Two namespaces both own `js`, so the bare name cannot be resolved.
  const { namespaces } = flattenNamespaceTools([
    {
      type: "namespace",
      name: "mcp__node_repl",
      tools: [{ type: "function", name: "js" }],
    },
    {
      type: "namespace",
      name: "mcp__other",
      tools: [{ type: "function", name: "js" }],
    },
    { type: "function", name: "exec_command" },
  ]);
  const events = [
    {
      type: "response.output_item.done",
      item: { type: "function_call", name: "js", call_id: "call_ambig", arguments: "{}" },
    },
    {
      type: "response.output_item.done",
      item: {
        type: "function_call",
        name: "exec_command",
        call_id: "call_exec",
        arguments: "{}",
      },
    },
  ].map((event) => `data: ${JSON.stringify(event)}\n\n`);
  const transform = new NamespaceToolCallTransform(namespaces);
  const output = await collect(Readable.from(events).pipe(transform));
  // The ambiguous bare name is left untouched -- no namespace is invented.
  assert.match(output, /"name":"js"/);
  assert.doesNotMatch(output, /"namespace":"mcp__node_repl"/);
  // Ordinary calls untouched.
  assert.match(output, /"name":"exec_command"/);
  assert.doesNotMatch(output, /"namespace":"mcp__other"/);
  // The exact flattened name still resolves.
  const resolved = rewriteNamespaceFunctionCall(
    {
      type: "response.output_item.done",
      item: { type: "function_call", name: "mcp__node_repl__js", call_id: "c" },
    },
    buildNamespaceLookups(namespaces),
  );
  assert.deepEqual(resolved.item, {
    type: "function_call",
    name: "js",
    namespace: "mcp__node_repl",
    call_id: "c",
  });
});

test("rewriteNamespaceFunctionCall rejects non-call events", () => {
  const lookups = buildNamespaceLookups(new Map());
  assert.equal(rewriteNamespaceFunctionCall({ item: { type: "message" } }, lookups), undefined);
  assert.equal(rewriteNamespaceFunctionCall(undefined, lookups), undefined);
});

test("response rewrite turns Grok whole-float tool arguments into integers", () => {
  const lookups = buildNamespaceLookups(new Map());
  const rewritten = rewriteNamespaceResponsePayload(
    {
      type: "response.output_item.done",
      item: {
        type: "function_call",
        name: "shell_command",
        call_id: "call_shell",
        arguments: '{"command":"git status","timeout_ms":20000.0}',
      },
    },
    lookups,
  );
  assert.equal(rewritten.item.arguments, '{"command":"git status","timeout_ms":20000}');
  assert.equal(rewritten.item.name, "shell_command");

  const done = rewriteNamespaceResponsePayload(
    {
      type: "response.function_call_arguments.done",
      item_id: "item_1",
      arguments: '{"timeout_ms":20000.0,"ratio":3.14}',
    },
    lookups,
  );
  assert.equal(done.arguments, '{"timeout_ms":20000,"ratio":3.14}');
});

test("response transform rewrites native shell_command integer floats in SSE", async () => {
  const events = [
    {
      type: "response.output_item.done",
      item: {
        type: "function_call",
        name: "shell_command",
        call_id: "call_shell",
        arguments: '{"timeout_ms":20000.0}',
      },
    },
    {
      type: "response.function_call_arguments.done",
      item_id: "item_1",
      arguments: '{"timeout_ms":15000.0}',
    },
  ].map((event) => `data: ${JSON.stringify(event)}\n\n`);
  const transform = new NamespaceToolCallTransform(new Map());
  const output = await collect(Readable.from(events).pipe(transform));
  assert.match(output, /timeout_ms\\":20000/);
  assert.match(output, /timeout_ms\\":15000/);
  assert.doesNotMatch(output, /20000\.0|15000\.0/);
});

// Regression for #175: strict upstreams (the xAI CLI proxy, Moonshot/Kimi)
// reject the whole request over a union-rooted parameter schema. Codex's own
// `automation_update` ships a `oneOf` root, so every routed provider saw it.
test("every flattened app tool reaches the provider with an object root", async () => {
  const { mergeCodexAppTools } = await import("../src/codex-app-tools.mjs");
  const { hasObjectRoot } = await import("../src/tool-schema-root.mjs");

  const merged = mergeCodexAppTools([{ type: "namespace", name: "codex_app", tools: [] }]);
  const { tools } = flattenNamespaceTools(merged.tools);

  const unionRooted = tools
    .filter((tool) => tool.parameters && !hasObjectRoot(tool.parameters))
    .map((tool) => tool.name);
  assert.deepEqual(unionRooted, [], "a union root fails the whole request, not the one tool");

  const automationUpdate = tools.find((tool) => tool.name === "codex_app__automation_update");
  assert.ok(automationUpdate, "automation_update is still relayed");
  assert.equal(automationUpdate.parameters.type, "object");
  assert.ok(
    Array.isArray(automationUpdate.inputSchema.oneOf),
    "inputSchema keeps the client's native union for responses-native routes",
  );
});

test("flattened parameters drop literals that contradict their declared type", () => {
  const { tools } = flattenNamespaceTools([
    {
      type: "namespace",
      name: "codex_app",
      tools: [
        {
          name: "automation_update",
          inputSchema: {
            type: "object",
            properties: { enabled: { type: "string", enum: [true] } },
          },
        },
      ],
    },
  ]);

  const flattened = tools.find((tool) => tool.name === "codex_app__automation_update");
  assert.equal("enum" in flattened.parameters.properties.enabled, false);
});
