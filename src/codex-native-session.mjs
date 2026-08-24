import { existsSync, readFileSync, rmSync, statSync } from "node:fs";
import path from "node:path";

import { discoveryDisabled } from "./discovery-mode.mjs";
import { writePrivateJson } from "./file-security.mjs";
import { CHATGPT_PROFILE_SWITCH_PATH, CODEX_HOME, NATIVE_SESSION_CONSENT_PATH } from "./paths.mjs";
import {
  chatGPTSubscriptionPoolHeaders,
} from "./chatgpt-account-pool.mjs";
import { readChatGPTProfileSwitchState } from "./chatgpt-profile-switch.mjs";

// The ChatGPT session the local Codex install already holds.
//
// Native GPT traffic is authorized by the caller's own session: `nativeHeaders`
// copies `authorization` and `chatgpt-account-id` off the incoming request, and
// Codex attaches both. A DeepSeek Harness turn attaches neither, so a native
// model advertised to the harness used to be a model it could not spend.
//
// This module can fall back to the session already sitting in
// `$CODEX_HOME/auth.json`, but only after the user authorizes that once for the
// shared router plane. The authorization is one owner-only marker carrying no
// credential. DeepSeek Harness, Gemini CLI, and any future local client then
// share that decision; asking the same OS user to sign in once per harness buys
// nothing. The subscription account pool is separate: it can replace the
// session attached to native Codex traffic when the user enables it.
//
// Access and refresh tokens are never logged, returned by a status call, or
// put in an error message. The desktop status may include the verified email
// claim from the id_token so the user can identify the signed-in profile.
export const CODEX_AUTH_PATH =
  process.env.MODEL_ROUTER_CODEX_AUTH || path.join(CODEX_HOME, "auth.json");

function consentMarkerEnabled() {
  if (!existsSync(NATIVE_SESSION_CONSENT_PATH)) return false;
  try {
    const parsed = JSON.parse(readFileSync(NATIVE_SESSION_CONSENT_PATH, "utf8"));
    return parsed?.version === 1 && parsed.sharing === "enabled";
  } catch {
    // This marker is an authorization boundary. An unreadable or unrecognized
    // file cannot prove consent, so it must fail closed.
    return false;
  }
}

// The fallback widens what the caller key reaches -- with it, a local process
// holding that key can spend the ChatGPT subscription and not only API-key
// providers. Missing state therefore means off, unlike the old implicit
// discovery behavior. `1` is an explicit headless opt-in and `0` an emergency
// off switch; any other environment value is not consent.
export function nativeSessionSharingEnabled() {
  // --no-discovery composes with the dedicated env switch: the Codex session
  // is a credential this process did not receive from its caller, so an idle
  // install must never spend it.
  if (discoveryDisabled()) return false;
  const override = process.env.CODEX_ROUTER_NATIVE_SESSION_FALLBACK;
  if (override !== undefined) return override === "1";
  return consentMarkerEnabled();
}

// Kept as an API alias for callers and integrations written against the first
// version of this feature. The behavior is now explicit sharing consent.
export function nativeSessionFallbackEnabled() {
  return nativeSessionSharingEnabled();
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

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function tokenEmail(idToken) {
  try {
    const payload = String(idToken).split(".")[1];
    if (!payload) return undefined;
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    const email = typeof claims?.email === "string" ? claims.email.trim() : "";
    return email.length <= 320 && EMAIL.test(email) ? email : undefined;
  } catch {
    return undefined;
  }
}

// Treated as expired slightly early: a token that dies mid-flight costs a whole
// turn, and there is nothing to gain from spending the last seconds of one.
const EXPIRY_SKEW_MS = 120_000;

function readSession() {
  // Under --no-discovery the Codex auth file is never opened; status readers
  // above report it absent rather than pretending to know what is inside.
  if (discoveryDisabled()) return undefined;
  if (!existsSync(CODEX_AUTH_PATH)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(CODEX_AUTH_PATH, "utf8"));
    const tokens = parsed?.tokens;
    const accessToken = typeof tokens?.access_token === "string" ? tokens.access_token : "";
    const accountId = typeof tokens?.account_id === "string" ? tokens.account_id : "";
    const idToken = typeof tokens?.id_token === "string" ? tokens.id_token : "";
    if (!accessToken) return undefined;
    const expiresAtMs = tokenExpiryMs(accessToken);
    return {
      accessToken,
      accountId,
      email: tokenEmail(idToken),
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

/**
 * Records or revokes the user's one-time, shared-plane authorization.
 *
 * Enabling is allowed only while the official Codex login is usable. The
 * router never creates, copies, or refreshes that credential itself. A forced
 * environment policy must be removed before the saved decision can be changed.
 */
export function setNativeSessionSharingEnabled(enabled) {
  if (!enabled) {
    if (process.env.CODEX_ROUTER_NATIVE_SESSION_FALLBACK === "1") {
      throw new Error(
        "CODEX_ROUTER_NATIVE_SESSION_FALLBACK=1 forces ChatGPT session sharing on. Remove that environment override, then run this disable command again.",
      );
    }
    rmSync(NATIVE_SESSION_CONSENT_PATH, { force: true });
    return false;
  }
  if (discoveryDisabled()) {
    throw new Error(
      "ChatGPT session sharing cannot be enabled while credential discovery is disabled.",
    );
  }
  const override = process.env.CODEX_ROUTER_NATIVE_SESSION_FALLBACK;
  if (override !== undefined && override !== "1") {
    throw new Error(
      "ChatGPT session sharing is forced off by CODEX_ROUTER_NATIVE_SESSION_FALLBACK. Remove that environment override or set it to 1 before enabling sharing.",
    );
  }
  const session = readSession();
  if (!session || session.expired) {
    throw new Error(
      "No usable ChatGPT session is available. Run `codex login`, complete the browser sign-in, then retry.",
    );
  }
  writePrivateJson(
    NATIVE_SESSION_CONSENT_PATH,
    { version: 1, sharing: "enabled" },
    { directoryMode: 0o700 },
  );
  return true;
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
  // `codex login status` makes Codex read (and possibly rewrite) its session
  // file; unreachable while readSession() is guarded, but the promise should
  // not depend on that call graph staying put.
  if (discoveryDisabled()) return false;
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
export function nativeSubscriptionPoolHeaders({ sessionId } = {}) {
  if (discoveryDisabled()) return undefined;
  const profile = readChatGPTProfileSwitchState(CHATGPT_PROFILE_SWITCH_PATH);
  if (profile.pending && profile.desired !== "auto") return undefined;
  const pooled = chatGPTSubscriptionPoolHeaders({ sessionId });
  if (pooled) {
    const { accountId: _accountId, ...headers } = pooled;
    return headers;
  }
  return undefined;
}

export function nativeSessionHeaders() {
  if (discoveryDisabled()) return undefined;
  if (!nativeSessionSharingEnabled()) return undefined;
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
  if (discoveryDisabled()) return false;
  return Boolean(nativeSessionHeaders());
}

/**
 * Presence and age, never contents. The age matters because Codex refreshes
 * this file: a session last written weeks ago is one whose access token has
 * almost certainly expired, and "signed in but stale" is a different problem
 * from "not signed in".
 */
export function nativeSessionStatus() {
  // Whether auth.json exists, and how old it is, is metadata about a
  // credential this process promised not to look at. Reporting it absent is
  // the same answer every other guarded reader gives under --no-discovery.
  if (discoveryDisabled()) {
    return {
      path: CODEX_AUTH_PATH,
      present: false,
      usable: false,
      hasAccountId: false,
      expired: false,
      expiresInHours: undefined,
      ageHours: undefined,
      sharingEnabled: false,
      fallbackEnabled: false,
    };
  }
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
  const sharingEnabled = nativeSessionSharingEnabled();
  return {
    path: CODEX_AUTH_PATH,
    present,
    // Usable means the credential itself is spendable: present, parseable, and
    // not expired. Publishing additionally requires explicit sharing consent,
    // which `nativeSessionAvailable()` applies.
    usable: Boolean(session) && !session.expired,
    hasAccountId: Boolean(session?.accountId),
    ...(session?.email ? { email: session.email } : {}),
    expired: Boolean(session?.expired),
    // The one number worth reporting: a session is only as good as the days
    // left on it, and "signed in but stale" is a different problem from
    // "not signed in".
    expiresInHours:
      session?.expiresAtMs === undefined
        ? undefined
        : Math.round(((session.expiresAtMs - Date.now()) / 36e5) * 10) / 10,
    ageHours,
    sharingEnabled,
    fallbackEnabled: sharingEnabled,
  };
}
