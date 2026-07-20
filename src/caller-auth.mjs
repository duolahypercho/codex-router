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

export function isManagedCallerBaseUrl(value, port) {
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
      new RegExp(`^${CALLER_PATH_PREFIX}/([A-Za-z0-9_-]+)/v1/?$`),
    );
    return Boolean(match && validCallerSecret(match[1]));
  } catch {
    return false;
  }
}

export function redactCallerUrl(value) {
  if (typeof value !== "string") return value;
  return value.replace(
    new RegExp(`(${CALLER_PATH_PREFIX}/)[A-Za-z0-9_-]+(?=/v1(?:/|$))`, "g"),
    "$1[REDACTED]",
  );
}
