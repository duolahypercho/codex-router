import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

const stateDir = mkdtempSync(path.join(os.tmpdir(), "model-picker-state-test-"));
process.env.CODEX_ROUTER_STATE_DIR = stateDir;

const {
  MODEL_PICKER_STATE_PATH,
  effectiveVisibleModels,
  migrateLegacyVisibleModels,
  modelPickerSnapshot,
  readHiddenModels,
  seedModelsHidden,
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

// The exact shape a pre-allowlist build left behind: `hidden` and `seeded`
// only, no `visible` key, and nothing recorded about the routed models that
// were showing in the picker the whole time.
const ROUTED_SLUGS = [
  "opencode-go/gpt-5.6-sol",
  "opencode-go/claude-opus-4.8",
  "opencode-go/kimi-k3",
];

function writeLegacyState(state) {
  writeFileSync(MODEL_PICKER_STATE_PATH, `${JSON.stringify(state)}\n`, { mode: 0o600 });
}

test("an update keeps the models a pre-allowlist install was already showing", () => {
  writeLegacyState({
    version: 1,
    hidden: ["gpt-5.6-sol-1m", "opencode-go/kimi-k3"],
    seeded: ["gpt-5.6-sol-1m", "opencode-go/kimi-k3"],
  });

  migrateLegacyVisibleModels(ROUTED_SLUGS);
  seedModelsHidden(["gpt-5.6-sol-1m", ...ROUTED_SLUGS]);

  const picker = modelPickerSnapshot();
  assert.equal(picker.hasExplicitVisibility, true);
  assert.deepEqual(picker.visible, [
    "opencode-go/claude-opus-4.8",
    "opencode-go/gpt-5.6-sol",
  ]);
  // A deliberate hide is a decision, and the extended-window variant has never
  // shipped switched on. Neither is the migration's to reverse.
  assert.deepEqual(picker.hidden, ["gpt-5.6-sol-1m", "opencode-go/kimi-k3"]);
});

test("the legacy picker migration runs once and then leaves the file alone", () => {
  writeLegacyState({ version: 1, hidden: [], seeded: ["gpt-5.6-sol-1m"] });
  migrateLegacyVisibleModels(ROUTED_SLUGS);
  const migrated = readFileSync(MODEL_PICKER_STATE_PATH, "utf8");
  // Everything the old `!hidden` rule was showing, written down once: the
  // routed models it never recorded, and the variant it had recorded.
  assert.deepEqual(
    JSON.parse(migrated).visible,
    ["gpt-5.6-sol-1m", ...ROUTED_SLUGS].sort(),
  );

  // A second rebuild has no legacy answer left to read, so it must not rewrite
  // a protected file to say the same thing.
  migrateLegacyVisibleModels([...ROUTED_SLUGS, "opencode-go/newly-curated"]);
  assert.equal(readFileSync(MODEL_PICKER_STATE_PATH, "utf8"), migrated);
});

test("a fresh install has no picker history to migrate and stays opt-in", () => {
  rmSync(MODEL_PICKER_STATE_PATH, { force: true });
  migrateLegacyVisibleModels(ROUTED_SLUGS);
  assert.equal(existsSync(MODEL_PICKER_STATE_PATH), false);

  seedModelsHidden(ROUTED_SLUGS);
  const picker = modelPickerSnapshot();
  assert.deepEqual(picker.visible, []);
  assert.deepEqual(picker.hidden, [...ROUTED_SLUGS].sort());
});

test("effective picker visibility reads both state formats and neither one", () => {
  rmSync(MODEL_PICKER_STATE_PATH, { force: true });
  assert.deepEqual([...effectiveVisibleModels(ROUTED_SLUGS)], []);

  writeLegacyState({ version: 1, hidden: ["opencode-go/kimi-k3"], seeded: [] });
  assert.deepEqual([...effectiveVisibleModels(ROUTED_SLUGS)].sort(), [
    "opencode-go/claude-opus-4.8",
    "opencode-go/gpt-5.6-sol",
  ]);

  writeLegacyState({
    version: 1,
    hidden: [],
    visible: ["opencode-go/kimi-k3"],
    seeded: ROUTED_SLUGS,
  });
  assert.deepEqual([...effectiveVisibleModels(ROUTED_SLUGS)], ["opencode-go/kimi-k3"]);
});

test("an explicit model selection does not turn a legacy file into an allowlist", () => {
  writeLegacyState({
    version: 1,
    hidden: ["deepseek/deepseek-v4-pro"],
    seeded: ["deepseek/deepseek-v4-pro"],
  });

  setModelSelection(
    ["deepseek/deepseek-v4-flash", "deepseek/deepseek-v4-pro"],
    ["deepseek/deepseek-v4-flash"],
  );

  // Recording an allowlist here would answer for every provider this call
  // never looked at, and every one of them would answer "off".
  const persisted = JSON.parse(readFileSync(MODEL_PICKER_STATE_PATH, "utf8"));
  assert.equal("visible" in persisted, false);
  const picker = modelPickerSnapshot();
  assert.equal(picker.hasExplicitVisibility, false);
  assert.deepEqual(picker.hidden, ["deepseek/deepseek-v4-pro"]);
  assert.ok(picker.visible.includes("deepseek/deepseek-v4-flash"));
});
