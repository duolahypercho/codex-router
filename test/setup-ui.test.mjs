import assert from "node:assert/strict";
import { test } from "node:test";

import {
  colorize,
  providerStatusLabel,
  renderProviderChoices,
  stepHeader,
  toggleSelection,
} from "../src/setup-ui.mjs";

const SNAPSHOTS = [
  { id: "kimi-oauth", displayName: "Kimi Code OAuth", kind: "oauth", action: "ready" },
  { id: "deepseek", displayName: "DeepSeek API", kind: "api", action: "add-key" },
  { id: "grok-oauth", displayName: "xAI Grok OAuth", kind: "oauth", action: "install" },
];

test("stepHeader shows position and title", () => {
  assert.equal(stepHeader(2, 5, "Choose providers"), "\n--- Step 2 of 5: Choose providers ---\n");
});

test("providerStatusLabel maps onboarding actions to friendly text", () => {
  assert.equal(providerStatusLabel({ action: "ready" }), "ready");
  assert.equal(providerStatusLabel({ action: "add-key" }), "needs API key");
  assert.equal(providerStatusLabel({ action: "login" }), "needs CLI sign-in");
  assert.equal(providerStatusLabel({ action: "install" }), "needs CLI install");
  assert.equal(providerStatusLabel({ action: "mystery" }), "setup required");
});

test("renderProviderChoices marks selected rows and shows status", () => {
  const rendered = renderProviderChoices(SNAPSHOTS, new Set([1, 3]));
  const lines = rendered.split("\n");
  assert.equal(lines[0], "  [x] 1. Kimi Code OAuth — ready");
  assert.equal(lines[1], "  [ ] 2. DeepSeek API — needs API key");
  assert.equal(lines[2], "  [x] 3. xAI Grok OAuth — needs CLI install");
});

test("toggleSelection toggles numbers on and off", () => {
  let state = toggleSelection(new Set(), "1,3", 3);
  assert.deepEqual([...state.selected].sort(), [1, 3]);
  assert.equal(state.done, undefined);
  state = toggleSelection(state.selected, "3", 3);
  assert.deepEqual([...state.selected], [1]);
});

test("toggleSelection supports all and none shortcuts", () => {
  const all = toggleSelection(new Set([2]), "a", 3);
  assert.deepEqual([...all.selected].sort(), [1, 2, 3]);
  const none = toggleSelection(all.selected, "n", 3);
  assert.deepEqual([...none.selected], []);
});

test("toggleSelection finishes on empty input with a non-empty selection", () => {
  const state = toggleSelection(new Set([2]), "", 3);
  assert.equal(state.done, true);
  assert.deepEqual([...state.selected], [2]);
});

test("toggleSelection refuses to finish with nothing selected", () => {
  const state = toggleSelection(new Set(), "", 3);
  assert.equal(state.done, undefined);
  assert.ok(state.error.includes("at least one"));
});

test("toggleSelection reports invalid input without changing the selection", () => {
  const state = toggleSelection(new Set([1]), "0,nope", 3);
  assert.ok(state.error);
  assert.deepEqual([...state.selected], [1]);
});

test("colorize wraps only when enabled", () => {
  assert.equal(colorize("ready", "green", false), "ready");
  assert.equal(colorize("ready", "green", true), "\u001b[32mready\u001b[0m");
  assert.equal(colorize("ready", "unknown-color", true), "ready");
});
