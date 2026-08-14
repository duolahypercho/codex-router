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

function readSession() {
  if (!existsSync(CODEX_AUTH_PATH)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(CODEX_AUTH_PATH, "utf8"));
    const tokens = parsed?.tokens;
    const accessToken = typeof tokens?.access_token === "string" ? tokens.access_token : "";
    const accountId = typeof tokens?.account_id === "string" ? tokens.account_id : "";
    if (!accessToken) return undefined;
    return { accessToken, accountId, lastRefresh: parsed?.last_refresh };
  } catch {
    // A half-written or hand-edited auth file is not an error worth failing a
    // turn over -- the caller simply has no fallback and the native call fails
    // the way it did before, with the upstream's own 401.
    return undefined;
  }
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
    usable: Boolean(session),
    hasAccountId: Boolean(session?.accountId),
    ageHours,
    fallbackEnabled: nativeSessionFallbackEnabled(),
  };
}
