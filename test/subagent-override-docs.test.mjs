import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// An explicit `spawn_agent.model` is kept, not rewritten to the routed parent.
// The behavior changed, the prose describing it did not: the bundled
// `codex-router` skill and the comment above `SPAWN_MODEL_TOOLS` both still
// told the reader that an in-session subagent is pinned to the parent. That is
// the version an operator or a delegated agent reads while diagnosing a child
// that ran on the wrong model, so the stale claim reads as the router
// discarding the override on purpose.
//
// A source assertion is the cheap guard here. Nothing else fails when prose
// drifts away from the code, and the sentence had already survived one
// behavior change.
const STALE_PINNING = /always pinned|pinned to the routed parent/i;

function read(relative) {
  return readFileSync(path.join(root, relative), "utf8");
}

test("no shipped skill claims an in-session subagent is pinned to the parent", () => {
  const shipped = [
    "skills/codex-router/SKILL.md",
    ".claude/skills/codex-subagents/SKILL.md",
  ];
  for (const file of shipped) {
    assert.doesNotMatch(read(file), STALE_PINNING, file);
  }
  assert.match(
    read("skills/codex-router/SKILL.md"),
    /keeps an explicit `spawn_agent\.model`/,
    "the skill states the inheritance rule the router actually implements",
  );
});

test("the spawn-model comment describes keeping an explicit model", () => {
  const source = read("src/namespace-relay.mjs");
  const start = source.indexOf("// A fresh local thread inherits");
  assert.notEqual(start, -1, "the spawn-model comment is present");
  const comment = source.slice(start, start + 1200);
  assert.doesNotMatch(comment, STALE_PINNING);
  assert.match(comment, /keeps an explicit model/);
});
