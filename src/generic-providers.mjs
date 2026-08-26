import { promises as dns } from "node:dns";
import { existsSync, readFileSync } from "node:fs";
import { isIP } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Agent, fetch as undiciFetch } from "undici";

import { normalizeGenericProviderId } from "./generic-provider-identity.mjs";
import { GENERIC_PROVIDERS_PATH } from "./paths.mjs";
import { withAtomicStateLock } from "./atomic-state-lock.mjs";
import { readProviderCredentialStore } from "./provider-credential-store.mjs";
import { resolveGenericProviderCredentialReference } from "./provider-credentials.mjs";

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

const HEADER_NAME_PATTERN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const MAX_HEADERS = 64;
const MAX_HEADER_VALUE_LENGTH = 4_096;
const MAX_DESCRIPTION_LENGTH = 240;
const MAX_RESPONSE_BYTES = 64 * 1024;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const SECRET_HEADER_PATTERN = /(?:^|[-_])(auth|authorization|api[-_]?key|key|token|secret|credential|cookie|password|session|signature)(?:$|[-_])/i;

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
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && [0, 2, 168].includes(b)) ||
    (a === 198 && b >= 18 && b <= 19) ||
    (a === 198 && b === 51) ||
    (a === 203 && b === 0) ||
    a >= 224
  );
}

function isPrivateAddress(value) {
  const address = String(value || "").toLowerCase();
  const family = isIP(address);
  if (family === 4) return isPrivateIpv4(address);
  if (family !== 6) return false;
  const withoutZone = address.split("%")[0];
  const parts = withoutZone.split("::");
  if (parts.length > 2) return false;
  const expand = (segment) => {
    if (!segment) return [];
    const values = segment.split(":");
    const result = [];
    for (const valuePart of values) {
      if (valuePart.includes(".")) {
        if (!isIpv4(valuePart)) return undefined;
        const [first, second, third, fourth] = valuePart.split(".").map(Number);
        result.push(((first << 8) | second).toString(16), ((third << 8) | fourth).toString(16));
      } else if (/^[0-9a-f]{1,4}$/.test(valuePart)) {
        result.push(valuePart);
      } else {
        return undefined;
      }
    }
    return result;
  };
  const left = expand(parts[0]);
  const right = expand(parts[1] || "");
  if (!left || !right) return false;
  const hextets = parts.length === 2
    ? [...left, ...Array(8 - left.length - right.length).fill("0"), ...right]
    : left;
  if (hextets.length !== 8) return false;
  const first = Number.parseInt(hextets[0], 16);
  const high = hextets.map((part) => BigInt(`0x${part}`)).reduce((valuePart, part) => (valuePart << 16n) | part, 0n);
  if (high === 0n || high === 1n) return true;
  if ((high >> 32n) === 0xffffn) {
    const mapped = Number(high & 0xffffffffn);
    const mappedAddress = `${mapped >>> 24}.${(mapped >>> 16) & 255}.${(mapped >>> 8) & 255}.${mapped & 255}`;
    return isPrivateIpv4(mappedAddress);
  }
  return (first & 0xfe00) === 0xfc00 || (first & 0xffc0) === 0xfe80 || (first & 0xff00) === 0xff00;
}

function isPrivateHostname(hostname) {
  const host = String(hostname || "").toLowerCase().replace(/^\[|\]$/g, "");
  if (!host) return false;
  if (isPrivateAddress(host)) return true;
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) {
    return true;
  }
  // IPv6 loopback, link-local and unique-local ranges. This intentionally
  // does not try to parse every IPv6 spelling; DNS lookup in testGenericProvider
  // catches resolved private addresses before a request is sent.
  return false;
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
    if (FORBIDDEN_HEADER_NAMES.has(lower) || SECRET_HEADER_PATTERN.test(lower)) {
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
  const id = normalizeGenericProviderId(input.id);
  if (existingId !== undefined && id !== existingId) {
    throw new Error("Provider id cannot be changed; remove and add a new provider instead.");
  }
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
  return withAtomicStateLock(GENERIC_PROVIDERS_PATH, () => {
    const current = readGenericProviders();
    const next = mutator(current.map((provider) => ({ ...provider, headers: { ...provider.headers } })));
    if (!Array.isArray(next)) throw new Error("Generic provider mutation returned an invalid list.");
    const validated = parseDocument({ version: GENERIC_PROVIDER_SCHEMA_VERSION, providers: next }).providers;
    saveProviders(validated);
    return validated;
  });
}

export function addGenericProvider(input) {
  const provider = validateProvider(input);
  const providers = mutateProviders((current) => {
    if (current.some((entry) => entry.id === provider.id)) {
      throw new Error(`Generic provider ${provider.id} already exists.`);
    }
    return [...current, provider];
  });
  return redactGenericProvider(providers.find((entry) => entry.id === provider.id));
}

export function updateGenericProvider(id, patch) {
  const providerId = text(id);
  let updated;
  mutateProviders((current) => {
    const existing = current.find((entry) => entry.id === providerId);
    if (!existing) throw new Error(`Unknown generic provider: ${id}`);
    updated = validateProvider({ ...existing, ...patch, id: existing.id }, { existingId: existing.id });
    return current.map((entry) => entry.id === existing.id ? updated : entry);
  });
  return redactGenericProvider(updated);
}

export function removeGenericProvider(id) {
  const providerId = text(id);
  const next = mutateProviders((providers) => {
    if (!providers.some((entry) => entry.id === providerId)) {
      throw new Error(`Unknown generic provider: ${id}`);
    }
    return providers.filter((entry) => entry.id !== providerId);
  });
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
    // The descriptor is safe to hand to catalogs and UI surfaces. Raw static
    // header values stay inside the request boundary and never become a model
    // descriptor or loggable catalog field.
    headers: Object.fromEntries(Object.keys(provider.headers).map((name) => [name, "[redacted]"])),
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

function destinationUrl(provider, requestPath) {
  const suffix = String(requestPath || "");
  if (!suffix.startsWith("/") || suffix.startsWith("//") || /^[a-z][a-z\d+.-]*:/i.test(suffix)) {
    throw new Error("Generic provider request paths must be relative to the configured baseUrl.");
  }
  const endpoint = new URL(provider.baseUrl);
  const target = new URL(`${provider.baseUrl}${suffix}`);
  if (target.origin !== endpoint.origin || target.username || target.password) {
    throw new Error("Generic provider request cannot change the configured origin.");
  }
  const basePath = endpoint.pathname.endsWith("/") ? endpoint.pathname : `${endpoint.pathname}/`;
  if (!target.pathname.startsWith(basePath)) {
    throw new Error("Generic provider request cannot escape the configured baseUrl path.");
  }
  return target;
}

async function validateResolvedDestination(endpoint, provider, lookup = lookupHost) {
  if (isPrivateHostname(endpoint.hostname) && !provider.allowPrivate) {
    throw new Error("Provider host is private or loopback; set allowPrivate=true explicitly.");
  }
  const resolved = await lookup(endpoint.hostname);
  if (!resolved.length) throw new Error(`Provider host ${endpoint.hostname} has no addresses.`);
  if (!provider.allowPrivate && resolved.some(isPrivateAddress)) {
    throw new Error("Provider host resolved to a private or link-local address; set allowPrivate=true explicitly.");
  }
  return resolved;
}

function safeHeaderEntries(headers) {
  const values = headers instanceof Headers ? [...headers.entries()] : Object.entries(headers || {});
  const result = {};
  for (const [nameValue, valueValue] of values) {
    const name = text(nameValue);
    const lower = name.toLowerCase();
    const value = String(valueValue ?? "");
    if (FORBIDDEN_HEADER_NAMES.has(lower) || SECRET_HEADER_PATTERN.test(lower)) {
      throw new Error(`Header ${name} is reserved for credential or transport handling.`);
    }
    if (!HEADER_NAME_PATTERN.test(name) || !value || value.length > MAX_HEADER_VALUE_LENGTH || /[\r\n]/.test(value)) {
      throw new Error(`Header ${name} has an invalid value.`);
    }
    result[name] = value;
  }
  return result;
}

function credentialSecret(provider) {
  if (!provider.credentialRef) return undefined;
  const entry = readProviderCredentialStore().credentials.find((candidate) => candidate.id === provider.credentialRef);
  if (!entry || entry.state !== "active") return undefined;
  if (entry.providerType !== "generic") return undefined;
  if (entry.providerId !== provider.id) return undefined;
  if (entry.kind !== "api_key") return undefined;
  return resolveGenericProviderCredentialReference(provider.id, entry.secretRef)?.value;
}

function requestSignal(signal, timeoutMs) {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

function createDestinationDispatcher(endpoint, provider, timeoutMs) {
  const lookup = (hostname, options, callback) => {
    lookupHost(hostname)
      .then((addresses) => {
        if (!provider.allowPrivate && addresses.some(isPrivateAddress)) {
          throw new Error("Provider host resolved to a private or link-local address.");
        }
        if (options?.all) {
          callback(null, addresses.map((address) => ({ address, family: isIP(address) })));
        } else {
          const address = addresses[0];
          callback(null, address, isIP(address));
        }
      })
      .catch((error) => callback(error));
  };
  return new Agent({
    allowH2: false,
    pipelining: 1,
    headersTimeout: timeoutMs,
    bodyTimeout: timeoutMs,
    connect: { lookup },
  });
}

async function boundedResponseBody(response, maxBytes = MAX_RESPONSE_BYTES) {
  const contentLength = Number(response.headers?.get?.("content-length"));
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    throw new Error(`Generic provider response exceeds the ${maxBytes}-byte limit.`);
  }
  if (!response.body) {
    if (typeof response.text === "function") {
      const value = await response.text();
      if (Buffer.byteLength(value, "utf8") > maxBytes) throw new Error("Generic provider response exceeds the read limit.");
      return value;
    }
    return "";
  }
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new Error(`Generic provider response exceeds the ${maxBytes}-byte limit.`);
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock?.();
  }
  return Buffer.concat(chunks).toString("utf8");
}

export async function requestGenericProvider(
  id,
  requestPath,
  { fetchImpl = undiciFetch, lookup = lookupHost, timeoutMs = 10_000, ...init } = {},
) {
  const provider = getGenericProvider(id);
  if (!provider.enabled) throw new Error(`Generic provider ${provider.id} is disabled.`);
  const endpoint = destinationUrl(provider, requestPath);
  await validateResolvedDestination(endpoint, provider, lookup);
  const requestHeaders = safeHeaderEntries(init.headers);
  const headers = { ...provider.headers, ...requestHeaders };
  const secret = credentialSecret(provider);
  if (provider.credentialRef && !secret) {
    throw new Error(`Credential ${provider.credentialRef} is unavailable for generic provider ${provider.id}.`);
  }
  if (secret) headers.Authorization = `Bearer ${secret}`;
  const useDispatcher = fetchImpl === undiciFetch;
  const dispatcher = useDispatcher ? createDestinationDispatcher(endpoint, provider, timeoutMs) : undefined;
  try {
    const response = await fetchImpl(endpoint.toString(), {
      ...init,
      headers,
      redirect: "manual",
      signal: requestSignal(init.signal, timeoutMs),
      ...(dispatcher ? { dispatcher } : {}),
    });
    if (REDIRECT_STATUSES.has(response.status)) {
      await Promise.resolve(response.body?.cancel?.()).catch(() => undefined);
      throw new Error("Generic provider redirects are disabled.");
    }
    return { response, endpoint: endpoint.toString(), dispatcher };
  } catch (error) {
    await dispatcher?.close().catch(() => undefined);
    throw error;
  }
}

export async function testGenericProvider(id, { fetchImpl = undiciFetch, lookup = lookupHost, timeoutMs = 10_000 } = {}) {
  const { response, endpoint, dispatcher } = await requestGenericProvider(id, "/models", {
    fetchImpl,
    lookup,
    timeoutMs,
    method: "GET",
    headers: { Accept: "application/json" },
  });
  try {
    await boundedResponseBody(response);
    return {
      ok: response.ok,
      status: response.status,
      endpoint,
      ...(response.ok ? { message: "Provider endpoint is reachable." } : { message: "Provider endpoint returned an error." }),
    };
  } finally {
    await dispatcher?.close().catch(() => undefined);
  }
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
