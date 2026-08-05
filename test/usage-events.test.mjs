import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("usage events persist only bounded request metadata in a private file", async () => {
  const stateDir = mkdtempSync(path.join(os.tmpdir(), "model-router-usage-"));
  const previousStateDir = process.env.MODEL_ROUTER_STATE_DIR;
  process.env.MODEL_ROUTER_STATE_DIR = stateDir;
  try {
    const usage = await import(`../src/usage-events.mjs?test=${Date.now()}`);
    usage.recordUsageEvent({
      model: "grok-oauth/grok-4.5",
      provider: "grok-oauth",
      status: 200,
      durationMs: 321,
      inputTokens: 120,
      outputTokens: 35,
      totalTokens: 155,
      prompt: "never persisted",
    });
    assert.deepEqual(usage.recentUsageEvents(), [
      {
        meteringVersion: 1,
        at: usage.recentUsageEvents()[0].at,
        model: "grok-oauth/grok-4.5",
        provider: "grok-oauth",
        status: 200,
        durationMs: 321,
        inputTokens: 120,
        outputTokens: 35,
        totalTokens: 155,
      },
    ]);
    if (process.platform !== "win32") {
      assert.equal(statSync(usage.USAGE_EVENTS_PATH).mode & 0o777, 0o600);
    }
  } finally {
    if (previousStateDir === undefined) delete process.env.MODEL_ROUTER_STATE_DIR;
    else process.env.MODEL_ROUTER_STATE_DIR = previousStateDir;
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("reading usage events folds protocol variants into their canonical provider", async () => {
  const stateDir = mkdtempSync(path.join(os.tmpdir(), "model-router-usage-"));
  const previousStateDir = process.env.MODEL_ROUTER_STATE_DIR;
  process.env.MODEL_ROUTER_STATE_DIR = stateDir;
  try {
    const usage = await import(`../src/usage-events.mjs?variant=${Date.now()}`);
    // Historical events recorded before canonicalization carry the variant id.
    usage.recordUsageEvent({
      model: "opencode-go-messages/minimax-m3",
      provider: "opencode-go-messages",
      status: 200,
      durationMs: 50,
    });
    assert.equal(usage.recentUsageEvents()[0].provider, "opencode-go");
  } finally {
    if (previousStateDir === undefined) delete process.env.MODEL_ROUTER_STATE_DIR;
    else process.env.MODEL_ROUTER_STATE_DIR = previousStateDir;
    rmSync(stateDir, { recursive: true, force: true });
  }
});
