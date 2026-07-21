import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import lockfile from "proper-lockfile";

import { grokAuthPath, grokSessionEntry } from "./grok-oauth-status.mjs";

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

function grokExecutable() {
  if (process.env.GROK_CLI) return process.env.GROK_CLI;
  const managed = path.join(process.env.GROK_HOME || path.join(os.homedir(), ".grok"), "bin", "grok");
  return existsSync(managed) ? managed : "grok";
}

function refreshWithOfficialCli() {
  return new Promise((resolve, reject) => {
    const { XAI_API_KEY: _apiKey, ...environment } = process.env;
    const child = spawn(grokExecutable(), ["models"], {
      env: environment,
      stdio: ["ignore", "ignore", "ignore"],
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
  if (refreshInFlight) return refreshInFlight;

  refreshInFlight = (async () => {
    const authPath = grokAuthPath();
    mkdirSync(path.dirname(authPath), { recursive: true, mode: 0o700 });
    const release = await lockfile.lock(authPath, {
      retries: { retries: 60, factor: 1, minTimeout: 250, maxTimeout: 500 },
      stale: REFRESH_TIMEOUT_MS + 5_000,
      realpath: false,
    });
    try {
      const latest = readSession();
      if (!force && !shouldRefresh(latest, now)) return latest.accessToken;
      if (force && latest.accessToken !== initial.accessToken) return latest.accessToken;

      await refresh();
      const refreshed = readSession();
      if (
        refreshed.accessToken === latest.accessToken &&
        (force || shouldRefresh(refreshed, Date.now()))
      ) {
        throw oauthError("Grok OAuth was not renewed; run `grok login --oauth`.");
      }
      return refreshed.accessToken;
    } finally {
      await release();
    }
  })().finally(() => {
    refreshInFlight = undefined;
  });
  return refreshInFlight;
}
