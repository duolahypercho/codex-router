import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

const stateDir = mkdtempSync(path.join(os.tmpdir(), "vision-bridge-state-test-"));
process.env.CODEX_ROUTER_STATE_DIR = stateDir;

const {
  DEFAULT_VISION_EFFORT,
  DEFAULT_VISION_ENGINE,
  VISION_BRIDGE_STATE_PATH,
  readVisionBridgeSettings,
  setVisionBridgeEffort,
  setVisionBridgeEnabled,
  setVisionBridgeEngine,
  setVisionBridgeLocal,
  visionBridgeConfigured,
  visionBridgeSnapshot,
} = await import("../src/vision-bridge-state.mjs");
const { resolveVisionEngine } = await import("../src/vision-bridge.mjs");

function forgetState() {
  rmSync(VISION_BRIDGE_STATE_PATH, { force: true });
}

test("a machine that never configured the bridge gets it on", () => {
  forgetState();
  assert.equal(visionBridgeConfigured(), false);
  // The default names a model rather than ranking for one: "cheapest" was
  // scored by slug substring and matched nothing on a typical install, so the
  // winner fell out of alphabetical order.
  assert.deepEqual(readVisionBridgeSettings(), {
    version: 1,
    enabled: true,
    engine: DEFAULT_VISION_ENGINE,
    effort: DEFAULT_VISION_EFFORT,
    local: null,
    defaulted: true,
  });
  assert.ok(VISION_BRIDGE_STATE_PATH.startsWith(stateDir));
});

test("the default reaches the resolver, so a pasted image is read with no configuration", () => {
  forgetState();
  const flash = {
    slug: "qwen-plan/qwen3.6-flash",
    provider: "qwen-plan",
    inputModalities: ["text", "image"],
  };
  assert.equal(
    resolveVisionEngine(() => [flash], readVisionBridgeSettings())?.slug,
    "qwen-plan/qwen3.6-flash",
  );
  // ...and with nothing to read it with, the answer is still "no engine", which
  // is byte-for-byte the behaviour a switched-off bridge always had.
  assert.equal(resolveVisionEngine(() => [], readVisionBridgeSettings()), undefined);
});

test("enabling and pinning round-trip through protected state", () => {
  setVisionBridgeEnabled(true);
  assert.equal(readVisionBridgeSettings().enabled, true);

  setVisionBridgeEngine("qwen-plan/qwen3.6-flash");
  assert.equal(readVisionBridgeSettings().engine, "qwen-plan/qwen3.6-flash");
  assert.equal(visionBridgeSnapshot().path, VISION_BRIDGE_STATE_PATH);

  // Unpinning hands the choice back to the automatic ranking without turning
  // the bridge off. The effort is a separate axis and is left alone, and the
  // result is no longer `defaulted`: the operator has been here.
  setVisionBridgeEngine(null);
  assert.deepEqual(readVisionBridgeSettings(), {
    version: 1,
    enabled: true,
    engine: null,
    effort: DEFAULT_VISION_EFFORT,
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
  assert.deepEqual(readVisionBridgeSettings(), { version: 1, enabled: false, engine: null, effort: null, local: null });
});

// The migration rule, stated as a test. "Never configured" is the absence of
// the file; anything on disk is the operator's own answer and the new default
// must not reach past it. An unreadable file is not consent either way, so it
// keeps the conservative reading it always had.
test("a stored off is never re-enabled by the new default", () => {
  writeFileSync(
    VISION_BRIDGE_STATE_PATH,
    `${JSON.stringify({ version: 1, enabled: false, engine: null, effort: null, local: null })}\n`,
    "utf8",
  );
  assert.equal(visionBridgeConfigured(), true);
  assert.equal(readVisionBridgeSettings().enabled, false);
  // And it keeps surviving reads, writes of unrelated fields, and re-reads.
  setVisionBridgeEffort("high");
  assert.equal(readVisionBridgeSettings().enabled, false);
  setVisionBridgeEngine("qwen-plan/qwen3.6-flash");
  assert.equal(readVisionBridgeSettings().enabled, false);
  // A stored off resolves no engine, exactly as before.
  assert.equal(
    resolveVisionEngine(
      () => [
        { slug: "qwen-plan/qwen3.6-flash", provider: "qwen-plan", inputModalities: ["text", "image"] },
      ],
      readVisionBridgeSettings(),
    ),
    undefined,
  );
  setVisionBridgeEffort(null);
  setVisionBridgeEngine(null);
});

test("a state file this build cannot read stays off rather than adopting the new default", () => {
  writeFileSync(
    VISION_BRIDGE_STATE_PATH,
    `${JSON.stringify({ version: 99, enabled: true })}\n`,
    "utf8",
  );
  assert.equal(readVisionBridgeSettings().enabled, false);
  writeFileSync(VISION_BRIDGE_STATE_PATH, `${JSON.stringify({ version: 1 })}\n`, "utf8");
  assert.equal(readVisionBridgeSettings().enabled, false);
});

test("a reasoning effort is pinned and cleared on its own, without touching the engine", () => {
  setVisionBridgeEnabled(true);
  setVisionBridgeEngine("gpt-5.6-luna");

  setVisionBridgeEffort("xhigh");
  assert.equal(readVisionBridgeSettings().effort, "xhigh");
  assert.equal(readVisionBridgeSettings().engine, "gpt-5.6-luna");

  // Anything outside the known ladder reads as no pin at all, so a hand-edited
  // state file cannot smuggle a value the backend would reject.
  setVisionBridgeEffort("turbo");
  assert.equal(readVisionBridgeSettings().effort, null);

  setVisionBridgeEffort("MAX");
  assert.equal(readVisionBridgeSettings().effort, "max");

  setVisionBridgeEffort(null);
  assert.equal(readVisionBridgeSettings().effort, null);
  assert.equal(readVisionBridgeSettings().engine, "gpt-5.6-luna");
});
