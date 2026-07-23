import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

const stateDir = mkdtempSync(path.join(os.tmpdir(), "user-models-test-"));
process.env.CODEX_ROUTER_STATE_DIR = stateDir;

const { userModelEntry, readUserModels, writeUserModels, USER_MODELS_PATH } = await import(
  "../src/user-models.mjs"
);

test("userModelEntry fills conservative picker metadata", () => {
  const entry = userModelEntry({
    providerId: "ollama-cloud",
    upstreamId: "gpt-oss:120b",
    requestProfile: "ollama-cloud",
    priority: 101,
  });
  assert.equal(entry.slug, "ollama-cloud/gpt-oss:120b");
  assert.equal(entry.gatewayModel, "ollama-cloud-gpt-oss-120b");
  assert.equal(entry.upstreamModel, "gpt-oss:120b");
  assert.equal(entry.provider, "ollama-cloud");
  assert.equal(entry.listed, true);
  assert.equal(entry.priority, 101);
  assert.equal(entry.requestProfile, "ollama-cloud");
  assert.equal(entry.defaultEffort, "high");
  assert.ok(entry.reasoningLevels.some((level) => level.effort === "high"));
  assert.ok(Number.isInteger(entry.contextWindow) && entry.contextWindow >= 1);
  assert.ok(entry.autoCompact >= 1 && entry.autoCompact <= entry.contextWindow);
  assert.deepEqual(entry.inputModalities, ["text"]);
  assert.equal(entry.compHash, "ollama-cloud-gpt-oss-120b-user-v1");
  assert.ok(entry.displayName.includes("gpt-oss:120b"));
  assert.ok(entry.description.length > 0);
});

test("userModelEntry omits requestProfile when the provider has none", () => {
  const entry = userModelEntry({
    providerId: "zai-coding",
    upstreamId: "glm-4.7",
    priority: 100,
  });
  assert.equal(entry.requestProfile, undefined);
});

test("user models round-trip through the protected state file", () => {
  const entries = [
    userModelEntry({ providerId: "deepseek", upstreamId: "deepseek-vl-test", priority: 100 }),
  ];
  writeUserModels(entries);
  assert.deepEqual(readUserModels(), entries);
  assert.ok(USER_MODELS_PATH.startsWith(stateDir));
});

test("readUserModels returns an empty list when the file is absent or invalid", () => {
  writeFileSync(USER_MODELS_PATH, "not-json\n");
  assert.deepEqual(readUserModels(), []);
});

test("registry merges valid user models and skips collisions", async () => {
  const entries = [
    userModelEntry({ providerId: "deepseek", upstreamId: "deepseek-user-test", priority: 100 }),
    // Collides with a built-in slug and must be skipped, not fatal.
    { ...userModelEntry({ providerId: "deepseek", upstreamId: "deepseek-v4-pro", priority: 101 }) },
    // Unknown provider must be skipped, not fatal.
    userModelEntry({ providerId: "no-such-provider", upstreamId: "x-model", priority: 102 }),
  ];
  writeUserModels(entries);
  const registry = await import("../src/model-registry.mjs");
  const slugs = registry.MODELS.map((model) => model.slug);
  assert.ok(slugs.includes("deepseek/deepseek-user-test"));
  assert.equal(slugs.filter((slug) => slug === "deepseek/deepseek-v4-pro").length, 1);
  assert.ok(!slugs.includes("no-such-provider/x-model"));
  assert.ok(registry.MODEL_BY_GATEWAY_ID.has("deepseek-deepseek-user-test"));
  assert.ok(registry.USER_MODEL_WARNINGS.length >= 2);
  const merged = registry.MODEL_BY_SLUG.get("deepseek/deepseek-user-test");
  assert.equal(merged.listed, true);
});
