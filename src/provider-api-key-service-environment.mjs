import {
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
} from "node:fs";
import path from "node:path";
import { discoveryDisabled } from "./discovery-mode.mjs";
import { fileURLToPath } from "node:url";

import {
  PROVIDER_API_KEY_POOL_PATH,
  PROVIDER_CREDENTIAL_STORE_PATH,
} from "./paths.mjs";

const MODULE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const REGISTRY_ROOT = path.join(MODULE_ROOT, "config");
const MAX_STATE_BYTES = 4 * 1024 * 1024;
const ENVIRONMENT_NAME = /^[A-Z][A-Z0-9_]{0,99}$/;
const CREDENTIAL_ID = /^cred_[A-Za-z0-9_-]{16,64}$/;

function record(value) {
  return value && typeof value === "object" && !Array.isArray(value);
}

function boundedJson(filePath) {
  if (!existsSync(filePath)) return undefined;
  try {
    const stat = lstatSync(filePath);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_STATE_BYTES) return undefined;
    return JSON.parse(readFileSync(filePath, "utf8"));
  } catch {
    return undefined;
  }
}

function registryFiles(directory) {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...registryFiles(target));
    else if (entry.isFile() && entry.name.endsWith(".json")) files.push(target);
  }
  return files;
}

// Read the allowlist from the checked-in registry beside this module, not from
// CODEX_ROUTER_SOURCE_ROOT. Service render tests and packaged launchers may
// deliberately point that variable at the eventual install location before
// its config tree exists; importing the live model registry in that phase
// would make an otherwise state-free service impossible to render.
function providerEnvironmentPolicy() {
  const policy = new Map();
  try {
    for (const file of registryFiles(REGISTRY_ROOT)) {
      const fragment = boundedJson(file);
      if (fragment?.version !== 1 || !Array.isArray(fragment.providers)) continue;
      for (const provider of fragment.providers) {
        if (!record(provider) || typeof provider.id !== "string") continue;
        const canonical = typeof provider.variantOf === "string" && provider.variantOf
          ? provider.variantOf
          : provider.id;
        const names = provider.credential?.environment;
        if (!Array.isArray(names)) continue;
        const allowed = policy.get(canonical) || new Set();
        for (const name of names) {
          if (typeof name === "string" && ENVIRONMENT_NAME.test(name)) allowed.add(name);
        }
        policy.set(canonical, allowed);
      }
    }
  } catch {
    return new Map();
  }
  return policy;
}

function pooledCredentialProviders(poolDocument) {
  if (!record(poolDocument) || poolDocument.version !== 1 || !record(poolDocument.providers)) {
    return undefined;
  }
  const owners = new Map();
  for (const [providerId, pool] of Object.entries(poolDocument.providers)) {
    if (!record(pool) || !record(pool.credentials)) return undefined;
    for (const credentialId of Object.keys(pool.credentials)) {
      if (!CREDENTIAL_ID.test(credentialId)) return undefined;
      if (owners.has(credentialId) && owners.get(credentialId) !== providerId) return undefined;
      owners.set(credentialId, providerId);
    }
  }
  return owners;
}

// Environment references are metadata-only until the managed service is
// rendered. Carry only variables that are registry-allowlisted, active, and
// referenced by a credential currently present in an authoritative pool. An
// unrelated provider key is therefore never copied into a private service
// definition merely because it happened to exist in the installer's shell.
export function providerApiKeyServiceEnvironment({
  environment = process.env,
  poolStatePath = PROVIDER_API_KEY_POOL_PATH,
  credentialStorePath = PROVIDER_CREDENTIAL_STORE_PATH,
} = {}) {
  if (discoveryDisabled()) return {};
  const owners = pooledCredentialProviders(boundedJson(poolStatePath));
  if (!owners?.size) return {};
  const store = boundedJson(credentialStorePath);
  if (!record(store) || store.schemaVersion !== 2 || !Array.isArray(store.credentials)) return {};
  const policy = providerEnvironmentPolicy();
  const values = {};
  for (const credential of store.credentials) {
    if (
      !record(credential) ||
      !CREDENTIAL_ID.test(credential.id || "") ||
      owners.get(credential.id) !== credential.providerId ||
      credential.state !== "active" ||
      credential.kind !== "api_key" ||
      !record(credential.secretRef) ||
      credential.secretRef.type !== "environment" ||
      credential.secretRef.providerId !== credential.providerId ||
      credential.secretRef.target !== "codex"
    ) {
      continue;
    }
    const name = credential.secretRef.name;
    if (!policy.get(credential.providerId)?.has(name)) continue;
    const value = typeof environment[name] === "string" ? environment[name] : "";
    if (!value.trim()) continue;
    if (/[\u0000-\u001f\u007f]/.test(value)) {
      throw new Error(`Provider pool environment ${name} contains unsupported control characters.`);
    }
    values[name] = value;
  }
  return values;
}
