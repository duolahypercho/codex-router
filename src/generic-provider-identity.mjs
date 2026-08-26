import { PROVIDERS } from "./model-registry.mjs";

export const GENERIC_PROVIDER_ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

export function normalizeGenericProviderId(value) {
  const providerId = typeof value === "string" ? value.trim() : "";
  if (!GENERIC_PROVIDER_ID_PATTERN.test(providerId)) {
    throw new Error("Provider id must match [a-z0-9][a-z0-9-]*.");
  }
  if (PROVIDERS.has(providerId)) {
    throw new Error(`Provider id ${providerId} is already used by the built-in registry.`);
  }
  return providerId;
}
