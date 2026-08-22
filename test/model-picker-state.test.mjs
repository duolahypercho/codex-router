import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

const stateDir = mkdtempSync(path.join(os.tmpdir(), "model-picker-state-test-"));
process.env.CODEX_ROUTER_STATE_DIR = stateDir;

const {
  MODEL_PICKER_STATE_PATH,
  modelPickerSnapshot,
  readHiddenModels,
  setAllModelsVisible,
  setModelVisible,
  setModelSelection,
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

test("an explicit model selection changes only the supplied provider models", () => {
  writeFileSync(
    MODEL_PICKER_STATE_PATH,
    `${JSON.stringify({
      version: 1,
      hidden: ["deepseek/deepseek-v4-pro", "kimi-oauth/k3"],
      visible: ["deepseek/deepseek-v4-flash"],
      seeded: [
        "deepseek/deepseek-v4-flash",
        "deepseek/deepseek-v4-pro",
        "kimi-oauth/k3",
      ],
    })}\n`,
    { mode: 0o600 },
  );

  setModelSelection(
    ["deepseek/deepseek-v4-flash", "deepseek/deepseek-v4-pro"],
    ["deepseek/deepseek-v4-pro"],
  );

  const picker = modelPickerSnapshot();
  assert.deepEqual(picker.hidden, ["deepseek/deepseek-v4-flash", "kimi-oauth/k3"]);
  assert.deepEqual(picker.visible, ["deepseek/deepseek-v4-pro"]);
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
