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
} =
  await import("../src/curate-models.mjs");
const {
  curatedModelContextLength,
  curatedModelDescription,
  curatedModelProviderId,
  curationProviderIds,
} = await import("../src/opencode-curation.mjs");
const { defaultUserModelDescription, userModelEntry } =
  await import("../src/user-models.mjs");
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

test("OpenCode curation pairs only the anonymous Free protocol variants", () => {
  assert.deepEqual(curationProviderIds("opencode-free"), [
    "opencode-free",
    "opencode-free-responses",
  ]);
  assert.deepEqual(curationProviderIds("opencode-free-responses"), [
    "opencode-free",
    "opencode-free-responses",
  ]);
  assert.deepEqual(curationProviderIds("opencode-zen"), ["opencode-zen"]);
  assert.deepEqual(curationProviderIds("opencode-go"), ["opencode-go"]);
  assert.deepEqual(curationProviderIds("opencode-go-messages"), ["opencode-go-messages"]);
  assert.equal(
    curatedModelProviderId("opencode-free", "muse-spark-1.2-contributor-free"),
    "opencode-free-responses",
  );
  assert.equal(
    curatedModelProviderId("opencode-zen", "muse-spark-1.2"),
    "opencode-zen",
  );
  assert.equal(
    curatedModelProviderId("opencode-free", "x-preview-f-free"),
    "opencode-free",
  );
});

test("OpenCode Free curation knows the documented windows its live catalog omits", () => {
  assert.equal(
    curatedModelContextLength("opencode-free", "muse-spark-1.2-contributor-free"),
    1_048_576,
  );
  assert.equal(
    curatedModelContextLength("opencode-free", "x-preview-f-free"),
    1_000_000,
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
    [correct],
  );

  const defaultOx = userModelEntry({
    providerId: "opencode-free",
    upstreamId: "x-preview-f-free",
    priority: 149,
  });
  const [sizedOx] = normalizeCurationModels([defaultOx], "opencode-free");
  assert.equal(sizedOx.contextWindow, 1_000_000);
  assert.equal(sizedOx.autoCompact, 850_000);

  const tunedOx = { ...defaultOx, autoCompact: 100_000 };
  assert.strictEqual(normalizeCurationModels([tunedOx], "opencode-free")[0], tunedOx);
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

test("OpenCode Free curation migrates Muse to Responses while Ox stays on Chat", () => {
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
      `${museId},${oxId}`,
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
    assert.equal(stored.models.length, 2);
    const muse = stored.models.find((model) => model.upstreamModel === museId);
    const ox = stored.models.find((model) => model.upstreamModel === oxId);
    assert.equal(muse.provider, "opencode-free-responses");
    assert.equal(muse.slug, `opencode-free-responses/${museId}`);
    assert.equal(muse.displayName, oldMuse.displayName);
    assert.equal(muse.contextWindow, oldMuse.contextWindow);
    assert.deepEqual(muse.inputModalities, oldMuse.inputModalities);
    assert.equal(muse.requestProfile, oldMuse.requestProfile);
    assert.equal(ox.provider, "opencode-free");
    assert.equal(ox.slug, `opencode-free/${oxId}`);
    assert.equal(ox.contextWindow, 1_000_000);
    assert.equal(ox.autoCompact, 850_000);

    const picker = JSON.parse(readFileSync(pickerFile, "utf8"));
    assert.deepEqual(picker.visible, [muse.slug, ox.slug].sort());
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
    const oxBlock = blockFor(ox.gatewayModel);
    assert.match(oxBlock, /model: "openai\/opencode-free-x-preview-f-free"/);
    assert.match(oxBlock, /use_chat_completions_api: true/);

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

test("removing an old Chat-routed Muse does not create a stale Responses picker entry", () => {
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
    assert.deepEqual(picker.visible, [oldMuse.slug]);
    assert.equal(
      picker.visible.includes(`opencode-free-responses/${museId}`),
      false,
    );
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
  for (const id of ["muse-spark-1.2-contributor-free", "x-preview-f-free"]) {
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
});

test("upgrading an untuned window replaces the note that called it a default", () => {
  const defaultOx = userModelEntry({
    providerId: "opencode-free",
    upstreamId: "x-preview-f-free",
    priority: 149,
  });
  assert.equal(defaultOx.description, defaultUserModelDescription("opencode-free"));
  const [sized] = normalizeCurationModels([defaultOx], "opencode-free");
  assert.equal(sized.contextWindow, 1_000_000);
  assert.equal(sized.description, curatedModelDescription("opencode-free", "x-preview-f-free"));

  // A description the operator wrote is theirs; the sizing upgrade still runs.
  const annotated = { ...defaultOx, description: "My own note." };
  const [keptNote] = normalizeCurationModels([annotated], "opencode-free");
  assert.equal(keptNote.description, "My own note.");
  assert.equal(keptNote.contextWindow, 1_000_000);

  // A tuned window is not upgraded, so its description is not rewritten either.
  const tuned = { ...defaultOx, autoCompact: 100_000 };
  assert.strictEqual(normalizeCurationModels([tuned], "opencode-free")[0], tuned);
});

test("scripted OpenCode Free curation stores the documented window and its sourcing", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "curate-opencode-free-sourcing-"));
  const file = path.join(dir, "user-models.json");
  const fixture = path.join(dir, "models.json");
  const oxId = "x-preview-f-free";
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
    // autoCompact has to leave room for the published 131,072 output limit, or
    // compaction never fires early enough to keep a completion inside the window.
    assert.ok(ox.contextWindow - ox.autoCompact >= 131_072);

    const other = stored.models.find((model) => model.upstreamModel === otherId);
    assert.equal(other.contextWindow, 131072);
    assert.equal(other.description, defaultUserModelDescription("opencode-free"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
