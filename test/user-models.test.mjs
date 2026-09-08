import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

const stateDir = mkdtempSync(path.join(os.tmpdir(), "user-models-test-"));
process.env.CODEX_ROUTER_STATE_DIR = stateDir;

const {
  userModelEntry,
  readUserModels,
  writeUserModels,
  hasDefaultUserModelReasoning,
  USER_MODELS_PATH,
} = await import("../src/user-models.mjs");

test("userModelEntry fills conservative picker metadata", () => {
  const entry = userModelEntry({
    providerId: "ollama-cloud",
    upstreamId: "gpt-oss:120b",
    requestProfile: "ollama-cloud",
    priority: 101,
  });
  assert.equal(entry.slug, "ollama-cloud/gpt-oss:120b");
  assert.equal(entry.gatewayModel, "ollama-cloud-gpt-oss-120b");
  assert.equal(entry.upstreamModel, "gpt-oss:120b");
  assert.equal(entry.provider, "ollama-cloud");
  assert.equal(entry.listed, true);
  assert.equal(entry.priority, 101);
  assert.equal(entry.requestProfile, "ollama-cloud");
  assert.equal(entry.defaultEffort, "high");
  assert.ok(entry.reasoningLevels.some((level) => level.effort === "high"));
  assert.ok(Number.isInteger(entry.contextWindow) && entry.contextWindow >= 1);
  assert.ok(entry.autoCompact >= 1 && entry.autoCompact <= entry.contextWindow);
  assert.deepEqual(entry.inputModalities, ["text"]);
  assert.equal(entry.compHash, "ollama-cloud-gpt-oss-120b-user-v1");
  assert.equal(entry.requiresTrailingUserTurn, undefined);
  assert.ok(entry.displayName.includes("gpt-oss:120b"));
  assert.ok(entry.description.length > 0);
});


test("OpenCode Free Muse Spark curation uses the official picker label", () => {
  const entry = userModelEntry({
    providerId: "opencode-free-responses",
    upstreamId: "muse-spark-1.3-contributor-free",
    priority: 100,
    metadata: { isFree: true },
  });
  assert.equal(entry.displayName, "Muse Spark 1.3 Contributor (OpenCode Free)");
});

test("curation metadata can set sizing and the effort ladder", () => {
  const entry = userModelEntry({
    providerId: "deepseek",
    upstreamId: "deepseek-effort-test",
    priority: 100,
    metadata: {
      contextWindow: 262144,
      autoCompact: 222822,
      inputModalities: ["text", "image"],
      reasoningLevels: [
        { effort: "low", description: "Quick reasoning" },
        { effort: "medium", description: "Balanced reasoning" },
        { effort: "high", description: "Deep reasoning" },
      ],
      defaultEffort: "medium",
      serviceTiers: [{ id: "priority", name: "Fast" }],
      supportsSearchHistory: true,
      requiresTrailingUserTurn: true,
      isFree: true,
    },
  });
  assert.equal(entry.contextWindow, 262144);
  assert.deepEqual(entry.inputModalities, ["text", "image"]);
  assert.equal(entry.reasoningLevels.length, 3);
  assert.equal(entry.defaultEffort, "medium");
  assert.deepEqual(entry.serviceTiers, [{ id: "priority", name: "Fast" }]);
  assert.equal(entry.supportsSearchHistory, true);
  assert.equal(entry.requiresTrailingUserTurn, true);
  assert.equal(entry.isFree, true);
});

test("curation metadata can expose provider-verified reasoning summaries", () => {
  const entry = userModelEntry({
    providerId: "chutes",
    upstreamId: "moonshotai/Kimi-K3-TEE",
    priority: 100,
    metadata: {
      supportsReasoningSummaries: true,
      defaultReasoningSummary: "auto",
    },
  });
  assert.equal(entry.supportsReasoningSummaries, true);
  assert.equal(entry.defaultReasoningSummary, "auto");
});

test("curation metadata preserves only explicit endpoint capabilities", () => {
  const entry = userModelEntry({
    providerId: "openrouter",
    upstreamId: "vendor/embedding-model",
    priority: 100,
    metadata: {
      supportedEndpoints: ["/embeddings"],
      endpoint: "/audio/speech",
    },
  });
  assert.deepEqual(entry.supportedEndpoints, ["/embeddings"]);
  assert.equal(entry.endpoint, undefined);
});

test("curation metadata cannot replace identity or routing fields", () => {
  const entry = userModelEntry({
    providerId: "deepseek",
    upstreamId: "deepseek-guard-test",
    priority: 100,
    metadata: {
      slug: "evil/override",
      gatewayModel: "evil-gateway",
      upstreamModel: "evil-upstream",
      provider: "evil",
      requestProfile: "evil-profile",
      contextWindow: 200000,
    },
  });
  assert.equal(entry.slug, "deepseek/deepseek-guard-test");
  assert.equal(entry.gatewayModel, "deepseek-deepseek-guard-test");
  assert.equal(entry.upstreamModel, "deepseek-guard-test");
  assert.equal(entry.provider, "deepseek");
  assert.equal(entry.requestProfile, undefined);
  assert.equal(entry.contextWindow, 200000);
});

test("userModelEntry omits requestProfile when the provider has none", () => {
  const entry = userModelEntry({
    providerId: "zai-coding",
    upstreamId: "glm-4.7",
    priority: 100,
  });
  assert.equal(entry.requestProfile, undefined);
});

test("user models round-trip through the protected state file", () => {
  const entries = [
    userModelEntry({ providerId: "deepseek", upstreamId: "deepseek-vl-test", priority: 100 }),
  ];
  writeUserModels(entries);
  assert.deepEqual(readUserModels(), entries);
  assert.ok(USER_MODELS_PATH.startsWith(stateDir));
});

test("readUserModels returns an empty list when the file is absent or invalid", () => {
  writeFileSync(USER_MODELS_PATH, "not-json\n");
  assert.deepEqual(readUserModels(), []);
});

test("registry merges valid user models and skips collisions", async () => {
  const entries = [
    userModelEntry({
      providerId: "deepseek",
      upstreamId: "deepseek-user-test",
      priority: 100,
      metadata: { availabilityNux: "Now available through your DeepSeek key." },
    }),
    // Collides with a built-in slug and must be skipped, not fatal.
    { ...userModelEntry({ providerId: "deepseek", upstreamId: "deepseek-v4-pro", priority: 101 }) },
    // The old OpenCode curation slug differs from the checked-in public slug,
    // but provider + upstream id identify the same physical route. It must be
    // suppressed and exposed as a visibility migration, not rendered twice.
    userModelEntry({
      providerId: "opencode-free",
      upstreamId: "x-preview-f-free",
      priority: 113,
    }),
    // A duplicate route must not be able to turn somebody else's checked-in
    // slug into its own alias. MODEL_BY_SLUG applies aliases after real models,
    // so accepting this would silently reroute DeepSeek traffic to OpenCode.
    {
      ...userModelEntry({
        providerId: "opencode-free",
        upstreamId: "x-preview-f-free",
        priority: 114,
      }),
      slug: "deepseek/deepseek-v4-pro",
    },
    // Repository migration aliases are reserved too. A mutable overlay must
    // not replace the old Grok route's checked-in Responses migration.
    {
      ...userModelEntry({
        providerId: "opencode-free",
        upstreamId: "x-preview-f-free",
        priority: 115,
      }),
      slug: "opencode-go/grok-4.5",
    },
    // Unknown provider must be skipped, not fatal.
    userModelEntry({ providerId: "no-such-provider", upstreamId: "x-model", priority: 102 }),
    // Endpoint-only models stay out of conversational pickers. A listed model
    // that omits its provider's chat route would otherwise advertise a turn
    // that the forwarder must refuse.
    {
      ...userModelEntry({
        providerId: "openrouter",
        upstreamId: "vendor/embedding-only-listed",
        priority: 116,
        metadata: { supportedEndpoints: ["/embeddings"] },
      }),
      listed: true,
    },
    {
      ...userModelEntry({
        providerId: "openrouter",
        upstreamId: "vendor/embedding-only",
        priority: 117,
        metadata: { supportedEndpoints: ["/embeddings"] },
      }),
      listed: false,
    },
    {
      ...userModelEntry({
        providerId: "openrouter",
        upstreamId: "vendor/bad-endpoint",
        priority: 118,
      }),
      supportedEndpoints: ["/audio/speech"],
    },
    {
      ...userModelEntry({
        providerId: "anthropic-api",
        upstreamId: "vendor/embedding-only",
        priority: 119,
        metadata: { supportedEndpoints: ["/embeddings"] },
      }),
      listed: false,
    },
    // Announcement copy must be a non-empty string; a blank one is skipped.
    {
      ...userModelEntry({ providerId: "deepseek", upstreamId: "deepseek-blank-nux", priority: 103 }),
      availabilityNux: "   ",
    },
    // Search modes are a closed set. Unknown modes must not advertise a
    // search path the request path cannot serve.
    {
      ...userModelEntry({ providerId: "deepseek", upstreamId: "deepseek-bad-search", priority: 106 }),
      searchTool: { mode: "emulated" },
    },
    {
      ...userModelEntry({ providerId: "deepseek", upstreamId: "deepseek-bad-search-history", priority: 120 }),
      supportsSearchHistory: "yes",
    },
    // Standalone search is Codex-side execution; it remains an explicit
    // per-model opt-in rather than a provider-wide default.
    {
      ...userModelEntry({ providerId: "deepseek", upstreamId: "deepseek-standalone-search", priority: 110 }),
      searchTool: { mode: "standalone" },
    },
    // Capability toggles are booleans; a truthy string must not slip through.
    {
      ...userModelEntry({ providerId: "deepseek", upstreamId: "deepseek-bad-detail", priority: 107 }),
      supportsImageDetailOriginal: "yes",
    },
    // Destructive trailing-turn handling is an explicit boolean capability.
    {
      ...userModelEntry({ providerId: "deepseek", upstreamId: "deepseek-bad-trailing-turn", priority: 111 }),
      requiresTrailingUserTurn: "yes",
    },
    // Local state is not a repository certificate. A hand-edited overlay must
    // never make its own route appear as a native v2 subagent.
    {
      ...userModelEntry({ providerId: "deepseek", upstreamId: "deepseek-self-certified", priority: 112 }),
      multiAgentVersion: "v2",
    },
    // Reasoning-summary capability fields must agree. A valid enum on its own
    // must not make the catalog claim summaries for a model that does not
    // explicitly support them.
    {
      ...userModelEntry({ providerId: "deepseek", upstreamId: "deepseek-summary-without-support", priority: 108 }),
      defaultReasoningSummary: "auto",
    },
    {
      ...userModelEntry({ providerId: "deepseek", upstreamId: "deepseek-invalid-summary-support", priority: 109 }),
      supportsReasoningSummaries: "yes",
      defaultReasoningSummary: "auto",
    },
    // An upgrade prompt pointing at a slug the merged registry does not carry
    // can never render, so the entry is skipped.
    {
      ...userModelEntry({ providerId: "deepseek", upstreamId: "deepseek-bad-upgrade", priority: 104 }),
      upgradeTo: { model: "no-such/model", markdown: "Switch now" },
    },
    // A prompt targeting a listed checked-in model is kept.
    {
      ...userModelEntry({ providerId: "deepseek", upstreamId: "deepseek-good-upgrade", priority: 105 }),
      upgradeTo: { model: "deepseek/deepseek-v4-pro", markdown: "V4 Pro supersedes this preview." },
    },
  ];
  writeUserModels(entries);
  const registry = await import("../src/model-registry.mjs");
  const slugs = registry.MODELS.map((model) => model.slug);
  assert.ok(slugs.includes("deepseek/deepseek-user-test"));
  assert.equal(slugs.includes("openrouter/vendor/embedding-only-listed"), false);
  assert.equal(slugs.includes("openrouter/vendor/embedding-only"), true);
  assert.equal(slugs.includes("openrouter/vendor/bad-endpoint"), false);
  assert.equal(slugs.includes("anthropic-api/vendor/embedding-only"), false);
  assert.equal(slugs.filter((slug) => slug === "deepseek/deepseek-v4-pro").length, 1);
  assert.equal(slugs.includes("opencode-free/ox-alpha"), false);
  assert.equal(slugs.filter((slug) => slug === "opencode-free/x-preview-f-free").length, 1);
  assert.equal(registry.MODEL_SLUG_ALIASES.has("opencode-free/x-preview-f-free"), false);
  // Historical user state keeps x-preview-f-free under its opaque id with curated suffix.
  assert.equal(
    registry.MODEL_BY_SLUG.get("opencode-free/x-preview-f-free").displayName,
    "x-preview-f-free (curated)",
  );
  assert.equal(registry.MODEL_SLUG_ALIASES.has("deepseek/deepseek-v4-pro"), false);
  assert.equal(registry.MODEL_BY_SLUG.get("deepseek/deepseek-v4-pro").provider, "deepseek");
  assert.equal(
    registry.MODEL_SLUG_ALIASES.get("opencode-go/grok-4.5"),
    "opencode-go-responses/grok-4.5",
  );
  assert.equal(
    registry.MODEL_SLUG_ALIASES.get("opencode-go/ox-alpha"),
    "opencode-go/glm-5.3-flash",
  );
  assert.equal(
    registry.MODEL_SLUG_ALIASES.get("opencode-go/ox-alpha-free"),
    "opencode-go/glm-5.3-flash",
  );
  assert.equal(
    registry.MODEL_BY_SLUG.get("opencode-go/ox-alpha"),
    registry.MODEL_BY_SLUG.get("opencode-go/glm-5.3-flash"),
  );
  assert.equal(
    registry.MODEL_BY_SLUG.get("opencode-go/grok-4.5").provider,
    "opencode-go-responses",
  );
  assert.ok(!slugs.includes("no-such-provider/x-model"));
  assert.ok(!slugs.includes("deepseek/deepseek-blank-nux"));
  assert.ok(!slugs.includes("deepseek/deepseek-bad-search"));
  assert.ok(!slugs.includes("deepseek/deepseek-bad-search-history"));
  assert.ok(slugs.includes("deepseek/deepseek-standalone-search"));
  assert.ok(!slugs.includes("deepseek/deepseek-bad-detail"));
  assert.ok(!slugs.includes("deepseek/deepseek-bad-trailing-turn"));
  assert.ok(!slugs.includes("deepseek/deepseek-self-certified"));
  assert.ok(!slugs.includes("deepseek/deepseek-summary-without-support"));
  assert.ok(!slugs.includes("deepseek/deepseek-invalid-summary-support"));
  assert.ok(!slugs.includes("deepseek/deepseek-bad-upgrade"));
  assert.deepEqual(
    registry.MODEL_BY_SLUG.get("deepseek/deepseek-good-upgrade").upgradeTo,
    { model: "deepseek/deepseek-v4-pro", markdown: "V4 Pro supersedes this preview." },
  );
  assert.ok(registry.MODEL_BY_GATEWAY_ID.has("deepseek-deepseek-user-test"));
  assert.ok(registry.USER_MODEL_WARNINGS.length >= 4);
  assert.ok(registry.USER_MODEL_WARNINGS.some((warning) => /may not declare multiAgentVersion v2/.test(warning)));
  assert.ok(registry.USER_MODEL_WARNINGS.some((warning) => (
    /deepseek\/deepseek-v4-pro/.test(warning) && /duplicates checked-in route/.test(warning)
  )));
  assert.ok(registry.USER_MODEL_WARNINGS.some((warning) => (
    /opencode-go\/grok-4\.5/.test(warning) && /collides with an existing model alias/.test(warning)
  )));
  const merged = registry.MODEL_BY_SLUG.get("deepseek/deepseek-user-test");
  assert.equal(merged.listed, true);
  assert.equal(merged.availabilityNux, "Now available through your DeepSeek key.");
  assert.deepEqual(
    registry.MODEL_BY_SLUG.get("deepseek/deepseek-standalone-search").searchTool,
    { mode: "standalone" },
  );
});


// Curation has to be able to tell "nobody documented this model's efforts"
// apart from a ladder somebody chose, the same way the untouched
// 131072/110000 pair marks untuned sizing. Without that distinction an upgrade
// path cannot add a published ladder without risking an operator's own (#352).
test("a defaulted effort ladder is distinguishable from a chosen one", () => {
  const stock = userModelEntry({
    providerId: "ollama-cloud",
    upstreamId: "gpt-oss:120b",
    priority: 101,
  });
  assert.equal(hasDefaultUserModelReasoning(stock), true);
  assert.equal(stock.defaultEffort, "high");
  assert.deepEqual(stock.reasoningLevels, [{ effort: "high", description: "Adaptive reasoning" }]);

  const chosen = userModelEntry({
    providerId: "ollama-cloud",
    upstreamId: "gpt-oss:120b",
    priority: 101,
    metadata: {
      defaultEffort: "high",
      reasoningLevels: [
        { effort: "low", description: "Quick reasoning" },
        { effort: "high", description: "Deep reasoning" },
      ],
    },
  });
  assert.equal(hasDefaultUserModelReasoning(chosen), false);

  // A single high level someone worded differently is still theirs.
  assert.equal(
    hasDefaultUserModelReasoning({
      defaultEffort: "high",
      reasoningLevels: [{ effort: "high", description: "My own wording" }],
    }),
    false,
  );
  assert.equal(hasDefaultUserModelReasoning({}), false);
  assert.equal(hasDefaultUserModelReasoning(undefined), false);
});
