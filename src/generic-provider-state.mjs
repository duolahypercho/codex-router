import { existsSync, readFileSync } from "node:fs";
import { isIP } from "node:net";

import {
  normalizeGenericProviderId,
  normalizeGenericProviderIdSyntax,
} from "./generic-provider-identity.mjs";
import { GENERIC_PROVIDERS_PATH } from "./paths.mjs";

export { GENERIC_PROVIDERS_PATH } from "./paths.mjs";

// This module is intentionally dependency-light. The checked-in model
// registry reads it while constructing the runtime provider map, so importing
// model-registry (directly or through credential/request helpers) from here
// would make provider loading depend on an initialization cycle.
export const GENERIC_PROVIDER_SCHEMA_VERSION = 1;
export const GENERIC_PROVIDER_ADAPTERS = Object.freeze([
  "openai-chat",
  "openai-responses",
  "openai-completions",
]);
// "http" is the Responses-over-HTTP(S) hop the forwarder has always made.
// "websocket" sends the provider's turns over the persistent
// responses_websockets protocol instead. Full requests retain the canonical
// pipeline; the Responses wire requires the adapter rule below.
export const GENERIC_PROVIDER_TRANSPORTS = Object.freeze(["http", "websocket"]);

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

export function isPrivateGenericProviderAddress(value) {
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

export function isPrivateGenericProviderHostname(hostname) {
  const host = String(hostname || "").toLowerCase().replace(/^\[|\]$/g, "");
  if (!host) return false;
  if (isPrivateGenericProviderAddress(host)) return true;
  return host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local");
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
  const privateHost = isPrivateGenericProviderHostname(parsed.hostname);
  if (parsed.protocol === "http:" && (!allowPrivate || !privateHost)) {
    throw new Error("Plain HTTP endpoints must be private and require allowPrivate=true.");
  }
  if (privateHost && !allowPrivate) {
    throw new Error("Private or loopback endpoints require allowPrivate=true.");
  }
  return { baseUrl };
}

export function validateGenericProviderHeaders(raw) {
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

export function validateGenericProvider(input, { existingId, reservedProviderIds } = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("A generic provider must be an object.");
  }
  const id = reservedProviderIds
    ? normalizeGenericProviderId(input.id, { reservedProviderIds })
    : normalizeGenericProviderIdSyntax(input.id);
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
  const transport = input.transport === undefined ? "http" : text(input.transport);
  if (!GENERIC_PROVIDER_TRANSPORTS.includes(transport)) {
    throw new Error(`transport must be one of: ${GENERIC_PROVIDER_TRANSPORTS.join(", ")}.`);
  }
  if (transport === "websocket" && adapter !== "openai-responses") {
    throw new Error(
      "transport websocket requires adapter openai-responses; the Responses WebSocket protocol carries Responses requests only.",
    );
  }
  const allowPrivate = input.allowPrivate === undefined ? false : input.allowPrivate;
  if (typeof allowPrivate !== "boolean") throw new Error("allowPrivate must be a boolean.");
  const { baseUrl } = validateEndpoint(input.baseUrl, allowPrivate);
  const headers = validateGenericProviderHeaders(input.headers);
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
    ...(transport === "websocket" ? { transport } : {}),
    headers,
    ...(credentialRef ? { credentialRef } : {}),
    allowPrivate,
    enabled,
  };
}

export function parseGenericProviderDocument(payload, { reservedProviderIds } = {}) {
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
    const provider = validateGenericProvider(entry, { reservedProviderIds });
    if (seen.has(provider.id)) throw new Error(`Duplicate generic provider id ${provider.id}.`);
    seen.add(provider.id);
    providers.push(provider);
  }
  return { version: GENERIC_PROVIDER_SCHEMA_VERSION, providers };
}

export function readGenericProviders({ reservedProviderIds } = {}) {
  if (!existsSync(GENERIC_PROVIDERS_PATH)) return [];
  let serialized;
  try {
    serialized = readFileSync(GENERIC_PROVIDERS_PATH, "utf8");
  } catch (error) {
    throw new Error(`Could not read generic provider state: ${errorMessage(error)}`);
  }
  let payload;
  try {
    payload = JSON.parse(serialized);
  } catch {
    // JSON parser messages can quote input fragments. This state may contain
    // raw static header values, so diagnostics identify the document without
    // reflecting any of its bytes.
    throw new Error(`Invalid generic provider state ${GENERIC_PROVIDERS_PATH}: document is not valid JSON.`);
  }
  return parseGenericProviderDocument(payload, { reservedProviderIds }).providers;
}

export function redactGenericProvider(provider, { reservedProviderIds } = {}) {
  const value = validateGenericProvider(provider, {
    existingId: provider.id,
    reservedProviderIds,
  });
  return {
    ...value,
    headers: Object.fromEntries(Object.keys(value.headers).map((name) => [name, "[redacted]"])),
  };
}

export function genericProviderRuntimeDescriptor(provider) {
  const value = validateGenericProvider(provider, { existingId: provider.id });
  return Object.freeze({
    id: value.id,
    displayName: value.displayName,
    kind: "openai-compatible",
    ownedBy: value.id,
    baseUrl: value.baseUrl,
    adapter: value.adapter,
    ...(value.transport === "websocket" ? { transport: value.transport } : {}),
    protocol: value.adapter === "openai-responses" ? "openai-responses" : "openai",
    // Raw static header values stay inside the request boundary and never
    // become model registry or diagnostic data.
    headers: Object.freeze(
      Object.fromEntries(Object.keys(value.headers).map((name) => [name, "[redacted]"])),
    ),
    allowPrivate: value.allowPrivate,
    enabled: value.enabled,
    ...(value.credentialRef ? { credentialRef: value.credentialRef } : {}),
    generic: true,
  });
}
