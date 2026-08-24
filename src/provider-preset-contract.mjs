const ID_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,62})$/;
const ENVIRONMENT_PATTERN = /^[A-Z][A-Z0-9_]{1,127}$/;
const CREDENTIAL_PATTERN = /^cred_[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;
const DOT_OR_ESCAPED_PATH = /(?:^|\/)(?:\.{1,2})(?:\/|$)|%2e|%2f|%5c/i;

export const PROVIDER_PRESET_SCHEMA_VERSION = 1;
export const PROVIDER_PRESET_PROTOCOLS = Object.freeze([
  "openai-chat",
  "openai-responses",
  "openai-completions",
]);
export const PROVIDER_PRESET_AUTH_MODES = Object.freeze([
  "none",
  "credential-ref",
  "environment",
]);

const PRESET_FIELDS = new Set([
  "id",
  "displayName",
  "protocol",
  "baseUrl",
  "allowPrivate",
  "discoveryPath",
  "auth",
]);
const AUTH_FIELDS = new Set(["mode", "credentialRef", "environment"]);

function text(value) {
  return typeof value === "string" ? value.trim() : "";
}

function fail(message) {
  throw new TypeError(`Invalid provider preset: ${message}`);
}

function assertPlainObject(value, field) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail(`${field} must be an object.`);
  }
}

function rejectUnknownFields(value, allowed, field) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) fail(`${field}.${key} is not allowed.`);
  }
}

function isPrivateHostname(hostname) {
  const host = String(hostname || "").toLowerCase().replace(/^\[|\]$/g, "");
  if (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local")
  ) {
    return true;
  }
  if (host === "::1" || host === "0:0:0:0:0:0:0:1") return true;
  if (/^(?:fc|fd)[0-9a-f]{2}:/.test(host) || host.startsWith("fe80:")) return true;
  const parts = host.split(".");
  if (parts.length !== 4 || parts.some((part) => !/^\d+$/.test(part) || Number(part) > 255)) {
    if (host.startsWith("::ffff:")) return isPrivateHostname(host.slice(7));
    return false;
  }
  const [first, second] = parts.map(Number);
  return (
    first === 0 ||
    first === 10 ||
    first === 100 && second >= 64 && second <= 127 ||
    first === 127 ||
    first === 169 && second === 254 ||
    first === 172 && second >= 16 && second <= 31 ||
    first === 192 && second === 0 ||
    first === 192 && second === 168 ||
    first === 198 && second >= 18 && second <= 19 ||
    first === 203 && second === 0 ||
    first >= 240
  );
}

function validateBaseUrl(value, allowPrivate) {
  const raw = text(value);
  if (!raw || CONTROL_CHARACTERS.test(raw) || raw.includes("\\")) {
    fail("baseUrl must be a clean absolute HTTP(S) URL.");
  }
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    fail("baseUrl must be an absolute HTTP(S) URL.");
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    fail("baseUrl must use http or https.");
  }
  if (
    !parsed.hostname ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash ||
    DOT_OR_ESCAPED_PATH.test(parsed.pathname)
  ) {
    fail("baseUrl must not contain credentials, query strings, fragments, or traversal paths.");
  }
  const privateEndpoint = isPrivateHostname(parsed.hostname);
  if (privateEndpoint && !allowPrivate) {
    fail("private endpoints require allowPrivate=true.");
  }
  if (parsed.protocol === "http:" && !privateEndpoint) {
    fail("plain HTTP is allowed only for private endpoints.");
  }
  return parsed.href.replace(/\/+$/, "");
}

function validateDiscoveryPath(value) {
  const path = text(value);
  if (
    !path ||
    path.length > 160 ||
    !path.startsWith("/") ||
    path.startsWith("//") ||
    CONTROL_CHARACTERS.test(path) ||
    path.includes("\\") ||
    path.includes("?") ||
    path.includes("#") ||
    DOT_OR_ESCAPED_PATH.test(path)
  ) {
    fail("discoveryPath must be a short absolute path without traversal or URL components.");
  }
  return path;
}

function validateAuth(value, privateEndpoint) {
  assertPlainObject(value, "auth");
  rejectUnknownFields(value, AUTH_FIELDS, "auth");
  const mode = text(value.mode);
  if (!PROVIDER_PRESET_AUTH_MODES.includes(mode)) {
    fail(`auth.mode must be one of: ${PROVIDER_PRESET_AUTH_MODES.join(", ")}.`);
  }
  if (mode === "none") {
    if (!privateEndpoint || value.credentialRef !== undefined || value.environment !== undefined) {
      fail("auth.mode none is only allowed for private endpoints and accepts no credential reference.");
    }
    return Object.freeze({ mode });
  }
  if (mode === "credential-ref") {
    if (!CREDENTIAL_PATTERN.test(text(value.credentialRef)) || value.environment !== undefined) {
      fail("auth.credentialRef must be an opaque credential reference.");
    }
    return Object.freeze({ mode, credentialRef: text(value.credentialRef) });
  }
  if (!ENVIRONMENT_PATTERN.test(text(value.environment)) || value.credentialRef !== undefined) {
    fail("auth.environment must be an uppercase environment variable name.");
  }
  return Object.freeze({ mode, environment: text(value.environment) });
}

/**
 * Validate the inactive provider-preset contract.
 *
 * This function has no runtime caller yet. It intentionally returns only
 * endpoint and authentication metadata; capabilities, retries, enablement,
 * headers, and model discovery are not accepted until a runtime boundary
 * proves and enforces them.
 */
export function validateProviderPresetContract(input, { knownProviderIds = [] } = {}) {
  assertPlainObject(input, "preset");
  rejectUnknownFields(input, PRESET_FIELDS, "preset");
  const id = text(input.id);
  if (!ID_PATTERN.test(id)) fail("id must match [a-z0-9][a-z0-9-]*.");
  if (new Set(knownProviderIds).has(id)) fail(`id ${id} is already used by the registry.`);
  const displayName = text(input.displayName);
  if (!displayName || displayName.length > 120) {
    fail("displayName must be a non-empty string of at most 120 characters.");
  }
  const protocol = text(input.protocol);
  if (!PROVIDER_PRESET_PROTOCOLS.includes(protocol)) {
    fail(`protocol must be one of: ${PROVIDER_PRESET_PROTOCOLS.join(", ")}.`);
  }
  const allowPrivate = input.allowPrivate === true;
  if (input.allowPrivate !== undefined && typeof input.allowPrivate !== "boolean") {
    fail("allowPrivate must be a boolean.");
  }
  const baseUrl = validateBaseUrl(input.baseUrl, allowPrivate);
  const privateEndpoint = isPrivateHostname(new URL(baseUrl).hostname);
  const discoveryPath = validateDiscoveryPath(input.discoveryPath);
  const auth = validateAuth(input.auth, privateEndpoint);
  return Object.freeze({
    schemaVersion: PROVIDER_PRESET_SCHEMA_VERSION,
    id,
    displayName,
    protocol,
    baseUrl,
    allowPrivate,
    discoveryPath,
    auth,
  });
}

