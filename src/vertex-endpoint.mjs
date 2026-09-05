import { resolveProviderBaseUrl } from "./model-registry.mjs";
import { resolveVertexConfiguration } from "./vertex-state.mjs";

function normalized(value) {
  return String(value || "").replace(/\/+$/, "");
}

function validBaseUrl(value) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }
  return (
    ["http:", "https:"].includes(parsed.protocol) &&
    !parsed.username &&
    !parsed.password &&
    !parsed.search &&
    !parsed.hash
  );
}

function alreadyScoped(value) {
  try {
    const parsed = new URL(value);
    return /^\/v1(?:beta1)?\/projects\/[^/]+\/locations\/[^/]+$/.test(parsed.pathname);
  } catch {
    return false;
  }
}

const DEFAULT_VERTEX_HOST = "aiplatform.googleapis.com";

function vertexHostForLocation(location) {
  if (location === "global") return DEFAULT_VERTEX_HOST;
  if (location === "us" || location === "eu") {
    return `aiplatform.${location}.rep.googleapis.com`;
  }
  return `${location}-aiplatform.googleapis.com`;
}

// Google uses a different hostname for multi-region Vertex endpoints. Keep
// the configured location in the resource path, but select the matching host
// when the registry uses the default global base URL. Explicit base URL
// overrides and already-scoped URLs are handled by vertexForwardBaseUrl before
// this helper is called.
export function vertexEndpointBaseUrl(base, location) {
  const candidate = normalized(base);
  let parsed;
  try {
    parsed = new URL(candidate);
  } catch {
    return candidate;
  }
  if (
    parsed.hostname !== DEFAULT_VERTEX_HOST ||
    parsed.port ||
    parsed.pathname !== "/" ||
    parsed.search ||
    parsed.hash
  ) {
    return candidate;
  }
  return normalized(`${parsed.protocol}//${vertexHostForLocation(location)}`);
}

export function vertexForwardBaseUrl(provider) {
  const resolved = resolveProviderBaseUrl(provider);
  const base = normalized(resolved.baseUrl);
  if (!validBaseUrl(base)) {
    throw new Error("Vertex API base URL must be an absolute HTTP(S) URL.");
  }
  // An explicit test/operator override is already the complete forwarding
  // base. This also keeps custom registries able to point at a local fixture
  // without requiring protected project state.
  if (provider.baseUrlEnv && process.env[provider.baseUrlEnv]) return base;
  if (alreadyScoped(base)) return base;

  const configuration = resolveVertexConfiguration({ persistent: true });
  if (!configuration.configured) {
    throw new Error(
      "Vertex project and location are not configured. Run ./bin/control vertex set PROJECT_ID LOCATION.",
    );
  }
  const endpointBase = vertexEndpointBaseUrl(base, configuration.location);
  return (
    endpointBase +
    "/v1/projects/" +
    configuration.projectId +
    "/locations/" +
    configuration.location
  );
}
