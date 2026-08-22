// OpenCode's anonymous catalog exposes one documented free model on Responses.
// Keep this mapping deliberately separate from paid Zen and the Go subscription
// family: those providers have different catalogs and billing semantics.
const CURATION_ROUTES = Object.freeze({
  "opencode-free": Object.freeze({
    providers: Object.freeze(["opencode-free", "opencode-free-responses"]),
    responsesProvider: "opencode-free-responses",
    responsesModels: Object.freeze(["muse-spark-1.2-contributor-free"]),
    // Zen's live /models response publishes ids, `object`, `created`, and
    // `owned_by` -- no context limit for any model. Without a documented size
    // these two ids fall back to the generic 131K guess and Codex compacts
    // every tool-bearing turn on a million-token route.
    //
    // The sizes below come from OpenCode's own published model metadata (the
    // `opencode` provider in https://models.dev/api.json, whose record points
    // at https://opencode.ai/zen/v1 and https://opencode.ai/docs/zen). That
    // dataset keys `limit` per *free id*, not per model, and demonstrably
    // records a smaller window when the free route is capped below the paid
    // one -- `deepseek-v4-flash` publishes 1,000,000 while
    // `deepseek-v4-flash-free` publishes 200,000, and `minimax-m3` publishes
    // 512,000 against `minimax-m3-free`'s 200,000. So a free id's figure is
    // the free route's own served cap, and these two are safe to declare:
    // `muse-spark-1.2-contributor-free` matches its paid twin rather than
    // being throttled, and `x-preview-f-free` has no paid Ox counterpart in
    // the catalog at all for a model-level number to have leaked in from.
    //
    // `curatedSizing` derives autoCompact at 0.85, which leaves 157,287 and
    // 150,000 tokens respectively -- both above each id's published 131,072
    // output limit, so compaction fires before a completion can overrun the
    // window. The evidence is restated in `descriptions` because that is where
    // this repository records a context window that is not a conservative
    // default (see config/zai/coding/glm-5.3.json). A future value in Zen's
    // own /models response is still preferred by curate-models, because that
    // one describes the served route first-hand.
    contextWindows: Object.freeze({
      "muse-spark-1.2-contributor-free": 1_048_576,
      "x-preview-f-free": 1_000_000,
    }),
    descriptions: Object.freeze({
      "muse-spark-1.2-contributor-free":
        "Muse Spark 1.2 Contributor Free through OpenCode Zen's anonymous Responses route. " +
        "The 1,048,576-token window is OpenCode's own published figure for this exact free id " +
        "(the `opencode` provider in models.dev/api.json), not the paid model's: that dataset " +
        "publishes a smaller window on free ids whose route is capped below their paid twin, " +
        "and this one is not. Zen's /models endpoint publishes no context limits.",
      "x-preview-f-free":
        "Ox Alpha Free through OpenCode Zen's anonymous Chat Completions route. " +
        "The 1,000,000-token window is OpenCode's own published figure for this exact free id " +
        "(the `opencode` provider in models.dev/api.json); the catalog carries no paid Ox entry " +
        "for a model-level number to have been copied from, and it publishes a smaller window " +
        "on free ids whose route is capped lower. Zen's /models endpoint publishes no context " +
        "limits.",
    }),
  }),
});

const PRIMARY_BY_PROVIDER = new Map(
  Object.entries(CURATION_ROUTES).flatMap(([primary, route]) =>
    route.providers.map((provider) => [provider, primary]),
  ),
);

export function curationPrimaryProviderId(providerId) {
  return PRIMARY_BY_PROVIDER.get(providerId) || providerId;
}

export function curationProviderIds(providerId) {
  const primary = curationPrimaryProviderId(providerId);
  return [...(CURATION_ROUTES[primary]?.providers || [primary])];
}

export function curatedModelProviderId(providerId, upstreamModel) {
  const primary = curationPrimaryProviderId(providerId);
  const route = CURATION_ROUTES[primary];
  if (route?.responsesModels.includes(upstreamModel)) return route.responsesProvider;
  return primary;
}

export function curatedModelContextLength(providerId, upstreamModel) {
  const primary = curationPrimaryProviderId(providerId);
  return CURATION_ROUTES[primary]?.contextWindows?.[upstreamModel];
}

// The picker text that carries the sourcing for a documented context window.
// Only defined for an id this module sizes; every other curated model keeps
// the generic "conservative default metadata" description it earns.
export function curatedModelDescription(providerId, upstreamModel) {
  const primary = curationPrimaryProviderId(providerId);
  return CURATION_ROUTES[primary]?.descriptions?.[upstreamModel];
}
