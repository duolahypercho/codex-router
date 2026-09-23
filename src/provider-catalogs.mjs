import { PROVIDERS } from "./model-registry.mjs";
import { forgetProviderCatalogCaches } from "./model-catalog-cache.mjs";

// Catalog capability belongs to the backend registry, not to a frontend
// denylist. Most OpenAI-compatible providers expose GET /models, while local
// inventories have their own richer UI and per-model containers have no
// single endpoint to ask. Devin is the narrow OAuth exception: its official
// CLI session exposes the account's Cascade model configuration.
const LOCAL_INVENTORY_PROVIDERS = new Set(["local", "lmstudio"]);

export function providerCatalogKind(provider) {
  if (provider?.id === "devin-cli") return "devin";
  // Vertex lists Model Garden publisher models, not GET /models. Treating it
  // as a models-endpoint would send curation at aiplatform.googleapis.com/v1/models.
  if (provider?.protocol === "vertex") return "vertex";
  if (
    provider?.kind === "openai-compatible"
    && !provider.perModelEndpoint
    && !LOCAL_INVENTORY_PROVIDERS.has(provider.id)
  ) return "models-endpoint";
  return undefined;
}

function catalogIdentity(provider) {
  if (providerCatalogKind(provider) === "devin") return "devin-cli";
  if (providerCatalogKind(provider) === "vertex") return "vertex";
  return `${provider.baseUrlEnv || ""}\0${provider.baseUrl || ""}`;
}

export function providerCatalogRouteIds(providerId, providers = PROVIDERS) {
  const provider = providers.get(providerId);
  if (!provider || !providerCatalogKind(provider)) return [];
  const canonical = provider.variantOf || provider.id;
  const identity = catalogIdentity(provider);
  return [...providers.values()]
    .filter((candidate) => (
      (candidate.id === canonical || candidate.variantOf === canonical)
      && providerCatalogKind(candidate)
      && catalogIdentity(candidate) === identity
    ))
    .map((candidate) => candidate.id);
}

// One provider card can own more than one genuinely different catalog. The
// opencode Go key, for example, reaches both the subscription catalog and the
// pay-per-use Zen catalog; protocol variants on the same base URL are still
// folded because listing them separately would show the same ids repeatedly.
export function providerCatalogSources(providerId, providers = PROVIDERS) {
  const canonical = providers.get(providerId)?.variantOf || providerId;
  const seen = new Set();
  const sources = [];
  for (const provider of providers.values()) {
    if (provider.id !== canonical && provider.variantOf !== canonical) continue;
    const kind = providerCatalogKind(provider);
    if (!kind) continue;
    const identity = catalogIdentity(provider);
    if (seen.has(identity)) continue;
    seen.add(identity);
    sources.push({ id: provider.id, displayName: provider.displayName, kind });
  }
  return sources;
}

export function providerCatalogFamilyCacheIds(providerId, providers = PROVIDERS) {
  const canonical = providers.get(providerId)?.variantOf || providerId;
  const sourceIds = providerCatalogSources(providerId, providers).map(({ id }) => id);
  const variantIds = [...providers.values()]
    .filter((provider) => (
      (provider.id === canonical || provider.variantOf === canonical)
      && providerCatalogKind(provider)
    ))
    .map(({ id }) => id);
  // Include the exact id as a compatibility cleanup for caches written by an
  // older build before protocol variants were folded into source descriptors.
  return [...new Set([providerId, ...sourceIds, ...variantIds])];
}

// Credential variants are one account even when that account exposes several
// endpoints. Replacing an OpenCode key, for example, changes both the Go and
// pay-per-use Zen answers. Invalidate every catalog source together so no
// mutation path can show the previous account's entitlements for another day.
export function forgetProviderCatalogFamilyCache(providerId, providers = PROVIDERS) {
  return forgetProviderCatalogCaches(providerCatalogFamilyCacheIds(providerId, providers));
}
