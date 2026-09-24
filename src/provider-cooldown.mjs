import { canonicalProviderId } from "./provider-selection.mjs";

// The cooldown identity, shared by everything that records or reads a provider
// window: `model-failover.mjs` owns the windows themselves in
// `provider-cooldowns.json`, `api-forwarder.mjs` files harvested quota headers
// in `rate-limits.json`, and `router.mjs` reads both. One function is what
// keeps those stores from drifting back apart under two names for the same
// subscription.
//
// Protocol variants of one subscription share the same upstream allowance.
// opencode Zen is the exception: it shares a credential and selection toggle
// with Go, but it uses the separately billed /zen endpoint. Exhausting Go must
// not disable a route the operator can still pay for through Zen.
export function cooldownScope(providerId) {
  if (providerId === "opencode-zen" || String(providerId).startsWith("opencode-zen-")) {
    return "opencode-zen";
  }
  return canonicalProviderId(providerId);
}
