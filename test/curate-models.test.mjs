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
const { curatedSizing, parseEfforts, parseRequestProfile, planCuration, renderRows } =
  await import("../src/curate-models.mjs");
process.argv = savedArgv;
process.exitCode = 0;

const curated = (upstreamModel, metadata = {}) => ({
  upstreamModel,
  provider: "fireworks",
  ...metadata,
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
