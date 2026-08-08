import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

const stateDir = mkdtempSync(path.join(os.tmpdir(), "vision-bridge-state-test-"));
process.env.CODEX_ROUTER_STATE_DIR = stateDir;

const {
  VISION_BRIDGE_STATE_PATH,
  readVisionBridgeSettings,
  setVisionBridgeEnabled,
  setVisionBridgeEngine,
  setVisionBridgeLocal,
  visionBridgeSnapshot,
} = await import("../src/vision-bridge-state.mjs");

test("the bridge is off until the operator turns it on", () => {
  assert.deepEqual(readVisionBridgeSettings(), { version: 1, enabled: false, engine: null, local: null });
  assert.ok(VISION_BRIDGE_STATE_PATH.startsWith(stateDir));
});

test("enabling and pinning round-trip through protected state", () => {
  setVisionBridgeEnabled(true);
  assert.equal(readVisionBridgeSettings().enabled, true);

  setVisionBridgeEngine("qwen-plan/qwen3.6-flash");
  assert.equal(readVisionBridgeSettings().engine, "qwen-plan/qwen3.6-flash");
  assert.equal(visionBridgeSnapshot().path, VISION_BRIDGE_STATE_PATH);

  // Unpinning hands the choice back to the automatic ranking without turning
  // the bridge off.
  setVisionBridgeEngine(null);
  assert.deepEqual(readVisionBridgeSettings(), {
    version: 1,
    enabled: true,
    engine: null,
    local: null,
  });

  setVisionBridgeEnabled(false);
  assert.equal(readVisionBridgeSettings().enabled, false);
});

test("pinning a local model stores it and selects the local engine", () => {
  setVisionBridgeLocal({ model: "qwen2.5vl:3b", baseUrl: "http://127.0.0.1:11434/v1" });
  const s = readVisionBridgeSettings();
  assert.equal(s.engine, "local");
  assert.deepEqual(s.local, { model: "qwen2.5vl:3b", baseUrl: "http://127.0.0.1:11434/v1" });

  // A local pin with just a model keeps the base URL to the resolver's default.
  setVisionBridgeLocal({ model: "moondream" });
  assert.deepEqual(readVisionBridgeSettings().local, { model: "moondream" });

  setVisionBridgeEnabled(false);
});

test("corrupt state reads as off rather than throwing", () => {
  writeFileSync(VISION_BRIDGE_STATE_PATH, "{not json", "utf8");
  assert.deepEqual(readVisionBridgeSettings(), { version: 1, enabled: false, engine: null, local: null });
});
