import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { userModelEntry } from "../src/user-models.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const customProvider = { id: "custom", displayName: "Custom", kind: "openai-compatible",
  ownedBy: "custom", authMode: "per-model", perModelEndpoint: true };

function customModel(upstreamModel, policy) {
  return { ...userModelEntry({ providerId: "custom", upstreamId: upstreamModel, priority: 100 }),
    endpoint: { baseUrl: "http://127.0.0.1:9999/v1", keyless: true, protocol: "openai-responses" },
    ...(policy === undefined ? {} : { reasoningTagPolicy: policy }) };
}

function fixture(t) {
  const directory = mkdtempSync(path.join(os.tmpdir(), "tag-policy-registry-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const registryPath = path.join(directory, "registry.json");
  const userPath = path.join(directory, "user-models.json");
  const genericPath = path.join(directory, "generic-providers.json");
  return {
    load({ models, users = [], generic = [] }) {
      writeFileSync(registryPath, JSON.stringify({ version: 1, providers: [customProvider], models }));
      writeFileSync(userPath, JSON.stringify({ version: 1, models: users }));
      writeFileSync(genericPath, JSON.stringify({ version: 1, providers: generic }));
      return spawnSync(process.execPath, ["--input-type=module", "-e", `
        const registry = await import('./src/model-registry.mjs');
        const { reasoningTagOptionsForRoute } = await import('./src/reasoning-tag-policy.mjs');
        process.stdout.write(JSON.stringify({
          models: registry.MODELS.map(model => ({ slug: model.slug,
            policy: model.reasoningTagPolicy, options: reasoningTagOptionsForRoute(model),
            protocol: registry.providerForModel(model)?.protocol })),
          warnings: registry.USER_MODEL_WARNINGS,
          skipped: [...registry.USER_MODELS_SKIPPED],
          rawModels: registry.readRegistryDocument().models,
        }));
      `], { cwd: root, encoding: "utf8", env: { ...process.env,
        CODEX_ROUTER_SOURCE_ROOT: root, CODEX_HOME: path.join(directory, "codex"),
        MODEL_ROUTER_STATE_DIR: directory, CODEX_ROUTER_STATE_DIR: directory,
        MODEL_ROUTER_REGISTRY: registryPath, MODEL_ROUTER_USER_MODELS: userPath,
        MODEL_ROUTER_GENERIC_PROVIDERS: genericPath } });
    },
  };
}

test("static registry round-trips tag policy into effective Responses routes", (t) => {
  const models = [customModel("default"), customModel("preserve", "preserve"),
    customModel("legacy", "legacy-inline"), customModel("vendor/hy4-preview", "hy4-nonce")];
  const result = fixture(t).load({ models });
  assert.equal(result.status, 0, result.stderr);
  const actual = JSON.parse(result.stdout);
  assert.deepEqual(actual.rawModels, models);
  assert.deepEqual(actual.models, [
    { slug: "custom/default", protocol: "openai-responses" },
    { slug: "custom/preserve", policy: "preserve", protocol: "openai-responses" },
    { slug: "custom/legacy", policy: "legacy-inline", protocol: "openai-responses",
      options: { plainDelimiters: true, nonceDelimiters: false } },
    { slug: "custom/vendor/hy4-preview", policy: "hy4-nonce", protocol: "openai-responses",
      options: { plainDelimiters: false, nonceDelimiters: true } },
  ]);
});

test("static registry rejects invalid policies before producing a model registry", (t) => {
  const load = fixture(t).load;
  for (const policy of [null, true, 1, {}, "legacy", "hy4-nonce"]) {
    const result = load({ models: [customModel("ordinary-model", policy)] });
    assert.notEqual(result.status, 0, JSON.stringify(policy));
    assert.match(result.stderr, /reasoningTagPolicy/);
    assert.equal(result.stdout, "");
  }
});

test("curated and generic route conversion retains valid policies and excludes invalid entries", (t) => {
  const users = [customModel("curated-preserve", "preserve"), customModel("curated-legacy", "legacy-inline"),
    customModel("curated-invalid", "legacy"), customModel("curated-forged-nonce", "hy4-nonce"),
    userModelEntry({ providerId: "runtime-responses", upstreamId: "vendor/model",
      requestProfile: "auto-tool-choice", priority: 110, metadata: { reasoningTagPolicy: "legacy-inline" } }),
    userModelEntry({ providerId: "runtime-responses", upstreamId: "vendor/preserve",
      priority: 111, metadata: { reasoningTagPolicy: "preserve" } }),
    userModelEntry({ providerId: "runtime-responses", upstreamId: "vendor/invalid",
      priority: 112, metadata: { reasoningTagPolicy: "invalid" } }),
  ];
  const generic = [{ id: "runtime-responses", displayName: "Runtime Responses",
    baseUrl: "https://responses.example.test/v1", adapter: "openai-responses", enabled: true,
    allowPrivate: false }];
  const result = fixture(t).load({ models: [customModel("checked-in")], users, generic });
  assert.equal(result.status, 0, result.stderr);
  const actual = JSON.parse(result.stdout);
  assert.deepEqual(actual.models.map(({ slug, policy, options }) => ({ slug, policy, options })), [
    { slug: "custom/checked-in", policy: undefined, options: undefined },
    { slug: "custom/curated-preserve", policy: "preserve", options: undefined },
    { slug: "custom/curated-legacy", policy: "legacy-inline", options: { plainDelimiters: true, nonceDelimiters: false } },
    { slug: "runtime-responses/vendor/model", policy: "legacy-inline", options: { plainDelimiters: true, nonceDelimiters: false } },
    { slug: "runtime-responses/vendor/preserve", policy: "preserve", options: undefined },
  ]);
  assert.equal(actual.skipped.length, 3);
  assert.ok(actual.skipped.every(([, reason]) => reason.includes("reasoningTagPolicy")));
});
