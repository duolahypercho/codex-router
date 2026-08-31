import assert from "node:assert/strict";
import test from "node:test";

import { claudeRouterEnvironment } from "../src/claude-code-launcher.mjs";

const SECRET = "test-claude-router-capability-with-sufficient-length";

test("the Claude launcher is local, discovery-enabled, and leaves the caller environment immutable", () => {
  const original = {
    KEEP_ME: "yes",
    CLAUDE_CODE_USE_VERTEX: "1",
  };
  const env = claudeRouterEnvironment({
    environment: original,
    secret: SECRET,
    args: [],
    catalog: { defaultModel: "codex_router/anthropic/openai/gpt-test" },
    settings: {},
  });
  assert.equal(env.KEEP_ME, "yes");
  assert.equal(env.ANTHROPIC_AUTH_TOKEN, SECRET);
  assert.match(env.ANTHROPIC_BASE_URL, /^http:\/\/127\.0\.0\.1:\d+\/_codex-router\//);
  assert.equal(env.CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY, "1");
  assert.equal(env.CLAUDE_CODE_DISABLE_UNKNOWN_MODEL_WINDOW_ENFORCEMENT, "1");
  assert.equal(env.ANTHROPIC_MODEL, "codex_router/anthropic/openai/gpt-test");
  assert.equal(env.CLAUDE_CODE_USE_VERTEX, undefined);
  assert.equal(original.CLAUDE_CODE_USE_VERTEX, "1");
});

test("an explicit or already-saved router model wins over the launcher default", () => {
  const explicit = claudeRouterEnvironment({
    environment: {}, secret: SECRET, args: ["--model", "codex_router/anthropic/deepseek/test"],
    catalog: { defaultModel: "codex_router/anthropic/openai/gpt-test" }, settings: {},
  });
  assert.equal(explicit.ANTHROPIC_MODEL, undefined);

  const saved = claudeRouterEnvironment({
    environment: {}, secret: SECRET, args: [],
    catalog: { defaultModel: "codex_router/anthropic/openai/gpt-test" },
    settings: { model: "codex_router/anthropic/deepseek/test" },
  });
  assert.equal(saved.ANTHROPIC_MODEL, undefined);
});
