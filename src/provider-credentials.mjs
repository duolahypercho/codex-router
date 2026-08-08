import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

import {
  cliSessionDescriptor,
  readCliSessionCredential,
} from "./cli-session-credential.mjs";
import { protectPrivateFile } from "./file-security.mjs";
import { LEGACY_STATE_DIRS, STATE_DIR, TARGET } from "./paths.mjs";
import { targetCli } from "./target-integration.mjs";
import { PROVIDERS } from "./model-registry.mjs";

export function apiProvider(providerId) {
  const provider = PROVIDERS.get(providerId);
  if (!provider || provider.kind !== "openai-compatible") {
    throw new Error(`Unknown API-key provider: ${providerId}`);
  }
  return provider;
}

export function primaryCredentialPath(provider) {
  if (!provider.credential) {
    throw new Error(`Provider ${provider.id} stores no credential.`);
  }
  return path.join(STATE_DIR, provider.credential.file);
}

export function credentialPaths(provider) {
  // A keyless provider stores nothing, so there is no file to look for and
  // nothing for a support bundle to redact.
  if (!provider.credential) return [];
  const names = [provider.credential.file, ...(provider.credential.legacyFiles || [])];
  const candidates = names.flatMap((name) => [
    path.join(STATE_DIR, name),
    ...LEGACY_STATE_DIRS.map((directory) => path.join(directory, name)),
  ]);
  return [...new Set(candidates)];
}

function keyFromKeychain(provider) {
  if (process.platform !== "darwin" || TARGET !== "codex") return undefined;
  for (const service of provider.credential.keychainServices || []) {
    try {
      const value = execFileSync(
        "/usr/bin/security",
        ["find-generic-password", "-s", service, "-a", "default", "-w"],
        { encoding: "utf8", timeout: 2_000, stdio: ["ignore", "pipe", "ignore"] },
      ).trim();
      if (value) return { value, source: `macOS Keychain (${service})` };
    } catch {
      // Try the next compatible service name.
    }
  }
  return undefined;
}

export function resolveProviderCredential(providerOrId, options = {}) {
  const provider =
    typeof providerOrId === "string" ? apiProvider(providerOrId) : providerOrId;
  // Nothing to resolve for a loopback provider: it authenticates no one. The
  // placeholder keeps the forwarder's header shape uniform, and the registry
  // guarantees keyless providers are loopback-only, so it never leaves the
  // machine.
  if (provider.keyless) {
    return { value: "local", source: "local endpoint (no key required)", persistent: true };
  }
  if (!options.persistent) {
    for (const name of provider.credential.environment) {
      const value = process.env[name]?.trim();
      if (value) return { value, source: `environment (${name})`, persistent: false };
    }
  }
  for (const candidate of credentialPaths(provider)) {
    if (!existsSync(candidate)) continue;
    const value = readFileSync(candidate, "utf8").trim();
    if (value) {
      return { value, source: `protected file (${candidate})`, persistent: true };
    }
  }
  const keychain = keyFromKeychain(provider);
  if (keychain) return { ...keychain, persistent: true };
  // The provider CLI's own sign-in comes last: a key the user deliberately
  // stored here, or exported into the environment, stays in charge, and the
  // session only fills the gap for someone who never pasted one.
  const session = readCliSessionCredential(provider);
  return session
    ? { value: session.value, source: session.label, persistent: true }
    : undefined;
}

// Providers that support a CLI sign-in have two equally valid setup paths, and
// naming only the key one would hide the OAuth flow from every surface that
// prints this sentence (doctor, discovery errors, the enable gate).
export function credentialSetupHint(provider) {
  if (provider.keyless) return "No key needed; it runs on this machine.";
  const keyCommand = targetCli(`provider-key ${provider.id} set`);
  const session = cliSessionDescriptor(provider);
  return session
    ? `Run \`${session.loginCommand}\`, or run ${keyCommand}`
    : `Run ${keyCommand}`;
}

export function credentialStatus(providerOrId, options = {}) {
  const provider =
    typeof providerOrId === "string" ? apiProvider(providerOrId) : providerOrId;
  const credential = resolveProviderCredential(provider, options);
  return credential
    ? { configured: true, source: credential.source, persistent: credential.persistent }
    : { configured: false, setup: credentialSetupHint(provider) };
}

export function writeProviderCredential(providerOrId, value) {
  const provider =
    typeof providerOrId === "string" ? apiProvider(providerOrId) : providerOrId;
  const key = String(value || "").trim();
  if (!key) throw new Error("No API key was entered; nothing changed.");
  mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
  chmodSync(STATE_DIR, 0o700);
  const target = primaryCredentialPath(provider);
  const temporary = `${target}.tmp.${process.pid}`;
  writeFileSync(temporary, `${key}\n`, { encoding: "utf8", mode: 0o600 });
  try {
    protectPrivateFile(temporary);
    renameSync(temporary, target);
    protectPrivateFile(target);
  } catch (error) {
    if (existsSync(temporary)) unlinkSync(temporary);
    throw error;
  }
  return target;
}

export function removeProviderCredential(providerOrId) {
  const provider =
    typeof providerOrId === "string" ? apiProvider(providerOrId) : providerOrId;
  let removed = 0;
  for (const candidate of credentialPaths(provider)) {
    if (!existsSync(candidate)) continue;
    unlinkSync(candidate);
    removed += 1;
  }
  return removed;
}

export function credentialFileMode(providerOrId) {
  const provider =
    typeof providerOrId === "string" ? apiProvider(providerOrId) : providerOrId;
  const target = primaryCredentialPath(provider);
  return existsSync(target) ? statSync(target).mode & 0o777 : undefined;
}
