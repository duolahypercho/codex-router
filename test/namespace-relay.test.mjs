import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { Readable, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import test from "node:test";

import {
  NamespaceToolCallTransform,
  agentMessagesAsUserMessages,
  bridgeCustomTools,
  buildNamespaceLookups,
  downgradeOriginalImageDetail,
  flattenNamespacedHistory,
  flattenNamespaceTools,
  flattenToolChoice,
  flattenToolSearchHistory,
  recoverPreflattenedMcpTools,
  rewriteNamespaceFunctionCall,
  rewriteNamespaceResponsePayload,
  repairToolSchemaRoots,
  stripSearchContentTypes,
  ToolSearchHistoryCapacityError,
} from "../src/namespace-relay.mjs";
import { CODEX_APP_TOOLS, mergeCodexAppTools } from "../src/codex-app-tools.mjs";

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

function collectBuffer(stream) {
  return new Promise((resolve, reject) => {
    const output = [];
    stream.on("data", (chunk) => output.push(Buffer.from(chunk)));
    stream.on("end", () => resolve(Buffer.concat(output)));
    stream.on("error", reject);
  });
}

async function collectUntilPipelineError(chunks, transform) {
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
  assert.ok(error, "the transform should fail after committing semantic output");
  return { output: Buffer.concat(output), error };
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

function clientToolSearchControl() {
  return {
    type: "tool_search",
    execution: "client",
    description: "Search deferred tools.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string" },
        limit: { type: "number" },
      },
      required: ["query"],
      additionalProperties: false,
    },
  };
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

test("turn metadata recovers a namespace Codex flattened before the router", () => {
  const wireName = "mcp__neon__apm__staging__snapshot__ro__get_monitor_snapshot";
  const tools = [{ type: "function", name: wireName, parameters: { type: "object" } }];
  const { namespaces } = flattenNamespaceTools(tools);
  const clientMetadata = {
    "x-codex-turn-metadata": JSON.stringify({
      tool_namespaces_info: {
        "mcp__neon__apm__staging__snapshot__ro": {
          name: "mcp__neon__apm__staging__snapshot__ro",
          functions: {
            get_monitor_snapshot: {
              name: "get_monitor_snapshot",
              direct: true,
              code_mode_name: null,
              deferred: false,
              source: { kind: "mcp", server_name: "neon__apm__staging__snapshot__ro" },
            },
          },
        },
      },
    }),
  };

  assert.equal(
    recoverPreflattenedMcpTools(tools, clientMetadata, namespaces),
    true,
  );
  assert.deepEqual(
    rewriteNamespaceResponsePayload(
      {
        output: [{
          type: "function_call",
          name: wireName,
          call_id: "call_snapshot",
          arguments: "{}",
        }],
      },
      buildNamespaceLookups(namespaces),
    ).output[0],
    {
      type: "function_call",
      name: "get_monitor_snapshot",
      namespace: "mcp__neon__apm__staging__snapshot__ro",
      call_id: "call_snapshot",
      arguments: "{}",
    },
  );
});

test("pre-flattened recovery does not reinterpret an ordinary function collision", () => {
  const wireName = "mcp__calendar__create_event";
  const tools = [{ type: "function", name: wireName }];
  const { namespaces } = flattenNamespaceTools(tools);
  const clientMetadata = {
    "x-codex-turn-metadata": JSON.stringify({
      tool_namespaces_info: {
        functions: {
          name: "functions",
          functions: {
            [wireName]: {
              name: wireName,
              direct: true,
              source: { kind: "harness" },
            },
          },
        },
        mcp__calendar: {
          name: "mcp__calendar",
          functions: {
            create_event: {
              name: "create_event",
              direct: true,
              source: { kind: "mcp", server_name: "calendar" },
            },
          },
        },
      },
    }),
  };

  assert.equal(
    recoverPreflattenedMcpTools(tools, clientMetadata, namespaces),
    false,
  );
  assert.equal(namespaces.size, 0);
});

test("pre-flattened recovery fails closed on ambiguous delimiter ownership", () => {
  const tools = [{ type: "function", name: "mcp__calendar__admin__create" }];
  const { namespaces } = flattenNamespaceTools(tools);
  const clientMetadata = {
    "x-codex-turn-metadata": JSON.stringify({
      tool_namespaces_info: {
        mcp__calendar: {
          name: "mcp__calendar",
          functions: {
            admin__create: {
              name: "admin__create",
              direct: true,
              source: { kind: "mcp", server_name: "calendar" },
            },
          },
        },
        mcp__calendar__admin: {
          name: "mcp__calendar__admin",
          functions: {
            create: {
              name: "create",
              direct: true,
              source: { kind: "mcp", server_name: "calendar__admin" },
            },
          },
        },
      },
    }),
  };

  assert.equal(
    recoverPreflattenedMcpTools(tools, clientMetadata, namespaces),
    false,
  );
  assert.equal(namespaces.size, 0);
});

test("pre-flattened recovery transfers a bounded provider alias to the MCP identity", () => {
  const serverName = "neon__apm__production__snapshot__read_only";
  const namespace = `mcp__${serverName}`;
  const name = "get_monitor_snapshot_with_complete_context";
  const wireName = `${namespace}__${name}`;
  const flattened = flattenNamespaceTools(
    [{ type: "function", name: wireName, parameters: { type: "object" } }],
    { maxNameLength: 64 },
  );
  const providerName = flattened.tools[0].name;
  assert.notEqual(providerName, wireName);
  assert.ok(providerName.length <= 64);

  assert.equal(
    recoverPreflattenedMcpTools(
      flattened.tools,
      {
        "x-codex-turn-metadata": JSON.stringify({
          tool_namespaces_info: {
            [namespace]: {
              name: namespace,
              functions: {
                [name]: {
                  name,
                  direct: true,
                  source: { kind: "mcp", server_name: serverName },
                },
              },
            },
          },
        }),
      },
      flattened.namespaces,
    ),
    true,
  );
  assert.equal(
    flattenNamespacedHistory(
      [{ type: "function_call", namespace, name, call_id: "call_history", arguments: "{}" }],
      flattened.namespaces,
    )[0].name,
    providerName,
  );
  assert.deepEqual(
    rewriteNamespaceResponsePayload(
      {
        output: [{
          type: "function_call",
          name: providerName,
          call_id: "call_live",
          arguments: "{}",
        }],
      },
      buildNamespaceLookups(flattened.namespaces),
    ).output[0],
    {
      type: "function_call",
      namespace,
      name,
      call_id: "call_live",
      arguments: "{}",
    },
  );
});

test("pre-flattened recovery transfers collision-only alias ownership", () => {
  const namespace = "mcp__calendar";
  const name = "create_event";
  const wireName = `${namespace}__${name}`;
  const flattened = flattenNamespaceTools(
    [{ type: "function", name: wireName }],
    { aliasCollisions: true },
  );
  assert.equal(flattened.tools[0].name, wireName);
  assert.equal(
    recoverPreflattenedMcpTools(
      flattened.tools,
      {
        "x-codex-turn-metadata": JSON.stringify({
          tool_namespaces_info: {
            [namespace]: {
              name: namespace,
              functions: {
                [name]: {
                  name,
                  direct: true,
                  source: { kind: "mcp", server_name: "calendar" },
                },
              },
            },
          },
        }),
      },
      flattened.namespaces,
    ),
    true,
  );
  assert.equal(
    flattenNamespacedHistory(
      [{ type: "function_call", namespace, name, call_id: "call_history", arguments: "{}" }],
      flattened.namespaces,
    )[0].name,
    wireName,
  );
  const restored = rewriteNamespaceResponsePayload(
    {
      output: [{
        type: "function_call",
        name: wireName,
        call_id: "call_live",
        arguments: "{}",
      }],
    },
    buildNamespaceLookups(flattened.namespaces),
  ).output[0];
  assert.deepEqual(
    { namespace: restored.namespace, name: restored.name },
    { namespace, name },
  );
});

test("pre-flattened recovery rejects malformed, duplicated, and non-MCP metadata", () => {
  const namespace = "mcp__calendar";
  const name = "create_event";
  const wireName = `${namespace}__${name}`;
  const mcpInfo = {
    name: namespace,
    functions: {
      [name]: {
        name,
        direct: true,
        source: { kind: "mcp", server_name: "calendar" },
      },
    },
  };
  const duplicateOrdinaryInventory =
    `{"tool_namespaces_info":{` +
    `"functions":{"name":"functions","functions":{"${wireName}":{"name":"${wireName}"}}},` +
    `"functions":{"name":"functions","functions":{}},` +
    `"${namespace}":${JSON.stringify(mcpInfo)}}}`;
  const cases = [
    JSON.stringify({
      tool_namespaces_info: {
        functions: { name: "functions", functions: [] },
        [namespace]: mcpInfo,
      },
    }),
    duplicateOrdinaryInventory,
    JSON.stringify({
      tool_namespaces_info: {
        codex_app: {
          name: "codex_app",
          functions: {
            create_thread: {
              name: "create_thread",
              direct: true,
              source: { kind: "mcp", server_name: "calendar" },
            },
          },
        },
      },
    }),
    JSON.stringify({
      tool_namespaces_info: {
        [namespace]: {
          ...mcpInfo,
          functions: {
            [name]: {
              ...mcpInfo.functions[name],
              source: { kind: "mcp", server_name: "different" },
            },
          },
        },
      },
    }),
  ];

  for (const encoded of cases) {
    const toolName = encoded.includes("codex_app") ? "codex_app__create_thread" : wireName;
    const { namespaces } = flattenNamespaceTools([{ type: "function", name: toolName }]);
    assert.equal(
      recoverPreflattenedMcpTools(
        [{ type: "function", name: toolName }],
        { "x-codex-turn-metadata": encoded },
        namespaces,
      ),
      false,
    );
    assert.equal(namespaces.size, 0);
  }
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

test("flattenNamespaceTools exposes client tool_search as an ordinary provider function", () => {
  const { tools, flattened } = flattenNamespaceTools([
    clientToolSearchControl(),
    {
      type: "namespace",
      name: "mcp__example",
      tools: [{ type: "function", name: "read" }],
    },
  ]);
  assert.equal(flattened, true);
  assert.deepEqual(tools, [
    {
      type: "function",
      name: "tool_search",
      description: "Search deferred tools.",
      parameters: clientToolSearchControl().parameters,
    },
    { type: "function", name: "mcp__example__read" },
  ]);
});

test("tool_search bridge uses a collision-safe request-local name", () => {
  const { tools, namespaces } = flattenNamespaceTools([
    {
      type: "function",
      name: "tool_search",
      description: "An unrelated application function.",
      parameters: { type: "object" },
    },
    clientToolSearchControl(),
  ]);
  assert.deepEqual(
    tools.map((tool) => tool.name),
    ["tool_search", "codex_tool_search_1"],
  );
  assert.match(tools[1].description, /call `codex_tool_search_1`/);
  assert.match(tools[1].description, /`tool_search` is a separate ordinary function/);

  const lookups = buildNamespaceLookups(namespaces);
  const bridged = rewriteNamespaceResponsePayload(
    {
      output: [
        {
          type: "function_call",
          name: "codex_tool_search_1",
          call_id: "search-1",
          arguments: '{"query":"calendar"}',
        },
        {
          type: "function_call",
          name: "tool_search",
          call_id: "ordinary-1",
          arguments: "{}",
        },
      ],
    },
    lookups,
  );
  assert.deepEqual(bridged.output[0], {
    type: "tool_search_call",
    call_id: "search-1",
    execution: "client",
    arguments: { query: "calendar" },
  });
  assert.deepEqual(bridged.output[1], {
    type: "function_call",
    name: "tool_search",
    call_id: "ordinary-1",
    arguments: "{}",
  });
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

test("bounded function names stay consistent across definitions, history, choices, and restore", () => {
  const namespace = "mcp__codex_apps__github";
  const nativeName = "list_repository_pull_request_review_comments_for_branch";
  const originalName = `${namespace}__${nativeName}`;
  assert.ok(originalName.length > 64, "fixture must exercise the provider limit");

  const definition = {
    type: "namespace",
    name: namespace,
    tools: [{ type: "function", name: nativeName, inputSchema: { type: "object" } }],
  };
  const first = flattenNamespaceTools([definition], { maxNameLength: 64 });
  const second = flattenNamespaceTools([definition], { maxNameLength: 64 });
  const alias = first.tools[0].name;
  assert.equal(alias.length, 64);
  assert.notEqual(alias, originalName);
  assert.equal(second.tools[0].name, alias, "the same request shape gets the same alias");

  const history = flattenNamespacedHistory(
    [
      {
        type: "function_call",
        name: nativeName,
        namespace,
        call_id: "explicit",
        arguments: "{}",
      },
      {
        type: "function_call",
        name: originalName,
        call_id: "already-flat",
        arguments: "{}",
      },
    ],
    first.namespaces,
  );
  assert.deepEqual(history.map((item) => item.name), [alias, alias]);
  assert.ok(history.every((item) => item.namespace === undefined));

  assert.deepEqual(
    flattenToolChoice(
      { type: "function", name: nativeName, namespace },
      first.namespaces,
    ),
    { type: "function", name: alias },
  );
  assert.deepEqual(
    flattenToolChoice({ type: "function", name: nativeName }, first.namespaces),
    { type: "function", name: alias },
  );
  assert.deepEqual(
    flattenToolChoice(
      {
        type: "allowed_tools",
        mode: "required",
        tools: [{ type: "function", name: nativeName, namespace }],
      },
      first.namespaces,
    ).tools,
    [{ type: "function", name: alias }],
  );

  const restored = rewriteNamespaceResponsePayload(
    {
      output: [
        { type: "function_call", name: alias, call_id: "result", arguments: "{}" },
      ],
    },
    buildNamespaceLookups(first.namespaces),
  );
  assert.deepEqual(restored.output[0], {
    type: "function_call",
    name: nativeName,
    namespace,
    call_id: "result",
    arguments: "{}",
  });
});

test("bounded aliases avoid request-local collisions without renaming the legal sibling", () => {
  const namespace = "mcp__codex_apps__github";
  const nativeName = "list_repository_pull_request_review_comments_for_branch";
  const definition = {
    type: "namespace",
    name: namespace,
    tools: [{ type: "function", name: nativeName }],
  };
  const initialAlias = flattenNamespaceTools([definition], { maxNameLength: 64 }).tools[0].name;
  const tools = [{ type: "function", name: initialAlias }, definition];
  const first = flattenNamespaceTools(tools, { maxNameLength: 64 });
  const second = flattenNamespaceTools(tools, { maxNameLength: 64 });
  assert.equal(first.tools[0].name, initialAlias, "the already-legal plain function wins");
  assert.equal(first.tools[1].name.length, 64);
  assert.notEqual(first.tools[1].name, initialAlias);
  assert.deepEqual(
    first.tools.map((tool) => tool.name),
    second.tools.map((tool) => tool.name),
    "collision fallback is deterministic",
  );
});

test("collision-only aliases preserve long Groq names without applying the OpenCode bound", () => {
  const namespace = `mcp__${"very_long_namespace_".repeat(4)}`;
  const nativeName = "read";
  const wireName = `${namespace}__${nativeName}`;
  const flattened = flattenNamespaceTools([
    { type: "function", name: wireName },
    {
      type: "namespace",
      name: namespace,
      tools: [{ type: "function", name: nativeName }],
    },
  ], { aliasCollisions: true });
  const names = flattened.tools.map((tool) => tool.name);
  assert.equal(new Set(names).size, 2);
  assert.ok(names.every((name) => name.startsWith(`${wireName}_`)));
  assert.ok(names.every((name) => name.length > 64));

  const history = flattenNamespacedHistory([
    { type: "function_call", name: wireName, call_id: "plain" },
    { type: "function_call", namespace, name: nativeName, call_id: "native" },
  ], flattened.namespaces);
  assert.notEqual(history[0].name, history[1].name);
  const restored = rewriteNamespaceResponsePayload({ output: history }, buildNamespaceLookups(
    flattened.namespaces,
  ));
  assert.deepEqual(restored.output[0], {
    type: "function_call",
    name: wireName,
    call_id: "plain",
  });
  assert.deepEqual(restored.output[1], {
    type: "function_call",
    namespace,
    name: nativeName,
    call_id: "native",
  });
});

test("delimiter-colliding namespace identities round-trip through distinct aliases", () => {
  const flattened = flattenNamespaceTools([
    {
      type: "namespace",
      name: "a__b",
      tools: [{ type: "function", name: "c" }],
    },
    {
      type: "namespace",
      name: "a",
      tools: [{ type: "function", name: "b__c" }],
    },
  ], { aliasCollisions: true });
  assert.equal(new Set(flattened.tools.map((tool) => tool.name)).size, 2);
  const history = flattenNamespacedHistory([
    { type: "function_call", namespace: "a__b", name: "c" },
    { type: "function_call", namespace: "a", name: "b__c" },
  ], flattened.namespaces);
  assert.notEqual(history[0].name, history[1].name);

  const restored = rewriteNamespaceResponsePayload(
    { output: history },
    buildNamespaceLookups(flattened.namespaces),
  );
  assert.deepEqual(restored.output, [
    { type: "function_call", namespace: "a__b", name: "c" },
    { type: "function_call", namespace: "a", name: "b__c" },
  ]);
});

test("bounded history keeps ordinary and bridged names ahead of bare namespace inference", () => {
  const flattened = flattenNamespaceTools(
    [
      { type: "function", name: "read" },
      clientToolSearchControl(),
      {
        type: "namespace",
        name: "mcp__files",
        tools: [
          { type: "function", name: "read" },
          { type: "function", name: "apply_patch" },
          { type: "function", name: "tool_search" },
        ],
      },
    ],
    { maxNameLength: 64 },
  );
  const bridged = bridgeCustomTools(
    [...flattened.tools, { type: "custom", name: "apply_patch" }],
    [
      { type: "function_call", name: "read", call_id: "plain", arguments: "{}" },
      {
        type: "custom_tool_call",
        name: "apply_patch",
        call_id: "patch",
        input: "patch",
      },
      {
        type: "function_call",
        name: "tool_search",
        call_id: "search",
        arguments: '{"query":"files"}',
      },
    ],
    flattened.namespaces,
    undefined,
    undefined,
    { maxNameLength: 64 },
  );
  const history = flattenNamespacedHistory(bridged.input, flattened.namespaces);
  assert.deepEqual(history.map((item) => item.name), ["read", "apply_patch", "tool_search"]);
});

test("later-discovered plain functions stay distinct from same-named custom relays", () => {
  const nativeName = "future_custom";
  const flattened = flattenNamespaceTools(
    [clientToolSearchControl(), { type: "custom", name: nativeName }],
    { maxNameLength: 64 },
  );
  const bridged = bridgeCustomTools(
    flattened.tools,
    [
      {
        type: "custom_tool_call",
        name: nativeName,
        call_id: "custom-call",
        input: "opaque",
      },
      { type: "custom_tool_call_output", call_id: "custom-call", output: "done" },
      {
        type: "tool_search_call",
        call_id: "search-call",
        execution: "client",
        arguments: { query: nativeName },
      },
      {
        type: "tool_search_output",
        call_id: "search-call",
        execution: "client",
        status: "completed",
        tools: [{ type: "function", name: nativeName, parameters: { type: "object" } }],
      },
      { type: "function_call", name: nativeName, call_id: "plain-call", arguments: "{}" },
    ],
    flattened.namespaces,
    { type: "function", name: nativeName },
    undefined,
    { maxNameLength: 64, bridgeAll: true },
  );
  const customChoice = bridgeCustomTools(
    flattened.tools,
    [],
    flattened.namespaces,
    { type: "custom", name: nativeName },
    undefined,
    { maxNameLength: 64, bridgeAll: true },
  ).toolChoice;
  const searched = flattenToolSearchHistory(
    bridged.input,
    bridged.tools,
    flattened.namespaces,
  );
  const plainAlias = searched.tools.at(-1).name;
  assert.notEqual(plainAlias, nativeName);

  const history = flattenNamespacedHistory(searched.input, flattened.namespaces);
  assert.equal(history.find((item) => item.call_id === "custom-call").name, nativeName);
  assert.equal(history.find((item) => item.call_id === "plain-call").name, plainAlias);
  assert.deepEqual(flattenToolChoice(bridged.toolChoice, flattened.namespaces), {
    type: "function",
    name: plainAlias,
  });
  assert.deepEqual(flattenToolChoice(customChoice, flattened.namespaces), {
    type: "function",
    name: nativeName,
  });

  const restored = rewriteNamespaceResponsePayload(
    {
      output: [
        {
          type: "function_call",
          name: nativeName,
          call_id: "custom-result",
          arguments: '{"input":"opaque"}',
        },
        { type: "function_call", name: plainAlias, call_id: "plain-result", arguments: "{}" },
      ],
    },
    buildNamespaceLookups(flattened.namespaces),
  );
  assert.equal(restored.output[0].type, "custom_tool_call");
  assert.equal(restored.output[0].name, nativeName);
  assert.deepEqual(restored.output[1], {
    type: "function_call",
    name: nativeName,
    call_id: "plain-result",
    arguments: "{}",
  });
});

test("later-discovered plain functions stay distinct from the tool-search relay", () => {
  const nativeName = "tool_search";
  const flattened = flattenNamespaceTools([clientToolSearchControl()], {
    maxNameLength: 64,
  });
  const searched = flattenToolSearchHistory(
    [
      {
        type: "tool_search_call",
        call_id: "search-call",
        execution: "client",
        arguments: { query: nativeName },
      },
      {
        type: "tool_search_output",
        call_id: "search-call",
        execution: "client",
        status: "completed",
        tools: [{ type: "function", name: nativeName, parameters: { type: "object" } }],
      },
      { type: "function_call", name: nativeName, call_id: "plain-call", arguments: "{}" },
    ],
    flattened.tools,
    flattened.namespaces,
  );
  const plainAlias = searched.tools.at(-1).name;
  assert.notEqual(plainAlias, nativeName);

  const history = flattenNamespacedHistory(searched.input, flattened.namespaces);
  assert.equal(history.find((item) => item.call_id === "search-call").name, nativeName);
  assert.equal(history.find((item) => item.call_id === "plain-call").name, plainAlias);
  assert.deepEqual(
    flattenToolChoice({ type: "function", name: nativeName }, flattened.namespaces),
    { type: "function", name: plainAlias },
  );
  const nativeSearchChoice = flattenToolChoice(
    { type: "tool_search", execution: "client" },
    flattened.namespaces,
  );
  assert.deepEqual(nativeSearchChoice, { type: "function", name: nativeName });
  assert.equal(
    flattenToolChoice(nativeSearchChoice, flattened.namespaces),
    nativeSearchChoice,
    "a second pass cannot retarget the native search choice to the plain alias",
  );
  const allowedSearchChoice = flattenToolChoice(
    {
      type: "allowed_tools",
      mode: "required",
      tools: [{ type: "tool_search", execution: "client" }],
    },
    flattened.namespaces,
  );
  assert.deepEqual(allowedSearchChoice.tools, [{ type: "function", name: nativeName }]);
  assert.equal(
    flattenToolChoice(allowedSearchChoice, flattened.namespaces),
    allowedSearchChoice,
    "allowed-tools search references stay idempotent too",
  );
});

test("plain functions and explicit namespace history remain distinct on name collisions", () => {
  const flattened = flattenNamespaceTools(
    [
      { type: "function", name: "read" },
      {
        type: "namespace",
        name: "mcp__files",
        tools: [{ type: "function", name: "read" }],
      },
    ],
    { maxNameLength: 64 },
  );

  const history = flattenNamespacedHistory(
    [
      {
        type: "function_call",
        name: "read",
        namespace: "mcp__files",
        call_id: "namespaced",
        arguments: "{}",
      },
      { type: "function_call", name: "read", call_id: "plain", arguments: "{}" },
    ],
    flattened.namespaces,
  );
  assert.deepEqual(history.map((item) => item.name), ["mcp__files__read", "read"]);
  assert.ok(history.every((item) => item.namespace === undefined));

  assert.deepEqual(
    flattenToolChoice({ type: "function", name: "read" }, flattened.namespaces),
    { type: "function", name: "read" },
  );
  assert.deepEqual(
    flattenToolChoice(
      { type: "function", name: "read", namespace: "mcp__files" },
      flattened.namespaces,
    ),
    { type: "function", name: "mcp__files__read" },
  );

  const plainResponse = {
    output: [
      { type: "function_call", name: "read", call_id: "plain-result", arguments: "{}" },
    ],
  };
  assert.equal(
    rewriteNamespaceResponsePayload(
      plainResponse,
      buildNamespaceLookups(flattened.namespaces),
    ),
    undefined,
  );
});

test("plain names equal to namespace wire names use their own aliases everywhere", () => {
  const plainName = "mcp__files__read";
  const flattened = flattenNamespaceTools(
    [
      { type: "function", name: plainName },
      {
        type: "namespace",
        name: "mcp__files",
        tools: [{ type: "function", name: "read" }],
      },
    ],
    { maxNameLength: 64 },
  );
  const [plainAlias, namespaceAlias] = flattened.tools.map((tool) => tool.name);
  assert.notEqual(plainAlias, plainName);
  assert.notEqual(namespaceAlias, plainName);
  assert.notEqual(plainAlias, namespaceAlias);

  const history = flattenNamespacedHistory(
    [
      { type: "function_call", name: plainName, call_id: "plain", arguments: "{}" },
      {
        type: "function_call",
        name: "read",
        namespace: "mcp__files",
        call_id: "namespaced",
        arguments: "{}",
      },
    ],
    flattened.namespaces,
  );
  assert.deepEqual(history.map((item) => item.name), [plainAlias, namespaceAlias]);

  assert.deepEqual(
    flattenToolChoice({ type: "function", name: plainName }, flattened.namespaces),
    { type: "function", name: plainAlias },
  );
  assert.deepEqual(
    flattenToolChoice(
      { type: "function", name: "read", namespace: "mcp__files" },
      flattened.namespaces,
    ),
    { type: "function", name: namespaceAlias },
  );

  const restored = rewriteNamespaceResponsePayload(
    {
      output: [
        { type: "function_call", name: plainAlias, call_id: "plain", arguments: "{}" },
        {
          type: "function_call",
          name: namespaceAlias,
          call_id: "namespaced",
          arguments: "{}",
        },
      ],
    },
    buildNamespaceLookups(flattened.namespaces),
  );
  assert.deepEqual(restored.output, [
    { type: "function_call", name: plainName, call_id: "plain", arguments: "{}" },
    {
      type: "function_call",
      name: "read",
      namespace: "mcp__files",
      call_id: "namespaced",
      arguments: "{}",
    },
  ]);
});

test("bounded aliases cover plain and tool-search-discovered functions", () => {
  const plainName = "plain_function_with_a_name_that_is_deliberately_longer_than_sixty_four_characters";
  const discoveredNamespace = "mcp__calendar_connector_with_a_long_namespace";
  const discoveredName = "delete_an_event_and_notify_every_participant";
  const flattened = flattenNamespaceTools(
    [clientToolSearchControl(), { type: "function", name: plainName }],
    { maxNameLength: 64 },
  );
  const plainAlias = flattened.tools.find((tool) => tool.name !== "tool_search").name;
  assert.ok(plainAlias.length <= 64);
  assert.notEqual(plainAlias, plainName);

  const routed = flattenToolSearchHistory(
    [
      {
        type: "tool_search_call",
        call_id: "search-long",
        execution: "client",
        arguments: { query: "calendar" },
      },
      {
        type: "tool_search_output",
        call_id: "search-long",
        status: "completed",
        execution: "client",
        tools: [
          {
            type: "namespace",
            name: discoveredNamespace,
            tools: [{ type: "function", name: discoveredName }],
          },
        ],
      },
      {
        type: "function_call",
        name: discoveredName,
        namespace: discoveredNamespace,
        call_id: "discovered-call",
        arguments: "{}",
      },
      { type: "function_call", name: plainName, call_id: "plain-call", arguments: "{}" },
    ],
    flattened.tools,
    flattened.namespaces,
  );
  const discoveredTool = routed.tools.at(-1);
  assert.equal(discoveredTool.type, "function");
  assert.ok(discoveredTool.name.length <= 64);
  assert.notEqual(discoveredTool.name, `${discoveredNamespace}__${discoveredName}`);

  const history = flattenNamespacedHistory(routed.input, flattened.namespaces);
  assert.equal(
    history.find((item) => item.call_id === "discovered-call").name,
    discoveredTool.name,
  );
  assert.equal(history.find((item) => item.call_id === "plain-call").name, plainAlias);
  assert.deepEqual(
    flattenToolChoice({ type: "tool_search", execution: "client" }, flattened.namespaces),
    { type: "function", name: "tool_search" },
  );

  const lookups = buildNamespaceLookups(flattened.namespaces);
  assert.deepEqual(
    rewriteNamespaceResponsePayload(
      {
        output: [
          {
            type: "function_call",
            name: discoveredTool.name,
            call_id: "result",
            arguments: "{}",
          },
          { type: "function_call", name: plainAlias, call_id: "plain", arguments: "{}" },
        ],
      },
      lookups,
    ).output,
    [
      {
        type: "function_call",
        name: discoveredName,
        namespace: discoveredNamespace,
        call_id: "result",
        arguments: "{}",
      },
      { type: "function_call", name: plainName, call_id: "plain", arguments: "{}" },
    ],
  );
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

test("matched tool_search history declares discovered tools and expands namespace lookup", () => {
  const flattened = flattenNamespaceTools([
    clientToolSearchControl(),
    {
      type: "function",
      name: "mcp__calendar__create_event",
      description: "Live schema wins.",
      parameters: { type: "object", properties: { live: { type: "boolean" } } },
    },
  ]);
  const history = [
    {
      type: "tool_search_call",
      call_id: "search-1",
      execution: "client",
      arguments: { query: "calendar", limit: 2 },
    },
    {
      type: "tool_search_output",
      call_id: "search-1",
      status: "completed",
      execution: "client",
      tools: [
        {
          type: "namespace",
          name: "mcp__calendar",
          tools: [
            {
              type: "function",
              name: "create_event",
              parameters: { type: "object", properties: { stale: { type: "string" } } },
            },
            {
              type: "function",
              name: "delete_event",
              parameters: {
                type: "object",
                properties: { id: { type: "string" } },
                required: ["id"],
              },
            },
            { type: "custom", name: "freeform_is_not_a_function" },
          ],
        },
        {
          type: "function",
          name: "weather",
          parameters: { type: "object", properties: { city: { type: "string" } } },
        },
      ],
    },
    {
      type: "tool_search_output",
      call_id: "orphan",
      status: "completed",
      execution: "client",
      tools: [{ type: "function", name: "must_not_be_injected" }],
    },
  ];

  const routed = flattenToolSearchHistory(history, flattened.tools, flattened.namespaces);
  assert.deepEqual(routed.input[0], {
    type: "function_call",
    name: "tool_search",
    call_id: "search-1",
    arguments: '{"query":"calendar","limit":2}',
  });
  const output = JSON.parse(routed.input[1].output);
  assert.equal(routed.input[1].type, "function_call_output");
  assert.deepEqual(
    output.tools.map((tool) => tool.name),
    ["mcp__calendar__delete_event", "weather"],
  );
  assert.equal(routed.input.length, 2, "orphan native history is dropped, not forwarded");
  assert.deepEqual(
    routed.tools.map((tool) => tool.name),
    [
      "tool_search",
      "mcp__calendar__create_event",
      "mcp__calendar__delete_event",
      "weather",
    ],
  );
  assert.equal(
    routed.tools.filter((tool) => tool.name === "mcp__calendar__create_event").length,
    1,
    "the current live schema wins over searched history",
  );
  assert.equal(
    routed.tools.some((tool) => tool.name === "freeform_is_not_a_function"),
    false,
  );
  assert.equal(routed.tools.some((tool) => tool.name === "must_not_be_injected"), false);

  const restored = rewriteNamespaceResponsePayload(
    {
      output: [
        {
          type: "function_call",
          name: "mcp__calendar__delete_event",
          call_id: "delete-1",
          arguments: '{"id":"evt-1"}',
        },
      ],
    },
    buildNamespaceLookups(flattened.namespaces),
  );
  assert.deepEqual(restored.output[0], {
    type: "function_call",
    name: "delete_event",
    namespace: "mcp__calendar",
    call_id: "delete-1",
    arguments: '{"id":"evt-1"}',
  });
});

test("tool_search history admits only definitions within provider capacity", () => {
  const flattened = flattenNamespaceTools([
    clientToolSearchControl(),
    ...Array.from({ length: 126 }, (_, index) => ({
      type: "function",
      name: `core_tool_${index}`,
    })),
  ]);
  assert.equal(flattened.tools.length, 127);
  const history = [
    {
      type: "tool_search_call",
      call_id: "capacity-search",
      execution: "client",
      arguments: { query: "calendar" },
    },
    {
      type: "tool_search_output",
      call_id: "capacity-search",
      status: "completed",
      execution: "client",
      tools: [
        {
          type: "namespace",
          name: "mcp__calendar",
          tools: [
            { type: "function", name: "first" },
            { type: "function", name: "second" },
          ],
        },
        { type: "function", name: "third" },
      ],
    },
  ];

  const routed = flattenToolSearchHistory(
    history,
    flattened.tools,
    flattened.namespaces,
    { maxTools: 128 },
  );
  assert.equal(routed.tools.length, 128);
  assert.deepEqual(
    routed.tools.slice(127).map((tool) => tool.name),
    ["mcp__calendar__first"],
  );
  assert.deepEqual(
    JSON.parse(routed.input[1].output).tools.map((tool) => tool.name),
    ["mcp__calendar__first"],
    "translated history promises only definitions actually admitted",
  );
  assert.deepEqual([...flattened.namespaces.get("mcp__calendar")], ["first"]);
});

test("tool_search capacity reserves every supported forced-choice function shape", () => {
  const choices = [
    { type: "function", namespace: "mcp__x", name: "forced" },
    { type: "function", namespace: "mcp__x", function: { name: "forced" } },
    {
      type: "allowed_tools",
      mode: "required",
      tools: [
        { type: "custom", name: "apply_patch" },
        { type: "function", name: "mcp__x__forced" },
        { type: "tool_search", execution: "client" },
      ],
    },
  ];
  for (const toolChoice of choices) {
    const flattened = flattenNamespaceTools([
      clientToolSearchControl(),
      ...Array.from({ length: 126 }, (_, index) => ({
        type: "function",
        name: `core_tool_${index}`,
      })),
    ], { aliasCollisions: true });
    const routed = flattenToolSearchHistory(
      referencedDiscoveryHistory(undefined).slice(0, 2),
      flattened.tools,
      flattened.namespaces,
      { maxTools: 128, toolChoice },
    );
    assert.equal(routed.tools.length, 128);
    assert.equal(routed.tools.at(-1).name, "mcp__x__forced");
  }
});

test("a forced discovered tool over capacity fails closed", () => {
  const flattened = flattenNamespaceTools([
    clientToolSearchControl(),
    ...Array.from({ length: 127 }, (_, index) => ({
      type: "function",
      name: `core_tool_${index}`,
    })),
  ], { aliasCollisions: true });
  assert.throws(
    () => flattenToolSearchHistory(
      referencedDiscoveryHistory(undefined).slice(0, 2),
      flattened.tools,
      flattened.namespaces,
      {
        maxTools: 128,
        toolChoice: { type: "function", namespace: "mcp__x", name: "forced" },
      },
    ),
    (error) => {
      assert.ok(error instanceof ToolSearchHistoryCapacityError);
      assert.equal(error.available, 0);
      assert.equal(error.required, 1);
      return true;
    },
  );
});

test("discovery references follow request-local identity and transcript time", () => {
  const collision = flattenNamespaceTools([{
    type: "namespace",
    name: "a",
    tools: [{ type: "function", name: "b" }],
  }], { aliasCollisions: true });
  const collisionHistory = [
    {
      type: "tool_search_call",
      call_id: "plain-collision-search",
      execution: "client",
      arguments: { query: "plain collision" },
    },
    {
      type: "tool_search_output",
      call_id: "plain-collision-search",
      execution: "client",
      status: "completed",
      tools: [
        { type: "function", name: "unused" },
        { type: "function", name: "a__b" },
      ],
    },
    { type: "function_call", name: "a__b", call_id: "plain-collision-call" },
  ];
  const collisionRouted = flattenToolSearchHistory(
    collisionHistory,
    collision.tools,
    collision.namespaces,
    { maxTools: 2, recoverWithoutRelay: true },
  );
  assert.equal(collisionRouted.tools.length, 2);
  const discoveredPlainAlias = collisionRouted.tools.at(-1).name;
  assert.notEqual(discoveredPlainAlias, "a__b");
  assert.equal(
    flattenNamespacedHistory(collisionRouted.input, collision.namespaces)[0].name,
    discoveredPlainAlias,
  );

  const differing = flattenNamespaceTools([clientToolSearchControl()]);
  const differingHistory = [
    {
      type: "tool_search_call",
      call_id: "different-namespace-search",
      execution: "client",
      arguments: { query: "different namespace" },
    },
    {
      type: "tool_search_output",
      call_id: "different-namespace-search",
      execution: "client",
      status: "completed",
      tools: [
        { type: "function", name: "unused" },
        { type: "function", name: "x" },
      ],
    },
    { type: "function_call", namespace: "mcp__other", name: "x" },
  ];
  const differingRouted = flattenToolSearchHistory(
    differingHistory,
    differing.tools,
    differing.namespaces,
    { maxTools: 2 },
  );
  assert.equal(differingRouted.tools.at(-1).name, "unused");

  const temporal = flattenNamespaceTools([clientToolSearchControl()]);
  const temporalHistory = [
    {
      type: "tool_search_call",
      call_id: "temporal-a",
      execution: "client",
      arguments: { query: "first" },
    },
    {
      type: "tool_search_output",
      call_id: "temporal-a",
      execution: "client",
      status: "completed",
      tools: [
        { type: "function", name: "unused" },
        {
          type: "namespace",
          name: "mcp__a",
          tools: [{ type: "function", name: "read" }],
        },
      ],
    },
    { type: "function_call", name: "read", call_id: "temporal-read" },
    {
      type: "tool_search_call",
      call_id: "temporal-b",
      execution: "client",
      arguments: { query: "second" },
    },
    {
      type: "tool_search_output",
      call_id: "temporal-b",
      execution: "client",
      status: "completed",
      tools: [{
        type: "namespace",
        name: "mcp__b",
        tools: [{ type: "function", name: "read" }],
      }],
    },
  ];
  const temporalRouted = flattenToolSearchHistory(
    temporalHistory,
    temporal.tools,
    temporal.namespaces,
    { maxTools: 2 },
  );
  assert.equal(temporalRouted.tools.at(-1).name, "mcp__a__read");
});

function referencedDiscoveryHistory(call) {
  return [
    {
      type: "tool_search_call",
      call_id: "referenced-search",
      execution: "client",
      arguments: { query: "deferred" },
    },
    {
      type: "tool_search_output",
      call_id: "referenced-search",
      status: "completed",
      execution: "client",
      tools: [
        {
          type: "namespace",
          name: "mcp__x",
          tools: [
            { type: "function", name: "unused" },
            { type: "function", name: call === undefined ? "forced" : "used" },
          ],
        },
      ],
    },
    ...(call === undefined ? [] : [call]),
  ];
}

test("tool_search capacity reserves a later namespace-referenced discovery", () => {
  const flattened = flattenNamespaceTools([clientToolSearchControl()]);
  const routed = flattenToolSearchHistory(
    referencedDiscoveryHistory({
      type: "function_call",
      name: "used",
      namespace: "mcp__x",
      call_id: "used-call",
      arguments: "{}",
    }),
    flattened.tools,
    flattened.namespaces,
    { maxTools: 2 },
  );
  assert.deepEqual(
    routed.tools.map((tool) => tool.name),
    ["tool_search", "mcp__x__used"],
  );
  assert.deepEqual(
    JSON.parse(routed.input[1].output).tools.map((tool) => tool.name),
    ["mcp__x__used"],
  );
  const history = flattenNamespacedHistory(routed.input, flattened.namespaces);
  assert.equal(history[2].name, "mcp__x__used");
  assert.equal(history[2].namespace, undefined);
});

test("tool_search capacity reserves a uniquely owned bare history name", () => {
  const flattened = flattenNamespaceTools([clientToolSearchControl()]);
  const routed = flattenToolSearchHistory(
    referencedDiscoveryHistory({
      type: "function_call",
      name: "used",
      call_id: "bare-used-call",
      arguments: "{}",
    }),
    flattened.tools,
    flattened.namespaces,
    { maxTools: 2 },
  );
  assert.deepEqual(
    routed.tools.map((tool) => tool.name),
    ["tool_search", "mcp__x__used"],
  );
  const history = flattenNamespacedHistory(routed.input, flattened.namespaces);
  assert.equal(history[2].name, "mcp__x__used");
});

test("referenced tool_search discoveries exceeding capacity fail closed", () => {
  const flattened = flattenNamespaceTools([clientToolSearchControl()]);
  const history = referencedDiscoveryHistory({
    type: "function_call",
    name: "used",
    namespace: "mcp__x",
    call_id: "used-call",
    arguments: "{}",
  });
  history.push({
    type: "function_call",
    name: "unused",
    namespace: "mcp__x",
    call_id: "also-used-call",
    arguments: "{}",
  });
  assert.throws(
    () =>
      flattenToolSearchHistory(history, flattened.tools, flattened.namespaces, {
        maxTools: 2,
      }),
    (error) => {
      assert.ok(error instanceof ToolSearchHistoryCapacityError);
      assert.equal(error.available, 1);
      assert.equal(error.required, 2);
      return true;
    },
  );
  assert.equal(flattened.namespaces.has("mcp__x"), false);
});

test("a referenced duplicate discovery still reserves its shared definition", () => {
  const flattened = flattenNamespaceTools([clientToolSearchControl()]);
  const pair = (suffix) => [
    {
      type: "tool_search_call",
      call_id: `duplicate-search-${suffix}`,
      execution: "client",
      arguments: { query: "duplicate" },
    },
    {
      type: "tool_search_output",
      call_id: `duplicate-search-${suffix}`,
      status: "completed",
      execution: "client",
      tools: [{
        type: "namespace",
        name: "mcp__x",
        tools: [{ type: "function", name: "used" }],
      }],
    },
  ];
  const history = [
    ...pair("first"),
    ...pair("second"),
    {
      type: "function_call",
      name: "used",
      namespace: "mcp__x",
      call_id: "duplicate-used-call",
      arguments: "{}",
    },
  ];
  assert.throws(
    () => flattenToolSearchHistory(
      history,
      flattened.tools,
      flattened.namespaces,
      { maxTools: 1 },
    ),
    (error) => {
      assert.ok(error instanceof ToolSearchHistoryCapacityError);
      assert.equal(error.available, 0);
      assert.equal(error.required, 1);
      return true;
    },
  );
  assert.equal(flattened.namespaces.has("mcp__x"), false);
});

test("model-switch history recovers referenced discoveries without a live search relay", () => {
  const flattened = flattenNamespaceTools([
    { type: "function", name: "exec_command" },
  ]);
  const routed = flattenToolSearchHistory(
    referencedDiscoveryHistory({
      type: "function_call",
      name: "used",
      namespace: "mcp__x",
      call_id: "used-after-switch",
      arguments: "{}",
    }),
    flattened.tools,
    flattened.namespaces,
    { maxTools: 2, recoverWithoutRelay: true },
  );
  assert.deepEqual(
    routed.tools.map((tool) => tool.name),
    ["exec_command", "mcp__x__used"],
  );
  assert.deepEqual(
    routed.input.map((item) => item.type),
    ["function_call"],
    "the unusable native search control pair is removed",
  );
  const history = flattenNamespacedHistory(routed.input, flattened.namespaces);
  assert.equal(history[0].name, "mcp__x__used");
  assert.equal(history[0].namespace, undefined);
  const restored = rewriteNamespaceResponsePayload(
    {
      output: [{
        type: "function_call",
        name: "mcp__x__used",
        call_id: "used-again",
        arguments: "{}",
      }],
    },
    buildNamespaceLookups(flattened.namespaces),
  );
  assert.deepEqual(restored.output[0], {
    type: "function_call",
    name: "used",
    namespace: "mcp__x",
    call_id: "used-again",
    arguments: "{}",
  });
});

test("model-switch discovery collisions keep the current client schema", () => {
  const current = {
    type: "function",
    name: "mcp__x__used",
    description: "Current client schema wins.",
    parameters: {
      type: "object",
      properties: { current: { type: "boolean" } },
    },
  };
  const flattened = flattenNamespaceTools([current]);
  const routed = flattenToolSearchHistory(
    referencedDiscoveryHistory({
      type: "function_call",
      name: "used",
      namespace: "mcp__x",
      call_id: "colliding-used-call",
      arguments: "{}",
    }),
    flattened.tools,
    flattened.namespaces,
    { maxTools: 1, recoverWithoutRelay: true },
  );
  assert.equal(routed.tools.length, 1);
  assert.equal(routed.tools[0], current);
  const history = flattenNamespacedHistory(routed.input, flattened.namespaces);
  assert.equal(history[0].name, "mcp__x__used");
  assert.equal(history[0].namespace, undefined);
});

test("model-switch referenced discovery overflow fails before mutating identities", () => {
  const flattened = flattenNamespaceTools([
    ...Array.from({ length: 127 }, (_, index) => ({
      type: "function",
      name: `core_tool_${index}`,
    })),
  ]);
  const history = referencedDiscoveryHistory({
    type: "function_call",
    name: "used",
    namespace: "mcp__x",
    call_id: "used-call",
    arguments: "{}",
  });
  history.push({
    type: "function_call",
    name: "unused",
    namespace: "mcp__x",
    call_id: "also-used-call",
    arguments: "{}",
  });
  assert.throws(
    () => flattenToolSearchHistory(
      history,
      flattened.tools,
      flattened.namespaces,
      { maxTools: 128, recoverWithoutRelay: true },
    ),
    (error) => {
      assert.ok(error instanceof ToolSearchHistoryCapacityError);
      assert.equal(error.available, 1);
      assert.equal(error.required, 2);
      return true;
    },
  );
  assert.equal(flattened.namespaces.has("mcp__x"), false);
});

test("parallel tool_search calls pair by call_id when all outputs follow the calls", () => {
  const flattened = flattenNamespaceTools([clientToolSearchControl()]);
  const history = [
    {
      type: "tool_search_call",
      call_id: "search-mail",
      execution: "client",
      arguments: { query: "mail" },
    },
    {
      type: "tool_search_call",
      call_id: "search-calendar",
      execution: "client",
      arguments: { query: "calendar" },
    },
    { type: "message", role: "assistant", content: [] },
    {
      type: "tool_search_output",
      call_id: "search-mail",
      status: "completed",
      execution: "client",
      tools: [{ type: "function", name: "list_messages" }],
    },
    {
      type: "tool_search_output",
      call_id: "search-calendar",
      status: "completed",
      execution: "client",
      tools: [{ type: "function", name: "list_events" }],
    },
  ];
  const routed = flattenToolSearchHistory(history, flattened.tools, flattened.namespaces);
  assert.deepEqual(
    routed.input.map((item) => [item.type, item.call_id]),
    [
      ["function_call", "search-mail"],
      ["function_call", "search-calendar"],
      ["message", undefined],
      ["function_call_output", "search-mail"],
      ["function_call_output", "search-calendar"],
    ],
  );
  assert.deepEqual(
    routed.tools.map((tool) => tool.name),
    ["tool_search", "list_messages", "list_events"],
  );
  assert.equal(
    routed.input.some(
      (item) => item.type === "tool_search_call" || item.type === "tool_search_output",
    ),
    false,
  );
  assert.equal(routed.flattened, true);
});

test("orphaned, malformed, and no-control native tool_search history is dropped", () => {
  const flattened = flattenNamespaceTools([clientToolSearchControl()]);
  const marker = { type: "message", role: "assistant", content: [] };
  const history = [
    marker,
    {
      type: "tool_search_call",
      call_id: "call-only",
      execution: "client",
      arguments: { query: "lost output" },
    },
    {
      type: "tool_search_output",
      call_id: "output-only",
      status: "completed",
      execution: "client",
      tools: [{ type: "function", name: "orphan_injection" }],
    },
    {
      type: "tool_search_call",
      call_id: "malformed",
      execution: "client",
      arguments: "not-an-object",
    },
    {
      type: "tool_search_output",
      call_id: "malformed",
      status: "completed",
      execution: "client",
      tools: [{ type: "function", name: "malformed_injection" }],
    },
  ];
  const routed = flattenToolSearchHistory(history, flattened.tools, flattened.namespaces);
  assert.deepEqual(routed.input, [marker]);
  assert.equal(routed.tools, flattened.tools);
  assert.equal(routed.flattened, true);

  const withoutControl = flattenNamespaceTools([
    {
      type: "namespace",
      name: "mcp__example",
      tools: [{ type: "function", name: "read" }],
    },
  ]);
  const noControl = flattenToolSearchHistory(
    [
      history[1],
      {
        type: "tool_search_output",
        call_id: "call-only",
        status: "completed",
        execution: "client",
        tools: [{ type: "function", name: "no_control_injection" }],
      },
      marker,
    ],
    withoutControl.tools,
    withoutControl.namespaces,
  );
  assert.deepEqual(noControl.input, [marker]);
  assert.equal(noControl.tools, withoutControl.tools);
});

test("compacted tool_search history keeps an ordered pair without reviving tool schemas", () => {
  const flattened = flattenNamespaceTools([clientToolSearchControl()]);
  const history = [
    {
      type: "tool_search_call",
      call_id: "compacted-search",
      execution: "client",
      arguments: { query: "calendar" },
    },
    {
      type: "tool_search_output",
      call_id: "compacted-search",
      status: "completed",
      execution: "client",
      tools: [],
    },
  ];

  const routed = flattenToolSearchHistory(history, flattened.tools, flattened.namespaces);
  assert.deepEqual(
    routed.input.map((item) => item.type),
    ["function_call", "function_call_output"],
  );
  assert.deepEqual(JSON.parse(routed.input[1].output), { tools: [] });
  assert.equal(routed.tools, flattened.tools);
});

test("duplicate ids, reversed order, and malicious outputs invalidate the whole id", () => {
  const call = (call_id) => ({
    type: "tool_search_call",
    call_id,
    execution: "client",
    arguments: { query: call_id },
  });
  const output = (call_id, name, overrides = {}) => ({
    type: "tool_search_output",
    call_id,
    status: "completed",
    execution: "client",
    tools: [{ type: "function", name }],
    ...overrides,
  });
  const cases = [
    [call("duplicate-call"), call("duplicate-call"), output("duplicate-call", "attack_a")],
    [
      call("duplicate-output"),
      output("duplicate-output", "attack_b"),
      output("duplicate-output", "attack_c"),
    ],
    [
      output("reversed", "attack_d"),
      call("reversed"),
      output("reversed", "attack_e"),
    ],
    [call("bad-tools"), output("bad-tools", "attack_f", { tools: { name: "attack_f" } })],
    [call("server-output"), output("server-output", "attack_g", { execution: "server" })],
    [
      { ...call("empty-query"), arguments: { query: "   " } },
      output("empty-query", "attack_h"),
    ],
    [
      { ...call("bad-limit"), arguments: { query: "mail", limit: 0 } },
      output("bad-limit", "attack_i"),
    ],
    [call("missing-status"), output("missing-status", "attack_j", { status: undefined })],
  ];

  for (const history of cases) {
    const flattened = flattenNamespaceTools([clientToolSearchControl()]);
    const routed = flattenToolSearchHistory(history, flattened.tools, flattened.namespaces);
    assert.deepEqual(routed.input, []);
    assert.equal(routed.tools, flattened.tools);
    assert.equal(routed.flattened, true);
  }
});

test("history rename is idempotent and leaves other namespaces alone", () => {
  const { namespaces } = flattenNamespaceTools(clientRoutedTools());
  const alreadyFlat = {
    type: "function_call",
    name: "codex_app__navigate_to_codex_page",
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
  assert.equal(input[0].name, "codex_app__navigate_to_codex_page");
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

// Issue #611: Responses-native routes (e.g. opencode-free-responses Muse Spark)
// keep type:"namespace" tools outbound. Some models then call with a dotted
// wire name (`collaboration.spawn_agent`, `mcp__agentmemory.memory_sessions`)
// instead of the `__` flattening the reverse map indexes. Restore only from
// the request inventory — never by splitting an arbitrary dotted string
// (#568 declined bare name-map recovery that bypasses spawn sanitisation).
test("response transform restores dotted wire names from the request inventory", () => {
  const { namespaces } = flattenNamespaceTools([
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
              model: { type: "string", enum: ["gpt-5.6-sol"] },
            },
          },
        },
      ],
    },
    {
      type: "namespace",
      name: "mcp__agentmemory",
      tools: [{ type: "function", name: "memory_sessions" }],
    },
  ]);
  const lookups = buildNamespaceLookups(namespaces);

  const spawn = rewriteNamespaceResponsePayload(
    {
      output: [
        {
          type: "function_call",
          name: "collaboration.spawn_agent",
          call_id: "call_dot_spawn",
          arguments: JSON.stringify({ model: "gpt-5.6-sol", task: "x" }),
        },
      ],
    },
    lookups,
  );
  assert.deepEqual(
    { namespace: spawn.output[0].namespace, name: spawn.output[0].name },
    { namespace: "collaboration", name: "spawn_agent" },
  );

  const mcp = rewriteNamespaceResponsePayload(
    {
      output: [
        {
          type: "function_call",
          name: "mcp__agentmemory.memory_sessions",
          call_id: "call_dot_mcp",
          arguments: "{}",
        },
      ],
    },
    lookups,
  );
  assert.deepEqual(
    { namespace: mcp.output[0].namespace, name: mcp.output[0].name },
    { namespace: "mcp__agentmemory", name: "memory_sessions" },
  );

  // An invented dotted spelling that is not an inventory pair stays untouched.
  const invented = rewriteNamespaceResponsePayload(
    {
      output: [
        {
          type: "function_call",
          name: "collaboration.not_a_real_tool",
          call_id: "call_invented",
          arguments: "{}",
        },
      ],
    },
    lookups,
  );
  assert.equal(invented, undefined);
});

test("tool_search response bridge suppresses function argument events across its lifecycle", async () => {
  const { namespaces } = flattenNamespaceTools([clientToolSearchControl()]);
  const events = [
    {
      type: "response.output_item.added",
      item: {
        type: "function_call",
        id: "fc_search_1",
        name: "tool_search",
        call_id: "search-1",
        arguments: "",
      },
    },
    {
      type: "response.function_call_arguments.delta",
      item_id: "fc_search_1",
      call_id: "search-1",
      delta: '{"query":"cal',
    },
    {
      type: "response.function_call_arguments.done",
      item_id: "fc_search_1",
      call_id: "search-1",
      arguments: '{"query":"calendar","limit":2}',
    },
    {
      type: "response.output_item.done",
      item: {
        type: "function_call",
        id: "fc_search_1",
        name: "tool_search",
        call_id: "search-1",
        arguments: '{"query":"calendar","limit":2.0}',
      },
    },
    {
      type: "response.completed",
      response: {
        id: "resp-1",
        output: [
          {
            type: "function_call",
            id: "fc_search_1",
            name: "tool_search",
            call_id: "search-1",
            arguments: '{"query":"calendar","limit":2}',
          },
        ],
      },
    },
  ].map((event) => `data: ${JSON.stringify(event)}\n\n`);
  const output = await collect(
    Readable.from(events).pipe(
      new NamespaceToolCallTransform(namespaces, "text/event-stream"),
    ),
  );
  const parsed = output
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => JSON.parse(line.slice(5).trimStart()));

  assert.deepEqual(parsed[0].item, {
    type: "tool_search_call",
    id: "fc_search_1",
    call_id: "search-1",
    execution: "client",
    arguments: {},
  });
  assert.deepEqual(parsed[1].item, {
    type: "tool_search_call",
    id: "fc_search_1",
    call_id: "search-1",
    execution: "client",
    arguments: { query: "calendar", limit: 2 },
  });
  assert.deepEqual(parsed[2].response.output[0], {
    type: "tool_search_call",
    id: "fc_search_1",
    call_id: "search-1",
    execution: "client",
    arguments: { query: "calendar", limit: 2 },
  });
  assert.doesNotMatch(output, /response\.function_call_arguments/u);
});

test("tool_search response bridge fails closed without native control or valid arguments", () => {
  const ordinary = flattenNamespaceTools([
    { type: "function", name: "tool_search", parameters: { type: "object" } },
  ]);
  const ordinaryPayload = {
    output: [
      {
        type: "function_call",
        name: "tool_search",
        call_id: "ordinary-1",
        arguments: '{"query":"calendar"}',
      },
    ],
  };
  assert.equal(
    rewriteNamespaceResponsePayload(
      ordinaryPayload,
      buildNamespaceLookups(ordinary.namespaces),
    ),
    undefined,
  );

  const bridged = flattenNamespaceTools([clientToolSearchControl()]);
  const malformed = {
    output: [
      {
        type: "function_call",
        name: "tool_search",
        call_id: "bad-1",
        arguments: "{not-json",
      },
      {
        type: "function_call",
        name: "tool_search",
        arguments: '{"query":"missing call id"}',
      },
    ],
  };
  assert.equal(
    rewriteNamespaceResponsePayload(
      malformed,
      buildNamespaceLookups(bridged.namespaces),
    ),
    undefined,
  );
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

  const inherited = rewriteNamespaceResponsePayload(
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
    "opencode-go/deepseek-v4-flash",
  );
  assert.deepEqual(JSON.parse(inherited.output[0].arguments), {
    message: "verify",
    model: "opencode-go/deepseek-v4-flash",
  });
});

test("stream response keeps an omitted spawn-agent model on its routed parent", async () => {
  const { namespaces } = flattenNamespaceTools(clientRoutedTools());
  const event = {
    type: "response.output_item.done",
    item: {
      type: "function_call",
      name: "collaboration__spawn_agent",
      call_id: "call_parent_model",
      arguments: JSON.stringify({ message: "verify" }),
    },
  };
  const transform = new NamespaceToolCallTransform(
    namespaces,
    "text/event-stream",
    "opencode-go/deepseek-v4-flash",
  );
  const output = await collect(
    Readable.from([`data: ${JSON.stringify(event)}\n\n`]).pipe(transform),
  );
  const payload = JSON.parse(output.toString("utf8").trim().slice(5));
  assert.equal(payload.item.namespace, "collaboration");
  assert.equal(payload.item.name, "spawn_agent");
  assert.deepEqual(JSON.parse(payload.item.arguments), {
    message: "verify",
    model: "opencode-go/deepseek-v4-flash",
  });
});

test("Responses-native stream keeps an omitted spawn-agent model on its routed parent", async () => {
  const event = {
    type: "response.output_item.done",
    item: {
      type: "function_call",
      namespace: "collaboration",
      name: "spawn_agent",
      call_id: "call_native_parent_model",
      arguments: JSON.stringify({ message: "verify" }),
    },
  };
  const transform = new NamespaceToolCallTransform(
    new Map(),
    "text/event-stream",
    "opencode-go/deepseek-v4-flash",
  );
  const output = await collect(
    Readable.from([`data: ${JSON.stringify(event)}\n\n`]).pipe(transform),
  );
  const payload = JSON.parse(output.toString("utf8").trim().slice(5));
  assert.equal(payload.item.namespace, "collaboration");
  assert.equal(payload.item.name, "spawn_agent");
  assert.deepEqual(JSON.parse(payload.item.arguments), {
    message: "verify",
    model: "opencode-go/deepseek-v4-flash",
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

test("response transform preserves no-op SSE and JSON bytes exactly", async () => {
  const { namespaces } = flattenNamespaceTools([
    {
      type: "namespace",
      name: "collaboration",
      tools: [{ type: "function", name: "spawn_agent" }],
    },
  ]);
  const sse = Buffer.from(
    'event: response.created\r\n' +
      'id: provider-spelling\r\n' +
      'data: { "type" : "response.created", "ratio": 1.00e+2, "nested": { "ok": true } }\r\n' +
      "\r\n",
    "utf8",
  );
  const streamed = await collectBuffer(
    Readable.from([...sse].map((byte) => Buffer.from([byte]))).pipe(
      new NamespaceToolCallTransform(namespaces, "text/event-stream"),
    ),
  );
  assert.deepEqual(streamed, sse);

  const jsonBody = Buffer.from(
    '\r\n { "id" : "resp-noop", "ratio" : 1.00e+2, "output" : [ { "type" : "message", "content" : [] } ] } \t',
    "utf8",
  );
  const jsonOutput = await collectBuffer(
    Readable.from([jsonBody.subarray(0, 7), jsonBody.subarray(7)]).pipe(
      new NamespaceToolCallTransform(namespaces, "application/json"),
    ),
  );
  assert.deepEqual(jsonOutput, jsonBody);
});

test("ambiguous SSE frames fail closed before namespace rewriting", async () => {
  const { namespaces } = flattenNamespaceTools([
    {
      type: "namespace",
      name: "collaboration",
      tools: [{ type: "function", name: "spawn_agent" }],
    },
  ]);
  const later = Buffer.from(
    'data: {"type":"response.output_item.done","item":{"type":"function_call","name":"collaboration__spawn_agent","arguments":"{}"}}\r\n\r\n',
    "utf8",
  );
  const duplicate = Buffer.from(
    'data: {"type":"response.output_item.done","item":{"type":"function_call","name":"ordinary","\\u006eame":"collaboration__spawn_agent","arguments":"{}"}}\r\n\r\n',
    "utf8",
  );
  const malformed = Buffer.from('data: {"type":\r\n\r\n', "utf8");
  const invalidUtf8 = Buffer.concat([
    Buffer.from("data: ", "ascii"),
    Buffer.from([0xff, 0xfe]),
    Buffer.from("\r\n\r\n", "ascii"),
  ]);

  for (const ambiguous of [duplicate, malformed, invalidUtf8]) {
    const source = Buffer.concat([ambiguous, later]);
    const output = await collectBuffer(
      Readable.from([...source].map((byte) => Buffer.from([byte]))).pipe(
        new NamespaceToolCallTransform(namespaces, "text/event-stream"),
      ),
    );
    assert.deepEqual(output, source);
  }
});

test("repeated SSE data or event fields disable rewriting without normalizing CRLF", async () => {
  const { namespaces } = flattenNamespaceTools([
    {
      type: "namespace",
      name: "collaboration",
      tools: [{ type: "function", name: "spawn_agent" }],
    },
  ]);
  const later =
    'data: {"type":"response.output_item.done","item":{"type":"function_call","name":"collaboration__spawn_agent","arguments":"{}"}}\r\n\r\n';
  const repeatedData =
    'event: response.output_item.done\r\n' +
    'data: {"type":"response.output_item.done","item":{"type":"function_call","name":"collaboration__spawn_agent","arguments":"{}"}}\r\n' +
    'data: {"second":"competing EventSource payload"}\r\n\r\n';
  const repeatedEvent =
    'event: response.output_item.done\r\n' +
    'event: response.completed\r\n' +
    'data: {"type":"response.output_item.done","item":{"type":"function_call","name":"collaboration__spawn_agent","arguments":"{}"}}\r\n\r\n';
  for (const ambiguous of [repeatedData, repeatedEvent]) {
    const source = Buffer.from(ambiguous + later, "utf8");
    const fragments = [...source].map((byte) => Buffer.from([byte]));
    const output = await collectBuffer(
      Readable.from(fragments).pipe(
        new NamespaceToolCallTransform(namespaces, "text/event-stream"),
      ),
    );
    assert.deepEqual(output, source);
  }
});

test("raw SSE framing honors downstream backpressure and aborts cleanly", async () => {
  const source = Buffer.from(
    'event: response.created\r\ndata: { "type": "response.created", "value": 1.00e+2 }\r\n\r\n',
    "utf8",
  );
  const output = [];
  await pipeline(
    Readable.from([...source].map((byte) => Buffer.from([byte]))),
    new NamespaceToolCallTransform(new Map(), "text/event-stream"),
    new Writable({
      highWaterMark: 1,
      write(chunk, _encoding, callback) {
        output.push(Buffer.from(chunk));
        setImmediate(callback);
      },
    }),
  );
  assert.deepEqual(Buffer.concat(output), source);

  const controller = new AbortController();
  const transform = new NamespaceToolCallTransform(new Map(), "");
  let prefixSent = false;
  const stalledSource = new Readable({
    read() {
      if (prefixSent) return;
      prefixSent = true;
      this.push(Buffer.from("da", "ascii"));
    },
  });
  const aborted = pipeline(
    stalledSource,
    transform,
    new Writable({ write(_chunk, _encoding, callback) { callback(); } }),
    { signal: controller.signal },
  );
  setImmediate(() => controller.abort());
  await assert.rejects(aborted, { name: "AbortError" });
  assert.equal(transform.destroyed, true);
  stalledSource.destroy();
});

test("ambiguous non-streaming JSON is preserved byte for byte", async () => {
  const { namespaces } = flattenNamespaceTools([
    {
      type: "namespace",
      name: "collaboration",
      tools: [{ type: "function", name: "spawn_agent" }],
    },
  ]);
  const duplicate = Buffer.from(
    '{"output":[{"type":"function_call","name":"ordinary","\\u006eame":"collaboration__spawn_agent","arguments":"{}"}]}',
    "utf8",
  );
  const malformed = Buffer.from('{"output":[', "utf8");
  const invalidUtf8 = Buffer.concat([
    Buffer.from(
      '{"output":[{"type":"function_call","name":"collaboration__spawn_agent","note":"',
      "utf8",
    ),
    Buffer.from([0xff]),
    Buffer.from('","arguments":"{}"}]}', "utf8"),
  ]);
  for (const body of [duplicate, malformed, invalidUtf8]) {
    const output = await collectBuffer(
      Readable.from([body.subarray(0, 3), body.subarray(3)]).pipe(
        new NamespaceToolCallTransform(namespaces, "application/json"),
      ),
    );
    assert.deepEqual(output, body);
  }
});

test("chunked JSON capture releases byte-exactly at its configured bound", async () => {
  const { namespaces } = flattenNamespaceTools([
    {
      type: "namespace",
      name: "collaboration",
      tools: [{ type: "function", name: "spawn_agent" }],
    },
  ]);
  const source = Buffer.from(
    '{"output":[{"type":"function_call","name":"collaboration__spawn_agent","arguments":"{}"}]}',
    "utf8",
  );
  const chunks = [];
  for (let offset = 0; offset < source.length; offset += 3) {
    chunks.push(source.subarray(offset, offset + 3));
  }
  const output = await collectBuffer(
    Readable.from(chunks).pipe(
      new NamespaceToolCallTransform(namespaces, "application/json", undefined, {
        maxJsonCaptureBytes: 31,
      }),
    ),
  );
  assert.deepEqual(output, source);
  assert.match(output.toString("utf8"), /collaboration__spawn_agent/u);
  assert.doesNotMatch(output.toString("utf8"), /"namespace":"collaboration"/u);
});

test("lossy JSON numbers fail closed before SSE or JSON namespace rewrites", async () => {
  const { namespaces } = flattenNamespaceTools([
    {
      type: "namespace",
      name: "collaboration",
      tools: [{ type: "function", name: "spawn_agent" }],
    },
  ]);
  const call =
    '"item":{"type":"function_call","name":"collaboration__spawn_agent","arguments":"{}"}';
  const output =
    '"output":[{"type":"function_call","name":"collaboration__spawn_agent","arguments":"{}"}]';
  const later =
    'event: response.output_item.done\r\n' +
    `data: {"type":"response.output_item.done",${call}}\r\n\r\n`;

  for (const numberText of [
    "9007199254740993",
    "1e999",
    "-0",
    "1e-324",
    "0.100000000000000005",
  ]) {
    const sse = Buffer.from(
      'event: response.output_item.done\r\n' +
        `data: {"type":"response.output_item.done","provider_number":${numberText},${call}}\r\n\r\n` +
        later,
      "utf8",
    );
    const streamed = await collectBuffer(
      Readable.from([...sse].map((byte) => Buffer.from([byte]))).pipe(
        new NamespaceToolCallTransform(namespaces, "text/event-stream"),
      ),
    );
    assert.deepEqual(streamed, sse, numberText);

    const json = Buffer.from(`{"provider_number":${numberText},${output}}`, "utf8");
    const jsonOutput = await collectBuffer(
      Readable.from([json.subarray(0, 5), json.subarray(5)]).pipe(
        new NamespaceToolCallTransform(namespaces, "application/json"),
      ),
    );
    assert.deepEqual(jsonOutput, json, numberText);

    const argumentsLiteral = JSON.stringify(`{"provider_number":${numberText}}`);
    const nestedItem =
      '"item":{"type":"function_call","name":"collaboration__spawn_agent",' +
      `"arguments":${argumentsLiteral}}`;
    const nestedSse = Buffer.from(
      'event: response.output_item.done\r\n' +
        `data: {"type":"response.output_item.done",${nestedItem}}\r\n\r\n` +
        later,
      "utf8",
    );
    const nestedStreamed = await collectBuffer(
      Readable.from([nestedSse]).pipe(
        new NamespaceToolCallTransform(namespaces, "text/event-stream"),
      ),
    );
    assert.deepEqual(nestedStreamed, nestedSse, `nested ${numberText}`);

    const nestedJson = Buffer.from(
      '{"output":[{"type":"function_call","name":"collaboration__spawn_agent",' +
        `"arguments":${argumentsLiteral}}]}`,
      "utf8",
    );
    const nestedJsonOutput = await collectBuffer(
      Readable.from([nestedJson]).pipe(
        new NamespaceToolCallTransform(namespaces, "application/json"),
      ),
    );
    assert.deepEqual(nestedJsonOutput, nestedJson, `nested ${numberText}`);
  }
});

test("exactly equivalent decimal spellings remain eligible for namespace rewrites", async () => {
  const { namespaces } = flattenNamespaceTools([
    {
      type: "namespace",
      name: "collaboration",
      tools: [{ type: "function", name: "spawn_agent" }],
    },
  ]);
  for (const [numberText, expected] of [["1.0", 1], ["1e3", 1000]]) {
    const item =
      '"item":{"type":"function_call","name":"collaboration__spawn_agent","arguments":"{}"}';
    const sse = Buffer.from(
      'event: response.output_item.done\r\n' +
        `data: {"type":"response.output_item.done","provider_number":${numberText},${item}}\r\n\r\n`,
      "utf8",
    );
    const streamed = await collect(
      Readable.from([sse]).pipe(
        new NamespaceToolCallTransform(namespaces, "text/event-stream"),
      ),
    );
    const event = JSON.parse(
      streamed.split(/\r?\n/u).find((line) => line.startsWith("data: ")).slice(6),
    );
    assert.equal(event.provider_number, expected);
    assert.equal(event.item.name, "spawn_agent");
    assert.equal(event.item.namespace, "collaboration");

    const json = Buffer.from(
      `{"provider_number":${numberText},"output":[{"type":"function_call","name":"collaboration__spawn_agent","arguments":"{}"}]}`,
      "utf8",
    );
    const payload = JSON.parse(
      await collect(
        Readable.from([json]).pipe(
          new NamespaceToolCallTransform(namespaces, "application/json"),
        ),
      ),
    );
    assert.equal(payload.provider_number, expected);
    assert.equal(payload.output[0].name, "spawn_agent");
    assert.equal(payload.output[0].namespace, "collaboration");
  }
});

test(
  "dense JSON number arrays are scanned within a linear-time bound",
  { timeout: 3000 },
  async () => {
    const source = Buffer.from(`[${"1,".repeat(128 * 1024 - 1)}1]`, "utf8");
    const output = await collectBuffer(
      Readable.from([source]).pipe(
        new NamespaceToolCallTransform(new Map(), "application/json"),
      ),
    );
    assert.deepEqual(output, source);
  },
);

test("inject-only responses preserve lossy decimal payloads without injecting", async () => {
  const { namespaces } = flattenNamespaceTools([
    {
      type: "namespace",
      name: "collaboration",
      tools: [{ type: "function", name: "interrupt_agent" }],
    },
  ]);
  for (const numberText of ["1e-324", "0.100000000000000005"]) {
    const sse = Buffer.from(
      'event: response.completed\r\n' +
        `data: {"type":"response.completed","provider_number":${numberText},"response":{"output":[]}}\r\n\r\n`,
      "utf8",
    );
    const streamed = await collectBuffer(
      Readable.from([sse]).pipe(
        new NamespaceToolCallTransform(namespaces, "text/event-stream", undefined, {
          injectOnly: true,
          pendingInterrupts: ["/root/finished"],
        }),
      ),
    );
    assert.deepEqual(streamed, sse, numberText);

    const json = Buffer.from(
      `{"provider_number":${numberText},"output":[]}`,
      "utf8",
    );
    const jsonOutput = await collectBuffer(
      Readable.from([json]).pipe(
        new NamespaceToolCallTransform(namespaces, "application/json", undefined, {
          injectOnly: true,
          pendingInterrupts: ["/root/finished"],
        }),
      ),
    );
    assert.deepEqual(jsonOutput, json, numberText);
  }
});

test("conflicting SSE event and payload types disable terminal decisions", async () => {
  const { namespaces } = flattenNamespaceTools([
    {
      type: "namespace",
      name: "collaboration",
      tools: [
        { type: "function", name: "spawn_agent" },
        { type: "function", name: "interrupt_agent" },
      ],
    },
  ]);
  const mismatchByEvent =
    'event: response.completed\r\n' +
    'data: {"type":"response.output_item.done","item":{"type":"function_call","name":"collaboration__spawn_agent","arguments":"{}"}}\r\n\r\n';
  const mismatchByPayload =
    'event: response.output_item.done\r\n' +
    'data: {"type":"response.completed","response":{"output":[]}}\r\n\r\n';
  const missingPayloadType =
    'event: response.completed\r\n' +
    'data: {"response":{"output":[]}}\r\n\r\n';
  const nullPayloadType =
    'event: response.completed\r\n' +
    'data: {"type":null,"response":{"output":[]}}\r\n\r\n';
  const tabIsPartOfEventValue =
    'event:\tresponse.output_item.done\r\n' +
    'data: {"type":"response.output_item.done","item":{"type":"function_call","name":"collaboration__spawn_agent","arguments":"{}"}}\r\n\r\n';
  const secondSpaceIsPartOfEventValue =
    'event:  response.output_item.done\r\n' +
    'data: {"type":"response.output_item.done","item":{"type":"function_call","name":"collaboration__spawn_agent","arguments":"{}"}}\r\n\r\n';
  const later =
    'event: response.output_item.done\r\n' +
    'data: {"type":"response.output_item.done","item":{"type":"function_call","name":"collaboration__spawn_agent","arguments":"{}"}}\r\n\r\n';

  for (const mismatch of [
    mismatchByEvent,
    mismatchByPayload,
    missingPayloadType,
    nullPayloadType,
    tabIsPartOfEventValue,
    secondSpaceIsPartOfEventValue,
  ]) {
    const source = Buffer.from(mismatch + later, "utf8");
    const transformed = await collectBuffer(
      Readable.from([...source].map((byte) => Buffer.from([byte]))).pipe(
        new NamespaceToolCallTransform(namespaces, "text/event-stream", undefined, {
          pendingInterrupts: ["/root/finished"],
        }),
      ),
    );
    assert.deepEqual(transformed, source);
  }
});

test("raw SSE framing handles CR, LF, and CRLF across one-byte chunks", async () => {
  const source = Buffer.from(
    'event: response.created\rdata: { "type": "response.created", "kind": "cr" }\r\r' +
      'event: response.created\ndata: { "type": "response.created", "kind": "lf" }\n\n' +
      'event: response.created\r\ndata: { "type": "response.created", "kind": "crlf" }\r\n\r\n',
    "utf8",
  );
  const output = await collectBuffer(
    Readable.from([...source].map((byte) => Buffer.from([byte]))).pipe(
      new NamespaceToolCallTransform(new Map(), "text/event-stream"),
    ),
  );
  assert.deepEqual(output, source);
});

test("headerless bare-CR streams rewrite and generated interrupts adopt CR", async () => {
  const { namespaces } = flattenNamespaceTools([
    {
      type: "namespace",
      name: "collaboration",
      tools: [
        { type: "function", name: "spawn_agent" },
        { type: "function", name: "interrupt_agent" },
      ],
    },
  ]);
  const source = Buffer.from(
    '\r: provider prelude\r' +
      'event: response.output_item.done\r' +
      'data: {"type":"response.output_item.done","item":{"type":"function_call","name":"collaboration__spawn_agent","arguments":"{}"}}\r\r',
    "utf8",
  );
  const output = await collectBuffer(
    Readable.from([...source].map((byte) => Buffer.from([byte]))).pipe(
      new NamespaceToolCallTransform(namespaces, ""),
    ),
  );
  assert.match(output.toString("utf8"), /"namespace":"collaboration"/u);
  assert.equal(output.includes(0x0a), false);

  const terminal = Buffer.from(
    'event: response.completed\r' +
      'data: {"type":"response.completed","response":{"output":[]}}\r\r',
    "utf8",
  );
  const injected = await collectBuffer(
    Readable.from([...terminal].map((byte) => Buffer.from([byte]))).pipe(
      new NamespaceToolCallTransform(namespaces, "text/event-stream", undefined, {
        pendingInterrupts: ["/root/finished"],
      }),
    ),
  );
  assert.match(injected.toString("utf8"), /"name":"interrupt_agent"/u);
  assert.equal(injected.includes(0x0a), false);
});

test("an initial SSE BOM is ignored for parsing and preserved in output", async () => {
  const { namespaces } = flattenNamespaceTools([
    {
      type: "namespace",
      name: "collaboration",
      tools: [
        { type: "function", name: "spawn_agent" },
        { type: "function", name: "interrupt_agent" },
      ],
    },
  ]);
  const bom = Buffer.from([0xef, 0xbb, 0xbf]);
  const matching = Buffer.concat([
    bom,
    Buffer.from(
      'data: {"type":"response.output_item.done","item":{"type":"function_call","name":"collaboration__spawn_agent","arguments":"{}"}}\r\n\r\n',
      "utf8",
    ),
  ]);
  const rewritten = await collectBuffer(
    Readable.from([...matching].map((byte) => Buffer.from([byte]))).pipe(
      new NamespaceToolCallTransform(namespaces, "text/event-stream"),
    ),
  );
  assert.deepEqual(rewritten.subarray(0, bom.length), bom);
  assert.match(rewritten.toString("utf8"), /"namespace":"collaboration"/u);

  const disagreement = Buffer.concat([
    bom,
    Buffer.from(
      'event: response.completed\r\n' +
        'data: {"type":"response.output_item.done","item":{"type":"function_call","name":"collaboration__spawn_agent","arguments":"{}"}}\r\n\r\n' +
        'event: response.output_item.done\r\n' +
        'data: {"type":"response.output_item.done","item":{"type":"function_call","name":"collaboration__spawn_agent","arguments":"{}"}}\r\n\r\n',
      "utf8",
    ),
  ]);
  const preserved = await collectBuffer(
    Readable.from([...disagreement].map((byte) => Buffer.from([byte]))).pipe(
      new NamespaceToolCallTransform(namespaces, "text/event-stream", undefined, {
        pendingInterrupts: ["/root/finished"],
      }),
    ),
  );
  assert.deepEqual(preserved, disagreement);
});

test("colonless event and data fields participate in repeated-field ambiguity", async () => {
  const { namespaces } = flattenNamespaceTools([
    {
      type: "namespace",
      name: "collaboration",
      tools: [{ type: "function", name: "spawn_agent" }],
    },
  ]);
  const data =
    'data: {"type":"response.output_item.done","item":{"type":"function_call","name":"collaboration__spawn_agent","arguments":"{}"}}\r\n';
  const later = `${data}\r\n`;
  for (const ambiguous of [
    `data\r\n${data}\r\n`,
    `event\r\nevent: response.output_item.done\r\n${data}\r\n`,
  ]) {
    const source = Buffer.from(ambiguous + later, "utf8");
    const output = await collectBuffer(
      Readable.from([...source].map((byte) => Buffer.from([byte]))).pipe(
        new NamespaceToolCallTransform(namespaces, "text/event-stream"),
      ),
    );
    assert.deepEqual(output, source);
  }
});

test("duplicate embedded interrupt arguments cannot steer terminal injection state", async () => {
  const { namespaces } = flattenNamespaceTools([
    {
      type: "namespace",
      name: "collaboration",
      tools: [{ type: "function", name: "interrupt_agent" }],
    },
  ]);
  const ambiguousArguments =
    '{"target":"/root/first","\\u0074arget":"/root/second"}';
  const ambiguousCall = {
    type: "function_call",
    name: "interrupt_agent",
    namespace: "collaboration",
    call_id: "call_ambiguous",
    arguments: ambiguousArguments,
  };
  const pendingInterrupts = ["/root/first", "/root/second"];

  const events = [
    {
      type: "response.output_item.done",
      sequence_number: 1,
      item: ambiguousCall,
    },
    {
      type: "response.completed",
      sequence_number: 2,
      response: { output: [ambiguousCall] },
    },
  ];
  const sse = Buffer.from(
    events
      .map((event) => `event: ${event.type}\r\ndata: ${JSON.stringify(event)}\r\n\r\n`)
      .join(""),
    "utf8",
  );
  const streamed = await collectBuffer(
    Readable.from([...sse].map((byte) => Buffer.from([byte]))).pipe(
      new NamespaceToolCallTransform(namespaces, "text/event-stream", undefined, {
        pendingInterrupts,
      }),
    ),
  );
  assert.deepEqual(streamed, sse);

  const jsonBody = Buffer.from(
    JSON.stringify({ id: "resp_ambiguous", output: [ambiguousCall] }),
    "utf8",
  );
  const jsonOutput = await collectBuffer(
    Readable.from([jsonBody]).pipe(
      new NamespaceToolCallTransform(namespaces, "application/json", undefined, {
        pendingInterrupts,
      }),
    ),
  );
  assert.deepEqual(jsonOutput, jsonBody);
});

test("changed SSE retains provider CRLF framing", async () => {
  const { namespaces } = flattenNamespaceTools([
    {
      type: "namespace",
      name: "collaboration",
      tools: [{ type: "function", name: "spawn_agent" }],
    },
  ]);
  const source = Buffer.from(
    'event: response.output_item.done\r\n' +
      'id: provider-id\r\n' +
      'data: { "type": "response.output_item.done", "item": { "type": "function_call", "name": "collaboration__spawn_agent", "arguments": "{}" } }\r\n' +
      "\r\n",
    "utf8",
  );
  const output = await collectBuffer(
    Readable.from([source.subarray(0, 13), source.subarray(13)]).pipe(
      new NamespaceToolCallTransform(namespaces, "text/event-stream"),
    ),
  );
  const text = output.toString("utf8");
  assert.match(text, /"name":"spawn_agent"/);
  assert.match(text, /"namespace":"collaboration"/);
  assert.ok(text.startsWith("event: response.output_item.done\r\nid: provider-id\r\n"));
  for (let index = 0; index < output.length; index += 1) {
    if (output[index] === 0x0a) assert.equal(output[index - 1], 0x0d);
  }
});

test("interrupt injection adopts the provider's CRLF framing", async () => {
  const { namespaces } = flattenNamespaceTools([
    {
      type: "namespace",
      name: "collaboration",
      tools: [{ type: "function", name: "interrupt_agent" }],
    },
  ]);
  const source = Buffer.from(
    'event: response.completed\r\n' +
      'data: {"type":"response.completed","sequence_number":7,"response":{"output":[]}}\r\n' +
      "\r\n",
    "utf8",
  );
  const output = await collectBuffer(
    Readable.from([source]).pipe(
      new NamespaceToolCallTransform(namespaces, "text/event-stream", undefined, {
        pendingInterrupts: ["/root/finished"],
      }),
    ),
  );
  assert.match(output.toString("utf8"), /"name":"interrupt_agent"/);
  for (let index = 0; index < output.length; index += 1) {
    if (output[index] === 0x0a) assert.equal(output[index - 1], 0x0d);
  }
});

test("EOF interrupt injection separates an unterminated final SSE frame", async () => {
  const { namespaces } = flattenNamespaceTools([
    {
      type: "namespace",
      name: "collaboration",
      tools: [{ type: "function", name: "interrupt_agent" }],
    },
  ]);
  for (const lineEnding of ["", "\n", "\r", "\r\n"]) {
    const source = Buffer.from(
      `data: {"type":"response.created","sequence_number":1}${lineEnding}`,
      "utf8",
    );
    const output = await collectBuffer(
      Readable.from([source]).pipe(
        new NamespaceToolCallTransform(namespaces, "text/event-stream", undefined, {
          pendingInterrupts: ["/root/finished"],
        }),
      ),
    );
    const separator = lineEnding || "\n\n";
    assert.deepEqual(output.subarray(0, source.length), source, JSON.stringify(lineEnding));
    assert.ok(
      output
        .subarray(source.length)
        .toString("utf8")
        .startsWith(`${separator}event: response.output_item.added${lineEnding || "\n"}`),
      JSON.stringify(lineEnding),
    );
    assert.match(output.toString("utf8"), /"name":"interrupt_agent"/u);
  }
});

test(
  "dense LF-only SSE frames are scanned within a linear-time bound",
  { timeout: 3000 },
  async () => {
    const source = Buffer.from(`:x\n`.repeat(Math.floor((512 * 1024) / 3) - 1) + "\n");
    const output = await collectBuffer(
      Readable.from([source]).pipe(
        new NamespaceToolCallTransform(new Map(), "text/event-stream", undefined, {
          maxSseFrameBytes: source.length + 1,
        }),
      ),
    );
    assert.deepEqual(output, source);
  },
);

test("oversized SSE framing releases bytes and disables later rewrites", async () => {
  const { namespaces } = flattenNamespaceTools([
    {
      type: "namespace",
      name: "collaboration",
      tools: [{ type: "function", name: "spawn_agent" }],
    },
  ]);
  const source = Buffer.from(
    `data: ${"x".repeat(40)}\n\n` +
      'data: {"type":"response.output_item.done","item":{"type":"function_call","name":"collaboration__spawn_agent","arguments":"{}"}}\n\n',
    "utf8",
  );
  const output = await collectBuffer(
    Readable.from([source]).pipe(
      new NamespaceToolCallTransform(namespaces, "text/event-stream", undefined, {
        maxSseFrameBytes: 32,
      }),
    ),
  );
  assert.deepEqual(output, source);
});

test("large terminal SSE frames remain valid after a namespace rewrite", async () => {
  const { namespaces } = flattenNamespaceTools([
    {
      type: "namespace",
      name: "collaboration",
      tools: [{ type: "function", name: "spawn_agent" }],
    },
  ]);
  const call = {
    type: "function_call",
    id: "fc_large_terminal",
    call_id: "call_large_terminal",
    name: "collaboration__spawn_agent",
    arguments: "{}",
  };
  const events = [
    { type: "response.output_item.done", item: call },
    {
      type: "response.completed",
      response: {
        output: [
          call,
          {
            type: "message",
            id: "msg_large_terminal",
            content: [{ type: "output_text", text: "x".repeat(320 * 1024) }],
          },
        ],
      },
    },
  ];
  const frames = events.map((event) =>
    Buffer.from(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`, "utf8"),
  );
  assert.ok(frames[1].length > 256 * 1024);

  const output = await collect(
    Readable.from(frames).pipe(
      new NamespaceToolCallTransform(namespaces, "text/event-stream"),
    ),
  );
  const payloads = output
    .split("\n")
    .filter((line) => line.startsWith("data: "))
    .map((line) => JSON.parse(line.slice(6)));
  assert.equal(payloads.length, 2);
  assert.equal(payloads[0].item.namespace, "collaboration");
  assert.equal(payloads[1].response.output[0].namespace, "collaboration");
  assert.equal(payloads[1].response.output[1].content[0].text.length, 320 * 1024);
});

test("unterminated oversized SSE frames release or fail at a fixed byte bound", async () => {
  const limit = 64 * 1024;
  const marker = "unterminated-oversized-frame-must-not-leak";
  const oversized = Buffer.from(
    `data: {"marker":"${marker}","padding":"${"x".repeat(limit * 2)}`,
    "utf8",
  );
  const precommit = await collectBuffer(
    Readable.from([oversized]).pipe(
      new NamespaceToolCallTransform(new Map(), "text/event-stream", undefined, {
        maxSseFrameBytes: limit,
      }),
    ),
  );
  assert.deepEqual(precommit, oversized);

  const { namespaces } = flattenNamespaceTools([
    {
      type: "namespace",
      name: "collaboration",
      tools: [{ type: "function", name: "spawn_agent" }],
    },
  ]);
  const committed = Buffer.from(
    'event: response.output_item.done\n' +
      'data: {"type":"response.output_item.done","item":{"type":"function_call","name":"collaboration__spawn_agent","arguments":"{}"}}\n\n',
    "utf8",
  );
  const { output, error } = await collectUntilPipelineError(
    [committed, oversized],
    new NamespaceToolCallTransform(namespaces, "text/event-stream", undefined, {
      maxSseFrameBytes: limit,
    }),
  );
  assert.equal(error.code, "ERR_NAMESPACE_RELAY_COMMITTED_STREAM");
  assert.match(output.toString("utf8"), /"namespace":"collaboration"/u);
  assert.doesNotMatch(output.toString("utf8"), new RegExp(marker, "u"));
});

test("post-rewrite ambiguity errors without leaking raw custom lifecycle bytes", async () => {
  const namespaces = new Map();
  bridgeCustomTools([{ type: "custom", name: "apply_patch" }], [], namespaces);
  const committed = Buffer.from(
    'event: response.output_item.added\n' +
      'data: {"type":"response.output_item.added","item":{"type":"function_call","id":"fc_guard","call_id":"call_guard","name":"apply_patch","arguments":""}}\n\n',
    "utf8",
  );
  const marker = "flattened-done-must-not-leak";
  const ambiguousFrames = [
    Buffer.from(
      'event: response.output_item.done\n' +
        `data: {"type":"response.output_item.done","raw_marker":"${marker}","item":{"type":"function_call","name":"apply_patch"\n\n`,
      "utf8",
    ),
    Buffer.from(
      'event: response.output_item.done\n' +
        `data: {"type":"response.output_item.done","raw_marker":"${marker}","item":{"type":"function_call","name":"ordinary","\\u006eame":"apply_patch","arguments":"{}"}}\n\n`,
      "utf8",
    ),
    Buffer.concat([
      Buffer.from(
        'event: response.output_item.done\n' +
          `data: {"type":"response.output_item.done","raw_marker":"${marker}","item":{"type":"function_call","name":"apply_patch","note":"`,
        "utf8",
      ),
      Buffer.from([0xff]),
      Buffer.from('","arguments":"{}"}}\n\n', "utf8"),
    ]),
    Buffer.from(
      'event: response.output_item.done\n' +
        `data: {"type":"response.output_item.done","raw_marker":"${marker}","item":{"type":"function_call","name":"apply_patch","arguments":"{}"}}\n` +
        'data: {"competing":true}\n\n',
      "utf8",
    ),
    Buffer.from(
      `data: {"type":"response.output_item.done","raw_marker":"${marker}"`,
      "utf8",
    ),
    Buffer.from(
      'event: response.output_item.done\n' +
        `data: {"type":"response.output_item.done","raw_marker":"${marker}","item":{"type":"function_call","name":"apply_patch","arguments":"{}"},"padding":"${"x".repeat(1024)}"}\n\n`,
      "utf8",
    ),
  ];

  for (const ambiguous of ambiguousFrames) {
    const source = Buffer.concat([committed, ambiguous]);
    const { output, error } = await collectUntilPipelineError(
      [...source].map((byte) => Buffer.from([byte])),
      new NamespaceToolCallTransform(namespaces, "text/event-stream", undefined, {
        maxSseFrameBytes: 512,
      }),
    );
    assert.equal(error.code, "ERR_NAMESPACE_RELAY_COMMITTED_STREAM");
    const text = output.toString("utf8");
    assert.match(text, /"type":"custom_tool_call"/u);
    assert.doesNotMatch(text, new RegExp(marker, "u"));
    assert.doesNotMatch(text, /response\.output_item\.done/u);
  }
});

test("suppression and injection also commit the SSE safety boundary", async () => {
  const marker = "post-commit-ambiguity-must-not-leak";
  const ambiguous = Buffer.from(
    'event: response.output_item.done\n' +
      `data: {"type":"response.output_item.done","raw_marker":"${marker}"\n\n`,
    "utf8",
  );

  const suppressionPrefix = Buffer.from(
    'event: response.output_item.added\n' +
      'data: {"type":"response.output_item.added","item":{"type":"custom_tool_call","id":"fc_native","call_id":"call_native","name":"apply_patch","input":""}}\n\n' +
      'event: response.function_call_arguments.delta\n' +
      'data: {"type":"response.function_call_arguments.delta","item_id":"fc_native","delta":"{\\"input\\":\\""}\n\n',
    "utf8",
  );
  const suppressed = await collectUntilPipelineError(
    [suppressionPrefix, ambiguous],
    new NamespaceToolCallTransform(new Map(), "text/event-stream"),
  );
  assert.equal(suppressed.error.code, "ERR_NAMESPACE_RELAY_COMMITTED_STREAM");
  assert.match(suppressed.output.toString("utf8"), /"type":"custom_tool_call"/u);
  assert.doesNotMatch(suppressed.output.toString("utf8"), new RegExp(marker, "u"));
  assert.doesNotMatch(
    suppressed.output.toString("utf8"),
    /response\.function_call_arguments\.delta/u,
  );

  const { namespaces } = flattenNamespaceTools([
    {
      type: "namespace",
      name: "collaboration",
      tools: [{ type: "function", name: "interrupt_agent" }],
    },
  ]);
  const injected = await collectUntilPipelineError(
    [Buffer.from("data: [DONE]\n\n", "utf8"), ambiguous],
    new NamespaceToolCallTransform(namespaces, "text/event-stream", undefined, {
      pendingInterrupts: ["/root/finished"],
    }),
  );
  assert.equal(injected.error.code, "ERR_NAMESPACE_RELAY_COMMITTED_STREAM");
  assert.match(injected.output.toString("utf8"), /"name":"interrupt_agent"/u);
  assert.doesNotMatch(injected.output.toString("utf8"), new RegExp(marker, "u"));
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

// A plain function tool reaches the provider with the same root a namespaced
// one does, and the providers that object do not care which it was. DeepSeek V4
// (Flash and Pro) both 400 a `type: ["object","null"]` root -- "schema must be a
// JSON Schema of 'type: \"object\"'" -- and xAI rejects a union root, both
// reproduced live. Repairing only the flattened children left every
// client-declared tool to fail on those providers.
test("a plain function tool's union root is repaired too", () => {
  const { tools, flattened } = flattenNamespaceTools([
    {
      type: "function",
      function: {
        name: "plain",
        parameters: {
          oneOf: [
            { type: "object", properties: { a: { type: "string" } }, required: ["a"] },
            { type: "object", properties: { b: { type: "string" } }, required: ["a"] },
          ],
        },
      },
    },
  ]);
  assert.equal(flattened, true);
  assert.equal(tools[0].function.parameters.type, "object");
  assert.equal(tools[0].function.parameters.oneOf, undefined);
  assert.deepEqual(Object.keys(tools[0].function.parameters.properties), ["a", "b"]);
});

test("a plain function tool's nullable root is repaired too", () => {
  const { tools, flattened } = flattenNamespaceTools([
    { type: "function", name: "plain", parameters: { type: ["object", "null"], properties: { a: {} } } },
  ]);
  assert.equal(flattened, true);
  assert.equal(tools[0].parameters.type, "object");
});

// The repair must not copy a tool it had nothing to fix: an ordinary root is
// the overwhelming majority, and a needless rewrite is a needless risk.
test("an ordinary function tool is passed through by identity", () => {
  const tool = {
    type: "function",
    function: { name: "plain", parameters: { type: "object", properties: { a: {} } } },
  };
  const { tools, flattened } = flattenNamespaceTools([tool]);
  assert.equal(tools[0], tool);
  assert.equal(flattened, false);
});

// Responses-native providers keep the namespace shape, so their tools never go
// through the flattening path -- but they still reach an upstream with a root
// it may reject. `opencode-go-responses/gpt-5.6-luna` 400s a
// `type: ["object","null"]` root while accepting the same request with a plain
// or union root, so the repair has to be available without flattening.
test("repairToolSchemaRoots fixes roots without flattening", () => {
  const tools = [
    { type: "function", name: "nullable", parameters: { type: ["object", "null"], properties: { a: {} } } },
    { type: "namespace", name: "codex_app", tools: [{ name: "child", inputSchema: { type: "object" } }] },
  ];
  const repaired = repairToolSchemaRoots(tools);
  assert.equal(repaired[0].parameters.type, "object");
  // The namespace entry keeps its native shape; only roots are touched.
  assert.equal(repaired[1], tools[1]);
});

test("repairToolSchemaRoots returns the original array when nothing needs repair", () => {
  const tools = [{ type: "function", name: "fine", parameters: { type: "object", properties: { a: {} } } }];
  assert.equal(repairToolSchemaRoots(tools), tools);
});

test("OpenCode search repair strips only search_content_types on web_search", () => {
  const webSearch = {
    type: "web_search",
    search_content_types: ["text", "image"],
    filters: { allowed_domains: ["example.com"] },
  };
  const preview = { type: "web_search_preview", search_content_types: ["text"] };
  const ordinary = {
    type: "function",
    name: "ordinary",
    search_content_types: ["application-specific"],
  };
  const stripped = stripSearchContentTypes([webSearch, preview, ordinary]);
  assert.deepEqual(stripped[0], {
    type: "web_search",
    filters: { allowed_domains: ["example.com"] },
  });
  assert.deepEqual(stripped[1], preview);
  assert.deepEqual(stripped[2], ordinary);
});

test("OpenCode input repair preserves collaboration text and inherited images", () => {
  const agent = {
    type: "agent_message",
    id: "amsg_1",
    author: "/root",
    recipient: "/root/reviewer",
    content: [
      { type: "input_text", text: "Message Type: NEW_TASK\nPayload:\nEdit it." },
      {
        type: "input_image",
        image_url: "data:image/png;base64,AAA",
        detail: "original",
      },
    ],
  };
  const publicInput = agentMessagesAsUserMessages([agent]);
  assert.deepEqual(publicInput[0], {
    type: "message",
    role: "user",
    content: agent.content,
  });
  const compatible = downgradeOriginalImageDetail(publicInput);
  assert.deepEqual(compatible[0].content[0], agent.content[0]);
  assert.equal(compatible[0].content[1].image_url, "data:image/png;base64,AAA");
  assert.equal(compatible[0].content[1].detail, "auto");
});

// Codex ships apply_patch as a custom tool whose lark grammar is the only
// place the V4A patch dialect is written down: the native definition carries
// no description at all. A fixture with a permissive `start: /.+/` and a
// friendly description would pass while the bridge threw the real spec away,
// so use the shape Codex actually sends.
const V4A_GRAMMAR = [
  "start: begin_patch hunk+ end_patch",
  'begin_patch: "*** Begin Patch" LF',
  'end_patch: "*** End Patch" LF?',
  "",
  "hunk: add_hunk | delete_hunk | update_hunk",
  'add_hunk: "*** Add File: " filename LF add_line+',
  'delete_hunk: "*** Delete File: " filename LF',
  'update_hunk: "*** Update File: " filename LF change_move? change?',
  "filename: /(.+)/",
  'add_line: "+" /(.+)/ LF -> line',
  "",
  'change_move: "*** Move to: " filename LF',
  "change: (change_context | change_line)+ eof_line?",
  'change_context: ("@@" | "@@ " /(.+)/) LF',
  'change_line: ("+" | "-" | " ") /(.+)/ LF',
  'eof_line: "*** End of File" LF',
  "",
  "%import common.LF",
].join("\n");

test("custom-tool bridge maps apply_patch definitions and paired history losslessly", () => {
  const namespaces = new Map();
  const patch = "*** Begin Patch\n*** Update File: seed.txt\n@@\n-before\n+after\n*** End Patch";
  const ordinary = { type: "function", name: "read_file", parameters: { type: "object" } };
  const unrelatedCall = {
    type: "function_call",
    name: "read_file",
    call_id: "call_read",
    arguments: '{"path":"seed.txt"}',
  };
  const bridged = bridgeCustomTools(
    [
      {
        type: "custom",
        name: "apply_patch",
        format: { type: "grammar", syntax: "lark", definition: V4A_GRAMMAR },
      },
      ordinary,
    ],
    [
      {
        type: "custom_tool_call",
        id: "ctc_1",
        call_id: "call_patch_1",
        name: "apply_patch",
        input: patch,
      },
      { type: "custom_tool_call_output", call_id: "call_patch_1", output: "Done!" },
      unrelatedCall,
    ],
    namespaces,
    { type: "custom", name: "apply_patch" },
  );
  assert.deepEqual(bridged.tools[0].parameters.required, ["input"]);
  assert.equal(bridged.tools[0].format, undefined);
  // A function tool has no grammar slot, so the definition has to survive in
  // the description or the model is told nothing about the patch format.
  assert.ok(bridged.tools[0].description.includes(V4A_GRAMMAR));
  assert.match(bridged.tools[0].description, /lark grammar/);
  assert.deepEqual(bridged.tools[1], ordinary);
  assert.deepEqual(bridged.toolChoice, { type: "function", name: "apply_patch" });
  assert.deepEqual(bridged.input[0], {
    id: "ctc_1",
    call_id: "call_patch_1",
    type: "function_call",
    name: "apply_patch",
    arguments: JSON.stringify({ input: patch }),
  });
  assert.equal(bridged.input[1].type, "function_call_output");
  assert.deepEqual(bridged.input[2], unrelatedCall);
  assert.equal(buildNamespaceLookups(namespaces).customTools.get("apply_patch"), "apply_patch");
});

test("custom-tool bridge avoids hijacking an ordinary apply_patch function", () => {
  const namespaces = new Map();
  const ordinary = { type: "function", name: "apply_patch", parameters: { type: "object" } };
  const bridged = bridgeCustomTools(
    [ordinary, { type: "custom", name: "apply_patch" }],
    [],
    namespaces,
  );
  assert.deepEqual(bridged.tools[0], ordinary);
  assert.equal(bridged.tools[1].name, "codex_custom_apply_patch");
  assert.equal(
    buildNamespaceLookups(namespaces).customTools.get("codex_custom_apply_patch"),
    "apply_patch",
  );
});

test("custom-tool bridge bounds its provider alias and restores the native custom call", () => {
  const nativeName = "custom_freeform_tool_with_a_name_that_is_deliberately_longer_than_sixty_four_chars";
  const flattened = flattenNamespaceTools([], { maxNameLength: 64 });
  const bridged = bridgeCustomTools(
    [{ type: "custom", name: nativeName }],
    [
      {
        type: "custom_tool_call",
        name: nativeName,
        call_id: "custom-long",
        input: "raw input",
      },
    ],
    flattened.namespaces,
    { type: "custom", name: nativeName },
    [nativeName],
    { maxNameLength: 64 },
  );
  const alias = bridged.tools[0].name;
  assert.equal(alias.length, 64);
  assert.deepEqual(bridged.toolChoice, { type: "function", name: alias });
  assert.equal(bridged.input[0].name, alias);

  const restored = rewriteNamespaceResponsePayload(
    {
      output: [
        {
          type: "function_call",
          name: alias,
          call_id: "custom-result",
          arguments: '{"input":"raw input"}',
        },
      ],
    },
    buildNamespaceLookups(flattened.namespaces),
  );
  assert.deepEqual(restored.output[0], {
    type: "custom_tool_call",
    name: nativeName,
    call_id: "custom-result",
    input: "raw input",
  });
});

test("custom-tool bridge rewrites native entries inside allowed_tools", () => {
  const nativeName = "custom_freeform_tool_with_a_name_that_is_deliberately_longer_than_sixty_four_chars";
  const flattened = flattenNamespaceTools([], { maxNameLength: 64 });
  const bridged = bridgeCustomTools(
    [{ type: "custom", name: nativeName }],
    [],
    flattened.namespaces,
    {
      type: "allowed_tools",
      mode: "required",
      tools: [
        { type: "custom", name: nativeName },
        { type: "function", name: "ordinary" },
      ],
    },
    [nativeName],
    { maxNameLength: 64 },
  );
  const alias = bridged.tools[0].name;
  assert.equal(alias.length, 64);
  assert.deepEqual(bridged.toolChoice, {
    type: "allowed_tools",
    mode: "required",
    tools: [
      { type: "function", name: alias },
      { type: "function", name: "ordinary" },
    ],
  });
});

test("flattened custom choices cannot be retargeted to a same-named namespace child", () => {
  const flattened = flattenNamespaceTools(
    [
      {
        type: "namespace",
        name: "mcp__files",
        tools: [{ type: "function", name: "apply_patch" }],
      },
      { type: "custom", name: "apply_patch" },
    ],
    { maxNameLength: 64 },
  );
  const forced = bridgeCustomTools(
    flattened.tools,
    [],
    flattened.namespaces,
    { type: "custom", name: "apply_patch" },
    undefined,
    { maxNameLength: 64 },
  );
  assert.deepEqual(
    flattenToolChoice(forced.toolChoice, flattened.namespaces),
    { type: "function", name: "apply_patch" },
  );

  const allowed = bridgeCustomTools(
    flattened.tools,
    [],
    flattened.namespaces,
    {
      type: "allowed_tools",
      mode: "required",
      tools: [{ type: "custom", name: "apply_patch" }],
    },
    undefined,
    { maxNameLength: 64 },
  );
  assert.deepEqual(
    flattenToolChoice(allowed.toolChoice, flattened.namespaces),
    {
      type: "allowed_tools",
      mode: "required",
      tools: [{ type: "function", name: "apply_patch" }],
    },
  );
});

test("strict custom bridging covers non-apply_patch definitions, history, and choices", () => {
  const flattened = flattenNamespaceTools([], { maxNameLength: 64 });
  const bridged = bridgeCustomTools(
    [
      {
        type: "custom",
        name: "future_custom",
        description: "A future freeform tool.",
      },
    ],
    [
      {
        type: "custom_tool_call",
        name: "future_custom",
        call_id: "future-call",
        input: "opaque",
      },
      {
        type: "custom_tool_call_output",
        call_id: "future-call",
        output: "done",
      },
    ],
    flattened.namespaces,
    { type: "custom", name: "future_custom" },
    undefined,
    { maxNameLength: 64, bridgeAll: true },
  );
  assert.deepEqual(bridged.tools[0].parameters.required, ["input"]);
  assert.deepEqual(bridged.toolChoice, { type: "function", name: "future_custom" });
  assert.equal(bridged.input[0].type, "function_call");
  assert.deepEqual(JSON.parse(bridged.input[0].arguments), { input: "opaque" });
  assert.equal(bridged.input[1].type, "function_call_output");
});

test("custom-tool bridge reserves native namespace names and restores the aliased call", () => {
  const namespaces = new Map();
  const namespace = {
    type: "namespace",
    name: "apply_patch",
    tools: [{ type: "function", name: "inspect", inputSchema: { type: "object" } }],
  };
  const bridged = bridgeCustomTools(
    [namespace, { type: "custom", name: "apply_patch" }],
    [],
    namespaces,
    { type: "custom", name: "apply_patch" },
  );

  assert.deepEqual(bridged.tools[0], namespace);
  assert.equal(bridged.tools[1].name, "codex_custom_apply_patch");
  assert.deepEqual(bridged.toolChoice, {
    type: "function",
    name: "codex_custom_apply_patch",
  });
  const rewritten = rewriteNamespaceResponsePayload(
    {
      output: [
        {
          type: "function_call",
          id: "fc_patch_json",
          call_id: "call_patch_json",
          name: "codex_custom_apply_patch",
          arguments: JSON.stringify({ input: "*** Begin Patch\n*** End Patch" }),
        },
      ],
    },
    buildNamespaceLookups(namespaces),
  );
  assert.deepEqual(rewritten.output[0], {
    type: "custom_tool_call",
    id: "fc_patch_json",
    call_id: "call_patch_json",
    name: "apply_patch",
    input: "*** Begin Patch\n*** End Patch",
  });
});

test("one-byte fragmented SSE preserves escaped and multibyte custom input", async () => {
  const namespaces = new Map();
  bridgeCustomTools([{ type: "custom", name: "apply_patch" }], [], namespaces);
  const patch =
    "*** Begin Patch\n+quote=\"yes\" slash=\\ tab=\t snowman=☃ emoji=🧩\n*** End Patch";
  const argumentsText = JSON.stringify({ input: patch });
  const fragments = [];
  for (let index = 0; index < argumentsText.length; index += 1) {
    fragments.push(argumentsText.slice(index, index + 1));
  }
  const events = [
    {
      type: "response.output_item.added",
      item: {
        type: "function_call",
        id: "fc_1",
        call_id: "call_patch_1",
        name: "apply_patch",
        arguments: "",
      },
    },
    ...fragments.map((delta) => ({
      type: "response.function_call_arguments.delta",
      item_id: "fc_1",
      delta,
    })),
    {
      type: "response.function_call_arguments.done",
      item_id: "fc_1",
      arguments: argumentsText,
    },
    {
      type: "response.output_item.done",
      item: {
        type: "function_call",
        id: "fc_1",
        call_id: "call_patch_1",
        name: "apply_patch",
        arguments: argumentsText,
      },
    },
  ];
  const source = events
    .map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
    .join("");
  const sourceBytes = Buffer.from(source, "utf8");
  const chunks = [];
  for (let index = 0; index < sourceBytes.length; index += 1) {
    chunks.push(sourceBytes.subarray(index, index + 1));
  }
  const transform = new NamespaceToolCallTransform(namespaces, "text/event-stream");
  const output = await collect(Readable.from(chunks).pipe(transform));
  const blocks = output.split(/\n\n/).filter(Boolean);
  const payloads = blocks.map((block) => {
    const data = block.split("\n").find((line) => line.startsWith("data: "));
    return JSON.parse(data.slice(6));
  });
  assert.equal(payloads[0].item.type, "custom_tool_call");
  const deltas = payloads
    .filter((event) => event.type === "response.custom_tool_call_input.delta")
    .map((event) => event.delta)
    .join("");
  assert.equal(deltas, patch);
  const done = payloads.find(
    (event) => event.type === "response.custom_tool_call_input.done",
  );
  assert.equal(done.input, patch);
  assert.equal(payloads.at(-1).item.type, "custom_tool_call");
  assert.equal(payloads.at(-1).item.input, patch);
  assert.doesNotMatch(output, /response\.function_call_arguments/);
  assert.match(output, /event: response\.custom_tool_call_input\.delta/);
  assert.match(output, /event: response\.custom_tool_call_input\.done/);
});

test("native custom-tool streams accept LiteLLM content-wrapped legacy argument events", async () => {
  const input = "console.log(6 * 7);\n";
  const argumentsText = JSON.stringify({ content: input });
  const events = [
    {
      type: "response.output_item.added",
      output_index: 0,
      item: {
        type: "custom_tool_call",
        id: "call_native_custom",
        call_id: "call_native_custom",
        name: "exec",
        status: "in_progress",
        input: "",
      },
    },
    ...[...argumentsText].map((delta) => ({
      type: "response.function_call_arguments.delta",
      item_id: "call_native_custom",
      output_index: 0,
      delta,
    })),
    {
      type: "response.function_call_arguments.done",
      item_id: "call_native_custom",
      output_index: 0,
      arguments: argumentsText,
    },
    {
      type: "response.output_item.done",
      output_index: 0,
      item: {
        type: "custom_tool_call",
        id: "call_native_custom",
        call_id: "call_native_custom",
        name: "exec",
        status: "completed",
        input,
      },
    },
  ];
  const source = events
    .map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
    .join("");
  const transform = new NamespaceToolCallTransform(new Map(), "text/event-stream");
  const output = await collect(Readable.from([source]).pipe(transform));
  const payloads = output.split(/\n\n/).filter(Boolean).map((block) => {
    const data = block.split("\n").find((line) => line.startsWith("data: "));
    return JSON.parse(data.slice(6));
  });
  assert.equal(payloads[0].item.type, "custom_tool_call");
  assert.equal(
    payloads.filter((event) => event.type === "response.custom_tool_call_input.delta")
      .map((event) => event.delta).join(""),
    input,
  );
  assert.equal(
    payloads.find((event) => event.type === "response.custom_tool_call_input.done")?.input,
    input,
  );
  assert.equal(payloads.at(-1).item.input, input);
  assert.doesNotMatch(output, /response\.function_call_arguments/u);
});

test("native custom-tool legacy arguments still fail closed when streamed input changes", async () => {
  const opening = {
    type: "response.output_item.added",
    output_index: 0,
    item: {
      type: "custom_tool_call",
      id: "call_native_mismatch",
      call_id: "call_native_mismatch",
      name: "exec",
      status: "in_progress",
      input: "",
    },
  };
  const streamed = JSON.stringify({ content: "first" });
  const completed = JSON.stringify({ content: "second" });
  const frames = [
    opening,
    {
      type: "response.function_call_arguments.delta",
      item_id: "call_native_mismatch",
      output_index: 0,
      delta: streamed,
    },
    {
      type: "response.function_call_arguments.done",
      item_id: "call_native_mismatch",
      output_index: 0,
      arguments: completed,
    },
  ].map((event) => `data: ${JSON.stringify(event)}\n\n`);
  const { error } = await collectUntilPipelineError(
    frames,
    new NamespaceToolCallTransform(new Map(), "text/event-stream"),
  );
  assert.equal(error.code, "ERR_NAMESPACE_RELAY_COMMITTED_STREAM");
  assert.match(error.message, /custom tool argument deltas disagree with completed input/u);
});

test("a bridged custom tool without a grammar carries only what it was given", () => {
  const namespaces = new Map();
  const described = bridgeCustomTools(
    [{ type: "custom", name: "apply_patch", description: "Apply a patch." }],
    [],
    namespaces,
  );
  assert.equal(described.tools[0].description, "Apply a patch.");

  const bare = bridgeCustomTools([{ type: "custom", name: "apply_patch" }], [], new Map());
  assert.equal("description" in bare.tools[0], false);
});

test("a bridged custom tool keeps its description above the grammar", () => {
  const namespaces = new Map();
  const bridged = bridgeCustomTools(
    [
      {
        type: "custom",
        name: "apply_patch",
        description: "Apply a patch.",
        format: { type: "grammar", syntax: "lark", definition: V4A_GRAMMAR },
      },
    ],
    [],
    namespaces,
  );
  const { description } = bridged.tools[0];
  assert.ok(description.startsWith("Apply a patch.\n\n"));
  assert.ok(description.endsWith(V4A_GRAMMAR));
  assert.match(description, /`input` string is freeform text, not JSON/);
});

test("malformed bridged arguments fail closed after a custom_tool_call opens", async () => {
  const namespaces = new Map();
  bridgeCustomTools([{ type: "custom", name: "apply_patch" }], [], namespaces);
  const argumentsText = JSON.stringify({ patch: "*** Begin Patch\n*** End Patch" });
  const events = [
    {
      type: "response.output_item.added",
      item: {
        type: "function_call",
        id: "fc_bad",
        call_id: "call_bad",
        name: "apply_patch",
        arguments: "",
      },
    },
    { type: "response.function_call_arguments.delta", item_id: "fc_bad", delta: argumentsText },
    { type: "response.function_call_arguments.done", item_id: "fc_bad", arguments: argumentsText },
    {
      type: "response.output_item.done",
      item: {
        type: "function_call",
        id: "fc_bad",
        call_id: "call_bad",
        name: "apply_patch",
        arguments: argumentsText,
      },
    },
  ];
  const source = events
    .map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
    .join("");
  const { output, error } = await collectUntilPipelineError(
    [Buffer.from(source, "utf8")],
    new NamespaceToolCallTransform(namespaces, "text/event-stream"),
  );
  assert.equal(error.code, "ERR_NAMESPACE_RELAY_COMMITTED_STREAM");
  assert.equal(error.status, 502);
  assert.match(output.toString("utf8"), /"type":"custom_tool_call"/u);
  assert.doesNotMatch(output.toString("utf8"), /function_call_arguments\.done/u);
  assert.doesNotMatch(output.toString("utf8"), /response\.output_item\.done/u);
});

test("special relay identities cannot be reused or changed after conversion", async () => {
  const namespaces = new Map();
  bridgeCustomTools([{ type: "custom", name: "apply_patch" }], [], namespaces);
  const argumentsText = JSON.stringify({ input: "*** Begin Patch\n*** End Patch" });
  const open = {
    type: "response.output_item.added",
    item: {
      type: "function_call",
      id: "fc_identity",
      call_id: "call_identity",
      name: "apply_patch",
      arguments: "",
    },
  };
  const close = {
    type: "response.output_item.done",
    item: {
      type: "function_call",
      id: "fc_identity",
      call_id: "call_identity",
      name: "apply_patch",
      arguments: argumentsText,
    },
  };
  const cases = [
    {
      name: "duplicate-item-id",
      events: [
        open,
        {
          type: "response.output_item.added",
          marker: "duplicate-item-id",
          item: {
            type: "function_call",
            id: "fc_identity",
            call_id: "call_ordinary",
            name: "exec_command",
            arguments: "",
          },
        },
      ],
    },
    {
      name: "duplicate-call-id",
      events: [
        open,
        {
          type: "response.output_item.added",
          marker: "duplicate-call-id",
          item: {
            type: "function_call",
            id: "fc_ordinary",
            call_id: "call_identity",
            name: "exec_command",
            arguments: "",
          },
        },
      ],
    },
    {
      name: "mismatched-close",
      events: [
        open,
        {
          ...close,
          marker: "mismatched-close",
          item: { ...close.item, call_id: "call_other" },
        },
      ],
    },
    {
      name: "mismatched-arguments",
      events: [
        open,
        {
          type: "response.function_call_arguments.done",
          marker: "mismatched-arguments",
          item_id: "fc_other",
          call_id: "call_identity",
          arguments: argumentsText,
        },
      ],
    },
    {
      name: "mismatched-delta-content",
      events: [
        open,
        {
          type: "response.function_call_arguments.delta",
          item_id: "fc_identity",
          call_id: "call_identity",
          delta: JSON.stringify({ input: "first" }),
        },
        {
          type: "response.function_call_arguments.done",
          marker: "mismatched-delta-content",
          item_id: "fc_identity",
          call_id: "call_identity",
          arguments: JSON.stringify({ input: "second" }),
        },
      ],
    },
    {
      name: "mixed-native-delta",
      events: [
        open,
        {
          type: "response.custom_tool_call_input.delta",
          marker: "mixed-native-delta",
          item_id: "fc_identity",
          call_id: "call_identity",
          delta: "patch",
        },
      ],
    },
    {
      name: "duplicate-close",
      events: [open, close, { ...close, marker: "duplicate-close" }],
    },
    {
      name: "mismatched-completed-summary",
      events: [
        open,
        close,
        {
          type: "response.completed",
          marker: "mismatched-completed-summary",
          response: {
            output: [
              {
                type: "function_call",
                id: "fc_identity",
                call_id: "call_identity",
                name: "exec_command",
                arguments: "{}",
              },
            ],
          },
        },
      ],
    },
  ];

  for (const fixture of cases) {
    const source = fixture.events
      .map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
      .join("");
    const { output, error } = await collectUntilPipelineError(
      [Buffer.from(source, "utf8")],
      new NamespaceToolCallTransform(namespaces, "text/event-stream"),
    );
    assert.equal(error.code, "ERR_NAMESPACE_RELAY_COMMITTED_STREAM", fixture.name);
    assert.match(output.toString("utf8"), /"type":"custom_tool_call"/u);
    assert.doesNotMatch(output.toString("utf8"), new RegExp(fixture.name, "u"));
  }

  const ordinaryFirst = [
    {
      type: "response.output_item.added",
      item: {
        type: "function_call",
        id: "fc_shared",
        call_id: "call_ordinary_first",
        name: "exec_command",
        arguments: "",
      },
    },
    {
      type: "response.output_item.added",
      item: {
        type: "function_call",
        id: "fc_shared",
        call_id: "call_custom_second",
        name: "apply_patch",
        arguments: "",
      },
    },
  ];
  const ordinaryFirstSource = Buffer.from(
    ordinaryFirst
      .map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
      .join(""),
    "utf8",
  );
  const ordinaryFirstOutput = await collectBuffer(
    Readable.from([ordinaryFirstSource]).pipe(
      new NamespaceToolCallTransform(namespaces, "text/event-stream"),
    ),
  );
  assert.deepEqual(ordinaryFirstOutput, ordinaryFirstSource);

  const boundedOrdinary = [
    {
      type: "response.output_item.added",
      item: { type: "message", id: "msg_1" },
    },
    {
      type: "response.output_item.added",
      item: { type: "message", id: "msg_2" },
    },
  ];
  const boundedOrdinarySource = Buffer.from(
    boundedOrdinary
      .map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
      .join(""),
    "utf8",
  );
  const boundedOrdinaryOutput = await collectBuffer(
    Readable.from([boundedOrdinarySource]).pipe(
      new NamespaceToolCallTransform(namespaces, "text/event-stream", undefined, {
        maxTrackedOutputItems: 1,
      }),
    ),
  );
  assert.deepEqual(boundedOrdinaryOutput, boundedOrdinarySource);

  const overLimit = {
    type: "response.output_item.added",
    marker: "post-commit-identity-limit",
    item: { type: "message", id: "msg_after_custom" },
  };
  const overLimitSource = [open, overLimit]
    .map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
    .join("");
  const boundedCommitted = await collectUntilPipelineError(
    [Buffer.from(overLimitSource, "utf8")],
    new NamespaceToolCallTransform(namespaces, "text/event-stream", undefined, {
      maxTrackedOutputItems: 1,
    }),
  );
  assert.equal(boundedCommitted.error.code, "ERR_NAMESPACE_RELAY_COMMITTED_STREAM");
  assert.doesNotMatch(boundedCommitted.output.toString("utf8"), /post-commit-identity-limit/u);

  const stateBounded = await collectUntilPipelineError(
    [Buffer.from(overLimitSource, "utf8")],
    new NamespaceToolCallTransform(namespaces, "text/event-stream", undefined, {
      maxTrackedStateBytes: 1024,
    }),
  );
  assert.equal(stateBounded.error.code, "ERR_NAMESPACE_RELAY_COMMITTED_STREAM");
  assert.doesNotMatch(stateBounded.output.toString("utf8"), /post-commit-identity-limit/u);
});

test(
  "closed special-call tracking retains fingerprints instead of payload-scale strings",
  { timeout: 30_000 },
  () => {
    const moduleUrl = new URL("../src/namespace-relay.mjs", import.meta.url).href;
    const script = String.raw`
      import { once } from "node:events";
      import { bridgeCustomTools, NamespaceToolCallTransform } from ${JSON.stringify(moduleUrl)};
      const namespaces = new Map();
      bridgeCustomTools([{ type: "custom", name: "apply_patch" }], [], namespaces);
      const transform = new NamespaceToolCallTransform(namespaces, "text/event-stream");
      transform.on("data", () => {});
      global.gc();
      const before = process.memoryUsage();
      let payloadCharacters = 0;
      const calls = 4096;
      for (let index = 0; index < calls; index += 1) {
        const input = String(index) + ":" +
          String.fromCharCode(65 + (index % 26)).repeat(12_000);
        payloadCharacters += input.length;
        const event = {
          type: "response.output_item.done",
          item: {
            type: "function_call",
            id: "fc_" + index,
            call_id: "call_" + index,
            name: "apply_patch",
            arguments: JSON.stringify({ input }),
          },
        };
        const frame = Buffer.from("data: " + JSON.stringify(event) + "\n\n");
        if (!transform.write(frame)) await once(transform, "drain");
      }
      global.gc();
      const after = process.memoryUsage();
      process.stdout.write(JSON.stringify({
        calls,
        payloadCharacters,
        heapDelta: after.heapUsed - before.heapUsed,
      }));
      transform.destroy();
    `;
    const child = spawnSync(
      process.execPath,
      ["--expose-gc", "--input-type=module", "--eval", script],
      { encoding: "utf8", timeout: 25_000, maxBuffer: 1024 * 1024 },
    );
    assert.equal(child.status, 0, child.stderr || child.stdout);
    const measurement = JSON.parse(child.stdout);
    assert.equal(measurement.calls, 4096);
    assert.ok(measurement.payloadCharacters > 40 * 1024 * 1024);
    assert.ok(
      measurement.heapDelta < 12 * 1024 * 1024,
      `retained heap grew by ${measurement.heapDelta} bytes for ` +
        `${measurement.payloadCharacters} payload characters`,
    );
  },
);

test("complete special closes and terminal summaries establish atomic lifecycles", async () => {
  const collaboration = {
    type: "namespace",
    name: "collaboration",
    tools: [{ type: "function", name: "spawn_agent" }],
  };
  const custom = flattenNamespaceTools([collaboration]);
  bridgeCustomTools([{ type: "custom", name: "apply_patch" }], [], custom.namespaces);
  const search = flattenNamespaceTools([collaboration, clientToolSearchControl()]);
  const specials = [
    {
      name: "custom",
      namespaces: custom.namespaces,
      item: {
        type: "function_call",
        id: "fc_done_only_custom",
        call_id: "call_done_only_custom",
        name: "apply_patch",
        arguments: JSON.stringify({ input: "patch" }),
      },
      expected: {
        type: "custom_tool_call",
        id: "fc_done_only_custom",
        call_id: "call_done_only_custom",
        name: "apply_patch",
        input: "patch",
      },
    },
    {
      name: "tool-search",
      namespaces: search.namespaces,
      item: {
        type: "function_call",
        call_id: "call_done_only_search",
        name: "tool_search",
        arguments: JSON.stringify({ query: "calendar" }),
      },
      expected: {
        type: "tool_search_call",
        call_id: "call_done_only_search",
        execution: "client",
        arguments: { query: "calendar" },
      },
    },
  ];

  for (const special of specials) {
    for (const shape of ["done", "summary"]) {
      const event =
        shape === "done"
          ? { type: "response.output_item.done", item: special.item }
          : {
              type: "response.completed",
              response: { output: [special.item] },
            };
      const output = await collect(
        Readable.from([
          `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
        ]).pipe(
          new NamespaceToolCallTransform(special.namespaces, "text/event-stream"),
        ),
      );
      const parsed = JSON.parse(
        output.split("\n").find((line) => line.startsWith("data:")).slice(5).trimStart(),
      );
      assert.deepEqual(
        shape === "done" ? parsed.item : parsed.response.output[0],
        special.expected,
        `${special.name}-${shape}`,
      );
    }

    const done = { type: "response.output_item.done", item: special.item };
    const summary = {
      type: "response.completed",
      response: { output: [special.item] },
    };
    const output = await collect(
      Readable.from(
        [done, summary].map(
          (event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
        ),
      ).pipe(
        new NamespaceToolCallTransform(special.namespaces, "text/event-stream"),
      ),
    );
    const parsed = output
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => JSON.parse(line.slice(5).trimStart()));
    assert.deepEqual(parsed[0].item, special.expected, `${special.name}-atomic-done`);
    assert.deepEqual(
      parsed[1].response.output[0],
      special.expected,
      `${special.name}-matching-summary`,
    );
  }
});

test("malformed, contradictory, or reused atomic special lifecycles fail safely", async () => {
  const collaboration = {
    type: "namespace",
    name: "collaboration",
    tools: [{ type: "function", name: "spawn_agent" }],
  };
  const custom = flattenNamespaceTools([collaboration]);
  bridgeCustomTools([{ type: "custom", name: "apply_patch" }], [], custom.namespaces);
  const search = flattenNamespaceTools([collaboration, clientToolSearchControl()]);
  const malformed = [
    {
      name: "custom-incomplete-arguments",
      namespaces: custom.namespaces,
      item: {
        type: "function_call",
        id: "fc_bad_custom_arguments",
        call_id: "call_bad_custom_arguments",
        name: "apply_patch",
        arguments: "{}",
      },
    },
    {
      name: "custom-missing-call-id",
      namespaces: custom.namespaces,
      item: {
        type: "function_call",
        id: "fc_bad_custom_identity",
        name: "apply_patch",
        arguments: JSON.stringify({ input: "patch" }),
      },
    },
    {
      name: "custom-empty-item-id",
      namespaces: custom.namespaces,
      item: {
        type: "function_call",
        id: "",
        call_id: "call_bad_custom_item_id",
        name: "apply_patch",
        arguments: JSON.stringify({ input: "patch" }),
      },
    },
    {
      name: "custom-provider-namespace",
      namespaces: custom.namespaces,
      item: {
        type: "function_call",
        namespace: "unexpected",
        call_id: "call_bad_custom_namespace",
        name: "apply_patch",
        arguments: JSON.stringify({ input: "patch" }),
      },
    },
    {
      name: "tool-search-incomplete-arguments",
      namespaces: search.namespaces,
      item: {
        type: "function_call",
        call_id: "call_bad_search_arguments",
        name: "tool_search",
        arguments: "[]",
      },
    },
    {
      name: "tool-search-missing-call-id",
      namespaces: search.namespaces,
      item: {
        type: "function_call",
        name: "tool_search",
        arguments: JSON.stringify({ query: "calendar" }),
      },
    },
  ];
  const prefix = {
    type: "response.output_item.done",
    item: {
      type: "function_call",
      name: "collaboration__spawn_agent",
      arguments: "{}",
    },
  };

  for (const fixture of malformed) {
    for (const shape of ["done", "summary"]) {
      const marker = `${fixture.name}-${shape}`;
      const event = shape === "done"
        ? { type: "response.output_item.done", marker, item: fixture.item }
        : {
            type: "response.completed",
            marker,
            response: { output: [fixture.item] },
          };
      const frame = Buffer.from(
        `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
        "utf8",
      );
      const preserved = await collectBuffer(
        Readable.from([frame]).pipe(
          new NamespaceToolCallTransform(fixture.namespaces, "text/event-stream"),
        ),
      );
      assert.deepEqual(preserved, frame, `${marker}-precommit`);

      const committedPrefix = Buffer.from(
        `event: ${prefix.type}\ndata: ${JSON.stringify(prefix)}\n\n`,
        "utf8",
      );
      const { output, error } = await collectUntilPipelineError(
        [committedPrefix, frame],
        new NamespaceToolCallTransform(fixture.namespaces, "text/event-stream"),
      );
      assert.equal(error.code, "ERR_NAMESPACE_RELAY_COMMITTED_STREAM", marker);
      assert.match(output.toString("utf8"), /"namespace":"collaboration"/u);
      assert.doesNotMatch(output.toString("utf8"), new RegExp(marker, "u"));
    }
  }

  const nonterminalSummary = {
    type: "response.in_progress",
    marker: "nonterminal-atomic-summary",
    response: {
      output: [
        {
          type: "function_call",
          id: "fc_nonterminal_summary",
          call_id: "call_nonterminal_summary",
          name: "apply_patch",
          arguments: JSON.stringify({ input: "patch" }),
        },
      ],
    },
  };
  const nonterminalFrame = Buffer.from(
    `event: ${nonterminalSummary.type}\ndata: ${JSON.stringify(nonterminalSummary)}\n\n`,
    "utf8",
  );
  const nonterminalPreserved = await collectBuffer(
    Readable.from([nonterminalFrame]).pipe(
      new NamespaceToolCallTransform(custom.namespaces, "text/event-stream"),
    ),
  );
  assert.deepEqual(nonterminalPreserved, nonterminalFrame);

  const atomicCustom = (id, callId, marker) => ({
    type: "response.output_item.done",
    marker,
    item: {
      type: "function_call",
      id,
      call_id: callId,
      name: "apply_patch",
      arguments: JSON.stringify({ input: "patch" }),
    },
  });
  const atomicOrdinary = (id, callId, marker) => ({
    type: "response.output_item.done",
    marker,
    item: {
      type: "function_call",
      id,
      call_id: callId,
      name: "exec_command",
      arguments: "{}",
    },
  });
  const first = atomicCustom("fc_atomic_first", "call_atomic_first");
  const second = atomicCustom("fc_atomic_second", "call_atomic_second");
  const crossWired = atomicCustom(
    "fc_atomic_first",
    "call_atomic_second",
    "cross-wired-atomic-identity",
  );
  const crossWiredSource = [first, second, crossWired]
    .map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
    .join("");
  const crossWiredResult = await collectUntilPipelineError(
    [Buffer.from(crossWiredSource, "utf8")],
    new NamespaceToolCallTransform(custom.namespaces, "text/event-stream"),
  );
  assert.equal(crossWiredResult.error.code, "ERR_NAMESPACE_RELAY_COMMITTED_STREAM");
  assert.doesNotMatch(
    crossWiredResult.output.toString("utf8"),
    /cross-wired-atomic-identity/u,
  );

  const summaryOnly = {
    type: "response.completed",
    response: {
      output: [atomicCustom("fc_summary_once", "call_summary_once").item],
    },
  };
  const duplicateSummary = {
    ...summaryOnly,
    marker: "duplicate-atomic-summary",
  };
  const duplicateSummarySource = [summaryOnly, duplicateSummary]
    .map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
    .join("");
  const duplicateSummaryResult = await collectUntilPipelineError(
    [Buffer.from(duplicateSummarySource, "utf8")],
    new NamespaceToolCallTransform(custom.namespaces, "text/event-stream"),
  );
  assert.equal(duplicateSummaryResult.error.code, "ERR_NAMESPACE_RELAY_COMMITTED_STREAM");
  assert.doesNotMatch(
    duplicateSummaryResult.output.toString("utf8"),
    /duplicate-atomic-summary/u,
  );

  const ordinaryThenSpecial = [
    atomicOrdinary("fc_shared_done", "call_shared_done"),
    atomicCustom(
      "fc_shared_done",
      "call_shared_done",
      "ordinary-then-special-done-reuse",
    ),
  ];
  const ordinaryThenSpecialSource = Buffer.from(
    ordinaryThenSpecial
      .map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
      .join(""),
    "utf8",
  );
  const ordinaryThenSpecialOutput = await collectBuffer(
    Readable.from([ordinaryThenSpecialSource]).pipe(
      new NamespaceToolCallTransform(custom.namespaces, "text/event-stream"),
    ),
  );
  assert.deepEqual(ordinaryThenSpecialOutput, ordinaryThenSpecialSource);

  const specialThenOrdinary = [
    atomicCustom("fc_special_first", "call_special_first"),
    atomicOrdinary(
      "fc_special_first",
      "call_special_first",
      "special-then-ordinary-done-reuse",
    ),
  ];
  const specialThenOrdinarySource = specialThenOrdinary
    .map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
    .join("");
  const specialThenOrdinaryResult = await collectUntilPipelineError(
    [Buffer.from(specialThenOrdinarySource, "utf8")],
    new NamespaceToolCallTransform(custom.namespaces, "text/event-stream"),
  );
  assert.equal(specialThenOrdinaryResult.error.code, "ERR_NAMESPACE_RELAY_COMMITTED_STREAM");
  assert.doesNotMatch(
    specialThenOrdinaryResult.output.toString("utf8"),
    /special-then-ordinary-done-reuse/u,
  );

  for (const [name, items] of [
    [
      "ordinary-then-special-summary-reuse",
      [
        atomicOrdinary("fc_shared_summary", "call_shared_summary").item,
        atomicCustom("fc_shared_summary", "call_shared_summary").item,
      ],
    ],
    [
      "special-then-ordinary-summary-reuse",
      [
        atomicCustom("fc_shared_summary", "call_shared_summary").item,
        atomicOrdinary("fc_shared_summary", "call_shared_summary").item,
      ],
    ],
  ]) {
    const event = {
      type: "response.completed",
      marker: name,
      response: { output: items },
    };
    const frame = Buffer.from(
      `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
      "utf8",
    );
    const preserved = await collectBuffer(
      Readable.from([frame]).pipe(
        new NamespaceToolCallTransform(custom.namespaces, "text/event-stream"),
      ),
    );
    assert.deepEqual(preserved, frame, `${name}-precommit`);

    const committedPrefix = Buffer.from(
      `event: ${prefix.type}\ndata: ${JSON.stringify(prefix)}\n\n`,
      "utf8",
    );
    const result = await collectUntilPipelineError(
      [committedPrefix, frame],
      new NamespaceToolCallTransform(custom.namespaces, "text/event-stream"),
    );
    assert.equal(result.error.code, "ERR_NAMESPACE_RELAY_COMMITTED_STREAM", name);
    assert.doesNotMatch(result.output.toString("utf8"), new RegExp(name, "u"));
  }

  const ordinary = {
    type: "response.output_item.added",
    item: {
      type: "function_call",
      id: "fc_prior_ordinary",
      call_id: "call_prior_owner",
      name: "exec_command",
      arguments: "",
    },
  };
  const contradictory = atomicCustom(
    "fc_later_special",
    "call_prior_owner",
    "contradictory-atomic-owner",
  );
  const contradictorySource = Buffer.from(
    [ordinary, contradictory]
      .map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
      .join(""),
    "utf8",
  );
  const contradictoryOutput = await collectBuffer(
    Readable.from([contradictorySource]).pipe(
      new NamespaceToolCallTransform(custom.namespaces, "text/event-stream"),
    ),
  );
  assert.deepEqual(contradictoryOutput, contradictorySource);
});

test("ordinary nonterminal snapshots reserve identities across compatible repeats", async () => {
  const flattened = flattenNamespaceTools([
    {
      type: "namespace",
      name: "collaboration",
      tools: [{ type: "function", name: "spawn_agent" }],
    },
  ]);
  bridgeCustomTools(
    [{ type: "custom", name: "apply_patch" }],
    [],
    flattened.namespaces,
  );
  const ordinary = {
    type: "function_call",
    id: "fc_progress_shared",
    call_id: "call_progress_shared",
    name: "collaboration__spawn_agent",
    arguments: "{}",
  };
  const progress = {
    type: "response.in_progress",
    response: { id: "resp_progress", object: "response", output: [ordinary] },
  };
  const progressFrame = Buffer.from(
    `event: ${progress.type}\ndata: ${JSON.stringify(progress)}\n\n`,
    "utf8",
  );
  const done = { type: "response.output_item.done", item: ordinary };
  const doneFrame = Buffer.from(
    `event: ${done.type}\ndata: ${JSON.stringify(done)}\n\n`,
    "utf8",
  );
  const completed = {
    type: "response.completed",
    response: { id: "resp_progress", object: "response", output: [ordinary] },
  };
  const completedFrame = Buffer.from(
    `event: ${completed.type}\ndata: ${JSON.stringify(completed)}\n\n`,
    "utf8",
  );
  const compatible = await collect(
    Readable.from([progressFrame, progressFrame, doneFrame, completedFrame]).pipe(
      new NamespaceToolCallTransform(flattened.namespaces, "text/event-stream"),
    ),
  );
  const compatiblePayloads = compatible
    .split("\n")
    .filter((line) => line.startsWith("data: "))
    .map((line) => JSON.parse(line.slice(6)));
  assert.equal(compatiblePayloads.length, 4);
  const compatibleItems = [
    compatiblePayloads[0].response.output[0],
    compatiblePayloads[1].response.output[0],
    compatiblePayloads[2].item,
    compatiblePayloads[3].response.output[0],
  ];
  for (const item of compatibleItems) {
    assert.equal(item.id, "fc_progress_shared");
    assert.equal(item.call_id, "call_progress_shared");
    assert.equal(item.name, "spawn_agent");
    assert.equal(item.namespace, "collaboration");
  }

  const reused = {
    type: "response.output_item.done",
    marker: "ordinary-progress-to-special-reuse",
    item: {
      type: "function_call",
      id: "fc_progress_shared",
      call_id: "call_progress_shared",
      name: "apply_patch",
      arguments: JSON.stringify({ input: "patch" }),
    },
  };
  const reusedFrame = Buffer.from(
    `event: ${reused.type}\ndata: ${JSON.stringify(reused)}\n\n`,
    "utf8",
  );
  const { output, error } = await collectUntilPipelineError(
    [progressFrame, progressFrame, reusedFrame],
    new NamespaceToolCallTransform(flattened.namespaces, "text/event-stream"),
  );
  assert.equal(error.code, "ERR_NAMESPACE_RELAY_COMMITTED_STREAM");
  assert.equal((output.toString("utf8").match(/"namespace":"collaboration"/gu) || []).length, 2);
  assert.doesNotMatch(output.toString("utf8"), /ordinary-progress-to-special-reuse/u);
  assert.doesNotMatch(output.toString("utf8"), /"type":"custom_tool_call"/u);
});

test("invalid or inconsistent tool_search arguments fail closed after conversion", async () => {
  const { namespaces } = flattenNamespaceTools([clientToolSearchControl()]);
  const open = {
    type: "response.output_item.added",
    item: {
      type: "function_call",
      id: "fc_search_bad",
      call_id: "call_search_bad",
      name: "tool_search",
      arguments: "",
    },
  };
  const fixtures = [
    [
      {
        type: "response.function_call_arguments.done",
        item_id: "fc_search_bad",
        call_id: "call_search_bad",
        arguments: "[]",
      },
    ],
    [
      {
        type: "response.function_call_arguments.done",
        item_id: "fc_search_bad",
        call_id: "call_search_bad",
        arguments: JSON.stringify({ query: "calendar" }),
      },
      {
        type: "response.output_item.done",
        item: {
          ...open.item,
          arguments: JSON.stringify({ query: "mail" }),
        },
      },
    ],
  ];
  for (const tail of fixtures) {
    const source = [open, ...tail]
      .map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
      .join("");
    const { output, error } = await collectUntilPipelineError(
      [Buffer.from(source, "utf8")],
      new NamespaceToolCallTransform(namespaces, "text/event-stream"),
    );
    assert.equal(error.code, "ERR_NAMESPACE_RELAY_COMMITTED_STREAM");
    assert.match(output.toString("utf8"), /"type":"tool_search_call"/u);
    assert.doesNotMatch(output.toString("utf8"), /function_call_arguments\.done/u);
    assert.doesNotMatch(output.toString("utf8"), /response\.output_item\.done/u);
  }
});

test("tool_search lifecycle fingerprints ignore object key order", async () => {
  const { namespaces } = flattenNamespaceTools([clientToolSearchControl()]);
  const open = {
    type: "response.output_item.added",
    item: {
      type: "function_call",
      id: "fc_search_canonical",
      call_id: "call_search_canonical",
      name: "tool_search",
      arguments: "",
    },
  };
  const argumentsDone = {
    type: "response.function_call_arguments.done",
    item_id: "fc_search_canonical",
    call_id: "call_search_canonical",
    arguments: JSON.stringify({ query: "calendar", limit: 4 }),
  };
  const closeItem = {
    ...open.item,
    arguments: JSON.stringify({ limit: 4, query: "calendar" }),
  };
  const events = [
    open,
    argumentsDone,
    { type: "response.output_item.done", item: closeItem },
    { type: "response.completed", response: { output: [closeItem] } },
  ];
  const output = await collect(
    Readable.from(
      events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`),
    ).pipe(new NamespaceToolCallTransform(namespaces, "text/event-stream")),
  );
  const payloads = output
    .split("\n")
    .filter((line) => line.startsWith("data: "))
    .map((line) => JSON.parse(line.slice(6)));
  assert.deepEqual(payloads.at(-2).item.arguments, { limit: 4, query: "calendar" });
  assert.deepEqual(payloads.at(-1).response.output[0].arguments, {
    limit: 4,
    query: "calendar",
  });
});

test("converted custom and tool_search calls must close before terminal or EOF", async () => {
  const customNamespaces = new Map();
  bridgeCustomTools([{ type: "custom", name: "apply_patch" }], [], customNamespaces);
  const { namespaces: searchNamespaces } = flattenNamespaceTools([clientToolSearchControl()]);
  const fixtures = [
    {
      name: "custom-eof",
      namespaces: customNamespaces,
      item: {
        type: "function_call",
        id: "fc_custom_eof",
        call_id: "call_custom_eof",
        name: "apply_patch",
        arguments: "",
      },
      terminal: "",
    },
    {
      name: "custom-done",
      namespaces: customNamespaces,
      item: {
        type: "function_call",
        id: "fc_custom_done",
        call_id: "call_custom_done",
        name: "apply_patch",
        arguments: "",
      },
      terminal: "data: [DONE]\n\n",
    },
    {
      name: "custom-completed",
      namespaces: customNamespaces,
      item: {
        type: "function_call",
        id: "fc_custom_completed",
        call_id: "call_custom_completed",
        name: "apply_patch",
        arguments: "",
      },
      terminal:
        'event: response.completed\ndata: {"type":"response.completed","response":{"output":[]}}\n\n',
    },
    {
      name: "tool-search-eof",
      namespaces: searchNamespaces,
      item: {
        type: "function_call",
        id: "fc_search_eof",
        call_id: "call_search_eof",
        name: "tool_search",
        arguments: "",
      },
      terminal: "",
    },
  ];

  for (const fixture of fixtures) {
    const added = {
      type: "response.output_item.added",
      item: fixture.item,
    };
    const source =
      `event: ${added.type}\ndata: ${JSON.stringify(added)}\n\n` + fixture.terminal;
    const { output, error } = await collectUntilPipelineError(
      [Buffer.from(source, "utf8")],
      new NamespaceToolCallTransform(fixture.namespaces, "text/event-stream"),
    );
    assert.equal(error.code, "ERR_NAMESPACE_RELAY_COMMITTED_STREAM", fixture.name);
    assert.match(output.toString("utf8"), /"type":"(?:custom_tool_call|tool_search_call)"/u);
    assert.doesNotMatch(output.toString("utf8"), /\[DONE\]|response\.completed/u);
  }
});

test("special openings without stable identities fail open before byte mutation", async () => {
  const customNamespaces = new Map();
  bridgeCustomTools([{ type: "custom", name: "apply_patch" }], [], customNamespaces);
  const { namespaces: searchNamespaces } = flattenNamespaceTools([clientToolSearchControl()]);
  const fixtures = [
    {
      namespaces: customNamespaces,
      item: {
        type: "function_call",
        call_id: "call_missing_item",
        name: "apply_patch",
        arguments: "",
      },
    },
    {
      namespaces: customNamespaces,
      item: {
        type: "function_call",
        id: "fc_missing_call",
        name: "apply_patch",
        arguments: "",
      },
    },
    {
      namespaces: searchNamespaces,
      item: {
        type: "function_call",
        id: "",
        call_id: "call_search_missing_item",
        name: "tool_search",
        arguments: "",
      },
    },
  ];

  for (const fixture of fixtures) {
    const event = { type: "response.output_item.added", item: fixture.item };
    const source = Buffer.from(
      `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
      "utf8",
    );
    const output = await collectBuffer(
      Readable.from([source]).pipe(
        new NamespaceToolCallTransform(fixture.namespaces, "text/event-stream"),
      ),
    );
    assert.deepEqual(output, source);
  }
});

test("a well-formed bridged call closes as the custom_tool_call it opened", async () => {
  const namespaces = new Map();
  bridgeCustomTools([{ type: "custom", name: "apply_patch" }], [], namespaces);
  const patch = "*** Begin Patch\n*** End Patch";
  const argumentsText = JSON.stringify({ input: patch });
  const events = [
    {
      type: "response.output_item.added",
      item: {
        type: "function_call",
        id: "fc_ok",
        call_id: "call_ok",
        name: "apply_patch",
        arguments: "",
      },
    },
    { type: "response.function_call_arguments.delta", item_id: "fc_ok", delta: argumentsText },
    { type: "response.function_call_arguments.done", item_id: "fc_ok", arguments: argumentsText },
    {
      type: "response.output_item.done",
      item: {
        type: "function_call",
        id: "fc_ok",
        call_id: "call_ok",
        name: "apply_patch",
        arguments: argumentsText,
      },
    },
  ];
  const source = events
    .map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
    .join("");
  const transform = new NamespaceToolCallTransform(namespaces, "text/event-stream");
  const output = await collect(Readable.from([Buffer.from(source, "utf8")]).pipe(transform));
  const payloads = output
    .split(/\n\n/)
    .filter(Boolean)
    .map((block) => JSON.parse(block.split("\n").find((line) => line.startsWith("data: ")).slice(6)));

  assert.equal(payloads[0].item.type, "custom_tool_call");
  assert.equal(payloads.at(-1).item.type, "custom_tool_call");
  assert.equal(payloads.at(-1).item.input, patch);
  assert.equal(
    payloads.some((event) => event.type === "response.custom_tool_call_input.done"),
    true,
  );
});

// Moonshot accepts a `$ref` only when it points into `#/$defs/`, and the Codex
// App connector pack ships sibling-property pointers -- Wego `_flights_search`
// points `inboundTotalDurationRange` at its own sibling `priceRange`. The
// rejection fails the whole request, so the kimi route inlines those pointers
// before relaying (issue #353).
function connectorNamespace() {
  return {
    type: "namespace",
    name: "wego",
    tools: [
      {
        name: "_flights_search",
        inputSchema: {
          type: "object",
          properties: {
            filters: {
              type: "object",
              properties: {
                priceRange: {
                  type: "object",
                  properties: { min: { type: "number" }, max: { type: "number" } },
                  required: ["min"],
                },
                inboundTotalDurationRange: {
                  $ref: "#/properties/filters/properties/priceRange",
                },
              },
            },
          },
        },
      },
    ],
  };
}

function siblingRefs(value, found = []) {
  if (Array.isArray(value)) {
    for (const entry of value) siblingRefs(entry, found);
    return found;
  }
  if (!value || typeof value !== "object") return found;
  for (const [key, entry] of Object.entries(value)) {
    if (key === "$ref" && typeof entry === "string" && !entry.startsWith("#/$defs/")) {
      found.push(entry);
    } else siblingRefs(entry, found);
  }
  return found;
}

function refsWithSiblings(value, found = []) {
  if (Array.isArray(value)) {
    for (const entry of value) refsWithSiblings(entry, found);
    return found;
  }
  if (!value || typeof value !== "object") return found;
  if (typeof value.$ref === "string" && Object.keys(value).length > 1) {
    found.push(value.$ref);
  }
  for (const entry of Object.values(value)) refsWithSiblings(entry, found);
  return found;
}

test("the kimi route relays connector tools with no sibling ref left", () => {
  const { tools } = flattenNamespaceTools([connectorNamespace()]);
  const relayed = repairToolSchemaRoots(tools, { inlineForeignRefs: true });
  const parameters = relayed[0].parameters;
  assert.deepEqual(siblingRefs(parameters), []);
  const inbound = parameters.properties.filters.properties.inboundTotalDurationRange;
  assert.deepEqual(Object.keys(inbound.properties), ["min", "max"]);
  assert.deepEqual(inbound.required, ["min"]);
  // The client's native declaration is not the provider-facing copy and stays
  // exactly as Codex sent it.
  const native = relayed[0].inputSchema.properties.filters.properties;
  assert.equal(
    native.inboundTotalDurationRange.$ref,
    "#/properties/filters/properties/priceRange",
  );
});

test("the kimi route expands Codex automation definitions with sibling refs", () => {
  const { tools } = flattenNamespaceTools(CODEX_APP_TOOLS);
  const automation = tools.find((tool) => tool.name.endsWith("__automation_update"));
  assert.ok(automation);
  assert.notDeepEqual(refsWithSiblings(automation.parameters), []);

  const relayed = repairToolSchemaRoots(tools, { inlineForeignRefs: true });
  const repaired = relayed.find((tool) => tool.name.endsWith("__automation_update"));
  assert.deepEqual(refsWithSiblings(repaired.parameters), []);
  assert.equal(repaired.parameters.$defs.__schema0.$ref, undefined);
});

// The negative control is the point of the gate: every provider that accepts
// these pointers today must keep the byte-identical payload it already gets.
test("a provider that never asked for inlining keeps its tools by identity", () => {
  const { tools } = flattenNamespaceTools([connectorNamespace()]);
  assert.equal(repairToolSchemaRoots(tools), tools);
  assert.deepEqual(siblingRefs(tools[0].parameters), [
    "#/properties/filters/properties/priceRange",
  ]);
});

test("the kimi route still copies nothing when no tool carries a foreign ref", () => {
  const tools = [
    {
      type: "function",
      name: "ordinary",
      parameters: {
        type: "object",
        properties: { window: { $ref: "#/$defs/range" } },
        $defs: { range: { type: "object" } },
      },
    },
  ];
  assert.equal(repairToolSchemaRoots(tools, { inlineForeignRefs: true }), tools);
});
