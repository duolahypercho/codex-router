import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// The registry is built at import time from the state directory, so each case
// loads it in a fresh process against its own user-models.json.
function loadUserModel(extra) {
  const stateDir = mkdtempSync(path.join(os.tmpdir(), "failover-candidate-registry-"));
  const entry = {
    slug: "kilo-free/example/failover-candidate-probe:free",
    gatewayModel: "kilo-free-example-failover-candidate-probe-free",
    compHash: "kilo-free-example-failover-candidate-probe-free-user-v1",
    upstreamModel: "example/failover-candidate-probe:free",
    provider: "kilo-free",
    listed: true,
    displayName: "Failover candidate probe",
    description: "test entry",
    priority: 100,
    defaultEffort: "high",
    reasoningLevels: [{ effort: "high", description: "x" }],
    contextWindow: 131072,
    autoCompact: 110000,
    inputModalities: ["text"],
    ...extra,
  };
  writeFileSync(path.join(stateDir, "user-models.json"), JSON.stringify({ version: 1, models: [entry] }));
  const script = `
    const reg = await import(${JSON.stringify(pathToFileURL(path.join(root, "src/model-registry.mjs")).href)});
    const model = reg.MODELS.find((m) => m.slug === ${JSON.stringify(entry.slug)});
    console.log(JSON.stringify({
      loaded: Boolean(model),
      failoverCandidate: model?.failoverCandidate,
      skipped: reg.USER_MODELS_SKIPPED.get(${JSON.stringify(entry.slug)}) ?? null,
    }));`;
  const out = execFileSync(process.execPath, ["--input-type=module", "-e", script], {
    cwd: root,
    env: { ...process.env, CODEX_ROUTER_STATE_DIR: stateDir, MODEL_ROUTER_STATE_DIR: stateDir },
    encoding: "utf8",
  });
  return JSON.parse(out.trim().split("\n").pop());
}

test("a user model keeps failoverCandidate: false through the registry", () => {
  const result = loadUserModel({ failoverCandidate: false });
  assert.equal(result.loaded, true);
  assert.equal(result.failoverCandidate, false);
});

test("a user model without failoverCandidate loads unchanged", () => {
  const result = loadUserModel({});
  assert.equal(result.loaded, true);
  assert.equal(result.failoverCandidate, undefined);
});

test("a non-boolean failoverCandidate is refused instead of silently ignored", () => {
  const result = loadUserModel({ failoverCandidate: "no" });
  assert.equal(result.loaded, false);
  assert.match(String(result.skipped), /invalid failoverCandidate/);
});
