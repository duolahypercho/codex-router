import assert from "node:assert/strict";
import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { privateFileIsProtected } from "../src/file-security.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const callbackSourcePath = path.join(root, "src", "grok_service_tier_callback.py");
const callbackSource = readFileSync(callbackSourcePath);
const cleanupCallbackSource = readFileSync(path.join(root, "src", "litellm_stream_cleanup_callback.py"));

// Keep the checked-in registry isolated from the machine's curated models and
// never write the live gateway config. An explicit target is the contract this
// file owns; the default STATE_DIR path stays unused.
const testRoot = mkdtempSync(path.join(os.tmpdir(), "grok-fast-config-"));
process.env.MODEL_ROUTER_USER_MODELS = path.join(testRoot, "user-models.json");
process.env.MODEL_ROUTER_STATE_DIR = path.join(testRoot, "state");

const { renderLiteLlmConfig, writeLiteLlmConfig } = await import("../src/litellm-config.mjs");
const { MODEL_BY_SLUG } = await import("../src/model-registry.mjs");
const { routedModel } = await import("../src/catalog.mjs");

const CALLBACK_NAME = "grok_service_tier_callback.py";
const CALLBACK_REF = "grok_service_tier_callback.grok_service_tier_callback";
const CLEANUP_NAME = "litellm_stream_cleanup_callback.py";
const CLEANUP_REF = "litellm_stream_cleanup_callback.stream_cleanup_callback";

function withScratch(run) {
  const scratch = mkdtempSync(path.join(os.tmpdir(), "grok-fast-config-write-"));
  try {
    return run(scratch);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

function leftoverTemps(directory) {
  const found = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const fullPath = path.join(directory, entry.name);
    if (entry.name.includes(".tmp.")) found.push(fullPath);
    if (entry.isDirectory()) found.push(...leftoverTemps(fullPath));
  }
  return found;
}

function assertPrivateFile(target) {
  if (process.platform === "win32") {
    assert.equal(privateFileIsProtected(target), true, `${target} must be owner-only`);
    return;
  }
  assert.equal(statSync(target).mode & 0o777, 0o600, `${target} must be 0600`);
}

function publishedCallbackAndYaml(scratch) {
  const gatewayDir = path.join(scratch, "gateway");
  const target = path.join(gatewayDir, "litellm.yaml");
  const sibling = path.join(scratch, "keep-me.txt");
  writeFileSync(sibling, "leave this file alone\n");
  writeLiteLlmConfig(target);
  return {
    gatewayDir,
    target,
    sibling,
    callbackPath: path.join(gatewayDir, CALLBACK_NAME),
    cleanupPath: path.join(gatewayDir, CLEANUP_NAME),
  };
}

test.after(() => {
  rmSync(testRoot, { recursive: true, force: true });
});

// The baseline wrote YAML only. Verify publication and permissions of the new
// sibling callbacks, including repeated writes without leftover temporary files.
test("writeLiteLlmConfig publishes the repository callback privately beside generated YAML", () => {
  withScratch((scratch) => {
    const first = publishedCallbackAndYaml(scratch);
    const yaml = readFileSync(first.target);
    const publishedCallback = readFileSync(first.callbackPath);

    assert.equal(first.target, path.join(first.gatewayDir, "litellm.yaml"));
    assert.equal(yaml.toString("utf8"), renderLiteLlmConfig());
    assert.ok(yaml.toString("utf8").includes(`callbacks: [${CALLBACK_REF}, ${CLEANUP_REF}]`));
    assert.equal(Buffer.compare(publishedCallback, callbackSource), 0);
    assert.deepEqual(readdirSync(first.gatewayDir).sort(), [CALLBACK_NAME, CLEANUP_NAME, "litellm.yaml"].sort());
    assert.deepEqual(leftoverTemps(scratch), []);
    assert.equal(readFileSync(first.sibling, "utf8"), "leave this file alone\n");
    assertPrivateFile(first.target);
    assertPrivateFile(first.callbackPath);
    assertPrivateFile(first.cleanupPath);
    assert.equal(Buffer.compare(readFileSync(first.cleanupPath), cleanupCallbackSource), 0);
    if (process.platform !== "win32") {
      assert.equal(statSync(first.gatewayDir).mode & 0o777, 0o700);
    }

    writeLiteLlmConfig(first.target);
    assert.equal(Buffer.compare(readFileSync(first.callbackPath), callbackSource), 0);
    assert.equal(readFileSync(first.target, "utf8"), yaml.toString("utf8"));
    assert.deepEqual(readdirSync(first.gatewayDir).sort(), [CALLBACK_NAME, CLEANUP_NAME, "litellm.yaml"].sort());
    assert.deepEqual(leftoverTemps(scratch), []);
    assertPrivateFile(first.target);
    assertPrivateFile(first.callbackPath);
    assertPrivateFile(first.cleanupPath);
    assert.equal(Buffer.compare(readFileSync(first.cleanupPath), cleanupCallbackSource), 0);
  });
});

test("rendered catalog keeps Fast opt-in on grok-oauth/grok-4.6 and leaves Grok 4.5 unchanged", () => {
  const nativeTemplate = {
    slug: "gpt-5.5",
    display_name: "GPT-5.5",
    description: "Native template",
    priority: 10,
    visibility: "list",
    base_instructions: "You are Codex.",
    default_service_tier: "priority",
  };
  const grok46 = routedModel(nativeTemplate, MODEL_BY_SLUG.get("grok-oauth/grok-4.6"));
  assert.deepEqual(grok46.service_tiers, [{ id: "priority", name: "Fast", description: "Use priority processing when available." }]);
  assert.equal(grok46.default_service_tier, null);

  const grok45 = routedModel(nativeTemplate, MODEL_BY_SLUG.get("grok-oauth/grok-4.5"));
  assert.deepEqual(grok45.service_tiers, []);
  assert.equal(grok45.default_service_tier, null);
});

// Compaction reaches the Grok deployment without streaming, where LiteLLM
// applies `timeout` rather than `stream_timeout`. Both must outlast the router's
// stall guard, and no other deployment may pick up either bound.
test("Grok deployments bound non-streaming calls like streams and other deployments keep the global timeout", () => {
  const blocks = renderLiteLlmConfig().split("\n  - model_name: ").slice(1);
  const grok = blocks.find((block) => block.startsWith('"grok-oauth-grok-4-6"'));
  assert.ok(grok, "the grok-oauth/grok-4.6 deployment is rendered");
  assert.match(grok, /\n {6}stream_timeout: 660\n/);
  assert.match(grok, /\n {6}timeout: 660\n/);

  const others = blocks.filter((block) => !block.includes("stream_timeout"));
  assert.ok(others.length > 0, "a non-Grok deployment is rendered");
  for (const block of others) assert.doesNotMatch(block, /\n {6}timeout: /);
});
