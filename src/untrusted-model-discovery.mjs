import { promises as dns } from "node:dns";
import net from "node:net";

// A provider's model endpoint is an untrusted boundary. The response is used
// for picker metadata only; it must never be allowed to turn discovery into a
// general-purpose HTTP client or an unbounded JSON parser.
export const MODEL_DISCOVERY_MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
export const MODEL_DISCOVERY_MAX_MODELS = 4_000;
export const MODEL_DISCOVERY_MAX_RECORD_BYTES = 256 * 1024;
export const MODEL_DISCOVERY_MAX_REDIRECTS = 3;

const PRIVATE_IPV4_RANGES = [
  [10, 0, 0, 0, 8],
  [100, 64, 0, 0, 10],
  [127, 0, 0, 0, 8],
  [169, 254, 0, 0, 16],
  [172, 16, 0, 0, 12],
  [192, 0, 0, 0, 24],
  [192, 0, 2, 0, 24],
  [192, 168, 0, 0, 16],
  [198, 18, 0, 0, 15],
  [198, 51, 100, 0, 24],
  [203, 0, 113, 0, 24],
  [224, 0, 0, 0, 4],
  [240, 0, 0, 0, 4],
];

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

function ipv4ToInteger(value) {
  const parts = value.split(".").map(Number);
  return parts.reduce((result, part) => (result * 256) + part, 0) >>> 0;
}

function ipv4InRange(address, base, prefix) {
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return (ipv4ToInteger(address) & mask) === (ipv4ToInteger(base) & mask);
}

function normalizedIpv6(value) {
  const source = value.toLowerCase().replace(/^\[|\]$/g, "");
  if (!source.includes("::")) return source;
  const [left, right] = source.split("::");
  const leftParts = left ? left.split(":") : [];
  const rightParts = right ? right.split(":") : [];
  return [
    ...leftParts,
    ...Array(Math.max(0, 8 - leftParts.length - rightParts.length)).fill("0"),
    ...rightParts,
  ].join(":");
}

function ipv6IsPrivate(value) {
  const normalized = normalizedIpv6(value);
  if (normalized === "0:0:0:0:0:0:0:1" || normalized === "0:0:0:0:0:0:0:0") return true;
  const first = Number.parseInt(normalized.split(":")[0] || "0", 16);
  const second = Number.parseInt(normalized.split(":")[1] || "0", 16);
  // IPv4-mapped and IPv4-compatible forms are private when their v4 tail is.
  const tail = normalized.split(":").slice(-2).map((part) => Number.parseInt(part || "0", 16));
  if ((first === 0 || first === 0xffff) && tail.length === 2) {
    const mapped = `${tail[0] >>> 8}.${tail[0] & 255}.${tail[1] >>> 8}.${tail[1] & 255}`;
    if (PRIVATE_IPV4_RANGES.some(([a, b, c, d, prefix]) => ipv4InRange(mapped, `${a}.${b}.${c}.${d}`, prefix))) {
      return true;
    }
  }
  return (first & 0xfe00) === 0xfc00 || (first & 0xffc0) === 0xfe80 || (first & 0xff00) === 0xff00 ||
    (first === 0 && second === 0);
}

export function isPrivateAddress(value) {
  const address = String(value || "").replace(/^\[|\]$/g, "").toLowerCase();
  const family = net.isIP(address);
  if (family === 4) {
    return PRIVATE_IPV4_RANGES.some(([a, b, c, d, prefix]) => ipv4InRange(address, `${a}.${b}.${c}.${d}`, prefix));
  }
  if (family === 6) return ipv6IsPrivate(address);
  return false;
}

export function isPrivateHostname(value) {
  const hostname = String(value || "").toLowerCase().replace(/^\[|\]$/g, "");
  return hostname === "localhost" || hostname.endsWith(".localhost") || hostname.endsWith(".local") || isPrivateAddress(hostname);
}

async function resolveAddresses(hostname, resolveHost = lookupHost) {
  const addresses = await resolveHost(hostname);
  if (!Array.isArray(addresses) || addresses.length === 0 || addresses.some((address) => typeof address !== "string" || !net.isIP(address))) {
    throw new Error("Provider host resolution returned no valid addresses.");
  }
  return addresses;
}

async function lookupHost(hostname) {
  try {
    return (await dns.lookup(hostname, { all: true, verbatim: true })).map((entry) => entry.address);
  } catch {
    throw new Error("Provider host could not be resolved.");
  }
}

function endpointOrigin(url) {
  return `${url.protocol}//${url.hostname.toLowerCase()}${url.port ? `:${url.port}` : ""}`;
}

export async function validateDiscoveryUrl(value, {
  allowPrivate = false,
  expectedOrigin,
  resolveHost = lookupHost,
} = {}) {
  let parsed;
  try {
    parsed = new URL(String(value));
  } catch {
    throw new Error("Model discovery endpoint must be an absolute HTTP(S) URL.");
  }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.hash || parsed.search) {
    throw new Error("Model discovery endpoint must be a credential-free HTTP(S) URL without query or fragment.");
  }
  const origin = endpointOrigin(parsed);
  if (expectedOrigin && origin !== expectedOrigin) {
    throw new Error("Model discovery refused a cross-origin redirect.");
  }
  const addresses = await resolveAddresses(parsed.hostname, resolveHost);
  if (!allowPrivate && (isPrivateHostname(parsed.hostname) || addresses.some(isPrivateAddress))) {
    throw new Error("Model discovery refused a private or loopback endpoint.");
  }
  return { url: parsed, origin };
}

function responseHeader(response, name) {
  if (!response?.headers) return undefined;
  if (typeof response.headers.get === "function") return response.headers.get(name);
  const key = Object.keys(response.headers).find((entry) => entry.toLowerCase() === name.toLowerCase());
  return key ? response.headers[key] : undefined;
}

function responseBodyReader(response) {
  if (response?.body && typeof response.body.getReader === "function") return response.body.getReader();
  return undefined;
}

async function boundedBody(response, maxBytes) {
  const declared = Number(responseHeader(response, "content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) throw new Error("Provider model catalog exceeds the response size limit.");
  const reader = responseBodyReader(response);
  if (reader) {
    const chunks = [];
    let total = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value?.byteLength || 0;
      if (total > maxBytes) {
        try { await reader.cancel(); } catch { /* best effort */ }
        throw new Error("Provider model catalog exceeds the response size limit.");
      }
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks, total).toString("utf8");
  }
  if (typeof response.arrayBuffer === "function") {
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.byteLength > maxBytes) throw new Error("Provider model catalog exceeds the response size limit.");
    return buffer.toString("utf8");
  }
  if (typeof response.text === "function") {
    const text = await response.text();
    if (Buffer.byteLength(text, "utf8") > maxBytes) throw new Error("Provider model catalog exceeds the response size limit.");
    return text;
  }
  throw new Error("Provider model catalog response has no readable body.");
}

function validateRecordShape(record, index, maxRecordBytes) {
  if (!record || typeof record !== "object" || Array.isArray(record)) {
    throw new Error(`Provider model catalog record ${index} is invalid.`);
  }
  let serialized;
  try { serialized = JSON.stringify(record); } catch { throw new Error(`Provider model catalog record ${index} is invalid.`); }
  if (Buffer.byteLength(serialized, "utf8") > maxRecordBytes) {
    throw new Error(`Provider model catalog record ${index} exceeds the record size limit.`);
  }
  const id = record.id ?? record.model ?? record.upstreamId;
  if (typeof id !== "string" || !id.trim() || id.length > 512 || /[\u0000-\u001f\u007f]/.test(id)) {
    throw new Error(`Provider model catalog record ${index} has an invalid model id.`);
  }
}

export function validateModelCatalogPayload(payload, {
  maxModels = MODEL_DISCOVERY_MAX_MODELS,
  maxRecordBytes = MODEL_DISCOVERY_MAX_RECORD_BYTES,
} = {}) {
  const data = Array.isArray(payload) ? payload : payload?.data;
  if (!Array.isArray(data) || data.length > maxModels) throw new Error("Provider returned an invalid or oversized model catalog.");
  data.forEach((record, index) => validateRecordShape(record, index, maxRecordBytes));
  return data;
}

export async function fetchUntrustedModelCatalog(endpoint, {
  headers = {},
  fetchImpl = globalThis.fetch,
  timeoutMs = 30_000,
  allowPrivate = false,
  maxBytes = MODEL_DISCOVERY_MAX_RESPONSE_BYTES,
  maxModels = MODEL_DISCOVERY_MAX_MODELS,
  maxRecordBytes = MODEL_DISCOVERY_MAX_RECORD_BYTES,
  maxRedirects = MODEL_DISCOVERY_MAX_REDIRECTS,
  resolveHost = lookupHost,
  acceptNonOk = false,
  validatePayload = true,
} = {}) {
  if (typeof fetchImpl !== "function") throw new Error("Model discovery requires a fetch implementation.");
  let current = await validateDiscoveryUrl(endpoint, { allowPrivate, resolveHost });
  const originalOrigin = current.origin;
  for (let redirect = 0; ; redirect += 1) {
    const response = await fetchImpl(current.url.toString(), {
      method: "GET",
      headers: { Accept: "application/json", ...headers },
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (REDIRECT_STATUSES.has(response?.status)) {
      if (redirect >= maxRedirects) throw new Error("Provider model discovery exceeded the redirect limit.");
      const location = responseHeader(response, "location");
      if (!location) throw new Error("Provider model discovery returned a redirect without a location.");
      current = await validateDiscoveryUrl(new URL(location, current.url), {
        allowPrivate,
        expectedOrigin: originalOrigin,
        resolveHost,
      });
      continue;
    }
    if (response?.ok && !validatePayload) return { ok: true, status: response.status };
    const body = await boundedBody(response, maxBytes);
    if (!response?.ok) {
      if (acceptNonOk) return { ok: false, status: response.status };
      throw new Error(`Provider model discovery returned HTTP ${response.status}.`);
    }
    let payload;
    const contentType = responseHeader(response, "content-type");
    if (contentType && !/\bjson\b/i.test(contentType)) throw new Error("Provider model catalog did not return JSON.");
    try { payload = JSON.parse(body); } catch { throw new Error("Provider returned invalid JSON for its model catalog."); }
    validateModelCatalogPayload(payload, { maxModels, maxRecordBytes });
    return payload;
  }
}
