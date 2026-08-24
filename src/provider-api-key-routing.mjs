import {
  providerApiKeyPoolStatus,
  recordProviderApiKeyOutcome,
  selectProviderApiKeyLocked,
} from "./provider-api-key-pool.mjs";
import {
  resolveProviderCredential,
  resolveProviderCredentialReference,
} from "./provider-credentials.mjs";

/**
 * Resolve one request credential without silently falling back around a pool.
 *
 * An absent provider entry means the legacy single-key path is still in use.
 * Once an entry exists, the pool is authoritative: invalid state, a lock
 * failure, an unavailable secret, or an empty pool returns no credential.
 * This is deliberately fail-closed because falling back to a different key
 * can spend the wrong account and hide a broken pool configuration.
 */
export async function resolveProviderApiKeyForRequest(
  provider,
  {
    sessionId,
    now = Date.now(),
    poolStatePath,
    resolveLegacy = () => resolveProviderCredential(provider),
    waitMs,
    retryMs,
    staleMs,
  } = {},
) {
  const status = providerApiKeyPoolStatus(provider.id, {
    filePath: poolStatePath,
    now,
  });
  if (!status.configured) {
    return {
      credential: resolveLegacy(),
      pooled: false,
      configured: false,
      fallbackAllowed: true,
    };
  }
  if (!status.valid) {
    return {
      credential: undefined,
      pooled: true,
      configured: true,
      fallbackAllowed: false,
      reason: "invalid_pool_state",
    };
  }
  let selection;
  try {
    selection = await selectProviderApiKeyLocked(provider.id, {
      filePath: poolStatePath,
      sessionId,
      now,
      waitMs,
      retryMs,
      staleMs,
      resolveSecret: (reference) => resolveProviderCredentialReference(provider, reference),
    });
  } catch (error) {
    return {
      credential: undefined,
      pooled: true,
      configured: true,
      fallbackAllowed: false,
      reason: error?.code === "provider_api_key_pool_locked" ? "pool_locked" : "pool_error",
      error,
    };
  }
  if (!selection?.credentialValue) {
    return {
      credential: undefined,
      pooled: true,
      configured: true,
      fallbackAllowed: false,
      selection,
      reason: selection?.reason || "no_eligible_credentials",
    };
  }
  return {
    credential: {
      value: selection.credentialValue,
      source: `provider API-key pool (${selection.credentialId})`,
      persistent: true,
    },
    pooled: true,
    configured: true,
    fallbackAllowed: false,
    selection,
  };
}

export async function recordProviderApiKeyRequestOutcome(
  routing,
  provider,
  outcome,
  { poolStatePath } = {},
) {
  if (!routing?.pooled || !routing.selection?.credentialId) return undefined;
  try {
    return await recordProviderApiKeyOutcome(
      provider.id,
      routing.selection.credentialId,
      outcome,
      { filePath: poolStatePath },
    );
  } catch {
    // The upstream result is already determined; telemetry failure must not
    // rewrite or truncate a response. The next request still fails closed if
    // the pool state or lock remains unavailable.
    return undefined;
  }
}
