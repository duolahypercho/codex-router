import assert from "node:assert/strict";
import test from "node:test";

import {
  CODEX_APP_TOOL_NAMES,
  CODEX_APP_TOOLS,
  mergeCodexAppTools,
  splitFlatCodexAppName,
} from "../src/codex-app-tools.mjs";

// The reduced codex_app namespace the client actually sends on routed requests
// (captured live: load_workspace_dependencies, navigate_to_codex_page,
// read_thread_terminal).
function clientRoutedTools() {
  return [
    { type: "function", name: "exec_command" },
    { type: "function", name: "view_image" },
    {
      type: "namespace",
      name: "collaboration",
      tools: [
        { type: "function", name: "spawn_agent" },
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
  ];
}

function fullAppToolNames(namespace) {
  const names = [];
  for (const entry of CODEX_APP_TOOLS) {
    if (namespace && entry.name !== namespace) continue;
    for (const fn of entry.tools || []) names.push(fn.name);
  }
  return names;
}

test("snapshot covers the full native app toolset (threads, automations, navigation)", () => {
  for (const name of [
    "create_thread",
    "list_threads",
    "read_thread",
    "fork_thread",
    "set_thread_title",
    "set_thread_archived",
    "set_thread_pinned",
    "send_message_to_thread",
    "handoff_thread",
    "wait_threads",
    "get_handoff_status",
    "automation_update",
    "list_projects",
    "open_in_codex",
    "navigate_to_codex_page",
    "read_thread_terminal",
    "load_workspace_dependencies",
  ]) {
    assert.ok(
      CODEX_APP_TOOL_NAMES.has(name),
      `snapshot must carry the app tool ${name}`,
    );
  }
});

test("merge fills the deferred app tools into the reduced client namespace", () => {
  const { tools, merged } = mergeCodexAppTools(clientRoutedTools());
  assert.equal(merged, true);
  const codexApp = tools.find((tool) => tool?.type === "namespace" && tool.name === "codex_app");
  assert.ok(codexApp, "codex_app namespace present after merge");
  const names = codexApp.tools.map((fn) => fn.name);
  for (const name of fullAppToolNames("codex_app")) {
    assert.ok(names.includes(name), `merged codex_app must include ${name}`);
  }
  // Nothing the client sent is dropped.
  assert.ok(names.includes("load_workspace_dependencies"));
  assert.ok(names.includes("navigate_to_codex_page"));
  assert.ok(names.includes("read_thread_terminal"));
  // The plugin_management namespace is appended with its own tool.
  const pluginMgmt = tools.find(
    (tool) => tool?.type === "namespace" && tool.name === "plugin_management",
  );
  assert.ok(pluginMgmt, "plugin_management namespace present after merge");
  assert.ok(pluginMgmt.tools.some((fn) => fn.name === "uninstall_plugin"));
  // Non-app tools are untouched.
  assert.ok(tools.some((tool) => tool.name === "exec_command"));
  assert.ok(
    tools.some(
      (tool) =>
        tool?.type === "namespace" &&
        tool.name === "collaboration" &&
        tool.tools.some((fn) => fn.name === "spawn_agent"),
    ),
  );
});

test("merge appends the full app namespaces when the client omits them", () => {
  const { tools, merged } = mergeCodexAppTools([
    { type: "function", name: "exec_command" },
  ]);
  assert.equal(merged, true);
  const codexApp = tools.find((tool) => tool?.type === "namespace" && tool.name === "codex_app");
  assert.ok(codexApp, "codex_app appended when absent");
  for (const name of fullAppToolNames("codex_app")) {
    assert.ok(
      codexApp.tools.some((fn) => fn.name === name),
      `appended codex_app must include ${name}`,
    );
  }
  assert.ok(
    tools.some(
      (tool) =>
        tool?.type === "namespace" &&
        tool.name === "plugin_management" &&
        tool.tools.some((fn) => fn.name === "uninstall_plugin"),
    ),
    "plugin_management appended when absent",
  );
});

test("merge leaves a full client namespace intact (client definitions win)", () => {
  const clientTools = clientRoutedTools();
  const { tools, merged } = mergeCodexAppTools([
    ...clientTools,
    {
      type: "namespace",
      name: "plugin_management",
      tools: [{ type: "function", name: "uninstall_plugin" }],
    },
  ]);
  assert.equal(merged, true);
  const pluginMgmt = tools.find(
    (tool) => tool?.type === "namespace" && tool.name === "plugin_management",
  );
  assert.ok(pluginMgmt, "plugin_management namespace present after merge");
  assert.ok(pluginMgmt.tools.some((fn) => fn.name === "uninstall_plugin"));
});

test("splitFlatCodexAppName parses flattened names only", () => {
  assert.deepEqual(splitFlatCodexAppName("codex_app__create_thread"), {
    namespace: "codex_app",
    name: "create_thread",
  });
  assert.equal(splitFlatCodexAppName("exec_command"), undefined);
  assert.equal(splitFlatCodexAppName("codex_app__"), undefined);
});


test("modern MCP app registration owns its surface without the legacy snapshot", () => {
  const fn = { type: "function", name: "list_projects", parameters: { type: "object", properties: {} } };
  const shapes = [
    { type: "namespace", name: "mcp__codex_app", defer_loading: true, tools: [fn] },
    { ...fn, namespace: "mcp__codex_app" },
    { ...fn, name: "mcp__codex_app__list_projects" },
    { type: "function", function: { ...fn, name: "mcp__codex_app__list_projects" } },
  ];
  for (const shape of shapes) {
    const tools = [{ type: "function", name: "exec_command" }, shape];
    const before = structuredClone(tools);
    const result = mergeCodexAppTools(tools);
    assert.equal(result.merged, false);
    assert.strictEqual(result.tools, tools);
    assert.deepEqual(tools, before);
  }
});

test("unrelated MCP connectors do not impersonate the app registration", () => {
  for (const name of ["mcp__codex_apps__notion", "mcp__codex_application", "other"]) {
    assert.equal(mergeCodexAppTools([{ type: "namespace", name, tools: [] }]).merged, true);
  }
});
