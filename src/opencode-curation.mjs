// OpenCode's anonymous catalog exposes one documented free model on Responses.
// Keep this mapping deliberately separate from paid Zen and the Go subscription
// family: those providers have different catalogs and billing semantics.
const CURATION_ROUTES = Object.freeze({
  "opencode-free": Object.freeze({
    providers: Object.freeze(["opencode-free", "opencode-free-responses"]),
    responsesProvider: "opencode-free-responses",
    responsesModels: Object.freeze(["muse-spark-1.2-contributor-free"]),
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
