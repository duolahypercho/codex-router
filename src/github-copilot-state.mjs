import { openSync, closeSync, fstatSync, lstatSync, readFileSync } from "node:fs";
import path from "node:path";

import { writePrivateJson } from "./file-security.mjs";
import { STATE_DIR } from "./paths.mjs";

export const GITHUB_COPILOT_STATE_PATH = path.join(STATE_DIR, "github-copilot-settings.json");

export function normalizeGitHubCopilotHost(value) {
  const host = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (host === "github.com" || /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.ghe\.com$/.test(host)) {
    return host;
  }
  throw new Error("Copilot host must be github.com or a tenant hostname such as octocorp.ghe.com.");
}

export function readGitHubCopilotSettings({ filePath = GITHUB_COPILOT_STATE_PATH } = {}) {
  let descriptor;
  try {
    // Distinguish absent state from damaged state. An invalid enterprise
    // setting must never send its credential to the public GitHub default.
    let stat;
    try {
      stat = lstatSync(filePath);
    } catch (error) {
      if (error.code === "ENOENT") return { host: "github.com", source: "default" };
      throw error;
    }
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4096) throw new Error("invalid state file");
    descriptor = openSync(filePath, "r");
    const opened = fstatSync(descriptor);
    if (!opened.isFile() || opened.size > 4096 || opened.dev !== stat.dev || opened.ino !== stat.ino) {
      throw new Error("state file changed");
    }
    const settings = JSON.parse(readFileSync(descriptor, "utf8"));
    if (!settings || settings.version !== 1 || Object.keys(settings).some((key) => !["version", "host"].includes(key))) {
      throw new Error("invalid settings");
    }
    return { host: normalizeGitHubCopilotHost(settings.host), source: "protected state" };
  } catch {
    throw new Error("Copilot host settings are invalid or unreadable. Use control github-copilot host set HOST or clear to repair them.");
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

export function setGitHubCopilotHost(value, { filePath = GITHUB_COPILOT_STATE_PATH } = {}) {
  const host = normalizeGitHubCopilotHost(value);
  writePrivateJson(filePath, { version: 1, host }, { directoryMode: 0o700 });
  return { host, source: "protected state" };
}

export function clearGitHubCopilotHost(options) {
  return setGitHubCopilotHost("github.com", options);
}
