import assert from "node:assert/strict";
import test from "node:test";

// curate-models.mjs validates process.argv at module scope and exits when the
// provider is missing, so give it a real invocation before importing. This is
// the flow PR #76 tried to bypass by hardcoding models, and it had no test
// coverage of any kind.
const savedArgv = [...process.argv];
process.argv = [process.argv[0], "curate-models.mjs", "gemini-api"];
const { parseEfforts, parseRequestProfile, renderRows } = await import(
  "../src/curate-models.mjs"
);
process.argv = savedArgv;
process.exitCode = 0;

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
