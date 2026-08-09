import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export function kimiCodeHome() {
  return process.env.KIMI_CODE_HOME || path.join(os.homedir(), ".kimi-code");
}

// A credential is only usable while its expiry is a real future timestamp.
// `kimi login` writes seconds since epoch; some builds write milliseconds, so
// the cutoff distinguishes the two scales. A missing field is not a failure:
// older CLI builds may never have written one, and the token fields are the
// only signal those builds trusted. Anything else — a non-numeric value, a
// zero, or a date already past (including the epoch garbage that broken login
// flows leave behind) — must reject the credential.
function credentialExpired(value) {
  const raw = value?.expires_at;
  if (raw === undefined || raw === null || raw === "") return false;
  const expiresAt = Number(raw);
  if (!Number.isFinite(expiresAt) || expiresAt <= 0) return true;
  const millis = expiresAt > 1e11 ? expiresAt : expiresAt * 1000;
  return millis <= Date.now();
}

export function kimiOAuthStatus() {
  const credentialsPath = path.join(
    kimiCodeHome(),
    "credentials",
    "kimi-code.json",
  );
  if (!existsSync(credentialsPath)) {
    return {
      configured: false,
      credentialsPath,
      setup: "Run `kimi login` in an interactive terminal",
    };
  }
  try {
    const value = JSON.parse(readFileSync(credentialsPath, "utf8"));
    const configured =
      Boolean(value?.access_token && value?.refresh_token) &&
      !credentialExpired(value);
    return configured
      ? { configured: true, credentialsPath, scope: value.scope || "kimi-code" }
      : credentialExpired(value)
        ? {
            configured: false,
            credentialsPath,
            setup: "Run `kimi login` again; the credential is expired",
          }
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
