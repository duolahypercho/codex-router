import assert from "node:assert/strict";
import test from "node:test";

import { refreshCatalog } from "../src/refresh-catalog.mjs";

const noJournal = {
  begin() {},
  clear() {},
  read() { return undefined; },
};
const noLock = (operation) => operation();

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

test("ordinary routed refresh avoids config mutation when the native cache is safe", async () => {
  const runner = recordingRunner();
  const result = await refreshCatalog({
    canRefreshInPlace: () => true,
    run: runner.run,
    lock: noLock,
  });
  assert.deepEqual(runner.calls, [
    ["config-manager.mjs", ["status"]],
    ["catalog.mjs", ["--refresh-native"]],
  ]);
  assert.equal(result.catalogOutput, '{"models":1}\n');
});

test("refresh orchestration restores signed routing and republishes the routed catalog", async () => {
  const runner = recordingRunner();
  const result = await refreshCatalog({
    canRefreshInPlace: () => false,
    run: runner.run,
    lock: noLock,
  });
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

test("refresh orchestration restores the active transport after catalog failure", async () => {
  const runner = recordingRunner({ failAt: 3 });
  await assert.rejects(
    refreshCatalog({
      canRefreshInPlace: () => false,
      run: runner.run,
      lock: noLock,
    }),
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

test("ordinary routed refresh also republishes external models after restore", async () => {
  const runner = recordingRunner({ signed: false });
  await refreshCatalog({
    canRefreshInPlace: () => false,
    run: runner.run,
    lock: noLock,
  });
  assert.deepEqual(runner.calls, [
    ["config-manager.mjs", ["status"]],
    ["config-manager.mjs", ["disable"]],
    ["catalog.mjs", ["--refresh-native"]],
    ["config-manager.mjs", ["enable"]],
    ["catalog.mjs", []],
  ]);
});

test("refresh orchestration restores identity-preserving login-free mode and its model", async () => {
  const runner = recordingRunner({
    signed: false,
    loginFree: true,
    model: "gpt-5.6-sol",
  });
  await refreshCatalog({
    canRefreshInPlace: () => true,
    run: runner.run,
    aliases: () => ({ "gpt-5.6-sol": "deepseek/deepseek-v4-pro" }),
    aliasFor: (slug) => slug === "deepseek/deepseek-v4-pro" ? "gpt-5.6-terra" : undefined,
    journal: noJournal,
    lock: noLock,
  });
  assert.deepEqual(runner.calls, [
    ["config-manager.mjs", ["status"]],
    [
      "config-manager.mjs",
      ["disable", "--preserve-login-free-state", "--park-login-free-refresh"],
    ],
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
    [
      "config-manager.mjs",
      ["login-free-enable", "gpt-5.6-terra", "--complete-login-free-refresh"],
    ],
  ]);
});

test("pending refresh resumes and completes only with an alias for the same canonical route", async () => {
  const runner = recordingRunner({
    signed: false,
    loginFree: true,
    model: "old-alias",
  });
  const pending = {
    canonicalModel: "deepseek/deepseek-v4-pro",
    displayModel: "old-alias",
  };
  await refreshCatalog({
    canRefreshInPlace: () => true,
    run: runner.run,
    aliases: () => ({ "old-alias": pending.canonicalModel }),
    aliasFor: (slug) => slug === pending.canonicalModel ? "fresh-alias" : undefined,
    journal: {
      begin() {},
      clear() {},
      read() { return pending; },
    },
    lock: noLock,
  });
  assert.deepEqual(runner.calls, [
    ["config-manager.mjs", ["enable", "--resume-login-free-refresh"]],
    ["config-manager.mjs", ["status"]],
    [
      "config-manager.mjs",
      ["disable", "--preserve-login-free-state", "--park-login-free-refresh"],
    ],
    ["catalog.mjs", ["--refresh-native"]],
    [
      "config-manager.mjs",
      [
        "login-free-enable",
        pending.canonicalModel,
        "--restore-disabled-login-free",
      ],
    ],
    ["catalog.mjs", []],
    [
      "config-manager.mjs",
      ["login-free-enable", "fresh-alias", "--complete-login-free-refresh"],
    ],
  ]);
});
