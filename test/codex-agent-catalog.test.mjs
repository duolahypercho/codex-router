import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  routedAgentDefinition,
  routedCodexAgentStatus,
  syncRoutedCodexAgents,
} from "../src/codex-agent-catalog.mjs";
import { subagentEligibleModels } from "../src/multi-agent-state.mjs";

const kimi = {
  slug: "kimi-oauth/k3",
  displayName: "Kimi K3 (OAuth)",
};

test("routed agent definitions select the router provider and exact model slug", () => {
  const definition = routedAgentDefinition(kimi);
  assert.equal(definition.agentName, "router_kimi_oauth_k3");
  assert.equal(definition.fileName, "router-model-kimi-oauth-k3.toml");
  assert.match(definition.contents, /^# Managed by Codex Router\./);
  assert.match(definition.contents, /model_provider = "codex-router"/);
  assert.match(definition.contents, /model = "kimi-oauth\/k3"/);
});

test("agent sync writes one private definition for every routed model", () => {
  const agentsDir = mkdtempSync(path.join(os.tmpdir(), "codex-router-agents-"));
  const grok = { slug: "grok-oauth/grok-4.5", displayName: "Grok 4.5 (OAuth)" };
  const { written, removed } = syncRoutedCodexAgents([kimi, grok], agentsDir);

  assert.deepEqual(removed, []);
  assert.deepEqual(
    written.map(({ model, agent }) => ({ model, agent })),
    [
      { model: "kimi-oauth/k3", agent: "router_kimi_oauth_k3" },
      { model: "grok-oauth/grok-4.5", agent: "router_grok_oauth_grok_4_5" },
    ],
  );
  const kimiFile = path.join(agentsDir, "router-model-kimi-oauth-k3.toml");
  assert.match(readFileSync(kimiFile, "utf8"), /name = "router_kimi_oauth_k3"/);
  assert.deepEqual(routedCodexAgentStatus([kimi, grok], agentsDir), {
    expected: 2,
    current: 2,
    missing: [],
    stale: [],
    unprotected: [],
    extra: [],
    ok: true,
  });
});

test("agent status reports definitions that have not been installed", () => {
  const agentsDir = mkdtempSync(path.join(os.tmpdir(), "codex-router-agents-"));
  assert.deepEqual(routedCodexAgentStatus([kimi], agentsDir), {
    expected: 1,
    current: 0,
    missing: ["kimi-oauth/k3"],
    stale: [],
    unprotected: [],
    extra: [],
    ok: false,
  });
});

test("agent definitions reject non-routed model slugs", () => {
  assert.throws(() => routedAgentDefinition({ slug: "gpt-5.6-sol" }), /invalid model slug/);
});

test("a model switched off as a subagent loses its definition", () => {
  const agentsDir = mkdtempSync(path.join(os.tmpdir(), "codex-router-agents-"));
  const grok = { slug: "grok-oauth/grok-4.5", displayName: "Grok 4.5 (OAuth)" };
  syncRoutedCodexAgents([kimi, grok], agentsDir);

  const { written, removed } = syncRoutedCodexAgents([kimi], agentsDir);
  assert.deepEqual(
    written.map(({ model }) => model),
    ["kimi-oauth/k3"],
  );
  assert.deepEqual(removed, ["router-model-grok-oauth-grok-4-5.toml"]);
  assert.deepEqual(readdirSync(agentsDir), ["router-model-kimi-oauth-k3.toml"]);
});

test("agent sync leaves definitions it does not manage alone", () => {
  const agentsDir = mkdtempSync(path.join(os.tmpdir(), "codex-router-agents-"));
  writeFileSync(path.join(agentsDir, "reviewer.toml"), 'name = "reviewer"\n');
  syncRoutedCodexAgents([kimi], agentsDir);

  const { removed } = syncRoutedCodexAgents([], agentsDir);
  assert.deepEqual(removed, ["router-model-kimi-oauth-k3.toml"]);
  assert.deepEqual(readdirSync(agentsDir), ["reviewer.toml"]);
});

test("agent status reports a definition left behind by an older install", () => {
  const agentsDir = mkdtempSync(path.join(os.tmpdir(), "codex-router-agents-"));
  syncRoutedCodexAgents([kimi], agentsDir);

  const status = routedCodexAgentStatus([], agentsDir);
  assert.deepEqual(status.extra, ["router-model-kimi-oauth-k3.toml"]);
  assert.equal(status.ok, false);
});

test("an install with every model switched off is a clean state", () => {
  const agentsDir = mkdtempSync(path.join(os.tmpdir(), "codex-router-agents-"));
  const status = routedCodexAgentStatus([], agentsDir);
  assert.deepEqual(status.extra, []);
  assert.equal(status.ok, true);
});

test("only an explicit switch off withholds a definition", () => {
  const models = [
    { slug: "kimi-oauth/k3" },
    { slug: "grok-oauth/grok-4.5" },
    { slug: "deepseek/deepseek-v4-flash" },
  ];
  // Settings that name nothing leave every model eligible, which is what an
  // install that has never opened the subagent settings looks like.
  assert.deepEqual(
    subagentEligibleModels(models, { mode: "proven", enabled: [], disabled: [] }).map(
      ({ slug }) => slug,
    ),
    ["kimi-oauth/k3", "grok-oauth/grok-4.5", "deepseek/deepseek-v4-flash"],
  );
  assert.deepEqual(
    subagentEligibleModels(models, {
      mode: "all",
      enabled: [],
      disabled: ["deepseek/deepseek-v4-flash"],
    }).map(({ slug }) => slug),
    ["kimi-oauth/k3", "grok-oauth/grok-4.5"],
  );
});
