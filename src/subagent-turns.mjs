import { acceptedInputTokens } from "./context-window-drift.mjs";

// Per-spawn accounting for child turns, and the only signal the router has
// that a child is looping rather than working.
//
// The router sees HTTP turns, not agent lifecycles: a child makes one turn per
// tool-call round trip and the loop stringing them together is Codex's. So
// "the child reached done" is not observable here, and neither is a terminal
// turn in any positive sense -- the turn that ended a spawn is only knowable
// afterwards, by no further turn arriving on that thread. That is exactly why
// no positive terminal-turn detector is needed: a ceiling can only ever be
// crossed by a spawn that is *still producing turns*, which is the same
// statement as "this spawn has not converged". A converged child stops, and a
// spawn that stopped never reaches the ceiling.
//
// What has to be defensible is the ceiling, and the repository already names
// both the pathology and its unit. `context-window-drift.mjs` describes the
// runaway shape verbatim: a task that opens above its own compaction
// threshold, summarizes, "lose[s] the agent's working state, redo[es] the same
// opening work, and compact[s] again without ever finishing. Nothing errors.
// The session simply never ends" -- the same failure the v0.4.0-beta.4
// changelog records for understated windows (#266). The unit in that sentence
// is the model's auto-compact budget, which every listed model already carries
// (`autoCompact`, validated in model-registry.mjs and derived from the
// provider's own declared window at AUTO_COMPACT_RATIO). It is per model, it
// is published by the provider, and nobody here invented it.
//
// The multiple is read off the same sentence. One compaction budget of new
// input is a large but legitimate task -- a child that reads a big file
// reaches it honestly. It is *compacting again* that names the runaway, so the
// ceiling is two budgets of new input with the child still going.
//
// That multiple is also what makes a false demotion structurally impossible
// rather than merely unlikely, which matters because a false demotion silently
// drops a working model from the picker and only a hand-run
// `control subagents verify` restores it. A spawn that has never been
// compacted cannot have produced more new input than its own largest prompt,
// so the ceiling is taken against whichever is bigger, the model's declared
// budget or the largest prompt this spawn has actually had accepted. An
// uncompacted spawn's total is then exactly half its own ceiling, however long
// its task runs and whatever the catalog declares -- the invariant holds even
// for a model whose `autoCompact` sits far below its window, which the registry
// validator permits (it requires only 1 <= autoCompact <= contextWindow), and
// for the single oversized tool result that can carry one turn past the
// compaction limit in one step. Crossing the ceiling therefore requires the
// child to have filled its context, been summarized, and filled it again
// without stopping. That is not a big task; it is the runaway, stated in the
// only unit the router can see.
//
// One thing this cannot separate, and does not pretend to: Codex reuses a
// child thread for a FOLLOWUP_TASK, so a thread that is delegated to twice is
// one spawn here. That is the conservative reading -- the child's context does
// carry across, so the tokens really are cumulative -- and a child left idle
// between delegations is expired by IDLE_SPAWN_MS below rather than
// accumulating forever.
export const SPAWN_BUDGET_MULTIPLE = 2;

// The counter is per spawn, so it grows with concurrent children rather than
// with traffic; Codex is configured for six threads per session
// (`max_concurrent_threads_per_session`, config-manager.mjs). 256 follows the
// agent payload cache's bound, and eviction is LRU so a busy router drops the
// coldest spawn rather than the newest.
export const MAX_TRACKED_SPAWNS = 256;

// A spawn nobody has sent a turn for in this long is over, whatever ended it.
// The same 15 minutes the router uses to decide an in-flight request leaked:
// no single Codex turn streams for that long, so a gap that size is not a
// child still thinking.
export const IDLE_SPAWN_MS = 15 * 60_000;

// spawnId -> { slug, turns, newInputTokens, lastInputTokens, startedAt, updatedAt }
// Insertion order is the LRU order: every touched spawn is re-inserted last.
const spawns = new Map();

function prune(now) {
  for (const [id, state] of spawns) {
    if (now - state.updatedAt > IDLE_SPAWN_MS) spawns.delete(id);
  }
  while (spawns.size > MAX_TRACKED_SPAWNS) {
    const oldest = spawns.keys().next();
    if (oldest.done) break;
    spawns.delete(oldest.value);
  }
}

function spawnKey(spawnId) {
  return typeof spawnId === "string" && spawnId.trim()
    ? spawnId.trim().toLowerCase()
    : undefined;
}

// Record one observed child turn against its spawn.
//
// `event` is the shape context-window-drift.mjs already judges: only a turn
// the provider answered 200 with a reported (not estimated, not
// retry-doubled) prompt count is allowed to move the token total, because an
// estimate the router invented cannot be evidence about how much the child
// actually sent. A skipped sample still counts as a turn, and the next
// believable sample folds its growth in, so a provider that meters badly slows
// the accounting down rather than corrupting it. (The router's own caller
// only reaches here for clean 200s; the non-200 case is reachable through
// this module's own contract and is defined rather than left to chance.)
//
// Returns undefined when the turn cannot be attributed to a spawn -- no
// thread id means no way to tell one child from the next, and guessing would
// demote a model for someone else's traffic.
export function observeChildTurn({
  spawnId,
  slug,
  autoCompact,
  event,
  now = Date.now(),
} = {}) {
  const id = spawnKey(spawnId);
  if (!id) return undefined;
  const model = String(slug || "");
  if (!model) return undefined;
  const previous = spawns.get(id);
  // A thread id that comes back on a different model is a different spawn.
  // Codex cannot change a child's model mid-thread, so this only guards
  // against merging two spawns that happened to collide.
  const state =
    previous && previous.slug === model
      ? previous
      : {
          slug: model,
          turns: 0,
          newInputTokens: 0,
          lastInputTokens: 0,
          peakInputTokens: 0,
          startedAt: now,
        };
  state.turns += 1;
  state.updatedAt = now;
  const accepted = acceptedInputTokens(event);
  if (accepted !== undefined) {
    // Every child turn resends the whole conversation, so the prompt count is
    // the conversation so far and its growth is what the child newly produced.
    // A compaction makes the count fall; everything after the fall is new work
    // the child has to do again, which is precisely what is being counted.
    state.newInputTokens += Math.max(0, accepted - state.lastInputTokens);
    state.lastInputTokens = accepted;
    state.peakInputTokens = Math.max(state.peakInputTokens, accepted);
  }
  spawns.delete(id);
  spawns.set(id, state);
  prune(now);
  const declared = Number.isInteger(autoCompact) && autoCompact > 0 ? autoCompact : 0;
  // Whichever is bigger: what the catalog says the child may hold, and what
  // this provider has actually accepted from it. The second term is what keeps
  // one very large legitimate prompt from being read as a loop.
  const held = Math.max(declared, state.peakInputTokens);
  const budget = declared > 0 ? held * SPAWN_BUDGET_MULTIPLE : undefined;
  return {
    turns: state.turns,
    newInputTokens: state.newInputTokens,
    budget,
    // A model with no declared compaction budget has no derived ceiling, so it
    // is counted and never demoted on this signal. Inventing one for it is the
    // thing this module exists not to do.
    exceeded: budget !== undefined && state.newInputTokens > budget,
  };
}

// Drop a spawn the router has already settled a verdict on, so a child that
// keeps answering after its slug was demoted does not keep re-firing.
export function forgetChildSpawn(spawnId) {
  const id = spawnKey(spawnId);
  if (id) spawns.delete(id);
}

export function childSpawnSnapshot() {
  return [...spawns.entries()].map(([spawnId, state]) => ({ spawnId, ...state }));
}

export function resetChildSpawns() {
  spawns.clear();
}
