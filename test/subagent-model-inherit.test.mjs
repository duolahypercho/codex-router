import assert from "node:assert/strict";
import test from "node:test";

import {
  SPAWN_MODEL_TOOLS,
  buildNamespaceLookups,
  flattenNamespaceTools,
  injectSessionModelForSpawnCalls,
  rewriteNamespaceResponsePayload,
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

test("explicit model on a fresh thread wins and stays untouched", () => {
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
});

test("an explicit subagent model is kept instead of pinned to the routed parent", () => {
  // Codex renders the override as a plain string and validates it against its
  // own list, so a value here is the operator's delegation choice. Rewriting it
  // back to the parent is what made cross-provider subagents impossible.
  for (const subagent of [
    spawnCall(
      "collaboration__spawn_agent",
      undefined,
      JSON.stringify({ task_name: "review", message: "inspect", model: "gpt-6-astra" }),
    ),
    spawnCall(
      "spawn_agent",
      "collaboration",
      JSON.stringify({ task_name: "review", message: "inspect", model: "gpt-5.6-sol" }),
    ),
  ]) {
    assert.equal(injectSessionModelForSpawnCalls(subagent, SESSION_MODEL), subagent);
  }
});

test("an unusable spawn model still inherits the routed parent", () => {
  // Absent, empty, and non-string values carry no override, so the child keeps
  // the routed parent exactly as it did before.
  const cases = [
    { task_name: "review", message: "inspect" },
    { task_name: "review", message: "inspect", model: "" },
    { task_name: "review", message: "inspect", model: null },
    { task_name: "review", message: "inspect", model: 7 },
  ];
  for (const args of cases) {
    for (const build of [
      (value) => spawnCall("collaboration__spawn_agent", undefined, JSON.stringify(value)),
      (value) => spawnCall("spawn_agent", "collaboration", JSON.stringify(value)),
    ]) {
      const subagent = build(args);
      const next = injectSessionModelForSpawnCalls(subagent, SESSION_MODEL);
      assert.notEqual(next, subagent);
      assert.equal(JSON.parse(next.arguments).model, SESSION_MODEL);
    }
  }
});

test("a spawned model equal to the routed parent is left untouched", () => {
  const item = spawnCall(
    "collaboration__spawn_agent",
    undefined,
    JSON.stringify({ task_name: "review", message: "inspect", model: SESSION_MODEL }),
  );
  assert.equal(injectSessionModelForSpawnCalls(item, SESSION_MODEL), item);
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

// `sanitizeSpawnAgentModel` polices an advertised enum when a client version
// ships one, so that split is exercised end to end through the real
// flatten/lookup/rewrite path instead of by calling the helper directly.
function routedCollaborationTools(models) {
  return [
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
                anyOf: [{ type: "string", enum: models }, { type: "null" }],
              },
            },
          },
        },
      ],
    },
  ];
}

function flattenedSpawnPayload(model) {
  return {
    output: [
      {
        type: "function_call",
        name: "collaboration__spawn_agent",
        call_id: "call_1",
        arguments: JSON.stringify({ task_name: "review", model }),
      },
    ],
  };
}

test("the client's advertised enum reaches the wire rewrite and is preserved", () => {
  const { namespaces } = flattenNamespaceTools(
    routedCollaborationTools(["gpt-6-astra", "gpt-5.6-sol"]),
  );
  const lookups = buildNamespaceLookups(namespaces);
  assert.ok(lookups.spawnAgentModels.has("gpt-6-astra"));

  const rewritten = rewriteNamespaceResponsePayload(
    flattenedSpawnPayload("gpt-6-astra"),
    lookups,
    SESSION_MODEL,
  );
  const item = rewritten.output[0];
  assert.equal(item.name, "spawn_agent");
  assert.equal(item.namespace, "collaboration");
  assert.equal(JSON.parse(item.arguments).model, "gpt-6-astra");
});

test("a wire model outside the advertised enum is still pinned to the parent", () => {
  const { namespaces } = flattenNamespaceTools(
    routedCollaborationTools(["gpt-6-astra", "gpt-5.6-sol"]),
  );
  const lookups = buildNamespaceLookups(namespaces);

  // `gpt-5.6-terra` is a real catalog entry the client did not advertise for
  // this session, so it is still treated as an invented value.
  const rewritten = rewriteNamespaceResponsePayload(
    flattenedSpawnPayload("gpt-5.6-terra"),
    lookups,
    SESSION_MODEL,
  );
  const item = rewritten.output[0];
  assert.equal(item.name, "spawn_agent");
  assert.equal(JSON.parse(item.arguments).model, SESSION_MODEL);
});
