import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { prepareRoutingChoice, replayRouting } from "../scripts/worker-routing-replay.mjs";

const profiles = [
  { id: "codex-low", harness: "codex", model: "fixture-codex", effort: "low", description: "Simple bounded work" },
  { id: "codex-high", harness: "codex", model: "fixture-codex", effort: "high", description: "Harder work on the same model" },
  { id: "codex-large", harness: "codex", model: "fixture-larger", effort: "high", description: "Complex investigation" },
  { id: "claude-high", harness: "claude", model: "fixture-claude", effort: "high", description: "Independent review" },
];
const answer = (choice, cost) => ({ answers: { route: { type: "choice", choice, confidence: 0.8 } }, ...(cost === undefined ? {} : { usage: { cost } }) });
const step = (id, overrides = {}) => ({
  id, taskId: "task-1", sessionId: "session-1", boundary: "task",
  taskSummary: "Synthetic task", stepSummary: "Synthetic request", outcome: "accepted",
  ...overrides,
});
const campaign = (policy, steps, overrides = {}) => ({
  evidence: "synthetic", policy, profiles, initialProfileId: "codex-low", steps, ...overrides,
});

test("fixed replay uses the configured route without consulting answers", () => {
  const report = replayRouting(campaign("fixed", [step("one", { answer: answer("not-approved") })]));
  assert.equal(report.rows[0].profileId, "codex-low");
  assert.equal(report.simulatedDecisions, 0);
  assert.equal(report.simulatedWorkerAttempts, 1);
  assert.equal(report.liveRequests, 0);
  assert.equal(report.measurements.jevCostUsd, 0);
  assert.equal(report.measurements.subscriptionCostUsd, null);
});

test("effort-only replay changes effort while preserving model and session", () => {
  const report = replayRouting(campaign("effort-only", [
    step("one", { answer: answer("codex-low") }),
    step("two", { boundary: "request", answer: answer("codex-high") }),
  ]));
  assert.deepEqual(report.rows.map(({ model, effort, sessionId }) => [model, effort, sessionId]), [
    ["fixture-codex", "low", "session-1"], ["fixture-codex", "high", "session-1"],
  ]);
  assert.equal(report.simulatedDecisions, 2);
  assert.equal(report.measurements.jevCostUsd, null);
});

test("task routing pins the model within a task and requires a fresh session and handover across harnesses", () => {
  const report = replayRouting(campaign("task-boundary", [
    step("one", { answer: answer("codex-low") }),
    step("two", { boundary: "request", answer: answer("codex-high") }),
    step("three", { taskId: "task-2", sessionId: "session-2", answer: answer("claude-high"), handoverSummary: "Review the supplied synthetic result" }),
  ]));
  assert.equal(report.rows[2].harness, "claude");
  assert.equal(report.rows[2].sessionId, "session-2");
  assert.equal(report.rows[2].handoverSupplied, true);
  assert.deepEqual(report.rows[1].requestOptions, { model: "fixture-codex", reasoning: { effort: "high" } });
  assert.deepEqual(report.rows[2].requestOptions, { model: "fixture-claude", effort: "high" });
  for (const change of [
    { boundary: "request", answer: answer("codex-large") },
    { boundary: "request", answer: answer("claude-high") },
    { taskId: "task-2", sessionId: "session-1", answer: answer("claude-high"), handoverSummary: "provided" },
    { taskId: "task-2", sessionId: "session-2", answer: answer("claude-high") },
  ]) {
    assert.throws(() => replayRouting(campaign("task-boundary", [step("one", { answer: answer("codex-low") }), step("two", change)])));
  }
});

test("a task boundary cannot be forged to switch model within the same task", () => {
  assert.throws(() => replayRouting(campaign("task-boundary", [
    step("one", { answer: answer("codex-low") }),
    step("two", { answer: answer("codex-large") }),
  ])), /boundary/);
});

test("Choice preparation uses the documented Decisions shape and an explicit state allowlist", () => {
  const prepared = prepareRoutingChoice(campaign("effort-only", []), step("one", {
    transcript: "private transcript", token: "private token",
  }));
  assert.equal(prepared.request.model, "openrouter-decisions/jev-latest");
  assert.equal(prepared.request.questions.route.type, "choice");
  assert.deepEqual(Object.keys(prepared.request.questions.route.criteria), ["codex-low", "codex-high"]);
  assert.equal(prepared.request.state.taskSummary, "Synthetic task");
  assert.equal(JSON.stringify(prepared).includes("private"), false);
});

test("Choice preparation rejects missing and overlong context before routing", () => {
  for (const taskSummary of [undefined, "", "x".repeat(2001)]) {
    assert.throws(() => prepareRoutingChoice(campaign("effort-only", []), step("one", { taskSummary })), /task summary/);
  }
  for (const stepSummary of [undefined, "", "x".repeat(2001)]) {
    assert.throws(() => prepareRoutingChoice(campaign("effort-only", []), step("one", { stepSummary })), /step summary/);
  }
});

test("invalid, missing, out-of-policy and failed Jev answers stop the replay", () => {
  for (const invalid of [undefined, {}, { answers: [] }, answer("unavailable"), answer("claude-high"),
    { answers: { route: { type: "score", choice: "codex-low" } } },
    { answers: { route: { type: "choice", choice: ["codex-low", "codex-high"] } } },
    { ...answer("codex-low"), error: { message: "failed" } },
    { answers: { route: { type: "choice", choice: "codex-low", confidence: 2 } } },
  ]) {
    assert.throws(() => replayRouting(campaign("effort-only", [step("one", { answer: invalid })])), /Choice/);
  }
});

test("invalid configuration, duplicate attempts and session reuse across tasks are rejected", () => {
  for (const overrides of [
    { policy: "automatic" }, { initialProfileId: "missing" }, { evidence: "measured-savings" },
    { profiles: [...profiles, profiles[0]] }, { profiles: [{ ...profiles[0], harness: "openrouter" }] },
    { profiles: [{ ...profiles[0], effort: "unsupported" }] },
    { profiles: [{ ...profiles[0], model: "--fallback-model" }] },
  ]) assert.throws(() => replayRouting(campaign("fixed", [step("one")], overrides)));
  assert.throws(() => replayRouting(campaign("fixed", [step("one"), step("one", { boundary: "request" })])), /Duplicate/);
  assert.throws(() => replayRouting(campaign("fixed", [step("one"), step("two", { boundary: "in-flight" })])), /boundary/);
  assert.throws(() => replayRouting(campaign("fixed", [step("one"), step("two", { boundary: "request", sessionId: "other" })])), /session/);
});

test("accounting includes rejected and failed work, keeps missing data unknown, and weights cache by tokens", () => {
  const report = replayRouting(campaign("effort-only", [
    step("one", { answer: answer("codex-low", 0.001), metrics: { durationMs: 20, inputTokens: 100, cachedInputTokens: 80 } }),
    step("two", { boundary: "request", answer: answer("codex-high", 0.002), outcome: "rejected", metrics: { durationMs: 30, inputTokens: 300, cachedInputTokens: 120 } }),
    step("three", { boundary: "request", answer: answer("codex-low", 0.003), outcome: "failed", metrics: { durationMs: 40, inputTokens: 100, cachedInputTokens: 0 } }),
  ]));
  assert.deepEqual(report.outcomes, { accepted: 1, rejected: 1, failed: 1, cancelled: 0 });
  assert.equal(report.simulatedWorkerAttempts, 3);
  assert.equal(report.measurements.totalDurationMs, 90);
  assert.equal(report.measurements.cacheHitRate, 0.4);
  assert.equal(report.measurements.jevCostUsd, 0.006);
  const unknown = replayRouting(campaign("fixed", [step("one")]));
  assert.equal(unknown.measurements.cacheHitRate, null);
  assert.equal(unknown.measurements.totalDurationMs, null);
  assert.throws(() => replayRouting(campaign("fixed", [step("one", { metrics: { inputTokens: 10, cachedInputTokens: 11 } })])), /cached/);
  assert.throws(() => replayRouting(campaign("fixed", [step("one", { outcome: "transport-ok" })])), /outcome/);
});

test("negative recorded cost and duration cannot masquerade as valid measurements", () => {
  assert.throws(() => replayRouting(campaign("effort-only", [
    step("one", { answer: answer("codex-low", -0.01) }),
  ])), /Jev cost/);
  assert.throws(() => replayRouting(campaign("fixed", [
    step("one", { metrics: { durationMs: -1 } }),
  ])), /duration/);
});

test("the report omits summaries and raw answers and CLI replays the synthetic fixture offline", () => {
  const report = replayRouting(campaign("effort-only", [step("one", { taskSummary: "private-marker", answer: { ...answer("codex-low"), extra: "private-marker" } })]));
  assert.equal(JSON.stringify(report).includes("private-marker"), false);
  const fixture = new URL("./fixtures/worker-routing.json", import.meta.url);
  const parsed = JSON.parse(readFileSync(fixture, "utf8"));
  const cli = new URL("../scripts/worker-routing-replay.mjs", import.meta.url);
  const output = JSON.parse(execFileSync(process.execPath, [fileURLToPath(cli), fileURLToPath(fixture)], { encoding: "utf8" }));
  assert.deepEqual(output, replayRouting(parsed));
  assert.equal(output.evidence, "synthetic");
  assert.equal(output.liveRequests, 0);
});

test("overflowing totals cannot become unknown measurements in JSON", () => {
  for (const metrics of [
    { durationMs: Number.MAX_VALUE },
    { inputTokens: Number.MAX_SAFE_INTEGER, cachedInputTokens: 0 },
  ]) {
    assert.throws(() => replayRouting(campaign("fixed", [
      step("one", { metrics }), step("two", { boundary: "request", metrics }),
    ])), /total/);
  }
});
