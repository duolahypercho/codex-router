import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const testRoot = mkdtempSync(path.join(os.tmpdir(), "provider-cooldown-"));
process.env.CODEX_HOME = path.join(testRoot, "codex");
process.env.CODEX_ROUTER_STATE_DIR = path.join(testRoot, "state");

const { cooldownScope } = await import("../src/provider-cooldown.mjs");

test.after(() => rmSync(testRoot, { recursive: true, force: true }));

test("subscription variants share a breaker while separately billed Zen does not", () => {
  assert.equal(cooldownScope("opencode-go"), "opencode-go");
  assert.equal(cooldownScope("opencode-go-messages"), "opencode-go");
  assert.equal(cooldownScope("opencode-go-responses"), "opencode-go");
  assert.equal(cooldownScope("opencode-zen"), "opencode-zen");
  assert.equal(cooldownScope("opencode-zen-messages"), "opencode-zen");
  assert.equal(cooldownScope("opencode-zen-responses"), "opencode-zen");
});
