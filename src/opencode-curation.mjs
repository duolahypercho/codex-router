// OpenCode's anonymous catalog exposes one documented free model on Responses.
// Keep this mapping deliberately separate from paid Zen and the Go subscription
// family: those providers have different catalogs and billing semantics.
const CURATION_ROUTES = Object.freeze({
  "opencode-free": Object.freeze({
    providers: Object.freeze(["opencode-free", "opencode-free-responses"]),
    responsesProvider: "opencode-free-responses",
    responsesModels: Object.freeze(["muse-spark-1.2-contributor-free"]),
    // Zen's live /models response currently publishes only ids. OpenCode's
    // published model metadata sizes these exact free routes, so
    // keep scripted curation from falling back to the generic 131K guess and
    // making Codex compact every tool-bearing turn. A future catalog value is
    // still preferred by curate-models because it describes the served route.
    contextWindows: Object.freeze({
      "muse-spark-1.2-contributor-free": 1_048_576,
      "x-preview-f-free": 1_000_000,
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
