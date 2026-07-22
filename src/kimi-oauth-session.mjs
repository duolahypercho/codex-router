import { execFileSync } from "node:child_process";
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";

import lockfile from "proper-lockfile";

import { protectPrivateFile } from "./file-security.mjs";
import { VERSION } from "./version.mjs";

const KIMI_CLIENT_ID = "17e5f671-d194-4dfb-9706-5516cb48c098";
const KIMI_CODE_HOME =
  process.env.KIMI_CODE_HOME || path.join(os.homedir(), ".kimi-code");
const OAUTH_HOST = (
  process.env.KIMI_CODE_OAUTH_HOST ||
  process.env.KIMI_OAUTH_HOST ||
  "https://auth.kimi.com"
).replace(/\/+$/, "");
const CREDENTIALS_PATH = path.join(
  KIMI_CODE_HOME,
  "credentials",
  "kimi-code.json",
);
const OAUTH_LOCK_TARGET = path.join(KIMI_CODE_HOME, "oauth", "kimi-code");
const DEVICE_ID_PATH = path.join(KIMI_CODE_HOME, "device_id");
let refreshInFlight;

function oauthError(message, { code = "oauth_error", status = 502 } = {}) {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  return error;
}

function unauthorizedError(message) {
  return oauthError(message, { code: "oauth_unauthorized", status: 401 });
}

function transientError(message, cause) {
  const error = oauthError(message, { code: "oauth_transient", status: 503 });
  if (cause !== undefined) error.cause = cause;
  return error;
}

function asciiHeader(value, fallback = "unknown") {
  const cleaned = String(value).replace(/[^\u0020-\u007e]/g, "").trim();
  return cleaned || fallback;
}

function macOSProductVersion() {
  if (os.type() !== "Darwin") return undefined;
  try {
    return execFileSync("/usr/bin/sw_vers", ["-productVersion"], {
      encoding: "utf8",
      timeout: 1_000,
    }).trim();
  } catch {
    return undefined;
  }
}

function readDeviceId() {
  let value;
  try {
    value = readFileSync(DEVICE_ID_PATH, "utf8").trim();
  } catch {
    throw unauthorizedError("Kimi device id is missing; run `kimi login` first.");
  }
  if (!value) {
    throw unauthorizedError("Kimi device id is missing; run `kimi login` first.");
  }
  return value;
}

export function kimiIdentityHeaders() {
  const platform =
    os.type() === "Darwin"
      ? `macOS ${macOSProductVersion() || os.release()} ${os.arch()}`
      : `${os.type()} ${os.release()} ${os.arch()}`;
  return {
    "User-Agent": `codex-router/${VERSION}`,
    "X-Msh-Platform": "codex",
    "X-Msh-Version": VERSION,
    "X-Msh-Device-Name": asciiHeader(os.hostname()),
    "X-Msh-Device-Model": asciiHeader(platform),
    "X-Msh-Os-Version": asciiHeader(os.release()),
    "X-Msh-Device-Id": asciiHeader(readDeviceId()),
  };
}

function validateToken(value) {
  if (!value || typeof value !== "object") {
    throw unauthorizedError("Kimi OAuth credential file is invalid; run `kimi login`.");
  }
  const expiresAt = Number(value.expires_at);
  const expiresIn = Number(value.expires_in);
  if (
    value.access_token === "" &&
    value.refresh_token === "" &&
    expiresAt === 0 &&
    expiresIn === 0
  ) {
    throw unauthorizedError("Kimi OAuth session was rejected; run `kimi login` again.");
  }
  if (typeof value.access_token !== "string" || !value.access_token) {
    throw unauthorizedError("Kimi OAuth credential is missing; run `kimi login`.");
  }
  if (typeof value.refresh_token !== "string" || !value.refresh_token) {
    throw unauthorizedError("Kimi OAuth refresh credential is missing; run `kimi login`.");
  }
  if (!Number.isFinite(expiresAt) || !Number.isFinite(expiresIn)) {
    throw unauthorizedError("Kimi OAuth credential has invalid expiry metadata; run `kimi login`.");
  }
  return {
    access_token: value.access_token,
    refresh_token: value.refresh_token,
    expires_at: expiresAt,
    expires_in: expiresIn,
    scope: typeof value.scope === "string" ? value.scope : "kimi-code",
    token_type: typeof value.token_type === "string" ? value.token_type : "Bearer",
  };
}

export function readKimiOAuthToken() {
  if (!existsSync(CREDENTIALS_PATH)) {
    throw unauthorizedError("Kimi OAuth credentials were not found; run `kimi login`.");
  }
  try {
    return validateToken(JSON.parse(readFileSync(CREDENTIALS_PATH, "utf8")));
  } catch (error) {
    if (error?.code === "oauth_unauthorized") throw error;
    throw unauthorizedError("Kimi OAuth credential file is invalid; run `kimi login`.");
  }
}

function shouldRefresh(token) {
  const threshold = Math.max(
    300,
    token.expires_in > 0 ? token.expires_in * 0.5 : 0,
  );
  return Math.floor(Date.now() / 1_000) >= token.expires_at - threshold;
}

function isHardExpired(token) {
  return Math.floor(Date.now() / 1_000) >= token.expires_at;
}

function sameToken(left, right) {
  return (
    left.access_token === right.access_token &&
    left.refresh_token === right.refresh_token &&
    left.expires_at === right.expires_at
  );
}

function atomicSaveToken(token) {
  const directory = path.dirname(CREDENTIALS_PATH);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);
  const temporary = `${CREDENTIALS_PATH}.tmp.${process.pid}`;
  const descriptor = openSync(temporary, "w", 0o600);
  try {
    writeFileSync(descriptor, `${JSON.stringify(token, null, 2)}\n`, "utf8");
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  try {
    protectPrivateFile(temporary);
    renameSync(temporary, CREDENTIALS_PATH);
    protectPrivateFile(CREDENTIALS_PATH);
  } catch (error) {
    try {
      unlinkSync(temporary);
    } catch {
      // Best-effort cleanup only.
    }
    throw error;
  }
}

function revokedTombstone(token) {
  return {
    access_token: "",
    refresh_token: "",
    expires_at: 0,
    expires_in: 0,
    scope: token.scope,
    token_type: token.token_type,
  };
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function refreshToken(refreshTokenValue) {
  const retryable = new Set([429, 500, 502, 503, 504]);
  let lastError;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    let response;
    try {
      response = await fetch(`${OAUTH_HOST}/api/oauth/token`, {
        method: "POST",
        headers: {
          ...kimiIdentityHeaders(),
          Accept: "application/json",
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
          client_id: KIMI_CLIENT_ID,
          grant_type: "refresh_token",
          refresh_token: refreshTokenValue,
        }),
        signal: AbortSignal.timeout(30_000),
      });
    } catch (error) {
      lastError = transientError("Kimi OAuth refresh could not reach the authentication service.", error);
      if (attempt < 2) await delay(2 ** attempt * 1_000);
      continue;
    }

    const payload = await response.json().catch(() => ({}));
    if (response.ok) {
      const expiresIn = Number(payload.expires_in);
      if (
        typeof payload.access_token !== "string" ||
        typeof payload.refresh_token !== "string" ||
        !Number.isFinite(expiresIn) ||
        expiresIn <= 0
      ) {
        throw oauthError("Kimi OAuth refresh returned an incomplete response.");
      }
      return {
        access_token: payload.access_token,
        refresh_token: payload.refresh_token,
        expires_at: Math.floor(Date.now() / 1_000) + expiresIn,
        expires_in: expiresIn,
        scope: typeof payload.scope === "string" ? payload.scope : "kimi-code",
        token_type: typeof payload.token_type === "string" ? payload.token_type : "Bearer",
      };
    }
    const code = typeof payload.error === "string" ? payload.error : "oauth_error";
    if (response.status === 401 || response.status === 403 || code === "invalid_grant") {
      throw unauthorizedError("Kimi OAuth refresh was rejected; run `kimi login` again.");
    }
    if (!retryable.has(response.status)) {
      throw oauthError(`Kimi OAuth refresh failed with HTTP ${response.status}.`);
    }
    lastError = transientError(`Temporary Kimi OAuth error: HTTP ${response.status}.`);
    if (attempt < 2) await delay(2 ** attempt * 1_000);
  }
  throw lastError || transientError("Kimi OAuth refresh failed.");
}

export async function ensureFreshKimiOAuthToken({ force = false } = {}) {
  const current = refreshInFlight;
  if (current) {
    if (!force || current.force) return current.promise;
    try {
      await current.promise;
    } catch {
      // The original caller owns its failure. A forced caller still needs its
      // own attempt because the non-forced refresh may have kept the old token.
    }
    return ensureFreshKimiOAuthToken({ force: true });
  }

  const promise = (async () => {
    const initial = readKimiOAuthToken();
    if (!force && !shouldRefresh(initial)) return initial.access_token;

    let release;
    try {
      mkdirSync(path.dirname(OAUTH_LOCK_TARGET), { recursive: true, mode: 0o700 });
      writeFileSync(OAUTH_LOCK_TARGET, "", { flag: "a", mode: 0o600 });
      release = await lockfile.lock(OAUTH_LOCK_TARGET, {
        retries: { retries: 120, factor: 1, minTimeout: 500, maxTimeout: 1_000 },
        stale: 5_000,
        realpath: false,
      });
    } catch (error) {
      if (!force && !isHardExpired(initial)) return initial.access_token;
      throw transientError("Kimi OAuth refresh lock is unavailable.", error);
    }

    try {
      const latest = readKimiOAuthToken();
      if (!force && !shouldRefresh(latest)) return latest.access_token;
      if (force && !sameToken(initial, latest)) return latest.access_token;
      try {
        const refreshed = await refreshToken(latest.refresh_token);
        atomicSaveToken(refreshed);
        return refreshed.access_token;
      } catch (error) {
        if (error?.code === "oauth_unauthorized") {
          await delay(100);
          const recovered = readKimiOAuthToken();
          if (recovered.refresh_token !== latest.refresh_token) {
            return recovered.access_token;
          }
          atomicSaveToken(revokedTombstone(latest));
        } else if (error?.code === "oauth_transient" && !force && !isHardExpired(latest)) {
          return latest.access_token;
        }
        throw error;
      }
    } finally {
      try {
        await release();
      } catch {
        // The lock may have been reaped as stale after a long network pause.
      }
    }
  })().finally(() => {
    if (refreshInFlight?.promise === promise) refreshInFlight = undefined;
  });
  refreshInFlight = { promise, force };
  return promise;
}
