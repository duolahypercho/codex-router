import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

import { CLAUDE_REASONING_EFFORTS } from "../src/claude-agent-bridge.mjs";
import { NATIVE_REASONING_EFFORT_LADDER } from "../src/native-reasoning-effort.mjs";

const POLICIES = ["fixed", "effort-only", "task-boundary"];
const OUTCOMES = ["accepted", "rejected", "failed", "cancelled"];

function token(value, name) {
  if (typeof value !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,199}$/.test(value)) {
    throw new Error(`Invalid ${name}; supply a short identifier.`);
  }
  return value;
}

function summary(value, name) {
  if (typeof value !== "string" || !value.trim() || value.length > 2000) {
    throw new Error(`Invalid ${name}; supply 1 to 2000 characters of sanitised context.`);
  }
  return value;
}

function configuration(config) {
  if (!POLICIES.includes(config?.policy)) throw new Error("Unknown routing policy.");
  if (!["synthetic", "recorded"].includes(config.evidence)) throw new Error("Declare synthetic or recorded evidence.");
  if (!Array.isArray(config.profiles) || !config.profiles.length || config.profiles.length > 32) {
    throw new Error("Supply 1 to 32 explicit route profiles.");
  }
  const ids = new Set();
  const profiles = config.profiles.map((profile) => {
    const id = token(profile?.id, "profile ID");
    if (ids.has(id)) throw new Error("Duplicate profile ID.");
    ids.add(id);
    const efforts = profile.harness === "codex" ? NATIVE_REASONING_EFFORT_LADDER
      : profile.harness === "claude" ? CLAUDE_REASONING_EFFORTS : [];
    if (!efforts.includes(profile.effort)) throw new Error("Unsupported harness or effort spelling.");
    return {
      id, harness: profile.harness, model: token(profile.model, "model"), effort: profile.effort,
      description: summary(profile.description, "profile description"),
    };
  });
  const initial = profiles.find(({ id }) => id === config.initialProfileId);
  if (!initial) throw new Error("The initial profile is unavailable.");
  return { profiles, initial };
}

function sameWorker(left, right) {
  return left.harness === right.harness && left.model === right.model;
}

export function prepareRoutingChoice(config, step, previous) {
  const { profiles, initial } = configuration(config);
  token(step?.id, "request ID");
  token(step.taskId, "task ID");
  token(step.sessionId, "session ID");
  const continuing = previous?.taskId === step.taskId;
  if (step.boundary !== (continuing ? "request" : "task")) {
    throw new Error("Invalid boundary: continue a task only between completed requests.");
  }
  if (continuing && previous.sessionId !== step.sessionId) throw new Error("A continuing task must keep its session.");
  const pinned = continuing ? profiles.find(({ id }) => id === previous.profileId) : initial;
  if (!pinned) throw new Error("The previous profile is unavailable.");
  const eligible = config.policy === "fixed" ? [initial]
    : config.policy === "effort-only" || continuing ? profiles.filter((profile) => sameWorker(profile, pinned))
      : profiles;
  const state = {
    taskSummary: summary(step.taskSummary, "task summary"),
    stepSummary: summary(step.stepSummary, "step summary"),
    boundary: step.boundary,
    currentProfileId: previous?.profileId ?? null,
  };
  return {
    profiles: eligible,
    request: eligible.length === 1 ? null : {
      model: "openrouter-decisions/jev-latest",
      state,
      questions: {
        route: {
          type: "choice",
          instructions: "Choose the least resource-intensive eligible profile that can complete the described work reliably. Preserve the current profile when it remains suitable. Profile descriptions are operator estimates, not measured prices.",
          criteria: Object.fromEntries(eligible.map((profile) => [profile.id,
            `${profile.description} (harness=${profile.harness}, model=${profile.model}, effort=${profile.effort})`,
          ])),
        },
      },
    },
  };
}

function resolveChoice(prepared, response) {
  if (!prepared.request) return prepared.profiles[0];
  const choice = response?.answers?.route;
  const profile = prepared.profiles.find(({ id }) => id === choice?.choice);
  if (response?.error || !choice || choice.type !== "choice" || !profile
    || (choice.confidence !== undefined && (!Number.isFinite(choice.confidence) || choice.confidence < 0 || choice.confidence > 1))) {
    throw new Error("Invalid or out-of-policy Jev Choice; replay stopped without fallback.");
  }
  return profile;
}

function measurement(value, name, { integer = false } = {}) {
  if (value === undefined || value === null) return null;
  if (!Number.isFinite(value) || value < 0 || (integer && !Number.isSafeInteger(value))) {
    throw new Error(`Invalid ${name} measurement.`);
  }
  return value;
}

function sumKnown(values, { integer = false } = {}) {
  const total = values.reduce((sum, value) => sum + (value ?? 0), 0);
  if (!Number.isFinite(total) || (integer && !Number.isSafeInteger(total))) {
    throw new Error("Invalid measurement total; numeric range exceeded.");
  }
  return values.includes(null) ? null : total;
}

export function replayRouting(config) {
  configuration(config);
  if (!Array.isArray(config.steps) || !config.steps.length) throw new Error("Supply at least one replay step.");
  const seenRequests = new Set();
  const seenTasks = new Set();
  const seenSessions = new Set();
  const rows = [];
  const outcomes = Object.fromEntries(OUTCOMES.map((outcome) => [outcome, 0]));
  const costs = [];
  const durations = [];
  const inputs = [];
  const cached = [];
  let simulatedDecisions = 0;
  for (const step of config.steps) {
    if (seenRequests.has(step.id)) throw new Error("Duplicate request ID; replay stopped.");
    const previous = rows.at(-1);
    const prepared = prepareRoutingChoice(config, step, previous);
    if (step.boundary === "task") {
      if (seenTasks.has(step.taskId) || seenSessions.has(step.sessionId)) throw new Error("A new task requires a new task ID and session ID.");
      seenTasks.add(step.taskId);
      seenSessions.add(step.sessionId);
    }
    const profile = resolveChoice(prepared, step.answer);
    const crossingHarness = previous && previous.harness !== profile.harness;
    if (crossingHarness) summary(step.handoverSummary, "handover summary");
    if (!OUTCOMES.includes(step.outcome)) throw new Error("Supply an explicit accepted, rejected, failed or cancelled outcome.");
    const input = measurement(step.metrics?.inputTokens, "input tokens", { integer: true });
    const hit = measurement(step.metrics?.cachedInputTokens, "cached input tokens", { integer: true });
    if (hit !== null && (input === null || hit > input)) throw new Error("Invalid cached input token count.");
    inputs.push(input);
    cached.push(hit);
    durations.push(measurement(step.metrics?.durationMs, "duration"));
    if (prepared.request) {
      simulatedDecisions += 1;
      costs.push(measurement(step.answer?.usage?.cost, "Jev cost"));
    }
    outcomes[step.outcome] += 1;
    seenRequests.add(step.id);
    rows.push({
      requestId: step.id, taskId: step.taskId, sessionId: step.sessionId,
      profileId: profile.id, harness: profile.harness, model: profile.model, effort: profile.effort,
      decisionSource: prepared.request ? "supplied-answer" : "single-profile",
      handoverSupplied: Boolean(crossingHarness), outcome: step.outcome,
      requestOptions: profile.harness === "codex"
        ? { model: profile.model, reasoning: { effort: profile.effort } }
        : { model: profile.model, effort: profile.effort },
    });
  }
  const inputTokens = sumKnown(inputs, { integer: true });
  const cachedInputTokens = sumKnown(cached, { integer: true });
  return {
    version: 1, evidence: config.evidence, policy: config.policy, liveRequests: 0,
    simulatedDecisions, simulatedWorkerAttempts: rows.length, outcomes,
    measurements: {
      totalDurationMs: sumKnown(durations), inputTokens, cachedInputTokens,
      cacheHitRate: inputTokens > 0 && cachedInputTokens !== null ? cachedInputTokens / inputTokens : null,
      jevCostUsd: sumKnown(costs), subscriptionCostUsd: null,
    },
    rows,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    if (process.argv.length !== 3) throw new Error("Usage: node scripts/worker-routing-replay.mjs FIXTURE.json");
    const report = replayRouting(JSON.parse(readFileSync(process.argv[2], "utf8")));
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } catch (error) {
    // JSON parse and filesystem errors can contain source text or private paths.
    const detail = error instanceof SyntaxError || error?.code ? "Cannot read a valid replay fixture." : error.message;
    console.error(detail);
    process.exitCode = 1;
  }
}
