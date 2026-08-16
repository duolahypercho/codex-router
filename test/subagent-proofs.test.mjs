import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

// Point the proofs file and the user-model overlay at empty temp state before
// the modules read their paths, the same isolation the registry tests use.
const stateDir = mkdtempSync(path.join(os.tmpdir(), "subagent-proofs-test-"));
process.env.MODEL_ROUTER_SUBAGENT_PROOFS = path.join(stateDir, "multi-agent-proofs.json");
process.env.MODEL_ROUTER_USER_MODELS = path.join(stateDir, "user-models.json");

const {
  applySubagentProofs,
  awaitingSpawnProof,
  clearSubagentProof,
  readSubagentProofs,
  recordProbeResult,
  recordProbeStarted,
  recordSpawnFailure,
  recordSpawnObserved,
  spawnProofRevocable,
  subagentProofSnapshot,
  SUBAGENT_PROOFS_PATH,
} = await import("../src/subagent-proofs.mjs");
const { subagentVerificationCandidates, verifySubagentCandidates } = await import(
  "../src/subagent-verify.mjs"
);

test("a proof walks checking -> experimental -> proven, and failures carry reasons", () => {
  const slug = "example/alpha";
  assert.equal(recordProbeStarted(slug).status, "checking");
  assert.equal(awaitingSpawnProof(slug), false);

  const experimental = recordProbeResult(slug, {
    ok: true,
    checks: [{ name: "tool calling", ok: true }],
  });
  assert.equal(experimental.status, "experimental");
  assert.equal(awaitingSpawnProof(slug), true);

  const proven = recordSpawnObserved(slug, { status: 200 });
  assert.equal(proven.status, "proven");
  assert.equal(awaitingSpawnProof(slug), false);

  const failed = recordSpawnFailure("example/beta", { status: 400 });
  assert.equal(failed.status, "failed");
  assert.match(failed.reason, /400/);

  const probeFailed = recordProbeResult("example/gamma", {
    ok: false,
    checks: [],
    detail: "tool calling: function call missing",
  });
  assert.equal(probeFailed.status, "failed");
  assert.match(probeFailed.reason, /function call missing/);

  clearSubagentProof("example/gamma");
  assert.equal(subagentProofSnapshot()["example/gamma"], undefined);
});

// Issue #257(b): `proven` was terminal, so the oldest observation on the wire
// beat every later one. Promotion is still a one-time event, but the window in
// which evidence can be *taken away* stays open for as long as this machine's
// traffic is what the v2 advertisement rests on.
test("a proven slug stays revocable while an unproven or settled one is untouchable", () => {
  const slug = "example/revocable";
  recordProbeResult(slug, { ok: true, checks: [] });
  assert.equal(spawnProofRevocable(slug), true, "the experimental window is revocable");

  recordSpawnObserved(slug, { status: 200 });
  assert.equal(awaitingSpawnProof(slug), false, "a first clean turn is only news once");
  assert.equal(spawnProofRevocable(slug), true, "promotion must not close the demotion path");

  // The counts that condemned it travel with the record, so `control subagents
  // status` and the tray can say how much of a spawn it took.
  const demoted = recordSpawnFailure(slug, {
    status: 200,
    reason: "one child spawn ran 6 turns without converging",
    turns: 6,
    newInputTokens: 2_100,
  });
  assert.equal(demoted.status, "failed");
  assert.equal(demoted.spawn.turns, 6);
  assert.equal(demoted.spawn.newInputTokens, 2_100);
  assert.equal(
    spawnProofRevocable(slug),
    false,
    "a slug already demoted has nothing left for traffic to take",
  );

  // Nothing local to revoke: a checking slug is not advertised yet, and a
  // registry-v2 model's claim is the shipped native proof, not this machine.
  recordProbeStarted(slug);
  assert.equal(spawnProofRevocable(slug), false);
  assert.equal(spawnProofRevocable("kimi-oauth/k3"), false);
  clearSubagentProof(slug);
});

test("a proofs file that cannot be read promotes nothing", () => {
  const corrupt = path.join(stateDir, "corrupt.json");
  writeFileSync(corrupt, "{not json", { mode: 0o600 });
  assert.deepEqual(readSubagentProofs(corrupt), { version: 1, proofs: {} });
  // Unknown statuses are dropped rather than trusted.
  const invented = path.join(stateDir, "invented.json");
  writeFileSync(
    invented,
    JSON.stringify({ version: 1, proofs: { "x/y": { status: "definitely-v2" } } }),
    { mode: 0o600 },
  );
  assert.deepEqual(readSubagentProofs(invented).proofs, {});
});

test("proof promotion respects demotions and never touches registry claims", () => {
  const models = [
    { slug: "vendor/experimental" },
    { slug: "vendor/proven" },
    { slug: "vendor/failed" },
    { slug: "vendor/checking" },
    { slug: "vendor/hidden" },
    { slug: "vendor/disabled" },
    { slug: "vendor/registry", multiAgentVersion: "v2" },
  ];
  const proofs = {
    "vendor/experimental": { status: "experimental" },
    "vendor/proven": { status: "proven" },
    "vendor/failed": { status: "failed" },
    "vendor/checking": { status: "checking" },
    "vendor/hidden": { status: "proven" },
    "vendor/disabled": { status: "proven" },
  };
  const promoted = applySubagentProofs(models, proofs, {
    hidden: new Set(["vendor/hidden"]),
    disabled: ["vendor/disabled"],
  });
  const bySlug = new Map(promoted.map((model) => [model.slug, model.multiAgentVersion]));
  assert.equal(bySlug.get("vendor/experimental"), "v2");
  assert.equal(bySlug.get("vendor/proven"), "v2");
  assert.equal(bySlug.get("vendor/failed"), undefined);
  assert.equal(bySlug.get("vendor/checking"), undefined);
  assert.equal(bySlug.get("vendor/hidden"), undefined);
  assert.equal(bySlug.get("vendor/disabled"), undefined);
  assert.equal(bySlug.get("vendor/registry"), "v2");
  // No proofs at all is a pass-through, not a rewrite.
  assert.equal(applySubagentProofs(models, {}), models);
});

test("verification skips registry-v2 models, unknown slugs, and settled proofs", () => {
  recordProbeResult("deepseek/deepseek-v4-pro", { ok: true, checks: [] });
  const candidates = subagentVerificationCandidates([
    "kimi-oauth/k3", // registry v2: shipped with the full native proof
    "deepseek/deepseek-v4-pro", // already experimental locally
    "deepseek/deepseek-v4-flash", // real, unproven: the one that needs research
    "not-a/model", // unknown slugs cannot be probed
    "deepseek/deepseek-v4-flash", // duplicates collapse
  ]);
  assert.deepEqual(candidates, ["deepseek/deepseek-v4-flash"]);
  // force re-researches a settled slug.
  assert.ok(
    subagentVerificationCandidates(["deepseek/deepseek-v4-pro"], { force: true }).includes(
      "deepseek/deepseek-v4-pro",
    ),
  );
  clearSubagentProof("deepseek/deepseek-v4-pro");
});

test("verify records the probe's verdict, and a probe crash reads as a failure", async () => {
  const passed = await verifySubagentCandidates(["deepseek/deepseek-v4-flash"], {
    probe: async (slug) => ({ ok: true, checks: [{ name: "tool calling", ok: true, slug }] }),
  });
  assert.equal(passed[0].status, "experimental");
  assert.equal(subagentProofSnapshot()["deepseek/deepseek-v4-flash"].status, "experimental");
  clearSubagentProof("deepseek/deepseek-v4-flash");

  // A probe that never reached the provider proved nothing: it defers and
  // leaves no verdict, instead of writing "incapable" for a socket error.
  const crashed = await verifySubagentCandidates(["deepseek/deepseek-v4-flash"], {
    probe: async () => {
      throw new Error("router unreachable");
    },
  });
  assert.equal(crashed[0].status, "deferred");
  assert.match(crashed[0].reason, /router unreachable/);
  assert.equal(subagentProofSnapshot()["deepseek/deepseek-v4-flash"], undefined);
});

test("the proofs path override is honoured", () => {
  assert.equal(SUBAGENT_PROOFS_PATH, process.env.MODEL_ROUTER_SUBAGENT_PROOFS);
});

test("a wedged 'checking' becomes retryable once it goes stale", () => {
  const slug = "deepseek/deepseek-v4-flash";
  recordProbeStarted(slug);
  const started = Date.parse(subagentProofSnapshot()[slug].startedAt);

  // Fresh checking means a worker is (plausibly) still running: don't stack a
  // second probe on it.
  assert.deepEqual(subagentVerificationCandidates([slug], { now: started + 1_000 }), []);

  // Past the probe ceiling the worker is dead, and the ordinary toggle path
  // must be able to re-probe without knowing about force.
  assert.deepEqual(
    subagentVerificationCandidates([slug], { now: started + 11 * 60_000 }),
    [slug],
  );

  // A checking record with no readable start time is treated as stale, not
  // trusted forever.
  recordProbeStarted(slug, { at: "not-a-timestamp" });
  assert.deepEqual(subagentVerificationCandidates([slug]), [slug]);
  clearSubagentProof(slug);
});

test("a probe that only hit quota or outage defers instead of condemning", async () => {
  const slug = "deepseek/deepseek-v4-flash";
  const deferred = await verifySubagentCandidates([slug], {
    probe: async () => ({
      ok: false,
      checks: [
        { name: "tool calling", ok: false, status: 429, detail: "1-week quota exhausted" },
        { name: "streaming", ok: true, status: 200 },
      ],
      detail: "tool calling: 1-week quota exhausted",
    }),
  });
  assert.equal(deferred[0].status, "deferred");
  // Nothing recorded: the next toggle or sweep researches again.
  assert.equal(subagentProofSnapshot()[slug], undefined);

  // A structural rejection alongside a transient one is still a failure —
  // the 400 answered the capability question even though the 503 did not.
  const condemned = await verifySubagentCandidates([slug], {
    probe: async () => ({
      ok: false,
      checks: [
        { name: "tool calling", ok: false, status: 400, detail: "tool_choice rejected" },
        { name: "streaming", ok: false, status: 503, detail: "upstream flap" },
      ],
      detail: "tool calling: tool_choice rejected",
    }),
  });
  assert.equal(condemned[0].status, "failed");
  clearSubagentProof(slug);
});

test("a plan-entitlement refusal defers every model it gated, condemning none", async () => {
  const slug = "deepseek/deepseek-v4-flash";
  // The Command Code case: the credential authenticates, the plan cannot call
  // the API, and every model behind it answers 403. Thirty models probed on
  // an un-entitled account must not become thirty "incapable" verdicts.
  const gated = await verifySubagentCandidates([slug], {
    probe: async () => ({
      ok: false,
      checks: [
        { name: "tool calling", ok: false, status: 403, detail: "plan does not include the API" },
        { name: "streaming", ok: false, status: 403, detail: "plan does not include the API" },
      ],
      detail: "tool calling: plan does not include the API",
    }),
  });
  assert.equal(gated[0].status, "deferred");
  assert.equal(subagentProofSnapshot()[slug], undefined);
});

// Issue #257: an operator watched "subagent proven: <slug> completed a live
// child turn" and read it as the child finishing the work it was delegated.
// The observer sees one HTTP turn — a child makes one per tool-call round trip
// and the loop stringing them together is Codex's — so the promotion cannot
// mean that, and the line it prints has to scope its own claim. Guarded at the
// source because the wording *is* the fix: nothing else in the process states
// what `proven` promises to the person reading the router log.
test("the subagent promotion log line claims the wire role, not a finished task", () => {
  const source = readFileSync(new URL("../src/router.mjs", import.meta.url), "utf8");
  const start = source.indexOf("function observeSubagentOutcome");
  assert.ok(start > 0, "observeSubagentOutcome moved; re-point this guard at the promotion path");
  // Scoped to the one function, so an unrelated router line cannot satisfy it.
  const body = source.slice(start).split(/\r?\n\}/)[0];
  assert.match(body, /child role verified/);
  assert.match(body, /not a claim the child finished its task/);
  assert.doesNotMatch(
    body,
    /subagent proven/,
    "the promotion line claims more than one observed turn proves",
  );
});
