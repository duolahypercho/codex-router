import { randomUUID } from "node:crypto";

import {
  ANTIGRAVITY_ENDPOINT,
  ANTIGRAVITY_PROD_ENDPOINT,
  antigravityBootstrapHeaders,
  antigravityLoadCodeAssistMetadata,
} from "./antigravity-oauth-constants.mjs";
import {
  assertAntigravitySessionCurrent,
  updateAntigravityToken,
} from "./antigravity-oauth-session.mjs";

const PROJECT_CACHE_TTL_MS = 30 * 60_000;
const projectCache = new Map();
const projectPending = new Map();
const projectKeyGenerations = new Map();
let projectCacheGeneration = 0;

// Bound a single request path so discovery cannot block on the two upstream
// endpoints indefinitely: one request approves at most one hit per endpoint.
export const DEFAULT_ATTEMPTS = 2;
export const DEFAULT_RETRY_DELAY_MS = 1_000;

function abortableDelay(milliseconds, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason || new Error("aborted"));
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason || new Error("aborted"));
    };
    const timer = setTimeout(resolve, milliseconds);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function combinedSignal(parentSignal, timeoutMs) {
  const timeout = AbortSignal.timeout(timeoutMs);
  if (!parentSignal) return timeout;
  return AbortSignal.any([parentSignal, timeout]);
}

function projectUnavailable(message, { code = "project_required", status = 502 } = {}) {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  return error;
}

// Google answers a disabled private API with a structured reason that names
// the service. Discarding the body reduced that to `HTTP 403`, which reads as
// a credential problem and sends the operator back through sign-in that is
// already working (issue #566).
//
// Only the structured fields are read. The free-text `message` embeds the
// caller's project number and a console URL built from it, and an error string
// the router prints and logs is the wrong place for either.
const PRIVATE_BOOTSTRAP_SERVICE = "cloudcode-pa.googleapis.com";
const MAX_ERROR_BODY_BYTES = 16 * 1024;

export function antigravityBootstrapFailure(status, bodyText) {
  const base = `HTTP ${status}`;
  if (typeof bodyText !== "string" || bodyText.length === 0) return base;
  let parsed;
  try {
    parsed = JSON.parse(bodyText.slice(0, MAX_ERROR_BODY_BYTES));
  } catch {
    return base;
  }
  const error = parsed?.error;
  if (!error || typeof error !== "object") return base;
  const details = Array.isArray(error.details) ? error.details : [];
  const disabled = details.find((detail) => detail?.reason === "SERVICE_DISABLED");
  const service = String(disabled?.metadata?.service || "");
  if (disabled && service === PRIVATE_BOOTSTRAP_SERVICE) {
    // Binding this service is gated by a producer-side permission
    // (`servicemanagement.services.bind`), so no IAM role an operator can
    // grant themselves enables it. Saying "enable the API" here would send
    // them to a console page that does not exist for a private API.
    return (
      `${base}: the OAuth client's Google Cloud project is not allowlisted for ` +
      `${service}, which is a private Google API that an ordinary project cannot ` +
      "enable. Antigravity sign-in succeeded; only the project behind the " +
      "operator-owned OAuth client is unauthorized"
    );
  }
  const status_ = typeof error.status === "string" ? error.status : undefined;
  const reason = typeof disabled?.reason === "string" ? disabled.reason : undefined;
  const detail = [status_, reason, service].filter(Boolean).join(", ");
  return detail ? `${base} (${detail})` : base;
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
  if (!Array.isArray(allowedTiers)) return undefined;
  const selected = allowedTiers.find(
    (tier) => tier?.isDefault && typeof tier.id === "string" && tier.id,
  ) || allowedTiers.find((tier) => typeof tier?.id === "string" && tier.id);
  return selected?.id;
}

function projectCacheKey(sessionGeneration) {
  // session_generation is already a validated router-created UUID. It is an
  // in-memory cache namespace, not a credential and not persisted or exposed.
  return sessionGeneration;
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

function projectContextChangedError(message =
  "The Antigravity project context changed while discovery was running; retry it.") {
  const error = new Error(message);
  error.code = "project_context_changed";
  error.status = 409;
  return error;
}

export function assertAntigravityProjectRevisionCurrent(session) {
  const latest = assertAntigravitySessionCurrent(session);
  if (
    typeof session?.project_revision !== "string" ||
    latest.project_revision !== session.project_revision
  ) {
    throw projectContextChangedError();
  }
  return latest;
}

export async function claimAntigravityProjectRevision(session) {
  const current = assertAntigravityProjectRevisionCurrent(session);
  const claimedRevision = randomUUID();
  const saved = await updateAntigravityToken((latest) => {
    if (
      latest.session_generation !== current.session_generation ||
      latest.project_revision !== current.project_revision
    ) return undefined;
    return { ...latest, project_revision: claimedRevision };
  });
  if (
    saved.session_generation !== current.session_generation ||
    saved.project_revision !== claimedRevision
  ) {
    throw projectContextChangedError(
      "Another Antigravity project discovery superseded this one before it began.",
    );
  }
  return saved;
}

export function invalidateAntigravityProjectCache(sessionGeneration) {
  if (!sessionGeneration) {
    projectCacheGeneration += 1;
    projectKeyGenerations.clear();
    projectCache.clear();
    projectPending.clear();
    return undefined;
  }
  const key = projectCacheKey(sessionGeneration);
  projectKeyGenerations.set(key, (projectKeyGenerations.get(key) || 0) + 1);
  projectCache.delete(key);
  projectPending.delete(key);
  const revision = randomUUID();
  return updateAntigravityToken((latest) => {
    if (latest.session_generation !== sessionGeneration) return undefined;
    return { ...latest, project_revision: revision };
  }).then((saved) => {
    if (
      saved.session_generation !== sessionGeneration ||
      saved.project_revision !== revision
    ) {
      const error = new Error(
        "The Antigravity OAuth session changed while its project context was invalidated; retry it.",
      );
      error.code = "oauth_session_changed";
      error.status = 409;
      throw error;
    }
    return saved;
  });
}

export async function loadAntigravityProject(
  accessToken,
  { fetchImpl = fetch, timeoutMs = 15_000, signal, assertCurrent = () => {} } = {},
) {
  const headers = antigravityBootstrapHeaders(accessToken);
  const body = JSON.stringify({ metadata: antigravityLoadCodeAssistMetadata() });
  const failures = [];
  for (const base of [...new Set([ANTIGRAVITY_ENDPOINT, ANTIGRAVITY_PROD_ENDPOINT])]) {
    try {
      assertCurrent();
      const response = await fetchImpl(`${base}/v1internal:loadCodeAssist`, {
        method: "POST",
        headers,
        body,
        signal: combinedSignal(signal, timeoutMs),
      });
      if (!response.ok) {
        // The body carries the only actionable part of this failure; a bare
        // status cannot distinguish "your project is not allowlisted" from
        // "your credential is bad".
        const bodyText = await response.text().catch(() => "");
        failures.push(antigravityBootstrapFailure(response.status, bodyText));
        continue;
      }
      const payload = await response.json().catch(() => undefined);
      if (payload && typeof payload === "object" && !Array.isArray(payload)) return payload;
      failures.push("malformed success response");
    } catch (error) {
      if (signal?.aborted) throw signal.reason || new Error("aborted");
      if (["oauth_session_changed", "project_context_changed"].includes(error?.code)) throw error;
      failures.push(error instanceof Error ? error.message : "network error");
    }
  }
  throw projectUnavailable(
    `Antigravity project bootstrap failed (${failures.join("; ") || "no usable response"}).`,
    { code: "project_bootstrap_failed", status: 502 },
  );
}

export async function onboardAntigravityProject(
  accessToken,
  tierId,
  {
    fetchImpl = fetch,
    attempts = DEFAULT_ATTEMPTS,
    retryDelayMs = DEFAULT_RETRY_DELAY_MS,
    delayImpl = abortableDelay,
    timeoutMs = 15_000,
    signal,
    assertCurrent = () => {},
  } = {},
) {
  const body = JSON.stringify({ tierId });
  for (const base of [...new Set([ANTIGRAVITY_PROD_ENDPOINT, ANTIGRAVITY_ENDPOINT])]) {
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        assertCurrent();
        const response = await fetchImpl(`${base}/v1internal:onboardUser`, {
          method: "POST",
          headers: antigravityBootstrapHeaders(accessToken),
          body,
          signal: combinedSignal(signal, timeoutMs),
        });
        if (!response.ok) break;
        const payload = await response.json().catch(() => ({}));
        const projectId = projectIdFrom(payload?.response);
        if (payload?.done && projectId) return projectId;
      } catch (error) {
        if (signal?.aborted) throw signal.reason || new Error("aborted");
        if (["oauth_session_changed", "project_context_changed"].includes(error?.code)) throw error;
        break;
      }
      if (attempt < attempts - 1) {
        await delayImpl(retryDelayMs, signal);
      }
    }
  }
  return undefined;
}

export async function discoverAntigravityProject(
  accessToken,
  {
    fetchImpl = fetch,
    now = Date.now,
    attempts = DEFAULT_ATTEMPTS,
    retryDelayMs = DEFAULT_RETRY_DELAY_MS,
    delayImpl = abortableDelay,
    timeoutMs = 15_000,
    signal,
    allowOnboard = false,
    assertCurrent = () => {},
  } = {},
) {
  const payload = await loadAntigravityProject(accessToken, {
    fetchImpl,
    timeoutMs,
    signal,
    assertCurrent,
  });
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

  // Provisioning creates a Google Cloud project under the signed-in account,
  // so only the explicit live probe may opt into it. Sign-in and the request
  // path never provision implicitly; if no managed project is discoverable,
  // fail rather than route through a foreign project.
  if (!allowOnboard) {
    throw projectUnavailable(
      "Antigravity could not discover a Google Cloud project. Retry the explicit live probe with --provision-project only if you authorize creating one.",
    );
  }

  const selectedTierId = defaultTierId(payload?.allowedTiers);
  if (!selectedTierId) {
    throw projectUnavailable(
      "Antigravity did not explicitly advertise an allowed provisioning tier; no project was created.",
      { code: "project_provisioning_not_advertised", status: 409 },
    );
  }
  const provisionedProjectId = await onboardAntigravityProject(
    accessToken,
    selectedTierId,
    { fetchImpl, attempts, retryDelayMs, delayImpl, timeoutMs, signal, assertCurrent },
  );
  if (provisionedProjectId) {
    return {
      projectId: provisionedProjectId,
      source: "managed",
      tierId: capturedTierId || selectedTierId,
      checkedAt: now(),
    };
  }
  throw projectUnavailable(
    "Antigravity could not provision a Google Cloud project during the explicit live probe.",
  );
}


function alreadyResolved(session, nowMs) {
  if (session.project_id && session.project_source !== "fallback") {
    return {
      projectId: session.project_id,
      source: "managed",
      tierId: session.tier_id,
      checkedAt: session.project_checked_at,
    };
  }
  // A fallback is a recorded absence, not a project. Re-deriving it on every
  // turn would hammer discovery for an account that has none, so the same TTL
  // that bounds a real answer also bounds how often the absence is retried --
  // and inside that window the caller is told plainly rather than routed
  // through a project that does not exist.
  if (
    session.project_source === "fallback" &&
    Number.isFinite(session.project_checked_at) &&
    nowMs - session.project_checked_at < PROJECT_CACHE_TTL_MS
  ) {
    throw projectUnavailable(
      "The Antigravity Google Cloud project is not available; re-run sign-in to provision one.",
    );
  }
  return undefined;
}

async function persistProjectContext(session, context, expectedProjectRevision) {
  assertAntigravitySessionCurrent(session);
  const committedRevision = randomUUID();
  const saved = await updateAntigravityToken((latest) => {
    if (
      latest.session_generation !== session.session_generation ||
      latest.project_revision !== expectedProjectRevision
    ) return undefined;
    return {
      ...latest,
      project_revision: committedRevision,
      // A fallback records that discovery produced nothing usable. Writing its
      // placeholder id would make the next `alreadyResolved` treat it as a
      // managed project and route through it.
      project_id: context.source === "managed" ? context.projectId : "",
      project_source: context.source,
      project_checked_at: context.checkedAt,
      tier_id: context.tierId,
    };
  });
  if (
    saved.session_generation !== session.session_generation ||
    saved.project_revision !== committedRevision
  ) {
    const error = new Error(
      "The Antigravity project context was invalidated during discovery; retry it.",
    );
    error.code = saved.session_generation !== session.session_generation
      ? "oauth_session_changed"
      : "project_context_changed";
    error.status = 409;
    throw error;
  }
  return saved;
}

export async function ensureAntigravityProject(
  session,
  {
    fetchImpl = fetch,
    now = Date.now,
    attempts = DEFAULT_ATTEMPTS,
    retryDelayMs = DEFAULT_RETRY_DELAY_MS,
    delayImpl = abortableDelay,
    timeoutMs = 15_000,
    signal,
    allowOnboard = false,
    forceFallbackRefresh = false,
  } = {},
) {
  let currentSession = assertAntigravitySessionCurrent(session);
  const nowMs = now();
  // An explicit retry is the one caller allowed past the fallback TTL: it has
  // already failed a turn and is asking for a fresh answer, not a cached
  // absence.
  const refreshFallback = forceFallbackRefresh && currentSession.project_source === "fallback";
  if (refreshFallback) {
    currentSession = await invalidateAntigravityProjectCache(currentSession.session_generation);
  }
  const resolved = refreshFallback ? undefined : alreadyResolved(currentSession, nowMs);
  if (resolved) {
    const latest = assertAntigravityProjectRevisionCurrent(currentSession);
    return { session: latest, ...resolved };
  }

  const sessionGeneration = currentSession.session_generation;
  const key = projectCacheKey(sessionGeneration);
  const cached = projectCache.get(key);
  if (cached && nowMs - cached.cachedAt < PROJECT_CACHE_TTL_MS) {
    const latest = assertAntigravityProjectRevisionCurrent(cached.session);
    return { session: latest, ...cached.context };
  }
  if (cached) projectCache.delete(key);

  const pending = projectPending.get(key);
  if (pending) {
    const result = await pending;
    const latest = assertAntigravityProjectRevisionCurrent(result.session);
    return { session: latest, ...result.context };
  }

  const generation = projectGeneration(key);
  const promise = (async () => {
    const claimedSession = await claimAntigravityProjectRevision(currentSession);
    const context = await discoverAntigravityProject(claimedSession.access_token, {
      fetchImpl,
      now,
      attempts,
      retryDelayMs,
      delayImpl,
      timeoutMs,
      signal,
      allowOnboard,
      assertCurrent: () => assertAntigravityProjectRevisionCurrent(claimedSession),
    });
    assertAntigravityProjectRevisionCurrent(claimedSession);
    const saved = await persistProjectContext(
      claimedSession,
      context,
      claimedSession.project_revision,
    );
    if (generationIsCurrent(key, generation)) {
      projectCache.set(key, { context, session: saved, cachedAt: now() });
    }
    return { context, session: saved };
  })().finally(() => {
    if (projectPending.get(key) === promise) projectPending.delete(key);
  });
  projectPending.set(key, promise);

  const result = await promise;
  const latest = assertAntigravityProjectRevisionCurrent(result.session);
  return { session: latest, ...result.context };
}
