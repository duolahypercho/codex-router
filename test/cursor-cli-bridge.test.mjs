import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

// Bound before the imports below: the bridge resolves its workspace from
// STATE_DIR at construction, and these tests must never write into the real
// state directory.
const stateDir = mkdtempSync(path.join(os.tmpdir(), "cursor-bridge-test-"));
process.env.MODEL_ROUTER_STATE_DIR = stateDir;

const {
  assistantDelta,
  buildCursorPrompt,
  createEventReader,
  resultError,
  usageFromResult,
} = await import("../src/cursor-cli-turn.mjs");
const { parseCursorModels, validCursorModelId } = await import("../src/cursor-cli.mjs");
const { createCursorBridge, turnArguments } = await import("../src/cursor-cli-bridge.mjs");

// A stand-in for `cursor-agent -p --output-format stream-json`. It emits the
// exact event shapes read out of cursor-agent 2026.08.11-e8db854's own bundle,
// so a change to the translation that would break against the real binary
// breaks here too.
function fakeAgent(directory, { deltas, result, usage, exitCode = 0, splitLines = false }) {
  const binary = path.join(directory, "cursor-agent");
  const events = [
    { type: "system", subtype: "init", model: "gpt-5", session_id: "s1", permissionMode: "default" },
    ...deltas.map((text) => ({
      type: "assistant",
      message: { role: "assistant", content: [{ type: "text", text }] },
      session_id: "s1",
      timestamp_ms: 1,
    })),
    {
      type: "result",
      subtype: exitCode === 0 ? "success" : "error",
      is_error: exitCode !== 0,
      duration_ms: 5,
      duration_api_ms: 4,
      result,
      session_id: "s1",
      request_id: "r1",
      ...(usage ? { usage } : {}),
    },
  ];
  const lines = events.map((event) => JSON.stringify(event));
  // `splitLines` writes the NDJSON in fragments that do not align to newlines,
  // which is what a real pipe does and what a naive line reader gets wrong.
  const body = splitLines
    ? `const blob = ${JSON.stringify(lines.join("\n") + "\n")};
for (let i = 0; i < blob.length; i += 7) process.stdout.write(blob.slice(i, i + 7));`
    : `process.stdout.write(${JSON.stringify(lines.join("\n") + "\n")});`;
  writeFileSync(
    binary,
    `#!/usr/bin/env node
process.stdin.resume();
process.stdin.on("data", () => {});
process.stdin.on("end", () => {
  ${body}
  process.exit(${exitCode});
});
`,
    { mode: 0o755 },
  );
  chmodSync(binary, 0o755);
  return binary;
}

async function withBridge(environment, run) {
  const server = createCursorBridge({ environment });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    return await run(base);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test("a system prompt and one user turn are sent without transcript scaffolding", () => {
  const prompt = buildCursorPrompt([
    { role: "system", content: "You are terse." },
    { role: "user", content: "What is 2+2?" },
  ]);
  assert.equal(prompt, "You are terse.\n\nWhat is 2+2?");
  assert.doesNotMatch(prompt, /^User:/m);
});

test("a multi-turn conversation is rendered as a transcript with a reply instruction", () => {
  const prompt = buildCursorPrompt([
    { role: "system", content: "Be brief." },
    { role: "user", content: "Hi" },
    { role: "assistant", content: "Hello" },
    { role: "user", content: "And now?" },
  ]);
  assert.match(prompt, /Be brief\./);
  assert.match(prompt, /User: Hi/);
  assert.match(prompt, /Assistant: Hello/);
  assert.match(prompt, /Reply to the final message/);
});

test("array content parts are joined and an image part is named rather than dropped", () => {
  const prompt = buildCursorPrompt([
    {
      role: "user",
      content: [
        { type: "text", text: "Describe" },
        { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
      ],
    },
  ]);
  assert.match(prompt, /Describe/);
  assert.match(prompt, /image omitted/);
  assert.doesNotMatch(prompt, /base64/);
});

test("assistant tool calls survive into the transcript", () => {
  const prompt = buildCursorPrompt([
    { role: "user", content: "Read it" },
    { role: "assistant", content: "", tool_calls: [{ function: { name: "shell", arguments: '{"cmd":"ls"}' } }] },
    { role: "tool", content: "a.txt" },
    { role: "user", content: "Summarize" },
  ]);
  assert.match(prompt, /Assistant called shell with \{"cmd":"ls"\}/);
  assert.match(prompt, /Tool result: a\.txt/);
});

test("the event reader reassembles objects split across chunk boundaries", () => {
  const reader = createEventReader();
  const line = JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "hello world" }] } });
  const collected = [];
  for (let i = 0; i < line.length; i += 5) collected.push(...reader.push(line.slice(i, i + 5)));
  assert.equal(collected.length, 0, "nothing is emitted before the newline arrives");
  collected.push(...reader.push("\n"));
  assert.equal(collected.length, 1);
  assert.equal(assistantDelta(collected[0]), "hello world");
});

test("a non-JSON line on stdout is skipped instead of failing the turn", () => {
  const reader = createEventReader();
  const events = reader.push('warning: something\n{"type":"result","result":"ok"}\n');
  assert.equal(events.length, 1);
  assert.equal(events[0].type, "result");
});

test("usage maps cache counts into prompt tokens, and reports nothing when the CLI does", () => {
  const mapped = usageFromResult({
    type: "result",
    usage: { input_tokens: 10, output_tokens: 5, cache_read_tokens: 3, cache_write_tokens: 2 },
  });
  assert.deepEqual(mapped, {
    prompt_tokens: 15,
    completion_tokens: 5,
    total_tokens: 20,
    prompt_tokens_details: { cached_tokens: 3 },
  });
  assert.equal(usageFromResult({ type: "result" }), undefined);
  assert.equal(
    usageFromResult({ type: "result", usage: { input_tokens: 0, output_tokens: 0 } }),
    undefined,
    "an all-zero block is missing data, not a free turn",
  );
});

test("is_error is honoured even when the result text looks like a normal answer", () => {
  assert.equal(
    resultError({ type: "result", is_error: true, result: "You have run out of requests." }),
    "You have run out of requests.",
  );
  assert.equal(resultError({ type: "result", is_error: false, result: "fine" }), undefined);
});

test("model ids accept Cursor's parameterized syntax and reject anything else", () => {
  assert.equal(validCursorModelId("gpt-5"), "gpt-5");
  assert.equal(
    validCursorModelId("claude-opus-4-8[context=1m,effort=high,fast=false]"),
    "claude-opus-4-8[context=1m,effort=high,fast=false]",
  );
  assert.equal(validCursorModelId("gpt-5; rm -rf /"), undefined);
  assert.equal(validCursorModelId("--force"), undefined);
  assert.equal(validCursorModelId(""), undefined);
});

test("`cursor-agent models` output parses to bare ids, markers and colour stripped", () => {
  const ids = parseCursorModels(
    [
      "[2mAvailable models[0m",
      "",
      "[32mgpt-5[0m [2m- GPT-5[0m [2m(current, default)[0m",
      "[36msonnet-4-thinking[0m [2m- Claude Sonnet 4 (Thinking)[0m",
      "",
      "[2mTip: use --model <id> to switch.[0m",
    ].join("\n"),
  );
  assert.deepEqual(ids, ["gpt-5", "sonnet-4-thinking"]);
});

test("a turn is always read-only: ask mode, sandbox on, and never --force", () => {
  const args = turnArguments("gpt-5", { stream: true });
  assert.deepEqual(args, [
    "--print",
    "--output-format",
    "stream-json",
    "--stream-partial-output",
    "--mode",
    "ask",
    "--sandbox",
    "enabled",
    "--model",
    "gpt-5",
  ]);
  for (const forbidden of ["--force", "--yolo", "--trust", "--auto-review"]) {
    assert.ok(!args.includes(forbidden), `${forbidden} must never be passed`);
  }
});

test("a non-streaming completion returns the result text and usage", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "cursor-agent-stub-"));
  const binary = fakeAgent(directory, {
    deltas: ["Four"],
    result: "Four",
    usage: { input_tokens: 12, output_tokens: 1 },
  });
  await withBridge({ ...process.env, CURSOR_AGENT: binary }, async (base) => {
    const response = await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "gpt-5", messages: [{ role: "user", content: "2+2?" }] }),
    });
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.equal(payload.object, "chat.completion");
    assert.equal(payload.choices[0].message.content, "Four");
    assert.equal(payload.choices[0].finish_reason, "stop");
    assert.equal(payload.usage.completion_tokens, 1);
  });
});

test("a streaming completion emits deltas, a stop chunk, and [DONE]", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "cursor-agent-stub-"));
  const binary = fakeAgent(directory, {
    deltas: ["Hel", "lo ", "world"],
    result: "Hello world",
    splitLines: true,
  });
  await withBridge({ ...process.env, CURSOR_AGENT: binary }, async (base) => {
    const response = await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "gpt-5", messages: [{ role: "user", content: "hi" }], stream: true }),
    });
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") || "", /text\/event-stream/);
    const body = await response.text();
    const frames = body
      .split("\n\n")
      .map((frame) => frame.replace(/^data: /, "").trim())
      .filter(Boolean);
    assert.equal(frames.at(-1), "[DONE]");
    const chunks = frames.slice(0, -1).map((frame) => JSON.parse(frame));
    const text = chunks.map((chunk) => chunk.choices?.[0]?.delta?.content || "").join("");
    assert.equal(text, "Hello world");
    assert.equal(chunks.at(-1).choices[0].finish_reason, "stop");
  });
});

test("a failed run reports the error inside the stream rather than ending it cleanly", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "cursor-agent-stub-"));
  const binary = fakeAgent(directory, {
    deltas: [],
    result: "You have hit your usage limit.",
    exitCode: 1,
  });
  await withBridge({ ...process.env, CURSOR_AGENT: binary }, async (base) => {
    const response = await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "gpt-5", messages: [{ role: "user", content: "hi" }], stream: true }),
    });
    const body = await response.text();
    assert.match(body, /usage limit/);
    assert.match(body, /"type":"server_error"/);
    assert.match(body, /\[DONE\]/);
    assert.doesNotMatch(body, /"finish_reason":"stop"/);
  });
});

test("a non-streaming failure is a 502 with an OpenAI-shaped error body", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "cursor-agent-stub-"));
  const binary = fakeAgent(directory, { deltas: [], result: "model not available", exitCode: 1 });
  await withBridge({ ...process.env, CURSOR_AGENT: binary }, async (base) => {
    const response = await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "gpt-5", messages: [{ role: "user", content: "hi" }] }),
    });
    assert.equal(response.status, 502);
    const payload = await response.json();
    assert.match(payload.error.message, /model not available/);
  });
});

test("an unusable model id is refused before anything is spawned", async () => {
  await withBridge({ ...process.env, CURSOR_AGENT: "/nonexistent/cursor-agent" }, async (base) => {
    const response = await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "gpt-5 --force", messages: [{ role: "user", content: "hi" }] }),
    });
    assert.equal(response.status, 400);
    assert.match((await response.json()).error.message, /Unknown or unusable model/);
  });
});

test("the bridge answers /health without touching cursor-agent", async () => {
  await withBridge({ ...process.env, CURSOR_AGENT: "/nonexistent/cursor-agent" }, async (base) => {
    const response = await fetch(`${base}/health`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true, bridge: "cursor-cli" });
  });
});
