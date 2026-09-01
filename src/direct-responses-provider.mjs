import { HOP_BY_HOP_HEADERS } from "./http-utils.mjs";
import { resolveProviderBaseUrl } from "./model-registry.mjs";

const DIRECT_REQUEST_HEADERS = new Set([
  "accept",
  "openai-beta",
  "originator",
  "session_id",
  "session-id",
  "thread-id",
  "traceparent",
  "tracestate",
  "user-agent",
  "x-client-request-id",
  "x-openai-internal-codex-responses-lite",
  "x-openai-subagent",
  "x-responsesapi-include-timing-metrics",
]);

export function isDirectResponsesProvider(provider) {
  return provider?.directResponses === true;
}

// The bridge needs Codex's native x-codex turn metadata and tool envelope,
// but it never needs the caller's ChatGPT bearer token. Replace every upstream
// credential with a local placeholder that satisfies the bridge's loopback
// Responses contract without disclosing an account credential to another
// same-user process.
export function directResponsesHeaders(source = {}) {
  const headers = {};
  for (const [name, raw] of Object.entries(source)) {
    const lower = name.toLowerCase();
    if (HOP_BY_HOP_HEADERS.has(lower)) continue;
    if (!DIRECT_REQUEST_HEADERS.has(lower) && !lower.startsWith("x-codex-")) continue;
    if (raw !== undefined) headers[name] = Array.isArray(raw) ? raw.join(", ") : raw;
  }
  headers.Authorization = "Bearer local";
  headers["Content-Type"] = "application/json";
  headers["Accept-Encoding"] = "identity";
  return headers;
}

export function directResponsesTarget(provider, pathname, search = "") {
  if (!isDirectResponsesProvider(provider)) {
    throw new Error("Provider does not declare the direct Responses contract.");
  }
  const suffix = /\/responses\/compact$/.test(String(pathname || ""))
    ? "/responses/compact"
    : /\/responses$/.test(String(pathname || ""))
      ? "/responses"
      : undefined;
  if (!suffix) throw new Error("Direct Responses providers accept only Responses routes.");
  const { baseUrl } = resolveProviderBaseUrl(provider);
  return `${baseUrl}${suffix}${search || ""}`;
}

export function directResponsesBody(payload, route) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("Direct Responses request body must be an object.");
  }
  const upstreamModel = String(route?.upstreamModel || "").trim();
  if (!upstreamModel) throw new Error("Direct Responses route requires an upstream model.");
  return Buffer.from(JSON.stringify({ ...payload, model: upstreamModel }), "utf8");
}
