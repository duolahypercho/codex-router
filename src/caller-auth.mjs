import { timingSafeEqual } from "node:crypto";

export const CALLER_PATH_PREFIX = "/_codex-router";
const MINIMUM_SECRET_LENGTH = 32;
const SECRET_PATTERN = /^[A-Za-z0-9_-]+$/;

export function validCallerSecret(value) {
  return (
    typeof value === "string" &&
    value.length >= MINIMUM_SECRET_LENGTH &&
    SECRET_PATTERN.test(value)
  );
}

export function assertCallerSecret(value) {
  if (!validCallerSecret(value)) {
    throw new Error("The local router caller key is missing or invalid; run ./bin/doctor --fix.");
  }
  return value;
}

export function secretEqual(actual, expected) {
  if (typeof actual !== "string" || typeof expected !== "string") return false;
  const actualBytes = Buffer.from(actual, "utf8");
  const expectedBytes = Buffer.from(expected, "utf8");
  return (
    actualBytes.length === expectedBytes.length &&
    timingSafeEqual(actualBytes, expectedBytes)
  );
}

export function callerBasePath(secret) {
  return `${CALLER_PATH_PREFIX}/${assertCallerSecret(secret)}/v1`;
}

export function callerBaseUrl(port, secret) {
  return `http://127.0.0.1:${port}${callerBasePath(secret)}`;
}

export function cursorCliBaseUrl(port, secret) {
  return `http://127.0.0.1:${port}${CALLER_PATH_PREFIX}/${assertCallerSecret(secret)}`;
}

// The Gemini API leaf, behind the identical capability in the identical
// position. Gemini CLI hands its base URL to @google/genai, which appends
// `/v1beta/models/{model}:{method}` itself -- so the secret has to be a path
// prefix here, and the leaf stops at `gemini` rather than naming a version the
// SDK is going to add. Every leaf must also be known to `redactCallerUrl`
// below, or the key reaches doctor output and support bundles in the clear.
export function geminiBasePath(secret) {
  return `${CALLER_PATH_PREFIX}/${assertCallerSecret(secret)}/gemini`;
}

export function geminiBaseUrl(port, secret) {
  return `http://127.0.0.1:${port}${geminiBasePath(secret)}`;
}

// Claude Code appends `/v1/messages` and `/v1/models` to this gateway origin.
// Keeping the capability ahead of the protocol leaf lets the router expose an
// Anthropic-compatible surface without placing a reusable credential in query
// parameters or changing the shared caller authority.
export function claudeBasePath(secret) {
  return `${CALLER_PATH_PREFIX}/${assertCallerSecret(secret)}/anthropic`;
}

export function claudeBaseUrl(port, secret) {
  return `http://127.0.0.1:${port}${claudeBasePath(secret)}`;
}

// The companion's browser surface sits behind the same capability as the API,
// so it is the same secret in the same position -- only the leaf differs. Built
// here rather than assembled by the caller so the one place that knows the
// path shape stays the one place that has to change.
export function panelPath(secret) {
  return `${CALLER_PATH_PREFIX}/${assertCallerSecret(secret)}/panel/`;
}

export function panelUrl(port, secret) {
  return `http://127.0.0.1:${port}${panelPath(secret)}`;
}

export function authenticatedRoute(pathname, expectedSecret) {
  if (typeof pathname !== "string") return undefined;
  const prefix = `${CALLER_PATH_PREFIX}/`;
  if (!pathname.startsWith(prefix)) return undefined;
  const remainder = pathname.slice(prefix.length);
  const separator = remainder.indexOf("/");
  if (separator === -1) return undefined;
  const candidate = remainder.slice(0, separator);
  if (!secretEqual(candidate, expectedSecret)) return undefined;
  return remainder.slice(separator) || "/";
}

function isManagedLeafBaseUrl(value, port, leaf) {
  if (typeof value !== "string" || !value) return false;
  try {
    const url = new URL(value);
    const expectedPort =
      port === undefined ? undefined : Number(port) === 80 ? "" : String(port);
    if (
      url.protocol !== "http:" ||
      url.hostname !== "127.0.0.1" ||
      (port !== undefined && url.port !== expectedPort) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    ) {
      return false;
    }
    const match = url.pathname.match(
      new RegExp(`^${CALLER_PATH_PREFIX}/([A-Za-z0-9_-]+)/${leaf}/?$`),
    );
    return Boolean(match && validCallerSecret(match[1]));
  } catch {
    return false;
  }
}

export function isManagedCallerBaseUrl(value, port) {
  return isManagedLeafBaseUrl(value, port, "v1");
}

// Codex can authenticate the router either with the legacy path capability or
// with a bearer sent to the plain loopback Responses endpoint.
export function isManagedCodexBaseUrl(value, port) {
  if (isManagedCallerBaseUrl(value, port)) return true;
  if (typeof value !== "string" || !value) return false;
  try {
    const url = new URL(value);
    const expectedPort = port === undefined ? undefined : Number(port) === 80 ? "" : String(port);
    return (
      url.protocol === "http:" &&
      url.hostname === "127.0.0.1" &&
      (port === undefined || url.port === expectedPort) &&
      !url.username && !url.password && !url.search && !url.hash &&
      /^\/v1\/?$/.test(url.pathname)
    );
  } catch {
    return false;
  }
}

// The base URL the Gemini integration writes. Checked separately from the
// Responses one because the two are not interchangeable: a client pointed at
// `/v1` speaks Responses and a client pointed at `/gemini` speaks Gemini, so
// accepting either as "managed" would let a repair leave a working-looking
// configuration that 404s on every turn.
export function isManagedGeminiBaseUrl(value, port) {
  return isManagedLeafBaseUrl(value, port, "gemini");
}

export function isManagedClaudeBaseUrl(value, port) {
  return isManagedLeafBaseUrl(value, port, "anthropic");
}

// Every leaf the capability guards, not just `/v1`. Redaction is what keeps the
// caller key out of support bundles, doctor output, and error messages, and it
// matched only the API path -- so the panel URL, which carries the identical
// secret in the identical position, passed through those surfaces verbatim.
// A new leaf must be added here at the same time it is added to the router.
export function redactCallerUrl(value) {
  if (typeof value !== "string") return value;
  return value.replace(
    new RegExp(`(${CALLER_PATH_PREFIX}/)[A-Za-z0-9_-]+(?=/(?:v1|panel|gemini|anthropic)(?:/|$|[^A-Za-z0-9_-])|$)`, "g"),
    "$1[REDACTED]",
  );
}
