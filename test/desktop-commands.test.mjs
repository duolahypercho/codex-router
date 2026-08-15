import assert from "node:assert/strict";
import test from "node:test";

import { COMMANDS } from "../src/desktop-commands.mjs";

test("desktop local-model commands use the shared model argument", () => {
  assert.deepEqual(COMMANDS.install_local_model({ model: "gemma4:12b" }), {
    args: ["local-models", "install", "gemma4:12b", "--yes"],
  });
  assert.deepEqual(COMMANDS.install_local_model({ model: "gemma4:12b", force: true }), {
    args: ["local-models", "install", "gemma4:12b", "--yes", "--force"],
  });
  assert.deepEqual(COMMANDS.uninstall_local_model({ model: "gemma4:12b" }), {
    args: ["local-models", "uninstall", "gemma4:12b", "--yes", "--async"],
  });
  assert.deepEqual(COMMANDS.cancel_local_model({ model: "gemma4:12b" }), {
    args: ["local-models", "cancel", "gemma4:12b"],
  });
  assert.deepEqual(COMMANDS.set_local_model_enabled({ model: "gemma4:12b", enabled: true }), {
    args: ["local-models", "set", "gemma4:12b", "on"],
  });
  // LM Studio ids carry slashes ("qwen/qwen3-4b"), which requireTag permits.
  assert.deepEqual(
    COMMANDS.set_lmstudio_model_enabled({ model: "qwen/qwen3-4b", enabled: true }),
    { args: ["local-models", "lmstudio-set", "qwen/qwen3-4b", "on"] },
  );
  assert.deepEqual(
    COMMANDS.set_lmstudio_model_enabled({ id: "qwen/qwen3-4b", enabled: false }),
    { args: ["local-models", "lmstudio-set", "qwen/qwen3-4b", "off"] },
  );
  assert.deepEqual(COMMANDS.local_model_speed({ model: "gemma4:12b" }), {
    args: ["local-models", "benchmark", "gemma4:12b"],
  });
  assert.deepEqual(COMMANDS.benchmark_vision_model({ model: "qwen2.5vl:3b" }), {
    args: ["vision-bridge", "benchmark", "qwen2.5vl:3b"],
  });
  assert.deepEqual(COMMANDS.use_local_vision_model({ model: "qwen2.5vl:3b" }), {
    args: ["vision-bridge", "local", "qwen2.5vl:3b"],
  });
});

test("desktop settings commands preserve the Windows and macOS tray contract", () => {
  assert.deepEqual(COMMANDS.set_signed_routing({ enabled: true }), {
    args: ["signed-routing", "on"],
    then: ["--json"],
  });
  assert.deepEqual(COMMANDS.set_presence_mode({ mode: "follow-codex" }), {
    args: ["presence", "set", "follow-codex"],
  });
  assert.deepEqual(COMMANDS.service_start(), { args: ["service", "start"] });
  assert.deepEqual(COMMANDS.service_stop(), { args: ["service", "stop"] });
  assert.deepEqual(COMMANDS.set_tool_result_aging({ enabled: true }), {
    args: ["tool-result-aging", "on"],
  });
  assert.deepEqual(COMMANDS.set_vision_engine({ engine: "gpt-5.6-luna", effort: "low" }), {
    args: ["vision-bridge", "engine", "gpt-5.6-luna", "low"],
  });
  assert.deepEqual(COMMANDS.doctor_fix(), {
    args: ["doctor", "--fix", "--json"],
  });
});

test("desktop local-model commands retain the legacy tag argument and validation", () => {
  assert.deepEqual(COMMANDS.install_local_model({ tag: "gemma4:12b" }), {
    args: ["local-models", "install", "gemma4:12b", "--yes"],
  });
  assert.deepEqual(COMMANDS.cancel_local_model({ tag: "gemma4:12b" }), {
    args: ["local-models", "cancel", "gemma4:12b"],
  });
  assert.throws(
    () => COMMANDS.install_local_model({ model: "not a model" }),
    /Unknown model tag: not a model/,
  );
});
