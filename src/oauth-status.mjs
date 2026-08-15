import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { discoveryDisabled } from "./discovery-mode.mjs";

export function kimiCodeHome() {
  return process.env.KIMI_CODE_HOME || path.join(os.homedir(), ".kimi-code");
}

function kimiCredentialsPath() {
  return path.join(kimiCodeHome(), "credentials", "kimi-code.json");
}

export function kimiOAuthStatus() {
  const credentialsPath = kimiCredentialsPath();
  // Defense in depth for --no-discovery: the caller-facing scans are already
  // guarded, but this file is another CLI's credential store and must not be
  // opened at all while discovery is off.
  if (discoveryDisabled()) {
    return {
      configured: false,
      credentialsPath,
      setup: "Credential discovery is disabled; re-run setup without --no-discovery",
    };
  }
  if (!existsSync(credentialsPath)) {
    return {
      configured: false,
      credentialsPath,
      setup: "Run `kimi login` in an interactive terminal",
    };
  }
  try {
    const value = JSON.parse(readFileSync(credentialsPath, "utf8"));
    const configured = Boolean(value?.access_token && value?.refresh_token);
    return configured
      ? { configured: true, credentialsPath, scope: value.scope || "kimi-code" }
      : {
          configured: false,
          credentialsPath,
          setup: "Run `kimi login` again; the credential file is incomplete",
        };
  } catch {
    return {
      configured: false,
      credentialsPath,
      setup: "Run `kimi login` again; the credential file is invalid",
    };
  }
}

// A deeper, read-only look at the credential than `kimiOAuthStatus()` offers,
// aligned with what the session reader (`kimi-oauth-session.mjs` validateToken)
// will accept at request time so a status verdict never diverges from runtime
// usability:
//
// - `ok`:      a live session that will serve requests
// - `stale`:   the access token is past its expiry, but the session is still
//              recoverable -- `ensureFreshKimiOAuthToken()` refreshes it with
//              the still-valid refresh token before forwarding, so this is a
//              working install, not a failure
// - `revoked`: the CLI wrote its revoked tombstone (all-empty tokens with zero
//              expiry metadata); the refresh was rejected, so `kimi login` is
//              genuinely required
// - `incomplete` / `invalid` / `missing`: no usable session on disk
export function kimiOAuthHealth() {
  const credentialsPath = kimiCredentialsPath();
  if (discoveryDisabled()) {
    return {
      status: "missing",
      detail: "credential discovery is disabled",
      fix: "Re-run setup without --no-discovery",
    };
  }
  if (!existsSync(credentialsPath)) {
    return {
      status: "missing",
      detail: "no credential file",
      fix: "Run `kimi login` in an interactive terminal",
    };
  }
  let value;
  try {
    value = JSON.parse(readFileSync(credentialsPath, "utf8"));
  } catch {
    return {
      status: "invalid",
      detail: "credential file is not valid JSON",
      fix: "Run `kimi login` again; the credential file is invalid",
    };
  }
  // Mirrors validateToken's all-empty + zero-metadata tombstone shape.
  const revoked =
    value?.access_token === "" &&
    value?.refresh_token === "" &&
    Number(value?.expires_at) === 0 &&
    Number(value?.expires_in) === 0;
  if (revoked) {
    return {
      status: "revoked",
      detail: "OAuth session was rejected by Kimi",
      fix: "Run `kimi login` again; the session must be re-authorized",
    };
  }
  const hasTokens =
    typeof value?.access_token === "string" &&
    value.access_token !== "" &&
    typeof value?.refresh_token === "string" &&
    value.refresh_token !== "";
  if (!hasTokens) {
    return {
      status: "incomplete",
      detail: "credential file is missing the access or refresh token",
      fix: "Run `kimi login` again; the credential file is incomplete",
    };
  }
  const expiresAt = Number(value?.expires_at);
  const expiresIn = Number(value?.expires_in);
  if (!Number.isFinite(expiresAt) || !Number.isFinite(expiresIn)) {
    return {
      status: "incomplete",
      detail: "credential file is missing finite second-based expiry metadata",
      fix: "Run `kimi login` again; the credential file is incomplete",
    };
  }
  const stale = Math.floor(Date.now() / 1_000) >= expiresAt;
  return {
    status: stale ? "stale" : "ok",
    detail: stale
      ? "access token expired; it refreshes automatically on the next request"
      : "credential present",
    fix: stale
      ? "No action needed; ensureFreshKimiOAuthToken() refreshes it before forwarding."
      : undefined,
  };
}
