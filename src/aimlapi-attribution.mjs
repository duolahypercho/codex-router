// AI/ML API counts a request toward an integration only when it carries these
// headers, so every request the router sends to the gateway carries them --
// and nothing else does. The gate is the *destination host*, not the provider
// id: `AIMLAPI_API_BASE_URL` can move the aimlapi provider somewhere else, and
// any other provider's baseUrl override can move it here. Attribution follows
// the address, which is the only thing that is true either way.
//
// Matching is exact on the hostname. A suffix test would hand the partner id
// to `api.aimlapi.com.example.net`, which is precisely the kind of host an
// override exists to be careful about.

import { resolveProviderBaseUrl } from "./model-registry.mjs";

export const AIMLAPI_HOST = "api.aimlapi.com";
export const AIMLAPI_SOURCE_HEADER = "x-aimlapi-source";
export const AIMLAPI_PARTNER_HEADER = "x-aimlapi-partner-id";

export const AIMLAPI_SOURCE = "agent/codex-router";
// Minted by AI/ML API, not by us. Empty means "not registered yet": an unknown
// partner id is accepted and silently dropped upstream, so sending a
// placeholder would look identical to working and count nothing.
export const AIMLAPI_PARTNER_ID = "part_iHUWvDUArvZvhexX3PzGBwPS";

const REFERER = "https://github.com/duolahypercho/codex-router";
const TITLE = "Codex Router";

export function isAimlapiBaseUrl(baseUrl) {
  if (typeof baseUrl !== "string" || !baseUrl.trim()) return false;
  try {
    return new URL(baseUrl).hostname.toLowerCase() === AIMLAPI_HOST;
  } catch {
    return false;
  }
}

export function aimlapiAttributionHeaders() {
  const headers = {
    "HTTP-Referer": REFERER,
    "X-Title": TITLE,
    "X-AIMLAPI-Source": AIMLAPI_SOURCE,
  };
  if (AIMLAPI_PARTNER_ID) headers["X-AIMLAPI-Partner-ID"] = AIMLAPI_PARTNER_ID;
  return headers;
}

// Where a request to this endpoint will actually land, honouring the same
// baseUrl override the forwarder honours. A vertex endpoint builds its URL
// elsewhere and never reaches the gateway, so it resolves to nothing.
export function endpointDestination(endpoint, env = process.env) {
  if (!endpoint || typeof endpoint !== "object") return "";
  if (endpoint.protocol === "vertex") return "";
  try {
    return resolveProviderBaseUrl(endpoint, env).baseUrl || "";
  } catch {
    return "";
  }
}

// Returns whether anything was attached, so a caller (and a test) can tell
// "not our host" from "our host, nothing to send". Pass `endpoint` to have the
// destination resolved (including its env override), or `baseUrl` when the
// caller has already resolved it.
export function applyAimlapiAttributionHeaders(target, { endpoint, baseUrl, env } = {}) {
  const destination = baseUrl !== undefined ? baseUrl : endpointDestination(endpoint, env);
  if (!isAimlapiBaseUrl(destination)) return false;
  Object.assign(target, aimlapiAttributionHeaders());
  return true;
}
