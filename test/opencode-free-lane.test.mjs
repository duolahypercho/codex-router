import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

const stateDir = mkdtempSync(path.join(os.tmpdir(), "opencode-free-lane-"));
process.env.MODEL_ROUTER_STATE_DIR = stateDir;
process.env.CODEX_ROUTER_STATE_DIR = stateDir;

const lane = await import("../src/opencode-free-lane.mjs");

test("minted free-lane sessions match the descending gate shape", () => {
  for (let i = 0; i < 20; i += 1) {
    const id = lane.mintOpenCodeFreeSessionId();
    assert.equal(lane.isCanonicalOpenCodeFreeSession(id), true, id);
  }
});

test("conversation seeds stick to one minted session", () => {
  const first = lane.openCodeFreeSessionForConversation("thread-abc");
  const second = lane.openCodeFreeSessionForConversation("thread-abc");
  const other = lane.openCodeFreeSessionForConversation("thread-xyz");
  assert.equal(first, second);
  assert.notEqual(first, other);
  assert.equal(lane.isCanonicalOpenCodeFreeSession(first), true);
});

test("fingerprint injects official read/shell tools and an env block", () => {
  const body = {
    model: "big-pickle",
    messages: [{ role: "user", content: "hi" }],
    tools: [
      {
        type: "function",
        function: {
          name: "Read",
          description: "caller read",
          parameters: { type: "object", properties: { path: { type: "string" } } },
        },
      },
    ],
  };
  const map = lane.applyOpenCodeFreeFingerprint(body, false);
  assert.equal(map.size, 0);
  const names = body.tools.map((tool) => tool.function?.name || tool.name);
  assert.deepEqual(names.slice(-2), ["read", "shell"]);
  assert.equal(names.includes("Read"), true);
  assert.match(body.messages[0].content, /<env>/);
  assert.match(body.messages[0].content, /placeholders that do nothing/);
  assert.equal(body.tool_choice, undefined);
});

test("fingerprint renames a colliding lowercase read and clears tool_choice none", () => {
  const body = {
    messages: [{ role: "user", content: "hi" }],
    tool_choice: "none",
    tools: [
      {
        type: "function",
        function: {
          name: "read",
          description: "not the official one",
          parameters: { type: "object", properties: { path: { type: "string" } } },
        },
      },
    ],
  };
  const map = lane.applyOpenCodeFreeFingerprint(body, false);
  assert.equal(map.get("read_client"), "read");
  const names = body.tools.map((tool) => tool.function?.name || tool.name);
  assert.equal(names.includes("read_client"), true);
  assert.equal(names.includes("read"), true);
  assert.equal(names.includes("shell"), true);
  assert.equal(body.tool_choice, undefined);
});

test("free-lane headers carry the public CLI fingerprint and never a request id", () => {
  const headers = {};
  assert.equal(
    lane.applyOpenCodeFreeLaneHeaders(headers, {
      provider: { id: "free-opencode" },
      requestHeaders: { "x-codex-thread-id": "t-1" },
      body: { stream: true },
    }),
    true,
  );
  assert.equal(headers.Authorization, "Bearer public");
  assert.equal(headers["User-Agent"], lane.OPENCODE_FREE_CLIENT_UA);
  assert.equal(headers["x-opencode-client"], "cli");
  assert.equal(headers["x-opencode-session"], headers["x-opencode-session-id"]);
  assert.equal(headers["x-session-affinity"], headers["x-opencode-session"]);
  assert.equal(headers["x-opencode-project"], "global");
  assert.equal(headers["x-opencode-request"], undefined);
  assert.equal(lane.isOpenCodeFreeLaneProvider({ id: "opencode-zen" }), false);
});

test.after(() => {
  rmSync(stateDir, { recursive: true, force: true });
});
