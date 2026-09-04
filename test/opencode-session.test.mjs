import assert from "node:assert/strict";
import test from "node:test";

import {
  OPENCODE_SESSION_FALLBACKS,
  OPENCODE_SESSION_HEADER,
  applyOpenCodeSessionHeaders,
  isOpenCodeProvider,
  openCodeSessionHeaders,
  resolveOpenCodeSessionId,
} from "../src/opencode-session.mjs";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

test("isOpenCodeProvider prefers ownedBy and accepts known ids", () => {
  assert.equal(isOpenCodeProvider({ ownedBy: "opencode", id: "anything" }), true);
  assert.equal(isOpenCodeProvider({ id: "opencode-go" }), true);
  assert.equal(isOpenCodeProvider({ id: "opencode-go-messages" }), true);
  assert.equal(isOpenCodeProvider({ id: "opencode-go-responses" }), true);
  assert.equal(isOpenCodeProvider({ id: "opencode-zen" }), true);
  assert.equal(isOpenCodeProvider({ id: "opencode-free" }), true);
  assert.equal(isOpenCodeProvider({ id: "opencode-free-responses" }), true);
  assert.equal(isOpenCodeProvider({ ownedBy: "openrouter", id: "openrouter" }), false);
  assert.equal(isOpenCodeProvider({ id: "deepseek" }), false);
  assert.equal(isOpenCodeProvider(null), false);
});

test("same conversation body yields the same session id", () => {
  const body = {
    messages: [
      { role: "system", content: "You are Codex." },
      { role: "user", content: "run the thing" },
    ],
  };
  const first = resolveOpenCodeSessionId({ body });
  const second = resolveOpenCodeSessionId({
    body: {
      messages: [
        ...body.messages,
        { role: "assistant", content: "ok" },
        { role: "user", content: "and again" },
      ],
    },
  });
  assert.equal(first, second);
  assert.match(first, UUID_RE);
});

test("different conversation bodies yield different session ids", () => {
  const left = resolveOpenCodeSessionId({
    body: {
      messages: [
        { role: "system", content: "You are Codex." },
        { role: "user", content: "one" },
      ],
    },
  });
  const right = resolveOpenCodeSessionId({
    body: {
      messages: [
        { role: "system", content: "You are Codex." },
        { role: "user", content: "two" },
      ],
    },
  });
  assert.notEqual(left, right);
});

test("Responses input and Anthropic messages use the same anchor rules", () => {
  const responses = resolveOpenCodeSessionId({
    body: {
      input: [
        { role: "user", content: [{ type: "input_text", text: "hello" }] },
        { type: "message", role: "assistant", content: "hi" },
      ],
    },
  });
  const anthropic = resolveOpenCodeSessionId({
    body: {
      messages: [
        { role: "user", content: [{ type: "text", text: "hello" }] },
        { role: "assistant", content: "hi" },
      ],
    },
  });
  assert.match(responses, UUID_RE);
  assert.match(anthropic, UUID_RE);
  assert.notEqual(responses, anthropic);
});

test("thread-id header wins over body anchor", () => {
  const threadId = "11111111-2222-3333-4444-555555555555";
  const fromHeader = resolveOpenCodeSessionId({
    headers: { "thread-id": threadId },
    body: {
      messages: [
        { role: "system", content: "You are Codex." },
        { role: "user", content: "run the thing" },
      ],
    },
  });
  assert.equal(fromHeader, threadId);
});

test("stable fallbacks cover discovery and usage", () => {
  assert.equal(
    resolveOpenCodeSessionId({ fallback: OPENCODE_SESSION_FALLBACKS.discovery }),
    "codex-router-discovery",
  );
  assert.equal(
    resolveOpenCodeSessionId({ fallback: OPENCODE_SESSION_FALLBACKS.usage }),
    "codex-router-usage",
  );
});

test("empty chat body falls back to a one-shot UUID", () => {
  const id = resolveOpenCodeSessionId({ body: { messages: [] } });
  assert.match(id, UUID_RE);
});

test("applyOpenCodeSessionHeaders attaches only for OpenCode providers", () => {
  const body = Buffer.from(
    JSON.stringify({
      messages: [
        { role: "system", content: "You are Codex." },
        { role: "user", content: "run the thing" },
      ],
    }),
    "utf8",
  );
  const openHeaders = { "User-Agent": "codex-router/test" };
  assert.equal(
    applyOpenCodeSessionHeaders(openHeaders, {
      provider: { id: "opencode-go", ownedBy: "opencode" },
      body,
    }),
    true,
  );
  assert.match(openHeaders[OPENCODE_SESSION_HEADER], UUID_RE);

  const otherHeaders = { "User-Agent": "codex-router/test" };
  assert.equal(
    applyOpenCodeSessionHeaders(otherHeaders, {
      provider: { id: "deepseek", ownedBy: "deepseek" },
      body,
    }),
    false,
  );
  assert.equal(OPENCODE_SESSION_HEADER in otherHeaders, false);
});

test("openCodeSessionHeaders returns the wire header shape", () => {
  const headers = openCodeSessionHeaders({
    fallback: OPENCODE_SESSION_FALLBACKS.discovery,
  });
  assert.deepEqual(headers, {
    [OPENCODE_SESSION_HEADER]: "codex-router-discovery",
  });
});
