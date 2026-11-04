import {
  providerApiKeyPoolsSnapshot,
  providerApiKeyPoolStatus,
  recordProviderApiKeyOutcome,
  selectProviderApiKey,
} from "./provider-api-key-pool.mjs";
import {
  credentialStatus,
  resolveProviderCredential,
  resolveProviderCredentialReference,
} from "./provider-credentials.mjs";
import { readProviderCredentialStore } from "./provider-credential-store.mjs";
import { PROVIDERS, providerNeedsNoKey } from "./model-registry.mjs";
import { discoveryDisabled } from "./discovery-mode.mjs";

function sanitizedReadiness(readiness, valid) {
  return {
    usable: valid && readiness?.usable === true,
    reason: valid ? readiness?.reason || "invalid_pool_state" : "invalid_pool_state",
    credentialCount: Number(readiness?.credentialCount) || 0,
    eligibleCredentialCount: Number(readiness?.eligibleCredentialCount) || 0,
    resolvableCredentialCount: Number(readiness?.resolvableCredentialCount) || 0,
  };
}

export function resolveStoredCredential(provider, credentialId, credentialStorePath) {
  const canonicalId = provider.variantOf || provider.id;
  const entry = readProviderCredentialStore(credentialStorePath).credentials.find(
    (candidate) =>
      candidate.id === credentialId &&
      candidate.providerId === canonicalId &&
      candidate.kind === "api_key" &&
      candidate.state === "active",
  );
  return entry ? resolveProviderCredentialReference(provider, entry.secretRef) : undefined;
}

/**
 * Report whether a provider's authoritative API-key pool can currently route.
 *
 * This intentionally returns only a reason and counts. Credential ids, source
 * names, references, and resolved values stay below this boundary so catalog,
 * setup, doctor, and status callers can share one authority decision without
 * growing a second secret-bearing diagnostics shape.
 */
export function providerApiKeyPoolReadiness(
  provider,
  {
    now = Date.now(),
    poolStatePath,
    credentialStorePath,
  } = {},
) {
  const resolutionAllowed = !discoveryDisabled();
  const status = providerApiKeyPoolStatus(provider.id, {
    filePath: poolStatePath,
    now,
    ...(resolutionAllowed
      ? {
          resolveCredential: (credentialId) =>
            resolveStoredCredential(provider, credentialId, credentialStorePath),
        }
      : {}),
  });
  return {
    configured: status.configured,
    valid: status.valid,
    ...(status.configured
      ? { readiness: sanitizedReadiness(status.readiness, status.valid) }
      : {}),
  };
}

/**
 * Read every configured pool once for callers that scan the whole registry.
 * A bounded pool document can still be several MiB; reparsing it once per
 * provider would turn a single catalog build into dozens of synchronous reads.
 */
export function providerApiKeyAuthoritySnapshot({
  now = Date.now(),
  poolStatePath,
  credentialStorePath,
} = {}) {
  const resolutionAllowed = !discoveryDisabled();
  const snapshot = providerApiKeyPoolsSnapshot({
    filePath: poolStatePath,
    now,
    ...(resolutionAllowed
      ? {
          resolveCredential: (providerId, credentialId) => {
            const provider = PROVIDERS.get(providerId);
            return provider
              ? resolveStoredCredential(provider, credentialId, credentialStorePath)
              : undefined;
          },
        }
      : {}),
  });
  return {
    configured: snapshot.configured,
    valid: snapshot.valid,
    providers: Object.fromEntries(
      Object.entries(snapshot.providers).map(([providerId, pool]) => [
        providerId,
        {
          configured: true,
          valid: true,
          readiness: sanitizedReadiness(pool.readiness, true),
        },
      ]),
    ),
  };
}

function poolAuthorityForProvider(provider, options) {
  const snapshot = options.poolAuthoritySnapshot;
  if (!snapshot) return providerApiKeyPoolReadiness(provider, options);
  if (!snapshot.valid) {
    return {
      configured: true,
      valid: false,
      readiness: sanitizedReadiness(undefined, false),
    };
  }
  return snapshot.providers[provider.variantOf || provider.id] || {
    configured: false,
    valid: true,
  };
}

/**
 * Resolve the effective credential authority for catalog and control surfaces.
 *
 * A missing pool preserves the legacy single-key contract. Once a pool entry
 * exists it is authoritative: a ready referenced key counts as configured even
 * without a legacy key, while an unusable pool cannot be masked by one.
 */
export function effectiveProviderCredentialStatus(provider, options = {}) {
  if (providerNeedsNoKey(provider)) {
    return credentialStatus(provider, { persistent: options.persistent === true });
  }
  const pool = poolAuthorityForProvider(provider, options);
  if (!pool.configured) {
    return credentialStatus(provider, { persistent: options.persistent === true });
  }
  const readiness = pool.readiness;
  if (pool.valid && readiness.usable) {
    const count = readiness.resolvableCredentialCount;
    return {
      configured: true,
      source: `provider API-key pool (${count} resolvable credential${count === 1 ? "" : "s"})`,
      persistent: true,
      pooled: true,
      poolReadiness: readiness,
    };
  }
  return {
    configured: false,
    setup: "Restore an eligible resolvable credential in the provider API-key pool, or delete the pool to use the legacy key.",
    pooled: true,
    poolReadiness: readiness,
  };
}

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
    stable = false,
    now = Date.now(),
    poolStatePath,
    credentialStorePath,
    resolveLegacy = () => resolveProviderCredential(provider),
    waitMs,
    retryMs,
    staleMs,
  } = {},
) {
  // API-key pools are provider-level authority. Per-model endpoint descriptors
  // deliberately derive their id from the model slug (for example
  // `custom/foo`) so each model keeps a distinct credential; those ids are not
  // registry provider ids and must stay on the existing endpoint credential
  // path instead of being parsed as pool provider identities. Generic runtime
  // providers are handled by their separate request boundary before this call.
  const perModelEndpointId =
    typeof provider?.id === "string" && provider.id.includes("/");
  if (perModelEndpointId) {
    return {
      credential: resolveLegacy(),
      pooled: false,
      configured: false,
      fallbackAllowed: true,
    };
  }

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
    // This is only an availability preview for setup/error reporting. The
    // attempt runner performs the locked, committing re-read immediately
    // before send, so one request does not advance sticky/round-robin state
    // twice and this earlier value is never trusted for authorization.
    selection = await selectProviderApiKey(provider.id, {
      filePath: poolStatePath,
      sessionId,
      stable,
      now,
      waitMs,
      retryMs,
      staleMs,
      resolveCredential: (credentialId) =>
        resolveStoredCredential(provider, credentialId, credentialStorePath),
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
