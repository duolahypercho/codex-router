import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { discoveryDisabled } from "./discovery-mode.mjs";

// Some providers finish a browser OAuth flow in their own CLI and then mint a
// long-lived API key into that CLI's home directory instead of handing back a
// refreshable token pair. Command Code works this way: `command-code login`
// opens the browser, receives the callback on a temporary local server, and
// writes {"apiKey": "...", "userName": "..."} to ~/.commandcode/auth.json.
//
// Reusing that file is the whole OAuth integration for such a provider. There
// is no forwarder and no refresh loop, because the key the sign-in produced is
// exactly the key the provider API expects. The router only ever reads the
// file: it never rewrites, copies, or deletes another tool's credentials.

// Every entry point below takes a registry provider record, never an id, so
// this module stays free of the registry import that provider-credentials.mjs
// already owns.
export function cliSessionDescriptor(provider) {
  return provider?.credential?.cliSession;
}

function sessionDirectory(descriptor) {
  const override = descriptor.homeEnv ? process.env[descriptor.homeEnv]?.trim() : undefined;
  // os.homedir() follows HOME/USERPROFILE, which is what the provider CLI
  // itself resolves, so both sides agree even under a relocated home.
  return override || path.join(os.homedir(), descriptor.directory);
}

export function cliSessionPath(provider) {
  const descriptor = cliSessionDescriptor(provider);
  if (!descriptor) return undefined;
  return path.join(sessionDirectory(descriptor), descriptor.file);
}

// Returns the key and the file it came from, and nothing else. The session
// file also carries the signed-in account name and id; those stay inside this
// function so status output, the tray, and support bundles cannot echo them.
export function readCliSessionCredential(provider) {
  const descriptor = cliSessionDescriptor(provider);
  if (!descriptor) return undefined;
  // Defense in depth for --no-discovery: another CLI's session file must not
  // be opened at all while discovery is off.
  if (discoveryDisabled()) return undefined;
  const file = cliSessionPath(provider);
  if (!file || !existsSync(file)) return undefined;
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    // A half-written or corrupt session file is the CLI's to repair; treating
    // it as "no credential" lets the stored router key take over instead of
    // failing every request.
    return undefined;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
  const raw = parsed[descriptor.field];
  const value = typeof raw === "string" ? raw.trim() : "";
  if (!value) return undefined;
  return { value, path: file, label: descriptor.label };
}

export function cliSessionStatus(provider) {
  const descriptor = cliSessionDescriptor(provider);
  if (!descriptor) return { supported: false, configured: false };
  return {
    supported: true,
    configured: Boolean(readCliSessionCredential(provider)),
    label: descriptor.label,
    loginCommand: descriptor.loginCommand,
    path: cliSessionPath(provider),
  };
}
