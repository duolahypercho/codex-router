import { createHash } from "node:crypto";

import {
  ANTIGRAVITY_DEFAULT_PROJECT_ID,
  ANTIGRAVITY_ENDPOINT,
  ANTIGRAVITY_PROD_ENDPOINT,
  antigravityBootstrapHeaders,
  antigravityLoadCodeAssistMetadata,
} from "./antigravity-oauth-constants.mjs";
import { updateAntigravityToken } from "./antigravity-oauth-session.mjs";

const PROJECT_CACHE_TTL_MS = 30 * 60_000;
const projectCache = new Map();
const projectPending = new Map();
const projectKeyGenerations = new Map();
let projectCacheGeneration = 0;

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function projectIdFrom(payload) {
  const project = payload?.cloudaicompanionProject;
  if (typeof project === "string" && project) return project;
  if (project && typeof project.id === "string" && project.id) return project.id;
  return undefined;
}

function tierIdFrom(payload) {
  return typeof payload?.currentTier?.id === "string" && payload.currentTier.id
    ? payload.currentTier.id
    : undefined;
}

function defaultTierId(allowedTiers) {
  if (!Array.isArray(allowedTiers)) return "free-tier";
  const selected = allowedTiers.find(
    (tier) => tier?.isDefault && typeof tier.id === "string" && tier.id,
  ) || allowedTiers.find((tier) => typeof tier?.id === "string" && tier.id);
  return selected?.id || "free-tier";
}

function projectCacheKey(refreshToken) {
  return createHash("sha256").update(refreshToken).digest("hex");
}

function projectGeneration(key) {
  return {
    global: projectCacheGeneration,
    key: projectKeyGenerations.get(key) || 0,
  };
}

function generationIsCurrent(key, generation) {
  return (
    generation.global === projectCacheGeneration &&
    generation.key === (projectKeyGenerations.get(key) || 0)
  );
}

export function invalidateAntigravityProjectCache(refreshToken) {
  if (!refreshToken) {
    projectCacheGeneration += 1;
    projectKeyGenerations.clear();
    projectCache.clear();
    projectPending.clear();
    return;
  }
  const key = projectCacheKey(refreshToken);
  projectKeyGenerations.set(key, (projectKeyGenerations.get(key) || 0) + 1);
  projectCache.delete(key);
  projectPending.delete(key);
}

export async function loadAntigravityProject(
  accessToken,
  { fetchImpl = fetch, timeoutMs = 15_000 } = {},
) {
  const headers = antigravityBootstrapHeaders(accessToken);
  const body = JSON.stringify({ metadata: antigravityLoadCodeAssistMetadata() });
  for (const base of [...new Set([ANTIGRAVITY_ENDPOINT, ANTIGRAVITY_PROD_ENDPOINT])]) {
    try {
      const response = await fetchImpl(`${base}/v1internal:loadCodeAssist`, {
        method: "POST",
        headers,
        body,
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!response.ok) continue;
      const payload = await response.json();
      if (payload && typeof payload === "object") return payload;
    } catch {
      // Daily and production discovery are independent rollout surfaces.
    }
  }
  return null;
}

export async function onboardAntigravityProject(
  accessToken,
  tierId,
  {
    fetchImpl = fetch,
    attempts = 10,
    retryDelayMs = 5_000,
    delayImpl = delay,
    timeoutMs = 15_000,
  } = {},
) {
  const body = JSON.stringify({ tierId });
  for (const base of [...new Set([ANTIGRAVITY_PROD_ENDPOINT, ANTIGRAVITY_ENDPOINT])]) {
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        const response = await fetchImpl(`${base}/v1internal:onboardUser`, {
          method: "POST",
          headers: antigravityBootstrapHeaders(accessToken),
          body,
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (!response.ok) break;
        const payload = await response.json().catch(() => ({}));
        const projectId = projectIdFrom(payload?.response);
        if (payload?.done && projectId) return projectId;
      } catch {
        break;
      }
      if (attempt < attempts - 1) await delayImpl(retryDelayMs);
    }
  }
  return undefined;
}

export async function discoverAntigravityProject(
  accessToken,
  {
    fetchImpl = fetch,
    now = Date.now,
    attempts = 10,
    retryDelayMs = 5_000,
    delayImpl = delay,
    timeoutMs = 15_000,
  } = {},
) {
  const payload = await loadAntigravityProject(accessToken, { fetchImpl, timeoutMs });
  const capturedTierId = tierIdFrom(payload);
  const managedProjectId = projectIdFrom(payload);
  if (managedProjectId) {
    return {
      projectId: managedProjectId,
      source: "managed",
      tierId: capturedTierId,
      checkedAt: now(),
    };
  }

  const selectedTierId = defaultTierId(payload?.allowedTiers);
  const provisionedProjectId = await onboardAntigravityProject(
    accessToken,
    selectedTierId,
    { fetchImpl, attempts, retryDelayMs, delayImpl, timeoutMs },
  );
  if (provisionedProjectId) {
    return {
      projectId: provisionedProjectId,
      source: "managed",
      tierId: capturedTierId || selectedTierId,
      checkedAt: now(),
    };
  }
  return {
    projectId: ANTIGRAVITY_DEFAULT_PROJECT_ID,
    source: "fallback",
    tierId: capturedTierId || selectedTierId,
    checkedAt: now(),
  };
}

// Compatibility wrapper retained for onboarding and external diagnostics.
export async function resolveAntigravityProject(accessToken, options = {}) {
  return (await discoverAntigravityProject(accessToken, options)).projectId;
}

function alreadyResolved(session, nowMs) {
  if (
    session.project_id &&
    session.project_id !== ANTIGRAVITY_DEFAULT_PROJECT_ID &&
    session.project_source !== "fallback"
  ) {
    return {
      projectId: session.project_id,
      source: "managed",
      tierId: session.tier_id,
      checkedAt: session.project_checked_at,
    };
  }
  if (
    session.project_source === "fallback" &&
    Number.isFinite(session.project_checked_at) &&
    nowMs - session.project_checked_at < PROJECT_CACHE_TTL_MS
  ) {
    return {
      projectId: ANTIGRAVITY_DEFAULT_PROJECT_ID,
      source: "fallback",
      tierId: session.tier_id,
      checkedAt: session.project_checked_at,
    };
  }
  return undefined;
}

async function persistProjectContext(session, context) {
  const saved = await updateAntigravityToken((latest) => {
    if (latest.refresh_token !== session.refresh_token) return undefined;
    return {
      ...latest,
      project_id: context.source === "managed" ? context.projectId : "",
      project_source: context.source,
      project_checked_at: context.checkedAt,
      tier_id: context.tierId,
    };
  });
  return saved;
}

export async function ensureAntigravityProject(
  session,
  {
    fetchImpl = fetch,
    now = Date.now,
    attempts = 10,
    retryDelayMs = 5_000,
    delayImpl = delay,
    timeoutMs = 15_000,
    forceFallbackRefresh = false,
  } = {},
) {
  const nowMs = now();
  const refreshFallback = forceFallbackRefresh && session.project_source === "fallback";
  if (refreshFallback) invalidateAntigravityProjectCache(session.refresh_token);
  const resolved = refreshFallback ? undefined : alreadyResolved(session, nowMs);
  if (resolved) return { session, ...resolved };

  const refreshToken = session.refresh_token;
  const key = projectCacheKey(refreshToken);
  const cached = projectCache.get(key);
  if (cached && nowMs - cached.cachedAt < PROJECT_CACHE_TTL_MS) {
    const saved = await persistProjectContext(session, cached.context);
    if (saved.refresh_token !== refreshToken) {
      return ensureAntigravityProject(saved, {
        fetchImpl,
        now,
        attempts,
        retryDelayMs,
        delayImpl,
        timeoutMs,
        forceFallbackRefresh,
      });
    }
    return { session: saved, ...cached.context };
  }
  if (cached) projectCache.delete(key);

  const pending = projectPending.get(key);
  if (pending) {
    const context = await pending;
    const saved = await persistProjectContext(session, context);
    if (saved.refresh_token !== refreshToken) {
      return ensureAntigravityProject(saved, {
        fetchImpl,
        now,
        attempts,
        retryDelayMs,
        delayImpl,
        timeoutMs,
        forceFallbackRefresh,
      });
    }
    return { session: saved, ...context };
  }

  const generation = projectGeneration(key);
  const promise = discoverAntigravityProject(session.access_token, {
    fetchImpl,
    now,
    attempts,
    retryDelayMs,
    delayImpl,
    timeoutMs,
  }).then((context) => {
    if (generationIsCurrent(key, generation)) {
      projectCache.set(key, { context, cachedAt: now() });
    }
    return context;
  }).finally(() => {
    if (projectPending.get(key) === promise) projectPending.delete(key);
  });
  projectPending.set(key, promise);

  const context = await promise;
  const saved = await persistProjectContext(session, context);
  if (saved.refresh_token !== refreshToken) {
    return ensureAntigravityProject(saved, {
      fetchImpl,
      now,
      attempts,
      retryDelayMs,
      delayImpl,
      timeoutMs,
      forceFallbackRefresh,
    });
  }
  return { session: saved, ...context };
}
