import assert from "node:assert/strict";
import test from "node:test";

import { refreshCatalog } from "../src/refresh-catalog.mjs";

function recordingRunner({ signed = true, loginFree = false, model, failAt } = {}) {
  const calls = [];
  return {
    calls,
    run(script, args) {
      calls.push([script, args]);
      const index = calls.length;
      if (index === failAt) {
        return { status: 75, stdout: "", stderr: "forced catalog failure" };
      }
      if (script === "config-manager.mjs" && args[0] === "status") {
        return {
          status: 0,
          stdout: `${JSON.stringify({
            mode: "router",
            signed_routing: signed,
            login_free: loginFree,
            model: model || null,
          })}\n`,
          stderr: "",
        };
      }
      return {
        status: 0,
        stdout: script === "catalog.mjs" ? '{"models":1}\n' : "",
        stderr: "",
      };
    },
  };
}

test("refresh orchestration restores signed routing and republishes the routed catalog", () => {
  const runner = recordingRunner();
  const result = refreshCatalog({ run: runner.run });
  assert.deepEqual(runner.calls, [
    ["config-manager.mjs", ["status"]],
    ["config-manager.mjs", ["disable"]],
    ["catalog.mjs", ["--refresh-native"]],
    ["config-manager.mjs", ["enable"]],
    ["config-manager.mjs", ["signed-enable"]],
    ["catalog.mjs", []],
  ]);
  assert.equal(result.catalogOutput, '{"models":1}\n');
});

test("refresh orchestration restores the active transport after catalog failure", () => {
  const runner = recordingRunner({ failAt: 3 });
  assert.throws(
    () => refreshCatalog({ run: runner.run }),
    /catalog\.mjs exited with status 75.*forced catalog failure/s,
  );
  assert.deepEqual(runner.calls, [
    ["config-manager.mjs", ["status"]],
    ["config-manager.mjs", ["disable"]],
    ["catalog.mjs", ["--refresh-native"]],
    ["config-manager.mjs", ["enable"]],
    ["config-manager.mjs", ["signed-enable"]],
    ["catalog.mjs", []],
  ]);
});

test("ordinary routed refresh also republishes external models after restore", () => {
  const runner = recordingRunner({ signed: false });
  refreshCatalog({ run: runner.run });
  assert.deepEqual(runner.calls, [
    ["config-manager.mjs", ["status"]],
    ["config-manager.mjs", ["disable"]],
    ["catalog.mjs", ["--refresh-native"]],
    ["config-manager.mjs", ["enable"]],
    ["catalog.mjs", []],
  ]);
});

test("refresh orchestration restores identity-preserving login-free mode and its model", () => {
  const runner = recordingRunner({
    signed: false,
    loginFree: true,
    model: "gpt-5.6-sol",
  });
  refreshCatalog({
    run: runner.run,
    aliases: () => ({ "gpt-5.6-sol": "deepseek/deepseek-v4-pro" }),
    aliasFor: (slug) => slug === "deepseek/deepseek-v4-pro" ? "gpt-5.6-terra" : undefined,
  });
  assert.deepEqual(runner.calls, [
    ["config-manager.mjs", ["status"]],
    ["config-manager.mjs", ["disable", "--preserve-login-free-state"]],
    ["catalog.mjs", ["--refresh-native"]],
    [
      "config-manager.mjs",
      [
        "login-free-enable",
        "deepseek/deepseek-v4-pro",
        "--restore-disabled-login-free",
      ],
    ],
    ["catalog.mjs", []],
    ["config-manager.mjs", ["login-free-enable", "gpt-5.6-terra"]],
  ]);
});
