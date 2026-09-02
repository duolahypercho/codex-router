import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

import { discoveryDisabled } from "./discovery-mode.mjs";
import { protectPrivateFile } from "./file-security.mjs";
import { normalizeGenericProviderId } from "./generic-provider-identity.mjs";
import {
  GENERIC_PROVIDER_CREDENTIALS_DIR,
  LEGACY_STATE_DIRS,
  ROUTER_PLANE_TARGET,
  STATE_DIR,
  TARGET,
} from "./paths.mjs";
import { targetCli } from "./target-integration.mjs";
import { PROVIDERS } from "./model-registry.mjs";
import {
  assertGitHubCopilotCredential,
  githubCopilotCredentialProblem,
} from "./github-copilot-session.mjs";
import {
  resolveVertexCredential,
  vertexCredentialSetupHint,
  vertexCredentialStatus,
} from "./vertex-credentials.mjs";

export function apiProvider(providerId) {
  const provider = PROVIDERS.get(providerId);
  if (
    !provider ||
    provider.kind !== "openai-compatible" ||
    ["anonymous", "per-model"].includes(provider.authMode)
  ) {
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
  if (!provider.credential?.file) return [];
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
// protected file in the state directory, while `kimi login` and `grok login`
// write their own OAuth files. Both stay live on every call, and files are
// checked *before*
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

function canonicalProviderId(provider) {
  return provider.variantOf || provider.id;
}

function genericCredentialProvider(providerId) {
  const id = normalizeGenericProviderId(providerId, { reservedProviderIds: PROVIDERS });
  return {
    id,
    kind: "openai-compatible",
    credential: {
      file: path.relative(STATE_DIR, path.join(GENERIC_PROVIDER_CREDENTIALS_DIR, `${id}.key`)),
      label: "API key",
      environment: [],
      keychainServices: [],
    },
  };
}

export function genericProviderCredentialPath(providerId) {
  return primaryCredentialPath(genericCredentialProvider(providerId));
}

function configuredProviderFileCredential(provider) {
  for (const candidate of credentialPaths(provider)) {
    let stat;
    try {
      stat = lstatSync(candidate);
    } catch (error) {
      if (error?.code === "ENOENT") continue;
      continue;
    }
    if (stat.isSymbolicLink() || !stat.isFile()) continue;
    try {
      const value = readFileSync(candidate, "utf8").trim();
      if (value) {
        const credential = resolvedCredential(
          provider,
          value,
          "protected file",
          true,
        );
        if (credential) return credential;
      }
    } catch {
      // A file that cannot be read is not a usable credential source.
    }
  }
  return undefined;
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
  // A per-model-endpoint provider holds no credential of its own: each of its
  // models resolves through this same function with its own endpoint
  // descriptor. Answering "configured" here is what lets the container take
  // part in selection, health, and the catalog; a model whose own endpoint
  // needs a key still reports that against the key it actually wants.
  if (provider.authMode === "per-model") {
    return { value: undefined, source: "per-model endpoints", persistent: true };
  }
  if (provider.credential?.resolver === "google-application-default") {
    return resolveVertexCredential(options);
  }
  // Nothing to resolve for a loopback provider: it authenticates no one. The
  // placeholder keeps the forwarder's header shape uniform, and the registry
  // guarantees keyless providers are loopback-only, so it never leaves the
  // machine.
  if (provider.keyless) {
    return { value: "local", source: "local endpoint (no key required)", persistent: true };
  }
  // The --no-discovery promise: no environment sniffing, no credential files,
  // no Keychain spawn, no other CLI's session file. The guard sits here, after
  // the anonymous and keyless returns, because those two read nothing -- and
  // before everything that does.
  if (discoveryDisabled()) return undefined;
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
    let stat;
    try {
      stat = lstatSync(candidate);
    } catch (error) {
      if (error?.code === "ENOENT") continue;
      continue;
    }
    if (stat.isSymbolicLink() || !stat.isFile()) continue;
    try {
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
    } catch {
      // An unreadable or non-text file is not a usable credential source.
    }
  }
  const keychain = keyFromKeychain(provider);
  if (keychain) {
    const credential = resolvedCredential(provider, keychain.value, keychain.source, true);
    if (credential) return credential;
  }
  return undefined;
}

/**
 * Resolve one metadata-only credential reference without changing the
 * provider's existing single-credential path. References are bound to this
 * target and to source names declared by the provider registry; raw secrets,
 * arbitrary paths, services, and environment variables are rejected.
 */
export function resolveProviderCredentialReference(providerOrId, secretRef) {
  const provider =
    typeof providerOrId === "string" ? PROVIDERS.get(providerOrId) : providerOrId;
  if (!provider || provider.kind !== "openai-compatible") return undefined;
  if (!secretRef || typeof secretRef !== "object" || Array.isArray(secretRef)) {
    return undefined;
  }
  const referenceKeys = new Set(["type", "providerId", "target", "service", "name"]);
  if (Object.keys(secretRef).some((key) => !referenceKeys.has(key))) return undefined;
  if (secretRef.target !== ROUTER_PLANE_TARGET) return undefined;
  if (secretRef.providerId !== canonicalProviderId(provider)) {
    return undefined;
  }
  if (discoveryDisabled()) return undefined;
  const type = typeof secretRef.type === "string" ? secretRef.type.trim() : "";
  if (type === "provider-file") {
    if (secretRef.service !== undefined || secretRef.name !== undefined) return undefined;
    return configuredProviderFileCredential(provider);
  }
  if (type === "environment") {
    if (secretRef.service !== undefined) return undefined;
    const name = typeof secretRef.name === "string" ? secretRef.name.trim() : "";
    if (!provider.credential?.environment?.includes(name)) return undefined;
    const value = process.env[name]?.trim();
    if (!value) return undefined;
    return resolvedCredential(provider, value, `environment (${name})`, false);
  }
  if (type === "keychain") {
    if (secretRef.name !== undefined) return undefined;
    if (process.platform !== "darwin") return undefined;
    const service = typeof secretRef.service === "string" ? secretRef.service.trim() : "";
    if (!provider.credential?.keychainServices?.includes(service)) return undefined;
    const found = keychainSecret(service, Date.now());
    return found
      ? resolvedCredential(provider, found.value, `macOS Keychain (${service})`, true)
      : undefined;
  }
  // OAuth sessions are provider-specific and remain owned by their existing
  // refresh/session implementations. Returning undefined keeps a pool entry
  // from accidentally forwarding an opaque session id as an API key.
  return undefined;
}

/**
 * Resolve a generic provider's deliberately narrow protected-file reference.
 * Built-in provider resolution remains registry-bound above; this separate
 * entry point cannot name environment variables, Keychain services, or paths.
 */
export function resolveGenericProviderCredentialReference(providerId, secretRef) {
  let provider;
  try {
    provider = genericCredentialProvider(providerId);
  } catch {
    return undefined;
  }
  if (!secretRef || typeof secretRef !== "object" || Array.isArray(secretRef)) return undefined;
  const referenceKeys = new Set(["type", "providerId", "target", "service", "name"]);
  if (Object.keys(secretRef).some((key) => !referenceKeys.has(key))) return undefined;
  if (
    secretRef.type !== "provider-file" ||
    secretRef.providerId !== provider.id ||
    secretRef.target !== ROUTER_PLANE_TARGET ||
    secretRef.service !== undefined ||
    secretRef.name !== undefined ||
    discoveryDisabled()
  ) {
    return undefined;
  }
  return configuredProviderFileCredential(provider);
}

export function credentialSetupHint(provider) {
  if (provider.authMode === "anonymous") return "No key needed; free models are rate limited by the provider.";
  if (provider.authMode === "per-model") return "No key needed here; each model names its own endpoint.";
  if (provider.keyless) return "No key needed; it runs on this machine.";
  if (provider.credential?.resolver === "google-application-default") {
    return vertexCredentialSetupHint({ persistent: true });
  }
  const keyCommand = targetCli(`provider-key ${provider.id} set`);
  return `Run ${keyCommand}`;
}

export function credentialLabel(provider) {
  if (provider.authMode === "anonymous") return "No API key";
  if (provider.authMode === "per-model") return "Per-model endpoints";
  return provider.credential?.label || "API key";
}

export function credentialStatus(providerOrId, options = {}) {
  const provider =
    typeof providerOrId === "string" ? PROVIDERS.get(providerOrId) : providerOrId;
  if (!provider || provider.kind !== "openai-compatible") {
    throw new Error(`Unknown API-key provider: ${typeof providerOrId === "string" ? providerOrId : "unknown"}`);
  }
  if (provider.credential?.resolver === "google-application-default") {
    return vertexCredentialStatus(options);
  }
  const credential = resolveProviderCredential(provider, options);
  return credential
    ? { configured: true, source: credential.source, persistent: credential.persistent }
    : { configured: false, setup: credentialSetupHint(provider) };
}

export function writeProviderCredential(providerOrId, value) {
  const provider =
    typeof providerOrId === "string" ? apiProvider(providerOrId) : providerOrId;
  if (provider.credential?.resolver === "google-application-default") {
    throw new Error(
      `${provider.displayName} does not accept API keys; ${credentialSetupHint(provider)}`,
    );
  }
  const key = String(value || "").trim();
  if (!key) throw new Error(`No ${credentialLabel(provider)} was entered; nothing changed.`);
  if (provider.authProfile === "github-copilot") {
    assertGitHubCopilotCredential(key);
  }
  mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
  chmodSync(STATE_DIR, 0o700);
  const target = primaryCredentialPath(provider);
  mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  chmodSync(path.dirname(target), 0o700);
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

export function writeGenericProviderCredential(providerId, value) {
  return writeProviderCredential(genericCredentialProvider(providerId), value);
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

export function removeGenericProviderCredential(providerId) {
  return removeProviderCredential(genericCredentialProvider(providerId));
}

export function credentialFileMode(providerOrId) {
  const provider =
    typeof providerOrId === "string" ? apiProvider(providerOrId) : providerOrId;
  const target = primaryCredentialPath(provider);
  return existsSync(target) ? statSync(target).mode & 0o777 : undefined;
}
