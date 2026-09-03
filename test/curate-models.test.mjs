import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// curate-models.mjs validates process.argv at module scope and exits when the
// provider is missing, so give it a real invocation before importing. This is
// the flow PR #76 tried to bypass by hardcoding models, and it had no test
// coverage of any kind.
const savedArgv = [...process.argv];
process.argv = [process.argv[0], "curate-models.mjs", "gemini-api"];
const {
  curatedSizing,
  mergeCurationIntoCurrent,
  normalizeCurationModels,
  parseEfforts,
  parseRequestProfile,
  planCuration,
  renderRows,
  uniformProviderFamilyRequestProfile,
} =
  await import("../src/curate-models.mjs");
const {
  curatedModelBlockReason,
  curatedModelContextLength,
  curatedModelDescription,
  curatedModelIds,
  curatedModelOutputLimit,
  curatedModelProviderId,
  curatedModelReasoningLevels,
  curatedModelRequestProfile,
  curationProviderIds,
} = await import("../src/opencode-curation.mjs");
const { CHECKED_IN_MODELS, MODEL_BY_SLUG } = await import("../src/model-registry.mjs");
const {
  DEFAULT_AUTO_COMPACT,
  DEFAULT_CONTEXT_WINDOW,
  defaultUserModelDescription,
  hasDefaultUserModelReasoning,
  userModelEntry,
  userModelIdentity,
} = await import("../src/user-models.mjs");
process.argv = savedArgv;
process.exitCode = 0;

const curated = (upstreamModel, metadata = {}) => ({
  upstreamModel,
  provider: "fireworks",
  ...metadata,
});

test("curation merges current unrelated providers and rejects stale same-provider edits", () => {
  const mine = curated("accounts/fireworks/models/kimi-k3");
  const other = { ...curated("openrouter/other"), provider: "openrouter" };
  const replacement = curated("accounts/fireworks/models/deepseek-v4-flash");
  assert.deepEqual(
    mergeCurationIntoCurrent([mine, other], {
      providerId: "fireworks",
      expectedMine: [mine],
      nextMine: [replacement],
    }),
    [other, replacement],
  );
  assert.throws(
    () => mergeCurationIntoCurrent(
      [replacement, other],
      { providerId: "fireworks", expectedMine: [mine], nextMine: [replacement] },
    ),
    /changed while this command was running/,
  );
});

test("OpenCode curation keeps each endpoint family on its documented protocol", () => {
  assert.deepEqual(curationProviderIds("opencode-free"), [
    "opencode-free",
    "opencode-free-responses",
  ]);
  assert.deepEqual(curationProviderIds("opencode-free-responses"), [
    "opencode-free",
    "opencode-free-responses",
  ]);
  assert.deepEqual(curationProviderIds("opencode-zen"), ["opencode-zen"]);
  assert.deepEqual(curationProviderIds("opencode-go"), [
    "opencode-go",
    "opencode-go-messages",
    "opencode-go-responses",
  ]);
  assert.deepEqual(curationProviderIds("opencode-go-messages"), [
    "opencode-go",
    "opencode-go-messages",
    "opencode-go-responses",
  ]);
  for (const model of CHECKED_IN_MODELS.filter(({ provider }) => provider.startsWith("opencode-go"))) {
    assert.equal(
      curatedModelProviderId("opencode-go", model.upstreamModel),
      model.provider,
      model.slug,
    );
  }
  assert.equal(
    curatedModelProviderId("opencode-free", "muse-spark-1.2-contributor-free"),
    "opencode-free-responses",
  );
  assert.equal(
    curatedModelProviderId("opencode-zen", "muse-spark-1.2"),
    "opencode-zen",
  );
  assert.equal(curatedModelBlockReason("opencode-go", "grok-4.5"), undefined);
  assert.match(
    curatedModelBlockReason("opencode-go", "future-responses-only-model"),
    /provider catalog lists future-responses-only-model.*has not verified whether the model uses Chat, Messages, or Responses.*router compatibility limitation.*future update/s,
  );
  assert.throws(
    () => curatedModelProviderId("opencode-go", "future-responses-only-model"),
    /cannot be added safely/,
  );
  assert.equal(
    curatedModelProviderId("opencode-go", "existing-private-model", {
      existingProvider: "opencode-go-responses",
    }),
    "opencode-go-responses",
  );
});

test("OpenCode Free Muse curation carries its model-specific tool-choice repair", () => {
  assert.equal(
    curatedModelRequestProfile("opencode-free", "muse-spark-1.2-contributor-free"),
    "auto-tool-choice",
  );
  assert.equal(
    curatedModelRequestProfile("opencode-free", "muse-spark-1.3-contributor-free"),
    "auto-tool-choice",
  );
  assert.equal(curatedModelRequestProfile("opencode-free", "nemotron-3-ultra-free"), undefined);
});

test("ChatGPT Web curation keeps the upstream slug and immutable account effort", () => {
  assert.deepEqual(curationProviderIds("chatgpt-web"), ["chatgpt-web"]);
  assert.equal(
    userModelIdentity({ providerId: "chatgpt-web", upstreamId: "chatgpt-web/pro" }).slug,
    "chatgpt-web/pro",
  );
  assert.deepEqual(curatedModelReasoningLevels("chatgpt-web", "chatgpt-web/light"), ["low"]);
  assert.deepEqual(curatedModelReasoningLevels("chatgpt-web", "chatgpt-web/pro"), ["ultra"]);
  assert.equal(parseEfforts("ultra").defaultEffort, "ultra");
});

test("ChatGPT Web curation preserves its live Codex catalog metadata", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "curate-chatgpt-web-"));
  const file = path.join(dir, "user-models.json");
  const fixture = path.join(dir, "models.json");
  writeFileSync(fixture, JSON.stringify({
    models: [
      { slug: "gpt-5.6-sol", display_name: "Native row must stay out" },
      {
        slug: "chatgpt-web/pro",
        display_name: "ChatGPT Web — Pro",
        context_window: 112_193,
        input_modalities: ["text", "image"],
      },
    ],
  }));
  try {
    const result = spawnSync(
      process.execPath,
      [
        path.join(root, "src", "curate-models.mjs"),
        "chatgpt-web",
        "--models",
        "chatgpt-web/pro",
        "--fixture",
        fixture,
        "--no-apply",
      ],
      {
        cwd: root,
        encoding: "utf8",
        env: {
          ...process.env,
          MODEL_ROUTER_STATE_DIR: path.join(dir, "state"),
          MODEL_ROUTER_USER_MODELS: file,
        },
      },
    );
    assert.equal(result.status, 0, result.stderr);
    const [model] = JSON.parse(readFileSync(file, "utf8")).models;
    assert.equal(model.slug, "chatgpt-web/pro");
    assert.equal(model.upstreamModel, "chatgpt-web/pro");
    assert.equal(model.displayName, "ChatGPT Web — Pro");
    assert.equal(model.contextWindow, 112_193);
    assert.deepEqual(model.inputModalities, ["text", "image"]);
    assert.deepEqual(model.reasoningLevels, [{ effort: "ultra", description: "Pro reasoning" }]);
    assert.equal(model.defaultEffort, "ultra");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Command Code curation accepts only its exact certified Chat and Messages routes", () => {
  assert.deepEqual(curationProviderIds("commandcode"), [
    "commandcode",
    "commandcode-messages",
  ]);
  assert.deepEqual(curationProviderIds("commandcode-messages"), [
    "commandcode",
    "commandcode-messages",
  ]);
  for (const model of CHECKED_IN_MODELS.filter(({ provider }) => (
    provider === "commandcode" || provider === "commandcode-messages"
  ))) {
    assert.equal(
      curatedModelProviderId("commandcode", model.upstreamModel),
      model.provider,
      model.slug,
    );
  }
  assert.match(
    curatedModelBlockReason("commandcode", "claude-future-messages-only"),
    /provider catalog lists claude-future-messages-only.*has not verified whether the model uses Chat or Messages.*router compatibility limitation.*future update/s,
  );
  for (const model of ["gpt-5.3-codex", "gpt-5.4", "gpt-5.4-mini"]) {
    assert.match(
      curatedModelBlockReason("commandcode", model),
      new RegExp(`provider catalog lists ${model}.*router compatibility limitation`, "s"),
    );
  }
  assert.throws(
    () => curatedModelProviderId("commandcode", "claude-future-messages-only"),
    /cannot be added safely/,
  );
  assert.equal(
    curatedModelProviderId("commandcode", "existing-private-model", {
      existingProvider: "commandcode-messages",
    }),
    "commandcode-messages",
  );
});

test("scripted OpenCode curation refuses an uncertified discovered protocol route", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "curate-models-opencode-blocked-"));
  const fixture = path.join(dir, "models.json");
  writeFileSync(fixture, JSON.stringify({ data: [{ id: "future-responses-only-model" }] }));
  try {
    const result = spawnSync(
      process.execPath,
      [
        path.join(root, "src", "curate-models.mjs"),
        "opencode-go",
        "--models",
        "future-responses-only-model",
        "--fixture",
        fixture,
        "--no-apply",
      ],
      {
        cwd: root,
        encoding: "utf8",
        env: {
          ...process.env,
          CODEX_ROUTER_STATE_DIR: dir,
          MODEL_ROUTER_USER_MODELS: path.join(dir, "user-models.json"),
          OPENCODE_API_KEY: "",
        },
      },
    );
    assert.equal(result.status, 1);
    assert.match(
      result.stderr,
      /provider catalog lists future-responses-only-model.*cannot be added safely/s,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("scripted Command Code curation refuses an uncertified discovered protocol route", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "curate-models-commandcode-blocked-"));
  const fixture = path.join(dir, "models.json");
  writeFileSync(fixture, JSON.stringify({ data: [{ id: "claude-future-messages-only" }] }));
  try {
    const result = spawnSync(
      process.execPath,
      [
        path.join(root, "src", "curate-models.mjs"),
        "commandcode",
        "--models",
        "claude-future-messages-only",
        "--fixture",
        fixture,
        "--no-apply",
      ],
      {
        cwd: root,
        encoding: "utf8",
        env: {
          ...process.env,
          CODEX_ROUTER_STATE_DIR: dir,
          MODEL_ROUTER_USER_MODELS: path.join(dir, "user-models.json"),
          COMMAND_CODE_API_KEY: "",
        },
      },
    );
    assert.equal(result.status, 1);
    assert.match(
      result.stderr,
      /provider catalog lists claude-future-messages-only.*cannot be added safely/s,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("OpenCode Free curation knows the documented windows its live catalog omits", () => {
  assert.equal(
    curatedModelContextLength("opencode-free", "muse-spark-1.2-contributor-free"),
    1_048_576,
  );
  assert.equal(curatedModelContextLength("opencode-free", "mimo-v2.5-free"), undefined);
});

test("paid Zen curation identity remains byte-for-byte unchanged", () => {
  const paidZen = userModelEntry({
    providerId: "opencode-zen",
    upstreamId: "muse-spark-1.2",
    priority: 151,
    requestProfile: "auto-tool-choice",
    metadata: { contextWindow: 1_048_576 },
  });
  const [normalized] = normalizeCurationModels([paidZen], "opencode-zen");
  assert.strictEqual(normalized, paidZen);
  assert.equal(normalized.slug, "opencode-zen/muse-spark-1.2");
  assert.equal(normalized.gatewayModel, "opencode-zen-muse-spark-1-2");
});

test("OpenCode protocol normalization preserves metadata and deduplicates old routes", () => {
  const upstreamModel = "muse-spark-1.2-contributor-free";
  const old = userModelEntry({
    providerId: "opencode-free",
    upstreamId: upstreamModel,
    priority: 147,
    requestProfile: "auto-tool-choice",
    metadata: {
      contextWindow: 1_048_576,
      autoCompact: 900_000,
      inputModalities: ["text", "image"],
      isFree: true,
    },
  });
  old.displayName = "Preserved Muse metadata";
  const correct = userModelEntry({
    providerId: "opencode-free-responses",
    upstreamId: upstreamModel,
    priority: 148,
    metadata: { contextWindow: 262_144 },
  });

  const [migrated] = normalizeCurationModels([old], "opencode-free");
  assert.equal(migrated.provider, "opencode-free-responses");
  assert.equal(migrated.slug, `opencode-free-responses/${upstreamModel}`);
  assert.equal(migrated.gatewayModel, "opencode-free-responses-muse-spark-1-2-contributor-free");
  assert.equal(migrated.displayName, old.displayName);
  assert.equal(migrated.contextWindow, old.contextWindow);
  assert.equal(migrated.requestProfile, old.requestProfile);

  assert.deepEqual(
    normalizeCurationModels([old, correct], "opencode-free"),
    [{ ...correct, requestProfile: "auto-tool-choice" }],
  );
});

test("Both Muse Spark 1.2 and 1.3 contributor free curate to opencode-free-responses", () => {
  for (const upstreamModel of [
    "muse-spark-1.2-contributor-free",
    "muse-spark-1.3-contributor-free",
  ]) {
    const entry = userModelEntry({
      providerId: "opencode-free",
      upstreamId: upstreamModel,
      priority: 147,
      requestProfile: "auto-tool-choice",
      metadata: {
        contextWindow: 1_048_576,
        autoCompact: 900_000,
        inputModalities: ["text", "image"],
        isFree: true,
      },
    });
    const [normalized] = normalizeCurationModels([entry], "opencode-free");
    assert.equal(normalized.provider, "opencode-free-responses", `${upstreamModel} provider`);
    assert.equal(
      normalized.slug,
      `opencode-free-responses/${upstreamModel}`,
      `${upstreamModel} slug`,
    );
    assert.equal(normalized.upstreamModel, upstreamModel);
    assert.equal(normalized.multiAgentVersion, undefined, `${upstreamModel} not v2`);
  }
});

test("an additive model run keeps unrelated curated metadata", () => {
  const existing = curated("accounts/fireworks/models/kimi-k3", { contextWindow: 262144 });
  const result = planCuration({
    mine: [existing],
    chosen: ["accounts/fireworks/models/deepseek-v4-flash"],
    removals: [],
    interactive: false,
  });
  assert.deepEqual(result.surviving, [existing]);
  assert.deepEqual(result.additions, ["accounts/fireworks/models/deepseek-v4-flash"]);
});

test("an additive model run is idempotent and deduplicates input", () => {
  const existing = curated("accounts/fireworks/models/kimi-k3");
  const result = planCuration({
    mine: [existing],
    chosen: [existing.upstreamModel, existing.upstreamModel],
    removals: [],
    interactive: false,
  });
  assert.deepEqual(result.surviving, [existing]);
  assert.deepEqual(result.additions, []);
});

test("explicit removal prunes only the named curated model", () => {
  const kept = curated("accounts/fireworks/models/kimi-k3");
  const removed = curated("accounts/fireworks/models/deepseek-v4-flash");
  const result = planCuration({
    mine: [kept, removed],
    chosen: [],
    removals: [removed.upstreamModel],
    interactive: false,
  });
  assert.deepEqual(result.surviving, [kept]);
  assert.deepEqual(result.additions, []);
});

test("--remove edits local curation without provider credentials or discovery", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "curate-models-remove-"));
  const file = path.join(dir, "user-models.json");
  const kept = curated("accounts/fireworks/models/kimi-k3");
  const removed = curated("accounts/fireworks/models/deepseek-v4-flash");
  writeFileSync(file, JSON.stringify({ version: 1, models: [kept, removed] }));
  try {
    const result = spawnSync(
      process.execPath,
      [
        path.join(root, "src", "curate-models.mjs"),
        "fireworks",
        "--remove",
        removed.upstreamModel,
        "--no-apply",
      ],
      {
        cwd: root,
        encoding: "utf8",
        env: {
          ...process.env,
          FIREWORKS_API_KEY: "",
          MODEL_ROUTER_USER_MODELS: file,
          MODEL_ROUTER_STATE_DIR: dir,
        },
      },
    );
    assert.equal(result.status, 0, result.stderr);
    const stored = JSON.parse(readFileSync(file, "utf8"));
    assert.deepEqual(stored.models, [kept]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("interactive deselection remains authoritative", () => {
  const kept = curated("accounts/fireworks/models/kimi-k3");
  const removed = curated("accounts/fireworks/models/deepseek-v4-flash");
  const result = planCuration({
    mine: [kept, removed],
    chosen: [kept.upstreamModel, "accounts/fireworks/models/glm-5.2"],
    removals: [],
    interactive: true,
  });
  assert.deepEqual(result.surviving, [kept]);
  assert.deepEqual(result.additions, ["accounts/fireworks/models/glm-5.2"]);
});

test("efforts are returned in the documented order, not the order typed", () => {
  // The stored model advertises these to the picker, where an arbitrary order
  // would present "high, low, medium" to the user.
  const parsed = parseEfforts("high,low,medium");
  assert.deepEqual(
    parsed.reasoningLevels.map((level) => level.effort),
    ["low", "medium", "high"],
  );
  for (const level of parsed.reasoningLevels) {
    assert.ok(level.description, `${level.effort} needs a description`);
  }
});

test("high is preferred as the default when offered", () => {
  assert.equal(parseEfforts("low,high,minimal").defaultEffort, "high");
});

test("without high, the strongest offered effort becomes the default", () => {
  // Falling back to the weakest would quietly downgrade every request made
  // through a curated model.
  assert.equal(parseEfforts("minimal,low").defaultEffort, "low");
  assert.equal(parseEfforts("medium,xhigh").defaultEffort, "xhigh");
});

test("an unknown effort is rejected by name", () => {
  // A typo must not be silently dropped: the model would be stored advertising
  // fewer efforts than the user asked for.
  assert.throws(() => parseEfforts("high,turbo"), /Unknown reasoning effort "turbo"/);
});

test("whitespace and casing are tolerated", () => {
  const parsed = parseEfforts(" HIGH , low ");
  assert.deepEqual(
    parsed.reasoningLevels.map((level) => level.effort),
    ["low", "high"],
  );
});

test("an empty efforts list leaves the model defaults alone", () => {
  assert.equal(parseEfforts(""), undefined);
  assert.equal(parseEfforts(" , , "), undefined);
});

test("a curated model can opt into the auto tool-choice profile", () => {
  // A reseller-hosted model whose upstream rejects tool_choice "required" is
  // otherwise unreachable: the catalog-only providers ship no registry model
  // to inherit a profile from, so the first curated model gets none.
  assert.equal(parseRequestProfile("auto-tool-choice"), "auto-tool-choice");
});

test("a curated model can opt into the narrow encrypted-schema profile", () => {
  assert.equal(
    parseRequestProfile("codex-encrypted-schema"),
    "codex-encrypted-schema",
  );
});

test("an unknown request profile is rejected by name", () => {
  // Nothing validates requestProfile downstream — the forwarder just runs no
  // branch — so a typo would store a model that silently keeps failing.
  assert.throws(() => parseRequestProfile("qwen-plan"), /Unknown request profile "qwen-plan"/);
  assert.throws(() => parseRequestProfile("auto_tool_choice"), /Unknown request profile/);
});

test("an empty request profile leaves the model without one", () => {
  assert.equal(parseRequestProfile(""), undefined);
  assert.equal(parseRequestProfile("  "), undefined);
});

test("request profile whitespace and casing are tolerated", () => {
  assert.equal(parseRequestProfile(" Auto-Tool-Choice "), "auto-tool-choice");
});

test("mixed provider families do not lend a model-specific request profile", () => {
  for (const providerId of [
    "openrouter",
    "commandcode",
    "opencode-go",
    "ollama-cloud",
    "deepseek",
  ]) {
    assert.equal(
      uniformProviderFamilyRequestProfile(
        CHECKED_IN_MODELS,
        curationProviderIds(providerId),
      ),
      undefined,
      providerId,
    );
  }
});

test("one uniform profile can span internal protocol variants", () => {
  const routes = [
    { provider: "example", requestProfile: "provider-contract" },
    { provider: "example-messages", requestProfile: "provider-contract" },
    { provider: "example-responses", requestProfile: "provider-contract" },
  ];
  assert.equal(
    uniformProviderFamilyRequestProfile(
      routes,
      ["example", "example-messages", "example-responses"],
    ),
    "provider-contract",
  );
  assert.equal(
    uniformProviderFamilyRequestProfile(
      CHECKED_IN_MODELS,
      curationProviderIds("qwen-plan"),
    ),
    "qwen-plan",
  );
});

test("a missing or different family profile prevents automatic inheritance", () => {
  assert.equal(
    uniformProviderFamilyRequestProfile([
      { provider: "example", requestProfile: "provider-contract" },
      { provider: "example-messages" },
    ], ["example", "example-messages"]),
    undefined,
  );
  assert.equal(
    uniformProviderFamilyRequestProfile([
      { provider: "example", requestProfile: "one" },
      { provider: "example-responses", requestProfile: "two" },
    ], ["example", "example-responses"]),
    undefined,
  );
});

test("scripted curation never projects a mixed family's profile onto a new model", () => {
  for (const { providerId, upstreamModel } of [
    { providerId: "openrouter", upstreamModel: "vendor/generic" },
    { providerId: "commandcode", upstreamModel: "stealth/ox-alpha" },
    { providerId: "opencode-go", upstreamModel: "x-preview-f" },
    { providerId: "ollama-cloud", upstreamModel: "vendor/generic" },
  ]) {
    const dir = mkdtempSync(path.join(os.tmpdir(), `curate-profile-${providerId}-`));
    const file = path.join(dir, "user-models.json");
    const fixture = path.join(dir, "models.json");
    writeFileSync(fixture, JSON.stringify({ data: [{ id: upstreamModel }] }));
    try {
      const result = spawnSync(
        process.execPath,
        [
          path.join(root, "src", "curate-models.mjs"),
          providerId,
          "--models",
          upstreamModel,
          "--fixture",
          fixture,
          "--no-apply",
        ],
        {
          cwd: root,
          encoding: "utf8",
          env: {
            ...process.env,
            CODEX_HOME: path.join(dir, "codex"),
            MODEL_ROUTER_STATE_DIR: dir,
            MODEL_ROUTER_USER_MODELS: file,
            MODEL_ROUTER_MODEL_PICKER_STATE: path.join(dir, "model-picker.json"),
            OPENROUTER_API_KEY: "",
            COMMAND_CODE_API_KEY: "",
            OPENCODE_API_KEY: "",
            OPENCODE_GO_API_KEY: "",
            OLLAMA_API_KEY: "",
          },
        },
      );
      assert.equal(result.status, 0, `${providerId}: ${result.stderr}`);
      const stored = JSON.parse(readFileSync(file, "utf8")).models.find(
        (model) => model.upstreamModel === upstreamModel,
      );
      assert.ok(stored, `${providerId} did not store ${upstreamModel}`);
      assert.equal(stored.requestProfile, undefined, providerId);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

test("an explicit request profile still wins when family inheritance is withheld", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "curate-profile-explicit-"));
  const file = path.join(dir, "user-models.json");
  const fixture = path.join(dir, "models.json");
  const upstreamModel = "vendor/explicit";
  writeFileSync(fixture, JSON.stringify({ data: [{ id: upstreamModel }] }));
  try {
    const result = spawnSync(
      process.execPath,
      [
        path.join(root, "src", "curate-models.mjs"),
        "openrouter",
        "--models",
        upstreamModel,
        "--request-profile",
        "auto-tool-choice",
        "--fixture",
        fixture,
        "--no-apply",
      ],
      {
        cwd: root,
        encoding: "utf8",
        env: {
          ...process.env,
          CODEX_HOME: path.join(dir, "codex"),
          MODEL_ROUTER_STATE_DIR: dir,
          MODEL_ROUTER_USER_MODELS: file,
          MODEL_ROUTER_MODEL_PICKER_STATE: path.join(dir, "model-picker.json"),
          OPENROUTER_API_KEY: "",
        },
      },
    );
    assert.equal(result.status, 0, result.stderr);
    const [stored] = JSON.parse(readFileSync(file, "utf8")).models;
    assert.equal(stored.requestProfile, "auto-tool-choice");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the picker marks selection and existing curation separately", () => {
  // Two independent facts share one row: whether this run will keep the model,
  // and whether it is already curated. Conflating them would make deselecting
  // an existing model look like a no-op.
  const rows = renderRows(
    ["gemini-3.5-flash", "gemini-3.5-pro"],
    new Set(["gemini-3.5-flash"]),
    new Set([2]),
  );
  const [first, second] = rows.split("\n");
  assert.match(first, /\[ \] 1\. gemini-3\.5-flash \(currently curated\)/);
  assert.match(second, /\[x\] 2\. gemini-3\.5-pro \(new\)/);
});

test("a curated model is sized from the context length its provider advertises", () => {
  // #266: every scripted curation stored 131072 regardless of the model. Codex
  // derives its compaction threshold from that number, so a 1,050,000-token
  // model was told to summarize at 110,000 -- and did, on every turn.
  assert.deepEqual(curatedSizing(1_050_000), {
    contextWindow: 1_050_000,
    autoCompact: 892_500,
  });
});

test("a context length that is not a whole positive count sizes nothing", () => {
  // Silence has to stay distinguishable from a number, or a catalog quirk
  // becomes a stored window.
  for (const value of [undefined, null, 0, -1, 1024.5, "200000", NaN, Infinity]) {
    assert.equal(curatedSizing(value), undefined, `${String(value)} is not a size`);
  }
});

test("scripted curation stores the advertised window, not the conservative guess", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "curate-models-context-"));
  const file = path.join(dir, "user-models.json");
  const fixture = path.join(dir, "models.json");
  writeFileSync(
    fixture,
    JSON.stringify({
      data: [
        { id: "openai/gpt-5.6-luna", context_length: 1_050_000 },
        // A model the catalog sizes in silence keeps the conservative default.
        { id: "vendor/unsized" },
      ],
    }),
  );
  try {
    const result = spawnSync(
      process.execPath,
      [
        path.join(root, "src", "curate-models.mjs"),
        "openrouter",
        "--models",
        "openai/gpt-5.6-luna,vendor/unsized",
        "--fixture",
        fixture,
        "--no-apply",
      ],
      {
        cwd: root,
        encoding: "utf8",
        env: {
          ...process.env,
          OPENROUTER_API_KEY: "",
          MODEL_ROUTER_USER_MODELS: file,
          MODEL_ROUTER_STATE_DIR: dir,
        },
      },
    );
    assert.equal(result.status, 0, result.stderr);
    const stored = JSON.parse(readFileSync(file, "utf8"));
    const luna = stored.models.find((model) => model.upstreamModel === "openai/gpt-5.6-luna");
    assert.equal(luna.contextWindow, 1_050_000);
    assert.equal(luna.autoCompact, 892_500);
    const unsized = stored.models.find((model) => model.upstreamModel === "vendor/unsized");
    assert.equal(unsized.contextWindow, 131072);
    assert.ok(unsized.autoCompact <= unsized.contextWindow);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("OpenCode Free curation migrates Muse to Responses", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "curate-opencode-free-protocol-"));
  const file = path.join(dir, "user-models.json");
  const pickerFile = path.join(dir, "model-picker.json");
  const fixture = path.join(dir, "models.json");
  const museId = "muse-spark-1.2-contributor-free";
  const oxId = "x-preview-f-free";
  const oldMuse = userModelEntry({
    providerId: "opencode-free",
    upstreamId: museId,
    priority: 147,
    requestProfile: "auto-tool-choice",
    metadata: {
      contextWindow: 1_048_576,
      autoCompact: 900_000,
      inputModalities: ["text", "image"],
      isFree: true,
    },
  });
  oldMuse.displayName = "Muse metadata from the existing curation";
  writeFileSync(file, JSON.stringify({ version: 1, models: [oldMuse] }));
  writeFileSync(pickerFile, JSON.stringify({
    version: 1,
    hidden: [],
    visible: [oldMuse.slug],
    seeded: [oldMuse.slug],
  }));
  writeFileSync(fixture, JSON.stringify({
    data: [
      { id: museId, context_length: 1_048_576 },
      // Zen currently serves this exact id-only record. The documented
      // fallback must keep a fresh scripted curation from storing 131K.
      { id: oxId },
    ],
  }));
  const env = {
    ...process.env,
    CODEX_HOME: path.join(dir, "codex"),
    MODEL_ROUTER_STATE_DIR: dir,
    MODEL_ROUTER_USER_MODELS: file,
    MODEL_ROUTER_MODEL_PICKER_STATE: pickerFile,
    OPENCODE_API_KEY: "",
    OPENCODE_GO_API_KEY: "",
  };
  const run = () => spawnSync(
    process.execPath,
    [
      path.join(root, "src", "curate-models.mjs"),
      "opencode-free",
      "--models",
      museId,
      "--fixture",
      fixture,
      "--no-apply",
    ],
    { cwd: root, encoding: "utf8", env },
  );
  try {
    const modelsBeforeDiscovery = readFileSync(file, "utf8");
    const pickerBeforeDiscovery = readFileSync(pickerFile, "utf8");
    const discovery = spawnSync(
      process.execPath,
      [
        path.join(root, "src", "model-discovery.mjs"),
        "opencode-free",
        "--fixture",
        fixture,
        "--json",
      ],
      { cwd: root, encoding: "utf8", env },
    );
    assert.equal(discovery.status, 0, discovery.stderr);
    assert.equal(readFileSync(file, "utf8"), modelsBeforeDiscovery);
    assert.equal(readFileSync(pickerFile, "utf8"), pickerBeforeDiscovery);

    const first = run();
    assert.equal(first.status, 0, first.stderr);
    const stored = JSON.parse(readFileSync(file, "utf8"));
    // The request is explicitly scoped to Muse. A withdrawn Ox id that remains
    // in a stale fixture must not be persisted as an accidental side effect.
    assert.equal(stored.models.length, 1);
    const muse = stored.models.find((model) => model.upstreamModel === museId);
    assert.equal(stored.models.some((model) => model.upstreamModel === oxId), false);
    assert.equal(muse.provider, "opencode-free-responses");
    assert.equal(muse.slug, `opencode-free-responses/${museId}`);
    assert.equal(muse.displayName, oldMuse.displayName);
    assert.equal(muse.contextWindow, oldMuse.contextWindow);
    assert.deepEqual(muse.inputModalities, oldMuse.inputModalities);
    assert.equal(muse.requestProfile, oldMuse.requestProfile);

    const picker = JSON.parse(readFileSync(pickerFile, "utf8"));
    assert.deepEqual(picker.visible, [muse.slug]);
    assert.equal(picker.visible.includes(oldMuse.slug), false);

    const configResult = spawnSync(
      process.execPath,
      [
        "-e",
        "const { renderLiteLlmConfig } = await import('./src/litellm-config.mjs');" +
          "process.stdout.write(renderLiteLlmConfig());",
      ],
      { cwd: root, encoding: "utf8", env },
    );
    assert.equal(configResult.status, 0, configResult.stderr);
    const blockFor = (gatewayModel) => {
      const start = configResult.stdout.indexOf(`model_name: "${gatewayModel}"`);
      assert.ok(start >= 0, `missing LiteLLM route for ${gatewayModel}`);
      const next = configResult.stdout.indexOf("model_name:", start + 1);
      return configResult.stdout.slice(start, next === -1 ? undefined : next);
    };
    const museBlock = blockFor(muse.gatewayModel);
    assert.match(
      museBlock,
      /model: "openai\/responses\/opencode-free-responses-muse-spark-1-2-contributor-free"/,
    );
    assert.doesNotMatch(museBlock, /use_chat_completions_api/);

    const beforeRepeat = readFileSync(file, "utf8");
    const pickerBeforeRepeat = readFileSync(pickerFile, "utf8");
    const second = run();
    assert.equal(second.status, 0, second.stderr);
    assert.equal(readFileSync(file, "utf8"), beforeRepeat);
    assert.equal(readFileSync(pickerFile, "utf8"), pickerBeforeRepeat);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("removing an old Chat-routed Muse forgets its stale picker decision", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "curate-opencode-free-remove-"));
  const file = path.join(dir, "user-models.json");
  const pickerFile = path.join(dir, "model-picker.json");
  const museId = "muse-spark-1.2-contributor-free";
  const oldMuse = userModelEntry({
    providerId: "opencode-free",
    upstreamId: museId,
    priority: 147,
  });
  writeFileSync(file, JSON.stringify({ version: 1, models: [oldMuse] }));
  writeFileSync(pickerFile, JSON.stringify({
    version: 1,
    hidden: [],
    visible: [oldMuse.slug],
    seeded: [oldMuse.slug],
  }));
  try {
    const result = spawnSync(
      process.execPath,
      [
        path.join(root, "src", "curate-models.mjs"),
        "opencode-free",
        "--remove",
        museId,
        "--no-apply",
      ],
      {
        cwd: root,
        encoding: "utf8",
        env: {
          ...process.env,
          CODEX_HOME: path.join(dir, "codex"),
          MODEL_ROUTER_STATE_DIR: dir,
          MODEL_ROUTER_USER_MODELS: file,
          MODEL_ROUTER_MODEL_PICKER_STATE: pickerFile,
          OPENCODE_API_KEY: "",
          OPENCODE_GO_API_KEY: "",
        },
      },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(readFileSync(file, "utf8")).models, []);
    const picker = JSON.parse(readFileSync(pickerFile, "utf8"));
    assert.deepEqual(picker.visible, []);
    assert.deepEqual(picker.hidden, []);
    assert.deepEqual(picker.seeded, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Committing a curated model used to shell out to bin/install, which
// reinstalls the background service and waits on its health. That installer's
// own EXIT trap disables the client config when the wait fails, so adding a
// single model could leave the router unrouted -- and on a GUI-launched app it
// failed outright, because bin/install resolves `node` by name off a PATH a
// desktop process does not inherit. Curation publishes through the shared
// overlay finalizer instead; nothing here may reach for the installer again.
test("curation publishes through the overlay finalizer, never the installer", () => {
  const source = readFileSync(path.join(root, "src", "curate-models.mjs"), "utf8");
  assert.equal(
    /bin["'\s,)\]]*\s*,\s*["']install|install\.ps1/.test(source),
    false,
    "curate-models.mjs must not invoke the installer to publish curated models",
  );
  assert.equal(
    source.includes('from "node:child_process"'),
    false,
    "curate-models.mjs must not spawn processes to publish curated models",
  );
  assert.match(source, /applyModelOverlayPublication/);
});

// A documented window is the one place this repository departs from
// "conservative default", so it has to say where the number came from. The
// checked-in precedent is config/zai/coding/glm-5.3.json, whose description
// records the probe that justified 1M. Curated entries have the same field.
test("a documented OpenCode Free window ships with the sourcing that justifies it", () => {
  for (const id of [
    "muse-spark-1.2-contributor-free",
    "muse-spark-1.3-contributor-free",
  ]) {
    const description = curatedModelDescription("opencode-free", id);
    assert.equal(typeof description, "string", `${id} has no sourcing note`);
    // Naming the figure, and naming what published it, is the whole point.
    const window = curatedModelContextLength("opencode-free", id);
    assert.ok(
      description.includes(window.toLocaleString("en-US")),
      `${id} note omits its own window`,
    );
    assert.match(description, /models\.dev/);
    assert.match(description, /free id/);
  }
  // Every other free id keeps the conservative default and earns no note.
  assert.equal(curatedModelDescription("opencode-free", "mimo-v2.5-free"), undefined);
  assert.equal(curatedModelDescription("fireworks", "x-preview-f-free"), undefined);
});

test("the Responses variant resolves the same sourcing as its base provider", () => {
  assert.equal(
    curatedModelDescription("opencode-free-responses", "muse-spark-1.2-contributor-free"),
    curatedModelDescription("opencode-free", "muse-spark-1.2-contributor-free"),
  );
  assert.equal(
    curatedModelDescription("opencode-free-responses", "muse-spark-1.3-contributor-free"),
    curatedModelDescription("opencode-free", "muse-spark-1.3-contributor-free"),
  );
});

test("OpenCode Free Muse Spark routes publish stable picker labels", async () => {
  const { curatedModelDisplayName } = await import("../src/opencode-curation.mjs");
  const { officialModelDisplayName } = await import("../src/user-models.mjs");
  for (const [providerId, upstreamId, label] of [
    [
      "opencode-free",
      "muse-spark-1.2-contributor-free",
      "Muse Spark 1.2 Contributor Free (OpenCode Free)",
    ],
    [
      "opencode-free",
      "muse-spark-1.3-contributor-free",
      "Muse Spark 1.3 Contributor Free (OpenCode Free)",
    ],
  ]) {
    assert.equal(curatedModelDisplayName(providerId, upstreamId), label);
    assert.equal(officialModelDisplayName(providerId, upstreamId), label);
    assert.equal(curatedModelDisplayName("opencode-free-responses", upstreamId), label);
    assert.equal(officialModelDisplayName("opencode-free-responses", upstreamId), label);
  }
});

test("scripted OpenCode Free curation stores the documented window and its sourcing", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "curate-opencode-free-sourcing-"));
  const file = path.join(dir, "user-models.json");
  const fixture = path.join(dir, "models.json");
  // Ox Alpha used to stand in for the documented-window case here, but that
  // OpenCode Free id was withdrawn. Nemotron 3 Ultra Free carries the same
  // shape (a published 1M window with a declared output limit) and is still
  // reached through curation.
  const oxId = "nemotron-3-ultra-free";
  const otherId = "mimo-v2.5-free";
  writeFileSync(fixture, JSON.stringify({ data: [{ id: oxId }, { id: otherId }] }));
  try {
    const result = spawnSync(
      process.execPath,
      [
        path.join(root, "src", "curate-models.mjs"),
        "opencode-free",
        "--models",
        `${oxId},${otherId}`,
        "--fixture",
        fixture,
        "--no-apply",
      ],
      {
        cwd: root,
        encoding: "utf8",
        env: {
          ...process.env,
          CODEX_HOME: path.join(dir, "codex"),
          MODEL_ROUTER_STATE_DIR: dir,
          MODEL_ROUTER_USER_MODELS: file,
          MODEL_ROUTER_MODEL_PICKER_STATE: path.join(dir, "model-picker.json"),
          OPENCODE_API_KEY: "",
          OPENCODE_GO_API_KEY: "",
        },
      },
    );
    assert.equal(result.status, 0, result.stderr);
    const stored = JSON.parse(readFileSync(file, "utf8"));
    const ox = stored.models.find((model) => model.upstreamModel === oxId);
    assert.equal(ox.contextWindow, 1_000_000);
    assert.equal(ox.autoCompact, 850_000);
    assert.equal(ox.description, curatedModelDescription("opencode-free", oxId));
    // autoCompact has to leave room for the id's published output limit, or
    // compaction never fires early enough to keep a completion inside the window.
    assert.ok(ox.contextWindow - ox.autoCompact >= curatedModelOutputLimit("opencode-free", oxId));

    const other = stored.models.find((model) => model.upstreamModel === otherId);
    assert.equal(other.contextWindow, 131072);
    assert.equal(other.description, defaultUserModelDescription("opencode-free"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});


// The context window is this repository's one departure from "conservative
// default", so a declared one has to be safe as well as sourced: Codex
// compacts at `curatedSizing`'s ratio, and whatever is left has to still hold
// a full-length completion or the turn runs past the window the entry itself
// declared. An id whose published output limit does not fit in that reserve
// keeps the default rather than declaring a number it cannot honour.
test("every documented OpenCode Free window reserves room for its output limit", () => {
  const ids = curatedModelIds("opencode-free");
  assert.ok(ids.length > 0);
  let declared = 0;
  for (const id of ids) {
    const output = curatedModelOutputLimit("opencode-free", id);
    assert.equal(typeof output, "number", `${id} records no published output limit`);
    const window = curatedModelContextLength("opencode-free", id);
    if (window === undefined) {
      // A withheld window has to say so in the entry, not only in a comment.
      assert.match(curatedModelDescription("opencode-free", id), /unknown/);
      continue;
    }
    declared += 1;
    const sizing = curatedSizing(window);
    assert.ok(
      sizing.contextWindow - sizing.autoCompact >= output,
      `${id} compacts at ${sizing.autoCompact} of ${sizing.contextWindow}, ` +
        `which leaves less than its ${output}-token output limit`,
    );
  }
  assert.ok(declared >= 1, "the documented windows regressed");
});

test("documented OpenCode Free effort ladders are real Codex efforts", () => {
  let ladders = 0;
  for (const id of curatedModelIds("opencode-free")) {
    const efforts = curatedModelReasoningLevels("opencode-free", id);
    if (!efforts) {
      // No published ladder means the entry keeps the single `high` default,
      // and its description has to admit that rather than imply a capability.
      assert.match(curatedModelDescription("opencode-free", id), /conservative default/);
      continue;
    }
    ladders += 1;
    const parsed = parseEfforts(efforts.join(","));
    assert.deepEqual(parsed.reasoningLevels.map((level) => level.effort), efforts);
    assert.equal(parsed.defaultEffort, "high");
  }
  assert.ok(ladders >= 1, "the documented effort ladders regressed");
});

test("an untuned entry gains the documented ladder while a tuned one is untouched", () => {
  const stock = userModelEntry({
    providerId: "opencode-free",
    upstreamId: "laguna-s-2.1-free",
    priority: 152,
  });
  assert.ok(hasDefaultUserModelReasoning(stock));
  const [upgraded] = normalizeCurationModels([stock], "opencode-free");
  assert.deepEqual(
    upgraded.reasoningLevels.map((level) => level.effort),
    ["low", "medium", "high"],
  );
  assert.equal(upgraded.contextWindow, 256_000);
  assert.equal(upgraded.autoCompact, 217_600);

  const muse = userModelEntry({
    providerId: "opencode-free-responses",
    upstreamId: "muse-spark-1.2-contributor-free",
    priority: 151,
    metadata: { contextWindow: 200_000, autoCompact: 170_000 },
  });
  const [upgradedMuse] = normalizeCurationModels([muse], "opencode-free");
  assert.equal(upgradedMuse.requestProfile, "auto-tool-choice");
  assert.equal(upgradedMuse.contextWindow, 200_000);
  assert.equal(upgradedMuse.autoCompact, 170_000);

  // A ladder-only id keeps the conservative window and still gains the ladder.
  const flash = userModelEntry({
    providerId: "opencode-free",
    upstreamId: "deepseek-v4-flash-free",
    priority: 153,
  });
  const [ladderOnly] = normalizeCurationModels([flash], "opencode-free");
  assert.deepEqual(
    ladderOnly.reasoningLevels.map((level) => level.effort),
    ["low", "high", "max"],
  );
  assert.equal(ladderOnly.contextWindow, DEFAULT_CONTEXT_WINDOW);
  assert.equal(ladderOnly.autoCompact, DEFAULT_AUTO_COMPACT);

  // Hand-tuned metadata survives byte for byte, ladder included.
  const tuned = {
    ...stock,
    autoCompact: 100_000,
    reasoningLevels: [{ effort: "medium", description: "Mine" }],
    defaultEffort: "medium",
  };
  assert.strictEqual(normalizeCurationModels([tuned], "opencode-free")[0], tuned);
  const tunedSizingOnly = { ...stock, contextWindow: 200_000, autoCompact: 170_000 };
  assert.strictEqual(
    normalizeCurationModels([tunedSizingOnly], "opencode-free")[0],
    tunedSizingOnly,
  );

  // An id this module documents nothing for keeps every default it started with.
  const undocumented = userModelEntry({
    providerId: "opencode-free",
    upstreamId: "mimo-v2.5-free",
    priority: 154,
  });
  assert.strictEqual(normalizeCurationModels([undocumented], "opencode-free")[0], undocumented);
});

test("a non-interactive OpenCode Free curation stores documented metadata and profiles", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "curate-opencode-free-ladders-"));
  const file = path.join(dir, "user-models.json");
  const fixture = path.join(dir, "models.json");
  const lagunaId = "laguna-s-2.1-free";
  const flashId = "deepseek-v4-flash-free";
  const museId = "muse-spark-1.2-contributor-free";
  const undocumentedId = "mimo-v2.5-free";
  // Zen serves these exact id-only records: no context limit, no effort control.
  writeFileSync(fixture, JSON.stringify({
    data: [{ id: lagunaId }, { id: flashId }, { id: museId }, { id: undocumentedId }],
  }));
  const env = {
    ...process.env,
    CODEX_HOME: path.join(dir, "codex"),
    MODEL_ROUTER_STATE_DIR: dir,
    MODEL_ROUTER_USER_MODELS: file,
    MODEL_ROUTER_MODEL_PICKER_STATE: path.join(dir, "model-picker.json"),
    OPENCODE_API_KEY: "",
    OPENCODE_GO_API_KEY: "",
  };
  const curate = (extra = []) => spawnSync(
    process.execPath,
    [
      path.join(root, "src", "curate-models.mjs"),
      "opencode-free",
      "--models",
      `${lagunaId},${flashId},${museId},${undocumentedId}`,
      "--fixture",
      fixture,
      "--no-apply",
      ...extra,
    ],
    { cwd: root, encoding: "utf8", env },
  );
  try {
    const result = curate();
    assert.equal(result.status, 0, result.stderr);
    const stored = JSON.parse(readFileSync(file, "utf8"));
    const find = (id) => stored.models.find((model) => model.upstreamModel === id);

    // Documented window and documented ladder.
    const laguna = find(lagunaId);
    assert.equal(laguna.contextWindow, 256_000);
    assert.equal(laguna.autoCompact, 217_600);
    assert.ok(
      laguna.contextWindow - laguna.autoCompact >=
        curatedModelOutputLimit("opencode-free", lagunaId),
    );
    assert.deepEqual(
      laguna.reasoningLevels.map((level) => level.effort),
      ["low", "medium", "high"],
    );
    assert.equal(laguna.defaultEffort, "high");
    assert.equal(laguna.description, curatedModelDescription("opencode-free", lagunaId));
    assert.match(laguna.description, /256,000/);
    assert.match(laguna.description, /models\.dev/);

    // Documented ladder, window deliberately left on the conservative default.
    const flash = find(flashId);
    assert.deepEqual(
      flash.reasoningLevels.map((level) => level.effort),
      ["low", "high", "max"],
    );
    assert.equal(flash.contextWindow, DEFAULT_CONTEXT_WINDOW);
    assert.equal(flash.autoCompact, DEFAULT_AUTO_COMPACT);
    // The entry itself says which half is documented and which is unknown.
    assert.match(flash.description, /unknown/);
    assert.match(flash.description, /low\/high\/max/);

    // The Responses-only Muse route gets its exact-model compatibility
    // profile without weakening any of the Chat routes beside it.
    const muse = find(museId);
    assert.equal(muse.provider, "opencode-free-responses");
    assert.equal(muse.requestProfile, "auto-tool-choice");
    assert.equal(laguna.requestProfile, undefined);

    // Nothing documented: every value stays a conservative default, and the
    // stock description keeps saying exactly that.
    const undocumented = find(undocumentedId);
    assert.equal(undocumented.contextWindow, DEFAULT_CONTEXT_WINDOW);
    assert.equal(undocumented.autoCompact, DEFAULT_AUTO_COMPACT);
    assert.ok(hasDefaultUserModelReasoning(undocumented));
    assert.equal(undocumented.description, defaultUserModelDescription("opencode-free"));

    // A rerun is additive and must not rewrite what it already stored.
    const before = readFileSync(file, "utf8");
    const second = curate();
    assert.equal(second.status, 0, second.stderr);
    assert.equal(readFileSync(file, "utf8"), before);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("--efforts still overrides a documented ladder", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "curate-opencode-free-efforts-"));
  const file = path.join(dir, "user-models.json");
  const fixture = path.join(dir, "models.json");
  const lagunaId = "laguna-s-2.1-free";
  writeFileSync(fixture, JSON.stringify({ data: [{ id: lagunaId }] }));
  try {
    const result = spawnSync(
      process.execPath,
      [
        path.join(root, "src", "curate-models.mjs"),
        "opencode-free",
        "--models",
        lagunaId,
        "--efforts",
        "medium,high",
        "--fixture",
        fixture,
        "--no-apply",
      ],
      {
        cwd: root,
        encoding: "utf8",
        env: {
          ...process.env,
          CODEX_HOME: path.join(dir, "codex"),
          MODEL_ROUTER_STATE_DIR: dir,
          MODEL_ROUTER_USER_MODELS: file,
          MODEL_ROUTER_MODEL_PICKER_STATE: path.join(dir, "model-picker.json"),
          OPENCODE_API_KEY: "",
          OPENCODE_GO_API_KEY: "",
        },
      },
    );
    assert.equal(result.status, 0, result.stderr);
    const [stored] = JSON.parse(readFileSync(file, "utf8")).models;
    assert.deepEqual(
      stored.reasoningLevels.map((level) => level.effort),
      ["medium", "high"],
    );
    // The stored ladder is the operator's, so the note must not claim OpenCode
    // published it -- while the documented window it did supply keeps its note.
    assert.equal(stored.contextWindow, 256_000);
    assert.match(stored.description, /256,000/);
    assert.doesNotMatch(stored.description, /low\/medium\/high ladder/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
