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
  flattenToolChoice,
  flattenToolSearchHistory,
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

test("non-Groq providers preserve the normally expanded tool surface", () => {
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

for (const providerId of ["commandcode", "commandcode-messages"]) {
  test(`${providerId} bounds provider-facing tool names to 64 characters`, () => {
    assert.equal(COMMAND_CODE_LONG_TOOL.length, 80, "regression fixture reproduces issue #626");
    const routed = chatProviderToolSurface(commandCodeSurface(), providerId);
    const names = routed.tools.map((tool) => tool.name);
    for (const name of names) {
      assert.ok(
        name.length <= 64,
        `${name} is ${name.length} characters, which Command Code rejects`,
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
    const first = chatProviderToolSurface(commandCodeSurface(), providerId);
    const second = chatProviderToolSurface(commandCodeSurface(), providerId);
    assert.deepEqual(
      first.tools.map((tool) => tool.name),
      second.tools.map((tool) => tool.name),
    );
  });
}

test("a non-Command Code chat provider keeps the unbounded 80-character name", () => {
  const routed = chatProviderToolSurface(commandCodeSurface(), "openrouter");
  assert.ok(
    routed.tools.some((tool) => tool.name === COMMAND_CODE_LONG_TOOL),
    "only Command Code opts into the 64-character bound",
  );
});

// A fresh routed turn ships the whole deferred connector registry. The unit
// behaviour lives in test/namespace-relay.test.mjs; this guards the request
// path, where `mergeCodexAppTools` could otherwise hand the deferred surface
// back to the provider after the relay dropped it.
function deferredConnectorSurface() {
  const connector = (namespace, name) => ({
    type: "function",
    name,
    defer_loading: true,
    description: `Call the ${namespace} connector.`,
    parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
  });
  return [
    { type: "function", name: "shell", parameters: { type: "object", properties: {} } },
    clientToolSearch(),
    {
      // Codex registers its whole app namespace with deferLoading. The router
      // injects this namespace's definitions itself, so the deferral rule must
      // not take the snapshot back out.
      type: "namespace",
      name: "codex_app",
      defer_loading: true,
      tools: [
        { type: "function", name: "navigate_to_codex_page", defer_loading: true },
        connector("codex_app", "read_connector_page"),
      ],
    },
    {
      type: "namespace",
      name: "mcp__codex_apps__notion",
      tools: [connector("notion", "search"), connector("notion", "fetch")],
    },
    {
      type: "namespace",
      name: "mcp__codex_apps__slack",
      defer_loading: true,
      tools: [{ type: "function", name: "post_message" }],
    },
  ];
}

test("a chat route omits deferred connector tools behind the bridged search relay", () => {
  const routed = chatProviderToolSurface(deferredConnectorSurface(), "deepseek");
  const names = routed.tools.map((tool) => tool.name);
  assert.ok(names.includes("shell"));
  assert.ok(names.includes("tool_search"));
  // The router-injected app snapshot survives its own deferral markers: the
  // client executes these natively and no search the router serves returns them.
  assert.ok(names.includes("codex_app__navigate_to_codex_page"));
  assert.ok(names.includes("codex_app__automation_update"));
  assert.ok(names.includes("plugin_management__uninstall_plugin"));
  // Everything else Codex registered with deferLoading stays out of the prompt.
  assert.ok(!names.includes("codex_app__read_connector_page"));
  assert.ok(!names.some((name) => name.startsWith("mcp__codex_apps__")));
  assert.ok(
    routed.tools.every((tool) => !("defer_loading" in tool)),
    "the registration flag never reaches a provider",
  );
});

test("a chat route sends non-connector deferred tools when no search relay is bridged", () => {
  withConnectorAllowList("none", () => {
    const withoutSearch = deferredConnectorSurface().filter((tool) => tool.type !== "tool_search");
    const routed = chatProviderToolSurface(withoutSearch, "deepseek");
    const names = routed.tools.map((tool) => tool.name);
    // A deferral marker outside the connector namespaces means nothing without
    // a relay to serve the search, so that definition is still sent.
    assert.ok(names.includes("codex_app__read_connector_page"));
    // An opted-in connector is withheld on its own evidence: the live capture
    // carries no relay and no marker, and the model cannot reach a connector it
    // was never shown.
    assert.ok(!names.includes("mcp__codex_apps__notion__search"));
    assert.ok(!names.includes("mcp__codex_apps__slack__post_message"));
    assert.ok(
      routed.tools.every((tool) => !("defer_loading" in tool)),
      "a sent definition never carries the registration flag either",
    );
  });
});

test("a chat route re-declares a deferred connector the transcript already called", () => {
  const routed = chatProviderToolSurface(deferredConnectorSurface(), "deepseek", {
    input: [
      {
        type: "function_call",
        call_id: "call-1",
        namespace: "mcp__codex_apps__notion",
        name: "search",
        arguments: '{"query":"roadmap"}',
      },
    ],
  });
  const withHistory = flattenToolSearchHistory(
    [
      {
        type: "function_call",
        call_id: "call-1",
        namespace: "mcp__codex_apps__notion",
        name: "search",
        arguments: '{"query":"roadmap"}',
      },
    ],
    routed.tools,
    routed.namespaces,
  );
  const names = withHistory.tools.map((tool) => tool.name);
  assert.ok(names.includes("mcp__codex_apps__notion__search"));
  assert.ok(!names.includes("mcp__codex_apps__notion__fetch"));
  assert.ok(withHistory.tools.every((tool) => !("defer_loading" in tool)));
});

// The real wire shape of a fresh routed turn, captured from DeepSeek on
// opencode-go and Union Alpha on opencode-go-messages: 38 entries, no
// `defer_loading` on any tool, and no `tool_search` control at all. The app
// connectors are ~900 KB of JSON Schema the model cannot reach by intent on a
// fresh turn, and they were being flattened into the prompt of a one-word
// message. Children carry `inputSchema`, as Codex sends them.
const REAL_TURN_NAMESPACES = [
  ["collaboration", 6, 9],
  ["mcp__codex_app", 31, 31],
  ["mcp__cua_repl", 2, 3],
  ["mcp__node_repl", 3, 4],
  ["mcp__openai_artifact_template_picker", 2, 3],
  ["image_gen", 1, 2],
  ["mcp__codex_apps__airtable", 47, 105],
  ["mcp__codex_apps__apify", 22, 39],
  ["mcp__codex_apps__canva", 33, 82],
  ["mcp__codex_apps__codex_document_control", 3, 4],
  ["mcp__codex_apps__figma", 38, 77],
  ["mcp__codex_apps__github", 89, 75],
  ["mcp__codex_apps__gmail", 21, 32],
  ["mcp__codex_apps__google_calendar", 15, 18],
  ["mcp__codex_apps__google_drive", 45, 69],
  ["mcp__codex_apps__granola", 6, 8],
  ["mcp__codex_apps__hotline", 1, 1],
  ["mcp__codex_apps__linkedin", 1, 1],
  ["mcp__codex_apps__notion", 36, 84],
  ["mcp__codex_apps__plugin_management", 6, 10],
  ["mcp__codex_apps__safety_settings", 5, 4],
  ["mcp__codex_apps__sites", 23, 36],
  ["mcp__codex_apps__slack", 38, 71],
  ["mcp__codex_apps__todoist__to_do_list___calendar", 47, 58],
  ["mcp__codex_apps__vercel", 24, 26],
];

const CONNECTOR_PREFIX = "mcp__codex_apps__";

function realTurnChildName(namespace, index) {
  return `${namespace.replace(/^mcp__(codex_apps__)?/, "")}_op_${index}`;
}

function realTurnChild(namespace, index, padding) {
  return {
    type: "function",
    name: realTurnChildName(namespace, index),
    description: `Operation ${index} on ${namespace}. ${"d".repeat(padding)}`,
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search text." },
        limit: { type: "integer", description: "Maximum rows." },
        cursor: { type: "string", description: "Opaque pagination cursor." },
      },
      required: ["query"],
      additionalProperties: false,
    },
  };
}

function realTurnSurface() {
  return [
    ...Array.from({ length: 11 }, (_, index) => ({
      type: "function",
      name: `core_op_${index}`,
      parameters: { type: "object", properties: {}, additionalProperties: false },
    })),
    { type: "custom", name: "apply_patch", description: "Apply a patch." },
    { type: "web_search" },
    ...REAL_TURN_NAMESPACES.map(realTurnNamespace),
  ];
}

// Pad each namespace to the byte size the capture recorded for it, so the
// measured before/after is the live one rather than an invented one.
function realTurnNamespace([name, children, kilobytes]) {
  const build = (padding) => ({
    type: "namespace",
    name,
    tools: Array.from({ length: children }, (_, index) => realTurnChild(name, index, padding)),
  });
  const bare = JSON.stringify(build(0)).length;
  return build(Math.max(0, Math.round((kilobytes * 1024 - bare) / children)));
}

function withConnectorAllowList(value, run) {
  const previous = process.env.CODEX_ROUTER_APP_CONNECTORS;
  if (value === undefined) delete process.env.CODEX_ROUTER_APP_CONNECTORS;
  else process.env.CODEX_ROUTER_APP_CONNECTORS = value;
  try {
    return run();
  } finally {
    if (previous === undefined) delete process.env.CODEX_ROUTER_APP_CONNECTORS;
    else process.env.CODEX_ROUTER_APP_CONNECTORS = previous;
  }
}

function eagerConnectorNamespaces(tools) {
  return REAL_TURN_NAMESPACES.map(([name]) => name)
    .filter((name) => name.startsWith(CONNECTOR_PREFIX))
    .filter((name) => tools.some((tool) => tool.name?.startsWith(`${name}__`)));
}

test("a fresh routed turn keeps every app connector eager by default", () => {
  const routed = withConnectorAllowList(undefined, () =>
    chatProviderToolSurface(realTurnSurface(), "opencode-go"),
  );
  const optedOut = withConnectorAllowList("all", () =>
    chatProviderToolSurface(realTurnSurface(), "opencode-go"),
  );
  // Withholding is opt-in: an unset variable must reach the provider with the
  // same surface the router sent before the feature existed, which is the one
  // `all` asks for explicitly.
  assert.equal(routed.tools.length, optedOut.tools.length);
  assert.deepEqual(
    JSON.stringify(routed.tools).length,
    JSON.stringify(optedOut.tools).length,
  );
  assert.equal(routed.tools.length, 576);
  assert.deepEqual(
    eagerConnectorNamespaces(routed.tools),
    REAL_TURN_NAMESPACES.map(([name]) => name).filter((name) =>
      name.startsWith(CONNECTOR_PREFIX),
    ),
  );
});

test("the connector allow-list value none withholds every connector", () => {
  const eager = withConnectorAllowList("all", () =>
    chatProviderToolSurface(realTurnSurface(), "opencode-go"),
  );
  const routed = withConnectorAllowList("none", () =>
    chatProviderToolSurface(realTurnSurface(), "opencode-go"),
  );
  const eagerBytes = JSON.stringify(eager.tools).length;
  const routedBytes = JSON.stringify(routed.tools).length;
  // The captured turn reached the provider as 576 flattened tools, ~923 KB.
  assert.equal(eager.tools.length, 576);
  assert.ok(eagerBytes > 900 * 1024, `${eagerBytes} bytes eager`);
  // What is left is the client's non-connector namespaces plus the app
  // snapshot the router injects itself (~53 KB of the total, half of it the
  // `inputSchema` copy `flattenNamespaceChild` keeps beside `parameters`).
  // Both are required eager, so the floor sits above the 100 KB the connector
  // removal alone would suggest.
  assert.ok(routedBytes < 128 * 1024, `${routedBytes} bytes routed`);
  assert.ok(routedBytes * 8 < eagerBytes, `${routedBytes} of ${eagerBytes} bytes`);
  const names = routed.tools.map((tool) => tool.name);
  assert.deepEqual(eagerConnectorNamespaces(routed.tools), []);
  // The app's own toolset, the collaboration runtime, the repls, the template
  // picker, image_gen and every plain tool are still declared in full.
  assert.equal(
    names.filter((name) => name?.startsWith("mcp__codex_app__")).length,
    31,
  );
  assert.equal(names.filter((name) => name?.startsWith("collaboration__")).length, 6);
  assert.ok(names.includes("mcp__node_repl__node_repl_op_0"));
  assert.ok(names.includes("image_gen__image_gen_op_0"));
  assert.ok(names.includes("mcp__openai_artifact_template_picker__openai_artifact_template_picker_op_0"));
  assert.ok(names.includes("codex_app__automation_update"));
  assert.ok(names.includes("core_op_0"));
  assert.ok(routed.tools.some((tool) => tool?.type === "custom"));
  assert.ok(routed.tools.some((tool) => tool?.type === "web_search"));
});

test("the connector allow-list keeps exactly the named connectors eager", () => {
  const routed = withConnectorAllowList(" Airtable , gmail ", () =>
    chatProviderToolSurface(realTurnSurface(), "opencode-go"),
  );
  assert.deepEqual(eagerConnectorNamespaces(routed.tools), [
    "mcp__codex_apps__airtable",
    "mcp__codex_apps__gmail",
  ]);
  const names = routed.tools.map((tool) => tool.name);
  assert.equal(
    names.filter((name) => name?.startsWith("mcp__codex_apps__airtable__")).length,
    47,
  );
  assert.equal(names.filter((name) => name?.startsWith("mcp__codex_apps__gmail__")).length, 21);
});

test("the connector allow-list value all restores the whole eager surface", () => {
  const eager = withConnectorAllowList("all", () =>
    chatProviderToolSurface(realTurnSurface(), "opencode-go"),
  );
  const declared = REAL_TURN_NAMESPACES.reduce((total, [, children]) => total + children, 0);
  // 11 functions + custom + web_search + every namespace child + the injected
  // codex_app (17) and plugin_management (1) app definitions.
  assert.equal(eager.tools.length, declared + 13 + 18);
  for (const [namespace, children] of REAL_TURN_NAMESPACES) {
    assert.equal(
      eager.tools.filter((tool) => tool.name?.startsWith(`${namespace}__`)).length,
      children,
      `${namespace} is declared in full`,
    );
  }
});

for (const [label, storedCall] of [
  [
    "the flattened wire name",
    {
      type: "function_call",
      call_id: "call-airtable",
      name: "mcp__codex_apps__airtable__airtable_op_3",
      arguments: '{"query":"roadmap"}',
    },
  ],
  [
    "the namespaced form Codex dispatches by",
    {
      type: "function_call",
      call_id: "call-airtable",
      namespace: "mcp__codex_apps__airtable",
      name: "airtable_op_3",
      arguments: '{"query":"roadmap"}',
    },
  ],
]) {
  test(`a stored connector call under ${label} restores only that definition`, () => {
    withConnectorAllowList("none", () => {
      const input = [storedCall];
      const routed = chatProviderToolSurface(realTurnSurface(), "opencode-go", { input });
      // This turn carries no tool_search control, so the restore may not
      // depend on a live relay.
      assert.equal(toolSearchRelayAvailable(routed.namespaces), false);
      const withHistory = flattenToolSearchHistory(input, routed.tools, routed.namespaces);
      const names = withHistory.tools.map((tool) => tool.name);
      assert.ok(names.includes("mcp__codex_apps__airtable__airtable_op_3"));
      assert.equal(
        names.filter((name) => name?.startsWith(CONNECTOR_PREFIX)).length,
        1,
        "every other connector tool stays withheld",
      );
      const renamed = flattenNamespacedHistory(withHistory.input, routed.namespaces);
      assert.equal(renamed[0].name, "mcp__codex_apps__airtable__airtable_op_3");
      assert.equal(renamed[0].namespace, undefined);
      // Withholding a definition never unregisters its identity: the model's
      // next call under the flat wire name still comes back as the namespaced
      // one Codex dispatches.
      const restored = rewriteNamespaceResponsePayload(
        {
          output: [
            {
              type: "function_call",
              name: "mcp__codex_apps__airtable__airtable_op_3",
              call_id: "call-airtable",
              arguments: "{}",
            },
          ],
        },
        buildNamespaceLookups(routed.namespaces),
      );
      assert.deepEqual(restored.output[0], {
        type: "function_call",
        name: "airtable_op_3",
        call_id: "call-airtable",
        arguments: "{}",
        namespace: "mcp__codex_apps__airtable",
      });
    });
  });
}

test("a forced choice on a withheld connector tool restores its definition", () => {
  withConnectorAllowList("none", () => {
    const toolChoice = { type: "function", name: "mcp__codex_apps__slack__slack_op_1" };
    const routed = chatProviderToolSurface(realTurnSurface(), "opencode-go", { toolChoice });
    const withHistory = flattenToolSearchHistory([], routed.tools, routed.namespaces, {
      toolChoice,
    });
    const names = withHistory.tools.map((tool) => tool.name);
    assert.ok(names.includes("mcp__codex_apps__slack__slack_op_1"));
    assert.equal(names.filter((name) => name?.startsWith(CONNECTOR_PREFIX)).length, 1);
  });
});
