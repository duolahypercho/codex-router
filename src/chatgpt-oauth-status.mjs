import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

// Location of the Codex CLI's ChatGPT OAuth session. The ChatGPT/Codex OAuth
// provider reuses this exact session rather than storing its own credential.
export function codexAuthPath() {
  return (
    process.env.CHATGPT_AUTH_PATH ||
    path.join(
      process.env.CODEX_HOME || path.join(os.homedir(), ".codex"),
      "auth.json",
    )
  );
}

// Report whether a usable ChatGPT/Codex OAuth session exists, WITHOUT ever
// returning token values — only presence, source, and refresh metadata.
export function chatgptOAuthStatus() {
  const authPath = codexAuthPath();
  if (!existsSync(authPath)) {
    return {
      configured: false,
      authPath,
      setup: "Run `codex login` in an interactive terminal",
    };
  }
  try {
    const value = JSON.parse(readFileSync(authPath, "utf8"));
    const tokens = value?.tokens;
    const configured = Boolean(tokens?.access_token && tokens?.refresh_token);
    if (!configured) {
      return {
        configured: false,
        authPath,
        setup: "Run `codex login` again; the Codex session is incomplete",
      };
    }
    return {
      configured: true,
      authPath,
      accountId: Boolean(tokens.account_id),
      lastRefresh: typeof value.last_refresh === "string" ? value.last_refresh : undefined,
    };
  } catch {
    return {
      configured: false,
      authPath,
      setup: "Run `codex login` again; the Codex session file is invalid",
    };
  }
}
