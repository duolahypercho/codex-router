import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

// A test that isolates the state directory must isolate CODEX_HOME with it:
// the agents directory is $CODEX_HOME/agents, and a scratch state pointed at a
// real home would let a publish prune the operator's own agent definitions.
const testRoot = mkdtempSync(path.join(os.tmpdir(), "subagent-explain-test-"));
process.env.CODEX_ROUTER_STATE_DIR = path.join(testRoot, "state");
process.env.CODEX_HOME = path.join(testRoot, "codex");
mkdirSync(process.env.CODEX_ROUTER_STATE_DIR, { recursive: true });
mkdirSync(path.join(process.env.CODEX_HOME, "agents"), { recursive: true });

const { explainSubagentRoute, formatSubagentExplanation } = await import(
  "../src/subagent-explain.mjs"
);
const { setSubagentEffort } = await import("../src/multi-agent-state.mjs");

const ROUTE = {
  slug: "opencode-go/deepseek-v4.1-flash",
  provider: "opencode-go",
  displayName: "DeepSeek V4.1 Flash",
};
const CERTIFIED = {
  slug: "kimi-oauth/k3",
  provider: "kimi-oauth",
  displayName: "Kimi K3",
  multiAgentVersion: "v2",
};
const MODELS = [ROUTE, CERTIFIED];

const selected = { version: 2, mode: "selected", enabled: [ROUTE.slug], disabled: [] };
const agentsDir = path.join(process.env.CODEX_HOME, "agents");

function explain(overrides = {}) {
  return explainSubagentRoute({
    slug: ROUTE.slug,
    models: MODELS,
    settings: selected,
    proofs: {},
    // No agentsDir by default: the definition check is exercised on its own.
    ...overrides,
  });
}

const codes = (explanation) => explanation.blockers.map((entry) => entry.code);
const noteCodes = (explanation) => explanation.notes.map((entry) => entry.code);

test("a selected route with an enabled provider is spawnable, under its agent name", () => {
  const result = explain();
  assert.equal(result.spawnable, true);
  assert.deepEqual(result.blockers, []);
  // The name Codex spawns by, which is the thing an operator actually needs.
  assert.equal(result.agentName, "router_opencode_go_deepseek_v4_1_flash");
});

test("an unknown slug says which half is wrong", () => {
  // A typo in the model, under a provider that exists, is a different problem
  // from a slug nothing recognizes -- and "Unknown model slug" says neither.
  const typo = explain({ slug: "opencode-go/not-a-real-model" });
  assert.deepEqual(codes(typo), ["unknown_route"]);
  assert.match(typo.blockers[0].summary, /opencode-go is a known provider/);
  assert.match(typo.blockers[0].fix, /curate-models opencode-go/);

  const nothing = explain({ slug: "nope/nope" });
  assert.deepEqual(codes(nothing), ["unknown_route"]);
  assert.match(nothing.blockers[0].summary, /not a routed model this install knows/);

  // A native slug is the common mistake this feature exists to catch: #804
  // asks for a *router* model as a subagent, and Codex's own models are not
  // reached this way.
  const native = explain({ slug: "gpt-6-astra" });
  assert.deepEqual(codes(native), ["unknown_route"]);
  assert.match(native.blockers[0].fix, /never a native one/);
});

test("a disabled provider is named before anything else", () => {
  const result = explain({ providerEnabled: () => false });
  assert.equal(result.spawnable, false);
  assert.equal(codes(result)[0], "provider_disabled");
  assert.match(result.blockers[0].fix, /providers enable opencode-go/);
});

test("hidden is reported ahead of selection, because hidden wins", () => {
  // Reporting "not selected" first would send the operator to a switch that
  // cannot take effect while the model is hidden.
  const result = explain({
    hidden: new Set([ROUTE.slug]),
    settings: { version: 2, mode: "all", enabled: [], disabled: [] },
  });
  assert.equal(codes(result)[0], "model_hidden");
  assert.match(result.blockers[0].fix, /picker set opencode-go\/deepseek-v4\.1-flash show/);
});

test("an explicit off is reported as beating every mode", () => {
  const result = explain({
    settings: { version: 2, mode: "all", enabled: [], disabled: [ROUTE.slug] },
  });
  assert.deepEqual(codes(result), ["explicitly_off"]);
  assert.match(result.blockers[0].summary, /beats every mode/);
});

test("proven mode explains itself rather than saying only 'not selected'", () => {
  const result = explain({
    settings: { version: 2, mode: "proven", enabled: [], disabled: [] },
  });
  assert.deepEqual(codes(result), ["not_selected"]);
  assert.match(result.blockers[0].summary, /only routes the registry certified/);
  assert.match(result.blockers[0].fix, /subagents set .* on/);
});

test("a promoted route with no definition on disk is the 'switch did nothing' case", () => {
  // Codex spawns by name out of the agents directory. Promotion in state with
  // no file there is exactly how turning the switch on looks like a no-op.
  const result = explain({ agentsDir });
  assert.deepEqual(codes(result), ["agent_definition_missing"]);
  assert.match(result.blockers[0].fix, /catalog\.mjs/);
  assert.match(result.blockers[0].fix, /quit and reopen Codex/);
  assert.equal(result.agentName, null, "a route that cannot be spawned has no usable agent name");

  writeFileSync(
    path.join(agentsDir, "router-model-opencode-go-deepseek-v4-1-flash.toml"),
    "# Managed by Codex Router.\n",
  );
  assert.equal(explain({ agentsDir }).spawnable, true);
});

test("blockers are ordered so the first fix unblocks the rest", () => {
  const result = explain({
    providerEnabled: () => false,
    hidden: new Set([ROUTE.slug]),
    settings: { version: 2, mode: "selected", enabled: [], disabled: [ROUTE.slug] },
  });
  assert.deepEqual(codes(result), ["provider_disabled", "model_hidden", "explicitly_off"]);
});

// #804 asks for "a clear explanation when a model requires additional
// compatibility or collaboration certification", and explicitly does not ask
// for an uncertified model to be treated silently as a native v2 subagent.
test("selection is reported as intent, never as certification", () => {
  const result = explain();
  assert.deepEqual(noteCodes(result), ["selected_not_certified"]);
  assert.match(result.notes[0].summary, /statement of intent/);
  assert.match(result.notes[0].summary, /Streaming and tool calls do not prove delegation/);
  assert.match(result.notes[0].fix, /subagents certify/);
  assert.match(result.notes[0].fix, /spends real quota/);
});

test("a registry-certified route says so instead", () => {
  const result = explain({
    slug: CERTIFIED.slug,
    settings: { version: 2, mode: "proven", enabled: [], disabled: [] },
  });
  assert.equal(result.spawnable, true);
  assert.deepEqual(noteCodes(result), ["certified_in_registry"]);
});

test("a locally verified route is distinguished from a selected one", () => {
  const result = explain({
    proofs: { [ROUTE.slug]: { verified: true } },
  });
  assert.deepEqual(noteCodes(result), ["verified_locally"]);
});

test("an effort off the model's ladder is flagged without blocking the spawn", () => {
  setSubagentEffort(ROUTE.slug, "ultra");
  const result = explain({ agentsDir, reasoningLevels: ["low", "high", "max"] });
  // The turn still runs; the provider is the thing that refuses the rung. So
  // this is a note, not a blocker.
  assert.equal(result.spawnable, true);
  assert.ok(noteCodes(result).includes("effort_unsupported"));
  assert.equal(result.effort.configured, "ultra");
  assert.deepEqual(result.effort.supported, ["low", "high", "max"]);

  setSubagentEffort(ROUTE.slug, "high");
  const ok = explain({ agentsDir, reasoningLevels: ["low", "high", "max"] });
  assert.equal(ok.notes.some((note) => note.code === "effort_unsupported"), false);

  // An unknown ladder cannot contradict anything, so nothing is claimed.
  const unknown = explain({ agentsDir, reasoningLevels: [] });
  assert.equal(unknown.notes.some((note) => note.code === "effort_unsupported"), false);

  setSubagentEffort(ROUTE.slug, undefined);
});

test("the prose form names the fix, not the machinery", () => {
  const text = formatSubagentExplanation(explain({
    settings: { version: 2, mode: "proven", enabled: [], disabled: [] },
  }));
  assert.match(text, /cannot be spawned as a subagent/);
  assert.match(text, /subagents set opencode-go\/deepseek-v4\.1-flash on/);
  // Rule 7 of docs/SUBAGENT-CERTIFICATION.md: the reader should not need to
  // know what "v2" or "the relay" mean to act on this.
  assert.doesNotMatch(text, /multiAgentVersion|v2_agent|encryptedRelay/);
});

test("a spawnable route says how to change its child reasoning depth", () => {
  const text = formatSubagentExplanation(explain({ agentsDir }));
  assert.match(text, /can be spawned as a subagent/);
  assert.match(text, /subagents effort opencode-go\/deepseek-v4\.1-flash <level>/);
});
