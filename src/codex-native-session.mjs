import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

import { CODEX_HOME } from "./paths.mjs";

// The ChatGPT session the local Codex install already holds.
//
// Native GPT traffic is authorized by the caller's own session: `nativeHeaders`
// copies `authorization` and `chatgpt-account-id` off the incoming request, and
// Codex attaches both. A DeepSeek Harness turn attaches neither, so a native
// model advertised to the harness used to be a model it could not spend.
//
// This module lets the router fall back to the session already sitting in
// `$CODEX_HOME/auth.json` -- the user is signed in to Codex on this machine, and
// asking them to sign in again for a client running as the same user on the same
// machine buys nothing. It is a *fallback*: a caller that presents its own
// credential is always relayed unchanged, so Codex is untouched by this.
//
// The values are never logged, never returned by a status call, and never put
// in an error message. `nativeSessionStatus` reports presence and age only,
// which is the same bound the rest of the router holds credentials to.
export const CODEX_AUTH_PATH =
  process.env.MODEL_ROUTER_CODEX_AUTH || path.join(CODEX_HOME, "auth.json");

// Off switch. The fallback widens what the caller key reaches -- with it, a
// local process holding that key can spend the ChatGPT subscription and not
// only the API-key providers -- so there has to be a way to say no.
export function nativeSessionFallbackEnabled() {
  return process.env.CODEX_ROUTER_NATIVE_SESSION_FALLBACK !== "0";
}

// The `exp` claim, in epoch milliseconds. Only the claim is read; the token
// itself is never returned, logged, or compared. A token with no readable exp
// is treated as usable -- refusing to send something that might be perfectly
// good is worse than letting the upstream be the judge.
export function tokenExpiryMs(accessToken) {
  try {
    const payload = String(accessToken).split(".")[1];
    if (!payload) return undefined;
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    return Number.isFinite(claims?.exp) ? claims.exp * 1000 : undefined;
  } catch {
    return undefined;
  }
}

// Treated as expired slightly early: a token that dies mid-flight costs a whole
// turn, and there is nothing to gain from spending the last seconds of one.
const EXPIRY_SKEW_MS = 120_000;

function readSession() {
  if (!existsSync(CODEX_AUTH_PATH)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(CODEX_AUTH_PATH, "utf8"));
    const tokens = parsed?.tokens;
    const accessToken = typeof tokens?.access_token === "string" ? tokens.access_token : "";
    const accountId = typeof tokens?.account_id === "string" ? tokens.account_id : "";
    if (!accessToken) return undefined;
    const expiresAtMs = tokenExpiryMs(accessToken);
    return {
      accessToken,
      accountId,
      lastRefresh: parsed?.last_refresh,
      expiresAtMs,
      expired: expiresAtMs !== undefined && expiresAtMs - EXPIRY_SKEW_MS <= Date.now(),
    };
  } catch {
    // A half-written or hand-edited auth file is not an error worth failing a
    // turn over -- the caller simply has no fallback and the native call fails
    // the way it did before, with the upstream's own 401.
    return undefined;
  }
}

// Codex owns this credential and is the only thing that may rewrite it.
//
// Refreshing it here would mean reproducing an OAuth exchange whose client
// identity is not published, and — if refresh tokens rotate — writing the new
// one back into Codex's own file or else invalidating the login this router was
// asked not to disturb. Running Codex instead delegates the whole problem to
// the program that owns it: `login status` is read-only from this router's side
// and refreshes on Codex's own terms if it decides to.
//
// Best effort by design. If it does not refresh, the session simply reads as
// expired, native models stop being published, and nobody is served a 401.
let refreshInFlight;
let lastRefreshAttemptMs = 0;
const REFRESH_RETRY_INTERVAL_MS = 5 * 60_000;
const REFRESH_TIMEOUT_MS = 30_000;

export async function refreshViaCodex({ now = Date.now() } = {}) {
  if (refreshInFlight) return refreshInFlight;
  if (now - lastRefreshAttemptMs < REFRESH_RETRY_INTERVAL_MS) return false;
  lastRefreshAttemptMs = now;
  refreshInFlight = (async () => {
    try {
      const { findCodexBinary } = await import("./codex-binary.mjs");
      const binary = findCodexBinary();
      if (!binary) return false;
      const { spawnableCommand } = await import("./spawnable-command.mjs");
      const { execFileSync } = await import("node:child_process");
      const command = spawnableCommand(binary, ["login", "status"]);
      execFileSync(command.command, command.args, {
        ...command.options,
        encoding: "utf8",
        timeout: REFRESH_TIMEOUT_MS,
        stdio: ["ignore", "ignore", "ignore"],
        windowsHide: true,
      });
      return true;
    } catch {
      return false;
    } finally {
      refreshInFlight = undefined;
    }
  })();
  return refreshInFlight;
}

/**
 * Headers that let a caller with no session of its own spend the local one.
 * `undefined` when there is nothing to fall back to, so call sites can leave
 * the request exactly as it arrived.
 */
export function nativeSessionHeaders() {
  if (!nativeSessionFallbackEnabled()) return undefined;
  const session = readSession();
  if (!session) return undefined;
  if (session.expired) {
    // Nudge Codex to renew it -- fire and forget, because a turn must not wait
    // on another program -- and decline for now. The next request picks up a
    // refreshed file if one appeared. Sending a token known to be dead would
    // just spend a round trip to be told so.
    void refreshViaCodex();
    return undefined;
  }
  return {
    authorization: `Bearer ${session.accessToken}`,
    ...(session.accountId ? { "chatgpt-account-id": session.accountId } : {}),
  };
}

export function nativeSessionAvailable() {
  return Boolean(nativeSessionHeaders());
}

/**
 * Presence and age, never contents. The age matters because Codex refreshes
 * this file: a session last written weeks ago is one whose access token has
 * almost certainly expired, and "signed in but stale" is a different problem
 * from "not signed in".
 */
export function nativeSessionStatus() {
  const present = existsSync(CODEX_AUTH_PATH);
  const session = present ? readSession() : undefined;
  let ageHours;
  if (present) {
    try {
      ageHours = Math.round((Date.now() - statSync(CODEX_AUTH_PATH).mtimeMs) / 36e5);
    } catch {
      ageHours = undefined;
    }
  }
  return {
    path: CODEX_AUTH_PATH,
    present,
    // Usable means spendable: present, parseable, and not expired. This is what
    // gates publishing, so the harness is never offered a model that would 401.
    usable: Boolean(session) && !session.expired,
    hasAccountId: Boolean(session?.accountId),
    expired: Boolean(session?.expired),
    // The one number worth reporting: a session is only as good as the days
    // left on it, and "signed in but stale" is a different problem from
    // "not signed in".
    expiresInHours:
      session?.expiresAtMs === undefined
        ? undefined
        : Math.round(((session.expiresAtMs - Date.now()) / 36e5) * 10) / 10,
    ageHours,
    fallbackEnabled: nativeSessionFallbackEnabled(),
  };
}
