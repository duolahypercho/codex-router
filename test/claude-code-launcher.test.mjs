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

test("agent and background model names follow the session model onto served ids", () => {
  const AGENT_VARIABLES = [
    "CLAUDE_CODE_SUBAGENT_MODEL",
    "ANTHROPIC_SMALL_FAST_MODEL",
    "ANTHROPIC_DEFAULT_OPUS_MODEL",
    "ANTHROPIC_DEFAULT_SONNET_MODEL",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL",
  ];
  const catalog = { defaultModel: "codex_router/anthropic/openai/gpt-test" };

  // Nothing selected: every name lands on the catalog default, which is what
  // keeps a built-in agent's `opus` tier request off the unserved literal id.
  const fallback = claudeRouterEnvironment({
    environment: {}, secret: SECRET, args: [], catalog, settings: {},
  });
  for (const name of AGENT_VARIABLES) assert.equal(fallback[name], catalog.defaultModel);

  const explicit = claudeRouterEnvironment({
    environment: {}, secret: SECRET,
    args: ["--model", "codex_router/anthropic/deepseek/test"], catalog, settings: {},
  });
  for (const name of AGENT_VARIABLES) {
    assert.equal(explicit[name], "codex_router/anthropic/deepseek/test");
  }

  const inline = claudeRouterEnvironment({
    environment: {}, secret: SECRET,
    args: ["--model=codex_router/anthropic/deepseek/test"], catalog, settings: {},
  });
  assert.equal(inline.ANTHROPIC_DEFAULT_OPUS_MODEL, "codex_router/anthropic/deepseek/test");

  const saved = claudeRouterEnvironment({
    environment: {}, secret: SECRET, args: [], catalog,
    settings: { model: "codex_router/anthropic/deepseek/test" },
  });
  for (const name of AGENT_VARIABLES) {
    assert.equal(saved[name], "codex_router/anthropic/deepseek/test");
  }

  // A model this launcher cannot recognise as routed is not worth pinning
  // agents to; the served catalog default still is.
  const unrouted = claudeRouterEnvironment({
    environment: {}, secret: SECRET, args: ["--model", "claude-opus-5"], catalog, settings: {},
  });
  assert.equal(unrouted.ANTHROPIC_MODEL, undefined);
  for (const name of AGENT_VARIABLES) assert.equal(unrouted[name], catalog.defaultModel);
});

test("an inherited agent model is kept only while it names a served id", () => {
  const env = claudeRouterEnvironment({
    environment: {
      CLAUDE_CODE_SUBAGENT_MODEL: "codex_router/anthropic/deepseek/test",
      ANTHROPIC_DEFAULT_OPUS_MODEL: "claude-opus-5",
    },
    secret: SECRET, args: [],
    catalog: { defaultModel: "codex_router/anthropic/openai/gpt-test" },
    settings: {},
  });
  assert.equal(env.CLAUDE_CODE_SUBAGENT_MODEL, "codex_router/anthropic/deepseek/test");
  assert.equal(env.ANTHROPIC_DEFAULT_OPUS_MODEL, "codex_router/anthropic/openai/gpt-test");
});

test("an absent catalog default leaves the agent model names untouched", () => {
  const env = claudeRouterEnvironment({
    environment: { ANTHROPIC_DEFAULT_OPUS_MODEL: "claude-opus-5" },
    secret: SECRET, args: [], catalog: {}, settings: {},
  });
  assert.equal(env.ANTHROPIC_MODEL, undefined);
  assert.equal(env.CLAUDE_CODE_SUBAGENT_MODEL, undefined);
  assert.equal(env.ANTHROPIC_DEFAULT_OPUS_MODEL, "claude-opus-5");
});
