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
  return (
    base +
    "/v1/projects/" +
    configuration.projectId +
    "/locations/" +
    configuration.location
  );
}
