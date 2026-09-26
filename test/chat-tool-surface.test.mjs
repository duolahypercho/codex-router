import assert from "node:assert/strict";
import test from "node:test";

import {
  chatProviderToolSurface,
  GROQ_MAX_TOOLS,
  GROQ_TOOL_LIMIT_CODE,
} from "../src/chat-tool-surface.mjs";
import { mergeCodexAppTools } from "../src/codex-app-tools.mjs";
import {
  buildNamespaceLookups,
  flattenNamespacedHistory,
  flattenNamespaceTools,
  flattenToolSearchHistory,
  flattenToolChoice,
  rewriteNamespaceResponsePayload,
  toolSearchRelayAvailable,
} from "../src/namespace-relay.mjs";

function clientToolSearch() {
  return {
    type: "tool_search",
    execution: "client",
    description: "Search deferred tools.",
    parameters: {
      type: "object",
      properties: { query: { type: "string" } },
      required: ["query"],
      additionalProperties: false,
    },
  };
}

function largeClientSurface({
  plainTools = 111,
  toolSearch = false,
  appTools = [
    { type: "function", name: "load_workspace_dependencies" },
    { type: "function", name: "navigate_to_codex_page" },
    { type: "function", name: "read_thread_terminal" },
  ],
} = {}) {
  return [
    ...(toolSearch ? [clientToolSearch()] : []),
    ...Array.from({ length: plainTools }, (_, index) => ({
      type: "function",
      name: `core_tool_${index}`,
      parameters: { type: "object" },
    })),
    {
      type: "namespace",
      name: "codex_app",
      tools: appTools,
    },
  ];
}

test("Groq defers only injected app definitions without requiring tool_search", () => {
  const client = largeClientSurface();
  const normallyExpanded = flattenNamespaceTools(mergeCodexAppTools(client).tools);
  assert.equal(normallyExpanded.tools.length, 129, "regression fixture reproduces issue #449");

  const routed = chatProviderToolSurface(client, "groq");
  const clientFlattened = flattenNamespaceTools(client);
  assert.equal(routed.tools.length, 114);
  assert.deepEqual(routed.tools, clientFlattened.tools);
  assert.equal(toolSearchRelayAvailable(routed.namespaces), false);

  const routedNames = new Set(routed.tools.map((tool) => tool.name));
  for (const tool of clientFlattened.tools) {
    assert.ok(routedNames.has(tool.name), `client tool ${tool.name} must survive`);
  }
  assert.equal(routedNames.has("codex_app__create_thread"), false);
  assert.equal(routedNames.has("plugin_management__uninstall_plugin"), false);
});

test("Groq refuses an over-limit surface instead of dropping client tools", () => {
  assert.throws(
    () => chatProviderToolSurface(largeClientSurface({ plainTools: 126 }), "groq"),
    (error) => {
      assert.equal(error.code, GROQ_TOOL_LIMIT_CODE);
      assert.equal(error.status, 400);
      assert.equal(error.limit, GROQ_MAX_TOOLS);
      assert.equal(error.clientToolCount, 129);
      return true;
    },
  );
});

test("Groq restores injected app definitions referenced by native and flattened history", () => {
  const input = [
    {
      type: "function_call",
      name: "create_thread",
      namespace: "codex_app",
      call_id: "thread-1",
      arguments: "{}",
    },
    {
      type: "function_call",
      name: "codex_app__read_thread",
      call_id: "thread-2",
      arguments: "{}",
    },
  ];
  const routed = chatProviderToolSurface(largeClientSurface(), "groq", { input });
  assert.equal(routed.tools.length, 116);
  assert.ok(routed.tools.some((tool) => tool.name === "codex_app__create_thread"));
  assert.ok(routed.tools.some((tool) => tool.name === "codex_app__read_thread"));
  const history = flattenNamespacedHistory(input, routed.namespaces);
  assert.deepEqual(history[0], {
    type: "function_call",
    name: "codex_app__create_thread",
    call_id: "thread-1",
    arguments: "{}",
  });
  assert.equal(history[1], input[1], "already-flattened history stays byte-identical");
});

test("Groq restores an injected app definition referenced by a forced choice", () => {
  const toolChoice = {
    type: "function",
    name: "send_message_to_thread",
    namespace: "codex_app",
  };
  const routed = chatProviderToolSurface(largeClientSurface(), "groq", { toolChoice });
  assert.ok(
    routed.tools.some((tool) => tool.name === "codex_app__send_message_to_thread"),
  );
  assert.deepEqual(flattenToolChoice(toolChoice, routed.namespaces), {
    type: "function",
    name: "codex_app__send_message_to_thread",
  });
});

test("Groq admits nested and allowed-tools app choices without rewriting other choice types", () => {
  const nestedChoice = {
    type: "function",
    namespace: "codex_app",
    function: { name: "create_thread" },
  };
  const nested = chatProviderToolSurface(largeClientSurface(), "groq", {
    toolChoice: nestedChoice,
  });
  assert.ok(nested.tools.some((tool) => tool.name === "codex_app__create_thread"));
  assert.deepEqual(flattenToolChoice(nestedChoice, nested.namespaces), {
    type: "function",
    function: { name: "codex_app__create_thread" },
  });

  const allowedChoice = {
    type: "allowed_tools",
    mode: "auto",
    tools: [
      { type: "function", namespace: "codex_app", name: "send_message_to_thread" },
      { type: "function", function: { name: "codex_app__read_thread" } },
      { type: "custom", name: "apply_patch" },
      { type: "tool_search", execution: "client" },
    ],
  };
  const allowed = chatProviderToolSurface(largeClientSurface(), "groq", {
    toolChoice: allowedChoice,
  });
  assert.ok(
    allowed.tools.some((tool) => tool.name === "codex_app__send_message_to_thread"),
  );
  assert.ok(allowed.tools.some((tool) => tool.name === "codex_app__read_thread"));
  assert.deepEqual(flattenToolChoice(allowedChoice, allowed.namespaces), {
    ...allowedChoice,
    tools: [
      { type: "function", name: "codex_app__send_message_to_thread" },
      allowedChoice.tools[1],
      allowedChoice.tools[2],
      allowedChoice.tools[3],
    ],
  });
});

test("Groq infers a unique bare deferred app name from stored history", () => {
  const input = [{ type: "function_call", name: "create_thread", call_id: "bare-1" }];
  const routed = chatProviderToolSurface(largeClientSurface(), "groq", { input });
  assert.ok(routed.tools.some((tool) => tool.name === "codex_app__create_thread"));
  assert.deepEqual(flattenNamespacedHistory(input, routed.namespaces), [{
    type: "function_call",
    name: "codex_app__create_thread",
    call_id: "bare-1",
  }]);
});

test("Groq refuses an absent forced app when the client already occupies 128 slots", () => {
  assert.throws(
    () => chatProviderToolSurface(largeClientSurface({ plainTools: 125 }), "groq", {
      toolChoice: { type: "function", function: { name: "codex_app__create_thread" } },
    }),
    (error) => {
      assert.equal(error.code, GROQ_TOOL_LIMIT_CODE);
      assert.equal(error.clientToolCount, 128);
      assert.equal(error.referencedToolCapacity, 0);
      assert.equal(error.referencedToolCount, 1);
      return true;
    },
  );
});

test("Groq aliases a plain flattened spelling away from its injected app identity", () => {
  const client = [
    ...largeClientSurface({ plainTools: 110 }),
    { type: "function", name: "codex_app__create_thread", parameters: { type: "object" } },
  ];
  const input = [
    { type: "function_call", name: "codex_app__create_thread", call_id: "plain" },
    {
      type: "function_call",
      namespace: "codex_app",
      name: "create_thread",
      call_id: "app",
    },
  ];
  const routed = chatProviderToolSurface(client, "groq", { input });
  const history = flattenNamespacedHistory(input, routed.namespaces);
  assert.notEqual(history[0].name, history[1].name);
  assert.match(history[0].name, /^codex_app__create_thread_/);
  assert.match(history[1].name, /^codex_app__create_thread_/);
  assert.equal(history[0].name.length, "codex_app__create_thread".length + 13);
  assert.equal(history[1].name.length, "codex_app__create_thread".length + 13);

  const restored = rewriteNamespaceResponsePayload({
    output: [
      { type: "function_call", name: history[0].name, call_id: "plain", arguments: "{}" },
      { type: "function_call", name: history[1].name, call_id: "app", arguments: "{}" },
    ],
  }, buildNamespaceLookups(routed.namespaces));
  assert.deepEqual(restored.output[0], {
    type: "function_call",
    name: "codex_app__create_thread",
    call_id: "plain",
    arguments: "{}",
  });
  assert.deepEqual(restored.output[1], {
    type: "function_call",
    name: "create_thread",
    namespace: "codex_app",
    call_id: "app",
    arguments: "{}",
  });
});

test("an exact plain create_thread wins while an explicit app identity remains available", () => {
  const client = [
    ...largeClientSurface({ plainTools: 110 }),
    { type: "function", name: "create_thread", parameters: { type: "object" } },
  ];
  const plainOnly = chatProviderToolSurface(client, "groq", {
    input: [{ type: "function_call", name: "create_thread" }],
  });
  assert.equal(
    plainOnly.tools.some((tool) => tool.name === "codex_app__create_thread"),
    false,
  );

  const routed = chatProviderToolSurface(client, "groq", {
    input: [{ type: "function_call", namespace: "codex_app", name: "create_thread" }],
  });
  const restored = rewriteNamespaceResponsePayload({
    output: [
      { type: "function_call", name: "create_thread", arguments: "{}" },
      { type: "function_call", name: "codex_app__create_thread", arguments: "{}" },
    ],
  }, buildNamespaceLookups(routed.namespaces));
  assert.deepEqual(restored.output, [
    { type: "function_call", name: "create_thread", arguments: "{}" },
    {
      type: "function_call",
      name: "create_thread",
      namespace: "codex_app",
      arguments: "{}",
    },
  ]);
});

test("a client app definition wins over the injected snapshot on Groq", () => {
  const clientDefinition = {
    type: "function",
    name: "create_thread",
    description: "Current client schema wins.",
    inputSchema: {
      type: "object",
      properties: { current: { type: "boolean" } },
    },
  };
  const client = largeClientSurface({
    appTools: [
      { type: "function", name: "load_workspace_dependencies" },
      { type: "function", name: "navigate_to_codex_page" },
      { type: "function", name: "read_thread_terminal" },
      clientDefinition,
    ],
  });
  const routed = chatProviderToolSurface(client, "groq", {
    input: [{
      type: "function_call",
      name: "create_thread",
      namespace: "codex_app",
    }],
  });
  const selected = routed.tools.filter((tool) => tool.name === "codex_app__create_thread");
  assert.equal(selected.length, 1);
  assert.equal(selected[0].description, clientDefinition.description);
  assert.deepEqual(selected[0].inputSchema, clientDefinition.inputSchema);
});

test("Groq refuses when client plus referenced app definitions exceed the cap", () => {
  assert.throws(
    () => chatProviderToolSurface(
      largeClientSurface({ plainTools: 125 }),
      "groq",
      {
        input: [
          { type: "function_call", name: "codex_app__create_thread" },
          { type: "function_call", name: "codex_app__send_message_to_thread" },
        ],
      },
    ),
    (error) => {
      assert.equal(error.code, GROQ_TOOL_LIMIT_CODE);
      assert.equal(error.clientToolCount, 128);
      assert.equal(error.referencedToolCapacity, 0);
      assert.equal(error.referencedToolCount, 2);
      return true;
    },
  );
});

test("tool-search capable chat providers keep the client-deferred app surface", () => {
  const client = largeClientSurface({ plainTools: 2, toolSearch: true });
  const clientFlattened = flattenNamespaceTools(client);
  const routed = chatProviderToolSurface(client, "zai-coding");

  assert.equal(toolSearchRelayAvailable(routed.namespaces), true);
  assert.deepEqual(routed.tools, clientFlattened.tools);
  assert.equal(
    routed.tools.some((tool) => tool.name === "codex_app__create_thread"),
    false,
  );
  assert.equal(
    routed.tools.some((tool) => tool.name === "plugin_management__uninstall_plugin"),
    false,
  );
});

test("tool-search capable chat providers add back only referenced deferred app tools", () => {
  const client = largeClientSurface({ plainTools: 2, toolSearch: true });
  const routed = chatProviderToolSurface(client, "zai-coding", {
    input: [{
      type: "function_call",
      namespace: "codex_app",
      name: "create_thread",
      call_id: "history-thread",
      arguments: "{}",
    }],
    toolChoice: {
      type: "function",
      namespace: "codex_app",
      name: "send_message_to_thread",
    },
  });
  const names = new Set(routed.tools.map((tool) => tool.name));

  assert.equal(toolSearchRelayAvailable(routed.namespaces), true);
  assert.equal(names.has("codex_app__create_thread"), true);
  assert.equal(names.has("codex_app__send_message_to_thread"), true);
  assert.equal(names.has("codex_app__automation_update"), false);
  assert.equal(names.has("plugin_management__uninstall_plugin"), false);
});

test("non-Groq providers without tool search preserve the normally expanded tool surface", () => {
  const client = largeClientSurface();
  const expected = flattenNamespaceTools(mergeCodexAppTools(client).tools);
  const routed = chatProviderToolSurface(client, "openrouter");
  assert.equal(routed.tools.length, 129);
  assert.equal(
    JSON.stringify(routed.tools),
    JSON.stringify(expected.tools),
    "the non-Groq provider-facing tool bytes stay unchanged",
  );
  assert.deepEqual(routed.tools, expected.tools);
  assert.deepEqual([...routed.namespaces], [...expected.namespaces]);
});

// Issue #626: Command Code answers `HTTP 400: \`name\` must be at most 64
// characters, got 80` before generation, so the exact reported tool has to
// reach the provider under a bounded alias and come back as its client
// identity. The tool below is the 80-character name from that report.
const COMMAND_CODE_LONG_TOOL =
  "mcp__openai_api_key_local_confirmation__confirm_openai_api_key_local_destination";

function commandCodeSurface() {
  return [
    {
      type: "function",
      name: COMMAND_CODE_LONG_TOOL,
      parameters: { type: "object" },
    },
    { type: "namespace", name: "codex_app", tools: [{ type: "function", name: "create_thread" }] },
  ];
}

for (const [providerId, upstreamModel] of [
  ["commandcode"],
  ["commandcode-messages"],
  ["openrouter", "meta/muse-spark-1.3-contributor"],
]) {
  test(`${providerId} bounds provider-facing tool names to 64 characters`, () => {
    assert.equal(COMMAND_CODE_LONG_TOOL.length, 80, "regression fixture reproduces issue #626");
    const routed = chatProviderToolSurface(commandCodeSurface(), providerId, { upstreamModel });
    const names = routed.tools.map((tool) => tool.name);
    for (const name of names) {
      assert.ok(
        name.length <= 64,
        `${name} is ${name.length} characters, which the upstream rejects`,
      );
    }
    const alias = names.find((name) => name !== "codex_app__create_thread");
    assert.ok(alias, "the long client tool must still be offered");
    assert.notEqual(alias, COMMAND_CODE_LONG_TOOL, "the alias must differ from the client name");

    // The alias is only safe because it is reversible: a call the model makes
    // under the bounded spelling has to come back as the client's own tool.
    const restored = rewriteNamespaceResponsePayload(
      {
        output: [
          { type: "function_call", name: alias, arguments: "{}" },
        ],
      },
      buildNamespaceLookups(routed.namespaces),
    );
    assert.equal(restored.output[0].name, COMMAND_CODE_LONG_TOOL);
  });

  test(`${providerId} keeps the bounded alias deterministic across identical surfaces`, () => {
    const first = chatProviderToolSurface(commandCodeSurface(), providerId, { upstreamModel });
    const second = chatProviderToolSurface(commandCodeSurface(), providerId, { upstreamModel });
    assert.deepEqual(
      first.tools.map((tool) => tool.name),
      second.tools.map((tool) => tool.name),
    );
  });
}

test("every chat provider aliases a plain flattened spelling away from its app identity", () => {
  // The same shape the Groq case above covers, on the providers that reach the
  // other branch. Codex injects its app tools as a `codex_app` namespace and
  // also sends the flattened spelling, so the two identities collide on the
  // wire. Without deterministic aliases the tool list carries one name twice,
  // the client's own `codex_app__create_thread` is unreachable for the turn,
  // and the past call it made is restored under the namespaced identity Codex
  // dispatches somewhere else.
  const client = [
    { type: "function", name: "shell", parameters: { type: "object" } },
    { type: "function", name: "codex_app__create_thread", parameters: { type: "object" } },
  ];
  const input = [
    { type: "function_call", name: "codex_app__create_thread", call_id: "plain" },
    { type: "function_call", namespace: "codex_app", name: "create_thread", call_id: "app" },
  ];
  for (const providerId of ["deepseek", "openrouter", "zai", "moonshot"]) {
    const routed = chatProviderToolSurface(client, providerId, { input });
    const names = routed.tools
      .filter((tool) => tool?.type === "function")
      .map((tool) => tool.name);
    assert.equal(
      new Set(names).size,
      names.length,
      `${providerId} sent one tool name twice: ${names.join(", ")}`,
    );

    const history = flattenNamespacedHistory(input, routed.namespaces);
    assert.notEqual(history[0].name, history[1].name, providerId);

    const restored = rewriteNamespaceResponsePayload({
      output: [
        { type: "function_call", name: history[0].name, call_id: "plain", arguments: "{}" },
        { type: "function_call", name: history[1].name, call_id: "app", arguments: "{}" },
      ],
    }, buildNamespaceLookups(routed.namespaces));
    assert.deepEqual(restored.output[0], {
      type: "function_call",
      name: "codex_app__create_thread",
      call_id: "plain",
      arguments: "{}",
    }, providerId);
    assert.deepEqual(restored.output[1], {
      type: "function_call",
      name: "create_thread",
      namespace: "codex_app",
      call_id: "app",
      arguments: "{}",
    }, providerId);
  }
});

test("a live top-level schema wins over a discovered one on every chat route", () => {
  // `flattenToolSearchHistory` states the rule: live top-level schemas win on
  // a name collision. It compared provider-facing names, so on a route that
  // aliases collisions the discovered tool was handed a different name, stopped
  // colliding, and the stale schema was declared beside the live one -- two
  // definitions of one tool, the wrong one first.
  const tools = [
    clientToolSearch(),
    { type: "function", name: "shell", parameters: { type: "object", properties: {} } },
    {
      type: "function",
      name: "mcp__calendar__create_event",
      description: "Current live schema.",
      parameters: { type: "object", properties: { live: { type: "boolean" } } },
    },
  ];
  const input = [
    { type: "tool_search_call", call_id: "s1", execution: "client", arguments: { query: "calendar" } },
    {
      type: "tool_search_output",
      call_id: "s1",
      status: "completed",
      execution: "client",
      tools: [{
        type: "namespace",
        name: "mcp__calendar",
        description: "Calendar tools.",
        tools: [
          { type: "function", name: "create_event", parameters: { type: "object", properties: { stale: { type: "string" } } } },
          { type: "function", name: "delete_event", parameters: { type: "object", properties: { id: { type: "string" } } } },
        ],
      }],
    },
  ];
  for (const providerId of ["groq", "commandcode", "deepseek", "openrouter"]) {
    const routed = chatProviderToolSurface(tools, providerId, { input });
    const flattened = flattenToolSearchHistory(input, routed.tools, routed.namespaces, {
      maxTools: 128,
    });
    const calendarTools = flattened.tools
      .filter((tool) => tool?.type === "function" && tool.name.startsWith("mcp__calendar"))
      .map((tool) => tool.name);
    assert.deepEqual(
      calendarTools,
      ["mcp__calendar__create_event", "mcp__calendar__delete_event"],
      `${providerId} redeclared the discovered schema beside the live one`,
    );
    const searchOutput = flattened.input.find(
      (item) => item?.type === "function_call_output" && item.call_id === "s1",
    );
    assert.deepEqual(
      JSON.parse(searchOutput.output).tools.map((tool) => tool.name),
      ["mcp__calendar__delete_event"],
      providerId,
    );
  }
});

test("collision aliases are the same on a bounded and an unbounded provider", () => {
  // The alias is derived from the native identity, not the route, so an
  // operator comparing two providers sees one answer.
  const client = [
    { type: "function", name: "codex_app__create_thread", parameters: { type: "object" } },
  ];
  const bounded = chatProviderToolSurface(client, "commandcode").tools.map((tool) => tool.name);
  const unbounded = chatProviderToolSurface(client, "deepseek").tools.map((tool) => tool.name);
  assert.deepEqual(unbounded, bounded);
});

for (const [providerId, upstreamModel] of [
  ["openrouter"],
  ["openrouter", "meta/muse-spark-1.3"],
  ["openrouter", "meta/muse-spark-1.2-contributor"],
  ["nousresearch", "meta/muse-spark-1.3-contributor"],
]) {
  test(`${providerId}/${upstreamModel} keeps the unbounded 80-character name`, () => {
    const routed = chatProviderToolSurface(commandCodeSurface(), providerId, { upstreamModel });
    assert.ok(
      routed.tools.some((tool) => tool.name === COMMAND_CODE_LONG_TOOL),
      "unaffected routes retain their original names",
    );
  });
}
