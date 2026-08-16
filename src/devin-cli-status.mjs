import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { discoveryDisabled } from "./discovery-mode.mjs";
import { scanTomlDocument, tomlStringValue } from "./toml-structure.mjs";

// The official Devin CLI stores its session in `credentials.toml` after
// `devin auth login`. The router reads it; it never writes, moves, copies, or
// deletes another tool's credential file.
export const DEFAULT_API_SERVER_URL = "https://server.codeium.com";

export function devinCredentialsPath() {
  if (process.env.DEVIN_CREDENTIALS_PATH) return process.env.DEVIN_CREDENTIALS_PATH;
  if (process.platform === "win32") {
    const appData = process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming");
    return path.join(appData, "devin", "credentials.toml");
  }
  const dataHome = process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share");
  return path.join(dataHome, "devin", "credentials.toml");
}

// Parsed with the repository's fail-closed TOML scanner rather than a regex:
// a duplicate key or a multi-line value is refused instead of guessed at.
export function devinSessionEntry(contents) {
  const document = scanTomlDocument(contents);
  const apiKey = tomlStringValue(document, [], "windsurf_api_key");
  if (typeof apiKey !== "string" || !apiKey) return undefined;
  return {
    apiKey,
    apiServerUrl: tomlStringValue(document, [], "api_server_url") || DEFAULT_API_SERVER_URL,
    devinApiUrl: tomlStringValue(document, [], "devin_api_url"),
  };
}

// Report only credential presence. Token values never leave this module.
export function devinCliStatus() {
  const authPath = devinCredentialsPath();
  // Defense in depth for --no-discovery: another CLI's session file must not
  // be opened at all while discovery is off.
  if (discoveryDisabled()) {
    return {
      configured: false,
      authPath,
      setup: "Credential discovery is disabled; re-run setup without --no-discovery",
    };
  }
  if (!existsSync(authPath)) {
    return {
      configured: false,
      authPath,
      setup: "Run `devin auth login` in an interactive terminal",
    };
  }
  try {
    const session = devinSessionEntry(readFileSync(authPath, "utf8"));
    if (!session) {
      return {
        configured: false,
        authPath,
        setup: "Run `devin auth login` again; the Devin session is incomplete",
      };
    }
    return {
      configured: true,
      authPath,
      source: "official Devin CLI session",
    };
  } catch {
    return {
      configured: false,
      authPath,
      setup: "Run `devin auth login` again; the Devin session file is invalid",
    };
  }
}
