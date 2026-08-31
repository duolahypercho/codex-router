import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import test from "node:test";

import { ClaudeAgentBridge } from "../src/claude-agent-bridge.mjs";

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
