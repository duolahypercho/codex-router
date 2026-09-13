// Moonshot accepts only pure `$ref` pointers into `#/$defs/`, and rejects the
// whole request -- not the one tool -- over any other pointer (issue #353), a
// definition reference carrying sibling keywords, or a node inside a union that
// declares no `type` (issue #641). The OAuth and platform-key routes are
// separate products, but their first-party validators share this schema flavor.
// Console Go's Kimi K2.7 Code route has returned the same validator error
// (#488), so it is included as an exact measured route without projecting the
// behavior onto unrelated OpenCode Go models.
//
// The set lives here rather than in `router.mjs` because the tool-schema
// repairs Moonshot needs do not all happen in one hop: the forwarder applies
// the recursion flattening, and it must be able to ask the same question.
const MOONSHOT_PROVIDER_IDS = new Set(["kimi-oauth", "kimi-api", "kimi-api-cn"]);
const OPENCODE_GO_MOONSHOT_MODELS = new Set(["kimi-k2.7-code"]);

export function moonshotSchemaRoute(providerId, upstreamModel) {
  return (
    MOONSHOT_PROVIDER_IDS.has(providerId) ||
    (providerId === "opencode-go" && OPENCODE_GO_MOONSHOT_MODELS.has(upstreamModel))
  );
}
