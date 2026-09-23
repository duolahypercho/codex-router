// One list of the Grok OAuth routes that run the bridge's agentic adaptations,
// instead of the literal "grok-oauth/grok-4.6" that used to be repeated across
// the forwarder, the router, the tool facade, the patch hook, and diagnostics.
//
// What belongs here and what does not:
//
//   * A *capability* never belongs here. What a route advertises — its effort
//     ladder, its service tiers, hosted search — is already declared by its
//     registry entry, and `hostedSearchEnabledFor` in the forwarder is the
//     existing shape for reading one back. Naming a model twice is how the two
//     copies drift.
//   * A *workaround* does belong here. Each of these is an observed shape of
//     the xAI OAuth bridge rather than a property of one model: the native
//     Codex `view_image` name that the upstream declines to call, the V4A
//     examples that keep `apply_patch` payloads out of markdown fences, the
//     structured-patch and patch-hook experiments (both off unless their env
//     switch is set), and the ingress byte split recorded for this bridge.
//     They were proven on grok-4.6 and re-checked on grok-4.7, which is the
//     same agentic family reached over the same endpoint with the same tool
//     surface.
//
// A new Grok OAuth model is added to these lists only after its own live
// check, never on family resemblance alone: the point of widening a
// workaround is that the defect was seen again, not that the name rhymes.

export const GROK_OAUTH_PROVIDER = "grok-oauth";

export const GROK_OAUTH_AGENTIC_SLUGS = Object.freeze([
  "grok-oauth/grok-4.6",
  "grok-oauth/grok-4.7",
]);

export const GROK_OAUTH_AGENTIC_MODELS = Object.freeze([
  "grok-4.6",
  "grok-4.7",
]);

export function isGrokOauthAgenticRoute(route) {
  return GROK_OAUTH_AGENTIC_SLUGS.includes(route?.slug);
}

export function isGrokOauthAgenticSlug(slug) {
  return GROK_OAUTH_AGENTIC_SLUGS.includes(slug);
}

// The forwarder receives the upstream model id, not the slug: LiteLLM has
// already translated the OAuth route by the time a request arrives.
export function isGrokOauthAgenticModel(upstreamModel) {
  return GROK_OAUTH_AGENTIC_MODELS.includes(upstreamModel);
}
