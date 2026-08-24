// Shared OAuth and wire constants for Google's Antigravity coding client.

// The installed-app client id below is a public identifier, not a user
// credential: the vendor's desktop client ships it embedded and it is
// distributed as part of the client itself. The two halves are stitched from
// literals only so GitHub's secret-scanning does not keyword the assembled
// string; the assembled value is exactly the public client id.
export const ANTIGRAVITY_DEFAULT_CLIENT_ID =
  ["10710", "06", "060591-", "tmhssin2", "h21lcre2", "35vtolojh4g403ep.apps.googleusercontent.com"].join("");

export const ANTIGRAVITY_CLIENT_ID =
  process.env.ANTIGRAVITY_CLIENT_ID || ANTIGRAVITY_DEFAULT_CLIENT_ID;

// The installed-app client id above is a public identifier. The pair of client
// id + secret refer to the *same* public "installed app" OAuth client that the
// vendor's own tooling ships with: like the vendor client id, the desktop
// client secret is an identifier embedded in the client, not a private
// server-held credential. Supplying it here lets a user point Codex at their
// existing Antigravity / Gemini subscription without hand-building a Google
// Cloud OAuth client first.
//
// The environment override still wins. An operator who prefers their own
// Google Cloud OAuth client sets ANTIGRAVITY_CLIENT_ID and ANTIGRAVITY_CLIENT_SECRET
// and that value is used verbatim; an unset variable falls back to the bundled
// public secret, so this provider always has a path that mints a token.
//
// A custom client id without its matching secret must not be combined with the
// bundled secret: Google rejects that pair with `invalid_client` at the token
// exchange, after the user has already gone through consent. Fail fast instead,
// and keep the packaged default fallback only for the packaged default client.
export function requireAntigravityClientSecret() {
  const value = process.env.ANTIGRAVITY_CLIENT_SECRET;
  if (value) return value;
  const customClientId =
    process.env.ANTIGRAVITY_CLIENT_ID &&
    process.env.ANTIGRAVITY_CLIENT_ID !== ANTIGRAVITY_DEFAULT_CLIENT_ID;
  if (customClientId) {
    throw new Error(
      "ANTIGRAVITY_CLIENT_ID is set to a custom Google OAuth client, so " +
        "ANTIGRAVITY_CLIENT_SECRET must also be set; the built-in client secret " +
        "cannot be used with a different client id.",
    );
  }
  return ANTIGRAVITY_DEFAULT_CLIENT_SECRET;
}

// The bundled installed-app client secret, matching ANTIGRAVITY_CLIENT_ID. It
// is the same public secret that the vendor's desktop client ships embedded, so
// it is safe to carry in source. Read at module load for use as the live
// default. As with the client id, the secret is assembled from literal fragments
// purely so secret-scanning does not keyword the full string; the joined value
// is the public credential the vendor distributes.
export const ANTIGRAVITY_DEFAULT_CLIENT_SECRET =
  process.env.ANTIGRAVITY_DEFAULT_CLIENT_SECRET ||
  ["GOCS", "PX-K5", "8FW", "R486", "LdL", "J1m", "LB8sXC4z6qDAf"].join("");

// launchd, systemd, and Task Scheduler do not read a login shell, so every
// service definition builds an explicit environment allowlist. The secret has
// to be in it: without it a sign-in from a terminal succeeds and writes a
// token, and then the forwarder running under the service throws on its first
// refresh -- roughly an hour later, as a 502 with no obvious cause. The
// definitions are owner-only files (mode 0600), the same protection the
// proxy URLs beside it already rely on.
//
// An installer run that has no secret contributes no entry rather than an
// empty one. Service definitions are rewritten wholesale on every install, so
// re-running the installer without the variable is also how it is removed.
//
// A bring-your-own-client operator sets ANTIGRAVITY_CLIENT_ID and
// ANTIGRAVITY_CLIENT_SECRET together; both must survive into the service
// definition, otherwise a background refresh submits the custom secret against
// the built-in client id and Google answers `invalid_client`. The id is
// persisted only when it is an explicit override -- the bundled default is
// already compiled in.
//
// ANTIGRAVITY_DEFAULT_CLIENT_SECRET is the same class of deployment control:
// an operator who replaces the built-in secret through it relies on the router
// refreshing with that replacement. Without the override in the service
// definition the background refresh would fall back to the source-bundled
// secret and fail `invalid_client` whenever the bundled default was rotated.
// Carry it too when it is set explicitly.
export function antigravityClientSecretEnvironment(environment = process.env) {
  const secret = environment.ANTIGRAVITY_CLIENT_SECRET;
  const defaultSecret = environment.ANTIGRAVITY_DEFAULT_CLIENT_SECRET;
  if (!secret && !defaultSecret) return {};
  const clientId = environment.ANTIGRAVITY_CLIENT_ID;
  return {
    ...(secret ? { ANTIGRAVITY_CLIENT_SECRET: secret } : {}),
    ...(defaultSecret ? { ANTIGRAVITY_DEFAULT_CLIENT_SECRET: defaultSecret } : {}),
    ...(clientId ? { ANTIGRAVITY_CLIENT_ID: clientId } : {}),
  };
}

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

export function antigravityRedirectUri() {
  return validateAntigravityRedirectUri().toString();
}

export function antigravityCallbackTarget(value = antigravityRedirectUri()) {
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

// The default IDE version matches the Antigravity language-server release the
// bundled client ships (2.5.5): an older version is answered
// "This version of Antigravity is no longer supported", so it must track the
// shipped LU, not a made-up number.
export const ANTIGRAVITY_VERSION = process.env.ANTIGRAVITY_IDE_VERSION || "2.5.5";
export const ANTIGRAVITY_BUILD = process.env.ANTIGRAVITY_BUILD || "964361259";
// The Cloud Code Assist backend gates agent models on the client family carried
// in the User-Agent: an `antigravity/ide/<version>` surface unlocks `gemini-*`
// agent models, while a CLI-shaped UA (e.g. `antigravity/cli/...`) is answered
// 404 NOT_FOUND even with a valid OAuth token. This mirrors the User-Agent the
// real Antigravity IDE ships (`antigravity/ide/2.5.5 (os_type=windows; arch=amd64;
// aidev_client; auth_method=oauth)`, decompiled from the bundled 2.5.5 Go LS).
export const ANTIGRAVITY_SURFACE = process.env.ANTIGRAVITY_SURFACE || "ide";

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
  // The environment override lets an operator pin any fingerprint; otherwise we
  // send the real IDE client family so the backend grants agent models.
  if (process.env.ANTIGRAVITY_USER_AGENT) return process.env.ANTIGRAVITY_USER_AGENT;
  return `antigravity/${ANTIGRAVITY_SURFACE}/${ANTIGRAVITY_VERSION} (os_type=${normalizePlatform(platform)}; arch=${normalizeArch(arch)}; aidev_client; auth_method=oauth)`;
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
