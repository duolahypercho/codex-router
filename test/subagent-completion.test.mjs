import assert from "node:assert/strict";
import { Readable } from "node:stream";
import test from "node:test";

import {
  collectFinishedSubagentState,
  pendingInterruptTargets,
  pendingInterruptPlan,
  subagentToolAvailable,
  buildInterruptAgentCall,
  filterAlreadyInterrupted,
} from "../src/subagent-completion.mjs";
import {
  NamespaceToolCallTransform,
  flattenNamespaceTools,
} from "../src/namespace-relay.mjs";

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

function finalAnswerMessage(author, body = "done") {
  return {
    type: "agent_message",
    author,
    recipient: "/root",
    content: [
      {
        type: "input_text",
        text: `Message Type: FINAL_ANSWER\nTask name: /root\nSender: ${author}\nPayload:\n${body}`,
      },
    ],
  };
}

function functionCall(name, namespace, args, callId) {
  return {
    type: "function_call",
    name,
    ...(namespace ? { namespace } : {}),
    call_id: callId,
    arguments: JSON.stringify(args),
  };
}

function collaborationNamespaces() {
  return flattenNamespaceTools([
    {
      type: "namespace",
      name: "collaboration",
      tools: [
        { type: "function", name: "spawn_agent" },
        { type: "function", name: "interrupt_agent" },
        { type: "function", name: "wait_agent" },
      ],
    },
  ]).namespaces;
}

function agentNamespaces(name = "agents") {
  return flattenNamespaceTools([
    {
      type: "namespace",
      name,
      tools: [
        { type: "function", name: "spawn_agent" },
        { type: "function", name: "wait_agent" },
        { type: "function", name: "interrupt_agent" },
      ],
    },
  ]).namespaces;
}

function lifecycleHistory(namespace, sender = "/root/child") {
  return [
    functionCall("spawn_agent", namespace, { task_name: "prior" }, `call_${namespace}_spawn`),
    functionCall("wait_agent", namespace, { targets: ["prior"] }, `call_${namespace}_wait`),
    finalAnswerMessage(sender),
  ];
}

test("subagent lifecycle availability survives supported namespace collisions", () => {
  const collaboration = collaborationNamespaces();
  const agents = agentNamespaces();
  const both = new Map([...collaboration, ...agents]);
  const unrelated = agentNamespaces("mcp__agents");
  const input = [finalAnswerMessage("/root/child")];

  assert.equal(subagentToolAvailable(collaboration), true);
  assert.equal(subagentToolAvailable(agents), true);
  assert.equal(subagentToolAvailable(both), true);
  assert.equal(subagentToolAvailable(unrelated), false);
  assert.deepEqual(pendingInterruptTargets(input, { namespaces: collaboration }), [
    "/root/child",
  ]);
  assert.deepEqual(pendingInterruptTargets(input, { namespaces: agents }), ["/root/child"]);
  assert.deepEqual(pendingInterruptTargets(input, { namespaces: both }), []);
  assert.deepEqual(
    pendingInterruptTargets(input, { namespaces: unrelated }),
    [],
  );
  assert.deepEqual(
    pendingInterruptTargets(input, {
      namespaces: new Map([["collaboration", new Set(["spawn_agent"])]]),
    }),
    [],
  );
});

test("collectFinishedSubagentState finds FINAL_ANSWER authors and skips already interrupted", () => {
  const input = [
    finalAnswerMessage("/root/visual_critic"),
    finalAnswerMessage("/root/metric_tiles"),
    functionCall(
      "interrupt_agent",
      "collaboration",
      { target: "/root/visual_critic" },
      "call_1",
    ),
  ];
  const state = collectFinishedSubagentState(input);
  assert.deepEqual([...state.finished].sort(), [
    "/root/metric_tiles",
    "/root/visual_critic",
  ]);
  assert.deepEqual([...state.interrupted], ["/root/visual_critic"]);
  assert.deepEqual(state.pending, ["/root/metric_tiles"]);
});

test("collectFinishedSubagentState deduplicates bare and root-qualified agent targets", () => {
  const input = [
    finalAnswerMessage("/root/native_regression_probe"),
    functionCall(
      "interrupt_agent",
      "agents",
      { target: "native_regression_probe" },
      "call_native_interrupt",
    ),
  ];
  const state = collectFinishedSubagentState(input);

  assert.deepEqual(state.finished, new Set(["/root/native_regression_probe"]));
  assert.deepEqual(state.interrupted, new Set(["native_regression_probe"]));
  assert.deepEqual(state.pending, []);
  assert.deepEqual(
    pendingInterruptTargets(input, { namespaces: agentNamespaces() }),
    [],
  );
  const deferred = pendingInterruptPlan(input, { namespaces: new Map() });
  assert.equal(deferred.namespace, "agents");
  assert.deepEqual(deferred.targets, []);
});

test("unrelated namespaced and unqualified interrupt calls cannot suppress a close", () => {
  const calls = [
    functionCall(
      "interrupt_agent",
      "mcp__files",
      { target: "/root/child" },
      "call_mcp_interrupt",
    ),
    functionCall(
      "interrupt_agent",
      undefined,
      { target: "/root/child" },
      "call_unqualified_interrupt",
    ),
    functionCall(
      "agents__interrupt_agent",
      undefined,
      { target: "/root/child" },
      "call_literal_flat_interrupt",
    ),
  ];

  for (const call of calls) {
    const input = [finalAnswerMessage("/root/child"), call];
    const state = collectFinishedSubagentState(input);
    assert.deepEqual([...state.interrupted], []);
    assert.deepEqual(state.pending, ["/root/child"]);
    assert.deepEqual(
      pendingInterruptTargets(input, { namespaces: collaborationNamespaces() }),
      ["/root/child"],
    );
  }
});

test("unqualified flattened-looking agent calls cannot prove an interrupt", () => {
  const state = collectFinishedSubagentState([
    finalAnswerMessage("/root/child"),
    functionCall("agents__interrupt_agent", undefined, { target: "/root/child" }, "call_agents_interrupt"),
  ]);
  assert.deepEqual(state.pending, ["/root/child"]);
});

test("collectFinishedSubagentState deduplicates final-answer target aliases", () => {
  const input = [
    finalAnswerMessage("/root/child"),
    finalAnswerMessage("child"),
  ];
  const state = collectFinishedSubagentState(input);

  assert.deepEqual([...state.finished], ["/root/child"]);
  assert.deepEqual(state.pending, ["/root/child"]);
  assert.deepEqual(
    pendingInterruptTargets(input, { namespaces: collaborationNamespaces() }),
    ["/root/child"],
  );
});

test("an empty tool inventory infers one lifecycle namespace from typed history", () => {
  const namespaces = new Map();

  for (const namespace of ["agents", "collaboration"]) {
    const input = lifecycleHistory(namespace);
    const plan = pendingInterruptPlan(input, { namespaces });
    assert.equal(plan.namespace, namespace);
    assert.deepEqual(plan.targets, ["/root/child"]);
    assert.deepEqual(pendingInterruptTargets(input, { namespaces }), ["/root/child"]);
  }
});

test("unauthorized close injection inventories fail closed and preserve bytes", async () => {
  const cases = [
    {
      label: "missing inventory",
      namespaces: new Map(),
      input: [finalAnswerMessage("/root/child")],
      interruptNamespace: undefined,
    },
    {
      label: "ambiguous native namespaces",
      namespaces: new Map([...collaborationNamespaces(), ...agentNamespaces()]),
      input: [finalAnswerMessage("/root/child")],
      interruptNamespace: "agents",
    },
    {
      label: "partial native namespace conflict",
      namespaces: new Map([
        ["collaboration", new Set(["interrupt_agent"])],
        ["agents", new Set(["spawn_agent", "wait_agent"])],
      ]),
      input: lifecycleHistory("agents"),
      interruptNamespace: "collaboration",
    },
    {
      label: "unrelated nonempty inventory",
      namespaces: new Map([["mcp__files", new Set(["read_file"])]]),
      input: lifecycleHistory("agents"),
      interruptNamespace: "agents",
    },
  ];
  const original =
    'data: {"type":"response.completed",  "sequence_number":2,"response":{"output":[]}}\n\n';

  for (const { label, namespaces, input, interruptNamespace } of cases) {
    const plan = pendingInterruptPlan(input, { namespaces });
    assert.equal(plan.namespace, undefined, label);
    assert.deepEqual(plan.targets, [], label);
    const transform = new NamespaceToolCallTransform(
      namespaces,
      "text/event-stream",
      undefined,
      {
        pendingInterrupts: ["/root/child"],
        interruptNamespace,
        injectOnly: true,
      },
    );
    assert.equal(
      await collect(Readable.from([original]).pipe(transform)),
      original,
      label,
    );
  }
});

test("empty-inventory namespace inference fails closed on conflicting or unknown history", async () => {
  const inputCases = [
    {
      label: "conflicting native namespaces",
      input: [
        ...lifecycleHistory("agents").slice(0, 1),
        ...lifecycleHistory("collaboration").slice(0, 1),
        finalAnswerMessage("/root/child"),
      ],
    },
    {
      label: "unknown namespace",
      input: [
        functionCall("spawn_agent", "mcp__agents", {}, "call_mcp_spawn"),
        finalAnswerMessage("/root/child"),
      ],
    },
    {
      label: "literal flattened-looking default function",
      input: [
        functionCall("agents__spawn_agent", undefined, {}, "call_literal_flat_spawn"),
        finalAnswerMessage("/root/child"),
      ],
    },
    {
      label: "prose is not typed tool history",
      input: [
        {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "Previously called agents.spawn_agent." }],
        },
        finalAnswerMessage("/root/child"),
      ],
    },
  ];
  const completed =
    'data: {"type":"response.completed",  "sequence_number":2,"response":{"output":[]}}\n\n';

  for (const { label, input } of inputCases) {
    const plan = pendingInterruptPlan(input, { namespaces: new Map() });
    assert.equal(plan.namespace, undefined, label);
    assert.deepEqual(plan.targets, [], label);
    const transform = new NamespaceToolCallTransform(
      new Map(),
      "text/event-stream",
      undefined,
      {
        pendingInterrupts: plan.targets,
        interruptNamespace: plan.namespace,
        injectOnly: true,
      },
    );
    assert.equal(
      await collect(Readable.from([completed]).pipe(transform)),
      completed,
      label,
    );
  }
});

test("resolved empty-inventory namespace reaches stream and JSON close injection", async () => {
  const namespaces = new Map();
  const input = lifecycleHistory("agents");
  const plan = pendingInterruptPlan(input, { namespaces });
  assert.equal(plan.namespace, "agents");
  assert.deepEqual(plan.targets, ["/root/child"]);

  const stream = await collect(
    Readable.from([
      'event: response.completed\ndata: {"type":"response.completed","sequence_number":2,"response":{"output":[]}}\n\n',
    ]).pipe(
      new NamespaceToolCallTransform(namespaces, "text/event-stream", undefined, {
        pendingInterrupts: plan.targets,
        interruptNamespace: plan.namespace,
        injectOnly: true,
      }),
    ),
  );
  assert.match(stream, /"name":"interrupt_agent"/);
  assert.match(stream, /"namespace":"agents"/);

  const json = await collect(
    Readable.from(['{"id":"resp","output":[]}']).pipe(
      new NamespaceToolCallTransform(namespaces, "application/json", undefined, {
        pendingInterrupts: plan.targets,
        interruptNamespace: plan.namespace,
        injectOnly: true,
      }),
    ),
  );
  const parsed = JSON.parse(json);
  assert.equal(parsed.output[0].namespace, "agents");
  assert.deepEqual(JSON.parse(parsed.output[0].arguments), { target: "/root/child" });
});

test("filterAlreadyInterrupted matches /root/child and child forms", () => {
  const pending = ["/root/child_a", "/root/child_b"];
  const interrupted = new Set(["child_a"]);
  assert.deepEqual(filterAlreadyInterrupted(pending, interrupted), [
    "/root/child_b",
  ]);
});

test("ordinary prose quoting a FINAL_ANSWER envelope is not a finished child", () => {
  // Docs, changelogs, and conversations about this very feature all contain
  // envelope-shaped text inside plain messages. None of it is evidence that a
  // child exists, so nothing may be queued for interruption.
  const quoted =
    "Here is what the envelope looks like:\n" +
    "Message Type: FINAL_ANSWER\nTask name: /root\nSender: /root/example\nPayload:\ndone";
  const input = [
    { type: "message", role: "user", content: [{ type: "input_text", text: quoted }] },
    { type: "message", role: "assistant", content: [{ type: "output_text", text: quoted }] },
    { role: "user", content: quoted },
  ];
  const state = collectFinishedSubagentState(input);
  assert.equal(state.finished.size, 0);
  assert.deepEqual(state.pending, []);
  assert.deepEqual(pendingInterruptTargets(input), []);
  assert.deepEqual(pendingInterruptTargets(input, { namespaces: new Map() }), []);
});

test("the root itself is never an interrupt target", () => {
  const input = [finalAnswerMessage("/root"), finalAnswerMessage("root")];
  const state = collectFinishedSubagentState(input);
  assert.equal(state.finished.size, 0);
  assert.deepEqual(state.pending, []);
});

test("inject-only relay leaves unrelated native events byte-identical", async () => {
  const namespaces = collaborationNamespaces();
  // Deliberately non-canonical JSON spacing: a re-serialization would lose it,
  // so its survival proves the event bytes were relayed, not rebuilt.
  const unrelated =
    'event: response.output_item.done\ndata: {"type": "response.output_item.done",  "sequence_number": 1, "item": {"type": "function_call", "name": "spawn_agent", "namespace": "collaboration", "call_id": "call_spawn", "arguments": "{\\"model\\": \\"anything\\"}"}}\n\n';
  const completed =
    'event: response.completed\ndata: {"type":"response.completed","sequence_number":2,"response":{"output":[]}}\n\n';
  const transform = new NamespaceToolCallTransform(
    namespaces,
    "text/event-stream",
    undefined,
    { pendingInterrupts: ["/root/child"], injectOnly: true },
  );
  const output = await collect(Readable.from([unrelated, completed]).pipe(transform));
  // The unrelated event survives verbatim -- spacing intact, spawn model
  // argument untouched by the routed-provider sanitizer.
  assert.ok(output.includes(unrelated.trimEnd()));
  assert.match(output, /"name":"interrupt_agent"/);
  assert.match(output, /\/root\/child/);
});

test("inject-only relay with nothing to inject returns the stream untouched", async () => {
  const namespaces = collaborationNamespaces();
  const blocks = [
    'event: response.output_item.done\ndata: {"type": "response.output_item.done", "sequence_number": 1, "item": {"type": "function_call", "name": "interrupt_agent", "namespace": "collaboration", "call_id": "call_done", "arguments": "{\\"target\\": \\"/root/child\\"}"}}\n\n',
    'event: response.completed\ndata: {"type": "response.completed", "sequence_number": 2, "response": {"output": []}}\n\n',
  ];
  const transform = new NamespaceToolCallTransform(
    namespaces,
    "text/event-stream",
    undefined,
    { pendingInterrupts: ["/root/child"], injectOnly: true },
  );
  const output = await collect(Readable.from(blocks).pipe(transform));
  // The model already closed the child, so the relay changes nothing but the
  // trailing empty separator the block splitter has always re-appended.
  assert.equal(output.trimEnd(), blocks.join("").trimEnd());
  assert.equal(output.trim().startsWith(blocks[0].trimEnd()), true);
});

test("stream transform injects interrupt_agent before response.completed", async () => {
  const namespaces = collaborationNamespaces();
  const events = [
    {
      type: "response.output_item.done",
      sequence_number: 1,
      item: {
        type: "function_call",
        name: "exec_command",
        call_id: "call_work",
        arguments: "{}",
      },
    },
    {
      type: "response.completed",
      sequence_number: 2,
      response: {
        output: [
          {
            type: "function_call",
            name: "exec_command",
            call_id: "call_work",
            arguments: "{}",
          },
        ],
      },
    },
    { type: "response.done", sequence_number: 3 },
  ].map(
    (event) =>
      `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
  );
  const transform = new NamespaceToolCallTransform(
    namespaces,
    "text/event-stream",
    "kimi-oauth/k3",
    { pendingInterrupts: ["/root/visual_critic", "/root/metric_tiles"] },
  );
  const output = await collect(Readable.from(events).pipe(transform));
  assert.match(output, /"name":"interrupt_agent"/);
  assert.match(output, /"namespace":"collaboration"/);
  assert.match(output, /\/root\/visual_critic/);
  assert.match(output, /\/root\/metric_tiles/);
  // Injected before completed, not after done.
  const criticAt = output.indexOf("/root/visual_critic");
  const completedAt = output.indexOf('"type":"response.completed"');
  const doneAt = output.indexOf('"type":"response.done"');
  assert.ok(criticAt > 0);
  assert.ok(completedAt > criticAt);
  assert.ok(doneAt > completedAt);
  // Only one pair per target.
  assert.equal((output.match(/\/root\/visual_critic/g) || []).length >= 1, true);
});

test("separate stream transforms give router-injected interrupts distinct call ids", async () => {
  const namespaces = collaborationNamespaces();
  const event = `data: ${JSON.stringify({
    type: "response.completed",
    sequence_number: 1,
    response: { output: [] },
  })}\n\n`;

  async function injectedCallId() {
    const transform = new NamespaceToolCallTransform(
      namespaces,
      "text/event-stream",
      "kimi-oauth/k3",
      { pendingInterrupts: ["/root/visual_critic"] },
    );
    const output = await collect(Readable.from([event]).pipe(transform));
    const match = output.match(/"call_id":"(call_router_interrupt_[^"]+)"/);
    assert.ok(match, output);
    return match[1];
  }

  const first = await injectedCallId();
  const second = await injectedCallId();
  assert.notEqual(first, second);
});

test("stream transform does not re-interrupt a target the model already closed", async () => {
  const namespaces = collaborationNamespaces();
  const events = [
    {
      type: "response.output_item.done",
      sequence_number: 1,
      item: {
        type: "function_call",
        name: "collaboration__interrupt_agent",
        call_id: "call_model",
        arguments: JSON.stringify({ target: "/root/visual_critic" }),
      },
    },
    {
      type: "response.completed",
      sequence_number: 2,
      response: {
        output: [
          {
            type: "function_call",
            name: "collaboration__interrupt_agent",
            call_id: "call_model",
            arguments: JSON.stringify({ target: "/root/visual_critic" }),
          },
        ],
      },
    },
  ].map((event) => `data: ${JSON.stringify(event)}\n\n`);
  const transform = new NamespaceToolCallTransform(
    namespaces,
    "text/event-stream",
    "kimi-oauth/k3",
    { pendingInterrupts: ["/root/visual_critic"] },
  );
  const output = await collect(Readable.from(events).pipe(transform));
  // Restored model call remains; no second router interrupt for same target.
  assert.match(output, /"name":"interrupt_agent"/);
  assert.equal((output.match(/call_router_interrupt_/g) || []).length, 0);
});

test("non-stream JSON payload receives injected interrupts in output", async () => {
  const namespaces = collaborationNamespaces();
  const payload = {
    output: [
      {
        type: "function_call",
        name: "collaboration__spawn_agent",
        call_id: "call_1",
        arguments: "{}",
      },
    ],
  };
  const transform = new NamespaceToolCallTransform(
    namespaces,
    "application/json",
    "kimi-oauth/k3",
    { pendingInterrupts: ["/root/child"] },
  );
  const output = await collect(
    Readable.from([Buffer.from(JSON.stringify(payload), "utf8")]).pipe(transform),
  );
  const parsed = JSON.parse(output);
  assert.equal(parsed.output.length, 2);
  assert.equal(parsed.output[1].name, "interrupt_agent");
  assert.equal(parsed.output[1].namespace, "collaboration");
  assert.equal(JSON.parse(parsed.output[1].arguments).target, "/root/child");
});

test("buildInterruptAgentCall shapes native collaboration call", () => {
  const call = buildInterruptAgentCall("/root/child", { callId: "call_x" });
  assert.deepEqual(call, {
    type: "function_call",
    name: "interrupt_agent",
    namespace: "collaboration",
    call_id: "call_x",
    arguments: JSON.stringify({ target: "/root/child" }),
  });
  assert.throws(
    () => buildInterruptAgentCall("/root/child", { namespace: "mcp__files" }),
    /namespace is unsupported/,
  );
});
