import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

// Set before the imports below: user-models and provider-selection bind their
// paths at module load, and these tests must never touch the real state.
const stateDir = mkdtempSync(path.join(os.tmpdir(), "lmstudio-panel-test-"));
process.env.MODEL_ROUTER_STATE_DIR = stateDir;
process.env.MODEL_ROUTER_USER_MODELS = path.join(stateDir, "user-models.json");

const {
  isLmstudioModelEnabled,
  lmstudioServedModels,
  lmstudioSnapshot,
  setLmstudioModelEnabled,
} = await import("../src/lmstudio-models.mjs");
const { readUserModels, writeUserModels, userModelEntry } = await import(
  "../src/user-models.mjs"
);
const { readProviderSelection } = await import("../src/provider-selection.mjs");

function fetchOk(ids) {
  return async () => ({
    ok: true,
    json: async () => ({ data: ids.map((id) => ({ id })) }),
  });
}

const fetchDown = async () => {
  throw new Error("connection refused");
};

test("served models come from the /models endpoint, deduplicated and sorted", async () => {
  const served = await lmstudioServedModels({
    fetchImpl: fetchOk(["zeta", "alpha", "alpha", ""]),
  });
  assert.equal(served.reachable, true);
  assert.match(String(served.baseUrl), /^http:\/\/127\.0\.0\.1:1234/);
  assert.deepEqual(served.models, ["alpha", "zeta"]);
});

test("a server that is off reads as unreachable, not as an error", async () => {
  const served = await lmstudioServedModels({ fetchImpl: fetchDown });
  assert.equal(served.reachable, false);
  assert.deepEqual(served.models, []);
});

test("the snapshot merges served models with curated ones, keeping stale entries visible", async () => {
  const userModels = [
    userModelEntry({ providerId: "lmstudio", upstreamId: "alpha", priority: 950 }),
    userModelEntry({ providerId: "lmstudio", upstreamId: "gone-model", priority: 951 }),
    userModelEntry({ providerId: "kimi-api", upstreamId: "other", priority: 100 }),
  ];
  const snapshot = await lmstudioSnapshot({
    fetchImpl: fetchOk(["alpha", "beta"]),
    userModels,
  });
  assert.equal(snapshot.reachable, true);
  assert.equal(snapshot.enabled, 2);
  assert.deepEqual(snapshot.models, [
    { id: "alpha", enabled: true, served: true },
    { id: "beta", enabled: false, served: true },
    // Curated but no longer served: hiding it would strand a picker route
    // with no way to see or clear it from the panel.
    { id: "gone-model", enabled: true, served: false },
  ]);
});

test("an unreachable server still reports curated models", async () => {
  const userModels = [
    userModelEntry({ providerId: "lmstudio", upstreamId: "alpha", priority: 950 }),
  ];
  const snapshot = await lmstudioSnapshot({ fetchImpl: fetchDown, userModels });
  assert.equal(snapshot.reachable, false);
  assert.deepEqual(snapshot.models, [{ id: "alpha", enabled: true, served: false }]);
});

test("checking a model publishes it through the same overlay curate-models writes", () => {
  writeUserModels([
    userModelEntry({ providerId: "kimi-api", upstreamId: "other", priority: 100 }),
  ]);
  setLmstudioModelEnabled("qwen/qwen3-4b", true);

  const stored = readUserModels();
  const mine = stored.filter((model) => model.provider === "lmstudio");
  assert.equal(mine.length, 1);
  assert.equal(mine[0].upstreamModel, "qwen/qwen3-4b");
  assert.equal(mine[0].displayName, "qwen/qwen3-4b (LM Studio, experimental)");
  assert.equal(mine[0].supportsApplyPatchTool, false);
  assert.equal(mine[0].multiAgentVersion, "v1");
  // The KV-cache reasoning from the Ollama path applies to any local model.
  assert.equal(mine[0].contextWindow, 32768);
  // Other providers' curated entries survive untouched.
  assert.ok(stored.some((model) => model.provider === "kimi-api"));
  assert.equal(isLmstudioModelEnabled("qwen/qwen3-4b"), true);
  // The provider follows the models: first check turns it on.
  assert.ok(readProviderSelection().includes("lmstudio"));

  setLmstudioModelEnabled("qwen/qwen3-4b", false);
  assert.equal(isLmstudioModelEnabled("qwen/qwen3-4b"), false);
  assert.ok(readUserModels().some((model) => model.provider === "kimi-api"));
  // ...and the last uncheck turns it back off.
  assert.ok(!readProviderSelection().includes("lmstudio"));
  const raw = JSON.parse(readFileSync(process.env.MODEL_ROUTER_USER_MODELS, "utf8"));
  assert.ok(Array.isArray(raw.models));
});

test("a disable/re-enable cycle cannot land two models on one priority", () => {
  writeUserModels([]);
  setLmstudioModelEnabled("alpha", true);
  setLmstudioModelEnabled("beta", true);
  setLmstudioModelEnabled("gamma", true);
  setLmstudioModelEnabled("beta", false);
  setLmstudioModelEnabled("beta", true);
  const mine = readUserModels().filter((model) => model.provider === "lmstudio");
  const priorities = mine.map((model) => model.priority);
  assert.equal(new Set(priorities).size, priorities.length, `collision in ${priorities}`);
});

test("toggling one model leaves the other curated LM Studio entries alone", () => {
  writeUserModels([]);
  setLmstudioModelEnabled("alpha", true);
  setLmstudioModelEnabled("beta", true);
  setLmstudioModelEnabled("alpha", false);
  const mine = readUserModels().filter((model) => model.provider === "lmstudio");
  assert.deepEqual(mine.map((model) => model.upstreamModel), ["beta"]);
  assert.ok(readProviderSelection().includes("lmstudio"));
});
