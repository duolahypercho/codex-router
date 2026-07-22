import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { oauthLoginArgs } from "../src/provider-onboarding.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("Grok tray sign-in explicitly starts the OAuth flow", () => {
  assert.deepEqual(oauthLoginArgs("grok-oauth"), ["login", "--oauth"]);
  assert.deepEqual(oauthLoginArgs("kimi-oauth"), ["login"]);
});

function isolatedPath() {
  if (process.platform !== "win32") return "/usr/bin:/bin";
  const windowsRoot = process.env.SystemRoot ?? process.env.WINDIR;
  assert.ok(windowsRoot, "Windows system root is required for isolated provider tests");
  return [
    path.join(windowsRoot, "System32"),
    path.join(windowsRoot, "System32", "WindowsPowerShell", "v1.0"),
  ].join(path.delimiter);
}

function isolatedEnvironment(testRoot) {
  return {
    ...process.env,
    HOME: testRoot,
    PATH: isolatedPath(),
    MODEL_ROUTER_TARGET: "cursor",
    MODEL_ROUTER_STATE_DIR: path.join(testRoot, "state"),
    KIMI_CODE_HOME: path.join(testRoot, "kimi"),
    GROK_HOME: path.join(testRoot, "grok-home"),
    GROK_AUTH_PATH: path.join(testRoot, "grok", "auth.json"),
    KIMI_API_KEY: "",
    MOONSHOT_API_KEY: "",
    DEEPSEEK_API_KEY: "",
    XAI_API_KEY: "",
    GROK_API_KEY: "",
    ANTHROPIC_API_KEY: "",
  };
}

test("provider onboarding reports install, login, and API key actions without secrets", () => {
  const testRoot = mkdtempSync(path.join(os.tmpdir(), "provider-onboarding-"));
  try {
    const output = execFileSync(
      process.execPath,
      [path.join(root, "src", "control.mjs"), "providers", "--json"],
      { cwd: root, encoding: "utf8", env: isolatedEnvironment(testRoot) },
    );
    const snapshot = JSON.parse(output);
    const byId = Object.fromEntries(snapshot.providers.map((provider) => [provider.id, provider]));

    assert.equal(byId["kimi-oauth"].action, "install");
    assert.equal(byId["grok-oauth"].action, "install");
    assert.equal(byId["kimi-api"].action, "add-key");
    assert.equal(byId["grok-api"].action, "add-key");
    assert.equal(byId["anthropic-api"].action, "add-key");
    assert.equal("source" in byId["kimi-api"], false);
  } finally {
    rmSync(testRoot, { recursive: true, force: true });
  }
});

test("control accepts an API key only through stdin and stores it privately", () => {
  const testRoot = mkdtempSync(path.join(os.tmpdir(), "provider-key-control-"));
  const testKey = "TEST_TRAY_XAI_KEY";
  try {
    const result = spawnSync(
      process.execPath,
      [path.join(root, "src", "control.mjs"), "credential", "grok-api"],
      {
        cwd: root,
        encoding: "utf8",
        env: isolatedEnvironment(testRoot),
        input: `${testKey}\n`,
      },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.doesNotMatch(result.stdout, new RegExp(testKey));
    assert.equal(
      readFileSync(path.join(testRoot, "state", "xai-api-key.secret"), "utf8").trim(),
      testKey,
    );
  } finally {
    rmSync(testRoot, { recursive: true, force: true });
  }
});
