import { existsSync, readFileSync } from "node:fs";

import { privateFileIsProtected } from "./file-security.mjs";
import {
  antigravityTokenPath,
  validateAntigravityToken,
} from "./antigravity-oauth-session.mjs";

// The Antigravity credential is written by this router's own sign-in flow, not
// lifted from another CLI's session file, so it is not gated on
// --no-discovery. It is this router's credential in the same sense an API key
// file is.

export function antigravityOAuthStatus() {
  const tokenPath = antigravityTokenPath();
  if (!existsSync(tokenPath)) {
    return {
      configured: false,
      credentialPresent: false,
      tokenPath,
      setup: "Run the Antigravity sign-in flow",
    };
  }
  try {
    const token = validateAntigravityToken(JSON.parse(readFileSync(tokenPath, "utf8")));
    return {
      configured: true,
      credentialPresent: true,
      tokenPath,
      source: `Google account session (${token.email || "Antigravity OAuth"})`,
      projectId: token.project_id || undefined,
    };
  } catch {
    return {
      configured: false,
      credentialPresent: true,
      tokenPath,
      setup: "Run the Antigravity sign-in flow again; the credential is invalid",
    };
  }
}

export function antigravityOAuthHealth() {
  const tokenPath = antigravityTokenPath();
  if (!existsSync(tokenPath)) {
    return {
      status: "missing",
      detail: "no Antigravity credential file",
      fix: "Run the Antigravity sign-in flow",
    };
  }
  let value;
  try {
    value = JSON.parse(readFileSync(tokenPath, "utf8"));
  } catch {
    return {
      status: "invalid",
      detail: "Antigravity credential file is not valid JSON",
      fix: "Run the Antigravity sign-in flow again",
    };
  }
  const revoked =
    value?.access_token === "" &&
    value?.refresh_token === "" &&
    Number(value?.expires_at) === 0 &&
    Number(value?.expires_in) === 0;
  if (revoked) {
    return {
      status: "revoked",
      detail: "Antigravity OAuth session was rejected by Google",
      fix: "Run the Antigravity sign-in flow again",
    };
  }
  try {
    const token = validateAntigravityToken(value);
    if (!privateFileIsProtected(tokenPath)) {
      return {
        status: "insecure",
        detail: "Antigravity credential file permissions allow access beyond the current user",
        fix: "Run the doctor with --fix to restore owner-only permissions",
        projectId: token.project_id || undefined,
      };
    }
    const stale = Math.floor(Date.now() / 1_000) >= token.expires_at;
    return {
      status: stale ? "stale" : "ok",
      detail: stale
        ? "access token expired; it refreshes automatically on the next request"
        : "credential present",
      fix: stale ? "No action needed; the session refreshes before forwarding." : undefined,
      projectId: token.project_id || undefined,
    };
  } catch {
    return {
      status: "incomplete",
      detail: "Antigravity credential is missing a usable token",
      fix: "Run the Antigravity sign-in flow again",
    };
  }
}
