import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import lockfile from "proper-lockfile";

import {
  ANTIGRAVITY_CLIENT_ID,
  ANTIGRAVITY_CLIENT_SECRET,
  ANTIGRAVITY_TOKEN_URL,
} from "./antigravity-oauth-constants.mjs";
import { protectPrivateFile, writePrivateJson } from "./file-security.mjs";
import { STATE_DIR } from "./paths.mjs";

const REFRESH_THRESHOLD_SECONDS = 60;
const RETRYABLE_REFRESH_STATUSES = new Set([429, 500, 502, 503, 504]);
const refreshInFlight = new Map();

export function antigravityTokenPath() {
  return process.env.ANTIGRAVITY_TOKEN_PATH || path.join(STATE_DIR, "antigravity-oauth.json");
}

function oauthError(message, { code = "oauth_error", status = 502, cause } = {}) {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  if (cause !== undefined) error.cause = cause;
  return error;
}

function unauthorizedError(message) {
  return oauthError(message, { code: "oauth_unauthorized", status: 401 });
}

function transientError(message, cause) {
  return oauthError(message, { code: "oauth_transient", status: 503, cause });
}

export function validateAntigravityToken(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw unauthorizedError("Antigravity OAuth credential file is invalid; run sign-in again.");
  }
  if (
    value.access_token === "" &&
    value.refresh_token === "" &&
    Number(value.expires_at) === 0 &&
    Number(value.expires_in) === 0
  ) {
    throw unauthorizedError("Antigravity OAuth session was rejected; run sign-in again.");
  }
  if (typeof value.refresh_token !== "string" || !value.refresh_token) {
    throw unauthorizedError("Antigravity OAuth refresh credential is missing; run sign-in again.");
  }
  if (typeof value.access_token !== "string" || !value.access_token) {
    throw unauthorizedError("Antigravity OAuth credential is missing; run sign-in again.");
  }
  const expiresAt = Number(value.expires_at);
  const expiresIn = Number(value.expires_in);
  if (!Number.isFinite(expiresAt) || !Number.isFinite(expiresIn) || expiresIn <= 0) {
    throw unauthorizedError("Antigravity OAuth credential has invalid expiry metadata; run sign-in again.");
  }
  const projectCheckedAt = Number(value.project_checked_at);
  return {
    access_token: value.access_token,
    refresh_token: value.refresh_token,
    expires_at: expiresAt,
    expires_in: expiresIn,
    project_id: typeof value.project_id === "string" ? value.project_id : "",
    project_source: value.project_source === "managed" || value.project_source === "fallback"
      ? value.project_source
      : undefined,
    project_checked_at: Number.isFinite(projectCheckedAt) ? projectCheckedAt : undefined,
    tier_id: typeof value.tier_id === "string" && value.tier_id ? value.tier_id : undefined,
    email: typeof value.email === "string" ? value.email : undefined,
    token_type: typeof value.token_type === "string" ? value.token_type : "Bearer",
  };
}

export function readAntigravityToken() {
  const tokenPath = antigravityTokenPath();
  if (!existsSync(tokenPath)) {
    throw unauthorizedError("Antigravity OAuth credentials were not found; run sign-in first.");
  }
  try {
    return validateAntigravityToken(JSON.parse(readFileSync(tokenPath, "utf8")));
  } catch (error) {
    if (error?.code === "oauth_unauthorized") throw error;
    throw unauthorizedError("Antigravity OAuth credential file is invalid; run sign-in again.");
  }
}

function atomicSaveToken(token) {
  const normalized = validateAntigravityToken(token);
  writePrivateJson(
    antigravityTokenPath(),
    { version: 1, ...normalized },
    { directoryMode: 0o700 },
  );
  return normalized;
}

function lockTarget() {
  return `${antigravityTokenPath()}.guard`;
}

async function withTokenLock(run) {
  const target = lockTarget();
  let release;
  try {
    mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
    writeFileSync(target, "", { flag: "a", mode: 0o600 });
    protectPrivateFile(target);
    release = await lockfile.lock(target, {
      retries: { retries: 120, factor: 1, minTimeout: 250, maxTimeout: 1_000 },
      stale: 120_000,
      update: 10_000,
      realpath: false,
    });
  } catch (error) {
    throw transientError("Antigravity OAuth credential lock is unavailable.", error);
  }
  try {
    return await run();
  } finally {
    try {
      await release();
    } catch {
      // A stale lock may already have been reaped after a long network pause.
    }
  }
}

export async function saveAntigravityToken(token) {
  return withTokenLock(() => atomicSaveToken(token));
}

// Backwards-compatible name for callers from the initial implementation.
export async function writeAntigravityToken(token) {
  return saveAntigravityToken(token);
}

export async function updateAntigravityToken(transform) {
  if (typeof transform !== "function") throw new TypeError("transform must be a function");
  return withTokenLock(async () => {
    const latest = readAntigravityToken();
    const candidate = await transform({ ...latest });
    if (candidate === undefined || candidate === null || candidate === latest) return latest;
    return atomicSaveToken(candidate);
  });
}

export async function removeAntigravityToken() {
  return withTokenLock(async () => {
    const target = antigravityTokenPath();
    if (!existsSync(target)) return false;
    let refreshToken;
    try {
      const stored = JSON.parse(readFileSync(target, "utf8"));
      if (typeof stored?.refresh_token === "string" && stored.refresh_token) {
        refreshToken = stored.refresh_token;
      }
    } catch {
      // Invalid credentials are still removable; clear every project cache entry.
    }
    const { invalidateAntigravityProjectCache } = await import("./antigravity-project.mjs");
    unlinkSync(target);
    invalidateAntigravityProjectCache(refreshToken);
    return true;
  });
}

export function protectAntigravityToken() {
  const target = antigravityTokenPath();
  if (!existsSync(target)) return false;
  protectPrivateFile(target);
  return target;
}

function shouldRefresh(token, nowSeconds) {
  return nowSeconds >= token.expires_at - REFRESH_THRESHOLD_SECONDS;
}

function isHardExpired(token, nowSeconds) {
  return nowSeconds >= token.expires_at;
}

function sameToken(left, right) {
  return (
    left.access_token === right.access_token &&
    left.refresh_token === right.refresh_token &&
    left.expires_at === right.expires_at
  );
}

function revokedTombstone(token) {
  return {
    access_token: "",
    refresh_token: "",
    expires_at: 0,
    expires_in: 0,
    project_id: token.project_source === "managed" ? token.project_id : "",
    project_source: token.project_source,
    project_checked_at: token.project_checked_at,
    tier_id: token.tier_id,
    email: token.email,
    token_type: token.token_type,
  };
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function retryDelay(response, attempt, now, random) {
  const retryAfter = response?.headers?.get?.("retry-after");
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1_000;
    const date = Date.parse(retryAfter);
    if (Number.isFinite(date)) return Math.max(0, date - now());
  }
  return 2 ** attempt * 1_000 + Math.floor(random() * 250);
}

async function refreshAntigravityToken(
  refreshToken,
  {
    fetchImpl = fetch,
    now = Date.now,
    delayImpl = delay,
    random = Math.random,
  } = {},
) {
  let lastError;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    let response;
    try {
      response = await fetchImpl(ANTIGRAVITY_TOKEN_URL, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          refresh_token: refreshToken,
          client_id: ANTIGRAVITY_CLIENT_ID,
          client_secret: ANTIGRAVITY_CLIENT_SECRET,
        }),
        signal: AbortSignal.timeout(30_000),
      });
    } catch (error) {
      lastError = transientError(
        "Antigravity OAuth refresh could not reach Google's authentication service.",
        error,
      );
      if (attempt < 2) await delayImpl(2 ** attempt * 1_000 + Math.floor(random() * 250));
      continue;
    }

    const payload = await response.json().catch(() => ({}));
    if (response.ok) {
      const expiresIn = Number(payload.expires_in);
      if (typeof payload.access_token !== "string" || !Number.isFinite(expiresIn) || expiresIn <= 0) {
        throw oauthError("Antigravity OAuth refresh returned an incomplete response.");
      }
      return {
        access_token: payload.access_token,
        refresh_token: typeof payload.refresh_token === "string" && payload.refresh_token
          ? payload.refresh_token
          : refreshToken,
        expires_at: Math.floor(now() / 1_000) + expiresIn,
        expires_in: expiresIn,
        token_type: typeof payload.token_type === "string" ? payload.token_type : "Bearer",
      };
    }

    const providerCode = typeof payload.error === "string" ? payload.error : "oauth_error";
    if (providerCode === "invalid_grant") {
      throw unauthorizedError("Antigravity OAuth refresh was rejected; run sign-in again.");
    }
    if (!RETRYABLE_REFRESH_STATUSES.has(response.status)) {
      throw oauthError(`Antigravity OAuth refresh failed with HTTP ${response.status}.`, {
        code: "oauth_refresh_failed",
        status: response.status >= 400 && response.status <= 599 ? response.status : 502,
      });
    }
    lastError = transientError(`Temporary Antigravity OAuth error: HTTP ${response.status}.`);
    if (attempt < 2) await delayImpl(retryDelay(response, attempt, now, random));
  }
  throw lastError || transientError("Antigravity OAuth refresh failed.");
}

export async function ensureFreshAntigravitySession({
  force = false,
  now = Date.now,
  fetchImpl = fetch,
  delayImpl = delay,
  random = Math.random,
} = {}) {
  const key = antigravityTokenPath();
  const current = refreshInFlight.get(key);
  if (current) {
    if (!force || current.force) return current.promise;
    try {
      await current.promise;
    } catch {
      // The original caller owns its failure. A forced caller still needs an
      // attempt when the first call only retained a hard-valid token.
    }
    return ensureFreshAntigravitySession({ force: true, now, fetchImpl, delayImpl, random });
  }

  const promise = (async () => {
    const initial = readAntigravityToken();
    const initialNowSeconds = Math.floor(now() / 1_000);
    if (!force && !shouldRefresh(initial, initialNowSeconds)) return initial;

    let result;
    try {
      result = await withTokenLock(async () => {
        const latest = readAntigravityToken();
        const nowSeconds = Math.floor(now() / 1_000);
        if (!force && !shouldRefresh(latest, nowSeconds)) return latest;
        if (force && !sameToken(initial, latest)) return latest;

        try {
          const refreshed = await refreshAntigravityToken(latest.refresh_token, {
            fetchImpl,
            now,
            delayImpl,
            random,
          });
          const recovered = readAntigravityToken();
          if (!sameToken(recovered, latest)) return recovered;
          return atomicSaveToken({
            ...recovered,
            ...refreshed,
          });
        } catch (error) {
          if (error?.code === "oauth_unauthorized") {
            await delayImpl(100);
            const recovered = readAntigravityToken();
            if (!sameToken(recovered, latest)) return recovered;
            writePrivateJson(
              antigravityTokenPath(),
              { version: 1, ...revokedTombstone(latest) },
              { directoryMode: 0o700 },
            );
          } else if (
            error?.code === "oauth_transient" &&
            !force &&
            !isHardExpired(latest, nowSeconds)
          ) {
            return latest;
          }
          throw error;
        }
      });
    } catch (error) {
      if (error?.code === "oauth_transient" && !force) {
        try {
          const recovered = readAntigravityToken();
          const recoveredNowSeconds = Math.floor(now() / 1_000);
          if (!isHardExpired(recovered, recoveredNowSeconds)) return recovered;
        } catch {
          // Fall back to the original snapshot only when it remains spendable.
        }
        if (!isHardExpired(initial, initialNowSeconds)) return initial;
      }
      throw error;
    }
    return result;
  })().finally(() => {
    if (refreshInFlight.get(key)?.promise === promise) refreshInFlight.delete(key);
  });
  refreshInFlight.set(key, { promise, force });
  return promise;
}

export async function ensureFreshAntigravityToken(options = {}) {
  return (await ensureFreshAntigravitySession(options)).access_token;
}

const isMain =
  process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) {
  const command = process.argv[2] || "protect";
  if (command !== "protect") {
    process.stderr.write("Usage: antigravity-oauth-session.mjs protect\n");
    process.exitCode = 2;
  } else {
    const protectedPath = protectAntigravityToken();
    process.stdout.write(`${JSON.stringify({ present: Boolean(protectedPath) })}\n`);
  }
}
