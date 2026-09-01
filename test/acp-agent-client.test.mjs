import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import test from "node:test";

import { AcpAgentClient } from "../src/acp-agent-client.mjs";

function fakeAcpAgent(handler) {
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.exitCode = null;
  child.signalCode = null;
  child.kill = () => {
    child.signalCode = "SIGTERM";
    child.emit("exit", null, "SIGTERM");
  };
  let buffer = "";
  child.stdin.on("data", (chunk) => {
    buffer += chunk.toString("utf8");
    let boundary = buffer.indexOf("\n");
    while (boundary !== -1) {
      const line = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 1);
      if (line) handler(JSON.parse(line), child);
      boundary = buffer.indexOf("\n");
    }
  });
  return child;
}

function send(child, message) {
  child.stdout.write(`${JSON.stringify(message)}\n`);
}

test("ACP initializes, creates a session, streams text, and rejects permissions by default", async () => {
  const received = [];
  const child = fakeAcpAgent((message, process) => {
    received.push(message);
    if (message.method === "initialize") {
      send(process, { jsonrpc: "2.0", id: message.id, result: { protocolVersion: 1 } });
    } else if (message.method === "session/new") {
      send(process, { jsonrpc: "2.0", id: message.id, result: { sessionId: "session-1" } });
    } else if (message.method === "session/prompt") {
      send(process, {
        jsonrpc: "2.0",
        id: 900,
        method: "session/request_permission",
        params: { sessionId: "session-1", options: [{ optionId: "allow-once" }, { optionId: "reject-once" }] },
      });
      send(process, {
        jsonrpc: "2.0",
        method: "session/update",
        params: { sessionId: "session-1", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "hello" } } },
      });
      send(process, { jsonrpc: "2.0", id: message.id, result: { stopReason: "end_turn" } });
    }
  });
  const client = new AcpAgentClient({ binary: "/fake/agent", spawnImpl: () => child });
  const session = await client.newSession({ cwd: "/workspace" });
  const result = await client.prompt(session.sessionId, "Hi");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(result.text, "hello");
  assert.equal(result.stopReason, "end_turn");
  assert.deepEqual(received.find((message) => message.id === 900)?.result, {
    outcome: { outcome: "selected", optionId: "reject-once" },
  });
  assert.deepEqual(received[0].params.clientCapabilities, {
    fs: { readTextFile: false, writeTextFile: false },
    terminal: false,
  });
  await client.close();
});

test("ACP cancellation is a notification and a stopped child rejects pending work", async () => {
  const received = [];
  const child = fakeAcpAgent((message, process) => {
    received.push(message);
    if (message.method === "initialize") {
      send(process, { jsonrpc: "2.0", id: message.id, result: { protocolVersion: 1 } });
    }
  });
  const client = new AcpAgentClient({ binary: "/fake/agent", spawnImpl: () => child });
  await client.start();
  await client.cancel("session-2");
  assert.deepEqual(received.at(-1), {
    jsonrpc: "2.0",
    method: "session/cancel",
    params: { sessionId: "session-2" },
  });
  const pending = client.request("session/load", { sessionId: "session-2" });
  child.emit("exit", 1, null);
  await assert.rejects(pending, /exit code 1/);
  await client.close();
});
