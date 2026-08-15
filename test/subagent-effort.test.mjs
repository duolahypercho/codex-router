import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

function scratchState() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "subagent-effort-"));
  process.env.MODEL_ROUTER_STATE_DIR = dir;
  return dir;
}

async function freshState(tag) {
  return import(`../src/multi-agent-state.mjs?effort=${tag}`);
}

test("an unset model reports no effort, so its own default stands", async () => {
  const dir = scratchState();
  try {
    const state = await freshState("unset");
    assert.equal(state.subagentEffort("opencode-go/glm-5.2"), undefined);
    assert.deepEqual(state.subagentEfforts(), {});
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an effort survives a round trip and is cleared by an empty value", async () => {
  const dir = scratchState();
  try {
    const state = await freshState("roundtrip");
    state.setSubagentEffort("opencode-go/glm-5.2", "max");
    assert.equal(state.subagentEffort("opencode-go/glm-5.2"), "max");
    state.setSubagentEffort("opencode-go/glm-5.2", undefined);
    assert.equal(state.subagentEffort("opencode-go/glm-5.2"), undefined);
    assert.deepEqual(state.subagentEfforts(), {}, "clearing removes the key, not just its value");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Every writer rebuilds the settings object, so each one is a chance to drop
// the effort map silently. A user who sets an effort and then toggles any
// unrelated subagent switch must not lose it.
test("efforts survive mode changes and model toggles", async () => {
  const dir = scratchState();
  try {
    const state = await freshState("survive");
    state.setSubagentEffort("opencode-go/glm-5.2", "high");

    state.setMultiAgentMode("all");
    assert.equal(state.subagentEffort("opencode-go/glm-5.2"), "high", "mode change dropped it");

    state.setMultiAgentModel("opencode-go/kimi-k3", true);
    assert.equal(state.subagentEffort("opencode-go/glm-5.2"), "high", "model toggle dropped it");

    state.setMultiAgentModels(["opencode-go/kimi-k3"], false);
    assert.equal(state.subagentEffort("opencode-go/glm-5.2"), "high", "bulk toggle dropped it");

    state.replaceMultiAgentState({ mode: "selected", enabled: ["a"], disabled: [] });
    assert.equal(state.subagentEffort("opencode-go/glm-5.2"), "high", "state replace dropped it");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("efforts are per model, so one model's depth never leaks to another", async () => {
  const dir = scratchState();
  try {
    const state = await freshState("permodel");
    state.setSubagentEffort("opencode-go/glm-5.2", "max");
    state.setSubagentEffort("opencode-go/kimi-k3", "low");
    assert.deepEqual(state.subagentEfforts(), {
      "opencode-go/glm-5.2": "max",
      "opencode-go/kimi-k3": "low",
    });
    assert.equal(state.subagentEffort("opencode-go/deepseek-v4-pro"), undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a malformed effort map is ignored rather than propagated into a request", async () => {
  const dir = scratchState();
  try {
    const { writePrivateJson } = await import("../src/file-security.mjs");
    const state = await freshState("malformed");
    writePrivateJson(state.MULTI_AGENT_STATE_PATH, {
      version: 2,
      mode: "selected",
      enabled: [],
      disabled: [],
      efforts: { "a/b": 7, "": "high", "c/d": "max" },
    });
    assert.deepEqual(state.subagentEfforts(), { "c/d": "max" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a slug is required, so a blank write cannot silently do nothing", async () => {
  const dir = scratchState();
  try {
    const state = await freshState("blank");
    assert.throws(() => state.setSubagentEffort("", "high"), /slug is required/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
