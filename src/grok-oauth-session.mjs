import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";

import {
  grokCliFailureMessage,
  grokCliPath,
  grokCliPreflight,
} from "./grok-cli.mjs";
import { grokAuthPath, grokSessionEntry } from "./grok-oauth-status.mjs";
import { spawnableCommand } from "./spawnable-command.mjs";

const REFRESH_THRESHOLD_MS = 5 * 60 * 1_000;
const REFRESH_TIMEOUT_MS = 30_000;
let refreshInFlight;

function oauthError(message) {
  const error = new Error(message);
  error.code = "oauth_unauthorized";
  error.status = 401;
  return error;
}

function expirationMilliseconds(value) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value > 10_000_000_000 ? value : value * 1_000;
  }
  const parsed = Date.parse(value || "");
  return Number.isFinite(parsed) ? parsed : undefined;
}

function readSession() {
  let auth;
  try {
    auth = JSON.parse(readFileSync(grokAuthPath(), "utf8"));
  } catch {
    throw oauthError("Grok OAuth session is unavailable; run `grok login --oauth`.");
  }
  const session = grokSessionEntry(auth);
  if (typeof session?.key !== "string" || !session.key) {
    throw oauthError("Grok OAuth session is incomplete; run `grok login --oauth`.");
  }
  return {
    accessToken: session.key,
    expiresAt: expirationMilliseconds(session.expires_at),
  };
}

function shouldRefresh(session, now) {
  return Number.isFinite(session.expiresAt) && session.expiresAt <= now + REFRESH_THRESHOLD_MS;
}

function isHardExpired(session, now) {
  return Number.isFinite(session.expiresAt) && session.expiresAt <= now;
}

export function refreshWithOfficialCli({
  executable = grokCliPath() || "grok",
  platform = process.platform,
  preflightOptions,
  spawnImpl = spawn,
} = {}) {
  const preflight = grokCliPreflight({ executable, platform, ...preflightOptions });
  if (!preflight.runnable) {
    return Promise.reject(oauthError(grokCliFailureMessage(preflight)));
  }
  return new Promise((resolve, reject) => {
    const { XAI_API_KEY: _apiKey, ...environment } = process.env;
    // The same batch-shim hop the preflight takes: a refresh that skipped it
    // failed on every npm-installed Windows CLI, expiring the session that the
    // preflight had just reported as healthy.
    const target = spawnableCommand(executable, ["models"], platform);
    const child = spawnImpl(target.command, target.args, {
      ...target.options,
      env: environment,
      stdio: ["ignore", "ignore", "ignore"],
      windowsHide: true,
    });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, REFRESH_TIMEOUT_MS);
    child.once("error", () => {
      clearTimeout(timer);
      reject(oauthError("The Grok CLI could not refresh OAuth; run `grok login --oauth`."));
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      if (!timedOut && code === 0) resolve();
      else reject(oauthError("The Grok CLI could not refresh OAuth; run `grok login --oauth`."));
    });
  });
}

export async function ensureFreshGrokOAuthToken({
  force = false,
  now = Date.now(),
  refresh = refreshWithOfficialCli,
} = {}) {
  const initial = readSession();
  if (!force && !shouldRefresh(initial, now)) return initial.accessToken;

  // A forced recovery must not reuse the unchanged token returned by a
  // concurrent early-refresh attempt. Wait for that attempt, then retry if it
  // only fell back to the still-valid access token.
  while (refreshInFlight) {
    const token = await refreshInFlight;
    if (!force || token !== initial.accessToken) return token;
  }

  refreshInFlight = (async () => {
    const latest = readSession();
    if (!force && !shouldRefresh(latest, now)) return latest.accessToken;
    if (force && latest.accessToken !== initial.accessToken) return latest.accessToken;

    try {
      await refresh();
    } catch (error) {
      // The five-minute refresh margin is conservative. Keep serving an access
      // token that is still wire-valid when the CLI has a transient problem;
      // an upstream 401 will take the forced path and surface an auth error.
      if (!force && !isHardExpired(latest, Date.now())) return latest.accessToken;
      throw error;
    }

    const refreshed = readSession();
    if (refreshed.accessToken === latest.accessToken) {
      if (!force && !isHardExpired(refreshed, Date.now())) {
        return refreshed.accessToken;
      }
      throw oauthError("Grok OAuth was not renewed; run `grok login --oauth`.");
    }
    return refreshed.accessToken;
  })().finally(() => {
    refreshInFlight = undefined;
  });
  return refreshInFlight;
}
