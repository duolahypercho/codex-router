import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

const stateDir = mkdtempSync(path.join(os.tmpdir(), "model-picker-state-test-"));
process.env.CODEX_ROUTER_STATE_DIR = stateDir;

const {
  MODEL_PICKER_STATE_PATH,
  migrateModelVisibility,
  modelPickerSnapshot,
  readHiddenModels,
  setAllModelsVisible,
  setModelVisible,
  setModelsVisible,
} = await import("../src/model-picker-state.mjs");

test("picker visibility defaults to no hidden models", () => {
  assert.deepEqual([...readHiddenModels()], []);
  assert.deepEqual(modelPickerSnapshot().hidden, []);
});

test("picker visibility round-trips through protected state", () => {
  setModelVisible("opencode-go/deepseek-v4-flash", false);
  assert.deepEqual([...readHiddenModels()], ["opencode-go/deepseek-v4-flash"]);
  assert.deepEqual(modelPickerSnapshot().hidden, ["opencode-go/deepseek-v4-flash"]);

  setModelVisible("opencode-go/deepseek-v4-flash", true);
  assert.deepEqual([...readHiddenModels()], []);
  assert.deepEqual(modelPickerSnapshot().visible, ["opencode-go/deepseek-v4-flash"]);
  const persisted = JSON.parse(readFileSync(MODEL_PICKER_STATE_PATH, "utf8"));
  assert.deepEqual(persisted.visible, ["opencode-go/deepseek-v4-flash"]);
  assert.ok(MODEL_PICKER_STATE_PATH.startsWith(stateDir));
});

test("picker bulk visibility hides and shows every supplied model", () => {
  const slugs = ["opencode-go/deepseek-v4-flash", "kimi-oauth/k3", "gpt-5.6-sol"];
  setAllModelsVisible(slugs, false);
  assert.deepEqual([...readHiddenModels()].sort(), [...slugs].sort());
  setAllModelsVisible(slugs, true);
  assert.deepEqual([...readHiddenModels()], []);
  assert.deepEqual(modelPickerSnapshot().visible.sort(), slugs.sort());
});

test("provider-sized picker changes preserve other providers", () => {
  setModelsVisible(["commandcode/kimi-k3", "commandcode-messages/claude-opus-4.8"], false);
  setModelVisible("kimi-oauth/k3", false);
  assert.deepEqual(modelPickerSnapshot().hidden, [
    "commandcode-messages/claude-opus-4.8",
    "commandcode/kimi-k3",
    "kimi-oauth/k3",
  ]);

  setModelsVisible(["commandcode/kimi-k3", "commandcode-messages/claude-opus-4.8"], true);
  assert.deepEqual(modelPickerSnapshot().hidden, ["kimi-oauth/k3"]);
  assert.ok(modelPickerSnapshot().visible.includes("commandcode/kimi-k3"));
  assert.ok(modelPickerSnapshot().visible.includes("commandcode-messages/claude-opus-4.8"));
});

test("a protocol migration carries the existing picker decision to the new slug", () => {
  const oldSlug = "opencode-free/muse-spark-1.2-contributor-free";
  const newSlug = "opencode-free-responses/muse-spark-1.2-contributor-free";
  setModelVisible(oldSlug, true);
  migrateModelVisibility([{ from: oldSlug, to: newSlug }]);
  const migrated = modelPickerSnapshot();
  assert.equal(migrated.visible.includes(oldSlug), false);
  assert.equal(migrated.visible.includes(newSlug), true);
});

test("legacy hidden-only state becomes an allowlist when a picker decision is made", () => {
  writeFileSync(
    MODEL_PICKER_STATE_PATH,
    `${JSON.stringify({
      version: 1,
      hidden: ["deepseek/deepseek-v4-pro"],
      seeded: ["deepseek/deepseek-v4-flash", "deepseek/deepseek-v4-pro"],
    })}\n`,
    { mode: 0o600 },
  );
  const legacy = modelPickerSnapshot();
  assert.equal(legacy.hasExplicitVisibility, false);
  assert.deepEqual(legacy.visible, ["deepseek/deepseek-v4-flash"]);

  setModelVisible("deepseek/deepseek-v4-flash", true);
  const current = modelPickerSnapshot();
  assert.equal(current.hasExplicitVisibility, true);
  assert.deepEqual(current.visible, ["deepseek/deepseek-v4-flash"]);
});
