import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const root = mkdtempSync(path.join(os.tmpdir(), "codex-router-claude-config-"));
const state = path.join(root, "state");
const launcher = path.join(root, "bin", "claude-router");
process.env.MODEL_ROUTER_STATE_DIR = state;
process.env.CODEX_ROUTER_STATE_DIR = state;
process.env.MODEL_ROUTER_CLAUDE_LAUNCHER = launcher;
process.env.MODEL_ROUTER_ALLOW_FOREIGN_STATE = "1";

const { mkdirSync } = await import("node:fs");
mkdirSync(state, { recursive: true });
writeFileSync(path.join(state, "caller-secret"), "test-claude-config-capability-with-sufficient-length\n", { mode: 0o600 });

const {
  claudeCatalogDrift,
  claudeIntegrationStatus,
  publishClaudeIntegration,
  removeClaudeIntegration,
} = await import("../src/claude-code-config-manager.mjs");

test("Claude publication is marker-owned, private, idempotent, and reversible", () => {
  const routedModels = () => ({
    engine: "test",
    models: [
      { slug: "deepseek/test", displayName: "DeepSeek Test", priority: 1 },
      { slug: "openai/gpt-test", displayName: "GPT Test", priority: 9 },
    ],
  });
  const probe = () => ({ available: true, command: "/fake/claude", version: "2.1.235" });
  const first = publishClaudeIntegration({ routedModels, probe });
  const launcherOnce = readFileSync(launcher, "utf8");
  const second = publishClaudeIntegration({ routedModels, probe });
  assert.equal(readFileSync(launcher, "utf8"), launcherOnce);
  assert.equal(first.defaultModel, "codex_router/anthropic/openai/gpt-test");
  assert.deepEqual(second.models.map((model) => model.id), [
    "codex_router/anthropic/deepseek/test",
    "codex_router/anthropic/openai/gpt-test",
  ]);
  const status = claudeIntegrationStatus();
  assert.equal(status.installed, true);
  assert.equal(status.baseUrlManaged, true);
  assert.deepEqual(claudeCatalogDrift({ routedModels }), { missing: [], added: [] });
  removeClaudeIntegration();
  assert.equal(existsSync(launcher), false);
  assert.equal(existsSync(path.join(state, "claude-models.json")), false);
});

test.after(() => rmSync(root, { recursive: true, force: true }));
