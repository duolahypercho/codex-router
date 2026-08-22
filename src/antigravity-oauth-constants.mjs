// Shared OAuth and wire constants for Google's Antigravity coding client.

export const ANTIGRAVITY_CLIENT_ID =
  process.env.ANTIGRAVITY_CLIENT_ID ||
  "1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com";

export const ANTIGRAVITY_CLIENT_SECRET =
  process.env.ANTIGRAVITY_CLIENT_SECRET ||
  "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";

export const ANTIGRAVITY_SCOPES = Object.freeze([
  "https://www.googleapis.com/auth/cloud-platform",
  "https://www.googleapis.com/auth/userinfo.email",
  "https://www.googleapis.com/auth/userinfo.profile",
  "https://www.googleapis.com/auth/cclog",
  "https://www.googleapis.com/auth/experimentsandconfigs",
]);

const DEFAULT_REDIRECT_URI = "http://localhost:51121/oauth-callback";

export function validateAntigravityRedirectUri(
  value = process.env.ANTIGRAVITY_REDIRECT_URI || DEFAULT_REDIRECT_URI,
) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error("ANTIGRAVITY_REDIRECT_URI must be a valid loopback URL.");
  }
  const loopbackHosts = new Set(["localhost", "127.0.0.1", "[::1]"]);
  if (
    url.protocol !== "http:" ||
    !loopbackHosts.has(url.hostname) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !url.port ||
    url.port === "0" ||
    !url.pathname.startsWith("/")
  ) {
    throw new Error(
      "ANTIGRAVITY_REDIRECT_URI must be an HTTP localhost/loopback URL with an explicit port, path, and no credentials, query, or fragment.",
    );
  }
  return url;
}

export const ANTIGRAVITY_REDIRECT_URI = validateAntigravityRedirectUri().toString();

export function antigravityCallbackTarget(value = ANTIGRAVITY_REDIRECT_URI) {
  const url = validateAntigravityRedirectUri(value);
  return {
    host: url.hostname === "localhost"
      ? "127.0.0.1"
      : url.hostname === "[::1]" ? "::1" : url.hostname,
    port: Number(url.port),
    path: url.pathname,
    redirectUri: url.toString(),
  };
}

export const ANTIGRAVITY_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
export const ANTIGRAVITY_TOKEN_URL = "https://oauth2.googleapis.com/token";

export const ANTIGRAVITY_ENDPOINT = (
  process.env.ANTIGRAVITY_ENDPOINT ||
  "https://daily-cloudcode-pa.googleapis.com"
).replace(/\/+$/, "");

export const ANTIGRAVITY_PROD_ENDPOINT = (
  process.env.ANTIGRAVITY_PROD_ENDPOINT || "https://cloudcode-pa.googleapis.com"
).replace(/\/+$/, "");

// Used only as a request-time fallback. It is never persisted as a resolved
// managed project because Google may provision the account later.
export const ANTIGRAVITY_DEFAULT_PROJECT_ID = "rising-fact-p41fc";

export const ANTIGRAVITY_VERSION = process.env.ANTIGRAVITY_IDE_VERSION || "1.1.13";
export const ANTIGRAVITY_BUILD = process.env.ANTIGRAVITY_BUILD || "964361259";
export const ANTIGRAVITY_SURFACE = process.env.ANTIGRAVITY_SURFACE || "cli";

function normalizePlatform(platform) {
  if (platform === "win32") return "windows";
  return platform || "unknown";
}

function normalizeArch(arch) {
  if (arch === "x64") return "amd64";
  if (arch === "ia32") return "386";
  return arch || "unknown";
}

export function antigravityUserAgent(
  platform = process.platform,
  arch = process.arch,
) {
  if (process.env.ANTIGRAVITY_USER_AGENT) return process.env.ANTIGRAVITY_USER_AGENT;
  return `antigravity/${ANTIGRAVITY_SURFACE}/${ANTIGRAVITY_VERSION} (aidev_client; os_type=${normalizePlatform(platform)}; arch=${normalizeArch(arch)}; cl=${ANTIGRAVITY_BUILD}; auth_method=consumer)`;
}

export function antigravityBootstrapHeaders(accessToken) {
  return {
    "User-Agent": antigravityUserAgent(),
    Authorization: `Bearer ${accessToken}`,
    "Content-Type": "application/json",
    "Accept-Encoding": "gzip",
  };
}

export function antigravityLoadCodeAssistMetadata() {
  return { ideType: "ANTIGRAVITY" };
}

// Kept for compatibility with callers that have not yet moved to the minimal
// bootstrap body. Current clients send only ideType in request metadata.
export function antigravityClientMetadata() {
  return JSON.stringify(antigravityLoadCodeAssistMetadata());
}
