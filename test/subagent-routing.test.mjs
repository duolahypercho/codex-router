import assert from "node:assert/strict";
import test from "node:test";

import { CHECKED_IN_MODELS } from "../src/model-registry.mjs";
import {
  MAX_SUBAGENT_ATTEMPTS,
  MAX_SUBAGENT_WEIGHT,
  normalizeSubagentChain,
  rankSubagentCandidates,
  selectWeightedSubagentTarget,
  subagentEligibility,
  subagentFallbackPlan,
  subagentTargetDiagnostic,
  verifiedSubagentTargets,
} from "../src/subagent-routing.mjs";

const SETTINGS = { mode: "proven", enabled: [], disabled: [] };
const AUTHORITY = CHECKED_IN_MODELS.filter((model) => model.multiAgentVersion === "v2");
const GROK_API = AUTHORITY.find((model) => model.slug === "grok-api/grok-4.5");
const GROK_OAUTH = AUTHORITY.find((model) => model.slug === "grok-oauth/grok-4.5");
const KIMI_API = AUTHORITY.find((model) => model.slug === "kimi-api/kimi-k3");
const GLM = AUTHORITY.find((model) => model.slug === "zai-coding/glm-5.3");

assert.ok(GROK_API && GROK_OAUTH && KIMI_API && GLM, "expected checked-in v2 fixtures");

test("only checked-in v2 records can authorize a target", () => {
  assert.equal(
    subagentEligibility(
      { slug: "invented/model", provider: "invented", multiAgentVersion: "v2" },
      {
        authority: [{ slug: "invented/model", provider: "invented", multiAgentVersion: "v2" }],
        settings: SETTINGS,
      },
    ),
    "unverified-model",
  );
  assert.equal(
    subagentEligibility(
      {
        slug: GROK_API.slug,
        provider: GROK_API.provider,
        multiAgentVersion: "v2",
      },
      { authority: [{ ...GROK_API, multiAgentVersion: "v1" }], settings: SETTINGS },
    ),
    undefined,
  );
  assert.equal(
    subagentEligibility(
      {
        slug: GLM.slug,
        provider: GLM.provider,
        multiAgentVersion: "v2",
        supportsVision: true,
      },
      { authority: [{ ...GLM, inputModalities: ["text", "image"] }], settings: SETTINGS, requiredCapabilities: ["vision"] },
    ),
    "missing-capability:vision",
  );
  assert.equal(
    subagentEligibility(
      { slug: GROK_API.slug, provider: GROK_API.provider, multiAgentVersion: "v1" },
      { authority: AUTHORITY, settings: SETTINGS, requiredCapabilities: ["vision"] },
    ),
    undefined,
  );
});

test("chain normalization requires a model and bounds duplicate weights", () => {
  assert.deepEqual(
    normalizeSubagentChain([
      { provider: GROK_API.provider, weight: 2 },
      { model: GROK_API.slug, provider: GROK_API.provider, weight: MAX_SUBAGENT_WEIGHT + 9 },
      { model: GROK_API.slug, provider: GROK_API.provider, weight: 2 },
      { model: GROK_API.slug, weight: 0 },
    ]),
    [
      { model: GROK_API.slug, provider: GROK_API.provider, weight: MAX_SUBAGENT_WEIGHT },
      { model: GROK_API.slug, weight: 1 },
    ],
  );
});

test("rank preserves provider identity and ignores caller capability claims", () => {
  const ranked = rankSubagentCandidates(
    [
      { ...GROK_API, supportsVision: true },
      { ...GROK_API, supportsVision: true },
      { ...GROK_OAUTH, multiAgentVersion: "v1" },
      { ...KIMI_API },
      { slug: "invented/model", provider: "provider-x", multiAgentVersion: "v2" },
    ],
    {
      authority: AUTHORITY,
      settings: SETTINGS,
      chain: [
        { model: GROK_OAUTH.slug, provider: GROK_OAUTH.provider, weight: 2 },
        GROK_API.slug,
        KIMI_API.slug,
      ],
    },
  );
  assert.deepEqual(
    ranked.map((entry) => `${entry.slug}@${entry.provider}`),
    ["grok-oauth/grok-4.5@grok-oauth", "grok-api/grok-4.5@grok-api", "kimi-api/kimi-k3@kimi-api"],
  );
  assert.equal(ranked[0].model.supportsVision, undefined);
  assert.equal(ranked[0].weight, 2);
});

test("ambiguous bare model names do not lose provider identity", () => {
  const ranked = rankSubagentCandidates(
    [AUTHORITY[0], AUTHORITY[1]],
    { authority: AUTHORITY, settings: SETTINGS, chain: ["grok-api/grok-4.5"] },
  );
  assert.deepEqual(ranked.map((entry) => `${entry.slug}@${entry.provider}`), ["grok-api/grok-4.5@grok-api"]);
});

test("weighted selection is deterministic without expanding the cycle", () => {
  const ranked = rankSubagentCandidates(
    [GROK_API, KIMI_API],
    {
      authority: AUTHORITY,
      settings: SETTINGS,
      chain: [
        { model: GROK_API.slug, provider: GROK_API.provider, weight: 2 },
        { model: KIMI_API.slug, provider: KIMI_API.provider, weight: 1 },
      ],
    },
  );
  assert.deepEqual(
    [0, 1, 2, 3].map((selectionIndex) => selectWeightedSubagentTarget(ranked, { selectionIndex }).provider),
    ["grok-api", "grok-api", "kimi-api", "grok-api"],
  );
});

test("fallback is bounded, pre-response, and excludes only the exact failed identity", () => {
  const ranked = rankSubagentCandidates(
    [GROK_API, GROK_OAUTH, KIMI_API, GLM],
    { authority: AUTHORITY, settings: SETTINGS },
  );
  assert.equal(
    subagentFallbackPlan(ranked, { committed: true, failureKind: "timeout" }),
    undefined,
  );
  assert.equal(
    subagentFallbackPlan(ranked, { failureKind: "invalid-request" }),
    undefined,
  );
  const plan = subagentFallbackPlan(ranked, {
    failureKind: "connection",
    failedTarget: { slug: GROK_API.slug, provider: GROK_API.provider },
    maxAttempts: 99,
    settings: SETTINGS,
  });
  assert.equal(plan.target.provider, "grok-oauth");
  assert.deepEqual(plan.fallbacks.map((entry) => entry.provider), ["kimi-api", "zai-coding"]);
  assert.equal(plan.maxAttempts, MAX_SUBAGENT_ATTEMPTS);
  assert.equal(plan.attempts.length, MAX_SUBAGENT_ATTEMPTS);
  assert.equal(
    subagentFallbackPlan(ranked, {
      failureKind: "connection",
      failedTarget: { slug: GROK_API.slug },
      settings: SETTINGS,
    }),
    undefined,
  );
  assert.equal(
    subagentFallbackPlan(ranked, {
      failureKind: "connection",
      settings: SETTINGS,
    }),
    undefined,
  );
});

test("fallback refuses ranked entries outside the checked-in v2 registry", () => {
  assert.equal(
    subagentFallbackPlan(
      [{ model: { slug: "invented/model", provider: "invented", multiAgentVersion: "v2" }, weight: 1 }],
      { failureKind: "timeout", settings: SETTINGS },
    ),
    undefined,
  );
});

test("fallback deduplicates exact model/provider identities before retrying", () => {
  const plan = subagentFallbackPlan(
    [
      { model: GROK_API, weight: 2 },
      { model: GROK_API, weight: 9 },
      { model: GROK_OAUTH, weight: 1 },
    ],
    { failureKind: "timeout", failedTarget: GROK_API, settings: SETTINGS },
  );
  assert.deepEqual(plan.attempts.map((entry) => `${entry.slug}@${entry.provider}`), [
    "grok-oauth/grok-4.5@grok-oauth",
  ]);
});

test("verified target list follows the actual checked-in v2 delegation contract", () => {
  const targets = verifiedSubagentTargets({
    authority: CHECKED_IN_MODELS,
    settings: SETTINGS,
  });
  assert.ok(targets.length > 0);
  assert.ok(targets.every((entry) => entry.model.multiAgentVersion === "v2"));
  assert.ok(targets.every((entry) => CHECKED_IN_MODELS.includes(entry.model)));
});

test("target diagnostics contain only identity and bounded attempt metadata", () => {
  assert.deepEqual(
    subagentTargetDiagnostic({
      agentId: "P11",
      target: { model: { slug: GROK_OAUTH.slug, provider: GROK_OAUTH.provider } },
      attempt: 1,
      source: "chain",
    }),
    {
      agentId: "P11",
      target: GROK_OAUTH.slug,
      provider: GROK_OAUTH.provider,
      attempt: 1,
      source: "chain",
    },
  );
});
