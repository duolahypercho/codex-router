import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";

// Point the proofs file and the user-model overlay at empty temp state before
// the modules read their paths, the same isolation the registry tests use.
const stateDir = mkdtempSync(path.join(os.tmpdir(), "subagent-proofs-test-"));
process.env.MODEL_ROUTER_SUBAGENT_PROOFS = path.join(stateDir, "multi-agent-proofs.json");
process.env.MODEL_ROUTER_USER_MODELS = path.join(stateDir, "user-models.json");
after(() => rmSync(stateDir, { recursive: true, force: true }));

const {
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

test("a compatibility check walks checking -> candidate, while only legacy records retain proven", () => {
  const slug = "example/alpha";
  assert.equal(recordProbeStarted(slug).status, "checking");
  assert.equal(awaitingSpawnProof(slug), false);

  const candidate = recordProbeResult(slug, {
    ok: true,
    checks: [{ name: "tool calling", ok: true }],
  });
  assert.equal(candidate.status, "candidate");
  assert.equal(awaitingSpawnProof(slug), false);

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

test("a candidate never supplies a locally revocable v2 claim", () => {
  const slug = "example/revocable";
  recordProbeResult(slug, { ok: true, checks: [] });
  assert.equal(spawnProofRevocable(slug), false);

  recordSpawnObserved(slug, { status: 200 });
  assert.equal(awaitingSpawnProof(slug), false);
  assert.equal(spawnProofRevocable(slug), false);

  // The counts that rejected it travel with the record, so `control subagents
  // status` and the tray can say how much of a spawn it took.
  const rejected = recordSpawnFailure(slug, {
    status: 200,
    reason: "one child spawn ran 6 turns without converging",
    turns: 6,
    newInputTokens: 2_100,
  });
  assert.equal(rejected.status, "failed");
  assert.equal(rejected.spawn.turns, 6);
  assert.equal(rejected.spawn.newInputTokens, 2_100);
  assert.equal(
    spawnProofRevocable(slug),
    false,
    "a local record has nothing to take from a repository v2 claim",
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

test("historical verified records remain readable diagnostics without being re-probed", () => {
  const slug = "deepseek/deepseek-v4-flash";
  const record = { status: "verified", checks: { markerReturn: { outcome: "pass" } } };
  writeFileSync(SUBAGENT_PROOFS_PATH, JSON.stringify({ version: 1, proofs: { [slug]: record } }));
  assert.deepEqual(subagentProofSnapshot()[slug], record);
  assert.deepEqual(subagentVerificationCandidates([slug]), []);
  assert.deepEqual(subagentVerificationCandidates([slug], { force: true }), [slug]);
  clearSubagentProof(slug);
});

test("verification skips reviewed v1/v2 models, unknown slugs, and settled candidates", () => {
  recordProbeResult("deepseek/deepseek-v4-pro", { ok: true, checks: [] });
  const candidates = subagentVerificationCandidates([
    "kimi-oauth/k3", // registry v2: shipped with the full native proof
    "deepseek/deepseek-v4-pro", // already a settled local candidate
    "deepseek/deepseek-v4-flash", // real, unproven: the one that needs research
    "not-a/model", // unknown slugs cannot be probed
    "deepseek/deepseek-v4-flash", // duplicates collapse
  ]);
  assert.deepEqual(candidates, ["deepseek/deepseek-v4-flash"]);
  // force may retry a candidate, but never a reviewed registry v1/v2 verdict.
  assert.ok(subagentVerificationCandidates(["deepseek/deepseek-v4-pro"], { force: true }).includes("deepseek/deepseek-v4-pro"));
  clearSubagentProof("deepseek/deepseek-v4-pro");
});

test("verify records the probe's verdict, and a probe crash reads as a failure", async () => {
  const passed = await verifySubagentCandidates(["deepseek/deepseek-v4-flash"], {
    probe: async (slug) => ({ ok: true, checks: [{ name: "tool calling", ok: true, slug }] }),
  });
  assert.equal(passed[0].status, "candidate");
  assert.equal(subagentProofSnapshot()["deepseek/deepseek-v4-flash"].status, "candidate");
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

// Historical child traffic remains useful application evidence, but the log
// must say it is diagnostic rather than implying a local v2 promotion or a
// finished delegated task.
test("the legacy child-observation log does not claim local v2 authority", () => {
  const source = readFileSync(new URL("../src/router.mjs", import.meta.url), "utf8");
  const start = source.indexOf("function observeSubagentOutcome");
  assert.ok(start > 0, "observeSubagentOutcome moved; re-point this guard at the observation path");
  // Scoped to the one function, so an unrelated router line cannot satisfy it.
  const body = source.slice(start).split(/\r?\n\}/)[0];
  assert.match(body, /legacy subagent evidence observed/);
  assert.match(body, /remains diagnostic and is not a repository v2 certificate/);
  assert.doesNotMatch(
    body,
    /subagent (?:proven|promoted)/,
    "the observation line must not claim local registry authority",
  );
});
