import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
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
  assert.match(definition.contents, /cite the exact file and line/);
  assert.match(definition.contents, /Before claiming that something is absent/);
  assert.match(definition.contents, /Never invent or reuse a stale name/);
  assert.match(definition.contents, /Do not stop after merely announcing a next action/);
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

test("only registry-proven models receive routed agent definitions", () => {
  const models = [
    { slug: "kimi-oauth/k3", multiAgentVersion: "v2" },
    { slug: "grok-oauth/grok-4.5", multiAgentVersion: "v2" },
    { slug: "deepseek/deepseek-v4-flash" },
  ];
  assert.deepEqual(
    subagentEligibleModels(models, { mode: "proven", enabled: [], disabled: [] }).map(
      ({ slug }) => slug,
    ),
    ["kimi-oauth/k3", "grok-oauth/grok-4.5"],
  );
  assert.deepEqual(
    subagentEligibleModels(models, {
      mode: "all",
      enabled: [],
      disabled: ["grok-oauth/grok-4.5"],
    }).map(({ slug }) => slug),
    ["kimi-oauth/k3"],
  );
});

test("a configured subagent effort rides along in the agent definition", () => {
  const withEffort = routedAgentDefinition(kimi, { effort: "max" });
  assert.match(withEffort.contents, /^model_reasoning_effort = "max"$/m);

  const withoutEffort = routedAgentDefinition(kimi);
  assert.equal(
    /model_reasoning_effort/.test(withoutEffort.contents),
    false,
    "an unset effort must not freeze the model's own default into the file",
  );
});

// A configured subagent effort is written into the definition, so the drift
// check has to expect it too. It did not, and the two disagreed by exactly the
// `model_reasoning_effort` line: doctor reported the agent `stale`, `--fix`
// republished byte-identical contents, and the next check said `stale` again —
// for as long as the effort stayed set (#804).
//
// `MULTI_AGENT_STATE_PATH` is resolved when `multi-agent-state.mjs` loads, so
// this runs in a child with the state directory set from the start. Reading the
// operator's own settings here is what let this defect hide: the assertion
// passed or failed depending on whether the machine running it happened to have
// an effort configured.
test("a configured subagent effort round-trips through sync and status", () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const testRoot = mkdtempSync(path.join(os.tmpdir(), "codex-router-agent-effort-"));
  const stateDir = path.join(testRoot, "state");
  const codexHome = path.join(testRoot, "codex");
  const agentsDir = path.join(codexHome, "agents");

  const stateModule = pathToFileURL(path.join(root, "src/multi-agent-state.mjs")).href;
  const catalogModule = pathToFileURL(path.join(root, "src/codex-agent-catalog.mjs")).href;
  const script = `
    import { mkdirSync } from "node:fs";
    mkdirSync(process.env.CODEX_ROUTER_STATE_DIR, { recursive: true });
    mkdirSync(${JSON.stringify(agentsDir)}, { recursive: true });
    const { setSubagentEffort } = await import(${JSON.stringify(stateModule)});
    const { syncRoutedCodexAgents, routedCodexAgentStatus } =
      await import(${JSON.stringify(catalogModule)});
    const model = { slug: "grok-oauth/grok-4.5", displayName: "Grok 4.5 (OAuth)" };
    setSubagentEffort(model.slug, "medium");
    syncRoutedCodexAgents([model], ${JSON.stringify(agentsDir)});
    process.stdout.write(JSON.stringify(
      routedCodexAgentStatus([model], ${JSON.stringify(agentsDir)}),
    ));
  `;
  const output = execFileSync(process.execPath, ["--input-type=module", "-e", script], {
    encoding: "utf8",
    env: {
      ...process.env,
      CODEX_ROUTER_STATE_DIR: stateDir,
      CODEX_HOME: codexHome,
      MODEL_ROUTER_MULTI_AGENT_STATE: path.join(stateDir, "multi-agent-settings.json"),
    },
  });

  const status = JSON.parse(output);
  assert.equal(status.ok, true, `an effort-configured agent must not read as drifted: ${output}`);
  assert.deepEqual(status.stale, []);
  assert.equal(status.current, 1);
  // ...and the effort really is in the file Codex spawns, not merely agreed on.
  assert.match(
    readFileSync(path.join(agentsDir, "router-model-grok-oauth-grok-4-5.toml"), "utf8"),
    /model_reasoning_effort = "medium"/,
  );
});
