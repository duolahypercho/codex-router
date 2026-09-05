import assert from "node:assert/strict";
import test from "node:test";

import {
  SPAWN_MODEL_TOOLS,
  injectSessionModelForSpawnCalls,
} from "../src/namespace-relay.mjs";

const SESSION_MODEL = "opencode-go/deepseek-v4-flash";

function spawnCall(name, namespace, argumentsText) {
  const item = {
    type: "function_call",
    name,
    call_id: "call_1",
    arguments: argumentsText,
  };
  if (namespace !== undefined) item.namespace = namespace;
  return item;
}

test("local thread and subagent spawns are eligible for routed model inheritance", () => {
  assert.deepEqual([...SPAWN_MODEL_TOOLS], ["create_thread", "spawn_agent"]);
});

test("routed session + omitted model injects the session model (flattened form)", () => {
  const item = spawnCall("codex_app__create_thread", undefined, JSON.stringify({ prompt: "hi", target: { type: "projectless" } }));
  const next = injectSessionModelForSpawnCalls(item, SESSION_MODEL);
  assert.notEqual(next, item);
  assert.deepEqual(JSON.parse(next.arguments), {
    prompt: "hi",
    target: { type: "projectless" },
    model: SESSION_MODEL,
  });
});

test("routed session + omitted model keeps a flattened subagent on its parent model", () => {
  const item = spawnCall(
    "collaboration__spawn_agent",
    undefined,
    JSON.stringify({ task_name: "review", message: "inspect" }),
  );
  const next = injectSessionModelForSpawnCalls(item, SESSION_MODEL);
  assert.notEqual(next, item);
  assert.deepEqual(JSON.parse(next.arguments), {
    task_name: "review",
    message: "inspect",
    model: SESSION_MODEL,
  });
});

test("routed session + omitted model keeps a native subagent on its parent model", () => {
  const item = spawnCall(
    "spawn_agent",
    "collaboration",
    JSON.stringify({ task_name: "review", message: "inspect" }),
  );
  const next = injectSessionModelForSpawnCalls(item, SESSION_MODEL);
  assert.deepEqual(JSON.parse(next.arguments), {
    task_name: "review",
    message: "inspect",
    model: SESSION_MODEL,
  });
});

test("send_message_to_thread keeps the target thread model settings", () => {
  const item = spawnCall(
    "send_message_to_thread",
    "codex_app",
    JSON.stringify({ threadId: "t1", prompt: "continue" }),
  );
  const next = injectSessionModelForSpawnCalls(item, SESSION_MODEL);
  assert.equal(next, item);
});

test("explicit model always wins and stays untouched", () => {
  const item = spawnCall(
    "codex_app__create_thread",
    undefined,
    JSON.stringify({ prompt: "hi", model: "gpt-5.6-terra" }),
  );
  const next = injectSessionModelForSpawnCalls(item, SESSION_MODEL);
  assert.equal(next, item);
  assert.equal(JSON.parse(next.arguments).model, "gpt-5.6-terra");

  const namespaced = spawnCall(
    "send_message_to_thread",
    "codex_app",
    JSON.stringify({ threadId: "t1", prompt: "continue", model: "gpt-5.5" }),
  );
  assert.equal(injectSessionModelForSpawnCalls(namespaced, SESSION_MODEL), namespaced);

  const subagent = spawnCall(
    "spawn_agent",
    "collaboration",
    JSON.stringify({ task_name: "review", message: "inspect", model: "gpt-5.6-terra" }),
  );
  assert.equal(injectSessionModelForSpawnCalls(subagent, SESSION_MODEL), subagent);
});

test("chatgptWorkCloud create_thread calls omit model", () => {
  const item = spawnCall(
    "codex_app__create_thread",
    undefined,
    JSON.stringify({ prompt: "cloud", target: { type: "chatgptWorkCloud" } }),
  );
  assert.equal(injectSessionModelForSpawnCalls(item, SESSION_MODEL), item);
});

test("non-routed session + omitted model stays untouched", () => {
  const item = spawnCall("codex_app__create_thread", undefined, JSON.stringify({ prompt: "hi" }));
  // No session model available (native session): nothing to inherit.
  assert.equal(injectSessionModelForSpawnCalls(item, undefined), item);
  assert.equal(injectSessionModelForSpawnCalls(item, ""), item);
  // A native-session name (not codex_app) is never a spawn target either.
  const native = spawnCall("create_thread", undefined, JSON.stringify({ prompt: "hi" }));
  assert.equal(injectSessionModelForSpawnCalls(native, SESSION_MODEL), native);
});

test("non-spawn tools are never touched", () => {
  for (const item of [
    spawnCall("codex_app__list_threads", undefined, "{}"),
    spawnCall("codex_app__read_thread", undefined, JSON.stringify({ threadId: "t1" })),
    spawnCall("mcp__node_repl__js", undefined, "{}"),
    // A different namespace with the same tool name is not the app's tool.
    spawnCall("mcp__other__create_thread", undefined, JSON.stringify({ prompt: "hi" })),
    spawnCall("mcp__other__spawn_agent", undefined, JSON.stringify({ task_name: "x" })),
    // A bare spelling carries no namespace authority and stays untouched.
    spawnCall("spawn_agent", undefined, JSON.stringify({ task_name: "x" })),
  ]) {
    assert.equal(injectSessionModelForSpawnCalls(item, SESSION_MODEL), item, item.name);
  }
});

test("malformed and non-call items are left alone", () => {
  const malformed = spawnCall("codex_app__create_thread", undefined, "{not json");
  assert.equal(injectSessionModelForSpawnCalls(malformed, SESSION_MODEL), malformed);
  const incomplete = spawnCall("codex_app__create_thread", undefined, undefined);
  assert.equal(injectSessionModelForSpawnCalls(incomplete, SESSION_MODEL), incomplete);
  assert.equal(injectSessionModelForSpawnCalls(undefined, SESSION_MODEL), undefined);
  const message = { type: "message", role: "user", content: [] };
  assert.equal(injectSessionModelForSpawnCalls(message, SESSION_MODEL), message);
  const nonObject = spawnCall("codex_app__create_thread", undefined, '"a string"');
  assert.equal(injectSessionModelForSpawnCalls(nonObject, SESSION_MODEL), nonObject);
});

test("injection is idempotent once the model is present", () => {
  const item = spawnCall(
    "codex_app__create_thread",
    undefined,
    JSON.stringify({ prompt: "hi", model: SESSION_MODEL }),
  );
  assert.equal(injectSessionModelForSpawnCalls(item, SESSION_MODEL), item);
});
