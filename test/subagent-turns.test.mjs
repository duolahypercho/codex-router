import assert from "node:assert/strict";
import test, { beforeEach } from "node:test";

import {
  IDLE_SPAWN_MS,
  MAX_TRACKED_SPAWNS,
  SPAWN_BUDGET_MULTIPLE,
  childSpawnSnapshot,
  forgetChildSpawn,
  observeChildTurn,
  resetChildSpawns,
} from "../src/subagent-turns.mjs";

const AUTO_COMPACT = 1_000;
const BUDGET = AUTO_COMPACT * SPAWN_BUDGET_MULTIPLE;

function turn(spawnId, inputTokens) {
  return observeChildTurn({
    spawnId,
    slug: "vendor/looper",
    autoCompact: AUTO_COMPACT,
    event: { status: 200, inputTokens },
  });
}

beforeEach(() => resetChildSpawns());

// The reported gap: a child that answers turn after turn without ever
// converging emits nothing but 200s, so no status-shaped branch can see it.
// What it does emit is its own context, over and over.
test("a looping spawn crosses the ceiling its model's compaction budget sets", () => {
  // A converging child grows its context and stops. This one grows, gets
  // compacted (the prompt count falls), redoes the same opening work, and
  // compacts again -- the runaway context-window-drift.mjs describes.
  assert.equal(turn("spawn-a", 400).newInputTokens, 400);
  assert.equal(turn("spawn-a", 900).newInputTokens, 900);
  // Compaction: the count falls, and everything after it is work done twice.
  assert.equal(turn("spawn-a", 300).newInputTokens, 900);
  const stillUnder = turn("spawn-a", 900);
  assert.equal(stillUnder.newInputTokens, 1_500);
  assert.equal(stillUnder.budget, BUDGET);
  assert.equal(stillUnder.exceeded, false, "one budget of new input is a big task, not a loop");

  turn("spawn-a", 300);
  const over = turn("spawn-a", 900);
  assert.equal(over.newInputTokens, 2_100);
  assert.equal(over.turns, 6);
  assert.equal(over.exceeded, true, "a second full budget with the child still going is the loop");
});

// The property that keeps this from condemning a working model: a spawn that
// was never compacted cannot have produced more new input than its own latest
// prompt, and Codex compacts at `autoCompact`. So however many turns a big
// honest task takes, its total is capped at one budget and the two-budget
// ceiling is out of reach. Only a child that filled its context, got
// summarized, and filled it again can cross.
test("a long task that never gets compacted cannot reach the ceiling", () => {
  let last = 0;
  for (let index = 1; index <= 50; index += 1) {
    // Monotonic growth up to the compaction limit, the shape of a child that
    // is genuinely working and simply has a lot to hold.
    last = Math.min(AUTO_COMPACT, index * 40);
    const seen = turn("spawn-honest", last);
    assert.equal(seen.exceeded, false, `turn ${index} condemned a child that never compacted`);
  }
  const final = turn("spawn-honest", AUTO_COMPACT);
  assert.equal(final.turns, 51);
  assert.equal(final.newInputTokens, AUTO_COMPACT);
  assert.equal(final.newInputTokens <= final.budget / SPAWN_BUDGET_MULTIPLE, true);
});

// The counter has to survive the demotion it triggers without re-firing, and
// two children of the same parent are two spawns.
test("spawns are accounted separately and a settled one is forgotten", () => {
  turn("spawn-a", 1_500);
  turn("spawn-b", 100);
  assert.equal(childSpawnSnapshot().length, 2);
  assert.equal(turn("spawn-b", 200).newInputTokens, 200);

  forgetChildSpawn("SPAWN-A");
  assert.deepEqual(
    childSpawnSnapshot().map((entry) => entry.spawnId),
    ["spawn-b"],
    "the thread id is matched case-insensitively, the way every other UUID here is",
  );
  assert.equal(turn("spawn-a", 900).newInputTokens, 900, "a forgotten spawn starts over");
});

// A model with no declared compaction budget has no derived ceiling. Counting
// it is free; condemning it would mean inventing the number this module exists
// not to invent.
test("a model with no auto-compact budget is counted and never condemned", () => {
  const seen = observeChildTurn({
    spawnId: "spawn-c",
    slug: "vendor/unsized",
    autoCompact: undefined,
    event: { status: 200, inputTokens: 10_000_000 },
  });
  assert.equal(seen.turns, 1);
  assert.equal(seen.newInputTokens, 10_000_000);
  assert.equal(seen.budget, undefined);
  assert.equal(seen.exceeded, false);
});

// Only a prompt count the provider actually reported may move the total. The
// router substitutes an estimate when a provider reports zero, and an
// empty-completion retry bills the same prompt twice and merges both counts --
// context-window-drift.mjs refuses both as capacity evidence for exactly the
// same reason they must not be counted as a child's work here.
test("estimated, retry-doubled, and failed turns count as turns but not as tokens", () => {
  const estimated = observeChildTurn({
    spawnId: "spawn-d",
    slug: "vendor/looper",
    autoCompact: AUTO_COMPACT,
    event: { status: 200, inputTokens: 5_000, estimatedInputTokens: 5_000 },
  });
  assert.equal(estimated.turns, 1);
  assert.equal(estimated.newInputTokens, 0);

  const retried = observeChildTurn({
    spawnId: "spawn-d",
    slug: "vendor/looper",
    autoCompact: AUTO_COMPACT,
    event: { status: 200, inputTokens: 5_000, emptyCompletionRetried: true },
  });
  assert.equal(retried.turns, 2);
  assert.equal(retried.newInputTokens, 0);

  const progressOnly = observeChildTurn({
    spawnId: "spawn-d",
    slug: "vendor/looper",
    autoCompact: AUTO_COMPACT,
    event: { status: 200, inputTokens: 5_000, progressOnlyRetried: true },
  });
  assert.equal(progressOnly.turns, 3);
  assert.equal(progressOnly.newInputTokens, 0);

  const failed = observeChildTurn({
    spawnId: "spawn-d",
    slug: "vendor/looper",
    autoCompact: AUTO_COMPACT,
    event: { status: 503, inputTokens: 5_000 },
  });
  assert.equal(failed.turns, 4);
  assert.equal(failed.newInputTokens, 0);

  // The next believable sample folds in the growth the skipped ones hid, so a
  // badly metering provider slows the accounting rather than corrupting it.
  const believable = observeChildTurn({
    spawnId: "spawn-d",
    slug: "vendor/looper",
    autoCompact: AUTO_COMPACT,
    event: { status: 200, inputTokens: 5_000 },
  });
  assert.equal(believable.newInputTokens, 5_000);
  // Still not a loop: one accepted prompt is one prompt, and the ceiling is
  // measured against the largest this spawn has actually been allowed to send.
  assert.equal(believable.budget, 10_000);
  assert.equal(believable.exceeded, false);
});

// The registry validator permits any `1 <= autoCompact <= contextWindow`, and
// one oversized tool result can carry a single turn well past the compaction
// limit in one step. Neither may be enough to condemn a model, so the ceiling
// is taken against the larger of the declared budget and what this spawn has
// actually had accepted.
test("a single oversized prompt cannot condemn a model whose declared budget is small", () => {
  const tiny = 100;
  const huge = observeChildTurn({
    spawnId: "spawn-oversized",
    slug: "vendor/understated",
    autoCompact: tiny,
    event: { status: 200, inputTokens: 500_000 },
  });
  assert.equal(huge.newInputTokens, 500_000);
  assert.equal(huge.budget, 1_000_000, "the ceiling followed the prompt the provider accepted");
  assert.equal(huge.exceeded, false);

  // It still condemns the same spawn once it has been summarized and has
  // filled that much again, twice over: the ceiling moved with the prompt, it
  // did not go away.
  let looping;
  for (const inputTokens of [10_000, 500_000, 10_000, 500_000]) {
    looping = observeChildTurn({
      spawnId: "spawn-oversized",
      slug: "vendor/understated",
      autoCompact: tiny,
      event: { status: 200, inputTokens },
    });
  }
  assert.equal(looping.newInputTokens, 1_480_000);
  assert.equal(looping.budget, 1_000_000);
  assert.equal(looping.exceeded, true);
});

// Without a thread id there is no way to tell one child from the next, and
// merging two children's turns would demote a model for someone else's
// traffic.
test("a turn that cannot be attributed to a spawn is not accounted at all", () => {
  assert.equal(observeChildTurn({ spawnId: "", slug: "vendor/looper" }), undefined);
  assert.equal(observeChildTurn({ spawnId: "spawn-e", slug: "" }), undefined);
  assert.deepEqual(childSpawnSnapshot(), []);
});

// A thread id reused on a different model is a different spawn, not a
// continuation: the totals must not merge.
test("a spawn id seen on another model starts fresh", () => {
  observeChildTurn({
    spawnId: "spawn-f",
    slug: "vendor/one",
    autoCompact: AUTO_COMPACT,
    event: { status: 200, inputTokens: 1_900 },
  });
  const other = observeChildTurn({
    spawnId: "spawn-f",
    slug: "vendor/two",
    autoCompact: AUTO_COMPACT,
    event: { status: 200, inputTokens: 1_900 },
  });
  assert.equal(other.turns, 1);
  assert.equal(other.newInputTokens, 1_900);
  assert.equal(other.exceeded, false);
});

// The map is per live spawn, not per turn, but a router runs for weeks: an
// abandoned child must not hold a slot forever, and a busy one must not grow
// the map without bound.
test("idle spawns expire and the map stays bounded", () => {
  const start = 1_000_000;
  observeChildTurn({
    spawnId: "spawn-old",
    slug: "vendor/looper",
    autoCompact: AUTO_COMPACT,
    event: { status: 200, inputTokens: 10 },
    now: start,
  });
  observeChildTurn({
    spawnId: "spawn-new",
    slug: "vendor/looper",
    autoCompact: AUTO_COMPACT,
    event: { status: 200, inputTokens: 10 },
    now: start + IDLE_SPAWN_MS + 1,
  });
  assert.deepEqual(
    childSpawnSnapshot().map((entry) => entry.spawnId),
    ["spawn-new"],
  );

  resetChildSpawns();
  for (let index = 0; index < MAX_TRACKED_SPAWNS + 10; index += 1) {
    observeChildTurn({
      spawnId: `spawn-${index}`,
      slug: "vendor/looper",
      autoCompact: AUTO_COMPACT,
      event: { status: 200, inputTokens: 10 },
    });
  }
  const snapshot = childSpawnSnapshot();
  assert.equal(snapshot.length, MAX_TRACKED_SPAWNS);
  // LRU: the coldest spawns went, the newest stayed.
  assert.equal(snapshot.at(-1).spawnId, `spawn-${MAX_TRACKED_SPAWNS + 9}`);
  assert.equal(snapshot.at(0).spawnId, "spawn-10");
});
