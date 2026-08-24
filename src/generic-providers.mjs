import { promises as dns } from "node:dns";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { PROVIDERS } from "./model-registry.mjs";
import { GENERIC_PROVIDERS_PATH } from "./paths.mjs";

export { GENERIC_PROVIDERS_PATH } from "./paths.mjs";
import { writePrivateJson } from "./file-security.mjs";

// Generic providers are deliberately kept in a separate user-owned document.
// The checked-in registry remains the authority for native and curated models;
// P06 can merge this descriptor into that registry after capability discovery.
// Keeping the two documents separate also means a checkout update cannot erase
// an operator's endpoint definitions.
export const GENERIC_PROVIDER_SCHEMA_VERSION = 1;
export const GENERIC_PROVIDER_ADAPTERS = Object.freeze([
  "openai-chat",
  "openai-responses",
  "openai-completions",
]);

// These names are either hop-by-hop transport headers or common secret
// carriers. A generic provider may declare static routing metadata, but P02's
// credential references must be used for authentication headers later.
const FORBIDDEN_HEADER_NAMES = new Set([
  "authorization",
  "proxy-authorization",
  "x-api-key",
  "api-key",
  "cookie",
  "set-cookie",
  "host",
  "content-length",
  "connection",
  "keep-alive",
  "transfer-encoding",
  "upgrade",
]);

const ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/;
const HEADER_NAME_PATTERN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const MAX_HEADERS = 64;
const MAX_HEADER_VALUE_LENGTH = 4_096;
const MAX_DESCRIPTION_LENGTH = 240;

function text(value) {
  return typeof value === "string" ? value.trim() : "";
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function normalizeBaseUrl(value) {
  return text(value).replace(/\/+$/, "");
}

function isIpv4(value) {
  const parts = value.split(".");
  return parts.length === 4 && parts.every((part) => /^\d+$/.test(part) && Number(part) <= 255);
}

function isPrivateIpv4(value) {
  if (!isIpv4(value)) return false;
  const [a, b] = value.split(".").map(Number);
  return (
    a === 10 ||
    a === 127 ||
    a === 0 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168)
  );
}

function isPrivateHostname(hostname) {
  const host = String(hostname || "").toLowerCase().replace(/^\[|\]$/g, "");
  if (!host) return false;
  if (isPrivateIpv4(host)) return true;
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) {
    return true;
  }
  // IPv6 loopback, link-local and unique-local ranges. This intentionally
  // does not try to parse every IPv6 spelling; DNS lookup in testGenericProvider
  // catches resolved private addresses before a request is sent.
  return (
    host === "::1" ||
    host.startsWith("fc") ||
    host.startsWith("fd") ||
    host.startsWith("fe80:") ||
    host === "0:0:0:0:0:0:0:1"
  );
}

function validateEndpoint(urlValue, allowPrivate) {
  const baseUrl = normalizeBaseUrl(urlValue);
  let parsed;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw new Error("baseUrl must be an absolute HTTP(S) URL.");
  }
  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new Error("baseUrl must use http or https.");
  }
  if (!parsed.hostname || parsed.username || parsed.password) {
    throw new Error("baseUrl must not contain credentials and must include a hostname.");
  }
  if (parsed.search || parsed.hash) {
    throw new Error("baseUrl must not contain a query string or fragment.");
  }
  const privateHost = isPrivateHostname(parsed.hostname);
  if (parsed.protocol === "http:" && (!allowPrivate || !privateHost)) {
    throw new Error("Plain HTTP endpoints must be private and require allowPrivate=true.");
  }
  if (privateHost && !allowPrivate) {
    throw new Error("Private or loopback endpoints require allowPrivate=true.");
  }
  return { baseUrl, privateHost };
}

function validateHeaders(raw) {
  if (raw === undefined) return {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("headers must be an object of static header values.");
  }
  const entries = Object.entries(raw);
  if (entries.length > MAX_HEADERS) throw new Error(`headers may contain at most ${MAX_HEADERS} entries.`);
  const headers = {};
  for (const [nameValue, valueValue] of entries) {
    const name = text(nameValue);
    const lower = name.toLowerCase();
    const value = typeof valueValue === "string" ? valueValue : "";
    if (!HEADER_NAME_PATTERN.test(name)) throw new Error(`Invalid header name: ${nameValue}`);
    if (FORBIDDEN_HEADER_NAMES.has(lower)) {
      throw new Error(`Header ${name} is reserved for credential or transport handling.`);
    }
    if (!value || value.length > MAX_HEADER_VALUE_LENGTH || /[\r\n]/.test(value)) {
      throw new Error(`Header ${name} has an invalid value.`);
    }
    headers[name] = value;
  }
  return headers;
}

function validateCredentialRef(value) {
  if (value === undefined || value === null || value === "") return undefined;
  const ref = text(value);
  if (!/^cred_[a-zA-Z0-9][a-zA-Z0-9._:-]{2,127}$/.test(ref)) {
    throw new Error("credentialRef must be an opaque id beginning with cred_.");
  }
  return ref;
}

function validateProvider(input, { existingId } = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("A generic provider must be an object.");
  }
  const id = text(input.id);
  if (!ID_PATTERN.test(id)) throw new Error("Provider id must match [a-z0-9][a-z0-9-]*.");
  if (existingId !== undefined && id !== existingId) {
    throw new Error("Provider id cannot be changed; remove and add a new provider instead.");
  }
  if (PROVIDERS.has(id)) throw new Error(`Provider id ${id} is already used by the built-in registry.`);
  const displayName = text(input.displayName);
  if (!displayName || displayName.length > 120) {
    throw new Error("displayName must be a non-empty string of at most 120 characters.");
  }
  const adapter = text(input.adapter) || "openai-chat";
  if (!GENERIC_PROVIDER_ADAPTERS.includes(adapter)) {
    throw new Error(`adapter must be one of: ${GENERIC_PROVIDER_ADAPTERS.join(", ")}.`);
  }
  const allowPrivate = input.allowPrivate === undefined ? false : input.allowPrivate;
  if (typeof allowPrivate !== "boolean") throw new Error("allowPrivate must be a boolean.");
  const { baseUrl } = validateEndpoint(input.baseUrl, allowPrivate);
  const headers = validateHeaders(input.headers);
  const credentialRef = validateCredentialRef(input.credentialRef);
  const description = input.description === undefined ? undefined : text(input.description);
  if (description !== undefined && description.length > MAX_DESCRIPTION_LENGTH) {
    throw new Error(`description must be at most ${MAX_DESCRIPTION_LENGTH} characters.`);
  }
  const enabled = input.enabled === undefined ? true : input.enabled;
  if (typeof enabled !== "boolean") throw new Error("enabled must be a boolean.");
  return {
    id,
    displayName,
    ...(description ? { description } : {}),
    baseUrl,
    adapter,
    headers,
    ...(credentialRef ? { credentialRef } : {}),
    allowPrivate,
    enabled,
  };
}

function parseDocument(payload) {
  if (payload === undefined) return { version: GENERIC_PROVIDER_SCHEMA_VERSION, providers: [] };
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error(`Invalid generic provider state ${GENERIC_PROVIDERS_PATH}: expected an object.`);
  }
  if (payload.version !== GENERIC_PROVIDER_SCHEMA_VERSION || !Array.isArray(payload.providers)) {
    throw new Error(
      `Invalid generic provider state ${GENERIC_PROVIDERS_PATH}: version must be ${GENERIC_PROVIDER_SCHEMA_VERSION} and providers must be an array.`,
    );
  }
  const providers = [];
  const seen = new Set();
  for (const entry of payload.providers) {
    const provider = validateProvider(entry);
    if (seen.has(provider.id)) throw new Error(`Duplicate generic provider id ${provider.id}.`);
    seen.add(provider.id);
    providers.push(provider);
  }
  return { version: GENERIC_PROVIDER_SCHEMA_VERSION, providers };
}

export function readGenericProviders() {
  if (!existsSync(GENERIC_PROVIDERS_PATH)) return [];
  let payload;
  try {
    payload = JSON.parse(readFileSync(GENERIC_PROVIDERS_PATH, "utf8"));
  } catch (error) {
    throw new Error(`Could not read generic provider state: ${errorMessage(error)}`);
  }
  return parseDocument(payload).providers;
}

export function redactGenericProvider(provider) {
  const value = validateProvider(provider, { existingId: provider.id });
  return {
    ...value,
    headers: Object.fromEntries(Object.keys(value.headers).map((name) => [name, "[redacted]"])),
  };
}

export function listGenericProviders({ redacted = true } = {}) {
  const providers = readGenericProviders();
  return providers.map((provider) => redacted ? redactGenericProvider(provider) : provider);
}

export function getGenericProvider(id, { redacted = false } = {}) {
  const provider = readGenericProviders().find((entry) => entry.id === text(id));
  if (!provider) throw new Error(`Unknown generic provider: ${id}`);
  return redacted ? redactGenericProvider(provider) : provider;
}

function saveProviders(providers) {
  writePrivateJson(
    GENERIC_PROVIDERS_PATH,
    { version: GENERIC_PROVIDER_SCHEMA_VERSION, providers },
    { directoryMode: 0o700 },
  );
}

function mutateProviders(mutator) {
  const current = readGenericProviders();
  const next = mutator(current.map((provider) => ({ ...provider, headers: { ...provider.headers } })));
  if (!Array.isArray(next)) throw new Error("Generic provider mutation returned an invalid list.");
  const validated = parseDocument({ version: GENERIC_PROVIDER_SCHEMA_VERSION, providers: next }).providers;
  saveProviders(validated);
  return validated;
}

export function addGenericProvider(input) {
  const provider = validateProvider(input);
  const current = readGenericProviders();
  if (current.some((entry) => entry.id === provider.id)) {
    throw new Error(`Generic provider ${provider.id} already exists.`);
  }
  mutateProviders((providers) => [...providers, provider]);
  return redactGenericProvider(provider);
}

export function updateGenericProvider(id, patch) {
  const current = readGenericProviders();
  const existing = current.find((entry) => entry.id === text(id));
  if (!existing) throw new Error(`Unknown generic provider: ${id}`);
  const next = validateProvider({ ...existing, ...patch, id: existing.id }, { existingId: existing.id });
  mutateProviders((providers) => providers.map((entry) => entry.id === existing.id ? next : entry));
  return redactGenericProvider(next);
}

export function removeGenericProvider(id) {
  const providerId = text(id);
  const current = readGenericProviders();
  if (!current.some((entry) => entry.id === providerId)) throw new Error(`Unknown generic provider: ${id}`);
  const next = mutateProviders((providers) => providers.filter((entry) => entry.id !== providerId));
  return { removed: providerId, remaining: next.length };
}

export function setGenericProviderEnabled(id, enabled) {
  if (typeof enabled !== "boolean") throw new Error("enabled must be a boolean.");
  return updateGenericProvider(id, { enabled });
}

// This descriptor is intentionally not inserted into PROVIDERS yet. P05/P06
// can map `adapter` to a wire protocol and merge it with discovered models,
// while native GPT catalog ownership stays untouched in the meantime.
export function genericProviderDescriptor(providerOrId) {
  const provider = typeof providerOrId === "string"
    ? getGenericProvider(providerOrId)
    : validateProvider(providerOrId, { existingId: providerOrId.id });
  return {
    id: provider.id,
    displayName: provider.displayName,
    kind: "openai-compatible",
    ownedBy: provider.id,
    baseUrl: provider.baseUrl,
    adapter: provider.adapter,
    protocol: provider.adapter === "openai-responses" ? "openai-responses" : "openai",
    headers: { ...provider.headers },
    allowPrivate: provider.allowPrivate,
    enabled: provider.enabled,
    ...(provider.credentialRef ? { credentialRef: provider.credentialRef } : {}),
    generic: true,
  };
}

async function lookupHost(hostname) {
  try {
    const addresses = await dns.lookup(hostname, { all: true, verbatim: true });
    return addresses.map((entry) => entry.address);
  } catch (error) {
    throw new Error(`Could not resolve provider host ${hostname}: ${errorMessage(error)}`);
  }
}

export async function testGenericProvider(id, { fetchImpl = globalThis.fetch, timeoutMs = 10_000 } = {}) {
  const provider = getGenericProvider(id);
  const endpoint = new URL(provider.baseUrl);
  const resolved = await lookupHost(endpoint.hostname);
  if (!provider.allowPrivate && resolved.some(isPrivateHostname)) {
    throw new Error("Provider host resolved to a private or loopback address; set allowPrivate=true explicitly.");
  }
  const response = await fetchImpl(`${provider.baseUrl}/models`, {
    method: "GET",
    headers: { Accept: "application/json", ...provider.headers },
    signal: AbortSignal.timeout(timeoutMs),
  });
  return {
    ok: response.ok,
    status: response.status,
    endpoint: `${provider.baseUrl}/models`,
    ...(response.ok ? { message: "Provider endpoint is reachable." } : { message: "Provider endpoint returned an error." }),
  };
}

function parseHeader(raw) {
  const separator = String(raw).indexOf("=");
  if (separator < 1) throw new Error("Headers must use Name=Value syntax.");
  return [String(raw).slice(0, separator), String(raw).slice(separator + 1)];
}

function optionValue(args, name) {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
}

function optionValues(args, name) {
  const values = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === name) values.push(args[index + 1]);
  }
  return values;
}

function cliUsage() {
  throw new Error(
    "Usage: providers generic list [--json] | add ID --name NAME --base-url URL " +
      "[--adapter openai-chat|openai-responses|openai-completions] [--header Name=Value] " +
      "[--credential-ref cred_ID] [--description TEXT] [--allow-private] | edit ID [options] | show ID [--json] | " +
      "enable ID | disable ID | remove ID | test ID [--json]",
  );
}

export async function runGenericProviderCli(args = process.argv.slice(3), { output = process.stdout } = {}) {
  const action = args[0] || "list";
  const json = args.includes("--json");
  const print = (value) => output.write(`${json ? JSON.stringify(value, null, 2) : value}\n`);
  if (action === "list") {
    const providers = listGenericProviders({ redacted: true });
    print(json ? { providers } : providers.map((provider) =>
      `${provider.enabled ? "SHOW" : "HIDE"} ${provider.id.padEnd(20)} ${provider.displayName} (${provider.adapter})`,
    ).join("\n"));
    return providers;
  }
  if (["add", "edit"].includes(action)) {
    const id = text(args[1]);
    if (!id) cliUsage();
    const patch = { id };
    for (const [flag, field] of [
      ["--name", "displayName"],
      ["--base-url", "baseUrl"],
      ["--adapter", "adapter"],
      ["--credential-ref", "credentialRef"],
      ["--description", "description"],
    ]) {
      const value = optionValue(args, flag);
      if (value !== undefined) patch[field] = value;
    }
    if (args.includes("--allow-private")) patch.allowPrivate = true;
    if (args.includes("--public-only")) patch.allowPrivate = false;
    const headerValues = optionValues(args, "--header").filter((value) => value !== undefined);
    if (headerValues.length) patch.headers = Object.fromEntries(headerValues.map(parseHeader));
    const provider = action === "add" ? addGenericProvider(patch) : updateGenericProvider(id, patch);
    print(json ? { provider } : `${action === "add" ? "Added" : "Updated"} generic provider ${provider.id}.`);
    return provider;
  }
  if (action === "show") {
    const provider = getGenericProvider(args[1], { redacted: true });
    print(json ? { provider } : JSON.stringify(provider, null, 2));
    return provider;
  }
  if (action === "remove") {
    const result = removeGenericProvider(args[1]);
    print(json ? result : `Removed generic provider ${result.removed}.`);
    return result;
  }
  if (action === "enable" || action === "disable") {
    const provider = setGenericProviderEnabled(args[1], action === "enable");
    print(json ? { provider } : `${provider.id} is now ${provider.enabled ? "enabled" : "disabled"}.`);
    return provider;
  }
  if (action === "test") {
    const result = await testGenericProvider(args[1]);
    print(json ? result : `${result.message} HTTP ${result.status}.`);
    return result;
  }
  cliUsage();
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runGenericProviderCli(process.argv.slice(2)).catch((error) => {
    console.error(errorMessage(error));
    process.exitCode = 1;
  });
}
