import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { callerBaseUrl } from "../src/caller-auth.mjs";
import { openPort } from "./port-pool.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const INTERNAL_KEY = "test-internal-service-key-with-sufficient-length";
const CALLER_KEY = "test-router-caller-capability-with-sufficient-length";

// An attempt that never proves it was generating. The guard holds all of it, so
// the router can swap it for a retry the client never sees.
const EMPTY_SSE = [
  'event: response.created',
  'data: {"type":"response.created","sequence_number":0,"response":{"id":"r-empty"}}',
  "",
  'event: response.in_progress',
  'data: {"type":"response.in_progress","sequence_number":1,"response":{"id":"r-empty"}}',
  "",
  'event: response.completed',
  'data: {"type":"response.completed","sequence_number":2,"response":{"id":"r-empty","output":[]}}',
  "",
  'event: response.done',
  'data: {"type":"response.done","sequence_number":3,"response":{"id":"r-empty"}}',
  "",
].join("\n");

// The same failure after the upstream proved it was generating. The reasoning
// delta releases the hold, so this attempt is already on the wire by the time
// it turns out to be empty and cannot be retried invisibly.
const REASONING_EMPTY_SSE = [
  'event: response.created',
  'data: {"type":"response.created","sequence_number":0,"response":{"id":"r-empty"}}',
  "",
  'event: response.reasoning_text.delta',
  'data: {"type":"response.reasoning_text.delta","sequence_number":1,"delta":"thinking..."}',
  "",
  'event: response.completed',
  'data: {"type":"response.completed","sequence_number":2,"response":{"id":"r-empty","output":[]}}',
  "",
  'event: response.done',
  'data: {"type":"response.done","sequence_number":3,"response":{"id":"r-empty"}}',
  "",
].join("\n");

const CONTENT_SSE = [
  'event: response.created',
  'data: {"type":"response.created","sequence_number":0,"response":{"id":"r-content"}}',
  "",
  'event: response.output_text.delta',
  'data: {"type":"response.output_text.delta","sequence_number":1,"delta":"Recovered"}',
  "",
  'event: response.output_text.done',
  'data: {"type":"response.output_text.done","sequence_number":2,"text":"Recovered"}',
  "",
  'event: response.completed',
  'data: {"type":"response.completed","sequence_number":3,"response":{"id":"r-content","output":[]}}',
  "",
  'event: response.done',
  'data: {"type":"response.done","sequence_number":4,"response":{"id":"r-content"}}',
  "",
].join("\n");

// Large enough to force the guard past its 1 MiB pre-content hold budget
// before any client-visible output arrives. Deliberately not a reasoning event:
// reasoning releases the hold on liveness long before the byte cap, so a
// reasoning prelude would exercise the wrong release path.
const BUDGET_RELEASE_REASONING_SSE = [
  "event: response.created",
  'data: {"type":"response.created","response":{"id":"r-budget"}}',
  "",
  "event: response.in_progress",
  `data: ${JSON.stringify({
    type: "response.in_progress",
    response: { id: "r-budget", status: "x".repeat(2 * 1024 * 1024) },
  })}`,
  "",
].join("\n");

const BUDGET_RELEASE_EMPTY_SSE = [
  BUDGET_RELEASE_REASONING_SSE,
  "event: response.completed",
  'data: {"type":"response.completed","response":{"id":"r-budget","output":[]}}',
  "",
  "event: response.done",
  'data: {"type":"response.done","response":{"id":"r-budget"}}',
  "",
].join("\n");

const CUSTOM_TOOL_CALL_SSE = [
  "event: response.created",
  'data: {"type":"response.created","sequence_number":0,"response":{"id":"r-custom-tool"}}',
  "",
  "event: response.custom_tool_call_input.delta",
  'data: {"type":"response.custom_tool_call_input.delta","sequence_number":1,"item_id":"ctc_1","delta":"move pointer"}',
  "",
  "event: response.custom_tool_call_input.done",
  'data: {"type":"response.custom_tool_call_input.done","sequence_number":2,"item_id":"ctc_1","input":"move pointer"}',
  "",
  "event: response.completed",
  `data: ${JSON.stringify({
    type: "response.completed",
    sequence_number: 3,
    response: {
      id: "r-custom-tool",
      output: [
        {
          id: "ctc_1",
          type: "custom_tool_call",
          call_id: "call_custom_1",
          name: "computer",
          input: "move pointer",
        },
      ],
    },
  })}`,
  "",
  "event: response.done",
  'data: {"type":"response.done","sequence_number":4,"response":{"id":"r-custom-tool"}}',
  "",
].join("\n");

const REFUSAL_EVENT_SSE = [
  "event: response.created",
  'data: {"type":"response.created","sequence_number":0,"response":{"id":"r-refusal-event"}}',
  "",
  "event: response.refusal.delta",
  'data: {"type":"response.refusal.delta","sequence_number":1,"delta":"I cannot help with that."}',
  "",
  "event: response.refusal.done",
  'data: {"type":"response.refusal.done","sequence_number":2,"refusal":"I cannot help with that."}',
  "",
  "event: response.completed",
  'data: {"type":"response.completed","sequence_number":3,"response":{"id":"r-refusal-event","output":[]}}',
  "",
  "event: response.done",
  'data: {"type":"response.done","sequence_number":4,"response":{"id":"r-refusal-event"}}',
  "",
].join("\n");

const REFUSAL_OUTPUT_SSE = [
  "event: response.created",
  'data: {"type":"response.created","sequence_number":0,"response":{"id":"r-refusal-output"}}',
  "",
  "event: response.completed",
  `data: ${JSON.stringify({
    type: "response.completed",
    sequence_number: 1,
    response: {
      id: "r-refusal-output",
      output: [
        {
          type: "message",
          content: [{ type: "refusal", refusal: "I cannot help with that." }],
        },
      ],
    },
  })}`,
  "",
  "event: response.done",
  'data: {"type":"response.done","sequence_number":2,"response":{"id":"r-refusal-output"}}',
  "",
].join("\n");

const CHAT_REFUSAL_SSE = [
  `data: ${JSON.stringify({
    id: "chat-refusal",
    choices: [{ index: 0, delta: { refusal: "I cannot help with that." } }],
  })}`,
  "",
  "data: [DONE]",
  "",
].join("\n");

const HEADERLESS_PREFIX_TOOL_SSE = Buffer.from(
  [
    "\uFEFF: keepalive\r\n\r\n",
    "\n",
    "event: response.created\n",
    'data: {"type":"response.created","sequence_number":0,"response":{"id":"r-prefix-tool"}}\n\n',
    "event: response.output_item.done\n",
    `data: ${JSON.stringify({
      type: "response.output_item.done",
      sequence_number: 1,
      item: {
        type: "function_call",
        name: "collaboration__spawn_agent",
        call_id: "call_prefix_tool",
        arguments: "{}",
      },
    })}\n\n`,
    "event: response.completed\n",
    `data: ${JSON.stringify({
      type: "response.completed",
      sequence_number: 2,
      response: {
        id: "r-prefix-tool",
        output: [],
        usage: {
          input_tokens: 19,
          output_tokens: 2,
          total_tokens: 21,
          input_tokens_details: { cached_tokens: 7 },
        },
      },
    })}\n\n`,
    "data: [DONE]\n\n",
  ].join(""),
  "utf8",
);

// The same two turns with the provider's own token counts attached, so a test
// can check what a retried turn reports as spend.
const EMPTY_SSE_METERED = [
  'event: response.created',
  'data: {"type":"response.created","response":{"id":"r-empty"}}',
  "",
  "event: response.completed",
  `data: ${JSON.stringify({
    type: "response.completed",
    response: {
      id: "r-empty",
      output: [],
      usage: {
        input_tokens: 100,
        output_tokens: 0,
        total_tokens: 100,
        input_tokens_details: { cached_tokens: 60 },
      },
    },
  })}`,
  "",
  "data: [DONE]",
  "",
].join("\n");

const CONTENT_SSE_METERED = [
  'event: response.created',
  'data: {"type":"response.created","response":{"id":"r-content"}}',
  "",
  'event: response.output_text.delta',
  'data: {"type":"response.output_text.delta","delta":"Recovered"}',
  "",
  "event: response.completed",
  `data: ${JSON.stringify({
    type: "response.completed",
    response: {
      id: "r-content",
      output: [],
      usage: {
        input_tokens: 100,
        output_tokens: 5,
        total_tokens: 105,
        input_tokens_details: { cached_tokens: 80 },
      },
    },
  })}`,
  "",
  "data: [DONE]",
  "",
].join("\n");

async function mockServer(handler) {
  const server = http.createServer(handler);
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return { server, port: server.address().port };
}

function run(env) {
  const stateDir = mkdtempSync(path.join(os.tmpdir(), "empty-completion-router-state-"));
  const child = spawn(process.execPath, [path.join(root, "src", "router.mjs")], {
    cwd: root,
    env: {
      ...process.env,
      MODEL_ROUTER_STATE_DIR: stateDir,
      CODEX_ROUTER_CALLER_KEY: CALLER_KEY,
      CODEX_ROUTER_INTERNAL_KEY: INTERNAL_KEY,
      KIMI_INTERNAL_KEY: INTERNAL_KEY,
      CODEX_ROUTER_SHOW_ALL_MODELS: "1",
      CODEX_ROUTER_QUIET: "1",
      ...env,
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  child.stderr.setEncoding("utf8");
  let errors = "";
  child.stderr.on("data", (chunk) => {
    errors += chunk;
  });
  child.testErrors = () => errors;
  child.stateDir = stateDir;
  return child;
}

function usageEvents(stateDir) {
  const file = path.join(stateDir, "usage-events.jsonl");
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

async function waitForUsageEvents(stateDir, count, child) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const events = usageEvents(stateDir);
    if (events.length >= count) return events;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for ${count} usage events: ${child.testErrors()}`);
}

async function waitForLog(child, pattern) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (pattern.test(child.testErrors())) return child.testErrors();
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for ${pattern}: ${child.testErrors()}`);
}

async function waitFor(url, child) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`Child exited early (${child.exitCode}): ${child.testErrors()}`);
    }
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // Not bound yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for ${url}: ${child.testErrors()}`);
}

async function stopChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  await new Promise((resolve) => child.once("exit", resolve));
}

async function closeServer(server) {
  await new Promise((resolve) => server.close(resolve));
}

function readRouted(port, body) {
  const base = new URL(`${callerBaseUrl(port, CALLER_KEY)}/responses`);
  return new Promise((resolve, reject) => {
    const request = http.request(
      {
        host: "127.0.0.1",
        port,
        path: base.pathname,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer codex-caller-auth",
        },
      },
      (response) => {
        let text = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => {
          text += chunk;
        });
        const done = () =>
          resolve({
            status: response.statusCode,
            headers: response.headers,
            body: text,
            complete: response.complete,
          });
        response.once("end", done);
        response.once("close", done);
        response.once("error", done);
      },
    );
    request.once("error", reject);
    request.end(JSON.stringify(body));
  });
}

function gateway(handler) {
  return mockServer((request, response) => {
    if (request.method === "GET" && request.url === "/health") {
      const payload = Buffer.from(JSON.stringify({ ok: true }), "utf8");
      response.writeHead(200, {
        "Content-Type": "application/json",
        "Content-Length": String(payload.length),
      });
      response.end(payload);
      return;
    }
    handler(request, response);
  });
}

function routerEnv(gatewayPort, routerPort) {
  return {
    CODEX_ROUTER_PORT: String(routerPort),
    CODEX_ROUTER_GATEWAY_BASE_URL: `http://127.0.0.1:${gatewayPort}/v1`,
    CODEX_ROUTER_OAUTH_HEALTH_URL: `http://127.0.0.1:${gatewayPort}/health`,
    CODEX_ROUTER_API_HEALTH_URL: `http://127.0.0.1:${gatewayPort}/health`,
    CODEX_ROUTER_GATEWAY_HEALTH_URL: `http://127.0.0.1:${gatewayPort}/health`,
  };
}

const TURN_BODY = {
  model: "deepseek/deepseek-v4-pro",
  input: "hello",
  stream: true,
};

// An empty completion used to reach the client as a clean 200 the app
// recorded as a successful turn with no content. The router must retry the
// identical request once and only surface the retry's completion.
test("an empty completion is retried once and the retry's content reaches the client", async () => {
  let posts = 0;
  const gw = await gateway((_request, response) => {
    posts += 1;
    response.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "X-Upstream-Attempt": posts === 1 ? "first" : "retry",
    });
    response.write(posts === 1 ? EMPTY_SSE : CONTENT_SSE);
    response.end();
  });
  const routerPort = await openPort();
  const router = run(routerEnv(gw.port, routerPort));

  try {
    await waitFor(`${callerBaseUrl(routerPort, CALLER_KEY)}/models`, router);

    const result = await readRouted(routerPort, TURN_BODY);

    assert.equal(result.status, 200);
    assert.equal(result.complete, true);
    // The retry's content reached the client...
    assert.match(result.body, /Recovered/);
    assert.doesNotMatch(result.body, /r-empty|thinking/);
    assert.match(result.body, /r-content/);
    assert.equal(result.headers["x-upstream-attempt"], "retry");
    // ...and exactly one completed event did: the first attempt's terminal
    // events were suppressed.
    assert.equal((result.body.match(/event: response\.completed/g) || []).length, 1);
    assert.equal((result.body.match(/event: response\.done/g) || []).length, 1);
    // ...and so did exactly one prologue: the retry's duplicate
    // `response.created`, with its new id and restarted sequence numbers, must
    // not appear inside the response the client already opened.
    assert.equal((result.body.match(/event: response\.created/g) || []).length, 1);
    assert.deepEqual(
      [...result.body.matchAll(/"sequence_number":(\d+)/g)].map((match) => Number(match[1])),
      [0, 1, 2, 3, 4],
    );
    assert.equal(posts, 2, "the empty first attempt must be retried");

    const [event] = await waitForUsageEvents(router.stateDir, 1, router);
    assert.equal(event.status, 200);
    assert.equal(event.emptyCompletionRetried, true);
    assert.equal(event.emptyCompletion, undefined);
  } finally {
    await stopChild(router);
    await closeServer(gw.server);
  }
});

// The counterpart to the test above. Once the upstream streams reasoning, the
// hold is over and the attempt is on the wire, so the router cannot substitute
// a retry for it. It states the failure into the open stream instead. Holding
// the prologue for this case is what used to cost every reasoning turn seconds
// of dead air, and the silent rescue it bought landed on roughly one routed
// turn in a thousand.
test("a reasoning turn that ends empty is relayed and stated, never retried", async () => {
  let posts = 0;
  const gw = await gateway((_request, response) => {
    posts += 1;
    response.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "X-Upstream-Attempt": posts === 1 ? "first" : "retry",
    });
    response.end(posts === 1 ? REASONING_EMPTY_SSE : CONTENT_SSE);
  });
  const routerPort = await openPort();
  const router = run(routerEnv(gw.port, routerPort));

  try {
    await waitFor(`${callerBaseUrl(routerPort, CALLER_KEY)}/models`, router);

    const result = await readRouted(routerPort, TURN_BODY);

    assert.equal(result.status, 200);
    // The reasoning the user watched arrive is still theirs...
    assert.match(result.body, /thinking/);
    assert.match(result.body, /r-empty/);
    // ...followed by a stated failure rather than a silent stop.
    assert.match(result.body, /event: error/);
    assert.match(result.body, /empty_completion/);
    // No second attempt: the response had already started.
    assert.equal(posts, 1, "a relayed attempt must not be retried");
    assert.doesNotMatch(result.body, /Recovered|r-content/);
    assert.equal(result.headers["x-upstream-attempt"], "first");

    const [event] = await waitForUsageEvents(router.stateDir, 1, router);
    assert.equal(event.emptyCompletion, true);
    assert.equal(event.emptyCompletionUnrepairable, true);
    assert.equal(event.emptyCompletionRetried, undefined);
  } finally {
    await stopChild(router);
    await closeServer(gw.server);
  }
});

// If the retry is also empty, the client must see a stated error instead of a
// second silent success, and the meter must call it a failure.
test("a double-empty completion surfaces an error and meters 502", async () => {
  let posts = 0;
  const gw = await gateway((_request, response) => {
    posts += 1;
    response.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8" });
    response.write(EMPTY_SSE);
    response.end();
  });
  const routerPort = await openPort();
  const router = run(routerEnv(gw.port, routerPort));

  try {
    await waitFor(`${callerBaseUrl(routerPort, CALLER_KEY)}/models`, router);

    const result = await readRouted(routerPort, TURN_BODY);

    assert.equal(result.status, 502);
    assert.equal(result.complete, true);
    assert.match(result.body, /empty_completion/);
    assert.doesNotMatch(result.body, /event: response\.completed/);
    assert.equal(posts, 2, "the empty first attempt must be retried exactly once");

    const [event] = await waitForUsageEvents(router.stateDir, 1, router);
    assert.equal(event.status, 502);
    assert.equal(event.emptyCompletion, true);
    assert.equal(event.emptyCompletionRetried, true);
    const health = await fetch(`http://127.0.0.1:${routerPort}/health`);
    assert.equal((await health.json()).activity.state, "error");
  } finally {
    await stopChild(router);
    await closeServer(gw.server);
  }
});

// The retry can fail outright. The first attempt is still fully buffered, so
// replace its staged head with one deterministic router error and never relay
// the upstream's internal body.
test("a retry that fails upstream states the failure instead of relaying its body", async () => {
  let posts = 0;
  const gw = await gateway((_request, response) => {
    posts += 1;
    if (posts === 1) {
      response.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8" });
      response.end(EMPTY_SSE);
      return;
    }
    const body = JSON.stringify({ error: { message: "upstream exploded", type: "server_error" } });
    response.writeHead(500, { "Content-Type": "application/json" });
    response.end(body);
  });
  const routerPort = await openPort();
  const router = run(routerEnv(gw.port, routerPort));

  try {
    await waitFor(`${callerBaseUrl(routerPort, CALLER_KEY)}/models`, router);

    const result = await readRouted(routerPort, TURN_BODY);

    assert.equal(result.status, 502);
    assert.equal(result.complete, true);
    assert.match(result.body, /empty_completion_retry_failed/);
    // The upstream's own error body never reaches the stream.
    assert.doesNotMatch(result.body, /upstream exploded/);
    assert.doesNotMatch(result.body, /event: response\.completed/);
    assert.equal(posts, 2);

    const [event] = await waitForUsageEvents(router.stateDir, 1, router);
    assert.equal(event.status, 502);
    assert.equal(event.emptyCompletion, true);
    assert.equal(event.emptyCompletionRetried, true);
  } finally {
    await stopChild(router);
    await closeServer(gw.server);
  }
});

// Both attempts were sent and both were billed. A meter that reports only the
// retry understates a retried turn by an entire prompt.
test("a retried turn meters the tokens of both attempts", async () => {
  let posts = 0;
  const gw = await gateway((_request, response) => {
    posts += 1;
    response.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8" });
    response.end(posts === 1 ? EMPTY_SSE_METERED : CONTENT_SSE_METERED);
  });
  const routerPort = await openPort();
  const router = run(routerEnv(gw.port, routerPort));

  try {
    await waitFor(`${callerBaseUrl(routerPort, CALLER_KEY)}/models`, router);

    const result = await readRouted(routerPort, TURN_BODY);
    assert.equal(result.status, 200);
    assert.match(result.body, /Recovered/);

    const [event] = await waitForUsageEvents(router.stateDir, 1, router);
    assert.equal(event.emptyCompletionRetried, true);
    assert.equal(event.inputTokens, 200, "both prompts were sent, so both are reported");
    assert.equal(event.cachedInputTokens, 140);
    assert.equal(event.outputTokens, 5);
    assert.equal(event.totalTokens, 205);
  } finally {
    await stopChild(router);
    await closeServer(gw.server);
  }
});

test("a retry that crosses the guard byte budget records the release", async () => {
  let posts = 0;
  const gw = await gateway((_request, response) => {
    posts += 1;
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    response.end(posts === 1 ? EMPTY_SSE : BUDGET_RELEASE_EMPTY_SSE);
  });
  const routerPort = await openPort();
  const router = run(routerEnv(gw.port, routerPort));

  try {
    await waitFor(`${callerBaseUrl(routerPort, CALLER_KEY)}/models`, router);
    const result = await readRouted(routerPort, TURN_BODY);

    assert.equal(result.status, 200);
    assert.equal(result.complete, true);
    assert.match(result.body, /r-budget/);
    assert.equal(posts, 2);

    const [event] = await waitForUsageEvents(router.stateDir, 1, router);
    assert.equal(event.status, 200);
    assert.equal(event.emptyCompletionRetried, true);
    assert.equal(event.emptyCompletionGuardReleased, true);
  } finally {
    await stopChild(router);
    await closeServer(gw.server);
  }
});

test("a retry tool call uses the normal namespace response transform", async () => {
  let posts = 0;
  const toolCall = [
    "event: response.created",
    'data: {"type":"response.created","sequence_number":0,"response":{"id":"r-tool"}}',
    "",
    "event: response.output_item.added",
    'data: {"type":"response.output_item.added","sequence_number":1,"item":{"type":"function_call","name":"collaboration__spawn_agent","call_id":"call_1"}}',
    "",
    "event: response.output_item.done",
    'data: {"type":"response.output_item.done","sequence_number":2,"item":{"type":"function_call","name":"collaboration__spawn_agent","call_id":"call_1","arguments":"{}"}}',
    "",
    "event: response.completed",
    'data: {"type":"response.completed","sequence_number":3,"response":{"id":"r-tool","output":[]}}',
    "",
    "event: response.done",
    'data: {"type":"response.done","sequence_number":4,"response":{"id":"r-tool"}}',
    "",
  ].join("\n");
  const gw = await gateway((_request, response) => {
    posts += 1;
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    response.end(posts === 1 ? EMPTY_SSE : toolCall);
  });
  const routerPort = await openPort();
  const router = run(routerEnv(gw.port, routerPort));

  try {
    await waitFor(`${callerBaseUrl(routerPort, CALLER_KEY)}/models`, router);
    const result = await readRouted(routerPort, {
      ...TURN_BODY,
      tools: [
        {
          type: "namespace",
          name: "collaboration",
          tools: [{ type: "function", name: "spawn_agent" }],
        },
      ],
    });

    assert.equal(result.status, 200);
    assert.match(result.body, /"name":"spawn_agent"/);
    assert.match(result.body, /"namespace":"collaboration"/);
    assert.doesNotMatch(result.body, /collaboration__spawn_agent|r-empty|thinking/);
    assert.equal(posts, 2);
  } finally {
    await stopChild(router);
    await closeServer(gw.server);
  }
});

test("multiline SSE content on the retry is not misclassified as empty", async () => {
  let posts = 0;
  const multiline = [
    "event: response.created",
    'data: {"type":"response.created","sequence_number":0,"response":{"id":"r-multiline"}}',
    "",
    "event: response.output_text.delta",
    'data: {"type":"response.output_text.delta","sequence_number":1,',
    'data: "delta":"Multiline recovered"}',
    "",
    "event: response.completed",
    'data: {"type":"response.completed","sequence_number":2,"response":{"id":"r-multiline","output":[]}}',
    "",
    "data: [DONE]",
    "",
  ].join("\n");
  const gw = await gateway((_request, response) => {
    posts += 1;
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    response.end(posts === 1 ? EMPTY_SSE : multiline);
  });
  const routerPort = await openPort();
  const router = run(routerEnv(gw.port, routerPort));

  try {
    await waitFor(`${callerBaseUrl(routerPort, CALLER_KEY)}/models`, router);
    const result = await readRouted(routerPort, TURN_BODY);
    assert.equal(result.status, 200);
    assert.match(result.body, /Multiline recovered/);
    assert.doesNotMatch(result.body, /r-empty|thinking/);
    assert.equal(posts, 2);
  } finally {
    await stopChild(router);
    await closeServer(gw.server);
  }
});

for (const retryKind of ["json", "bodyless"]) {
  test(`a successful ${retryKind} retry becomes a deterministic protocol error`, async () => {
    let posts = 0;
    const gw = await gateway((_request, response) => {
      posts += 1;
      if (posts === 1) {
        response.writeHead(200, {
          "Content-Type": "text/event-stream",
          "X-Upstream-Attempt": "first",
        });
        response.end(EMPTY_SSE);
        return;
      }
      if (retryKind === "bodyless") {
        response.writeHead(204, { "X-Upstream-Attempt": "retry" });
        response.end();
        return;
      }
      response.writeHead(200, {
        "Content-Type": "application/json",
        "X-Upstream-Attempt": "retry",
      });
      response.end(JSON.stringify({ secret: "must not enter the client response" }));
    });
    const routerPort = await openPort();
    const router = run(routerEnv(gw.port, routerPort));

    try {
      await waitFor(`${callerBaseUrl(routerPort, CALLER_KEY)}/models`, router);
      const result = await readRouted(routerPort, TURN_BODY);
      assert.equal(result.status, 502);
      assert.match(result.body, /empty_completion_retry_protocol_error/);
      assert.doesNotMatch(result.body, /must not enter|r-empty|thinking/);
      assert.equal(result.headers["content-type"], "application/json");
      assert.equal(result.headers["x-upstream-attempt"], undefined);
      assert.equal(posts, 2);
    } finally {
      await stopChild(router);
      await closeServer(gw.server);
    }
  });
}

test("an incompatible JSON retry still contributes its reported usage", async () => {
  let posts = 0;
  const gw = await gateway((_request, response) => {
    posts += 1;
    if (posts === 1) {
      response.writeHead(200, { "Content-Type": "text/event-stream" });
      response.end(EMPTY_SSE_METERED);
      return;
    }
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(
      JSON.stringify({
        id: "incompatible-json-retry",
        output: [],
        usage: {
          input_tokens: 100,
          output_tokens: 3,
          total_tokens: 103,
          input_tokens_details: { cached_tokens: 80 },
        },
      }),
    );
  });
  const routerPort = await openPort();
  const router = run(routerEnv(gw.port, routerPort));

  try {
    await waitFor(`${callerBaseUrl(routerPort, CALLER_KEY)}/models`, router);
    const result = await readRouted(routerPort, TURN_BODY);
    assert.equal(result.status, 502);
    assert.match(result.body, /empty_completion_retry_protocol_error/);

    const [event] = await waitForUsageEvents(router.stateDir, 1, router);
    assert.equal(event.inputTokens, 200);
    assert.equal(event.outputTokens, 3);
    assert.equal(event.totalTokens, 203);
    assert.equal(event.cachedInputTokens, 140);
    assert.equal(event.emptyCompletionRetried, true);
  } finally {
    await stopChild(router);
    await closeServer(gw.server);
  }
});

test("a transport-failed retry keeps first-attempt usage, cache, and markers", async () => {
  let posts = 0;
  const gw = await gateway((_request, response) => {
    posts += 1;
    if (posts === 1) {
      response.writeHead(200, { "Content-Type": "text/event-stream" });
      response.end(EMPTY_SSE_METERED);
      return;
    }
    response.socket.destroy();
  });
  const routerPort = await openPort();
  const router = run(routerEnv(gw.port, routerPort));

  try {
    await waitFor(`${callerBaseUrl(routerPort, CALLER_KEY)}/models`, router);
    const result = await readRouted(routerPort, TURN_BODY);
    assert.equal(result.status, 502);
    assert.match(result.body, /empty_completion_retry_failed/);
    assert.doesNotMatch(result.body, /r-empty|thinking/);

    const [event] = await waitForUsageEvents(router.stateDir, 1, router);
    assert.equal(event.status, 502);
    assert.equal(event.inputTokens, 100);
    assert.equal(event.outputTokens, 0);
    assert.equal(event.totalTokens, 100);
    assert.equal(event.cachedInputTokens, 60);
    assert.equal(event.emptyCompletion, true);
    assert.equal(event.emptyCompletionRetried, true);
    assert.match(
      await waitForLog(router, /timing .*status=502 .*cached_tokens=60/),
      /timing .*status=502 .*cached_tokens=60/,
    );
  } finally {
    await stopChild(router);
    await closeServer(gw.server);
  }
});

for (const [name, body, expected] of [
  ["custom tool input", CUSTOM_TOOL_CALL_SSE, /move pointer/],
  ["refusal events", REFUSAL_EVENT_SSE, /response\.refusal\.delta/],
  ["completed refusal output", REFUSAL_OUTPUT_SSE, /I cannot help with that/],
  ["chat-completions refusal", CHAT_REFUSAL_SSE, /I cannot help with that/],
]) {
  test(`valid ${name} is content and is never retried`, async () => {
    let posts = 0;
    const gw = await gateway((_request, response) => {
      posts += 1;
      response.writeHead(200, { "Content-Type": "text/event-stream" });
      response.end(body);
    });
    const routerPort = await openPort();
    const router = run(routerEnv(gw.port, routerPort));

    try {
      await waitFor(`${callerBaseUrl(routerPort, CALLER_KEY)}/models`, router);
      const result = await readRouted(routerPort, TURN_BODY);
      assert.equal(result.status, 200);
      assert.match(result.body, expected);
      assert.equal(posts, 1, "valid Responses output must not trigger an empty retry");

      const [event] = await waitForUsageEvents(router.stateDir, 1, router);
      assert.equal(event.status, 200);
      assert.equal(event.emptyCompletion, undefined);
      assert.equal(event.emptyCompletionRetried, undefined);
    } finally {
      await stopChild(router);
      await closeServer(gw.server);
    }
  });
}

test("a headerless first attempt preserves guard, usage, and namespace transforms", async () => {
  let posts = 0;
  const gw = await gateway((_request, response) => {
    posts += 1;
    response.writeHead(200);
    let offset = 0;
    const sizes = [1, 1, 1, 2, 3, 5, 1, 4, 7, 2, 11];
    const writeNext = () => {
      if (offset >= HEADERLESS_PREFIX_TOOL_SSE.length) {
        response.end();
        return;
      }
      const size = sizes.shift() || HEADERLESS_PREFIX_TOOL_SSE.length;
      const next = Math.min(HEADERLESS_PREFIX_TOOL_SSE.length, offset + size);
      response.write(HEADERLESS_PREFIX_TOOL_SSE.subarray(offset, next));
      offset = next;
      setImmediate(writeNext);
    };
    writeNext();
  });
  const routerPort = await openPort();
  const router = run(routerEnv(gw.port, routerPort));

  try {
    await waitFor(`${callerBaseUrl(routerPort, CALLER_KEY)}/models`, router);
    const result = await readRouted(routerPort, {
      ...TURN_BODY,
      tools: [
        {
          type: "namespace",
          name: "collaboration",
          tools: [{ type: "function", name: "spawn_agent" }],
        },
      ],
    });
    assert.equal(result.status, 200);
    assert.match(result.body, /"name":"spawn_agent"/);
    assert.match(result.body, /"namespace":"collaboration"/);
    assert.doesNotMatch(result.body, /collaboration__spawn_agent/);
    assert.equal(posts, 1);

    const [event] = await waitForUsageEvents(router.stateDir, 1, router);
    assert.equal(event.inputTokens, 19);
    assert.equal(event.outputTokens, 2);
    assert.equal(event.totalTokens, 21);
    assert.equal(event.cachedInputTokens, 7);
    assert.equal(event.emptyCompletionRetried, undefined);
  } finally {
    await stopChild(router);
    await closeServer(gw.server);
  }
});

test("a client cancel during the retry meters and logs status zero", async () => {
  let posts = 0;
  const gw = await gateway((_request, response) => {
    posts += 1;
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    if (posts === 1) {
      response.end(EMPTY_SSE);
      return;
    }
    response.write(
      [
        "event: response.created",
        'data: {"type":"response.created","sequence_number":0,"response":{"id":"r-retry-cancel"}}',
        "",
        "event: response.output_text.delta",
        'data: {"type":"response.output_text.delta","sequence_number":1,"delta":"started"}',
        "",
        "",
      ].join("\n"),
    );
  });
  const routerPort = await openPort();
  const router = run(routerEnv(gw.port, routerPort));

  try {
    await waitFor(`${callerBaseUrl(routerPort, CALLER_KEY)}/models`, router);
    await new Promise((resolve) => {
      const base = new URL(`${callerBaseUrl(routerPort, CALLER_KEY)}/responses`);
      const request = http.request(
        {
          host: "127.0.0.1",
          port: routerPort,
          path: base.pathname,
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: "Bearer codex-caller-auth",
          },
        },
        (response) => {
          response.once("data", () => {
            request.destroy();
            resolve();
          });
        },
      );
      request.once("error", resolve);
      request.end(JSON.stringify(TURN_BODY));
    });

    const [event] = await waitForUsageEvents(router.stateDir, 1, router);
    assert.equal(posts, 2);
    assert.equal(event.status, 0);
    assert.equal(event.emptyCompletion, undefined);
    assert.equal(event.emptyCompletionRetried, true);
    assert.match(await waitForLog(router, /timing .*status=0 /), /timing .*status=0 /);
    const health = await fetch(`http://127.0.0.1:${routerPort}/health`).then((r) => r.json());
    assert.equal(health.activity.state, "idle");
  } finally {
    await stopChild(router);
    await closeServer(gw.server);
  }
});

test("a client cancel while an incompatible retry body stalls is not a protocol error", async () => {
  let posts = 0;
  let retryBodyStartedResolve;
  const retryBodyStarted = new Promise((resolve) => {
    retryBodyStartedResolve = resolve;
  });
  const gw = await gateway((_request, response) => {
    posts += 1;
    if (posts === 1) {
      response.writeHead(200, { "Content-Type": "text/event-stream" });
      response.end(EMPTY_SSE);
      return;
    }
    response.writeHead(200, { "Content-Type": "application/json" });
    response.write('{"id":"stalled-retry","usage":');
    retryBodyStartedResolve();
  });
  const routerPort = await openPort();
  const router = run(routerEnv(gw.port, routerPort));

  try {
    await waitFor(`${callerBaseUrl(routerPort, CALLER_KEY)}/models`, router);
    let responseStarted = false;
    const base = new URL(`${callerBaseUrl(routerPort, CALLER_KEY)}/responses`);
    const request = http.request(
      {
        host: "127.0.0.1",
        port: routerPort,
        path: base.pathname,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer codex-caller-auth",
        },
      },
      () => {
        responseStarted = true;
      },
    );
    request.on("error", () => {});
    request.end(JSON.stringify(TURN_BODY));

    await retryBodyStarted;
    request.destroy();

    const [event] = await waitForUsageEvents(router.stateDir, 1, router);
    assert.equal(posts, 2);
    assert.equal(responseStarted, false, "the staged response head must remain hidden");
    assert.equal(event.status, 0);
    assert.equal(event.emptyCompletion, undefined);
    assert.equal(event.emptyCompletionRetried, true);
    assert.match(await waitForLog(router, /timing .*status=0 /), /timing .*status=0 /);
    const health = await fetch(`http://127.0.0.1:${routerPort}/health`).then((r) => r.json());
    assert.equal(health.activity.state, "idle");
  } finally {
    await stopChild(router);
    await closeServer(gw.server);
  }
});

test("a headerless SSE retry is relayed through the normal pipeline", async () => {
  let posts = 0;
  const gw = await gateway((_request, response) => {
    posts += 1;
    if (posts === 1) {
      response.writeHead(200, { "Content-Type": "text/event-stream" });
      response.end(EMPTY_SSE);
      return;
    }
    response.writeHead(200, { "X-Upstream-Attempt": "retry" });
    response.write(CONTENT_SSE.slice(0, 3));
    setImmediate(() => response.end(CONTENT_SSE.slice(3)));
  });
  const routerPort = await openPort();
  const router = run(routerEnv(gw.port, routerPort));

  try {
    await waitFor(`${callerBaseUrl(routerPort, CALLER_KEY)}/models`, router);
    const result = await readRouted(routerPort, TURN_BODY);
    assert.equal(result.status, 200);
    assert.match(result.body, /Recovered/);
    assert.equal(result.headers["content-type"], undefined);
    assert.equal(result.headers["x-upstream-attempt"], "retry");
    assert.equal(posts, 2);
  } finally {
    await stopChild(router);
    await closeServer(gw.server);
  }
});

test("a headerless non-SSE retry is still a deterministic protocol error", async () => {
  let posts = 0;
  const gw = await gateway((_request, response) => {
    posts += 1;
    if (posts === 1) {
      response.writeHead(200, { "Content-Type": "text/event-stream" });
      response.end(EMPTY_SSE);
      return;
    }
    response.writeHead(200);
    response.end(JSON.stringify({ secret: "headerless json must not be relayed" }));
  });
  const routerPort = await openPort();
  const router = run(routerEnv(gw.port, routerPort));

  try {
    await waitFor(`${callerBaseUrl(routerPort, CALLER_KEY)}/models`, router);
    const result = await readRouted(routerPort, TURN_BODY);
    assert.equal(result.status, 502);
    assert.match(result.body, /empty_completion_retry_protocol_error/);
    assert.doesNotMatch(result.body, /headerless json must not be relayed/);
    assert.equal(posts, 2);
  } finally {
    await stopChild(router);
    await closeServer(gw.server);
  }
});

// The retry re-sends the whole prompt. An operator who would rather pay once
// can turn the guard off, and the router must then behave exactly as it did
// before it existed: one attempt, terminal events relayed, no markers.
test("the guard can be turned off and the turn relays exactly as before", async () => {
  let posts = 0;
  const gw = await gateway((_request, response) => {
    posts += 1;
    response.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8" });
    response.end(EMPTY_SSE);
  });
  const routerPort = await openPort();
  const router = run({
    ...routerEnv(gw.port, routerPort),
    CODEX_ROUTER_EMPTY_COMPLETION_RETRY: "0",
  });

  try {
    await waitFor(`${callerBaseUrl(routerPort, CALLER_KEY)}/models`, router);

    const result = await readRouted(routerPort, TURN_BODY);

    assert.equal(result.status, 200);
    assert.match(result.body, /event: response\.completed/);
    assert.match(result.body, /event: response\.done/);
    assert.doesNotMatch(result.body, /event: error/);
    assert.equal(posts, 1, "the guard is off, so nothing is retried");

    const [event] = await waitForUsageEvents(router.stateDir, 1, router);
    assert.equal(event.status, 200);
    assert.equal(event.emptyCompletion, undefined);
    assert.equal(event.emptyCompletionRetried, undefined);
  } finally {
    await stopChild(router);
    await closeServer(gw.server);
  }
});

// A normal turn must be untouched: one upstream attempt, no retry, no markers.
test("a content turn is not retried and carries no empty-completion markers", async () => {
  let posts = 0;
  const gw = await gateway((_request, response) => {
    posts += 1;
    response.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8" });
    response.write(CONTENT_SSE);
    response.end();
  });
  const routerPort = await openPort();
  const router = run(routerEnv(gw.port, routerPort));

  try {
    await waitFor(`${callerBaseUrl(routerPort, CALLER_KEY)}/models`, router);

    const result = await readRouted(routerPort, TURN_BODY);

    assert.equal(result.status, 200);
    assert.equal(result.complete, true);
    assert.match(result.body, /Recovered/);
    assert.equal(posts, 1, "a content turn must not be retried");

    const [event] = await waitForUsageEvents(router.stateDir, 1, router);
    assert.equal(event.status, 200);
    assert.equal(event.emptyCompletion, undefined);
    assert.equal(event.emptyCompletionRetried, undefined);
  } finally {
    await stopChild(router);
    await closeServer(gw.server);
  }
});
