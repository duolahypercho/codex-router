// A declared context window is a claim, and every successful turn is evidence
// against it. When a provider answered 200 to a prompt larger than the window
// we advertise, the window is not "probably" wrong -- the provider itself
// disproved it, and the only question is by how much.
//
// This matters because the failure is silent and asymmetric. Codex compacts at
// the auto-compact limit derived from that window, so an understated window
// makes a legitimate task open above its own compaction threshold, summarize,
// lose the agent's working state, redo the same opening work, and compact
// again without ever finishing. Nothing errors. The session simply never ends,
// and the model takes the blame. An overstated window fails the honest way
// instead: one upstream rejection that names the real limit.
//
// The evidence is already on disk. This reads it rather than probing, so the
// check costs no quota and no network.

// A provider reporting more input tokens than it could possibly have accepted
// is a metering bug, not a window discovery. Anything beyond this multiple of
// the declared window is treated as unusable rather than believed.
const IMPLAUSIBLE_MULTIPLE = 64;

function positiveInteger(value) {
  return Number.isInteger(value) && value > 0 ? value : undefined;
}

// Only a turn the provider actually accepted proves capacity. A failed turn
// proves nothing: the request may have been rejected for exactly this reason.
// Estimated counts prove nothing either -- the router substitutes those when a
// provider reports zero, and an estimate cannot disprove a provider's own
// limit.
export function acceptedInputTokens(event) {
  if (event?.status !== 200) return undefined;
  if (event?.estimatedInputTokens !== undefined) return undefined;
  return positiveInteger(event?.inputTokens);
}

// Highest accepted prompt per model slug. Keyed on the routed slug rather than
// the upstream model name on purpose: the same model reached through two
// providers is two different ceilings, because resellers and subscription
// endpoints enforce their own.
export function observedCeilings(events) {
  const highest = new Map();
  for (const event of events ?? []) {
    const accepted = acceptedInputTokens(event);
    if (accepted === undefined) continue;
    const slug = typeof event.model === "string" ? event.model : undefined;
    if (!slug) continue;
    if (accepted > (highest.get(slug) ?? 0)) highest.set(slug, accepted);
  }
  return highest;
}

// Models whose own traffic contradicts their declared window, worst first.
// `models` is any list carrying { slug, contextWindow, autoCompact }; `ceilings`
// is a slug -> highest-accepted-prompt Map, from observedCeilings() or from
// usage-events' own streaming scan when the full ledger is too large to parse
// into an array.
export function contextWindowDrift(models, ceilings) {
  const highest = ceilings instanceof Map ? ceilings : observedCeilings(ceilings);
  const drift = [];
  for (const model of models ?? []) {
    const declared = positiveInteger(model?.contextWindow);
    const observed = highest.get(model?.slug);
    if (!declared || !observed || observed <= declared) continue;
    if (observed > declared * IMPLAUSIBLE_MULTIPLE) continue;
    drift.push({
      slug: model.slug,
      declared,
      observed,
      autoCompact: positiveInteger(model?.autoCompact),
      // How much capacity the declaration is hiding. Reported as a ratio
      // because that is what decides whether this is a rounding disagreement
      // or a model being run at a quarter of its size.
      ratio: Number((observed / declared).toFixed(2)),
    });
  }
  return drift.sort((left, right) => right.ratio - left.ratio);
}

export function describeContextWindowDrift(drift) {
  if (!drift?.length) return undefined;
  const worst = drift
    .slice(0, 3)
    .map((entry) => `${entry.slug} declares ${entry.declared} but accepted ${entry.observed}`)
    .join("; ");
  const rest = drift.length > 3 ? `, and ${drift.length - 3} more` : "";
  return `${worst}${rest}`;
}
