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
import {
  assertGitHubCopilotCredential,
  githubCopilotCredentialProblem,
} from "./github-copilot-session.mjs";

export function apiProvider(providerId) {
  const provider = PROVIDERS.get(providerId);
  if (!provider || provider.kind !== "openai-compatible" || provider.authMode === "anonymous") {
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

// Every other source this module consults is a `statSync`/`readFileSync` pair
// costing microseconds. This one spawns a process, and it is the only reason
// resolving credentials is expensive at all: on this tree a full pass over the
// registry is 26 keychain services, measured at ~9ms per spawn -- 235ms of a
// 235.5ms scan. Because `execFileSync` is synchronous, that quarter second is
// spent with the event loop stopped, so a single routed turn that resolves
// credentials stalls every other in-flight request too.
//
// So the spawn is memoized, and only the spawn. Scope is the point: the router
// **never writes a Keychain item** -- `writeProviderCredential` below writes a
// protected file in the state directory, `kimi login` and `grok login` write
// their own OAuth files, and `command-code login` writes its own session file.
// All three of those stay live on every call, and files are checked *before*
// the Keychain, so a key the operator adds through any documented path is
// visible immediately. What can go stale is only a key some other tool put in
// the login keychain behind the router's back, which nothing in this repository
// does. Thirty seconds is the ceiling on noticing that; see `resetKeychainCache`
// for the same-process paths that shorten it to zero.
//
// The cached entry holds the secret in memory for that window. That is not a
// new exposure: the value is already read into memory on every resolve and
// forwarded upstream, and it is never logged or written out from here.
const KEYCHAIN_CACHE_TTL_MS = 30_000;
const keychainCache = new Map();
let keychainProbes = 0;

// Test-visible evidence that the memo is doing its job, without resorting to a
// timing threshold. Counts actual `/usr/bin/security` spawns.
export function keychainProbeCount() {
  return keychainProbes;
}

// Anything that changes what this process believes about stored credentials
// drops the memo, so a write followed by a read inside one process is never
// served a stale answer. In practice credentials are written by short-lived CLI
// processes (`provider-key set`, `bin/control credential`) rather than by the
// long-running router, so this is a correctness backstop for same-process
// sequences -- installer and tray flows that store a key and then immediately
// rebuild the catalog -- and the TTL is what governs the router itself.
export function resetKeychainCache() {
  keychainCache.clear();
}

function keychainSecret(service, now) {
  const cached = keychainCache.get(service);
  if (cached && now - cached.at < KEYCHAIN_CACHE_TTL_MS) return cached.result;
  keychainProbes += 1;
  let result = null;
  try {
    const value = execFileSync(
      "/usr/bin/security",
      ["find-generic-password", "-s", service, "-a", "default", "-w"],
      { encoding: "utf8", timeout: 2_000, stdio: ["ignore", "pipe", "ignore"] },
    ).trim();
    if (value) result = { value, source: `macOS Keychain (${service})` };
  } catch {
    // No such item, or the keychain refused. Either way: nothing here.
  }
  // A miss is cached as deliberately as a hit. The absent case is both the
  // common one and the expensive one -- a machine with no keychain items pays
  // the full 26 spawns every pass -- so caching only hits would have left the
  // cost exactly where it was.
  keychainCache.set(service, { at: now, result });
  return result;
}

function keyFromKeychain(provider) {
  if (process.platform !== "darwin" || TARGET !== "codex") return undefined;
  const now = Date.now();
  for (const service of provider.credential.keychainServices || []) {
    const found = keychainSecret(service, now);
    if (found) return found;
    // Otherwise try the next compatible service name.
  }
  return undefined;
}

function resolvedCredential(provider, value, source, persistent) {
  if (provider.authProfile === "github-copilot" && githubCopilotCredentialProblem(value)) {
    return undefined;
  }
  return { value, source, persistent };
}

export function resolveProviderCredential(providerOrId, options = {}) {
  const provider =
    typeof providerOrId === "string" ? PROVIDERS.get(providerOrId) : providerOrId;
  if (!provider || provider.kind !== "openai-compatible") {
    throw new Error(`Unknown API-key provider: ${typeof providerOrId === "string" ? providerOrId : "unknown"}`);
  }
  // Anonymous providers deliberately carry no secret. Returning a persistent
  // marker makes them participate in the same configured/selected/catalog
  // flow as local Ollama without ever creating a credential file or header.
  if (provider.authMode === "anonymous") {
    return { value: undefined, source: "official anonymous endpoint", persistent: true };
  }
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
      if (value) {
        const credential = resolvedCredential(provider, value, `environment (${name})`, false);
        if (credential) return credential;
      }
    }
  }
  for (const candidate of credentialPaths(provider)) {
    if (!existsSync(candidate)) continue;
    const value = readFileSync(candidate, "utf8").trim();
    if (value) {
      const credential = resolvedCredential(
        provider,
        value,
        `protected file (${candidate})`,
        true,
      );
      if (credential) return credential;
    }
  }
  const keychain = keyFromKeychain(provider);
  if (keychain) {
    const credential = resolvedCredential(provider, keychain.value, keychain.source, true);
    if (credential) return credential;
  }
  // The provider CLI's own sign-in comes last: a key the user deliberately
  // stored here, or exported into the environment, stays in charge, and the
  // session only fills the gap for someone who never pasted one.
  const session = readCliSessionCredential(provider);
  return session
    ? resolvedCredential(provider, session.value, session.label, true)
    : undefined;
}

// Providers that support a CLI sign-in have two equally valid setup paths, and
// naming only the key one would hide the OAuth flow from every surface that
// prints this sentence (doctor, discovery errors, the enable gate).
export function credentialSetupHint(provider) {
  if (provider.authMode === "anonymous") return "No key needed; free models are rate limited by the provider.";
  if (provider.keyless) return "No key needed; it runs on this machine.";
  const keyCommand = targetCli(`provider-key ${provider.id} set`);
  const session = cliSessionDescriptor(provider);
  return session
    ? `Run \`${session.loginCommand}\`, or run ${keyCommand}`
    : `Run ${keyCommand}`;
}

export function credentialLabel(provider) {
  if (provider.authMode === "anonymous") return "No API key";
  return provider.credential?.label || "API key";
}

export function credentialStatus(providerOrId, options = {}) {
  const provider =
    typeof providerOrId === "string" ? PROVIDERS.get(providerOrId) : providerOrId;
  if (!provider || provider.kind !== "openai-compatible") {
    throw new Error(`Unknown API-key provider: ${typeof providerOrId === "string" ? providerOrId : "unknown"}`);
  }
  const credential = resolveProviderCredential(provider, options);
  return credential
    ? { configured: true, source: credential.source, persistent: credential.persistent }
    : { configured: false, setup: credentialSetupHint(provider) };
}

export function writeProviderCredential(providerOrId, value) {
  const provider =
    typeof providerOrId === "string" ? apiProvider(providerOrId) : providerOrId;
  const key = String(value || "").trim();
  if (!key) throw new Error(`No ${credentialLabel(provider)} was entered; nothing changed.`);
  if (provider.authProfile === "github-copilot") {
    assertGitHubCopilotCredential(key);
  }
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
  resetKeychainCache();
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
  // Deleting the files makes the Keychain the next thing consulted, and
  // `removeApiCredential` reports what still resolves afterwards. That answer
  // has to come from a fresh look.
  resetKeychainCache();
  return removed;
}

export function credentialFileMode(providerOrId) {
  const provider =
    typeof providerOrId === "string" ? apiProvider(providerOrId) : providerOrId;
  const target = primaryCredentialPath(provider);
  return existsSync(target) ? statSync(target).mode & 0o777 : undefined;
}
