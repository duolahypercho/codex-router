import assert from "node:assert/strict";
import test from "node:test";
import { grokToolDiagnostics } from "../src/grok-tool-diagnostics.mjs";
import { chatProviderToolSurface } from "../src/chat-tool-surface.mjs";

const poll = { type: "function", name: "write_stdin", parameters: {
  type: "object", properties: { session_id: { type: "number" }, chars: { type: "string" },
    yield_time_ms: { type: "number" }, max_output_tokens: { type: "number" } }, required: ["session_id"],
} };

test("poll diagnostics follow the native namespace through the Chat surface without dropping its schema", () => {
  const tools = [{ type: "namespace", name: "functions", tools: [poll] }];
  const before = grokToolDiagnostics(tools);
  const surface = chatProviderToolSurface(tools, "grok-oauth");
  const after = grokToolDiagnostics(surface.tools);
  assert.deepEqual(after.known.write_stdin, before.known.write_stdin);
  assert.deepEqual(after.known.write_stdin.declarations[0].parameters,
    ["chars", "max_output_tokens", "session_id", "yield_time_ms"]);
  assert.equal(after.known.write_stdin.declarations[0].deferred, false);
  const chat = grokToolDiagnostics([{ type: "function", function: { name: poll.name, parameters: poll.parameters } }]);
  assert.deepEqual(chat.known.write_stdin, before.known.write_stdin);
});

test("tool diagnostics distinguish absent, deferred, changed and duplicate declarations", () => {
  const base = grokToolDiagnostics([poll]);
  assert.deepEqual(grokToolDiagnostics([]), { count: 0, known: {} });
  const deferred = grokToolDiagnostics([{ ...poll, defer_loading: true }]);
  assert.equal(deferred.known.write_stdin.declarations[0].deferred, true);
  const changed = grokToolDiagnostics([{ ...poll, parameters: { type: "object", properties: {} } }]);
  assert.notEqual(changed.known.write_stdin.declarations[0].schemaSha256,
    base.known.write_stdin.declarations[0].schemaSha256);
  const duplicate = grokToolDiagnostics(Array(50).fill(poll));
  assert.equal(duplicate.known.write_stdin.count, 50);
  assert.equal(duplicate.known.write_stdin.declarations.length, 4);
});

test("namespace deferral is visible before the search relay withholds its function", () => {
  const tools = [{ type: "namespace", name: "functions", defer_loading: true, tools: [poll] },
    { type: "tool_search", execution: "client" }];
  const before = grokToolDiagnostics(tools);
  assert.equal(before.known.write_stdin.declarations[0].deferred, true);
  const after = grokToolDiagnostics(chatProviderToolSurface(tools, "grok-oauth").tools);
  assert.equal(after.known.write_stdin, undefined);
});

test("diagnostics never reflect unknown names, namespaces, properties or schema content", () => {
  const secret = "DO_NOT_LOG_PRIVATE_CONTENT";
  const result = grokToolDiagnostics([
    { ...poll, name: secret },
    { type: "namespace", name: secret, tools: [poll] },
    { ...poll, namespace: secret },
    { ...poll, description: secret, parameters: { properties: { session_id: { description: secret }, [secret]: {} } } },
    { type: "custom", name: "apply_patch", format: { type: "grammar", definition: secret } },
  ]);
  assert.equal(result.count, 5);
  assert.equal(result.known.write_stdin.count, 1);
  assert.equal(result.known.apply_patch.declarations[0].type, "custom");
  assert.doesNotMatch(JSON.stringify(result), new RegExp(secret));
  assert.deepEqual(result.known.write_stdin.declarations[0].parameters, ["session_id"]);
});


test("discovery and app diagnostics distinguish native, relay, current and legacy registrations", () => {
  const app = { type: "function", name: "list_projects", parameters: { type: "object", properties: {} } };
  const tools = [
    { type: "tool_search", execution: "client", parameters: {
      type: "object", properties: { query: { type: "string" }, limit: { type: "number" } },
    } },
    { type: "namespace", name: "mcp__codex_app", defer_loading: true, tools: [app] },
    { type: "namespace", name: "codex_app", tools: [app] },
  ];
  const before = grokToolDiagnostics(tools);
  assert.equal(before.known.tool_search.declarations[0].execution, "client");
  assert.equal(before.known.mcp__codex_app__list_projects.declarations[0].deferred, true);
  assert.equal(before.known.codex_app__list_projects.declarations[0].deferred, false);
  const after = grokToolDiagnostics(chatProviderToolSurface(tools, "grok-oauth").tools);
  assert.equal(after.known.tool_search.declarations[0].type, "function");
  assert.equal(after.known.mcp__codex_app__list_projects, undefined);
  assert.deepEqual(after.known.codex_app__list_projects, before.known.codex_app__list_projects);
  const chat = grokToolDiagnostics([{ type: "function", function: {
    ...app, name: "mcp__codex_app__list_projects",
  } }]);
  assert.equal(chat.known.mcp__codex_app__list_projects.declarations[0].schemaSha256,
    before.known.mcp__codex_app__list_projects.declarations[0].schemaSha256);
});

test("app diagnostics do not log lookalikes or arbitrary search metadata", () => {
  const secret = "DO_NOT_LOG_DISCOVERY_SECRET";
  const tools = [
    { type: "function", name: "create_thread" },
    { type: "function", name: "mcp__codex_app__" + secret },
    { type: "namespace", name: "mcp__codex_apps__private", tools: [{ type: "function", name: "create_thread" }] },
    { type: "function", name: "mcp__codex_app__list_projects", namespace: secret },
    { type: "namespace", name: "mcp__codex_app", tools: [{ type: "function", name: "create_thread", namespace: secret }] },
    { type: "tool_search", execution: secret, description: secret },
  ];
  const result = grokToolDiagnostics(tools);
  assert.deepEqual(Object.keys(result.known), ["tool_search"]);
  assert.doesNotMatch(JSON.stringify(result), new RegExp(secret));
});
