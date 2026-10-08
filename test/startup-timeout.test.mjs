import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

import {
  clearStartupTimeouts,
  runtimeChildEnvironment,
  serviceStartupTimeoutEnvironment,
  startupTimeoutMs,
} from "../src/startup-timeout.mjs";

test("runtime children never inherit the supervisor's startup-only allowances", () => {
  const env = {
    CODEX_ROUTER_WINDOWS_PRIVATE_SYNC_TIMEOUT_MS: "900000",
    CODEX_ROUTER_VENV_PROBE_TIMEOUT_MS: "300000",
    CODEX_ROUTER_VENV_PROBE_RETRY_TIMEOUT_MS: "300000",
    CODEX_ROUTER_WINDOWS_PROCESS_PROBE_TIMEOUT_MS: "900000",
    CODEX_ROUTER_STARTUP_HEALTH_TIMEOUT_MS: "300000",
    CODEX_ROUTER_GATEWAY_HEALTH_TIMEOUT_MS: "900000",
    PATH: "test-path",
  };
  assert.deepEqual(runtimeChildEnvironment(env), { PATH: "test-path" });
  assert.equal(env.CODEX_ROUTER_WINDOWS_PRIVATE_SYNC_TIMEOUT_MS, "900000");
});

test("the ready supervisor retires startup settings before background publication", () => {
  const env = {
    CODEX_ROUTER_WINDOWS_PRIVATE_SYNC_TIMEOUT_MS: "900000",
    CODEX_ROUTER_GATEWAY_HEALTH_TIMEOUT_MS: "900000",
    PATH: "test-path",
  };
  assert.equal(clearStartupTimeouts(env), env);
  assert.deepEqual(env, { PATH: "test-path" });
});

test("startup cleanup removes every casing and preserves unrelated environment keys", () => {
  const settings = serviceStartupTimeoutEnvironment({
    CODEX_ROUTER_WINDOWS_PRIVATE_SYNC_TIMEOUT_MS: "900000",
    CODEX_ROUTER_VENV_PROBE_TIMEOUT_MS: "300000",
    CODEX_ROUTER_VENV_PROBE_RETRY_TIMEOUT_MS: "300000",
    CODEX_ROUTER_WINDOWS_PROCESS_PROBE_TIMEOUT_MS: "900000",
    CODEX_ROUTER_STARTUP_HEALTH_TIMEOUT_MS: "300000",
    CODEX_ROUTER_GATEWAY_HEALTH_TIMEOUT_MS: "900000",
  });
  const unrelated = {
    PATH: "test-path",
    codex_router_unknown_timeout_ms: "123",
    CODEX_ROUTER_WINDOWS_PRIVATE_SYNC_TIMEOUT_MS_SUFFIX: "456",
  };
  const env = { ...unrelated };
  for (const [name, value] of Object.entries(settings)) {
    env[name] = value;
    env[name.toLowerCase()] = value;
    env[name.replace(/_([A-Z])/g, (_match, letter) => `_${letter.toLowerCase()}`)] = value;
  }
  const original = { ...env };
  assert.deepEqual(runtimeChildEnvironment(env), unrelated);
  assert.deepEqual(env, original, "child filtering must not mutate the supervisor");
  assert.equal(clearStartupTimeouts(env), env);
  assert.deepEqual(env, unrelated);
});

test("Windows runtime children use normal bounds after a mixed-case startup override", {
  skip: process.platform !== "win32",
}, () => {
  const name = "CODEX_ROUTER_WINDOWS_PRIVATE_SYNC_TIMEOUT_MS";
  const moduleUrl = new URL("../src/startup-timeout.mjs", import.meta.url).href;
  const script = `import { startupTimeoutMs } from ${JSON.stringify(moduleUrl)};\n` +
    `console.log(startupTimeoutMs(${JSON.stringify(name)}, 15000));`;
  const probe = (env) => {
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
      env,
      encoding: "utf8",
      timeout: 10_000,
      windowsHide: true,
    });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, result.stderr);
    return Number(result.stdout.trim());
  };
  for (const spelling of [name.toLowerCase(), "Codex_Router_Windows_Private_Sync_Timeout_Ms"]) {
    const env = { ...runtimeChildEnvironment(process.env), [spelling]: "900000" };
    assert.equal(probe(env), 900_000, "control must exercise native Windows lookup");
    assert.equal(probe(runtimeChildEnvironment(env)), 15_000, spelling);
  }
});

test("an unset variable keeps the shipped default", () => {
  assert.equal(startupTimeoutMs("CODEX_ROUTER_VENV_PROBE_TIMEOUT_MS", 15_000, {}), 15_000);
});

test("valid decimal integer overrides stay within their per-setting startup bound", () => {
  for (const [name, value] of [
    ["CODEX_ROUTER_VENV_PROBE_TIMEOUT_MS", "300000"],
    ["CODEX_ROUTER_VENV_PROBE_RETRY_TIMEOUT_MS", "300000"],
    ["CODEX_ROUTER_WINDOWS_PROCESS_PROBE_TIMEOUT_MS", "900000"],
    ["CODEX_ROUTER_WINDOWS_PRIVATE_SYNC_TIMEOUT_MS", "900000"],
    ["CODEX_ROUTER_STARTUP_HEALTH_TIMEOUT_MS", "300000"],
    ["CODEX_ROUTER_GATEWAY_HEALTH_TIMEOUT_MS", "900000"],
  ]) {
    assert.equal(startupTimeoutMs(name, 5_000, { [name]: value }), Number(value), name);
  }
});

test("malformed, fractional, and out-of-bound overrides keep the shipped default", () => {
  for (const raw of [
    "",
    "   ",
    "fast",
    "-1",
    "0",
    "12ms",
    "1.5",
    "300001",
    "900001",
    "Infinity",
  ]) {
    assert.equal(
      startupTimeoutMs("CODEX_ROUTER_VENV_PROBE_TIMEOUT_MS", 5_000, {
        CODEX_ROUTER_VENV_PROBE_TIMEOUT_MS: raw,
      }),
      5_000,
      `raw=${JSON.stringify(raw)}`,
    );
  }
  assert.equal(
    startupTimeoutMs("CODEX_ROUTER_STARTUP_HEALTH_TIMEOUT_MS", 5_000, {
      CODEX_ROUTER_STARTUP_HEALTH_TIMEOUT_MS: "900000",
    }),
    5_000,
    "startup health retains its tighter 300-second ceiling",
  );
});

test("service startup settings include only explicitly supplied valid overrides", () => {
  assert.deepEqual(serviceStartupTimeoutEnvironment({}), {});
  assert.deepEqual(
    serviceStartupTimeoutEnvironment({
      CODEX_ROUTER_VENV_PROBE_TIMEOUT_MS: "300000",
      CODEX_ROUTER_WINDOWS_PROCESS_PROBE_TIMEOUT_MS: "900000",
      CODEX_ROUTER_WINDOWS_PRIVATE_SYNC_TIMEOUT_MS: "12ms",
      CODEX_ROUTER_STARTUP_HEALTH_TIMEOUT_MS: "900000",
      CODEX_ROUTER_UNKNOWN_TIMEOUT_MS: "300000",
    }),
    {
      CODEX_ROUTER_VENV_PROBE_TIMEOUT_MS: "300000",
      CODEX_ROUTER_WINDOWS_PROCESS_PROBE_TIMEOUT_MS: "900000",
    },
  );
});

test("explicit caller options still win over the environment", async () => {
  const { venvRuntimeProblem } = await import("../src/venv-runtime.mjs");
  const timeouts = [];
  let calls = 0;
  const spawn = (_python, _args, { timeout }) => {
    timeouts.push(timeout);
    calls += 1;
    if (calls % 2 === 1) {
      return {
        error: Object.assign(new Error("spawnSync ETIMEDOUT"), { code: "ETIMEDOUT" }),
        status: null,
        stderr: "",
        stdout: "",
      };
    }
    return { error: undefined, status: 0, stderr: "", stdout: "/venv\n" };
  };
  const originalTimeout = process.env.CODEX_ROUTER_VENV_PROBE_TIMEOUT_MS;
  const originalRetry = process.env.CODEX_ROUTER_VENV_PROBE_RETRY_TIMEOUT_MS;
  process.env.CODEX_ROUTER_VENV_PROBE_TIMEOUT_MS = "120000";
  process.env.CODEX_ROUTER_VENV_PROBE_RETRY_TIMEOUT_MS = "300000";
  try {
    assert.equal(venvRuntimeProblem("python", { spawn }), undefined);
    assert.deepEqual(timeouts, [120_000, 300_000]);
    timeouts.length = 0;
    assert.equal(
      venvRuntimeProblem("python", { spawn, timeoutMs: 5_000, retryTimeoutMs: 7_000 }),
      undefined,
    );
    assert.deepEqual(timeouts, [5_000, 7_000]);
  } finally {
    if (originalTimeout === undefined) delete process.env.CODEX_ROUTER_VENV_PROBE_TIMEOUT_MS;
    else process.env.CODEX_ROUTER_VENV_PROBE_TIMEOUT_MS = originalTimeout;
    if (originalRetry === undefined) delete process.env.CODEX_ROUTER_VENV_PROBE_RETRY_TIMEOUT_MS;
    else process.env.CODEX_ROUTER_VENV_PROBE_RETRY_TIMEOUT_MS = originalRetry;
  }
});
