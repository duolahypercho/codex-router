import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { discoveryDisabled } from "./discovery-mode.mjs";

export function grokSessionEntry(auth) {
  if (!auth || typeof auth !== "object" || Array.isArray(auth)) return undefined;
  return Object.entries(auth).find(
    ([scope, entry]) =>
      scope.startsWith("https://auth.x.ai::") &&
      entry &&
      typeof entry === "object" &&
      typeof entry.key === "string" &&
      entry.key,
  )?.[1];
}

export function grokAuthPath() {
  return (
    process.env.GROK_AUTH_PATH ||
    path.join(
      process.env.GROK_HOME || path.join(os.homedir(), ".grok"),
      "auth.json",
    )
  );
}

// Report only credential presence. Token values never leave this module.
export function grokOAuthStatus() {
  const authPath = grokAuthPath();
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
      setup: "Run `grok login --oauth` in an interactive terminal",
    };
  }
  try {
    const value = JSON.parse(readFileSync(authPath, "utf8"));
    const configured = Boolean(grokSessionEntry(value));
    if (!configured) {
      return {
        configured: false,
        authPath,
        setup: "Run `grok login --oauth` again; the Grok session is incomplete",
      };
    }
    return {
      configured: true,
      authPath,
      source: "official Grok CLI session",
    };
  } catch {
    return {
      configured: false,
      authPath,
      setup: "Run `grok login --oauth` again; the Grok session file is invalid",
    };
  }
}
