import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function probe(target, providers, usageEvents = []) {
  const stateDir = mkdtempSync(path.join(os.tmpdir(), "control-probe-"));
  writeFileSync(
    path.join(stateDir, "enabled-providers.json"),
    `${JSON.stringify({ version: 1, providers })}\n`,
    { mode: 0o600 },
  );
  if (usageEvents.length) {
    writeFileSync(
      path.join(stateDir, "usage-events.jsonl"),
      `${usageEvents.map((event) => JSON.stringify(event)).join("\n")}\n`,
      { mode: 0o600 },
    );
  }
  try {
    const output = execFileSync(process.execPath, [path.join(root, "src", "control.mjs"), "--probe"], {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, MODEL_ROUTER_TARGET: target, MODEL_ROUTER_STATE_DIR: stateDir },
    });
    return JSON.parse(output);
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
}

test("claude probe reports enabled models with role mapping", () => {
  const slice = probe("claude", ["chatgpt-oauth"]);
  assert.equal(slice.target, "claude");
  assert.equal(slice.configured, true);
  const gpt = slice.models.find((m) => m.provider === "chatgpt-oauth");
  assert.equal(gpt.enabled, true);
  assert.equal(gpt.claudeRole, "claude-sonnet-5");
  // A disabled provider is reported but not enabled, and has no role.
  const kimi = slice.models.find((m) => m.provider === "kimi-oauth");
  assert.equal(kimi.enabled, false);
  assert.equal(kimi.claudeRole, undefined);
});

test("cursor probe reports enabled models without claude roles", () => {
  const slice = probe("cursor", ["deepseek"]);
  assert.equal(slice.target, "cursor");
  const deepseek = slice.models.filter((m) => m.provider === "deepseek");
  assert.ok(deepseek.length > 0 && deepseek.every((m) => m.enabled));
  assert.ok(slice.models.every((m) => m.claudeRole === undefined));
});

test("codex probe exposes only privacy-safe recent usage events", () => {
  const event = {
    at: new Date().toISOString(),
    model: "chatgpt-oauth/gpt-5.6-sol",
    provider: "chatgpt-oauth",
    status: 200,
    durationMs: 1234,
    prompt: "must not escape the private event store",
  };
  const slice = probe("codex", ["chatgpt-oauth"], [event]);
  assert.deepEqual(slice.usageEvents, [{
    at: event.at,
    model: event.model,
    provider: event.provider,
    status: event.status,
    durationMs: event.durationMs,
  }]);
  assert.equal("prompt" in slice.usageEvents[0], false);
  assert.equal("response" in slice.usageEvents[0], false);
});

function probeSet(target, providers, provider, desired) {
  const stateDir = mkdtempSync(path.join(os.tmpdir(), "control-set-"));
  writeFileSync(
    path.join(stateDir, "enabled-providers.json"),
    `${JSON.stringify({ version: 1, providers })}\n`,
    { mode: 0o600 },
  );
  try {
    const output = execFileSync(
      process.execPath,
      [path.join(root, "src", "control.mjs"), "--probe-set", provider, desired],
      {
        cwd: root,
        encoding: "utf8",
        env: { ...process.env, MODEL_ROUTER_TARGET: target, MODEL_ROUTER_STATE_DIR: stateDir },
      },
    );
    return JSON.parse(output);
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
}

test("toggle on adds a provider; toggle off removes it", () => {
  const added = probeSet("cursor", ["deepseek"], "chatgpt-oauth", "on");
  assert.deepEqual(added.enabledProviders, ["deepseek", "chatgpt-oauth"]);

  const removed = probeSet("cursor", ["chatgpt-oauth", "deepseek"], "deepseek", "off");
  assert.deepEqual(removed.enabledProviders, ["chatgpt-oauth"]);
});

test("toggle rejects an unknown provider", () => {
  assert.throws(() => probeSet("cursor", ["deepseek"], "not-a-provider", "on"));
});

test("aggregate overview covers every target", () => {
  const output = execFileSync(process.execPath, [path.join(root, "src", "control.mjs"), "--json"], {
    cwd: root,
    encoding: "utf8",
  });
  const overview = JSON.parse(output);
  assert.deepEqual(Object.keys(overview.targets).sort(), ["claude", "codex", "cursor"]);
});
