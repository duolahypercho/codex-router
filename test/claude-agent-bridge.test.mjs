import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import test from "node:test";

import { CLAUDE_REASONING_EFFORTS, ClaudeAgentBridge, validateClaudePromptControls } from "../src/claude-agent-bridge.mjs";

function fakeClaude(onSpawn) {
  return (command, args, options) => {
    const child = new EventEmitter();
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.exitCode = null;
    child.signalCode = null;
    child.kill = () => {};
    onSpawn({ command, args, options, child });
    return child;
  };
}

test("Claude bridge keeps prompts off argv and returns the official stream result", async () => {
  let invocation;
  const bridge = new ClaudeAgentBridge({
    binary: "/fake/claude",
    spawnImpl: fakeClaude((value) => {
      invocation = value;
      let input = "";
      value.child.stdin.on("data", (chunk) => { input += chunk.toString("utf8"); });
      value.child.stdin.on("end", () => {
        assert.equal(input, "private prompt");
        value.child.stdout.write(`${JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "partial" }] } })}\n`);
        value.child.stdout.write(`${JSON.stringify({ type: "result", subtype: "success", session_id: "11111111-1111-4111-8111-111111111111", result: "complete" })}\n`);
        value.child.emit("exit", 0, null);
      });
    }),
  });
  const result = await bridge.prompt("11111111-1111-4111-8111-111111111111", "private prompt", { cwd: "/tmp" });
  assert.equal(result.text, "complete");
  assert.equal(invocation.args.includes("private prompt"), false);
  assert.deepEqual(invocation.args.slice(0, 9), [
    "-p", "--input-format", "text", "--output-format", "stream-json", "--verbose", "--permission-mode", "dontAsk", "--tools",
  ]);
  assert.equal(invocation.args.includes(""), true);
});

test("Claude bridge resume uses the supplied session and reports a failed client cleanly", async () => {
  const bridge = new ClaudeAgentBridge({
    binary: "/fake/claude",
    spawnImpl: fakeClaude(({ args, child }) => {
      assert.deepEqual(args.slice(-2), ["--resume", "session-existing"]);
      queueMicrotask(() => child.emit("exit", 1, null));
    }),
  });
  await assert.rejects(
    bridge.prompt("session-existing", "continue", { cwd: "/tmp", resume: true }),
    /claude auth status/,
  );
});

test("Claude bridge preserves an official entitlement rejection without exposing stream noise", async () => {
  const bridge = new ClaudeAgentBridge({
    binary: "/fake/claude",
    spawnImpl: fakeClaude(({ child }) => {
      child.stdin.on("end", () => {
        child.stdout.write(`${JSON.stringify({
          type: "result",
          subtype: "success",
          is_error: true,
          api_error_status: 403,
          result: "Failed to authenticate. API Error: 403 Request not allowed",
        })}\n`);
        child.emit("exit", 1, null);
      });
      child.stdin.resume();
    }),
  });
  await assert.rejects(
    bridge.prompt("session-denied", "hello", { cwd: "/tmp" }),
    (error) => error.code === "claude_agent_rejected" && error.status === 403 && /Request not allowed/.test(error.message),
  );
});

test("Claude bridge sends optional model and effort on fresh and resumed prompts", async () => {
  const invocations = [];
  const bridge = new ClaudeAgentBridge({
    binary: "/fake/claude",
    spawnImpl: fakeClaude(({ args, child }) => {
      invocations.push(args);
      child.stdin.on("end", () => {
        child.stdout.write(`${JSON.stringify({ type: "result", subtype: "success", result: "ok" })}\n`);
        child.emit("exit", 0, null);
      });
      child.stdin.resume();
    }),
  });
  await bridge.prompt("same-session", "first", { model: "claude-sonnet-4-5", effort: "low" });
  await bridge.prompt("same-session", "second", { resume: true, model: "claude-sonnet-4-5", effort: "high" });
  assert.deepEqual(invocations[0].slice(-6), ["--session-id", "same-session", "--model", "claude-sonnet-4-5", "--effort", "low"]);
  assert.deepEqual(invocations[1].slice(-6), ["--resume", "same-session", "--model", "claude-sonnet-4-5", "--effort", "high"]);
  assert.equal(invocations.every((args) => !args.includes("first") && !args.includes("second")), true);
});

test("Claude bridge omits optional flags by default and rejects invalid controls before spawning", async () => {
  let spawns = 0;
  const bridge = new ClaudeAgentBridge({
    binary: "/fake/claude",
    spawnImpl: fakeClaude(({ args, child }) => {
      spawns += 1;
      assert.equal(args.includes("--model"), false);
      assert.equal(args.includes("--effort"), false);
      child.stdin.on("end", () => {
        child.stdout.write(`${JSON.stringify({ type: "result", subtype: "success", result: "ok" })}\n`);
        child.emit("exit", 0, null);
      });
      child.stdin.resume();
    }),
  });
  for (const model of ["", "--help", "claude sonnet", "claude\nsonnet", null, 123]) {
    await assert.rejects(bridge.prompt("s", "prompt", { model }), /model/i);
  }
  for (const effort of ["", "ultracode", "HIGH", "maximum", null]) {
    await assert.rejects(bridge.prompt("s", "prompt", { effort }), /effort/i);
  }
  assert.equal(spawns, 0);
  await bridge.prompt("s", "prompt");
  assert.equal(spawns, 1);
});

test("Claude controls allow documented effort levels and model punctuation", () => {
  assert.deepEqual(CLAUDE_REASONING_EFFORTS, ["low", "medium", "high", "xhigh", "max"]);
  assert.equal(Object.isFrozen(CLAUDE_REASONING_EFFORTS), true);
  for (const effort of CLAUDE_REASONING_EFFORTS) {
    assert.doesNotThrow(() => validateClaudePromptControls({ model: "provider/model:version", effort }));
  }
  assert.throws(() => validateClaudePromptControls({ model: "model\u0085name" }), /model/i);
});

test("Claude bridge rejects an overlapping prompt even when its effort differs", async () => {
  let child;
  const bridge = new ClaudeAgentBridge({
    binary: "/fake/claude",
    spawnImpl: fakeClaude((invocation) => { child = invocation.child; }),
  });
  const first = bridge.prompt("same-session", "first", { effort: "low" });
  await assert.rejects(bridge.prompt("same-session", "second", { effort: "high" }), /active prompt/);
  child.stdout.write(`${JSON.stringify({ type: "result", subtype: "success", result: "ok" })}\n`);
  child.emit("exit", 0, null);
  await first;
});
